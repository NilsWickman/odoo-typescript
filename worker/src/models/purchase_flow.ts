/**
 * New purchase orders and their lines (odoo/addons/purchase/models/purchase_order.py and purchase_order_line.py, with
 * purchase_stock): the line's shared compute `_compute_price_unit_and_date_planned_and_name` (:545-606) over the vendor
 * selection of product_product.py:1258-1313, the product onchange (:506-535), taxes (:192-197) and labels (:609-633).
 * Other currencies, other tax modes and units that need a quantity conversion refuse with NotPorted.
 */
import { PrivateRecords } from "../orm/private_hooks";
import { NotPorted, UserError } from "../errors";
import { registerMethod } from "../http/methods";
import { onchangeCall } from "../web/onchange";
import { floatRound } from "../orm/convert";
import { and, cond } from "../orm/domain";
import { registerHooks } from "../orm/hooks";
import { DbRec, NewRec, preciseDatetime, registerDefaults, registerOnchange, registerRecordCompute, type Rec } from "../orm/recompute";
import { ensureRegistryLang } from "../orm/registry";
import { plainNumber, PreciseDatetime } from "../orm/values";
import { envTz, hasGroup } from "../orm/env";
import type { Environment } from "../orm/types";
import { registerOverrides, write } from "../orm/write";
import { fiscalPositionFor } from "./sale_computes";
import { adaptToDocumentTaxMode, analyticDistribution, analyticPrecision, mapTax, nextByCode, taxesOfCompany, uomPrice, uomQuantity } from "./sale_flow";
import { defineComputes, withCompany } from "./tail_util";
import { dbNow, todayInTz, translate } from "./util";
import { contextToday, postNote } from "./stock_engine";
import { pyPercent } from "./ir_fields_converter";
import { escapeText } from "../mail/message";
import { pyFloatRepr as pyFloat } from "../http/json";
import { copy } from "../web/save";
import { envFor } from "../web/common";
import { withDbErrors } from "../orm/sql_errors";
import { conversionRate, convertAmount } from "./currency_convert";
import * as priv from "../orm/dispatch_gen";

const idOf = (v: unknown): number | null => (typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : null);

export interface Seller {
  id: number; partner_id: number; company_id: number | null; product_id: number | null; sequence: number; min_qty: number;
  price: number; discount: number; date_start: string | null; date_end: string | null; uom_id: number; delay: number;
  currency_id: number; product_name: string | null; product_code: string | null;
  /** the last confirmed order line acting as a vendor pricelist (lastPoSeller): no supplierinfo record */
  lastPo?: boolean;
}

/** product.supplierinfo of the template in `_order` (sequence, min_qty DESC, price, id), which is the order of `_prepare_sellers`. */
async function sellersOf(env: Environment, product: Rec): Promise<(Seller & { partner_active: boolean })[]> {
  return (await env.cr.query<Seller & { partner_active: boolean }>(
    `SELECT s.id, s.partner_id, s.company_id, s.product_id, s.sequence, s.min_qty::float8 AS min_qty, s.price::float8 AS price,
            COALESCE(s.discount, 0)::float8 AS discount, s.date_start::text AS date_start, s.date_end::text AS date_end, s.uom_id,
            COALESCE(s.delay, 0) AS delay, s.currency_id, s.product_name, s.product_code, COALESCE(p.active, false) AS partner_active
       FROM product_supplierinfo s JOIN res_partner p ON p.id = s.partner_id
      WHERE s.product_tmpl_id = $1 ORDER BY s.sequence, s.min_qty DESC, s.price, s.id`, [idOf(await product.get("product_tmpl_id"))])).rows;
}

/** fields.Date.context_today(timestamp=...): the local date of a UTC datetime string in the user's timezone. */
async function localDate(env: Environment, utc: string | null): Promise<string> {
  const when = utc ? new Date(`${utc.replace(" ", "T")}Z`) : await dbNow(env);
  return todayInTz(when, await envTz(env));
}

function compare(a: number, b: number, digits: number): number {
  if (a === b) return 0;
  const delta = floatRound(a, digits) - floatRound(b, digits);
  if (floatRound(delta, digits) === 0) return 0;
  return delta < 0 ? -1 : 1;
}

/**
 * purchase/models/product.py:264-273 `_select_seller` without a matching vendor: unless the product has a vendor
 * pricelist for the partner and company (`_has_vendor_pricelist` :204-212: any supplierinfo, active partner or not,
 * dated or not), the last confirmed order line acts as one (`_get_last_po_seller_info` :214-255): the last order in
 * state purchase with an approval date (by date_approve desc, id desc) of the vendor (child_of the partner's
 * parent or the partner) in the company, its last line of the product; the delay is the days from the approval to
 * the line's planned date. `lastPo` marks it (no supplierinfo record).
 */
async function lastPoSeller(env: Environment, product: Rec, partner: number | null, parent: number | null, company: number): Promise<Seller | null> {
  const tmpl = idOf(await product.get("product_tmpl_id"));
  const has = (await env.cr.query(
    `SELECT 1 FROM product_supplierinfo s WHERE s.product_tmpl_id = $1 AND (s.product_id IS NULL OR s.product_id = $2)
        AND (s.company_id IS NULL OR s.company_id = $3) AND ($4::int IS NULL OR s.partner_id = $4 OR s.partner_id = $5) LIMIT 1`,
    [tmpl, product.origin, company, partner, parent])).rows.length > 0;
  if (has) return null;
  const vendor = parent ?? partner;
  const order = (await env.cr.query<{ id: number; approve: string; partner_id: number; partner_parent: number | null }>(
    `SELECT o.id, (o.date_approve)::date::text AS approve, o.partner_id, p.parent_id AS partner_parent FROM purchase_order o JOIN res_partner p ON p.id = o.partner_id
      WHERE o.state = 'purchase' AND o.date_approve IS NOT NULL AND o.company_id = $2
        AND EXISTS (SELECT 1 FROM purchase_order_line l WHERE l.order_id = o.id AND l.product_id = $1)
        AND ($3::int IS NULL OR o.partner_id IN (WITH RECURSIVE c(id) AS (SELECT $3::int UNION SELECT p.id FROM res_partner p JOIN c ON p.parent_id = c.id) SELECT id FROM c))
      ORDER BY o.date_approve DESC, o.id DESC LIMIT 1`, [product.origin, company, vendor])).rows[0];
  if (!order) return null;
  const line = (await env.cr.query<{ price: number; discount: number | null; currency_id: number; uom_id: number; planned: string | null }>(
    `SELECT l.price_unit::float8 AS price, l.discount::float8 AS discount, o.currency_id, l.uom_id, (l.date_planned)::date::text AS planned
       FROM purchase_order_line l JOIN purchase_order o ON o.id = l.order_id WHERE l.order_id = $1 AND l.product_id = $2 ORDER BY l.id DESC LIMIT 1`, [order.id, product.origin])).rows[0]!;
  const days = line.planned ? Math.round((Date.parse(line.planned) - Date.parse(order.approve)) / 86400000) : 0;
  return {
    id: 0, lastPo: true, partner_id: order.partner_parent ?? order.partner_id, company_id: null, product_id: null, sequence: 0, min_qty: 0,
    price: line.price, discount: line.discount ?? 0, date_start: null, date_end: null, uom_id: line.uom_id, delay: Math.max(0, days),
    currency_id: line.currency_id, product_name: null, product_code: null,
  };
}

/** purchase_order_line.py:917-931 `_get_seller_info` over product_product.py:1262-1313 `_select_seller` (purchase/models/product.py:283-286). */
async function sellerInfo(env: Environment, line: Rec, product: Rec): Promise<Seller | null> {
  const order = await line.rel("order_id");
  const orderCompany = order ? idOf(await order.get("company_id")) : null;
  const partner = idOf(await line.get("partner_id"));
  const dateOrder = order ? await order.get("date_order") : null;
  const date = await localDate(env, typeof dateOrder === "string" ? dateOrder : null);
  return selectSeller(env, product, {
    company: orderCompany ?? await env.company(), partner, date, quantity: Math.abs(Number((await line.get("product_qty")) ?? 0)),
    uom: idOf(await line.get("uom_id")), forceUom: true, params: { order_id: order, force_uom: true },
  });
}

