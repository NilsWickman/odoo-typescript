/**
 * `ir.fields.converter` (odoo/odoo/addons/base/models/ir_fields.py): the string-to-write-value conversion of
 * `BaseModel.load` (`for_model` :97-158, the `_str_to_<type>` converters :209-701, `db_id_for` :480-596).
 *
 * Errors and warnings travel as {@link ImportProblem} (Python raises `ValueError(message, info)` or returns
 * `ImportWarning`s); `message` keeps its `%(field)s` placeholder, formatted by load's `_log` (models.py:1255-1275).
 * Refused (NotPorted): properties and json values, datetimes, external ids of other modules' records
 * (`_xmlid_to_record_id` is ported, its import flush of not-yet-created records is not), name_create of missing
 * related records, and translations of the messages outside en_US.
 */
import { hooksOf } from "../orm/hooks";
import { NotPorted } from "../errors";
import { TRUE } from "../orm/domain";
import type { Environment, FieldDef } from "../orm/types";
import { translate } from "./util";

export const REFERENCING_FIELDS: ReadonlySet<string | null> = new Set([null, "id", ".id"]);
/** The display-name sub-field of `_extract_records` (`fnames[1:] or [None]`). */
export const NAME_KEY = "\u0000name";

export type ImportRecord = Record<string, unknown>;

/** A Python `ValueError(msg, info)` (`warning=false`) or `ImportWarning(msg)` (`warning=true`) of the converters. */
export class ImportProblem extends Error {
  constructor(readonly msg: string, readonly info: Record<string, unknown> | null = null, readonly warning = false) {
    super(msg);
    this.name = warning ? "ImportWarning" : "ValueError";
  }
}

/** ir_fields.py:48-58 `_format_import_error`: params are %-escaped then substituted into the message. */
function formatError(msg: string, params: string | Record<string, unknown>, info: Record<string, unknown> | null = null, warning = false): ImportProblem {
  const sanitize = (p: unknown): unknown => (typeof p === "string" ? p.replace(/%/g, "%%") : p);
  let out: string;
  if (typeof params === "string") out = pyPercent(msg, [sanitize(params)]);
  else out = pyPercent(msg, Object.fromEntries(Object.entries(params).map(([k, v]) => [k, sanitize(v)])));
  return new ImportProblem(out, info, warning);
}

/** Python `msg % args` for `%s`, `%(name)s` and `%%`. */
export function pyPercent(msg: string, args: unknown[] | Record<string, unknown>): string {
  let i = 0;
  return msg.replace(/%(\(([^)]+)\))?([s%d])/g, (_m, _g, name: string | undefined, conv: string) => {
    if (conv === "%") return "%";
    const v = name !== undefined ? (args as Record<string, unknown>)[name] : (args as unknown[])[i++];
    if (v === undefined) throw new NotPorted(`%-format of a missing key ${String(name)}`);
    return pyStrScalar(v);
  });
}

function pyStrScalar(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

type Converter = (value: unknown) => Promise<[unknown, ImportProblem[]]>;

export interface ConverterContext {
  /** `import_flush(model=...)` of load (models.py:997-1018): create the pending batch before a name_search. */
  readonly flush: (opts: { model?: string; xmlId?: string }) => Promise<void>;
}

const BOOLEAN_TRANSLATIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // odoo/odoo/addons/base/i18n/fr.po:22475-22476, :22631-22632, :22752-22753, :22796-22797
  fr_FR: { true: "vrai", yes: "oui", false: "faux", no: "non" },
};

/** ir_fields.py:406-421 `_get_boolean_translations(src)`: the base module's translation in every installed language. */
async function booleanTranslations(env: Environment, src: string): Promise<string[]> {
  const langs = (await env.cr.query<{ code: string }>("SELECT code FROM res_lang WHERE active ORDER BY name")).rows.map((r) => r.code);
  const out: string[] = [];
  for (const lang of langs) {
    if (lang === "en_US") continue;
    const t = BOOLEAN_TRANSLATIONS[lang];
    if (t === undefined) throw new NotPorted(`base translations of booleans for ${lang}`);
    const v = t[src];
    if (v !== undefined && !out.includes(v)) out.push(v);
  }
  return out;
}

