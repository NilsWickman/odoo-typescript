/**
 * The procurement of automatic reordering rules (stock_orderpoint.py:749-830 `_procure_orderpoint_confirm`) through
 * `stock.rule.run` (stock_rule.py:426-480, purchase_stock stock_rule.py:45-56) and purchase_stock's `_run_buy`
 * (stock_rule.py:58-160): the vendor (`_find_procurement_supplier`, `_pick_supplier`), the request for quotation it
 * goes on (`_make_po_get_domain` with project_purchase_stock's project), a matching line (`_find_candidate`) whose
 * quantity grows (`_update_purchase_order_line`), a new line (`_prepare_purchase_order_line_from_procurement`) or a
 * new request (`_prepare_purchase_order`). Routes on the orderpoint, rules other than buy, failed procurements (the
 * warning activity), units or currencies other than the line's, grouped requests per day or week and vendors in
 * another language refuse with NotPorted.
 */
import { NotPorted } from "../errors";
import { localMidnightToUtc, PyDate } from "../orm/domain";
import { envTz } from "../orm/env";
import { DbRec, RecomputeQueue } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { write } from "../orm/write";
import { create } from "../orm/create";
import { pyFloat } from "../orm/values";
import { trackPrepare } from "../mail/tracking";
import { closeTrackingScope } from "../mail/write_hooks";
import { addPrecommit } from "./precommit";
import { fiscalPositionFor } from "./sale_computes";
import { mapTax, taxesOfCompany } from "./sale_flow";
import { orderpointPurchaseDelay } from "./orderpoint_forecast";
import { selectSeller } from "./purchase_flow";
import { PrivateDatetime, privateNormal, PrivateRecords } from "../orm/private_hooks";
import { findRule, type RuleRow } from "./sale_confirm";
import { withCompany } from "./tail_util";
import { datetimeToString, dbNow, todayInTz, validTz } from "./util";
import * as priv from "../orm/dispatch_gen";

const SUPERUSER_ID = 1;
type Seller = NonNullable<Awaited<ReturnType<typeof selectSeller>>>;

async function rows<T extends object>(env: Environment, text: string, params: unknown[]): Promise<T[]> {
  return (await env.cr.query<T & Record<string, unknown>>(text, params)).rows;
}

const shiftDays = (dt: string, days: number): string => datetimeToString(new Date(Date.parse(`${dt.replace(" ", "T")}Z`) + days * 86400000));

async function unitDigits(env: Environment): Promise<number> {
  return (await rows<{ d: number }>(env, "SELECT digits AS d FROM decimal_precision WHERE name = 'Product Unit'", []))[0]?.d ?? 2;
}

function compare(a: number, b: number, digits: number): number {
  const f = 10 ** digits;
  const x = Math.round(a * f), y = Math.round(b * f);
  return x === y ? 0 : x < y ? -1 : 1;
}

interface Procurement {
  orderpoint: number; product: number; template: number; categ: number; qty: number; uom: number; location: number; name: string; origin: string; company: number;
  warehouse: number | null; route: number | null; datePlanned: string; dateOrder: string; dateDeadline: string; references: number[]; supplierinfo: number | null;
  /** the context's `origins` was given (`_prepare_procurement_values` then has `reference_ids`, maybe empty) */
  referencesGiven: boolean;
}

/**
 * stock_orderpoint.py:749-830 for the orderpoints (in this order) of one company, with `origins` the stock references
 * per orderpoint (`_trigger_scheduler`'s context).
 */
