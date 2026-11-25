/**
 * `odoo/odoo/orm/environments.py` Environment: registry, cursor, user, context, superuser flag, and the
 * per-request cache shared by every environment derived from the same request (Odoo's transaction cache).
 * The user data the ORM needs (companies, groups with their implied closure, partner) is read from res_users,
 * res_company_users_rel, res_groups_users_rel and res_groups_implied_rel (res_users.py:823, :1228; res_groups.py:342).
 */
import type { Cursor } from "../db";
import { AccessError, NotPorted, UserError } from "../errors";
import { ModelImpl } from "./model";
import { ensureRegistryLang, getRegistry } from "./registry";
import { preloadTableSql } from "./table_sql";
import type { Context, Environment, Model, Registry } from "./types";
import { isPyFloat } from "./values";
import { activeLangRows, registryCached } from "./signaling";
import { directGroupIds, fetchUser, impliedClosure, impliedGroupMap, userActiveCompanyIds, warmRequest } from "../session/user";

export interface EnvironmentOptions {
  readonly cr: Cursor;
  readonly uid: number;
  readonly context?: Context;
  /** `env.su` (environments.py:180). */
  readonly su?: boolean;
  /** `request.session.debug` non-empty (res_users.py:1210). */
  readonly debug?: boolean;
}

/**
 * A registry loaded again in the middle of a transaction (a custom field or model created, B4: Odoo sets the models up
 * again in the registry every environment of the process shares, ir_model.py:1206-1212): every environment on the
 * cursor reads it from then on (a data file's next record sees the new field). `anyReload` keeps the common path to a
 * single test.
 */
const RELOADED = new WeakMap<object, Registry>();
let anyReload = false;
export async function reloadRegistryOf(cr: Cursor, lang?: string | null): Promise<Registry> {
  const reg = await getRegistry(cr);
  if (typeof lang === "string" && lang !== "" && lang !== "en_US") await ensureRegistryLang(cr, reg, lang);
  await preloadTableSql(cr);
  anyReload = true;
  RELOADED.set(cr, reg);
  return reg;
}

/** `createEnvironment` loads the registry on first use of a database (lazy, cached: registry.ts). */
export async function createEnvironment(opts: EnvironmentOptions): Promise<Environment> {
  warmRequest(opts.cr, opts.uid);
  const reg = await getRegistry(opts.cr);
  const lang = opts.context?.lang;
  if (typeof lang === "string" && lang !== "" && lang !== "en_US") await ensureRegistryLang(opts.cr, reg, lang);
  await preloadTableSql(opts.cr); // query-backed models (src/orm/table_sql.ts)
  return new Env(reg, opts.cr, opts.uid, opts.context ?? {}, opts.su ?? false, opts.debug ?? false, new Map());
}

class Env implements Environment {
  private readonly baseReg: Registry;
  get reg(): Registry {
    if (anyReload) {
      const r = RELOADED.get(this.cr);
      if (r !== undefined) return r;
    }
    return this.baseReg;
  }
  readonly cr: Cursor;
  readonly uid: number;
  readonly context: Context;
  readonly su: boolean;
  readonly debug: boolean;
  readonly cache: Map<string, unknown>;

  constructor(reg: Registry, cr: Cursor, uid: number, context: Context, su: boolean, debug: boolean, cache: Map<string, unknown>) {
    this.baseReg = reg;
    this.cr = cr;
    this.uid = uid;
    this.context = context;
    this.su = su;
    this.debug = debug;
    this.cache = cache;
  }

  /** environments.py:326: `context['lang'] or None`; the validity check needs the database (see `checkLang`). */
  get lang(): string | null {
    const lang = this.context.lang;
    return typeof lang === "string" && lang !== "" ? lang : null;
  }

  async companies(): Promise<readonly number[]> {
    // environments.py:286-303
    const allowed = allowedCompanyIds(this.context, this.su);
    const user = await userInfo(this);
    if (allowed.length > 0) {
      if (!this.su && allowed.some((cid) => !user.companyIds.includes(cid))) {
        throw new AccessError("Access to unauthorized or invalid companies.");
      }
      return allowed;
    }
    return user.companyIds;
  }

  async company(): Promise<number> {
    // environments.py:256-263
    const allowed = allowedCompanyIds(this.context, this.su);
    const user = await userInfo(this);
    if (allowed.length > 0) {
      if (!this.su && allowed.some((cid) => !user.companyIds.includes(cid))) {
        throw new AccessError("Access to unauthorized or invalid companies.");
      }
      return allowed[0] as number;
    }
    return user.companyId;
  }

