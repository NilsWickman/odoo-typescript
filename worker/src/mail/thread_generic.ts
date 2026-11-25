/**
 * Chatter of non-partner threads for internal users (crm.lead on poc_erp): mail/controllers/thread.py
 * `/mail/thread/messages` and the `mail.thread` store request, i.e. mail_thread.py:5285-5398 `_store_thread_fields`
 * with mail_thread_subject_suggested.py:9-27, and the generic recipients of mail/models/models.py:163-570.
 * thread.ts (stream MAIL) keeps the res.partner path; this module covers the hand port's models listed in
 * THREAD_MODELS, with their Python class attributes, and every mail.thread model a new module introduces whose build
 * read the same attributes from Odoo's class (registerCompiledThread, compiler/oc/build.py `thread_chatter`: a model
 * whose mixins or overrides the generic chatter does not follow refuses), and refuses every branch whose data it does
 * not port (activities, attachments, scheduled messages, suggestion from replies or loose emails). Written by stream CRM.
 */
import { AccessError, NotPorted } from '../errors';
import { requestOfCursor } from '../http/context';
import { and, cond, parseDomain, TRUE } from '../orm/domain';
import { userInfo } from '../orm/env';
import type { Environment } from '../orm/types';
import { userFlags, xmlidToResId, icpStr } from '../session/user';
import { dbNow, textwrapShorten, todayInTz } from '../models/util';
import { Store } from './store';
import { attachmentStoreFields } from './attachment';
import { MailBootstrap } from './bootstrap';
import { setMessageDone } from './busnotify';

interface ThreadModel {
  /** `_mail_post_access` (mail_thread.py:147 default 'write'; crm.lead keeps it). */
  readonly postAccess: 'read' | 'write';
  /** `_primary_email` (crm_lead.py:98 'email_from'; mail_thread.py:148 'email'); null when the class sets None. */
  readonly primaryEmail: string | null;
  /** Inherits mail.thread.subject.suggested (models.json inherit). */
  readonly subjectSuggested: boolean;
  /** `_creation_subtype` xmlid used by `_sort_suggested_messages` (models.py:553-568). */
  readonly creationSubtype: string | null;
  /** Inherits mail.thread.main.attachment (mail_thread_main_attachment.py:49-52 `_store_thread_fields`). */
  readonly mainAttachment?: boolean;
}

/**
 * The chatter of a mail.thread model a new module introduces (K2: compiler/oc/build.py `thread_chatter`, installed by
 * compiler/runtime/install.ts threadModelKey): its class attributes read from Odoo's class by the build, or the reason
 * the generic chatter cannot follow it (a mixin or an override of mail's methods). `creationSubtype` is the model's
 * compiled `_creation_subtype` (a subtype id), when it overrides it.
 */
export interface ThreadChatter {
  readonly postAccess: 'read' | 'write';
  readonly primaryEmail: string | null;
  readonly subjectSuggested: boolean;
  readonly mainAttachment: boolean;
}
export type ThreadChatterOf = ThreadChatter | { readonly refused: string } | undefined;
interface CompiledThread {
  /** The chatter of each template's build of the model (undefined: a build made before the chatter was keyed). */
  readonly chatters: () => readonly ThreadChatterOf[];
  readonly creationSubtype: ((env: Environment, id: number) => Promise<number | false>) | undefined;
}
const COMPILED_THREADS = new Map<string, CompiledThread>();
const ON_THREAD: ((model: string) => void)[] = [];

/** A compiled thread model joins the generic chatter (and the RPC methods registered per generic thread model). */
export function registerCompiledThread(model: string, thread: CompiledThread): void {
  if (Object.hasOwn(THREAD_MODELS, model) || COMPILED_THREADS.has(model)) return;
  COMPILED_THREADS.set(model, thread);
  if (compiledSpec(model) !== null) for (const cb of ON_THREAD) cb(model);
}

/** `cb` for every generic thread model, now and as compiled ones are registered (post.ts, actions.ts RPC methods). */
export function forEachGenericThread(cb: (model: string) => void): void {
  ON_THREAD.push(cb);
  for (const model of genericThreadModels()) cb(model);
}

/**
 * The chatter of a compiled thread model: the same in every template that builds it, else null (the model then keeps
 * the paths for models without a generic chatter, which refuse). A refused chatter is null too.
 */
function compiledSpec(model: string): ThreadModel | null {
  const t = COMPILED_THREADS.get(model);
  if (t === undefined) return null;
  const all = t.chatters();
  const first = all[0];
  if (first === undefined || 'refused' in first) return null;
  for (const c of all) if (c === undefined || 'refused' in c || JSON.stringify(c) !== JSON.stringify(first)) return null;
  return { postAccess: first.postAccess, primaryEmail: first.primaryEmail, subjectSuggested: first.subjectSuggested, creationSubtype: null, mainAttachment: first.mainAttachment };
}

/** Why a compiled thread model has no generic chatter (the build's refusal), for the refusals of its callers. */
export function chatterRefusal(model: string): string | null {
  const t = COMPILED_THREADS.get(model);
  if (t === undefined || compiledSpec(model) !== null) return null;
  const why = t.chatters().map((c) => c === undefined ? 'built before the chatter was keyed' : 'refused' in c ? c.refused : null).filter((w) => w !== null);
  return why.length ? why.join('; ') : 'different chatters in its templates';
}

/** The `_creation_subtype` of one record as a subtype id (null: none): account_move.py:8069-8074 depends on the move type. */
async function creationSubtypeOf(env: Environment, model: string, id: number): Promise<number | null> {
  const compiled = COMPILED_THREADS.get(model);
  if (compiled !== undefined) {
    spec(model);
    return compiled.creationSubtype ? (await compiled.creationSubtype(env, id)) || null : null;
  }
  let xmlid: string | null;
  if (model !== 'account.move') xmlid = spec(model).creationSubtype;
  else {
    const t = (await env.cr.query<{ t: string }>('SELECT move_type AS t FROM account_move WHERE id = $1', [id])).rows[0]?.t;
    xmlid = t === 'out_invoice' || t === 'out_receipt' ? 'account.mt_invoice_created' : null;
  }
  return xmlid === null ? null : xmlidToResId(env.cr, xmlid);
}

