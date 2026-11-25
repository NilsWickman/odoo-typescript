/**
 * Stock quantities of products (odoo/addons/stock/models/product.py): product.product `_compute_quantities` /
 * `_compute_quantities_dict` (:140-273) with the location context of `_get_domain_locations` (:349-402) and
 * `_get_domain_locations_new` (:404-466), product.template's sum over its variants (product/models/
 * product_template.py:487-505), and purchase.order.line `forecasted_issue` (purchase_stock purchase_order_line.py:
 * 89-99). Context keys the port does not handle (lot/owner/package, dates, owners, expiration, location names) refuse.
 */
import { checkModelAccess } from "../orm/access";
import { NotPorted } from "../errors";
import { and, cond, not, or } from "../orm/domain";
import { DbRec, type Rec, registerRecordCompute } from "../orm/recompute";
import type { Domain, Environment } from "../orm/types";
import { floatRound } from "../orm/convert";
import { hasGroup } from "../orm/env";
import { defineComputes } from "./tail_util";
import { registerHooks } from "../orm/hooks";
import { datetimeToString, dbNow } from "./util";
import { contextToday } from "./account_computes";

type Quantities = { qty_available: number; free_qty: number; incoming_qty: number; outgoing_qty: number; virtual_available: number };
const ZERO: Quantities = { qty_available: 0, free_qty: 0, incoming_qty: 0, outgoing_qty: 0, virtual_available: 0 };

function idList(v: unknown, what: string): number[] {
  const list = Array.isArray(v) ? v : [v];
  if (!list.every((x): x is number => typeof x === "number" && Number.isInteger(x))) throw new NotPorted(`stock quantities with a ${what} given by name`);
  return list;
}

/** product.py:349-402 `_get_domain_locations`: the location ids of the context (ids only). */
async function contextLocations(env: Environment): Promise<number[]> {
  const ctx = env.context;
  const location = ctx["location"] || ctx["search_location"];
  const warehouse = ctx["warehouse_id"] || ctx["search_warehouse"];
  const viewLocations = async (ids: number[]): Promise<number[]> => ids.length === 0 ? [] : (await env.cr.query<{ v: number | null }>(
    "SELECT view_location_id AS v FROM stock_warehouse WHERE id = ANY($1::int[]) ORDER BY id", [ids])).rows.map((r) => r.v).filter((v): v is number => v !== null);
  if (warehouse) {
    const wIds = [...new Set(await viewLocations(idList(warehouse, "warehouse")))];
    if (!location) return wIds;
    const lIds = idList(location, "location");
    const parents = (await env.cr.query<{ p: string }>("SELECT parent_path AS p FROM stock_location WHERE id = ANY($1::int[])", [wIds])).rows.map((r) => r.p);
    const locs = (await env.cr.query<{ id: number; p: string }>("SELECT id, parent_path AS p FROM stock_location WHERE id = ANY($1::int[])", [lIds])).rows;
    return locs.filter((l) => parents.some((p) => l.p.startsWith(p))).map((l) => l.id);
  }
  if (location) return idList(location, "location");
  const warehouses = await env.model("stock.warehouse").search(cond("company_id", "in", [...await env.companies()]));
  return [...new Set(await viewLocations(warehouses))];
}

