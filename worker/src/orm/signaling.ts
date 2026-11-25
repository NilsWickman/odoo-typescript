/**
 * Odoo's registry caches across requests, with Odoo's invalidation (odoo/orm/registry.py).
 *
 * Odoo keeps `ormcache` results in the registry of each process (`_get_company_ids`, `_get_group_ids`, the access
 * rows, `res.lang.get_installed`, `_xmlid_lookup`, ...) and, at the start of every request, reads the signaling
 * sequences with the database's now() in one statement (`get_sequences`, registry.py:1120-1130,
 * environments.py:752 `_check_signaling`). A sequence that moved clears its own container ('registry' reloads
 * everything). A process that changes cached data invalidates the containers `_CACHES_BY_KEY` names (registry.py:66-73,
 * e.g. 'groups' also clears 'default') and signals each of them by inserting into `orm_signaling_<cache>`
 * (`_signal_changes`, registry.py:1132-1150).
 *
 * The port does the same per isolate and database: `registryCached` keeps a value of a container ('default' or
 * 'stable') under the request's sequences that clear it, and drops the container when one of them moved. Its own writes are recognized
 * on the cursor (src/db.ts `writtenTables`): a statement that writes a table these caches read makes the rest of the
 * request read past the cache, and the commit inserts the signaling rows (`signalWrites`) so other isolates and Odoo
 * processes drop theirs, as Odoo's `clear_cache` does.
 */
import type { Cursor } from "../db";
import { forgetCatalog } from "../sql_cache";

/** The signaling tables read per request, in Odoo's order (registry.py:1121: 'registry', then `_CACHES_BY_KEY`). */
const SIGNALING = ["registry", "default", "assets", "stable", "templates", "routing", "groups"] as const;
/**
 * The sequences whose movement clears a container: on the receiving side a moved sequence clears its own container
 * only (environments.py:752-802 `_check_signaling`; `_CACHES_BY_KEY` widens what the writer invalidates and signals,
 * environments.py:833-849, :950-976), and the registry sequence reloads everything.
 */
export type Container = "default" | "stable";
const KEYS: Record<Container, readonly (typeof SIGNALING[number])[]> = {
  default: ["registry", "default"],
  stable: ["registry", "stable"],
};

/**
 * The tables the cached values are read from. A write to one of them (or an unrecognized write, "*") signals
 * 'default', 'groups' and 'stable', which clears every cache here, in other isolates and in Odoo.
 */
export const WATCHED_TABLES: ReadonlySet<string> = new Set([
  "res_lang", "res_company", "res_company_users_rel", "res_groups", "res_groups_users_rel", "res_groups_implied_rel",
  "ir_access", "ir_model", "ir_model_data", "website",
  // the tables of the models Odoo clears a cache for on create/write/unlink (`_clear_cache_name`, models.py:3797,
  // :3980, :4225; CachedModel models_cached.py:17), read by `sharedRead` below: ir_config_parameter.py:40,
  // ir_default.py:19, ir_ui_view.py:151, ir_ui_menu.py:21, ir_actions.py:57, ir_asset.py:64, ir_module.py:167,
  // decimal_precision.py:12, mail_message_subtype.py:13, res_currency.py:51, res_country.py:52; and the registry's
  // own tables (ir_model_fields*, ir_model_inherit: a write there is a registry change in Odoo)
  "ir_config_parameter", "ir_default", "ir_ui_view", "ir_ui_menu", "ir_ui_menu_group_rel", "ir_actions",
  "ir_act_window", "ir_act_window_view", "ir_act_window_group_rel", "ir_act_server", "ir_act_server_group_rel",
  "ir_act_client", "ir_act_url", "ir_act_report_xml", "ir_asset", "ir_module_module", "decimal_precision",
  "mail_message_subtype", "res_currency", "res_country", "ir_model_fields", "ir_model_fields_selection",
  "ir_model_fields_group_rel", "ir_model_inherit",
]);

/** `SELECT (now() AT TIME ZONE 'UTC'), (SELECT max(id) FROM orm_signaling_registry), ...` (registry.py:1122-1124). */
export const SEQUENCES_SQL = `SELECT now() AS now, ${SIGNALING.map((s) => `(SELECT max(id) FROM orm_signaling_${s}) AS ${s}`).join(", ")}`
  // the same now() as text to the microsecond (src/models/util.ts dbNow, src/orm/date_relative.ts): one statement less
  + `, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now_utc`
  // the database's identity: a copy dropped and created again under the same name (the harness's copies) starts
  // from its template's sequences, so the isolate's caches of the name are only reused for the same database
  + `, (SELECT oid FROM pg_database WHERE datname = current_database())::text AS dboid`;

