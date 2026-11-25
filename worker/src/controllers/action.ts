/** web/controllers/action.py:24-49; base/models/ir_actions.py:217-377, 1463-1498. */
import { AccessError, HttpError, NotPorted, OdooError } from "../errors";
import type { RequestContext } from "../http/context";
import { jsonRoute } from "../http/router";
import { evalExpr } from "../pyexpr";
import * as D from "../orm/domain";
import type { Environment } from "../orm/types";
import { userGroupIds } from "../session/user";
import { translated } from "./webclient";
import { getEmptyListHelp } from "../web/empty_list_help";

const BASE = ["id", "name", "type", "path", "help", "binding_model_id", "binding_type", "binding_view_types"];
const WINDOW = ["view_id", "domain", "context", "res_id", "res_model", "target", "view_mode", "mobile_view_mode", "limit", "search_view_id", "filter", "cache"];
const CLIENT = ["tag", "target", "res_model", "context"];
/** ir_actions_report.py:118-127 `_get_readable_fields` among the fields read() returns (context/data/target are not fields). */
const REPORT = ["report_name", "report_type", "domain"];

/**
 * The action dict of `ref` (an id, xmlid or path) as `/web/action/load` returns it; also `_for_xml_id` /
 * `_get_action_dict` (ir_actions.py:206-226) for model methods returning actions (src/models/partner_erp.ts).
 */
export async function loadAction(ctx: Pick<RequestContext, "cursor" | "context" | "uid">, ref: unknown, env?: Environment): Promise<Record<string, unknown>> {
  return load(ctx, ref, env);
}

/**
 * The python methods of the installed embedded actions (ir_embedded_actions.py:87 `hasattr(env[parent_res_model],
 * python_method)`), each defined by the module whose data creates the embedded action (checked in the sources).
 */
const EMBEDDED_METHODS: Readonly<Record<string, readonly string[]>> = {
  "project.project": ["action_get_list_view", "action_view_sos", "action_view_sols", "action_open_project_invoices",
    "action_open_project_purchase_orders", "action_open_project_vendor_bills", "action_open_deliveries", "action_open_receipts",
    "action_open_all_pickings", "action_project_task_burndown_chart_report", "action_open_analytic_items", "action_open_project_form",
    "action_project_time_by_stage_report", "action_real_margin", "action_estimated_margin"],
};

/**
 * ir_actions.py:320-323 `_compute_embedded_actions` (search on parent_action_id, `is_visible`,
 * ir_embedded_actions.py:77-96) and :368-377 `_get_action_dict`: the visible ones read with `_get_readable_fields`
 * (:105-111) in `_order` 'sequence, id'.
 */