/** product.py:404-466 `_get_domain_locations_new`: (quant, move in, move out) domains. */
async function locationDomains(env: Environment, locationIds: number[]): Promise<{ quant: Domain; moveIn: Domain; moveOut: Domain; moveInDone: Domain; moveOutDone: Domain } | null> {
  if (locationIds.length === 0) return null;
  let loc: Domain, dest: Domain, destOut: Domain, destDone: Domain;
  if (env.context["strict"]) {
    loc = cond("location_id", "in", locationIds);
    dest = cond("location_dest_id", "in", locationIds);
    destOut = cond("location_dest_id", "not in", locationIds);
    destDone = dest;
  } else {
    const descendants = (await env.cr.query<{ id: number }>(
      `WITH RECURSIVE descendants AS (SELECT id FROM stock_location WHERE id = ANY($1::int[])
         UNION SELECT sl.id FROM stock_location sl JOIN descendants d ON sl.location_id = d.id) SELECT id FROM descendants`, [locationIds])).rows.map((r) => r.id);
    loc = cond("location_id", "in", descendants);
    destDone = cond("location_dest_id", "in", descendants);
    const inProgress = or([
      and([cond("forecasted_location_id", "!=", false), cond("forecasted_location_id", "in", descendants)]),
      and([cond("forecasted_location_id", "=", false), cond("location_dest_id", "in", descendants)]),
    ]);
    dest = or([and([cond("state", "=", "done"), destDone]), and([cond("state", "!=", "done"), inProgress])]);
    destOut = or([and([cond("state", "=", "done"), not(destDone)]), and([cond("state", "!=", "done"), not(inProgress)])]);
  }
  return { quant: loc, moveIn: and([dest, not(loc)]), moveOut: and([loc, destOut]), moveInDone: and([destDone, not(loc)]), moveOutDone: and([loc, not(destDone)]) };
}

