/**
 * Sales (`sale.*`) & Products (`product.*`) UI button actions, wizards, and computes (Odoo 20 Community).
 * Each body cites its Odoo Python source.
 */
import { NotPorted, UserError, ValidationError } from "../errors";
import { registerMethod } from "../http/methods";
import { create } from "../orm/create";
import { floatRepr, floatRound, roundMonetary } from "../orm/convert";
import { and, cond, localMidnightToUtc, or, PyDate } from "../orm/domain";
import { envTz, hasGroup } from "../orm/env";
import { DbRec, NewRec, RecomputeQueue, recordCompute, registerDefaults, registerOnchange, registerRecordCompute, type Rec } from "../orm/recompute";
import { hasFieldAccess } from "../orm/sql";
import type { Environment, PyFloat } from "../orm/types";
import { pyFloat } from "../orm/values";
import { registerOverrides, write } from "../orm/write";
import { envFor } from "../web/common";
import { trackPrepare } from "../mail/tracking";
import { closeTrackingScope } from "../mail/write_hooks";
import { addPrecommit } from "./precommit";
import { accountTaxHelpers, floatIsZero, type BaseLine, type TaxCompany, type TaxCurrency, type TaxTotalsSummary } from "./account_tax_engine";
import { companyData, currencyData, pyFloats, taxData, withTaxEngineLabels } from "./account_taxes";
import { checkBaseLine, lineRecord, loadedOf, storedLine } from "./account_tax_hooks";
import { PrivateDatetime, privateNormal, PrivateRecords } from "../orm/private_hooks";
import * as priv from "../orm/dispatch_gen";
import { pyPercent } from "./ir_fields_converter";
import { selectSeller } from "./purchase_flow";
import { availableUoms, fiscalPositionFor } from "./sale_computes";
import { cancelOrders, findRule, type RuleRow } from "./sale_confirm";
import { orderLang, pyExtraTaxData } from "./sale_down_payment";
import { mapTax, taxesOfCompany, uomQuantity } from "./sale_flow";
import { actionConfirm } from "./stock_engine";
import { canCreate, defineComputes, filteredAccess, withCompany } from "./tail_util";
import { datetimeToString, dbNow, todayInTz, translate, validTz } from "./util";
import { pySplitlines } from "../mail/html2plaintext";

const idOf = (v: unknown): number | null => (typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : null);
const idsOf = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : []);
const numOf = (v: unknown): number => (typeof v === "object" && v !== null && "float" in v ? Number((v as { float: number }).float) : Number(v ?? 0));

function ensureOne(ids: readonly number[] | null, model: string): number {
  if (!ids || ids.length !== 1) throw new NotPorted(`ensure_one on ${model}(${(ids ?? []).join(", ")})`);
  return ids[0]!;
}

async function actionOf(env: Environment, xmlid: string): Promise<Record<string, unknown>> {
  const { loadAction } = await import("../controllers/action");
  return loadAction({ cursor: () => env.cr, context: env.context, uid: env.uid }, xmlid, env);
}

type ButtonFn = (env: Environment, ids: number[], kwargs: Record<string, unknown>) => Promise<unknown>;
function button(model: string, method: string, fn: ButtonFn, readonly = false): void {
  registerMethod(model, method, async (env0, ids, _args, kwargs0) => {
    const { env, kwargs } = envFor(env0, kwargs0);
    return fn(env, ids ?? [], kwargs);
  }, { apiModel: false, readonly });
}

// =================================================================================================================
// Global discount tax engine support on sale.order & sale.order.line (without editing account_taxes.ts)
// =================================================================================================================

interface GlobalDiscountTaxHelpers {
  prepare_global_discount_lines(
    baseLines: BaseLine[],
    company: TaxCompany,
    amountType: "percent" | "fixed",
    amount: number,
    opts?: { computation_key?: string; grouping_function?: (b: BaseLine) => Record<string, unknown> },
  ): BaseLine[];
  aggregate_base_lines_tax_details(baseLines: BaseLine[], groupingFn: (b: BaseLine, td: unknown) => unknown): [BaseLine, Record<string, unknown>][];
  aggregate_base_lines_aggregated_values(agg: [BaseLine, Record<string, unknown>][]): Record<string, {
    grouping_key: unknown;
    total_excluded_currency: number;
    tax_amount_currency: number;
    total_excluded: number;
    tax_amount: number;
  }>;
}
export const extendedTaxHelpers = accountTaxHelpers as unknown as typeof accountTaxHelpers & GlobalDiscountTaxHelpers;

const EXTRA_KEYS = new Set(["computation_key", "currency_id", "discount", "manual_tax_amounts", "manual_total_excluded", "manual_total_excluded_currency", "price_unit", "quantity", "rate"]);

/** Like account_taxes.ts extraTaxData, plus global_discount special_type (sale_order_line.py:1055-1066). */
export function saleExtraTaxData(extra: unknown, downpayment: boolean): { extra_tax_data: Record<string, unknown>; special_type: string | null } {
  const plain = (v: unknown): unknown => (v && typeof v === "object" && !Array.isArray(v)
    ? ("float" in (v as object) && Object.keys(v as object).length === 1 ? (v as { float: number }).float : Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, plain(x)])))
    : v);
  const data = extra && typeof extra === "object" && !Array.isArray(extra) ? plain(extra) as Record<string, unknown> : {};
  for (const k of Object.keys(data)) if (!EXTRA_KEYS.has(k)) throw new NotPorted(`extra_tax_data key ${k}`);
  const key = typeof data["computation_key"] === "string" ? data["computation_key"] : "";
  const isGlobal = key.startsWith("global_discount,");
  const manual = data["manual_tax_amounts"];
  if (!isGlobal && Object.keys(data).some((k) => k !== "computation_key") && !(manual && typeof manual === "object" && Object.keys(manual).length)) {
    throw new NotPorted("extra_tax_data without manual tax amounts");
  }
  const special = isGlobal ? "global_discount" : downpayment ? "down_payment" : null;
  return { extra_tax_data: data, special_type: special };
}

/** sale_order_line.py:1036-1060 `_prepare_base_line_for_taxes_computation` with global_discount support. */
export async function saleLineBaseAll(
  env: Environment,
  line: Rec,
  opts?: { quantity?: number; discount?: number },
): Promise<{ base: BaseLine; company: TaxCompany; docCompany: TaxCompany; currency: TaxCurrency }> {
  const extra = saleExtraTaxData(await line.get("extra_tax_data"), Boolean(await line.get("is_downpayment")));
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
  const qty = opts?.quantity ?? Number((await line.get("product_uom_qty")) ?? 0);
  const discount = opts?.discount ?? Number((await line.get("discount")) ?? 0);
  const base = accountTaxHelpers.prepare_base_line_for_taxes_computation({
    id: line.origin ?? 0,
    tax_ids: taxes,
    price_unit: Number((await line.get("price_unit")) ?? 0),
    quantity: qty,
    discount,
    currency_id: currency,
    rate,
    product_id: {},
    product_uom_id: {},
    document_tax_mode: typeof mode === "string" && mode ? mode : null,
    extra_tax_data: extra.extra_tax_data,
  }, { special_type: extra.special_type });
  await checkBaseLine(env, base, async () => {
    const partner = order ? await order.get("partner_id") : false;
    const kwargs: Record<string, unknown> = {
      tax_ids: new PrivateRecords("account.tax", [...taxIds]),
      quantity: qty,
      partner_id: new PrivateRecords("res.partner", typeof partner === "number" && partner ? [partner] : []),
      currency_id: new PrivateRecords("res.currency", currency.id ? [currency.id] : []),
      rate,
      name: (await line.get("name")) || false,
      document_tax_mode: typeof mode === "string" && mode ? mode : false,
      ...(extra.special_type ? { special_type: extra.special_type } : {}),
    };
    return { record: lineRecord("sale.order.line", line), kwargs, loaded: await loadedOf(line, kwargs, false) };
  });
  return { base, company, docCompany, currency };
}

// sale.order.line & sale.order tax computes live in account_taxes.ts (which natively supports global_discount,).

// =================================================================================================================
// 1. sale.order buttons (sale, sale_project, sale_purchase, sale_purchase_stock, sale_stock)
// =================================================================================================================

// sale/models/sale_order.py:1785-1786 action_lock (action_unlock is already in tail_buttons.ts)
button("sale.order", "action_lock", async (env, ids) => {
  await write(env, "sale.order", ids, { locked: true });
  return null;
});

// sale/models/sale_order.py:1505-1514 action_open_discount_wizard
button("sale.order", "action_open_discount_wizard", async (env, ids) => {
  ensureOne(ids, "sale.order");
  return {
    name: translate(env, "Discount", "sale"),
    type: "ir.actions.act_window",
    res_model: "sale.order.discount",
    views: [[false, "form"]],
    view_mode: "form",
    target: "new",
  };
}, true);

// sale_project/models/sale_order.py:257-284 action_view_milestone
button("sale.order", "action_view_milestone", async (env, ids) => {
  const id = ensureOne(ids, "sale.order");
  const [row] = await env.model("sale.order").read([id], ["project_ids", "order_line"], "");
  const projectIds = idsOf(row?.["project_ids"]);
  const defaultProject = projectIds[0] ?? false;
  const lineIds = idsOf(row?.["order_line"]);
  let defaultSaleLine: number | false = false;
  if (lineIds.length) {
    const lines = (await env.cr.query<{ id: number; is_service: boolean | null; product_id: number | null; sequence: number | null }>(
      "SELECT id, is_service, product_id, sequence FROM sale_order_line WHERE id = ANY($1::int[]) ORDER BY sequence, id", [lineIds])).rows;
    const prodDef = env.reg.model("product.product");
    for (const l of lines) {
      if (!l.is_service || !l.product_id) continue;
      const policy = await new DbRec(env, prodDef, l.product_id).get("service_policy");
      if (policy === "delivered_milestones") { defaultSaleLine = l.id; break; }
    }
  }
  const viewId = await env.reg.xmlid(env.cr, "sale_project.project_milestone_view_tree");
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Milestones", "sale_project"),
    domain: [["sale_line_id", "in", lineIds]],
    res_model: "project.milestone",
    views: [[viewId ?? false, "list"]],
    view_mode: "list",
    help: translate(env, `\n                <p class="o_view_nocontent_smiling_face">\n                    No milestones found. Let's create one!\n                </p><p>\n                    Track major progress points that must be reached to achieve success.\n                </p>\n            `, "sale_project"),
    context: {
      ...env.context,
      default_project_id: defaultProject,
      default_sale_line_id: defaultSaleLine,
    },
  };
});

