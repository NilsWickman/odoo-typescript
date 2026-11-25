/**
 * Approving a purchase order and its receipt (odoo/addons/purchase/models/purchase_order.py:698-702 `button_approve`,
 * purchase_stock purchase_order.py:211-215 and :392-415 `_create_picking`, purchase_stock purchase_order_line.py:233-353
 * `_prepare_stock_moves`, `_get_stock_move_price_unit`, `_prepare_stock_move_vals`, :404-417 `_create_stock_moves`).
 * Lines with destination moves (procurements), dropshipping, other currencies, price-included taxes and orders whose
 * operation type belongs to another company refuse with NotPorted.
 */
import { PreciseDatetime } from "../orm/values";
import { NotPorted, OdooError, UserError } from "../errors";
import { create } from "../orm/create";
import { trackPrepare } from "../mail/tracking";
import { closeTrackingScope } from "../mail/write_hooks";
import { floatRound } from "../orm/convert";
import type { Environment } from "../orm/types";
import { write } from "../orm/write";
import { actionAssign, actionConfirm, nowString, pickingActionConfirm, postOriginLink, uomCompare } from "./stock_engine";
import { uomQuantity } from "./sale_flow";
import { withCompany } from "./tail_util";
import { translate } from "./util";

async function rows<T extends object>(env: Environment, text: string, params: unknown[]): Promise<T[]> {
  return (await env.cr.query<T & Record<string, unknown>>(text, params)).rows;
}

interface OrderRow {
  id: number; name: string; state: string; company_id: number; partner_id: number; partner_ref: string | null; dest_address_id: number | null; picking_type_id: number;
  priority: string | null; currency_id: number; company_currency: number; date_planned: string | null; type_company: number | null; type_code: string; type_dest: number | null;
  type_warehouse: number | null; wh_stock: number | null; po_lock: string | null;
}

async function orderRow(env: Environment, id: number): Promise<OrderRow> {
  const [o] = await rows<OrderRow>(env,
    `SELECT o.id, o.name, o.state, o.company_id, o.partner_id, o.partner_ref, o.dest_address_id, o.picking_type_id, o.priority, o.currency_id, c.currency_id AS company_currency,
            o.date_planned::text AS date_planned, pt.company_id AS type_company, pt.code AS type_code, pt.default_location_dest_id AS type_dest, pt.warehouse_id AS type_warehouse,
            w.lot_stock_id AS wh_stock, c.po_lock
       FROM purchase_order o JOIN res_company c ON c.id = o.company_id JOIN stock_picking_type pt ON pt.id = o.picking_type_id
       LEFT JOIN stock_warehouse w ON w.id = pt.warehouse_id WHERE o.id = $1`, [id]);
  if (!o) throw new NotPorted(`purchase.order ${id} missing`);
  return o;
}

/** stock_location.py `_child_of`: `self.parent_path` starts with the other's. */
async function childOf(env: Environment, child: number, parent: number): Promise<boolean> {
  const [r] = await rows<{ ok: boolean }>(env,
    "SELECT (SELECT parent_path FROM stock_location WHERE id = $1) LIKE (SELECT parent_path FROM stock_location WHERE id = $2) || '%' AS ok", [child, parent]);
  return Boolean(r?.ok);
}

