/**
 * New stock.picking and stock.move records (stock/models/stock_picking.py, stock_move.py): the stored computes of a draft
 * transfer and its moves, create with the name from the operation type. Reservation, chained moves and done moves refuse.
 */
import { NotPorted, UserError } from "../errors";
import { convertToCache, floatRound } from "../orm/convert";
import { checkUnlinkAccess, unlink } from "../orm/unlink";
import { and, cond, parseDomain } from "../orm/domain";
import { DbRec, preciseDatetime, registerDefaults, registerRecordCompute, setOverlay, type Rec } from "../orm/recompute";
import { PreciseDatetime } from "../orm/values";

const dtText = (d: string | PreciseDatetime): string => (d instanceof PreciseDatetime ? d.text : d);
import type { Environment } from "../orm/types";
import { create } from "../orm/create";
import { inversePicked } from "./stock_validate";
import { actionAssign, applyPutaway, doUnreserve, logDemandChange, moveLineVals, moveRows, recomputeState, reserveQuantity, unitDigits, updateOrderpoints, uomCompare } from "./stock_engine";
import { relevantState } from "./stock_states";
import { registerOverrides, write } from "../orm/write";
import { nextOfSequence, uomQuantity } from "./sale_flow";
import { defineComputes, withCompany } from "./tail_util";
import { datetimeToString, dbNow, translate } from "./util";

const idOf = (v: unknown): number | null => (typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : null);

/** stock_picking.py location computes: `property` is the partner's own location when the type's default is that usage. */
async function pickingLocation(env: Environment, rec: Rec, own: "location_id" | "location_dest_id", defaultField: string, usage: string, property: string): Promise<unknown> {
  const state = await rec.get("state");
  if (state === "cancel" || state === "done" || (await rec.get("return_id"))) return rec.prev(own);
  const type = await rec.rel("picking_type_id");
  if (!type) return rec.prev(own);
  const location = await type.rel(defaultField);
  let id = location?.origin ?? null;
  const partner = idOf(await rec.get("partner_id"));
  if (location && (await location.get("usage")) === usage && partner) {
    const company = idOf(await rec.get("company_id")) ?? await env.company();
    const cenv = await withCompany(env.sudo(), company);
    const fromPartner = idOf((await cenv.model("res.partner").read([partner], [property], ""))[0]?.[property]);
    const fallback = (await env.cr.query<{ v: string | null }>(
      `SELECT d.json_value AS v FROM ir_default d JOIN ir_model_fields f ON f.id = d.field_id WHERE f.model = 'res.partner' AND f.name = $1 AND d.company_id IS NOT DISTINCT FROM $2 AND d.user_id IS NULL AND d.condition IS NULL`, [property, company])).rows[0]?.v;
    if (fromPartner && fromPartner !== (fallback ? Number(fallback) : null)) id = fromPartner;
  }
  return id;
}

registerRecordCompute("stock.picking", {
  // :_compute_location_id, _compute_location_dest_id
  location_id: (env, rec) => pickingLocation(env, rec, "location_id", "default_location_src_id", "supplier", "property_stock_supplier"),
  location_dest_id: (env, rec) => pickingLocation(env, rec, "location_dest_id", "default_location_dest_id", "customer", "property_stock_customer"),
  // _compute_move_type
  move_type: async (_env, rec) => {
    const type = await rec.rel("picking_type_id");
    return type ? await type.get("move_type") : null;
  },
  // stock_picking.py:331-377 _compute_state: the moves are searched by `self.ids` (:347), the origin's moves in the
  // database for a new transfer (its moves in the form count only in the `picking.move_ids` of :370), none without one
  state: async (env, rec) => {
    const picking = rec.origin;
    if (picking === null) return "draft";
    const moveIds = (await env.cr.query<{ id: number }>(
      "SELECT id FROM stock_move WHERE picking_id = $1 ORDER BY sequence, id", [picking])).rows.map((r) => r.id);
    if (!moveIds.length) return "draft";
    const moveDef = env.reg.model("stock.move");
    const moves: { state: string; is_scrap: boolean | null; procure_method: string; qty: number }[] = [];
    for (const mid of moveIds) {
      const m = new DbRec(env.sudo(), moveDef, mid);
      moves.push({
        state: String((await m.get("state")) ?? ""),
        is_scrap: Boolean(await m.get("is_scrap")),
        procure_method: String((await m.get("procure_method")) ?? ""),
        qty: Number((await m.get("product_uom_qty")) ?? 0),
      });
    }
    if (moves.some((m) => m.state === "draft")) return "draft";
    if (moves.every((m) => m.state === "cancel")) return "cancel";
    if (moves.every((m) => m.state === "cancel" || m.state === "done")) {
      const scrapped = moves.every((m) => (m.state === "done" ? Boolean(m.is_scrap) : true));
      return scrapped && moves.some((m) => m.state === "cancel" && !m.is_scrap) ? "cancel" : "done";
    }
    const location = await rec.rel("location_id");
    const bypass = location !== null && ["supplier", "customer", "inventory", "production"].includes(String(await location.get("usage")));
    if (bypass) {
      // `picking.move_ids`: the form's moves on a new transfer
      let mts = moves.every((m) => m.procure_method === "make_to_stock");
      if (rec.id === null) {
        mts = true;
        for (const m of await rec.rels("move_ids")) if ((await m.get("procure_method")) !== "make_to_stock") mts = false;
      }
      if (mts) return "assigned";
    }
    const relevant = relevantState(moves, String(await rec.get("move_type")));
    return relevant === "partially_available" ? "assigned" : relevant;
  },
  // _compute_scheduled_date (`if not picking.id: continue`)
  scheduled_date: async (env, rec) => {
    const current = await rec.prev("scheduled_date");
    if (rec.id === null) return current;
    // the moves' dates as Odoo's cache holds them (with a demo move's microseconds, src/orm/recompute.ts preciseDatetime)
    const dates: (string | PreciseDatetime)[] = [];
    for (const m of await rec.rels("move_ids")) {
      if (["done", "cancel"].includes(String(await m.get("state")))) continue;
      const d = await preciseDatetime(m, "date");
      if (typeof d === "string" || d instanceof PreciseDatetime) dates.push(d);
    }
    dates.sort((a, b) => (dtText(a) < dtText(b) ? -1 : dtText(a) > dtText(b) ? 1 : 0));
    const fallback = typeof current === "string" && current ? current : datetimeToString(await dbNow(env));
    if (!dates.length) return fallback;
    return (await rec.get("move_type")) === "direct" ? dates[0] : dates[dates.length - 1];
  },
  // _compute_date_deadline
  date_deadline: async (_env, rec) => {
    const dates: (string | PreciseDatetime)[] = [];
    for (const m of await rec.rels("move_ids")) {
      const d = await preciseDatetime(m, "date_deadline");
      if (((typeof d === "string" && d) || d instanceof PreciseDatetime) && (await m.get("state")) !== "cancel") dates.push(d);
    }
    dates.sort((a, b) => (dtText(a) < dtText(b) ? -1 : dtText(a) > dtText(b) ? 1 : 0));
    if (!dates.length) return null;
    return (await rec.get("move_type")) === "direct" ? dates[0] : dates[dates.length - 1];
  },
  // _compute_has_deadline_issue
  has_deadline_issue: async (_env, rec) => {
    const deadline = await rec.get("date_deadline"), scheduled = await rec.get("scheduled_date");
    return typeof deadline === "string" && typeof scheduled === "string" && deadline < scheduled;
  },
  // sale_stock stock.py:266-272 _compute_sale_id
  sale_id: async (_env, rec) => {
    for (const m of await rec.rels("move_ids")) {
      const line = await m.rel("sale_line_id");
      const order = line ? idOf(await line.get("order_id")) : null;
      if (order) return order;
    }
    return null;
  },
  picking_properties: async (_env, rec) => rec.prev("picking_properties"),
  // stock_picking.py:390-422 `_compute_bulk_weight` and `_compute_shipping_weight` without packages
  shipping_weight: async (env, rec) => {
    if (rec.id === null) {
      if (((await rec.get("move_line_ids")) as unknown[] | null)?.length) throw new NotPorted("stock.picking.shipping_weight of a new transfer with move lines");
      return 0;
    }
    const groups = (await env.cr.query<{ uom_id: number; product_uom: number; quantity: number; weight: number; n: number }>(
      `SELECT l.uom_id, t.uom_id AS product_uom, l.quantity::float8 AS quantity, COALESCE(p.weight, 0)::float8 AS weight, count(*)::int AS n
         FROM stock_move_line l JOIN product_product p ON p.id = l.product_id JOIN product_template t ON t.id = p.product_tmpl_id
        WHERE l.picking_id = $1 AND l.result_package_id IS NULL GROUP BY l.uom_id, t.uom_id, l.product_id, l.quantity, p.weight ORDER BY l.product_id, l.uom_id, l.quantity`, [rec.id])).rows;
    let weight = 0;
    for (const g of groups) {
      const qty = g.uom_id === g.product_uom ? g.quantity : await uomQuantity(env, g.quantity, g.uom_id, g.product_uom, "UP");
      weight += g.n * qty * g.weight;
    }
    const pkgRows = (await env.cr.query<{ id: number; shipping_weight: number | null; base_weight: number | null }>(
      `SELECT DISTINCT pk.id, pk.shipping_weight::float8 AS shipping_weight, pt.base_weight::float8 AS base_weight
         FROM stock_move_line l JOIN stock_package pk ON pk.id = l.result_package_id
         LEFT JOIN stock_package_type pt ON pt.id = pk.package_type_id
        WHERE l.picking_id = $1`, [rec.id])).rows;
    for (const pk of pkgRows) {
      if (pk.shipping_weight) {
        weight += pk.shipping_weight;
      } else {
        const pLines = (await env.cr.query<{ uom_id: number; product_uom: number; quantity: number; weight: number }>(
          `SELECT l.uom_id, t.uom_id AS product_uom, l.quantity::float8 AS quantity, COALESCE(p.weight, 0)::float8 AS weight
             FROM stock_move_line l JOIN product_product p ON p.id = l.product_id JOIN product_template t ON t.id = p.product_tmpl_id
            WHERE l.picking_id = $1 AND l.result_package_id = $2`, [rec.id, pk.id])).rows;
        weight += pk.base_weight ?? 0;
        for (const pl of pLines) {
          const qty = pl.uom_id === pl.product_uom ? pl.quantity : await uomQuantity(env, pl.quantity, pl.uom_id, pl.product_uom, "UP");
          weight += qty * pl.weight;
        }
      }
    }
    return weight;
  },
  // :_compute_display_name of a new transfer
  display_name: async (env, rec) => {
    if (rec.id !== null) return (await env.model("stock.picking").displayName([rec.id])).get(rec.id) ?? "";
    return rec.get("name");
  },
});