/** crm/models/crm_lead.py: _primary_email (:98), _creation_subtype -> crm.mt_lead_create (:2049-2050). */
const THREAD_MODELS: Readonly<Record<string, ThreadModel>> = {
  'crm.lead': { postAccess: 'write', primaryEmail: 'email_from', subjectSuggested: true, creationSubtype: 'crm.mt_lead_create' },
  // sales_team/models/crm_team.py:14 `_mail_post_access = 'read'`; mail_thread.py:148 `_primary_email = 'email'`
  // (no such field on crm.team), :509 no creation subtype
  'crm.team': { postAccess: 'read', primaryEmail: 'email', subjectSuggested: false, creationSubtype: null },
  // product/models/product_category.py:8-10 plain mail.thread: mail_thread.py:147-148 defaults, no creation subtype
  'product.category': { postAccess: 'write', primaryEmail: 'email', subjectSuggested: false, creationSubtype: null },
  // account/models/account_tax.py:58 plain mail.thread
  'account.tax': { postAccess: 'write', primaryEmail: 'email', subjectSuggested: false, creationSubtype: null },
  // calendar/models/calendar_event.py:100-101 (`_mail_post_access = 'read'`, default primary email, no creation subtype)
  'calendar.event': { postAccess: 'read', primaryEmail: 'email', subjectSuggested: false, creationSubtype: null },
  // project/models/project_task.py:103-106, :1648-1649 `_creation_subtype` project.mt_task_new
  'project.task': { postAccess: 'read', primaryEmail: 'email_from', subjectSuggested: false, creationSubtype: 'project.mt_task_new' },
  // project/models/project_project.py:26-33 (mail.thread defaults, no creation subtype)
  'project.project': { postAccess: 'write', primaryEmail: 'email', subjectSuggested: false, creationSubtype: null },
  // product/models/product_template.py:21, product_product.py:20: mail.thread defaults, no creation subtype
  'product.template': { postAccess: 'write', primaryEmail: 'email', subjectSuggested: false, creationSubtype: null },
  'product.product': { postAccess: 'write', primaryEmail: 'email', subjectSuggested: false, creationSubtype: null },
  // stock/models/stock_lot.py:26, stock_picking.py:20: mail.thread defaults
  'stock.lot': { postAccess: 'write', primaryEmail: 'email', subjectSuggested: false, creationSubtype: null },
  'stock.picking': { postAccess: 'write', primaryEmail: 'email', subjectSuggested: false, creationSubtype: null },
  // purchase/models/purchase_order.py:23-27 (`_mail_post_access = 'read'`)
  'purchase.order': { postAccess: 'read', primaryEmail: 'email', subjectSuggested: false, creationSubtype: null },
  // sale/models/sale_order.py:38-49 (mail.thread.subject.suggested, `_mail_post_access = 'read'`)
  'sale.order': { postAccess: 'read', primaryEmail: 'email', subjectSuggested: true, creationSubtype: null },
  // account/models/account_move.py:84-87 (mail.thread.main.attachment, `_mail_post_access = 'read'`); the creation
  // subtype depends on the move type (:8069-8074, see creationSubtypeOf)
  'account.move': { postAccess: 'read', primaryEmail: 'email', subjectSuggested: false, creationSubtype: null, mainAttachment: true },
  // account/models/account_payment.py:9 (mail.thread.main.attachment, mail thread defaults)
  'account.payment': { postAccess: 'write', primaryEmail: 'email', subjectSuggested: false, creationSubtype: null, mainAttachment: true },
  // account/models/account_account.py:25-27 (mail.thread and mail.activity.mixin defaults, no mail override)
  'account.account': { postAccess: 'write', primaryEmail: 'email', subjectSuggested: false, creationSubtype: null },
  // account/models/account_journal.py:42 (mail.thread defaults)
  'account.journal': { postAccess: 'write', primaryEmail: 'email', subjectSuggested: false, creationSubtype: null },
  // mail/models/res_users.py:23-24 (`_mail_post_access = 'read'`); mail/models/res_company.py (mail.thread defaults)
  'res.users': { postAccess: 'read', primaryEmail: 'email', subjectSuggested: false, creationSubtype: null },
  'res.company': { postAccess: 'write', primaryEmail: 'email', subjectSuggested: false, creationSubtype: null },
};

/** The model's `_mail_post_access` (mail_thread.py:147): the document access needed to post on it. */
export function postAccessOf(model: string): 'read' | 'write' {
  return spec(model).postAccess === 'read' ? 'read' : 'write';
}

/** The generic thread models: the hand port's (THREAD_MODELS) and the compiled ones with a chatter. */
export function genericThreadModels(): string[] {
  return [...Object.keys(THREAD_MODELS), ...[...COMPILED_THREADS.keys()].filter((m) => compiledSpec(m) !== null)];
}

/** A mail.thread model a new module introduces whose build gave it the generic chatter (registerCompiledThread). */
export function isCompiledThread(model: string): boolean {
  return !Object.hasOwn(THREAD_MODELS, model) && compiledSpec(model) !== null;
}

export function isGenericThread(model: string): boolean {
  return Object.hasOwn(THREAD_MODELS, model) || compiledSpec(model) !== null;
}

function spec(model: string): ThreadModel {
  const s = Object.hasOwn(THREAD_MODELS, model) ? THREAD_MODELS[model] : compiledSpec(model) ?? undefined;
  if (s === undefined) {
    const why = chatterRefusal(model);
    throw new NotPorted(`chatter of ${model} threads${why ? ` (${why})` : ''}`);
  }
  return s;
}

export async function permissionOn(env: Environment, model: string, id: number, operation: 'read' | 'write'): Promise<boolean> {
  const rule = await env.model(model).accessDomain(operation);
  return (await env.sudo().withContext({ ...env.context, active_test: false }).model(model).search(and([cond('id', '=', id), rule ?? TRUE]))).length > 0;
}

/**
 * mail_thread.py:3173-3195 `_message_compute_parent_id(False)` for `_mail_flat_thread` models (all generic thread
 * models keep the default True): the record's latest comment/email, else its latest message (by date, id),
 * user notifications excluded; at most the 200 latest by date are considered.
 */
export async function flatThreadParent(env: Environment, model: string, id: number): Promise<number | false> {
  spec(model);
  return flatParent(env, model, id);
}

/**
 * The same parent for any mail.thread model that keeps `_mail_flat_thread = True` (mail_thread.py:145): every model of
 * Community and OCA but res.partner and discuss.channel (mail res_partner.py:18, discuss_channel.py:88), which refuse.
 * For a module's model the hand port has no chatter of (a compiled thread model's tracking post, write_hooks.ts).
 */
