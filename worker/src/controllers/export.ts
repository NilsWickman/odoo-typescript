/**
 * The export dialog's routes, `odoo/addons/web/controllers/export.py`: `/web/export/formats` (:292-307),
 * `/web/export/get_fields` (:309-385), `/web/export/csv` (:520-566, through `ExportFormat.base` :431-517) and the
 * record side `BaseModel.export_data` / `_export_rows` (`odoo/odoo/orm/models.py:711-937`).
 *
 * Supported: flat field paths and relational paths whose sub-fields are themselves supported (recursively, as
 * `_export_rows` does), `.id`, CSV and xlsx, grouped xlsx (export_group.ts). Refused (NotPorted): external ids
 * (`id` paths create `ir.model.data` rows through `__ensure_xml_id`), `field@lang` translations, properties sub-paths
 * and `/web/export/namelist`.
 */
import { HttpError, NotPorted, OdooError, UserError } from "../errors";
import type { RequestContext } from "../http/context";
import { dumps } from "../http/json";
import { jsonRoute, route } from "../http/router";
import { parseDomain } from "../orm/domain";
import { envTz, hasGroup } from "../orm/env";
import type { Context, Environment, FieldDef, RecordValues } from "../orm/types";
import { pyTruthy, translate } from "../models/util";
import { getPropertyFields } from "../models/ir_exports";
import { formatNaive, parseNaive, utcToLocal } from "../web/tz";
import { cleanFilename, contentDispositionAttachment, csvFromData, type ExportCell } from "./export_csv";
import { groupedRows } from "./export_group";
import { buildXlsx, XLS_STRMAX, type XlsxRow } from "./export_xlsx";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// export.py:292-307. The reference Odoo has xlsxwriter installed, so `error` is None; the port answers the same
// list (the client only offers the formats) and refuses /web/export/xlsx itself below.
jsonRoute("/web/export/formats", async (ctx) => {
  const env = await ctx.orm();
  return [
    { tag: "xlsx", label: translate(env, "Excel Workbook (.xlsx)"), error: null },
    { tag: "csv", label: translate(env, "Plain Text (.csv)") },
  ];
}, { auth: "user", readonly: true });

/** registry.py:1069-1084 `is_an_ordinary_table`: the model's table is a plain table (relkind 'r'). */
async function isOrdinaryTable(env: Environment, model: string): Promise<boolean> {
  const table = env.reg.model(model).table;
  const r = await env.cr.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_class c WHERE c.relname = $1 AND c.relkind = 'r' AND c.relnamespace = current_schema::regnamespace",
    [table],
  );
  return (r.rows[0]?.n ?? 0) > 0;
}

const GET_FIELDS_ATTRIBUTES = [
  "type", "string", "required", "relation_field", "default_export_compatible",
  "relation", "definition_record", "definition_record_field", "exportable", "readonly",
  "translate",
];

