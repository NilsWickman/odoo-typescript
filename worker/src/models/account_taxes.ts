/**
 * The server side of Odoo's tax computation for documents: account.tax records and currencies as the engine's data
 * (account_tax_engine.js, Odoo's own mirror of account_tax.py), the base lines of sale.order.line
 * (sale/models/sale_order_line.py:1036-1060 `_prepare_base_line_for_taxes_computation`, account_tax.py:1572-1660),
 * and the sale.order computes built on them (sale_order.py:725-741 `_compute_amounts`, :1178-1190
 * `_compute_tax_totals`). Taxes of the 'group' or 'code' kind, extra tax data (manual amounts, global discounts),
 * early payment discounts refuse with NotPorted.
 */
import { roundMonetary } from "../orm/convert";
import { NotPorted } from "../errors";
import type { Rec } from "../orm/recompute";
import { registerRecordCompute } from "../orm/recompute";
import type { Environment, PyFloat } from "../orm/types";
import { pyFloat } from "../orm/values";
import { accountTaxHelpers, roundPrecision, setTaxEngineTranslator, type BaseLine, type TaxCompany, type TaxCurrency, type TaxData, type TaxTotalsSummary } from "./account_tax_engine";
import { defineComputes, getLang } from "./tail_util";
import { langNumber } from "../mail/tracking";
import { mainCompanyCurrency } from "./product_computes";
import { translate } from "./util";
import { PrivateRecords } from "../orm/private_hooks";
import { checkBaseLine, lineRecord, loadedOf, storedLine } from "./account_tax_hooks";

/**
 * account_tax.py:2837 `_get_tax_totals_summary`: the one label the engine writes, `_("Untaxed Amount")`, is account's
 * `_()` (translated with account's .po, translate.py:981-989). The engine's translator is module state, so it is set
 * in the same synchronous run as the summary (no await between them: another request of the isolate cannot interleave).
 */
export function withTaxEngineLabels<T>(env: Environment, run: () => T): T {
  setTaxEngineTranslator((source: string) => translate(env, source, "account"));
  try {
    return run();
  } finally {
    setTaxEngineTranslator((source: string) => source);
  }
}

function taxTotalsSummary(env: Environment, lines: BaseLine[], currency: TaxCurrency, company: TaxCompany): TaxTotalsSummary {
  return withTaxEngineLabels(env, () => {
    accountTaxHelpers.add_tax_details_in_base_lines(lines, company);
    accountTaxHelpers.round_base_lines_tax_details(lines, company);
    return accountTaxHelpers.get_tax_totals_summary(lines, currency, company);
  });
}

export async function currencyData(env: Environment, id: number): Promise<TaxCurrency> {
  const row = (await env.cr.query<{ rounding: string; decimal_places: number | null }>(
    "SELECT rounding::text AS rounding, decimal_places FROM res_currency WHERE id = $1", [id])).rows[0];
  if (!row) throw new NotPorted(`currency ${id} for the tax engine`);
  return { id, rounding: Number(row.rounding), decimal_places: row.decimal_places ?? 0 };
}

export async function companyData(env: Environment, id: number): Promise<TaxCompany> {
  const row = (await env.cr.query<{ currency_id: number; method: string | null }>(
    "SELECT currency_id, tax_calculation_rounding_method AS method FROM res_company WHERE id = $1", [id])).rows[0];
  if (!row) throw new NotPorted(`company ${id} for the tax engine`);
  return { currency_id: await currencyData(env, row.currency_id), tax_calculation_rounding_method: row.method ?? "round_per_line" };
}