export async function procureOrderpoints(
  env0: Environment,
  points: readonly number[],
  origins: ReadonlyMap<number, ReadonlySet<number>>,
  company: number,
  qtyOverride?: ReadonlyMap<number, number>,
): Promise<void> {
  const env = await withCompany(env0, company);
  const digits = await unitDigits(env);
  const procurements: Procurement[] = [];
  for (const id of points) {
    const [rec] = await env.model("stock.warehouse.orderpoint").read([id], ["qty_to_order", "lead_horizon_date", "name", "display_name"], "");
    const num = (v: unknown): number => (typeof v === "object" && v !== null && "float" in v ? Number((v as { float: number }).float) : Number(v ?? 0));
    const [op] = await rows<{ product_id: number; location_id: number; company_id: number; warehouse_id: number | null; route_id: number | null; supplier_id: number | null; uom: number; template: number; categ: number; type: string; tz: string | null; horizon: number | null; loc_company: number | null }>(env,
      `SELECT o.product_id, o.location_id, o.company_id, o.warehouse_id, o.route_id, o.supplier_id, t.uom_id AS uom, t.id AS template, t.categ_id AS categ, t.type,
              p.tz, c.horizon_days::float8 AS horizon, l.company_id AS loc_company
         FROM stock_warehouse_orderpoint o JOIN product_product pp ON pp.id = o.product_id JOIN product_template t ON t.id = pp.product_tmpl_id
         JOIN res_company c ON c.id = o.company_id JOIN res_partner p ON p.id = c.partner_id JOIN stock_location l ON l.id = o.location_id WHERE o.id = $1`, [id]);
    if (!rec || !op) continue;
    const qty = qtyOverride?.has(id) ? qtyOverride.get(id)! : num(rec["qty_to_order"]);
    if (compare(qty, 0, digits) !== 1) continue;
    const refs = [...(origins.get(id) ?? [])];
    const name = String(rec["name"]);
    let origin = name;
    if (refs.length) {
      const refNames = (await rows<{ id: number; name: string }>(env, "SELECT id, name FROM stock_reference WHERE id = ANY($1::int[])", [refs]));
      const byId = new Map(refNames.map((r) => [r.id, r.name]));
      origin = `${String(rec["display_name"])} - ${refs.map((r) => byId.get(r) ?? "").join(",")}`;
    }
    // :845-846 `_get_orderpoint_procurement_date`: noon of the lead horizon day in the company's timezone, in UTC
    const horizonDay = String(rec["lead_horizon_date"]);
    const noon = localMidnightToUtc(new PyDate(Date.parse(`${horizonDay}T12:00:00Z`)), validTz(op.tz) ?? "UTC");
    let date = datetimeToString(new Date(noon.ms));
    // :776-778 the horizon (get_horizon_days) moves the date back
    const horizon = env.context["global_horizon_days"] !== undefined ? Number(env.context["global_horizon_days"] || 0) : Number(op.horizon ?? 0);
    if (Math.trunc(horizon)) date = shiftDays(date, -Math.trunc(horizon));
    // :729-748 `_prepare_procurement_values` (product.py:726-732 `_get_dates_info`), purchase_stock stock.py:331-334
    let purchaseDelay = 0;
    if (op.route_id) {
      const seller = await selectSeller(env.withContext({ ...env.context, allowed_company_ids: [op.company_id] }), new DbRec(env, env.reg.model("product.product"), op.product_id), {
        company: op.company_id, partner: null, date: null, quantity: null, uom: null, forceUom: false, params: false, envCompany: op.company_id,
      });
      purchaseDelay = env.context["ignore_vendor_lead_time"] ? 0 : (seller?.delay ?? 0);
    } else {
      purchaseDelay = await orderpointPurchaseDelay(env, new DbRec(env, env.reg.model("stock.warehouse.orderpoint"), id));
    }
    procurements.push({
      orderpoint: id, product: op.product_id, template: op.template, categ: op.categ, qty, uom: op.uom, location: op.location_id, name, origin, company: op.company_id,
      warehouse: op.warehouse_id, route: op.route_id, datePlanned: date, dateOrder: shiftDays(date, -purchaseDelay), dateDeadline: date, references: refs, supplierinfo: op.supplier_id,
      referencesGiven: origins.size > 0,
    });
    if (op.type !== "consu") throw new NotPorted("stock.rule.run of a product that is not goods (_skip_procurement)");
  }
  if (!procurements.length) return;
  await run(env.withContext({ ...env.context, from_orderpoint: true }), procurements);
  // :805 `_post_process_scheduler` is empty
}

/** Find a rule on a specific route_id walking up the location chain (stock_rule.py `_get_rule` with route_ids). */
async function findRuleForRoute(env: Environment, location: number, routeId: number, warehouse: number | null, company: number): Promise<RuleRow | null> {
  const chain = (await rows<{ id: number }>(env,
    `WITH RECURSIVE up(id, parent, depth) AS (SELECT id, location_id, 0 FROM stock_location WHERE id = $1
       UNION ALL SELECT l.id, l.location_id, up.depth + 1 FROM stock_location l JOIN up ON l.id = up.parent) SELECT id FROM up ORDER BY depth`, [location])).map((r) => r.id);
  const rules = await rows<RuleRow & { location_dest_id: number }>(env,
    `SELECT r.id, r.action, r.procure_method, r.location_src_id, r.picking_type_id, r.warehouse_id, r.delay, r.propagate_cancel, r.company_id, r.location_dest_from_rule,
            r.partner_address_id, r.route_id, r.location_dest_id
       FROM stock_rule r WHERE r.active AND r.action != 'push' AND r.route_id = $1 AND r.location_dest_id = ANY($2::int[])
        AND (r.warehouse_id = $3 OR r.warehouse_id IS NULL) AND (r.company_id IS NULL OR r.company_id = $4)
      ORDER BY r.route_sequence, r.sequence, r.id`, [routeId, chain, warehouse, company]);
  for (const loc of chain) {
    const candidates = rules.filter((r) => r.location_dest_id === loc);
    const hit = candidates.find((r) => r.warehouse_id === warehouse) ?? candidates.find((r) => r.warehouse_id === null);
    if (hit) return hit;
  }
  return null;
}

