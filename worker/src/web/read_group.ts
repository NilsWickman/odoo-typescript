/**
 * `web_read_group` and `formatted_read_group` (`odoo/addons/web/models/models.py:567-1480`, Odoo 20) on top of the
 * `_read_group` contract (`odoo/odoo/orm/models.py:1996`). The ORM contract (src/orm/types.ts) has no `_read_group`
 * yet (NEEDS.md), so `rawReadGroup` below is a JS fallback over `search` + `read` that follows `_read_group_groupby`
 * (models.py:2124), `_read_group_select` (2087), `_read_group_orderby` (2202) and the postprocessing (2294-2373)
 * for plain fields; it refuses (NotPorted) dotted and properties groupbys; `having` is evaluated on the groups.
 */
import { NotPorted } from "../errors";
import { hasGroup } from "../orm/env";
import { registerBaseMethod } from "./register";
import { and, cond, iterConditions, or, pyRepr as pyValueRepr, PyTypeError, PyValueError, toList, TRUE } from "../orm/domain";
import type { Context, Domain, Environment, FieldDef, ModelDef, RecordValues } from "../orm/types";
import { isPyFloat, pyFloat } from "../orm/values";
import { pyFloatRepr } from "../pyexpr/values";
import { boolArg, envFor, intArg, isRecord, optInt, optStr, parseSpecification, type Specification } from "./common";
import { parseDomain } from "../orm/domain";
import { checkModelAccess } from "../orm/access";
import { checkFieldAccess, ident, raw, runSql, Sql, sql, sqlColumnType } from "../orm/sql";
import { tableQuery } from "../orm/table_sql";
import {
  addInterval, cldrLocale, formatGroupLabel, type Granularity, isGranularity, isoWeek, truncate,
} from "./labels";
import { formatNaive, isTimezone, localToUtc, type Naive, parseNaive, utcToLocal } from "./tz";
import { webRead } from "./read";
import { hooksOf } from "../orm/hooks";
import { envCache } from "../orm/env";
import { requestSequences } from "../orm/signaling";
import { currentRates } from "./currency_rates";
import { keyed } from "../orm/keys";
import GROUP_EXPAND_METHODS from "../../gen/out/poc_erp/group_expand.json" with { type: "json" };

const MAX_NUMBER_OPENED_GROUPS = 10; // models.py:31

// --------------------------------------------------------------------------------------------------------------
// Specs and order parsing (odoo/odoo/orm/models.py:88-120)
// --------------------------------------------------------------------------------------------------------------

/** regex_read_group_spec (models.py:108): `field`, `field.property.path`, `field:func`, `field.property:func`. */
export function parseReadGroupSpec(spec: string): [string, string | null, string | null] {
  const m = /^(\w+)(?:\.([\w.]+))?(?::(\w+))?$/.exec(spec);
  // models.py:118-126 parse_read_group_spec: `{spec!r}` and the two lines of help
  if (m === null) throw new PyValueError(`Invalid aggregate/groupby specification ${pyValueRepr(spec)}.\n`
    + `- Valid aggregate specification looks like "<field_name>:<agg>" example: "quantity:sum".\n`
    + `- Valid groupby specification looks like "<no_datish_field_name>" or "<datish_field_name>:<granularity>" example: "date:month" or "<properties_field_name>.<property>:<granularity>".`);
  return [m[1] ?? "", m[2] ?? null, m[3] ?? null];
}

export interface OrderPart {
  readonly term: string;
  readonly field: string;
  readonly property: string | null;
  readonly func: string | null;
  readonly direction: "ASC" | "DESC";
  readonly nulls: "" | "NULLS FIRST" | "NULLS LAST";
}

const RE_ORDER_PART = /^\s*(?<term>(?<field>[a-z0-9_]+)(?:\.(?<property>[a-z0-9_]+))?(?::(?<func>[a-z_]+))?)(?:\s+(?<direction>desc|asc))?(?:\s+(?<nulls>nulls first|nulls last))?\s*$/i;

/** One part of regex_order (models.py:88) / regex_order_part_read_group (models.py:100). */
export function parseOrderPart(part: string, whole: string, who: string): OrderPart {
  const m = RE_ORDER_PART.exec(part);
  const g = m?.groups;
  if (m === null || g === undefined) throw new PyValueError(`Invalid order ${pyRepr(whole)} for ${who}`);
  const direction = (g["direction"] ?? "ASC").toUpperCase() === "DESC" ? "DESC" : "ASC";
  const nullsRaw = (g["nulls"] ?? "").toUpperCase();
  return {
    term: g["term"] ?? "",
    field: g["field"] ?? "",
    property: g["property"] ?? null,
    func: g["func"] ?? null,
    direction,
    nulls: nullsRaw === "NULLS FIRST" ? "NULLS FIRST" : nullsRaw === "NULLS LAST" ? "NULLS LAST" : "",
  };
}

