/**
 * `ir.model.create` (odoo/odoo/addons/base/models/ir_model.py:455-470), B4: a custom (`x_`) model made in Settings →
 * Technical → Models and used without a restart.
 *
 * Odoo creates the rows (the model, and its `field_id`: by default an `x_name` char, :233-236), checks the name
 * (`_check_model_name`, :291-296: a ValidationError rolls back after the rows took their ids), sets the registry up
 * again and runs `init_models` on the new models (registry.py:812-867). Measured on Odoo's create of `x_dm_visit` with
 * a char and an integer field (statement log, poc_erp), after the ORM's inserts:
 *   - `CREATE TABLE` with the stored columns in `column_order` (sql.py SQL_ORDER_BY_TYPE: int4, varchar, date, jsonb,
 *     text, numeric, bool, timestamp, float8, a stable sort of `_fields`), the table and column comments;
 *   - `_reflect_models`: the model's row upserted (`_reflect_model_params`, :476-495: `info` is the docstring of
 *     `Model`, `explanation` False, written as the text 'false');
 *   - `_reflect_fields`: every field upserted in `_fields` order (the magic fields, then the manual ones), the new
 *     magic rows taking their ids from that upsert;
 *   - `check_foreign_keys`: create_uid and write_uid reference res_users ON DELETE set null;
 *   - the registry signal at the commit.
 * No selections, constraints, inherits or xmlids for a custom model without a module (:2163, `_reflect_models` without
 * `module`).
 *
 * In scope: a regular model (not abstract or transient, no `_inherit`, order 'id') with fields of
 * src/models/ir_model_fields_create.ts's scope. The rest refuses.
 */
import { NotPorted, ValidationError } from "../errors";
import { registryChanged } from "../orm/signaling";
import { reloadRegistryOf } from "../orm/env";
import { pinTemplate, templateOf } from "../orm/template";
import type { Environment } from "../orm/types";
import { registerOverrides } from "../orm/write";
import { COLUMN_TYPE, creatingModels, fieldParams, upsertFields } from "./ir_model_fields_create";
import { translate } from "./util";

/** sql.py SQL_ORDER_BY_TYPE (others 16). */
const ORDER_BY_TYPE: Readonly<Record<string, number>> = { int4: 1, varchar: 2, date: 3, jsonb: 4, text: 5, numeric: 6, bool: 7, timestamp: 8, float8: 9 };

/** odoo/orm/models.py `class Model`'s docstring: `info` of a model whose classes have none (a custom model). */
const MODEL_DOC = " Main super-class for regular database-persisted Odoo models.\n\n    Odoo models are created by inheriting from this class::\n\n        class ResUsers(Model):\n            ...\n\n    The system will later instantiate the class once per database (on\n    which the class' module is installed).\n    ";

/** The magic fields of a model with `_log_access` (models.py, model_classes.py `_add_magic_fields`), in `_fields` order. */
const MAGIC: readonly { name: string; ttype: string; label: string; column: string | null; relation?: string }[] = [
  { name: "id", ttype: "integer", label: "ID", column: null },
  { name: "display_name", ttype: "char", label: "Display Name", column: null },
  { name: "create_uid", ttype: "many2one", label: "Created by", column: "int4", relation: "res.users" },
  { name: "create_date", ttype: "datetime", label: "Created on", column: "timestamp" },
  { name: "write_uid", ttype: "many2one", label: "Last Updated by", column: "int4", relation: "res.users" },
  { name: "write_date", ttype: "datetime", label: "Last Updated on", column: "timestamp" },
];

const quote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

