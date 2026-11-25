/**
 * The "My Preferences" dialog of the user menu (`web/static/src/webclient/user_menu/user_menu_items.js`
 * `preferencesItem`): `res.users.action_get` (base/models/res_users.py:828-830), the form's computed fields, and
 * the `preference_save` button (res_users.py:1114-1119) that `/web/dataset/call_button` dispatches.
 * Also the `ir.actions.act_window` behaviour `action_get`'s full `read()` reaches (base/models/ir_actions.py).
 */
import { AccessError, NotPorted, UserError } from "../errors";
import { registerMethod } from "../http/methods";
import { registerHooks } from "../orm/hooks";
import type { Environment, RecordValues } from "../orm/types";
import { hasGroup } from "../orm/env";
import { registerRecordCompute, type Rec } from "../orm/recompute";
import { emailNormalize } from "../mail/message";
import { checkFieldAccess, sql } from "../orm/sql";
import { registerOverrides, write } from "../orm/write";
import { collapseIpAddress } from "../session/device";
import { STORED_SESSION_BYTES } from "../session/session";
import { userGroupIds, userRole } from "../session/user";
import { isTimezone, utcToLocal } from "../web/tz";
import { requestInfo } from "./request_info";
import { codeTranslation } from "../orm/code_translations";
import { groupsWrite } from "./res_users_groups";
import { nonPublicMembers } from "./res_users_unlink";
import { requestOfCursor } from "../http/context";
import { withStoreVersionAtEnd } from "../mail/busnotify";
import { unlinkMembers } from "../mail/channel_write";

type WriteNext = (env: Environment, ids: readonly number[], vals: Record<string, unknown>) => Promise<void>;

// ---------------------------------------------------------------------------------------------------------------
// ir.actions.act_window computed fields (read() of all fields)
// ---------------------------------------------------------------------------------------------------------------

/** ir_actions.py:106-109 `_compute_xml_id` via models.py `get_external_id` (first xmlid by ir_model_data.id). */
async function actionXmlIds(env: Environment, model: string, ids: readonly number[]): Promise<Map<number, unknown>> {
  const r = await env.cr.query<{ res_id: number; xmlid: string }>(
    "SELECT DISTINCT ON (res_id) res_id, module || '.' || name AS xmlid FROM ir_model_data WHERE model = $1 AND res_id = ANY($2::int[]) ORDER BY res_id, id",
    [model, ids],
  );
  const out = new Map<number, unknown>(ids.map((id) => [id, false]));
  for (const row of r.rows) out.set(row.res_id, row.xmlid);
  return out;
}

/** ir_actions.py:259-282 `_compute_views`. */
async function actionViews(env: Environment, ids: readonly number[]): Promise<Map<number, unknown>> {
  const out = new Map<number, unknown>();
  for (const id of ids) {
    const act = (await env.cr.query<{ view_mode: string; view_id: number | null; view_type: string | null }>(
      `SELECT a.view_mode, a.view_id, v.type AS view_type FROM ir_act_window a LEFT JOIN ir_ui_view v ON v.id = a.view_id WHERE a.id = $1`, [id])).rows[0];
    if (act === undefined) continue;
    // view_ids: One2many('ir.actions.act_window.view', 'act_window_id'), _order 'sequence,id' (ir_actions.py:400)
    const lines = (await env.cr.query<{ view_id: number | null; view_mode: string }>(
      "SELECT view_id, view_mode FROM ir_act_window_view WHERE act_window_id = $1 ORDER BY sequence, id", [id])).rows;
    const views: unknown[][] = lines.map((l) => [l.view_id ?? false, l.view_mode]);
    const got = lines.map((l) => l.view_mode);
    const missing = act.view_mode.split(",").filter((m) => !got.includes(m));
    if (missing.length) {
      if (act.view_type !== null && missing.includes(act.view_type)) {
        missing.splice(missing.indexOf(act.view_type), 1);
        views.push([act.view_id ?? false, act.view_type]);
      }
      views.push(...missing.map((m) => [false, m]));
    }
    out.set(id, views);
  }
  return out;
}

/** ir_actions.py:320-323 `_compute_embedded_actions`: visible ir.embedded.actions of the action. */
async function actionEmbedded(env: Environment, ids: readonly number[]): Promise<Map<number, unknown>> {
  const r = await env.cr.query<{ n: number }>("SELECT count(*)::int AS n FROM ir_embedded_actions WHERE parent_action_id = ANY($1::int[])", [ids]);
  if ((r.rows[0]?.n ?? 0) > 0) throw new NotPorted("ir.embedded.actions is_visible (embedded actions of an action)");
  return new Map(ids.map((id) => [id, []]));
}