function pyRepr(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

// --------------------------------------------------------------------------------------------------------------
// Language helpers (odoo/odoo/tools/misc.py:1272 get_lang): the installed context lang, else en_US
// --------------------------------------------------------------------------------------------------------------

interface LangData { code: string; weekStart: number }

async function getLang(env: Environment): Promise<LangData> {
  const key = `web.get_lang:${env.lang ?? ""}`;
  const cached = env.cache.get(key);
  if (isRecord(cached) && typeof cached["code"] === "string" && typeof cached["weekStart"] === "number") {
    return { code: cached["code"], weekStart: cached["weekStart"] };
  }
  const res = await env.cr.query<{ code: string; week_start: string }>("SELECT code, week_start FROM res_lang WHERE active ORDER BY code");
  const rows = res.rows;
  const wanted = env.context.lang;
  let row = rows.find((r) => r.code === wanted) ?? rows.find((r) => r.code === "en_US") ?? rows[0];
  if (row === undefined) throw new NotPorted("no active res_lang");
  // misc.py:1288 also tries the company partner's language before en_US; not needed while en_US is installed
  if (row.code !== wanted && !rows.some((r) => r.code === "en_US")) row = rows[0] ?? row;
  const data: LangData = { code: row.code, weekStart: parseInt(row.week_start, 10) };
  env.cache.set(key, data);
  return data;
}

// --------------------------------------------------------------------------------------------------------------
// group_expand registry (fields.py `group_expand`, `determine_group_expand`; models.py:2375 _read_group_expand_full)
// --------------------------------------------------------------------------------------------------------------

/** For relational fields `values` are ids and the result ids; for selection fields they are the keys. */
export type GroupExpandFn = (env: Environment, model: string, values: readonly unknown[], domain: Domain) => Promise<unknown[]>;

const GROUP_EXPAND = new Map<string, GroupExpandFn>();

export function registerGroupExpand(model: string, field: string, fn: GroupExpandFn): void {
  GROUP_EXPAND.set(`${model}.${field}`, keyed("groupExpand", model, field, fn));
}

/** `_read_group_expand_full`: every record of the comodel (its default order, active_test of the env). */
export const readGroupExpandFull: GroupExpandFn = async (env, _model, _values, _domain) => {
  throw new NotPorted("readGroupExpandFull needs the comodel: use readGroupExpandFullOn(comodel)");
};

export function readGroupExpandFullOn(comodel: string): GroupExpandFn {
  return (env) => env.model(comodel).search(TRUE);
}

/** fields_selection.py:215 `_default_group_expand`: one group per selection option, in definition order. */
export const selectionGroupExpand: GroupExpandFn = async (env, model, _values, _domain) => {
  throw new NotPorted(`selectionGroupExpand(${model}) must be bound to a field with selectionGroupExpandOf(field)`);
};

export function selectionGroupExpandOf(field: FieldDef): GroupExpandFn {
  return async () => (field.selection ?? []).map((s) => s.value);
}

function groupExpandOf(model: string, field: string): GroupExpandFn | null {
  return GROUP_EXPAND.get(`${model}.${field}`) ?? null;
}

/**
 * A field's group_expand that no file registered: the method gen/group_expand.py read from poc_erp's registry.
 * `_read_group_expand_full` and a selection's `_default_group_expand` are generic; any other method refuses (before
 * 2026-11-17 such a field was grouped without its empty groups: project.project's stage_id, which Settings > Project
 * Stages shows as kanban columns, and five more, src/models/group_expand_methods.ts). A field the file does not list
 * (a module beyond poc_erp's) keeps the old answer.
 */
function generatedExpandOf(model: string, field: FieldDef): GroupExpandFn | null {
  if (!field.groupExpand) return null;
  const kind = (GROUP_EXPAND_METHODS as Record<string, Record<string, string> | undefined>)[model]?.[field.name];
  if (kind === undefined) return null;
  if (kind === "full") {
    if (!field.relation) throw new NotPorted(`_read_group_expand_full on ${model}.${field.name} without a comodel`);
    return readGroupExpandFullOn(field.relation);
  }
  if (kind === "selection" || kind === "_default_group_expand") return selectionGroupExpandOf(field);
  throw new NotPorted(`group_expand ${kind} of ${model}.${field.name}`);
}

// --------------------------------------------------------------------------------------------------------------
// Raw _read_group fallback
// --------------------------------------------------------------------------------------------------------------

export interface RawReadGroupOptions {
  readonly offset?: number;
  readonly limit?: number | null;
  readonly order?: string | null;
  /** `having`: a domain over aggregates (models.py:2173-2200 `_read_group_having`) */
  readonly having?: unknown;
  /** internal: keep SQL NULLs (no postprocessing), for the having clause */
  readonly keepNull?: boolean;
  /**
   * internal: this groupby is one set of `_read_grouping_sets` (models.py:1677): Odoo's one GROUPING SETS query over
   * `all` specs in `order`, whose rows give the exact float aggregates (`odooGroupQuery`).
   */
  readonly groupingSets?: { readonly sets: readonly (readonly string[])[]; readonly all: readonly string[]; readonly order: string };
}

/** models.py:2180 SUPPORTED */
const HAVING_OPERATORS = ["in", "not in", "<", ">", "<=", ">=", "=", "!="];

type Tri = boolean | null;

/**
 * `_read_group_having` evaluated on the computed groups with SQL's three-valued logic: a NULL aggregate compares to
 * NULL, which the HAVING clause drops; the leaves are combined in prefix order, the remaining ones with AND. The right
 * side must be a number; anything else refuses.
 */
function havingFilter(having: readonly unknown[], valueOf: (spec: string) => unknown): Tri {
  const stack: Tri[] = [];
  const num = (v: unknown): number | null => (v === null ? null : typeof v === "number" ? v : isPyFloat(v) ? v.float : typeof v === "boolean" ? NaN : NaN);
  const and = (a: Tri, b: Tri): Tri => (a === false || b === false ? false : a === null || b === null ? null : true);
  const or = (a: Tri, b: Tri): Tri => (a === true || b === true ? true : a === null || b === null ? null : false);
  for (const item of [...having].reverse()) {
    if (item === "!") { const a = stack.pop() ?? null; stack.push(a === null ? null : !a); continue; }
    if (item === "&" || item === "|") {
      const a = stack.pop() ?? null, b = stack.pop() ?? null;
      stack.push(item === "&" ? and(a, b) : or(a, b));
      continue;
    }
    if (!Array.isArray(item) || item.length !== 3) throw new PyValueError(`Invalid having clause ${pyValueRepr(item)}: it should be a domain-like clause`);
    const [left, op, right] = item as [unknown, unknown, unknown];
    if (typeof op !== "string" || !HAVING_OPERATORS.includes(op)) {
      throw new PyValueError(`Invalid having clause ${pyValueRepr(item)}: supported comparators are ('in', 'not in', '<', '>', '<=', '>=', '=', '!=')`);
    }
    const v = num(valueOf(String(left)));
    if (Number.isNaN(v)) throw new NotPorted(`having on a non-numeric aggregate ${String(left)}`);
    // Odoo renders the list as `IN ARRAY[...]`, a syntax error of PostgreSQL whose text the port cannot reproduce
    if (op === "in" || op === "not in") throw new NotPorted(`having with ${op} (an SQL syntax error in Odoo)`);
    if (typeof right !== "number") throw new NotPorted(`having with the value ${JSON.stringify(right)}`);
    if (v === null) { stack.push(null); continue; }
    stack.push(op === "=" ? v === right : op === "!=" ? v !== right : op === "<" ? v < right : op === ">" ? v > right : op === "<=" ? v <= right : v >= right);
  }
  let r: Tri = stack.pop() ?? true;
  while (stack.length) r = and(r, stack.pop() ?? null);
  return r;
}

const TIME_GRANULARITIES: ReadonlySet<string> = new Set(["hour", "day", "week", "month", "quarter", "year"]);
/** odoo/odoo/orm/utils.py:35 READ_GROUP_NUMBER_GRANULARITY, all `date_part` (double precision, hence PyFloat). */
const NUMBER_GRANULARITIES: ReadonlySet<string> = new Set([
  "year_number", "quarter_number", "month_number", "iso_week_number", "day_of_year", "day_of_month", "day_of_week",
  "hour_number", "minute_number", "second_number",
]);
const AGGREGATES: ReadonlySet<string> = new Set([
  "sum", "avg", "max", "min", "bool_and", "bool_or", "array_agg", "array_agg_distinct", "count", "count_distinct",
]);

function fieldOf(def: ModelDef, fname: string, spec: string): FieldDef {
  const field = def.fields.get(fname);
  if (field === undefined) throw new PyValueError(`Invalid field ${pyRepr(fname)} on model ${pyRepr(def.name)} for ${pyRepr(spec)}.`);
  return field;
}

/**
 * The exact sum of numbers read from a `numeric` column (each the shortest decimal of the stored value), as
 * PostgreSQL's SUM(numeric) computes it, converted to the nearest float.
 */
function decimalSum(values: readonly number[]): number {
  const parts = values.map((v) => String(v));
  if (parts.some((p) => /e/i.test(p) || !Number.isFinite(Number(p)))) return values.reduce((x, y) => x + y, 0);
  const scale = Math.max(0, ...parts.map((p) => (p.includes(".") ? p.length - p.indexOf(".") - 1 : 0)));
  let total = 0n;
  for (const p of parts) {
    const neg = p.startsWith("-");
    const [i, f = ""] = (neg ? p.slice(1) : p).split(".");
    const n = BigInt(`${i}${f.padEnd(scale, "0")}`);
    total += neg ? -n : n;
  }
  const neg = total < 0n;
  const digits = (neg ? -total : total).toString().padStart(scale + 1, "0");
  const text = scale === 0 ? digits : `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
  return Number(`${neg ? "-" : ""}${text}`);
}

/**
 * Which aggregates PostgreSQL computes in a way the port's JS arithmetic does not reproduce: SUM and AVG over a float8
 * column (float8pl and float8_accum add in the plan's row order), AVG over a numeric or integer column (a numeric
 * division rounded at select_div_scale, then float()), sum_currency (numeric quotients).
 */
function exactKind(a: { field: FieldDef | null; func: string }): "float8" | "numeric_avg" | "currency" | null {
  const f = a.field;
  // SUM(amount / rate) in numeric: Postgres's quotients
  if (a.func === "sum_currency") return "currency";
  if (f === null || (a.func !== "sum" && a.func !== "avg")) return null;
  if (f.type === "float" && sqlColumnType(f) === "float8") return "float8";
  if (a.func === "avg" && (f.type === "integer" || f.type === "float" || f.type === "monetary")) return "numeric_avg";
  return null;
}

/** `v = m * 2**e` with m odd (0 for v = 0). */
function binaryParts(v: number): { m: bigint; e: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(v));
  const bits = view.getBigUint64(0);
  const exp = Number((bits >> 52n) & 0x7ffn);
  let m = bits & ((1n << 52n) - 1n);
  let e = -1074;
  if (exp !== 0) { m |= 1n << 52n; e = exp - 1075; }
  if (m === 0n) return { m, e: 0 };
  while ((m & 1n) === 0n) { m >>= 1n; e++; }
  return { m, e };
}

/**
 * Whether every partial sum of the values is exact whatever their order: all are multiples of 2**emin (the lowest bit
 * among them) and the sum of their magnitudes is at most 2**53 of those units, so no addition rounds. Then the JS sum
 * is PostgreSQL's float8 sum in any scan order.
 */
export function exactInAnyOrder(values: readonly number[]): boolean {
  if (values.some((v) => !Number.isFinite(v))) return false;
  const parts = values.filter((v) => v !== 0).map(binaryParts);
  if (parts.length === 0) return true;
  const emin = Math.min(...parts.map((p) => p.e));
  let units = 0n;
  for (const p of parts) units += p.m << BigInt(p.e - emin);
  return units <= 1n << 53n;
}

/**
 * The numeric aggregates of `pending` computed by PostgreSQL over the group's values, one query for all groups:
 * AVG(v) of a numeric or integer column, SUM(v / rate) of sum_currency (the rates as Odoo's UNNEST passes them,
 * res_currency.py:163-169). Each value is the shortest decimal of the float read() gave, which is the stored numeric
 * (as `decimalSum` assumes).
 */
async function exactAggregates(env: Environment, pending: readonly { row: unknown[]; index: number; values: string[]; rates?: string[] }[],
  groupColumns: number): Promise<void> {
  for (const withRates of [false, true]) {
    const items = pending.filter((p) => (p.rates !== undefined) === withRates);
    if (items.length === 0) continue;
    const g: number[] = [], v: string[] = [], r: string[] = [];
    items.forEach((p, i) => p.values.forEach((x, k) => { g.push(i); v.push(x); r.push(p.rates?.[k] ?? "1"); }));
    const rows = withRates
      ? await runSql<{ g: number; a: string | null }>(env, sql`SELECT g, SUM(v / r)::text AS a FROM unnest(${g}::int[], ${v}::numeric[], ${r}::numeric[]) AS t(g, v, r) GROUP BY g`)
      : await runSql<{ g: number; a: string | null }>(env, sql`SELECT g, AVG(v)::text AS a FROM unnest(${g}::int[], ${v}::numeric[]) AS t(g, v) GROUP BY g`);
    for (const row of rows) {
      const p = items[Number(row.g)]!;
      p.row[groupColumns + p.index] = row.a === null ? null : pyFloat(Number(row.a));
    }
  }
}

/** `_read_group_empty_value` (models.py:2294): the value of a NULL group or aggregate. */
export function readGroupEmptyValue(def: ModelDef, spec: string): unknown {
  if (spec === "__count") return 0;
  const [fname, , func] = parseReadGroupSpec(spec);
  if (func === "count" || func === "count_distinct") return 0;
  if (func === "array_agg" || func === "array_agg_distinct") return [];
  // relational fields give an empty recordset, which the formatters test with `if not value`: false here
  return false;
}

interface Column {
  readonly spec: string;
  readonly field: FieldDef;
  readonly granularity: string | null;
  /** A many2one path `field.sub` (models.py:2146-2151): the comodel's stored field through the LEFT JOIN. */
  readonly path?: { readonly sub: FieldDef; readonly table: string; values?: Map<number, unknown> };
}

/** The types of a path's last field grouped as their column (no translation, granularity or company dependency). */
const PATH_TYPES = new Set(["many2one", "selection", "char", "integer", "boolean"]);

/** The wall-clock value of a date/datetime read value for grouping (fields_temporal.py:87-92 tz conversion). */
function wallClock(value: unknown, field: FieldDef, tz: string | null): Naive | null {
  if (value === false || value === null || value === undefined) return null;
  if (typeof value !== "string") throw new NotPorted(`read() of ${field.name} returned ${JSON.stringify(value)} for a ${field.type}`);
  const n = parseNaive(value);
  if (n === null) throw new NotPorted(`unparseable ${field.type} ${value}`);
  if (field.type === "datetime" && tz !== null) return utcToLocal(new Date(Date.UTC(n.year, n.month - 1, n.day, n.hour, n.minute, n.second)), tz);
  return n;
}

/** `date_part(part, ts)` of fields_temporal.py:97 for the number granularities. */
function datePart(granularity: string, n: Naive, isDatetime: boolean): number {
  switch (granularity) {
    case "year_number": return n.year;
    case "quarter_number": return Math.floor((n.month - 1) / 3) + 1;
    case "month_number": return n.month;
    case "iso_week_number": return isoWeek(n.year, n.month, n.day)[1];
    case "day_of_year": return Math.floor((Date.UTC(n.year, n.month - 1, n.day) - Date.UTC(n.year, 0, 1)) / 86_400_000) + 1;
    case "day_of_month": return n.day;
    case "day_of_week": return new Date(Date.UTC(n.year, n.month - 1, n.day)).getUTCDay(); // Postgres dow: Sunday = 0
    case "hour_number": return isDatetime ? n.hour : 0;
    case "minute_number": return isDatetime ? n.minute : 0;
    case "second_number": return isDatetime ? n.second : 0;
    default: throw new PyValueError(`Invalid granularity in ${pyRepr(granularity)}`);
  }
}

function keyOf(v: unknown): string {
  return JSON.stringify(v);
}

type Comparator = (a: unknown[], b: unknown[]) => number;

/**
 * Strings order as the database's ORDER BY: the harness templates are created with LC_COLLATE "C"
 * (pg_database.datcollate of poc_corpus and poc_erp), i.e. by code point ("Albania" < "Åland Islands",
 * "Demo" < "board").
 */
/** The code-point order below is the database's only under LC_COLLATE "C"/"POSIX"; other collations refuse. */
/** Whether a database (its name and oid: a database's collation never changes) sorts text as C, kept by the isolate. */
const COLLATE_C = new Map<string, boolean>();

async function assertCollateC(env: Environment): Promise<void> {
  const ok = await envCache(env, "web.read_group.collate_c", async () => {
    // the request's first statement already read the database's oid (src/orm/signaling.ts)
    const oid = (await requestSequences(env.cr)).dboid;
    const key = oid ? `${env.cr.db}\u0000${oid}` : null;
    const kept = key === null ? undefined : COLLATE_C.get(key);
    if (kept !== undefined) return kept;
    const row = (await env.cr.query<{ c: string }>("SELECT datcollate AS c FROM pg_database WHERE datname = current_database()")).rows[0];
    const c = row !== undefined && (row.c === "C" || row.c === "POSIX");
    if (key !== null) {
      if (COLLATE_C.size >= 256) COLLATE_C.clear();
      COLLATE_C.set(key, c);
    }
    return c;
  });
  if (!ok) throw new NotPorted("read_group ordering of text groups under a collation other than C (the database's ORDER BY)");
}

function compareCollateC(a: string, b: string): number {
  const ca = Array.from(a), cb = Array.from(b);
  for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
    const d = (ca[i]!.codePointAt(0) ?? 0) - (cb[i]!.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return ca.length - cb.length;
}

function compareNatural(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (isPyFloat(a) && isPyFloat(b)) return a.float - b.float;
  if (typeof a === "string" && typeof b === "string") return compareCollateC(a, b);
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  throw new NotPorted(`ordering of mixed group values ${JSON.stringify(a)} / ${JSON.stringify(b)} (SQL ORDER BY belongs to the ORM, NEEDS.md)`);
}

/**
 * The rows of a query-backed model whose ids repeat, as `read(..., load="web")` would give the columns: stored columns
 * of simple types only, each row with its own position as id (aggregates on `id` refuse). NULL numbers are recorded in
 * `nulls` as the read path does.
 */
async function viewRows(env: Environment, def: ModelDef, domain: Domain, names: readonly string[],
  aggColumns: readonly { field: FieldDef | null; func: string }[], nulls: Map<string, Set<number>>): Promise<RecordValues[]> {
  if (aggColumns.some((a) => a.field?.name === "id")) throw new NotPorted(`read_group of ${def.name} with repeated ids aggregating id`);
  if (hooksOf(def.name).searchOverride || hooksOf(def.name).searchFetch) throw new NotPorted(`read_group of ${def.name} with repeated ids and its own _search`);
  const { searchQuery } = await import("../orm/sql");
  for (const n of names) {
    await checkFieldAccess(env, def, def.fields.get(n)!, "read");
  }
  const q = await searchQuery(env, def, domain, { limit: null, order: def.order });
  const cols = names.map((n) => {
    const f = def.fields.get(n)!;
    if (!f.column || !["many2one", "date", "selection", "char", "float", "integer", "monetary", "boolean"].includes(f.type)) {
      throw new NotPorted(`read_group of ${def.name} with repeated ids over ${f.type} field ${n}`);
    }
    return f.type === "date" ? sql`${ident(def.table)}.${ident(n)}::text AS ${ident(n)}` : sql`${ident(def.table)}.${ident(n)} AS ${ident(n)}`;
  });
  if (!cols.length) cols.push(sql`1 AS one`);
  const raw = await runSql<Record<string, unknown>>(env, q.select(...cols));
  for (const n of names) nulls.set(n, new Set());
  return raw.map((r, i) => {
    const out: RecordValues = { id: i + 1 };
    for (const n of names) {
      const f = def.fields.get(n)!;
      const v = r[n];
      if (v === null || v === undefined) {
        if (["float", "integer", "monetary"].includes(f.type)) nulls.get(n)!.add(i + 1);
        out[n] = f.type === "float" || f.type === "monetary" ? pyFloat(0) : f.type === "integer" ? 0 : false;
        continue;
      }
      out[n] = f.type === "float" || f.type === "monetary" ? pyFloat(Number(v)) : f.type === "integer" || f.type === "many2one" ? Number(v) : v;
    }
    return out;
  });
}

/** psycopg2's quoting of a parameter (`mogrify`): strings, numbers, booleans, NULL and lists as ARRAY[...]. */
function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new NotPorted(`SQL literal of ${v}`);
    return String(v);
  }
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  if (Array.isArray(v)) return v.length ? `ARRAY[${v.map(sqlLiteral).join(",")}]` : "'{}'";
  throw new NotPorted(`SQL literal of a ${typeof v}`);
}

/** The query with its $n parameters written in; a `$` inside a quoted literal or identifier is kept as it is. */
function inlineParams(text: string, values: readonly unknown[]): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      out += ch;
      if (ch === quote) quote = null; // a doubled quote closes and reopens: the same text either way
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    const m = ch === "$" ? /^\$(\d+)/.exec(text.slice(i)) : null;
    if (m) {
      const k = Number(m[1]) - 1;
      if (k < 0 || k >= values.length) throw new NotPorted(`SQL parameter $${m[1]}`);
      out += sqlLiteral(values[k]);
      i += m[0].length - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

const PG_AGGREGATES: Readonly<Record<string, string>> = { sum: "SUM", avg: "AVG", max: "MAX", min: "MIN", bool_and: "BOOL_AND", bool_or: "BOOL_OR", count: "COUNT" };

/** A group value as the SQL row gives it, in the form `groupValue` gives it (a timestamp from pg is a Date in UTC). */
function pgKeyValue(v: unknown, column: Column): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    const n: Naive = { year: v.getUTCFullYear(), month: v.getUTCMonth() + 1, day: v.getUTCDate(), hour: v.getUTCHours(), minute: v.getUTCMinutes(), second: v.getUTCSeconds() };
    return formatNaive(n, column.field.type === "datetime");
  }
  if (column.field.type === "many2one" || column.field.type === "integer") return Number(v);
  return v;
}

/**
 * The order of the groups as Odoo's own query gives it (models.py:2036-2066: `_search`, the GROUP BY of
 * `_read_group_groupby`, the aggregates of `_read_group_select`, the ORDER BY of `_read_group_orderby` with the
 * comodel's order columns added to the GROUP BY, LIMIT and OFFSET): groups an explicit order leaves equal come in
 * the order Postgres emits them (a HashAggregate's), which only the same query on the same rows reproduces. The
 * keys (JSON of the group values) in that order, or null for the shapes not built here (the JS order is kept).
 */
async function postgresGroupOrder(env: Environment, def: ModelDef, domain: Domain, columns: readonly Column[],
  aggColumns: readonly { spec: string; field: FieldDef | null; func: string }[], order: string, traverseMany2one: boolean,
  offset: number, limit: number | null): Promise<string[] | null> {
  return (await odooGroupQuery(env, def, domain, columns, aggColumns, order, traverseMany2one, offset, limit))?.keys ?? null;
}

/**
 * Odoo's own `_read_group` query (models.py:2036-2066, the one `postgresGroupOrder` describes; without a groupby no
 * GROUP BY and no ORDER BY): the group keys in the order Postgres emits them and the raw aggregate values per key
 * (float8 as a number, numeric and bigint as text), or null for the shapes not built here.
 */
async function odooGroupQuery(env: Environment, def: ModelDef, domain: Domain, columns: readonly Column[],
  aggColumns: readonly { spec: string; field: FieldDef | null; func: string; currencyField?: string }[], order: string, traverseMany2one: boolean,
  offset: number, limit: number | null,
  sets: { readonly sets: readonly (readonly string[])[]; readonly all: readonly Column[]; readonly order: string } | null = null,
): Promise<{ keys: string[]; aggs: Map<string, unknown[]> } | null> {
  // `_read_grouping_sets` (models.py:1830-1858): the columns of every set, the whole order (never empty with a
  // groupby, so many2ones are traversed), GROUP BY GROUPING SETS, no limit; the rows of this set by their GROUPING mask
  const own = columns;
  if (sets !== null) {
    columns = sets.all;
    order = sets.order;
    traverseMany2one = true;
    offset = 0;
    limit = null;
  }
  // a `_search` override changes Odoo's query; search_fetch overrides are not on `_read_group`'s way
  if (hooksOf(def.name).searchOverride) return null;
  const PLAIN = ["many2one", "selection", "char", "integer", "boolean", "date", "datetime"];
  for (const c of columns) {
    if (c.path || !PLAIN.includes(c.field.type) || !c.field.column || c.field.translate || c.field.companyDependent || !c.field.store) return null;
    if (c.granularity !== null && !TIME_GRANULARITIES.has(c.granularity)) return null;
  }
  for (const a of aggColumns) {
    if (a.func === "__count") continue;
    if (!a.field || a.field.companyDependent || (!(a.func in PG_AGGREGATES) && !["count_distinct", "array_agg", "array_agg_distinct", "sum_currency"].includes(a.func))) return null;
    // `table[fname]` (models.py:2121): a stored column, a compute_sql field or a related path of stored columns (their
    // joins are added as Odoo adds them, fields.py:776)
    const f = a.field;
    if (!(f.name === "id" || (f.store && f.column) || hooksOf(def.name).computeSql?.[f.name] !== undefined || (f.related && !f.store && relatedSqlPath(env, def, f)))) return null;
    if (a.func === "sum_currency" && a.currencyField === undefined) return null;
  }
  const { searchQuery } = await import("../orm/sql");
  const { orderToSql } = await import("../orm/order");
  const query = await searchQuery(env, def, domain, { limit: null });
  if (query.isEmpty()) return null;
  const table = query.table;
  const tz = isTimezone(env.context.tz) ? env.context.tz : null;
  const lang = await getLang(env);
  const literal = (v: string): string => `'${v.replace(/'/g, "''")}'`;
  const terms = new Map<string, ReturnType<typeof sql>>();
  for (const c of columns) {
    let expr = await table.field(c.field.name);
    if (c.field.type === "boolean") expr = sql`COALESCE(${expr}, FALSE)`;
    else if (c.field.type === "date" || c.field.type === "datetime") {
      // fields_temporal.py:85-116 `_generic_property_to_sql`
      if (c.field.type === "datetime" && tz) expr = sql`timezone(${raw(literal(tz))}, timezone('UTC', ${expr}))`;
      if (c.granularity === "week") {
        const firstWeekDay = lang.weekStart - 1;
        const interval = literal(`-${firstWeekDay && 7 - firstWeekDay} DAY`);
        expr = sql`(date_trunc('week', ${expr}::timestamp - INTERVAL ${raw(interval)}) + INTERVAL ${raw(interval)})`;
      } else {
        expr = sql`date_trunc(${raw(literal(c.granularity ?? ""))}, ${expr}::timestamp)`;
      }
      if (c.field.type === "date") expr = sql`${expr}::date`;
    }
    terms.set(c.spec, expr);
  }
  const aggSql: ReturnType<typeof sql>[] = [];
  for (const a of aggColumns) {
    if (a.func === "__count") { aggSql.push(raw("COUNT(*)")); continue; }
    if (a.func === "sum_currency") {
      // models.py:2107-2113 SUM(field / rate), the rate from res_currency.py:148-169 `_current_rate_sql`: 1.0, or a
      // LEFT JOIN LATERAL over UNNEST(currency ids, rates) (the lists as psycopg writes them: ARRAY[...] of reprs)
      const rates = await currentRates(env);
      let rateSql: ReturnType<typeof sql> = raw("1.0");
      if (rates.size > 0) {
        const alias = table.makeAlias(`${a.currencyField!}__rate`, def).alias;
        const cur = await table.field(a.currencyField!);
        const ids = `ARRAY[${[...rates.keys()].join(",")}]`;
        const values = `ARRAY[${[...rates.values()].map(pyFloatRepr).join(",")}]`;
        query.addJoin("LEFT JOIN LATERAL", alias, raw(`(SELECT * FROM UNNEST(${ids}, ${values}) AS v(currency_id, rate))`), sql`${ident(alias, "currency_id")} = ${cur}`);
        rateSql = sql`COALESCE(${ident(alias, "rate")}, 1.0)`;
      }
      aggSql.push(sql`SUM(${await table.field(a.field!.name)} / ${rateSql})`);
      continue;
    }
    const f = await table.field(a.field!.name);
    // models.py:329-342 READ_GROUP_AGGREGATE
    aggSql.push(a.func === "count_distinct" ? sql`COUNT(DISTINCT ${f})`
      : a.func === "array_agg" ? sql`ARRAY_AGG(${f} ORDER BY ${await table.field("id")})`
      : a.func === "array_agg_distinct" ? sql`ARRAY_AGG(DISTINCT ${f} ORDER BY ${f})`
      : sql`${raw(PG_AGGREGATES[a.func]!)}(${f})`);
  }
  // select_args are taken before `_read_group_orderby` widens a many2one's GROUP BY term (models.py:2057-2060)
  const selectTerms = new Map(terms);
  // models.py:2202-2292 `_read_group_orderby`
  const orderTerms = [];
  for (const part of columns.length && order.trim() !== "" ? order.split(",") : []) {
    const p = parseOrderPart(part, order, "_read_group()");
    const dir = raw(p.direction === "DESC" ? "DESC" : p.direction === "ASC" ? "ASC" : "");
    const nulls = raw(p.nulls);
    const gi = columns.findIndex((c) => c.spec === p.term);
    if (gi < 0) {
      const ai = aggColumns.findIndex((a) => a.spec === p.term);
      if (ai < 0) return null;
      orderTerms.push(sql`${aggSql[ai]!} ${dir} ${nulls}`);
      continue;
    }
    const column = columns[gi]!;
    if (traverseMany2one && column.field.type === "many2one" && env.reg.model(column.field.relation!).order !== "id") {
      const extra: ReturnType<typeof sql>[] = [];
      const o = await orderToSql(table, `${p.term} ${p.direction} ${p.nulls}`, false, new Set(), extra);
      if (!o.isEmpty()) {
        orderTerms.push(o);
        if (extra.length) terms.set(column.spec, Sql.join(", ", [terms.get(column.spec)!, ...extra]));
      }
    } else if (column.field.type === "selection") {
      const keys = (column.field.selection ?? []).map((x) => x.value);
      orderTerms.push(sql`array_position(${keys}::text[], ${terms.get(column.spec)!}::text) ${dir} ${nulls}`);
    } else {
      orderTerms.push(sql`${terms.get(column.spec)!} ${dir} ${nulls}`);
    }
  }
  // the output names are the port's (the plan does not depend on them)
  const selectCols = [...columns.map((c, i) => sql`${selectTerms.get(c.spec)!} AS ${ident(`k${i}`)}`), ...aggSql.map((a, i) => sql`${a} AS ${ident(`a${i}`)}`)];
  // the unique terms by their rendered text (psycopg's mogrify: one SQL text is one term)
  const text_ = (q: ReturnType<typeof sql>): string => { const r = q.render(); return inlineParams(r.text, r.values); };
  const uniqueTerms = (list: readonly ReturnType<typeof sql>[]): ReturnType<typeof sql>[] => {
    const seen = new Set<string>();
    return list.filter((t) => { const k = text_(t); if (seen.has(k)) return false; seen.add(k); return true; });
  };
  let mask = 0;
  if (sets !== null) {
    // GROUPING(a, b) of the select terms (models.py:1833-1838); bit i of the reversed unique terms is set when the
    // row's set lacks that term (:1873-1888)
    const grouping = columns.length ? sql`GROUPING(${Sql.join(", ", uniqueTerms(columns.map((c) => selectTerms.get(c.spec)!)))})` : raw("0");
    selectCols.unshift(sql`${grouping} AS ${ident("gmask")}`);
    const all = uniqueTerms([...columns.map((c) => terms.get(c.spec)!)].reverse()).map(text_);
    const mine = new Set(own.map((c) => text_(terms.get(c.spec)!)));
    all.forEach((t, i) => { if (!mine.has(t)) mask += 1 << i; });
  }
  let text = sql`SELECT ${Sql.join(", ", selectCols)} FROM ${query.fromClause()}`;
  if (query.where.length) text = sql`${text} WHERE ${query.whereClause()}`;
  if (sets !== null) {
    const byName = new Map(columns.map((c) => [c.spec, c]));
    const setSql = sets.sets.map((set) => sql`(${Sql.join(", ", uniqueTerms(set.map((spec) => terms.get(byName.get(spec)!.spec)!)))})`);
    text = sql`${text} GROUP BY GROUPING SETS (${Sql.join(", ", uniqueTerms(setSql))})`;
  } else if (columns.length) text = sql`${text} GROUP BY ${Sql.join(", ", columns.map((c) => terms.get(c.spec)!))}`;
  if (orderTerms.length) text = sql`${text} ORDER BY ${Sql.join(", ", orderTerms)}`;
  if (limit !== null) text = sql`${text} LIMIT ${raw(String(Math.trunc(limit)))}`;
  if (offset) text = sql`${text} OFFSET ${raw(String(Math.trunc(offset)))}`;
  // psycopg interpolates the parameters into the text (`cr.mogrify`): the same expression twice (a translated
  // name in the GROUP BY and the ORDER BY) is then one grouping term, as in Odoo's query
  const rendered = text.render();
  let rows = (await env.cr.query<Record<string, unknown>>(inlineParams(rendered.text, rendered.values))).rows;
  if (sets !== null) {
    rows = rows.filter((row) => Number(row["gmask"]) === mask);
    const keys = rows.map((row) => JSON.stringify(own.map((c) => pgKeyValue(row[`k${columns.findIndex((x) => x.spec === c.spec)}`], c))));
    return { keys, aggs: new Map(rows.map((row, r) => [keys[r]!, aggSql.map((_, i) => row[`a${i}`])])) };
  }
  const keys = rows.map((row) => JSON.stringify(columns.map((c, i) => pgKeyValue(row[`k${i}`], c))));
  return { keys, aggs: new Map(rows.map((row, r) => [keys[r]!, aggSql.map((_, i) => row[`a${i}`])])) };
}

