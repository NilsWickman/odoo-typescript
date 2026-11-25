/**
 * mail's create/write/unlink overrides as WriteHooks (src/orm/hooks.ts; the call shape WR's core must honour is in
 * src/mail/WRITE_HOOKS.md):
 *  - mail.thread (odoo/addons/mail/models/mail_thread.py `create` :346, `write` :415, `unlink` :424) and
 *    mail.track.mixin (mail_track_mixin.py `write` :29) on every model inheriting mail.thread;
 *  - mail's `models.Model` override (addons/mail/models/models.py `unlink` :48: activities of deleted records),
 *    for the mail.thread models only (refuses when there are activities).
 */
import { translate } from '../models/util';
import { channelAfterWrite, channelBeforeWrite } from './channel_write';
import { NotPorted } from '../errors';
import { checkWriteAccess } from '../orm/write';
import type { Environment } from '../orm/types';
import { registerHooks, type WriteHooks } from '../orm/hooks';
import { userInfo } from '../orm/env';
import { computeAuthor, insertMessages, messageLogBatch, plaintextBody, replyToDefault, trackingMessageId, xmlid } from './message';
import { notifyThread } from './notify';
import { requestOfCursor } from '../http/context';
import { userAssignedBody } from '../models/mail_notify_layout';
import { insertFollowers, deleteFollowers } from './followers';
import { runAfterTracking, trackCollect, trackDiscard, trackFinalize, trackPrepare, heldTrackingModels, holdTracking } from './tracking';
import { mailTranslate } from './i18n';
import { taskTrackFinalize } from './task_create';
import { assertNoRecipients } from './post';
import { flatParent, flatThreadParent, isCompiledThread } from './thread_generic';
import '../models/mail_users_state';

/**
 * Concrete models of poc_corpus inheriting mail.thread (worker/gen/out/models.json `inherit`, transitively). The
 * ERP template has more; a model missing here simply gets no mail side effects, so WR should refuse writes on
 * `isMailThread` models that are not listed (`isPortedMailThread`).
 */
export const MAIL_THREAD_MODELS: readonly string[] = [
  'discuss.channel', 'iap.account', 'ir.access', 'ir.actions.server', 'ir.cron', 'mail.blacklist', 'phone.blacklist',
  'res.partner', 'res.users',
];
export function isPortedMailThread(model: string): boolean { return MAIL_THREAD_MODELS.includes(model) || ERP_THREADS.includes(model) || model === 'crm.lead' || EXTRA_RULES.has(model); }

/**
 * A mail.thread model of a module the hand port never saw (compiled code, K2: compiler/runtime/install.ts
 * threadModelKey): the same generic hooks, with the model's Python overrides of mail.thread's callbacks given as
 * functions of the compiled code.
 */
export interface ThreadModelRules {
  /** `_creation_subtype()` of one record: a subtype id, or false (mail_thread.py:384-394). */
  readonly creationSubtype?: (env: Environment, id: number) => Promise<number | false>;
  /** `_track_log_get_default_subtype(track_init_values)` of one record (mail_thread.py:661-668): a subtype id or false. */
  readonly trackSubtype?: (env: Environment, id: number, initValues: Readonly<Record<string, unknown>>) => Promise<number | false>;
}
const EXTRA_RULES = new Map<string, ThreadModelRules>();
export function registerThreadModel(model: string, rules: ThreadModelRules): void {
  if (MAIL_THREAD_MODELS.includes(model) || ERP_THREADS.includes(model) || EXTRA_RULES.has(model)) return;
  EXTRA_RULES.set(model, rules);
  registerHooks(model, { write: [threadHooks(model)] });
}

/**
 * Per-model Python overrides of the mail.thread hooks, from the installed modules of poc_erp:
 *  - `createContext`: keys their `create` passes to super (account_tax.py:617-621, account_journal.py:1064,
 *    project_project.py:652, crm_team.py:226, crm_team_member.py:170, stock_lot.py:196);
 *  - `subtypeFields`: `_track_log_get_default_subtype` returns a subtype when one of these changed, which posts the
 *    tracking with notifications (mail_thread.py:661-668): refused (account_move.py:8076, calendar_event.py:1588,
 *    project_project.py:944 and :934 `_track_template_parameters`, purchase_order.py:601, sale_order.py:2274,
 *    stock_picking.py:729, stock_picking_batch.py:445).
 */
