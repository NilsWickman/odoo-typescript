/**
 * Prefetch of stored columns, as Odoo's `_fetch_field` (odoo/orm/models.py:3077-3095): a stored field missing from the
 * cache is read together with the other fields of its prefetch group, for the records being read and the other
 * records of the model this transaction has already read (Odoo's `_prefetch_ids`), in one statement.
 *
 * The values live on the cursor (src/sql_cache.ts `RowCache`) for the transaction and are what the database answers: a
 * statement that may change a table drops that table's rows before it runs (INSERT/UPDATE: its target tables; any
 * other write, DELETE with its cascades, savepoints, DDL: every table), and a read that was in flight across such a
 * statement is not kept. So a value from the cache is the value the single-column read would have returned at the
 * same point of the transaction (REPEATABLE READ: only the transaction's own statements change what it sees).
 *
 * Plain columns are kept: `Field.to_sql` is the bare column (no translation, no company-dependent value, no
 * compute_sql), on a model backed by its table (no `_table_sql` query), readable without groups; and translated and
 * company-dependent number and boolean columns as stored, their SQL expression evaluated when they are read
 * (prefetchTranslated, prefetchCompanyDependent). Everything else is read as before, one field per statement. Access is checked by the caller exactly as before (`fieldSql` runs
 * `check_field_access` for the requested field; record rules are `read()`'s check_access, as before).
 */
import type { Cursor } from "../db";
import type { RowCache } from "../sql_cache";
import { hooksOf } from "./hooks";
import { ident, type Query, runSql, Sql, sql } from "./sql";
import { tableQuery } from "./table_sql";
import type { Environment, FieldDef, ModelDef } from "./types";
import { fromPg } from "./values";

/** The most records one prefetch statement reads (the requested ones always, the model's other records up to it). */
export const PREFETCH_MAX = 1000;

/** Whether `field` is a plain column of `model` whose value the row cache may hold (see the module comment). */
export function plainColumn(model: ModelDef, field: FieldDef): boolean {
  return field.translate !== true && storedColumn(model, field);
}

/** A column read as it is stored: no company-dependent value, compute_sql, attachment, delegation or binary. */
function storedColumn(model: ModelDef, field: FieldDef): boolean {
  if (!field.store || !field.column || field.name === "id") return false;
  if (field.companyDependent || field.attachment || field.inheritedFrom !== null) return false;
  if (field.type === "binary" || field.type === "image" || field.type === "one2many" || field.type === "many2many") return false;
  if (hooksOf(model.name).computeSql?.[field.name] !== undefined) return false;
  return true;
}

/**
 * A translated column the row cache holds as stored (the jsonb of every language), the language picked when it is read
 * (prefetchTranslated). Html ones are left out: their bytes in every language for every prefetched record.
 */
function translatedColumn(model: ModelDef, field: FieldDef): boolean {
  return field.translate === true && field.type !== "html" && storedColumn(model, field);
}

/** The types of the company-dependent columns the row cache holds (their SQL is a cast of the company's jsonb value). */
const COMPANY_CAST_TYPES: ReadonlySet<string> = new Set(["boolean", "integer", "float", "monetary"]);

/**
 * A company-dependent column the row cache holds as stored (the jsonb of every company), the company's value or the
 * fallback picked when it is read (prefetchCompanyDependent): numbers and booleans only, whose SQL is the cast of the
 * jsonb value (fields.py:1378-1407); a many2one's checks that the id exists, the others go through `->>0`.
 */
function companyColumn(model: ModelDef, field: FieldDef): boolean {
  if (!field.companyDependent || !field.store || !field.column || field.name === "id" || field.inheritedFrom !== null) return false;
  return COMPANY_CAST_TYPES.has(field.type) && hooksOf(model.name).computeSql?.[field.name] === undefined;
}

/** A column the row cache may hold: plain, translated (see translatedColumn) or company-dependent (companyColumn). */
function cachedColumn(model: ModelDef, field: FieldDef): boolean {
  return plainColumn(model, field) || translatedColumn(model, field) || companyColumn(model, field);
}

const groups = new WeakMap<ModelDef, readonly string[]>();

/**
 * The prefetch group of a model (`f.prefetch == field.prefetch`, models.py:3083-3090): its plain columns. Fields with
 * groups are left out without asking (`has_field_access` would cost statements); they are read on their own.
 */
