/**
 * The invoice of a confirmed order: sale.advance.payment.inv.create_invoices (sale/wizard/sale_make_invoice_advance.py:135-164),
 * sale_order.py:2031-2195 `_create_invoices` for one order at a time, and the stored quantities and statuses the new invoice
 * lines move. Down payment invoices are src/models/sale_down_payment.ts; a final invoice deducts the down payment lines
 * (quantity -1, their reversed extra tax data). Payment transactions refuse with NotPorted.
 */
import { originLinkBody } from "./stock_engine";
import { NotPorted, UserError } from "../errors";
import { registerMethod } from "../http/methods";
import { computeAuthor, insertMessages, replyToDefault, trackingMessageId, xmlid } from "../mail/message";
import { flatThreadParent } from "../mail/thread_generic";
import { create } from "../orm/create";
import { DbRec, recordCompute } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { envFor } from "../web/common";
import { updateRow } from "./account_entries";
import { actionOf } from "./sps_menus";
import { withCompany } from "./tail_util";
import { contextDay, translate } from "./util";
import * as priv from "../orm/dispatch_gen";

const idOf = (v: unknown): number | null => (typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : null);
const LINE = "sale.order.line", ORDER = "sale.order";

async function productUnitDigits(env: Environment): Promise<number> {
  return (await env.cr.query<{ digits: number }>("SELECT digits FROM decimal_precision WHERE name = 'Product Unit'")).rows[0]?.digits ?? 2;
}

/** sale_order.py:1963-2013 `_get_invoiceable_lines`. */
async function invoiceableLines(env: Environment, order: number, final: boolean): Promise<number[]> {
  const ids = await env.sudo().model(LINE).search({ kind: "cond", path: "order_id", op: "=", value: order });
  const digits = await productUnitDigits(env);
  const out: number[] = [], down: number[] = [];
  let section: number[] = [], subsection: number[] = [];
  for (const id of ids) {
    const line = new DbRec(env.sudo(), env.reg.model(LINE), id);
    const type = await line.get("display_type");
    if (type === "line_section") { section = [id]; subsection = []; continue; }
    if (type === "line_subsection") { subsection = [id]; continue; }
    const qty = Number((await line.get("qty_to_invoice")) ?? 0);
    const zero = Math.abs(qty) < 0.5 * 10 ** -digits;
    if (type !== "line_note" && zero) continue;
    if (!(qty > 0 || (qty < 0 && final) || type === "line_note")) continue;
    if (await line.get("is_downpayment")) { down.push(id); continue; }
    if (subsection.length) {
      if (type) { subsection.push(id); continue; }
      out.push(...section, ...subsection);
      subsection = []; section = [];
    } else if (section.length) {
      if (type) { section.push(id); continue; }
      out.push(...section);
      section = []; subsection = [];
    }
    out.push(id);
  }
  return [...out, ...down];
}

