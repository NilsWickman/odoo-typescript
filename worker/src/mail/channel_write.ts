/**
 * `discuss.channel.write` (odoo/addons/mail/models/discuss/discuss_channel.py:596-694) and the bus synchronisation
 * of `bus.sync.mixin.write` (mail/models/discuss/bus_sync_mixin.py:26-50) with the channel's `_sync_field_names`
 * (discuss_channel.py:696-707): the fields that changed are sent to the channel's bus as `mail.record/insert`
 * (one Store per bus target; an empty store is skipped, mail/models/discuss/bus.py:12-16).
 *
 * Ported: the value checks of the override that need no further state, and the sync of the scalar fields. Refused
 * (NotPorted): `is_readonly`/`active`/`default_display_mode` changes that need the member role checks, `group_ids`
 * (`_subscribe_users_automatically`), and a change of a synced relation (discuss_category_id, group_ids,
 * group_public_id), whose Store payloads (`_store_category_fields`, `full_name`) are not ported.
 */
import { NotPorted, UserError } from '../errors';
import { requestOfCursor } from '../http/context';
import { fieldOrder } from '../models/base_import';
import { limitedFieldAccessToken } from '../models/util';
import type { Environment } from '../orm/types';
import { userFlags } from '../session/user';
import { registerMethod } from '../http/methods';
import { and, cond, TRUE } from '../orm/domain';
import { MailBootstrap } from './bootstrap';
import { unreadCount } from './channels';
import { Store } from './store';
import { envFor } from '../web/common';
import { hasGroup, userInfo } from '../orm/env';
import { registerOverrides, write as ormWrite } from '../orm/write';
import { unlink as ormUnlink } from '../orm/unlink';
import { create as ormCreate } from '../orm/create';
import { datetimeToString, dbNow } from '../models/util';
import { busSend, type VersionedPayload } from './busnotify';
import { storeVersion } from '../bus/presence';
import { defineComputes } from '../models/tail_util';

// discuss_channel.py:479-484 `_compute_member_count` (compute_sudo): the channel's members, all of them
defineComputes('discuss.channel', {
  // discuss_channel.py:499-507 `_compute_group_public_id`
  group_public_id: async (env, rec) => {
    if ((await rec.get('channel_type')) !== 'channel') return null;
    const parent = await rec.rel('parent_channel_id');
    if (parent) {
      const g = await parent.get('group_public_id');
      return Array.isArray(g) ? g[0] : g || null;
    }
    const prev = await rec.prev('group_public_id');
    if (prev) return Array.isArray(prev) ? prev[0] : prev;
    return env.reg.xmlid(env.cr, 'base.group_user');
  },
  // discuss_channel.py:265-290 `_compute_channel_name_member_ids`: the first 3 members of a group (member-based naming)
  channel_name_member_ids: async (env, rec) => {
    if ((await rec.get('channel_type')) !== 'group') return [];
    if (rec.id === null) throw new NotPorted('channel_name_member_ids of a new group');
    return (await env.cr.query<{ id: number }>('SELECT id FROM discuss_channel_member WHERE channel_id = $1 ORDER BY id LIMIT 3', [rec.id])).rows.map((r) => r.id);
  },
  // discuss_channel.py:249-263 `_compute_display_name`: the name, else the member names (format_list)
  display_name: async (_env, rec) => {
    const name = await rec.get('name');
    if (typeof name === 'string' && name !== '') return name;
    if (rec.id === null && (await rec.rels('channel_name_member_ids')).length === 0) return ''; // format_list([])
    throw new NotPorted('display_name of an unnamed discuss.channel (member names)');
  },
  member_count: async (env, rec) => rec.id === null ? 0
    : Number((await env.cr.query<{ n: string }>('SELECT count(*) AS n FROM discuss_channel_member WHERE channel_id = $1', [rec.id])).rows[0]?.n ?? 0),
});