function prefetchGroup(model: ModelDef): readonly string[] {
  let g = groups.get(model);
  if (g === undefined) {
    g = [...model.fields.values()]
      .filter((f) => cachedColumn(model, f) && !f.noAccess && (f.groups === null || f.groups.length === 0))
      .map((f) => f.name);
    groups.set(model, g);
  }
  return g;
}

/** Whether `values()` may answer `field` from the row cache: a plain column whose SQL is the bare column. */
export function prefetchable(env: Environment, model: ModelDef, field: FieldDef, expr: Sql): boolean {
  if (!plainColumn(model, field) || tableQuery(env, model) !== null) return false;
  const bare = ident(model.table, field.name);
  return expr.params.length === 0 && expr.text === bare.text;
}

/**
 * Whether `values()` may answer a translated field from the row cache (prefetchTranslated): its column holds every
 * language and the SQL would pick one (`prefetch_langs` reads the whole value: not here).
 */
export function prefetchableTranslated(env: Environment, model: ModelDef, field: FieldDef): boolean {
  return translatedColumn(model, field) && tableQuery(env, model) === null && env.context["prefetch_langs"] !== true;
}

/**
 * A translated field's values for `ids` as `fieldSql`'s `COALESCE(col->>lang, col->>'en_US')` gives them
 * (fields_textual.py:421-431, `langs` from src/orm/sql.ts fallbackLangs), from the stored values in the row cache
 * (read with the group as prefetchValues does). `->>` of a string is the string; of a NULL column or a missing language
 * NULL. Null when a stored value holds something else than strings: the caller reads it with SQL as before.
 */
export async function prefetchTranslated(env: Environment, model: ModelDef, field: FieldDef, ids: readonly number[], langs: readonly string[]): Promise<Map<number, unknown> | null> {
  const raw = await prefetchValues(env, model, field, ids, (v) => v);
  const out = new Map<number, unknown>();
  for (const [id, v] of raw) {
    let picked: string | null = null;
    if (v !== null && v !== undefined) {
      if (typeof v !== "object" || Array.isArray(v)) return null;
      for (const lang of langs) {
        const t: unknown = Reflect.get(v, lang);
        if (t === undefined || t === null) continue;
        if (typeof t !== "string") return null;
        picked = t;
        break;
      }
    }
    out.set(id, fromPg(field.type, picked));
  }
  return out;
}

/** Whether `values()` may answer a company-dependent field from the row cache (prefetchCompanyDependent). */
export function prefetchableCompanyDependent(env: Environment, model: ModelDef, field: FieldDef): boolean {
  return companyColumn(model, field) && tableQuery(env, model) === null;
}

/**
 * A company-dependent field's values for `ids` as `fieldSql`'s `(COALESCE(col->company, to_jsonb(fallback)))::type`
 * gives them (fields.py:1378-1407), from the stored values in the row cache (read with the group as prefetchValues
 * does): the company's entry when the column has one, else `fallback` (the column value of the ir.default). Null when
 * an entry is not a value of the column's type (a JSON null, a string): the caller reads it with SQL as before.
 */
export async function prefetchCompanyDependent(env: Environment, model: ModelDef, field: FieldDef, ids: readonly number[], company: number, fallback: unknown): Promise<Map<number, unknown> | null> {
  const raw = await prefetchValues(env, model, field, ids, (v) => v);
  const key = String(company);
  const out = new Map<number, unknown>();
  for (const [id, v] of raw) {
    let value: unknown = fallback;
    if (v !== null && v !== undefined) {
      if (typeof v !== "object" || Array.isArray(v)) return null;
      const own: unknown = Reflect.get(v, key);
      // a JSON null is not SQL's NULL: COALESCE keeps it and the cast fails (as in Odoo): read with SQL
      if (own === null) return null;
      if (own !== undefined) value = own;
    }
    if (value === null || value === undefined) {
      value = null;
    } else if (field.type === "boolean") {
      if (typeof value !== "boolean") return null;
    } else if (typeof value !== "number" || (field.type === "integer" && !Number.isInteger(value))) {
      return null;
    }
    out.set(id, fromPg(field.type, value));
  }
  return out;
}

/** A value as the caller may keep and change it: json values are copied, the cache keeps its own. */
function copy(v: unknown): unknown {
  return v !== null && typeof v === "object" && !(v instanceof Date) ? structuredClone(v) : v;
}

/**
 * The values of a plain column for `ids` in cache format (as `values()` returns them). When one of them is missing,
 * all of them are read again with the group in one statement and the answer is that statement's (as the single-column
 * read issued at the same point), whatever ran concurrently; it is kept only when no write ran meanwhile.
 */
