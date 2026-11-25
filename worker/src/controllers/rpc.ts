/**
 * The external RPC services (odoo/addons/rpc/controllers: xmlrpc.py `/xmlrpc/2/<service>` and `/xmlrpc/<service>`,
 * jsonrpc.py `/jsonrpc`) over odoo/http/router.py:125-150 `dispatch_rpc`: the `common` service
 * (odoo/service/common.py: version, login, authenticate) and the `object` service (odoo/service/model.py:68-104:
 * execute, execute_kw with `_check_uid_passwd`, then `call_kw` in an environment without context). Each call opens
 * its own cursor on the database it names. `/json/2` (auth='bearer', API keys) is not ported.
 */
import { Cursor } from "../db";
import { AccessDenied, NotPorted, OdooError, UserError } from "../errors";
import { ormEnvironmentOn, type RequestContext } from "../http/context";
import { dbFilter } from "../http/dispatch";
import { callKw } from "../http/methods";
import { jsonRoute, route } from "../http/router";
import { dumpsFault, dumpsResult, loadsCall } from "../http/xmlrpc";
import { isConcurrencyError, isPgError, mapDbError, psycopgError } from "../orm/sql_errors";
import { readFile } from "../filestore";
import { FILESTORE_READER_KEY } from "../models/binary";
import { PDF_ENGINE_KEY, pdfEngineOf } from "../report/engine";
import { APPS_INSTALLABLE_KEY, appsInstallableOnly } from "../modules/apps_visible";
import { createHash } from "node:crypto";
import { checkPasswordWithMethod, experimentRounds, loginUser } from "../session/auth";
import { fetchUser } from "../session/user";
import { SERVER_SERIE, SERVER_VERSION, SERVER_VERSION_INFO } from "../session/info";

/** service/common.py:9-14 RPC_VERSION_1. */
const RPC_VERSION_1 = { server_version: SERVER_VERSION, server_version_info: SERVER_VERSION_INFO, server_serie: SERVER_SERIE, protocol_version: 1 };

/** Python's `Exception("Method not found: %s")` and friends: an application error (fault 1). */
class RpcApplicationError extends Error {
  constructor(readonly pyName: string, message: string) { super(message); }
}

async function withCursor<T>(ctx: RequestContext, db: unknown, fn: (cr: Cursor) => Promise<T>): Promise<T> {
  if (typeof db !== "string" || !db) throw new RpcApplicationError("TypeError", "database name must be a string");
  if (dbFilter([db]).length !== 1) throw new AccessDenied("Database not found.");
  const cr = new Cursor(ctx.env, db);
  let ok = false;
  try {
    const out = await fn(cr);
    ok = true;
    return out;
  } finally {
    const callbacks = ok ? cr.postcommit.splice(0) : [];
    try {
      if (ok) await cr.commit();
      else await cr.rollback();
    } finally {
      await cr.close();
    }
    for (const cb of callbacks) await cb();
  }
}

function passwordRequest(ctx: RequestContext): { derivePassword: (p: Uint8Array, s: Uint8Array) => Promise<Uint8Array>; experimentRounds: number | null; interactive: false } {
  // the key derivation runs in the session store's object; an RPC call has no session, any key spreads the load
  const key = ctx.store.generateKey();
  return { derivePassword: (bytes, salt) => ctx.store.derivePassword(key, bytes, salt), experimentRounds: experimentRounds(ctx.env.EXPERIMENT_PASSWORD_ROUNDS), interactive: false };
}

/** service/common.py:16-35 `exp_login` / `exp_authenticate`: the uid, or False when the credentials are refused. */
async function authenticate(ctx: RequestContext, db: unknown, login: unknown, password: unknown): Promise<number | false> {
  return withCursor(ctx, db, async (cr) => {
    try {
      const info = await loginUser(cr, { login: String(login ?? ""), password: typeof password === "string" ? password : "", type: "password" }, {
        ...passwordRequest(ctx), remoteAddr: ctx.remoteAddr, userAgent: ctx.userAgent, baseLocation: "", tzCookie: null, bestLang: null,
        loginFailures: null, // router.py:143 dispatch_rpc runs without a request: `_assert_can_auth` does not apply
      });
      return info.uid;
    } catch (e) {
      if (e instanceof AccessDenied) return false;
      throw e;
    }
  });
}

