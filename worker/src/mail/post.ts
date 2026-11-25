/**
 * Posting and editing chatter messages of internal users on partner threads:
 *  - `/mail/message/post` (odoo/addons/mail/controllers/thread.py:230, `_prepare_message_data` :156;
 *    mail_thread.py `message_post` :2256, `_notify_thread` :3470, `_notify_get_recipients` :4279);
 *  - `/mail/message/update_content` (thread.py:262; mail_thread.py `_message_update_content` :5168).
 * Recipients: partners and emails in To and Cc and mentioned roles (`postRecipients`; an email nobody holds would
 * create a partner, which refuses, src/mail/partner_find.ts), notified by `notifyThread`, which refuses what it does
 * not port, as do the parts of the body the port cannot sanitize exactly (PORTING_odoo.md 12.1, 12.11).
 */
import { HttpError, NotPorted, UserError } from '../errors';
import { Markup } from '../pyexpr/values';
import { jsonRoute } from '../http/router';
import type { Environment } from '../orm/types';
import { userInfo } from '../orm/env';
import { userFlags } from '../session/user';
import { computeAuthor, escapeText, insertMessages, trackingMessageId, xmlid } from './message';
import { messageSubscribe } from './followers';
import { Store } from './store';
import { MailBootstrap } from './bootstrap';
import { checkThread, messageFields, permission } from './thread';
import { checkGenericThread, flatThreadParent, isGenericThread, permissionOn, postAccessOf, recordCompany, recordResponsible } from './thread_generic';
import { attachmentStoreFields, ownershipToken } from './attachment';
import { busSend } from './busnotify';
import { sanitizeBody } from './sanitize';
import { notifyThread } from './notify';
import { and, cond } from '../orm/domain';
import { write } from '../orm/write';
import { emailNormalize } from './message';
import { storeVersion } from '../bus/presence';
import { forEachGenericThread } from './thread_generic';
import { registerMethod } from '../http/methods';
import { envFor } from '../web/common';
import { requestOfCursor } from '../http/context';
import { htmlEscape, translate } from '../models/util';
import { attachmentHasAccess } from '../models/ir_attachment_access';
import { messagePostAfterHook } from './move_import';
import { recordWritten } from '../orm/written_fields';
import { trackPrepare } from './tracking';
import { closeTrackingScope } from './write_hooks';
import { hasGroup } from '../orm/env';

const ALLOWED = new Set(['email_add_signature', 'message_type', 'subject', 'subtype_xmlid']); // mail_thread.py:5417


/** `Datetime.to_string(Datetime.now())` of the request (the transaction's now, frozen by the harness). */
async function nowString(env: Environment): Promise<string> {
  return (await env.cr.query<{ s: string }>(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS s`)).rows[0]!.s;
}

/**
 * `_notify_get_recipients` + `_notify_thread_with_out_of_office` (mail_thread.py:4279, :4626) reduced to the check
 * that nobody would be notified: followers of the subtype (internal subtypes only for non-share partners) and the
 * explicit partners, minus the real author and inactive partners.
 */
export async function assertNoRecipients(env: Environment, model: string, resId: number, subtypeId: number, partnerIds: readonly number[],
  opts: { readonly notification?: boolean } = {}): Promise<void> {
  const author = (await userInfo(env)).partnerId; // _message_compute_real_author: the active current user
  const rows = (await env.cr.query<{ id: number }>(
    `SELECT DISTINCT p.id FROM res_partner p
      WHERE p.active IS TRUE AND p.id != $4 AND (p.id = ANY($5::int[]) OR EXISTS (
        SELECT 1 FROM mail_followers f JOIN mail_followers_mail_message_subtype_rel r ON r.mail_followers_id = f.id
          JOIN mail_message_subtype s ON s.id = r.mail_message_subtype_id
         WHERE f.res_model = $1 AND f.res_id = $2 AND f.partner_id = p.id AND s.id = $3
           AND (s.internal IS NOT TRUE OR p.partner_share IS NOT TRUE)))`,
    [model, resId, subtypeId, author, partnerIds])).rows;
  if (rows.length) throw new NotPorted('message notifications (inbox/email) of followers and recipients');
  // :4632-4634 out-of-office answers are only for comments and emails (a `notification` such as a creation message)
  if (opts.notification) return;
  // :4723-4726: the record responsible may answer out of office
  const ooo = model === 'res.partner' ? (await env.cr.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM res_partner p JOIN res_users u ON u.id = p.user_id
      WHERE p.id = $1 AND u.out_of_office_from IS NOT NULL AND u.partner_id != $2`, [resId, author])).rows[0]
    : (await env.cr.query<{ n: string }>(`SELECT count(*)::text AS n FROM res_users u WHERE u.id = $1 AND u.out_of_office_from IS NOT NULL
      AND u.partner_id != $2`, [isGenericThread(model) ? await recordResponsible(env, model, resId) : null, author])).rows[0];
  if (Number(ooo?.n ?? 0) > 0) throw new NotPorted('out of office answers');
  if (model !== 'res.partner' && !isGenericThread(model)) throw new NotPorted(`notification check on ${model}`);
}

