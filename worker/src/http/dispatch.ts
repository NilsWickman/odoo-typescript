/**
 * Odoo's request lifecycle (`odoo/odoo/http/router.py` Application.__call__, serve_db, serve_nodb,
 * `dispatcher.py` HttpDispatcher/JsonRPCDispatcher, `odoo/odoo/addons/base/models/ir_http.py` _authenticate,
 * _pre_dispatch, _dispatch, _post_dispatch, `odoo/odoo/http/session.py` save_session):
 * session load -> database selection -> route match -> authentication -> pre-dispatch -> controller ->
 * session save and cookie -> default headers; commit on success, rollback and `handle_error` on failure.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { registrySourceOf } from "../orm/registry_share";
import { Phases, phasesWanted } from "../phases";
import { replacedKeys, takeRequestHits } from "../orm/keys";
import { setOverrideGuardMode } from "../orm/override_guard";
import type { Env } from "../env";
import type { BusDispatcher } from "../do/bus";
import { FILES_DB, isReservedDb } from "../filestore_files";
import { Cursor, UnknownDatabase } from "../db";
import { AccessDenied, AccessError, HttpError, HttpResponseError, MissingError, NotPorted, OdooError, SessionExpired, UserError } from "../errors";
import { isConcurrencyError, isPgError, mapDbError, psycopgError } from "../orm/sql_errors";
import { NOT_FOUND_NODB } from "./not_found_nodb";
import { parseCookies, dumpCookie, expiredCookie } from "./cookies";
import { validateCsrf } from "./csrf";
import { dumpsResponse } from "./json";
import { htmlEscape, RequestContextImpl, redirectResponse, type RequestContext } from "./context";
import { fallbacks, matchPath, matchPathFor, templateRouteCandidates, type Match, type RouteDef } from "./router";
import { templateOf } from "../orm/template";
import type { Handler, JsonHandler } from "./context";
import {
  getDefaultSession, Session, SessionStore, SESSION_LIFETIME, warmSessionObjects, SESSION_ROTATION_EXCLUDED_PATHS, SESSION_ROTATION_INTERVAL,
  SESSION_ROTATION_INTERVAL_HEADER_SKIP,
} from "../session/session";
import { checkApikeyCredentials, checkSession, computeSessionToken, logoutSession } from "../session/auth";
import { getDevice } from "../session/device";
import { demoNotPortedFloor } from "../demo/not_ported";
import { publicUserId } from "../session/info";
import { databaseSecret, fetchUser, getLangCode, icpBool, icpInt, str2bool, SUPERUSER_ID, userFlags } from "../session/user";

export const CORS_MAX_AGE = 60 * 60 * 24; // dispatcher.py:47
export const SAFE_HTTP_METHODS: readonly string[] = ["GET", "HEAD", "OPTIONS", "TRACE"]; // dispatcher.py:50
const DB_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/; // odoo/odoo/modules/db.py:45

/** `werkzeug.exceptions.abort(response)`: a response that ends the controller early but still gets post_dispatch. */
export class AbortResponse extends Error {
  constructor(readonly response: Response) {
    super("abort");
    this.name = "AbortResponse";
  }
}

/** The names and default descriptions of werkzeug's HTTPException subclasses the port raises. */
const HTTP_ERRORS: Record<number, { name: string; description: string }> = {
  400: { name: "Bad Request", description: "The browser (or proxy) sent a request that this server could not understand." },
  401: { name: "Unauthorized", description: "The server could not verify that you are authorized to access the URL requested. You either supplied the wrong credentials (e.g. a bad password), or your browser doesn't understand how to supply the credentials required." },
  403: { name: "Forbidden", description: "You don't have the permission to access the requested resource. It is either read-protected or not readable by the server." },
  404: { name: "Not Found", description: "The requested URL was not found on the server. If you entered the URL manually please check your spelling and try again." },
  405: { name: "Method Not Allowed", description: "The method is not allowed for the requested URL." },
  409: { name: "Conflict", description: "A conflict happened while processing the request. The resource might have been modified while the request was being processed." },
  415: { name: "Unsupported Media Type", description: "The server does not support the media type transmitted in the request." },
  422: { name: "Unprocessable Entity", description: "The request was well-formed but was unable to be followed due to semantic errors." },
  426: { name: "Upgrade Required", description: "The server cannot process the request using the current protocol." },
  500: { name: "Internal Server Error", description: "The server encountered an internal error and was unable to complete your request. Either the server is overloaded or there is an error in the application." },
};

function httpErrorInfo(status: number): { name: string; description: string } {
  return HTTP_ERRORS[status] ?? { name: `${status}`, description: "" };
}

/** `werkzeug.exceptions.HTTPException.get_body()`. */
export function werkzeugErrorResponse(status: number, description: string | null, headers: Record<string, string> = {}): Response {
  const info = httpErrorInfo(status);
  const desc = description ?? info.description;
  const body = `<!doctype html>\n<html lang=en>\n<title>${status} ${info.name}</title>\n<h1>${htmlEscape(info.name)}</h1>\n<p>${htmlEscape(desc)}</p>\n`;
  const h = new Headers(headers);
  h.set("Content-Type", "text/html; charset=utf-8");
  return new Response(body, { status, headers: h });
}

export interface DbFilterConfig {
  readonly pattern: string;
  readonly host: string;
}

/**
 * Odoo's `dbfilter` option (env DB_FILTER, a Python `re.match` pattern with %h and %d), scoped per request via
 * AsyncLocalStorage so concurrent requests with different Host headers never race.
 */
const dbFilterStorage = new AsyncLocalStorage<DbFilterConfig | null>();
let dbFilterFallback: DbFilterConfig | null = null;

export function makeDbFilterConfig(env: Pick<Env, "DB_FILTER">, host: string): DbFilterConfig | null {
  return env.DB_FILTER ? { pattern: env.DB_FILTER, host } : null;
}

export function runWithDbFilter<T>(config: DbFilterConfig | null, fn: () => T): T {
  return dbFilterStorage.run(config, fn);
}

/**
 * `router.py:87-122 db_filter`: without `dbfilter`/`db_name` configured every name passes; the shape is still checked.
 * The Worker's own files database (src/filestore_files.ts FILES_DB) never passes, whatever DB_FILTER says, as the
 * database list already leaves out `postgres` and the templates (dbList).
 */
