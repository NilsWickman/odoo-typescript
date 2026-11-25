/**
 * Small public methods scripts call over call_kw (XML-RPC, JSON-RPC, /json/2):
 *  - `ir.model.data.check_object_reference(module, xml_id, raise_on_access_error=False)` (base ir_model.py:2378-2388)
 *    with `_xmlid_lookup` (:2351-2361), on models whose `search` is Odoo's own (gen/out/poc_erp/orm_methods.json);
 *  - `ir.actions.server.run()` (base ir_actions.py:1169-1198) as far as a missing action: its `_get_eval_context` reads
 *    the action and raises MissingError; running an existing action is not ported.
 */
import { AccessError, MissingError, NotPorted } from "../errors";
import { registerMethod } from "../http/methods";
import { cond, PyValueError } from "../orm/domain";
import { envFor } from "../web/common";
import { translate } from "./util";
import { runServerAction } from "./ir_actions_server";
import { toJson } from "./server_action_code";
import { genericMethod } from "../orm/generic_methods";
import { templateOf } from "../orm/template";
import genErp from "../../gen/out/poc_erp/orm_methods.json" with { type: "json" };

const searchable = new Set(Object.entries(genErp.models as Record<string, string[]>).filter(([, m]) => m.includes("search")).map(([k]) => k));

registerMethod("ir.model.data", "check_object_reference", async (env0, _ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const module = "module" in kwargs ? kwargs["module"] : args[0];
  const xmlId = "xml_id" in kwargs ? kwargs["xml_id"] : args[1];
  const raiseOnAccess = "raise_on_access_error" in kwargs ? kwargs["raise_on_access_error"] : args[2] ?? false;
  if (typeof module !== "string" || typeof xmlId !== "string") throw new NotPorted("check_object_reference with a module or xml_id that is not a string");
  // `"%s.%s" % (module, xml_id)` split on the first dot
  const full = `${module}.${xmlId}`;
  const dot = full.indexOf(".");
  const r = (await env.cr.query<{ model: string; res_id: number | null }>(
    "SELECT model, res_id FROM ir_model_data WHERE module = $1 AND name = $2", [full.slice(0, dot), full.slice(dot + 1)])).rows[0];
  if (!r || !r.res_id) throw new PyValueError(`External ID not found in the system: ${full}`);
  if (!env.reg.models.has(r.model)) throw new NotPorted(`check_object_reference of a ${r.model} record (model not in the registry: KeyError)`);
  // a model of a site's new modules: its own build says (compiler/oc/module_keys.py `generic`, src/orm/generic_methods.ts)
  if (!searchable.has(r.model) && !genericMethod((await templateOf(env.cr)).name, r.model, "search")) {
    throw new NotPorted(`check_object_reference on ${r.model}, whose search is overridden`);
  }
  if ((await env.model(r.model).search(cond("id", "=", r.res_id))).length) return [r.model, r.res_id];
  if (raiseOnAccess) {
    throw new AccessError(translate(env, 'Not enough access rights on the external ID "%(module)s.%(xml_id)s"', "base")
      .replace("%(module)s", module).replace("%(xml_id)s", xmlId));
  }
  return [r.model, false];
}, { apiModel: true });

registerMethod("ir.actions.server", "run", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  let res: unknown = false;
  for (const id of ids ?? []) {
    const exists = (await env.cr.query("SELECT 1 FROM ir_act_server WHERE id = $1", [id])).rows.length > 0;
    // :1192 `self._get_eval_context(action.sudo())` reads the action first (models.py `_fetch_query` MissingError)
    if (!exists) throw new MissingError(`Record does not exist or has been deleted.\n(Record: ir.actions.server(${id},), User: ${env.uid})`);
    // :1191-1197 the last action's result (src/models/ir_actions_server.ts; other states refuse there)
    res = toJson(await runServerAction(env, id));
  }
  return res;
}, { apiModel: false });