/** `_sync_field_names` attributes in order, with their predicates (is_channel_or_group / is_channel). */
const SYNC: readonly { name: string; when?: 'channel' | 'channel_or_group'; relation?: true }[] = [
  { name: 'avatar_cache_key' },
  { name: 'avatar_128_access_token' },
  { name: 'discuss_category_id', relation: true },
  { name: 'channel_type' },
  { name: 'create_uid' },
  { name: 'default_display_mode' },
  { name: 'description', when: 'channel_or_group' },
  { name: 'group_ids', when: 'channel', relation: true },
  { name: 'group_public_id', when: 'channel', relation: true },
  { name: 'is_readonly', when: 'channel' },
  { name: 'last_interest_dt' },
  { name: 'member_count' },
  { name: 'name' },
  { name: 'uuid' },
];

type Snapshot = Map<number, Record<string, unknown>>;
const BEFORE = new WeakMap<object, Snapshot>();
const BEFORE_ROWS = new WeakMap<object, Snapshot>();

/** The stored columns written by `vals` and write_uid, as the database holds them. */
async function rowsOf(env: Environment, ids: readonly number[], names: readonly string[]): Promise<Snapshot> {
  const def = env.reg.model('discuss.channel');
  const cols = [...new Set([...names.filter((n) => def.fields.get(n)?.column), 'write_uid'])];
  const rows = (await env.cr.query<Record<string, unknown>>(
    `SELECT id, ${cols.map((c) => `"${c}"`).join(', ')} FROM discuss_channel WHERE id = ANY($1::int[])`, [[...ids]])).rows;
  return new Map(rows.map((r) => [Number(r['id']), r]));
}

async function syncValues(env: Environment, ids: readonly number[]): Promise<Snapshot> {
  const fields = SYNC.map((f) => f.name).filter((n) => n !== 'avatar_128_access_token');
  const rows = await env.model('discuss.channel').read(ids, [...fields, 'channel_type'], '_classic_read');
  const out: Snapshot = new Map();
  for (const row of rows) {
    const id = Number(row['id']);
    const type = row['channel_type'];
    const values: Record<string, unknown> = {};
    for (const f of SYNC) {
      if ((f.when === 'channel' && type !== 'channel') || (f.when === 'channel_or_group' && type !== 'channel' && type !== 'group')) {
        values[f.name] = null;
        continue;
      }
      if (f.name === 'avatar_128_access_token') values[f.name] = await limitedFieldAccessToken(env, 'discuss.channel', id, 'avatar_128', 'binary');
      else {
        const v = row[f.name];
        values[f.name] = Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' ? v[0] : v; // many2one: the id
      }
    }
    out.set(id, values);
  }
  return out;
}

/** discuss_channel.py:1000-1005 `get_invite_partner_domain`, res_partner.py:103-127 `_get_channel_invite_domain`. */
registerMethod('discuss.channel', 'get_invite_partner_domain', async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  if (ids?.length !== 1) throw new NotPorted('get_invite_partner_domain on several channels (Expected singleton)');
  if (!(await userFlags(env.cr, env.uid)).isInternal) throw new NotPorted('get_invite_partner_domain of a non-internal user (AccessError)');
  const group = (await env.cr.query<{ g: number | null }>('SELECT group_public_id AS g FROM discuss_channel WHERE id = $1', [ids[0]])).rows[0]?.g ?? null;
  return [...(group === null ? [] : ['&']), '&', '&', '&', '&', ['active', '=', true], ['user_ids', '!=', false], ['user_ids.active', '=', true], ['user_ids.share', '=', false],
    ['channel_ids', 'not in', ids[0]], ...(group === null ? [] : [['user_ids.all_group_ids', 'in', group]])];
}, { apiModel: false });

