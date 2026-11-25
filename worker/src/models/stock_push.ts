/**
 * Push rules after a move is done (stock_move.py:1273-1332 `_push_apply`, stock_rule.py:226-260
 * `_push_prepare_move_copy_values`, :650-667 `_get_push_rule`, :516-543 `_search_rule`) and the assignment of the done
 * moves' destination moves (stock_move.py:2400-2420): the multi-step routes of a warehouse (pick then ship, input
 * then quality control then stock). Transparent rules, push domains, packages, another company's destination and
 * moves whose destination moves start elsewhere (`_break_mto_link`) refuse with NotPorted.
 */
import { NotPorted, UserError } from "../errors";
import type { Environment } from "../orm/types";
import { create } from "../orm/create";
import { write } from "../orm/write";
import { copyData } from "../web/save";
import { actionAssign, actionConfirm, moveRows, orderpointsToUpdate, recomputeOrderpoints } from "./stock_engine";
import { registerOverrides } from "../orm/write";
import { unlink } from "../orm/unlink";
import { withCompany } from "./tail_util";
import { datetimeToString, translate } from "./util";

async function rows<T extends object>(env: Environment, text: string, params: unknown[]): Promise<T[]> {
  return (await env.cr.query<T & Record<string, unknown>>(text, params)).rows;
}

/** `a._child_of(b)` (stock_location.py): a is b or below it. */
async function childOf(env: Environment, a: number | null, b: number | null): Promise<boolean> {
  if (!a || !b) return false;
  return (await rows(env, `SELECT 1 FROM stock_location x, stock_location y WHERE x.id = $1 AND y.id = $2 AND x.parent_path LIKE y.parent_path || '%'`, [a, b])).length > 0;
}

interface PushMove {
  id: number; product_id: number; template: number; categ: number; location_id: number; location_dest_id: number; forecasted_location_id: number | null;
  warehouse_id: number | null; picking_id: number | null; picking_name: string | null; type_warehouse: number | null; dest_warehouse: number | null;
  dest_company: number | null; is_inventory: boolean | null; origin: string | null; date: string; date_deadline: string | null; partner_id: number | null;
  product_uom_qty: number; packaging_uom_id: number | null;
}

interface PushRule { id: number; location_src_id: number; location_dest_id: number; picking_type_id: number | null; company_id: number | null; warehouse_id: number | null;
  rule_wh_company: number | null; type_wh_company: number | null; delay: number | null; propagate_cancel: boolean | null; partner_address_id: number | null;
  auto: string; push_domain: string | null; dest_usage: string }

/** stock_rule.py:516-543 `_search_rule` with a push domain on `location_src_id` (the active rules the user's companies see). */
async function searchRule(env: Environment, companies: readonly number[], routes: readonly number[], m: PushMove, warehouse: number | null, location: number): Promise<PushRule | null> {
  const find = async (routeIds: readonly number[] | null): Promise<PushRule | null> => (await rows<PushRule>(env,
    `SELECT x.id, x.location_src_id, x.location_dest_id, x.picking_type_id, x.company_id, x.warehouse_id, w.company_id AS rule_wh_company, tw.company_id AS type_wh_company,
            x.delay, x.propagate_cancel, x.partner_address_id, x.auto, x.push_domain, d.usage AS dest_usage
       FROM stock_rule x JOIN stock_location d ON d.id = x.location_dest_id LEFT JOIN stock_warehouse w ON w.id = x.warehouse_id
       LEFT JOIN stock_picking_type t ON t.id = x.picking_type_id LEFT JOIN stock_warehouse tw ON tw.id = t.warehouse_id
      WHERE x.active AND x.location_src_id = $1 AND x.action IN ('push', 'pull_push') AND ($2::int IS NULL OR x.warehouse_id IS NULL OR x.warehouse_id = $2)
        AND (x.company_id IS NULL OR x.company_id = ANY($3::int[])) AND ($4::int[] IS NULL OR x.route_id = ANY($4::int[]))
      ORDER BY x.route_sequence, x.sequence, x.id LIMIT 1`, [location, warehouse, [...companies], routeIds === null ? null : [...routeIds]]))[0] ?? null;
  let res: PushRule | null = null;
  if (routes.length) res = await find(routes);
  if (!res && m.packaging_uom_id) {
    const packaging = (await rows<{ r: number }>(env,
      `SELECT rr.stock_route_id AS r FROM uom_uom u JOIN stock_package_type_stock_route_rel rr ON rr.stock_package_type_id = u.package_type_id WHERE u.id = $1`, [m.packaging_uom_id])).map((r) => r.r);
    if (packaging.length) throw new NotPorted("stock.rule._search_rule through the routes of a package type");
  }
  if (!res) {
    const product = (await rows<{ r: number }>(env,
      `SELECT route_id AS r FROM stock_route_product WHERE product_id = $1
       UNION SELECT rc.route_id FROM stock_route_categ rc WHERE rc.categ_id IN (
         WITH RECURSIVE c(id, parent) AS (SELECT id, parent_id FROM product_category WHERE id = $2 UNION ALL SELECT p.id, p.parent_id FROM product_category p JOIN c ON p.id = c.parent)
         SELECT id FROM c)`, [m.template, m.categ])).map((r) => r.r);
    if (product.length) res = await find(product);
  }
  if (!res && warehouse) {
    const house = (await rows<{ r: number }>(env, "SELECT route_id AS r FROM stock_route_warehouse WHERE warehouse_id = $1", [warehouse])).map((r) => r.r);
    if (house.length) res = await find(house);
  } else if (!res && !warehouse) res = await find(null);
  return res;
}

