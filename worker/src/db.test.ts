import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Cursor } from "./db";
import type { Env } from "./env";
import { catalogOf, setCatalog } from "./sql_cache";

/**
 * A connection that answers in the order statements were sent, a tick later each, as Postgres does in a pipeline: a
 * failing statement aborts the transaction (25P02 for everything after it but ROLLBACK).
 */
function fakeCursor(fail: (sql: string) => boolean): { cr: Cursor; sent: string[] } {
  const cr = new Cursor({ SLOTS: "{}" } as Env, "dev_test");
  const sent: string[] = [];
  let aborted = false;
  let chain: Promise<unknown> = Promise.resolve();
  const client = {
    query(sql: string): Promise<{ rows: unknown[] }> {
      sent.push(sql);
      const answer = chain.then(() => new Promise((resolve) => setTimeout(resolve, 1))).then(() => {
        if (/^\s*ROLLBACK/i.test(sql)) { aborted = false; return { rows: [] }; }
        if (aborted) throw Object.assign(new Error("current transaction is aborted"), { code: "25P02", severity: "ERROR" });
        if (fail(sql)) { aborted = true; throw Object.assign(new Error(`failed: ${sql}`), { code: "23505", severity: "ERROR" }); }
        return { rows: [{ sql }] };
      });
      chain = answer.catch(() => undefined);
      return answer;
    },
  };
  Reflect.set(cr, "client", client);
  Reflect.set(cr, "opened", Promise.resolve(client));
  return { cr, sent };
}

test("a deferred write goes out at once, in call order, and its error is thrown by the next statement", async () => {
  const { cr, sent } = fakeCursor((sql) => sql.includes("bad"));
  assert.equal(cr.canDefer(`UPDATE "t" SET "a" = $1 WHERE id = $2`), true);
  assert.equal(cr.canDefer(`UPDATE "t" SET "a" = 1 WHERE id = 2 RETURNING id`), false);
  assert.equal(cr.canDefer(`SELECT 1`), false);
  cr.defer(`UPDATE "t" SET "a" = 1 WHERE id = 1`);
  const read = cr.query(`SELECT 2`);
  assert.deepEqual(sent, [`UPDATE "t" SET "a" = 1 WHERE id = 1`, `SELECT 2`], "both sent before any answer");
  assert.equal((await read).rows.length, 1);

  cr.defer(`UPDATE "t" SET bad = 1 WHERE id = 1`);
  cr.defer(`UPDATE "t" SET "a" = 2 WHERE id = 1`); // aborted by the first
  await assert.rejects(cr.query(`SELECT 3`), /failed: UPDATE "t" SET bad/, "the first deferred error, not 25P02");
  await assert.rejects(cr.query(`SELECT 4`), /aborted/, "thrown once; then the transaction's own state");
  await cr.query(`ROLLBACK`);
  await cr.query(`SELECT 5`);
});

test("savepoints, drain and commit wait for the deferred writes", async () => {
  const { cr } = fakeCursor((sql) => sql.includes("bad"));
  cr.defer(`UPDATE "t" SET bad = 1 WHERE id = 1`);
  await assert.rejects(cr.query(`SAVEPOINT a`), /failed: UPDATE/, "a savepoint is not opened over a failed write");
  await cr.query(`ROLLBACK`);

  await cr.query(`SAVEPOINT b`);
  assert.equal(cr.canDefer(`UPDATE "t" SET "a" = 1 WHERE id = 1`), false, "inside a savepoint the caller gets its error");
  await cr.query(`RELEASE SAVEPOINT b`);
  assert.equal(cr.canDefer(`UPDATE "t" SET "a" = 1 WHERE id = 1`), true);

  cr.defer(`UPDATE "t" SET bad = 2 WHERE id = 1`);
  await assert.rejects(cr.drain(), /failed: UPDATE/);
  await cr.rollback();

  cr.defer(`UPDATE "t" SET bad = 3 WHERE id = 1`);
  await assert.rejects(cr.commit(), /failed: UPDATE/, "the commit fails with the write's error");
  await cr.rollback();
  cr.defer(`UPDATE "t" SET bad = 4 WHERE id = 1`);
  await cr.rollback(); // discarded with the transaction
  await cr.query(`SELECT 6`);
});

test("a failing statement after a deferred write reports its own error when the write succeeded", async () => {
  const { cr } = fakeCursor((sql) => sql.includes("boom"));
  cr.defer(`UPDATE "t" SET "a" = 1 WHERE id = 1`);
  await assert.rejects(cr.query(`SELECT boom`), /failed: SELECT boom/);
  await cr.query(`ROLLBACK`);
  // a deferred write sent after a failing statement does not replace that statement's error
  const first = cr.query(`SELECT boom`);
  cr.defer(`UPDATE "t" SET "a" = 2 WHERE id = 1`);
  await assert.rejects(first, /failed: SELECT boom/);
});

