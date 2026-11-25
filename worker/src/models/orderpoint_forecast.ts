/**
 * The forecast of a reordering rule (stock.warehouse.orderpoint) with purchase_stock: the lead days through its rules
 * (stock_orderpoint.py:206-216, stock_rule.py:388-419, purchase_stock stock_rule.py:180-207), the forecast at the lead
 * horizon (:407-428 `_compute_qty`, :521-527 `_get_product_context`), the quantity already on requests for quotation
 * (purchase_stock stock.py:354-361, product.py:164-214) and the stored quantity to order (:440-455
 * `_compute_qty_to_order_computed`, :499-513 `_get_qty_to_order`, :849-856 `_get_multiple_rounded_qty`, purchase_stock
 * stock.py:336-352) and the deadline (:151-204 `_compute_deadline_date`, the walk over the open moves to the horizon).
 * A route set on the rule, several buy rules, vendors with validity dates and manufacture refuse.
 */
import { NotPorted } from "../errors";
import { floatRound } from "../orm/convert";
import { defineComputes } from "./tail_util";
import { registerDefaults, registerRecordCompute } from "../orm/recompute";
import { cond } from "../orm/domain";
import { nextByCode, uomQuantity } from "./sale_flow";

// stock_orderpoint.py:27-29 the name's default: `ir.sequence.next_by_code('stock.orderpoint')` (drawn for every
// default_get, as Odoo's lambda); before round 11 the default refused, so no rule could be created
registerDefaults("stock.warehouse.orderpoint", {
  name: async (env) => nextByCode(env, "stock.orderpoint"),
});

const m2o = (v: unknown): number | null => (typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : null);

/** `stock.warehouse.search([('company_id', '=', company)], limit=1)` (stock.warehouse `_order`). */
async function firstWarehouse(env: Environment, company: number | null): Promise<number | false> {
  const [w] = await env.model("stock.warehouse").search(cond("company_id", "=", company ?? false), { limit: 1 });
  return w ?? false;
}

registerRecordCompute("stock.warehouse.orderpoint", {
  // stock_orderpoint.py:293-303 `_compute_warehouse_id` (precompute): the location's warehouse, else the company's
  // first; reading the location computes it (with this field protected, :305-314 sees it empty)
  warehouse_id: async (env, rec) => {
    const location = m2o(await rec.get("location_id"));
    const fromLocation = location !== null ? m2o((await env.model("stock.location").read([location], ["warehouse_id"], ""))[0]?.["warehouse_id"]) : null;
    if (fromLocation !== null) return fromLocation;
    const company = m2o(await rec.get("company_id"));
    const w = company !== null ? await firstWarehouse(env, company) : (await rec.prev("warehouse_id")) ?? false;
    if (!w) throw new NotPorted("stock.warehouse.orderpoint without a warehouse (_warehouse_redirect_warning)");
    return w;
  },
  // :305-314 `_compute_location_id`: the stock location of the warehouse (or of the company's first one)
  location_id: async (env, rec) => {
    let warehouse: number | false | null = m2o(await rec.get("warehouse_id"));
    if (warehouse === null) warehouse = await firstWarehouse(env, m2o(await rec.get("company_id")));
    if (!warehouse) return false;
    return m2o((await env.model("stock.warehouse").read([warehouse], ["lot_stock_id"], ""))[0]?.["lot_stock_id"]) ?? false;
  },
});
import type { Rec } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { orderpointDefaultRoute, rulesFromLocation } from "./inventory_flow";
import { selectSeller } from "./purchase_flow";
import { quantitiesDict } from "./stock_quantities";
import { dbNow, todayInTz, validTz } from "./util";
import { envTz } from "../orm/env";
import { localMidnightToUtc, PyDate } from "../orm/domain";

const idOf = (v: unknown): number | null => (typeof v === "number" && v > 0 ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : null);

interface Op {
  id: number | null; product: Rec; productId: number; template: number; categ: number; uom: number; location: number; company: number;
  min: number; max: number; route: number | null; supplier: number | null; replenishmentUom: number | null;
}