/**
 * `_read_group` (models.py:1996) over `search` + `read`: rows of groupby values then aggregate values, NULLs already
 * replaced by `_read_group_empty_value` (relational groups are ids or false).
 */
export async function rawReadGroup(
  env: Environment,
  model: string,
  domain: Domain,
  groupby: readonly string[],
  aggregates: readonly string[],
  opts: RawReadGroupOptions = {},
): Promise<unknown[][]> {
  const def = env.reg.model(model);
  const having = opts.having;
  if (Array.isArray(having) && having.length) {
    if (!groupby.length) throw new NotPorted("read_group having without groupby (one row or none)");
    // the aggregates the clause uses (`_read_group_select`, which also validates them), after the requested ones
    const lefts = having.filter((i): i is unknown[] => Array.isArray(i) && i.length === 3).map((i) => String(i[0]));
    const all = [...aggregates, ...lefts.filter((l, k) => !aggregates.includes(l) && lefts.indexOf(l) === k)];
    const rows = await rawReadGroup(env, model, domain, groupby, all, { order: opts.order ?? null, keepNull: true });
    const kept = rows.filter((row) => havingFilter(having, (spec) => row[groupby.length + all.indexOf(spec)] ?? null) === true);
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? null;
    return kept.slice(offset, limit === null ? undefined : offset + limit).map((row) => row.slice(0, groupby.length + aggregates.length).map((v, i) => {
      const spec = i < groupby.length ? groupby[i] : aggregates[i - groupby.length];
      return v === null ? readGroupEmptyValue(def, spec ?? "") : v;
    }));
  } else if (having !== undefined && !Array.isArray(having)) throw new NotPorted(`having of type ${typeof having}`);
  if (model === "project.task" && groupby.includes("personal_stage_type_id")) {
    // project_task.py:2250-2261 `_read_group`: personal_stage_type_id (computed) groups as the many2many
    // personal_stage_type_ids (fields_relational.py:1706-1745: the join keeps the stages the comodel's _search allows)
    return rawReadGroup(env, model, domain, groupby.map((g) => (g === "personal_stage_type_id" ? "personal_stage_type_ids" : g)), aggregates,
      { ...opts, order: opts.order ? opts.order.replace(/\bpersonal_stage_type_id\b/g, "personal_stage_type_ids") : opts.order ?? null });
  }
  const ids = await env.model(model).search(domain);
  if (ids.length === 0) {
    if (groupby.length === 0) return [[...groupby, ...aggregates].map((spec) => readGroupEmptyValue(def, spec))];
    return [];
  }
  if (groupby.length === 0 && aggregates.length === 0) throw new PyValueError("Need groupby or aggregates.");

  // _read_group_groupby (models.py:2124)
  const toColumn = async (spec: string): Promise<Column> => {
    const [fname, chain, granularity] = parseReadGroupSpec(spec);
    const field = fieldOf(def, fname, spec);
    if (field.type === "properties") throw new NotPorted(`read_group on properties ${spec} (needs the SQL _read_group of the ORM)`);
    if (chain !== null) {
      if (field.type !== "many2one") throw new PyValueError(`Only many2one path is accepted for the ${pyRepr(spec)} groupby spec`);
      // models.py:2146-2151: `field.join(table)` and the comodel's own groupby of the rest
      if (chain.includes(".") || granularity !== null || field.relation === null) throw new NotPorted(`read_group on the many2one path ${spec} (several levels or a granularity)`);
      const co = env.reg.model(field.relation);
      const sub = co.fields.get(chain);
      if (sub === undefined || !sub.groupable) throw new PyValueError(`Invalid field ${pyRepr(chain)} on model ${pyRepr(co.name)}`);
      await checkFieldAccess(env, def, field, "read");
      if (!env.su) await checkModelAccess(env, co, "read");
      await checkFieldAccess(env, co, sub, "read");
      // a stored column, or a related field over stored many2ones (fields.py:672-689, the joins of `_field_to_sql`)
      const sqlable = sub.column || (sub.related && !sub.store && relatedSqlPath(env, co, sub));
      if (!sqlable || sub.translate || sub.companyDependent || !PATH_TYPES.has(sub.type) || tableQuery(env, co) !== null) {
        throw new NotPorted(`read_group on the many2one path ${spec} (a ${sub.type} that is not a plain column)`);
      }
      return { spec, field, granularity: null, path: { sub, table: co.table } };
    }
    if (field.type === "date" || field.type === "datetime") {
      if (granularity === null) throw new PyValueError(`Granularity not set on a date(time) field: ${pyRepr(spec)}`);
      if (!TIME_GRANULARITIES.has(granularity) && !NUMBER_GRANULARITIES.has(granularity)) {
        throw new PyValueError(`Error when processing the granularity ${granularity} is not supported.`);
      }
    } else if (granularity !== null) {
      throw new PyValueError(`Granularity set on a no-datetime field or property: ${pyRepr(spec)}`);
    }
    if (!field.groupable) throw new PyValueError(`Invalid field ${pyRepr(fname)} on model ${pyRepr(model)}`);
    return { spec, field, granularity };
  };
  const columns: Column[] = [];
  for (const g of groupby) columns.push(await toColumn(g));
  // _read_grouping_sets: Odoo's one query over every set's columns (the other sets' columns too)
  let sets: { sets: readonly (readonly string[])[]; all: Column[]; order: string } | null = null;
  if (opts.groupingSets) {
    const allCols: Column[] = [];
    for (const s of opts.groupingSets.all) allCols.push(await toColumn(s));
    sets = { sets: opts.groupingSets.sets, all: allCols, order: opts.groupingSets.order };
  }
  // _read_group_select (models.py:2087)
  const aggColumns = aggregates.map((spec): { spec: string; field: FieldDef | null; func: string; currencyField?: string } => {
    if (spec === "__count") return { spec, field: null, func: "__count" };
    const [fname, chain, func] = parseReadGroupSpec(spec);
    if (chain !== null) throw new PyValueError(`Invalid ${pyRepr(spec)}, this dot notation is not supported`);
    const field = fieldOf(def, fname, spec);
    if (func === null) throw new PyValueError(`Aggregate method is mandatory for ${pyRepr(fname)}`);
    if (func === "sum_currency") {
      // models.py:2107-2113: SUM(field / rate of its currency field), res_currency.py:148 _current_rate_sql
      if (field.type !== "monetary") throw new PyValueError(`Aggregator "sum_currency" only works on currency field for ${pyRepr(fname)}`);
      // fields_numeric.py:227 get_currency_field
      const currencyField = field.currencyField ?? (def.fields.has("currency_id") ? "currency_id" : def.fields.has("x_currency_id") ? "x_currency_id" : null);
      if (currencyField === null) throw new PyValueError(`Field ${pyRepr(fname)} has no currency field`);
      return { spec, field, func, currencyField };
    }
    if (!AGGREGATES.has(func)) throw new PyValueError(`Invalid aggregate method ${pyRepr(func)} for ${pyRepr(spec)}.`);
    // a company-dependent field aggregates its SQL expression (the company's value, else the fallback): the port's
    // aggregate over read() values gave False where Odoo gives 0.0 (credit_limit:avg)
    if (field.companyDependent) throw new NotPorted(`read_group aggregate of the company-dependent field ${model}.${fname}`);
    // stock_account stock_quant.py:67-78: `value:sum`/`value:sum_currency` of the non-stored valuation is
    // `id:recordset` (ARRAY_AGG ORDER BY id) summed in Python over `records.mapped('value')` (rådet runda 13, åtgärd 14);
    // the field's group (stock.group_stock_manager) is checked before (the port does not know whether Odoo's mapped does)
    if (model === "stock.quant" && fname === "value" && (func === "sum" || func === "sum_currency") && !field.store) {
      return { spec, field, func: "quant_value_sum" };
    }
    // `table[fname]` (models.py:2121): stored columns, or compute_sql fields (fields.py:1365)
    // fields.py:672-689, 1374-1376: a non-stored related field whose path is stored columns is SQL too
    if (fname !== "id" && !field.store && hooksOf(model).computeSql?.[fname] === undefined && !relatedSqlPath(env, def, field)) {
      throw new PyValueError(`Invalid field ${pyRepr(fname)} on model ${pyRepr(model)}`);
    }
    return { spec, field, func };
  });
  const rates = aggColumns.some((a) => a.func === "sum_currency") ? await currentRates(env) : null;
  if (aggColumns.some((a) => a.func === "quant_value_sum") && !env.su && !(await hasGroup(env, "stock.group_stock_manager"))) {
    throw new NotPorted("stock.quant value:sum for a user outside stock.group_stock_manager");
  }

  const fieldNames = new Set<string>();
  for (const c of columns) fieldNames.add(c.field.name);
  for (const a of aggColumns) {
    if (a.field !== null && a.field.name !== "id") fieldNames.add(a.field.name);
    if (a.currencyField !== undefined) fieldNames.add(a.currencyField);
  }
  // SQL views of reports may repeat an id over several rows (stock report_stock_quantity.py: one id per kind of row):
  // `_read_group` groups the rows of the query, so they are read as rows, not as records by id
  const repeated = new Set(ids).size !== ids.length;
  const nulls = new Map<string, Set<number>>();
  const rows = repeated ? await viewRows(env, def, domain, [...fieldNames], aggColumns, nulls)
    : fieldNames.size > 0 ? await env.model(model).read(ids, [...fieldNames], "web") : ids.map((id) => ({ id }));
  // read() gives 0.0 for a NULL number (convert_to_read), but SQL aggregates skip NULLs (AVG, MIN, MAX, COUNT):
  // the stored numeric columns of the aggregates are read raw to keep NULL apart from 0
  for (const a of repeated ? [] : aggColumns) {
    const f = a.field;
    if (f === null || f.name === "id" || !f.column || !["integer", "float", "monetary"].includes(f.type) || nulls.has(f.name)) continue;
    // a query-backed model (reports, src/orm/table_sql.ts) has no table: its `_table_query` is the FROM
    const r = await runSql<{ id: number }>(env, sql`SELECT id FROM ${tableQuery(env, def) ?? ident(def.table)} AS ${ident(def.table)} WHERE id = ANY(${[...ids]}::int[]) AND ${ident(f.name)} IS NULL`);
    nulls.set(f.name, new Set(r.map((x) => Number(x.id))));
  }

  // the paths' values by the many2one's id, filtered by the comodel's read record rules
  for (const c of columns) {
    if (!c.path) continue;
    const coIds = [...new Set(rows.map((r) => (r as RecordValues)[c.field.name]).filter((v): v is number => typeof v === "number"))];
    const allowedCoIds = !coIds.length || env.su
      ? coIds
      : await env.withContext({ ...env.context, active_test: false }).model(c.field.relation!).search(cond("id", "in", coIds));
    if (c.path.sub.column) {
      const found = allowedCoIds.length ? await runSql<{ id: number; v: unknown }>(env,
        sql`SELECT id, ${ident(c.path.sub.name)} AS v FROM ${ident(c.path.table)} WHERE id = ANY(${allowedCoIds}::int[])`) : [];
      c.path.values = new Map(found.map((r) => [Number(r.id), r.v]));
    } else {
      const su = env.sudo();
      const read = allowedCoIds.length ? await su.withContext({ ...su.context, active_test: false }).model(c.field.relation!).read(allowedCoIds, [c.path.sub.name], "web") : [];
      c.path.values = new Map(read.map((r) => [Number(r["id"]), r[c.path!.sub.name] === false ? null : r[c.path!.sub.name]]));
    }
  }

  const tz = isTimezone(env.context.tz) ? env.context.tz : null;
  const lang = await getLang(env);
  const firstWeekDay = lang.weekStart - 1; // fields_temporal.py:102, 0 = Monday
  const weekOffset = firstWeekDay !== 0 ? 7 - firstWeekDay : 0;

  const groupValue = (row: RecordValues, c: Column): unknown => {
    if (c.path) {
      const base = row[c.field.name];
      const pv = typeof base === "number" ? c.path.values?.get(base) ?? null : null;
      if (c.path.sub.type === "boolean") return pv === true; // COALESCE(x, FALSE)
      if (c.path.sub.type === "integer" || c.path.sub.type === "many2one") return pv === null || pv === undefined ? null : Number(pv);
      return pv === null || pv === undefined || pv === false ? null : pv;
    }
    const v = row[c.field.name];
    switch (c.field.type) {
      case "many2one":
        return typeof v === "number" ? v : null;
      case "many2many":
        // fields_relational.py:1706 join(only_ids=True): one row per linked co-record visible through
        // `comodel._search(codomain)` (read() applies the same active/access/domain filters), NULL without any
        return Array.isArray(v) && v.length ? v : null;
      case "boolean":
        return v === true; // COALESCE(x, FALSE) (models.py:2160)
      case "date":
      case "datetime": {
        const n = wallClock(v, c.field, tz);
        if (n === null) return null;
        const g = c.granularity ?? "";
        if (NUMBER_GRANULARITIES.has(g)) return pyFloat(datePart(g, n, c.field.type === "datetime"));
        if (!isGranularity(g)) throw new PyValueError(`Invalid granularity in ${pyRepr(c.spec)}`);
        return formatNaive(truncate(n, g, weekOffset), c.field.type === "datetime");
      }
      default:
        return v === false || v === null || v === undefined ? null : v;
    }
  };

  interface Group { key: unknown[]; rows: RecordValues[] }
  const groups = new Map<string, Group>();
  for (const row of rows) {
    // many2many columns duplicate the row once per linked record (the LEFT JOIN of models.py:2155)
    let keys: unknown[][] = [[]];
    for (const c of columns) {
      const v = groupValue(row, c);
      const options = c.field.type === "many2many" && Array.isArray(v) ? v : [v];
      keys = keys.flatMap((k) => options.map((o) => [...k, o]));
    }
    for (const key of keys) {
      const k = keyOf(key);
      const g = groups.get(k);
      if (g === undefined) groups.set(k, { key, rows: [row] });
      else g.rows.push(row);
    }
  }

  // _read_group_orderby (models.py:2202)
  const order = opts.order !== undefined && opts.order !== null && opts.order !== "" ? opts.order : groupby.join(",");
  const traverseMany2one = opts.order !== undefined && opts.order !== null && opts.order !== "";
  // SUM and AVG are PostgreSQL's: over a float8 column they add in the order the query's plan feeds the rows (not the
  // records' order: 4.95 or 4.950000000000001), an AVG over numeric or integer divides in numeric. They come from
  // Odoo's own query when the port builds it (`odooGroupQuery`, with Odoo's order, limit and offset: the same plan);
  // else from `exactInAnyOrder` or numeric arithmetic in Postgres (`exactAggregates` below); else the group refuses.
  // (Under `having` this is the inner call without the HAVING clause: the same scan, filtered after the aggregation.)
  const exactKinds = aggColumns.map((a) => exactKind(a));
  const pgExact = !repeated && exactKinds.some((k) => k !== null)
    ? await odooGroupQuery(env, def, domain, columns, aggColumns, order, traverseMany2one, opts.offset ?? 0, opts.limit ?? null, sets) : null;
  /** The rows with an aggregate the port could not take from Postgres nor prove: refused if they are returned. */
  const unproven = new Set<unknown[]>();
  /** Aggregates computed in Postgres from the group's values after the rows are built (numeric AVG, sum_currency). */
  const pending: { row: unknown[]; index: number; values: string[]; rates?: string[] }[] = [];
  let current: { row: unknown[]; index: number } = { row: [], index: 0 };

  const aggregate = (g: Group, a: { spec: string; field: FieldDef | null; func: string; currencyField?: string }): unknown => {
    const kind = exactKinds[current.index] ?? null;
    if (kind !== null && pgExact !== null) {
      const v = pgExact.aggs.get(JSON.stringify(g.key));
      if (v !== undefined) {
        const raw = v[current.index];
        return raw === null || raw === undefined ? null : pyFloat(Number(raw));
      }
      // outside Odoo's LIMIT/OFFSET: kept for the sort, refused if the port returns the group
      unproven.add(current.row);
    }
    if (a.field === null) return g.rows.length;
    const field = a.field;
    if (a.func === "quant_value_sum") {
      // `sum(records.mapped('value'))`: from int 0, in the records' id order
      let total = 0;
      for (const r of [...g.rows].sort((x, y) => Number(x["id"]) - Number(y["id"]))) {
        const v = r[field.name];
        total += typeof v === "number" ? v : isPyFloat(v) ? v.float : 0;
      }
      return pyFloat(total);
    }
    if (a.func === "sum_currency") {
      // SUM(value / COALESCE(rate, 1.0)): NULL values are skipped, all-NULL gives NULL
      const cf = a.currencyField ?? "";
      let total: number | null = null;
      const unitRate: number[] = [];
      let allUnit = true;
      for (const r of g.rows) {
        const v = r[field.name];
        if (v === false || v === null || v === undefined) continue;
        const n = typeof v === "number" ? v : isPyFloat(v) ? v.float : NaN;
        const cur = r[cf];
        const rate = typeof cur === "number" ? rates?.get(cur) ?? 1.0 : 1.0;
        if (rate !== 1) allUnit = false;
        unitRate.push(n);
        total = (total ?? 0) + n / rate;
      }
      // numeric / 1.0 stays exact in PostgreSQL: the sum of a numeric column is the exact decimal sum
      if (total !== null && allUnit && sqlColumnType(field) === "numeric") total = decimalSum(unitRate);
      else if (total !== null && sqlColumnType(field) === "numeric") {
        // SUM(amount / rate) in numeric (each quotient rounded at its division scale): computed by Postgres below
        const rs = g.rows.filter((r) => { const v = r[field.name]; return v !== false && v !== null && v !== undefined; }).map((r) => {
          const cur = r[cf];
          return String(typeof cur === "number" ? rates?.get(cur) ?? 1.0 : 1.0);
        });
        pending.push({ ...current, values: unitRate.map(String), rates: rs });
      }
      return total === null ? null : pyFloat(total);
    }
    const nullIds = nulls.get(field.name);
    const values = g.rows.filter((r) => !nullIds?.has(Number(r["id"]))).map((r) => r[field.name]).filter((v) => v !== false && v !== null && v !== undefined);
    const nums = (): number[] => values.map((v) => (typeof v === "number" ? v : isPyFloat(v) ? v.float : NaN));
    const isFloat = field.type === "float" || field.type === "monetary";
    switch (a.func) {
      case "count": return values.length;
      case "count_distinct": return new Set(values.map(keyOf)).size;
      case "sum": {
        if (values.length === 0) return null;
        // SUM over a numeric column is exact in PostgreSQL (the Decimal becomes a float only at the end)
        if (kind === "float8") {
          // float8pl from the first value: the same sum in any order when every partial sum is exact
          const n = nums();
          if (!exactInAnyOrder(n)) unproven.add(current.row);
          return pyFloat(n.slice(1).reduce((x, y) => x + y, n[0]!));
        }
        const s = sqlColumnType(field) === "numeric" ? decimalSum(nums()) : nums().reduce((x, y) => x + y, 0);
        return isFloat ? pyFloat(s) : s;
      }
      case "avg": {
        if (values.length === 0) return null;
        const n = nums();
        if (kind === "float8") {
          // float8_accum/float8_avg: Sx / N, Sx exact in any order (as for the sum)
          if (!exactInAnyOrder(n)) unproven.add(current.row);
          return pyFloat(n.slice(1).reduce((x, y) => x + y, n[0]!) / n.length);
        }
        // AVG over numeric or integer: a numeric division (select_div_scale), computed by Postgres below
        pending.push({ ...current, values: n.map(String) });
        return pyFloat(n.reduce((x, y) => x + y, 0) / n.length);
      }
      case "min":
      case "max": {
        if (values.length === 0) return null;
        const sorted = [...values].sort(compareNatural);
        return a.func === "min" ? sorted[0] : sorted[sorted.length - 1];
      }
      case "bool_and": return values.length === 0 ? null : values.every((v) => v === true);
      case "bool_or": return values.length === 0 ? null : values.some((v) => v === true);
      // ARRAY_AGG(expr ORDER BY id) (models.py:336)
      case "array_agg": return [...g.rows].sort((x, y) => Number(x["id"]) - Number(y["id"])).map((r) => (field.name === "id" ? r["id"] : r[field.name] === false ? null : r[field.name]));
      case "array_agg_distinct": {
        // ARRAY_AGG(DISTINCT expr ORDER BY expr) (models.py:337): sorted, NULL last
        const seen = new Set<string>();
        const distinct = g.rows.map((r) => (r[field.name] === false ? null : r[field.name])).filter((v) => {
          const k = keyOf(v);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        const nonNull = distinct.filter((v) => v !== null).sort(compareNatural);
        return distinct.includes(null) ? [...nonNull, null] : nonNull;
      }
      default: throw new PyValueError(`Invalid aggregate method ${pyRepr(a.func)} for ${pyRepr(a.spec)}.`);
    }
  };

  let result = [...groups.values()].map((g) => {
    const row: unknown[] = [...g.key];
    aggColumns.forEach((a, index) => {
      current = { row, index };
      row.push(aggregate(g, a));
    });
    return row;
  });
  await exactAggregates(env, pending, columns.length);

  const finish = (rows: unknown[][]): unknown[][] => {
    const bad = rows.find((r) => unproven.has(r));
    if (bad !== undefined) {
      const spec = aggColumns.find((a, i) => exactKinds[i] === "float8")?.spec ?? aggregates.join(", ");
      throw new NotPorted(`read_group of ${model} ${spec}: a float sum PostgreSQL adds in its plan's row order, and Odoo's query for it is not built here`);
    }
    return finishRows(def, groupby, aggregates, opts.keepNull, rows);
  };
  if (order !== "") {
    if (result.some((row) => row.some((v) => typeof v === "string"))) await assertCollateC(env);
    const comparators: Comparator[] = [];
    for (const part of order.split(",")) {
      const p = parseOrderPart(part, order, "_read_group()");
      const gi = groupby.indexOf(p.term);
      const nullsFirst = p.nulls === "NULLS FIRST" || (p.nulls === "" && p.direction === "DESC");
      const sign = p.direction === "DESC" ? -1 : 1;
      let rank: (row: unknown[]) => Promise<unknown> | unknown;
      if (gi < 0) {
        const ai = aggregates.indexOf(p.term);
        if (ai < 0) throw new NotPorted(`Order term ${pyRepr(part)} is not among the aggregates (SQL _read_group of the ORM, NEEDS.md)`);
        rank = (row) => row[groupby.length + ai];
      } else {
        const column = columns[gi];
        if (column === undefined) throw new Error("unreachable");
        const field = column.field;
        if (column.path) {
          // models.py:2246 `self._fields.get(term)` is None for a path: ordered by the raw expression
          rank = (row) => row[gi];
        } else if (traverseMany2one && field.type === "many2one" && field.relation !== null && env.reg.model(field.relation).order !== "id") {
          // `_order_to_sql` joins the comodel and orders by its `_order` (models.py:2241-2248)
          const idsInGroups = result.map((r) => r[gi]).filter((v): v is number => typeof v === "number");
          const ordered = await env.sudo().withContext({ ...env.context, active_test: false }).model(field.relation)
            .search(cond("id", "in", idsInGroups), { activeTest: false });
          const position = new Map<number, number>();
          ordered.forEach((id, i) => position.set(id, i));
          rank = (row) => (typeof row[gi] === "number" ? position.get(row[gi] as number) ?? null : null);
        } else if (field.type === "selection") {
          // array_position(keys, value) (models.py:2250-2252)
          const keys = (field.selection ?? []).map((s) => s.value);
          rank = (row) => {
            const i = keys.indexOf(String(row[gi]));
            return row[gi] === null || i < 0 ? null : i;
          };
        } else if (column.granularity === "day_of_week") {
          // models.py:2254-2274: mod(7 - first_week_day + dow, 7)
          const fwd = lang.weekStart;
          rank = (row) => {
            const v = row[gi];
            return isPyFloat(v) ? (((7 - fwd + v.float) % 7) + 7) % 7 : null;
          };
        } else {
          rank = (row) => row[gi];
        }
      }
      const ranks = new Map<unknown[], unknown>();
      for (const row of result) ranks.set(row, await rank(row));
      comparators.push((a, b) => {
        const ra = ranks.get(a) ?? null;
        const rb = ranks.get(b) ?? null;
        if (ra === null && rb === null) return 0;
        if (ra === null) return nullsFirst ? -1 : 1;
        if (rb === null) return nullsFirst ? 1 : -1;
        return sign * compareNatural(ra, rb);
      });
    }
    const compare = (a: unknown[], b: unknown[]): number => {
      for (const c of comparators) {
        const r = c(a, b);
        if (r !== 0) return r;
      }
      return 0;
    };
    result = [...result].sort(compare);
    // groups the order leaves equal: Postgres's order of Odoo's query (postgresGroupOrder), else the JS order
    // (not under `having`, whose HAVING clause the query here would lack: keepNull is its inner call)
    if (!repeated && !opts.keepNull && result.some((row, i) => i > 0 && compare(result[i - 1]!, row) === 0)) {
      const pgOrder = pgExact?.keys ?? await postgresGroupOrder(env, def, domain, columns, aggColumns, order, traverseMany2one, opts.offset ?? 0, opts.limit ?? null);
      if (pgOrder !== null) {
        const byKey = new Map(result.map((row) => [JSON.stringify(row.slice(0, columns.length)), row]));
        const ordered = pgOrder.map((k) => byKey.get(k));
        if (ordered.some((r) => r === undefined)) throw new NotPorted(`read_group of ${model}: the groups of the query and of the port differ`);
        result = ordered as unknown[][];
        return finish(result);
      }
    }
  }

  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? null;
  result = result.slice(offset, limit === null ? undefined : offset + limit);
  return finish(result);
}

/** The postprocessing of `rawReadGroup`'s rows. */
function finishRows(def: ModelDef, groupby: readonly string[], aggregates: readonly string[], keepNull: boolean | undefined, result: unknown[][]): unknown[][] {

  // postprocessing (models.py:2312-2373): NULL -> empty value
  if (keepNull) return result;
  return result.map((row) => row.map((v, i) => {
    const spec = i < groupby.length ? groupby[i] : aggregates[i - groupby.length];
    return v === null ? readGroupEmptyValue(def, spec ?? "") : v;
  }));
}

// --------------------------------------------------------------------------------------------------------------
// formatted_read_group (models.py:1022) and its helpers
// --------------------------------------------------------------------------------------------------------------

export type FormattedGroup = Record<string, unknown>;

/** `_web_read_group_field_expand` (models.py:1136). */
function fieldExpand(env: Environment, model: string, groupby: readonly string[]): { field: FieldDef; expand: GroupExpandFn } | null {
  const [first] = groupby;
  if (groupby.length !== 1 || first === undefined || !boolArg(env.context["read_group_expand"]) || first.includes(".")) return null;
  const fname = first.split(":")[0] ?? "";
  const field = env.reg.model(model).fields.get(fname);
  if (field === undefined) throw new PyValueError(`Invalid field ${pyRepr(fname)} on model ${pyRepr(model)}`);
  const expand = groupExpandOf(model, fname) ?? generatedExpandOf(model, field);
  return expand === null ? null : { field, expand };
}

/** `_web_read_group_expand` (models.py:1148): add the empty groups the field's group_expand method returns. */
async function webReadGroupExpand(
  env: Environment, model: string, domain: Domain, groups: unknown[][], groupbySpec: string, aggregates: readonly string[],
  order: string, expand: { field: FieldDef; expand: GroupExpandFn },
): Promise<unknown[][]> {
  const def = env.reg.model(model);
  const values = groups.map((g) => g[0]).filter((v) => v !== false && v !== null);
  let expandValues = await expand.expand(env, model, values, domain);
  if (order.toLowerCase().includes(`${groupbySpec} desc`)) expandValues = [...expandValues].reverse();
  const emptyAggregates = aggregates.map((spec) => readGroupEmptyValue(def, spec));
  const result = new Map<string, unknown[]>();
  for (const v of expandValues) result.set(keyOf(v), [v, ...emptyAggregates]);
  for (const g of groups) result.set(keyOf(g[0]), g);
  return [...result.values()];
}

type Formatter = (value: unknown) => Promise<[unknown, Domain]>;

/** `_web_read_group_groupby_formatter` (models.py:1385). */
async function groupbyFormatter(env: Environment, model: string, groupbySpec: string, values: readonly unknown[]): Promise<Formatter> {
  const def = env.reg.model(model);
  const fieldPath = groupbySpec.split(":")[0] ?? "";
  const [fieldName, remaining] = splitFirst(fieldPath, ".");
  const field = def.fields.get(fieldName);
  if (field === undefined) throw new PyValueError(`Invalid field ${pyRepr(fieldName)} on model ${pyRepr(model)}`);

  if (remaining !== null && field.type === "many2one") {
    // models.py:1394-1404 formatter_follow_many2one: the comodel's formatter of the rest, under `any`
    if (field.relation === null) throw new NotPorted(`relational ${fieldName} without comodel`);
    const sub = await groupbyFormatter(env, field.relation, groupbySpec.split(".").slice(1).join("."), values);
    return async (value) => {
      const [v, domain] = await sub(value);
      if (v === false || v === null) return [v === null ? false : v, or([cond(fieldName, "not any", []), cond(fieldName, "any", domain)])];
      return [v, cond(fieldName, "any", domain)];
    };
  }

  if (field.type === "many2many" || field.type === "many2one" || fieldName === "id") {
    const comodel = fieldName === "id" ? model : field.relation;
    if (comodel === null) throw new NotPorted(`relational ${fieldName} without comodel`);
    const ids = values.filter((v): v is number => typeof v === "number");
    const names = await env.sudo().model(comodel).displayName(ids); // `value.sudo().display_name`
    const isM2m = field.type === "many2many";
    return async (value) => {
      if (value === false || value === null) {
        // models.py:1412: (<many2many>, '=', False) would bypass ir.rule, hence 'not any'
        return [false, isM2m ? cond(fieldName, "not any", []) : cond(fieldName, "=", false)];
      }
      if (typeof value !== "number") throw new NotPorted(`group value ${JSON.stringify(value)} for ${fieldName}`);
      return [[value, names.get(value) ?? false], cond(fieldName, "=", value)];
    };
  }

  if (field.type === "date" || field.type === "datetime") {
    const granularity = groupbySpec.split(":")[1];
    if (granularity === undefined) throw new Error(`Granularity is missing in ${groupbySpec}`);
    if (TIME_GRANULARITIES.has(granularity)) {
      if (!isGranularity(granularity)) throw new Error("unreachable");
      const locale = await cldrLocale((await getLang(env)).code);
      const isDatetime = field.type === "datetime";
      const tz = isDatetime && isTimezone(env.context.tz) ? env.context.tz : null;
      return async (value) => {
        if (value === false || value === null) return [value === null ? false : value, cond(fieldName, "=", false)];
        if (typeof value !== "string") throw new NotPorted(`group value ${JSON.stringify(value)} for ${fieldName}`);
        const local = parseNaive(value);
        if (local === null) throw new NotPorted(`unparseable group value ${value}`);
        const localEnd = addInterval(local, granularity);
        // models.py:1437-1441: replace(tzinfo=tz).astimezone(UTC) for both bounds
        const start = tz === null ? formatNaive(local, isDatetime) : formatNaive(utcOf(localToUtc(local, tz)), true);
        const end = tz === null ? formatNaive(localEnd, isDatetime) : formatNaive(utcOf(localToUtc(localEnd, tz)), true);
        const label = formatGroupLabel(granularity, local, locale);
        return [[start, label], and([cond(fieldName, ">=", start), cond(fieldName, "<", end)])];
      };
    }
    if (NUMBER_GRANULARITIES.has(granularity)) {
      return async (value) => {
        // models.py:1466-1468: a NULL date number group returns a one-item list, which the caller fails to unpack
        if (value === false || value === null) throw new PyValueError("not enough values to unpack (expected 2, got 1)");
        return [value, cond(`${fieldName}.${granularity}`, "=", value)];
      };
    }
    throw new PyValueError(`${pyRepr(granularity)} isn't a valid granularity`);
  }

  if (field.type === "properties") throw new NotPorted(`groupby on properties ${groupbySpec}`);

  return async (value) => [value, cond(fieldName, "=", value)];
}

function utcOf(d: Date): Naive {
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(),
  };
}

function splitFirst(s: string, sep: string): [string, string | null] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + sep.length)];
}

