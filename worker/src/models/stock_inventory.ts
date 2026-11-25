/**
 * Applying a physical inventory count: stock_quant.py:465-482 `action_apply_inventory` and :1028-1067
 * `_apply_inventory` with `_get_inventory_move_values` (:1285-1324) and `action_clear_inventory_quantity` (:577-581):
 * one inventory move per counted quant, from or to the product's inventory loss location, created confirmed with its
 * picked line and done through `_action_done` (stock_validate.ts, with the stock_account valuation), then
 * `_trigger_assign`, the location's last inventory date and the quants' next one. Lots, packages, owners, the
 * conflict wizard of outdated quants and a date argument refuse with NotPorted.
 */
import { NotPorted, UserError } from "../errors";
import { registerMethod } from "../http/methods";
import { DbRec, registerOnchange } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { create } from "../orm/create";
import { registerOverrides, write } from "../orm/write";
import { actionAssign, contextToday, nextInventoryDate, pickingActionConfirm, removalStrategy, uomCompare } from "./stock_engine";
import { checkCompany } from "../orm/check_company";
import { trackPrepare } from "../mail/tracking";
import { closeTrackingScope } from "../mail/write_hooks";
import { addPrecommit, withPrecommit } from "./precommit";
import { movesDone, triggerAssign } from "./stock_validate";
import { quantIsOutdated, quantTasks, quantViewContext } from "./inventory_flow";
import { actionOf, variantsOf } from "./sps_menus";
import { envFor } from "../web/common";
import { hasGroup } from "../orm/env";
import { and, cond, parseDomain } from "../orm/domain";
import { translate } from "./util";
import { defineComputes } from "./tail_util";

interface QuantRow {
  id: number; product_id: number; location_id: number; company_id: number | null; lot_id: number | null; package_id: number | null; owner_id: number | null;
  uom_id: number; diff: number;
}

async function rows<T extends object>(env: Environment, text: string, params: unknown[]): Promise<T[]> {
  return (await env.cr.query<T & Record<string, unknown>>(text, params)).rows;
}

async function quantRows(env: Environment, ids: readonly number[]): Promise<QuantRow[]> {
  const out = await rows<QuantRow>(env,
    `SELECT q.id, q.product_id, q.location_id, q.company_id, q.lot_id, q.package_id, q.owner_id, t.uom_id, COALESCE(q.inventory_diff_quantity, 0)::float8 AS diff
       FROM stock_quant q JOIN product_product p ON p.id = q.product_id JOIN product_template t ON t.id = p.product_tmpl_id WHERE q.id = ANY($1::int[])`, [[...ids]]);
  const byId = new Map(out.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is QuantRow => r !== undefined);
}

const idOf = (v: unknown): number | null => (typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : null);

/** The product's `property_stock_inventory` in the quant's company, else the company's default (`_get_model_defaults`). */
async function inventoryLocation(env: Environment, product: number, company: number): Promise<number> {
  const cenv = env.sudo().withContext({ ...env.context, allowed_company_ids: [company] });
  const [p] = await cenv.model("product.product").read([product], ["property_stock_inventory"], "");
  const own = idOf(p?.["property_stock_inventory"]);
  if (own !== null) return own;
  const [d] = await rows<{ v: string }>(env,
    `SELECT d.json_value AS v FROM ir_default d JOIN ir_model_fields f ON f.id = d.field_id
      WHERE f.model = 'product.template' AND f.name = 'property_stock_inventory' AND d.user_id IS NULL AND d.condition IS NULL
        AND (d.company_id = $1 OR d.company_id IS NULL) ORDER BY d.company_id NULLS LAST LIMIT 1`, [company]);
  const id = d ? Number(JSON.parse(d.v)) : NaN;
  if (!Number.isInteger(id)) throw new NotPorted("stock.quant._apply_inventory without an inventory loss location");
  return id;
}

