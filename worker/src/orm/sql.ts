/**
 * SQL generation: `Sql` fragments (odoo/tools/sql.py SQL: text plus parameters, composed by splicing),
 * `Query`/`TableSQL` (odoo/odoo/orm/query.py), `Field.to_sql` and `condition_to_sql` per field type
 * (fields.py:1357, :1419; fields_textual.py:421, :449; fields_relational.py:463, :483, :845, :1205, :1766;
 * fields_misc.py:36; fields_binary.py:265), the FULL optimization level of domains (domains.py:998-1039 and the
 * FULL/DYNAMIC rules :1799-2030) and `BaseModel._search` (models.py:4852). Parameterized queries only: values are
 * never spliced into text, identifiers are validated.
 */
import { registryCached } from "./signaling";
import { AccessError, NotPorted, UserError } from "../errors";
import { accessDomain, checkModelAccess } from "./access";
import * as D from "./domain";
import { envCache, envTz, hasGroup, hasGroups } from "./env";
import { fieldFlushed } from "./flush_points";
import { hooksOf } from "./hooks";
import { tableQuery } from "./table_sql";
import { orderToSql } from "./order";
import { isRelativeDate, parseRelativeDate } from "./date_relative";
import type { Context, Domain, Environment, FieldDef, ModelDef } from "./types";
import { plainNumber } from "./values";
import { USERS_USER_WRITEABLE, usersWriteableKnown } from "./users_writeable";

type Cond = Extract<Domain, { kind: "cond" }>;

// --------------------------------------------------------------------------------------------------------------
// Sql fragments
// --------------------------------------------------------------------------------------------------------------

/** A fragment of SQL with its parameters; `?` marks a parameter position and is renumbered to `$n` when rendered. */
export class Sql {
  readonly text: string;
  readonly params: readonly unknown[];

  constructor(text: string, params: readonly unknown[] = []) {
    this.text = text;
    this.params = params;
  }

  isEmpty(): boolean {
    return this.text === "";
  }

  static join(separator: string, parts: readonly Sql[]): Sql {
    return new Sql(parts.map((p) => p.text).join(separator), parts.flatMap((p) => p.params));
  }

  /** Positional placeholders for node-postgres. */
  render(): { text: string; values: unknown[] } {
    let n = 0;
    const text = this.text.replace(/\?/g, () => `$${++n}`);
    if (n !== this.params.length) throw new TypeError(`SQL placeholder count ${n} does not match ${this.params.length} parameters`);
    return { text, values: [...this.params] };
  }
}

/** sql`...`: interpolated Sql fragments are spliced, anything else becomes a parameter. */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): Sql {
  let text = "";
  const params: unknown[] = [];
  strings.forEach((s, i) => {
    text += s;
    if (i < values.length) {
      const v = values[i];
      if (v instanceof Sql) {
        text += v.text;
        params.push(...v.params);
      } else {
        text += "?";
        params.push(v);
      }
    }
  });
  return new Sql(text, params);
}

export function raw(text: string): Sql {
  if (text.includes("?")) throw new TypeError(`raw SQL must not contain '?': ${text}`);
  return new Sql(text);
}

export function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new TypeError(`invalid SQL identifier ${name}`);
  return `"${name}"`;
}

export function ident(...names: string[]): Sql {
  return raw(names.map(quoteIdent).join("."));
}

/**
 * A statement whose answer the caller does not read (a write without RETURNING): sent without waiting when the cursor
 * may defer it (src/db.ts `Cursor.defer`; its error comes with a later statement), else run and waited for.
 */
export async function execute(env: Pick<Environment, "cr">, text: string, params: unknown[]): Promise<void> {
  const cr = env.cr;
  if (typeof cr.canDefer === "function" && cr.canDefer(text)) cr.defer(text, params);
  else await cr.query(text, params);
}

/**
 * `env.execute_query(sql)`. A write without RETURNING has no rows to give: it is sent without waiting for its answer
 * (src/db.ts `Cursor.defer`), so that it shares a round trip with the next statement; its error comes later.
 */
export async function runSql<R extends Record<string, unknown>>(env: Environment, s: Sql): Promise<R[]> {
  const { text, values } = s.render();
  const cr = env.cr;
  if (typeof cr.canDefer === "function" && cr.canDefer(text)) {
    cr.defer(text, values);
    return [];
  }
  const res = await cr.query<R>(text, values);
  return res.rows;
}

/** `_generate_table_alias` (query.py:31): `<alias>__<link>`, shortened like `make_identifier` when too long. */
function makeAliasName(src: string, link: string): string {
  const name = `${src}__${link}`;
  if (name.length <= 63) return name;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const suffix = h.toString(16);
  return `${name.slice(0, 63 - suffix.length - 1)}_${suffix}`;
}

interface Join { kind: "" | "JOIN" | "LEFT JOIN" | "LEFT JOIN LATERAL"; table: Sql; condition: Sql }

/** query.py:51 Query: FROM table, joins, where clauses, order, limit, offset and a possibly known result. */
export class Query {
  readonly model: ModelDef;
  readonly env: Environment;
  readonly alias: string;
  private readonly joins = new Map<string, Join>();
  readonly where: Sql[] = [];
  order: Sql | null = null;
  limit: number | null = null;
  offset: number | null = null;
  /** `Query._ids`: the result when it is already known (query.py:84). */
  resultIds: readonly number[] | null = null;

  constructor(model: ModelDef, env: Environment, alias?: string) {
    this.model = model;
    this.env = env;
    this.alias = alias ?? model.table;
    // models.py:531 `_table_sql`: a query-backed model (reports) is `(<query>) AS alias` (src/orm/table_sql.ts)
    this.joins.set(this.alias, { kind: "", table: tableQuery(env, model) ?? ident(model.table), condition: raw("") });
  }

  get table(): Table {
    return new Table(this.alias, this.model, this, this.env);
  }

  /** query.py:101 add_join: the same alias may be added again with the same definition. */
  addJoin(kind: "JOIN" | "LEFT JOIN" | "LEFT JOIN LATERAL", alias: string, table: Sql, condition: Sql): void {
    const entry = this.joins.get(alias);
    if (entry !== undefined) {
      const same = entry.table.text === table.text && entry.condition.text === condition.text;
      if (entry.kind === kind && same) return;
      if (kind !== "JOIN" || !same) throw new TypeError(`Cannot change the JOIN condition from ${alias}`);
    }
    this.joins.set(alias, { kind, table, condition });
    this.resultIds = null;
  }

  /** The join kind of an alias ('' for the FROM table), used by Many2one.join (fields_relational.py:575). */
  joinKind(alias: string): "" | "JOIN" | "LEFT JOIN" | "LEFT JOIN LATERAL" | undefined {
    return this.joins.get(alias)?.kind;
  }

  addWhere(clause: Sql): void {
    this.where.push(clause);
    this.resultIds = null;
  }

  /** query.py:198: known to return nothing. */
  isEmpty(): boolean {
    return this.resultIds !== null && this.resultIds.length === 0;
  }

  fromClause(): Sql {
    const parts: Sql[] = [];
    for (const [alias, join] of this.joins) {
      const from = join.table.text === quoteIdent(alias) ? join.table : sql`${join.table} AS ${ident(alias)}`;
      parts.push(join.kind === "" ? from : sql`${raw(join.kind)} ${from} ON (${join.condition})`);
    }
    return Sql.join(" ", parts);
  }

  whereClause(): Sql {
    return Sql.join(" AND ", this.where);
  }

  /** query.py:202 select. */
  select(...cols: Sql[]): Sql {
    const selectClause = cols.length > 0 ? Sql.join(", ", cols) : this.table.id;
    let s = sql`SELECT ${selectClause} FROM ${this.fromClause()}`;
    if (this.where.length > 0) s = sql`${s} WHERE ${this.whereClause()}`;
    if (this.order !== null && !this.order.isEmpty()) s = sql`${s} ORDER BY ${this.order}`;
    if (this.limit !== null) s = sql`${s} LIMIT ${raw(String(Math.trunc(this.limit)))}`;
    if (this.offset !== null && this.offset !== 0) s = sql`${s} OFFSET ${raw(String(Math.trunc(this.offset)))}`;
    return s;
  }

  /** query.py:219 subselect: known ids are injected directly, ORDER BY only with LIMIT/OFFSET. */
  subselect(...cols: Sql[]): Sql {
    if (this.resultIds !== null && cols.length === 0) {
      if (this.resultIds.length === 0) return raw("(SELECT 1 WHERE FALSE)");
      return sql`(${Sql.join(", ", this.resultIds.map((id) => sql`${id}`))})`;
    }
    if (this.limit !== null || (this.offset !== null && this.offset !== 0)) return sql`(${this.select(...cols)})`;
    const selectClause = cols.length > 0 ? Sql.join(", ", cols) : this.table.id;
    let s = sql`(SELECT ${selectClause} FROM ${this.fromClause()}`;
    if (this.where.length > 0) s = sql`${s} WHERE ${this.whereClause()}`;
    return sql`${s})`;
  }

