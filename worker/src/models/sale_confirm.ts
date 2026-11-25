/**
 * sale.order.action_confirm (sale_order.py:1619-1660) with the sale_stock chain for single-step deliveries:
 * `_action_launch_stock_rule` (sale_stock sale_order_line.py:377-425), `stock.rule.run`/`_run_pull` (stock_rule.py),
 * then the move engine (src/models/stock_engine.ts: `_action_confirm`, `_assign_picking`, reservation,
 * `_trigger_scheduler`). The cancel side follows stock_move.py `_action_cancel` and sale_stock sale_order.py
 * `_action_cancel`. Make-to-order and buy procurements (an orderpoint with something to order), chained moves and
 * service generation refuse with NotPorted.
 */
import { timesheetServiceGeneration } from "./sale_service";
import { NotPorted, UserError } from "../errors";
import { hasGroup } from "../orm/env";
import { DbRec, RecomputeQueue, recordCompute } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { write } from "../orm/write";
import { trackPrepare } from "../mail/tracking";
import { closeTrackingScope } from "../mail/write_hooks";
import { addPrecommit, withPrecommit } from "./precommit";
import { insertRow, updateRow } from "./account_entries";
import { create } from "../orm/create";
import { actionConfirm, doUnreserve, pickingActionConfirm } from "./stock_engine";
import { refreshInvoiced } from "./sale_invoice";
import { withCompany } from "./tail_util";
import { datetimeToString, dbNow, translate } from "./util";
import { floatRound } from "../orm/convert";

const asc = (rows: { id: number }[]): number[] => rows.map((r) => r.id);

export interface OrderRow {
  id: number; name: string; company_id: number; warehouse_id: number; partner_shipping_id: number; locked: boolean | null; project_id: number | null;
  picking_policy: string; commitment_date: string | null; date_order: string; security_lead: number;
}
interface LineRow { id: number; product_id: number; qty: number; uom: number; sequence: number; lead: number; type: string; tracking: string | null; service: boolean; product_uom: number; template: number; categ: number; storable: boolean }
export interface RuleRow { id: number; action: string; procure_method: string; location_src_id: number; picking_type_id: number; warehouse_id: number | null; delay: number | null; propagate_cancel: boolean | null; company_id: number | null; location_dest_from_rule: boolean | null; partner_address_id: number | null; route_id: number }

/** stock_rule.py:546-630 `_get_rule` without routes on the line: the product's routes, its category's, then the warehouse's. */
async function ruleFor(env: Environment, line: LineRow, location: number, warehouse: number, company: number): Promise<RuleRow> {
  const hit = await findRule(env, line, location, warehouse, company);
  if (hit) return hit;
  throw new UserError(await noRuleMessage(env, line, location));
}

/** stock_rule.py:458-459 the error of a procurement without rule, with the product's and location's display names. */
async function noRuleMessage(env: Environment, line: LineRow, location: number): Promise<string> {
  const product = (await env.sudo().model("product.product").displayName([line.product_id])).get(line.product_id) ?? "";
  const loc = (await env.sudo().model("stock.location").displayName([location])).get(location) ?? "";
  return translate(env, 'No rule has been found to replenish "%(product)s" in "%(location)s".\nVerify the routes configuration on the product.')
    .replace("%(product)s", product).replace("%(location)s", loc);
}

