/**
 * `/mail/message/post` on a discuss.channel (odoo/addons/mail/controllers/thread.py:230-259) for an internal user who
 * is a member: discuss_channel.py:1423-1448 `message_post` -> mail_thread.py:2256-2449 (sudo), with
 *  - `_update_last_interest_dt` (:710-768): a `discuss.channel.last.interest.update` row and the trigger of the sync
 *    cron, then, after commit, `_sync_last_interest_dt` (:770-799) in its own transaction as superuser: the channel's
 *    `last_interest_dt`, the drained rows and the trigger deleted, the channel's synced field on its bus;
 *  - `_message_post_after_hook` (:1450-1488, mail_bot's first: no answer outside a chat with OdooBot or a mention):
 *    the author's member sees the message and moves its separator (discuss_channel_member.py:777-818), whose write
 *    syncs `message_unread_counter` and `new_message_separator` to the member's user (bus.sync.mixin, :316-336);
 *  - `_notify_thread` (:1216-1363): the other members are web push recipients (no device, else refused), then
 *    `discuss.channel/new_message` with the message's Store (and the composer's `temporary_id`) on the channel's bus;
 *  - in a chat with OdooBot, mail_bot's answers first (src/mail/mail_bot.ts), each a silent message of OdooBot.
 *  - the attachments of the post (moved from the composer) and the mentioned partners' inbox notifications and Stores.
 *  - a reply's parent (a message of the same channel).
 * Refused: partner emails, special mentions, canned responses, sub-channels, guests and portal users,
 * non-members, push devices, other message types, OdooBot's random answer.
 */
import { NotPorted } from '../errors';
import type { RequestContext } from '../http/context';
import type { Env } from '../env';
import type { Environment } from '../orm/types';
import { userInfo } from '../orm/env';
import { userFlags } from '../session/user';
import { Cursor } from '../db';
import { BusValues, dispatchRows } from '../bus/bus';
import { storeVersion } from '../bus/presence';
import { computeAuthor, insertMessages, trackingMessageId, xmlid } from './message';
import { sanitizeBody, sanitizeBodyFull } from './sanitize';
import { messageFields } from './thread';
import { Store } from './store';
import { unreadCount } from './channels';
import { pyTruthy } from '../models/util';
import { recordWritten } from '../orm/written_fields';
import { cond } from '../orm/domain';

const ALLOWED_POST_DATA = new Set(['body', 'email_add_signature', 'message_type', 'subtype_xmlid', 'partner_ids', 'attachment_ids', 'attachment_tokens', 'partner_emails',
  'partner_ids_mention_token', 'parent_id']);

/**
 * The `mail.message` entries of a Store sent to the channel's bus: without the fields only the current user's answer
 * has (`for_current_user`), and, unless the channel's bus is for internal users only (tools/discuss.py:909-933
 * `is_for_internal_users`: a channel whose group implies base.group_user), without `email_from`, `reply_to` (of a message
 * with an author) and `notification_ids` (mail_message.py:1224-1277).
 */
/** tools/discuss.py:909-933 `is_for_internal_users` of a channel's bus: a channel whose group implies base.group_user. */
export async function channelBusIsInternal(env: Environment, channel: { channel_type: string; group_public_id: number | null }): Promise<boolean> {
  return channel.channel_type === 'channel' && channel.group_public_id !== null && (await env.cr.query(
    `WITH RECURSIVE g(id) AS (SELECT $1::int UNION SELECT r.hid FROM res_groups_implied_rel r JOIN g ON r.gid = g.id)
     SELECT 1 FROM g JOIN ir_model_data d ON d.model = 'res.groups' AND d.res_id = g.id WHERE d.module = 'base' AND d.name = 'group_user'`, [channel.group_public_id])).rows.length > 0;
}

export function forChannelBus(data0: Record<string, unknown>, internal: boolean): Record<string, unknown> {
  // the attachments' `ownership_token` is the poster's own (mail ir_attachment.py `_store_ownership_fields`, the answer
  // only); the notifications and the partners' emails are internal fields (mail_message.py `notification_ids`)
  const data = { ...data0 };
  if (Array.isArray(data['ir.attachment'])) {
    data['ir.attachment'] = (data['ir.attachment'] as Record<string, unknown>[]).map(({ ownership_token: _o, ...a }) => a);
  }
  if (!internal) {
    delete data['mail.notification'];
    // res_partner.py:250-255 `_store_partner_fields`: email and tz are internal fields (here from the notifications)
    if (Array.isArray(data['res.partner'])) data['res.partner'] = (data['res.partner'] as Record<string, unknown>[]).map(({ email: _e, ...p }) => p);
  }
  const messages = data['mail.message'];
  if (!Array.isArray(messages)) return data;
  return { ...data, 'mail.message': messages.map((m) => {
    const { is_bookmarked: _a, needaction: _b, needaction_done: _c, ...rest } = m as Record<string, unknown>;
    if (internal) return rest;
    const { notification_ids: _n, ...out } = rest;
    if (out['author_id'] || out['author_guest_id']) { delete out['email_from']; delete out['reply_to']; }
    return out;
  }) };
}