export async function flatParent(env: Environment, model: string, id: number): Promise<number | false> {
  if (model === 'res.partner' || model === 'discuss.channel') throw new NotPorted(`the flat thread parent of ${model} (_mail_flat_thread False)`);
  const rows = (await env.cr.query<{ id: number; message_type: string; d: string }>(
    `SELECT id, message_type, COALESCE(date, create_date)::text AS d FROM mail_message
      WHERE res_id = $1 AND model = $2 AND message_type != 'user_notification' ORDER BY date DESC, id DESC LIMIT 200`, [id, model])).rows;
  const key = (m: { id: number; message_type: string; d: string }): [number, string, number] => [['comment', 'email'].includes(m.message_type) ? 1 : 0, m.d, m.id];
  rows.sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i]! < kb[i]! ? 1 : -1;
    return 0;
  });
  return rows[0]?.id ?? false;
}

/** `_mail_get_companies(default=env.company)` (mail/models/models.py:140-153) for one record. */
export async function recordCompany(env: Environment, model: string, id: number): Promise<number> {
  spec(model);
  const def = env.reg.model(model);
  if (def.fields.get('company_id')?.column) {
    const row = (await env.cr.query<{ company_id: number | null }>(`SELECT company_id FROM "${def.table}" WHERE id = $1`, [id])).rows[0];
    if (row?.company_id) return row.company_id;
  }
  return env.company();
}

/** The record responsible of `_notify_thread_with_out_of_office_get_additional_users` (mail_thread.py:4725-4726). */
export async function recordResponsible(env: Environment, model: string, id: number): Promise<number | null> {
  spec(model);
  const def = env.reg.model(model);
  if (!def.fields.get('user_id')?.column) return null;
  return (await env.cr.query<{ user_id: number | null }>(`SELECT user_id FROM "${def.table}" WHERE id = $1`, [id])).rows[0]?.user_id ?? null;
}

/** `_get_thread_with_access(thread_id)`: read access (`_mail_get_operation_for_mail_message_operation('read')`). */
export async function checkGenericThread(env: Environment, model: string, id: number): Promise<boolean> {
  spec(model);
  if (!(await userFlags(env.cr, env.uid)).isInternal) throw new NotPorted(`chatter of ${model} for non-internal users`);
  return permissionOn(env, model, id, 'read');
}

/** mail_message.py `_message_fetch` for the thread (same branches as thread.ts fetchMessages). */
export async function fetchGenericMessages(env: Environment, model: string, id: number, params: Record<string, unknown>, store: Store, dataId: number | null): Promise<number[]> {
  for (const k of Object.keys(params)) if (!['limit', 'before', 'after'].includes(k)) throw new NotPorted(`message fetch ${k}`);
  const domain: unknown[] = [['model', '=', model], ['res_id', '=', id], ['message_type', '!=', 'user_notification']];
  if (params['before']) domain.push(['id', '<', params['before']]);
  if (params['after']) domain.push(['id', '>', params['after']]);
  const ids = await env.sudo().model('mail.message').search(parseDomain(domain), { limit: Number(params['limit'] ?? 30), order: params['after'] ? 'id ASC' : 'id DESC' });
  if (params['after']) ids.sort((a, b) => b - a);
  if (ids.length && !(await userFlags(env.cr, env.uid)).isPublic) {
    const ctx = requestOfCursor(env.cr);
    const partnerId = (await userInfo(env)).partnerId;
    if (ctx !== null) {
      await setMessageDone(ctx, env, ids, partnerId);
    } else {
      await env.cr.query(
        `UPDATE mail_notification SET is_read = true, read_date = date_trunc('second', now() AT TIME ZONE 'UTC')
          WHERE mail_message_id = ANY($1::int[]) AND res_partner_id = $2 AND is_read IS NOT TRUE`,
        [ids, partnerId],
      );
    }
  }
  if (dataId !== null) store.add('DataResponse', dataId, { _resolve: true, messages: ids }, false);
  return ids;
}

/** `_sort_suggested_messages` (models.py:553-568): the thread's comment/email messages of the discussion subtypes. */
async function suggestedMessages(env: Environment, model: string, id: number): Promise<number[]> {
  const subtypes: number[] = [];
  const creation = await creationSubtypeOf(env, model, id);
  if (creation !== null) subtypes.push(creation);
  const comment = await xmlidToResId(env.cr, 'mail.mt_comment');
  if (comment !== null) subtypes.push(comment);
  return env.sudo().model('mail.message').search(parseDomain([['model', '=', model], ['res_id', '=', id],
    ['message_type', 'in', ['email', 'comment']], ['subtype_id', 'in', subtypes]]), { order: 'date DESC, id DESC' });
}