/**
 * The `params` of a `_select_seller` call, in the order of Odoo's dict literal: `order_id` the purchase order of
 * `{'order_id': order, ...}` (purchase_order_line.py:917-922, purchase_order.py:1275-1282), `force_uom` its value when
 * the call gives one (None: `values.get('force_uom')` of a procurement without it); false: no params.
 */
export type SellerParams = false | { readonly order_id?: Rec | null; readonly force_uom?: unknown };

/**
 * product_product.py:1258-1260 `_prepare_sellers(params)` through callPrivate (private_hooks.json): the hand is
 * `_get_filtered_supplier` (product_supplierinfo.py:143-145 with purchase's company of the order, product.py:283-286,
 * done by the caller's `company`) and the sort, `prepared`. A site's override filters them (purchase_requisition: the
 * order's agreement, mrp_subcontracting: the subcontractors), passing `params` on unchanged. A new order (a form)
 * cannot be given to compiled code: refused where an override would run.
 */
async function prepareSellers(env: Environment, product: Rec, prepared: readonly (Seller & { partner_active: boolean })[], params: SellerParams): Promise<(Seller & { partner_active: boolean })[]> {
  let py: false | Record<string, unknown> = false;
  if (params) {
    py = {};
    for (const [k, v] of Object.entries(params)) {
      if (k !== "order_id") { py[k] = v; continue; }
      const order = v as Rec | null;
      if (!order) { py[k] = new PrivateRecords("purchase.order", []); continue; }
      if (order instanceof NewRec || order.origin === null || order.origin === undefined) {
        if (await priv.product_product._prepare_sellers.overridden(env)) throw new NotPorted("product.product._prepare_sellers of a new purchase order (a form) on a site with an override");
        py[k] = null;
        continue;
      }
      py[k] = new PrivateRecords("purchase.order", [order.origin]);
    }
  }
  const out = await priv.product_product._prepare_sellers.call(env, [product.origin!], [py],
    async () => new PrivateRecords("product.supplierinfo", prepared.map((s) => s.id)));
  const ids = out instanceof PrivateRecords ? out.ids : Array.isArray(out) ? out as number[] : null;
  if (!ids) throw new NotPorted("product.product._prepare_sellers() returned something else than supplierinfo records");
  const byId = new Map(prepared.map((s) => [s.id, s]));
  return ids.map((id) => {
    const s = byId.get(id);
    if (!s) throw new NotPorted("product.product._prepare_sellers() returned a vendor pricelist outside the prepared ones");
    return s;
  });
}

/**
 * product_product.py:1262-1313 `_get_filtered_sellers` and `_select_seller` with `self.env.company` = `company`; `date`
 * null means "no seller has a date range" was required by the caller (the date then cannot matter).
 */
export async function selectSeller(env: Environment, product: Rec, o: { company: number; partner: number | null; date: string | null; quantity: number | null; uom: number | null; forceUom: boolean; envCompany?: number; params: SellerParams }): Promise<Seller | null> {
  const { company, partner, date, quantity, uom } = o;
  const parent = partner ? (await env.cr.query<{ p: number | null }>("SELECT parent_id AS p FROM res_partner WHERE id = $1", [partner])).rows[0]?.p ?? null : null;
  const productUom = idOf(await product.get("uom_id"));
  const digits = (await env.cr.query<{ digits: number }>("SELECT digits FROM decimal_precision WHERE name = 'Product Unit'")).rows[0]!.digits;
  const found: Seller[] = [];
  const prepared = (await sellersOf(env, product)).filter((s) => (!s.company_id || s.company_id === company) && s.partner_active
    && (!s.product_id || s.product_id === product.origin));
  for (const s of await prepareSellers(env, product, prepared, o.params)) {
    // :1271-1274 the quantity in the seller's unit
    const quantitySeller = quantity && uom && uom !== s.uom_id ? await uomQuantity(env, quantity, uom, s.uom_id) : quantity;
    // product_product.py:1283 `quantity is not None and float_compare(...)`: no quantity, no minimum
    if (date === null && (s.date_start || s.date_end)) throw new NotPorted("vendor selection by date without the procurement date");
    if (date !== null && s.date_start && s.date_start > date) continue;
    if (date !== null && s.date_end && s.date_end < date) continue;
    if (o.forceUom && s.uom_id !== uom && s.uom_id !== productUom) continue; // params force_uom (purchase_order_line.py:917-922)
    if (partner && s.partner_id !== partner && s.partner_id !== parent) continue;
    if (quantitySeller !== null && compare(quantitySeller, s.min_qty, digits) === -1) continue;
    found.push(s);
  }
  const first = found[0];
  if (!first) return lastPoSeller(env, product, partner, parent, company);
  const same = found.filter((s) => s.partner_id === first.partner_id);
  if (same.length === 1) return first;
  // :1297-1306 sort_function: `price_discounted` (product_supplierinfo.py:71-75, in the product's unit) converted
  // unrounded to the environment company's currency at the caller's `date`; the callers that pass null here call
  // `_select_seller` without a date (purchase_stock stock_rule.py:185 and the replenishment reports), and
  // res_currency.py:345-355 converts on `fields.Date.context_today` then
  const envCompany = o.envCompany ?? await env.company();
  const currency = (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [envCompany])).rows[0]!.c;
  const keyed: { s: Seller; price: number }[] = [];
  for (const s of same) {
    const discounted = (await uomPrice(env, s.price, s.uom_id, productUom)) * (1 - s.discount / 100);
    const price = s.currency_id === currency || !discounted ? discounted
      : discounted * await conversionRate(env, s.currency_id, currency, envCompany, date ?? await contextToday(env));
    keyed.push({ s, price });
  }
  keyed.sort((a, b) => a.price - b.price || a.s.sequence - b.s.sequence || a.s.id - b.s.id);
  return keyed[0]!.s;
}

async function vendorLangEnv(env: Environment, partner: Rec | null): Promise<Environment> {
  const lang = partner ? await partner.get("lang") : null;
  if (typeof lang !== "string" || !lang || lang === (env.lang ?? "en_US")) return env;
  await ensureRegistryLang(env.cr, env.reg, lang);
  return env.withContext({ ...env.context, lang });
}

/** purchase_order_line.py:763-775 `_get_product_purchase_description`, in the vendor's language. */
async function purchaseDescription(env: Environment, line: Rec, product: Rec): Promise<string> {
  const partner = await line.rel("partner_id");
  const venv = await vendorLangEnv(env, partner);
  if (((await line.get("product_no_variant_attribute_value_ids")) as unknown[] | null)?.length) throw new NotPorted("purchase.order.line description with no-variant attributes");
  const prodRec = venv !== env && product.origin !== null ? new DbRec(venv, product.def, product.origin) : product;
  const description = await prodRec.get("description_purchase");
  return typeof description === "string" ? description : "";
}

async function supplierTaxes(env: Environment, product: Rec, company: number | null): Promise<Rec[]> {
  return taxesOfCompany(env, await product.rels("supplier_taxes_id"), company ?? await env.company());
}

/** account_tax.py:4983-4999 `_fix_tax_included_price_company`. */
async function fixIncludedPrice(env: Environment, line: Rec, product: Rec, price: number, company: number): Promise<number> {
  const lineTaxes = new Set(((await line.get("tax_ids")) as unknown[] | null ?? []).map(idOf));
  const taxes = ((await product.rels("supplier_taxes_id")).map((t) => t.origin!)).filter((t) => !lineTaxes.has(t));
  if (!taxes.length) return price;
  const mode = await line.get("document_tax_mode");
  const rows = (await env.cr.query<{ o: string | null }>(
    `SELECT t.price_include_override AS o FROM account_tax t
      WHERE t.id = ANY($1::int[]) AND t.company_id = $2
        AND NOT EXISTS(SELECT 1 FROM account_tax_repartition_line r WHERE r.tax_id = t.id AND r.repartition_type = 'tax' AND r.factor_percent < 0)`, [taxes, company])).rows;
  if (rows.some((r) => (r.o ? r.o === "tax_included" : mode === "tax_included"))) throw new NotPorted("purchase.order.line price without its included taxes (_fix_tax_included_price)");
  return price;
}

