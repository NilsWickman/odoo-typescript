/**
 * Write side of mail.message: the low-level helpers mail.thread uses to log and post
 * (odoo/addons/mail/models/mail_thread.py `_message_log_batch` :3015, `_message_compute_author` :3104,
 * `_message_create` :3208; mail_message.py `create` :769; models.py `_notify_get_reply_to_batch` :610).
 * Rows are inserted with SQL in the columns Odoo writes (the ORM write core is stream WR's); every branch that
 * would need more of Odoo than ported here raises NotPorted.
 */
import { randomBytes } from 'node:crypto';
import { NotPorted } from '../errors';
import type { Environment } from '../orm/types';
import { userInfo } from '../orm/env';
import { xmlidToResId } from '../session/user';

/** `odoo.tools.mail.email_normalize` for one address (mail.py email_normalize, strict): lower-cased, or null. */
export function emailNormalize(text: string | null | undefined): string | null {
  if (!text) return null;
  const s = text.trim();
  // A bare `local@domain` is the only input form ported; display-name or multi-address input refuses.
  if (/^[^\s@<>,;"()]+@[^\s@<>,;"()]+$/.test(s)) return s.toLowerCase();
  if (/[<>,;]/.test(s)) throw new NotPorted(`email_normalize of a formatted or multi-address value`);
  return null;
}

/** `odoo.tools.mail.formataddr((name, email))` with charset utf-8 (mail.py:1041). */
export function formatAddr(name: string, address: string): string {
  const at = address.lastIndexOf('@');
  const local = at < 0 ? '' : address.slice(0, at), domain = at < 0 ? address : address.slice(at + 1);
  if (/[^\x00-\x7f]/.test(domain)) throw new NotPorted('formataddr with an IDNA domain');
  if (!name) return `${local}@${domain}`;
  // mail.py:1070: names that are not ASCII go base64 (rfc2047); ASCII names escape `\` and `"`.
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(name)) return `=?utf-8?b?${Buffer.from(name, 'utf8').toString('base64')}?= <${local}@${domain}>`;
  return `"${name.replace(/[\\"]/g, '\\$&')}" <${local}@${domain}>`;
}

/** `res.partner.email_formatted` (base res_partner.py:655): false without a valid email. */
export async function partnerEmailFormatted(env: Environment, partnerId: number): Promise<string | false> {
  const row = (await env.cr.query<{ name: string | null; email: string | null }>(
    'SELECT name, email FROM res_partner WHERE id=$1', [partnerId])).rows[0];
  if (!row) return false;
  const normalized = emailNormalize(row.email);
  if (normalized) return formatAddr(row.name || 'False', normalized);
  // res_partner.py:681-684: an invalid email is kept as is; a void one gives False.
  return row.email ? row.email : false;
}

/** `_message_compute_author(author_id, email_from)` (mail_thread.py:3104) without the email lookup branch. */
export async function computeAuthor(env: Environment, authorId: number | null | undefined, emailFrom?: string | null): Promise<[number | false, string | false]> {
  if (authorId === undefined || authorId === null) {
    if (emailFrom) throw new NotPorted('message author from an email address (_partner_find_from_emails_single)');
    const pid = (await userInfo(env)).partnerId;
    return [pid, await partnerEmailFormatted(env, pid)];
  }
  if (emailFrom === undefined || emailFrom === null) return [authorId, authorId ? await partnerEmailFormatted(env, authorId) : false];
  return [authorId, emailFrom];
}

/** `mail.thread._notify_get_reply_to(default)` on the empty mail.thread (models.py:610): the env company's catchall. */
export async function replyToDefault(env: Environment, fallback: string | false): Promise<string | false> {
  const company = await env.company();
  const row = (await env.cr.query<{ alias_domain_id: number | null }>('SELECT alias_domain_id FROM res_company WHERE id=$1', [company])).rows[0];
  // models.py:663 `company.catchall_email` (related alias_domain_id.catchall_email): none without an alias domain.
  if (row?.alias_domain_id) throw new NotPorted('reply-to through a company alias domain catchall');
  return fallback;
}

/** `tools.mail.generate_tracking_message_id(res)` (mail.py): random, masked by the harness (dbdiff N6 `<msgid>`). */
export function trackingMessageId(res: string): string {
  const rnd = `0.${BigInt('0x' + randomBytes(7).toString('hex')).toString().slice(0, 16)}`;
  const now = (Date.now() / 1000).toFixed(6);
  return `<${rnd}.${now}-openerp-${res}@worker>`;
}

