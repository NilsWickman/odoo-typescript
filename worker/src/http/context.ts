/**
 * Per-request state, Odoo's `request` object (`odoo/odoo/http/requestlib.py`, `session.py`).
 * Owned by the HTTP stream (src/http/, src/session/). Controllers receive a RequestContext and return a Response.
 */
import type { Env } from "../env";
import { Cursor } from "../db";
import type { Context, Environment } from "../orm/types";
import { Session, SessionStore, DEFAULT_LANG } from "../session/session";
import { csrfToken } from "./csrf";
import { dumpsResponse } from "./json";
import { databaseSecret, dbNow } from "../session/user";
import { NotPorted } from "../errors";
import { readFile } from "../filestore";
import { FILESTORE_READER_KEY } from "../models/binary";
import { PDF_ENGINE_KEY, pdfEngineOf } from "../report/engine";
import { APPS_INSTALLABLE_KEY, appsInstallableOnly } from "../modules/apps_visible";
import { REQUEST_INFO_KEY, type RequestInfo } from "../models/request_info";
import type { Phases } from "../phases";

/** The session dict Odoo stores (`odoo/odoo/http/session.py` Session, `get_default_session`), plus the sid. */
export interface SessionData {
  sid: string;
  uid: number | null;
  login: string | null;
  db: string | null;
  /** `session.context`: lang, tz, uid, ... as Odoo keeps them. */
  context: Context;
  debug: string;
  /** `_trace_disable`, `pre_login`, `pre_uid`, `identity-check-*` and other keys Odoo sets, kept verbatim. */
  [key: string]: unknown;
}

/**
 * `ctx.session` as a dict view of a `Session`: reads, writes (`session["k"] = v`, dirty-tracked), `in` and deletes
 * go through the Session so `is_dirty` stays right (session.py:105-123).
 */
export function sessionView(sess: Session): SessionData {
  const target = {} as SessionData;
  return new Proxy(target, {
    get: (_t, prop) => (prop === "sid" ? sess.sid : typeof prop === "string" ? sess.get(prop) : undefined),
    set: (_t, prop, value) => {
      if (typeof prop !== "string") return false;
      if (prop === "sid") sess.sid = String(value);
      else sess.set(prop, value);
      return true;
    },
    has: (_t, prop) => prop === "sid" || (typeof prop === "string" && sess.has(prop)),
    deleteProperty: (_t, prop) => {
      if (typeof prop === "string") sess.delete(prop);
      return true;
    },
    ownKeys: () => [...sess.keys()],
    getOwnPropertyDescriptor: (_t, prop) => (typeof prop === "string" && sess.has(prop)
      ? { value: sess.get(prop), writable: true, enumerable: true, configurable: true } : undefined),
  });
}