interface LineBlock { date_planned: unknown; name: unknown; discount: unknown; price_unit: number; technical_price_unit: number }

/** purchase_order_line.py:545-606 _compute_price_unit_and_date_planned_and_name, from the values before the compute. */
async function lineBlock(env: Environment, line: Rec): Promise<LineBlock> {
  const before = async (name: string): Promise<unknown> => (line instanceof NewRec && line.values.has(name) ? line.values.get(name) : line.prev(name));
  const out: LineBlock = {
    date_planned: await before("date_planned"), name: await before("name"), discount: await before("discount"),
    price_unit: Number((await before("price_unit")) ?? 0), technical_price_unit: Number((await before("technical_price_unit")) ?? 0),
  };
  const product = await line.rel("product_id");
  const company = idOf(await line.get("company_id"));
  if (!product || !company || env.context["skip_uom_conversion"] || out.technical_price_unit !== out.price_unit) return out;
  if (((await line.get("invoice_lines")) as unknown[] | null)?.length) return out;
  const seller = await sellerInfo(env, line, product);
  if (seller || !out.date_planned) {
    const order = await line.rel("order_id");
    const dateOrder = order ? await order.get("date_order") : null;
    const from = typeof dateOrder === "string" ? new Date(`${dateOrder.replace(" ", "T")}Z`) : await dbNow(env);
    out.date_planned = new Date(from.getTime() + (seller?.delay ?? 0) * 86400000).toISOString().slice(0, 19).replace("T", " ");
  }
  if (!out.name) out.name = await purchaseDescription(env, line, product);
  const uom = idOf(await line.get("uom_id"));
  const productUom = idOf(await product.get("uom_id"));
  const mode = await line.get("document_tax_mode");
  const currency = idOf(await line.get("currency_id"));
  // :582-588, :593-598 `_adapt_price_unit_to_document_tax_mode(price, product.supplier_taxes_id, ...)`: the product's
  // supplier taxes of every company, unfiltered (src/models/sale_flow.ts adaptToDocumentTaxMode, the tax engine)
  const finish = async (price: number): Promise<void> => {
    out.price_unit = out.technical_price_unit = await adaptToDocumentTaxMode(env, product, await product.rels("supplier_taxes_id"), mode, price);
  };
  // :585-590, :597-602 `_convert(price, line.currency_id, company, line.date_order or context_today, round=False)`
  const convertDate = async (): Promise<string> => {
    const d = await line.get("date_order");
    return typeof d === "string" && d ? d.slice(0, 10) : localDate(env, null);
  };
  if (seller) {
    let price = await fixIncludedPrice(env, line, product, seller.price, company);
    if (currency && seller.currency_id !== currency) price = await convertAmount(env, price, seller.currency_id, currency, company, await convertDate(), false);
    await finish(await uomPrice(env, price, seller.uom_id, uom));
    out.discount = seller.discount;
    return out;
  }
  const origin = line instanceof NewRec ? line.originRec : line;
  const sameUom = uom === (origin ? idOf(await origin.get("uom_id")) : null);
  const partner = idOf(await line.get("partner_id"));
  const samePartner = partner === (origin ? idOf(await origin.get("partner_id")) : null);
  if (out.price_unit && sameUom && samePartner) {
    const sellers = await sellersOf(env, product);
    const parent = partner ? (await env.cr.query<{ p: number | null }>("SELECT parent_id AS p FROM res_partner WHERE id = $1", [partner])).rows[0]?.p ?? null : null;
    // purchase/models/product.py:204-212 `_has_vendor_pricelist`
    const has = sellers.some((s) => (!s.product_id || s.product_id === product.origin) && (!s.company_id || s.company_id === company)
      && (!partner || s.partner_id === partner || s.partner_id === parent));
    if (!has) return out;
  }
  out.discount = 0;
  const cost = await uomPrice(env, Number((await product.get("standard_price")) ?? 0), productUom, uom ?? productUom);
  const from = idOf(await product.get("cost_currency_id"));
  let fixed = await fixIncludedPrice(env, line, product, cost, company);
  if (from && currency && from !== currency) fixed = await convertAmount(env, fixed, from, currency, company, await convertDate(), false);
  await finish(fixed);
  return out;
}

/** The fields of the block other than `own` go into the cache of a new line; a stored line refuses to move them. */
async function blockField(env: Environment, line: Rec, own: keyof LineBlock): Promise<unknown> {
  const block = await lineBlock(env, line);
  if (line instanceof NewRec) {
    for (const key of Object.keys(block) as (keyof LineBlock)[]) if (key !== own) line.put(key, block[key]);
    return block[own];
  }
  if (Number(await line.prev("price_unit")) !== block.price_unit) throw new NotPorted("purchase.order.line price recompute of a stored line");
  return block[own];
}

/** purchase_order_line.py:190-197 `_compute_tax_id`. */
async function computeLineTaxes(env: Environment, line: NewRec): Promise<void> {
  const product = await line.rel("product_id");
  const company = idOf(await line.get("company_id"));
  const order = await line.rel("order_id");
  let position = order ? await order.rel("fiscal_position_id") : null;
  const partner = order ? idOf(await order.get("partner_id")) : null;
  if (!position && partner && company) {
    const found = await fiscalPositionFor(env, company, partner, null);
    if (found) position = new DbRec(env, env.reg.model("account.fiscal.position"), found);
  }
  await line.set("tax_ids", product ? await mapTax(position, await supplierTaxes(env, product, company)) : []);
}

/** purchase_order_line.py:261-271 `_prepare_qty_invoiced`: bills add, refunds subtract, cancelled moves do not count. */
async function qtyInvoiced(env: Environment, rec: Rec): Promise<number> {
  if (env.context["accrual_entry_date"] || env.context["excluded_aml_ids"]) throw new NotPorted("purchase.order.line.qty_invoiced at an accrual date or with excluded lines");
  if (rec.id === null) {
    if (((await rec.get("invoice_lines")) as unknown[] | null)?.length) throw new NotPorted("purchase.order.line.qty_invoiced of a new line with bills");
    return 0;
  }
  const lines = (await env.cr.query<{ quantity: number; uom: number | null; move_type: string; state: string; payment_state: string | null }>(
    `SELECT l.quantity::float8 AS quantity, l.product_uom_id AS uom, m.move_type, m.state, m.payment_state
       FROM account_move_line l JOIN account_move m ON m.id = l.move_id WHERE l.purchase_line_id = $1 ORDER BY l.id`, [rec.id])).rows;
  const lineUom = idOf(await rec.get("uom_id"));
  let total = 0;
  for (const l of lines) {
    if (l.state === "cancel" && l.payment_state !== "invoicing_legacy") continue;
    const qty = l.uom === lineUom ? l.quantity : await uomQuantity(env, l.quantity, l.uom, lineUom, "UP");
    if (l.move_type === "in_invoice") total += qty;
    else if (l.move_type === "in_refund") total -= qty;
  }
  return total;
}

/** purchase_order_line.py:880-891 `_track_qty_received`: purchase.track_po_line_qty_received_template on the order (mt_note). */
async function trackQtyReceived(env: Environment, rec: Rec, order: number, before: number, after: number): Promise<void> {
  const product = idOf(await rec.get("product_id"));
  const display = product ? (await env.model("product.product").displayName([product])).get(product) ?? "" : "";
  const esc = (v: string): string => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const heading = esc(translate(env, "The received quantity has been updated.", "purchase"));
  const qtyLabel = esc(translate(env, "Received Quantity:", "purchase"));
  const body = `<div>\n            <strong>${heading}</strong>\n            <ul>\n                <li>${esc(display)}:</li>\n                ${qtyLabel} ${pyFloat(before)} -&gt; ${pyFloat(after)}<br>\n            </ul>\n        </div>`;
  const deferred = DEFERRED_NOTES.get(env.cr);
  if (deferred) deferred.push(() => postNote(env, "purchase.order", order, body));
  else await postNote(env, "purchase.order", order, body);
}