  /** query.py:296 `__len__`: COUNT(*) honouring limit and offset. */
  countSql(): Sql {
    if (this.limit !== null || (this.offset !== null && this.offset !== 0)) {
      return sql`SELECT COUNT(*) AS count FROM (${this.select(raw("1 AS one"))}) t`;
    }
    return this.select(raw("COUNT(*) AS count"));
  }

  /** query.py:257 set_result_ids: a query that returns exactly `ids`, in order when asked. */
  setResultIds(ids: readonly number[], ordered: boolean): void {
    if (this.joins.size > 1 || this.where.length > 0 || this.limit !== null || this.offset !== null) {
      throw new TypeError("Method set_result_ids() can only be called on a virgin Query");
    }
    if (ids.length === 0) {
      this.where.push(raw("FALSE"));
    } else if (ordered) {
      const alias = makeAliasName(this.alias, "ids");
      this.joins.set(alias, {
        kind: "JOIN",
        table: sql`(SELECT * FROM unnest(${[...ids]}::int4[]) WITH ORDINALITY)`,
        condition: sql`${this.table.id} = ${ident(alias, "unnest")}`,
      });
      this.where.push(raw("1=1"));
      this.order = ident(alias, "ordinality");
    } else {
      this.where.push(sql`${this.table.id} IN (${Sql.join(", ", ids.map((id) => sql`${id}`))})`);
    }
    this.resultIds = ids;
  }
}

/** query.py:310 TableSQL: an alias of a table bound to a model and an environment. */
export class Table {
  readonly alias: string;
  readonly model: ModelDef;
  readonly query: Query;
  readonly env: Environment;

  constructor(alias: string, model: ModelDef, query: Query, env: Environment) {
    this.alias = alias;
    this.model = model;
    this.query = query;
    this.env = env;
  }

  get id(): Sql {
    return ident(this.alias, "id");
  }

  column(name: string): Sql {
    return ident(this.alias, name);
  }

  withEnv(env: Environment): Table {
    return new Table(this.alias, this.model, this.query, env);
  }

  sudo(): Table {
    return this.env.su ? this : this.withEnv(this.env.sudo());
  }

  makeAlias(link: string, model: ModelDef): Table {
    return new Table(makeAliasName(this.alias, link), model, this.query, this.env);
  }

  fieldDef(name: string): FieldDef {
    const field = this.model.fields.get(name);
    if (field === undefined) throw new D.PyValueError(`Invalid field ${D.pyRepr(name)} on model ${D.pyRepr(this.model.name)}`);
    return field;
  }

  /** `table[field_name]` -> `Field.to_sql(table)`. */
  field(name: string): Promise<Sql> {
    return fieldSql(this, this.fieldDef(name));
  }
}

// --------------------------------------------------------------------------------------------------------------
// Field access (models.py:2703-2790)
// --------------------------------------------------------------------------------------------------------------

/** `has_field_access(field, operation)` (models.py:2703, :2722). */
export async function hasFieldAccess(env: Environment, field: FieldDef): Promise<boolean> {
  if (env.su) return true;
  if (field.noAccess) return false; // groups == NO_ACCESS (models.py:2732)
  if (field.groups === null || field.groups.length === 0) return true;
  return hasGroups(env, field.groups.join(","));
}

/**
 * res.users `_has_field_access` (base res_users.py:652-661): writing a field needs the superuser, the group
 * base.group_erp_manager or a `user_writeable` field (the records are protected by record rules).
 */
async function usersFieldWriteAccess(env: Environment, model: ModelDef, field: FieldDef): Promise<boolean> {
  if (model.name !== "res.users" || env.su || USERS_USER_WRITEABLE.has(field.name)) return true;
  usersWriteableKnown(env);
  return hasGroup(env, "base.group_erp_manager");
}

/** `check_field_access(field, operation)` (models.py:2737): AccessError with Odoo's message (en_US). */
export async function checkFieldAccess(env: Environment, model: ModelDef, field: FieldDef, operation: "read" | "write"): Promise<void> {
  if (await hasFieldAccess(env, field) && (operation !== "write" || await usersFieldWriteAccess(env, model, field))) return;
  const lang = env.lang ?? "en_US";
  const description = model.descriptions[lang] ?? model.description;
  let message = `You do not have enough rights to access the field "${field.name}" on ${description} (${model.name}). `
    + `Please contact your system administrator.\n\nOperation: ${operation}`;
  // models.py:2771: `_has_group('base.group_no_one')` (membership only, no debug-mode rule)
  if (await hasGroup(env, "base.group_no_one")) {
    let allowed: string;
    if (field.noAccess) {
      allowed = "always forbidden";
    } else if (field.groups === null || field.groups.length === 0) {
      allowed = "custom field access rules";
    } else {
      const ids: number[] = [];
      for (const xmlid of field.groups) {
        const id = await env.reg.xmlid(env.cr, xmlid);
        if (id !== null) ids.push(id);
      }
      ids.sort((a, b) => a - b);
      const names = await env.sudo().model("res.groups").displayName(ids);
      allowed = `allowed for groups ${ids.map((id) => D.pyRepr(names.get(id) ?? "")).join(", ")}`;
    }
    message += `\nUser: ${env.uid}\nGroups: ${allowed}`;
  }
  throw new AccessError(message);
}

// --------------------------------------------------------------------------------------------------------------
// Field.to_sql (fields.py:1357) and friends
// --------------------------------------------------------------------------------------------------------------

/** `Field._column_type[0]`: the type identifier used in casts (fields.py:900 sql_column_type). */
export function sqlColumnType(field: FieldDef): string {
  switch (field.type) {
    case "boolean": return "bool";
    case "integer":
    case "many2one":
    case "many2one_reference": return "int4";
    case "float": return field.digits === null ? "float8" : "numeric"; // fields_numeric.py:129
    case "monetary": return "numeric";
    case "char":
    case "selection":
    case "reference": return "varchar";
    case "text":
    case "html": return "text";
    case "date": return "date";
    case "datetime": return "timestamp";
    case "json":
    case "properties":
    case "properties_definition": return "jsonb";
    case "binary":
    case "image": return "bytea";
    case "one2many":
    case "many2many": throw new TypeError(`${field.type} has no column type`);
    default: {
      const never: never = field.type;
      throw new TypeError(String(never));
    }
  }
}

/** `StoredTranslations.fallback_langs` (odoo/tools/translate.py:490) for `translate=True` fields. */
export function fallbackLangs(lang: string): string[] {
  return lang === "en_US" ? ["en_US"] : [lang, "en_US"];
}

/**
 * `Field.to_sql(table)` (fields.py:1357-1409), with the translated jsonb lookup (fields_textual.py:421-431) and the
 * company-dependent fallback (fields.py:1378-1407, fields_relational.py:463-475).
 */
export async function fieldSql(table: Table, field: FieldDef): Promise<Sql> {
  const env = table.env;
  await checkFieldAccess(env, table.model, field, "read"); // fields.py:1364
  if (field.name === "id") return table.id; // fields_misc.py:123
  // fields.py:1365-1370: compute_sql first (as superuser when compute_sudo)
  const computeSql = hooksOf(table.model.name).computeSql?.[field.name];
  if (computeSql !== undefined) return computeSql(field.computeSudo ? table.sudo() : table);
  if (!field.store || !field.column) {
    if (field.related !== null && !field.store) return relatedSql(table, field);
    if ((field.type === "binary" || field.type === "image") && field.attachment && field.store) {
      throw new NotPorted(`${table.model.name}.${field.name}: attachment binary in SQL (fields_binary.py:237)`);
    }
    throw new D.PyValueError(`Cannot convert ${table.model.name}.${field.name} to SQL because it is not stored`);
  }
  let s = table.column(field.name);
  fieldFlushed(env.cr, table.model.name, field.name, env.uid); // `execute_query` flushes the fields its SQL reads
  if (field.companyDependent) {
    const companyId = String(await env.company());
    const fallback = await companyDependentFallback(env, table.model, field);
    const columnType = ident(sqlColumnType(field));
    s = sql`COALESCE(${s}->(${companyId}::"varchar"),to_jsonb(${fallback}::${columnType}))`;
    if (field.type === "boolean" || field.type === "integer" || field.type === "float" || field.type === "monetary") {
      s = sql`(${s})::${columnType}`;
    } else {
      // the specified value for a company might be NULL e.g. '{"1": null}'::jsonb (fields.py:1403-1407)
      s = sql`(${s}->>0)::${columnType}`;
    }
    if (field.type === "many2one" && field.relation !== null) {
      // fields_relational.py:465: only ids that still exist
      const comodel = env.reg.model(field.relation);
      const coalias = makeAliasName(comodel.table, "exists");
      s = sql`(SELECT ${ident(coalias, "id")} FROM ${ident(comodel.table)} AS ${ident(coalias)} WHERE ${ident(coalias, "id")} = ${s})`;
    }
    return s;
  }
  if (field.translate && env.context.prefetch_langs !== true) {
    const lang = env.lang ?? "en_US"; // fields_textual.py:244 translation_lang
    const langs = fallbackLangs(lang).map((l) => sql`${s}->>${l}`);
    return langs.length === 1 ? (langs[0] as Sql) : sql`COALESCE(${Sql.join(", ", langs)})`;
  }
  return s;
}