/** stock_location.py:600-611 `_get_routes_with_no_warehouse` with purchase_stock's buy action. */
async function routesWithNoWarehouse(env: Environment): Promise<number[]> {
  const company = await env.company();
  return (await rows<{ id: number }>(env,
    `SELECT r.id FROM stock_route r WHERE r.active AND r.warehouse_selectable AND (r.company_id IS NULL OR r.company_id = $1)
        AND EXISTS (SELECT 1 FROM stock_rule x WHERE x.route_id = r.id AND x.active AND x.action = 'buy')
        AND (NOT EXISTS (SELECT 1 FROM stock_route_warehouse rw WHERE rw.route_id = r.id)
             OR NOT EXISTS (SELECT 1 FROM stock_route_warehouse rw JOIN stock_warehouse w ON w.id = rw.warehouse_id WHERE rw.route_id = r.id AND w.company_id = $1))`, [company])).map((r) => r.id);
}

/** stock_rule.py:426-480 `run` (purchase_stock :45-56 adds the reception route to buy routes, none here). */
async function run(env: Environment, procurements: Procurement[]): Promise<void> {
  if ((await routesWithNoWarehouse(env)).length) throw new NotPorted("stock.rule._get_rule with routes without warehouse");
  const buys: [Procurement, RuleRow][] = [];
  for (const p of procurements) {
    if (compare(p.qty, 0, await unitDigits(env)) === 0) continue; // `_skip_procurement`
    const company = p.company;
    const rule = (p.route ? await findRuleForRoute(env.sudo(), p.location, p.route, p.warehouse, company) : null)
      ?? await findRule(env.sudo(), { template: p.template, categ: p.categ }, p.location, p.warehouse, company);
    if (!rule) throw new NotPorted("stock.rule.run without a rule (the orderpoint's warning activity)");
    if (rule.action !== "buy") throw new NotPorted(`stock.rule.run of an orderpoint through a ${rule.action} rule`);
    buys.push([p, rule]);
  }
  if (buys.length) await runBuy(env, buys);
}

interface PartnerRow { id: number; buyer_id: number | null; group_rfq: string | null; currency: number | null; lang: string | null; term: number | null }

/** purchase_stock stock_rule.py:385-410 `_find_procurement_supplier` and `_pick_supplier`. */
async function findSupplier(env: Environment, company: number, p: Procurement): Promise<Seller | null> {
  const product = new DbRec(env, env.reg.model("product.product"), p.product);
  const cenv = env.withContext({ ...env.context, allowed_company_ids: [company] });
  if (p.supplierinfo) throw new NotPorted("stock.rule._run_buy with the orderpoint's vendor (supplierinfo_id)");
  const today = todayInTz(await dbNow(env), "UTC");
  const day = p.datePlanned.slice(0, 10) > today ? p.datePlanned.slice(0, 10) : today;
  const ctxToday = todayInTz(await dbNow(env), await envTz(env));
  // :402-406 the four calls with `params={"force_uom": procurement.values.get('force_uom')}` (no force_uom here), the
  // fifth without params
  const pick = (o: { quantity: number | null; date: string; uom: number | null; params?: false }): Promise<Seller | null> =>
    selectSeller(cenv, product, { company, partner: null, date: o.date, quantity: o.quantity, uom: o.uom, forceUom: false, envCompany: company,
      params: o.params ?? { force_uom: null } });
  return (await pick({ quantity: p.qty, date: day, uom: p.uom })) ?? (await pick({ quantity: null, date: day, uom: p.uom }))
    ?? (await pick({ quantity: null, date: ctxToday, uom: p.uom })) ?? (await pick({ quantity: null, date: ctxToday, uom: null }))
    ?? (await pick({ quantity: null, date: ctxToday, uom: null, params: false }))
    ?? (await anySeller(env, p));
}

/** :408-409 the last fallback, also matching expired pricelists: refuses rather than guessing the expired vendor. */
async function anySeller(env: Environment, p: Procurement): Promise<null> {
  if ((await rows(env, "SELECT 1 FROM product_supplierinfo WHERE product_tmpl_id = $1 LIMIT 1", [p.template])).length) {
    throw new NotPorted("stock.rule._pick_supplier of an expired or other company's vendor (_prepare_sellers fallback)");
  }
  return null;
}