interface ModelRules {
  readonly createContext?: Readonly<Record<string, boolean>>;
  readonly subtypeFields?: readonly string[];
  /** When set, a change of `subtypeFields` only selects a subtype for records this returns true for. */
  readonly subtypeIf?: (env: Environment, id: number) => Promise<boolean>;
  /** The subtype's xmlid: the tracking is posted with it (`message_post`), for nobody to notify; without it the change refuses. */
  readonly subtypeOf?: (env: Environment, id: number) => Promise<string>;
}
const RULES: Readonly<Record<string, ModelRules>> = {
  'account.tax': { createContext: { mail_create_nosubscribe: true, mail_auto_subscribe_no_notify: true, mail_create_nolog: true } },
  'account.journal': { createContext: { mail_create_nolog: true } },
  'project.project': { createContext: { mail_create_nosubscribe: true }, subtypeFields: ['stage_id'] },
  'crm.team': { createContext: { mail_create_nosubscribe: true } },
  'crm.team.member': { createContext: { mail_create_nosubscribe: true } },
  'stock.lot': { createContext: { mail_create_nosubscribe: true } },
  // account_move.py:8076-8084: only a paid or a validated invoice has a subtype
  'account.move': {
    subtypeFields: ['payment_state', 'state'],
    subtypeIf: async (env, id) => ['posted'].includes(
      (await env.cr.query<{ state: string | null }>('SELECT state FROM account_move WHERE id = $1', [id])).rows[0]?.state ?? ''),
  },
  // calendar_event.py:1588-1591: a change of the start, stop or location posts as "Event Updated"
  'calendar.event': { subtypeFields: ['start', 'stop', 'location'], subtypeOf: async () => 'calendar.mt_calendar_event_updated' },
  // purchase_order.py:601-611: confirmed (approved after 'to approve', which src/models/purchase_flow.ts refuses) and sent
  'purchase.order': {
    subtypeFields: ['state'],
    subtypeIf: async (env, id) => ['purchase', 'to approve', 'sent'].includes(
      (await env.cr.query<{ state: string | null }>('SELECT state FROM purchase_order WHERE id = $1', [id])).rows[0]?.state ?? ''),
    subtypeOf: async (env, id) => {
      const state = (await env.cr.query<{ state: string | null }>('SELECT state FROM purchase_order WHERE id = $1', [id])).rows[0]?.state;
      return state === 'sent' ? 'purchase.mt_rfq_sent' : 'purchase.mt_rfq_confirmed';
    },
  },
  // sale_order.py:2274-2280: a subtype only for the new states 'sale' and 'sent'; otherwise the default (none)
  'sale.order': {
    subtypeFields: ['state'],
    subtypeIf: async (env, id) => ['sale', 'sent'].includes(
      (await env.cr.query<{ state: string | null }>('SELECT state FROM sale_order WHERE id = $1', [id])).rows[0]?.state ?? ''),
    subtypeOf: async (env, id) => {
      const state = (await env.cr.query<{ state: string | null }>('SELECT state FROM sale_order WHERE id = $1', [id])).rows[0]?.state;
      return state === 'sale' ? 'sale.mt_order_confirmed' : 'sale.mt_order_sent';
    },
  },
  // stock_picking.py:729-732
  'stock.picking': {
    subtypeFields: ['state'],
    subtypeIf: async (env, id) => ['done', 'cancel'].includes(
      (await env.cr.query<{ state: string | null }>('SELECT state FROM stock_picking WHERE id = $1', [id])).rows[0]?.state ?? ''),
    subtypeOf: async () => 'stock.mt_picking_state',
  },
  'stock.picking.batch': { subtypeFields: ['state'] },
};

/** Models whose create/write mail overrides add behaviour this port does not have (each refuses). */
const OWN_OVERRIDES: Readonly<Record<string, string>> = {
  'res.users': 'mail res_users.py create (portal access log, odoobot)',
};

/**
 * `_message_auto_subscribe(updated_values)` (mail_thread.py:5008-5075): the followers of the parent records named by the
 * updated relation fields of the subtypes (mail_message_subtype.py:47-85 `_get_auto_subscription_subtypes`: a parent
 * subtype such as project's "Task Created" propagates its child, a generic or own subtype propagates itself, internal ones
 * are dropped for share partners), then the tracked responsible `user_id` (`_message_auto_subscribe_followers`), all
 * inserted together (`_insert_followers`, check_existing).
 */