export interface RequestContext {
  readonly env: Env;
  readonly request: Request;
  readonly url: URL;
  /** The database the request is bound to (cookie `?db=`/session), or null before a database is chosen. */
  readonly db: string | null;
  /** Lazily opened cursor on `db`; committed by the dispatcher on success, rolled back on error. */
  cursor(): Cursor;
  /** The session dict (`odoo/odoo/http/session.py` Session): `sid`, `uid`, `db`, `login`, `context`, `debug`, ... */
  readonly session: SessionData;
  /** The same session as the object the dispatcher rotates and saves (`is_dirty`, `should_rotate`, `can_save`). */
  readonly sessionState: Session;
  /** Whether the session must be written back (Odoo's `session.is_dirty`). */
  sessionDirty: boolean;
  /** Set-Cookie values to add to the response (session cookie rotation, `cids`, ...): `future_response`. */
  readonly cookies: string[];
  /** Headers Odoo's `request.future_response` collects for the final response (dispatcher.py:208-216). */
  readonly headers: Headers;
  /** The ORM environment for `uid`/`context` (null without a database); needs the ORM stream's factory. */
  orm(): Promise<Environment>;
  /** The JSON-RPC `params` of a `type='jsonrpc'` route, else null. */
  readonly jsonParams: Record<string, unknown> | null;
  /** The parsed form body of an `http` POST route, else null. */
  readonly form: FormData | null;
  /** `request.params`: query string, form fields and path arguments merged (requestlib.py:284-296, dispatcher.py:244). */
  params: Record<string, unknown>;
  /** The request's cookies (`request.cookies`, with `cids` sanitized, web/models/ir_http.py:29-32). */
  readonly requestCookies: ReadonlyMap<string, string>;
  readonly remoteAddr: string;
  readonly userAgent: string;
  /** `request.env.uid`: the session user, None for auth="none", the public user for auth="public". */
  uid: number | null;
  /** `request.env.context`. */
  context: Context;
  updateContext(overrides: Record<string, unknown>): void;
  /** `request.best_lang` / `request.default_lang()` (requestlib.py:198-212, 277-282). */
  bestLang(): string | null;
  defaultLang(): string;
  /** `cr.now()`: the database's now(), one value per request. */
  now(): Promise<Date>;
  /** `request.csrf_token(time_limit)` (requestlib.py:224-244). */
  csrfToken(timeLimit?: number | null): Promise<string>;
  /** `request.redirect(location, code)` with `local=True` (requestlib.py:358-367). */
  redirect(location: string, code?: number): Response;
  /** `request.redirect_query(location, query, code)` (requestlib.py:369-372). */
  redirectQuery(location: string, query: Record<string, string> | null, code?: number): Response;
  /** `request.make_json_response(data, headers, status)` (requestlib.py:327-349). */
  makeJsonResponse(data: unknown, headers?: Record<string, string>, status?: number): Response;
  /** `request.httprequest.url_root.rstrip('/')`. */
  readonly baseLocation: string;
  readonly store: SessionStore;
  /** `cr.postcommit.add(fn)`: run after the request's COMMIT succeeded (bus fan-out of rows once visible). */
  afterCommit(fn: () => Promise<void>): void;
  /** The post-commit callbacks queued so far, and dropping those queued since: the bus notifications made inside a
   *  savepoint that is rolled back (sql_db.py `_FlushingSavepoint.rollback`: `cr.precommit.clear()`, where Odoo keeps
   *  them, e.g. base_import's dry run). */
  afterCommitMark(): number;
  dropAfterCommitSince(mark: number): void;
  /**
   * Run once the response has been handed back (ExecutionContext.waitUntil): bus deliveries Odoo makes from a later
   * transaction (e.g. the post-commit mail send), which a client receives after the HTTP answer.
   */
  afterResponse(fn: () => Promise<void>): void;
  /** The request's phases with SQL_LOG=1 (src/phases.ts), else null or absent. */
  readonly phases?: Phases | null;
}

const CONTEXT_OF_CURSOR = new WeakMap<Cursor, RequestContext>();
/** The request owning a cursor, for model code that must defer work after the commit (bus notifications). */
export function requestOfCursor(cr: Cursor): RequestContext | null {
  return CONTEXT_OF_CURSOR.get(cr) ?? null;
}

/** A cursor the request's own code opened (a cron job run in the HTTP thread, `method_direct_trigger`): owned by it. */
export function bindRequestCursor(ctx: RequestContext, cr: Cursor): Cursor {
  CONTEXT_OF_CURSOR.set(cr, ctx);
  return cr;
}

export type Handler = (ctx: RequestContext, params: Record<string, string>) => Promise<Response>;
/** A `type='jsonrpc'` controller: returns the `result` of the envelope; errors become `error`. */
export type JsonHandler = (ctx: RequestContext, params: Record<string, string>) => Promise<unknown>;

/** The ORM stream registers how an Environment is built (src/orm/); until then `orm()` raises NotPorted. */
export type EnvironmentFactory = (cr: Cursor, uid: number | null, context: Context) => Promise<Environment>;
let environmentFactory: EnvironmentFactory | null = null;

export function setEnvironmentFactory(factory: EnvironmentFactory): void {
  environmentFactory = factory;
}

