/**
 * Inventory and Sales menus that open on Python methods: the picking server actions (web/controllers/action.py run,
 * stock_picking.py:1600-1627), the product list's category panel (web/models/models.py search_panel_select_range) and its
 * valuation columns (stock_account/models/product.py:97-189 for the standard cost method), picking returns, provider features.
 */
import { create, HOOKS_INSIDE } from "../orm/create";
import { plainNumber } from "../orm/values";
import { isPyFloat } from "../web/common";
import { ensureRegistryLang } from "../orm/registry";
import { AccessError, NotPorted, ValidationError } from "../errors";
import { checkModelAccess } from "../orm/access";
import { loadAction } from "../controllers/action";
import { hostIdFromDomain, lookupMethod, registerMethod } from "../http/methods";
import { jsonRoute } from "../http/router";
import { floatRound } from "../orm/convert";
import { cond, localMidnightToUtc, or, parseDomain, PyDate } from "../orm/domain";
import { envTz, hasGroup } from "../orm/env";
import { registerHooks } from "../orm/hooks";
import { evalExpr } from "../pyexpr";
import { renderTemplate } from "../qweb";
import { envFor } from "../web/common";
import { registerOverrides, write } from "../orm/write";
import { datetimeToString, dbNow, todayInTz, translate } from "./util";
import { actionOf, variantsOf } from "./sps_menus";
import { formatDate } from "./invoicing_computes";
import { moveForecast } from "./stock_forecast";
import { quantitiesDict } from "./stock_quantities";
import { changeStandardPrice, costedValue, num, roundCurrency } from "./stock_valuation";
import { findRule, type RuleRow } from "./sale_confirm";
import { defineComputes, searchMethod } from "./tail_util";
import { runServerActionRoute } from "./ir_actions_server";
import { createVariantIds } from "./product_variants";
import * as edit from "./product_template_edit";
import { DbRec, overlayOf, readFieldBatch, registerRecordCompute, type Rec } from "../orm/recompute";
import type { Environment } from "../orm/types";

const idOf = (v: unknown): number | null => (typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : null);

/** The window actions behind `action = model.<method>()` of the stock.picking server actions. */
const PICKING_ACTIONS: Readonly<Record<string, string>> = {
  get_action_click_graph: "stock.action_picking_tree_graph",
  get_action_picking_tree_incoming: "stock.action_picking_tree_incoming",
  get_action_picking_tree_outgoing: "stock.action_picking_tree_outgoing",
  get_action_picking_tree_internal: "stock.action_picking_tree_internal",
};

// action.py run() over `action.run()`; only the code above has been ported
jsonRoute("/web/action/run", async (ctx) => {
  const p = ctx.jsonParams ?? {};
  if (p["context"] && typeof p["context"] === "object" && !Array.isArray(p["context"])) ctx.updateContext(p["context"] as Record<string, unknown>);
  const row = (await ctx.cursor().query<{ state: string; code: string | null; groups: string; model: string }>(
    `SELECT a.state, a.code, (SELECT count(*)::text FROM ir_act_server_group_rel r WHERE r.act_id = a.id) AS groups, m.model
       FROM ir_act_server a JOIN ir_model m ON m.id = a.model_id WHERE a.id = $1`, [p["action_id"]])).rows[0];
  const callCtx = p["context"] && typeof p["context"] === "object" ? p["context"] as Record<string, unknown> : {};
  if (row && !Number(row.groups) && !callCtx["active_id"] && !callCtx["active_ids"]) {
    // ir_actions.py:1196 with :1233-1249 `_can_execute_action_on_records` (no groups, no records): write access on the model
    const env0 = await ctx.orm();
    try {
      await checkModelAccess(env0, env0.reg.model(row.model), "write");
    } catch (e) {
      if (e instanceof AccessError) throw new AccessError(translate(env0, "You don't have enough access rights to run this action."));
      throw e;
    }
  }
  const recordsCall = row?.state === "code" ? recordsMethodCall(row.code ?? "") : null;
  if (recordsCall) return runRecordsCode(ctx, Number(p["action_id"]), row!.model, recordsCall, Number(row!.groups) > 0);
  const method = /^action = model\.(\w+)\(\)$/.exec((row?.code ?? "").trim())?.[1];
  if (row?.state === "code" && row.model === "stock.quant" && method === "action_view_inventory") {
    const env = await ctx.orm();
    // ir_actions.py:1233-1240 `_can_execute_action_on_records`: an action with groups needs one of them
    if (Number(row.groups)) {
      const groups = (await env.cr.query<{ x: string }>(
        `SELECT d.module || '.' || d.name AS x FROM ir_act_server_group_rel r JOIN ir_model_data d ON d.model = 'res.groups' AND d.res_id = r.gid
          WHERE r.act_id = $1 ORDER BY d.id`, [p["action_id"]])).rows.map((r) => r.x);
      let allowed = false;
      for (const g of groups) if (await hasGroup(env, g)) { allowed = true; break; }
      if (!allowed) throw new AccessError(translate(env, "You don't have enough access rights to run this action."));
    }
    const base = { ...env.context, host_id: env.context["host_id"] ?? await hostIdFromDomain(env), mail_notify_force_send: false };
    return viewInventory(env.withContext(base));
  }
  const xmlid = method ? PICKING_ACTIONS[method] : undefined;
  // the other code, update and create actions (src/models/ir_actions_server.ts)
  if (row && !xmlid && ["code", "object_write", "object_create"].includes(row.state)) return runServerActionRoute(await ctx.orm(), Number(p["action_id"]));
  if (row?.state !== "code" || !xmlid || Number(row.groups)) throw new NotPorted(`/web/action/run of server action ${String(p["action_id"])}`);
  const env = await ctx.orm();
  const action = await loadAction(ctx, xmlid, env);
  // stock_picking.py:1603-1615 _get_action
  const own = evalExpr(typeof action["context"] === "string" ? action["context"] : "{}", new Map());
  // mail ir_actions_server.py run(): server actions do not force the send of mails
  const base = { ...env.context, host_id: env.context["host_id"] ?? await hostIdFromDomain(env), mail_notify_force_send: false };
  const context: Record<string, unknown> = { ...base, ...(own instanceof Map ? Object.fromEntries(own) : (own as Record<string, unknown>)) };
  action["context"] = context;
  action["help"] = await renderTemplate(ctx.cursor(), "stock.help_message_template", { picking_type_code: context["restricted_picking_type_code"] || false }, { lang: env.lang ?? "en_US" });
  return action;
});

/**
 * The code of the standard server actions bound to a model's list (the Action menu): one method of `records` called
 * as `records.<m>()`, `action = records.<m>()`, under `if records:`, or `res = records.<m>()` returned when it is a
 * dict (sale.order Confirm Orders, Mark as Sent; account.move Reset to Draft, Confirm Entries, Pay; purchase.order
 * Confirm RFQ, Merge RFQs; stock.picking Unreserve, Validate). Anything else is not this runner's.
 */
interface RecordsCall { readonly method: string; readonly guarded: boolean; readonly result: "none" | "action" | "dict" }
function recordsMethodCall(code: string): RecordsCall | null {
  const lines = code.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() !== "");
  if (!lines.length) return null;
  const indent = Math.min(...lines.map((l) => l.length - l.trimStart().length));
  const body = lines.map((l) => l.slice(indent)).join("\n");
  const one = /^(action = )?records\.([a-z_][a-z0-9_]*)\(\)$/.exec(body);
  if (one) return { method: one[2]!, guarded: false, result: one[1] ? "action" : "none" };
  const guarded = /^if records:\n( +)(action = )?records\.([a-z_][a-z0-9_]*)\(\)$/.exec(body);
  if (guarded) return { method: guarded[3]!, guarded: true, result: guarded[2] ? "action" : "none" };
  const dict = /^if records:\n( +)res = records\.([a-z_][a-z0-9_]*)\(\)\n\1if isinstance\(res, dict\):\n\1( +)action = res$/.exec(body);
  if (dict) return { method: dict[2]!, guarded: true, result: "dict" };
  // purchase Confirm RFQ: the isinstance test after the `if` block (`res` is unbound without records: a NameError)
  const after = /^if records:\n( +)res = records\.([a-z_][a-z0-9_]*)\(\)\nif isinstance\(res, dict\):\n( +)action = res$/.exec(body);
  if (after) return { method: after[2]!, guarded: false, result: "dict" };
  return null;
}

/**
 * ir_actions.py:1169-1198 `run` of a code action with one of the patterns above: the eval context's `records` (the
 * context's active_ids when active_model is the action's model, :1144-1151) under `mail_notify_force_send=False`
 * (mail ir_actions_server.py:464-470), `_can_execute_action_on_records` (:1233-1260: one of the action's groups, else
 * write access to the model and to the records), the method called as the user, then web action.py:57 `clean_action`
 * of a dict result, else False.
 */
async function runRecordsCode(ctx: Parameters<Parameters<typeof jsonRoute>[1]>[0], actionId: number, model: string, call: RecordsCall, hasGroups: boolean): Promise<unknown> {
  const env0 = await ctx.orm();
  const env = env0.withContext({ ...env0.context, mail_notify_force_send: false });
  const active = env.context["active_model"] === model;
  const rawIds = active ? (env.context["active_ids"] ?? (env.context["active_id"] ? [env.context["active_id"]] : [])) : [];
  if (!Array.isArray(rawIds) || rawIds.some((i) => typeof i !== "number")) throw new NotPorted("server action active_ids value");
  const ids = rawIds as number[];
  const refused = (): AccessError => new AccessError(translate(env, "You don't have enough access rights to run this action."));
  if (hasGroups) {
    const groups = (await env.cr.query<{ x: string }>(
      `SELECT d.module || '.' || d.name AS x FROM ir_act_server_group_rel r JOIN ir_model_data d ON d.model = 'res.groups' AND d.res_id = r.gid
        WHERE r.act_id = $1 ORDER BY d.id`, [actionId])).rows.map((r) => r.x);
    let allowed = false;
    for (const g of groups) if (await hasGroup(env, g)) { allowed = true; break; }
    if (!allowed) throw refused();
  } else {
    try {
      await checkModelAccess(env, env.reg.model(model), "write");
      if (ids.length) await env.model(model).checkAccess(ids, "write");
    } catch (e) {
      if (e instanceof AccessError) throw refused();
      throw e;
    }
  }
  if (!ids.length) {
    // `records` is None without active ids: `if records:` does nothing; a bare `records.<m>()` is an AttributeError
    if (call.guarded) return false;
    throw new NotPorted("server action on records without active_ids (AttributeError on None)");
  }
  const { callKw } = await import("../http/methods");
  const { cleanAction } = await import("../controllers/call_button");
  const res = await callKw(env, model, call.method, [ids], {});
  const action = call.result === "none" ? null : call.result === "dict" ? (isDict(res) ? res : null) : res;
  // action.py:57 `clean_action(result) if isinstance(result, dict) and result else False`
  return isDict(action) && Object.keys(action).length ? cleanAction({ ...action }, env0) : false;
}

const isDict = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** stock_quant.py:1326-1338 `_set_view_context` (product_expiry :38-42 first): the context of the quant views. */
export async function quantViewContext(env: Environment): Promise<Record<string, unknown>> {
  const ctx: Record<string, unknown> = { ...env.context };
  if (ctx["default_product_id"]) {
    const expiry = (await env.cr.query("SELECT 1 FROM ir_module_module WHERE name = 'product_expiry' AND state = 'installed'")).rows.length;
    if (expiry) throw new NotPorted("stock.quant._set_view_context with product_expiry and a default product");
  }
  if (!(await hasGroup(env, "stock.group_stock_multi_locations"))) {
    const wh = (await env.cr.query<{ lot_stock_id: number }>(
      "SELECT lot_stock_id FROM stock_warehouse WHERE company_id = $1 AND active ORDER BY sequence, id LIMIT 1", [await env.company()])).rows[0];
    if (wh) Object.assign(ctx, { default_location_id: wh.lot_stock_id, hide_location: !ctx["always_show_loc"] });
  }
  if (await hasGroup(env, "stock.group_stock_user")) ctx["inventory_mode"] = true;
  return ctx;
}

