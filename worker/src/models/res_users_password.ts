/**
 * Changing one's password and the identity check:
 *  - base res_users.py:1018-1046 `change_password(old, new)` (the old password checked, `_change_password`), :1133-1139
 *    `preference_change_password`, :98-137 `check_identity` (the res.users.identitycheck wizard unless the identity was
 *    checked in the last ten minutes), :1487-1526 the wizard's `run_check`, :1574-1593 change.password.own;
 *  - the write of `password` (`_set_password` :287-299, a 600,000-round pbkdf2_sha512 hash with a random salt, in the
 *    session Durable Object, src/session/auth.ts) and mail res_users.py:246-250 + :310-398 `_notify_security_setting_update`:
 *    the "Security Update: Password Changed" mail (mail.account_security_alert with auth_totp_mail's 2FA suggestion,
 *    in mail.mail_notification_light), created as sudo and sent at once (the refused SMTP connection, D9).
 * The session that changed the password keeps its old token, so it is logged out (the token follows the hash).
 * The mail in another language takes the terms of the stored views in that language (src/mail/view_terms.ts); the long
 * date is written for en_US and sv_SE only. A GeoIP location and users without an email refuse.
 */
import { AccessDenied, NotPorted, UserError, ValidationError } from "../errors";
import { requestOfCursor, type RequestContext } from "../http/context";
import { dumps } from "../http/json";
import { escapeText, formatAddr, emailNormalize, insertMessages, partnerEmailFormatted, replyToDefault, trackingMessageId } from "../mail/message";
import { lightLayout } from "../mail/notify_layout";
import { smtpConnectFailure } from "../mail/notify";
import { messagePreview } from "./mail_notify_layout";
import { create } from "../orm/create";
import { registerDefaults } from "../orm/recompute";
import { registerOverrides } from "../orm/write";
import { lookupMethod, registerMethod } from "../http/methods";
import { unlink } from "../orm/unlink";
import type { Environment } from "../orm/types";
import { checkPassword } from "../session/auth";
import { envFor } from "../web/common";
import { dbNow, translate, validTz } from "./util";
import { viewTerms } from "../mail/view_terms";
import * as priv from "../orm/dispatch_gen";

/** odoo/tools/_vendor/useragents.py:19-72 (werkzeug's UserAgentParser, case-insensitive). */
const PLATFORMS: readonly [RegExp, string][] = ([
  ["cros", "chromeos"], ["iphone|ios", "iphone"], ["ipad", "ipad"], ["darwin|mac|os\\s*x", "macos"], ["win", "windows"],
  ["android", "android"], ["netbsd", "netbsd"], ["openbsd", "openbsd"], ["freebsd", "freebsd"], ["dragonfly", "dragonflybsd"],
  ["(sun|i86)os", "solaris"], ["x11|lin(\\b|ux)?", "linux"], ["nintendo\\s+wii", "wii"], ["irix", "irix"], ["hp-?ux", "hpux"],
  ["aix", "aix"], ["sco|unix_sv", "sco"], ["bsd", "bsd"], ["amiga", "amiga"], ["blackberry|playbook", "blackberry"], ["symbian", "symbian"],
] as const).map(([r, n]) => [new RegExp(r, "i"), n]);
const BROWSERS: readonly [RegExp, string][] = ([
  ["googlebot", "google"], ["msnbot", "msn"], ["yahoo", "yahoo"], ["ask jeeves", "ask"], ["aol|america\\s+online\\s+browser", "aol"],
  ["opera", "opera"], ["edge", "edge"], ["chrome|crios", "chrome"], ["seamonkey", "seamonkey"], ["firefox|firebird|phoenix|iceweasel", "firefox"],
  ["galeon", "galeon"], ["safari|version", "safari"], ["webkit", "webkit"], ["camino", "camino"], ["konqueror", "konqueror"],
  ["k-meleon", "kmeleon"], ["netscape", "netscape"], ["msie|microsoft\\s+internet\\s+explorer|trident/.+? rv:", "msie"], ["lynx", "lynx"],
  ["links", "links"], ["Baiduspider", "baidu"], ["bingbot", "bing"], ["mozilla", "mozilla"],
] as const).map(([r, n]) => [new RegExp(`(?:${r})[/\\sa-z(]*(\\d+[.\\da-z]+)?`, "i"), n]);

