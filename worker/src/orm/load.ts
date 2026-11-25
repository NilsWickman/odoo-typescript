/**
 * `BaseModel.load(fields, data)` (odoo/odoo/orm/models.py:943-1119) with `_extract_records` (:1121-1242),
 * `_convert_records` (:1244-1296) and `_load_records` (:4619-4717) for records without external ids.
 * Records are created through the ORM write core (src/orm/create.ts); conversion is `ir.fields.converter`
 * (src/models/ir_fields_converter.ts).
 *
 * Refused (NotPorted): `mode='update'`, external ids on the imported records (`id` column: ir.model.data
 * `_update_xmlids`), updates through `.id`, one2many sub-records, properties columns, and database errors
 * (`psycopg2.Error` mapped to messages by `_sql_error_to_message`).
 */
import { AccessDenied, AccessError, MissingError, NotPorted, OdooError, UserError, ValidationError } from "../errors";
import { convertRecord, type ImportProblem, type ImportRecord, NAME_KEY, pyPercent } from "../models/ir_fields_converter";
import { translate } from "../models/util";
import { create } from "./create";
import { loadRecords, loadRecordsCreate } from "./load_records";
import type { Environment } from "./types";

/** models.py:138-149 `fix_import_export_id_paths`. */
/** Odoo's `except UserError` (models.py:1057): AccessDenied, AccessError, MissingError and ValidationError subclass
 *  UserError in odoo/exceptions.py:39-99; the port's error classes are flat. */
function isUserError(e: OdooError): boolean {
  return e instanceof UserError || e instanceof ValidationError || e instanceof AccessError || e instanceof MissingError
    || e instanceof AccessDenied;
}

interface PgError { code: string; message: string; detail?: string; constraint?: string; table?: string; severity: string }

/** A PostgreSQL error from the driver (pg-protocol DatabaseError), psycopg2.Error in Odoo. */
function isPgError(e: unknown): e is PgError {
  return typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string"
    && typeof (e as { severity?: unknown }).severity === "string";
}

/**
 * models.py:2607-2674 `_sql_error_to_message` for the cases ported: the message of the constraint in
 * ir.model.constraint, else a unique violation of a unique index (no pg_constraint, so
 * `get_columns_from_sql_diagnostics` finds no column) falls back to `exception_to_unicode(exc)`, psycopg2's text.
 */
async function sqlErrorMessage(env: Environment, model: string, e: PgError): Promise<string> {
  if (e.constraint) {
    const row = (await env.cr.query<{ message: string | null }>(
      `SELECT COALESCE(c.message->>$3, c.message->>'en_US') AS message FROM ir_model_constraint c JOIN ir_model m ON m.id = c.model
        WHERE c.name = $1 AND m.model = $2 LIMIT 1`, [e.constraint, model, env.lang ?? "en_US"])).rows[0];
    if (row?.message) return row.message;
  }
  const isConstraint = e.constraint
    ? (await env.cr.query("SELECT 1 FROM pg_constraint WHERE conname = $1 LIMIT 1", [e.constraint])).rows.length > 0 : false;
  if (e.code === "23505" && !isConstraint) return `${e.message}\n${e.detail ? `DETAIL:  ${e.detail}\n` : ""}`;
  throw new NotPorted(`import message of the database error ${e.code} (_sql_error_to_message)`);
}

export function fixImportExportIdPaths(fieldname: string): string[] {
  return fieldname.replace(/([^/])\.id/g, "$1/.id").replace(/([^/]):id/g, "$1/id").split("/");
}

export interface LoadResult {
  ids: number[] | false;
  messages: Record<string, unknown>[];
  nextrow: number;
}

type Cell = unknown;
interface Extracted { record: ImportRecord; rows: { from: number; to: number } }