/**
 * stock_quant.py:1257-1260 `_quant_tasks`: `_merge_quants` (:1210-1253, the same SQL), `_clean_reservations`
 * (:1173-1208; a quant whose reservation differs from its move lines, or one reserved where reservation is bypassed,
 * refuses) and `_unlink_zero_quants` (:1155-1171, the same SQL, then `sudo().unlink()`).
 */
export async function quantTasks(env: Environment): Promise<void> {
  await env.cr.query("SAVEPOINT merge_quants");
  await env.cr.query(`WITH dupes AS (
      SELECT min(id) AS to_update_quant_id, (array_agg(id ORDER BY id))[2:array_length(array_agg(id), 1)] AS to_delete_quant_ids,
             GREATEST(0, SUM(reserved_quantity)) AS reserved_quantity, SUM(inventory_quantity) AS inventory_quantity,
             SUM(quantity) AS quantity, MIN(in_date) AS in_date
        FROM stock_quant GROUP BY product_id, company_id, location_id, lot_id, package_id, owner_id HAVING count(id) > 1),
    _up AS (UPDATE stock_quant q SET quantity = d.quantity, reserved_quantity = d.reserved_quantity,
             inventory_quantity = d.inventory_quantity, in_date = d.in_date FROM dupes d WHERE d.to_update_quant_id = q.id)
    DELETE FROM stock_quant WHERE id IN (SELECT unnest(to_delete_quant_ids) FROM dupes)`);
  await env.cr.query("RELEASE SAVEPOINT merge_quants");
  const unbalanced = (await env.cr.query(`
    WITH q AS (SELECT product_id, location_id, lot_id, package_id, owner_id, sum(reserved_quantity) AS r
                 FROM stock_quant WHERE reserved_quantity != 0 GROUP BY 1, 2, 3, 4, 5),
         ml AS (SELECT l.product_id, l.location_id, l.lot_id, l.package_id, l.owner_id, sum(l.quantity_product_uom) AS r
                  FROM stock_move_line l JOIN product_product p ON p.id = l.product_id JOIN product_template t ON t.id = p.product_tmpl_id
                 WHERE l.state IN ('assigned', 'partially_available', 'waiting', 'confirmed') AND l.quantity_product_uom != 0 AND t.is_storable
                 GROUP BY 1, 2, 3, 4, 5)
    SELECT 1 FROM q FULL JOIN ml ON ml.product_id = q.product_id AND ml.location_id = q.location_id
       AND ml.lot_id IS NOT DISTINCT FROM q.lot_id AND ml.package_id IS NOT DISTINCT FROM q.package_id AND ml.owner_id IS NOT DISTINCT FROM q.owner_id
      JOIN stock_location loc ON loc.id = COALESCE(q.location_id, ml.location_id)
     WHERE loc.usage IN ('supplier', 'customer', 'inventory', 'production') AND q.r IS NOT NULL
        OR loc.usage NOT IN ('supplier', 'customer', 'inventory', 'production') AND abs(COALESCE(q.r, 0) - COALESCE(ml.r, 0)) > 0.000001
     LIMIT 1`)).rows.length;
  if (unbalanced) throw new NotPorted("stock.quant._clean_reservations with reservations to correct");
  const uomDigits = (await env.cr.query<{ digits: number }>(
    "SELECT d.digits FROM decimal_precision d JOIN ir_model_data m ON m.model = 'decimal.precision' AND m.res_id = d.id WHERE m.module = 'uom' AND m.name = 'decimal_product_uom'")).rows[0]?.digits ?? 2;
  const digits = Math.max(6, uomDigits * 2);
  const zero = (await env.cr.query<{ id: number }>(
    `SELECT id FROM stock_quant WHERE (round(quantity::numeric, $1) = 0 OR quantity IS NULL) AND round(reserved_quantity::numeric, $1) = 0
       AND (round(inventory_quantity::numeric, $1) = 0 OR inventory_quantity IS NULL) AND user_id IS NULL`, [digits])).rows.map((r) => r.id);
  if (zero.length) {
    const { unlink } = await import("../orm/unlink");
    await unlink(env.sudo(), "stock.quant", zero);
  }
}

/** stock_quant.py:435-463 `action_view_inventory`. */
async function viewInventory(env0: Environment): Promise<Record<string, unknown>> {
  const ctx = await quantViewContext(env0);
  const env = env0.withContext(ctx);
  const skip = (await env.cr.query<{ value: string }>("SELECT value FROM ir_config_parameter WHERE key = 'stock.skip_quant_tasks'")).rows[0]?.value;
  const { str2bool } = await import("../session/user");
  if (!(skip !== undefined && str2bool(skip))) await quantTasks(env);
  if (await hasGroup(env, "stock.group_stock_user") && !(await hasGroup(env, "stock.group_stock_manager"))) ctx["search_default_my_count"] = true;
  const view = (await env.cr.query<{ res_id: number }>("SELECT res_id FROM ir_model_data WHERE module = 'stock' AND name = 'view_stock_quant_tree_inventory_editable'")).rows[0];
  if (!view) throw new NotPorted("stock.view_stock_quant_tree_inventory_editable missing");
  const { escape } = await import("../pyexpr/values");
  return {
    name: translate(env, "Physical Inventory"), view_mode: "list", res_model: "stock.quant", type: "ir.actions.act_window", context: ctx,
    domain: [["location_id.usage", "in", ["internal", "transit"]]], views: [[view.res_id, "list"]],
    help: `
                <p class="o_view_nocontent_smiling_face">
                    ${String(escape(translate(env, "Your stock is currently empty")))}
                </p>
                <p>
                    ${String(escape(translate(env, 'Press the "New" button to define the quantity for a product in your stock or import quantities from a spreadsheet via the Actions menu')))} <span class="oi oi-filled" data-icon="settings"/>
                </p>
                `,
  };
}

/** stock_account product.py:97-189 _compute_value: both monetary in the company's currency (fields_numeric.py:270-288
 *  convert_to_cache rounds an assigned value with the record's currency). */
async function productValue(env: Environment, rec: Rec): Promise<{ total: number; average: number }> {
  const { total, average } = await productValueRaw(env, rec);
  const currency = (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [await env.company()])).rows[0]?.c ?? null;
  return { total: await roundCurrency(env, total, currency), average: await roundCurrency(env, average, currency) };
}

/** stock_account product.py:97-189 _compute_value, for products of one company in the whole company. */
async function productValueRaw(env: Environment, rec: Rec): Promise<{ total: number; average: number }> {
  if (rec.id === null) throw new NotPorted("product.product valuation of a new record");
  if ((await env.companies()).length > 1) throw new NotPorted("product.product valuation over several companies");
  if (env.context["to_date"]) throw new NotPorted("product.product valuation with to_date");
  const costMethod = String((await rec.get("cost_method")) || "standard");
  if (costMethod !== "standard" && await rec.get("lot_valuated")) throw new NotPorted("product.product valuation of a lot-valuated average or FIFO product");
  if (costMethod === "fifo" && env.context["warehouse_id"]) throw new NotPorted("product.product valuation of a FIFO product in a warehouse");
  if ((await env.cr.query("SELECT 1 FROM stock_quant WHERE owner_id IS NOT NULL LIMIT 1")).rows.length) throw new NotPorted("product.product valuation with consigned stock");
  const company = await env.company();
  // :319-321 `_with_valuation_context`, stock_location.py:17-24 `_search_is_valued`
  const locations = (await env.cr.query<{ id: number }>("SELECT id FROM stock_location WHERE company_id = $1 AND usage IN ('internal', 'transit')", [company])).rows.map((r) => r.id);
  const qty = (await quantitiesDict(env.withContext({ ...env.context, location: locations, strict: true }), [rec.id])).get(rec.id)?.qty_available ?? 0;
  const price = Number((await rec.get("standard_price")) ?? 0);
  const digits = (await env.cr.query<{ digits: number }>("SELECT digits FROM decimal_precision WHERE name = 'Product Unit'")).rows[0]?.digits ?? 2;
  if (await rec.get("lot_valuated")) {
    // :125-144 the sum of the lots, stock_lot.py:23-46 _compute_value of standard products
    let total = 0;
    for (const id of await env.sudo().model("stock.lot").search(cond("product_id", "=", rec.id))) {
      const lot = new DbRec(env.sudo(), env.reg.model("stock.lot"), id);
      const lotQty = Number((await lot.get("product_qty")) ?? 0);
      if (floatRound(lotQty, digits) !== 0) total += Number((await lot.get("standard_price")) ?? 0) * lotQty;
    }
    return { total, average: qty ? total / qty : price };
  }
  if (floatRound(qty, digits) === 0) return { total: 0, average: price };
  // :164-177 `_run_avco` without a date is the cost times the quantity, as `_run_standard`; `_run_fifo` sums its stack
  if (costMethod === "fifo") return costedValue(env, rec.id, costMethod, qty, price);
  let total = qty * price;
  if (env.context["warehouse_id"]) {
    // :149-162 with :170-180: the value of the whole company (`_run_standard` with warehouse_id=False), times the
    // warehouse's share of the quantity when it differs
    const whole = (await quantitiesDict(env.withContext({ ...env.context, location: locations, strict: true, warehouse_id: false }), [rec.id])).get(rec.id)?.qty_available ?? 0;
    if (floatRound(whole, digits) === 0) total = price * qty;
    else total = whole * price * (floatRound(qty, digits) !== floatRound(whole, digits) ? qty / whole : 1);
  }
  return { total, average: qty ? total / qty : price };
}

/** stock_account stock_quant.py:47-65 `_compute_value`: the quant's share of its product's value in its company. */
async function quantValue(env: Environment, rec: Rec): Promise<number> {
  const location = idOf(await rec.get("location_id")), product = idOf(await rec.get("product_id"));
  if (location === null || product === null) return 0;
  const company = idOf(await rec.get("company_id"));
  // stock_location.py:30-35 `_should_be_valued`
  const [loc] = (await env.cr.query<{ company_id: number | null; usage: string }>("SELECT company_id, usage FROM stock_location WHERE id = $1", [location])).rows;
  if (!loc?.company_id || loc.company_id !== await env.company() || !["internal", "transit"].includes(loc.usage)) return 0;
  const owner = idOf(await rec.get("owner_id"));
  if (owner !== null) {
    const partner = (await env.cr.query<{ p: number }>("SELECT partner_id AS p FROM res_company WHERE id = $1", [company])).rows[0]?.p;
    if (owner !== partner) return 0;
  }
  const digits = (await env.cr.query<{ digits: number }>("SELECT digits FROM decimal_precision WHERE name = 'Product Unit'")).rows[0]?.digits ?? 2;
  const quantity = Number((await rec.get("quantity")) ?? 0);
  if (floatRound(quantity, digits) === 0) return 0;
  const cenv = company === null ? env : env.withContext({ ...env.context, allowed_company_ids: [company] });
  const prod = new DbRec(cenv, cenv.reg.model("product.product"), product);
  if (await prod.get("lot_valuated")) throw new NotPorted("stock.quant.value of a lot valuated product");
  const locations = (await cenv.cr.query<{ id: number }>("SELECT id FROM stock_location WHERE company_id = $1 AND usage IN ('internal', 'transit')", [await cenv.company()])).rows.map((r) => r.id);
  const qty = (await quantitiesDict(cenv.withContext({ ...cenv.context, location: locations, strict: true }), [product])).get(product)?.qty_available ?? 0;
  if (floatRound(qty, digits) === 0) return 0;
  const currency = (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [company ?? await env.company()])).rows[0]?.c ?? null;
  return roundCurrency(env, quantity * (await productValue(cenv, prod)).total / qty, currency);
}
defineComputes("stock.quant", { value: quantValue });
defineComputes("product.product", {
  company_currency_id: async (env) => (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [await env.company()])).rows[0]?.c ?? null,
  total_value: async (env, rec) => (await productValue(env, rec)).total,
  avg_cost: async (env, rec) => (await productValue(env, rec)).average,
});

