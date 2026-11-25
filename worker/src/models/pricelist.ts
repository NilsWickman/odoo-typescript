/**
 * The pricelist engine for one product.product (odoo/addons/product/models/product_pricelist.py:121-352 and
 * product_pricelist_item.py:483-677), as sale.order.line uses it (sale_order_line.py:748-1035): the applicable rule
 * (`_get_applicable_rules` + `_is_applicable_for`), its price (`_compute_price` over `_compute_base_price` and
 * `_convert_price`) and the price before the discount. Rules based on another pricelist or on the cost, and quantities
 * in another unit than the rule's or the product's, refuse.
 */
import { NotPorted, ValidationError } from "../errors";
import { registerOverrides, write } from "../orm/write";
import { isPyFloat } from "../orm/values";
import { defineComputes } from "./tail_util";
import { translate } from "./util";
import { and, cond, or } from "../orm/domain";
import { floatRoundRounding } from "../orm/convert";
import type { Environment } from "../orm/types";
import { DbRec, type Rec } from "../orm/recompute";
import { convertAmount } from "./currency_convert";
import { productListPrice, uomPrice } from "./sale_flow";

export interface PriceArgs {
  /** The product.product (a database record). */
  readonly product: Rec;
  /** `product_uom_qty or 1.0` in `uom`. */
  readonly quantity: number;
  /** The line's unit, or null for the product's. */
  readonly uom: number | null;
  /** The order date (UTC 'YYYY-MM-DD HH:MM:SS'): rule validity and currency rates. */
  readonly date: string;
  /** The currency of the price (the order's). */
  readonly currency: number;
  /** The line's no_variant attribute values (`_get_product_price_context`). */
  readonly chosen: readonly number[];
}

interface RuleRow {
  id: number; applied_on: string; compute_price: string; base: string | null; base_pricelist_id: number | null;
  fixed_price: number | null; price_discount: number | null; price_round: number | null; price_surcharge: number | null;
  price_min_margin: number | null; price_max_margin: number | null; min_quantity: number | null; uom_id: number | null;
  categ_id: number | null; product_tmpl_id: number | null; product_id: number | null; pricelist_currency: number | null;
}

const idOf = (v: unknown): number | null => (typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : null);

async function rule(env: Environment, id: number): Promise<RuleRow> {
  const r = (await env.cr.query<RuleRow>(
    `SELECT i.id, i.applied_on, i.compute_price, i.base, i.base_pricelist_id, i.fixed_price::float8 AS fixed_price,
            i.price_discount::float8 AS price_discount, i.price_round::float8 AS price_round, i.price_surcharge::float8 AS price_surcharge,
            i.price_min_margin::float8 AS price_min_margin, i.price_max_margin::float8 AS price_max_margin,
            i.min_quantity::float8 AS min_quantity, i.uom_id, i.categ_id, i.product_tmpl_id, i.product_id, p.currency_id AS pricelist_currency
       FROM product_pricelist_item i LEFT JOIN product_pricelist p ON p.id = i.pricelist_id WHERE i.id = $1`, [id])).rows[0];
  if (!r) throw new NotPorted(`product.pricelist.item ${id}`);
  return r;
}

/**
 * product_pricelist.py:140-157 `_get_product_rule` (`_compute_price_rule(compute_price=False)`): the candidate rules
 * of `_get_applicable_rules_domain` (:295-352) in the item order, the first one `_is_applicable_for` (:488-544).
 */
