/**
 * stock_account's costing methods average (AVCO) and FIFO (ACCEPTANCE A7, fix A3-1): the value of outgoing moves
 * (stock_move.py:345-438 `_set_value`), the product's cost after each valued move (product.py:720-760
 * `_update_standard_price` with :378-509 `_run_avco` and :511-618 `_run_fifo`), the FIFO stack (:620-718
 * `_get_fifo_value`, `_get_fifo_stack`), the moves' remaining quantity and value (stock_move.py:153-172,
 * product.py:323-343 `_get_remaining_moves`), the product's value (product.py:97-189 `_compute_value`), and the cost
 * row of a changed cost (product.py:197-245 `write`, `_change_standard_price`).
 *
 * Not ported, refused: lot valuation, consigned stock (owners other than the company), valuation over several
 * companies, valuation at a date (`to_date`), the replay of the valuation timeline (`_set_value(recompute_date)`,
 * `_correct_inventory_valuation`: an incoming move whose quantity is not all on hand, a move dated in the past).
 */
import { NotPorted } from "../errors";
import { floatRepr, floatRound, floatRoundRounding } from "../orm/convert";
import { create } from "../orm/create";
import type { Environment } from "../orm/types";
import { write } from "../orm/write";
import { isPyFloat } from "../web/common";
import { quantitiesDict } from "./stock_quantities";
import { nowString, unitDigits } from "./stock_engine";
import { defineComputes, withCompany } from "./tail_util";
import { pyFloatReprSimple, translate } from "./util";

async function rows<T extends object>(env: Environment, text: string, params: unknown[]): Promise<T[]> {
  return (await env.cr.query<T & Record<string, unknown>>(text, params)).rows;
}

export function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (isPyFloat(v)) return v.float;
  if (typeof v === "string" && v !== "") return Number(v);
  return 0;
}

export interface ValuedMove { id: number; date: string; value: number; quantity: number; is_in: boolean; is_out: boolean; qty: number }

/** A move line counts for valuation (stock_move.py:619-651 `_get_in_move_lines`/`_get_out_move_lines`): picked, not
 *  consigned (stock_move_line.py:39-47 `_should_exclude_for_valuation`), between a valued location of the line's company
 *  and one that is not (stock_location.py:30-35 `_should_be_valued`). */
const OWN = "(l.owner_id IS NULL OR l.owner_id = (SELECT partner_id FROM res_company WHERE id = l.company_id))";
const SRC_VALUED = "COALESCE(s.company_id = l.company_id, false) AND s.usage IN ('internal', 'transit')";
const DST_VALUED = "COALESCE(d.company_id = l.company_id, false) AND d.usage IN ('internal', 'transit')";

/** stock_move.py:536-550 `_get_valued_qty` (lot None, unsigned) of done moves, with their value, date and quantity. */
export async function valuedMoves(env: Environment, ids: readonly number[]): Promise<Map<number, ValuedMove>> {
  const out = new Map<number, ValuedMove>();
  if (!ids.length) return out;
  const res = await rows<{ id: number; date: string; value: number | null; quantity: number | null; state: string; is_in: boolean | null; is_out: boolean | null; is_dropship: boolean | null; qin: number; qout: number }>(env,
    `SELECT m.id, m.date::text AS date, m.value::float8 AS value, m.quantity::float8 AS quantity, m.state, m.is_in, m.is_out, m.is_dropship,
            COALESCE(sum(l.quantity_product_uom) FILTER (WHERE NOT (${SRC_VALUED}) AND ${DST_VALUED}), 0)::float8 AS qin,
            COALESCE(sum(l.quantity_product_uom) FILTER (WHERE ${SRC_VALUED} AND NOT (${DST_VALUED})), 0)::float8 AS qout
       FROM stock_move m
       LEFT JOIN stock_move_line l ON l.move_id = m.id AND COALESCE(l.picked, false) AND ${OWN}
       LEFT JOIN stock_location s ON s.id = l.location_id LEFT JOIN stock_location d ON d.id = l.location_dest_id
      WHERE m.id = ANY($1::int[]) GROUP BY m.id`, [[...ids]]);
  for (const r of res) {
    if (r.state !== "done") throw new NotPorted("stock_account _get_valued_qty of a move not done");
    if (r.is_dropship) throw new NotPorted("stock_account valuation of a dropship move");
    const qty = r.is_in ? r.qin : r.is_out ? r.qout : 0;
    out.set(r.id, { id: r.id, date: r.date, value: r.value ?? 0, quantity: r.quantity ?? 0, is_in: Boolean(r.is_in), is_out: Boolean(r.is_out), qty });
  }
  return out;
}