// stock_picking.py:534-537
defineComputes("stock.picking", { return_count: async (_env, rec) => (await rec.rels("return_ids")).length });

// payment_provider.py:321-352 _compute_feature_support_fields: payment's (None, read as False); a provider module's
// compiled override replaces it (payment_demo)
defineComputes("payment.provider", {
  support_express_checkout: async () => null,
  support_manual_capture: async () => null,
  support_refund: async () => "none",
  support_tokenization: async () => null,
});

// product_template.py:996-1024 action_open_documents with :268-279 `_get_product_document_domain`
registerMethod("product.template", "action_open_documents", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = (ids ?? [])[0];
  if (id === undefined || (ids ?? []).length !== 1) throw new NotPorted("action_open_documents of several products");
  const variants = await variantsOf(env, [id]);
  const row = (await env.model("product.template").read([id], ["company_id"], ""))[0];
  return {
    name: translate(env, "Documents"), type: "ir.actions.act_window", res_model: "product.document", view_mode: "kanban,list,form",
    context: { default_res_model: "product.template", default_res_id: id, default_company_id: row?.["company_id"] ?? false },
    domain: ["|", "&", ["res_model", "=", "product.template"], ["res_id", "in", [id]], "&", ["res_model", "=", "product.product"], ["res_id", "in", variants]],
    target: "current",
    help: `
                <p class="o_view_nocontent_smiling_face">
                    ${translate(env, "Upload files to your product")}
                </p>
                <p>
                    ${translate(env, "Use this feature to store any files you would like to share with your customers")}
                    <br/>
                    ${translate(env, "(e.g: product description, ebook, legal notice, ...).")}
                </p>
            `,
    views: [[false, "kanban"], [false, "list"], [false, "form"]],
  };
}, { apiModel: false });

// stock/models/product.py:1236-1252 action_open_product_lot
registerMethod("product.template", "action_open_product_lot", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = (ids ?? [])[0];
  if (id === undefined || (ids ?? []).length !== 1) throw new NotPorted("action_open_product_lot of several products");
  const action = await actionOf(env, "stock.action_product_production_lot_form");
  action["domain"] = [["product_id.product_tmpl_id", "=", id], "|", ["location_id", "=", false],
    ["location_id", "any", [["company_id", "in", [...(await env.companies()), false]]]]];
  const variants = await variantsOf(env, [id]);
  const context: Record<string, unknown> = { default_product_tmpl_id: id, search_default_group_by_location: true };
  if (variants.length === 1) context["default_product_id"] = variants[0];
  action["context"] = context;
  return action;
}, { apiModel: false });

// stock/models/product.py:1271-1276 action_product_tmpl_forecast_report
registerMethod("product.template", "action_product_tmpl_forecast_report", async (env0, _ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const warehouse = (await env.cr.query("SELECT 1 FROM stock_warehouse WHERE company_id = $1 AND active LIMIT 1", [await env.company()])).rows.length;
  if (!warehouse) throw new NotPorted("action_product_tmpl_forecast_report without a warehouse (_warehouse_redirect_warning)");
  return actionOf(env, "stock.stock_forecasted_product_template_action");
}, { apiModel: false });

async function setOnAllVariants(env: Environment, ids: readonly number[], fname: "volume" | "weight"): Promise<void> {
  const rows = (await env.cr.query<{ id: number; v: number | null }>(`SELECT id, ${fname}::float8 AS v FROM product_template WHERE id = ANY($1::int[])`, [[...ids]])).rows;
  for (const r of rows) {
    let variants = await variantsOf(env, [r.id]);
    if (!variants.length) variants = await variantsOf(env, [r.id], false);
    if (variants.length) await write(env, "product.product", variants, { [fname]: r.v ?? 0 });
  }
}

// product_template.py:737-740 _set_base_unit_count, :651-654 _set_default_code, :551-554 _set_barcode
registerOverrides("product.template", {
  inverse: {
    default_code: async (env, ids) => {
      const rows = (await env.cr.query<{ id: number; v: string | null }>("SELECT id, default_code AS v FROM product_template WHERE id = ANY($1::int[])", [[...ids]])).rows;
      for (const r of rows) {
        const variants = await variantsOf(env, [r.id]);
        if (variants.length === 1) await write(env, "product.product", variants, { default_code: r.v ?? false });
      }
    },
    // :533-541 _set_volume / _set_weight: `_set_product_variant_field(fname, update_all_variants=True)` (:446-461), every
    // variant, or the archived ones of a template without active variants
    volume: async (env, ids) => setOnAllVariants(env, ids, "volume"),
    weight: async (env, ids) => setOnAllVariants(env, ids, "weight"),
    // :551-554 _set_barcode
    barcode: async (env, ids) => {
      const rows = (await env.cr.query<{ id: number; v: string | null }>("SELECT id, barcode AS v FROM product_template WHERE id = ANY($1::int[])", [[...ids]])).rows;
      for (const r of rows) {
        const variants = await variantsOf(env, [r.id]);
        if (variants.length === 1) await write(env, "product.product", variants, { barcode: r.v ?? false });
      }
    },
    base_unit_count: async (env, ids) => {
      const rows = (await env.cr.query<{ id: number; v: number }>("SELECT id, base_unit_count::float8 AS v FROM product_template WHERE id = ANY($1::int[])", [[...ids]])).rows;
      for (const r of rows) {
        const variants = await variantsOf(env, [r.id]);
        if (variants.length === 1) await write(env, "product.product", variants, { base_unit_count: r.v });
      }
    },
  },
});

// sale_report.py action_open_order with `_get_order_reference`: the report's id is the line's, ir_ui_view.py:3307-3328 `_get_records_action`
registerMethod("sale.report", "action_open_order", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  if ((ids ?? []).length !== 1) throw new NotPorted("sale.report.action_open_order of several lines");
  const order = (await env.cr.query<{ o: number }>("SELECT order_id AS o FROM sale_order_line WHERE id = $1", [ids![0]])).rows[0]?.o;
  if (!order) throw new NotPorted("sale.report.action_open_order without a line");
  const context = Object.fromEntries(Object.entries(env.context).filter(([k]) => !k.startsWith("default_")));
  return { type: "ir.actions.act_window", res_model: "sale.order", target: "current", context, views: [[false, "form"]], res_id: order };
}, { apiModel: false });

/** The one record of a button on the variant list. */
function single(ids: number[] | null, what: string): number {
  if ((ids ?? []).length !== 1) throw new NotPorted(`product.product.${what} of several products`);
  return ids![0]!;
}

// product_product.py:1233-1243 action_open_documents, over product_template.py:996-1024
registerMethod("product.product", "action_open_documents", async (env0, ids, args, kwargs0, model) => {
  const { env } = envFor(env0, kwargs0);
  const id = single(ids, "action_open_documents");
  const template = (await env.cr.query<{ t: number }>("SELECT product_tmpl_id AS t FROM product_product WHERE id = $1", [id])).rows[0]!.t;
  const res = await lookupMethod("product.template", "action_open_documents")!.fn(env, [template], args, {}, model) as Record<string, unknown>;
  res["context"] = { ...(res["context"] as Record<string, unknown>), default_res_model: "product.product", default_res_id: id };
  res["domain"] = ["|", "&", ["res_model", "=", "product.product"], ["res_id", "=", id], "&", ["res_model", "=", "product.template"], ["res_id", "=", template]];
  return res;
}, { apiModel: false });

// stock/models/product.py:690-695
registerMethod("product.product", "action_product_forecast_report", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  single(ids, "action_product_forecast_report");
  const warehouse = (await env.cr.query("SELECT 1 FROM stock_warehouse WHERE company_id = $1 AND active LIMIT 1", [await env.company()])).rows.length;
  if (!warehouse) throw new NotPorted("action_product_forecast_report without a warehouse (_warehouse_redirect_warning)");
  return actionOf(env, "stock.stock_forecasted_product_product_action");
}, { apiModel: false });

// stock/models/product.py:614-618
registerMethod("product.product", "action_view_stock_move_lines", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = single(ids, "action_view_stock_move_lines");
  const action = await actionOf(env, "stock.stock_move_line_action");
  action["domain"] = [["product_id", "=", id]];
  return action;
}, { apiModel: false });

// stock/models/product.py:595-609
registerMethod("product.product", "action_view_orderpoints", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = single(ids, "action_view_orderpoints");
  const action = await actionOf(env, "stock.action_orderpoint");
  const own = evalExpr(typeof action["context"] === "string" ? action["context"] : "{}", new Map([["uid", env.uid]]));
  const context = new Map<string, unknown>(own instanceof Map ? own as Map<string, unknown> : Object.entries(own as Record<string, unknown>));
  context.delete("search_default_trigger");
  action["context"] = { ...Object.fromEntries(context), search_default_filter_not_snoozed: true, default_product_id: id, search_default_product_id: id };
  return action;
}, { apiModel: false });

// stock/models/product.py:641-654
registerMethod("product.product", "action_open_product_lot", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = single(ids, "action_open_product_lot");
  const action = await actionOf(env, "stock.action_product_production_lot_form");
  action["domain"] = [["product_id", "=", id], "|", ["location_id", "=", false],
    ["location_id", "any", [["company_id", "in", [...(await env.companies()), false]]]]];
  action["context"] = { default_product_id: id, set_product_readonly: true, search_default_group_by_location: true };
  return action;
}, { apiModel: false });

// purchase/models/product.py:160-164
registerMethod("product.product", "action_view_po", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = single(ids, "action_view_po");
  const action = await actionOf(env, "purchase.action_purchase_history");
  action["domain"] = ["&", ["state", "=", "purchase"], ["product_id", "in", [id]]];
  const name = (await env.model("product.product").displayName([id])).get(id) ?? "";
  action["display_name"] = translate(env, "Purchase History for %s").replace("%s", name);
  return action;
}, { apiModel: false });

// sale/models/product_product.py:115-125
registerMethod("product.product", "action_view_sales", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const action = await actionOf(env, "sale.report_all_channels_sales_action");
  action["domain"] = [["product_id", "in", [...(ids ?? [])]]];
  action["context"] = {
    pivot_measures: ["product_uom_qty"], active_id: env.context["active_id"] ?? null, search_default_Sales: 1, active_model: "sale.report", search_default_filter_order_date: 1,
  };
  return action;
}, { apiModel: false });

// product_document.py:31-38 _compute_variant_attribute_value_ids
defineComputes("product.document", {
  variant_attribute_value_ids: async (env, rec) => {
    if ((await rec.get("res_model")) !== "product.product" || !(await rec.get("res_id"))) return [];
    return new DbRec(env, env.reg.model("product.product"), Number(await rec.get("res_id"))).get("product_template_attribute_value_ids");
  },
});

// stock/models/product.py:1046-1047 `_set_tracking`: a tracked goods product is storable
registerOverrides("product.template", {
  inverse: {
    // stock/models/product.py:893-910 `_inverse_serial_prefix_format`: without a prefix the default lot sequence
    // (`env.ref('stock.sequence_production_lots', raise_if_not_found=False)`); a prefix finds or creates its sequence
    serial_prefix_format: async (env, ids, vals) => {
      if (vals["serial_prefix_format"]) throw new NotPorted("product.template serial_prefix_format with a prefix (ir.sequence search and create)");
      const seq = (await env.cr.query<{ id: number }>(
        `SELECT d.res_id AS id FROM ir_model_data d JOIN ir_sequence s ON s.id = d.res_id
          WHERE d.module = 'stock' AND d.name = 'sequence_production_lots' AND d.model = 'ir.sequence'`)).rows[0]?.id ?? false;
      await write(env, "product.template", [...ids], { lot_sequence_id: seq });
    },
    tracking: async (env, ids) => {
      const todo = (await env.cr.query<{ id: number }>(
        "SELECT id FROM product_template WHERE id = ANY($1::int[]) AND tracking IS NOT NULL AND tracking != '' AND type = 'consu' ORDER BY id", [[...ids]])).rows.map((r) => r.id);
      if (todo.length) await write(env, "product.template", todo, { is_storable: true });
    },
  },
});

