/**
 * The customer portal page of a sales order: `/my/orders/<id>` (sale/controllers/portal.py:132-333) for quotations
 * (`draft`, `sent`) and confirmed/cancelled orders (`sale`, `cancel`), with `_get_page_view_values`
 * (portal/controllers/portal.py:1107-1168, with the record pager of the session history the lists keep) and `sale_stock` delivery orders
 * (sale_stock/controllers/portal.py:14-24).
 */
import { AccessError, MissingError, NotPorted } from "../errors";
import { envTz } from "../orm/env";
import { floatRoundRounding } from "../orm/convert";
import { DbRec, deferredFlush, type Rec } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { asFloat, pyBool } from "../pyexpr/values";
import { defineComputes } from "../models/tail_util";
import { dbNow, todayInTz, translate } from "../models/util";
import { lookupMethod } from "../http/methods";
import { ensureRegistryLang } from "../orm/registry";
import type { RequestContext } from "../http/context";
import { route } from "../http/router";
import { pdfEngineOf } from "../report/engine";
import { PyRecords, registerPyMethod } from "../qweb/records";
import { contentDispositionAttachment } from "./export_csv";
import { documentCheckAccess, floatCompare, isPublicUser, preparePaymentFormContext, recordsPager, ensurePortalToken } from "./portal_invoice";
import { renderPage } from "./page";
import { frontendLangCookie, renderReportHtml, renderReportPdfInRequest } from "./report";
import "./portal_home";

const num = (v: unknown): number => Number(typeof v === "object" && v !== null && "float" in v ? (v as { float: number }).float : v ?? 0);

// sale_order.py:955-1010 `_get_advantages`
async function advantages(order: PyRecords): Promise<[unknown, unknown]> {
  const rec = new DbRec(order.env, order.def, order.ids[0]!);
  const priced: Rec[] = [];
  let hasDiscountOrGlobal = false;
  for (const line of await rec.rels("order_line")) {
    if (await line.get("display_type")) continue;
    priced.push(line);
    if (num(await line.get("discount")) > 0) hasDiscountOrGlobal = true;
    const extra = await line.get("extra_tax_data");
    if (extra && typeof extra === "object") {
      const ck = String((extra as Record<string, unknown>)["computation_key"] ?? "");
      if (ck.startsWith("global_discount,") || ck.startsWith("loyalty_discount,")) hasDiscountOrGlobal = true;
    }
  }
  if (!hasDiscountOrGlobal || !priced.length) return [0, 0];
  const { extendedTaxHelpers, saleLineBaseAll } = await import("../models/sweep_sale_product");
  const { companyData } = await import("../models/account_taxes");
  const companyId = await rec.get("company_id");
  const company = await companyData(order.env, typeof companyId === "number" && companyId ? companyId : await order.env.company());
  const currencyId = await rec.get("currency_id");
  const curRounding = typeof currencyId === "number" && currencyId
    ? Number((await order.env.cr.query<{ r: string }>("SELECT rounding::text AS r FROM res_currency WHERE id = $1", [currencyId])).rows[0]?.r ?? 0.01)
    : company.currency_id.rounding;
  const baseLines = [];
  const undiscountedLines = [];
  for (const line of priced) {
    baseLines.push((await saleLineBaseAll(order.env, line)).base);
    const d = num(await line.get("discount"));
    undiscountedLines.push((await saleLineBaseAll(order.env, line, { discount: Math.min(d, 0) })).base);
  }
  const grp = (b: unknown) => {
    const st = (b as { special_type?: string | null }).special_type;
    return st !== "global_discount" && st !== "loyalty_discount";
  };
  extendedTaxHelpers.add_tax_details_in_base_lines(baseLines, company);
  extendedTaxHelpers.round_base_lines_tax_details(baseLines, company);
  const agg = extendedTaxHelpers.aggregate_base_lines_aggregated_values(extendedTaxHelpers.aggregate_base_lines_tax_details(baseLines, grp));
  extendedTaxHelpers.add_tax_details_in_base_lines(undiscountedLines, company);
  extendedTaxHelpers.round_base_lines_tax_details(undiscountedLines, company);
  const aggU = extendedTaxHelpers.aggregate_base_lines_aggregated_values(extendedTaxHelpers.aggregate_base_lines_tax_details(undiscountedLines, grp));
  let totalExcl = 0, totalIncl = 0, undiscountedExcl = 0, undiscountedIncl = 0;
  for (const v of Object.values(agg)) {
    totalExcl += v.total_excluded_currency;
    totalIncl += v.total_excluded_currency + v.tax_amount_currency;
  }
  for (const v of Object.values(aggU)) {
    if (v.grouping_key) {
      undiscountedExcl += v.total_excluded_currency;
      undiscountedIncl += v.total_excluded_currency + v.tax_amount_currency;
    }
  }
  const advExcl = totalExcl - undiscountedExcl;
  const advIncl = totalIncl - undiscountedIncl;
  if (floatRoundRounding(advIncl, curRounding) !== 0) {
    return [asFloat(advExcl), asFloat(advIncl)];
  }
  return [0, 0];
}

