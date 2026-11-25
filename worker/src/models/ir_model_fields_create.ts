/**
 * `ir.model.fields.create` (odoo/odoo/addons/base/models/ir_model.py:1162-1214), B4: a custom (`x_`) field made in
 * Settings → Technical, used at once without a restart.
 *
 * Odoo first takes `model` from `model_id` (:1171-1180, refusing an inconsistent pair with a ValidationError), inserts
 * the rows (the ORM create), and then, for a model of the registry, re-runs `_setup_models__` and `init_models` on the
 * model and its `_inherits` descendants (:1206-1212, registry.py:812-867). Measured on Odoo's create of a char field on
 * res.partner (statement log, poc_erp): the INSERT, `ALTER TABLE ... ADD COLUMN ...; COMMENT ON COLUMN ...`, then the
 * reflection of the models (`_reflect_models`, `_reflect_fields`, `_reflect_selections`, `_reflect_constraints`,
 * `_reflect_inherits`: each upserts only the rows that differ, ir_model.py:503-538, :1367-1400, :1761-1801), and at
 * the commit `INSERT INTO orm_signaling_registry` (the registry changed: every process reloads it).
 *
 * The port does the same steps on its registry, whose fields are read from ir_model_fields (src/orm/registry.ts):
 *   - the field's own row: the ORM create, then the reflection's upsert of `_reflect_field_params` (:1327-1365) for it;
 *   - each `_inherits` descendant (res.users for res.partner) gets the inherited field (`_add_inherited_fields`,
 *     model_classes.py: related `<link>.<name>`, not stored, state 'base'), in the same upsert;
 *   - the selections of the models: the expected rows are the registry's (gen/: the order of Odoo's process), the
 *     differing ones are upserted. Measured: res.partner.tz's 35 Etc/* sequences, exactly Odoo's;
 *   - the xmlid upserts of the constraints and inherits (`_update_xmlids`, ON CONFLICT ... WHERE differs) write
 *     nothing on a consistent database but take one value of ir_model_data_id_seq per row: the port takes as many
 *     (the rows are the models' existing xmlids of ir.model.constraint and ir.model.inherit, measured 3 + 29);
 *   - `registryChanged`: this isolate drops its registry, the commit signals the others and Odoo.
 * The rows of the models' other fields are taken to be what the reflection expects (the template's, reflected by Odoo).
 *
 * In scope: stored scalar fields (char, text, integer, float, boolean, date, datetime) of a model of the registry,
 * not translated, required, indexed, related or computed. Anything else refuses (NotPorted), as before round 4.
 */
import { NotPorted, UserError, ValidationError } from "../errors";
import { registryChanged } from "../orm/signaling";
import { reloadRegistryOf } from "../orm/env";
import { pinTemplate, templateOf } from "../orm/template";
import type { Environment, ModelDef } from "../orm/types";
import { registerRecordCompute } from "../orm/recompute";
import { registerOverrides } from "../orm/write";
import { translate } from "./util";

/** The cursors inside ir.model.create (src/models/ir_model_create.ts), whose new models' fields are created first. */
export const creatingModels = new WeakSet<object>();
/** The cursors uninstalling modules with Python code (`registry.uninstalling_modules`, src/modules/uninstall.ts): the
 *  registry stays the one with their models until the load after the uninstall. */
export const uninstallingModules = new WeakSet<object>();

/** The column of a manual field (fields `column_type`; Float without digits is float8, fields_numeric.py). */
export const COLUMN_TYPE: Readonly<Record<string, string>> = {
  char: "varchar", text: "text", integer: "int4", float: "float8", boolean: "bool", date: "date", datetime: "timestamp", selection: "varchar",
};

/** `models.check_pg_name` (models.py): what `_check_name` (ir_model.py:761-768) accepts. */
const PG_NAME = /^[a-z_][a-z0-9_$]*$/i;

