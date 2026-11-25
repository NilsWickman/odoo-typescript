/**
 * rating/models/mail_message.py:41-68 `_store_message_fields` (rating installed, e.g. poc_erp): `rating_id`, the
 * latest consumed rating of the message (`_compute_rating_id`, :17-22), and per-thread rating stats for
 * rating.mixin models. A message with a rating (its `_store_rating_fields`) and threads of rating.mixin models
 * are refused. Added by stream CRM next to thread.ts (stream MAIL).
 */
import { NotPorted } from '../errors';
import type { Environment } from '../orm/types';
import type { Store } from './store';
import { pyFloat } from '../orm/values';

export async function ratingMessageFields(env: Environment, mid: number, model: string, store?: Store): Promise<Record<string, unknown>> {
  if (!(env.reg.model('mail.message').modules?.includes('rating'))) return {};
  void model; // the thread's rating fields: ratingThreadFields
  const r = await env.cr.query<{ id: number; rating: number | null; rating_text: string | null }>(
    'SELECT id, rating, rating_text FROM rating_rating WHERE message_id = $1 AND consumed ORDER BY create_date DESC, id DESC LIMIT 1', [mid]);
  const row = r.rows[0];
  if (!row) return { rating_id: false };
  if (!store) throw new NotPorted('mail.message rating_id Store (_store_rating_fields) without a Store');
  // rating.py:210-211 `_store_rating_fields`; :98-108 the image of `_rating_to_threshold` (rating_data.py:77-87)
  const v = row.rating ?? 0;
  const threshold = v >= 4 ? 5 : v >= 3 ? 3 : v >= 1 ? 1 : 0;
  store.add('rating.rating', row.id, { rating: pyFloat(v), rating_image_url: `/rating/static/src/img/rating_${threshold}.png`, rating_text: row.rating_text ?? false });
  return { rating_id: row.id };
}

/**
 * rating/models/mail_message.py:45-66: the threads of rating.mixin models (`rating_avg_text` is a rating.mixin field,
 * rating.parent.mixin has none) readable by the user (rating_avg: groups base.group_user) get `rating_avg` and
 * `rating_count` in the Store; `rating_stats` only when `_allow_publish_rating_stats` (False for the installed models).
 */
export async function ratingThreadFields(env: Environment, model: string, id: number): Promise<Record<string, unknown>> {
  if (!(env.reg.model('mail.message').modules?.includes('rating'))) return {};
  const def = env.reg.models.get(model);
  if (!def?.fields.has('rating_avg_text')) return {};
  const { userHasGroup } = await import('../web/groups');
  if (!env.su && !(await userHasGroup(env, 'base.group_user'))) return {};
  const row = (await env.sudo().model(model).read([id], ['rating_avg', 'rating_count'], 'web'))[0];
  if (!row) return {};
  return { rating_avg: row['rating_avg'], rating_count: row['rating_count'] };
}