/** stock/models/product.py:1054-1060 `_set_store_by`, which runs after the record is written. */
function storeByValues(storeBy: unknown, type: unknown): Record<string, unknown> {
  const isStorable = storeBy !== "untracked" && Boolean(storeBy) && type === "consu";
  return { is_storable: isStorable, tracking: isStorable && (storeBy === "lot" || storeBy === "serial") ? storeBy : false };
}
/** stock_picking.py:271-301 _compute_products_availability. */
async function pickingAvailability(env: Environment, rec: Rec): Promise<{ label: string | false; state: string | false }> {
  const state = await rec.get("state");
  if (!["waiting", "confirmed", "assigned"].includes(String(state)) || !["outgoing", "internal"].includes(String(await rec.get("picking_type_code")))) return { label: false, state: false };
  const moves = await rec.rels("move_ids");
  const ids = moves.map((m) => m.origin).filter((id): id is number => id !== null);
  if (ids.length !== moves.length) throw new NotPorted("stock.picking.products_availability of new moves");
  return availabilityOf(env, rec, moves, await moveForecast(env, ids));
}

/** The picking's availability from its moves' forecast (stock_picking.py:286-301). */
async function availabilityOf(env: Environment, rec: Rec, moves: readonly Rec[], forecast: ReadonlyMap<number, { availability: number; expected: string | false }>): Promise<{ label: string | false; state: string | false }> {
  const digits = (await env.cr.query<{ digits: number }>("SELECT digits FROM decimal_precision WHERE name = 'Product Unit'")).rows[0]?.digits ?? 2;
  let latest: string | false = false;
  for (const move of moves) {
    const f = forecast.get(move.origin!);
    const wanted = (await move.get("state")) === "draft" ? 0 : Number((await move.get("product_qty")) ?? 0);
    if ((await move.get("product_id")) && floatRound(f?.availability ?? 0, digits) < floatRound(wanted, digits)) return { label: translate(env, "Not Available"), state: "late" };
    if (f?.expected && (!latest || f.expected > latest)) latest = f.expected;
  }
  if (!latest) return { label: translate(env, "Available"), state: "available" };
  const scheduled = await rec.get("scheduled_date");
  return { label: translate(env, "Exp %s").replace("%s", await formatDate(env, latest.length > 10 ? todayInTz(new Date(`${latest.replace(" ", "T")}Z`), await envTz(env)) : latest)), state: typeof scheduled === "string" && scheduled < latest ? "late" : "expected" };
}

/**
 * `_compute_products_availability` of a recordset (stock_picking.py:271-301): the forecast of all the pickings' moves
 * computed together (`all_moves._fields['forecast_availability'].compute_value(all_moves)`), then each picking.
 */
async function pickingsAvailability(env: Environment, ids: readonly number[]): Promise<Map<number, { label: string | false; state: string | false }>> {
  const def = env.reg.model("stock.picking");
  const out = new Map<number, { label: string | false; state: string | false }>();
  const states = await readFieldBatch(env, def, ids, "state");
  const codes = await readFieldBatch(env, def, ids, "picking_type_code");
  const pickings = ids.filter((id) => ["waiting", "confirmed", "assigned"].includes(String(states.get(id))) && ["outgoing", "internal"].includes(String(codes.get(id))));
  for (const id of ids) out.set(id, { label: false, state: false });
  if (!pickings.length) return out;
  const movesOf = await readFieldBatch(env, def, pickings, "move_ids");
  const allMoves = [...new Set(pickings.flatMap((id) => (movesOf.get(id) as number[] | undefined ?? []).map(Number)))];
  const forecast = await moveForecast(env, allMoves);
  const moveDef = env.reg.model("stock.move");
  for (const id of pickings) {
    const moves = (movesOf.get(id) as number[] | undefined ?? []).map((m) => new DbRec(env, moveDef, Number(m)));
    out.set(id, await availabilityOf(env, new DbRec(env, def, id), moves, forecast));
  }
  return out;
}

/** Both fields come from one compute (Odoo computes and caches them together): kept until the next write. */
const availabilityMemo = new WeakMap<object, { key: string; value: Promise<Map<number, { label: string | false; state: string | false }>> }>();
function pickingsAvailabilityOnce(env: Environment, ids: readonly number[]): Promise<Map<number, { label: string | false; state: string | false }>> {
  const key = JSON.stringify([env.cr.rows.writeCount(), env.uid, env.su, env.lang, env.context, ids]);
  const hit = availabilityMemo.get(env.cr);
  if (hit !== undefined && hit.key === key) return hit.value;
  const value = pickingsAvailability(env, ids);
  availabilityMemo.set(env.cr, { key, value });
  return value;
}

// a record computes them alone, a list for all its records at once (each key registered once: compiled modules
// replace them by key)
registerRecordCompute("stock.picking", {
  products_availability: async (env, rec) => (await pickingAvailability(env, rec)).label,
  products_availability_state: async (env, rec) => (await pickingAvailability(env, rec)).state,
});
registerHooks("stock.picking", { computed: {
  products_availability: async (env, ids) => new Map([...await pickingsAvailabilityOnce(env, ids)].map(([id, v]) => [id, v.label])),
  products_availability_state: async (env, ids) => new Map([...await pickingsAvailabilityOnce(env, ids)].map(([id, v]) => [id, v.state])),
} });

// stock_picking.py:238-244 _search_date_category with :1673-1720 `date_category_to_domain`
registerHooks("stock.picking", {
  search: {
    search_date_category: searchMethod("stock.picking", "search_date_category", async (env, operator, value) => {
      if (operator !== "in") return null;
      const tz = await envTz(env);
      const start = localMidnightToUtc(new PyDate(Date.parse(`${todayInTz(await dbNow(env), tz)}T00:00:00Z`)), tz);
      const at = (days: number): string => datetimeToString(new Date(start.ms + days * 86400000));
      const ranges: Record<string, unknown[]> = {
        before: [["scheduled_date", "<", at(-1)]],
        yesterday: [["scheduled_date", ">=", at(-1)], ["scheduled_date", "<", at(0)]],
        today: [["scheduled_date", ">=", at(0)], ["scheduled_date", "<", at(1)]],
        day_1: [["scheduled_date", ">=", at(1)], ["scheduled_date", "<", at(2)]],
        day_2: [["scheduled_date", ">=", at(2)], ["scheduled_date", "<", at(3)]],
        after: [["scheduled_date", ">=", at(3)]],
      };
      const items = Array.isArray(value) ? value : [value];
      return or(items.map((item) => parseDomain(ranges[String(item)] ?? [])));
    }),
  },
});

/** Find a rule on a specific route_id walking up the location chain (stock_rule.py `_get_rule` with route_ids). */
async function findRuleForRoute(env: Environment, location: number, routeId: number, warehouse: number | null, company: number): Promise<RuleRow | null> {
  const chain = (await env.cr.query<{ id: number }>(
    `WITH RECURSIVE up(id, parent, depth) AS (SELECT id, location_id, 0 FROM stock_location WHERE id = $1
       UNION ALL SELECT l.id, l.location_id, up.depth + 1 FROM stock_location l JOIN up ON l.id = up.parent) SELECT id FROM up ORDER BY depth`, [location])).rows.map((r) => r.id);
  const rules = (await env.cr.query<RuleRow & { location_dest_id: number }>(
    `SELECT r.id, r.action, r.procure_method, r.location_src_id, r.picking_type_id, r.warehouse_id, r.delay, r.propagate_cancel, r.company_id, r.location_dest_from_rule,
            r.partner_address_id, r.route_id, r.location_dest_id
       FROM stock_rule r WHERE r.active AND r.action != 'push' AND r.route_id = $1 AND r.location_dest_id = ANY($2::int[])
        AND (r.warehouse_id = $3 OR r.warehouse_id IS NULL) AND (r.company_id IS NULL OR r.company_id = $4)
      ORDER BY r.route_sequence, r.sequence, r.id`, [routeId, chain, warehouse, company])).rows;
  for (const loc of chain) {
    const candidates = rules.filter((r) => r.location_dest_id === loc);
    const hit = candidates.find((r) => r.warehouse_id === warehouse) ?? candidates.find((r) => r.warehouse_id === null);
    if (hit) return hit;
  }
  return null;
}

/** product.py:707-724 `_get_rules_from_location(location)`: the pull chain up to a make_to_stock or non-pull rule. */
export async function rulesFromLocation(env: Environment, line: { template: number; categ: number }, location: number, company: number, routeId?: number | null): Promise<RuleRow[]> {
  const seen: RuleRow[] = [];
  let loc = location;
  for (;;) {
    const warehouse = (await env.cr.query<{ w: number | null }>("SELECT warehouse_id AS w FROM stock_location WHERE id = $1", [loc])).rows[0]?.w ?? null;
    const rule = (routeId ? await findRuleForRoute(env, loc, routeId, warehouse, company) : null)
      ?? await findRule(env, line, loc, warehouse, company);
    if (!rule) return seen;
    if (seen.some((r) => r.id === rule.id)) throw new NotPorted("rule chain with an endless loop (UserError)");
    seen.push(rule);
    if (rule.procure_method === "make_to_stock" || !["pull_push", "pull"].includes(rule.action)) return seen;
    loc = rule.location_src_id;
  }
}

/**
 * stock_orderpoint.py:481-490 `_get_default_route` (mrp is not installed): the first route of
 * `product.route_ids | categ_id.total_route_ids` (product_category.py:1325, the category's routes then its parents',
 * :1310-1317) with an active pull or pull_push rule into the orderpoint's location.
 */
export async function orderpointDefaultRoute(env: Environment, product: number | null, location: number | null, op?: { company: number; route: number | null }): Promise<number | null> {
  if (!product) return null;
  // purchase_stock stock.py:282-291: with vendors (or a confirmed purchase) the route of the buy rule in `rule_ids`
  if (op && location) {
    const tmpl = (await env.cr.query<{ t: number; c: number }>("SELECT p.product_tmpl_id AS t, t.categ_id AS c FROM product_product p JOIN product_template t ON t.id = p.product_tmpl_id WHERE p.id = $1", [product])).rows[0]!;
    const sellers = (await env.cr.query("SELECT 1 FROM product_supplierinfo WHERE product_tmpl_id = $1 LIMIT 1", [tmpl.t])).rows.length > 0;
    const purchased = sellers || (await env.cr.query(
      `SELECT 1 FROM purchase_order_line l JOIN purchase_order o ON o.id = l.order_id
        WHERE l.product_id = $1 AND o.state = 'purchase' AND o.date_approve IS NOT NULL AND o.company_id = $2 LIMIT 1`, [product, op.company])).rows.length > 0;
    if (purchased) {
      for (const rule of await rulesFromLocation(env, { template: tmpl.t, categ: tmpl.c }, location, op.company, op.route)) {
        if (rule.action === "buy") return rule.route_id;
      }
    }
  }
  const own = (await env.cr.query<{ id: number }>(
    `SELECT r.id FROM stock_route r JOIN stock_route_product rp ON rp.route_id = r.id JOIN product_product p ON p.product_tmpl_id = rp.product_id
      WHERE p.id = $1 ORDER BY r.sequence, r.id`, [product])).rows.map((r) => r.id);
  const categ = (await env.cr.query<{ id: number; parent_path: string }>(
    "SELECT c.id, c.parent_path FROM product_category c JOIN product_template t ON t.categ_id = c.id JOIN product_product p ON p.product_tmpl_id = t.id WHERE p.id = $1", [product])).rows[0];
  const routes = [...own];
  if (categ) {
    const chain = categ.parent_path.split("/").filter(Boolean).map(Number).reverse(); // the category, then its parents upward
    for (const cid of chain) {
      for (const r of (await env.cr.query<{ id: number }>(
        "SELECT r.id FROM stock_route r JOIN stock_route_categ rc ON rc.route_id = r.id WHERE rc.categ_id = $1 ORDER BY r.sequence, r.id", [cid])).rows) {
        if (!routes.includes(r.id)) routes.push(r.id);
      }
    }
  }
  for (const id of routes) {
    const ok = (await env.cr.query(
      "SELECT 1 FROM stock_rule ru JOIN stock_route r ON r.id = ru.route_id WHERE ru.route_id = $1 AND r.active AND ru.active AND ru.location_dest_id = $2 AND ru.action IN ('pull_push', 'pull') LIMIT 1",
      [id, location])).rows.length;
    if (ok) return id;
  }
  return null;
}