defineComputes("stock.picking", {
  // _compute_is_date_editable
  is_date_editable: async (_env, rec) => {
    const state = await rec.get("state");
    if (state === "done" || state === "cancel") return false;
    return true;
  },
  has_tracking: async (_env, rec) => {
    for (const m of await rec.rels("move_ids")) {
      const t = await m.get("has_tracking");
      if (t && t !== "none") return true;
    }
    return false;
  },
  has_scrap_move: async (_env, rec) => {
    for (const m of await rec.rels("move_ids")) if (await m.get("is_scrap")) return true;
    return false;
  },
});

/** `_get_in_move_lines` / `_get_out_move_lines` is not empty: picked lines from (into) a location the company does not value into (from) one it values. */
async function valuedLines(env: Environment, rec: Rec, direction: "in" | "out"): Promise<boolean> {
  if (rec.id === null) throw new NotPorted("stock.move.is_in of a new move");
  const rows = (await env.cr.query<{ src: boolean; dst: boolean; owner: boolean }>(
    `SELECT (COALESCE(s.company_id = l.company_id, false) AND s.usage IN ('internal', 'transit')) AS src,
            (COALESCE(d.company_id = l.company_id, false) AND d.usage IN ('internal', 'transit')) AS dst,
            (l.owner_id IS NOT NULL AND l.owner_id IS DISTINCT FROM c.partner_id) AS owner
       FROM stock_move_line l JOIN stock_location s ON s.id = l.location_id JOIN stock_location d ON d.id = l.location_dest_id JOIN res_company c ON c.id = l.company_id
      WHERE l.move_id = $1 AND COALESCE(l.picked, false)`, [rec.id])).rows;
  return rows.some((r) => !r.owner && (direction === "in" ? !r.src && r.dst : r.src && !r.dst));
}

/** `_is_dropshipped` (returned: the other way): from a supplier (or a company-less transit) to a customer. */
async function dropship(rec: Rec, returned: boolean): Promise<boolean> {
  const src = await rec.rel("location_id"), dst = await rec.rel("location_dest_id");
  const end = async (l: Rec | null, usage: string): Promise<boolean> => l !== null && ((await l.get("usage")) === usage || ((await l.get("usage")) === "transit" && !(await l.get("company_id"))));
  return returned ? (await end(src, "customer")) && (await end(dst, "supplier")) : (await end(src, "supplier")) && (await end(dst, "customer"));
}