export async function prefetchValues(env: Environment, model: ModelDef, field: FieldDef, ids: readonly number[], convert: (v: unknown) => unknown = (v) => fromPg(field.type, copy(v))): Promise<Map<number, unknown>> {
  const cache: RowCache = env.cr.rows;
  const table = model.table;
  // ascending ids: the order the single-column read's `WHERE id IN (...)` gave through the primary key index
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  const missing = unique.some((id) => {
    const row = cache.row(table, id);
    return row === undefined || (row !== null && !row.has(field.name));
  });
  if (!missing && typeof env.cr.noteRead === "function") env.cr.noteRead(table, [field.name]);
  const rows = missing ? await fetchRows(env, cache, model, field, unique) : null;
  const out = new Map<number, unknown>();
  for (const id of unique) {
    const row = rows !== null ? rows.get(id) ?? null : cache.row(table, id);
    if (row === undefined) throw new TypeError(`prefetch of ${model.name}.${field.name}: no row state for ${id}`);
    if (row === null) continue; // no such record: absent from the map, as the single-column read
    if (!row.has(field.name)) throw new TypeError(`prefetch of ${model.name}.${field.name} left no value for ${id}`);
    out.set(id, convert(row.get(field.name)));
  }
  return out;
}

/** The group's columns for `ids` and the table's other read records (up to PREFETCH_MAX), by id; kept when no write ran. */
async function fetchRows(env: Environment, cache: RowCache, model: ModelDef, field: FieldDef, ids: readonly number[]): Promise<Map<number, Map<string, unknown>>> {
  const cr: Cursor = env.cr;
  const table = model.table;
  const group = prefetchGroup(model);
  const names = group.includes(field.name) ? group : [...group, field.name];
  // the model's other records read in this transaction that lack the field (Odoo's prefetch ids), up to PREFETCH_MAX
  const wanted = new Set(ids);
  for (const id of cache.seen(table)) {
    if (wanted.size >= Math.max(PREFETCH_MAX, ids.length)) break;
    const row = cache.row(table, id);
    if (row === null || (row !== undefined && row.has(field.name))) continue;
    wanted.add(id);
  }
  const all = [...wanted];
  const version = cache.version(table);
  const cols = Sql.join(", ", names.map((n) => sql`${ident(table, n)} AS ${ident(n)}`));
  const text = sql`SELECT ${ident(table, "id")} AS "id", ${cols} FROM ${ident(table)} WHERE ${ident(table, "id")} IN (${Sql.join(", ", all.map((i) => sql`${i}`))})`;
  const { text: q, values } = text.render();
  const result = (await cr.query<Record<string, unknown>>(q, values)).rows;
  const out = new Map<number, Map<string, unknown>>();
  for (const r of result) {
    const row = new Map<string, unknown>();
    for (const n of names) row.set(n, r[n]);
    out.set(Number(r["id"]), row);
  }
  // a write to the table while the statement ran: what it read may be older than the write, keep nothing
  if (cache.version(table) === version) {
    for (const id of all) {
      const row = out.get(id);
      cache.put(table, id, row === undefined ? null : new Map(row));
    }
  }
  hintRelated(env, model, names, out);
  return out;
}

/**
 * The many2one values of fetched rows join their comodel's prefetch ids (fields_relational.py:362-372
 * `prefetch_many2one_ids`: a many2one value's `_prefetch_ids` are the field's values of every record in the prefetch
 * set), so that reading the products of a quotation's lines is one statement, not one per line.
 */
function hintRelated(env: Environment, model: ModelDef, names: readonly string[], rows: ReadonlyMap<number, ReadonlyMap<string, unknown>>): void {
  for (const n of names) {
    const f = model.fields.get(n);
    if (f === undefined || f.type !== "many2one" || f.relation === null) continue;
    const comodel = env.reg.models.get(f.relation);
    if (comodel === undefined) continue;
    const ids: number[] = [];
    for (const row of rows.values()) {
      const v = row.get(n);
      if (v !== null && v !== undefined) ids.push(Number(v));
    }
    if (ids.length) env.cr.rows.hint(comodel.table, ids);
  }
}

/**
 * The ids an x2many value of the records reached (fields_relational.py `prefetch_x2many_ids`): prefetch ids of the
 * comodel, as many2one values are (hintRelated).
 */
