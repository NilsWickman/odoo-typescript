/**
 * The stock move engine (odoo/addons/stock/models/stock_move.py, stock_move_line.py, stock_quant.py, stock_picking.py)
 * for single-step operations without lots, packages, owners, chained moves or procurements:
 * `_action_confirm` (:1773-1866), `_assign_picking` (:1629-1660), `_action_assign` (:2138-2274) with the quant
 * reservation (`_update_reserved_quantity_vals` :2000-2045, stock_quant.py `_get_reserve_quantity` :866-946,
 * `_update_available_quantity` :1070-1137), `_recompute_state` (:2534-2553), `_update_orderpoints` (:944-963) and
 * picking `action_confirm` (stock_picking.py:768-785). Everything else refuses with NotPorted.
 */
import { NotPorted, UserError } from "../errors";
import { computeAuthor, insertMessages, replyToDefault, trackingMessageId, xmlid } from "../mail/message";
import { flatThreadParent } from "../mail/thread_generic";
import { create } from "../orm/create";
import { floatRound } from "../orm/convert";
import { parseDomain } from "../orm/domain";
import { envTz, hasGroup } from "../orm/env";
import { DbRec, RecomputeQueue, registerRecordCompute } from "../orm/recompute";
import { registerHooks } from "../orm/hooks";
import type { Environment } from "../orm/types";
import { registerOverrides, write } from "../orm/write";
import { uomQuantity } from "./sale_flow";
import { defineComputes } from "./tail_util";
import { relevantState } from "./stock_states";
import { datetimeToString, dbNow, todayInTz, translate } from "./util";

type Row = Record<string, unknown>;
const ids = (rows: { id: number }[]): number[] => rows.map((r) => r.id);

async function rows<T extends object = Record<string, unknown>>(env: Environment, text: string, params: unknown[]): Promise<T[]> {
  return (await env.cr.query<T & Record<string, unknown>>(text, params)).rows;
}

/** fields.Date.context_today: the user's day. */
export async function contextToday(env: Environment): Promise<string> {
  return todayInTz(await dbNow(env), await envTz(env));
}

/** fields.Datetime.now(): the transaction clock without microseconds. */
export async function nowString(env: Environment): Promise<string> {
  return datetimeToString(await dbNow(env));
}

/** decimal.precision 'Product Unit'. */
export async function unitDigits(env: Environment): Promise<number> {
  return (await rows<{ digits: number }>(env, "SELECT digits FROM decimal_precision WHERE name = 'Product Unit'", []))[0]?.digits ?? 2;
}

/** uom_uom.py `compare` and `is_zero` (both values rounded to the 'Product Unit' precision). */
export async function uomCompare(env: Environment, a: number, b: number): Promise<number> {
  const d = await unitDigits(env);
  const x = floatRound(a, d), y = floatRound(b, d);
  return x === y ? 0 : x < y ? -1 : 1;
}

/** stock_location.py:407-409 `should_bypass_reservation`. */
async function bypassLocation(env: Environment, location: number): Promise<boolean> {
  const usage = (await rows<{ u: string }>(env, "SELECT usage AS u FROM stock_location WHERE id = $1", [location]))[0]?.u;
  return ["supplier", "customer", "inventory", "production"].includes(String(usage));
}

interface MoveRow {
  id: number; state: string; product_id: number; uom_id: number; product_uom: number; product_uom_qty: number; product_qty: number; quantity: number;
  location_id: number; location_dest_id: number; picking_id: number | null; picking_type_id: number | null; company_id: number; procure_method: string;
  rule_id: number | null; partner_id: number | null; origin: string | null; priority: string; picked: boolean; storable: boolean; tracking: string;
  orig: number; dests: number; origin_returned_move_id: number | null; reservation_date: string | null; reservation_method: string | null; date: string;
  /** the picking type's `use_create_lots or use_existing_lots` */
  lots_on_type: boolean;
}

export async function moveRows(env: Environment, moveIds: readonly number[]): Promise<MoveRow[]> {
  const out = await rows<MoveRow>(env,
    `SELECT m.id, m.state, m.product_id, m.uom_id, t.uom_id AS product_uom, m.product_uom_qty::float8 AS product_uom_qty, m.product_qty::float8 AS product_qty,
            COALESCE(m.quantity, 0)::float8 AS quantity, m.location_id, m.location_dest_id, m.picking_id, m.picking_type_id, m.company_id, m.procure_method,
            m.rule_id, m.partner_id, m.origin, COALESCE(m.priority, '0') AS priority, COALESCE(m.picked, false) AS picked, COALESCE(t.is_storable, false) AS storable,
            COALESCE(t.tracking, 'none') AS tracking,
            (SELECT count(*)::int FROM stock_move_move_rel r WHERE r.move_dest_id = m.id) AS orig,
            (SELECT count(*)::int FROM stock_move_move_rel r WHERE r.move_orig_id = m.id) AS dests,
            m.origin_returned_move_id, m.reservation_date::text AS reservation_date, pt.reservation_method, m.date::text AS date,
            COALESCE(pt.use_create_lots, false) OR COALESCE(pt.use_existing_lots, false) AS lots_on_type
       FROM stock_move m JOIN product_product p ON p.id = m.product_id JOIN product_template t ON t.id = p.product_tmpl_id
       LEFT JOIN stock_picking_type pt ON pt.id = m.picking_type_id
      WHERE m.id = ANY($1::int[])`, [[...moveIds]]);
  const byId = new Map(out.map((r) => [r.id, r]));
  return moveIds.map((id) => byId.get(id)).filter((r): r is MoveRow => r !== undefined);
}

async function referencesOf(env: Environment, move: number): Promise<number[]> {
  return (await rows<{ r: number }>(env, "SELECT reference_id AS r FROM stock_reference_move_rel WHERE move_id = $1 ORDER BY reference_id", [move])).map((r) => r.r);
}

/** stock_move.py:944-963 `_update_orderpoints`: the orderpoints of the moves' products in their warehouses get `qty_to_order_computed` again. */
export async function updateOrderpoints(env: Environment, moveIds: readonly number[]): Promise<void> {
  await recomputeOrderpoints(env, await orderpointsToUpdate(env, moveIds));
}

/** The orderpoints' `qty_to_order_computed` again (as superuser). */
export async function recomputeOrderpoints(env: Environment, points: readonly number[]): Promise<void> {
  if (!points.length) return;
  const queue = new RecomputeQueue(env.sudo());
  queue.add("stock.warehouse.orderpoint", "qty_to_order_computed", [...points]);
  await queue.run();
}

/** stock_move.py:954-963 `_get_orderpoints_to_update`: the active orderpoints of the moves' products in their warehouses. */
export async function orderpointsToUpdate(env: Environment, moveIds: readonly number[]): Promise<number[]> {
  if (!moveIds.length) return [];
  const moves = await rows<{ product_id: number; src: number | null; dst: number | null }>(env,
    `SELECT m.product_id, ls.warehouse_id AS src, ld.warehouse_id AS dst FROM stock_move m
       LEFT JOIN stock_location ls ON ls.id = m.location_id LEFT JOIN stock_location ld ON ld.id = m.location_dest_id WHERE m.id = ANY($1::int[]) ORDER BY m.id`, [[...moveIds]]);
  const domains: unknown[][] = moves.map((m) => {
    const wh = [m.src, m.dst].filter((w): w is number => w !== null);
    return wh.length ? ["&", ["product_id", "=", m.product_id], ["warehouse_id", "in", wh]] : [["product_id", "=", m.product_id]];
  });
  const domain: unknown[] = [];
  for (let i = 0; i < domains.length - 1; i++) domain.push("|");
  for (const d of domains) domain.push(...d);
  const su = env.sudo();
  return su.withContext({ ...su.context, active_test: true }).model("stock.warehouse.orderpoint").search(parseDomain(domain), { order: "id" });
}

/** stock_move.py:2534-2553 `_recompute_state`. */
export async function recomputeState(env: Environment, moveIds: readonly number[]): Promise<void> {
  if (env.context["preserve_state"] || !moveIds.length) return;
  const su = env.sudo();
  const moveDef = env.reg.model("stock.move");
  const byState = new Map<string, number[]>();
  for (const id of moveIds) {
    const m = new DbRec(su, moveDef, id);
    const curState = String((await m.get("state")) ?? "");
    const qty = Number((await m.get("quantity")) ?? 0);
    if (curState === "cancel" || curState === "done" || (curState === "draft" && !qty)) continue;
    const demand = Number((await m.get("product_uom_qty")) ?? 0);
    let state: string;
    if ((await uomCompare(env, qty, demand)) >= 0) state = "assigned";
    else if (qty && (await uomCompare(env, qty, demand)) <= 0) state = "partially_available";
    else {
      const procureMethod = String((await m.get("procure_method")) ?? "");
      const origs = await m.rels("move_orig_ids");
      if (procureMethod === "make_to_order" && !origs.length) {
        state = "waiting";
      } else if (origs.length) {
        let anyOpen = false;
        for (const o of origs) {
          const oState = String((await o.get("state")) ?? "");
          const oQty = Number((await o.get("product_uom_qty")) ?? 0);
          if (oQty > 0 && oState !== "done" && oState !== "cancel") { anyOpen = true; break; }
        }
        state = anyOpen ? "waiting" : "confirmed";
      } else {
        state = "confirmed";
      }
    }
    if (state !== curState) byState.set(state, [...(byState.get(state) ?? []), id]);
  }
  for (const [state, list] of byState) await write(env, "stock.move", list, { state });
}

/**
 * sale_project_stock stock_move.py:60-70: `self.sale_line_id.order_id.project_id` of the moves (the first move's for
 * `_assign_picking_values`); null without the module or without a project. Several projects across the moves of one
 * new transfer refuse (Odoo's `.id` of several records raises).
 */
async function saleProjectOf(env: Environment, moveIds: readonly number[], first: boolean): Promise<number | null | undefined> {
  if (!env.reg.model("stock.picking").fields.has("project_id") || !env.reg.model("stock.move").fields.has("sale_line_id")) return undefined;
  const ids = first ? moveIds.slice(0, 1) : moveIds;
  const projects = (await rows<{ p: number | null }>(env,
    `SELECT DISTINCT o.project_id AS p FROM stock_move m JOIN sale_order_line l ON l.id = m.sale_line_id JOIN sale_order o ON o.id = l.order_id
      WHERE m.id = ANY($1::int[]) AND o.project_id IS NOT NULL`, [[...ids]])).map((r) => r.p);
  if (projects.length > 1) throw new NotPorted("stock.move._get_new_picking_values with moves of several sale projects");
  return projects[0] ?? null;
}