export async function postOnChannel(ctx: RequestContext, env0: Environment, p: Record<string, unknown>): Promise<unknown> {
  const db = ctx.db;
  if (db === null) throw new NotPorted('channel post without a database');
  let env = env0;
  const context = p['context'];
  if (context && typeof context === 'object') env = env.withContext({ ...env.context, ...(context as Record<string, unknown>) });
  if (p['canned_response_ids'] && (p['canned_response_ids'] as unknown[]).length) throw new NotPorted('canned responses');
  const channelId = Number(p['thread_id']);
  if (!Number.isInteger(channelId)) throw new NotPorted('channel post on a missing thread id');
  if (!(await userFlags(env.cr, env.uid)).isInternal) throw new NotPorted('channel post of non-internal users');
  const post = (p['post_data'] ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(post)) if (!ALLOWED_POST_DATA.has(k)) throw new NotPorted(`channel post_data ${k}`);
  if (((post['partner_emails'] as unknown[] | undefined) ?? []).length) throw new NotPorted('channel post with partner_emails');
  if ((post['message_type'] ?? 'comment') !== 'comment') throw new NotPorted(`channel post of type ${String(post['message_type'])}`);
  const subtypeXmlid = typeof post['subtype_xmlid'] === 'string' ? post['subtype_xmlid'] : 'mail.mt_note';
  if (subtypeXmlid !== 'mail.mt_comment') throw new NotPorted(`channel post with subtype ${subtypeXmlid}`);
  const channel = (await env.cr.query<{ channel_type: string; parent_channel_id: number | null; group_public_id: number | null }>(
    'SELECT channel_type, parent_channel_id, group_public_id FROM discuss_channel WHERE id = $1', [channelId])).rows[0];
  if (!channel) throw new NotPorted('channel post on a missing channel');
  if (channel.parent_channel_id) throw new NotPorted('channel post in a sub-channel');
  const self = await userInfo(env);
  const member = (await env.cr.query<{ id: number; seen_message_id: number | null; new_message_separator: number; last_seen: string | null; now_s: string; write_uid: number | null }>(
    `SELECT id, seen_message_id, new_message_separator, to_char(last_seen_dt, 'YYYY-MM-DD HH24:MI:SS') AS last_seen, write_uid,
            to_char(date_trunc('second', now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS') AS now_s
       FROM discuss_channel_member WHERE channel_id = $1 AND partner_id = $2`, [channelId, self.partnerId])).rows[0];
  if (!member) throw new NotPorted('channel post of a non-member (channel access rules)');
  const root = (await env.cr.query<{ id: number }>("SELECT res_id AS id FROM ir_model_data WHERE module = 'base' AND name = 'partner_root'")).rows[0]!.id;
  const members = (await env.cr.query<{ partner_id: number | null }>('SELECT partner_id FROM discuss_channel_member WHERE channel_id = $1', [channelId])).rows;
  // mail_bot/models/mail_bot.py:58-60 OdooBot answers in a chat it is a member of
  const botChat = channel.channel_type === 'chat' && members.some((m) => m.partner_id === root);
  // `_notify_thread_by_web_push` (mail_thread.py) of the other members: their devices
  const others = members.map((m) => m.partner_id).filter((id): id is number => id !== null && id !== self.partnerId);
  if (others.length && (await env.cr.query('SELECT 1 FROM mail_push_device WHERE partner_id = ANY($1::int[]) LIMIT 1', [others])).rows.length) {
    throw new NotPorted('web push notifications of channel members');
  }
  if ((await env.cr.query('SELECT 1 FROM res_company WHERE id = $1 AND alias_domain_id IS NOT NULL', [await env.company()])).rows.length) throw new NotPorted('record alias domains (_mail_get_alias_domains)');
  // thread.py:179-226 `_prepare_message_data`: the attachments the user owns, the partners an internal user can read
  // (the mention tokens are for share users); discuss_channel.py:1423-1436 `message_post` keeps the partners allowed
  // in the channel (`_get_allowed_message_partner_ids` :1404-1421)
  const { postAttachmentIds, processAttachmentsForPost } = await import('./post');
  const attachmentIds = await postAttachmentIds(env, post);
  const partnerIds = await allowedPartners(env, channelId, channel, ((post['partner_ids'] as unknown[] | undefined) ?? []).map(Number));
  // discuss_channel.py:1402 `parent_id` -> mail_thread.py:3173-3196 `_message_compute_parent_id` of a non-flat thread:
  // the given message when it is in this channel, else none
  const parentGiven = post['parent_id'];
  const parentId = parentGiven === undefined || parentGiven === null || parentGiven === false ? false
    : (await env.cr.query<{ id: number }>("SELECT id FROM mail_message WHERE id = $1 AND model = 'discuss.channel' AND res_id = $2", [Number(parentGiven), channelId])).rows[0]?.id ?? false;
  if (parentId) {
    // :4626-4634 `_notify_thread_with_out_of_office`: the parent's internal author may answer out of office
    if ((await env.cr.query(`SELECT 1 FROM mail_message m JOIN res_users u ON u.partner_id = m.author_id
        WHERE m.id = $1 AND u.active AND u.out_of_office_from IS NOT NULL AND m.author_id IS DISTINCT FROM $2`, [parentId, self.partnerId])).rows.length) {
      throw new NotPorted('out of office answers');
    }
  }
  const sudo = env.sudo();
  const trigger = await queueLastInterest(env, channelId);
  // mail_thread.py:2425-2427 `_process_attachments_for_post`: the composer's pending uploads move to the channel
  const attWritten: Record<string, Record<string, string[]>> = {};
  await processAttachmentsForPost(env, attachmentIds, 'discuss.channel', channelId, attWritten);
  // mail_thread.py:2256-2449 on the sudo channel (`mail_post_autofollow_author_skip`: no author subscription)
  const body = sanitizeBody(typeof post['body'] === 'string' ? post['body'] : '');
  const [authorId, emailFrom] = await computeAuthor(sudo, null, null);
  const [mid] = await insertMessages(sudo, [{
    model: 'discuss.channel', res_id: channelId, body, author_id: authorId, email_from: emailFrom, message_type: 'comment',
    subtype_id: await xmlid(env, 'mail.mt_comment'), subject: false,
    email_add_signature: post['email_add_signature'] === undefined ? true : Boolean(post['email_add_signature']), record_alias_domain_id: false,
    // `_mail_get_companies(default=env.company)`: a channel has no company; `_notify_get_reply_to` without alias domains
    record_company_id: await env.company(), reply_to: emailFrom, message_id: trackingMessageId(`${channelId}-discuss.channel`),
    attachment_ids: attachmentIds, partner_ids: partnerIds, ...(parentId ? { parent_id: parentId } : {}),
  }]);
  // mail_bot's `_message_post_after_hook` runs first (mail_bot/models/discuss_channel.py:13-15): the user's onboarding
  // state, then each answer posted as OdooBot (`channel.sudo().message_post(author_id=odoobot, silent=True)`): its
  // last interest (the trigger is the request's first, discuss_channel.py:741-744), the message, no seen marker (not
  // the current user's), the web push recipients (the user), and `new_message` with `silent` on the channel's bus
  const botMessages: number[] = [];
  let botWritten: Record<string, Record<string, string[]>> = {};
  if (botChat) {
    const { odoobotAnswers } = await import('./mail_bot');
    const answered = await recordWritten(env, () => odoobotAnswers(env, body));
    botWritten = answered.written;
    for (const answer of answered.out) {
      await queueLastInterest(env, channelId, false);
      const [botAuthor, botFrom] = await computeAuthor(sudo, root, null);
      const [bid] = await insertMessages(sudo, [{
        model: 'discuss.channel', res_id: channelId, body: sanitizeBodyFull(answer), author_id: botAuthor, email_from: botFrom, message_type: 'comment',
        subtype_id: await xmlid(env, 'mail.mt_comment'), subject: false, email_add_signature: true, record_alias_domain_id: false,
        record_company_id: await env.company(), reply_to: botFrom, message_id: trackingMessageId(`${channelId}-discuss.channel`),
      }]);
      if (self.partnerId !== root && (await env.cr.query('SELECT 1 FROM mail_push_device WHERE partner_id = $1 LIMIT 1', [self.partnerId])).rows.length) {
        throw new NotPorted('web push notifications of channel members');
      }
      botMessages.push(bid!);
    }
  }
  // :1450-1455 the author's member: seen (without notification) and its separator after the message
  // the Store version lists the fields whose value the writes changed (an unchanged last_seen_dt of the same second, or
  // write_uid of the same user, is left out: measured on Odoo after a mark_as_read)
  const written = ['seen_message_id', 'new_message_separator', ...(member.last_seen !== member.now_s ? ['last_seen_dt'] : []),
    ...(member.write_uid !== env.uid ? ['write_uid'] : []), 'write_date'];
  const busLast = (await env.cr.query<{ id: number | null }>('SELECT max(id) AS id FROM bus_bus')).rows[0]?.id ?? 0;
  if ((member.seen_message_id ?? 0) >= mid! || member.new_message_separator === mid! + 1) throw new NotPorted('channel post with the member already past the message');
  await env.cr.query(
    `UPDATE discuss_channel_member SET seen_message_id = $2, last_seen_dt = date_trunc('second', now() AT TIME ZONE 'UTC'), new_message_separator = $3,
       write_uid = $4, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1`, [member.id, mid, mid! + 1, env.uid]);
  const version = await storeVersion(env.cr, { ...attWritten, 'discuss.channel.member': { [String(member.id)]: written }, ...botWritten });
  const bus = new BusValues(db);
  const internal = await channelBusIsInternal(env, channel);
  // :1351-1353 the composer's temporary id (thread_model.js:811), with which the client replaces its pending message;
  // OdooBot's answers carry it too (the request's context)
  const temporaryId = env.context['temporary_id'];
  const payloadHead = { id: channelId, ...(pyTruthy(temporaryId) ? { temporary_id: temporaryId } : {}) };
  for (const bid of botMessages) {
    const botStore = new Store();
    await messageFields(env, [bid], botStore);
    const botData = forChannelBus(await botStore.asDict(env.cr), internal);
    botData['__store_version__'] = version;
    bus.sendone({ model: 'discuss.channel', id: channelId }, 'discuss.channel/new_message', { ...payloadHead, silent: true, store_data: botData });
  }
  // bus_sync_mixin.py write: the changed synced fields (the counter counted the new message before) to the user
  bus.sendone({ model: 'res.users', id: env.uid }, 'mail.record/insert', {
    'discuss.channel.member': [{ channel_id: channelId, id: member.id, message_unread_counter: await unreadCount(env, member.id),
      message_unread_counter_bus_id: busLast, new_message_separator: mid! + 1, partner_id: self.partnerId }],
    __store_version__: version,
  });
  // :1216-1332 `_notify_get_recipients`, mail_thread.py:3528-3587 `_notify_thread_by_inbox`: the mentioned partners'
  // inbox notifications and a Store per user (as that user, with the inbox fields)
  const inboxUsers = await mentionInbox(env, mid!, authorId, emailFrom, partnerIds);
  for (const uid of inboxUsers) {
    const userEnv = env.withUser(uid).withContext({ ...env.context, uid, allowed_company_ids: [] });
    const store = new Store();
    await messageFields(userEnv, [mid!], store, true, { inbox: true });
    const data = await store.asDict(env.cr);
    data['__store_version__'] = version;
    bus.sendone({ model: 'res.users', id: uid }, 'mail.message/notification', { message_id: mid, store_data: data });
  }
  // :1348-1363 `_notify_thread`: the message's Store on the channel
  const channelStore = new Store();
  await messageFields(env, [mid!], channelStore);
  const channelData = forChannelBus(await channelStore.asDict(env.cr), internal);
  channelData['__store_version__'] = version;
  bus.sendone({ model: 'discuss.channel', id: channelId }, 'discuss.channel/new_message', { ...payloadHead, store_data: channelData });
  const rows = await bus.create(env.cr, env.uid);
  ctx.afterCommit(async () => {
    await dispatchRows(ctx.env, db, rows);
    await syncLastInterest(ctx.env, db, [channelId], trigger);
  });
  // thread.py:257-259 the answer
  const store = new Store();
  await messageFields(env, [mid!], store, true, { currentUser: true });
  const data = await store.asDict(env.cr);
  data['__store_version__'] = version;
  return { store_data: data, message_id: mid };
}

