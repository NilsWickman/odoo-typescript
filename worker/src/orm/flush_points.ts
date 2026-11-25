/**
 * Where Odoo would flush a field (environments.py:545-560 `execute_query`: the fields an ORM query reads, flushed in
 * the querying environment). The port writes at once; src/orm/recompute.ts `deferredFlush` listens here to know when
 * a pending write of a field reached the database in Odoo, and with which uid.
 */
import type { Cursor } from "../db";

interface Listener {
  flushed(model: string, field: string, uid: number): void;
  /** Whether Odoo has `field` of every one of `ids` in its cache (a dirty value always is). */
  cached(model: string, field: string, ids: readonly number[]): boolean;
}
const LISTENERS = new WeakMap<Cursor, Listener>();
const QUIET = new WeakMap<Cursor, number>();

export function onFieldFlush(cr: Cursor, listener: Listener | null): void {
  if (listener) LISTENERS.set(cr, listener);
  else LISTENERS.delete(cr);
}

/** Whether a listener follows the cursor's flushes (src/orm/recompute.ts `deferredFlush` is running). */
export function flushListening(cr: Cursor): boolean {
  return LISTENERS.has(cr);
}

/** An ORM query of the cursor reads `model.field` (its SQL is built by `fieldSql`). */
export function fieldFlushed(cr: Cursor, model: string, field: string, uid: number): void {
  if (QUIET.get(cr)) return;
  LISTENERS.get(cr)?.flushed(model, field, uid);
}

/**
 * A read of `field` of `ids` (models.py:3077 `_fetch_field`): when Odoo has them all in cache it answers without a
 * query, so nothing is flushed (fields.py `__get__`); the port's SELECT in `fn` then flushes nothing either.
 */
export async function readRecords<T>(cr: Cursor, model: string, field: string, ids: readonly number[], fn: () => Promise<T>): Promise<T> {
  const listener = LISTENERS.get(cr);
  if (!listener || !listener.cached(model, field, ids)) return fn();
  QUIET.set(cr, (QUIET.get(cr) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    QUIET.set(cr, QUIET.get(cr)! - 1);
  }
}

/**
 * A read of the port's own bookkeeping that Odoo does not make (src/orm/write.ts `snapshot`, the old values for the
 * write hooks): it flushes nothing. vagb_chart_lu: the purchase journal's snapshot flushed the sale journal's pending
 * default_account_id with uid 2, where Odoo (tracking_disable, chart_template.py:208-214) reads nothing and leaves it to
 * `_load_translations`' superuser flush (measured with a trace of Odoo, 2026-11-14).
 */
export async function withoutFlush<T>(cr: Cursor, fn: () => Promise<T>): Promise<T> {
  QUIET.set(cr, (QUIET.get(cr) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    QUIET.set(cr, QUIET.get(cr)! - 1);
  }
}
