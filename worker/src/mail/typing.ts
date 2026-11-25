/**
 * `/discuss/channel/notify_typing` (odoo/addons/mail/controllers/discuss/channel.py:242-253), which the Discuss composer
 * calls on every keystroke: discuss_channel_member.py:402-414 `_notify_typing`, the member's Store
 * (`_store_member_fields`, `isTyping`, `is_typing_dt`) on the channel's bus. A channel whose bus is not for internal
 * users only (tools/discuss.py:909-933) gets the internal fields (the partner's email, tz and im status, its users'
 * im status) on its `internal_users` subchannel (:239-240). A missing or unreadable channel answers nothing; a non-member
 * starting to type would become a member (`_find_or_create_member_for_self`, not ported: refused).
 */
import { NotPorted } from '../errors';
import { jsonRoute } from '../http/router';
import { userInfo } from '../orm/env';
import { userFlags } from '../session/user';
import { cond } from '../orm/domain';
import { BusValues, dispatchRows } from '../bus/bus';
import { storeVersion } from '../bus/presence';
import { MailBootstrap } from './bootstrap';
import { Store } from './store';
import { storeMember } from './channels';
import { channelBusIsInternal } from './channel_post';

type Row = Record<string, unknown>;

jsonRoute('/discuss/channel/notify_typing', async ctx => {
  const p = ctx.jsonParams ?? {};
  const env = await ctx.orm();
  const db = ctx.db;
  if (db === null) throw new NotPorted('notify_typing without a database');
  if (!(await userFlags(env.cr, env.uid)).isInternal) throw new NotPorted('notify_typing of non-internal users');
  const channelId = Number(p['channel_id']);
  const isTyping = Boolean(p['is_typing']);
  if (!Number.isInteger(channelId) || !(await env.model('discuss.channel').search(cond('id', '=', channelId))).length) return null;
  const self = await userInfo(env);
  const member = (await env.cr.query<{ id: number }>('SELECT id FROM discuss_channel_member WHERE channel_id = $1 AND partner_id = $2', [channelId, self.partnerId])).rows[0];
  if (!member) {
    if (isTyping) throw new NotPorted('notify_typing of a non-member (_find_or_create_member_for_self)');
    return null;
  }
  const now = (await env.cr.query<{ t: string }>(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS t`)).rows[0]!.t;
  const store = new Store();
  await storeMember(env, store, new MailBootstrap(env, store), { id: member.id, partner_id: self.partnerId });
  store.add('discuss.channel.member', member.id, { isTyping, is_typing_dt: now });
  const data: Record<string, unknown> = await store.asDict(env.cr);
  const version = await storeVersion(env.cr, {});
  const channel = (await env.cr.query<{ channel_type: string; group_public_id: number | null }>('SELECT channel_type, group_public_id FROM discuss_channel WHERE id = $1', [channelId])).rows[0]!;
  const bus = new BusValues(db);
  if (await channelBusIsInternal(env, channel)) {
    data['__store_version__'] = version;
    bus.sendone({ model: 'discuss.channel', id: channelId }, 'mail.record/insert', data);
  } else {
    // res_partner.py:250-255 `_store_partner_fields`: im status (the users' `_store_im_status_fields`), email and tz
    // are internal; res_users.py:487-493 the main user's own fields stay
    const main: Record<string, unknown> = {}, internal: Record<string, unknown> = {};
    for (const [model, rows] of Object.entries(data)) {
      if (!Array.isArray(rows)) { main[model] = rows; continue; }
      const m: Row[] = [], i: Row[] = [];
      for (const r of rows as Row[]) {
        const keep: Row = {}, move: Row = { id: r['id'] };
        for (const [k, v] of Object.entries(r)) {
          const isInternal = (model === 'res.partner' && ['email', 'tz', 'user_ids'].includes(k))
            || (model === 'res.users' && ['im_status', 'im_status_access_token'].includes(k));
          if (isInternal) move[k] = v; else keep[k] = v;
        }
        if (model === 'res.users' && Object.keys(move).length > 1) move['partner_id'] = r['partner_id'];
        if (Object.keys(keep).length > 1 || !(model === 'res.users' && Object.keys(move).length > 1)) m.push(keep);
        if (Object.keys(move).length > 1) i.push(move);
      }
      if (m.length) main[model] = m;
      if (i.length) internal[model] = i;
    }
    main['__store_version__'] = version;
    internal['__store_version__'] = version;
    bus.sendone({ model: 'discuss.channel', id: channelId }, 'mail.record/insert', main);
    bus.sendone({ model: 'discuss.channel', id: channelId, sub: 'internal_users' }, 'mail.record/insert', internal);
  }
  const rows = await bus.create(env.cr, env.uid);
  ctx.afterCommit(() => dispatchRows(ctx.env, db, rows));
  return null;
}, { auth: 'public' });