  withContext(ctx: Context): Environment {
    return new Env(this.reg, this.cr, this.uid, ctx, this.su, this.debug, this.cache);
  }

  withUser(uid: number): Environment {
    // environments.py `with_user`: su is reset to False
    return new Env(this.reg, this.cr, uid, this.context, false, this.debug, this.cache);
  }

  sudo(): Environment {
    return new Env(this.reg, this.cr, this.uid, this.context, true, this.debug, this.cache);
  }

  model(name: string): Model {
    return new ModelImpl(this, this.reg.model(name));
  }
}

/**
 * `context['allowed_company_ids']` as plain integers (PyFloat ids like `1.0` come from the JSON parser).
 * environments.py:256-261 and :286-291 test `if company_ids:` and then `set(company_ids) - set(user_company_ids)`: an
 * empty value (`[]`, `""`, False, None) means the user's companies; a non-empty string is a set of its characters, none
 * of them a company id, so a user gets the AccessError (round 9: the port read `"1"` as no value and answered with the
 * user's companies). In sudo Odoo skips the check and browses the value: refused here.
 */
export function allowedCompanyIds(context: Context, su = false): number[] {
  // typed as number[] in the contract, but the client's JSON can carry anything
  const raw: unknown = context.allowed_company_ids;
  if (raw === undefined || raw === null || raw === false || raw === "" || raw === 0) return [];
  const invalid = (): never => {
    if (su) throw new NotPorted(`allowed_company_ids ${JSON.stringify(raw)} in sudo`);
    throw new AccessError("Access to unauthorized or invalid companies.");
  };
  if (typeof raw === "string") return invalid();
  if (!Array.isArray(raw)) throw new NotPorted(`allowed_company_ids of type ${typeof raw}`);
  const out: number[] = [];
  for (const v of raw) {
    const n: unknown = isPyFloat(v) ? v.float : v;
    // a non-int is never one of the user's company ids (environments.py:261)
    if (typeof n !== "number" || !Number.isInteger(n)) return invalid();
    out.push(n);
  }
  return out;
}

/** Typed slot of the per-request cache; `init` runs once per key. */
export function envCache<T>(env: Environment, key: string, init: () => T): T {
  const existing = env.cache.get(key);
  if (existing !== undefined) return existing as T;
  const value = init();
  env.cache.set(key, value);
  return value;
}

// --------------------------------------------------------------------------------------------------------------
// Users, companies and groups
// --------------------------------------------------------------------------------------------------------------

export interface UserInfo {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly active: boolean;
  readonly share: boolean;
  readonly partnerId: number;
  readonly commercialPartnerId: number;
  readonly companyId: number;
  /** `_get_company_ids` (res_users.py:823): company_id first, then the active companies of company_ids. */
  readonly companyIds: readonly number[];
  /** `all_group_ids` (res_users.py:486): the groups and their transitively implied groups. */
  readonly groupIds: readonly number[];
  readonly lang: string | null;
  readonly tz: string | null;
}


/** The current user (`env.user`, always read as superuser: environments.py:233). */
export function userInfo(env: Environment): Promise<UserInfo> {
  return userInfoOf(env, env.uid);
}

export function userInfoOf(env: Environment, uid: number): Promise<UserInfo> {
  const users = envCache(env, "orm.users", () => new Map<number, Promise<UserInfo>>());
  const cached = users.get(uid);
  if (cached !== undefined) return cached;
  const loading = loadUser(env, uid);
  users.set(uid, loading);
  return loading;
}

async function loadUser(env: Environment, uid: number): Promise<UserInfo> {
  // `_get_company_ids` and `_get_group_ids` are ormcaches of the registry (res_users.py:823, :485): src/orm/signaling.ts
  const cr = env.cr;
  const [user, companies, groups, implied] = await Promise.all([
    // the request's user row, the statement the session check read already (src/session/user.ts fetchUser)
    fetchUser(cr, uid),
    userActiveCompanyIds(cr, uid),
    userDirectGroups(env, uid),
    impliedGroups(env),
  ]);
  const row = user;
  if (row === null) throw new MissingUser(uid);
  const companyIds = [row.company_id];
  for (const c of companies) if (!companyIds.includes(c)) companyIds.push(c);
  // all_group_ids = group_ids.all_implied_ids: reflexive transitive closure of implied_ids (res_groups.py:342-346)
  const groupIds = impliedClosure(groups, implied);
  return {
    id: row.id,
    login: row.login,
    name: row.partner_name ?? "",
    active: row.active === true,
    share: row.share === true,
    partnerId: row.partner_id,
    commercialPartnerId: row.partner_commercial_partner_id ?? row.partner_id,
    companyId: row.company_id,
    companyIds,
    groupIds: [...groupIds].sort((a, b) => a - b),
    lang: row.partner_lang,
    tz: row.partner_tz,
  };
}