jsonRoute('/mail/message/post', async ctx => {
  const p = ctx.jsonParams ?? {};
  let env = await ctx.orm();
  // discuss.channel: src/mail/channel_post.ts
  if (p['thread_model'] === 'discuss.channel') return (await import('./channel_post')).postOnChannel(ctx, env, p);
  const context = p['context'];
  if (context && typeof context === 'object') env = env.withContext({ ...env.context, ...(context as Record<string, unknown>) });
  if (p['canned_response_ids'] && (p['canned_response_ids'] as unknown[]).length) throw new NotPorted('canned responses');
  const model = String(p['thread_model']), resId = Number(p['thread_id']);
  // generic threads (crm.lead, thread_generic.ts): same path with the record's own access, company and flat parent
  const generic = isGenericThread(model);
  if ((model !== 'res.partner' && !generic) || !Number.isInteger(resId)) throw new NotPorted(`message post on ${model}`);
  // a share (portal) user posts on a generic thread it can read or write as `_mail_post_access` asks (thread.py:43-54,
  // 250-258); the access parameters of portal/controllers/thread.py (token, hash, pid) are not ported
  const flags = await userFlags(env.cr, env.uid);
  if (flags.isPublic) throw new NotPorted('message post of the public user');
  if (!flags.isInternal) {
    if (!generic) throw new NotPorted(`message post of a share user on ${model}`);
    if (model === 'calendar.event') throw new NotPorted('message post on calendar.event (_mail_get_operation_for_mail_message_operation)');
    for (const k of Object.keys(p)) if (!['thread_model', 'thread_id', 'post_data', 'context', 'canned_response_ids'].includes(k)) throw new NotPorted(`message post of a share user with ${k}`);
  } else if (generic) await checkGenericThread(env, model, resId); else await checkThread(env, model, resId);
  const writeAccess = (): Promise<boolean> => generic ? permissionOn(env, model, resId, 'write') : permission(env, resId, 'write');
  // thread.py:241-243 `_get_thread_with_access_for_post`: `_mail_post_access` = write (mail_thread.py:147), read on
  // res.partner (mail/models/res_partner.py:19); without write access the author does not follow (thread.py:253-254)
  if (!(await (generic ? permissionOn(env, model, resId, postAccessOf(model)) : permission(env, resId, 'read')))) throw new HttpError(404, '');
  const post = (p['post_data'] ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(post)) {
    // `parent_id` is not among mail.thread's `_get_allowed_message_params` (mail_thread.py:5417-5422; only
    // discuss.channel adds it, discuss_channel.py:1402): `_prepare_message_data` drops it (thread.py:157-161)
    if (k === 'parent_id') continue;
    if (!ALLOWED.has(k) && k !== 'body' && !['partner_ids', 'partner_cc_ids', 'partner_emails', 'partner_cc_emails', 'role_ids', 'partner_ids_mention_token', 'attachment_ids', 'attachment_tokens'].includes(k)) {
      throw new NotPorted(`message post_data ${k}`);
    }
  }
  const attachmentIds = await postAttachmentIds(env, post);
  const recipients = await postRecipients(env, model, resId, post);
  const partnerIds = recipients.to;
  const messageType = post['message_type'] === undefined ? 'comment' : String(post['message_type']); // thread.py:181
  if (messageType !== 'comment') throw new NotPorted(`message post of type ${messageType}`);
  const subtypeId = await xmlid(env, typeof post['subtype_xmlid'] === 'string' ? post['subtype_xmlid'] : 'mail.mt_note');
  const comment = await xmlid(env, 'mail.mt_comment');
  const body = sanitizeBody(typeof post['body'] === 'string' ? post['body'] : ''); // thread.py:191-194 Markup, sanitized by the field
  const [authorId, emailFrom] = await computeAuthor(env, null, null);
  const company = generic ? await recordCompany(env, model, resId)
    : (await env.cr.query<{ company_id: number | null }>('SELECT company_id FROM res_partner WHERE id = $1', [resId])).rows[0]?.company_id ?? await env.company();
  const alias = (await env.cr.query<{ alias_domain_id: number | null }>('SELECT alias_domain_id FROM res_company WHERE id = $1', [await env.company()])).rows[0];
  if (alias?.alias_domain_id) throw new NotPorted('record alias domains (_mail_get_alias_domains)');
  const aliases = (await env.cr.query<{ n: string }>(`SELECT count(*)::text n FROM mail_alias a JOIN ir_model m ON m.id = a.alias_parent_model_id
      WHERE a.alias_domain_id IS NOT NULL AND m.model = $1 AND a.alias_parent_thread_id = $2 AND a.alias_name IS NOT NULL`, [model, resId])).rows[0];
  if (Number(aliases?.n ?? 0) > 0) throw new NotPorted('reply-to through a document alias');
  const companyAlias = (await env.cr.query<{ alias_domain_id: number | null }>('SELECT alias_domain_id FROM res_company WHERE id = $1', [company])).rows[0];
  if (companyAlias?.alias_domain_id) throw new NotPorted('reply-to through a company catchall');
  // res.partner `_mail_flat_thread = False` (mail res_partner.py:18): no parent without an explicit one; generic
  // threads are flat (mail_thread.py:145, :3173)
  const parentId = generic ? await flatThreadParent(env, model, resId) : false;
  const written: Record<string, Record<string, string[]>> = {};
  await processAttachmentsForPost(env, attachmentIds, model, resId, written);
  const [id] = await insertMessages(env, [{
    model, res_id: resId, body, author_id: authorId, email_from: emailFrom, message_type: messageType, subtype_id: subtypeId,
    subject: typeof post['subject'] === 'string' && post['subject'] ? post['subject'] : false,
    email_add_signature: post['email_add_signature'] === undefined ? true : Boolean(post['email_add_signature']),
    record_alias_domain_id: false, record_company_id: company, reply_to: emailFrom,
    message_id: trackingMessageId(`${resId}-${model}`), attachment_ids: attachmentIds, partner_ids: partnerIds, partner_cc_ids: recipients.cc,
    ...(parentId ? { parent_id: parentId } : {}),
  }]);
  // :2420-2431: the author follows the thread of a comment posted with the Discussions subtype
  const writable = await writeAccess();
  const skip = Boolean(env.context['mail_post_autofollow_author_skip']) || !writable;
  if (!skip && subtypeId === comment) {
    const user = await userInfo(env);
    const share = (await env.cr.query<{ partner_share: boolean | null }>('SELECT partner_share FROM res_partner WHERE id = $1', [user.partnerId])).rows[0];
    if (user.active && !share?.partner_share) await messageSubscribe(env, model, [resId], [user.partnerId], null);
  }
  // :2447 `_message_post_after_hook`: crm.lead's customer from the recipients, then (super) account.move's files and
  // the main attachment (src/mail/move_import.ts)
  // the lead's tracking is logged at precommit (mail_track_mixin.py:133), after the notification and the answer
  let leadTracking: Environment | null = null;
  if (model === 'crm.lead') {
    leadTracking = env.sudo();
    await trackPrepare(leadTracking, 'crm.lead', []);
    const { written: w } = await recordWritten(env, () => leadPartnerFromRecipients(leadTracking!, resId, partnerIds));
    for (const [m, byId] of Object.entries(w)) for (const [rid, fields] of Object.entries(byId)) (written[m] ??= {})[rid] = [...fields];
  }
  await messagePostAfterHook(ctx.env, env, model, resId, id!, attachmentIds, written);
  // mail_thread.py:2433 `_notify_thread`: notification emails are sent after commit, so the answer shows them ready
  const notified = await notifyThread(ctx, env, model, resId, id!, { inbox: true });
  if (notified.messageWritten.length) (written['mail.message'] ??= {})[String(id)] = [...notified.messageWritten];
  for (const [m, byId] of Object.entries(notified.recordsWritten)) {
    for (const [rid, fields] of Object.entries(byId)) (written[m] ??= {})[rid] = [...fields];
  }
  const store = new Store();
  await messageFields(env, [id!], store, true, { currentUser: true });
  const data = await store.asDict(env.cr);
  data['__store_version__'] = await storeVersion(env.cr, written);
  // the inbox recipients' Stores are serialized at precommit, after the answer (the same written fields)
  await notified.inbox(written);
  if (leadTracking !== null) await closeTrackingScope(leadTracking, 'crm.lead');
  await notified.send();
  return { store_data: data, message_id: id };
}, { auth: 'public' });

