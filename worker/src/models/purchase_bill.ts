/**
 * Vendor bills from purchase orders: purchase_order.py:820-893 `action_create_invoice` (without attachments),
 * :982-1003 `_prepare_invoice`, purchase_order_line.py:777-797 `_prepare_account_move_line` with purchase_stock
 * purchase_order_line.py:355-370 (the balance in the company currency), :1005-1032 `action_view_invoice`, and
 * purchase account_invoice.py:259-272 (the "created from" note). Sections, several orders on one bill, other currencies,
 * refunds (negative totals) and down payments refuse with NotPorted.
 */
import { NotPorted } from "../errors";
import { registerMethod } from "../http/methods";
import { create } from "../orm/create";
import { RecomputeQueue } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { plainNumber } from "../orm/values";
import { envFor } from "../web/common";
import { fiscalPositionFor } from "./sale_computes";
import { actionOf } from "./sps_menus";
import { postNote } from "./stock_engine";
import { roundCurrency } from "./stock_valuation";
import { withCompany } from "./tail_util";
import { translate } from "./util";
import * as priv from "../orm/dispatch_gen";

const idOf = (v: unknown): number | null => (typeof v === "number" && v > 0 ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : null);

async function rows<T extends object>(env: Environment, text: string, params: unknown[]): Promise<T[]> {
  return (await env.cr.query<T & Record<string, unknown>>(text, params)).rows;
}

/** purchase_order.py:982-1003 `_prepare_invoice`. */
async function prepareInvoice(env: Environment, order: number): Promise<Record<string, unknown>> {
  const [o] = await env.model("purchase.order").read([order], ["note", "currency_id", "partner_id", "fiscal_position_id", "name", "payment_term_id", "incoterm_id", "company_id", "document_tax_mode"], "");
  const partner = idOf(o!["partner_id"])!;
  const company = idOf(o!["company_id"])!;
  // the commercial partner's first bank account of no company or the order's (res.partner.bank _order: sequence, id)
  const [bank] = await rows<{ id: number }>(env,
    `SELECT b.id FROM res_partner_bank b WHERE b.partner_id = (SELECT commercial_partner_id FROM res_partner WHERE id = $1) AND b.active
        AND (b.company_id IS NULL OR b.company_id = $2) ORDER BY b.sequence, b.id LIMIT 1`, [partner, company]);
  const position = idOf(o!["fiscal_position_id"]) ?? (await fiscalPositionFor(env, company, partner, null)) ?? false;
  return {
    move_type: env.context["default_move_type"] ?? "in_invoice", narration: o!["note"] || false, currency_id: idOf(o!["currency_id"]), partner_id: partner,
    fiscal_position_id: position, partner_bank_id: bank?.id ?? false, invoice_origin: o!["name"], invoice_payment_term_id: idOf(o!["payment_term_id"]) ?? false,
    invoice_line_ids: [] as unknown[], invoice_incoterm_id: idOf(o!["incoterm_id"]) ?? false, company_id: company, document_tax_mode: o!["document_tax_mode"] || false,
  };
}

/**
 * `line._prepare_account_move_line()` (no move: the bill is new) through the private hook (src/orm/private_hooks.ts):
 * a site's compiled override runs around purchase's with purchase_stock's, both below it in the MRO
 * (stock_landed_costs purchase.py:7-10: the landed cost flag of the product).
 */
export async function lineValues(env: Environment, line: number): Promise<Record<string, unknown>> {
  const out = await priv.purchase_order_line._prepare_account_move_line.call(env, [line], [false], async (e, ids, args) => {
    if (ids.length !== 1 || ids[0] !== line || (args[0] !== false && args[0] !== null && args[0] !== undefined)) {
      throw new NotPorted("purchase.order.line._prepare_account_move_line called by an override with other records or a move");
    }
    return lineValuesOf(e, line);
  });
  if (out === null || typeof out !== "object" || Array.isArray(out)) throw new NotPorted(`_prepare_account_move_line returning ${JSON.stringify(out)}`);
  return out as Record<string, unknown>;
}

