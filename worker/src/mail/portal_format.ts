/**
 * The portal chatter's messages: portal/controllers/thread.py:35-75 `/mail/chatter_fetch` (the share-only domain of
 * :151-162 `_get_portal_message_fetch_domain`, `_message_fetch` as superuser, mail_message.py:984-1039) and
 * portal/models/mail_message.py:30-172 `portal_message_format` of the fetched messages, added to the Store as plain
 * values. Refused: attachments, reactions, linked messages (`o_message_redirect` links in the body), search terms
 * and filters.
 */
import { NotPorted } from '../errors';
import type { Environment } from '../orm/types';
import { limitedFieldAccessToken } from '../models/util';
import { formatDatetime } from '../models/tail_util';
import { userInfo } from '../orm/env';
import { xmlidToResId } from '../session/user';
import type { Store } from './store';

/** mail_thread.py:5442-5445 `_get_customer_portal_message_types` (no installed model overrides it for sale/account). */
const CUSTOMER_TYPES = ['auto_comment', 'comment', 'email', 'email_outgoing'];

/** `_message_fetch(domain & thread, before/after/around, limit)` of the portal domain, as superuser. */
export async function fetchPortalMessages(env: Environment, model: string, id: number, params: Record<string, unknown>): Promise<number[]> {
  for (const k of Object.keys(params)) {
    if (!['limit', 'before', 'after', 'around'].includes(k)) throw new NotPorted(`portal message fetch ${k}`);
  }
  const limit = params['limit'] === undefined || params['limit'] === null ? 30 : Number(params['limit']);
  // :151-162 and mail_message.py:33-37 SHARE_DOMAIN, :1488-1498 `_get_empty_domain` negated
  const rows = async (extra: string, order: 'ASC' | 'DESC', lim: number, arg: unknown[]): Promise<number[]> => (await env.cr.query<{ id: number }>(
    `SELECT m.id FROM mail_message m LEFT JOIN mail_message_subtype s ON s.id = m.subtype_id
      WHERE m.model = $1 AND m.res_id = $2 AND m.message_type = ANY($3::text[]) AND m.message_type != 'user_notification'
        AND m.message_type != 'tracking' AND m.is_internal IS NOT TRUE AND s.internal IS NOT TRUE
        AND NOT (NOT EXISTS (SELECT 1 FROM message_attachment_rel r WHERE r.message_id = m.id)
                 AND (m.body IS NULL OR m.body = '' OR m.body LIKE '<span class="o-mail-Message-edited"%></span>')
                 AND s.description IS NULL
                 AND NOT EXISTS (SELECT 1 FROM mail_poll pl WHERE pl.end_message_id = m.id OR pl.start_message_id = m.id))
        ${extra}
      ORDER BY m.id ${order} LIMIT ${lim}`, [model, id, CUSTOMER_TYPES, ...arg])).rows.map((r) => r.id);
  if (params['around'] !== undefined && params['around'] !== null) {
    const around = Number(params['around']);
    const before = await rows('AND m.id <= $4', 'DESC', Math.floor(limit / 2), [around]);
    const after = await rows('AND m.id > $4', 'ASC', Math.floor(limit / 2), [around]);
    return [...after, ...before].sort((a, b) => b - a);
  }
  const conds: string[] = [], args: unknown[] = [];
  if (params['before']) { args.push(Number(params['before'])); conds.push(`AND m.id < $${3 + args.length}`); }
  if (params['after']) { args.push(Number(params['after'])); conds.push(`AND m.id > $${3 + args.length}`); }
  const ids = await rows(conds.join(' '), params['after'] ? 'ASC' : 'DESC', limit, args);
  if (params['after']) ids.sort((a, b) => b - a);
  return ids;
}

/** portal mail_message.py:30-172 `portal_message_format` (as superuser: the messages come from a sudo fetch). */
export async function portalMessageFormat(env: Environment, ids: readonly number[], store: Store): Promise<void> {
  if (!ids.length) return;
  const rows = (await env.cr.query<{
    id: number; body: string | null; date: string | null; author_id: number | null; author_guest_id: number | null; is_internal: boolean | null;
    message_type: string; model: string | null; res_id: number | null; subtype_id: number | null; author_name: string | null; guest_name: string | null;
  }>(
    `SELECT m.id, m.body, to_char(m.date, 'YYYY-MM-DD HH24:MI:SS') AS date, m.author_id, m.author_guest_id, m.is_internal, m.message_type,
            m.model, m.res_id, m.subtype_id, p.name AS author_name, g.name AS guest_name
       FROM mail_message m LEFT JOIN res_partner p ON p.id = m.author_id LEFT JOIN mail_guest g ON g.id = m.author_guest_id
      WHERE m.id = ANY($1::int[])`, [[...ids]])).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const attached = (await env.cr.query<{ message_id: number }>('SELECT message_id FROM message_attachment_rel WHERE message_id = ANY($1::int[]) LIMIT 1', [[...ids]])).rows;
  if (attached.length) throw new NotPorted('portal_message_format of messages with attachments (access tokens)');
  const reacted = (await env.cr.query<{ message_id: number }>('SELECT message_id FROM mail_message_reaction WHERE message_id = ANY($1::int[]) LIMIT 1', [[...ids]])).rows;
  if (reacted.length) throw new NotPorted('portal_message_format of messages with reactions');
  const partnerId = (await userInfo(env)).partnerId;
  const bookmarked = new Set((await env.cr.query<{ id: number }>(
    'SELECT mail_message_id AS id FROM mail_message_res_partner_bookmarked_rel WHERE mail_message_id = ANY($1::int[]) AND res_partner_id = $2',
    [[...ids], partnerId])).rows.map((r) => r.id));
  const subtypes = [...new Set(rows.map((r) => r.subtype_id).filter((s): s is number => s !== null))];
  const subtypeNames = subtypes.length ? await env.sudo().model('mail.message.subtype').displayName(subtypes) : new Map<number, string>();
  const note = await xmlidToResId(env.cr, 'mail.mt_note');
  for (const id of ids) {
    const r = byId.get(id);
    if (r === undefined) continue;
    if (r.body && r.body.includes('o_message_redirect')) throw new NotPorted('portal_message_format of a message linking other messages');
    if (r.model === null || r.res_id === null) throw new NotPorted('portal_message_format of a message without a thread');
    const subtype = r.subtype_id === null ? false : [r.subtype_id, subtypeNames.get(r.subtype_id) ?? false];
    store.add('mail.message', id, {
      attachment_ids: [],
      author_guest_id: r.author_guest_id === null ? false : [r.author_guest_id, r.guest_name ?? false],
      author_id: r.author_id === null ? false : {
        id: r.author_id, name: r.author_name ?? false,
        avatar_128_access_token: await limitedFieldAccessToken(env, 'res.partner', r.author_id, 'avatar_128', 'binary'),
      },
      body: ['markup', r.body ?? false],
      date: r.date ?? false,
      is_bookmarked: bookmarked.has(id),
      is_internal: Boolean(r.is_internal),
      is_message_subtype_note: r.subtype_id !== null && r.subtype_id === note,
      message_type: r.message_type,
      model: r.model,
      published_date_str: await formatDatetime(env, r.date),
      reactions: [],
      res_id: r.res_id,
      subtype_id: subtype,
      // `isinstance(self.env[model], mail.thread)`: the portal threads are mail.thread models
      thread: { has_mail_thread: true, id: r.res_id, model: r.model },
    }, false);
  }
}