/** product.py:156-273 `_compute_quantities_dict` for the context without lots, an owner, packages or from_date. */
export async function quantitiesDict(env: Environment, productIds: readonly number[]): Promise<Map<number, Quantities>> {
  for (const key of ["lot_id", "owner_id", "package_id", "from_date", "with_expiration"]) {
    if (env.context[key] !== undefined && env.context[key] !== null) throw new NotPorted(`stock quantities with context ${key}`);
  }
  // product.py:180-189 and :199-206 `'owners' in self.env.context` (stock_account product.py:319-321
  // `_with_valuation_context`: [False, the company's partner]): the quants, moves (through their lines) and done move
  // lines of those owners, or of none when the list is empty or None
  let owners: { quant: Domain; move: Domain; line: Domain } | null = null;
  if ("owners" in env.context) {
    const o = env.context["owners"];
    if (o !== null && o !== false && o !== undefined && !Array.isArray(o)) throw new NotPorted(`stock quantities with context owners of type ${typeof o}`);
    const list = Array.isArray(o) ? o : [];
    if (!list.every((x) => x === false || (typeof x === "number" && Number.isInteger(x)))) throw new NotPorted("stock quantities with owners given by name");
    owners = list.length
      ? { quant: cond("owner_id", "in", list), move: cond("move_line_ids.owner_id", "in", list), line: cond("owner_id", "in", list) }
      : { quant: cond("owner_id", "=", false), move: cond("move_line_ids.owner_id", "=", false), line: cond("owner_id", "=", false) };
  }
  const withOwners = (d: Domain, which: "quant" | "move" | "line"): Domain => owners ? and([d, owners[which]]) : d;
  const out = new Map<number, Quantities>(productIds.map((id) => [id, { ...ZERO }]));
  if (productIds.length === 0) return out;
  const domains = await locationDomains(env, await contextLocations(env));
  // product.py:221 `Move._read_group(...)` runs whatever the locations: its `_search` checks the user's read access on
  // stock.move first (models.py:4884), compute_sudo=False on these fields
  if (!env.su) await checkModelAccess(env, env.reg.model("stock.move"), "read");
  if (domains === null) return out;
  const products = cond("product_id", "in", [...productIds]);
  let todo = cond("state", "in", ["waiting", "confirmed", "assigned", "partially_available"]);
  let pastFrom: string | null = null;
  const toDate = env.context["to_date"];
  if (toDate !== undefined && toDate !== null && toDate !== false) {
    // product.py:162-170: a date alone means the end of that day; a date in the past recomputes from done moves
    if (typeof toDate !== "string") throw new NotPorted("stock quantities with a non-string to_date");
    const limit = toDate.length === 10 ? `${toDate} 23:59:59.999999` : toDate;
    if (limit < datetimeToString(await dbNow(env))) pastFrom = limit.slice(0, 19);
    todo = and([todo, cond("date", "<=", limit.slice(0, 19))]);
  }
  const moveEnv = env.withContext({ ...env.context, active_test: false });
  const sums = async (model: string, table: string, domain: Domain, columns: string[]): Promise<Map<number, number[]>> => {
    const ids = await moveEnv.model(model).search(domain, { activeTest: false });
    const res = new Map<number, number[]>();
    if (ids.length === 0) return res;
    const rows = (await env.cr.query<Record<string, number | null>>(
      `SELECT product_id, ${columns.map((c, i) => `sum(${c})::float8 AS c${i}`).join(", ")} FROM ${table} WHERE id = ANY($1::int[]) GROUP BY product_id`, [ids])).rows;
    for (const r of rows) res.set(Number(r["product_id"]), columns.map((_c, i) => Number(r[`c${i}`] ?? 0)));
    return res;
  };
  const movesIn = await sums("stock.move", "stock_move", withOwners(and([todo, products, domains.moveIn]), "move"), ["product_qty"]);
  const movesOut = await sums("stock.move", "stock_move", withOwners(and([todo, products, domains.moveOut]), "move"), ["product_qty"]);
  const quants = await sums("stock.quant", "stock_quant", withOwners(and([products, domains.quant]), "quant"), ["quantity", "reserved_quantity"]);
  // :231-240 back in time from the done move lines after the date
  let inPast = new Map<number, number[]>(), outPast = new Map<number, number[]>();
  if (pastFrom !== null) {
    const done = and([cond("state", "=", "done"), cond("date", ">", pastFrom), products]);
    inPast = await sums("stock.move.line", "stock_move_line", withOwners(and([done, domains.moveInDone]), "line"), ["quantity_product_uom"]);
    outPast = await sums("stock.move.line", "stock_move_line", withOwners(and([done, domains.moveOutDone]), "line"), ["quantity_product_uom"]);
  }
  // uom.uom.round (uom_uom.py:108-112): the 'Product Unit' precision, HALF-UP
  const digits = (await env.cr.query<{ digits: number }>("SELECT digits FROM decimal_precision WHERE name = 'Product Unit'")).rows[0]?.digits ?? 2;
  const round = (v: number): number => floatRound(v, digits);
  for (const id of productIds) {
    if (!quants.has(id) && !movesIn.has(id) && !movesOut.has(id) && !inPast.has(id) && !outPast.has(id)) continue;
    const [qty, reserved] = quants.get(id) ?? [0, 0];
    const available = pastFrom === null ? qty! : qty! - (inPast.get(id)?.[0] ?? 0) + (outPast.get(id)?.[0] ?? 0);
    const incoming = round(movesIn.get(id)?.[0] ?? 0), outgoing = round(movesOut.get(id)?.[0] ?? 0);
    out.set(id, {
      qty_available: round(available), free_qty: round(available - reserved!), incoming_qty: incoming, outgoing_qty: outgoing,
      virtual_available: round(available + incoming - outgoing),
    });
  }
  return out;
}

/** product.py:140-154 `_compute_quantities`: services have 0. */
async function productQuantities(env: Environment, rec: Rec): Promise<Quantities> {
  if (rec.id === null) return { ...ZERO };
  if ((await rec.get("type")) === "service") return { ...ZERO };
  return (await quantitiesDict(env, [rec.id])).get(rec.id) ?? { ...ZERO };
}

/** product_template.py:487-505: the sum over the template's active variants. */
async function templateQuantities(env: Environment, rec: Rec): Promise<Quantities> {
  const total = { ...ZERO };
  for (const variant of await rec.rels("product_variant_ids")) {
    const q = await productQuantities(env, variant);
    for (const k of Object.keys(total) as (keyof Quantities)[]) total[k] += q[k];
  }
  return total;
}

