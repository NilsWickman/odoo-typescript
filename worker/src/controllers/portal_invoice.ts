/**
 * The customer portal page of an invoice: `/my/invoices/<id>` (account/controllers/portal.py:144-177 with
 * account_payment/controllers/portal.py:14-24, portal/controllers/portal.py `_document_check_access`, `_show_report`,
 * `_get_page_view_values`), and the company logo of its layout (`/logo.png`, web/controllers/binary.py:257-293).
 * The payment form of an invoice to pay is ported when no payment provider is available (the warning); a PDF
 * download, a custom amount and the form with providers refuse.
 */
import { AccessError, MissingError, NotPorted } from "../errors";
import type { RequestContext } from "../http/context";
import { route } from "../http/router";
import { floatRoundRounding } from "../orm/convert";
import type { Environment } from "../orm/types";
import { asFloat, isPyFloat, pyBool } from "../pyexpr/values";
import { PyRecords, registerPyMethod } from "../qweb/records";
import { dbNow, todayInTz, translate } from "../models/util";
import { envTz } from "../orm/env";
import { parseDomain } from "../orm/domain";
import { redirectResponse } from "../http/context";
import { userHasGroup } from "../web/groups";
import { pdfEngineOf } from "../report/engine";
import { ATTACHMENT_COLUMNS, type AttachmentRow, attachmentStream } from "./binary";
import { contentDispositionAttachment } from "./export_csv";
import { renderPage } from "./page";
import { frontendLangCookie, renderReportHtml, renderReportPdfInRequest } from "./report";
import { Buffer } from "node:buffer";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { write } from "../orm/write";

// base res_users.py `_is_public`
export async function isPublicUser(env: Environment, uid: number): Promise<boolean> {
  return uid === (await env.cr.query<{ res_id: number }>("SELECT res_id FROM ir_model_data WHERE module = 'base' AND name = 'public_user'")).rows[0]?.res_id;
}

registerPyMethod("res.users", "_is_public", async (recs) => {
  recs.ensureOne();
  return isPublicUser(recs.env, recs.ids[0]!);
});

// base res_users.py:1288-1290 `_is_system`: `self.sudo().has_group('base.group_system')`, for the current user
registerPyMethod("res.users", "_is_system", async (recs) => {
  recs.ensureOne();
  if (recs.ids[0] !== recs.env.uid) throw new NotPorted("res.users._is_system of another user");
  return userHasGroup(recs.env.sudo(), "base.group_system");
});

/** odoo/tools/float_utils.py:216-260 `float_compare(value1, value2, precision_rounding=r)`. */
export function floatCompare(value1: number, value2: number, rounding: number): -1 | 0 | 1 {
  if (value1 === value2) return 0;
  const delta = floatRoundRounding(value1, rounding) - floatRoundRounding(value2, rounding);
  if (floatRoundRounding(delta, rounding) === 0) return 0;
  return delta < 0 ? -1 : 1;
}

// res_currency.py `is_zero` and `compare_amounts`
registerPyMethod("res.currency", "is_zero", async (recs, args) => {
  recs.ensureOne();
  return floatRoundRounding(money(args[0]), money(await recs.field("rounding"))) === 0;
});
registerPyMethod("res.currency", "compare_amounts", async (recs, args, kwargs) => {
  recs.ensureOne();
  const a1 = money(args[0] ?? kwargs.get("amount1"));
  const a2 = money(args[1] ?? kwargs.get("amount2"));
  return floatCompare(a1, a2, money(await recs.field("rounding")));
});