export function dbFilter(dbs: readonly string[], config?: DbFilterConfig | null): string[] {
  const shaped = dbs.filter((db) => DB_NAME_RE.test(db) && !isReservedDb(db));
  const store = dbFilterStorage.getStore();
  const cfg = config !== undefined ? config : (store !== undefined ? store : dbFilterFallback);
  if (cfg === null) return shaped;
  // router.py:104-116: host without port and "www.", %h the host and %d its first label, both regex-escaped
  const host = cfg.host.split(":")[0]!.replace(/^www\./, "");
  const domain = host.split(".")[0]!;
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // re.match anchors at the start only
  const re = new RegExp("^(?:" + cfg.pattern.replaceAll("%h", esc(host)).replaceAll("%d", esc(domain)) + ")");
  return shaped.filter((db) => re.test(db));
}

/** Sets the fallback dbfilter (for direct unit tests outside handleRequest). */
export function configureDbFilter(env: Env, host: string): void {
  dbFilterFallback = makeDbFilterConfig(env, host);
}

/**
 * `router.py:70-84 db_list`. With a dbfilter configured, `modules/db.py:703-734 list_dbs`: the databases the
 * connecting role owns on the server, read through the `postgres` database (db_system), then filtered. Otherwise
 * the slot databases (wrangler SLOTS); locally the list stays empty and the monodb heuristic never applies (the
 * harness names its database by `?db=`).
 */
export async function dbList(env: Env): Promise<string[]> {
  if (env.DB_FILTER) {
    const cr = new Cursor(env, "postgres");
    try {
      const r = await cr.query<{ datname: string }>(
        `SELECT datname FROM pg_database
          WHERE datdba = (SELECT usesysid FROM pg_user WHERE usename = current_user)
            AND NOT datistemplate AND datallowconn AND datname NOT IN ('postgres', 'template0', '${FILES_DB}')
          ORDER BY datname`);
      return dbFilter(r.rows.map((x) => x.datname));
    } catch {
      return []; // list_dbs logs psycopg2 errors and returns []
    } finally {
      await cr.close();
    }
  }
  const slots = JSON.parse(env.SLOTS) as Record<string, string>;
  return dbFilter(Object.keys(slots));
}

interface Served {
  readonly ctx: RequestContextImpl;
  readonly response: Response;
}

/** The part of the Workers ExecutionContext the dispatcher uses. */
export interface WaitUntil { waitUntil(promise: Promise<unknown>): void }

/** retrying.py:23 MAX_TRIES_ON_CONCURRENCY_FAILURE. */
const MAX_TRIES_ON_CONCURRENCY_FAILURE = 5;


/** Thrown out of serve_db after the rollback when a concurrency failure may still be retried. */
class RetryRequest extends Error {
  constructor(override readonly cause: unknown) { super("retry after a concurrency failure"); }
}

/**
 * router.py:420, :446 `retrying(serve_ir_http)` (odoo/odoo/http/retrying.py:27-120): a serialization failure, deadlock
 * or lock timeout rolls the transaction back and serves the request again, up to 5 tries, after a random wait of
 * uniform(0, 2**tryno) seconds; the session is read again (`_set_session_and_dbname`) and the body is replayed from a
 * copy. The last failure is handled as any other error.
 */
export async function handleRequest(request: Request, env: Env, exec?: WaitUntil): Promise<Response> {
  // SQL_LOG=1: the request's phases (src/phases.ts), logged once all its waitUntil work has ended
  const ph = phasesWanted(env) ? new Phases() : null;
  const tracked = ph !== null && exec !== undefined ? ph.track(exec) : exec;
  try {
    for (let tryno = 1; ; tryno++) {
      const last = tryno >= MAX_TRIES_ON_CONCURRENCY_FAILURE;
      try {
        return await handleRequestOnce(last ? request : request.clone(), env, tracked, !last, ph);
      } catch (e) {
        if (!(e instanceof RetryRequest)) throw e;
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 2 ** tryno * 1000));
      }
    }
  } finally {
    if (ph !== null) {
      ph.responded();
      const path = new URL(request.url).pathname;
      const log = (): void => {
        ph.done();
        logPhases(ph, path);
      };
      if (exec !== undefined) exec.waitUntil(ph.settled().then(log));
      else log();
    }
  }
}

/**
 * The SQL_LOG line of each cursor the request closed, the last with the phases (src/phases.ts); a request without a
 * cursor gets a `req` line with the phases alone.
 */
function logPhases(ph: Phases, path: string): void {
  const lines = ph.sqlLines;
  if (lines.length === 0) {
    console.log(`req ${path} ${ph.fields()}`);
    return;
  }
  for (let i = 0; i < lines.length; i++) console.log(i === lines.length - 1 ? `${lines[i]} ${ph.fields()}` : lines[i]);
}

/**
 * The database each session id had on this isolate's last request with it (bounded, oldest out): the next request
 * with that id starts connecting to it while the session is read from its Durable Object, instead of after (C2d: the
 * session read took about 18 ms on the site before the connection's 26-33 ms could begin). Only a guess: the request
 * takes the cursor only when the session names that database, and otherwise closes it unused.
 */
const EARLY_DB = new Map<string, string>();
const EARLY_DB_MAX = 4096;

function rememberDb(sid: string, db: string): void {
  if (sid === "") return;
  EARLY_DB.delete(sid);
  EARLY_DB.set(sid, db);
  if (EARLY_DB.size > EARLY_DB_MAX) {
    const oldest = EARLY_DB.keys().next().value;
    if (oldest !== undefined) EARLY_DB.delete(oldest);
  }
}

