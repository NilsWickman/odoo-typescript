/**
 * `mail.activity.action_feedback` (odoo/addons/mail/models/mail_activity.py:655, `_action_done` :687): the
 * "activity done" message rendered from `mail.message_activity_done` (data/mail_templates_chatter.xml:12) through
 * `message_post_with_source` (mail_thread.py:2724), then the activity archived with its feedback and done date.
 * Ported for activities on partner threads without note, attachments or followers to notify.
 */
import { NotPorted } from '../errors';
import { dbNow, todayInTz, translate } from '../models/util';
import { registerMethod } from '../http/methods';
import { hooksOf, registerHooks } from '../orm/hooks';
import { messageSubscribe } from './followers';
import { phoneOfRecord } from '../models/mail_activity_write';
import { phoneGetFormatted } from '../models/phone_recipients';
import type { Environment } from '../orm/types';
import { envTz, userInfo } from '../orm/env';
import { busSend } from './busnotify';
import { computeAuthor, escapeText, insertMessages, replyToDefault, trackingMessageId, xmlid } from './message';
import { assertNoRecipients } from './post';
import { notifyThread } from './notify';
import { requestOfCursor } from '../http/context';
import { permission } from './thread';
import { flatThreadParent, isGenericThread, permissionOn, recordCompany } from './thread_generic';
import { checkActivityAccess } from '../models/mail_activity_access';
import { fieldOrder } from '../models/base_import';
import type { WrittenFields } from '../bus/presence';

interface ActivityRow {
  id: number; res_model: string | null; res_id: number | null; summary: string | null; note: string | null;
  user_id: number | null; activity_type_id: number | null; date_done: string | null; icon: string | null; user_name: string | null;
}

/**
 * The template's output after html_sanitize, with its QWeb whitespace as Odoo renders it (checked against Odoo for
 * summary/no summary, the assignee line, one and several feedback lines and empty lines).
 */
export function activityDoneBody(icon: string | null, summary: string | null, assignee: string | null, feedback: string | null): string {
  let out = `<div>\n    <p class="o_mail_activity_title mb-1">\n        <span class="oi oi-fw oi-filled"${icon ? ` data-icon="${escapeText(icon).replace(/"/g, '&quot;')}"` : ''}></span>`;
  if (summary) out += `\n        <span>${escapeText(summary)}</span>`;
  if (assignee !== null) out += `\n         (originally assigned to <span>${escapeText(assignee)}</span>)`;
  out += '\n    </p>';
  if (feedback) out += `\n    <div>\n            ${feedback.split('\n').map(escapeText).join('\n            <br>\n            ')}\n    </div>`;
  return `${out}\n</div>`;
}