async function autoSubscribe(env: Environment, model: string, values: Readonly<Record<string, unknown>>,
  ids: readonly number[] = [], policy: 'skip' | 'update' = 'skip'): Promise<void> {
  // the subtypes in their `_order` (sequence, id)
  const subtypes = (await env.cr.query<{ id: number; res_model: string | null; parent_id: number | null; relation_field: string | null; default: boolean | null; internal: boolean | null }>(
    `SELECT s.id, s.res_model, s.parent_id, s.relation_field, s."default", s.internal FROM mail_message_subtype s LEFT JOIN mail_message_subtype p ON p.id = s.parent_id
      WHERE s.res_model IS NULL OR s.res_model = $1 OR p.res_model = $1 ORDER BY s.sequence, s.id`, [model])).rows;
  const childIds = new Set<number>(), internal = new Set<number>(), parent = new Map<number, number | null>();
  const defIds: number[] = [];
  const relation = new Map<string, string[]>();
  for (const st of subtypes) {
    if (!st.res_model || st.res_model === model) {
      childIds.add(st.id);
      if (st.default) defIds.push(st.id);
    }
    if (st.relation_field) {
      parent.set(st.id, st.parent_id);
      const fields = relation.get(st.res_model ?? '') ?? [];
      if (!fields.includes(st.relation_field)) fields.push(st.relation_field);
      relation.set(st.res_model ?? '', fields);
    }
    if (st.internal) internal.add(st.id);
  }
  const newSubtypes = new Map<number, number[]>();
  const docData: [string, number[]][] = [];
  for (const [resModel, fields] of relation) {
    const parents = fields.filter(f => values[f]).map(f => Number(values[f]));
    if (parents.length) docData.push([resModel, parents]);
  }
  if (docData.length) {
    if (!ids.length) throw new NotPorted('auto-subscription through parent subtypes without records');
    // mail_followers.py:351-399 `_get_subscription_data(doc_data, None, include_pshare=True, include_active=True)`
    const where = docData.map((_, i) => '(f.res_model = $' + String(2 * i + 1) + ' AND f.res_id = ANY($' + String(2 * i + 2) + '::int[]))').join(' OR ');
    const rows = (await env.cr.query<{ partner_id: number | null; sids: (number | null)[]; pshare: boolean | null; active: boolean | null }>(
      `SELECT f.id, f.res_id, f.partner_id, array_agg(r.mail_message_subtype_id) AS sids, p.partner_share AS pshare, p.active
         FROM mail_followers f LEFT JOIN mail_followers_mail_message_subtype_rel r ON r.mail_followers_id = f.id
         LEFT JOIN res_partner p ON p.id = f.partner_id
        WHERE (${where}) GROUP BY f.id, p.partner_share, p.active`, docData.flatMap(([m, r]) => [m, r]))).rows;
    for (const r of rows) {
      const sids: number[] = [];
      for (const sid of r.sids) if (sid !== null && parent.get(sid)) sids.push(parent.get(sid)!);
      for (const sid of r.sids) if (sid !== null && !parent.has(sid) && childIds.has(sid)) sids.push(sid);
      if (!r.partner_id || !r.active) continue;
      const set = [...new Set(sids)];
      newSubtypes.set(r.partner_id, r.pshare ? set.filter(sid => !internal.has(sid)) : set);
    }
  }
  // _message_auto_subscribe_followers (:4960): the tracked res.users `user_id` is subscribed and notified
  const field = env.reg.model(model).fields.get('user_id');
  let notify: { userId: number; partnerId: number } | null = null;
  if (field && values['user_id'] && field.relation === 'res.users' && field.descriptionTracking) {
    const userId = values['user_id'];
    // the env user as responsible: subscribed with the default subtypes, no assignment notification (:4966-4967)
    if (!ids.length) throw new NotPorted('auto-subscription without records');
    const user = (await env.cr.query<{ active: boolean; partner_id: number }>('SELECT active, partner_id FROM res_users WHERE id = $1', [userId])).rows[0];
    if (user?.active) {
      // :5060 `setdefault`: a partner already subscribed through a parent keeps those subtypes
      if (!newSubtypes.has(user.partner_id)) newSubtypes.set(user.partner_id, defIds);
      // :5071-5073 another user is notified with mail.message_user_assigned (unless mail_auto_subscribe_no_notify)
      if (userId !== env.uid && !env.context['mail_auto_subscribe_no_notify'] && !env.context['install_demo']) notify = { userId: Number(userId), partnerId: user.partner_id };
    }
  }
  // project_task.py:1620-1636 `_message_auto_subscribe_followers`: the users the commands name (from an empty value)
  if (model === 'project.task' && 'user_ids' in values) {
    const { userIdsOf } = await import('./task_create');
    const users = userIdsOf(values['user_ids']);
    const partners = users.length ? (await env.cr.query<{ id: number; partner_id: number | null }>('SELECT id, partner_id FROM res_users WHERE id = ANY($1::int[])', [users])).rows : [];
    for (const u of users) {
      const p = partners.find((r) => r.id === u)?.partner_id;
      if (p && !newSubtypes.has(p)) newSubtypes.set(p, defIds);
    }
  }
  if (newSubtypes.size) await insertFollowers(env, model, ids, [...newSubtypes.keys()], newSubtypes, { checkExisting: true, policy }); // :5066-5069
  if (notify) await notifyUserAssigned(env, model, ids, notify.userId, notify.partnerId);
}

/**
 * `_message_auto_subscribe_notify(partner_ids, 'mail.message_user_assigned')` (mail_thread.py:4972-5006) for models
 * without their own override: `message_notify` of the rendered assignment (CRM's `userAssignedBody`, the template's
 * sanitized output) to the new responsible, sent by email (src/mail/notify.ts).
 */
async function notifyUserAssigned(env: Environment, model: string, ids: readonly number[], userId: number, partnerId: number): Promise<void> {
  const ctx = requestOfCursor(env.cr);
  if (ctx === null) throw new NotPorted('assignment notification outside a request');
  const p = (await env.cr.query<{ name: string | null; lang: string | null }>('SELECT name, lang FROM res_partner WHERE id = $1', [partnerId])).rows[0];
  // :5072 `with_context(lang=partner.lang)`
  const lang = p?.lang || env.lang || 'en_US';
  if (lang !== 'en_US') throw new NotPorted('assignment notification in a language other than en_US');
  const modelDescription = (await env.cr.query<{ name: string }>("SELECT COALESCE(name->>'en_US', model) AS name FROM ir_model WHERE model = $1", [model])).rows[0]!.name;
  const def = env.reg.model(model);
  for (const id of ids) {
    const displayName = (await env.sudo().model(model).displayName([id])).get(id) ?? '';
    const userName = (await env.cr.query<{ name: string | null }>('SELECT p.name FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1', [userId])).rows[0]?.name ?? '';
    const body = userAssignedBody(userName, modelDescription, displayName);
    const [authorId, emailFrom] = await computeAuthor(env, null, null);
    let company = await env.company();
    if (def.fields.get('company_id')?.column) {
      const row = (await env.cr.query<{ c: number | null }>(`SELECT company_id AS c FROM "${def.table}" WHERE id = $1`, [id])).rows[0];
      if (row?.c) company = row.c;
    }
    const [mid] = await insertMessages(env, [{
      model, res_id: id, body, author_id: authorId, email_from: emailFrom, message_type: 'user_notification',
      subtype_id: await xmlid(env, 'mail.mt_note'), is_internal: true, subject: `You have been assigned to ${displayName}`,
      reply_to: await replyToDefault(env, emailFrom), message_id: trackingMessageId('message-notify'), email_add_signature: true,
      record_alias_domain_id: false, record_company_id: company, email_layout_xmlid: 'mail.mail_notification_layout', partner_ids: [partnerId],
    }]);
    const notified = await notifyThread(ctx, env, model, id, mid!, { modelDescription });
    await notified.send();
  }
}