/** stock_quant.py:1028-1067 `_apply_inventory`. */
export async function applyInventory(env: Environment, ids: readonly number[], date: string | null = null): Promise<void> {
  if (!ids.length) return;
  // "Consider the inventory_quantity as set => recompute the inventory_diff_quantity if needed"
  await write(env, "stock.quant", ids, { inventory_quantity_set: true });
  const quants = await quantRows(env, ids);
  // stock_account stock_quant.py:80-87: an accounting date posts the moves in that period
  if ((await rows(env, "SELECT 1 FROM stock_quant WHERE id = ANY($1::int[]) AND accounting_date IS NOT NULL LIMIT 1", [[...ids]])).length) {
    throw new NotPorted("stock.quant._apply_inventory with an accounting date (force_period_date)");
  }
  const vals: Record<string, unknown>[] = [];
  for (const q of quants) {
    if (q.lot_id || q.package_id || q.owner_id) throw new NotPorted("stock.quant._apply_inventory with a lot, package or owner");
    // :1040-1043 from the product's quantity inverse, a count that is the quantity there makes no move
    if (env.context["from_inverse_qty"] && (await uomCompare(env, q.diff, 0)) === 0) continue;
    const company = q.company_id ?? await env.company();
    const loss = await inventoryLocation(env, q.product_id, company);
    const positive = (await uomCompare(env, q.diff, 0)) > 0;
    const qty = positive ? q.diff : -q.diff;
    const [from, to] = positive ? [loss, q.location_id] : [q.location_id, loss];
    // :1285-1324 `_get_inventory_move_values`
    const move: Record<string, unknown> = {
      product_id: q.product_id, uom_id: q.uom_id, product_uom_qty: qty, company_id: company, state: "confirmed",
      location_id: from, location_dest_id: to, restrict_partner_id: false, is_inventory: true, picked: true,
      move_line_ids: [[0, 0, {
        product_id: q.product_id, uom_id: q.uom_id, quantity: qty, location_id: from, location_dest_id: to, company_id: company,
        lot_id: false, package_id: false, result_package_id: false, owner_id: false,
      }]],
    };
    if (env.context["inventory_name"]) move["inventory_name"] = env.context["inventory_name"];
    vals.push(move);
  }
  const moves = vals.length ? await create(env.withContext({ ...env.context, inventory_mode: false }), "stock.move", vals) : [];
  if (moves.length) await movesDone(env.withContext({ ...env.context, ignore_dest_packages: true }), moves, false);
  if (date) await write(env, "stock.move", moves, { date });
  await triggerAssign(env, moves);
  const locations = [...new Set(quants.map((q) => q.location_id))];
  await write(env.sudo(), "stock.location", locations, { last_inventory_date: await contextToday(env) });
  for (const q of quants) await write(env, "stock.quant", [q.id], { inventory_date: (await nextInventoryDate(env, q.location_id)) ?? false });
  // :577-581 `action_clear_inventory_quantity`
  await write(env, "stock.quant", ids, { inventory_quantity: 0, inventory_diff_quantity: 0, inventory_quantity_set: false, user_id: false });
}

/** stock_quant.py:1263-1268 `_is_inventory_mode`. */
async function isInventoryMode(env: Environment): Promise<boolean> {
  return Boolean(env.context["inventory_mode"]) && await hasGroup(env, "stock.group_stock_user");
}

// stock_quant.py:1271-1283 `_get_inventory_fields_create` with `_get_inventory_fields_write`, and stock_account's
// stock_quant.py:103-108 (`accounting_date`)
const INVENTORY_FIELDS_CREATE = new Set(["product_id", "owner_id", "inventory_quantity", "inventory_quantity_auto_apply", "inventory_diff_quantity",
  "inventory_date", "user_id", "inventory_quantity_set", "is_outdated", "lot_id", "location_id", "package_id", "accounting_date"]);

const counted = (vals: Readonly<Record<string, unknown>>): boolean => "inventory_quantity" in vals || "inventory_quantity_auto_apply" in vals;
const given = (v: unknown): boolean => v !== undefined && v !== false && v !== null && v !== 0;