export function hintIds(env: Environment, comodel: ModelDef, ids: Iterable<number>): void {
  if (tableQuery(env, comodel) === null) env.cr.rows.hint(comodel.table, ids);
}

/** The names a read()'s fetch selects with its ids: the prefetch group and the requested plain columns. */
function fetchedColumns(model: ModelDef, requested: readonly string[]): string[] {
  const names = [...prefetchGroup(model)];
  for (const n of requested) {
    const f = model.fields.get(n);
    if (f !== undefined && cachedColumn(model, f) && !names.includes(n)) names.push(n);
  }
  return names;
}

/**
 * Whether a read of `requested` for `ids` fetches columns (models.py:3134-3137: `fetch` queries only when a field to
 * fetch is a column; `_determine_fields_to_fetch(ignore_when_in_cache=True)`): one of them is a plain column some id
 * lacks in the row cache.
 */
export function readFetchesColumns(env: Environment, model: ModelDef, requested: readonly string[], ids: readonly number[]): boolean {
  if (tableQuery(env, model) !== null) return false;
  const cache = env.cr.rows;
  for (const n of requested) {
    const f = model.fields.get(n);
    if (f === undefined || !(plainColumn(model, f) || prefetchableTranslated(env, model, f))) continue;
    for (const id of ids) {
      const row = cache.row(model.table, id);
      if (row === undefined || (row !== null && !row.has(n))) return true;
    }
  }
  return false;
}

/**
 * read()'s fetch (models.py:3098-3153 `fetch` and :3229 `_fetch_query`): the ids `query` selects (the requested ids
 * with the access domain in its WHERE) and, with `columns`, the prefetch group and the requested plain columns of
 * those rows in the same statement, kept in the row cache when no write to the table ran meanwhile.
 */
export async function fetchQuery(env: Environment, model: ModelDef, query: Query, requested: readonly string[], columns: boolean): Promise<number[]> {
  if (query.isEmpty()) return [];
  const table = model.table;
  const cache = env.cr.rows;
  const names = columns ? fetchedColumns(model, requested) : [];
  const version = cache.version(table);
  const cols = names.map((n) => sql`${ident(query.alias, n)} AS ${ident(n)}`);
  const rows = await runSql<Record<string, unknown>>(env, query.select(sql`${query.table.id} AS "id"`, ...cols));
  const out = new Map<number, Map<string, unknown>>();
  for (const r of rows) {
    const row = new Map<string, unknown>();
    for (const n of names) row.set(n, r[n]);
    out.set(Number(r["id"]), row);
  }
  if (names.length && cache.version(table) === version) {
    for (const [id, row] of out) cache.put(table, id, new Map(row));
  }
  if (names.length) hintRelated(env, model, names, out);
  return [...out.keys()];
}

/**
 * The rows of a many2many relation table for `ids` (`Many2many.read`'s query of the links, fields_relational.py:
 * 1428-1436), kept in the row cache like columns: an INSERT into the table drops its links, any DELETE every link.
 */
export async function many2manyLinks(env: Environment, field: FieldDef, ids: readonly number[]): Promise<{ parent: number; child: number }[]> {
  if (!field.relationTable || !field.column1 || !field.column2) throw new TypeError(`${field.name} is not a many2many`);
  const table = field.relationTable;
  const columns = `${field.column1}\u0000${field.column2}`;
  const cache = env.cr.rows;
  const unique = [...new Set(ids)];
  const out: { parent: number; child: number }[] = [];
  if (unique.every((id) => cache.link(table, columns, id) !== undefined)) {
    if (typeof env.cr.noteRead === "function") env.cr.noteRead(table, null);
    for (const id of unique) for (const child of cache.link(table, columns, id)!) out.push({ parent: id, child });
    return out;
  }
  // one missing: all of them in one statement, whose answer this is; kept when no write ran meanwhile
  const version = cache.version(table);
  const rows = await runSql<{ parent: number; child: number }>(env, sql`SELECT ${ident(field.column1)} AS parent, ${ident(field.column2)} AS child FROM ${ident(table)} WHERE ${ident(field.column1)} = ANY(${unique}::int[])`);
  if (cache.version(table) === version) {
    const byParent = new Map<number, number[]>(unique.map((id) => [id, []]));
    for (const r of rows) byParent.get(r.parent)?.push(r.child);
    for (const [id, children] of byParent) cache.putLinks(table, columns, id, children);
  }
  return rows;
}
