/**
 * The defaults of a site's new fields on rows the hand port inserts directly (models/account_entries.ts insertRow):
 * Odoo's `create` gives every field its default (models.py `_add_missing_default_values`), and a field a site module
 * adds to a model the hand port writes row by row (l10n_cn's account.move.line `l10n_cn_output_vat_offset_account_id`,
 * `default=lambda self: self.env.company.l10n_cn_output_vat_offset_account_id`) would otherwise stay NULL. The default
 * is the port's own (a compiled `default=` of the site's build, or gen/write_defaults.py's patterns), in the inserting
 * environment, as `convert_to_write` gives it; a field the hand port's values already hold keeps them. Only scalar
 * columns: another default of such a field refuses.
 */
import { NotPorted } from "../errors";
import { siteOnlyFields } from "./genmeta";
import { fieldDefault } from "./recompute";
import { generatedDefault } from "./defaults_gen";
import type { Environment } from "./types";

const SCALAR = new Set(["many2one", "char", "text", "selection", "integer", "float", "monetary", "boolean", "date", "datetime"]);

export async function withSiteDefaults(env: Environment, table: string, vals: Record<string, unknown>): Promise<Record<string, unknown>> {
  const def = [...env.reg.models.values()].find((d) => d.table === table && !d.abstract);
  if (!def) return vals;
  const names = await siteOnlyFields(env, def.name);
  if (!names.length) return vals;
  let out = vals;
  for (const name of names) {
    if (name in vals) continue;
    const field = def.fields.get(name);
    if (!field || !field.store || !field.column) continue;
    const fn = fieldDefault(def.name, name);
    const raw = fn ? await fn(env) : await generatedDefault(env, def.name, name);
    if (raw === undefined || raw === null || raw === false) continue;
    if (!SCALAR.has(field.type) || field.translate || field.companyDependent) throw new NotPorted(`the default of ${def.name}.${name} on a row the port inserts (a ${field.type} field)`);
    const { toWriteFormat } = await import("../web/defaults");
    const v = await toWriteFormat(env, def.name, field, raw);
    if (v === false && field.type !== "boolean") continue;
    if (field.type === "many2one" && typeof v !== "number") throw new NotPorted(`the default of ${def.name}.${name}: a ${typeof v} for a many2one`);
    out = { ...out, [name]: v };
  }
  return out;
}
