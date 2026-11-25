/**
 * The document-based read access of mail.activity: the search method of `res_access_read`
 * (odoo/addons/mail/models/mail_activity.py:70-74, `_search_res_access` :499-555), which the record rule
 * `['|', ('user_id', '=', user.id), ('res_access_read', '=', True)]` (mail/security/ir.access.csv:131) puts on the
 * search path of every non-superuser read of activities (e.g. `activity_ids` of any mail.activity.mixin model).
 *
 * The search method receives the searched domain through `search_domain` (src/orm/sql.ts searchDomainOf):
 *  - with a `res_model` restriction it builds, per document model, `res_id any! <query of readable documents>`;
 *  - without one it fetches the matching activities (sudo, at most MAX_SEARCH_LIMIT) and keeps those the user may
 *    read (`_filtered_access('read')`, models.py:3539-3563: the access domain evaluated on the records, where
 *    `res_access_read` is the compute `_compute_res_access` :280-301 and `_find_allowed_doc_ids`,
 *    mail_message.py:66-97).
 * The write, create and unlink variants take the first branch (`operation != 'read'`).
 */
import { AccessError, NotPorted } from "../errors";
import { checkModelAccess, accessDomain } from "../orm/access";
import * as D from "../orm/domain";
import { envTz } from "../orm/env";
import { registerHooks } from "../orm/hooks";
import { registerOverrides } from "../orm/write";
import { queryIds, searchDomainOf, searchQuery, optimizeFull } from "../orm/sql";
import type { Domain, Environment, ModelDef } from "../orm/types";
import { translate } from "./util";

/** odoo/tools/constants.py:13 IN_MAX; mail_message.py:32 MAX_SEARCH_LIMIT = IN_MAX * 10. */
const MAX_SEARCH_LIMIT = 1000 * 10;

/** ir_attachment.py:52-66 `condition_values`: the values of the `in` conditions on `field` the domain restricts to. */
export async function conditionValues(env: Environment, def: ModelDef, field: string, domain: Domain): Promise<unknown[] | null> {
  const dmodel = D.domainModelOf(env.reg, def, await envTz(env));
  const optimized = D.optimizeBasic(domain, dmodel);
  const kept = D.optimizeBasic(D.mapConditions(optimized, (c) => (c.path === field && c.op === "in" ? c : D.TRUE)), dmodel);
  for (const c of D.iterConditions(kept)) return Array.isArray(c.value) ? [...(c.value as unknown[])] : [c.value];
  return null;
}

/** `env(su=False)`: the same user without superuser mode. */
function userEnv(env: Environment, context = env.context): Environment {
  return env.withUser(env.uid).withContext(context);
}

/** `_mail_post_access` of the models that set it (mail_thread.py:147 default 'write'). */
const MAIL_POST_ACCESS: Readonly<Record<string, "read" | "write">> = {
  "res.partner": "read", "res.users": "read", "crm.team": "read", "sale.order": "read", "discuss.channel": "read",
  "account.move": "read", "hr.expense": "read", "product.product": "read", "product.template": "read",
  "purchase.order": "read", "project.task": "read", // purchase_order.py:27, project_task.py
};
type DocOp = "read" | "write";
export type ActivityOperation = "read" | "write" | "create" | "unlink";

/**
 * `_mail_get_operation_for_mail_message_operation(operation)` (mail/models/models.py:64-103): `((TRUE, op),)` with
 * op 'read' for read, `_mail_post_access` for create, 'write' otherwise; with the overrides of calendar.event (read,
 * calendar_event.py:1289-1298) and discuss.channel (write: none; create: the read-only check, discuss_channel.py:1489-1502).
 */