// stock_orderpoint.py:317-323 _compute_unwanted_replenish, :430-433 _compute_qty_to_order, :267-270 _compute_route_id_placeholder
defineComputes("stock.warehouse.orderpoint", {
  route_id_placeholder: async (env, rec) => {
    const route = await orderpointDefaultRoute(env, idOf(await rec.get("product_id")), idOf(await rec.get("location_id")),
      { company: idOf(await rec.get("company_id")) ?? await env.company(), route: idOf(await rec.get("route_id")) });
    if (!route) return "";
    return (await env.model("stock.route").displayName([route])).get(route) ?? "";
  },
  // purchase_stock stock.py:206-212 `_compute_show_supplier`: the effective route (stock_orderpoint.py:273-275, the
  // orderpoint's route or `_get_default_route`) is the route of a buy rule (`search_read` as the user: active rules)
  show_supplier: async (env, rec) => {
    const effective = idOf(await rec.get("route_id")) ?? await orderpointDefaultRoute(env, idOf(await rec.get("product_id")), idOf(await rec.get("location_id")),
      { company: idOf(await rec.get("company_id")) ?? await env.company(), route: null });
    if (!effective) return false;
    const rules = await env.model("stock.rule").search(cond("action", "=", "buy"));
    if (!rules.length) return false;
    return (await env.cr.query("SELECT 1 FROM stock_rule WHERE id = ANY($1::int[]) AND route_id = $2 LIMIT 1", [rules, effective])).rows.length > 0;
  },
  // purchase_stock stock.py:219-223 `_compute_supplier_id_placeholder`: `_get_seller_info_display_name` (product.py:301-305)
  // of `_get_default_supplier` (:293-300): with the supplier column, stock_rule.py:393-410 `_pick_supplier` for the
  // orderpoint's company, quantity to order and unit (every `_select_seller` there dated `context_today`)
  supplier_id_placeholder: async (env, rec) => {
    if (!(await rec.get("show_supplier"))) return "";
    const product = await rec.rel("product_id");
    if (!product) return "";
    const company = idOf(await rec.get("company_id")) ?? await env.company();
    const cenv = env.withContext({ ...env.context, allowed_company_ids: [company] });
    const { selectSeller } = await import("./purchase_flow");
    const { contextToday } = await import("./stock_engine");
    const today = await contextToday(cenv);
    const uom = idOf(await rec.get("uom_id"));
    const pick = (quantity: number | null, u: number | null) => selectSeller(cenv, product, {
      company, partner: null, date: today, quantity, uom: u, forceUom: false, params: false, envCompany: company,
    });
    const seller = (await pick(Number((await rec.get("qty_to_order")) ?? 0), uom)) ?? (await pick(null, uom)) ?? (await pick(null, null));
    if (!seller) {
      // :408-409 the last fallback, also matching expired pricelists
      const tmpl = idOf(await product.get("product_tmpl_id"));
      if ((await env.cr.query("SELECT 1 FROM product_supplierinfo WHERE product_tmpl_id = $1 LIMIT 1", [tmpl])).rows.length) {
        throw new NotPorted("orderpoint supplier placeholder of an expired or other company's vendor (_prepare_sellers fallback)");
      }
      return "";
    }
    const vendor = (await env.model("res.partner").displayName([seller.partner_id])).get(seller.partner_id) ?? "";
    const uomName = (await env.cr.query<{ n: string | null }>("SELECT COALESCE(name->>$2, name->>'en_US') AS n FROM uom_uom WHERE id = $1",
      [seller.uom_id, env.lang ?? "en_US"])).rows[0]?.n ?? "False";
    const { formatLangCurrency } = await import("./product_computes");
    const { pyFloatReprSimple } = await import("./util");
    return `${vendor} (${pyFloatReprSimple(seller.min_qty)} ${uomName} - ${await formatLangCurrency(env, seller.price, seller.currency_id)})`;
  },
  // stock_orderpoint.py:256-260 over purchase_stock stock.py:336-351 (and mrp stock_orderpoint.py:149-155)
  // `_get_replenishment_multiple_alternative(qty_to_order)`: the unit of the vendor a buy route would pick
  replenishment_uom_id_placeholder: async (env, rec) => {
    const product = await rec.rel("product_id");
    if (!product) return "";
    const own = idOf(await rec.get("route_id")) ?? await orderpointDefaultRoute(env, product.origin!, idOf(await rec.get("location_id")),
      { company: idOf(await rec.get("company_id")) ?? await env.company(), route: null });
    const routes = own ? [own] : (await env.cr.query<{ r: number }>(
      "SELECT route_id AS r FROM stock_route_product WHERE product_id = $1", [idOf(await product.get("product_tmpl_id"))])).rows.map((x) => x.r);
    const actions = new Set((await env.cr.query<{ a: string }>(
      "SELECT DISTINCT action AS a FROM stock_rule WHERE route_id = ANY($1::int[]) AND active", [routes])).rows.map((x) => x.a));
    if (actions.has("manufacture")) throw new NotPorted("orderpoint replenishment unit of a manufacture route (mrp _bom_find)");
    if (!actions.has("buy")) return "";
    const company = idOf(await rec.get("company_id")) ?? await env.company();
    let uom: number | null = null;
    const supplier = idOf(await rec.get("supplier_id"));
    if (supplier) uom = (await env.cr.query<{ u: number }>("SELECT uom_id AS u FROM product_supplierinfo WHERE id = $1", [supplier])).rows[0]?.u ?? null;
    else {
      const { selectSeller } = await import("./purchase_flow");
      const seller = await selectSeller(env, product, {
        company, partner: null, date: null, quantity: Number((await rec.get("qty_to_order")) ?? 0), uom: idOf(await rec.get("uom_id")), forceUom: false, params: false, envCompany: company,
      });
      if (seller?.lastPo) throw new NotPorted("vendor from the last confirmed purchase (purchase/models/product.py _get_last_po_seller_info) for an orderpoint");
      uom = seller?.uom_id ?? null;
    }
    if (!uom) return "";
    return (await env.model("uom.uom").displayName([uom])).get(uom) ?? "";
  },
  qty_to_order: async (_env, rec) => {
    const manual = Number((await rec.get("qty_to_order_manual")) ?? 0);
    return manual ? manual : Number((await rec.get("qty_to_order_computed")) ?? 0);
  },
  unwanted_replenish: async (env, rec) => {
    const product = idOf(await rec.get("product_id"));
    const digits = (await env.cr.query<{ digits: number }>("SELECT digits FROM decimal_precision WHERE name = 'Product Unit'")).rows[0]?.digits ?? 2;
    const qty = Number((await rec.get("qty_to_order")) ?? 0), max = Number((await rec.get("product_max_qty")) ?? 0);
    if (!product || floatRound(qty, digits) === 0 || floatRound(max, digits) < 0) return false;
    const cenv = env.withContext({ ...env.context, company_id: idOf(await rec.get("company_id")), location: idOf(await rec.get("location_id")) });
    const virtual = (await quantitiesDict(cenv, [product])).get(product)?.virtual_available ?? 0;
    return floatRound(virtual + qty, digits) > floatRound(max, digits);
  },
});

// product_product.py:252-268 _compute_write_date: the template's when it is later
registerRecordCompute("product.product", {
  write_date: async (env, rec) => {
    const own = await rec.prev("write_date");
    const template = await rec.rel("product_tmpl_id");
    const of = template ? await template.get("write_date") : null;
    const current = typeof own === "string" && own ? own : datetimeToString(await dbNow(env));
    return typeof of === "string" && of > current ? of : current;
  },
});

/** stock/models/product.py:280-298 `_inverse_qty_available`: an adjustment to nothing leaves no quant behind. */
function dropZeroQuantity(vals: Record<string, unknown>): void {
  // product_template.py:470-471 `_set_standard_price`: a zero cost is what a new variant has already
  // (`num`: a float from compiled code is a PyFloat, which Number() made NaN and so dropped every compiled cost write:
  // stock_landed_costs' `_update_standard_price` after a landed cost, vagb_landed_cost)
  if ("standard_price" in vals && !num(vals["standard_price"])) delete vals["standard_price"];
  if (!("qty_available" in vals)) return;
  if (Number(plainNumber(vals["qty_available"]) ?? 0) !== 0) throw new NotPorted("qty_available inverse (inventory adjustment from the product)");
  delete vals["qty_available"];
}
// the modules' create overrides of products sit above mail.thread: the creation message comes inside `next`, before the
// variants a template creates (product_template.py:818-820) and before stock_account's cost row of a variant
HOOKS_INSIDE.add("product.template");
HOOKS_INSIDE.add("product.product");