/** stock_rule.py:650-667 `_get_push_rule`: the location and then its parents. */
async function pushRule(env: Environment, companies: readonly number[], m: PushMove, locationDest: number, routes: readonly number[], warehouse: number | null): Promise<PushRule | null> {
  let location: number | null = locationDest;
  while (location) {
    const rule = await searchRule(env, companies, routes, m, warehouse, location);
    if (rule) {
      if (rule.push_domain) throw new NotPorted("stock.rule._get_push_rule with a push domain");
      return rule;
    }
    location = (await rows<{ p: number | null }>(env, "SELECT location_id AS p FROM stock_location WHERE id = $1", [location]))[0]?.p ?? null;
  }
  return null;
}

/** stock_rule.py:226-260 `_push_prepare_move_copy_values`. */
async function pushValues(env: Environment, rule: PushRule, m: PushMove): Promise<Record<string, unknown>> {
  const company = rule.company_id ?? rule.rule_wh_company ?? rule.type_wh_company;
  let location = rule.location_src_id;
  let locationDest = rule.location_dest_id;
  let finalLocation: number | false = false;
  if (await childOf(env, m.location_dest_id, rule.location_src_id)) location = m.location_dest_id;
  if (m.forecasted_location_id && !(await childOf(env, m.location_dest_id, m.forecasted_location_id))) finalLocation = m.forecasted_location_id;
  if (m.forecasted_location_id && (await childOf(env, m.forecasted_location_id, rule.location_dest_id))) locationDest = m.forecasted_location_id;
  else if (m.partner_id && rule.dest_usage === "customer") {
    const cenv = await withCompany(env, company ?? await env.company());
    const v = (await cenv.model("res.partner").read([m.partner_id], ["property_stock_customer"], ""))[0]?.["property_stock_customer"];
    locationDest = typeof v === "number" ? v : Array.isArray(v) ? Number(v[0]) : (() => { throw new NotPorted("push to a partner without customer location"); })();
  }
  const dests = (await rows<{ d: number }>(env, "SELECT move_dest_id AS d FROM stock_move_move_rel WHERE move_orig_id = $1 ORDER BY move_dest_id", [m.id])).map((r) => r.d);
  // :218-224 `_get_push_new_date`: the move's date plus the rule's delay in days
  const date = rule.delay ? datetimeToString(new Date(Date.parse(`${m.date.replace(" ", "T")}Z`) + rule.delay * 86400000)) : m.date;
  const vals: Record<string, unknown> = {
    origin: m.origin || m.picking_name || "/", location_id: location, location_dest_id: locationDest, forecasted_location_id: finalLocation, rule_id: rule.id,
    date, date_deadline: m.date_deadline ?? false, company_id: company ?? false, picking_id: false, picking_type_id: rule.picking_type_id ?? false,
    propagate_cancel: rule.propagate_cancel ?? false, warehouse_id: rule.warehouse_id ?? m.dest_warehouse ?? false, procure_method: "make_to_order",
    move_orig_ids: [[4, m.id, 0]], move_dest_ids: dests.map((d) => [4, d, 0]), partner_id: rule.partner_address_id ?? m.partner_id ?? false,
  };
  // purchase_stock stock_rule.py:361-366: no purchase line, unless the rule returns to a vendor
  if (env.reg.model("stock.move").fields.has("purchase_line_id")) {
    if (rule.dest_usage === "supplier") throw new NotPorted("stock.rule._push_prepare_move_copy_values to a vendor (_get_purchase_line_and_partner_from_chain)");
    vals["purchase_line_id"] = false;
  }
  return vals;
}

