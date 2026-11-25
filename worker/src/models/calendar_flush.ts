/**
 * The calendar's records still pending in Odoo's cache when `calendar.alarm_manager._notify_next_alarm`
 * (calendar_alarm_manager.py:234-242) runs `get_next_notif` as each notified user (`with_user(user)`, users in
 * res.users order 'name, login'): its `_get_next_potential_limit_alarm` flushes (:16-18 `flush_model`, :65
 * `flush_all`) in that user's environment, so `_write_multi` (models.py:4008-4010) stamps the pending records with
 * that user's uid. Measured in an Odoo shell (`_write_multi` traced, 2026-11-09): at an event's create the event
 * (`calendar_id`, `duration`), every attendee created with it or its occurrences (`common_name`), the recurrence and
 * the invitations' attachments (`res_model`, `res_id`) are pending; at a write of the times only a changed `duration`.
 * An explicit write from a fresh request carries its own write_uid and is flushed before.
 *
 * The callers mark what is pending (`markPending`); `notifyNextAlarm` stamps it with its first user and clears it
 * (`flushPendingAs`); the caller clears what is left at its end (the request's own flush, as its user).
 */
import type { Environment } from "../orm/types";

const PENDING = new WeakMap<object, Map<string, Set<number>>>();

export function markPending(env: Environment, model: string, ids: readonly number[]): void {
  if (!ids.length) return;
  const byModel = PENDING.get(env.cr) ?? new Map<string, Set<number>>();
  PENDING.set(env.cr, byModel);
  const set = byModel.get(model) ?? new Set<number>();
  for (const id of ids) set.add(id);
  byModel.set(model, set);
}

/** A flush in the environment of `uid`: the pending records get its write_uid, nothing is pending afterwards. */
export async function flushPendingAs(env: Environment, uid: number): Promise<void> {
  const byModel = PENDING.get(env.cr);
  if (!byModel) return;
  PENDING.delete(env.cr);
  for (const [model, ids] of byModel) {
    const table = env.reg.model(model).table;
    await env.cr.query(`UPDATE "${table}" SET write_uid = $1 WHERE id = ANY($2::int[]) AND write_uid IS DISTINCT FROM $1`, [uid, [...ids]]);
  }
}

/** The end of the caller's work: what is still pending is flushed as its own user, which already wrote it. */
export function clearPending(env: Environment): void {
  PENDING.delete(env.cr);
}

/** Whether anything is pending (a caller that cannot know the flushing user refuses then). */
export function hasPending(env: Environment): boolean {
  return PENDING.has(env.cr);
}