/** purchase_stock stock_rule.py:58-160 `_run_buy`. */
async function runBuy(env: Environment, procurements: [Procurement, RuleRow][]): Promise<void> {
  const digits = await unitDigits(env);
  const byDomain = new Map<string, { p: Procurement; rule: RuleRow; seller: Seller; partner: PartnerRow; currency: number; company: number;
    extra: [string, unknown][]; values: ProcurementValues }[]>();
  for (const [p, rule] of procurements) {
    const company = rule.company_id ?? p.company;
    const seller = await findSupplier(env, company, p);
    if (!seller) throw new NotPorted("stock.rule._run_buy without a vendor (ProcurementException, the warning activity on the product)");
    const [partner] = await rows<PartnerRow>(env,
      `SELECT p.id, p.buyer_id, p.group_rfq, NULL::int AS currency, p.lang, NULL::int AS term FROM res_partner p WHERE p.id = $1`, [seller.partner_id]);
    if (!partner) throw new NotPorted("stock.rule._run_buy vendor missing");
    const props = (await env.withContext({ ...env.context, allowed_company_ids: [company] }).sudo().model("res.partner").read([partner.id], ["property_purchase_currency_id", "property_supplier_payment_term_id"], ""))[0] ?? {};
    const idOf = (v: unknown): number | null => (typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : null);
    partner.currency = idOf(props["property_purchase_currency_id"]);
    partner.term = idOf(props["property_supplier_payment_term_id"]);
    if (partner.group_rfq && partner.group_rfq !== "default") throw new NotPorted(`stock.rule._make_po_get_domain with requests grouped per ${partner.group_rfq}`);
    const companyCurrency = (await rows<{ c: number }>(env, "SELECT currency_id AS c FROM res_company WHERE id = $1", [company]))[0]!.c;
    const currency = seller.currency_id ?? partner.currency ?? companyCurrency;
    if (currency !== companyCurrency) throw new NotPorted("stock.rule._run_buy in another currency");
    // stock_rule.py:325-366 `_make_po_get_domain` through callPrivate (private_hooks.json): the hand is purchase_stock's
    // (group_rfq 'default': the references, or none) with project_purchase_stock's project_id = False
    const values = await procurementValues(env, p, rule, seller, partner);
    const hand: unknown[] = [["partner_id", "=", partner.id], ["state", "=", "draft"], ["picking_type_id", "=", rule.picking_type_id],
      ["company_id", "=", company], ["user_id", "=", partner.buyer_id ?? false], ["currency_id", "=", currency],
      p.references.length ? ["reference_ids", "in", [...p.references]] : ["reference_ids", "=", false], ["project_id", "=", false]];
    const domain = await priv.stock_rule._make_po_get_domain.call(env, [rule.id],
      [new PrivateRecords("res.company", [company]), values.py, new PrivateRecords("res.partner", [partner.id])],
      async (_e, _ids, args) => { values.check(args[1], "_make_po_get_domain"); return hand; });
    const extra = extraDomain(env, hand, domain);
    const key = JSON.stringify(domain);
    const list = byDomain.get(key) ?? [];
    list.push({ p, rule, seller, partner, currency, company, extra, values });
    byDomain.set(key, list);
  }
  for (const group of byDomain.values()) {
    const { partner, rule, currency, company, extra } = group[0]!;
    const origins = [...new Set(group.map((g) => g.p.origin).filter(Boolean))];
    const refs = group[0]!.p.references;
    // the hand's domain as SQL, and the terms a site's override appended (extraDomain)
    const params: unknown[] = [partner.id, rule.picking_type_id, company, partner.buyer_id, currency, refs];
    const more = extra.map(([f, v]) => { params.push(v === false ? null : v); return ` AND o."${f}" IS NOT DISTINCT FROM $${params.length}`; }).join("");
    const [po] = await rows<{ id: number; origin: string | null; date_order: string; date_planned: string | null }>(env,
      `SELECT o.id, o.origin, o.date_order::text AS date_order, o.date_planned::text AS date_planned FROM purchase_order o
        WHERE o.partner_id = $1 AND o.state = 'draft' AND o.picking_type_id = $2 AND o.company_id = $3 AND o.user_id IS NOT DISTINCT FROM $4 AND o.currency_id = $5
          AND o.project_id IS NULL
          AND (CASE WHEN cardinality($6::int[]) > 0 THEN EXISTS (SELECT 1 FROM stock_reference_purchase_rel r WHERE r.purchase_id = o.id AND r.reference_id = ANY($6::int[]))
                    ELSE NOT EXISTS (SELECT 1 FROM stock_reference_purchase_rel r WHERE r.purchase_id = o.id) END)${more}
        ORDER BY o.priority DESC, o.id DESC LIMIT 1`, params);
    const su = env.sudo();
    let poId: number;
    if (!po) {
      // :96-107 a new request for quotation from the procurements with a positive quantity, as the superuser
      const positive = group.filter((g) => compare(g.p.qty, 0, digits) >= 0);
      if (!positive.length) continue;
      poId = await createOrder(env, rule, company, origins, positive.map((g) => ({ p: g.p, seller: g.seller, partner: g.partner, currency: g.currency, values: g.values })));
      await trackPrepare(su, "purchase.order", [poId]);
      await addPrecommit(env.cr, () => closeTrackingScope(su, "purchase.order"));
    } else {
      poId = po.id;
      await trackPrepare(su, "purchase.order", [poId]);
      await addPrecommit(env.cr, () => closeTrackingScope(su, "purchase.order"));
      // :108-117 the references (linked) and the origins
      await write(su, "purchase.order", [poId], { reference_ids: refs.map((r) => [4, r, 0]) });
      if (po.origin) {
        const have = new Set(po.origin.split(", "));
        const missing = origins.filter((o) => !have.has(o));
        if (missing.length) await write(su, "purchase.order", [poId], { origin: `${po.origin}, ${missing.join(", ")}` });
      } else await write(su, "purchase.order", [poId], { origin: origins.join(", ") });
    }
    // :119-121 `_get_procurements_to_merge` / `_merge_procurements`: one procurement per orderpoint here
    const seen = new Set<string>();
    for (const g of group) {
      const k = `${g.p.product}/${g.p.uom}/${g.rule.propagate_cancel ?? false}/${g.p.orderpoint}`;
      if (seen.has(k)) throw new NotPorted("stock.rule._merge_procurements of several procurements");
      seen.add(k);
    }
    const newLines: Record<string, unknown>[] = [];
    for (const g of group) {
      const p = g.p;
      const propagate = Boolean(g.rule.propagate_cancel);
      // :126-130 the order's lines of the product; `_find_candidate` (purchase_stock purchase_order_line.py:419-452)
      const lines = await rows<{ id: number; orderpoint_id: number | null; uom_id: number; product_qty: number; price_unit: number; partner_id: number | null; date_order: string; currency_id: number }>(env,
        `SELECT l.id, l.orderpoint_id, l.uom_id, l.product_qty::float8 AS product_qty, l.price_unit::float8 AS price_unit, l.partner_id, o.date_order::text AS date_order, o.currency_id
           FROM purchase_order_line l JOIN purchase_order o ON o.id = l.order_id
          WHERE l.order_id = $1 AND l.product_id = $2 AND l.display_type IS NULL AND COALESCE(l.propagate_cancel, false) = $3
            AND (l.orderpoint_id IS NULL OR l.orderpoint_id = $4) ORDER BY l.id`, [poId, p.product, propagate, p.orderpoint]);
      const [temp] = await rows<{ t: boolean }>(env, "SELECT (create_uid = $2 AND trigger = 'manual') AS t FROM stock_warehouse_orderpoint WHERE id = $1", [p.orderpoint, SUPERUSER_ID]);
      if (temp?.t) throw new NotPorted("purchase.order.line._find_candidate of a temporary manual orderpoint");
      if (lines.length > 1) throw new NotPorted("purchase.order.line._find_candidate over several lines (sorted by orderpoint)");
      const line = lines[0];
      if (!line) {
        if (compare(p.qty, 0, digits) <= 0) continue;
        newLines.push(await prepareLine(env, p, g.seller, g.partner, poId, company, propagate));
        // :151-155 the order date moves back for the new line
        const [o] = await rows<{ date_order: string; date_planned: string | null }>(env,
          "SELECT date_order::text AS date_order, date_planned::text AS date_planned FROM purchase_order WHERE id = $1", [poId]);
        const planned = o!.date_planned ? o!.date_planned.slice(0, 19) : newLines.map((v) => String(v["date_planned"])).sort()[0]!;
        const orderPlanned = shiftDays(planned, -(g.seller.delay || 0));
        if (orderPlanned.slice(0, 10) < o!.date_order.slice(0, 10)) await write(su, "purchase.order", [poId], { date_order: orderPlanned });
        continue;
      }
      // stock_rule.py:290-317 `_update_purchase_order_line`
      if (line.uom_id !== p.uom) throw new NotPorted("stock.rule._update_purchase_order_line in another unit");
      const [sel] = await su.model("purchase.order.line").read([line.id], ["selected_seller_id"], "");
      const selected = sel?.["selected_seller_id"];
      const selectedId = typeof selected === "number" ? selected : Array.isArray(selected) ? Number(selected[0]) : null;
      const sellerPartner = selectedId ? (await rows<{ p: number }>(env, "SELECT partner_id AS p FROM product_supplierinfo WHERE id = $1", [selectedId]))[0]?.p ?? null : null;
      const total = line.product_qty + p.qty;
      const product = new DbRec(env, env.reg.model("product.product"), p.product);
      const seller = await selectSeller(env.withContext({ ...env.context, allowed_company_ids: [company] }), product, {
        company, partner: sellerPartner ?? line.partner_id, date: line.date_order.slice(0, 10), quantity: total, uom: line.uom_id, forceUom: false, params: { force_uom: null }, envCompany: company,
      });
      let price = line.price_unit;
      if (seller) {
        await assertNoIncludedTax(env, line.id, p.product, company);
        price = seller.price;
        if (seller.currency_id !== line.currency_id) throw new NotPorted("stock.rule._update_purchase_order_line in the vendor's other currency");
        if (seller.uom_id !== line.uom_id) throw new NotPorted("stock.rule._update_purchase_order_line in the vendor's unit");
      }
      await write(su, "purchase.order.line", [line.id], { product_qty: total, price_unit: price, move_dest_ids: [], orderpoint_id: p.orderpoint });
      // purchase_stock stock.py:184-188: qty_to_order_computed depends on product_id.purchase_order_line_ids.product_qty
      await recomputeOrderpointsOf(env, [p.product]);
    }
    if (newLines.length) {
      await create(su, "purchase.order.line", newLines);
      await recomputeOrderpointsOf(env, [...new Set(newLines.map((v) => Number(v["product_id"])))]);
    }
  }
}

