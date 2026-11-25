/**
 * ir.attachment access for a non-superuser (odoo/odoo/addons/base/models/ir_attachment.py):
 *  - `_compute_res_access(operation)` (:672-722) with `_inaccessible_comodel_records` (:785-813): an attachment is
 *    accessible when the user may `operation` its record (and, unless system user, read/write its field), or when it
 *    has no record and the user created it (or is a system user);
 *  - `_search_res_access(operation, 'in')` (:724-783), the search method of `res_access_read`/`res_access_write`,
 *    from the searched domain (`search_domain`, src/orm/sql.ts searchDomainOf);
 *  - `_search` (:817-860): `res_field = False` unless the domain names `id` or `res_field` (or the context sets
 *    `skip_res_field_check`); without a small `res_model` restriction the readable attachments are filtered in Python.
 * `_filtered_access(operation)` (models.py:3539-3563) evaluates the access domain on the records, where the
 * `res_access_*` conditions are the compute's values.
 */
import { AccessError, NotPorted } from "../errors";
import { accessDomain, checkModelAccess } from "../orm/access";
import * as D from "../orm/domain";
import { registerHooks } from "../orm/hooks";
import { hasFieldAccess, optimizeFull, queryIds, searchDomainOf, searchQuery } from "../orm/sql";
import type { Domain, Environment, FieldDef } from "../orm/types";
import { userHasGroup } from "../web/groups";
import { conditionValues } from "./mail_activity_access";
import { translate } from "./util";

/** ir_attachment.py:42-43 */
const MAX_COMODELS_FOR_DOMAIN = 5;
const MAX_SEARCH_LIMIT = 1000 * 10;
type Operation = "read" | "write";
interface AttRow { id: number; res_model: string | null; res_id: number | null; res_field: string | null; create_uid: number | null }

/** `env.is_system()` (environments.py:187-190, res_users.py:1288-1290). */
export async function isSystem(env: Environment): Promise<boolean> {
  return env.su || userHasGroup(env.sudo(), "base.group_system");
}

/** models whose `_has_field_access` is overridden (res_users.py:652, hr_employee.py:508, project_task.py:1093) */
const FIELD_ACCESS_OVERRIDES = new Set(["res.users", "hr.employee", "project.task"]);

/** `user_model.has_field_access(field, operation)` (models.py:2703-2734): the field's groups, for read and write. */
export async function fieldAccess(env: Environment, model: string, field: FieldDef): Promise<boolean> {
  if (FIELD_ACCESS_OVERRIDES.has(model)) throw new NotPorted(`${model}._has_field_access override (attachment res_field access)`);
  return hasFieldAccess(env, field);
}

/** `records._filtered_access(operation)` of a model without `_check_access` override (models.py:3539-3563). */
async function filteredAccess(env: Environment, model: string, ids: readonly number[], operation: Operation): Promise<number[]> {
  if (env.su || ids.length === 0) return [...ids];
  if (model === "ir.attachment") return filteredAttachments(env, ids, operation);
  const def = env.reg.model(model);
  const domain = await accessDomain(env, def, operation);
  if (domain.kind === "false") return [];
  if (domain.kind === "true") return [...ids];
  const ok = new Set(await queryIds(await searchQuery(env, def, D.cond("id", "in", [...ids]), { activeTest: false, secDomain: domain })));
  return ids.filter((id) => ok.has(id));
}

