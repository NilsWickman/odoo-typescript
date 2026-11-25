/**
 * `_message_auto_subscribe_notify(partner_ids, 'mail.message_user_assigned')` of crm.lead
 * (odoo/addons/mail/models/mail_thread.py:4972-5006): `message_notify` (:3393-) of the rendered assignment to the new
 * salesperson, `_notify_thread` (:3470) by email (`_notify_thread_by_email` :3594: one mail.mail per recipients group
 * and one mail.notification per recipient), then `send_after_commit` (mail_mail.py:735-750): `send()` (:752) as
 * superuser in a new cursor after the commit. The port sends in the request (same end state).
 *
 * Sending: `ir.mail_server._connect__` (base ir_mail_server.py) with no ir.mail_server record and no smtp_server in
 * the server configuration connects to localhost:25. The Worker opens that TCP connection with cloudflare:sockets;
 * a refused connection is recorded the way `send()` records the exception (mail_mail.py:784-790:
 * `exception_to_unicode(exc)` of `ConnectionRefusedError(111, 'Connection refused')`, failure_type mail_smtp on the
 * notifications). Any other outcome (a reachable SMTP server) refuses: SMTP delivery is not ported.
 *
 * Ported for internal recipients notified by email (`notification_type` email) in en_US; inbox recipients, share
 * partners, other followers of the note subtype and alias domains refuse.
 */
import { notifyFailure, smtpConnectFailure } from "../mail/notify";
import { NotPorted } from "../errors";
import type { Environment } from "../orm/types";
import { computeAuthor, emailNormalize, insertMessages, trackingMessageId, xmlid } from "../mail/message";
import { messagePreview, notificationLayout, userAssignedBody } from "./mail_notify_layout";

const MODEL = "crm.lead";

/** Python `strftime` for the date formats of res.lang that only use %d %m %Y %y (formats with others refuse). */
export function strftimeDate(date: string, fmt: string): string {
  const [y, m, d] = date.split("-");
  if (!/^(%[dmYy]|[^%])*$/.test(fmt)) throw new NotPorted(`date format ${fmt}`);
  return fmt.replace(/%d/g, d!).replace(/%m/g, m!).replace(/%Y/g, y!).replace(/%y/g, y!.slice(2));
}

