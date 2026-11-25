/**
 * Odoo's HTTP session (`odoo/odoo/http/session.py`): the `Session` mapping with dirty tracking, the default
 * values, sid generation and the store (`SessionStore`), here backed by a fixed set of Durable Objects
 * (src/do/session.ts) instead of the filesystem.
 */
import { randomBytes } from "node:crypto";
import type { Env } from "../env";
import type { SessionStore as SessionStoreDO } from "../do/session";
import type { Context } from "../orm/types";

export const DEFAULT_LANG = "en_US"; // session.py:36
export const SESSION_LIFETIME = 60 * 60 * 24 * 7; // session.py:39
export const SESSION_ROTATION_EXCLUDED_PATHS: readonly string[] = [
  "/websocket/on_closed", "/websocket/peek_notifications", "/websocket/update_bus_presence",
]; // session.py:46-50
export const SESSION_ROTATION_INTERVAL = 60 * 60 * 3; // session.py:53
export const SESSION_ROTATION_INTERVAL_HEADER_SKIP = "X-Odoo-Skip-Session-Rotation-Interval"; // session.py:59
export const SESSION_DELETION_TIMER = 120; // session.py:62
export const STORED_SESSION_BYTES = 42; // session.py:69
export const DEVICE_ACTIVITY_UPDATE_FREQUENCY = 3600; // session.py:76

// session.py:80-82 (84 kept for sessions of the old generator, which the store never produces here)
const BASE64_URLSAFE_RE = /^[A-Za-z0-9_-]{84,86}$/;

/** The session dict Odoo stores (session.py:187-203 `get_default_session`, keys kept verbatim). */
export interface SessionData {
  context: Context & { lang?: string };
  create_time: number;
  db: string | null;
  debug: string;
  login: string | null;
  uid: number | null;
  session_token: string | null;
  _devices: Record<string, Device>;
  _device_salt: string;
  [key: string]: unknown;
}

/** session.py:177-184 `Device`. */
export interface Device {
  ip_address: string;
  user_agent: string;
  first_activity: number;
  last_activity: number | null;
  country: string | null;
  city: string | null;
  trusted?: boolean;
}

/** `secrets.token_urlsafe(n)`: base64url without padding of n random bytes. */
export function tokenUrlsafe(nbytes = 32): string {
  return randomBytes(nbytes).toString("base64url");
}

/** session.py:187-203: the dictionary a new session is initialised with (lang and host_id set at runtime). */
export function getDefaultSession(now: number = Date.now() / 1000): SessionData {
  return {
    context: {},
    create_time: now,
    db: null,
    debug: "",
    login: null,
    uid: null,
    session_token: null,
    _devices: {},
    _device_salt: tokenUrlsafe(),
  };
}

/** Python `value == stored` after a `json.loads(json.dumps(value))` round trip (session.py:106-109). */
function jsonRoundTrip(value: unknown): unknown {
  return value === undefined ? null : (JSON.parse(JSON.stringify(value)) as unknown);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  return ak.length === bk.length && ak.every((k) => k in bo && deepEqual(ao[k], bo[k]));
}

/** session.py:92-175 `Session`: a mapping that remembers whether it changed. */
export class Session {
  canSave = true; // session.py:103
  isDirty = false;
  isNew: boolean;
  shouldRotate = false;
  sid: string;
  private data: Record<string, unknown>;

  constructor(data: Record<string, unknown>, sid: string, isNew = false) {
    this.data = {};
    for (const [k, v] of Object.entries(data)) this.data[k] = jsonRoundTrip(v);
    this.isDirty = false;
    this.isNew = isNew;
    this.sid = sid;
  }

  get(key: string): unknown {
    return this.data[key];
  }

  has(key: string): boolean {
    return key in this.data;
  }

  keys(): string[] {
    return Object.keys(this.data);
  }

  /** `__setitem__`: a JSON round trip, dirty only when the value changed (session.py:105-109). */
  set(key: string, value: unknown): void {
    const v = jsonRoundTrip(value);
    if (!(key in this.data) || !deepEqual(this.data[key], v)) this.isDirty = true;
    this.data[key] = v;
  }

  setdefault(key: string, value: unknown): void {
    if (!(key in this.data)) this.set(key, value);
  }

  delete(key: string): void {
    delete this.data[key];
    this.isDirty = true; // session.py:111-113
  }

  pop(key: string): unknown {
    const v = this.data[key];
    this.delete(key);
    return v;
  }

  clear(): void {
    this.data = {};
    this.isDirty = true; // session.py:121-123
  }