// sale_order.py:2609-2619 `_get_prepayment_required_amount`
async function prepaymentRequiredAmount(order: PyRecords): Promise<{ raw: number; py: unknown }> {
  const percent = num(await order.field("prepayment_percent"));
  if (percent === 0) return { raw: 0, py: 0 };
  const total = num(await order.field("amount_total"));
  const currency = (await order.field("currency_id")) as PyRecords;
  const rounded = floatRoundRounding(total * percent, num(await currency.field("rounding")));
  return { raw: rounded, py: asFloat(rounded) };
}

// sale_order.py:2621-2633 `_is_confirmation_amount_reached`
async function isConfirmationAmountReached(order: PyRecords): Promise<boolean> {
  const { raw: required } = await prepaymentRequiredAmount(order);
  const paid = num(await order.field("amount_paid"));
  const currency = (await order.field("currency_id")) as PyRecords;
  return floatCompare(required, paid, num(await currency.field("rounding"))) <= 0;
}

// sale_order.py:2383-2403 `_has_to_be_signed`
async function hasToBeSigned(order: PyRecords): Promise<boolean> {
  if (!["draft", "sent"].includes(String(await order.field("state")))) return false;
  if (await order.field("is_expired")) return false;
  if (!(await order.field("require_signature"))) return false;
  if (pyBool(await order.field("signature"))) return false;
  return true;
}

// sale_order.py:2405-2427 `_has_to_be_paid`
async function hasToBePaid(order: PyRecords): Promise<boolean> {
  if (!["draft", "sent"].includes(String(await order.field("state")))) return false;
  if (await order.field("is_expired")) return false;
  if (!(num(await order.field("prepayment_percent")) > 0)) return false;
  if (!(num(await order.field("amount_total")) > 0)) return false;
  if (await isConfirmationAmountReached(order)) return false;
  return true;
}

registerPyMethod("sale.order", "_has_to_be_paid", async (recs) => {
  recs.ensureOne();
  return hasToBePaid(recs);
});

/** portal_mixin.py:34-39 `_portal_ensure_token`: an uuid4 written as superuser when missing. */
async function ensureOrderToken(order: PyRecords): Promise<string> {
  return ensurePortalToken(order);
}

async function salePortalUrl(order: PyRecords, suffix = ""): Promise<string> {
  const token = await ensureOrderToken(order);
  return `/my/orders/${order.ids[0]}${suffix}?access_token=${token}`;
}

/** sale/controllers/portal.py:245-264 `_determine_is_down_payment`. */
async function determineIsDownPayment(order: PyRecords, amountSelection: string | null, paymentAmount: number | null): Promise<boolean> {
  if (amountSelection === "down_payment") return true;
  if (amountSelection === "full_amount") return false;
  if (paymentAmount === null) return num(await order.field("prepayment_percent")) < 1.0;
  return paymentAmount < num(await order.field("amount_total"));
}