/** The columns of `_reflect_field_params` in Odoo's order (the upsert's cols, ['model', 'name'] first). */
export const FIELD_COLS = ["model", "name", "model_id", "field_description", "help", "ttype", "state", "relation", "index", "store",
  "copied", "on_delete", "related", "readonly", "required", "selectable", "size", "translate", "company_dependent",
  "relation_field", "relation_model_field", "relation_table", "column1", "column2", "currency_field", "sanitize",
  "sanitize_overridable", "sanitize_tags", "sanitize_attributes", "sanitize_style", "sanitize_form", "strip_style",
  "strip_classes", "tracking"] as const;
/** The translated columns: upsert_en keeps the other languages unless the source (en_US) changed (ir_model.py upsert_en). */
const TRANSLATED = new Set(["field_description", "help"]);

function unsupported(vals: Readonly<Record<string, unknown>>): string | null {
  const ttype = String(vals["ttype"] ?? "");
  if (!(ttype in COLUMN_TYPE)) return `field type ${ttype || "(none)"}`;
  if ((vals["state"] ?? "manual") !== "manual") return "a field of state " + String(vals["state"]);
  // a selection's options come as `selection_ids` commands (the deprecated `selection` text is not ported)
  for (const k of ["related", "compute", "depends", "index", "required", "translate", "company_dependent", "help", "groups", "tracking", "selection", ...(ttype === "selection" ? [] : ["selection_ids"])]) {
    if (vals[k] !== undefined && vals[k] !== false && vals[k] !== null && !(Array.isArray(vals[k]) && (vals[k] as unknown[]).length === 0)) return `the value ${k}`;
  }
  if (vals["store"] === false) return "a field that is not stored";
  // a Char's size (`varchar(n)`, fields_textual.py Char column_type); 0 or none is no size (:1523 `or None`)
  if (vals["size"] !== undefined && vals["size"] !== false && vals["size"] !== 0 && !(ttype === "char" && typeof vals["size"] === "number" && Number.isInteger(vals["size"]) && vals["size"] > 0)) return "the value size";
  if (vals["domain"] !== undefined && vals["domain"] !== false && vals["domain"] !== "[]") return "a domain";
  return null;
}

/** `registry.descendants(models, '_inherits')`: the models and, transitively, those that `_inherits` one of them. */
function inheritsDescendants(env: Environment, model: string): string[] {
  const out = [model];
  for (let i = 0; i < out.length; i++) {
    for (const [name, def] of env.reg.models) {
      if (!out.includes(name) && def.inherits.has(out[i]!)) out.push(name);
    }
  }
  return out;
}

/** The link field through which `child` reaches `parent`'s fields: `partner_id` (res.users), via intermediate parents. */
function linkTo(env: Environment, child: ModelDef, parent: string): string | null {
  for (const [p, link] of child.inherits) {
    if (p === parent) return link;
    if (linkTo(env, env.reg.model(p), parent) !== null) return link;
  }
  return null;
}

/** `upsert_en` of `_reflect_fields` (ir_model.py:1393-1396): the rows that differ, inserted or updated, one value of
 *  ir_model_fields_id_seq per row; the translated labels keep their other languages unless the source changed. */
export async function upsertFields(env: Environment, rows: readonly Record<(typeof FIELD_COLS)[number], unknown>[]): Promise<void> {
  if (!rows.length) return;
  const params: unknown[] = [];
  const values = rows.map((r) => `(${FIELD_COLS.map((c) => {
    const v = r[c];
    params.push(TRANSLATED.has(c) && v !== null ? JSON.stringify(v) : v);
    return `$${params.length}${TRANSLATED.has(c) ? "::jsonb" : ""}`;
  }).join(", ")})`).join(", ");
  const set = FIELD_COLS.map((c) => TRANSLATED.has(c)
    ? `CASE WHEN ir_model_fields."${c}" ->> 'en_US' IS DISTINCT FROM EXCLUDED."${c}" ->> 'en_US' THEN EXCLUDED."${c}" ELSE COALESCE(ir_model_fields."${c}", '{}'::jsonb) || EXCLUDED."${c}" END`
    : `EXCLUDED."${c}"`).join(", ");
  await env.cr.query(`INSERT INTO ir_model_fields (${FIELD_COLS.map((c) => `"${c}"`).join(", ")}) VALUES ${values}
    ON CONFLICT ("model", "name") DO UPDATE SET (${FIELD_COLS.map((c) => `"${c}"`).join(", ")}) = (${set}) RETURNING id`, params);
}