/**
 * `Field._compute_sql_related` (fields.py:776): follow the related path through many2one joins. Related fields
 * are `compute_sudo` by default (fields.py:482), so the joins run as superuser.
 */
async function relatedSql(table: Table, field: FieldDef): Promise<Sql> {
  if (field.related === null) throw new TypeError(`${field.name} is not related`);
  let current = table.sudo();
  const parts = field.related.split(".");
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i] as string;
    const f = current.fieldDef(name);
    if (i === parts.length - 1) return fieldSql(current, f);
    if (f.type !== "many2one") {
      throw new D.PyValueError(`Invalid field property ${D.pyRepr(parts.slice(i + 1).join("."))} on ${current.model.name}.${f.name}`);
    }
    current = await joinMany2one(current, f);
  }
  throw new TypeError("unreachable");
}

/** `Many2one.join(table)` (fields_relational.py:550-583): LEFT JOIN (or JOIN for NOT NULL columns) on the comodel. */
export async function joinMany2one(table: Table, field: FieldDef, kind: "JOIN" | "LEFT JOIN" = "LEFT JOIN"): Promise<Table> {
  if (field.relation === null) throw new TypeError(`${field.name} has no comodel`);
  const env = table.env;
  const comodel = env.reg.model(field.relation);
  const canBeNull = !field.notNull;
  const delegate = table.model.inherits.get(field.relation) === field.name;
  let coalias: Table;
  let cotable: Sql | null;
  // related fields are compute_sudo; delegate links bypass access (fields_relational.py:557)
  if (delegate || env.su) {
    coalias = table.makeAlias(field.name, comodel);
    cotable = null;
  } else {
    const coquery = await searchQuery(env.withContext({ ...env.context, _generating_sql_for_fields: true }), comodel, D.TRUE, { activeTest: false });
    if (coquery.where.length === 0) {
      coalias = table.makeAlias(field.name, comodel);
      cotable = null;
    } else {
      coalias = table.makeAlias(`${field.name}__${env.uid}`, comodel);
      cotable = coquery.subselect(sql`${ident(coquery.alias)}.*`);
    }
  }
  let joinKind = kind;
  if (kind === "LEFT JOIN" && !canBeNull && cotable === null) {
    // [PERF] JOIN when the left reference is NOT NULL and the left table is the main table or JOINed itself
    const tableKind = table.query.joinKind(table.alias);
    if (tableKind === "" || tableKind === "JOIN") joinKind = "JOIN";
  }
  table.query.addJoin(joinKind, coalias.alias, cotable ?? tableQuery(table.env, comodel) ?? ident(comodel.table), sql`${await table.field(field.name)} = ${coalias.id}`);
  return coalias;
}

/**
 * `ir.default._get_model_defaults(model_name)` (ir_default.py:174-200) for user `uid` in company `company`: every default
 * of the model in one statement, the highest priority one per field. Odoo keeps the answer in an ormcache; here the
 * statement's text is the same for every field and caller, so the cursor's read cache (until ir_default is written) and
 * the isolate's cache of the registry tables (src/orm/signaling.ts, 'default') answer it again.
 */
export async function modelDefaults(env: Environment, model: string, uid: number, company: number): Promise<Map<string, unknown>> {
  const rows = (await env.cr.query<{ name: string; json_value: string }>(
    `SELECT f.name, d.json_value FROM ir_default d JOIN ir_model_fields f ON d.field_id = f.id
     WHERE f.model = $1 AND (d.user_id IS NULL OR d.user_id = $2) AND (d.company_id IS NULL OR d.company_id = $3)
       AND d.condition IS NULL ORDER BY d.user_id, d.company_id, d.id`, [model, uid, company])).rows;
  const out = new Map<string, unknown>();
  for (const r of rows) if (!out.has(r.name)) out.set(r.name, JSON.parse(r.json_value) as unknown);
  return out;
}

/**
 * `Field.get_company_dependent_fallback` (fields.py:914): the ir.default for the field as superuser in the current
 * company (`ir_default._get_model_defaults`, ir_default.py:174-200), converted to the column value.
 */
export async function companyDependentFallback(env: Environment, model: ModelDef, field: FieldDef): Promise<unknown> {
  const companyId = await env.company();
  // not kept in the environment's cache: ir.default's create/write/unlink clear Odoo's (ir_default.py:19
  // `_clear_cache_name`), and a chart loaded in the request sets its company's receivable and payable defaults; the
  // cursor's read cache answers the statement again until ir_default is written (src/db.ts)
  const fallback = (await modelDefaults(env, model.name, 1, companyId)).get(field.name);
  return valueToColumn(field, fallback === undefined ? null : fallback);
}

/** `Field.convert_to_column(value, validate=False)` per type, for SQL parameters. */
export function valueToColumn(field: FieldDef, rawValue: unknown): unknown {
  const value = plainNumber(rawValue);
  switch (field.type) {
    case "boolean": return !D.pyFalsy(value); // fields_misc.py:27
    case "integer":
    case "many2one_reference": {
      // fields_numeric.py:32 int(value or 0)
      if (D.pyFalsy(value)) return 0;
      if (typeof value === "number") return Math.trunc(value);
      if (typeof value === "string" && /^\s*-?\d+\s*$/.test(value)) return Number(value);
      throw new D.PyValueError(`invalid literal for int() with base 10: ${D.pyRepr(value)}`);
    }
    case "float":
    case "monetary": {
      if (D.pyFalsy(value)) return 0;
      if (typeof value === "number") return value;
      if (typeof value === "string" && !Number.isNaN(Number(value))) return Number(value);
      throw new D.PyValueError(`could not convert string to float: ${D.pyRepr(value)}`);
    }
    case "char":
    case "text":
    case "html":
    case "selection":
    case "reference":
      if (value === null || value === false || value === undefined) return null;
      return D.pyStr(value);
    case "date": {
      if (value === null || value === false || value === undefined) return null;
      if (value instanceof D.PyDateTime) return value.toDate().toString();
      if (value instanceof D.PyDate) return value.toString();
      if (typeof value === "string") return D.parseIsoDate(value.slice(0, 10)).toString();
      throw new D.PyValueError(`invalid date ${D.pyRepr(value)}`);
    }
    case "datetime": {
      if (value === null || value === false || value === undefined) return null;
      if (value instanceof D.PyDateTime) return value.toString();
      if (value instanceof D.PyDate) return `${value.toString()} 00:00:00`;
      if (typeof value === "string") {
        const parsed = D.parseIsoDate(value);
        return parsed instanceof D.PyDate ? `${parsed.toString()} 00:00:00` : parsed.toString();
      }
      throw new D.PyValueError(`invalid datetime ${D.pyRepr(value)}`);
    }
    case "many2one": {
      // fields_relational.py:323 `value or None`
      if (D.pyFalsy(value)) return null;
      if (typeof value === "number") return value;
      if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
      throw new NotPorted(`${field.name}: many2one value ${D.pyRepr(value)} in a domain`);
    }
    case "json":
    case "properties":
    case "properties_definition":
    case "binary":
    case "image":
    case "one2many":
    case "many2many":
      throw new NotPorted(`${field.name}: ${field.type} value in a domain`);
    default: {
      const never: never = field.type;
      throw new TypeError(String(never));
    }
  }
}

// --------------------------------------------------------------------------------------------------------------
// condition_to_sql (fields.py:1419 and the per-type overrides)
// --------------------------------------------------------------------------------------------------------------

const SQL_OPERATORS: Readonly<Record<string, string>> = {
  "=": " = ", "!=": " != ", "in": " IN ", "not in": " NOT IN ", "<": " < ", ">": " > ", "<=": " <= ", ">=": " >= ",
  "like": " LIKE ", "ilike": " ILIKE ", "=like": " LIKE ", "=ilike": " ILIKE ",
  "not like": " NOT LIKE ", "not ilike": " NOT ILIKE ", "not =like": " NOT LIKE ", "not =ilike": " NOT ILIKE ",
};

function operatorSql(op: string): Sql {
  const text = SQL_OPERATORS[op];
  if (text === undefined) throw new TypeError(`no SQL operator for ${op}`);
  return raw(text);
}

function unaccent(env: Environment, s: Sql): Sql {
  return env.reg.hasUnaccent ? sql`unaccent(${s})` : s; // registry.py:78, :346
}

function isNullish(v: unknown): boolean {
  return v === false || v === null || v === undefined;
}

/** `(field_expr, operator, value)!r` of a condition, as `DomainCondition._raise` (domains.py:951-954) prints it. */
function condRepr(c: Cond, optimized = false): string {
  const [path, op, value] = D.toList(c)[0] as [unknown, unknown, unknown];
  // after the basic optimizations `in`/`not in` hold an OrderedSet (domains.py `_optimize_in_set`), whose repr is
  // `OrderedSet([...])` (tools/misc.py:1049-1050); measured for the stored-field check (opus9_mc step 48)
  const v = optimized && (op === "in" || op === "not in") && Array.isArray(value) ? `OrderedSet(${D.pyRepr(value)})` : D.pyRepr(value);
  return `(${D.pyRepr(path)}, ${D.pyRepr(op)}, ${v})`;
}