/** sale/controllers/portal.py:266-333 `_get_payment_values`. */
async function salePaymentValues(
  env: Environment, order: PyRecords, isDownPayment: boolean, paymentAmount: number | null, prepaymentAvailable: boolean,
): Promise<Record<string, unknown>> {
  const company = (await order.field("company_id")) as PyRecords;
  const logged = !await isPublicUser(env, env.uid);
  const partnerId = logged
    ? (await env.sudo().cr.query<{ partner_id: number }>("SELECT partner_id FROM res_users WHERE id = $1", [env.uid])).rows[0]!.partner_id
    : ((await order.field("partner_id")) as PyRecords).ids[0]!;
  const currency = (await order.field("currency_id")) as PyRecords;
  const total = num(await order.field("amount_total"));
  const state = String(await order.field("state"));
  let amount: number;
  if (isDownPayment) {
    amount = paymentAmount && paymentAmount < total ? paymentAmount : (await prepaymentRequiredAmount(order)).raw;
  } else if (state === "sale") {
    amount = paymentAmount || total;
  } else {
    amount = floatRoundRounding(total - num(await order.field("amount_paid")), num(await currency.field("rounding")));
  }
  const formCtx = await preparePaymentFormContext(env, company, partnerId, amount, currency, { sale_order_id: order.ids[0]! });
  return {
    ...formCtx,
    payment_amount: paymentAmount,
    show_amount_input: !paymentAmount && !prepaymentAvailable,
    amount: asFloat(amount),
    currency,
    partner_id: partnerId,
    transaction_route: await salePortalUrl(order, "/transaction"),
    landing_route: await salePortalUrl(order),
    access_token: await ensureOrderToken(order),
  };
}

/**
 * sale/controllers/portal.py:172-201: a public or portal visitor with the access token on a quotation (draft or sent),
 * once per day and session (`view_quote_<id>` holds `fields.Date.today()`, the server's UTC date): the note "Quotation
 * viewed by customer <name>" in the request's language (`self.env._`; the `context` local there is unused), posted as
 * the superuser with the `sale.mt_order_viewed` subtype. The author named is the order's customer for the public user,
 * else the visitor's own partner.
 */
async function quotationViewedNote(ctx: RequestContext, env: Environment, order: PyRecords): Promise<void> {
  const id = order.ids[0]!;
  const today = (await dbNow(env)).toISOString().slice(0, 10);
  const key = `view_quote_${id}`;
  if (ctx.session[key] === today) return;
  ctx.session[key] = today;
  const authorPartner = await isPublicUser(env, env.uid)
    ? ((await order.field("partner_id")) as PyRecords).ids[0]
    : (await env.sudo().cr.query<{ partner_id: number }>("SELECT partner_id FROM res_users WHERE id = $1", [env.uid])).rows[0]?.partner_id;
  const name = authorPartner
    ? (await env.cr.query<{ name: string | null }>("SELECT name FROM res_partner WHERE id = $1", [authorPartner])).rows[0]?.name ?? false
    : false;
  // `"…%s" % author.name`: Python formats False (no partner, or a partner without name) as "False"
  const body = translate(env, "Quotation viewed by customer %s", "sale").replace("%s", name === false || name === null ? "False" : String(name));
  const post = lookupMethod("sale.order", "message_post");
  if (post === null) throw new NotPorted("sale.order.message_post (the 'Quotation viewed by customer' note)");
  const su = env.withUser(1).sudo();
  // the request's own flush (its environment is the visitor's) writes what the superuser's writes left clean: the
  // message's subject (mail.mail `_inherits`) and the customer's signup fields get the visitor's write_uid
  // (models.py:4008-4010, src/orm/recompute.ts deferredFlush)
  await deferredFlush(su, env.uid, () => post.fn(su, [id], [], { body, message_type: "notification", subtype_xmlid: "sale.mt_order_viewed" }, "sale.order"));
}