export async function productRule(env: Environment, pricelist: number, a: PriceArgs): Promise<number | null> {
  const product = a.product;
  if (product.origin === null) throw new NotPorted("pricelist rule of a new product");
  const tmpl = idOf(await product.get("product_tmpl_id"));
  const categ = idOf(await product.get("categ_id"));
  const productUom = idOf(await product.get("uom_id"));
  // :208-283 `quantity_uom = uom or product._get_main_uom()`, the domain gets `uom` as given by the line
  const uom = a.uom ?? productUom;
  let domain = and([
    cond("pricelist_id", "=", pricelist),
    or([cond("categ_id", "=", false), cond("categ_id", "parent_of", categ ? [categ] : [])]),
    or([cond("product_tmpl_id", "=", false), cond("product_tmpl_id", "in", tmpl ? [tmpl] : [])]),
    or([cond("product_id", "=", false), cond("product_id", "in", [product.origin])]),
    or([cond("date_start", "=", false), cond("date_start", "<=", a.date)]),
    or([cond("date_end", "=", false), cond("date_end", ">=", a.date)]),
  ]);
  if (a.uom !== null) domain = and([domain, or([cond("uom_id", "=", false), cond("uom_id", "=", a.uom)])]);
  else if (a.quantity) domain = and([domain, or([cond("min_quantity", "=", 0), cond("min_quantity", "<=", a.quantity)])]);
  const candidates = await env.model("product.pricelist.item").search(domain);
  for (const id of candidates) {
    const r = await rule(env, id);
    // :488-544 `_is_applicable_for` of a product.product
    if (r.uom_id && uom !== r.uom_id) continue;
    // `uom._compute_quantity(quantity, product_uom)` when the unit is neither the product's nor the rule's
    if (uom !== productUom && uom !== r.uom_id && r.min_quantity) throw new NotPorted("pricelist rule with a minimum quantity in another unit (uom._compute_quantity)");
    if (r.min_quantity && a.quantity < r.min_quantity) continue;
    if (r.applied_on === "2_product_category") {
      if (!categ || !r.categ_id) continue;
      if (categ !== r.categ_id) {
        const paths = (await env.cr.query<{ id: number; p: string }>("SELECT id, parent_path AS p FROM product_category WHERE id = ANY($1::int[])", [[categ, r.categ_id]])).rows;
        const own = paths.find((x) => x.id === categ)?.p ?? "", theirs = paths.find((x) => x.id === r.categ_id)?.p ?? "";
        if (!own.startsWith(theirs)) continue;
      }
    } else if (r.applied_on === "1_product" && tmpl !== r.product_tmpl_id) continue;
    else if (r.applied_on === "0_product_variant" && product.origin !== r.product_id) continue;
    return id;
  }
  return null;
}

/** product_product.py:1326-1336 `_get_no_variant_attributes_price_extra` of the line's combination. */
async function noVariantExtra(env: Environment, a: PriceArgs): Promise<number> {
  if (!a.chosen.length) return 0;
  const tmpl = idOf(await a.product.get("product_tmpl_id"));
  const own = new Set(((await a.product.get("product_template_attribute_value_ids")) as number[] | null) ?? []);
  const rows = (await env.cr.query<{ id: number; e: number | null; t: number }>(
    "SELECT id, price_extra::float8 AS e, product_tmpl_id AS t FROM product_template_attribute_value WHERE id = ANY($1::int[])", [[...a.chosen]])).rows;
  return rows.filter((r) => r.e && r.t === tmpl && !own.has(r.id)).reduce((s, r) => s + r.e!, 0);
}

/** product_pricelist_item.py:646-652 `_convert_price` (`_convert(round=False)` on the env's company). */
async function convertPrice(env: Environment, price: number, from: number, a: PriceArgs): Promise<number> {
  if (from === a.currency) return price;
  return convertAmount(env, price, from, a.currency, await env.company(), a.date, false);
}

/** :608-644 `_compute_base_price`: the list price (`_price_compute('list_price', uom)`) in the price's currency. */
async function basePrice(env: Environment, r: RuleRow | null, a: PriceArgs): Promise<number> {
  const base = r?.base || "list_price";
  if (base === "pricelist" && r?.base_pricelist_id) throw new NotPorted("pricelist rule based on another pricelist");
  if (base === "standard_price") {
    // :637-639 with product_product.py:1343-1372 `_price_compute('standard_price', uom)`: the cost in the env's company
    // (read as superuser), converted to the line's unit, from the cost currency
    if (a.product.origin === null) throw new NotPorted("pricelist rule based on the cost of a new product");
    const company = await env.company();
    const su = env.sudo().withContext({ ...env.context, allowed_company_ids: [company, ...(await env.companies()).filter((c) => c !== company)] });
    const p = new DbRec(su, su.reg.model(a.product.def.name), a.product.origin);
    const productUom = idOf(await p.get("uom_id"));
    const raw = await p.get("standard_price");
    let cost = Number((isPyFloat(raw) ? raw.float : raw) || 0);
    const uom = a.uom ?? productUom;
    if (uom !== null && productUom !== null && uom !== productUom) cost = await uomPrice(env, cost, productUom, uom);
    const from = idOf(await p.get("cost_currency_id"));
    if (from === null) throw new NotPorted("cost price of a product without cost currency");
    return convertPrice(env, cost, from, a);
  }
  const price = await productListPrice(env, a.product, a.chosen, a.uom ?? idOf(await a.product.get("uom_id")));
  const from = idOf(await a.product.get("currency_id"));
  if (from === null) throw new NotPorted("list price of a product without currency");
  return convertPrice(env, price, from, a);
}