/** Python `str.lower()` ordering of `sorted(..., key=lambda f: f[1]['string'].lower())` (stable, code points). */
function byLowerString(a: [string, RecordValues], b: [string, RecordValues]): number {
  const x = String(a[1]["string"]).toLowerCase();
  const y = String(b[1]["string"]).toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

// export.py:309-385
jsonRoute("/web/export/get_fields", async (ctx) => {
  const p = ctx.jsonParams ?? {};
  const known = new Set(["model", "domain", "prefix", "parent_name", "import_compat", "parent_field_type", "parent_field", "exclude"]);
  for (const k of Object.keys(p)) if (!known.has(k)) throw new OdooError("builtins.TypeError", `Export.get_fields() got an unexpected keyword argument '${k}'`);
  const model = p["model"];
  const env = await ctx.orm();
  if (typeof model !== "string" || !env.reg.models.has(model)) throw new OdooError("builtins.KeyError", `'${String(model)}'`);
  const prefix = typeof p["prefix"] === "string" ? p["prefix"] : "";
  const parentName = typeof p["parent_name"] === "string" ? p["parent_name"] : "";
  const importCompat = "import_compat" in p ? pyTruthy(p["import_compat"]) : true;
  const parentFieldType = p["parent_field_type"] ?? null;
  const parentField = p["parent_field"] ?? null;
  const exclude = Array.isArray(p["exclude"]) ? p["exclude"] : null;
  const domain = p["domain"];

  const Model = env.model(model);
  let fields: Record<string, RecordValues> = await Model.fieldsGet(null, GET_FIELDS_ATTRIBUTES);
  if (importCompat) {
    if (parentFieldType === "many2one" || parentFieldType === "many2many") {
      const recName = Model.def.recName ?? "id"; // models.py:1410 _rec_name_fallback
      const kept: Record<string, RecordValues> = {};
      if (fields["id"]) kept["id"] = fields["id"];
      if (fields[recName]) kept[recName] = fields[recName];
      fields = kept;
    }
  } else if (fields["id"]) {
    fields[".id"] = { ...fields["id"] };
  }
  if (fields["id"]) fields["id"] = { ...fields["id"], string: translate(env, "External ID") };

  if (!(await isOrdinaryTable(env, model))) delete fields["id"];
  else if (isRecord(parentField) && Object.keys(parentField).length > 0) {
    // export.py:334-337 (parent_field arrives from the client as the parent's field dict)
    fields["id"] = { ...parentField, string: translate(env, "External ID"), type: parentField["field_type"] };
  }

  const exportable: [string, RecordValues][] = [];
  for (const [name, field] of Object.entries(fields)) {
    if (importCompat && name !== "id") {
      if (exclude && exclude.includes(name)) continue;
      if (field["readonly"]) continue;
    }
    if (field["exportable"] === false) continue;
    exportable.push([name, field]);
  }
  const props = await getPropertyFields(env, fields, model, domain === undefined ? [] : domain);
  for (const [k, v] of Object.entries(props)) {
    const i = exportable.findIndex(([n]) => n === k);
    if (i >= 0) exportable[i] = [k, v];
    else exportable.push([k, v]);
  }
  const sequence = [...exportable].sort(byLowerString);

  const result: Record<string, unknown>[] = [];
  for (const [name, field] of sequence) {
    const ident = prefix + (prefix ? "/" : "") + name;
    let val = ident;
    if (name === "name" && importCompat && (parentFieldType === "many2one" || parentFieldType === "many2many")) val = prefix;
    const label = parentName + (parentName ? "/" : "") + String(field["string"]);
    const dict: Record<string, unknown> = {
      id: ident,
      string: label,
      value: val,
      children: false,
      field_type: field["type"] ?? null,
      required: field["required"] ?? null,
      relation_field: field["relation_field"] ?? null,
      default_export: importCompat && (field["default_export_compatible"] ?? null),
      translate: Boolean(field["translate"]),
    };
    if (ident.split("/").length < 3 && "relation" in field) {
      dict["value"] = String(dict["value"]) + "/id";
      dict["params"] = { model: field["relation"], prefix: ident, name: label, parent_field: field };
      dict["children"] = true;
    }
    result.push(dict);
  }
  return result;
}, { auth: "user", readonly: true });

jsonRoute("/web/export/namelist", async () => {
  throw new NotPorted("/web/export/namelist (ir.exports._get_fields_info)");
}, { auth: "user", readonly: true });

// ---------------------------------------------------------------------------------------------------------------
// export_data / _export_rows (models.py:711-937)
// ---------------------------------------------------------------------------------------------------------------

/** A `_export_rows` cell before the top-level xid pass; tuples are not produced (external ids refuse). */
type Cell = ExportCell;

/** models.py:138-149 `fix_import_export_id_paths`. */
export function fixImportExportIdPaths(fieldname: string): string[] {
  return fieldname.replace(/([^/])\.id/g, "$1/.id").replace(/([^/]):id/g, "$1/id").split("/");
}

/** Python truthiness of an export cell (`if val or isinstance(val, (int, float))`, bool being an int). */
function mergeable(v: Cell | XidRef): boolean {
  return typeof v !== "string" || v !== "";
}

interface ReadValues {
  readonly fields: ReadonlyMap<string, FieldDef>;
  readonly rows: ReadonlyMap<number, RecordValues>;
  readonly selections: ReadonlyMap<string, readonly [string, string][]>;
}

async function fetchValues(env: Environment, model: string, ids: readonly number[], names: readonly string[]): Promise<ReadValues> {
  const def = env.reg.model(model);
  const fields = new Map<string, FieldDef>();
  for (const n of names) {
    const f = def.fields.get(n);
    // models.py:870 `record._fields[fname]` raises KeyError on an unknown field
    if (!f) throw new OdooError("builtins.KeyError", `'${n}'`);
    fields.set(n, f);
  }
  const m = env.model(model);
  const rows = new Map<number, RecordValues>();
  if (names.length && ids.length) {
    for (const r of await m.read(ids, [...names], "")) rows.set(Number(r["id"]), r);
  }
  const selections = new Map<string, readonly [string, string][]>();
  const selNames = names.filter((n) => fields.get(n)?.type === "selection");
  if (selNames.length) {
    const fg = await m.fieldsGet(selNames, ["selection"]);
    for (const n of selNames) {
      const sel = fg[n]?.["selection"];
      selections.set(n, Array.isArray(sel) ? (sel as [string, string][]) : []);
    }
  }
  return { fields, rows, selections };
}

function asNumber(v: unknown): number | { float: number } | null {
  if (typeof v === "number") return v;
  if (isRecord(v) && typeof v["float"] === "number") return { float: v["float"] };
  return null;
}

/** `field.convert_to_export(value, record)` for a non-relational value as `read(load='')` returns it. */
async function convertToExport(env: Environment, field: FieldDef, value: unknown, selection: readonly [string, string][] | undefined): Promise<Cell> {
  switch (field.type) {
    case "boolean": return Boolean(value); // fields_misc.py:33
    case "integer": case "float": case "monetary": { // fields_numeric.py:54, :178, :301
      const n = asNumber(value);
      return n === null ? "" : n;
    }
    case "selection": { // fields_selection.py:235
      for (const [k, label] of selection ?? []) if (k === value) return label;
      return typeof value === "string" ? value : "";
    }
    case "date": return typeof value === "string" ? value : ""; // fields_temporal.py:199
    case "datetime": { // fields_temporal.py:302-309: context_timestamp(env.tz), seconds precision
      if (typeof value !== "string" || value === "") return "";
      const naive = parseNaive(value);
      if (naive === null) throw new NotPorted(`datetime export of ${value}`);
      const utc = new Date(Date.UTC(naive.year, naive.month - 1, naive.day, naive.hour, naive.minute, naive.second));
      return formatNaive(utcToLocal(utc, await envTz(env)), true);
    }
    case "binary": case "image": { // fields_binary.py:125 value.to_base64() (empty binary -> '')
      if (!isRecord(value)) return "";
      const content = value["content"];
      return typeof content === "string" ? content : "";
    }
    case "json": // fields_misc.py:82-85
      if (value === false || value === null || value === undefined || (isRecord(value) && Object.keys(value).length === 0)
        || (Array.isArray(value) && value.length === 0) || value === "" || value === 0) return "";
      return dumps(value);
    case "properties": case "properties_definition": // fields_properties.py:236
      if (value === false || value === null || (Array.isArray(value) && value.length === 0)) return "";
      throw new NotPorted(`export of a non-empty ${field.type} value (${field.name})`);
    case "reference": { // fields_reference.py:51-52: value.display_name if value else ''
      if (typeof value !== "string" || value === "") return "";
      const comma = value.indexOf(",");
      const id = Number(value.slice(comma + 1));
      if (comma <= 0 || !Number.isInteger(id) || id <= 0) throw new NotPorted(`export of the reference value ${value} (${field.name})`);
      const rows = await env.model(value.slice(0, comma)).read([id], ["display_name"], "");
      const name = rows[0]?.["display_name"];
      if (typeof name !== "string") throw new NotPorted(`export of a reference to a record without a display name (${field.name})`);
      return name;
    }
    case "many2one_reference":
      throw new NotPorted(`export of ${field.type} field ${field.name}`);
    case "char": case "text": case "html": // fields.py:1214
      return typeof value === "string" && value !== "" ? value : "";
    case "many2one": case "one2many": case "many2many":
      throw new Error("relational value reached convertToExport");
  }
}

/** An `id` cell before the top-level call resolves it: `(record._name, record.id)` (models.py:832-833). */
class XidRef {
  constructor(readonly model: string, readonly id: number) {}
}

/**
 * models.py:632-700 `__ensure_xml_id` for records that all have exactly one external id. Odoo builds a dict from an
 * unordered query (the last row of a record wins) and creates `__export__.<table>_<id>_<uuid8>` rows for the missing
 * ones: both cases refuse, the first is not deterministic and the second has a random name.
 */
async function ensureXmlIds(env: Environment, model: string, ids: readonly number[]): Promise<Map<number, string>> {
  const rows = (await env.cr.query<{ res_id: number; module: string | null; name: string }>(
    "SELECT res_id, module, name FROM ir_model_data WHERE model = $1 AND res_id = ANY($2::int[])", [model, [...ids]])).rows;
  const out = new Map<number, string>();
  for (const r of rows) {
    if (out.has(r.res_id)) throw new NotPorted(`export of the external id of ${model}(${r.res_id}), which has several`);
    out.set(r.res_id, r.module ? `${r.module}.${r.name}` : r.name);
  }
  if (ids.some((id) => !out.has(id))) throw new NotPorted("export of external ids of records without one (__ensure_xml_id creates __export__ rows)");
  return out;
}

/** models.py:711-922 `_export_rows(fields)` for records `ids` of `model`. */
export async function exportRows(env: Environment, model: string, ids: readonly number[], paths: readonly string[][]): Promise<Cell[][]> {
  const lines = await exportRowsInner(env, model, ids, paths);
  // models.py:902-916: the external ids, at top level only, per model
  if (!paths.some((p) => p.length && p[p.length - 1] === "id")) return lines as Cell[][];
  const byModel = new Map<string, Set<number>>();
  for (const line of lines) for (const cell of line) if (cell instanceof XidRef) byModel.set(cell.model, (byModel.get(cell.model) ?? new Set()).add(cell.id));
  const resolved = new Map<string, Map<number, string>>();
  for (const [m, set] of byModel) resolved.set(m, await ensureXmlIds(env, m, [...set]));
  return lines.map((line) => line.map((cell) => (cell instanceof XidRef ? resolved.get(cell.model)!.get(cell.id)! : cell)));
}

type RowCell = Cell | XidRef;

async function exportRowsInner(env: Environment, model: string, ids: readonly number[], paths: readonly string[][]): Promise<RowCell[][]> {
  const importCompatible = pyTruthy(env.context["import_compat"] ?? true);
  for (const path of paths) {
    if (!path.length) continue;
    const name = path[0]!;
    if (name.includes("@")) throw new NotPorted(`export of a translation path ${name}`);
    if (name !== ".id" && name.includes(".")) throw new NotPorted(`export of a properties path ${name}`);
  }
  const names = [...new Set(paths.filter((p) => p.length && p[0] !== ".id" && p[0] !== "id").map((p) => p[0]!))];
  const values = await fetchValues(env, model, ids, names);
  const lines: RowCell[][] = [];
  for (const id of ids) {
    const row = values.rows.get(id);
    if (row === undefined && names.length) throw new NotPorted(`export of a missing or inaccessible record ${model}(${id})`);
    const current: RowCell[] = paths.map(() => "");
    lines.push(current);
    const primaryDone: string[] = [];
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i]!;
      if (!path.length) continue;
      const name = path[0]!;
      if (primaryDone.includes(name)) continue;
      if (name === ".id") {
        current[i] = String(id);
        continue;
      }
      if (name === "id") {
        current[i] = new XidRef(model, id);
        continue;
      }
      const field = values.fields.get(name)!;
      const value = row![name];
      const relational = field.type === "many2one" || field.type === "one2many" || field.type === "many2many";
      if (!relational) {
        current[i] = await convertToExport(env, field, value, values.selections.get(name));
        continue;
      }
      primaryDone.push(name);
      const subIds: number[] = field.type === "many2one"
        ? (typeof value === "number" && value > 0 ? [value] : [])
        : (Array.isArray(value) ? value.filter((x): x is number => typeof x === "number") : []);
      const fields2 = paths.map((p) => (p.length && p[0] === name ? (p.length > 1 ? p.slice(1) : ["display_name"]) : []));
      if (importCompatible && field.type === "many2many") {
        let index: number | null = null;
        let found: string | null = null;
        for (const n of ["id", "name", "display_name"]) {
          const j = fields2.findIndex((p) => p.length === 1 && p[0] === n);
          if (j >= 0) {
            index = j;
            found = n;
            break;
          }
        }
        if (index === null) index = i;
        if (found === "id") {
          const xids = await ensureXmlIds(env, field.relation!, subIds);
          current[index] = subIds.map((s) => xids.get(s)!).join(",");
        } else if (!subIds.length) current[index] = "";
        else {
          const rows = await env.model(field.relation!).read(subIds, ["display_name"], "");
          const byId = new Map(rows.map((r) => [Number(r["id"]), String(r["display_name"])]));
          current[index] = subIds.map((s) => byId.get(s) ?? "").join(",");
        }
        continue;
      }
      const lines2 = await exportRowsInner(env, field.relation!, subIds, fields2);
      if (lines2.length) {
        lines2[0]!.forEach((val, j) => {
          if (mergeable(val)) current[j] = val;
        });
        lines.push(...lines2.slice(1));
      } else current[i] = "";
    }
  }
  return lines;
}