/**
 * An ORM environment on a cursor the handler opened itself (the RPC services open `Registry(db).cursor()` on the
 * database named in the call, odoo/service/model.py:93, common.py:22), owned by `ctx` for deferred work.
 */
export async function ormEnvironmentOn(ctx: RequestContext, cr: Cursor, uid: number | null, context: Context): Promise<Environment> {
  if (environmentFactory === null) throw new NotPorted("ORM environment factory not registered");
  CONTEXT_OF_CURSOR.set(cr, ctx);
  return environmentFactory(cr, uid, context);
}

/** babel.core.LOCALE_ALIASES (`.venv/lib/python3.12/site-packages/babel/core.py`), used by `request.best_lang`. */
const LOCALE_ALIASES: Record<string, string> = {
  ar: "ar_SY", bg: "bg_BG", bs: "bs_BA", ca: "ca_ES", cs: "cs_CZ", da: "da_DK", de: "de_DE", el: "el_GR", en: "en_US",
  es: "es_ES", et: "et_EE", fa: "fa_IR", fi: "fi_FI", fr: "fr_FR", gl: "gl_ES", he: "he_IL", hu: "hu_HU", id: "id_ID",
  is: "is_IS", it: "it_IT", ja: "ja_JP", km: "km_KH", ko: "ko_KR", lt: "lt_LT", lv: "lv_LV", mk: "mk_MK", nl: "nl_NL",
  nn: "nn_NO", no: "nb_NO", pl: "pl_PL", pt: "pt_PT", ro: "ro_RO", ru: "ru_RU", sk: "sk_SK", sl: "sl_SI", sv: "sv_SE",
  th: "th_TH", tr: "tr_TR", uk: "uk_UA",
};

/** werkzeug `LanguageAccept.best`: the highest quality entry, first by position on ties. */
export function acceptLanguageBest(header: string | null): string | null {
  if (header === null) return null;
  let best: { lang: string; q: number } | null = null;
  for (const raw of header.split(",")) {
    const [langPart, ...params] = raw.trim().split(";");
    const lang = (langPart ?? "").trim();
    if (lang === "") continue;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(p);
      if (m !== null) q = Number(m[1]);
    }
    if (best === null || q > best.q) best = { lang, q };
  }
  return best?.lang ?? null;
}

/** requestlib.py:198-212 `best_lang`: `babel.parse_locale(lang, sep='-')`, aliasing a bare language code. */
export function bestLangFrom(header: string | null): string | null {
  const lang = acceptLanguageBest(header);
  if (lang === null || lang === "*") return null;
  const parts = lang.split("-");
  const code = (parts[0] ?? "").toLowerCase();
  if (!/^[a-z]{2,3}$/.test(code)) return null;
  const territory = parts.slice(1).find((p) => /^[A-Za-z]{2}$/.test(p) || /^\d{3}$/.test(p));
  if (territory !== undefined) return `${code}_${territory.toUpperCase()}`;
  return LOCALE_ALIASES[code] ?? null; // KeyError -> None
}

/** markupsafe.escape, as werkzeug's redirect page and error pages use it. */
export function htmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;").replace(/'/g, "&#39;");
}

/** `werkzeug.utils.redirect(location, code)`: the body werkzeug writes, with the Location header. */
export function redirectResponse(location: string, code: number, headers?: Headers): Response {
  const esc = htmlEscape(location);
  const body = `<!doctype html>\n<html lang=en>\n<title>Redirecting...</title>\n<h1>Redirecting...</h1>\n<p>You should be redirected automatically to the target URL: <a href="${esc}">${esc}</a>. If not, click the link.\n`;
  const h = new Headers(headers);
  h.set("Content-Type", "text/html; charset=utf-8");
  h.set("Location", location);
  return new Response(body, { status: code, headers: h });
}

/** `werkzeug.urls.url_encode(query)`: `quote_plus` of keys and values, joined by `&`. */
export function urlEncode(query: Record<string, string>): string {
  const enc = (s: string): string => encodeURIComponent(s).replace(/%20/g, "+").replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return Object.entries(query).map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");
}

