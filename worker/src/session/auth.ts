/**
 * Login, session tokens, logout and the per-request session check:
 * `odoo/odoo/http/session.py:214-283, 398-432` (authenticate, finalize, logout, check) and
 * `odoo/odoo/addons/base/models/res_users.py` (_login 857-884, _check_credentials 314-404, authenticate 900-928,
 * _update_last_login 839-843, _compute_session_token 971-1004).
 */
import { createHmac, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import type { PasswordKdf } from "./kdf";
import type { Cursor } from "../db";
import { AccessDenied, NotPorted, OdooError, SessionExpired } from "../errors";
import { requestSequences } from "../orm/signaling";
import { inOrder } from "../in_order";
import { pyRepr, type PyValue } from "./pyrepr";
import { getDefaultSession, type LoginFailures, Session, SessionStore, STORED_SESSION_BYTES } from "./session";
import { type Client, updateDeviceLog } from "./device";
import {
  contextGet, dbNow, fetchUser, fetchUserByLogin, hasGroup, icpBool, icpInt, icpStr, userGroupIds, type UserRow,
} from "./user";

const MIN_ROUNDS = 600_000; // res_users.py:90

/** D18: `EXPERIMENT_PASSWORD_ROUNDS` parsed; anything but a positive integer below Odoo's minimum is ignored. */
export function experimentRounds(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n < MIN_ROUNDS ? n : null;
}

/** passlib's "adapted base64" (`+` written as `.`, no padding). */
const ab64Decode = (s: string): Buffer => Buffer.from(s.replace(/\./g, "+"), "base64");
const ab64Encode = (b: Uint8Array): string => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, ".");

export interface VerifyResult {
  readonly valid: boolean;
  /** The hash `verify_and_update` replaces the stored one with, or null. */
  readonly replacement: string | null;
}

/**
 * res_users.py:366-374 with :1305-1322 `_crypt_context`: passlib `CryptContext(['pbkdf2_sha512', 'plaintext'],
 * deprecated=['auto'], pbkdf2_sha512__rounds=600000).verify_and_update(password, hashed)`. A pbkdf2_sha512 hash
 * (`$pbkdf2-sha512$<rounds>$<salt>$<checksum>`, 64-byte key) or a plaintext one is verified; when it is valid and
 * not a 600,000-round pbkdf2_sha512 hash (measured with Odoo's passlib: 1000, 599999 and 700000 rounds and plaintext
 * are all replaced) the replacement is a new 600,000-round hash with a 16-byte random salt.
 *
 * 600,000 rounds run in the session Durable Object (D17); fewer rounds are verified in the Worker (cheaper than
 * that); more rounds refuse. D18: with `experimentRounds` set, a hash of exactly that many rounds is valid and kept.
 */
export async function verifyAndUpdate(stored: string, password: string, derive: PasswordKdf,
  experimentRounds: number | null = null): Promise<VerifyResult> {
  if (stored === "") return { valid: false, replacement: null };
  const bytes = Buffer.from(password, "utf8");
  let derived: Uint8Array | undefined;
  try {
    const m = /^\$pbkdf2-sha512\$(\d+)\$([A-Za-z0-9./]+)\$([A-Za-z0-9./]+)$/.exec(stored);
    let valid: boolean;
    let current = false;
    if (m === null) {
      if (stored.startsWith("$pbkdf2-sha512$")) throw new NotPorted("malformed pbkdf2_sha512 hash");
      // passlib `plaintext` (the last scheme: it identifies any other string) compares the strings
      valid = stored === password;
    } else {
      const rounds = Number(m[1]);
      if (rounds > MIN_ROUNDS) throw new NotPorted(`pbkdf2_sha512 with ${rounds} rounds (more than the Durable Object derives)`);
      const salt = ab64Decode(m[2]!), expected = ab64Decode(m[3]!);
      derived = rounds === MIN_ROUNDS ? await derive(bytes, salt, rounds) : pbkdf2Sync(bytes, salt, rounds, 64, "sha512");
      valid = derived.length === expected.length && timingSafeEqual(derived, expected);
      current = rounds === MIN_ROUNDS || (experimentRounds !== null && rounds === experimentRounds);
    }
    if (!valid || current) return { valid, replacement: null };
    const salt = crypto.getRandomValues(new Uint8Array(16)); // passlib pbkdf2_sha512 default_salt_size
    const key = await derive(bytes, salt, MIN_ROUNDS);
    return { valid, replacement: `$pbkdf2-sha512$${MIN_ROUNDS}$${ab64Encode(salt)}$${ab64Encode(key)}` };
  } finally {
    bytes.fill(0);
    derived?.fill(0);
  }
}

