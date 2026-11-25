/**
 * The "Return" button of a transfer: stock_picking.py:812-821 `action_return` and :976-995 `_create_return` with the
 * overrides of the installed modules (sale_stock stock.py:349-359, :399-409; purchase_stock stock.py:42-52;
 * stock_account stock_picking.py:34-37). A copy of the transfer with the return operation type and swapped
 * locations, the "created from" note, one draft return move per move (demand 0: the button is the return, not the
 * exchange) linked to the move it returns, then the Return/Exchange toggle. Chained moves (moves with destination or
 * origin moves, the multi-step links of :911-957) and returns to a supplier (purchase_stock's chain lookup) refuse.
 */
import { NotPorted } from "../errors";
import { registerMethod } from "../http/methods";
import type { Environment } from "../orm/types";
import { create } from "../orm/create";
import { write } from "../orm/write";
import { copy, copyData } from "../web/save";
import { envFor } from "../web/common";
import { postOriginLink } from "./stock_engine";
import { registerHooks } from "../orm/hooks";
import { iterConditions } from "../orm/domain";
import { searchRead } from "./res_lang";
import { search, searchCount } from "../web/read_methods";
import { datetimeToString, dbNow, translate } from "./util";

interface PickRow { id: number; name: string; location_id: number; location_dest_id: number; picking_type_id: number; sale_id: number | null; show_return: boolean | null; partner_id: number | null }

async function picking(env: Environment, id: number): Promise<PickRow> {
  const hasSaleId = env.reg.model("stock.picking").fields.has("sale_id");
  const row = (await env.cr.query<PickRow>(
    `SELECT id, name, location_id, location_dest_id, picking_type_id, ${hasSaleId ? "sale_id" : "NULL::int AS sale_id"}, show_return, partner_id FROM stock_picking WHERE id = $1`, [id])).rows[0];
  if (!row) throw new NotPorted(`stock.picking(${id}) does not exist`);
  return row;
}

