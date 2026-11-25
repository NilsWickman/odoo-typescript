/**
 * stock.move `forecast_availability` and `forecast_expected_date` (stock/models/stock_move.py:530-607
 * `_compute_forecast_information`, compute_sudo), with `_get_forecast_availability_outgoing` (:2818-2839) over
 * stock.forecasted_product_product `_get_report_lines(read=False)` (stock/report/stock_forecasted.py:239-483). Only what
 * the outgoing forecast reads of each report line is built (move_out, move_in, quantity, replenishment_filled).
 * Chained moves (stock_move_move_rel, multi-step routes) and moves in another unit than the product's refuse.
 */
import { NotPorted } from "../errors";
import { floatRound } from "../orm/convert";
import { parseDomain } from "../orm/domain";
import type { Environment } from "../orm/types";
import { defineComputes } from "./tail_util";
import { datetimeToString, dbNow } from "./util";

const digitsCache = new WeakMap<object, number>();
/** decimal.precision 'Product Unit' (uom_uom.py:108-129 round/compare/is_zero). */
async function productUnitDigits(env: Environment): Promise<number> {
  const hit = digitsCache.get(env.cr);
  if (hit !== undefined) return hit;
  const d = (await env.cr.query<{ digits: number }>("SELECT digits FROM decimal_precision WHERE name = 'Product Unit'")).rows[0]?.digits ?? 2;
  digitsCache.set(env.cr, d);
  return d;
}

interface MoveRow {
  id: number; product_id: number; product_qty: number; quantity: number; uom_id: number; product_uom: number; state: string;
  location_id: number; location_dest_id: number; date: string; storable: boolean; picking_code: string | null;
  from_wh: number | null; to_wh: number | null;
}

async function moveRows(env: Environment, ids: readonly number[]): Promise<MoveRow[]> {
  const rows = (await env.cr.query<{ id: number; product_id: number; product_qty: string | number | null; quantity: string | number | null;
    uom_id: number; product_uom: number; state: string; location_id: number; location_dest_id: number; date: string; storable: boolean | null;
    picking_code: string | null; from_wh: number | null; to_wh: number | null }>(
    `SELECT m.id, m.product_id, m.product_qty, m.quantity, m.uom_id, t.uom_id AS product_uom, m.state, m.location_id, m.location_dest_id,
            to_char(m.date, 'YYYY-MM-DD HH24:MI:SS') AS date, t.is_storable AS storable, pt.code AS picking_code,
            ls.warehouse_id AS from_wh, ld.warehouse_id AS to_wh
       FROM stock_move m JOIN product_product p ON p.id = m.product_id JOIN product_template t ON t.id = p.product_tmpl_id
       LEFT JOIN stock_picking_type pt ON pt.id = m.picking_type_id
       JOIN stock_location ls ON ls.id = m.location_id JOIN stock_location ld ON ld.id = m.location_dest_id
      WHERE m.id = ANY($1::int[])`, [ids])).rows;
  return rows.map((r) => ({ ...r, product_qty: Number(r.product_qty ?? 0), quantity: Number(r.quantity ?? 0), storable: r.storable === true }));
}

/** `move.uom_id._compute_quantity(move.quantity, move.product_id.uom_id)`: only the same unit is ported. */
function reservedQty(m: MoveRow): number {
  if (m.uom_id !== m.product_uom) throw new NotPorted("stock forecast of a move in another unit than the product's");
  return m.quantity;
}

export interface Line {
  out: number | null; moveIn: MoveRow | null; quantity: number; filled: boolean;
  /** the product (`product or move_out.product_id or move_in.product_id`), the reserved move, `in_transit` */
  product: number; reserved: number | null; inTransit: boolean;
}

