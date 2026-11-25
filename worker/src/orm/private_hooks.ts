/**
 * Private methods of the hand port that a module's compiled override can take over (D23 path B: a module overriding a
 * private method the hand port runs itself, compiler/VAGB.md; product_email_template's account.move `_post`). The
 * hand port calls them through `callPrivate`; the compiled build of a template registers its override of one
 * (compiler/runtime/install.ts privateKey), which runs for that template's databases with the hand port's
 * implementation as its `super()`. The list of these methods is dispatch_map.json, with a handle of each in
 * dispatch_gen.ts (compiler/dispatch.py generates them and checks that the hand port calls the methods only through
 * them); compiler/oc/build.py reads it with private_hooks.json (covered, unreached, unported): an override of a private
 * method in neither is refused, and of a mapped one whose check fails too.
 */
import type { Environment } from "./types";
import type { Rec } from "./recompute";
import { templateOf } from "./template";

/** A recordset in a private method's arguments (`partial_info['aml']`): compiled code gets it as records. */
export class PrivateRecords {
  constructor(readonly model: string, readonly ids: readonly number[]) {}
}

/**
 * A recordset of records that may be new in a private method's arguments (the `record` of a base line computed on an
 * onchange's line, src/models/account_tax_hooks.ts): compiled code gets records of those Recs, in a pure run (no
 * write), as for PrivateRecs on the method's own records.
 */
export class PrivateNewRecords {
  constructor(readonly model: string, readonly recs: readonly Rec[]) {}
}

/**
 * An `odoo.tools.SQL` in a private method's value or arguments (sequence.mixin `_get_last_sequence_domain`): the hand
 * port's SQL text with numbered placeholders `$1`..`$n`, each used once and in that order, and their parameters
 * (str, number, boolean, null, or arrays of them). Compiled code gets it as an SQL and may return one
 * (compiler/runtime/private_bridge.ts); the translation refuses what it cannot carry exactly.
 */
export class PrivateSql {
  constructor(readonly sql: string, readonly params: readonly unknown[]) {}
}

/**
 * A Python datetime in a private method's arguments (a procurement's `date_planned`), its 'YYYY-MM-DD HH:MM:SS' value:
 * compiled code gets a naive datetime, and a naive datetime it returns or leaves in an argument dict comes back as one
 * (compiler/runtime/install.ts privateKey; an aware one or one with microseconds refuses).
 */
/**
 * The model of an id list that compiled code passed as a recordset (compiler/runtime/records.ts toJs: a non-enumerable
 * property of the array, so the ids stay what every hand method takes from JSON-RPC). purchase_requisition's
 * `message_post_with_source(..., render_values={'origin': order.requisition_id})`: the template needs the model.
 */
export const RECORDS_MODEL: unique symbol = Symbol.for("odoo-ts.records.model") as never;
export function idsModel(x: unknown): string | null {
  return Array.isArray(x) && typeof (x as unknown as Record<symbol, unknown>)[RECORDS_MODEL] === "string"
    ? (x as unknown as Record<symbol, string>)[RECORDS_MODEL]! : null;
}

/**
 * Keyword arguments of a private method's call, as the last element of callPrivate's `args`: compiled code gets them
 * as its keyword arguments (compiler/runtime/install.ts privateKey), and the hand port gets them back from a compiled
 * `super()` the same way, the names its hook accepts (private_hooks.json `kwargs`). account_payment_custom
 * `_setup_provider(*args, custom_mode=None, **kwargs)` and `_find_available_providers(..., is_invoice=False, report=None)`.
 */
export class PrivateKwargs {
  constructor(readonly values: Readonly<Record<string, unknown>>) {}
}

export class PrivateDatetime {
  constructor(readonly value: string) {}
}

/** Arguments in one form whether they come back from compiled code (toJs: records as ids) or not: for comparing. */
export function privateNormal(x: unknown): unknown {
  if (x instanceof PrivateRecords) return [...x.ids];
  if (x instanceof PrivateNewRecords) return x.recs.map((r) => r.id ?? -1);
  if (x instanceof PrivateDatetime) return { datetime: x.value };
  if (Array.isArray(x)) return x.map(privateNormal);
  if (x !== null && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype) {
    return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, v]) => [k, privateNormal(v)]));
  }
  return x;
}

