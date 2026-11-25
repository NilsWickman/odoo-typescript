/**
 * The one place where a Postgres value becomes a typed ORM value, and where the ORM's cache format becomes the
 * `read()` format (`convert_to_read`). `pg` returns int8 and numeric as strings and date/timestamp as Date objects
 * (ARCHITECTURE.md: parse deliberately per field type here, nowhere else).
 *
 * Cache format per type (Field.convert_to_cache of the column value):
 *   boolean -> boolean; integer/many2one/many2one_reference -> number | null; float/monetary -> number | null;
 *   char/text/html/selection/reference -> string | null; date -> 'YYYY-MM-DD' | null;
 *   datetime -> 'YYYY-MM-DD HH:MM:SS' | null (fields_temporal.py:271, microseconds are dropped);
 *   binary -> BinaryValue | null; json/properties -> parsed JSON | null; one2many/many2many -> number[].
 */
import { createHash } from "node:crypto";
import type { BinaryValue, FieldType, PyFloat } from "./types";

/** XML-RPC limit: integers above it are read as floats (fields_numeric.py:45). */
export const MAXINT = 2147483647;

/**
 * A datetime read from its column with the microseconds Odoo keeps in its cache (fields_temporal.py `to_datetime` of
 * a datetime): a copied value (models.py copy_data) is written back as it was. RPC strings never carry a fraction.
 */
export class PreciseDatetime {
  readonly text: string;
  constructor(text: string) { this.text = text; }
}

/** `json.loads`: a number written with a fraction or an exponent is a Python float (PyFloat), the others ints. */
export function parseJsonFloats(text: string): unknown {
  let i = 0;
  const ws = (): void => { while (i < text.length && " \t\n\r".includes(text[i]!)) i++; };
  const value = (): unknown => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++; const out: Record<string, unknown> = {}; ws();
      if (text[i] === "}") { i++; return out; }
      for (;;) {
        ws(); const k = value() as string; ws(); i++; // ':'
        out[k] = value(); ws();
        if (text[i++] === "}") return out;
      }
    }
    if (c === "[") {
      i++; const out: unknown[] = []; ws();
      if (text[i] === "]") { i++; return out; }
      for (;;) { out.push(value()); ws(); if (text[i++] === "]") return out; }
    }
    if (c === '"') {
      const m = /^"(?:[^"\\]|\\.)*"/.exec(text.slice(i))!;
      i += m[0].length; return JSON.parse(m[0]) as string;
    }
    const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if (!m) throw new TypeError(`invalid JSON at ${i}: ${text.slice(i, i + 20)}`);
    i += m[0].length;
    const t = m[0];
    if (t === "true") return true;
    if (t === "false") return false;
    if (t === "null") return null;
    return /[.eE]/.test(t) ? pyFloat(Number(t)) : Number(t);
  };
  const out = value(); ws();
  if (i !== text.length) throw new TypeError("trailing data after JSON");
  return out;
}

export function pyFloat(value: number): PyFloat {
  return { float: value };
}

export function isPyFloat(value: unknown): value is PyFloat {
  return typeof value === "object" && value !== null && "float" in value
    && typeof (value as { float: unknown }).float === "number" && Object.keys(value).length === 1;
}

/** Unwrap a PyFloat (from the JSON parser) to a plain number; other values pass through. */
export function plainNumber(value: unknown): unknown {
  return isPyFloat(value) ? value.float : value;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** `date` column -> 'YYYY-MM-DD' (fields_temporal.py:186 Date.to_string). */
export function pgDateToString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) {
    // pg parses `date` as local midnight: read it back with local getters.
    return `${pad(raw.getFullYear(), 4)}-${pad(raw.getMonth() + 1, 2)}-${pad(raw.getDate(), 2)}`;
  }
  if (typeof raw === "string") return raw.slice(0, 10);
  throw new TypeError(`unexpected date value ${String(raw)}`);
}

/** `timestamp without time zone` column -> 'YYYY-MM-DD HH:MM:SS' (fields_temporal.py:280 Datetime.to_string). */
export function pgTimestampToString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) {
    return `${pad(raw.getFullYear(), 4)}-${pad(raw.getMonth() + 1, 2)}-${pad(raw.getDate(), 2)} `
      + `${pad(raw.getHours(), 2)}:${pad(raw.getMinutes(), 2)}:${pad(raw.getSeconds(), 2)}`;
  }
  if (typeof raw === "string") {
    // '2026-10-27 19:35:18.123456' or '2026-10-27T19:35:18' -> drop fraction, normalize the separator
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(raw);
    if (m !== null) return `${m[1]} ${m[2]}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw} 00:00:00`;
    throw new TypeError(`unexpected timestamp value ${raw}`);
  }
  throw new TypeError(`unexpected timestamp value ${String(raw)}`);
}