/** discuss_channel.py:596-690, the checks before `super().write(vals)`. */
export async function channelBeforeWrite(env: Environment, ids: readonly number[], vals: Record<string, unknown>): Promise<void> {
  const keys = new Set(Object.keys(vals));
  const rows = (await env.cr.query<{ id: number; name: string | null; channel_type: string; is_readonly: boolean | null; parent_channel_id: number | null; member_indices: unknown; active: boolean | null; default_display_mode: string | null }>(
    'SELECT id, name, channel_type, is_readonly, parent_channel_id, member_indices, active, default_display_mode FROM discuss_channel WHERE id = ANY($1::int[]) ORDER BY id', [[...ids]])).rows;
  if (env.lang && env.lang !== 'en_US' && ['channel_type', 'from_message_id', 'parent_channel_id', 'group_public_id'].some((k) => keys.has(k))) {
    throw new NotPorted(`translated discuss.channel write errors (${env.lang})`);
  }
  if (keys.has('channel_type')) {
    const failing = rows.filter((c) => c.channel_type !== vals['channel_type']);
    if (failing.length) throw new UserError(`Cannot change the channel type of: ${failing.map((c) => c.name ?? '').join(', ')}`);
  }
  const isAdmin = env.su || (await userFlags(env.cr, env.uid)).isAdmin;
  if (keys.has('is_readonly') && !isAdmin && rows.some((c) => Boolean(c.is_readonly) !== Boolean(vals['is_readonly']))) {
    throw new NotPorted('discuss.channel is_readonly change by a non-admin (can_self_edit_readonly_channel)');
  }
  if (keys.has('member_indices')) throw new NotPorted('discuss.channel member_indices write');
  if (['name', 'description', 'image_128'].some((k) => keys.has(k)) && !isAdmin && rows.some((c) => c.is_readonly)) {
    throw new NotPorted('discuss.channel edit of a read-only channel by a non-admin (can_self_edit_readonly_channel)');
  }
  if (keys.has('from_message_id') || keys.has('parent_channel_id')) {
    throw new UserError(`Cannot change initial message nor parent channel of: ${rows.map((c) => c.name ?? '').join(', ')}.`);
  }
  if (keys.has('group_public_id')) {
    const failing = rows.filter((c) => c.parent_channel_id !== null);
    if (failing.length) throw new UserError(`Cannot change authorized group of sub-channel: ${failing.map((c) => c.name ?? '').join(', ')}.`);
  }
  if (keys.has('active')) {
    // :662-676 the owner of a channel or group, or a system administrator
    const partner = (await userInfo(env)).partnerId;
    const failing: typeof rows = [];
    for (const c of rows.filter((r) => Boolean(r.active) !== Boolean(vals['active']) && ['channel', 'group'].includes(r.channel_type))) {
      const role = (await env.cr.query<{ r: string | null }>('SELECT channel_role AS r FROM discuss_channel_member WHERE channel_id = $1 AND partner_id = $2', [c.id, partner])).rows[0]?.r;
      if (role !== 'owner' && !env.su && !(await hasGroup(env, 'base.group_system'))) failing.push(c);
    }
    if (failing.length) {
      throw new UserError(`Cannot change the active state of the following channels: ${failing.map((c) => c.name ?? '').join(', ')}. You must be the owner or a system administrator to change it.`);
    }
  }
  if (keys.has('default_display_mode') && !isAdmin && rows.some((c) => (c.default_display_mode ?? false) !== (vals['default_display_mode'] ?? false))) {
    throw new NotPorted('discuss.channel default_display_mode change by a non-admin (member role check)');
  }
  if (vals['group_ids']) throw new NotPorted('discuss.channel group_ids write (_subscribe_users_automatically)');
  BEFORE.set(vals, await syncValues(env, ids));
  BEFORE_ROWS.set(vals, await rowsOf(env, ids, Object.keys(vals)));
}

