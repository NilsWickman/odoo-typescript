/**
 * Server actions an administrator creates and runs (ACCEPTANCE.md A18), odoo/odoo/addons/base/models/ir_actions.py:
 *  - `create` (:695-712): the first history entry of a code action (`ir.actions.server.history`), after mail.thread's
 *    creation message; `_check_python_code` (:962-967) through the code runner's parser (code it cannot read refuses);
 *    a child action (`parent_id`, which copies the parent's model and groups) refuses;
 *  - `run` (:1169-1198) for the states `code`, `object_write` and `object_create`: the eval context (:1129-1167, with
 *    mail's `mail_notify_force_send=False`, mail/models/ir_actions_server.py:464-470), `_can_execute_action_on_records`
 *    (:1233-1260), `_run` (:1200-1231: the warnings, the multi runner once, the others once per active id) and the
 *    runners `_run_action_code_multi` (src/models/server_action_code.ts), `_run_action_object_write` (:1027-1056,
 *    `_eval_value` :1325-1363) and `_run_action_object_create` (:1115-1127);
 *  - `/web/action/run` (web/controllers/action.py:51-57) falls back to `runServerActionRoute` with `clean_action`
 *    (web/controllers/utils.py:40-64) for the client action types whose fields are known here.
 * Other states (mail_post, followers, next_activity, sms, webhook, multi, object_copy), sequences, properties and
 * x2many values refuse with NotPorted before anything is written.
 */
import { AccessError, NotPorted, UserError } from "../errors";
import { hostIdFromDomain, lookupMethod } from "../http/methods";
import { checkModelAccess } from "../orm/access";
import { userInfo } from "../orm/env";
import { registerOverrides } from "../orm/write";
import { registerDefaults, registerRecordCompute, type Rec } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { parseProgram, runActionCode, runCode, toJson } from "./server_action_code";
import { filteredAccess } from "./tail_util";
import { translate } from "./util";
import { trackAbortLevel, trackedFields, trackPrepare } from "../mail/tracking";
import { closeTrackingScope } from "../mail/write_hooks";

interface ActionRow {
  id: number; name: string | null; state: string; model: string; code: string | null; evaluation_type: string | null; value: string | null;
  update_path: string | null; update_property: string | null; update_field: string | null; update_field_type: string | null;
  update_boolean_value: string | null; update_m2m_operation: string | null; html_value: string | null; crud_model: string | null;
  link_field_id: number | null; parent_id: number | null; children: number; groups: number[];
}

async function actionRow(env: Environment, id: number): Promise<ActionRow | null> {
  return (await env.cr.query<ActionRow>(
    `SELECT a.id, a.name->>'en_US' AS name, a.state, m.model, a.code, a.evaluation_type, a.value, a.update_path, a.update_property,
            f.name AS update_field, f.ttype AS update_field_type, a.update_boolean_value, a.update_m2m_operation, a.html_value,
            cm.model AS crud_model, a.link_field_id, a.parent_id,
            (SELECT count(*)::int FROM ir_act_server c WHERE c.parent_id = a.id) AS children,
            ARRAY(SELECT r.gid FROM ir_act_server_group_rel r WHERE r.act_id = a.id ORDER BY r.gid) AS groups
       FROM ir_act_server a JOIN ir_model m ON m.id = a.model_id LEFT JOIN ir_model_fields f ON f.id = a.update_field_id
       LEFT JOIN ir_model cm ON cm.id = a.crud_model_id WHERE a.id = $1`, [id])).rows[0] ?? null;
}

const refusedRun = (env: Environment): AccessError => new AccessError(translate(env, "You don't have enough access rights to run this action.", "base"));

/** :1233-1260 `_can_execute_action_on_records`. */
async function canExecute(env: Environment, a: ActionRow, records: readonly number[]): Promise<void> {
  if (a.groups.length) {
    const mine = new Set((await userInfo(env)).groupIds);
    if (!a.groups.some((g) => mine.has(g))) throw refusedRun(env);
    return;
  }
  try {
    if (!env.su) await checkModelAccess(env, env.reg.model(a.model), "write");
  } catch (e) {
    if (e instanceof AccessError) throw refusedRun(env);
    throw e;
  }
  if (records.length && (await filteredAccess(env, a.model, records, "write")).size !== new Set(records).size) throw refusedRun(env);
}

