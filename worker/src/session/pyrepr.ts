/**
 * Python `repr()` of the simple values Odoo feeds to HMAC keys: `str(tuple(...))` in
 * `res.users._session_token_hash_compute` (res_users.py:991-1004) and `repr((scope, message))` in
 * `odoo.tools.misc.hmac` (misc.py:1815). Supported: str, bool, int, None, nested tuples (JS arrays).
 */
export type PyValue = string | number | boolean | null | readonly PyValue[];

function reprStr(s: string): string {
  // CPython unicode_repr: single quotes unless the string has a single quote and no double quote.
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === quote || ch === "\\") out += `\\${ch}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, "0")}`;
    else out += ch; // repr keeps printable non-ASCII as is (str.isprintable)
  }
  return out + quote;
}

export function pyRepr(v: PyValue): string {
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new TypeError("pyRepr of a float is not supported");
    return String(v);
  }
  if (typeof v === "string") return reprStr(v);
  if (v.length === 1) return `(${pyRepr(v[0] as PyValue)},)`;
  return `(${v.map(pyRepr).join(", ")})`;
}