/** purchase_stock purchase_order_line.py:372-403 with purchase_order_line.py:813-862 `_prepare_purchase_order_line` and sale_purchase_stock. */
async function prepareLine(env: Environment, p: Procurement, supplier: Seller, partner: PartnerRow, poId: number, company: number, propagate: boolean): Promise<Record<string, unknown>> {
  if (supplier.uom_id !== p.uom) throw new NotPorted("purchase.order.line from a procurement in the vendor's unit");
  if (partner.lang && partner.lang !== "en_US") throw new NotPorted("purchase.order.line from a procurement in the vendor's language");
  const [po] = await rows<{ date_order: string; fpos: number | null; currency_id: number; tax_mode: string | null }>(env,
    "SELECT date_order::text AS date_order, fiscal_position_id AS fpos, currency_id, document_tax_mode AS tax_mode FROM purchase_order WHERE id = $1", [poId]);
  const product = new DbRec(env, env.reg.model("product.product"), p.product);
  const today = todayInTz(await dbNow(env), await envTz(env));
  const orderDay = todayInTz(new Date(Date.parse(`${po!.date_order.slice(0, 19).replace(" ", "T")}Z`)), await envTz(env));
  const seller = await selectSeller(env.withContext({ ...env.context, allowed_company_ids: [company] }), product, {
    company, partner: partner.id, date: orderDay > today ? orderDay : today, quantity: p.qty, uom: p.uom, forceUom: false, params: { force_uom: null }, envCompany: company,
  });
  const productTaxes = await taxesOfCompany(env, await product.rels("supplier_taxes_id"), company);
  const position = po!.fpos ? new DbRec(env, env.reg.model("account.fiscal.position"), po!.fpos) : null;
  const taxes = await mapTax(position, productTaxes);
  let price = 0;
  if (seller) {
    if (seller.uom_id !== p.uom) throw new NotPorted("purchase.order.line price in the vendor's unit (_compute_price)");
    const included = await rows(env, "SELECT 1 FROM account_tax WHERE id = ANY($1::int[]) AND (price_include_override = 'tax_included' OR (price_include_override IS NULL AND $2 = 'tax_included')) LIMIT 1",
      [productTaxes.map((t) => t.origin!), po!.tax_mode ?? ""]);
    if (included.length) throw new NotPorted("purchase.order.line from a procurement with price-included taxes (_fix_tax_included_price_company)");
    price = seller.price;
    if (price && seller.currency_id !== po!.currency_id) throw new NotPorted("purchase.order.line from a procurement in the vendor's other currency");
  }
  const [desc] = await rows<{ d: string | null }>(env,
    "SELECT t.description_purchase->>'en_US' AS d FROM product_product pp JOIN product_template t ON t.id = pp.product_tmpl_id WHERE pp.id = $1", [p.product]);
  return {
    name: desc?.d || "", product_qty: p.qty, product_id: p.product, uom_id: p.uom, price_unit: price, date_planned: p.datePlanned,
    tax_ids: [[6, 0, taxes]], order_id: poId, discount: seller?.discount || 0, move_dest_ids: [], forecasted_location_id: p.location,
    orderpoint_id: p.orderpoint, propagate_cancel: propagate, product_description_variants: false, product_no_variant_attribute_value_ids: false, sale_line_id: false,
  };
}