/** `_web_read_group_format` (models.py:1342). */
async function webReadGroupFormat(
  env: Environment, model: string, groupby: readonly string[], aggregates: readonly string[], groups: unknown[][],
): Promise<FormattedGroup[]> {
  const result: FormattedGroup[] = groups.map(() => ({}));
  const extraDomains: Domain[][] = groups.map(() => []);
  if (groups.length === 0) return result;
  let col = 0;
  for (const spec of groupby) {
    const values = groups.map((g) => g[col]);
    const formatter = await groupbyFormatter(env, model, spec, values);
    for (let i = 0; i < groups.length; i++) {
      const [value, domain] = await formatter(values[i]);
      const group = result[i];
      if (group === undefined) throw new Error("unreachable");
      group[spec] = value;
      extraDomains[i]?.push(domain);
    }
    // models.py:1357: fold information only with read_group_expand on a relational field
    const expand = fieldExpand(env, model, groupby);
    if (expand !== null && (expand.field.type === "many2one" || expand.field.type === "many2many") && expand.field.relation !== null) {
      const comodelDef = env.reg.model(expand.field.relation);
      const foldName = "fold"; // BaseModel._fold_name (models.py:484); per-model overrides would come from gen/ (NEEDS.md)
      if (comodelDef.fields.has(foldName)) {
        const ids = values.filter((v): v is number => typeof v === "number");
        const folds = new Map<number, unknown>();
        for (const vals of await env.sudo().model(expand.field.relation).read(ids, [foldName], "web")) {
          if (typeof vals["id"] === "number") folds.set(vals["id"], vals[foldName]);
        }
        for (let i = 0; i < groups.length; i++) {
          const v = values[i];
          const group = result[i];
          if (group !== undefined) group["__fold"] = typeof v === "number" ? folds.get(v) ?? false : false;
        }
      }
    }
    col++;
  }
  for (let i = 0; i < result.length; i++) {
    const group = result[i];
    // models.py:1380 `list(Domain.AND(...) or [])`: the TRUE domain is falsy, hence []
    const extra = and(extraDomains[i] ?? []);
    if (group !== undefined) group["__extra_domain"] = extra.kind === "true" ? [] : toList(extra);
  }
  for (const spec of aggregates) {
    for (let i = 0; i < groups.length; i++) {
      const group = result[i];
      if (group !== undefined) group[spec] = groups[i]?.[col];
    }
    col++;
  }
  return result;
}