/**
 * thread.py:217-225 for an internal user (the partners it can read: an unreadable one refuses) and discuss_channel.py
 * :1404-1421 `_get_allowed_message_partner_ids`: in a channel with a group, the partners one of whose active users has
 * the group (implied groups included, `all_group_ids`); in a channel without group all of them; in a chat or group the
 * channel's members (their `discuss.channel.member` order).
 */
async function allowedPartners(env: Environment, channelId: number, channel: { channel_type: string; group_public_id: number | null }, given: number[]): Promise<number[]> {
  if (!given.length) return [];
  const unique = [...new Set(given)];
  const readable = await env.withContext({ ...env.context, active_test: false }).model('res.partner').search(cond('id', 'in', unique));
  if (readable.length !== unique.length) throw new NotPorted('channel post mentioning partners the user cannot read (mention tokens)');
  if (channel.channel_type === 'channel') {
    if (channel.group_public_id === null) return given;
    const ok = new Set((await env.cr.query<{ id: number }>(
      `WITH RECURSIVE g(pid, gid) AS (
         SELECT u.partner_id, r.gid FROM res_users u JOIN res_groups_users_rel r ON r.uid = u.id WHERE u.active AND u.partner_id = ANY($1::int[])
         UNION SELECT g.pid, i.hid FROM g JOIN res_groups_implied_rel i ON i.gid = g.gid)
       SELECT DISTINCT pid AS id FROM g WHERE gid = $2`, [unique, channel.group_public_id])).rows.map((r) => r.id));
    return given.filter((pid) => ok.has(pid));
  }
  // `search_fetch([channel, partner in ids]).partner_id`: the members in the member order (`_order` id)
  return (await env.cr.query<{ partner_id: number }>(
    'SELECT partner_id FROM discuss_channel_member WHERE channel_id = $1 AND partner_id = ANY($2::int[]) ORDER BY id', [channelId, unique])).rows.map((r) => r.partner_id);
}

