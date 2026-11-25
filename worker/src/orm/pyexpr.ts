/**
 * The subset of Python that `ir.access.domain` uses (ir_access.py:312 `_eval_context`: `user`, `company_ids`,
 * `company_id`, `time`), as found by `SELECT domain FROM ir_access` on poc_corpus: list and tuple displays, string,
 * integer and boolean literals, and attribute chains on the context names (`user.id`, `user.partner_id.id`,
 * `user.commercial_partner_id.id`, `user.all_group_ids.ids`, `user.ids`, `company_ids`, `company_id`).
 * poc_erp adds `+` between lists (`company_ids + [False]`).
 * Anything else raises NotPorted: Odoo's safe_eval would accept more, but guessing is worse than failing loudly.
 */
import { NotPorted } from "../errors";

export type PyExpr =
  | { readonly kind: "str"; readonly value: string }
  | { readonly kind: "int"; readonly value: number }
  | { readonly kind: "float"; readonly value: number }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "none" }
  | { readonly kind: "list"; readonly items: readonly PyExpr[] }
  | { readonly kind: "tuple"; readonly items: readonly PyExpr[] }
  | { readonly kind: "name"; readonly path: readonly string[] }
  /** `a + b`: list concatenation, as in poc_erp's `[('company_id', 'in', company_ids + [False])]`
   *  (sale/security/ir_access.xml and siblings, multi-company rules on optional companies). */
  | { readonly kind: "add"; readonly left: PyExpr; readonly right: PyExpr };

type Token =
  | { readonly t: "punct"; readonly v: string }
  | { readonly t: "str"; readonly v: string }
  | { readonly t: "num"; readonly v: string }
  | { readonly t: "name"; readonly v: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if ("[](),.+".includes(ch)) { tokens.push({ t: "punct", v: ch }); i++; continue; }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      let out = "";
      while (j < src.length && src[j] !== quote) {
        if (src[j] === "\\") {
          const next = src[j + 1];
          if (next === undefined) throw new NotPorted(`python expression: unterminated escape in ${src}`);
          out += next === "n" ? "\n" : next === "t" ? "\t" : next;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new NotPorted(`python expression: unterminated string in ${src}`);
      tokens.push({ t: "str", v: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const m = /^-?\d+(\.\d+)?/.exec(src.slice(i));
      if (m === null) throw new NotPorted(`python expression: bad number at ${src.slice(i, i + 10)}`);
      tokens.push({ t: "num", v: m[0] });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      if (m === null) throw new NotPorted(`python expression: bad name at ${src.slice(i, i + 10)}`);
      tokens.push({ t: "name", v: m[0] });
      i += m[0].length;
      continue;
    }
    throw new NotPorted(`python expression: unsupported character ${JSON.stringify(ch)} in ${src}`);
  }
  return tokens;
}

/** Parse a Python expression of the supported subset into an AST. */
export function parsePyExpr(src: string): PyExpr {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const next = (): Token => {
    const tok = tokens[pos++];
    if (tok === undefined) throw new NotPorted(`python expression: unexpected end of ${src}`);
    return tok;
  };
  const expect = (v: string): void => {
    const tok = next();
    if (tok.t !== "punct" || tok.v !== v) throw new NotPorted(`python expression: expected ${v} in ${src}`);
  };

  function parseSequence(close: string): PyExpr[] {
    const items: PyExpr[] = [];
    for (;;) {
      const tok = peek();
      if (tok === undefined) throw new NotPorted(`python expression: unterminated sequence in ${src}`);
      if (tok.t === "punct" && tok.v === close) { pos++; return items; }
      items.push(parseExpr());
      const sep = next();
      if (sep.t === "punct" && sep.v === close) return items;
      if (!(sep.t === "punct" && sep.v === ",")) throw new NotPorted(`python expression: expected , in ${src}`);
    }
  }

  function parseExpr(): PyExpr {
    let left = parsePrimary();
    while (peek()?.t === "punct" && (peek() as Token).v === "+") {
      pos++;
      left = { kind: "add", left, right: parsePrimary() };
    }
    return left;
  }

  function parsePrimary(): PyExpr {
    const tok = next();
    switch (tok.t) {
      case "str": return { kind: "str", value: tok.v };
      case "num":
        return tok.v.includes(".") ? { kind: "float", value: Number(tok.v) } : { kind: "int", value: Number(tok.v) };
      case "name": {
        if (tok.v === "True") return { kind: "bool", value: true };
        if (tok.v === "False") return { kind: "bool", value: false };
        if (tok.v === "None") return { kind: "none" };
        const path = [tok.v];
        while (peek()?.t === "punct" && (peek() as Token).v === ".") {
          pos++;
          const attr = next();
          if (attr.t !== "name") throw new NotPorted(`python expression: expected attribute name in ${src}`);
          path.push(attr.v);
        }
        if (peek()?.t === "punct" && (peek() as Token).v === "(") {
          throw new NotPorted(`python expression: call ${path.join(".")}() in ${src}`);
        }
        return { kind: "name", path };
      }
      case "punct":
        if (tok.v === "[") return { kind: "list", items: parseSequence("]") };
        if (tok.v === "(") return { kind: "tuple", items: parseSequence(")") };
        throw new NotPorted(`python expression: unexpected ${tok.v} in ${src}`);
      default: {
        const never: never = tok;
        throw new TypeError(String(never));
      }
    }
  }

  const result = parseExpr();
  if (pos !== tokens.length) throw new NotPorted(`python expression: trailing input in ${src}`);
  return result;
}

/** Resolves a dotted name (`user.partner_id.id`) to a value; must throw NotPorted for unknown paths. */
export type NameResolver = (path: readonly string[]) => unknown;

/** Evaluate the AST to JSON-like values (tuples become arrays, as Odoo's Domain() accepts both). */
export function evalPyExpr(expr: PyExpr, resolve: NameResolver): unknown {
  switch (expr.kind) {
    case "str": return expr.value;
    case "int": return expr.value;
    case "float": return expr.value;
    case "bool": return expr.value;
    case "none": return null;
    case "list":
    case "tuple": return expr.items.map((item) => evalPyExpr(item, resolve));
    case "name": return resolve(expr.path);
    case "add": {
      const l = evalPyExpr(expr.left, resolve);
      const r = evalPyExpr(expr.right, resolve);
      if (Array.isArray(l) && Array.isArray(r)) return [...l, ...r];
      if (typeof l === "string" && typeof r === "string") return l + r;
      throw new NotPorted(`python expression: + of ${Array.isArray(l) ? "list" : typeof l} and ${Array.isArray(r) ? "list" : typeof r}`);
    }
    default: {
      const never: never = expr;
      throw new TypeError(String(never));
    }
  }
}

/** Names referenced by an expression, as dotted paths (for cache keys and reporting). */
export function pyExprNames(expr: PyExpr): string[] {
  switch (expr.kind) {
    case "list":
    case "tuple": return expr.items.flatMap(pyExprNames);
    case "name": return [expr.path.join(".")];
    case "add": return [...pyExprNames(expr.left), ...pyExprNames(expr.right)];
    default: return [];
  }
}