export async function formattedReadGroup(
  env: Environment,
  model: string,
  domain: Domain,
  groupbyIn: readonly string[] = [],
  aggregatesIn: readonly string[] = [],
  having: unknown = [],
  offset = 0,
  limit: number | null = null,
  orderIn: string | null = null,
  groupingSets?: RawReadGroupOptions["groupingSets"],
): Promise<FormattedGroup[]> {
  const groupby = [...groupbyIn];
  const aggregates = aggregatesIn.map((agg) => agg.replace(":recordset", ":array_agg"));
  const order = orderIn !== null && orderIn !== "" ? orderIn : groupby.join(", ");
  let groups = await rawReadGroup(env, model, domain, groupby, aggregates, { offset, limit, order, having, ...(groupingSets ? { groupingSets } : {}) });

  // models.py:1098-1109: expand only without offset and when the limit is not reached
  const expand = fieldExpand(env, model, groupby);
  const [first] = groupby;
  if (offset === 0 && (limit === null || limit === 0 || groups.length < limit) && expand !== null && first !== undefined) {
    const expanded = await webReadGroupExpand(env, model, domain, groups, first, aggregates, order, expand);
    if (limit === null || limit === 0 || expanded.length <= limit) groups = expanded;
  }

  const fillTemporal = env.context["fill_temporal"];
  if (groupby.length > 0 && (boolArg(fillTemporal) || isRecord(fillTemporal))) {
    if ((limit !== null && limit !== 0) || offset !== 0) throw new PyValueError("You cannot used fill_temporal with a limit or an offset");
    // _web_read_group_fill_temporal: only a date/datetime (or dated property) first groupby is filled; others
    // return the groups unchanged (web/models/models.py `if field.type not in ('date', 'datetime') ...: return groups`)
    const firstName = (groupby[0] ?? "").split(":")[0]?.split(".")[0] ?? "";
    const firstField = env.reg.model(model).fields.get(firstName);
    if (firstField !== undefined && (firstField.type === "date" || firstField.type === "datetime"
      || (firstField.type === "properties" && (groupby[0] ?? "").includes(":")))) {
      if (firstField.type === "properties") throw new NotPorted("fill_temporal on a property groupby");
      groups = await fillTemporalGroups(env, model, groupby, aggregates, groups, firstField, isRecord(fillTemporal) ? fillTemporal : {});
    }
  }
  return webReadGroupFormat(env, model, groupby, aggregates, groups);
}