/**
 * Odoo computes `qty_received` lazily: when a transfer gets a backorder, the received-quantity note is posted after
 * the backorder's messages (stock_move.py:2420-2433, the value is read by stock_account's valuation). The port
 * recomputes at the moves' write, so the note waits until `flushDeferredNotes`.
 */
const DEFERRED_NOTES = new WeakMap<object, (() => Promise<void>)[]>();
export function deferNotes(env: Environment): void {
  if (!DEFERRED_NOTES.has(env.cr)) DEFERRED_NOTES.set(env.cr, []);
}
export async function flushDeferredNotes(env: Environment): Promise<void> {
  const list = DEFERRED_NOTES.get(env.cr) ?? [];
  DEFERRED_NOTES.delete(env.cr);
  for (const fn of list) await fn();
}

/**
 * project_purchase purchase_order_line.py:9-29 `_compute_analytic_distribution` over purchase's (:494-505, no
 * distribution models): a line that is not a section or note, of the context's project or the order's, takes the
 * project's accounts (analytic_line.py:61-73 `_get_analytic_distribution`) without a distribution, or adds to each key
 * the project's accounts of the root plans its distribution lacks.
 */
async function purchaseLineAnalyticDistribution(env: Environment, rec: Rec): Promise<unknown> {
  const base = await analyticDistribution(env, rec);
  if (!env.reg.models.get("purchase.order")?.fields.has("project_id")) return base;
  if (await rec.get("display_type")) return base;
  const ctxProject = env.context["project_id"];
  let project: number | null = typeof ctxProject === "number" && ctxProject ? ctxProject : null;
  if (ctxProject !== undefined && ctxProject !== false && ctxProject !== null && project === null) throw new NotPorted(`purchase.order.line analytic distribution with the context's project ${JSON.stringify(ctxProject)}`);
  if (project === null) {
    const order = await rec.rel("order_id");
    project = order ? idOf(await order.get("project_id")) : null;
  }
  if (project === null) return base;
  const pf = env.reg.model("project.project").fields;
  const extra = ["x_plan2_id", "x_plan3_id"].filter((f) => pf.has(f));
  const [p] = (await env.cr.query<Record<string, number | null>>(
    `SELECT account_id AS a${extra.map((f) => `, ${f}`).join("")} FROM project_project WHERE id = $1`, [project])).rows;
  if (p && extra.some((f) => p[f])) throw new NotPorted("purchase.order.line.analytic_distribution of a project with accounts in several plans");
  const account = p?.["a"] ?? null;
  const current = base && typeof base === "object" && Object.keys(base).length ? base as Record<string, unknown> : null;
  if (current === null) return account ? { [String(account)]: 100 } : base;
  if (!account) return base;
  const keys = Object.keys(current);
  const ids = [...new Set(keys.flatMap((k) => k.split(",").map((x) => Number(x.trim()))))];
  const roots = new Set((await env.cr.query<{ r: number | null }>(
    "SELECT root_plan_id AS r FROM account_analytic_account WHERE id = ANY($1::int[])", [ids])).rows.map((r) => r.r));
  const own = (await env.cr.query<{ r: number | null }>("SELECT root_plan_id AS r FROM account_analytic_account WHERE id = $1", [account])).rows[0]?.r ?? null;
  if (roots.has(own)) return base;
  return Object.fromEntries(keys.map((k) => [`${k},${account}`, current[k]]));
}

registerRecordCompute("purchase.order.line", {
  date_planned: (env, rec) => blockField(env, rec, "date_planned"),
  name: (env, rec) => blockField(env, rec, "name"),
  discount: (env, rec) => blockField(env, rec, "discount"),
  price_unit: (env, rec) => blockField(env, rec, "price_unit"),
  technical_price_unit: (env, rec) => blockField(env, rec, "technical_price_unit"),
  analytic_distribution: purchaseLineAnalyticDistribution,
  // :649-656 _compute_product_uom_qty
  product_uom_qty: async (env, rec) => {
    const product = await rec.rel("product_id");
    const qty = Number((await rec.get("product_qty")) ?? 0);
    const uom = idOf(await rec.get("uom_id"));
    // uom_uom.py:154 `_compute_quantity` of an empty unit returns the quantity
    if (product && uom && idOf(await product.get("uom_id")) !== uom) throw new NotPorted("purchase.order.line.product_uom_qty in another unit");
    return qty;
  },
  // :292-297 with purchase_stock purchase_order_line.py:40-44
  qty_received_method: async (_env, rec) => {
    const product = await rec.rel("product_id");
    const type = product ? await product.get("type") : null;
    if (type === "consu" && !(await rec.get("display_type"))) return "stock_moves";
    return type === "consu" || type === "service" ? "manual" : false;
  },
  // :300-305 `_compute_qty_received` with purchase_stock :59-87 `_prepare_qty_received` (done moves of the line's product
  // from a supplier or transit location; returns and dropships refuse) and :880-891 `_track_qty_received`
  qty_received: async (env, rec) => {
    const method = await rec.get("qty_received_method");
    if (method !== "stock_moves") {
      const total = method === "manual" ? Number((await rec.get("qty_received_manual")) ?? 0) : 0;
      if (method === "manual" && rec.id !== null && !env.context["accrual_entry_date"]) {
        const before = Number((await rec.prev("qty_received")) ?? 0);
        const order = await rec.rel("order_id");
        if (total !== before && order && (await order.get("state")) === "purchase") {
          await trackQtyReceived(env, rec, order.origin!, before, total);
        }
      }
      return total;
    }
    if (rec.id === null) {
      if (((await rec.get("move_ids")) as unknown[] | null)?.length) throw new NotPorted("purchase.order.line.qty_received of a new line with moves");
      return 0;
    }
    if (env.context["accrual_entry_date"]) throw new NotPorted("purchase.order.line.qty_received at an accrual date");
    const moves = (await env.cr.query<{ quantity: number; uom_id: number; dest_usage: string; src_usage: string; returned: number | null }>(
      `SELECT m.quantity::float8 AS quantity, m.uom_id, d.usage AS dest_usage, s.usage AS src_usage, m.origin_returned_move_id AS returned
         FROM stock_move m JOIN purchase_order_line l ON l.id = m.purchase_line_id JOIN stock_location d ON d.id = m.location_dest_id JOIN stock_location s ON s.id = m.location_id
        WHERE m.purchase_line_id = $1 AND m.product_id = l.product_id AND m.state = 'done' ORDER BY m.id`, [rec.id])).rows;
    const lineUom = idOf(await rec.get("uom_id"));
    let total = 0;
    for (const m of moves) {
      if (m.dest_usage === "supplier" || m.returned) throw new NotPorted("purchase.order.line.qty_received of returned or dropshipped moves");
      if (!["supplier", "transit"].includes(m.src_usage)) continue;
      total += await uomQuantity(env, m.quantity, m.uom_id, lineUom, "HALF-UP");
    }
    const before = Number((await rec.prev("qty_received")) ?? 0);
    const order = await rec.rel("order_id");
    if (total !== before && order && (await order.get("state")) === "purchase") await trackQtyReceived(env, rec, order.origin!, before, total);
    return total;
  },
  // :211-224 `_compute_qty_invoiced` (qty_invoiced and qty_to_invoice) over :261-271 `_prepare_qty_invoiced`
  qty_invoiced: (env, rec) => qtyInvoiced(env, rec),
  qty_to_invoice: async (env, rec) => {
    const order = await rec.rel("order_id");
    if (!order || (await order.get("state")) !== "purchase") return 0;
    const product = await rec.rel("product_id");
    const invoiced = await qtyInvoiced(env, rec);
    if (product && (await product.get("purchase_method")) === "purchase") return Number((await rec.get("product_qty")) ?? 0) - invoiced;
    return Number((await rec.get("qty_received")) ?? 0) - invoiced;
  },
  qty_to_invoice_raw: async (_env, rec) => Number((await rec.get("product_qty")) ?? 0) - Number((await rec.get("qty_invoiced")) ?? 0),
  // :201-204, :206-209
  price_unit_discounted: async (_env, rec) => Number((await rec.get("price_unit")) ?? 0) * (1 - Number((await rec.get("discount")) ?? 0) / 100),
  price_unit_product_uom: async (env, rec) => {
    if ((await rec.get("display_type")) || (await rec.get("is_downpayment"))) return 0;
    const product = await rec.rel("product_id");
    return uomPrice(env, Number((await rec.get("price_unit")) ?? 0), idOf(await rec.get("uom_id")), product ? idOf(await product.get("uom_id")) : null);
  },
});