/**
 * discuss_channel.py:1232-1281 `_notify_get_recipients` for the message's partners: active, not the author, an email
 * different from the author's (a partner without email is left out), each with its first active user (internal first,
 * then by id); internal partners get an inbox notification (mail_thread.py:3539-3562), share partners an email (not
 * ported: refused). Out-of-office answers (mail_thread.py:4626) refuse. Returns the users to send the inbox Store to.
 */
async function mentionInbox(env: Environment, messageId: number, authorId: number | false | null, emailFrom: unknown, partnerIds: readonly number[]): Promise<number[]> {
  if (!partnerIds.length) return [];
  // `email_normalize(message.email_from)`: the author's `formataddr((name, email))` (computeAuthor) normalizes to the
  // author's own address (a formatted or multi-address email refuses in emailNormalize)
  const { emailNormalize } = await import('./message');
  const authorEmail = authorId ? (await env.cr.query<{ email: string | null }>('SELECT email FROM res_partner WHERE id = $1', [authorId])).rows[0]?.email ?? null : null;
  if (typeof emailFrom !== 'string' || !authorId) throw new NotPorted('channel mentions without an author partner');
  const rows = (await env.cr.query<{ id: number; partner_share: boolean | null; uid: number | null }>(
    `SELECT p.id, p.partner_share, u.uid FROM res_partner p
       LEFT JOIN LATERAL (SELECT users.id AS uid FROM res_users users WHERE users.partner_id = p.id AND users.active
                          ORDER BY users.share ASC NULLS FIRST, users.id ASC FETCH FIRST ROW ONLY) u ON TRUE
      WHERE p.active IS TRUE AND p.email != $1 AND p.id = ANY($2::int[]) AND p.id != $3`,
    [emailNormalize(authorEmail) || '', [...partnerIds], authorId])).rows;
  if (rows.some((r) => r.partner_share)) throw new NotPorted('email notifications of share partners mentioned in a channel');
  if (!rows.length) return [];
  const ooo = (await env.cr.query('SELECT 1 FROM res_users WHERE active AND out_of_office_from IS NOT NULL AND partner_id = ANY($1::int[]) LIMIT 1', [rows.map((r) => r.id)])).rows;
  if (ooo.length) throw new NotPorted('out of office answers');
  if ((await env.cr.query('SELECT 1 FROM mail_push_device WHERE partner_id = ANY($1::int[]) LIMIT 1', [rows.map((r) => r.id)])).rows.length) {
    throw new NotPorted('web push notification of inbox recipients with a device');
  }
  const { createInboxNotifications } = await import('./notify');
  return createInboxNotifications(env, messageId, authorId || null, rows.map((r) => r.id).sort((a, b) => a - b));
}