/** `_compute_res_access(operation)` (:672-722) for a non-superuser environment: the accessible attachment ids. */
async function resAccess(env: Environment, atts: readonly AttRow[], operation: Operation): Promise<Set<number>> {
  // Odoo's ORM field-compute re-entrancy guard (fields.py): while `res_access_<op>` is being computed for a batch
  // of attachments, a nested check on any id in that batch sees the Boolean default (False) instead of re-entering
  // `_compute_res_access` (preventing cycles and matching Odoo's batch semantics for attachment-on-attachment rows).
  const key = `ir_attachment.res_access_${operation}.computing`;
  let computing = env.cache.get(key) as Set<number> | undefined;
  if (!computing) { computing = new Set<number>(); env.cache.set(key, computing); }
  const system = await isSystem(env);
  const forbidden = new Set<number>();
  const modelIds = new Map<string, Set<number>>();
  const attModel: [number, string, number][] = [];
  const added: number[] = [];
  for (const a of atts) {
    if (computing.has(a.id)) { forbidden.add(a.id); continue; }
    computing.add(a.id);
    added.push(a.id);
  }
  try {
    for (const a of atts) {
      if (forbidden.has(a.id)) continue;
      if (!system) {
        if (!a.res_id && a.create_uid !== env.uid) { forbidden.add(a.id); continue; }
        if (a.res_field) {
          const field = a.res_model && env.reg.models.has(a.res_model) ? env.reg.model(a.res_model).fields.get(a.res_field) : undefined;
          if (field === undefined || !(await fieldAccess(env, a.res_model!, field))) { forbidden.add(a.id); continue; }
        }
      }
      if (a.res_model && a.res_id) {
        const set = modelIds.get(a.res_model) ?? new Set<number>();
        modelIds.set(a.res_model, set);
        set.add(a.res_id);
        attModel.push([a.id, a.res_model, a.res_id]);
      }
    }
    const inaccessible = await inaccessibleComodelRecords(env, modelIds, operation);
    for (const [att, model, id] of attModel) if (inaccessible.has(`${model},${id}`)) forbidden.add(att);
    return new Set(atts.map((a) => a.id).filter((id) => !forbidden.has(id)));
  } finally {
    for (const id of added) computing.delete(id);
  }
}

/** `_inaccessible_comodel_records(model_and_ids, operation)` (:787-814): the `model,id` keys the user may not access. */
export async function inaccessibleComodelRecords(env: Environment, modelIds: ReadonlyMap<string, ReadonlySet<number>>, operation: Operation): Promise<Set<string>> {
  const inaccessible = new Set<string>();
  if (env.su) return inaccessible;
  for (const [model, idsSet] of modelIds) {
    const ids = [...idsSet].filter(Boolean);
    if (!model || !ids.length) continue;
    if (!env.reg.models.has(model)) { for (const id of ids) inaccessible.add(`${model},${id}`); continue; }
    if (model === "res.users" && ids.length === 1 && ids[0] === env.uid) continue;
    const def = env.reg.model(model);
    // records.exists() on MissingError: the existing ones are checked, the missing ones stay forbidden
    const existing = (await env.cr.query<{ id: number }>(`SELECT id FROM "${def.table}" WHERE id = ANY($1::int[])`, [ids])).rows.map((r) => r.id);
    const ok = new Set(await filteredAccess(env, model, existing, operation));
    for (const id of ids) if (!ok.has(id)) inaccessible.add(`${model},${id}`);
  }
  return inaccessible;
}

async function rowsOf(env: Environment, ids: readonly number[]): Promise<AttRow[]> {
  if (!ids.length) return [];
  return (await env.cr.query<AttRow>("SELECT id, res_model, res_id, res_field, create_uid FROM ir_attachment WHERE id = ANY($1::int[]) ORDER BY id", [[...ids]])).rows;
}

