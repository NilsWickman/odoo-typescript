/**
 * Shared helpers of the web methods (stream W): kwargs decoding and the Python-value conventions of
 * `odoo/odoo/service/model.py call_kw` (PORTING_odoo.md section 1) and PORTING_ts.md (PyFloat, false vs null).
 */
import { NotPorted } from "../errors";
import type { Context, Environment, PyFloat } from "../orm/types";

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isPyFloat(v: unknown): v is PyFloat {
  return isRecord(v) && typeof v["float"] === "number" && Object.keys(v).length === 1;
}

/**
 * `with_context(context)` of call_kw replaces the environment context entirely (service/model.py:31). The
 * dispatcher normally does it; a leftover `context` key is applied here and removed from kwargs, so the methods
 * behave the same whichever side did it.
 */
export function envFor(env: Environment, kwargs: Record<string, unknown>): { env: Environment; kwargs: Record<string, unknown> } {
  if (!("context" in kwargs)) return { env, kwargs };
  const { context, ...rest } = kwargs;
  if (context === null || context === undefined || context === false) return { env, kwargs: rest };
  if (!isRecord(context)) throw new NotPorted(`call_kw context of type ${typeof context}`);
  return { env: env.withContext(context as Context), kwargs: rest };
}

/** An optional integer argument: Python `int | None`. `false`/`null`/`undefined` are None (the JSON client sends false). */
export function optInt(v: unknown, what: string): number | null {
  if (v === null || v === undefined || v === false) return null;
  if (typeof v === "number" && Number.isInteger(v)) return v;
  // A JSON `80.0` is a Python float; psycopg passes it to LIMIT/OFFSET where Postgres casts 80.0 to bigint.
  if (isPyFloat(v) && Number.isInteger(v.float)) return v.float;
  throw new NotPorted(`${what}=${JSON.stringify(v)} (expected an integer)`);
}

export function intArg(v: unknown, what: string, dflt: number): number {
  const n = optInt(v, what);
  return n === null ? dflt : n;
}

/** Python `str | None`; `False`/`""` count as falsy like Odoo's `if order:` tests. */
export function optStr(v: unknown, what: string): string | null {
  if (v === null || v === undefined || v === false) return null;
  if (typeof v === "string") return v;
  throw new NotPorted(`${what}=${JSON.stringify(v)} (expected a string)`);
}

export function boolArg(v: unknown): boolean {
  // Python truthiness of the JSON values the client sends.
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isRecord(v)) return Object.keys(v).length > 0;
  return true;
}

/** The ids of a record method: `args[0]` of `_call_kw_multi`, as the dispatcher or the raw args carry them. */
export function recordIds(ids: number[] | null, args: unknown[], method: string): number[] {
  const raw: unknown = ids ?? args[0];
  if (!Array.isArray(raw)) throw new NotPorted(`${method}: ids ${JSON.stringify(raw)} (expected a list of integers)`);
  return raw.map((x) => {
    if (typeof x === "number" && Number.isInteger(x)) return x;
    throw new NotPorted(`${method}: id ${JSON.stringify(x)} (expected an integer)`);
  });
}

/** A `web_read` specification: `{field: {fields?, context?, limit?, order?}}` (addons/web/models/models.py:315). */
export interface FieldSpec {
  readonly fields?: Specification;
  readonly context?: Context;
  readonly limit?: number | null;
  readonly order?: string | null;
  /** Odoo tests `if not field_spec` (empty dict) in several places. */
  readonly empty: boolean;
}
export type Specification = Readonly<Record<string, FieldSpec>>;

export function parseSpecification(v: unknown, what = "specification"): Specification {
  if (v === null || v === undefined || v === false) return {};
  if (!isRecord(v)) throw new NotPorted(`${what} of type ${typeof v}`);
  const out: Record<string, FieldSpec> = {};
  for (const [name, raw] of Object.entries(v)) {
    if (!isRecord(raw)) throw new NotPorted(`${what}.${name} of type ${typeof raw}`);
    const spec: { fields?: Specification; context?: Context; limit?: number | null; order?: string | null; empty: boolean } = {
      empty: Object.keys(raw).length === 0,
    };
    if ("fields" in raw) spec.fields = parseSpecification(raw["fields"], `${what}.${name}.fields`);
    if ("context" in raw) {
      const ctx = raw["context"];
      if (!isRecord(ctx)) throw new NotPorted(`${what}.${name}.context of type ${typeof ctx}`);
      spec.context = ctx as Context;
    }
    if ("limit" in raw) spec.limit = optInt(raw["limit"], `${what}.${name}.limit`);
    if ("order" in raw) spec.order = optStr(raw["order"], `${what}.${name}.order`);
    out[name] = spec;
  }
  return out;
}

/** `dict.get(key)` on a spec: Python `'fields' in field_spec`. */
export function hasKey(spec: FieldSpec, key: "fields" | "context" | "limit" | "order"): boolean {
  return key in spec;
}