/**
 * discuss_channel.py:710-768 `_update_last_interest_dt` for one channel in a transaction: the queued update and the
 * sync cron's trigger (`ir_cron.py:790-818 `_trigger_list`, one minute ahead: kept also for an inactive cron). Returns
 * the trigger, which `syncLastInterest` deletes after the commit.
 */
export async function queueLastInterest(env: Environment, channelId: number): Promise<number>;
export async function queueLastInterest(env: Environment, channelId: number, trigger: false): Promise<null>;
export async function queueLastInterest(env: Environment, channelId: number, trigger = true): Promise<number | null> {
  const now = (await env.cr.query<{ t: string }>("SELECT to_char(date_trunc('second', now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS') AS t")).rows[0]!.t;
  await env.cr.query('INSERT INTO discuss_channel_last_interest_update (channel_id, last_interest_dt) VALUES ($1, $2)', [channelId, now]);
  if (!trigger) return null;
  const cron = (await env.cr.query<{ id: number; active: boolean }>(
    `SELECT c.id, c.active FROM ir_cron c JOIN ir_model_data d ON d.model = 'ir.cron' AND d.res_id = c.id
      WHERE d.module = 'mail' AND d.name = 'ir_cron_discuss_channel_sync_last_interest_dt'`)).rows[0];
  if (!cron) throw new NotPorted('the last interest sync cron is missing');
  return (await env.cr.query<{ id: number }>(
    `INSERT INTO ir_cron_trigger (cron_id, call_at, create_uid, write_uid, create_date, write_date)
     VALUES ($1, date_trunc('second', now() AT TIME ZONE 'UTC') + interval '1 minute', $2, $2, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC') RETURNING id`,
    [cron.id, env.uid])).rows[0]!.id;
}