async function dispatchCommon(ctx: RequestContext, method: string, params: unknown[]): Promise<unknown> {
  if (method === "version") return RPC_VERSION_1;
  if (method === "login") {
    if (params.length !== 3) throw new RpcApplicationError("TypeError", `exp_login() takes 3 positional arguments but ${params.length} were given`);
    return authenticate(ctx, params[0], params[1], params[2]);
  }
  if (method === "authenticate") {
    if (params.length !== 4) throw new RpcApplicationError("TypeError", `exp_authenticate() takes 4 positional arguments but ${params.length} were given`);
    return authenticate(ctx, params[0], params[1], params[2]);
  }
  throw new RpcApplicationError("Exception", `Method not found: ${method}`);
}

/** service/model.py:68-104 `dispatch` and `execute_cr`. */
async function dispatchObject(ctx: RequestContext, method: string, params: unknown[]): Promise<unknown> {
  if (params.length < 5) throw new RpcApplicationError("ValueError", `not enough values to unpack (expected at least 5, got ${params.length})`);
  const [db, uidRaw, passwd, model, method_, ...rest] = params;
  const uid = typeof uidRaw === "number" ? Math.trunc(uidRaw) : typeof uidRaw === "string" && /^\s*[+-]?\d+\s*$/.test(uidRaw) ? Number(uidRaw) : NaN;
  if (Number.isNaN(uid)) throw new RpcApplicationError("ValueError", `invalid literal for int() with base 10: ${JSON.stringify(uidRaw)}`);
  if (!passwd) throw new AccessDenied();
  let args: unknown[];
  let kw: Record<string, unknown>;
  if (method === "execute") { args = rest; kw = {}; }
  else if (method === "execute_kw") {
    const a = rest.length === 1 ? [...rest, {}] : rest;
    if (a.length !== 2) throw new RpcApplicationError("ValueError", "too many values to unpack (expected 2)");
    args = Array.isArray(a[0]) ? a[0] : [];
    if (!Array.isArray(a[0])) throw new RpcApplicationError("TypeError", "args must be a list");
    kw = a[1] === null || a[1] === undefined ? {} : a[1] as Record<string, unknown>;
  } else throw new RpcApplicationError("NameError", `Method not available ${method}`);
  return withCursor(ctx, db, async (cr) => {
    await checkUidPasswd(ctx, cr, uid, String(passwd));
    return executeCr(ctx, cr, uid, model, method_, args, kw);
  });
}

/**
 * The successful checks of `_check_uid_passwd`, as its `@api.ormcache('uid', 'passwd')` (res_users.py:934): a hit
 * skips the check and its `_assert_can_auth`, as in Odoo. The key is a hash of the database, uid, the password given
 * and the stored hash and TOTP state, so a changed password or second factor misses (Odoo clears its cache when the
 * user is written); the user's `active` is still read on every call. Per isolate, bounded, as Odoo's per process.
 */
const CHECKED_PASSWORDS = new Map<string, true>();
const CHECKED_PASSWORDS_MAX = 256;

/** res_users.py:933-947 `_check_uid_passwd`. */
async function checkUidPasswd(ctx: RequestContext, cr: Cursor, uid: number, passwd: string): Promise<void> {
  const user = await fetchUser(cr, uid);
  const key = user && user.active
    ? createHash("sha256").update(JSON.stringify([cr.db, uid, passwd, user.password ?? "", user.totp_secret !== null])).digest("base64")
    : null;
  if (key !== null && CHECKED_PASSWORDS.has(key)) return;
  // res_users.py:942 `with self._assert_can_auth(user=uid)`: without a request (router.py:143) it only yields
  if (!user || !user.active) throw new AccessDenied();
  const method = await checkPasswordWithMethod(cr, uid, user.password ?? "", user.totp_secret !== null, passwd, passwordRequest(ctx));
  if (method === null) throw new AccessDenied();
  if (method !== "password" || key === null) return;
  if (CHECKED_PASSWORDS.size >= CHECKED_PASSWORDS_MAX) CHECKED_PASSWORDS.delete(CHECKED_PASSWORDS.keys().next().value!);
  CHECKED_PASSWORDS.set(key, true);
}