registerRecordCompute("stock.move", {
  // :_compute_picking_type_id, _compute_partner_id, _compute_priority
  picking_type_id: async (_env, rec) => {
    const picking = await rec.rel("picking_id");
    return picking ? idOf(await picking.get("picking_type_id")) : rec.prev("picking_type_id");
  },
  partner_id: async (_env, rec) => {
    const picking = await rec.rel("picking_id");
    return picking ? idOf(await picking.get("partner_id")) : rec.prev("partner_id");
  },
  priority: async (_env, rec) => {
    const picking = await rec.rel("picking_id");
    return (picking ? await picking.get("priority") : null) || (await rec.prev("priority")) || "0";
  },
  // :_compute_uom_id
  uom_id: async (_env, rec) => {
    const product = await rec.rel("product_id");
    return product ? idOf(await product.get("uom_id")) : null;
  },
  // :_compute_location_id, :_compute_location_dest_id
  location_id: async (_env, rec) => {
    const current = await rec.prev("location_id");
    if (await rec.get("picked")) return current;
    if (current && rec.origin !== null) return current;
    const picking = await rec.rel("picking_id");
    if (picking) return idOf(await picking.get("location_id"));
    const type = await rec.rel("picking_type_id");
    if (type) return idOf(await type.get("default_location_src_id"));
    if (await rec.get("is_scrap")) {
      const company = await rec.rel("company_id");
      return company ? idOf(await company.get("default_stock_location_id")) : current;
    }
    return current;
  },
  // stock_move.py:232-263 _compute_location_dest_id
  location_dest_id: async (env, rec) => {
    let dest: Rec | null = null;
    const company = await rec.rel("company_id");
    if (await rec.get("is_scrap")) {
      const current = await rec.rel("location_dest_id");
      if (current && (await current.get("usage")) === "inventory") {
        const own = idOf(await current.get("company_id"));
        if (!own || own === (company?.origin ?? null)) dest = current;
      }
      if (!dest && company) dest = await company.rel("scrap_location_id");
    } else {
      const picking = await rec.rel("picking_id");
      const rule = await rec.rel("rule_id");
      const type = await rec.rel("picking_type_id");
      if (picking) dest = await picking.rel("location_dest_id");
      else if (rule && (await rule.get("location_dest_from_rule"))) dest = await rule.rel("location_dest_id");
      else if (type) dest = await type.rel("default_location_dest_id");
    }
    const final = await rec.rel("forecasted_location_id");
    if (dest && final && dest.origin !== null && final.origin !== null) {
      const paths = (await env.cr.query<{ id: number; p: string }>("SELECT id, parent_path AS p FROM stock_location WHERE id = ANY($1::int[])",
        [[dest.origin, final.origin, ...[await env.reg.xmlid(env.cr, "stock.stock_location_customers")].filter((x): x is number => typeof x === "number")]])).rows;
      const path = (id: number): string => paths.find((r) => r.id === id)?.p ?? "\u0000";
      const customers = await env.reg.xmlid(env.cr, "stock.stock_location_customers");
      if (typeof customers !== "number") throw new NotPorted("stock.move.location_dest_id without stock.stock_location_customers (_get_partner_locations search)");
      const toTransit = path(dest.origin).startsWith(path(customers)) && (await final.get("usage")) === "transit";
      if (path(final.origin).startsWith(path(dest.origin)) || toTransit) return final.origin;
    }
    return dest ? dest.origin : null;
  },
  // :_compute_product_qty, _compute_quantity_product_uom, _compute_packaging_uom_id, _compute_packaging_uom_qty: one unit only
  // stock_move.py:405-408 `uom_id._compute_quantity(product_uom_qty, product_id.uom_id, rounding_method='HALF-UP')`
  product_qty: async (env, rec) => {
    const product = await rec.rel("product_id");
    const uom = idOf(await rec.get("uom_id"));
    const qty = Number((await rec.get("product_uom_qty")) ?? 0);
    if (!product || !uom) return qty;
    const { uomQuantity } = await import("./sale_flow");
    return uomQuantity(env, qty, uom, idOf(await product.get("uom_id")), "HALF-UP");
  },
  // stock_move.py:266-268 (same conversion, HALF-UP)
  quantity_product_uom: async (env, rec) => {
    const product = await rec.rel("product_id");
    const uom = idOf(await rec.get("uom_id"));
    const qty = Number((await rec.get("quantity")) ?? 0);
    if (!product || !uom) return qty;
    const { uomQuantity } = await import("./sale_flow");
    return uomQuantity(env, qty, uom, idOf(await product.get("uom_id")), "HALF-UP");
  },
  packaging_uom_id: async (_env, rec) => idOf(await rec.get("uom_id")),
  packaging_uom_qty: async (_env, rec) => Number((await rec.get("product_uom_qty")) ?? 0),
  // stock_move.py:305-311 _compute_picked
  picked: async (_env, rec) => {
    if ((await rec.get("state")) === "done") return true;
    const lines = await rec.rels("move_line_ids");
    for (const l of lines) if (await l.get("picked")) return true;
    if (lines.length) return false;
    return rec.prev("picked");
  },
  // :_compute_reference
  reference: async (env, rec) => {
    // stock_move.py:384-394: the inventory name, else whether the count confirmed or changed the quantity, with the
    // creating user unless it is the superuser
    if (await rec.get("is_inventory")) {
      const name = await rec.get("inventory_name");
      if (name) return name;
      const zero = (await uomCompare(env, Number((await rec.get("quantity")) ?? 0), 0)) === 0;
      let ref = translate(env, zero ? "Product Quantity Confirmed" : "Product Quantity Updated");
      const creator = idOf(await rec.get("create_uid")) ?? env.uid;
      if (creator !== 1) {
        const [u] = await env.sudo().model("res.users").read([creator], ["display_name"], "");
        ref += ` (${String(u?.["display_name"] ?? "")})`;
      }
      return ref;
    }
    const picking = await rec.rel("picking_id");
    return picking ? await picking.get("name") : null;
  },
  // :_compute_reservation_date
  reservation_date: async (_env, rec) => {
    const type = await rec.rel("picking_type_id");
    const method = type ? await type.get("reservation_method") : null;
    if (method === "by_date") throw new NotPorted("stock.move.reservation_date of by_date operation types");
    return method === "manual" ? null : rec.prev("reservation_date");
  },
  // stock_move.py:415-426 `_compute_delay_alert_date`: the latest date of the open origin moves when after the move's
  delay_alert_date: async (_env, rec) => {
    const state = await rec.get("state");
    if (state === "done" || state === "cancel") return null;
    const date = await rec.get("date");
    let latest: string | null = null;
    for (const m of await rec.rels("move_orig_ids")) {
      if (["done", "cancel"].includes(String(await m.get("state")))) continue;
      const d = await m.get("date");
      if (typeof d === "string" && d && (latest === null || d > latest)) latest = d;
    }
    return latest !== null && typeof date === "string" && latest > date ? latest : null;
  },
  // stock_account stock_move.py:87-110 with :624-706 `_is_in`, `_is_out`, `_is_dropshipped(_returned)`
  is_in: async (env, rec) => ((await rec.get("state")) === "done" ? (await valuedLines(env, rec, "in")) && !(await dropship(rec, true)) : false),
  is_out: async (env, rec) => ((await rec.get("state")) === "done" ? (await valuedLines(env, rec, "out")) && !(await dropship(rec, false)) : false),
  is_dropship: async (_env, rec) => ((await rec.get("state")) === "done" ? (await dropship(rec, false)) || (await dropship(rec, true)) : false),
});

// stock res_company.py:61-65, :55-59 the company's scrap location and first warehouse stock
defineComputes("res.company", {
  scrap_location_id: async (env, rec) => (await env.cr.query<{ id: number }>("SELECT min(id) AS id FROM stock_location WHERE company_id = $1 AND usage = 'inventory' AND active", [rec.origin])).rows[0]?.id ?? null,
  default_stock_location_id: async (env, rec) => (await env.cr.query<{ id: number }>("SELECT lot_stock_id AS id FROM stock_warehouse WHERE company_id = $1 AND active ORDER BY id LIMIT 1", [rec.origin])).rows[0]?.id ?? null,
});

registerDefaults("stock.picking", {
  // stock_picking.py:26-33 `_default_picking_type_id`
  picking_type_id: async (env) => {
    const code = env.context["restricted_picking_type_code"];
    if (!code) return undefined;
    const rows = await env.model("stock.picking.type").search(parseDomain([["code", "=", code], ["company_id", "=", await env.company()]]));
    return rows[0] ?? false;
  },
});