/** `_creation_message` (mail_thread.py:516): "<ir.model name> created" in the env language. */
/** `_mail_get_companies` of a record (mail_thread.py `_mail_get_company_field`: its company_id, if any). */
async function recordCompanyOf(env: Environment, model: string, id: number): Promise<number | false> {
  const def = env.reg.model(model);
  const f = def.fields.get('company_id');
  if (!f || !f.store || !f.column) return false;
  return (await env.cr.query<{ c: number | null }>(`SELECT company_id AS c FROM "${def.table}" WHERE id = $1`, [id])).rows[0]?.c ?? false;
}

function creationBody(env: Environment, model: string): string {
  const def = env.reg.model(model);
  const lang = env.lang ?? 'en_US';
  const name = def.descriptions[lang] ?? def.description;
  return plaintextBody(mailTranslate(lang, '%s created').replace('%s', name));
}

/** account_move.py:8085-8095 `_creation_message` of a move without creation subtype. */
async function moveCreationBody(env: Environment, id: number): Promise<string> {
  const t = (await env.cr.query<{ t: string }>('SELECT move_type AS t FROM account_move WHERE id = $1', [id])).rows[0]?.t;
  const labels: Record<string, string> = { out_refund: 'Credit Note Created', in_invoice: 'Vendor Bill Created', in_refund: 'Refund Created', in_receipt: 'Purchase Receipt Created' };
  if (t === undefined || t === 'entry') return creationBody(env, 'account.move');
  if (!labels[t]) throw new NotPorted(`creation message of a ${t}`);
  // `_()` of account's frame in the creating environment's language (before round 11 another language refused)
  return plaintextBody(translate(env, labels[t]!, 'account'));
}

/**
 * `_notify_thread` (mail_thread.py:2433) of a message the write hooks posted with a subtype (a tracking message, a
 * compiled `_creation_subtype`'s creation message): the followers of the subtype are notified by src/mail/notify.ts,
 * which refuses what it does not port (inbox recipients here: their bus Store is the caller's, see NotifyOptions.inbox).
 * The mails are sent at once, as `send_after_commit` leaves them (the answer of a write is not their Store).
 * Only for the compiled thread models, whose build checked that they keep mail's `_notify_*` methods: the hand port's
 * models with a tracking subtype (sale.order, purchase.order, stock.picking, calendar.event: portal customers,
 * attendees and their own groups) have no proof of these notifications, and outside a request nobody may be notified
 * either. Both refuse as before when someone would be (assertNoRecipients).
 */
async function notifyPosted(env: Environment, model: string, id: number, messageId: number, subtype: number): Promise<void> {
  const ctx = requestOfCursor(env.cr);
  if (ctx === null || !isCompiledThread(model)) { await assertNoRecipients(env, model, id, subtype, [], { notification: true }); return; }
  await (await notifyThread(ctx, env, model, id, messageId)).send();
}

/**
 * mail_thread.py:668-690 `_track_finalize` of a record whose `_track_log_get_default_subtype` gave a subtype:
 * `message_post(subtype_id=..., tracking_value_ids=...)`, the trackings in its body (:2428-2429), and its notification.
 */
async function postTracking(env: Environment, tenv: Environment, model: string, id: number, body: string, subtype: number): Promise<void> {
  const [authorId, emailFrom] = await computeAuthor(tenv, null, null);
  // mail_thread.py:2420-2421 `_mail_get_companies(default=self.env.company)` (models.py:140-153): the record's
  // company, else (no company field, as calendar.event, or an empty one) the environment's
  const own = env.reg.model(model).fields.get('company_id')?.column
    ? (await env.cr.query<{ c: number | null }>(`SELECT company_id AS c FROM ${model.replace(/\./g, '_')} WHERE id = $1`, [id])).rows[0]?.c ?? null : null;
  const company = own ?? await tenv.company();
  const [mid] = await insertMessages(tenv, [{
    model, res_id: id, body, author_id: authorId, email_from: emailFrom, message_type: 'tracking', subject: false, subtype_id: subtype, email_add_signature: true,
    record_company_id: company, parent_id: EXTRA_RULES.has(model) ? await flatParent(env, model, id) : await flatThreadParent(env, model, id),
    message_id: trackingMessageId('message-notify'), reply_to: await replyToDefault(tenv, emailFrom),
  }]);
  await notifyPosted(tenv, model, id, mid!, subtype);
}

/** mail.thread write after super(): auto-subscription and the tracking log (mail_thread.py:418-419, :628). */
async function threadAfterWriteOf(model: string, env: Environment, _ids: readonly number[], vals: Record<string, unknown>): Promise<void> {
  if (model === 'discuss.channel') await channelAfterWrite(env, _ids, vals);
  if (!env.context['tracking_disable']) await autoSubscribe(env, model, vals, _ids); // :418-419
  if (model === 'project.task') { await taskTrackFinalize(env); return; }
  const extra = EXTRA_RULES.get(model)?.trackSubtype;
  if (extra) {
    // a compiled `_track_log_get_default_subtype`: the changes it gives no subtype are logged as usual, one with a
    // subtype is posted with it (mail_thread.py:668-690, postTracking: refused if it would notify anyone)
    const collected = await trackCollect(env, model);
    if (!collected || !collected.changes.size) return;
    const plain = new Map<number, string>();
    for (const [id, c] of collected.changes) {
      // mail_thread.py:658-661 `record_init_values`: the initial values of the changed fields only (a write that
      // names an unchanged stage_id is not a stage change for maintenance.request's subtype)
      const subtype = await extra(collected.env, id, Object.fromEntries(c.changes.map(f => [f, c.init[f]])));
      if (subtype) await postTracking(env, collected.env, model, id, c.body, subtype);
      else plain.set(id, c.body);
    }
    if (plain.size) await messageLogBatch(collected.env, model, plain, { messageType: 'tracking' });
    return;
  }
  const guard = RULES[model]?.subtypeFields;
  if (!guard) { await trackFinalize(env, model); return; }
  const collected = await trackCollect(env, model);
  if (!collected || !collected.changes.size) return;
  const subtypeIf = RULES[model]?.subtypeIf, subtypeOf = RULES[model]?.subtypeOf;
  const plain = new Map<number, string>();
  for (const [id, c] of collected.changes) {
    const hit = c.changes.filter(f => guard.includes(f));
    if (!hit.length || (subtypeIf && !(await subtypeIf(env, id)))) { plain.set(id, c.body); continue; }
    if (!subtypeOf) throw new NotPorted(`${model} tracking of ${hit.join(', ')} posts with a subtype (_track_log_get_default_subtype)`);
    // mail_thread.py:668-690 `message_post(subtype_id=..., tracking_value_ids=...)`
    await postTracking(env, collected.env, model, id, c.body, await xmlid(env, await subtypeOf(env, id)));
  }
  if (plain.size) await messageLogBatch(collected.env, model, plain, { messageType: 'tracking' });
}

