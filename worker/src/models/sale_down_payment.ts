/**
 * Down payments of a sale order (ACCEPTANCE A5, fix A3-2): the wizard's percentage and fixed methods
 * (sale/wizard/sale_make_invoice_advance.py:166-277 `_create_invoices`), the order's down payment section and lines
 * (sale_order.py:2541-2607), their invoice, and what posting, resetting and cancelling the invoice changes on the
 * order's lines (sale account_move.py:113-161). The amounts come from the tax engine's down payment helpers
 * (account_tax.py:3894-3931 `_prepare_down_payment_lines`, the account_tax.js mirror in account_tax_engine.js).
 *
 * Refused (NotPorted, before anything is written): several orders, taxes that cannot be discounted (fixed or code
 * taxes, which the engine dispatches into new base lines), a company down payment account. The analytic distribution
 * of the reduced lines, which the JavaScript mirror does not have, is ported here.
 */
import { NotPorted } from "../errors";
import { computeAuthor, insertMessages, replyToDefault, trackingMessageId, xmlid } from "../mail/message";
import { flatThreadParent } from "../mail/thread_generic";
import { create } from "../orm/create";
import { DbRec } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { pyFloat } from "../orm/values";
import { write } from "../orm/write";
import { accountTaxHelpers, type BaseLine } from "./account_tax_engine";
import { companyData, saleLineBase } from "./account_taxes";
import { langNumber } from "../mail/tracking";
import { withCompany } from "./tail_util";
import { translate } from "./util";

const idOf = (v: unknown): number | null => (typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : null);

/** The stored form of an exported `extra_tax_data` (Python floats keep their ".0" in the jsonb; currency_id is an id). */
export function pyExtraTaxData(data: Readonly<Record<string, unknown>> | null): Record<string, unknown> | null {
  if (data === null) return null;
  const conv = (k: string, v: unknown): unknown => {
    if (typeof v === "number") return k === "currency_id" ? v : pyFloat(v);
    if (v && typeof v === "object" && !Array.isArray(v)) return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k2, v2]) => [k2, conv(k2, v2)]));
    return v;
  };
  return conv("", data) as Record<string, unknown>;
}

interface RawBaseLine {
  price_unit: number;
  tax_ids: { id: number }[];
  analytic_distribution: unknown;
  tax_details: { taxes_data: { tax: { id: number; amount_type: string } }[] };
}
const raw = (b: BaseLine): RawBaseLine => b as unknown as RawBaseLine;

/** sale_order.py:2789-2795 `_get_lang`. */
export async function orderLang(env: Environment, order: number): Promise<string> {
  const r = (await env.cr.query<{ lang: string | null; public: boolean }>(
    `SELECT p.lang, EXISTS (SELECT 1 FROM res_users u JOIN res_groups_users_rel g ON g.uid = u.id JOIN ir_model_data d ON d.res_id = g.gid AND d.model = 'res.groups'
                              AND d.module = 'base' AND d.name = 'group_public' WHERE u.partner_id = p.id) AS public
       FROM sale_order o JOIN res_partner p ON p.id = o.partner_id WHERE o.id = $1`, [order])).rows[0];
  return r?.lang && !r.public ? r.lang : env.lang ?? "en_US";
}

/** sale_order_line.py:617-650 `_get_downpayment_description` of a draft down payment line (or the section). */
async function draftDescription(env: Environment, lang: string, section: boolean, createDay: string): Promise<string> {
  const lenv = env.withContext({ ...env.context, lang });
  if (section) return translate(lenv, "Down Payments", "sale");
  const { formatDate } = await import("./invoicing_computes");
  return translate(lenv, "Down Payment: %(date)s (Draft)", "sale").replace("%(date)s", await formatDate(lenv, createDay));
}

/**
 * sale_make_invoice_advance.py:166-231 `_create_invoices` for the percentage and fixed methods: the down payment
 * lines of the order and their invoice. Returns the invoice.
 */
