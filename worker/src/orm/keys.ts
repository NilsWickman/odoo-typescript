/**
 * The registry's keys (compiler/PLAN.md "Nyckeln och enheten", "Gränssnittet mot porttråden", HOOKS_API = 1).
 *
 * Every function the models register through the base registries (orm/hooks.ts registerHooks, orm/recompute.ts
 * registerRecordCompute/registerOnchange/registerDefaults, orm/write.ts registerOverrides, http/methods.ts
 * registerMethod, web/read_group.ts registerGroupExpand, qweb/records.ts registerPyMethod) is wrapped here once, at
 * registration, under a key (kind, model, name). The wrapper
 *   - counts the call (the hit counter: a key is "run by the gate" when its counter moved, PLAN.md condition 1),
 *   - dispatches to a replacement when the compiled build installed one with `replaceKey` (src/compiled/, chosen by
 *     the manifest at build time, never by import order),
 *   - in shadow mode runs the replacement and the hand port both and logs the differences (PLAN.md condition 2).
 * A key registered twice is reported by `duplicateKeys()` (the compiled build refuses to replace such a key).
 *
 * The template is part of a key's identity in the manifest; the replacement itself decides per call whether it
 * serves the request's template (compiler/runtime/install.ts), so the dispatch here stays synchronous and keeps the
 * registered function's own calling convention (some registries hold synchronous functions).
 */

/** A registry surface; the name is a field, a method, `*` (one function per model) or `#<n>` (list entries). */
export type KeyKind =
  | "hooks.computed" | "hooks.search" | "hooks.selection" | "hooks.storedCompute" | "hooks.defaults"
  | "hooks.computeSql" | "hooks.descriptionDomain" | "hooks.write" | "hooks.onchange" | "hooks.fetchFilter"
  | "hooks.displayName" | "hooks.searchDisplayName" | "hooks.nameSearch" | "hooks.searchFetch" | "hooks.searchOverride"
  | "recordCompute" | "onchange" | "default" | "override.create" | "override.write" | "override.unlink" | "override.beforeUnlink"
  | "override.copyData" | "override.inverse" | "override.constraint" | "override.defaultGet" | "override.nameCreate"
  | "method" | "groupExpand" | "pyMethod";

export interface KeyInfo {
  readonly kind: KeyKind;
  readonly model: string;
  readonly name: string;
  registrations: number;
  hits: number;
}

// eslint-style note: the functions are stored with their own signatures; the registry only forwards arguments.
type AnyFn = (...args: never[]) => unknown;

/** The replacement of a key and, in shadow mode, how to compare its answer with the hand port's. */
export interface Replacement {
  /** The compiled implementation; `hand` is the hand port's (a replacement that does not serve the request's
   *  template, compiler/runtime/install.ts, calls it). */
  readonly fn: (hand: (...args: unknown[]) => unknown, args: unknown[]) => unknown;
  /** Shadow mode: run both, return the hand port's answer, log a difference. Only for keys the compiler approved. */
  readonly shadow?: ((hand: unknown, compiled: unknown, args: readonly unknown[]) => Promise<string | null>) | undefined;
  /** Shadow mode: runs the hand port's pass (`run`) under the replacement's statement watch, so a write there marks the
   *  key's run impure too (compiler/runtime/install.ts). */
  readonly watchHand?: ((args: readonly unknown[], run: () => Promise<unknown>) => Promise<unknown>) | undefined;
}

const KEYS = new Map<string, KeyInfo>();
/** Diagnostic builds of the compiler (compiler/oc/build.py --diagnose): a failing replacement is logged and the hand
 *  port answers, so that one gate run lists every failing key. Never on in a run that counts (PLAN.md: no fallback). */
const DIAGNOSTIC = { on: false };
export function setDiagnostic(on: boolean): void { DIAGNOSTIC.on = on; if (on) console.warn("compiler-diagnostic-build (not a proof run)"); }
const REPLACED = new Map<string, Replacement>();
/** Replacements of keys not registered yet (see allowPendingReplacements). */
const PENDING = new Map<string, Replacement>();
let pendingAllowed = false;
/** Node test runs load the compiled build before the test imports the hand port's modules (test/compiled.mjs): a
 *  replacement then waits for its key's registration. The Worker installs after every registration and never needs it. */
export function allowPendingReplacements(on: boolean): void { pendingAllowed = on; }
/** Whether replacements may wait for their key (Node checks load the compiled build before the hand port's modules). */
export function pendingReplacementsAllowed(): boolean { return pendingAllowed; }

export function keyId(kind: KeyKind, model: string, name: string): string {
  return `${kind}|${model}|${name}`;
}

function note(kind: KeyKind, model: string, name: string): KeyInfo {
  const id = keyId(kind, model, name);
  let info = KEYS.get(id);
  if (!info) { info = { kind, model, name, registrations: 0, hits: 0 }; KEYS.set(id, info); }
  info.registrations += 1;
  // a replacement installed before the hand port registered the key (Node tests load the compiled build first)
  const pending = PENDING.get(id);
  if (pending !== undefined) { PENDING.delete(id); REPLACED.set(id, pending); }
  if (info.registrations > 1 && REPLACED.has(id)) throw new Error(`replaceKey: ${id} is registered again after its replacement (a double registration is a build error)`);
  return info;
}

/** COMPILER_HITS: print each key's first hit in this isolate (`compiler-hit <id>`), for the gate's server log. */
let logHits = true;
export function setHitLogging(on: boolean): void { logHits = on; }

/** Keys hit since the last `takeRequestHits()`: the dispatcher reads them per request (the speed measure). */
let requestHits = new Set<string>();
export function takeRequestHits(): Set<string> {
  const out = requestHits;
  requestHits = new Set();
  return out;
}

