/**
 * Odoo domains (`odoo/odoo/orm/domains.py`): parsing the prefix-notation list into the `Domain` tree, the boolean
 * algebra (AND/OR flattening, NOT), and the BASIC optimization level (domains.py:433 `Domain.optimize`), which
 * only depends on field definitions and is therefore pure. The FULL level (searchable fields, `_inherits`,
 * hierarchy operators, access) needs the database and lives in sql.ts.
 *
 * Values: Odoo's `OrderedSet` becomes a deduplicated array; `date`/`datetime` objects become PyDate/PyDateTime.
 */
import { NotPorted, OdooError } from "../errors";
import type { Domain, FieldType, ModelDef, Registry } from "./types";
import { isPyFloat, plainNumber, str2bool } from "./values";

// --------------------------------------------------------------------------------------------------------------
// Errors (Python builtins raised by domains.py; the JSON-RPC data.name is the dotted Python name)
// --------------------------------------------------------------------------------------------------------------

export class PyValueError extends OdooError {
  constructor(message: string) {
    super("builtins.ValueError", message);
  }
}

export class PyTypeError extends OdooError {
  constructor(message: string) {
    super("builtins.TypeError", message);
  }
}

// --------------------------------------------------------------------------------------------------------------
// Operators (domains.py:80-170)
// --------------------------------------------------------------------------------------------------------------

export const STANDARD_CONDITION_OPERATORS: ReadonlySet<string> = new Set([
  "any", "not any", "any!", "not any!", "in", "not in", "<", ">", "<=", ">=",
  "like", "not like", "ilike", "not ilike", "=like", "not =like", "=ilike", "not =ilike",
]);

/** STANDARD plus the operators rewritten by `@operator_optimization` (domains.py:1340-1972). */
export const CONDITION_OPERATORS: ReadonlySet<string> = new Set([
  ...STANDARD_CONDITION_OPERATORS, "=?", "=", "!=", "parent_of", "child_of", "access",
]);

export const NEGATIVE_CONDITION_OPERATORS: Readonly<Record<string, string>> = {
  "not any": "any", "not any!": "any!", "not in": "in", "not like": "like", "not ilike": "ilike",
  "not =like": "=like", "not =ilike": "=ilike", "!=": "=",
};

const INVERSE_OPERATOR: Readonly<Record<string, string>> = {
  ...NEGATIVE_CONDITION_OPERATORS,
  "any": "not any", "any!": "not any!", "in": "not in", "like": "not like", "ilike": "not ilike",
  "=like": "not =like", "=ilike": "not =ilike", "=": "!=",
};

const INVERSE_INEQUALITY: Readonly<Record<string, string>> = { "<": ">=", ">": "<=", ">=": "<", "<=": ">" };

export function isNegativeOperator(op: string): boolean {
  return op in NEGATIVE_CONDITION_OPERATORS;
}

// --------------------------------------------------------------------------------------------------------------
// Date values (fields_temporal.py DATE_FORMAT / DATETIME_FORMAT, domains.py:1590-1748)
// --------------------------------------------------------------------------------------------------------------

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** A Python `date` in a domain value. */
export class PyDate {
  readonly ms: number;
  constructor(ms: number) { this.ms = ms; }
  toString(): string {
    const d = new Date(this.ms);
    return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
  }
  get year(): number { return new Date(this.ms).getUTCFullYear(); }
}