/**
 * Closes a tracking scope opened with `trackPrepare` around several steps of one method, so the tracking is logged
 * after them as at Odoo's precommit (mail_track_mixin.py:133), with the model's subtype rules.
 */
export async function closeTrackingScope(env: Environment, model: string): Promise<void> {
  await threadAfterWriteOf(model, env, [], {});
  await runAfterTracking(env, model);
}

/**
 * `cr.flush()`'s precommit for the tracking held on the cursor (src/mail/tracking.ts `holdTracking`): each held
 * model's level is closed and its tracking logged, in the order of the models' first tracking. `keep` holds again
 * afterwards (a savepoint's flush in the middle of a data file).
 */
export async function flushHeldTracking(env: Environment, keep = false): Promise<void> {
  // the end values are read in the environment of the model's first tracking, as Odoo's bound `_track_finalize`
  for (const held of heldTrackingModels(env.cr)) await closeTrackingScope(held.env, held.model);
  if (keep) holdTracking(env.cr);
}

/** mail.thread `create` (mail_thread.py:344-412) after the ORM's. */
async function threadAfterCreate(model: string, env0: Environment, ids: readonly number[], valsList: readonly Record<string, unknown>[]): Promise<void> {
  {
    // project_task.py:1158-1272: the mail.thread part runs inside the create override (src/mail/task_create.ts)
    if (model === 'project.task') return;
    // discuss_channel.py:571: created with mail_create_nolog and mail_create_nosubscribe (src/mail/channel_write.ts)
    if (model === 'discuss.channel') { if (ids.length) await trackDiscard(env0, model, ids); return; }
    // res.users: mail res_users.py create (its portal access log) is in src/models/res_users_create.ts
    if (OWN_OVERRIDES[model] && model !== 'res.users') throw new NotPorted(OWN_OVERRIDES[model]);
    if (!ids.length) return;
    const ctxRules = RULES[model]?.createContext;
    const env = ctxRules ? env0.withContext({ ...env0.context, ...ctxRules }) : env0;
    // addons/mail/models/res_partner.py:68: partners default to mail_create_nosubscribe=True
    const nosubscribe = model === 'res.partner' && !('mail_create_nosubscribe' in env.context) ? true : Boolean(env.context['mail_create_nosubscribe']);
    if (env.context['tracking_disable']) { await trackDiscard(env, model, ids); return; } // :357-360
    const user = await userInfo(env);
    if (!nosubscribe && user.active && !user.share) {
      await insertFollowers(env, model, ids, [user.partnerId], null, { customerIds: [], checkExisting: false, policy: 'skip' });
    }
    for (let i = 0; i < ids.length; i++) {
      // :372-376: values plus the context's default_* keys
      const createValues: Record<string, unknown> = { ...valsList[i] };
      for (const [k, v] of Object.entries(env.context)) if (k.startsWith('default_') && !(k.slice(8) in createValues)) createValues[k.slice(8)] = v;
      await autoSubscribe(env, model, createValues, [ids[i]!], 'update'); // :379
    }
    if (!env.context['mail_create_nolog']) {
      // `_creation_subtype` is empty for the ported models: `_message_log_batch` (:396-398), as superuser-free log
      const bodies = new Map<number, string>();
      for (const id of ids) {
        // account_move.py:8069-8095: customer invoices are posted with their creation subtype (mail_thread.py:386-394)
        const posted = model === 'account.move' ? (await env.cr.query<{ t: string; c: number }>(
          `SELECT move_type AS t, company_id AS c FROM account_move WHERE id = $1 AND move_type IN ('out_invoice', 'out_receipt')`, [id])).rows[0] : undefined;
        // mail_thread.py:384-394: a compiled `_creation_subtype` (K2) posts the creation message with its subtype, as
        // superuser and authored by the user, notifying the followers of the subtype (notifyPosted)
        const creation = EXTRA_RULES.get(model)?.creationSubtype;
        const subtype = creation ? await creation(env, id) : false;
        if (subtype) {
          const [authorId, emailFrom] = await computeAuthor(env, user.partnerId, null);
          const company = await recordCompanyOf(env, model, id);
          const [mid] = await insertMessages(env, [{
            model, res_id: id, body: `<div>${creationBody(env, model)}</div>`, author_id: authorId, email_from: emailFrom,
            message_type: 'notification', subject: false, subtype_id: subtype, email_add_signature: true,
            record_company_id: company, message_id: trackingMessageId('message-notify'), reply_to: await replyToDefault(env, emailFrom),
          }]);
          await notifyPosted(env.sudo(), model, id, mid!, subtype);
          continue;
        }
        if (posted) {
          // the body of an invoice is empty in every language; a receipt's "Sales Receipt Created" would be translated
          if (posted.t === 'out_receipt' && env.lang && env.lang !== 'en_US') throw new NotPorted('creation message of sales receipts outside en_US');
          const [authorId, emailFrom] = await computeAuthor(env, user.partnerId, null);
          await insertMessages(env, [{
            model, res_id: id, body: `<div><p>${posted.t === 'out_receipt' ? 'Sales Receipt Created' : ''}</p></div>`, author_id: authorId, email_from: emailFrom,
            message_type: 'notification', subject: false, subtype_id: await xmlid(env, 'account.mt_invoice_created'), email_add_signature: true,
            record_company_id: posted.c, message_id: trackingMessageId('message-notify'), reply_to: await replyToDefault(env, emailFrom),
          }]);
        } else bodies.set(id, model === 'account.move' ? await moveCreationBody(env, id) : creationBody(env, model));
      }
      if (bodies.size) await messageLogBatch(env, model, bodies);
    }
    await trackDiscard(env, model, ids);
    // `_track_prepare_for_template` (:402-412): `_track_template_parameters` is empty for the ported models.
  }
}