export async function createDownPaymentInvoice(env0: Environment, wizard: number, orders: readonly number[], method: string, amount: number): Promise<number> {
  if (orders.length !== 1) throw new NotPorted("a down payment invoice of several orders (ensure_one)");
  const order = orders[0]!;
  const wrow = (await env0.cr.query<{ company_id: number | null }>("SELECT company_id FROM sale_advance_payment_inv WHERE id = $1", [wizard])).rows[0];
  const orow = (await env0.cr.query<{ company_id: number; fiscal_position_id: number | null; locked: boolean | null }>(
    "SELECT company_id, fiscal_position_id, locked FROM sale_order WHERE id = $1", [order])).rows[0]!;
  const company = wrow?.company_id ?? orow.company_id;
  const env = await withCompany(env0, company);
  const dpAccount = (await env.cr.query<{ a: number | null }>("SELECT downpayment_account_id AS a FROM res_company WHERE id = $1", [company])).rows[0]?.a ?? null;
  if (dpAccount !== null) throw new NotPorted("a down payment with the company's down payment account (fiscal position mapping)");
  // :176-184 the base lines of the priced lines, at their ordered quantity (else the delivered one)
  const lineDef = env.reg.model("sale.order.line");
  const lines = (await env.cr.query<{ id: number; qty: number | null; delivered: number | null; analytic: unknown; product_id: number | null }>(
    `SELECT id, product_uom_qty::float8 AS qty, qty_delivered::float8 AS delivered, analytic_distribution AS analytic, product_id
       FROM sale_order_line WHERE order_id = $1 AND display_type IS NULL ORDER BY sequence, id`, [order])).rows;
  const bases: BaseLine[] = [];
  for (const l of lines) {
    const { base } = await saleLineBase(env, new DbRec(env, lineDef, l.id), l.qty || l.delivered || 0);
    if (raw(base).tax_ids.some((t) => (t as { amount_type?: string }).amount_type === "fixed" || (t as { amount_type?: string }).amount_type === "code")) {
      throw new NotPorted("a down payment with fixed or code taxes (dispatched into new base lines)");
    }
    bases.push(base);
  }
  const companyTax = await companyData(env, orow.company_id);
  accountTaxHelpers.add_tax_details_in_base_lines(bases, companyTax);
  accountTaxHelpers.round_base_lines_tax_details(bases, companyTax);
  const dp = accountTaxHelpers.prepare_down_payment_lines(bases, companyTax, method === "percentage" ? "percent" : "fixed", amount, { computation_key: `down_payment,${wizard}` });
  // the product of each reduced line is the first line's of its taxes (`_reduce_base_lines_with_grouping_function`)
  const key = (b: BaseLine): string => [...new Set(raw(b).tax_ids.map((t) => t.id))].sort((a, c) => a - c).join(",");
  const productOf = new Map<string, number | null>();
  for (const [i, b] of bases.entries()) if (!productOf.has(key(b))) productOf.set(key(b), lines[i]!.product_id);
  // account_tax.py:3482-3484 and :3517-3538 (not in the JavaScript mirror): the analytic distribution of each reduced
  // line, the lines' distributions weighted by their untaxed amounts (100 % of an account when they sum to zero)
  const analytic = new Map<string, { total: number; accounts: Map<string, number> }>();
  for (const [i, b] of bases.entries()) {
    const g = analytic.get(key(b)) ?? { total: 0, accounts: new Map<string, number>() };
    const amount = (b as unknown as { tax_details: { raw_total_excluded_currency: number } }).tax_details.raw_total_excluded_currency;
    g.total += amount;
    const dist = lines[i]!.analytic && typeof lines[i]!.analytic === "object" ? lines[i]!.analytic as Record<string, number> : {};
    for (const [account, share] of Object.entries(dist)) g.accounts.set(account, (g.accounts.get(account) ?? 0) + Number(share) * amount / 100.0);
    analytic.set(key(b), g);
  }
  const analyticOf = (b: BaseLine): Record<string, unknown> | false => {
    const g = analytic.get(key(b));
    if (!g || !g.accounts.size) return false;
    return Object.fromEntries([...g.accounts].map(([account, amount]) => [account, pyFloat(g.total ? amount * 100 / g.total : 100.0)]));
  };

  // :201-203 the section, then the lines (sale_order.py:2541-2607), without their creation message
  const lenv = env.withContext({ ...env.context, sale_no_log_for_new_lines: true });
  const lang = await orderLang(env, order);
  const today = (await env.cr.query<{ d: string }>("SELECT (now() AT TIME ZONE 'UTC')::date::text AS d")).rows[0]!.d;
  const maxSeq = async (): Promise<number> => (await env.cr.query<{ s: number | null }>("SELECT max(sequence) AS s FROM sale_order_line WHERE order_id = $1", [order])).rows[0]?.s ?? 10;
  const hasSection = (await env.cr.query("SELECT 1 FROM sale_order_line WHERE order_id = $1 AND display_type IS NOT NULL AND is_downpayment LIMIT 1", [order])).rows.length > 0;
  if (!hasSection) {
    // `_compute_name` of the section: `_get_downpayment_description` (:619-620)
    await create(lenv, "sale.order.line", [{ order_id: order, display_type: "line_section", is_downpayment: true, sequence: (await maxSeq()) + 1, name: await draftDescription(env, lang, true, today) }]);
  }
  const sequence = (await maxSeq()) + 1;
  const soLines = await create(lenv, "sale.order.line", await Promise.all(dp.map(async (b, index) => ({
    order_id: order, is_downpayment: true, product_uom_qty: 0.0, price_unit: raw(b).price_unit, tax_ids: [[6, 0, raw(b).tax_ids.map((t) => t.id)]],
    analytic_distribution: analyticOf(b), extra_tax_data: pyExtraTaxData(accountTaxHelpers.export_base_line_extra_tax_data(b)), sequence: sequence + index,
    name: await draftDescription(env, lang, false, today),
  }))));

  // :233-277 the invoice: the order's values and one line per down payment line, on its first product's income account
  const { invoiceValuesOf } = await import("./sale_invoice");
  const values = await invoiceValuesOf(env, order);
  const name = method === "percentage"
    ? translate(env.withContext({ ...env.context, lang }), "Down payment of %s%%", "sale").replace("%s", await langNumber(env, lang, amount, 2)).replace("%%", "%")
    : translate(env.withContext({ ...env.context, lang }), "Down Payment", "sale");
  const { productAccountOf } = await import("./account_move_create");
  const invoiceLines: unknown[] = [];
  for (const [i, b] of dp.entries()) {
    const product = productOf.get(key(b)) ?? null;
    let account: number | null = null;
    if (product !== null) {
      account = await productAccountOf(env, new DbRec(env, env.reg.model("product.product"), product), company, "income");
      if (account !== null && orow.fiscal_position_id !== null) {
        const mapped = (await env.cr.query<{ d: number }>("SELECT account_dest_id AS d FROM account_fiscal_position_account WHERE position_id = $1 AND account_src_id = $2 LIMIT 1", [orow.fiscal_position_id, account])).rows[0]?.d;
        if (mapped) account = mapped;
      }
    }
    invoiceLines.push([0, 0, await downPaymentInvoiceLine(env, soLines[i]!, { name, quantity: 1.0, ...(account !== null ? { account_id: account } : {}) })]);
  }
  values["invoice_line_ids"] = invoiceLines;
  const sudo = env.sudo().withContext({ ...env.context, default_move_type: "out_invoice" });
  const [invoice] = await create(sudo, "account.move", [values]);
  const { refreshInvoiced } = await import("./sale_invoice");
  await refreshInvoiced(env, [order]);

  // :216-229 the origin link on the invoice and the note on the order
  const { originLinkBody } = await import("./stock_engine");
  const rendered = await originLinkBody(env, "account.move", { model: "sale.order", id: order });
  const [author, emailFrom] = await computeAuthor(env, null, null);
  const note = await xmlid(env, "mail.mt_note");
  await insertMessages(env, [{
    model: "account.move", res_id: invoice!, body: rendered, author_id: author, email_from: emailFrom, message_type: "notification", subject: false,
    subtype_id: note, email_add_signature: true, record_company_id: company,
    parent_id: await flatThreadParent(env, "account.move", invoice!), message_id: trackingMessageId("message-notify"), reply_to: await replyToDefault(env, emailFrom),
  }]);
  const { assertNoRecipients } = await import("../mail/post");
  await assertNoRecipients(env, "sale.order", order, note, []);
  // `self.env._("%s has been created", invoice._get_html_link(title=_("Down payment invoice")))`, a Markup in a span
  const title = translate(env, "Down payment invoice", "sale");
  const link = `<a href="#" data-oe-model="account.move" data-oe-id="${invoice}">${title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</a>`;
  await insertMessages(env, [{
    model: "sale.order", res_id: order, body: `<span>${translate(env, "%s has been created", "sale").replace("%s", link)}</span>`, author_id: author, email_from: emailFrom,
    message_type: "notification", subject: false, subtype_id: note, email_add_signature: true, record_company_id: orow.company_id,
    parent_id: await flatThreadParent(env, "sale.order", order), message_id: trackingMessageId("message-notify"), reply_to: await replyToDefault(env, emailFrom),
  }]);
  return invoice!;
}

