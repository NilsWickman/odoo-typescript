/**
 * The cron job "Mail: End polls" (odoo/addons/mail/models/mail_poll.py:61-65 `_end_expired_polls`): the polls whose end
 * date passed and that have no end message get `_end_and_notify` (:48-59): their end date set to now, then per poll an
 * empty comment posted on the poll's thread with `mail_end_poll` in the context (mail_thread.py:2458-2460 links it as
 * the poll's end message), and the poll's fields on the thread's bus.
 *
 * The post is discuss_channel.py:1423-1448 `message_post` -> mail_thread.py `message_post` as the cron user, OdooBot,
 * who is not a member: `_update_last_interest_dt` (:710-768, the queued update, the sync cron's trigger and the
 * post-commit sync), no author subscription (`mail_post_autofollow_author_skip`), no member to mark as seen
 * (:1450-1454), mail_bot's hook skipped for OdooBot's own message (mail_bot.py:26), and `_notify_thread` (:1348-1363)
 * with the members as web push recipients (:1216-1332) then `discuss.channel/new_message` on the channel's bus.
 *
 * Refused before anything is written: polls on other threads than channels, a sub-channel, members with push devices,
 * a cron user other than the superuser, record alias domains.
 */
import type { Env } from '../env';
import { NotPorted } from '../errors';
import type { Environment } from '../orm/types';
import { BusValues, dispatchRows } from '../bus/bus';
import { storeVersion } from '../bus/presence';
import { computeAuthor, insertMessages, trackingMessageId, xmlid } from './message';
import { messageFields } from './thread';
import { Store } from './store';
import { addPollFields } from './poll_store';
import { channelBusIsInternal, forChannelBus, syncLastInterest } from './channel_post';

interface Due { id: number; start_message_id: number; write_uid: number | null; model: string | null; res_id: number | null }
interface Channel { id: number; channel_type: string; group_public_id: number | null; parent_channel_id: number | null }