/**
 * thread.py:183-190 `_prepare_message_data`: the post's `attachment_ids` after `_has_attachments_ownership(attachment_tokens)`
 * (mail ir_attachment.py:27-48): each attachment exists and is writable by the user, or its scoped ownership token is
 * valid; else a UserError.
 */
export async function postAttachmentIds(env: Environment, post: Record<string, unknown>): Promise<number[]> {
  const attachmentIds = ((post['attachment_ids'] as unknown[] | undefined) ?? []).map(Number);
  if (post['attachment_ids'] !== undefined && post['attachment_ids'] !== null) {
    const given = post['attachment_tokens'];
    const tokens = Array.isArray(given) && given.length ? given : attachmentIds.map(() => null);
    if (tokens.length !== attachmentIds.length) throw new UserError(translate(env, 'An access token must be provided for each attachment.', 'mail'));
    for (const [i, aid] of attachmentIds.entries()) {
      const exists = (await env.cr.query('SELECT 1 FROM ir_attachment WHERE id = $1', [aid])).rows.length > 0;
      const owned = exists && (await attachmentHasAccess(env, aid, 'write') || (Boolean(tokens[i]) && tokens[i] === await ownershipToken(env, aid)));
      if (!owned) throw new UserError(translate(env, 'One or more attachments do not exist, or you do not have the rights to access them.', 'mail'));
    }
  }
  return attachmentIds;
}