/** `_reflect_field_params` (ir_model.py:1327-1365) of a field in scope: `over` gives what differs from a stored,
 *  copied, writable scalar field without relation. */
export function fieldParams(over: Partial<Record<(typeof FIELD_COLS)[number], unknown>> & { model: string; name: string; model_id: unknown; ttype: string; label: string }): Record<(typeof FIELD_COLS)[number], unknown> {
  const out = Object.fromEntries(FIELD_COLS.map((c) => [c, null])) as Record<(typeof FIELD_COLS)[number], unknown>;
  Object.assign(out, { field_description: { en_US: over.label }, state: "manual", store: true, copied: true, readonly: false,
    required: false, selectable: true, company_dependent: false });
  const { label: _label, ...rest } = over;
  return Object.assign(out, rest);
}

type FieldRow = Record<(typeof FIELD_COLS)[number], unknown>;

/**
 * `_setup_models__` and `init_models` of `models` and their `_inherits` descendants after their manual fields changed
 * (ir_model.py:1206-1212 create, :1290-1299 write, registry.py:812-867): the new columns (`_auto_init`), the
 * reflection of the fields (`_reflect_fields`: the rows that differ from what the registry expects, :1367-1400; the
 * expected rows of the models' other fields are taken to be the stored ones, reflected by Odoo), the selections
 * (:1761-1801), the constraints' and inherits' xmlid upserts (one sequence value per row, nothing written on a
 * consistent database), then the registry signalled and loaded again for the rest of the transaction.
 */