defineComputes("purchase.order.line", {
  // :338-345
  selected_seller_id: async (env, rec) => {
    const product = await rec.rel("product_id");
    const seller = product ? await sellerInfo(env, rec, product) : null;
    // product.py:243 the fallback's `supplierinfo` is the empty recordset
    return seller && !seller.lastPo ? seller.id : null;
  },
  // :609-622 _compute_label with :635-645 `_get_product_display_name`
  label: async (env, rec) => {
    const name = await rec.get("name");
    if (!(await rec.get("product_id"))) return name;
    const display = await lineProductName(env, rec);
    if (!name) return display;
    return String(name).split(/\r\n|\r|\n/)[0] === display ? name : `${display}\n${String(name)}`;
  },
  // :286-289 _compute_purchase_line_warn_msg
  purchase_line_warn_msg: async (env, rec) => {
    if (!(await hasGroup(env, "purchase.group_warning_purchase"))) return "";
    const product = await rec.rel("product_id");
    return product ? await product.get("purchase_line_warn_msg") : false;
  },
});

/** purchase_order_line.py:635-645 `_get_product_display_name`. */
async function lineProductName(env: Environment, line: Rec): Promise<string> {
  const product = (await line.rel("product_id"))!;
  const partner = await line.rel("partner_id");
  const venv = await vendorLangEnv(env, partner);
  const senv = venv.withContext({ ...venv.context, seller_id: idOf(await line.get("selected_seller_id")) ?? false });
  return (await senv.model("product.product").displayName([product.origin!])).get(product.origin!) ?? "";
}

// :506-531 onchange_product_id, _product_id_change and :745-761 `_suggest_quantity`
async function onchangeProduct(env: Environment, rec: NewRec): Promise<void> {
  const product = await rec.rel("product_id");
  if (!product) return;
  if (env.context["origin_po_id"] && Number((await rec.get("product_qty")) ?? 0)) { await computeLineTaxes(env, rec); return; }
  await rec.set("price_unit", 0);
  await rec.set("product_qty", 0);
  await rec.set("technical_price_unit", 0);
  await rec.set("uom_id", idOf(await product.get("uom_id")));
  await rec.set("name", await purchaseDescription(env, rec, product));
  await computeLineTaxes(env, rec);
  const order = await rec.rel("order_id");
  const dateOrder = order ? await order.get("date_order") : null;
  const date = typeof dateOrder === "string" ? dateOrder.slice(0, 10) : await localDate(env, null);
  const partner = order ? idOf(await order.get("partner_id")) : null;
  const sellers = (await sellersOf(env, product)).filter((s) => s.partner_id === partner && (!s.product_id || s.product_id === product.origin)
    && (!s.date_start || s.date_start <= date) && (!s.date_end || s.date_end >= date)).sort((a, b) => a.min_qty - b.min_qty);
  const first = sellers[0];
  await rec.set("product_qty", first ? first.min_qty || 1 : 1);
  if (first) await rec.set("uom_id", first.uom_id);
}
registerOnchange("purchase.order.line", "onchange_product_id", ["product_id"], onchangeProduct);
// purchase_order_line.py:326-336 `_inverse_qty_received`, an @api.onchange on qty_received
registerOnchange("purchase.order.line", "_inverse_qty_received", ["qty_received"], async (_env, rec) => {
  await rec.set("qty_received_manual", (await rec.get("qty_received_method")) === "manual" ? await rec.get("qty_received") : 0);
});

// purchase purchase_order.py:489-499 `onchange` and purchase_stock purchase_order.py:100-110 above it: the dates of the
// lines that a change of the lines put back on them are not sent. purchase's deletes date_planned when
// `_must_delete_date_planned(field)` holds for one of the fields (through the private hook: purchase_product_matrix
// adds 'grid'); purchase_stock's deletes date_promised when 'order_line' is one of them
registerMethod("purchase.order", "onchange", async (env, ids, args, kwargs, model) => {
  const result = await onchangeCall(env, ids, args, kwargs, model);
  const raw = kwargs["field_names"] ?? args[1];
  const names: unknown[] = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  if (!("value" in result)) return result;
  // `any(self._must_delete_date_planned(field) for field in field_names)`: stops at the first that holds
  let planned = false;
  for (const name of names) {
    const must = await priv.purchase_order._must_delete_date_planned.call(env, [...(ids ?? [])], [name], async (_e, _ids, a) => a[0] === "order_line");
    if (must) { planned = true; break; }
  }
  const promised = names.includes("order_line");
  if (!planned && !promised) return result;
  const lines = (result.value as Record<string, unknown>)["order_line"];
  if (Array.isArray(lines)) {
    for (const cmd of lines) {
      if (Array.isArray(cmd) && cmd[0] === 1 && typeof cmd[2] === "object" && cmd[2] !== null) {
        if (planned) delete (cmd[2] as Record<string, unknown>)["date_planned"];
        if (promised) delete (cmd[2] as Record<string, unknown>)["date_promised"];
      }
    }
  }
  return result;
}, { apiModel: false });

