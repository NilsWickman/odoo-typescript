/**
 * `utm.mixin.utm_reference` selection (odoo/addons/utm/models/utm_mixin.py:19-27 `_selection_target_model`):
 * `ir.model.sudo().search_fetch([('transient', '=', False)], ['model', 'name'])` in ir.model's `_order`
 * (mail/models/ir_model.py: `is_mail_thread DESC, name ASC`, name translated in env.lang), keeping models in
 * the registry. Registered on the poc_erp models inheriting utm.mixin (gen/out/poc_erp/models.json).
 */
import { registerHooks } from "../orm/hooks";
import type { Environment } from "../orm/types";

async function selectionTargetModel(env: Environment): Promise<readonly [string, string][]> {
  const lang = env.lang ?? "en_US";
  const rows = await env.cr.query<{ model: string; name: string }>(
    `SELECT model, COALESCE(name->>$1, name->>'en_US') AS name FROM ir_model WHERE transient IS NOT TRUE
     ORDER BY is_mail_thread DESC, COALESCE(name->>$1, name->>'en_US') ASC`, [lang]);
  return rows.rows.filter((r) => env.reg.models.has(r.model)).map((r) => [r.model, r.name] as [string, string]);
}

for (const model of ["account.bank.statement.line", "account.move", "crm.lead", "sale.order", "sale.report", "utm.mixin"]) {
  registerHooks(model, { selection: { utm_reference: selectionTargetModel } });
}