/** `attachments._filtered_access(operation)` for a non-superuser. */
async function filteredAttachments(env: Environment, ids: readonly number[], operation: Operation): Promise<number[]> {
  const def = env.reg.model("ir.attachment");
  const domain = await accessDomain(env, def, operation);
  if (domain.kind === "false" || ids.length === 0) return [];
  const atts = await rowsOf(env, ids);
  const computed = new Map<string, Set<number>>();
  for (const c of D.iterConditions(domain)) {
    const m = /^res_access_(read|write)$/.exec(c.path);
    if (m && !computed.has(c.path)) computed.set(c.path, await resAccess(env, atts, m[1] as Operation));
  }
  const replaced = D.mapConditions(domain, (c) => {
    const set = computed.get(c.path);
    if (set === undefined) return c;
    const v = c.value;
    const wantsTrue = (c.op === "=" && v === true) || (c.op === "in" && Array.isArray(v) && v.length === 1 && v[0] === true);
    if (!wantsTrue) throw new NotPorted(`ir.attachment access rule condition ${D.pyRepr(c.op)} on ${c.path}`);
    return D.cond("id", "in", [...set]);
  });
  const sudo = env.sudo().withContext({ ...env.context, active_test: false });
  const ok = new Set(await queryIds(await searchQuery(sudo, def, D.and([D.cond("id", "in", [...ids]), replaced]), { activeTest: false })));
  return ids.filter((id) => ok.has(id));
}

/** `attachment.has_access(operation)` (models.py `has_access` = `_check_access` returns None): model access, then
 *  `_filtered_access` (ir_attachment.py:654-700) for a non-superuser. */
export async function attachmentHasAccess(env: Environment, id: number, operation: Operation): Promise<boolean> {
  if (env.su) return true;
  try {
    await checkModelAccess(env, env.reg.model("ir.attachment"), operation);
  } catch (e) {
    if (e instanceof AccessError) return false;
    throw e;
  }
  return (await filteredAttachments(env, [id], operation)).length === 1;
}

/** ir_attachment.py:724-783 `_search_res_access(operation, domain_operator)`. */
async function searchResAccess(env: Environment, operation: Operation, operator: string): Promise<Domain> {
  if (!env.su) throw new Error("_search_res_access runs as superuser");
  if (operator !== "in") throw new NotPorted(`ir.attachment.res_access_${operation} with operator ${operator} (NotImplemented)`);
  const def = env.reg.model("ir.attachment");
  const domain = searchDomainOf(env) ?? D.TRUE;
  let secDomain: Domain = D.FALSE;
  const user = env.withUser(env.uid); // self.sudo(False)
  const system = await isSystem(user);

  // - res_id == False needs to be system user or creator
  const resIds = await conditionValues(user, def, "res_id", domain);
  if (!resIds || resIds.length === 0 || resIds.some((v) => v === false)) {
    secDomain = D.or([secDomain, system
      ? D.cond("res_id", "=", false)
      : D.and([D.cond("res_id", "=", false), D.cond("create_uid", "=", user.uid)])]);
  }
  const resModelNames = await conditionValues(user, def, "res_model", domain);
  const count = resModelNames?.length ?? 0;
  if (count > 0 && count <= MAX_COMODELS_FOR_DOMAIN) {
    const coEnv = user.withContext({ ...user.context, active_test: false });
    const resFields = await conditionValues(user, def, "res_field", domain);
    const checkResFields = !system && !(resFields !== null && resFields.length === 1 && resFields[0] === false);
    for (const name of resModelNames ?? []) {
      if (typeof name !== "string" || !env.reg.models.has(name)) continue;
      const comodel = env.reg.model(name);
      let codomain: Domain = D.cond("res_model", "=", comodel.name);
      const comodelResIds = await conditionValues(user, def, "res_id",
        D.mapConditions(domain, (c) => (c.path === "res_model" ? D.and([codomain, c]) : c)));
      let comodelDomain: Domain = comodelResIds && comodelResIds.length ? D.cond("id", "in", comodelResIds) : D.TRUE;
      if (operation !== "read") {
        comodelDomain = D.and([comodelDomain, await optimizeFull(await accessDomain(coEnv, comodel, operation), comodel, coEnv.sudo())]);
      }
      let query;
      try {
        query = await searchQuery(coEnv, comodel, await optimizeFull(comodelDomain, comodel, coEnv), {});
      } catch (e) {
        if (e instanceof AccessError) continue;
        throw e;
      }
      if (query.isEmpty()) continue;
      codomain = D.and([codomain, D.cond("res_id", "any!", new D.SubQueryValue(query))]); // `res_id in <query>`
      if (checkResFields) {
        const accessible: unknown[] = [];
        for (const field of comodel.fields.values()) {
          const relevant = field.type === "binary" || field.type === "image"
            || ((field.type === "many2one" || field.type === "one2many" || field.type === "many2many") && field.relation === "ir.attachment");
          if (relevant && await fieldAccess(coEnv, comodel.name, field)) accessible.push(field.name);
        }
        accessible.push(false);
        codomain = D.and([codomain, D.cond("res_field", "in", accessible)]);
      }
      secDomain = D.or([secDomain, codomain]);
    }
    return secDomain;
  }
  // :775-783 no small res_model restriction: the readable records among the others, filtered in Python
  const sudo = env.withContext({ ...env.context, active_test: false });
  const ids = await queryIds(await searchQuery(sudo, def,
    D.and([domain, D.cond("res_model", "!=", false), D.not(secDomain)]), { activeTest: false, order: "id", limit: MAX_SEARCH_LIMIT }));
  if (ids.length === MAX_SEARCH_LIMIT) throw new D.PyValueError("Cannot search, too many attachments");
  const allowed = await filteredAttachments(user, ids, operation);
  return D.or([secDomain, D.cond("id", "in", allowed)]);
}