export interface ProductCost { costMethod: string; lotValuated: boolean; standardPrice: number; storable: boolean; company: number | null }

/** The product's costing method, lot valuation and cost in the environment's company. */
export async function productCost(env: Environment, product: number): Promise<ProductCost> {
  const [r] = await env.sudo().model("product.product").read([product], ["cost_method", "lot_valuated", "standard_price", "is_storable", "company_id"], "");
  if (!r) throw new NotPorted(`product.product ${product} without record`);
  const company = Array.isArray(r["company_id"]) ? Number(r["company_id"][0]) : typeof r["company_id"] === "number" ? r["company_id"] : null;
  return { costMethod: String(r["cost_method"] || "standard"), lotValuated: Boolean(r["lot_valuated"]), standardPrice: num(r["standard_price"]), storable: Boolean(r["is_storable"]), company };
}

/** product.py:319-321 `_with_valuation_context`: the valued locations of the environment's companies (stock_location.py
 *  :17-24 `_search_is_valued`, archived ones too), strict, owned by nobody or the company. */
export async function valuedLocations(env: Environment): Promise<number[]> {
  return (await rows<{ id: number }>(env, "SELECT id FROM stock_location WHERE company_id = ANY($1::int[]) AND usage IN ('internal', 'transit') ORDER BY id", [[...(await env.companies())]])).map((r) => r.id);
}

/** `product._with_valuation_context().with_context(to_date=...).qty_available`. Consigned stock refuses. */
export async function valuationQty(env: Environment, product: number, toDate: string | null = null): Promise<number> {
  const company = await env.company();
  const consigned = await rows(env,
    `SELECT 1 FROM stock_quant q WHERE q.product_id = $1 AND q.owner_id IS NOT NULL AND q.owner_id != (SELECT partner_id FROM res_company WHERE id = $2) LIMIT 1`, [product, company]);
  if (consigned.length) throw new NotPorted("stock valuation with consigned stock (owners)");
  const ctx: Record<string, unknown> = { ...env.context, location: await valuedLocations(env), strict: true };
  if (toDate) ctx["to_date"] = toDate;
  else delete ctx["to_date"];
  delete ctx["warehouse_id"];
  return (await quantitiesDict(env.withContext(ctx), [product])).get(product)?.qty_available ?? 0;
}

/** uom `compare` with the 'Product Unit' precision. */
async function cmp(env: Environment, a: number, b: number): Promise<number> {
  const d = await unitDigits(env);
  const x = floatRound(a, d), y = floatRound(b, d);
  return x === y ? 0 : x < y ? -1 : 1;
}

/** product.py:659-718 `_get_fifo_stack` without lot: the incoming moves (or, oversold, the outgoing ones) that make up
 *  the quantity on hand, oldest first, and the part of the oldest one still on hand (signed). */
export async function fifoStack(env: Environment, product: number, opts: { atDate?: string | null; allowNegative?: boolean; extra?: number } = {}): Promise<{ moves: ValuedMove[]; first: number }> {
  let size = await valuationQty(env, product, opts.atDate ?? null);
  size += opts.extra ?? 0;
  if ((await cmp(env, size, 0)) === 0) return { moves: [], first: 0 };
  const oversold = (await cmp(env, size, 0)) < 0;
  if (oversold && !opts.allowNegative) return { moves: [], first: 0 };
  const sign = oversold ? -1 : 1;
  let remaining = Math.abs(size);
  const ids = (await rows<{ id: number }>(env,
    `SELECT id FROM stock_move WHERE product_id = $1 AND company_id = ANY($2::int[]) AND ${oversold ? "is_out" : "is_in"} AND ($3::timestamp IS NULL OR date <= $3::timestamp)
      ORDER BY date DESC, id DESC`, [product, [...(await env.companies())], opts.atDate ?? null])).map((r) => r.id);
  const moves = await valuedMoves(env, ids);
  const stack: ValuedMove[] = [];
  let first = 0;
  for (const id of ids) {
    if ((await cmp(env, remaining, 0)) <= 0) break;
    const m = moves.get(id)!;
    stack.push(m);
    first = sign * Math.min(m.qty, remaining);
    remaining -= m.qty;
  }
  stack.reverse();
  return { moves: stack, first };
}