route("/my/orders/<int:order_id>", async (ctx: RequestContext, params) => {
  const env = await ctx.orm();
  const id = Number(params["order_id"]);
  const q = ctx.url.searchParams;
  const token = q.get("access_token");
  let order: PyRecords;
  try {
    order = await documentCheckAccess(env, "sale.order", id, token);
  } catch (e) {
    if (e instanceof AccessError || e instanceof MissingError) return ctx.redirect("/my"); // request.redirect: werkzeug's redirect page with the 303
    throw e;
  }
  // portal/controllers/portal.py:1097 `_document_check_access` returns `document.with_user(SUPERUSER_ID)`
  order = new PyRecords(env.withUser(1).sudo(), "sale.order", order.ids);
  frontendLangCookie(ctx, env);
  for (const k of ["payment_amount", "payment_token"]) {
    if (q.get(k)) throw new NotPorted(`/my/orders with ${k}`);
  }
  const [excl, incl] = await advantages(order);
  const reportType = q.get("report_type");
  if (reportType === "text") throw new NotPorted(`/my/orders with report_type=${reportType}`);
  if (reportType === "html" || reportType === "pdf") {
    const company = (await order.field("company_id")) as PyRecords;
    const su = company.ids.length
      ? env.sudo().withContext({ ...env.context, allowed_company_ids: [company.ids[0]!] })
      : env.sudo();
    if (reportType === "html") {
      const html = await renderReportHtml(su, "sale.report_saleorder", [id], { report_type: "html" });
      return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
    }
    if (!pdfEngineOf(ctx.env, ctx.db)) throw new NotPorted("/my/orders with report_type=pdf");
    const pdf = await renderReportPdfInRequest(su, "sale.report_saleorder", [id]);
    const baseName = `${String(await order.field("type_name"))} ${String(await order.field("name"))}`.replace(/\W+/g, "_");
    // portal.py:1162 `if report_type == 'pdf' and download`: any non-empty string is true ("0" and "false" too)
    const download = Boolean(q.get("download"));
    const disposition = download
      ? contentDispositionAttachment(`${baseName}.pdf`)
      : contentDispositionAttachment(`${baseName}.pdf`).replace(/^attachment;/, "inline;");
    return new Response(pdf, { status: 200, headers: { "Content-Type": "application/pdf", "Content-Length": String(pdf.length), "Content-Disposition": disposition } });
  }
  const state = String(await order.field("state"));
  const user = await env.cr.query<{ share: boolean | null }>("SELECT share FROM res_users WHERE id = $1", [env.uid]);
  if (user.rows[0]?.share && token && ctx.request.headers.get("Odoo-Link-Preview") !== "True" && ["draft", "sent"].includes(state)) {
    await quotationViewedNote(ctx, env, order);
  }
  const actionId = (await env.cr.query<{ res_id: number }>("SELECT res_id FROM ir_model_data WHERE module = 'sale' AND name = 'action_quotations_with_onboarding'")).rows[0]!.res_id;
  const lang = await (async () => {
    const p = (await order.field("partner_id")) as PyRecords;
    const l = await p.field("lang");
    // res_partner.py `_compute_is_public`: a partner of the public user
    const isPublic = (await env.cr.query("SELECT 1 FROM res_users u JOIN ir_model_data d ON d.res_id = u.id AND d.model = 'res.users' AND d.module = 'base' AND d.name = 'public_user' WHERE u.partner_id = $1", [p.ids[0]])).rows.length > 0;
    return l && !isPublic ? String(l) : env.lang ?? "en_US";
  })();
  // sale/controllers/portal.py:206 `order_sudo.with_context(lang=order_sudo._get_lang())`: only the `sale_order` value
  // reads in the customer's language; the page itself (and `object`, `res_company`) stays in the request's
  if (lang !== "en_US") await ensureRegistryLang(env.cr, env.reg, lang);
  const orderInLang = lang === (order.env.lang ?? "en_US") ? order
    : new PyRecords(order.env.withContext({ ...order.env.context, lang }), "sale.order", order.ids);
  const percent = num(await order.field("prepayment_percent"));
  const prepaymentAvailable = Boolean(percent && percent < 1.0);
  const values: Record<string, unknown> = {
    sale_order: orderInLang, product_documents: await productDocuments(order), message: q.get("message") ?? false, report_type: "html",
    backend_url: `/odoo/action-${actionId}/${id}`, res_company: await order.field("company_id"), payment_amount: null,
    prepayment_available: prepaymentAvailable, advantage_tax_excl: excl, advantage_tax_incl: incl,
  };
  if (await hasToBePaid(order)) {
    const isDownPayment = await determineIsDownPayment(order, q.get("amount_selection"), null);
    Object.assign(values, await salePaymentValues(env, order, isDownPayment, null, prepaymentAvailable));
  } else {
    values["payment_amount"] = null;
  }
  Object.assign(values, { object: order, prev_record: false, next_record: false });
  Object.assign(values, await recordsPager(ctx.session[["draft", "sent", "cancel"].includes(state) ? "my_quotations_history" : "my_orders_history"], order));
  // sale_stock controllers/portal.py:14-23: the outgoing pickings of the order (`order_sudo.picking_ids` filtered by outgoing)
  const deliveries: number[] = [];
  if (order.def.fields.has("picking_ids")) {
    const pickings = (await order.field("picking_ids")) as PyRecords;
    for (const p of pickings.pyIter() as PyRecords[]) {
      const pt = (await p.field("picking_type_id")) as PyRecords;
      if (pt.ids.length && (await pt.field("code")) === "outgoing") deliveries.push(p.ids[0]!);
    }
    Object.assign(values, {
      delivery_orders: new PyRecords(env.sudo(), "stock.picking", deliveries),
      has_info_cards: Boolean(values["has_info_cards"]) || deliveries.length > 0,
    });
  }
  if (token) Object.assign(values, { no_breadcrumbs: false, access_token: token, token });
  for (const k of ["error", "warning", "success", "pid", "hash"]) if (q.get(k)) values[k] = q.get(k);
  const html = await renderPage(ctx, "sale.sale_order_portal_template", values, env);
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}, { auth: "public" });