async function mailOperations(env: Environment, model: string, operation: ActivityOperation): Promise<[Domain, DocOp][]> {
  // product.product / product.template: `_mail_post_access = "read"` comes from website_sale (product_product.py:16,
  // product_template.py:48), mail_thread.py:147's 'write' otherwise
  const websiteSale = (env.reg.models.get(model)?.modules ?? []).includes("website_sale");
  const postAccess = (model === "product.product" || model === "product.template") && !websiteSale ? "write" : MAIL_POST_ACCESS[model];
  const op: DocOp = operation === "read" ? "read" : operation === "create" ? (postAccess ?? "write") : "write";
  const base: [Domain, DocOp][] = [[D.TRUE, op]];
  if (model === "calendar.event" && operation === "read") {
    const partner = (await env.cr.query<{ partner_id: number }>("SELECT partner_id FROM res_users WHERE id = $1", [env.uid])).rows[0]?.partner_id;
    const priv = D.and([D.cond("privacy", "=", "private"), D.not(D.cond("attendee_ids.partner_id", "=", partner ?? false))]);
    return [[priv, "write"], ...base];
  }
  if (model === "discuss.channel" && operation !== "read") {
    if (operation === "create") return [[D.or([D.cond("is_readonly", "=", false), D.cond("can_self_edit_readonly_channel", "=", true)]), "read"]];
    return [];
  }
  for (const name of ["product.product", "product.template", "event.event", "slide.channel", "blog.post", "crm.lead"]) {
    // other overrides of the method in Odoo's addons (crm.lead: website_crm_partner_assign), not checked here
    // product.*: the override is website_sale's (product_product.py:562, product_template.py:2004)
    const overriding = name === "crm.lead" ? false
      : name.startsWith("product.") ? (env.reg.models.get(name)?.modules ?? []).includes("website_sale")
      : env.reg.models.has(name);
    if (model === name && overriding) throw new NotPorted(`${name}._mail_get_operation_for_mail_message_operation`);
  }
  return base;
}

/** `records._filtered_access(operation)` (models.py:3539-3563) for a model without a `_check_access` override. */
async function filteredAccess(env: Environment, def: ModelDef, ids: readonly number[], operation: "read" | "write"): Promise<number[]> {
  if (env.su || ids.length === 0) return [...ids];
  const domain = await accessDomain(env, def, operation);
  if (domain.kind === "false") return [];
  if (domain.kind === "true") return [...ids];
  const ok = new Set(await queryIds(await searchQuery(env, def, D.cond("id", "in", [...ids]), { activeTest: false, secDomain: domain })));
  return ids.filter((id) => ok.has(id));
}

/** mail_message.py:66-97 `_find_allowed_doc_ids(env, model_ids, operation)`. */
async function findAllowedDocIds(env: Environment, modelIds: Map<string, Map<number, number[]>>, operation: ActivityOperation): Promise<Set<number>> {
  const allowed = new Set<number>();
  for (const [docModel, docDict] of modelIds) {
    if (!env.reg.models.has(docModel)) continue;
    const def = env.reg.model(docModel);
    // exists_in_cache(...) -> the documents that exist
    const existing = (await env.cr.query<{ id: number }>(`SELECT id FROM "${def.table}" WHERE id = ANY($1::int[])`, [[...docDict.keys()]])).rows.map((r) => r.id);
    let documents = new Set(existing);
    for (const [documentDomain, docOperation] of await mailOperations(env, docModel, operation)) {
      if (documents.size === 0) break;
      const sudo = env.sudo().withContext({ ...env.context, active_test: false });
      const matched = documentDomain.kind === "true"
        ? [...documents]
        : await queryIds(await searchQuery(sudo, def, D.and([D.cond("id", "in", [...documents]), documentDomain]), { activeTest: false }));
      const records = [...documents].filter((id) => matched.includes(id));
      documents = new Set([...documents].filter((id) => !matched.includes(id)));
      for (const id of await filteredAccess(env, def, records, docOperation)) for (const act of docDict.get(id) ?? []) allowed.add(act);
    }
  }
  return allowed;
}

interface ActRow { id: number; res_model: string | null; res_id: number | null; user_id: number | null }

/** `_compute_res_access(operation)` (mail_activity.py:280-301), evaluated for a non-superuser environment. */
async function resAccess(env: Environment, acts: readonly ActRow[], operation: ActivityOperation): Promise<Set<number>> {
  if (acts.length === 0) return new Set();
  try {
    await checkModelAccess(env, env.reg.model("mail.activity"), operation); // self.browse().sudo(False).has_access(operation)
  } catch (e) {
    if (e instanceof AccessError) return new Set();
    throw e;
  }
  const modelIds = new Map<string, Map<number, number[]>>();
  for (const a of acts) {
    if (!a.res_model || !a.res_id) continue;
    const docs = modelIds.get(a.res_model) ?? new Map<number, number[]>();
    modelIds.set(a.res_model, docs);
    docs.set(a.res_id, [...(docs.get(a.res_id) ?? []), a.id]);
  }
  return findAllowedDocIds(env, modelIds, operation);
}

