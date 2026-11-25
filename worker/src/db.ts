/**
 * One Postgres connection per request, like Odoo's cursor (`odoo/sql_db.py`): a transaction is opened on first
 * use and committed or rolled back by the request. Production reaches a slot database through its Hyperdrive
 * binding (docs/PHASE1.md section 5); local development connects directly with PG_DSN_TEMPLATE.
 */
import pg from "pg";
import * as pgCloudflare from "pg-cloudflare";
import type { Env, VpcNetwork } from "./env";
import { abandonRegistryChange, dropRegistryCaches, endTransaction, keepShared, releaseDatabase, sharable, sharedRead, signalWrites, touchesWatched, writtenTablesOf } from "./orm/signaling";
import { buildUpdates, PendingWrites, type PendingValue } from "./pending_writes";
import { CATALOG_SQL, catalogFor, catalogOf, forgetCatalog, mentionedTables, ReadCache, readDeps, readWords, RowCache, setCatalog, type WriteEffect, writeEffect } from "./sql_cache";
import { isReservedDb } from "./filestore_files";
import type { Phases } from "./phases";

export class UnknownDatabase extends Error {
  constructor(public readonly db: string) {
    super(`database "${db}" is not served`);
  }
}

function connectionString(env: Env, db: string): string {
  const slots = JSON.parse(env.SLOTS) as Record<string, string>;
  const binding = slots[db];
  if (binding !== undefined) {
    const hd = env[binding as `HD_${number}`];
    if (hd === undefined) throw new UnknownDatabase(db);
    return hd.connectionString;
  }
  if (env.PG_DSN_TEMPLATE !== undefined) return env.PG_DSN_TEMPLATE.replace("{db}", db);
  throw new UnknownDatabase(db);
}

/**
 * The socket of a connection through PG_NET (wrangler.jsonc `vpc_networks`: the Cloudflare Tunnel to the VPS's
 * Postgres, 2026-11-06): pg-cloudflare's CloudflareSocket with its connect() opening the TCP stream on the binding
 * instead of `cloudflare:sockets` (pg-cloudflare 1.4.1 dist/index.js connect, otherwise unchanged). Plaintext inside
 * the tunnel: the binding's connect() has no TLS, the tunnel itself is encrypted and Postgres has no public port.
 */
interface CfSocket {
  writable: boolean;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  emit(event: string, ...args: unknown[]): boolean;
  _addClosedHandler(): void;
  _listen(): Promise<void>;
  connect(port: number, host: string, connectListener?: (...args: unknown[]) => void): Promise<CfSocket | undefined>;
}
// TypeScript resolves the package's "default" condition (an empty module); workerd gets the "workerd" one.
const { CloudflareSocket } = pgCloudflare as unknown as { CloudflareSocket: new (ssl: boolean) => CfSocket };

function tunnelStream(net: VpcNetwork): () => CfSocket {
  return () => {
    const s = new CloudflareSocket(false);
    const raw = s as CfSocket & Record<string, unknown>;
    raw.connect = async function (port: number, host: string, connectListener?: (...args: unknown[]) => void) {
      try {
        if (connectListener) s.once("connect", connectListener);
        const sock = net.connect(`${host}:${port}`);
        raw["_cfSocket"] = sock;
        raw["_cfWriter"] = sock.writable.getWriter();
        s._addClosedHandler();
        raw["_cfReader"] = sock.readable.getReader();
        s._listen().catch((e: unknown) => s.emit("error", e));
        await (raw["_cfWriter"] as WritableStreamDefaultWriter).ready;
        s.writable = true;
        s.emit("connect");
        return s;
      } catch (e) {
        s.emit("error", e);
        return undefined;
      }
    };
    return s;
  };
}