/** purchase_stock purchase_order_line.py:266-290 `_get_stock_move_price_unit` without price-included taxes and in the company's currency. */
async function stockMovePriceUnit(env: Environment, line: LineRow, order: OrderRow): Promise<number> {
  let price = line.price_unit * (1 - line.discount / 100);
  const taxes = await rows<{ id: number; amount_type: string; override: string | null; company_mode: string | null; void_reps: number }>(env,
    `SELECT t.id, t.amount_type, t.price_include_override AS override, c.account_price_include AS company_mode,
            (SELECT count(*)::int FROM account_tax_repartition_line r WHERE r.tax_id = t.id AND r.repartition_type = 'tax' AND r.account_id IS NULL) AS void_reps
       FROM account_tax_purchase_order_line_rel rel JOIN account_tax t ON t.id = rel.account_tax_id JOIN res_company c ON c.id = t.company_id
      WHERE rel.purchase_order_line_id = $1`, [line.id]);
  for (const t of taxes) {
    const included = t.override ? t.override === "tax_included" : t.company_mode === "tax_included";
    if (included || t.amount_type === "group" || t.void_reps) throw new NotPorted("purchase.order.line stock move price with price-included, grouped or account-less taxes (compute_all total_void)");
  }
  if (taxes.length) {
    // compute_all(...)['total_void'] / qty: the raw total excluded when every tax line has an account
    const qty = line.product_qty || 1;
    price = (price * qty) / qty;
  }
  if (line.uom_id !== line.product_uom) {
    const f = await rows<{ id: number; factor: number }>(env, "SELECT id, factor::float8 AS factor FROM uom_uom WHERE id = ANY($1::int[])", [[line.uom_id, line.product_uom]]);
    const factor = (id: number): number => f.find((r) => r.id === id)!.factor;
    price /= factor(line.uom_id);
    price *= factor(line.product_uom);
  }
  // :287-289 `order.currency_id._convert(price, company currency, line.company_id, at_date or Date.today(), round=False)`
  // (the server runs in UTC: today is the UTC date)
  if (order.currency_id !== order.company_currency) {
    const { convertAmount } = await import("./currency_convert");
    const { dbNow } = await import("./util");
    price = await convertAmount(env, price, order.currency_id, order.company_currency, order.company_id, (await dbNow(env)).toISOString().slice(0, 10), false);
  }
  const digits = (await rows<{ d: number }>(env, "SELECT digits AS d FROM decimal_precision WHERE name = 'Product Price'", []))[0]?.d ?? 2;
  return floatRound(price, digits);
}

interface LineRow {
  id: number; product_id: number; product_qty: number; uom_id: number; product_uom: number; price_unit: number; discount: number; sequence: number; type: string;
  date_planned: string | null; propagate_cancel: boolean | null; forecasted_location_id: number | null; orderpoint_id: number | null; display_type: string | null;
}