// sale/models/sale_order.py:1924-1932 action_view_payment_transaction
button("sale.order", "action_view_payment_transaction", async (env, ids) => {
  const rows = ids.length ? await env.model("sale.order").read(ids, ["transaction_ids"], "") : [];
  const txIds: number[] = [];
  for (const r of rows) for (const tid of idsOf(r["transaction_ids"])) if (!txIds.includes(tid)) txIds.push(tid);
  const action = await actionOf(env, "payment.action_payment_transaction");
  if (txIds.length === 1) {
    action["view_mode"] = "form";
    action["res_id"] = txIds[0];
    action["views"] = [];
  } else {
    action["domain"] = [["id", "in", txIds]];
  }
  return action;
});

// sale_purchase/models/sale_order.py:34-55 + sale_purchase_stock/models/sale_order.py:14-15 action_view_purchase_orders
button("sale.order", "action_view_purchase_orders", async (env, ids) => {
  const id = ensureOne(ids, "sale.order");
  const hasStockRef = env.reg.model("sale.order").fields.has("stock_reference_ids");
  const fields = hasStockRef ? ["name", "order_line", "stock_reference_ids"] : ["name", "order_line"];
  const [row] = await env.model("sale.order").read([id], fields, "");
  const orderName = String(row?.["name"] ?? "");
  const poIds: number[] = [];
  const addPo = (poId: number | null) => { if (poId !== null && !poIds.includes(poId)) poIds.push(poId); };
  const lineIds = idsOf(row?.["order_line"]);
  if (lineIds.length) {
    const lineRows = await env.model("sale.order.line").read(lineIds, ["purchase_line_ids"], "");
    const plIds: number[] = [];
    for (const lr of lineRows) for (const plid of idsOf(lr["purchase_line_ids"])) if (!plIds.includes(plid)) plIds.push(plid);
    if (plIds.length) {
      for (const pl of await env.model("purchase.order.line").read(plIds, ["order_id"], "")) addPo(idOf(pl["order_id"]));
    }
  }
  if (hasStockRef) {
    const refIds = idsOf(row?.["stock_reference_ids"]);
    if (refIds.length) {
      for (const ref of await env.model("stock.reference").read(refIds, ["purchase_ids"], "")) {
        for (const poId of idsOf(ref["purchase_ids"])) addPo(poId);
      }
    }
  }
  const action: Record<string, unknown> = {
    res_model: "purchase.order",
    type: "ir.actions.act_window",
  };
  if (poIds.length === 1) {
    action["view_mode"] = "form";
    action["res_id"] = poIds[0];
  } else {
    action["name"] = pyPercent(translate(env, "Purchase Order generated from %s", "sale_purchase"), [orderName]);
    action["domain"] = [["id", "in", poIds]];
    action["view_mode"] = "list,form";
  }
  return action;
});

// =================================================================================================================
// 2. sale.order.discount wizard (sale/wizard/sale_order_discount.py)
// =================================================================================================================

registerDefaults("sale.order.discount", {
  sale_order_id: async (env) => env.context["active_id"] ?? false,
  discount_type: async () => "sol_discount",
});

async function checkDiscountAmount(env: Environment, ids: readonly number[]): Promise<void> {
  if (!ids.length) return;
  const rows = (await env.cr.query<{ discount_type: string | null; discount_percentage: number | null }>(
    "SELECT discount_type, discount_percentage::float8 AS discount_percentage FROM sale_order_discount WHERE id = ANY($1::int[])", [[...ids]])).rows;
  for (const r of rows) {
    if ((r.discount_type === "sol_discount" || r.discount_type === "so_discount") && (r.discount_percentage ?? 0) > 1.0) {
      throw new ValidationError(translate(env, "Invalid discount amount", "sale"));
    }
  }
}

registerOverrides("sale.order.discount", {
  create: async (env, valsList, next) => {
    const ids = await next(env, valsList);
    await checkDiscountAmount(env, ids);
    return ids;
  },
  write: async (env, ids, vals, next) => {
    await next(env, ids, vals);
    await checkDiscountAmount(env, ids);
  },
});

async function getDiscountProduct(env: Environment, companyId: number): Promise<number> {
  const existing = (await env.cr.query<{ p: number | null }>("SELECT sale_discount_product_id AS p FROM res_company WHERE id = $1", [companyId])).rows[0]?.p ?? null;
  if (existing) return existing;
  const companyField = env.reg.model("res.company").fields.get("sale_discount_product_id");
  const okCreate = await canCreate(env, "product.product");
  const okCompanyWrite = (await filteredAccess(env, "res.company", [companyId], "write")).has(companyId);
  const okFieldWrite = companyField ? await hasFieldAccess(env, companyField) : false;
  if (!okCreate || !okCompanyWrite || !okFieldWrite) {
    throw new ValidationError(translate(env,
      "There does not seem to be any discount product configured for this company yet. You can either use a per-line discount, or ask an administrator to grant the discount the first time.",
      "sale"));
  }
  const vals: Record<string, unknown> = {
    name: translate(env, "Discount", "sale"),
    type: "service",
    invoice_policy: "order",
    list_price: 0.0,
    company_id: companyId,
    taxes_id: [[5, 0, 0]],
  };
  const svcCateg = await env.reg.xmlid(env.cr, "product.product_category_services");
  if (svcCateg) vals["categ_id"] = svcCateg;
  const [prodId] = await create(env, "product.product", [vals]);
  await write(env, "res.company", [companyId], { sale_discount_product_id: prodId! });
  return prodId!;
}

// sale/wizard/sale_order_discount.py:166-172 action_apply_discount
button("sale.order.discount", "action_apply_discount", async (env, ids) => {
  const id = ensureOne(ids, "sale.order.discount");
  const [wiz] = await env.model("sale.order.discount").read([id], ["sale_order_id", "company_id", "discount_type", "discount_percentage", "discount_amount"], "");
  if (!wiz) throw new NotPorted(`sale.order.discount(${id}) missing`);
  const orderId = idOf(wiz["sale_order_id"]);
  if (orderId === null) throw new ValidationError(translate(env, "Sale Order is required", "sale"));
  const companyId = idOf(wiz["company_id"]) ?? await env.company();
  const cenv = await withCompany(env, companyId);
  const discountType = String(wiz["discount_type"] ?? "sol_discount");
  const discountPct = numOf(wiz["discount_percentage"]);
  const discountAmt = numOf(wiz["discount_amount"]);

  // _get_discountable_order_lines: order_line.filtered(lambda line: not line.display_type)
  const orderLines = (await cenv.cr.query<{ id: number }>(
    "SELECT id FROM sale_order_line WHERE order_id = $1 AND display_type IS NULL ORDER BY sequence, id", [orderId])).rows.map((r) => r.id);

  if (discountType === "sol_discount") {
    if (orderLines.length) await write(cenv, "sale.order.line", orderLines, { discount: discountPct * 100 });
    return null;
  }

  // _create_discount_lines (:130-164)
  const lang = await orderLang(cenv, orderId);
  const lenv = cenv.withContext({ ...cenv.context, lang });
  const discountProductId = await getDiscountProduct(lenv, companyId);
  const amountType: "percent" | "fixed" = discountType === "so_discount" ? "percent" : "fixed";
  const amount = discountType === "so_discount" ? discountPct * 100.0 : discountAmt;

  const lineDef = lenv.reg.model("sale.order.line");
  const baseLines: BaseLine[] = [];
  for (const lid of orderLines) {
    const { base } = await saleLineBaseAll(lenv, new DbRec(lenv, lineDef, lid));
    baseLines.push(base);
  }
  const orderCompanyId = (await lenv.cr.query<{ c: number }>("SELECT company_id AS c FROM sale_order WHERE id = $1", [orderId])).rows[0]!.c;
  const orderCompany = await companyData(lenv, orderCompanyId);
  const wizCompany = await companyData(lenv, companyId);
  accountTaxHelpers.add_tax_details_in_base_lines(baseLines, orderCompany);
  accountTaxHelpers.round_base_lines_tax_details(baseLines, orderCompany);

  const globalLines = extendedTaxHelpers.prepare_global_discount_lines(
    baseLines,
    wizCompany,
    amountType,
    amount,
    {
      computation_key: `global_discount,${id}`,
      grouping_function: () => ({ product_id: discountProductId }),
    },
  );

  // _prepare_global_discount_so_lines (:57-98)
  const discountDp = (await lenv.cr.query<{ d: number }>("SELECT digits AS d FROM decimal_precision WHERE name = 'Discount'")).rows[0]?.d ?? 2;
  const rawLines = globalLines as unknown as {
    product_id: number;
    price_unit: number;
    quantity: number;
    tax_ids: { id: number; name: string }[];
  }[];
  const taxCombos = new Set(
    rawLines
      .filter((b) => b.tax_ids.length > 0)
      .map((b) => b.tax_ids.map((t) => t.id).join(",")),
  );
  const hasMultipleTaxCombinations = taxCombos.size > 1;
  const pctRepr = floatRepr(discountPct * 100.0, discountDp);

  const lineCommands: unknown[] = [];
  for (const [i, b] of rawLines.entries()) {
    const taxNames = b.tax_ids.map((t) => t.name).join(", ");
    let desc: string;
    if (hasMultipleTaxCombinations) {
      if (discountType === "so_discount") {
        desc = pyPercent(translate(lenv, "Discount %(percent)s%%- On products with the following taxes %(taxes)s", "sale"), { percent: pctRepr, taxes: taxNames });
      } else {
        desc = pyPercent(translate(lenv, "Discount- On products with the following taxes %(taxes)s", "sale"), { taxes: taxNames });
      }
    } else if (discountType === "so_discount") {
      desc = pyPercent(translate(lenv, "Discount %(percent)s%%", "sale"), { percent: pctRepr });
    } else {
      desc = translate(lenv, "Discount", "sale");
    }
    lineCommands.push([0, 0, {
      name: desc,
      product_id: discountProductId,
      price_unit: b.price_unit,
      technical_price_unit: 0,
      product_uom_qty: b.quantity,
      tax_ids: [[6, 0, b.tax_ids.map((t) => t.id)]],
      extra_tax_data: pyExtraTaxData(accountTaxHelpers.export_base_line_extra_tax_data(globalLines[i]!)),
      sequence: 999,
    }]);
  }
  if (lineCommands.length) {
    await write(lenv, "sale.order", [orderId], { order_line: lineCommands });
  }
  return null;
});

// =================================================================================================================
// 3. sale.mass.cancel.orders wizard (sale/wizard/mass_cancel_orders.py)
// =================================================================================================================

registerDefaults("sale.mass.cancel.orders", {
  sale_order_ids: async (env) => {
    const active = env.context["active_ids"];
    return Array.isArray(active) ? [[6, 0, active.filter((x): x is number => typeof x === "number")]] : [[6, 0, []]];
  },
});

defineComputes("sale.mass.cancel.orders", {
  sale_orders_count: async (_env, rec) => (await rec.rels("sale_order_ids")).length,
  has_confirmed_order: async (_env, rec) => {
    for (const so of await rec.rels("sale_order_ids")) {
      const state = await so.get("state");
      if (state === "sale" || state === "done") return true;
    }
    return false;
  },
});

