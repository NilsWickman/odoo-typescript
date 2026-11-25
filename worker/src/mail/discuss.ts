/**
 * `/discuss/channel/mark_as_read` (odoo/addons/mail/controllers/discuss/channel.py:222;
 * models/discuss/discuss_channel_member.py `_mark_as_read` :754, `_set_last_seen_message` :777,
 * `_set_new_message_separator` :799), with the bus notifications Odoo sends when both the seen message and the
 * separator move (the usual case): the seen state to the chat channel and its internal_users subchannel, the synced
 * member fields (`_sync_field_names` :316) to the user. Other transitions refuse rather than miss notifications.
 */
import { NotPorted } from '../errors';
import { jsonRoute } from '../http/router';
import { userInfo } from '../orm/env';
import { userFlags } from '../session/user';
import type { RequestContext } from '../http/context';
import type { Environment } from '../orm/types';
import { BusValues, dispatchRows } from '../bus/bus';
import { storeVersion } from '../bus/presence';
import { limitedFieldAccessToken } from '../models/util';
import { MailBootstrap } from './bootstrap';
import { Store } from './store';
import { unreadCount } from './channels';

jsonRoute('/discuss/channel/mark_as_read', async ctx => {
  const p = ctx.jsonParams ?? {};
  const env = await ctx.orm();
  if (env.context['guest'] || (await userFlags(env.cr, env.uid)).isPublic) throw new NotPorted('mark_as_read of guests');
  const channelId = Number(p['channel_id']), lastId = Number(p['last_message_id']);
  if (!Number.isInteger(channelId) || !Number.isInteger(lastId)) throw new NotPorted('mark_as_read parameters');
  const self = await userInfo(env);
  // ("channel_id", "=", channel_id), ("is_self", "=", True), through the member access rules (own memberships)
  const member = (await env.cr.query<{ id: number; invitation_sent_dt: string | null; seen_message_id: number | null; new_message_separator: number | null }>(
    `SELECT id, invitation_sent_dt::text, seen_message_id, new_message_separator FROM discuss_channel_member
      WHERE channel_id = $1 AND partner_id = $2`, [channelId, self.partnerId])).rows[0];
  if (!member) return null; // channel.py:228-229: the member left meanwhile
  const sets: string[] = [];
  const writtenFields: string[] = [];
  let seenMoved = false;
  if (member.invitation_sent_dt) {
    sets.push('invitation_sent_dt = NULL'); // :762-764
    writtenFields.push('invitation_sent_dt');
  }
  // :765-772 the last message of the channel up to last_message_id, as the user may read them (a member)
  const last = (await env.cr.query<{ id: number }>(
    `SELECT id FROM mail_message WHERE model = 'discuss.channel' AND res_id = $1 AND id <= $2 ORDER BY id DESC LIMIT 1`, [channelId, lastId])).rows[0];
  let effectiveSeen: number | false = member.seen_message_id ?? false;
  if (last) {
    if ((member.seen_message_id ?? 0) < last.id) {
      sets.push(`seen_message_id = ${last.id}`, `last_seen_dt = date_trunc('second', now() AT TIME ZONE 'UTC')`);
      writtenFields.push('seen_message_id');
      seenMoved = true;
      effectiveSeen = last.id;
    }
    const separator = Math.max(member.new_message_separator ?? 0, last.id + 1);
    if (separator !== member.new_message_separator) {
      sets.push(`new_message_separator = ${separator}`);
      writtenFields.push('new_message_separator');
    }
    if (seenMoved) writtenFields.push('last_seen_dt');
  }
  if (!sets.length) {
    // :794-797 / :805-817: nothing written, but the seen fields and the counter still go to the member's user
    if (last) await notifyUnchanged(ctx, env, channelId, member.id, self.partnerId, member.seen_message_id ?? false, member.new_message_separator ?? 0);
    return null;
  }
  writtenFields.push('write_uid', 'write_date');
  await env.cr.query(`UPDATE discuss_channel_member SET ${sets.join(', ')}, write_uid = $2, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1`, [member.id, env.uid]);
  if (last) await notifyRead(ctx, env, channelId, member.id, self.partnerId, effectiveSeen, seenMoved, writtenFields);
  return null;
}, { auth: 'public' });