/** purchase_stock purchase_order_line.py:233-264 `_prepare_stock_moves` and :311-353 `_prepare_stock_move_vals` (no picking). */
async function prepareStockMoves(env: Environment, order: OrderRow, line: LineRow, picking: { id: number; location_id: number; location_dest_id: number } | null = null): Promise<Record<string, unknown>[]> {
  if (line.type !== "consu") return [];
  const price = await stockMovePriceUnit(env, line, order);
  // :292-302 `_get_qty_procurement` with :454-465 `_get_outgoing_incoming_moves`: the line's incoming moves (done by
  // their quantity, the others by their demand); returns to the vendor and returned moves refuse
  const existing = await rows<{ id: number; state: string; quantity: number; product_uom_qty: number; uom_id: number; product_id: number; dest_usage: string; returned: number | null; to_refund: boolean | null }>(env,
    `SELECT m.id, m.state, COALESCE(m.quantity, 0)::float8 AS quantity, m.product_uom_qty::float8 AS product_uom_qty, m.uom_id, m.product_id, d.usage AS dest_usage,
            m.origin_returned_move_id AS returned, m.to_refund
       FROM stock_move m JOIN stock_location d ON d.id = m.location_dest_id WHERE m.purchase_line_id = $1 AND m.state != 'cancel' ORDER BY m.id`, [line.id]);
  let procured = 0;
  for (const m of existing) {
    if (m.dest_usage === "inventory" || m.product_id !== line.product_id) continue;
    if (m.dest_usage === "supplier" || m.returned) throw new NotPorted("purchase.order.line._get_qty_procurement with returns");
    if (m.uom_id !== line.uom_id) throw new NotPorted("purchase.order.line._get_qty_procurement of moves in another unit");
    procured += m.state === "done" ? m.quantity : m.product_uom_qty;
  }
  const dests = await rows<{ id: number }>(env, "SELECT move_id AS id FROM stock_move_created_purchase_line_rel WHERE created_purchase_line_id = $1 LIMIT 1", [line.id]);
  if (dests.length) throw new NotPorted("purchase.order.line._prepare_stock_moves with destination moves");
  if (existing.length && (await rows(env, "SELECT 1 FROM stock_move_move_rel r JOIN stock_move m ON m.id = r.move_orig_id WHERE m.purchase_line_id = $1 LIMIT 1", [line.id])).length) {
    throw new NotPorted("purchase.order.line._prepare_stock_moves with the moves' destination moves");
  }
  if (line.orderpoint_id) throw new NotPorted("purchase.order.line._check_orderpoint_picking_type of a line from an orderpoint");
  const qtyToPush = line.product_qty - procured;
  if ((await uomCompare(env, qtyToPush, 0)) === 0) return [];
  // stock product.py:1382-1394 `_adjust_uom_quantities` without stock.propagate_uom: the product's unit
  const propagate = await rows<{ v: string }>(env, "SELECT value AS v FROM ir_config_parameter WHERE key = 'stock.propagate_uom'", []);
  if (propagate[0] && !["", "0", "false", "False"].includes(propagate[0].v)) throw new NotPorted("stock.propagate_uom");
  const qty = await uomQuantity(env, qtyToPush, line.uom_id, line.product_uom, "HALF-UP");
  // :317-322 the order's reference, created once
  const refs = await rows<{ r: number }>(env, "SELECT reference_id AS r FROM stock_reference_purchase_rel WHERE purchase_id = $1 ORDER BY reference_id", [order.id]);
  let references = refs.map((r) => r.r);
  if (!references.length) {
    const [ref] = await create(env, "stock.reference", [{ name: order.name }]);
    await write(env, "purchase.order", [order.id], { reference_ids: [[6, 0, [ref!]]] });
    references = [ref!];
  }
  const supplier = (await env.withContext({ ...env.context, allowed_company_ids: [order.company_id] }).model("res.partner").read([order.partner_id], ["property_stock_supplier", "name"], ""))[0];
  const supplierLoc = Array.isArray(supplier?.["property_stock_supplier"]) ? Number((supplier!["property_stock_supplier"] as unknown[])[0]) : typeof supplier?.["property_stock_supplier"] === "number" ? supplier["property_stock_supplier"] as number : null;
  if (!supplierLoc) throw new UserError(translate(env, "You must set a Vendor Location for partner %(partner_name)s").replace("%(partner_name)s", String(supplier?.["name"] ?? "")));
  // purchase_stock purchase_order.py:355-376 `_get_destination_location`, `_get_final_location_record`
  if (order.type_code === "dropship") throw new NotPorted("purchase.order receipt of a dropship");
  let dest = picking ? picking.location_dest_id : order.type_dest;
  let final: number | null = line.forecasted_location_id;
  if (final === null) final = order.type_dest && (!order.wh_stock || (await childOf(env, order.type_dest, order.wh_stock))) ? order.type_dest : order.wh_stock;
  if (final !== null && dest !== null && (await childOf(env, final, dest))) dest = final;
  // :326-333 the planned datetime as read (a demo order's carries microseconds, which the move keeps)
  const planned = line.date_planned ?? order.date_planned;
  const date = planned && planned.includes(".") ? new PreciseDatetime(planned) : planned;
  return [{
    product_id: line.product_id, date, date_deadline: date, location_id: picking ? picking.location_id : supplierLoc, location_dest_id: dest, forecasted_location_id: final ?? false,
    picking_id: picking ? picking.id : false,
    partner_id: order.dest_address_id ?? order.partner_id, move_dest_ids: [], state: "draft", purchase_line_id: line.id, company_id: order.company_id, price_unit: price,
    picking_type_id: order.picking_type_id, priority: order.priority, reference_ids: [[6, 0, references]],
    origin: order.partner_ref ? `${order.name} - ${order.partner_ref}` : order.name, propagate_cancel: line.propagate_cancel ?? false,
    warehouse_id: order.type_warehouse ?? false, product_uom_qty: qty, uom_id: line.product_uom, sequence: line.sequence,
  }];
}