/** sale_order_line.py:2032-2081 `_prepare_invoice_line` with sale_project sale_order_line.py:449-469. */
async function invoiceLineValues(env: Environment, id: number, sequence: number): Promise<Record<string, unknown>> {
  const line = new DbRec(env.sudo(), env.reg.model(LINE), id);
  const product = await line.rel("product_id");
  if (product && (await product.get("type")) === "combo") throw new NotPorted("invoice of a combo line");
  if (await line.get("is_downpayment")) throw new NotPorted("invoice of a down payment line");
  const type = await line.get("display_type");
  const res: Record<string, unknown> = {
    display_type: type || "product", sequence, name: (await env.cr.query<{ n: string | null }>("SELECT name AS n FROM sale_order_line WHERE id = $1", [id])).rows[0]?.n ?? false, product_id: idOf(await line.get("product_id")) ?? false,
    product_uom_id: idOf(await line.get("product_uom_id")) ?? false, quantity: Number((await line.get("qty_to_invoice")) ?? 0),
    discount: Number((await line.get("discount")) ?? 0), price_unit: Number((await line.get("price_unit")) ?? 0),
    tax_ids: [[6, 0, ((await line.get("tax_ids")) as unknown[]).map(idOf)]], sale_line_ids: [[4, id]],
    is_downpayment: false, collapse_prices: (await line.get("collapse_prices")) || false, collapse_composition: (await line.get("collapse_composition")) || false,
  };
  const extra = await line.get("extra_tax_data");
  if (extra && typeof extra === "object" && Object.keys(extra).length) throw new NotPorted("invoice of a line with extra tax data");
  // sale_order_line.py:2032-2081 gives no distribution: the invoice line computes its sale line's
  // (src/models/account_move_create.ts `createInvoiceLine`); sale_project :456-469 gives one only without it
  const distribution = await line.get("analytic_distribution");
  if (!(distribution && typeof distribution === "object" && Object.keys(distribution).length)) {
    const task = await line.rel("task_id");
    const taskProject = task ? await task.rel("project_id") : null;
    const project = await line.rel("project_id");
    if (taskProject && (await taskProject.get("account_id"))) res["analytic_distribution"] = { [String(idOf(await taskProject.get("account_id")))]: 100 };
    else if (project && (await project.get("account_id"))) res["analytic_distribution"] = { [String(idOf(await project.get("account_id")))]: 100 };
    else if ((await line.get("is_service")) && !(await line.get("is_expense"))) {
      const accounts = (await env.cr.query<{ a: number }>(
        `SELECT DISTINCT p.account_id AS a FROM project_project p WHERE p.account_id IS NOT NULL
           AND (p.sale_line_id = $1 OR EXISTS(SELECT 1 FROM project_task t WHERE t.project_id = p.id AND t.sale_line_id = $1))`, [id])).rows;
      if (accounts.length === 1) res["analytic_distribution"] = { [String(accounts[0]!.a)]: 100 };
    }
  }
  if (type) res["account_id"] = false;
  return res;
}

/** sale_order.py:1836-1888 `_prepare_invoice` with sale_stock sale_order.py:306-309. */
export async function invoiceValuesOf(env: Environment, id: number): Promise<Record<string, unknown>> {
  return invoiceValues(env, id);
}

/**
 * `order._prepare_invoice()`: sale's definition through the private hook (src/orm/private_hooks.ts), so a site's
 * compiled override runs around it (l10n_kr_sale: the proof of issuance), then sale_stock's, above them in the MRO
 * (sale_stock, l10n_kr_sale, sale) and after its super(): the delivery date (private_hooks.json `above`).
 */
async function invoiceValues(env: Environment, id: number): Promise<Record<string, unknown>> {
  const values = await priv.sale_order._prepare_invoice.call(env, [id], [], async (e, ids) => saleInvoiceValues(e, ids[0]!));
  if (values === null || typeof values !== "object" || Array.isArray(values)) throw new NotPorted(`sale.order._prepare_invoice returning ${JSON.stringify(values)}`);
  const out = values as Record<string, unknown>;
  // sale_stock sale_order.py:306-309: `self.effective_date and context_timestamp(self, self.effective_date)`, the day
  // in the environment's zone once the Date field takes it
  if (env.reg.model(ORDER).fields.has("effective_date")) {
    out["delivery_date"] = await contextDay(env, await new DbRec(env.sudo(), env.reg.model(ORDER), id).get("effective_date"));
  }
  return out;
}