/**
 * `activities._filtered_access(operation)` for a non-superuser (models.py:3539-3563): the access domain evaluated
 * on the records (`filtered_domain`), where each `res_access_<op>` condition is the compute's value.
 */
async function filteredActivities(env: Environment, acts: readonly ActRow[], operation: ActivityOperation): Promise<number[]> {
  const def = env.reg.model("mail.activity");
  const domain = await accessDomain(env, def, operation);
  if (domain.kind === "false" || acts.length === 0) return [];
  const computed = new Map<string, Set<number>>();
  for (const c of D.iterConditions(domain)) {
    const m = /^res_access_(read|write|create|unlink)$/.exec(c.path);
    if (m && !computed.has(c.path)) computed.set(c.path, await resAccess(env, acts, m[1] as ActivityOperation));
  }
  const replaced = D.mapConditions(domain, (c) => {
    const set = computed.get(c.path);
    if (set === undefined) return c;
    const v = c.value;
    const wantsTrue = (c.op === "=" && v === true) || (c.op === "in" && Array.isArray(v) && v.length === 1 && v[0] === true);
    if (!wantsTrue) throw new NotPorted(`mail.activity access rule condition ${D.pyRepr(c.op)} on ${c.path}`);
    return D.cond("id", "in", [...set]);
  });
  const sudo = env.sudo().withContext({ ...env.context, active_test: false });
  const ids = acts.map((a) => a.id);
  const ok = new Set(await queryIds(await searchQuery(sudo, def, D.and([D.cond("id", "in", ids), replaced]), { activeTest: false })));
  return ids.filter((id) => ok.has(id));
}

/** mail_activity.py:499-555 `_search_res_access(operation, domain_operator)`. */
async function searchResAccess(env: Environment, operation: ActivityOperation, operator: string): Promise<Domain> {
  if (!env.su) throw new Error("_search_res_access runs as superuser");
  if (operator !== "in") throw new NotPorted(`mail.activity.res_access_${operation} with operator ${operator} (NotImplemented)`);
  const def = env.reg.model("mail.activity");
  const domain = searchDomainOf(env) ?? D.TRUE;
  const user = userEnv(env); // self.sudo(False)
  const resModelNames = await conditionValues(user, def, "res_model", domain);
  if (operation !== "read" || resModelNames === null) {
    // :509-516
    const sudo = env.withContext({ ...env.context, active_test: false });
    const ids = await queryIds(await searchQuery(sudo, def, domain, { activeTest: false, order: "id", limit: MAX_SEARCH_LIMIT }));
    if (ids.length === MAX_SEARCH_LIMIT) throw new D.PyValueError("Cannot search, too many activities");
    const rows = ids.length ? (await env.cr.query<ActRow>(
      "SELECT id, res_model, res_id, user_id FROM mail_activity WHERE id = ANY($1::int[]) ORDER BY id", [ids])).rows : [];
    const allowed = await filteredActivities(user, rows, operation);
    return D.cond("id", "in", allowed);
  }
  // :518-555 search by model and res_id
  let secDomain: Domain = D.FALSE;
  const coEnv = userEnv(env, { ...env.context, active_test: false });
  for (const name of resModelNames ?? []) {
    if (typeof name !== "string" || !env.reg.models.has(name)) continue;
    const comodel = env.reg.model(name);
    let codomain: Domain = D.cond("res_model", "=", comodel.name);
    const comodelResIds = await conditionValues(user, def, "res_id",
      D.mapConditions(domain, (c) => (c.path === "res_model" ? D.and([codomain, c]) : c)));
    let comodelDomain: Domain = D.FALSE;
    let remaining: Domain = D.TRUE;
    for (const [domainOperation0, docOperation] of await mailOperations(coEnv, comodel.name, "read")) {
      const domainOperation = D.and([remaining, domainOperation0]);
      remaining = D.and([remaining, D.not(domainOperation0)]);
      let comodelRule = await accessDomain(coEnv, comodel, docOperation);
      if (comodelRule.kind === "false") continue;
      if (docOperation === "read") comodelRule = D.TRUE; // covered by the search below
      comodelDomain = D.or([comodelDomain, D.and([domainOperation, comodelRule])]);
    }
    if (comodelResIds !== null) comodelDomain = D.and([comodelDomain, D.cond("id", "in", comodelResIds)]);
    comodelDomain = await optimizeFull(comodelDomain, comodel, coEnv.sudo());
    let query;
    try {
      query = await searchQuery(coEnv, comodel, comodelDomain, {});
    } catch (e) {
      if (e instanceof AccessError) continue;
      throw e;
    }
    if (query.isEmpty()) continue;
    codomain = D.and([codomain, D.cond("res_id", "any!", new D.SubQueryValue(query))]);
    secDomain = D.or([secDomain, codomain]);
  }
  return secDomain;
}