button("sale.mass.cancel.orders", "action_mass_cancel", async (env, ids) => {
  const rows = ids.length ? await env.model("sale.mass.cancel.orders").read(ids, ["sale_order_ids"], "") : [];
  const orderIds: number[] = [];
  for (const r of rows) for (const oid of idsOf(r["sale_order_ids"])) if (!orderIds.includes(oid)) orderIds.push(oid);
  if (orderIds.length) await cancelOrders(env, orderIds);
  return null;
});

// =================================================================================================================
// 4. Product catalog actions (sale.order, sale.order.line, sale.order.template, sale.order.template.line)
// =================================================================================================================

async function productCatalogAction(
  env: Environment,
  model: "sale.order" | "sale.order.template",
  ids: readonly number[],
): Promise<Record<string, unknown>> {
  const id = ensureOne(ids, model);
  const childField = env.context["child_field"];
  if (!childField || typeof childField !== "string") {
    throw new ValidationError(translate(env, "Catalog missing the child field to update.", "product"));
  }
  if (!env.reg.model(model).fields.has(childField)) {
    throw new ValidationError(translate(env, "Wrong catalog child field!", "product"));
  }
  const kanbanViewId = await env.reg.xmlid(env.cr, "product.product_view_kanban_catalog");
  const searchViewId = await env.reg.xmlid(env.cr, "product.product_view_search_catalog");
  const envCompanyId = await env.company();
  const companyCurrency = async (cid: number): Promise<number | false> =>
    (await env.cr.query<{ c: number | null }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [cid])).rows[0]?.c ?? false;

  let additionalContext: Record<string, unknown>;
  let domain: unknown[];

  if (model === "sale.order") {
    const hasSaleStock = env.reg.model("sale.order").fields.has("warehouse_id");
    const fields = hasSaleStock ? ["company_id", "currency_id", "partner_id", "warehouse_id"] : ["company_id", "currency_id", "partner_id"];
    const [row] = await env.model("sale.order").read([id], fields, "");
    const companyId = idOf(row?.["company_id"]) ?? false;
    const currencyId = idOf(row?.["currency_id"]) ?? await companyCurrency(envCompanyId);
    const partnerId = idOf(row?.["partner_id"]) ?? false;
    additionalContext = {
      product_catalog_order_id: id,
      product_catalog_order_model: "sale.order",
      product_catalog_currency_id: currencyId,
      show_prices: true,
      show_sections: true,
      order_customer_id: partnerId,
      // sale_order_line.py:220 price_unit uses min_display_digits (not digits), so get_digits(env) returns None -> false
      product_catalog_digits: false,
      ...(hasSaleStock ? { warehouse_id: idOf(row?.["warehouse_id"]) ?? false, display_stock: true } : {}),
    };
    // product_catalog_mixin.py:54-56 & sale_order.py:2694
    // (Domain("company_id", "=", False) | Domain("company_id", "parent_of", self.company_id.id)) & Domain("type", "!=", "combo") & Domain("sale_ok", "=", True)
    domain = [
      "&", "&",
      "|", ["company_id", "=", false], ["company_id", "parent_of", companyId],
      ["type", "!=", "combo"],
      ["sale_ok", "=", true],
    ];
  } else {
    const [row] = await env.model("sale.order.template").read([id], ["company_id", "currency_id"], "");
    const companyId = idOf(row?.["company_id"]);
    let currencyId: number | false = idOf(row?.["currency_id"]) ?? false;
    if (!currencyId && companyId) currencyId = await companyCurrency(companyId);
    if (!currencyId) currencyId = await companyCurrency(envCompanyId);
    additionalContext = {
      product_catalog_order_id: id,
      product_catalog_order_model: "sale.order.template",
      product_catalog_currency_id: currencyId,
      show_sections: true,
    };
    // product_catalog_mixin.py:54-56 & sale_order_template.py:407-410 & sale_order_template_line.py:353
    // super() & Domain([("sale_ok", "=", True), ("type", "!=", "combo")])
    domain = [
      "&", "&", "&",
      "|", ["company_id", "=", false], ["company_id", "parent_of", companyId ?? false],
      ["type", "!=", "combo"],
      ["sale_ok", "=", true],
      ["type", "!=", "combo"],
    ];
  }

  const context: Record<string, unknown> = { ...env.context, ...additionalContext };
  delete context["form_view_ref"];
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Products", "product"),
    res_model: "product.product",
    views: [[kanbanViewId ?? false, "kanban"], [false, "form"]],
    search_view_id: [searchViewId ?? false, "search"],
    domain,
    context,
  };
}

button("sale.order", "action_add_from_catalog", async (env, ids) => productCatalogAction(env, "sale.order", ids), true);
button("sale.order.line", "action_add_from_catalog", async (env) => {
  const orderId = env.context["order_id"];
  const ids = typeof orderId === "number" && orderId ? [orderId] : [];
  return productCatalogAction(env.withContext({ ...env.context, child_field: "order_line" }), "sale.order", ids);
}, true);
button("sale.order.template", "action_add_from_catalog", async (env, ids) => productCatalogAction(env, "sale.order.template", ids), true);
button("sale.order.template.line", "action_add_from_catalog", async (env) => {
  const tmplId = env.context["order_id"];
  const ids = typeof tmplId === "number" && tmplId ? [tmplId] : [];
  return productCatalogAction(env.withContext({ ...env.context, child_field: "sale_order_template_line_ids" }), "sale.order.template", ids);
}, true);

// =================================================================================================================
// 5. product.* simple UI actions
// =================================================================================================================

// product/models/product_template_attribute_line.py:269-283 action_open_attribute_values
button("product.template.attribute.line", "action_open_attribute_values", async (env, ids) => {
  const rows = ids.length ? await env.model("product.template.attribute.line").read(ids, ["attribute_id", "product_template_value_ids"], "") : [];
  const attrIds = [...new Set(rows.map((r) => idOf(r["attribute_id"])).filter((x): x is number => x !== null))];
  if (attrIds.length > 1) throw new NotPorted("product.template.attribute.line.action_open_attribute_values with several attributes");
  const attrName = attrIds.length === 1
    ? ((await env.model("product.attribute").read(attrIds, ["name"], ""))[0]?.["name"] ?? false)
    : false;
  const ptavIds: number[] = [];
  for (const r of rows) for (const vid of idsOf(r["product_template_value_ids"])) if (!ptavIds.includes(vid)) ptavIds.push(vid);
  const viewId = await env.reg.xmlid(env.cr, "product.product_template_attribute_value_view_tree");
  return {
    type: "ir.actions.act_window",
    name: attrName,
    res_model: "product.template.attribute.value",
    view_mode: "list,form",
    domain: [["id", "in", ptavIds]],
    views: [[viewId ?? false, "list"]],
    context: {
      search_default_active: 1,
      product_invisible: true,
    },
  };
}, true);

// product/models/product_template.py:1026-1035 action_open_packaging_barcodes
button("product.template", "action_open_packaging_barcodes", async (env, ids) => {
  const id = ensureOne(ids, "product.template");
  const [row] = await env.model("product.template").read([id], ["product_variant_ids"], "");
  const variants = idsOf(row?.["product_variant_ids"]);
  const action = await actionOf(env, "product.product_uom_action_view_list");
  action["domain"] = [["product_id", "in", variants]];
  action["context"] = {
    default_product_id: variants[0] ?? false,
    product_ids: variants,
  };
  return action;
});

// product/models/product_product.py:1245-1254 action_open_packaging_barcodes
button("product.product", "action_open_packaging_barcodes", async (env, ids) => {
  const id = ensureOne(ids, "product.product");
  const action = await actionOf(env, "product.product_uom_action_view_list");
  action["domain"] = [["product_id", "=", id]];
  action["context"] = {
    create: true,
    default_product_id: id,
    product_ids: [id],
  };
  return action;
});

// product/models/uom_uom.py:21-32 action_open_packaging_barcodes
button("uom.uom", "action_open_packaging_barcodes", async (env, ids) => {
  const id = ensureOne(ids, "uom.uom");
  const productIds = env.context["product_ids"];
  const domain = Array.isArray(productIds) && productIds.length
    ? ["&", ["uom_id", "=", id], ["product_id", "in", productIds]]
    : [["uom_id", "=", id]];
  const action = await actionOf(env, "product.product_uom_action_view_list");
  action["domain"] = domain;
  action["context"] = {
    ...env.context,
    default_uom_id: id,
  };
  return action;
});

// stock/models/product.py:990-997, 1214-1221, 620-627 action_view_related_putaway_rules
function putawayAction(env: Environment, domain: unknown[]): Record<string, unknown> {
  return {
    name: translate(env, "Putaway Rules", "stock"),
    type: "ir.actions.act_window",
    res_model: "stock.putaway.rule",
    view_mode: "list",
    domain,
  };
}

button("product.template", "action_view_related_putaway_rules", async (env, ids) => {
  const id = ensureOne(ids, "product.template");
  const [row] = await env.model("product.template").read([id], ["categ_id"], "");
  const categId = idOf(row?.["categ_id"]) ?? false;
  return putawayAction(env, ["|", ["product_id.product_tmpl_id", "=", id], ["category_id", "parent_of", categId]]);
});

button("product.product", "action_view_related_putaway_rules", async (env, ids) => {
  const id = ensureOne(ids, "product.product");
  const [row] = await env.model("product.product").read([id], ["product_tmpl_id"], "");
  const tmplId = idOf(row?.["product_tmpl_id"]);
  const categId = tmplId !== null ? (idOf((await env.model("product.template").read([tmplId], ["categ_id"], ""))[0]?.["categ_id"]) ?? false) : false;
  return putawayAction(env, ["|", ["product_id", "=", id], ["category_id", "parent_of", categId]]);
});

// stock/models/product.py:629-639, 1223-1225 action_view_storage_category_capacity
async function storageCategoryCapacityAction(env: Environment, productIds: readonly number[]): Promise<Record<string, unknown>> {
  const action = await actionOf(env, "stock.action_storage_category_capacity");
  const context: Record<string, unknown> = { hide_package_type: true };
  if (productIds.length === 1) context["default_product_id"] = productIds[0];
  action["context"] = context;
  action["domain"] = [["product_id", "in", [...productIds]]];
  return action;
}

button("product.product", "action_view_storage_category_capacity", async (env, ids) => storageCategoryCapacityAction(env, ids));

button("product.template", "action_view_storage_category_capacity", async (env, ids) => {
  const id = ensureOne(ids, "product.template");
  const [row] = await env.model("product.template").read([id], ["product_variant_ids"], "");
  return storageCategoryCapacityAction(env, idsOf(row?.["product_variant_ids"]));
});