registerHooks("ir.actions.act_window", {
  computed: {
    xml_id: (env, ids) => actionXmlIds(env, "ir.actions.act_window", ids),
    views: actionViews,
    embedded_action_ids: actionEmbedded,
  },
});

// ---------------------------------------------------------------------------------------------------------------
// get_empty_list_help (ir.actions.act_window.read, ir_actions.py:325-339)
// ---------------------------------------------------------------------------------------------------------------

/**
 * `_(source)` of `module` in the environment's language: the generated .po table (src/orm/code_translations.ts, sv_SE
 * and fr_FR on poc_erp); where none is generated (poc_corpus) the fr_FR copies below, as src/mail/i18n.ts; else refuses.
 */
const FR: Readonly<Record<string, string>> = {
  "Create new %(document)s": "Créer un nouveau %(document)s", // mail/i18n/fr.po:4193-4194
  document: "document", // mail/i18n/fr.po:16584-16585
  Unknown: "Inconnu", // base/i18n/fr.po:20443-20444
};

function codeT(env: Environment, source: string, module: string): string {
  const lang = env.lang;
  if (lang === null || lang === "en_US") return source;
  const t = codeTranslation(lang, module, source) ?? (lang === "fr_FR" ? FR[source] : undefined);
  if (t === undefined) throw new NotPorted(`translation of "${source}" to ${lang} (${module}: no .po table)`);
  return t;
}

/** mail_thread.py:441-490's `_()`. */
function mailT(env: Environment, source: string): string {
  return codeT(env, source, "mail");
}

