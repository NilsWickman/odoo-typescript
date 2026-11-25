/**
 * `ir.exports` (`odoo/odoo/addons/base/models/ir_exports.py`): the saved export templates the export dialog lists
 * with `search_read([('resource', '=', model)], [])`, and `_get_property_fields` (:22-77) used by
 * `/web/export/get_fields`.
 */
import { NotPorted } from "../errors";
import type { Environment, RecordValues } from "../orm/types";
import { registerSearchRead } from "./res_lang";

registerSearchRead("ir.exports");

/**
 * ir_exports.py:22-77 `_get_property_fields(fields, model, domain)`: one entry per property definition of the
 * definition records reachable from `domain`. Only the case where no definition record has a non-empty definition
 * is ported (then the answer is `{}` whatever the domain restricts); otherwise the property labels need
 * `display_name` of the definition records and the domain subselect, which refuse.
 */
export async function getPropertyFields(env: Environment, fields: Readonly<Record<string, RecordValues>>, model: string, _domain: unknown): Promise<Record<string, RecordValues>> {
  const def = env.reg.model(model);
  for (const [fname, field] of Object.entries(fields)) {
    if (field["type"] !== "properties") continue;
    const definitionRecord = def.fields.get(fname)?.definitionRecord ?? null;
    const definitionRecordField = def.fields.get(fname)?.definitionRecordField ?? null;
    if (definitionRecord === null || definitionRecordField === null) throw new NotPorted(`properties field ${model}.${fname} without definition record`);
    const comodel = def.fields.get(definitionRecord)?.relation ?? null;
    if (comodel === null) throw new NotPorted(`properties definition record ${model}.${definitionRecord}`);
    const target = env.reg.model(comodel);
    const column = target.fields.get(definitionRecordField);
    if (!column || !column.column) throw new NotPorted(`properties definition ${comodel}.${definitionRecordField} is not a column`);
    // sudo(): search_fetch([(definition_record_field, '!=', False)]) on the definition model; a definition list
    // containing anything but separators would produce fields
    const r = await env.cr.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "${target.table}" t, jsonb_array_elements(CASE WHEN jsonb_typeof(t."${definitionRecordField}") = 'array'
         THEN t."${definitionRecordField}" ELSE '[]'::jsonb END) AS d WHERE d->>'type' IS DISTINCT FROM 'separator'`,
    );
    if ((r.rows[0]?.n ?? 0) > 0) throw new NotPorted(`export of properties of ${model}.${fname} (non-empty definitions)`);
  }
  return {};
}