registerOverrides("product.product", {
  // product_product.py create: `super(ProductProduct, self.with_context(create_product_product=False)).create(vals_list)`,
  // so the template created through `_inherits` makes no variant of its own
  create: async (env, valsList, next) => {
    valsList.forEach(dropZeroQuantity);
    const ids = await next(env.withContext({ ...env.context, create_product_product: false }), valsList);
    await initialCostRows(env, ids);
    return ids;
  },
  // stock_account product.py:197-211: a new cost writes a cost row of the old and new cost (`_change_standard_price`),
  // unless `disable_auto_revaluation`; `lot_valuated` goes to the template (refused, not ported)
  write: async (env, ids, vals, next) => {
    // stock product.py:276-298 `_inverse_qty_available` (the field is not stored: its value is the written one)
    const hasQty = "qty_available" in vals;
    const qty = num(vals["qty_available"]);
    delete vals["qty_available"];
    dropZeroQuantity(vals);
    if ("lot_valuated" in vals) throw new NotPorted("product.product write of lot_valuated (the template's, with the lots' cost)");
    // stock product.py:697-701, before super()
    if ("active" in vals) await edit.orderpointsFollow(env, ids, vals["active"]);
    const barcodeTouched = "barcode" in vals || "company_id" in vals;
    if (!("standard_price" in vals) || env.context["disable_auto_revaluation"]) await next(env, ids, vals);
    else {
      const old = new Map<number, number | null>();
      for (const r of await env.model("product.product").read([...ids], ["standard_price"], "")) old.set(Number(r["id"]), num(r["standard_price"]));
      await next(env, ids, vals);
      await changeStandardPrice(env, old, null);
    }
    if (hasQty) await edit.inverseVariantQtyAvailable(env, ids, qty);
    // product_product.py:895-899, after the write
    if (barcodeTouched) await edit.checkVariantBarcodes(env, ids);
  },
  // product_product.py unlink (rådet runda 13, åtgärd 6): the existing variants are deleted (a variant used elsewhere
  // raises the database's error as Odoo); a variant image moved to an imageless template and the template of a last
  // variant deleted after it are not ported: refused (the latter after the delete, the request rolls back)
  unlink: async (env, ids, next) => {
    if (env.context["create_product_product"] === false) return next(env, ids);
    const rows = (await env.cr.query<{ id: number; t: number }>("SELECT id, product_tmpl_id AS t FROM product_product WHERE id = ANY($1::int[]) ORDER BY id", [[...ids]])).rows;
    if (!rows.length) return next(env, []);
    // the access error of a user who may not delete comes first, as in BaseModel.unlink (models.py:3666)
    const { checkUnlinkAccess } = await import("../orm/unlink");
    await checkUnlinkAccess(env, env.reg.model("product.product"), rows.map((r) => r.id));
    const images = (await env.cr.query(
      `SELECT 1 FROM ir_attachment a JOIN product_product p ON p.id = a.res_id
        WHERE a.res_model = 'product.product' AND a.res_field = 'image_variant_1920' AND a.res_id = ANY($1::int[])
          AND NOT EXISTS (SELECT 1 FROM ir_attachment b WHERE b.res_model = 'product.template' AND b.res_field = 'image_1920' AND b.res_id = p.product_tmpl_id) LIMIT 1`,
      [rows.map((r) => r.id)])).rows.length;
    if (images) throw new NotPorted("product.product unlink moving the variant image to its template");
    // :the template's other variants (active_test=False) besides this one; a template of only dynamic attributes stays
    const lastOf: number[] = [];
    for (const r of rows) {
      const others = (await env.cr.query("SELECT 1 FROM product_product WHERE product_tmpl_id = $1 AND id != $2 LIMIT 1", [r.t, r.id])).rows.length;
      if (others) continue;
      const dynamic = (await env.cr.query(
        `SELECT 1 FROM product_template_attribute_line l JOIN product_attribute a ON a.id = l.attribute_id
          WHERE l.product_tmpl_id = $1 AND l.active AND a.create_variant = 'dynamic' LIMIT 1`, [r.t])).rows.length;
      if (!dynamic && !lastOf.includes(r.t)) lastOf.push(r.t);
    }
    await next(env, rows.map((r) => r.id));
    if (lastOf.length) throw new NotPorted("product.product unlink of a template's last variant (the template's unlink)");
  },
});
/**
 * account product.py:295-305 create: a product without company is available everywhere, so it also gets the default
 * taxes of the companies outside the environment's (`_force_default_tax`, :271-293: their sale and purchase taxes in
 * the companies' order, linked as sudo).
 */
async function forceDefaultTaxes(env: Environment, ids: readonly number[]): Promise<void> {
  if (!ids.length) return;
  const allowed = await env.companies();
  const others = (await env.cr.query<{ sale: number | null; purchase: number | null }>(
    `SELECT c.account_sale_tax_id AS sale, c.account_purchase_tax_id AS purchase FROM res_company c
      WHERE NOT EXISTS (SELECT 1 FROM res_company a WHERE a.id = ANY($1::int[]) AND c.parent_path LIKE a.parent_path || '%')
      ORDER BY c.sequence, c.name, c.id`, [allowed])).rows;
  if (!others.length) return;
  const todo = (await env.cr.query<{ id: number }>(
    "SELECT id FROM product_template WHERE id = ANY($1::int[]) AND company_id IS NULL AND type != 'combo' ORDER BY id", [[...ids]])).rows.map((r) => r.id);
  if (!todo.length) return;
  const sale = [...new Set(others.map((r) => r.sale).filter((x): x is number => x !== null))];
  const purchase = [...new Set(others.map((r) => r.purchase).filter((x): x is number => x !== null))];
  if (sale.length) await write(env.sudo(), "product.template", todo, { taxes_id: sale.map((t) => [4, t]) });
  if (purchase.length) await write(env.sudo(), "product.template", todo, { supplier_taxes_id: purchase.map((t) => [4, t]) });
}

/**
 * stock_account product.py:191-195 create: `_change_standard_price({product: 0 for product in products if
 * product.standard_price}, valuation_date=datetime.min)` (:213-245): a storable variant not in FIFO gets its first
 * cost row (the old cost is None without a cost, so the row is always written), quantity on hand at datetime.min.
 */
async function initialCostRows(env: Environment, ids: readonly number[]): Promise<void> {
  if (!ids.length) return;
  const rows = await env.sudo().model("product.product").read([...ids], ["is_storable", "cost_method", "standard_price", "company_id", "lot_valuated"], "");
  const vals: Record<string, unknown>[] = [];
  for (const r of rows) {
    if (!r["is_storable"] || r["cost_method"] === "fifo") continue;
    if (r["lot_valuated"]) throw new NotPorted("the first cost row of a lot-valuated product (stock.lot standard_price)");
    const sp = r["standard_price"];
    const value = typeof sp === "number" ? sp : isPyFloat(sp) ? sp.float : 0;
    const old: number | null = value ? 0 : null;
    if (old === value) continue;
    const quantity = 0; // a new variant has no quants yet (qty_available at datetime.min)
    const user = (await env.cr.query<{ name: string }>("SELECT p.name FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1", [env.uid])).rows[0]?.name ?? "";
    // Python's repr of None, an int and a float (the shortest round trip, as JavaScript's, with ".0" on integers)
    const pyNum = (n: number | null, float: boolean): string => {
      if (n === null) return "None";
      if (!float) return String(n);
      if (n !== 0 && (Math.abs(n) >= 1e16 || Math.abs(n) < 1e-4)) throw new NotPorted(`repr of the float ${n}`);
      return Number.isInteger(n) ? `${n}.0` : String(n);
    };
    const companyId = Array.isArray(r["company_id"]) ? r["company_id"][0] : typeof r["company_id"] === "number" ? r["company_id"] : await env.company();
    vals.push({
      product_id: Number(r["id"]), quantity, old_cost: old ?? false, new_cost: value, old_value: (old ?? 0) * quantity, new_value: value * quantity,
      value, company_id: companyId, date: "0001-01-01 00:00:00",
      description: translate(env, "Cost update from %(old_value)s to %(new_value)s for %(quantity)s by %(user)s", "stock_account")
        .replace("%(old_value)s", () => pyNum(old, false))
        .replace("%(new_value)s", () => pyNum(value, true))
        .replace("%(quantity)s", () => pyNum(quantity, true))
        .replace("%(user)s", () => user),
    });
  }
  if (vals.length) await create(env.sudo(), "product.value", vals);
}

function pyTruthyValue(v: unknown): boolean {
  return !(v === undefined || v === null || v === false || v === 0 || v === "" || (Array.isArray(v) && v.length === 0));
}

/**
 * product_template.py:1092-1223 `_create_variant_ids` for new templates without attribute lines: the one combination
 * of no values gives one variant (`_prepare_variant_values`: the template, no values, its active flag and base unit
 * count, 0 without variants). Templates with attribute lines refuse (the combinations, exclusions and dynamic
 * attributes are not ported).
 */

/** product_template.py `_set_product_variant_field('standard_price')`; stock_account writes a valuation row for storable products. */
async function setVariantCost(env: Environment, template: number, cost: number): Promise<void> {
  const variants = await variantsOf(env, [template]);
  if (variants.length !== 1) return;
  // the cost row of a storable product comes from the variant's write (stock_account product.py:197-211)
  await write(env, "product.product", variants, { standard_price: cost });
}

/** sale_project product_template.py:91-113 `_inverse_service_policy`: the policy written as invoice policy and service type. */
function applyServicePolicy(vals: Record<string, unknown>): void {
  if (!("service_policy" in vals)) return;
  const general = ({ ordered_prepaid: ["order", "manual"], delivered_milestones: ["delivery", "milestones"], delivered_manual: ["delivery", "manual"] } as Record<string, [string, string]>)[String(vals["service_policy"])];
  if (vals["service_policy"]) Object.assign(vals, { invoice_policy: general?.[0] ?? false, service_type: general?.[1] ?? false });
  delete vals["service_policy"];
}
registerOverrides("product.template", {
  create: async (env, valsList, next) => {
    for (const vals of valsList) {
      dropZeroQuantity(vals);
      applyServicePolicy(vals);
      if (!("store_by" in vals)) continue;
      Object.assign(vals, storeByValues(vals["store_by"], vals["type"] ?? "consu"));
      delete vals["store_by"];
    }
    const costs = valsList.map((vals) => { const c = vals["standard_price"]; delete vals["standard_price"]; return Number(plainNumber(c) ?? 0); });
    const given = valsList.map((vals) => ({ ...vals }));
    const ids = await next(env, valsList);
    // product_template.py:816-834: the variants, then the values of the variant's related fields given to the template
    if (env.context["create_product_product"] ?? true) {
      await createVariantIds(env, ids);
      for (const [i, id] of ids.entries()) {
        const related: Record<string, unknown> = {};
        // `_get_related_fields_variant_template`: barcode, default_code, standard_price, volume, weight, product_properties
        // (`if vals.get(f) and not template[f]`: the new variant has none of them)
        for (const f of ["barcode", "default_code", "volume", "weight", "product_properties"]) if (pyTruthyValue(given[i]![f])) related[f] = given[i]![f];
        if (Object.keys(related).length) await write(env, "product.template", [id], related);
      }
      // :831-832
      if (given.some((vals) => "barcode" in vals || "company_id" in vals)) await checkTemplateBarcodes(env, ids);
    }
    for (const [i, id] of ids.entries()) if (costs[i]) await setVariantCost(env, id, costs[i]!);
    await forceDefaultTaxes(env, ids);
    await checkSubcontractVendors(env, ids);
    return ids;
  },
  write: async (env, ids, vals, next) => {
    await writeTemplate(env, ids, vals, next);
    await checkSubcontractVendors(env, ids);
  },
});

/**
 * product_template.py:381-393 `_check_barcode_uniqueness`, per run of templates of the same company (`groupby` of
 * the recordset): no two active templates with one barcode (:334-350, `_read_group` having count > 1), and no active
 * variant with it but the mirrored variant of a single-variant template (:352-379). A duplicate refuses: its error
 * message (`_build_duplicate_barcode_error_string` over the readable duplicates) is not ported.
 */