registerRecordCompute("purchase.order", {
  // purchase_stock purchase_order.py:76-78 _compute_dest_address_id
  dest_address_id: async (_env, rec) => {
    const type = await rec.rel("picking_type_id");
    const location = type ? await type.rel("default_location_dest_id") : null;
    if (!location || (await location.get("usage")) !== "customer") return null;
    return rec.prev("dest_address_id");
  },
  // :552-557 _compute_document_tax_mode
  document_tax_mode: async (env, rec) => {
    const mode = await rec.prev("document_tax_mode");
    if (mode) return mode;
    const company = idOf(await rec.get("company_id")) ?? await env.company();
    return (await env.cr.query<{ m: string }>("SELECT account_price_include AS m FROM res_company WHERE id = $1", [company])).rows[0]?.m ?? null;
  },
  // :245-252 _compute_currency_rate: `_get_conversion_rate(company currency, order currency, company,
  // (date_order or now).date())`, the UTC date of the order (src/models/currency_convert.ts)
  currency_rate: async (env, rec) => {
    const company = idOf(await rec.get("company_id"));
    const from = company === null ? null : (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [company])).rows[0]?.c ?? null;
    const to = idOf(await rec.get("currency_id"));
    if (from === to) return 1;
    if (company === null || from === null || to === null) throw new NotPorted("purchase.order.currency_rate without a company or a currency");
    const dateOrder = await rec.get("date_order");
    const date = typeof dateOrder === "string" && dateOrder ? dateOrder.slice(0, 10) : (await dbNow(env)).toISOString().slice(0, 10);
    return conversionRate(env, from, to, company, date);
  },
  // purchase_stock purchase_order.py:61-71 _compute_receipt_status
  receipt_status: async (_env, rec) => {
    const states: string[] = [];
    for (const p of await rec.rels("picking_ids")) states.push(String(await p.get("state")));
    if (!states.length || states.every((st) => st === "cancel")) return null;
    if (states.every((st) => st === "done" || st === "cancel")) return "full";
    if (states.some((st) => st === "done")) return "partial";
    return "pending";
  },
  // :47-51 _compute_effective_date: the last date_done of the done receipts that do not go back to a supplier
  effective_date: async (_env, rec) => {
    let last: string | null = null;
    for (const p of await rec.rels("picking_ids")) {
      if ((await p.get("state")) !== "done") continue;
      const dest = await p.rel("location_dest_id");
      if (dest && (await dest.get("usage")) === "supplier") continue;
      const done = await p.get("date_done");
      if (typeof done === "string" && done && (last === null || done > last)) last = done;
    }
    return last;
  },
  // :327-333 _compute_incoterm_id, :334-339 _compute_incoterm_location
  incoterm_id: async (_env, rec) => {
    const partner = await rec.rel("partner_id");
    return (partner ? idOf(await partner.get("purchase_incoterm_id")) : null) ?? rec.prev("incoterm_id");
  },
  incoterm_location: async (_env, rec) => {
    const partner = await rec.rel("partner_id");
    return (partner ? await partner.get("purchase_incoterm_location") : null) || rec.prev("incoterm_location");
  },
  // :73-78 _compute_invoice
  // computed with invoice_ids by the same method: from the lines' invoice lines, not from the stored invoice_ids
  invoice_count: async (_env, rec) => {
    const out = new Set<number>();
    for (const line of await rec.rels("order_line")) for (const il of await line.rels("invoice_lines")) { const m = idOf(await il.get("move_id")); if (m !== null) out.add(m); }
    return out.size;
  },
  // :50-71 _get_invoiced: only a confirmed order has something to bill
  invoice_status: async (env, rec) => {
    if ((await rec.get("state")) !== "purchase") return "no";
    const digits = (await env.cr.query<{ d: number }>("SELECT digits AS d FROM decimal_precision WHERE name = 'Product Unit'")).rows[0]?.d ?? 2;
    const lines = [];
    for (const l of await rec.rels("order_line")) if (!(await l.get("display_type"))) lines.push(l);
    const zero: boolean[] = [];
    for (const l of lines) zero.push(floatRound(Number((await l.get("qty_to_invoice")) ?? 0), digits) === 0);
    if (zero.some((z) => !z)) return "to invoice";
    if (((await rec.get("invoice_ids")) as unknown[] | null)?.length) return "invoiced";
    return "no";
  },
  // purchase_stock purchase_order.py:80-87 _compute_date_promised
  date_promised: async (_env, rec) => {
    if (!["purchase", "cancel"].includes(String(await rec.get("state")))) return null;
    // the lines' dates as Odoo's cache holds them (a demo line's microseconds, src/orm/recompute.ts preciseDatetime)
    let first: string | PreciseDatetime | null = null;
    const text = (d: string | PreciseDatetime): string => (d instanceof PreciseDatetime ? d.text : d);
    for (const l of await rec.rels("order_line")) {
      if (await l.get("display_type")) continue;
      const d = await preciseDatetime(l, "date_promised");
      if (((typeof d === "string" && d) || d instanceof PreciseDatetime) && (first === null || text(d as string | PreciseDatetime) < text(first))) first = d as string | PreciseDatetime;
    }
    return first;
  },
  // :270-278 _compute_display_name on new orders
  display_name: async (env, rec) => {
    if (rec.id !== null) return (await env.model("purchase.order").displayName([rec.id])).get(rec.id) ?? "";
    const ref = await rec.get("partner_ref");
    return ref ? `${String(await rec.get("name"))} (${String(ref)})` : await rec.get("name");
  },
  // :240-243 _compute_date_calendar_start
  date_calendar_start: async (_env, rec) => rec.get((await rec.get("state")) === "purchase" ? "date_approve" : "date_order"),
});

// purchase_order.py:505-518 onchange_partner_id, in the company of the order
registerOnchange("purchase.order", "onchange_partner_id", ["partner_id", "company_id"], async (env, rec) => {
  const partner = idOf(await rec.get("partner_id"));
  if (!partner) { await rec.set("fiscal_position_id", null); return; }
  const company = idOf(await rec.get("company_id")) ?? await env.company();
  await rec.set("fiscal_position_id", await fiscalPositionFor(env, company, partner, null));
  const cenv = await withCompany(env.sudo(), company);
  const row = (await cenv.model("res.partner").read([partner], ["property_supplier_payment_term_id", "buyer_id"], ""))[0];
  await rec.set("payment_term_id", idOf(row?.["property_supplier_payment_term_id"]));
  const buyer = idOf(row?.["buyer_id"]);
  if (buyer) await rec.set("user_id", buyer);
});
// :431-434 onchange_date_planned
registerOnchange("purchase.order", "onchange_date_planned", ["date_planned"], async (_env, rec) => {
  const date = await rec.get("date_planned");
  if (!date) return;
  for (const line of await rec.rels("order_line")) {
    if (await line.get("display_type")) continue;
    // Odoo assigns on every line (new copies of the stored ones, shown as UPDATE commands): not skipped silently
    if (!(line instanceof NewRec) || line.cascaded) throw new NotPorted("purchase.order date_planned over a stored line");
    await line.set("date_planned", date);
  }
});
// purchase_stock purchase_order.py:89-92 `_onchange_date_promised`
registerOnchange("purchase.order", "_onchange_date_promised", ["date_promised"], async (_env, rec) => {
  const date = await rec.get("date_promised");
  if (!date) return;
  for (const line of await rec.rels("order_line")) {
    if (await line.get("display_type")) continue;
    if (!(line instanceof NewRec) || line.cascaded) throw new NotPorted("purchase.order date_promised over a stored line");
    await line.set("date_promised", date);
  }
});
// purchase_stock purchase_order.py:94-98 `_onchange_company_id` with :378-384 `_get_picking_type`
registerOnchange("purchase.order", "_onchange_company_id", ["company_id"], async (env, rec) => {
  const company = idOf(await rec.get("company_id"));
  const pType = await rec.rel("picking_type_id");
  if (pType && (await pType.get("code")) === "incoming") {
    const wh = await pType.rel("warehouse_id");
    if (!wh || idOf(await wh.get("company_id")) === company) return;
  }
  const T = "stock.picking.type";
  let found = await env.model(T).search(and([cond("code", "=", "incoming"), cond("warehouse_id.company_id", "=", company ?? false)]));
  if (!found.length) found = await env.model(T).search(and([cond("code", "=", "incoming"), cond("warehouse_id", "=", false)]));
  if (!found.length) found = await env.withContext({ ...env.context, active_test: false }).model(T).search(and([cond("code", "=", "incoming"), cond("warehouse_id", "=", false)]));
  await rec.set("picking_type_id", found[0] ?? null);
});
// :529-534 _compute_tax_id
registerOnchange("purchase.order", "_compute_tax_id", ["fiscal_position_id", "company_id"], async (env, rec) => {
  for (const line of await rec.rels("order_line")) {
    if (line instanceof NewRec) await computeLineTaxes(env, line);
    else throw new NotPorted("purchase.order fiscal position change over stored lines");
  }
});