/**
 * purchase_stock stock_rule.py:319-349 `_prepare_purchase_order` (project_purchase_stock: no project) through callPrivate
 * (private_hooks.json; a site's override adds to the values: purchase_requisition_stock's agreement, its reference and
 * currency), and the create as superuser.
 */
async function createOrder(env: Environment, rule: RuleRow, company: number, origins: string[], values: { p: Procurement; seller: Seller; partner: PartnerRow; currency: number; values: ProcurementValues }[]): Promise<number> {
  const purchaseDate = values.map((v) => v.p.dateOrder).sort()[0]!;
  const first = values[0]!;
  const fpos = await fiscalPositionFor(env, company, first.partner.id, null);
  const senv = await withCompany(env.withUser(SUPERUSER_ID).sudo(), company);
  const hand: Record<string, unknown> = {
    partner_id: first.partner.id, user_id: first.partner.buyer_id ?? false, picking_type_id: rule.picking_type_id, company_id: company, currency_id: first.currency,
    dest_address_id: false, origin: origins.join(", "), payment_term_id: first.partner.term ?? false, date_order: purchaseDate, fiscal_position_id: fpos ?? false,
    reference_ids: [[6, 0, first.p.references]],
  };
  const sent = values.map((v) => v.values.py);
  const vals = await priv.stock_rule._prepare_purchase_order.call(env, [rule.id], [new PrivateRecords("res.company", [company]), [...origins], sent],
    async (_e, _ids, args) => {
      const got = args[2];
      if (!Array.isArray(got) || got.length !== values.length) throw new NotPorted("super()._prepare_purchase_order() with other values");
      got.forEach((g, i) => values[i]!.values.check(g, "_prepare_purchase_order"));
      if (JSON.stringify(privateNormal(args[1])) !== JSON.stringify(origins)) throw new NotPorted("super()._prepare_purchase_order() with other origins");
      return hand;
    });
  if (vals === null || typeof vals !== "object" || Array.isArray(vals)) throw new NotPorted("stock.rule._prepare_purchase_order() returned something else than a dict");
  const [id] = await create(senv, "purchase.order", [vals as Record<string, unknown>]);
  return id!;
}

