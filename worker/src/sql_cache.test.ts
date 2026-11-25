import { strict as assert } from "node:assert";
import { test } from "node:test";
import { catalogOf, mentionedTables, ReadCache, readDeps, readWords, RowCache, setColumns, writeEffect } from "./sql_cache";

const cat = catalogOf([
  { name: "sale_order", kind: "r" }, { name: "sale_order_line", kind: "r" }, { name: "res_currency", kind: "r" },
  { name: "res_company", kind: "r" }, { name: "account_tax", kind: "r" }, { name: "ir_ui_view", kind: "r" },
  { name: "res_device", kind: "v" }, { name: "ir_sequence_001", kind: "S" }, { name: "now", kind: "F" },
]);
const deps = (sql: string): string[] | null => {
  const d = readDeps(sql, cat);
  return d === null ? null : [...d].sort();
};

test("a read depends on the tables it names", () => {
  assert.deepEqual(deps(`SELECT rounding::text AS r FROM res_currency WHERE id = $1`), ["res_currency"]);
  assert.deepEqual(deps(`SELECT "sale_order"."id" FROM "sale_order" JOIN "sale_order_line" AS "l" ON l.order_id = sale_order.id`), ["sale_order", "sale_order_line"]);
  assert.deepEqual(deps(`SELECT t.id FROM account_tax t JOIN res_company c ON c.id = t.company_id WHERE t.id = ANY($1::int[])`), ["account_tax", "res_company"]);
  assert.deepEqual(deps(`SELECT "sale_order"."id" FROM "sale_order" JOIN (SELECT * FROM unnest($1::int4[]) WITH ORDINALITY) AS "sale_order__ids" ON ("sale_order"."id" = "sale_order__ids"."unnest")`), ["sale_order"]);
  assert.deepEqual(deps(`SELECT 1 FROM sale_order WHERE EXISTS(SELECT FROM (SELECT order_id FROM sale_order_line) x)`), ["sale_order", "sale_order_line"]);
  assert.deepEqual(deps(`WITH RECURSIVE v AS (SELECT id FROM ir_ui_view WHERE id = $1 UNION SELECT c.id FROM ir_ui_view c JOIN v ON c.inherit_id = v.id) SELECT * FROM v`), ["ir_ui_view"]);
  assert.deepEqual(deps(`SELECT now() AT TIME ZONE 'UTC'`), null, "a public function (the frozen clock's now) is not attributed");
  assert.deepEqual(deps(`SELECT 1 AS n`), []);
});

test("what cannot be attributed is null (dropped by any write, as before)", () => {
  assert.equal(deps(`SELECT * FROM res_device WHERE id = 1`), null, "a view");
  assert.equal(deps(`SELECT last_value FROM ir_sequence_001`), null, "a sequence");
  assert.equal(deps(`SELECT * FROM unknown_table`), null, "an unknown FROM target");
  assert.equal(deps(`SELECT EXTRACT(year FROM date_order) FROM sale_order`), null, "FROM inside a call");
  assert.equal(deps(`SELECT a IS DISTINCT FROM b FROM sale_order`), null);
  assert.equal(deps(`SELECT * FROM pg_catalog.pg_class`), null);
  assert.equal(deps(`SELECT column_name FROM information_schema.columns`), null);
  assert.equal(deps(`SELECT * FROM other.sale_order`), null, "another schema");
  assert.equal(deps(`SELECT query_to_xml('select 1', true, true, '')`), null);
  assert.equal(deps(`SELECT E'it\\'s' FROM sale_order`), null, "escaped strings defeat the scan");
  assert.equal(deps(`SELECT $$x$$ FROM sale_order`), null);
  assert.equal(readDeps(`SELECT 1 FROM sale_order`, undefined), null, "no catalog yet");
  assert.deepEqual(deps(`SELECT 'FROM nowhere' AS x FROM sale_order`), ["sale_order"], "literals are skipped");
});