export async function actionFeedback(env: Environment, ids: number[] | null, _args: unknown[], kwargs: Record<string, unknown>): Promise<unknown> {
  if (!ids || ids.length !== 1) throw new NotPorted('action_feedback on several activities');
  if ((kwargs['attachment_ids'] as unknown[] | undefined)?.length) throw new NotPorted('action_feedback with attachments');
  const feedback = typeof kwargs['feedback'] === 'string' && kwargs['feedback'] ? kwargs['feedback'] : null;
  if (kwargs['feedback'] !== undefined && kwargs['feedback'] !== false && typeof kwargs['feedback'] !== 'string') throw new NotPorted('feedback value');
  const a = (await env.cr.query<ActivityRow>(
    `SELECT a.id, a.res_model, a.res_id, a.summary, a.note, a.user_id, a.activity_type_id, a.date_done::text AS date_done,
            t.icon, p.name AS user_name
       FROM mail_activity a LEFT JOIN mail_activity_type t ON t.id = a.activity_type_id
       LEFT JOIN res_users u ON u.id = a.user_id LEFT JOIN res_partner p ON p.id = u.partner_id WHERE a.id = $1`, [ids[0]])).rows[0];
  if (!a) throw new NotPorted('action_feedback on a missing activity (MissingError)');
  // generic threads (crm.lead, thread_generic.ts) take the same path with their own access, company and flat parent;
  // personal activities (res_model IS NULL) post no message and are simply archived with feedback/date_done
  const model = a.res_model ?? '';
  const personal = !model;
  const generic = !personal && isGenericThread(model);
  if (!personal && ((model !== 'res.partner' && !generic) || !a.res_id)) throw new NotPorted(`activities on ${a.res_model}`);
  const resId = a.res_id ?? 0;
  // mail.activity write access (ir.access of mail.activity: assignee or writable document)
  if (a.user_id !== env.uid && (personal || !(await (generic ? permissionOn(env, model, resId, 'write') : permission(env, resId, 'write'))))) {
    throw new NotPorted('action_feedback without write access (AccessError)');
  }
  if (!personal && a.note && a.note.replace(/<[^>]*>/g, '').trim()) throw new NotPorted('activity done message with a note');
  const atts = (await env.cr.query<{ n: string }>(`SELECT count(*)::text n FROM ir_attachment WHERE res_model = 'mail.activity' AND res_id = $1`, [a.id])).rows[0];
  if (Number(atts?.n ?? 0) > 0) throw new NotPorted('attachments of done activities');
  let mid: number | false = false;
  if (!a.date_done && !personal) {
    const exists = (await env.cr.query(`SELECT 1 FROM "${env.reg.model(model).table}" WHERE id = $1`, [resId])).rows.length > 0;
    if (!exists) throw new NotPorted('done activity of a deleted record (activity unlinked)');
    // `message_post_with_source(..., author_id=env.user.partner_id, subtype_xmlid='mail.mt_activities')`
    const [authorId, emailFrom] = await computeAuthor(env, (await userInfo(env)).partnerId, null);
    const subtypeId = await xmlid(env, 'mail.mt_activities');
    const company = generic ? await recordCompany(env, model, resId)
      : (await env.cr.query<{ company_id: number | null }>('SELECT company_id FROM res_partner WHERE id = $1', [resId])).rows[0]?.company_id ?? await env.company();
    // mail_thread.py:3173 `_message_compute_parent_id`: flat threads attach to their latest message
    const parentId = generic ? await flatThreadParent(env, model, resId) : false;
    const body = activityDoneBody(a.icon, a.summary, a.user_id !== env.uid ? (a.user_name ?? '') : null, feedback);
    [mid] = await insertMessages(env, [{
      model, res_id: resId, body, author_id: authorId, email_from: emailFrom, message_type: 'notification', ...(parentId ? { parent_id: parentId } : {}),
      subtype_id: subtypeId, mail_activity_type_id: a.activity_type_id ?? false, subject: false, email_add_signature: true,
      record_alias_domain_id: false, record_company_id: company, reply_to: await replyToDefault(env, emailFrom),
      message_id: trackingMessageId(`${resId}-${model}`),
    }]) as [number];
    await assertNoRecipients(env, model, resId, subtypeId, []);
  }
  // `action_archive` + feedback: `_compute_date_done` stores the UTC date of now (mail_activity.py:160-165)
  await env.cr.query(`UPDATE mail_activity SET active = false,
      date_done = COALESCE(date_done, (now() AT TIME ZONE 'UTC')::date), feedback = COALESCE($2, feedback),
      write_uid = $3, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1`, [a.id, feedback, env.uid]);
  return mid;
}

registerMethod('mail.activity', 'action_feedback', actionFeedback, { apiModel: false });

/**
 * mail_activity.py:661-685 `action_done_schedule_next` / `action_feedback_schedule_next`: the activity done as
 * `action_feedback` (`_action_done`), then the scheduling wizard's action with the context without `default_*`
 * keys (`clean_context`), the done activity's deadline, its document and the type's suggested next type.
 */
