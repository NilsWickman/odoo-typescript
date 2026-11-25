/**
 * The order of a many2many value in Odoo's cache after a write (fields_relational.py:1484-1605 `write_batch`): the old
 * ids as they were read (the comodel's `_order`), LINK appended in command order, SET in the given order. A later read
 * in the same transaction that finds the value in cache (the tracking of the write, mail_track_mixin.py `_track_finalize`)
 * sees that order, not the one a new SELECT gives. Kept per cursor, model, field and record; the last write wins.
 */
import type { Cursor } from "../db";

const ORDER = new WeakMap<Cursor, Map<string, number[]>>();

export function rememberX2manyOrder(cr: Cursor, model: string, field: string, relation: ReadonlyMap<number, readonly number[]>): void {
  let m = ORDER.get(cr);
  if (!m) ORDER.set(cr, m = new Map());
  for (const [id, ys] of relation) m.set(`${model}/${field}/${id}`, [...ys]);
}

/** `ids` (a value read from the database) in the cache order of the last write, those it does not know at the end. */
export function inX2manyCacheOrder(cr: Cursor, model: string, field: string, id: number, ids: readonly number[]): number[] {
  const order = ORDER.get(cr)?.get(`${model}/${field}/${id}`);
  if (!order) return [...ids];
  const rank = new Map(order.map((y, i) => [y, i]));
  return [...ids].sort((a, b) => (rank.get(a) ?? order.length) - (rank.get(b) ?? order.length));
}

/** The many2many fields whose cache order after a write survives to web_save's web_read (registerWrittenOrder). */
const WRITTEN_ORDER = new Set<string>();

/**
 * After `write`, web_save's web_read reads this many2many from the cache, in the order `write_batch` left it, not the
 * comodel's `_order` of a database read (src/web/save.ts). Used for fields written as a side effect (not in `vals`).
 */
export function registerWrittenOrder(model: string, field: string): void {
  WRITTEN_ORDER.add(`${model}.${field}`);
}

export function keepsWrittenOrder(model: string, field: string): boolean {
  return WRITTEN_ORDER.has(`${model}.${field}`);
}

/**
 * environments.py `invalidate_all`: the cache is empty, so a later read gives the database order again (base
 * res_users.py:721-723 a write of `group_ids`, res_groups.py:262-265 and ir_access.py:252-256 `_clear_caches`).
 */
export function forgetX2manyOrder(cr: Cursor): void {
  ORDER.delete(cr);
}
