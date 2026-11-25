/**
 * User groups and access as the view postprocessing and fields_get need them:
 * `res.users._get_group_ids` (res_users.py:1228: `all_group_ids`, i.e. the direct groups plus the implied closure
 * of res_groups_implied_rel), `has_group`/`has_groups` (res_users.py:1163-1226, `base.group_no_one` only in debug),
 * `ir.access._get_groups_with_access` (ir_access.py:349) and `has_access` on the empty recordset (models.py:3464).
 */
import type { Domain, Environment } from "../orm/types";
import { accessDomain } from "../orm/access";
import { and, or, not } from "../orm/domain";
import { optimizeFull } from "../orm/sql";
import { impliedGroups, userDirectGroups } from "../orm/env";

const CACHE_GROUPS = "web.groups.user_group_ids";

/** `_get_group_ids()` of the environment's user: direct groups and every group they imply, transitively. */
export async function userGroupIds(env: Environment): Promise<ReadonlySet<number>> {
  const key = `${CACHE_GROUPS}:${env.uid}`;
  const cached = env.cache.get(key);
  if (cached instanceof Set) return cached as ReadonlySet<number>;
  // the registry's ormcache of `_get_group_ids` (src/orm/signaling.ts), shared with src/orm/env.ts userInfo
  const direct = await userDirectGroups(env, env.uid);
  const impliedBy = await impliedGroups(env);
  const all = new Set<number>();
  const stack = [...direct];
  while (stack.length > 0) {
    const g = stack.pop();
    if (g === undefined || all.has(g)) continue;
    all.add(g);
    for (const h of impliedBy.get(g) ?? []) stack.push(h);
  }
  env.cache.set(key, all);
  return all;
}

/** `res.groups._get_group_definitions().get_id(xmlid)`: the group id of an xmlid, null when unknown. */
export async function groupId(env: Environment, xmlid: string): Promise<number | null> {
  return env.reg.xmlid(env.cr, xmlid);
}

/** `user.has_group(xmlid)` (res_users.py:1195): membership, and for base.group_no_one only in debug mode. */
export async function userHasGroup(env: Environment, xmlid: string): Promise<boolean> {
  const id = await groupId(env, xmlid.trim());
  if (id === null) return false;
  const member = (await userGroupIds(env)).has(id);
  if (xmlid.trim() === "base.group_no_one") return member && env.debug;
  return member;
}

/** `user.has_groups("a,b,!c")` (res_users.py:1163): no negative member, and a positive member (or no positives). */
export async function userHasGroups(env: Environment, spec: string): Promise<boolean> {
  if (spec === ".") return false;
  const positives: string[] = [];
  const negatives: string[] = [];
  for (const raw of spec.split(",")) {
    const ext = raw.trim();
    if (ext.startsWith("!")) negatives.push(ext.slice(1));
    else positives.push(ext);
  }
  for (const n of negatives) if (await userHasGroup(env, n)) return false;
  for (const p of positives) if (await userHasGroup(env, p)) return true;
  return positives.length === 0;
}

/**
 * Whether the user is in the set `GroupDefinitions.parse(groups)` denotes (set_expression.py:104): the union over
 * the positive refs of (ref AND NOT every negative ref); with no positive ref, the intersection of the negations.
 * Unknown refs are `Leaf(UnknownId)` and never match. Unlike `has_group`, `base.group_no_one` is a plain group here:
 * the view code strips it beforehand into `__debug__` (ir_ui_view.py:1406 _postprocess_debug_to_cache).
 */
export async function userInGroupExpression(env: Environment, groups: string): Promise<boolean> {
  const ids = await userGroupIds(env);
  const positives: string[] = [];
  const negatives: string[] = [];
  for (const raw of groups.split(",")) {
    const ext = raw.trim();
    if (ext === "") continue;
    if (ext.startsWith("!")) negatives.push(ext.slice(1));
    else positives.push(ext);
  }
  const member = async (ref: string): Promise<boolean> => {
    if (ref === "*") return true;
    const id = await groupId(env, ref);
    return id !== null && ids.has(id);
  };
  for (const n of negatives) if (await member(n)) return false;
  if (positives.length === 0) return true;
  for (const p of positives) if (await member(p)) return true;
  return false;
}

const OP_LETTER: Readonly<Record<"read" | "write" | "create" | "unlink", string>> = { read: "r", write: "u", create: "c", unlink: "d" };

/**
 * `ir.access._get_groups_with_access(model, operation)` (ir_access.py:349-380) reduced to the current user: the
 * groups that have an access row for the model (global rows do not count, :358), expanded to the groups implying
 * them (:374 `all_implied_by_ids`), contain one of the user's groups iff one row's group is in the user's closure.
 * Rows whose domain carries an 'access' condition are kept conservatively (Odoo evaluates the condition, :360-380).
 */
export async function userInModelAccessGroups(env: Environment, model: string, operation: "read" | "write" | "create" | "unlink"): Promise<boolean> {
  const ids = await userGroupIds(env);
  const res = await env.cr.query<{ group_id: number }>(
    `SELECT a.group_id FROM ir_access a JOIN ir_model m ON m.id = a.model_id
      WHERE m.model = $1 AND a.active AND a.group_id IS NOT NULL AND a.operation LIKE $2`,
    [model, `%${OP_LETTER[operation]}%`],
  );
  return res.rows.some((r) => ids.has(r.group_id));
}

/** `model.has_access(operation)` on the empty recordset (models.py:3464-3489): the model-level permission. */
export async function hasModelAccess(env: Environment, model: string, operation: "read" | "write" | "create" | "unlink"): Promise<boolean> {
  if (env.su) return true;
  // models.py:3480 maps only 'access' conditions. It does not construct the
  // translated exception used by check_access when the operation is denied.
  const def=env.reg.model(model);
  const resolve=async (domain:Domain):Promise<Domain>=>{
    switch(domain.kind) {
      case 'and': return and(await Promise.all(domain.args.map(resolve)));
      case 'or': return or(await Promise.all(domain.args.map(resolve)));
      case 'not': return not(await resolve(domain.arg));
      case 'cond': return domain.op==='access' ? optimizeFull(domain,def,env.sudo()) : domain;
      default: return domain;
    }
  };
  return (await resolve(await accessDomain(env,def,operation))).kind!=='false';
}