/** `Domain._to_sql(table)` for an optimized domain (domains.py:548, :594, :699, :1171). */
export async function domainToSql(domain: Domain, table: Table): Promise<Sql> {
  switch (domain.kind) {
    case "true": return raw("TRUE");
    case "false": return raw("FALSE");
    case "not": return sql`(${await domainToSql(domain.arg, table)}) IS NOT TRUE`;
    case "and":
    case "or": {
      const parts: Sql[] = [];
      for (const child of domain.args) parts.push(await domainToSql(child, table));
      return sql`(${Sql.join(domain.kind === "and" ? " AND " : " OR ", parts)})`;
    }
    case "cond": return conditionToSql(table, domain);
    default: {
      const never: never = domain;
      throw new TypeError(String(never));
    }
  }
}

/** `field.condition_to_sql(table, field_expr, operator, value)` after `check_field_access` (domains.py:1180). */
export async function conditionToSql(table: Table, c: Cond): Promise<Sql> {
  if (!D.STANDARD_CONDITION_OPERATORS.has(c.op)) {
    throw new D.PyValueError(`Invalid operator ${D.pyRepr(c.op)} for SQL in domain term ${condRepr(c)}`);
  }
  const [fname, property] = D.parseFieldExpr(c.path);
  const field = table.fieldDef(fname);
  await checkFieldAccess(table.env, table.model, field, "read");
  const anyOps = ["any", "not any", "any!", "not any!"];
  if (field.type === "many2one" && anyOps.includes(c.op) && property === null) return many2oneAnyToSql(table, field, c);
  if (field.type === "one2many" || field.type === "many2many") return x2manyToSql(table, field, c);
  if ((field.type === "binary" || field.type === "image") && property === null) {
    // fields_binary.py:265-276: only existence checks
    const onlyFalse = (c.op === "in" || c.op === "not in") && Array.isArray(c.value) && c.value.length === 1 && isNullish(c.value[0]);
    if (field.attachment && onlyFalse) {
      return sql`${raw(c.op === "in" ? "NOT " : "")}EXISTS (SELECT 1 FROM ir_attachment WHERE res_model = ${table.model.name} AND res_field = ${field.name} AND res_id = ${table.id})`;
    }
    if (!(!field.attachment && onlyFalse)) throw new D.PyValueError("Binary field, accepts only existence check; skipping domain");
  }
  if (field.type === "boolean" && (c.op === "in" || c.op === "not in") && property === null) {
    // fields_misc.py:36-51
    if (!Array.isArray(c.value)) throw new D.PyValueError(`condition_to_sql() 'in' operator expects a collection, not a ${D.pyRepr(c.value)}`);
    const values = new Set(c.value.map((v) => !D.pyFalsy(v)));
    const possible = c.op === "in" ? values : new Set([true, false].filter((v) => !values.has(v)));
    if (possible.size !== 1) return raw(possible.size > 0 ? "TRUE" : "FALSE");
    const sqlField = await table.field(fname);
    return possible.has(true) ? sql`${sqlField} IS TRUE` : sql`${sqlField} IS NOT TRUE`;
  }
  return baseConditionToSql(table, field, c, property);
}

/** `Field._condition_to_sql` (fields.py:1432-1539). */
async function baseConditionToSql(table: Table, field: FieldDef, c: Cond, property: string | null): Promise<Sql> {
  let sqlField = await table.field(field.name);
  if (property !== null) sqlField = await propertyToSql(table, field, property);
  const toColumn = (v: unknown): unknown => (property === null ? valueToColumn(field, v) : v);
  const canBeNull = !field.notNull;
  const op = c.op;
  const value = c.value;
  const falsyValue = D.fieldFalsyValue(field);

  if (op === "in" || op === "not in") {
    if (!Array.isArray(value)) throw new D.PyValueError(`condition_to_sql() 'in' operator expects a collection, not a ${D.pyRepr(value)}`);
    let columnValues = value.filter((v) => !isNullish(v)).map(toColumn);
    let nullInCondition = columnValues.length < value.length;
    if (falsyValue !== undefined) {
      const nullValue = toColumn(falsyValue);
      if (columnValues.some((v) => v === nullValue)) nullInCondition = true;
      else if (nullInCondition) columnValues = [...columnValues, nullValue];
    }
    let s: Sql | null = null;
    if (columnValues.length > 0) {
      s = sql`${sqlField}${operatorSql(op)}(${Sql.join(", ", columnValues.map((v) => sql`${v}`))})`;
    }
    if ((op === "in") === nullInCondition) {
      // field in {val, False} => field IN vals OR field IS NULL; field not in {val} => field NOT IN vals OR field IS NULL
      if (!canBeNull) return s ?? raw("FALSE");
      const sqlNull = sql`${sqlField} IS NULL`;
      return s === null ? sqlNull : sql`(${s} OR ${sqlNull})`;
    }
    if (op === "not in" && nullInCondition && s === null) {
      return canBeNull ? sql`${sqlField} IS NOT NULL` : raw("TRUE");
    }
    if (s === null) throw new TypeError(`Missing sql query for ${op} ${D.pyRepr(value)}`);
    return s;
  }

  if (op.endsWith("like")) {
    const isText = field.type === "char" || field.type === "text" || field.type === "html"; // BaseString.is_text
    let sqlLeft = isText ? sqlField : sql`${sqlField}::text`;
    const needWildcard = !op.includes("=");
    let sqlValue = sql`${needWildcard ? `%${D.pyStr(value)}%` : D.pyStr(value)}`;
    if (op.endsWith("ilike")) {
      sqlLeft = unaccent(table.env, sqlLeft);
      sqlValue = unaccent(table.env, sqlValue);
    }
    let s = sql`${sqlLeft}${operatorSql(op)}${sqlValue}`;
    if (D.isNegativeOperator(op) && canBeNull) s = sql`(${s} OR ${sqlField} IS NULL)`;
    return s;
  }

  if (op === ">" || op === "<" || op === ">=" || op === "<=") {
    let acceptNull = false;
    let compared: unknown = value;
    if (falsyValue !== undefined) {
      // value = convert_to_cache(value) or null_value (fields.py:1511)
      const cached = toColumn(value);
      compared = D.pyFalsy(cached) ? falsyValue : cached;
      if (typeof compared === "number" || typeof compared === "boolean") {
        const n = Number(falsyValue);
        const v = Number(compared);
        acceptNull = canBeNull && (op === "<" ? n < v : op === ">" ? n > v : op === "<=" ? n <= v : n >= v);
      } else {
        // strings: Python compares lexicographically with '' (fields_textual.py:32)
        const s = String(compared);
        const f = String(falsyValue);
        acceptNull = canBeNull && (op === "<" ? f < s : op === ">" ? f > s : op === "<=" ? f <= s : f >= s);
      }
    }
    let s = sql`${sqlField}${operatorSql(op)}${toColumn(compared)}`;
    if (acceptNull) s = sql`(${s} OR ${sqlField} IS NULL)`;
    return s;
  }

  if (op === "any!" || op === "not any!") {
    // fields.py:1529: ('id', 'any!', Query)
    if (!(value instanceof D.SubQueryValue) || !(value.query instanceof Query)) {
      throw new D.PyTypeError(`condition_to_sql() operator 'any!' accepts SQL or Query, got ${D.pyRepr(value)}`);
    }
    return sql`${sqlField}${raw(op === "any!" ? " IN " : " NOT IN ")}${value.query.subselect()}`;
  }
  throw new D.PyValueError(`Invalid operator ${D.pyRepr(op)} for SQL in domain term ${condRepr(c)}`);
}

/** `Field.property_to_sql` (fields.py:1411): only many2one traversal is supported here (fields_relational.py:477). */
async function propertyToSql(table: Table, field: FieldDef, property: string): Promise<Sql> {
  if (field.type === "many2one") {
    const cotable = await joinMany2one(table, field);
    const [name, rest] = D.parseFieldExpr(property);
    const cofield = cotable.fieldDef(name);
    return rest === null ? fieldSql(cotable, cofield) : propertyToSql(cotable, cofield, rest);
  }
  // fields.py:1411-1417: the field classes without their own property_to_sql (all but Many2one, Date/Datetime,
  // Binary/Image and Properties) raise ValueError with the field's str (`model.name`)
  if (!["date", "datetime", "binary", "image", "properties"].includes(field.type)) {
    throw new D.PyValueError(`Invalid field property ${D.pyRepr(property)} on ${table.model.name}.${field.name}`);
  }
  throw new NotPorted(`field property ${D.pyRepr(property)} on ${table.model.name}.${field.name} (fields_temporal.py:95, fields_binary.py:250)`);
}

