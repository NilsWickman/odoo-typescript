/**
 * Shared helpers of the per-app compute ports (src/models/*_computes.ts): one record-level compute body registered
 * for both the read path (hooks.ts `computed`) and the write core (recompute.ts `registerRecordCompute`, onchange and
 * web_save), `_filtered_access`, and `odoo.tools.misc.format_datetime` for the res.lang formats in use.
 */
import { NotPorted } from "../errors";
import { and, cond, isNegativeOperator, NEGATIVE_CONDITION_OPERATORS, not, or, TRUE } from "../orm/domain";
import { userInfo } from "../orm/env";
import { hooksOf, registerHooks, type SearchFn } from "../orm/hooks";
import { DbRec, registerRecordCompute, type Rec, type RecordCompute } from "../orm/recompute";
import { queryIds, searchQuery } from "../orm/sql";
import type { Domain, Environment } from "../orm/types";
import { validTz } from "./util";

/**
 * Register `fn` (the Python `for record in self:` body) as the compute of non-stored fields of `model`: the read
 * path calls it per id on a database record, the write core on database or new records.
 */
export function defineComputes(model: string, computes: Record<string, RecordCompute>): void {
  registerRecordCompute(model, computes);
  const computed: Record<string, (env: Environment, ids: readonly number[]) => Promise<Map<number, unknown>>> = {};
  for (const [name, fn] of Object.entries(computes)) {
    computed[name] = async (env, ids) => {
      const def = env.reg.model(model);
      const out = new Map<number, unknown>();
      for (const id of ids) out.set(id, await fn(env, new DbRec(env, def, id)));
      return out;
    };
  }
  registerHooks(model, { computed });
}

/**
 * models.py:3506-3540 `_filtered_access(operation)` on database ids: all ids for the superuser; none when the
 * access domain is false; otherwise the ids matching it as superuser with active_test=False.
 */
export async function filteredAccess(env: Environment, model: string, ids: readonly number[], operation: "read" | "write" | "create" | "unlink"): Promise<Set<number>> {
  if (env.su || ids.length === 0) return new Set(ids);
  const domain = await env.model(model).accessDomain(operation);
  if (domain === null || domain.kind === "true") return new Set(ids);
  if (domain.kind === "false") return new Set();
  const found = await queryIds(await searchQuery(env, env.reg.model(model), cond("id", "in", [...ids]), { activeTest: false, secDomain: domain }));
  return new Set(found);
}

/** `self.env['x']._filtered_access('create')` on new records: the model-level permission (domain not false). */
export async function canCreate(env: Environment, model: string): Promise<boolean> {
  if (env.su) return true;
  const domain = await env.model(model).accessDomain("create");
  return domain === null || domain.kind !== "false";
}

/** `search_count(domain)` as the env's user. */
export async function searchCount(env: Environment, model: string, domain = TRUE): Promise<number> {
  return env.model(model).searchCount(domain);
}