async function opOf(env: Environment, rec: Rec): Promise<Op | null> {
  const product = await rec.rel("product_id");
  const location = idOf(await rec.get("location_id"));
  if (!product || product.origin === null || location === null) return null;
  const tmpl = (await env.cr.query<{ t: number; c: number; u: number }>(
    "SELECT p.product_tmpl_id AS t, t.categ_id AS c, t.uom_id AS u FROM product_product p JOIN product_template t ON t.id = p.product_tmpl_id WHERE p.id = $1", [product.origin])).rows[0]!;
  return {
    id: rec.id, product, productId: product.origin, template: tmpl.t, categ: tmpl.c, uom: tmpl.u, location,
    company: idOf(await rec.get("company_id")) ?? await env.company(),
    min: Number((await rec.get("product_min_qty")) ?? 0), max: Number((await rec.get("product_max_qty")) ?? 0),
    route: idOf(await rec.get("route_id")), supplier: idOf(await rec.get("supplier_id")), replenishmentUom: idOf(await rec.get("replenishment_uom_id")),
  };
}

async function digits(env: Environment): Promise<number> {
  return (await env.cr.query<{ digits: number }>("SELECT digits FROM decimal_precision WHERE name = 'Product Unit'")).rows[0]?.digits ?? 2;
}

/** uom_uom.py:114-123 `compare`: both values rounded to the 'Product Unit' precision. */
async function uomCompare(env: Environment, a: number, b: number): Promise<number> {
  const d = await digits(env);
  const x = floatRound(a, d), y = floatRound(b, d);
  return x === y ? 0 : x < y ? -1 : 1;
}

/** stock_orderpoint.py:853-859 `get_horizon_days`. */
async function horizonDays(env: Environment, company: number): Promise<number> {
  const ctx = env.context["global_horizon_days"];
  if (ctx !== undefined) return Number(ctx || 0);
  return Number((await env.cr.query<{ h: number | null }>("SELECT horizon_days::float8 AS h FROM res_company WHERE id = $1", [company])).rows[0]?.h ?? 0);
}

/** `_compute_lead_days`: the rules' delays, the horizon and (purchase_stock) the vendor's delay and days to purchase. */
async function leadDays(env: Environment, op: Op): Promise<{ total: number; horizon: number; purchase: number }> {
  const rules = await rulesFromLocation(env.sudo(), { template: op.template, categ: op.categ }, op.location, op.company, op.route);
  let total = 0, horizon = 0;
  for (const r of rules) if (["pull", "pull_push"].includes(r.action) && r.delay) total += r.delay;
  if (!env.context["bypass_global_horizon_days"]) horizon += await horizonDays(env, op.company);
  const buy = rules.filter((r) => r.action === "buy");
  if (!buy.length) return { total, horizon, purchase: 0 };
  if (buy.length > 1) throw new NotPorted("orderpoint with several buy rules (ensure_one)");
  const buyCompany = buy[0]!.company_id;
  let delay: number | null;
  if (op.supplier) {
    delay = (await env.cr.query<{ d: number }>("SELECT delay AS d FROM product_supplierinfo WHERE id = $1", [op.supplier])).rows[0]?.d ?? null;
  } else {
    if ((await env.cr.query("SELECT 1 FROM product_supplierinfo WHERE product_tmpl_id = $1 AND (date_start IS NOT NULL OR date_end IS NOT NULL) LIMIT 1", [op.template])).rows.length) {
      throw new NotPorted("orderpoint lead days with dated vendors");
    }
    const company = buyCompany ?? await env.company();
    const seller = await selectSeller(env.withContext({ ...env.context, allowed_company_ids: [company] }), op.product, {
      company, partner: null, date: null, quantity: null, uom: null, forceUom: false, params: false, envCompany: company,
    });
    if (seller?.lastPo) throw new NotPorted("vendor from the last confirmed purchase (purchase/models/product.py _get_last_po_seller_info) for an orderpoint");
    delay = seller ? seller.delay : null;
  }
  if (delay === null) return { total: total + 365, horizon, purchase: 0 };
  const purchase = env.context["ignore_vendor_lead_time"] ? 0 : delay;
  total += purchase;
  const purchaseDays = buyCompany === null ? 0 : Number((await env.cr.query<{ d: number | null }>("SELECT days_to_purchase::float8 AS d FROM res_company WHERE id = $1", [buyCompany])).rows[0]?.d ?? 0);
  return { total: total + purchaseDays, horizon, purchase };
}