/** purchase_stock purchase_order_line.py:188-226 `_create_or_update_picking` of a line whose quantity grew. */
export async function createOrUpdatePicking(env: Environment, lineId: number, orderId: number, previousQty: number): Promise<void> {
  const [line] = await rows<LineRow & { qty_invoiced: number; qty_received: number; partner_id: number | null }>(env,
    `SELECT l.id, l.product_id, l.product_qty::float8 AS product_qty, l.uom_id, t.uom_id AS product_uom, l.price_unit::float8 AS price_unit, COALESCE(l.discount, 0)::float8 AS discount,
            l.sequence, t.type, l.date_planned::text AS date_planned, l.propagate_cancel, l.forecasted_location_id, l.orderpoint_id, l.display_type,
            COALESCE(l.qty_invoiced, 0)::float8 AS qty_invoiced, COALESCE(l.qty_received, 0)::float8 AS qty_received, l.partner_id
       FROM purchase_order_line l LEFT JOIN product_product p ON p.id = l.product_id LEFT JOIN product_template t ON t.id = p.product_tmpl_id WHERE l.id = $1`, [lineId]);
  if (!line || !line.product_id || line.type !== "consu") return;
  // :191 `line.uom_id.compare(...)`: a line without unit (a create without order_id in its values gets no missing
  // fields, purchase_order_line.py:419) fails on the empty recordset's ensure_one
  if (!line.uom_id) throw new OdooError("builtins.ValueError", "Expected singleton: uom.uom()");
  if ((await uomCompare(env, line.product_qty, line.qty_invoiced)) < 0
    && (await rows(env, "SELECT 1 FROM account_move_line WHERE purchase_line_id = $1 LIMIT 1", [lineId])).length) {
    throw new NotPorted("purchase.order.line._create_or_update_picking below the billed quantity (the refund activity)");
  }
  // :202-203 the order's moves without purchase line of the product
  const loose = await rows(env,
    `SELECT 1 FROM stock_move m JOIN purchase_order_stock_picking_rel r ON r.stock_picking_id = m.picking_id
      WHERE r.purchase_order_id = $1 AND m.purchase_line_id IS NULL AND m.product_id = $2 LIMIT 1`, [orderId, line.product_id]);
  if (loose.length) throw new NotPorted("purchase.order.line._create_or_update_picking assigning moves without purchase line");
  if (line.product_qty - previousQty < 0) throw new NotPorted("purchase.order.line._create_or_update_picking of a decrease");
  // :206-211 the line's open transfer to an internal, transit or customer location, else the order's
  const open = (where: string, param: number): Promise<{ id: number; location_id: number; location_dest_id: number }[]> => rows(env,
    `SELECT DISTINCT p.id, p.location_id, p.location_dest_id FROM stock_picking p JOIN stock_location d ON d.id = p.location_dest_id
      WHERE ${where} AND p.state NOT IN ('done', 'cancel') AND d.usage IN ('internal', 'transit', 'customer')`, [param]);
  let pickings = await open("p.id IN (SELECT picking_id FROM stock_move WHERE purchase_line_id = $1)", lineId);
  if (!pickings.length) pickings = await open("p.id IN (SELECT stock_picking_id FROM purchase_order_stock_picking_rel WHERE purchase_order_id = $1)", orderId);
  if (pickings.length > 1) throw new NotPorted("purchase.order.line._create_or_update_picking with several open receipts (their order)");
  const picking = pickings[0] ?? null;
  if (!picking && !(line.product_qty > line.qty_received) && line.product_qty > 0) return;
  const order = await orderRow(env, orderId);
  const vals = await prepareStockMoves(env, order, line, picking);
  if (!vals.length) return;
  const created = await create(env, "stock.move", vals);
  // `move.with_context(move_picking_partner_id=line.partner_id)._action_confirm()._action_assign()`
  const cenv = env.withContext({ ...env.context, move_picking_partner_id: line.partner_id ?? false });
  const confirmed = await actionConfirm(cenv, created);
  await actionAssign(cenv, confirmed);
}