/**
 * web/models/models.py `_web_read_group_fill_temporal`: the empty groups between the bounds (fill_from, fill_to,
 * min_groups) of a date(time) first groupby, at its granularity. Group values are wall-clock strings here (the
 * tz conversion is done by rawReadGroup), so the range steps in wall-clock time like date_utils.date_range.
 */
export const MAX_TEMPORAL_GROUPS = 5000;

export function parseStrictNaive(v: string): Naive | null {
  const n = parseNaive(v);
  if (n === null) return null;
  if (n.year < 1 || n.year > 9999 || n.month < 1 || n.month > 12 || n.day < 1 || n.day > 31) return null;
  if (n.hour < 0 || n.hour > 23 || n.minute < 0 || n.minute > 59 || n.second < 0 || n.second > 59) return null;
  const check = new Date(0);
  check.setUTCFullYear(n.year, n.month - 1, n.day);
  if (check.getUTCFullYear() !== n.year || check.getUTCMonth() + 1 !== n.month || check.getUTCDate() !== n.day) return null;
  return n;
}

export async function fillTemporalGroups(
  env: Environment, model: string, groupby: readonly string[], aggregates: readonly string[], groups: unknown[][],
  field: FieldDef, opts: Record<string, unknown>,
): Promise<unknown[][]> {
  const g = (groupby[0] ?? "").split(":")[1] ?? "";
  if (!isGranularity(g)) throw new NotPorted(`fill_temporal with granularity ${g}`);
  const isDatetime = field.type === "datetime";
  let daysOffset = 0;
  if (g === "week") {
    const firstWeekDay = (await getLang(env)).weekStart - 1; // int(get_lang(env).week_start) - 1
    daysOffset = firstWeekDay ? 7 - firstWeekDay : 0;
  }
  const bound = (v: unknown): string | null => {
    if (!v) return null;
    if (isDatetime) throw new NotPorted("fill_temporal bounds on a datetime groupby"); // date.replace(tzinfo=...)
    if (typeof v !== "string") throw new NotPorted(`fill_temporal bound ${JSON.stringify(v)}`);
    const n = parseStrictNaive(v);
    if (n === null) throw new PyValueError(`Invalid date ${v}`);
    // date_utils.start_of(value, granularity) - timedelta(days=days_offset)
    let start = truncate({ ...n, hour: 0, minute: 0, second: 0 }, g, 0);
    if (daysOffset) {
      const shifted = new Date(0);
      shifted.setUTCFullYear(start.year, start.month - 1, start.day - daysOffset);
      const sy = shifted.getUTCFullYear();
      if (sy < 1 || sy > 9999) throw new PyValueError(`Date out of range ${v}`);
      start = { year: sy, month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), hour: 0, minute: 0, second: 0 };
    }
    return formatNaive(start, false);
  };
  const existingVals = groups.map((r) => r[0]).filter((v): v is string => typeof v === "string" && v !== "").sort();
  let fillFrom = bound(opts["fill_from"]) ?? existingVals[0] ?? null;
  let fillTo = bound(opts["fill_to"]) ?? existingVals[existingVals.length - 1] ?? null;
  if (!fillTo && fillFrom) fillTo = fillFrom;
  else if (!fillFrom && fillTo) fillFrom = fillTo;
  if (!fillFrom || !fillTo) return groups;
  const step = (x: string, k: number): string => {
    let n = parseStrictNaive(x);
    if (n === null) throw new PyValueError(`Invalid date ${x}`);
    for (let i = 0; i < k; i++) {
      n = addInterval(n, g);
      if (n.year < 1 || n.year > 9999) throw new PyValueError("Date out of range");
    }
    return formatNaive(n, isDatetime);
  };
  const minGroups = typeof opts["min_groups"] === "number" ? opts["min_groups"] : 0;
  if (!Number.isFinite(minGroups)) throw new PyValueError("Invalid min_groups");
  if (minGroups > MAX_TEMPORAL_GROUPS) throw new PyValueError(`Too many temporal groups (max ${MAX_TEMPORAL_GROUPS})`);
  if (minGroups > 0) {
    const atLeast = step(fillFrom, Math.trunc(minGroups) - 1);
    if (atLeast > fillTo) fillTo = atLeast;
  }
  if (fillFrom > fillTo) return groups;
  const def = env.reg.model(model);
  const emptyItem = [...groupby.slice(1), ...aggregates].map((spec) => readGroupEmptyValue(def, spec));
  const required: string[] = [];
  for (let d = fillFrom; d <= fillTo;) {
    if (required.length >= MAX_TEMPORAL_GROUPS) {
      throw new PyValueError(`Too many temporal groups (max ${MAX_TEMPORAL_GROUPS})`);
    }
    required.push(d);
    if (d === fillTo) break;
    d = step(d, 1);
  }
  const existing = existingVals.length === 0 ? required : [...new Set([...existingVals, ...required])].sort();
  const mapped = new Map<unknown, unknown[][]>();
  for (const r of groups) mapped.set(r[0], [...(mapped.get(r[0]) ?? []), r]);
  const result: unknown[][] = [];
  for (const dt of existing) result.push(...(mapped.get(dt) ?? [[dt, ...emptyItem]]));
  result.push(...(mapped.get(false) ?? []));
  return result;
}