// purchase_order.py:455-467 create: one create per values, under `with_company(company_id)` (the order's sequence, and
// the multi-company rules then admit an order of another of the user's companies)
registerOverrides("purchase.order", {
  // purchase_order.py:116-131 write: a quantity lowered on a confirmed order logs on its receipts; the tracking of a state
  // left from 'to approve' posts with mt_rfq_approved (:603-605), which src/mail/write_hooks.ts does not choose
  write: async (env, ids, vals, next) => {
    if ("state" in vals && (await env.cr.query("SELECT 1 FROM purchase_order WHERE id = ANY($1::int[]) AND state = 'to approve' LIMIT 1", [[...ids]])).rows.length) {
      throw new NotPorted("purchase.order state change from 'to approve' (mt_rfq_approved)");
    }
    // purchase_stock purchase_order.py:116-128: the lines of a confirmed order are updated through their own write (a
    // quantity raised goes to the receipt, src/models/purchase_receipt.ts; a decrease refuses there, so
    // `_log_decrease_ordered_quantity` has nothing to log) and new lines through their create (the receipt and the
    // "Extra line" note, round 14); removed or relinked lines refuse
    if (vals["order_line"] && (await env.cr.query("SELECT 1 FROM purchase_order WHERE id = ANY($1::int[]) AND state = 'purchase' LIMIT 1", [[...ids]])).rows.length) {
      const cmds = Array.isArray(vals["order_line"]) ? vals["order_line"] as unknown[] : [];
      if (!cmds.every((c) => Array.isArray(c) && (c[0] === 1 || c[0] === 0))) {
        throw new NotPorted("purchase.order write of removed or relinked lines on a confirmed order (_log_decrease_ordered_quantity)");
      }
    }
    await next(env, ids, vals);
    // purchase_stock purchase_order.py:129-130: the open receipts follow the order's priority (`picking_ids` is
    // `order_line.move_ids.picking_id`, :38-40)
    if ("priority" in vals) {
      const pickings = (await env.cr.query<{ id: number }>(
        `SELECT DISTINCT p.id FROM stock_move m JOIN purchase_order_line l ON l.id = m.purchase_line_id JOIN stock_picking p ON p.id = m.picking_id
          WHERE l.order_id = ANY($1::int[]) AND p.state NOT IN ('done', 'cancel') ORDER BY p.id`, [[...ids]])).rows.map((r) => r.id);
      if (pickings.length) await write(env, "stock.picking", pickings, { priority: vals["priority"] });
    }
  },
  // purchase_order.py:469-473 _unlink_if_cancelled
  beforeUnlink: async (env, ids) => {
    if ((await env.cr.query("SELECT 1 FROM purchase_order WHERE id = ANY($1::int[]) AND state != 'cancel' LIMIT 1", [[...ids]])).rows.length) {
      throw new UserError(translate(env, "In order to delete a purchase order, you must cancel it first.", "purchase"));
    }
  },
  create: async (env, valsList, next) => {
    const ids: number[] = [];
    for (const vals of valsList) {
      const company = idOf(vals["company_id"]) ?? await env.company();
      const comp = await withCompany(env, company);
      if (!("name" in vals) || vals["name"] === "New") vals["name"] = (await nextByCode(comp, "purchase.order")) || "/";
      ids.push(...(await next(comp, [vals])));
    }
    return ids;
  },
});

/**
 * purchase_order.py:475-483 copy: BaseModel's copy without `default_product_id` in the context, then each copied line
 * with a product gets `_get_date_planned(_get_seller_info())` (purchase_order_line.py:474-491): the new order's
 * `date_order` plus the selected vendor's delay (0 without one).
 */
registerMethod("purchase.order", "copy", async (env0, ids, args, kwargs0) => {
  const { env: env1, kwargs } = envFor(env0, kwargs0);
  const dflt = kwargs["default"] ?? args[0];
  if (dflt !== undefined && dflt !== null && dflt !== false && (typeof dflt !== "object" || Array.isArray(dflt))) throw new NotPorted("copy default");
  const { default_product_id: _drop, ...ctx } = env1.context;
  const env = env1.withContext(ctx);
  const created = await withDbErrors(env, () => copy(env, "purchase.order", ids ?? [], (dflt && typeof dflt === "object" ? dflt : {}) as Record<string, unknown>));
  const lineDef = env.reg.model("purchase.order.line");
  for (const order of created) {
    const o = (await env.cr.query<{ d: string | null }>("SELECT date_order::text AS d FROM purchase_order WHERE id = $1", [order])).rows[0];
    const lines = (await env.cr.query<{ id: number }>("SELECT id FROM purchase_order_line WHERE order_id = $1 AND product_id IS NOT NULL ORDER BY sequence, id", [order])).rows;
    for (const { id } of lines) {
      const line = new DbRec(env, lineDef, id);
      const product = await line.rel("product_id");
      const seller = product ? await sellerInfo(env, line, product) : null;
      const from = o?.d ? new Date(`${o.d.replace(" ", "T")}Z`) : await dbNow(env);
      const date = new Date(from.getTime() + (seller?.delay ?? 0) * 86400000).toISOString().slice(0, 19).replace("T", " ");
      await write(env, "purchase.order.line", [id], { date_planned: date });
    }
  }
  return created;
}, { apiModel: false });

registerDefaults("purchase.order.line", { analytic_precision: analyticPrecision });

// purchase_order_line.py:624-633 `_inverse_label`
async function inverseLabel(env: Environment, id: number, label: unknown): Promise<string | null> {
  const line = new DbRec(env, env.reg.model("purchase.order.line"), id);
  if (!(await line.get("product_id")) || !label) return typeof label === "string" ? label : null;
  const display = await lineProductName(env, line);
  const text = String(label);
  const rest = display && text.startsWith(display) ? text.slice(display.length) : text;
  return rest.startsWith("\n") ? rest.slice(1) : rest;
}
registerOverrides("purchase.order.line", {
  create: async (env, valsList, next) => {
    const labels = valsList.map((vals) => {
      const had = "label" in vals, label = vals["label"];
      delete vals["label"];
      return { had, label };
    });
    for (const vals of valsList) {
      // :414-424 with `_prepare_add_missing_fields` :800-810
      if (vals["display_type"]) {
        Object.assign(vals, { product_id: false, price_unit: 0, product_uom_qty: 0, uom_id: false, date_planned: false });
        continue;
      }
      const missing = ["name", "price_unit", "product_qty", "uom_id", "tax_ids", "date_planned", "discount"].filter((f) => !(f in vals));
      if (vals["order_id"] && vals["product_id"] && missing.length) {
        const line = new NewRec(env, env.reg.model("purchase.order.line"), null);
        for (const [k, v] of Object.entries(vals)) {
          const type = line.def.fields.get(k)?.type;
          if (type && type !== "one2many" && type !== "many2many") line.put(k, v);
        }
        await onchangeProduct(env, line);
        for (const f of missing) {
          const v = await line.get(f);
          vals[f] = f === "tax_ids" ? [[6, 0, (v as unknown[] | null ?? []).map(idOf)]] : v;
        }
      }
      if (vals["price_unit"] && !vals["technical_price_unit"] && !env.context["import_file"]) vals["technical_price_unit"] = vals["price_unit"];
    }
    // the orders' tracking (amounts) is one message per order at precommit (mail_track_mixin.py:133), after the
    // "Extra line" note and the receipt; the order is the given one or the default's (default_order_id)
    const dflt = valsList.some((v) => !("order_id" in v)) ? idOf(env.context["default_order_id"]) : null;
    const orders = [...new Set(valsList.map((v) => ("order_id" in v ? idOf(v["order_id"]) : dflt)).filter((o): o is number => o !== null))].sort((a, b) => a - b);
    const { trackPrepare } = await import("../mail/tracking");
    const { closeTrackingScope } = await import("../mail/write_hooks");
    await trackPrepare(env, "purchase.order", orders);
    const ids = await next(env, valsList);
    for (const [i, id] of ids.entries()) {
      if (labels[i]!.had) await write(env, "purchase.order.line", [id], { name: await inverseLabel(env, id, labels[i]!.label) });
    }
    await afterPurchaseLineCreate(env, ids);
    await closeTrackingScope(env, "purchase.order");
    return ids;
  },

  write: async (env, ids, vals, next) => {
    const { purchaseLineWriteMoves } = await import("./purchase_receipt");
    await purchaseLineWriteMoves(env, ids, vals, async () => {
      await logLinePriceChange(env, ids, vals);
      if ("qty_received" in vals && !env.context["accrual_entry_date"]) {
        const raw = vals["qty_received"];
        const nextQty = typeof raw === "object" && raw !== null && "float" in raw ? Number((raw as { float: number }).float) : Number(raw ?? 0);
        for (const id of ids) {
          const rec = new DbRec(env, env.reg.model("purchase.order.line"), id);
          const before = Number((await rec.get("qty_received")) ?? 0);
          const order = await rec.rel("order_id");
          if (nextQty !== before && order && (await order.get("state")) === "purchase") {
            await trackQtyReceived(env, rec, order.origin!, before, nextQty);
          }
        }
      }
      if (!("label" in vals)) return next(env, ids, vals);
      const { label, ...rest } = vals;
      await next(env, ids, rest);
      for (const id of ids) await next(env, [id], { name: await inverseLabel(env, id, label) });
    });
  },
});