/** models.py:1121-1242 `_extract_records(field_paths, data, limit)`. */
function extractRecords(env: Environment, model: string, fieldPaths: readonly (string | null)[][], data: readonly Cell[][], limit: number): Extracted[] {
  const fields = env.reg.model(model).fields;
  const isO2m = (f: string | null): boolean => f !== null && fields.get(f)?.type === "one2many";
  const o2mIdx = fieldPaths.map((p, i) => (isO2m(p[0] ?? null) ? i : -1)).filter((i) => i >= 0);
  const nonO2mIdx = fieldPaths.map((p, i) => (isO2m(p[0] ?? null) ? -1 : i)).filter((i) => i >= 0);
  const truthy = (v: Cell): boolean => v !== "" && v !== null && v !== undefined && v !== false;
  const onlyO2m = (row: readonly Cell[]): boolean => o2mIdx.some((i) => truthy(row[i])) && !nonO2mIdx.some((i) => truthy(row[i]));
  for (const [fname] of fieldPaths) {
    if (!fname) continue;
    if (!fname.includes(".")) {
      if (!fields.has(fname)) throw new OdooError("builtins.ValueError", `Invalid field name '${fname}'`);
      continue;
    }
    const [prop] = fname.split(".");
    if (fields.get(prop!)?.type === "properties") throw new NotPorted("import into properties");
  }
  const isRelational = (f: string | null): boolean => {
    const t = f === null ? undefined : fields.get(f)?.type;
    return t === "many2one" || t === "one2many" || t === "many2many";
  };
  const out: Extracted[] = [];
  let index = 0;
  while (index < data.length && index < limit) {
    const row = data[index]!;
    const record: ImportRecord = {};
    fieldPaths.forEach((p, i) => { if (!isRelational(p[0] ?? null)) record[p[0] === null ? NAME_KEY : p[0]!] = row[i]; });
    const span: (readonly Cell[])[] = [row];
    for (let j = index + 1; j < data.length && onlyO2m(data[j]!); j++) span.push(data[j]!);
    for (const [relfield] of fieldPaths) {
      if (!isRelational(relfield ?? null) || relfield === null || relfield === undefined || relfield in record) continue;
      const comodel = fields.get(relfield)!.relation!;
      const indices: number[] = [];
      const subfields: (string | null)[][] = [];
      fieldPaths.forEach((p, i) => { if (p[0] === relfield) { indices.push(i); subfields.push(p.length > 1 ? p.slice(1) : [null]); } });
      const relData = span.map((r) => indices.map((i) => r[i])).filter((it) => it.some(truthy));
      record[relfield] = extractRecords(env, comodel, subfields, relData, Infinity).map((e) => e.record);
    }
    out.push({ record, rows: { from: index, to: index + span.length - 1 } });
    index += span.length;
  }
  return out;
}