/** misc.py:1272 get_lang: the explicit code, the context lang, the company partner's lang, en_US, among the installed. */
export async function getLang(env: Environment, code?: string): Promise<{ code: string; dateFormat: string; timeFormat: string }> {
  const langs = (await env.cr.query<{ code: string; date_format: string; time_format: string }>(
    "SELECT code, date_format, time_format FROM res_lang WHERE active ORDER BY name")).rows;
  const codes = langs.map((l) => l.code);
  let lang = codes.includes("en_US") ? "en_US" : codes[0] ?? "en_US";
  const ctxLang = env.context.lang;
  if (code && codes.includes(code)) lang = code;
  else if (typeof ctxLang === "string" && codes.includes(ctxLang)) lang = ctxLang;
  else {
    const user = await userInfo(env);
    const row = (await env.cr.query<{ lang: string | null }>(
      "SELECT p.lang FROM res_users u JOIN res_company c ON c.id = u.company_id JOIN res_partner p ON p.id = c.partner_id WHERE u.id = $1", [user.id])).rows[0];
    if (row?.lang && codes.includes(row.lang)) lang = row.lang;
  }
  const found = langs.find((l) => l.code === lang);
  if (!found) throw new NotPorted(`get_lang: no installed language ${lang}`);
  return { code: found.code, dateFormat: found.date_format, timeFormat: found.time_format };
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/** The wall clock of a UTC instant in an IANA zone. */
export function wallClock(utc: Date, tz: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(utc);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
}

/**
 * The strftime directives of res.lang formats through misc.py posix_to_ldml + babel format_datetime, for the numeric
 * directives and `%p` (babel `a`: CLDR dayPeriods abbreviated format, "AM"/"PM" in en). Other directives refuse.
 */
export function formatPosix(fmt: string, w: { y: number; mo: number; d: number; h: number; mi: number; s: number }, langCode: string): string {
  let out = "";
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i]!;
    if (ch !== "%") { out += ch; continue; }
    const dir = fmt[++i];
    switch (dir) {
      case "Y": out += pad(w.y, 4); break;
      case "y": out += pad(w.y % 100); break;
      case "m": out += pad(w.mo); break;
      case "d": out += pad(w.d); break;
      case "H": out += pad(w.h); break;
      case "I": out += pad(w.h % 12 === 0 ? 12 : w.h % 12); break;
      case "M": out += pad(w.mi); break;
      case "S": out += pad(w.s); break;
      case "p":
        // babel en/fr CLDR `dayPeriods.format.abbreviated`: am "AM", pm "PM" (babel/locale-data/en.dat, fr.dat)
        if (!langCode.startsWith("en") && !langCode.startsWith("fr")) throw new NotPorted(`format_datetime %p for ${langCode}`);
        out += w.h < 12 ? "AM" : "PM"; break;
      case "%": out += "%"; break;
      default: throw new NotPorted(`format_datetime directive %${dir ?? ""}`);
    }
  }
  return out;
}

/**
 * misc.py:1442 `format_datetime(env, value, tz=tz, dt_format='medium')`: the UTC "YYYY-MM-DD HH:MM:SS" value in `tz`
 * (else env.user.tz, else UTC; an unknown zone keeps UTC) with the lang's `date_format time_format`.
 */
export async function formatDatetime(env: Environment, value: string | null | false, tz?: string | null): Promise<string> {
  if (!value) return "";
  let zone = "UTC";
  if (tz) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); zone = tz; } catch (e) { if (!(e instanceof RangeError)) throw e; }
  } else {
    // `env.user.tz or 'UTC'` (an invalid zone falls back to UTC in the except branch)
    zone = validTz((await userInfo(env)).tz) ?? "UTC";
  }
  const utc = new Date(`${value.replace(" ", "T")}Z`);
  const lang = await getLang(env);
  return formatPosix(`${lang.dateFormat} ${lang.timeFormat}`, wallClock(utc, zone), lang.code);
}

/**
 * The selection of a `related=` Selection field (fields.py:690 setup_related copies the target's `selection`):
 * the target field's static keys with their labels in env.lang.
 */
export function relatedSelection(targetModel: string, targetField: string): (env: Environment) => Promise<readonly [string, string][]> {
  return async (env) => {
    const sel = env.reg.model(targetModel).fields.get(targetField)?.selection;
    if (!sel) throw new NotPorted(`selection of ${targetModel}.${targetField} (callable)`);
    const lang = env.lang ?? "en_US";
    return sel.map((s) => [s.value, s.labels[lang] ?? s.label] as [string, string]);
  };
}

/**
 * mail.alias.mixin.optional (mail/models/mail_alias_mixin_optional.py:21-46) on `model`: `alias_contact` related to
 * mail.alias, `alias_email` computed from alias_name and alias_domain and searched on alias_id.alias_full_name.
 */
