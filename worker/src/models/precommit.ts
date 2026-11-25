/**
 * A small part of Odoo's `cr.precommit` (sql_db.py:295-306): tracking scopes closed when the transaction flushes,
 * which Odoo also does at every `cr.savepoint()` (`flush` runs the precommit hooks). Methods that keep a tracking
 * scope open past their return register its close here; `withPrecommit` runs the list when the outermost owner
 * returns, `runPrecommit` at a savepoint.
 */
import type { Cursor } from "../db";

const LISTS = new WeakMap<Cursor, { depth: number; fns: (() => Promise<void>)[] }>();

function stateOf(cr: Cursor): { depth: number; fns: (() => Promise<void>)[] } {
  let st = LISTS.get(cr);
  if (!st) LISTS.set(cr, st = { depth: 0, fns: [] });
  return st;
}

/** Adds `fn` to the hooks; outside an owner it runs at once (the owner's end is now). */
export async function addPrecommit(cr: Cursor, fn: () => Promise<void>): Promise<void> {
  const st = stateOf(cr);
  if (st.depth === 0) { await fn(); return; }
  st.fns.push(fn);
}

/** Runs the hooks added so far, in their order (a hook may add others: they run too). */
export async function runPrecommit(cr: Cursor): Promise<void> {
  const st = stateOf(cr);
  while (st.fns.length) await st.fns.shift()!();
}

/** Runs `fn` as an owner of the hooks: the outermost owner runs them when `fn` returns. */
export async function withPrecommit<T>(cr: Cursor, fn: () => Promise<T>): Promise<T> {
  const st = stateOf(cr);
  st.depth++;
  let out: T;
  try {
    out = await fn();
  } finally {
    st.depth--;
  }
  if (st.depth === 0) await runPrecommit(cr);
  return out;
}