/** `_get_rule` as above, or null when no rule applies (a location without warehouse only takes rules without one). */
export async function findRule(env: Environment, line: { template: number; categ: number }, location: number, warehouse: number | null, company: number): Promise<RuleRow | null> {
  const chain = (await env.cr.query<{ id: number }>(
    `WITH RECURSIVE up(id, parent, depth) AS (SELECT id, location_id, 0 FROM stock_location WHERE id = $1
       UNION ALL SELECT l.id, l.location_id, up.depth + 1 FROM stock_location l JOIN up ON l.id = up.parent) SELECT id FROM up ORDER BY depth`, [location])).rows.map((r) => r.id);
  const own = asc((await env.cr.query<{ id: number }>(
    `SELECT r.id FROM stock_route r JOIN stock_route_product rp ON rp.route_id = r.id WHERE rp.product_id = $1 AND r.active ORDER BY r.sequence, r.id`, [line.template])).rows);
  const categ = asc((await env.cr.query<{ id: number }>(
    `WITH RECURSIVE c(id, parent) AS (SELECT id, parent_id FROM product_category WHERE id = $1 UNION ALL SELECT p.id, p.parent_id FROM product_category p JOIN c ON p.id = c.parent)
     SELECT r.id FROM stock_route r JOIN stock_route_categ rc ON rc.route_id = r.id JOIN c ON c.id = rc.categ_id WHERE r.active ORDER BY r.sequence, r.id`, [line.categ])).rows);
  const house = asc((await env.cr.query<{ id: number }>(
    `SELECT r.id FROM stock_route r JOIN stock_route_warehouse rw ON rw.route_id = r.id WHERE rw.warehouse_id = $1 AND r.active ORDER BY r.sequence, r.id`, [warehouse])).rows);
  const rules = (await env.cr.query<RuleRow & { location_dest_id: number; route_sequence: number | null; sequence: number | null }>(
    `SELECT r.id, r.action, r.procure_method, r.location_src_id, r.picking_type_id, r.warehouse_id, r.delay, r.propagate_cancel, r.company_id, r.location_dest_from_rule,
            r.partner_address_id, r.route_id, r.location_dest_id, r.route_sequence, r.sequence
       FROM stock_rule r WHERE r.active AND r.action != 'push' AND r.location_dest_id = ANY($1::int[]) AND (r.warehouse_id = $2 OR r.warehouse_id IS NULL)
        AND (r.company_id IS NULL OR r.company_id = $3)
      ORDER BY r.route_sequence, r.sequence, r.id`, [chain, warehouse, company])).rows;
  for (const loc of chain) {
    for (const routes of [[...new Set([...own, ...categ])], house]) {
      for (const route of routes) {
        const candidates = rules.filter((r) => r.location_dest_id === loc && r.route_id === route);
        const hit = candidates.find((r) => r.warehouse_id === warehouse) ?? candidates.find((r) => r.warehouse_id === null);
        if (hit) return hit;
      }
    }
  }
  return null;
}

/** The stock.reference of the order, created with the first procurement (sale_order_line.py:362-366). */
async function orderReference(env: Environment, order: OrderRow): Promise<number> {
  const found = (await env.cr.query<{ reference_id: number }>("SELECT reference_id FROM stock_reference_sale_rel WHERE sale_id = $1 ORDER BY reference_id LIMIT 1", [order.id])).rows[0];
  if (found) return found.reference_id;
  const id = await insertRow(env, "stock_reference", { name: order.name });
  await env.cr.query("INSERT INTO stock_reference_sale_rel (reference_id, sale_id) VALUES ($1, $2)", [id, order.id]);
  return id;
}

/**
 * sale_stock sale_order_line.py:377-425 `_action_launch_stock_rule`: one procurement per line (:271-304
 * `_prepare_procurement_values`, :368-375), `stock.rule.run` (stock_rule.py:426-480) through `_run_pull` (:262-290,
 * `_get_stock_move_values` :298-363 with sale_stock's custom fields), the moves confirmed by the engine
 * (src/models/stock_engine.ts: pickings, reservation), then the transfers' `action_confirm` (scheduler).
 */
/**
 * sale_stock sale_order_line.py:306-366 `_get_qty_procurement` with `_get_outgoing_incoming_moves(strict=False)`: what
 * the line's moves created through the rule that started the chain already bring to the customer (done moves by their
 * quantity, the others by their demand). Returns and refunds (incoming moves) refuse.
 */