/**
 * product.py:726-732 `_get_dates_info` of an orderpoint's product at its location (`_get_lead_days` with
 * bypass_delay_description): the vendor's delay in days (purchase_delay) that the order date is moved back by.
 */
export async function orderpointPurchaseDelay(env: Environment, rec: Rec): Promise<number> {
  const op = await opOf(env, rec);
  if (!op) throw new NotPorted("stock.warehouse.orderpoint procurement without a product or a location");
  return (await leadDays(env, op)).purchase;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.trunc(days));
  return d.toISOString().slice(0, 10);
}

async function leadHorizonDate(env: Environment, op: Op): Promise<string> {
  const { total, horizon } = await leadDays(env, op);
  // fields.Date.today() + relativedelta(days=total_delay + horizon_time)
  return addDays(todayInTz(await dbNow(env), "UTC"), total + horizon);
}

/** purchase_stock product.py:164-214 `_get_quantity_in_progress(location_ids=[location])` for one product, in its unit. */
async function inProgress(env: Environment, op: Op): Promise<number> {
  const rows = (await env.cr.query<{ qty: number; uom: number; orderpoint: number | null; op_location: number | null; forecasted: number | null; type_dest: number | null; has_moves: boolean; has_dest: boolean; forecast_in: boolean }>(
    `SELECT l.product_qty::float8 AS qty, l.uom_id AS uom, l.orderpoint_id AS orderpoint, op.location_id AS op_location, l.forecasted_location_id AS forecasted,
            pt.default_location_dest_id AS type_dest,
            EXISTS (SELECT 1 FROM stock_move m WHERE m.purchase_line_id = l.id) AS has_moves,
            EXISTS (SELECT 1 FROM stock_move_move_rel r JOIN stock_move m ON m.id = r.move_orig_id WHERE m.purchase_line_id = l.id) AS has_dest,
            COALESCE(fl.parent_path LIKE (SELECT parent_path FROM stock_location WHERE id = $2) || '%', false) AS forecast_in
       FROM purchase_order_line l JOIN purchase_order o ON o.id = l.order_id
       LEFT JOIN stock_picking_type pt ON pt.id = o.picking_type_id
       LEFT JOIN stock_warehouse_orderpoint op ON op.id = l.orderpoint_id
       LEFT JOIN stock_location fl ON fl.id = l.forecasted_location_id
      WHERE l.product_id = $1 AND o.state IN ('draft', 'sent', 'to approve')`, [op.productId, op.location])).rows;
  let total = 0;
  for (const r of rows) {
    // _get_lines_domain(location_ids): without orderpoint, the picking type's destination (no forecasted location) or a
    // forecasted location under it (no moves); with one, its location when the line feeds no other move
    const matches = r.orderpoint === null
      ? (r.forecasted === null && r.type_dest === op.location) || (!r.has_moves && r.forecast_in)
      : (!r.has_dest && r.op_location === op.location);
    if (!matches) continue;
    // the line's location (orderpoint, forecasted location, picking type destination) must be the orderpoint's
    const location = r.orderpoint !== null ? r.op_location : r.forecasted ?? r.type_dest;
    if (location !== op.location) continue;
    if (r.has_dest) throw new NotPorted("orderpoint quantity in progress of a line with destination moves");
    total += r.uom === op.uom ? r.qty : await convert(env, r.qty, r.uom, op.uom);
  }
  return total;
}