test("BEGIN is not waited for: the first statement goes out behind it, and a failed BEGIN fails the statement and COMMIT", async () => {
  const { cr, sent } = fakeCursor((sql) => sql.startsWith("BEGIN") && sql.includes("bad"));
  const client = Reflect.get(cr, "client") as { query(sql: string): Promise<unknown> };
  Reflect.set(cr, "begun", client.query("BEGIN ISOLATION LEVEL REPEATABLE READ").then(() => undefined));
  const read = cr.query(`SELECT 1`);
  assert.deepEqual(sent, ["BEGIN ISOLATION LEVEL REPEATABLE READ", "SELECT 1"], "both sent before any answer");
  assert.equal((await read).rows.length, 1);

  const bad = fakeCursor((sql) => sql.startsWith("BEGIN") && sql.includes("bad"));
  const badClient = Reflect.get(bad.cr, "client") as { query(sql: string): Promise<unknown> };
  const begun = badClient.query("BEGIN bad").then(() => undefined);
  begun.catch(() => undefined);
  Reflect.set(bad.cr, "begun", begun);
  await assert.rejects(bad.cr.query(`SELECT 1`), /failed: BEGIN bad|aborted/, "the statement does not answer without a transaction");
  await assert.rejects(bad.cr.commit(), /failed: BEGIN bad/, "and the transaction never commits");
  assert.equal(bad.sent.includes("COMMIT"), false);
});

test("buffered updates merge across calls, keep RowCache warm, and flush on dependent SQL or drain/rollback", async () => {
  setCatalog("dev_test", catalogOf([{ name: "stock_move", kind: "r" }, { name: "res_partner", kind: "r" }]));
  const { cr, sent } = fakeCursor((sql) => sql.includes(`"bad"`));
  cr.rows.put("stock_move", 1, new Map<string, unknown>([["is_in", true], ["state", "draft"], ["write_date", "d"]]));

  cr.bufferUpdate(
    "stock_move",
    [[1, new Map([["is_in", { kind: "val", sqlVal: false, pgType: "bool" }], ["write_date", { kind: "now" }]])]],
    [[1, new Map([["is_in", { raw: false }], ["write_date", null]])]],
  );
  cr.bufferUpdate(
    "stock_move",
    [[1, new Map([["is_out", { kind: "val", sqlVal: true, pgType: "bool" }]])]],
    [[1, new Map([["is_out", { raw: true }]])]],
  );
  assert.equal(sent.length, 0, "buffered writes send nothing yet");
  assert.equal(cr.rows.row("stock_move", 1)?.get("is_in"), false, "RowCache updated in place");
  assert.equal(cr.rows.row("stock_move", 1)?.get("is_out"), true);
  assert.equal(cr.rows.row("stock_move", 1)?.has("write_date"), false, "NOW column dropped from RowCache");

  // Unrelated table or untouched column does not flush
  await cr.query(`SELECT id FROM res_partner WHERE id = $1`, [1]);
  await cr.query(`SELECT state FROM stock_move WHERE id = $1`, [1]);
  assert.equal(sent.filter((s) => s.startsWith("UPDATE")).length, 0);

  // Reading a dirty column flushes merged UPDATE right before SELECT
  await cr.query(`SELECT is_in FROM stock_move WHERE id = $1`, [1]);
  assert.equal(sent.filter((s) => s.startsWith("UPDATE")).length, 1);
  assert.match(sent[sent.length - 2]!, /^UPDATE "stock_move" SET "is_in" = \$1, "is_out" = \$2, "write_date" = \(now\(\) AT TIME ZONE 'UTC'\) WHERE id = \$3$/);
  assert.equal(sent[sent.length - 1], `SELECT is_in FROM stock_move WHERE id = $1`);

  // Rollback discards pending writes without sending
  const before = sent.length;
  cr.bufferUpdate("stock_move", [[2, new Map([["is_in", { kind: "val", sqlVal: true, pgType: "bool" }]])]], []);
  await cr.rollback();
  assert.equal(sent.slice(before).filter((s) => s.startsWith("UPDATE")).length, 0);

  // Flushed error surfaces through drain
  cr.bufferUpdate("stock_move", [[3, new Map([["bad", { kind: "val", sqlVal: 1, pgType: "int4" }]])]], []);
  await assert.rejects(cr.drain(), /failed: UPDATE "stock_move"/);
  await cr.rollback();
});