/**
 * purchase_stock purchase_order_line.py:110-134 write of a confirmed order's lines: a new price goes to the line's
 * moves that are not done or cancelled (`_get_stock_move_price_unit`); a quantity change (`_create_or_update_picking`),
 * a date change of lines with open moves (`_update_move_dates`) and the revaluation of valued moves refuse.
 */
export async function purchaseLineWriteMoves(env: Environment, ids: readonly number[], vals: Readonly<Record<string, unknown>>, next: () => Promise<void>): Promise<void> {
  const lines = await rows<LineRow & { order_id: number }>(env,
    `SELECT l.id, l.order_id, l.product_id, l.product_qty::float8 AS product_qty, l.uom_id, t.uom_id AS product_uom, l.price_unit::float8 AS price_unit, COALESCE(l.discount, 0)::float8 AS discount,
            l.sequence, t.type, l.date_planned::text AS date_planned, l.propagate_cancel, l.forecasted_location_id, l.orderpoint_id, l.display_type
       FROM purchase_order_line l JOIN purchase_order o ON o.id = l.order_id LEFT JOIN product_product p ON p.id = l.product_id LEFT JOIN product_template t ON t.id = p.product_tmpl_id
      WHERE l.id = ANY($1::int[]) AND o.state = 'purchase' AND l.display_type IS NULL ORDER BY l.id`, [[...ids]]);
  const moved = lines.length ? await rows<{ id: number; line: number; state: string; product_id: number; is_in: boolean | null; is_out: boolean | null }>(env,
    "SELECT id, purchase_line_id AS line, state, product_id, is_in, is_out FROM stock_move WHERE purchase_line_id = ANY($1::int[]) ORDER BY id", [lines.map((l) => l.id)]) : [];
  // :112-115 `_update_move_dates` (:172-186): a new date_planned of a line with open moves refuses; a new date_promised
  // sets the open incoming moves' date_deadline, which changes nothing when it is already theirs (the assignment writes
  // only the records whose value differs, fields.py `_filter_not_equal`) and refuses otherwise (`_set_date_deadline`)
  if (lines.length && (vals["date_planned"] || vals["date_promised"]) && moved.some((m) => m.state !== "done" && m.state !== "cancel")) {
    if (vals["date_planned"]) throw new NotPorted("purchase.order.line date change of a line with open moves (_update_move_dates)");
    const promised = vals["date_promised"] instanceof PreciseDatetime ? vals["date_promised"].text : String(vals["date_promised"]);
    const open = moved.filter((m) => m.state !== "done" && m.state !== "cancel").map((m) => m.id);
    const changed = await rows(env,
      `SELECT 1 FROM stock_move m LEFT JOIN stock_picking p ON p.id = m.picking_id LEFT JOIN stock_picking_type t ON t.id = p.picking_type_id
        WHERE m.id = ANY($1::int[]) AND t.code = 'incoming' AND m.date_deadline IS DISTINCT FROM $2::timestamp LIMIT 1`, [open, promised]);
    if (changed.length) throw new NotPorted("purchase.order.line promised date change of a line with open moves (_update_move_dates, _set_date_deadline)");
  }
  // :177-178 a line without open moves updates its open downstream moves (move_dest_ids) instead: refused
  if (lines.length && (vals["date_planned"] || vals["date_promised"]) && (await rows(env,
    `SELECT 1 FROM stock_move_created_purchase_line_rel r JOIN stock_move m ON m.id = r.move_id
      WHERE r.created_purchase_line_id = ANY($1::int[]) AND m.state NOT IN ('done', 'cancel')
        AND NOT EXISTS (SELECT 1 FROM stock_move o WHERE o.purchase_line_id = r.created_purchase_line_id AND o.state NOT IN ('done', 'cancel')) LIMIT 1`, [lines.map((l) => l.id)])).length) {
    throw new NotPorted("purchase.order.line date change of a line with open downstream moves (_update_move_dates, move_dest_ids)");
  }
  const previousQty = new Map(lines.map((l) => [l.id, l.product_qty]));
  if (lines.length && "product_qty" in vals) {
    const digits = (await rows<{ d: number }>(env, "SELECT digits AS d FROM decimal_precision WHERE name = 'Product Unit'", []))[0]?.d ?? 2;
    for (const l of lines) {
      if (floatRound(Number(vals["product_qty"] ?? 0), digits) < floatRound(l.product_qty, digits)) {
        throw new NotPorted("purchase.order.line quantity decrease on a confirmed order (_log_decrease_ordered_quantity, a negative move)");
      }
    }
  }
  // :131-133 `move_ids.filtered('is_valued')._set_value()`: a done move would be valued again (refused); an open one
  // without picked lines has nothing valued and keeps its zero value
  if (lines.length && ["price_unit", "uom_id"].some((k) => k in vals)) {
    const valued = moved.filter((m) => m.is_in || m.is_out);
    if (valued.some((m) => m.state === "done")) throw new NotPorted("purchase.order.line price or unit change with done moves (_set_value)");
    if (valued.length && (await rows(env, "SELECT 1 FROM stock_move m WHERE m.id = ANY($1::int[]) AND (COALESCE(m.value, 0) != 0 OR EXISTS(SELECT 1 FROM stock_move_line l WHERE l.move_id = m.id AND l.picked)) LIMIT 1", [valued.map((m) => m.id)])).length) {
      throw new NotPorted("purchase.order.line price or unit change with picked or valued open moves (_set_value)");
    }
  }
  if (lines.length && "uom_id" in vals) throw new NotPorted("purchase.order.line unit change on a confirmed order");
  await next();
  // :128-130 the lines whose quantity changed: `_create_or_update_picking` with the previous quantities
  if ("product_qty" in vals) {
    const digits = (await rows<{ d: number }>(env, "SELECT digits AS d FROM decimal_precision WHERE name = 'Product Unit'", []))[0]?.d ?? 2;
    for (const l of lines) {
      const [now] = await rows<{ q: number }>(env, "SELECT product_qty::float8 AS q FROM purchase_order_line WHERE id = $1", [l.id]);
      if (floatRound(now!.q, digits) !== floatRound(previousQty.get(l.id)!, digits)) await createOrUpdatePicking(env, l.id, l.order_id, previousQty.get(l.id)!);
    }
  }
  if ("price_unit" in vals) {
    for (const l of lines) {
      const open = moved.filter((m) => m.line === l.id && m.state !== "done" && m.state !== "cancel" && m.product_id === l.product_id).map((m) => m.id);
      if (!open.length) continue;
      const [fresh] = await rows<LineRow>(env,
        `SELECT l.id, l.product_id, l.product_qty::float8 AS product_qty, l.uom_id, t.uom_id AS product_uom, l.price_unit::float8 AS price_unit, COALESCE(l.discount, 0)::float8 AS discount,
                l.sequence, t.type, l.date_planned::text AS date_planned, l.propagate_cancel, l.forecasted_location_id, l.orderpoint_id, l.display_type
           FROM purchase_order_line l LEFT JOIN product_product p ON p.id = l.product_id LEFT JOIN product_template t ON t.id = p.product_tmpl_id WHERE l.id = $1`, [l.id]);
      await write(env, "stock.move", open, { price_unit: await stockMovePriceUnit(env, fresh!, await orderRow(env, l.order_id)) });
    }
  }
}