/** uom_uom.py `_compute_quantity(qty, to_unit, round=False)`. */
async function convert(env: Environment, qty: number, from: number, to: number): Promise<number> {
  const rows = (await env.cr.query<{ id: number; factor: number }>("SELECT id, factor::float8 AS factor FROM uom_uom WHERE id = ANY($1::int[])", [[from, to]])).rows;
  const f = (id: number): number => rows.find((r) => r.id === id)!.factor;
  return qty * f(from) / f(to);
}

async function forecast(env: Environment, op: Op, horizon: string): Promise<{ onHand: number; virtual: number }> {
  const q = (await quantitiesDict(env.withContext({ ...env.context, location: op.location, to_date: `${horizon} 23:59:59` }), [op.productId])).get(op.productId);
  return { onHand: q?.qty_available ?? 0, virtual: q?.virtual_available ?? 0 };
}

/** `_get_multiple_rounded_qty` with purchase_stock's `_get_replenishment_multiple_alternative` (the vendor's unit). */
async function multipleRounded(env: Environment, op: Op, qty: number): Promise<number> {
  let multiple = op.replenishmentUom;
  if (multiple === null) {
    // purchase_stock stock.py:336-340: `self.effective_route_id or self.product_id.route_ids` (stock_orderpoint.py:273-275:
    // the route set, else `_get_default_route`) with a buy rule among the routes' (active) rules
    const effective = op.route ?? await orderpointDefaultRoute(env, op.productId, op.location, { company: op.company, route: op.route });
    const routes = effective !== null ? [effective] : (await env.cr.query<{ r: number }>(
      "SELECT route_id AS r FROM stock_route_product WHERE product_id = $1", [op.template])).rows.map((x) => x.r);
    const buy = routes.length > 0 && (await env.cr.query("SELECT 1 FROM stock_rule WHERE route_id = ANY($1::int[]) AND action = 'buy' AND active LIMIT 1", [routes])).rows.length > 0;
    if (buy) {
      if (op.supplier) multiple = (await env.cr.query<{ u: number }>("SELECT uom_id AS u FROM product_supplierinfo WHERE id = $1", [op.supplier])).rows[0]?.u ?? null;
      else {
        if ((await env.cr.query("SELECT 1 FROM product_supplierinfo WHERE product_tmpl_id = $1 AND (date_start IS NOT NULL OR date_end IS NOT NULL) LIMIT 1", [op.template])).rows.length) {
          throw new NotPorted("orderpoint replenishment unit with dated vendors (_get_dates_info)");
        }
        const seller = await selectSeller(env.withContext({ ...env.context, allowed_company_ids: [op.company] }), op.product, {
          company: op.company, partner: null, date: null, quantity: qty, uom: op.uom, forceUom: false, params: false, envCompany: op.company,
        });
        if (seller?.lastPo) throw new NotPorted("vendor from the last confirmed purchase (purchase/models/product.py _get_last_po_seller_info) for an orderpoint");
        multiple = seller?.uom_id ?? null;
      }
    }
  }
  if (multiple === null) return qty;
  // stock_orderpoint.py:844-851: both conversions are `_compute_quantity` with its rounding (uom_uom.py:139-169:
  // Product Unit digits, UP), around fields.Float.round(qty, precision_digits=0, rounding_method="UP")
  const inMultiple = multiple === op.uom ? qty : await uomQuantity(env, qty, op.uom, multiple);
  const up = Math.ceil(floatRound(inMultiple, 10));
  return multiple === op.uom ? up : await uomQuantity(env, up, multiple, op.uom);
}

/**
 * stock_orderpoint.py:151-204 `_compute_deadline_date`: today when the forecast at the lead horizon is under the
 * minimum, else the first day of the open moves to the company's horizon (grouped per product, the move's own
 * location and `date:day`) where the walk falls under it, less the lead days; False when that is not before the horizon.
 */
