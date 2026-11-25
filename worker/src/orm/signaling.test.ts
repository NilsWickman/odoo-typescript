import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Cursor } from "../db";
import { endTransaction, KEPT_DBS, keepShared, keptDatabases, onRegistryChange, registryCached, registryChanged, requestSequences, sharable, sharedRead, signalWrites, touchesWatched, writtenTablesOf } from "./signaling";

test("written tables of a statement: DML targets, DDL as *, reads and locks as nothing watched", () => {
  assert.deepEqual(writtenTablesOf(`INSERT INTO res_groups_users_rel (gid, uid) VALUES ($1, $2)`), ["res_groups_users_rel"]);
  assert.deepEqual(writtenTablesOf(`UPDATE "res_company" SET name = $1 WHERE id = $2`), ["res_company"]);
  assert.deepEqual(writtenTablesOf(`DELETE FROM ir_access WHERE id = 3`), ["ir_access"]);
  assert.deepEqual(writtenTablesOf(`WITH x AS (DELETE FROM "res_lang" RETURNING id) SELECT * FROM x`), ["res_lang"]);
  assert.deepEqual(writtenTablesOf(`ALTER TABLE res_partner ADD COLUMN x int`), ["*"]);
  assert.deepEqual(writtenTablesOf(`SELECT id FROM res_users WHERE id = 1`), []);
  assert.ok(!writtenTablesOf(`SELECT id FROM res_users WHERE id = 1 FOR UPDATE NOWAIT`).some((t) => t.startsWith("res_")));
});

/** A cursor stand-in: the sequences row is the only statement registryCached itself runs. */
function fakeCursor(db: string, seq: Record<string, number>): Cursor & { ran: string[] } {
  const ran: string[] = [];
  const cr = {
    db, ran, writtenTables: new Set<string>(),
    async query(sql: string) {
      ran.push(sql);
      return { rows: [{ now: new Date(0), registry: 1, default: 1, assets: 1, stable: 1, templates: 1, routing: 1, groups: 1, ...seq }] };
    },
  };
  return cr as unknown as Cursor & { ran: string[] };
}

test("a value is loaded once per database and container state (environments.py:752-802)", async () => {
  let loads = 0;
  const load = async (): Promise<number> => ++loads;
  const db = `t${Math.random()}`;
  assert.equal(await registryCached(fakeCursor(db, {}), "k", load), 1);
  assert.equal(await registryCached(fakeCursor(db, {}), "k", load), 1); // next request, same sequences: cached
  assert.equal(await registryCached(fakeCursor(db, { assets: 9 }), "k", load), 1); // 'assets' does not clear 'default'
  // the receiving side clears only the container whose own sequence moved (environments.py:780-799)
  assert.equal(await registryCached(fakeCursor(db, { assets: 9, groups: 2, stable: 2 }), "k", load), 1);
  assert.equal(await registryCached(fakeCursor(db, { default: 2 }), "k", load), 2);
  assert.equal(await registryCached(fakeCursor(db, { default: 2 }), "s", load, "stable"), 3);
  assert.equal(await registryCached(fakeCursor(db, { default: 3 }), "s", load, "stable"), 3); // not 'stable'
  assert.equal(await registryCached(fakeCursor(db, { default: 3, stable: 2 }), "s", load, "stable"), 4);
  assert.equal(await registryCached(fakeCursor(db, { default: 3, registry: 2 }), "k", load), 5); // the registry: all
  // an older snapshot loads for itself and leaves the newer state alone
  assert.equal(await registryCached(fakeCursor(db, { default: 2 }), "k", load), 6);
  assert.equal(await registryCached(fakeCursor(db, { default: 3, registry: 2 }), "k", load), 5);
  assert.equal(await registryCached(fakeCursor(`${db}x`, { default: 3, registry: 2 }), "k", load), 7); // another database
});

test("after a write to a watched table the request reads past the cache, and the commit signals", async () => {
  let loads = 0;
  const load = async (): Promise<number> => ++loads;
  const db = `w${Math.random()}`;
  const cr = fakeCursor(db, {});
  assert.equal(await registryCached(cr, "k", load), 1);
  for (const t of writtenTablesOf("UPDATE res_partner SET name = 'x'")) cr.writtenTables.add(t);
  assert.ok(!touchesWatched(cr));
  assert.equal(await registryCached(cr, "k", load), 1);
  for (const t of writtenTablesOf("INSERT INTO res_groups_users_rel VALUES (1, 2)")) cr.writtenTables.add(t);
  assert.ok(touchesWatched(cr));
  assert.equal(await registryCached(cr, "k", load), 2);
  assert.equal(await registryCached(cr, "k", load), 3); // not kept
  const signals: string[] = [];
  await signalWrites(cr, async (sql) => signals.push(sql));
  assert.deepEqual(signals, ["default", "groups", "stable"].map((n) => `INSERT INTO orm_signaling_${n} DEFAULT VALUES`));
  endTransaction(cr);
  assert.ok(!touchesWatched(cr));
  // the isolate's own state was dropped with the signal: the next request loads again
  assert.equal(await registryCached(fakeCursor(db, {}), "k", load), 4);
});