export async function genericThreadFields(env: Environment, model: string, id: number, requests: string[], store: Store): Promise<void> {
  const s = spec(model);
  const self = await userInfo(env), partners = new MailBootstrap(env, store);
  const thread = { id, model };
  const values: Record<string, unknown> = {
    ...thread, hasReadAccess: true, hasWriteAccess: await permissionOn(env, model, id, 'write'),
    // mail/models/models.py:94-104: posting needs `_mail_post_access`; only 'read' allows posting on readonly
    canPostOnReadonly: s.postAccess === 'read',
  };
  const known = new Set(['activities', 'attachments', 'contact_fields', 'defaultSubject', 'followers', 'has_pinned_messages',
    'scheduledMessages', 'showSubjectInSmallComposer', 'suggestedRecipients', 'suggestedSubject', 'display_name']);
  for (const r of requests) if (!known.has(r)) throw new NotPorted(`mail.thread request ${r}`);
  const name = (await env.sudo().model(model).displayName([id])).get(id) ?? '';
  if (requests.includes('activities') && env.reg.model(model).hasActivities) { // isinstance(self, mail.activity.mixin)
    // mail_thread.py:5299-5305: the thread's activities (active, as the user) with `_store_activity_fields`
    const ids = await env.sudo().withContext({ ...env.context, active_test: true }).model('mail.activity').search(parseDomain([['res_model', '=', model], ['res_id', '=', id]]));
    await activityStore(env, model, ids, store, partners);
    values['activities'] = ids;
  }
  if (requests.includes('attachments')) {
    // _get_mail_thread_data_attachments (mail_thread.py:5400): ir.attachment search excludes field attachments
    const ids = await env.sudo().model('ir.attachment').search(parseDomain([['res_model', '=', model], ['res_id', '=', id], ['res_field', '=', false]]), { order: 'id desc' });
    // account_move.py:8125-8128: `res | invoice_pdf_report_id` (attachments with res_field are excluded above)
    if (model === 'account.move') {
      const pdf = await env.model('ir.attachment').search(parseDomain([['res_model', '=', model], ['res_id', 'in', [id]], ['res_field', '=', 'invoice_pdf_report_file']]));
      const last = pdf[pdf.length - 1];
      if (last !== undefined && !ids.includes(last)) ids.push(last);
    }
    // mail_thread.py:5398: original_id/svg variants are not ported (as for partner threads, thread.ts)
    if (ids.length && (await env.cr.query('SELECT 1 FROM ir_attachment WHERE id = ANY($1::int[]) AND (original_id IS NOT NULL OR mimetype = $2 OR id IN (SELECT original_id FROM ir_attachment WHERE original_id IS NOT NULL))', [ids, 'image/svg+xml'])).rows.length) {
      throw new NotPorted('chatter attachments with original/svg variants');
    }
    for (const aid of ids) store.add('ir.attachment', aid, await attachmentStoreFields(env, aid));
    Object.assign(values, { attachments: ids, areAttachmentsLoaded: true, isLoadingAttachments: false });
    if (s.mainAttachment) {
      const def = env.reg.model(model);
      values['message_main_attachment_id'] = (await env.cr.query<{ a: number | null }>(`SELECT message_main_attachment_id AS a FROM "${def.table}" WHERE id = $1`, [id])).rows[0]?.a ?? false;
    }
  }
  if (requests.includes('contact_fields')) {
    const def = env.reg.model(model);
    // models.py:163-181 `_mail_get_partner_fields`, :204-210 `_mail_get_primary_email_field`
    Object.assign(values, {
      primary_email_field: s.primaryEmail !== null && def.fields.has(s.primaryEmail) ? s.primaryEmail : null,
      partner_fields: ['partner_id', 'partner_ids'].filter((f) => def.fields.has(f)),
    });
  }
  // mail_thread.py:3198-3205 `_message_compute_subject`
  const computedSubject = textwrapShorten(name, 100, '...');
  if (requests.includes('defaultSubject')) values['defaultSubject'] = computedSubject;
  if (requests.includes('followers')) {
    const ids = await env.model('mail.followers').search(parseDomain([['res_model', '=', model], ['res_id', '=', id]]), { order: 'id' });
    const followers = await env.sudo().model('mail.followers').read(ids, ['partner_id', 'name', 'email', 'is_active', 'subtype_ids'], 'web');
    const own = followers.find((f) => f['partner_id'] === self.partnerId), others = followers.filter((f) => f['partner_id'] !== self.partnerId);
    const comment = await xmlidToResId(env.cr, 'mail.mt_comment');
    const activePartners = new Set((await env.cr.query<{ id: number }>('SELECT id FROM res_partner WHERE active AND id = ANY($1::int[])',
      [followers.map((f) => Number(f['partner_id']))])).rows.map((r) => r.id));
    const recipients = others.filter((f) => activePartners.has(Number(f['partner_id'])) && (f['subtype_ids'] as number[]).includes(comment ?? -1));
    Object.assign(values, {
      followersCount: ids.length, selfFollower: own?.['id'] ?? false, followers: others.slice(0, 100).map((f) => f['id']),
      recipientsCount: recipients.length, recipients: recipients.slice(0, 100).map((f) => f['id']),
    });
    const all = [...(own ? [own] : []), ...others.slice(0, 100), ...recipients.slice(0, 100)], seen = new Set<number>();
    for (const f of all) {
      const fid = Number(f['id']);
      if (seen.has(fid)) continue;
      seen.add(fid);
      const pid = Number(f['partner_id']);
      store.add('mail.followers', fid, { name: f['name'], email: f['email'], is_active: f['is_active'], partner_id: pid, display_name: (await env.sudo().model('res.partner').displayName([pid])).get(pid), thread });
      await partners.partner(pid, true);
    }
  }
  // project_project.py:1239-1242: project followers come with the project's collaborators (`collaborator_ids`)
  if (model === 'project.project' && requests.includes('followers')) {
    const collaborators = [...new Set((await env.cr.query<{ p: number }>('SELECT partner_id AS p FROM project_collaborator WHERE project_id = $1 ORDER BY id', [id])).rows.map((r) => r.p))];
    values['collaborator_ids'] = collaborators;
  }
  if (requests.includes('has_pinned_messages')) {
    values['has_pinned_messages'] = (await env.sudo().model('mail.message').searchCount(parseDomain([['model', '=', model], ['res_id', '=', id], ['pinned_at', '!=', false]]))) > 0;
  }
  if (requests.includes('scheduledMessages')) {
    const ids = await env.sudo().model('mail.scheduled.message').search(parseDomain([['model', '=', model], ['res_id', '=', id]]));
    if (ids.length) throw new NotPorted('scheduled chatter messages');
    values['scheduledMessages'] = [];
  }
  if (requests.includes('display_name')) values['display_name'] = (await env.model(model).displayName([id])).get(id);
  if (requests.includes('suggestedRecipients')) values['suggestedRecipients'] = await suggestedRecipients(env, model, id);
  if (s.subjectSuggested) {
    if (requests.includes('showSubjectInSmallComposer')) values['showSubjectInSmallComposer'] = true;
    if (requests.includes('suggestedSubject')) {
      // mail_thread_subject_suggested.py:19-27: the last discussion message's subject, else the computed one
      const msgs = await suggestedMessages(env, model, id);
      let subject = computedSubject;
      if (msgs.length) {
        const m = (await env.sudo().model('mail.message').read([msgs[0]!], ['subject'], 'web'))[0]!;
        if (m['subject']) subject = String(m['subject']);
      }
      values['suggestedSubject'] = subject;
    }
  } else if (requests.includes('showSubjectInSmallComposer') || requests.includes('suggestedSubject')) {
    // base mail.thread `_store_thread_fields` has no such fields: only the subject.suggested mixin answers them
  }
  store.add('mail.thread', `${model}:${id}`, values);
}

/**
 * webclient.py:94-99 the `mail.activity` store handler: `search_fetch([('id', 'in', ids)])` as the user with
 * active_test=False (the default order `date_deadline ASC, id ASC`; mail_activity.py:416-463 `_search` keeps the
 * readable ones), then `_store_activity_fields` of each, in that order.
 */