/**
 * sale_order.py:2726-2741 `_get_product_documents`: the active documents of the lines' products and templates
 * (One2many on res_id with res_model, product_product.py:116, product_template.py:215) attached on quotations, or on
 * orders once confirmed, in product.document `_order` (sequence, name).
 */
async function productDocuments(order: PyRecords): Promise<PyRecords> {
  const state = String(await order.field("state"));
  const ids = (await order.env.cr.query<{ id: number }>(
    `SELECT d.id FROM product_document d JOIN ir_attachment a ON a.id = d.ir_attachment_id
      WHERE d.active AND (d.attached_on_sale = 'quotation' OR ($2 = 'sale' AND d.attached_on_sale = 'sale_order'))
        AND ((a.res_model = 'product.product' AND a.res_id IN (SELECT product_id FROM sale_order_line WHERE order_id = $1 AND product_id IS NOT NULL))
          OR (a.res_model = 'product.template' AND a.res_id IN (SELECT p.product_tmpl_id FROM sale_order_line l JOIN product_product p ON p.id = l.product_id WHERE l.order_id = $1)))
      ORDER BY d.sequence, a.name, d.id`, [order.ids[0], state])).rows.map((r) => r.id);
  return new PyRecords(order.env, "product.document", ids);
}

async function transactionIds(order: PyRecords): Promise<number[]> {
  return (await order.env.cr.query<{ id: number }>("SELECT transaction_id AS id FROM sale_order_transaction_rel WHERE sale_order_id = $1", [order.ids[0]])).rows.map((r) => r.id);
}

// portal_mixin.py:121-148 `get_portal_url` (sale_order.py:1217-1220 access_url '/my/orders/<id>')
registerPyMethod("sale.order", "get_portal_url", async (recs, args, kwargs) => {
  recs.ensureOne();
  for (const k of kwargs.keys()) if (!["report_type", "download", "query_string", "anchor", "suffix"].includes(k)) throw new NotPorted(`sale.order.get_portal_url(${k}=)`);
  const token = await ensureOrderToken(recs);
  const rawSuffix = args[0] ?? kwargs.get("suffix");
  const suffix = rawSuffix ? String(rawSuffix) : "";
  let url = `/my/orders/${recs.ids[0]}${suffix}?access_token=${token}`;
  if (kwargs.get("report_type")) url += `&report_type=${String(kwargs.get("report_type"))}`;
  if (kwargs.get("download")) url += "&download=true";
  // portal_mixin.py:141-144: `query_string.lstrip('&')` joined with '&', as the generic portalUrl (portal_invoice.ts)
  if (kwargs.get("query_string")) url += `&${String(kwargs.get("query_string")).replace(/^&+/, "")}`;
  if (kwargs.get("anchor")) url += `#${String(kwargs.get("anchor"))}`;
  return url;
});

// sale_order.py:2383-2403 `_has_to_be_signed`
registerPyMethod("sale.order", "_has_to_be_signed", async (recs) => {
  recs.ensureOne();
  return hasToBeSigned(recs);
});

// sale_order.py:2745-2761 `_is_partially_paid`
registerPyMethod("sale.order", "_is_partially_paid", async (recs) => {
  recs.ensureOne();
  if (String(await recs.field("state")) === "cancel") return false;
  const txIds = await transactionIds(recs);
  if (!txIds.length) return false;
  const paidRow = (await recs.env.sudo().cr.query<{ s: number }>(
    "SELECT COALESCE(sum(amount), 0)::float8 AS s FROM payment_transaction WHERE id = ANY($1::int[]) AND state IN ('authorized', 'done')", [txIds],
  )).rows[0];
  const paid = paidRow?.s ?? 0;
  const total = num(await recs.field("amount_total"));
  const currency = (await recs.field("currency_id")) as PyRecords;
  const rounding = num(await currency.field("rounding")) || 0.01;
  return floatCompare(paid, 0, rounding) > 0 && floatCompare(paid, total, rounding) < 0;
});