function ids(v: unknown): number[] | null {
  if (v === undefined || v === null || v === false) return null;
  if (typeof v === "number") return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === "number")) return v as number[];
  throw new NotPorted("server action with active ids that are not integers");
}

/** :1325-1363 `_eval_value` of one action, for the scalar field types. */
async function evalValue(env: Environment, a: ActionRow, record: number | null): Promise<unknown> {
  const type = a.update_field_type;
  if (type === "properties" || type === "one2many" || type === "many2many") throw new NotPorted(`server action value of a ${type} field`);
  if (a.evaluation_type === "equation") {
    // safe_eval(value, eval_context): an expression over the same names as code (src/models/server_action_code.ts)
    return runActionCode(env, a.model, `action = ${a.value ?? ""}`, record, record === null ? null : [record]);
  }
  if (a.evaluation_type === "sequence") throw new NotPorted("server action value from a sequence (ir.sequence next_by_id)");
  if (type === "boolean") return a.update_boolean_value === "true";
  if (type === "many2one" || type === "integer") {
    // int(value), else the text itself (`except Exception: pass`)
    const s = (a.value ?? "").trim();
    if (/^[+-]?\d+$/.test(s)) { const n = Number(s); return n === 0 && type === "many2one" ? false : n; }
    return a.value ?? false;
  }
  if (type === "float") {
    const s = (a.value ?? "").trim();
    if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return Number(s);
    return a.value ?? false;
  }
  if (type === "html") return a.html_value ?? false;
  return a.value ?? false;
}

/** :1027-1056 `_run_action_object_write` for one active id: the value evaluated with the eval context (the user's env),
 * written as superuser (`action.sudo()._run`). */
async function runObjectWrite(user: Environment, sudo: Environment, a: ActionRow, activeId: number | null): Promise<void> {
  const value = await evalValue(user, a, activeId);
  if (sudo.context["onchange_self"]) throw new NotPorted("server action run from an onchange");
  if (!a.update_path) return;
  if (a.update_property) throw new NotPorted("server action writing a property");
  if (!a.update_field) throw new NotPorted("server action without a field to update");
  // reduce(getitem, path[:-1], starting_record): the records at the end of the path
  let model = a.model, targets: number[] = activeId === null ? [] : [activeId];
  for (const part of a.update_path.split(".").slice(0, -1)) {
    const f = sudo.reg.model(model).fields.get(part);
    if (!f || f.type !== "many2one" || !f.relation) throw new NotPorted(`server action update path through ${model}.${part}`);
    const out: number[] = [];
    for (const id of targets) {
      const [row] = await sudo.model(model).read([id], [part], "");
      const v = row?.[part];
      const rid = Array.isArray(v) ? v[0] : v;
      if (typeof rid === "number" && !out.includes(rid)) out.push(rid);
    }
    model = f.relation; targets = out;
  }
  const m = lookupMethod(model, "write");
  if (!m) throw new NotPorted(`${model}.write`);
  if (targets.length) await m.fn(sudo, targets, [{ [a.update_field]: value }], {}, model);
}

/** :1115-1127 `_run_action_object_create`: `name_create(value)` on the model to create, as superuser. */
async function runObjectCreate(sudo: Environment, a: ActionRow): Promise<void> {
  if (a.link_field_id !== null) throw new NotPorted("server action creating a record linked to the active record");
  if (!a.crud_model) throw new NotPorted("server action creating a record without a model");
  const m = lookupMethod(a.crud_model, "name_create");
  if (!m) throw new NotPorted(`${a.crud_model}.name_create`);
  await m.fn(sudo, null, [a.value ?? false], {}, a.crud_model);
}

