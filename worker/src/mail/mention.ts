/**
 * `res.partner.get_mention_suggestions(search, limit=8, internal_users_only=False)`
 * (odoo/addons/mail/models/res_partner.py:257-305): partners whose name or email matches, internal users first,
 * then users, then the others, each search through `_search` without an order; Store with `_store_partner_fields`
 * and the mention token, plus the matching roles (:273-277).
 */
import { AccessError, NotPorted } from '../errors';
import { registerMethod } from '../http/methods';
import { and, cond, or } from '../orm/domain';
import { queryIds, searchQuery } from '../orm/sql';
import { limitedFieldAccessToken } from '../models/util';
import { MailBootstrap } from './bootstrap';

registerMethod('res.partner', 'get_mention_suggestions', async (env, _ids, args, kwargs) => {
  const search = kwargs['search'] ?? args[0];
  const limit = Number(kwargs['limit'] ?? args[1] ?? 8);
  const internalOnly = Boolean(kwargs['internal_users_only'] ?? args[2] ?? false);
  if (typeof search !== 'string' || !Number.isInteger(limit)) throw new NotPorted('get_mention_suggestions arguments');
  let domain = and([or([cond('name', 'ilike', search), cond('email', 'ilike', search)]), cond('active', '=', true)]);
  if (internalOnly) domain = and([domain, cond('partner_share', '=', false)]);
  const isUser = and([cond('user_ids', '!=', false), cond('user_ids.active', '=', true), domain]);
  const def = env.reg.model('res.partner');
  const found: number[] = [];
  for (const d of [and([isUser, cond('partner_share', '=', false)]), isUser, domain]) {
    const remaining = limit - found.length;
    if (remaining <= 0) break;
    const ids = await queryIds(await searchQuery(env, def, and([cond('id', 'not in', [...found]), d]), { limit: remaining, order: null }));
    for (const id of ids) if (!found.includes(id)) found.push(id);
  }
  let roles: number[] = [];
  try {
    roles = await env.model('res.role').search(cond('name', 'ilike', search), { limit: 8 });
  } catch (e) {
    if (!(e instanceof AccessError)) throw e; // :276 roles the user cannot read are left out
  }
  const boot = new MailBootstrap(env);
  for (const id of found) {
    await boot.partner(id, true);
    boot.store.add('res.partner', id, { mention_token: await limitedFieldAccessToken(env, 'res.partner', id, 'id', 'mail.message_mention') });
  }
  // :275 roles with name and user_ids_count (res_role.py:23 `_read_group` of the active users per role)
  for (const rid of roles) {
    const row = (await env.cr.query<{ name: string; n: string }>(
      `SELECT r.name, (SELECT count(*) FROM res_role_res_users_rel x JOIN res_users u ON u.id = x.res_users_id
                        WHERE x.res_role_id = r.id AND u.active IS TRUE)::text AS n FROM res_role r WHERE r.id = $1`, [rid])).rows[0]!;
    boot.store.add('res.role', rid, { name: row.name, user_ids_count: Number(row.n) });
  }
  return boot.store.asDict(env.cr);
}, { apiModel: true, readonly: true });

/**
 * `res.partner.get_mention_suggestions_from_channel(channel_id, search, limit=8)`
 * (odoo/addons/mail/models/discuss/res_partner.py:159-205): the mention suggestions of a channel's composer. The
 * channel through the user's search (none: `[]`); partners matching the search that are members of the channel or of
 * its parent, by `_search_mention_suggestions` (:283-305: internal users, users, the others, then the `extra_domain`
 * alone: active internal users, those of the channel's group when it has one); the members of those partners
 * (`_store_identifying_fields`: channel and persona), the partners (`_store_partner_fields`, the mention token), the
 * channel's `group_public_id`, each partner's share of that group (`group_ids` ADD) and the matching roles.
 */