/** odoo/tools/mail.py:525-538 `is_html_empty`, refusing html whose emptiness would need entity unescaping. */
function isHtmlEmpty(html: unknown): boolean {
  if (html === false || html === null || html === undefined || html === "") return true;
  if (typeof html !== "string") throw new NotPorted("is_html_empty of a non-string");
  const tagRe = /<\s*\/?(?:p|div|section|span|br|b|i|font)\b(?:(\s+[A-Za-z_-][A-Za-z0-9-_]*(\s*=\s*['"][^"']*['"]))*)(?:\s*>|\s*\/\s*>)/g;
  const iconRe = /<\s*(i|span)\b(\s+[A-Za-z_-][A-Za-z0-9-_]*(\s*=\s*['"][^"']*['"])?)*\s*\bclass\s*=\s*["'][^"']*\b(fa|fab|fad|far|oi)\b/;
  const text = html.replace(tagRe, "");
  if (text.includes("&")) throw new NotPorted("is_html_empty with html entities");
  return text.trim() === "" && !iconRe.test(html);
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;").replace(/'/g, "&#39;");
}

/**
 * `env[model].get_empty_list_help(help)`: base returns the help (ir_ui_view.py:2813-2822); mail.thread models add the
 * "Create new document" paragraph when the help is empty (mail_thread.py:441-490). The alias branches need
 * `empty_list_help_model` in the context, which refuses.
 */
export function getEmptyListHelp(env: Environment, model: string, help: unknown): unknown {
  const def = env.reg.model(model);
  if (!def.isMailThread) return help;
  if (env.context["empty_list_help_model"]) throw new NotPorted("get_empty_list_help with empty_list_help_model (mail aliases)");
  const docName = env.context["empty_list_help_document_name"];
  const document = typeof docName === "string" ? docName : mailT(env, "document");
  if (isHtmlEmpty(help)) {
    const dyn = mailT(env, "Create new %(document)s").replace("%(document)s", htmlEscape(document));
    return `<p class='o_view_nocontent_smiling_face'>${dyn}</p>`;
  }
  return help;
}

// ---------------------------------------------------------------------------------------------------------------
// res.users.action_get / preference_save
// ---------------------------------------------------------------------------------------------------------------

/** res_users.py:828-830: `self.sudo().env.ref('base.action_res_users_my').read()[0]`. */
async function actionGet(env: Environment): Promise<RecordValues> {
  const su = env.sudo();
  const r = await su.cr.query<{ res_id: number; model: string }>(
    "SELECT res_id, model FROM ir_model_data WHERE module = 'base' AND name = 'action_res_users_my'");
  const ref = r.rows[0];
  if (ref === undefined) throw new NotPorted("env.ref('base.action_res_users_my') missing (ValueError)");
  if (ref.model !== "ir.actions.act_window") throw new NotPorted(`base.action_res_users_my of model ${ref.model}`);
  const rows = await su.model("ir.actions.act_window").read([ref.res_id], []);
  const values = rows[0];
  if (values === undefined) throw new NotPorted("base.action_res_users_my record missing");
  // ir_actions.py:325-339: help through get_empty_list_help of the action's res_model, with the action context
  const resModel = values["res_model"];
  if (typeof resModel === "string" && su.reg.models.has(resModel)) {
    const actionContext = values["context"];
    if (typeof actionContext === "string" && actionContext.trim() !== "{}" && actionContext.trim() !== "") {
      throw new NotPorted(`act_window.read help with action context ${actionContext}`);
    }
    values["help"] = getEmptyListHelp(su, resModel, values["help"]);
  }
  return values;
}

registerMethod("res.users", "action_get", async (env) => actionGet(env), { apiModel: true });

// res_users.py:1114-1119
registerMethod("res.users", "preference_save", async () => ({ type: "ir.actions.client", tag: "reload_context" }), { apiModel: false });

// ---------------------------------------------------------------------------------------------------------------
// res.users fields of the preferences form
// ---------------------------------------------------------------------------------------------------------------

registerHooks("res.users", {
  selection: {
    // related partner_id.lang / partner_id.tz: res_partner.py:304 _lang_get, :131-134 _tz_get
    lang: async (env) => (await env.cr.query<{ code: string; name: string }>("SELECT code, name FROM res_lang WHERE active ORDER BY name")).rows.map((r) => [r.code, r.name]),
    // the related field describes its target's selection (res_partner.py:131-134 `_tzs`, static): the
    // res.partner.tz rows of ir_model_fields_selection with their labels in the env language
    tz: async (env) => {
      const target = env.reg.model("res.partner").fields.get("tz")?.selection ?? null;
      if (target === null || !target.length) throw new NotPorted("res.users.tz selection without res.partner.tz selection rows");
      const lang = env.lang ?? "en_US";
      return target.map((s) => [s.value, s.labels[lang] ?? s.label] as [string, string]);
    },
  },
});

// ---------------------------------------------------------------------------------------------------------------
// res.users computed fields of the preferences form
// ---------------------------------------------------------------------------------------------------------------

/** res_users.py:430-446 `_compute_role` (session/user.ts userRole implements `_is_light_groups`). */
async function computeRole(env: Environment, ids: readonly number[]): Promise<Map<number, unknown>> {
  const out = new Map<number, unknown>();
  for (const id of ids) out.set(id, await userRole(env.cr, await userGroupIds(env.cr, id)));
  return out;
}

/** res_users.py:565-568 `_compute_tz_offset`: `datetime.now(ZoneInfo(user.tz or 'UTC')).strftime('%z')`. */
async function computeTzOffset(env: Environment, ids: readonly number[]): Promise<Map<number, unknown>> {
  const rows = (await env.cr.query<{ id: number; tz: string | null }>(
    "SELECT u.id, p.tz FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = ANY($1::int[])", [ids])).rows;
  const out = new Map<number, unknown>();
  for (const r of rows) {
    out.set(r.id, await tzOffset(env, r.tz || "UTC"));
  }
  return out;
}

async function tzOffset(env: Environment, tz: string): Promise<string> {
  if (!isTimezone(tz)) throw new NotPorted(`tz_offset of an unknown time zone ${tz} (ZoneInfo raises)`);
  // the database's now(): the harness freezes it per copy (ARCHITECTURE.md Time)
  const now = (await env.cr.query<{ s: number }>("SELECT extract(epoch FROM now())::float8 AS s")).rows[0]?.s ?? 0;
  const utc = new Date(Math.floor(now) * 1000);
  const local = utcToLocal(utc, tz);
  const minutes = Math.round((Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - utc.getTime()) / 60000);
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}${String(abs % 60).padStart(2, "0")}`;
}

/** The computes of the form on a new user; records go through the `computed` hooks below. */
const refuseRecord = (rec: Rec, name: string): void => {
  if (rec.id !== null) throw new NotPorted(`res.users.${name} compute on a record`);
};
registerRecordCompute("res.users", {
  // res_users.py:565-568 with the tz of the new user
  tz_offset: async (env, rec) => {
    refuseRecord(rec, "tz_offset");
    return tzOffset(env, String((await rec.get("tz")) || "UTC"));
  },
  // mail res_users.py:85-87
  has_external_mail_server: async (env, rec) => {
    refuseRecord(rec, "has_external_mail_server");
    return (await computeHasExternalMailServer(env, [env.uid])).get(env.uid) ?? false;
  },
  // mail res_users.py:155-180: no server owned by a new user; one matching its email refuses
  outgoing_mail_server_id: async (env, rec) => {
    refuseRecord(rec, "outgoing_mail_server_id");
    const email = await rec.get("email");
    if (email && (await env.cr.query("SELECT 1 FROM ir_mail_server WHERE from_filter ILIKE '%@%' AND (smtp_user = $1 OR from_filter = $2) LIMIT 1", [email, emailNormalize(String(email))])).rows.length) {
      throw new NotPorted("res.users.outgoing_mail_server_id of a new user matching a mail server");
    }
    return null;
  },
  outgoing_mail_server_type: async (_env, rec) => {
    refuseRecord(rec, "outgoing_mail_server_type");
    return "default";
  },
  totp_enabled: async (_env, rec) => {
    refuseRecord(rec, "totp_enabled");
    return false;
  },
  // models.py:1504 _compute_display_name of `name`, the _rec_name
  display_name: async (env, rec) => {
    if (rec.id === null) return (await rec.get("name")) || false;
    return (await env.model("res.users").displayName([rec.id])).get(rec.id) ?? false;
  },
});

/** mail/models/res_users.py:85-87 `_compute_has_external_mail_server` (compute_sudo). */
async function computeHasExternalMailServer(env: Environment, ids: readonly number[]): Promise<Map<number, unknown>> {
  const v = (await env.cr.query<{ value: string }>("SELECT value FROM ir_config_parameter WHERE key = 'base_setup.default_external_email_server'")).rows[0]?.value;
  // ir.config_parameter.get_bool: str2bool(value, default=False)
  const on = v !== undefined && ["y", "yes", "1", "true", "t", "on"].includes(v.trim().toLowerCase());
  return new Map(ids.map((id) => [id, on]));
}

/**
 * mail/models/res_users.py:155-181 `_compute_outgoing_mail_server_id` (both fields): the user's own ir.mail_server
 * whose from_filter is the user's normalized email and smtp_user the email; types are the selection keys
 * (mail 'default', google_gmail 'gmail', microsoft_outlook 'outlook').
 */
async function outgoingMailServer(env: Environment, ids: readonly number[]): Promise<Map<number, { id: number | false; type: string }>> {
  const out = new Map<number, { id: number | false; type: string }>(ids.map((id) => [id, { id: false, type: "default" }]));
  let todo = [...ids];
  if (!(env.su || (await hasGroup(env, "base.group_user")))) todo = todo.filter((id) => id === env.uid);
  if (!todo.length) return out;
  const rows = (await env.cr.query<{ uid: number; server_id: number; smtp_authentication: string | null }>(
    `SELECT u.id AS uid, s.id AS server_id, s.smtp_authentication
       FROM res_users u JOIN res_partner p ON p.id = u.partner_id
       JOIN ir_mail_server s ON s.owner_user_id = u.id AND s.from_filter = p.email_normalized AND s.smtp_user = p.email
      WHERE u.id = ANY($1::int[]) AND s.active AND s.from_filter ILIKE '%_@_%'
      ORDER BY s.sequence, s.id`, [todo])).rows;
  const types = ["default", "gmail", "outlook"];
  for (const r of rows) {
    // `{m.owner_user_id: m for m in mail_servers}`: the last server of the search order wins
    out.set(r.uid, { id: r.server_id, type: r.smtp_authentication !== null && types.includes(r.smtp_authentication) ? r.smtp_authentication : "default" });
  }
  return out;
}

/** auth_totp/models/res_users.py:58-64 `_compute_totp_enabled`. */
async function computeTotpEnabled(env: Environment, ids: readonly number[]): Promise<Map<number, unknown>> {
  const out = new Map<number, unknown>(ids.map((id) => [id, false]));
  let todo = [...ids];
  if (!(env.su || (await hasGroup(env, "base.group_erp_manager")))) todo = todo.filter((id) => id === env.uid);
  if (!todo.length) return out;
  const rows = (await env.cr.query<{ id: number; on: boolean }>(
    "SELECT id, totp_secret IS NOT NULL AND totp_secret <> '' AS on FROM res_users WHERE id = ANY($1::int[])", [todo])).rows;
  for (const r of rows) out.set(r.id, r.on);
  return out;
}

registerHooks("res.users", {
  computed: {
    role: computeRole,
    tz_offset: computeTzOffset,
    has_external_mail_server: computeHasExternalMailServer,
    outgoing_mail_server_id: async (env, ids) => new Map([...(await outgoingMailServer(env, ids))].map(([id, v]) => [id, v.id])),
    outgoing_mail_server_type: async (env, ids) => new Map([...(await outgoingMailServer(env, ids))].map(([id, v]) => [id, v.type])),
    totp_enabled: computeTotpEnabled,
  },
});

// ---------------------------------------------------------------------------------------------------------------
// res.session / res.device (base/models/res_device.py), the sessions list of the preferences form
// ---------------------------------------------------------------------------------------------------------------

/** odoo/tools/_vendor/useragents.py:19-110 UserAgentParser: (platform, browser, version, language). */
const UA_PLATFORMS: readonly (readonly [RegExp, string])[] = [
  [/cros/i, "chromeos"], [/iphone|ios/i, "iphone"], [/ipad/i, "ipad"], [/darwin|mac|os\s*x/i, "macos"], [/win/i, "windows"],
  [/android/i, "android"], [/netbsd/i, "netbsd"], [/openbsd/i, "openbsd"], [/freebsd/i, "freebsd"], [/dragonfly/i, "dragonflybsd"],
  [/(sun|i86)os/i, "solaris"], [/x11|lin(\b|ux)?/i, "linux"], [/nintendo\s+wii/i, "wii"], [/irix/i, "irix"], [/hp-?ux/i, "hpux"],
  [/aix/i, "aix"], [/sco|unix_sv/i, "sco"], [/bsd/i, "bsd"], [/amiga/i, "amiga"], [/blackberry|playbook/i, "blackberry"], [/symbian/i, "symbian"],
];
const UA_BROWSERS: readonly (readonly [string, string])[] = [
  ["googlebot", "google"], ["msnbot", "msn"], ["yahoo", "yahoo"], ["ask jeeves", "ask"], ["aol|america\\s+online\\s+browser", "aol"],
  ["opera", "opera"], ["edge", "edge"], ["chrome|crios", "chrome"], ["seamonkey", "seamonkey"], ["firefox|firebird|phoenix|iceweasel", "firefox"],
  ["galeon", "galeon"], ["safari|version", "safari"], ["webkit", "webkit"], ["camino", "camino"], ["konqueror", "konqueror"],
  ["k-meleon", "kmeleon"], ["netscape", "netscape"], ["msie|microsoft\\s+internet\\s+explorer|trident/.+? rv:", "msie"], ["lynx", "lynx"],
  ["links", "links"], ["Baiduspider", "baidu"], ["bingbot", "bing"], ["mozilla", "mozilla"],
];
const UA_BROWSER_RES = UA_BROWSERS.map(([re, name]) => [new RegExp(`(?:${re})[/\\sa-z(]*(\\d+[.\\da-z]+)?`, "i"), name] as const);
const UA_LANGUAGE = /(?:;\s*|\s+)(\b\w{2}\b(?:-\b\w{2}\b)?)\s*;|(?:\(|\[|;)\s*(\b\w{2}\b(?:-\b\w{2}\b)?)\s*(?:\]|\)|;)/;

export function parseUserAgent(ua: string): [string | null, string | null, string | null, string | null] {
  let platform: string | null = null;
  for (const [re, name] of UA_PLATFORMS) if (re.test(ua)) { platform = name; break; }
  let browser: string | null = null;
  let version: string | null = null;
  for (const [re, name] of UA_BROWSER_RES) {
    const m = re.exec(ua);
    if (m !== null) { browser = name; version = m[1] ?? null; break; }
  }
  const lm = UA_LANGUAGE.exec(ua);
  const language = lm === null ? null : (lm[1] ?? lm[2] ?? null);
  return [platform, browser, version, language];
}

const MOBILE_PLATFORMS = ["android", "iphone", "ipad", "ipod", "blackberry", "windows phone", "webos"];

/** res_device.py:215-221 `_compute_device_info` ('Unknown' through base's _(), src/orm/code_translations.ts). */
function deviceInfo(env: Environment, ua: string | null): Record<string, string> {
  const [platform, browser, version, language] = parseUserAgent(ua ?? "");
  const unknown = (v: string | null): string => v ? v : codeT(env, "Unknown", "base");
  const p = unknown(platform);
  return { platform: p, browser: unknown(browser), browser_version: unknown(version), browser_language: unknown(language),
    device_type: MOBILE_PLATFORMS.includes(p) ? "mobile" : "computer" };
}

/** Python `str.capitalize()`. */
function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1).toLowerCase() : s;
}

interface DeviceRow { id: number; session_identifier: string; ip_address: string | null; user_agent: string | null; country: string | null; city: string | null; first_activity: string | null; last_activity: string | null }

function sessionIdentifier(env: Environment): string | null {
  const info = requestInfo(env);
  return info === null ? null : info.sid().slice(0, STORED_SESSION_BYTES);
}

/** res_device.py:202-212 res.device `_compute_is_current`: same session, ip (collapsed) and user agent. */
function deviceIsCurrent(env: Environment, d: DeviceRow): boolean {
  const info = requestInfo(env);
  if (info === null) return false;
  return d.session_identifier === info.sid().slice(0, STORED_SESSION_BYTES) && d.ip_address === collapseIpAddress(info.remoteAddr) && d.user_agent === info.userAgent;
}

async function deviceRows(env: Environment, table: "res_device" | "res_session", ids: readonly number[]): Promise<Map<number, { session_identifier: string; user_agent: string | null }>> {
  const col = table === "res_device" ? "user_agent" : "NULL::varchar AS user_agent";
  const rows = (await env.cr.query<{ id: number; session_identifier: string; user_agent: string | null }>(
    `SELECT id, session_identifier, ${col} FROM ${table} WHERE id = ANY($1::int[])`, [ids])).rows;
  return new Map(rows.map((r) => [r.id, r]));
}

/** res_device.py:289-316 res.session `_compute_session_info`: the session's devices, most recent first. */
async function sessionInfo(env: Environment, ids: readonly number[]): Promise<Map<number, Record<string, unknown>>> {
  const sessions = await deviceRows(env, "res_session", ids);
  const idents = [...new Set([...sessions.values()].map((s) => s.session_identifier))];
  // res.device is itself a view; `sorted('last_activity', reverse=True)` (stable over the _read_group id order)
  const devices = (await env.cr.query<DeviceRow>(
    `SELECT id, session_identifier, ip_address, user_agent, country, city, first_activity::text, last_activity::text
       FROM res_device WHERE session_identifier = ANY($1::varchar[]) ORDER BY last_activity DESC NULLS LAST, id`, [idents])).rows;
  const current = sessionIdentifier(env);
  const out = new Map<number, Record<string, unknown>>();
  for (const id of ids) {
    const s = sessions.get(id);
    if (s === undefined) continue;
    const list = devices.filter((d) => d.session_identifier === s.session_identifier);
    let last = list[0];
    if (last === undefined) throw new NotPorted(`res.session ${id} without res.device rows`);
    if (current !== null && s.session_identifier === current) {
      const cur = list.find((d) => deviceIsCurrent(env, d));
      if (cur !== undefined) last = cur;
    }
    const firsts = list.map((d) => d.first_activity).filter((x): x is string => x !== null).sort();
    out.set(id, {
      device_ids: list.map((d) => d.id), ip_address: last.ip_address ?? false, user_agent: last.user_agent ?? false,
      country: last.country ?? false, city: last.city ?? false, first_activity: firsts[0] ?? false,
    });
  }
  return out;
}

function pick(field: string): (env: Environment, ids: readonly number[]) => Promise<Map<number, unknown>> {
  return async (env, ids) => new Map([...(await sessionInfo(env, ids))].map(([id, v]) => [id, v[field]]));
}

async function sessionUserAgents(env: Environment, ids: readonly number[]): Promise<Map<number, string | null>> {
  const info = await sessionInfo(env, ids);
  return new Map([...info].map(([id, v]) => [id, typeof v["user_agent"] === "string" ? v["user_agent"] : null]));
}

function deviceInfoField(table: "res_device" | "res_session", field: string): (env: Environment, ids: readonly number[]) => Promise<Map<number, unknown>> {
  return async (env, ids) => {
    const uas = table === "res_session" ? await sessionUserAgents(env, ids)
      : new Map([...(await deviceRows(env, "res_device", ids))].map(([id, r]) => [id, r.user_agent]));
    return new Map(ids.map((id) => [id, deviceInfo(env, uas.get(id) ?? null)[field]]));
  };
}

const DEVICE_INFO_FIELDS = ["platform", "browser", "browser_version", "browser_language", "device_type"];

registerHooks("res.session", {
  computed: {
    ...Object.fromEntries(["device_ids", "ip_address", "user_agent", "country", "city", "first_activity"].map((f) => [f, pick(f)])),
    ...Object.fromEntries(DEVICE_INFO_FIELDS.map((f) => [f, deviceInfoField("res_session", f)])),
    // res_device.py:281-287
    is_current: async (env, ids) => {
      const current = sessionIdentifier(env);
      const rows = await deviceRows(env, "res_session", ids);
      return new Map(ids.map((id) => [id, current !== null && rows.get(id)?.session_identifier === current]));
    },
  },
  // res_device.py:322-325 `_order_field_to_sql`: is_current orders by `session_identifier = <current sid>`; the field
  // has no SQL otherwise (Odoo refuses it in domains, this expression would not)
  computeSql: {
    is_current: async (table) => {
      const current = sessionIdentifier(table.env);
      if (current === null) throw new NotPorted("res.session.is_current in SQL outside a request");
      return sql`(${await table.field("session_identifier")} = ${current})`;
    },
  },
  // res_device.py:318-320 `_compute_display_name`: "<Platform> <Browser>"
  displayName: async (env, ids) => {
    const uas = await sessionUserAgents(env, ids);
    return new Map(ids.map((id) => {
      const i = deviceInfo(env, uas.get(id) ?? null);
      return [id, `${capitalize(i["platform"]!)} ${capitalize(i["browser"]!)}`];
    }));
  },
});

registerHooks("res.device", {
  computed: {
    ...Object.fromEntries(DEVICE_INFO_FIELDS.map((f) => [f, deviceInfoField("res_device", f)])),
    is_current: async (env, ids) => {
      const rows = (await env.cr.query<DeviceRow>(
        `SELECT id, session_identifier, ip_address, user_agent, country, city, first_activity::text, last_activity::text FROM res_device WHERE id = ANY($1::int[])`, [ids])).rows;
      return new Map(rows.map((r) => [r.id, deviceIsCurrent(env, r)]));
    },
  },
});

// ---------------------------------------------------------------------------------------------------------------
// res.users writes of `_inherits` fields only (the preferences dialog's `lang`/`tz`, the login's `tz`)
// ---------------------------------------------------------------------------------------------------------------

/** base/models/res_users.py:243-249: the inherited fields marked `user_writeable` (no installed module adds more). */
const USER_WRITEABLE_INHERITED = new Set(["name", "email", "phone", "image_1920", "lang", "tz"]);

/**
 * models.py:3805-3990 `write` on res.users when every written field is delegated to the partner (`_inherits`,
 * related `partner_id.<f>` with `inherited=True`): the magic columns of the res_users rows (:3863-3867), then the
 * related inverse (fields.py:799-813) writes the partner as the same user; an AccessError there is reworded
 * (:3962-3971). res.users `_has_field_access` (res_users.py:651-660) allows the write for user_writeable fields, the
 * superuser and base.group_erp_manager. Any other vals go to the ORM core (src/orm/write.ts), which refuses
 * `_inherits` models: this override is the narrow case the scenarios reach until the core handles delegation.
 */
registerOverrides("res.users", {
  write: async (env, ids, vals, next) => {
    // base res_users.py:682-690: the superuser cannot be activated, the current user not deactivated (before super())
    const refuse = (message: string): never => {
      if (env.lang && env.lang !== "en_US") throw new NotPorted(`res.users write error in ${env.lang}`);
      throw new UserError(message);
    };
    if (vals["active"] && ids.includes(1)) refuse("You cannot activate the superuser.");
    if (vals["active"] === false && ids.includes(env.uid)) refuse("You cannot deactivate the user you're currently logged in as.");
    if (vals["active"]) {
      // `self.partner_id.action_unarchive()` first: nothing to do when the partners are active; then super().write,
      // whose access checks refuse a user who may not write `active`
      const archived = (await env.cr.query("SELECT 1 FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = ANY($1::int[]) AND NOT p.active LIMIT 1", [[...ids]])).rows.length;
      if (archived) throw new NotPorted("res.users write of active (the partners are unarchived first)");
    }
    const rest = (): Promise<void> => writeRest(env, ids, vals, next);
    if ("active" in vals && !vals["active"]) return archiveUsers(env, ids, rest);
    return rest();
  },
});

/**
 * Archiving users: auth_signup res_users.py:316-319 (before super) `self.partner_id.sudo().signup_cancel()`, then the
 * write, then discuss res_users.py:19-22 `_unsubscribe_from_non_public_channels(reset_role=True)` (:35-52): the members
 * leave the group-restricted channels none of the partner's other active users may see. A member with a channel
 * role (reset first) refuses.
 */
async function archiveUsers(env: Environment, ids: readonly number[], rest: () => Promise<void>): Promise<void> {
  const partners = (await env.cr.query<{ id: number; t: string | null }>(
    `SELECT DISTINCT p.id, p.signup_type AS t FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = ANY($1::int[]) ORDER BY p.id`, [[...ids]])).rows;
  // (fields.py `_filter_not_equal`: an empty signup_type stays clean, the write still logs write_date)
  const dirty = partners.filter((p) => p.t !== null).map((p) => p.id);
  const clean = partners.filter((p) => p.t === null).map((p) => p.id);
  if (dirty.length) await write(env.sudo(), "res.partner", dirty, { signup_type: false });
  if (clean.length) await write(env.sudo(), "res.partner", clean, {});
  if (!env.reg.models.has("discuss.channel.member")) return rest();
  const roles = (await env.cr.query(
    "SELECT 1 FROM discuss_channel_member WHERE partner_id IN (SELECT partner_id FROM res_users WHERE id = ANY($1::int[])) AND channel_role IS NOT NULL LIMIT 1", [[...ids]])).rows;
  if (roles.length) throw new NotPorted("archiving a user who has a channel role (reset_role)");
  const leave = await nonPublicMembers(env, ids);
  if (!leave.length) return rest();
  const ctx = requestOfCursor(env.cr);
  if (!ctx) throw new NotPorted("res.users archive leaving channels outside a request");
  await withStoreVersionAtEnd(ctx, env, async () => {
    await rest();
    await unlinkMembers(env.sudo(), leave);
  });
}

/** The rest of the write: the groups, the delegated fields, else the ORM core. */
async function writeRest(env: Environment, ids: readonly number[], vals: Record<string, unknown>, next: WriteNext): Promise<void> {
  {
    const def = env.reg.model("res.users");
    const names = Object.keys(vals);
    const delegated = names.filter((n) => def.fields.get(n)?.inheritedFrom === "res.partner");
    // the groups and the notification type: src/models/res_users_groups.ts (discuss, mail and base res_users.py writes)
    if ("group_ids" in vals || "notification_type" in vals) return groupsWrite(env, ids, vals, next);
    if (!names.length || delegated.length !== names.length) return next(env, ids, vals);
    if (!env.su) {
      const existing = (await env.cr.query<{ id: number }>("SELECT id FROM res_users WHERE id = ANY($1::int[])", [ids])).rows;
      if (existing.length !== new Set(ids).size) return next(env, ids, vals); // MissingError path of the core
      await env.model("res.users").checkAccess(ids, "write");
      const manager = await hasGroup(env, "base.group_erp_manager");
      for (const n of delegated) {
        await checkFieldAccess(env, def, def.fields.get(n)!, "write");
        if (!manager && !USER_WRITEABLE_INHERITED.has(n)) throw new NotPorted(`res.users write of ${n} by a non-manager (_has_field_access AccessError)`);
      }
    }
    await env.cr.query(
      "UPDATE res_users SET write_uid = $2, write_date = now() AT TIME ZONE 'UTC' WHERE id = ANY($1::int[])", [ids, env.uid]);
    const partners = (await env.cr.query<{ partner_id: number }>(
      "SELECT DISTINCT partner_id FROM res_users WHERE id = ANY($1::int[]) AND partner_id IS NOT NULL", [ids])).rows.map((r) => r.partner_id);
    try {
      await write(env, "res.partner", partners, { ...vals });
    } catch (e) {
      if (e instanceof AccessError) {
        const lang = env.lang ?? "en_US";
        if (lang !== "en_US") throw new NotPorted(`translated implicit-access AccessError (${lang})`);
        throw new AccessError(`${e.message}\n\nImplicitly accessed through '${def.descriptions[lang] ?? def.description}' (res.users).`);
      }
      throw e;
    }
  }
}

/** res_partner.py:505-507 `_compute_tz_offset`, the same as the user's. */
registerHooks("res.partner", {
  computed: {
    tz_offset: async (env, ids) => {
      const rows = (await env.cr.query<{ id: number; tz: string | null }>("SELECT id, tz FROM res_partner WHERE id = ANY($1::int[])", [ids])).rows;
      const out = new Map<number, unknown>();
      for (const r of rows) out.set(r.id, await tzOffset(env, r.tz || "UTC"));
      return out;
    },
  },
});
