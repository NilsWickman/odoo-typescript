/**
 * Python `str()` of JSON values (dict, list, str, int, float, bool, None), as Odoo stores a non-string value written
 * to a Char/Text field (odoo/orm/fields_textual.py:137 `str(value)`), e.g. the search panel's filter context.
 */
import { pyFloatRepr } from "../http/json";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Python `repr(str)`: single quotes unless the text has `'` and no `"`; backslash, quote and controls escaped. */
function pyStrRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += "\\x" + c.toString(16).padStart(2, "0");
    else if (c >= 0x80 && c < 0xa0) out += "\\x" + c.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out + quote;
}

/**
 * Python `str(value)` of a JSON value (dict, list, str, int, float, bool, None) as the Text field's
 * `convert_to_cache` stores it (fields_textual.py:137 `str(value)`), e.g. the search panel's context dict.
 */
export function pyStr(v: unknown, nested = false): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return nested ? pyStrRepr(v) : v;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  if (Array.isArray(v)) return `[${v.map((x) => pyStr(x, true)).join(", ")}]`;
  if (isRecord(v)) {
    if (Object.keys(v).length === 1 && typeof v["float"] === "number") return pyFloatRepr(v["float"]);
    return `{${Object.entries(v).map(([k, x]) => `${pyStrRepr(k)}: ${pyStr(x, true)}`).join(", ")}}`;
  }
  throw new TypeError(`str() of ${typeof v}`);
}