/** Wrap `fn` under its key: count, dispatch to a replacement, shadow. Keeps `this` and the arguments. */
export function keyed<F extends AnyFn>(kind: KeyKind, model: string, name: string, fn: F): F {
  const info = note(kind, model, name);
  const id = keyId(kind, model, name);
  HAND.set(id, fn);
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    info.hits += 1;
    requestHits.add(id);
    if (info.hits === 1 && logHits) console.warn(`compiler-hit ${id}`);
    const alt = REPLACED.get(id);
    const hand = (fn as unknown as (...a: unknown[]) => unknown).bind(this);
    if (alt === undefined) return hand(...args);
    if (alt.shadow === undefined) {
      // a failure of compiled code is logged with its key (the gate's server log), then raised unchanged
      const out = alt.fn(hand, args);
      if (out instanceof Promise) return out.catch((e: unknown) => {
        console.warn(`compiler-fail ${id} ${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)}`.slice(0, 600));
        if (DIAGNOSTIC.on) return hand(...args); // development builds only: see setDiagnostic
        throw e;
      });
      return out;
    }
    return shadowCall(id, alt, hand, args);
  };
  return wrapped as unknown as F;
}

/** Shadow mode (PLAN.md "Vilka nycklar som får skuggas"): the compiled first, then the hand port; the hand port answers. */
async function shadowCall(id: string, alt: Replacement, hand: (...a: unknown[]) => unknown, args: unknown[]): Promise<unknown> {
  let compiled: unknown;
  let compiledError: unknown = null;
  try { compiled = await alt.fn(hand, args); } catch (e) { compiledError = e; }
  let handAnswer: unknown;
  let handError: unknown = null;
  try { handAnswer = await (alt.watchHand ? alt.watchHand(args, async () => hand(...args)) : hand(...args)); } catch (e) { handError = e; }
  let diff: string | null;
  if (compiledError !== null || handError !== null) {
    const name = (e: unknown): string => e === null ? "none" : e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
    diff = name(compiledError) === name(handError) ? null : `exception compiled=${name(compiledError)} hand=${name(handError)}`;
  } else {
    // a comparator that fails is a difference of the key, never an error of the request (the hand port answers)
    try { diff = await alt.shadow!(handAnswer, compiled, args); } catch (e) { diff = `comparator failed: ${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)}`; }
  }
  SHADOW.set(id, { runs: (SHADOW.get(id)?.runs ?? 0) + 1, diffs: (SHADOW.get(id)?.diffs ?? 0) + (diff === null ? 0 : 1) });
  if (diff !== null) console.warn(`compiler-shadow-diff ${id} ${diff.slice(0, 2000)}`);
  if (handError !== null) throw handError;
  return handAnswer;
}

const SHADOW = new Map<string, { runs: number; diffs: number }>();

/** The hand port's own implementation of each key, whatever replaces it (shadow mode compares a compute's whole field
 *  group: the other fields' hand computes, install.ts). */
const HAND = new Map<string, AnyFn>();
export function handOf(kind: KeyKind, model: string, name: string): ((...args: unknown[]) => unknown) | undefined {
  return HAND.get(keyId(kind, model, name)) as ((...args: unknown[]) => unknown) | undefined;
}

/**
 * Install the compiled implementation of a key (src/compiled/, generated from compiler/out/<template>/manifest.json).
 * The key must be registered exactly once by the hand port: replacing a missing or doubly registered key is a build
 * error, so nothing is chosen by import order.
 */
export function replaceKey(kind: KeyKind, model: string, name: string, replacement: Replacement): void {
  checkReplaceable(kind, model, name);
  const id = keyId(kind, model, name);
  if (!KEYS.has(id)) {
    const waiting = PENDING.get(id);
    PENDING.set(id, waiting === undefined ? replacement : chain(waiting, replacement));
    return;
  }
  const prev = REPLACED.get(id);
  if (prev === undefined) { REPLACED.set(id, replacement); return; }
  // a second template's build replaces the same key: each replacement serves its own template and passes other
  // requests on (compiler/runtime/install.ts), so they chain: the new one's "hand" is the previous replacement
  REPLACED.set(id, {
    fn: (hand, args) => replacement.fn((...a: unknown[]) => prev.fn(hand, a), args),
    shadow: replacement.shadow ?? prev.shadow,
    watchHand: replacement.watchHand ?? prev.watchHand,
  });
}

function chain(prev: Replacement, replacement: Replacement): Replacement {
  return { fn: (hand, args) => replacement.fn((...a: unknown[]) => prev.fn(hand, a), args), shadow: replacement.shadow ?? prev.shadow,
    watchHand: replacement.watchHand ?? prev.watchHand };
}

/** Throws unless the key can be replaced: registered exactly once (or, in Node tests, not registered yet). */
export function checkReplaceable(kind: KeyKind, model: string, name: string): void {
  const id = keyId(kind, model, name);
  const info = KEYS.get(id);
  if (!info) { if (pendingAllowed) return; throw new Error(`replaceKey: ${id} is not registered by the hand port`); }
  if (info.registrations !== 1) throw new Error(`replaceKey: ${id} is registered ${info.registrations} times`);
}

/** Whether the hand port registered the key (a surface of a behaviour that may have several). */
export function isRegistered(kind: KeyKind, model: string, name: string): boolean {
  return KEYS.has(keyId(kind, model, name));
}

export function allKeys(): readonly KeyInfo[] {
  return [...KEYS.values()];
}

export function duplicateKeys(): readonly KeyInfo[] {
  return [...KEYS.values()].filter((k) => k.registrations > 1);
}

export function replacedKeys(): readonly string[] {
  return [...REPLACED.keys()];
}

export function shadowStats(): ReadonlyMap<string, { runs: number; diffs: number }> {
  return SHADOW;
}