/**
 * mail_thread.py:2511-2523 `_process_attachments_for_post` for existing attachments: the composer's pending uploads
 * of the user move to the record (the written fields marked for the Store version).
 */
export async function processAttachmentsForPost(env: Environment, attachmentIds: readonly number[], model: string, resId: number,
  written: Record<string, Record<string, string[]>>): Promise<void> {
  for (const aid of attachmentIds) {
    const a = (await env.cr.query<{ res_model: string | null; create_uid: number | null }>('SELECT res_model, create_uid FROM ir_attachment WHERE id = $1', [aid])).rows[0];
    if (!a) throw new NotPorted('posting a missing attachment');
    if ((a.res_model === 'mail.compose.message' || a.res_model === 'mail.scheduled.message') && a.create_uid === env.uid) {
      await env.cr.query(`UPDATE ir_attachment SET res_model = $2, res_id = $3, write_uid = $4, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1`, [aid, model, resId, env.uid]);
      (written['ir.attachment'] ??= {})[String(aid)] = ['res_model', 'res_id', 'write_uid', 'write_date'];
    }
  }
}

/**
 * The edited body of mail_thread.py:5199-5209 for the html the composer sends: `html.fragment_fromstring(body,
 * create_parent="div")` whose children are only `<p>`/`<div>` elements without attributes, each holding text (no
 * entities, no line breaks) and balanced inline tags without attributes, so `etree.tostring` gives each back as
 * written. `head` is the element's `.text` (up to its first child), `rest` the children with their tails. Anything
 * else (top-level text, attributes, entities, nested blocks) is null.
 */
function editedBlocks(body: string): { tag: string; head: string; rest: string }[] | null {
  const re = /<(p|div)>((?:[^<>&\n\r]|<\/?(?:b|i|u|em|strong|s|code)>)*?)<\/\1>/y;
  const out: { tag: string; head: string; rest: string }[] = [];
  let at = 0;
  while (at < body.length) {
    re.lastIndex = at;
    const m = re.exec(body);
    if (!m) return null;
    const content = m[2]!;
    // an empty element serializes self-closed (`<p/>`, `<b/>`), which the sanitizer's HTML parser reads as an open tag
    if (content === '' || /<([a-z]+)><\/\1>/.test(content)) return null;
    const stack: string[] = [];
    for (const t of content.matchAll(/<(\/?)([a-z]+)>/g)) {
      if (t[1]) { if (stack.pop() !== t[2]) return null; } else stack.push(t[2]!);
    }
    if (stack.length) return null;
    const first = content.indexOf('<');
    out.push({ tag: m[1]!, head: first < 0 ? content : content.slice(0, first), rest: first < 0 ? '' : content.slice(first) });
    at = re.lastIndex;
  }
  return out.length ? out : null;
}