registerOverrides("stock.quant", {
  /**
   * stock_quant.py:284-346 `create`: in the inventory mode a counted quantity goes on the quant of the exact
   * product, location, lot, package and owner (`_gather(strict=True)`) when there is one, else on a new empty quant
   * created as superuser; the count is then set as a write (`inventory_quantity`, the counting user, today), which
   * leaves the move to `action_apply_inventory`. Outside it, a quant created without a counted quantity is not
   * "set" (:338-340). Before round 11 the counted quantity was stored on a new quant beside the existing one, so
   * applying the count added it to the stock (50 counted where 20 were gave 70).
   */
  create: async (env, valsList, next) => {
    const inventoryMode = await isInventoryMode(env);
    // everything the port does not follow refuses before anything is written
    for (const vals of valsList) {
      if (!(inventoryMode && counted(vals))) continue;
      if (Object.keys(vals).some((f) => !f.startsWith("x_") && !INVENTORY_FIELDS_CREATE.has(f))) {
        throw new UserError(translate(env, "Quant's creation is restricted, you can't do this operation."));
      }
      if ("inventory_quantity_auto_apply" in vals) throw new NotPorted("stock.quant.create with inventory_quantity_auto_apply (the _set_inventory_quantity inverse)");
      if (env.context["import_file"]) throw new NotPorted("stock.quant.create in the inventory mode of an import (quants merged later)");
      if (given(vals["lot_id"]) || given(vals["package_id"]) || given(vals["owner_id"])) throw new NotPorted("stock.quant.create in the inventory mode with a lot, package or owner");
      if (typeof vals["product_id"] !== "number" || typeof vals["location_id"] !== "number") throw new NotPorted("stock.quant.create in the inventory mode without a product or location id");
      if (env.context["quants_cache"] !== undefined || env.context["with_expiration"]) throw new NotPorted("stock.quant._gather with quants_cache or with_expiration");
    }
    const out: number[] = [];
    for (const vals0 of valsList) {
      const vals = { ...vals0 };
      if (inventoryMode && counted(vals)) {
        // `vals.pop('inventory_quantity_auto_apply', False) or vals.pop('inventory_quantity', False) or 0`
        const qty = Number(vals["inventory_quantity"] || 0);
        delete vals["inventory_quantity"];
        const product = vals["product_id"] as number;
        const location = vals["location_id"] as number;
        // :803-823 `_gather(strict=True)` searched as the calling user, with :760-782 the removal strategy's order;
        // without lot, package or owner every quant found is untracked, so `sorted(lambda q: not q.lot_id)` keeps it
        const strategy = await removalStrategy(env.sudo(), product, location);
        const order = strategy === "fifo" || strategy === "least_packages" ? "in_date ASC, id" : strategy === "lifo" ? "in_date DESC, id DESC" : null;
        if (order === null) throw new NotPorted(`stock.quant._gather with the ${strategy} removal strategy`);
        const found = await env.model("stock.quant").search(and([cond("product_id", "=", product), cond("lot_id", "in", [false]),
          cond("package_id", "=", false), cond("owner_id", "=", false), cond("location_id", "=", location)]), { order });
        let quant = found[0];
        if (quant === undefined) quant = (await create(env.sudo(), "stock.quant", [vals]))[0]!;
        // `quant.inventory_quantity = ...; quant.user_id = ...; quant.inventory_date = context_today` on the sudo record
        await write(env.sudo(), "stock.quant", [quant], {
          inventory_quantity: qty,
          user_id: "user_id" in vals ? vals["user_id"] : env.uid,
          inventory_date: await contextToday(env),
        });
        if (!out.includes(quant)) out.push(quant); // `quants |= quant`
      } else {
        if (!("inventory_quantity" in vals)) vals["inventory_quantity_set"] = vals["inventory_quantity_set"] ?? false;
        const [quant] = await next(env, [vals]);
        if (!out.includes(quant!)) out.push(quant!);
        if (inventoryMode && (await rows(env, "SELECT 1 FROM stock_quant WHERE id = $1 AND company_id IS NOT NULL", [quant])).length) {
          await checkCompany(env, env.reg.model("stock.quant"), [quant!], null);
        }
      }
    }
    return out;
  },
});