async function embeddedActions(env: Environment, actionId: number, lang: string): Promise<Record<string, unknown>[]> {
  const ids = await env.model("ir.embedded.actions").search(D.cond("parent_action_id", "in", [actionId]), { order: "sequence, id" });
  const activeId = env.context["active_id"];
  if (!ids.length || !activeId) return [];
  if (typeof activeId !== "number") throw new NotPorted("embedded actions with a non-integer active_id");
  const rows = (await env.cr.query<{ id: number; name: unknown; parent_action_id: number; parent_res_id: number | null; parent_res_model: string;
    action_id: number | null; python_method: string | null; user_id: number | null; default_view_mode: string | null; domain: string | null; context: string | null }>(
    `SELECT id, name, parent_action_id, parent_res_id, parent_res_model, action_id, python_method, user_id, default_view_mode, domain, context
       FROM ir_embedded_actions WHERE id = ANY($1::int[])`, [ids])).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const userGroups = new Set((await env.cr.query<{ id: number }>(
    `WITH RECURSIVE g(id) AS (SELECT gid FROM res_groups_users_rel WHERE uid = $1 UNION SELECT r.hid FROM res_groups_implied_rel r JOIN g ON r.gid = g.id)
     SELECT id FROM g`, [env.uid])).rows.map((r) => r.id));
  const out: Record<string, unknown>[] = [];
  for (const eid of ids) {
    const r = byId.get(eid)!;
    if (r.python_method && !(EMBEDDED_METHODS[r.parent_res_model] ?? []).includes(r.python_method)) {
      throw new NotPorted(`embedded action method ${r.parent_res_model}.${r.python_method}`);
    }
    const groups = (await env.cr.query<{ id: number }>(
      `SELECT g.id FROM ir_embedded_actions_res_groups_rel r JOIN res_groups g ON g.id = r.res_groups_id
         LEFT JOIN res_groups_privilege p ON p.id = g.privilege_id
        WHERE r.ir_embedded_actions_id = $1
        ORDER BY p.sequence, COALESCE(p.name->>$2, p.name->>'en_US'), p.id, g.sequence, COALESCE(g.name->>$2, g.name->>'en_US'), g.id`, [eid, lang])).rows.map((g) => g.id);
    if (groups.length && !groups.some((g) => userGroups.has(g))) continue;
    if (!(r.parent_res_id === null || r.parent_res_id === 0 || r.parent_res_id === activeId) || !(r.user_id === null || r.user_id === env.uid)) continue;
    // `env[parent_res_model].search([('id', '=', active_id)]).filtered_domain(literal_eval(domain))`
    const domain = evalExpr(r.domain || "[]", new Map());
    if (!Array.isArray(domain)) throw new NotPorted("embedded action domain that is not a list");
    const parsed = D.parseDomain(domain);
    const hit = await env.model(r.parent_res_model).search(D.and([D.cond("id", "=", activeId), parsed]));
    if (!hit.length) continue;
    const filters = (await env.cr.query("SELECT 1 FROM ir_filters WHERE embedded_action_id = $1 LIMIT 1", [eid])).rows.length;
    if (filters) throw new NotPorted("embedded action filter_ids (ir.filters order)");
    const xmlids = (await env.cr.query<{ m: string }>("SELECT module AS m FROM ir_model_data WHERE model = 'ir.embedded.actions' AND res_id = $1", [eid])).rows;
    const parentName = (await env.cr.query<{ name: unknown }>("SELECT name FROM ir_actions WHERE id = $1", [r.parent_action_id])).rows[0]?.name;
    const actionName = r.action_id ? (await env.cr.query<{ name: unknown }>("SELECT name FROM ir_actions WHERE id = $1", [r.action_id])).rows[0]?.name : null;
    const userName = r.user_id ? (await env.model("res.users").displayName([r.user_id])).get(r.user_id) ?? "" : null;
    out.push({
      id: eid, python_method: r.python_method || false, filter_ids: [], parent_res_model: r.parent_res_model, domain: r.domain ?? false,
      default_view_mode: r.default_view_mode || false, groups_ids: groups, parent_res_id: r.parent_res_id ?? 0, name: translated(r.name, lang),
      user_id: r.user_id ? [r.user_id, userName] : false, action_id: r.action_id ? [r.action_id, translated(actionName, lang)] : false,
      parent_action_id: [r.parent_action_id, translated(parentName, lang)],
      // :67-73 `_compute_is_deletable`: every external id is __export__/__custom__ (none: deletable)
      is_deletable: xmlids.every((x) => x.m === "__export__" || x.m === "__custom__"),
      context: r.context ?? false,
    });
  }
  return out;
}

async function assertActionGroupAccess(env: Environment | undefined, groupIds: readonly number[]): Promise<void> {
  if (!env || env.su || groupIds.length === 0) return;
  const userGroups = await userGroupIds(env.cr, env.uid);
  if (!groupIds.some((gid) => userGroups.has(gid))) {
    throw new AccessError("You are not allowed to access this action.");
  }
}