/** account.tax records as the engine reads them (account_tax.py fields; price_include :299-305, has_negative_factor :457-460). */
export async function taxData(env: Environment, ids: readonly number[]): Promise<TaxData[]> {
  if (ids.length === 0) return [];
  const lang = env.lang ?? "en_US";
  const rows = (await env.cr.query<{
    id: number; name: string; amount_type: string; amount: string; sequence: number | null; price_include_override: string | null;
    company_price_include: string | null; include_base_amount: boolean | null; is_base_affected: boolean | null; negative: boolean;
    group_id: number; group_name: string; preceding: string | null; pos_label: string | null;
  }>(
    `SELECT t.id, COALESCE(t.name->>$2, t.name->>'en_US') AS name, t.amount_type, t.amount::text AS amount, t.sequence,
            t.price_include_override, c.account_price_include AS company_price_include, t.include_base_amount, t.is_base_affected,
            EXISTS(SELECT 1 FROM account_tax_repartition_line r WHERE r.tax_id = t.id AND r.document_type = 'invoice'
                     AND r.repartition_type = 'tax' AND r.factor_percent < 0) AS negative,
            g.id AS group_id, COALESCE(g.name->>$2, g.name->>'en_US') AS group_name,
            COALESCE(g.preceding_subtotal->>$2, g.preceding_subtotal->>'en_US') AS preceding, g.pos_receipt_label AS pos_label
       FROM account_tax t JOIN res_company c ON c.id = t.company_id JOIN account_tax_group g ON g.id = t.tax_group_id
      WHERE t.id = ANY($1::int[])`, [ids, lang])).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const r = byId.get(id);
    if (!r) throw new NotPorted(`account.tax ${id} for the tax engine`);
    if (r.amount_type === "group" || r.amount_type === "code") throw new NotPorted(`account.tax of type ${r.amount_type}`);
    return {
      id: r.id, name: r.name, amount_type: r.amount_type, amount: Number(r.amount), sequence: r.sequence ?? 1,
      price_include: r.price_include_override === "tax_included" || (r.company_price_include === "tax_included" && !r.price_include_override),
      price_include_override: r.price_include_override ?? false,
      include_base_amount: Boolean(r.include_base_amount), is_base_affected: Boolean(r.is_base_affected),
      has_negative_factor: r.negative, children_tax_ids: [],
      tax_group_id: { id: r.group_id, name: r.group_name, preceding_subtotal: r.preceding || false, pos_receipt_label: r.pos_label || false },
    };
  });
}

/** Floats of the tax totals summary as Python floats in JSON (`50000.0`). */
export function pyFloats(value: unknown, key = ""): unknown {
  const INT_KEYS = new Set(["id", "currency_id", "company_currency_id", "involved_tax_ids"]);
  if (typeof value === "number") return INT_KEYS.has(key) ? value : pyFloat(value);
  if (Array.isArray(value)) return value.map((v) => pyFloats(v, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = pyFloats(v, k);
    return out;
  }
  return value;
}

const EXTRA_KEYS = new Set(["computation_key", "currency_id", "discount", "manual_tax_amounts", "manual_total_excluded", "manual_total_excluded_currency", "price_unit", "quantity", "rate"]);

/**
 * A stored `extra_tax_data` (account_tax.py:1375-1407 `_export_base_line_extra_tax_data`) for the engine's import
 * (account_tax.py:1409-1462 `_import_base_line_extra_tax_data`, account_tax.js mirror), and the base line's special
 * type: sale_order_line.py:1055-1058 (the line's flag) or account_move.py:1685-1689 (the computation key). Global
 * discounts refuse (not ported), and so does a value the JavaScript mirror would import where Python does not
 * (stored source data without manual tax amounts).
 */
export function extraTaxData(extra: unknown, downpayment: boolean | null): { extra_tax_data: Record<string, unknown>; special_type: string | null } {
  // a value given in create values carries Python floats (PyFloat); the engine computes with numbers
  const plain = (v: unknown): unknown => (v && typeof v === "object" && !Array.isArray(v)
    ? ("float" in (v as object) && Object.keys(v as object).length === 1 ? (v as { float: number }).float : Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, plain(x)])))
    : v);
  const data = extra && typeof extra === "object" && !Array.isArray(extra) ? plain(extra) as Record<string, unknown> : {};
  for (const k of Object.keys(data)) if (!EXTRA_KEYS.has(k)) throw new NotPorted(`extra_tax_data key ${k}`);
  const key = typeof data["computation_key"] === "string" ? data["computation_key"] : "";
  const isGlobal = key.startsWith("global_discount,");
  if (key.startsWith("global_discount") && !isGlobal) throw new NotPorted("a global discount line (extra_tax_data global_discount)");
  const manual = data["manual_tax_amounts"];
  if (!isGlobal && Object.keys(data).some((k) => k !== "computation_key") && !(manual && typeof manual === "object" && Object.keys(manual).length)) {
    throw new NotPorted("extra_tax_data without manual tax amounts");
  }
  const special = isGlobal
    ? "global_discount"
    : downpayment === null
      ? (key.startsWith("down_payment") ? "down_payment" : null)
      : (downpayment ? "down_payment" : null);
  return { extra_tax_data: data, special_type: special };
}

interface OrderData { company: number; currency: number; rate: number; taxMode: string | null }