export async function setupManualFields(env: Environment, models: readonly string[],
  newColumns: readonly { model: string; name: string; ttype: string; field_description: Record<string, string>; size: number | null }[]): Promise<void> {
  const all = [...new Set(models.flatMap((m) => inheritsDescendants(env, m)))];
  const modelIds = new Map((await env.cr.query<{ id: number; model: string }>("SELECT id, model FROM ir_model WHERE model = ANY($1::varchar[])", [all])).rows.map((r) => [r.model, r.id]));
  // _auto_init: the new columns (fields.py update_db_column, sql.py create_column)
  for (const f of newColumns) {
    const table = env.reg.model(f.model).table;
    await env.cr.query(`ALTER TABLE "${table}" ADD COLUMN "${f.name}" ${COLUMN_TYPE[f.ttype]}${f.ttype === "char" && f.size ? `(${f.size})` : ""}; COMMENT ON COLUMN "${table}"."${f.name}" IS '${(f.field_description["en_US"] ?? "").replace(/'/g, "''")}'`);
  }
  // _reflect_fields: the manual fields of `models` and their inherited copies, in the models' order
  const manual = (await env.cr.query<{ id: number; model: string; name: string; ttype: string; field_description: Record<string, string>; readonly: boolean | null; size: number | null }>(
    "SELECT id, model, name, ttype, field_description, readonly, size FROM ir_model_fields WHERE model = ANY($1::varchar[]) AND state = 'manual' ORDER BY id", [[...models]])).rows;
  const expected: FieldRow[] = [];
  for (const m of all) {
    for (const f of manual) {
      const own = m === f.model;
      let related: string | null = null;
      if (!own) {
        const def = env.reg.model(m);
        if (def.fields.has(f.name) && def.fields.get(f.name)!.related !== `${def.inherits.get(f.model) ?? ""}.${f.name}`) continue;
        const link = linkTo(env, def, f.model);
        if (link === null) continue;
        related = `${link}.${f.name}`;
      }
      expected.push(fieldParams({ model: m, name: f.name, model_id: modelIds.get(m), label: f.field_description["en_US"] ?? "",
        ttype: f.ttype, state: own ? "manual" : "base", store: own, related, readonly: f.readonly === true,
        // a Char's size, the related copy's too (`_related_size`)
        ...(f.ttype === "char" && f.size ? { size: f.size } : {}) }));
    }
  }
  const stored = new Map((await env.cr.query<Record<string, unknown>>(
    `SELECT ${FIELD_COLS.map((c) => TRANSLATED.has(c) ? `"${c}"->>'en_US' AS "${c}"` : `"${c}"`).join(", ")} FROM ir_model_fields WHERE model = ANY($1::varchar[])`,
    [all])).rows.map((r) => [`${String(r["model"])}.${String(r["name"])}`, r]));
  // `existing.get(row[:2]) != row` (:1391): every column, the labels in English
  await upsertFields(env, expected.filter((e) => {
    const r = stored.get(`${String(e.model)}.${String(e.name)}`);
    return r === undefined || FIELD_COLS.some((c) => (TRANSLATED.has(c) ? ((e[c] as Record<string, string> | null)?.["en_US"] ?? null) : e[c]) !== (r[c] ?? null));
  }));
  // _reflect_selections: the models' selections, the registry's (gen/: Odoo's process order) for the fields it has,
  // the stored options by sequence for a new manual one (`_get_selection_data`, ir_model.py:1869-1884)
  const fieldIds = new Map((await env.cr.query<{ id: number; model: string; name: string }>(
    "SELECT id, model, name FROM ir_model_fields WHERE model = ANY($1::varchar[])", [all])).rows.map((r) => [`${r.model}.${r.name}`, r.id]));
  const sel: [number, string, string, number][] = [];
  for (const m of all) {
    for (const [name, def] of env.reg.model(m).fields) {
      if ((def.type !== "selection" && def.type !== "reference") || def.selection === null || def.related !== null || def.manual) continue;
      const fid = fieldIds.get(`${m}.${name}`);
      if (fid === undefined) continue;
      def.selection.forEach((o, i) => sel.push([fid, o.value, o.label, i]));
    }
    for (const f of manual) {
      if (f.model !== m || f.ttype !== "selection") continue;
      const opts = (await env.cr.query<{ value: string; label: string }>(
        "SELECT value, name->>'en_US' AS label FROM ir_model_fields_selection WHERE field_id = $1 ORDER BY sequence, id", [f.id])).rows;
      opts.forEach((o, i) => sel.push([f.id, o.value, o.label, i]));
    }
  }
  if (sel.length) {
    const existing = new Map((await env.cr.query<{ field_id: number; value: string; label: string | null; sequence: number }>(
      `SELECT s.field_id, s.value, s.name->>'en_US' AS label, s.sequence FROM ir_model_fields_selection s, ir_model_fields f
        WHERE s.field_id = f.id AND f.model = ANY($1::varchar[])`, [all])).rows.map((r) => [`${r.field_id}\u0000${r.value}`, r]));
    const differ = sel.filter(([fid, value, label, seq]) => {
      const e = existing.get(`${fid}\u0000${value}`);
      return e === undefined || e.label !== label || e.sequence !== seq;
    });
    if (differ.length) {
      const params: unknown[] = [];
      const values = differ.map(([fid, value, label, seq]) => {
        params.push(fid, value, JSON.stringify({ en_US: label }), seq);
        const n = params.length;
        return `($${n - 3}, $${n - 2}, $${n - 1}::jsonb, $${n})`;
      }).join(", ");
      await env.cr.query(`INSERT INTO "ir_model_fields_selection" ("field_id", "value", "name", "sequence") VALUES ${values}
        ON CONFLICT ("field_id", "value") DO UPDATE SET ("field_id", "value", "name", "sequence") = (EXCLUDED."field_id", EXCLUDED."value", CASE
          WHEN "ir_model_fields_selection"."name" ->> 'en_US' IS DISTINCT FROM EXCLUDED."name" ->> 'en_US' THEN EXCLUDED."name"
          ELSE COALESCE("ir_model_fields_selection"."name", '{}'::jsonb) || EXCLUDED."name" END, EXCLUDED."sequence") RETURNING id`, params);
    }
  }
  // _reflect_constraints, _reflect_inherits: `_update_xmlids` of the existing xmlids, one sequence value per row
  const n = (await env.cr.query<{ n: number }>(
    `SELECT (SELECT count(*) FROM ir_model_data d JOIN ir_model_constraint c ON d.model = 'ir.model.constraint' AND d.res_id = c.id WHERE c.model = ANY($1::int[]))
          + (SELECT count(*) FROM ir_model_data d JOIN ir_model_inherit i ON d.model = 'ir.model.inherit' AND d.res_id = i.id WHERE i.model_id = ANY($1::int[])) AS n`, [[...modelIds.values()]])).rows[0]!.n;
  if (Number(n) > 0) await env.cr.query("SELECT nextval('ir_model_data_id_seq') FROM generate_series(1, $1::int)", [Number(n)]);
  await registryReloaded(env);
}

