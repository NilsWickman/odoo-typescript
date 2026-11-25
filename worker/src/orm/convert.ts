/**
 * Write-path value conversion per field type: `convert_to_cache` (write format -> cache format) and
 * `convert_to_column[_insert]` (cache format -> SQL parameter), odoo/odoo/orm/fields*.py.
 *
 * Cache format used by the port (the same as `ModelImpl.values`, src/orm/values.ts fromPg):
 * boolean -> boolean; integer -> number; float/monetary -> number | null; char/text/html/selection -> string | null;
 * date/datetime -> "YYYY-MM-DD[ HH:MM:SS]" | null; many2one -> id | null; x2many -> ids; json/properties -> value | null;
 * binary -> BinaryValue | null.
 */
import { NotPorted } from "../errors";
import { OdooValueError } from "./commands";
import type { FieldDef } from "./types";
import { isPyFloat, PreciseDatetime } from "./values";
import { Markup, PyTuple } from "../pyexpr/values";

function num(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (isPyFloat(v)) return v.float;
  return null;
}

/** Python truthiness of a JSON value. */
export function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (isPyFloat(v)) return v.float !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** Python `round()` (half to even) of a float to an integer. */
function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** odoo/tools/float_utils.py:72 float_round(value, precision_digits=d), HALF-UP with the epsilon correction. */
/** A JSON value's deep copy (the json round trip), keeping PyFloat values as floats. */
function jsonClone(value: unknown): unknown {
  if (isPyFloat(value)) return { float: value.float };
  if (Array.isArray(value)) return value.map(jsonClone);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, jsonClone(v)]));
  return value;
}

export function floatRound(value: number, digits: number): number {
  if (value === 0) return 0;
  // rounding_factor = 10**-digits < 1 is inverted (float_utils.py:117): normalize multiplies by 10**digits
  const factor = 10 ** digits;
  const normalized = digits > 0 ? value * factor : value / 10 ** -digits;
  const epsilon = 2 ** (Math.log2(Math.abs(normalized)) - 50);
  const rounded = roundHalfEven(normalized + Math.sign(normalized) * epsilon);
  return digits > 0 ? rounded / factor : rounded * 10 ** -digits;
}

/** float_utils.py:72 float_round(value, precision_digits=d, rounding_method='UP'): away from zero, with the epsilon. */
export function floatRoundUp(value: number, digits: number): number {
  if (value === 0) return 0;
  const factor = 10 ** digits;
  const normalized = digits > 0 ? value * factor : value / 10 ** -digits;
  const epsilon = 2 ** (Math.log2(Math.abs(normalized)) - 50);
  const rounded = Math.trunc(normalized + Math.sign(normalized) * (1 - epsilon));
  return digits > 0 ? rounded / factor : rounded * 10 ** -digits;
}

/** float_utils.py:403-424 float_invert, with its table of exact inverses. */
export function floatInvert(value: number): number {
  for (const m of [1, 2, 5]) for (let e = 1; e <= 10; e++) {
    if (value === Number(`${m}e-${e}`)) return Number(`${m === 1 ? 1 : m === 2 ? 5 : 2}e+${m === 1 ? e : e - 1}`);
  }
  const [coef, exp] = value.toExponential(15).split("e") as [string, string];
  return Number(`${coef}e${-Number(exp)}`) / Number(coef) ** 2;
}

/** float_utils.py:72 float_round(value, precision_rounding=r), HALF-UP. */
export function floatRoundRounding(value: number, rounding: number): number {
  if (rounding === 0 || value === 0) return 0;
  const inv = rounding < 1 ? floatInvert(rounding) : 0;
  const normalized = rounding < 1 ? value * inv : value / rounding;
  const epsilon = 2 ** (Math.log2(Math.abs(normalized)) - 50);
  const rounded = roundHalfEven(normalized + Math.sign(normalized) * epsilon);
  return rounding < 1 ? rounded / inv : rounded * rounding;
}