/**
 * product.py:140-154 `_compute_quantities` over the recordset: services 0, the others from one
 * `_compute_quantities_dict` for all of them (productQuantities does one record).
 */
async function productsQuantities(env: Environment, ids: readonly number[]): Promise<Map<number, Quantities>> {
  const def = env.reg.model("product.product");
  const goods: number[] = [];
  for (const id of ids) if ((await new DbRec(env, def, id).get("type")) !== "service") goods.push(id);
  const dict = goods.length ? await quantitiesDict(env, goods) : new Map<number, Quantities>();
  return new Map(ids.map((id) => [id, goods.includes(id) ? dict.get(id) ?? { ...ZERO } : { ...ZERO }]));
}

/** product_template.py:487-505 over the recordset: each template's sum over its active variants, in their order. */
async function templatesQuantities(env: Environment, ids: readonly number[]): Promise<Map<number, Quantities>> {
  const def = env.reg.model("product.template");
  const variants = new Map<number, number[]>();
  for (const id of ids) {
    const vs: number[] = [];
    for (const v of await new DbRec(env, def, id).rels("product_variant_ids")) if (v.id !== null) vs.push(v.id);
    variants.set(id, vs);
  }
  const quantities = await productsQuantities(env, [...new Set([...variants.values()].flat())]);
  const out = new Map<number, Quantities>();
  for (const id of ids) {
    const total = { ...ZERO };
    for (const v of variants.get(id) ?? []) {
      const q = quantities.get(v) ?? ZERO;
      for (const k of Object.keys(total) as (keyof Quantities)[]) total[k] += q[k];
    }
    out.set(id, total);
  }
  return out;
}

for (const field of ["qty_available", "free_qty", "incoming_qty", "outgoing_qty", "virtual_available"] as const) {
  // the record computes (new records, onchange) one record at a time, as defineComputes registers them
  registerRecordCompute("product.product", { [field]: async (env, rec) => (await productQuantities(env, rec))[field] });
  registerRecordCompute("product.template", { [field]: async (env, rec) => (await templateQuantities(env, rec))[field] });
  // a read of the field for many records computes them together, as Odoo's compute over the recordset (a list of
  // products was 3 searches and 3 sums per product and field)
  registerHooks("product.product", { computed: { [field]: async (env, ids) => new Map([...await productsQuantities(env, ids)].map(([id, q]) => [id, q[field]])) } });
  registerHooks("product.template", { computed: { [field]: async (env, ids) => new Map([...await templatesQuantities(env, ids)].map(([id, q]) => [id, q[field]])) } });
}

defineComputes("purchase.order.line", {
  // purchase_stock purchase_order_line.py:89-99 _compute_forecasted_issue: the forecast at the order's warehouse up to
  // the planned date (to_date) is not ported; lines without product have none
  forecasted_issue: async (env, line) => {
    const product = await line.rel("product_id");
    if (!product || product.origin === null) return false;
    const order = await line.rel("order_id");
    const pickingType = order ? await order.get("picking_type_id") : null;
    const warehouse = typeof pickingType === "number" && pickingType
      ? (await env.cr.query<{ w: number | null }>("SELECT warehouse_id AS w FROM stock_picking_type WHERE id = $1", [pickingType])).rows[0]?.w ?? null : null;
    const planned = await line.get("date_planned");
    const fenv = env.sudo().withContext({ ...env.context, warehouse_id: warehouse ?? false, to_date: typeof planned === "string" ? planned : false });
    let virtual = (await env.cr.query<{ t: string | null }>("SELECT pt.type AS t FROM product_product p JOIN product_template pt ON pt.id = p.product_tmpl_id WHERE p.id = $1", [product.origin])).rows[0]?.t === "service"
      ? 0 : ((await quantitiesDict(fenv, [product.origin])).get(product.origin)?.virtual_available ?? 0);
    if ((await line.get("state")) === "draft") virtual += Number((await line.get("product_uom_qty")) ?? 0);
    return virtual < 0;
  },
});

