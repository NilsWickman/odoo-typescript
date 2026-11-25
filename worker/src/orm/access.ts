/** Odoo 20 ir.access and BaseModel._access_domain (models.py:3603-3650). */
import { AccessError, NotPorted } from "../errors";
import * as D from "./domain";
import { envCache, groupsImplying, userInfo, type UserInfo } from "./env";
import { accessRows, type AccessRow } from "../session/user";
import { codeTranslation } from "./code_translations";
import { evalPyExpr, parsePyExpr } from "./pyexpr";
import type { Domain, Environment, ModelDef } from "./types";

export type Operation = "read" | "write" | "create" | "unlink";
const LETTER = { read: "r", write: "u", create: "c", unlink: "d" };

function rows(env: Environment): Promise<readonly AccessRow[]> {
  // ir.access rows are read through an ormcache of the stable container (ir_access.py:282): src/session/user.ts
  return envCache(env, "orm.access.rows", () => accessRows(env.cr));
}

async function accessEvalValues(env: Environment, user: UserInfo): Promise<Record<string, unknown>> {
  return {
    "user.id": user.id, "user.ids": [user.id], "user.partner_id.id": user.partnerId,
    "user.commercial_partner_id.id": user.commercialPartnerId,
    "user.partner_id.commercial_partner_id.id": user.commercialPartnerId,
    "user.all_group_ids.ids": user.groupIds,
    "user.company_id.id": user.companyId, "user.company_ids.ids": user.companyIds,
    "user.share": user.share,
    company_ids: await env.companies(), company_id: await env.company(),
  };
}

export async function accessDomain(env: Environment, model: ModelDef, operation: Operation): Promise<Domain> {
  if (env.su) return D.TRUE;
  const user = await userInfo(env);
  const values = await accessEvalValues(env, user);
  const permissions: Domain[] = [];
  const restrictions: Domain[] = [];
  for (const row of await rows(env)) {
    if (row.model !== model.name || !row.operation.includes(LETTER[operation])) continue;
    if (row.group_id !== null && !user.groupIds.includes(row.group_id)) continue;
    const domain = row.domain?.trim() ? D.parseDomain(evalPyExpr(parsePyExpr(row.domain), path => {
      const name = path.join(".");
      if (!(name in values)) throw new NotPorted(`ir.access evaluation: ${name}`);
      return values[name];
    }), true) : D.TRUE;
    (row.group_id === null ? restrictions : permissions).push(domain);
  }
  if (model.checkInheritsAccess) {
    for (const [parent, link] of model.inherits) {
      const domain = await accessDomain(env, env.reg.model(parent), operation);
      if (domain.kind === "false") return D.FALSE;
      restrictions.push(D.cond(link, "any", domain));
    }
  }
  return D.and([D.or(permissions), D.and(restrictions)]);
}

/**
 * ir_access.py:496-539 `_get_failed_accesses` reduced to what `_make_record_access_error` (:445) uses: whether a
 * failing access's domain text mentions `company_id`. Group permissions fail together when OR-ed they filter out
 * some of the records; restrictions (no group) fail individually. Parent-model domains are ignored as in Odoo (FIXME
 * :537). `filtered` returns how many of the records match a domain (filtered_domain, sudo, active_test=False).
 */
export async function failingAccessCompanyRelated(env: Environment, model: ModelDef, operation: Operation,
  filtered: (domain: Domain) => Promise<number>, count: number): Promise<boolean> {
  const user = await userInfo(env);
  const values = await accessEvalValues(env, user);
  const evalDomain = (row: AccessRow): Domain => row.domain?.trim() ? D.parseDomain(evalPyExpr(parsePyExpr(row.domain), path => {
    const name = path.join(".");
    if (!(name in values)) throw new NotPorted(`ir.access evaluation: ${name}`);
    return values[name];
  }), true) : D.TRUE;
  const accesses = (await rows(env)).filter((r) => r.model === model.name && r.operation.includes(LETTER[operation]));
  const permissions = accesses.filter((r) => r.group_id !== null && user.groupIds.includes(r.group_id));
  const permissionsFail = (await filtered(D.or(permissions.map(evalDomain)))) !== count;
  for (const access of accesses) {
    const failing = access.group_id !== null
      ? permissionsFail && user.groupIds.includes(access.group_id)
      : (await filtered(evalDomain(access))) < count;
    if (failing && (access.domain ?? "").includes("company_id")) return true;
  }
  return false;
}

