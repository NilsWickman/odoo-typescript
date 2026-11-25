/**
 * The Python value model of the expression evaluator, mapped to JS:
 *   None -> null (undefined is read as None), bool, int -> number, float -> number or PyFloat (orm/types.ts) when
 *   integral, str -> string, list -> Array, tuple -> PyTuple (an Array subclass), dict -> Map or a plain object
 *   (prototype Object or null; insertion order is Python's key order, so pass a Map when keys look like integers),
 *   markupsafe.Markup -> Markup, functions -> JS functions (keyword arguments arrive as a trailing PyKwargs),
 *   everything else (records, request, ...) -> "attribute objects" read with property access.
 * Also here: truthiness, str()/repr(), ==, `%` formatting and `json.dumps` with CPython's output format.
 */
import { NotPorted } from "../errors";
import type { PyFloat } from "../orm/types";

/** `markupsafe.Markup`: html that `escape()` leaves alone. */
export class Markup {
  readonly html: string;
  constructor(html: string) {
    this.html = html;
  }
  /** `str(markup)`. */
  toString(): string {
    return this.html;
  }
  /** `__html__()`: the markup as emitted by `escape()`. */
  __html__(): string {
    return this.html;
  }
}

/** A Python tuple (an Array that remembers it is a tuple: `%` formatting and repr differ). */
export class PyTuple extends Array<unknown> {
  static override get [Symbol.species](): ArrayConstructor {
    return Array; // map/filter/slice on a tuple give plain arrays
  }
}

export function pyTuple(items: Iterable<unknown>): PyTuple {
  const t = new PyTuple();
  for (const i of items) t.push(i);
  return t;
}

/** Keyword arguments of a call, passed as the trailing argument to a JS function value. */
export class PyKwargs {
  readonly entries: Map<string, unknown>;
  constructor(entries: Map<string, unknown>) {
    this.entries = entries;
  }
}

export function isPyFloat(v: unknown): v is PyFloat {
  return typeof v === "object" && v !== null && "float" in v && typeof (v as { float: unknown }).float === "number" && Object.keys(v).length === 1;
}

export function isNone(v: unknown): v is null | undefined {
  return v === null || v === undefined;
}

/** A Python dict: Map or a plain object. */
export function isDict(v: unknown): v is Map<unknown, unknown> | Record<string, unknown> {
  if (v instanceof Map) return true;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

export function dictEntries(d: Map<unknown, unknown> | Record<string, unknown>): [unknown, unknown][] {
  return d instanceof Map ? [...d.entries()] : Object.entries(d);
}

export function dictGet(d: Map<unknown, unknown> | Record<string, unknown>, key: unknown): { found: boolean; value: unknown } {
  if (d instanceof Map) {
    if (d.has(key)) return { found: true, value: d.get(key) };
    // Python 1 == 1.0 == True as keys; JS Map keys are strict, so try the obvious alternates
    if (typeof key === "number" && d.has(String(key))) return { found: true, value: d.get(String(key)) };
    return { found: false, value: null };
  }
  const k = typeof key === "string" ? key : typeof key === "number" ? String(key) : null;
  if (k !== null && Object.hasOwn(d, k)) return { found: true, value: (d as Record<string, unknown>)[k] };
  return { found: false, value: null };
}

export function dictSize(d: Map<unknown, unknown> | Record<string, unknown>): number {
  return d instanceof Map ? d.size : Object.keys(d).length;
}

/** Python truthiness (`bool(x)`). */
/**
 * A host object of the Python expressions (records, `env`): attribute access may be asynchronous (`evalExprAsync`);
 * truth, length, iteration, equality and `in` follow the Python protocol of the object.
 */
export abstract class PyObject {
  abstract pyGetAttr(name: string): unknown;
  pyTruth(): boolean { return true; }
  pyLen(): number | null { return null; }
  pyIter(): unknown[] | null { return null; }
  pyEquals(other: unknown): boolean { return this === other; }
  pyContains(_item: unknown): boolean | null { return null; }
  pyGetItem(_key: unknown): unknown { return undefined; }
  pyAdd(_other: unknown): unknown { return undefined; }
  /** `self - other`; undefined: the operator's TypeError (binary()). */
  pySub(_other: unknown): unknown { return undefined; }
  /** `obj[a:b]` of an iterable object: the object for the sliced items (`records[:1]` is a recordset), else the list. */
  pyFromSlice(_items: unknown[]): unknown { return undefined; }
  pyToString(): string { return "<object>"; }
}

export function pyBool(v: unknown): boolean {
  if (isNone(v)) return false;
  if (v instanceof PyObject) return v.pyTruth();
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  if (v instanceof Markup) return v.toString().length > 0;
  if (isPyFloat(v)) return v.float !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (isDict(v)) return dictSize(v) > 0;
  if (v instanceof Set) return v.size > 0;
  return true;
}

export function isFloatValue(v: unknown): boolean {
  return isPyFloat(v) || (typeof v === "number" && !Number.isInteger(v));
}

export function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (isPyFloat(v)) return v.float;
  throw new TypeError(`unsupported operand type: ${pyTypeName(v)}`);
}