// sale_order.py:2609-2619 `_get_prepayment_required_amount`
registerPyMethod("sale.order", "_get_prepayment_required_amount", async (recs) => {
  recs.ensureOne();
  return (await prepaymentRequiredAmount(recs)).py;
});

// sale_order.py:2316-2318 `get_portal_last_transaction`
registerPyMethod("sale.order", "get_portal_last_transaction", async (recs) => {
  recs.ensureOne();
  const txIds = await transactionIds(recs);
  if (!txIds.length) return new PyRecords(recs.env.sudo(), "payment.transaction", []);
  const last = (await recs.env.sudo().cr.query<{ id: number }>(
    "SELECT id FROM payment_transaction WHERE id = ANY($1::int[]) ORDER BY (state != 'draft') DESC, id DESC LIMIT 1", [txIds],
  )).rows[0];
  return new PyRecords(recs.env.sudo(), "payment.transaction", last ? [last.id] : []);
});

// sale_order.py:2434-2449
registerPyMethod("sale.order", "_get_name_portal_content_view", async () => "sale.sale_order_portal_content");
registerPyMethod("sale.order", "_get_name_tax_totals_view", async () => "sale.document_tax_totals");

// sale_order_line.py:2323-2330 `_can_be_edited_on_portal` + sale_management :79-92 + sale_loyalty :177
registerPyMethod("sale.order.line", "_can_be_edited_on_portal", async (recs) => {
  recs.ensureOne();
  const order = (await recs.field("order_id")) as PyRecords;
  if (!["draft", "sent"].includes(String(await order.field("state")))) return false;
  if (recs.def.fields.has("combo_item_id") && ((await recs.field("combo_item_id")) as PyRecords).ids.length) return false;
  const product = (await recs.field("product_id")) as PyRecords;
  if (product.ids.length) {
    const company = (await recs.field("company_id")) as PyRecords;
    const discProd = company.ids.length && company.def.fields.has("sale_discount_product_id")
      ? ((await company.field("sale_discount_product_id")) as PyRecords) : null;
    if (discProd && discProd.ids.length && discProd.ids[0] === product.ids[0]) return false;
  }
  const isExpense = recs.def.fields.has("is_expense") && Boolean(await recs.field("is_expense"));
  const reinvPolicy = product.ids.length && product.def.fields.has("reinvoice_policy") ? await product.field("reinvoice_policy") : false;
  const qtyMethod = recs.def.fields.has("qty_delivered_method") ? await recs.field("qty_delivered_method") : false;
  if (!isExpense && reinvPolicy !== "no" && qtyMethod !== "manual") return false;
  if (recs.def.fields.has("is_optional")) {
    const parent = (await recs.field("parent_id")) as PyRecords;
    if (!parent.ids.length) return false;
    if (!(await parent.field("is_optional"))) {
      if ((await parent.field("display_type")) !== "line_subsection") return false;
      const grand = (await parent.field("parent_id")) as PyRecords;
      if (!grand.ids.length || !(await grand.field("is_optional"))) return false;
    }
  }
  if (recs.def.fields.has("is_reward_line") && Boolean(await recs.field("is_reward_line"))) return false;
  return true;
});

// sale_order_line.py:2209-2211 `_get_discounted_price`
registerPyMethod("sale.order.line", "_get_discounted_price", async (recs) => {
  recs.ensureOne();
  return num(await recs.field("price_unit")) * (1 - num(await recs.field("discount")) / 100.0);
});

// sale_stock sale_order.py:265-275 `_is_portal_return_allowed`
registerPyMethod("sale.order", "_is_portal_return_allowed", async (recs) => {
  recs.ensureOne();
  const company = (await recs.field("company_id")) as PyRecords;
  if (!(await company.field("allow_spontaneous_returns"))) return false;
  const effectiveDate = await recs.field("effective_date");
  if (String(await recs.field("state")) !== "sale" || !effectiveDate) return false;
  const days = num(await company.field("return_validity_days"));
  const cutoff = new Date((await dbNow(recs.env)).getTime() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  return String(effectiveDate) >= cutoff;
});

// sale_order.py:1110-1117 `_compute_is_expired` (context_today)
defineComputes("sale.order", {
  is_expired: async (env, rec) => {
    if (!["draft", "sent"].includes(String(await rec.get("state")))) return false;
    const validity = await rec.get("validity_date");
    if (!validity) return false;
    const today = todayInTz(await dbNow(env), await envTz(env));
    return String(validity) < today;
  },
});