/**
 * stock_move.py:467-507 `_set_quantity`: a quantity below the lines' sum takes it off the lines, last line first
 * (`_process_decrease`); a higher one goes through `_process_increase` -> `_set_quantity_done(move.quantity)`.
 */
async function setMoveQuantity(env: Environment, ids: readonly number[]): Promise<void> {
  const digits = await unitDigits(env);
  const errors: string[] = [];
  for (const id of ids) {
    const [m] = (await env.cr.query<{ quantity: number; uom_id: number; product: string }>(
      "SELECT COALESCE(quantity, 0)::float8 AS quantity, uom_id, product_id::text AS product FROM stock_move WHERE id = $1", [id])).rows;
    if (!m) continue;
    if (floatRound(m.quantity, digits) !== m.quantity) {
      const [p] = await env.model("product.product").read([Number(m.product)], ["display_name"], "");
      errors.push(translate(env, "\nThe quantity done for the product %(product)s doesn't respect the rounding precision defined on the system.\nPlease change the quantity done or the rounding precision in your settings.").replace("%(product)s", String(p?.["display_name"] ?? "")));
      continue;
    }
    const lines = (await env.cr.query<{ id: number; quantity: number; uom_id: number; state: string | null; picked: boolean | null }>(
      "SELECT id, COALESCE(quantity, 0)::float8 AS quantity, uom_id, state, picked FROM stock_move_line WHERE move_id = $1 ORDER BY id", [id])).rows;
    // `_quantity_sml`: the lines' quantities in the move's unit (round=False)
    if (lines.some((l) => l.uom_id !== m.uom_id)) throw new NotPorted("stock.move._set_quantity with lines in another unit");
    let sml = 0;
    for (const l of lines) sml += l.quantity;
    const delta = m.quantity - sml;
    const cmp = await uomCompare(env, delta, 0);
    if (cmp > 0) {
      await setQuantityDone(env, id, m.quantity);
      continue;
    }
    if (cmp === 0) continue;
    let quantity = -delta;
    const toUnlink: number[] = [];
    for (const ml of [...lines].reverse()) {
      if (env.context["unreserve_unpicked_only"] && ml.picked) continue;
      if ((await uomCompare(env, quantity, 0)) === 0) break;
      const dec = Math.min(ml.quantity, quantity);
      if ((await uomCompare(env, dec, 0)) === 0) continue;
      if ((await uomCompare(env, ml.quantity, dec)) === 0 && !["done", "cancel"].includes(String(ml.state))) toUnlink.push(ml.id);
      else await write(env, "stock.move.line", [ml.id], { quantity: ml.quantity - dec });
      quantity -= dec;
    }
    if (toUnlink.length) await unlink(env, "stock.move.line", toUnlink);
  }
  if (errors.length) throw new UserError(errors.join("\n"));
}

/**
 * stock_move.py:2671-2682 `_set_quantity_done(qty)` with :2590-2669 `_set_quantity_done_prepare_vals`: the existing
 * lines (in `_order`, id without result packages) are lowered to the target, deleted once it is reached, or raised by
 * what their own quants (strict: the line's location and lot) can still reserve; the rest is reserved on the move's
 * quants (from the total, skipping the quants the lines consumed), then a line from the move itself. Updates run in
 * order, the deletes and the creates at the end (fields_relational.py:1062-1113 One2many write `flush`).
 * Serial numbers, other units, result packages, packages and owners refuse.
 */
async function setQuantityDone(env: Environment, moveId: number, qtyMove: number): Promise<void> {
  const [m] = await moveRows(env, [moveId]);
  if (!m) return;
  if (m.tracking === "serial") throw new NotPorted("stock.move._set_quantity_done of a serial number product (one line per unit)");
  // `_compute_quantity(..., round=False)` between the move's and the product's unit: only the same unit here
  if (m.uom_id !== m.product_uom) throw new NotPorted("stock.move._set_quantity_done in another unit than the product's");
  const lines = (await env.cr.query<{ id: number; quantity: number; uom_id: number; result_package_id: number | null; location_id: number; lot_id: number | null; package_id: number | null; owner_id: number | null }>(
    `SELECT id, COALESCE(quantity, 0)::float8 AS quantity, uom_id, result_package_id, location_id, lot_id, package_id, owner_id
       FROM stock_move_line WHERE move_id = $1 ORDER BY id`, [moveId])).rows;
  if (lines.some((l) => l.result_package_id !== null)) throw new NotPorted("stock.move._set_quantity_done with result packages (line order and kept quantities)");
  if (lines.some((l) => l.uom_id !== m.product_uom)) throw new NotPorted("stock.move._set_quantity_done with lines in another unit");
  if (lines.some((l) => l.package_id !== null || l.owner_id !== null)) throw new NotPorted("stock.move._set_quantity_done with lines of a package or owner");
  let qty = qtyMove;
  const total = qty;
  const updates: [number, number][] = [];
  const deletes: number[] = [];
  const consumed = new Set<number>();
  for (const ml of lines) {
    const mlQty = ml.quantity;
    if ((await uomCompare(env, mlQty, 0)) < 0) continue;
    if ((await uomCompare(env, qty, 0)) === 0) { deletes.push(ml.id); continue; }
    if ((await uomCompare(env, mlQty, qty)) > 0) { updates.push([ml.id, qty]); qty = 0; continue; }
    qty -= Math.min(qty, mlQty);
    if ((await uomCompare(env, qty, 0)) <= 0) continue;
    const mlQuants = await reserveQuantity(env, m.product_id, ml.location_id, qty, m.uom_id, m.product_uom, false, { lot: ml.lot_id });
    let avail = 0;
    for (const [q, a] of mlQuants) { avail += a; consumed.add(q.id); }
    if ((await uomCompare(env, avail, qty)) <= 0) {
      qty -= avail;
      updates.push([ml.id, avail + mlQty]);
    }
  }
  const creates: Record<string, unknown>[] = [];
  if ((await uomCompare(env, qty, 0)) > 0) {
    for (const [quant, avail] of await reserveQuantity(env, m.product_id, m.location_id, total, m.uom_id, m.product_uom, false)) {
      if (consumed.has(quant.id)) continue;
      const taken = Math.min(qty, avail);
      qty -= taken;
      creates.push(await moveLineVals(env, m, taken, quant));
      if ((await uomCompare(env, qty, 0)) <= 0) break;
    }
  }
  if ((await uomCompare(env, qty, 0)) > 0) creates.push(await moveLineVals(env, m, qty, null));
  for (const [id, q] of updates) await write(env, "stock.move.line", [id], { quantity: q });
  if (deletes.length) await unlink(env, "stock.move.line", deletes);
  if (creates.length) await create(env, "stock.move.line", creates);
  await applyPutaway(env, [moveId]);
}

/**
 * stock_move.py:908-916, after the write of a new source: each line of the moves (`move_to_check_location.move_line_ids`,
 * the moves in order, each one's lines in `_order`: result_package_id desc, id) whose location is not inside the new
 * source sends all those moves back to make-to-stock without previous moves, and is deleted; the moves are then
 * assigned again (the returned ids).
 */