interface ProcurementValues {
  /** the values as compiled code gets them (records as PrivateRecords, datetimes as PrivateDatetime) */
  readonly py: Record<string, unknown>;
  /** refuses when `super()` got other values than these (an override that changed them: the hand does not read them) */
  check(got: unknown, method: string): void;
}

/**
 * `procurement.values` at stock_rule.py:84 `_make_po_get_domain` for an orderpoint's procurement: stock_orderpoint.py:729-747
 * `_prepare_procurement_values` with purchase_stock's `supplierinfo_id` (stock.py:331-334), stock_rule.py:450-452's
 * defaults, then :79-81 the vendor, the partner and propagate_cancel. The vendor's information is product_supplierinfo.py:103-117
 * `_get_seller_info`; the last confirmed order line as a vendor (purchase product.py:235-255) is refused to compiled code.
 */
async function procurementValues(env: Environment, p: Procurement, rule: RuleRow, seller: Seller, partner: PartnerRow): Promise<ProcurementValues> {
  const R = (model: string, ids: readonly (number | null | undefined)[]): PrivateRecords => new PrivateRecords(model, ids.filter((i): i is number => typeof i === "number"));
  const py: Record<string, unknown> = {};
  if (await priv.stock_rule._make_po_get_domain.overridden(env) || await priv.stock_rule._prepare_purchase_order.overridden(env)) {
    if (seller.lastPo) throw new NotPorted("procurement values of a vendor from the last purchase order for compiled code (_get_last_po_seller_info)");
    const [info] = await env.sudo().model("product.supplierinfo").read([seller.id], ["price_discounted"], "");
    const [loc] = await rows<{ c: number | null }>(env, "SELECT company_id AS c FROM stock_location WHERE id = $1", [p.location]);
    Object.assign(py, {
      route_ids: R("stock.route", []), date_planned: new PrivateDatetime(p.datePlanned.slice(0, 19)), date_order: new PrivateDatetime(p.dateOrder.slice(0, 19)),
      date_deadline: new PrivateDatetime(p.dateDeadline.slice(0, 19)), warehouse_id: R("stock.warehouse", [p.warehouse]), orderpoint_id: R("stock.warehouse.orderpoint", [p.orderpoint]),
      ...(p.referencesGiven ? { reference_ids: R("stock.reference", p.references) } : {}),
      supplierinfo_id: R("product.supplierinfo", []), company_id: R("res.company", [loc?.c]), priority: "0",
      supplier: {
        supplierinfo: R("product.supplierinfo", [seller.id]), partner_id: R("res.partner", [seller.partner_id]), price: pyFloat(seller.price), discount: pyFloat(seller.discount),
        price_discounted: info?.["price_discounted"], currency_id: R("res.currency", [seller.currency_id]), uom_id: R("uom.uom", [seller.uom_id]),
        min_qty: pyFloat(seller.min_qty), delay: seller.delay,
      },
      procurement_partner: R("res.partner", [partner.id]), propagate_cancel: Boolean(rule.propagate_cancel),
    });
  }
  const sent = JSON.stringify(privateNormal(py));
  return {
    py,
    check(got: unknown, method: string): void {
      if (JSON.stringify(privateNormal(got)) !== sent) throw new NotPorted(`super().${method}() with other procurement values`);
    },
  };
}