async function qtyProcurement(env: Environment, line: LineRow): Promise<number> {
  const moves = (await env.cr.query<{ id: number; state: string; product_id: number; rule_id: number | null; warehouse_id: number | null; dest_usage: string | null;
    out_usage: string | null; src_usage: string | null; out_loc: number; origin_returned_move_id: number | null; to_refund: boolean | null; product_uom_qty: number; quantity: number; uom_id: number }>(
    `SELECT m.id, m.state, m.product_id, m.rule_id, m.warehouse_id, d.usage AS dest_usage, COALESCE(f.usage, d.usage) AS out_usage, COALESCE(m.forecasted_location_id, m.location_dest_id) AS out_loc, s.usage AS src_usage,
            m.origin_returned_move_id, m.to_refund, m.product_uom_qty::float8 AS product_uom_qty, COALESCE(m.quantity, 0)::float8 AS quantity, m.uom_id
       FROM stock_move m JOIN stock_location d ON d.id = m.location_dest_id JOIN stock_location s ON s.id = m.location_id LEFT JOIN stock_location f ON f.id = m.forecasted_location_id
      WHERE m.sale_line_id = $1 ORDER BY m.id`, [line.id])).rows.filter((m) => m.dest_usage !== "inventory" && m.product_id === line.product_id);
  if (!moves.length) return 0;
  const rules: number[] = [];
  const seen = new Set<number | null>();
  for (const m of moves) if (!seen.has(m.warehouse_id) && m.rule_id) { rules.push(m.rule_id); seen.add(m.warehouse_id); }
  let qty = 0;
  for (const m of moves) {
    if (m.state === "cancel") continue;
    if (m.origin_returned_move_id) throw new NotPorted("sale.order.line._get_qty_procurement with returned moves");
    const triggering = m.rule_id !== null && rules.includes(m.rule_id);
    // stock_location.py:464-470 `_is_outgoing`: a customer location, or under the inter-company transit location
    const outgoing = m.out_usage === "customer";
    if (!outgoing && triggering) {
      const inter = (await env.cr.query(
        `SELECT 1 FROM stock_location l, ir_model_data d WHERE l.id = $1 AND d.module = 'stock' AND d.name = 'stock_location_inter_company' AND d.model = 'stock.location'
            AND ('/' || l.parent_path) LIKE ('%/' || d.res_id || '/%') LIMIT 1`, [m.out_loc])).rows.length;
      if (inter) throw new NotPorted("sale.order.line._get_qty_procurement of an inter-company move");
    }
    if (triggering && outgoing) {
      if (m.uom_id !== line.uom) throw new NotPorted("sale.order.line._get_qty_procurement of moves in another unit");
      qty += m.state === "done" ? m.quantity : m.product_uom_qty;
    } else if (m.to_refund && (m.src_usage === "customer" || (triggering && m.out_usage === "internal"))) {
      throw new NotPorted("sale.order.line._get_qty_procurement with incoming moves (returns)");
    }
  }
  return qty;
}