/** The moves whose `create` override reset `is_manually_modified` (src/models/account_move_create.ts), per cursor,
 *  until mail.thread's create of the same call has run. */
const MOVE_CREATE_RESET = new WeakMap<object, Set<number>>();
export function noteMoveCreateReset(cr: object, ids: readonly number[]): void {
  const s = MOVE_CREATE_RESET.get(cr) ?? new Set<number>();
  for (const id of ids) s.add(id);
  MOVE_CREATE_RESET.set(cr, s);
}
function takeMoveCreateReset(cr: object, ids: readonly number[]): number[] {
  const s = MOVE_CREATE_RESET.get(cr);
  if (!s) return [];
  const out = ids.filter((id) => s.has(id));
  for (const id of out) s.delete(id);
  return out;
}

const threadHooks = (model: string): WriteHooks => ({
  afterCreate: async (env0, ids, valsList) => {
    await threadAfterCreate(model, env0, ids, valsList);
    // account_move.py:3992 `moves.is_manually_modified = False` runs after super().create(), mail.thread's create
    // included: a write that one makes on the new move (the assignment notification's `_portal_ensure_token` on
    // access_token, account_move.py:4085-4086) leaves it False. Only for the moves the create override reset: a move
    // inserted directly (a reversal's copy, src/models/account_move_ops.ts) runs these hooks with its final value
    if (model === 'account.move') {
      const reset = takeMoveCreateReset(env0.cr, ids);
      if (reset.length) await env0.cr.query('UPDATE account_move SET is_manually_modified = FALSE WHERE id = ANY($1::int[])', [reset]);
    }
  },
  beforeWrite: async (env, ids, vals) => {
    // mail res_users.py:209-266: security notification mails for these keys (group_ids and notification_type:
    // src/models/res_users_groups.ts)
    if (model === 'res.users') {
      const keys = ['login', 'password', 'email'].filter(k => k in vals);
      // BaseModel.write's access checks come first (inside super().write): a user who may not write these gets
      // Odoo's AccessError, not the refusal
      if (keys.length) await checkWriteAccess(env, model, ids, Object.keys(vals));
      if (keys.length) throw new NotPorted(`res.users write of ${keys.join(', ')} (mail res_users.py:209)`);
    } else if (model === 'project.task') {
      // project_task.py:1274-1460 (and project_sms project_task.py:24-29): for these keys the override does nothing
      // beyond check_access and super().write (whose tracking is the generic one: `_track_log_get_default_subtype`
      // :1658-1673 falls back to the default without stage_id/state); the others refuse
      // stage_id and state: the write override in task_create.ts
      // user_ids: the write override in task_create.ts (with project_id or company_id, which refuse here, it refuses too)
      // description: project_task.py:1391-1404 only writes sudo for portal users (refused below); HtmlFieldHistoryMixin in src/models/html_field_history.ts
      const handled = ['milestone_id', 'parent_id', 'repeat_interval', 'repeat_unit', 'repeat_type',
        'repeat_until', 'recurring_task', 'project_id', 'company_id', 'date_assign'];
      // :1366-1367 a falsy personal_stage_type_id is dropped; a stage goes through the generic related write (src/orm/write.ts)
      if ('personal_stage_type_id' in vals && !vals['personal_stage_type_id']) throw new NotPorted('project.task write of an empty personal stage (dropped from vals)');
      // project_id alone: the write override in task_create.ts (writeProject)
      const projectAlone = Object.keys(vals).length === 1 && 'project_id' in vals;
      const hit = Object.keys(vals).filter(k => handled.includes(k) && !(k === 'milestone_id' && !('project_id' in vals)) && !(projectAlone && k === 'project_id'));
      if (hit.length) throw new NotPorted(`project.task write of ${hit.join(', ')} (project_task.py:1274 override)`);
      if (!env.su && (await userInfo(env)).share) throw new NotPorted('project.task write by a portal user (_ensure_fields_write)');
      if ('milestone_id' in vals) await taskMilestoneWrite(env, ids, vals['milestone_id']);
    } else if (model === 'discuss.channel') {
      await channelBeforeWrite(env, ids, vals); // discuss_channel.py:596-694 and bus_sync_mixin.py:26-50
    } else if (OWN_OVERRIDES[model]) throw new NotPorted(OWN_OVERRIDES[model]);
    await trackPrepare(env, model, ids);
  },
  afterWrite: async (env, ids, vals) => {
    await threadAfterWriteOf(model, env, ids, vals);
    await runAfterTracking(env, model); // tracking of records reporting on this model (`_track_record`)
  },
  beforeUnlink: async (env, ids) => {
    if (!ids.length) return;
    await trackDiscard(env, model, ids); // :431
    await unlinkMessages(env, model, ids); // :432
  },
  afterUnlink: (env, ids) => threadAfterUnlink(env, model, ids),
});