export class RequestContextImpl implements RequestContext {
  private cr: Cursor | null = null;
  private nowValue: Promise<Date> | null = null;
  private envPromise: Promise<Environment> | null = null;
  readonly cookies: string[] = [];
  readonly headers = new Headers();
  params: Record<string, unknown> = {};
  uid: number | null;
  context: Context;
  jsonParams: Record<string, unknown> | null = null;
  /** The JSON-RPC request `id`, echoed in the envelope (dispatcher.py:360, 401). */
  jsonRequestId: unknown = null;
  form: FormData | null = null;
  readonly remoteAddr: string;
  readonly userAgent: string;
  readonly baseLocation: string;
  readonly postCommit: (() => Promise<void>)[] = [];
  readonly postResponse: (() => Promise<void>)[] = [];
  /** Whether a concurrency failure may still be retried (http/retrying.py, src/http/dispatch.ts handleRequest). */
  mayRetry = false;
  session: SessionData;
  private sess: Session;

  constructor(
    readonly env: Env,
    readonly request: Request,
    readonly url: URL,
    readonly db: string | null,
    session: Session,
    readonly requestCookies: ReadonlyMap<string, string>,
    readonly store: SessionStore,
  ) {
    this.sess = session;
    this.session = sessionView(session);
    this.uid = session.uid;
    this.context = { ...session.context };
    // odoo/http.py behind a proxy (`proxy_mode`, ProxyFix): the public host is the forwarded one. Off unless configured,
    // as in Odoo: a client-set header would otherwise reach `web.base.url` on an admin login.
    const forwarded = env.PROXY_MODE === "1" ? request.headers.get("x-forwarded-host") : null;
    // `httprequest.remote_addr`: on Cloudflare the client address is CF-Connecting-IP. Behind Odoo's proxy mode
    // (router.py:256, only with X-Forwarded-Host) werkzeug's ProxyFix(x_for=1) takes the last X-Forwarded-For entry,
    // the one the trusted proxy appended; earlier entries are the client's own and are ignored.
    const forwardedFor = forwarded ? request.headers.get("x-forwarded-for")?.split(",").map((x) => x.trim()).at(-1) : undefined;
    this.remoteAddr = request.headers.get("cf-connecting-ip") ?? (forwardedFor || null) ?? "127.0.0.1";
    this.userAgent = request.headers.get("user-agent") ?? "";
    this.baseLocation = forwarded ? `${request.headers.get("x-forwarded-proto") ?? url.protocol.slice(0, -1)}://${forwarded}` : url.origin;
  }

  cursor(): Cursor {
    if (this.db === null) throw new Error("no database for this request");
    if (this.cr === null) {
      const early = this.early;
      this.early = null;
      this.cr = early !== null && early.db === this.db && !early.earlyFailed ? early : new Cursor(this.env, this.db);
      if (early !== null && early !== this.cr) this.unused = early;
      this.cr.waitUntil = (p) => { if (this.waitUntil !== null) this.waitUntil(p); };
      this.cr.phases = this.phases;
      CONTEXT_OF_CURSOR.set(this.cr, this);
    }
    return this.cr;
  }

  private early: Cursor | null = null;
  private unused: Cursor | null = null;

  /** A cursor already connecting to this request's database (src/http/dispatch.ts), taken by the first `cursor()`. */
  offerCursor(cr: Cursor): void {
    this.early = cr;
  }

  /** The offered cursor when no `cursor()` took it, to be abandoned by the dispatcher. */
  takeUnusedCursor(): Cursor | null {
    const c = this.early ?? this.unused;
    this.early = null;
    this.unused = null;
    return c;
  }

  /** The cursor if one was opened (for commit/rollback/close by the dispatcher). */
  openedCursor(): Cursor | null {
    return this.cr;
  }

  get sessionState(): Session {
    return this.sess;
  }