/** stock_move.py:1273-1332 `_push_apply` of done moves (the ones `_skip_push` keeps); returns the new moves. */
export async function pushApply(env0: Environment, moveIds: readonly number[]): Promise<number[]> {
  const env = env0.sudo();
  const companies = await env0.companies();
  const moves = await rows<PushMove>(env,
    `SELECT m.id, m.product_id, t.id AS template, t.categ_id AS categ, m.location_id, m.location_dest_id, m.forecasted_location_id, m.warehouse_id, m.picking_id,
            p.name AS picking_name, pt.warehouse_id AS type_warehouse, d.warehouse_id AS dest_warehouse, d.company_id AS dest_company, m.is_inventory, m.origin,
            m.date::text AS date, m.date_deadline::text AS date_deadline, m.partner_id, m.product_uom_qty::float8 AS product_uom_qty, m.packaging_uom_id
       FROM stock_move m JOIN product_product pp ON pp.id = m.product_id JOIN product_template t ON t.id = pp.product_tmpl_id JOIN stock_location d ON d.id = m.location_dest_id
       LEFT JOIN stock_picking p ON p.id = m.picking_id LEFT JOIN stock_picking_type pt ON pt.id = p.picking_type_id
      WHERE m.id = ANY($1::int[]) ORDER BY array_position($1::int[], m.id)`, [[...moveIds]]);
  const valsList: Record<string, unknown>[] = [];
  for (const m of moves) {
    // :2408 `_skip_push`
    if (m.is_inventory) continue;
    const destLocs = await rows<{ l: number }>(env, "SELECT d.location_id AS l FROM stock_move_move_rel r JOIN stock_move d ON d.id = r.move_dest_id WHERE r.move_orig_id = $1", [m.id]);
    let skip = false;
    for (const d of destLocs) if ((await childOf(env, d.l, m.location_dest_id)) || (await childOf(env, m.location_dest_id, d.l))) skip = true;
    if (skip) continue;
    const warehouse = m.dest_warehouse ? (m.warehouse_id ?? m.type_warehouse) : null;
    if (m.dest_company !== null && !companies.includes(m.dest_company)) throw new NotPorted("stock.move._push_apply to another company's location");
    const baseRoutes = (await rows<{ r: number }>(env, "SELECT route_id AS r FROM stock_route_move WHERE move_id = $1", [m.id])).map((r) => r.r);
    const lines = await rows<{ id: number; location_dest_id: number; result_package_id: number | null; quantity: number }>(env,
      "SELECT id, location_dest_id, result_package_id, quantity::float8 AS quantity FROM stock_move_line WHERE move_id = $1 ORDER BY id", [m.id]);
    // :1295-1302 the lines grouped by (destination, result_package), one rule per group; packages add their package types' routes
    let pkgRoutes: number[] | null = null;
    const byRule = new Map<number, { rule: PushRule; qty: number; any: boolean }>();
    const groups = new Map<string, { dest: number; pkg: number | null; ids: number[] }>();
    for (const l of lines) {
      const k = `${l.location_dest_id}/${l.result_package_id ?? ""}`;
      const g = groups.get(k) ?? { dest: l.location_dest_id, pkg: l.result_package_id, ids: [] };
      g.ids.push(l.id);
      groups.set(k, g);
    }
    let routes = baseRoutes;
    for (const { dest, pkg, ids } of groups.values()) {
      if (pkg !== null) {
        if (pkgRoutes === null) {
          const allResPkgs = [...new Set(lines.map((l) => l.result_package_id).filter((p): p is number => p !== null))];
          const paths = (await rows<{ p: string | null }>(env, "SELECT parent_path AS p FROM stock_package WHERE id = ANY($1::int[])", [allResPkgs])).map((r) => r.p).filter((p): p is string => Boolean(p));
          const ancestorIds = new Set<number>(allResPkgs);
          for (const path of paths) for (const part of path.split("/")) if (part) ancestorIds.add(Number(part));
          pkgRoutes = (await rows<{ r: number }>(env,
            `SELECT DISTINCT rel.stock_route_id AS r FROM stock_package p
               JOIN stock_package_type_stock_route_rel rel ON rel.stock_package_type_id = p.package_type_id
              WHERE p.id = ANY($1::int[])`, [[...ancestorIds]])).map((r) => r.r);
        }
        routes = [...new Set([...routes, ...pkgRoutes])];
      }
      const rule = await pushRule(env, companies, m, dest, routes, warehouse);
      if (!rule) continue;
      const g = byRule.get(rule.id) ?? { rule, qty: 0, any: false };
      for (const id of ids) g.qty += lines.find((l) => l.id === id)!.quantity;
      g.any = true;
      byRule.set(rule.id, g);
    }
    if (!lines.length) {
      const rule = await pushRule(env, companies, m, m.location_dest_id, routes, warehouse);
      if (rule && !byRule.has(rule.id)) byRule.set(rule.id, { rule, qty: 0, any: false });
    }
    for (const { rule, qty, any } of byRule.values()) {
      if (rule.auto === "transparent") throw new NotPorted("stock.move._push_apply of a transparent rule");
      const [vals] = await copyData(env, "stock.move", [m.id], await pushValues(env, rule, m));
      vals!["product_uom_qty"] = any ? qty : m.product_uom_qty;
      valsList.push(vals!);
    }
  }
  if (!valsList.length) return [];
  const created = await create(env, "stock.move", valsList);
  // :1320 the moves that bypass reservation are make-to-stock
  const bypass = (await rows<{ id: number }>(env,
    `SELECT m.id FROM stock_move m JOIN stock_location l ON l.id = m.location_id JOIN product_product p ON p.id = m.product_id JOIN product_template t ON t.id = p.product_tmpl_id
      WHERE m.id = ANY($1::int[]) AND (l.usage IN ('supplier', 'customer', 'inventory', 'production') OR NOT COALESCE(t.is_storable, false))
      ORDER BY m.id`, [created])).map((r) => r.id);
  if (bypass.length) await write(env, "stock.move", bypass, { procure_method: "make_to_stock" });
  return actionConfirm(env, created);
}