/** Wrap an integral result of a float operation so it prints as `x.0`. */
export function asFloat(n: number): number | PyFloat {
  return Number.isInteger(n) ? { float: n } : n;
}

/** `repr(float)` as CPython prints it (shortest round-trip digits, exponent form below 1e-4 and from 1e16). */
export function pyFloatRepr(n: number): string {
  if (Number.isNaN(n)) return "nan";
  if (n === Infinity) return "inf";
  if (n === -Infinity) return "-inf";
  if (n === 0) return Object.is(n, -0) ? "-0.0" : "0.0";
  const abs = Math.abs(n);
  if (abs >= 1e16 || abs < 1e-4) {
    const [mant, exp] = n.toExponential().split("e") as [string, string];
    const e = parseInt(exp, 10);
    return `${mant}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
  }
  const s = String(n);
  return s.includes(".") ? s : `${s}.0`;
}

export function pyTypeName(v: unknown): string {
  if (isNone(v)) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (isPyFloat(v)) return "float";
  if (typeof v === "string") return "str";
  if (v instanceof Markup) return "Markup";
  if (v instanceof PyTuple) return "tuple";
  if (Array.isArray(v)) return "list";
  if (isDict(v)) return "dict";
  if (typeof v === "function") return "function";
  return "object";
}

/** `str(x)`. */
export function pyStr(v: unknown): string {
  if (v instanceof PyObject) return v.pyToString();
  if (isNone(v)) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  if (isPyFloat(v)) return pyFloatRepr(v.float);
  if (typeof v === "string") return v;
  if (v instanceof Markup) return v.toString();
  return pyRepr(v);
}

/** `repr(x)`. */
export function pyRepr(v: unknown): string {
  if (typeof v === "string") return reprStr(v);
  if (v instanceof Markup) return `Markup(${reprStr(v.toString())})`;
  if (v instanceof PyTuple) return v.length === 1 ? `(${pyRepr(v[0])},)` : `(${v.map(pyRepr).join(", ")})`;
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (isDict(v)) return `{${dictEntries(v).map(([k, val]) => `${pyRepr(k)}: ${pyRepr(val)}`).join(", ")}}`;
  if (isNone(v) || typeof v === "boolean" || typeof v === "number" || isPyFloat(v)) return pyStr(v);
  throw new NotPorted(`repr() of a ${pyTypeName(v)} value`);
}

function reprStr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === quote || ch === "\\") out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return out + quote;
}

/** Python `==`. */
export function pyEq(a: unknown, b: unknown): boolean {
  if (a instanceof PyObject) return a.pyEquals(b);
  if (b instanceof PyObject) return b.pyEquals(a);
  if (isNone(a) || isNone(b)) return isNone(a) && isNone(b);
  const na = typeof a === "number" || typeof a === "boolean" || isPyFloat(a);
  const nb = typeof b === "number" || typeof b === "boolean" || isPyFloat(b);
  if (na && nb) return toNumber(a) === toNumber(b);
  if (na !== nb) return false;
  const sa = typeof a === "string" || a instanceof Markup;
  const sb = typeof b === "string" || b instanceof Markup;
  if (sa && sb) return String(a) === String(b);
  if (sa !== sb) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if ((a instanceof PyTuple) !== (b instanceof PyTuple)) return false;
    return a.length === b.length && a.every((x, i) => pyEq(x, b[i]));
  }
  if (isDict(a) && isDict(b)) {
    const ea = dictEntries(a);
    if (ea.length !== dictSize(b)) return false;
    return ea.every(([k, v]) => {
      const r = dictGet(b, k);
      return r.found && pyEq(v, r.value);
    });
  }
  return a === b;
}

/** Python ordering comparison for numbers and strings (lists/tuples lexicographically). */
export function pyCompare(a: unknown, b: unknown): number {
  const na = typeof a === "number" || typeof a === "boolean" || isPyFloat(a);
  const nb = typeof b === "number" || typeof b === "boolean" || isPyFloat(b);
  if (na && nb) {
    const x = toNumber(a);
    const y = toNumber(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = pyCompare(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  throw new TypeError(`'<' not supported between instances of '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

/** `markupsafe.escape(x)`: Markup passes through, everything else is `str()`'d and HTML-escaped. */
export function escape(v: unknown): Markup {
  if (v instanceof Markup) return new Markup(v.__html__());
  return new Markup(escapeHtml(pyStr(v)));
}

/** markupsafe's escaping table: `&`, `<`, `>`, `"` -> `&#34;`, `'` -> `&#39;`. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&#34;" : "&#39;"));
}

/**
 * Python's `'%.Nf' % x` / `format(x, '.Nf')`: the exact binary value rounded to N decimals, an exact tie to even.
 * `Number.prototype.toFixed` rounds the same exact value but a tie away from zero (`'%.1f' % 0.25` is `0.2`, not `0.3`).
 */
export function toFixedHalfEven(x: number, digits: number): string {
  // -0.0 keeps its sign in CPython ('%.1f' % -0.0 is '-0.0'); toFixed drops it
  if (Object.is(x, -0)) return "-" + (0).toFixed(digits);
  const s = x.toFixed(digits);
  if (!Number.isFinite(x) || Number.isInteger(x) || Math.abs(x) >= 1e21) return s;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x));
  const bits = view.getBigUint64(0);
  const expBits = Number((bits >> 52n) & 0x7ffn);
  const mant = expBits === 0 ? bits & 0xfffffffffffffn : (bits & 0xfffffffffffffn) | (1n << 52n);
  const shift = BigInt(expBits === 0 ? 1074 : 1075 - expBits); // |x| = mant / 2^shift, shift > 0 for a non-integer
  const twice = mant * 10n ** BigInt(digits) * 2n; // 2·|x|·10^digits = twice / 2^shift
  const den = 1n << shift;
  if (twice % den !== 0n || ((twice / den) & 1n) === 0n) return s; // not exactly halfway
  const lo = (twice / den - 1n) / 2n;
  const n = lo % 2n === 0n ? lo : lo + 1n;
  const d = n.toString().padStart(digits + 1, "0");
  const body = digits === 0 ? d : `${d.slice(0, d.length - digits)}.${d.slice(d.length - digits)}`;
  return x < 0 ? `-${body}` : body;
}