/**
 * project_task.py:1293-1329 the `milestone_id` part of project.task write (without `project_id` in the values): tasks of
 * another project than the milestone's would be written False apart and the key dropped (refused here, before anything
 * is written); the open subtasks (not among the written tasks) of the valid ones follow when they have no milestone and
 * belong to the milestone's project, or share their parent's milestone, written as sudo before the tasks themselves.
 */
async function taskMilestoneWrite(env: Environment, ids: readonly number[], value: unknown): Promise<void> {
  const milestone = typeof value === 'number' && value ? value : null;
  const project = milestone === null ? null : (await env.cr.query<{ p: number | null }>('SELECT project_id AS p FROM project_milestone WHERE id = $1', [milestone])).rows[0]?.p ?? null;
  const tasks = (await env.cr.query<{ id: number; project_id: number | null }>('SELECT id, project_id FROM project_task WHERE id = ANY($1::int[]) ORDER BY id', [[...ids]])).rows;
  if (milestone !== null && tasks.some(t => t.project_id !== project)) throw new NotPorted('project.task write of a milestone of another project (milestone_id reset apart)');
  // CLOSED_STATES (project_task.py:85-88); `child_ids` of the tasks, in the subtasks' `_order`
  const subtasks = (await env.cr.query<{ id: number }>(
    `SELECT c.id FROM project_task c JOIN project_task p ON p.id = c.parent_id
      WHERE c.parent_id = ANY($1::int[]) AND NOT (c.id = ANY($1::int[])) AND c.state NOT IN ('1_done', '1_canceled')
        AND ((c.milestone_id IS NULL AND c.project_id IS NOT DISTINCT FROM $2) OR c.milestone_id IS NOT DISTINCT FROM p.milestone_id)
      ORDER BY c.priority DESC, c.sequence, c.date_deadline ASC NULLS LAST, c.id DESC`, [[...ids], project])).rows.map(r => r.id);
  if (!subtasks.length) return;
  const order = env.reg.model('project.task').order;
  if (order !== 'priority desc, sequence, date_deadline asc, id desc') throw new NotPorted(`project.task order ${order}`);
  const { write } = await import('../orm/write');
  await write(env.sudo(), 'project.task', subtasks, { milestone_id: milestone ?? false });
}

/** mail.thread unlink after super() (mail_thread.py:434-437) and the activities of the deleted records. */
export async function threadAfterUnlink(env: Environment, model: string, ids: readonly number[]): Promise<void> {
  if (!ids.length) return;
  await deleteFollowers(env, model, ids, null); // :434-436
  await env.cr.query('DELETE FROM mail_scheduled_message WHERE model = $1 AND res_id = ANY($2::int[])', [model, ids]); // :437
  // addons/mail/models/models.py:48 (every model; ported for the mail.thread models): activities of deleted records
  const acts = (await env.cr.query<{ id: number }>('SELECT id FROM mail_activity WHERE res_model = $1 AND res_id = ANY($2::int[])', [model, ids])).rows;
  // mail_activity.py:408 unlink only adds the `mail.activity/updated` bus counter notification (not sent)
  if (acts.length) await env.cr.query('DELETE FROM mail_activity WHERE id = ANY($1::int[])', [acts.map(a => a.id)]);
  // rating/models/mail_thread.py:18-23: the ratings of the deleted records (those of their messages went with the
  // messages, ON DELETE CASCADE), as superuser; rating.py:140-143 would first delete the messages they still hold
  // (only where the rating module is installed: poc_corpus has no rating_rating)
  const ratings = env.reg.models.has('rating.rating')
    ? (await env.cr.query<{ id: number; message_id: number | null }>('SELECT id, message_id FROM rating_rating WHERE res_model = $1 AND res_id = ANY($2::int[])', [model, ids])).rows : [];
  if (ratings.some(r => r.message_id !== null)) throw new NotPorted('unlink of ratings that hold a message of another record');
  if (ratings.length) {
    await env.cr.query('DELETE FROM rating_rating WHERE id = ANY($1::int[])', [ratings.map(r => r.id)]);
    await env.cr.query("DELETE FROM ir_model_data WHERE model = 'rating.rating' AND res_id = ANY($1::int[])", [ratings.map(r => r.id)]);
  }
}

/**
 * mail_thread.py:432 `self.env['mail.message'].sudo().search([('model', '=', model), ('res_id', 'in', ids)]).unlink()`:
 * `mail.message.unlink` (mail_message.py:874-895) of a deleted record's messages, in the messages' `_order` (id desc).
 */
