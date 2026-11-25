/**
 * `mail.render.mixin` on `mail.template` (mail/models/mail_render_mixin.py): `_render_field` for a record, the
 * inline_template and qweb engines, the post-processing of links. `_render_template_qweb_regex` and
 * `_render_template_inline_template_regex` are static shortcuts of the same output and are not distinguished.
 */
import { NotPorted } from "../errors";
import { renderQwebTree } from "../controllers/report";
import { DbRec } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { evalExprAsync, type Scope } from "../pyexpr";
import { isPyFloat, pyBool, pyStr, PyKwargs, toNumber } from "../pyexpr/values";
import { userInfo } from "../orm/env";
import { formatPosix, getLang } from "../models/tail_util";
import { parseHtmlFragment, XmlSyntaxError } from "../xml";
import { formatAmount } from "../models/account_taxes";
import { isHtmlEmpty } from "./helpers";
import { PyEnv, PyRecords } from "./records";
import { LazyTerm } from "../orm/lazy_term";

const refused = (name: string) => (): never => { throw new NotPorted(`${name} in a mail template`); };

/** Positional and keyword arguments of a template call, by parameter name. */
function callArgs(raw: unknown[], names: readonly string[]): Map<string, unknown> {
  const args = [...raw];
  const kw = args.length && args[args.length - 1] instanceof PyKwargs ? (args.pop() as PyKwargs) : null;
  const out = new Map<string, unknown>();
  names.forEach((n, i) => { if (i < args.length) out.set(n, args[i]); });
  if (kw) for (const [k, v] of kw.entries) out.set(k, v);
  return out;
}

type Wall = { y: number; mo: number; d: number; h: number; mi: number; s: number };

/** The wall clock of a UTC "YYYY-MM-DD HH:MM:SS" value in `tz` (misc.py: an unknown zone keeps UTC). */
function wallClock(value: string, tz: string): Wall {
  const utc = new Date(`${value.slice(0, 19).replace(" ", "T")}Z`);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(utc);
  } catch {
    return wallClock(value, "UTC");
  }
  const g = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { y: g("year"), mo: g("month"), d: g("day"), h: g("hour"), mi: g("minute"), s: g("second") };
}

/** babel.dates format of an LDML pattern, for the fields mail templates use (en locales only). */
function formatLdml(pattern: string, w: Wall, langCode: string): string {
  if (!langCode.startsWith("en")) throw new NotPorted(`babel date pattern ${pattern} for ${langCode}`);
  const date = new Date(Date.UTC(w.y, w.mo - 1, w.d));
  const name = (o: Intl.DateTimeFormatOptions): string => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...o }).format(date);
  const pad = (n: number, k: number): string => String(n).padStart(k, "0");
  return pattern.replace(/'[^']*'|E{1,4}|M{1,4}|d{1,2}|y{1,4}|H{1,2}|h{1,2}|m{1,2}|s{1,2}|a/g, (t) => {
    if (t.startsWith("'")) return t.length === 2 ? "'" : t.slice(1, -1);
    switch (t[0]) {
      case "E": return name({ weekday: t.length === 4 ? "long" : "short" });
      case "M": return t.length === 4 ? name({ month: "long" }) : t.length === 3 ? name({ month: "short" }) : pad(w.mo, t.length);
      case "d": return pad(w.d, t.length);
      case "y": return t.length === 2 ? pad(w.y % 100, 2) : pad(w.y, t.length);
      case "H": return pad(w.h, t.length);
      case "h": return pad(w.h % 12 === 0 ? 12 : w.h % 12, t.length);
      case "m": return pad(w.mi, t.length);
      case "s": return pad(w.s, t.length);
      case "a": return w.h < 12 ? "AM" : "PM";
      default: return t;
    }
  });
}