async function load(ctx: Pick<RequestContext, "cursor" | "context" | "uid">, ref: unknown, env?: Environment): Promise<Record<string, unknown>> {
  const cr = ctx.cursor();
  let id = typeof ref === "number" && Number.isInteger(ref) ? ref : typeof ref === "string" && /^\d+$/.test(ref) ? Number(ref) : null;
  if (id === null && typeof ref === "string") {
    if (ref.includes(".")) {
      const [module, name] = ref.split(".");
      id = (await cr.query<{res_id:number}>("SELECT res_id FROM ir_model_data WHERE module=$1 AND name=$2 AND model LIKE 'ir.actions.%'",[module,name])).rows[0]?.res_id ?? null;
    } else id = (await cr.query<{id:number}>("SELECT id FROM ir_actions WHERE path=$1 ORDER BY id LIMIT 1",[ref])).rows[0]?.id ?? null;
  }
  const type = id === null ? null : (await cr.query<{type:string}>("SELECT type FROM ir_actions WHERE id=$1",[id])).rows[0]?.type;
  if (!type) throw new OdooError("odoo.addons.web.controllers.action.MissingActionError",`The action “${String(ref)}” does not exist`);
  const table = type === "ir.actions.act_window" ? "ir_act_window" : type === "ir.actions.client" ? "ir_act_client"
    : type === "ir.actions.report" ? "ir_act_report_xml" : type === "ir.actions.server" ? "ir_act_server" : null;
  if (!table) throw new NotPorted(`action/load ${type}`);
  const row = (await cr.query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id=$1`,[id])).rows[0]!;
  const result: Record<string, unknown> = {};
  for (const f of [...BASE, ...(type === "ir.actions.act_window" ? WINDOW : type === "ir.actions.report" ? REPORT : type === "ir.actions.server" ? [] : CLIENT)]) result[f] = row[f] ?? false;
  const lang = typeof ctx.context.lang === "string" ? ctx.context.lang : "en_US";
  result["name"] = translated(row["name"],lang);
  result["display_name"] = result["name"];
  result["help"] = translated(row["help"],lang);
  result["xml_id"] = (await cr.query<{xmlid:string}>("SELECT module||'.'||name AS xmlid FROM ir_model_data WHERE model=$1 AND res_id=$2 ORDER BY id LIMIT 1",[type,id])).rows[0]?.xmlid ?? false;
  if (row["binding_model_id"]) {
    const m=(await cr.query<{name:unknown}>("SELECT name FROM ir_model WHERE id=$1",[row["binding_model_id"]])).rows[0];
    result["binding_model_id"]=[row["binding_model_id"],translated(m?.name,lang)];
  }
  if (type === "ir.actions.report") {
    // action.py:47-49: read() then clean_action; nothing else to add
  } else if (type === "ir.actions.server") {
    // ir_actions.py:1463-1498 `_get_readable_fields`: group_ids, model_name
    const groupIds = (await cr.query<{ gid: number }>("SELECT gid FROM ir_act_server_group_rel WHERE act_id = $1 ORDER BY gid", [id])).rows.map((r) => r.gid);
    await assertActionGroupAccess(env, groupIds);
    result["model_name"] = (await cr.query<{ model: string }>("SELECT model FROM ir_model WHERE id = $1", [row["model_id"]])).rows[0]?.model ?? false;
    result["group_ids"] = groupIds;
  } else if (type === "ir.actions.client") {
    result["params"] = typeof row["params_store"] === "string" && row["params_store"] ? evalExpr(row["params_store"],new Map([["uid",ctx.uid]])) : false;
  } else {
    const groupIds = (await cr.query<{ gid: number }>("SELECT gid FROM ir_act_window_group_rel WHERE act_id = $1 ORDER BY gid", [id])).rows.map((r) => r.gid);
    await assertActionGroupAccess(env, groupIds);
    const views: unknown[][] = (await cr.query<{view_id:number|null; view_mode:string}>("SELECT view_id,view_mode FROM ir_act_window_view WHERE act_window_id=$1 ORDER BY sequence,id",[id])).rows.map(v=>[v.view_id??false,v.view_mode]);
    const modes = String(row["view_mode"]).split(",").filter(mode=>!views.some(v=>v[1]===mode));
    for (const field of ["view_id","search_view_id"]) {
      if (!row[field]) continue;
      const view=(await cr.query<{name:string; type:string}>("SELECT name,type FROM ir_ui_view WHERE id=$1",[row[field]])).rows[0];
      result[field]=view ? [row[field],view.name] : false;
      if (field === "view_id" && view && modes.includes(view.type)) { modes.splice(modes.indexOf(view.type),1);views.push([Number(row[field]),view.type]); }
    }
    views.push(...modes.map(mode=>[false,mode]));result["views"]=views;
    result["res_id"]=row["res_id"] ?? 0;
    result["group_ids"]=groupIds;
    const embedded=await cr.query<{id:number}>("SELECT id FROM ir_embedded_actions WHERE parent_action_id=$1",[id]);
    if (embedded.rows.length && !env) throw new NotPorted("embedded action visibility and serialization");
    result["embedded_action_ids"]=embedded.rows.length && env ? await embeddedActions(env, id!, lang) : [];
    // ir_actions.py:325-339 read(): help = env[res_model].with_context(**safe_eval(context, env.context)).get_empty_list_help(help)
    const resModel = typeof row["res_model"] === "string" ? row["res_model"] : null;
    if (resModel !== null && (await cr.query("SELECT 1 FROM ir_model WHERE model = $1", [resModel])).rows.length > 0) {
      let actionCtx: Record<string, unknown> = {};
      try {
        const v = evalExpr(typeof row["context"] === "string" ? row["context"] : "{}", new Map(Object.entries(ctx.context)));
        if (v instanceof Map) actionCtx = Object.fromEntries([...v].map(([k, x]) => [String(k), x]));
        else if (typeof v === "object" && v !== null && !Array.isArray(v)) actionCtx = v as Record<string, unknown>;
      } catch (e) {
        if (e instanceof NotPorted) throw e;
        actionCtx = {}; // ir_actions.py:336-337: except Exception -> {}
      }
      const allowed = ctx.context["allowed_company_ids"];
      const companyId = Array.isArray(allowed) && typeof allowed[0] === "number" ? allowed[0]
        : (await cr.query<{ company_id: number }>("SELECT company_id FROM res_users WHERE id = $1", [ctx.uid ?? 1])).rows[0]?.company_id ?? 1;
      const helpValue = result["help"];
      result["help"] = await getEmptyListHelp({ cr, uid: ctx.uid ?? 1, context: { ...ctx.context, ...actionCtx }, companyId, lang },
        resModel, typeof helpValue === "string" ? helpValue : false);
    }
  }
  return result;
}

jsonRoute("/web/action/load",async ctx=>{
  const p=ctx.jsonParams??{};
  if (p["context"] && typeof p["context"]==="object" && !Array.isArray(p["context"])) ctx.updateContext(p["context"] as Record<string,unknown>);
  return load(ctx,p["action_id"],await ctx.orm());
});

/** web/controllers/action.py:59-113 `load_breadcrumbs`: the display names of the breadcrumbs of a reloaded URL. */
jsonRoute("/web/action/load_breadcrumbs", async (ctx) => {
  const p = ctx.jsonParams ?? {};
  const actions = Array.isArray(p["actions"]) ? p["actions"] as unknown[] : null;
  if (actions === null) throw new OdooError("builtins.TypeError", "ActionController.load_breadcrumbs() missing 1 required positional argument: 'actions'");
  const env = await ctx.orm();
  const caught = new Set(["odoo.addons.web.controllers.action.MissingActionError", "odoo.exceptions.MissingError", "odoo.exceptions.AccessError"]);
  const recordName = async (model: string, id: unknown): Promise<unknown> => {
    if (typeof id !== "number") throw new NotPorted(`load_breadcrumbs resId ${JSON.stringify(id)}`);
    // `record.read(['display_name'])`: access, then existence (models.py `_fetch_query`: MissingError)
    await env.model(model).read([id], ["display_name"]);
    const def = env.reg.model(model);
    if (def.table && !(await env.cr.query(`SELECT 1 FROM "${def.table}" WHERE id = $1`, [id])).rows.length) {
      const { MissingError } = await import("../errors");
      throw new MissingError(`Record does not exist or has been deleted.\n(Record: ${model}(${id},), User: ${env.uid})`);
    }
    return (await env.model(model).displayName([id])).get(id) ?? false;
  };
  const { translate } = await import("../models/util");
  const results: Record<string, unknown>[] = [];
  for (let idx = 0; idx < actions.length; idx++) {
    const rawAction = actions[idx];
    if (!rawAction || typeof rawAction !== "object" || Array.isArray(rawAction)) {
      throw new HttpError(400, "Invalid action");
    }
    const action = rawAction as Record<string, unknown>;
    const recordId = action["resId"];
    try {
      if (action["action"]) {
        const act = await load(ctx, action["action"], env);
        if (act["type"] === "ir.actions.server") throw new NotPorted("load_breadcrumbs of a server action (run)");
        if (!act["display_name"]) act["display_name"] = act["name"];
        // client actions have no multi-record views: the next controller of the same action cannot be restored
        const nextRaw = idx + 1 < actions.length ? actions[idx + 1] : null;
        const nextAction = nextRaw && typeof nextRaw === "object" && !Array.isArray(nextRaw) ? (nextRaw as Record<string, unknown>) : null;
        if (act["type"] === "ir.actions.client" && nextAction !== null && action["action"] === nextAction["action"]) {
          results.push({ error: "Client actions don't have multi-record views" });
          continue;
        }
        if (recordId) {
          if (recordId === "new") results.push({ display_name: translate(env, "New", "web") });
          else if (act["res_model"]) results.push({ display_name: await recordName(String(act["res_model"]), recordId) });
          else results.push({ display_name: act["display_name"] });
        } else if (act["res_model"] && act["type"] !== "ir.actions.client") {
          const { checkModelAccess } = await import("../orm/access");
          await checkModelAccess(env, env.reg.model(String(act["res_model"])), "read");
          const views = Array.isArray(act["views"]) ? act["views"] as unknown[][] : [];
          results.push({ display_name: views.some((v) => v[1] !== "form" && v[1] !== "search") ? act["display_name"] : null });
        } else {
          results.push({ display_name: act["display_name"] });
        }
      } else if (action["model"]) {
        const model = String(action["model"]);
        if (!env.reg.models.has(model)) throw new NotPorted(`load_breadcrumbs of an unknown model ${model} (KeyError)`);
        if (!recordId) throw new NotPorted("load_breadcrumbs: a model without resId (BadRequest)");
        results.push({ display_name: recordId === "new" ? translate(env, "New", "web") : await recordName(model, recordId) });
      } else {
        throw new NotPorted("load_breadcrumbs: neither an action nor a model (BadRequest)");
      }
    } catch (e) {
      if (e instanceof OdooError && caught.has(e.odooName)) { results.push({ error: e.message }); continue; }
      throw e;
    }
  }
  return results;
});