async function checkMoveLocation(env: Environment, moves: readonly number[]): Promise<number[]> {
  const lines: { id: number; path: string; source: number }[] = [];
  for (const m of moves) {
    lines.push(...(await env.cr.query<{ id: number; path: string; source: number }>(
      `SELECT l.id, loc.parent_path AS path, m.location_id AS source FROM stock_move_line l JOIN stock_move m ON m.id = l.move_id
        JOIN stock_location loc ON loc.id = l.location_id WHERE l.move_id = $1 ORDER BY l.result_package_id DESC NULLS FIRST, l.id`, [m])).rows);
  }
  let reassign: number[] = [];
  for (const ml of lines) {
    const path = ml.path.split("/").slice(0, -1).map(Number);
    if (path.includes(ml.source)) continue;
    reassign = [...moves];
    await write(env, "stock.move", moves, { procure_method: "make_to_stock" });
    await write(env, "stock.move", moves, { move_orig_ids: [[5, 0, 0]] });
    await unlink(env, "stock.move.line", [ml.id]);
  }
  return reassign;
}

/** stock_move.py:917-925: a move takes the warehouse of its source, else of its destination, when it differs. */
async function followWarehouse(env: Environment, ids: readonly number[]): Promise<void> {
  const rows = (await env.cr.query<{ id: number; wh: number | null; own: number | null }>(
    `SELECT m.id, COALESCE(s.warehouse_id, d.warehouse_id) AS wh, m.warehouse_id AS own FROM stock_move m
       JOIN stock_location s ON s.id = m.location_id JOIN stock_location d ON d.id = m.location_dest_id WHERE m.id = ANY($1::int[])`, [[...ids]])).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const groups = new Map<number | null, number[]>();
  for (const id of ids) {
    const r = byId.get(id);
    if (!r || r.wh === r.own) continue;
    const g = groups.get(r.wh) ?? [];
    if (!g.includes(id)) g.push(id);
    groups.set(r.wh, g);
  }
  for (const [wh, moves] of groups) await write(env, "stock.move", moves, { warehouse_id: wh ?? false });
}

const PROPAGATED = "date_deadline_propagate_ids";

/**
 * stock_move.py:609-628 `_set_date_deadline`, before the write: each move's next and previous moves (`move_dest_ids |
 * move_orig_ids`, each in the move order) that are not done or cancelled and not yet reached (the context's set, shared
 * by the nested writes) move by the same delta when they have a deadline, and take the new one otherwise. The new
 * deadline is the written value as the client gives it (a string: `move_update.date_deadline != new_deadline` compares
 * a datetime with a string, so it always holds).
 */
async function setDateDeadline(env: Environment, ids: readonly number[], deadline: unknown): Promise<void> {
  const prev = env.context[PROPAGATED];
  const seen = prev instanceof Set ? prev as Set<number> : new Set<number>();
  if (prev !== undefined && !(prev instanceof Set)) throw new NotPorted("stock.move date_deadline_propagate_ids given by the caller");
  for (const id of ids) seen.add(id);
  const linked = (await env.cr.query<{ id: number; n: string }>(
    `SELECT m.id, count(r.*)::text AS n FROM stock_move m LEFT JOIN stock_move_move_rel r ON r.move_orig_id = m.id OR r.move_dest_id = m.id
      WHERE m.id = ANY($1::int[]) GROUP BY m.id`, [[...ids]])).rows;
  if (!linked.some((r) => Number(r.n) > 0)) return;
  if (deadline !== false && typeof deadline !== "string") throw new NotPorted(`stock.move date_deadline propagation of ${JSON.stringify(deadline)}`);
  const sub = env.withContext({ ...env.context, [PROPAGATED]: seen });
  for (const id of ids) {
    const own = (await env.cr.query<{ d: string | null }>("SELECT date_deadline::text AS d FROM stock_move WHERE id = $1", [id])).rows[0]?.d ?? null;
    // `move.move_dest_ids | move.move_orig_ids`: the next moves, then the previous ones, each in `_order` (sequence, id)
    const updates = (await env.cr.query<{ id: number; state: string | null; d: string | null; k: number }>(
      `SELECT u.id, u.state, u.date_deadline::text AS d, x.k FROM (
          SELECT r.move_dest_id AS id, 0 AS k FROM stock_move_move_rel r WHERE r.move_orig_id = $1
          UNION ALL SELECT r.move_orig_id AS id, 1 AS k FROM stock_move_move_rel r WHERE r.move_dest_id = $1) x
        JOIN stock_move u ON u.id = x.id ORDER BY x.k, u.sequence, u.id`, [id])).rows;
    const done = new Set<number>();
    for (const u of updates) {
      if (done.has(u.id)) continue; // the union keeps the first
      done.add(u.id);
      if (u.state === "done" || u.state === "cancel" || seen.has(u.id)) continue;
      // :616-619 `delta = move.date_deadline - to_datetime(new_deadline)`, then :625-626 `move_update.date_deadline -= delta`
      const current = (await env.cr.query<{ d: string | null }>("SELECT date_deadline::text AS d FROM stock_move WHERE id = $1", [u.id])).rows[0]?.d ?? null;
      let value: string | false = deadline === false ? false : String(deadline);
      if (own && deadline && current) {
        const shifted = (await env.cr.query<{ v: string; z: boolean }>(
          "SELECT ($1::timestamp - ($2::timestamp - $3::timestamp))::text AS v, ($2::timestamp = $3::timestamp) AS z", [current, own, deadline])).rows[0]!;
        if (!shifted.z) value = shifted.v;
      }
      await write(sub, "stock.move", [u.id], { date_deadline: value });
    }
  }
}