/** purchase_stock purchase_order.py:392-415 `_create_picking`. */
async function createPicking(env0: Environment, id: number): Promise<void> {
  const order = await orderRow(env0, id);
  if (order.state !== "purchase") return;
  if (order.type_company !== order.company_id) throw new NotPorted("purchase.order._create_picking with an operation type of another company");
  const lines = await rows<LineRow>(env0,
    `SELECT l.id, l.product_id, l.product_qty::float8 AS product_qty, l.uom_id, t.uom_id AS product_uom, l.price_unit::float8 AS price_unit, COALESCE(l.discount, 0)::float8 AS discount,
            l.sequence, t.type, l.date_planned::text AS date_planned, l.propagate_cancel, l.forecasted_location_id, l.orderpoint_id, l.display_type
       FROM purchase_order_line l LEFT JOIN product_product p ON p.id = l.product_id LEFT JOIN product_template t ON t.id = p.product_tmpl_id
      WHERE l.order_id = $1 ORDER BY l.sequence, l.id`, [id]);
  if (!lines.some((l) => l.type === "consu")) return;
  const env = await withCompany(env0, order.company_id);
  const vals: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (line.display_type) continue;
    vals.push(...await prepareStockMoves(env, order, line));
  }
  const created = vals.length ? await create(env, "stock.move", vals) : [];
  const open = (await rows<{ id: number }>(env, "SELECT id FROM stock_move WHERE id = ANY($1::int[]) AND state NOT IN ('done', 'cancel')", [created])).map((r) => r.id);
  const confirmEnv = env.sudo().withContext({ ...env.sudo().context, move_picking_partner_id: order.partner_id });
  const moves = await actionConfirm(confirmEnv, created.filter((m) => open.includes(m)));
  // sequence 5, 10, ... in the order of the moves' dates (sorted is stable)
  const dated = await rows<{ id: number; date: string }>(env, "SELECT id, date::text AS date FROM stock_move WHERE id = ANY($1::int[])", [moves]);
  const byDate = moves.map((m, i) => ({ m, i, d: dated.find((r) => r.id === m)!.date })).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.i - b.i));
  let seq = 0;
  for (const { m } of byDate) { seq += 5; await write(confirmEnv, "stock.move", [m], { sequence: seq }); }
  await actionAssign(confirmEnv, moves);
  const pickings = (await rows<{ id: number }>(env, "SELECT DISTINCT picking_id AS id FROM stock_move WHERE id = ANY($1::int[]) AND picking_id IS NOT NULL ORDER BY picking_id", [moves])).map((r) => r.id);
  const forward = await rows(env, "SELECT 1 FROM stock_move_move_rel WHERE move_orig_id = ANY($1::int[]) LIMIT 1", [moves]);
  if (forward.length) throw new NotPorted("purchase.order._create_picking with following pickings (_get_impacted_pickings)");
  await pickingActionConfirm(confirmEnv, pickings);
  await postOriginLink(env, "stock.picking", pickings, { model: "purchase.order", id });
}

