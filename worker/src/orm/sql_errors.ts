/**
 * Database errors as Odoo reports them. An IntegrityError (SQLSTATE class 23) is caught by the request's
 * `retrying` (odoo/odoo/http/retrying.py:60-91): the transaction is rolled back, then the message comes from
 * `_sql_error_to_message` (odoo/odoo/orm/models.py:2604) of the model owning the table, wrapped in
 * "The operation cannot be completed: %s" as a ValidationError. Other psycopg2 errors propagate with their class.
 */
import { NotPorted, OdooError, ValidationError } from "../errors";
import type { Environment, ModelDef } from "./types";

interface PgError { code: string; message: string; table?: string; column?: string; constraint?: string; detail?: string }

export function isPgError(e: unknown): e is PgError {
  return typeof e === "object" && e !== null && "code" in e && typeof (e as { code: unknown }).code === "string"
    && /^[0-9A-Z]{5}$/.test((e as { code: string }).code) && "severity" in e;
}

/** psycopg2.errors class names of the SQLSTATEs that reach users (psycopg2/errorcodes.py). */
const PSYCOPG_CLASSES: Readonly<Record<string, string>> = {
  "22001": "StringDataRightTruncation", "22003": "NumericValueOutOfRange", "22P02": "InvalidTextRepresentation",
  "22007": "InvalidDatetimeFormat", "22008": "DatetimeFieldOverflow", "22012": "DivisionByZero",
};

let translations: Promise<Record<string, { translations: Record<string, Record<string, string>> }>> | undefined;
async function tr(env: Environment, source: string): Promise<string> {
  const lang = env.lang ?? "en_US";
  if (lang === "en_US") return source;
  translations ??= import("../../gen/out/contacts.json", { with: { type: "json" } }).then((m) => m.default as Record<string, { translations: Record<string, Record<string, string>> }>);
  const t = (await translations)[lang]?.translations["base"]?.[source];
  if (!t) throw new NotPorted(`translation of "${source.slice(0, 40)}" in ${lang}`);
  return t;
}

function fmt(template: string, values: Record<string, string>): string {
  return template.replace(/%\((\w+)\)s/g, (_, k: string) => values[k] ?? "");
}

let pgClasses: Promise<Readonly<Record<string, string>>> | undefined;

/**
 * A database error as the psycopg2 exception Odoo reports (dispatcher.py:78-91 serialize_exception: the class from
 * gen/out/pg_errors.json; `str(exc)` is libpq's message with its DETAIL and HINT lines, ending with a newline).
 */
export async function psycopgError(e: PgError & { hint?: string }): Promise<unknown> {
  const local = PSYCOPG_CLASSES[e.code];
  pgClasses ??= import("../../gen/out/pg_errors.json", { with: { type: "json" } }).then((m) => m.default.classes as Readonly<Record<string, string>>);
  const cls = local ? `psycopg2.errors.${local}` : (await pgClasses)[e.code];
  if (!cls) return e;
  const text = `${e.message}\n${e.detail ? `DETAIL:  ${e.detail}\n` : ""}${e.hint ? `HINT:  ${e.hint}\n` : ""}`;
  return new OdooError(cls, local ? `${e.message}\n` : text);
}

/** Convert a database error raised in a call into Odoo's error; anything else is returned unchanged. */
export async function mapDbError(env: Environment, e: unknown): Promise<unknown> {
  if (!isPgError(e)) return e;
  if (!e.code.startsWith("23")) return psycopgError(e);
  // retrying.py:67 env.cr.rollback(): the messages are read in a fresh transaction (PORTING_odoo.md 12.15)
  await env.cr.query("ROLLBACK");
  await env.cr.query("BEGIN");
  const def = [...env.reg.models.values()].find((m) => m.table === e.table && !m.abstract);
  const message = await sqlErrorToMessage(env, def ?? null, e);
  return new ValidationError(fmt(await tr(env, "The operation cannot be completed: %s").then((s) => s.replace("%s", "%(m)s")), { m: message }));
}