/** product.py:620-657 `_get_fifo_value` without lot: the value of the next `quantity` going out. */
export async function fifoValue(env: Environment, product: number, quantity: number, extra: number): Promise<number> {
  const cost = await productCost(env, product);
  if ((await cmp(env, quantity, 0)) <= 0) return quantity * cost.standardPrice;
  let fifoCost = 0;
  const { moves, first } = await fifoStack(env, product, { extra });
  let qtyOnFirst = first;
  let last: ValuedMove | null = null;
  for (const m of moves) {
    if (!(quantity > 0)) break;
    last = m;
    let inQty: number, inValue: number;
    if (qtyOnFirst) {
      inQty = qtyOnFirst;
      inValue = m.value * inQty / m.qty;
      qtyOnFirst = 0;
    } else {
      inQty = m.qty;
      inValue = m.value;
    }
    if (inQty > quantity) {
      inValue = inValue * quantity / inQty;
      inQty = quantity;
    }
    fifoCost += inValue;
    quantity -= inQty;
  }
  // more than on hand: the last known price
  if (quantity > 0) fifoCost += last && last.quantity ? quantity * (last.value / last.quantity) : quantity * cost.standardPrice;
  return fifoCost;
}

/** product.py:511-552 `_run_fifo` without date or correction: the product's value and unit cost on hand. */
export async function runFifo(env: Environment, product: number): Promise<{ std: number; value: number }> {
  const quantity = await valuationQty(env, product);
  let std = (await productCost(env, product)).standardPrice;
  if ((await cmp(env, quantity, 0)) < 0) return { std, value: quantity * std };
  const { moves, first } = await fifoStack(env, product);
  let value = 0;
  for (const [index, m] of moves.entries()) {
    value += index === 0 && first ? (m.qty ? m.value * first / m.qty : 0) : m.value;
  }
  std = quantity ? value / quantity : std;
  return { std, value };
}

/** product.py:291-310 `_get_last_product_value` without date or lot: the last cost row not of a move, in the company. */
async function lastProductValue(env: Environment, product: number): Promise<{ value: number; date: string } | null> {
  const [r] = await rows<{ value: number | null; date: string }>(env,
    `SELECT value::float8 AS value, date::text AS date FROM product_value WHERE product_id = $1 AND move_id IS NULL AND company_id = $2 AND lot_id IS NULL
      ORDER BY date DESC, id DESC LIMIT 1`, [product, await env.company()]);
  return r ? { value: r.value ?? 0, date: r.date } : null;
}

/** product.py:378-509 `_run_avco(force_recompute=True)` for one product without lot, date or correction: the average
 *  cost replayed over the valued moves since the last cost row (undefined without any). */
export async function runAvco(env: Environment, product: number): Promise<number | undefined> {
  const manual = await lastProductValue(env, product);
  let quantity: number | undefined, average: number | undefined, value: number | undefined;
  let from: string | null = null;
  if (manual) {
    // `product.with_context(to_date=manual_value.date).qty_available` (the default locations, not the valued ones)
    quantity = (await quantitiesDict(env.withContext({ ...env.context, to_date: manual.date }), [product])).get(product)?.qty_available ?? 0;
    average = manual.value;
    value = manual.value * quantity;
    from = manual.date;
  }
  const ids = (await rows<{ id: number }>(env,
    `SELECT id FROM stock_move WHERE product_id = $1 AND company_id = $2 AND (is_in OR is_out) AND ($3::timestamp IS NULL OR date > $3::timestamp)
      ORDER BY date, id`, [product, await env.company(), from])).map((r) => r.id);
  const moves = await valuedMoves(env, ids);
  for (const id of ids) {
    const m = moves.get(id)!;
    let q = quantity ?? 0;
    let avg = average ?? (m.qty ? m.value / m.qty : 0);
    let v = value ?? 0;
    if (m.is_in) {
      const previous = q;
      q += m.qty;
      if (previous > 0) {
        v += m.value;
        avg = v / q;
      } else {
        avg = m.qty ? m.value / m.qty : avg;
        v = avg * q;
      }
    }
    if (m.is_out) {
      const outValue = m.qty * avg;
      v -= outValue;
      q -= m.qty;
    }
    quantity = q; average = avg; value = v;
  }
  return average;
}

/** stock_move.py:322-342 `_get_price_unit` of one product's moves (without consumables or consigned). */
export async function priceUnit(env: Environment, moveIds: readonly number[]): Promise<number> {
  const moves = await valuedMoves(env, moveIds);
  let total = 0, qty = 0;
  for (const m of moves.values()) {
    total += m.value;
    qty += m.is_out ? -m.qty : m.qty;
  }
  return qty ? total / qty : 0;
}