/** int4/int8 (pg gives int8 as a string). */
export function pgInt(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new TypeError(`not an integer: ${raw}`);
    return n;
  }
  if (typeof raw === "bigint") return Number(raw);
  throw new TypeError(`unexpected integer value ${String(raw)}`);
}

/** numeric/float8 (pg gives numeric as a string). */
export function pgFloat(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new TypeError(`not a number: ${raw}`);
    return n;
  }
  throw new TypeError(`unexpected float value ${String(raw)}`);
}

function pgString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") return raw;
  throw new TypeError(`unexpected text value ${String(raw)}`);
}

function pgJson(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") return JSON.parse(raw) as unknown;
  return raw;
}

function pgBytes(raw: unknown): Uint8Array | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Uint8Array) return raw;
  throw new TypeError(`unexpected bytea value ${String(raw)}`);
}

/** In-memory binary value (binary.py:74 BinaryBytes): checksum is sha256 (binary.py:71), filename '' by default. */
export function binaryBytes(data: Uint8Array, filename = "", mimetype = "application/octet-stream"): BinaryValue {
  let checksum: string | null = null;
  return {
    filename,
    size: data.byteLength,
    get checksum(): string {
      if (checksum === null) checksum = createHash("sha256").update(data).digest("hex");
      return checksum;
    },
    mimetype,
    content: () => Promise.resolve(data),
  };
}

/**
 * Convert a value as returned by pg for a column of `type` into the cache format. Translated jsonb and
 * company-dependent jsonb are resolved in SQL (fields_textual.py:421, fields.py:1378), so here the column is already
 * the plain value. `date`/`datetime` selects are cast to text in sql.ts; Date objects are accepted anyway.
 */
export function fromPg(type: FieldType, raw: unknown): unknown {
  switch (type) {
    case "boolean":
      // Boolean.convert_to_cache: bool(value) (fields_misc.py:31); NULL reads as False
      return raw === true;
    case "integer":
    case "many2one":
    case "many2one_reference":
      return pgInt(raw);
    case "float":
    case "monetary":
      return pgFloat(raw);
    case "char":
    case "text":
    case "html":
    case "selection":
    case "reference":
      return pgString(raw);
    case "date":
      return pgDateToString(raw);
    case "datetime":
      return pgTimestampToString(raw);
    case "binary":
    case "image": {
      const bytes = pgBytes(raw);
      return bytes === null || bytes.byteLength === 0 ? null : binaryBytes(bytes);
    }
    case "json":
    case "properties":
    case "properties_definition":
      return pgJson(raw);
    case "one2many":
    case "many2many":
      throw new TypeError(`${type} has no column`);
    default: {
      const never: never = type;
      throw new TypeError(`unknown field type ${String(never)}`);
    }
  }
}

/** Integer.convert_to_read (fields_numeric.py:44): big values become floats for XML-RPC. */
export function integerToRead(value: number | null): number | PyFloat {
  const v = value ?? 0; // convert_to_record: value or 0 (fields_numeric.py:41)
  return v > MAXINT ? pyFloat(v) : v;
}

/** Float/Monetary.convert_to_read: `value or 0.0` as a Python float (fields_numeric.py:175, :292). */
export function floatToRead(value: number | null): PyFloat {
  return pyFloat(value ?? 0);
}

/** Binary.convert_to_read (fields_binary.py:134): filename (unless empty or the field name), base64 content, size. */
export async function binaryToRead(value: BinaryValue | null, fieldName: string): Promise<false | Record<string, unknown>> {
  if (value === null) return false;
  const res: Record<string, unknown> = {};
  if (value.filename !== "" && value.filename !== fieldName) res["filename"] = value.filename;
  res["content"] = Buffer.from(await value.content()).toString("base64");
  res["size"] = value.size;
  return res;
}

/** `_read_format(load='web')` for binaries (models.py:3047): filename, size, checksum; content only for new records. */
export function binaryToWebRead(value: BinaryValue | null, fieldName: string): false | Record<string, unknown> {
  if (value === null) return false;
  const res: Record<string, unknown> = {};
  if (value.filename !== "" && value.filename !== fieldName) res["filename"] = value.filename;
  res["size"] = value.size;
  res["checksum"] = value.checksum;
  return res;
}

/** Python `str2bool` (odoo/tools/misc.py) as used by `_optimize_boolean_in` (domains.py:1568). */
export function str2bool(s: string, fallback: boolean): boolean {
  const v = s.toLowerCase();
  if (["y", "yes", "1", "true", "t", "on"].includes(v)) return true;
  if (["n", "no", "0", "false", "f", "off"].includes(v)) return false;
  return fallback;
}