/** sale_order_line.py:2032-2081 `_prepare_invoice_line` of a down payment line. */
export async function downPaymentInvoiceLine(env: Environment, id: number, optional: Record<string, unknown>): Promise<Record<string, unknown>> {
  const line = new DbRec(env.sudo(), env.reg.model("sale.order.line"), id);
  const r = (await env.cr.query<{ name: string | null; sequence: number; display_type: string | null; price_unit: number | null; discount: number | null; extra: unknown; cp: boolean | null; cc: boolean | null; uom: number | null; product: number | null }>(
    `SELECT name, sequence, display_type, price_unit::float8 AS price_unit, discount::float8 AS discount, extra_tax_data AS extra, collapse_prices AS cp, collapse_composition AS cc,
            product_uom_id AS uom, product_id AS product FROM sale_order_line WHERE id = $1`, [id])).rows[0]!;
  const taxes = ((await line.get("tax_ids")) as unknown[]).map(idOf);
  const res: Record<string, unknown> = {
    display_type: r.display_type || "product", sequence: r.sequence, name: r.name ?? false, product_id: r.product ?? false, product_uom_id: r.uom ?? false,
    quantity: Number((await line.get("qty_to_invoice")) ?? 0), discount: r.discount ?? 0, price_unit: r.price_unit ?? 0, tax_ids: [[6, 0, taxes]],
    sale_line_ids: [[4, id]], is_downpayment: true, extra_tax_data: pyExtraTaxData(r.extra && typeof r.extra === "object" ? r.extra as Record<string, unknown> : null),
    collapse_prices: r.cp || false, collapse_composition: r.cc || false,
  };
  // the invoice line computes its sale line's distribution (sale account_move_line.py:45-49 `_related_analytic_distribution`,
  // src/models/account_move_create.ts `createInvoiceLine`): not given here
  // :2074-2076 a line invoiced before keeps the account of its down payment invoice lines
  const dpAccount = (await env.cr.query<{ a: number | null }>(
    `SELECT l.account_id AS a FROM sale_order_line_invoice_rel x JOIN account_move_line l ON l.id = x.invoice_line_id
      WHERE x.order_line_id = $1 AND l.is_downpayment ORDER BY l.id LIMIT 1`, [id])).rows[0];
  if (dpAccount) res["account_id"] = dpAccount.a ?? false;
  Object.assign(res, optional);
  if (r.display_type) res["account_id"] = false;
  return res;
}