/** `Many2one.condition_to_sql` for 'any' (fields_relational.py:483-548), as `field IN (subselect)`. */
async function many2oneAnyToSql(table: Table, field: FieldDef, c: Cond): Promise<Sql> {
  if (field.relation === null) throw new TypeError(`${field.name} has no comodel`);
  const env = table.env;
  const comodel = env.reg.model(field.relation);
  const sqlField = await table.field(field.name);
  const canBeNull = !field.notNull;
  const bypass = c.op === "any!" || c.op === "not any!" || field.bypassSearchAccess;
  const positive = c.op === "any" || c.op === "any!";
  let subselect: Sql;
  if (D.isDomain(c.value)) {
    const query = await searchQuery(env, comodel, c.value, { activeTest: false, bypassAccess: bypass });
    subselect = query.subselect();
  } else if (c.value instanceof D.SubQueryValue && c.value.query instanceof Query) {
    subselect = c.value.query.subselect();
  } else {
    throw new D.PyTypeError(`condition_to_sql() 'any' operator accepts Domain, SQL or Query, got ${D.pyRepr(c.value)}`);
  }
  let s = sql`${sqlField}${raw(positive ? " IN " : " NOT IN ")}${subselect}`;
  if (canBeNull && !positive) s = sql`(${sqlField} IS NULL OR ${s})`;
  return s;
}

/** `_RelationalMulti.get_comodel_domain` + `One2many._additional_domain` (fields_relational.py:91, :971, :979). */
export function comodelDomain(env: Environment, model: ModelDef, field: FieldDef): Domain {
  let domain: Domain = D.TRUE;
  if (Array.isArray(field.domain)) domain = D.parseDomain(field.domain);
  if (field.type === "one2many" && field.relation !== null && field.relationField !== null) {
    const inverse = env.reg.model(field.relation).fields.get(field.relationField);
    if (inverse?.type === "many2one_reference" && inverse.modelField !== null) {
      domain = D.and([domain, D.cond(inverse.modelField, "=", model.name)]);
    }
  }
  return domain;
}

/** `_RelationalMulti.condition_to_sql` (fields_relational.py:845-889) and the EXISTS forms (:1205, :1766). */
async function x2manyToSql(table: Table, field: FieldDef, c: Cond): Promise<Sql> {
  if (c.path !== field.name) throw new TypeError("Supporting condition only to field");
  if (!field.store) throw new D.PyValueError(`Cannot convert ${table.model.name}.${field.name} to SQL because it is not stored`);
  if (field.relation === null) throw new TypeError(`${field.name} has no comodel`);
  const anyOps = ["any", "not any", "any!", "not any!"];
  if (!anyOps.includes(c.op)) throw new TypeError(`Relational field ${field.name} expects 'any' operator`);
  const env = table.env;
  const comodelEnv = env.withContext({ ...env.context, ...field.context });
  const comodel = env.reg.model(field.relation);
  const exists = c.op === "any" || c.op === "any!";
  const fieldDomain = comodelDomain(env, table.model, field);
  let query: Query;
  if (D.isDomain(c.value)) {
    let domain = D.and([c.value, fieldDomain]);
    const bypass = field.bypassSearchAccess || c.op === "any!" || c.op === "not any!";
    if (field.type === "one2many" && field.relationField !== null) {
      // if the inverse is a column, already make sure it's set (fields_relational.py:869-873)
      const inverse = comodel.fields.get(field.relationField);
      if (inverse?.column === true && !inverse.notNull) domain = D.and([domain, D.cond(inverse.name, "!=", false)]);
    }
    query = await searchQuery(comodelEnv, comodel, domain, { bypassAccess: bypass });
  } else if (c.value instanceof D.SubQueryValue && c.value.query instanceof Query) {
    query = c.value.query;
    if (fieldDomain.kind !== "true") {
      const optimized = await optimizeFull(fieldDomain, comodel, comodelEnv);
      if (optimized.kind !== "true") query.addWhere(await domainToSql(optimized, query.table.withEnv(comodelEnv)));
    }
  } else {
    throw new TypeError(`Unimplemented condition on ${field.name} for ${D.pyRepr(c.value)}`);
  }
  if (query.isEmpty()) return raw(exists ? "FALSE" : "TRUE");
  if (field.type === "one2many") {
    if (field.relationField === null) throw new TypeError(`${field.name} has no inverse`);
    const inverse = comodel.fields.get(field.relationField);
    if (inverse === undefined) throw new TypeError(`${field.name}: unknown inverse ${field.relationField}`);
    if (!inverse.store) {
      throw new NotPorted(`${table.model.name}.${field.name}: one2many with a non-stored inverse (fields_relational.py:1210)`);
    }
    const inverseSql = await query.table.withEnv(comodelEnv.sudo()).field(inverse.name);
    const subselect = query.subselect(sql`${inverseSql} AS __inverse`);
    return sql`${raw(exists ? "" : "NOT ")}EXISTS(SELECT FROM ${subselect} AS __sub WHERE __inverse = ${table.id})`;
  }
  if (field.relationTable === null || field.column1 === null || field.column2 === null) {
    throw new TypeError(`${field.name}: many2many without relation table`);
  }
  const rel = ident(field.relationTable);
  const relAlias = makeAliasName(table.alias, field.name);
  const col1 = ident(relAlias, field.column1);
  const col2 = ident(relAlias, field.column2);
  if (query.where.length === 0) {
    // no constraints on the comodel and we have foreign keys: just check the relation table
    return sql`${raw(exists ? "" : "NOT ")}EXISTS (SELECT 1 FROM ${rel} AS ${ident(relAlias)} WHERE ${col1} = ${table.id})`;
  }
  return sql`${raw(exists ? "" : "NOT ")}EXISTS (SELECT 1 FROM ${rel} AS ${ident(relAlias)} WHERE ${col1} = ${table.id} AND ${col2} IN ${query.subselect()})`;
}

// --------------------------------------------------------------------------------------------------------------
// FULL optimization (domains.py:461 optimize_full; _optimize_step at FULL, :998-1039)
// --------------------------------------------------------------------------------------------------------------

/**
 * `Domain.optimize_full(model)`: BASIC rules (domain.ts), then inherited fields, searchable fields (`search=`),
 * hierarchy and access operators, and the rewrites that need a database or an environment.
 */
export async function optimizeFull(domain: Domain, model: ModelDef, env: Environment): Promise<Domain> {
  const dmodel = D.domainModelOf(env.reg, model, await envTz(env));
  return optimizeFullNode(domain, model, env, dmodel);
}

async function optimizeFullNode(domain: Domain, model: ModelDef, env: Environment, dmodel: D.DomainModel): Promise<Domain> {
  switch (domain.kind) {
    case "true":
    case "false": return domain;
    case "not": {
      // `_optimize` walks the levels in order (domains.py:584-585): at BASIC the negation is pushed into the condition
      // (`!(x > 0)` becomes `x <= 0`), and only then does FULL run the field's search method on what is left
      const basic = D.optimizeBasic(domain, dmodel);
      if (basic.kind !== "not") return optimizeFullNode(basic, model, env, dmodel);
      return D.negate(await optimizeFullNode(basic.arg, model, env, dmodel), dmodel);
    }
    case "and":
    case "or": {
      // `_optimize` walks the levels in order: the n-ary BASIC step (sorting and merging the children, domain.ts)
      // comes before the children's DYNAMIC and FULL steps, after which the n-ary step sorts and merges again
      // (domains.py:671-702)
      const basic = D.optimizeBasic(domain, dmodel);
      if (basic.kind !== "and" && basic.kind !== "or") return optimizeFullNode(basic, model, env, dmodel);
      const kind = basic.kind;
      const optimized: Domain[] = [];
      for (const child of basic.args) optimized.push(await optimizeFullNode(child, model, env, dmodel));
      let children = D.flattenNary(kind, optimized);
      for (let i = 0; children.length > 1; i++) {
        if (i >= 1000) throw new RangeError("Domain.optimize: too many loops");
        const kept = new Set(children);
        const step = D.naryMerge(kind, children, dmodel);
        children = step.children;
        if (!step.merged) break;
        // a merge makes new conditions, which walk the levels; the children kept are optimized already
        const next: Domain[] = [];
        for (const c of children) next.push(kept.has(c) ? c : await optimizeFullNode(c, model, env, dmodel));
        children = D.flattenNary(kind, next);
      }
      return kind === "and" ? D.and(children) : D.or(children);
    }
    case "cond": {
      let current: Domain = domain;
      for (let i = 0; i < 1000; i++) {
        const basic = D.optimizeBasic(current, dmodel);
        if (basic.kind !== "cond") return optimizeFullNode(basic, model, env, dmodel);
        const next = await optimizeFullStep(basic, model, env, dmodel);
        if (D.equalDomains(next, basic)) return basic;
        if (next.kind !== "cond") return optimizeFullNode(next, model, env, dmodel);
        current = next;
      }
      throw new RangeError("Domain.optimize: too many loops");
    }
    default: {
      const never: never = domain;
      throw new TypeError(String(never));
    }
  }
}