/** `verify_and_update`'s verdict only (tests). */
export async function verifyPassword(stored: string, password: string, derive: PasswordKdf, experimentRounds: number | null = null): Promise<boolean> {
  return (await verifyAndUpdate(stored, password, derive, experimentRounds)).valid;
}

/**
 * res_users.py:952-1004: `_session_token_get_values` is one SQL row `(database_secret, active, id, login,
 * password)` (the token fields sorted, `auth_passkey_key_ids` of auth_passkey being relational is skipped,
 * auth_passkey/models/res_users.py:78-79), `_session_token_hash_compute` is HMAC-SHA256 keyed by the Python repr
 * of the `(name, value)` tuples whose value is not None.
 */
export async function sessionTokenValues(cr: Cursor, uid: number): Promise<readonly [string, PyValue][] | false> {
  // the request's user row (`fetchUser`, the same statement `env.user` reads: one per request) and the secret, a
  // config parameter the isolate keeps under the signaling (src/session/user.ts icpStr, registryCached: read first for
  // that). The user row does not depend on the signaling: it is sent right behind it and shares its round trip (C2d)
  const [, user] = await inOrder([requestSequences(cr), fetchUser(cr, uid)]);
  const [secret, row] = await Promise.all([icpStr(cr, "database.secret"), user]);
  if (row === null) return false;
  return [
    ["database_secret", secret],
    ["active", row.active_raw],
    ["id", row.id],
    ["login", row.login],
    ["password", row.password],
  ];
}

export function sessionTokenHash(sid: string, values: readonly [string, PyValue][]): string {
  const keyTuple: PyValue[] = values.filter(([, v]) => v !== null).map(([k, v]) => [k, v]);
  return createHmac("sha256", Buffer.from(pyRepr(keyTuple), "utf8")).update(sid, "utf8").digest("hex");
}

export async function computeSessionToken(cr: Cursor, uid: number, sid: string): Promise<string | false> {
  const values = await sessionTokenValues(cr, uid);
  return values === false ? false : sessionTokenHash(sid, values);
}

/** `odoo.tools.misc.hmac(env, scope, message)` (misc.py:1792-1820): HMAC-SHA256 of `repr((scope, message))`. */
export function odooHmac(secret: string, scope: string, message: PyValue): string {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(pyRepr([scope, message]), "utf8").digest("hex");
}

export interface Credential {
  readonly login: string;
  readonly password: string;
  readonly type: string;
}

export interface AuthInfo {
  readonly uid: number;
  readonly auth_method: string;
  readonly mfa: string;
}

export interface LoginRequest extends Client {
  readonly derivePassword: PasswordKdf;
  /** D18: the experiment's accepted round count (`EXPERIMENT_PASSWORD_ROUNDS`), null for Odoo's behaviour. */
  readonly experimentRounds?: number | null;
  /** `request.httprequest.url_root.rstrip('/')`, the base location (session.py:229). */
  readonly baseLocation: string;
  /** The `tz` cookie the login page sets (res_users.py:869). */
  readonly tzCookie: string | null;
  /** The request's best Accept-Language (`request.best_lang`), for context_get's fallback. */
  readonly bestLang: string | null;
  /** `user_agent_env['interactive']` (default True); False for the RPC services (service/common.py:29). */
  readonly interactive?: boolean;
  /** The failures of this request's source (`_assert_can_auth`); null when there is no request (res_users.py:1352). */
  readonly loginFailures: LoginFailures | null;
  /** The language of the environment, else of the request (translate.py `_get_lang`), for the cooldown message. */
  readonly lang?: string | null;
}

/**
 * res_users.py:1394-1417 `_on_login_cooldown`: after `base.login_cooldown_after` (5, 0 disables) failures, every
 * attempt within `base.login_cooldown_duration` (or 60) seconds of the last failure is refused.
 */
export async function onLoginCooldown(cr: Cursor, failures: number, previous: number, now: number): Promise<boolean> {
  const minFailures = await icpInt(cr, "base.login_cooldown_after", 5);
  if (minFailures === 0) return false;
  const delay = (await icpInt(cr, "base.login_cooldown_duration")) || 60;
  return failures >= minFailures && now - previous < delay * 1000;
}

/**
 * res_users.py:1326-1392 `_assert_can_auth` around a login attempt: refused without trying while on cooldown (the
 * failure is not counted), a failure (AccessDenied) counted with its time, a success clears the record. The clock
 * is the Worker's, as Odoo's `datetime.now()` is the process's: only differences of it are used.
 */
