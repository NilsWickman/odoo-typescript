/**
 * Evaluator for ./parse.ts ASTs with the value model of ./values.ts. Name lookup follows QWeb's compilation
 * (ir_qweb.py:1500-1656 `_compile_expr_tokens`): names in `_BUILTINS` (odoo/odoo/tools/safe_eval/evaluation.py:336)
 * are the builtins, every other name is `values.get(name)` (None when missing). Attribute access on a provided
 * object reads its property (a missing property means the HTTP stream did not supply it: NotPorted). Methods on
 * str/dict/list are a whitelist; anything else raises NotPorted with the expression text.
 */
import { NotPorted } from "../errors";
import type { Expr } from "./parse";
import {
  asFloat,
  dictEntries,
  dictGet,
  dictSize,
  escape,
  isDict,
  isFloatValue,
  isNone,
  isPyFloat,
  Markup,
  percentFormat,
  PyObject,
  pyBool,
  pyCompare,
  pyEq,
  PyKwargs,
  pyRepr,
  pyStr,
  PyTuple,
  pyTuple,
  pyTypeName,
  toNumber,
} from "./values";

export type Scope = Map<string, unknown>;

export class PyEvalError extends Error {
  constructor(message: string, expr: string) {
    super(`${message} (in python expression ${JSON.stringify(expr)})`);
    this.name = "PyEvalError";
  }
}

type Builtin = (args: unknown[], kwargs: PyKwargs | null) => unknown;

export function iterate(v: unknown, what: string): unknown[] {
  if (v instanceof PyObject) {
    const items = v.pyIter();
    if (items !== null) return items;
  }
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [...v];
  if (isDict(v)) return dictEntries(v).map(([k]) => k);
  if (v instanceof Set) return [...v];
  if (v instanceof Markup) return [...v.toString()];
  throw new TypeError(`'${pyTypeName(v)}' object is not iterable (${what})`);
}

function pyInt(v: unknown): number {
  if (typeof v === "string") {
    const t = v.trim();
    if (!/^[+-]?\d+$/.test(t)) throw new Error(`ValueError: invalid literal for int() with base 10: ${pyRepr(v)}`);
    return parseInt(t, 10);
  }
  return Math.trunc(toNumber(v));
}