/**
 * product.py:298-316 (variants) and :954-976 (templates) _compute_nbr_moves: done move lines of the last year
 * entering (from outside a warehouse into one) or leaving a warehouse, searched as the user.
 */
async function nbrMoves(env: Environment, productDomain: Domain, direction: "in" | "out"): Promise<number> {
  const now = await dbNow(env);
  const yearAgo = new Date(now.getTime());
  yearAgo.setUTCFullYear(yearAgo.getUTCFullYear() - 1); // relativedelta(years=1)
  const from = direction === "in" ? cond("location_id.warehouse_id", "=", false) : cond("location_id.warehouse_id", "!=", false);
  const to = direction === "in" ? cond("location_dest_id.warehouse_id", "!=", false) : cond("location_dest_id.warehouse_id", "=", false);
  return env.model("stock.move.line").searchCount(and([productDomain, cond("state", "=", "done"), from, to,
    cond("date", ">=", `${datetimeToString(yearAgo)}`)]));
}
defineComputes("product.product", {
  nbr_moves_in: async (env, rec) => (rec.id === null ? 0 : nbrMoves(env, cond("product_id", "in", [rec.id]), "in")),
  nbr_moves_out: async (env, rec) => (rec.id === null ? 0 : nbrMoves(env, cond("product_id", "in", [rec.id]), "out")),
  // product.py:121-125 _compute_show_qty_status_button: the template's
  show_on_hand_qty_status_button: async (_env, rec) => {
    const t = await rec.rel("product_tmpl_id");
    return t ? Boolean(await t.get("is_storable")) : false;
  },
  show_forecasted_qty_status_button: async (_env, rec) => {
    const t = await rec.rel("product_tmpl_id");
    return t ? Boolean((await t.get("is_storable")) && (await t.get("product_variant_id"))) : false;
  },
});
defineComputes("product.template", {
  nbr_moves_in: async (env, rec) => (rec.id === null ? 0 : nbrMoves(env, cond("product_id.product_tmpl_id", "in", [rec.id]), "in")),
  nbr_moves_out: async (env, rec) => (rec.id === null ? 0 : nbrMoves(env, cond("product_id.product_tmpl_id", "in", [rec.id]), "out")),
  // product.py:925-929 _compute_show_qty_status_button
  show_on_hand_qty_status_button: async (_env, rec) => Boolean(await rec.get("is_storable")),
  show_forecasted_qty_status_button: async (_env, rec) => Boolean((await rec.get("is_storable")) && (await rec.get("product_variant_id"))),
});

/** product_template.py:415-445 `_compute_template_field_from_variant_field(fname)` (default False, not multi_variant). */
async function fromSingleVariant(env: Environment, rec: Rec, fname: string, activeTest = true): Promise<unknown> {
  const tenv = activeTest ? env : env.withContext({ ...env.context, active_test: false });
  // a new template without origin has no variants (default False); one with an origin has the origin's
  const tmplId = rec.id ?? rec.origin;
  if (tmplId === null) return false;
  const variants = await tenv.model("product.product").search(cond("product_tmpl_id", "=", tmplId), { activeTest });
  if (variants.length === 1) {
    return new DbRec(env, env.reg.model("product.product"), variants[0]!).get(fname);
  }
  if (variants.length === 0 && activeTest && env.context["active_test"] !== false) return fromSingleVariant(env, rec, fname, false);
  return false;
}
defineComputes("product.template", {
  // product_template.py:464-468 _compute_standard_price
  standard_price: async (env, rec) => {
    const v = await fromSingleVariant(env, rec, "standard_price");
    return v === false || v === null ? 0 : v;
  },
});