export async function activitiesByIds(env: Environment, ids: unknown, store: Store): Promise<void> {
  if (!Array.isArray(ids) || ids.some((id) => !Number.isInteger(id))) throw new NotPorted('mail.activity store handler without a list of ids');
  const found = await env.withContext({ ...env.context, active_test: false }).model('mail.activity').search(cond('id', 'in', ids), { order: 'date_deadline ASC, id ASC' });
  if (!found.length) return;
  const rows = new Map((await env.cr.query<{ id: number; res_model: string | null; user_id: number | null }>(
    'SELECT id, res_model, user_id FROM mail_activity WHERE id = ANY($1::int[])', [found])).rows.map((r) => [r.id, r]));
  const partners = new MailBootstrap(env, store);
  for (const id of found) {
    const r = rows.get(id)!;
    // `can_write` of a personal activity (no document) assigned to someone else: mail.activity's own rules, not ported
    if (!r.res_model && r.user_id !== env.uid) throw new NotPorted('mail.activity Store of a personal activity of another user');
    await activityStore(env, r.res_model ?? '', [id], store, partners);
  }
}

/**
 * mail_activity.py:817-828 `_store_activity_fields` with calendar's override (calendar/models/mail_activity.py:96-99:
 * `res_name` and `calendar_event_id`), as thread.ts does for partner threads.
 */
async function activityStore(env: Environment, model: string, ids: number[], store: Store, partners: MailBootstrap): Promise<void> {
  const fields = ['activity_category', 'activity_type_id', 'create_date', 'create_uid', 'date_deadline', 'date_done', 'icon', 'note', 'phone',
    'res_id', 'res_model', 'role_id', 'user_id', 'attachment_ids', 'mail_template_ids', 'summary', 'user_tz', 'active'];
  if (env.reg.models.has('calendar.event')) fields.push('res_name', 'calendar_event_id');
  const rows = await env.sudo().model('mail.activity').read(ids, fields, 'web');
  const self = await userInfo(env), now = await dbNow(env);
  for (const a of rows) {
    if (a['calendar_event_id']) await calendarEventStore(env, Number(a['calendar_event_id']), store);
    let typeName: unknown = false;
    if (a['activity_type_id']) {
      const type = (await env.sudo().model('mail.activity.type').read([Number(a['activity_type_id'])], ['name'], 'web'))[0];
      if (type) {
        typeName = type['name'];
        store.add('mail.activity.type', Number(type['id']), { name: type['name'] });
      }
    }
    if (a['create_uid']) {
      const creator = (await env.sudo().model('res.users').read([Number(a['create_uid'])], ['partner_id'], 'web'))[0];
      if (creator) {
        store.add('res.users', Number(creator['id']), { partner_id: creator['partner_id'] });
        if (creator['partner_id']) {
          const cp = (await env.sudo().model('res.partner').read([Number(creator['partner_id'])], ['name'], 'web'))[0];
          if (cp) store.add('res.partner', Number(cp['id']), { name: cp['name'] });
        }
      }
    }
    if (a['user_id']) {
      const user = (await env.sudo().model('res.users').read([Number(a['user_id'])], ['partner_id'], 'web'))[0];
      if (user) {
        store.add('res.users', Number(user['id']), { partner_id: user['partner_id'] });
        if (user['partner_id']) await partners.partner(Number(user['partner_id']), true);
      }
    }
    if (a['role_id']) {
      const role = (await env.sudo().model('res.role').read([Number(a['role_id'])], ['name'], 'web'))[0];
      if (role) store.add('res.role', Number(role['id']), { name: role['name'] });
    }
    for (const [field, m] of [['attachment_ids', 'ir.attachment'], ['mail_template_ids', 'mail.template']] as const) {
      for (const row of await env.sudo().model(m).read(a[field] as number[], ['name'], 'web')) store.add(m, Number(row['id']), { name: row['name'] });
    }
    // mail_activity.py:225-237 state in the activity's user_tz, else the context/user tz
    const day = todayInTz(now, String(a['user_tz'] || env.context['tz'] || self.tz || 'UTC')), deadline = String(a['date_deadline']);
    const { user_tz: _tz, active: _active, ...rest } = a;
    // `can_write` (mail_activity.py:239-242): ir.access of mail.activity, i.e. the assignee or write access to the document
    const canWrite = a['user_id'] === env.uid || await permissionOn(env, model, Number(a['res_id']), 'write');
    store.add('mail.activity', Number(a['id']), {
      ...rest, note: a['note'] ? ['markup', a['note']] : false, can_write: canWrite, display_name: a['summary'] || typeName,
      state: !a['active'] ? 'done' : deadline < day ? 'overdue' : deadline === day ? 'today' : 'planned',
    });
  }
}

/**
 * calendar_event.py:2180-2182 `_store_calendar_event_fields` of an activity's meeting (calendar/models/mail_activity.py:99
 * `res.one`): its name, times, locations and attendees' names, read as the user (another's private event refuses).
 */
export async function calendarEventStore(env: Environment, id: number, store: Store): Promise<void> {
  const ev = (await env.cr.query<{ privacy: string | null; user_id: number | null }>('SELECT privacy, user_id FROM calendar_event WHERE id = $1', [id])).rows[0];
  if (ev && ev.privacy === 'private' && ev.user_id !== env.uid) throw new NotPorted("activity calendar event Store fields of another user's private event");
  const row = (await env.model('calendar.event').read([id], ['name', 'start', 'stop', 'location', 'videocall_location', 'partner_ids'], 'web'))[0];
  if (!row) throw new NotPorted('activity calendar event Store fields of an event the user cannot read');
  const partners = Array.isArray(row['partner_ids']) ? (row['partner_ids'] as unknown[]).map(Number) : [];
  store.add('calendar.event', id, { name: row['name'], start: row['start'], stop: row['stop'], location: row['location'], videocall_location: row['videocall_location'], partner_ids: partners });
  for (const p of await env.model('res.partner').read(partners, ['name'], 'web')) store.add('res.partner', Number(p['id']), { name: p['name'] });
}

/** tools/mail.py email_normalize (strict=False is the same for single addresses): lowercased addr-spec. */
function emailNormalize(email: string | null): string | null {
  if (!email) return null;
  const m = /<([^<>]+)>\s*$/.exec(email);
  const addr = (m ? m[1]! : email).trim();
  if (!/^[^\s@,<>]+@[^\s@,<>]+$/.test(addr)) return null;
  return addr.toLowerCase();
}

