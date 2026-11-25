/**
 * mail.tracking.duration.mixin's rotting (odoo/addons/mail/models/mail_tracking_duration_mixin.py:60-125), for one
 * record: `is_rotting` and `rotting_days` of a model whose `_track_duration_field` is `stage_id` on a stage model with
 * `rotting_threshold_days`, and a `date_last_stage_update` field. The feature is on for a batch when some record's stage
 * rots (:60-80); a record whose own stage does not rot is outside `_get_rotting_domain()` (:91-97) and gets
 * False/0 either way, so the per-record answer equals the batch's. Each model's own `_get_rotting_domain()` terms are
 * its `extra` predicate (crm_lead.py:382-386, project_project.py:643-647, project_task.py:432-433).
 */
import type { Rec } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { dbNow } from "./util";

export interface Rotting { is_rotting: boolean; rotting_days: number }

export async function rottingOf(env: Environment, rec: Rec, extra: (rec: Rec) => Promise<boolean>): Promise<Rotting> {
  const none = { is_rotting: false, rotting_days: 0 };
  const stage = await rec.rel("stage_id");
  const days = stage ? Number((await stage.get("rotting_threshold_days")) ?? 0) : 0;
  if (!days) return none; // :97 `stage_id.rotting_threshold_days != 0`
  if (!(await extra(rec))) return none;
  // :110-119 `(date_last_stage_update or create_date or Datetime.now()) + timedelta(days=threshold) < now`, with
  // `now = cr.now()` (the transaction's time, src/models/util.ts dbNow); stored datetimes are naive UTC
  const now = await dbNow(env);
  const stamp = ((await rec.get("date_last_stage_update")) || (await rec.get("create_date"))) as string | null;
  const since = stamp ? new Date(`${stamp.replace(" ", "T")}Z`) : now;
  if (since.getTime() + days * 86_400_000 >= now.getTime()) return none;
  // :118 `(now - (date_last_stage_update or create_date)).days`: timedelta.days floors
  return { is_rotting: true, rotting_days: Math.floor((now.getTime() - since.getTime()) / 86_400_000) };
}