/** product.py:97-189 `_compute_value` of an average or FIFO product without lot valuation, in the environment's single
 *  company, without date or warehouse: its total value and unit cost. */
export async function costedValue(env: Environment, product: number, costMethod: string, quantity: number, price: number): Promise<{ total: number; average: number }> {
  if (costMethod === "average") return { total: quantity * price, average: quantity ? quantity * price / quantity : price };
  const { value } = await runFifo(env, product);
  return { total: value, average: quantity ? value / quantity : price };
}

/** product.py:720-760 `_update_standard_price` (stock_account): the cost of average and FIFO products after their
 *  valued moves, written without a cost row (`disable_auto_revaluation`) and without tracking. */
export async function updateStandardPrice(env0: Environment, products: readonly number[]): Promise<void> {
  const env = env0.withContext({ ...env0.context, disable_auto_revaluation: true, mail_notrack: true });
  for (const product of [...new Set(products)].sort((a, b) => a - b)) {
    const cost = await productCost(env, product);
    if (cost.lotValuated && cost.costMethod !== "standard") throw new NotPorted("stock_account _update_standard_price of a lot-valuated product");
    let price: number | undefined;
    if (cost.costMethod === "standard") continue;
    if (cost.costMethod === "fifo") {
      const qty = await valuationQty(env, product);
      if ((await cmp(env, qty, 0)) > 0) {
        price = (await runFifo(env, product)).value / qty;
      } else {
        const [last] = await rows<{ id: number }>(env,
          "SELECT id FROM stock_move WHERE is_in AND product_id = $1 AND company_id = $2 ORDER BY date DESC, id DESC LIMIT 1", [product, await env.company()]);
        const unit = last ? await priceUnit(env, [last.id]) : 0;
        if (unit) price = unit;
      }
    } else if (cost.costMethod === "average") {
      price = await runAvco(env, product);
    } else {
      throw new NotPorted(`stock_account _update_standard_price with the ${cost.costMethod} cost method`);
    }
    // `product.sudo().standard_price = ...` writes (fields.py:1992-2028 __set__ calls write for stored records)
    if (price === undefined) continue;
    await write(env.sudo(), "product.product", [product], { standard_price: price });
  }
}

/** product.py:213-245 `_change_standard_price`: a cost row for each storable product (not FIFO) whose cost changed,
 *  with the quantity on hand at `date` (now when absent). */
export async function changeStandardPrice(env: Environment, old: ReadonlyMap<number, number | null>, date: string | null): Promise<void> {
  const when = date ?? await nowString(env);
  const vals: Record<string, unknown>[] = [];
  for (const [product, oldValue] of [...old.entries()].sort((a, b) => a[0] - b[0])) {
    const cost = await productCost(env, product);
    const value = cost.standardPrice;
    if (!cost.storable || cost.costMethod === "fifo" || value === oldValue) continue;
    if (cost.lotValuated) throw new NotPorted("_change_standard_price of a lot-valuated product (the lots' cost)");
    const quantity = (await quantitiesDict(env.sudo().withContext({ ...env.context, to_date: when }), [product])).get(product)?.qty_available ?? 0;
    const user = (await rows<{ name: string }>(env, "SELECT p.name FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1", [env.uid]))[0]?.name ?? "";
    // `%(old_value)s` of a float (or None), `%(new_value)s` and `%(quantity)s` of floats
    const repr = (n: number | null): string => (n === null ? "None" : pyFloatReprSimple(n));
    vals.push({
      product_id: product, quantity, old_cost: oldValue ?? false, new_cost: value, old_value: (oldValue ?? 0) * quantity, new_value: value * quantity,
      value, company_id: cost.company ?? await env.company(), date: when,
      description: translate(env, "Cost update from %(old_value)s to %(new_value)s for %(quantity)s by %(user)s", "stock_account")
        .replace("%(old_value)s", () => repr(oldValue))
        .replace("%(new_value)s", () => repr(value))
        .replace("%(quantity)s", () => repr(quantity))
        .replace("%(user)s", () => user),
    });
  }
  if (!vals.length) return;
  await create(env.sudo(), "product.value", vals);
  await revalueStacks(env.sudo(), vals.map((v) => ({ product: Number(v["product_id"]), date: String(v["date"]) })));
}