interface PartnerRow { id: number; name: string | null; email: string | null; email_normalized: string | null; partner_share: boolean | null; active: boolean | null }

/**
 * models.py:398-551 `_message_get_suggested_recipients_batch(reply_discussion=True, no_create=True)` with
 * `_message_add_suggested_recipients` (:367-396) and `_message_add_default_recipients` (:238-285).
 */
/**
 * `record.message_partner_ids` read as the user (mail/models/models.py:466, :486): `_compute_message_partner_ids`
 * (mail_thread.py:185-189, internal users) assigns the followers' partners, and the many2many write checks read
 * access on them (odoo/orm/fields_relational.py:1588-1594): a follower the user cannot read (another company's
 * contact) fails the whole request with "Failed to write field <model>.message_partner_ids" and the record error.
 */
export async function followerPartnersAsUser(env: Environment, model: string, id: number): Promise<number[]> {
  const followers = (await env.cr.query<{ partner_id: number }>('SELECT partner_id FROM mail_followers WHERE res_model = $1 AND res_id = $2 ORDER BY id', [model, id])).rows.map((f) => f.partner_id);
  if (env.su || !followers.length) return followers;
  if (!(await userFlags(env.cr, env.uid)).isInternal) throw new NotPorted('message_partner_ids of a non-internal user (searchable partners only)');
  try {
    await env.model('res.partner').checkAccess(followers, 'read');
  } catch (e) {
    if (e instanceof AccessError) throw new AccessError(`Failed to write field ${model}.message_partner_ids\n${e.message}`);
    throw e;
  }
  return followers;
}

export async function suggestedSubjectFor(env: Environment, model: string, id: number): Promise<string> {
  const name = (await env.sudo().model(model).displayName([id])).get(id) ?? '';
  const def = env.reg.model(model);
  if (!def.isMailThread) return name;
  const computedSubject = textwrapShorten(name, 100, '...');
  const s = Object.hasOwn(THREAD_MODELS, model) ? THREAD_MODELS[model] : compiledSpec(model) ?? undefined;
  if (s?.subjectSuggested) {
    const msgs = await suggestedMessages(env, model, id);
    if (msgs.length) {
      const m = (await env.sudo().model('mail.message').read([msgs[0]!], ['subject'], 'web'))[0]!;
      if (m['subject']) return String(m['subject']);
    }
  }
  return computedSubject;
}