/**
 * service/model.py:95-115 `execute_cr`: `retrying(partial(call_kw, ...), env)` (odoo/http/retrying.py:27-120). A
 * serialization failure, deadlock or lock timeout rolls the transaction back and calls again, up to 5 tries, after a
 * random wait of uniform(0, 2**tryno) seconds; the last one propagates as the psycopg2 error. An IntegrityError rolls
 * back and becomes "The operation cannot be completed: ..." (ValidationError), without a retry. The port's
 * transaction state (ORM cache, tracking, precommit lists) hangs on the cursor, so each try runs on a fresh cursor of
 * the same database; the rolled-back one is closed. The credentials were checked once, before, as in Odoo.
 */
async function executeCr(ctx: RequestContext, first: Cursor, uid: number, model: unknown, method: unknown, args: unknown[], kw: Record<string, unknown>): Promise<unknown> {
  let cr = first;
  for (let tryno = 1; ; tryno++) {
    const env = await ormEnvironmentOn(ctx, cr, uid, {});
    // attachments (image and binary fields) are read from the database's filestore, as in the web requests
    env.cache.set(FILESTORE_READER_KEY, (name: string) => readFile(ctx.env, cr.db, name));
    env.cache.set(PDF_ENGINE_KEY, pdfEngineOf(ctx.env, cr.db) !== null);
    env.cache.set(APPS_INSTALLABLE_KEY, appsInstallableOnly(ctx.env.APPS_INSTALLABLE_DBS, cr.db));
    if (typeof model !== "string" || !env.reg.models.has(model)) throw new UserError(`Object ${String(model)} doesn't exist`);
    if (typeof method !== "string") throw new RpcApplicationError("TypeError", "method name must be a string");
    try {
      const result = await callKw(env, model, method, args, kw, { rpc: true });
      await cr.drain(); // a deferred write's error (src/db.ts) is the call's, mapped below
      if (cr !== first) await commitRetry(cr, true);
      return result === undefined ? null : result;
    } catch (e) {
      if (!isPgError(e)) {
        if (cr !== first) await commitRetry(cr, false);
        throw e;
      }
      if (!isConcurrencyError(e)) {
        const mapped = await mapDbError(env, e); // retrying.py:80-91 (the rollback happens inside for an IntegrityError)
        if (cr !== first) await commitRetry(cr, false);
        throw mapped;
      }
      if (tryno >= MAX_TRIES_ON_CONCURRENCY_FAILURE) {
        if (cr !== first) await commitRetry(cr, false);
        throw await psycopgError(e); // retrying.py:101-103 "maximum number of tries reached", re-raised
      }
      if (cr === first) await cr.rollback();
      else await commitRetry(cr, false);
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 2 ** tryno * 1000)); // retrying.py:105
      cr = first.fresh();
    }
  }
}

/** retrying.py:27 MAX_TRIES_ON_CONCURRENCY_FAILURE. */
const MAX_TRIES_ON_CONCURRENCY_FAILURE = 5;

/** End a retry's own cursor: commit (and run its post-commit callbacks) or roll back, then close it. */
async function commitRetry(cr: Cursor, commit: boolean): Promise<void> {
  const callbacks = commit ? cr.postcommit.splice(0) : [];
  try {
    if (commit) await cr.commit();
    else await cr.rollback();
  } finally {
    await cr.close();
  }
  for (const cb of callbacks) await cb();
}

async function dispatchRpc(ctx: RequestContext, service: string, method: string, params: unknown[]): Promise<unknown> {
  if (service === "object") return dispatchObject(ctx, method, params);
  if (service === "common") return dispatchCommon(ctx, method, params);
  throw new RpcApplicationError("ValueError", `Invalid service name: ${service}`);
}