registerHooks("mail.activity", {
  // mail_activity.py:303-318 `_make_access_error_message`: a rule domain that is not FALSE gives the activity's message
  accessErrorMessage: async (env, ids, operation, domain) => {
    if (domain.kind === "false") return null;
    const head = translate(env, "The requested operation cannot be completed due to security restrictions. Please contact your system administrator.", "base");
    return new AccessError(`${head}\n\n(Document type: Activity, Operation: ${operation})\n\nRecords: ${(await import("./display_names")).formatList(env, ids.slice(0, 6).map(String))}, User: ${env.uid}`);
  },
  search: {
    res_access_read: (env, operator) => searchResAccess(env, "read", operator),
    res_access_write: (env, operator) => searchResAccess(env, "write", operator),
    res_access_create: (env, operator) => searchResAccess(env, "create", operator),
    res_access_unlink: (env, operator) => searchResAccess(env, "unlink", operator),
  },
  // mail_activity.py:557-561 `_compute_display_name`: the summary, else the activity type's display name
  displayName: async (env, ids) => {
    const rows = ids.length ? (await env.cr.query<{ id: number; summary: string | null; activity_type_id: number | null }>(
      "SELECT id, summary, activity_type_id FROM mail_activity WHERE id = ANY($1::int[])", [[...ids]])).rows : [];
    const typeIds = [...new Set(rows.filter((r) => !r.summary && r.activity_type_id !== null).map((r) => r.activity_type_id as number))];
    const typeNames = typeIds.length ? await env.model("mail.activity.type").displayName(typeIds) : new Map<number, string>();
    return new Map(rows.map((r) => [r.id, r.summary || (r.activity_type_id !== null ? typeNames.get(r.activity_type_id) ?? "" : "")]));
  },
});

/**
 * `activities.check_access(operation)` (models.py:3443-3461) for a non-superuser, as `create` ends with it
 * (models.py:4449): the activities outside the record rules raise mail.activity's own message
 * (mail_activity.py:303-318 `_make_access_error_message`, the rule domain not being FALSE).
 */
export async function checkActivityAccess(env: Environment, ids: readonly number[], operation: ActivityOperation): Promise<void> {
  if (env.su || ids.length === 0) return;
  const def = env.reg.model("mail.activity");
  await checkModelAccess(env, def, operation);
  const rows = (await env.cr.query<ActRow>(
    "SELECT id, res_model, res_id, user_id FROM mail_activity WHERE id = ANY($1::int[]) ORDER BY id", [[...ids]])).rows;
  const allowed = new Set(await filteredActivities(env, rows, operation));
  const inaccessible = ids.filter((id) => !allowed.has(id));
  if (inaccessible.length === 0) return;
  if ((await accessDomain(env, def, operation)).kind === "false") throw new NotPorted("mail.activity access error with a FALSE rule domain (base message)");
  const head = translate(env, "The requested operation cannot be completed due to security restrictions. Please contact your system administrator.", "base");
  throw new AccessError(`${head}\n\n(Document type: Activity, Operation: ${operation})\n\nRecords: ${(await import("./display_names")).formatList(env, inaccessible.slice(0, 6).map(String))}, User: ${env.uid}`);
}