interface LineSource {
  readonly table: string;
  readonly qty: string;
  readonly rel: string;
  readonly relLine: string;
  /** sale lines: extra_tax_data and is_downpayment (sale_order_line.py:1054-1058); purchase lines have neither. */
  readonly sale: boolean;
}
const SALE_LINES: LineSource = { table: "sale_order_line", qty: "product_uom_qty", rel: "account_tax_sale_order_line_rel", relLine: "sale_order_line_id", sale: true };
const PURCHASE_LINES: LineSource = { table: "purchase_order_line", qty: "product_qty", rel: "account_tax_purchase_order_line_rel", relLine: "purchase_order_line_id", sale: false };

/**
 * The priced lines of an order (`display_type` empty: sale_order.py:722-723, purchase_order.py:35) as base lines:
 * sale_order_line.py:1036-1060 / purchase_order_line.py:167-185 over account_tax.py:1572-1660
 * `_prepare_base_line_for_taxes_computation`; taxes in their `_order` (sequence, id).
 */
async function orderBaseLines(env: Environment, src: LineSource, orderId: number, order: OrderData): Promise<BaseLine[]> {
  const extra = src.sale ? ", extra_tax_data AS extra, is_downpayment AS downpayment" : ", NULL::jsonb AS extra, false AS downpayment";
  const lines = (await env.cr.query<{ id: number; price_unit: number | null; qty: number | null; discount: number | null; extra: unknown; downpayment: boolean | null }>(
    `SELECT id, price_unit::float8 AS price_unit, ${src.qty}::float8 AS qty, discount::float8 AS discount${extra}
       FROM ${src.table} WHERE order_id = $1 AND display_type IS NULL ORDER BY sequence, id`, [orderId])).rows;
  const currency = await currencyData(env, order.currency);
  // every line's taxes in one statement (one round trip on the site instead of one per line), each line's in the
  // taxes' `_order`
  const taxesOf = new Map<number, number[]>(lines.map((l) => [l.id, []]));
  if (lines.length) {
    const rows = (await env.cr.query<{ line: number; id: number }>(
      `SELECT r.${src.relLine} AS line, r.account_tax_id AS id FROM ${src.rel} r JOIN account_tax t ON t.id = r.account_tax_id
        WHERE r.${src.relLine} = ANY($1::int[]) ORDER BY t.sequence, t.id`, [lines.map((l) => l.id)])).rows;
    for (const r of rows) taxesOf.get(Number(r.line))?.push(Number(r.id));
  }
  const out: BaseLine[] = [];
  for (const l of lines) {
    const extra = src.sale ? extraTaxData(l.extra, Boolean(l.downpayment)) : { extra_tax_data: {}, special_type: null };
    const taxIds = taxesOf.get(l.id) ?? [];
    const base = accountTaxHelpers.prepare_base_line_for_taxes_computation({
      id: l.id, tax_ids: await taxData(env, taxIds), price_unit: l.price_unit ?? 0, quantity: l.qty ?? 0, discount: l.discount ?? 0,
      currency_id: currency, rate: order.rate, product_id: {}, product_uom_id: {}, document_tax_mode: order.taxMode, extra_tax_data: extra.extra_tax_data,
    }, { special_type: extra.special_type });
    await checkBaseLine(env, base, async () => {
      const rec = storedLine(env, src.sale ? "sale.order.line" : "purchase.order.line", l.id);
      return { record: lineRecord(rec.def.name, rec), ...(await orderLineKwargs(env, rec, src.sale, taxIds, l.qty ?? 0, order.currency, order.rate, order.taxMode, extra.special_type)) };
    });
    out.push(base);
  }
  return out;
}

/**
 * The keyword arguments of an order line's `_prepare_base_line_for_taxes_computation` (sale_order_line.py:1044-1060,
 * purchase_order_line.py:173-185) and the values Odoo loads from the line, for a compiled override (checkBaseLine).
 */