/** misc.py:1442-1490 `format_datetime(env, dt, tz, dt_format, lang_code)`. */
export async function formatDatetimeIn(env: Environment, raw: unknown[]): Promise<string> {
  const a = callArgs(raw, ["dt", "tz", "dt_format", "lang_code"]);
  const value = a.get("dt");
  if (!value) return "";
  const lang = await getLang(env, a.get("lang_code") ? String(a.get("lang_code")) : undefined);
  const tz = String(a.get("tz") || (await userInfo(env)).tz || "UTC");
  const w = wallClock(String(value), tz);
  const fmt = a.get("dt_format");
  if (!fmt || fmt === "medium") return formatPosix(`${lang.dateFormat} ${lang.timeFormat}`, w, lang.code);
  if (fmt === "short") return formatPosix(`${lang.dateFormat} ${lang.timeFormat.replace(":%S", "")}`, w, lang.code);
  return formatLdml(String(fmt), w, lang.code);
}

/** misc.py:1493-1537 `format_time(env, time, tz, time_format, lang_code)` of a datetime value. */
export async function formatTimeIn(env: Environment, raw: unknown[]): Promise<string> {
  const a = callArgs(raw, ["time", "tz", "time_format", "lang_code"]);
  const value = a.get("time");
  if (!value) return "";
  if (typeof value !== "string" || value.length < 19) throw new NotPorted("format_time of a time value in a mail template");
  const lang = await getLang(env, a.get("lang_code") ? String(a.get("lang_code")) : undefined);
  const w = wallClock(value, String(a.get("tz") || (await userInfo(env)).tz || "UTC"));
  const fmt = a.get("time_format");
  if (!fmt || fmt === "medium") return formatPosix(lang.timeFormat, w, lang.code);
  if (fmt === "short") return formatPosix(lang.timeFormat.replace(":%S", ""), w, lang.code);
  return formatLdml(String(fmt), w, lang.code);
}

/** mail_render_mixin.py:343-364 `_render_eval_context` plus `object`. */
function evalContext(env: Environment, model: string, id: number): Scope {
  return new Map<string, unknown>(Object.entries({
    ctx: new Map(Object.entries(env.context)),
    format_addr: refused("format_addr"),
    format_date: refused("format_date"),
    format_datetime: (...raw: unknown[]) => formatDatetimeIn(env, raw),
    format_time: (...raw: unknown[]) => formatTimeIn(env, raw),
    format_amount: async (amount: unknown, currency: unknown, langCode?: unknown) => {
      if (langCode) throw new NotPorted("format_amount with a language in a mail template");
      if (!(currency instanceof PyRecords) || currency.ids.length !== 1) throw new NotPorted("format_amount without a currency");
      return formatAmount(env, isPyFloat(amount) ? amount.float : toNumber(amount), currency.ids[0]!);
    },
    format_duration: refused("format_duration"),
    is_html_empty: isHtmlEmpty,
    slug: refused("slug"),
    user: new PyRecords(env, "res.users", [env.uid]),
    env: new PyEnv(env),
    object: new PyRecords(env, model, [id]),
  }));
}

/** tools/rendering_tools.py:39-54 and :66-76. */
async function renderInline(src: string, scope: Scope): Promise<string> {
  let out = "", at = 0;
  for (const m of src.matchAll(/\{\{(.+?)(\|\|\|\s*(.*?))?\}\}/g)) {
    out += src.slice(at, m.index);
    at = m.index + m[0].length;
    const value = await evalExprAsync(m[1]!.trim(), scope);
    const result: unknown = pyBool(value) ? value : (m[3] ?? "");
    if (pyBool(result)) out += pyStr(result);
  }
  return out + src.slice(at);
}