type Row = { now: Date; now_utc?: string; dboid?: string | null } & Record<typeof SIGNALING[number], number | null>;

/**
 * The transaction's now() as `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, read with the
 * signaling sequences (the statement every request runs first).
 */
export async function transactionNowUtc(cr: Cursor): Promise<string> {
  const text = (await requestSequences(cr)).now_utc;
  if (typeof text !== "string") throw new Error("the signaling statement returned no now_utc");
  return text;
}

/** The database's identity and then the sequences, as compared by the caches (a recreated database is "newer"). */
function sequenceOf(row: Row, keys: readonly (typeof SIGNALING[number])[]): number[] {
  return [Number(row.dboid ?? 0), ...keys.map((k) => row[k] ?? 0)];
}

const perCursor = new WeakMap<Cursor, Promise<Row>>();
/** The sequences once read, for the synchronous check of `sharedRead` (no await before a statement is issued). */
const resolved = new WeakMap<Cursor, Row>();

/** The transaction's sequences once read (the same object `requestSequences` gave), or undefined before or after. */
export function currentSequences(cr: Cursor): Row | undefined {
  return resolved.get(cr);
}
const lastRegistry = new Map<string, string>();
/** The newest registry identity seen per database (the dboid and the registry sequence). */
const lastNewest = new Map<string, string>();

/**
 * The databases an isolate keeps its state of: the loaded registry (src/orm/registry.ts), the values and statement
 * answers kept here, the table catalog, the installed modules and the template. Each of them had its own bound
 * (8 registries, 32 databases of values and of answers, 64 catalogs), counted by first use. An isolate that met one
 * fresh database after another kept 2.5-4 MB for each copy of the corpus template and 6-7 MB for each of the ERP
 * template (heap after a collection, the same two scenarios again and again: 83.7, 94.9, 103.7 MB after 2, 4 and 6
 * databases, 118.3 after 8, docs/infra-2026-11-14.md), of the 128 MB an isolate has: the site map, a fresh copy for
 * every menu, met "exceeded memory limits".
 *
 * So one bound for all of it, by last use: beside the databases with a transaction open in this isolate, the
 * KEPT_DBS used last are kept, and one beyond them is forgotten as a whole, as when its registry changes. Never one
 * with a transaction open: a request keeps what it began with, and a database that is forgotten between its
 * requests is to them what a new isolate is. The older bounds stay behind this one.
 */
export const KEPT_DBS = 4;
/** Database -> its open transactions here, the least recently used database first. */
const keptDbs = new Map<string, number>();
const countedCursors = new WeakSet<Cursor>();

function keepDatabase(cr: Cursor): void {
  if (countedCursors.has(cr)) return;
  countedCursors.add(cr);
  const open = keptDbs.get(cr.db) ?? 0;
  keptDbs.delete(cr.db);
  keptDbs.set(cr.db, open + 1);
  forgetLeastUsed();
}

/** The cursor's transaction ended, or the cursor was closed without one ending (src/db.ts close). */
export function releaseDatabase(cr: Cursor): void {
  if (!countedCursors.delete(cr)) return;
  const open = keptDbs.get(cr.db);
  if (open !== undefined) keptDbs.set(cr.db, Math.max(0, open - 1));  // its place in the order stays
  forgetLeastUsed();
}

function forgetLeastUsed(): void {
  let idle = 0;
  for (const open of keptDbs.values()) if (open === 0) idle++;
  for (const [db, open] of keptDbs) {
    if (idle <= KEPT_DBS) break;
    if (open > 0) continue;
    idle--;
    keptDbs.delete(db);
    lastRegistry.delete(db);
    lastNewest.delete(db);
    dropRegistryCaches(db);
    forgetRegistry(db);
  }
}

/** The databases the isolate keeps state of and has no transaction open on, the least recently used first (tests). */
export function keptDatabases(): string[] {
  return [...keptDbs].filter(([, open]) => open === 0).map(([db]) => db);
}