/** stock product.py:533-544 / :1018-1035 _compute_nbr_reordering_rules: orderpoints (as the user, active ones). */
async function orderpoints(env: Environment, domain: Domain): Promise<{ count: number; min: number; max: number; products: number }> {
  const ids = await env.model("stock.warehouse.orderpoint").search(domain);
  if (ids.length === 0) return { count: 0, min: 0, max: 0, products: 0 };
  const rows = (await env.cr.query<{ p: number; n: string; mn: number | null; mx: number | null }>(
    `SELECT product_id AS p, count(*)::text AS n, sum(product_min_qty)::float8 AS mn, sum(product_max_qty)::float8 AS mx
       FROM stock_warehouse_orderpoint WHERE id = ANY($1::int[]) GROUP BY product_id`, [ids])).rows;
  return { count: rows.reduce((s, r) => s + Number(r.n), 0), min: rows[0]?.mn ?? 0, max: rows[0]?.mx ?? 0, products: rows.length };
}
defineComputes("product.product", {
  nbr_reordering_rules: async (env, rec) => (rec.id === null ? 0 : (await orderpoints(env, cond("product_id", "in", [rec.id]))).count),
  reordering_min_qty: async (env, rec) => (rec.id === null ? 0 : (await orderpoints(env, cond("product_id", "in", [rec.id]))).min),
  reordering_max_qty: async (env, rec) => (rec.id === null ? 0 : (await orderpoints(env, cond("product_id", "in", [rec.id]))).max),
});
/** The template keeps the last product group's sums (assignment, not addition): one product only is ported. */
async function templateOrderpoints(env: Environment, rec: Rec): Promise<{ count: number; min: number; max: number }> {
  if (rec.id === null) return { count: 0, min: 0, max: 0 };
  const r = await orderpoints(env, cond("product_id.product_tmpl_id", "in", [rec.id]));
  if (r.products > 1) throw new NotPorted("product.template reordering quantities over several variants (read_group order)");
  return r;
}
defineComputes("product.template", {
  nbr_reordering_rules: async (env, rec) => (await templateOrderpoints(env, rec)).count,
  reordering_min_qty: async (env, rec) => (await templateOrderpoints(env, rec)).min,
  reordering_max_qty: async (env, rec) => (await templateOrderpoints(env, rec)).max,
});

/** uom.uom.round with the 'Product Unit' precision, HALF-UP (as quantitiesDict). */
async function roundProductUnit(env: Environment, v: number): Promise<number> {
  const digits = (await env.cr.query<{ digits: number }>("SELECT digits FROM decimal_precision WHERE name = 'Product Unit'")).rows[0]?.digits ?? 2;
  return floatRound(v, digits);
}