/**
 * discuss_channel.py:750-767 the post-commit fast path: a fresh transaction as superuser runs `_sync_last_interest_dt`
 * (:770-799: the lockable channels, their queued updates' maximum when later than the channel's, the queue drained)
 * and deletes the trigger when every channel drained. The channel's write syncs `last_interest_dt` on its bus.
 */
export async function syncLastInterest(worker: Env, db: string, channelIds: readonly number[], trigger: number): Promise<void> {
  const cr = new Cursor(worker, db);
  try {
    const lockable = (await cr.query<{ id: number; last: string | null; write_uid: number | null }>(
      `SELECT id, to_char(last_interest_dt, 'YYYY-MM-DD HH24:MI:SS') AS last, write_uid FROM discuss_channel WHERE id = ANY($1::int[])
        ORDER BY id FOR NO KEY UPDATE SKIP LOCKED`, [[...channelIds]])).rows;
    const pending = (await cr.query<{ id: number; channel_id: number; t: string }>(
      `SELECT id, channel_id, to_char(last_interest_dt, 'YYYY-MM-DD HH24:MI:SS') AS t FROM discuss_channel_last_interest_update
        WHERE channel_id = ANY($1::int[]) ORDER BY id`, [lockable.map((c) => c.id)])).rows;
    const bus = new BusValues(db);
    for (const c of lockable) {
      const max = pending.filter((u) => u.channel_id === c.id).map((u) => u.t).sort().pop();
      if (!max || (c.last !== null && c.last >= max)) continue;
      await cr.query(`UPDATE discuss_channel SET last_interest_dt = $2, write_uid = 1, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1`, [c.id, max]);
      const fields = ['last_interest_dt', ...(c.write_uid !== 1 ? ['write_uid'] : []), 'write_date'];
      bus.sendone({ model: 'discuss.channel', id: c.id }, 'mail.record/insert', {
        'discuss.channel': [{ id: c.id, last_interest_dt: max }],
        __store_version__: await storeVersion(cr, { 'discuss.channel': { [String(c.id)]: fields } }),
      });
    }
    if (pending.length) await cr.query('DELETE FROM discuss_channel_last_interest_update WHERE id = ANY($1::int[])', [pending.map((u) => u.id)]);
    if (lockable.length === channelIds.length) await cr.query('DELETE FROM ir_cron_trigger WHERE id = $1', [trigger]);
    const rows = await bus.create(cr, 1);
    await cr.commit();
    await dispatchRows(worker, db, rows);
  } finally {
    await cr.close();
  }
}