const COOLDOWN_MSG_EN = "Too many login failures, please wait a bit before trying again.";
const COOLDOWN_MSG_SV = "För många misslyckade inloggningsförsök, vänta en stund innan du försöker igen.";

export async function assertCanAuth<T>(cr: Cursor, source: LoginFailures | null, lang: string | null | undefined, user: string | number, fn: () => Promise<T>): Promise<T> {
  if (source === null) return fn();
  const [failures, previous] = await source.read();
  if (await onLoginCooldown(cr, failures, previous, Date.now())) {
    console.warn(`Login attempt ignored for user ${JSON.stringify(user)} on ${cr.db}: ${failures} failures since last success`);
    // translate.py:1084-1120 `_get_lang` of the `_()` call: the environment's language, then the request's; without
    // one it falls back to `int(frame.f_locals['user'])` (:1077), which raises for a login that is not a number
    if (!lang) {
      if (typeof user === "string" && !/^\s*[+-]?\d+\s*$/.test(user)) throw new OdooError("builtins.ValueError", `invalid literal for int() with base 10: ${pyRepr(user)}`);
      throw new AccessDenied(COOLDOWN_MSG_EN);
    }
    if (lang === "en_US") throw new AccessDenied(COOLDOWN_MSG_EN);
    const { codeTranslation } = await import("../orm/code_translations");
    const translated = codeTranslation(lang, "base", COOLDOWN_MSG_EN);
    if (translated !== null) throw new AccessDenied(translated);
    if (lang === "sv_SE") throw new AccessDenied(COOLDOWN_MSG_SV);
    throw new AccessDenied(COOLDOWN_MSG_EN);
  }
  let out: T;
  try {
    out = await fn();
  } catch (e) {
    if (e instanceof AccessDenied) await source.failed(Date.now());
    throw e;
  }
  // reg._login_failures.pop(source, None): nothing to remove when the record was empty when read
  if (failures !== 0 || previous !== 0) await source.succeeded();
  return out;
}

/**
 * res_users.py:314-404 `_check_credentials` of a password: the hash, unless a non-interactive call of a user whose RPC
 * needs API keys (auth_totp `_rpc_api_keys_only`); non-interactive calls then try the password as an API key
 * (res_users.py:390-397), which refuses as long as the database holds keys (their check is not ported).
 */
export type CredentialCheckMethod = "password" | "apikey" | null;

export async function checkPasswordWithMethod(cr: Cursor, uid: number, stored: string, totp: boolean, password: string, req: { derivePassword: PasswordKdf; experimentRounds?: number | null; interactive?: boolean }): Promise<CredentialCheckMethod> {
  const interactive = req.interactive !== false;
  if (interactive || !totp) {
    // res_users.py:1322 `max(MIN_ROUNDS, password.hashing.rounds)`: a higher setting would change the target work factor
    const icpRounds = (await cr.query<{ v: string | null }>("SELECT value AS v FROM ir_config_parameter WHERE key = 'password.hashing.rounds'")).rows[0]?.v;
    if (icpRounds && Number(icpRounds) > MIN_ROUNDS) throw new NotPorted("password.hashing.rounds above 600000");
    const { valid, replacement } = await verifyAndUpdate(stored, password, req.derivePassword, req.experimentRounds ?? null);
    // :372-374 `_set_encrypted_password`: a plain UPDATE (no write_date); the session token, computed from the row
    // when the session is finalized, follows the new hash (:375-379)
    if (replacement !== null) await cr.query("UPDATE res_users SET password = $1 WHERE id = $2", [replacement, uid]);
    if (valid) return "password";
  }
  // res_users.py:389-395: a non-interactive call accepts the user's own global API key as password
  if (!interactive && (await checkApikeyCredentials(cr, "rpc", password)) === uid) return "apikey";
  return null;
}

export async function checkPassword(cr: Cursor, uid: number, stored: string, totp: boolean, password: string, req: { derivePassword: PasswordKdf; experimentRounds?: number | null; interactive?: boolean }): Promise<boolean> {
  return (await checkPasswordWithMethod(cr, uid, stored, totp, password, req)) !== null;
}

/**
 * res_users.py:1813-1842 `_check_apikey_credentials`: the keys of active users with the key's index (its first 8
 * characters) and scope that have not expired, verified with passlib's pbkdf2_sha512 (KEY_CRYPT_CONTEXT, :1598-1603).
 */