/** bus_sync_mixin.py:36-50: the changed synced fields of each record, to the record's bus channel. */
export async function channelAfterWrite(env: Environment, ids: readonly number[], vals: Record<string, unknown>): Promise<void> {
  const before = BEFORE.get(vals);
  if (!before) return;
  BEFORE.delete(vals);
  const beforeRows = BEFORE_ROWS.get(vals);
  BEFORE_ROWS.delete(vals);
  const after = await syncValues(env, ids);
  const def0 = env.reg.model('discuss.channel');
  for (const [name, value] of Object.entries(vals)) {
    // a computed field without inverse is only assigned in the cache (models.py write -> Field.write), and the
    // mixin reads that cached value back
    const f = def0.fields.get(name);
    if (f && !f.column && SYNC.some((s) => s.name === name)) for (const v of after.values()) v[name] = value;
  }
  const ctx = requestOfCursor(env.cr);
  const def = env.reg.model('discuss.channel');
  for (const id of ids) {
    const old = before.get(id) ?? {};
    const now = after.get(id) ?? {};
    const changed = SYNC.filter((f) => JSON.stringify(old[f.name] ?? null) !== JSON.stringify(now[f.name] ?? null));
    if (!changed.length) continue;
    // discuss_channel.py:702 `one("discuss_category_id", "_store_category_fields", sudo=True)`, discuss_category.py:45-48
    const rel = changed.find((f) => f.relation && f.name !== 'discuss_category_id');
    if (rel) throw new NotPorted(`discuss.channel bus sync of ${rel.name} (Store relation payload)`);
    if (ctx === null) throw new NotPorted('discuss.channel bus sync outside a request');
    const record: Record<string, unknown> = { id };
    for (const f of changed) record[f.name] = now[f.name] ?? false;
    // Store.as_dict: fields sorted by name; the version marks the fields flushed in this transaction (models.py:29-34
    // `_flush`, in `_fields` order): the written stored fields and the log access columns
    const order = (await fieldOrder(env))['discuss.channel'] ?? [];
    const rowBefore = beforeRows?.get(id) ?? {};
    const rowAfter = (await rowsOf(env, [id], Object.keys(vals))).get(id) ?? {};
    // dirty fields are those whose cache value changed (fields.py Field.write `_filter_not_equal`)
    const written = order.filter((n) => (n in vals && def.fields.get(n)?.column && JSON.stringify(rowBefore[n]) !== JSON.stringify(rowAfter[n]))
      || (n === 'write_uid' && rowBefore['write_uid'] !== env.uid) || n === 'write_date');
    const sorted = Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    const category = changed.some((f) => f.name === 'discuss_category_id') ? now['discuss_category_id'] : null;
    const categories = typeof category === 'number' ? (await env.cr.query<{ id: number; name: string; sequence: number | null }>(
      'SELECT id, name, sequence FROM discuss_category WHERE id = $1', [category])).rows : [];
    const payload = {
      ...(categories.length ? { 'discuss.category': await Promise.all(categories.map(async (c) => ({
        bus_channel_access_token: await limitedFieldAccessToken(env, 'discuss.category', c.id, 'id', 'bus.channel'), id: c.id, name: c.name, sequence: c.sequence ?? false,
      }))) } : {}),
      'discuss.channel': [sorted],
      __store_version__: await storeVersion(env.cr, { 'discuss.channel': Object.fromEntries(ids.map((i) => [String(i), written])) }),
    };
    await busSend(ctx, env, { model: 'discuss.channel', id }, 'mail.record/insert', payload);
  }
}

/**
 * `discuss.channel.channel_join` (discuss_channel.py:1863-1867): the user's member gets `last_interest_dt = now`
 * (synced to the member's bus target by bus_sync_mixin, discuss_channel_member.py:316-325, with
 * `_store_identifying_fields`), and channels the user is not a member of get the user added (`_add_members`, not
 * ported: refused).
 */
registerMethod('discuss.channel', 'channel_join', async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const channels = ids ?? [];
  if ((await userFlags(env.cr, env.uid)).isPublic) throw new NotPorted('channel_join of a guest persona');
  const partner = (await userInfo(env)).partnerId;
  const members = new Map<number, number>();
  for (const id of channels) {
    const m = (await env.cr.query<{ id: number | null }>('SELECT max(id) AS id FROM discuss_channel_member WHERE channel_id = $1 AND partner_id = $2', [id, partner])).rows[0]?.id;
    if (m) members.set(id, m);
  }
  if (channels.some((c) => !members.has(c))) throw new NotPorted('channel_join of a channel the user is not a member of (_add_members)');
  const memberIds = [...new Set(members.values())];
  if (!memberIds.length) return null;
  type Row = { id: number; channel_id: number; partner_id: number | null; guest_id: number | null; last_interest_dt: Date | null; write_uid: number | null };
  const read = async (): Promise<Row[]> => (await env.cr.query<Row>(
    'SELECT id, channel_id, partner_id, guest_id, last_interest_dt, write_uid FROM discuss_channel_member WHERE id = ANY($1::int[]) ORDER BY id', [memberIds])).rows;
  const before = new Map((await read()).map((r) => [r.id, r]));
  const now = datetimeToString(new Date(Math.floor((await dbNow(env)).getTime() / 1000) * 1000));
  await ormWrite(env, 'discuss.channel.member', memberIds, { last_interest_dt: now });
  const ctx = requestOfCursor(env.cr);
  if (ctx === null) throw new NotPorted('discuss.channel.member bus sync outside a request');
  const order = (await fieldOrder(env))['discuss.channel.member'] ?? [];
  for (const row of await read()) {
    const old = before.get(row.id);
    const changed = (old?.last_interest_dt?.getTime() ?? null) !== (row.last_interest_dt?.getTime() ?? null);
    if (!changed) continue;
    if (row.partner_id === null) throw new NotPorted('bus sync of a guest member');
    const user = (await env.cr.query<{ id: number }>('SELECT id FROM res_users WHERE partner_id = $1 AND active ORDER BY share, id LIMIT 1', [row.partner_id])).rows[0];
    if (!user) throw new NotPorted('bus sync of a member without user (partner bus channel)');
    const written = order.filter((n) => n === 'last_interest_dt' || (n === 'write_uid' && old?.write_uid !== env.uid) || n === 'write_date');
    const payload = {
      'discuss.channel.member': [{ channel_id: row.channel_id, id: row.id, last_interest_dt: now, partner_id: row.partner_id }],
      __store_version__: await storeVersion(env.cr, { 'discuss.channel.member': { [String(row.id)]: written } }),
    };
    await busSend(ctx, env, { model: 'res.users', id: user.id }, 'mail.record/insert', payload);
  }
  return null;
}, { apiModel: false });