/** ir_fields.py:311-339 `_str_to_boolean`. */
async function strToBoolean(env: Environment, field: FieldDef, value: string): Promise<[unknown, ImportProblem[]]> {
  const trues = new Set(["1", "true", "yes", ...(await booleanTranslations(env, "true")), ...(await booleanTranslations(env, "yes"))].map((w) => w.toLowerCase()));
  if (trues.has(value.toLowerCase())) return [true, []];
  const falses = new Set(["", "0", "false", "no", ...(await booleanTranslations(env, "false")), ...(await booleanTranslations(env, "no"))].map((w) => w.toLowerCase()));
  if (falses.has(value.toLowerCase())) return [false, []];
  if (listCtx(env, "import_skip_records").includes(field.name)) return [null, []];
  return [true, [formatError(translate(env, "Unknown value '%s' for boolean field '%%(field)s'"), value,
    { moreinfo: translate(env, "Use '1' for yes and '0' for no") }, true)]];
}

function listCtx(env: Environment, key: string): string[] {
  const v = env.context[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Python `int(str)`: optional sign, digits with single underscores, surrounding whitespace. */
function pyInt(value: string): number | null {
  const m = /^\s*([+-]?\d+(?:_\d+)*)\s*$/.exec(value);
  return m ? Number(m[1]!.replace(/_/g, "")) : null;
}

/** Python `float(str)` for decimal literals, inf and nan. */
function pyFloat(value: string): number | null {
  const s = value.trim().replace(/(\d)_(?=\d)/g, "$1");
  if (/^[+-]?((\d+\.?\d*)|(\.\d+))([eE][+-]?\d+)?$/.test(s)) return Number(s);
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(s)) throw new NotPorted("import of a NaN float");
  return null;
}

/** ir_fields.py:449-478 `_str_to_selection`. */
async function strToSelection(env: Environment, model: string, field: FieldDef, value: string): Promise<[unknown, ImportProblem[]]> {
  // untranslated selection (lang=None); static selections also accept their translations (ir_model_fields_selection)
  if (field.selection === null) {
    // a callable selection: `get_description(lang=None)` and the env lang's `_description_selection` (:455-460)
    const fn = hooksOf(model).selection?.[field.name];
    if (fn === undefined) throw new NotPorted(`import into the callable selection ${model}.${field.name} (_description_selection labels)`);
    const { lang: _lang, ...noLang } = env.context;
    const base = await fn(env.withContext(noLang));
    const local = env.lang && env.lang !== "en_US" ? await fn(env) : base;
    for (const [item, label] of base) {
      const labels = [label, ...local.filter(([i]) => i === item).slice(0, 1).map(([, l]) => l)];
      if (value.toLowerCase() === String(item).toLowerCase() || labels.some((l) => value.toLowerCase() === String(l).toLowerCase())) return [item, []];
    }
    if (listCtx(env, "import_skip_records").includes(field.name)) return [null, []];
    if (listCtx(env, "import_set_empty_fields").includes(field.name)) return [false, []];
    throw formatError(translate(env, "Value '%s' not found in selection field '%%(field)s'"), value,
      { moreinfo: base.filter(([item, l]) => l || item).map(([item, l]) => l || item) });
  }
  const selection: [string, string][] = field.selection.map((s) => [s.value, s.label]);
  for (const [item, label] of selection) {
    const s = field.selection!.find((x) => x.value === item);
    const labels = [label, ...Object.entries(s?.labels ?? {}).filter(([l]) => l !== "en_US").map(([, v]) => v)];
    if (value.toLowerCase() === item.toLowerCase() || labels.some((l) => value.toLowerCase() === l.toLowerCase())) return [item, []];
  }
  if (listCtx(env, "import_skip_records").includes(field.name)) return [null, []];
  if (listCtx(env, "import_set_empty_fields").includes(field.name)) return [false, []];
  throw formatError(translate(env, "Value '%s' not found in selection field '%%(field)s'"), value,
    { moreinfo: selection.filter(([item, l]) => l || item).map(([item, l]) => l || item) });
}

/** ir_fields.py:598-621 `_xmlid_to_record_id`. */
async function xmlidToRecordId(env: Environment, xmlid: string, comodel: string): Promise<number | null> {
  const dot = xmlid.indexOf(".");
  const module = xmlid.slice(0, dot), name = xmlid.slice(dot + 1);
  const table = env.reg.model(comodel).table;
  const r = (await env.cr.query<{ model: string; res_id: number }>(
    `SELECT d.model, d.res_id FROM ir_model_data d JOIN "${table}" r ON d.res_id = r.id WHERE d.module = $1 AND d.name = $2 LIMIT 1`,
    [module, name])).rows[0];
  if (r === undefined) return null;
  if (r.model !== comodel) throw new ImportProblem(`Invalid external ID ${xmlid}: expected model '${comodel}', found '${r.model}'`);
  return r.res_id;
}

/** ir_fields.py:480-596 `db_id_for(model, field, subfield, value)`. */
export async function dbIdFor(env: Environment, cc: ConverterContext, field: FieldDef, subfield: string | null, value: string): Promise<[number | false | null, ImportProblem[]]> {
  const comodel = field.relation!;
  let id: number | null = null;
  const warnings: ImportProblem[] = [];
  const action: Record<string, unknown> = {
    name: "Possible Values", type: "ir.actions.act_window", target: "new", view_mode: "list,form",
    views: [[false, "list"], [false, "form"]], context: { create: false }, help: translate(env, "See all possible values"),
  };
  if (subfield === null) action["res_model"] = comodel;
  else { action["res_model"] = "ir.model.data"; action["domain"] = [["model", "=", comodel]]; }
  let fieldType: string;
  if (subfield === ".id") {
    fieldType = translate(env, "database id");
    if (!(await strToBoolean(env, field, value))[0]) return [false, warnings];
    const tentative = pyInt(value);
    if (tentative === null) throw formatError(translate(env, "Invalid database id '%s' for the field '%%(field)s'"), value, { moreinfo: action });
    const exists = await env.cr.query("SELECT 1 FROM \"" + env.reg.model(comodel).table + "\" WHERE id = $1", [tentative]);
    if (exists.rows.length) id = tentative;
  } else if (subfield === "id") {
    fieldType = translate(env, "external id");
    if (!(await strToBoolean(env, field, value))[0]) return [false, warnings];
    const xmlid = value.includes(".") ? value : `${String(env.context["_import_current_module"] ?? "")}.${value}`;
    await cc.flush({ xmlId: xmlid });
    id = await xmlidToRecordId(env, xmlid, comodel);
  } else if (subfield === null) {
    fieldType = translate(env, "name");
    if (value === "") return [false, warnings];
    await cc.flush({ model: comodel });
    const ids = await env.model(comodel).nameSearch(value, TRUE, "=", 100);
    if (ids.length) {
      if (ids.length > 1) {
        warnings.push(new ImportProblem(pyPercent(translate(env, 'Found multiple matches for value "%(value)s" in field "%%(field)s" (%(match_count)s matches)'),
          { value: value.replace(/%/g, "%%"), match_count: ids.length }), null, true));
      }
      id = ids[0]![0];
    } else {
      const enabled = env.context["name_create_enabled_fields"];
      if (enabled && typeof enabled === "object" && (enabled as Record<string, unknown>)[field.name]) {
        throw new NotPorted("import name_create of a missing related record");
      }
    }
  } else {
    throw new ImportProblem(pyPercent(translate(env, "Unknown sub-field “%s”"), [subfield]));
  }
  let setEmpty = false, skipRecord = false;
  if (env.context["import_file"]) {
    const hierarchy = listCtx(env, "parent_fields_hierarchy");
    const path = [...hierarchy, field.name].join("/");
    setEmpty = listCtx(env, "import_set_empty_fields").includes(path);
    skipRecord = listCtx(env, "import_skip_records").includes(path);
  }
  if (id === null && !setEmpty && !skipRecord) {
    const message = translate(env, "No matching record found for %(field_type)s '%(value)s' in field '%%(field)s'");
    const info: Record<string, unknown> = { moreinfo: action };
    if (env.context["import_file"]) Object.assign(info, { value: value.slice(0, 50), field_type: fieldType });
    throw formatError(message, { field_type: fieldType, value, error_message: "" }, info);
  }
  return [id, warnings];
}

/** ir_fields.py:623-645 `_referencing_subfield`. */
function referencingSubfield(env: Environment, record: ImportRecord): string | null {
  const keys = Object.keys(record).map((k) => (k === NAME_KEY ? null : k));
  if (keys.some((k) => !REFERENCING_FIELDS.has(k))) {
    throw new ImportProblem(translate(env, "Can not create Many-To-One records indirectly, import the field separately"));
  }
  if (keys.length > 1) {
    throw new ImportProblem(translate(env, "Ambiguous specification for field '%(field)s', only provide one of name, external id or database id"));
  }
  return keys[0] ?? null;
}

function refValue(record: ImportRecord, subfield: string | null): string {
  const v = record[subfield === null ? NAME_KEY : subfield];
  return typeof v === "string" ? v : String(v ?? "");
}

/** ir_fields.py:161-207 `to_field`: the converter of a field type, or null when there is none. */
function toField(env: Environment, cc: ConverterContext, model: string, field: FieldDef): Converter | null {
  switch (field.type) {
    case "char": case "text": case "html": case "binary": case "image": case "reference":
      // `_str_id`; image is a Binary subclass whose type is 'binary' in Python's fields_get, 'image' here
      return async (v) => [v, []];
    case "boolean": return async (v) => strToBoolean(env, field, String(v));
    case "integer": return async (v) => {
      const n = pyInt(String(v));
      if (n === null) throw formatError(translate(env, "'%s' does not seem to be an integer for field '%%(field)s'"), String(v));
      return [n, []];
    };
    case "many2one_reference": return toField(env, cc, model, { ...field, type: "integer" });
    case "float": case "monetary": return async (v) => {
      const n = pyFloat(String(v));
      if (n === null) throw formatError(translate(env, "'%s' does not seem to be a number for field '%%(field)s'"), String(v));
      return [n, []];
    };
    case "date": return async (v) => {
      const s = String(v);
      // fields.Date.from_string: strptime('%Y-%m-%d') of the first 10 characters' worth
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
        throw formatError(translate(env, "'%s' does not seem to be a valid date for field '%%(field)s'"), s,
          { moreinfo: pyPercent(translate(env, "Use the format '%s'"), ["2012-12-31"]) });
      }
      return [s, []];
    };
    case "datetime": return async () => { throw new NotPorted("import of datetime values (input tz conversion)"); };
    case "selection": return async (v) => strToSelection(env, model, field, String(v));
    case "json": case "properties": case "properties_definition":
      return async () => { throw new NotPorted(`import of ${field.type} values`); };
    case "many2one": return async (values) => {
      const records = values as ImportRecord[];
      if (records.length !== 1) throw new NotPorted("many2one import with several sub-records");
      const subfield = referencingSubfield(env, records[0]!);
      return dbIdFor(env, cc, field, subfield, refValue(records[0]!, subfield));
    };
    case "many2many": return async (values) => {
      const records = values as ImportRecord[];
      if (records.length !== 1) throw new NotPorted("many2many import with several sub-records");
      const subfield = referencingSubfield(env, records[0]!);
      const ids: (number | false | null)[] = [];
      const warnings: ImportProblem[] = [];
      for (const reference of refValue(records[0]!, subfield).split(",")) {
        const [id, ws] = await dbIdFor(env, cc, field, subfield, reference);
        ids.push(id);
        warnings.push(...ws);
      }
      let out = ids;
      if (listCtx(env, "import_set_empty_fields").includes(field.name) && ids.some((x) => x === null)) out = ids.filter((x) => x);
      else if (listCtx(env, "import_skip_records").includes(field.name) && ids.some((x) => x === null)) return [null, warnings];
      if (env.context["update_many2many"]) return [out.map((id) => [4, id, 0]), warnings];
      return [[[6, 0, out.map((x) => (x === null ? false : x))]], warnings];
    };
    case "one2many":
      return async () => { throw new NotPorted("import of one2many sub-records (_str_to_one2many)"); };
  }
}