/**
 * sale account_move.py:113-131 `action_post` (also :136-139 `button_draft`, :141-161 `button_cancel`): the down
 * payment lines of the invoices' sale lines get their description again (`_compute_name`), and on orders not
 * locked their unit price from their posted invoices other than the order's regular ones and, after posting, the
 * invoice lines' taxes.
 */
export async function downPaymentAfterState(env: Environment, invoices: readonly number[], kind: "post" | "draft" | "cancel"): Promise<void> {
  if (!env.reg.models.has("sale.order.line")) return;
  const dp = (await env.cr.query<{ id: number; order_id: number; locked: boolean | null }>(
    `SELECT DISTINCT s.id, s.order_id, o.locked FROM account_move_line l JOIN sale_order_line_invoice_rel x ON x.invoice_line_id = l.id
       JOIN sale_order_line s ON s.id = x.order_line_id JOIN sale_order o ON o.id = s.order_id
      WHERE l.move_id = ANY($1::int[]) AND s.is_downpayment AND s.display_type IS NULL ${kind === "draft" ? "AND l.is_downpayment" : ""} ORDER BY s.id`, [[...invoices]])).rows;
  if (!dp.length) return;
  for (const l of dp) {
    const name = await downPaymentName(env, l.id, l.order_id);
    await write(env.sudo(), "sale.order.line", [l.id], { name });
  }
  if (kind === "draft") return;
  const open = dp.filter((l) => !l.locked);
  if (!open.length) return;
  // `real_invoices`: the invoices of the orders' other lines
  const orders = [...new Set(open.map((l) => l.order_id))];
  const real = new Set((await env.cr.query<{ m: number }>(
    `SELECT DISTINCT l.move_id AS m FROM sale_order_line s JOIN sale_order_line_invoice_rel x ON x.order_line_id = s.id JOIN account_move_line l ON l.id = x.invoice_line_id
      WHERE s.order_id = ANY($1::int[]) AND s.id != ALL($2::int[])`, [orders, open.map((l) => l.id)])).rows.map((r) => r.m));
  for (const l of open) {
    // sale_order_line.py:2103-2109 `_get_downpayment_line_price_unit`
    const inv = (await env.cr.query<{ price: number; type: string; state: string; move: number }>(
      `SELECT l.price_unit::float8 AS price, m.move_type AS type, m.state, m.id AS move FROM sale_order_line_invoice_rel x JOIN account_move_line l ON l.id = x.invoice_line_id
         JOIN account_move m ON m.id = l.move_id WHERE x.order_line_id = $1 ORDER BY l.id`, [l.id])).rows;
    let price = 0;
    for (const r of inv) if (r.state === "posted" && !real.has(r.move)) price += r.type === "out_invoice" ? r.price : -r.price;
    const vals: Record<string, unknown> = { price_unit: price };
    if (kind === "post") {
      const taxes = (await env.cr.query<{ t: number }>(
        `SELECT DISTINCT r.account_tax_id AS t FROM sale_order_line_invoice_rel x JOIN account_move_line_account_tax_rel r ON r.account_move_line_id = x.invoice_line_id
          WHERE x.order_line_id = $1 ORDER BY 1`, [l.id])).rows.map((r) => r.t);
      vals["tax_ids"] = [[6, 0, taxes]];
    }
    await write(env.sudo(), "sale.order.line", [l.id], vals);
  }
}