/** :367-481 `_render_template_qweb`: `html.fragment_fromstring(src, create_parent='div')` (:409), which the result drops. */
async function renderBody(env: Environment, src: string, scope: Scope): Promise<string> {
  let tree;
  try {
    tree = parseHtmlFragment(src);
  } catch (e) {
    if (e instanceof XmlSyntaxError) throw new NotPorted(`mail template body that lxml's html parser would repair: ${e.message}`);
    throw e;
  }
  // portal/models/ir_qweb.py:11-24 `_prepare_environment` (not minimal_qcontext, which this render is not): with portal
  // installed every context key the values lack becomes a value. Lunch's supplier template reads `sites`, given only
  // in the context by `_send_auto_email` (measured on the oracle: `t-if="sites"` true from the context alone)
  if ((await env.cr.query("SELECT 1 FROM ir_module_module WHERE name = 'portal' AND state = 'installed'")).rows.length) {
    const lazy = (v: unknown): boolean => v instanceof LazyTerm || (Array.isArray(v) && v.some(lazy));
    for (const [k, v] of Object.entries(env.context)) {
      if (scope.has(k)) continue;
      // a lazy translation (compiled code's `_lt` in a context, src/orm/lazy_term.ts) has no template value here: a
      // template that names the key refuses, the others never read it
      if (lazy(v)) {
        if (new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(src)) throw new NotPorted(`a lazy translation from the context as the template value ${k}`);
        continue;
      }
      scope.set(k, v);
    }
  }
  return (await renderQwebTree(env, tree, scope, { escapeText: true })).slice(5, -6);
}

/** :152-192 `_replace_local_links`. */
export function replaceLocalLinks(html: string, baseUrl: string): string {
  if (!baseUrl) return html;
  const join = (_m: string, head: string, path: string): string => head + new URL(path, baseUrl).href;
  return html
    .replace(/(<(?:img|v:fill|v:image)(?=\s)[^>]*\ssrc=")(\/[^/][^"]+)/g, join)
    .replace(/(<a(?=\s)[^>]*\shref=")(\/[^/][^"]+)/g, join)
    .replace(/(<[\w-]+(?=\s)[^>]*\sbackground=")(\/[^/][^"]+)/g, join)
    .replace(/(<[^>]+\bstyle=['"][^'"]+\burl\((?:&#34;|'|&quot;|&#39;|")?)(\/(?:[^'")]|(?!&#34;)|(?!&#39;))+)/g, join);
}

/** The rendered fields of a mail.template: `body_html` with qweb, the others with inline_template (mail_template.py:245-256). */
export type TemplateField = "subject" | "body_html" | "lang" | "email_from" | "reply_to" | "email_cc" | "email_to" | "partner_cc" | "partner_to" | "scheduled_date";

/**
 * `mail_template.sudo().with_context(lang=lang)._render_field(field, [id], ...)` of `subject`, `lang`, `email_from`, `reply_to` (inline_template)
 * or `body_html` (qweb, with `post_process`, the field's `render_options`).
 */
export async function renderTemplateField(env0: Environment, template: number, field: TemplateField, id: number, lang: string | null, sudo = true): Promise<string> {
  const env = (sudo ? env0.sudo() : env0).withContext({ ...env0.context, ...(lang ? { lang } : {}) });
  const rec = new DbRec(env, env.reg.model("mail.template"), template);
  const model = String(await rec.get("model"));
  const src = await rec.get(field);
  if (typeof src !== "string" || src === "") return "";
  const scope = evalContext(env, model, id);
  if (field !== "body_html") return renderInline(src, scope);
  const base = (await env.cr.query<{ value: string }>("SELECT value FROM ir_config_parameter WHERE key = 'web.base.url'")).rows[0]?.value ?? "";
  return replaceLocalLinks(await renderBody(env, src, scope), base);
}

/** Render an inline_template string (`{{ ... }}`) for one record `(model, id)` (mail_render_mixin._render_field). */
export async function renderInlineForRecord(env0: Environment, src: string, model: string, id: number, lang: string | null): Promise<string> {
  if (!src) return "";
  const env = lang ? env0.withContext({ ...env0.context, lang }) : env0;
  return renderInline(src, evalContext(env, model, id));
}

/** Render a QWeb HTML body fragment (`t-out`, `t-if`, ...) for one record `(model, id)`, with local link post-processing. */
export async function renderQwebBodyForRecord(env0: Environment, src: string, model: string, id: number, lang: string | null): Promise<string> {
  if (!src) return "";
  const env = lang ? env0.withContext({ ...env0.context, lang }) : env0;
  const base = (await env.cr.query<{ value: string }>("SELECT value FROM ir_config_parameter WHERE key = 'web.base.url'")).rows[0]?.value ?? "";
  return replaceLocalLinks(await renderBody(env, src, evalContext(env, model, id)), base);
}