/**
 * `_store_channel_fields` (discuss_channel.py:1920-2016) for channels of type 'channel' and a store for the current
 * user (`res.is_for_current_user()`): members load lazily (only the self member), no RTC session, no invitation,
 * no parent channel, no initial message. Other channel types and those cases refuse.
 */
export async function storeChannelTypeChannel(env: Environment, store: Store, ids: readonly number[]): Promise<void> {
  const self = await userInfo(env);
  const bus = (await env.cr.query<{ id: number | null }>('SELECT max(id) AS id FROM bus_bus')).rows[0]?.id ?? 0;
  const partners = new MailBootstrap(env, store);
  for (const id of ids) {
    const c = (await env.model('discuss.channel').read([id], ['avatar_cache_key', 'channel_type', 'create_uid', 'default_display_mode', 'description',
      'discuss_category_id', 'from_message_id', 'group_ids', 'group_public_id', 'is_readonly', 'last_interest_dt', 'member_count', 'name',
      'parent_channel_id', 'uuid'], 'web'))[0]!;
    if (c['channel_type'] !== 'channel') throw new NotPorted(`_store_channel_fields of a ${String(c['channel_type'])} channel`);
    if (c['from_message_id'] || c['parent_channel_id']) throw new NotPorted('_store_channel_fields of a sub-channel (parent, from_message_id)');
    const rtc = (await env.cr.query('SELECT 1 FROM discuss_channel_rtc_session WHERE channel_id = $1 LIMIT 1', [id])).rows.length;
    const invited = (await env.cr.query('SELECT 1 FROM discuss_channel_member WHERE channel_id = $1 AND rtc_inviting_session_id IS NOT NULL LIMIT 1', [id])).rows.length;
    if (rtc || invited) throw new NotPorted('_store_channel_fields with RTC sessions or invitations');
    const m2oId = (v: unknown): unknown => (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'string' ? v[0]
      : v && typeof v === 'object' && 'id' in (v as Record<string, unknown>) ? (v as Record<string, unknown>)['id'] : v);
    const categoryId = m2oId(c['discuss_category_id']);
    const groupPublic = m2oId(c['group_public_id']);
    const groupIds = Array.isArray(c['group_ids']) ? (c['group_ids'] as unknown[]).map((g) => Number(m2oId(g))) : [];
    const editable = (await env.sudo().model('discuss.channel').search(and([cond('id', '=', id), (await env.model('discuss.channel').accessDomain('write')) ?? TRUE]))).length > 0;
    const needaction = (await env.cr.query<{ n: string }>(`SELECT count(*)::text n FROM mail_message m JOIN mail_notification n ON n.mail_message_id = m.id
      WHERE m.model = 'discuss.channel' AND m.res_id = $1 AND n.res_partner_id = $2 AND NOT n.is_read`, [id, self.partnerId])).rows[0];
    if (typeof categoryId === 'number') {
      const cat = (await env.sudo().model('discuss.category').read([categoryId], ['name', 'sequence'], 'web'))[0]!;
      store.add('discuss.category', categoryId, { name: cat['name'], sequence: cat['sequence'],
        bus_channel_access_token: await limitedFieldAccessToken(env, 'discuss.category', categoryId, 'id', 'bus.channel') });
    }
    if (typeof groupPublic === 'number') {
      const g = (await env.sudo().model('res.groups').read([groupPublic], ['full_name'], 'web'))[0]!;
      store.add('res.groups', groupPublic, { full_name: g['full_name'] });
    }
    store.add('discuss.channel', id, {
      avatar_128_access_token: await limitedFieldAccessToken(env, 'discuss.channel', id, 'avatar_128', 'binary'),
      avatar_cache_key: c['avatar_cache_key'], channel_type: c['channel_type'], create_uid: m2oId(c['create_uid']),
      default_display_mode: c['default_display_mode'], description: c['description'], discuss_category_id: categoryId ?? false,
      from_message_id: false, group_ids: groupIds, group_public_id: groupPublic ?? false, is_readonly: c['is_readonly'],
      last_interest_dt: c['last_interest_dt'], member_count: c['member_count'], name: c['name'], parent_channel_id: false, uuid: c['uuid'],
      fetchChannelInfoState: 'fetched', is_editable: editable, message_needaction_counter: Number(needaction?.n ?? 0),
      message_needaction_counter_bus_id: bus,
    });
    // the self member (`self_member_id`, the highest member id of the user's partner)
    const m = (await env.cr.query<{ id: number | null }>('SELECT max(id) AS id FROM discuss_channel_member WHERE channel_id = $1 AND partner_id = $2', [id, self.partnerId])).rows[0]?.id;
    if (m) {
      const row = (await env.sudo().model('discuss.channel.member').read([m], ['channel_id', 'channel_role', 'create_date', 'invitation_sent_dt',
        'last_seen_dt', 'seen_message_id', 'partner_id', 'custom_notifications', 'last_interest_dt', 'mute_until_dt', 'new_message_separator',
        'rtc_inviting_session_id', 'unpin_dt'], 'web'))[0]!;
      const flat = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, m2oId(v)]));
      store.add('discuss.channel.member', m, { ...flat, message_unread_counter: await unreadCount(env, m), message_unread_counter_bus_id: bus });
      await partners.partner(self.partnerId, true);
      store.add('res.partner', self.partnerId, { mention_token: await limitedFieldAccessToken(env, 'res.partner', self.partnerId, 'id', 'mail.message_mention') });
    }
  }
}