jsonRoute('/mail/message/update_content', async ctx => {
  const p = ctx.jsonParams ?? {};
  const env = await ctx.orm();
  const mid = Number(p['message_id']);
  const data = (p['update_data'] ?? {}) as Record<string, unknown>;
  const msg = (await env.cr.query<{ model: string | null; res_id: number | null; author_id: number | null; message_type: string; body: string | null; email_add_signature: boolean | null; parent_id: number | null }>(
    'SELECT model, res_id, author_id, message_type, body, email_add_signature, parent_id FROM mail_message WHERE id = $1', [mid])).rows[0];
  if (!msg) throw new HttpError(404, '');
  // res.partner and the generic threads (thread_generic.ts), whose `_message_update_content` is mail.thread's, and
  // discuss.channel (discuss_channel.py:1490-1500, 2010-2015)
  const generic = msg.model !== null && isGenericThread(msg.model);
  const channel = msg.model === 'discuss.channel';
  if ((msg.model !== 'res.partner' && !generic && !channel) || !msg.res_id) throw new NotPorted(`message edit on ${msg.model}`);
  const self = await userInfo(env);
  // thread.py:280 `_can_edit_message`: the author or an administrator; mode write on the message (its document)
  if (msg.author_id !== self.partnerId) throw new NotPorted('editing messages of other authors');
  if (channel) {
    // a channel gives no ORM right on its messages (`_mail_get_operation_for_mail_message_operation('write')` is
    // empty): the author's own message in a channel the user is an internal member of
    if (!(await userFlags(env.cr, env.uid)).isInternal) throw new NotPorted('channel message edit of non-internal users');
    if (!(await env.cr.query('SELECT 1 FROM discuss_channel_member WHERE channel_id = $1 AND partner_id = $2', [msg.res_id, self.partnerId])).rows.length) {
      throw new NotPorted('channel message edit of a non-member');
    }
    // discuss_channel.py `_check_can_update_message_content`: comments only, without mail.thread's checks
    if (msg.message_type !== 'comment') throw new UserError(translate(env, "Only messages type comment can have their content updated on model 'discuss.channel'", 'mail'));
    // mail_thread.py:5240-5241 `_filter_empty` -> discuss_channel.py:2010-2012 `_clean_empty_message`: an emptied
    // message loses its parent (a write of the unchanged False marks nothing); the update Store of a reply carries its
    // parent's (:2014-2015): a reply refuses either way (not ported)
    if (msg.parent_id) throw new NotPorted('editing a reply in a channel (its parent in the update Store)');
  } else {
    if (!(await (generic ? permissionOn(env, msg.model!, msg.res_id, 'write') : permission(env, msg.res_id, 'write')))) throw new NotPorted('message edit without document write access');
    // mail_thread.py:524 `_check_can_update_message_content`
    if (msg.message_type === 'tracking') throw new UserError('Messages with tracking values cannot be modified');
    if (msg.message_type !== 'comment') throw new UserError('Only messages type comment can have their content updated');
  }
  for (const k of Object.keys(data)) {
    if (!['body', 'attachment_ids', 'attachment_tokens', 'partner_ids', 'role_ids', 'partner_ids_mention_token', 'subject', 'rating_value'].includes(k)) throw new NotPorted(`update_data ${k}`);
  }
  // rating mail_thread.py:208-218 (the message actions' delete sends `rating_value: false`): False unlinks the
  // message's ratings, a value rewrites its rating; only a message without ratings and a False or absent value is ported
  if ('rating_value' in data) {
    if (data['rating_value'] !== false && data['rating_value'] !== null) throw new NotPorted('message edit with a rating value');
    if (data['rating_value'] === false && (await env.cr.query('SELECT 1 FROM rating_rating WHERE message_id = $1 LIMIT 1', [mid])).rows.length) {
      throw new NotPorted('message edit unlinking its ratings');
    }
  }
  if ((data['role_ids'] as unknown[] | undefined)?.length) throw new NotPorted('message edit with roles');
  const current = (await env.cr.query<{ attachment_id: number }>('SELECT attachment_id FROM message_attachment_rel WHERE message_id = $1 ORDER BY attachment_id', [mid])).rows.map(r => r.attachment_id);
  const wanted = ((data['attachment_ids'] as number[] | undefined) ?? current).map(Number).sort((a, b) => a - b);
  if (wanted.join(',') !== current.join(',')) throw new NotPorted('message edit adding or removing attachments');
  const sets: string[] = [], params: unknown[] = [mid];
  let written: string[] = [];
  if (typeof data['body'] === 'string') {
    const text = data['body'];
    const html = /[<>&\n\r]/.test(text) ? editedBlocks(text) : null;
    if (/[<>&\n\r]/.test(text) && html === null) throw new NotPorted('message edit with an html body other than paragraphs of text and inline tags');
    // :5198 `if body or not message._filter_empty()`: an empty body on an empty message stays empty
    const empty = !current.length && (!msg.body || /^<span class="o-mail-Message-edited".*><\/span>$/.test(msg.body));
    if (text || !empty) {
      const span = `<span class="o-mail-Message-edited" data-o-datetime="${await nowString(env)}"></span>`;
      if (html !== null) {
        // :5199-5209 a valid html body: the edited span goes inside the last <p>/<div> (the one before it when the
        // message has no signature and two or more elements), after its text (`.text`, the run before its first
        // child) gets a space; the message write sanitizes it (mail_message.py:175 Html field)
        const target = !msg.email_add_signature && html.length >= 2 ? html.length - 2 : html.length - 1;
        params.push(sanitizeBody(html.map((b, i) => i !== target ? `<${b.tag}>${b.head}${b.rest}</${b.tag}>`
          : `<${b.tag}>${b.head}${b.head ? ' ' : ''}${b.rest}${span}</${b.tag}>`).join('')));
      } else {
        // :5210-5212 plain text + the edited span, then html_sanitize (a leading text run goes in a paragraph)
        params.push(text ? `<p>${escapeText(text)}${span}</p>` : span);
      }
    } else params.push('');
    sets.push(`body = $${params.length}`);
    written.push('body');
  }
  // thread.py:200-226: partner_ids only when some recipient key is given (role_ids counts even when empty)
  const partnerUpdate = (data['partner_ids'] as number[] | undefined)?.length || data['role_ids'] !== undefined;
  if (partnerUpdate) {
    if ((data['partner_ids'] as number[] | undefined)?.length) throw new NotPorted('message edit with mentions');
    await env.cr.query('DELETE FROM mail_message_res_partner_rel WHERE mail_message_id = $1', [mid]);
  }
  if ('subject' in data) { params.push(data['subject'] === false ? null : data['subject']); sets.push(`subject = $${params.length}`); written = ['subject', ...written]; }
  if (sets.length || partnerUpdate) {
    params.push(env.uid);
    await env.cr.query(`UPDATE mail_message SET ${[...sets, `write_uid = $${params.length}`, `write_date = now() AT TIME ZONE 'UTC'`].join(', ')} WHERE id = $1`, params);
    written.push('write_date');
  }
  const previews = (await env.cr.query<{ n: string }>('SELECT count(*)::text n FROM mail_message_link_preview WHERE message_id = $1', [mid])).rows[0];
  if (Number(previews?.n ?? 0) > 0) throw new NotPorted('link previews of edited messages');
  await env.cr.query('DELETE FROM mail_message_translation WHERE message_id = $1', [mid]); // :5251-5254
  const version = { 'mail.message': { [String(mid)]: written } };
  // :5255-5272 the updated content to the message's bus channel (the current user, mail_message.py:1475)
  const busStore = new Store();
  const m = (await env.cr.query<{ body: string | null; subject: string | null; pinned_at: string | null; write_date: string }>(
    `SELECT body, subject, to_char(pinned_at, 'YYYY-MM-DD HH24:MI:SS') AS pinned_at, to_char(write_date, 'YYYY-MM-DD HH24:MI:SS') AS write_date FROM mail_message WHERE id = $1`, [mid])).rows[0]!;
  const partnerIds = (await env.cr.query<{ id: number }>('SELECT res_partner_id AS id FROM mail_message_res_partner_rel WHERE mail_message_id = $1 ORDER BY res_partner_id', [mid])).rows.map(r => r.id);
  for (const aid of current) busStore.add('ir.attachment', aid, await attachmentStoreFields(env, aid));
  // :5260-5265 partner_ids with `_store_avatar_fields` and the name (sorted by id)
  const avatars = new MailBootstrap(env, busStore);
  for (const pid of partnerIds) await avatars.avatar(pid);
  busStore.add('mail.message', mid, { attachment_ids: current, body: m.body ? ['markup', m.body] : false, partner_ids: partnerIds, pinned_at: m.pinned_at ?? false,
    subject: m.subject ?? false, write_date: m.write_date, translationValue: false, ...(channel ? { parent_id: false } : {}) });
  let busData = await busStore.asDict(env.cr);
  busData['__store_version__'] = await storeVersion(env.cr, version);
  if (channel) {
    // discuss mail_message.py:48-51 `_bus_channels`: a channel message's Store goes to its channel
    const { channelBusIsInternal, forChannelBus } = await import('./channel_post');
    const ch = (await env.cr.query<{ channel_type: string; group_public_id: number | null }>('SELECT channel_type, group_public_id FROM discuss_channel WHERE id = $1', [msg.res_id])).rows[0]!;
    busData = forChannelBus(busData, await channelBusIsInternal(env, ch));
    await busSend(ctx, env, { model: 'discuss.channel', id: msg.res_id }, 'mail.record/insert', busData);
  } else await busSend(ctx, env, { model: 'res.users', id: env.uid }, 'mail.record/insert', busData);
  const store = new Store();
  await messageFields(env, [mid], store, true, { currentUser: true });
  const out = await store.asDict(env.cr);
  // Store version: the fields this request wrote on the message (tools/discuss.py StoreVersion)
  out['__store_version__'] = await storeVersion(env.cr, version);
  return out;
}, { auth: 'public' });