  update(values: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(values)) this.set(k, v);
  }

  /** A JSON snapshot for the store (`json.dump(dict(session))`, session.py:482). */
  toJSON(): string {
    return JSON.stringify(this.data);
  }

  /** The dict view, for `session_info` keys read with `session.get(...)`. */
  asData(): SessionData {
    return this.data as unknown as SessionData;
  }

  // session.py:128-174: the properties
  get uid(): number | null {
    const v = this.data["uid"];
    return typeof v === "number" ? v : null;
  }
  set uid(v: number | null) {
    this.set("uid", v);
  }
  get db(): string | null {
    const v = this.data["db"];
    return typeof v === "string" ? v : null;
  }
  set db(v: string | null) {
    this.set("db", v);
  }
  get login(): string | null {
    const v = this.data["login"];
    return typeof v === "string" ? v : null;
  }
  get context(): Record<string, unknown> {
    const v = this.data["context"];
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
    return {};
  }
  set context(v: Record<string, unknown>) {
    this.set("context", v);
  }
  /** `session.context[key] = value`: Odoo mutates the nested dict in place, which does NOT mark the session dirty. */
  setContextKey(key: string, value: unknown): void {
    const ctx = this.data["context"];
    if (typeof ctx === "object" && ctx !== null && !Array.isArray(ctx)) {
      (ctx as Record<string, unknown>)[key] = jsonRoundTrip(value);
    } else {
      this.data["context"] = { [key]: jsonRoundTrip(value) };
    }
  }
  get debug(): string {
    const v = this.data["debug"];
    return typeof v === "string" ? v : "";
  }
  set debug(v: string) {
    this.set("debug", v);
  }
  get sessionToken(): string | null {
    const v = this.data["session_token"];
    return typeof v === "string" ? v : null;
  }
  set sessionToken(v: string | null) {
    this.set("session_token", v);
  }
  get createTime(): number {
    const v = this.data["create_time"];
    return typeof v === "number" ? v : 0;
  }
}

/** Failures since the last successful login from one source, and the time of the last one (ms since the epoch). */
export interface LoginFailures {
  read(): Promise<readonly [number, number]>;
  failed(now: number): Promise<void>;
  succeeded(): Promise<void>;
}

/**
 * The objects of the session store (src/do/session.ts): sessions and login-failure records in `SESSION_OBJECTS`
 * objects, PBKDF2 in `KDF_OBJECTS` others (600,000 rounds hold an object's thread for about 550 ms on the site, which
 * must not stall the session reads of its other users). Fixed names, so after their first use no request waits for
 * a new object's global check (C2c). Changing either count, or `OBJECTS_GENERATION`, moves the sessions: everyone logs
 * in again.
 */
export const SESSION_OBJECTS = 16;
export const KDF_OBJECTS = 8;

/**
 * The names' prefix. An object lives where its first call came from. The first generation (no prefix) was warmed by
 * the scheduled handler, which Cloudflare runs in any data center: 7 of the objects the site's runs used answered a
 * session read in 105-122 ms against 9-12 ms for the others, every read of every request on them (C2f,
 * docs/accept/C2f.md). `v2/` objects are first called by requests (warmSessionObjects from the request path), which
 * run next to the database.
 */
const OBJECTS_GENERATION = "v2/";

/** FNV-1a (32 bits) of a string's UTF-16 code units: a stable spread of keys over the objects. */
function spread(key: string, n: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  return (h >>> 0) % n;
}

function sessionObject(env: Env, name: string): DurableObjectStub<SessionStoreDO> {
  const ns = env.SESSION as DurableObjectNamespace<SessionStoreDO>;
  return ns.get(ns.idFromName(OBJECTS_GENERATION + name));
}

/**
 * Every object of the store, once per isolate, from a request's waitUntil (src/http/dispatch.ts warmDatabaseObjects):
 * an object's first call waits for the global check of its name, which then is cached, so later requests do not pay
 * it. Never from the scheduled handler: an object is placed where its first call came from (OBJECTS_GENERATION).
 */
let warmed: Promise<void> | null = null;
export function warmSessionObjects(env: Env): Promise<void> {
  warmed ??= (async () => {
    const names = [
      ...Array.from({ length: SESSION_OBJECTS }, (_, i) => `sessions/${i}`),
      ...Array.from({ length: KDF_OBJECTS }, (_, i) => `kdf/${i}`),
    ];
    await Promise.all(names.map((n) => sessionObject(env, n).ping()));
  })().catch((e: unknown) => {
    warmed = null; // tried again by a later request
    throw e;
  });
  return warmed;
}

/** session.py:434-682 `SessionStore` on Durable Objects: a session lives in the object its sid spreads to. */
export class SessionStore {
  constructor(private readonly env: Env) {}

  /**
   * The object of a sid: spread by its first `STORED_SESSION_BYTES` characters, which a soft rotation keeps
   * (session.py:552-556), so a session's rotations share an object.
   */
  private stub(sid: string): DurableObjectStub<SessionStoreDO> {
    return sessionObject(this.env, `sessions/${spread(sid.slice(0, STORED_SESSION_BYTES), SESSION_OBJECTS)}`);
  }