/** purchase_order.py:698-702 `button_approve` with purchase_stock :211-215, for orders `_approval_allowed` already let through. */
export async function approveOrders(env: Environment, ids: readonly number[]): Promise<void> {
  for (const id of ids) {
    const lines = await rows<{ id: number; date_planned: string | null }>(env, "SELECT id, date_planned::text AS date_planned FROM purchase_order_line WHERE order_id = $1 ORDER BY sequence, id", [id]);
    // purchase_stock purchase_order_line.py:54-56 `_set_date_promised`: the datetime as read, with its microseconds
    for (const l of lines) await write(env, "purchase.order.line", [l.id], { date_promised: l.date_planned ? new PreciseDatetime(l.date_planned) : false });
  }
  // the order's tracking is logged at precommit, after the receipts and their chatter
  await trackPrepare(env, "purchase.order", ids);
  await write(env, "purchase.order", ids, { state: "purchase", date_approve: await nowString(env) });
  const lock = (await rows<{ id: number }>(env, "SELECT o.id FROM purchase_order o JOIN res_company c ON c.id = o.company_id WHERE o.id = ANY($1::int[]) AND c.po_lock = 'lock' ORDER BY o.id", [[...ids]])).map((r) => r.id);
  if (lock.length) await write(env, "purchase.order", lock, { locked: true });
  for (const id of ids) await createPicking(env, id);
  await closeTrackingScope(env, "purchase.order");
}