export async function unlinkMessages(env: Environment, model: string, ids: readonly number[]): Promise<void> {
  const msgs = (await env.cr.query<{ id: number }>('SELECT id FROM mail_message WHERE model = $1 AND res_id = ANY($2::int[]) ORDER BY id DESC', [model, ids])).rows.map(r => r.id);
  if (!msgs.length) return;
  const { unlinkAttachments } = await import('../orm/unlink');
  // :882-884 the attachments of the messages that belong to the messages themselves (res_model mail.message, res_id
  // one of them or 0), as superuser
  const own = (await env.cr.query<{ id: number }>(
    `SELECT DISTINCT a.id FROM message_attachment_rel r JOIN ir_attachment a ON a.id = r.attachment_id
      WHERE r.message_id = ANY($1::int[]) AND a.res_model = 'mail.message' AND (a.res_id = ANY($1::int[]) OR a.res_id = 0) ORDER BY a.id`, [msgs])).rows.map(r => r.id);
  await unlinkAttachments(env, own);
  await notifyMessagesDeleted(env, msgs);
  await env.cr.query('DELETE FROM mail_message WHERE id = ANY($1::int[])', [msgs]);
  // models.py unlink: the deleted records' ir.model.data go with them (messages of demo data have xmlids), then their
  // attachments that :882-884 left (res_model mail.message without being linked to them)
  await env.cr.query("DELETE FROM ir_model_data WHERE model = 'mail.message' AND res_id = ANY($1::int[])", [msgs]);
  const rest = (await env.cr.query<{ id: number }>("SELECT id FROM ir_attachment WHERE res_model = 'mail.message' AND res_id = ANY($1::int[]) ORDER BY id", [msgs])).rows.map(r => r.id);
  await unlinkAttachments(env, rest);
}

/**
 * mail_message.py:885-894: every partner with a user among a message's recipients (To and Cc) and every author of its
 * notifications gets `mail.message/delete` with its messages (in the order of `msgs`), partners in the order they first
 * appear (the recipients in res.partner's `_order`, then the notifications' authors in id order). `partner._bus_send`
 * goes to the partner's active users (bus res_partner.py:10-12, in res.users' `_order`): a partner without one sends
 * nothing, so `filtered('user_ids')` needs no separate test.
 */
async function notifyMessagesDeleted(env: Environment, msgs: readonly number[]): Promise<void> {
  const rows = (await env.cr.query<{ mid: number; pid: number; kind: number }>(
    `SELECT x.mid, x.pid, x.kind FROM (
       SELECT r.mail_message_id AS mid, p.id AS pid, 0 AS kind, p.complete_name AS cn, -p.id AS ord
         FROM mail_message_res_partner_rel r JOIN res_partner p ON p.id = r.res_partner_id WHERE r.mail_message_id = ANY($1::int[])
       UNION ALL
       SELECT r.mail_message_id, p.id, 1, p.complete_name, -p.id
         FROM mail_message_res_partner_cc_rel r JOIN res_partner p ON p.id = r.res_partner_id WHERE r.mail_message_id = ANY($1::int[])
       UNION ALL
       SELECT n.mail_message_id, n.author_id, 2, NULL, n.id
         FROM mail_notification n WHERE n.mail_message_id = ANY($1::int[]) AND n.author_id IS NOT NULL
     ) x ORDER BY x.kind, x.cn, x.ord`, [msgs])).rows;
  if (!rows.length) return;
  const users = new Map<number, number[]>();
  for (const u of (await env.cr.query<{ id: number; partner_id: number }>(
    `SELECT u.id, u.partner_id FROM res_users u JOIN res_partner p ON p.id = u.partner_id
      WHERE u.active AND u.partner_id = ANY($1::int[]) ORDER BY p.name, u.login`, [[...new Set(rows.map(r => r.pid))]])).rows) {
    users.set(u.partner_id, [...(users.get(u.partner_id) ?? []), u.id]);
  }
  const byPartner = new Map<number, number[]>();
  for (const mid of msgs) {
    const of = rows.filter(r => r.mid === mid);
    // ((partner_ids | partner_cc_ids) & partners_with_user) | notification_ids.author_id, first occurrences kept
    const partners = [...new Set([...of.filter(r => r.kind < 2 && users.has(r.pid)).map(r => r.pid), ...of.filter(r => r.kind === 2).map(r => r.pid)])];
    for (const pid of partners) {
      const list = byPartner.get(pid) ?? [];
      if (!list.includes(mid)) list.push(mid);
      byPartner.set(pid, list);
    }
  }
  const targets = [...byPartner].filter(([pid]) => users.has(pid));
  if (!targets.length) return;
  const ctx = requestOfCursor(env.cr);
  if (!ctx) throw new NotPorted('mail.message/delete bus notification outside a request');
  const { busSend } = await import('./busnotify');
  for (const [pid, messageIds] of targets) {
    for (const uid of users.get(pid)!) await busSend(ctx, env, { model: 'res.users', id: uid }, 'mail.message/delete', { message_ids: messageIds });
  }
}

for (const model of MAIL_THREAD_MODELS) registerHooks(model, { write: [threadHooks(model)] });


/**
 * The other mail.thread models of the ERP template (gen/out/poc_erp/models.json, transitively inheriting mail.thread)
 * get the same generic hooks, driven by their field metadata (`tracking`) and the RULES above. crm.lead has its own
 * (src/models/crm_lead_mail.ts); project.task refuses (OWN_OVERRIDES).
 */
const ERP_THREADS: readonly string[] = [
  'account.account', 'account.analytic.account', 'account.journal', 'account.move', 'account.payment',
  'account.reconcile.model', 'account.tax', 'calendar.event', 'crm.team', 'crm.team.member',
  'product.category', 'product.pricelist', 'product.product', 'product.template', 'project.milestone',
  'project.project', 'project.task', 'project.update', 'purchase.order', 'res.company', 'res.partner.bank',
  'sale.order', 'stock.lot', 'stock.picking', 'stock.picking.batch',
];
for (const model of ERP_THREADS) registerHooks(model, { write: [threadHooks(model)] });