/** models.py:924-937 `export_data`: the export right, then `_export_rows` on the fixed paths. */
export async function exportData(env: Environment, model: string, ids: readonly number[], fieldsToExport: readonly string[]): Promise<Cell[][]> {
  // environments.py is_admin: superuser or base.group_erp_manager (res_users.py:1292-1294)
  const isAdmin = env.su || env.uid === 1 || (await hasGroup(env, "base.group_erp_manager"));
  if (!(isAdmin || (await hasGroup(env, "base.group_allow_export")))) {
    throw new UserError(translate(env, "You don't have the rights to export data. Please contact an Administrator."));
  }
  return exportRows(env, model, ids, fieldsToExport.map(fixImportExportIdPaths));
}

/** export.py:407-415 `filename(base)`: "<ir.model name> (<model>)" when the model exists. */
function exportFilename(env: Environment, model: string): string {
  if (!env.reg.models.has(model)) return model;
  const def = env.reg.model(model);
  const lang = env.lang ?? "en_US";
  return `${def.descriptions[lang] ?? def.description} (${model})`;
}

/** export.py:431-517 `ExportFormat.base(data)` for CSV and xlsx (:569-606 ExcelExport). */
async function csvBase(ctx: RequestContext, data: string, format: "csv" | "xlsx" = "csv"): Promise<Response> {
  let params: unknown;
  try {
    params = JSON.parse(data);
  } catch {
    throw new OdooError("json.decoder.JSONDecodeError", "Expecting value");
  }
  if (!isRecord(params)) throw new OdooError("builtins.TypeError", "export parameters must be an object");
  for (const k of ["model", "fields", "ids", "domain", "import_compat"]) {
    if (!(k in params)) throw new OdooError("builtins.KeyError", `'${k}'`);
  }
  const model = params["model"];
  const fieldsRaw = params["fields"];
  const ids = params["ids"];
  const importCompat = params["import_compat"];
  if (typeof model !== "string" || !Array.isArray(fieldsRaw)) throw new OdooError("builtins.TypeError", "invalid export parameters");
  const env0 = await ctx.orm();
  if (!env0.reg.models.has(model)) throw new OdooError("builtins.KeyError", `'${model}'`);
  const extra = isRecord(params["context"]) ? params["context"] : {};
  // export.py:436: request.env[model].with_context(import_compat=import_compat, **params.get('context', {}))
  const env = env0.withContext({ ...env0.context, import_compat: importCompat, ...extra } as Context);
  let fields = fieldsRaw.filter(isRecord);
  if (!(await isOrdinaryTable(env, model))) fields = fields.filter((f) => f["name"] !== "id");
  const fieldNames = fields.map((f) => String(f["name"]));
  const columnsHeaders = pyTruthy(importCompat) ? fieldNames : fields.map((f) => String(f["label"]).trim());

  let recordIds: number[];
  if (Array.isArray(ids) && ids.length) {
    if (!ids.every((x): x is number => typeof x === "number" && Number.isInteger(x))) throw new NotPorted("export of non-integer ids");
    recordIds = ids;
  } else {
    recordIds = await env.model(model).search(parseDomain(params["domain"] ?? []));
  }
  const groupby = params["groupby"];
  const grouped = !pyTruthy(importCompat) && Array.isArray(groupby) && groupby.length > 0;
  // CSVExport.from_group_data (export.py:543-544)
  if (grouped && format !== "xlsx") throw new UserError(translate(env, "Exporting grouped data to csv is not supported."));
  const rows: XlsxRow[] = [];
  if (grouped) {
    // export.py:449-493: the search of the groups runs on the given ids without active_test, else on the domain
    const byIds = Array.isArray(ids) && ids.length > 0;
    rows.push(...(await groupedRows(byIds ? env.withContext({ ...env.context, active_test: false } as Context) : env, model,
      fields.map((f) => ({ name: String(f["name"]), type: String(f["type"] ?? "char") })), (groupby as unknown[]).map(String), recordIds,
      parseDomain(byIds ? [["id", "in", recordIds]] : params["domain"] ?? []),
      await exportData(env, model, recordIds, [".id", ...fieldNames]))));
  } else {
    // split_every(IN_MAX, records.ids): IN_MAX batches (odoo/tools/constants.py) only bound the queries
    for (let i = 0; i < recordIds.length; i += 1000) {
      rows.push(...(await exportData(env, model, recordIds.slice(i, i + 1000), fieldNames)));
    }
  }
  if (format === "xlsx") {
    // export.py:183-184: the largest decimal_places of all currencies for the monetary format
    const dp = (await env.cr.query<{ dp: number | null }>("SELECT max(decimal_places) AS dp FROM res_currency")).rows[0]?.dp;
    // export.py:236-237 (too long cells)
    const tooLong = translate(env, "The content of this cell is too long for an XLSX file (more than %s characters). Please use the CSV format for this export.").replace("%s", String(XLS_STRMAX));
    const xlsx = buildXlsx(columnsHeaders, rows, fields.map((f) => String(f["type"] ?? "char")), dp || 2, tooLong);
    return new Response(xlsx, {
      status: 200,
      headers: {
        "Content-Disposition": contentDispositionAttachment(cleanFilename(exportFilename(env0, model) + ".xlsx")),
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  }
  const body = csvFromData(columnsHeaders, rows as ExportCell[][]);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Disposition": contentDispositionAttachment(cleanFilename(exportFilename(env0, model) + ".csv")),
      "Content-Type": "text/csv;charset=utf8",
    },
  });
}

// export.py:522-533: any exception becomes an InternalServerError whose description is the JSON payload
route("/web/export/csv", async (ctx) => {
  const data = ctx.params["data"];
  if (typeof data !== "string") throw new OdooError("builtins.TypeError", "CSVExport.web_export_csv() missing 1 required positional argument: 'data'");
  try {
    return await csvBase(ctx, data);
  } catch (e) {
    if (e instanceof OdooError) {
      throw new HttpError(500, dumps({ code: 0, message: "Odoo Server Error", data: e.data() }));
    }
    throw e;
  }
}, { auth: "user" });

// export.py:571-582: as /web/export/csv, any exception becomes an InternalServerError carrying the JSON payload
route("/web/export/xlsx", async (ctx) => {
  const data = ctx.params["data"];
  if (typeof data !== "string") throw new OdooError("builtins.TypeError", "ExcelExport.web_export_xlsx() missing 1 required positional argument: 'data'");
  try {
    return await csvBase(ctx, data, "xlsx");
  } catch (e) {
    if (e instanceof OdooError) {
      throw new HttpError(500, dumps({ code: 0, message: "Odoo Server Error", data: e.data() }));
    }
    throw e;
  }
}, { auth: "user" });