async function feedbackScheduleNext(env: Environment, ids: number[] | null, kwargs: Record<string, unknown>): Promise<unknown> {
  if (!ids || ids.length !== 1) throw new NotPorted('action_feedback_schedule_next on several activities (ensure_one)');
  const a = (await env.cr.query<{ deadline: string | null; res_id: number | null; res_model: string | null; next: number | null }>(
    `SELECT a.date_deadline::text AS deadline, a.res_id, a.res_model, t.suggested_next_type_id AS next
       FROM mail_activity a LEFT JOIN mail_activity_type t ON t.id = a.activity_type_id WHERE a.id = $1`, [ids[0]])).rows[0];
  if (!a) throw new NotPorted('action_feedback_schedule_next on a missing activity (MissingError)');
  const ctx: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(env.context)) if (!k.startsWith('default_')) ctx[k] = v;
  Object.assign(ctx, { activity_previous_deadline: a.deadline ?? false, active_id: a.res_id ?? false, active_model: a.res_model ?? false });
  if (a.next) ctx['default_activity_type_id'] = a.next;
  await actionFeedback(env, ids, [], kwargs);
  return {
    name: translate(env, 'Schedule Activity'), context: ctx, view_mode: 'form', res_model: 'mail.activity.schedule',
    views: [[false, 'form']], type: 'ir.actions.act_window', target: 'new',
  };
}

registerMethod('mail.activity', 'action_feedback_schedule_next', async (env, ids, args, kwargs) => {
  if (args.length) throw new NotPorted('action_feedback_schedule_next with positional arguments');
  return feedbackScheduleNext(env, ids, kwargs);
}, { apiModel: false });
// :661-664: the button's wrapper, without feedback
registerMethod('mail.activity', 'action_done_schedule_next', async (env, ids) => feedbackScheduleNext(env, ids, {}), { apiModel: false });

/**
 * mail.activity create/write overrides (mail_activity.py:324, :362) as WriteHooks: the responsible user follows
 * the document. Assigning someone else sends them the "assigned to you" notification and email (`action_notify`),
 * which refuses; the activity counter bus notifications (`mail.activity/updated`) are not sent.
 */
async function subscribeResponsibles(env: Environment, activityIds: readonly number[]): Promise<void> {
  const rows = (await env.cr.query<{ res_model: string | null; res_id: number | null; user_id: number | null; partner_id: number | null }>(
    `SELECT a.res_model, a.res_id, a.user_id, u.partner_id FROM mail_activity a LEFT JOIN res_users u ON u.id = a.user_id
      WHERE a.id = ANY($1::int[]) ORDER BY a.id`, [activityIds])).rows;
  const self = await userInfo(env);
  for (const r of rows) {
    if (!r.res_model || !r.res_id || !r.user_id || !r.partner_id) continue;
    const generic = isGenericThread(r.res_model);
    if (r.res_model !== 'res.partner' && !generic) throw new NotPorted(`activity followers on ${r.res_model}`);
    // mail_thread.py:4862 message_subscribe: oneself needs read access, others write access and an active partner
    const adding = r.partner_id === self.partnerId;
    const op = adding ? 'read' : 'write';
    if (!(await (generic ? permissionOn(env, r.res_model, r.res_id, op) : permission(env, r.res_id, op)))) throw new NotPorted('activity follower without access (AccessError)');
    await messageSubscribe(env, r.res_model, [r.res_id], [r.partner_id], null, adding ? [] : null);
  }
}

