/**
 * Python expression subset for QWeb templates and view attributes: `evalExpr(src, scope)`. Parsed ASTs are cached
 * per source string (bounded), like Odoo's compiled template cache. Unsupported syntax raises NotPorted with the
 * expression; Python runtime errors raise PyEvalError.
 */
import { parseExpr, type Expr } from "./parse";
import { evaluate, evaluateAsync, type Scope } from "./eval";
import { NotPorted } from "../errors";

export { evaluate, evaluateAsync, getAttr, getItem, binary, contains, iterate, PyEvalError, BUILTIN_NAMES, type Scope } from "./eval";
export { parseExpr, type Expr } from "./parse";
export * from "./values";

const CACHE_LIMIT = 4096;
const cache = new Map<string, Expr>();

export function compileExpr(src: string): Expr {
  const hit = cache.get(src);
  if (hit !== undefined) return hit;
  const ast = parseExpr(src);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(src, ast);
  return ast;
}

/** Evaluate a Python expression with `scope` as the template values (missing names read as None). */
export function evalExpr(src: string, scope: Scope): unknown {
  return evaluate(compileExpr(src), scope, src);
}

/** `evalExpr` for records: attribute reads and calls may be asynchronous. */
export function evalExprAsync(src: string, scope: Scope): Promise<unknown> {
  return evaluateAsync(compileExpr(src), scope, src);
}

/** Python's ValueError of `ast.literal_eval` on a node it does not accept. */
export class LiteralEvalError extends Error {
  constructor(src: string) {
    super(`malformed node or string: ${JSON.stringify(src)}`);
    this.name = "ValueError";
  }
}

/**
 * `ast.literal_eval(s)` (Lib/ast.py:56-112, Python 3.12): the source (leading spaces and tabs stripped) must be a
 * literal: str, numbers, True/False/None, tuples, lists and dicts of literals, and a sign on a number (`-1`, not `--1`:
 * `_convert_signed_num` takes a Constant only). Names, calls, operators and nested signs raise ValueError, as the
 * compiler thread's K2 asked (rådet runda 13); sets, `set()` and complex numbers are not ported. Before, the callers
 * evaluated such sources with `evalExpr`, where `--1` is 1 and an unknown name is None.
 */
export function literalEval(src: string): unknown {
  const text = src.replace(/^[ \t]+/, "");
  const ast = compileExpr(text);
  const check = (n: Expr): void => {
    switch (n.kind) {
      case "const": case "num": case "str": return;
      case "list": case "tuple": n.items.forEach(check); return;
      case "dict":
        for (const it of n.items) {
          if ("unpack" in it) throw new LiteralEvalError(src);
          check(it.key); check(it.value);
        }
        return;
      case "unary":
        // `_convert_num`: `type(value) in (int, float, complex)`, so not a bool
        if (n.op !== "not" && n.operand.kind === "num") return;
        throw new LiteralEvalError(src);
      case "binary":
        if (n.op === "+" || n.op === "-") throw new NotPorted(`ast.literal_eval of ${JSON.stringify(src)} (a complex number or an error)`);
        throw new LiteralEvalError(src);
      case "call":
        if (n.func.kind === "name" && n.func.id === "set" && !n.args.length && !n.kwargs.length) throw new NotPorted("ast.literal_eval of set()");
        throw new LiteralEvalError(src);
      default:
        throw new LiteralEvalError(src);
    }
  };
  check(ast);
  return evaluate(ast, new Map(), text);
}