/**
 * crm_lead.py:2128-2145 `_message_post_after_hook` (the post runs as sudo, thread.py:257): a lead with an email and no
 * customer takes the first of the message's partners (res.partner order) holding that email as its customer, with
 * every open lead (stage not folded) without customer on the same email.
 */
export async function leadPartnerFromRecipients(env: Environment, resId: number, partnerIds: readonly number[]): Promise<void> {
  if (!partnerIds.length) return;
  const lead = (await env.cr.query<{ email_from: string | null; email_normalized: string | null; partner_id: number | null }>(
    'SELECT email_from, email_normalized, partner_id FROM crm_lead WHERE id = $1', [resId])).rows[0];
  if (!lead?.email_from || lead.partner_id) return;
  const partners = (await env.cr.query<{ id: number; email: string | null; email_normalized: string | null }>(
    'SELECT id, email, email_normalized FROM res_partner WHERE id = ANY($1::int[])', [[...partnerIds]])).rows;
  const matching = partners.filter((p) => p.email === lead.email_from || (lead.email_normalized && p.email_normalized === lead.email_normalized)).map((p) => p.id);
  if (!matching.length) return;
  // `message.partner_ids` reads in the comodel's order
  const first = (await env.model('res.partner').search(cond('id', 'in', matching), { activeTest: false }))[0];
  if (first === undefined) return;
  const p = partners.find((x) => x.id === first)!;
  const emailDomain = p.email_normalized ? cond('email_normalized', '=', p.email_normalized) : cond('email_from', '=', p.email);
  const leads = await env.model('crm.lead').search(and([cond('partner_id', '=', false), emailDomain, cond('stage_id.fold', '=', false)]));
  if (leads.length) await write(env, 'crm.lead', leads, { partner_id: first });
}