export async function checkModelAccess(env: Environment, model: ModelDef, operation: Operation): Promise<void> {
  if ((await accessDomain(env, model, operation)).kind !== "false") return;
  // ir_access.py:326-347 `_make_model_access_error`: the texts are base's `_()` in the environment's language, the
  // model's name is `ir.model.name` in that language
  const lang = env.lang ?? "en_US";
  const tr = (source: string): string => {
    if (lang === "en_US") return source;
    const t = codeTranslation(lang, "base", source);
    if (t === null) throw new NotPorted(`translated ir.access error (${lang}: no .po table)`);
    return t;
  };
  const kind = lang === "en_US" ? model.description : model.descriptions[lang];
  if (kind === undefined) throw new NotPorted(`translated ir.access error (${lang}: model name of ${model.name})`);
  const groups = await groupsWithAccess(env, model, operation);
  const names = await env.sudo().model("res.groups").displayName(groups);
  const info = groups.length
    ? tr("This operation is allowed for the following groups:\n%(groups_list)s").split("%(groups_list)s").join(groups.map(id => `\t- ${names.get(id)}`).join("\n"))
    : tr("No group currently allows this operation.");
  const verb = { read: "access", write: "modify", create: "create", unlink: "delete" }[operation];
  const head = tr(`You are not allowed to ${verb} '%(document_kind)s' (%(document_model)s) records.`)
    .split("%(document_kind)s").join(kind).split("%(document_model)s").join(model.name);
  throw new AccessError(`${head}\n\n${info}\n\n${tr("Contact your administrator to request access if necessary.")}`);
}

/**
 * ir_access.py:349 _get_groups_with_access: per access row (by id) with a group, the group and then the groups
 * implying it (`all_implied_by_ids` = [g] + sorted(subsets), res_groups.py:362), in order of first appearance;
 * intersected with the parents' groups for `_inherits` models.
 */
async function groupsWithAccess(env: Environment, model: ModelDef, operation: Operation): Promise<number[]> {
  const out: number[] = [];
  for (const r of await rows(env)) {
    if (r.model !== model.name || !r.operation.includes(LETTER[operation]) || r.group_id === null) continue;
    if (r.domain && /['"]access['"]/.test(r.domain)) throw new NotPorted(`ir.access 'access' conditions in the error message (${model.name})`);
    const implying = [...await groupsImplying(env, [r.group_id])].filter((g) => g !== r.group_id).sort((a, b) => a - b);
    for (const g of [r.group_id, ...implying]) if (!out.includes(g)) out.push(g);
  }
  let result = out;
  for (const parent of model.inherits.keys()) {
    const p = new Set(await groupsWithAccess(env, env.reg.model(parent), operation));
    result = result.filter((g) => p.has(g));
  }
  // ir_access.py:408 `groups.sorted()`: res.groups _order 'privilege_id, sequence, name, id' (res_groups.py:19), the
  // many2one by res.groups.privilege _order 'sequence, name, id' (res_groups_privilege.py:7), NULLs last
  if (!result.length) return result;
  const lang = env.lang ?? "en_US";
  return (await env.cr.query<{ id: number }>(
    `SELECT g.id FROM res_groups g LEFT JOIN res_groups_privilege p ON p.id = g.privilege_id WHERE g.id = ANY($1::int[])
     ORDER BY p.sequence, COALESCE(p.name->>$2, p.name->>'en_US'), p.id, g.sequence, COALESCE(g.name->>$2, g.name->>'en_US'), g.id`,
    [result, lang])).rows.map((r) => r.id);
}