async function deadlineDate(env: Environment, rec: Rec): Promise<string | null> {
  const op = await opOf(env, rec);
  if (!op) throw new NotPorted("stock.warehouse.orderpoint.deadline_date without a product or a location");
  const today = todayInTz(await dbNow(env), "UTC");
  const onHand = (await forecast(env, op, await leadHorizonDate(env, op))).onHand;
  if (onHand < op.min) return today;
  const horizon = addDays(today, await horizonDays(env, op.company));
  const lead = (await leadDays(env, op)).total;
  if (!Number.isInteger(lead)) throw new NotPorted("stock.warehouse.orderpoint.deadline_date with fractional lead days (relativedelta on a date)");
  // product.py:349-401 `_get_domain_locations` without location context: the view locations of the companies' warehouses
  const views = (await env.cr.query<{ id: number }>("SELECT view_location_id AS id FROM stock_warehouse WHERE company_id = ANY($1::int[]) AND active", [[...await env.companies()]])).rows.map((r) => r.id);
  if (!views.length) return null;
  // domains.py:1682-1716: `date <= horizon_date` is `date < horizon + 1 day` at midnight in the environment's timezone
  const until = localMidnightToUtc(new PyDate(Date.parse(`${addDays(horizon, 1)}T00:00:00Z`)), await envTz(env)).toString();
  // fields_temporal.py:86-91: the day of a datetime in the context's timezone only
  const ctxTz = validTz(typeof env.context.tz === "string" ? env.context.tz : null);
  const day = ctxTz ? "date_trunc('day', timezone($4, timezone('UTC', m.date)))::date" : "date_trunc('day', m.date)::date";
  // product.py:404-466 `_get_domain_locations_new`: an open move comes in when its forecasted location (or, without
  // one, its destination) is under the views and its source is not; it goes out in the opposite case
  const rows = (await env.cr.query<{ loc: number; d: string; qty: number; dir: string }>(
    `WITH RECURSIVE d AS (SELECT id FROM stock_location WHERE id = ANY($2::int[]) UNION SELECT l.id FROM stock_location l JOIN d ON l.location_id = d.id),
     m AS (SELECT m.*, (CASE WHEN m.forecasted_location_id IS NOT NULL THEN m.forecasted_location_id IN (SELECT id FROM d) ELSE m.location_dest_id IN (SELECT id FROM d) END) AS dest_in,
                  m.location_id IN (SELECT id FROM d) AS src_in
             FROM stock_move m WHERE m.product_id = $1 AND m.state IN ('waiting', 'confirmed', 'assigned', 'partially_available') AND m.date < $3)
     SELECT m.location_dest_id AS loc, ${day}::text AS d, sum(m.product_qty)::float8 AS qty, 'in' AS dir FROM m WHERE m.dest_in AND NOT m.src_in GROUP BY 1, 2
     UNION ALL
     SELECT m.location_id AS loc, ${day}::text AS d, sum(m.product_qty)::float8 AS qty, 'out' AS dir FROM m WHERE m.src_in AND NOT m.dest_in GROUP BY 1, 2`,
    ctxTz ? [op.productId, views, until, ctxTz] : [op.productId, views, until])).rows;
  const byDay = new Map<string, number>();
  for (const r of rows) if (r.loc === op.location) byDay.set(r.d, (byDay.get(r.d) ?? 0) + (r.dir === "in" ? r.qty : -r.qty));
  let qty = onHand;
  let tentative = horizon;
  for (const d of [...byDay.keys()].sort()) {
    qty += byDay.get(d)!;
    if (qty < op.min) { tentative = addDays(d, -lead); break; }
  }
  return tentative < horizon ? tentative : null;
}

/** stock_orderpoint.py:219-246 `_compute_rules` (compute_sudo): the rules from the orderpoint's location, honoring route_id. */
async function opRules(env: Environment, op: Op): Promise<{ action: string }[]> {
  return rulesFromLocation(env.sudo(), { template: op.template, categ: op.categ }, op.location, op.company, op.route);
}