/** The request's now() and signaling sequences: one statement per request (`dbNow` shares it). */
export function requestSequences(cr: Cursor): Promise<Row> {
  let p = perCursor.get(cr);
  if (p === undefined) {
    keepDatabase(cr);
    p = cr.query<Row>(SEQUENCES_SQL).then((r) => {
      const row = r.rows[0];
      if (row === undefined) throw new Error("no signaling sequences");
      // registry.py check_signaling: a moved registry sequence reloads everything, here also the table catalog
      const identity = `${row.dboid ?? ""}:${row.registry ?? ""}`;
      const last = lastRegistry.get(cr.db);
      if (last !== identity) {
        if (last !== undefined) forgetCatalog(cr.db);
        lastRegistry.set(cr.db, identity);
        // another database under the name, or a newer registry (an install elsewhere): what the isolate keeps per
        // database goes; an older snapshot (a request that began before the install) leaves the newer state alone
        const [lastOid, lastSeq] = (lastNewest.get(cr.db) ?? ":").split(":");
        if (lastOid !== (row.dboid ?? "") || Number(row.registry ?? 0) > Number(lastSeq || 0)) {
          if (lastNewest.has(cr.db)) forgetRegistry(cr.db);
          lastNewest.set(cr.db, identity);
        }
      }
      resolved.set(cr, row);
      return row;
    });
    p.catch(() => perCursor.delete(cr));
    perCursor.set(cr, p);
  }
  return p;
}

interface Entry { readonly seq: readonly number[]; readonly values: Map<string, Promise<unknown>> }
const isolatePerDb = new Map<string, Entry>();
const MAX_DBS = 32;
/**
 * `ISOLATE_CACHE=0` (measurement, src/db.ts `isolateCache`): the caches live as long as the cursor's request, as on a
 * new isolate (with the registry loaded) for every request.
 */
const requestPerDb = new WeakMap<Cursor, Map<string, Entry>>();
function perDbOf(cr: Cursor): Map<string, Entry> {
  if (cr.isolateCache !== false) return isolatePerDb;
  let m = requestPerDb.get(cr);
  if (m === undefined) requestPerDb.set(cr, m = new Map());
  return m;
}

function newer(a: readonly number[], b: readonly number[]): boolean {
  return a.every((v, i) => v >= b[i]!);
}

/**
 * `load()` once per isolate, database and signaling state: the value of an `ormcache` method kept in the registry.
 * After a write to a watched table in this transaction the value is loaded fresh and not kept.
 */
export async function registryCached<T>(cr: Cursor, key: string, load: () => Promise<T>, container: Container = "default"): Promise<T> {
  if (touchesWatched(cr)) return load();
  const row = await requestSequences(cr);
  const perDb = perDbOf(cr);
  const seq = sequenceOf(row, KEYS[container]);
  const slot = `${cr.db}\u0000${container}`;
  let entry = perDb.get(slot);
  if (entry === undefined || entry.seq.some((v, i) => v !== seq[i])) {
    const fresh: Entry = { seq, values: new Map() };
    // a request on an older snapshot (REPEATABLE READ) does not replace a newer state another request loaded
    if (entry === undefined || newer(seq, entry.seq)) {
      perDb.delete(slot);
      perDb.set(slot, fresh);
      while (perDb.size > 2 * MAX_DBS) {
        const oldest = perDb.keys().next().value;
        if (oldest === undefined) break;
        perDb.delete(oldest);
      }
    }
    entry = fresh;
  }
  let p = entry.values.get(key) as Promise<T> | undefined;
  if (p === undefined) {
    p = load();
    const values = entry.values;
    values.set(key, p);
    p.catch(() => values.delete(key));
  }
  return p;
}

/**
 * The active languages' (code, name) sorted by name: `res.lang._get_active_by` (res_lang.py:354-355), one ormcache
 * of the stable container behind `get_installed`, `_lang_get` and the session's language checks. Sorted as
 * Postgres sorts with the "C" collation of the templates (D20), which is code point order.
 */
export function activeLangRows(cr: Cursor): Promise<readonly { code: string; name: string }[]> {
  return registryCached(cr, "res.lang _get_active_by", async () => {
    const rows = (await cr.query<{ code: string; name: string }>("SELECT code, name FROM res_lang WHERE active")).rows;
    return rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }, "stable");
}

/** The end of the cursor's transaction: the next one reads its own now() and sequences. */
// ------------------------------------------------------------------------------------------- registry changes

const registryHooks: ((db: string) => void)[] = [];
const changedRegistry = new WeakSet<Cursor>();

/**
 * Register what an isolate keeps per database and must drop when the database's registry changes (its installed
 * modules: src/orm/template.ts, src/http/modules.ts, the loaded registry, the query-backed models).
 */