/** sale_order.py:1836-1888 sale's `_prepare_invoice`. */
async function saleInvoiceValues(env: Environment, id: number): Promise<Record<string, unknown>> {
  const order = new DbRec(env.sudo(), env.reg.model(ORDER), id);
  if ((await order.rels("transaction_ids")).length) throw new NotPorted("invoice of an order with payment transactions");
  if (await order.get("utm_reference")) throw new NotPorted("invoice of an order with a utm_reference");
  const m2o = async (f: string): Promise<number | false> => idOf(await order.get(f)) ?? false;
  const invoicePartner = await order.get("partner_invoice_id");
  let position = await m2o("fiscal_position_id");
  if (!position) {
    const { fiscalPositionFor } = await import("./sale_computes");
    position = (await fiscalPositionFor(env, Number(await order.get("company_id")), Number(invoicePartner), null)) ?? false;
  }
  const values: Record<string, unknown> = {
    ref: (await order.get("client_order_ref")) || (await order.get("name")), move_type: "out_invoice", narration: (await order.get("note")) || false,
    currency_id: await m2o("currency_id"), campaign_id: await m2o("campaign_id"), medium_id: await m2o("medium_id"), source_id: await m2o("source_id"),
    team_id: await m2o("team_id"), partner_id: await m2o("partner_invoice_id"), partner_shipping_id: await m2o("partner_shipping_id"),
    fiscal_position_id: position, invoice_origin: await order.get("name"), invoice_payment_term_id: await m2o("payment_term_id"),
    preferred_payment_method_line_id: await m2o("preferred_payment_method_line_id"), invoice_user_id: await m2o("user_id"),
    payment_reference: (await order.get("reference")) || false, company_id: await m2o("company_id"), invoice_line_ids: [] as unknown[],
    // sale_order.py:1881 `user_id` too (account.move.user_id, related to invoice_user_id and tracked): the mail.thread
    // create subscribes that user and, when it is not the current one, notifies them (mail_thread.py:4960-4970)
    user_id: await m2o("user_id"),
    invoice_incoterm_id: await m2o("incoterm"), incoterm_location: (await order.get("incoterm_location")) || false, document_tax_mode: (await order.get("document_tax_mode")) || false,
  };
  const journal = await m2o("journal_id");
  if (journal) values["journal_id"] = journal;
  return values;
}

/** The stored computes on the lines and the order that follow the invoice lines (`invoice_lines.move_id.state`, `invoice_lines.quantity`). */
export async function refreshInvoiced(env0: Environment, orders: readonly number[]): Promise<void> {
  const env = env0.sudo();
  for (const order of orders) {
    for (const id of await env.model(LINE).search({ kind: "cond", path: "order_id", op: "=", value: order })) {
      // sale_order_line.py:1294-1312 `_prepare_qty_invoiced`
      const rows = (await env.cr.query<{ qty: number; type: string; state: string; payment: string | null; from_uom: number | null; to_uom: number | null }>(
        `SELECT aml.quantity::float8 AS qty, m.move_type AS type, m.state, m.payment_state AS payment, fu.factor::float8 AS from_uom, tu.factor::float8 AS to_uom
           FROM sale_order_line_invoice_rel r JOIN account_move_line aml ON aml.id = r.invoice_line_id JOIN account_move m ON m.id = aml.move_id
           JOIN sale_order_line sl ON sl.id = r.order_line_id LEFT JOIN uom_uom fu ON fu.id = aml.product_uom_id LEFT JOIN uom_uom tu ON tu.id = sl.product_uom_id
          WHERE r.order_line_id = $1`, [id])).rows;
      let invoiced = 0;
      for (const r of rows) {
        if (r.state === "cancel" && r.payment !== "invoicing_legacy") continue;
        const qty = r.from_uom && r.to_uom ? r.qty * r.from_uom / r.to_uom : r.qty;
        if (r.type === "out_invoice") invoiced += qty;
        else if (r.type === "out_refund") invoiced -= qty;
      }
      const before = (await env.cr.query<{ i: number | null; t: number | null; s: string | null }>(
        "SELECT qty_invoiced::float8 AS i, qty_to_invoice::float8 AS t, invoice_status AS s FROM sale_order_line WHERE id = $1", [id])).rows[0]!;
      if ((before.i ?? 0) !== invoiced) await updateRow(env, "sale_order_line", id, { qty_invoiced: invoiced });
      const line = (): DbRec => new DbRec(env, env.reg.model(LINE), id);
      const toInvoice = Number(await recordCompute(LINE, "qty_to_invoice")!(env, line()));
      if ((before.t ?? 0) !== toInvoice) await updateRow(env, "sale_order_line", id, { qty_to_invoice: toInvoice });
      const status = await recordCompute(LINE, "invoice_status")!(env, line());
      if (before.s !== status) await updateRow(env, "sale_order_line", id, { invoice_status: status });
    }
    const rec = (): DbRec => new DbRec(env, env.reg.model(ORDER), order);
    const row = (await env.cr.query<{ s: string | null; u: number | null }>("SELECT invoice_status AS s, amount_unpaid::float8 AS u FROM sale_order WHERE id = $1", [order])).rows[0]!;
    const status = await recordCompute(ORDER, "invoice_status")!(env, rec());
    if (row.s !== status) await updateRow(env, "sale_order", order, { invoice_status: status });
    const unpaid = Number(await recordCompute(ORDER, "amount_unpaid")!(env, rec()));
    if ((row.u ?? 0) !== unpaid) await updateRow(env, "sale_order", order, { amount_unpaid: unpaid });
  }
}