export async function suggestedRecipients(env: Environment, model: string, id: number): Promise<Array<{
  email: string | false; name: string | false; partner_id: number | false;
  create_values: Record<string, unknown>; recipient_type: 'to' | 'cc'; display_name?: string | undefined;
}>> {
  const s = spec(model);
  const self = await userInfo(env);
  const def = env.reg.model(model);
  const cols = ['user_id', 'partner_id', ...(s.primaryEmail !== null ? [s.primaryEmail] : [])].filter((f) => def.fields.get(f)?.column);
  for (const f of ['email_cc', 'partner_email_cc', 'x_email_cc']) {
    if (def.fields.has(f)) throw new NotPorted(`suggested recipients with ${model}.${f}`);
  }
  const row = (await env.cr.query<Record<string, unknown>>(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${def.table}" WHERE id = $1`, [id])).rows[0] ?? {};
  // a related responsible (account_move.py:727 user_id related to invoice_user_id) has no column
  if (def.fields.get('user_id')?.related) {
    const v = (await env.sudo().model(model).read([id], ['user_id'], ''))[0]?.['user_id'];
    row['user_id'] = Array.isArray(v) ? v[0] : v;
  }
  // suggested partners: the responsible's partner unless it is the user's, then the customers (_mail_get_partners)
  const partners: number[] = [];
  if (row['user_id']) {
    const u = (await env.cr.query<{ partner_id: number }>('SELECT partner_id FROM res_users WHERE id = $1', [row['user_id']])).rows[0];
    if (u && u.partner_id !== self.partnerId) partners.push(u.partner_id);
  }
  // models.py:163-201 `_mail_get_partners`: the values of partner_id then partner_ids, whichever exist (a related
  // partner_id such as calendar.event's is read too), without duplicates
  const defaults: number[] = [];
  const partnerFields = ['partner_id', 'partner_ids'].filter((f) => def.fields.get(f)?.relation === 'res.partner');
  if (partnerFields.length) {
    const rec = (await env.model(model).read([id], partnerFields, ''))[0] ?? {};
    for (const f of partnerFields) {
      const v = rec[f];
      const ids = Array.isArray(v) ? (f === 'partner_id' ? [v[0] as number] : (v as number[])) : typeof v === 'number' ? [v] : [];
      for (const p of ids) if (p && !defaults.includes(p)) defaults.push(p);
    }
  }
  for (const p of defaults) if (!partners.includes(p)) partners.push(p);
  // email_to_lst: the primary email (email_split_and_format_normalize)
  const primary = s.primaryEmail !== null && typeof row[s.primaryEmail] === 'string' ? String(row[s.primaryEmail]) : '';
  if (primary.includes(',')) throw new NotPorted('suggested recipients from several primary emails');
  const emailTo = primary ? [emailNormalize(primary) ?? primary] : [];
  // an unnormalizable value is kept as is (models.py:265 `... or [email_to]`); without '@' email_split_tuples finds
  // no address in it, so it proposes nothing later (tools/mail.py:844-850)
  if (emailTo.length && emailNormalize(primary) === null && primary.includes('@')) throw new NotPorted('suggested recipients from an invalid primary email');
  // answers: the last discussion message (reply_discussion=True, models.py:432-458)
  const emailCc: string[] = [];
  const ccPartners: number[] = [];
  const recordPartners = [...partners]; // suggested_record[record.id]['partners']
  const lastMsg = (await suggestedMessages(env, model, id))[0];
  if (lastMsg !== undefined) {
    const m = (await env.cr.query<{ author_id: number | null; email_from: string | null; incoming_email_to: string | null; incoming_email_cc: string | null }>(
      'SELECT author_id, email_from, incoming_email_to, incoming_email_cc FROM mail_message WHERE id = $1', [lastMsg])).rows[0]!;
    // `partner_ids` / `partner_cc_ids` read in the comodel's order (res.partner `complete_name, id desc`), the active ones
    const related = async (table: string): Promise<number[]> => {
      const ids = (await env.cr.query<{ id: number }>(
        `SELECT p.id FROM ${table} r JOIN res_partner p ON p.id = r.res_partner_id WHERE r.mail_message_id = $1 AND p.active`, [lastMsg])).rows.map((r) => r.id);
      return ids.length > 1 ? env.sudo().model('res.partner').search(cond('id', 'in', ids), { activeTest: false }) : ids;
    };
    const direct = await related('mail_message_res_partner_rel');
    const cc = await related('mail_message_res_partner_cc_rel');
    // `(partner_ids | author_id).filtered(active)`: recordset union keeps the partners' order (prefetch order)
    const authorActive = m.author_id !== null && (await env.cr.query('SELECT 1 FROM res_partner WHERE id = $1 AND active', [m.author_id])).rows.length > 0;
    for (const pid of [...direct, ...(authorActive && m.author_id !== null ? [m.author_id] : [])]) if (!partners.includes(pid)) partners.push(pid);
    for (const pid of cc) if (!ccPartners.includes(pid)) ccPartners.push(pid);
    emailTo.push(...emailSplitAndFormat(m.incoming_email_to), ...(m.email_from ? [m.email_from] : []));
    emailCc.push(...emailSplitAndFormat(m.incoming_email_cc));
    const fromNormalized = emailNormalize(m.email_from);
    const authorNormalized = m.author_id === null ? null
      : (await env.cr.query<{ email_normalized: string | null }>('SELECT email_normalized FROM res_partner WHERE id = $1', [m.author_id])).rows[0]?.email_normalized ?? null;
    if (fromNormalized && fromNormalized !== authorNormalized) emailTo.push(m.email_from!);
  }
  const key = (e: string): string => emailNormalize(e) ?? e.trim();
  const followers = await followerPartnersAsUser(env, model, id);
  const rows = (await env.cr.query<PartnerRow>('SELECT id, name, email, email_normalized, partner_share, active FROM res_partner WHERE id = ANY($1::int[])',
    [[...new Set([...partners, ...ccPartners, ...followers])]])).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const skip = new Set<string>();
  for (const pid of [...followers, ...partners, ...ccPartners]) {
    const p = byId.get(pid);
    if (p?.email_normalized) skip.add(p.email_normalized);
    if (p?.email) skip.add(p.email);
  }
  // ban: OdooBot and aliases (alias domains' bounce/catchall/default-from addresses, aliases)
  const bot = await xmlidToResId(env.cr, 'base.partner_root');
  const botEmail = (await env.cr.query<{ email_normalized: string | null }>('SELECT email_normalized FROM res_partner WHERE id = $1', [bot])).rows[0]?.email_normalized ?? null;
  const publicIds = new Set((await env.cr.query<{ partner_id: number }>(
    `SELECT u.partner_id FROM res_users u JOIN res_groups_users_rel r ON r.uid = u.id JOIN ir_model_data d ON d.model = 'res.groups' AND d.res_id = r.gid
      AND d.module = 'base' AND d.name = 'group_public'`)).rows.map((r) => r.partner_id));
  const isAlias = await aliasMatcher(env);
  const banned = (email: string | null): boolean => email === botEmail || isAlias(email);
  // records_emails (:466-475): the emails not already held by followers / suggested partners
  const recordEmails = [...emailTo, ...emailCc].flatMap((e) => emailSplitAndFormat(e)).filter((e) => e.trim() && !skip.has(key(e)));
  const found: number[] = [];
  if (recordEmails.length) {
    // mail_thread.py:2071-2174 `_partner_find_from_emails(no_create=True)` -> res_partner.py:101-215: search by
    // email_normalized (id ASC), banned emails excluded; one candidate per email (the sort_key only orders ties)
    const wanted = [...new Set(recordEmails.map((e) => emailNormalize(e)).filter((e): e is string => e !== null && !banned(e)))];
    if (recordEmails.some((e) => emailNormalize(e) === null)) throw new NotPorted('suggested recipients from invalid loose emails');
    const ids = wanted.length ? await env.model('res.partner').search(cond('email_normalized', 'in', wanted), { order: 'id ASC' }) : [];
    const foundRows = (await env.cr.query<PartnerRow>('SELECT id, name, email, email_normalized, partner_share, active FROM res_partner WHERE id = ANY($1::int[])', [ids])).rows;
    for (const e of wanted) {
      const candidates = foundRows.filter((r) => r.email_normalized === e);
      if (candidates.length > 1) throw new NotPorted('suggested recipient email matching several partners (sort_key)');
      if (candidates.length === 0) continue;
      const c = candidates[0]!;
      byId.set(c.id, c);
      found.push(c.id);
    }
  }
  const out: Array<{
    email: string | false; name: string | false; partner_id: number | false;
    create_values: Record<string, unknown>; recipient_type: 'to' | 'cc'; display_name?: string | undefined;
  }> = [];
  const seen = new Set<number>();
  // cc_partners_filter (:511-517): cc partners, and partners only reached through a cc email
  const ccFilter = new Set<number>(ccPartners);
  const partnerEmails = new Set(partners.map((pid) => byId.get(pid)?.email).filter((e): e is string => !!e).map(key));
  const toKeys = new Set(emailTo.map(key));
  const ccOnly = new Set(emailCc.map(key).filter((k) => !partnerEmails.has(k) && !toKeys.has(k)));
  const kept: number[] = [];
  for (const pid of [...partners, ...ccPartners, ...found]) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    const p = byId.get(pid);
    if (p === undefined) continue;
    // skip followers, unless being a customer suggested by the record (and a portal/customer partner)
    if (followers.includes(pid) && !(recordPartners.includes(pid) && p.partner_share)) continue;
    if (banned(p.email_normalized) || publicIds.has(pid)) continue;
    kept.push(pid);
  }
  for (const pid of kept) {
    const p = byId.get(pid)!;
    if (p.email && ccOnly.has(key(p.email))) ccFilter.add(pid);
  }
  for (const pid of kept) {
    const p = byId.get(pid)!;
    out.push({
      ...(!p.name ? { display_name: (await env.sudo().model('res.partner').displayName([pid])).get(pid) } : {}),
      email: p.email_normalized || false, name: p.name || false, partner_id: pid, create_values: {},
      recipient_type: ccFilter.has(pid) ? 'cc' : 'to',
    });
  }
  // models.py:519-548: the emails no partner holds, with `_get_customer_information` as create values
  const existing = new Set<string>();
  for (const pid of [...followers, ...kept]) {
    const p = byId.get(pid) ?? (await env.cr.query<PartnerRow>('SELECT id, name, email, email_normalized, partner_share, active FROM res_partner WHERE id = $1', [pid])).rows[0];
    if (p?.email_normalized) existing.add(p.email_normalized);
    for (const e of emailSplitAndFormat(p?.email ?? null)) existing.add(key(e));
  }
  let info: Map<string, Record<string, unknown>> | null = null;
  for (const [lst, type] of [[emailTo, 'to'], [emailCc, 'cc']] as const) {
    const uniq = [...new Set(lst.flatMap((e) => emailSplitAndFormat(e)))]
      .filter((e) => e.trim() && !banned(key(e)) && !existing.has(key(e)));
    for (const e of uniq) {
      const [pname, normalized] = parseContactFromEmail(e);
      existing.add(key(e));
      info ??= await customerInformation(env, model, id);
      const values = { ...(info.get(normalized) ?? {}) };
      const name = values['name'];
      delete values['name'];
      out.push({ email: normalized, name: typeof name === 'string' && name ? name : pname, partner_id: false, create_values: values, recipient_type: type });
    }
  }
  return out;
}

/**
 * mail_alias_domain.py:203 `_find_aliases` as a test on one normalized email: an alias domain's bounce, catchall or
 * default-from address, or an alias (by its local part when it accepts any allowed catchall domain).
 */
export async function aliasMatcher(env: Environment): Promise<(email: string | null) => boolean> {
  const aliasDomains = await env.sudo().model('mail.alias.domain').read(await env.sudo().model('mail.alias.domain').search(TRUE), ['name', 'bounce_email', 'catchall_email', 'default_from_email'], 'web');
  const aliases = await env.sudo().model('mail.alias').read(await env.sudo().model('mail.alias').search(TRUE), ['alias_full_name', 'alias_name', 'alias_incoming_local'], 'web');
  const domains = (await icpStr(env.cr, 'mail.catchall.domain.allowed') || '').split(',').filter(Boolean);
  if (domains.length) domains.push(...aliasDomains.map((d) => String(d['name'])));
  return (email) => !!email && (
    aliasDomains.some((d) => ['bounce_email', 'catchall_email', 'default_from_email'].some((f) => d[f] === email))
    || aliases.some((a) => a['alias_incoming_local'] ? a['alias_name'] === email.split('@')[0] && (!domains.length || domains.includes(email.split('@')[1]!)) : a['alias_full_name'] === email));
}

/** tools/mail.py:816 email_split_tuples for the common shapes: `addr`, `Name <addr>`, `"Name" <addr>`, comma lists. */
export function emailSplitTuples(text: string | null): [string, string][] {
  if (!text) return [];
  const out: [string, string][] = [];
  for (const raw of text.match(/(?:"[^"]*"|[^,])+/g) ?? []) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(?:"([^"]*)"|([^<]*?))\s*<([^<>]+)>$/.exec(part);
    if (m) { out.push([(m[1] ?? m[2] ?? '').trim(), m[3]!.trim()]); continue; }
    if (/^[^\s@,<>"]+@[^\s@,<>"]+$/.test(part)) { out.push(['', part]); continue; }
    // tools/mail.py:844-850: getaddresses pairs without '@' are dropped
    if (!part.includes('@') && !part.includes('<')) continue;
    throw new NotPorted(`email_split_tuples of ${JSON.stringify(part)}`);
  }
  return out;
}

/** tools/mail.py:868 email_split_and_format (formataddr :1041: `"name" <addr>` or the bare address). */
function emailSplitAndFormat(text: string | null): string[] {
  return emailSplitTuples(text).map(([name, addr]) => {
    if (!name) return addr;
    if (/[^\x00-\x7f]/.test(name)) throw new NotPorted('formataddr of a non-ascii name');
    return `"${name.replace(/[\\"]/g, '\\$&')}" <${addr}>`;
  });
}

/** tools/mail.py:1111 parse_contact_from_email. */
export function parseContactFromEmail(text: string): [string, string] {
  const [first] = emailSplitTuples(text);
  if (!first) return [text, ''];
  return [first[0], emailNormalize(first[1]) ?? first[1]];
}

/**
 * crm_lead.py:1988-2004 `_get_customer_information` with `_prepare_customer_values` (:2006-2038) for one lead: the
 * create values keyed by the normalized email (falsy values and `email` dropped). Other models: none (mail_thread.py:2239).
 */
async function customerInformation(env: Environment, model: string, id: number): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (model !== 'crm.lead') {
    // the overrides in the source are crm.lead (below), hr.applicant and the test models (`def
    // _get_customer_information` in odoo/addons); a compiled thread model has none (its build refuses overrides of
    // mail's methods, compiler/oc/build.py `thread_chatter`), nor res.partner and the hand-listed thread models
    const known = model === 'res.partner' || isGenericThread(model);
    if (model === 'hr.applicant' || (!known && env.reg.model(model).modules?.some((m) => m !== 'mail'))) throw new NotPorted(`_get_customer_information of ${model}`);
    return out;
  }
  const [lead] = await env.sudo().model(model).read([id], ['email_normalized', 'email_from', 'contact_name', 'user_id', 'description', 'phone',
    'function', 'street', 'street2', 'zip', 'city', 'country_id', 'state_id', 'website', 'partner_name', 'lang_id'], '');
  if (lead === undefined) return out;
  const key = String(lead['email_normalized'] || lead['email_from'] || '');
  const from = typeof lead['email_from'] === 'string' ? lead['email_from'] : '';
  if (/[<,]/.test(from)) throw new NotPorted('parse_contact_from_email of a formatted lead email');
  const contactName = lead['contact_name'] || from;
  const vals: Record<string, unknown> = {
    name: contactName, user_id: env.context['default_user_id'] || lead['user_id'], comment: lead['description'], phone: lead['phone'],
    function: lead['function'], street: lead['street'], street2: lead['street2'], zip: lead['zip'], city: lead['city'],
    country_id: lead['country_id'], state_id: lead['state_id'], website: lead['website'], type: 'contact',
  };
  if (lead['partner_name']) vals['parent_name'] = lead['partner_name'];
  if (lead['lang_id']) {
    const l = (await env.cr.query<{ code: string; active: boolean }>('SELECT code, active FROM res_lang WHERE id = $1', [lead['lang_id']])).rows[0];
    if (l?.active) vals['lang'] = l.code;
  }
  out.set(key, Object.fromEntries(Object.entries(vals).filter(([k, v]) => v && k !== 'email')));
  return out;
}