/** float_utils.py:313 float_repr: "%.*f" after float_is_zero. */
export function floatRepr(value: number, digits: number): string {
  const zero = Math.abs(floatRound(value, digits)) < 10 ** -digits / 2;
  return (zero ? 0 : value).toFixed(digits);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

import { dumps, pyFloatRepr } from "../http/json";

/**
 * `Field.convert_to_cache(value, records, validate=True)` for the write format. `activeLangs` is needed for
 * translated dict values (fields_textual.py:115-134).
 */
export function convertToCache(field: FieldDef, value: unknown, model: string): unknown {
  const where = `${model}.${field.name}`;
  switch (field.type) {
    case "boolean":
      // fields_misc.py:30 bool(value)
      return pyTruthy(value);
    case "integer": {
      // fields_numeric.py:35: dict -> value['id']; int(value or 0)
      if (typeof value === "object" && value !== null && !Array.isArray(value) && !isPyFloat(value)) {
        const id = (value as Record<string, unknown>)["id"];
        return typeof id === "number" ? id : null;
      }
      if (!pyTruthy(value)) return 0;
      const n = num(value);
      if (n === null) {
        if (value === true) return 1;
        // Python int(str): optional sign and whitespace, digits with single underscores (a CSV value of a chart
        // template, chart_template.py:1325-1336 only literal_evals 'int'-typed fields, so integers stay text)
        if (typeof value === "string" && /^\s*[+-]?\d+(_\d+)*\s*$/.test(value)) return parseInt(value.replace(/_/g, "").trim(), 10);
        throw new NotPorted(`int(${JSON.stringify(value)}) for ${where}`);
      }
      return Math.trunc(n);
    }
    case "float": {
      // fields_numeric.py:169: float(value or 0.0) rounded to the field's digits
      if (!pyTruthy(value)) return 0;
      const n = num(value);
      if (n === null) {
        if (value === true) return 1;
        throw new NotPorted(`float(${JSON.stringify(value)}) for ${where}`);
      }
      return field.digits ? floatRound(n, field.digits[1]) : n;
    }
    case "monetary": {
      // fields_numeric.py:271: float(value or 0.0); the currency rounding is applied by the caller (roundMonetary),
      // which knows the record's currency
      if (!pyTruthy(value)) return 0;
      const n = num(value);
      if (n === null) {
        if (value === true) return 1;
        throw new NotPorted(`float(${JSON.stringify(value)}) for ${where}`);
      }
      return n;
    }
    case "char":
    case "text":
    case "html": {
      if (value === false || value === null || value === undefined) return null;
      // markupsafe.Markup is a str: its text (a compiled default returning web's nl2br_enclose, base.document.layout)
      if (value instanceof Markup) return convertToCache(field, value.toString(), model);
      if (field.translate && typeof value === "object") throw new NotPorted(`translated dict value for ${where}`);
      if (typeof value !== "string") {
        if (typeof value === "number") return String(value);
        // fields_textual.py:137 `str(value)` of a list of ints (e.g. the composer's res_ids): "[5, 7]"; a JSON
        // number may have been a Python float elsewhere, so other shapes refuse
        if (Array.isArray(value) && value.every((x) => typeof x === "number" && Number.isInteger(x))) return `[${value.join(", ")}]`;
        // `str(list)` of a domain evaluated in a data file (l10n_kr simplified_tax_report.xml: account.report.expression
        // formula `eval="[('move_id.l10n_kr_issuance_type', '=', ...), ...]"`): repr of its strings, integers and the
        // evaluator's tuples (PyTuple); a float leaf refuses (pyLiteralRepr)
        if (Array.isArray(value)) return pyLiteralRepr(value, where);
        // `str(dict)`: ir.actions.act_window.context's default {} (ir_actions.py `fields.Char(default={})`) and
        // dicts evaluated in data files (`<field name="context" eval="{...}"/>`)
        if (value instanceof Map || (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)) return pyLiteralRepr(value, where);
        throw new NotPorted(`str(${JSON.stringify(value)}) for ${where}`);
      }
      // odoo/tools/mail.py html_sanitize keeps a lone <p>/<div> (data-oe-version is in safe_attrs, :68-73) around
      // plain text unchanged: that one shape is stored as given (the web editor's single-paragraph value)
      if (field.type === "html" && field.sanitize?.["sanitize"] && /^<(p|div)( data-oe-version="\d+(\.\d+)*")?>[^<>&\n]*[^<>&\s][^<>&\n]*<\/\1>$/.test(value)) {
        return value;
      }
      if (field.type === "html" && field.sanitize?.["sanitize"] && value !== "") {
        // fields_textual.py:731 html_sanitize (odoo/tools/mail.py, lxml): not ported, refuse instead of storing raw
        // markup (PORTING_odoo.md 12.1, 12.11)
        throw new NotPorted(`html_sanitize for ${where}`);
      }
      return value;
    }
    case "selection": {
      // fields_selection.py:228; callable selections are not validated (PORTING_odoo.md 12.5)
      if (value === false || value === null || value === undefined) return null;
      const s = typeof value === "string" ? value : num(value) !== null ? String(num(value)) : null;
      if (s === null) throw new NotPorted(`selection value ${JSON.stringify(value)} for ${where}`);
      if (field.selection && !field.selection.some((o) => o.value === s)) {
        throw new OdooValueError(`Wrong value for ${where}: '${s}'`);
      }
      return s;
    }
    case "many2one": {
      // fields_relational.py:326-349: int, (id, name) tuple (none in JSON), recordset, dict -> new record; else None
      if (typeof value === "number" && Number.isInteger(value)) return value === 0 ? null : value;
      if (typeof value === "object" && value !== null && !Array.isArray(value) && !isPyFloat(value)) {
        const dict = value as Record<string, unknown>;
        if (Object.keys(dict).some((k) => k !== "id")) throw new NotPorted(`many2one dict value with fields for ${where}`);
        return typeof dict["id"] === "number" ? dict["id"] : null;
      }
      return null;
    }
    case "date":
      if (!pyTruthy(value)) return null;
      if (typeof value === "string" && DATE_RE.test(value)) return value;
      // fields_temporal.py:178 `to_date`: a string is cut to DATE_LENGTH first ('2026-11-15 00:00' -> '2026-11-15')
      if (typeof value === "string" && DATE_RE.test(value.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}[ T]/.test(value)) return value.slice(0, 10);
      throw new NotPorted(`date value ${JSON.stringify(value)} for ${where}`);
    case "datetime":
      if (!pyTruthy(value)) return null;
      if (typeof value === "string" && DATETIME_RE.test(value)) return value;
      if (value instanceof PreciseDatetime) return value.text;
      // fields_temporal.py:263-264 `to_datetime`: a partial value parsed with DATETIME_FORMAT[:len(value) - 2] (a data
      // file's `time.strftime('%Y-%m-10')`: midnight); the zero-padded forms
      if (typeof value === "string") {
        const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?: (\d{2})(?::(\d{2}))?)?)?)?$/.exec(value);
        if (m) {
          const full = `${m[1]}-${m[2] ?? "01"}-${m[3] ?? "01"} ${m[4] ?? "00"}:${m[5] ?? "00"}:00`;
          if (DATETIME_RE.test(full)) return full;
        }
      }
      throw new NotPorted(`datetime value ${JSON.stringify(value)} for ${where}`);
    case "json":
      // fields_misc.py:70 json round trip; falsy -> None (a PyFloat stays a float: analytic distributions)
      if (!pyTruthy(value)) return null;
      return jsonClone(value);
    case "properties":
    case "properties_definition":
      if (!pyTruthy(value)) return null;
      throw new NotPorted(`properties write ${where}`);
    case "binary":
    case "image":
      if (!pyTruthy(value)) return null;
      // fields_binary.py:71-93: a column Binary (attachment=False) stores the decoded bytes; an RPC string is
      // base64, decoded with validate=True
      // :94-104 a dict {filename, content} (the web client's upload): the content, base64
      if (field.type === "binary" && field.column && !field.attachment && typeof value === "object" && value !== null && !Array.isArray(value)
          && Object.keys(value).every((k) => k === "filename" || k === "content") && typeof (value as Record<string, unknown>)["content"] === "string") {
        value = (value as Record<string, unknown>)["content"];
      }
      if (field.type === "binary" && field.column && !field.attachment && typeof value === "string") {
        const b64 = value.replace(/\s+/g, "");
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)) throw new NotPorted(`binary write ${where}: invalid base64 (binascii.Error)`);
        const bytes = Buffer.from(b64, "base64");
        if (!bytes.length) return null;
        if (bytes[0] === 0x3c) throw new NotPorted(`binary write ${where}: content starting with '<' (SVG upload check)`);
        return bytes;
      }
      throw new NotPorted(`binary write ${where} (attachments, image resizing)`);
    case "many2one_reference":
      // fields_reference.py:88-92: Integer.convert_to_cache, int(value or 0) (fields_numeric.py:35-39)
      if (!pyTruthy(value)) return 0;
      if (typeof value === "number" && Number.isInteger(value)) return value;
      if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
      throw new NotPorted(`many2one_reference value ${JSON.stringify(value)} ${where}`);
    case "reference":
      if (!pyTruthy(value)) return null;
      // fields_reference.py:26-40 a "model,id" string of a selection model; the record must exist, which the async
      // callers check first (referenceExists), so a value reaching here is kept
      if (typeof value === "string" && /^[\w.]+,\d+$/.test(value)) {
        const refModel = value.split(",")[0];
        if (field.selection?.some((x) => x.value === refModel)) return value;
      }
      throw new NotPorted(`${field.type} write ${where}`);
    case "one2many":
    case "many2many":
      throw new TypeError(`convertToCache on x2many ${where}`);
    default: {
      const never: never = field.type;
      throw new TypeError(String(never));
    }
  }
}