/**
 * After the base create of purchase.order.line: purchase_order_line.py:427-430, a product line of a confirmed order is
 * noted on the order ("Extra line with %s ", message_post as a note); purchase_stock purchase_order_line.py:102-108,
 * the confirmed order's new lines make or update its receipt (`_create_or_update_picking`, unless bypass_move_update;
 * the receipts' tracking is logged once, at precommit) and get `_set_date_promised` (:54-56).
 */
async function afterPurchaseLineCreate(env: Environment, ids: readonly number[]): Promise<void> {
  if (!ids.length) return;
  const created = (await env.cr.query<{ id: number; order_id: number; state: string | null; product_id: number | null; display_type: string | null }>(
    `SELECT l.id, l.order_id, o.state, l.product_id, l.display_type FROM purchase_order_line l JOIN purchase_order o ON o.id = l.order_id WHERE l.id = ANY($1::int[])`, [ids])).rows;
  const byId = new Map(created.map((r) => [r.id, r]));
  if (!env.context["skip_intercompany_sync"]) {
    for (const id of ids) {
      const r = byId.get(id);
      if (!r || !r.product_id || r.state !== "purchase") continue;
      const shown = (await env.model("product.product").displayName([r.product_id])).get(r.product_id) ?? "";
      await postNote(env, "purchase.order", r.order_id, `<p>${escapeText(pyPercent(translate(env, "Extra line with %s ", "purchase"), [shown]))}</p>`);
    }
  }
  const confirmed = ids.filter((id) => byId.get(id)?.state === "purchase" && !byId.get(id)?.display_type);
  if (confirmed.length) {
    if (!env.context["bypass_move_update"]) {
      const { createOrUpdatePicking } = await import("./purchase_receipt");
      const { trackPrepare } = await import("../mail/tracking");
      const { closeTrackingScope } = await import("../mail/write_hooks");
      const orders = [...new Set(confirmed.map((id) => byId.get(id)!.order_id))];
      const pickings = (await env.cr.query<{ id: number }>(
        "SELECT DISTINCT stock_picking_id AS id FROM purchase_order_stock_picking_rel WHERE purchase_order_id = ANY($1::int[]) ORDER BY 1", [orders])).rows.map((r) => r.id);
      await trackPrepare(env, "stock.picking", pickings);
      for (const id of confirmed) await createOrUpdatePicking(env, id, byId.get(id)!.order_id, 0);
      await closeTrackingScope(env, "stock.picking");
    }
    // the datetime as read, with its microseconds (as purchase_receipt.ts approveOrders)
    for (const id of confirmed) {
      const [d] = (await env.cr.query<{ d: string | null }>("SELECT date_planned::text AS d FROM purchase_order_line WHERE id = $1", [id])).rows;
      await write(env, "purchase.order.line", [id], { date_promised: d?.d ? new PreciseDatetime(d.d) : false });
    }
  }
}

/**
 * purchase_order_line.py:438-459 write: a new unit price (or quantity) of a confirmed order's line posts
 * `purchase.track_po_line_template` (data/mail_templates.xml:4-35) on the order as a note, before the write; the
 * quantity refuses before (purchase_receipt.ts), other languages than en_US refuse.
 */
async function logLinePriceChange(env: Environment, ids: readonly number[], vals: Readonly<Record<string, unknown>>): Promise<void> {
  if (!("price_unit" in vals || "product_qty" in vals) || env.context["skip_intercompany_sync"]) return;
  const digits = (await env.cr.query<{ d: number }>("SELECT digits AS d FROM decimal_precision WHERE name = 'Product Unit'")).rows[0]?.d ?? 2;
  const newPrice = Number(plainNumber(vals["price_unit"]) ?? 0);
  const newQty = Number(plainNumber(vals["product_qty"]) ?? 0);
  const lang = env.lang ?? "en_US";
  const esc = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  for (const id of ids) {
    const l = (await env.cr.query<{ order_id: number; state: string; price_unit: number; product_qty: number; product_id: number | null; currency_id: number | null; qty_invoiced: number }>(
      `SELECT l.order_id, o.state, l.price_unit::float8 AS price_unit, l.product_qty::float8 AS product_qty, l.product_id, o.currency_id, COALESCE(l.qty_invoiced, 0)::float8 AS qty_invoiced
         FROM purchase_order_line l JOIN purchase_order o ON o.id = l.order_id WHERE l.id = $1`, [id])).rows[0];
    if (!l || l.state !== "purchase") continue;
    // float_compare(..., precision_digits=<Product Unit>) for both values; the quantity shown is float_round(new)
    const qtyChanged = "product_qty" in vals && floatRound(l.product_qty, digits) !== floatRound(newQty, digits);
    const priceChanged = "price_unit" in vals && floatRound(l.price_unit, digits) !== floatRound(newPrice, digits);
    if (!qtyChanged && !priceChanged) continue;
    if (qtyChanged && priceChanged) throw new NotPorted("purchase.track_po_line_template of a quantity and a price");
    if (qtyChanged) {
      const display = l.product_id ? (await env.model("product.product").displayName([l.product_id])).get(l.product_id) ?? "" : "";
      const heading = esc(translate(env, "The ordered quantity has been updated.", "purchase"));
      const orderedLabel = esc(translate(env, "Ordered Quantity:", "purchase"));
      const billedLabel = esc(translate(env, "Billed Quantity:", "purchase"));
      const body = `<div>\n            <strong>\n                    ${heading}\n            </strong>\n\n            <ul>\n`
        + `                <li>${esc(display)}:</li>\n                    ${orderedLabel} ${pyFloat(l.product_qty)} -&gt; ${pyFloat(floatRound(newQty, digits))}<br>\n`
        + `                ${billedLabel} ${pyFloat(l.qty_invoiced)}\n            </ul>\n        </div>`;
      await postNote(env, "purchase.order", l.order_id, body);
      continue;
    }
    if (l.currency_id === null) throw new NotPorted("purchase.track_po_line_template without a currency");
    const money = async (v: number): Promise<string> => {
      const c = (await env.cr.query<{ symbol: string; position: string; places: number; rounding: number }>(
        "SELECT symbol, position, decimal_places AS places, rounding::float8 AS rounding FROM res_currency WHERE id = $1", [l.currency_id])).rows[0]!;
      const { langNumber } = await import("../mail/tracking");
      const amount = floatRound(Math.round(v / c.rounding) * c.rounding, c.places);
      const span = `<span class="oe_currency_value">${(await langNumber(env, lang, amount, c.places)).replace(/-/g, "-\ufeff")}</span>`;
      return c.position === "before" ? `${esc(c.symbol)}&nbsp;${span}` : `${span}&nbsp;${esc(c.symbol)}`;
    };
    const display = l.product_id ? (await env.model("product.product").displayName([l.product_id])).get(l.product_id) ?? "" : "";
    const heading = esc(translate(env, "The unit price has been updated.", "purchase"));
    const priceLabel = esc(translate(env, "Unit Price:", "purchase"));
    const billedLabel = esc(translate(env, "Billed Quantity:", "purchase"));
    const body = `<div>\n            <strong>\n                    ${heading}\n            </strong>\n\n            <ul>\n`
      + `                <li>${esc(display)}:</li>\n                    ${priceLabel}\n                    ${await money(l.price_unit)}\n                    -&gt;\n`
      + `                    ${await money(newPrice)}\n                    <br>\n                ${billedLabel} ${pyFloat(l.qty_invoiced)}\n            </ul>\n        </div>`;
    await postNote(env, "purchase.order", l.order_id, body);
  }
}

// purchase_order.py:270-278 _compute_display_name
registerHooks("purchase.order", {
  displayName: async (env, ids) => {
    if (env.context["show_total_amount"]) throw new NotPorted("purchase.order display_name with show_total_amount");
    const rows = (await env.cr.query<{ id: number; name: string; ref: string | null }>("SELECT id, name, partner_ref AS ref FROM purchase_order WHERE id = ANY($1::int[])", [[...ids]])).rows;
    return new Map(rows.map((r) => [r.id, r.ref ? `${r.name} (${r.ref})` : r.name]));
  },
});