/** purchase_order_line.py:777-797 with purchase_stock :355-370 (no move: the bill is new). */
async function lineValuesOf(env: Environment, line: number): Promise<Record<string, unknown>> {
  const [l] = await rows<{ display_type: string | null; name: string | null; product_id: number | null; uom_id: number | null; qty_to_invoice: number; discount: number | null;
    price_unit: number; is_downpayment: boolean | null; document_tax_mode: string | null; currency_id: number; company_currency: number }>(env,
    `SELECT l.display_type, l.name, l.product_id, l.uom_id, COALESCE(l.qty_to_invoice, 0)::float8 AS qty_to_invoice, l.discount::float8 AS discount, l.price_unit::float8 AS price_unit,
            l.is_downpayment, o.document_tax_mode, o.currency_id, c.currency_id AS company_currency
       FROM purchase_order_line l JOIN purchase_order o ON o.id = l.order_id JOIN res_company c ON c.id = o.company_id WHERE l.id = $1`, [line]);
  // :779-789 `aml_currency = move and move.currency_id or self.currency_id`: a new bill (no move) is in the order's
  // currency, so `_convert` to the same currency keeps the price
  if (l!.is_downpayment) throw new NotPorted("purchase.order.line._prepare_account_move_line of a down payment");
  const taxes = (await rows<{ id: number }>(env, "SELECT account_tax_id AS id FROM account_tax_purchase_order_line_rel WHERE purchase_order_line_id = $1 ORDER BY account_tax_id", [line])).map((r) => r.id);
  const vals: Record<string, unknown> = {
    display_type: l!.display_type || "product", name: l!.name ?? false, product_id: l!.product_id ?? false, product_uom_id: l!.uom_id ?? false, quantity: l!.qty_to_invoice,
    discount: l!.discount ?? 0, price_unit: l!.price_unit, tax_ids: [[6, 0, taxes]], purchase_line_id: line, is_downpayment: l!.is_downpayment ?? false,
    document_tax_mode: l!.document_tax_mode || false,
  };
  // purchase_stock: compute_all(price_unit_discounted, quantity=qty_to_invoice, round=False, round_base=False)['total_excluded']
  if (taxes.length) {
    const kinds = await rows<{ amount_type: string; override: string | null; company_mode: string | null }>(env,
      "SELECT t.amount_type, t.price_include_override AS override, c.account_price_include AS company_mode FROM account_tax t JOIN res_company c ON c.id = t.company_id WHERE t.id = ANY($1::int[])", [taxes]);
    if (kinds.some((k) => k.amount_type === "group" || (k.override ? k.override === "tax_included" : k.company_mode === "tax_included"))) {
      throw new NotPorted("purchase_stock _prepare_account_move_line balance with price-included or grouped taxes");
    }
  }
  const raw = l!.price_unit * (1 - (l!.discount ?? 0) / 100) * l!.qty_to_invoice;
  // `self.currency_id._convert(total_wo_tax, company currency, round=False)`: env.company, context_today
  // (res_currency.py:344-354)
  if (l!.currency_id !== l!.company_currency) {
    const { convertAmount } = await import("./currency_convert");
    const { dbNow, todayInTz } = await import("./util");
    const { envTz } = await import("../orm/env");
    vals["balance"] = await convertAmount(env, raw, l!.currency_id, l!.company_currency, await env.company(), todayInTz(await dbNow(env), await envTz(env)), false);
  } else vals["balance"] = raw;
  return vals;
}

/** purchase_order.py:1005-1032 `action_view_invoice(invoices)`. */
async function viewInvoices(env: Environment, orders: readonly number[], invoices: readonly number[]): Promise<Record<string, unknown>> {
  let action: Record<string, unknown> = await actionOf(env, "account.action_move_in_invoice_type");
  if (invoices.length > 1) action["domain"] = [["id", "in", [...invoices]]];
  else if (invoices.length === 1) {
    const form = await env.reg.xmlid(env.cr, "account.view_move_form");
    action["views"] = "views" in action ? [[form, "form"], ...(action["views"] as [unknown, string][]).filter((v) => v[1] !== "form")] : [[form, "form"]];
    action["res_id"] = invoices[0];
  } else action = { type: "ir.actions.act_window_close" };
  // literal_eval(result['context']) of account.action_move_in_invoice_type
  const context: Record<string, unknown> = { default_move_type: "in_invoice" };
  if (action["type"] === "ir.actions.act_window_close") throw new NotPorted("purchase.order.action_view_invoice without invoices (context of a closing action)");
  const partners = [...new Set((await env.model("purchase.order").read([...orders], ["partner_id"], "")).map((r) => idOf(r["partner_id"])).filter((p) => p !== null))];
  if (partners.length === 1) context["default_partner_id"] = partners[0];
  action["context"] = context;
  return action;
}

