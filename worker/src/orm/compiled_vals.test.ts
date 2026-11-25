// orm/compiled_vals.ts: the values compiled code writes (compiler/runtime/records.ts toJs: an integral float as a
// PyFloat object, a Markup instance, None as null) put in the RPC layer's form before the write/create hooks read
// them. Each case shows the hook pattern's silent answer on the raw value and Python's answer after normalizeVals
// (the expected strings and numbers are CPython's: str(35.0), bool(0.0), int(35.0), str(Markup(...))).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Markup } from "../pyexpr/values";
import { normalizeVals, normalizeValsList } from "./compiled_vals";
import type { Environment } from "./types";

function envOf(models: Record<string, Record<string, { type: string; relation?: string }>>): Environment {
  const defs = new Map(Object.entries(models).map(([name, fields]) =>
    [name, { name, fields: new Map(Object.entries(fields).map(([n, f]) => [n, { name: n, ...f }])) }]));
  return { reg: { models: defs, model: (n: string) => defs.get(n) } } as unknown as Environment;
}

const env = envOf({
  "x.prod": {
    standard_price: { type: "float" }, qty: { type: "float" }, probability: { type: "float" }, amount: { type: "monetary" },
    sequence: { type: "integer" }, active: { type: "boolean" }, flag: { type: "boolean" }, name: { type: "char" },
    note: { type: "text" }, state: { type: "selection" }, body: { type: "html" }, partner_id: { type: "many2one", relation: "x.partner" },
    date: { type: "date" }, data: { type: "json" }, line_ids: { type: "one2many", relation: "x.line" },
  },
  "x.line": { price_unit: { type: "float" }, label: { type: "char" } },
});

test("a PyFloat in a numeric field: the hooks' Number(), truthiness and typeof answer as for the RPC value", () => {
  const raw = { standard_price: { float: 0 }, qty: { float: 35 }, probability: { float: 35 }, amount: { float: 1e16 }, sequence: { float: -2 } };
  // before: inventory_flow.ts dropZeroQuantity `!Number(vals.standard_price)` (676b4f3), stock_engine.ts
  // `Number(vals.quantity || 0)`, crm_lead_write.ts `typeof vals.probability === "number"`
  assert.ok(Number.isNaN(Number(raw.standard_price)));
  assert.equal(!raw.standard_price, false); // a 0.0 cost is not "empty"
  assert.ok(Number.isNaN(Number(raw.qty || 0)));
  assert.equal(typeof raw.probability === "number" ? raw.probability : 0, 0);
  const vals: Record<string, unknown> = { ...raw };
  normalizeVals(env, "x.prod", vals);
  assert.deepEqual(vals, { standard_price: 0, qty: 35, probability: 35, amount: 1e16, sequence: -2 });
  assert.equal(!vals["standard_price"], true);
  assert.equal(Number(vals["qty"] || 0), 35);
  assert.equal(typeof vals["probability"] === "number" ? vals["probability"] : 0, 35);
});

test("None is False in scalar fields: the hooks' `=== false` checks answer as for the RPC value", () => {
  const vals: Record<string, unknown> = { active: null, name: null, state: null, body: null, partner_id: null, date: null, qty: null };
  // before: res_users_prefs.ts `vals.active === false` (deactivating oneself), calendar_computes.ts `vals.recurrency === false`
  assert.equal(vals["active"] === false, false);
  normalizeVals(env, "x.prod", vals);
  assert.deepEqual(vals, { active: false, name: false, state: false, body: false, partner_id: false, date: false, qty: false });
});

test("char, text, selection, html: a PyFloat is str(value), a Markup its text (fields_textual.py:137)", () => {
  const m = new Markup("<b>x</b>");
  const vals: Record<string, unknown> = { name: { float: 35 }, note: { float: 1e22 }, state: m, body: m, flag: { float: 0 } };
  assert.equal(String(vals["name"]), "[object Object]"); // before: stock_warehouse.ts `String(vals.code)` and the like
  normalizeVals(env, "x.prod", vals);
  assert.equal(vals["name"], "35.0");
  assert.equal(vals["note"], "1e+22");
  assert.equal(vals["state"], "<b>x</b>");
  assert.equal(vals["body"], "<b>x</b>"); // before: mail_message_create.ts `typeof values.body === "string"` skipped its check
  assert.equal(vals["flag"], false);
});

test("the values of x2many create/update commands, json and other keys left as they are, a float id refuses", () => {
  const data = { "12": { float: 100 } };
  const vals: Record<string, unknown> = { line_ids: [[0, 0, { price_unit: { float: 10 }, label: { float: 2 } }], [1, 7, { price_unit: null }], [4, 3]], data, extra: { float: 1 } };
  normalizeValsList(env, "x.prod", [vals]);
  assert.deepEqual(vals["line_ids"], [[0, 0, { price_unit: 10, label: "2.0" }], [1, 7, { price_unit: false }], [4, 3]]);
  assert.equal(vals["data"], data); // json keeps 100.0 apart from 100, as Python's json column does
  assert.deepEqual(vals["extra"], { float: 1 }); // not a field: the hook's own business
  assert.throws(() => normalizeVals(env, "x.prod", { partner_id: { float: 3 } }), (e: unknown) => e instanceof Error && e.constructor.name === "NotPorted");
});

test("RPC values are unchanged", () => {
  const vals: Record<string, unknown> = { standard_price: 0, qty: 2.5, active: true, name: "a", partner_id: 3, line_ids: [[0, 0, { price_unit: 1 }]] };
  const copy = JSON.parse(JSON.stringify(vals)) as unknown;
  normalizeVals(env, "x.prod", vals);
  assert.deepEqual(vals, copy);
});