/** stock_picking.py:976-995 `_create_return`, with sale_stock's return reason and purchase_stock's partner (after super). */
export async function createReturn(env: Environment, id: number): Promise<number> {
  const self = await picking(env, id);
  const moveFields = env.reg.model("stock.move").fields;
  const hasSaleLine = moveFields.has("sale_line_id");
  const hasPurchaseLine = moveFields.has("purchase_line_id");
  const moves = (await env.cr.query<{ id: number; state: string; quantity: number; uom_id: number; product_uom: number; location_id: number; location_dest_id: number;
    origin_returned_move_id: number | null; to_refund: boolean | null; sale_line_id: number | null; purchase_line_id: number | null; orig: number; dests: number; dest_open: number }>(
    `SELECT m.id, m.state, COALESCE(m.quantity, 0)::float8 AS quantity, m.uom_id, t.uom_id AS product_uom, m.location_id, m.location_dest_id,
            m.origin_returned_move_id, m.to_refund,
            ${hasSaleLine ? "m.sale_line_id" : "NULL::int AS sale_line_id"},
            ${hasPurchaseLine ? "m.purchase_line_id" : "NULL::int AS purchase_line_id"},
            (SELECT count(*)::int FROM stock_move_move_rel r WHERE r.move_dest_id = m.id) AS orig,
            (SELECT count(*)::int FROM stock_move_move_rel r WHERE r.move_orig_id = m.id) AS dests,
            (SELECT count(*)::int FROM stock_move_move_rel r JOIN stock_move d ON d.id = r.move_dest_id WHERE r.move_orig_id = m.id AND d.state NOT IN ('done', 'cancel')) AS dest_open
       FROM stock_move m JOIN product_product p ON p.id = m.product_id JOIN product_template t ON t.id = p.product_tmpl_id
      WHERE m.picking_id = $1 ORDER BY m.sequence, m.id`, [id])).rows;
  // :978 `self.move_ids.move_dest_ids.filtered(...)._do_unreserve()`
  if (moves.some((m) => m.dest_open > 0)) throw new NotPorted("stock.picking._create_return with open destination moves (_do_unreserve)");
  // :959-974 `_prepare_return_picking_default_values` (+ sale_stock :405-409)
  const type = (await env.cr.query<{ return_type: number | null }>("SELECT return_picking_type_id AS return_type FROM stock_picking_type WHERE id = $1", [self.picking_type_id])).rows[0];
  const returnType = type?.return_type ?? self.picking_type_id;
  const rt = (await env.cr.query<{ code: string; default_location_dest_id: number | null; warehouse_id: number | null }>(
    "SELECT code, default_location_dest_id, warehouse_id FROM stock_picking_type WHERE id = $1", [returnType])).rows[0]!;
  const locationDest = rt.code === "incoming" ? rt.default_location_dest_id : self.location_id;
  const defaults: Record<string, unknown> = {
    move_ids: [], picking_type_id: returnType, state: "draft", return_id: id,
    origin: translate(env, "Return of %(picking_name)s", "stock").replace("%(picking_name)s", self.name),
    user_id: false, location_id: self.location_dest_id, location_dest_id: locationDest ?? false,
  };
  if (self.sale_id) defaults["sale_id"] = self.sale_id;
  const [newId] = await copy(env, "stock.picking", [id], defaults);
  const created = await picking(env, newId!);
  await postOriginLink(env, "stock.picking", [newId!], { model: "stock.picking", id });
  // :911-957 `_prepare_return_move_default_values` (new_picking's), with stock_account :34-37, sale_stock :399-403, purchase_stock :42-52
  const destUsage = (await env.cr.query<{ usage: string }>("SELECT usage FROM stock_location WHERE id = $1", [created.location_dest_id])).rows[0]?.usage;
  const now = datetimeToString(await dbNow(env));
  const valsList: Record<string, unknown>[] = [];
  for (const m of moves) {
    if (m.state === "cancel") continue;
    const originMove = m.origin_returned_move_id ?? m.id;
    // :919-935 move_orig_to_link & move_dest_to_link
    const moveOrigSet = new Set<number>();
    for (const r of (await env.cr.query<{ id: number }>(
      `SELECT rm.id FROM stock_move_move_rel rel JOIN stock_move rm ON rm.origin_returned_move_id = rel.move_dest_id
        WHERE rel.move_orig_id = $1 ORDER BY rm.id`, [originMove])).rows) moveOrigSet.add(r.id);
    if (!m.origin_returned_move_id) {
      moveOrigSet.add(originMove);
      for (const r of (await env.cr.query<{ id: number }>(
        `SELECT mo.id FROM stock_move_move_rel r1 JOIN stock_move md ON md.id = r1.move_dest_id AND md.state != 'cancel'
           JOIN stock_move_move_rel r2 ON r2.move_dest_id = md.id JOIN stock_move mo ON mo.id = r2.move_orig_id AND mo.state != 'cancel'
          WHERE r1.move_orig_id = $1 ORDER BY mo.id`, [originMove])).rows) moveOrigSet.add(r.id);
    }
    const moveDestSet = new Set<number>();
    for (const r of (await env.cr.query<{ id: number }>(
      `SELECT rm.id FROM stock_move_move_rel rel JOIN stock_move rm ON rm.origin_returned_move_id = rel.move_orig_id
        WHERE rel.move_dest_id = $1 ORDER BY rm.id`, [originMove])).rows) moveDestSet.add(r.id);
    for (const r of (await env.cr.query<{ id: number }>(
      `SELECT md.id FROM stock_move_move_rel r0 JOIN stock_move rm ON rm.origin_returned_move_id = r0.move_orig_id
         JOIN stock_move_move_rel r1 ON r1.move_dest_id = rm.id JOIN stock_move mo ON mo.id = r1.move_orig_id AND mo.state != 'cancel'
         JOIN stock_move_move_rel r2 ON r2.move_orig_id = mo.id JOIN stock_move md ON md.id = r2.move_dest_id AND md.state != 'cancel'
        WHERE r0.move_dest_id = $1 ORDER BY md.id`, [originMove])).rows) moveDestSet.add(r.id);
    // `origin_move.picking_id.reference_ids`: related "move_ids.reference_ids" (first move of origin_move's picking)
    const originPick = (await env.cr.query<{ p: number | null }>("SELECT picking_id AS p FROM stock_move WHERE id = $1", [originMove])).rows[0]?.p;
    const firstOrigMove = originPick ? (await env.cr.query<{ id: number }>("SELECT id FROM stock_move WHERE picking_id = $1 ORDER BY sequence, id LIMIT 1", [originPick])).rows[0]?.id : null;
    const refs = firstOrigMove ? (await env.cr.query<{ r: number }>(
      "SELECT r.reference_id AS r FROM stock_reference_move_rel r WHERE r.move_id = $1 ORDER BY r.reference_id", [firstOrigMove])).rows.map((x) => x.r) : [];
    const vals: Record<string, unknown> = {
      product_uom_qty: created.show_return === false ? m.quantity : 0,
      uom_id: m.uom_id || m.product_uom, picking_id: newId, state: "draft", date: now,
      location_id: created.location_id || m.location_dest_id, location_dest_id: created.location_dest_id || m.location_id,
      forecasted_location_id: false, picking_type_id: created.picking_type_id, warehouse_id: rt.warehouse_id ?? false,
      origin_returned_move_id: m.id, procure_method: "make_to_stock", reference_ids: [[6, 0, refs]],
      move_orig_ids: [...moveOrigSet].map((mid) => [4, mid]),
      move_dest_ids: [...moveDestSet].map((mid) => [4, mid]),
      // stock_account stock_picking.py:34-37: the origin move's flag, also on an exchange (sweep_purchase_stock)
      to_refund: Boolean(m.to_refund),
    };
    if (rt.code === "outgoing") vals["partner_id"] = created.partner_id ?? false;
    if (hasSaleLine && m.sale_line_id) vals["sale_line_id"] = m.sale_line_id;
    if (destUsage === "supplier" && hasPurchaseLine) {
      const chain = (await env.cr.query<{ purchase_line_id: number; partner_id: number | null }>(
        `WITH RECURSIVE chain(id, depth) AS (
           SELECT $1::int, 0
           UNION ALL
           SELECT r.move_orig_id, c.depth + 1
             FROM stock_move_move_rel r JOIN chain c ON c.id = r.move_dest_id
            WHERE c.depth < 20
         )
         SELECT sm.purchase_line_id, po.partner_id
           FROM chain c
           JOIN stock_move sm ON sm.id = c.id
           LEFT JOIN purchase_order_line pol ON pol.id = sm.purchase_line_id
           LEFT JOIN purchase_order po ON po.id = pol.order_id
          WHERE sm.purchase_line_id IS NOT NULL
          ORDER BY c.depth, sm.id LIMIT 1`, [m.id])).rows[0];
      if (chain) {
        vals["purchase_line_id"] = chain.purchase_line_id;
        if (chain.partner_id) vals["partner_id"] = chain.partner_id;
      }
    }
    const product = (await env.cr.query<{ product_id: number }>("SELECT product_id FROM stock_move WHERE id = $1", [m.id])).rows[0]!.product_id;
    vals["product_id"] = product;
    valsList.push((await copyData(env, "stock.move", [m.id], vals))[0]!);
  }
  if (valsList.length) await create(env, "stock.move", valsList);
  // :992-993 toggles between showing Return and Exchange buttons
  await write(env, "stock.picking", [newId!], { show_return: !(created.show_return ?? false) });
  // purchase_stock stock.py:42-46
  const partners = [...new Set((await env.cr.query<{ p: number | null }>("SELECT partner_id AS p FROM stock_move WHERE picking_id = $1 AND partner_id IS NOT NULL", [newId])).rows.map((r) => r.p))];
  const now2 = await picking(env, newId!);
  if (partners.length === 1 && now2.partner_id !== partners[0]) await write(env, "stock.picking", [newId!], { partner_id: partners[0] });
  // sale_stock stock.py:349-359
  const reason = env.context["return_reason_id"];
  if (typeof reason === "string" && /^\d+$/.test(reason)) throw new NotPorted("stock.picking._create_return with a return reason");
  return newId!;
}