/**
 * thread.py:195-226 `_prepare_message_data` recipients: `partner_ids` and `partner_cc_ids`, the users' partners of the
 * mentioned `role_ids` (as sudo, res.users order), and the partners found, or created for a partner manager, for
 * `partner_emails` and `partner_cc_emails` (`_partner_find_from_emails_single`, src/mail/partner_find.ts), each list
 * kept to the partners the internal user can read. mail_thread.py:2352-2353: a partner in "To" and "Cc" stays in "To".
 */
async function postRecipients(env: Environment, model: string, resId: number, post: Record<string, unknown>): Promise<{ to: number[]; cc: number[] }> {
  const ints = (k: string): number[] => ((post[k] as unknown[] | undefined) ?? []).map(Number);
  let to = ints('partner_ids'), cc = ints('partner_cc_ids');
  const emails = ((post['partner_emails'] as unknown[] | undefined) ?? []).map(String);
  const ccEmails = ((post['partner_cc_emails'] as unknown[] | undefined) ?? []).map(String);
  const roles = post['role_ids'];
  if (!to.length && !cc.length && !emails.length && !ccEmails.length && (roles === undefined || roles === null)) return { to, cc };
  // `partners |= ...`: a recordset union, the first occurrences in order
  const union = (a: readonly number[], b: readonly number[]): number[] => [...new Set([...a, ...b])];
  if (Array.isArray(roles) && roles.length) {
    const users = await env.sudo().model('res.users').search(cond('role_ids', 'in', roles.map(Number)));
    const partners = (await env.cr.query<{ id: number; partner_id: number }>('SELECT id, partner_id FROM res_users WHERE id = ANY($1::int[])', [users])).rows;
    const byUser = new Map(partners.map((r) => [r.id, r.partner_id]));
    to = union(to, users.map((u) => byUser.get(u)!));
  }
  if (emails.length || ccEmails.length) {
    const { partnerFindFromEmails } = await import('./partner_find');
    const noCreate = !(await hasGroup(env, 'base.group_partner_manager'));
    if (emails.length) to = union(to, await partnerFindFromEmails(env, model, resId, emails, noCreate));
    if (ccEmails.length) cc = union(cc, await partnerFindFromEmails(env, model, resId, ccEmails, noCreate));
  }
  // internal users keep the partners they can read; a mention token for the others (thread.py:217-225) is not ported
  for (const list of [to, cc]) {
    const all = [...new Set(list)];
    const readable = all.length ? await env.model('res.partner').search(cond('id', 'in', all)) : [];
    if (readable.length !== all.length) throw new NotPorted('recipients the user cannot read (mention tokens)');
  }
  return { to: [...new Set(to)], cc: [...new Set(cc)].filter((pid) => !to.includes(pid)) };
}

/**
 * `message_post(*, body, subject, message_type, subtype_xmlid, partner_ids, body_is_html)` over call_kw
 * (mail_thread.py:2256-2440) for internal users on res.partner and the generic thread models, without attachments
 * or recipients: a `str` body is escaped (`escape(body)`) and sanitized by the field, the message is created as the
 * chatter route does it (same author, company, reply-to, flat parent), then `_notify_thread` (which refuses what it
 * does not port). Returns the message (its id list over RPC). A user without the document access, partner_ids
 * (`mail_post_autofollow` and the customer subscription), other parameters and other message types refuse.
 */