/** stock_forecasted.py:239-483 `_get_report_lines` for `products` (the active variants of the templates). */
export async function reportLines(env: Environment, products: readonly number[], whLocations: readonly number[], stockLocation: number): Promise<Line[]> {
  const digits = await productUnitDigits(env);
  const round = (v: number): number => floatRound(v, digits);
  const isZero = (v: number): boolean => round(v) === 0;
  const moves = env.model("stock.move");
  const base = [["product_id", "in", [...products]], ["product_uom_qty", "!=", 0]];
  const states = ["waiting", "confirmed", "partially_available", "assigned"];
  const outDomain = [...base, "&", ["location_id", "in", [...whLocations]], "|", ["location_dest_id", "not in", [...whLocations]],
    "&", ["forecasted_location_id", "!=", false], ["forecasted_location_id", "not in", [...whLocations]], ["state", "in", states]];
  const inDomain = [...base, "&", ["location_id", "not in", [...whLocations]], ["location_dest_id", "in", [...whLocations]], ["state", "in", states]];
  const today = (await dbNow(env)).toISOString().slice(0, 10); // date.today(): the server's (UTC) date
  const pastOuts = await moves.search(parseDomain([...outDomain, ["reservation_date", "<=", today]]), { order: "priority desc, date, id" });
  const futureOuts = await moves.search(parseDomain([...outDomain, "|", ["reservation_date", ">", today], ["reservation_date", "=", false]]), { order: "reservation_date, priority desc, date, id" });
  const outIds = [...new Set([...pastOuts, ...futureOuts])];
  const inIds = await moves.search(parseDomain(inDomain), { order: "priority desc, date, id" });
  if (outIds.length || inIds.length) {
    const chained = (await env.cr.query("SELECT 1 FROM stock_move_move_rel WHERE move_orig_id = ANY($1::int[]) OR move_dest_id = ANY($1::int[]) LIMIT 1", [[...outIds, ...inIds]])).rows.length;
    if (chained) throw new NotPorted("stock forecast of chained moves (_rollup_moves)");
  }
  const byId = new Map((await moveRows(env, [...outIds, ...inIds])).map((m) => [m.id, m]));
  const outs = outIds.map((id) => byId.get(id)!);
  const outsPerProduct = new Map<number, MoveRow[]>();
  for (const o of outs) outsPerProduct.set(o.product_id, [...(outsPerProduct.get(o.product_id) ?? []), o]);
  const inQty = new Map<number, number>();
  const insPerProduct = new Map<number, number[]>();
  for (const id of inIds) {
    const m = byId.get(id)!;
    inQty.set(id, m.product_qty);
    insPerProduct.set(m.product_id, [...(insPerProduct.get(m.product_id) ?? []), id]);
  }
  const allProducts = [...new Set([...outs.map((o) => o.product_id), ...products])];
  const quants = allProducts.length ? await env.model("stock.quant").search(parseDomain([["location_id", "in", [...whLocations]], ["quantity", ">", 0], ["product_id", "in", allProducts]])) : [];
  const stockChildren = new Set(await env.model("stock.location").search(parseDomain([["id", "child_of", stockLocation]])));
  stockChildren.delete(stockLocation);
  const key = (p: number, l: number): string => `${p},${l}`;
  const currents = new Map<string, number>();
  const add = (p: number, l: number, q: number): void => { currents.set(key(p, l), (currents.get(key(p, l)) ?? 0) + q); };
  if (quants.length) {
    const rows = (await env.cr.query<{ product_id: number; location_id: number; q: string | number }>(
      "SELECT product_id, location_id, SUM(quantity) AS q FROM stock_quant WHERE id = ANY($1::int[]) GROUP BY product_id, location_id", [quants])).rows;
    for (const r of rows) {
      if (stockChildren.has(r.location_id)) add(r.product_id, stockLocation, Number(r.q));
      add(r.product_id, r.location_id, Number(r.q));
    }
  }
  const take = (m: MoveRow, q: number): void => {
    if (stockChildren.has(m.location_id)) add(m.product_id, stockLocation, -q);
    add(m.product_id, m.location_id, -q);
  };
  const data = new Map<number, { reserved: number; taken: number; reservedMove: number | null }>();
  for (const list of outsPerProduct.values()) {
    const used = new Map<number, number>();
    // `_get_out_move_reserved_data`: each out is its only linked move (no chain)
    for (const out of list) {
      let reservedOut = 0;
      let reservedMove: number | null = null;
      if (out.state === "partially_available" || out.state === "assigned") {
        const reserved = Math.min(reservedQty(out) - (used.get(out.id) ?? 0), out.product_qty);
        if (reserved && reservedMove === null) reservedMove = out.id;
        reservedOut += reserved;
        used.set(out.id, (used.get(out.id) ?? 0) + reserved);
        take(out, reserved);
      }
      data.set(out.id, { reserved: reservedOut, taken: 0, reservedMove });
    }
    // `_get_out_move_taken_from_stock_data`, after the reserved quantities of all outs
    for (const out of list) {
      const d = data.get(out.id)!;
      if (["draft", "cancel", "assigned", "done"].includes(out.state)) continue;
      const demand = Math.min(Math.max(out.product_qty - reservedQty(out), 0), out.product_qty - d.reserved);
      if (isZero(demand)) continue;
      const available = currents.get(key(out.product_id, out.location_id)) ?? 0;
      const taken = Math.min(demand, available, available);
      if (taken > 0) {
        take(out, taken);
        d.taken += taken;
      }
    }
  }
  const productSum = new Map<number, number>();
  for (const [k, q] of currents) {
    const [p, l] = k.split(",").map(Number) as [number, number];
    if (!stockChildren.has(l)) productSum.set(p, (productSum.get(p) ?? 0) + q);
  }
  const lines: Line[] = [];
  const push = (out: MoveRow | null, moveIn: MoveRow | null, quantity: number, filled = true, o: { product?: number; reserved?: number | null; inTransit?: boolean } = {}): void => {
    const product = o.product ?? out?.product_id ?? moveIn!.product_id;
    lines.push({ out: out?.id ?? null, moveIn, quantity: round(quantity), filled, product, reserved: o.reserved ?? null, inTransit: o.inTransit ?? false });
  };
  const reconcile = (out: MoveRow, product: number, demandIn: number): number => {
    let demand = demandIn;
    const ins = insPerProduct.get(product) ?? [];
    const remove: number[] = [];
    for (const id of ins) {
      const left = inQty.get(id)!;
      if (isZero(left)) { remove.push(id); continue; }
      const fromIn = Math.min(demand, left);
      demand -= fromIn;
      push(out, byId.get(id)!, fromIn);
      inQty.set(id, left - fromIn);
      if (left - fromIn <= 0) remove.push(id);
      if (isZero(demand)) break;
    }
    insPerProduct.set(product, ins.filter((id) => !remove.includes(id)));
    return demand;
  };
  for (const product of new Set([...inIds.map((id) => byId.get(id)!.product_id), ...outs.map((o) => o.product_id), ...products])) {
    const initCount = lines.length;
    const unreconciled: [number, MoveRow][] = [];
    const freeStock = currents.get(key(product, stockLocation)) ?? 0;
    let transit = (productSum.get(product) ?? 0) - freeStock;
    for (const out of outsPerProduct.get(product) ?? []) {
      const d = data.get(out.id)!;
      let demand = out.product_qty;
      if (d.reserved > 0) {
        demand = Math.max(demand - d.reserved, 0);
        push(out, null, d.reserved, true, { reserved: d.reservedMove, inTransit: false });
      }
      if (isZero(demand)) continue;
      if (d.taken > 0) {
        demand = Math.max(demand - d.taken, 0);
        push(out, null, d.taken);
      }
      if (isZero(demand)) continue;
      const unreservable = Math.min(demand, transit);
      if (unreservable > 0) {
        demand -= unreservable;
        transit -= unreservable;
        push(out, null, unreservable, true, { inTransit: true });
      }
      if (isZero(demand)) continue;
      // the ins linked to this out: none without chains; then the second pass over the product's ins
      unreconciled.push([demand, out]);
    }
    for (const [demandIn, out] of unreconciled) {
      const demand = reconcile(out, product, demandIn);
      if (!isZero(demand)) push(out, null, demand, false);
    }
    // stock in transit, the unused remaining stock (`_free_stock_lines`), the ins not used
    if (!isZero(transit)) push(null, null, transit, true, { product, inTransit: true });
    if (!isZero(freeStock) || initCount === lines.length) push(null, null, freeStock, true, { product });
    for (const id of insPerProduct.get(product) ?? []) {
      const left = inQty.get(id)!;
      if (isZero(left)) continue;
      push(null, byId.get(id)!, left);
    }
  }
  return lines;
}