/** rpc/controllers/xmlrpc.py:36-71 the faults: int codes (/xmlrpc/2) or the historical strings (/xmlrpc). */
function fault(e: unknown, intCodes: boolean): string {
  const name = e instanceof OdooError ? e.odooName : "";
  const message = e instanceof Error ? e.message : String(e);
  const isUserError = ["odoo.exceptions.UserError", "odoo.exceptions.ValidationError", "odoo.exceptions.MissingError", "odoo.exceptions.AccessError", "odoo.exceptions.AccessDenied"].includes(name);
  if (intCodes) {
    if (name === "odoo.exceptions.RedirectWarning") return dumpsFault(2, message);
    if (name === "odoo.exceptions.AccessError") return dumpsFault(4, message);
    if (name === "odoo.exceptions.AccessDenied") return dumpsFault(3, message);
    if (isUserError) return dumpsFault(2, message);
    return dumpsFault(1, traceback(e));
  }
  if (name === "odoo.exceptions.RedirectWarning") return dumpsFault(`warning -- Warning\n\n${message}`, "");
  if (name === "odoo.exceptions.MissingError") return dumpsFault(`warning -- MissingError\n\n${message}`, "");
  if (name === "odoo.exceptions.AccessError") return dumpsFault(`warning -- AccessError\n\n${message}`, "");
  if (name === "odoo.exceptions.AccessDenied") return dumpsFault("AccessDenied", message);
  if (isUserError) return dumpsFault(`warning -- UserError\n\n${message}`, "");
  return dumpsFault(message, traceback(e));
}

/** `traceback.format_exception`: the port has no Python frames, only the last line is the same. */
function traceback(e: unknown): string {
  if (e instanceof RpcApplicationError) return `Traceback (most recent call last):\n${e.pyName}: ${e.message}\n`;
  // traceback.py `_format_final_exc_line`: the class's module is left out for builtins (`TypeError: ...`)
  if (e instanceof OdooError) return `Traceback (most recent call last):\n${e.odooName.replace(/^builtins\./, "")}: ${e.message}\n`;
  if (e instanceof NotPorted) return `Traceback (most recent call last):\nNotPorted: ${e.message}\n`;
  if (e instanceof TypeError || e instanceof RangeError) return `Traceback (most recent call last):\n${e instanceof RangeError ? "OverflowError" : "TypeError"}: ${e.message}\n`;
  return `Traceback (most recent call last):\nException: ${e instanceof Error ? e.message : String(e)}\n`;
}

function xmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/xml; charset=utf-8" } });
}

async function xmlrpc(ctx: RequestContext, service: string, intCodes: boolean): Promise<Response> {
  try {
    const { params, method } = loadsCall(await ctx.request.text());
    const result = await dispatchRpc(ctx, service, method, params);
    return xmlResponse(dumpsResult(result));
  } catch (e) {
    return xmlResponse(fault(e, intCodes));
  }
}

route("/xmlrpc/2/<service>", async (ctx, p) => xmlrpc(ctx, p["service"]!, true), { auth: "none", methods: ["POST"], csrf: false, saveSession: false });
route("/xmlrpc/<service>", async (ctx, p) => xmlrpc(ctx, p["service"]!, false), { auth: "none", methods: ["POST"], csrf: false, saveSession: false });

/** rpc/controllers/jsonrpc.py:10-17: `dispatch_rpc(service, method, args)`; errors are the JSON-RPC error envelope. */
jsonRoute("/jsonrpc", async (ctx) => {
  const p = ctx.jsonParams ?? {};
  const args = p["args"];
  try {
    return await dispatchRpc(ctx, String(p["service"] ?? ""), String(p["method"] ?? ""), Array.isArray(args) ? args : []);
  } catch (e) {
    if (e instanceof RpcApplicationError) throw new OdooError(`builtins.${e.pyName}`, e.message);
    throw e;
  }
}, { auth: "none", saveSession: false });