defineComputes("stock.warehouse.orderpoint", {
  deadline_date: deadlineDate,
  // stock_orderpoint.py:469-472 `_compute_qty_to_order_to_max`
  qty_to_order_to_max: async (env, rec) => {
    const op = await opOf(env, rec);
    if (!op) return 0;
    const fc = (await forecast(env, op, await leadHorizonDate(env, op))).virtual + await inProgress(env, op);
    return Math.max(0, await multipleRounded(env, op, op.max - fc));
  },
  // purchase_stock stock.py:259-265 over stock_orderpoint.py:145-147 `_compute_show_supply_warning`: with a buy rule,
  // no vendor (`vendor_ids`, the template's) and no confirmed purchase of the variant in the orderpoint's company
  // (purchase/models/product.py:195-202); else no rule at all
  show_supply_warning: async (env, rec) => {
    const op = await opOf(env, rec);
    const rules = op ? await opRules(env, op) : [];
    if (op && rules.some((r) => r.action === "buy")) {
      if ((await env.cr.query("SELECT 1 FROM product_supplierinfo WHERE product_tmpl_id = $1 LIMIT 1", [op.template])).rows.length) return false;
      return (await env.cr.query(
        `SELECT 1 FROM purchase_order_line l JOIN purchase_order o ON o.id = l.order_id
          WHERE l.product_id = $1 AND o.state = 'purchase' AND o.date_approve IS NOT NULL AND o.company_id = $2 LIMIT 1`, [op.productId, op.company])).rows.length === 0;
    }
    return rules.length === 0;
  },
  // stock_orderpoint.py:249-254 `_compute_allowed_replenishment_uom_ids`: the template's packagings | the variant's
  // extra packagings, then (`+=`) the vendors' units when a buy rule applies
  allowed_replenishment_uom_ids: async (env, rec) => {
    const product = await rec.rel("product_id");
    if (!product || product.origin === null) return [];
    const ids = (await env.cr.query<{ id: number }>(
      `SELECT u.id FROM uom_uom u WHERE u.id IN (
         SELECT r.uom_uom_id FROM product_template_uom_uom_rel r JOIN product_product p ON p.product_tmpl_id = r.product_template_id WHERE p.id = $1)
       ORDER BY u.sequence, u.relative_uom_id, u.id`, [product.origin])).rows.map((r) => r.id);
    const extra = (await env.sudo().model("product.product").read([product.origin], ["extra_uom_ids"], "web"))[0]?.["extra_uom_ids"];
    if (Array.isArray(extra) && extra.length) throw new NotPorted("orderpoint allowed units with variant extra packagings");
    const op = await opOf(env, rec);
    if (op && (await opRules(env, op)).some((r) => r.action === "buy")) {
      for (const r of (await env.cr.query<{ u: number }>(
        "SELECT uom_id AS u FROM product_supplierinfo WHERE product_tmpl_id = $1 ORDER BY sequence, min_qty DESC, price, id", [op.template])).rows) {
        if (!ids.includes(r.u)) ids.push(r.u);
      }
    }
    return ids;
  },
  lead_days: async (env, rec) => { const op = await opOf(env, rec); return op ? (await leadDays(env, op)).total : 0; },
  lead_horizon_date: async (env, rec) => { const op = await opOf(env, rec); return op ? leadHorizonDate(env, op) : null; },
  qty_on_hand: async (env, rec) => {
    const op = await opOf(env, rec);
    return op ? (await forecast(env, op, await leadHorizonDate(env, op))).onHand : 0;
  },
  qty_forecast: async (env, rec) => {
    const op = await opOf(env, rec);
    return op ? (await forecast(env, op, await leadHorizonDate(env, op))).virtual + await inProgress(env, op) : 0;
  },
  qty_to_order_computed: async (env, rec) => {
    const op = await opOf(env, rec);
    if (!op || op.id === null) return 0;
    const horizon = await leadHorizonDate(env, op);
    const progress = await inProgress(env, op);
    const fc = (await forecast(env, op, horizon)).virtual + progress;
    // `(self - orderpoints).qty_to_order_computed = False` is 0.0 in the Float cache: no write when it was 0
    if ((await uomCompare(env, fc, op.min)) >= 0) return 0;
    return multipleRounded(env, op, Math.max(op.min, op.max) - fc);
  },
});