async function orderLineKwargs(env: Environment, rec: Rec, sale: boolean, taxIds: readonly number[], qty: number, currency: number, rate: number, mode: string | null,
  special: string | null): Promise<{ kwargs: Record<string, unknown>; loaded: Awaited<ReturnType<typeof loadedOf>> }> {
  const order = await rec.rel("order_id");
  const partner = order ? await order.get("partner_id") : false;
  const kwargs: Record<string, unknown> = {
    tax_ids: new PrivateRecords("account.tax", [...taxIds]), quantity: qty, partner_id: new PrivateRecords("res.partner", typeof partner === "number" && partner ? [partner] : []),
    currency_id: new PrivateRecords("res.currency", currency ? [currency] : []), rate, name: (await rec.get("name")) || false,
  };
  if (sale) {
    kwargs["document_tax_mode"] = mode || false;
    if (special) kwargs["special_type"] = special;
  } else {
    const uom = await rec.get("uom_id");
    kwargs["product_uom_id"] = new PrivateRecords("uom.uom", typeof uom === "number" && uom ? [uom] : []);
  }
  return { kwargs, loaded: await loadedOf(rec, kwargs, false) };
}

async function summaryOf(env: Environment, src: LineSource, orderId: number, order: OrderData): Promise<TaxTotalsSummary> {
  const company = await companyData(env, order.company);
  const lines = await orderBaseLines(env, src, orderId, order);
  const currency = await currencyData(env, order.currency);
  return taxTotalsSummary(env, lines, currency, company);
}

async function orderData(env: Environment, rec: Rec): Promise<OrderData | null> {
  if (rec.id === null) return null;
  const row = (await env.cr.query<{ company_id: number; currency_id: number | null; rate: number | null; mode: string | null; ccur: number; term: number | null }>(
    `SELECT o.company_id, o.currency_id, o.currency_rate::float8 AS rate, o.document_tax_mode AS mode, c.currency_id AS ccur, o.payment_term_id AS term
       FROM sale_order o JOIN res_company c ON c.id = o.company_id WHERE o.id = $1`, [rec.id])).rows[0];
  if (!row) return null;
  if (row.term !== null) {
    // sale_order.py:743-770 `_add_base_lines_for_early_payment_discount`: only for 'mixed' early discount terms
    const term = (await env.cr.query<{ early: boolean | null; comp: string | null }>(
      "SELECT early_discount AS early, early_pay_discount_computation AS comp FROM account_payment_term WHERE id = $1", [row.term])).rows[0];
    if (term?.early && term.comp === "mixed") throw new NotPorted("sale.order early payment discount lines (mixed computation)");
  }
  return { company: row.company_id, currency: row.currency_id ?? row.ccur, rate: row.rate ?? 1, taxMode: row.mode };
}

/** sale_order.py:1178-1190 `_compute_tax_totals` (and :725-741 `_compute_amounts`, the same summary). */
async function saleTaxTotals(env: Environment, rec: Rec): Promise<TaxTotalsSummary | null> {
  const order = await orderData(env, rec);
  return order === null ? null : summaryOf(env, SALE_LINES, rec.id!, order);
}

/** purchase_order.py:299-317 `_compute_tax_totals` (no company: False; foreign currency adds amount_total_cc). */
async function purchaseTaxTotals(env: Environment, rec: Rec): Promise<TaxTotalsSummary | null> {
  if (rec.id === null) return purchaseRecordSummary(env, rec);
  const row = (await env.cr.query<{ company_id: number | null; currency_id: number | null; rate: number | null; ccur: number | null }>(
    `SELECT o.company_id, o.currency_id, o.currency_rate::float8 AS rate, c.currency_id AS ccur
       FROM purchase_order o LEFT JOIN res_company c ON c.id = o.company_id WHERE o.id = $1`, [rec.id])).rows[0];
  if (!row || row.company_id === null) return null;
  const currency = row.currency_id ?? row.ccur!;
  return summaryOf(env, PURCHASE_LINES, rec.id, { company: row.company_id, currency, rate: row.rate ?? 1, taxMode: null });
}
defineComputes("purchase.order", {
  tax_totals: async (env, rec) => {
    const summary = await purchaseTaxTotals(env, rec);
    if (summary === null) return false;
    // :315-316 an order in another currency than the company's: `amount_total_cc` formatted in the company currency
    const company = await rec.rel("company_id");
    const ccur = company ? Number(await company.get("currency_id")) : null;
    const cur = await rec.get("currency_id");
    const out: Record<string, unknown> = { ...pyFloats(summary) as Record<string, unknown> };
    if (ccur !== null && typeof cur === "number" && cur && cur !== ccur) {
      const { formatLangCurrency } = await import("./product_computes");
      out["amount_total_cc"] = `(${await formatLangCurrency(env, Number(summary.total_amount), ccur)})`;
    }
    return out;
  },
});

