/**
 * The registry's rows shared between isolates (C2e): a new isolate reads them from the Workers Cache API of its data
 * centre instead of from Postgres through the tunnel (1.36 MB on poc_corpus, 4.2 MB on poc_erp, every new isolate on
 * the site: docs/accept/C2e.md).
 *
 * What is kept is what `readRegistryRows` (src/orm/registry.ts) read from the database, byte for byte for the JSON texts
 * Postgres built (ir_model_fields and the columns per model and per table) and as node-postgres parsed them for the
 * other rows (int4, boolean, varchar and jsonb only, which JSON keeps as they were). The registry is then built from
 * them by the same code as from the database.
 *
 * The key is the database's identity and the transaction's signaling sequences, all of them (src/orm/signaling.ts
 * SEQUENCES_SQL: `pg_database.oid` and the max(id) of every `orm_signaling_*` table), and the statements' text. Every
 * table the rows come from is watched (WATCHED_TABLES: ir_model, ir_model_fields, ir_model_fields_selection,
 * ir_model_inherit, ir_model_fields_group_rel, ir_model_data, res_lang; information_schema and pg_extension change by DDL,
 * which counts as a write to every table): a transaction that writes one inserts signaling rows before its COMMIT
 * (`signalWrites`; 'registry' too for a module install or a new field or model, `registryChanged`), so a snapshot with
 * the same sequences has the same rows. A copy of a database made again under the same name has another oid.
 *
 * Neither read nor kept: a transaction that has written a watched table (its own rows are not the committed ones) or
 * that loads a registry during an install (`registryLoading`), and a load whose statements were sent after such a
 * write. `REGISTRY_SHARE=0` turns it off (measurement). Where there is no Cache API (Node tests) the rows come from the
 * database as before.
 */
import type { Cursor } from "../db";
import { currentSequences, registryLoading, requestSequences, touchesWatched } from "./signaling";

export interface ModelRow {
  id: number; model: string; order: string; name: Record<string, string> | null; transient: boolean | null;
  abstract: boolean | null; is_mail_thread: boolean | null; state: string | null;
}
export interface SelectionRow { field_id: number; value: string; name: Record<string, string> | null }
export interface InheritRow { model_id: number; parent_id: number; link: string | null }
export interface GroupRow { field_id: number; xmlid: string }

/** What a registry load reads from the database (src/orm/registry.ts `readRegistryRows`). */
export interface RegistryRows {
  readonly models: readonly ModelRow[];
  /** ir_model_fields per model: the model and the text of its json_agg, in the statement's row order. */
  readonly fieldTexts: readonly (readonly [string, string])[];
  readonly selections: readonly SelectionRow[];
  readonly inherits: readonly InheritRow[];
  readonly groups: readonly GroupRow[];
  /** information_schema.columns per table: the table and the text of its json_agg, in the statement's row order. */
  readonly columnTexts: readonly (readonly [string, string])[];
  readonly unaccent: boolean;
  readonly langs: readonly string[];
}

// ------------------------------------------------------------------------------------------------------- format

/**
 * One UTF-8 text: a JSON header line, then the JSON texts one after the other. The header has the small row sets and,
 * per model and per table, the name and the byte length of its text.
 */
const FORMAT = 1;

interface Header {
  readonly v: number;
  readonly models: readonly ModelRow[];
  readonly selections: readonly SelectionRow[];
  readonly inherits: readonly InheritRow[];
  readonly groups: readonly GroupRow[];
  readonly unaccent: boolean;
  readonly langs: readonly string[];
  readonly fields: readonly (readonly [string, number])[];
  readonly columns: readonly (readonly [string, number])[];
}