/** relativedelta(years=1) subtracted from a 'YYYY-MM-DD' date (Feb 29 becomes Feb 28). */
function yearBefore(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const day = m === 2 && d === 29 ? 28 : d;
  return `${String(y - 1).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * purchase product.py:84-97 product.product._compute_purchased_product_qty: product_uom_qty of the lines of
 * confirmed purchase orders approved in the last year (from context_today), as the user; new records have 0.
 */
async function purchasedQty(env: Environment, productId: number | null): Promise<number> {
  if (productId === null) return 0;
  const dateFrom = `${yearBefore(await contextToday(env))} 00:00:00`;
  const ids = await env.model("purchase.order.line").search(and([
    cond("order_id.state", "=", "purchase"), cond("product_id", "in", [productId]), cond("order_id.date_approve", ">=", dateFrom),
  ]));
  if (ids.length === 0) return 0;
  const row = (await env.cr.query<{ s: number | null }>(
    "SELECT sum(product_uom_qty)::float8 AS s FROM purchase_order_line WHERE id = ANY($1::int[])", [ids])).rows[0];
  return roundProductUnit(env, Number(row?.s ?? 0));
}
defineComputes("product.product", {
  purchased_product_qty: async (env, rec) => purchasedQty(env, rec.id),
});
defineComputes("product.template", {
  // purchase product.py:30-33: the sum over the variants (active_test=False), rounded
  purchased_product_qty: async (env, rec) => {
    if (rec.id === null) return 0;
    const variants = await env.withContext({ ...env.context, active_test: false }).model("product.product")
      .search(cond("product_tmpl_id", "=", rec.id), { activeTest: false });
    let total = 0;
    for (const v of variants) total += await purchasedQty(env, v);
    return roundProductUnit(env, total);
  },
});

/**
 * sale product_product.py:19-42 product.product._compute_sales_count: product_uom_qty of sale.report rows in the
 * done states (sale_report.py:19-20; pos_sale's extension is refused) dated within 365 days of today (UTC), for
 * salesmen only; new records have 0.
 */
async function salesCount(env: Environment, productId: number | null): Promise<number> {
  if (productId === null) return 0;
  if (!(await hasGroup(env, "sales_team.group_sale_salesman"))) return 0;
  if ((env.reg.model("sale.report").modules ?? []).includes("pos_sale")) throw new NotPorted("product.product.sales_count with pos_sale done states");
  const today = new Date((await dbNow(env)).getTime() - 365 * 86400000);
  const dateFrom = `${datetimeToString(today).slice(0, 10)} 00:00:00`;
  const ids = await env.model("sale.report").search(and([
    cond("state", "in", ["sale"]), cond("product_id", "in", [productId]), cond("date", ">=", dateFrom),
  ]));
  if (ids.length === 0) return 0;
  let total = 0;
  const def = env.reg.model("sale.report");
  for (const id of ids) total += Number((await new DbRec(env, def, id).get("product_uom_qty")) ?? 0);
  return roundProductUnit(env, total);
}
defineComputes("product.product", {
  sales_count: async (env, rec) => salesCount(env, rec.id),
});
defineComputes("product.template", {
  // sale product_template.py:121-128: the sum over the variants (active_test=False), rounded
  sales_count: async (env, rec) => {
    if (rec.id === null) return 0;
    const variants = await env.withContext({ ...env.context, active_test: false }).model("product.product")
      .search(cond("product_tmpl_id", "=", rec.id), { activeTest: false });
    let total = 0;
    for (const v of variants) total += await salesCount(env, v);
    return roundProductUnit(env, total);
  },
});

/** stock product.py:1196-1206 product.template._should_open_product_quants (mrp's is_kits extension refused). */
async function shouldOpenProductQuants(env: Environment, tmpl: Rec): Promise<boolean> {
  if ((env.reg.model("product.template").modules ?? []).includes("mrp")) throw new NotPorted("_should_open_product_quants with mrp (is_kits)");
  for (const g of ["stock.group_stock_multi_locations", "stock.group_tracking_owner", "stock.group_tracking_lot"]) {
    if (await hasGroup(env, g)) return true;
  }
  return Boolean(await tmpl.get("tracking"));
}
defineComputes("product.template", {
  // stock product.py:935-941 _compute_show_qty_update_button
  show_qty_update_button: async (env, rec) =>
    (await shouldOpenProductQuants(env, rec)) || Number(await rec.get("product_variant_count")) > 1,
});
defineComputes("product.product", {
  // stock product.py:127-130 _compute_show_qty_update_button: the template's _should_open_product_quants
  show_qty_update_button: async (env, rec) => {
    // a new variant's template is its _inherits parent, whose tracking the variant reads
    return shouldOpenProductQuants(env, (await rec.rel("product_tmpl_id")) ?? rec);
  },
});

/** odoo/orm/domains.py PY_OPERATORS with the value converted as `_search_field_by_quants` does (float, or a set of floats). */
function pyOperator(op: string, value: unknown): (x: number) => boolean {
  const many = Array.isArray(value);
  const num = (v: unknown): number => {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "boolean" ? Number(v) : NaN;
    if (Number.isNaN(n)) throw new NotPorted(`stock quantity search with the value ${JSON.stringify(v)}`);
    return n;
  };
  if (op === "in" || op === "not in") {
    if (!many) throw new NotPorted(`stock quantity search ${op} a single value`);
    const set = new Set((value as unknown[]).map(num));
    return op === "in" ? (x) => set.has(x) : (x) => !set.has(x);
  }
  if (many) throw new NotPorted(`stock quantity search ${op} a list`);
  const v = num(value);
  switch (op) {
    case "=": return (x) => x === v;
    case "!=": return (x) => x !== v;
    case "<": return (x) => x < v;
    case "<=": return (x) => x <= v;
    case ">": return (x) => x > v;
    case ">=": return (x) => x >= v;
    default: throw new NotPorted(`stock quantity search with operator ${op}`);
  }
}

/** product.py:493-531 `_search_field_by_quants`: the quants of the context's locations, summed per product. */
async function searchByQuants(env: Environment, op: string, value: unknown, field: "qty_available" | "free_qty"): Promise<Domain> {
  for (const key of ["lot_id", "owner_id", "package_id"]) if (env.context[key]) throw new NotPorted(`stock quantity search with context ${key}`);
  const test = pyOperator(op, value);
  const domains = await locationDomains(env, await contextLocations(env));
  const quantIds = domains === null ? [] : await env.model("stock.quant").search(domains.quant);
  const sums = quantIds.length ? (await env.cr.query<{ p: number; q: number; r: number }>(
    `SELECT product_id AS p, sum(quantity)::float8 AS q, sum(reserved_quantity)::float8 AS r FROM stock_quant WHERE id = ANY($1::int[]) GROUP BY product_id`,
    [quantIds])).rows : [];
  const includeZero = test(0);
  const ids = new Set<number>();
  const processed = new Set<number>();
  for (const s of sums) {
    const sum = field === "free_qty" ? s.q - s.r : s.q;
    if (includeZero) processed.add(s.p);
    if (test(sum)) ids.add(s.p);
  }
  if (includeZero) {
    const without = await env.model("product.product").search(and([cond("is_storable", "=", true), cond("id", "not in", [...processed])]));
    for (const id of without) ids.add(id);
  }
  return cond("id", "in", [...ids]);
}

/** product product_product.py:549-552 `_search_product_quantity`: every product (active ones) computed and filtered. */
async function searchProductQuantity(env: Environment, op: string, value: unknown, field: keyof Quantities): Promise<Domain> {
  const test = pyOperator(op, value);
  const all = await env.model("product.product").search(cond("id", "!=", false), { order: "id" });
  const quantities = await quantitiesDict(env, all);
  return cond("id", "in", all.filter((id) => test(quantities.get(id)?.[field] ?? 0)));
}

const withoutDates = (env: Environment): boolean => !["from_date", "to_date"].some((k) => k in env.context);

registerHooks("product.product", {
  search: {
    // product.py:468-479 and :481-488: the quants unless a date is in the context
    qty_available: async (env, op, value) => withoutDates(env) ? searchByQuants(env, op, value, "qty_available") : searchProductQuantity(env, op, value, "qty_available"),
    free_qty: async (env, op, value) => withoutDates(env) ? searchByQuants(env, op, value, "free_qty") : searchProductQuantity(env, op, value, "free_qty"),
    virtual_available: async (env, op, value) => searchProductQuantity(env, op, value, "virtual_available"),
    incoming_qty: async (env, op, value) => searchProductQuantity(env, op, value, "incoming_qty"),
    outgoing_qty: async (env, op, value) => searchProductQuantity(env, op, value, "outgoing_qty"),
  },
});

// product.py:999-1017: a template matches through its variants
const viaVariants = (field: string) => async (env: Environment, op: string, value: unknown): Promise<Domain> =>
  cond("product_variant_ids", "in", await env.model("product.product").search(cond(field, op, value)));
registerHooks("product.template", {
  search: {
    qty_available: viaVariants("qty_available"),
    virtual_available: viaVariants("virtual_available"),
    incoming_qty: viaVariants("incoming_qty"),
    outgoing_qty: viaVariants("outgoing_qty"),
  },
});