registerHooks('mail.activity', { write: [{
  afterCreate: async (env, ids) => {
    let inbox: ((written: WrittenFields) => Promise<void>)[] = [];
    // :335-343 activities created for someone else notify their assignee (action_notify)
    if (!env.context['mail_activity_quick_update']) {
      const others = (await env.cr.query<{ id: number }>('SELECT id FROM mail_activity WHERE id = ANY($1::int[]) AND user_id IS NOT NULL AND user_id != $2 ORDER BY id', [ids, env.uid])).rows.map(r => r.id);
      if (others.length) inbox = await actionNotify(env, others);
    }
    await subscribeResponsibles(env, ids);
    if (inbox.length) {
      // the inbox Stores at precommit (mail_thread.py:3577-3587): after the subscriptions, with the activities' stored
      // computes flushed after their creation (mail models.py:29-34 `_flush`, in `_fields` order)
      const order = ((await fieldOrder(env))['mail.activity'] ?? []).filter((f) => f === 'res_name' || f === 'user_tz');
      const written: WrittenFields = { 'mail.activity': Object.fromEntries(ids.map((id) => [String(id), [...order]])) };
      for (const send of inbox) await send(written);
    }
    // mail_activity.py:354-360: bus counter update for active activities due today or earlier
    const ctx = requestOfCursor(env.cr);
    if (ctx) {
      const today = todayInTz(await dbNow(env), await envTz(env));
      const due = (await env.cr.query<{ user_id: number }>(
        `SELECT user_id FROM mail_activity WHERE id = ANY($1::int[]) AND active AND user_id IS NOT NULL AND date_deadline <= $2::date ORDER BY array_position($1::int[], id)`,
        [ids, today],
      )).rows;
      const byUser = new Map<number, number>();
      for (const r of due) byUser.set(r.user_id, (byUser.get(r.user_id) ?? 0) + 1);
      for (const [uid, count] of byUser) {
        await busSend(ctx, env, { model: 'res.users', id: uid }, 'mail.activity/updated', { activity_created: true, count_diff: count });
      }
    }
  },
  afterWrite: async (env, ids, vals) => {
    if (!vals['user_id']) return;
    if (vals['user_id'] !== env.uid && !env.context['mail_activity_quick_update']) throw new NotPorted('activity assignment notification to another user (action_notify)');
    await subscribeResponsibles(env, ids);
  },
}] });

/**
 * `mail.activity.schedule.action_schedule_activities` (odoo/addons/mail/wizard/mail_activity_schedule.py:425,
 * `_action_schedule_activities` :431) -> `activity_schedule` (mail_activity_mixin.py:428,
 * `_activity_schedule_create_vals` :355): one activity per record of the wizard, created through the ORM write
 * core (src/orm/create.ts) so the mail.activity hooks above and the stored computes run. Plans, single phone calls
 * and personal (record-less) activities refuse.
 */
