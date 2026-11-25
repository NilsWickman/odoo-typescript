/**
 * The warehouse's configuration writes (stock/models/stock_warehouse.py with purchase_stock stock.py:74-152): a new
 * `reception_steps` or `delivery_steps` activates or archives the warehouse's locations, updates its operation types
 * (`_create_or_update_sequences_and_picking_types`), rebuilds the rules of its reception and delivery routes
 * (`_create_or_update_route`, `_find_existing_rule_or_create`) and the global MTO and buy rules
 * (`_create_or_update_global_routes_rules`). With them the overrides those writes go through: stock.location `write`
 * (stock_location.py:213-256, archiving a location archives its children), stock.route `write`
 * (stock_location.py:548-582, a route (un)archives its rules; its warehouses resync their global rules) and
 * stock.picking.type `write` (stock_picking_type.py:303-341).
 *
 * A new name or code renames the routes, rules and sequences (`_update_name_and_code`) and the view location.
 *
 * Create (stock_warehouse.py:113-162): the view location and the warehouse's locations, the sequences and operation
 * types, the reception and delivery routes with their rules, the global MTO and buy rules, the address's transit
 * properties per company and the multi-warehouse group (`_check_multiwarehouse_group`, which saves the settings with
 * multiple locations through `res.config.settings.execute`, src/models/res_config_settings_save.ts). Archiving
 * (`'active' in vals`) archives the operation types, locations, routes and rules.
 *
 * Refused with NotPorted before anything is written: a missing location, operation type, route or global rule on a
 * write (they would be created), unarchiving a warehouse, a new address (the inter-warehouse properties), resupply
 * warehouses, `buy_to_resupply` on a write, a global route that would be copied, removing the multi-warehouse group,
 * and the operation types' reservation method.
 */
import { NotPorted, UserError } from "../errors";
import { create } from "../orm/create";
import { and, cond, TRUE as TRUE_DOMAIN } from "../orm/domain";
import { registerOverrides, write } from "../orm/write";
import type { Environment } from "../orm/types";
import { translate } from "./util";

type Vals = Record<string, unknown>;

const LOCATION_FIELDS = ["lot_stock_id", "wh_input_stock_loc_id", "wh_qc_stock_loc_id", "wh_output_stock_loc_id", "wh_pack_stock_loc_id"] as const;
const TYPE_FIELDS = ["in_type_id", "out_type_id", "pick_type_id", "pack_type_id", "qc_type_id", "store_type_id", "int_type_id", "xdock_type_id"] as const;
/** `_get_routes_values` depends (purchase_stock's reception route adds buy_to_resupply) and the global rules' depends. */
const ROUTE_DEPENDS = ["reception_steps", "buy_to_resupply", "delivery_steps"];
const GLOBAL_RULE_FIELDS = ["mto_pull_id", "buy_pull_id"] as const;
const GLOBAL_DEPENDS = ["delivery_steps", "reception_steps", "buy_to_resupply"];

/** stock_warehouse.py:13-20 ROUTE_NAMES (LazyTranslate of the stock module). */
const ROUTE_NAMES: Readonly<Record<string, string>> = {
  one_step: "Receive in 1 step (stock)",
  two_steps: "Receive in 2 steps (input + stock)",
  three_steps: "Receive in 3 steps (input + quality + stock)",
  ship_only: "Deliver in 1 step (ship)",
  pick_ship: "Deliver in 2 steps (pick + ship)",
  pick_pack_ship: "Deliver in 3 steps (pick + pack + ship)",
};

interface Wh {
  id: number; name: string; code: string; company_id: number; active: boolean; reception_steps: string; delivery_steps: string;
  lot_stock_id: number | null; view_location_id: number | null; wh_input_stock_loc_id: number | null; wh_qc_stock_loc_id: number | null;
  wh_output_stock_loc_id: number | null; wh_pack_stock_loc_id: number | null; mto_pull_id: number | null; buy_pull_id: number | null;
  reception_route_id: number | null; delivery_route_id: number | null; in_type_id: number | null; out_type_id: number | null; pick_type_id: number | null;
  pack_type_id: number | null; qc_type_id: number | null; store_type_id: number | null; int_type_id: number | null; xdock_type_id: number | null;
}

async function warehouse(env: Environment, id: number): Promise<Wh> {
  const [row] = (await env.cr.query<Wh>(
    `SELECT id, name, code, company_id, active, reception_steps, delivery_steps, lot_stock_id, view_location_id, wh_input_stock_loc_id, wh_qc_stock_loc_id,
            wh_output_stock_loc_id, wh_pack_stock_loc_id, mto_pull_id, buy_pull_id, reception_route_id, delivery_route_id, in_type_id, out_type_id, pick_type_id,
            pack_type_id, qc_type_id, store_type_id, int_type_id, xdock_type_id
       FROM stock_warehouse WHERE id = $1`, [id])).rows;
  if (!row) throw new NotPorted(`stock.warehouse ${id} missing`);
  return row;
}

async function locationName(env: Environment, id: number | null): Promise<string> {
  if (!id) return "";
  return (await env.cr.query<{ name: string }>("SELECT name FROM stock_location WHERE id = $1", [id])).rows[0]?.name ?? "";
}

/** stock_warehouse.py:674-680 `_format_rulename`. */
async function ruleName(env: Environment, wh: Wh, from: number | null, dest: number | null, suffix: string): Promise<string> {
  let name = `${wh.code}: ${await locationName(env, from)}`;
  if (dest) name += ` → ${await locationName(env, dest)}`;
  if (suffix) name += ` (${suffix})`;
  return name;
}

/** :682-685 `_format_routename` with :766-767 `_get_route_name` (translated in the user's language). */
function routeName(env: Environment, wh: Wh, routeType: string): string {
  return `${wh.name}: ${translate(env, ROUTE_NAMES[routeType]!, "stock")}`;
}

/** :753-765 `_get_partner_locations`: the data locations, else the first location of the usage. */
async function partnerLocations(env: Environment): Promise<{ customer: number; supplier: number }> {
  const byXmlid = async (xmlid: string, usage: string): Promise<number | null> => {
    const id = await env.reg.xmlid(env.cr, xmlid);
    if (id && (await env.cr.query("SELECT 1 FROM stock_location WHERE id = $1", [id])).rows.length) return id;
    throw new NotPorted(`stock.warehouse._get_partner_locations without ${xmlid} (the first ${usage} location)`);
  };
  return { customer: (await byXmlid("stock.stock_location_customers", "customer"))!, supplier: (await byXmlid("stock.stock_location_suppliers", "supplier"))! };
}

interface Routing { from: number | null; dest: number | null; type: number | null; action: string }

/** :769-794 `get_rules_dict` with purchase_stock stock.py:135-139 (`_get_receive_rules_dict` :796-810 for the receptions). */
async function rulesDict(env: Environment, wh: Wh): Promise<Record<string, Routing[]>> {
  const { customer } = await partnerLocations(env);
  const r = (from: number | null, dest: number | null, type: number | null, action: string): Routing => ({ from, dest, type, action });
  return {
    one_step: [],
    two_steps: [r(wh.wh_input_stock_loc_id, wh.lot_stock_id, wh.store_type_id, "push")],
    three_steps: [r(wh.wh_input_stock_loc_id, wh.wh_qc_stock_loc_id, wh.qc_type_id, "push"), r(wh.wh_qc_stock_loc_id, wh.lot_stock_id, wh.store_type_id, "push")],
    ship_only: [r(wh.lot_stock_id, customer, wh.out_type_id, "pull")],
    pick_ship: [r(wh.lot_stock_id, customer, wh.pick_type_id, "pull"), r(wh.wh_output_stock_loc_id, customer, wh.out_type_id, "push")],
    pick_pack_ship: [r(wh.lot_stock_id, customer, wh.pick_type_id, "pull"), r(wh.wh_pack_stock_loc_id, wh.wh_output_stock_loc_id, wh.pack_type_id, "push"),
      r(wh.wh_output_stock_loc_id, customer, wh.out_type_id, "push")],
  };
}