export async function launchStockRule(env: Environment, order: OrderRow, only: readonly number[] | null = null): Promise<void> {
  const lines = (await env.cr.query<LineRow>(
    `SELECT l.id, l.product_id, l.product_uom_qty::float8 AS qty, l.product_uom_id AS uom, l.sequence, COALESCE(l.customer_lead, 0)::float8 AS lead, t.type, t.tracking,
            COALESCE(t.service_tracking, 'no') <> 'no' AS service, t.uom_id AS product_uom, t.id AS template, t.categ_id AS categ, COALESCE(t.is_storable, false) AS storable
       FROM sale_order_line l JOIN product_product p ON p.id = l.product_id JOIN product_template t ON t.id = p.product_tmpl_id
      WHERE l.order_id = $1 AND l.display_type IS NULL ORDER BY l.sequence, l.id`, [order.id])).rows.filter((l) => only === null || only.includes(l.id));
  const consu = lines.filter((l) => l.type === "consu");
  if (!consu.length) return;
  if (order.locked) return;
  if (order.picking_policy !== "direct") throw new NotPorted("sale.order.action_confirm with the 'one' shipping policy");
  // sale_project_stock stock_move.py:72-77 `_prepare_procurement_values` carries the order's project: read by
  // project_purchase_stock's purchase rule (not reached: only make_to_stock pull rules are ported below); the
  // transfer gets it in stock_engine.ts (`_get_new_picking_values`, `_assign_picking_values`)
  const destination = (await env.withContext({ ...env.context, allowed_company_ids: [order.company_id] }).model("res.partner").read([order.partner_shipping_id], ["property_stock_customer"], ""))[0]?.["property_stock_customer"];
  const location = typeof destination === "number" ? destination : Array.isArray(destination) ? Number(destination[0]) : null;
  if (!location) throw new NotPorted("sale.order.action_confirm without a customer location");
  const vals: Record<string, unknown>[] = [];
  // stock_rule.py:448-467 `run`: every procurement's rule first; the procurements without one raise together
  // (:442-445 `'\n'.join(errors)`)
  const missing: string[] = [];
  // :391-396 the quantity still to procure per line (`_get_qty_procurement`); equal quantities are skipped
  const digits = (await env.cr.query<{ d: number }>("SELECT digits AS d FROM decimal_precision WHERE name = 'Product Unit'")).rows[0]?.d ?? 2;
  const todo: { line: LineRow; qty: number }[] = [];
  for (const line of consu) {
    const procured = await qtyProcurement(env, line);
    if (floatRound(procured, digits) === floatRound(line.qty, digits)) continue;
    todo.push({ line, qty: line.qty - procured });
  }
  for (const { line, qty } of todo) {
    if (floatRound(qty, digits) !== 0 && !(await findRule(env, line, location, order.warehouse_id, order.company_id))) missing.push(await noRuleMessage(env, line, location));
  }
  if (missing.length) throw new UserError(missing.join("\n"));
  // stock_rule.py:275 `_run_pull`: the negative procurements first (sorted on `qty > 0`, stable)
  todo.sort((a, b) => Number(floatRound(a.qty, digits) > 0) - Number(floatRound(b.qty, digits) > 0));
  for (const { line, qty } of todo) {
    if (line.uom !== line.product_uom) throw new NotPorted("sale.order.action_confirm of a line in another unit (_adjust_uom_quantities)");
    if ((await env.cr.query("SELECT 1 FROM sale_order_line_stock_route_rel WHERE sale_order_line_id = $1 LIMIT 1", [line.id])).rows.length) {
      throw new NotPorted("sale.order.action_confirm of a line with routes");
    }
    if (floatRound(qty, digits) === 0) continue; // stock_rule.py:422-424 `_skip_procurement`
    const rule = await ruleFor(env, line, location, order.warehouse_id, order.company_id);
    if ((rule.action !== "pull" && rule.action !== "pull_push") || rule.procure_method !== "make_to_stock") {
      throw new NotPorted(`sale.order.action_confirm through rule ${rule.id} (${rule.action}, ${rule.procure_method})`);
    }
    // :280-287 `_prepare_procurement_values` (:2007-2013 `_expected_date`), stock_rule.py:306-307 the rule's delay
    const reference = await orderReference(env, order);
    const deadline = order.commitment_date ?? datetimeToString(new Date(Date.parse(`${order.date_order.replace(" ", "T")}Z`) + line.lead * 86400000));
    const planned = order.security_lead ? datetimeToString(new Date(Date.parse(`${deadline.replace(" ", "T")}Z`) - order.security_lead * 86400000)) : deadline;
    const shift = (d: string): string => (rule.delay ? datetimeToString(new Date(Date.parse(`${d.replace(" ", "T")}Z`) - rule.delay * 86400000)) : d);
    const [src] = (await env.cr.query<{ c: number | null }>("SELECT company_id AS c FROM stock_location WHERE id = $1", [rule.location_src_id])).rows;
    const [dst] = (await env.cr.query<{ c: number | null; d: number }>("SELECT l.company_id AS c, r.location_dest_id AS d FROM stock_rule r JOIN stock_location l ON l.id = r.location_dest_id WHERE r.id = $1", [rule.id])).rows;
    const move: Record<string, unknown> = {
      company_id: rule.company_id ?? src?.c ?? dst?.c ?? order.company_id, product_id: line.product_id, uom_id: line.product_uom, product_uom_qty: qty,
      partner_id: rule.partner_address_id ?? order.partner_shipping_id, location_id: rule.location_src_id, forecasted_location_id: location, move_dest_ids: [],
      rule_id: rule.id, reference_ids: [[6, 0, [reference]]], procure_method: rule.procure_method, origin: order.name, picking_type_id: rule.picking_type_id,
      route_ids: [[5, 0, 0]], never_product_template_attribute_value_ids: false, warehouse_id: rule.warehouse_id ?? false, date: shift(planned), date_deadline: shift(deadline),
      propagate_cancel: rule.propagate_cancel ?? false, priority: "0", orderpoint_id: false, sale_line_id: line.id, sequence: line.sequence,
    };
    if (rule.location_dest_from_rule) move["location_dest_id"] = dst!.d;
    vals.push(move);
  }
  if (vals.length) {
    const su0 = (await withCompany(env, order.company_id)).sudo();
    const su = su0.withContext({ ...su0.context, sale_stock_launching_moves: true });
    const moves = await create(su, "stock.move", vals);
    await actionConfirm(su0, moves);
  }
  // :418-424 the transfers of the order not done or cancelled: `action_confirm` (the scheduler)
  const pickings = (await env.cr.query<{ id: number }>("SELECT id FROM stock_picking WHERE sale_id = $1 AND state NOT IN ('cancel', 'done') ORDER BY id", [order.id])).rows.map((r) => r.id);
  if (pickings.length) await pickingActionConfirm(env, pickings);
}