// product/models/product_attribute_value.py:153-180 action_add_to_products & action_update_prices
button("product.attribute.value", "action_add_to_products", async (env, ids) => {
  const id = ids.length === 1 ? ids[0]! : ids.length === 0 ? false : ensureOne(ids, "product.attribute.value");
  return {
    name: translate(env, "Add to all products", "product"),
    type: "ir.actions.act_window",
    res_model: "update.product.attribute.value",
    view_mode: "form",
    target: "new",
    context: {
      default_attribute_value_id: id,
      default_mode: "add",
      dialog_size: "medium",
    },
  };
}, true);

button("product.attribute.value", "action_update_prices", async (env, ids) => {
  const id = ids.length === 1 ? ids[0]! : ids.length === 0 ? false : ensureOne(ids, "product.attribute.value");
  return {
    name: translate(env, "Update product extra prices", "product"),
    type: "ir.actions.act_window",
    res_model: "update.product.attribute.value",
    view_mode: "form",
    target: "new",
    context: {
      default_attribute_value_id: id,
      default_mode: "update_extra_price",
      dialog_size: "medium",
    },
  };
}, true);

// product/wizard/update_product_attribute_value.py
registerDefaults("update.product.attribute.value", {});

defineComputes("update.product.attribute.value", {
  product_count: async (env, rec) => {
    const mode = await rec.get("mode");
    const pav = await rec.rel("attribute_value_id");
    if (!pav) return 0;
    if (mode === "add") {
      const attrId = idOf(await pav.get("attribute_id"));
      return env.model("product.template").searchCount(cond("attribute_line_ids.attribute_id", "=", attrId ?? false));
    }
    if (mode === "update_extra_price") {
      return env.model("product.template").searchCount(cond("attribute_line_ids.value_ids", "=", pav.origin ?? false));
    }
    return 0;
  },
  message: async (env, rec) => {
    const mode = await rec.get("mode");
    const count = Number((await rec.get("product_count")) ?? 0);
    if (mode === "add") {
      const pav = await rec.rel("attribute_value_id");
      const name = pav ? String((await pav.get("name")) ?? "False") : "False";
      return pyPercent(translate(env, 'You are about to add the value "%(attribute_value)s" to %(product_count)s products.', "product"), {
        attribute_value: name,
        product_count: count,
      });
    }
    if (mode === "update_extra_price") {
      return pyPercent(translate(env, "You are about to update the extra price of %s products.", "product"), [count]);
    }
    return "";
  },
});

button("update.product.attribute.value", "action_confirm", async (env, ids) => {
  const id = ensureOne(ids, "update.product.attribute.value");
  const [wiz] = await env.model("update.product.attribute.value").read([id], ["attribute_value_id", "mode"], "");
  const pavId = idOf(wiz?.["attribute_value_id"]);
  const mode = wiz?.["mode"];
  if (pavId === null) return null;
  const companies = [...await env.companies(), false];
  if (mode === "add") {
    const [pav] = await env.model("product.attribute.value").read([pavId], ["attribute_id"], "");
    const attrId = idOf(pav?.["attribute_id"]);
    const ptals = await env.model("product.template.attribute.line").search(and([
      cond("attribute_id", "=", attrId ?? false),
      cond("product_tmpl_id.company_id", "in", companies),
    ]));
    if (ptals.length) await write(env, "product.template.attribute.line", ptals, { value_ids: [[4, pavId, 0]] });
  } else if (mode === "update_extra_price") {
    const [pav] = await env.model("product.attribute.value").read([pavId], ["default_extra_price"], "");
    const priceExtra = numOf(pav?.["default_extra_price"]);
    const ptavs = await env.model("product.template.attribute.value").search(and([
      cond("product_attribute_value_id", "=", pavId),
      cond("product_tmpl_id.company_id", "in", companies),
    ]));
    if (ptavs.length) await write(env, "product.template.attribute.value", ptavs, { price_extra: priceExtra });
  }
  return null;
});

// product/models/product_pricelist.py:493-499 action_open_pricelist_report
button("product.pricelist", "action_open_pricelist_report", async (env, ids) => {
  ensureOne(ids, "product.pricelist");
  return {
    name: translate(env, "Pricelist Report Preview", "product"),
    type: "ir.actions.client",
    tag: "generate_pricelist_report",
  };
}, true);

// product/models/product_pricelist.py:516-533 action_open_daily_rates
button("product.pricelist", "action_open_daily_rates", async (env, ids) => {
  const id = ensureOne(ids, "product.pricelist");
  const viewId = await env.reg.xmlid(env.cr, "product.product_pricelist_item_calendar");
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Daily Rates", "product"),
    res_model: "product.pricelist.item",
    view_mode: "calendar,form",
    views: [
      [viewId ?? false, "calendar"],
      [false, "form"],
    ],
    domain: [
      ["pricelist_id", "=", id],
      ["date_start", "!=", false],
      ["date_end", "!=", false],
    ],
    context: { default_pricelist_id: id },
  };
});

// product/models/product_template_attribute_value.py:210-217 action_edit_product_attribute_value
button("product.template.attribute.value", "action_edit_product_attribute_value", async (env, ids) => {
  const rows = ids.length ? await env.model("product.template.attribute.value").read(ids, ["product_attribute_value_id"], "") : [];
  const pavIds = [...new Set(rows.map((r) => idOf(r["product_attribute_value_id"])).filter((x): x is number => x !== null))];
  if (pavIds.length > 1) throw new NotPorted("product.template.attribute.value.action_edit_product_attribute_value with several values");
  return {
    type: "ir.actions.act_window",
    res_model: "product.attribute.value",
    res_id: pavIds[0] ?? false,
    view_mode: "form",
    target: "new",
  };
}, true);

// stock_account/models/product_value.py:123-131 action_open_account_move
button("product.value", "action_open_account_move", async (env, ids) => {
  const id = ensureOne(ids, "product.value");
  const [row] = await env.model("product.value").read([id], ["account_move_id"], "");
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Journal Entry", "stock_account"),
    res_model: "account.move",
    res_id: idOf(row?.["account_move_id"]) ?? false,
    view_mode: "form",
  };
});

// =================================================================================================================
// 6. product.supplierinfo.action_set_supplier + stock.replenishment.info support
// =================================================================================================================

registerDefaults("stock.replenishment.info", {
  based_on: async () => "one_month",
  percent_factor: async () => 100,
});

// stock.replenishment.info inverses/supplierinfo_ids and stock.warehouse.orderpoint inverses live in sweep_purchase_stock.ts.

async function openOrderpointReplenishmentInfo(env: Environment, orderpointId: number): Promise<Record<string, unknown>> {
  const [op] = await env.model("stock.warehouse.orderpoint").read([orderpointId], ["product_id", "warehouse_id", "min_max_based_on", "min_max_based_on_factor"], "");
  const prodId = idOf(op?.["product_id"]);
  const whId = idOf(op?.["warehouse_id"]);
  const prodName = prodId !== null ? ((await env.model("product.product").displayName([prodId])).get(prodId) ?? "") : "";
  const whName = whId !== null ? ((await env.model("stock.warehouse").displayName([whId])).get(whId) ?? "") : "";
  const action = await actionOf(env, "stock.action_stock_replenishment_info");
  action["name"] = pyPercent(translate(env, "Replenishment Information for %(product)s in %(warehouse)s", "stock"), {
    product: prodName,
    warehouse: whName,
  });
  const [infoId] = await create(env, "stock.replenishment.info", [{
    orderpoint_id: orderpointId,
    based_on: op?.["min_max_based_on"] || "one_month",
    percent_factor: Number(op?.["min_max_based_on_factor"] ?? 100),
  }]);
  action["res_id"] = infoId!;
  return action;
}

// purchase_stock/models/product.py:307-337 action_set_supplier
button("product.supplierinfo", "action_set_supplier", async (env, ids) => {
  const id = ensureOne(ids, "product.supplierinfo");
  const orderpointId = idOf(env.context["orderpoint_id"]);
  if (orderpointId === null) return null;
  const [op] = await env.model("stock.warehouse.orderpoint").read([orderpointId], ["route_id", "company_id", "product_id", "qty_to_order"], "");
  const routeId = idOf(op?.["route_id"]);
  const companyId = idOf(op?.["company_id"]);
  let hasBuyAction = false;
  if (routeId !== null) {
    hasBuyAction = (await env.cr.query("SELECT 1 FROM stock_rule WHERE route_id = $1 AND active AND action = 'buy' LIMIT 1", [routeId])).rows.length > 0;
  }
  if (!hasBuyAction) {
    const buyRules = await env.model("stock.rule").search(and([
      cond("action", "=", "buy"),
      or([cond("company_id", "=", companyId ?? false), cond("company_id", "=", false)]),
    ]), { limit: 1 });
    const buyRouteId = buyRules.length
      ? idOf((await env.model("stock.rule").read(buyRules, ["route_id"], ""))[0]?.["route_id"])
      : null;
    await write(env, "stock.warehouse.orderpoint", [orderpointId], { route_id: buyRouteId ?? false });
  }
  await write(env, "stock.warehouse.orderpoint", [orderpointId], { supplier_id: id });
  const [seller] = await env.model("product.supplierinfo").read([id], ["uom_id", "min_qty"], "");
  const prodId = idOf(op?.["product_id"]);
  const prodUomId = prodId !== null ? idOf((await env.model("product.product").read([prodId], ["uom_id"], ""))[0]?.["uom_id"]) : null;
  const supplierMinQty = await uomQuantity(env, numOf(seller?.["min_qty"]), idOf(seller?.["uom_id"]), prodUomId);
  const [opAfter] = await env.model("stock.warehouse.orderpoint").read([orderpointId], ["qty_to_order", "qty_to_order_computed", "trigger"], "");
  const currentQtyToOrder = numOf(opAfter?.["qty_to_order"]);
  if (currentQtyToOrder < supplierMinQty) {
    // stock_orderpoint.py:435-442 `_inverse_qty_to_order`
    const trigger = String(opAfter?.["trigger"] ?? "auto");
    if (trigger === "auto") {
      await write(env, "stock.warehouse.orderpoint", [orderpointId], { qty_to_order_manual: 0 });
    } else if (supplierMinQty !== numOf(opAfter?.["qty_to_order_computed"])) {
      await write(env, "stock.warehouse.orderpoint", [orderpointId], { qty_to_order_manual: supplierMinQty });
    }
  }
  const replenishId = idOf(env.context["replenish_id"]);
  if (replenishId !== null) {
    await write(env, "product.replenish", [replenishId], { supplier_id: id });
    return {
      type: "ir.actions.act_window",
      name: "Replenish",
      res_model: "product.replenish",
      res_id: replenishId,
      target: "new",
      view_mode: "form",
    };
  }
  return openOrderpointReplenishmentInfo(env, orderpointId);
});

// =================================================================================================================
// 7. product.replenish wizard (stock/wizard/product_replenish.py + purchase_stock/wizard/product_replenish.py)
// =================================================================================================================

