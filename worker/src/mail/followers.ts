/**
 * mail.followers writes (odoo/addons/mail/models/mail_followers.py `_insert_followers` :405,
 * `_add_default_followers` :439, `_add_followers` :464; mail_message_subtype.py `_default_subtypes` :94) and the
 * thread API on top (mail_thread.py `_message_subscribe` :4889, `message_unsubscribe` :4917).
 */
import { NotPorted } from '../errors';
import type { Environment } from '../orm/types';
import { pySetOrder } from '../models/pyset';
import { execute } from '../orm/sql';

/** `default_subtypes(model)`: (all default, internal, external) ids, in mail.message.subtype order (sequence, id). */
export async function defaultSubtypes(env: Environment, model: string): Promise<{ all: number[]; internal: number[]; external: number[] }> {
  const rows = (await env.cr.query<{ id: number; internal: boolean | null }>(
    `SELECT id, internal FROM mail_message_subtype WHERE "default" IS TRUE AND (res_model = $1 OR res_model IS NULL)
      ORDER BY sequence, id`, [model])).rows;
  return { all: rows.map(r => r.id), internal: rows.filter(r => r.internal).map(r => r.id), external: rows.filter(r => !r.internal).map(r => r.id) };
}

// mail_followers.py:504 `for partner_id in set(partner_ids or [])`: the CPython set's slot order (src/models/pyset.ts)

type Policy = 'skip' | 'force' | 'replace' | 'update';

/**
 * `_insert_followers(res_model, res_ids, partner_ids, subtypes, customer_ids, check_existing, existing_policy)`.
 * `subtypes` null computes the defaults (internal for non-share partners, external for customers).
 */
export async function insertFollowers(env: Environment, model: string, resIds: readonly number[], partnerIds: readonly number[],
  subtypes: ReadonlyMap<number, readonly number[]> | null, opts: { customerIds?: readonly number[] | null; checkExisting: boolean; policy: Policy }): Promise<void> {
  if (!partnerIds.length) return;
  let byPartner: ReadonlyMap<number, readonly number[]>;
  if (subtypes === null) {
    const def = await defaultSubtypes(env, model);
    const customers = opts.customerIds ?? (await env.cr.query<{ id: number }>(
      'SELECT id FROM res_partner WHERE id = ANY($1::int[]) AND partner_share IS TRUE', [partnerIds])).rows.map(r => r.id);
    byPartner = new Map(partnerIds.map(pid => [pid, customers.includes(pid) ? def.external : def.all]));
  } else byPartner = subtypes;
  const existing = new Map<string, { id: number; sids: number[] }>();
  if (opts.checkExisting && resIds.length) {
    const rows = (await env.cr.query<{ id: number; res_id: number; partner_id: number | null; sids: number[] | null }>(
      `SELECT f.id, f.res_id, f.partner_id, array_remove(array_agg(r.mail_message_subtype_id ORDER BY r.mail_message_subtype_id), NULL) AS sids
         FROM mail_followers f LEFT JOIN mail_followers_mail_message_subtype_rel r ON r.mail_followers_id = f.id
        WHERE f.res_model = $1 AND f.res_id = ANY($2::int[]) AND f.partner_id = ANY($3::int[]) GROUP BY f.id ORDER BY f.id`,
      [model, resIds, partnerIds])).rows;
    if (opts.policy === 'force' && rows.length) throw new NotPorted('follower existing_policy force');
    for (const r of rows) if (r.partner_id) existing.set(`${r.res_id}:${r.partner_id}`, { id: r.id, sids: r.sids ?? [] });
  }
  const order = pySetOrder(partnerIds);
  for (const resId of resIds) {
    for (const pid of order) {
      const want = byPartner.get(pid) ?? [];
      const old = existing.get(`${resId}:${pid}`);
      if (!old) {
        const fid = (await env.cr.query<{ id: number }>(
          `INSERT INTO mail_followers (res_model, res_id, partner_id, create_uid, write_uid, create_date, write_date)
           VALUES ($1, $2, $3, $4, $4, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC') RETURNING id`,
          [model, resId, pid, env.uid])).rows[0]!.id;
        await insertSubtypes(env, fid, want);
      } else if (opts.policy === 'replace' || opts.policy === 'update') {
        const add = want.filter(s => !old.sids.includes(s));
        const remove = opts.policy === 'replace' ? old.sids.filter(s => !want.includes(s)) : [];
        if (!add.length && !remove.length) continue;
        await insertSubtypes(env, old.id, add);
        if (remove.length) await env.cr.query('DELETE FROM mail_followers_mail_message_subtype_rel WHERE mail_followers_id = $1 AND mail_message_subtype_id = ANY($2::int[])', [old.id, remove]);
        await env.cr.query(`UPDATE mail_followers SET write_uid = $2, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1`, [old.id, env.uid]);
      }
    }
  }
}

/** `_message_subscribe(partner_ids, subtype_ids, customer_ids)` (mail_thread.py:4889). */
export async function messageSubscribe(env: Environment, model: string, resIds: readonly number[], partnerIds: readonly number[],
  subtypeIds: readonly number[] | null, customerIds: readonly number[] | null = null): Promise<void> {
  if (!resIds.length) return;
  if (!subtypeIds || !subtypeIds.length) {
    await insertFollowers(env, model, resIds, partnerIds, null, { customerIds, checkExisting: true, policy: 'skip' });
  } else {
    await insertFollowers(env, model, resIds, partnerIds, new Map(partnerIds.map(p => [p, subtypeIds])), { customerIds, checkExisting: true, policy: 'replace' });
  }
}

/** The SQL part of `message_unsubscribe` (mail_thread.py:4930): the caller did the access check. */
export async function deleteFollowers(env: Environment, model: string, resIds: readonly number[], partnerIds: readonly number[] | null): Promise<void> {
  if (partnerIds === null) await env.cr.query('DELETE FROM mail_followers WHERE res_model = $1 AND res_id = ANY($2::int[])', [model, resIds]);
  else await env.cr.query('DELETE FROM mail_followers WHERE res_model = $1 AND res_id = ANY($2::int[]) AND partner_id = ANY($3::int[])', [model, resIds, partnerIds]);
}

/**
 * The subtype links of a follower in one statement, in the given order (Many2many's `_write_real` inserts a record's
 * links at once, fields_relational.py), as the per-link INSERTs did one after the other.
 */
async function insertSubtypes(env: Environment, followerId: number, subtypeIds: readonly number[]): Promise<void> {
  if (subtypeIds.length === 0) return;
  if (subtypeIds.length === 1) {
    // nothing to read back: sent without waiting (src/orm/sql.ts execute)
    await execute(env, 'INSERT INTO mail_followers_mail_message_subtype_rel (mail_followers_id, mail_message_subtype_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [followerId, subtypeIds[0]]);
    return;
  }
  await execute(env, `INSERT INTO mail_followers_mail_message_subtype_rel (mail_followers_id, mail_message_subtype_id)
    SELECT $1, s FROM unnest($2::int[]) WITH ORDINALITY AS u(s, n) ORDER BY n ON CONFLICT DO NOTHING`, [followerId, [...subtypeIds]]);
}