/** MAX_COMODELS_FOR_DOMAIN (mail_message.py:31). */
const MAX_COMODELS_FOR_DOMAIN = 5;

/**
 * mail_message.py:487-561 `_search_res_access('read', 'in')` of mail.message (the access rule
 * `[('res_access_read', '=', True)]`, mail/security/ir.access.csv:3) for internal users and a search restricted to at
 * most MAX_COMODELS_FOR_DOMAIN document models: per model `res_id any! <readable documents>`, or'ed with the messages
 * the user wrote, created or received; without a model restriction the messages are filtered one by one
 * (`_filter_accessible_from_query`). Other operations and share users (SHARE_DOMAIN) refuse.
 */
async function searchMessageResAccess(env: Environment, operator: string): Promise<Domain> {
  if (!env.su) throw new Error("_search_res_access runs as superuser");
  if (operator !== "in") throw new NotPorted(`mail.message.res_access_read with operator ${operator} (NotImplemented)`);
  const def = env.reg.model("mail.message");
  const domain = searchDomainOf(env) ?? D.TRUE;
  const user = userEnv(env); // self.sudo(False)
  const internal = (await env.cr.query("SELECT 1 FROM res_users WHERE id = $1 AND share IS NOT TRUE", [env.uid])).rows.length > 0;
  if (!internal) throw new NotPorted("mail.message access of a share user (SHARE_DOMAIN)");
  const names = await conditionValues(user, def, "model", domain);
  if (names === null || names.length === 0 || names.length > MAX_COMODELS_FOR_DOMAIN) {
    // :500-504 `super()._search(domain, order='id')` (sudo) then `_filter_accessible_from_query(query, 'read')`
    const sudo = env.withContext({ ...env.context, active_test: false });
    const ids = await queryIds(await searchQuery(sudo, def, domain, { activeTest: false, order: "id", limit: MAX_SEARCH_LIMIT }));
    if (ids.length === MAX_SEARCH_LIMIT) throw new D.PyValueError("Cannot search, too many messages");
    return D.cond("id", "in", await accessibleMessages(user, ids));
  }
  let modelCodomains: Domain = D.FALSE;
  const coEnv = userEnv(env, { ...env.context, active_test: false });
  for (const name of names) {
    if (typeof name !== "string" || !env.reg.models.has(name)) continue;
    const comodel = env.reg.model(name);
    let codomain: Domain = D.cond("model", "=", comodel.name);
    const comodelResIds = await conditionValues(user, def, "res_id",
      D.mapConditions(domain, (c) => (c.path === "model" ? D.and([codomain, c]) : c)));
    let comodelDomain: Domain = D.FALSE;
    let remaining: Domain = D.TRUE;
    for (const [domainOperation0, docOperation] of await mailOperations(coEnv, comodel.name, "read")) {
      const domainOperation = D.and([remaining, domainOperation0]);
      remaining = D.and([remaining, D.not(domainOperation0)]);
      let comodelRule = await accessDomain(coEnv, comodel, docOperation);
      if (comodelRule.kind === "false") continue;
      if (docOperation === "read") comodelRule = D.TRUE; // covered by the search below
      comodelDomain = D.or([comodelDomain, D.and([domainOperation, comodelRule])]);
    }
    if (comodelResIds !== null) comodelDomain = D.and([comodelDomain, D.cond("id", "in", comodelResIds)]);
    comodelDomain = await optimizeFull(comodelDomain, comodel, coEnv.sudo());
    let query;
    try {
      query = await searchQuery(coEnv, comodel, comodelDomain, {});
    } catch (e) {
      if (e instanceof AccessError) continue;
      throw e;
    }
    if (query.isEmpty()) continue;
    codomain = D.and([codomain, D.cond("res_id", "any!", new D.SubQueryValue(query))]);
    modelCodomains = D.or([modelCodomains, codomain]);
  }
  const partner = (await env.cr.query<{ p: number }>("SELECT partner_id AS p FROM res_users WHERE id = $1", [env.uid])).rows[0]!.p;
  return D.and([domain, D.or([
    D.cond("author_id", "=", partner),
    D.cond("create_uid", "=", env.uid),
    D.cond("partner_ids", "in", [partner]),
    D.cond("partner_cc_ids", "in", [partner]),
    D.cond("notified_partner_ids", "in", [partner]),
    D.and([modelCodomains, D.cond("message_type", "!=", "user_notification")]),
  ])]);
}