test("a statement is kept across requests only when it reads registry tables and nothing that moves", () => {
  assert.ok(sharable("SELECT res_id FROM ir_model_data WHERE module = $1 AND name = $2", new Set(["ir_model_data"])));
  assert.ok(!sharable("SELECT id FROM sale_order WHERE id = $1", new Set(["sale_order"])), "not a registry table");
  assert.ok(!sharable("SELECT v.id FROM ir_ui_view v JOIN sale_order s ON true", new Set(["ir_ui_view", "sale_order"])));
  assert.ok(!sharable("SELECT value FROM ir_config_parameter WHERE write_date < now()", new Set(["ir_config_parameter"])), "the clock");
  assert.ok(!sharable("SELECT current_setting('x') FROM ir_model", new Set(["ir_model"])));
  assert.ok(!sharable("SELECT 1", new Set()), "no table");
  assert.ok(!sharable("SELECT * FROM res_device", null), "unknown dependencies");
  assert.ok(sharable("SELECT value FROM ir_config_parameter WHERE key = 'now'", new Set(["ir_config_parameter"])), "a literal is not the clock");
});

test("the isolate keeps small answers and drops one over 256 KB (the registry's own load is held by the registry)", async () => {
  const cr = fakeCursor(`s${Math.random()}`, {});
  await requestSequences(cr); // sharing needs the transaction's sequences
  const small = Promise.resolve({ rows: [{ value: "x".repeat(1000) }] });
  const big = Promise.resolve({ rows: Array.from({ length: 200 }, () => ({ value: "y".repeat(1000) })) });
  keepShared(cr, "small", small);
  keepShared(cr, "big", big);
  assert.equal(sharedRead(cr, "big"), big, "shared with concurrent readers while it runs");
  await small;
  await big;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sharedRead(cr, "small"), small);
  assert.equal(sharedRead(cr, "big"), undefined);
});

test("a registry change: the hooks run for an install here and for a newer registry elsewhere, not for an older snapshot", async () => {
  const db = `r${Math.random()}`;
  const seen: string[] = [];
  onRegistryChange((d) => { if (d === db) seen.push(d); });
  const cr0 = fakeCursor(db, { registry: 3 });
  await requestSequences(cr0); // first sight of the database: nothing to drop
  assert.equal(seen.length, 0);
  const cr = fakeCursor(db, { registry: 3 });
  registryChanged(cr); // this transaction installed a module
  assert.equal(seen.length, 1);
  const ran: string[] = [];
  await signalWrites(cr, async (sql) => { ran.push(sql); });
  assert.deepEqual(ran, ["INSERT INTO orm_signaling_registry DEFAULT VALUES"]);
  endTransaction(cr);
  await requestSequences(fakeCursor(db, { registry: 4 })); // another isolate installed: newer
  assert.equal(seen.length, 2);
  await requestSequences(fakeCursor(db, { registry: 3 })); // a request on an older snapshot
  assert.equal(seen.length, 2);
  await requestSequences(fakeCursor(db, { registry: 4, dboid: "other" } as unknown as Record<string, number>)); // recreated
  assert.equal(seen.length, 3);
});

test("an isolate keeps the databases used last, forgets the others whole, and never one with a transaction open", async () => {
  const forgotten: string[] = [];
  onRegistryChange((db) => { if (db.startsWith("kept_")) forgotten.push(db); });
  let loads = 0;
  const load = async () => ++loads;
  const request = async (db: string, end = true): Promise<Cursor> => {
    const cr = fakeCursor(db, {});
    await registryCached(cr, "k", load);
    if (end) endTransaction(cr);
    return cr;
  };
  // one request after another on new databases: the first ones go, in the order of their last use (databases that
  // earlier tests of the process left idle are older, and go before these)
  const names = Array.from({ length: KEPT_DBS + 2 }, (_, i) => `kept_${i}`);
  for (const db of names) await request(db);
  assert.deepEqual(keptDatabases(), names.slice(-KEPT_DBS));
  assert.deepEqual(forgotten, names.slice(0, 2));
  // a kept database's value is still there, a forgotten one's is loaded again
  const before = loads;
  await request(names[names.length - 1]!);
  assert.equal(loads, before);
  await request("kept_0");
  assert.equal(loads, before + 1);
  // a database with a transaction open is not forgotten, however many others come after it
  forgotten.length = 0;
  const open = await request("kept_open", false);
  for (let i = 0; i < KEPT_DBS + 3; i++) await request(`kept_after_${i}`);
  assert.ok(!forgotten.includes("kept_open"));
  const held = loads;
  await registryCached(open, "k", load);
  assert.equal(loads, held);
  // once its transaction has ended it is the least recently used one, and goes with the next new database
  endTransaction(open);
  await request("kept_last");
  assert.ok(forgotten.includes("kept_open"));
  assert.equal(keptDatabases().length, KEPT_DBS);
});
