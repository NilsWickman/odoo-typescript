/** Request values for ir.qweb._prepare_environment, ir_qweb.py:1364-1400. */
import type { RequestContext } from "../http/context";
import { renderTemplate } from "../qweb";
import { frontendSessionInfo } from "../session/info";
import { fetchUser, xmlidToResId } from "../session/user";
import { NotPorted } from "../errors";
import { PyKwargs } from "../pyexpr/values";
import type { Environment } from "../orm/types";
import { hasGroups } from "../orm/env";
import { fieldHooks } from "../qweb/fields";
import { reportHelpers } from "../qweb/helpers";
import { PyEnv, PyRecords } from "../qweb/records";

/** `env` of a page with records (`orm` given): `env['ir.http']` is the session's, the rest are the ORM's. */
class FrontendEnv extends PyEnv {
  constructor(orm: Environment, private readonly irHttp: unknown) {
    super(orm);
  }
  override pyGetItem(key: unknown): unknown {
    return key === "ir.http" ? this.irHttp : super.pyGetItem(key);
  }
}

/** `responseTemplate: false`: rendered by `ir.ui.view._render_template` (http_routing's error pages), not by
 *  `Response.render`, so the qcontext has no `response_template`. */
export interface RenderPageOptions { readonly responseTemplate?: boolean }

/** Formats a localized URL for the language selector, avoiding `/undefined/...` on unknown/inactive codes. */
export function formatLocalizedUrl(
  langs: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  code: unknown,
  pathname: string,
  search: string,
): string {
  const urlCode = langs.get(String(code))?.["url_code"];
  if (typeof urlCode !== "string" || !urlCode) return `${pathname}${search}`;
  return `/${urlCode}${pathname}${search}`;
}

export async function renderPage(ctx: RequestContext, template: string, values: Record<string, unknown>, orm?: Environment, options: RenderPageOptions = {}): Promise<string> {
  const csrf = await ctx.csrfToken(null);
  const uid = ctx.uid ?? (await xmlidToResId(ctx.cursor(), "base.public_user")) ?? 1;
  const user = await fetchUser(ctx.cursor(), uid);
  const company = (await ctx.cursor().query<{ id: number; name: string; uses_default_logo: boolean; email_primary_color: string | null; email_secondary_color: string | null }>(
    "SELECT id, name, uses_default_logo, email_primary_color, email_secondary_color FROM res_company WHERE id = $1", [user?.company_id ?? 1],
  )).rows[0];
  const lang = orm?.lang ?? (typeof ctx.context.lang === "string" ? ctx.context.lang : "en_US");
  const langs = await activeLangData(ctx);
  const groups = await userGroupXmlids(ctx, uid);
  // res.lang._get_data(code=...) (res_lang.py:314): the LangData of an active language, else a dummy whose
  // fields are all False
  const resLang = {
    _get_data: (...args: unknown[]) => {
      const kw = args[args.length - 1];
      const code = kw instanceof PyKwargs ? kw.entries.get("code") : undefined;
      if (!(kw instanceof PyKwargs) || kw.entries.size !== 1 || code === undefined) throw new NotPorted("res.lang._get_data other than code=");
      return langs.get(String(code)) ?? { direction: false, code: false, name: false, url_code: false };
    },
  };
  const irHttp = { get_frontend_session_info: () => frontend };
  // request.env / env as the templates use them: env['ir.http'], env['res.lang'], env.lang, env.company
  const env = orm !== undefined ? new FrontendEnv(orm, irHttp) : new PageEnv(lang, company ?? null, { "ir.http": irHttp, "res.lang": resLang });
  const frontend = template === "web.login" || orm !== undefined ? await frontendSessionInfo({
    cr: ctx.cursor(), session: ctx.sessionState, uid, cookies: ctx.requestCookies, bestLang: ctx.bestLang(),
  }) : {};
  const icon = values["odoo_icon"];
  const records = orm === undefined ? {} : {
    ...reportHelpers(orm),
    res_company: new PyRecords(orm.sudo(), "res.company", [await orm.company()]),
    company: new PyRecords(orm.sudo(), "res.company", [await orm.company()]),
    user_id: new PyRecords(orm, "res.users", [orm.uid]),
    // portal/models/ir_qweb.py:20 `res.lang._get_frontend()`: the active languages by id
    frontend_languages: new Map(langs),
    // http_routing ir_http.py:183-226 `url_lang` of the current path, for the language selector
    url_localized: (...args: unknown[]) => {
      const kw = args[args.length - 1];
      const code = kw instanceof PyKwargs ? kw.entries.get("lang_code") : undefined;
      if (code === undefined) throw new NotPorted("url_localized without lang_code");
      return formatLocalizedUrl(langs, code, ctx.url.pathname, ctx.url.search);
    },
  };
  const sub = (t: string, v: Map<string, unknown>): Promise<string> => renderTemplate(ctx.cursor(), t, v, { lang, ...hooks });
  const hooks = orm === undefined ? {} : fieldHooks(orm, sub);
  return renderTemplate(ctx.cursor(), template, {
    ...values,
    ...(icon instanceof Uint8Array ? { odoo_icon: { to_base64: () => Buffer.from(icon).toString("base64") } } : {}),
    // `request.session.get(key)` (portal.user_sign_in reads profile_session): the session's stored values
    // `session` an attribute object: a plain object is a dict to the expressions, whose `.get` would look up its keys
    request: { db: ctx.db, csrf_token: () => csrf, env, httprequest: new HttpRequestView(safeDecode(ctx.url.pathname)), session: new SessionGet((key, dflt) => ctx.sessionState.asData()[key] ?? dflt) },
    env,
    // http/response.py:83 Response.render: qcontext['response_template'] = self.template
    ...(options.responseTemplate === false ? {} : { response_template: template }),
    res_company: company,
    ...records,
    // base ir_qweb.py:511-531 `keep_query(*keep_params, **additional_params)`
    keep_query: (...raw: unknown[]) => {
      const last = raw[raw.length - 1];
      const additional = last instanceof PyKwargs ? last.entries : new Map<string, unknown>();
      let keep = (last instanceof PyKwargs ? raw.slice(0, -1) : raw).map(String);
      if (!keep.length && !additional.size) keep = ["*"];
      const params: [string, unknown][] = [...additional].map(([k, v]) => [String(k), v]);
      const qsKeys = [...new Set([...ctx.url.searchParams.keys()])];
      for (const pattern of keep) {
        const re = fnmatchRegex(pattern);
        for (const key of qsKeys) {
          if (re.test(key) && !additional.has(key)) {
            const i = params.findIndex(([k]) => k === key);
            const v = ctx.url.searchParams.getAll(key);
            if (i >= 0) params[i] = [key, v]; else params.push([key, v]);
          }
        }
      }
      return urlEncode(params);
    },
    debug: ctx.sessionState.debug,
  }, {
    lang,
    ...hooks,
    // res_users.py:1163 has_groups for `groups=` attributes (ir_qweb.py:2356); base.group_no_one only in debug
    hasGroups: (spec: string) => {
      if (spec === ".") return false;
      const has = (g: string): boolean => groups.has(g) && (g !== "base.group_no_one" || ctx.sessionState.debug !== "");
      const parts = spec.split(",").map((g) => g.trim());
      const positives = parts.filter((g) => !g.startsWith("!"));
      if (parts.some((g) => g.startsWith("!") && has(g.slice(1)))) return false;
      if (positives.some(has)) return true;
      return positives.length === 0;
    },
  });
}