/** `fmt % args` for str and Markup (markupsafe escapes the arguments when the format string is Markup). */
export function percentFormat(fmt: string | Markup, args: unknown): string | Markup {
  const markup = fmt instanceof Markup;
  const text = fmt.toString();
  const positional: unknown[] = args instanceof PyTuple ? [...args] : [args];
  let argIndex = 0;
  const conv = (v: unknown): string => (markup ? escape(v).toString() : pyStr(v));
  const out = text.replace(/%(?:\(([^)]*)\))?([-+ 0#]*)(\d+|\*)?(?:\.(\d+|\*))?([diouxXeEfFgGcrsa%])/g, (m, key: string | undefined, flags0: string, width0: string | undefined, precision0: string | undefined, type: string) => {
    if (type === "%") return "%";
    let flags = flags0, width = width0, precision = precision0;
    // Objects/unicodeobject.c unicode_format_arg_parse: a `*` width or precision is the next positional argument, an
    // int (a bool is one), else "* wants int"; a negative width left-justifies (compiler thread K2, rådet runda 13)
    const star = (): number => {
      if (key !== undefined) throw new TypeError("* wants int");
      if (argIndex >= positional.length) throw new TypeError("not enough arguments for format string");
      const a = positional[argIndex++];
      if (typeof a === "boolean") return a ? 1 : 0;
      if (typeof a !== "number" || !Number.isInteger(a) || isPyFloat(a)) throw new TypeError("* wants int");
      return a;
    };
    if (width === "*") {
      const w = star();
      if (w < 0) flags += "-";
      width = String(Math.abs(w));
    }
    if (precision === "*") {
      const p = star();
      if (p < 0) throw new NotPorted("a negative `*` precision in % formatting");
      precision = String(p);
    }
    let v: unknown;
    if (key !== undefined) {
      if (!isDict(args)) throw new TypeError("format requires a mapping");
      const r = dictGet(args, key);
      if (!r.found) throw new Error(`KeyError: '${key}'`);
      v = r.value;
    } else {
      if (argIndex >= positional.length) throw new TypeError("not enough arguments for format string");
      v = positional[argIndex++];
    }
    let s: string;
    switch (type) {
      case "s":
        s = conv(v);
        break;
      case "r":
      case "a":
        s = pyRepr(v);
        break;
      case "d":
      case "i":
      case "u":
        s = String(Math.trunc(toNumber(v)));
        break;
      case "f":
      case "F":
        s = toFixedHalfEven(toNumber(v), precision !== undefined ? parseInt(precision, 10) : 6);
        break;
      case "e":
      case "E": {
        s = toNumber(v).toExponential(precision !== undefined ? parseInt(precision, 10) : 6);
        s = s.replace(/e([+-])(\d)$/, "e$10$2");
        if (type === "E") s = s.toUpperCase();
        break;
      }
      case "g":
      case "G":
        s = String(toNumber(v));
        break;
      case "x":
        s = Math.trunc(toNumber(v)).toString(16);
        break;
      case "X":
        s = Math.trunc(toNumber(v)).toString(16).toUpperCase();
        break;
      case "o":
        s = Math.trunc(toNumber(v)).toString(8);
        break;
      case "c":
        s = typeof v === "string" ? v : String.fromCodePoint(toNumber(v));
        break;
      default:
        throw new NotPorted(`format specifier ${m}`);
    }
    if (flags.includes("#")) throw new NotPorted(`format specifier ${m}`);
    // the sign flags of a number: '+' always, ' ' a space for a positive value (CPython printf-style formatting)
    if ("diufFeE".includes(type) && !s.startsWith("-")) {
      if (flags.includes("+")) s = "+" + s;
      else if (flags.includes(" ")) s = " " + s;
    }
    if (precision !== undefined && type === "s") s = s.slice(0, parseInt(precision, 10));
    if (width !== undefined) {
      const w = parseInt(width, 10);
      if (s.length < w) {
        if (flags.includes("-")) s = s.padEnd(w);
        else if (flags.includes("0") && "diouxXeEfFgG".includes(type)) s = /^[-+ ]/.test(s) ? s[0] + s.slice(1).padStart(w - 1, "0") : s.padStart(w, "0");
        else s = s.padStart(w);
      }
    }
    return s;
  });
  if (key_free(text) && argIndex < positional.length) throw new TypeError("not all arguments converted during string formatting");
  return markup ? new Markup(out) : out;
}