export function parseUserAgent(ua: string): { platform: string | null; browser: string | null } {
  return { platform: PLATFORMS.find(([r]) => r.test(ua))?.[1] ?? null, browser: BROWSERS.find(([r]) => r.test(ua))?.[1] ?? null };
}

/** Python `str.capitalize`. */
const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * tools/misc.py:1442-1490 `format_datetime(env, value, dt_format='long')` in en_US: babel's long pattern
 * "MMMM d, y 'at' h:mm:ss a z", the zone written as its offset (+0100), in the user's time zone.
 */
function formatLong(utc: Date, tz: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(utc).map((p) => [p.type, p.value]));
  const local = Date.UTC(Number(parts["year"]), Number(parts["month"]) - 1, Number(parts["day"]), Number(parts["hour"]) % 24, Number(parts["minute"]), Number(parts["second"]));
  const offset = Math.round((local - Math.floor(utc.getTime() / 1000) * 1000) / 60000);
  const sign = offset < 0 ? "-" : "+";
  const z = `${sign}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}${String(Math.abs(offset) % 60).padStart(2, "0")}`;
  const h24 = Number(parts["hour"]) % 24;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${MONTHS[Number(parts["month"]) - 1]} ${Number(parts["day"])}, ${parts["year"]} at ${h12}:${parts["minute"]}:${parts["second"]} ${h24 < 12 ? "AM" : "PM"} ${z}`;
}

const SV_MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
// babel 2.10.3 sv `z` (short specific non-location): the metazone's short names where sv has them, else the
// offset as ±HHMM (checked for these zones against the oracle's babel, 2026-11-07)
const SV_CET = new Set(["Europe/Brussels", "Europe/Stockholm", "Europe/Paris", "Europe/Berlin", "Europe/Amsterdam", "Europe/Copenhagen",
  "Europe/Oslo", "Europe/Madrid", "Europe/Rome", "Europe/Vienna", "Europe/Zurich", "Europe/Prague", "Europe/Warsaw", "Europe/Budapest", "Europe/Luxembourg"]);
const SV_EET = new Set(["Europe/Helsinki", "Europe/Athens", "Europe/Riga", "Europe/Tallinn", "Europe/Vilnius", "Europe/Sofia", "Europe/Bucharest"]);

/** The wall clock of `utc` in `tz` and its offset in minutes. */
function wallClock(utc: Date, tz: string): { y: number; mo: number; d: number; h: number; mi: string; s: string; offset: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(utc).map((p) => [p.type, p.value]));
  const h = Number(parts["hour"]) % 24;
  const local = Date.UTC(Number(parts["year"]), Number(parts["month"]) - 1, Number(parts["day"]), h, Number(parts["minute"]), Number(parts["second"]));
  return { y: Number(parts["year"]), mo: Number(parts["month"]), d: Number(parts["day"]), h, mi: parts["minute"]!, s: parts["second"]!,
    offset: Math.round((local - Math.floor(utc.getTime() / 1000) * 1000) / 60000) };
}

/** babel `format_datetime(dt, 'long', locale='sv_SE')`: "d MMMM y HH:mm:ss z" ("{1} {0}"). */
export function formatLongSv(utc: Date, tz: string): string {
  const w = wallClock(utc, tz);
  let z: string;
  if (tz === "UTC" || tz === "Etc/UTC") z = "UTC";
  else if (SV_CET.has(tz) && (w.offset === 60 || w.offset === 120)) z = w.offset === 60 ? "CET" : "CEST";
  else if (SV_EET.has(tz) && (w.offset === 120 || w.offset === 180)) z = w.offset === 120 ? "EET" : "EEST";
  else {
    const sign = w.offset < 0 ? "-" : "+";
    const abs = Math.abs(w.offset);
    const hh = Math.floor(abs / 60);
    const mm = abs % 60;
    z = mm === 0 ? `GMT${sign}${hh}` : `GMT${sign}${hh}:${String(mm).padStart(2, "0")}`;
  }
  return `${w.d} ${SV_MONTHS[w.mo - 1]} ${w.y} ${String(w.h).padStart(2, "0")}:${w.mi}:${w.s} ${z}`;
}

const qesc = (s: string): string => escapeText(s).replace(/"/g, "&quot;");

/** mail res_users.py:310-362 for one user, with :364-398 `_notify_security_setting_update_prepare_values`. */
async function notifySecurityUpdate(env: Environment, ctx: RequestContext, userId: number, subject: string, content: string): Promise<void> {
  const lang = env.lang ?? "en_US";
  // `_render_template` (qweb_view) and `_render_encapsulate` render in the env's language
  const tr = await viewTerms(env, ["mail.account_security_alert", "auth_totp_mail.account_security_alert", "mail.mail_notification_light"]);
  const u = (await env.cr.query<{ name: string | null; email: string | null; partner_id: number; company_id: number; tz: string | null; totp: boolean }>(
    `SELECT p.name, p.email, u.partner_id, u.company_id, p.tz, u.totp_secret IS NOT NULL AS totp FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1`, [userId])).rows[0];
  if (!u) return;
  const email = emailNormalize(u.email);
  if (!email) return;
  const reset = (await env.cr.query<{ v: string | null }>("SELECT value AS v FROM ir_config_parameter WHERE key = 'auth_signup.reset_password'")).rows[0]?.v;
  // ir_config_parameter `get_bool`: a set, non-falsy value
  const suggestReset = Boolean(reset) && !["False", "false", "0", ""].includes(reset ?? "");
  const baseUrl = (await env.cr.query<{ v: string | null }>("SELECT value AS v FROM ir_config_parameter WHERE key = 'web.base.url'")).rows[0]?.v ?? "";
  // :381-391 request.geoip: none here (no GeoIP database, as the oracle)
  const ua = parseUserAgent(ctx.userAgent);
  // the env user's time zone (format_datetime `tz or env.user.tz`)
  const rawTz = (await env.cr.query<{ tz: string | null }>("SELECT p.tz FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1", [env.uid])).rows[0]?.tz;
  const envTz = validTz(rawTz) ?? "UTC";
  const now = await dbNow(env);
  const when = lang === "sv_SE" ? formatLongSv(now, envTz) : formatLong(now, envTz);
  let body = `\n        <div>\n            ${tr("Dear")} ${escapeText(u.name ?? "")}${tr(",")}<br/><br/>\n            ${escapeText(content)} <br/><br/>\n\n            ${tr("Here are some details about the connection:")}<br/>\n            <ul>\n                <li><span style="font-weight: bold">\n                    ${tr("Date:")}</span> ${escapeText(when)}</li>`;
  if (ua.platform) body += `\n                <li><span style="font-weight: bold">\n                    ${tr("Platform:")}</span> ${escapeText(capitalize(ua.platform))}</li>`;
  if (ua.browser) body += `\n                <li><span style="font-weight: bold">\n                    ${tr("Browser:")}</span> ${escapeText(capitalize(ua.browser))}</li>`;
  body += `\n                <li><span style="font-weight: bold">\n                    ${tr("IP Address:")}</span> ${escapeText(ctx.remoteAddr)}</li>\n            </ul>\n`;
  if (suggestReset) {
    body += `\n            <div class="o_mail_account_security_suggestions">\n                ${tr("If you don't recognize it, you should change your password immediately via this link:")}<br/>\n                <div style="margin: 16px 0px 16px 0px">\n                    <a style="background-color: #875A7B; padding: 8px 16px 8px 16px; text-decoration: none; color: #fff; border-radius: 5px; font-size:13px" href="${qesc(baseUrl)}/web/reset_password">\n                        ${tr("Reset Password")}\n                    </a>\n                </div>\n                ${tr("Otherwise, you can safely ignore this email.")}\n            </div>`;
  }
  // auth_totp_mail res_users.py:69-78: the 2FA suggestion unless 2FA is on
  if (!u.totp) body += `\n                <div>\n                    <span>${tr("Consider also")}</span>\n                    <a href="https://www.odoo.com/documentation/latest/applications/general/auth/2fa.html">\n                        ${tr("activating Two-factor Authentication")}\n                    </a>\n                </div>`;
  body += "\n        </div>";
  const company = (await env.cr.query<{ name: string; phone: string | null; email: string | null; website: string | null; s: string | null; logo: boolean | null; partner: number }>(
    `SELECT c.name, p.phone, p.email, p.website, c.email_secondary_color AS s, c.uses_default_logo AS logo, c.partner_id AS partner
       FROM res_company c JOIN res_partner p ON p.id = c.partner_id WHERE c.id = $1`, [u.company_id])).rows[0]!;
  const preview = messagePreview(body) ?? "";
  const html = `${lightLayout({ lang, preview, modelDescription: translate(env, "Account", "mail"), recordName: u.name ?? "", buttonUrl: null, body, tr,
    secondaryColor: company.s || "#875A7B", company: { name: company.name, phone: company.phone ?? "", email: company.email ?? "", website: company.website ?? "" } })}`;
  // :340-350 the mail values; `mail.mail.sudo().create` (its mail.message through _inherits)
  const self = (await env.cr.query<{ p: number }>("SELECT partner_id AS p FROM res_users WHERE id = $1", [env.uid])).rows[0]!.p;
  const emailFrom = (await partnerEmailFormatted(env, company.partner)) || (await partnerEmailFormatted(env, self));
  if (!emailFrom) return;
  const [mid] = await insertMessages(env, [{
    model: false, res_id: false, body: "", author_id: self, email_from: emailFrom, message_type: "email_outgoing", subtype_id: false,
    subject, reply_to: await replyToDefault(env, emailFrom), message_id: trackingMessageId("private"), email_add_signature: true,
    record_alias_domain_id: false, record_company_id: false,
  }]);
  const to = formatAddr(u.name || "False", email);
  const mail = (await env.cr.query<{ id: number }>(
    `INSERT INTO mail_mail (mail_message_id, body_html, email_to, auto_delete, state, create_uid, write_uid, create_date, write_date)
     VALUES ($1, $2, $3, TRUE, 'outgoing', $4, $4, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC') RETURNING id`, [mid, html, to, env.uid])).rows[0]!.id;
  // :352-354 `mails.send()` under suppress(Exception): the refused connection (mail_mail.py:784-790)
  const reason = await smtpConnectFailure();
  await env.cr.query(`UPDATE mail_mail SET state = 'exception', failure_reason = $2 WHERE id = $1`, [mail, reason]);
}