const shiftDays = (dt: string, days: number): string =>
  datetimeToString(new Date(Date.parse(`${dt.replace(" ", "T")}Z`) + Math.round(days * 86400000)));

async function hasConfirmedPurchase(env: Environment, productIds: readonly number[], companyId: number | null): Promise<boolean> {
  if (!productIds.length) return false;
  const companies = companyId !== null ? [companyId] : [...await env.companies()];
  const count = await env.sudo().model("purchase.order.line").searchCount(and([
    cond("product_id", "in", [...productIds]),
    cond("order_id.state", "=", "purchase"),
    cond("order_id.date_approve", "!=", false),
    cond("order_id.company_id", "in", companies),
  ]));
  return count > 0;
}

async function allowedRouteDomain(env: Environment, warehouseId: number | null, productId: number | null) {
  const interCompanyId = await env.reg.xmlid(env.cr, "stock.stock_location_inter_company");
  let base = cond("product_selectable", "=", true);
  if (warehouseId !== null && productId !== null) {
    const whRoutes = idsOf((await env.model("stock.warehouse").read([warehouseId], ["route_ids"], ""))[0]?.["route_ids"]);
    const validWhRoutes: number[] = [];
    if (whRoutes.length) {
      const buyRoutes = new Set((await env.cr.query<{ r: number }>(
        "SELECT DISTINCT route_id AS r FROM stock_rule WHERE route_id = ANY($1::int[]) AND active AND action = 'buy'", [whRoutes])).rows.map((r) => r.r));
      const hasSellers = (await env.cr.query(
        `SELECT 1 FROM product_supplierinfo s JOIN product_product p ON p.product_tmpl_id = s.product_tmpl_id
          WHERE p.id = $1 AND (s.product_id IS NULL OR s.product_id = $1) LIMIT 1`, [productId])).rows.length > 0;
      const confirmed = hasSellers ? true : await hasConfirmedPurchase(env, [productId], null);
      for (const r of whRoutes) if (buyRoutes.has(r) && confirmed) validWhRoutes.push(r);
    }
    if (validWhRoutes.length) base = or([base, cond("id", "in", validWhRoutes)]);
  }
  return and([
    base,
    cond("rule_ids.location_src_id", "!=", interCompanyId ?? false),
    cond("rule_ids.location_dest_id", "!=", interCompanyId ?? false),
    cond("rule_ids.location_dest_id.warehouse_id", "!=", false),
  ]);
}

async function resolveReplenishSupplier(
  env: Environment,
  companyId: number,
  productId: number,
  partnerId: number | null,
  qty: number,
  uomId: number | null,
  dateDay?: string,
) {
  const cenv = env.withContext({ ...env.context, allowed_company_ids: [companyId] });
  const product = new DbRec(cenv, cenv.reg.model("product.product"), productId);
  const ctxToday = todayInTz(await dbNow(env), await envTz(env));
  const day = dateDay ?? ctxToday;
  const pick = (o: { quantity: number | null; date: string; uom: number | null; params?: false }) =>
    selectSeller(cenv, product, {
      company: companyId,
      partner: partnerId,
      date: o.date,
      quantity: o.quantity,
      uom: o.uom,
      forceUom: o.params !== false,
      envCompany: companyId,
      params: o.params ?? { force_uom: true },
    });
  return (await pick({ quantity: qty, date: day, uom: uomId }))
    ?? (await pick({ quantity: null, date: day, uom: uomId }))
    ?? (await pick({ quantity: null, date: ctxToday, uom: uomId }))
    ?? (await pick({ quantity: null, date: ctxToday, uom: null }))
    ?? (await pick({ quantity: null, date: ctxToday, uom: null, params: false }));
}

async function routeHasBuy(env: Environment, routeId: number | null): Promise<boolean> {
  if (routeId === null) return false;
  return (await env.cr.query("SELECT 1 FROM stock_rule WHERE route_id = $1 AND active AND action = 'buy' LIMIT 1", [routeId])).rows.length > 0;
}

registerDefaults("product.replenish", {
  product_has_variants: async () => false,
  quantity: async () => 1,
});

registerOverrides("product.replenish", {
  defaultGet: async (env, fields, defaults) => {
    let tmplId: number | null = null;
    const ctxProd = idOf(env.context["default_product_id"]);
    const ctxTmpl = idOf(env.context["default_product_tmpl_id"]);
    if (ctxProd !== null) {
      const [p] = await env.model("product.product").read([ctxProd], ["product_tmpl_id"], "");
      tmplId = idOf(p?.["product_tmpl_id"]);
      if (fields.includes("product_id")) {
        defaults["product_tmpl_id"] = tmplId ?? false;
        defaults["product_id"] = ctxProd;
      }
    } else if (ctxTmpl !== null) {
      tmplId = ctxTmpl;
      if (fields.includes("product_id")) {
        const [t] = await env.model("product.template").read([ctxTmpl], ["product_variant_id", "product_variant_ids"], "");
        defaults["product_tmpl_id"] = ctxTmpl;
        defaults["product_id"] = idOf(t?.["product_variant_id"]) ?? false;
        if (idsOf(t?.["product_variant_ids"]).length > 1) defaults["product_has_variants"] = true;
      }
    }
    let tmplCompany: number | null = null;
    let tmplUom: number | null = null;
    let tmplRoutes: number[] = [];
    let tmplVariants: number[] = [];
    let tmplSellers: number[] = [];
    if (tmplId !== null) {
      const [t] = await env.model("product.template").read([tmplId], ["company_id", "uom_id", "route_ids", "product_variant_ids", "seller_ids"], "");
      tmplCompany = idOf(t?.["company_id"]);
      tmplUom = idOf(t?.["uom_id"]);
      tmplRoutes = idsOf(t?.["route_ids"]);
      tmplVariants = idsOf(t?.["product_variant_ids"]);
      tmplSellers = idsOf(t?.["seller_ids"]);
    }
    const companyId = tmplCompany ?? await env.company();
    if (fields.includes("uom_id")) defaults["uom_id"] = tmplUom ?? false;
    if (fields.includes("company_id")) defaults["company_id"] = companyId;
    if (fields.includes("warehouse_id") && !("warehouse_id" in defaults)) {
      const whs = await env.model("stock.warehouse").search(cond("company_id", "=", companyId), { limit: 1 });
      defaults["warehouse_id"] = whs[0] ?? false;
    }
    if (fields.includes("route_id") && !("route_id" in defaults) && tmplId !== null) {
      // stock + purchase_stock _get_route_domain
      let dom = and([
        await allowedRouteDomain(env, null, null),
        cond("company_id", "in", [companyId, false]),
      ]);
      if (tmplRoutes.length) dom = and([dom, cond("product_ids", "=", tmplId)]);
      // purchase_stock adds buy_route if seller_ids or _has_confirmed_purchase
      const buyRuleIds = await env.model("stock.rule").search(and([
        cond("action", "=", "buy"),
        cond("company_id", "=", companyId),
        cond("picking_type_id.code", "=", "incoming"),
      ]));
      const buyRouteIds = buyRuleIds.length
        ? [...new Set((await env.model("stock.rule").read(buyRuleIds, ["route_id"], "")).map((r) => idOf(r["route_id"])).filter((x): x is number => x !== null))]
        : [];
      if (buyRouteIds.length && (tmplSellers.length > 0 || await hasConfirmedPurchase(env, tmplVariants, companyId))) {
        dom = or([dom, cond("id", "in", buyRouteIds)]);
      }
      const found = await env.model("stock.route").search(dom, { limit: 1 });
      let routeId: number | false = found[0] ?? false;
      if (!routeId && tmplRoutes.length) {
        const rows = await env.model("stock.route").read(tmplRoutes, ["company_id"], "");
        const envComp = await env.company();
        const hit = rows.find((r) => { const c = idOf(r["company_id"]); return c === null || c === envComp; });
        routeId = hit ? Number(hit["id"]) : false;
      }
      defaults["route_id"] = routeId;
    }
    // purchase_stock/wizard/product_replenish.py:13-28
    const prodId = idOf(defaults["product_id"]);
    if (prodId !== null) {
      const [p] = await env.model("product.product").read([prodId], ["product_tmpl_id"], "");
      const ptId = idOf(p?.["product_tmpl_id"]);
      let firstVarId = prodId;
      let ptComp: number | null = null;
      if (ptId !== null) {
        const [t] = await env.model("product.template").read([ptId], ["product_variant_id", "company_id"], "");
        firstVarId = idOf(t?.["product_variant_id"]) ?? prodId;
        ptComp = idOf(t?.["company_id"]);
      }
      const comp = ptComp ?? await env.company();
      if (!("warehouse_id" in defaults)) {
        const whs = await env.model("stock.warehouse").search(cond("company_id", "in", [comp, false]), { limit: 1 });
        defaults["warehouse_id"] = whs[0] ?? false;
      }
      const whId = idOf(defaults["warehouse_id"]);
      const ops = await env.model("stock.warehouse.orderpoint").search(and([
        cond("product_id", "in", [firstVarId, prodId]),
        cond("warehouse_id", "=", whId ?? false),
      ]), { limit: 1 });
      if (ops.length) {
        const [op] = await env.model("stock.warehouse.orderpoint").read(ops, ["route_id", "supplier_id"], "");
        const opRoute = idOf(op?.["route_id"]);
        if (opRoute !== null) defaults["route_id"] = opRoute;
        const opSupp = idOf(op?.["supplier_id"]);
        if (opSupp !== null) {
          const [s] = await env.model("product.supplierinfo").read([opSupp], ["partner_id"], "");
          const sp = idOf(s?.["partner_id"]);
          if (sp !== null) defaults["partner_id"] = sp;
        }
      }
    }
  },
});

defineComputes("product.replenish", {
  // stock/wizard/product_replenish.py:37-39 _compute_allowed_uom_ids
  allowed_uom_ids: async (env, rec) => {
    const product = await rec.rel("product_id");
    if (!product) return [];
    const out = await availableUoms(env, product);
    for (const s of await product.rels("seller_ids")) {
      const u = idOf(await s.get("uom_id"));
      if (u !== null && !out.includes(u)) out.push(u);
    }
    return out;
  },
  // stock/wizard/product_replenish.py:42-44 _compute_forecasted_quantity
  forecasted_quantity: async (env, rec) => {
    const prodId = idOf(await rec.get("product_id"));
    if (prodId === null) return 0;
    const whId = idOf(await rec.get("warehouse_id"));
    const wenv = env.withContext({ ...env.context, warehouse_id: whId ?? false });
    const v = await new DbRec(wenv, wenv.reg.model("product.product"), prodId).get("virtual_available");
    return numOf(v);
  },
  // stock/models/stock_replenish_mixin.py + stock/wizard/product_replenish.py:138-142 _compute_allowed_route_ids
  allowed_route_ids: async (env, rec) => {
    const whId = idOf(await rec.get("warehouse_id"));
    const prodId = idOf(await rec.get("product_id"));
    const dom = await allowedRouteDomain(env, whId, prodId);
    const out = await env.model("stock.route").search(dom);
    if (prodId !== null) {
      const prod = new DbRec(env, env.reg.model("product.product"), prodId);
      for (const r of await prod.rels("route_from_categ_ids")) {
        if (r.origin !== null && !out.includes(r.origin)) out.push(r.origin);
      }
    }
    return out;
  },
  // purchase_stock/models/stock_replenish_mixin.py:12-18 _compute_show_vendor
  show_vendor: async (env, rec) => routeHasBuy(env, idOf(await rec.get("route_id"))),
});