defineComputes("sale.order", {
  tax_totals: async (env, rec) => {
    // a new order: its line records (database orders read their lines from the database)
    if (rec.id === null) return pyFloats(await recordSummary(env, rec));
    const summary = await saleTaxTotals(env, rec);
    return summary === null ? null : pyFloats(summary);
  },
});

registerRecordCompute("sale.order", {
  // sale_order.py:725-741 _compute_amounts (stored) on saved orders whose lines are in the database
  amount_untaxed: async (env, rec) => amountOf(env, rec, "base_amount_currency"),
  amount_tax: async (env, rec) => amountOf(env, rec, "tax_amount_currency"),
  amount_total: async (env, rec) => amountOf(env, rec, "total_amount_currency"),
});

/** sale_order.py:725-741 `_compute_amounts` (stored) over the order's line records (database or new). */
async function amountOf(env: Environment, rec: Rec, key: "base_amount_currency" | "tax_amount_currency" | "total_amount_currency"): Promise<number | PyFloat> {
  return (await recordSummary(env, rec))[key];
}

/** The tax totals summary of an order record's priced lines (sale_order.py:1176-1190, also for new orders). */
async function recordSummary(env: Environment, rec: Rec): Promise<TaxTotalsSummary> {
  const priced: Rec[] = [];
  for (const line of await rec.rels("order_line")) if (!(await line.get("display_type"))) priced.push(line);
  const companyField = await rec.get("company_id");
  const company = await companyData(env, typeof companyField === "number" && companyField ? companyField : await env.company());
  const term = await rec.rel("payment_term_id");
  if (term && (await term.get("early_discount")) && (await term.get("early_pay_discount_computation")) === "mixed") {
    throw new NotPorted("sale.order early payment discount lines (mixed computation)");
  }
  const orderCurrency = await rec.get("currency_id");
  const currency = typeof orderCurrency === "number" && orderCurrency ? await currencyData(env, orderCurrency) : company.currency_id;
  const lines: BaseLine[] = [];
  for (const line of priced) lines.push((await saleLineBase(env, line)).base);
  return taxTotalsSummary(env, lines, currency, company);
}

/** purchase_order_line.py:167-185 `_prepare_base_line_for_taxes_computation` of a line record (database or new). */
async function purchaseLineBase(env: Environment, line: Rec): Promise<{ base: BaseLine; company: TaxCompany }> {
  const order = await line.rel("order_id");
  const lineCompany = await line.get("company_id");
  const company = await companyData(env, typeof lineCompany === "number" && lineCompany ? lineCompany : await env.company());
  const orderCurrency = order ? await order.get("currency_id") : null;
  const currency = typeof orderCurrency === "number" && orderCurrency ? await currencyData(env, orderCurrency) : company.currency_id;
  const mode = await line.get("document_tax_mode");
  const taxIds: number[] = [];
  for (const t of await line.rels("tax_ids")) if (t.origin !== null) taxIds.push(t.origin);
  const taxes = (await taxData(env, taxIds)).sort((a, b) => a.sequence - b.sequence || a.id - b.id);
  const base = accountTaxHelpers.prepare_base_line_for_taxes_computation({
    id: line.origin ?? 0, tax_ids: taxes, price_unit: Number((await line.get("price_unit")) ?? 0),
    quantity: Number((await line.get("product_qty")) ?? 0), discount: Number((await line.get("discount")) ?? 0),
    currency_id: currency, rate: order ? Number((await order.get("currency_rate")) ?? 0) : 0, product_id: {}, product_uom_id: {},
    document_tax_mode: typeof mode === "string" && mode ? mode : null,
  });
  await checkBaseLine(env, base, async () => ({ record: lineRecord("purchase.order.line", line),
    ...(await orderLineKwargs(env, line, false, taxIds, Number((await line.get("product_qty")) ?? 0), currency.id, order ? Number((await order.get("currency_rate")) ?? 0) : 0, null, null)) }));
  return { base, company };
}