export type ConvertLog = (field: string, problem: ImportProblem) => void;

/** ir_fields.py:97-158 `for_model(model)` applied to one record. */
export async function convertRecord(env: Environment, cc: ConverterContext, model: string, record: ImportRecord, log: ConvertLog): Promise<Record<string, unknown>> {
  const def = env.reg.model(model);
  const converted: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(record)) {
    if (name === NAME_KEY || REFERENCING_FIELDS.has(name)) continue;
    if (value === "" || value === null || value === undefined || value === false || (Array.isArray(value) && value.length === 0)) {
      converted[name] = false;
      continue;
    }
    const field = def.fields.get(name);
    if (!field) throw new NotPorted(`import into unknown field ${model}.${name}`);
    if (field.translate && typeof value === "object" && !Array.isArray(value)) throw new NotPorted("import of field@lang translations");
    const conv = toField(env, cc, model, field);
    if (conv === null) throw new NotPorted(`import converter for ${field.type}`);
    try {
      const [v, ws] = await conv(value);
      converted[name] = v;
      for (const w of ws) log(name, w);
    } catch (e) {
      if (!(e instanceof ImportProblem)) throw e;
      if (env.context["import_file"] && e.info && !e.info["field_path"]) {
        e.info["field_path"] = [...listCtx(env, "parent_fields_hierarchy"), name];
      }
      log(name, e);
    }
  }
  return converted;
}