registerRecordCompute("product.replenish", {
  // stock/wizard/product_replenish.py:46-49, 82-87 + purchase_stock/wizard/product_replenish.py:37-42, 78-90
  date_planned: async (env, rec) => {
    const now = datetimeToString(await dbNow(env));
    const routeId = idOf(await rec.get("route_id"));
    let delay = 0;
    if (routeId !== null) {
      const sum = (await env.cr.query<{ d: number | null }>("SELECT COALESCE(SUM(delay), 0)::float8 AS d FROM stock_rule WHERE route_id = $1 AND active", [routeId])).rows[0]?.d ?? 0;
      delay += sum;
    }
    let dt = shiftDays(now, delay);
    if (routeId !== null && await routeHasBuy(env, routeId)) {
      const showVendor = Boolean(await rec.get("show_vendor"));
      const prodId = idOf(await rec.get("product_id"));
      if (showVendor && prodId !== null) {
        const companyId = await env.company();
        const partnerId = idOf(await rec.get("partner_id"));
        const qty = numOf(await rec.get("quantity"));
        const uomId = idOf(await rec.get("uom_id"));
        const seller = await resolveReplenishSupplier(env, companyId, prodId, partnerId, qty, uomId);
        if (seller) {
          const daysToPurchase = (await env.cr.query<{ d: number | null }>("SELECT COALESCE(days_to_purchase, 0)::float8 AS d FROM res_company WHERE id = $1", [companyId])).rows[0]?.d ?? 0;
          dt = shiftDays(dt, (seller.delay || 0) + daysToPurchase);
        }
      }
    }
    return dt;
  },
});

// stock/wizard/product_replenish.py:31-34
registerOnchange("product.replenish", "_onchange_product_id", ["product_id", "warehouse_id"], async (env, rec) => {
  if (!env.context["default_quantity"]) {
    const f = numOf(await rec.get("forecasted_quantity"));
    await rec.set("quantity", f < 0 ? Math.abs(f) : 1);
  }
});

// purchase_stock/wizard/product_replenish.py:30-35
registerOnchange("product.replenish", "_onchange_route_id", ["route_id"], async (env, rec) => {
  if (await rec.get("show_vendor")) {
    const prodId = idOf(await rec.get("product_id"));
    if (prodId !== null) {
      const seller = await resolveReplenishSupplier(
        env,
        await env.company(),
        prodId,
        idOf(await rec.get("partner_id")),
        numOf(await rec.get("quantity")),
        idOf(await rec.get("uom_id")),
      );
      await rec.set("partner_id", seller?.partner_id ?? false);
    }
  } else {
    await rec.set("partner_id", false);
  }
});

// purchase_stock/wizard/product_replenish.py:50-64 action_stock_replenishment_info
button("product.replenish", "action_stock_replenishment_info", async (env, ids) => {
  const id = ensureOne(ids, "product.replenish");
  const [wiz] = await env.model("product.replenish").read([id], ["product_id", "warehouse_id"], "");
  const prodId = idOf(wiz?.["product_id"]);
  const whId = idOf(wiz?.["warehouse_id"]);
  let ops = await env.model("stock.warehouse.orderpoint").search(and([
    cond("product_id", "=", prodId ?? false),
    cond("warehouse_id", "=", whId ?? false),
  ]), { limit: 1 });
  let opId = ops[0];
  if (opId === undefined) {
    const [created] = await create(env, "stock.warehouse.orderpoint", [{ product_id: prodId ?? false, warehouse_id: whId ?? false }]);
    opId = created!;
  }
  const action = await openOrderpointReplenishmentInfo(env, opId);
  action["context"] = { default_orderpoint_id: opId, replenish_id: id };
  return action;
});

/** Find rule for manual replenishment: route_ids on the wizard take precedence over product/category/warehouse routes. */
async function findReplenishRule(
  env: Environment,
  product: { template: number; categ: number },
  locationId: number,
  warehouseId: number,
  companyId: number,
  explicitRouteId: number | null,
): Promise<RuleRow | null> {
  if (explicitRouteId !== null) {
    const chain = (await env.cr.query<{ id: number }>(
      `WITH RECURSIVE up(id, parent, depth) AS (SELECT id, location_id, 0 FROM stock_location WHERE id = $1
         UNION ALL SELECT l.id, l.location_id, up.depth + 1 FROM stock_location l JOIN up ON l.id = up.parent) SELECT id FROM up ORDER BY depth`, [locationId])).rows.map((r) => r.id);
    const rules = (await env.cr.query<RuleRow & { location_dest_id: number }>(
      `SELECT r.id, r.action, r.procure_method, r.location_src_id, r.picking_type_id, r.warehouse_id, r.delay, r.propagate_cancel, r.company_id, r.location_dest_from_rule,
              r.partner_address_id, r.route_id, r.location_dest_id
         FROM stock_rule r WHERE r.active AND r.action != 'push' AND r.route_id = $1
          AND r.location_dest_id = ANY($2::int[]) AND (r.warehouse_id = $3 OR r.warehouse_id IS NULL)
          AND (r.company_id IS NULL OR r.company_id = $4)
        ORDER BY r.route_sequence, r.sequence, r.id`, [explicitRouteId, chain, warehouseId, companyId])).rows;
    for (const loc of chain) {
      const cands = rules.filter((r) => r.location_dest_id === loc);
      const hit = cands.find((r) => r.warehouse_id === warehouseId) ?? cands.find((r) => r.warehouse_id === null);
      if (hit) return hit;
    }
  }
  return findRule(env, product, locationId, warehouseId, companyId);
}