async function optimizeFullStep(c: Cond, model: ModelDef, env: Environment, dmodel: D.DomainModel): Promise<Domain> {
  const [fname, property] = D.parseFieldExpr(c.path);
  const field = model.fields.get(fname);
  if (field === undefined) throw new D.PyValueError(`Invalid field ${model.name}.${fname} in condition ${condRepr(c)}`);

  // resolve inherited fields (domains.py:999-1006): `_inherits` implies delegate and bypass_search_access
  if (field.inheritedVia !== null) return D.cond(field.inheritedVia, "any", c);

  // DYNAMIC_VALUES (domains.py:1629, :1739): relative date strings of date/datetime conditions -> date_utils.parse_date
  if ((field.type === "date" || field.type === "datetime") && property === null && !c.path.includes(".")
    && ["in", "not in", ">", "<", "<=", ">="].includes(c.op)) {
    // on a datetime field the parsed value is made a datetime here (`_value_to_datetime`, :1641-1674: a date is
    // midnight in env.tz, in UTC) and keeps its operator: the date shift of an ISO date (`>` to `>=` the next day,
    // `_optimize_type_datetime` :1682-1716) does not apply, the relative string having passed that level as is. Before
    // round 11 the date went on and got the shift: `date_order > 'today -14d +1d'` started a day late (sv_pages, the
    // sales dashboard's previous period).
    const rel = async (v: unknown): Promise<unknown> => {
      if (!(typeof v === "string" && isRelativeDate(v))) return v;
      const parsed = await parseRelativeDate(env, v);
      if (field.type !== "datetime" || !(parsed instanceof D.PyDate)) return parsed;
      return parsed.year === 1 || parsed.year === 9999 ? new D.PyDateTime(parsed.ms) : D.localMidnightToUtc(parsed, await envTz(env));
    };
    if (typeof c.value === "string" && isRelativeDate(c.value)) c = { ...c, value: await rel(c.value) };
    else if (Array.isArray(c.value) && c.value.some((v) => typeof v === "string" && isRelativeDate(v))) {
      const vals: unknown[] = [];
      for (const v of c.value) vals.push(await rel(v));
      c = { ...c, value: vals };
    }
  }

  // DYNAMIC_VALUES (domains.py:1781 `_optimize_type_selection`): `field not in excl` becomes `field in incl` for a
  // field with a static selection (`_selection` is None for related fields and selection methods, where the
  // registry has no selection either); `not in [False]` stays
  if (field.type === "selection" && c.op === "not in" && !c.path.includes(".") && field.selection !== null
    && field.related === null && Array.isArray(c.value) && c.value.some((v) => !D.pyFalsy(v))) {
    const included = D.setMinus(D.orderedSet([...field.selection.map((s) => s.value), false]), c.value);
    return D.cond(c.path, "in", included);
  }

  // handle searchable fields (domains.py:1008-1019)
  if (hasSearchFunction(model, field) && property === null) {
    if (field.type === "boolean") {
      const tautology = D.booleanInAll(c);
      if (tautology.kind !== "cond") return tautology;
    }
    const searched = await fieldSearchMethod(c, model, field, env);
    const optimized = D.optimizeBasic(searched, dmodel);
    if (!D.equalDomains(optimized, c)) return optimized;
  }
  // domains.py:1021: compute_sql fields have an SQL representation
  if (!field.store && field.name !== "id" && hooksOf(model.name).computeSql?.[field.name] === undefined) {
    throw new D.PyValueError(`Field has no SQL representation because it is not stored in condition ${condRepr(c, true)}`);
  }

  // operator optimizations at FULL (and DYNAMIC) level
  switch (c.op) {
    case "child_of":
    case "parent_of":
      return hierarchyDomain(c, model, field, env);
    case "access":
      return accessOperatorDomain(c, model, field, env);
    case "any":
    case "not any":
      // domains.py:1968 `_optimize_any_with_rights`
      if (env.su || field.bypassSearchAccess) return D.cond(c.path, `${c.op}!`, c.value);
      return anyAtFull(c, field, env);
    case "any!":
    case "not any!":
      return anyAtFull(c, field, env);
    default:
      break;
  }

  // field type optimizations at FULL level
  if (field.type === "boolean") {
    const tautology = D.booleanInAll(c);
    if (tautology.kind !== "cond") return tautology;
  }
  if (field.type === "many2one") {
    const bypassed = m2oBypassComodelIdLookup(c);
    if (bypassed !== c) return bypassed;
  }
  if ((field.type === "one2many" || field.type === "many2many") && (c.op === "in" || c.op === "not in")) {
    return x2manyInOperator(c, field, env);
  }

  // final checks (domains.py:1036)
  if (!D.STANDARD_CONDITION_OPERATORS.has(c.op)) {
    throw new D.PyValueError(`Not standard operator left in condition ${condRepr(c)}`);
  }
  return c;
}

/** Whether the field has a `search=` function: display_name, non-stored related fields, computed fields with search. */
function hasSearchFunction(model: ModelDef, field: FieldDef): boolean {
  if (field.search) return true; // domains.py:1008 does not require compute/store.
  if (field.name === "display_name" && !field.store) return true;
  if (field.related !== null && !field.store) return field.searchable; // Field.setup_related (fields.py:690)
  if (!field.store) return (field.search ?? (field.compute && field.searchable)) || hooksOf(model.name).search?.[field.name] !== undefined;
  return false;
}

/** domains.py:1041 `_optimize_field_search_method`. */
async function fieldSearchMethod(c: Cond, model: ModelDef, field: FieldDef, env: Environment): Promise<Domain> {
  let searchEnv = env;
  const op = c.op;
  let value: unknown = c.value;
  if (!env.su) {
    if (op !== "any!" && op !== "not any!") await checkFieldAccess(env, model, field, "read");
    // related fields are compute_sudo (fields.py:482); computed fields are compute_sudo only when stored (:490)
    if (field.related !== null) searchEnv = env.sudo();
  }
  const anyOps = ["any", "not any", "any!", "not any!"];
  if (anyOps.includes(op) && D.isRelationalType(field.type) && D.isDomain(value) && field.related === null && field.relation !== null) {
    // domains.py:1051-1065: the sub-domain is searched on the comodel first
    const comodel = env.reg.model(field.relation);
    const comodelEnv = field.type === "many2one"
      ? env.withContext({ ...env.context, active_test: false })
      : env.withContext({ ...env.context, ...field.context });
    const query = await searchQuery(comodelEnv, comodel, value, { bypassAccess: op.includes("!") || field.bypassSearchAccess });
    value = D.cond("id", "any!", new D.SubQueryValue(query));
  }
  const determine = async (operator: string, v: unknown): Promise<Domain | null> => {
    if (field.name === "display_name" && field.related === null) return searchDisplayName(searchEnv, model, operator, v);
    if (field.related !== null) return searchRelated(model, field, operator, v, env);
    const hook = hooksOf(model.name).search?.[field.name];
    if (hook === undefined) {
      throw new NotPorted(`${model.name}.${field.name}: search function of a computed field (register hooks.search)`);
    }
    return hook(searchEnv, operator, v);
  };
  let result = await determine(op, value);
  if (result !== null) return result;
  // try with the positive operator (domains.py:1078)
  const inverse = D.isNegativeOperator(op) ? (D.NEGATIVE_CONDITION_OPERATORS[op] ?? null) : inverseOf(op);
  if (inverse !== null) {
    result = await determine(inverse, value);
    if (result !== null) return D.not(result);
  }
  // compatibility for '=' and '!=' (domains.py:1101)
  if ((op === "in" || op === "not in") && Array.isArray(value)) {
    const parts: Domain[] = [];
    for (const v of value) {
      const d = await determine(op === "in" ? "=" : "!=", v);
      if (d === null) break;
      parts.push(d);
    }
    if (parts.length === value.length) return op === "in" ? D.or(parts) : D.and(parts);
  }
  const lang = env.lang ?? "en_US";
  throw new UserError(
    `Unsupported operator on ${field.strings[lang] ?? field.string} ${D.pyRepr(model.descriptions[lang] ?? model.description)} (${model.name}) in ${D.pyRepr(D.toList(c))}`);
}

function inverseOf(op: string): string | null {
  for (const [neg, pos] of Object.entries(D.NEGATIVE_CONDITION_OPERATORS)) if (pos === op) return neg;
  return null;
}

/** `Field._search_related` (fields.py:815-851); null stands for NotImplemented. */
function searchRelated(model: ModelDef, field: FieldDef, operator: string, value: unknown, env: Environment): Domain | null {
  if (field.related === null) throw new TypeError(`${field.name} is not related`);
  const falsy = D.fieldFalsyValue(field);
  const isNull = (v: unknown): boolean => v === false || v === null || (falsy !== undefined && D.equalValues(v, falsy));
  const valueIsNull = Array.isArray(value) ? value.some(isNull) : isNull(value);
  const negative = D.isNegativeOperator(operator);
  const canBeNull = !negative === valueIsNull;
  if (negative && !valueIsNull) return null; // NotImplemented: called back with the positive operator
  const seq: FieldDef[] = [];
  let current: ModelDef | null = model;
  for (const fname of field.related.split(".")) {
    if (current === null) throw new TypeError(`${field.name}: related path through a non-relational field`);
    const f: FieldDef | undefined = current.fields.get(fname);
    if (f === undefined) throw new TypeError(`${field.name}: unknown related field ${fname}`);
    seq.push(f);
    current = f.relation === null || !D.isRelationalType(f.type) ? null : env.reg.model(f.relation);
  }
  const last = seq[seq.length - 1] as FieldDef;
  let domain = D.cond(last.name, operator, value);
  for (const f of seq.slice(0, -1).reverse()) {
    // related fields are compute_sudo (fields.py:482): 'any!'
    domain = D.cond(f.name, "any!", domain);
    if (canBeNull && f.type === "many2one" && !f.required) domain = D.or([domain, D.cond(f.name, "=", false)]);
  }
  return domain;
}