async function sqlErrorToMessage(env: Environment, def: ModelDef | null, e: PgError): Promise<string> {
  const lang = env.lang ?? "en_US";
  if (def && e.constraint) {
    // models.py:2609: a constraint of the model's _table_objects with its ir.model.constraint message
    const row = (await env.cr.query<{ type: string; message: Record<string, string | null> | null }>(
      `SELECT c.type, c.message FROM ir_model_constraint c JOIN ir_model m ON m.id = c.model WHERE c.name = $1 AND m.model = $2 LIMIT 1`,
      [e.constraint, def.name])).rows[0];
    if (row && row.type !== "f") {
      const msg = row.message?.[lang] ?? row.message?.["en_US"];
      if (msg) return msg;
      throw new NotPorted(`Python-side message of constraint ${e.constraint}`);
    }
  }
  // models.py:2622 _sql_error_to_message_generic
  if (!def) throw new NotPorted(`database error on table ${e.table ?? "?"} without a model`);
  const modelName = (await env.cr.query<{ name: string | null }>(
    "SELECT COALESCE(name->>$2, name->>'en_US') AS name FROM ir_model WHERE model = $1", [def.name, lang])).rows[0]?.name ?? def.description;
  const info: Record<string, string> = { model_display: `'${modelName}' (${def.name})`, table_name: e.table ?? "", constraint_name: e.constraint ?? "" };
  let columns: string[] = [];
  if (e.column) columns = [e.column];
  else if (e.constraint && e.table) {
    const r = (await env.cr.query<{ columns: string[] }>(
      `SELECT ARRAY(SELECT attname FROM pg_attribute WHERE attrelid = conrelid AND attnum = ANY(conkey))::text[] AS columns
       FROM pg_constraint JOIN pg_class t ON t.oid = conrelid WHERE conname = $1 AND t.relname = $2
       AND t.relnamespace = current_schema::regnamespace`, [e.constraint, e.table])).rows[0];
    columns = r?.columns ?? [];
  }
  const unknown = await tr(env, "Unknown");
  const label = (c: string): string | null => { const f = def.fields.get(c); return f ? (f.strings[lang] ?? f.string) : null; };
  if (!columns.length) info["field_display"] = unknown;
  else if (columns.length === 1 && label(columns[0]!) !== null) info["field_display"] = `'${label(columns[0]!)}' (${columns[0]})`;
  else {
    if (columns.length > 1 && lang !== "en_US") throw new NotPorted("format_list in a non-English language");
    info["field_display"] = `'${formatList(columns)}'`;
  }
  switch (e.code) {
    case "23502":
      return fmt(await tr(env, "Missing required field %(field_display)s for model %(model_display)s"), info);
    case "23503":
      if (columns.length !== 1) info["field_display"] = info["constraint_name"]!;
      return fmt(await tr(env, "Another model is using the record you are trying to delete.\n\nThe troublemaker is: %(model_display)s\nThanks to the following constraint: %(field_display)s\nHow about archiving the record instead?"), info);
    case "23505":
      if (columns.length) {
        const names = columns.map((c) => label(c) ?? c);
        if (lang !== "en_US" && names.length > 1) throw new NotPorted("format_list in a non-English language");
        info["field_display"] = `'${columns.join(", ")}' (${formatList(names)})`;
        info["detail"] = e.detail ?? "";
        return fmt(await tr(env, "The value for %(field_display)s already exists.\n\nDetail: %(detail)s\n"), info);
      }
      break;
  }
  // models.py:2670 exception_to_unicode(exc): the server's message
  return `${e.message}\n${e.detail ? `DETAIL:  ${e.detail}\n` : ""}`;
}

/** odoo/tools/misc.py format_list for en_US: "a", "a and b", "a, b, and c" (babel list pattern, standard). */
function formatList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** sql_db.py:87-91 PG_CONCURRENCY_EXCEPTIONS_TO_RETRY: LockNotAvailable, SerializationFailure, DeadlockDetected. */
export function isConcurrencyError(e: unknown): boolean {
  const code = typeof e === "object" && e !== null && "code" in e ? (e as { code: unknown }).code : null;
  return code === "55P03" || code === "40001" || code === "40P01";
}

/**
 * Run a call and convert the database errors it raises. A concurrency failure passes through unchanged: the request's
 * `retrying` (retrying.py:93-108) must see it to roll back and try again, and converts it only when the tries run out.
 */
export async function withDbErrors<T>(env: Environment, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isConcurrencyError(e)) throw e;
    throw await mapDbError(env, e);
  }
}
