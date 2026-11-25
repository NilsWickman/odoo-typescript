/**
 * Records inserted by the current transaction (one request cursor), by model. mail.thread `create` discards the
 * tracking of the records it creates for the rest of the transaction (mail_thread.py:404 `_track_discard`), and Odoo
 * only finalizes tracking at precommit, so a stored compute written during the create (an order's totals once its
 * lines exist) is never logged. The port finalizes tracking when the outermost write returns, which can happen before
 * `create` returns: src/mail/tracking.ts consults this set to discard such records from the start.
 */
import type { Cursor } from "../db";

const CREATED = new WeakMap<Cursor, Map<string, Set<number>>>();

export function noteCreated(cr: Cursor, model: string, ids: readonly number[]): void {
  let byModel = CREATED.get(cr);
  if (!byModel) CREATED.set(cr, (byModel = new Map()));
  let set = byModel.get(model);
  if (!set) byModel.set(model, (set = new Set()));
  for (const id of ids) set.add(id);
}

export function createdInTransaction(cr: Cursor, model: string, id: number): boolean {
  return CREATED.get(cr)?.get(model)?.has(id) ?? false;
}

/**
 * Records created before a commit inside the request (`button_immediate_install`'s `cr.commit()`, ir_module.py:645):
 * their discarded tracking ended with that commit's precommit, so their later writes are tracked again.
 */
const BEFORE_COMMIT = new WeakMap<Cursor, Map<string, Set<number>>>();

/** A commit inside the request: the records created so far are no longer discarded from tracking. */
export function noteCommitPoint(cr: Cursor): void {
  const byModel = CREATED.get(cr);
  if (!byModel) return;
  let done = BEFORE_COMMIT.get(cr);
  if (!done) BEFORE_COMMIT.set(cr, (done = new Map()));
  for (const [model, ids] of byModel) {
    let set = done.get(model);
    if (!set) done.set(model, (set = new Set()));
    for (const id of ids) set.add(id);
  }
}

/** Created in this transaction after its last commit point (mail_thread.py:404 `_track_discard` still applies). */
export function createdSinceCommit(cr: Cursor, model: string, id: number): boolean {
  return createdInTransaction(cr, model, id) && !(BEFORE_COMMIT.get(cr)?.get(model)?.has(id) ?? false);
}