function key_free(text: string): boolean {
  return !/%\(/.test(text);
}

/** `json.dumps(obj)` with CPython's defaults (`ensure_ascii=True`, separators `, ` and `: `, insertion order). */
export function jsonDumps(v: unknown, defaultFn?: (v: unknown) => unknown): string {
  if (isNone(v)) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return String(v);
    if (Number.isNaN(v)) return "NaN";
    if (!Number.isFinite(v)) return v > 0 ? "Infinity" : "-Infinity";
    return pyFloatRepr(v);
  }
  if (isPyFloat(v)) return pyFloatRepr(v.float);
  if (typeof v === "string") return jsonString(v);
  if (Array.isArray(v)) return `[${v.map((x) => jsonDumps(x, defaultFn)).join(", ")}]`;
  if (isDict(v)) {
    return `{${dictEntries(v)
      .map(([k, val]) => {
        let key: string;
        if (typeof k === "string") key = k;
        else if (typeof k === "number") key = Number.isInteger(k) ? String(k) : pyFloatRepr(k);
        else if (typeof k === "boolean") key = k ? "true" : "false";
        else if (isNone(k)) key = "null";
        else throw new TypeError(`keys must be str, int, float, bool or None, not ${pyTypeName(k)}`);
        return `${jsonString(key)}: ${jsonDumps(val, defaultFn)}`;
      })
      .join(", ")}}`;
  }
  if (defaultFn !== undefined) return jsonDumps(defaultFn(v), undefined);
  throw new TypeError(`Object of type ${pyTypeName(v)} is not JSON serializable`);
}

function jsonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const code = s.charCodeAt(i);
    if (c === '"') out += '\\"';
    else if (c === "\\") out += "\\\\";
    else if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else if (c === "\t") out += "\\t";
    else if (c === "\b") out += "\\b";
    else if (c === "\f") out += "\\f";
    else if (code < 0x20 || code > 0x7e) out += `\\u${code.toString(16).padStart(4, "0")}`; // ensure_ascii, surrogates stay paired
    else out += c;
  }
  return out + '"';
}
