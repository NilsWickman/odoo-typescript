/**
 * Builders for the `Domain` tree of src/orm/types.ts, mirroring `odoo.fields.Domain` as the Python search functions
 * use it (`Domain(field, op, value)`, `&`, `|`, `~`, `Domain.TRUE/FALSE`, `Domain.NEGATIVE_OPERATORS`).
 */
import type { Domain } from "../orm/types";

export const TRUE: Domain = { kind: "true" };
export const FALSE: Domain = { kind: "false" };

export function cond(path: string, op: string, value: unknown): Domain {
  return { kind: "cond", path, op, value };
}

export function and(...items: Domain[]): Domain {
  const args = items.filter((d) => d.kind !== "true");
  if (args.some((d) => d.kind === "false")) return FALSE;
  if (args.length === 0) return TRUE;
  if (args.length === 1) return args[0] as Domain;
  return { kind: "and", args };
}

export function or(...items: Domain[]): Domain {
  const args = items.filter((d) => d.kind !== "false");
  if (args.some((d) => d.kind === "true")) return TRUE;
  if (args.length === 0) return FALSE;
  if (args.length === 1) return args[0] as Domain;
  return { kind: "or", args };
}

export function not(d: Domain): Domain {
  if (d.kind === "true") return FALSE;
  if (d.kind === "false") return TRUE;
  return { kind: "not", arg: d };
}

/** `Domain.NEGATIVE_OPERATORS` (domains.py:43 NEGATIVE_CONDITION_OPERATORS keys). */
const NEGATIVE = new Set(["!=", "not in", "not like", "not ilike", "not =like", "not =ilike", "not any", "not any!"]);

export function isNegativeOperator(op: string): boolean {
  return NEGATIVE.has(op);
}

/**
 * Search functions run after `Domain.optimize` (domains.py:1348 rewrites `=` to `in`); callers may still pass the
 * raw form. Normalize `=`/`!=` with a scalar to `in`/`not in` with a one-element list.
 */
export function normalizeIn(operator: string, value: unknown): [string, unknown] {
  if (operator === "=" && !Array.isArray(value)) return ["in", [value]];
  if (operator === "!=" && !Array.isArray(value)) return ["not in", [value]];
  return [operator, value];
}

/** The values of an `in` operand as a list (a scalar counts as a one-element list). */
export function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/** `condition_values(model, field, domain)` (mail/models/mail_message.py): the values of `=`/`in` conditions on `field`, or null. */
export function conditionValues(d: Domain, field: string): unknown[] | null {
  let found: unknown[] | null = null;
  const walk = (x: Domain): void => {
    if (x.kind === "cond") {
      if (x.path === field && (x.op === "=" || x.op === "in")) {
        found = [...(found ?? []), ...asList(x.value)];
      }
    } else if (x.kind === "and" || x.kind === "or") x.args.forEach(walk);
    else if (x.kind === "not") walk(x.arg);
  };
  walk(d);
  return found;
}