export function registerAliasMixin(model: string): void {
  registerHooks(model, {
    selection: { alias_contact: relatedSelection("mail.alias", "alias_contact") },
    search: {
      alias_email: searchMethod(model, "alias_email", async (_env, operator, operand) => {
        if (isNegativeOperator(operator)) return null;
        const domain = cond("alias_id.alias_full_name", operator, operand);
        if (operator === "in" && Array.isArray(operand) && operand.includes(false)) return or([domain, cond("alias_id", "=", false)]);
        return domain;
      }),
    },
  });
  defineComputes(model, {
    // :30-37 _compute_alias_email
    alias_email: async (_env, rec) => {
      const name = await rec.get("alias_name"), domain = await rec.get("alias_domain");
      return name && domain ? `${String(name)}@${String(domain)}` : null; // an empty char in cache format
    },
  });
}

/**
 * mail.thread `message_needaction` (mail/models/mail_thread.py:278-293 `_compute_message_needaction`): a message of
 * the record (not a user notification) with an unread notification of the user's partner.
 */
export function registerNeedaction(model: string): void {
  registerHooks(model, {
    computed: {
      message_needaction: async (env, ids) => {
        const user = await userInfo(env);
        const rows = (await env.cr.query<{ res_id: number }>(
          `SELECT msg.res_id FROM mail_message msg
           RIGHT JOIN mail_notification rel ON rel.mail_message_id = msg.id AND rel.res_partner_id = $1
             AND (rel.is_read = false OR rel.is_read IS NULL)
           WHERE msg.model = $2 AND msg.res_id = ANY($3::int[]) AND msg.message_type != 'user_notification'`,
          [user.partnerId, model, ids])).rows;
        const hit = new Set(rows.map((r) => r.res_id));
        return new Map(ids.map((id) => [id, hit.has(id)]));
      },
    },
  });
}

/** `ir.config_parameter.sudo().get_str(key, default)`. */
export async function configParam(env: Environment, key: string): Promise<string | null> {
  return (await env.cr.query<{ value: string | null }>("SELECT value FROM ir_config_parameter WHERE key = $1", [key])).rows[0]?.value ?? null;
}

/** The reference value `"model,id"` when the record exists (fields_reference.py:26-37 convert_to_cache), else null. */
export async function referenceIfExists(env: Environment, model: string, id: number): Promise<string | null> {
  if (!env.reg.models.has(model)) return null;
  const def = env.reg.model(model);
  if (def.abstract) return null;
  const found = (await env.cr.query(`SELECT 1 FROM "${def.table}" WHERE id = $1`, [id])).rows.length > 0;
  return found ? `${model},${id}` : null;
}

/**
 * mail.thread `message_is_follower` (mail/models/mail_thread.py:241-260): whether the user's partner follows the
 * record, searched through mail.followers (`in` only).
 */
export function registerIsFollower(model: string): void {
  if (hooksOf(model).computed?.["message_is_follower"] !== undefined) return;
  registerHooks(model, {
    computed: {
      message_is_follower: async (env, ids) => {
        const user = await userInfo(env);
        const rows = (await env.cr.query<{ res_id: number }>(
          "SELECT res_id FROM mail_followers WHERE res_model = $1 AND res_id = ANY($2::int[]) AND partner_id = $3", [model, ids, user.partnerId])).rows;
        const hit = new Set(rows.map((r) => r.res_id));
        return new Map(ids.map((id) => [id, hit.has(id)]));
      },
    },
    search: {
      message_is_follower: async (env, operator) => {
        if (operator !== "in") throw new NotPorted(`${model}.message_is_follower ${operator} (NotImplemented)`);
        const user = await userInfo(env);
        const rows = (await env.cr.query<{ res_id: number }>(
          "SELECT res_id FROM mail_followers WHERE res_model = $1 AND partner_id = $2", [model, user.partnerId])).rows;
        return cond("id", "in", [...new Set(rows.map((r) => r.res_id))]);
      },
    },
  });
}