/** stock_quant.py:465-482 `action_apply_inventory`. */
export async function actionApplyInventory(env: Environment, quantIds: readonly number[], date: string | null = null): Promise<Record<string, unknown> | null> {
  const ctx: Record<string, unknown> = { ...env.context, default_quant_ids: [...quantIds] };
  const outdated: number[] = [];
  for (const id of quantIds) {
    if (await quantIsOutdated(env, new DbRec(env, env.reg.model("stock.quant"), id))) outdated.push(id);
  }
  if (outdated.length) {
    ctx["default_quant_to_fix_ids"] = outdated;
    return {
      name: translate(env, "Conflict in Inventory Adjustment", "stock"),
      type: "ir.actions.act_window",
      view_mode: "form",
      views: [[false, "form"]],
      res_model: "stock.inventory.conflict",
      target: "new",
      context: ctx,
    };
  }
  await applyInventory(env, quantIds, date);
  await write(env, "stock.quant", quantIds, { inventory_quantity_set: false });
  return null; // stock_quant.py:481-482 returns None (call_button answers false)
}

registerMethod("stock.quant", "action_apply_inventory", async (env0, ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const rawDate = args[0] ?? kwargs["date"];
  const date = typeof rawDate === "string" && rawDate ? rawDate : null;
  return actionApplyInventory(env, ids ?? [], date);
}, { apiModel: false });

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