/**
 * `_search_display_name` (models.py:1521-1572) or the model's override (hooks.searchDisplayName, e.g.
 * res_partner.py:258 for categories, res_users.py:771).
 */
export async function searchDisplayName(env: Environment, model: ModelDef, operator: string, value: unknown): Promise<Domain | null> {
  const hook = hooksOf(model.name).searchDisplayName;
  if (hook !== undefined) return hook(env, operator, value);
  return searchDisplayNameDefault(env, model, operator, value);
}

export function searchDisplayNameDefault(env: Environment, model: ModelDef, operator: string, value: unknown): Domain {
  const searchFnames = model.recNamesSearch.length > 0 ? model.recNamesSearch : model.recName !== null ? [model.recName] : [];
  if (searchFnames.length === 0) return D.TRUE; // "Cannot search on display_name" -> do not restrain anything
  if (operator.endsWith("like") && D.pyFalsy(value) && !operator.includes("=")) {
    return D.isNegativeOperator(operator) ? D.FALSE : D.TRUE;
  }
  const domains: Domain[] = [];
  for (const fieldName of searchFnames) {
    // field_name may be a sequence of field names (partner_id.name): retrieve the last field in the sequence
    let current: ModelDef | null = model;
    let field: FieldDef | undefined;
    for (const fname of fieldName.split(".")) {
      if (current === null) throw new D.PyValueError(`Traversing non-relational field in ${model.name}._rec_names_search or ${model.name}._rec_name`);
      field = current.fields.get(fname);
      if (field === undefined) throw new D.PyValueError(`Invalid field ${current.name}.${fname}`);
      current = D.isRelationalType(field.type) && field.relation !== null ? env.reg.model(field.relation) : null;
    }
    if (field === undefined) continue;
    if (D.isRelationalType(field.type)) {
      domains.push(D.cond(`${fieldName}.display_name`, operator, value));
    } else if (operator.endsWith("like")) {
      domains.push(D.cond(fieldName, operator, value));
    } else if (Array.isArray(value)) {
      const typed: unknown[] = [];
      for (const v of value) {
        const converted = convertToWrite(field, v);
        if (converted !== undefined) typed.push(converted);
      }
      domains.push(D.cond(fieldName, operator, typed));
    } else {
      const converted = convertToWrite(field, value);
      if (converted !== undefined) domains.push(D.cond(fieldName, operator, converted));
    }
  }
  return D.isNegativeOperator(operator) ? D.and(domains) : D.or(domains);
}

/** `field.convert_to_write(value)` for the scalar types `_search_display_name` casts; undefined when it would raise. */
function convertToWrite(field: FieldDef, value: unknown): unknown {
  try {
    switch (field.type) {
      case "char":
      case "text":
      case "html":
      case "selection":
        return value === false || value === null ? false : D.pyStr(value);
      case "integer":
      case "float":
      case "monetary":
      case "boolean":
      case "date":
      case "datetime":
      case "many2one":
        return valueToColumn(field, value) ?? false;
      default:
        return value;
    }
  } catch (e) {
    if (e instanceof D.PyValueError || e instanceof D.PyTypeError) return undefined;
    throw e;
  }
}

/** domains.py:1432 `_optimize_any_domain_at_level` at FULL: optimize the sub-domain against the comodel. */
async function anyAtFull(c: Cond, field: FieldDef, env: Environment): Promise<Domain> {
  if (!D.isDomain(c.value)) return c;
  if (!D.isRelationalType(field.type) || field.relation === null) {
    throw new D.PyValueError(`Cannot use 'any' with non-relational fields in condition ${condRepr(c)}`);
  }
  const comodel = env.reg.model(field.relation);
  const comodelEnv = field.type === "many2one"
    ? env.withContext({ ...env.context, active_test: false })
    : env.withContext({ ...env.context, ...field.context });
  const optimized = await optimizeFull(c.value, comodel, comodelEnv);
  if (optimized.kind === "false") return c.op === "any" || c.op === "any!" ? D.FALSE : D.TRUE;
  if (D.equalDomains(optimized, c.value)) return c;
  return D.cond(c.path, c.op, optimized);
}

/** domains.py:1975 `_optimize_m2o_bypass_comodel_id_lookup`. */
function m2oBypassComodelIdLookup(c: Cond): Domain {
  if ((c.op !== "any!" && c.op !== "not any!") || !D.isDomain(c.value) || c.value.kind !== "cond") return c;
  const sub = c.value;
  if (sub.path !== "id") return c;
  let domain: Domain;
  switch (sub.op) {
    case "in":
      domain = D.cond(c.path, "in", D.setMinus(Array.isArray(sub.value) ? sub.value : [sub.value], [false]));
      break;
    case "not in":
      domain = D.cond(c.path, "not in", D.setUnion(Array.isArray(sub.value) ? sub.value : [sub.value], [false]));
      break;
    case "any!":
      domain = D.cond(c.path, "any!", sub.value);
      break;
    case "not any!":
      domain = D.and([D.cond(c.path, "!=", false), D.cond(c.path, "not any!", sub.value)]);
      break;
    default:
      return c;
  }
  return c.op === "not any!" ? D.not(domain) : domain;
}

/** domains.py:2011 `_optimize_x2m_in_operator`: x2many 'in' ids becomes 'any!' with a query of the ids. */
function x2manyInOperator(c: Cond, field: FieldDef, env: Environment): Domain {
  if (field.relation === null) throw new TypeError(`${field.name} has no comodel`);
  const comodel = env.reg.model(field.relation);
  let ids: unknown[] = Array.isArray(c.value) ? c.value : [c.value];
  let domain: Domain = D.FALSE;
  if (ids.some(isNullish)) {
    // x2m in {False, ...} => x2m not any! (Domain.TRUE) or x2m in {...}
    domain = D.or([domain, D.cond(c.path, "not any!", new D.SubQueryValue(new Query(comodel, env)))]);
    ids = ids.filter((v) => !isNullish(v));
  }
  if (ids.length > 0) {
    const query = new Query(comodel, env);
    query.setResultIds(ids.map((v) => Number(plainNumber(v))), false);
    domain = D.or([domain, D.cond(c.path, "any!", new D.SubQueryValue(query))]);
  }
  return c.op === "in" ? domain : D.not(domain);
}

/** domains.py:1799 `_operator_hierarchy` (child_of / parent_of). */
async function hierarchyDomain(c: Cond, model: ModelDef, field: FieldDef, env: Environment): Promise<Domain> {
  let value: unknown = c.value;
  if (value === false) return D.FALSE;
  let comodel: ModelDef;
  let comodelEnv: Environment;
  if (field.type === "many2one") {
    if (field.relation === null) throw new TypeError(`${field.name} has no comodel`);
    comodel = env.reg.model(field.relation);
    comodelEnv = env.withContext({ ...env.context, active_test: false });
  } else if (field.type === "one2many" || field.type === "many2many") {
    if (field.relation === null) throw new TypeError(`${field.name} has no comodel`);
    comodel = env.reg.model(field.relation);
    comodelEnv = env.withContext({ ...env.context, ...field.context });
  } else if (field.name === "id") {
    comodel = model;
    comodelEnv = env;
  } else {
    throw new D.PyValueError(`Cannot execute ${c.op} for ${model.name}.${field.name}, works only for relational fields in condition ${condRepr(c)}`);
  }
  const sudoEnv = comodelEnv.sudo().withContext({ ...comodelEnv.context, active_test: false });
  let parent = comodel.parentName;
  let resultField = field;
  if (comodel.name === model.name) {
    if (c.path !== "id") parent = c.path;
    if (field.type === "many2one") resultField = model.fields.get("id") as FieldDef;
  }
  if (typeof value === "number" || typeof value === "string") value = [value];
  if (!Array.isArray(value)) throw new D.PyValueError(`Value of type ${typeof value} is not supported in condition ${condRepr(c)}`);
  let coids: number[] = value.map(plainNumber).filter((v): v is number => typeof v === "number");
  const otherValues = value.map(plainNumber).filter((v) => typeof v !== "number");
  let searchDomain: Domain = D.FALSE;
  if (field.type === "many2many") {
    // always search for many2many
    searchDomain = D.or([searchDomain, D.cond("id", "in", coids)]);
    coids = [];
  }
  if (otherValues.length > 0) {
    searchDomain = D.or([searchDomain, D.or(otherValues.map((v) => D.cond("display_name", "ilike", v)))]);
  }
  if (searchDomain.kind !== "false") {
    coids = coids.concat(await queryIds(await searchQuery(comodelEnv, comodel, searchDomain, { order: "id" })));
  }
  if (coids.length === 0) return D.FALSE;
  const result = c.op === "parent_of"
    ? await parentOfDomain(sudoEnv, comodel, coids, parent)
    : await childOfDomain(sudoEnv, comodel, coids, parent);
  if (D.isDomain(result)) {
    if (resultField.name === "id") return result;
    return D.cond(resultField.name, "any!", result);
  }
  return D.cond(resultField.name, "in", result);
}