/** stock_move.py:2818-2839 `_get_forecast_availability_outgoing` over the report lines. */
async function outgoingForecast(env: Environment, warehouse: number, location: number, products: readonly number[]): Promise<Map<number, [number, string | false]>> {
  const view = (await env.cr.query<{ v: number }>("SELECT view_location_id AS v FROM stock_warehouse WHERE id = $1", [warehouse])).rows[0]?.v;
  if (view === undefined) throw new NotPorted(`stock forecast of warehouse ${warehouse}`);
  const whLocations = await env.model("stock.location").search(parseDomain([["id", "child_of", view]]));
  const result = new Map<number, [number, string | false]>();
  for (const line of await reportLines(env, products, whLocations, location)) {
    if (line.out === null || !line.quantity) continue;
    const [q, d] = result.get(line.out) ?? [0, false];
    const qty = line.filled ? line.quantity + q : -line.quantity;
    let date: string | false = false;
    if (line.moveIn) date = d && d > line.moveIn.date ? d : line.moveIn.date;
    result.set(line.out, [qty, date]);
  }
  return result;
}

export interface MoveForecast { availability: number; expected: string | false }

/** stock_move.py:530-607 `_compute_forecast_information` of `ids`. */
export async function moveForecast(env0: Environment, ids: readonly number[]): Promise<Map<number, MoveForecast>> {
  const env = env0.sudo();
  const out = new Map<number, MoveForecast>(ids.map((id) => [id, { availability: 0, expected: false }]));
  if (!ids.length) return out;
  const digits = await productUnitDigits(env);
  const compare = (a: number, b: number): number => { const x = floatRound(a, digits), y = floatRound(b, digits); return x < y ? -1 : x > y ? 1 : 0; };
  const rows = await moveRows(env, ids);
  const product = rows.filter((m) => m.storable);
  for (const m of rows) if (!m.storable) out.get(m.id)!.availability = m.product_qty;
  const now = datetimeToString(await dbNow(env));
  const consuming = (m: MoveRow): boolean => ["internal", "outgoing"].includes(String(m.picking_code)) || (m.from_wh !== null && m.to_wh !== null && m.from_wh !== m.to_wh);
  const keyOf = (m: MoveRow, incoming = false): string => `${incoming ? m.to_wh ?? "" : m.from_wh ?? ""}|${m.date > now ? m.date : now}`;
  const prefetch = new Map<string, Set<number>>();
  for (const m of product) {
    if ((consuming(m) && m.state === "draft") || m.picking_code === "internal") prefetch.set(keyOf(m), (prefetch.get(keyOf(m)) ?? new Set()).add(m.product_id));
    else if (m.picking_code === "incoming") prefetch.set(keyOf(m, true), (prefetch.get(keyOf(m, true)) ?? new Set()).add(m.product_id));
  }
  const available = new Map<string, Map<number, [number, number]>>();
  for (const [k, products] of prefetch) {
    const sep = k.indexOf("|");
    const wh = k.slice(0, sep);
    const qenv = env.withContext({ ...env.context, warehouse_id: wh ? Number(wh) : false, to_date: k.slice(sep + 1) });
    const read = await qenv.model("product.product").read([...products], ["virtual_available", "free_qty"], "");
    const num = (v: unknown): number => (typeof v === "number" ? v : v && typeof v === "object" && "float" in v ? Number((v as { float: number }).float) : 0);
    available.set(k, new Map(read.map((r) => [Number(r["id"]), [num(r["virtual_available"]), num(r["free_qty"])]])));
  }
  const unreserved = new Map<string, MoveRow[]>();
  for (const m of product) {
    const f = out.get(m.id)!;
    const free = available.get(keyOf(m))?.get(m.product_id)?.[1] ?? 0;
    if (m.state === "assigned") { f.availability = reservedQty(m); continue; }
    if (m.state === "draft" && compare(free, m.product_qty) >= 0) { f.availability = free; continue; }
    if (consuming(m)) {
      if (m.state === "draft") {
        const virtual = available.get(keyOf(m))!.get(m.product_id)![0];
        f.availability = compare(virtual, m.product_qty) >= 0 ? virtual : virtual - m.product_qty;
      } else if (["waiting", "confirmed", "partially_available"].includes(m.state) && m.from_wh !== null) {
        const k = `${m.from_wh}|${m.location_id}`;
        unreserved.set(k, [...(unreserved.get(k) ?? []), m]);
      }
    } else if (m.picking_code === "internal") {
      if (compare(free, m.product_qty) >= 0) f.availability = free;
    } else if (m.picking_code === "incoming") {
      const virtual = available.get(keyOf(m, true))!.get(m.product_id)![0];
      f.availability = m.state === "draft" ? virtual + m.product_qty : virtual;
    }
  }
  for (const [k, moves] of unreserved) {
    const [wh, location] = k.split("|").map(Number) as [number, number];
    const info = await outgoingForecast(env, wh, location, [...new Set(moves.map((m) => m.product_id))]);
    for (const m of moves) {
      const [q, d] = info.get(m.id) ?? [0, false];
      out.set(m.id, { availability: q, expected: d });
    }
  }
  return out;
}

defineComputes("stock.move", {
  forecast_availability: async (env, rec) => (rec.id === null ? 0 : (await moveForecast(env, [rec.id])).get(rec.id)?.availability ?? 0),
  forecast_expected_date: async (env, rec) => {
    if (rec.id === null) return null;
    return (await moveForecast(env, [rec.id])).get(rec.id)?.expected || null;
  },
});