/**
 * `convert_to_column_insert` / the UPDATE parameter of `_write_multi` for a cache value (models.py:4384,
 * :4014). Translated char/text values become `{"en_US": v, lang: v}` on insert (fields_textual.py:75-90).
 */
export function convertToColumn(field: FieldDef, value: unknown, lang: string): unknown {
  // a computed datetime with the microseconds of its source (src/orm/recompute.ts preciseDatetime)
  if (value instanceof PreciseDatetime && field.type === "datetime") return value.text;
  switch (field.type) {
    case "boolean": return value === true;
    case "integer": case "many2one_reference": return typeof value === "number" ? value : 0; // int(value or 0)
    case "float": {
      const v = typeof value === "number" ? value : 0;
      // fields_numeric.py:159: float_repr with the digits (numeric column), plain float otherwise, which psycopg2 sends
      // as repr(float): "66.0" (a numeric column keeps that scale, row_to_json gives 66.0 and not 66)
      return field.digits ? floatRepr(floatRound(v, field.digits[1]), field.digits[1]) : pyFloatRepr(v);
    }
    case "char": case "text": case "html":
      // fields_textual.py:117-118 convert_to_cache: None or False is None (NULL), never the text "false"
      if (value === null || value === undefined || value === false) return null;
      if (field.translate) return JSON.stringify(lang === "en_US" ? { en_US: value } : { en_US: value, [lang]: value });
      return value;
    case "selection": case "date": case "datetime":
      // the cache's empty value is False; the column gets NULL (fields_temporal.py `to_date(False)`/`to_datetime(False)`
      // are None, fields_selection.py `convert_to_cache` keeps `value or None`): "false" is no date
      return value === false || value === undefined ? null : value;
    case "many2one":
      // fields_relational.py:323 `value or None`
      return value || null;
    case "json":
      // json.dumps: floats keep their decimal point (jsonb keeps the numeric's scale, "100.0" is not "100")
      return value === null || value === undefined ? null : dumps(value);
    case "binary":
      // fields_binary.py:71-83 a column Binary: psycopg2.Binary of the bytes
      if (value === null || value === undefined) return null;
      if (value instanceof Uint8Array) return value;
      throw new NotPorted(`column value of binary field ${field.name}`);
    case "properties": case "properties_definition": case "image":
    case "monetary":
      // fields_numeric.py: Monetary has no convert_to_column (Field's: the cache float, already rounded with the
      // currency by convert_to_cache); convert_to_column_insert (:247-268) rounds with the currency of `record[:1]`,
      // which is empty in `_create` (models.py:4370, self is the model) unless the currency field is in the values
      if (value === null || value === undefined) return null;
      if (typeof value === "number") return value;
      throw new NotPorted(`column value ${JSON.stringify(value)} of monetary field ${field.name}`);
    case "reference":
      return value === null || value === undefined ? null : value;
    case "many2one_reference":
      if (value === null || value === undefined) return null;
      throw new NotPorted(`column value of ${field.type} field ${field.name}`);
    case "one2many": case "many2many":
      throw new TypeError(`${field.type} has no column`);
    default: {
      const never: never = field.type;
      throw new TypeError(String(never));
    }
  }
}