/** purchase_order_line.py:151-165 _compute_amount (stored); `non_deductible_amount` is account_tax.py:663-669. */
async function purchaseLineAmounts(env: Environment, line: Rec): Promise<{ subtotal: number; total: number; nonDeductible: number }> {
  const { base, company } = await purchaseLineBase(env, line);
  accountTaxHelpers.add_tax_details_in_base_lines([base], company);
  accountTaxHelpers.round_base_lines_tax_details([base], company);
  const taxes = (base.tax_details as unknown as { taxes_data: { tax: { id: number }; tax_amount_currency: number }[] }).taxes_data;
  let nonDeductible = 0;
  for (const data of taxes) {
    const row = (await env.cr.query<{ f: number | null }>(
      `SELECT sum(factor_percent / 100.0)::float8 AS f FROM account_tax_repartition_line
        WHERE tax_id = $1 AND document_type = 'invoice' AND repartition_type = 'tax' AND NOT COALESCE(use_in_tax_closing, false)`, [data.tax.id])).rows[0];
    nonDeductible += data.tax_amount_currency * (row?.f ?? 0);
  }
  // Monetary fields round to their currency when assigned (fields_numeric.py:271-288 convert_to_cache): 120.5 + 18.08
  // is 138.57999999999998 in floats, 138.58 in the record (gcrawl G318)
  const rounding = (base as unknown as { currency_id: { rounding: number } }).currency_id.rounding;
  const r = (v: number): number => roundMonetary(v, rounding);
  return { subtotal: r(base.tax_details.total_excluded_currency), total: r(base.tax_details.total_included_currency), nonDeductible: r(nonDeductible) };
}
registerRecordCompute("purchase.order.line", {
  price_subtotal: async (env, line) => (await purchaseLineAmounts(env, line)).subtotal,
  price_total: async (env, line) => (await purchaseLineAmounts(env, line)).total,
  // purchase_order_line.py:63, :161: price_tax is a Float, `price_total - price_subtotal` unrounded (76.95000000000005)
  price_tax: async (env, line) => {
    const a = await purchaseLineAmounts(env, line);
    return a.total - a.subtotal;
  },
  non_deductible_tax: async (env, line) => (await purchaseLineAmounts(env, line)).nonDeductible,
});

/** purchase_order.py:299-314 `_compute_tax_totals` of a new order's line records. */
async function purchaseRecordSummary(env: Environment, rec: Rec): Promise<TaxTotalsSummary | null> {
  const companyField = await rec.get("company_id");
  if (typeof companyField !== "number" || !companyField) return null;
  const company = await companyData(env, companyField);
  const orderCurrency = await rec.get("currency_id");
  const currency = typeof orderCurrency === "number" && orderCurrency ? await currencyData(env, orderCurrency) : company.currency_id;
  const lines: BaseLine[] = [];
  for (const line of await rec.rels("order_line")) if (!(await line.get("display_type"))) lines.push((await purchaseLineBase(env, line)).base);
  return taxTotalsSummary(env, lines, currency, company);
}

/** purchase_order.py:26-47 _amount_all (stored): the summary of the order's line records. */
async function purchaseAmount(env: Environment, rec: Rec, key: "base_amount_currency" | "tax_amount_currency" | "total_amount_currency" | "total_amount"): Promise<number> {
  const summary = await purchaseRecordSummary(env, rec);
  return summary === null ? 0 : Number(summary[key]);
}
registerRecordCompute("purchase.order", {
  amount_untaxed: (env, rec) => purchaseAmount(env, rec, "base_amount_currency"),
  amount_tax: (env, rec) => purchaseAmount(env, rec, "tax_amount_currency"),
  amount_total: (env, rec) => purchaseAmount(env, rec, "total_amount_currency"),
  amount_total_cc: (env, rec) => purchaseAmount(env, rec, "total_amount"),
});

/** sale_order_line.py:1036-1060 `_prepare_base_line_for_taxes_computation` of a line record (database or new). */
export async function saleLineBase(env: Environment, line: Rec, quantity?: number): Promise<{ base: BaseLine; company: TaxCompany; docCompany: TaxCompany; currency: TaxCurrency }> {
  const extra = extraTaxData(await line.get("extra_tax_data"), Boolean(await line.get("is_downpayment")));
  const order = await line.rel("order_id");
  const lineCompany = await line.get("company_id");
  const company = await companyData(env, typeof lineCompany === "number" && lineCompany ? lineCompany : await env.company());
  const orderCompany = order ? await order.get("company_id") : null;
  const docCompany = typeof orderCompany === "number" && orderCompany ? await companyData(env, orderCompany) : await companyData(env, await env.company());
  const orderCurrency = order ? await order.get("currency_id") : null;
  const currency = typeof orderCurrency === "number" && orderCurrency ? await currencyData(env, orderCurrency) : docCompany.currency_id;
  const rate = order ? Number((await order.get("currency_rate")) ?? 0) : 0;
  const mode = order ? await order.get("document_tax_mode") : null;
  const taxIds: number[] = [];
  for (const t of await line.rels("tax_ids")) if (t.origin !== null) taxIds.push(t.origin);
  const taxes = (await taxData(env, taxIds)).sort((a, b) => a.sequence - b.sequence || a.id - b.id);
  const base = accountTaxHelpers.prepare_base_line_for_taxes_computation({
    id: line.origin ?? 0, tax_ids: taxes, price_unit: Number((await line.get("price_unit")) ?? 0),
    quantity: quantity ?? Number((await line.get("product_uom_qty")) ?? 0), discount: Number((await line.get("discount")) ?? 0),
    currency_id: currency, rate, product_id: {}, product_uom_id: {}, document_tax_mode: typeof mode === "string" && mode ? mode : null,
    extra_tax_data: extra.extra_tax_data,
  }, { special_type: extra.special_type });
  await checkBaseLine(env, base, async () => ({ record: lineRecord("sale.order.line", line),
    ...(await orderLineKwargs(env, line, true, taxIds, quantity ?? Number((await line.get("product_uom_qty")) ?? 0), currency.id, rate,
      typeof mode === "string" && mode ? mode : null, extra.special_type)) }));
  return { base, company, docCompany, currency };
}

