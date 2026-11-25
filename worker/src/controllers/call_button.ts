/**
 * `/web/dataset/call_button` (`odoo/addons/web/controllers/dataset.py:34-41`): `call_kw` of a button method (the
 * methods registered with `registerMethod`, src/http/methods.ts), then `clean_action`
 * (`odoo/addons/web/controllers/utils.py:40-64`, `generate_views` :122-157) on a dict result; anything else is
 * `False`.
 */
import { HttpError, NotPorted, OdooError } from "../errors";
import { callKw } from "../http/methods";
import { jsonRoute } from "../http/router";
import type { Environment } from "../orm/types";

/** `_get_readable_fields()` per action model (base/models/ir_actions.py:228-240, :359-365, :416-418, :437-440,
 * :977-980, :1495-1498; base/models/ir_actions_report.py:118-127). No installed module extends them (the only
 * override, addons/printer, is not installed in the corpus databases). */
const BASE_READABLE = ["binding_model_id", "binding_type", "binding_view_types", "display_name", "help", "id", "name", "type", "xml_id", "path"];
const READABLE: Readonly<Record<string, readonly string[]>> = {
  "ir.actions.actions": BASE_READABLE,
  "ir.actions.act_window": [...BASE_READABLE, "context", "cache", "mobile_view_mode", "domain", "filter", "group_ids", "limit",
    "res_id", "res_model", "search_view_id", "target", "view_id", "view_mode", "views", "embedded_action_ids", "close_on_report_download"],
  "ir.actions.act_window_close": [...BASE_READABLE, "effect", "infos"],
  "ir.actions.act_url": [...BASE_READABLE, "target", "url", "close"],
  "ir.actions.server": [...BASE_READABLE, "group_ids", "model_name"],
  "ir.actions.client": [...BASE_READABLE, "context", "params", "res_model", "tag", "target"],
  "ir.actions.report": [...BASE_READABLE, "report_name", "report_type", "target", "context", "data", "close_on_report_download"],
};

/** utils.py:122-157 `generate_views(action)`. */
function generateViews(action: Record<string, unknown>): void {
  let viewId = action["view_id"] || false;
  if (Array.isArray(viewId)) viewId = viewId[0] ?? false;
  const viewMode = action["view_mode"];
  if (typeof viewMode !== "string") throw new OdooError("builtins.KeyError", "'view_mode'");
  const modes = viewMode.split(",");
  if (modes.length > 1) {
    if (viewId) throw new OdooError("builtins.ValueError", "Non-db action dictionaries should provide either multiple view modes or a single view mode and an optional view id.");
    action["views"] = modes.map((m) => [false, m]);
    return;
  }
  action["views"] = [[viewId, modes[0]]];
}

/** utils.py:40-64 `clean_action(action, env)`. */
export function cleanAction(action: Record<string, unknown>, env: Environment): Record<string, unknown> {
  if (!("type" in action)) action["type"] = "ir.actions.act_window_close";
  const type = action["type"];
  if (type === "ir.actions.act_window" && !action["views"]) generateViews(action);
  if (typeof type !== "string" || !env.reg.models.has(type)) throw new OdooError("builtins.KeyError", `'${String(type)}'`);
  const readable = READABLE[type];
  if (readable === undefined) throw new NotPorted(`clean_action for ${type} (_get_readable_fields)`);
  const typeFields = env.reg.model(type).fields;
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(action)) {
    // keep allowed fields and custom properties fields
    if (readable.includes(k) || !typeFields.has(k)) cleaned[k] = v;
  }
  return cleaned;
}

jsonRoute(["/web/dataset/call_button", "/web/dataset/call_button/<path:path>"], async (ctx) => {
  const p = ctx.jsonParams ?? {};
  for (const k of ["model", "method", "args", "kwargs"]) {
    if (!(k in p)) throw new OdooError("builtins.TypeError", `DataSet.call_button() missing 1 required positional argument: '${k}'`);
  }
  const model = p["model"];
  const method = p["method"];
  const args = p["args"];
  const kwargs = p["kwargs"];
  if (typeof model !== "string" || typeof method !== "string") throw new OdooError("builtins.TypeError", "model and method must be strings");
  if (!Array.isArray(args) || typeof kwargs !== "object" || kwargs === null || Array.isArray(kwargs)) {
    throw new OdooError("builtins.TypeError", "invalid args or kwargs");
  }
  const env = await ctx.orm();
  // dataset.py:15-20 `_call_kw_readonly` (the route's readonly callback): `request.registry[model]` -> NotFound
  if (!env.reg.models.has(model)) throw new HttpError(404, "");
  const action = await callKw(env, model, method, args, kwargs as Record<string, unknown>);
  // dataset.py:39: `isinstance(action, dict) and action.get('type') != ''`
  if (typeof action === "object" && action !== null && !Array.isArray(action) && (action as Record<string, unknown>)["type"] !== "") {
    return cleanAction({ ...(action as Record<string, unknown>) }, env);
  }
  return false;
});
