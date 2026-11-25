/**
 * Chatter actions of the internal user on partner threads and the generic thread models (src/mail/thread_generic.ts):
 *  - `/mail/thread/subscribe`, `/mail/thread/unsubscribe` (odoo/addons/mail/controllers/thread.py:283-298;
 *    mail_thread.py `message_subscribe` :4862, `message_unsubscribe` :4917);
 *  - `/mail/message/reaction` (controllers/message_reaction.py:11; mail_message.py `_message_reaction` :1074).
 * Subscribing sends no bus notification in Odoo; a reaction sends its group to the user's bus channel.
 */
import { HttpError, NotPorted } from '../errors';
import { jsonRoute } from '../http/router';
import type { Environment } from '../orm/types';
import { userInfo } from '../orm/env';
import { userFlags } from '../session/user';
import { Store } from './store';
import { checkThread, permission, reactionGroups, threadFields } from './thread';
import { deleteFollowers, messageSubscribe } from './followers';
import { checkGenericThread, genericThreadFields, forEachGenericThread, isGenericThread, permissionOn, postAccessOf } from './thread_generic';
import { registerMethod } from '../http/methods';
import { envFor } from '../web/common';
import { and, cond } from '../orm/domain';
import { busSend } from './busnotify';

const notFound = (): HttpError => new HttpError(404, '');

function ids(v: unknown): number[] {
  if (!Array.isArray(v) || !v.every(x => Number.isInteger(x))) throw new NotPorted('partner_ids that are not a list of ints');
  return v as number[];
}

// project_task.py:510 and project_project.py:821-845 override message_subscribe/unsubscribe (subscribing the
// project's tasks, the task's project followers): not ported
const OWN_SUBSCRIBE = new Set(['project.task', 'project.project']);

async function followThread(env: Environment, model: unknown, id: unknown, subscribeWithoutSubtypes = false): Promise<[string, number]> {
  if (typeof model !== 'string' || !Number.isInteger(id)) throw new NotPorted(`follow actions on ${String(model)}`);
  // project_project.py:821-837: without subtype_ids the project's message_subscribe is mail.thread's (the tasks follow
  // only for given subtypes); the route subscribes without them (thread.py:289-298)
  if (OWN_SUBSCRIBE.has(model) && !(subscribeWithoutSubtypes && model === 'project.project')) throw new NotPorted(`message_subscribe override of ${model}`);
  if (model !== 'res.partner' && !isGenericThread(model)) throw new NotPorted(`follow actions on ${model}`);
  return [model, Number(id)];
}

/** `check_access(operation)` where the port's own check found no access: Odoo's AccessError, never a silent pass. */
async function raiseAccess(env: Environment, model: string, id: number, operation: 'read' | 'write'): Promise<never> {
  await env.model(model).checkAccess([id], operation);
  throw new NotPorted(`${model} ${operation} access: the thread check and check_access disagree`);
}

const readable = (env: Environment, model: string, id: number): Promise<boolean> =>
  model === 'res.partner' ? checkThread(env, model, id) : checkGenericThread(env, model, id);

const writable = (env: Environment, model: string, id: number): Promise<boolean> =>
  model === 'res.partner' ? permission(env, id, 'write') : permissionOn(env, model, id, 'write');

async function followStore(env: Environment, model: string, id: number): Promise<unknown> {
  // thread.py:296 `_store_thread_follow_fields`: request_list followers and suggestedRecipients, as a thread; reading
  // the thread raises the read AccessError of an unreadable record
  if (!(await readable(env, model, id))) await raiseAccess(env, model, id, 'read');
  const store = new Store();
  if (model === 'res.partner') await threadFields(env, id, ['followers', 'suggestedRecipients'], store);
  else await genericThreadFields(env, model, id, ['followers', 'suggestedRecipients'], store);
  return store.asDict(env.cr);
}

/**
 * mail_thread.py:4862-4887 `message_subscribe(partner_ids, subtype_ids)` on records of `model` (res.partner or a
 * generic thread model): False for oneself without read access (or a public user), write access for others, the
 * active partners in res.partner's order (the set `_add_followers` iterates is built in that order).
 */
export async function messageSubscribeApi(env: Environment, model: string, resIds: readonly number[], partnerIds: readonly number[], subtypeIds: readonly number[] | null): Promise<boolean> {
  if (!resIds.length || !partnerIds.length) return true;
  const self = await userInfo(env);
  const addingCurrent = new Set(partnerIds).size === 1 && partnerIds[0] === self.partnerId;
  if (addingCurrent && (await userFlags(env.cr, env.uid)).isPublic) return false;
  let pids = [...partnerIds];
  if (addingCurrent) {
    for (const id of resIds) if (!(await readable(env, model, id))) return false;
  } else {
    for (const id of resIds) if (!(await writable(env, model, id))) await raiseAccess(env, model, id, 'write');
    pids = await env.sudo().model('res.partner').search(and([cond('id', 'in', partnerIds), cond('active', '=', true)]));
  }
  await messageSubscribe(env, model, resIds, pids, subtypeIds && subtypeIds.length ? subtypeIds : null, addingCurrent ? [] : null);
  return true;
}

jsonRoute('/mail/thread/subscribe', async ctx => {
  const p = ctx.jsonParams ?? {};
  const env = await ctx.orm();
  const [model, id] = await followThread(env, p['res_model'], p['res_id'], true);
  await messageSubscribeApi(env, model, [id], ids(p['partner_ids']), null);
  return followStore(env, model, id);
}, { auth: 'user' });