/** sale_order_line.py:617-650 `_get_downpayment_description` with :652-672 `_get_downpayment_state`, in the order's language. */
async function downPaymentName(env: Environment, line: number, order: number): Promise<string> {
  const lang = await orderLang(env, order);
  const lenv = env.withContext({ ...env.context, lang });
  const moves = (await env.cr.query<{ id: number; state: string; move_type: string; payment_state: string | null; payment_reference: string | null; invoice_date: string | null; quantity: number }>(
    `SELECT m.id, m.state, m.move_type, m.payment_state, m.payment_reference, m.invoice_date::text AS invoice_date, l.quantity::float8 AS quantity
       FROM sale_order_line_invoice_rel x JOIN account_move_line l ON l.id = x.invoice_line_id JOIN account_move m ON m.id = l.move_id
      WHERE x.order_line_id = $1 ORDER BY l.id`, [line])).rows;
  // :1190-1202 `_get_downpayment_state` over `_get_invoice_lines()` (all of them without an accrual date)
  if (env.context["accrual_entry_date"]) throw new NotPorted("a down payment description at an accrual date");
  const states = (await env.cr.query<{ s: string | null }>(
    "SELECT l.parent_state AS s FROM sale_order_line_invoice_rel x JOIN account_move_line l ON l.id = x.invoice_line_id WHERE x.order_line_id = $1", [line])).rows.map((r) => r.s);
  const state = states.every((x) => x === "draft") ? "draft" : states.every((x) => x === "cancel") ? "cancel" : "";
  const { formatDate } = await import("./invoicing_computes");
  if (state === "draft") {
    const created = (await env.cr.query<{ d: string }>("SELECT create_date::date::text AS d FROM sale_order_line WHERE id = $1", [line])).rows[0]!.d;
    return translate(lenv, "Down Payment: %(date)s (Draft)", "sale").replace("%(date)s", await formatDate(lenv, created));
  }
  if (state === "cancel") return translate(lenv, "Down Payment (Cancelled)", "sale");
  const invoices = [...new Map(moves.filter((m) => m.quantity >= 0 && m.move_type === "out_invoice").map((m) => [m.id, m])).values()];
  const active = invoices.filter((m) => m.payment_state !== "reversed");
  const chosen = active.length ? active : invoices;
  if (chosen.length === 1 && chosen[0]!.payment_reference && chosen[0]!.invoice_date) {
    return translate(lenv, "Down Payment (ref: %(reference)s on %(date)s)", "sale")
      .replace("%(reference)s", chosen[0]!.payment_reference).replace("%(date)s", await formatDate(lenv, chosen[0]!.invoice_date));
  }
  return translate(lenv, "Down Payment", "sale");
}