/** Python `str.strip()`: the characters `str.isspace` accepts, at both ends. */
const PY_SPACE = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);
const isPySpace = (c: number): boolean => PY_SPACE.has(c) || (c >= 0x2000 && c <= 0x200a);
function pyStrip(s: string): string {
  let a = 0, b = s.length;
  while (a < b && isPySpace(s.charCodeAt(a))) a++;
  while (b > a && isPySpace(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

/** res_users.py:1039-1046 `_change_password` of a user (`self.password = ...` as superuser, the env user's uid). */
export async function changePassword(env: Environment, ctx: RequestContext, raw: unknown, userId = env.uid): Promise<void> {
  if (typeof raw !== "string") throw new NotPorted("change_password with a non-string password");
  const pw = pyStrip(raw);
  if (!pw) {
    throw new UserError(translate(env, "Setting empty passwords is not allowed for security reasons!", "base"));
  }
  // the ORM write of the non-stored `password`: write_uid/write_date, then the inverse `_set_password` on userId (sudo)
  // through the private hook (a module's compiled override runs around it: auth_password_policy's length check), with
  // the plaintext in the record cache as Odoo's write leaves it
  await env.cr.query("UPDATE res_users SET write_uid = $2, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1", [userId, env.uid]);
  await priv.res_users._set_password.call(env.sudo(), [userId], [], async (_e, ids) => {
    if (ids.length !== 1 || ids[0] !== userId) throw new NotPorted("res.users._set_password of unexpected records");
    // :287-290 `_set_password` and :292-299 `_set_encrypted_password`: the hash, a plain UPDATE
    const salt = crypto.getRandomValues(new Uint8Array(16)); // passlib pbkdf2_sha512 default_salt_size
    const bytes = Buffer.from(pw, "utf8");
    const key = await ctx.store.derivePassword(ctx.sessionState.sid, bytes, salt);
    bytes.fill(0);
    const ab64 = (b: Uint8Array): string => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, ".");
    const hash = `$pbkdf2-sha512$600000$${ab64(salt)}$${ab64(key)}`;
    await env.cr.query("UPDATE res_users SET password = $1 WHERE id = $2", [hash, userId]);
    return null;
  }, { password: new Map([[userId, pw]]) });
  await notifySecurityUpdate(env, ctx, userId, translate(env, "Security Update: Password Changed", "mail"), translate(env, "Your account password has been updated", "mail"));
}

/** res_users.py:332-404 `_check_credentials` of the env user's password, interactive. */
async function checkOwnPassword(env: Environment, ctx: RequestContext, password: unknown): Promise<boolean> {
  if (typeof password !== "string") return false;
  const u = (await env.cr.query<{ password: string | null; totp: boolean }>("SELECT COALESCE(password, '') AS password, totp_secret IS NOT NULL AS totp FROM res_users WHERE id = $1", [env.uid])).rows[0];
  if (!u) return false;
  return checkPassword(env.cr, env.uid, u.password ?? "", u.totp, password, {
    derivePassword: (b, s) => ctx.store.derivePassword(ctx.sessionState.sid, b, s), interactive: true,
  });
}

function requestOf(env: Environment): RequestContext {
  const ctx = requestOfCursor(env.cr);
  if (ctx === null) throw new NotPorted("password change outside a request");
  return ctx;
}

registerMethod("res.users", "change_password", async (env0, _ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const ctx = requestOf(env);
  const old = "old_passwd" in kwargs ? kwargs["old_passwd"] : args[0];
  const fresh = "new_passwd" in kwargs ? kwargs["new_passwd"] : args[1];
  if (!old) throw new AccessDenied("Access Denied"); // :1028-1029
  if (!(await checkOwnPassword(env, ctx, old))) throw new AccessDenied("Access Denied");
  await changePassword(env, ctx, fresh);
  return true;
}, { apiModel: true });

/**
 * :98-137 `check_identity`: the method runs when the session checked the identity in the last ten minutes, else a
 * res.users.identitycheck (as sudo) keeps the call (context without the non-JSON values, model, ids, method, args,
 * kwargs) and its form opens.
 */
export async function checkIdentity(env: Environment, model: string, ids: readonly number[], method: string, fn: () => Promise<unknown>): Promise<unknown> {
  const ctx = requestOf(env);
  const last = Number(ctx.sessionState.get("identity-check-last") ?? 0);
  if (last > Date.now() / 1000 - 10 * 60) return fn();
  const request = dumps([env.context, model, [...ids], method, [], {}], { ensureAscii: true });
  const [w] = await create(env.sudo(), "res.users.identitycheck", [{ request }]);
  return { type: "ir.actions.act_window", res_model: "res.users.identitycheck", res_id: w, name: translate(env, "Access Control", "base"), target: "new", views: [[false, "form"]], context: { dialog_size: "medium" } };
}

// base res_users.py:1503-1504 `_get_default_auth_method`, auth_passkey res_users_identitycheck.py:10-15 ('webauthn'
// for a user with passkeys, refused here)
registerDefaults("res.users.identitycheck", {
  auth_method: async (env) => {
    const keys = (await env.cr.query("SELECT 1 FROM auth_passkey_key WHERE create_uid = $1 LIMIT 1", [env.uid])).rows.length;
    if (keys) throw new NotPorted("identity check by passkey (auth_passkey webauthn)");
    return "password";
  },
});

// :1132-1139
registerMethod("res.users", "preference_change_password", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  return checkIdentity(env, "res.users", ids ?? [], "preference_change_password",
    async () => ({ type: "ir.actions.act_window", target: "new", res_model: "change.password.own", view_mode: "form" }));
}, { apiModel: false });

/** :1582-1585 `_check_password_confirmation`. */
async function checkConfirmation(env: Environment, ids: readonly number[]): Promise<void> {
  const rows = (await env.cr.query<{ n: string | null; c: string | null }>("SELECT new_password AS n, confirm_password AS c FROM change_password_own WHERE id = ANY($1::int[])", [[...ids]])).rows;
  if (rows.some((r) => (r.n ?? null) !== (r.c ?? null))) {
    throw new ValidationError(translate(env, "The new password and its confirmation must be identical.", "base"));
  }
}
registerOverrides("change.password.own", { constraints: [{ fields: ["new_password", "confirm_password"], fn: checkConfirmation }] });

// :1587-1593
registerMethod("change.password.own", "change_password", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const wizard = [...(ids ?? [])];
  return checkIdentity(env, "change.password.own", wizard, "change_password", async () => {
    if (wizard.length !== 1) throw new NotPorted("change.password.own.change_password on several wizards");
    const ctx = requestOf(env);
    const pw = (await env.cr.query<{ p: string | null }>("SELECT new_password AS p FROM change_password_own WHERE id = $1", [wizard[0]])).rows[0]?.p ?? false;
    await changePassword(env, ctx, pw === null ? false : pw);
    await unlink(env, "change.password.own", wizard);
    return { type: "ir.actions.client", tag: "reload" };
  });
}, { apiModel: false });