async function checkTemplateBarcodes(env: Environment, ids: readonly number[]): Promise<void> {
  if (env.context["skip_barcode_uniqueness_check"]) return;
  const rows = (await env.cr.query<{ id: number; barcode: string | null; company_id: number | null }>(
    "SELECT id, barcode, company_id FROM product_template WHERE id = ANY($1::int[])", [[...ids]])).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids.map((id) => byId.get(id)).filter((r): r is { id: number; barcode: string | null; company_id: number | null } => r !== undefined);
  const mirrored: number[] = [];
  for (const id of ids) {
    const variants = (await env.cr.query<{ id: number }>("SELECT id FROM product_product WHERE product_tmpl_id = $1 AND active", [id])).rows;
    if (variants.length === 1) mirrored.push(variants[0]!.id);
  }
  const su = env.sudo();
  for (let i = 0; i < ordered.length;) {
    const company = ordered[i]!.company_id;
    let j = i;
    while (j < ordered.length && ordered[j]!.company_id === company) j++;
    const barcodes = ordered.slice(i, j).map((r) => r.barcode).filter((b): b is string => Boolean(b));
    i = j;
    if (!barcodes.length) continue;
    const domain: unknown[] = [["barcode", "in", barcodes]];
    if (company) domain.push(["company_id", "in", [false, company]]);
    const templates = await su.model("product.template").search(parseDomain(domain));
    if (templates.length) {
      const counts = (await env.cr.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM product_template WHERE id = ANY($1::int[]) GROUP BY barcode HAVING count(*) > 1 LIMIT 1", [templates])).rows;
      if (counts.length) throw new NotPorted("product.template barcode already assigned to another product (duplicate barcode message)");
    }
    const variants = await su.model("product.product").search(parseDomain([...domain, ["id", "not in", mirrored]]));
    if (variants.length) throw new NotPorted("product.template barcode already assigned to a variant (duplicate barcode message)");
  }
}

/** sale_purchase product_template.py:29-49: a subcontracted service needs a vendor (after create and write). */
async function checkSubcontractVendors(env: Environment, ids: readonly number[]): Promise<void> {
  if (!ids.length) return;
  const bad = (await env.cr.query(
    `SELECT 1 FROM product_template t WHERE t.id = ANY($1::int[]) AND t.service_tracking = 'subcontract'
        AND NOT EXISTS (SELECT 1 FROM product_supplierinfo s WHERE s.product_tmpl_id = t.id) LIMIT 1`, [[...ids]])).rows.length;
  if (bad) throw new ValidationError(translate(env, "Please define the vendor from whom you would like to purchase this service automatically."));
}

type WriteNext = (env: Environment, ids: readonly number[], vals: Record<string, unknown>) => Promise<void>;
/**
 * The product.template write chain in the MRO of the installed modules (sale_project, stock_account, stock, account,
 * product; src/models/product_template_edit.ts): their steps before `super().write`, the core write with the
 * inverses (the cost, the service policy, store_by, the quantity on hand), then their steps after it.
 */
async function writeTemplate(env: Environment, ids: readonly number[], vals: Record<string, unknown>, next: WriteNext): Promise<void> {
  const barcodeTouched = "barcode" in vals || "company_id" in vals;
  // sale_project product_template.py:139-145: a product that is no service tracks nothing
  if ("type" in vals && vals["type"] !== "service") Object.assign(vals, { service_tracking: "no", project_id: false });
  // stock_account product.py:38-44: the variants whose costing method changes with the category
  const costChanged = "categ_id" in vals ? await edit.costMethodChanges(env, ids, vals["categ_id"]) : [];
  // stock product.py:1127-1131: Track Inventory turned on for a template that had it off
  let toReset: number[] = [];
  if ("is_storable" in vals) {
    const off = (await env.cr.query<{ id: number }>("SELECT id FROM product_template WHERE id = ANY($1::int[]) AND NOT COALESCE(is_storable, false) ORDER BY id", [[...ids]])).rows.map((r) => r.id);
    if (vals["is_storable"] && off.length) toReset = off;
  }
  // product_template.py:837-839: the variants' lines take the new unit (checked now, written after the template)
  const uomPlan = "uom_id" in vals ? await edit.planUomUpdate(env, ids, typeof vals["uom_id"] === "number" ? vals["uom_id"] : null) : null;
  // stock product.py:980-987 `_inverse_qty_available` (the field is not stored: its value is the written one)
  const hasQty = "qty_available" in vals;
  const qty = num(vals["qty_available"]);
  delete vals["qty_available"];
  dropZeroQuantity(vals);
  applyServicePolicy(vals);
  if ("standard_price" in vals) {
    const cost = Number(plainNumber(vals["standard_price"]) ?? 0);
    delete vals["standard_price"];
    for (const id of ids) await setVariantCost(env, id, cost);
  }
  if (!("store_by" in vals)) await next(env, ids, vals);
  else {
    const { store_by: storeBy, ...rest } = vals;
    await next(env, ids, rest);
    for (const row of await env.model("product.template").read([...ids], ["type"], "")) {
      await next(env, [Number(row["id"])], storeByValues(storeBy, row["type"]));
    }
  }
  if (hasQty) await edit.inverseTemplateQtyAvailable(env, ids, qty);
  if (uomPlan) await edit.applyUomPlan(env, uomPlan, typeof vals["uom_id"] === "number" ? vals["uom_id"] : null);
  // product_template.py:841-849: an active template without active variants gets them back; an archived one
  // archives all of its variants
  if (vals["active"] && !(await variantsOf(env, ids)).length) await createVariantIds(env, ids);
  if ("active" in vals && !vals["active"]) {
    const all = await variantsOf(env, ids, false);
    if (all.length) await write(env.withContext({ ...env.context, active_test: false }), "product.product", all, { active: false });
  }
  // product_template.py:857-858
  if (barcodeTouched) await checkTemplateBarcodes(env, ids);
  // stock product.py:1134-1136
  if (toReset.length) {
    await edit.cleanReservations(env.sudo());
    await edit.resetInventory(env, toReset);
  }
  // stock_account product.py:75-76
  await edit.updateStandardPrice(env, costChanged);
}

defineComputes("stock.picking", {
  // stock_picking.py:191-206 _compute_show_check_availability
  show_check_availability: async (env, rec) => {
    if (!["confirmed", "waiting", "assigned"].includes(String(await rec.get("state")))) return false;
    const moves = await rec.rels("move_ids");
    let open = false, reservable = false;
    const digits = (await env.cr.query<{ digits: number }>("SELECT digits FROM decimal_precision WHERE name = 'Product Unit'")).rows[0]?.digits ?? 2;
    for (const m of moves) {
      const qty = Number((await m.get("product_uom_qty")) ?? 0);
      if (!((await m.get("picked")) || qty === Number((await m.get("quantity")) ?? 0))) open = true;
      if (["waiting", "confirmed", "partially_available"].includes(String(await m.get("state"))) && floatRound(qty, digits) !== 0) reservable = true;
    }
    return open && reservable;
  },
  // :208-213 _compute_show_allocation
  // with :594-614 `_get_show_allocation`: other open moves of the warehouse waiting for the same products
  show_allocation: async (env, rec) => {
    const type = await rec.rel("picking_type_id");
    if (!type || !(await type.get("auto_show_allocation_report"))) return false;
    if ((await type.get("code")) === "outgoing") return false;
    // `self.move_ids.filtered(...)`: on a new transfer (onchange) the moves of the form, new ones among them
    const lines: { id: number | null; product_id: number | null }[] = [];
    if (rec.id !== null) {
      lines.push(...(await env.cr.query<{ id: number; product_id: number }>(
        `SELECT m.id, m.product_id FROM stock_move m JOIN product_product p ON p.id = m.product_id JOIN product_template t ON t.id = p.product_tmpl_id
          WHERE m.picking_id = $1 AND COALESCE(t.is_storable, false) AND m.state != 'cancel'`, [rec.id])).rows);
    } else {
      for (const m of await rec.rels("move_ids")) {
        const product = await m.rel("product_id");
        if (!product || !(await product.get("is_storable")) || (await m.get("state")) === "cancel") continue;
        lines.push({ id: m.origin, product_id: product.origin });
      }
    }
    if (!lines.length) return false;
    // `self.ids` and `lines.ids` are origin ids: a new transfer has none, so 'picking_id not in []' holds for every
    // move and 'move_orig_ids in []' for none
    const states = ["confirmed", "partially_available", "waiting"];
    if ((await rec.get("state")) === "done") states.push("assigned");
    const warehouse = await type.rel("warehouse_id");
    const view = warehouse ? idOf(await warehouse.get("view_location_id")) : null;
    const hit = (await env.cr.query(
      `SELECT 1 FROM stock_move m JOIN stock_location l ON l.id = m.location_id
        WHERE m.state = ANY($1::text[]) AND m.product_qty > 0 AND l.usage != 'supplier'
          AND l.parent_path LIKE (SELECT parent_path FROM stock_location WHERE id = $2) || '%'
          AND (m.picking_id IS NULL OR NOT m.picking_id = ANY($3::int[])) AND m.product_id = ANY($4::int[])
          AND (NOT EXISTS (SELECT 1 FROM stock_move_move_rel r WHERE r.move_dest_id = m.id)
               OR EXISTS (SELECT 1 FROM stock_move_move_rel r WHERE r.move_dest_id = m.id AND r.move_orig_id = ANY($5::int[]))) LIMIT 1`,
      [states, view, rec.origin === null ? [] : [rec.origin], lines.map((l) => l.product_id).filter((id): id is number => id !== null),
        lines.map((l) => l.id).filter((id): id is number => id !== null)])).rows.length;
    return hit > 0;
  },
  // stock_picking.py:552-558 `_compute_show_next_pickings` over `_get_next_transfers`: the transfers of the moves'
  // destination moves, less the picking's own returns
  show_next_pickings: async (env, rec) => {
    const dests = new Set<number>();
    for (const m of await rec.rels("move_ids")) for (const d of ((await m.get("move_dest_ids")) as unknown[] | null) ?? []) { const id = idOf(d); if (id !== null) dests.add(id); }
    if (!dests.size) return false;
    const pickings = (await env.cr.query<{ p: number }>("SELECT DISTINCT picking_id AS p FROM stock_move WHERE id = ANY($1::int[]) AND picking_id IS NOT NULL", [[...dests]])).rows.map((r) => r.p);
    if (!pickings.length) return false;
    const returns = new Set(((await rec.get("return_ids")) as unknown[] | null ?? []).map(idOf));
    return pickings.some((p) => !returns.has(p));
  },
  // _compute_validate_button_style
  validate_button_style: async (_env, rec) => {
    const state = String(await rec.get("state"));
    return state === "done" || state === "cancel" ? "invisible" : state === "waiting" || state === "assigned" ? "primary" : "secondary";
  },
});

/** stock_move.py:786-802 _compute_show_info. */
async function moveInfo(rec: Rec): Promise<{ quant: boolean; text: boolean; m2o: boolean }> {
  const product = await rec.rel("product_id");
  const type = await rec.rel("picking_type_id");
  const tracked = product ? ["lot", "serial"].includes(String(await product.get("tracking"))) : false;
  const create = type ? Boolean(await type.get("use_create_lots")) : false, existing = type ? Boolean(await type.get("use_existing_lots")) : false;
  const returned = Boolean(await rec.get("origin_returned_move_id")), state = await rec.get("state");
  const quant = (await rec.get("picking_code")) !== "incoming" && Boolean(product && (await product.get("is_storable"))) && !(tracked && create && !existing);
  const text = tracked && create && !existing && state !== "done" && !returned;
  return { quant, text, m2o: !quant && !text && tracked && (existing || state === "done" || returned) };
}
defineComputes("stock.move", {
  show_quant: async (_env, rec) => (await moveInfo(rec)).quant,
  show_lots_text: async (_env, rec) => (await moveInfo(rec)).text,
  show_lots_m2o: async (_env, rec) => (await moveInfo(rec)).m2o,
  // stock_move.py:345-371 _compute_show_details_visible
  show_details_visible: async (env, rec) => {
    const product = await rec.rel("product_id");
    const type = await rec.rel("picking_type_id");
    if (!product || (await rec.get("state")) === "draft") return false;
    const lots = type ? Boolean((await type.get("use_create_lots")) || (await type.get("use_existing_lots"))) : false;
    const multi = await hasGroup(env, "stock.group_stock_multi_locations");
    if (!lots && !multi) return false;
    if ((await rec.rels("move_line_ids")).length > 1) return true;
    return multi || (await hasGroup(env, "stock.group_tracking_lot")) || (await hasGroup(env, "stock.group_tracking_owner"))
      || ["lot", "serial"].includes(String(await product.get("tracking")));
  },
  // :778 _compute_is_initial_demand_editable
  is_initial_demand_editable: async (_env, rec) => {
    const picking = await rec.rel("picking_id");
    return !(picking && (await picking.get("is_locked"))) || (await rec.get("state")) === "draft";
  },
  is_quantity_done_editable: async (_env, rec) => Boolean(await rec.get("product_id")),
  // _compute_display_assign_serial
  display_import_lot: async (_env, rec) => {
    const product = await rec.rel("product_id");
    const type = await rec.rel("picking_type_id");
    return Boolean(product && ["lot", "serial"].includes(String(await product.get("tracking"))) && type && (await type.get("use_create_lots"))
      && !(await rec.get("origin_returned_move_id")) && !["done", "cancel"].includes(String(await rec.get("state"))));
  },
  // _compute_has_lines_without_result_package
  has_lines_without_result_package: async (_env, rec) => {
    let some = false, without = false;
    for (const line of await rec.rels("move_line_ids")) { if (await line.get("result_package_id")) some = true; else without = true; }
    return some && without;
  },
});

defineComputes("stock.move", {
  // stock_move.py:400-402, :330-336
  move_lines_count: async (_env, rec) => (await rec.rels("move_line_ids")).length,
  is_locked: async (_env, rec) => {
    const picking = await rec.rel("picking_id");
    return picking ? Boolean(await picking.get("is_locked")) : false;
  },
  // _compute_description_picking with product.py:334-347, purchase_stock stock_move.py:48-74 and sale_stock stock.py:82-92
  description_picking: async (env, rec) => {
    // a description written in this request stays in the cache (stock_move.py:848-850 the inverse runs protected):
    // src/models/stock_new.ts keeps it in the write overlay
    const written = rec instanceof DbRec ? overlayOf(env, "stock.move", "description_picking") : undefined;
    if (written?.has(rec.origin as number)) return written.get(rec.origin as number) ?? false;
    const manual = await rec.get("description_picking_manual");
    if (manual) return manual;
    const moveProduct = await rec.rel("product_id");
    if (!moveProduct) return "";
    // stock_move.py:839 `product.with_context(lang=move._get_lang())`, :2561-2563: the picking's partner's language,
    // else the move's partner's, else the user's
    const picking = await rec.rel("picking_id");
    const pickingPartner = picking ? await picking.rel("partner_id") : null;
    const movePartner = await rec.rel("partner_id");
    let lang = (pickingPartner ? await pickingPartner.get("lang") : null) || (movePartner ? await movePartner.get("lang") : null) || null;
    if (!lang) {
      lang = (await env.cr.query<{ lang: string | null }>("SELECT p.lang FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1", [env.uid])).rows[0]?.lang ?? null;
    }
    const prodLang = typeof lang === "string" && lang ? lang : "en_US";
    // the registry's translated labels of the move's language (an active language; else checkLang refuses)
    if (prodLang !== (env.lang ?? "en_US")) await ensureRegistryLang(env.cr, env.reg, prodLang);
    const langEnv = env.withContext({ ...env.context, lang: prodLang });
    if (moveProduct.origin === null) throw new NotPorted("stock.move.description_picking of a new product");
    const product = prodLang === (env.lang ?? "en_US") ? moveProduct : new DbRec(langEnv, env.reg.model("product.product"), moveProduct.origin);
    const type = await rec.rel("picking_type_id");
    const field = ({ incoming: "description_pickingin", outgoing: "description_pickingout", internal: "description_picking" } as Record<string, string>)[String(type ? await type.get("code") : "")];
    const own = field ? await product.get(field) : null;
    const purchaseLine = await rec.rel("purchase_line_id");
    const saleLine = await rec.rel("sale_line_id");
    // `_get_description`: the purchase line's name (purchase_stock :73-74), else the product's display name
    let description = String(own || (purchaseLine ? (await purchaseLine.get("name")) || "" : (await langEnv.sudo().model("product.product").displayName([product.origin!])).get(product.origin!) ?? "") || "");
    if (own === false || own === null) description = description || "";
    if (purchaseLine) {
      const seller = await purchaseLine.rel("selected_seller_id");
      let vendor = seller && (await seller.get("product_code")) ? `[${String(await seller.get("product_code"))}]` : "";
      if (seller && (await seller.get("product_name"))) vendor += ` ${String(await seller.get("product_name"))}`;
      if (description && description.includes(vendor.trim())) vendor = "";
      if (own && ((await purchaseLine.get("product_no_variant_attribute_value_ids")) as unknown[] | null)?.length) throw new NotPorted("stock.move.description_picking with no-variant attributes");
      description = [vendor, description].filter((x) => x).join("\n").trim();
    }
    if (saleLine) {
      const custom = ((await saleLine.get("product_custom_attribute_value_ids")) as unknown[] | null)?.length;
      const noVariant = ((await saleLine.get("product_no_variant_attribute_value_ids")) as unknown[] | null)?.length;
      if (custom || noVariant) throw new NotPorted("stock.move.description_picking of a sale line with custom or no-variant attributes");
      description = description.trim();
    }
    return description;
  },
});

registerOverrides("product.template", {
  constraints: [{
    // product_template.py:701-705 _check_combo_ids_not_empty
    fields: ["type", "combo_ids"],
    fn: async (env, ids) => {
      for (const r of await env.sudo().model("product.template").read([...ids], ["type", "combo_ids"])) {
        if (r["type"] === "combo" && !(Array.isArray(r["combo_ids"]) && r["combo_ids"].length)) {
          throw new ValidationError(translate(env, "A combo product must contain at least 1 combo choice."));
        }
      }
    },
  }],
});

// stock_quant.py:117-119 user_id's domain lambda: users of stock.group_stock_user
registerHooks("stock.quant", {
  descriptionDomain: {
    user_id: async (env) => {
      const group = (await env.cr.query<{ res_id: number }>("SELECT res_id FROM ir_model_data WHERE module = 'stock' AND name = 'group_stock_user'")).rows[0];
      if (!group) throw new NotPorted("stock.group_stock_user missing");
      return [["all_group_ids", "in", group.res_id]];
    },
  },
});

/** stock_quant.py:230-235 `_compute_is_outdated`: a counted quant whose quantity moved since the count. */
export async function quantIsOutdated(env: Environment, rec: Rec): Promise<boolean> {
  if (!(await rec.get("product_id")) || !(await rec.get("inventory_quantity_set"))) return false;
  const counted = Number((await rec.get("inventory_quantity")) ?? 0) - Number((await rec.get("inventory_diff_quantity")) ?? 0);
  const { uomCompare } = await import("./stock_engine");
  return (await uomCompare(env, counted, Number((await rec.get("quantity")) ?? 0))) !== 0;
}

defineComputes("stock.quant", {
  is_outdated: quantIsOutdated,
  // stock_quant.py:249-256 `_compute_sn_duplicated`: a serial number in stock (internal or transit) more than once
  sn_duplicated: async (env, rec) => {
    const lot = await rec.get("lot_id");
    const lotId = typeof lot === "number" ? lot : Array.isArray(lot) && typeof lot[0] === "number" ? lot[0] : null;
    if (lotId === null) return false;
    return (await env.cr.query(
      `SELECT 1 FROM stock_quant q JOIN product_product p ON p.id = q.product_id JOIN product_template t ON t.id = p.product_tmpl_id
         JOIN stock_location l ON l.id = q.location_id
        WHERE t.tracking = 'serial' AND q.lot_id = $1 AND q.quantity > 0 AND l.usage IN ('internal', 'transit') HAVING count(*) > 1`, [lotId])).rows.length > 0;
  },
});

/**
 * stock_quant.py:133-179 `_compute_last_count_date` of a recordset: one `_read_group` of the done inventory move lines
 * of all the quants' products, lots, owners, locations and packages, the latest date per (location, package, product,
 * lot, owner) from either end and either package of a line; the datetime's (UTC) day in the Date field.
 */
async function quantsLastCountDate(env: Environment, ids: readonly number[]): Promise<Map<number, unknown>> {
  const def = env.reg.model("stock.quant");
  const idOf = (v: unknown): number | null => (typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : null);
  const cols = ["product_id", "location_id", "lot_id", "owner_id", "package_id"] as const;
  const values = new Map<string, Map<number, unknown>>();
  for (const f of cols) values.set(f, await readFieldBatch(env, def, ids, f));
  const of = (f: typeof cols[number], id: number): number | null => idOf(values.get(f)!.get(id));
  const out = new Map<number, unknown>(ids.map((id) => [id, false]));
  const set = (f: typeof cols[number]): number[] => [...new Set(ids.map((id) => of(f, id)).filter((v): v is number => v !== null))];
  const products = set("product_id");
  if (!products.length) return out;
  const rows = (await env.cr.query<{ product_id: number; lot_id: number | null; package_id: number | null; owner_id: number | null; result_package_id: number | null; location_id: number; location_dest_id: number; d: string }>(
    `SELECT l.product_id, l.lot_id, l.package_id, l.owner_id, l.result_package_id, l.location_id, l.location_dest_id, max(l.date)::date::text AS d
       FROM stock_move_line l JOIN stock_move m ON m.id = l.move_id
      WHERE l.state = 'done' AND m.is_inventory AND l.product_id = ANY($1::int[])
        AND (l.lot_id = ANY($2::int[]) OR l.lot_id IS NULL) AND (l.owner_id = ANY($3::int[]) OR l.owner_id IS NULL)
        AND (l.location_id = ANY($4::int[]) OR l.location_dest_id = ANY($4::int[]))
        AND (l.package_id IS NULL OR l.package_id = ANY($5::int[]) OR l.result_package_id = ANY($5::int[]))
      GROUP BY l.product_id, l.lot_id, l.package_id, l.owner_id, l.result_package_id, l.location_id, l.location_dest_id`,
    [products, set("lot_id"), set("owner_id"), set("location_id"), set("package_id")])).rows;
  const latest = new Map<string, string>();
  const update = (loc: number | null, pkg: number | null, r: { product_id: number; lot_id: number | null; owner_id: number | null; d: string }): void => {
    const key = `${loc}|${pkg}|${r.product_id}|${r.lot_id}|${r.owner_id}`;
    const cur = latest.get(key);
    if (!cur || r.d > cur) latest.set(key, r.d);
  };
  for (const r of rows) {
    update(r.location_id, r.package_id, r);
    update(r.location_dest_id, r.package_id, r);
    update(r.location_id, r.result_package_id, r);
    update(r.location_dest_id, r.result_package_id, r);
  }
  for (const id of ids) {
    const d = latest.get(`${of("location_id", id)}|${of("package_id", id)}|${of("product_id", id)}|${of("lot_id", id)}|${of("owner_id", id)}`);
    if (d !== undefined) out.set(id, d);
  }
  return out;
}
registerRecordCompute("stock.quant", {
  // stock_quant.py:133-179 `_compute_last_count_date`: the latest done inventory move line of the quant's product,
  // lot and owner from or to its location, in or out of its package; the datetime's (UTC) day in the Date field
  last_count_date: async (env, rec) => {
    const id = (v: unknown): number | null => (typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : null);
    const [product, location, lot, owner, pkg] = await Promise.all(["product_id", "location_id", "lot_id", "owner_id", "package_id"].map(async (f) => id(await rec.get(f))));
    if (product === null || location === null) return false;
    const r = (await env.cr.query<{ d: string | null }>(
      `SELECT max(l.date)::date::text AS d FROM stock_move_line l JOIN stock_move m ON m.id = l.move_id
        WHERE l.state = 'done' AND m.is_inventory AND l.product_id = $1 AND l.lot_id IS NOT DISTINCT FROM $3::int AND l.owner_id IS NOT DISTINCT FROM $4::int
          AND (l.location_id = $2 OR l.location_dest_id = $2)
          AND (l.package_id IS NOT DISTINCT FROM $5::int OR l.result_package_id IS NOT DISTINCT FROM $5::int)
          AND (l.package_id IS NULL OR l.package_id = $5::int OR l.result_package_id = $5::int)`, [product, location, lot, owner, pkg])).rows[0];
    return r?.d ?? false;
  },
});
registerHooks("stock.quant", { computed: { last_count_date: quantsLastCountDate } });

// stock_quant.py:237-242 `_search_is_outdated`: only `in`
registerHooks("stock.quant", {
  search: {
    is_outdated: async (env, op, value) => {
      if (op !== "in") throw new NotPorted(`stock.quant.is_outdated ${op}`);
      void value; // Odoo returns the outdated quants whatever the value
      const ids = await env.model("stock.quant").search(cond("inventory_quantity_set", "=", true));
      const out: number[] = [];
      for (const id of ids) if (await quantIsOutdated(env, new DbRec(env, env.reg.model("stock.quant"), id))) out.push(id);
      return cond("id", "in", out);
    },
  },
});