registerOverrides("ir.model", {
  create: async (env, valsList, next) => {
    for (const vals of valsList) {
      if ((vals["state"] ?? "manual") !== "manual") throw new NotPorted("ir.model.create of a model of state " + String(vals["state"]));
      for (const k of ["abstract", "transient", "inherited_model_ids", "fold_name", "is_mail_thread", "is_mail_activity", "is_mail_blacklist"]) {
        if (vals[k]) throw new NotPorted(`ir.model.create with ${k} (src/models/ir_model_create.ts: a regular model only)`);
      }
      if (vals["order"] !== undefined && vals["order"] !== "id") throw new NotPorted("ir.model.create with an order other than 'id'");
      // :233-236 `_default_field_id`: an x_name char unless importing
      if (!("field_id" in vals) && !env.context["install_mode"]) {
        vals["field_id"] = [[0, 0, { name: "x_name", field_description: "Name", ttype: "char", copied: true }]];
      }
    }
    creatingModels.add(env.cr);
    let ids: number[];
    try {
      ids = await next(env, valsList);
    } finally {
      creatingModels.delete(env.cr);
    }
    // the constraints, at the end of create (models.py `_validate_fields`): :291-296 `_check_model_name`
    const rows = (await env.cr.query<{ id: number; model: string; name: Record<string, string>; state: string }>(
      "SELECT id, model, name, state FROM ir_model WHERE id = ANY($1::int[]) ORDER BY id", [ids])).rows;
    for (const r of rows) {
      if (r.state === "manual" && !r.model.startsWith("x_")) throw new ValidationError(translate(env, "The model name must start with 'x_'.", "base"));
      if (!/^[a-z0-9_.]+$/.test(r.model)) throw new ValidationError(translate(env, "The model name can only contain lowercase characters, digits, underscores and dots.", "base"));
      if (env.reg.models.has(r.model)) throw new NotPorted(`ir.model.create of ${r.model}: a model the registry has`);
    }
    // ir_model.py:461-466: the new models set up and their tables created
    for (const r of rows) {
      const fields = (await env.cr.query<{ name: string; ttype: string; field_description: Record<string, string>; readonly: boolean | null; size: number | null }>(
        "SELECT name, ttype, field_description, readonly, size FROM ir_model_fields WHERE model_id = $1 AND state = 'manual' ORDER BY id", [r.id])).rows;
      const table = r.model.replace(/\./g, "_");
      const label = r.name["en_US"] ?? "";
      const stored = [
        ...MAGIC.filter((m) => m.column !== null).map((m) => ({ name: m.name, column: m.column!, size: null as number | null, comment: m.label })),
        ...fields.map((f) => ({ name: f.name, column: COLUMN_TYPE[f.ttype]!, size: f.ttype === "char" ? f.size : null, comment: f.field_description["en_US"] ?? "" })),
      ].map((c, i) => ({ ...c, i })).sort((a, b) => ((ORDER_BY_TYPE[a.column] ?? 16) - (ORDER_BY_TYPE[b.column] ?? 16)) || a.i - b.i);
      await env.cr.query(`CREATE TABLE "${table}" (id SERIAL NOT NULL, ${stored.map((c) => `"${c.name}" ${c.column}${c.size ? `(${c.size})` : ""}`).join(", ")}, PRIMARY KEY(id)); `
        + `COMMENT ON TABLE "${table}" IS ${quote(label)}; `
        + stored.map((c) => `COMMENT ON COLUMN "${table}"."${c.name}" IS ${quote(c.comment)}`).join("; "));
      // _reflect_models (ir_model.py:503-523): the row Odoo expects, upserted
      await env.cr.query(`INSERT INTO "ir_model" ("model", "name", "explanation", "order", "info", "state", "abstract", "transient", "fold_name", "is_mail_thread", "is_mail_activity", "is_mail_blacklist")
        VALUES ($1, $2::jsonb, 'false', 'id', $3, 'manual', false, false, NULL, false, false, false)
        ON CONFLICT ("model") DO UPDATE SET ("model", "name", "explanation", "order", "info", "state", "abstract", "transient", "fold_name", "is_mail_thread", "is_mail_activity", "is_mail_blacklist")
          = (EXCLUDED."model", CASE WHEN "ir_model"."name" ->> 'en_US' IS DISTINCT FROM EXCLUDED."name" ->> 'en_US' THEN EXCLUDED."name"
             ELSE COALESCE("ir_model"."name", '{}'::jsonb) || EXCLUDED."name" END, EXCLUDED."explanation", EXCLUDED."order", EXCLUDED."info",
             EXCLUDED."state", EXCLUDED."abstract", EXCLUDED."transient", EXCLUDED."fold_name", EXCLUDED."is_mail_thread",
             EXCLUDED."is_mail_activity", EXCLUDED."is_mail_blacklist") RETURNING id`, [r.model, JSON.stringify({ en_US: label }), MODEL_DOC]);
      // _reflect_fields: every field, the magic ones first (`_reflect_field_params` of each, as measured)
      await upsertFields(env, [
        ...MAGIC.map((m) => fieldParams({
          model: r.model, name: m.name, model_id: r.id, label: m.label, ttype: m.ttype, state: "base",
          store: m.name !== "display_name", copied: m.name !== "display_name", readonly: true,
          ...(m.relation ? { relation: m.relation, on_delete: "set null" } : {}),
        })),
        ...fields.map((f) => fieldParams({ model: r.model, name: f.name, model_id: r.id, label: f.field_description["en_US"] ?? "", ttype: f.ttype, readonly: f.readonly === true, ...(f.ttype === "char" && f.size ? { size: f.size } : {}) })),
      ]);
      // registry.check_foreign_keys (registry.py:856-857)
      for (const fk of ["create_uid", "write_uid"]) {
        await env.cr.query(`ALTER TABLE "${table}" ADD FOREIGN KEY ("${fk}") REFERENCES "res_users"("id") ON DELETE set null`);
      }
    }
    if (rows.length) {
      const template = await templateOf(env.cr);
      registryChanged(env.cr);
      pinTemplate(env.cr.db, template);
      await reloadRegistryOf(env.cr, env.lang);
    }
    return ids;
  },
});