registerMethod('res.partner', 'get_mention_suggestions_from_channel', async (env, _ids, args, kwargs) => {
  const channelArg = kwargs['channel_id'] ?? args[0];
  const search = kwargs['search'] ?? args[1];
  const limit = Number(kwargs['limit'] ?? args[2] ?? 8);
  if (typeof search !== 'string' || !Number.isInteger(limit)) throw new NotPorted('get_mention_suggestions_from_channel arguments');
  const channel = (await env.model('discuss.channel').search(cond('id', '=', channelArg as number)))[0];
  if (channel === undefined) return [];
  const c = (await env.cr.query<{ parent: number | null; grp: number | null }>(
    'SELECT parent_channel_id AS parent, group_public_id AS grp FROM discuss_channel WHERE id = $1', [channel])).rows[0]!;
  // `(channel.parent_channel_id | channel).ids`: the parent first
  const channels = c.parent !== null ? [c.parent, channel] : [channel];
  // `(channel.parent_channel_id or channel).group_public_id`
  const allowedGroup = c.parent !== null
    ? (await env.cr.query<{ grp: number | null }>('SELECT group_public_id AS grp FROM discuss_channel WHERE id = $1', [c.parent])).rows[0]?.grp ?? null
    : c.grp;
  const domain = and([or([cond('name', 'ilike', search), cond('email', 'ilike', search)]), cond('active', '=', true), cond('channel_ids', 'in', channels)]);
  let extra = and([cond('user_ids', '!=', false), cond('user_ids.active', '=', true), cond('partner_share', '=', false)]);
  if (allowedGroup !== null) extra = and([extra, cond('user_ids.all_group_ids', 'in', allowedGroup)]);
  const isUser = and([cond('user_ids', '!=', false), cond('user_ids.active', '=', true), domain]);
  const def = env.reg.model('res.partner');
  const found: number[] = [];
  for (const d of [and([isUser, cond('partner_share', '=', false)]), isUser, domain, extra]) {
    const remaining = limit - found.length;
    if (remaining <= 0) break;
    const ids = await queryIds(await searchQuery(env, def, and([cond('id', 'not in', [...found]), d]), { limit: remaining, order: null }));
    for (const id of ids) if (!found.includes(id)) found.push(id);
  }
  const boot = new MailBootstrap(env);
  // the members of these partners in these channels (discuss.channel.member `_order`: id), `_store_identifying_fields`
  // (the persona relation has no fields: the partners keep the order of the search below)
  const members = found.length
    ? await env.model('discuss.channel.member').search(and([cond('channel_id', 'in', channels), cond('partner_id', 'in', found)]))
    : [];
  if (members.length) {
    const rows = (await env.sudo().cr.query<{ id: number; channel_id: number; partner_id: number | null; guest_id: number | null }>(
      'SELECT id, channel_id, partner_id, guest_id FROM discuss_channel_member WHERE id = ANY($1::int[])', [members])).rows;
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of members) {
      const m = byId.get(id)!;
      if (m.guest_id !== null) throw new NotPorted('mention suggestions with a guest member');
      boot.store.add('discuss.channel.member', id, { channel_id: m.channel_id, ...(m.partner_id !== null ? { partner_id: m.partner_id } : {}) });
    }
  }
  for (const id of found) {
    await boot.partner(id, true);
    boot.store.add('res.partner', id, { mention_token: await limitedFieldAccessToken(env, 'res.partner', id, 'id', 'mail.message_mention') });
  }
  boot.store.add('discuss.channel', channel, { group_public_id: c.grp ?? false });
  if (allowedGroup !== null) {
    // `allowed_group & p.user_ids.all_group_ids`: the group when one of the partner's active users has it, implied included
    for (const id of found) {
      const has = (await env.cr.query(
        `WITH RECURSIVE g(id) AS (SELECT r.gid FROM res_groups_users_rel r JOIN res_users u ON u.id = r.uid WHERE u.partner_id = $1 AND u.active
           UNION SELECT i.hid FROM res_groups_implied_rel i JOIN g ON g.id = i.gid) SELECT 1 FROM g WHERE id = $2`, [id, allowedGroup])).rows.length > 0;
      boot.store.add('res.partner', id, { group_ids: [['ADD', has ? [allowedGroup] : []]] });
    }
  }
  let roles: number[] = [];
  try {
    roles = await env.model('res.role').search(cond('name', 'ilike', search), { limit: 8 });
  } catch (e) {
    if (!(e instanceof AccessError)) throw e;
  }
  for (const rid of roles) {
    const row = (await env.cr.query<{ name: string; n: string }>(
      `SELECT r.name, (SELECT count(*) FROM res_role_res_users_rel x JOIN res_users u ON u.id = x.res_users_id
                        WHERE x.res_role_id = r.id AND u.active IS TRUE)::text AS n FROM res_role r WHERE r.id = $1`, [rid])).rows[0]!;
    boot.store.add('res.role', rid, { name: row.name, user_ids_count: Number(row.n) });
  }
  return boot.store.asDict(env.cr);
}, { apiModel: true, readonly: true });