function consteq(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** portal/controllers/portal.py:1086-1104 `_document_check_access`: the sudoed record, or an access error. */
export async function documentCheckAccess(env: Environment, model: string, id: number, token: string | null): Promise<PyRecords> {
  const table = env.reg.model(model).table;
  const row = (await env.sudo().cr.query<{ access_token: string | null }>(`SELECT access_token FROM "${table}" WHERE id = $1`, [id])).rows[0];
  if (row === undefined) throw new MissingError("This document does not exist.");
  try {
    await env.model(model).checkAccess([id], "read");
  } catch (e) {
    if (!(e instanceof AccessError)) throw e;
    if (!token || !row.access_token || !consteq(row.access_token, token)) throw e;
  }
  return new PyRecords(env.sudo(), model, [id]);
}

/**
 * portal/controllers/portal.py:105-130 `get_records_pager(request.session.get(key, []), document)` as
 * `_get_page_view_values` (:1139-1140) adds it: the previous and next documents of the list the session remembers.
 */
export async function recordsPager(history: unknown, doc: PyRecords): Promise<Record<string, unknown>> {
  const ids = Array.isArray(history) ? (history as unknown[]) : [];
  const id = doc.ids[0]!;
  const idx = ids.indexOf(id);
  if (idx < 0) return {};
  const url = async (i: number): Promise<string | false> => {
    if (i < 0 || i >= ids.length) return false;
    const other = doc.browse([Number(ids[i])]);
    const accessUrl = await other.field("access_url");
    return accessUrl ? `${String(accessUrl)}?access_token=${await ensurePortalToken(other)}` : false;
  };
  return { prev_record: idx !== 0 ? await url(idx - 1) : false, next_record: idx < ids.length - 1 ? await url(idx + 1) : false };
}

const money = (v: unknown): number => (isPyFloat(v) ? v.float : Number(v ?? 0));

/**
 * The tokens `_portal_ensure_token` assigned during a list page, by cursor: Odoo keeps them dirty in the cache and
 * flushes them with the request (models.py:5859-5905 `_flush`), in one `UPDATE ... FROM (VALUES ...)` of the records
 * in the order they were written. Writing each one at once would flush it before the next read of the table, one
 * UPDATE per record, and the rows would land elsewhere in the table (a later list then orders its ties otherwise).
 */
const TOKEN_BATCH = new WeakMap<object, Map<string, Map<number, string>>>();

/** Runs `fn` with the tokens it assigns held until it returns, then written together (see TOKEN_BATCH). */
export async function withPortalTokenBatch<T>(env: Environment, fn: () => Promise<T>): Promise<T> {
  if (TOKEN_BATCH.has(env.cr)) return fn();
  const batch = new Map<string, Map<number, string>>();
  TOKEN_BATCH.set(env.cr, batch);
  let out: T;
  try {
    out = await fn();
  } finally {
    TOKEN_BATCH.delete(env.cr);
  }
  for (const [model, tokens] of batch) {
    for (const [id, token] of tokens) await write(env.sudo(), model, [id], { access_token: token });
  }
  return out;
}

/** portal_mixin.py:34-39 `_portal_ensure_token`: an uuid4 written as superuser when missing. */
export async function ensurePortalToken(recs: PyRecords): Promise<string> {
  const id = recs.ids[0]!;
  const batch = TOKEN_BATCH.get(recs.env.cr);
  const held = batch?.get(recs.model)?.get(id);
  if (held !== undefined) return held;
  const token = await recs.field("access_token");
  if (token) return String(token);
  const fresh = randomUUID();
  if (batch !== undefined) {
    const m = batch.get(recs.model) ?? new Map<number, string>();
    batch.set(recs.model, m);
    m.set(id, fresh);
  } else {
    await write(recs.env.sudo(), recs.model, [id], { access_token: fresh });
  }
  return fresh;
}

const PORTAL_URL_ARGS = ["suffix", "report_type", "download", "query_string", "anchor", "share_token"];

/** portal_mixin.py:120-146 `get_portal_url(suffix, report_type, download, query_string, anchor, share_token=True)`. */
export async function portalUrl(recs: PyRecords, args: readonly unknown[] = [], kwargs: ReadonlyMap<string, unknown> = new Map()): Promise<string> {
  recs.ensureOne();
  if (args.length > PORTAL_URL_ARGS.length) throw new NotPorted("get_portal_url with too many arguments");
  const a = new Map<string, unknown>();
  args.forEach((v, i) => a.set(PORTAL_URL_ARGS[i]!, v));
  for (const [k, v] of kwargs) {
    if (!PORTAL_URL_ARGS.includes(k)) throw new NotPorted(`get_portal_url(${k}=)`);
    a.set(k, v);
  }
  const truthy = (k: string): boolean => pyBool(a.get(k) ?? null);
  let url = String(await recs.field("access_url")) + (truthy("suffix") ? String(a.get("suffix")) : "");
  const params: string[] = [];
  if (a.has("share_token") ? truthy("share_token") : true) params.push(`access_token=${await ensurePortalToken(recs)}`);
  if (truthy("report_type")) params.push(`report_type=${String(a.get("report_type"))}`);
  if (truthy("download")) params.push("download=true");
  if (truthy("query_string")) params.push(String(a.get("query_string")).replace(/^&+/, ""));
  if (params.length) url += `?${params.join("&")}`;
  if (truthy("anchor")) url += `#${String(a.get("anchor"))}`;
  return url;
}

registerPyMethod("account.move", "get_portal_url", async (recs, args, kwargs) => {
  recs.ensureOne();
  return portalUrl(recs, args, kwargs);
});

/** Sum of authorized/pending payment transactions on the invoice. */
async function pendingTxAmount(recs: PyRecords): Promise<number> {
  const txIds = await transactions(recs);
  if (!txIds.length) return 0;
  const row = (await recs.env.sudo().cr.query<{ s: number }>(
    `SELECT COALESCE(sum(amount), 0)::float8 AS s FROM payment_transaction
      WHERE id = ANY($1::int[]) AND state IN ('authorized', 'pending')`, [txIds],
  )).rows[0];
  return row?.s ?? 0;
}

/** account_payment account_move.py:53-71 `_has_to_be_paid`. */
async function hasToBePaid(recs: PyRecords): Promise<boolean> {
  if (!await portalPaymentEnabled(recs.env)) return false;
  const currency = (await recs.field("currency_id")) as PyRecords;
  const rounding = money(await currency.field("rounding")) || 0.01;
  const remaining = money(await recs.field("amount_residual")) - await pendingTxAmount(recs);
  return await recs.field("state") === "posted" && ["not_paid", "in_payment", "partial"].includes(String(await recs.field("payment_state")))
    && floatCompare(remaining, 0, rounding) > 0 && money(await recs.field("amount_total")) !== 0 && await recs.field("move_type") === "out_invoice";
}

registerPyMethod("account.move", "_has_to_be_paid", async (recs) => {
  recs.ensureOne();
  return hasToBePaid(recs);
});

async function portalPaymentEnabled(env: Environment): Promise<boolean> {
  const v = (await env.cr.query<{ value: string }>("SELECT value FROM ir_config_parameter WHERE key = 'account_payment.enable_portal_payment'")).rows[0]?.value;
  return Boolean(v) && !["False", "false", "0"].includes(String(v));
}

async function isZero(move: PyRecords): Promise<boolean> {
  const currency = (await move.field("currency_id")) as PyRecords;
  return floatRoundRounding(money(await move.field("amount_residual")), money(await currency.field("rounding"))) === 0;
}

// account_payment account_move.py:72-98 `_get_online_payment_error`
registerPyMethod("account.move", "_get_online_payment_error", async (recs) => {
  recs.ensureOne();
  const currency = (await recs.field("currency_id")) as PyRecords;
  const rounding = money(await currency.field("rounding")) || 0.01;
  const residual = money(await recs.field("amount_residual"));
  const pending = await pendingTxAmount(recs);
  const zero = floatRoundRounding(residual, rounding) === 0;
  const remainingZero = floatCompare(residual - pending, 0, rounding) <= 0;
  const errors: string[] = [];
  if (!await portalPaymentEnabled(recs.env)) errors.push(translate(recs.env, "This invoice cannot be paid online."));
  if (remainingZero) errors.push(translate(recs.env, "There is no amount to be paid."));
  if (await recs.field("state") !== "posted") errors.push(translate(recs.env, "This invoice isn't posted."));
  if (zero) errors.push(translate(recs.env, "This invoice has already been paid."));
  if (await recs.field("move_type") !== "out_invoice") errors.push(translate(recs.env, "This is not an outgoing invoice."));
  return errors.join("\n");
});

async function transactions(recs: PyRecords): Promise<number[]> {
  return (await recs.env.cr.query<{ transaction_id: number }>("SELECT transaction_id FROM account_invoice_transaction_rel WHERE invoice_id = $1", [recs.ids[0]])).rows.map((r) => r.transaction_id);
}

// account_payment account_move.py:100-102 `get_portal_last_transaction`
registerPyMethod("account.move", "get_portal_last_transaction", async (recs) => {
  recs.ensureOne();
  const txIds = await transactions(recs);
  if (!txIds.length) return new PyRecords(recs.env.sudo(), "payment.transaction", []);
  const last = (await recs.env.sudo().cr.query<{ id: number }>(
    "SELECT id FROM payment_transaction WHERE id = ANY($1::int[]) ORDER BY (state != 'draft') DESC, id DESC LIMIT 1", [txIds],
  )).rows[0];
  return new PyRecords(recs.env.sudo(), "payment.transaction", last ? [last.id] : []);
});

export interface PaymentTermLineInput {
  readonly id: number;
  readonly date_maturity: string | null;
  readonly amount_residual_currency: number;
  readonly amount_currency: number;
  readonly reconciled: boolean;
  readonly discount_date: string | null;
  readonly discount_amount_currency: number | null;
}

export interface NextPaymentInput {
  readonly lines: readonly PaymentTermLineInput[];
  readonly paymentState: unknown;
  readonly total: number;
  readonly residual: number;
  readonly dueDate: unknown;
  readonly reference: unknown;
  readonly today: string;
  readonly unreconciledPaidAmount: number;
  readonly rounding: number;
}

/** Pure calculation for account_move.py:7350-7448 `_get_invoice_next_payment_values` (single, EPD, and installments). */
export function computeNextPaymentValues(input: NextPaymentInput): Record<string, unknown> {
  const { lines, paymentState, total, residual, dueDate, reference, today, unreconciledPaidAmount, rounding } = input;
  if (!lines.length) return {};
  const open = lines
    .filter((l) => !l.reconciled && floatCompare(Math.abs(l.amount_residual_currency), 0, rounding) > 0)
    .sort((a, b) => (a.date_maturity ?? "").localeCompare(b.date_maturity ?? "") || a.id - b.id);
  const base: Record<string, unknown> = {
    payment_state: paymentState,
    installment_state: null,
    next_amount_to_pay: asFloat(residual),
    next_payment_reference: reference,
    amount_paid: asFloat(total - residual),
    amount_due: asFloat(residual),
    next_due_date: dueDate,
    due_date: dueDate,
    is_last_installment: open.length <= 1 && lines.some((l) => !l.reconciled),
    unreconciled_paid_amount: unreconciledPaidAmount ? asFloat(unreconciledPaidAmount) : 0,
  };
  if (lines.length === 1) {
    const line = lines[0]!;
    if (
      !line.reconciled
      && line.discount_date
      && line.discount_date >= today
      && line.discount_amount_currency !== null
      && floatCompare(Math.abs(line.discount_amount_currency), residual, rounding) < 0
    ) {
      const epdAmt = Math.abs(line.discount_amount_currency);
      return {
        ...base,
        installment_state: "epd",
        next_amount_to_pay: asFloat(epdAmt),
        next_due_date: line.discount_date,
        epd_discount_amount: asFloat(floatRoundRounding(residual - epdAmt, rounding)),
      };
    }
    return base;
  }
  if (!open.length) {
    return { ...base, installment_state: null, is_last_installment: false };
  }
  const overdue = open.filter((l) => l.date_maturity && l.date_maturity < today);
  if (overdue.length) {
    const overdueSum = floatRoundRounding(overdue.reduce((s, l) => s + Math.abs(l.amount_residual_currency), 0), rounding);
    return {
      ...base,
      installment_state: "overdue",
      next_amount_to_pay: asFloat(overdueSum),
      next_due_date: overdue[0]!.date_maturity ?? dueDate,
      is_last_installment: overdue.length === open.length,
    };
  }
  const next = open[0]!;
  return {
    ...base,
    installment_state: "next",
    next_amount_to_pay: asFloat(Math.abs(next.amount_residual_currency)),
    next_due_date: next.date_maturity ?? dueDate,
    is_last_installment: open.length === 1,
  };
}

/** account_move.py:7350-7448 `_get_invoice_next_payment_values`. */
export async function nextPaymentValues(move: PyRecords): Promise<Record<string, unknown>> {
  const rows = (await move.env.cr.query<{
    id: number; date_maturity: string | null; amount_residual_currency: number; amount_currency: number;
    reconciled: boolean; discount_date: string | null; discount_amount_currency: number | null;
  }>(
    `SELECT id, date_maturity::text AS date_maturity, COALESCE(amount_residual_currency, 0)::float8 AS amount_residual_currency,
            COALESCE(amount_currency, 0)::float8 AS amount_currency, COALESCE(reconciled, false) AS reconciled,
            discount_date::text AS discount_date, discount_amount_currency::float8 AS discount_amount_currency
       FROM account_move_line WHERE move_id = $1 AND display_type = 'payment_term' ORDER BY date_maturity NULLS LAST, id`,
    [move.ids[0]],
  )).rows;
  if (!rows.length) return {};
  const payments = (await move.field("reconciled_payment_ids")) as PyRecords;
  let unreconciledPaid = 0;
  for (const p of payments.pyIter() as PyRecords[]) {
    if (!await p.field("is_reconciled") && !await p.field("is_matched") && await p.field("state") === "paid") {
      unreconciledPaid += money(await p.field("amount"));
    }
  }
  const currency = (await move.field("currency_id")) as PyRecords;
  const rounding = money(await currency.field("rounding")) || 0.01;
  const today = todayInTz(await dbNow(move.env), await envTz(move.env));
  return computeNextPaymentValues({
    lines: rows,
    paymentState: await move.field("payment_state"),
    total: money(await move.field("amount_total")),
    residual: money(await move.field("amount_residual")),
    dueDate: await move.field("invoice_date_due"),
    reference: await move.field("name"),
    today,
    unreconciledPaidAmount: unreconciledPaid,
    rounding,
  });
}

/**
 * payment/controllers/portal.py:198-271 `_prepare_payment_form_values` and :539-551 `_can_partner_pay_in_company`,
 * shared by `/my/invoices/<id>` and `/my/orders/<id>`.
 */
export async function preparePaymentFormContext(
  env: Environment, company: PyRecords, partnerId: number, amount: number, currency: PyRecords,
  extra: Readonly<Record<string, unknown>> = {},
): Promise<Record<string, unknown>> {
  const companyId = company.ids[0]!;
  const su = env.sudo();
  // payment controllers/portal.py:539-551 `_can_partner_pay_in_company`
  const partnerCompany = (await su.cr.query<{ company_id: number | null }>("SELECT company_id FROM res_partner WHERE id = $1", [partnerId])).rows[0]?.company_id ?? null;
  // payment controllers/portal.py:198-272 `_prepare_payment_form_values` (src/models/payment_flow.ts)
  const { paymentFormValues } = await import("../models/payment_flow");
  const form = await paymentFormValues(env, companyId, partnerId, amount, currency.ids[0] ?? null, extra);
  // the availability report as Python's dict of records (template payment.availability_report_records)
  const report = new Map<string, Map<PyRecords, Map<string, unknown>>>();
  for (const [category, model] of [["providers", "payment.provider"], ["payment_methods", "payment.method"]] as const) {
    const m = form.report[category];
    if (m) report.set(category, new Map([...m].map(([id, v]) => [new PyRecords(su, model, [id]), new Map<string, unknown>([["available", v.available], ["reason", v.reason]])])));
  }
  return {
    company_mismatch: !(partnerCompany === null || partnerCompany === companyId), expected_company: company,
    providers_sudo: new PyRecords(su, "payment.provider", form.providers), payment_methods_sudo: new PyRecords(su, "payment.method", form.paymentMethods),
    tokens_sudo: new PyRecords(su, "payment.token", form.tokens), show_tokenize_input_mapping: form.showTokenizeInput, availability_report: report,
  };
}

/**
 * account_payment controllers/portal.py:14-49 `_invoice_get_page_view_values` for an invoice to pay, with :144-196
 * `_get_common_page_view_values` and payment/controllers/portal.py:198-271 `_prepare_payment_form_values`.
 */
async function invoicePaymentValues(env: Environment, invoice: PyRecords, token: string | null, payment: unknown,
  kwargs: Readonly<Record<string, string>>): Promise<Record<string, unknown>> {
  // the early payment discount refuses in nextPaymentValues: `epd` is 0.0
  const logged = !await isPublicUser(env, env.uid);
  const partnerId = logged
    ? (await env.sudo().cr.query<{ partner_id: number }>("SELECT partner_id FROM res_users WHERE id = $1", [env.uid])).rows[0]!.partner_id
    : ((await invoice.field("partner_id")) as PyRecords).ids[0]!;
  const company = (await invoice.field("company_id")) as PyRecords;
  if (!company.ids.length) throw new NotPorted("the portal payment form of an invoice without a company");
  const currency = (await invoice.field("currency_id")) as PyRecords;
  // the route's other query parameters reach `_prepare_payment_form_values(**kwargs)` and `_find_available_providers`
  // (account/controllers/portal.py portal_my_invoice_detail `**kw`, account_payment :14-49 `**kwargs`).
  // account_payment_custom's controller adds is_invoice=True (controllers/portal.py:8-10): a controller override the
  // site build does not see, so the hand port follows the module's installation
  const extra: Record<string, unknown> = { ...kwargs };
  const custom = (await env.sudo().cr.query("SELECT 1 FROM ir_module_module WHERE name = 'account_payment_custom' AND state = 'installed'")).rows.length > 0;
  if (custom) {
    if ("is_invoice" in extra) throw new NotPorted("/my/invoices with an is_invoice parameter (a duplicate keyword in Odoo)");
    extra["is_invoice"] = true;
  }
  const formCtx = await preparePaymentFormContext(env, company, partnerId, money(await invoice.field("amount_total")), currency, extra);
  return {
    ...formCtx,
    currency, partner_id: partnerId, transaction_route: `/invoice/transaction/${invoice.ids[0]}`,
    landing_route: await portalUrl(invoice), access_token: token, payment_reference: false,
    amount_custom: asFloat(0), payment, invoice_id: invoice.ids[0], invoice_name: await invoice.field("name"), show_epd: asFloat(0),
  };
}

route("/my/invoices/<int:invoice_id>", async (ctx: RequestContext, params) => {
  const env = await ctx.orm();
  const id = Number(params["invoice_id"]);
  const q = ctx.url.searchParams;
  const token = q.get("access_token");
  // account_payment controllers/portal.py:198-205: a custom amount needs its payment token
  if (q.get("amount")) {
    if (!q.get("payment_token")) return redirectResponse("/my", 303);
    throw new NotPorted("/my/invoices with a custom amount and its payment token");
  }
  let invoice: PyRecords;
  try {
    invoice = await documentCheckAccess(env, "account.move", id, token);
  } catch (e) {
    if (e instanceof AccessError || e instanceof MissingError) return ctx.redirect("/my"); // request.redirect: werkzeug's redirect page with the 303
    throw e;
  }
  frontendLangCookie(ctx, env);
  const reportType = q.get("report_type");
  if (reportType === "text") throw new NotPorted(`/my/invoices with report_type=${reportType}`);
  if (reportType === "html" || reportType === "pdf") {
    const pdf = (await env.sudo().cr.query("SELECT 1 FROM ir_attachment WHERE res_model = 'account.move' AND res_id = $1 AND res_field = 'invoice_pdf_report_file' LIMIT 1", [id])).rows.length > 0;
    const partner = (await invoice.field("partner_id")) as PyRecords;
    const template = (await partner.field("invoice_template_pdf_report_id")) as PyRecords;
    if (template.ids.length) throw new NotPorted("partner invoice template on the portal");
    // account/controllers/portal.py:166-169: a right-to-left customer language becomes the report's language
    const partnerLang = await partner.field("lang");
    if (partnerLang) {
      const dir = (await env.sudo().cr.query<{ direction: string }>("SELECT direction FROM res_lang WHERE code = $1", [String(partnerLang)])).rows[0]?.direction;
      if (dir === "rtl") throw new NotPorted("/my/invoices report in a right-to-left customer language");
    }
    // portal.py:1149-1152 `_show_report`: `ReportAction.with_company(model.company_id)`, as /my/orders does
    const company = (await invoice.field("company_id")) as PyRecords;
    const su = env.sudo().withContext({ ...env.context, proforma_invoice: !pdf, ...(company.ids.length ? { allowed_company_ids: [company.ids[0]!] } : {}) });
    if (reportType === "html") {
      const html = await renderReportHtml(su, "account.report_invoice_with_payments", [id], { report_type: "html" });
      return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
    }
    if (!pdfEngineOf(ctx.env, ctx.db)) throw new NotPorted("/my/invoices with report_type=pdf");
    const pdfBytes = await renderReportPdfInRequest(su, "account.report_invoice_with_payments", [id]);
    const baseName = `${String(await invoice.field("name") ?? `Invoice_${id}`)}`.replace(/\W+/g, "_");
    // portal.py:1162 `'attachment' if download else 'inline'`: any non-empty string is true ("0" and "false" too)
    const download = Boolean(q.get("download"));
    const disposition = download
      ? contentDispositionAttachment(`${baseName}.pdf`)
      : contentDispositionAttachment(`${baseName}.pdf`).replace(/^attachment;/, "inline;");
    return new Response(pdfBytes, { status: 200, headers: { "Content-Type": "application/pdf", "Content-Length": String(pdfBytes.length), "Content-Disposition": disposition } });
  }
  // account/controllers/portal.py:32-40, portal/controllers/portal.py:1118-1141 (the record pager of the session history, recordsPager below)
  const values: Record<string, unknown> = {
    page_name: "invoice", invoice, currency: await invoice.field("currency_id"), ...await nextPaymentValues(invoice),
    object: invoice, prev_record: false, next_record: false,
  };
  Object.assign(values, await recordsPager(ctx.session["my_invoices_history"], invoice));
  if (token) Object.assign(values, { no_breadcrumbs: false, access_token: token, token });
  for (const k of ["error", "warning", "success", "pid", "hash"]) if (q.get(k)) values[k] = q.get(k);
  const payment = q.get("payment") ?? false;
  const kwargs: Record<string, string> = {};
  for (const [k, v] of q) if (!["access_token", "report_type", "download", "payment", "amount", "payment_token"].includes(k) && !(k in kwargs)) kwargs[k] = v;
  Object.assign(values, await hasToBePaid(invoice) ? await invoicePaymentValues(env, invoice, token, payment, kwargs) : { payment });
  const html = await renderPage(ctx, "account.portal_invoice_page", values, env);
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}, { auth: "public" });

// web/controllers/binary.py:257-293 company_logo for an explicit or default company
route(["/web/binary/company_logo", "/logo", "/logo.png"], async (ctx: RequestContext) => {
  const raw = ctx.url.searchParams.get("company");
  let companyId: number;
  if (raw !== null && raw !== "") {
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) return new Response("Not Found", { status: 404 });
    companyId = Number(raw);
  } else if (ctx.uid) {
    companyId = (await ctx.cursor().query<{ company_id: number }>("SELECT company_id FROM res_users WHERE id = $1", [ctx.uid])).rows[0]?.company_id ?? 1;
  } else {
    companyId = 1;
  }
  const row = (await ctx.cursor().query<AttachmentRow>(
    `SELECT ${ATTACHMENT_COLUMNS} FROM ir_attachment WHERE res_model = 'res.company' AND res_field = 'logo_web' AND res_id = $1 ORDER BY id LIMIT 1`, [companyId])).rows[0];
  if (row === undefined) return new Response("Not Found", { status: 404 });
  const stream = await attachmentStream(ctx, row, row.mimetype?.includes("/svg") ? "logo.svg" : "logo.png");
  stream.public = true;
  return stream.getResponse(ctx.request, {});
}, { auth: "none", cors: "*" });