/**
 * A Python `_search_<field>` that may return NotImplemented (null here), with the ORM's fallbacks
 * (domains.py:1078-1110 `_optimize_field_search_method`): a negative operator is retried with the positive one and
 * negated; `in`/`not in` of a list is retried per value with '='/'!='. (hooks.ts SearchFn has no NotImplemented.)
 */
export function searchMethod(model: string, field: string, inner: (env: Environment, operator: string, value: unknown) => Promise<Domain | null>): SearchFn {
  return async (env, operator, value) => {
    const first = await inner(env, operator, value);
    if (first !== null) return first;
    // domains.py:1078: the inverse operator (positive for a negative one and vice versa), negated
    const inverse = NEGATIVE_CONDITION_OPERATORS[operator]
      ?? Object.entries(NEGATIVE_CONDITION_OPERATORS).find(([, pos]) => pos === operator)?.[0];
    if (inverse !== undefined) {
      const d = await inner(env, inverse, value);
      if (d !== null) return not(d);
    }
    if ((operator === "in" || operator === "not in") && Array.isArray(value)) {
      const parts: Domain[] = [];
      for (const v of value) {
        const d = await inner(env, operator === "in" ? "=" : "!=", v);
        if (d === null) throw new NotPorted(`${model}.${field} ${operator} (NotImplemented)`);
        parts.push(d);
      }
      return operator === "in" ? or(parts) : and(parts);
    }
    throw new NotPorted(`${model}.${field} ${operator} (NotImplemented: unsupported operator)`);
  };
}

/**
 * A field neither stored nor computed reads its default (fields.py:1973-1987 `__get__`: `default_get([name])` on a
 * cache miss), the same for every record.
 */
export function registerDefaultValued(model: string, field: string): void {
  if (hooksOf(model).computed?.[field] !== undefined) return;
  registerHooks(model, {
    computed: {
      [field]: async (env, ids) => {
        const { defaultGet } = await import("../web/defaults");
        const values = await defaultGet(env, model, [field]);
        const value = field in values ? values[field] : null;
        return new Map(ids.map((id) => [id, value]));
      },
    },
  });
}

/**
 * base res_partner.py:1235-1272 `address_get(adr_pref)` of one partner: a depth-first scan of the descendants that
 * are not companies, then of the ancestors up to the commercial entity; missing types default to the 'contact'
 * found, else the partner itself.
 */
export async function addressGet(env: Environment, partnerId: number, adrPref: readonly string[]): Promise<Record<string, number>> {
  const pref = new Set(adrPref);
  pref.add("contact");
  const result = new Map<string, number>();
  const visited = new Set<number>();
  const def = env.reg.model("res.partner");
  let current: Rec | null = new DbRec(env, def, partnerId);
  while (current) {
    let toScan: Rec[] = [current];
    while (toScan.length) {
      const record = toScan.shift()!;
      visited.add(record.id!);
      const type = String(await record.get("type"));
      if (pref.has(type) && !result.get(type)) result.set(type, record.id!);
      if (result.size === pref.size) return Object.fromEntries(result);
      const children: Rec[] = [];
      for (const c of await record.rels("child_ids")) if (!visited.has(c.id!) && !(await c.get("is_company"))) children.push(c);
      toScan = [...children, ...toScan];
    }
    if ((await current.get("is_company")) || !(await current.get("parent_id"))) break;
    current = await current.rel("parent_id");
  }
  const fallback = result.get("contact") ?? partnerId;
  const out: Record<string, number> = {};
  for (const t of pref) out[t] = result.get(t) || fallback;
  return out;
}

/** models.py:5482-5494 with_company: the company first in allowed_company_ids. */
export async function withCompany(env: Environment, company: number): Promise<Environment> {
  const allowed = [...(await env.companies())];
  if (allowed[0] === company) return env;
  return env.withContext({ ...env.context, allowed_company_ids: [company, ...allowed.filter((c) => c !== company)] });
}