test("a write's effect: INSERT/UPDATE their targets, an UPDATE by id its rows, the rest everything", () => {
  assert.deepEqual(writeEffect(`INSERT INTO "sale_order_line" ("a") VALUES ($1) RETURNING id`, [1]), { kind: "tables", tables: ["sale_order_line"], rows: null, insert: true });
  assert.deepEqual(writeEffect(`INSERT INTO rel (a, b) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [1, 2]), { kind: "tables", tables: ["rel"], rows: null, insert: true });
  const upsert = writeEffect(`INSERT INTO ir_default (a) VALUES ($1) ON CONFLICT (a) DO UPDATE SET a = EXCLUDED.a`, [1]);
  assert.ok(upsert.kind === "tables" && upsert.insert === undefined && upsert.rows === null && upsert.tables.includes("ir_default"), "an upsert changes rows");
  assert.deepEqual(writeEffect(`UPDATE "sale_order_line" SET "price_unit" = $1, "write_uid" = $2, "write_date" = (now() AT TIME ZONE 'UTC') WHERE id = $3`, [1, 2, 7]),
    { kind: "tables", tables: ["sale_order_line"], rows: { table: "sale_order_line", ids: [7], columns: ["price_unit", "write_uid", "write_date"] } });
  assert.deepEqual(writeEffect(`UPDATE sale_order SET state = $1 WHERE id = ANY($2::int[])`, ["sale", [3, 4]]),
    { kind: "tables", tables: ["sale_order"], rows: { table: "sale_order", ids: [3, 4], columns: ["state"] } });
  assert.deepEqual(writeEffect(`UPDATE sale_order SET state = $1 WHERE partner_id = $2`, ["sale", 3]), { kind: "tables", tables: ["sale_order"], rows: null });
  assert.deepEqual(writeEffect(`UPDATE sale_order SET a = 1 WHERE b IN (SELECT x FROM sale_order_line WHERE id = $1)`, [3]), { kind: "tables", tables: ["sale_order"], rows: null });
  assert.deepEqual(writeEffect(`UPDATE sale_order SET id = $1 WHERE id = $2`, [9, 3]), { kind: "tables", tables: ["sale_order"], rows: null }, "the row moves");
  assert.deepEqual(writeEffect(`UPDATE sale_order SET a = 1 WHERE id = $1 RETURNING id`, [3]), { kind: "tables", tables: ["sale_order"], rows: null });
  assert.deepEqual(writeEffect(`DELETE FROM sale_order WHERE id = $1`, [1]), { kind: "all" }, "cascades");
  assert.deepEqual(writeEffect(`SAVEPOINT x`, []), { kind: "all" });
  assert.deepEqual(writeEffect(`ROLLBACK TO SAVEPOINT x`, []), { kind: "all" });
  assert.deepEqual(writeEffect(`SELECT nextval('ir_sequence_001')`, []), { kind: "tables", tables: [], rows: null }, "a sequence only");
  assert.deepEqual(writeEffect(`SELECT nextval('ir_sequence_001')::text AS n`, []), { kind: "tables", tables: [], rows: null });
  assert.deepEqual(writeEffect(`SELECT nextval('ir_sequence_001'), (SELECT 1 FROM sale_order FOR UPDATE)`, []), { kind: "all" });
  assert.deepEqual(writeEffect(`SELECT setval('ir_sequence_001', 5)`, []), { kind: "all" });
  assert.deepEqual(writeEffect(`WITH x AS (INSERT INTO sale_order DEFAULT VALUES RETURNING id) SELECT id FROM x`, []), { kind: "all" });
  assert.deepEqual(writeEffect(`ALTER TABLE sale_order ADD COLUMN x int`, []), { kind: "all" });
});

test("caches keep what a write did not touch", () => {
  const reads = new ReadCache<string>();
  reads.set("a", "currency", new Set(["res_currency"]));
  reads.set("b", "lines", new Set(["sale_order_line"]));
  reads.set("c", "unknown", null);
  reads.drop(writeEffect(`UPDATE "sale_order_line" SET x = $1 WHERE id = $2`, [1, 2]));
  assert.equal(reads.get("a"), "currency");
  assert.equal(reads.get("b"), undefined);
  assert.equal(reads.get("c"), undefined);
  reads.drop(writeEffect(`DELETE FROM sale_order WHERE id = 1`, []));
  assert.equal(reads.get("a"), undefined);

  const rows = new RowCache();
  rows.put("sale_order_line", 1, new Map([["price_unit", 1]]));
  rows.put("sale_order_line", 2, new Map([["price_unit", 2]]));
  rows.put("sale_order", 5, null);
  const v = rows.version("sale_order_line");
  rows.drop(writeEffect(`UPDATE "sale_order_line" SET "price_unit" = $1 WHERE id = $2`, [3, 1]));
  assert.deepEqual(rows.row("sale_order_line", 1), new Map(), "the row is known to exist, its written column is not kept");
  assert.deepEqual(rows.row("sale_order_line", 2), new Map([["price_unit", 2]]));
  assert.notEqual(rows.version("sale_order_line"), v, "an in-flight read of the table is not kept");
  assert.equal(rows.row("sale_order", 5), null);
  rows.drop(writeEffect(`INSERT INTO sale_order (id) VALUES (5)`, []));
  assert.equal(rows.row("sale_order", 5), undefined, "an absent id may exist after an INSERT");
  rows.drop(writeEffect(`DELETE FROM res_currency`, []));
  assert.equal(rows.row("sale_order_line", 2), undefined);
  assert.deepEqual([...rows.seen("sale_order_line")], [1, 2], "the prefetch ids stay");
  rows.hint("product_product", [7, 8, 7]);
  assert.deepEqual([...rows.seen("product_product")], [7, 8], "ids reached through a relation are prefetch ids");
  assert.equal(rows.row("product_product", 7), undefined, "nothing is known of their rows");
  rows.putX2many("stock.picking.move_ids", 3, [10, 11]);
  const w = rows.writeCount();
  assert.deepEqual(rows.x2many("stock.picking.move_ids", 3), [10, 11]);
  rows.drop(writeEffect(`UPDATE "res_company" SET "name" = $1 WHERE id = $2`, ["x", 1]));
  assert.equal(rows.x2many("stock.picking.move_ids", 3), undefined, "any write drops every x2many value");
  assert.notEqual(rows.writeCount(), w, "a read in flight across a write is not kept");
});

test("a read survives an UPDATE by id of columns it never names", () => {
  const reads = new ReadCache<string>();
  const put = (k: string, q: string, deps: string[]): void => reads.set(k, k, new Set(deps), readWords(q));
  put("state", `SELECT state FROM stock_move WHERE sale_line_id = $1 ORDER BY id`, ["stock_move"]);
  put("qty", `SELECT "stock_move"."id", "stock_move"."product_qty" FROM "stock_move" WHERE "stock_move"."picking_id" IN ($1)`, ["stock_move"]);
  put("star", `SELECT * FROM stock_move WHERE id = $1`, ["stock_move"]);
  put("count", `SELECT count(*) FROM stock_move WHERE picking_id = $1`, ["stock_move"]);
  put("row", `SELECT row_to_json(m) FROM stock_move m WHERE id = $1`, ["stock_move"]);
  put("lit", `SELECT id FROM stock_move WHERE name = 'state'`, ["stock_move"]);
  reads.drop(writeEffect(`UPDATE "stock_move" SET "date_deadline" = $1, "write_uid" = $2, "write_date" = (now() AT TIME ZONE 'UTC') WHERE id = $3`, [null, 2, 7]));
  assert.deepEqual(["state", "qty", "star", "count", "row", "lit"].map((k) => reads.get(k)), ["state", "qty", undefined, "count", undefined, "lit"]);
  reads.drop(writeEffect(`UPDATE "stock_move" SET "State" = $1 WHERE id = ANY($2::int[])`, ["done", [7]]));
  assert.equal(reads.get("state"), undefined, "a quoted name matches the word in any case");
  assert.equal(reads.get("qty"), "qty");
  reads.drop(writeEffect(`UPDATE stock_move SET product_qty = 1 WHERE picking_id = $1`, [3]));
  assert.equal(reads.get("qty"), undefined, "not by id: the columns are not read");
  put("q2", `SELECT id FROM stock_move WHERE picking_id = $1`, ["stock_move"]);
  reads.drop(writeEffect(`INSERT INTO stock_move (picking_id) VALUES ($1)`, [3]));
  assert.equal(reads.get("q2"), undefined, "an INSERT adds rows");
  assert.equal(readWords(`SELECT a * b FROM t`), null, "a product is treated as a star");
});

test("the columns an UPDATE sets: top-level assignments only, null when the list cannot be read", () => {
  assert.deepEqual(setColumns(`"a" = $1, "b" = COALESCE("b", $2::jsonb) || $3::jsonb, c = (now() AT TIME ZONE 'UTC')`), ["a", "b", "c"]);
  assert.deepEqual(setColumns(`"x" = (SELECT jsonb_object_agg(d.key, d.value) FROM jsonb_each(COALESCE(t."x", '{}'::jsonb) || $1::jsonb) d JOIN jsonb_each($2::jsonb) f ON d.key = f.key AND d.value != f.value)`), ["x"]);
  assert.deepEqual(setColumns(`Name = 'a, b = c', "Mixed" = $1`), ["name", "Mixed"], "unquoted names fold, quoted ones do not");
  assert.deepEqual(setColumns(`a = 'it''s, x = 1'`), ["a"]);
  assert.equal(setColumns(`(a, b) = ($1, $2)`), null);
  assert.equal(setColumns(`a = E'x\\', b = 1'`), null);
  assert.equal(setColumns(`a = $$x, y = 1$$`), null);
  assert.equal(setColumns(`a = (1`), null);
  assert.equal(setColumns(`a = 1)`), null);
  assert.equal(setColumns(`a == 1`), null);
});

test("an UPDATE by id drops the columns it sets of those rows and keeps the others", () => {
  const rows = new RowCache();
  rows.put("sale_order_line", 1, new Map<string, unknown>([["price_unit", 1], ["name", "x"], ["write_date", "d"]]));
  rows.put("sale_order_line", 2, new Map<string, unknown>([["price_unit", 2], ["name", "y"]]));
  rows.drop(writeEffect(`UPDATE "sale_order_line" SET "price_unit" = $1, "write_uid" = $2, "write_date" = (now() AT TIME ZONE 'UTC') WHERE id = $3`, [3, 2, 1]));
  assert.deepEqual(rows.row("sale_order_line", 1), new Map([["name", "x"]]));
  assert.deepEqual(rows.row("sale_order_line", 2), new Map<string, unknown>([["price_unit", 2], ["name", "y"]]));
  rows.drop(writeEffect(`UPDATE "sale_order_line" SET (name, price_unit) = ($1, $2) WHERE id = $3`, ["z", 4, 2]));
  assert.equal(rows.row("sale_order_line", 2), undefined, "an unread SET list drops the rows");
  assert.deepEqual(rows.row("sale_order_line", 1), new Map([["name", "x"]]));
});

test("an INSERT keeps the rows read and forgets the absent ids; allExist answers only for rows read and not deleted", () => {
  const rows = new RowCache();
  rows.put("sale_order_line", 1, new Map([["name", "x"]]));
  rows.put("sale_order_line", 9, null);
  assert.ok(rows.allExist("sale_order_line", [1]));
  assert.ok(!rows.allExist("sale_order_line", [1, 9]), "absent");
  assert.ok(!rows.allExist("sale_order_line", [1, 2]), "never read");
  rows.drop(writeEffect(`INSERT INTO "sale_order_line" ("name") VALUES ($1), ($2) RETURNING id`, ["a", "b"]));
  assert.deepEqual(rows.row("sale_order_line", 1), new Map([["name", "x"]]));
  assert.equal(rows.row("sale_order_line", 9), undefined);
  rows.drop(writeEffect(`UPDATE "sale_order_line" SET "name" = $1 WHERE id = $2`, ["y", 1]));
  assert.ok(rows.allExist("sale_order_line", [1]), "an UPDATE does not delete");
  rows.drop(writeEffect(`DELETE FROM "sale_order_line" WHERE id = $1`, [1]));
  assert.ok(!rows.allExist("sale_order_line", [1]));
  rows.put("sale_order_line", 1, new Map([["name", "x"]]));
  rows.drop(writeEffect(`UPDATE "sale_order_line" SET id = $1 WHERE id = $2`, [5, 1]));
  assert.ok(!rows.allExist("sale_order_line", [1]), "the row moved");
});

test("x2many cache with deps/words survives unrelated writes and drops on touching ones", () => {
  const rows = new RowCache();
  rows.putX2many("stock.picking.move_ids", 3, [10, 11], new Set(["stock_move"]), new Set(["id", "picking_id", "sequence", "stock_move"]));
  // Unrelated table: survives
  rows.drop(writeEffect(`UPDATE "sale_order" SET "state" = $1 WHERE id = $2`, ["sale", 1]));
  assert.deepEqual(rows.x2many("stock.picking.move_ids", 3), [10, 11]);
  // Same table, untouched column: survives
  rows.drop(writeEffect(`UPDATE "stock_move" SET "state" = $1 WHERE id = $2`, ["assigned", 10]));
  assert.deepEqual(rows.x2many("stock.picking.move_ids", 3), [10, 11]);
  // Same table, touched column: drops
  rows.drop(writeEffect(`UPDATE "stock_move" SET "picking_id" = $1 WHERE id = $2`, [4, 10]));
  assert.equal(rows.x2many("stock.picking.move_ids", 3), undefined);
  // Same table, INSERT: drops
  rows.putX2many("stock.picking.move_ids", 3, [10, 11], new Set(["stock_move"]), new Set(["id", "picking_id", "stock_move"]));
  rows.drop(writeEffect(`INSERT INTO "stock_move" ("picking_id") VALUES ($1)`, [3]));
  assert.equal(rows.x2many("stock.picking.move_ids", 3), undefined);
  // mentionedTables extracts plain tables from raw UPDATEs
  assert.deepEqual([...mentionedTables(`UPDATE sale_order_line l SET state = o.state FROM sale_order o WHERE l.order_id = o.id`, cat)!].sort(), ["sale_order", "sale_order_line"]);
  assert.equal(mentionedTables(`UPDATE sale_order SET state = 'x' FROM res_device`, cat), null);
});