async function parentPaths(env: Environment, model: ModelDef, ids: readonly number[]): Promise<string[]> {
  const load = async (): Promise<string[]> => (await runSql<{ parent_path: string | null }>(env,
    sql`SELECT parent_path FROM ${ident(model.table)} WHERE id = ANY(${[...ids]}::int4[])`))
    .map((r) => r.parent_path).filter((p): p is string => p !== null);
  // the companies of a record rule (`company_ids` with parent_of/child_of): Odoo evaluates rule domains once per
  // user, model, mode and companies in the registry (ir_rule.py `_compute_domain` ormcache), src/orm/signaling.ts
  if (model.table === "res_company") return [...await registryCached(env.cr, `res_company parent_path ${ids.join(",")}`, load)];
  return load();
}

/** domains.py:1872 `_operator_child_of_domain`: parent_path prefix match, or a recursive sudo search. */
async function childOfDomain(env: Environment, model: ModelDef, ids: readonly number[], parent: string): Promise<Domain | number[]> {
  if (model.parentStore && parent === model.parentName) {
    const paths = await parentPaths(env, model, ids);
    return D.or(paths.map((path) => D.cond("parent_path", "=like", `${path}%`)));
  }
  const childIds: number[] = [];
  const seen = new Set<number>();
  let current = [...ids];
  while (current.length > 0) {
    for (const id of current) if (!seen.has(id)) { seen.add(id); childIds.push(id); }
    const query = new Query(model, env);
    const domain = await optimizeFull(D.cond(parent, "in", current), model, env);
    query.addWhere(await domainToSql(domain, query.table));
    const found = await queryIds(query);
    current = found.filter((id) => !seen.has(id));
  }
  return childIds;
}

/** domains.py:1898 `_operator_parent_of_domain`. */
async function parentOfDomain(env: Environment, model: ModelDef, ids: readonly number[], parent: string): Promise<number[]> {
  if (model.parentStore && parent === model.parentName) {
    const paths = await parentPaths(env, model, ids);
    return D.orderedSet(paths.flatMap((path) => path.split("/").slice(0, -1).map(Number))) as number[];
  }
  const parentIds: number[] = [];
  const seen = new Set<number>();
  let current = [...ids];
  while (current.length > 0) {
    for (const id of current) if (!seen.has(id)) { seen.add(id); parentIds.push(id); }
    const rows = await runSql<{ parent: number | null }>(env,
      sql`SELECT ${ident(parent)} AS parent FROM ${ident(model.table)} WHERE id = ANY(${current}::int4[])`);
    current = D.orderedSet(rows.map((r) => r.parent).filter((p): p is number => p !== null && !seen.has(p))) as number[];
  }
  return parentIds;
}

/** domains.py:1926 `_operator_access_rule_domain`: `(field, 'access', operation)`. */
async function accessOperatorDomain(c: Cond, model: ModelDef, field: FieldDef, env: Environment): Promise<Domain> {
  if (c.path !== field.name) throw new D.PyValueError(`The 'access' operator does not work for properties in condition ${condRepr(c)}`);
  let comodel: ModelDef;
  if (field.name === "id") comodel = model;
  else if (field.type === "many2one" && field.relation !== null) comodel = env.reg.model(field.relation);
  else throw new D.PyValueError(`The 'access' operator works only for many2one and 'id' fields in condition ${condRepr(c)}`);
  const operation = c.value;
  if (operation !== "read" && operation !== "write" && operation !== "create" && operation !== "unlink") {
    throw new D.PyValueError(`Invalid value for 'access' operator in condition ${condRepr(c)}`);
  }
  // comodel.sudo(False)._access_domain(operation)
  const userEnv = env.su ? env.withUser(env.uid) : env;
  const domain = await accessDomain(userEnv, comodel, operation);
  if (domain.kind === "false") return D.FALSE;
  if (domain.kind === "true") return D.cond(field.name, "!=", false);
  return D.cond(field.name, "any!", domain);
}

// --------------------------------------------------------------------------------------------------------------
// _search (models.py:4852-4942)
// --------------------------------------------------------------------------------------------------------------

export interface SearchQueryOptions {
  readonly offset?: number;
  readonly limit?: number | null;
  readonly order?: string | null;
  readonly activeTest?: boolean;
  readonly bypassAccess?: boolean;
  /** Explicit access domain (`_filtered_access` / `_check_access`): skips implicit read rules and `searchDomain`
   *  rewrites, and optimizes this domain as superuser with `search_domain` bound to the searched domain (`id in ids`)
   *  so `res_access_*` search hooks inspect only those records rather than scanning the entire table. */
  readonly secDomain?: Domain;
}

/**
 * `env.context['search_domain']` during the optimization of a search's access domain (domains.py:460-474): the
 * already optimized domain being searched, for the search methods of fields used in record rules
 * (`mail.activity._search_res_access`, `ir.attachment._search_res_access`). Odoo resets the key on every other
 * `optimize_full`; here it is bound to the one environment object that searchQuery passes down, so any environment
 * derived from it (with_user, sudo, with_context) does not carry it, as in Odoo.
 */
const SEARCH_DOMAINS = new WeakMap<Environment, Domain>();
export function searchDomainOf(env: Environment): Domain | undefined {
  return SEARCH_DOMAINS.get(env);
}

/**
 * `Domain(domain).validate(model)` (domains.py:418-422), for `/web/domain/validate`: the FULL optimization with
 * `search_domain=Domain.FALSE` (no search runs for a field's search method that looks at it), then the SQL. Raises what
 * the parsing, the optimization or the SQL raises; the caller answers False on ValueError and TypeError.
 */
export async function validateDomain(env: Environment, model: ModelDef, raw: unknown): Promise<void> {
  const domain = D.parseDomain(raw);
  const vEnv = env.withContext({ ...env.context });
  SEARCH_DOMAINS.set(vEnv, D.FALSE);
  const optimized = await optimizeFull(domain, model, vEnv);
  if (optimized.kind === "true" || optimized.kind === "false") return;
  await domainToSql(optimized, new Query(model, vEnv).table);
}

/** `BaseModel._search`: access domain, active_test, optimization, SQL. */
export async function searchQuery(env: Environment, model: ModelDef, rawDomain: Domain, opts: SearchQueryOptions): Promise<Query> {
  const bypass = opts.bypassAccess ?? false;
  let secDomain: Domain = D.TRUE;
  if (opts.secDomain !== undefined) {
    secDomain = opts.secDomain;
  } else if (!env.su && !bypass) {
    secDomain = await accessDomain(env, model, "read");
    if (secDomain.kind === "false") {
      await checkModelAccess(env, model, "read"); // raises ir_access.py:326
    }
  }
  const rewrite = opts.secDomain !== undefined ? undefined : hooksOf(model.name).searchDomain;
  let domain = rewrite ? await rewrite(env, rawDomain) : rawDomain;
  // inactive records unless they were explicitly asked for (models.py:4889-4897)
  const activeName = model.activeName;
  if (activeName !== null && (opts.activeTest ?? true) && contextActiveTest(env.context)) {
    let mentioned = false;
    for (const leaf of D.iterConditions(domain)) if (leaf.path === activeName) { mentioned = true; break; }
    if (!mentioned) domain = D.and([D.cond(activeName, "in", [true]), domain]);
  }
  domain = await optimizeFull(domain, model, env);
  const query = new Query(model, env);
  if (domain.kind === "false") {
    query.setResultIds([], false);
    return query;
  }
  if (domain.kind !== "true") query.addWhere(await domainToSql(domain, query.table));
  if (secDomain.kind !== "true") {
    const sudoEnv = env.sudo().withContext({ ...env.context, active_test: false });
    // models.py:4910 `sec_domain.optimize_full(self_sudo, search_domain=domain)`: the search methods of the rules'
    // fields see the searched domain (domains.py:473, context key `search_domain`; see searchDomainOf)
    SEARCH_DOMAINS.set(sudoEnv, domain);
    const sec = await optimizeFull(secDomain, model, sudoEnv);
    if (sec.kind === "false") {
      const empty = new Query(model, env);
      empty.setResultIds([], false);
      return empty;
    }
    if (sec.kind !== "true") query.addWhere(await domainToSql(sec, query.table.withEnv(sudoEnv)));
  }
  if (opts.order !== undefined && opts.order !== null && opts.order !== "") {
    query.order = await orderToSql(query.table, opts.order, false);
  }
  const limit = opts.limit;
  if (limit !== undefined && limit !== null) query.limit = Math.trunc(limit);
  if (opts.offset !== undefined) query.offset = Math.trunc(opts.offset);
  return query;
}

function contextActiveTest(context: Context): boolean {
  const v = context.active_test;
  return v === undefined || !D.pyFalsy(v);
}

/** `query.get_result_ids()` (query.py:249). */
export async function queryIds(query: Query): Promise<number[]> {
  if (query.resultIds !== null) return [...query.resultIds];
  const rows = await runSql<{ id: number }>(query.env, query.select());
  const ids = rows.map((r) => r.id);
  query.resultIds = ids;
  return ids;
}

/** `len(query)` (query.py:296). */
export async function queryCount(query: Query): Promise<number> {
  if (query.resultIds !== null) return query.resultIds.length;
  const rows = await runSql<{ count: string | number }>(query.env, query.countSql());
  return Number(rows[0]?.count ?? 0);
}