export async function scheduleActivities(env: Environment, ids: number[] | null): Promise<number[]> {
  if (!ids || ids.length !== 1) throw new NotPorted('action_schedule_activities on several wizards');
  const w = (await env.cr.query<{ res_model: string | null; res_ids: string | null; plan_id: number | null; activity_type_id: number | null;
    summary: string | null; note: string | null; activity_user_id: number | null; activity_role_id: number | null; date_deadline: string | null;
    activity_user_id_fname: string | null; create_uid: number | null; category: string | null; type_summary: string | null;
    phone: string | null; default_note: string | null; default_user_id: number | null; type_model: string | null }>(
    `SELECT w.res_model, w.res_ids, w.plan_id, w.activity_type_id, w.summary, w.note, w.activity_user_id, w.activity_role_id,
            w.date_deadline::text AS date_deadline, w.activity_user_id_fname, w.create_uid, t.category, w.phone,
            COALESCE(t.summary->>$2, t.summary->>'en_US') AS type_summary, COALESCE(t.default_note->>$2, t.default_note->>'en_US') AS default_note,
            t.default_user_id, t.res_model AS type_model
       FROM mail_activity_schedule w LEFT JOIN mail_activity_type t ON t.id = w.activity_type_id WHERE w.id = $1`,
    [ids[0], env.lang ?? 'en_US'])).rows[0];
  if (!w) throw new NotPorted('action_schedule_activities on a missing wizard (MissingError)');
  if (w.create_uid !== env.uid) throw new NotPorted('scheduling from another user\'s wizard');
  if (w.plan_id) throw new NotPorted('activity plans');
  if (!w.res_model) {
    // mail_activity_schedule.py:450-463 _action_schedule_activities_personal
    if (!w.activity_user_id) throw new Error(translate(env, 'Scheduling personal activities requires an assigned user.'));
    const tz = (await env.cr.query<{ tz: string | null }>('SELECT p.tz FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1', [w.activity_user_id])).rows[0]?.tz ?? null;
    const row = (await env.cr.query<{ id: number }>(
      `INSERT INTO mail_activity (res_model_id, res_model, res_id, res_name, activity_type_id, summary, note, date_deadline,
         automated, technical_usage, user_id, role_id, user_tz, active, create_uid, write_uid, create_date, write_date)
       VALUES (NULL, NULL, NULL, NULL, $1, $2, $3, $4, false, 'none', $5, $6, $7, true, $8, $8, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')
       RETURNING id`,
      [w.activity_type_id, w.summary || null, w.note || null, w.date_deadline, w.activity_user_id, w.activity_role_id || null, tz, env.uid])).rows[0]!;
    await checkActivityAccess(env, [row.id], 'create');
    for (const h of hooksOf('mail.activity').write ?? []) if (h.afterCreate) await h.afterCreate(env, [row.id], [{}]);
    return [row.id];
  }
  if (w.res_model !== 'res.partner' && !isGenericThread(w.res_model)) throw new NotPorted(`activities on ${w.res_model}`);
  const recordIds = JSON.parse(w.res_ids ?? '[]') as unknown;
  if (!Array.isArray(recordIds) || !recordIds.every(Number.isInteger)) throw new NotPorted('wizard res_ids');
  // :435-447 a single call takes the wizard's number, formatted (phone_validation's _get_phone_number_for_activity)
  const singleCall = w.category === 'phonecall' && recordIds.length === 1;
  const callPhone = singleCall ? await phoneGetFormatted(env, w.res_model, (recordIds as number[])[0]!, w.phone) : false;
  if (!w.activity_type_id || (w.type_model && w.type_model !== w.res_model)) throw new NotPorted('default activity type (_default_activity_type)');
  if (w.activity_user_id_fname) throw new NotPorted('responsible from activity_user_id_fname');
  const model = (await env.cr.query<{ id: number }>('SELECT id FROM ir_model WHERE model = $1', [w.res_model])).rows[0]!.id;
  const valsList = (recordIds as number[]).map(id => {
    const v: Record<string, unknown> = {
      activity_type_id: w.activity_type_id, summary: w.summary || w.type_summary || false, automated: false,
      note: w.note || w.default_note || false, date_deadline: w.date_deadline, res_model_id: model, res_id: id,
      user_id: w.activity_user_id ?? false, role_id: w.activity_role_id ?? false,
    };
    if (!v['user_id'] && !v['role_id'] && w.default_user_id) v['user_id'] = w.default_user_id;
    if (singleCall) v['phone'] = callPhone;
    return v;
  });
  // activity_schedule (:434): created with clean_context (no default_* keys)
  const clean = Object.fromEntries(Object.entries(env.context).filter(([k]) => !k.startsWith('default_')));
  return createActivities(env.withContext(clean), valsList, { inbox: true });
}

registerMethod('mail.activity.schedule', 'action_schedule_activities', async (env, ids) => {
  await scheduleActivities(env, ids);
  // mail_activity_schedule.py:424-425 returns None (call_button answers false for it)
  return null;
}, { apiModel: false });

/**
 * `mail.activity.create` for fully specified values (all precomputed fields given, as `activity_schedule` passes
 * them): the row with its stored computes (res_model related, res_name `_compute_res_name` :167, user_tz related
 * :130, date_done/phone empty for active non-call activities), then the create override (`afterCreate` above).
 * Written with SQL until the ORM core converts many2one_reference values (src/orm/convert.ts).
 */
