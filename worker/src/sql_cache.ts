/**
 * What a statement does to the transaction's caches (src/db.ts): the tables a write may change and the tables a read
 * depends on. Odoo keeps field values in the environment's cache for the transaction and invalidates exactly what a
 * write touched (models.py `_write`, `invalidate_model`); the port caches statements and rows by the tables they read
 * and drops them by the tables a statement writes.
 *
 * Both sides are conservative: a write is "every table" unless it is an INSERT or UPDATE whose target tables are
 * known (in Odoo's schema neither has effects elsewhere: no ON UPDATE action, no trigger but the harness's audit, no
 * rule), and a read depends on "every table" unless every relation it names is a known plain table of the public
 * schema, it calls no function that may read tables (functions of the public schema in SQL/plpgsql, the XML and
 * sequence readers) and nothing makes the scan unreliable (escaped or dollar-quoted strings). "Every table" is what
 * the cursor did before: the entry is dropped by any write.
 */
import { writtenTablesOf } from "./orm/signaling";

/** The relations and functions of the public schema, from pg_class/pg_proc, per isolate and database. */
export interface Catalog {
  /** Plain tables (relkind r, p). */
  readonly tables: ReadonlySet<string>;
  /** Views, materialized views, sequences, foreign tables: what they read is not visible in the statement. */
  readonly opaque: ReadonlySet<string>;
  /** Functions of the public schema in a language that may read tables (not C/internal). */
  readonly functions: ReadonlySet<string>;
}

export const CATALOG_SQL = `SELECT c.relname::text AS name, c.relkind::text AS kind FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  UNION ALL SELECT p.proname::text, 'F' FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
  WHERE p.pronamespace = 'public'::regnamespace AND l.lanname NOT IN ('c', 'internal')`;

export function catalogOf(rows: readonly { name: string; kind: string }[]): Catalog {
  const tables = new Set<string>();
  const opaque = new Set<string>();
  const functions = new Set<string>();
  for (const r of rows) {
    const name = r.name.toLowerCase();
    if (r.kind === "r" || r.kind === "p") tables.add(name);
    else if (r.kind === "F") functions.add(name);
    else opaque.add(name);
  }
  return { tables, opaque, functions };
}

const catalogs = new Map<string, Catalog>();
export function catalogFor(db: string): Catalog | undefined {
  return catalogs.get(db);
}
export function setCatalog(db: string, catalog: Catalog): void {
  catalogs.delete(db);
  catalogs.set(db, catalog);
  while (catalogs.size > 64) {
    const oldest = catalogs.keys().next().value;
    if (oldest === undefined) break;
    catalogs.delete(oldest);
  }
}
/** DDL, or the registry signaling moved (another process installed something): the catalog is read again. */
export function forgetCatalog(db: string): void {
  catalogs.delete(db);
}

// ------------------------------------------------------------------------------------------------- writes

export type WriteEffect =
  | { readonly kind: "all" }
  /**
   * `rows`: an UPDATE of these ids of one table only (`WHERE id = $n` or `= ANY($n)` closing the statement), which sets
   * `columns` only (null when the SET list cannot be read: the whole rows).
   */
  | { readonly kind: "tables"; readonly tables: readonly string[]; readonly rows: UpdatedRows | null; readonly insert?: true };

export interface UpdatedRows { readonly table: string; readonly ids: readonly number[]; readonly columns: readonly string[] | null }