export async function checkApikeyCredentials(cr: Cursor, scope: string, key: string): Promise<number | null> {
  if (!scope || !key) throw new NotPorted("_check_apikey_credentials without scope or key (AssertionError)");
  const rows = (await cr.query<{ user_id: number; key: string }>(
    `SELECT user_id, key FROM res_users_apikeys INNER JOIN res_users u ON (u.id = user_id)
      WHERE u.active AND index = $1 AND scope = $2 AND (expiration_date IS NULL OR expiration_date >= now() at time zone 'utc')`,
    [key.slice(0, 8), scope])).rows;
  for (const r of rows) {
    const m = /^\$pbkdf2-sha512\$(\d+)\$([A-Za-z0-9./]+)\$([A-Za-z0-9./]+)$/.exec(r.key);
    if (m === null) throw new NotPorted("API key hash scheme other than pbkdf2_sha512");
    const ab64 = (v: string): Buffer => Buffer.from(v.replace(/\./g, "+"), "base64");
    const salt = ab64(m[2]!), expected = ab64(m[3]!);
    const derived = pbkdf2Sync(Buffer.from(key, "utf8"), salt, Number(m[1]), expected.length, "sha512");
    if (derived.length === expected.length && timingSafeEqual(derived, expected)) return r.user_id;
  }
  return null;
}

/** res_users.py:857-884 `_login` (inside `_assert_can_auth`) then 900-928 `authenticate`. */
export async function loginUser(cr: Cursor, credential: Credential, req: LoginRequest): Promise<AuthInfo> {
  const authInfo = await assertCanAuth(cr, req.loginFailures, req.lang, credential.login, () => login(cr, credential, req));
  // res_users.py:915-927: a system user's interactive login records the base url (`base_location` of the user agent env)
  if (req.interactive === false) return authInfo;
  const groups = await userGroupIds(cr, authInfo.uid);
  if (await hasGroup(cr, groups, "base.group_system") && !(await icpBool(cr, "web.base.url.freeze"))) {
    const current = await icpStr(cr, "web.base.url");
    if (current !== req.baseLocation) {
      // ir_config_parameter.py:81-90 set_str -> `_set`: write({'value': base}) on the existing row, create only when
      // absent. Not INSERT ... ON CONFLICT: that takes an id from the sequence even when it updates, and the next
      // parameter created (a module's data, auth_password_policy.minlength) got Odoo's id + 1
      const now = await dbNow(cr);
      const upd = await cr.query(`UPDATE ir_config_parameter SET value = $1, write_uid = $2, write_date = $3 WHERE key = 'web.base.url'`,
        [req.baseLocation, authInfo.uid, now]);
      if (!upd.rowCount) {
        await cr.query(`INSERT INTO ir_config_parameter (key, value, create_uid, create_date, write_uid, write_date) VALUES ('web.base.url', $1, $2, $3, $2, $3)`,
          [req.baseLocation, authInfo.uid, now]);
      }
    }
  }
  return authInfo;
}

/** res_users.py:862-877, the body of `_login`'s `with self._assert_can_auth(user=login)`. */
async function login(cr: Cursor, credential: Credential, req: LoginRequest): Promise<AuthInfo> {
  // _check_credentials (res_users.py:352-353): only password credentials with a non-empty password
  if (credential.type !== "password" || credential.password === "") throw new AccessDenied();
  const user = await fetchUserByLogin(cr, credential.login);
  if (user === null) throw new AccessDenied(); // res_users.py:863-865
  // res_users.py:366-370: SELECT COALESCE(password, '') FROM res_users WHERE id=%s
  if (!(await checkPassword(cr, user.id, user.password ?? "", user.totp_secret !== null, credential.password, req))) throw new AccessDenied(); // res_users.py:404
  const authInfo: AuthInfo = { uid: user.id, auth_method: "password", mfa: "default" }; // res_users.py:383-387

  // _update_last_login (res_users.py:839-843): res.users.log.sudo().create({}) with the magic columns
  const now = await dbNow(cr);
  const updateLastLogin = async (): Promise<void> => {
    await cr.query(
      "INSERT INTO res_users_log (create_uid, create_date, write_uid, write_date) VALUES ($1, $2, $1, $2)",
      [user.id, now],
    );
  };
  // res_users.py:868-877: first login (no login_date) or missing tz -> write the browser's tz cookie when it is a
  // known zone (`ZoneInfo(tz).key in all_timezones`), then _update_last_login (src/models/res_users_login.ts)
  const login = await import("../models/res_users_login");
  if (req.tzCookie !== null && (user.partner_tz === null || !(await login.hasLoggedIn(cr, user.id)))
    && (await login.isKnownTimezone(cr, req.tzCookie))) {
    await login.writeLoginTz(cr, user.id, req.tzCookie, updateLastLogin);
  } else {
    await updateLastLogin();
  }
  return authInfo;
}