// --------------------------------------------------------------------------------------------------------------
// web_read_group (models.py:567)
// --------------------------------------------------------------------------------------------------------------

/** `_formatted_read_group_with_length` (models.py:721). */
async function formattedReadGroupWithLength(
  env: Environment, model: string, domain: Domain, groupby: readonly string[], aggregates: readonly string[],
  offset: number, limit: number | null, order: string | null,
): Promise<[FormattedGroup[], number]> {
  const groups = await formattedReadGroup(env, model, domain, groupby, aggregates, [], offset, limit, order);
  let length: number;
  if (groups.length === 0) length = 0;
  else if (limit !== null && limit !== 0 && groups.length === limit) {
    length = limit + (await rawReadGroup(env, model, domain, groupby, [], { offset: limit })).length;
  } else length = groups.length + offset;
  return [groups, length];
}

/** `_get_read_group_order` (models.py:777). */
export function getReadGroupOrder(def: ModelDef, dictOrder: ReadonlyMap<string, string>, groupbyIn: readonly string[], aggregates: readonly string[]): string {
  if (dictOrder.size === 0) return groupbyIn.join(", ");
  const groupby = [...groupbyIn];
  const orderSpec: string[] = [];
  for (const [fname, direction] of dictOrder) {
    if (fname === "__count") {
      orderSpec.push(`${fname} ${direction}`);
      continue;
    }
    const group = groupby.find((g) => fname === g || g.startsWith(`${fname}:`));
    if (group !== undefined) {
      groupby.splice(groupby.indexOf(group), 1);
      orderSpec.push(`${group} ${direction}`);
      continue;
    }
    const agg = aggregates.find((a) => a.startsWith(`${fname}:`));
    if (agg !== undefined) {
      orderSpec.push(`${agg} ${direction}`);
      continue;
    }
    const field = def.fields.get(fname);
    if (field !== undefined && field.aggregator !== null) orderSpec.push(`${fname}:${field.aggregator} ${direction}`);
  }
  return [...orderSpec, ...groupby].join(", ");
}

interface OpeningInfo {
  value: unknown;
  folded: boolean;
  offset: number;
  limit: number | null;
  progressbarDomain: unknown;
  groups: OpeningInfo[] | null;
}

function parseOpeningInfo(raw: unknown): OpeningInfo[] | null {
  if (raw === null || raw === undefined || raw === false) return null;
  if (!Array.isArray(raw)) throw new NotPorted(`opening_info of type ${typeof raw}`);
  return raw.map((item) => {
    if (!isRecord(item)) throw new NotPorted("opening_info item");
    return {
      value: item["value"],
      folded: boolArg(item["folded"]),
      offset: intArg(item["offset"], "opening_info.offset", 0),
      limit: optInt(item["limit"], "opening_info.limit"),
      progressbarDomain: item["progressbar_domain"],
      groups: parseOpeningInfo(item["groups"]),
    };
  });
}

interface RecordsOpening {
  domain: Domain;
  limit: number | null;
  offset: number;
  group: FormattedGroup;
}

/** `_open_groups` (models.py:804). */
async function openGroups(
  env: Environment, model: string,
  p: {
    recordsOpeningInfo: RecordsOpening[]; groups: FormattedGroup[]; domain: Domain; groupby: readonly string[];
    aggregates: readonly string[]; dictOrder: ReadonlyMap<string, string>; autoUnfold: boolean;
    openingInfo: OpeningInfo[] | null; unfoldReadDefaultLimit: number | null; parentOpeningInfo: OpeningInfo[] | null;
    parentGroupDomain: Domain;
  },
): Promise<void> {
  const def = env.reg.model(model);
  const maxOpened = optInt(env.context["max_number_opened_groups"], "max_number_opened_groups") || MAX_NUMBER_OPENED_GROUPS;
  const parentInfo = new Map<string, OpeningInfo>();
  for (const info of p.parentOpeningInfo ?? []) parentInfo.set(keyOf(info.value), info);
  const [groupbySpec, second] = p.groupby;
  if (groupbySpec === undefined) return;
  const fname = (groupbySpec.split(":")[0] ?? "").split(".")[0] ?? "";
  const field = def.fields.get(fname);
  if (field === undefined) throw new PyValueError(`Invalid field ${pyRepr(fname)} on model ${pyRepr(model)}`);
  const relational = field.type === "many2one" || field.type === "one2many" || field.type === "many2many";
  let nbOpened = 0;
  const lastLevel = p.groupby.length === 1;
  const readGroupOrder = lastLevel || second === undefined ? null : getReadGroupOrder(def, p.dictOrder, [second], p.aggregates);

  for (const group of p.groups) {
    const foldInfo = "__fold" in group;
    const fold = boolArg(group["__fold"]);
    delete group["__fold"];
    const groupbyValue = group[groupbySpec];
    // tuples (relational/date/property groups) carry the raw value first
    const rawValue = Array.isArray(groupbyValue) ? groupbyValue[0] : groupbyValue;

    let limit = p.unfoldReadDefaultLimit;
    let offset = 0;
    let progressbarDomain: unknown = null;
    let subgroupOpeningInfo: OpeningInfo[] | null = null;
    const info = parentInfo.get(keyOf(rawValue));
    if (p.openingInfo !== null && p.openingInfo.length > 0 && info !== undefined) {
      if (info.folded) continue;
      limit = info.limit;
      offset = info.offset;
      progressbarDomain = info.progressbarDomain;
      subgroupOpeningInfo = info.groups;
    } else if (
      (!p.autoUnfold && !foldInfo)
      || nbOpened >= maxOpened
      || fold
      || (relational && !boolArg(groupbyValue))
    ) {
      continue;
    }

    nbOpened++;
    const extra = parseDomain(group["__extra_domain"]);
    if (lastLevel) {
      let recordsDomain = and([p.parentGroupDomain, extra]);
      if (boolArg(progressbarDomain)) recordsDomain = and([recordsDomain, parseDomain(progressbarDomain)]);
      const count = group["__count"];
      if (offset !== 0 && typeof count === "number" && offset >= count) {
        group["__offset"] = 0;
        offset = 0;
      }
      p.recordsOpeningInfo.push({ domain: recordsDomain, limit, offset, group });
    } else {
      let subgroupDomain = p.parentGroupDomain;
      if (boolArg(group["__extra_domain"])) subgroupDomain = and([subgroupDomain, extra]);
      if (second === undefined) throw new Error("unreachable");
      const [subgroups, length] = await formattedReadGroupWithLength(
        env, model, and([subgroupDomain, p.domain]), [second], p.aggregates, offset, limit, readGroupOrder,
      );
      group["__groups"] = { groups: subgroups, length };
      await openGroups(env, model, {
        recordsOpeningInfo: p.recordsOpeningInfo, groups: subgroups, domain: p.domain, groupby: p.groupby.slice(1),
        aggregates: p.aggregates, dictOrder: p.dictOrder, autoUnfold: false, openingInfo: p.openingInfo,
        unfoldReadDefaultLimit: p.unfoldReadDefaultLimit, parentOpeningInfo: subgroupOpeningInfo, parentGroupDomain: subgroupDomain,
      });
    }
  }
}