/** The registry changed: signalled at the commit, and loaded again for the rest of the transaction (Odoo's registry
 *  is shared by the process: a data file's next record sees the new fields). The database's template stays (a module
 *  being installed is not 'installed' yet). */
export async function registryReloaded(env: Environment): Promise<void> {
  const template = await templateOf(env.cr);
  registryChanged(env.cr);
  pinTemplate(env.cr.db, template);
  await reloadRegistryOf(env.cr, env.lang);
}

registerOverrides("ir.model.fields", {
  create: async (env, valsList, next) => {
    const targets: { model: string; name: string; vals: Record<string, unknown> }[] = [];
    for (const vals of valsList) {
      if ("model_id" in vals) {
        const id = vals["model_id"];
        if (typeof id !== "number" || !Number.isInteger(id)) throw new NotPorted("ir.model.fields.create with a model_id that is not an id");
        const row = (await env.cr.query<{ model: string }>("SELECT model FROM ir_model WHERE id = $1", [id])).rows[0];
        // `IrModel.browse(id).model` of a missing record raises MissingError in Odoo
        if (!row) throw new NotPorted("ir.model.fields.create with the id of a missing ir.model");
        if (vals["model"]) {
          if (vals["model"] !== row.model) {
            throw new ValidationError(translate(env, "Inconsistent values: model=%(model)s does not match model_id=%(model_id)s.", "base")
              .replace("%(model)s", String(vals["model"])).replace("%(model_id)s", String(id)));
          }
        } else vals["model"] = row.model;
      }
      const model = String(vals["model"] ?? "");
      const why = unsupported(vals);
      if (!env.reg.models.has(model)) {
        // a model being created (ir.model.create's `field_id`, src/models/ir_model_create.ts): Odoo sets nothing up
        // here (:1206 `any(model in self.pool ...)`), the model's own setup creates the table with these columns
        const row = (await env.cr.query<{ state: string }>("SELECT state FROM ir_model WHERE model = $1", [model])).rows[0];
        if (row?.state !== "manual" || !creatingModels.has(env.cr)) throw new NotPorted(`ir.model.fields.create on ${model || "no model"}: a field of a model outside the registry`);
        if (why) throw new NotPorted(`ir.model.fields.create of ${model}.${String(vals["name"] ?? "")}: ${why} (src/models/ir_model_fields_create.ts: stored scalar fields only)`);
        continue;
      }
      if (why) throw new NotPorted(`ir.model.fields.create of ${model}.${String(vals["name"] ?? "")}: ${why} (src/models/ir_model_fields_create.ts: stored scalar fields only)`);
      const name = String(vals["name"] ?? "x_");
      if (!PG_NAME.test(name) || name.length > 63) throw new ValidationError(translate(env, "Field names can only contain characters, digits and underscores (up to 63).", "base"));
      if (env.reg.model(model).fields.has(name)) throw new NotPorted(`ir.model.fields.create of ${model}.${name}: the model has the field already`);
      targets.push({ model, name, vals });
    }
    const ids = await next(env, valsList);
    if (!targets.length) return ids;
    // ir_model.py:1206-1212: the models of the registry are set up again and their tables updated
    const created = (await env.cr.query<{ model: string; name: string; ttype: string; field_description: Record<string, string>; size: number | null }>(
      "SELECT model, name, ttype, field_description, size FROM ir_model_fields WHERE id = ANY($1::int[]) ORDER BY id", [ids])).rows;
    await setupManualFields(env, [...new Set(targets.map((t) => t.model))], created);
    return ids;
  },
});