/** discuss_channel.py:1869-1871 `open_chat_window_action`: a client action inserting the channel in the store. */
registerMethod('discuss.channel', 'open_chat_window_action', async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const store = new Store();
  store.markVersioned();
  const channels = ids ?? [];
  await storeChannelTypeChannel(env, store, channels);
  for (const id of channels) store.add('discuss.channel', id, { open_chat_window: true }); // :2017-2019
  return { params: { store_values: await store.asDict(env.cr), next_action: null }, tag: 'mail.store_insert', type: 'ir.actions.client' };
}, { apiModel: false });

/**
 * `discuss.channel.create` (discuss_channel.py:522-578): the creating user becomes a member (owner of a channel or
 * group), the record is created with `mail_create_nolog`/`mail_create_nosubscribe` (no creation message, no
 * follower), `_subscribe_users_automatically` (group_ids: refused), and the channel goes to the user's bus with
 * `_store_channel_fields`. Explicit members (channel_partner_ids, channel_member_ids) are refused.
 */
registerOverrides('discuss.channel', {
  // discuss_channel.py:590-594 `@api.ondelete _unlink_channel`: "discuss.channel/delete" on each channel's own bus
  // (bus_listener_mixin.py:15-25, `_bus_channels` is the record), in the records' order; the members, messages and
  // followers go as for any mail.thread (the database cascade and src/mail/write_hooks.ts)
  beforeUnlink: async (env, ids) => {
    const ctx = requestOfCursor(env.cr);
    if (ctx === null) throw new NotPorted('discuss.channel unlink outside a request');
    for (const id of ids) await busSend(ctx, env, { model: 'discuss.channel', id }, 'discuss.channel/delete', { id });
  },
  create: async (env, valsList, next) => {
    if (env.context['install_mode']) throw new NotPorted('discuss.channel create in install mode');
    const flags = await userFlags(env.cr, env.uid);
    if (flags.isPublic) throw new NotPorted('discuss.channel create by the public user');
    const self = await userInfo(env);
    for (const vals of valsList) {
      const partnerCmds = vals['channel_partner_ids'];
      const memberCmds = vals['channel_member_ids'];
      if ((Array.isArray(partnerCmds) && partnerCmds.length) || (Array.isArray(memberCmds) && memberCmds.length)) {
        throw new NotPorted('discuss.channel create with explicit members (channel_partner_ids / channel_member_ids)');
      }
      if (vals['group_ids'] && !(Array.isArray(vals['group_ids']) && vals['group_ids'].length === 0)) {
        throw new NotPorted('discuss.channel create with group_ids (_subscribe_users_automatically)');
      }
      delete vals['channel_partner_ids'];
    }
    const types = valsList.map((vals) => (typeof vals['channel_type'] === 'string' ? vals['channel_type'] : 'channel'));
    const ids = await next(env.withContext({ ...env.context, mail_create_nolog: true, mail_create_nosubscribe: true }), valsList);
    // the `channel_member_ids` Command.create of the user, created as superuser (`mail_create_bypass_create_check`,
    // discuss_channel_member.py create: `self = self.sudo()`) right after its channel
    for (let i = 0; i < ids.length; i++) {
      await ormCreate(env.sudo(), 'discuss.channel.member', [{ channel_id: ids[i], partner_id: self.partnerId,
        channel_role: types[i] === 'channel' || types[i] === 'group' ? 'owner' : false }]);
    }
    // Store(bus_channel=self.env.user).add(channels, "_store_channel_fields")
    const ctx = requestOfCursor(env.cr);
    if (ctx === null) throw new NotPorted('discuss.channel create outside a request');
    const store = new Store();
    await storeChannelTypeChannel(env, store, ids);
    const data = await store.asDict(env.cr);
    await busSend(ctx, env, { model: 'res.users', id: env.uid }, 'mail.record/insert', data);
    return ids;
  },
});