async function handleRequestOnce(request: Request, env: Env, exec: WaitUntil | undefined, mayRetry: boolean, ph: Phases | null): Promise<Response> {
  const url = new URL(request.url);
  return dbFilterStorage.run(makeDbFilterConfig(env, request.headers.get("host") ?? url.host), async () => {
    const store = new SessionStore(env);
    const cookies = parseCookies(request.headers.get("cookie"));
    const nowSec = Date.now() / 1000;
    const sid = cookies.get("session_id") ?? "";
    const guess = sid === "" ? undefined : EARLY_DB.get(sid);
    const early = guess === undefined || isReservedDb(guess) ? null : new Cursor(env, guess);
    if (early !== null) early.phases = ph;
    early?.connectEarly();
    let ctxSeen: RequestContextImpl | null = null;
    try {
      return await serveRequest(request, env, exec, mayRetry, url, store, cookies, nowSec, sid, early, ph, (ctx) => { ctxSeen = ctx; });
    } finally {
      const seen = ctxSeen as RequestContextImpl | null;
      const unused = seen !== null ? seen.takeUnusedCursor() : early;
      if (unused !== null) {
        const closing = unused.abandon();
        if (exec) exec.waitUntil(closing);
        else await closing;
      }
      if (seen !== null && seen.db !== null && seen.sessionState.db === seen.db) rememberDb(seen.sessionState.sid, seen.db);
    }
  });
}

async function serveRequest(request: Request, env: Env, exec: WaitUntil | undefined, mayRetry: boolean, url: URL, store: SessionStore,
  cookies: ReadonlyMap<string, string>, nowSec: number, sid: string, early: Cursor | null, ph: Phases | null,
  seen: (ctx: RequestContextImpl) => void): Promise<Response> {
  // router.py:496-532 _set_session_and_dbname
  ph?.enter("sess");
  const session = await store.get(sid, true);
  ph?.enter("setup");
  for (const [k, v] of Object.entries(getDefaultSession(nowSec))) session.setdefault(k, v);
  const bestLang = bestLangOf(request);
  if (typeof session.context["lang"] !== "string" || session.context["lang"] === "") session.setContextKey("lang", bestLang);

  let dbname: string | null = null;
  const headerDb = request.headers.get("x-odoo-database");
  if (session.db !== null && dbFilter([session.db]).length === 1) {
    dbname = session.db;
    if (headerDb !== null && headerDb !== dbname) {
      return werkzeugErrorResponse(403, "Cannot use both the session_id cookie and the x-odoo-database header.");
    }
  } else if (headerDb !== null) {
    session.canSave = false; // stateless
    if (dbFilter([headerDb]).length === 1) dbname = headerDb;
  } else {
    const all = await dbList(env);
    if (all.length === 1) dbname = all[0] ?? null; // monodb
  }
  if (session.db !== dbname) {
    if (session.db !== null) logoutSession(session, false, bestLang, nowSec); // dbfilter rejected it
    session.db = dbname;
  }
  session.isDirty = false;

  const ctx = new RequestContextImpl(env, request, url, dbname, session, cookies, store);
  ctx.phases = ph;
  seen(ctx);
  if (early !== null) ctx.offerCursor(early);
  ctx.mayRetry = mayRetry;
  ctx.waitUntil = exec ? (p) => exec.waitUntil(p) : null;
  if (dbname !== null) {
    try {
      return await finish(await serveDb(ctx), exec);
    } catch (e) {
      if (!isRegistryError(e)) throw e;
      // router.py:280-293: database unusable -> log the session out and serve without a database
      await closeCursor(ctx, false);
      logoutSession(session, false, bestLang, nowSec);
      let nodbUrl = url;
      if (url.pathname.startsWith("/odoo/") || ["/odoo", "/web", "/web/login", "/test_http/ensure_db"].includes(url.pathname)) {
        nodbUrl = new URL(url.toString());
        nodbUrl.searchParams.delete("db");
      }
      const nodbCtx = new RequestContextImpl(env, request, nodbUrl, null, session, cookies, store);
      nodbCtx.waitUntil = ctx.waitUntil;
      nodbCtx.phases = ph;
      return await finish(await serveNodb(nodbCtx));
    }
  }
  return await finish(await serveNodb(ctx));
}

function bestLangOf(request: Request): string {
  // requestlib.py:277-282 default_lang: best Accept-Language or en_US
  const probe = new RequestContextImpl({ SLOTS: "{}" } as Env, request, new URL(request.url), null, new Session({}, "", true), new Map(), new SessionStore({ SLOTS: "{}" } as Env));
  return probe.defaultLang();
}

function isRegistryError(e: unknown): boolean {
  if (e instanceof UnknownDatabase) return true;
  // psycopg2.OperationalError on connect: pg reports 3D000 (invalid_catalog_name) for an unknown database
  return typeof e === "object" && e !== null && "code" in e && (e as { code: unknown }).code === "3D000";
}

async function finish(served: Served, exec?: WaitUntil): Promise<Response> {
  const pending = served.ctx.postResponse.splice(0);
  if (pending.length) {
    const run = (async () => { for (const fn of pending) await fn(); })();
    if (exec) exec.waitUntil(run);
    else await run;
  }
  return served.response;
}

async function closeCursor(ctx: RequestContextImpl, commit: boolean): Promise<void> {
  const cr = ctx.openedCursor();
  if (cr === null) return;
  try {
    if (commit) await cr.commit();
    else await cr.rollback();
  } finally {
    // the transaction is over: the connection's goodbye (Terminate, then the tunnel socket's close) is not waited for
    // before the response is sent (C2d), only kept alive by waitUntil
    const closing = cr.close();
    if (ctx.waitUntil !== null) ctx.waitUntil(closing.catch(() => undefined));
    else await closing;
    // SQL_LOG=1 (wrangler tail): statements per request and the time spent waiting on them, for latency work
    if (Reflect.get(ctx.env, "SQL_LOG") === "1") {
      const ms = cr.queries.reduce((a, q) => a + q.ms, 0);
      const cached = cr.queries.filter((q) => q.cached === true).length;
      // the registry was loaded by this request: from the shared cache (hit), the database and kept (put), or not (db)
      const reg = registrySourceOf(cr);
      const line = `sql ${ctx.url.pathname} n=${cr.queries.length - cached} cached=${cached} ms=${Math.round(ms)} connect=${Math.round(cr.connectMs)} rx=${cr.rxBytes} rt=${cr.roundTrips} early=${cr.early ? 1 : 0}${reg === undefined ? "" : ` reg=${reg}`}`;
      // with the phases, logged at the request's end (handleRequest); a context without them logs it now
      if (ctx.phases !== null) ctx.phases.sqlLines.push(line);
      else console.log(line);
      // SQL_LOG_STATEMENTS=1: each statement's first 160 characters; a larger number: that many
      const width = Number(Reflect.get(ctx.env, "SQL_LOG_STATEMENTS") ?? 0);
      if (width >= 1) for (const q of cr.queries) console.log(`  sql${q.cached ? "=" : ">"} ${q.cached ? "" : `[${q.rx ?? 0}B ${q.ms.toFixed(1)}ms] `}${q.sql.replace(/\s+/g, " ").slice(0, width === 1 ? 160 : width)}${q.at ? ` @@ ${q.at}` : ""}`);
    }
    // COMPILER_REQUEST_LOG=1 (compiler/speedpair.mjs, local only): per request the statements and the replaced registry
    // keys it ran, so that the speed measure keeps the requests that reach compiled code (compiler/PLAN.md K1a)
    if (Reflect.get(ctx.env, "COMPILER_REQUEST_LOG") === "1") {
      const replaced = new Set(replacedKeys());
      const hit = [...takeRequestHits()].filter((id) => replaced.has(id)).length;
      console.warn(`compiler-request ${ctx.url.search} sql=${cr.queries.filter((q) => q.cached !== true).length} replaced=${hit}`);
    }
  }
}