/** models.py:943-1119 `load(fields, data)`. */
export async function load(env0: Environment, model: string, fieldNames: readonly string[], data: readonly Cell[][]): Promise<LoadResult> {
  const mode = env0.context["mode"] ?? "init";
  if (mode === "update") throw new NotPorted("load in update mode");
  const currentModule = env0.context["module"] ?? "__import__";
  const env = env0.withContext({ ...env0.context, _import_current_module: currentModule });
  const def = env.reg.model(model);
  const cr = env.cr;
  const sp = `load_${Math.random().toString(36).slice(2, 10)}`;
  await cr.query(`SAVEPOINT ${sp}`);
  const fieldPaths: (string | null)[][] = fieldNames.map(fixImportExportIdPaths);
  const ids: number[] = [];
  const messages: Record<string, unknown>[] = [];
  const batch: { values: Record<string, unknown>; info: Record<string, unknown>; xid?: string }[] = [];
  const batchXmlIds = new Set<string>();
  const noupdate = !!env0.context["noupdate"];
  const update = mode === "update";
  // models.py:1018-1030 `_load_records(data_list, mode == "update")`: plain creates when no external id is batched
  const createOrLoad = (rows: { values: Record<string, unknown>; xid?: string }[]): Promise<number[]> =>
    rows.some((r) => r.xid)
      ? loadRecords(env, model, rows.map((r) => (r.xid ? { xml_id: r.xid, values: { ...r.values }, noupdate } : { values: { ...r.values }, noupdate })), update)
      : loadRecordsCreate(env, model, rows.map((r) => ({ ...r.values })));
  // models.py:976-990: the root model and the comodels of one2many paths
  const creatable = new Set([model]);
  for (const path of fieldPaths) {
    if (path[0] === null || path[0] === "id" || path[0] === ".id") continue;
    let fields = def.fields;
    for (const name of path) {
      if (name === null || name === "id" || name === ".id") break;
      const f = fields.get(name);
      if (f?.type === "one2many") { creatable.add(f.relation!); fields = env.reg.model(f.relation!).fields; }
    }
  }

  const flush = async (opts: { model?: string; xmlId?: string } = {}): Promise<void> => {
    if (!batch.length) return;
    // :1000-1003 an external id not in the batch: `xml_id not in self.env` (a model name test) returns
    if (opts.xmlId !== undefined && !batchXmlIds.has(opts.xmlId)) return;
    if (opts.model !== undefined && !creatable.has(opts.model)) return;
    const dataList = batch.splice(0, batch.length);
    batchXmlIds.clear();
    // models.py:1018-1030: batch create inside a savepoint
    const inner = `${sp}_b`;
    await cr.query(`SAVEPOINT ${inner}`);
    let globalError: Record<string, unknown> | null = null;
    try {
      const created = await createOrLoad(dataList);
      await cr.query(`RELEASE SAVEPOINT ${inner}`);
      ids.push(...created);
      return;
    } catch (e) {
      await cr.query(`ROLLBACK TO SAVEPOINT ${inner}`);
      if (e instanceof NotPorted) throw e;
      if (e instanceof OdooError && isUserError(e)) globalError = { ...dataList[0]!.info, type: "error", message: e.message };
      else if (!(e instanceof OdooError) && !isPgError(e)) throw e; // :1031-1032 `except Exception: pass`
    }
    // models.py:1041-1084: record by record
    let errors = 0;
    for (let i = 0; i < dataList.length; i++) {
      const rec = dataList[i]!;
      try {
        ids.push(...(await createOrLoad([rec])));
      } catch (e) {
        if (isPgError(e)) {
          // models.py:1045-1056: a database error of this record
          await cr.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          messages.push({ ...rec.info, type: "error", message: await sqlErrorMessage(env, model, e) });
          errors++;
          if (errors >= 10 && errors >= (i + 1) / 10) {
            messages.push({ type: "warning", message: translate(env, "Found more than 10 errors and more than one error per 10 records, interrupted to avoid showing too many errors.") });
            break;
          }
          continue;
        }
        if (e instanceof NotPorted || !(e instanceof OdooError)) throw e;
        await cr.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        if (isUserError(e)) messages.push({ ...rec.info, type: "error", message: e.message });
        else {
          messages.push({ ...rec.info, type: "error",
            message: pyPercent(translate(env, "Unknown error during import: %(error_type)s: %(error_message)s"), { error_type: `<class '${e.odooName}'>`, error_message: e.message }),
            moreinfo: translate(env, "Resolve other errors first") });
        }
        errors++;
      }
      if (errors >= 10 && errors >= (i + 1) / 10) {
        messages.push({ type: "warning", message: translate(env, "Found more than 10 errors and more than one error per 10 records, interrupted to avoid showing too many errors.") });
        break;
      }
    }
    if (errors > 0 && globalError !== null && !messages.some((m) => JSON.stringify(m) === JSON.stringify(globalError))) messages.unshift(globalError);
  };

  const limitRaw = env.context["_import_limit"];
  const limit = typeof limitRaw === "number" ? limitRaw : Infinity;
  const extracted = extractRecords(env, model, fieldPaths, data, limit);

  // models.py:1255-1275 `_log`: field labels in the env language
  const lang = env.lang ?? "en_US";
  const label = (f: string): string => {
    const fd = def.fields.get(f);
    return fd ? (fd.strings[lang] ?? fd.string) : f;
  };
  let info: Record<string, unknown> = { rows: { to: -1 } };
  const cc = { flush };
  const skip = Array.isArray(env.context["import_skip_records"]) ? (env.context["import_skip_records"] as unknown[]) : [];
  for (let streamIndex = 0; streamIndex < extracted.length; streamIndex++) {
    const { record, rows } = extracted[streamIndex]!;
    const extras = { rows };
    let xid: string | undefined;
    if (record["id"]) {
      // :1097-1099 the external id, prefixed with the current module when it has none
      const raw = String(record["id"]);
      xid = raw.includes(".") ? raw : `${String(currentModule)}.${raw}`;
    }
    if (record[".id"]) throw new NotPorted("import updating records by database id");
    const converted = await convertRecord(env, cc, model, record, (field: string, p: ImportProblem) => {
      const fieldName = label(field);
      const base = { ...extras, record: streamIndex, field: fieldName };
      const entry: Record<string, unknown> = { ...extras, type: p.warning ? "warning" : "error", record: streamIndex, field,
        message: pyPercent(p.msg, base) };
      if (p.info !== null) Object.assign(entry, p.info, { field_name: fieldName });
      messages.push(entry);
    });
    info = { ...extras, record: streamIndex };
    if (env.context["import_file"] && skip.length && skip.some((f) => typeof f === "string" && converted[f] === null)) continue;
    if (xid !== undefined) batchXmlIds.add(xid);
    batch.push(xid !== undefined ? { values: converted, info, xid } : { values: converted, info });
  }
  await flush();
  let outIds: number[] | false = ids;
  if (messages.some((m) => m["type"] === "error")) {
    await cr.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    outIds = false;
  }
  await cr.query(`RELEASE SAVEPOINT ${sp}`);
  const rowsInfo = info["rows"] as { to: number };
  let nextrow = rowsInfo.to + 1;
  if (nextrow < limit) nextrow = 0;
  return { ids: outIds, messages, nextrow };
}