/** Store payload helper: `{model: [record]}` with the transaction's version (no written fields). */
/** A Store payload of `data`, its version formatted when the bus row is created: at once, or at the end of
 *  src/mail/busnotify.ts withStoreVersionAtEnd with the fields written until then. */
function versionedPayload(env: Environment, data: Record<string, unknown[]>): VersionedPayload {
  return async (written) => ({ ...data, __store_version__: await storeVersion(env.cr, written) });
}

/** discuss.channel.member `_bus_channels` (discuss_channel_member.py: partner -> its active users, bus res_partner.py:10-12). */
async function memberUsers(env: Environment, member: { partner_id: number | null; guest_id: number | null }): Promise<number[]> {
  if (member.partner_id === null) throw new NotPorted('bus channels of a guest member');
  return (await env.cr.query<{ id: number }>('SELECT id FROM res_users WHERE partner_id = $1 AND active ORDER BY id', [member.partner_id])).rows.map((r) => r.id);
}

/**
 * discuss.channel.member unlink (discuss_channel_member.py:339-370) with `_unlink_notify_channel_left` (:327-337):
 * the members of the sub-channels go first (same unlink), then per member: unfollow the channel and close its chat
 * window on the member's bus; after the DELETE, each channel's store deletes the members and updates member_count.
 */