/** A handler's 101 upgrade response (bus websocket) is returned untouched: no cookies, no header mutation. */
function isUpgrade(response: Response): boolean {
  return response.status === 101 || response.webSocket !== null;
}

// --------------------------------------------------------------------------------- serve_db / serve_nodb

/** router.py:377-459 serve_db: match, authenticate, dispatch, commit; rollback and `_handle_error` on failure. */
async function serveDb(ctx: RequestContextImpl): Promise<Served> {
  setOverrideGuardMode(Reflect.get(ctx.env, "OVERRIDE_GUARD"));
  const method = ctx.request.method;
  let dispatcherType: "http" | "jsonrpc" | "json2" = "http"; // Request.__init__: HttpDispatcher until a rule matched
  try {
    // the registry's routing map (router.py:213-226): with the compiled routes of the database's template, when a
    // compiled route's pattern matches at all (src/http/router.ts templateRoute)
    const m = templateRouteCandidates(ctx.url.pathname).size
      ? matchPathFor((await templateOf(ctx.cursor())).name, method, ctx.url.pathname)
      : matchPath(method, ctx.url.pathname, false);
    if (m.kind === "method_not_allowed") throw new HttpError(405, "", { Allow: m.allowed.join(", ") });
    if (m.kind === "not_found") {
      // router.py:566-583 _serve_ir_http_fallback: ir.http._auth_method_public then _serve_fallback
      ctx.phases?.enter("disp");
      ctx.params = httpParams(ctx);
      const sessionUid = ctx.uid;
      if (ctx.uid === null) ctx.uid = await publicUserId(ctx.cursor());
      for (const fb of fallbacks()) {
        const response = await fb(ctx);
        if (response !== null) {
          const out = await postDispatch(ctx, response, null);
          await commit(ctx);
          return { ctx, response: out };
        }
      }
      // http_routing ir_http.py:571-608 `_handle_error` of the NotFound: its 404 page (src/controllers/not_found.ts)
      const page = await (await import("../controllers/not_found")).notFoundPage(ctx, sessionUid);
      if (page !== null) {
        const out = await postDispatch(ctx, page, null);
        await closeCursor(ctx, false); // :588 `request.env.cr.rollback()`
        return { ctx, response: out };
      }
      throw new HttpError(404, "", { "X-Odoo-Port-Fallback": "1" });
    }
    dispatcherType = m.route.type;
    checkDispatcherCompatible(ctx, m.route);
    const response = await serveIrHttp(ctx, m);
    await commit(ctx);
    return { ctx, response };
  } catch (e) {
    if (e instanceof AbortResponse) {
      // router.py:449-455: a response returned through abort() still gets post_dispatch
      const out = await postDispatch(ctx, e.response, null);
      await commit(ctx);
      return { ctx, response: out };
    }
    if (isRegistryError(e)) throw e;
    if (ctx.mayRetry && isConcurrencyError(e)) {
      await closeCursor(ctx, false); // retrying.py:66 env.cr.rollback()
      throw new RetryRequest(e);
    }
    // retrying.py:80-91: an IntegrityError becomes "The operation cannot be completed: ..." (ValidationError) for any
    // request; other psycopg2 errors keep their class (dispatcher.py:78 serialize_exception)
    const error = isPgError(e) ? await translateDbError(ctx, e) : e;
    const response = await handleError(ctx, error, dispatcherType);
    await closeCursor(ctx, false);
    return { ctx, response };
  }
}

/** router.py:349-374 serve_nodb: only auth="none" routes, no database. */
async function translateDbError(ctx: RequestContextImpl, e: unknown): Promise<unknown> {
  try {
    return await mapDbError(await ctx.orm(), e);
  } catch (inner) {
    if (inner instanceof OdooError) return inner;
    return isPgError(e) ? psycopgError(e) : e;
  }
}

async function serveNodb(ctx: RequestContextImpl): Promise<Served> {
  const m = matchPath(ctx.request.method, ctx.url.pathname, true);
  let dispatcherType: "http" | "jsonrpc" | "json2" = "http";
  try {
    if (m.kind === "method_not_allowed") throw new HttpError(405, "", { Allow: m.allowed.join(", ") });
    if (m.kind === "not_found") {
      // router.py:358-361: `exc.response = Response(not_found_nodb.html, status=404, mimetype='text/html')`, which
      // werkzeug's HTTPException returns as is (no post_dispatch: the exception leaves serve_nodb)
      throw new HttpResponseError(new Response(NOT_FOUND_NODB, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } }));
    }
    dispatcherType = m.route.type;
    checkDispatcherCompatible(ctx, m.route);
    preDispatchCommon(ctx, m.route);
    ctx.phases?.enter("disp");
    const response = await dispatch(ctx, m);
    return { ctx, response: await postDispatch(ctx, response, null) };
  } catch (e) {
    if (e instanceof AbortResponse) return { ctx, response: await postDispatch(ctx, e.response, null) };
    return { ctx, response: await handleError(ctx, e, dispatcherType) };
  }
}