/** The stored related `state` of the lines and what follows from it. */
export async function orderStateChanged(env: Environment, orders: readonly number[]): Promise<void> {
  await env.cr.query(
    `UPDATE sale_order_line l SET state = o.state, write_uid = $2, write_date = now() AT TIME ZONE 'UTC' FROM sale_order o
      WHERE l.order_id = o.id AND o.id = ANY($1::int[]) AND l.state IS DISTINCT FROM o.state`, [[...orders], env.uid]);
  await refreshInvoiced(env, orders);
  for (const id of orders) {
    const su = env.sudo();
    const status = await recordCompute("sale.order", "delivery_status")!(su, new DbRec(su, su.reg.model("sale.order"), id));
    const before = (await env.cr.query<{ s: string | null }>("SELECT delivery_status AS s FROM sale_order WHERE id = $1", [id])).rows[0]?.s ?? null;
    if ((status || null) !== before) await updateRow(env, "sale_order", id, { delivery_status: status || null });
  }
}

export async function orderRow(env: Environment, id: number): Promise<OrderRow> {
  const row = (await env.cr.query<OrderRow>(
    `SELECT o.id, o.name, o.company_id, o.warehouse_id, o.partner_shipping_id, o.locked, o.project_id, o.picking_policy, o.commitment_date::text AS commitment_date, o.date_order::text AS date_order,
            COALESCE(c.security_lead, 0)::float8 AS security_lead
       FROM sale_order o JOIN res_company c ON c.id = o.company_id WHERE o.id = $1`, [id])).rows[0];
  if (!row) throw new NotPorted(`sale.order ${id} missing`);
  return row;
}

/**
 * sale_stock sale_order.py:122-144 `_check_warehouse` (constraint on `warehouse_id`, `state`, `order_line`): a confirmed
 * order without warehouse and with a goods line raises, UserError when its company has a warehouse, else
 * stock_warehouse.py:164-171 `_warehouse_redirect_warning` in the order's company (UserError without the stock manager
 * group). Lines routed through another company's routes refuse (not ported).
 */
async function checkWarehouse(env: Environment, ids: readonly number[]): Promise<void> {
  const orders = (await env.cr.query<{ id: number; company_id: number }>(
    "SELECT id, company_id FROM sale_order WHERE id = ANY($1::int[]) AND state NOT IN ('draft', 'cancel') AND warehouse_id IS NULL ORDER BY id", [[...ids]])).rows;
  if (!orders.length) return;
  const withWarehouse = new Set((await env.cr.query<{ c: number }>(
    "SELECT DISTINCT company_id AS c FROM stock_warehouse WHERE active AND company_id = ANY($1::int[])", [orders.map((o) => o.company_id)])).rows.map((r) => r.c));
  const lines = (await env.cr.query<{ order_id: number; company_id: number; routes: boolean }>(
    `SELECT l.order_id, o.company_id, EXISTS (SELECT 1 FROM sale_order_line_stock_route_rel r JOIN stock_route sr ON sr.id = r.stock_route_id
              WHERE r.sale_order_line_id = l.id AND sr.company_id IS NOT NULL) AS routes
       FROM sale_order_line l JOIN sale_order o ON o.id = l.order_id JOIN product_product p ON p.id = l.product_id JOIN product_template t ON t.id = p.product_tmpl_id
      WHERE l.order_id = ANY($1::int[]) AND t.type = 'consu' ORDER BY l.order_id, l.sequence, l.id`, [orders.map((o) => o.id)])).rows;
  for (const l of lines) {
    if (l.routes) throw new NotPorted("sale_stock _check_warehouse with company routes on a line");
    if (withWarehouse.has(l.company_id)) throw new UserError(translate(env, "You must set a warehouse on your sale order to proceed.", "sale_stock"));
    const cenv = await withCompany(env, l.company_id);
    if (!(await hasGroup(cenv, "stock.group_stock_manager"))) throw new UserError(translate(cenv, "Please contact your administrator to configure your warehouse.", "stock"));
    const company = (await cenv.cr.query<{ name: string }>("SELECT name FROM res_company WHERE id = $1", [l.company_id])).rows[0]?.name ?? "";
    const action = await cenv.reg.xmlid(cenv.cr, "stock.action_warehouse_form");
    const { RedirectWarning } = await import("../errors");
    throw new RedirectWarning(translate(cenv, "Please create a warehouse for company %s.", "stock").replace("%s", company), action, translate(cenv, "Go to Warehouses", "stock"), String(action));
  }
}