/** `_add_groupby_values` (models.py:751). */
async function addGroupbyValues(
  env: Environment, model: string, groupbyReadSpecification: Readonly<Record<string, Specification>> | null,
  groupby: readonly string[], groups: FormattedGroup[],
): Promise<void> {
  if (groupbyReadSpecification === null) return;
  if (!groupby.some((g) => g in groupbyReadSpecification)) return;
  const def = env.reg.model(model);
  let current = groups;
  for (const spec of groupby) {
    const readSpec = groupbyReadSpecification[spec];
    if (readSpec !== undefined) {
      const field = def.fields.get(spec);
      if (field === undefined || field.relation === null) throw new Error("We can only read extra info from a relational field");
      const ids = current.map((g) => g[spec]).filter((v): v is [number, unknown] => Array.isArray(v) && typeof v[0] === "number").map((v) => v[0]);
      const read = await webRead(env, field.relation, ids, readSpec);
      const byId = new Map<number, RecordValues>();
      read.forEach((vals, i) => byId.set(ids[i] ?? -1, vals));
      for (const group of current) {
        const v = group[spec];
        group["__values"] = Array.isArray(v) && typeof v[0] === "number" ? byId.get(v[0]) : { id: false };
      }
    }
    const next: FormattedGroup[] = [];
    for (const group of current) {
      const sub = group["__groups"];
      if (isRecord(sub) && Array.isArray(sub["groups"])) for (const s of sub["groups"]) if (isRecord(s)) next.push(s);
    }
    current = next;
  }
}

export interface WebReadGroupArgs {
  domain: Domain;
  groupby: readonly string[];
  aggregates?: readonly string[];
  limit?: number | null;
  offset?: number;
  order?: string | null;
  autoUnfold?: boolean;
  openingInfo?: OpeningInfo[] | null;
  unfoldReadSpecification?: Specification | null;
  unfoldReadDefaultLimit?: number | null;
  groupbyReadSpecification?: Readonly<Record<string, Specification>> | null;
}

export async function webReadGroup(env0: Environment, model: string, a: WebReadGroupArgs): Promise<{ groups: FormattedGroup[]; length: number }> {
  const def = env0.reg.model(model);
  const groupby = a.groupby;
  if (groupby.length === 0) throw new PyValueError("Need at least one item to groupby");
  const aggregates = [...(a.aggregates ?? [])];
  if (!aggregates.includes("__count")) aggregates.push("__count");

  // models.py:647-652: a condition on the active field disables the active test
  let domain = a.domain;
  const activeName = def.activeName;
  if (activeName !== null && [...iterConditions(domain)].some((c) => c.path === activeName)) {
    domain = and([domain, cond(activeName, "in", [true, false])]);
  }

  const dictOrder = new Map<string, string>();
  const order = a.order ?? null;
  if (order !== null && order !== "") {
    for (const part of order.split(",")) {
      const p = parseOrderPart(part, order, "web_read_group()");
      const key = p.property !== null ? `${p.field}.${p.property}` : p.field;
      dictOrder.set(key, p.nulls !== "" ? `${p.direction} ${p.nulls}` : p.direction);
    }
  }

  const [first] = groupby;
  if (first === undefined) throw new Error("unreachable");
  const readGroupOrder = getReadGroupOrder(def, dictOrder, [first], aggregates);
  const env = env0.withContext({ ...env0.context, formatted_display_name: true } as Context);
  const limit = a.limit ?? null;
  const offset = a.offset ?? 0;
  const [groups, length] = await formattedReadGroupWithLength(env, model, domain, [first], aggregates, offset, limit, readGroupOrder);

  const recordsOpeningInfo: RecordsOpening[] = [];
  await openGroups(env, model, {
    recordsOpeningInfo, groups, domain, groupby, aggregates, dictOrder, autoUnfold: a.autoUnfold ?? false,
    openingInfo: a.openingInfo ?? null, unfoldReadDefaultLimit: a.unfoldReadDefaultLimit === undefined ? 80 : a.unfoldReadDefaultLimit,
    parentOpeningInfo: a.openingInfo ?? null, parentGroupDomain: TRUE,
  });

  if (recordsOpeningInfo.length > 0) {
    // models.py:689-702: order of the records inside the groups
    const orderSpecs: string[] = [];
    for (const [fname, direction] of dictOrder) {
      if (!groupby.includes(fname) && fname !== "__count") orderSpecs.push(`${fname} ${direction}`);
    }
    for (const orderStr of def.order.split(",")) {
      const fname = orderStr.trim().split(" ", 1)[0] ?? "";
      if (!dictOrder.has(fname) && !groupby.includes(fname)) orderSpecs.push(orderStr);
    }
    const orderSearches = orderSpecs.join(", ");
    const recordsets: number[][] = [];
    for (const sub of recordsOpeningInfo) {
      const count = sub.group["__count"];
      recordsets.push(boolArg(count)
        ? await env0.model(model).search(and([domain, sub.domain]), { order: orderSearches, limit: sub.limit, offset: sub.offset })
        : []);
    }
    const all: number[] = [];
    const seen = new Set<number>();
    for (const ids of recordsets) for (const id of ids) if (!seen.has(id)) { seen.add(id); all.push(id); }
    const read = await webRead(env0, model, all, a.unfoldReadSpecification ?? {});
    const mapped = new Map<number, RecordValues>();
    read.forEach((vals, i) => mapped.set(all[i] ?? -1, vals));
    recordsOpeningInfo.forEach((opening, i) => {
      opening.group["__records"] = (recordsets[i] ?? []).map((id) => mapped.get(id));
    });
  }

  await addGroupbyValues(env0, model, a.groupbyReadSpecification ?? null, groupby, groups);
  return { groups, length };
}

// --------------------------------------------------------------------------------------------------------------
// call_kw entries
// --------------------------------------------------------------------------------------------------------------

function stringList(v: unknown, what: string): string[] {
  if (v === null || v === undefined || v === false) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new NotPorted(`${what} must be a list of strings`);
  return v.map(String);
}

registerBaseMethod("web_read_group", async (env0, _ids, args, kwargs0, model) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const groupbyRaw = kwargs["groupby"] ?? args[1];
  if (!Array.isArray(groupbyRaw)) throw new NotPorted("web_read_group: groupby must be a list"); // Python: AssertionError
  let groupbyRead: Readonly<Record<string, Specification>> | null = null;
  const grs = kwargs["groupby_read_specification"];
  if (isRecord(grs)) {
    const out: Record<string, Specification> = {};
    for (const [k, v] of Object.entries(grs)) out[k] = parseSpecification(v, `groupby_read_specification.${k}`);
    groupbyRead = out;
  }
  const unfoldLimit = "unfold_read_default_limit" in kwargs ? optInt(kwargs["unfold_read_default_limit"], "unfold_read_default_limit") : 80;
  return webReadGroup(env, model, {
    domain: parseDomain(kwargs["domain"] ?? args[0]),
    groupby: stringList(groupbyRaw, "groupby"),
    aggregates: stringList(kwargs["aggregates"] ?? args[2], "aggregates"),
    limit: optInt(kwargs["limit"] ?? args[3], "limit"),
    offset: intArg(kwargs["offset"] ?? args[4], "offset", 0),
    order: optStr(kwargs["order"] ?? args[5], "order"),
    autoUnfold: boolArg(kwargs["auto_unfold"]),
    openingInfo: (() => {
      const info = parseOpeningInfo(kwargs["opening_info"]);
      // mail discuss_channel.py:2083-2108: grouped by category, the "None" group opens initially
      if (info === null && model === "discuss.channel" && groupbyRaw[0] === "discuss_category_id") {
        return [{ value: false, folded: false, offset: 0, limit: unfoldLimit, progressbarDomain: undefined, groups: null }];
      }
      return info;
    })(),
    unfoldReadSpecification: parseSpecification(kwargs["unfold_read_specification"], "unfold_read_specification"),
    unfoldReadDefaultLimit: unfoldLimit,
    groupbyReadSpecification: groupbyRead,
  });
}, { apiModel: true, readonly: true });

registerBaseMethod("formatted_read_group", async (env0, _ids, args, kwargs0, model) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  return formattedReadGroup(
    env, model,
    parseDomain(kwargs["domain"] ?? args[0]),
    stringList(kwargs["groupby"] ?? args[1], "groupby"),
    stringList(kwargs["aggregates"] ?? args[2], "aggregates"),
    kwargs["having"] ?? args[3] ?? [],
    intArg(kwargs["offset"] ?? args[4], "offset", 0),
    optInt(kwargs["limit"] ?? args[5], "limit"),
    optStr(kwargs["order"] ?? args[6], "order"),
  );
}, { apiModel: true, readonly: true });

// models.py:1932-1993 read_group (the public one of Odoo 20): `_read_group` rows as lists, records as ids
registerBaseMethod("read_group", async (env0, _ids, args, kwargs0, model) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  // CPython's argument binding of `read_group(self, domain, groupby=(), aggregates=(), having=(), offset=0, limit=None,
  // order=None)` (no **kwargs, and no model overrides it): the keywords in their order, then the positional count
  const params = ["domain", "groupby", "aggregates", "having", "offset", "limit", "order"];
  for (const k of Object.keys(kwargs)) {
    const i = params.indexOf(k);
    if (i < 0) throw new PyTypeError(`BaseModel.read_group() got an unexpected keyword argument '${k}'`);
    if (i < args.length) throw new PyTypeError(`BaseModel.read_group() got multiple values for argument '${k}'`);
  }
  if (args.length > params.length) throw new PyTypeError(`BaseModel.read_group() takes from 2 to 8 positional arguments but ${args.length + 1} were given`);
  const having = kwargs["having"] ?? args[3] ?? [];
  return rawReadGroup(env, model,
    parseDomain(kwargs["domain"] ?? args[0]),
    stringList(kwargs["groupby"] ?? args[1] ?? [], "groupby"),
    stringList(kwargs["aggregates"] ?? args[2] ?? [], "aggregates"),
    { offset: intArg(kwargs["offset"] ?? args[4], "offset", 0), limit: optInt(kwargs["limit"] ?? args[5], "limit"), order: optStr(kwargs["order"] ?? args[6], "order"), having });
}, { apiModel: true, readonly: true });

/** fields.py:672-689 `_compute_sql_related`: a related field whose every step is a stored column. */
function relatedSqlPath(env: Environment, def: ModelDef, field: FieldDef): boolean {
  if (!field.related || field.store) return false;
  let current: ModelDef | undefined = def;
  for (const seg of field.related.split(".")) {
    const f: FieldDef | undefined = current?.fields.get(seg);
    if (!f || !f.store || !f.column) return false;
    current = f.relation ? env.reg.models.get(f.relation) : undefined;
  }
  return true;
}