async function commit(ctx: RequestContextImpl): Promise<void> {
  ctx.phases?.enter("commit");
  const callbacks = ctx.openedCursor()?.postcommit.splice(0) ?? [];
  await closeCursor(ctx, true);
  for (const fn of callbacks) await fn(); // cr.postcommit.run() (sql_db.py commit)
  for (const fn of ctx.postCommit) await fn(); // cr.postcommit
}

/** router.py:535-554 _set_request_dispatcher: a jsonrpc route needs a JSON body (dispatcher.py:317, 325-326). */
function checkDispatcherCompatible(ctx: RequestContextImpl, route: RouteDef): void {
  if (route.type === "json2") {
    // dispatcher.py:422-427 Json2Dispatcher.is_compatible_with: a JSON body or none
    const mt = (ctx.request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    const length = Number(ctx.request.headers.get("content-length") ?? "0");
    if (mt === "application/json" || !length) return;
    throw new HttpError(415,
      `Request inferred type is compatible with ['http'] but '${route.pattern.replace(/<(?:\w+:)?(\w+)>/g, "<$1>")}' is type='json2'.\n\nPlease verify the Content-Type request header and try again.`,
      { Accept: "application/json" });
  }
  if (route.type !== "jsonrpc") return;
  if (ctx.request.method === "OPTIONS" && route.cors !== null) return; // CORS preflight
  const mimetype = (ctx.request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (mimetype === "application/json" || mimetype === "application/json-rpc") return;
  throw new HttpError(
    415,
    `Request inferred type is compatible with ['http'] but '${route.pattern}' is type='jsonrpc'.\n\nPlease verify the Content-Type request header and try again.`,
    { Accept: "application/json, application/json-rpc" },
  );
}

/** router.py:586-595 serve_ir_http. */
async function serveIrHttp(ctx: RequestContextImpl, m: Match): Promise<Response> {
  ctx.phases?.enter("auth");
  await authenticate(ctx, m.route);
  ctx.phases?.enter("pre");
  await preDispatch(ctx, m.route);
  ctx.phases?.enter("disp");
  const response = await dispatch(ctx, m);
  return postDispatch(ctx, response, m.route);
}

// --------------------------------------------------------------------------------- authentication

/** base ir_http.py:378-420 `_authenticate` / `_authenticate_explicit`. */
async function authenticate(ctx: RequestContextImpl, route: RouteDef): Promise<void> {
  const auth = ctx.request.method === "OPTIONS" && route.cors !== null ? "none" : route.auth;
  const sess = ctx.sessionState;
  let sessionExpired: SessionExpired | null = null;
  const nowSec = Date.now() / 1000;
  try {
    if (sess.uid !== null) {
      const safe: Record<string, unknown> = {};
      for (const k of ["lang", "tz", "website_id"]) if (k in ctx.context) safe[k] = ctx.context[k];
      try {
        await checkSession(ctx.cursor(), ctx.store, sess, { remoteAddr: ctx.remoteAddr, userAgent: ctx.userAgent }, ctx.defaultLang(), nowSec);
      } catch (e) {
        if (!(e instanceof SessionExpired)) throw e;
        sessionExpired = e;
        Object.assign(safe, sess.context);
        ctx.uid = null;
        ctx.context = safe;
      }
    }
    if (auth === "bearer") {
      await authBearer(ctx, route);
    } else if (auth === "user") {
      // ir_http.py:361-365 _auth_method_user
      if (ctx.uid === null || ctx.uid === await publicUserId(ctx.cursor())) throw new SessionExpired("user is not connected");
    } else if (auth === "none") {
      ctx.uid = null; // ir_http.py:367-370
    } else {
      if (ctx.uid === null) ctx.uid = await publicUserId(ctx.cursor()); // ir_http.py:372-375
    }
  } catch (e) {
    // ir_http.py:395-399 `raise exc from session_expired_exc`: the outer exception (e.g. "user is not connected"),
    // the session check's only as its cause
    if (e instanceof SessionExpired) throw e;
    if (e instanceof AccessDenied || e instanceof HttpError || e instanceof NotPorted) throw e;
    throw e; // Odoo logs and raises AccessDenied() (ir_http.py:415-417); kept loud here
  }
  if (auth === "user" && sess.uid !== null) {
    // ir_http.py:589-606 _must_check_identity
    const device = getDevice(sess, { remoteAddr: ctx.remoteAddr, userAgent: ctx.userAgent }, (await ctx.now()).getTime() / 1000);
    if (device.trusted !== true) {
      const internal = (await userFlags(ctx.cursor(), sess.uid)).isInternal;
      const mustCheck = await icpBool(ctx.cursor(), "base.session_check_device");
      if (!internal || !mustCheck) {
        device.trusted = true;
        sess.isDirty = true;
      } else if (route.checkIdentity) {
        throw new NotPorted("CheckIdentityException: identity confirmation page (/web/session/identity)");
      }
    }
  }
}

/** ir_http.py:318-357 `_auth_method_bearer`. */
async function authBearer(ctx: RequestContextImpl, route: RouteDef): Promise<void> {
  const header = ctx.request.headers.get("authorization");
  const token = header ? /^bearer\s+(.+)$/i.exec(header)?.[1] ?? null : null;
  const unauthorized = (message: string): HttpError => new HttpError(401, message, { "WWW-Authenticate": "Bearer" });
  if (token) {
    const uid = await checkApikeyCredentials(ctx.cursor(), route.bearerScope ?? "", token);
    if (!uid) throw unauthorized("Invalid apikey");
    if (ctx.uid !== null && ctx.uid !== uid) throw new AccessDenied("Session user does not match the used apikey.");
    ctx.uid = uid;
    ctx.sessionState.canSave = false; // stateless
  } else if (ctx.uid === null) {
    throw unauthorized("User not authenticated, use an API Key with a Bearer Authorization header.");
  } else {
    const h = ctx.request.headers;
    const interactive = h.get("sec-fetch-dest") === "document" && h.get("sec-fetch-mode") === "navigate"
      && ["none", "same-origin"].includes(h.get("sec-fetch-site") ?? "") && h.get("sec-fetch-user") === "?1";
    if (!interactive) throw unauthorized('Missing "Authorization" or Sec-headers for interactive usage.');
  }
  // `_authenticate_explicit(dict(routing, auth='user'))`
  if (ctx.uid === null || ctx.uid === await publicUserId(ctx.cursor())) throw new SessionExpired("user is not connected");
}

// --------------------------------------------------------------------------------- pre dispatch

/** dispatcher.py:168-197 Dispatcher.pre_dispatch: save_session, CORS headers and preflight. */
function preDispatchCommon(ctx: RequestContextImpl, route: RouteDef): void {
  ctx.sessionState.canSave = ctx.sessionState.canSave && route.saveSession;
  if (route.cors !== null) {
    ctx.headers.set("Access-Control-Allow-Origin", route.cors);
    ctx.headers.set("Access-Control-Allow-Methods", route.type === "jsonrpc" ? "POST" : route.method === "ANY" ? "GET, POST" : route.method);
    if (ctx.request.method === "OPTIONS") {
      ctx.headers.set("Access-Control-Max-Age", String(CORS_MAX_AGE));
      ctx.headers.set("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, Range");
      throw new AbortResponse(new Response(null, { status: 204 }));
    }
  }
}

/** base ir_http.py:430-473 `_pre_dispatch` and web/models/ir_http.py:51-65 `_handle_debug`. */
async function preDispatch(ctx: RequestContextImpl, route: RouteDef): Promise<void> {
  preDispatchCommon(ctx, route);
  const debug = ctx.url.searchParams.get("debug");
  if (debug !== null) {
    // web/models/ir_http.py:52-60: each mode is kept if known, else '1' when truthy, else ''
    const modes = new Set(["", "1", "assets", "tests"]);
    ctx.sessionState.debug = debug.split(",").map((mode) => (modes.has(mode) ? mode : (str2bool(mode) ?? mode !== "") ? "1" : "")).join(",");
  }
  // ir_http.py:446-448: a valid context lang, from the user or the superuser's company
  const uid = ctx.uid ?? SUPERUSER_ID;
  const user = await fetchUser(ctx.cursor(), uid);
  const lang = typeof ctx.context["lang"] === "string" ? ctx.context["lang"] : undefined;
  ctx.updateContext({ lang: await getLangCode(ctx.cursor(), lang, user?.company_id ?? null) });
}

// --------------------------------------------------------------------------------- dispatch

/** requestlib.py:284-296 get_http_params: query args, then form fields (first value of repeated keys, as `dict(MultiDict)`). */
function httpParams(ctx: RequestContextImpl): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [k, v] of ctx.url.searchParams) if (!(k in params)) params[k] = v;
  if (ctx.form !== null) for (const [k, v] of ctx.form) if (!(k in params) || typeof params[k] === "string") params[k] = v;
  return params;
}

