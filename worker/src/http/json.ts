/**
 * Python-compatible JSON output, the one serializer every JSON response goes through (ARCHITECTURE.md Rules).
 *
 * Odoo serializes with `json.dumps(data, ensure_ascii=False, default=json_default)` for RPC answers
 * (`odoo/odoo/http/requestlib.py:342`) and with `odoo.tools.json.scriptsafe.dumps` (ensure_ascii=True plus the
 * `<>&  ` escapes, `odoo/odoo/tools/json.py:10-15,60`) when a JSON value is embedded in a page by QWeb
 * (`web.webclient_bootstrap`, `web.frontend_layout`). The html body of such a page is compared as text
 * (harness/rcheck.py norm_body), so the separators (", " and ": "), the escapes and the float repr must match
 * Python's exactly. Key order is insertion order, as Python dicts.
 *
 * `PyFloat` (src/orm/types.ts) prints with a decimal point: Python `repr(2026.0)` is "2026.0" where JS prints
 * "2026" (PORTING_odoo.md section 9). `false` and `null` are kept as given: the ORM decides which one Odoo emits.
 */
import type { PyFloat } from "../orm/types";
import { Markup } from "../pyexpr/values";

export interface DumpsOptions {
  /** Python's `ensure_ascii` (default True in Python; Odoo passes False for RPC answers). */
  readonly ensureAscii?: boolean;
  /** `odoo.tools.json.scriptsafe`: escape `<`, `>`, `&`, U+2028, U+2029 as \uXXXX (lowercase hex as Odoo's mapper). */
  readonly scriptSafe?: boolean;
}

export function isPyFloat(v: unknown): v is PyFloat {
  return typeof v === "object" && v !== null && "float" in v && typeof (v as { float: unknown }).float === "number"
    && Object.keys(v).length === 1;
}

/** Python `repr(float)`: shortest round-trip digits, ".0" for integral values, exponent below 1e-4 and from 1e16. */
export function pyFloatRepr(n: number): string {
  if (!Number.isFinite(n)) throw new TypeError(`cannot serialize non-finite float ${n}`);
  if (n === 0) return Object.is(n, -0) ? "-0.0" : "0.0";
  const abs = Math.abs(n);
  if (abs >= 1e16 || abs < 1e-4) {
    // Python: '1e+16', '1.5e-05' (exponent sign always, at least two digits); JS toExponential: '1e+16', '1.5e-5'.
    const [mant, exp] = n.toExponential().split("e") as [string, string];
    const sign = exp.startsWith("-") ? "-" : "+";
    const digits = exp.replace(/^[-+]/, "").padStart(2, "0");
    return `${mant}e${sign}${digits}`;
  }
  const s = String(n);
  return Number.isInteger(n) ? `${s}.0` : s;
}

/** Python `json.dumps` string escaping: `ensure_ascii` escapes every non-ASCII code unit as \uXXXX (lowercase hex). */
function dumpString(s: string, ensureAscii: boolean, scriptSafe: boolean): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i] as string;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else if (scriptSafe && (ch === "<" || ch === ">" || ch === "&" || c === 0x2028 || c === 0x2029)) {
      // odoo/odoo/tools/json.py:10-15 JSON_SCRIPTSAFE_MAPPER
      out += `\\u${c.toString(16).padStart(4, "0")}`;
    } else if (ensureAscii && c > 0x7e) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out + '"';
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `fields.Datetime.to_string`: "%Y-%m-%d %H:%M:%S" of the UTC instant (odoo/orm/fields_temporal.py). */
export function datetimeToString(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

export function dumps(value: unknown, opts: DumpsOptions = {}): string {
  const ensureAscii = opts.ensureAscii ?? true;
  const scriptSafe = opts.scriptSafe ?? false;
  const parts: string[] = [];
  const walk = (v: unknown, path: string): void => {
    if (v === null) parts.push("null");
    else if (v === true) parts.push("true");
    else if (v === false) parts.push("false");
    else if (typeof v === "string") parts.push(dumpString(v, ensureAscii, scriptSafe));
    // markupsafe.Markup is a str: json.dumps writes its text (a compiled method's or hook's value; before K2-base
    // round 4 it was walked as an object and came out as {"html": ...})
    else if (v instanceof Markup) parts.push(dumpString(v.toString(), ensureAscii, scriptSafe));
    else if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new TypeError(`non-finite number at ${path}`);
      // A plain JS number is an int when integral (Odoo integers); PyFloat carries the float marker.
      parts.push(Number.isInteger(v) ? String(v) : pyFloatRepr(v));
    } else if (typeof v === "bigint") parts.push(v.toString());
    else if (isPyFloat(v)) parts.push(pyFloatRepr(v.float));
    else if (v instanceof Date) parts.push(dumpString(datetimeToString(v), ensureAscii, scriptSafe));
    else if (Array.isArray(v)) {
      parts.push("[");
      v.forEach((x, i) => {
        if (i > 0) parts.push(", ");
        walk(x, `${path}[${i}]`);
      });
      parts.push("]");
    } else if (v instanceof Map) {
      parts.push("{");
      let first = true;
      for (const [k, x] of v) {
        if (!first) parts.push(", ");
        first = false;
        parts.push(dumpString(String(k), ensureAscii, scriptSafe), ": ");
        walk(x, `${path}.${String(k)}`);
      }
      parts.push("}");
    } else if (typeof v === "object") {
      parts.push("{");
      let first = true;
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        // Python has no `undefined`: a missing value is a bug in the caller, never a silently dropped key.
        if (x === undefined) throw new TypeError(`undefined value at ${path}.${k}`);
        if (!first) parts.push(", ");
        first = false;
        parts.push(dumpString(k, ensureAscii, scriptSafe), ": ");
        walk(x, `${path}.${k}`);
      }
      parts.push("}");
    } else throw new TypeError(`cannot serialize ${typeof v} at ${path}`);
  };
  walk(value, "$");
  return parts.join("");
}

/** The serializer of RPC answers: `json.dumps(data, ensure_ascii=False)` (requestlib.py:342). */
export function dumpsResponse(value: unknown): string {
  return dumps(value, { ensureAscii: false });
}

/** The serializer of values embedded in pages by QWeb: `odoo.tools.json.scriptsafe.dumps` (ensure_ascii=True). */
export function dumpsScriptSafe(value: unknown): string {
  return dumps(value, { ensureAscii: true, scriptSafe: true });
}