/**
 * The terms a site's `_make_po_get_domain` appended to the hand's domain: `(field, '=', value)` on a stored scalar or
 * many2one column of purchase.order (purchase_requisition_stock's `requisition_id`). Anything else refuses.
 */
function extraDomain(env: Environment, hand: readonly unknown[], domain: unknown): [string, unknown][] {
  if (!Array.isArray(domain) || domain.length < hand.length) throw new NotPorted("stock.rule._make_po_get_domain() returned something else than the hand's domain and more");
  if (JSON.stringify(privateNormal(domain.slice(0, hand.length))) !== JSON.stringify(hand)) throw new NotPorted("stock.rule._make_po_get_domain() changed the hand's domain");
  const fields = env.reg.model("purchase.order").fields;
  return domain.slice(hand.length).map((t) => {
    const ok = Array.isArray(t) && t.length === 3 && typeof t[0] === "string" && t[1] === "=" && (typeof t[2] === "number" || typeof t[2] === "string" || t[2] === false);
    const f = ok ? fields.get(t[0] as string) : undefined;
    if (!ok || !f || !f.store || !["many2one", "char", "integer", "selection", "boolean"].includes(f.type)) {
      throw new NotPorted(`stock.rule._make_po_get_domain() term ${JSON.stringify(t)}`);
    }
    return [t[0] as string, t[2]] as [string, unknown];
  });
}

/** account_tax.py:4983-4999 `_fix_tax_included_price_company`: only the case without price-included taxes to remove. */
async function assertNoIncludedTax(env: Environment, line: number, product: number, company: number): Promise<void> {
  const hit = await rows(env,
    `SELECT 1 FROM product_supplier_taxes_rel r JOIN product_product p ON p.product_tmpl_id = r.prod_id JOIN account_tax t ON t.id = r.tax_id
      WHERE p.id = $1 AND t.company_id = $2 AND COALESCE(t.price_include_override, '') = 'tax_included'
        AND NOT EXISTS (SELECT 1 FROM account_tax_purchase_order_line_rel x WHERE x.purchase_order_line_id = $3 AND x.account_tax_id = t.id) LIMIT 1`, [product, company, line]);
  if (hit.length) throw new NotPorted("stock.rule._update_purchase_order_line with a price-included tax (_fix_tax_included_price_company)");
  const mode = await rows<{ m: string | null }>(env, "SELECT account_price_include AS m FROM res_company WHERE id = $1", [company]);
  if (mode[0]?.m === "tax_included") throw new NotPorted("stock.rule._update_purchase_order_line in a company with tax-included prices");
}

/** The orderpoints of the products get `qty_to_order_computed` again (the depends on the purchase lines). */
async function recomputeOrderpointsOf(env: Environment, products: readonly number[]): Promise<void> {
  const su = env.sudo();
  const points = (await rows<{ id: number }>(env, "SELECT id FROM stock_warehouse_orderpoint WHERE product_id = ANY($1::int[]) ORDER BY id", [[...products]])).map((r) => r.id);
  if (!points.length) return;
  const queue = new RecomputeQueue(su);
  queue.add("stock.warehouse.orderpoint", "qty_to_order_computed", points);
  await queue.run();
}

export const _forTests = { compare, shiftDays };