async function refuseMoveLines(env: Environment, ids: readonly number[], what: string): Promise<void> {
  if ((await env.cr.query("SELECT 1 FROM stock_move_line WHERE move_id = ANY($1::int[]) LIMIT 1", [[...ids]])).rows.length) throw new NotPorted(`stock.move ${what} with move lines`);
}
registerOverrides("stock.move", {
  inverse: {
    // stock_move.py `_set_location_dest_id`, `_inverse_picked`, `_set_quantity`: on the move lines, which a draft move does not have
    // stock_move.py:270-276 `_set_location_dest_id`: lines already inside the move's destination keep theirs; the others
    // would go through the putaway strategy
    // the others take `_get_putaway_strategy` of the move's destination (stock_location.py:293-371): without putaway
    // rules on it and when it is not a view, the destination itself
    location_dest_id: async (env, ids) => {
      const lines: { id: number; path: string; dest: number; usage: string; rules: number }[] = [];
      for (const m of ids) {
        lines.push(...(await env.cr.query<{ id: number; path: string; dest: number; usage: string; rules: number }>(
          `SELECT l.id, ld.parent_path AS path, m.location_dest_id AS dest, d.usage,
                  (SELECT count(*)::int FROM stock_putaway_rule r WHERE r.location_in_id = m.location_dest_id AND r.active) AS rules
             FROM stock_move_line l JOIN stock_move m ON m.id = l.move_id JOIN stock_location ld ON ld.id = l.location_dest_id
             JOIN stock_location d ON d.id = m.location_dest_id WHERE l.move_id = $1 ORDER BY l.result_package_id DESC NULLS FIRST, l.id`, [m])).rows);
      }
      for (const l of lines) {
        if (l.path.split("/").slice(0, -1).map(Number).includes(l.dest)) continue;
        if (l.rules) throw new NotPorted("stock.move location_dest_id inverse with putaway rules (_get_putaway_strategy)");
        if (l.usage === "view") throw new NotPorted("stock.move location_dest_id inverse into a view location (_get_putaway_strategy)");
        await write(env, "stock.move.line", [l.id], { location_dest_id: l.dest });
      }
    },
    picked: (env, ids) => inversePicked(env, ids),
    quantity: (env, ids) => setMoveQuantity(env, ids),
    product_qty: async () => undefined,
    // stock_move.py:649-651 `_set_lot_ids`: a move whose product is not tracked by lots or serials is skipped (the
    // scrap form of an untracked product writes lot_ids=[] beside the quantity that made its move lines)
    lot_ids: async (env, ids) => {
      const tracked = (await env.cr.query<{ id: number }>(
        `SELECT m.id FROM stock_move m JOIN product_product p ON p.id = m.product_id JOIN product_template t ON t.id = p.product_tmpl_id
          WHERE m.id = ANY($1::int[]) AND t.tracking IN ('lot', 'serial')`, [[...ids]])).rows.map((r) => r.id);
      if (tracked.length) await refuseMoveLines(env, tracked, "lot_ids inverse");
    },
    // stock_move.py:848-850 `_inverse_description_picking`: the written description is kept as the manual one
    description_picking: async (env, ids, vals) => {
      if (!("description_picking" in vals)) throw new NotPorted("stock.move description_picking inverse without the written value");
      // models.py write runs the inverses under `env.protecting(...)`: the written description stays in the cache
      // although its dependency description_picking_manual changes (an emptied one is read back as written; the
      // compute in src/models/inventory_flow.ts reads it from the write overlay)
      await write(env, "stock.move", ids, { description_picking_manual: vals["description_picking"] ?? false });
      const field = env.reg.model("stock.move").fields.get("description_picking")!;
      setOverlay(env, "stock.move", "description_picking", ids, convertToCache(field, vals["description_picking"] ?? false, "stock.move"));
    },
  },
  // stock_move.py create: a description that repeats the product's is not stored
  create: async (env, valsList, next) => {
    for (const vals of valsList) {
      if (!("description_picking" in vals)) continue;
      const text = vals["description_picking"];
      delete vals["description_picking"];
      const product = idOf(vals["product_id"]), picking = idOf(vals["picking_id"]);
      if (!text || !product) continue;
      const code = picking ? (await env.cr.query<{ c: string | null }>("SELECT t.code AS c FROM stock_picking p JOIN stock_picking_type t ON t.id = p.picking_type_id WHERE p.id = $1", [picking])).rows[0]?.c : null;
      const field = ({ incoming: "description_pickingin", outgoing: "description_pickingout", internal: "description_picking" } as Record<string, string>)[String(code)];
      const own = field ? (await env.sudo().model("product.product").read([product], [field], ""))[0]?.[field] : null;
      if (text !== own) vals["description_picking_manual"] = text;
    }
    const ids = await next(env, valsList);
    // stock_move.py:866 `_update_orderpoints` (the orderpoints' qty_to_order_computed, computed again on read in Odoo)
    await updateOrderpoints(env, ids);
    return ids;
  },
  // stock_move.py:872-942 write: the orderpoints of the moves before a product or location change and after the
  // changes of product, state, date, quantity or locations
  write: async (env, ids, vals, next) => {
    // :876-899 a new initial demand: the `stock.track_move_template` note on the transfer, then (unless
    // `do_not_unreserve`) the moves reserving more than the new demand are unreserved, the others leave 'assigned'
    let recompute: number[] = [];
    let reassign: number[] = [];
    if ("product_uom_qty" in vals) {
      const qty = Number(vals["product_uom_qty"] || 0);
      const moves = await moveRows(env, ids);
      const logged = moves.filter((m) => !["done", "draft"].includes(m.state) && m.picking_id);
      for (const m of logged) {
        if ((await uomCompare(env, qty, m.product_uom_qty)) === 0) continue;
        // stock_template.xml `message_body` prints a line per other logged key
        const others = ["quantity", "location_id", "location_dest_id", "lot_id", "package_id", "package_result_id", "owner_id"].filter((k) => k in vals);
        if (others.length) throw new NotPorted(`stock.track_move_template with ${others.join(", ")}`);
        await logDemandChange(env, m.id, qty);
      }
      if (env.context["do_not_unreserve"] === undefined || env.context["do_not_unreserve"] === null) {
        const unreserve: number[] = [];
        for (const m of moves) if (!["draft", "done", "cancel"].includes(m.state) && (await uomCompare(env, m.quantity, qty)) === 1) unreserve.push(m.id);
        await doUnreserve(env, unreserve);
        const rest = moves.filter((m) => !unreserve.includes(m.id));
        const assigned = rest.filter((m) => m.state === "assigned").map((m) => m.id);
        if (assigned.length) await write(env, "stock.move", assigned, { state: "partially_available" });
        const usage = new Map((await env.cr.query<{ id: number; usage: string | null }>(
          "SELECT m.id, l.usage FROM stock_move m JOIN stock_location l ON l.id = m.location_id WHERE m.id = ANY($1::int[])", [[...ids]])).rows.map((r) => [r.id, r.usage]));
        const current = new Map((await moveRows(env, ids)).map((m) => [m.id, m.state]));
        reassign = [...unreserve.filter((m) => usage.get(m) === "supplier"),
          ...rest.filter((m) => usage.get(m.id) === "supplier" && ["partially_available", "assigned"].includes(current.get(m.id) ?? "")).map((m) => m.id)];
        recompute = ids.filter((m) => !unreserve.includes(m) && !reassign.includes(m));
      }
    }
    // :900-901 a new deadline goes up and down the chains first
    if ("date_deadline" in vals) await setDateDeadline(env, ids, vals["date_deadline"]);
    // :904-905 the moves leaving another source
    const checkLocation = "location_id" in vals ? (await env.cr.query<{ id: number }>(
      "SELECT id FROM stock_move WHERE id = ANY($1::int[]) AND location_id IS DISTINCT FROM $2", [[...ids], idOf(vals["location_id"])])).rows.map((r) => r.id)
      .sort((a, b) => ids.indexOf(a) - ids.indexOf(b)) : [];
    if ("product_id" in vals || "location_id" in vals || "location_dest_id" in vals) await updateOrderpoints(env, ids);
    await next(env, ids, vals);
    await recomputeState(env, recompute);
    if (checkLocation.length) reassign = [...reassign, ...await checkMoveLocation(env, checkLocation)];
    if ("location_id" in vals || "location_dest_id" in vals) await followWarehouse(env, ids);
    reassign = [...new Set(reassign)];
    if (reassign.length) await actionAssign(env, reassign);
    if (["product_id", "state", "date", "product_uom_qty", "location_id", "location_dest_id"].some((k) => k in vals)) await updateOrderpoints(env, ids);
  },
});

/**
 * sale_stock stock.py:205-224 `_reassign_sale_lines`: when the moves' sale lines belong to at most one order and it is
 * not the transfer's, each move takes the first line (by id, models.py:336 `array_agg ... ORDER BY id`) of the
 * transfer's order with its product, read as the user (`_read_group` applies the record rules); the others, or all of
 * them without an order, lose their line. Each assignment is a write on the move (fields.py:2024-2028).
 */