/** Values of one mail.message row as `_message_create` hands them to `mail.message.create`. */
export interface MessageValues {
  readonly model: string | false;
  readonly res_id: number | false;
  readonly body: string;
  readonly author_id: number | false;
  readonly email_from: string | false;
  readonly message_type: string;
  readonly subtype_id: number | false;
  readonly is_internal?: boolean | null;
  readonly subject?: string | false | null;
  readonly reply_to: string | false;
  readonly message_id: string;
  readonly email_add_signature: boolean;
  readonly record_alias_domain_id?: number | false | null;
  readonly record_company_id?: number | false | null;
  readonly parent_id?: number | false | null;
  readonly mail_activity_type_id?: number | false | null;
  readonly email_layout_xmlid?: string | false | null;
  /** Columns left NULL unless given (message_post kwargs that are mail.message fields). */
  readonly reply_to_force_new?: boolean | null;
  readonly mail_server_id?: number | false | null;
  readonly partner_ids?: readonly number[];
  readonly partner_cc_ids?: readonly number[];
  readonly attachment_ids?: readonly number[];
}

const sqlv = (v: unknown): unknown => (v === false || v === undefined ? null : v);

/**
 * `mail.message.create` (mail_message.py:769) for values already complete (email_from, message_id and reply_to
 * given, no base64 images in the body). Returns the new ids in order. Columns not given keep their SQL default (NULL),
 * exactly as Odoo leaves them; create/write uid and dates are the ORM's magic fields.
 */
export async function insertMessages(env: Environment, valuesList: readonly MessageValues[]): Promise<number[]> {
  const ids: number[] = [];
  for (const v of valuesList) {
    if (/src=["']data:image\//.test(v.body)) throw new NotPorted('message body with base64 images (mail_message.py:787)');
    const row = (await env.cr.query<{ id: number }>(
      `INSERT INTO mail_message (model, res_id, body, author_id, email_from, message_type, subtype_id, is_internal, subject,
         reply_to, message_id, email_add_signature, record_alias_domain_id, record_company_id, parent_id,
         mail_activity_type_id, email_layout_xmlid, reply_to_force_new, mail_server_id, date, create_uid, write_uid, create_date, write_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$19,$20,
         date_trunc('second', now() AT TIME ZONE 'UTC'), $18, $18, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')
       RETURNING id`,
      [sqlv(v.model), sqlv(v.res_id), v.body, sqlv(v.author_id), sqlv(v.email_from), v.message_type, sqlv(v.subtype_id),
        v.is_internal ?? null, v.subject === undefined ? null : sqlv(v.subject), sqlv(v.reply_to), v.message_id,
        v.email_add_signature, sqlv(v.record_alias_domain_id), sqlv(v.record_company_id), sqlv(v.parent_id),
        sqlv(v.mail_activity_type_id), sqlv(v.email_layout_xmlid), env.uid, v.reply_to_force_new ?? null, sqlv(v.mail_server_id)])).rows[0]!;
    ids.push(row.id);
    for (const pid of v.partner_ids ?? []) {
      await env.cr.query('INSERT INTO mail_message_res_partner_rel (mail_message_id, res_partner_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [row.id, pid]);
    }
    for (const pid of v.partner_cc_ids ?? []) {
      await env.cr.query('INSERT INTO mail_message_res_partner_cc_rel (mail_message_id, res_partner_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [row.id, pid]);
    }
    for (const aid of v.attachment_ids ?? []) {
      await env.cr.query('INSERT INTO message_attachment_rel (message_id, attachment_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [row.id, aid]);
    }
  }
  return ids;
}

export async function xmlid(env: Environment, name: string): Promise<number> {
  const id = await xmlidToResId(env.cr, name);
  if (id === null) throw new Error(`Missing XML id ${name}`);
  return id;
}

/**
 * `_message_log_batch(bodies, author_id=None, message_type, tracking_values)` (mail_thread.py:3015). `bodies` are
 * html already (the caller escaped text, :3078 `escape(...)`, and appended the tracking html, :3084); the result is
 * the body after the Html field's sanitize, which leaves the generated markup unchanged.
 */
export async function messageLogBatch(env: Environment, model: string, bodies: ReadonlyMap<number, string>,
  opts: { authorId?: number | null; messageType?: string } = {}): Promise<number[]> {
  const [authorId, emailFrom] = await computeAuthor(env, opts.authorId ?? null, null);
  const replyTo = await replyToDefault(env, emailFrom);
  const subtype = await xmlid(env, 'mail.mt_note');
  const values: MessageValues[] = [...bodies].map(([resId, body]) => ({
    model, res_id: resId, body, author_id: authorId, email_from: emailFrom, message_type: opts.messageType ?? 'notification',
    is_internal: true, subject: false, subtype_id: subtype, email_add_signature: false,
    record_alias_domain_id: false, record_company_id: false,
    message_id: trackingMessageId('message-notify'), reply_to: replyTo,
  }));
  return insertMessages(env, values);
}

/** markupsafe `escape` of text as it reads back after lxml re-serialization in html_sanitize: `&`, `<`, `>` only. */
export function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The stored body of `escape(text)` through mail.message's Html field (fields_textual.py:731 html_sanitize): a plain
 * text body is wrapped in a paragraph (PORTING_odoo.md 12.9). Only single-line text without markup is ported.
 */
export function plaintextBody(text: string): string {
  if (text === '') return '';
  if (/[\n\r]/.test(text)) throw new NotPorted('multi-line plain text message body');
  return `<p>${escapeText(text)}</p>`;
}
