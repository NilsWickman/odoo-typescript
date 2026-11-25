/**
 * Tokenizer for the Python expression subset of QWeb attributes (`tokenize.tokenize` in
 * odoo/odoo/addons/base/models/ir_qweb.py:1658-1691 `_compile_expr`). Unsupported lexemes raise NotPorted.
 */
import { NotPorted } from "../errors";

export type Token =
  | { kind: "name"; value: string; pos: number }
  | { kind: "number"; value: number; isFloat: boolean; pos: number }
  | { kind: "string"; value: string; pos: number }
  | { kind: "op"; value: string; pos: number }
  | { kind: "end"; pos: number };

const OPERATORS = [
  "**=", "//=", ">>", "<<", "**", "//", "==", "!=", "<=", ">=", "->", "+=", "-=", "*=", "/=", "%=",
  "+", "-", "*", "/", "%", "<", ">", "=", "(", ")", "[", "]", "{", "}", ",", ":", ".", "~", "|", "&", "^", ";", "@",
];

const SIMPLE_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", f: "\f", v: "\v", "0": "\0", "\n": "" };

function unescape(body: string, raw: boolean, expr: string): string {
  if (raw || !body.includes("\\")) return body;
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = body[++i];
    if (n === undefined) throw new NotPorted(`python expression ${JSON.stringify(expr)}: trailing backslash`);
    if (n === "x") {
      out += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (n === "u") {
      out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (n === "U") {
      out += String.fromCodePoint(parseInt(body.slice(i + 1, i + 9), 16));
      i += 8;
    } else if (n in SIMPLE_ESCAPES) {
      out += SIMPLE_ESCAPES[n];
    } else {
      out += "\\" + n; // Python keeps unknown escapes verbatim
    }
  }
  return out;
}

export function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = expr.length;
  while (i < n) {
    const c = expr[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f") {
      i++;
      continue;
    }
    if (c === "#") {
      // a comment runs to the end of the line (also valid in `eval` mode: manifests, `ast.literal_eval` of a file)
      while (i < n && expr[i] !== "\n") i++;
      continue;
    }
    if (c === "\\" && expr[i + 1] === "\n") {
      i += 2;
      continue;
    }
    // string literal, with an optional prefix
    const strm = /^([rRuUbBfF]{0,2})('''|"""|'|")/.exec(expr.slice(i));
    if (strm !== null && (strm[1] === "" || /^[A-Za-z]/.test(expr[i]!))) {
      const prefix = strm[1]!.toLowerCase();
      const quote = strm[2]!;
      if (prefix.includes("f")) throw new NotPorted(`python expression ${JSON.stringify(expr)}: f-string`);
      if (prefix.includes("b")) throw new NotPorted(`python expression ${JSON.stringify(expr)}: bytes literal`);
      const raw = prefix.includes("r");
      const start = i;
      let j = i + strm[0].length;
      let body = "";
      for (;;) {
        if (j >= n) throw new NotPorted(`python expression ${JSON.stringify(expr)}: unterminated string`);
        if (expr.startsWith(quote, j)) break;
        if (expr[j] === "\\" && j + 1 < n) {
          body += expr.slice(j, j + 2);
          j += 2;
          continue;
        }
        body += expr[j];
        j++;
      }
      tokens.push({ kind: "string", value: unescape(body, raw, expr), pos: start });
      i = j + quote.length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(expr[j]!)) j++;
      tokens.push({ kind: "name", value: expr.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(expr[i + 1] ?? ""))) {
      const m = /^(0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?(?:[eE][+-]?[0-9_]+)?)/.exec(expr.slice(i));
      if (m === null || m[0] === "") throw new NotPorted(`python expression ${JSON.stringify(expr)}: bad number`);
      const text = m[0].replace(/_/g, "");
      let value: number;
      let isFloat = false;
      if (/^0[xX]/.test(text)) value = parseInt(text.slice(2), 16);
      else if (/^0[oO]/.test(text)) value = parseInt(text.slice(2), 8);
      else if (/^0[bB]/.test(text)) value = parseInt(text.slice(2), 2);
      else {
        isFloat = /[.eE]/.test(text);
        value = Number(text);
      }
      if (/[jJ]/.test(expr[i + m[0].length] ?? "")) throw new NotPorted(`python expression ${JSON.stringify(expr)}: complex literal`);
      tokens.push({ kind: "number", value, isFloat, pos: i });
      i += m[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => expr.startsWith(o, i));
    if (op === undefined) throw new NotPorted(`python expression ${JSON.stringify(expr)}: unexpected character ${JSON.stringify(c)}`);
    tokens.push({ kind: "op", value: op, pos: i });
    i += op.length;
  }
  tokens.push({ kind: "end", pos: n });
  return tokens;
}