/** product_pricelist_item.py:546-606 `_compute_price` of `ruleId` (null: the empty rule, the list price). */
export async function rulePrice(env: Environment, ruleId: number | null, a: PriceArgs): Promise<number> {
  const r = ruleId === null ? null : await rule(env, ruleId);
  const productUom = idOf(await a.product.get("uom_id"));
  const uom = a.uom ?? productUom;
  if (r?.compute_price === "fixed") {
    const price = await uomPrice(env, r.fixed_price ?? 0, productUom, uom);
    // :578-586: a variant rule adds the no_variant extras only, the others the variant's (lst_price - list_price) too
    const noVariant = await noVariantExtra(env, a);
    let extra = noVariant;
    if (r.applied_on !== "0_product_variant") extra += Number((await a.product.get("lst_price")) ?? 0) - Number((await a.product.get("list_price")) ?? 0);
    extra = await uomPrice(env, extra, productUom, uom);
    const from = idOf(await a.product.get("currency_id"));
    if (from === null) throw new NotPorted("extra price of a product without currency");
    // `_convert_price(extra_price, product.currency_id, **kwargs)`: the rule's currency is the kwargs' currency
    return price + (extra ? await convertPrice(env, extra, from, a) : 0);
  }
  const base = await basePrice(env, r, a);
  if (r && (r.compute_price === "discount" || r.compute_price === "markup")) {
    let price = base - (base * ((r.price_discount ?? 0) / 100));
    if (r.price_round) price = floatRoundRounding(price, r.price_round);
    if (r.price_surcharge) price += await uomPrice(env, r.price_surcharge, productUom, uom);
    if (r.price_min_margin) price = Math.max(price, base + await uomPrice(env, r.price_min_margin, productUom, uom));
    if (r.price_max_margin) price = Math.min(price, base + await uomPrice(env, r.price_max_margin, productUom, uom));
    return price;
  }
  if (r && r.compute_price !== "fixed" && r.compute_price !== "discount" && r.compute_price !== "markup") {
    throw new NotPorted(`pricelist rule computing ${r.compute_price}`);
  }
  return base;
}

/** :654-677 `_compute_price_before_discount` (no chained pricelists: those refuse in `basePrice`). */
export async function rulePriceBeforeDiscount(env: Environment, ruleId: number, a: PriceArgs): Promise<number> {
  return basePrice(env, await rule(env, ruleId), a);
}

/**
 * sale product_pricelist_item.py:8-16 `_show_discount`: the discount feature (sale.group_discount_per_so_line on the
 * superuser, res_groups.py `_is_feature_enabled`) and `is_plain_discount` (product_pricelist_item.py:307-320).
 */
export async function showDiscount(env: Environment, ruleId: number | null): Promise<boolean> {
  if (ruleId === null) return false;
  if (!(await discountFeature(env))) return false;
  const r = await rule(env, ruleId);
  return r.compute_price === "discount" && (r.price_discount ?? 0) > 0
    && !(r.price_round || r.price_surcharge || r.price_min_margin || r.price_max_margin);
}

/**
 * res_groups.py `_is_feature_enabled`: the superuser has the group (or one implying it). Not imported from
 * partner_erp.ts: a static import from here would evaluate that module before partner_read.ts, whose computed hooks it
 * must follow (src/index.ts order).
 */
export async function discountFeature(env: Environment): Promise<boolean> {
  return (await env.cr.query(
    `WITH RECURSIVE g(id) AS (SELECT gid FROM res_groups_users_rel WHERE uid = 1 UNION SELECT r.hid FROM res_groups_implied_rel r JOIN g ON r.gid = g.id)
     SELECT 1 FROM g JOIN ir_model_data d ON d.model = 'res.groups' AND d.res_id = g.id WHERE d.module = 'sale' AND d.name = 'group_discount_per_so_line' LIMIT 1`)).rows.length > 0;
}

// ------------------------------------------------------------------------------------------------------------
// product.pricelist.item: its stored computes, the markup's inverse, create and the constraints
// ------------------------------------------------------------------------------------------------------------

const ITEM = "product.pricelist.item";