/** sale_order.py:1934-1943 sale's `_get_invoice_grouping_keys`. */
const INVOICE_GROUPING_KEYS = ["company_id", "partner_id", "partner_shipping_id", "currency_id", "fiscal_position_id", "invoice_incoterm_id", "incoterm_location"];

/**
 * sale_order.py:2031-2195 `_create_invoices`, each order on its own invoice: `grouped`, or a single order to invoice.
 * Ungrouped, `_get_invoice_grouping_keys()` runs through the private hook (a site's override adds keys: l10n_kr_sale's
 * proof of issuance), and the invoice values of several orders, which Odoo sorts and merges by those keys
 * (:2100-2131), refuse.
 */
export async function createOrderInvoices(env0: Environment, orders: readonly number[], final: boolean, grouped = false): Promise<number[]> {
  const moves: number[] = [];
  const todo: { id: number; company: number; env: Environment; lines: number[]; values: Record<string, unknown> }[] = [];
  for (const id of orders) {
    const company = Number((await env0.cr.query<{ c: number }>("SELECT company_id AS c FROM sale_order WHERE id = $1", [id])).rows[0]?.c);
    const env = await withCompany(env0, company);
    // :2057-2061 `_prepare_invoice` before the invoiceable lines, also for an order skipped below
    const values = await invoiceValues(env, id);
    const lines = await invoiceableLines(env, id, final);
    const types = (await env.cr.query<{ id: number; display_type: string | null }>("SELECT id, display_type FROM sale_order_line WHERE id = ANY($1::int[])", [lines])).rows;
    if (types.every((l) => l.display_type)) continue;
    todo.push({ id, company, env, lines, values });
  }
  if (!grouped && todo.length) {
    const keys = await priv.sale_order._get_invoice_grouping_keys.call(env0, [...orders], [], async () => [...INVOICE_GROUPING_KEYS]);
    if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string")) throw new NotPorted(`sale.order._get_invoice_grouping_keys returning ${JSON.stringify(keys)}`);
    if (todo.length > 1) throw new NotPorted(`invoicing ${todo.length} orders at once: their invoices sorted and merged by ${keys.join(", ")} (sale_order.py:2100-2131)`);
  }
  for (const { id, company, env, lines, values } of todo) {
    let sequence = 0;
    // :2062-2088 the down payment lines (at the end) after their own section, each deducted: quantity -1 and the
    // reversed extra tax data (account_tax.py:1463-1486)
    const dps = new Set((await env.cr.query<{ id: number }>("SELECT id FROM sale_order_line WHERE id = ANY($1::int[]) AND is_downpayment AND display_type IS NULL", [lines])).rows.map((r) => r.id));
    let dpSection = false;
    for (const line of lines) {
      if (!dpSection && dps.has(line)) {
        values["invoice_line_ids"] = [...(values["invoice_line_ids"] as unknown[]), [0, 0, {
          display_type: "line_section", name: translate(env, "Down Payments", "sale"), product_id: false, product_uom_id: false, quantity: 0, discount: 0, price_unit: 0,
          account_id: false, sequence: sequence++,
        }]];
        dpSection = true;
      }
      let vals: Record<string, unknown>;
      if (dps.has(line)) {
        const { downPaymentInvoiceLine, pyExtraTaxData } = await import("./sale_down_payment");
        const { accountTaxHelpers } = await import("./account_tax_engine");
        const extra = (await env.cr.query<{ x: Record<string, unknown> | null }>("SELECT extra_tax_data AS x FROM sale_order_line WHERE id = $1", [line])).rows[0]?.x ?? null;
        vals = await downPaymentInvoiceLine(env, line, { sequence, quantity: -1.0, extra_tax_data: pyExtraTaxData(accountTaxHelpers.reverse_quantity_base_line_extra_tax_data(extra)) });
      } else vals = await invoiceLineValues(env, line, sequence);
      sequence++;
      values["invoice_line_ids"] = [...(values["invoice_line_ids"] as unknown[]), [0, 0, vals]];
    }
    // :2124-2128 grouping leaves one payment reference as it is
    const sudo = env.sudo().withContext({ ...env.context, default_move_type: "out_invoice" });
    const [move] = await create(sudo, "account.move", [values]);
    // :2166-2170 a final invoice with a negative total becomes a credit note (`action_switch_move_type`, the team
    // protected), then `invoice_ids._set_reversed_entry` (account_move.py:8213-8221: only with
    // `_refunds_origin_required`, False without a localization overriding it)
    if (final) {
      const total = (await env.cr.query<{ t: number }>("SELECT amount_total::float8 AS t FROM account_move WHERE id = $1", [move])).rows[0]?.t ?? 0;
      if (total < 0) {
        const { switchMoveType } = await import("./account_move_switch");
        await switchMoveType(sudo, [move!]);
      }
    }
    moves.push(move!);
    await refreshInvoiced(env, [id]);
    // :2178-2184 message_post_with_source('mail.message_origin_link')
    const rendered = await originLinkBody(env, "account.move", { model: ORDER, id });
    const [author, emailFrom] = await computeAuthor(env, null, null);
    await insertMessages(env, [{
      model: "account.move", res_id: move!, body: rendered, author_id: author, email_from: emailFrom, message_type: "notification", subject: false,
      subtype_id: await xmlid(env, "mail.mt_note"), email_add_signature: true, record_company_id: company,
      parent_id: await flatThreadParent(env, "account.move", move!), message_id: trackingMessageId("message-notify"), reply_to: await replyToDefault(env, emailFrom),
    }]);
  }
  // :2097-2098 with `_nothing_to_invoice_error_message` (:1945-1957)
  if (!moves.length && (env0.context["raise_if_nothing_to_invoice"] ?? true)) {
    throw new UserError(translate(env0, "Cannot create an invoice. No items are available to invoice.\n\n"
      + "To resolve this issue, please ensure that:\n"
      + "   \u2022 The products have been delivered before attempting to invoice them.\n"
      + "   \u2022 The invoicing policy of the product is configured correctly.\n\n"
      + "If you want to invoice based on ordered quantities instead:\n"
      + "   \u2022 For consumable or storable products, open the product, go to the"
      + " 'General Information' tab and change the 'Invoicing Policy' from 'Delivered"
      + " Quantities' to 'Ordered Quantities'.\n"
      + "   \u2022 For services (and other products), change the 'Invoicing Policy' to"
      + " 'Prepaid/Fixed Price'.\n", "sale"));
  }
  return moves;
}