/** stock_move.py:2400-2420: the destination moves of the done moves, assigned per company. */
export async function assignDestMoves(env0: Environment, doneIds: readonly number[]): Promise<void> {
  const env = env0.sudo();
  const perCompany = new Map<number, number[]>();
  for (const m of await moveRows(env, doneIds)) {
    const dests = await rows<{ id: number; location_id: number; company_id: number }>(env,
      "SELECT d.id, d.location_id, d.company_id FROM stock_move_move_rel r JOIN stock_move d ON d.id = r.move_dest_id WHERE r.move_orig_id = $1 ORDER BY d.id", [m.id]);
    for (const d of dests) {
      if (!(await childOf(env, d.location_id, m.location_dest_id)) && !(await childOf(env, m.location_dest_id, d.location_id))) {
        throw new NotPorted("stock.move._break_mto_link of a destination move starting elsewhere");
      }
      const list = perCompany.get(d.company_id) ?? [];
      if (!list.includes(d.id)) list.push(d.id);
      perCompany.set(d.company_id, list);
    }
  }
  for (const [company, ids] of perCompany) await actionAssign(await withCompany(env, company), ids);
}

/** stock_move.py:2721-2727 `_apply_allocation`: refuses when it would move destination moves. */
export async function assertNoAllocation(env: Environment, doneIds: readonly number[]): Promise<void> {
  const hit = await rows(env,
    `SELECT 1 FROM stock_move m JOIN stock_picking_type t ON t.id = m.picking_type_id JOIN stock_location d ON d.id = m.location_dest_id JOIN stock_location a ON a.id = t.allocated_location_id
      WHERE m.id = ANY($1::int[]) AND d.parent_path LIKE a.parent_path || '%' AND EXISTS (SELECT 1 FROM stock_move_move_rel r WHERE r.move_orig_id = m.id) LIMIT 1`, [[...doneIds]]);
  if (hit.length) throw new NotPorted("stock.move._apply_allocation of the operation type's allocated location");
}

registerOverrides("stock.move", {
  // stock_move.py:2458-2461 `_unlink_if_draft_or_cancel`
  beforeUnlink: async (env, ids) => {
    const linked = await rows(env, `SELECT 1 FROM stock_move m WHERE m.id = ANY($1::int[]) AND m.state NOT IN ('draft', 'cancel')
        AND EXISTS (SELECT 1 FROM stock_move_move_rel r WHERE r.move_orig_id = m.id OR r.move_dest_id = m.id) LIMIT 1`, [[...ids]]);
    if (linked.length) throw new UserError(translate(env, "You can not delete moves linked to another operation", "stock"));
  },
  // stock_move.py:2463-2469 unlink: the moves' lines first (their unlink gives the reservation back), then super()
  // (with :2458-2461 `_unlink_if_draft_or_cancel`), then the orderpoints of the products in the moves' warehouses
  unlink: async (env, ids, next) => {
    const lines = (await rows<{ id: number }>(env, "SELECT id FROM stock_move_line WHERE move_id = ANY($1::int[]) ORDER BY id", [[...ids]])).map((r) => r.id);
    if (lines.length) await unlink(env, "stock.move.line", lines);
    const points = await orderpointsToUpdate(env, ids);
    await next(env, ids);
    await recomputeOrderpoints(env, points);
  },
});