export function encodeRows(rows: RegistryRows): Uint8Array {
  const enc = new TextEncoder();
  const fieldBytes = rows.fieldTexts.map(([, t]) => enc.encode(t));
  const columnBytes = rows.columnTexts.map(([, t]) => enc.encode(t));
  const header: Header = {
    v: FORMAT, models: rows.models, selections: rows.selections, inherits: rows.inherits, groups: rows.groups,
    unaccent: rows.unaccent, langs: rows.langs,
    fields: rows.fieldTexts.map(([m], i) => [m, (fieldBytes[i] as Uint8Array).length]),
    columns: rows.columnTexts.map(([t], i) => [t, (columnBytes[i] as Uint8Array).length]),
  };
  const head = enc.encode(JSON.stringify(header) + "\n");
  let size = head.length;
  for (const b of fieldBytes) size += b.length;
  for (const b of columnBytes) size += b.length;
  const out = new Uint8Array(size);
  out.set(head, 0);
  let at = head.length;
  for (const b of [...fieldBytes, ...columnBytes]) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

/** The rows of `encodeRows`; throws on anything else (then the database is read). */
export function decodeRows(bytes: Uint8Array): RegistryRows {
  const nl = bytes.indexOf(10);
  if (nl < 0) throw new TypeError("registry rows: no header");
  const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const header = JSON.parse(dec.decode(bytes.subarray(0, nl))) as Header;
  if (header.v !== FORMAT) throw new TypeError(`registry rows: format ${String(header.v)}`);
  let at = nl + 1;
  // each text decoded on its own: one string per model and table, as node-postgres gave them (a slice of one big
  // string would keep the whole text alive, twice its size once a character is outside Latin-1)
  const take = (list: readonly (readonly [string, number])[]): [string, string][] => list.map(([name, len]) => {
    const end = at + len;
    if (end > bytes.length) throw new TypeError("registry rows: truncated");
    const text = dec.decode(bytes.subarray(at, end));
    at = end;
    return [name, text];
  });
  const fieldTexts = take(header.fields);
  const columnTexts = take(header.columns);
  if (at !== bytes.length) throw new TypeError("registry rows: trailing bytes");
  return {
    models: header.models, fieldTexts, selections: header.selections, inherits: header.inherits, groups: header.groups,
    columnTexts, unaccent: header.unaccent, langs: header.langs,
  };
}

// -------------------------------------------------------------------------------------------------------- cache

/**
 * How the cursor's registry load got its rows, for SQL_LOG (`reg=`): hit (with the milliseconds from the sequences to
 * the decoded rows), put (read and kept), db (read, not kept).
 */
const SOURCE = new WeakMap<Cursor, string>();

export function registrySourceOf(cr: Cursor): string | undefined {
  return SOURCE.get(cr);
}

const CACHE_NAME = "odoo-ts-registry";
let version: Promise<string> | null = null;

/** The statements' text and the format, hashed: another load (other columns, other order) is another key. */
function versionOf(statements: string): Promise<string> {
  version ??= crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${FORMAT}\n${statements}`))
    .then((d) => [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join(""));
  return version;
}

function cacheStorage(cr: Cursor): CacheStorage | null {
  if (!cr.registryShare) return null;
  const storage: unknown = Reflect.get(globalThis, "caches");
  return typeof storage === "object" && storage !== null ? storage as CacheStorage : null;
}

/** May this transaction's registry rows be taken from, or kept in, the shared cache now. */
function shareable(cr: Cursor): boolean {
  return !touchesWatched(cr) && !registryLoading(cr);
}

/**
 * The registry rows of the cursor's database: from the shared cache under the transaction's sequences, or `read` from
 * the database (and kept there for the next isolate).
 */
export async function sharedRegistryRows(cr: Cursor, statements: string, read: (cr: Cursor) => Promise<RegistryRows>): Promise<RegistryRows> {
  const storage = cacheStorage(cr);
  if (storage === null || !shareable(cr)) {
    SOURCE.set(cr, "db");
    return read(cr);
  }
  let cache: Cache | null = null;
  let request: Request | null = null;
  const row = await requestSequences(cr);
  try {
    const parts = [row.dboid ?? "", row.registry, row.default, row.assets, row.stable, row.templates, row.routing, row.groups]
      .map((v) => String(v ?? 0));
    request = new Request(`https://registry.invalid/${encodeURIComponent(cr.db)}/${parts.join("-")}/${await versionOf(statements)}`);
    cache = await storage.open(CACHE_NAME);
    const t0 = performance.now();
    const hit = shareable(cr) && currentSequences(cr) === row ? await cache.match(request) : undefined;
    if (hit !== undefined) {
      const rows = decodeRows(new Uint8Array(await hit.arrayBuffer()));
      SOURCE.set(cr, `hit regms=${Math.round(performance.now() - t0)}`);
      return rows;
    }
  } catch (e) {
    // the cache is an optimization only: unreadable or unusable, the rows come from the database
    console.warn("registry cache unavailable:", e instanceof Error ? e.message : String(e));
    cache = null;
  }
  // decided synchronously with the sending of the statements: the snapshot is the sequences' and holds no write of this
  // transaction to the registry's tables
  const keep = cache !== null && request !== null && shareable(cr) && currentSequences(cr) === row;
  const rows = read(cr);
  if (keep) {
    SOURCE.set(cr, "put");
    const put = rows.then((r) => (cache as Cache).put(request as Request, new Response(encodeRows(r), {
      headers: { "content-type": "application/octet-stream", "cache-control": "max-age=86400" },
    }))).catch((e: unknown) => console.warn("registry cache put failed:", e instanceof Error ? e.message : String(e)));
    if (cr.waitUntil !== null) cr.waitUntil(put);
  } else {
    SOURCE.set(cr, "db");
  }
  return rows;
}