registerHooks("ir.attachment", {
  // ir_attachment.py:658-669 `_make_access_error_message`: a rule domain that is not FALSE gives the attachment's message
  accessErrorMessage: async (env, ids, operation, domain) => {
    if (domain.kind === "false") return null;
    const recs = (await import("./display_names")).formatList(env, ids.slice(0, 6).map((id) => `ir.attachment(${id},)`));
    const head = translate(env, "Sorry, you are not allowed to access this document. Please contact your system administrator.", "base");
    return new AccessError(`${head}\n\n(Operation: ${operation})\n\nRecords: ${recs}, User: ${env.uid}`);
  },
  search: {
    res_access_read: (env, operator) => searchResAccess(env, "read", operator),
    res_access_write: (env, operator) => searchResAccess(env, "write", operator),
  },
  searchOverride: async (env, domain0, next) => {
    let domain = domain0;
    const names = [...D.iterConditions(domain)].map((c) => c.path);
    // `bypass_access` is not visible here: Model.search never bypasses (searchQuery callers that do skip this hook)
    if (!env.context["skip_res_field_check"] && !names.some((n) => n === "id" || n === "res_field")) {
      domain = D.and([domain, D.cond("res_field", "=", false)]);
    }
    const def = env.reg.model("ir.attachment");
    const optimized = await optimizeFull(domain, def, env);
    if (env.su || optimized.kind === "false") return next(domain);
    if (env.context["_generating_sql_for_fields"]) throw new D.PyValueError("Cannot generate SQL for whole ir.attachment");
    const models = await conditionValues(env, def, "res_model", optimized);
    if (models !== null && models.length > 0 && models.length <= MAX_COMODELS_FOR_DOMAIN) return next(domain);
    // :836-860: the read access domain where SQL can express it, then `_filtered_access('read')` on the records
    const system = await isSystem(env);
    const toSql = D.mapConditions(await accessDomain(env, def, "read"), (c) => {
      if (c.path === "res_access_read" || c.path === "res_access_write") {
        const v = c.value;
        const onlyTrue = (c.op === "=" && v === true) || (c.op === "in" && Array.isArray(v) && v.length === 1 && v[0] === true);
        if (onlyTrue && !system) return D.or([D.cond("res_id", "!=", false), D.cond("create_uid", "=", env.uid)]);
        return D.TRUE;
      }
      return c;
    });
    const sudo = env.sudo().withContext({ ...env.context, active_test: false });
    const candidates = await queryIds(await searchQuery(sudo, def, D.and([optimized, toSql]), { activeTest: false }));
    const allowed = await filteredAttachments(env, candidates, "read");
    // the caller's order, offset and limit apply to the readable records
    return next(D.and([domain, D.cond("id", "in", allowed)]));
  },
});