export async function unlinkMembers(env: Environment, memberIds: readonly number[]): Promise<void> {
  if (!memberIds.length) return;
  const ctx = requestOfCursor(env.cr);
  if (ctx === null) throw new NotPorted('member unlink outside a request');
  type M = { id: number; channel_id: number; partner_id: number | null; guest_id: number | null; channel_type: string };
  const members = (await env.cr.query<M>(`SELECT m.id, m.channel_id, m.partner_id, m.guest_id, c.channel_type FROM discuss_channel_member m
    JOIN discuss_channel c ON c.id = m.channel_id WHERE m.id = ANY($1::int[]) ORDER BY m.id`, [[...memberIds]])).rows;
  const ordered = memberIds.map((id) => members.find((m) => m.id === id)!).filter(Boolean);
  if ((await env.cr.query('SELECT 1 FROM discuss_channel_rtc_session WHERE channel_member_id = ANY($1::int[]) LIMIT 1', [[...memberIds]])).rows.length) {
    throw new NotPorted('member unlink with RTC sessions');
  }
  // sub-channel members of the same persona (search_fetch order: discuss.channel.member _order = 'id')
  const subs: number[] = [];
  for (const m of ordered) {
    const rows = (await env.cr.query<{ id: number }>(`SELECT s.id FROM discuss_channel_member s JOIN discuss_channel c ON c.id = s.channel_id
      WHERE c.parent_channel_id = $1 AND s.partner_id IS NOT DISTINCT FROM $2 AND s.guest_id IS NOT DISTINCT FROM $3 AND NOT (s.id = ANY($4::int[]))
      ORDER BY s.id`, [m.channel_id, m.partner_id, m.guest_id, [...memberIds]])).rows;
    for (const r of rows) if (!subs.includes(r.id)) subs.push(r.id);
  }
  if (subs.length) await unlinkMembers(env, [...subs].sort((a, b) => a - b));
  if (ordered.some((m) => m.channel_type === 'group' || m.channel_type === 'chat')) {
    throw new NotPorted('member unlink in a group or chat (member-based names, leave message)');
  }
  // @api.ondelete _unlink_notify_channel_left (close_chat_window defaults to True)
  if (env.context['close_chat_window'] === false) throw new NotPorted('member unlink without close_chat_window');
  for (const m of ordered) {
    // channel.message_unsubscribe(member.partner_id.ids) (mail_thread.py:4917-4933)
    if (m.partner_id !== null) {
      await env.cr.query("DELETE FROM mail_followers WHERE res_model = 'discuss.channel' AND res_id = $1 AND partner_id = $2", [m.channel_id, m.partner_id]);
    }
    for (const uid of await memberUsers(env, m)) {
      await busSend(ctx, env, { model: 'res.users', id: uid }, 'mail.record/insert', null, 'commit',
        versionedPayload(env, { 'discuss.channel': [{ close_chat_window: true, id: m.channel_id, isLocallyPinned: false }] }));
    }
  }
  await ormUnlink(env, 'discuss.channel.member', ordered.map((m) => m.id));
  // stores[channel].delete(members).add(channel, ["member_count"]), channels in member order
  const channels = [...new Set(ordered.map((m) => m.channel_id))];
  for (const c of channels) {
    const count = Number((await env.cr.query<{ n: string }>('SELECT count(*) AS n FROM discuss_channel_member WHERE channel_id = $1', [c])).rows[0]?.n ?? 0);
    await busSend(ctx, env, { model: 'discuss.channel', id: c }, 'mail.record/insert', null, 'commit', versionedPayload(env, {
      'discuss.channel': [{ id: c, member_count: count }],
      'discuss.channel.member': ordered.filter((m) => m.channel_id === c).map((m) => ({ _DELETE: true, id: m.id })),
    }));
  }
}

/** discuss_channel.py:858-872 `action_unfollow`. */
registerMethod('discuss.channel', 'action_unfollow', async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const channels = ids ?? [];
  if (channels.length !== 1) throw new NotPorted('action_unfollow on several channels (ensure_one through self_member_id)');
  const id = channels[0]!;
  const type = (await env.cr.query<{ channel_type: string }>('SELECT channel_type FROM discuss_channel WHERE id = $1', [id])).rows[0]?.channel_type;
  if ((await userFlags(env.cr, env.uid)).isPublic) throw new NotPorted('action_unfollow of a guest');
  const partner = (await userInfo(env)).partnerId;
  const member = (await env.cr.query<{ id: number | null }>('SELECT max(id) AS id FROM discuss_channel_member WHERE channel_id = $1 AND partner_id = $2', [id, partner])).rows[0]?.id ?? null;
  if (type !== 'channel' && type !== 'group') throw new NotPorted('action_unfollow of a chat (unpin_dt)');
  if (member === null) throw new NotPorted('action_unfollow without membership (close_chat_window store)');
  // post_leave_message only applies to non-'channel' types (refused in unlinkMembers)
  await unlinkMembers(env, [member]);
  return null;
}, { apiModel: false });