const PLAIN_WRITE = /^\s*(INSERT|UPDATE)\b/i;
const OTHER_WRITE = /\b(DELETE|TRUNCATE|MERGE|COPY)\b/i;
const UPDATE_BY_ID = /^\s*UPDATE\s+(?:ONLY\s+)?(?:"?public"?\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s+(?:(?:AS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s+)?SET\s([\s\S]*)\sWHERE\s+(?:"?([A-Za-z_][A-Za-z0-9_]*)"?\.)?"?id"?\s*(?:=\s*\$(\d+)|=\s*ANY\s*\(\s*\$(\d+)\s*(?:::\s*(?:int|int4|integer|int8|bigint)\s*\[\]\s*)?\))\s*$/i;

/** True when `set` contains a top-level `FROM` clause (e.g. `UPDATE a SET x = b.y FROM b WHERE ...`) or cannot be scanned safely. */
function hasTopLevelFrom(set: string): boolean {
  if (/\bE'|\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$|\\'/i.test(set)) return true;
  let depth = 0, quote: string | null = null;
  let top = "";
  for (let i = 0; i < set.length; i++) {
    const c = set[i]!;
    if (quote !== null) {
      if (c === quote) {
        if (set[i + 1] === quote) i++;
        else quote = null;
      }
    } else if (c === "'" || c === '"') {
      quote = c;
      if (depth === 0) top += " ";
    } else if (c === "(" || c === "[") {
      if (depth === 0) top += " ";
      depth++;
    } else if (c === ")" || c === "]") {
      if (--depth < 0) return true;
    } else if (depth === 0) {
      top += c;
    }
  }
  if (quote !== null || depth !== 0) return true;
  return /\bFROM\b/i.test(top);
}

/**
 * The columns a SET list assigns (`"a" = $1, b = COALESCE(b, $2) || $3, ...`): split at the commas outside parentheses
 * and literals, each part `column = expression`. Null when a part is anything else (`(a, b) = (...)`) or the scan
 * cannot be trusted (escaped or dollar-quoted strings).
 */
export function setColumns(set: string): string[] | null {
  if (/\bE'|\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$|\\'/i.test(set)) return null;
  const parts: string[] = [];
  let depth = 0, start = 0, quote: string | null = null;
  for (let i = 0; i < set.length; i++) {
    const c = set[i]!;
    if (quote !== null) {
      if (c === quote) {
        if (set[i + 1] === quote) i++; // '' or "" inside the literal
        else quote = null;
      }
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") { if (--depth < 0) return null; }
    else if (c === "," && depth === 0) { parts.push(set.slice(start, i)); start = i + 1; }
  }
  if (quote !== null || depth !== 0) return null;
  parts.push(set.slice(start));
  const columns: string[] = [];
  for (const part of parts) {
    const m = /^\s*(?:"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))\s*=(?!=)/.exec(part);
    if (m === null) return null;
    columns.push(m[1] ?? m[2]!.toLowerCase());
  }
  return columns;
}

function updatedRows(sql: string, params: readonly unknown[]): UpdatedRows | null {
  const m = UPDATE_BY_ID.exec(sql);
  if (m === null) return null;
  const table = m[1]!.toLowerCase();
  const alias = m[2]?.toLowerCase();
  const setClause = m[3]!;
  const qualifier = m[4]?.toLowerCase();
  if (qualifier !== undefined && qualifier !== (alias ?? table)) return null;
  if (hasTopLevelFrom(setClause)) return null;
  if (/(?:^|[\s,(])"?id"?\s*=/i.test(setClause)) return null; // SET id = ...: the row moves
  const p = params[Number(m[5] ?? m[6]) - 1];
  const values = m[5] !== undefined ? [p] : Array.isArray(p) ? p : null;
  if (values === null) return null;
  const ids: number[] = [];
  for (const v of values) {
    const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
    if (!Number.isSafeInteger(n)) return null;
    ids.push(n);
  }
  return { table, ids, columns: setColumns(setClause) };
}

/**
 * `SELECT nextval('<sequence>')` and nothing else (ir_sequence.py `_next_do` for a standard sequence): it moves the
 * sequence and changes no table. A read of a sequence itself is never kept (readDeps: an opaque relation).
 */
const NEXTVAL_ONLY = /^\s*SELECT\s+nextval\(\s*'[A-Za-z_][A-Za-z0-9_]*'\s*\)(?:\s*::\s*[A-Za-z0-9_]+)?(?:\s+AS\s+"?[A-Za-z_][A-Za-z0-9_]*"?)?\s*;?\s*$/i;

/** What a statement that is not a pure read may change. */
export function writeEffect(sql: string, params: readonly unknown[]): WriteEffect {
  if (NEXTVAL_ONLY.test(sql)) return { kind: "tables", tables: [], rows: null };
  if (PLAIN_WRITE.test(sql) && !OTHER_WRITE.test(sql)) {
    const tables = writtenTablesOf(sql);
    if (tables.length > 0 && !tables.includes("*")) {
      // an INSERT adds rows and changes none (no trigger or rule; ON CONFLICT DO UPDATE does change one)
      if (/^\s*INSERT\b/i.test(sql) && !/\bON\s+CONFLICT\b[\s\S]*\bDO\s+UPDATE\b/i.test(sql) && tables.length === 1) return { kind: "tables", tables, rows: null, insert: true };
      const rows = updatedRows(sql, params);
      return { kind: "tables", tables, rows: rows !== null && tables.length === 1 && tables[0] === rows.table ? rows : null };
    }
  }
  return { kind: "all" };
}

// ------------------------------------------------------------------------------------------------- reads

/** Builtins that read relations or state by name or move with the statement, never attributed to tables. */
const OPAQUE_FUNCTIONS = new Set([
  "query_to_xml", "query_to_xmlschema", "query_to_xml_and_xmlschema", "table_to_xml", "table_to_xmlschema",
  "table_to_xml_and_xmlschema", "cursor_to_xml", "cursor_to_xmlschema", "schema_to_xml", "database_to_xml", "dblink",
  "lo_get", "lo_import", "pg_read_file", "pg_read_binary_file", "currval", "lastval", "nextval", "setval",
  "pg_sequence_last_value", "statement_timestamp", "timeofday", "clock_timestamp", "random", "txid_current",
  "txid_current_snapshot", "pg_current_snapshot", "pg_current_xact_id", "pg_current_xact_id_if_assigned",
]);

const WORD = /[A-Za-z_][A-Za-z0-9_$]*/g;
const CALL = /([A-Za-z_][A-Za-z0-9_$]*)\s*\(/g;
const TARGET = /\b(?:FROM|JOIN)\s+(?:ONLY\s+)?([A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*([A-Za-z_][A-Za-z0-9_$]*))?(\s*\()?/gi;
const CTE_FIRST = /\bWITH\s+(?:RECURSIVE\s+)?([A-Za-z_][A-Za-z0-9_$]*)\s*(?:\([^)]*\)\s*)?AS\b/gi;
const CTE_NEXT = /,\s*([A-Za-z_][A-Za-z0-9_$]*)\s*(?:\([^)]*\)\s*)?AS\s+(?:NOT\s+)?(?:MATERIALIZED\s+)?\(/gi;

/**
 * The plain tables a pure read depends on, or null when that cannot be told from the statement (see the module
 * comment). Every word that names a table counts (aliases and literals only widen the set).
 */
export function readDeps(sql: string, catalog: Catalog | undefined): ReadonlySet<string> | null {
  if (catalog === undefined) return null;
  // escaped and dollar-quoted strings would defeat the literal scan below
  if (/\bE'|\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$|\\'/i.test(sql)) return null;
  const text = sql.replace(/'(?:[^']|'')*'/g, " ").replace(/"([^"]*)"/g, (_, name: string) => name.toLowerCase());
  if (text.includes("'") || text.includes('"')) return null;
  const deps = new Set<string>();
  for (const m of text.matchAll(WORD)) {
    const w = m[0].toLowerCase();
    if (w === "pg_catalog" || w === "information_schema" || catalog.opaque.has(w)) return null;
    if (catalog.tables.has(w)) deps.add(w);
  }
  for (const m of text.matchAll(CALL)) {
    const f = m[1]!.toLowerCase();
    if (catalog.functions.has(f) || OPAQUE_FUNCTIONS.has(f)) return null;
  }
  const ctes = new Set<string>();
  for (const m of text.matchAll(CTE_FIRST)) ctes.add(m[1]!.toLowerCase());
  for (const m of text.matchAll(CTE_NEXT)) ctes.add(m[1]!.toLowerCase());
  for (const m of text.matchAll(TARGET)) {
    if (m[3] !== undefined) continue; // FROM func(...) / FROM (subquery): functions were checked above
    const first = m[1]!.toLowerCase();
    if (first === "lateral") continue; // JOIN LATERAL (...) / LATERAL func(...)
    if (m[2] !== undefined && first !== "public") return null; // another schema
    const name = (m[2] ?? m[1]!).toLowerCase();
    if (!catalog.tables.has(name) && !ctes.has(name)) return null; // EXTRACT(x FROM col), IS DISTINCT FROM, unknown
  }
  return deps;
}

/**
 * The plain tables named anywhere in a write statement (for selective pending-write flushing on raw UPDATEs), or null
 * when that cannot be told safely (no catalog, escaped/dollar strings, opaque view/function/schema).
 */
export function mentionedTables(sql: string, catalog: Catalog | undefined): ReadonlySet<string> | null {
  if (catalog === undefined) return null;
  if (/\bE'|\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$|\\'/i.test(sql)) return null;
  const text = sql.replace(/'(?:[^']|'')*'/g, " ").replace(/"([^"]*)"/g, (_, name: string) => name.toLowerCase());
  if (text.includes("'") || text.includes('"')) return null;
  const tables = new Set<string>();
  for (const m of text.matchAll(WORD)) {
    const w = m[0].toLowerCase();
    if (w === "pg_catalog" || w === "information_schema" || catalog.opaque.has(w)) return null;
    if (catalog.tables.has(w)) tables.add(w);
  }
  for (const m of text.matchAll(CALL)) {
    const f = m[1]!.toLowerCase();
    if (catalog.functions.has(f) || OPAQUE_FUNCTIONS.has(f)) return null;
  }
  return tables;
}

/** Functions that take a whole row (`row_to_json(x)`): a read calling one depends on every column. */
const ROW_FUNCTIONS = new Set(["to_json", "to_jsonb", "row_to_json", "json_agg", "jsonb_agg", "array_agg", "hstore",
  "json_populate_record", "jsonb_populate_record", "row", "record_in", "record_out"]);

/**
 * The words of a pure read whose tables `readDeps` could tell (columns, aliases, tables, keywords; lowercased), or null
 * when it may depend on columns it does not name: `*` (but `count(*)`) or a function of a whole row. An UPDATE that
 * sets only columns none of these words names changes no row the read returns and no row it filters on (an UPDATE
 * neither adds nor removes rows; no trigger, rule or generated column, see the module comment), so its result stays.
 */
export function readWords(sql: string): ReadonlySet<string> | null {
  const text = sql.replace(/'(?:[^']|'')*'/g, " ").replace(/"([^"]*)"/g, (_, name: string) => name.toLowerCase());
  if (text.replace(/\bcount\s*\(\s*\*\s*\)/gi, " ").includes("*")) return null;
  for (const m of text.matchAll(CALL)) if (ROW_FUNCTIONS.has(m[1]!.toLowerCase())) return null;
  const words = new Set<string>();
  for (const m of text.matchAll(WORD)) words.add(m[0].toLowerCase());
  return words;
}

// ------------------------------------------------------------------------------------------------- caches

/**
 * Whether an entry depending on `deps` survives `effect`: it reads none of the written tables, or a written table only
 * through columns an UPDATE by id does not set (`words`: readWords of the entry, null when unknown).
 */
function survives(deps: ReadonlySet<string> | null, words: ReadonlySet<string> | null, effect: WriteEffect): boolean {
  if (effect.kind === "all" || deps === null) return false;
  for (const t of effect.tables) {
    if (!deps.has(t)) continue;
    const rows = effect.rows;
    if (words !== null && rows !== null && rows.table === t && rows.columns !== null && rows.columns.every((c) => !words.has(c.toLowerCase()))) continue;
    return false;
  }
  return true;
}

/** Results of pure reads in the transaction, by statement and parameters, with the tables they read. */
export class ReadCache<V> {
  private readonly entries = new Map<string, { readonly value: V; readonly deps: ReadonlySet<string> | null; readonly words: ReadonlySet<string> | null }>();

  get(key: string): V | undefined {
    return this.entries.get(key)?.value;
  }

  set(key: string, value: V, deps: ReadonlySet<string> | null, words: ReadonlySet<string> | null = null): void {
    this.entries.set(key, { value, deps, words });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  drop(effect: WriteEffect): void {
    if (effect.kind === "all") {
      this.entries.clear();
      return;
    }
    for (const [k, e] of this.entries) if (!survives(e.deps, e.words, effect)) this.entries.delete(k);
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Column values of rows read in this transaction (src/orm/prefetch.ts), by table and id; `null` for an id the table
 * does not have; and many2many links by relation table. A write drops what it may have changed (an UPDATE by id
 * only those rows) and moves the tables' versions, so a read that was in flight across it is not kept.
 */
export class RowCache {
  private readonly tables = new Map<string, Map<number, Map<string, unknown> | null>>();
  /** many2many links by relation table, then `column1\0column2`, then the column1 id: its column2 ids. */
  private readonly links = new Map<string, Map<string, Map<number, number[]>>>();
  /** Ids read per table in this transaction, kept across drops: the prefetch ids of the next read. */
  private readonly seenIds = new Map<string, Set<number>>();
  private readonly versions = new Map<string, number>();
  private epoch = 0;
  /** x2many values by relation key (src/orm/model.ts relationValues), with the tables/columns they depend on. */
  private readonly x2m = new Map<string, {
    readonly values: Map<number, readonly number[]>;
    deps: Set<string> | null;
    words: Set<string> | null;
  }>();
  private writes = 0;

  row(table: string, id: number): Map<string, unknown> | null | undefined {
    return this.tables.get(table)?.get(id);
  }

  /**
   * Whether every id is a row read in this transaction and not deleted since (a DELETE, TRUNCATE or an UPDATE of
   * `id` drops the table's rows): what `SELECT id FROM table WHERE id = ANY(ids)` would answer with all of them.
   */
  allExist(table: string, ids: readonly number[]): boolean {
    const rows = this.tables.get(table);
    if (rows === undefined) return false;
    for (const id of ids) {
      const row = rows.get(id);
      if (row === undefined || row === null) return false;
    }
    return true;
  }

  seen(table: string): Iterable<number> {
    return this.seenIds.get(table) ?? [];
  }

  version(table: string): string {
    return `${this.epoch}.${this.versions.get(table) ?? 0}`;
  }

  put(table: string, id: number, row: Map<string, unknown> | null): void {
    let t = this.tables.get(table);
    if (t === undefined) this.tables.set(table, t = new Map());
    const old = t.get(id);
    if (row !== null && old !== undefined && old !== null) for (const [k, v] of row) old.set(k, v);
    else t.set(id, row);
    this.hint(table, [id]);
  }

  /**
   * Ids of `table` reached through a relation's values (Odoo's `_prefetch_ids` of a many2one or x2many value,
   * fields_relational.py prefetch_many2one_ids/prefetch_x2many_ids): the next prefetch of the table reads them too.
   * Nothing is known of their rows.
   */
  hint(table: string, ids: Iterable<number>): void {
    let s = this.seenIds.get(table);
    if (s === undefined) this.seenIds.set(table, s = new Set());
    for (const id of ids) {
      if (s.size >= 1000) break;
      // a SQL view's bigint id may come as a string (pg's int8): kept as the number the rows are keyed by
      const n = Number(id);
      if (Number.isInteger(n) && n > 0) s.add(n);
    }
  }

  link(table: string, columns: string, id: number): readonly number[] | undefined {
    return this.links.get(table)?.get(columns)?.get(id);
  }

  putLinks(table: string, columns: string, id: number, children: number[]): void {
    let t = this.links.get(table);
    if (t === undefined) this.links.set(table, t = new Map());
    let c = t.get(columns);
    if (c === undefined) t.set(columns, c = new Map());
    c.set(id, children);
  }

  /**
   * The x2many value of `parent` under `key` kept since the last touching write, or undefined. Entries track the tables
   * and words their fetch read (when known) and survive writes to unrelated tables/columns via `survives`.
   */
  x2many(key: string, parent: number): readonly number[] | undefined {
    return this.x2m.get(key)?.values.get(parent);
  }

  putX2many(
    key: string,
    parent: number,
    children: readonly number[],
    deps: ReadonlySet<string> | null = null,
    words: ReadonlySet<string> | null = null,
  ): void {
    let entry = this.x2m.get(key);
    if (entry === undefined) {
      entry = {
        values: new Map(),
        deps: deps === null ? null : new Set(deps),
        words: words === null ? null : new Set(words),
      };
      this.x2m.set(key, entry);
    } else {
      if (deps === null) entry.deps = null;
      else if (entry.deps !== null) for (const d of deps) entry.deps.add(d);
      if (words === null) entry.words = null;
      else if (entry.words !== null) for (const w of words) entry.words.add(w);
    }
    entry.values.set(parent, children);
  }

  /** Moves with every write and every new transaction: an x2many read in flight across one is not kept. */
  writeCount(): number {
    return this.writes;
  }

  private dropX2m(effect: WriteEffect): void {
    if (effect.kind === "all") {
      this.x2m.clear();
      return;
    }
    for (const [k, entry] of this.x2m) {
      if (!survives(entry.deps, entry.words, effect)) this.x2m.delete(k);
    }
  }

  /**
   * Apply buffered column updates for `table` in place (src/pending_writes.ts): existing cached rows receive the new
   * raw values for plain columns (and drop non-cacheable / NOW columns), affected x2many caches drop, and the table
   * version moves so any in-flight read started before this write is not kept.
   */
  applyPending(
    table: string,
    effect: WriteEffect,
    rows: readonly [number, ReadonlyMap<string, { readonly raw: unknown } | null>][],
  ): void {
    this.dropX2m(effect);
    this.writes++;
    const tbl = this.tables.get(table);
    if (tbl !== undefined) {
      for (const [id, cols] of rows) {
        const row = tbl.get(id);
        if (row === undefined || row === null) continue;
        for (const [col, v] of cols) {
          if (v === null) row.delete(col);
          else row.set(col, v.raw);
        }
      }
    }
    this.links.delete(table);
    this.versions.set(table, (this.versions.get(table) ?? 0) + 1);
  }

  drop(effect: WriteEffect): void {
    this.dropX2m(effect);
    this.writes++;
    if (effect.kind === "all") {
      this.clear();
      return;
    }
    for (const t of effect.tables) {
      if (effect.rows !== null && effect.rows.table === t) {
        // an UPDATE by id changes the columns it sets of those rows only (no trigger, rule or generated column)
        const rows = this.tables.get(t);
        const columns = effect.rows.columns;
        if (rows !== undefined) {
          for (const id of effect.rows.ids) {
            const row = rows.get(id);
            if (columns === null || row === undefined || row === null) rows.delete(id);
            else for (const c of columns) row.delete(c);
          }
        }
      } else if (effect.insert === true) {
        // the ids known to be absent may exist now; the rows read are unchanged
        const rows = this.tables.get(t);
        if (rows !== undefined) for (const [id, row] of rows) if (row === null) rows.delete(id);
      } else {
        this.tables.delete(t);
      }
      this.links.delete(t);
      this.versions.set(t, (this.versions.get(t) ?? 0) + 1);
    }
  }

  clear(): void {
    this.x2m.clear();
    this.writes++;
    this.tables.clear();
    this.links.clear();
    this.epoch++;
  }
}
