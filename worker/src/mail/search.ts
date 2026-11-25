/**
 * `/discuss/search` (odoo/addons/mail/controllers/discuss/search.py): the channels whose name matches (favorites of
 * the user first, then the user's channels, then any readable channel, chats excluded), each step a `_search` without
 * an order, then `res.partner._search_for_channel_invite` without a channel (models/discuss/res_partner.py:103-157).
 */
import { NotPorted } from '../errors';
import { jsonRoute } from '../http/router';
import { and, cond, or } from '../orm/domain';
import { userInfo } from '../orm/env';
import { queryIds, searchQuery } from '../orm/sql';
import type { Environment } from '../orm/types';
import { userFlags } from '../session/user';
import { MailBootstrap } from './bootstrap';
import { storeChannels } from './channels';
import { Store } from './store';

/** discuss_channel.py:1843-1847 `_member_based_naming_channel_types` (no installed module extends it). */
const MEMBER_BASED_NAMING = ['group'];

jsonRoute('/discuss/search', async (ctx) => {
  const p = ctx.jsonParams ?? {};
  const term = p['term'];
  const limit = p['limit'] === undefined ? 10 : Number(p['limit']);
  if (typeof term !== 'string' || !Number.isInteger(limit)) throw new NotPorted('/discuss/search parameters');
  const env = await ctx.orm();
  if (env.context['guest'] || (await userFlags(env.cr, env.uid)).isPublic) throw new NotPorted('/discuss/search for guests or the public user');
  const self = await userInfo(env);
  const nameIlike = cond('name', 'ilike', term);
  let nameForMembers = nameIlike;
  if (term) {
    // search.py:16-30: groups without a name match on their members' names (partner or guest)
    nameForMembers = or([nameIlike, and([
      cond('channel_member_ids', 'any', or([cond('partner_id.name', 'ilike', term), cond('guest_id.name', 'ilike', term)])),
      cond('channel_type', 'in', MEMBER_BASED_NAMING), cond('name', '=', false)])]);
  }
  const notChat = cond('channel_type', '!=', 'chat');
  // `self_member_id.is_favorite`: self_member_id searches as channel_member_ids any is_self (discuss_channel.py:435-440)
  const favorite = cond('channel_member_ids', 'any', and([cond('partner_id', '=', self.partnerId), cond('is_favorite', '=', true)]));
  const priority = [and([nameForMembers, notChat, favorite]), and([nameForMembers, notChat, cond('is_member', '=', true)]), and([nameIlike, notChat])];
  const channelDef = env.reg.model('discuss.channel');
  const channels: number[] = [];
  for (const d of priority) {
    const remaining = limit - channels.length;
    if (remaining <= 0) break;
    const ids = await queryIds(await searchQuery(env, channelDef, and([cond('id', 'not in', [...channels]), d]), { limit: remaining, order: null }));
    for (const id of ids) if (!channels.includes(id)) channels.push(id);
  }
  const store = new Store();
  // search.py:53: `_store_channel_fields`, then the user's members with `is_favorite` (storeChannels adds both)
  if (channels.length) await storeChannels(env, store, channels);
  await searchForChannelInvite(env, store, term, limit, self.partnerId);
  return store.asDict(env.cr);
}, { auth: 'public' });

/** res_partner.py:131-157 `_search_for_channel_invite` without a channel or portal users: internal users' active
 *  partners matching name or email, the user's own excepted, `limit + 1` by name, with `_store_partner_fields`
 *  (im_livechat's `_store_channel_invite_fields` adds nothing outside a livechat channel). */
async function searchForChannelInvite(env: Environment, store: Store, term: string, limit: number, selfPartner: number): Promise<number[]> {
  const domain = and([cond('active', '=', true), cond('user_ids', '!=', false), cond('user_ids.active', '=', true), cond('user_ids.share', '=', false),
    or([cond('name', 'ilike', term), cond('email', 'ilike', term)]), cond('id', '!=', selfPartner)]);
  const ids = await env.model('res.partner').search(domain, { limit: limit + 1, order: 'name, id' });
  const boot = new MailBootstrap(env, store);
  for (const id of ids) await boot.partner(id, true);
  return ids;
}