export type PrivateHand = (env: Environment, ids: readonly number[], args: readonly unknown[]) => Promise<unknown>;
/**
 * Values Odoo's record cache holds for the records when the method is called, by field and id, that a read would not
 * give: a non-stored field written just before its inverse runs (res.users `password`: `_set_password` reads the
 * plaintext the write put in the cache, the field's compute gives '').
 */
export type PrivateCache = Readonly<Record<string, ReadonlyMap<number, unknown>>>;
/**
 * The records themselves, when they may be new (a compute or an onchange on a NewRec: account.move `highest_name`):
 * compiled code gets them as records of those Recs, never written; `ids` is then empty for a new one.
 */
export type PrivateRecs = readonly Rec[];
export type PrivateOverride = (env: Environment, ids: readonly number[], args: readonly unknown[], hand: PrivateHand, cache?: PrivateCache,
  recs?: PrivateRecs) => Promise<unknown>;

const OVERRIDES = new Map<string, { template: string; fn: PrivateOverride }[]>();

export function registerPrivateOverride(model: string, name: string, template: string, fn: PrivateOverride): void {
  const key = `${model}.${name}`;
  OVERRIDES.set(key, [...(OVERRIDES.get(key) ?? []).filter((o) => o.template !== template), { template, fn }]);
}

/**
 * Whether this database's template has a compiled override of the private method: for a call the hand port cannot
 * make with Odoo's arguments (a new record in them), which then refuses only where an override would run.
 */
export async function hasPrivateOverride(env: Environment, model: string, name: string): Promise<boolean> {
  const list = OVERRIDES.get(`${model}.${name}`);
  if (!list?.length) return false;
  const t = (await templateOf(env.cr)).name;
  return list.some((x) => x.template === t);
}

/** Whether any template has a compiled override of the private method (no database read: a hot path's quick test). */
export function privateOverridden(model: string, name: string): boolean {
  return Boolean(OVERRIDES.get(`${model}.${name}`)?.length);
}

/** `records.<name>(*args)` of a private method the hand port implements as `hand`. */
export async function callPrivate(env: Environment, model: string, name: string, ids: readonly number[], args: readonly unknown[],
  hand: PrivateHand, cache?: PrivateCache, recs?: PrivateRecs): Promise<unknown> {
  const list = OVERRIDES.get(`${model}.${name}`);
  if (list?.length) {
    const t = (await templateOf(env.cr)).name;
    const o = list.find((x) => x.template === t);
    if (o) return o.fn(env, ids, args, hand, cache, recs);
  }
  return hand(env, ids, args);
}

/**
 * One private method of the dispatch map (src/orm/dispatch_map.json): its handle in src/orm/dispatch_gen.ts, which
 * compiler/dispatch.py generates. The hand port calls the private methods only through these (the check refuses
 * another use of callPrivate, hasPrivateOverride and privateOverridden), so every site of a method is in the map.
 */
export class PrivateMethod {
  constructor(readonly model: string, readonly name: string) {}

  /** callPrivate: `records.<name>(*args)` with `hand` as the hand port's implementation. */
  call(env: Environment, ids: readonly number[], args: readonly unknown[], hand: PrivateHand, cache?: PrivateCache, recs?: PrivateRecs): Promise<unknown> {
    return callPrivate(env, this.model, this.name, ids, args, hand, cache, recs);
  }

  /** hasPrivateOverride on the method's model: a guard that refuses where a compiled override would run. */
  overridden(env: Environment): Promise<boolean> {
    return hasPrivateOverride(env, this.model, this.name);
  }

  /** hasPrivateOverride of the method's name on the records' model (tracking, the main attachment, the views). */
  overriddenOn(env: Environment, model: string): Promise<boolean> {
    return hasPrivateOverride(env, model, this.name);
  }

  /** privateOverridden: whether any template has a compiled override (no database read). */
  quick(): boolean {
    return privateOverridden(this.model, this.name);
  }
}