export async function createActivities(env: Environment, valsList: readonly Record<string, unknown>[], opts: { readonly sanitizedNote?: boolean; readonly inbox?: boolean } = {}): Promise<number[]> {
  const ids: number[] = [];
  for (const v of valsList) {
    const model = (await env.cr.query<{ model: string }>('SELECT model FROM ir_model WHERE id = $1', [v['res_model_id']])).rows[0]?.model;
    const resId = Number(v['res_id']);
    const generic = isGenericThread(model ?? '');
    if ((model !== 'res.partner' && !generic) || !model || !resId) throw new NotPorted(`activities on ${model}`);
    const type = (await env.cr.query<{ category: string | null }>('SELECT category FROM mail_activity_type WHERE id = $1', [v['activity_type_id']])).rows[0];
    if (!type) throw new NotPorted('activity without a type');
    // mail_activity.py:182-193 _compute_phone (stored, readonly=False): a given number is kept, a call activity
    // without one gets its record's (or its first customer's)
    const phone = type.category === 'phonecall' ? ('phone' in v ? (v['phone'] || null) : (await phoneOfRecord(env, model, resId)) || null) : null;
    if (!v['date_deadline']) throw new NotPorted('activity date_deadline to compute');
    const userId = v['user_id'] || null, roleId = v['role_id'] || null;
    const tz = userId ? (await env.cr.query<{ tz: string | null }>('SELECT p.tz FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1', [userId])).rows[0]?.tz ?? null : null;
    const resName = (await env.sudo().model(model).displayName([resId])).get(resId) ?? null;
    const note = v['note'] ? String(v['note']) : null;
    // a note is only taken from callers whose markup is already in the sanitizer's output form (a fixed qweb
    // template with escaped values, e.g. stock_backorder.ts): html_sanitize of other notes is not ported
    if (note && !opts.sanitizedNote) throw new NotPorted('activity notes (html sanitize of the note field)');
    const row = (await env.cr.query<{ id: number }>(
      `INSERT INTO mail_activity (res_model_id, res_model, res_id, res_name, activity_type_id, summary, note, date_deadline,
         automated, technical_usage, user_id, role_id, user_tz, active, create_uid, write_uid, create_date, write_date, phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'none', $10, $11, $12, true, $13, $13, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC', $14)
       RETURNING id`,
      [v['res_model_id'], model, resId, resName, v['activity_type_id'], v['summary'] || null, note, v['date_deadline'],
        'automated' in v ? Boolean(v['automated']) : null, userId, roleId, tz, env.uid, phone])).rows[0]!;
    ids.push(row.id);
  }
  // models.py:4449 `records.check_access('create')`: the rule `res_access_create` (mail/security/ir.access.csv:136),
  // the document's `_mail_post_access` (read for res.partner, mail/models/res_partner.py:19)
  await checkActivityAccess(env, ids, 'create');
  if (opts.inbox) INBOX_REQUESTS.add(env.cr);
  try {
    for (const h of hooksOf('mail.activity').write ?? []) if (h.afterCreate) await h.afterCreate(env, ids, valsList);
  } finally {
    INBOX_REQUESTS.delete(env.cr);
  }
  return ids;
}

/** Python `strftime` for res.lang date formats made of %d %m %Y %y and literals (others refuse). */
function strftimeDate(date: string, fmt: string): string {
  const [y, m, d] = date.split('-');
  if (!/^(%[dmYy]|[^%])*$/.test(fmt)) throw new NotPorted(`date format ${fmt}`);
  return fmt.replace(/%d/g, d!).replace(/%m/g, m!).replace(/%Y/g, y!).replace(/%y/g, y!.slice(2));
}

/**
 * `mail.activity.action_notify` (mail_activity.py:565-622) for one activity per assignee and document: the
 * `mail.message_activity_assigned` body (data/mail_templates_chatter.xml:31-50, as stored after html_sanitize), then
 * `message_notify` to the assignee with the forced header and footer, sent by email (src/mail/notify.ts).
 */
/**
 * The requests whose activities may notify an inbox user: the schedule wizard (`action_schedule_activities`), whose
 * transaction writes nothing else, so the Stores' version marks only the activities' fields flushed after their
 * creation (measured in Odoo: `res_name`, `user_tz`). Other callers (stock_backorder) refuse inbox recipients.
 */
const INBOX_REQUESTS = new WeakSet<object>();