/** :1169-1231 `run()` of one action: its result (an action dict, or false). */
export async function runServerAction(env0: Environment, actionId: number): Promise<unknown> {
  const a = await actionRow(env0.sudo(), actionId);
  if (!a) throw new NotPorted(`ir.actions.server.run of a missing action ${actionId}`);
  if (!["code", "object_write", "object_create"].includes(a.state)) throw new NotPorted(`server action of type ${a.state}`);
  if (a.children) throw new NotPorted("server action with child actions");
  // mail's `mail_notify_force_send=False` (mail/models/ir_actions_server.py:464-470) is the eval context's (its env,
  // model and records: code, runActions below); object_write and object_create write with the action's own env, whose
  // notifications are sent (a18_actions: the salesperson's assignment email)
  const env = env0;
  const active = env.context["active_model"] === a.model;
  const record = active && env.context["active_id"] ? ids(env.context["active_id"])![0]! : null;
  const records = active && env.context["active_ids"] ? ids(env.context["active_ids"]) : null;
  // :1192-1194 record | records
  const union = [...new Set([...(record === null ? [] : [record]), ...(records ?? [])])];
  await canExecute(env, a, union);
  const sudo = env.sudo();
  // :1203-1204 `self.warning`: the warnings of these states (sequence on a non-text field; JSON fields in the path)
  if (a.state === "object_write" && a.evaluation_type === "sequence" && a.update_field_type && !["char", "text"].includes(a.update_field_type)) {
    throw new UserError(translate(env, "Server action %(action_name)s has one or more warnings, address them first.", "base").replace("%(action_name)s", a.name ?? ""));
  }
  if (a.update_field_type === "json") throw new NotPorted("server action on a JSON field (warning)");
  // Odoo logs the tracking of every write at precommit; the port logs at the outermost write of a model, so the run
  // is one tracking scope of the action's model (its writes, one per active id, log after all of them)
  const tracked = (await trackedFields(env, a.model)).length > 0;
  if (tracked) await trackPrepare(env, a.model, []);
  let res: unknown;
  try {
    res = await runActions(env, sudo, a, record, records);
  } catch (e) {
    if (tracked) trackAbortLevel(env.cr, a.model);
    throw e;
  }
  if (tracked) await closeTrackingScope(env, a.model);
  return res;
}

/** :1200-1231 `_run`: the multi runner once, the others once per active id. */
async function runActions(env: Environment, sudo: Environment, a: ActionRow, record: number | null, records: readonly number[] | null): Promise<unknown> {
  if (a.state === "code") {
    // the multi runner once, with the eval context's env (the user's, not sudo); the code by the runner that takes it
    // (src/models/server_action_code.ts codeRunnerFor: this interpreter, or the compiled build's)
    if (!a.code) return false;
    const res = await runCode(env.withContext({ ...env.context, mail_notify_force_send: false }), a.model, a.code, record, records);
    return res === null || res === undefined ? false : res;
  }
  // :1213-1225 once per active id (active_ids, else active_id), with that id as active_id(s)
  const activeIds = ids(env.context["active_ids"]) ?? (record !== null ? [record] : ids(env.context["active_id"]) ?? []);
  for (const id of activeIds) {
    const ctx = { ...sudo.context, active_ids: [id], active_id: id };
    if (a.state === "object_write") await runObjectWrite(env.withContext(ctx), sudo.withContext(ctx), a, id);
    else await runObjectCreate(sudo.withContext(ctx), a);
  }
  return false;
}