export function onRegistryChange(fn: (db: string) => void): void {
  registryHooks.push(fn);
}

function forgetRegistry(db: string): void {
  forgetCatalog(db);
  for (const hook of registryHooks) hook(db);
}

/**
 * The transaction changed the database's registry (a module install, src/modules/install.ts; Odoo's
 * `Registry.new(update_module=True)`): this isolate drops its state of the database now, so the next environment
 * loads the new registry, and the commit signals 'registry' (registry.py:1136-1138 `signal_changes`), so other
 * isolates and Odoo processes reload theirs.
 */
export function registryChanged(cr: Cursor): void {
  changedRegistry.add(cr);
  dropRegistryCaches(cr.db);
  forgetRegistry(cr.db);
}

/** A rolled-back registry change: the isolate's state of the database is the old registry's again. */
export function abandonRegistryChange(cr: Cursor): void {
  if (changedRegistry.has(cr)) forgetRegistry(cr.db);
}

export function endTransaction(cr: Cursor): void {
  releaseDatabase(cr);
  requestPerDb.delete(cr);
  requestShared.delete(cr);
  changedRegistry.delete(cr);
  perCursor.delete(cr);
  resolved.delete(cr);
  cr.writtenTables.clear();
}

/** Forget the isolate's cached values of a database. */
export function dropRegistryCaches(db: string): void {
  for (const c of Object.keys(KEYS)) isolatePerDb.delete(`${db}\u0000${c}`);
  isolateShared.delete(db);
}

// --------------------------------------------------------------------------------------------- shared reads

/**
 * Statements whose answer the isolate keeps across requests, as Odoo keeps the `ormcache` results built from them
 * (`_get_id`, `_xmlid_lookup`, `ir.access` rows, `_get_param`, views, `_get_model_defaults`, menus, currencies): a
 * pure read of WATCHED_TABLES only (src/sql_cache.ts readDeps), with nothing that changes between requests (the
 * clock, the session, randomness), by statement and parameters, under the request's signaling sequences. Every
 * write to one of these tables signals (`signalWrites` here, `_clear_cache_name` in Odoo), so equal sequences in a
 * later snapshot mean equal rows. Not used once the transaction has written one of them (as `registryCached`), nor
 * before the transaction's sequences are known: deciding must not wait, or a concurrent write could run first.
 */
interface SharedEntry { readonly value: Promise<unknown>; readonly size: number }
interface SharedDb { readonly seq: readonly number[]; readonly entries: Map<string, SharedEntry>; size: number }
const isolateShared = new Map<string, SharedDb>();
const requestShared = new WeakMap<Cursor, Map<string, SharedDb>>();
function sharedOf(cr: Cursor): Map<string, SharedDb> {
  if (cr.isolateCache !== false) return isolateShared;
  let m = requestShared.get(cr);
  if (m === undefined) requestShared.set(cr, m = new Map());
  return m;
}
/**
 * About 4 MB of strings per isolate at most, the oldest dropped first, and no answer over 256 KB. The isolate holds the
 * ERP template's registry close to the Workers limit of 128 MB: on the site an isolate over it is replaced and the next
 * request loads the registry again (about 800 ms CPU), and perf-1's 24 MB bound let the cache hold the registry's own
 * load twice (measured 2026-11-07, docs/perf-2026-11-07.md "Implementering (perf-2)"). The sale flow keeps about
 * 0.5 MB here.
 */
const SHARED_MAX = 4_000_000;
const SHARED_ENTRY_MAX = 256_000;

const VOLATILE = /\b(now|current_timestamp|current_date|current_time|localtime|localtimestamp|transaction_timestamp|statement_timestamp|clock_timestamp|timeofday|random|current_setting|current_user|session_user|current_role|user|current_schema|current_database|current_catalog|pg_backend_pid|inet_client_addr|inet_server_addr|version|gen_random_uuid|age|set_config|pg_sleep|txid_current|pg_current_xact_id|pg_current_snapshot)\b/i;

/** Whether a pure read with these table dependencies may be kept across requests. */
export function sharable(sql: string, deps: ReadonlySet<string> | null): boolean {
  if (deps === null || deps.size === 0) return false;
  for (const t of deps) if (!WATCHED_TABLES.has(t)) return false;
  return !VOLATILE.test(sql.replace(/'(?:[^']|'')*'/g, " "));
}