/** Run a single manual replenishment buy procurement (purchase_stock stock_rule.py:58-160 _run_buy). */
async function runManualBuyProcurement(
  env: Environment,
  rule: RuleRow,
  p: {
    productId: number;
    qty: number;
    uomId: number;
    locationId: number;
    origin: string;
    companyId: number;
    warehouseId: number;
    datePlanned: string;
    partnerId: number | null;
  },
): Promise<{ poId: number; lineId: number }> {
  const company = rule.company_id ?? p.companyId;
  const today = todayInTz(await dbNow(env), "UTC");
  const day = p.datePlanned.slice(0, 10) > today ? p.datePlanned.slice(0, 10) : today;
  const seller = await resolveReplenishSupplier(env, company, p.productId, p.partnerId, p.qty, p.uomId, day);
  if (!seller) {
    const prodName = (await env.sudo().model("product.product").displayName([p.productId])).get(p.productId) ?? "";
    throw new UserError(translate(env, "There is no matching vendor price to generate the purchase order for product %s (no vendor defined, minimum quantity not reached, dates not valid, ...). Go on the product form and complete the list of vendors.", "purchase_stock").replace("%s", prodName));
  }
  const [partner] = (await env.cr.query<{ id: number; buyer_id: number | null; group_rfq: string | null; lang: string | null }>(
    "SELECT id, buyer_id, group_rfq, lang FROM res_partner WHERE id = $1", [seller.partner_id])).rows;
  if (!partner) throw new NotPorted("product.replenish._run_buy vendor missing");
  if (partner.group_rfq && partner.group_rfq !== "default") throw new NotPorted(`product.replenish._run_buy grouped per ${partner.group_rfq}`);
  const props = (await env.withContext({ ...env.context, allowed_company_ids: [company] }).sudo().model("res.partner").read([partner.id], ["property_purchase_currency_id", "property_supplier_payment_term_id"], ""))[0] ?? {};
  const partnerCurrency = idOf(props["property_purchase_currency_id"]);
  const partnerTerm = idOf(props["property_supplier_payment_term_id"]);
  const companyCurrency = (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [company])).rows[0]!.c;
  const currency = seller.currency_id ?? partnerCurrency ?? companyCurrency;
  if (currency !== companyCurrency) throw new NotPorted("product.replenish._run_buy in another currency");

  const daysToPurchase = (await env.cr.query<{ d: number | null }>("SELECT COALESCE(days_to_purchase, 0)::float8 AS d FROM res_company WHERE id = $1", [company])).rows[0]?.d ?? 0;
  const dateOrder = shiftDays(p.datePlanned, -(seller.delay || 0) - daysToPurchase);

  // Check existing draft RFQ matching _make_po_get_domain (no references, no project)
  const [existingPo] = (await env.cr.query<{ id: number; origin: string | null; date_order: string; date_planned: string | null }>(
    `SELECT o.id, o.origin, o.date_order::text AS date_order, o.date_planned::text AS date_planned FROM purchase_order o
      WHERE o.partner_id = $1 AND o.state = 'draft' AND o.picking_type_id = $2 AND o.company_id = $3
        AND o.user_id IS NOT DISTINCT FROM $4 AND o.currency_id = $5 AND o.project_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM stock_reference_purchase_rel r WHERE r.purchase_id = o.id)
      ORDER BY o.priority DESC, o.id DESC LIMIT 1`,
    [partner.id, rule.picking_type_id, company, partner.buyer_id, currency])).rows;

  const su = await withCompany(env.sudo(), company);
  let poId: number;
  if (!existingPo) {
    const fpos = await fiscalPositionFor(env, company, partner.id, null);
    const [createdPo] = await create(su, "purchase.order", [{
      partner_id: partner.id,
      user_id: partner.buyer_id ?? false,
      picking_type_id: rule.picking_type_id,
      company_id: company,
      currency_id: currency,
      dest_address_id: false,
      origin: p.origin,
      payment_term_id: partnerTerm ?? false,
      date_order: dateOrder,
      fiscal_position_id: fpos ?? false,
      reference_ids: [[6, 0, []]],
    }]);
    poId = createdPo!;
    await trackPrepare(su, "purchase.order", [poId]);
    await addPrecommit(env.cr, () => closeTrackingScope(su, "purchase.order"));
  } else {
    poId = existingPo.id;
    await trackPrepare(su, "purchase.order", [poId]);
    await addPrecommit(env.cr, () => closeTrackingScope(su, "purchase.order"));
    if (existingPo.origin) {
      const have = new Set(existingPo.origin.split(", "));
      if (!have.has(p.origin)) await write(su, "purchase.order", [poId], { origin: `${existingPo.origin}, ${p.origin}` });
    } else {
      await write(su, "purchase.order", [poId], { origin: p.origin });
    }
  }

  const propagate = Boolean(rule.propagate_cancel);
  const existingLines = (await env.cr.query<{ id: number; uom_id: number; product_qty: number; price_unit: number; partner_id: number | null; date_order: string; currency_id: number }>(
    `SELECT l.id, l.uom_id, l.product_qty::float8 AS product_qty, l.price_unit::float8 AS price_unit, l.partner_id, o.date_order::text AS date_order, o.currency_id
       FROM purchase_order_line l JOIN purchase_order o ON o.id = l.order_id
      WHERE l.order_id = $1 AND l.product_id = $2 AND l.display_type IS NULL AND COALESCE(l.propagate_cancel, false) = $3
        AND l.orderpoint_id IS NULL ORDER BY l.id`,
    [poId, p.productId, propagate])).rows;

  let lineId: number;
  if (existingLines.length === 1 && existingLines[0]!.uom_id === p.uomId) {
    const line = existingLines[0]!;
    const total = line.product_qty + p.qty;
    const product = new DbRec(env, env.reg.model("product.product"), p.productId);
    const updatedSeller = await selectSeller(env.withContext({ ...env.context, allowed_company_ids: [company] }), product, {
      company, partner: partner.id, date: line.date_order.slice(0, 10), quantity: total, uom: line.uom_id, forceUom: false, params: { force_uom: null }, envCompany: company,
    });
    const price = updatedSeller ? updatedSeller.price : line.price_unit;
    await write(su, "purchase.order.line", [line.id], { product_qty: total, price_unit: price, move_dest_ids: [] });
    lineId = line.id;
  } else {
    const [poRow] = (await env.cr.query<{ date_order: string; fpos: number | null; currency_id: number }>(
      "SELECT date_order::text AS date_order, fiscal_position_id AS fpos, currency_id FROM purchase_order WHERE id = $1", [poId])).rows;
    const product = new DbRec(env, env.reg.model("product.product"), p.productId);
    const ctxToday = todayInTz(await dbNow(env), await envTz(env));
    const orderDay = todayInTz(new Date(Date.parse(`${poRow!.date_order.slice(0, 19).replace(" ", "T")}Z`)), await envTz(env));
    const lineSeller = await selectSeller(env.withContext({ ...env.context, allowed_company_ids: [company] }), product, {
      company, partner: partner.id, date: orderDay > ctxToday ? orderDay : ctxToday, quantity: p.qty, uom: p.uomId, forceUom: false, params: { force_uom: null }, envCompany: company,
    });
    const productTaxes = await taxesOfCompany(env, await product.rels("supplier_taxes_id"), company);
    const position = poRow!.fpos ? new DbRec(env, env.reg.model("account.fiscal.position"), poRow!.fpos) : null;
    const taxes = await mapTax(position, productTaxes);
    const [desc] = (await env.cr.query<{ d: string | null }>(
      "SELECT COALESCE(t.description_purchase->>$2, t.description_purchase->>'en_US') AS d FROM product_product pp JOIN product_template t ON t.id = pp.product_tmpl_id WHERE pp.id = $1",
      [p.productId, partner.lang || "en_US"])).rows;
    const [createdLine] = await create(su, "purchase.order.line", [{
      name: desc?.d || "",
      product_qty: p.qty,
      product_id: p.productId,
      uom_id: p.uomId,
      price_unit: lineSeller ? lineSeller.price : seller.price,
      date_planned: p.datePlanned,
      tax_ids: [[6, 0, taxes]],
      order_id: poId,
      discount: lineSeller?.discount || 0,
      move_dest_ids: [],
      forecasted_location_id: p.locationId,
      propagate_cancel: propagate,
      product_description_variants: false,
      product_no_variant_attribute_value_ids: false,
      sale_line_id: false,
    }]);
    lineId = createdLine!;
    const [o] = (await env.cr.query<{ date_order: string; date_planned: string | null }>(
      "SELECT date_order::text AS date_order, date_planned::text AS date_planned FROM purchase_order WHERE id = $1", [poId])).rows;
    const planned = o!.date_planned ? o!.date_planned.slice(0, 19) : p.datePlanned;
    const orderPlanned = shiftDays(planned, -(seller.delay || 0));
    if (orderPlanned.slice(0, 10) < o!.date_order.slice(0, 10)) {
      await write(su, "purchase.order", [poId], { date_order: orderPlanned });
    }
  }
  const points = (await env.cr.query<{ id: number }>("SELECT id FROM stock_warehouse_orderpoint WHERE product_id = $1 ORDER BY id", [p.productId])).rows.map((r) => r.id);
  if (points.length) {
    const queue = new RecomputeQueue(su);
    queue.add("stock.warehouse.orderpoint", "qty_to_order_computed", points);
    await queue.run();
  }
  return { poId, lineId };
}

// stock/wizard/product_replenish.py:89-115 + purchase_stock/wizard/product_replenish.py:44-76 launch_replenishment
button("product.replenish", "launch_replenishment", async (env, ids) => {
  const id = ensureOne(ids, "product.replenish");
  const hasPartner = env.reg.model("product.replenish").fields.has("partner_id");
  const fields = ["product_id", "quantity", "uom_id", "warehouse_id", "route_id", "date_planned", ...(hasPartner ? ["partner_id"] : [])];
  const [wiz] = await env.model("product.replenish").read([id], fields, "");
  const prodId = idOf(wiz?.["product_id"]);
  const qty = numOf(wiz?.["quantity"]);
  const uomId = idOf(wiz?.["uom_id"]);
  const whId = idOf(wiz?.["warehouse_id"]);
  const routeId = idOf(wiz?.["route_id"]);
  const partnerId = hasPartner ? idOf(wiz?.["partner_id"]) : null;
  const datePlanned = String(wiz?.["date_planned"] || datetimeToString(await dbNow(env)));
  if (prodId === null || uomId === null || whId === null) throw new UserError(translate(env, "Missing replenishment parameters.", "stock"));

  const [wh] = (await env.cr.query<{ lot_stock_id: number; company_id: number }>(
    "SELECT lot_stock_id, company_id FROM stock_warehouse WHERE id = $1", [whId])).rows;
  const [prod] = (await env.cr.query<{ template: number; categ: number; uom_id: number; type: string }>(
    "SELECT t.id AS template, t.categ_id AS categ, t.uom_id, t.type FROM product_product p JOIN product_template t ON t.id = p.product_tmpl_id WHERE p.id = $1", [prodId])).rows;
  if (!wh || !prod) throw new NotPorted("product.replenish warehouse or product missing");

  const actWindowClose: Record<string, unknown> = {
    type: "ir.actions.act_window_close",
    infos: { done: true },
  };
  const digits = (await env.cr.query<{ d: number }>("SELECT digits AS d FROM decimal_precision WHERE name = 'Product Unit'")).rows[0]?.d ?? 2;
  let link: { label: string; url: string }[] | false = false;

  if (floatRound(qty, digits) !== 0 && prod.type === "consu") {
    const rule = await findReplenishRule(env, { template: prod.template, categ: prod.categ }, wh.lot_stock_id, whId, wh.company_id, routeId);
    if (!rule) {
      const prodName = (await env.sudo().model("product.product").displayName([prodId])).get(prodId) ?? "";
      const locName = (await env.sudo().model("stock.location").displayName([wh.lot_stock_id])).get(wh.lot_stock_id) ?? "";
      throw new UserError(
        translate(env, 'No rule has been found to replenish "%(product)s" in "%(location)s".\nVerify the routes configuration on the product.', "stock")
          .replace("%(product)s", prodName)
          .replace("%(location)s", locName),
      );
    }
    const origin = translate(env, "Manual Replenishment", "stock");
    if (rule.action === "buy") {
      const { poId } = await runManualBuyProcurement(env, rule, {
        productId: prodId,
        qty,
        uomId,
        locationId: wh.lot_stock_id,
        origin,
        companyId: wh.company_id,
        warehouseId: whId,
        datePlanned,
        partnerId,
      });
      const poDisplay = (await env.model("purchase.order").displayName([poId])).get(poId) ?? "";
      link = [{ label: poDisplay, url: `/odoo/action-purchase.action_rfq_form/${poId}` }];
    } else if (rule.action === "pull" || rule.action === "pull_push") {
      const su = (await withCompany(env, wh.company_id)).sudo();
      const moveQty = uomId === prod.uom_id ? qty : await uomQuantity(env, qty, uomId, prod.uom_id);
      const [moveId] = await create(su, "stock.move", [{
        company_id: rule.company_id ?? wh.company_id,
        product_id: prodId,
        uom_id: prod.uom_id,
        product_uom_qty: moveQty,
        location_id: rule.location_src_id,
        location_dest_id: wh.lot_stock_id,
        rule_id: rule.id,
        procure_method: rule.procure_method,
        origin,
        picking_type_id: rule.picking_type_id,
        warehouse_id: rule.warehouse_id ?? whId,
        date: datePlanned,
        propagate_cancel: rule.propagate_cancel ?? false,
      }]);
      await actionConfirm(su, [moveId!]);
      const pickingId = (await env.cr.query<{ p: number | null }>("SELECT picking_id AS p FROM stock_move WHERE id = $1", [moveId!])).rows[0]?.p ?? null;
      if (pickingId !== null) {
        const pickName = (await env.cr.query<{ n: string }>("SELECT name AS n FROM stock_picking WHERE id = $1", [pickingId])).rows[0]?.n ?? "";
        link = [{ label: pickName, url: `/odoo/action-stock.stock_picking_action_picking_type/${pickingId}` }];
      }
    } else {
      throw new NotPorted(`product.replenish.launch_replenishment through ${rule.action} rule`);
    }
  }

  if (link) {
    return {
      type: "ir.actions.client",
      tag: "display_notification",
      params: {
        title: translate(env, "The following replenishment order have been generated", "stock"),
        message: "%s",
        links: link,
        sticky: false,
        next: actWindowClose,
      },
    };
  }
  return actWindowClose;
});

// stock.warehouse.orderpoint computes with explicit route_id are handled natively in orderpoint_forecast.ts & inventory_flow.ts.

// =================================================================================================================
// sale_pdf_quote_builder/models/sale_order.py `get_update_included_pdf_params` (the Quote Builder tab,
// custom_content_kanban_like_widget.js:44)
// =================================================================================================================

/** Python `str.rstrip(chars)`: every trailing character in `chars` (`".pdf"` is a set, not a suffix). */
function pyRstrip(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1]!)) end--;
  return s.slice(0, end);
}

/** `d.get(key, dflt)` on the json.loads mapping: a non-dict value raises AttributeError in Odoo. */
function pyGet(d: unknown, key: string, dflt: unknown): unknown {
  if (typeof d !== "object" || d === null || Array.isArray(d)) throw new NotPorted(`get_update_included_pdf_params: customizable_pdf_form_fields .get on ${JSON.stringify(d)}`);
  return Object.prototype.hasOwnProperty.call(d, key) ? (d as Record<string, unknown>)[key] : dflt;
}