// message_subscribe over call_kw (XML-RPC, JSON-RPC, /json/2) on the same models
for (const model of ['res.partner']) registerThreadMethods(model);
forEachGenericThread(registerThreadMethods);
function registerThreadMethods(model: string): void {
  if (OWN_SUBSCRIBE.has(model)) return;
  registerMethod(model, 'message_subscribe', async (env0, recIds, args, kwargs0) => {
    const { env, kwargs } = envFor(env0, kwargs0);
    const raw = 'partner_ids' in kwargs ? kwargs['partner_ids'] : args[0];
    const subtypes = 'subtype_ids' in kwargs ? kwargs['subtype_ids'] : args[1];
    if (subtypes !== undefined && subtypes !== null && subtypes !== false && !Array.isArray(subtypes)) throw new NotPorted('message_subscribe subtype_ids that are not a list');
    const partnerIds = raw === undefined || raw === null || raw === false ? [] : ids(raw);
    return messageSubscribeApi(env, model, recIds ?? [], partnerIds, Array.isArray(subtypes) ? ids(subtypes) : null);
  }, { apiModel: false });
}

jsonRoute('/mail/thread/unsubscribe', async ctx => {
  const p = ctx.jsonParams ?? {};
  const env = await ctx.orm();
  const [model, id] = await followThread(env, p['res_model'], p['res_id']);
  const partnerIds = ids(p['partner_ids']);
  if (partnerIds.length) {
    const self = await userInfo(env);
    // mail_thread.py:4925-4929: others need write access; internal users may always unfollow themselves
    if (!(new Set(partnerIds).size === 1 && partnerIds[0] === self.partnerId) && !(await writable(env, model, id))) {
      await raiseAccess(env, model, id, 'write');
    }
    await deleteFollowers(env, model, [id], partnerIds);
  }
  return followStore(env, model, id);
}, { auth: 'user' });

jsonRoute('/mail/message/reaction', async ctx => {
  const p = ctx.jsonParams ?? {};
  const env = await ctx.orm();
  const mid = Number(p['message_id']), content = p['content'], action = p['action'];
  if (typeof content !== 'string' || (action !== 'add' && action !== 'remove')) throw new NotPorted('reaction parameters');
  const msg = (await env.cr.query<{ model: string | null; res_id: number | null }>('SELECT model, res_id FROM mail_message WHERE id = $1', [mid])).rows[0];
  if (!msg) throw notFound();
  // res.partner and the generic threads (thread_generic.ts)
  const generic = msg.model !== null && isGenericThread(msg.model);
  const channel = msg.model === 'discuss.channel';
  if ((msg.model !== 'res.partner' && !generic && !channel) || !msg.res_id) throw new NotPorted(`reactions on ${msg.model} messages`);
  // message_reaction.py:17: mode "create" -> `_mail_post_access` on the document for internal users (mail_message.py
  // :747-766 `_get_with_access`; "write" as ported for res.partner, the model's own for the generic threads); a channel
  // asks read (discuss_channel.py:90 `_mail_message_reaction_access`), which its members have
  if (!(await userFlags(env.cr, env.uid)).isInternal) throw new NotPorted('reactions of non-internal users');
  const partner = (await userInfo(env)).partnerId;
  const allowed = channel
    ? (await env.cr.query('SELECT 1 FROM discuss_channel_member WHERE channel_id = $1 AND partner_id = $2', [msg.res_id, partner])).rows.length > 0
    : generic ? await permissionOn(env, msg.model!, msg.res_id, postAccessOf(msg.model!)) : await permission(env, msg.res_id, 'write');
  if (!allowed) throw new NotPorted(channel ? 'reaction in a channel by a non-member (channel access rules)' : 'reaction without post access (mail.message _get_with_access)');
  const existing = (await env.cr.query<{ id: number; content: string }>(
    'SELECT id, content FROM mail_message_reaction WHERE message_id = $1 AND partner_id = $2 AND guest_id IS NULL AND content = $3 ORDER BY id DESC LIMIT 1',
    [mid, partner, content])).rows[0];
  if (action === 'add' && !existing) {
    await env.cr.query('INSERT INTO mail_message_reaction (message_id, content, partner_id) VALUES ($1, $2, $3)', [mid, content, partner]);
  }
  if (action === 'remove' && existing) await env.cr.query('DELETE FROM mail_message_reaction WHERE id = $1', [existing.id]);
  const store = new Store();
  const groups = await reactionGroups(env, mid, store, content);
  // :1132-1150: ADD the group of this content when it still exists, else DELETE it
  store.add('mail.message', mid, { reactions: groups.length ? [['ADD', groups]] : [['DELETE', { message: mid, content }]] });
  const out = await store.asDict(env.cr);
  // :1102-1106 `_bus_send_reaction_group`: the same group to the message's bus channel (the current user,
  // mail_message.py:1475 `_bus_channels`; a channel message's channel, discuss mail_message.py:48-51)
  if (channel) {
    const { channelBusIsInternal, forChannelBus } = await import('./channel_post');
    const ch = (await env.cr.query<{ channel_type: string; group_public_id: number | null }>('SELECT channel_type, group_public_id FROM discuss_channel WHERE id = $1', [msg.res_id])).rows[0]!;
    await busSend(ctx, env, { model: 'discuss.channel', id: msg.res_id }, 'mail.record/insert', forChannelBus(out, await channelBusIsInternal(env, ch)));
  } else await busSend(ctx, env, { model: 'res.users', id: env.uid }, 'mail.record/insert', out);
  return out;
}, { auth: 'public' });