/** `_get_active_by('code')` (res_lang.py:314-330) for the fields the templates read. */
async function activeLangData(ctx: RequestContext): Promise<Map<string, Record<string, unknown>>> {
  const r = await ctx.cursor().query<{ code: string; direction: string; name: string; url_code: string }>(
    "SELECT code, direction, name, url_code FROM res_lang WHERE active ORDER BY id");
  return new Map(r.rows.map((l) => [l.code, { code: l.code, direction: l.direction, name: l.name, url_code: l.url_code }]));
}

/** The xmlids of `user.all_group_ids` (res_groups.py:342-346, the implied closure) for has_groups. */
async function userGroupXmlids(ctx: RequestContext, uid: number): Promise<Set<string>> {
  const r = await ctx.cursor().query<{ xmlid: string }>(`
    WITH RECURSIVE g(id) AS (
      SELECT gid FROM res_groups_users_rel WHERE uid = $1
      UNION SELECT i.hid FROM res_groups_implied_rel i JOIN g ON g.id = i.gid
    )
    SELECT d.module || '.' || d.name AS xmlid FROM g JOIN ir_model_data d ON d.model = 'res.groups' AND d.res_id = g.id`, [uid]);
  return new Set(r.rows.map((row) => row.xmlid));
}

/** `request.httprequest` for page templates: werkzeug's `path` (percent-decoded). */
class HttpRequestView {
  constructor(readonly path: string) {}
}

function safeDecode(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/** fnmatch.translate (POSIX, case-sensitive): `*`, `?`, `[seq]`, `[!seq]`. */
function fnmatchRegex(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const j = pattern.indexOf("]", i + 2);
      if (j < 0) re += "\\[";
      else {
        let body = pattern.slice(i + 1, j).replace(/\\/g, "\\\\");
        if (body.startsWith("!")) body = "^" + body.slice(1);
        re += `[${body}]`;
        i = j;
      }
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "s");
}

/**
 * werkzeug `url_encode` as odoo/_monkeypatches/werkzeug.py:465-490, 590-591 patch it: pairs in order, a list value as
 * one pair per item, None skipped, `str()` of the value, quote_plus of its UTF-8.
 */
export function urlEncode(pairs: Iterable<readonly [string, unknown]>): string {
  const quote = (v: string): string => {
    let out = "";
    for (const c of Buffer.from(v, "utf8")) {
      const ch = String.fromCharCode(c);
      if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
      else if (ch === " ") out += "+";
      else out += `%${c.toString(16).toUpperCase().padStart(2, "0")}`;
    }
    return out;
  };
  const str = (v: unknown): string => {
    if (v === true) return "True";
    if (v === false) return "False";
    if (typeof v === "string" || typeof v === "number") return String(v);
    throw new NotPorted(`url_encode of a ${typeof v}`);
  };
  const out: string[] = [];
  for (const [k, v] of pairs) {
    for (const item of Array.isArray(v) ? v : [v]) {
      if (item === null || item === undefined) continue;
      out.push(`${quote(k)}=${quote(str(item))}`);
    }
  }
  return out.join("&");
}

/** `request.session` for page templates: `get(key, default=None)` of the session dict. */
class SessionGet {
  constructor(private readonly read: (key: string, dflt: unknown) => unknown) {}
  get(key: unknown, dflt: unknown = null): unknown {
    return this.read(String(key), dflt);
  }
}

/** `request.env` for page templates: an attribute object (not a dict) with `env[model]` (eval.ts getItem `getitem`). */
class PageEnv {
  constructor(readonly lang: string, readonly company: unknown, private readonly models: Readonly<Record<string, unknown>>) {}
  getitem(k: unknown): unknown {
    const m = typeof k === "string" ? this.models[k] : undefined;
    if (m === undefined) throw new NotPorted(`env[${JSON.stringify(k)}] in a page template`);
    return m;
  }
}