/** :1506-1526 `_check_identity` and `run_check`: the password from the context, then the kept call. */
registerMethod("res.users.identitycheck", "run_check", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const ctx = requestOf(env);
  if (ids?.length !== 1) throw new NotPorted("run_check on several wizards");
  const w = (await env.cr.query<{ request: string | null; create_uid: number | null }>("SELECT request, create_uid FROM res_users_identitycheck WHERE id = $1", [ids[0]])).rows[0];
  if (!w || !w.request) throw new NotPorted("run_check of a missing identity check");
  if (w.create_uid !== env.uid) throw new NotPorted("run_check of another user's identity check (create_uid credentials)");
  if (!(await checkOwnPassword(env, ctx, env.context["password"]))) {
    throw new UserError(translate(env, "Incorrect Password, try again or click on Forgot Password to reset your password.", "base"));
  }
  ctx.sessionState.set("identity-check-last", Date.now() / 1000);
  const [context, model, recIds, method, args, kwargs] = JSON.parse(w.request) as [Record<string, unknown>, string, number[], string, unknown[], Record<string, unknown>];
  if ((args as unknown[]).length || Object.keys(kwargs).length) throw new NotPorted("identity check of a call with arguments");
  const target = env.withContext(context);
  const fn = lookupMethod(model, method);
  if (!fn || !["preference_change_password", "change_password", "change_password_button", "action_change_password_wizard"].includes(method)) {
    throw new NotPorted(`identity check of ${model}.${method}`);
  }
  return fn.fn(target, recIds, [], {}, model);
}, { apiModel: false });