/** stock_move.py:1740-1767 `_get_new_picking_values`. */
async function newPickingValues(env: Environment, moves: MoveRow[]): Promise<Row> {
  const origins = [...new Set(moves.map((m) => m.origin).filter((o): o is string => Boolean(o)))];
  let origin: string | false = false;
  if (origins.length) origin = origins.slice(0, 5).join(",") + (origins.length > 5 ? "..." : "");
  const partners = [...new Set(moves.map((m) => m.partner_id).filter((p): p is number => p !== null))];
  const ctxPartner = env.context["move_picking_partner_id"];
  const companies = [...new Set(moves.map((m) => m.company_id))];
  const types = [...new Set(moves.map((m) => m.picking_type_id).filter((p): p is number => p !== null))];
  const sources = [...new Set(moves.map((m) => m.location_id))];
  const dests = [...new Set(moves.map((m) => m.location_dest_id))];
  if (companies.length > 1 || types.length > 1 || sources.length > 1 || dests.length > 1) throw new NotPorted("stock.move._get_new_picking_values over several companies, types or locations (ensure_one)");
  const vals: Row = {
    origin, company_id: companies[0], user_id: false,
    partner_id: ctxPartner !== undefined ? ctxPartner : partners.length === 1 ? partners[0] : false,
    picking_type_id: types[0] ?? false, priority: moves.some((m) => m.priority === "1") ? "1" : "0", location_id: sources[0],
  };
  if (dests.length) vals["location_dest_id"] = dests[0];
  // sale_project_stock stock_move.py:60-64: the sale order's project, when the values have none
  const project = await saleProjectOf(env, moves.map((m) => m.id), false);
  if (project) vals["project_id"] = project;
  return vals;
}

