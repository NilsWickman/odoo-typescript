/**
 * Values of a `write(vals)` or `create(vals_list)` in the form the RPC layer gives them, whatever their source
 * (K2-base round 4: a silent class found by the compiler thread). Compiled code passes Python values through
 * compiler/runtime/records.ts toJs: an integral float as a PyFloat object (`{float: 35}`; `Number()` of it is NaN and
 * `!x` is false even for 0.0), a Markup instance (not a `typeof === "string"`), None as null (where the web client sends
 * false). The hand port's write and create hooks read `vals` before the ORM converts it (inventory_flow.ts
 * dropZeroQuantity tested `!Number(vals.standard_price)` and so dropped every compiled cost write, 676b4f3).
 *
 * Here, at the top of orm/write.ts write() and orm/create.ts create(), before any hook, each value of a field is put
 * in the form Odoo's convert_to_cache gives it for the field's type, so the hooks see what an RPC call would send:
 *   integer, float, monetary: a PyFloat is its number; None is False (`value or 0` / `float(value or 0.0)`)
 *   boolean: a PyFloat is `bool(value)`; None is False
 *   char, text, selection, html: a PyFloat is `str(value)` ("35.0"), a Markup its text (BaseString.convert_to_cache,
 *     fields_textual.py:137 `str(value)`, before an html field's sanitizing); None is False
 *   many2one, date, datetime, reference, many2one_reference: None is False; a PyFloat refuses (Odoo raises)
 *   one2many, many2many: the values of the create/update commands, recursively for the comodel
 *   json, properties, binary and the rest: unchanged (a json value keeps 100.0 apart from 100, as Python does)
 * Keys that are not fields are left to the hooks and the ORM's own checks. The object is changed in place (the
 * hooks change it too); RPC values are already in this form, so an RPC call is unchanged.
 */
import { NotPorted } from "../errors";
import { Markup } from "../pyexpr/values";
import { pyFloatRepr } from "../http/json";
import { isPyFloat } from "./values";
import type { Environment } from "./types";

type Vals = Record<string, unknown>;

const NUMERIC = new Set(["integer", "float", "monetary"]);
const TEXT = new Set(["char", "text", "selection", "html"]);
const REF = new Set(["many2one", "date", "datetime", "reference", "many2one_reference"]);

export function normalizeVals(env: Environment, model: string, vals: Vals): void {
  const def = env.reg.models.get(model);
  if (!def) return;
  for (const [name, v] of Object.entries(vals)) {
    const f = def.fields.get(name);
    if (!f) continue;
    if (NUMERIC.has(f.type)) {
      if (isPyFloat(v)) vals[name] = v.float;
      else if (v === null) vals[name] = false;
    } else if (f.type === "boolean") {
      if (isPyFloat(v)) vals[name] = v.float !== 0;
      else if (v === null) vals[name] = false;
    } else if (TEXT.has(f.type)) {
      if (isPyFloat(v)) vals[name] = pyFloatRepr(v.float);
      else if (v instanceof Markup) vals[name] = v.toString();
      else if (v === null) vals[name] = false;
    } else if (REF.has(f.type)) {
      if (isPyFloat(v)) throw new NotPorted(`a float written to ${model}.${name} (${f.type})`);
      if (v === null) vals[name] = false;
    } else if ((f.type === "one2many" || f.type === "many2many") && Array.isArray(v) && f.relation) {
      for (const c of v) {
        if (Array.isArray(c) && (c[0] === 0 || c[0] === 1) && c[2] !== null && typeof c[2] === "object" && !Array.isArray(c[2])) {
          normalizeVals(env, f.relation, c[2] as Vals);
        }
      }
    }
  }
}

export function normalizeValsList(env: Environment, model: string, valsList: readonly Vals[]): void {
  for (const vals of valsList) if (vals !== null && typeof vals === "object") normalizeVals(env, model, vals);
}
