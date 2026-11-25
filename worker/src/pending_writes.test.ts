import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildUpdates, PendingWrites, type PendingValue } from "./pending_writes";

const val = (sqlVal: unknown, pgType: string): PendingValue => ({ kind: "val", sqlVal, pgType });
const now: PendingValue = { kind: "now" };

test("merges sequential writes to the same record and table into one UPDATE", () => {
  const pw = new PendingWrites();
  pw.put("stock_move", 10, new Map([["is_in", val(false, "bool")], ["write_uid", val(2, "int4")], ["write_date", now]]));
  pw.put("stock_move", 10, new Map([["is_out", val(true, "bool")], ["product_qty", val("2.00", "numeric")], ["write_uid", val(2, "int4")], ["write_date", now]]));
  pw.put("stock_move", 10, new Map([["product_qty", val("3.00", "numeric")]]));

  const rows = pw.takeTable("stock_move")!;
  assert.equal(pw.size, 0);
  const stmts = buildUpdates("stock_move", rows);
  assert.equal(stmts.length, 1);
  assert.equal(
    stmts[0]!.text,
    `UPDATE "stock_move" SET "is_in" = $1, "is_out" = $2, "product_qty" = $3, "write_date" = (now() AT TIME ZONE 'UTC'), "write_uid" = $4 WHERE id = $5`,
  );
  assert.deepEqual(stmts[0]!.params, [false, true, "3.00", 2, 10]);
});

test("uses WHERE id = ANY for identical multi-row values and FROM (VALUES ...) for differing values", () => {
  const pw = new PendingWrites();
  // Same values -> ANY
  pw.put("stock_move", 1, new Map([["state", val("assigned", "varchar")], ["write_date", now]]));
  pw.put("stock_move", 2, new Map([["state", val("assigned", "varchar")], ["write_date", now]]));
  const same = buildUpdates("stock_move", pw.takeTable("stock_move")!);
  assert.equal(same.length, 1);
  assert.equal(
    same[0]!.text,
    `UPDATE "stock_move" SET "state" = $1, "write_date" = (now() AT TIME ZONE 'UTC') WHERE id = ANY($2::int[])`,
  );
  assert.deepEqual(same[0]!.params, ["assigned", [1, 2]]);

  // Differing values -> constant columns in SET, varying columns in VALUES
  pw.put("stock_move", 1, new Map([["is_in", val(false, "bool")], ["product_qty", val("2.00", "numeric")], ["write_uid", val(2, "int4")], ["write_date", now]]));
  pw.put("stock_move", 2, new Map([["is_in", val(false, "bool")], ["product_qty", val("5.00", "numeric")], ["write_uid", val(2, "int4")], ["write_date", now]]));
  const diff = buildUpdates("stock_move", pw.takeTable("stock_move")!);
  assert.equal(diff.length, 1);
  assert.equal(
    diff[0]!.text,
    `UPDATE "stock_move" SET "is_in" = $1, "write_date" = (now() AT TIME ZONE 'UTC'), "write_uid" = $2, "product_qty" = "__tmp"."product_qty" FROM (VALUES ($3::int4, $4::"numeric"), ($5::int4, $6::"numeric")) AS "__tmp"("id", "product_qty") WHERE "stock_move"."id" = "__tmp"."id"`,
  );
  assert.deepEqual(diff[0]!.params, [false, 2, 1, "2.00", 2, "5.00"]);
});

test("groups records by their set of updated columns", () => {
  const pw = new PendingWrites();
  pw.put("stock_move", 1, new Map([["state", val("done", "varchar")]]));
  pw.put("stock_move", 2, new Map([["state", val("done", "varchar")], ["is_out", val(true, "bool")]]));
  pw.put("stock_move", 3, new Map([["state", val("cancel", "varchar")]]));
  const stmts = buildUpdates("stock_move", pw.takeTable("stock_move")!);
  assert.equal(stmts.length, 2);
  assert.match(stmts[0]!.text, /FROM \(VALUES /);
  assert.deepEqual(stmts[0]!.params, [1, "done", 3, "cancel"]);
  assert.equal(stmts[1]!.text, `UPDATE "stock_move" SET "is_out" = $1, "state" = $2 WHERE id = $3`);
  assert.deepEqual(stmts[1]!.params, [true, "done", 2]);
});

test("tablesToFlushForRead flushes only tables whose pending columns a SELECT may read", () => {
  const pw = new PendingWrites();
  pw.put("stock_move", 1, new Map([["is_in", val(false, "bool")], ["write_date", now]]));
  pw.put("stock_picking", 2, new Map([["shipping_weight", val("1.5", "float8")]]));

  assert.deepEqual(pw.tablesToFlushForRead(new Set(["sale_order"]), new Set(["select", "id", "from", "sale_order"])), []);
  assert.deepEqual(pw.tablesToFlushForRead(new Set(["stock_move"]), new Set(["select", "state", "from", "stock_move"])), []);
  assert.deepEqual(pw.tablesToFlushForRead(new Set(["stock_move"]), new Set(["select", "is_in", "from", "stock_move"])), ["stock_move"]);
  assert.deepEqual(pw.tablesToFlushForRead(new Set(["stock_move"]), null), ["stock_move"]);
  assert.deepEqual(pw.tablesToFlushForRead(null, null), ["stock_move", "stock_picking"]);
});