/** sale_order.py:1891-1925 action_view_invoice. */
export async function viewInvoice(env: Environment, orders: readonly number[], given: readonly number[] | null): Promise<Record<string, unknown>> {
  const rows = await env.model(ORDER).read([...orders], ["invoice_ids", "partner_id", "partner_shipping_id", "payment_term_id"], "");
  const invoices = given ?? [...new Set(rows.flatMap((r) => (r["invoice_ids"] as number[] | undefined) ?? []))];
  let action: Record<string, unknown> = await actionOf(env, "account.action_move_out_invoice_type");
  if (invoices.length > 1) action["domain"] = [["id", "in", invoices]];
  else if (invoices.length === 1) {
    const form = await env.reg.xmlid(env.cr, "account.view_move_form");
    action["views"] = [[form, "form"], ...(action["views"] as [unknown, string][]).filter((v) => v[1] !== "form")];
    action["res_id"] = invoices[0];
  } else action = { type: "ir.actions.act_window_close" };
  const context: Record<string, unknown> = { default_move_type: "out_invoice" };
  if (rows.length === 1) {
    const row = rows[0]!;
    let term = idOf(row["payment_term_id"]);
    const partner = idOf(row["partner_id"]);
    if (term === null && partner) term = idOf((await env.model("res.partner").read([partner], ["property_payment_term_id"], ""))[0]?.["property_payment_term_id"]);
    // `... or self.env["account.move"].default_get(["invoice_payment_term_id"]).get(...)`: None (null) without a default
    let fallback: unknown = term;
    if (term === null) {
      const { defaultGet } = await import("../web/defaults");
      const v = (await defaultGet(env, "account.move", ["invoice_payment_term_id"]))["invoice_payment_term_id"];
      fallback = v === undefined ? null : v;
    }
    Object.assign(context, { default_partner_id: partner, default_partner_shipping_id: idOf(row["partner_shipping_id"]), default_invoice_payment_term_id: fallback });
  }
  action["context"] = context;
  return action;
}