/**
 * pg sends an extended-protocol query as five messages (Parse, Bind, Describe, Execute, Sync) and corks the stream
 * around them so they leave in one write (pg/lib/query.js:163-178), but only when the stream has cork():
 * pg-cloudflare's CloudflareSocket has none and its setNoDelay() does nothing, so each message became its own TCP
 * write. On the deployed Worker that cost about 40 ms per statement (Nagle against delayed ACK: load_menus, 171
 * statements, waited 6.5 s on SQL after a 46 ms connect, 2026-11-03). Node's sockets have cork() and are left alone.
 */
function corkable(stream: pg.Client["connection"]["stream"]): void {
  if (typeof Reflect.get(stream, "cork") === "function") return;
  const write: (data: Uint8Array) => boolean = stream.write.bind(stream);
  let parts: Uint8Array[] | null = null;
  Object.assign(stream, {
    cork(): void {
      parts ??= [];
    },
    uncork(): void {
      const held = parts;
      parts = null;
      if (held === null || held.length === 0) return;
      const out = new Uint8Array(held.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of held) {
        out.set(p, at);
        at += p.length;
      }
      write(out);
    },
    write(data: Uint8Array, ...rest: unknown[]): boolean {
      if (parts !== null && rest.length === 0 && data instanceof Uint8Array) {
        parts.push(data); // Connection._send passes buffers without callbacks
        return true;
      }
      return Reflect.apply(write, stream, [data, ...rest]) as boolean;
    },
  });
}

/**
 * A statement whose result may be reused within the transaction: a plain read with no side effect and no lock.
 * Anything else (writes, sequences, locks, savepoints, set_config) is a barrier that empties the cache.
 */
const READ = /^\s*(SELECT|WITH)\b/i;
const NOT_PURE = /\b(INSERT|UPDATE|DELETE|MERGE|nextval|setval|currval|lastval|set_config|pg_notify|pg_advisory\w*|txid_current|clock_timestamp|random|FOR\s+(SHARE|NO\s+KEY|KEY\s+SHARE))\b/i;

/** Statements `defer` may send (src/orm/sql.ts runSql), and the transaction control that waits for them first. */
const DEFERRABLE = /^\s*(UPDATE|INSERT|DELETE)\b/i;
const RETURNING = /\bRETURNING\b/i;
const CONTROL = /^\s*(SAVEPOINT|RELEASE|ROLLBACK|COMMIT)\b/i;

function cacheKey(sql: string, params: readonly unknown[]): string | null {
  for (const p of params) {
    if (p === null || typeof p === "number" || typeof p === "string" || typeof p === "boolean") continue;
    if (Array.isArray(p) && p.every((v) => v === null || typeof v === "number" || typeof v === "string" || typeof v === "boolean")) continue;
    return null; // dates, buffers, objects: not worth keying
  }
  return `${sql}\u0000${JSON.stringify(params)}`;
}

/** A copy of result rows a caller may mutate (sort, push, assign): rows, their arrays and json values. Buffers and
 *  dates are shared: a deep clone would turn pg's Buffers into plain Uint8Arrays. */
function copyRows<R>(rows: readonly R[]): R[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      out[k] = v === null || typeof v !== "object" || v instanceof Uint8Array || v instanceof Date ? v : structuredClone(v);
    }
    return out as R;
  });
}

/**
 * The functions that sent a statement, innermost first, without the cursor's own (SQL_LOG_STACK; the bundle is
 * minified, so names, not lines; async callers too, as V8 keeps them across awaits).
 */