defineComputes("stock.location", {
  // stock_location.py:145-162 `_compute_next_inventory_date`: the cyclic count date of internal and transit locations
  next_inventory_date: async (env, rec) => {
    const freq = Number((await rec.get("cyclic_inventory_frequency")) ?? 0);
    if (!idOf(await rec.get("company_id")) || !["internal", "transit"].includes(String(await rec.get("usage"))) || freq <= 0) return null;
    const today = await contextToday(env);
    const last = await rec.get("last_inventory_date");
    if (typeof last !== "string" || !last) return addDays(today, freq);
    const days = freq - Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${last.slice(0, 10)}T00:00:00Z`)) / 86400000);
    if (days <= 0) return addDays(today, 1);
    const out = addDays(last.slice(0, 10), freq);
    if (out > "9999-12-31" || !/^\d{4}-/.test(out)) throw new NotPorted("stock.location.next_inventory_date beyond year 9999 (UserError)");
    return out;
  },
});

/** stock_quant.py:1340-1381 `_get_quants_action` (after `action_view_quants`, :429-432, with `extend=True`). */
export async function quantsAction(env0: Environment): Promise<Record<string, unknown>> {
  const env = env0.withContext(await quantViewContext(env0.withContext({ ...env0.context, search_default_internal_loc: 1 })));
  const skip = (await rows<{ value: string }>(env, "SELECT value FROM ir_config_parameter WHERE key = 'stock.skip_quant_tasks'", []))[0]?.value;
  const { str2bool } = await import("../session/user");
  if (!(skip !== undefined && str2bool(skip))) await quantTasks(env);
  const ctx: Record<string, unknown> = { ...env.context, inventory_report_mode: true };
  delete ctx["group_by"];
  const action = await actionOf(env, "stock.stock_quant_action");
  action["domain"] = ["|", ["product_id.company_id", "parent_of", ctx["allowed_company_ids"] ?? []], ["product_id.company_id", "=", false]];
  const ref = async (name: string): Promise<number> => {
    const r = (await rows<{ res_id: number }>(env, "SELECT res_id FROM ir_model_data WHERE module = 'stock' AND name = $1", [name]))[0];
    if (!r) throw new NotPorted(`stock.${name} missing`);
    return r.res_id;
  };
  const form = await ref("view_stock_quant_form_editable");
  action["view_id"] = env.context["inventory_mode"] && await hasGroup(env, "stock.group_stock_user") ? await ref("view_stock_quant_tree_editable") : await ref("view_stock_quant_tree");
  action["context"] = ctx;
  action["view_mode"] = "list,form,pivot,graph";
  action["views"] = [[action["view_id"], "list"], [form, "form"], [await ref("view_stock_quant_pivot"), "pivot"], [await ref("stock_quant_view_graph"), "graph"]];
  // :1381-1382 the path of the server action that opens it from a url
  action["path"] = "stock-locations";
  return action;
}

/** stock product.py:657-688 `action_open_quants` of product variants. */
export async function openQuants(env0: Environment, products: readonly number[]): Promise<Record<string, unknown>> {
  const ctx: Record<string, unknown> = { ...env0.context };
  const multi = await hasGroup(env0, "stock.group_stock_multi_locations");
  const tracked = products.length ? (await rows(env0, `SELECT 1 FROM product_product p JOIN product_template t ON t.id = p.product_tmpl_id
      WHERE p.id = ANY($1::int[]) AND t.tracking IN ('lot', 'serial') LIMIT 1`, [[...products]])).length > 0 : false;
  Object.assign(ctx, { hide_location: !multi, hide_lot: !tracked });
  if (await hasGroup(env0, "stock.group_stock_user")) {
    ctx["inventory_mode"] = true;
    if (!multi) {
      const [wh] = await env0.withContext(ctx).model("stock.warehouse").search(parseDomain([["company_id", "=", await env0.company()]]), { limit: 1 });
      if (wh !== undefined) ctx["default_location_id"] = (await rows<{ s: number }>(env0, "SELECT lot_stock_id AS s FROM stock_warehouse WHERE id = $1", [wh]))[0]!.s;
    }
  }
  if (products.length === 1) Object.assign(ctx, { default_product_id: products[0], single_product: true });
  else {
    const tmpls = products.length ? (await rows<{ t: number }>(env0, "SELECT DISTINCT ON (product_tmpl_id) product_tmpl_id AS t, id FROM product_product WHERE id = ANY($1::int[]) ORDER BY product_tmpl_id", [[...products]])) : [];
    if (tmpls.length > 1) throw new NotPorted("action_open_quants of several templates (product_tmpl_ids order)");
    ctx["product_tmpl_ids"] = tmpls.map((r) => r.t);
  }
  const env = env0.withContext(ctx);
  const action = await quantsAction(env);
  if (!env.context["is_stock_report"]) {
    action["domain"] = [["product_id", "in", [...products]]];
    action["name"] = translate(env, "Update Quantity");
  }
  return action;
}

registerMethod("product.product", "action_open_quants", async (env0, ids, _args, kwargs) => openQuants(envFor(env0, kwargs).env, ids ?? []), { apiModel: false });
// stock product.py:1209-1212 the template's active variants (or variants with stock)
registerMethod("product.template", "action_open_quants", async (env0, ids, _args, kwargs) => {
  const { env } = envFor(env0, kwargs);
  if ("product_variant" in env.context) {
    const id = env.context["default_product_id"];
    return openQuants(env, typeof id === "number" ? [id] : []);
  }
  return openQuants(env, await variantsOf(env, ids ?? []));
}, { apiModel: false });

// stock_quant.py `_compute_inventory_quantity_auto_apply`: the quantity on hand
// stock_quant.py:121-124 `_compute_available_quantity`
defineComputes("stock.quant", {
  inventory_quantity_auto_apply: async (_env, rec) => Number((await rec.get("quantity")) ?? 0),
  // stock_account stock_quant.py:27-36 `_compute_cost_method`: the category's in the quant's company, else the company's
  cost_method: async (env, rec) => {
    const company = idOf(await rec.get("company_id")) ?? await env.company();
    const categ = idOf(await rec.get("product_categ_id"));
    if (categ !== null) {
      const cenv = env.sudo().withContext({ ...env.context, allowed_company_ids: [company] });
      const [c] = await cenv.model("product.category").read([categ], ["property_cost_method"], "");
      if (c?.["property_cost_method"]) return c["property_cost_method"];
    }
    return (await rows<{ m: string | null }>(env, "SELECT cost_method AS m FROM res_company WHERE id = $1", [company]))[0]?.m ?? false;
  },
  available_quantity: async (_env, rec) => Number((await rec.get("quantity")) ?? 0) - Number((await rec.get("reserved_quantity")) ?? 0),
});

/** stock_picking.py:1293-1307 `_action_generate_zero_demand_wizard`. */
export async function zeroDemandWizardAction(env: Environment, pickings: readonly number[]): Promise<Record<string, unknown>> {
  const viewId = await env.reg.xmlid(env.cr, "stock.view_zero_demand_confirmation");
  return {
    name: translate(env, "Zero Demand Warning", "stock"),
    type: "ir.actions.act_window",
    view_mode: "form",
    res_model: "stock.zero.demand.confirmation",
    views: [[viewId, "form"]],
    view_id: viewId,
    target: "new",
    context: {
      ...env.context,
      default_picking_ids: [...pickings],
    },
  };
}

/**
 * stock_picking.py:768-785 `action_confirm`: `_check_company`, the zero-demand wizard unless skip_zero_demand_check,
 * the draft moves confirmed and the scheduler triggered (stock_engine.ts pickingActionConfirm); the automatic batches
 * of group_stock_picking_batch refuse.
 */
export async function pickingConfirm(env: Environment, pickings: readonly number[]): Promise<true | Record<string, unknown>> {
  await env.model("stock.picking").read([...pickings], ["id"], ""); // access to the transfers
  await checkCompany(env, env.reg.model("stock.picking"), pickings, null);
  if (!env.context["skip_zero_demand_check"]
    && (await rows(env, "SELECT 1 FROM stock_move WHERE picking_id = ANY($1::int[]) AND product_uom_qty <= 0 LIMIT 1", [[...pickings]])).length) {
    return zeroDemandWizardAction(env, pickings);
  }
  if (await hasGroup(env, "stock.group_stock_picking_batch")) throw new NotPorted("stock.picking.action_confirm with automatic batches (_find_auto_batch)");
  // the transfers' tracking (their computed state) is logged once, at precommit (either end of method or scheduler savepoint)
  await withPrecommit(env.cr, async () => {
    await trackPrepare(env, "stock.picking", pickings);
    await addPrecommit(env.cr, () => closeTrackingScope(env, "stock.picking"));
    await pickingActionConfirm(env, pickings);
  });
  return true;
}

registerMethod("stock.picking", "action_confirm", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  return pickingConfirm(env, ids ?? []);
}, { apiModel: false });

/** stock_picking.py:787-800 `action_assign`: the open moves of the transfers by priority, deadline, date and id. */
registerMethod("stock.picking", "action_assign", async (env, ids) => {
  const pickings = ids ?? [];
  // :793 the draft transfers are confirmed first, without the zero-demand check
  const drafts = new Set((await rows<{ id: number }>(env, "SELECT id FROM stock_picking WHERE id = ANY($1::int[]) AND state = 'draft'", [[...pickings]])).map((r) => r.id));
  const draft = pickings.filter((id) => drafts.has(id));
  if (draft.length) await pickingConfirm(env.withContext({ ...env.context, skip_zero_demand_check: true }), draft);
  await env.model("stock.picking").read(pickings, ["id"], ""); // access to the transfers
  const moves = await rows<{ id: number; priority: string | null; deadline: string | null; date: string }>(env,
    `SELECT id, priority, to_char(date_deadline, 'YYYY-MM-DD HH24:MI:SS.US') AS deadline, to_char(date, 'YYYY-MM-DD HH24:MI:SS.US') AS date
       FROM stock_move WHERE picking_id = ANY($1::int[]) AND state NOT IN ('draft', 'cancel', 'done')`, [[...pickings]]);
  if (!moves.length) throw new UserError(translate(env, "There is nothing to reserve."));
  const cmp = (a: string | null, b: string | null): number => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1);
  moves.sort((a, b) => (-Number(a.priority ?? 0)) - (-Number(b.priority ?? 0))
    || Number(a.deadline === null) - Number(b.deadline === null) || cmp(a.deadline, b.deadline) || cmp(a.date, b.date) || a.id - b.id);
  await actionAssign(env, moves.map((m) => m.id));
  return true;
}, { apiModel: false });

// stock_quant.py:991-1001 `_onchange_inventory_quantity` (the two literals are joined without a space)
registerOnchange("stock.quant", "_onchange_inventory_quantity", ["inventory_quantity"], async (env, rec) => {
  const location = await rec.rel("location_id");
  if (!location || (await location.get("usage")) !== "inventory") return;
  return {
    title: translate(env, "You cannot modify inventory loss quantity", "stock"),
    message: translate(env, "Editing quantities in an Inventory Adjustment location is forbidden,those locations are used as counterpart when correcting the quantities.", "stock"),
  };
});