/** The stored computes of a created field (ir_model.py:669-682, :698-700); the relational cases refuse above. */
registerRecordCompute("ir.model.fields", {
  relation_field_id: async (_env, rec) => {
    if ((await rec.get("state")) === "manual" && (await rec.get("relation_field"))) throw new NotPorted("ir.model.fields.relation_field_id of a manual one2many");
    return false;
  },
  related_field_id: async (_env, rec) => {
    if ((await rec.get("state")) === "manual" && (await rec.get("related"))) throw new NotPorted("ir.model.fields.related_field_id of a manual related field");
    return false;
  },
  copied: async (_env, rec) => (await rec.get("ttype")) !== "one2many" && !((await rec.get("related")) || (await rec.get("compute"))),
});

/** The translated properties of ir.model.fields (`_get_writable_properties`, ir_model.py:1217-1218). */
const WRITABLE = new Set(["field_description", "help"]);
/** The values a write may repeat unchanged (a data file's record written again on an upgrade). */
const SAME_ALLOWED = new Set(["name", "ttype", "size", "readonly", "required", "store", "copied", "index", "translate", "related", "domain"]);

registerOverrides("ir.model.fields", {
  // ir_model.py:1220-1305 write: the translated properties of any field, or a manual field's values; then the models
  // set up again (and, for a manual field's other values, their schema and reflection)
  write: async (env, ids, values, next) => {
    const vals = { ...values };
    const keys = Object.keys(vals);
    if (!ids.length) return;
    const writableOnly = keys.every((k) => WRITABLE.has(k));
    const rows = (await env.cr.query<Record<string, unknown> & { id: number; model: string; name: string; state: string; model_id: number; ttype: string }>(
      `SELECT * FROM ir_model_fields WHERE id = ANY($1::int[]) ORDER BY id`, [[...ids]])).rows;
    const patched = new Set<string>();
    if (keys.length && !writableOnly) {
      for (const r of rows) {
        if (r.state !== "manual") throw new UserError(translate(env, "Properties of base fields cannot be altered in this manner! Please modify them through Python code, preferably through a custom addon!", "base"));
        if ("model_id" in vals && vals["model_id"] !== r.model_id) throw new UserError(translate(env, "Changing the model of a field is forbidden!", "base"));
        if ("ttype" in vals && vals["ttype"] !== r.ttype) throw new UserError(translate(env, "Changing the type of a field is not yet supported. Please drop it and create it again!", "base"));
        for (const k of keys) {
          if (WRITABLE.has(k) || k === "model_id" || k === "model" || k === "state") continue;
          if (!SAME_ALLOWED.has(k)) throw new NotPorted(`ir.model.fields.write of ${k} on a manual field (src/models/ir_model_fields_create.ts)`);
          const v = vals[k] === false && k !== "readonly" && k !== "required" && k !== "store" && k !== "copied" ? null : vals[k];
          if ((v ?? null) !== (r[k] ?? null) && !(k === "domain" && (v ?? "[]") === (r[k] ?? "[]"))) throw new NotPorted(`ir.model.fields.write changing ${k} of a manual field (its schema)`);
        }
        if (env.reg.models.get(r.model)?.fields.has(r.name)) patched.add(r.model);
      }
    }
    // :1262-1264 these are never written
    for (const k of ["model_id", "model", "state"]) delete vals[k];
    await next(env, ids, vals);
    if (patched.size) await setupManualFields(env, [...patched], []);
    else if (writableOnly && keys.length) await registryReloaded(env);
  },
});