/** web/controllers/utils.py:40-64 `clean_action` for the client action types known here. */
function cleanAction(env: Environment, action: Record<string, unknown>): Record<string, unknown> {
  const type = (action["type"] ??= "ir.actions.act_window_close") as string;
  const readable: Record<string, readonly string[]> = {
    // ir_actions.py:236-240 and :1495-1498 (ir.actions.client), :416-421 (act_window_close), :359-365 (act_window),
    // :437-440 (act_url)
    "ir.actions.client": ["context", "params", "res_model", "tag", "target"],
    "ir.actions.act_window_close": ["effect", "infos"],
    "ir.actions.act_window": ["context", "cache", "mobile_view_mode", "domain", "filter", "group_ids", "limit", "res_id", "res_model",
      "search_view_id", "target", "view_id", "view_mode", "views", "embedded_action_ids", "close_on_report_download"],
    "ir.actions.act_url": ["target", "url", "close"],
  };
  // utils.py:44-45: a window action without views gets them from generate_views
  if (type === "ir.actions.act_window" && !(Array.isArray(action["views"]) && action["views"].length)) throw new NotPorted("clean_action of a window action without views (generate_views)");
  const own = readable[type];
  if (!own || !env.reg.models.has(type)) throw new NotPorted(`clean_action of an ${type} action`);
  const keep = new Set(["binding_model_id", "binding_type", "binding_view_types", "display_name", "help", "id", "name", "type", "xml_id", "path", ...own]);
  const fields = env.reg.model(type).fields;
  return Object.fromEntries(Object.entries(action).filter(([k]) => keep.has(k) || !fields.has(k)));
}

/** action.py:51-57 `/web/action/run` for an action the specific runners do not cover. */
export async function runServerActionRoute(env0: Environment, actionId: number): Promise<unknown> {
  // router.py:389 sets host_id on the request's context (ir_http.py:256-310 `_get_host_id_from_domain`), which the
  // action's environment and the action it returns carry (src/http/methods.ts callMethod does the same for call_kw)
  const hostId = env0.context["host_id"] ?? await hostIdFromDomain(env0);
  const env = hostId ? env0.withContext({ ...env0.context, host_id: hostId }) : env0;
  const result = toJson(await runServerAction(env, actionId));
  if (result && typeof result === "object" && !Array.isArray(result) && Object.keys(result).length) return cleanAction(env, result as Record<string, unknown>);
  return false;
}

registerOverrides("ir.actions.server", {
  create: async (env, valsList, next) => {
    for (const vals of valsList) {
      if (vals["parent_id"]) throw new NotPorted("ir.actions.server created as a child action (parent's model and groups)");
      if (!CREATE_STATES.includes(String(vals["state"]))) throw new NotPorted(`ir.actions.server created of type ${String(vals["state"])}`);
      if (typeof vals["update_path"] === "string" && vals["update_path"].includes(".")) throw new NotPorted("ir.actions.server with an update path through relations");
    }
    const created = await next(env, valsList);
    // :848-881 `_compute_crud_relations` runs at the flush, after create's protection: outside object_write it assigns
    // `update_path = False`, a write whose `modified` reaches name and automated_name through crud_model_id
    // (`_compute_name` depends on it), so `_compute_name` runs then (measured on the oracle 2026-11-09: code and
    // object_create actions get their automated name, object_write ones keep none). A given crud field protects the
    // whole compute (models.py:4165-4167 `field_computed`).
    for (let i = 0; i < created.length; i++) {
      const vals = valsList[i]!;
      if (CRUD_FIELDS.some((f) => f in vals) || vals["state"] === "object_write") continue;
      await env.cr.query("UPDATE ir_act_server SET update_path = NULL WHERE id = $1", [created[i]]);
      const row = (await env.cr.query<{ name: string | null; automated_name: string | null }>(
        "SELECT name->>'en_US' AS name, automated_name FROM ir_act_server WHERE id = $1", [created[i]])).rows[0]!;
      const generated = await generateActionName(env, created[i]!);
      // `was_automated = name == automated_name`: a given name stays (a missing one failed the NOT NULL before)
      if (row.name === row.automated_name) throw new NotPorted("ir.actions.server whose given name equals its automated name");
      await env.cr.query("UPDATE ir_act_server SET automated_name = $2 WHERE id = $1", [created[i], generated]);
    }
    // :704-711 the first history entries of the code actions
    const history = created.map((id, i) => ({ id, vals: valsList[i]! })).filter((x) => "code" in x.vals);
    if (history.length) {
      const m = lookupMethod("ir.actions.server.history", "create");
      if (!m) throw new NotPorted("ir.actions.server.history create");
      await m.fn(env, null, [history.map((h) => ({ action_id: h.id, code: h.vals["code"] ?? false }))], {}, "ir.actions.server.history");
    }
    return created;
  },
  // :714-717 a new history entry when the code changes (before the write); also through ir.cron's delegated `code`
  // (lunch's `_sync_cron`, `cron.code = ...`)
  write: async (env, ids, vals, next) => {
    const code = vals["code"];
    if (typeof code === "string" ? code !== "" : code !== undefined && code !== false && code !== null) {
      if (typeof code !== "string") throw new NotPorted(`ir.actions.server code written as ${typeof code}`);
      // `self.code` of several records raises (Expected singleton), of none is False
      if (ids.length !== 1) throw new NotPorted(`ir.actions.server code written on ${ids.length} actions`);
      const current = (await env.cr.query<{ code: string | null }>("SELECT code FROM ir_act_server WHERE id = $1", [ids[0]])).rows[0]?.code ?? null;
      if (code !== (current ?? false)) {
        const m = lookupMethod("ir.actions.server.history", "create");
        if (!m) throw new NotPorted("ir.actions.server.history create");
        await m.fn(env, null, [[{ action_id: ids[0], code }]], {}, "ir.actions.server.history");
      }
    }
    await next(env, ids, vals);
  },
  constraints: [{
    fields: ["code"],
    // :962-967 `test_python_expr(code.strip(), mode="exec")`: code the runner reads is valid Python here; other code
    // cannot be checked and refuses
    fn: async (env, actionIds) => {
      for (const id of actionIds) {
        const code = (await env.cr.query<{ code: string | null }>("SELECT code FROM ir_act_server WHERE id = $1", [id])).rows[0]?.code;
        if (code) parseProgram(code.trim());
      }
    },
  }],
});