const BUILTINS: Record<string, Builtin> = {
  str: ([v]) => (v === undefined ? "" : pyStr(v)),
  unicode: ([v]) => (v === undefined ? "" : pyStr(v)),
  repr: ([v]) => pyRepr(v),
  bool: ([v]) => (v === undefined ? false : pyBool(v)),
  int: ([v]) => (v === undefined ? 0 : pyInt(v)),
  float: ([v]) => (v === undefined ? { float: 0 } : asFloat(typeof v === "string" ? Number(v) : toNumber(v))),
  len: ([v]) => {
    if (v instanceof PyObject) {
      const n = v.pyLen();
      if (n !== null) return n;
    }
    if (typeof v === "string") return [...v].length;
    if (v instanceof Markup) return [...v.toString()].length;
    if (Array.isArray(v)) return v.length;
    if (isDict(v)) return dictSize(v);
    if (v instanceof Set) return v.size;
    throw new TypeError(`object of type '${pyTypeName(v)}' has no len()`);
  },
  list: ([v]) => (v === undefined ? [] : [...iterate(v, "list()")]),
  tuple: ([v]) => pyTuple(v === undefined ? [] : iterate(v, "tuple()")),
  dict: ([v], kwargs) => {
    const m = new Map<unknown, unknown>();
    if (v !== undefined) {
      if (isDict(v)) for (const [k, val] of dictEntries(v)) m.set(k, val);
      else for (const pair of iterate(v, "dict()")) {
        const [k, val] = iterate(pair, "dict()");
        m.set(k, val);
      }
    }
    if (kwargs !== null) for (const [k, val] of kwargs.entries) m.set(k, val);
    return m;
  },
  set: ([v]) => new Set(v === undefined ? [] : iterate(v, "set()")),
  range: (args) => {
    const [a, b, c] = args.map((x) => pyInt(x));
    const start = b === undefined ? 0 : a!;
    const stop = b === undefined ? a! : b;
    const step = c ?? 1;
    if (step === 0) throw new Error("ValueError: range() arg 3 must not be zero");
    const out: number[] = [];
    for (let i = start; step > 0 ? i < stop : i > stop; i += step) out.push(i);
    return out;
  },
  enumerate: ([v, start]) => iterate(v, "enumerate()").map((x, i) => pyTuple([i + (start === undefined ? 0 : pyInt(start)), x])),
  zip: (args) => {
    const lists = args.map((a) => iterate(a, "zip()"));
    const n = Math.min(...lists.map((l) => l.length));
    const out: PyTuple[] = [];
    for (let i = 0; i < n; i++) out.push(pyTuple(lists.map((l) => l[i])));
    return out;
  },
  min: (args) => {
    const items = args.length === 1 ? iterate(args[0], "min()") : args;
    if (items.length === 0) throw new Error("ValueError: min() arg is an empty sequence");
    return items.reduce((m, x) => (pyCompare(x, m) < 0 ? x : m));
  },
  max: (args) => {
    const items = args.length === 1 ? iterate(args[0], "max()") : args;
    if (items.length === 0) throw new Error("ValueError: max() arg is an empty sequence");
    return items.reduce((m, x) => (pyCompare(x, m) > 0 ? x : m));
  },
  sum: ([v, start]) => iterate(v, "sum()").reduce((acc: unknown, x) => binary("+", acc, x), start ?? 0),
  abs: ([v]) => (isFloatValue(v) ? asFloat(Math.abs(toNumber(v))) : Math.abs(toNumber(v))),
  round: ([v, nd]) => {
    const n = toNumber(v);
    if (nd === undefined || isNone(nd)) {
      // Python rounds half to even
      const r = Math.round(n);
      return Math.abs(n % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
    }
    const f = 10 ** pyInt(nd);
    return asFloat(Math.round(n * f) / f);
  },
  sorted: ([v], kwargs) => {
    const out = [...iterate(v, "sorted()")].sort(pyCompare);
    if (kwargs !== null) {
      if (kwargs.entries.has("key")) throw new NotPorted("sorted(key=...)");
      if (pyBool(kwargs.entries.get("reverse"))) out.reverse();
    }
    return out;
  },
  all: ([v]) => iterate(v, "all()").every(pyBool),
  any: ([v]) => iterate(v, "any()").some(pyBool),
  ord: ([v]) => pyStr(v).codePointAt(0) ?? 0,
  chr: ([v]) => String.fromCodePoint(pyInt(v)),
  divmod: ([a, b]) => pyTuple([binary("//", a, b), binary("%", a, b)]),
  isinstance: ([v, types]) => {
    const names = (Array.isArray(types) ? types : [types]).map((t) => {
      if (typeof t !== "function" || !("pyTypeName" in t)) throw new NotPorted("isinstance() with a non-type argument");
      return (t as { pyTypeName: string }).pyTypeName;
    });
    const actual = pyTypeName(v);
    return names.some((n) => n === actual || (n === "int" && actual === "bool") || (n === "str" && actual === "Markup"));
  },
  // map(fn, iterable) over one iterable, materialized as a list (the templates consume it at once); template lambdas
  // may answer with promises (record reads), awaited together
  map: ([fn, it, ...more]) => {
    if (more.length || typeof fn !== "function") throw new NotPorted("map() of several iterables or a non-callable");
    const out = iterate(it, "map()").map((x) => (fn as (v: unknown) => unknown)(x));
    return out.some((x) => x instanceof Promise) ? Promise.all(out) : out;
  },
  filter: () => {
    throw new NotPorted("filter()");
  },
  reduce: () => {
    throw new NotPorted("reduce()");
  },
  bytes: () => {
    throw new NotPorted("bytes()");
  },
  Exception: () => {
    throw new NotPorted("Exception()");
  },
  __import__: () => {
    throw new NotPorted("__import__()");
  },
};

// the type builtins double as `isinstance` arguments
for (const [name, fn] of Object.entries(BUILTINS)) {
  if (["str", "int", "float", "bool", "list", "dict", "tuple", "set"].includes(name)) {
    (fn as unknown as { pyTypeName: string }).pyTypeName = name;
  }
}

export const BUILTIN_NAMES: ReadonlySet<string> = new Set(Object.keys(BUILTINS));

/** Methods of str (and Markup, which wraps the results of the text-producing ones). */
const STR_METHODS: Record<string, (s: string, args: unknown[]) => unknown> = {
  startswith: (s, [p, start]) => {
    const from = start === undefined ? 0 : pyInt(start);
    return (Array.isArray(p) ? p : [p]).some((x) => s.startsWith(pyStr(x), from));
  },
  endswith: (s, [p]) => (Array.isArray(p) ? p : [p]).some((x) => s.endsWith(pyStr(x))),
  strip: (s, [chars]) => (chars === undefined || isNone(chars) ? s.trim() : stripChars(s, pyStr(chars), true, true)),
  lstrip: (s, [chars]) => (chars === undefined || isNone(chars) ? s.replace(/^\s+/, "") : stripChars(s, pyStr(chars), true, false)),
  rstrip: (s, [chars]) => (chars === undefined || isNone(chars) ? s.replace(/\s+$/, "") : stripChars(s, pyStr(chars), false, true)),
  lower: (s) => s.toLowerCase(),
  upper: (s) => s.toUpperCase(),
  title: (s) => s.replace(/\w\S*/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()),
  capitalize: (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(),
  replace: (s, [a, b, count]) => {
    const from = pyStr(a);
    const to = pyStr(b);
    if (count !== undefined) {
      let n = pyInt(count);
      let out = s;
      let idx = 0;
      while (n-- > 0 && (idx = out.indexOf(from, idx)) >= 0) {
        out = out.slice(0, idx) + to + out.slice(idx + from.length);
        idx += to.length;
      }
      return out;
    }
    return from === "" ? s : s.split(from).join(to);
  },
  split: (s, [sep, maxsplit]) => {
    if (sep === undefined || isNone(sep)) {
      if (maxsplit !== undefined) throw new NotPorted("str.split(None, maxsplit)");
      return s.split(/\s+/).filter((x) => x !== "");
    }
    const parts = s.split(pyStr(sep));
    if (maxsplit === undefined || Number(maxsplit) < 0) return parts;
    const n = Number(maxsplit); // str.split(sep, maxsplit): at most maxsplit splits, the rest joined back
    return parts.length <= n + 1 ? parts : [...parts.slice(0, n), parts.slice(n).join(pyStr(sep))];
  },
  join: (s, [items]) => iterate(items, "str.join()").map((x) => {
    if (typeof x !== "string" && !(x instanceof Markup)) throw new TypeError(`sequence item: expected str instance, ${pyTypeName(x)} found`);
    return x.toString();
  }).join(s),
  find: (s, [sub]) => s.indexOf(pyStr(sub)),
  count: (s, [sub]) => s.split(pyStr(sub)).length - 1,
  isdigit: (s) => /^\d+$/.test(s),
  isalpha: (s) => /^\p{L}+$/u.test(s),
  isalnum: (s) => /^[\p{L}\p{N}]+$/u.test(s),
  isspace: (s) => /^\s+$/.test(s),
  zfill: (s, [w]) => s.padStart(pyInt(w), "0"),
  format: () => {
    throw new NotPorted("str.format()");
  },
  encode: () => {
    throw new NotPorted("str.encode()");
  },
};

function stripChars(s: string, chars: string, left: boolean, right: boolean): string {
  let a = 0;
  let b = s.length;
  if (left) while (a < b && chars.includes(s[a]!)) a++;
  if (right) while (b > a && chars.includes(s[b - 1]!)) b--;
  return s.slice(a, b);
}

const MARKUP_PRESERVING = new Set(["strip", "lstrip", "rstrip", "lower", "upper", "title", "capitalize", "replace", "zfill"]);

function dictMethod(d: Map<unknown, unknown> | Record<string, unknown>, name: string): ((args: unknown[]) => unknown) | null {
  switch (name) {
    case "get":
      return ([k, dflt]) => {
        const r = dictGet(d, k);
        return r.found ? r.value : dflt === undefined ? null : dflt;
      };
    case "items":
      return () => dictEntries(d).map(([k, v]) => pyTuple([k, v]));
    case "keys":
      return () => dictEntries(d).map(([k]) => k);
    case "values":
      return () => dictEntries(d).map(([, v]) => v);
    case "copy":
      return () => new Map(dictEntries(d));
    default:
      return null;
  }
}

function listMethod(l: unknown[], name: string): ((args: unknown[]) => unknown) | null {
  switch (name) {
    case "index":
      return ([v]) => {
        const i = l.findIndex((x) => pyEq(x, v));
        if (i < 0) throw new Error("ValueError: value is not in list");
        return i;
      };
    case "count":
      return ([v]) => l.filter((x) => pyEq(x, v)).length;
    case "pop":
      return ([i]) => {
        if (!l.length) throw new Error("IndexError: pop from empty list");
        return l.splice(typeof i === "number" ? (i < 0 ? l.length + i : i) : l.length - 1, 1)[0];
      };
    default:
      return null;
  }
}

/** Python attribute access `obj.name`. */
export function getAttr(obj: unknown, name: string, exprText: string): unknown {
  if (name.includes("__")) throw new NotPorted(`python expression ${JSON.stringify(exprText)}: dunder attribute ${name}`);
  if (obj instanceof PyObject) return obj.pyGetAttr(name);
  if (isNone(obj)) throw new PyEvalError(`AttributeError: 'NoneType' object has no attribute '${name}'`, exprText);
  if (typeof obj === "string" || obj instanceof Markup) {
    const m = STR_METHODS[name];
    if (m === undefined) throw new NotPorted(`python expression ${JSON.stringify(exprText)}: str method ${name}`);
    const s = obj.toString();
    const markup = obj instanceof Markup;
    return (...args: unknown[]) => {
      const r = m(s, stripKwargs(args, name));
      return markup && MARKUP_PRESERVING.has(name) && typeof r === "string" ? new Markup(r) : r;
    };
  }
  if (isDict(obj)) {
    const m = dictMethod(obj, name);
    if (m !== null) return (...args: unknown[]) => m(stripKwargs(args, name));
    // a plain object may be an attribute object of the host (request, res_company, ...) rather than a dict
    if (!(obj instanceof Map) && name in obj) {
      const v = (obj as Record<string, unknown>)[name];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(obj) : v;
    }
    throw new NotPorted(`python expression ${JSON.stringify(exprText)}: ${obj instanceof Map ? "dict method" : "attribute"} ${name} is not provided`);
  }
  if (Array.isArray(obj)) {
    const m = listMethod(obj, name);
    if (m === null) throw new NotPorted(`python expression ${JSON.stringify(exprText)}: list method ${name}`);
    return (...args: unknown[]) => m(stripKwargs(args, name));
  }
  if (typeof obj === "object" || typeof obj === "function") {
    const o = obj as Record<string, unknown>;
    if (!(name in o)) throw new NotPorted(`python expression ${JSON.stringify(exprText)}: attribute ${name} is not provided on the ${pyTypeName(obj)} value`);
    const v = o[name];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(obj) : v;
  }
  throw new NotPorted(`python expression ${JSON.stringify(exprText)}: attribute ${name} on ${pyTypeName(obj)}`);
}

function stripKwargs(args: unknown[], method: string): unknown[] {
  if (args.length > 0 && args[args.length - 1] instanceof PyKwargs) throw new NotPorted(`keyword arguments to ${method}()`);
  return args;
}

/** Python `obj[key]`. */
export function getItem(obj: unknown, key: unknown, exprText: string): unknown {
  if (obj instanceof PyObject) return obj.pyGetItem(key);
  if (Array.isArray(obj) || typeof obj === "string" || obj instanceof Markup) {
    const seq = typeof obj === "string" ? obj : obj instanceof Markup ? obj.toString() : obj;
    if (typeof key !== "number" && typeof key !== "boolean") throw new PyEvalError(`TypeError: indices must be integers, not ${pyTypeName(key)}`, exprText);
    let i = toNumber(key);
    if (i < 0) i += seq.length;
    if (i < 0 || i >= seq.length) throw new PyEvalError("IndexError: index out of range", exprText);
    const item = typeof seq === "string" ? seq[i]! : seq[i];
    return obj instanceof Markup ? new Markup(item as string) : item;
  }
  if (isDict(obj)) {
    const r = dictGet(obj, key);
    if (!r.found) throw new PyEvalError(`KeyError: ${pyRepr(key)}`, exprText);
    return r.value;
  }
  if (isNone(obj)) throw new PyEvalError("TypeError: 'NoneType' object is not subscriptable", exprText);
  if (typeof obj === "object") {
    // attribute objects with a `__getitem__`-like accessor provided by the host (e.g. `env['ir.http']`)
    const o = obj as { getitem?: unknown };
    if (typeof o.getitem === "function") return (o.getitem as (k: unknown) => unknown).call(obj, key);
  }
  throw new NotPorted(`python expression ${JSON.stringify(exprText)}: subscript on ${pyTypeName(obj)}`);
}

function sliceOf(obj: unknown, lower: unknown, upper: unknown, step: unknown, exprText: string): unknown {
  if (!isNone(step) && step !== undefined && pyInt(step) !== 1) throw new NotPorted(`python expression ${JSON.stringify(exprText)}: slice step`);
  const isStr = typeof obj === "string" || obj instanceof Markup;
  if (!Array.isArray(obj) && !isStr) throw new PyEvalError(`TypeError: '${pyTypeName(obj)}' object is not subscriptable`, exprText);
  const seq: string | unknown[] = typeof obj === "string" ? obj : obj instanceof Markup ? obj.toString() : (obj as unknown[]);
  const n = seq.length;
  const norm = (v: unknown, dflt: number): number => {
    if (v === undefined || isNone(v)) return dflt;
    let i = pyInt(v);
    if (i < 0) i += n;
    return Math.max(0, Math.min(n, i));
  };
  const a = norm(lower, 0);
  const b = norm(upper, n);
  const out = seq.slice(a, Math.max(a, b));
  if (obj instanceof Markup) return new Markup(out as string);
  if (obj instanceof PyTuple) return pyTuple(out as unknown[]);
  return out;
}

/** Python binary operators. */
export function binary(op: string, a: unknown, b: unknown): unknown {
  switch (op) {
    case "+": {
      if (a instanceof Markup || b instanceof Markup) {
        if ((typeof a === "string" || a instanceof Markup) && (typeof b === "string" || b instanceof Markup)) {
          // Markup.__add__ / __radd__: the plain side is escaped
          return new Markup(escape(a).toString() + escape(b).toString());
        }
        throw new TypeError(`can only concatenate str (not "${pyTypeName(a instanceof Markup ? b : a)}") to str`);
      }
      if (typeof a === "string" && typeof b === "string") return a + b;
      if (Array.isArray(a) && Array.isArray(b)) {
        if (a instanceof PyTuple && b instanceof PyTuple) return pyTuple([...a, ...b]);
        if (a instanceof PyTuple || b instanceof PyTuple) throw new TypeError("can only concatenate list (not tuple) to list");
        return [...a, ...b];
      }
      return arith(a, b, (x, y) => x + y);
    }
    case "-":
      return arith(a, b, (x, y) => x - y);
    case "*": {
      if (typeof a === "string" && typeof b === "number") return a.repeat(Math.max(0, b));
      if (typeof b === "string" && typeof a === "number") return b.repeat(Math.max(0, a));
      if (Array.isArray(a) && typeof b === "number") return Array<unknown>(Math.max(0, b)).fill(null).flatMap(() => a);
      return arith(a, b, (x, y) => x * y);
    }
    case "/": {
      const y = toNumber(b);
      if (y === 0) throw new Error("ZeroDivisionError: division by zero");
      return asFloat(toNumber(a) / y);
    }
    case "//": {
      const y = toNumber(b);
      if (y === 0) throw new Error("ZeroDivisionError: integer division or modulo by zero");
      const r = Math.floor(toNumber(a) / y);
      return isFloatValue(a) || isFloatValue(b) ? asFloat(r) : r;
    }
    case "%": {
      if (typeof a === "string" || a instanceof Markup) return percentFormat(a, b);
      const y = toNumber(b);
      if (y === 0) throw new Error("ZeroDivisionError: integer division or modulo by zero");
      const x = toNumber(a);
      const r = x - Math.floor(x / y) * y; // Python: the result has the sign of the divisor
      return isFloatValue(a) || isFloatValue(b) ? asFloat(r) : r;
    }
    case "**":
      return arith(a, b, (x, y) => x ** y);
    default:
      throw new NotPorted(`operator ${op}`);
  }
}

function arith(a: unknown, b: unknown, f: (x: number, y: number) => number): unknown {
  const r = f(toNumber(a), toNumber(b));
  return isFloatValue(a) || isFloatValue(b) ? asFloat(r) : r;
}

/** Python `a in b`. */
export function contains(item: unknown, container: unknown): boolean {
  if (container instanceof PyObject) {
    const r = container.pyContains(item);
    if (r !== null) return r;
  }
  if (typeof container === "string" || container instanceof Markup) {
    if (typeof item !== "string" && !(item instanceof Markup)) throw new TypeError(`'in <string>' requires string as left operand, not ${pyTypeName(item)}`);
    return container.toString().includes(item.toString());
  }
  if (Array.isArray(container)) return container.some((x) => pyEq(x, item));
  if (isDict(container)) return dictGet(container, item).found;
  if (container instanceof Set) return container.has(item);
  if (isNone(container)) throw new TypeError("argument of type 'NoneType' is not iterable");
  throw new NotPorted(`'in' on ${pyTypeName(container)}`);
}

export function compare(op: string, a: unknown, b: unknown): boolean {
  switch (op) {
    case "==":
      return pyEq(a, b);
    case "!=":
      return !pyEq(a, b);
    case "<":
      return pyCompare(a, b) < 0;
    case ">":
      return pyCompare(a, b) > 0;
    case "<=":
      return pyCompare(a, b) <= 0;
    case ">=":
      return pyCompare(a, b) >= 0;
    case "in":
      return contains(a, b);
    case "not in":
      return !contains(a, b);
    case "is":
      return isNone(a) && isNone(b) ? true : a === b;
    case "is not":
      return isNone(a) && isNone(b) ? false : a !== b;
    default:
      throw new NotPorted(`comparison ${op}`);
  }
}

/**
 * `evaluate` for templates that reach records: attribute reads and calls may be promises, lambdas and comprehensions
 * are supported. Same semantics otherwise (`ast` of the same parser).
 */
export async function evaluateAsync(node: Expr, scope: Scope, exprText: string): Promise<unknown> {
  const ev = (n: Expr, s: Scope = scope): Promise<unknown> => evaluateAsync(n, s, exprText);
  switch (node.kind) {
    case "name":
      if (node.id.includes("__")) throw new NotPorted(`python expression ${JSON.stringify(exprText)}: name ${node.id}`);
      if (BUILTIN_NAMES.has(node.id)) return BUILTINS[node.id];
      return scope.has(node.id) ? (scope.get(node.id) ?? null) : null;
    case "const":
      return node.value;
    case "num":
      return node.isFloat ? asFloat(node.value) : node.value;
    case "str":
      return node.value;
    case "list": {
      const out: unknown[] = [];
      for (const item of node.items) out.push(await ev(item));
      return out;
    }
    case "tuple": {
      const out: unknown[] = [];
      for (const item of node.items) out.push(await ev(item));
      return pyTuple(out);
    }
    case "dict": {
      const m = new Map<unknown, unknown>();
      for (const item of node.items) {
        if ("unpack" in item) {
          const v = await ev(item.unpack);
          if (!isDict(v)) throw new PyEvalError(`TypeError: '${pyTypeName(v)}' object is not a mapping`, exprText);
          for (const [k, val] of dictEntries(v)) m.set(k, val);
        } else {
          const key = await ev(item.key);
          m.set(key, await ev(item.value));
        }
      }
      return m;
    }
    case "attr":
      return getAttr(await ev(node.obj), node.name, exprText);
    case "subscript":
      return getItem(await ev(node.obj), await ev(node.index), exprText);
    case "slice": {
      const obj = await ev(node.obj);
      const lower = node.lower === null ? null : await ev(node.lower);
      const upper = node.upper === null ? null : await ev(node.upper);
      const step = node.step === null ? null : await ev(node.step);
      if (!(obj instanceof PyObject)) return sliceOf(obj, lower, upper, step, exprText);
      const items = sliceOf(iterate(obj, "slice"), lower, upper, step, exprText) as unknown[];
      return obj.pyFromSlice(items) ?? items;
    }
    case "call": {
      const func = await ev(node.func);
      const args: unknown[] = [];
      for (const a of node.args) args.push(await ev(a));
      let kwargs: PyKwargs | null = null;
      if (node.kwargs.length > 0) {
        const m = new Map<string, unknown>();
        for (const k of node.kwargs) m.set(k.name, await ev(k.value));
        kwargs = new PyKwargs(m);
      }
      if (typeof func !== "function") throw new PyEvalError(`TypeError: '${pyTypeName(func)}' object is not callable`, exprText);
      if (node.func.kind === "name" && BUILTIN_NAMES.has(node.func.id)) return (func as Builtin)(args, kwargs);
      const result: unknown = await (kwargs === null ? (func as (...a: unknown[]) => unknown)(...args) : (func as (...a: unknown[]) => unknown)(...args, kwargs));
      return result === undefined ? null : result;
    }
    case "unary": {
      const v = await ev(node.operand);
      if (node.op === "not") return !pyBool(v);
      if (node.op === "-") return isFloatValue(v) ? asFloat(-toNumber(v)) : -toNumber(v);
      return isPyFloat(v) ? v : toNumber(v);
    }
    case "binary": {
      const left = await ev(node.left);
      const right = await ev(node.right);
      if (left instanceof PyObject && node.op === "+") return left.pyAdd(right);
      if (left instanceof PyObject && node.op === "-") {
        const r = left.pySub(right);
        if (r !== undefined) return r;
      }
      return binary(node.op, left, right);
    }
    case "compare": {
      let left = await ev(node.left);
      for (let i = 0; i < node.ops.length; i++) {
        const right = await ev(node.comparators[i]!);
        if (!compare(node.ops[i]!, left, right)) return false;
        left = right;
      }
      return true;
    }
    case "bool": {
      let v: unknown = null;
      for (const sub of node.values) {
        v = await ev(sub);
        if (node.op === "and" ? !pyBool(v) : pyBool(v)) return v;
      }
      return v;
    }
    case "ifexp":
      return pyBool(await ev(node.test)) ? ev(node.body) : ev(node.orelse);
    case "lambda":
      return async (...args: unknown[]): Promise<unknown> => {
        const inner: Scope = new Map(scope);
        node.params.forEach((p, i) => inner.set(p, args[i] ?? null));
        return evaluateAsync(node.body, inner, exprText);
      };
    case "comp": {
      const out: unknown[] = [];
      const pairs = new Map<unknown, unknown>();
      const walk = async (index: number, s: Scope): Promise<void> => {
        if (index === node.clauses.length) {
          if (node.value !== null) pairs.set(await ev(node.elt, s), await ev(node.value, s));
          else out.push(await ev(node.elt, s));
          return;
        }
        const clause = node.clauses[index]!;
        for (const item of iterate(await ev(clause.iter, s), "comprehension")) {
          const inner: Scope = new Map(s);
          if (clause.targets.length === 1) inner.set(clause.targets[0]!, item);
          else {
            const parts = iterate(item, "comprehension");
            clause.targets.forEach((t, i) => inner.set(t, parts[i]));
          }
          let keep = true;
          for (const cond of clause.ifs) {
            if (!pyBool(await ev(cond, inner))) { keep = false; break; }
          }
          if (keep) await walk(index + 1, inner);
        }
      };
      await walk(0, scope);
      return node.value !== null ? pairs : out;
    }
    default: {
      const never: never = node;
      return never;
    }
  }
}

export function evaluate(node: Expr, scope: Scope, exprText: string): unknown {
  const ev = (n: Expr): unknown => evaluate(n, scope, exprText);
  switch (node.kind) {
    case "name":
      if (node.id.includes("__")) throw new NotPorted(`python expression ${JSON.stringify(exprText)}: name ${node.id}`);
      if (BUILTIN_NAMES.has(node.id)) return BUILTINS[node.id];
      return scope.has(node.id) ? (scope.get(node.id) ?? null) : null;
    case "const":
      return node.value;
    case "num":
      return node.isFloat ? asFloat(node.value) : node.value;
    case "str":
      return node.value;
    case "list":
      return node.items.map(ev);
    case "tuple":
      return pyTuple(node.items.map(ev));
    case "dict": {
      const m = new Map<unknown, unknown>();
      for (const item of node.items) {
        if ("unpack" in item) {
          const v = ev(item.unpack);
          if (!isDict(v)) throw new PyEvalError(`TypeError: '${pyTypeName(v)}' object is not a mapping`, exprText);
          for (const [k, val] of dictEntries(v)) m.set(k, val);
        } else {
          m.set(ev(item.key), ev(item.value));
        }
      }
      return m;
    }
    case "attr":
      return getAttr(ev(node.obj), node.name, exprText);
    case "subscript":
      return getItem(ev(node.obj), ev(node.index), exprText);
    case "slice":
      return sliceOf(ev(node.obj), node.lower === null ? null : ev(node.lower), node.upper === null ? null : ev(node.upper), node.step === null ? null : ev(node.step), exprText);
    case "call": {
      const func = ev(node.func);
      const args = node.args.map(ev);
      const kwargs = node.kwargs.length > 0 ? new PyKwargs(new Map(node.kwargs.map((k) => [k.name, ev(k.value)]))) : null;
      if (typeof func !== "function") throw new PyEvalError(`TypeError: '${pyTypeName(func)}' object is not callable`, exprText);
      if (node.func.kind === "name" && BUILTIN_NAMES.has(node.func.id)) return (func as Builtin)(args, kwargs);
      const result: unknown = kwargs === null ? (func as (...a: unknown[]) => unknown)(...args) : (func as (...a: unknown[]) => unknown)(...args, kwargs);
      return result === undefined ? null : result;
    }
    case "unary": {
      const v = ev(node.operand);
      if (node.op === "not") return !pyBool(v);
      if (node.op === "-") return isFloatValue(v) ? asFloat(-toNumber(v)) : -toNumber(v);
      return isPyFloat(v) ? v : toNumber(v);
    }
    case "binary":
      return binary(node.op, ev(node.left), ev(node.right));
    case "compare": {
      let left = ev(node.left);
      for (let i = 0; i < node.ops.length; i++) {
        const right = ev(node.comparators[i]!);
        if (!compare(node.ops[i]!, left, right)) return false;
        left = right;
      }
      return true;
    }
    case "bool": {
      let v: unknown = null;
      for (const sub of node.values) {
        v = ev(sub);
        if (node.op === "and" ? !pyBool(v) : pyBool(v)) return v;
      }
      return v;
    }
    case "ifexp":
      return pyBool(ev(node.test)) ? ev(node.body) : ev(node.orelse);
    case "lambda":
    case "comp":
      throw new NotPorted(`python expression ${JSON.stringify(exprText)}: ${node.kind} outside an asynchronous evaluation`);
    default: {
      const never: never = node;
      return never;
    }
  }
}