/**
 * mail_message.py:568-702 `_filter_accessible_from_query(query, 'read')` for an internal user: the messages the user
 * wrote or created, those it received (partner_ids, partner_cc_ids or a notification), then those on documents it may
 * read (`_find_allowed_doc_ids`, user notifications excepted). Returns them in the given order.
 */
async function accessibleMessages(env: Environment, ids: readonly number[]): Promise<number[]> {
  if (!ids.length) return [];
  const partner = (await env.cr.query<{ p: number }>("SELECT partner_id AS p FROM res_users WHERE id = $1", [env.uid])).rows[0]!.p;
  const rows = (await env.cr.query<{ id: number; model: string | null; res_id: number | null; author_id: number | null; create_uid: number | null; message_type: string; notified: boolean }>(
    `SELECT m.id, m.model, m.res_id, m.author_id, m.create_uid, m.message_type,
            EXISTS (SELECT 1 FROM mail_message_res_partner_rel r WHERE r.mail_message_id = m.id AND r.res_partner_id = $2)
         OR EXISTS (SELECT 1 FROM mail_message_res_partner_cc_rel r WHERE r.mail_message_id = m.id AND r.res_partner_id = $2)
         OR EXISTS (SELECT 1 FROM mail_notification n WHERE n.mail_message_id = m.id AND n.res_partner_id = $2) AS notified
       FROM mail_message m WHERE m.id = ANY($1::int[])`, [[...ids], partner])).rows;
  const ok = new Set<number>();
  const docs = new Map<string, Map<number, number[]>>();
  for (const r of rows) {
    if (r.author_id === partner || r.create_uid === env.uid || r.notified) { ok.add(r.id); continue; }
    if (r.model && r.res_id && r.message_type !== "user_notification") {
      const d = docs.get(r.model) ?? new Map<number, number[]>();
      docs.set(r.model, d);
      d.set(r.res_id, [...(d.get(r.res_id) ?? []), r.id]);
    }
  }
  for (const id of await findAllowedDocIds(env, docs, "read")) ok.add(id);
  return ids.filter((id) => ok.has(id));
}

/**
 * `messages._filtered_access('read')` (models.py:3506-3540) for a non-superuser: the access domain evaluated on the
 * records (`filtered_domain` as superuser), where `res_access_read` is the compute `_compute_res_access('read')`
 * (mail_message.py:473-485: no model access gives False; otherwise `_filter_accessible_from_query` over the records,
 * the share domain being TRUE for internal users). Share users and the other `res_access_*` conditions refuse.
 * Returns the accessible ids in the given order.
 */
export async function filteredMessages(env: Environment, ids: readonly number[]): Promise<number[]> {
  if (env.su || ids.length === 0) return [...ids];
  const def = env.reg.model("mail.message");
  const domain = await accessDomain(env, def, "read");
  if (domain.kind === "false") return [];
  if (domain.kind === "true") return [...ids];
  let computed: Set<number> | null = null;
  for (const c of D.iterConditions(domain)) {
    if (!/^res_access_/.test(c.path)) continue;
    if (c.path !== "res_access_read") throw new NotPorted(`mail.message access rule on ${c.path}`);
    if (computed !== null) continue;
    let allowed = true;
    try {
      await checkModelAccess(env, def, "read"); // self.browse().sudo(False).has_access(operation)
    } catch (e) {
      if (!(e instanceof AccessError)) throw e;
      allowed = false;
    }
    if (allowed && !(await env.cr.query("SELECT 1 FROM res_users WHERE id = $1 AND share IS NOT TRUE", [env.uid])).rows.length) {
      throw new NotPorted("mail.message access of a share user (SHARE_DOMAIN)");
    }
    computed = new Set(allowed ? await accessibleMessages(userEnv(env), ids) : []);
  }
  const replaced = D.mapConditions(domain, (c) => {
    if (c.path !== "res_access_read" || computed === null) return c;
    const v = c.value;
    const wantsTrue = (c.op === "=" && v === true) || (c.op === "in" && Array.isArray(v) && v.length === 1 && v[0] === true);
    if (!wantsTrue) throw new NotPorted(`mail.message access rule condition ${D.pyRepr(c.op)} on ${c.path}`);
    return D.cond("id", "in", [...computed]);
  });
  const sudo = env.sudo().withContext({ ...env.context, active_test: false });
  const ok = new Set(await queryIds(await searchQuery(sudo, def, D.and([D.cond("id", "in", [...ids]), replaced]), { activeTest: false })));
  return ids.filter((id) => ok.has(id));
}