registerDefaults("ir.actions.server", {
  // ir_actions.py:572-583 `_default_update_path`: the first of the sensible fields of the context's default model that
  // the model has and that is not readonly, else ''
  update_path: async (env) => {
    const modelId = env.context["default_model_id"];
    if (!modelId) return "";
    if (typeof modelId !== "number") throw new NotPorted("default_model_id that is not an id");
    const name = (await env.cr.query<{ model: string }>("SELECT model FROM ir_model WHERE id = $1", [modelId])).rows[0]?.model;
    if (!name || !env.reg.models.has(name)) throw new NotPorted(`default_model_id of a model outside the registry (${String(name)})`);
    const fields = env.reg.model(name).fields;
    for (const f of ["partner_id", "user_id", "user_ids", "stage_id", "state", "active"]) {
      const def = fields.get(f);
      if (def && !def.readonly) return f;
    }
    return "";
  },
  // mail/models/ir_actions_server.py:63-67 `self.env.ref('mail.mt_comment').ids`
  subtype_ids: async (env) => {
    const id = await env.reg.xmlid(env.cr, "mail.mt_comment");
    if (id === null) throw new NotPorted("mail.mt_comment is missing");
    return [[6, 0, [id]]];
  },
});

/** The states an administrator's create is ported for. */
const CREATE_STATES = ["code", "object_write", "object_create"];
/** `pool.field_computed` of `_compute_crud_relations`. */
const CRUD_FIELDS = ["crud_model_id", "update_field_id", "update_property", "update_related_model_id"];