/** sale_order_line.py:1068-1078 _compute_amount (stored): the line alone through the engine, with the line's company. */
async function saleLineAmounts(env: Environment, line: Rec): Promise<{ subtotal: number; total: number }> {
  const { base, company } = await saleLineBase(env, line);
  accountTaxHelpers.add_tax_details_in_base_lines([base], company);
  accountTaxHelpers.round_base_lines_tax_details([base], company);
  // Monetary fields round to their currency when assigned (fields_numeric.py:270-288 convert_to_cache), so `price_tax`
  // (a Float, :1078) is the difference of the rounded values: 395.53 + 59.33 is 454.85999999999996 in floats, the
  // record holds 454.86, and 454.86 - 395.53 is 59.33000000000004 (council round 5, proofs/scenarios/round200.py)
  const rounding = (base as unknown as { currency_id: { rounding: number } | null }).currency_id?.rounding;
  const r = (v: number): number => (rounding ? roundMonetary(v, rounding) : v);
  return { subtotal: r(base.tax_details.total_excluded_currency), total: r(base.tax_details.total_included_currency) };
}
registerRecordCompute("sale.order.line", {
  price_subtotal: async (env, line) => (await saleLineAmounts(env, line)).subtotal,
  price_total: async (env, line) => (await saleLineAmounts(env, line)).total,
  price_tax: async (env, line) => { const a = await saleLineAmounts(env, line); return a.total - a.subtotal; },
});

/** misc.py:1603-1619 format_amount(env, amount, currency) with the env's language and trailing zeroes. */
export async function formatAmount(env: Environment, amount: number, currencyId: number): Promise<string> {
  const c = (await env.cr.query<{ symbol: string | null; position: string; decimal_places: number; rounding: string }>(
    "SELECT symbol, position, decimal_places, rounding::text AS rounding FROM res_currency WHERE id = $1", [currencyId])).rows[0];
  if (!c) throw new NotPorted(`format_amount: currency ${currencyId}`);
  const lang = (await getLang(env)).code;
  const rounded = roundPrecision(amount, Number(c.rounding));
  const formatted = (await langNumber(env, lang, rounded, c.decimal_places)).replace(/ /g, "\u00a0").replace(/-/g, "-\ufeff");
  return c.position === "before" ? `${c.symbol ?? ""}\u00a0${formatted}` : `${formatted}\u00a0${c.symbol ?? ""}`;
}

/**
 * account product.py:225-241 product.template._construct_tax_string(price): compute_all (account_tax.py:4849-4962)
 * of the customer taxes of env.company's branch chain (`_filter_taxes_by_company`, :4964-4977) without a partner,
 * labelled with the totals that differ from the price. Companies with branches and `force_price_include` refuse.
 */