/** sale_order.py:1619-1644 action_confirm. */
export async function confirmOrders(env0: Environment, ids: readonly number[]): Promise<void> {
  if (env0.context["send_email"]) throw new NotPorted("sale.order.action_confirm with send_email");
  const mandatory = (await env0.cr.query("SELECT 1 FROM account_analytic_applicability WHERE business_domain = 'sale_order' AND applicability = 'mandatory' LIMIT 1")).rows.length;
  if (mandatory) throw new NotPorted("sale.order.action_confirm with mandatory analytic plans (_validate_analytic_distribution)");
  const projects = (await env0.cr.query("SELECT 1 FROM project_project WHERE reinvoiced_sale_order_id = ANY($1::int[]) LIMIT 1", [[...ids]])).rows.length;
  if (projects) throw new NotPorted("sale.order.action_confirm of an order with projects");
  // sale_order.py:1640-1652: the orders are written first; their tracking is logged at precommit, which is the end of
  // the method or the scheduler's savepoint (stock_orderpoint.py:784), after the chatter of the pickings
  const now = datetimeToString(await dbNow(env0));
  await withPrecommit(env0.cr, async () => {
    await trackPrepare(env0, "sale.order", ids);
    await write(env0, "sale.order", ids, { state: "sale", date_order: now });
    // the write's constraints: sale_stock sale_order.py:122-144 `_check_warehouse`
    await checkWarehouse(env0, ids);
    await addPrecommit(env0.cr, () => closeTrackingScope(env0, "sale.order"));
    for (const id of ids) {
      const order = { ...(await orderRow(env0, id)), date_order: now };
      const partner = (await env0.cr.query<{ c: number | null; w: number | null }>(
        "SELECT p.company_id AS c, w.company_id AS w FROM res_partner p, stock_warehouse w WHERE p.id = $1 AND w.id = $2", [order.partner_shipping_id, order.warehouse_id])).rows[0];
      if (partner?.c && partner.c !== partner.w) throw new NotPorted("sale.order.action_confirm with a delivery address of another company");
      // sale_project sale_order.py:148-176 `_action_confirm` before sale_stock's: the service tasks and projects
      await timesheetServiceGeneration((await withCompany(env0, order.company_id)).sudo(), id);
      await launchStockRule((await withCompany(env0, order.company_id)).sudo(), { ...order, project_id: (await orderRow(env0, id)).project_id });
    }
    // sale_order.py:1644, 1651-1654: auto-lock confirmed orders when sale.group_auto_done_setting is enabled
    if (await hasGroup(env0.withUser(1), "sale.group_auto_done_setting")) {
      await write(env0, "sale.order", ids, { locked: true });
    }
  });
  await orderStateChanged(env0, ids);
}