/** Python equality of two cache values (snapshots, `_filter_not_equal`). Binary values compare by identity. */
export function cacheEqual(a0: unknown, b0: unknown): boolean {
  // Python compares 0 == 0.0: a JSON value parsed as a float against the integer of the other side
  const plain = (v: unknown): unknown => (typeof v === "object" && v !== null && "float" in v && Object.keys(v).length === 1 ? (v as { float: unknown }).float : v);
  const a = plain(a0), b = plain(b0);
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => cacheEqual(x, b[i]));
  if (typeof a === "object" && typeof b === "object") {
    if ("content" in (a as object) || "content" in (b as object)) return false;
    const ka = Object.keys(a as object), kb = Object.keys(b as object);
    return ka.length === kb.length && ka.every((k) => cacheEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/** `currency.round(value)` then `float(float_repr(value, decimal_places))` (fields_numeric.py:283-288,
 * res_currency.py `round`/`decimal_places`) for a currency rounding that is a power of ten. */
export function roundMonetary(value: number, rounding: number): number {
  const digits = Math.round(-Math.log10(rounding));
  if (!(rounding > 0) || Math.abs(10 ** -digits - rounding) > 1e-12) throw new NotPorted(`currency rounding ${rounding}`);
  if (digits < 0) throw new NotPorted(`currency rounding ${rounding}`);
  return Number(floatRepr(floatRound(value, digits), digits));
}

/** fields_reference.py:33-37: a "model,id" whose record does not exist is stored as None. */
export async function referenceValue(env: { cr: { query: (q: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }; reg: { models: ReadonlyMap<string, { table: string }> } }, value: unknown): Promise<unknown> {
  if (typeof value !== "string" || !/^[\w.]+,\d+$/.test(value)) return value;
  const [model, id] = value.split(",") as [string, string];
  const def = env.reg.models.get(model);
  if (!def) return value;
  return (await env.cr.query(`SELECT 1 FROM "${def.table}" WHERE id = $1`, [Number(id)])).rows.length ? value : null;
}

/** Python `repr` of a literal (str, int, bool, None, list, tuple, dict with str keys); anything else refuses. */
export function pyLiteralRepr(v: unknown, where: string): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number" && Number.isInteger(v)) return String(v);
  if (typeof v === "string") {
    // repr(str): single quotes unless the text has some and no double quote
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    let out = "";
    for (const ch of v) {
      if (ch === "\\") out += "\\\\";
      else if (ch === q) out += "\\" + q;
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else if (ch.codePointAt(0)! < 0x20 || ch.codePointAt(0) === 0x7f) throw new NotPorted(`repr of a control character for ${where}`);
      else out += ch;
    }
    return q + out + q;
  }
  if (Array.isArray(v)) {
    const items = v.map((x) => pyLiteralRepr(x, where));
    if (v instanceof PyTuple) return items.length === 1 ? `(${items[0]},)` : `(${items.join(", ")})`;
    return `[${items.join(", ")}]`;
  }
  const entries = v instanceof Map ? [...v.entries()] : typeof v === "object" ? Object.entries(v as Record<string, unknown>) : null;
  if (entries) return `{${entries.map(([k, x]) => `${pyLiteralRepr(k, where)}: ${pyLiteralRepr(x, where)}`).join(", ")}}`;
  throw new NotPorted(`str(${JSON.stringify(v)}) for ${where}`);
}