/** ir_actions.py:805-818 `_generate_action_name` (with mail's and sms' overrides, which act on other states). */
async function generateActionName(env: Environment, id: number): Promise<string> {
  if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated server action names (${env.lang})`);
  const a = (await env.cr.query<{ state: string; crud: string | null }>(
    "SELECT a.state, m.name->>'en_US' AS crud FROM ir_act_server a LEFT JOIN ir_model m ON m.id = a.crud_model_id WHERE a.id = $1", [id])).rows[0]!;
  if (a.state === "object_create") return `Create ${a.crud ?? "False"}`;
  if (a.state === "object_write") return `Update ${a.crud ?? "False"}`;
  // dict(self._fields["state"]._description_selection(self.env)).get(self.state, "")
  const label = env.reg.model("ir.actions.server").fields.get("state")?.selection?.find((s) => s.value === a.state)?.label;
  if (label === undefined) throw new NotPorted(`the label of server action type ${a.state}`);
  return label;
}

const m2o = (v: unknown): number | false => (typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : false);

/** :848-881 `_compute_crud_relations` for a plain update path (one field of the model, no property). */
async function crudRelations(rec: Rec): Promise<{ crud: number | false; field: number | false; property: unknown; related: unknown }> {
  const state = await rec.get("state"), model = m2o(await rec.get("model_id"));
  const same = { property: await rec.prev("update_property"), related: await rec.prev("update_related_model_id") };
  if (!model || !["object_write", "object_create", "object_copy"].includes(String(state))) return { crud: false, field: false, ...same };
  if (state !== "object_write") return { crud: model, field: false, ...same };
  const path = await rec.get("update_path");
  if (!path) return { crud: model, field: false, ...same };
  if (typeof path !== "string" || path.includes(".")) throw new NotPorted("server action update path through relations (_traverse_path)");
  const modelName = (await rec.env.cr.query<{ model: string }>("SELECT model FROM ir_model WHERE id = $1", [model])).rows[0]!.model;
  const f = (await rec.env.cr.query<{ id: number; relation: string | null; ttype: string }>(
    "SELECT id, relation, ttype FROM ir_model_fields WHERE model = $1 AND name = $2", [modelName, path])).rows[0];
  if (!f) throw new NotPorted(`server action update path ${path} (no such field: KeyError)`);
  if (f.ttype === "properties" || f.ttype === "json") throw new NotPorted(`server action update path to a ${f.ttype} field`);
  // need_update_model: a value update of a relational field
  let related: number | false = false;
  if ((await rec.get("evaluation_type")) === "value" && f.relation) {
    related = (await rec.env.cr.query<{ id: number }>("SELECT id FROM ir_model WHERE model = $1", [f.relation])).rows[0]?.id ?? false;
  }
  return { crud: model, field: f.id, property: false, related };
}

registerRecordCompute("ir.actions.server", {
  crud_model_id: async (_env, rec) => (await crudRelations(rec)).crud,
  update_field_id: async (_env, rec) => (await crudRelations(rec)).field,
  update_property: async (_env, rec) => (await crudRelations(rec)).property,
  update_related_model_id: async (_env, rec) => (await crudRelations(rec)).related,
  // mail/models/ir_actions_server.py:171-277: everything the states mail_post, log_note, followers and next_activity
  // use is reset for the other states (the ported ones refuse those states at create)
  template_id: async () => false,
  mail_post_autofollow: async () => false,
  // a translated html field: None (NULL) rather than False, which the flush would store as {"en_US": false}
  log_note_note: async () => null,
  followers_type: async () => false,
  followers_partner_field_name: async () => false,
  partner_ids: async () => [],
  activity_plan_id: async () => false,
  activity_type_id: async () => false,
  activity_date_deadline_range: async () => false,
  activity_date_deadline_range_type: async () => false,
  // :248-253 no plan: the default 'specific' when unset
  activity_user_type: async (_env, rec) => (await rec.prev("activity_user_type")) || "specific",
  // :255-268 specific: kept; the role and the user field are reset
  activity_user_id: async (_env, rec) => ((await rec.get("activity_user_type")) !== "specific" ? false : (await rec.prev("activity_user_id")) ?? false),
  activity_role_id: async (_env, rec) => ((await rec.get("activity_user_type")) !== "role" ? false : (await rec.prev("activity_role_id")) ?? false),
  activity_user_field_name: async (_env, rec) => {
    if ((await rec.get("activity_user_type")) === "generic") throw new NotPorted("server action activity user field (generic)");
    return false;
  },
  // sms/models/ir_actions_server.py:40-47
  sms_template_id: async () => false,
});