/** stock_move.py:1629-1660 `_assign_picking` (one group of moves sharing their key). */
async function assignPicking(env: Environment, moves: MoveRow[]): Promise<void> {
  const groups = new Map<string, MoveRow[]>();
  for (const m of moves) {
    // :1595-1600 `_key_assign_picking`: without references, the origin moves' transfers too
    const refs = await referencesOf(env, m.id);
    const origPickings = !refs.length && m.orig ? (await rows<{ p: number }>(env,
      "SELECT DISTINCT o.picking_id AS p FROM stock_move_move_rel r JOIN stock_move o ON o.id = r.move_orig_id WHERE r.move_dest_id = $1 AND o.picking_id IS NOT NULL ORDER BY 1", [m.id])).map((r) => r.p) : [];
    const key = JSON.stringify([refs, m.location_id, m.location_dest_id, m.picking_type_id, m.priority, origPickings]);
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  for (const group of groups.values()) {
    const first = group[0]!;
    // :1602-1627 `_search_picking_for_assignation`
    let picking: number | null = null;
    const refs = await referencesOf(env, first.id);
    if (refs.length) {
      const destDefault: number | null = first.location_dest_id ?? (await rows<{ d: number | null }>(env, "SELECT default_location_dest_id AS d FROM stock_picking_type WHERE id = $1", [first.picking_type_id]))[0]?.d ?? null;
      const domain: unknown[] = [["reference_ids", "in", refs], ["location_id", "=", first.location_id], ["location_dest_id", "=", destDefault],
        ["picking_type_id", "=", first.picking_type_id], ["printed", "=", false], ["state", "in", ["draft", "confirmed", "waiting", "partially_available", "assigned"]]];
      if (first.partner_id) {
        // :1736-1738 `_get_picking_partner`: no picking yet, so the context's partner or the move's
        const ctx = env.context["move_picking_partner_id"];
        domain.push(["partner_id", "=", typeof ctx === "number" ? ctx : first.partner_id]);
      }
      picking = (await env.model("stock.picking").search(parseDomain(domain), { limit: 1 }))[0] ?? null;
    }
    let targets = group;
    let isNew = false;
    if (picking !== null) {
      // :1662-1672 `_assign_picking_values`
      const [p] = await rows<{ partner_id: number | null; origin: string | null }>(env, "SELECT partner_id, origin FROM stock_picking WHERE id = $1", [picking]);
      const vals: Row = {};
      if (group.some((m) => (p!.partner_id ?? null) !== (m.partner_id ?? null))) vals["partner_id"] = false;
      if (group.some((m) => (p!.origin ?? false) !== (m.origin ?? false))) {
        const current = p!.origin ? p!.origin.split(",") : [];
        const merged = [...new Set([...current, ...group.map((m) => m.origin).filter((o): o is string => Boolean(o))])].join(",");
        if (p!.origin !== merged) vals["origin"] = merged;
      }
      // sale_project_stock stock_move.py:66-70: `project_id` of the first move's sale order is always in the values,
      // so the transfer is always written (its project, False without one)
      const project = await saleProjectOf(env, group.map((m) => m.id), true);
      if (project !== undefined) vals["project_id"] = project ?? false;
      if (Object.keys(vals).length) await write(env, "stock.picking", [picking], vals);
    } else {
      const digits = await unitDigits(env);
      targets = group.filter((m) => floatRound(m.product_uom_qty, digits) >= 0);
      if (!targets.length) continue;
      picking = (await create(env, "stock.picking", [await newPickingValues(env, targets)]))[0]!;
      isNew = true;
    }
    await write(env, "stock.move", targets.map((m) => m.id), { picking_id: picking });
    // the transfer's one2many `move_ids` changed with the moves' picking_id (models.py `modified` through the inverse):
    // its computes on `move_ids.*` (sale_id, date_deadline, ...) follow
    const queue = new RecomputeQueue(env.sudo());
    await queue.modified("stock.picking", [picking!], ["move_ids"]);
    await queue.run();
    // :1674-1678 `_assign_picking_post_process` with sale_stock stock.py:176-186: a new transfer notes its sale orders
    if (await hasGroup(env, "stock.group_stock_picking_batch")) throw new NotPorted("stock.picking._find_auto_batch");
    if (isNew) {
      const sales = (await rows<{ o: number }>(env,
        "SELECT DISTINCT l.order_id AS o FROM stock_move m JOIN sale_order_line l ON l.id = m.sale_line_id WHERE m.id = ANY($1::int[]) ORDER BY l.order_id", [targets.map((m) => m.id)])).map((r) => r.o);
      for (const so of sales) await postOriginLink(env, "stock.picking", [picking!], { model: "sale.order", id: so });
    }
    // :828-831 `_set_references` (write of picking_id)
    for (const m of targets) {
      if ((await referencesOf(env, m.id)).length) continue;
      throw new NotPorted("stock.move._set_references from the picking's references");
    }
  }
}

/**
 * stock_move.py `write` (:872-889) of a new demand on moves of a transfer that is not draft or done: the
 * `stock.track_move_template` note (stock_template.xml `message_head`, `message_body`) through `_log_message`
 * (stock_move_line.py `_log_message`, message_post_with_source with mt_note).
 */
export async function logDemandChange(env: Environment, moveId: number, newQty: number): Promise<void> {
  const [m] = await rows<{ picking_id: number | null; state: string; product_id: number; qty: number }>(env,
    "SELECT picking_id, state, product_id, product_uom_qty::float8 AS qty FROM stock_move WHERE id = $1", [moveId]);
  if (!m!.picking_id || ["done", "draft"].includes(m!.state)) return;
  if ((await uomCompare(env, newQty, m!.qty)) === 0) return;
  const display = (await env.model("product.product").displayName([m!.product_id])).get(m!.product_id) ?? "";
  const [head, qtyLabel, arrow] = await demandTemplateTerms(env);
  const body = `<div>\n            <strong>${head}</strong>\n        <ul>\n            <li>\n                ${escAttr(display)}:\n            </li>\n`
    + `                    <li>\n                        ${qtyLabel} ${pyFloat(m!.qty)} ${arrow} ${pyFloat(newQty)}\n                    </li>\n        </ul>\n        </div>`;
  await postNote(env, "stock.picking", m!.picking_id, body);
}

/**
 * The words of stock.message_head and stock.message_body (stock_template.xml) as rendered in the environment's
 * language: the views' arch_db translation (Odoo renders the QWeb view in `env.lang`, mail.render.mixin
 * `_render_template_qweb_view`), else en_US, as the arch keeps them (escaped). Before round 11 another language refused.
 */
async function demandTemplateTerms(env: Environment): Promise<[string, string, string]> {
  const lang = env.lang ?? "en_US";
  const arch = async (name: string): Promise<string> => (await rows<{ a: string | null }>(env,
    `SELECT COALESCE(v.arch_db->>$1, v.arch_db->>'en_US') AS a FROM ir_ui_view v JOIN ir_model_data d ON d.model = 'ir.ui.view' AND d.res_id = v.id
      WHERE d.module = 'stock' AND d.name = $2`, [lang, name]))[0]?.a ?? "";
  const head = /<t t-if="move\.state != 'done'">\s*<strong>([^<]*)<\/strong>/.exec(await arch("message_head"));
  const qty = /<t t-if="'product_uom_qty' in vals">\s*<li>([^<]*)<t t-out="move\.product_uom_qty"\/>([^<]*)<t t-out="float\(vals\.get\('product_uom_qty'\)\)"\/>/.exec(await arch("message_body"));
  if (!head || !qty) throw new NotPorted(`stock.track_move_template in ${lang} (message_head/message_body arch)`);
  return [head[1]!.trim(), qty[1]!.trim(), qty[2]!.trim()];
}

/** Python's `str(float)` for the quantities the templates print. */
export function pyFloat(v: number): string {
  if (!Number.isFinite(v)) throw new NotPorted("str() of a non-finite float");
  if (Number.isInteger(v) && Math.abs(v) < 1e16) return `${v}.0`;
  const s = String(v);
  if (/e/.test(s)) throw new NotPorted("str() of a float in exponent notation");
  return s;
}

/** A boolean `ir.config_parameter` (`get_bool`): set and not a false-like text. */
async function configBool(env: Environment, key: string): Promise<boolean> {
  const [r] = await rows<{ v: string }>(env, "SELECT value AS v FROM ir_config_parameter WHERE key = $1", [key]);
  return Boolean(r && !["", "0", "false", "False"].includes(r.v.trim()));
}

/**
 * stock_move.py:1082-1108 `_do_unreserve`: the lines of the moves that are not picked are unlinked (their unlink frees the
 * quants and recomputes the moves' state), the moves without picked lines get `_recompute_state`.
 */
export async function doUnreserve(env: Environment, moveIds: readonly number[]): Promise<void> {
  if (!moveIds.length) return;
  const moves = await rows<{ id: number; state: string; picked: boolean; usage: string | null }>(env,
    `SELECT m.id, m.state, COALESCE(m.picked, false) AS picked, d.usage FROM stock_move m LEFT JOIN stock_location d ON d.id = m.location_dest_id WHERE m.id = ANY($1::int[])`, [[...moveIds]]);
  const byId = new Map(moves.map((m) => [m.id, m]));
  const todo: number[] = [];
  for (const id of moveIds) {
    const m = byId.get(id);
    if (!m || m.state === "cancel" || (m.state === "done" && m.usage === "inventory") || m.picked) continue;
    if (m.state === "done") throw new UserError(translate(env, "You cannot unreserve a stock move that has been set to 'Done'.", "stock"));
    if (!todo.includes(id)) todo.push(id);
  }
  if (!todo.length) return;
  const lines = await rows<{ id: number; move_id: number; picked: boolean }>(env,
    "SELECT id, move_id, COALESCE(picked, false) AS picked FROM stock_move_line WHERE move_id = ANY($1::int[]) ORDER BY id", [todo]);
  const keep = new Set(lines.filter((l) => l.picked).map((l) => l.move_id));
  const drop = lines.filter((l) => !l.picked).map((l) => l.id);
  if (drop.length) {
    const { unlink } = await import("../orm/unlink");
    await unlink(env, "stock.move.line", drop);
  }
  await recomputeState(env, todo.filter((m) => !keep.has(m)));
}

/**
 * stock_move.py:2276-2322 `_action_cancel` of moves without chains (no move_dest_ids/move_orig_ids to propagate to),
 * `_log_cancel_activity` being empty in the installed modules.
 */
export async function cancelMoves(env: Environment, moveIds: readonly number[]): Promise<void> {
  if (!moveIds.length) return;
  const moves = await rows<{ id: number; state: string; usage: string | null; orig: number; dests: number; batch: number | null }>(env,
    `SELECT m.id, m.state, d.usage, (SELECT count(*)::int FROM stock_move_move_rel r WHERE r.move_dest_id = m.id) AS orig,
            (SELECT count(*)::int FROM stock_move_move_rel r WHERE r.move_orig_id = m.id) AS dests, p.batch_id AS batch
       FROM stock_move m LEFT JOIN stock_location d ON d.id = m.location_dest_id LEFT JOIN stock_picking p ON p.id = m.picking_id WHERE m.id = ANY($1::int[])`, [[...moveIds]]);
  if (moves.some((m) => m.state === "done" && m.usage !== "inventory")) {
    throw new UserError(translate(env, "You cannot cancel a stock move that has been set to 'Done'. Create a return in order to reverse the moves which took place.", "stock"));
  }
  const byId = new Map(moves.map((m) => [m.id, m]));
  const todo = moveIds.filter((id) => { const m = byId.get(id); return m && m.state !== "cancel" && !(m.state === "done" && m.usage === "inventory"); });
  if (todo.some((id) => byId.get(id)!.orig || byId.get(id)!.dests)) throw new NotPorted("stock.move._action_cancel of chained moves (propagate_cancel)");
  if (todo.some((id) => byId.get(id)!.batch)) throw new NotPorted("stock.move._action_cancel in a batch transfer");
  if (!todo.length) return;
  await write(env, "stock.move", todo, { picked: false });
  await doUnreserve(env, todo);
  await write(env, "stock.move", todo, { state: "cancel" });
  await write(env, "stock.move", todo, { move_orig_ids: [[5, 0, 0]], procure_method: "make_to_stock" });
}

interface MergeRow {
  id: number; state: string; picking_id: number | null; sequence: number | null; product_id: number; price_unit: number | null; procure_method: string; location_id: number;
  location_dest_id: number; forecasted_location_id: number | null; uom_id: number; restrict_partner_id: number | null; origin_returned_move_id: number | null;
  propagate_cancel: boolean | null; date_deadline: string | null; date: string; sale_line_id: number | null; purchase_line_id: number | null; product_uom_qty: number;
  product_qty: number; picked: boolean; origin: string | null; company_id: number; move_type: string | null; never: number[]; created: number[]; dests: number[]; origs: number[];
}

async function mergeRows(env: Environment, moveIds: readonly number[]): Promise<MergeRow[]> {
  const f = env.reg.model("stock.move").fields;
  // sale_stock's sale_line_id and purchase_stock's purchase_line_id/created_purchase_line_ids exist with their modules
  const sale = f.has("sale_line_id") ? "m.sale_line_id" : "NULL::int";
  const purchase = f.has("purchase_line_id") ? "m.purchase_line_id" : "NULL::int";
  const created = f.has("created_purchase_line_ids") ? "ARRAY(SELECT r.created_purchase_line_id FROM stock_move_created_purchase_line_rel r WHERE r.move_id = m.id ORDER BY 1)" : "ARRAY[]::int[]";
  const out = await rows<MergeRow>(env,
    `SELECT m.id, m.state, m.picking_id, m.sequence, m.product_id, m.price_unit::float8 AS price_unit, m.procure_method, m.location_id, m.location_dest_id,
            m.forecasted_location_id, m.uom_id, m.restrict_partner_id, m.origin_returned_move_id, m.propagate_cancel,
            to_char(m.date_deadline, 'YYYY-MM-DD HH24:MI:SS') AS date_deadline, to_char(m.date, 'YYYY-MM-DD HH24:MI:SS') AS date, ${sale} AS sale_line_id, ${purchase} AS purchase_line_id,
            m.product_uom_qty::float8 AS product_uom_qty, m.product_qty::float8 AS product_qty, COALESCE(m.picked, false) AS picked, m.origin, m.company_id, p.move_type,
            ARRAY(SELECT r.template_attribute_value_id FROM template_attribute_value_stock_move_rel r WHERE r.move_id = m.id ORDER BY 1) AS never,
            ${created} AS created,
            ARRAY(SELECT r.move_dest_id FROM stock_move_move_rel r WHERE r.move_orig_id = m.id ORDER BY 1) AS dests,
            ARRAY(SELECT r.move_orig_id FROM stock_move_move_rel r WHERE r.move_dest_id = m.id ORDER BY 1) AS origs
       FROM stock_move m LEFT JOIN stock_picking p ON p.id = m.picking_id WHERE m.id = ANY($1::int[])`, [[...moveIds]]);
  const byId = new Map(out.map((r) => [r.id, r]));
  return moveIds.map((id) => byId.get(id)).filter((r): r is MergeRow => r !== undefined);
}

/**
 * stock_move.py:1396-1476 `_merge_moves` (no merge_into): each move's transfer's moves grouped by the distinct fields
 * (:1349-1362 with sale_stock's `sale_line_id`, purchase_stock's `purchase_line_id`/`created_purchase_line_ids`;
 * `odoo.tools.misc.groupby` over `picking.move_ids` in `sequence, id` order) are merged into the first;
 * negative moves are absorbed by the positive move of the same limited key. Returns `(self | merged) - unlinked`.
 */
export async function mergeMoves(env: Environment, moveIds: readonly number[]): Promise<number[]> {
  if ((await rows(env, "SELECT 1 FROM ir_module_module WHERE name = 'mrp' AND state IN ('installed', 'to upgrade') LIMIT 1", [])).length) {
    throw new NotPorted("stock.move._merge_moves with mrp (_update_candidate_moves_list, created_production_id)");
  }
  if (env.context["merge_extra"]) throw new NotPorted("stock.move._merge_moves with merge_extra");
  const self = await mergeRows(env, moveIds);
  const pickings = [...new Set(self.map((m) => m.picking_id).filter((p): p is number => p !== null))];
  const candidateSets: number[][] = [];
  for (const p of pickings) candidateSets.push((await rows<{ id: number }>(env, "SELECT id FROM stock_move WHERE picking_id = $1 ORDER BY sequence, id", [p])).map((r) => r.id));
  const sameDate = await configBool(env, "stock.merge_only_same_date");
  const withDeadline = !(await configBool(env, "stock.merge_ignore_date_deadline"));
  const allIds = [...new Set([...moveIds, ...candidateSets.flat()])];
  const all = new Map((await mergeRows(env, allIds)).map((m) => [m.id, m]));
  // description_picking (not stored, `_compute_description_picking`) through the ORM
  const descriptions = new Map<number, unknown>();
  for (const r of await env.sudo().model("stock.move").read(allIds, ["description_picking"], "")) descriptions.set(Number(r["id"]), r["description_picking"] ?? false);
  // :1383-1387 price_unit compared at min(company currency decimals, 'Product Price') digits
  const [pp] = await rows<{ d: number }>(env, "SELECT digits AS d FROM decimal_precision WHERE name = 'Product Price'", []);
  const companies = [...new Set([...all.values()].map((m) => m.company_id))];
  const [cur] = await rows<{ d: number | null }>(env,
    `SELECT min(GREATEST(0, CEIL(LOG(1 / c.rounding::float8))))::int AS d FROM res_company co JOIN res_currency c ON c.id = co.currency_id WHERE co.id = ANY($1::int[])`, [companies]);
  const priceDigits = cur?.d !== null && cur?.d !== undefined ? Math.min(cur.d, pp?.d ?? 2) : pp?.d ?? 2;
  const key = (m: MergeRow, negative: boolean): string => JSON.stringify([
    m.product_id, floatRound(m.price_unit ?? 0, priceDigits).toFixed(priceDigits), m.procure_method, m.location_id, m.location_dest_id, m.forecasted_location_id ?? false,
    m.uom_id, m.restrict_partner_id ?? false, m.origin_returned_move_id ?? false, Boolean(m.propagate_cancel), negative ? null : descriptions.get(m.id) ?? false, m.never,
    sameDate ? m.date : null, withDeadline ? m.date_deadline ?? false : null, m.sale_line_id ?? false, m.purchase_line_id ?? false, negative ? null : m.created,
  ]);
  const digits = await unitDigits(env);
  const toUnlink: number[] = [];
  const merged: number[] = [];
  const toCancel: number[] = [];
  const byNegKey = new Map<string, number[]>();
  const neg = self.filter((m) => floatRound(m.product_qty, digits) < 0).map((m) => m.id);
  // :1424 the negative moves leave their transfer before being absorbed
  if (neg.length) await write(env, "stock.move", neg, { picking_id: false });
  for (const set of candidateSets) {
    const candidates = set.map((id) => all.get(id)!).filter((m) => !["done", "cancel", "draft"].includes(m.state) && !neg.includes(m.id));
    // odoo.tools.misc.groupby: every move of a key, the groups in the order of their first move
    const groups = new Map<string, MergeRow[]>();
    for (const m of candidates) { const k = key(m, false); groups.set(k, [...(groups.get(k) ?? []), m]); }
    for (const group of groups.values()) {
      if (group.length > 1) {
        const head = group[0]!;
        const lines = (await rows<{ id: number }>(env, "SELECT id FROM stock_move_line WHERE move_id = ANY($1::int[]) ORDER BY id", [group.map((m) => m.id)])).map((r) => r.id);
        if (lines.length) await write(env, "stock.move.line", lines, { move_id: head.id });
        // :1334-1346 `_merge_moves_fields`
        const origins = [...new Set(group.map((m) => m.origin).filter((o): o is string => Boolean(o)))];
        if (origins.length > 1) throw new NotPorted("stock.move._merge_moves_fields of several origins ('/'.join of a set)");
        const direct = group.every((m) => m.picking_id === null || m.move_type === "direct");
        const dates = group.map((m) => m.date).sort();
        let qty = 0;
        for (const m of group) qty += m.product_uom_qty;
        await write(env, "stock.move", [head.id], {
          product_uom_qty: qty, date: direct ? dates[0] : dates[dates.length - 1],
          move_dest_ids: [...new Set(group.flatMap((m) => m.dests))].map((d) => [4, d]), move_orig_ids: [...new Set(group.flatMap((m) => m.origs))].map((o) => [4, o]),
          state: relevantState(group.map((m) => ({ state: m.state, qty: m.product_uom_qty })), group[0]!.picking_id ? group[0]!.move_type ?? "direct" : "direct"), origin: origins[0] ?? "",
        });
        toUnlink.push(...group.slice(1).map((m) => m.id));
        if (!merged.includes(head.id)) merged.push(head.id);
      }
      const nk = key(group[0]!, true);
      byNegKey.set(nk, [...(byNegKey.get(nk) ?? []), group[0]!.id]);
    }
  }
  const [pricePrec] = await rows<{ d: number }>(env, "SELECT digits AS d FROM decimal_precision WHERE name = 'Product Price'", []);
  for (const negId of neg) {
    for (const posId of byNegKey.get(key(all.get(negId)!, true)) ?? []) {
      const [pos] = await mergeRows(env, [posId]);
      const [n] = await mergeRows(env, [negId]);
      if (pos!.uom_id !== n!.uom_id || pos!.product_qty !== pos!.product_uom_qty) throw new NotPorted("stock.move._merge_moves of a negative move in another unit");
      const total = pos!.product_qty * (pos!.price_unit ?? 0) + n!.product_qty * (n!.price_unit ?? 0);
      if ((await uomCompare(env, pos!.product_uom_qty, Math.abs(n!.product_uom_qty))) >= 0) {
        const qty = pos!.product_uom_qty + n!.product_uom_qty;
        await write(env, "stock.move", [posId], { product_uom_qty: qty });
        const [after] = await mergeRows(env, [posId]);
        await write(env, "stock.move", [posId], {
          price_unit: after!.product_qty ? floatRound(total / after!.product_qty, pricePrec?.d ?? 2) : 0,
          move_dest_ids: n!.dests.length ? (() => { throw new NotPorted("stock.move._merge_moves of a negative chained move"); })() : [],
          move_orig_ids: n!.origs.length ? (() => { throw new NotPorted("stock.move._merge_moves of a negative chained move"); })() : [],
        });
        if (!merged.includes(posId)) merged.push(posId);
        toUnlink.push(negId);
        if ((await uomCompare(env, after!.product_uom_qty, 0)) === 0) toCancel.push(posId);
        break;
      }
      await write(env, "stock.move", [negId], { product_uom_qty: n!.product_uom_qty + pos!.product_uom_qty });
      const [nAfter] = await mergeRows(env, [negId]);
      await write(env, "stock.move", [negId], { price_unit: floatRound(total / nAfter!.product_qty, pricePrec?.d ?? 2) });
      await write(env, "stock.move", [posId], { product_uom_qty: 0 });
      toCancel.push(posId);
    }
  }
  // :1468 `_clean_merged` (purchase_stock: and the created purchase lines)
  const cleaned = [...new Set([...toUnlink, ...toCancel])];
  if (cleaned.length) {
    await write(env, "stock.move", cleaned, { propagate_cancel: false });
    if (env.reg.model("stock.move").fields.has("created_purchase_line_ids")) await write(env, "stock.move", cleaned, { created_purchase_line_ids: [[5, 0, 0]] });
  }
  if (toUnlink.length) {
    await cancelMoves(env, toUnlink);
    const { unlink } = await import("../orm/unlink");
    await unlink(env.sudo(), "stock.move", toUnlink);
  }
  if (toCancel.length) {
    const picked = new Set((await rows<{ id: number }>(env, "SELECT id FROM stock_move WHERE id = ANY($1::int[]) AND picked", [toCancel])).map((r) => r.id));
    await cancelMoves(env, toCancel.filter((m) => !picked.has(m)));
  }
  return [...new Set([...moveIds, ...merged])].filter((m) => !toUnlink.includes(m));
}

/** stock_move.py:1773-1866 `_action_confirm` (merge=True, create_proc=True) for make_to_stock moves without chains. */
export async function actionConfirm(env: Environment, moveIds: readonly number[], opts: { merge?: boolean } = {}): Promise<number[]> {
  const moves = await moveRows(env, moveIds);
  const toConfirm: number[] = [];
  const waiting: number[] = [];
  const toAssign = new Map<string, MoveRow[]>();
  for (const m of moves) {
    if (m.state !== "draft") continue;
    // :1792-1794 a move preceded by others waits for them (no procurement)
    if (m.orig) waiting.push(m.id);
    else if (m.procure_method === "make_to_order") throw new NotPorted("stock.move._action_confirm of a make_to_order move (procurement)");
    else if (m.rule_id && (await rows<{ p: string }>(env, "SELECT procure_method AS p FROM stock_rule WHERE id = $1", [m.rule_id]))[0]?.p === "mts_else_mto") {
      throw new NotPorted("stock.move._action_confirm through an mts_else_mto rule (procurement)");
    } else toConfirm.push(m.id);
    // :1769-1771 `_should_be_assigned`
    if (!m.picking_id && m.picking_type_id) {
      const key = JSON.stringify([await referencesOf(env, m.id), m.location_id, m.location_dest_id]);
      toAssign.set(key, [...(toAssign.get(key) ?? []), m]);
    }
  }
  if (toConfirm.length) await write(env, "stock.move", toConfirm, { state: "confirmed" });
  if (waiting.length) await write(env, "stock.move", waiting, { state: "waiting" });
  if (toConfirm.length || waiting.length) {
    const atConfirm = (await moveRows(env, [...toConfirm, ...waiting])).filter((m) => m.reservation_method === "at_confirm").map((m) => m.id);
    if (atConfirm.length) await write(env, "stock.move", atConfirm, { reservation_date: await contextToday(env) });
  }
  // clean_context: the default_* keys are dropped
  const clean = Object.fromEntries(Object.entries(env.context).filter(([k]) => !k.startsWith("default_")));
  for (const group of toAssign.values()) await assignPicking(env.withContext(clean), await moveRows(env, group.map((m) => m.id)));
  const result = opts.merge !== false ? await mergeMoves(env, moveIds) : [...moveIds];
  const after = await moveRows(env, result);
  if (after.some((m) => m.product_uom_qty < 0)) throw new NotPorted("stock.move._action_confirm of a negative move (return)");
  // :2061-2062 `_filtered_for_assign`
  const today = await contextToday(env);
  const assign: number[] = [];
  for (const m of after) {
    if (!(["confirmed", "partially_available"].includes(m.state) || m.origin_returned_move_id)) continue;
    const bypass = (await bypassLocation(env, m.location_id)) || !m.storable;
    if (m.origin_returned_move_id || bypass || m.reservation_method === "at_confirm" || (m.reservation_date && m.reservation_date <= today)) assign.push(m.id);
  }
  await actionAssign(env, assign);
  return result;
}

/** stock_move.py:1955-1986 `_prepare_move_line_vals` (quantity in the product's unit). */
export async function moveLineVals(env: Environment, m: MoveRow, quantity: number | null, quant: { location_id: number; lot_id?: number | null; package_id?: number | null } | null): Promise<Row> {
  const [extra] = await rows<{ picking_id: number | null; location_dest_id: number; company_id: number }>(env, "SELECT picking_id, location_dest_id, company_id FROM stock_move WHERE id = $1", [m.id]);
  let vals: Row = { move_id: m.id, product_id: m.product_id, uom_id: m.uom_id, location_id: m.location_id, location_dest_id: extra!.location_dest_id, picking_id: extra!.picking_id ?? false, company_id: extra!.company_id };
  if (quantity) {
    const digits = await unitDigits(env);
    const inMoveUom = floatRound(await uomQuantity(env, quantity, m.product_uom, m.uom_id, "HALF-UP"), digits);
    const back = await uomQuantity(env, inMoveUom, m.uom_id, m.product_uom, "HALF-UP");
    vals = floatRound(quantity, digits) === floatRound(back, digits) ? { ...vals, quantity: inMoveUom } : { ...vals, quantity, uom_id: m.product_uom };
  }
  if (quant) vals = { ...vals, location_id: quant.location_id, lot_id: quant.lot_id ?? false, package_id: quant.package_id ?? false, owner_id: false };
  return vals;
}

interface QuantRow { id: number; location_id: number; quantity: number; reserved_quantity: number; in_date: string | null; lot_id: number | null; package_id: number | null; owner_id: number | null }

/**
 * stock_quant.py:650-660 `_get_removal_strategy`, :773-780 the order, :782-823 `_gather` (no packages, owners): strict is
 * the exact location with the lot (or none) and the untracked quants, else the location's children with the lot (or
 * any); the lots' quants first (`sorted(lambda q: not q.lot_id)`, stable).
 */
/** stock_quant.py:650-660 `_get_removal_strategy` (as superuser): the product category's, else the first location up the chain's, else fifo. */
export async function removalStrategy(env: Environment, product: number, location: number): Promise<string> {
  const [p] = await rows<{ categ_method: string | null }>(env,
    `SELECT rs.method AS categ_method FROM product_product p JOIN product_template t ON t.id = p.product_tmpl_id JOIN product_category c ON c.id = t.categ_id
       LEFT JOIN product_removal rs ON rs.id = c.removal_strategy_id WHERE p.id = $1`, [product]);
  let method = p?.categ_method ?? null;
  if (!method) {
    const chain = await rows<{ m: string | null }>(env,
      `WITH RECURSIVE up(id, parent, depth) AS (SELECT id, location_id, 0 FROM stock_location WHERE id = $1
         UNION ALL SELECT l.id, l.location_id, up.depth + 1 FROM stock_location l JOIN up ON l.id = up.parent)
       SELECT rs.method AS m FROM up JOIN stock_location l ON l.id = up.id LEFT JOIN product_removal rs ON rs.id = l.removal_strategy_id ORDER BY up.depth`, [location]);
    method = chain.find((c) => c.m)?.m ?? "fifo";
  }
  return method;
}

async function gather(env: Environment, product: number, location: number, strict: boolean, lot: number | null = null, pkg: number | null = null): Promise<QuantRow[]> {
  const method = await removalStrategy(env, product, location);
  if (method !== "fifo") throw new NotPorted(`stock.quant._gather with the ${method} removal strategy`);
  if (env.context["with_expiration"]) throw new NotPorted("stock.quant._gather with_expiration");
  const lotCond = strict || lot !== null ? "(q.lot_id IS NULL OR q.lot_id = $3)" : "$3::int IS NULL";
  const where = strict
    ? `q.location_id = $2 AND ${lotCond} AND q.package_id IS NOT DISTINCT FROM $4 AND q.owner_id IS NULL`
    : `q.location_id IN (SELECT l.id FROM stock_location l WHERE l.parent_path LIKE (SELECT parent_path FROM stock_location WHERE id = $2) || '%') AND (${lotCond} OR $3::int IS NULL)${pkg !== null ? " AND q.package_id = $4" : ""}`;
  const quants = await rows<QuantRow>(env,
    `SELECT q.id, q.location_id, q.quantity::float8 AS quantity, COALESCE(q.reserved_quantity, 0)::float8 AS reserved_quantity, q.in_date::text AS in_date,
            q.lot_id, q.package_id, q.owner_id
       FROM stock_quant q WHERE q.product_id = $1 AND ${where} ORDER BY q.in_date ASC NULLS LAST, q.id`,
    strict || pkg !== null ? [product, location, lot, pkg] : [product, location, lot]);
  if (quants.some((q) => q.owner_id)) throw new NotPorted("stock.quant reservation of owners");
  return [...quants.filter((q) => q.lot_id), ...quants.filter((q) => !q.lot_id)];
}

/**
 * stock_quant.py:825-864 `_get_available_quantity`: `product_id.tracking` is a selection ('none' is truthy), so every
 * product takes the per-lot branch: the quantity minus the reservation per lot and for the untracked quants (skipped
 * when strict with a lot), then the sum (only the positive buckets unless negative quantities are allowed).
 */
export async function availableQuantity(env: Environment, quants: QuantRow[], allowNegative: boolean, strictLot: number | null = null): Promise<number> {
  const buckets = new Map<number | "untracked", number>();
  for (const q of quants) if (q.lot_id) buckets.set(q.lot_id, 0);
  buckets.set("untracked", 0);
  for (const q of quants) {
    if (!q.lot_id && strictLot !== null) continue;
    const k = q.lot_id ?? "untracked";
    buckets.set(k, buckets.get(k)! + q.quantity - q.reserved_quantity);
  }
  let sum = 0;
  for (const v of buckets.values()) if (allowNegative || (await uomCompare(env, v, 0)) > 0) sum += v;
  return sum;
}

/** stock_quant.py:866-946 `_get_reserve_quantity` (non-strict, move unit = product unit): [(quant, quantity)]. */
export async function reserveQuantity(env: Environment, product: number, location: number, quantity0: number, moveUom: number, productUom: number, serial = false,
  strict: { lot: number | null } | null = null): Promise<[QuantRow, number][]> {
  // `strict=True` (the quants of a move line's exact location and lot, without package or owner): `_gather` and
  // `_get_available_quantity` with the line's characteristics, no unit conversion (:897)
  const quants = strict ? await gather(env, product, location, true, strict.lot) : await gather(env, product, location, false);
  let available = strict ? await availableQuantity(env, quants, false, strict.lot) : await availableQuantity(env, quants, false);
  if (env.context["packaging_uom_id"]) throw new NotPorted("stock.quant reservation of full packagings");
  let quantity = Math.min(quantity0, available);
  if (!strict && productUom !== moveUom) {
    const inMove = await uomQuantity(env, quantity, productUom, moveUom, "DOWN");
    quantity = await uomQuantity(env, inMove, moveUom, productUom, "HALF-UP");
  }
  // stock_quant.py:901-903: a serial number is reserved by whole units, a fractional quantity not at all
  if (serial && (await uomCompare(env, quantity, Math.trunc(quantity))) !== 0) quantity = 0;
  const out: [QuantRow, number][] = [];
  if ((await uomCompare(env, quantity, 0)) > 0) {
    let pos = 0;
    for (const q of quants) if ((await uomCompare(env, q.quantity, 0)) > 0) pos += q.quantity;
    let res = 0;
    for (const q of quants) res += q.reserved_quantity;
    available = pos - res;
  } else if ((await uomCompare(env, quantity, 0)) < 0) {
    throw new NotPorted("stock.quant unreservation");
  } else return out;
  // :913-916 keyed by (location, lot, package, owner)
  const nkey = (q: QuantRow): string => `${q.location_id}/${q.lot_id ?? ""}/${q.package_id ?? ""}`;
  const negative = new Map<string, number>();
  for (const q of quants) if ((await uomCompare(env, q.quantity - q.reserved_quantity, 0)) < 0) negative.set(nkey(q), (negative.get(nkey(q)) ?? 0) + q.quantity - q.reserved_quantity);
  for (const q of quants) {
    let max = q.quantity - q.reserved_quantity;
    if ((await uomCompare(env, max, 0)) <= 0) continue;
    const neg = negative.get(nkey(q)) ?? 0;
    if (neg) {
      const remove = Math.min(Math.abs(neg), max);
      negative.set(nkey(q), neg + remove);
      max -= remove;
    }
    if ((await uomCompare(env, max, 0)) <= 0) continue;
    max = Math.min(max, quantity);
    out.push([q, max]);
    quantity -= max;
    available -= max;
    if ((await uomCompare(env, quantity, 0)) === 0 || (await uomCompare(env, available, 0)) === 0) break;
  }
  return out;
}

/**
 * stock_quant.py:1070-1137 `_update_available_quantity` without lot, package or owner: the first quant at the exact
 * location (by in_date, id) takes the change, else a new quant. Returns the in_date used.
 */
export async function updateAvailableQuantity(env: Environment, product: number, location: number, quantity: number, reserved: number, inDate: string | null, lot: number | null = null, pkg: number | null = null): Promise<string> {
  if (!quantity && !reserved) throw new UserError(translate(env, "Quantity or Reserved Quantity should be set."));
  const su = env.sudo();
  let quants = await gather(su, product, location, true, lot, pkg);
  // :1088-1093 with a lot: an increase goes to the lot's quant; a decrease never empties a negative untracked quant
  if (lot !== null) {
    if ((await uomCompare(su, quantity, 0)) > 0) quants = quants.filter((q) => q.lot_id);
    else {
      const keep: QuantRow[] = [];
      for (const q of quants) if (q.lot_id || (await uomCompare(su, q.quantity, 0)) > 0) keep.push(q);
      quants = keep;
    }
  }
  const incoming: string[] = [];
  if (!(await bypassLocation(su, location))) {
    for (const q of quants) if (q.in_date && (await uomCompare(su, q.quantity, 0)) > 0) incoming.push(q.in_date);
  }
  if (inDate) incoming.push(inDate);
  const date = incoming.length ? [...incoming].sort()[0]! : await nowString(su);
  const quant = quants[0];
  if (quant) {
    const vals: Row = { in_date: date };
    if (quantity) vals["quantity"] = quant.quantity + quantity;
    if (reserved) vals["reserved_quantity"] = Math.max(0, quant.reserved_quantity + reserved);
    await write(su.withContext({ ...su.context, inventory_mode: false }), "stock.quant", [quant.id], vals);
  } else {
    // stock_quant.py:338-341: a create outside the inventory mode without counted quantity is not "set"
    const vals: Row = { product_id: product, location_id: location, lot_id: lot ?? false, package_id: pkg ?? false, owner_id: false, in_date: date, inventory_quantity_set: false };
    if (quantity) vals["quantity"] = quantity;
    if (reserved) vals["reserved_quantity"] = reserved;
    await create(su.withContext({ ...su.context, inventory_mode: false }), "stock.quant", [vals]);
  }
  if (pkg !== null) {
    const queue = new RecomputeQueue(su);
    await queue.modified("stock.package", [pkg], ["quant_ids"]);
    await queue.run();
  }
  return date;
}

/** stock_move.py:2000-2045 `_update_reserved_quantity_vals` + `_update_reserved_quantity` (:1988-1998). */
async function updateReservedQuantity(env: Environment, m: MoveRow, need: number, location: number, strict = false): Promise<number> {
  const quants = await reserveQuantity(env, m.product_id, location, need, m.uom_id, m.product_uom, m.tracking === "serial", strict ? { lot: null } : null);
  // :2016-2020 the candidates to update: not a serial number's line (one unit per line)
  const candidates = m.tracking === "serial" ? [] : await rows<{ id: number; location_id: number; lot_id: number | null; package_id: number | null; uom_id: number; quantity: number }>(env,
    `SELECT id, location_id, lot_id, package_id, uom_id, quantity::float8 AS quantity FROM stock_move_line WHERE move_id = $1 AND result_package_id IS NULL AND owner_id IS NULL ORDER BY id`, [m.id]);
  let taken = 0;
  // :2000-2045 grouped by (location, lot, package, owner) of the quants
  const grouped = new Map<string, [QuantRow, number]>();
  for (const [q, qty] of quants) {
    const key = `${q.location_id}/${q.lot_id ?? ""}/${q.package_id ?? ""}`;
    const g = grouped.get(key);
    if (g) g[1] += qty; else grouped.set(key, [q, qty]);
  }
  const vals: Row[] = [];
  const digits = await unitDigits(env);
  for (const [quant, qty] of grouped.values()) {
    taken += qty;
    // stock_move_line.py `_reservation_is_updatable`: same location, lot and package
    const line = [...candidates].reverse().find((c) => c.location_id === quant.location_id && (c.lot_id ?? null) === (quant.lot_id ?? null) && (c.package_id ?? null) === (quant.package_id ?? null));
    if (line) {
      const inLine = floatRound(await uomQuantity(env, qty, m.product_uom, line.uom_id, "HALF-UP"), digits);
      const back = await uomQuantity(env, inLine, line.uom_id, m.product_uom, "HALF-UP");
      if (floatRound(qty, digits) === floatRound(back, digits)) {
        // `to_update.with_context(reserved_quant=...).quantity += uom_quantity`: the line's write moves the reservation
        await write(env, "stock.move.line", [line.id], { quantity: line.quantity + inLine });
        line.quantity += inLine;
        continue;
      }
    }
    // :2039-2048 `_add_serial_move_line_to_vals_list`: a serial number per unit when the operation type uses lots
    if (m.tracking === "serial" && m.lots_on_type) {
      for (let i = 0; i < Math.trunc(qty); i++) vals.push(await moveLineVals(env, m, 1, quant));
    } else vals.push(await moveLineVals(env, m, qty, quant));
  }
  if (vals.length) await create(env, "stock.move.line", vals);
  return taken;
}

/**
 * stock_move.py:2083-2136 `_get_available_move_lines` (lines without lot, package or owner): what the done origin moves
 * of the move's chain brought per location (`_get_available_move_lines_in`), less what the origin moves' other
 * destination moves took (`_get_available_move_lines_out`: done, reserved, or reserved earlier in this `_action_assign`,
 * whose sum replaces the done quantity of the same key) and what the move already reserved; [location, quantity] > 0.
 */
async function availableMoveLines(env: Environment, m: MoveRow, assigned: readonly number[], partial: readonly number[]): Promise<[number, number][]> {
  const lineQty = async (ls: { quantity: number; uom_id: number; product_uom: number }[]): Promise<number> => {
    let q = 0;
    for (const l of ls) q += await uomQuantity(env, l.quantity, l.uom_id, l.product_uom);
    return q;
  };
  type L = { move_id: number; location_id: number; location_dest_id: number; lot_id: number | null; package_id: number | null; result_package_id: number | null; owner_id: number | null;
    quantity: number; quantity_product_uom: number; uom_id: number; product_uom: number };
  const lines = async (moves: readonly number[]): Promise<L[]> => moves.length ? rows<L>(env,
    `SELECT l.move_id, l.location_id, l.location_dest_id, l.lot_id, l.package_id, l.result_package_id, l.owner_id, l.quantity::float8 AS quantity,
            COALESCE(l.quantity_product_uom, 0)::float8 AS quantity_product_uom, l.uom_id, t.uom_id AS product_uom
       FROM stock_move_line l JOIN product_product p ON p.id = l.product_id JOIN product_template t ON t.id = p.product_tmpl_id
      WHERE l.move_id = ANY($1::int[]) ORDER BY l.id`, [[...moves]]) : [];
  const origs = (await rows<{ o: number }>(env, "SELECT move_orig_id AS o FROM stock_move_move_rel WHERE move_dest_id = $1", [m.id])).map((r) => r.o);
  const siblingsAll = (await rows<{ d: number; state: string }>(env,
    "SELECT DISTINCT r.move_dest_id AS d, s.state FROM stock_move_move_rel r JOIN stock_move s ON s.id = r.move_dest_id WHERE r.move_orig_id = ANY($1::int[])", [origs]));
  const inMoves = (await rows<{ o: number }>(env,
    `SELECT DISTINCT r.move_orig_id AS o FROM stock_move_move_rel r JOIN stock_move o ON o.id = r.move_orig_id WHERE r.move_dest_id = ANY($1::int[]) AND o.state = 'done'`,
    [siblingsAll.map((s) => s.d)])).map((r) => r.o);
  const inLines = await lines(inMoves);
  const siblings = siblingsAll.filter((s) => s.d !== m.id);
  const outDone = await lines(siblings.filter((s) => s.state === "done").map((s) => s.d));
  const outReserved = await lines(siblings.filter((s) => ["partially_available", "assigned"].includes(s.state) || assigned.includes(s.d) || partial.includes(s.d)).map((s) => s.d));
  const own = await lines([m.id]);
  if ([...inLines, ...outDone, ...outReserved, ...own].some((l) => l.lot_id || l.package_id || l.result_package_id || l.owner_id)) {
    throw new NotPorted("stock.move._get_available_move_lines with lots, packages or owners");
  }
  const groups = new Map<number, number>();
  for (const loc of [...new Set(inLines.map((l) => l.location_dest_id))]) groups.set(loc, await lineQty(inLines.filter((l) => l.location_dest_id === loc)));
  const out = new Map<number, number>();
  for (const loc of [...new Set(outDone.map((l) => l.location_id))]) out.set(loc, await lineQty(outDone.filter((l) => l.location_id === loc)));
  for (const loc of [...new Set(outReserved.map((l) => l.location_id))]) out.set(loc, outReserved.filter((l) => l.location_id === loc).reduce((a, l) => a + l.quantity_product_uom, 0));
  const available = new Map<number, number>();
  for (const [loc, q] of groups) available.set(loc, q - (out.get(loc) ?? 0));
  for (const l of own) {
    if ((await uomCompare(env, l.quantity_product_uom, 0)) === 0) continue;
    if (available.has(l.location_id)) available.set(l.location_id, available.get(l.location_id)! - l.quantity_product_uom);
  }
  const res: [number, number][] = [];
  for (const [loc, q] of available) if ((await uomCompare(env, q, 0)) > 0) res.push([loc, q]);
  return res;
}

/** stock_move.py:2138-2274 `_action_assign` (no force_qty) for moves without chains, lots, packages or putaway rules. */
export async function actionAssign(env0: Environment, moveIds: readonly number[]): Promise<void> {
  if (!moveIds.length) return;
  const assigned: number[] = [];
  const partial: number[] = [];
  const toRedirect: number[] = [];
  const createVals: Row[] = [];
  const moves = (await moveRows(env0, moveIds)).filter((m) => !m.picked && ["confirmed", "waiting", "partially_available"].includes(m.state));
  // the reserved quantities are read once, before any reservation
  const reservedBefore = new Map(moves.map((m) => [m.id, m.quantity]));
  for (const m of moves) {
    const env = env0.withContext({ ...env0.context, allowed_company_ids: [m.company_id, ...(await env0.companies()).filter((c) => c !== m.company_id)] });
    const missingUom = m.product_uom_qty - reservedBefore.get(m.id)!;
    if ((await uomCompare(env, missingUom, 0)) <= 0) { assigned.push(m.id); continue; }
    let missing = await uomQuantity(env, missingUom, m.uom_id, m.product_uom, "HALF-UP");
    const bypass = (await bypassLocation(env, m.location_id)) || !m.storable;
    if (m.orig && bypass) {
      // :2096-2111 with `_get_available_move_lines` (:2017-2030, :2032-2060): what the origin moves brought, by their
      // lines' destination (no lots, packages or owners here) and without other destination moves taking it
      const others = await rows<{ n: number }>(env, `SELECT count(*)::int AS n FROM stock_move_move_rel r JOIN stock_move_move_rel s ON s.move_orig_id = r.move_orig_id
          WHERE r.move_dest_id = $1 AND s.move_dest_id != $1`, [m.id]);
      if (others[0]!.n) throw new NotPorted("stock.move._action_assign of a chained move with sibling moves");
      const lines = await rows<{ location_dest_id: number; lot_id: number | null; result_package_id: number | null; owner_id: number | null; quantity: number; uom_id: number; product_uom: number }>(env,
        `SELECT l.location_dest_id, l.lot_id, l.result_package_id, l.owner_id, l.quantity::float8 AS quantity, l.uom_id, t.uom_id AS product_uom
           FROM stock_move_move_rel r JOIN stock_move o ON o.id = r.move_orig_id JOIN stock_move_line l ON l.move_id = o.id
           JOIN product_product pp ON pp.id = l.product_id JOIN product_template t ON t.id = pp.product_tmpl_id
          WHERE r.move_dest_id = $1 AND o.state = 'done' ORDER BY o.id, l.id`, [m.id]);
      if ((await rows(env, "SELECT 1 FROM stock_move_line WHERE move_id = $1 AND quantity != 0 LIMIT 1", [m.id])).length) throw new NotPorted("stock.move._action_assign of a chained move with own lines");
      if (lines.some((l) => l.lot_id || l.result_package_id || l.owner_id || l.location_dest_id !== m.location_id)) {
        throw new NotPorted("stock.move._action_assign of a chained move from lots, packages, owners or another location");
      }
      let available = 0;
      for (const l of lines) available += await uomQuantity(env, l.quantity, l.uom_id, l.product_uom);
      if ((await uomCompare(env, available, 0)) > 0) {
        const added = Math.min(missing, available);
        createVals.push(await moveLineVals(env, m, added, null));
        missing -= added;
        if ((await uomCompare(env, missing, 0)) === 0) missing = 0;
      }
    }
    if (bypass) {
      if (missing && m.tracking === "serial" && m.lots_on_type) {
        // :2189-2191 one line of one unit per serial number to come (`range(int(missing))`)
        for (let i = 0; i < Math.trunc(missing); i++) createVals.push(await moveLineVals(env, m, 1, null));
      } else if (missing) {
        const [line] = await rows<{ id: number; quantity: number }>(env,
          `SELECT l.id, l.quantity::float8 AS quantity FROM stock_move_line l JOIN stock_move m ON m.id = l.move_id
            WHERE l.move_id = $1 AND l.uom_id = m.uom_id AND l.location_id = m.location_id AND l.location_dest_id = m.location_dest_id
              AND l.picking_id IS NOT DISTINCT FROM m.picking_id AND NOT COALESCE(l.picked, false) AND l.lot_id IS NULL AND l.result_package_id IS NULL
              AND l.package_id IS NULL AND l.owner_id IS NULL ORDER BY l.id LIMIT 1`, [m.id]);
        // :2207-2211 the matching line gets the missing quantity (in the move's unit)
        if (line) await write(env, "stock.move.line", [line.id], { quantity: line.quantity + await uomQuantity(env, missing, m.product_uom, m.uom_id, "HALF-UP") });
        else createVals.push(await moveLineVals(env, m, missing, null));
      }
      assigned.push(m.id);
      toRedirect.push(m.id);
    } else {
      if ((await uomCompare(env, m.product_uom_qty, 0)) === 0) assigned.push(m.id);
      else if (m.orig) {
        // :2224-2258 what the origin moves brought (`_get_available_move_lines`), reserved strictly at its location
        const available = await availableMoveLines(env, m, assigned, partial);
        if (!available.length) continue;
        if (available.length > 1) throw new NotPorted("stock.move._action_assign of a chained move from several locations (the order of _get_available_move_lines)");
        const [location, quantity] = available[0]!;
        const own = (await rows<{ q: number }>(env, "SELECT COALESCE(sum(quantity_product_uom), 0)::float8 AS q FROM stock_move_line WHERE move_id = $1", [m.id]))[0]!.q;
        const need = m.product_qty - own;
        const taken = await updateReservedQuantity(env, m, Math.min(quantity, need), location, true);
        if ((await uomCompare(env, taken, 0)) !== 0) {
          toRedirect.push(m.id);
          if ((await uomCompare(env, need - taken, 0)) === 0) assigned.push(m.id); else partial.push(m.id);
        }
      } else {
        if (m.procure_method === "make_to_order") continue;
        if ((await uomCompare(env, missing, 0)) === 0) { assigned.push(m.id); continue; }
        const taken = await updateReservedQuantity(env, m, missing, m.location_id);
        if ((await uomCompare(env, taken, 0)) === 0) continue;
        toRedirect.push(m.id);
        if ((await uomCompare(env, missing, taken)) === 0) assigned.push(m.id); else partial.push(m.id);
      }
    }
    // :2263-2264 `move.next_serial_count = move.product_uom_qty` (an Integer field: int())
    if (m.tracking === "serial") await write(env0, "stock.move", [m.id], { next_serial_count: Math.trunc(m.product_uom_qty) });
  }
  if (createVals.length) await create(env0, "stock.move.line", createVals);
  if (partial.length) await write(env0, "stock.move", partial, { state: "partially_available" });
  if (assigned.length) await write(env0, "stock.move", assigned, { state: "assigned" });
  // stock_picking.py `_check_entire_pack`
  if (!env0.context["bypass_entire_pack"]) {
    const pkgPickings = (await rows<{ p: number }>(env0,
      "SELECT DISTINCT picking_id AS p FROM stock_move_line WHERE move_id = ANY($1::int[]) AND picking_id IS NOT NULL AND (package_id IS NOT NULL OR result_package_id IS NOT NULL)", [[...moveIds]])).map((r) => r.p);
    if (pkgPickings.length) {
      const { checkEntirePack } = await import("./sweep2_stock_sale");
      await checkEntirePack(env0, pkgPickings);
    }
  }
  await applyPutaway(env0, toRedirect);
}

/** stock_move_line.py:265-296 `_apply_putaway_strategy` without putaway rules: a destination that is a view takes its first internal child. */
export async function applyPutaway(env: Environment, moveIds: readonly number[]): Promise<void> {
  if (!moveIds.length || env.context["avoid_putaway_rules"]) return;
  const lines = await rows<{ id: number; dest: number; usage: string; rules: number }>(env,
    `SELECT l.id, m.location_dest_id AS dest, d.usage, (SELECT count(*)::int FROM stock_putaway_rule r WHERE r.location_in_id = m.location_dest_id AND r.active) AS rules
       FROM stock_move_line l JOIN stock_move m ON m.id = l.move_id JOIN stock_location d ON d.id = m.location_dest_id WHERE l.move_id = ANY($1::int[])`, [[...moveIds]]);
  for (const l of lines) {
    if (l.rules) throw new NotPorted("stock.move.line putaway rules (_get_putaway_strategy)");
    if (l.usage === "view") throw new NotPorted("stock.move.line putaway into a view location");
  }
}

/** stock_picking.py:768-785 `action_confirm` with `_trigger_scheduler` of moves that leave no orderpoint to trigger. */
export async function pickingActionConfirm(env: Environment, pickingIds: readonly number[]): Promise<void> {
  const draft = ids(await rows<{ id: number }>(env, "SELECT id FROM stock_move WHERE picking_id = ANY($1::int[]) AND state = 'draft' ORDER BY id", [[...pickingIds]]));
  if (draft.length) await actionConfirm(env, draft);
  const open = ids(await rows<{ id: number }>(env, "SELECT id FROM stock_move WHERE picking_id = ANY($1::int[]) AND state NOT IN ('draft', 'cancel', 'done') ORDER BY id", [[...pickingIds]]));
  await triggerScheduler(env, open);
}

/**
 * stock_move.py:2729-2751 `_trigger_scheduler`: the auto orderpoint over each move's source and not over its
 * destination, per company, with the moves' stock references as origins when the move is above the minimum; then
 * stock_orderpoint.py:749-830 `_procure_orderpoint_confirm` (src/models/stock_procure.ts).
 */
export async function triggerScheduler(env: Environment, moveIds: readonly number[]): Promise<void> {
  if (!moveIds.length) return;
  const off = await rows<{ v: string }>(env, "SELECT value AS v FROM ir_config_parameter WHERE key = 'stock.no_auto_scheduler'", []);
  if (off[0] && !["", "0", "false", "False"].includes(off[0].v)) return;
  const byCompany = new Map<number, number[]>();
  const origins = new Map<number, Map<number, Set<number>>>();
  for (const m of await moveRows(env, moveIds)) {
    const [hit] = await rows<{ id: number; company_id: number; min: number }>(env,
      `SELECT o.id, o.company_id, o.product_min_qty::float8 AS min FROM stock_warehouse_orderpoint o JOIN stock_location l ON l.id = o.location_id
        WHERE o.product_id = $1 AND o.trigger = 'auto' AND o.company_id = $2 AND o.active
          AND (SELECT parent_path FROM stock_location WHERE id = $3) LIKE l.parent_path || '%'
          AND NOT (SELECT parent_path FROM stock_location WHERE id = $4) LIKE l.parent_path || '%'
        ORDER BY o.id LIMIT 1`, [m.product_id, m.company_id, m.location_id, m.location_dest_id]);
    if (!hit) continue;
    const list = byCompany.get(hit.company_id) ?? [];
    if (!list.includes(hit.id)) list.push(hit.id);
    byCompany.set(hit.company_id, list);
    const refs = await referencesOf(env, m.id);
    if (m.product_qty > hit.min && refs.length) {
      const per = origins.get(hit.company_id) ?? new Map<number, Set<number>>();
      const set = per.get(hit.id) ?? new Set<number>();
      for (const r of refs) set.add(r);
      per.set(hit.id, set);
      origins.set(hit.company_id, per);
    }
  }
  if (!byCompany.size) return;
  const { procureOrderpoints } = await import("./stock_procure");
  const { runPrecommit, withPrecommit } = await import("./precommit");
  for (const [company, points] of byCompany) {
    // stock_orderpoint.py:784 `with self.env.cr.savepoint()`: the flush runs the precommit hooks
    await runPrecommit(env.cr);
    await withPrecommit(env.cr, () => procureOrderpoints(env, points, origins.get(company) ?? new Map(), company));
  }
}

/**
 * The body of mail_templates_chatter.xml `message_origin_link` for one origin record, created (not edited): the
 * template's `t-else` words in the environment's language (its arch_db translation, else en_US) around the model's
 * name, "This <name> has been created from:", and the link. Text is escaped as the sanitized body keeps it (&, <, >).
 */
export async function originLinkBody(env: Environment, model: string, origin: { model: string; id: number }): Promise<string> {
  const lang = env.lang ?? "en_US";
  const arch = (await rows<{ a: string | null }>(env,
    `SELECT COALESCE(v.arch_db->>$1, v.arch_db->>'en_US') AS a FROM ir_ui_view v JOIN ir_model_data d ON d.model = 'ir.ui.view' AND d.res_id = v.id
      WHERE d.module = 'mail' AND d.name = 'message_origin_link'`, [lang]))[0]?.a ?? "";
  const words = /<t t-else="">([^<]*)<t t-out="self\.env\['ir\.model'\]\._get\(self\._name\)\.name\.lower\(\)"\/>([^<]*)<\/t>/.exec(arch);
  if (!words || /[&]/.test(words[1]! + words[2]!)) throw new NotPorted(`message_origin_link text in ${lang}`);
  const label = String((await rows<{ n: string }>(env, "SELECT COALESCE(name->>$2, name->>'en_US') AS n FROM ir_model WHERE model = $1", [model, lang]))[0]?.n ?? model).toLowerCase();
  const display = (await env.sudo().model(origin.model).displayName([origin.id])).get(origin.id) ?? "";
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<p>\n                ${words[1]}${esc(label)}${words[2]}\n                    <a href="#" data-oe-model="${origin.model}" data-oe-id="${origin.id}"> ${esc(display)}</a>\n            </p>`;
}

/** mail_templates_chatter.xml `message_origin_link` posted on records (message_post_with_source, mt_note). */
export async function postOriginLink(env: Environment, model: string, resIds: readonly number[], origin: { model: string; id: number }): Promise<void> {
  const body = await originLinkBody(env, model, origin);
  for (const id of resIds) await postNote(env, model, id, body);
}

/** `message_post_with_source(..., subtype_xmlid='mail.mt_note')` of a rendered body: one notification, no notified partners. */
export async function postNote(env: Environment, model: string, id: number, body: string): Promise<void> {
  const [author, emailFrom] = await computeAuthor(env, null, null);
  const [row] = await rows<{ c: number | null }>(env, `SELECT company_id AS c FROM ${env.reg.model(model).table} WHERE id = $1`, [id]);
  await insertMessages(env, [{
    model, res_id: id, body, author_id: author, email_from: emailFrom, message_type: "notification", subject: false, subtype_id: await xmlid(env, "mail.mt_note"),
    email_add_signature: true, record_company_id: row?.c ?? false, parent_id: await flatThreadParent(env, model, id), message_id: trackingMessageId("message-notify"),
    reply_to: await replyToDefault(env, emailFrom),
  }]);
}

const escAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const relId = (v: unknown): number | null => (typeof v === "number" && v > 0 ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : null);

// stock_move_line.py:104-174 the stored computes of a move line (an existing line keeps its locations: `_origin` is itself)
registerRecordCompute("stock.move.line", {
  uom_id: async (_env, rec) => {
    const current = await rec.prev("uom_id");
    if (relId(current)) return current;
    const move = await rec.rel("move_id");
    const fromMove = move ? relId(await move.get("uom_id")) : null;
    if (fromMove) return fromMove;
    const product = await rec.rel("product_id");
    return product ? relId(await product.get("uom_id")) : null;
  },
  picked: async (env, rec) => {
    const move = await rec.rel("move_id");
    if ((move && (await move.get("state")) === "done") || env.context["auto_pick_move_lines"]) return true;
    return rec.prev("picked");
  },
  location_id: async (_env, rec) => {
    const current = await rec.prev("location_id");
    if (relId(current)) {
      if (rec.id === null) throw new NotPorted("stock.move.line.location_id of a new line (_origin.picking_id)");
      return current;
    }
    const move = await rec.rel("move_id");
    const picking = await rec.rel("picking_id");
    return (move ? relId(await move.get("location_id")) : null) ?? (picking ? relId(await picking.get("location_id")) : null);
  },
  location_dest_id: async (_env, rec) => {
    const current = await rec.prev("location_dest_id");
    if (relId(current)) {
      if (rec.id === null) throw new NotPorted("stock.move.line.location_dest_id of a new line (_origin.picking_id)");
      return current;
    }
    const move = await rec.rel("move_id");
    const picking = await rec.rel("picking_id");
    return (move ? relId(await move.get("location_dest_id")) : null) ?? (picking ? relId(await picking.get("location_dest_id")) : null);
  },
  quantity: async (_env, rec) => {
    const current = await rec.prev("quantity");
    if (!relId(await rec.get("quant_id")) || current) return current;
    throw new NotPorted("stock.move.line.quantity from a quant (_compute_quantity)");
  },
  quantity_product_uom: async (env, rec) => {
    const product = await rec.rel("product_id");
    const uom = relId(await rec.get("uom_id"));
    const qty = Number((await rec.get("quantity")) ?? 0);
    if (!product || !uom) return qty;
    return uomQuantity(env, qty, uom, relId(await product.get("uom_id")), "HALF-UP");
  },
});

// stock_move_line.py:435-551 write: a change of quantity, unit, locations, lot, package or owner moves the reservation
// on the quants (and of done lines the quants themselves); only the other fields are written as they are
const RESERVING = ["quantity", "uom_id", "location_id", "location_dest_id", "lot_id", "package_id", "result_package_id", "owner_id", "quant_id", "product_id"];
interface LineRow { id: number; move_id: number | null; product_id: number; location_id: number; uom_id: number; product_uom: number; quantity: number; qpu: number; state: string | null; storable: boolean;
  lot_id: number | null; package_id: number | null; owner_id: number | null; result_package_id: number | null }

async function lineRows(env: Environment, lineIds: readonly number[]): Promise<LineRow[]> {
  return rows<LineRow>(env,
    `SELECT l.id, l.move_id, l.product_id, l.location_id, l.uom_id, t.uom_id AS product_uom, COALESCE(l.quantity, 0)::float8 AS quantity, COALESCE(l.quantity_product_uom, 0)::float8 AS qpu,
            l.state, COALESCE(t.is_storable, false) AS storable, l.lot_id, l.package_id, l.owner_id, l.result_package_id
       FROM stock_move_line l JOIN product_product p ON p.id = l.product_id JOIN product_template t ON t.id = p.product_tmpl_id WHERE l.id = ANY($1::int[]) ORDER BY l.id`, [[...lineIds]]);
}

/** stock_move.py `_should_bypass_reservation(location)`: the location bypasses it or the product is not storable. */
async function moveBypasses(env: Environment, move: number | null, location: number): Promise<boolean> {
  if (move === null) return false;
  const [m] = await moveRows(env, [move]);
  return (await bypassLocation(env, location)) || !m!.storable;
}

registerOverrides("stock.move.line", {
  // :435-551 with only `quantity` among the reserving keys, on lines that are not done (the `_synchronize_quant`
  // "reserved" pair, then `_recompute_state` of the moves whose quantity changed)
  write: async (env, lineIds, vals, next) => {
    // :459-462 under skip_uom_conversion (product_template.py:839, a new unit of the product) the keys leave the quants
    // as they are: only a write of the unit alone is followed
    if (env.context["skip_uom_conversion"]) {
      const other = RESERVING.filter((k) => k in vals && k !== "uom_id");
      if (other.length) throw new NotPorted(`stock.move.line write of ${other.join(", ")} under skip_uom_conversion`);
      return next(env, lineIds, vals);
    }
    const keys = RESERVING.filter((k) => k in vals && k !== "quantity" && k !== "lot_id" && k !== "result_package_id" && k !== "location_dest_id");
    if (keys.length) throw new NotPorted(`stock.move.line write of ${keys.join(", ")} (quant reservation)`);
    // a new destination (stock.move `_set_location_dest_id`) of lines that are not done: the reservation pair at the
    // line's own source below (:485-494); a done line's quants (:498-526) and packages (:544-546) refuse
    if ("location_dest_id" in vals) {
      const ls = await lineRows(env, lineIds);
      if (ls.some((l) => l.state === "done")) throw new NotPorted("stock.move.line write of location_dest_id on a done line (the quants move)");
      if (ls.some((l) => l.package_id || l.result_package_id)) throw new NotPorted("stock.move.line write of location_dest_id with packages (_get_lines_not_entire_pack)");
    }
    if ("result_package_id" in vals && (await lineRows(env, lineIds)).some((l) => l.state === "done")) {
      throw new NotPorted("stock.move.line write of result_package_id on a done line (quant reservation)");
    }
    const recompute: number[] = [];
    if ("lot_id" in vals) {
      const products = new Set((await lineRows(env, lineIds)).map((l) => l.product_id));
      if (products.size > 1) throw new UserError(translate(env, "Changing the Lot/Serial number for move lines with different products is not allowed.", "stock"));
    }
    if ("quantity" in vals || "lot_id" in vals || "location_dest_id" in vals) {
      const newLot = "lot_id" in vals ? (relId(vals["lot_id"]) ?? null) : undefined;
      for (const ml of await lineRows(env, lineIds)) {
        if (!ml.storable || ml.state === "done") continue;
        if (ml.owner_id) throw new NotPorted("stock.move.line write of quantity, lot or destination with an owner");
        let newReserved = ml.qpu;
        if ("quantity" in vals) {
          newReserved = await uomQuantity(env, Number(vals["quantity"] || 0), ml.uom_id, ml.product_uom, "HALF-UP");
          if ((await uomCompare(env, newReserved, 0)) < 0) throw new UserError(translate(env, "Reserving a negative quantity is not allowed."));
        }
        // `_synchronize_quant(..., action="reserved")` returns at once for a zero quantity (uom.is_zero) and when the
        // move bypasses the location: unreserve the old lot, reserve on the new one
        const bypass = await moveBypasses(env, ml.move_id, ml.location_id);
        if ((await uomCompare(env, ml.qpu, 0)) !== 0 && !bypass) await updateAvailableQuantity(env, ml.product_id, ml.location_id, 0, -ml.qpu, null, ml.lot_id, ml.package_id);
        if (!bypass && (await uomCompare(env, newReserved, 0)) !== 0) await updateAvailableQuantity(env, ml.product_id, ml.location_id, 0, newReserved, null, newLot === undefined ? ml.lot_id : newLot, ml.package_id);
        if ("quantity" in vals && Number(vals["quantity"] || 0) !== ml.quantity && ml.move_id !== null && !recompute.includes(ml.move_id)) recompute.push(ml.move_id);
      }
    }
    await next(env, lineIds, vals);
    await recomputeState(env, recompute);
  },
  // :552-560 `_unlink_except_done_or_cancel`, after the unlink override's unreservation (:562-570)
  beforeUnlink: async (env, lineIds) => {
    const lines = await lineRows(env, lineIds);
    const digits = await unitDigits(env);
    const moves: number[] = [];
    const pickings: number[] = [];
    const resultPkgs: number[] = [];
    const pickingRows = lineIds.length ? await rows<{ id: number; picking_id: number | null }>(env, "SELECT id, picking_id FROM stock_move_line WHERE id = ANY($1::int[])", [[...lineIds]]) : [];
    for (const r of pickingRows) if (r.picking_id !== null && !pickings.includes(r.picking_id)) pickings.push(r.picking_id);
    for (const ml of lines) {
      if (ml.move_id !== null && !moves.includes(ml.move_id)) moves.push(ml.move_id);
      if (ml.result_package_id !== null && !resultPkgs.includes(ml.result_package_id)) resultPkgs.push(ml.result_package_id);
      if (floatRound(ml.qpu, digits) === 0 || ml.move_id === null || (await moveBypasses(env, ml.move_id, ml.location_id))) continue;
      if (ml.owner_id) throw new NotPorted("stock.move.line unlink with an owner");
      if (ml.lot_id) {
        // stock_quant.py `_update_reserved_quantity(-qty, lot_id=lot, strict=True)`: the lot's quant at the location gives
        // the reservation back; several quants of the lot there, or less reserved than the line, refuse
        const quants = await rows<{ reserved: number }>(env,
          "SELECT COALESCE(reserved_quantity, 0)::float8 AS reserved FROM stock_quant WHERE product_id = $1 AND location_id = $2 AND lot_id = $3 AND package_id IS NOT DISTINCT FROM $4 AND owner_id IS NULL",
          [ml.product_id, ml.location_id, ml.lot_id, ml.package_id]);
        if (quants.length !== 1 || (await uomCompare(env, quants[0]!.reserved, ml.qpu)) < 0) throw new NotPorted("stock.move.line unlink of a lot's reservation over several quants or more than reserved");
      }
      await updateAvailableQuantity(env, ml.product_id, ml.location_id, 0, -ml.qpu, null, ml.lot_id, ml.package_id);
    }
    if (lines.some((ml) => ml.state === "done" || ml.state === "cancel")) {
      throw new UserError(translate(env, "Deleting product moves after the transfer is done?\n\nThat would be like going back in time to revert all operations triggered after this move. Who knows what the end result would be, So let's not do it.\n\nTry changing the “done” quantity to 0 instead."));
    }
    const allPkgs = resultPkgs.length ? await (await import("./sweep2_stock_sale")).getAllPackageDestIds(env, resultPkgs) : [];
    const cur = UNLINKED_STATE.get(env.cr) ?? { moves: [], pickings: [], packages: [] };
    cur.moves.push(...moves);
    cur.pickings.push(...pickings);
    cur.packages.push(...allPkgs);
    UNLINKED_STATE.set(env.cr, cur);
  },
});

// :571-584 after super().unlink(): `_get_lines_not_entire_pack`, `_recompute_state`, isolated package_dest_id cleanup
const UNLINKED_STATE = new WeakMap<object, { moves: number[]; pickings: number[]; packages: number[] }>();
registerHooks("stock.move.line", {
  write: [{
    afterUnlink: async (env) => {
      const state = UNLINKED_STATE.get(env.cr);
      UNLINKED_STATE.delete(env.cr);
      if (!state) return;
      const { clearNotEntirePackLines, clearIsolatedPackageDests } = await import("./sweep2_stock_sale");
      if (state.pickings.length) await clearNotEntirePackLines(env, state.pickings);
      if (state.moves.length) {
        const alive = (await rows<{ id: number }>(env, "SELECT id FROM stock_move WHERE id = ANY($1::int[])", [state.moves])).map((r) => r.id);
        await recomputeState(env, state.moves.filter((m) => alive.includes(m)));
      }
      if (state.packages.length) await clearIsolatedPackageDests(env, state.packages);
    },
  }],
});

// stock_move_line.py:349-432 create: the company and `picked` of the move, then the quants' reservation of the lines
// that do not bypass it and `_recompute_state` of their moves. Lines without a move and done lines refuse.
registerOverrides("stock.move.line", {
  create: async (env, valsList, next) => {
    const su = env.sudo();
    const moveDef = env.reg.model("stock.move");
    for (const vals of valsList) {
      const move = typeof vals["move_id"] === "number" ? vals["move_id"] : null;
      if (move === null) throw new NotPorted("stock.move.line create without a move (_get_linkable_moves, create_move)");
      const m = new DbRec(su, moveDef, move);
      vals["company_id"] = Number(await m.get("company_id"));
      if (!("picked" in vals)) vals["picked"] = Boolean(await m.get("picked"));
      if (vals["quant_id"]) throw new NotPorted("stock.move.line create from a quant (_copy_quant_info)");
      if (vals["state"] === "done" || vals["owner_id"]) throw new NotPorted("stock.move.line create with an owner or done");
    }
    const created = await next(env, valsList);
    // the related `date` (move_id.date) is the move's value as cached, microseconds included (fields_temporal.py:300-301
    // `to_datetime` keeps them); the port's datetime values are whole seconds, so the column is copied as it is
    await env.cr.query("UPDATE stock_move_line l SET date = m.date FROM stock_move m WHERE l.id = ANY($1::int[]) AND m.id = l.move_id AND l.date IS DISTINCT FROM m.date", [created]);
    const lineDef = env.reg.model("stock.move.line");
    const recompute: number[] = [];
    for (const id of created) {
      const l = new DbRec(su, lineDef, id);
      if ((await l.get("state")) === "done") continue;
      const moveId = Number(await l.get("move_id"));
      const m = new DbRec(su, moveDef, moveId);
      const locId = Number(await m.get("location_id"));
      const prod = await m.rel("product_id");
      const storable = Boolean(prod && await prod.get("is_storable"));
      const reservation = !((await bypassLocation(env, locId)) || !storable);
      const qty = Number((await l.get("quantity_product_uom")) ?? 0);
      if (qty && reservation) {
        const lotVal = await l.get("lot_id");
        const pkgVal = await l.get("package_id");
        await updateAvailableQuantity(env, Number(await l.get("product_id")), Number(await l.get("location_id")), 0, qty, null, typeof lotVal === "number" ? lotVal : null, typeof pkgVal === "number" ? pkgVal : null);
        if (!recompute.includes(moveId)) recompute.push(moveId);
      }
    }
    await recomputeState(env, recompute);
    return created;
  },
});

// stock_move.py:434-466 `_compute_quantity`: the lines' quantities in the move's unit (round=False), summed per unit in SQL
registerRecordCompute("stock.move", {
  quantity: async (env, rec) => {
    const uom = relId(await rec.get("uom_id"));
    if (rec.id === null) {
      // :445-448 the onchange branch `_quantity_sml`
      let total = 0;
      for (const line of await rec.rels("move_line_ids")) {
        const lineUom = relId(await line.get("uom_id"));
        const q = Number((await line.get("quantity")) ?? 0);
        total += lineUom !== null && uom !== null && lineUom !== uom ? await uomQuantityRaw(env, q, lineUom, uom) : q;
      }
      return total;
    }
    const sums = await rows<{ uom_id: number; q: number }>(env, "SELECT uom_id, sum(quantity)::float8 AS q FROM stock_move_line WHERE move_id = $1 GROUP BY uom_id ORDER BY uom_id", [rec.id]);
    let total = 0;
    for (const s of sums) total += s.uom_id === uom ? s.q : await uomQuantityRaw(env, s.q, s.uom_id, uom);
    return total;
  },
});

/** uom_uom.py `_compute_quantity(qty, to_unit, round=False)`. */
export async function uomQuantityRaw(env: Environment, qty: number, from: number, to: number | null): Promise<number> {
  if (to === null || from === to) return qty;
  const f = await rows<{ id: number; factor: number }>(env, "SELECT id, factor::float8 AS factor FROM uom_uom WHERE id = ANY($1::int[])", [[from, to]]);
  const factor = (id: number): number => f.find((r) => r.id === id)!.factor;
  return qty * factor(from) / factor(to);
}

/** stock_location.py:374-404 `_get_next_inventory_date` (the location's cyclic date, the company's annual date). */
export async function nextInventoryDate(env: Environment, location: number): Promise<string | null> {
  const [l] = await rows<{ usage: string; next: string | null; month: string | null; day: number | null }>(env,
    `SELECT l.usage, l.next_inventory_date::text AS next, c.annual_inventory_month AS month, c.annual_inventory_day AS day
       FROM stock_location l LEFT JOIN res_company c ON c.id = l.company_id WHERE l.id = $1`, [location]);
  if (!l || !["internal", "transit"].includes(l.usage)) return null;
  let company: string | null = null;
  if (l.month) {
    const today = await contextToday(env);
    const year = Number(today.slice(0, 4)), month = Number(l.month);
    const lastDay = (y: number): number => new Date(Date.UTC(y, month, 0)).getUTCDate();
    const want = Math.max(l.day ?? 0, 1);
    const fmt = (y: number, d: number): string => `${String(y).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    company = fmt(year, Math.min(want, lastDay(year)));
    if (company <= today) company = fmt(year + 1, Math.min(Math.min(want, lastDay(year)), lastDay(year + 1)));
  }
  if (l.next) return company ? (l.next < company ? l.next : company) : l.next;
  return company;
}

defineComputes("stock.quant", {
  // stock_quant.py:218-228
  inventory_quantity_set: async () => true,
  inventory_diff_quantity: async (_env, rec) => ((await rec.get("inventory_quantity_set")) ? Number((await rec.get("inventory_quantity")) ?? 0) - Number((await rec.get("quantity")) ?? 0) : 0),
  // stock_quant.py:127-131 `_compute_inventory_date`: only quants without a date in internal or transit locations
  inventory_date: async (env, rec) => {
    const current = await rec.prev("inventory_date");
    if (current) return current;
    const loc = await rec.get("location_id");
    const location = typeof loc === "number" ? loc : Array.isArray(loc) ? Number(loc[0]) : null;
    return location === null ? current ?? null : (await nextInventoryDate(env, location)) ?? current ?? null;
  },
});
