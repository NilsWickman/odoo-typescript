/**
 * `default_get` (odoo/odoo/orm/models.py:1317-1405): context `default_*` keys, `ir.default` rows
 * (odoo/addons/base/models/ir_default.py:174 `_get_model_defaults`), the fields' Python `default=` (ported per model,
 * src/orm/recompute.ts registerDefaults), then conversion to the write format. Model overrides
 * (`res.partner.default_get`, res_partner.py:284) run through src/orm/write.ts registerOverrides.
 */
import { NotPorted } from "../errors";
import { parseCommands } from "../orm/commands";
import { convertToCache } from "../orm/convert";
import { defaultsPorted, fieldDefault } from "../orm/recompute";
import { overridesOf } from "../orm/write";
import { hasFieldAccess, modelDefaults } from "../orm/sql";
import { sanitizeHtml } from "../orm/write_values";
import { generatedDefault, hasGeneratedDefaults } from "../orm/defaults_gen";
import type { Environment, FieldDef } from "../orm/types";
import { isPyFloat, pyFloat } from "../orm/values";
import { Markup } from "../pyexpr/values";
import { registerBaseMethod } from "./register";

/** ir_default.py:174: highest priority value per field (user, then company, then global; oldest first). */
async function irDefaults(env: Environment, model: string): Promise<Map<string, unknown>> {
  return modelDefaults(env, model, env.uid, await env.company());
}

/** `convert_to_write(convert_to_cache(value))` of a default value (models.py:1371-1400). */
export async function toWriteFormat(env: Environment, model: string, field: FieldDef, value0: unknown): Promise<unknown> {
  // markupsafe.Markup is a str: its text (a compiled default returning web's nl2br_enclose, base.document.layout)
  const value = value0 instanceof Markup ? value0.toString() : value0;
  if (field.type === "one2many" || field.type === "many2many") {
    // stepping through the cache normalises commands into [(SET, 0, ids)] (models.py:1363-1369);
    // CREATE/UPDATE lines in a default are new records in the cache (PORTING_odoo.md 12.8): not ported
    const ids: number[] = [];
    // CREATE lines are new records in the cache; convert_to_write (fields_relational.py:736-767) gives them back as
    // Command.create of their cached values after Command.set of the real ids
    const creates: unknown[] = [];
    // models.py:1378-1399: a one2many's LINK and UNLINK write the inverse of the linked records (checked for write
    // access, not ported); a SET is not checked
    let checked = false;
    for (const cmd of parseCommands(value === false ? [] : value, `${model}.${field.name}`)) {
      if (cmd.op === "create") { creates.push([0, 0, { ...(cmd.values as Record<string, unknown>) }]); continue; }
      if (cmd.op === "link" || cmd.op === "unlink") checked = true;
      switch (cmd.op) {
        case "link": if (!ids.includes(cmd.id)) ids.push(cmd.id); break;
        case "set": ids.length = 0; for (const id of cmd.ids) if (!ids.includes(id)) ids.push(id); break;
        case "clear": ids.length = 0; break;
        case "unlink": case "delete": { const i = ids.indexOf(cmd.id); if (i >= 0) ids.splice(i, 1); break; }
        default: throw new NotPorted(`x2many default with ${cmd.op} command (${model}.${field.name})`);
      }
    }
    if (!env.su && field.type === "one2many" && checked) throw new NotPorted(`one2many default LINK access check (${model}.${field.name})`);
    return [[6, 0, ids], ...creates];
  }
  if (field.type === "html" && typeof value === "string" && value !== "" && field.sanitize?.["sanitize"]) {
    return sanitizeHtml(env, env.reg.model(model), field, value);
  }
  // base64 or {content, filename} (a BinaryBytes with its name), both understood by the record cache of an onchange
  if ((field.type === "binary" || field.type === "image") && (typeof value === "string" || (typeof value === "object" && value !== null && "content" in value))) return value;
  const cache = convertToCache(field, isPyFloat(value) ? value.float : value, model);
  if (cache === null || cache === undefined) return false;
  return cache;
}

/** models.py:1317 default_get(fields): the ORM's, then the model's hand-ported override of it. */
export async function defaultGet(env: Environment, model: string, fields: readonly string[]): Promise<Record<string, unknown>> {
  const defaults = await defaultGetBase(env, model, fields);
  const override = overridesOf(model).defaultGet;
  if (override) await override(env, fields, defaults);
  return defaults;
}

/** models.py:1317-1405 BaseModel.default_get itself, without the model's overrides: what `super().default_get()` of a
 *  compiled override chain reaches (compiler/runtime/records.ts), the chain being every override. */
export async function defaultGetBase(env: Environment, model: string, fields: readonly string[]): Promise<Record<string, unknown>> {
  const def = env.reg.model(model);
  // a custom model has no Python defaults (its fields are manual ones and the magic fields, ir_model.py:1503-1560)
  if (!def.custom && !defaultsPorted(model) && !(await hasGeneratedDefaults(env, model))) throw new NotPorted(`default values (Python default=) of ${model}`);
  const defaults: Record<string, unknown> = {};
  const ir = await irDefaults(env, model);
  const parentFields = new Map<string, string[]>();
  for (const name of fields) {
    const key = `default_${name}`;
    if (key in env.context) { defaults[name] = env.context[key]; continue; }
    const field = def.fields.get(name);
    if (!field) continue;
    if (!field.companyDependent && ir.has(name)) { defaults[name] = ir.get(name); continue; }
    const fn = fieldDefault(model, name);
    if (fn) {
      const v = await fn(env);
      if (v !== undefined) { defaults[name] = v; continue; }
    } else {
      // gen/write_defaults.py: the field's `default=` (constants and known lambda patterns)
      const v = await generatedDefault(env, model, name);
      if (v !== undefined) { defaults[name] = v; continue; }
    }
    if (field.companyDependent && ir.has(name)) { defaults[name] = ir.get(name); continue; }
    // models.py:1360 5. delegate to the parent model (when the user may write the field)
    if (field.inheritedFrom && await hasFieldAccess(env, field)) parentFields.set(field.inheritedFrom, [...(parentFields.get(field.inheritedFrom) ?? []), name]);
  }
  for (const [name, value] of Object.entries(defaults)) {
    const field = def.fields.get(name);
    if (!field) continue;
    defaults[name] = await toWriteFormat(env, model, field, value);
  }
  // models.py:1402 add default values for inherited fields
  for (const [parent, names] of parentFields) Object.assign(defaults, await defaultGet(env, parent, names));
  return defaults;
}

registerBaseMethod("default_get", async (env, _ids, args, kwargs, model) => {
  const raw = kwargs["fields"] ?? args[0];
  if (!Array.isArray(raw) || !raw.every((x): x is string => typeof x === "string")) throw new NotPorted("default_get fields");
  const out = await defaultGet(env, model, raw);
  // fields_numeric.py Float/Monetary convert_to_write: a float, which JSON-RPC writes as 12.0 (lunch.supplier's
  // automatic_email_time default 12.0 came back as 12); only here, where the answer leaves for JSON: the hand port's
  // own callers (create's defaults) keep plain numbers
  const def = env.reg.model(model);
  for (const [name, v] of Object.entries(out)) {
    const t = def.fields.get(name)?.type;
    if ((t === "float" || t === "monetary") && typeof v === "number") out[name] = pyFloat(v);
  }
  return out;
}, { apiModel: true });