async function readForm(ctx: RequestContextImpl): Promise<void> {
  if (SAFE_HTTP_METHODS.includes(ctx.request.method)) return;
  const ct = (ctx.request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (ct === "application/x-www-form-urlencoded" || ct === "multipart/form-data") ctx.form = await ctx.request.formData();
}

async function dispatch(ctx: RequestContextImpl, m: Match): Promise<Response> {
  if (m.route.type === "jsonrpc") return dispatchJsonRpc(ctx, m);
  if (m.route.type === "json2") return dispatchJson2(ctx, m);
  // dispatcher.py:235-267 HttpDispatcher.dispatch
  await readForm(ctx);
  ctx.params = { ...httpParams(ctx), ...m.params };
  if (!SAFE_HTTP_METHODS.includes(ctx.request.method) && m.route.csrf) {
    if (ctx.db === null) return ctx.redirect("/web/database/selector");
    const token = ctx.params["csrf_token"];
    delete ctx.params["csrf_token"];
    if (!validateCsrf(await databaseSecret(ctx.cursor()), ctx.sessionState.sid, token)) {
      throw new HttpError(400, "Session expired (invalid CSRF token)");
    }
  }
  const handler = m.route.handler as Handler;
  return handler(ctx, m.params);
}

/** dispatcher.py:328-374 JsonRPCDispatcher.dispatch and 400-411 _response. */
async function dispatchJsonRpc(ctx: RequestContextImpl, m: Match): Promise<Response> {
  let body: unknown;
  try {
    body = JSON.parse(await ctx.request.text());
  } catch (e) {
    if (e instanceof SyntaxError) throw new AbortResponse(new Response("Invalid JSON data", { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }));
    throw e;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AbortResponse(new Response("Invalid JSON-RPC data", { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }));
  }
  const req = body as Record<string, unknown>;
  ctx.jsonRequestId = req["id"] ?? null;
  const params = req["params"];
  const dict = typeof params === "object" && params !== null && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
  ctx.jsonParams = { ...dict, ...m.params };
  ctx.params = ctx.jsonParams;
  const handler = m.route.handler as JsonHandler;
  const result = await handler(ctx, m.params);
  return jsonRpcResponse(ctx, { jsonrpc: "2.0", id: ctx.jsonRequestId, result: result === undefined ? null : result });
}

/** dispatcher.py:429-446 Json2Dispatcher.dispatch: the JSON body merged with the path arguments. */
async function dispatchJson2(ctx: RequestContextImpl, m: Match): Promise<Response> {
  let body: unknown = null;
  if (Number(ctx.request.headers.get("content-length") ?? "0")) {
    const text = await ctx.request.text();
    try {
      body = JSON.parse(text);
    } catch (e) {
      if (e instanceof SyntaxError) throw new NotPorted("json2 body that is not JSON (the BadRequest names json.loads' message)");
      throw e;
    }
  }
  // `self.jsonrequest | args`: a dict body, else the path arguments alone (TypeError)
  const params = typeof body === "object" && body !== null && !Array.isArray(body) ? { ...(body as Record<string, unknown>), ...m.params } : { ...m.params };
  ctx.jsonParams = params;
  ctx.params = params;
  const handler = m.route.handler as JsonHandler;
  const result = await handler(ctx, m.params);
  if (result instanceof Response) return result;
  return ctx.makeJsonResponse(result === undefined ? null : result);
}

function jsonRpcResponse(ctx: RequestContextImpl, envelope: Record<string, unknown>): Response {
  return ctx.makeJsonResponse(envelope);
}

// --------------------------------------------------------------------------------- post dispatch

/** dispatcher.py:208-216 post_dispatch: save_session, the future response headers, set_csp. */
async function postDispatch(ctx: RequestContextImpl, response: Response, route: RouteDef | null): Promise<Response> {
  void route;
  ctx.phases?.enter("post");
  if (isUpgrade(response)) return response;
  await saveSession(ctx);
  const out = new Response(response.body, response);
  for (const [k, v] of ctx.headers) out.headers.append(k, v);
  for (const c of ctx.cookies) out.headers.append("Set-Cookie", c);
  setCsp(out.headers);
  return out;
}

/** router.py:233-243 set_csp. */
function setCsp(headers: Headers): void {
  headers.set("X-Content-Type-Options", "nosniff");
  if (headers.has("Content-Security-Policy")) return;
  if (!(headers.get("Content-Type") ?? "").startsWith("image/")) return;
  headers.set("Content-Security-Policy", "default-src 'none'");
}

/** session.py:189-194 get_session_max_inactivity. */
async function sessionMaxInactivity(ctx: RequestContextImpl): Promise<number> {
  if (ctx.db === null) return SESSION_LIFETIME;
  return (await icpInt(ctx.cursor(), "sessions.max_inactivity_seconds")) || SESSION_LIFETIME;
}

export function sessionCookie(sid: string, maxAge: number): string {
  return dumpCookie("session_id", sid, { maxAge, expires: new Date(Date.now() + 365 * 86400 * 1000), httpOnly: true });
}

/** session.py:684-716 save_session. */
async function saveSession(ctx: RequestContextImpl): Promise<void> {
  const sess = ctx.sessionState;
  if (!sess.canSave) return;
  const nowSec = Date.now() / 1000;
  const tokenFn = ctx.db === null ? null : (sid: string): Promise<string | false> => {
    const uid = sess.uid;
    return uid === null ? Promise.resolve(false) : computeSessionToken(ctx.cursor(), uid, sid);
  };
  const ph = ctx.phases ?? null;
  const timed = (p: Promise<void>): Promise<void> => (ph === null ? p : ph.time("save", p));
  if (sess.shouldRotate) {
    await timed(ctx.store.rotate(sess, tokenFn, false, nowSec));
  } else if (
    sess.uid !== null
    && nowSec >= sess.createTime + SESSION_ROTATION_INTERVAL
    && !SESSION_ROTATION_EXCLUDED_PATHS.includes(ctx.url.pathname)
    && ctx.request.headers.get(SESSION_ROTATION_INTERVAL_HEADER_SKIP) === null
  ) {
    await timed(ctx.store.rotate(sess, tokenFn, true, nowSec));
  } else if (sess.isDirty) {
    await timed(ctx.store.save(sess));
  }
  const cookieSid = ctx.requestCookies.get("session_id");
  if (sess.isDirty || cookieSid !== sess.sid) {
    ctx.cookies.push(sessionCookie(sess.sid, await sessionMaxInactivity(ctx)));
  }
}

// --------------------------------------------------------------------------------- errors

/** dispatcher.py:78-91 serialize_exception. */
export function serializeException(e: unknown, now: number = Date.now() / 1000): Record<string, unknown> {
  const timestamp = Math.floor(now);
  if (e instanceof OdooError) return { ...e.data(), timestamp };
  if (e instanceof HttpError) {
    const info = httpErrorInfo(e.status);
    const message = `${e.status} ${info.name}: ${e.message !== "" ? e.message : info.description}`;
    return {
      name: `werkzeug.exceptions.${info.name.replace(/ /g, "")}`,
      message,
      arguments: [e.message !== "" ? e.message : null],
      timestamp,
      context: {},
      debug: `Traceback (most recent call last):\nwerkzeug.exceptions.${info.name.replace(/ /g, "")}: ${message}\n`,
    };
  }
  const err = e instanceof Error ? e : new Error(String(e));
  const name = err instanceof NotPorted ? "NotPorted" : `builtins.${err.name}`;
  return {
    name,
    message: err.message,
    arguments: [err.message],
    timestamp,
    context: {},
    // Odoo's debug is the Python traceback; the Worker's own stack is not sent (it names port internals, not Odoo's)
    debug: `Traceback (most recent call last):\n${name}: ${err.message}\n`,
  };
}

/**
 * `time.time()` of serialize_exception (dispatcher.py:85) on the database's clock: the request's `now()` (the
 * transaction start, which a harness frozen clock shifts per database) when a cursor is open and usable, the
 * Worker's clock otherwise.
 */
async function databaseNow(ctx: RequestContextImpl): Promise<number> {
  const cr = ctx.openedCursor();
  if (cr === null) return Date.now() / 1000;
  try {
    const row = (await cr.query<{ t: string | number }>("SELECT EXTRACT(EPOCH FROM now()) AS t")).rows[0];
    return row ? Number(row.t) : Date.now() / 1000;
  } catch {
    return Date.now() / 1000; // aborted transaction
  }
}

/** HttpDispatcher.handle_error (dispatcher.py:269-312) and JsonRPCDispatcher.handle_error (376-398). */
/** The `http_status` of Odoo's exceptions (exceptions.py, http/session.py:85). */
const HTTP_STATUS: Record<string, number> = {
  "odoo.exceptions.UserError": 422, "odoo.exceptions.ValidationError": 422, "odoo.exceptions.AccessDenied": 403, "odoo.exceptions.AccessError": 403,
  "odoo.exceptions.MissingError": 404, "odoo.exceptions.LockError": 409, "odoo.http.session.SessionExpiredException": 403,
};

async function handleError(ctx: RequestContextImpl, e: unknown, dispatcherType: "http" | "jsonrpc" | "json2"): Promise<Response> {
  // public demo only (DEMO_MODE=1, never LOCAL_DEV): a refusal of the port shows as Odoo's UserError dialog
  e = demoNotPortedFloor(ctx.env, e, ctx.url.pathname);
  if (e instanceof HttpResponseError) return e.response; // werkzeug HTTPException.get_response() of a given response
  if (dispatcherType === "json2") {
    // dispatcher.py:448-472 Json2Dispatcher.handle_error
    const now = await databaseNow(ctx);
    if (e instanceof OdooError && e.odooName in HTTP_STATUS) return ctx.makeJsonResponse(serializeException(e, now), {}, HTTP_STATUS[e.odooName]!);
    if (e instanceof HttpError) {
      const info = httpErrorInfo(e.status);
      const description = e.message !== "" ? e.message : info.description;
      const name = `werkzeug.exceptions.${info.name.replace(/ /g, "")}`;
      const body = { name, message: description, arguments: [description, e.status], timestamp: Math.floor(now), context: {},
        debug: `Traceback (most recent call last):\n${name}: ${e.status} ${info.name}: ${description}\n` };
      return ctx.makeJsonResponse(body, { ...e.headers }, e.status);
    }
    return ctx.makeJsonResponse(serializeException(e, now), {}, 500);
  }
  if (dispatcherType === "jsonrpc") {
    const error: Record<string, unknown> = { code: 0, message: "Odoo Server Error", data: serializeException(e, await databaseNow(ctx)) }; // dispatcher.py:387 code 0
    if (e instanceof HttpError && e.status === 404) {
      error["code"] = 404;
      error["message"] = "404: Not Found";
    } else if (e instanceof SessionExpired) {
      error["code"] = 100;
      error["message"] = "Odoo Session Expired";
    }
    const h = new Headers({ "Content-Type": "application/json; charset=utf-8" });
    if (e instanceof HttpError) for (const [k, v] of Object.entries(e.headers)) h.set(k, v);
    return new Response(dumpsResponse({ jsonrpc: "2.0", id: ctx.jsonRequestId, error }), { status: 200, headers: h });
  }
  if (e instanceof SessionExpired) {
    // dispatcher.py:280-301: log out, redirect to the login page, rotate the cookie if a user was connected
    const sess = ctx.sessionState;
    const wasConnected = sess.uid !== null;
    logoutSession(sess, true, ctx.defaultLang(), Date.now() / 1000);
    const fullPath = `${ctx.url.pathname}?${ctx.url.search.slice(1)}`; // werkzeug full_path always carries "?"
    const response = ctx.redirectQuery("/web/login", { redirect: fullPath });
    if (wasConnected) {
      await ctx.store.rotate(sess, null, false, Date.now() / 1000);
      response.headers.append("Set-Cookie", sessionCookie(sess.sid, await sessionMaxInactivity(ctx).catch(() => SESSION_LIFETIME)));
    }
    // web/models/ir_http.py:67-70 _post_logout: cids cookie expired
    response.headers.append("Set-Cookie", expiredCookie("cids", new Date()));
    return response;
  }
  if (e instanceof HttpError) return werkzeugErrorResponse(e.status, e.message === "" ? null : e.message, e.headers);
  if (e instanceof AccessDenied || e instanceof AccessError) return werkzeugErrorResponse(403, e.message);
  if (e instanceof MissingError) return werkzeugErrorResponse(404, e.message);
  if (e instanceof UserError || e instanceof OdooError) return werkzeugErrorResponse(422, e.message);
  // dispatcher.py:312 `InternalServerError()`: werkzeug's generic page, no cause and no stack; the cause goes to the log
  console.error("Exception during request handling.", e);
  return werkzeugErrorResponse(500, null);
}

// --------------------------------------------------------------------------------- ensure_db

/**
 * web/controllers/utils.py:67-118 `ensure_db`, for the auth="none" web client routes. Raises AbortResponse with
 * the redirect Odoo issues: 302 to the same URL once the session carries the database, 303 to the selector when
 * none can be found.
 */
export async function ensureDb(ctx: RequestContext, redirect = "/web/database/selector"): Promise<void> {
  const impl = ctx as RequestContextImpl;
  const raw = ctx.params["db"];
  let db: string | null = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
  if (db !== null && dbFilter([db]).length !== 1) db = null;
  const sess = ctx.sessionState;
  if (db !== null && sess.db === null) {
    // utils.py:82-96: a database asked on a new session; redirect with the cookie set
    sess.db = db;
    impl.background(warmDatabaseObjects(ctx.env, db));
    throw new AbortResponse(ctx.redirect(`${ctx.url.pathname}${ctx.url.search}`, 302));
  }
  if (db === null && sess.db !== null && dbFilter([sess.db]).length === 1) db = sess.db;
  if (db === null) {
    const all = await dbList(ctx.env);
    if (all.length === 1) db = all[0] ?? null;
  }
  if (db === null) throw new AbortResponse(ctx.redirect(redirect, 303));
  if (db !== sess.db) {
    // utils.py:113-118: switch the session to the computed database
    const fresh = ctx.store.new();
    fresh.update({ ...getDefaultSession(Date.now() / 1000), db });
    fresh.setContextKey("lang", ctx.defaultLang());
    impl.replaceSession(fresh);
    throw new AbortResponse(ctx.redirect(`${ctx.url.pathname}${ctx.url.search}`, 302));
  }
}

/**
 * The database's Durable Objects (its written files and its bus), called once with nothing to do when a session takes
 * the database: the first call to an object named by `idFromName` waits for Cloudflare's global check of the name,
 * 0.95-1.3 s on the site (results/evidence/c2d), and a new database's first page waited for both (the stylesheet and
 * fonts for the files, the websocket for the bus). Started here, the checks run while the browser follows the
 * redirect and loads the login page. Nothing in the objects changes; a failure is only logged.
 */
async function warmDatabaseObjects(env: Env, db: string): Promise<void> {
  // and the session store's objects, once per isolate (src/session/session.ts): from here they are placed next to the
  // Worker, as the database's
  const calls: Promise<void>[] = [];
  if (Reflect.get(env, "SESSION")) calls.push(warmSessionObjects(env));
  if (Reflect.get(env, "FILESTORE_DO")) calls.push(env.FILESTORE_DO.get(env.FILESTORE_DO.idFromName(db)).ping());
  if (Reflect.get(env, "BUS")) calls.push((env.BUS as DurableObjectNamespace<BusDispatcher>).get(env.BUS.idFromName(db)).ping());
  const failed = (await Promise.allSettled(calls)).find((r) => r.status === "rejected");
  if (failed) console.warn(`database objects of ${db}: warm-up failed`, failed.reason);
}

export { redirectResponse, Cursor };