registerMethod("purchase.order", "action_create_invoice", async (env0, ids0, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  if (kwargs["attachment_ids"] || args[0]) throw new NotPorted("purchase.order.action_create_invoice with attachments");
  const ids = ids0 ?? [];
  if (ids.length !== 1) throw new NotPorted("purchase.order.action_create_invoice of several orders (grouping by partner)");
  const order = ids[0]!;
  const company = (await rows<{ c: number }>(env, "SELECT company_id AS c FROM purchase_order WHERE id = $1", [order]))[0]!.c;
  const cenv = await withCompany(env, company);
  const vals = await prepareInvoice(cenv, order);
  const lines = await rows<{ id: number; display_type: string | null }>(cenv, "SELECT id, display_type FROM purchase_order_line WHERE order_id = $1 ORDER BY sequence, id", [order]);
  let sequence = 10;
  for (const line of lines) {
    if (line.display_type === "line_section" || line.display_type === "line_subsection") throw new NotPorted("purchase.order.action_create_invoice with sections");
    vals["invoice_line_ids"] = [...(vals["invoice_line_ids"] as unknown[]), [0, 0, { ...(await lineValues(cenv, line.id)), sequence }]];
    sequence += 1;
  }
  const moveEnv = (await withCompany(env, company)).withContext({ ...cenv.context, default_move_type: "in_invoice" });
  const [move] = await create(moveEnv, "account.move", [vals]);
  // the order lines follow their new invoice lines (`invoice_lines.move_id`, `invoice_lines.quantity`): qty_invoiced,
  // qty_to_invoice, invoice_ids and the order's invoice status
  const [compCur] = await rows<{ id: number }>(env, "SELECT currency_id AS id FROM res_company WHERE id = $1", [company]);
  const created = await rows<{ id: number; purchase_line_id: number | null; balance: number }>(env,
    "SELECT id, purchase_line_id, balance::float8 AS balance FROM account_move_line WHERE move_id = $1 AND display_type = 'product' ORDER BY id", [move]);
  for (const c of (vals["invoice_line_ids"] as [number, number, Record<string, unknown>][])) {
    const dt = c[2]["display_type"];
    if (dt && dt !== "product") continue;
    const line = created.find((l) => l.purchase_line_id === c[2]["purchase_line_id"]);
    // the given balance is a Monetary of the company currency (rounded in that currency when cached)
    const expected = await roundCurrency(env, Number(plainNumber(c[2]["balance"]) ?? 0), compCur?.id ?? null);
    if (!line || Math.abs(line.balance - expected) > 1e-9) throw new NotPorted("purchase bill line whose given balance differs from the synced one");
  }
  const queue = new RecomputeQueue(env.sudo());
  await queue.modified("purchase.order.line", [...new Set(created.map((l) => l.purchase_line_id).filter((x): x is number => x !== null))], ["invoice_lines"]);
  await queue.run();
  // purchase account_invoice.py:259-272: the note on the new bill
  // `purchase._get_html_link()` (models.py `_get_html_link`): the order's display_name, with its vendor reference
  // (purchase_order.py:270-278); before round 11 the plain name. The sanitized body keeps text escaped as &, <, >.
  const title = (await moveEnv.model("purchase.order").displayName([order])).get(order) ?? "";
  const esc = (v: string): string => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // `_("This vendor bill has been created from: ")` of purchase's frame, in the language of the bill's environment
  const intro = esc(translate(moveEnv, "This vendor bill has been created from: ", "purchase"));
  await postNote(moveEnv, "account.move", move!, `<p>${intro}<a href="#" data-oe-model="purchase.order" data-oe-id="${order}">${esc(title)}</a></p>`);
  // :876 refunds when the total is negative
  const [total] = await rows<{ t: number; d: number }>(env, "SELECT m.amount_total::float8 AS t, c.decimal_places AS d FROM account_move m JOIN res_currency c ON c.id = m.currency_id WHERE m.id = $1", [move]);
  if (Math.round(total!.t * 10 ** total!.d) < 0) throw new NotPorted("purchase.order.action_create_invoice of a negative bill (action_switch_move_type)");
  return viewInvoices(env, ids, [move!]);
}, { apiModel: false });