function sharedDb(cr: Cursor): SharedDb | null {
  if (touchesWatched(cr)) return null;
  const row = resolved.get(cr);
  if (row === undefined) return null;
  const shared = sharedOf(cr);
  const seq = sequenceOf(row, SIGNALING);
  let db = shared.get(cr.db);
  if (db === undefined || db.seq.some((v, i) => v !== seq[i])) {
    // a request on an older snapshot (REPEATABLE READ) does not replace a newer state: it reads without the cache
    if (db !== undefined && !newer(seq, db.seq)) return null;
    db = { seq, entries: new Map(), size: 0 };
    shared.delete(cr.db);
    shared.set(cr.db, db);
    while (shared.size > MAX_DBS) {
      const oldest = shared.keys().next().value;
      if (oldest === undefined) break;
      shared.delete(oldest);
    }
  }
  return db;
}

/** The kept answer of a sharable statement, or undefined (then `keepShared` once it runs). */
export function sharedRead(cr: Cursor, key: string): Promise<unknown> | undefined {
  return sharedDb(cr)?.entries.get(key)?.value;
}

/** Approximate bytes of a result, for the bound. */
function sizeOf(rows: readonly Record<string, unknown>[]): number {
  let n = 64;
  for (const r of rows) for (const v of Object.values(r)) n += typeof v === "string" ? v.length * 2 : v !== null && typeof v === "object" ? JSON.stringify(v).length * 2 : 8;
  return n;
}

export function keepShared(cr: Cursor, key: string, value: Promise<{ rows: Record<string, unknown>[] }>): void {
  const db = sharedDb(cr);
  if (db === null) return;
  const entries = db.entries;
  value.then((r) => {
    const e = entries.get(key);
    if (e === undefined || e.value !== value) return;
    const size = sizeOf(r.rows);
    if (size > SHARED_ENTRY_MAX) {
      entries.delete(key);
      return;
    }
    entries.set(key, { value, size });
    db.size += size;
    while (db.size > SHARED_MAX && entries.size > 0) {
      const [k, old] = entries.entries().next().value!;
      entries.delete(k);
      db.size -= old.size;
    }
  }, () => {
    if (entries.get(key)?.value === value) entries.delete(key);
  });
  entries.set(key, { value, size: 0 });
}

/** Whether this transaction wrote a table the caches read. */
export function touchesWatched(cr: Cursor): boolean {
  for (const t of cr.writtenTables) if (t === "*" || WATCHED_TABLES.has(t)) return true;
  return false;
}

/**
 * Before COMMIT: the signaling rows of this transaction's writes to watched tables (`_signal_changes`), and the
 * isolate's own caches of the database dropped at once. Odoo signals 'groups' for groups and xmlids
 * (res_groups.py:20-21, ir_model.py:2401-2417), 'stable' for access rows and languages (ir_access.py:251-255,
 * ir_model.py:451) and 'default' for users and companies (res_users.py:724-753); the port signals all three for a
 * write to any watched table, which clears at least what Odoo would.
 */
export async function signalWrites(cr: Cursor, run: (sql: string) => Promise<unknown>): Promise<void> {
  const registry = changedRegistry.has(cr);
  if (registry) await run("INSERT INTO orm_signaling_registry DEFAULT VALUES");
  if (!touchesWatched(cr)) return;
  dropRegistryCaches(cr.db);
  for (const name of ["default", "groups", "stable"]) await run(`INSERT INTO orm_signaling_${name} DEFAULT VALUES`);
}

/** Tables a statement writes: INSERT/UPDATE/DELETE/MERGE/TRUNCATE targets; DDL and other writes count as "*". */
export function writtenTablesOf(sql: string): string[] {
  const out: string[] = [];
  const re = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?(?:"?public"?\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi;
  for (const m of sql.matchAll(re)) out.push(m[1]!.toLowerCase());
  if (/^\s*(CREATE|ALTER|DROP|COMMENT|GRANT|REVOKE)\b/i.test(sql)) out.push("*");
  return out;
}

/** Cursors loading a registry (modules/loading.py `load_modules`: `registry.ready` is False until it ends). */
const LOADING = new WeakSet<Cursor>();

/** Mark the cursor's registry as loading (a module install, src/modules/install.ts) or ready again. */
export function setRegistryLoading(cr: Cursor, loading: boolean): void {
  if (loading) LOADING.add(cr);
  else LOADING.delete(cr);
}

/** `not registry.ready` for the cursor's database during its own load. */
export function registryLoading(cr: Cursor): boolean {
  return LOADING.has(cr);
}