async function constructTaxString(env: Environment, tmpl: Rec, price: number): Promise<string> {
  if ("force_price_include" in env.context) throw new NotPorted("tax_string with force_price_include");
  const taxes: { id: number; company: number | null }[] = [];
  for (const t of await tmpl.rels("taxes_id")) {
    if (t.origin === null) throw new NotPorted("tax_string with a new tax");
    const company = await t.get("company_id");
    taxes.push({ id: t.origin, company: typeof company === "number" ? company : null });
  }
  let selected: number[] = [];
  if (taxes.length) {
    for (let company: number | null = await env.company(); !selected.length && company;) {
      const c: number = company;
      selected = taxes.filter((t) => t.company === c).map((t) => t.id);
      company = (await env.cr.query<{ parent_id: number | null }>("SELECT parent_id FROM res_company WHERE id = $1", [c])).rows[0]?.parent_id ?? null;
    }
  }
  // compute_all: the company of the first tax (its accessible branches are refused), else env.company
  let companyId = await env.company();
  if (selected.length) {
    companyId = taxes.find((t) => t.id === selected[0])!.company ?? companyId;
    const related = (await env.cr.query("SELECT 1 FROM res_company WHERE parent_id = $1 OR (id = $1 AND parent_id IS NOT NULL)", [companyId])).rows.length;
    if (related) throw new NotPorted("tax_string for a company with branches (_accessible_branches)");
  }
  const company = await companyData(env, companyId);
  const taxRows = (await taxData(env, selected)).sort((a, b) => a.sequence - b.sequence || a.id - b.id);
  const base = accountTaxHelpers.prepare_base_line_for_taxes_computation({
    id: 0, tax_ids: taxRows, price_unit: price, quantity: 1, discount: 0, currency_id: company.currency_id, rate: 1,
    product_id: {}, product_uom_id: {}, document_tax_mode: null,
  });
  // account_tax.py:4909-4920 compute_all's base line, `product=self` the template (product.py:227-229)
  await checkBaseLine(env, base, async () => {
    const kwargs: Record<string, unknown> = { partner_id: new PrivateRecords("res.partner", []), currency_id: new PrivateRecords("res.currency", [company.currency_id.id]),
      product_id: tmpl.origin !== null ? new PrivateRecords(tmpl.def.name, [tmpl.origin]) : null, tax_ids: new PrivateRecords("account.tax", taxRows.map((t) => t.id)),
      price_unit: price, quantity: 1, is_refund: false, special_mode: false, document_tax_mode: null };
    if (tmpl.origin === null) throw new NotPorted("a compiled override of account.tax._prepare_base_line_for_taxes_computation on a new product's tax string");
    return { record: null, kwargs, loaded: { product_id: false, product_uom_id: false, partner_id: false, account_id: false, analytic_distribution: null, is_refund: false } };
  });
  accountTaxHelpers.add_tax_details_in_base_lines([base], company);
  const rounding = company.currency_id.rounding;
  const included = roundPrecision(base.tax_details.raw_total_included_currency, rounding);
  const excluded = roundPrecision(base.tax_details.raw_total_excluded_currency, rounding);
  // currency.compare_amounts with the template's currency
  let cur = await tmpl.get("currency_id");
  // a new record's currency (product_template.py:396 _compute_currency_id): the company's, else the main company's
  if ((typeof cur !== "number" || !cur) && !(await tmpl.get("company_id"))) cur = await mainCompanyCurrency(env);
  if (typeof cur !== "number" || !cur) throw new NotPorted("tax_string without a currency");
  const curData = await currencyData(env, cur);
  // float_utils.py float_compare / float_is_zero with precision_rounding
  const r = curData.rounding;
  const differs = (a: number, b: number): boolean => {
    const delta = roundPrecision(a, r) - roundPrecision(b, r);
    return !(delta === 0 || Math.abs(roundPrecision(delta, r)) < r);
  };
  const joined: string[] = [];
  // account product.py:233-236: account's `_('%(amount)s Incl. Taxes', amount=format_amount(...))`
  if (differs(included, price)) joined.push(translate(env, "%(amount)s Incl. Taxes", "account").replace("%(amount)s", await formatAmount(env, included, cur)));
  if (differs(excluded, price)) joined.push(translate(env, "%(amount)s Excl. Taxes", "account").replace("%(amount)s", await formatAmount(env, excluded, cur)));
  return joined.length ? `(= ${joined.join(", ")})` : " ";
}
defineComputes("product.template", {
  // account product.py:219-223 _compute_tax_string: of the list price
  tax_string: async (env, rec) => constructTaxString(env, rec, Number((await rec.get("list_price")) ?? 0)),
});
defineComputes("product.product", {
  // account product.py:449-453 _compute_tax_string: the template's string of the variant's lst_price
  tax_string: async (env, rec) => constructTaxString(env, (await rec.rel("product_tmpl_id")) ?? rec, Number((await rec.get("lst_price")) ?? 0)),
});