function callersOf(stack: string): string {
  const out: string[] = [];
  for (const m of stack.matchAll(/^\s*at (?:async )?([^\s(]+) \(/gm)) {
    const name = m[1]!;
    if (name.startsWith("Cursor.") || name === "Error") continue;
    out.push(name);
    if (out.length >= 10) break;
  }
  return out.join(" < ");
}

export class Cursor {
  private client: pg.Client | null = null;
  private opened: Promise<pg.Client> | null = null;
  readonly queries: { sql: string; ms: number; cached?: boolean; rx?: number; at?: string | undefined }[] = [];
  /** Bytes received from Postgres on this cursor's connection, with SQL_LOG=1 only (src/http/dispatch.ts). */
  rxBytes = 0;
  private rxSeen = 0;
  /**
   * Repeated identical reads in one transaction get the first result (a copy), as Odoo's per-transaction ORM cache
   * would answer them without SQL: every statement costs about 1.3 ms CPU on the deployed Worker (2026-11-03 profile),
   * and a request repeated the same access-rule and parent_path reads up to four times. An entry is kept until a
   * statement may write one of the tables it reads (src/sql_cache.ts; any write when they cannot be told).
   */
  private readonly reads = new ReadCache<Promise<pg.QueryResult>>();
  /** Column values of rows read in this transaction (src/orm/prefetch.ts). */
  readonly rows = new RowCache();
  /** Tables written in this transaction (src/orm/signaling.ts writtenTablesOf), for the registry caches. */
  readonly writtenTables = new Set<string>();
  /** Time to connect (TCP and authentication to Postgres; BEGIN rides with the first statement), for SQL_LOG. */
  connectMs = 0;
  /** The request's phases (src/phases.ts), with SQL_LOG=1 only: the wait for the connection and the round trips. */
  phases: Phases | null = null;
  private connectWaited = false;
  /**
   * The transaction's BEGIN, sent without waiting (open): a statement's answer and COMMIT wait for it, so a failed BEGIN
   * is thrown by the first statement after it and the transaction never commits.
   */
  private begun: Promise<void> | null = null;

  /**
   * `cr.postcommit` (odoo/odoo/sql_db.py Callbacks): functions run after a successful COMMIT, in order, and `data`
   * shared by them for the transaction; both are dropped on rollback.
   */
  readonly postcommit: (() => Promise<void>)[] = [];
  readonly postcommitData = new Map<string, unknown>();

  /**
   * `internal`: the Worker's own database (src/filestore_files.ts FILES_DB, src/filestore_mirror.ts). Any other cursor
   * on a reserved name fails as an unknown database, so no path (?db=, the session, a header, XML-RPC, /health) reaches it.
   */
  /**
   * `ISOLATE_CACHE=0` (measurement only, start.sh): the isolate's caches across requests (src/orm/signaling.ts
   * `registryCached`, `sharedRead`) are kept for the transaction only, so every request reads as on a new isolate
   * with the registry loaded, as most requests on the site do (docs/accept/C2.md). Unset: as before.
   */
  readonly isolateCache: boolean;
  /** `REGISTRY_SHARE=0` (measurement only, start.sh): the registry's rows always from the database (src/orm/registry_share.ts). */
  readonly registryShare: boolean;
  /**
   * The request's `waitUntil` (src/http/context.ts), for work after the response that belongs to this cursor's request
   * (the registry rows kept for other isolates); null outside a request.
   */
  waitUntil: ((p: Promise<unknown>) => void) | null = null;
  private readonly pipelined: boolean;
  /**
   * Round trips to Postgres for SQL_LOG: a statement issued while none is unanswered starts one; with pipelining the
   * statements issued meanwhile ride along (without it, every statement is its own).
   */
  roundTrips = 0;
  private inFlight = 0;
  /**
   * Writes sent without waiting for their answer (`defer`, src/orm/sql.ts runSql): an UPDATE, INSERT or DELETE without
   * RETURNING, whose only answer is an error. Postgres runs them in the order sent, so a later statement sees them; the
   * caller goes on at once and the next statement shares their round trip (Odoo's own writes wait in the cache until
   * a flush, models.py `_write` / `flush_model`). Their first error (in the order sent) is thrown by the next
   * statement, by a failing statement sent after it (instead of "current transaction is aborted"), by `drain`, a
   * SAVEPOINT, RELEASE or COMMIT; a ROLLBACK discards it. Inside a savepoint nothing is deferred: the code there
   * catches the statement's own error to roll back to it.
   */
  private deferSeq = 0;
  private readonly deferred = new Map<number, Promise<void>>();
  private deferredError: { readonly seq: number; readonly error: unknown } | null = null;
  private savepoints = 0;
  /** Column updates buffered in memory until a statement needs them or commit (src/pending_writes.ts). */
  private readonly pending = new PendingWrites();
  /** Active read-dependency trackers (ModelImpl.relationValues: tables/words an x2many fetch depended on). */
  private readonly readTrackers: { deps: Set<string> | null; words: Set<string> | null }[] = [];
  /** Sees every statement that may write, before it is sent (src/orm/written_fields.ts: a Store version's written fields). */
  writeWatch: ((sql: string) => void) | null = null;

  constructor(private readonly env: Env, readonly db: string, private readonly internal = false) {
    this.isolateCache = Reflect.get(env, "ISOLATE_CACHE") !== "0";
    this.registryShare = Reflect.get(env, "REGISTRY_SHARE") !== "0";
    this.pipelined = Reflect.get(env, "PG_PIPELINE") !== "0";
  }

  /**
   * Start connecting now, before the first statement (src/http/dispatch.ts: while the session is read, to the database
   * the session had on this isolate). Nothing is sent but the connection's start and BEGIN.
   */
  connectEarly(): void {
    this.early = true;
    this.open().catch(() => { this.earlyFailed = true; });
  }

  /** Whether `connectEarly` opened it (SQL_LOG `early=1`). */
  early = false;

  /** Whether `connectEarly` failed: the request then opens its own cursor, as without it. */
  earlyFailed = false;

  /** Close a cursor `connectEarly` opened that no statement used (no COMMIT: the server drops the empty transaction). */
  abandon(): Promise<void> {
    return this.open().then(() => this.close(), () => undefined);
  }

  /** A new cursor on the same database (`registry.cursor()`), for work in its own transaction. */
  fresh(): Cursor {
    return new Cursor(this.env, this.db, this.internal);
  }

  private open(): Promise<pg.Client> {
    if (this.opened === null) {
      if (!this.internal && isReservedDb(this.db)) return Promise.reject(new UnknownDatabase(this.db));
      this.opened = (async () => {
        const t0 = performance.now();
        const net = this.env.PG_TUNNEL === "1" ? this.env.PG_NET : undefined;
        // pipelining (pg 8.23 `pipeline`): a statement issued while earlier ones are unanswered is written at once
        // instead of after their ReadyForQuery, so statements a caller issues together (Promise.all) share one round
        // trip through the tunnel (about 7 ms each on the site, docs/perf-2026-11-07.md). The server runs them in the
        // order sent, as before, each with its own Sync; only the waiting changes. PG_PIPELINE=0 turns it off.
        const client = new pg.Client({ connectionString: connectionString(this.env, this.db), pipeline: this.pipelined,
          ...(net ? { stream: tunnelStream(net) as unknown as NonNullable<pg.ClientConfig["stream"]> } : {}) });
        corkable(client.connection.stream);
        if (Reflect.get(this.env, "SQL_LOG") === "1") client.connection.stream.on("data", (b: Uint8Array) => { this.rxBytes += b.length; });
        await client.connect();
        // odoo/odoo/sql_db.py:29, :795 every cursor runs at ISOLATION_LEVEL_REPEATABLE_READ: a row changed by a concurrent
        // transaction since the snapshot raises a serialization failure (40001), which http/retrying.py retries.
        // Not waited for: with pipelining the first statement is written right behind it and shares its round trip
        // (C2d; a round trip of every request on the site). Postgres runs it first; every answer waits for its result.
        this.begun = client.query("BEGIN ISOLATION LEVEL REPEATABLE READ").then(() => undefined);
        this.begun.catch(() => undefined);
        // the tables and views of the database, once per isolate (src/sql_cache.ts): which tables a read depends on
        if (catalogFor(this.db) === undefined) {
          const c0 = performance.now();
          setCatalog(this.db, catalogOf((await client.query<{ name: string; kind: string }>(CATALOG_SQL)).rows));
          this.queries.push({ sql: CATALOG_SQL, ms: performance.now() - c0 });
        }
        this.connectMs = performance.now() - t0;
        this.rxSeen = this.rxBytes;
        this.client = client;
        return client;
      })();
    }
    return this.opened;
  }

  /**
   * `opts.share: false`: never answered from or kept in the isolate's cache (src/orm/signaling.ts `sharedRead`) nor
   * the transaction's, for statements whose result the caller keeps itself for the isolate's life (the registry's
   * load). Its rows are then the caller's, not copies: copying them for the transaction's cache was a third of a cold
   * registry load's CPU (10,635 rows of ir_model_fields on poc_erp, results/fn/regprof2.ts, C2c).
   */
  /** Whether `defer` may send this statement: a write without RETURNING, outside any savepoint. */
  canDefer(sql: string): boolean {
    return this.savepoints === 0 && DEFERRABLE.test(sql) && !RETURNING.test(sql);
  }

  /** Whether column writes may be buffered on this cursor (outside savepoints). */
  canBuffer(): boolean {
    return this.savepoints === 0;
  }

  /**
   * Buffer column updates for `table` (src/pending_writes.ts): merged per table and flushed before any SQL statement
   * that may read or write them, or at drain/savepoint/commit. Caches (`ReadCache`, `RowCache`) and `writtenTables`
   * update immediately so ORM reads see the new values without flushing.
   */
  bufferUpdate(
    table: string,
    rows: readonly [number, ReadonlyMap<string, PendingValue>][],
    cacheUpdates: readonly [number, ReadonlyMap<string, { readonly raw: unknown } | null>][],
  ): void {
    if (!rows.length) return;
    const ids: number[] = [];
    const colSet = new Set<string>();
    for (const [id, cols] of rows) {
      if (!cols.size) continue;
      ids.push(id);
      this.pending.put(table, id, cols);
      for (const c of cols.keys()) colSet.add(c);
    }
    if (!ids.length) return;
    const effect: WriteEffect = { kind: "tables", tables: [table], rows: { table, ids, columns: [...colSet] } };
    this.reads.drop(effect);
    this.rows.applyPending(table, effect, cacheUpdates);
    this.writtenTables.add(table);
  }

  /** Record a cache-only read dependency (RowCache/links hit without SQL) for any active `trackReads` scope. */
  noteRead(table: string, words: readonly string[] | null): void {
    if (!this.readTrackers.length) return;
    for (const t of this.readTrackers) {
      if (t.deps !== null) t.deps.add(table);
      if (words === null) t.words = null;
      else if (t.words !== null) for (const w of words) t.words.add(w.toLowerCase());
    }
  }

  private recordTrackedRead(deps: ReadonlySet<string> | null, words: ReadonlySet<string> | null): void {
    if (!this.readTrackers.length) return;
    for (const t of this.readTrackers) {
      if (deps === null) t.deps = null;
      else if (t.deps !== null) for (const d of deps) t.deps.add(d);
      if (words === null) t.words = null;
      else if (t.words !== null) for (const w of words) t.words.add(w);
    }
  }

  /** Run `fn` while collecting the union of `(deps, words)` of every read it performs on this cursor. */
  async trackReads<T>(fn: () => Promise<T>): Promise<{ value: T; deps: ReadonlySet<string> | null; words: ReadonlySet<string> | null }> {
    const tracker: { deps: Set<string> | null; words: Set<string> | null } = { deps: new Set(), words: new Set() };
    this.readTrackers.push(tracker);
    try {
      const value = await fn();
      return { value, deps: tracker.deps, words: tracker.words };
    } finally {
      const i = this.readTrackers.lastIndexOf(tracker);
      if (i >= 0) this.readTrackers.splice(i, 1);
    }
  }

  /** Flush all (or the named) pending tables to Postgres via `defer` (pipelined ahead of the next statement). */
  flushPending(tables?: readonly string[]): void {
    if (this.pending.size === 0) return;
    const entries = tables === undefined
      ? this.pending.takeAll()
      : tables.map((t) => [t, this.pending.takeTable(t)] as const).filter((e): e is [string, Map<number, Map<string, PendingValue>>] => e[1] !== undefined);
    for (const [table, rows] of entries) {
      for (const { text, params } of buildUpdates(table, rows)) {
        this.deferFlush(text, params);
      }
    }
  }

  private deferFlush(sql: string, params: unknown[]): void {
    const seq = ++this.deferSeq;
    const done = this.send(sql, params, undefined, seq, true).then(() => undefined, (error: unknown) => {
      if (this.deferredError === null || seq < this.deferredError.seq) this.deferredError = { seq, error };
    });
    this.deferred.set(seq, done);
    void done.then(() => this.deferred.delete(seq));
  }

  private flushPendingForWrite(sql: string, effect: ReturnType<typeof writeEffect>): void {
    if (this.pending.size === 0) return;
    if (effect.kind === "tables" && effect.tables.length === 0) {
      // nextval only: touches no table
    } else if (effect.kind === "tables" && effect.insert === true && !/\bSELECT\b/i.test(sql)) {
      this.flushPending(effect.tables);
    } else if (effect.kind === "tables") {
      const refs = mentionedTables(sql, catalogFor(this.db));
      if (refs !== null) this.flushPending([...new Set([...effect.tables, ...refs])]);
      else this.flushPending();
    } else {
      this.flushPending();
    }
  }

  /** Send a write whose result nobody reads and go on (see `deferred`); its error is thrown later. */
  defer(sql: string, params: unknown[] = []): void {
    const pure = READ.test(sql) && !NOT_PURE.test(sql);
    if (!pure && this.pending.size > 0) this.flushPendingForWrite(sql, writeEffect(sql, params));
    const seq = ++this.deferSeq;
    const done = this.send(sql, params, undefined, seq).then(() => undefined, (error: unknown) => {
      if (this.deferredError === null || seq < this.deferredError.seq) this.deferredError = { seq, error };
    });
    this.deferred.set(seq, done);
    void done.then(() => this.deferred.delete(seq));
  }

  /** Wait for the deferred writes and throw the first one's error. */
  async drain(): Promise<void> {
    this.flushPending();
    if (this.deferred.size) await Promise.all([...this.deferred.values()]);
    this.throwDeferred();
  }

  private throwDeferred(before = Infinity): void {
    const d = this.deferredError;
    if (d === null || d.seq >= before) return;
    this.deferredError = null;
    throw d.error;
  }

  query<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = [], opts?: { readonly share?: boolean }): Promise<pg.QueryResult<R>> {
    return this.send<R>(sql, params, opts, null);
  }

  /** `query`, or a deferred write's own sending (`deferredSeq`: it waits for nothing and throws nothing earlier). */
  private async send<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[], opts: { readonly share?: boolean } | undefined, deferredSeq: number | null, isFlush = false): Promise<pg.QueryResult<R>> {
    const control = deferredSeq === null ? CONTROL.exec(sql) : null;
    // SQL_LOG_STACK=1 (local diagnosis only): the callers in src/ that sent the statement, logged with it
    const at = Reflect.get(this.env, "SQL_LOG_STACK") === "1" ? callersOf(new Error().stack ?? "") : undefined;
    if (control !== null) {
      const word = control[1]!.toUpperCase();
      if (word === "ROLLBACK" && !/^\s*ROLLBACK\s+TO\b/i.test(sql)) this.pending.clear();
      else this.flushPending();
      if (this.deferred.size) await Promise.all([...this.deferred.values()]);
      if (word === "ROLLBACK") this.deferredError = null; // rolled back with the rest (a savepoint is never deferred)
      else this.throwDeferred();
      if (word === "SAVEPOINT") this.savepoints++;
      else if (word === "RELEASE") this.savepoints = Math.max(0, this.savepoints - 1);
      else if (word === "ROLLBACK" && !/^\s*ROLLBACK\s+TO\b/i.test(sql)) this.savepoints = 0;
    } else if (deferredSeq === null) this.throwDeferred();
    const pure = READ.test(sql) && !NOT_PURE.test(sql);
    if (!pure && control === null && this.writeWatch) this.writeWatch(sql);
    if (!isFlush && !pure) {
      // before it runs: flush any pending writes this statement may observe or overwrite, then drop caches
      const effect = writeEffect(sql, params);
      if (control === null) this.flushPendingForWrite(sql, effect);
      this.rows.drop(effect);
      this.reads.drop(effect);
    }
    const key = pure && opts?.share !== false ? cacheKey(sql, params) : null;
    if (key === null && !isFlush) {
      const written = writtenTablesOf(sql);
      if (written.includes("*")) forgetCatalog(this.db);
      for (const t of written) this.writtenTables.add(t);
    }
    let deps: ReadonlySet<string> | null = null;
    let words: ReadonlySet<string> | null = null;
    let share = false;
    if (key !== null) {
      const hit = this.reads.get(key);
      if (hit !== undefined) {
        if (this.readTrackers.length) {
          const hdeps = readDeps(sql, catalogFor(this.db));
          this.recordTrackedRead(hdeps, hdeps !== null ? readWords(sql) : null);
        }
        this.queries.push({ sql, ms: 0, cached: true, at });
        const r = await hit;
        return { ...r, rows: copyRows(r.rows) } as pg.QueryResult<R>;
      }
      deps = readDeps(sql, catalogFor(this.db));
      if (deps !== null) words = readWords(sql);
      share = opts?.share !== false && sharable(sql, deps);
      // the isolate's answer of a statement on the registry's tables under the same signaling (src/orm/signaling.ts)
      const kept = share ? sharedRead(this, key) as Promise<pg.QueryResult> | undefined : undefined;
      if (kept !== undefined) {
        this.reads.set(key, kept, deps, words);
        if (this.readTrackers.length) this.recordTrackedRead(deps, words);
        this.queries.push({ sql, ms: 0, cached: true, at });
        const r = await kept;
        return { ...r, rows: copyRows(r.rows) } as pg.QueryResult<R>;
      }
    }
    // pure read that missed caches: track its deps and flush any pending tables whose dirty columns it may read
    if (pure && !isFlush) {
      const needDeps = this.pending.size > 0 || this.readTrackers.length > 0;
      if (needDeps) {
        const rdeps = key !== null ? deps : readDeps(sql, catalogFor(this.db));
        const rwords = key !== null ? words : (rdeps !== null ? readWords(sql) : null);
        if (this.readTrackers.length) this.recordTrackedRead(rdeps, rwords);
        // pg_attribute schema metadata queries are unaffected by DML column updates in PendingWrites
        if (this.pending.size > 0 && !(rdeps === null && /^\s*SELECT\b[\s\S]*\bFROM\s+pg_attribute\b/i.test(sql))) {
          const toFlush = this.pending.tablesToFlushForRead(rdeps, rwords);
          if (toFlush.length) this.flushPending(toFlush);
        }
      }
    }
    // sent in the order of the calls: no wait once the connection is open (a deferred write and the next statement)
    let client = this.client;
    if (client === null) {
      // the first statement's wait for the connection (with connectEarly, what is left of it), once per cursor
      const first = this.phases !== null && !this.connectWaited;
      this.connectWaited = true;
      const tw = performance.now();
      client = await this.open();
      if (first) this.phases?.add("cw", performance.now() - tw);
    }
    // the deferred writes sent before this statement
    const mark = deferredSeq === null ? this.deferSeq : deferredSeq - 1;
    const t0 = performance.now();
    if (this.inFlight === 0 || !this.pipelined) this.roundTrips++;
    this.inFlight++;
    const phases = this.phases;
    phases?.sqlBegin();
    const running = client.query<R>(sql, params);
    void running.then(() => { this.inFlight--; phases?.sqlEnd(); }, () => { this.inFlight--; phases?.sqlEnd(); });
    if (key !== null) {
      // kept until a write to one of the tables it reads (or any write, when they cannot be told)
      this.reads.set(key, running, deps, words);
      running.catch(() => this.reads.delete(key));
      if (share) keepShared(this, key, running);
    }
    try {
      const r = await running;
      await this.begun;
      return key === null ? r : { ...r, rows: copyRows(r.rows) };
    } catch (e) {
      // a deferred write sent before this statement failed first: its error, not the aborted transaction's
      if (deferredSeq === null && (this.deferred.size || this.deferredError !== null)) {
        await Promise.all([...this.deferred].filter(([seq]) => seq <= mark).map(([, done]) => done));
        this.throwDeferred(mark + 1);
      }
      throw e;
    } finally {
      // the protocol answers in order: what arrived since the previous answer is this statement's (SQL_LOG only)
      this.queries.push({ sql, ms: performance.now() - t0, rx: this.rxBytes - this.rxSeen, at });
      this.rxSeen = this.rxBytes;
    }
  }

  async commit(): Promise<void> {
    await this.drain();
    if (this.client === null) return;
    await this.begun;
    const client = this.client;
    // registry.py:1132-1150 `_signal_changes` for writes to tables the registry caches read (src/orm/signaling.ts)
    await signalWrites(this, (sql) => client.query(sql));
    await client.query("COMMIT");
    endTransaction(this);
    this.rows.clear();
    this.reads.clear();
  }

  /**
   * `cr.commit()` in the middle of work that goes on (ir_cron `_commit_progress`, ir_cron.py:872-916): the transaction
   * is committed and the next statement runs in a new one, as psycopg2 opens it.
   */
  async commitAndContinue(): Promise<void> {
    if (this.client === null) return;
    await this.commit();
    this.reads.clear();
    this.rows.clear(); // the new transaction's snapshot sees other transactions' commits
    await this.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  }

  async rollback(): Promise<void> {
    this.pending.clear();
    if (this.deferred.size) await Promise.all([...this.deferred.values()]);
    this.deferredError = null;
    this.savepoints = 0;
    // a rolled-back write may have been cached as the transaction saw it: drop the isolate's caches of the database
    if (touchesWatched(this)) dropRegistryCaches(this.db);
    abandonRegistryChange(this);
    endTransaction(this);
    this.rows.clear();
    this.reads.clear();
    this.postcommit.length = 0;
    this.postcommitData.clear();
    if (this.client !== null) await this.client.query("ROLLBACK");
  }

  async close(): Promise<void> {
    releaseDatabase(this);  // a cursor closed without a commit or rollback no longer holds its database in the isolate
    const client = this.client;
    this.client = null;
    this.opened = null;
    this.begun = null;
    if (client !== null) await client.end();
  }
}

/**
 * Autocommit Postgres client for administrative statements that Postgres forbids inside a transaction block
 * (`DROP DATABASE ... WITH (FORCE)`, `CREATE DATABASE ... TEMPLATE ...`), using the exact same `PG_NET` tunnel
 * transport as `Cursor`. Used exclusively by `DemoPool` (src/do/demo_pool.ts).
 */
export async function withAdminClient<T>(env: Env, db: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const net = env.PG_TUNNEL === "1" ? env.PG_NET : undefined;
  const client = new pg.Client({
    connectionString: connectionString(env, db),
    ...(net ? { stream: tunnelStream(net) as unknown as NonNullable<pg.ClientConfig["stream"]> } : {}),
  });
  corkable(client.connection.stream);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}