async function reassignSaleLines(env: Environment, moves: readonly number[], currentOrders: readonly number[], sale: number | null): Promise<void> {
  const same = sale === null ? currentOrders.length === 0 : currentOrders.length === 1 && currentOrders[0] === sale;
  if (currentOrders.length > 1 || same) return;
  const reset: number[] = [];
  if (sale === null) {
    reset.push(...moves);
  } else {
    const rows = (await env.cr.query<{ id: number; product_id: number | null }>(
      "SELECT id, product_id FROM stock_move WHERE id = ANY($1::int[]) ORDER BY id", [[...moves]])).rows;
    const products = [...new Set(rows.map((r) => r.product_id).filter((p): p is number => p !== null))];
    const visible = await env.model("sale.order.line").search(and([cond("order_id", "=", sale), cond("product_id", "in", products)]), { order: "id" });
    const lines = (await env.cr.query<{ id: number; product_id: number }>(
      "SELECT id, product_id FROM sale_order_line WHERE id = ANY($1::int[]) ORDER BY id", [visible])).rows;
    const firstByProduct = new Map<number, number>();
    for (const l of lines) if (!firstByProduct.has(l.product_id)) firstByProduct.set(l.product_id, l.id);
    for (const id of moves) {
      const product = rows.find((r) => r.id === id)?.product_id ?? null;
      const line = product === null ? undefined : firstByProduct.get(product);
      if (line !== undefined) await write(env, "stock.move", [id], { sale_line_id: line });
      else reset.push(id);
    }
  }
  // `self.env['stock.move'].browse(ids_to_reset)` of a set: ascending ids, as the reset writes them together
  if (reset.length) await write(env, "stock.move", [...reset].sort((a, b) => a - b), { sale_line_id: false });
}

// stock_picking.py create: the name from the sequence of the operation type
registerOverrides("stock.picking", {
  inverse: {
    // stock_picking.py:440-446 _set_scheduled_date: the moves follow the transfer (a write, so the moves' own write and
    // the fields depending on their date follow; the transfer's scheduled_date is protected by the caller)
    scheduled_date: async (env, ids) => {
      const rows = (await env.cr.query<{ id: number; state: string; scheduled_date: string | null }>(
        `SELECT id, state, to_char(scheduled_date, 'YYYY-MM-DD HH24:MI:SS') AS scheduled_date FROM stock_picking WHERE id = ANY($1::int[]) ORDER BY id`, [[...ids]])).rows;
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const id of ids) {
        const p = byId.get(id);
        if (!p) continue;
        if (p.state === "cancel") throw new UserError(translate(env, "You cannot change the Scheduled Date on a cancelled transfer.", "stock"));
        if (p.state === "done") continue;
        const moves = (await env.cr.query<{ id: number }>("SELECT id FROM stock_move WHERE picking_id = $1 ORDER BY sequence, id", [id])).rows.map((r) => r.id);
        if (moves.length) await write(env, "stock.move", moves, { date: p.scheduled_date });
      }
    },
    // sale_stock stock.py:285-300 `_set_sale_id`: the transfer's references (its first move's, the related
    // `move_ids.reference_ids`) get the order, or a new reference for the order goes on the moves; then the moves follow
    sale_id: async (env, ids) => {
      for (const id of ids) {
        const p = (await env.cr.query<{ sale_id: number | null }>("SELECT sale_id FROM stock_picking WHERE id = $1", [id])).rows[0];
        if (!p) continue;
        const moves = (await env.cr.query<{ id: number; order_id: number | null }>(
          "SELECT m.id, l.order_id FROM stock_move m LEFT JOIN sale_order_line l ON l.id = m.sale_line_id WHERE m.picking_id = $1 ORDER BY m.sequence, m.id", [id])).rows;
        const refs = moves.length ? (await env.cr.query<{ r: number }>("SELECT reference_id AS r FROM stock_reference_move_rel WHERE move_id = $1 ORDER BY reference_id", [moves[0]!.id])).rows.map((r) => r.r) : [];
        const orders = [...new Set(moves.map((m) => m.order_id).filter((o): o is number => o !== null))];
        if (refs.length) {
          if (p.sale_id) await write(env, "stock.reference", refs, { sale_ids: [[4, p.sale_id]] });
          else if (orders.length === 1) await write(env, "stock.reference", refs, { sale_ids: [[3, orders[0]]] });
        } else if (p.sale_id) {
          const name = (await env.cr.query<{ name: string }>("SELECT name FROM sale_order WHERE id = $1", [p.sale_id])).rows[0]?.name ?? false;
          const [reference] = await create(env.sudo(), "stock.reference", [{ sale_ids: [[4, p.sale_id]], name }]);
          // stock_picking.py:1949-1952 `_add_reference`
          if (moves.length) await write(env, "stock.move", moves.map((m) => m.id), { reference_ids: [[4, reference]] });
        }
        if (moves.length) await reassignSaleLines(env, moves.map((m) => m.id), orders, p.sale_id);
      }
    },
  },
  // stock_picking.py:682-721 write: a new operation type (refused on done or cancelled transfers) renames the
  // transfers of another type from its sequence and brings its default locations; after super, a new transfer date of
  // done transfers is their moves' date, and new locations or contact go to the moves (not those to an inventory
  // location). The batch, the signature and the moves' autoconfirmation are the guard's (src/orm/override_status.ts).
  write: async (env, ids, vals, next) => {
    if (vals["picking_type_id"]) {
      const rows = (await env.cr.query<{ id: number; state: string | null; picking_type_id: number | null }>(
        "SELECT id, state, picking_type_id FROM stock_picking WHERE id = ANY($1::int[])", [[...ids]])).rows;
      if (rows.some((r) => r.state === "done" || r.state === "cancel")) {
        throw new UserError(translate(env, "Changing the operation type of this record is forbidden at this point.", "stock"));
      }
      const typeId = idOf(vals["picking_type_id"]);
      const type = (await env.cr.query<{ seq: number | null; src: number | null; dst: number | null }>(
        "SELECT sequence_id AS seq, default_location_src_id AS src, default_location_dest_id AS dst FROM stock_picking_type WHERE id = $1", [typeId])).rows[0];
      if (!type) throw new NotPorted(`stock.picking write of the missing operation type ${JSON.stringify(vals["picking_type_id"])}`);
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const id of ids) {
        if (byId.get(id)?.picking_type_id === typeId) continue;
        // :692 `picking.name = picking_type.sequence_id.next_by_id()`
        if (!type.seq) throw new NotPorted("stock.picking new operation type without a sequence (next_by_id of no sequence)");
        const seq = (await env.cr.query<{ id: number; prefix: string | null; suffix: string | null; padding: number; implementation: string; use_date_range: boolean | null }>(
          "SELECT id, prefix, suffix, padding, implementation, use_date_range FROM ir_sequence WHERE id = $1", [type.seq])).rows[0]!;
        await write(env, "stock.picking", [id], { name: await nextOfSequence(env, seq, "stock.picking") });
        vals["location_id"] = type.src ?? false;
        vals["location_dest_id"] = type.dst ?? false;
      }
    }
    await next(env, ids, vals);
    if (vals["date_done"]) {
      // :703-704 `self.filtered(lambda p: p.state == 'done').move_ids.date = vals['date_done']`
      const moves = (await env.cr.query<{ id: number }>(
        `SELECT m.id FROM stock_picking p JOIN stock_move m ON m.picking_id = p.id WHERE p.id = ANY($1::int[]) AND p.state = 'done' AND NOT COALESCE(m.is_scrap, false)
          ORDER BY array_position($1::int[], p.id), m.sequence, m.id`, [[...ids]])).rows.map((r) => r.id);
      if (moves.length) await write(env, "stock.move", moves, { date: vals["date_done"] });
    }
    const after: Record<string, unknown> = {};
    if (vals["location_id"]) after["location_id"] = vals["location_id"];
    if (vals["location_dest_id"]) after["location_dest_id"] = vals["location_dest_id"];
    if ("partner_id" in vals) after["partner_id"] = vals["partner_id"];
    if (Object.keys(after).length) {
      // :716-717 `self.move_ids.filtered(lambda move: move.location_dest_usage != 'inventory').write(after_vals)`
      const moves = (await env.cr.query<{ id: number }>(
        `SELECT m.id FROM stock_picking p JOIN stock_move m ON m.picking_id = p.id JOIN stock_location d ON d.id = m.location_dest_id
          WHERE p.id = ANY($1::int[]) AND NOT COALESCE(m.is_scrap, false) AND d.usage IS DISTINCT FROM 'inventory'
          ORDER BY array_position($1::int[], p.id), m.sequence, m.id`, [[...ids]])).rows.map((r) => r.id);
      if (moves.length) await write(env, "stock.move", moves, after);
    }
  },
  // stock_picking.py:724-727 unlink, with stock_move.py :2458-2470 for moves without lines
  beforeUnlink: async (env, ids) => {
    const moves = (await env.cr.query<{ id: number; state: string }>("SELECT id, state FROM stock_move WHERE picking_id = ANY($1::int[])", [[...ids]])).rows;
    if (moves.some((m) => m.state === "done")) throw new NotPorted("stock.picking unlink with done moves");
    await refuseMoveLines(env, moves.map((m) => m.id), "unlink");
    // `move_ids.unlink()` as the user: models.py unlink's `check_access('unlink')` (a user without the right on
    // stock.move gets the AccessError, and the transfer stays)
    if (moves.length) await checkUnlinkAccess(env, env.reg.model("stock.move"), moves.map((m) => m.id));
    await env.cr.query("DELETE FROM stock_move WHERE id = ANY($1::int[])", [moves.map((m) => m.id)]);
  },
  create: async (env, valsList, next) => {
    for (const vals of valsList) {
      const type = idOf(vals["picking_type_id"]);
      if ((vals["name"] ?? "/") !== "/" || !type) continue;
      const seq = (await env.cr.query<{ id: number; prefix: string | null; suffix: string | null; padding: number; implementation: string; use_date_range: boolean | null }>(
        "SELECT s.id, s.prefix, s.suffix, s.padding, s.implementation, s.use_date_range FROM stock_picking_type t JOIN ir_sequence s ON s.id = t.sequence_id WHERE t.id = $1", [type])).rows[0];
      if (seq) vals["name"] = await nextOfSequence(env, seq, "stock.picking");
    }
    return next(env, valsList);
  },
});