defineComputes(ITEM, {
  // product_pricelist_item.py:184-192 _compute_applied_on (stored, precomputed)
  applied_on: async (_env, rec) => {
    if (await rec.get("categ_id")) return "2_product_category";
    if (await rec.get("product_tmpl_id")) return (await rec.get("product_id")) ? "0_product_variant" : "1_product";
    return "3_global";
  },
  // :165-168 _compute_company_id (stored)
  company_id: async (_env, rec) => {
    const pricelist = await rec.rel("pricelist_id");
    const fromPricelist = pricelist ? idOf(await pricelist.get("company_id")) : null;
    if (fromPricelist !== null) return fromPricelist;
    const tmpl = await rec.rel("product_tmpl_id");
    return tmpl ? idOf(await tmpl.get("company_id")) : null;
  },
  // :170-177 _compute_currency_id (stored)
  currency_id: async (env, rec) => {
    const pricelist = await rec.rel("pricelist_id");
    const own = pricelist ? idOf(await pricelist.get("currency_id")) : null;
    if (own !== null) return own;
    const company = await rec.rel("company_id");
    const fromCompany = company ? idOf(await company.get("currency_id")) : null;
    if (fromCompany !== null) return fromCompany;
    return (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [await env.company()])).rows[0]!.c;
  },
  // :277-280 _compute_price_markup (not stored)
  price_markup: async (_env, rec) => -Number((await rec.get("price_discount")) ?? 0),
});

registerOverrides(ITEM, {
  // :469-480 create: a variant without its template takes the variant's
  create: async (env, valsList, next) => {
    for (const vals of valsList) {
      if (vals["product_id"] && !vals["product_tmpl_id"]) {
        const t = (await env.cr.query<{ t: number }>("SELECT product_tmpl_id AS t FROM product_product WHERE id = $1", [Number(vals["product_id"])])).rows[0];
        if (t) vals["product_tmpl_id"] = t.t;
      }
    }
    return next(env, valsList);
  },
  // :282-285 _inverse_price_markup
  inverse: {
    price_markup: async (env, ids, vals) => {
      const markup = vals["price_markup"];
      const n = typeof markup === "number" ? markup : isPyFloat(markup) ? markup.float : Number(markup ?? 0);
      await write(env, ITEM, ids, { price_discount: -n });
    },
  },
  constraints: [
    // :344-347
    { fields: ["base_pricelist_id", "base"], fn: async (env, ids) => {
      const bad = (await env.cr.query("SELECT 1 FROM product_pricelist_item WHERE id = ANY($1::int[]) AND base = 'pricelist' AND base_pricelist_id IS NULL", [[...ids]])).rows.length;
      if (bad) throw new ValidationError(translate(env, 'A pricelist item with "Other Pricelist" as base must have a base_pricelist_id.'));
    } },
    // :349-380 the recursion check walks the pricelists' rules
    { fields: ["base_pricelist_id", "pricelist_id", "base"], fn: async (env, ids) => {
      const based = (await env.cr.query("SELECT 1 FROM product_pricelist_item WHERE id = ANY($1::int[]) AND base = 'pricelist' AND base_pricelist_id IS NOT NULL AND pricelist_id IS NOT NULL", [[...ids]])).rows.length;
      if (based) throw new NotPorted("product.pricelist.item based on another pricelist (_check_pricelist_recursion)");
    } },
    // :382-392 (the message formats the dates with format_datetime)
    { fields: ["date_start", "date_end"], fn: async (env, ids) => {
      const bad = (await env.cr.query("SELECT 1 FROM product_pricelist_item WHERE id = ANY($1::int[]) AND date_start IS NOT NULL AND date_end IS NOT NULL AND date_start >= date_end", [[...ids]])).rows.length;
      if (bad) throw new NotPorted("product.pricelist.item end date before its start date (_check_date_range message)");
    } },
    // :394-397
    { fields: ["price_min_margin", "price_max_margin"], fn: async (env, ids) => {
      const bad = (await env.cr.query("SELECT 1 FROM product_pricelist_item WHERE id = ANY($1::int[]) AND COALESCE(price_min_margin, 0) > COALESCE(price_max_margin, 0)", [[...ids]])).rows.length;
      if (bad) throw new ValidationError(translate(env, "The minimum margin should be lower than the maximum margin."));
    } },
    // :399-408
    { fields: ["product_id", "product_tmpl_id", "categ_id"], fn: async (env, ids) => {
      for (const r of (await env.cr.query<{ a: string; c: number | null; t: number | null; p: number | null }>(
        "SELECT applied_on AS a, categ_id AS c, product_tmpl_id AS t, product_id AS p FROM product_pricelist_item WHERE id = ANY($1::int[]) ORDER BY id", [[...ids]])).rows) {
        if (r.a === "2_product_category" && !r.c) throw new ValidationError(translate(env, "Please specify the category for which this rule should be applied"));
        if (r.a === "1_product" && !r.t) throw new ValidationError(translate(env, "Please specify the product for which this rule should be applied"));
        if (r.a === "0_product_variant" && !r.p) throw new ValidationError(translate(env, "Please specify the product variant for which this rule should be applied"));
      }
    } },
  ],
});