registerOverrides("ir.model.fields.selection", {
  // ir_model.py:1886-1912: options of a manual field; options added to a field of the registry set it up again
  create: async (env, valsList, next) => {
    const fieldIds = [...new Set(valsList.map((v) => Number(v["field_id"])))];
    const fields = (await env.cr.query<{ model: string; name: string; state: string }>("SELECT model, name, state FROM ir_model_fields WHERE id = ANY($1::int[])", [fieldIds])).rows;
    for (const f of fields) {
      if (f.state !== "manual") throw new UserError(translate(env, "Properties of base fields cannot be altered in this manner! Please modify them through Python code, preferably through a custom addon!", "base"));
      if (env.reg.models.get(f.model)?.fields.has(f.name)) throw new NotPorted("ir.model.fields.selection.create on a field of the registry (its setup again)");
    }
    return next(env, valsList);
  },
});

/** models.MAGIC_COLUMNS (models.py): never dropped. */
const MAGIC_COLUMNS = new Set(["id", "create_uid", "create_date", "write_uid", "write_date"]);

registerOverrides("ir.model.fields", {
  // ir_model.py:1116-1157 unlink, as a module uninstall runs it (`force_delete`, the registry uninstalling: no setup of
  // the models afterwards, ir_model_data.py `_module_data_uninstall`); a field deleted from Settings refuses
  unlink: async (env, ids, next) => {
    if (!ids.length) return next(env, ids);
    if (!env.context["force_delete"]) throw new NotPorted("ir.model.fields.unlink outside a module uninstall (the models set up and reflected again)");
    const rows = (await env.cr.query<{ id: number; model: string; name: string; state: string; ttype: string; store: boolean | null; related: string | null }>(
      "SELECT id, model, name, state, ttype, store, related FROM ir_model_fields WHERE id = ANY($1::int[])", [[...ids]])).rows;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const records = ids.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
    // :1027-1066 `_prepare_update`: the inherited copies of the fields go with them; another manual field depending on
    // one of them refuses (force_delete would delete it too)
    for (const r of [...records]) {
      if (!env.reg.models.get(r.model)?.fields.has(r.name)) continue;
      for (const m of inheritsDescendants(env, r.model).slice(1)) {
        const def = env.reg.model(m);
        const link = linkTo(env, def, r.model);
        const copy = (await env.cr.query<{ id: number; model: string; name: string; state: string; ttype: string; store: boolean | null; related: string | null }>(
          "SELECT id, model, name, state, ttype, store, related FROM ir_model_fields WHERE model = $1 AND name = $2 AND related = $3", [m, r.name, `${link}.${r.name}`])).rows[0];
        if (copy && !records.some((x) => x.id === copy.id)) records.push(copy);
      }
      const dependents = (await env.cr.query<{ n: string }>(
        `SELECT model || '.' || name AS n FROM ir_model_fields WHERE state = 'manual' AND id != ALL($1::int[])
          AND (related LIKE $2 OR depends LIKE $2)`, [records.map((x) => x.id), `%${r.name}%`])).rows;
      if (dependents.length) throw new NotPorted(`ir.model.fields.unlink of ${r.model}.${r.name}: ${dependents[0]!.n} depends on it`);
    }
    // :992-1024 `_drop_column`
    for (const r of records) {
      if (MAGIC_COLUMNS.has(r.name)) continue;
      const def = env.reg.models.get(r.model);
      if (r.store && def) {
        if (r.state === "manual" && r.ttype === "many2many") throw new NotPorted("ir.model.fields.unlink of a manual many2many (its relation table)");
        const exists = (await env.cr.query("SELECT 1 FROM information_schema.columns c JOIN pg_class t ON t.relname = c.table_name AND t.relkind = 'r' WHERE c.table_schema = 'public' AND c.table_name = $1 AND c.column_name = $2", [def.table, r.name])).rows.length;
        if (exists) await env.cr.query(`ALTER TABLE "${def.table}" DROP COLUMN "${r.name}" CASCADE`);
      }
    }
    await next(env, records.map((r) => r.id));
    // the registry without the fields (`_discard_fields`, will_change_registry); while modules are uninstalled it stays
    // (ir_model.py:1149 `self.pool.uninstalling_modules`), loaded again after their uninstall
    if (!uninstallingModules.has(env.cr)) await registryReloaded(env);
  },
});