export async function notifyAssigned(env: Environment, ids: readonly number[], partnerIds: readonly number[]): Promise<void> {
  const lang = env.lang ?? "en_US";
  if (lang !== "en_US") throw new NotPorted(`assignment notification in ${lang}`);
  const n = (await env.cr.query<{ n: string }>("SELECT count(*)::text AS n FROM mail_alias_domain")).rows[0]?.n ?? "0";
  if (Number(n) > 0) throw new NotPorted("notification reply-to and bounce through mail alias domains");
  const modelDescription = (await env.cr.query<{ name: string }>(
    "SELECT COALESCE(name->>$2, name->>'en_US') AS name FROM ir_model WHERE model = $1", [MODEL, lang])).rows[0]?.name ?? "";
  const noteId = await xmlid(env, "mail.mt_note");
  const baseUrl = (await env.cr.query<{ value: string }>("SELECT value FROM ir_config_parameter WHERE key = 'web.base.url'")).rows[0]?.value ?? "";
  const dateFormat = (await env.cr.query<{ date_format: string }>("SELECT date_format FROM res_lang WHERE code = $1", [lang])).rows[0]?.date_format ?? "%m/%d/%Y";
  for (const id of ids) {
    const lead = (await env.cr.query<{ name: string | null; user_name: string | null; company_id: number | null; date_deadline: string | null }>(
      `SELECT l.name, p.name AS user_name, l.company_id, l.date_deadline::text AS date_deadline FROM crm_lead l
         LEFT JOIN res_users u ON u.id = l.user_id LEFT JOIN res_partner p ON p.id = u.partner_id WHERE l.id = $1`, [id])).rows[0];
    if (!lead) continue;
    const displayName = lead.name ?? "";
    // :4985-4999: the template rendered with object = lead, then message_notify
    const body = userAssignedBody(lead.user_name ?? "", modelDescription, displayName);
    const [authorId, emailFrom] = await computeAuthor(env, null, null);
    const company = lead.company_id ?? await env.company();
    const [messageId] = await insertMessages(env, [{
      model: MODEL, res_id: id, body, author_id: authorId, email_from: emailFrom, message_type: "user_notification",
      subtype_id: noteId, is_internal: true, subject: `You have been assigned to ${displayName}`,
      reply_to: emailFrom, message_id: trackingMessageId("message-notify"), email_add_signature: true,
      record_alias_domain_id: false, record_company_id: company, email_layout_xmlid: "mail.mail_notification_layout",
      partner_ids: partnerIds,
    }]);
    // `_notify_get_recipients` (:4279): partner_ids plus followers of the note subtype, minus the author
    const others = (await env.cr.query<{ id: number }>(
      `SELECT DISTINCT f.partner_id AS id FROM mail_followers f JOIN mail_followers_mail_message_subtype_rel r ON r.mail_followers_id = f.id
        WHERE f.res_model = $1 AND f.res_id = $2 AND r.mail_message_subtype_id = $3 AND f.partner_id != ALL($4::int[]) AND f.partner_id != $5`,
      [MODEL, id, noteId, partnerIds, authorId || 0])).rows;
    if (others.length) throw new NotPorted("assignment notification with other followers of the note subtype");
    const recipients = (await env.cr.query<{ id: number; email: string | null; share: boolean | null; active: boolean | null; notif: string | null }>(
      `SELECT p.id, p.email, p.partner_share AS share, p.active, u.notification_type AS notif FROM res_partner p
         LEFT JOIN res_users u ON u.partner_id = p.id AND u.active WHERE p.id = ANY($1::int[]) ORDER BY p.id`, [partnerIds])).rows;
    const emailRecipients = recipients.filter((r) => r.id !== authorId);
    for (const r of emailRecipients) {
      if (r.notif !== "email" || r.share || !r.active) throw new NotPorted("assignment notification to inbox, share or inactive recipients");
    }
    if (!emailRecipients.length) continue;
    // `_notify_by_email_prepare_rendering_context` (:3864) and the user group of `_notify_get_recipients_groups`
    const colors = (await env.cr.query<{ p: string | null; s: string | null }>(
      "SELECT email_primary_color AS p, email_secondary_color AS s FROM res_company WHERE id = $1", [company])).rows[0];
    const authorUser = (await env.cr.query<{ signature: string | null }>(
      "SELECT signature FROM res_users WHERE partner_id = $1 ORDER BY id LIMIT 1", [authorId || 0])).rows[0];
    const signatureHtml = authorUser?.signature ?? "";
    // crm_lead.py:2082-2093: the deadline subtitle
    const subtitles = [displayName.length <= 100 ? displayName : (() => { throw new NotPorted("record name longer than 100 characters"); })()];
    if (lead.date_deadline) subtitles.push(`Deadline: ${strftimeDate(lead.date_deadline, dateFormat)}`);
    const preview = messagePreview(body);
    if (preview === null) throw new NotPorted("message preview longer than 190 characters");
    const bodyHtml = notificationLayout({
      lang, subtypeInternal: true, preview, buttonUrl: `${baseUrl}/mail/view?model=${encodeURIComponent(MODEL)}&res_id=${id}`,
      buttonTitle: `View ${modelDescription}`, subtitles, body,
      // :3909-3913: an author with a user signs `<div>-- <br/>%s</div>` (never html-empty, so always shown)
      signature: authorUser ? `<div>-- <br/>${signatureHtml}</div>` : null,
      primaryColor: colors?.p || "#FFFFFF", secondaryColor: colors?.s || "#875A7B",
    });
    // `_notify_by_email_get_base_mail_values` (:4007): references of up to 3 ancestors then the message
    const ancestors = (await env.cr.query<{ id: number; message_id: string; is_internal: boolean | null; sub_internal: boolean | null; message_type: string }>(
      `SELECT m.id, m.message_id, m.is_internal, s.internal AS sub_internal, m.message_type FROM mail_message m
         LEFT JOIN mail_message_subtype s ON s.id = m.subtype_id
        WHERE m.model = $1 AND m.res_id = $2 AND m.id != $3 AND m.subtype_id IS NOT NULL AND m.message_id IS NOT NULL
        ORDER BY m.id DESC LIMIT 32`, [MODEL, id, messageId])).rows;
    const key = (a: typeof ancestors[number]): number[] => [
      !a.is_internal && !a.sub_internal ? 1 : 0,
      ["comment", "auto_comment", "email", "email_outgoing"].includes(a.message_type) ? 1 : 0,
      !["user_notification", "out_of_office"].includes(a.message_type) ? 1 : 0,
    ];
    // sorted(key, reverse=True) is stable on the id DESC order
    const best = ancestors.map((a, i) => ({ a, i })).sort((x, y) => {
      const kx = key(x.a), ky = key(y.a);
      for (let j = 0; j < 3; j++) if (kx[j] !== ky[j]) return ky[j]! - kx[j]!;
      return x.i - y.i;
    }).slice(0, 3).map((x) => x.a).sort((x, y) => x.id - y.id);
    const own = (await env.cr.query<{ message_id: string }>("SELECT message_id FROM mail_message WHERE id = $1", [messageId])).rows[0]!.message_id;
    const references = [...best.map((a) => a.message_id), own].join(" ");
    const headers = `{'X-Odoo-Objects': '${MODEL}-${id}'}`;
    const mailId = (await env.cr.query<{ id: number }>(
      `INSERT INTO mail_mail (mail_message_id, body_html, "references", headers, auto_delete, is_notification, state,
         create_uid, write_uid, create_date, write_date)
       VALUES ($1, $2, $3, $4, TRUE, TRUE, 'outgoing', $5, $5, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC') RETURNING id`,
      [messageId, bodyHtml, references, headers, env.uid])).rows[0]!.id;
    for (const r of emailRecipients) {
      await env.cr.query("INSERT INTO mail_mail_res_partner_rel (mail_mail_id, res_partner_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [mailId, r.id]);
    }
    for (const r of emailRecipients) {
      // `_notify_by_email_get_base_notification_values` (:4116): read, ready, email; read_date set by is_read
      await env.cr.query(
        `INSERT INTO mail_notification (author_id, mail_message_id, mail_mail_id, res_partner_id, mail_email_address,
           notification_type, notification_status, is_read, read_date)
         VALUES ($1, $2, $3, $4, $5, 'email', 'ready', TRUE, now() AT TIME ZONE 'UTC')`,
        [authorId || null, messageId, mailId, r.id, emailNormalize(r.email)]);
    }
    // send_after_commit -> send() as superuser (mail_mail.py:745-750, :784-790, _postprocess_sent_message :286-325)
    const reason = await smtpConnectFailure();
    await env.cr.query(
      `UPDATE mail_mail SET state = 'exception', failure_reason = $2, write_uid = 1, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1`,
      [mailId, reason]);
    await env.cr.query(
      `UPDATE mail_notification SET notification_status = 'exception', failure_type = 'mail_smtp', failure_reason = NULL
        WHERE mail_mail_id = $1 AND notification_type = 'email' AND notification_status NOT IN ('sent', 'canceled')`, [mailId]);
    // mail_mail.py:320-322 `messages._notify_message_notification_update()` (mail_message.py:1445-1473): the thread
    // message's failure goes to the current user and the author (both the internal sender here) as a Store insert
    if (messageId !== undefined) {
      const notifIds = (await env.cr.query<{ id: number }>("SELECT id FROM mail_notification WHERE mail_mail_id = $1 ORDER BY id", [mailId])).rows;
      await notifyFailure(env, messageId, {
        "mail.mail": { [String(mailId)]: ["state", "failure_reason", "write_uid", "write_date"] },
        "mail.notification": Object.fromEntries(notifIds.map((n) => [String(n.id), ["notification_status", "failure_type"]])),
      });
    }
  }
}