async function notifyRead(
  ctx: RequestContext, env: Environment, channelId: number, memberId: number, partnerId: number,
  seenId: number | false, seenMoved: boolean, writtenFields: readonly string[],
): Promise<void> {
  const db = ctx.db;
  if (db === null) return;
  const channel = (await env.cr.query<{ channel_type: string }>('SELECT channel_type FROM discuss_channel WHERE id = $1', [channelId])).rows[0]!;
  const busLast = (await env.cr.query<{ id: number | null }>('SELECT max(id) AS id FROM bus_bus')).rows[0]?.id ?? 0;
  const separator = (await env.cr.query<{ n: number }>('SELECT new_message_separator AS n FROM discuss_channel_member WHERE id = $1', [memberId])).rows[0]!.n;
  // written fields of the writes, in the order Odoo's StoreVersion reports them
  const version = await storeVersion(env.cr, { 'discuss.channel.member': { [String(memberId)]: [...writtenFields] } });
  const seen = new Store();
  const boot = new MailBootstrap(env, seen);
  seen.add('discuss.channel.member', memberId, { channel_id: channelId, partner_id: partnerId, seen_message_id: seenId });
  await boot.avatar(partnerId);
  seen.add('res.partner', partnerId, { mention_token: await limitedFieldAccessToken(env, 'res.partner', partnerId, 'id', 'mail.message_mention') });
  const broadcastSeen = seenMoved && (channel.channel_type === 'chat' || channel.channel_type === 'group');
  if (!broadcastSeen) await boot.status(env.uid);
  const seenData = await seen.asDict(env.cr);
  seenData['__store_version__'] = version;
  // :316-334 synced member fields to the member's user
  const unread = await unreadCount(env, memberId);
  const sync = { 'discuss.channel.member': [{ channel_id: channelId, id: memberId, message_unread_counter: unread, message_unread_counter_bus_id: busLast,
    new_message_separator: separator, partner_id: partnerId }], __store_version__: version };
  const bus = new BusValues(db);
  if (broadcastSeen) {
    // tools/discuss.py:239-240 the internal-only fields (im_status) on the internal_users subchannel
    const internal = new Store();
    await new MailBootstrap(env, internal).status(env.uid);
    const internalData = await internal.asDict(env.cr);
    internalData['__store_version__'] = version;
    bus.sendone({ model: 'discuss.channel', id: channelId }, 'mail.record/insert', seenData);
    bus.sendone({ model: 'discuss.channel', id: channelId, sub: 'internal_users' }, 'mail.record/insert', internalData);
  } else {
    bus.sendone({ model: 'res.users', id: env.uid }, 'mail.record/insert', seenData);
  }
  bus.sendone({ model: 'res.users', id: env.uid }, 'mail.record/insert', sync);
  const rows = await bus.create(env.cr, env.uid);
  ctx.afterCommit(() => dispatchRows(ctx.env, db, rows));
}

async function notifyUnchanged(ctx: RequestContext, env: Environment, channelId: number, memberId: number, partnerId: number, seenId: number | false, separator: number): Promise<void> {
  const db = ctx.db;
  if (db === null) return;
  const busLast = (await env.cr.query<{ id: number | null }>('SELECT max(id) AS id FROM bus_bus')).rows[0]?.id ?? 0;
  const version = await storeVersion(env.cr, {});
  // the member's own bus channel (its partner's user): seen fields with the internal fields in the same store
  const seen = new Store();
  const boot = new MailBootstrap(env, seen);
  seen.add('discuss.channel.member', memberId, { channel_id: channelId, partner_id: partnerId, seen_message_id: seenId });
  await boot.avatar(partnerId);
  seen.add('res.partner', partnerId, { mention_token: await limitedFieldAccessToken(env, 'res.partner', partnerId, 'id', 'mail.message_mention') });
  await boot.status(env.uid);
  const seenData = await seen.asDict(env.cr);
  seenData['__store_version__'] = version;
  const unread = await unreadCount(env, memberId);
  const counter = { 'discuss.channel.member': [{ channel_id: channelId, id: memberId, message_unread_counter: unread, message_unread_counter_bus_id: busLast,
    new_message_separator: separator, partner_id: partnerId }], __store_version__: version };
  const bus = new BusValues(db);
  bus.sendone({ model: 'res.users', id: env.uid }, 'mail.record/insert', seenData);
  bus.sendone({ model: 'res.users', id: env.uid }, 'mail.record/insert', counter);
  const rows = await bus.create(env.cr, env.uid);
  ctx.afterCommit(() => dispatchRows(ctx.env, db, rows));
}