export async function endExpiredPolls(env: Environment, worker: Env): Promise<void> {
  // :63-65 search_fetch([("poll_end_dt", "<=", "now"), ("end_message_id", "=", None)]) (mail.poll has no _order: id)
  const polls = (await env.cr.query<Due>(
    `SELECT p.id, p.start_message_id, p.write_uid, m.model, m.res_id FROM mail_poll p JOIN mail_message m ON m.id = p.start_message_id
      WHERE p.poll_end_dt <= date_trunc('second', now() AT TIME ZONE 'UTC') AND p.end_message_id IS NULL ORDER BY p.id`)).rows;
  if (!polls.length) return;
  if (env.uid !== 1 || !env.su) throw new NotPorted('ending polls as another user than the superuser (author, member and access)');
  const channels = new Map<number, Channel>();
  for (const p of polls) {
    // `_record_by_message`: the start message's document
    if (p.model !== 'discuss.channel' || !p.res_id) throw new NotPorted(`ending a poll posted on ${p.model ?? 'no thread'}`);
    if (channels.has(p.res_id)) continue;
    const c = (await env.cr.query<Channel>('SELECT id, channel_type, group_public_id, parent_channel_id FROM discuss_channel WHERE id = $1', [p.res_id])).rows[0];
    if (!c) throw new NotPorted('ending a poll of a deleted channel');
    if (c.parent_channel_id) throw new NotPorted('ending a poll in a sub-channel (message_count in the Store)');
    // :1216-1332 / mail_thread `_notify_thread_by_web_push`: the members' devices
    if ((await env.cr.query(
      `SELECT 1 FROM discuss_channel_member mb JOIN mail_push_device d ON d.partner_id = mb.partner_id WHERE mb.channel_id = $1 LIMIT 1`, [c.id])).rows.length) {
      throw new NotPorted('web push notifications of channel members');
    }
    channels.set(c.id, c);
  }
  if ((await env.cr.query('SELECT 1 FROM res_company WHERE id = $1 AND alias_domain_id IS NOT NULL', [await env.company()])).rows.length) {
    throw new NotPorted('record alias domains (_mail_get_alias_domains)');
  }
  // :52 `self.poll_end_dt = fields.Datetime.now()` (to the second), flushed with the end message below
  await env.cr.query(
    `UPDATE mail_poll SET poll_end_dt = date_trunc('second', now() AT TIME ZONE 'UTC'), write_uid = $2, write_date = now() AT TIME ZONE 'UTC'
      WHERE id = ANY($1::int[])`, [polls.map((p) => p.id), env.uid]);
  const sudo = env.sudo();
  const [authorId, emailFrom] = await computeAuthor(sudo, null, null);
  const comment = await xmlid(env, 'mail.mt_comment');
  // the bus Stores in their creation order (the post's new_message, then the thread's Store at its first use);
  // their content is serialized at the end of the transaction, as Odoo's bus precommit does
  const stores: { channel: Channel; type: 'new_message' | 'insert'; store: Store; message?: number; polls: number[] }[] = [];
  const pollStores = new Map<number, (typeof stores)[number]>();
  let trigger: number | null = null;
  const synced: number[] = [];
  for (const p of polls) {
    const channel = channels.get(p.res_id!)!;
    // :1424-1425 `_update_last_interest_dt` (:736-768): the queued update; the trigger and the post-commit sync once
    // per transaction (`cr.postcommit.data["mail.sync_last_interest_dt"]`)
    await env.cr.query(
      `INSERT INTO discuss_channel_last_interest_update (channel_id, last_interest_dt) VALUES ($1, date_trunc('second', now() AT TIME ZONE 'UTC'))`, [channel.id]);
    if (trigger === null) {
      const cron = (await env.cr.query<{ id: number }>(
        `SELECT c.id FROM ir_cron c JOIN ir_model_data d ON d.model = 'ir.cron' AND d.res_id = c.id
          WHERE d.module = 'mail' AND d.name = 'ir_cron_discuss_channel_sync_last_interest_dt'`)).rows[0];
      if (!cron) throw new NotPorted('the last interest sync cron is missing');
      // ir_cron.py `_trigger(at=now + 1 minute)` as superuser
      trigger = (await env.cr.query<{ id: number }>(
        `INSERT INTO ir_cron_trigger (cron_id, call_at, create_uid, write_uid, create_date, write_date)
         VALUES ($1, date_trunc('second', now() AT TIME ZONE 'UTC') + interval '1 minute', $2, $2, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC') RETURNING id`,
        [cron.id, env.uid])).rows[0]!.id;
      const t = trigger, db = env.cr.db;
      env.cr.postcommit.push(() => syncLastInterest(worker, db, synced, t));
    }
    if (!synced.includes(channel.id)) synced.push(channel.id);
    // mail_thread.py:2256-2449 on the channel: an empty comment of the cron user (OdooBot)
    const [mid] = await insertMessages(sudo, [{
      model: 'discuss.channel', res_id: channel.id, body: '', author_id: authorId, email_from: emailFrom, message_type: 'comment',
      subtype_id: comment, subject: false, email_add_signature: true, record_alias_domain_id: false,
      record_company_id: await env.company(), reply_to: emailFrom, message_id: trackingMessageId(`${channel.id}-discuss.channel`),
    }]);
    // mail_thread.py:2458-2460 `_message_post_after_hook`: the poll's end message
    await env.cr.query('UPDATE mail_poll SET end_message_id = $2 WHERE id = $1', [p.id, mid]);
    stores.push({ channel, type: 'new_message', store: new Store(), message: mid!, polls: [] });
    // :58 `stores[thread._store_target()].add(poll, "_store_poll_fields")`
    let ps = pollStores.get(channel.id);
    if (!ps) { ps = { channel, type: 'insert', store: new Store(), polls: [] }; pollStores.set(channel.id, ps); stores.push(ps); }
    ps.polls.push(p.id);
  }
  // the content of each Store, now that every write is done
  for (const s of stores) {
    if (s.message !== undefined) await messageFields(env, [s.message], s.store, true);
    for (const poll of s.polls) await addPollFields(env, s.store, [poll], true, (start) => messageFields(env, [start], s.store, true));
  }
  // the version: the polls' fields the run changed (a flushed write, in the model's field order)
  const written: Record<string, Record<string, string[]>> = { 'mail.poll': {} };
  for (const p of polls) written['mail.poll']![String(p.id)] = ['end_message_id', 'poll_end_dt', ...(p.write_uid !== env.uid ? ['write_uid'] : []), 'write_date'];
  const version = await storeVersion(env.cr, written);
  const bus = new BusValues(env.cr.db);
  for (const s of stores) {
    const data = forChannelBus(await s.store.asDict(env.cr), await channelBusIsInternal(env, s.channel));
    data['__store_version__'] = version;
    if (s.type === 'new_message') bus.sendone({ model: 'discuss.channel', id: s.channel.id }, 'discuss.channel/new_message', { id: s.channel.id, store_data: data });
    else bus.sendone({ model: 'discuss.channel', id: s.channel.id }, 'mail.record/insert', data);
  }
  const rows = await bus.create(env.cr, env.uid);
  // the bus rows before the last interest sync (both post-commit; the sync runs in its own transaction)
  env.cr.postcommit.unshift(() => dispatchRows(worker, env.cr.db, rows));
}