registerMethod("sale.order", "action_view_invoice", async (env0, ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const given = kwargs["invoices"] ?? args[0];
  if (given) throw new NotPorted("sale.order.action_view_invoice with given invoices over RPC");
  return viewInvoice(env, ids ?? [], null);
}, { apiModel: false });

registerMethod("sale.advance.payment.inv", "create_invoices", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const rows = await env.model("sale.advance.payment.inv").read(ids ?? [], ["advance_payment_method", "amount", "fixed_amount", "sale_order_ids", "deduct_down_payments", "consolidated_billing"], "");
  if (rows.length !== 1) throw new NotPorted("create_invoices of several wizards");
  const w = rows[0]!;
  const method = w["advance_payment_method"];
  // :135-142 _check_amount_is_positive (float values may come as {float: n} from read)
  const amount = (v: unknown): number => (typeof v === "object" && v !== null && "float" in v ? Number((v as { float: number }).float) : Number(v ?? 0));
  if ((method === "percentage" && amount(w["amount"]) <= 0) || (method === "fixed" && amount(w["fixed_amount"]) <= 0)) {
    throw new UserError(translate(env, "The value of the down payment amount must be positive."));
  }
  const orders = (w["sale_order_ids"] as number[] | undefined) ?? [];
  if (method === "percentage" || method === "fixed") {
    const { createDownPaymentInvoice } = await import("./sale_down_payment");
    const invoice = await createDownPaymentInvoice(env, rows[0]!["id"] as number, orders, String(method), amount(w[method === "percentage" ? "amount" : "fixed_amount"]));
    return viewInvoice(env, orders, [invoice]);
  }
  if (method !== "delivered") throw new NotPorted(`create_invoices with the method ${String(method)}`);
  // sale_make_invoice_advance.py:166-171 `grouped=not self.consolidated_billing`
  const moves = await createOrderInvoices(env, orders, Boolean(w["deduct_down_payments"]), !w["consolidated_billing"]);
  return viewInvoice(env, orders, moves);
}, { apiModel: false });