async function actionNotify(env: Environment, ids: readonly number[]): Promise<((written: WrittenFields) => Promise<void>)[]> {
  const inbox: ((written: WrittenFields) => Promise<void>)[] = [];
  const ctx = requestOfCursor(env.cr);
  if (ctx === null) throw new NotPorted('activity notification outside a request');
  const rows = (await env.cr.query<{ id: number; res_model: string | null; res_id: number | null; res_name: string | null; summary: string | null;
    date_deadline: string; type_name: string | null; user_name: string | null; user_partner: number; user_lang: string | null; create_uid: number }>(
    `SELECT a.id, a.res_model, a.res_id, a.res_name, a.summary, a.date_deadline::text AS date_deadline,
            COALESCE(t.name->>'en_US', NULL) AS type_name, p.name AS user_name, u.partner_id AS user_partner, p.lang AS user_lang, a.create_uid
       FROM mail_activity a JOIN res_users u ON u.id = a.user_id JOIN res_partner p ON p.id = u.partner_id
       LEFT JOIN mail_activity_type t ON t.id = a.activity_type_id WHERE a.id = ANY($1::int[]) ORDER BY a.id`, [ids])).rows;
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!r.res_model || !r.res_id) continue;
    const k = `${r.user_partner}:${r.res_model}:${r.res_id}:${r.create_uid}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const acts of groups.values()) {
    if (acts.length !== 1) throw new NotPorted('assignment notification of several activities');
    const a = acts[0]!;
    const resModel = a.res_model ?? '';
    if ((resModel !== 'res.partner' && !isGenericThread(resModel)) || !a.res_id) throw new NotPorted(`assignment notification on ${a.res_model}`);
    const resId = a.res_id;
    const lang = a.user_lang || env.lang || 'en_US';
    if (lang !== 'en_US') throw new NotPorted('assignment notification in a language other than en_US');
    const modelDescription = (await env.cr.query<{ name: string }>("SELECT COALESCE(name->>'en_US', model) AS name FROM ir_model WHERE model = $1", [resModel])).rows[0]!.name;
    const author = (await env.cr.query<{ name: string | null }>('SELECT p.name FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1', [a.create_uid])).rows[0]?.name ?? '';
    const dateFormat = (await env.cr.query<{ date_format: string }>('SELECT date_format FROM res_lang WHERE code = $1', [lang])).rows[0]?.date_format ?? '%m/%d/%Y';
    const deadline = strftimeDate(a.date_deadline, dateFormat);
    const label = a.summary || a.type_name || '';
    const body = `<div style="margin:0px; padding:0px; font-size:13px">\n    \n    Dear <span>${escapeText(a.user_name ?? '')}</span>,\n    <br><br>\n    <p>\n        <span>${escapeText(author)}</span>\n        has just assigned you the following activity on document\n        "${escapeText(a.res_name ?? '')}" (${escapeText(modelDescription)}):\n        </p><ul>\n            <li>\n                <span>${escapeText(label)}</span>\n                - deadline: <span>${deadline}</span>\n            </li>\n        </ul>\n    \n</div>`;
    const subject = `"${a.res_name ?? ''}: ${a.summary || a.type_name || ''}" assigned to you`;
    const subtitles = [a.type_name ? `Activity: ${a.type_name}` : 'Activity: Todo', `Deadline: ${deadline}`];
    // message_notify (mail_thread.py:2815): a user_notification on the record, internal, note subtype
    const [authorId, emailFrom] = await computeAuthor(env, null, null);
    // mail_thread.py:2939-2940 `_mail_get_companies(default=env.company)`: the record's company_id
    const company = resModel !== 'res.partner' ? await recordCompany(env, resModel, resId)
      : (await env.cr.query<{ company_id: number | null }>('SELECT company_id FROM res_partner WHERE id = $1', [resId])).rows[0]?.company_id ?? await env.company();
    const [mid] = await insertMessages(env, [{
      model: resModel, res_id: resId, body, author_id: authorId, email_from: emailFrom, message_type: 'user_notification',
      subtype_id: await xmlid(env, 'mail.mt_note'), is_internal: true, subject, reply_to: await replyToDefault(env, emailFrom),
      message_id: trackingMessageId('message-notify'), email_add_signature: true, record_alias_domain_id: false,
      record_company_id: company, email_layout_xmlid: 'mail.mail_notification_layout', partner_ids: [a.user_partner],
    }]);
    const notified = await notifyThread(ctx, env, resModel, resId, mid!, { forceHeader: true, forceFooter: true, subtitles, modelDescription, inbox: INBOX_REQUESTS.has(env.cr) });
    inbox.push(notified.inbox);
    await notified.send();
  }
  return inbox;
}