/**
 * product_value.py:107-121 `create`: a cost row without a move values again the moves of its product's FIFO stack at
 * its date, `moves._set_value(recompute_date=min(dates))` (stock_move.py:345-438). With every move of the stack
 * incoming and whole on hand that is the plain valuation (src/models/stock_validate.ts setValue); a stack with an
 * outgoing move or an incoming one partly gone out replays the valuation (`_correct_inventory_valuation`): refused.
 */
async function revalueStacks(env: Environment, costRows: readonly { product: number; date: string }[]): Promise<void> {
  const ids: number[] = [];
  const products = new Map<number, number[]>();
  for (const { product, date } of costRows) {
    for (const m of (await fifoStack(env, product, { atDate: date })).moves) {
      if (ids.includes(m.id)) continue;
      ids.push(m.id);
      products.set(product, [...(products.get(product) ?? []), m.id]);
    }
  }
  if (!ids.length) return;
  const valued = await valuedMoves(env, ids);
  for (const [product, moveIds] of products) {
    const remaining = await remainingByMove(env, product);
    for (const id of moveIds) {
      const m = valued.get(id)!;
      if (m.is_out || (await cmp(env, remaining.get(id) ?? 0, m.qty)) !== 0) {
        throw new NotPorted("product.value create replaying the valuation of its product's moves (_set_value with recompute_date)");
      }
    }
  }
  const { setValue } = await import("./stock_validate");
  await setValue(env, ids);
}

/** product.py:323-343 `_get_remaining_moves` for one product without lot: the on-hand quantity per move of its stack. */
export async function remainingByMove(env: Environment, product: number): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const { moves, first } = await fifoStack(env, product, { allowNegative: true });
  if (!moves.length) return out;
  const sign = moves[0]!.is_out ? -1 : 1;
  out.set(moves[0]!.id, (out.get(moves[0]!.id) ?? 0) + first);
  for (const m of moves.slice(1)) out.set(m.id, (out.get(m.id) ?? 0) + sign * m.qty);
  return out;
}

/** fields_numeric.py:270-288 Monetary.convert_to_cache: `currency.round`, then float(float_repr(value, decimal_places)). */
export async function roundCurrency(env: Environment, value: number, currency: number | null): Promise<number> {
  if (!value || currency === null) return value;
  const [c] = await rows<{ rounding: number; places: number | null }>(env, "SELECT rounding::float8 AS rounding, decimal_places AS places FROM res_currency WHERE id = $1", [currency]);
  if (!c) return value;
  return Number(floatRepr(floatRoundRounding(value, c.rounding), c.places ?? 0));
}

function idOf(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (Array.isArray(v) && typeof v[0] === "number") return v[0];
  return null;
}

defineComputes("stock.move", {
  // stock_move.py:76-79 `_compute_standard_price`: the product's cost in the move's company
  standard_price: async (env, rec) => {
    const product = idOf(await rec.get("product_id")), company = idOf(await rec.get("company_id"));
    if (product === null) return 0;
    return (await productCost(company === null ? env : await withCompany(env, company), product)).standardPrice;
  },
  // :153-160 `_compute_remaining_qty`: the move's part of its product's on-hand stack in the move's company
  remaining_qty: async (env, rec) => {
    const product = idOf(await rec.get("product_id")), company = idOf(await rec.get("company_id"));
    if (product === null || rec.origin === null) return 0;
    const cenv = company === null ? env : await withCompany(env, company);
    if ((await productCost(cenv, product)).lotValuated) throw new NotPorted("stock.move.remaining_qty of a lot-valuated product");
    return (await remainingByMove(cenv, product)).get(rec.origin) ?? 0;
  },
  // :162-172 `_compute_remaining_value`
  remaining_value: async (env, rec) => {
    if (!(await rec.get("is_in"))) return 0;
    const product = idOf(await rec.get("product_id")), company = idOf(await rec.get("company_id"));
    if (product === null) return 0;
    const cenv = company === null ? env : await withCompany(env, company);
    const remaining = num(await rec.get("remaining_qty"));
    if ((await productCost(cenv, product)).costMethod === "fifo") {
      const quantity = num(await rec.get("quantity"));
      const ratio = quantity ? remaining / quantity : 0;
      return roundCurrency(env, ratio ? ratio * num(await rec.get("value")) : 0, idOf(await rec.get("company_currency_id")));
    }
    return roundCurrency(env, remaining * num(await rec.get("standard_price")), idOf(await rec.get("company_currency_id")));
  },
});