  /** `request.session = session_store().new()` (utils.py:115 ensure_db): swap the session object. */
  replaceSession(session: Session): void {
    this.sess = session;
    this.session = sessionView(session);
  }

  get sessionDirty(): boolean {
    return this.sess.isDirty;
  }
  set sessionDirty(v: boolean) {
    this.sess.isDirty = v;
  }

  afterCommit(fn: () => Promise<void>): void {
    this.postCommit.push(fn);
  }

  afterCommitMark(): number {
    return this.postCommit.length;
  }

  dropAfterCommitSince(mark: number): void {
    this.postCommit.splice(mark);
  }

  afterResponse(fn: () => Promise<void>): void {
    this.postResponse.push(fn);
  }

  /** The ExecutionContext's `waitUntil` (src/http/dispatch.ts), null where there is none (tests). */
  waitUntil: ((p: Promise<unknown>) => void) | null = null;
  /** The request's phases with SQL_LOG=1 (src/phases.ts, set by src/http/dispatch.ts), else null. */
  phases: Phases | null = null;

  /** Work the response does not wait for and nothing reads (the database's objects woken, `ensureDb`). */
  background(p: Promise<void>): void {
    const done = p.catch((e: unknown) => console.warn("background work failed", e));
    if (this.waitUntil !== null) this.waitUntil(done);
  }

  orm(): Promise<Environment> {
    if (this.envPromise === null) {
      if (environmentFactory === null) {
        return Promise.reject(new NotPorted("ORM environment: src/orm/ has not registered setEnvironmentFactory"));
      }
      this.envPromise = environmentFactory(this.cursor(), this.uid, this.context).then(env => {
        env.cache.set(FILESTORE_READER_KEY, (name: string) => {
          const read = readFile(this.env, this.db!, name);
          return this.phases === null ? read : this.phases.time("fs", read);
        });
        env.cache.set(PDF_ENGINE_KEY, pdfEngineOf(this.env, this.db) !== null);
        env.cache.set(APPS_INSTALLABLE_KEY, appsInstallableOnly(this.env.APPS_INSTALLABLE_DBS, this.db));
        const info: RequestInfo = { sid: () => this.sess.sid, remoteAddr: this.remoteAddr, userAgent: this.userAgent };
        env.cache.set(REQUEST_INFO_KEY, info);
        return env;
      });
    }
    return this.envPromise;
  }

  updateContext(overrides: Record<string, unknown>): void {
    this.context = { ...this.context, ...overrides };
    this.envPromise = null; // request.update_env builds a new environment (requestlib.py:142-153)
  }

  bestLang(): string | null {
    return bestLangFrom(this.request.headers.get("accept-language"));
  }

  defaultLang(): string {
    return this.bestLang() ?? DEFAULT_LANG;
  }

  now(): Promise<Date> {
    if (this.nowValue === null) this.nowValue = dbNow(this.cursor());
    return this.nowValue;
  }

  async csrfToken(timeLimit: number | null = null): Promise<string> {
    return csrfToken(await databaseSecret(this.cursor()), this.sess.sid, timeLimit);
  }

  redirect(location: string, code = 303): Response {
    // requestlib.py:362-364: drop scheme and netloc, keep one leading slash
    let loc = location;
    try {
      const u = new URL(location, "http://local");
      loc = `${u.pathname}${u.search}${u.hash}`;
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
    }
    loc = "/" + loc.replace(/^[/\\]+/, "");
    return redirectResponse(loc, code);
  }

  redirectQuery(location: string, query: Record<string, string> | null, code = 303): Response {
    const loc = query !== null && Object.keys(query).length > 0 ? `${location}?${urlEncode(query)}` : location;
    return this.redirect(loc, code);
  }

  makeJsonResponse(data: unknown, headers: Record<string, string> = {}, status = 200): Response {
    const body = dumpsResponse(data);
    const h = new Headers(headers);
    if (!h.has("Content-Type")) h.set("Content-Type", "application/json; charset=utf-8");
    return new Response(body, { status, headers: h });
  }
}
