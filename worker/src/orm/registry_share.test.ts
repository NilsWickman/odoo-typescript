import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Cursor } from "../db";
import { decodeRows, encodeRows, registrySourceOf, sharedRegistryRows, type RegistryRows } from "./registry_share";
import { endTransaction } from "./signaling";

const ROWS: RegistryRows = {
  models: [
    { id: 1, model: "res.partner", order: "complete_name ASC, id DESC", name: { en_US: "Contact", fr_FR: "Contact" }, transient: false, abstract: false, is_mail_thread: true, state: "base" },
    { id: 2, model: "x_é", order: "id", name: null, transient: null, abstract: null, is_mail_thread: null, state: "manual" },
  ],
  fieldTexts: [
    ["res.partner", '[[1, "name", "char", null, {"en_US" : "Name", "fr_FR" : "Nom"}, true]]'],
    ["x_é", '[[2, "x_name", "char", "\\ufeffbom \u{1F600} é中", null]]'],
    ["empty", ""],
  ],
  selections: [{ field_id: 7, value: "a", name: { en_US: "A", "__proto__": "p" } }],
  inherits: [{ model_id: 1, parent_id: 2, link: null }],
  groups: [{ field_id: 1, xmlid: "base.group_user" }],
  columnTexts: [["﻿res_partner", '[["id", "NO", "integer"]]']],
  unaccent: true,
  langs: ["en_US", "fr_FR"],
};

test("registry rows: encoded and decoded as they were (texts byte for byte, row values, key order)", () => {
  const back = decodeRows(encodeRows(ROWS));
  assert.deepStrictEqual(back, ROWS);
  assert.equal(JSON.stringify(back), JSON.stringify(ROWS));
  assert.equal(back.fieldTexts[1]![1], ROWS.fieldTexts[1]![1]);
  assert.equal(back.columnTexts[0]![0].charCodeAt(0), 0xfeff);
});

test("registry rows: anything but a whole encoding is refused", () => {
  const bytes = encodeRows(ROWS);
  assert.throws(() => decodeRows(bytes.subarray(0, bytes.length - 1)));
  const longer = new Uint8Array(bytes.length + 1);
  longer.set(bytes);
  assert.throws(() => decodeRows(longer));
  assert.throws(() => decodeRows(new TextEncoder().encode('{"v":0}\n')));
  assert.throws(() => decodeRows(new Uint8Array([0xff, 0xfe, 10])));
});

/** A cursor answering the signaling statement with `seq` (dboid 41); `written` are tables it has written. */
function cursor(seq: { registry?: number; default?: number; dboid?: string }, written: string[] = [], share = true): Cursor {
  const row = { now: new Date(0), registry: seq.registry ?? 1, default: seq.default ?? 1, assets: 1, stable: 1, templates: 1, routing: 1, groups: 1, dboid: seq.dboid ?? "41" };
  return {
    db: "db1", isolateCache: true, registryShare: share, waitUntil: null, writtenTables: new Set<string>(written),
    query: async (sql: string) => {
      if (!sql.includes("orm_signaling_registry")) throw new Error(`unexpected statement ${sql}`);
      return { rows: [row] };
    },
  } as unknown as Cursor;
}

/** An in-memory CacheStorage (one cache), installed as `caches` for `fn`. */
async function withCaches(fn: (store: Map<string, Uint8Array>) => Promise<void>): Promise<void> {
  const store = new Map<string, Uint8Array>();
  const cache = {
    match: async (r: Request) => {
      const b = store.get(r.url);
      return b === undefined ? undefined : new Response(b.slice());
    },
    put: async (r: Request, res: Response) => { store.set(r.url, new Uint8Array(await res.arrayBuffer())); },
  };
  const before = Reflect.get(globalThis, "caches");
  Reflect.set(globalThis, "caches", { open: async () => cache });
  try {
    await fn(store);
  } finally {
    Reflect.set(globalThis, "caches", before);
  }
}

async function load(cr: Cursor, reads: { n: number }): Promise<RegistryRows> {
  const rows = await sharedRegistryRows(cr, "SELECT statements", async () => {
    reads.n++;
    return ROWS;
  });
  // the put runs behind the load; let it finish
  await new Promise((r) => setTimeout(r, 0));
  endTransaction(cr);
  return rows;
}

test("shared registry rows: kept under the database's identity and every signaling sequence", async () => {
  await withCaches(async (store) => {
    const reads = { n: 0 };
    const a = cursor({});
    assert.deepStrictEqual(await load(a, reads), ROWS);
    assert.equal(registrySourceOf(a), "put");
    assert.equal(store.size, 1);
    const b = cursor({});
    assert.deepStrictEqual(await load(b, reads), ROWS);
    assert.match(registrySourceOf(b) ?? "", /^hit regms=\d+$/);
    assert.equal(reads.n, 1);
    // another sequence, another database under the name: read again
    for (const seq of [{ default: 2 }, { registry: 2 }, { dboid: "42" }]) {
      const c = cursor(seq);
      await load(c, reads);
      assert.equal(registrySourceOf(c), "put");
    }
    assert.equal(reads.n, 4);
    assert.equal(store.size, 4);
  });
});

test("shared registry rows: a transaction that wrote a watched table neither reads nor keeps them", async () => {
  await withCaches(async (store) => {
    const reads = { n: 0 };
    await load(cursor({}), reads);
    const w = cursor({}, ["ir_model_fields"]);
    await load(w, reads);
    assert.equal(registrySourceOf(w), "db");
    const ddl = cursor({ default: 5 }, ["*"]);
    await load(ddl, reads);
    assert.equal(registrySourceOf(ddl), "db");
    assert.equal(store.size, 1);
    // a write to a table the registry does not read changes nothing
    const other = cursor({}, ["res_device_log"]);
    await load(other, reads);
    assert.match(registrySourceOf(other) ?? "", /^hit regms=\d+$/);
    // REGISTRY_SHARE=0
    const off = cursor({}, [], false);
    await load(off, reads);
    assert.equal(registrySourceOf(off), "db");
    assert.equal(reads.n, 4);
  });
});

test("shared registry rows: without a Cache API they come from the database", async () => {
  const before = Reflect.get(globalThis, "caches");
  Reflect.set(globalThis, "caches", undefined);
  try {
    const reads = { n: 0 };
    const cr = cursor({});
    await load(cr, reads);
    assert.equal(registrySourceOf(cr), "db");
    assert.equal(reads.n, 1);
  } finally {
    Reflect.set(globalThis, "caches", before);
  }
});