/**
 * mail_message.py:447-471, the batched branch of `_search` (a limit and no restriction to at most
 * MAX_COMODELS_FOR_DOMAIN document models): the matching messages fetched as superuser IN_MAX at a time in the given
 * order (`model nulls first, id` without one), each batch filtered by `_filtered_access('read')`, until `offset +
 * limit` are accessible; the slice `[offset:offset + limit]` in that order.
 */
export async function messageSearchBatched(env: Environment, domain: Domain, offset: number, limit: number, order: string | null): Promise<number[]> {
  const def = env.reg.model("mail.message");
  const sudo = env.sudo();
  const ord = order || "model nulls first, id";
  const end = limit + offset;
  const result: number[] = [];
  let looping = 0;
  while (result.length < end) {
    const batch = await queryIds(await searchQuery(sudo, def, domain, { offset: looping, limit: 1000, order: ord }));
    result.push(...await filteredMessages(userEnv(env), batch));
    if (batch.length < 1000) break;
    looping += 1000;
  }
  return result.slice(offset, end);
}

/**
 * mail_message.py:386-392 `_search_needaction`: the messages with a notification of the user's partner, unread for
 * `in` and read for `not in` (the notifications searched in the same environment, so with their access rules).
 */
async function searchNeedaction(env: Environment, operator: string): Promise<Domain | null> {
  if (operator !== "in" && operator !== "not in") return null;
  const partner = (await env.cr.query<{ p: number }>("SELECT partner_id AS p FROM res_users WHERE id = $1", [env.uid])).rows[0]!.p;
  const query = await searchQuery(env, env.reg.model("mail.notification"),
    D.and([D.cond("res_partner_id", "=", partner), D.cond("is_read", "=", operator === "not in")]), {});
  // `('notification_ids', 'in', <Query>)` becomes `any!` (domains.py:1371-1386, :1408-1414)
  return D.cond("notification_ids", "any!", new D.SubQueryValue(query));
}

registerHooks("mail.message", {
  search: {
    res_access_read: (env, operator) => searchMessageResAccess(env, operator),
    needaction: (env, operator) => searchNeedaction(env, operator),
  },
  // mail_message.py:733-745: a rule domain that is not FALSE gives mail.message's own message, the ids through
  // `_()`'s list formatting (tools/translate.py:1002-1005 format_list)
  accessErrorMessage: async (env, ids, operation, domain) => {
    if (domain.kind === "false") return null;
    const head = translate(env, "The requested operation cannot be completed due to security restrictions. Please contact your system administrator.", "base");
    return new AccessError(`${head}\n\n(Document type: Message, Operation: ${operation})\n\nRecords: ${(await import("./display_names")).formatList(env, ids.slice(0, 6).map(String))}, User: ${env.uid}`);
  },
});

registerOverrides("mail.activity", {
  // models.py `_write` at flush: Odoo recomputes the related `res_model` (mail_activity.py:62) before it flushes, so
  // res_model_id, res_id and res_model go in one UPDATE and `_check_res_id_is_set_if_model` (:142-146) holds; the
  // port's recompute would update res_model after (the chart loader's delayed res_model_id/res_id, account_demo.py:524)
  write: async (env, ids, vals, next) => {
    if (!("res_model_id" in vals) || "res_model" in vals) { await next(env, ids, vals); return; }
    const modelId = vals["res_model_id"];
    const name = typeof modelId === "number" && modelId
      ? (await env.cr.query<{ model: string }>("SELECT model FROM ir_model WHERE id = $1", [modelId])).rows[0]?.model ?? false : false;
    await next(env, ids, { ...vals, res_model: name });
  },
});