/** `res.users._mfa_url()`: auth_totp (totp_enabled) and auth_totp_mail (ICP auth_totp.policy) decide. */
async function mfaUrl(cr: Cursor, user: UserRow, isInternal: boolean): Promise<string | null> {
  if (user.totp_secret !== null) return "/web/login/totp"; // auth_totp/models/res_users.py:43-56
  const policy = await icpStr(cr, "auth_totp.policy"); // auth_totp_mail/models/res_users.py:116-134
  if (policy === "all_required" || (policy === "employee_required" && isInternal)) return "/web/login/totp";
  return null;
}

/**
 * session.py:214-248 `authenticate` and 251-270 `finalize`: store the authenticated user in the session
 * (`pre_login`/`pre_uid` until MFA, then uid, login, db, context, session_token) and ask for a rotation.
 */
export async function authenticateSession(cr: Cursor, session: Session, credential: Credential, req: LoginRequest): Promise<AuthInfo> {
  const authInfo = await loginUser(cr, credential, req);
  session.uid = null;
  session.set("pre_login", credential.login);
  session.set("pre_uid", authInfo.uid);
  const user = await fetchUser(cr, authInfo.uid);
  if (user === null) throw new AccessDenied();
  const groups = await userGroupIds(cr, user.id);
  const isInternal = await hasGroup(cr, groups, "base.group_user");
  if (authInfo.mfa === "skip" || (await mfaUrl(cr, user, isInternal)) === null) {
    await finalizeSession(cr, session, user, req.bestLang);
  }
  return authInfo;
}

export async function finalizeSession(cr: Cursor, session: Session, user: UserRow, bestLang: string | null): Promise<void> {
  const login = session.pop("pre_login");
  session.pop("pre_uid");
  const userContext = await contextGet(cr, user, bestLang);
  session.shouldRotate = true;
  session.update({
    db: cr.db,
    login,
    uid: user.id,
    context: userContext,
    session_token: await computeSessionToken(cr, user.id, session.sid),
  });
  // env.user._after_session_login(): a hook (res_users.py:930-932), only auth_timeout (not installed) extends it
}

/** session.py:273-283 `logout`: reset to the defaults, keeping db and debug; `_post_logout` is the caller's (cids cookie). */
export function logoutSession(session: Session, keepDb: boolean, defaultLang: string, nowSec: number): void {
  const db = keepDb ? session.db : null;
  const debug = session.debug;
  session.clear();
  const defaults: Record<string, unknown> = { ...getDefaultSession(nowSec), db, debug };
  session.update(defaults);
  session.setContextKey("lang", defaultLang);
  session.shouldRotate = true;
}

export function touchSession(session: Session): void {
  session.isDirty = true; // session.py:286-287
}

/**
 * session.py:398-432 `check`: the stored token must match the user's current one (credentials unchanged); on
 * success the device log is updated; on failure the session is logged out (db kept) and SessionExpired raised.
 * `nowSec` is the wall clock (deletion_time and create_time are wall-clock values of the store).
 */
export async function checkSession(cr: Cursor, store: SessionStore, session: Session, client: Client | null, defaultLang: string, nowSec: number): Promise<void> {
  await store.deleteOldSessions(session, nowSec);
  const deletion = session.get("deletion_time");
  if (typeof deletion === "number" && deletion <= nowSec) {
    logoutSession(session, true, defaultLang, nowSec);
    throw new SessionExpired("session is too old");
  }
  const uid = session.uid;
  const expected = uid === null ? false : await computeSessionToken(cr, uid, session.sid);
  if (expected !== false) {
    const stored = session.sessionToken ?? "";
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(stored, "utf8");
    if (a.length === b.length && timingSafeEqual(a, b)) {
      if (client !== null) {
        const dbNowSec = (await dbNow(cr)).getTime() / 1000;
        if (await updateDeviceLog(cr, session, client, dbNowSec)) await store.save(session);
      }
      return;
    }
    // the legacy token (res_users.py:1006-1016) is `str(tuple(values))` keyed; port it only if a session ever carries one
  }
  logoutSession(session, true, defaultLang, nowSec);
  throw new SessionExpired("session token mismatch; likely because the user credentials changed");
}

export { STORED_SESSION_BYTES };