registerMethod("stock.picking", "action_return", async (env0, ids, _args, kwargs) => {
  const { env } = envFor(env0, kwargs);
  if (ids === null || ids.length !== 1) throw new NotPorted(`ensure_one on stock.picking(${(ids ?? []).join(", ")})`);
  const id = await createReturn(env, ids[0]!);
  return { name: translate(env, "Returned Picking", "stock"), type: "ir.actions.act_window", res_model: "stock.picking", res_id: id, view_mode: "form", context: env.context };
}, { apiModel: false });

// stock_quant.py:212-216 `_search`: a condition on the lot's properties becomes `lot_id any [...]`; the rest of
// search, search_count and search_read is the ORM's (gen/orm_methods.py finds no other override on stock.quant)
registerHooks("stock.quant", {
  searchOverride: async (_env, domain, next) => {
    for (const c of iterConditions(domain)) if (c.path.startsWith("lot_properties.")) throw new NotPorted("stock.quant search on lot_properties (lot_id any)");
    return next(domain);
  },
});
registerMethod("stock.quant", "search_read", async (env0, _ids, args, kwargs0, name) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  return searchRead(env, name, args, kwargs);
}, { apiModel: true, readonly: true });
registerMethod("stock.quant", "search", async (env0, _ids, args, kwargs0, name) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  return search(env, name, args, kwargs);
}, { apiModel: true, readonly: true });
registerMethod("stock.quant", "search_count", async (env0, _ids, args, kwargs0, name) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  return searchCount(env, name, args, kwargs);
}, { apiModel: true, readonly: true });