/** :745-747 `_get_input_output_locations`. */
function inputOutput(wh: Wh, reception: string | null | undefined, delivery: string | null | undefined): [number | null, number | null] {
  return [reception === "one_step" ? wh.lot_stock_id : wh.wh_input_stock_loc_id, delivery === "ship_only" ? wh.lot_stock_id : wh.wh_output_stock_loc_id];
}

/** :388-401 `_find_or_create_global_route`: the data route of the warehouse's company or of none; the search by name and
 *  the copy refuse. */
async function globalRoute(env: Environment, wh: Wh, xmlid: string): Promise<number> {
  const data = await env.reg.xmlid(env.cr, xmlid);
  const [row] = data ? (await env.cr.query<{ c: number | null }>("SELECT company_id AS c FROM stock_route WHERE id = $1", [data])).rows : [];
  if (!data || !row || (row.c && row.c !== wh.company_id)) throw new NotPorted(`stock.warehouse._find_or_create_global_route without ${xmlid} for the company`);
  return data;
}

/** The `buy_to_resupply` a warehouse's create left in Odoo's cache (the field has no `@depends`, so the writes of the
 *  create do not invalidate it), per transaction. */
const BUY_CACHE = new WeakMap<object, Map<number, boolean>>();

/** purchase_stock stock.py:83-86 `_compute_buy_to_resupply`. */
async function buyToResupply(env: Environment, wh: Wh): Promise<boolean> {
  const cached = BUY_CACHE.get(env.cr)?.get(wh.id);
  if (cached !== undefined) return cached;
  if (!wh.buy_pull_id) return false;
  const [row] = (await env.cr.query<{ linked: boolean; selectable: boolean | null; any: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM stock_route_warehouse rw WHERE rw.route_id = r.id AND rw.warehouse_id = $2) AS linked, r.warehouse_selectable AS selectable,
            EXISTS (SELECT 1 FROM stock_route_warehouse rw WHERE rw.route_id = r.id) AS any
       FROM stock_rule x JOIN stock_route r ON r.id = x.route_id WHERE x.id = $1`, [wh.buy_pull_id, wh.id])).rows;
  if (!row) return false;
  return row.linked || (Boolean(row.selectable) && !row.any);
}

interface GlobalRule { depends: string[]; create: Vals; update: Vals }

/** :403-447 `_get_global_route_rules_values` / `_generate_global_route_rules_values` with purchase_stock stock.py:107-128. */
async function globalRulesValues(env: Environment, wh: Wh): Promise<Map<string, GlobalRule>> {
  const dict = await rulesDict(env, wh);
  const routing = (dict[wh.delivery_steps] ?? []).find((r) => r.from === wh.lot_stock_id);
  if (!routing) throw new NotPorted(`stock.warehouse delivery steps ${wh.delivery_steps}`);
  const mtoRoute = await globalRoute(env, wh, "stock.route_warehouse0_mto");
  const buyRoute = await globalRoute(env, wh, "purchase_stock.route_warehouse0_buy");
  const out = new Map<string, GlobalRule>();
  const mto: GlobalRule = {
    depends: ["delivery_steps"],
    create: { active: true, procure_method: "make_to_order", company_id: wh.company_id, action: "pull", auto: "manual", propagate_carrier: true, route_id: mtoRoute },
    update: { name: await ruleName(env, wh, routing.from, routing.dest, "MTO"), location_dest_id: routing.dest, location_src_id: routing.from, picking_type_id: routing.type ?? false },
  };
  const buy: GlobalRule = {
    depends: ["reception_steps", "buy_to_resupply"],
    create: { action: "buy", picking_type_id: wh.in_type_id ?? false, company_id: wh.company_id, route_id: buyRoute, propagate_cancel: wh.reception_steps !== "one_step" },
    update: { active: await buyToResupply(env, wh), name: await ruleName(env, wh, wh.lot_stock_id, null, "Buy"), location_dest_id: wh.lot_stock_id, propagate_cancel: wh.reception_steps !== "one_step" },
  };
  out.set("mto_pull_id", mto);
  out.set("buy_pull_id", buy);
  return out;
}

/** :372-386 `_create_or_update_global_routes_rules`. */
async function createOrUpdateGlobalRules(env: Environment, whId: number): Promise<void> {
  // the values are computed once (`_get_global_route_rules_values()` before the loop), the rule fields read per field
  const values = await globalRulesValues(env, await warehouse(env, whId));
  for (const [field, details] of values) {
    const wh = await warehouse(env, whId);
    const rule = wh[field as "mto_pull_id" | "buy_pull_id"];
    if (rule) await write(env, "stock.rule", [rule], details.update);
    else {
      // :382-384 `self[rule_field] = create(...)`: a write of the warehouse, whose override runs this method again
      const [created] = await create(env, "stock.rule", [{ ...details.update, ...details.create, warehouse_id: wh.id }]);
      await write(env, "stock.warehouse", [wh.id], { [field]: created });
    }
  }
}

/** :960-1000 `_get_picking_type_update_values`. */
function pickingTypeUpdateValues(wh: Wh): Record<string, Vals> {
  const [input, output] = inputOutput(wh, wh.reception_steps, wh.delivery_steps);
  const code = wh.code.replace(/ /g, "").toUpperCase();
  return {
    in_type_id: { default_location_dest_id: input ?? false, barcode: code + "IN" },
    out_type_id: { default_location_src_id: output ?? false, barcode: code + "OUT" },
    pick_type_id: {
      active: wh.delivery_steps !== "ship_only" && wh.active,
      default_location_dest_id: (wh.delivery_steps === "pick_ship" ? output : wh.wh_pack_stock_loc_id) ?? false, barcode: code + "PICK",
    },
    pack_type_id: { active: wh.delivery_steps === "pick_pack_ship" && wh.active, default_location_dest_id: output ?? false, barcode: code + "PACK" },
    qc_type_id: { active: wh.reception_steps === "three_steps" && wh.active, barcode: code + "QC" },
    store_type_id: {
      active: wh.reception_steps !== "one_step" && wh.active,
      default_location_src_id: (wh.reception_steps === "two_steps" ? input : wh.wh_qc_stock_loc_id) ?? false, barcode: code + "STOR",
    },
    int_type_id: { barcode: code + "INT" },
    xdock_type_id: { active: wh.reception_steps !== "one_step" && wh.delivery_steps !== "ship_only" && wh.active, barcode: code + "XD" },
  };
}

/** :327-370 `_create_or_update_sequences_and_picking_types` for a warehouse whose operation types all exist. */
async function sequencesAndPickingTypes(env: Environment, whId: number): Promise<Vals> {
  const wh = await warehouse(env, whId);
  const data = pickingTypeUpdateValues(wh);
  for (const field of TYPE_FIELDS) {
    const type = wh[field];
    if (!type) throw new NotPorted(`stock.warehouse._create_or_update_sequences_and_picking_types creating ${field}`);
    const [seq] = (await env.cr.query<{ s: number | null }>("SELECT sequence_id AS s FROM stock_picking_type WHERE id = $1", [type])).rows;
    if (seq?.s) await write(env.sudo(), "ir.sequence", [seq.s], { company_id: wh.company_id });
    await write(env, "stock.picking.type", [type], data[field]!);
  }
  return {};
}

/** :826-855 `_get_rule_values`. */
async function ruleValues(env: Environment, wh: Wh, routings: readonly Routing[], values: Vals, suffix = ""): Promise<Vals[]> {
  const list: Vals[] = [];
  let first = true;
  for (const r of routings) {
    list.push({
      name: await ruleName(env, wh, r.from, r.dest, suffix), location_src_id: r.from ?? false, location_dest_id: r.dest ?? false, action: r.action, auto: "manual",
      picking_type_id: r.type ?? false, procure_method: first ? "make_to_stock" : "make_to_order", warehouse_id: wh.id, company_id: wh.company_id, ...values,
    });
    first = false;
  }
  // :385-395 the last step of a chain with cancel propagation stops it
  if (values["propagate_cancel"] && list.length) list[list.length - 1]!["propagate_cancel"] = false;
  return list;
}

/** :594-608 `_find_existing_rule_or_create`. */
async function findExistingRuleOrCreate(env: Environment, rules: readonly Vals[]): Promise<void> {
  for (const vals of rules) {
    const existing = (await env.cr.query<{ id: number }>(
      `SELECT id FROM stock_rule WHERE picking_type_id IS NOT DISTINCT FROM $1 AND location_src_id IS NOT DISTINCT FROM $2 AND location_dest_id IS NOT DISTINCT FROM $3
          AND route_id IS NOT DISTINCT FROM $4 AND action = $5 AND NOT active ORDER BY sequence, id`,
      [vals["picking_type_id"] || null, vals["location_src_id"] || null, vals["location_dest_id"] || null, vals["route_id"] || null, vals["action"]])).rows.map((r) => r.id);
    if (!existing.length) await create(env, "stock.rule", [vals]);
    else await write(env, "stock.rule", existing, { active: true });
  }
}

/** :449-500 `_create_or_update_route` with purchase_stock stock.py:100-105 (the buy route linked first) and :141-144. */
async function createOrUpdateRoute(env: Environment, whId: number): Promise<Vals> {
  let wh = await warehouse(env, whId);
  const buyRoute = await globalRoute(env, wh, "purchase_stock.route_warehouse0_buy");
  if (await buyToResupply(env, wh)) await write(env.sudo(), "stock.route", [buyRoute], { warehouse_ids: [[4, wh.id, 0]] });
  wh = await warehouse(env, whId);
  const dict = await rulesDict(env, wh);
  const routes: number[] = [];
  const spec: { field: "reception_route_id" | "delivery_route_id"; key: string; update: Vals; rules: Vals }[] = [
    // purchase_stock `_get_receive_routes_values` (stock_warehouse.py:558-592): the receptions' rules are make-to-order
    { field: "reception_route_id", key: wh.reception_steps, update: { name: routeName(env, wh, wh.reception_steps), active: wh.active },
      rules: { active: true, propagate_cancel: true, procure_method: "make_to_order" } },
    { field: "delivery_route_id", key: wh.delivery_steps, update: { name: routeName(env, wh, wh.delivery_steps), active: wh.active },
      rules: { active: true, propagate_carrier: true } },
  ];
  for (const s of spec) {
    const route = wh[s.field];
    if (!route) throw new NotPorted(`stock.warehouse._create_or_update_route creating ${s.field}`);
    await write(env, "stock.route", [route], s.update);
    const ruleIds = (await env.cr.query<{ id: number }>("SELECT id FROM stock_rule WHERE route_id = $1 ORDER BY sequence, id", [route])).rows.map((r) => r.id);
    await write(env, "stock.rule", ruleIds, { active: false });
    const routings = dict[s.key];
    if (!routings) throw new NotPorted(`stock.warehouse routing ${s.key}`);
    await findExistingRuleOrCreate(env, await ruleValues(env, wh, routings, { ...s.rules, route_id: route }));
    routes.push(route); // both routes are warehouse_selectable on creation
  }
  return { route_ids: routes.map((r) => [4, r, 0]) };
}

/** :660-676 `_create_missing_locations`: a missing location would be created, which refuses. */
async function assertNoMissingLocations(env: Environment, ids: readonly number[], vals: Vals): Promise<void> {
  for (const id of ids) {
    const wh = await warehouse(env, id);
    for (const f of LOCATION_FIELDS) if (!wh[f] && !(f in vals)) throw new NotPorted(`stock.warehouse._create_missing_locations (${f})`);
  }
}

/** :866-900 `_update_reception_delivery_resupply` with the warehouses' values before the write. */
async function updateReceptionDeliveryResupply(env: Environment, ids: readonly number[], reception: string | undefined, delivery: string | undefined): Promise<void> {
  for (const id of ids) {
    const wh = await warehouse(env, id);
    const [input] = inputOutput(wh, reception, delivery);
    if (reception && wh.reception_steps !== reception && (wh.reception_steps === "one_step" || reception === "one_step")) {
      // :875-883 `_check_reception_resupply`
      const rules = (await env.cr.query<{ id: number }>(
        `SELECT x.id FROM stock_rule x JOIN stock_route r ON r.id = x.route_id JOIN stock_location s ON s.id = x.location_src_id
          WHERE x.active AND r.supplier_wh_id = $1 AND x.action = 'push' AND s.usage = 'transit' ORDER BY x.sequence, x.id`, [id])).rows.map((r) => r.id);
      await write(env, "stock.rule", rules, { location_dest_id: input ?? false });
    }
    if (delivery && wh.delivery_steps !== delivery && (wh.delivery_steps === "ship_only" || delivery === "ship_only")) {
      // :885-900 `_check_delivery_resupply`
      const mtoRoute = wh.mto_pull_id ? (await env.cr.query<{ r: number | null }>("SELECT route_id AS r FROM stock_rule WHERE id = $1", [wh.mto_pull_id])).rows[0]?.r ?? null : null;
      const type = delivery === "ship_only" ? wh.out_type_id : wh.pick_type_id;
      const rules = (await env.cr.query<{ id: number }>(
        `SELECT x.id FROM stock_rule x JOIN stock_route r ON r.id = x.route_id JOIN stock_location d ON d.id = x.location_dest_id
          WHERE x.active AND (r.supplier_wh_id = $1 OR x.route_id = $2) AND x.action != 'push' AND x.location_src_id = $3 AND d.usage = 'transit'
          ORDER BY x.sequence, x.id`, [id, mtoRoute, wh.lot_stock_id])).rows.map((r) => r.id);
      await write(env, "stock.rule", rules, { picking_type_id: type ?? false });
    }
  }
}

/** :929-935 `_update_location_reception` / `_update_location_delivery`. */
async function setLocationsActive(env: Environment, ids: readonly number[], field: keyof Wh, active: boolean): Promise<void> {
  const locs = (await env.cr.query<{ l: number | null }>(`SELECT ${field} AS l FROM stock_warehouse WHERE id = ANY($1::int[]) ORDER BY sequence, id`, [[...ids]])).rows
    .map((r) => r.l).filter((l): l is number => l !== null);
  await write(env, "stock.location", [...new Set(locs)], { active });
}

const REFUSED_KEYS = ["partner_id", "resupply_wh_ids", "buy_to_resupply"];

/**
 * stock_warehouse.py:240-253, `'active' in vals` after the write: a warehouse whose operation types still have moves
 * that are neither done nor cancelled cannot be archived or unarchived (UserError, the types in the moves' order,
 * `format_list`); otherwise its operation types, locations, routes and rules follow (`archiveWarehouse`). Checked
 * before anything is written: the UserError rolls the write back in Odoo too (rådet runda 13, åtgärd 6).
 */
async function checkWarehouseActive(env: Environment, ids: readonly number[]): Promise<void> {
  for (const id of ids) {
    const types = await env.withContext({ ...env.context, active_test: false }).model("stock.picking.type").search(cond("warehouse_id", "=", id));
    const moves = types.length ? await env.model("stock.move").search(and([cond("picking_type_id", "in", types), cond("state", "not in", ["done", "cancel"])])) : [];
    if (!moves.length) continue;
    const lang = env.lang ?? "en_US";
    if (lang !== "en_US") throw new NotPorted(`the ongoing-operations error of a warehouse in ${lang} (format_list)`);
    const rows = await env.model("stock.move").read(moves, ["picking_type_id"], "");
    const seen: number[] = [];
    for (const r of rows) {
      const t = r["picking_type_id"];
      const tid = typeof t === "number" ? t : Array.isArray(t) ? Number(t[0]) : null;
      if (tid !== null && !seen.includes(tid)) seen.push(tid);
    }
    const names = (await env.model("stock.picking.type").read(seen, ["name"], "")).map((r) => String(r["name"]));
    // tools/i18n.py format_list (babel 'standard', en_US): "a", "a and b", "a, b, and c"
    const list = names.length <= 1 ? names.join("") : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
    const wh = (await env.model("stock.warehouse").read([id], ["name"], ""))[0]?.["name"];
    throw new UserError(translate(env, "You still have ongoing operations for operation types %(operations)s in warehouse %(warehouse)s", "stock")
      .replace("%(operations)s", list).replace("%(warehouse)s", String(wh)));
  }
}

/** stock_warehouse.py:220-253 `'active' in vals` after the write, for a warehouse without ongoing operations. */
async function archiveWarehouse(env: Environment, id: number, active: boolean): Promise<void> {
  const all = env.withContext({ ...env.context, active_test: false });
  const types = await all.model("stock.picking.type").search(cond("warehouse_id", "=", id));
  await write(env, "stock.picking.type", types, { active });
  const wh = await warehouse(env, id);
  const locations = wh.view_location_id ? await all.model("stock.location").search(cond("location_id", "child_of", wh.view_location_id)) : [];
  const using = await env.model("stock.picking.type").search(and([cond("default_location_src_id", "in", locations), cond("default_location_dest_id", "in", locations), cond("id", "not in", types)]));
  if (using.length) {
    const lang = env.lang ?? "en_US";
    if (lang !== "en_US") throw new NotPorted(`the default-locations error of a warehouse in ${lang} (format_list)`);
    const names = (await env.model("stock.picking.type").read(using, ["name"], "")).map((r) => String(r["name"]));
    const list = names.length <= 1 ? names.join("") : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
    throw new UserError(translate(env, "%(operations)s have default source or destination locations within warehouse %(warehouse)s, therefore you cannot archive it.", "stock")
      .replace("%(operations)s", list).replace("%(warehouse)s", wh.name));
  }
  if (wh.view_location_id) await write(env, "stock.location", [wh.view_location_id], { active });
  const rules = await all.model("stock.rule").search(cond("warehouse_id", "=", id));
  // `warehouse.route_ids` (as the user reads them) used by this warehouse alone
  const routes = await all.model("stock.route").search(cond("warehouse_ids", "in", [id]));
  const own: number[] = [];
  for (const r of routes) {
    const n = (await env.cr.query<{ n: number }>("SELECT count(*)::int AS n FROM stock_route_warehouse WHERE route_id = $1", [r])).rows[0]?.n ?? 0;
    if (n === 1) own.push(r);
  }
  await write(env, "stock.route", own, { active });
  await write(env, "stock.rule", rules, { active });
  if (active) throw new NotPorted("stock.warehouse unarchive (the steps written again to reactivate their records)");
}

/** :1084-1131 `_get_sequence_values` for a new name or code (the current ones otherwise). */
function sequenceValues(env: Environment, wh: Wh, name: string | null, code: string | null): Record<string, Vals> {
  const n = name || wh.name, c = code || wh.code;
  const v = (label: string, suffix: string): Vals => ({
    name: translate(env, `%(name)s Sequence ${label}`, "stock").replace("%(name)s", n), prefix: `${c}/${suffix}/`, padding: 5, company_id: wh.company_id,
  });
  return {
    in_type_id: v("in", "IN"), out_type_id: v("out", "OUT"), pack_type_id: v("packing", "PACK"), pick_type_id: v("picking", "PICK"),
    qc_type_id: v("quality control", "QC"), store_type_id: v("storage", "STOR"), int_type_id: v("internal", "INT"), xdock_type_id: v("cross dock", "XD"),
  };
}

/** A translated name as the user reads it (the env's language, else en_US). */
async function nameOf(env: Environment, table: "stock_route" | "stock_rule", id: number): Promise<string> {
  return (await env.cr.query<{ n: string | null }>(`SELECT COALESCE(name->>$2, name->>'en_US') AS n FROM ${table} WHERE id = $1`, [id, env.lang ?? "en_US"])).rows[0]?.n ?? "";
}

/** Python's `str.replace(old, new, 1)`. */
const replaceFirst = (s: string, from: string, to: string): string => {
  const i = s.indexOf(from);
  return i < 0 ? s : s.slice(0, i) + to + s.slice(i + from.length);
};

/** :902-927 `_update_name_and_code` with purchase_stock stock.py:146-152 (the buy rule), before the write. */
async function updateNameAndCode(env: Environment, ids: readonly number[], newName: string | null, newCode: string | null): Promise<void> {
  if (newCode) {
    const views = (await env.cr.query<{ v: number }>(
      "SELECT DISTINCT l.location_id AS v FROM stock_warehouse w JOIN stock_location l ON l.id = w.lot_stock_id WHERE w.id = ANY($1::int[]) AND l.location_id IS NOT NULL ORDER BY 1", [[...ids]])).rows.map((r) => r.v);
    if (views.length) await write(env, "stock.location", views, { name: newCode });
  }
  if (newName) {
    for (const id of ids) {
      const wh = await warehouse(env, id);
      // `warehouse.route_ids` and `route.rule_ids` as the user reads them (record rules: another company's rule of a
      // shared route is not there), archived ones too (the warehouses' active_test=False)
      const routes = await env.model("stock.route").search(cond("warehouse_ids", "in", [id]), { activeTest: false });
      for (const route of routes) {
        await write(env, "stock.route", [route], { name: replaceFirst(await nameOf(env, "stock_route", route), wh.name, newName) });
        const rules = await env.model("stock.rule").search(cond("route_id", "=", route), { activeTest: false });
        for (const rule of rules) await write(env, "stock.rule", [rule], { name: replaceFirst(await nameOf(env, "stock_rule", rule), wh.name, newName) });
      }
      if (wh.mto_pull_id) await write(env, "stock.rule", [wh.mto_pull_id], { name: replaceFirst(await nameOf(env, "stock_rule", wh.mto_pull_id), wh.name, newName) });
    }
  }
  const { hasGroup } = await import("../orm/env");
  const manager = await hasGroup(env, "stock.group_stock_manager");
  for (const id of ids) {
    const wh = await warehouse(env, id);
    const data = sequenceValues(env, wh, newName, newCode);
    const senv = manager ? env.sudo() : env;
    for (const field of ["in_type_id", "qc_type_id", "store_type_id", "out_type_id", "pack_type_id", "pick_type_id", "int_type_id", "xdock_type_id"] as const) {
      const type = wh[field];
      const seq = type ? (await env.cr.query<{ s: number | null }>("SELECT sequence_id AS s FROM stock_picking_type WHERE id = $1", [type])).rows[0]?.s ?? null : null;
      if (seq) await write(senv, "ir.sequence", [seq], data[field]!);
    }
  }
  // purchase_stock: the first warehouse's buy rule
  const first = ids.length ? await warehouse(env, ids[0]!) : null;
  if (first?.buy_pull_id && newName) {
    await write(env, "stock.rule", [first.buy_pull_id], { name: replaceFirst(await nameOf(env, "stock_rule", first.buy_pull_id), first.name, newName) });
  }
}

registerOverrides("stock.warehouse", {
  // stock_warehouse.py:174-301 write
  write: async (env0, ids, vals, next) => {
    for (const k of REFUSED_KEYS) {
      if (k in vals && (k !== "resupply_wh_ids" || (vals[k] && !vals["resupply_route_ids"]))) throw new NotPorted(`stock.warehouse.write of ${k}`);
    }
    if ("company_id" in vals) {
      const other = (await env0.cr.query("SELECT 1 FROM stock_warehouse WHERE id = ANY($1::int[]) AND company_id IS DISTINCT FROM $2 LIMIT 1", [[...ids], vals["company_id"] || null])).rows.length;
      if (other) throw new UserError(translate(env0, "Changing the company of this record is forbidden at this point, you should rather archive it and create a new one."));
    }
    // the ongoing-operations UserError, checked before anything is written (Odoo's rolls the write back)
    if ("active" in vals) await checkWarehouseActive(env0, ids);
    // :181 the warehouses without the active filter
    const env = env0.withContext({ ...env0.context, active_test: false });
    await assertNoMissingLocations(env, ids, vals);
    const reception = vals["reception_steps"] ? String(vals["reception_steps"]) : undefined;
    const delivery = vals["delivery_steps"] ? String(vals["delivery_steps"]) : undefined;
    if (reception || delivery) {
      // refuse before anything is written: the operation types, routes and global rules must exist
      for (const id of ids) {
        const wh = await warehouse(env, id);
        for (const f of [...TYPE_FIELDS, "reception_route_id", "delivery_route_id", ...GLOBAL_RULE_FIELDS] as const) {
          if (!wh[f]) throw new NotPorted(`stock.warehouse.write of the steps creating ${f}`);
        }
        await globalRulesValues(env, wh);
      }
    }
    if (reception) {
      await setLocationsActive(env, ids, "wh_qc_stock_loc_id", reception === "three_steps");
      await setLocationsActive(env, ids, "wh_input_stock_loc_id", reception !== "one_step");
    }
    if (delivery) {
      await setLocationsActive(env, ids, "wh_pack_stock_loc_id", delivery === "pick_pack_ship");
      await setLocationsActive(env, ids, "wh_output_stock_loc_id", delivery !== "ship_only");
    }
    if (reception || delivery) await updateReceptionDeliveryResupply(env, ids, reception, delivery);
    if (vals["code"] || vals["name"]) await updateNameAndCode(env, ids, vals["name"] ? String(vals["name"]) : null, vals["code"] ? String(vals["code"]) : null);
    await next(env, ids, vals);
    const keys = Object.keys(vals);
    for (const id of ids) {
      // :245-249 a new code or a step updates the operation types (their barcodes), a step the routes too
      if (keys.includes("code") || ROUTE_DEPENDS.some((d) => keys.includes(d))) {
        const typeVals = await sequencesAndPickingTypes(env, id);
        if (Object.keys(typeVals).length) await write(env, "stock.warehouse", [id], typeVals);
      }
      if (ROUTE_DEPENDS.some((d) => keys.includes(d))) {
        const routeVals = await createOrUpdateRoute(env, id);
        await write(env, "stock.warehouse", [id], routeVals);
      }
      if (keys.some((k) => (GLOBAL_RULE_FIELDS as readonly string[]).includes(k) || GLOBAL_DEPENDS.includes(k))) await createOrUpdateGlobalRules(env, id);
      if ("active" in vals) await archiveWarehouse(env0, id, Boolean(vals["active"]));
    }
    // :299-300
    if ("active" in vals) await checkMultiwarehouseGroup(env0);
  },
  // :303-306 unlink, then the multi-warehouse group
  unlink: async (env, ids, next) => {
    await next(env, ids);
    await checkMultiwarehouseGroup(env);
  },
});

// --------------------------------------------------------------------------------------------- stock.warehouse create

/** `user.has_group(xmlid)` read now (the groups may have changed in this request: the settings' execute). */
async function userHas(env: Environment, xmlid: string): Promise<boolean> {
  if (env.su && env.uid === 1) return true;
  const gid = await env.reg.xmlid(env.cr, xmlid);
  if (gid === null) return false;
  const r = await env.cr.query(
    `WITH RECURSIVE g(id) AS (SELECT gid FROM res_groups_users_rel WHERE uid = $1
       UNION SELECT r.hid FROM res_groups_implied_rel r JOIN g ON r.gid = g.id) SELECT 1 FROM g WHERE id = $2`, [env.uid, gid]);
  return r.rows.length > 0;
}

/** :653-658 `_valid_barcode`: the barcode, or False when a location of the company (archived ones too) has it. */
async function validBarcode(env: Environment, barcode: string, company: unknown): Promise<string | false> {
  const found = await env.withContext({ ...env.context, active_test: false }).model("stock.location")
    .search(and([cond("barcode", "=", barcode), cond("company_id", "=", company ?? false)]));
  return found.length ? false : barcode;
}

/** :610-651 `_get_locations_values`. */
async function locationsValues(env: Environment, vals: Vals): Promise<[typeof LOCATION_FIELDS[number], Vals][]> {
  const { defaultGet } = await import("../web/defaults");
  const def = await defaultGet(env, "stock.warehouse", ["reception_steps", "delivery_steps"]);
  const reception = "reception_steps" in vals ? vals["reception_steps"] : def["reception_steps"];
  const delivery = "delivery_steps" in vals ? vals["delivery_steps"] : def["delivery_steps"];
  const code = String(vals["code"] || "").replace(/ /g, "").toUpperCase();
  const company = "company_id" in vals ? vals["company_id"] : (await defaultGet(env, "stock.warehouse", ["company_id"]))["company_id"];
  const t = (s: string): string => translate(env, s, "stock");
  return [
    ["lot_stock_id", { name: t("Stock"), active: true, usage: "internal", replenish_location: true, barcode: await validBarcode(env, code + "STOCK", company) }],
    ["wh_input_stock_loc_id", { name: t("Input"), active: reception !== "one_step", usage: "internal", barcode: await validBarcode(env, code + "INPUT", company) }],
    ["wh_qc_stock_loc_id", { name: t("Quality Control"), active: reception === "three_steps", usage: "internal", barcode: await validBarcode(env, code + "QUALITY", company) }],
    ["wh_output_stock_loc_id", { name: t("Output"), active: delivery !== "ship_only", usage: "internal", barcode: await validBarcode(env, code + "OUTPUT", company) }],
    ["wh_pack_stock_loc_id", { name: t("Packing Zone"), active: delivery === "pick_pack_ship", usage: "internal", barcode: await validBarcode(env, code + "PACKING", company) }],
  ];
}

/** :1002-1082 `_get_picking_type_create_values`. */
async function pickingTypeCreateValues(env: Environment, wh: Wh, max: number): Promise<[Record<string, Vals>, number]> {
  const [, output] = inputOutput(wh, wh.reception_steps, wh.delivery_steps);
  const batch = await userHas(env, "stock.group_stock_picking_batch");
  const t = (s: string): string => translate(env, s, "stock");
  const c = wh.company_id;
  return [{
    in_type_id: { name: t("Receipts"), code: "incoming", use_existing_lots: false, sequence: max + 1, company_id: c, auto_show_allocation_report: true, auto_batch: batch, batch_group_by_partner: batch },
    out_type_id: { name: t("Delivery Orders"), code: "outgoing", use_create_lots: false, sequence: max + 7, print_label: true, company_id: c, auto_batch: batch, batch_group_by_partner: batch },
    pack_type_id: { name: t("Pack"), code: "internal", use_create_lots: false, use_existing_lots: true, default_location_src_id: wh.wh_pack_stock_loc_id ?? false, default_location_dest_id: output ?? false, sequence: max + 6, company_id: c },
    pick_type_id: { name: t("Pick"), code: "internal", use_create_lots: false, use_existing_lots: true, default_location_src_id: wh.lot_stock_id ?? false, sequence: max + 5, company_id: c },
    qc_type_id: { name: t("Quality Control"), code: "internal", use_create_lots: false, use_existing_lots: true, default_location_src_id: wh.wh_input_stock_loc_id ?? false, default_location_dest_id: wh.wh_qc_stock_loc_id ?? false, sequence: max + 2, company_id: c },
    store_type_id: { name: t("Storage"), code: "internal", use_create_lots: false, use_existing_lots: true, default_location_dest_id: wh.lot_stock_id ?? false, sequence: max + 3, company_id: c },
    int_type_id: { name: t("Internal Transfers"), code: "internal", use_create_lots: false, use_existing_lots: true, default_location_src_id: wh.lot_stock_id ?? false, default_location_dest_id: wh.lot_stock_id ?? false,
      active: await userHas(env, "stock.group_stock_multi_locations"), sequence: max + 4, company_id: c },
    xdock_type_id: { name: t("Cross Dock"), code: "internal", use_create_lots: false, use_existing_lots: true, default_location_src_id: wh.wh_input_stock_loc_id ?? false, default_location_dest_id: wh.wh_output_stock_loc_id ?? false, sequence: max + 8, company_id: c },
  }, max + 9];
}

/** :327-370 `_create_or_update_sequences_and_picking_types` for a new warehouse (no operation type yet). */
async function createSequencesAndPickingTypes(env: Environment, whId: number): Promise<Vals> {
  const wh = await warehouse(env, whId);
  const types = env.model("stock.picking.type");
  // :337-339 the next free color of the warehouses' operation types
  const colored = await types.search(and([cond("warehouse_id", "!=", false), cond("color", "!=", false)]), { order: "color" });
  const used = new Set((await types.read(colored, ["color"], "")).map((r) => r["color"]));
  const color = [...Array(12).keys()].find((z) => !used.has(z)) ?? 0;
  const sequenceData = sequenceValues(env, wh, null, null);
  // :344-345 the highest sequence of the operation types the user reads
  const top = await types.search(cond("sequence", "!=", false), { order: "sequence desc", limit: 1 });
  const max = top.length ? Number((await types.read(top, ["sequence"], ""))[0]?.["sequence"] ?? 0) || 0 : 0;
  const data = pickingTypeUpdateValues(wh);
  const [createData] = await pickingTypeCreateValues(env, wh, max);
  const su = env.sudo();
  const out: Record<string, number> = {};
  for (const field of TYPE_FIELDS) {
    if (wh[field]) throw new NotPorted(`stock.warehouse create with an existing ${field}`);
    const values: Vals = { ...data[field]!, ...createData[field]! };
    const seq = sequenceData[field]!;
    const existing = await su.model("ir.sequence").search(and([cond("company_id", "=", seq["company_id"] ?? false), cond("name", "=", seq["name"])]), { limit: 1 });
    const [sequence] = await create(su, "ir.sequence", [{ ...seq }]);
    if (existing.length) {
      await write(su, "ir.sequence", [sequence!], { name: translate(env, "%(name)s (copy)(%(id)s)", "stock").replace("%(name)s", String(seq["name"])).replace("%(id)s", String(sequence)) });
    }
    Object.assign(values, { warehouse_id: wh.id, color, sequence_id: sequence });
    const [pt] = await create(env, "stock.picking.type", [values]);
    out[field] = pt!;
  }
  await write(env, "stock.picking.type", [out["out_type_id"]!], { return_picking_type_id: out["in_type_id"] ?? false });
  await write(env, "stock.picking.type", [out["in_type_id"]!], { return_picking_type_id: out["out_type_id"] ?? false });
  return out;
}

/** :449-500 `_create_or_update_route` for a new warehouse (with purchase_stock stock.py:100-105, :141-144). */
async function createRoutes(env: Environment, whId: number, buyToResupplyValue: boolean): Promise<Vals> {
  let wh = await warehouse(env, whId);
  const buyRoute = await globalRoute(env, wh, "purchase_stock.route_warehouse0_buy");
  if (buyToResupplyValue) await write(env.sudo(), "stock.route", [buyRoute], { warehouse_ids: [[4, wh.id, 0]] });
  wh = await warehouse(env, whId);
  const dict = await rulesDict(env, wh);
  const routes: number[] = [];
  const spec: { field: "reception_route_id" | "delivery_route_id"; key: string; sequence: number; update: Vals; rules: Vals }[] = [
    { field: "reception_route_id", key: wh.reception_steps, sequence: 9, update: { name: routeName(env, wh, wh.reception_steps), active: wh.active },
      rules: { active: true, propagate_cancel: true, procure_method: "make_to_order" } },
    { field: "delivery_route_id", key: wh.delivery_steps, sequence: 60, update: { name: routeName(env, wh, wh.delivery_steps), active: wh.active },
      rules: { active: true, propagate_carrier: true } },
  ];
  for (const s of spec) {
    if (wh[s.field]) throw new NotPorted(`stock.warehouse create with an existing ${s.field}`);
    const [route] = await create(env, "stock.route", [{ product_categ_selectable: true, warehouse_selectable: true, product_selectable: false,
      company_id: wh.company_id, sequence: s.sequence, ...s.update }]);
    await write(env, "stock.warehouse", [wh.id], { [s.field]: route });
    const routings = dict[s.key];
    if (!routings) throw new NotPorted(`stock.warehouse routing ${s.key}`);
    await findExistingRuleOrCreate(env, await ruleValues(env, wh, routings, { ...s.rules, route_id: route }));
    routes.push(route!);
  }
  return { route_ids: routes.map((r) => [4, r, 0]) };
}

/** :937-958 `_update_inter_warehouse_location_properties`. */
async function updateInterWarehouseProperties(env: Environment, ids: readonly number[]): Promise<void> {
  const companies = await env.model("res.company").search(TRUE_DOMAIN);
  const interCompany = await env.reg.xmlid(env.cr, "stock.stock_location_inter_company");
  const { guardOverride } = await import("../orm/override_guard");
  for (const id of ids) {
    const wh = (await env.cr.query<{ p: number | null; c: number }>("SELECT partner_id AS p, company_id AS c FROM stock_warehouse WHERE id = $1", [id])).rows[0]!;
    const internal = (await env.cr.query<{ t: number | null }>("SELECT internal_transit_location_id AS t FROM res_company WHERE id = $1", [wh.c])).rows[0]?.t ?? null;
    if (wh.p === null) continue;
    for (const company of companies) {
      const loc = company === wh.c ? internal : interCompany;
      const vals = { property_stock_customer: loc ?? false, property_stock_supplier: loc ?? false };
      const e = env.sudo().withContext({ ...env.context, allowed_company_ids: [company, ...(Array.isArray(env.context["allowed_company_ids"]) ? (env.context["allowed_company_ids"] as number[]).filter((x) => x !== company) : [])] });
      await guardOverride(e, "res.partner", "write", [wh.p], [vals]);
      await write(e, "res.partner", [wh.p], vals);
    }
  }
}

/** :308-325 `_check_multiwarehouse_group`. */
async function checkMultiwarehouseGroup(env: Environment): Promise<void> {
  const counts = (await env.cr.query<{ n: number }>("SELECT count(*)::int AS n FROM stock_warehouse WHERE active GROUP BY company_id")).rows.map((r) => r.n);
  if (!counts.length) return;
  const max = Math.max(...counts);
  const user = await env.reg.xmlid(env.cr, "base.group_user");
  const multiWh = await env.reg.xmlid(env.cr, "stock.group_stock_multi_warehouses");
  const multiLoc = await env.reg.xmlid(env.cr, "stock.group_stock_multi_locations");
  if (user === null || multiWh === null || multiLoc === null) throw new NotPorted("stock.warehouse _check_multiwarehouse_group without its groups");
  const implied = new Set((await env.cr.query<{ h: number }>("SELECT hid AS h FROM res_groups_implied_rel WHERE gid = $1", [user])).rows.map((r) => r.h));
  if (max <= 1 && implied.has(multiWh)) throw new NotPorted("stock.warehouse _check_multiwarehouse_group removing the multi-warehouse group");
  if (max > 1 && !implied.has(multiWh)) {
    if (!implied.has(multiLoc)) {
      const { executeSettings } = await import("./res_config_settings_save");
      const [settings] = await create(env, "res.config.settings", [{ group_stock_multi_locations: true }]);
      await executeSettings(env, settings!);
    }
    await write(env, "res.groups", [user], { implied_ids: [[4, multiWh, 0], [4, multiLoc, 0]] });
    const { checkGroupRegular } = await import("./res_users_groups");
    await checkGroupRegular(env.sudo());
    // `self.env.user._bus_send("stock_group_sync", {})`
    const { requestOfCursor } = await import("../http/context");
    const { busSend } = await import("../mail/busnotify");
    const ctx = requestOfCursor(env.cr);
    if (!ctx) throw new NotPorted("stock_group_sync outside a request");
    await busSend(ctx, env, { model: "res.users", id: env.uid }, "stock_group_sync", {});
  }
}

registerOverrides("stock.warehouse", {
  // stock_warehouse.py:113-162 create
  create: async (env, valsList, next) => {
    for (const vals of valsList) {
      if (vals["resupply_wh_ids"] && !(Array.isArray(vals["resupply_wh_ids"]) && (vals["resupply_wh_ids"] as unknown[]).length === 0)) {
        const { parseCommands } = await import("../orm/commands");
        const cmds = parseCommands(vals["resupply_wh_ids"], "stock.warehouse.resupply_wh_ids");
        if (cmds.some((c) => c.op !== "clear" && !(c.op === "set" && c.ids.length === 0))) throw new NotPorted("stock.warehouse create with resupply warehouses (create_resupply_routes)");
      }
      if (vals["company_id"]) {
        const c = (await env.cr.query<{ name: string; partner_id: number | null }>("SELECT name, partner_id FROM res_company WHERE id = $1", [vals["company_id"]])).rows[0];
        if (!c) throw new NotPorted(`stock.warehouse create for company ${String(vals["company_id"])}`);
        if (!("name" in vals)) vals["name"] = c.name;
        if (!("code" in vals)) vals["code"] = [...c.name].slice(0, 5).join("");
        if (!("partner_id" in vals)) vals["partner_id"] = c.partner_id ?? false;
      }
      // :124-136 the view location, then the warehouse's locations under it (archived ones too)
      const locVals: Vals = { name: vals["code"] ?? false, usage: "view" };
      if (vals["company_id"]) locVals["company_id"] = vals["company_id"];
      [vals["view_location_id"]] = await create(env, "stock.location", [locVals]);
      const all = env.withContext({ ...env.context, active_test: false });
      for (const [field, values] of await locationsValues(env, vals)) {
        values["location_id"] = vals["view_location_id"];
        if (vals["company_id"]) values["company_id"] = vals["company_id"];
        [vals[field]] = await create(all, "stock.location", [values]);
      }
    }
    const ids = await next(env, valsList);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!, vals = valsList[i]!;
      // purchase_stock buy_to_resupply (default True): the value the create left in the cache
      const buy = "buy_to_resupply" in vals ? Boolean(vals["buy_to_resupply"]) : true;
      const cache = BUY_CACHE.get(env.cr) ?? new Map<number, boolean>();
      BUY_CACHE.set(env.cr, cache);
      cache.set(id, buy);
      await write(env, "stock.warehouse", [id], await createSequencesAndPickingTypes(env, id));
      await write(env, "stock.warehouse", [id], await createRoutes(env, id, buy));
      await createOrUpdateGlobalRules(env, id);
      // :154-156 the view location and its children (archived too) get the warehouse
      const view = Number(vals["view_location_id"]);
      const children = await env.withContext({ ...env.context, active_test: false }).model("stock.location").search(cond("location_id", "=", view));
      await write(env, "stock.location", [view, ...children.filter((c) => c !== view)], { warehouse_id: id });
    }
    await updateInterWarehouseProperties(env, ids);
    await checkMultiwarehouseGroup(env);
    return ids;
  },
  inverse: {
    // purchase_stock stock.py:88-98: on a new warehouse the buy route is not there yet (no rule): nothing to link
    buy_to_resupply: async (env, ids, vals) => {
      for (const id of ids) {
        const wh = await warehouse(env, id);
        let route = wh.buy_pull_id ? (await env.cr.query<{ r: number | null }>("SELECT route_id AS r FROM stock_rule WHERE id = $1", [wh.buy_pull_id])).rows[0]?.r ?? null : null;
        if (route === null) {
          const rules = await env.model("stock.rule").search(and([cond("action", "=", "buy"), cond("warehouse_id", "=", id)]));
          const routesOf = rules.length ? (await env.cr.query<{ r: number }>("SELECT DISTINCT route_id AS r FROM stock_rule WHERE id = ANY($1::int[]) AND route_id IS NOT NULL", [rules])).rows.map((r) => r.r) : [];
          if (routesOf.length > 1) throw new NotPorted("stock.warehouse buy_to_resupply over several buy routes");
          route = routesOf[0] ?? null;
        }
        if (route === null) continue;
        await write(env.sudo(), "stock.route", [route], { warehouse_ids: [[vals["buy_to_resupply"] ? 4 : 3, id, 0]] });
      }
    },
  },
});

registerOverrides("stock.location", {
  // stock_location.py:213-256 write
  write: async (env, ids, vals, next) => {
    if ("company_id" in vals) {
      const other = (await env.cr.query("SELECT 1 FROM stock_location WHERE id = ANY($1::int[]) AND company_id IS DISTINCT FROM $2 LIMIT 1", [[...ids], vals["company_id"] || null])).rows.length;
      if (other) throw new UserError(translate(env, "Changing the company of this record is forbidden at this point, you should rather archive it and create a new one."));
    }
    if ("usage" in vals && vals["usage"] === "view") {
      if ((await env.cr.query("SELECT 1 FROM stock_quant WHERE location_id = ANY($1::int[]) LIMIT 1", [[...ids]])).rows.length) {
        throw new UserError(translate(env, "This location's usage cannot be changed to view as it contains products."));
      }
    }
    if ("usage" in vals) {
      const hit = (await env.cr.query(
        "SELECT 1 FROM stock_quant q JOIN stock_location l ON l.id = q.location_id WHERE l.id = ANY($1::int[]) AND l.usage IS DISTINCT FROM $2 AND q.quantity > 0 LIMIT 1",
        [[...ids], vals["usage"]])).rows.length;
      if (hit) throw new UserError(translate(env, "Internal locations having stock can't be converted"));
    }
    if ("active" in vals) {
      const active = Boolean(vals["active"]);
      if (!active) {
        for (const id of ids) {
          const [wh] = (await env.cr.query<{ id: number }>(
            "SELECT id FROM stock_warehouse WHERE active AND (lot_stock_id = $1 OR view_location_id = $1) ORDER BY sequence, id LIMIT 1", [id])).rows;
          if (wh) {
            const loc = (await env.model("stock.location").displayName([id])).get(id) ?? "";
            const name = (await env.model("stock.warehouse").displayName([wh.id])).get(wh.id) ?? "";
            throw new UserError(translate(env, "You cannot archive location %(location)s because it is used by warehouse %(warehouse)s")
              .replace("%(location)s", loc).replace("%(warehouse)s", name));
          }
        }
      }
      // :242 `child_of` through parent_path, in the model's order (complete_name, id)
      const children = (await env.cr.query<{ id: number; usage: string }>(
        `SELECT c.id, c.usage FROM stock_location c WHERE EXISTS (SELECT 1 FROM stock_location p WHERE p.id = ANY($1::int[]) AND c.parent_path LIKE p.parent_path || '%')
          ORDER BY c.complete_name, c.id`, [[...ids]])).rows;
      const internal = children.filter((c) => c.usage === "internal").map((c) => c.id);
      if (!active && internal.length) {
        const quants = (await env.cr.query<{ l: number }>(
          "SELECT location_id AS l FROM stock_quant WHERE (quantity != 0 OR reserved_quantity != 0) AND location_id = ANY($1::int[]) ORDER BY id", [internal])).rows.map((r) => r.l);
        if (quants.length) {
          const locs = [...new Set(quants)];
          const names = await env.model("stock.location").displayName(locs);
          throw new UserError(translate(env, "You can't disable locations %s because they still contain products.").replace("%s", locs.map((l) => names.get(l) ?? "").join(", ")));
        }
      }
      const others = children.map((c) => c.id).filter((c) => !ids.includes(c));
      if (others.length) await next(env, others, { active });
    }
    await next(env, ids, vals);
  },
});

registerOverrides("stock.route", {
  // stock_location.py:548-582 write
  write: async (env, ids, vals, next) => {
    if ("active" in vals) {
      // the rules (archived ones too) whose destination is active: action_unarchive / action_archive (models.py:5273-5295).
      // `self.with_context(active_test=False).rule_ids` is read as the user before `.sudo()`: the one2many keeps the
      // rules the user may read (the multi-company rule of stock.rule, stock ir.access.csv:39), so a write from
      // company 1 leaves company 2's rule of the same route alone (the settings' MTO switch, G68)
      const visible = await env.withContext({ ...env.context, active_test: false }).model("stock.rule").search(cond("route_id", "in", [...ids]));
      const rules = (await env.cr.query<{ id: number; active: boolean }>(
        `SELECT x.id, x.active FROM stock_rule x JOIN stock_location d ON d.id = x.location_dest_id WHERE x.id = ANY($1::int[]) AND d.active ORDER BY x.sequence, x.id`,
        [visible])).rows;
      const target = Boolean(vals["active"]);
      const todo = rules.filter((r) => r.active !== target).map((r) => r.id);
      if (todo.length) await write(env.sudo(), "stock.rule", todo, { active: target });
    }
    let warehouseVals: unknown[] = [];
    const old = new Map<number, Set<number>>();
    const linked = async (id: number): Promise<Set<number>> => new Set((await env.cr.query<{ w: number }>(
      "SELECT warehouse_id AS w FROM stock_route_warehouse WHERE route_id = $1", [id])).rows.map((r) => r.w));
    if ("warehouse_ids" in vals) for (const id of ids) old.set(id, await linked(id));
    if ("warehouse_selectable" in vals && !vals["warehouse_selectable"]) warehouseVals = [[5, 0, 0]];
    if (vals["company_id"] && !warehouseVals.length) {
      const others = (await env.cr.query<{ w: number }>(
        `SELECT DISTINCT rw.warehouse_id AS w FROM stock_route_warehouse rw JOIN stock_warehouse w ON w.id = rw.warehouse_id
          WHERE rw.route_id = ANY($1::int[]) AND w.company_id IS DISTINCT FROM $2 ORDER BY 1`, [[...ids], vals["company_id"]])).rows.map((r) => r.w);
      warehouseVals = others.map((w) => [3, w, 0]);
    }
    if (warehouseVals.length) {
      const su = env.sudo();
      await write(su.withContext({ ...su.context, bypass_global_route_sync: true }), "stock.route", ids, { warehouse_ids: warehouseVals });
    }
    await next(env, ids, vals);
    if ("warehouse_ids" in vals && !env.context["bypass_global_route_sync"]) {
      const sync: number[] = [];
      for (const id of ids) {
        const now = await linked(id);
        const before = old.get(id) ?? new Set<number>();
        const changed = [...now].filter((w) => !before.has(w)).concat([...before].filter((w) => !now.has(w)));
        for (const w of changed) {
          if (sync.includes(w)) continue;
          const wh = await warehouse(env, w);
          for (const field of (await globalRulesValues(env, wh)).keys()) {
            const rule = wh[field as "mto_pull_id" | "buy_pull_id"];
            const route = rule ? (await env.cr.query<{ r: number | null }>("SELECT route_id AS r FROM stock_rule WHERE id = $1", [rule])).rows[0]?.r ?? null : null;
            if (route === id) { sync.push(w); break; }
          }
        }
      }
      for (const w of sync) await createOrUpdateGlobalRules(env, w);
    }
  },
});

registerOverrides("stock.picking.type", {
  // `sequence_code` is related='sequence_id.prefix', readonly=False (stock_picking_type.py:59): fields.py:799-813
  // `_inverse_related` assigns the prefix on the first sequence (a write on ir.sequence), not a write of the operation
  // type (whose override would rename the sequence after the warehouse)
  inverse: {
    sequence_code: async (env, ids, vals) => {
      for (const id of ids) {
        const seq = (await env.cr.query<{ s: number | null }>("SELECT sequence_id AS s FROM stock_picking_type WHERE id = $1", [id])).rows[0]?.s ?? null;
        if (seq !== null) await write(env, "ir.sequence", [seq], { prefix: vals["sequence_code"] ?? false });
      }
    },
  },
  // stock_picking_type.py:276-293 create: a sequence code without a sequence gets its own ir.sequence (as superuser),
  // named after the warehouse when there is one
  create: async (env, valsList, next) => {
    for (const vals of valsList) {
      if (vals["sequence_id"] || !vals["sequence_code"]) continue;
      const code = String(vals["sequence_code"]);
      const whId = typeof vals["warehouse_id"] === "number" && vals["warehouse_id"] ? vals["warehouse_id"] : null;
      let seqVals: Vals;
      if (whId !== null) {
        const wh = (await env.cr.query<{ name: string; company_id: number | null }>("SELECT name, company_id FROM stock_warehouse WHERE id = $1", [whId])).rows[0];
        seqVals = {
          name: translate(env, "%(warehouse)s Sequence %(code)s", "stock").replace("%(warehouse)s", wh?.name ?? "").replace("%(code)s", code),
          padding: 5, company_id: wh?.company_id ?? false,
        };
      } else {
        seqVals = {
          name: translate(env, "Sequence %(code)s", "stock").replace("%(code)s", code),
          padding: 5, company_id: vals["company_id"] || await env.company(),
        };
      }
      [vals["sequence_id"]] = await create(env.sudo(), "ir.sequence", [seqVals]);
    }
    return next(env, valsList);
  },
  // stock_picking_type.py:303-341 write
  write: async (env, ids, vals, next) => {
    if ("company_id" in vals) {
      const other = (await env.cr.query("SELECT 1 FROM stock_picking_type WHERE id = ANY($1::int[]) AND company_id IS DISTINCT FROM $2 LIMIT 1", [[...ids], vals["company_id"] || null])).rows.length;
      if (other) throw new UserError(translate(env, "Changing the company of this record is forbidden at this point, you should rather archive it and create a new one."));
    }
    if ("reservation_method" in vals) throw new NotPorted("stock.picking.type.write of reservation_method (the moves' reservation dates)");
    if ("sequence_code" in vals) {
      for (const id of ids) {
        const [t] = (await env.cr.query<{ seq: number | null; wh: number | null; wh_name: string | null; wh_company: number | null }>(
          `SELECT t.sequence_id AS seq, t.warehouse_id AS wh, w.name AS wh_name, w.company_id AS wh_company FROM stock_picking_type t
             LEFT JOIN stock_warehouse w ON w.id = t.warehouse_id WHERE t.id = $1`, [id])).rows;
        if (vals["sequence_id"] === false) vals["sequence_id"] = t?.seq ?? false;
        if (!t?.seq) continue;
        const code = String(vals["sequence_code"]);
        const seqVals = t.wh
          ? { name: translate(env, "%(warehouse)s Sequence %(code)s", "stock").replace("%(warehouse)s", t.wh_name ?? "").replace("%(code)s", code), padding: 5, company_id: t.wh_company }
          : { name: translate(env, "Sequence %(code)s", "stock").replace("%(code)s", code), padding: 5, company_id: await env.company() };
        await write(env.sudo(), "ir.sequence", [t.seq], seqVals);
      }
    }
    await next(env, ids, vals);
  },
});