button("sale.order", "get_update_included_pdf_params", async (env, ids) => {
  if (!ids.length) return { headers: {}, files: {}, footers: {} };
  const id = ensureOne(ids, "sale.order");
  const [order] = await env.model("sale.order").read([id],
    ["customizable_pdf_form_fields", "available_quotation_document_ids", "quotation_document_ids", "order_line"], "");
  // `self.customizable_pdf_form_fields and json.loads(...)`: the widget stores a JSON string in the Json field. The
  // column's text, parsed once: node-pg hands a jsonb string already parsed and the ORM's read (orm/values.ts pgJson)
  // parses that string again, so a read gives the object where Odoo has the str
  const text = (await env.cr.query<{ v: string | null }>("SELECT customizable_pdf_form_fields::text AS v FROM sale_order WHERE id = $1", [id])).rows[0]?.v ?? null;
  const raw = text === null ? null : JSON.parse(text) as unknown;
  let mapping: unknown = {};
  if (raw !== null && raw !== undefined && raw !== false && raw !== "") {
    if (typeof raw !== "string") throw new NotPorted("get_update_included_pdf_params: json.loads of a non-string customizable_pdf_form_fields");
    mapping = JSON.parse(raw) as unknown;
    if (mapping === null || mapping === false || mapping === 0 || mapping === "" || (Array.isArray(mapping) && !mapping.length)
      || (typeof mapping === "object" && !Array.isArray(mapping) && !Object.keys(mapping as object).length)) mapping = {};
  }
  const value = (path: string[], field: string): unknown => {
    let d: unknown = mapping;
    for (const k of path) d = pyGet(d, k, {});
    return pyGet(pyGet(d, "custom_form_fields", {}), field, "");
  };
  const available = idsOf(order?.["available_quotation_document_ids"]);
  const selected = idsOf(order?.["quotation_document_ids"]);
  // `available | selected`: the union keeps the first operand's order, then the new records of the second
  const docs = [...available, ...selected.filter((d) => !available.includes(d))];
  const docRows = docs.length ? await env.model("quotation.document").read(docs, ["name", "document_type", "form_field_ids"], "") : [];
  const byId = new Map(docRows.map((r) => [Number(r["id"]), r]));
  // `form_field_ids.filtered(lambda ff: not ff.path)`, in sale.pdf.form.field's order (name)
  const fieldRows = new Map<number, Record<string, unknown>>();
  const readFields = async (fids: number[]): Promise<void> => {
    const missing = [...new Set(fids.filter((f) => !fieldRows.has(f)))];
    if (missing.length) for (const r of await env.model("sale.pdf.form.field").read(missing, ["name", "path"], "")) fieldRows.set(Number(r["id"]), r);
  };
  const formFields = (fids: number[], path: string[]): Array<{ name: unknown; value: unknown }> =>
    fids.map((f) => fieldRows.get(f)!).filter((ff) => !ff["path"]).map((ff) => ({ name: ff["name"], value: value(path, String(ff["name"])) }));
  await readFields(docRows.flatMap((r) => idsOf(r["form_field_ids"])));
  const selectedHeaders = selected.filter((d) => byId.get(d)?.["document_type"] === "header");
  const selectedFooters = selected.filter((d) => !selectedHeaders.includes(d));
  const files = (type: "header" | "footer", isSelected: number[]) => docs.filter((d) => byId.get(d)!["document_type"] === type).map((d) => {
    const r = byId.get(d)!;
    return { id: d, name: r["name"], is_selected: isSelected.includes(d), custom_form_fields: formFields(idsOf(r["form_field_ids"]), [type, String(d)]) };
  });
  const headers = files("header", selectedHeaders), footers = files("footer", selectedFooters);
  // the lines with available product documents
  const lineIds = idsOf(order?.["order_line"]);
  const lines = lineIds.length ? await env.model("sale.order.line").read(lineIds, ["label", "available_product_document_ids"], "") : [];
  const withDocs = lines.filter((l) => idsOf(l["available_product_document_ids"]).length);
  const sudoLines = withDocs.length ? await env.sudo().model("sale.order.line").read(withDocs.map((l) => Number(l["id"])), ["product_document_ids"], "") : [];
  const lineSelected = new Map(sudoLines.map((l) => [Number(l["id"]), idsOf(l["product_document_ids"])]));
  const productDocIds = [...new Set(withDocs.flatMap((l) => idsOf(l["available_product_document_ids"])))];
  const productDocs = productDocIds.length ? await env.model("product.document").read(productDocIds, ["name", "form_field_ids"], "") : [];
  const productById = new Map(productDocs.map((r) => [Number(r["id"]), r]));
  await readFields(productDocs.flatMap((r) => idsOf(r["form_field_ids"])));
  const linesParams = withDocs.map((l) => {
    const lineId = Number(l["id"]);
    const first = pySplitlines(typeof l["label"] === "string" ? l["label"] : "")[0];
    if (first === undefined) throw new NotPorted("get_update_included_pdf_params: a line without label (IndexError in Odoo)");
    return {
      name: first,
      id: lineId,
      files: idsOf(l["available_product_document_ids"]).map((d) => {
        const doc = productById.get(d)!;
        return {
          name: pyRstrip(String(doc["name"]), ".pdf"),
          id: d,
          is_selected: (lineSelected.get(lineId) ?? []).includes(d),
          custom_form_fields: formFields(idsOf(doc["form_field_ids"]), ["line", String(lineId), String(d)]),
        };
      }),
    };
  });
  return {
    headers: { name: translate(env, "Header", "sale_pdf_quote_builder"), files: headers },
    lines: linesParams,
    footers: { name: translate(env, "Footer", "sale_pdf_quote_builder"), files: footers },
  };
}, true);

// =================================================================================================================
// product.catalog.mixin `get_catalog_section_data` (the catalog's section panel) on sale.order, purchase.order and
// account.move: account product_catalog_mixin.py:65-125 with `_has_sections` True (sale_order.py:2721,
// purchase_order.py:1312, account_move.py:3068) and `_show_prices` True (product_catalog_mixin.py:49-50)
// =================================================================================================================

/** The line model and its order field of each model's catalog lines; account's parent sections are computed over
 *  `line_ids`, whose non-catalog lines (tax, payment term) get no parent and never end a section. */
const CATALOG_SECTION_MODELS: Readonly<Record<string, { line: string; inverse: string }>> = {
  "sale.order": { line: "sale.order.line", inverse: "order_id" },
  "purchase.order": { line: "purchase.order.line", inverse: "order_id" },
  "account.move": { line: "account.move.line", inverse: "move_id" },
};

interface CatalogLine { id: number; name: unknown; display_type: unknown; sequence: number; price_subtotal: number; parent: number | false }

for (const [model, { line: lineModel }] of Object.entries(CATALOG_SECTION_MODELS)) {
  registerMethod(model, "get_catalog_section_data", async (env0, ids, args, kwargs0) => {
    const { env: env1, kwargs } = envFor(env0, kwargs0);
    const childField = "child_field" in kwargs ? kwargs["child_field"] : args[0];
    if (typeof childField !== "string") throw new NotPorted(`${model}.get_catalog_section_data without a child_field`);
    const id = ensureOne(ids, model);
    const field = env1.reg.model(model).fields.get(childField);
    if (!field || field.type !== "one2many" || field.relation !== lineModel) throw new NotPorted(`${model}.get_catalog_section_data of ${childField}`);
    // `self.with_company(self.company_id)`
    const [head] = await env1.model(model).read([id], ["name", "amount_untaxed", "company_id", childField], "");
    if (!head) throw new NotPorted(`${model}.get_catalog_section_data of a missing record`);
    const company = idOf(head["company_id"]);
    const env = company !== null ? await withCompany(env1, company) : env1;
    const lineIds = idsOf(head[childField]);
    const rows = lineIds.length ? await env.model(lineModel).read(lineIds, ["name", "display_type", "sequence", "price_subtotal"], "") : [];
    const byId = new Map(rows.map((r) => [r["id"] as number, r]));
    // `self[child_field].sorted('sequence')`: the one2many in the lines' order, stably sorted by sequence
    const lines: CatalogLine[] = lineIds.map((lid) => {
      const r = byId.get(lid)!;
      return { id: lid, name: r["name"], display_type: r["display_type"], sequence: Number(r["sequence"] ?? 0), price_subtotal: numOf(r["price_subtotal"]), parent: false as number | false };
    });
    const sorted = lines.map((l, i) => [l, i] as const).sort((a, b) => a[0].sequence - b[0].sequence || a[1] - b[1]).map(([l]) => l);
    // sale_order_line.py:1685-1705, purchase_order_line.py:673-693, account_move_line.py:1668-1694 `_compute_parent_id`
    let lastSection: number | false = false;
    let lastSub: number | false = false;
    for (const l of sorted) {
      if (l.display_type === "line_section") { lastSection = l.id; l.parent = false; lastSub = false; }
      else if (l.display_type === "line_subsection") { l.parent = lastSection; lastSub = l.id; }
      else if (model !== "account.move" || l.display_type === "line_note" || l.display_type === "product") l.parent = lastSub || lastSection;
    }
    const kind = new Map(sorted.map((l) => [l.id, l]));
    // account product_catalog_line_mixin.py:35-46 `_is_line_in_section`
    const inSection = (section: CatalogLine, l: CatalogLine): boolean => l.parent === section.id
      || (section.display_type === "line_section" && l.parent !== false && kind.get(l.parent)?.display_type === "line_subsection" && kind.get(l.parent)?.parent === section.id);
    // python's sum: an int 0 for no line, else a float
    const pySum = (values: number[]): unknown => (values.length ? pyFloat(values.reduce((a, b) => a + b, 0)) : 0);
    const isSection = (l: CatalogLine): boolean => l.display_type === "line_section" || l.display_type === "line_subsection";
    // :83-125 `_get_sections`; `_get_section_lines` filters the order's `order_line` / the move's `invoice_line_ids`
    const sections: Record<string, unknown>[] = sorted.filter(isSection).map((s) => ({
      id: s.id, name: s.name, parent_id: s.parent, subtotal: pySum(sorted.filter((l) => inSection(s, l)).map((l) => l.price_subtotal)),
    }));
    const noSection = sorted.filter((l) => !isSection(l) && l.parent === false);
    if (sections.length && noSection.length) {
      sections.unshift({ id: false, name: translate(env, "No Section", "account"), subtotal: pySum(noSection.map((l) => l.price_subtotal)) });
    }
    return { name: head["name"], sections, amountUntaxed: pyFloat(numOf(head["amount_untaxed"])) };
  }, { apiModel: false, readonly: true });
}