for (const model of ['res.partner']) registerThreadMethods(model);
forEachGenericThread(registerThreadMethods);
function registerThreadMethods(model: string): void {
  registerMethod(model, 'message_post', async (env0, ids, args, kwargs0) => {
    const { env, kwargs } = envFor(env0, kwargs0);
    if (args.length) throw new NotPorted('message_post with positional arguments (keyword-only: TypeError)');
    if (ids?.length !== 1) throw new NotPorted('message_post on several records (ensure_one)');
    const resId = ids[0]!;
    for (const k of Object.keys(kwargs)) if (!['body', 'subject', 'message_type', 'subtype_xmlid', 'partner_ids', 'body_is_html', 'author_id'].includes(k)) throw new NotPorted(`message_post parameter ${k}`);
    // :2302-2305 `author_id` given: that partner and its formatted email (`_message_compute_author`)
    const givenAuthor = kwargs['author_id'];
    if (givenAuthor !== undefined && givenAuthor !== null && givenAuthor !== false && typeof givenAuthor !== 'number') throw new NotPorted('message_post author_id that is not an id');
    const partners = kwargs['partner_ids'];
    if (Array.isArray(partners) ? partners.length : partners) throw new NotPorted('message_post with partner_ids over RPC (autofollow of the customer)');
    const ctx = requestOfCursor(env.cr);
    if (ctx === null) throw new NotPorted('message_post outside a request');
    if (!(await userFlags(env.cr, env.uid)).isInternal) throw new NotPorted('message_post of non-internal users');
    const generic = model !== 'res.partner';
    const allowed = generic ? await permissionOn(env, model, resId, postAccessOf(model)) : await checkThread(env, model, resId) && await permission(env, resId, 'read');
    if (!allowed) throw new NotPorted('message_post without access to the document (mail.message create AccessError)');
    const messageType = kwargs['message_type'] === undefined ? 'notification' : String(kwargs['message_type']);
    if (messageType !== 'notification' && messageType !== 'comment') throw new NotPorted(`message_post of type ${messageType}`);
    const subtypeId = await xmlid(env, typeof kwargs['subtype_xmlid'] === 'string' && kwargs['subtype_xmlid'] ? kwargs['subtype_xmlid'] : 'mail.mt_note');
    const given = kwargs['body'] === undefined ? '' : kwargs['body'];
    // a Markup body (compiled callers: payment's transaction messages) is html as it is
    const raw = given instanceof Markup ? given.toString() : given;
    if (typeof raw !== 'string') throw new NotPorted('message_post with a body that is not a string');
    // :2366-2369 body_is_html for internal users (Markup), else `escape(body)`
    const html = kwargs['body_is_html'] || given instanceof Markup ? raw : htmlEscape(raw);
    const body = sanitizeBody(html);
    const subject = kwargs['subject'];
    if (subject !== undefined && subject !== null && subject !== false && typeof subject !== 'string') throw new NotPorted('message_post subject that is not a string');
    const [authorId, emailFrom] = await computeAuthor(env, typeof givenAuthor === 'number' ? givenAuthor : null, null);
    const company = generic ? await recordCompany(env, model, resId)
      : (await env.cr.query<{ company_id: number | null }>('SELECT company_id FROM res_partner WHERE id = $1', [resId])).rows[0]?.company_id ?? await env.company();
    const aliasDomains = (await env.cr.query<{ n: string }>('SELECT count(*)::text n FROM res_company WHERE id = ANY($1::int[]) AND alias_domain_id IS NOT NULL', [[await env.company(), company]])).rows[0];
    if (Number(aliasDomains?.n ?? 0) > 0) throw new NotPorted('record alias domains (_mail_get_alias_domains, reply-to)');
    const aliases = (await env.cr.query<{ n: string }>(`SELECT count(*)::text n FROM mail_alias a JOIN ir_model m ON m.id = a.alias_parent_model_id
        WHERE a.alias_domain_id IS NOT NULL AND m.model = $1 AND a.alias_parent_thread_id = $2 AND a.alias_name IS NOT NULL`, [model, resId])).rows[0];
    if (Number(aliases?.n ?? 0) > 0) throw new NotPorted('reply-to through a document alias');
    const parentId = generic ? await flatThreadParent(env, model, resId) : false;
    const [id] = await insertMessages(env, [{
      model, res_id: resId, body, author_id: authorId, email_from: emailFrom, message_type: messageType, subtype_id: subtypeId,
      subject: typeof subject === 'string' && subject ? subject : false, email_add_signature: true,
      record_alias_domain_id: false, record_company_id: company, reply_to: emailFrom,
      message_id: trackingMessageId(`${resId}-${model}`), attachment_ids: [], partner_ids: [],
      ...(parentId ? { parent_id: parentId } : {}),
    }]);
    // :2420-2431 the author follows the thread of a comment posted with the Discussions subtype
    const comment = await xmlid(env, 'mail.mt_comment');
    const writable = generic ? await permissionOn(env, model, resId, 'write') : await permission(env, resId, 'write');
    if (subtypeId === comment && writable && !env.context['mail_post_autofollow_author_skip']) {
      const user = await userInfo(env);
      const share = (await env.cr.query<{ partner_share: boolean | null }>('SELECT partner_share FROM res_partner WHERE id = $1', [user.partnerId])).rows[0];
      if (user.active && !share?.partner_share) await messageSubscribe(env, model, [resId], [user.partnerId], null);
    }
    const notified = await notifyThread(ctx, env, model, resId, id!);
    await notified.send();
    return [id];
  }, { apiModel: false });
}