/** sale_order.py:1791-1800 action_cancel with sale_stock's `_action_cancel` and stock_move.py `_action_cancel`. */
export async function cancelOrders(env: Environment, ids: readonly number[]): Promise<void> {
  const purchase = (await env.cr.query("SELECT 1 FROM purchase_order_line p JOIN sale_order_line l ON l.id = p.sale_line_id WHERE l.order_id = ANY($1::int[]) LIMIT 1", [[...ids]])).rows.length;
  if (purchase) throw new NotPorted("sale.order.action_cancel with purchase lines");
  const pickings = (await env.cr.query<{ id: number; state: string }>("SELECT id, state FROM stock_picking WHERE sale_id = ANY($1::int[]) AND state != 'done' ORDER BY id", [[...ids]])).rows;
  for (const picking of pickings) {
    const moves = (await env.cr.query<{ id: number; state: string; picked: boolean; lines: string }>(
      "SELECT m.id, m.state, COALESCE(m.picked, false) AS picked, (SELECT count(*)::text FROM stock_move_line l WHERE l.move_id = m.id) AS lines FROM stock_move m WHERE m.picking_id = $1", [picking.id])).rows;
    if (moves.some((m) => m.state === "done")) throw new UserError(translate(env, "You cannot cancel a stock move that has been set to 'Done'. Create a return in order to reverse the moves which took place."));
    const cancelled = moves.filter((m) => m.state !== "cancel").map((m) => m.id);
    if (moves.some((m) => m.state !== "cancel" && Number(m.lines) > 0)) {
      const pickedMoves = moves.filter((m) => m.state !== "cancel" && m.picked).map((m) => m.id);
      if (pickedMoves.length) {
        await env.sudo().cr.query("UPDATE stock_move_line SET picked = false WHERE move_id = ANY($1::int[]) AND picked", [pickedMoves]);
        await env.sudo().cr.query("UPDATE stock_move SET picked = false WHERE id = ANY($1::int[])", [pickedMoves]);
      }
      await doUnreserve(env.sudo(), cancelled);
    }
    for (const id of cancelled) await updateRow(env.sudo(), "stock_move", id, { state: "cancel", picked: false, procure_method: "make_to_stock" });
    // stock_move.py `_action_cancel` writes the state through the ORM, so the picking's stored computes on
    // `move_ids.state` follow: `_compute_date_deadline` (stock_picking.py:431-438) skips cancelled moves (before
    // round 11 a cancelled order's delivery kept its deadline)
    const queue = new RecomputeQueue(env.sudo());
    await queue.modified("stock.move", cancelled, ["state"]);
    await queue.run();
    if (picking.state !== "cancel") await write(env.sudo(), "stock.picking", [picking.id], { state: "cancel", is_locked: true });
  }
  // sale_order.py:1797-1800 `self.invoice_ids.filtered(lambda inv: inv.state == "draft")`: the invoices the user reads
  // (a salesperson's own documents leave another salesperson's invoice out), then `button_cancel` as the user
  const { orderInvoiceIds } = await import("./sale_computes");
  const linked: number[] = [];
  for (const id of ids) for (const m of await orderInvoiceIds(env, id)) if (!linked.includes(m)) linked.push(m);
  const drafts = new Set((await env.cr.query<{ id: number }>("SELECT id FROM account_move WHERE id = ANY($1::int[]) AND state = 'draft'", [linked])).rows.map((r) => r.id));
  const invoices = linked.filter((m) => drafts.has(m));
  if (invoices.length && !env.su) {
    const { filteredAccess } = await import("./tail_util");
    const writable = await filteredAccess(env, "account.move", invoices, "write");
    if (invoices.some((m) => !writable.has(m))) throw new NotPorted("sale.order.action_cancel of draft invoices the user may not write (button_cancel AccessError)");
  }
  if (invoices.length) {
    // account_move.py:7070-7082 button_cancel of draft moves
    const reconciled = (await env.cr.query("SELECT 1 FROM account_move_line l JOIN account_partial_reconcile p ON p.debit_move_id = l.id OR p.credit_move_id = l.id WHERE l.move_id = ANY($1::int[]) LIMIT 1", [invoices])).rows.length;
    if (reconciled) throw new NotPorted("sale.order.action_cancel of a reconciled invoice");
    await write(env.sudo(), "account.move", invoices, { auto_post: "no", state: "cancel" });
    await env.cr.query("UPDATE account_move_line SET parent_state = 'cancel' WHERE move_id = ANY($1::int[])", [invoices]);
  }
  await write(env, "sale.order", ids, { state: "cancel" });
  await orderStateChanged(env, ids);
}