  /** Offload only PBKDF2 to an object of the store, not the request dispatcher or database work; `key` spreads the load. */
  async derivePassword(key: string, password: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
    if (!this.isValidSessionId(key)) throw new Error("Invalid session id for password derivation");
    return sessionObject(this.env, `kdf/${spread(key, KDF_OBJECTS)}`).derivePassword(password, salt);
  }

  /** The login-failure record of one database and remote address (res_users.py:1356 `_login_failures[source]`). */
  loginFailures(db: string, remoteAddr: string): LoginFailures {
    const key = `login_failures:${db}:${remoteAddr}`;
    const stub = sessionObject(this.env, `sessions/${spread(key, SESSION_OBJECTS)}`);
    return {
      read: async () => { const r = await stub.loginFailures(key); return [r[0] ?? 0, r[1] ?? 0]; },
      failed: (now) => stub.loginFailed(key, now),
      succeeded: () => stub.loginSucceeded(key),
    };
  }

  /** session.py:444-453: 64 bytes of entropy, 86 urlsafe chars. */
  generateKey(): string {
    return tokenUrlsafe(64);
  }

  isValidSessionId(sid: string): boolean {
    return BASE64_URLSAFE_RE.test(sid); // session.py:455-457
  }

  new(): Session {
    return new Session({}, this.generateKey(), true); // session.py:459-461
  }

  async save(session: Session): Promise<void> {
    if (!this.isValidSessionId(session.sid)) throw new Error(`Invalid session id ${JSON.stringify(session.sid)}`);
    await this.stub(session.sid).putSession(session.sid, session.toJSON()); // session.py:470-488
  }

  async delete(session: Session): Promise<void> {
    if (!this.isValidSessionId(session.sid)) return;
    await this.stub(session.sid).deleteSession(session.sid); // session.py:490-494
  }

  /** session.py:496-528 `get`: a new session for an invalid sid; for an unknown valid sid, the same sid when keepSid. */
  async get(sid: string, keepSid = false): Promise<Session> {
    if (!this.isValidSessionId(sid)) return this.new();
    const raw = await this.stub(sid).getSession(sid);
    if (raw === null) return keepSid ? new Session({}, sid, false) : this.new();
    try {
      const data = JSON.parse(raw) as unknown;
      if (typeof data !== "object" || data === null || Array.isArray(data)) return new Session({}, sid, false);
      return new Session(data as Record<string, unknown>, sid, false);
    } catch (e) {
      if (e instanceof SyntaxError) return new Session({}, sid, false); // session.py:514-518
      throw e;
    }
  }

  /**
   * session.py:530-575 `rotate`. `computeToken` is `res.users._compute_session_token(sid)` for the session's uid
   * (needs a cursor), null when there is no uid; `now` is the wall clock in seconds.
   */
  async rotate(session: Session, computeToken: ((sid: string) => Promise<string | false>) | null, soft: boolean, now: number): Promise<void> {
    if (soft) {
      const stat = session.sid.slice(0, STORED_SESSION_BYTES);
      const recent = await this.get(session.sid);
      const next = recent.get("next_sid");
      if (typeof next === "string") {
        // a concurrent request already rotated (session.py:546-551)
        session.sid = next;
        return;
      }
      const nextSid = stat + this.generateKey().slice(STORED_SESSION_BYTES);
      session.set("next_sid", nextSid);
      session.set("deletion_time", now + SESSION_DELETION_TIMER);
      await this.save(session);
      session.set("gc_previous_sessions", true);
      session.sid = nextSid;
      session.delete("deletion_time");
      session.delete("next_sid");
    } else {
      await this.delete(session);
      session.sid = this.generateKey();
    }
    if (session.uid !== null) {
      if (computeToken === null) throw new Error("saving this session requires an environment"); // session.py:569
      const token = await computeToken(session.sid);
      session.sessionToken = token === false ? null : token;
    }
    session.shouldRotate = false;
    session.set("create_time", now);
    await this.save(session);
  }

  /**
   * session.py:663-669 `delete_old_sessions`: the previous sids of a soft rotation share the first 42 chars
   * and share the Durable Object of the current sid (`stub`).
   */
  async deleteOldSessions(session: Session, now: number): Promise<void> {
    if (session.has("gc_previous_sessions") && session.createTime + SESSION_DELETION_TIMER < now) {
      if (this.isValidSessionId(session.sid)) {
        await this.stub(session.sid).deleteOldSessions(session.sid.slice(0, STORED_SESSION_BYTES), session.sid, now);
      }
      session.delete("gc_previous_sessions");
      await this.save(session);
    }
  }
}

export {
  SESSION_STORAGE_PREFIX,
  LOGIN_FAILURES_MAX_AGE_MS,
  type SessionStorageLike,
  purgeOldSessions,
  readLoginFailures,
  recordLoginFailure,
} from "./session_gc";
