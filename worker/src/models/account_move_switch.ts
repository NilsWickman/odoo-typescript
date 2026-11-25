/**
 * account_move.py:6684-6708 `action_switch_move_type`: a draft customer invoice becomes a credit note (and back), the
 * quantities negated when the total is negative. Called by sale's `_create_invoices` for a final invoice whose total
 * is negative (sale_order.py:2166-2170).
 */
import { NotPorted, ValidationError } from "../errors";
import type { Environment } from "../orm/types";
import { write } from "../orm/write";
import { syncInvoice } from "./account_move_create";
import { touchSyncedInvoices, updateRow } from "./account_entries";
import { movePartnerBank } from "./account_move_ops";
import { translate } from "./util";

export async function switchMoveType(env: Environment, ids: readonly number[]): Promise<void> {
  const rows = (await env.cr.query<{ id: number; move_type: string; state: string; name: string | null; company_id: number; cp: number | null; user: number | null; partner: number | null }>(
    `SELECT id, move_type, state, name, company_id, commercial_partner_id AS cp, invoice_user_id AS user, partner_id AS partner
       FROM account_move WHERE id = ANY($1::int[]) ORDER BY id`, [ids])).rows;
  if (rows.some((r) => r.move_type === "entry")) throw new ValidationError(translate(env, "This action isn't available for this document.", "account"));
  if (rows.some((r) => r.state !== "draft")) throw new ValidationError(translate(env, "You can only switch the type of a draft document.", "account"));
  for (const id of ids) {
    const r = rows.find((x) => x.id === id)!;
    const [inOut, old] = r.move_type.split("_") as [string, string];
    const newType = `${inOut}_${old === "refund" ? "invoice" : "refund"}`;
    if (inOut !== "out") throw new NotPorted("action_switch_move_type of a vendor bill or refund (_compute_date, _compute_journal_id of a purchase document)");
    // :6693 `move.name = False`: a draft never posted has no name yet (`_inverse_name` then does nothing)
    if (r.name && r.name !== "/") throw new NotPorted("action_switch_move_type of a move with a name");
    // :6694-6698 the write of move_type recomputes the stored fields depending on it; for a customer invoice and its
    // credit note (both sale documents) these stay as they were, except the ones below
    const company = (await env.cr.query<{ storno: boolean | null; incoterm: number | null }>(
      "SELECT account_storno AS storno, incoterm_id AS incoterm FROM res_company WHERE id = $1", [r.company_id])).rows[0]!;
    // :985-988 `_compute_is_storno` of a refund
    if (company.storno) throw new NotPorted("action_switch_move_type in a company with storno accounting");
    // :2066-2079 `_compute_narration` replaces the invoice terms of a sale document when they are used
    const terms = (await env.cr.query<{ v: string | null }>("SELECT value AS v FROM ir_config_parameter WHERE key = 'account.use_invoice_terms'")).rows[0]?.v;
    if (terms && terms !== "False" && terms !== "0") throw new NotPorted("action_switch_move_type with invoice terms (_compute_narration)");
    // :850-864 `_compute_invoice_default_sale_person` keeps a salesperson already set
    if (r.partner && !r.user) throw new NotPorted("action_switch_move_type of an invoice without salesperson (_compute_invoice_default_sale_person)");
    await touchSyncedInvoices(env, [id]);
    await updateRow(env, "account_move", id, {
      move_type: newType, is_manually_modified: true,
      // :2333-2338 `_compute_incoterm`: the company's for a customer document
      invoice_incoterm_id: company.incoterm,
      // :1095-1110 `_compute_partner_bank_id` through `bank_partner_id` (:2010-2016): the customer's account for an
      // outbound document, the company's for an inbound one
      partner_bank_id: await movePartnerBank(env, newType, r.company_id, r.cp),
      // :1265-1300 `_compute_payment_state` of a draft
      payment_state: "not_paid",
    });
    // :4083 `_sync_dynamic_lines`: the lines' balances, tax lines (refund repartition) and terms of the new type
    await syncInvoice(env, id, { resync: true });
    const total = (await env.cr.query<{ t: number }>("SELECT amount_total::float8 AS t FROM account_move WHERE id = $1", [id])).rows[0]!.t;
    if (total < 0) {
      // :6699-6708 the product lines' quantities negated, with their extra tax data
      const { accountTaxHelpers } = await import("./account_tax_engine");
      const { pyExtraTaxData } = await import("./sale_down_payment");
      const lines = (await env.cr.query<{ id: number; q: number; x: Record<string, unknown> | null }>(
        "SELECT id, quantity::float8 AS q, extra_tax_data AS x FROM account_move_line WHERE move_id = $1 AND display_type = 'product' ORDER BY id", [id])).rows;
      const commands = lines.map((l) => [1, l.id, { quantity: -l.q, extra_tax_data: pyExtraTaxData(accountTaxHelpers.reverse_quantity_base_line_extra_tax_data(l.x)) }]);
      // Odoo writes them as `line_ids` commands; the product lines are the invoice lines
      if (commands.length) await write(env, "account.move", [id], { invoice_line_ids: commands });
    }
  }
}