// stock_lot.py:173-176 _compute_single_location; the inverse moves quants, which a new lot does not have
registerRecordCompute("stock.lot", {
  location_id: async (env, rec) => {
    if (rec.origin === null) return null;
    const rows = (await env.cr.query<{ l: number }>("SELECT DISTINCT location_id AS l FROM stock_quant WHERE lot_id = $1 AND quantity > 0", [rec.origin])).rows;
    return rows.length === 1 ? rows[0]!.l : null;
  },
  lot_properties: async (_env, rec) => rec.prev("lot_properties"),
});
registerOverrides("stock.lot", {
  inverse: {
    location_id: async (env, ids) => {
      if ((await env.cr.query("SELECT 1 FROM stock_quant WHERE lot_id = ANY($1::int[]) AND quantity > 0 LIMIT 1", [[...ids]])).rows.length) throw new NotPorted("stock.lot location_id inverse (move_quants)");
    },
  },
  // stock_account stock_lot.py:49-56 create: a lot valuated on its own starts at the product's cost
  create: async (env, valsList, next) => {
    const ids = await next(env, valsList);
    for (const id of ids) {
      const lot = new DbRec(env, env.reg.model("stock.lot"), id);
      if (Number((await lot.get("standard_price")) ?? 0)) continue;
      const product = await lot.rel("product_id");
      if (product && (await product.get("lot_valuated"))) await write(env.withContext({ ...env.context, disable_auto_revaluation: true }), "stock.lot", [id], { standard_price: await product.get("standard_price") });
    }
    return ids;
  },
});

/** stock_picking_type.py default locations: the warehouse's stock, or the partner locations of the operation's far end. */
async function typeLocation(env: Environment, rec: Rec, far: string, xmlid: string): Promise<number | null> {
  if ((await rec.get("code")) === far) return env.reg.xmlid(env.cr, xmlid);
  const warehouse = await rec.rel("warehouse_id");
  if (!warehouse) throw new NotPorted("stock.picking.type without a warehouse (_warehouse_redirect_warning)");
  return idOf(await warehouse.get("lot_stock_id"));
}
registerRecordCompute("stock.picking.type", {
  // :503-509 _compute_warehouse_id
  warehouse_id: async (env, rec) => {
    const current = await rec.prev("warehouse_id");
    if (current) return current;
    const company = idOf(await rec.get("company_id"));
    if (!company) return null;
    return (await env.sudo().model("stock.warehouse").search(parseDomain([["company_id", "=", company]])))[0] ?? null;
  },
  // :464-484
  default_location_src_id: (env, rec) => typeLocation(env, rec, "incoming", "stock.stock_location_suppliers"),
  default_location_dest_id: (env, rec) => typeLocation(env, rec, "outgoing", "stock.stock_location_customers"),
  // :437-447 _compute_use_create_lots, _compute_use_existing_lots: only set for the matching code
  use_create_lots: async (_env, rec) => ((await rec.get("code")) === "incoming" ? true : rec.prev("use_create_lots")),
  use_existing_lots: async (_env, rec) => ((await rec.get("code")) === "outgoing" ? true : rec.prev("use_existing_lots")),
  // project_stock_account stock_picking_type.py
  analytic_costs: async () => false,
});

/** ir_sequence.py create: the row and its PostgreSQL sequence (the ir.sequence override, src/models/company_create.ts). */
async function createSequence(env: Environment, name: string, company: unknown): Promise<number> {
  const [id] = await create(env.sudo(), "ir.sequence", [{ name, padding: 5, company_id: company }]);
  return id!;
}

// stock_picking_type.py:277-293 create
registerOverrides("stock.picking.type", {
  create: async (env, valsList, next) => {
    for (const vals of valsList) {
      if (vals["sequence_id"] || !vals["sequence_code"]) continue;
      const warehouse = idOf(vals["warehouse_id"]);
      if (warehouse) throw new NotPorted("stock.picking.type sequence named after the warehouse");
      vals["sequence_id"] = await createSequence(env, translate(env, "Sequence %(code)s").replace("%(code)s", String(vals["sequence_code"])), idOf(vals["company_id"]) ?? await env.company());
    }
    return next(env, valsList);
  },
  inverse: {
    // :_inverse_batch_creation_type of the field's default
    batch_creation_type: async () => undefined,
    is_favorite: async (env, ids) => {
      if (ids.length) throw new NotPorted("stock.picking.type is_favorite inverse");
    },
  },
});