/** The user's `group_ids` (res_groups_users_rel), kept with `_get_group_ids` in the registry (src/orm/signaling.ts). */
export function userDirectGroups(env: Environment, uid: number): Promise<number[]> {
  return directGroupIds(env.cr, uid);
}

export class MissingUser extends Error {
  constructor(uid: number) {
    super(`res.users ${uid} does not exist`);
    this.name = "MissingUser";
  }
}

/** `res_groups_implied_rel`: group id -> directly implied group ids (res_groups.py:75). */
export function impliedGroups(env: Environment): Promise<Map<number, number[]>> {
  // the implied groups are read through ormcaches of the registry (res_groups.py): src/orm/signaling.ts
  return impliedGroupMap(env.cr);
}

/** `all_implied_by_ids` (res_groups.py:362): the groups that transitively imply any of `ids`, including themselves. */
export async function groupsImplying(env: Environment, ids: readonly number[]): Promise<Set<number>> {
  const implied = await impliedGroups(env);
  const reverse = new Map<number, number[]>();
  for (const [gid, hids] of implied) {
    for (const hid of hids) {
      const list = reverse.get(hid) ?? [];
      list.push(gid);
      reverse.set(hid, list);
    }
  }
  const result = new Set<number>();
  const todo = [...ids];
  while (todo.length > 0) {
    const gid = todo.pop() as number;
    if (result.has(gid)) continue;
    result.add(gid);
    for (const parent of reverse.get(gid) ?? []) todo.push(parent);
  }
  return result;
}

/** `user._has_group(xmlid)` (res_users.py:1214): membership through the implied closure, no debug-mode rule. */
export async function hasGroup(env: Environment, xmlid: string): Promise<boolean> {
  const gid = await env.reg.xmlid(env.cr, xmlid);
  if (gid === null) return false;
  const user = await userInfo(env);
  return user.groupIds.includes(gid);
}

/** `user.has_groups(spec)` (res_users.py:1163): "a,b,!c"; `base.group_no_one` counts only in debug mode (:1210). */
export async function hasGroups(env: Environment, spec: string): Promise<boolean> {
  if (spec === ".") return false; // NO_ACCESS (models.py:115)
  const positives: string[] = [];
  const negatives: string[] = [];
  for (const raw of spec.split(",")) {
    const g = raw.trim();
    if (g.startsWith("!")) negatives.push(g.slice(1));
    else positives.push(g);
  }
  const check = async (g: string): Promise<boolean> => {
    const member = await hasGroup(env, g);
    return g === "base.group_no_one" ? member && env.debug : member;
  };
  for (const g of negatives) if (await check(g)) return false;
  for (const g of positives) if (await check(g)) return true;
  return positives.length === 0;
}

// --------------------------------------------------------------------------------------------------------------
// Language and timezone
// --------------------------------------------------------------------------------------------------------------

/** Active language codes (`res.lang._lang_get`, res_lang.py:332). */
export function activeLangs(env: Environment): Promise<Set<string>> {
  return envCache(env, "orm.langs", async () => new Set((await activeLangRows(env.cr)).map((r) => r.code)));
}

/** environments.py:329-331: an unknown or inactive context language raises UserError (untranslated). */
export async function checkLang(env: Environment): Promise<string | null> {
  const lang = env.lang;
  if (lang !== null && lang !== "en_US" && !(await activeLangs(env)).has(lang)) {
    throw new UserError(`Invalid language code: ${lang}`);
  }
  if (lang !== null && lang !== "en_US") await ensureRegistryLang(env.cr, env.reg, lang);
  return lang;
}

function validTz(tz: unknown): string | null {
  if (typeof tz !== "string" || tz === "") return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null; // environments.py:321: invalid timezone -> UTC
  }
}

/** `env.tz` (environments.py:314-323) as an IANA name; 'UTC' by default. */
export async function envTz(env: Environment): Promise<string> {
  const fromContext = validTz(env.context.tz);
  if (fromContext !== null) return fromContext;
  if (typeof env.context.tz === "string" && env.context.tz !== "") return "UTC";
  const user = await userInfo(env);
  return validTz(user.tz) ?? "UTC";
}