/** A naive Python `datetime` (UTC wall time) in a domain value; microseconds are kept until dropped explicitly. */
export class PyDateTime {
  readonly ms: number;
  constructor(ms: number) { this.ms = ms; }
  toString(): string {
    const d = new Date(this.ms);
    return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)} `
      + `${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}`;
  }
  get year(): number { return new Date(this.ms).getUTCFullYear(); }
  withoutMicroseconds(): PyDateTime { return new PyDateTime(this.ms - (this.ms % 1000)); }
  plusSeconds(n: number): PyDateTime { return new PyDateTime(this.ms + n * 1000); }
  plusDays(n: number): PyDateTime { return new PyDateTime(this.ms + n * 86400000); }
  toDate(): PyDate { return new PyDate(this.ms - (((this.ms % 86400000) + 86400000) % 86400000)); }
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** `odoo.tools.date_utils.parse_iso_date` (date_utils.py:115): date for 10 chars or less, else a naive datetime. */
export function parseIsoDate(value: string): PyDate | PyDateTime {
  if (value.length <= 10) {
    const m = ISO_DATE.exec(value);
    if (m === null) throw new PyValueError(`Invalid isoformat string: '${value}'`);
    return new PyDate(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }
  const m = ISO_DATETIME.exec(value);
  if (m === null) throw new PyValueError(`Invalid isoformat string: '${value}'`);
  if (m[8] !== undefined) throw new PyValueError(`expecting only datetimes with no timezone: '${value}'`);
  const micros = m[7] === undefined ? 0 : Number(m[7].padEnd(6, "0"));
  return new PyDateTime(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? "0"), Math.floor(micros / 1000)));
}

/** UTC offset in ms of IANA zone `tz` at the UTC instant `ms`. */
function tzOffsetMs(tz: string, ms: number): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(parts["year"] ?? 1970, (parts["month"] ?? 1) - 1, parts["day"] ?? 1, parts["hour"] ?? 0, parts["minute"] ?? 0, parts["second"] ?? 0);
  return asUtc - (ms - (ms % 1000));
}

/** Midnight of `date` in zone `tz`, as a UTC datetime (`value.replace(tzinfo=env.tz).astimezone(utc)`, domains.py:1671). */
export function localMidnightToUtc(date: PyDate, tz: string): PyDateTime {
  let guess = date.ms - tzOffsetMs(tz, date.ms);
  const offset2 = tzOffsetMs(tz, guess);
  guess = date.ms - offset2;
  return new PyDateTime(guess);
}

// --------------------------------------------------------------------------------------------------------------
// Tree construction (domains.py:193-760)
// --------------------------------------------------------------------------------------------------------------

export const TRUE: Domain = { kind: "true" };
export const FALSE: Domain = { kind: "false" };

export function isDomain(v: unknown): v is Domain {
  if (typeof v !== "object" || v === null) return false;
  const kind = (v as { kind?: unknown }).kind;
  return kind === "and" || kind === "or" || kind === "not" || kind === "cond" || kind === "true" || kind === "false";
}

export function isTrue(d: Domain): boolean { return d.kind === "true"; }
export function isFalse(d: Domain): boolean { return d.kind === "false"; }

export function isCondition(d: Domain, fieldExpr?: string, operators?: readonly string[]): d is Extract<Domain, { kind: "cond" }> {
  return d.kind === "cond"
    && (fieldExpr === undefined || d.path === fieldExpr)
    && (operators === undefined || operators.includes(d.op));
}

/** Python truthiness of a JSON-ish value (`not value`). */
export function pyFalsy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return true;
  if (isPyFloat(v)) return v.float === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object" && Object.keys(v).length === 0 && !(v instanceof PyDate) && !(v instanceof PyDateTime)) return true;
  return false;
}

function condRepr(path: string, op: string, value: unknown): string {
  return `(${pyRepr(path)}, ${pyRepr(op)}, ${pyRepr(value)})`;
}

/** Python `repr` for the values that occur in domains (error messages). */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") {
    if (v.includes("'") && !v.includes('"')) return `"${v}"`;
    return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  if (typeof v === "number") return String(v);
  if (isPyFloat(v)) return Number.isInteger(v.float) ? `${v.float}.0` : String(v.float);
  if (v instanceof PyDate) return `datetime.date(${v.toString().split("-").map(Number).join(", ")})`;
  if (v instanceof PyDateTime) {
    const d = new Date(v.ms);
    const parts = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()];
    while (parts.length > 3 && parts[parts.length - 1] === 0) parts.pop();
    return `datetime.datetime(${parts.join(", ")})`;
  }
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (isDomain(v)) return pyRepr(toList(v));
  return String(v);
}

/** `DomainCondition(...).checked()` (domains.py:859). */
export function cond(path: string, op: string, value: unknown): Domain {
  if (typeof path !== "string" || path === "") {
    throw new PyTypeError(`Empty field name in condition ${condRepr(path, op, value)}`);
  }
  if (!CONDITION_OPERATORS.has(op)) {
    throw new PyValueError(`Invalid operator in condition ${condRepr(path, op, value)}`);
  }
  if (value === null || value === undefined) value = false;
  return { kind: "cond", path, op, value };
}

/** `DomainNary._flatten` (domains.py:624): absorb the neutral constant, short-circuit on the other, flatten. */
function flatten(kind: "and" | "or", children: Iterable<Domain>): Domain[] {
  const zero = kind === "and" ? "true" : "false";
  const result: Domain[] = [];
  for (const child of children) {
    if (child.kind === "true" || child.kind === "false") {
      if (child.kind !== zero) return [child];
    } else if (child.kind === kind) {
      result.push(...child.args);
    } else {
      result.push(child);
    }
  }
  return result.length === 0 ? [kind === "and" ? TRUE : FALSE] : result;
}

function nary(kind: "and" | "or", items: Iterable<Domain>): Domain {
  const children = flatten(kind, items);
  if (children.length === 1) return children[0] as Domain;
  return { kind, args: children };
}

export function and(items: Iterable<Domain>): Domain { return nary("and", items); }
export function or(items: Iterable<Domain>): Domain { return nary("or", items); }

/** `~domain` (domains.py:333, :529, :571, :658, :890). */
export function not(d: Domain): Domain {
  switch (d.kind) {
    case "true": return FALSE;
    case "false": return TRUE;
    case "not": return d.arg;
    case "and": return { kind: "or", args: d.args.map(not) };
    case "or": return { kind: "and", args: d.args.map(not) };
    case "cond": {
      // only for simple fields (not expressions); inequalities are handled in negate()
      const neg = INVERSE_OPERATOR[d.op];
      if (!d.path.includes(".") && neg !== undefined) return { kind: "cond", path: d.path, op: neg, value: d.value };
      return { kind: "not", arg: d };
    }
    default: {
      const never: never = d;
      throw new TypeError(String(never));
    }
  }
}

/**
 * `Domain(arg)` for a list (domains.py:240-272): prefix notation with '&', '|', '!' and 3-item conditions.
 * `internal` lets 'any!' through (sub-domains built by the ORM itself); request domains must not use it.
 */
/**
 * The values of `=`, `!=`, `in` and `not in` conditions end up in a Python set when the domain is optimized
 * (domains.py `_optimize_in_set` and the `=`/`!=` to `in`/`not in` rewrite): a dict or a list among them raises
 * `TypeError: unhashable type` (measured on Odoo for char, integer, many2one and boolean fields).
 */
function checkHashable(op: string, value: unknown): void {
  if (!["=", "!=", "in", "not in"].includes(op)) return;
  const kind = (v: unknown): string | null => Array.isArray(v) ? "list"
    : typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype ? "dict" : null;
  const items = Array.isArray(value) ? value : [value];
  for (const v of items) {
    const k = kind(v);
    if (k) throw new PyTypeError(`unhashable type: '${k}'`);
  }
}

export function parseDomain(arg: unknown, internal = false): Domain {
  if (isDomain(arg)) return arg;
  if (arg === true) return TRUE;
  if (arg === false) return FALSE;
  if (!Array.isArray(arg)) throw new PyTypeError(`Domain() invalid argument type for domain: ${pyRepr(arg)}`);
  if (arg.length === 0) return TRUE;
  const stack: Domain[] = [];
  const pop = (): Domain => {
    const d = stack.pop();
    if (d === undefined) throw new PyValueError(`Domain() malformed domain ${pyRepr(arg)}`);
    return d;
  };
  for (let i = arg.length - 1; i >= 0; i--) {
    const item: unknown = arg[i];
    if (Array.isArray(item) && item.length === 3) {
      const [path, op, rawValue] = item as [unknown, unknown, unknown];
      if (typeof path !== "string" || typeof op !== "string") {
        // Domain(1, '=', 1) / (0, '=', 1) are the TRUE/FALSE leaves (domains.py:169, :224)
        if (path === 1 && op === "=" && rawValue === 1) { stack.push(TRUE); continue; }
        if (path === 0 && op === "=" && rawValue === 1) { stack.push(FALSE); continue; }
        throw new PyTypeError(`Domain() invalid arguments: ${pyRepr(item)}`);
      }
      let value: unknown = plainNumber(rawValue);
      if (["any", "any!", "not any", "not any!"].includes(op) && Array.isArray(value)) {
        if (!internal && (op === "any!" || op === "not any!")) {
          throw new PyValueError(`Domain() invalid item in domain: ${pyRepr(item)}`);
        }
        value = parseDomain(value, internal);
      } else if (!internal && (op === "any!" || op === "not any!")) {
        throw new PyValueError(`Domain() invalid item in domain: ${pyRepr(item)}`);
      }
      if (!internal) checkHashable(op, value);
      stack.push(cond(path, op, value));
    } else if (item === "&") {
      stack.push(and([pop(), pop()]));
    } else if (item === "|") {
      stack.push(or([pop(), pop()]));
    } else if (item === "!") {
      stack.push(not(pop()));
    } else if (isDomain(item)) {
      stack.push(item);
    } else {
      throw new PyValueError(`Domain() invalid item in domain: ${pyRepr(item)}`);
    }
  }
  if (stack.length === 1) return stack[0] as Domain;
  return and(stack.reverse());
}

/** `list(domain)` (domains.py:378, :542, :574, :641, :912): the polish-notation list with JSON-able values. */
export function toList(d: Domain): unknown[] {
  const out: unknown[] = [];
  const emit = (node: Domain): void => {
    switch (node.kind) {
      case "true": out.push([1, "=", 1]); return;
      case "false": out.push([0, "=", 1]); return;
      case "not": out.push("!"); emit(node.arg); return;
      case "and":
      case "or":
        for (let i = 0; i < node.args.length - 1; i++) out.push(node.kind === "and" ? "&" : "|");
        node.args.forEach(emit);
        return;
      case "cond": out.push([node.path, node.op, listValue(node.value)]); return;
      default: {
        const never: never = node;
        throw new TypeError(String(never));
      }
    }
  };
  emit(d);
  return out;
}

function listValue(v: unknown): unknown {
  if (isDomain(v)) return toList(v);
  if (v instanceof PyDate || v instanceof PyDateTime) return v.toString();
  if (Array.isArray(v)) return v.map(listValue);
  return v;
}

export function* iterConditions(d: Domain): Generator<Extract<Domain, { kind: "cond" }>> {
  switch (d.kind) {
    case "cond": yield d; return;
    case "not": yield* iterConditions(d.arg); return;
    case "and":
    case "or":
      for (const child of d.args) yield* iterConditions(child);
      return;
    default: return;
  }
}

export function mapConditions(d: Domain, fn: (c: Extract<Domain, { kind: "cond" }>) => Domain): Domain {
  switch (d.kind) {
    case "cond": return fn(d);
    case "not": return not(mapConditions(d.arg, fn));
    case "and": return and(d.args.map((c) => mapConditions(c, fn)));
    case "or": return or(d.args.map((c) => mapConditions(c, fn)));
    default: return d;
  }
}

/** `Domain.__eq__` (domains.py:520, :587, :646, :919): structural equality, values compared by Python rules. */
export function equalDomains(a: Domain, b: Domain): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "true":
    case "false": return true;
    case "not": return equalDomains(a.arg, (b as typeof a).arg);
    case "and":
    case "or": {
      const bb = b as typeof a;
      return a.args.length === bb.args.length && a.args.every((x, i) => equalDomains(x, bb.args[i] as Domain));
    }
    case "cond": {
      const bb = b as typeof a;
      return a.path === bb.path && a.op === bb.op && equalValues(a.value, bb.value);
    }
    default: {
      const never: never = a;
      throw new TypeError(String(never));
    }
  }
}

export function equalValues(x: unknown, y: unknown): boolean {
  if (x === y) return true;
  if (isDomain(x) && isDomain(y)) return equalDomains(x, y);
  if (Array.isArray(x) && Array.isArray(y)) return x.length === y.length && x.every((v, i) => equalValues(v, y[i]));
  if (x instanceof PyDate && y instanceof PyDate) return x.ms === y.ms;
  if (x instanceof PyDateTime && y instanceof PyDateTime) return x.ms === y.ms;
  if (isPyFloat(x) || isPyFloat(y)) return plainNumber(x) === plainNumber(y);
  return false;
}

function valueKey(v: unknown): string {
  if (v === null || v === undefined || v === false) return "F";
  if (v === true) return "T";
  if (typeof v === "number") return `n${v}`;
  if (isPyFloat(v)) return `n${v.float}`;
  if (typeof v === "string") return `s${v}`;
  if (v instanceof PyDate) return `d${v.ms}`;
  if (v instanceof PyDateTime) return `t${v.ms}`;
  return `o${JSON.stringify(v)}`;
}

/** `OrderedSet(values)`: deduplicated, order kept. */
export function orderedSet(values: Iterable<unknown>): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const v of values) {
    const k = valueKey(v);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}

export function setMinus(a: readonly unknown[], b: readonly unknown[]): unknown[] {
  const drop = new Set(b.map(valueKey));
  return a.filter((v) => !drop.has(valueKey(v)));
}

export function setUnion(a: readonly unknown[], b: readonly unknown[]): unknown[] {
  return orderedSet([...a, ...b]);
}

export function setHas(a: readonly unknown[], v: unknown): boolean {
  const k = valueKey(v);
  return a.some((x) => valueKey(x) === k);
}

function isCollection(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

// --------------------------------------------------------------------------------------------------------------
// Field information needed by the BASIC optimizations
// --------------------------------------------------------------------------------------------------------------

export interface DomainField {
  readonly name: string;
  readonly type: FieldType;
  readonly comodel: string | null;
  readonly required: boolean;
  readonly notNull: boolean;
  readonly selection: readonly string[] | null;
}

export interface DomainModel {
  readonly name: string;
  field(name: string): DomainField | undefined;
  comodel(name: string): DomainModel;
  /** `env.tz` as an IANA name ('UTC' when unknown). */
  readonly tz: string;
}

export function isRelationalType(type: FieldType): boolean {
  return type === "many2one" || type === "one2many" || type === "many2many";
}

/** `Field.falsy_value` per type; undefined means Python None (fields_misc.py:25, fields_numeric.py:21/:202, fields_textual.py:32). */
export function falsyValueOf(type: FieldType): unknown {
  switch (type) {
    case "boolean": return false;
    case "integer":
    case "many2one_reference": return 0;
    case "float":
    case "monetary": return 0;
    case "char":
    case "text":
    case "html": return "";
    default: return undefined;
  }
}

/** `field.falsy_value`: the `id` field is the plain `Id` class without one (fields_misc.py:88). */
export function fieldFalsyValue(field: { readonly name: string; readonly type: FieldType }): unknown {
  return field.name === "id" ? undefined : falsyValueOf(field.type);
}

/** Build the DomainModel view of a registry model. */
export function domainModelOf(reg: Registry, def: ModelDef, tz: string): DomainModel {
  return {
    name: def.name,
    tz,
    field(name: string): DomainField | undefined {
      const f = def.fields.get(name);
      if (f === undefined) return undefined;
      return {
        name: f.name, type: f.type, comodel: f.relation, required: f.required, notNull: f.notNull,
        selection: f.selection === null ? null : f.selection.map((s) => s.value),
      };
    },
    comodel(name: string): DomainModel {
      return domainModelOf(reg, reg.model(name), tz);
    },
  };
}

/** `odoo.orm.utils.parse_field_expr`: 'a.b.c' -> ['a', 'b.c']. */
export function parseFieldExpr(fieldExpr: string): [string, string | null] {
  const i = fieldExpr.indexOf(".");
  const fname = i >= 0 ? fieldExpr.slice(0, i) : fieldExpr;
  if (fname === "") throw new PyValueError(`Invalid field expression ${pyRepr(fieldExpr)}`);
  return [fname, i >= 0 ? fieldExpr.slice(i + 1) : null];
}

type Cond = Extract<Domain, { kind: "cond" }>;

function raiseFor(c: Cond, message: string, error: "value" | "type" = "value"): never {
  const msg = `${message} in condition ${condRepr(c.path, c.op, c.value)}`;
  throw error === "value" ? new PyValueError(msg) : new PyTypeError(msg);
}

/** `DomainCondition._field` (domains.py:963): the field of the expression's first part, or ValueError. */
export function fieldOf(c: Cond, model: DomainModel): [DomainField, string | null] {
  const [fname, property] = parseFieldExpr(c.path);
  const field = model.field(fname);
  if (field === undefined) raiseFor(c, `Invalid field ${model.name}.${fname}`);
  return [field, property];
}

// --------------------------------------------------------------------------------------------------------------
// Negation with field knowledge (domains.py:337, :584, :661, :897)
// --------------------------------------------------------------------------------------------------------------

export function negate(d: Domain, model: DomainModel): Domain {
  switch (d.kind) {
    case "and": return { kind: "or", args: d.args.map((c) => negate(c, model)) };
    case "or": return { kind: "and", args: d.args.map((c) => negate(c, model)) };
    case "cond": {
      const neg = INVERSE_INEQUALITY[d.op];
      if (neg !== undefined) {
        // inverse and add "or field is null" when the field has no falsy value (domains.py:900-908)
        let result: Domain = { kind: "cond", path: d.path, op: neg, value: d.value };
        const [field] = fieldOf(d, model);
        if (fieldFalsyValue(field) === undefined) {
          result = or([{ kind: "cond", path: d.path, op: "in", value: [false] }, result]);
        }
        return result;
      }
      return not(d);
    }
    default: return not(d);
  }
}

// --------------------------------------------------------------------------------------------------------------
// BASIC optimizations (domains.py:974-1039 `_optimize_step`, :1340-1735 condition and type optimizations)
// --------------------------------------------------------------------------------------------------------------

/** `Domain.optimize(model)` (domains.py:433): the BASIC level, a fixpoint over the rewrite rules. */
export function optimizeBasic(d: Domain, model: DomainModel): Domain {
  switch (d.kind) {
    case "true":
    case "false": return d;
    case "not": return negate(optimizeBasic(d.arg, model), model);
    case "and":
    case "or": {
      // `DomainNary._optimize_step` (domains.py:671-702): optimize the children, sort them and merge them; a merge
      // makes a new domain whose new children are optimized again (the children kept are already optimized)
      let children = flatten(d.kind, d.args.map((c) => optimizeBasic(c, model)));
      for (let i = 0; children.length > 1; i++) {
        if (i >= 1000) throw new RangeError("Domain.optimize: too many loops");
        const kept = new Set(children);
        const step = naryMerge(d.kind, children, model);
        children = step.children;
        if (!step.merged) break;
        children = flatten(d.kind, children.map((c) => (kept.has(c) ? c : optimizeBasic(c, model))));
      }
      const result = nary(d.kind, children);
      return result.kind === d.kind && result.args.length === d.args.length && result.args.every((c, i) => c === d.args[i]) ? d : result;
    }
    case "cond": {
      let current = d;
      for (let i = 0; i < 1000; i++) {
        const next = optimizeConditionStep(current, model);
        if (next === current) return current;
        if (next.kind !== "cond") return optimizeBasic(next, model);
        current = next;
      }
      throw new RangeError("Domain.optimize: too many loops");
    }
    default: {
      const never: never = d;
      throw new TypeError(String(never));
    }
  }
}

function optimizeConditionStep(c: Cond, model: DomainModel): Domain {
  // optimize path (domains.py:989-994)
  const [field, property] = fieldOf(c, model);
  if (property !== null && isRelationalType(field.type)) {
    return cond(field.name, "any", cond(property, c.op, c.value));
  }
  // operator optimizations in registration order (domains.py:1025-1029)
  const byOperator = OPERATOR_OPTIMIZATIONS[c.op];
  if (byOperator !== undefined) {
    for (const opt of byOperator) {
      const result = opt(c, model, field);
      if (!equalDomains(result, c)) return result;
    }
  }
  // field type optimizations (domains.py:1030-1033)
  const byType = TYPE_OPTIMIZATIONS[field.type];
  if (byType !== undefined) {
    for (const opt of byType) {
      const result = opt(c, model, field);
      if (!equalDomains(result, c)) return result;
    }
  }
  return c;
}

// --------------------------------------------------------------------------------------------------------------
// N-ary optimizations (domains.py:671-702 `DomainNary._optimize_step`, :1224-1330 the sort key and the registries,
// :2038-2177 the merges). They are independent of the optimization level: optimizeFull (sql.ts) runs them again
// on the children it optimized further.
// --------------------------------------------------------------------------------------------------------------

/** `DomainNary._flatten` for the FULL level in sql.ts. */
export function flattenNary(kind: "and" | "or", children: Iterable<Domain>): Domain[] {
  return flatten(kind, children);
}

/**
 * `_optimize_nary_sort_key` (domains.py:1224): field, operator type, operator; non-conditions sort last ('~' is
 * after any letter in Python's string order, which is the code point order of JavaScript's `<` for these names).
 */
function narySortKey(d: Domain): readonly [string, string, string] {
  switch (d.kind) {
    case "cond": {
      const positive = NEGATIVE_CONDITION_OPERATORS[d.op] ?? d.op;
      let order: string;
      if (positive === "in") order = "0in";
      else if (positive === "any") order = "1any";
      else if (positive === "any!") order = "2any";
      else if (positive.endsWith("like")) order = "like";
      else order = positive;
      return [d.path, order, d.op];
    }
    case "and": return ["~", "", "&"];
    case "or": return ["~", "", "|"];
    case "not": return ["~", "", "!"];
    // DomainBool: absorbed by `_flatten` before the sort, kept for completeness
    case "true":
    case "false": return ["~", "~", "DomainBool"];
    default: {
      const never: never = d;
      throw new TypeError(String(never));
    }
  }
}

function compareNaryKeys(a: Domain, b: Domain): number {
  const ka = narySortKey(a);
  const kb = narySortKey(b);
  for (let i = 0; i < 3; i++) {
    const x = ka[i] as string;
    const y = kb[i] as string;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

type NaryMerge = (kind: "and" | "or", domains: Domain[], model: DomainModel) => Domain[];

/**
 * `nary_condition_optimization` (domains.py:1281-1330): run `optimization` on each run of at least two adjacent
 * conditions on the same field expression with one of `operators` (and, when given, a field of `fieldTypes`).
 */
function naryConditionOptimization(
  operators: readonly string[],
  fieldTypes: readonly FieldType[] | null,
  optimization: (kind: "and" | "or", conditions: Cond[], model: DomainModel) => Domain[],
): NaryMerge {
  return (kind, domains, model) => {
    // result stays null until an optimization is applied, after which it is the optimization of domains[:index]
    let result: Domain[] | null = null;
    // when not null, domains[block:index] are all conditions with the same field expression
    let block: number | null = null;
    for (let index = 0; ; index++) {
      const domain = index < domains.length ? domains[index] as Domain : null;
      const matching = domain !== null && domain.kind === "cond" && operators.includes(domain.op);
      if (block !== null) {
        const first = domains[block] as Cond;
        if (!(matching && domain.kind === "cond" && domain.path === first.path)) {
          if (block < index - 1 && (fieldTypes === null || fieldTypes.includes(fieldOf(first, model)[0].type))) {
            if (result === null) result = domains.slice(0, block);
            result.push(...optimization(kind, domains.slice(block, index) as Cond[], model));
          } else if (result !== null) {
            result.push(...domains.slice(block, index));
          }
          block = null;
        }
      }
      if (domain === null) break;
      if (matching) {
        if (block === null) block = index;
      } else if (result !== null) {
        result.push(domain);
      }
    }
    return result ?? domains;
  };
}

/** `intersection` (domains.py:2068): `functools.reduce(operator.and_)`, OrderedSet `&` keeps the left order. */
function setIntersection(sets: readonly (readonly unknown[])[]): unknown[] {
  let result = [...(sets[0] ?? [])];
  for (const s of sets.slice(1)) result = result.filter((v) => setHas(s, v));
  return result;
}

/** `union` (domains.py:2073). */
function setUnionAll(sets: readonly (readonly unknown[])[]): unknown[] {
  return orderedSet(sets.flat());
}

/** `_merge_set_conditions` (domains.py:2038): combine 'in' and 'not in' conditions to one set of values. */
function mergeSetConditions(kind: "and" | "or", conditions: Cond[]): Domain[] {
  // the values are OrderedSets after the BASIC optimizations (domains.py:2049 asserts it)
  if (!conditions.every((c) => Array.isArray(c.value))) return conditions;
  const inSets = conditions.filter((c) => c.op === "in").map((c) => c.value as unknown[]);
  const notInSets = conditions.filter((c) => c.op === "not in").map((c) => c.value as unknown[]);
  const path = (conditions[0] as Cond).path;
  if (kind === "and") {
    if (inSets.length > 0) return [cond(path, "in", setMinus(setIntersection(inSets), setUnionAll(notInSets)))];
    return [cond(path, "not in", setUnionAll(notInSets))];
  }
  if (notInSets.length > 0) return [cond(path, "not in", setMinus(setIntersection(notInSets), setUnionAll(inSets)))];
  return [cond(path, "in", setUnionAll(inSets))];
}

/** `_optimize_merge_any` (domains.py:2114) and `_optimize_merge_not_any` (:2136). */
function mergeAny(negative: boolean) {
  return (kind: "and" | "or", conditions: Cond[], model: DomainModel): Domain[] => {
    const [field] = fieldOf(conditions[0] as Cond, model);
    if (field.type !== "many2one" && kind === (negative ? "or" : "and")) return conditions;
    const merge = conditions.filter((c) => isDomain(c.value));
    const other = conditions.filter((c) => !isDomain(c.value));
    if (merge.length < 2) return conditions;
    const base = merge[0] as Cond;
    // `cls(...)` / `cls.INVERSE(...)`: a plain n-ary node, flattened when the sub-domain is optimized
    const subKind = negative ? (kind === "and" ? "or" : "and") : kind;
    const sub: Domain = { kind: subKind, args: merge.map((c) => c.value as Domain) };
    return [{ kind: "cond", path: base.path, op: base.op, value: sub }, ...other];
  };
}

/** `_optimize_same_conditions` (domains.py:2158): drop adjacent repeated children. */
const sameConditions: NaryMerge = (_kind, domains) => {
  if (!domains.some((d, i) => i > 0 && equalDomains(domains[i - 1] as Domain, d))) return domains;
  return domains.filter((d, i) => i === 0 || !equalDomains(domains[i - 1] as Domain, d));
};

/** `_MERGE_OPTIMIZATIONS` in registration order (decorators apply bottom-up: 'any!' before 'any'). */
const NARY_MERGES: readonly NaryMerge[] = [
  // domains.py:2078 `_optimize_merge_set_conditions_mono_value`
  naryConditionOptimization(["in", "not in"], null, (kind, conditions, model) => {
    const [field] = fieldOf(conditions[0] as Cond, model);
    if (field.type === "many2many" || field.type === "one2many" || field.type === "properties") return conditions;
    return mergeSetConditions(kind, conditions);
  }),
  // :2096 `_optimize_merge_set_conditions_x2many_in`
  naryConditionOptimization(["in"], ["many2many", "one2many"], (kind, conditions) => (kind === "and" ? conditions : mergeSetConditions(kind, conditions))),
  // :2105 `_optimize_merge_set_conditions_x2many_not_in`
  naryConditionOptimization(["not in"], ["many2many", "one2many"], (kind, conditions) => (kind === "or" ? conditions : mergeSetConditions(kind, conditions))),
  naryConditionOptimization(["any!"], ["many2one", "one2many", "many2many"], mergeAny(false)),
  naryConditionOptimization(["any"], ["many2one", "one2many", "many2many"], mergeAny(false)),
  naryConditionOptimization(["not any!"], ["many2one", "one2many", "many2many"], mergeAny(true)),
  naryConditionOptimization(["not any"], ["many2one", "one2many", "many2many"], mergeAny(true)),
  sameConditions,
];

/**
 * domains.py:681-698: sort the optimized children (a stable sort, as Python's) and run the merges until one of them
 * merges some; `merged` says the caller must optimize the new children and merge again.
 */
export function naryMerge(kind: "and" | "or", children: readonly Domain[], model: DomainModel): { children: Domain[]; merged: boolean } {
  const size = children.length;
  let list = [...children];
  if (size <= 1) return { children: list, merged: false };
  list.sort(compareNaryKeys);
  for (const merge of NARY_MERGES) {
    list = merge(kind, list, model);
    if (list.length < size) return { children: list, merged: true };
  }
  return { children: list, merged: false };
}

type Optimization = (c: Cond, model: DomainModel, field: DomainField) => Domain;

/** domains.py:1340 `a =? b  <=>  not b or a = b` */
const equalIfValue: Optimization = (c) => (pyFalsy(c.value) ? TRUE : cond(c.path, "=", c.value));

/** domains.py:1348: equality becomes 'in' with a set. */
const equalAsIn: Optimization = (c) => {
  const op = c.op === "=" ? "in" : "not in";
  let value: unknown[];
  if (isCollection(c.value)) {
    // views sometimes use ('user_ids', '!=', []) to indicate the user is set
    value = c.value.length === 0 ? [false] : orderedSet(c.value);
  } else {
    value = [c.value];
  }
  return cond(c.path, op, value);
};

/** domains.py:1371: make sure the value is a set, or use 'any' for domain values. */
const inSet: Optimization = (c) => {
  const value = c.value;
  if (isDomain(value) || value instanceof SubQueryValue) {
    return cond(c.path, c.op === "in" ? "any" : "not any", value);
  }
  if (pyFalsy(value)) return c.op === "in" ? FALSE : TRUE;
  const list = isCollection(value) ? value : [value];
  const set = orderedSet(list.map(plainNumber));
  if (isCollection(value) && set.length === value.length && set.every((v, i) => v === value[i])) return c;
  return cond(c.path, c.op, set);
};

/** domains.py:1390: remove checks against a null value for required fields and 'id'. */
const inRequired: Optimization = (c, _model, field) => {
  if (!isCollection(c.value)) return c;
  if (fieldFalsyValue(field) === undefined && ((field.required && field.notNull) || field.name === "id")) {
    const value = c.value.filter((v) => v !== false && v !== null);
    if (value.length !== c.value.length) return cond(c.path, c.op, value);
  }
  return c;
};

/** domains.py:1410: the value of 'any' is an optimized domain; `id any dom` is `dom`. */
const anyDomain: Optimization = (c, _model, field) => {
  const value = c.value;
  if (value instanceof SubQueryValue) {
    if (c.op === "any" || c.op === "not any") return cond(c.path, `${c.op}!`, value);
    return c;
  }
  const domain = parseDomain(value, true);
  if (field.name === "id") return c.op === "any" || c.op === "any!" ? domain : not(domain);
  if (domain === value) return c;
  return cond(c.path, c.op, domain);
};

/** domains.py:1432 at BASIC level: optimize the sub-domain against the comodel. */
const anyDomainAtLevel: Optimization = (c, model, field) => {
  const domain = c.value;
  if (!isDomain(domain)) return c;
  if (!isRelationalType(field.type)) raiseFor(c, "Cannot use 'any' with non-relational fields");
  if (field.comodel === null) raiseFor(c, "Cannot determine the comodel relation");
  const comodel = model.comodel(field.comodel);
  const optimized = optimizeBasic(domain, comodel);
  if (optimized.kind === "false") return c.op === "any" || c.op === "any!" ? FALSE : TRUE;
  if (optimized === domain) return c;
  return cond(c.path, c.op, optimized);
};

/** domains.py:1496: pattern matching needs a string. */
const likeStr: Optimization = (c, _model, field) => {
  const value = c.value;
  if (pyFalsy(value)) {
    // =like matches only empty string (inverse the condition)
    const result = isNegativeOperator(c.op) === c.op.includes("=");
    if (isRelationalType(field.type) || c.op.includes("=")) return cond(c.path, result ? "!=" : "=", false);
    return result ? TRUE : FALSE;
  }
  if (typeof value === "string") return c;
  if (c.op.includes("=")) raiseFor(c, "The pattern to match must be a string", "type");
  return cond(c.path, c.op, pyStr(value));
};

/** Python `str(value)` for scalars. */
export function pyStr(value: unknown): string {
  if (value === true) return "True";
  if (value === false) return "False";
  if (isPyFloat(value)) return Number.isInteger(value.float) ? `${value.float}.0` : String(value.float);
  if (value instanceof PyDate || value instanceof PyDateTime) return value.toString();
  return String(value);
}

/** domains.py:1516: a string compared to a relational field searches the comodel's display_name. */
const relationalNameSearch: Optimization = (c) => {
  const op = c.op;
  const value = c.value;
  const positive = NEGATIVE_CONDITION_OPERATORS[op] ?? op;
  const anyOp = positive === op ? "any" : "not any";
  if (op.endsWith("like")) {
    return cond(c.path, anyOp, cond("display_name", positive, value));
  }
  if ((op[0] === "<" || op[0] === ">") && typeof value === "string") {
    raiseFor(c, "Inequality not supported for relational field using a string", "type");
  }
  if (positive !== "in" || !isCollection(value)) return c;
  const strValues = value.filter((v) => typeof v === "string");
  const otherValues = value.filter((v) => typeof v !== "string");
  if (strValues.length === 0) return c;
  let domain = cond(c.path, anyOp, cond("display_name", positive, strValues));
  if (otherValues.length > 0) {
    domain = positive === op
      ? or([domain, cond(c.path, op, otherValues)])
      : and([domain, cond(c.path, op, otherValues)]);
  }
  return domain;
};

/** domains.py:1557: booleans compare to [True] when possible. */
const booleanIn: Optimization = (c) => {
  if ((c.op !== "in" && c.op !== "not in") || !isCollection(c.value)) {
    raiseFor(c, `Cannot compare ${pyRepr(c.path)} to ${typeof c.value} which is not a collection of length 1`);
  }
  const original: unknown[] = c.value;
  let value: unknown[] = original;
  let op = c.op;
  if (!value.every((v) => typeof v === "boolean")) {
    value = orderedSet(value.map((v) => (typeof v === "string" ? str2bool(v.toLowerCase(), false) : !pyFalsy(v))));
  }
  if (value.length === 1 && !value.some(Boolean)) {
    op = INVERSE_OPERATOR[op] ?? op;
    value = [true];
  }
  if (op === c.op && value.length === original.length && value.every((v, i) => v === original[i])) return c;
  return cond(c.path, op, value);
};

const INEQUALITY_OR_IN = ["in", "not in", ">", "<", "<=", ">="];

/**
 * Whether `odoo.tools.date_utils.parse_date` (date_utils.py:129-215) accepts a relative value: an optional
 * "today"/"now" then terms `[=+-]N[dwmyHMS]` (no "=Nw") or `[=+-]weekday|week_start`.
 */
function relativeDateSyntax(value: string): boolean {
  const terms = value.split(/\s+/).filter((t) => t !== "");
  if (!terms.length) return false;
  if (terms[0] === "today" || terms[0] === "now") terms.shift();
  const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "week_start"];
  return terms.every((t) => {
    if (!"+-=".includes(t[0]!) || t.length < 3) return false;
    if (days.includes(t.slice(1))) return true;
    if (!"dwmyHMS".includes(t[t.length - 1]!)) return false;
    const digits = t[0] === "=" ? t.slice(1, -1) : t.slice(0, -1);
    if (!/^[+-]?\d+$/.test(digits.replace(/_/g, ""))) return false;
    return !(t[0] === "=" && t.endsWith("w"));
  });
}

/** domains.py:1590 `_value_to_date(value, env, iso_only=True)`. */
function valueToDate(c: Cond, value: unknown): unknown {
  if (value instanceof PyDateTime) return value.toDate();
  if (value instanceof PyDate || value === false) return value;
  if (typeof value === "string") {
    let parsed: PyDate | PyDateTime;
    try {
      parsed = parseIsoDate(value);
    } catch (e) {
      if (e instanceof PyValueError) {
        // relative dates ("today", "+1d", ...) are only format-checked here and parsed by odoo.tools.date_utils
        // .parse_date at the DYNAMIC level (domains.py:1595-1600, src/orm/sql.ts)
        if (relativeDateSyntax(value)) return value;
        throw new NotPorted(`relative date value ${pyRepr(value)} in condition ${condRepr(c.path, c.op, c.value)}`);
      }
      throw e;
    }
    return valueToDate(c, parsed);
  }
  if (isCollection(value)) return orderedSet(value.map((v) => valueToDate(c, v)));
  throw new PyValueError(`Failed to cast ${pyRepr(value)} into a date`);
}

/** domains.py:1612: make sure we have a date type in the value. */
const typeDate: Optimization = (c) => {
  if (!INEQUALITY_OR_IN.includes(c.op) || c.path.includes(".")) return c;
  const value = valueToDate(c, c.value);
  if (value === false && (c.op[0] === "<" || c.op[0] === ">")) return FALSE;
  if (equalValues(value, c.value)) return c;
  return cond(c.path, c.op, value);
};

/** domains.py:1641 `_value_to_datetime(value, env, iso_only=True)`: the converted value and whether all were dates. */
function valueToDatetime(c: Cond, value: unknown, tz: string): [unknown, boolean] {
  if (value === false) return [false, true];
  if (value instanceof PyDateTime) return [value, false];
  if (typeof value === "string") {
    let parsed: PyDate | PyDateTime;
    try {
      parsed = parseIsoDate(value);
    } catch (e) {
      if (e instanceof PyValueError) {
        // domains.py:1657-1663: format-checked, kept as is (the caller leaves the condition unchanged)
        if (relativeDateSyntax(value)) return [value, false];
        throw new NotPorted(`relative date value ${pyRepr(value)} in condition ${condRepr(c.path, c.op, c.value)}`);
      }
      throw e;
    }
    return valueToDatetime(c, parsed, tz);
  }
  if (value instanceof PyDate) {
    const year = value.year;
    let dt = new PyDateTime(value.ms);
    if (year !== 1 && year !== 9999 && tz !== "UTC") dt = localMidnightToUtc(value, tz);
    return [dt, true];
  }
  if (isCollection(value)) {
    const converted = value.map((v) => valueToDatetime(c, v, tz));
    return [orderedSet(converted.map((x) => x[0])), converted.every((x) => x[1])];
  }
  throw new PyValueError(`Failed to cast ${pyRepr(value)} into a datetime`);
}

const MAX_YEAR_MS = Date.UTC(10000, 0, 1);

/** domains.py:1681: datetime values; inequalities on dates/seconds; equality compares the whole second. */
const typeDatetime: Optimization = (c, model) => {
  const fieldExpr = c.path;
  let op = c.op;
  if (!INEQUALITY_OR_IN.includes(op) || fieldExpr.includes(".")) return c;
  const [converted, isDate] = valueToDatetime(c, c.value, model.tz);
  let value: unknown = converted;
  if (op[0] === "<" || op[0] === ">") {
    if (converted === false) return FALSE;
    if (!(converted instanceof PyDateTime)) return c;
    const dt = converted.withoutMicroseconds();
    value = dt;
    const bumped = isDate ? dt.plusDays(1) : dt.plusSeconds(1);
    if (op === ">") {
      if (bumped.ms >= MAX_YEAR_MS) return FALSE; // OverflowError: higher than max, not possible
      value = bumped;
      op = ">=";
    } else if (op === "<=") {
      if (bumped.ms >= MAX_YEAR_MS) return cond(fieldExpr, "!=", false); // lower than max, just check if field is set
      value = bumped;
      op = "<";
    }
  }
  if ((op === "in" || op === "not in") && isCollection(value) && value.some((v) => v instanceof PyDateTime)) {
    let domain = or(value.map((v) => {
      if (v instanceof PyDateTime) {
        const v0 = v.withoutMicroseconds();
        return and([cond(fieldExpr, ">=", v0), cond(fieldExpr, "<", v0.plusSeconds(1))]);
      }
      return cond(fieldExpr, "=", v);
    }));
    if (op === "not in") domain = not(domain);
    return domain;
  }
  if (op === c.op && equalValues(value, c.value)) return c;
  return cond(fieldExpr, op, value);
};

const OPERATOR_OPTIMIZATIONS: Readonly<Record<string, readonly Optimization[]>> = {
  "=?": [equalIfValue],
  "=": [equalAsIn],
  "!=": [equalAsIn],
  "in": [inSet, inRequired],
  "not in": [inSet, inRequired],
  "any": [anyDomain, anyDomainAtLevel],
  "not any": [anyDomain, anyDomainAtLevel],
  "any!": [anyDomain, anyDomainAtLevel],
  "not any!": [anyDomain, anyDomainAtLevel],
  "like": [likeStr], "not like": [likeStr], "ilike": [likeStr], "not ilike": [likeStr],
  "=like": [likeStr], "not =like": [likeStr], "=ilike": [likeStr], "not =ilike": [likeStr],
};

const TYPE_OPTIMIZATIONS: Partial<Readonly<Record<FieldType, readonly Optimization[]>>> = {
  many2one: [relationalNameSearch],
  one2many: [relationalNameSearch],
  many2many: [relationalNameSearch],
  boolean: [booleanIn],
  date: [typeDate],
  datetime: [typeDatetime],
};

/** domains.py:1579 (FULL level): `b in [True, False]  =>  True`. Applied by sql.ts. */
export function booleanInAll(c: Cond): Domain {
  if (isCollection(c.value) && c.value.length === 2 && setHas(c.value, true) && setHas(c.value, false)) {
    return c.op === "in" ? TRUE : FALSE;
  }
  return c;
}

/**
 * A sub-query used as the value of 'any!'/'not any!' (domains.py `Query` values). Built by sql.ts; carried
 * opaquely by the domain tree so the pure optimizations can recognize it (ANY_TYPES, domains.py:1188).
 */
export class SubQueryValue {
  constructor(readonly query: import("./sql").Query) {}
  get knownIds(): readonly number[] | null { return this.query.resultIds; }
}
