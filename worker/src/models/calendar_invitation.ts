/**
 * The calendar's mails to the attendees: calendar_attendee.py:114-210 `_send_invitation_emails` / `_notify_attendees`
 * with `calendar_template_meeting_invitation` (calendar_event.py:946 at create, :1094-1095 for new attendees) and
 * `calendar_template_meeting_changedate` (:1096-1104, a future start), and :1969-2040 `_get_ics_file`.
 *
 * For each notified attendee, in the order of `set(self.ids)`, other than the user and with an email: an
 * `invitation.ics` attachment (`no_document`, on mail.compose.message 0), the template rendered for the attendee in
 * the language of its partner (`compute_lang`), then `message_notify` on the event as superuser (light layout, the
 * attachment moved to the event, mail.mail queued) and, with `force_send`, `send_after_commit` of the mails (D9: the
 * refused SMTP connection, src/mail/notify.ts).
 *
 * Refused before anything is written: templates with attachments, languages other than en_US, all-day events (the
 * calendar file's dates), record alias domains, inbox recipients, partners without an email among the notified.
 */
import { NotPorted, UserError } from "../errors";
import { requestOfCursor } from "../http/context";
import { html2plaintext, pySplitlines } from "../mail/html2plaintext";
import { computeAuthor, insertMessages, replyToDefault, trackingMessageId, xmlid } from "../mail/message";
import { notifyThread, type NotifyResult } from "../mail/notify";
import { recordCompany } from "../mail/thread_generic";
import { userInfo } from "../orm/env";
import { htmlSanitize } from "../orm/html_sanitize";
import type { Environment } from "../orm/types";
import { renderTemplateField } from "../qweb/mail_render";
import { PyRecords } from "../qweb/records";
import { isHtmlEmpty } from "../web/empty_list_help";
import { createBinaryAttachment } from "./account_move_send_mail";
import { serializeIcs, type IcsAlarm } from "./ics";
import { PySet } from "./pyset";
import { configParam, formatPosix, getLang, wallClock } from "./tail_util";
import { datetimeToString, dbNow, translate } from "./util";
import { markPending } from "./calendar_flush";

/** One attendee as the callers know it. */
export interface Attendee { readonly id: number; readonly partner: number; readonly email: string | null; readonly event: number }

/** `html_sanitize(src)` with its defaults (tools/mail.py:425). */
const SANITIZE = { sanitizeTags: true, sanitizeAttributes: false, sanitizeStyle: false, sanitizeForm: true, stripStyle: false, stripClasses: false };
/** The mail.message `body` field's sanitize (mail_message.py:175 `fields.Html(sanitize_style=True)`). */
const MESSAGE_BODY = { sanitizeTags: true, sanitizeAttributes: true, sanitizeStyle: true, sanitizeForm: true, stripStyle: false, stripClasses: false };

const utc = (s: string): Date => new Date(`${s.slice(0, 19).replace(" ", "T")}Z`);

/** calendar_event.py:1969-2040 `_get_ics_file` of one event (`fields.Datetime.now()` and vobject's clock: the transaction's). */
async function icsFile(env: Environment, eventId: number): Promise<Uint8Array> {
  const e = (await env.cr.query<{ start: string | null; stop: string | null; allday: boolean | null; name: string | null; description: string | null;
    location: string | null; videocall_location: string | null; rrule: string | null; user_id: number | null }>(
    `SELECT to_char(e.start, 'YYYY-MM-DD HH24:MI:SS') AS start, to_char(e.stop, 'YYYY-MM-DD HH24:MI:SS') AS stop, e.allday, e.name, e.description,
            e.location, e.videocall_location, r.rrule, e.user_id
       FROM calendar_event e LEFT JOIN calendar_recurrence r ON r.id = e.recurrence_id WHERE e.id = $1`, [eventId])).rows[0];
  if (!e) throw new NotPorted(`calendar file of a missing event ${eventId}`);
  if (e.allday) throw new NotPorted("calendar file of an all-day event (dates without time)");
  if (!e.start || !e.stop) throw new UserError("First you have to specify the date of the invitation.");
  const lang = env.lang ?? "en_US";
  const alarms: IcsAlarm[] = (await env.cr.query<{ interval: string; duration: number; name: string | null }>(
    `SELECT a.interval, a.duration, COALESCE(a.name->>$2, a.name->>'en_US') AS name FROM calendar_alarm_calendar_event_rel r
       JOIN calendar_alarm a ON a.id = r.calendar_alarm_id WHERE r.calendar_event_id = $1 ORDER BY a.id`, [eventId, lang])).rows
    .map((a) => ({ interval: a.interval, duration: Number(a.duration), description: a.name || "Odoo" }));
  const attendees = (await env.cr.query<{ email: string | null }>(
    `SELECT p.email FROM calendar_attendee a JOIN res_partner p ON p.id = a.partner_id WHERE a.event_id = $1 ORDER BY a.create_date, a.id`, [eventId])).rows
    .map((a) => `MAILTO:${a.email ?? ""}`);
  let organizer: { value: string; cn: string | null } | null = null;
  if (e.user_id !== null) {
    const p = (await env.cr.query<{ id: number; email: string | null; name: string | null }>(
      "SELECT p.id, p.email, p.name FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1", [e.user_id])).rows[0];
    if (p?.email) {
      const display = p.name ? (await env.model("res.partner").displayName([p.id])).get(p.id) ?? "" : null;
      organizer = { value: `MAILTO:${p.email}`, cn: display === null ? null : display.replace(/"/g, "'") };
    }
  }
  // `_get_customer_description`: html_sanitize of a non-empty description, then html2plaintext
  const description = isHtmlEmpty(e.description) ? "" : html2plaintext(htmlSanitize(String(e.description), SANITIZE));
  const now = datetimeToString(await dbNow(env)).slice(0, 19);
  const stamp = now.replace(/[-: ]/g, "").replace(/^(\d{8})(\d{6})$/, "$1T$2Z");
  return serializeIcs({
    // icalendar.py:721-726 (socket.gethostname(): the Worker has none, "worker" as in its message ids)
    uid: `${stamp} - ${Math.floor(Math.random() * 100000)}@worker`,
    created: now, dtstamp: now, dtstart: e.start, dtend: e.stop, summary: e.name ?? "", description: description || null,
    location: e.location || null, url: e.videocall_location || null,
    // `meeting.rrule.splitlines()[-1].replace("RRULE:", "", 1)`
    rrule: e.rrule ? (pySplitlines(e.rrule).pop() ?? "").replace("RRULE:", "") : null,
    alarms, attendees, organizer,
  });
}

interface Rendered { readonly attendee: Attendee; readonly body: string; readonly subject: string; readonly emailFrom: string; readonly author: number }

/** calendar_attendee.py:114-121 `_send_invitation_emails`: the attendees of future events get the invitation. */
export async function sendInvitationEmails(env: Environment, attendees: readonly Attendee[]): Promise<void> {
  if (!attendees.length) return;
  const now = datetimeToString(await dbNow(env));
  const future = new Set((await env.cr.query<{ id: number }>(
    "SELECT id FROM calendar_event WHERE id = ANY($1::int[]) AND to_char(start, 'YYYY-MM-DD HH24:MI:SS') > $2", [[...new Set(attendees.map((a) => a.event))], now])).rows.map((r) => r.id));
  await notifyAttendees(env, attendees.filter((a) => future.has(a.event)), "calendar.calendar_template_meeting_invitation", true);
}

/**
 * `_notify_attendees(mail_template, force_send=force_send)` of `attendees` (their order is `self`'s), the template
 * rendered in `env` (the environment the caller took the template from).
 */
export async function notifyAttendees(env: Environment, attendees: readonly Attendee[], templateXmlid: string, forceSend: boolean): Promise<void> {
  if (!attendees.length) return;
  // :132-137 `set(self.ids)` minus the attendees of draft events (`_skip_send_mail_status_update`)
  const ids = PySet.fromList(attendees.map((a) => a.id));
  const events = [...new Set(attendees.map((a) => a.event))];
  const drafts = new Set((await env.cr.query<{ id: number }>("SELECT id FROM calendar_event WHERE id = ANY($1::int[]) AND is_draft", [events])).rows.map((r) => r.id));
  for (const a of attendees) if (drafts.has(a.event)) ids.discard(a.id);
  const byId = new Map(attendees.map((a) => [a.id, a]));
  const notified = ids.order().map((id) => byId.get(id)!);
  if (env.context["no_mail_to_attendees"]) return;
  const template = await env.reg.xmlid(env.cr, templateXmlid);
  // :151-161 a template with attachments copies them for every attendee, mailed or not
  if (template !== null && (await env.cr.query("SELECT 1 FROM email_template_attachment_rel WHERE email_template_id = $1 LIMIT 1", [template])).rows.length) {
    throw new NotPorted("calendar mail template with attachments (copies per attendee)");
  }
  const self = (await userInfo(env)).partnerId;
  const mailed = notified.filter((a) => a.email && a.partner !== self);
  if (!mailed.length) return; // nothing observable is left: the calendar files and the template are only computed
  // `-=` resizes the table when over a quarter of it is dummies (setobject.c set_difference_update_internal), which
  // can reorder what is left: not ported
  if (notified.length >= 2 && notified.length < attendees.length) throw new NotPorted("calendar mails of draft and other events together (set resize)");
  // :140-142 (ir_config_parameter.get_bool: a set value refuses, its typed parsing is not ported)
  if ((await configParam(env.sudo(), "calendar.block_mail")) !== null) throw new NotPorted("calendar.block_mail set");
  if (template === null) return; // :143-145 a warning, nothing sent
  const limit = forceSend ? Number((await configParam(env.sudo(), "mail.mail_force_send_limit")) ?? 100) : 0;
  if (forceSend && !Number.isInteger(limit)) throw new NotPorted("mail.mail_force_send_limit that is not an integer");
  await checkRecipients(env, mailed);
  // :148 the calendar files of the notified attendees' events (only those of a mail are observable: refusals such as an
  // all-day event's dates stay with them), then each mail rendered, all before anything is written
  const ics = new Map<number, Uint8Array>();
  for (const event of [...new Set(mailed.map((a) => a.event))]) ics.set(event, await icsFile(env, event));
  const rendered: Rendered[] = [];
  for (const a of mailed) rendered.push(await renderFor(env, template, a));
  const ctx = requestOfCursor(env.cr);
  if (ctx === null) throw new NotPorted("calendar mails outside a request");
  const su = env.sudo();
  const note = await xmlid(env, "mail.mt_note");
  const results: NotifyResult[] = [];
  for (const r of rendered) {
    const { attendee: a } = r;
    // :167-179 the attachment as the user (its create_uid is the user's, so `_process_attachments_for_post` moves it)
    const att = await createBinaryAttachment(env, { name: "invitation.ics", description: "invitation.ics", data: ics.get(a.event)!, mimetype: "text/calendar",
      resModel: "mail.compose.message", resId: 0, resField: null, company: await env.company() });
    // mail_thread.py:2514-2518 `_process_attachments_for_post`: the pending attachment moves to the event
    await env.cr.query(`UPDATE ir_attachment SET res_model = 'calendar.event', res_id = $2, write_uid = $3, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1`, [att, a.event, env.uid]);
    markPending(env, "ir.attachment", [att]);
    // mail_thread.py:2815-2950 `message_notify` on the event as superuser
    const [authorId, emailFrom] = await computeAuthor(su, r.author, r.emailFrom || null);
    const [mid] = await insertMessages(su, [{
      model: "calendar.event", res_id: a.event, body: htmlSanitize(r.body, MESSAGE_BODY), author_id: authorId, email_from: emailFrom,
      message_type: "user_notification", subtype_id: note, is_internal: true, subject: r.subject, reply_to: await replyToDefault(su, emailFrom),
      message_id: trackingMessageId("message-notify"), email_add_signature: true, record_alias_domain_id: false,
      record_company_id: await recordCompany(su, "calendar.event", a.event), email_layout_xmlid: "mail.mail_notification_light",
      partner_ids: [a.partner], attachment_ids: [att],
    }]);
    results.push(await notifyThread(ctx, su, "calendar.event", a.event, mid!, { light: true }));
  }
  // :202-205 `send_after_commit` of all the mails when fewer attendees than the limit were notified
  if (forceSend && notified.length < limit) for (const r of results) await r.send();
}

/** What `_notify_thread` would refuse, checked before anything is written. */
async function checkRecipients(env: Environment, mailed: readonly Attendee[]): Promise<void> {
  if (!mailed.length) return;
  if (Number((await env.cr.query<{ n: string }>("SELECT count(*)::text AS n FROM mail_alias_domain")).rows[0]?.n ?? 0) > 0) throw new NotPorted("calendar mails with alias domains (reply-to, bounce)");
  const rows = (await env.cr.query<{ id: number; lang: string | null; active: boolean | null; notif: string | null }>(
    `SELECT p.id, p.lang, p.active, (SELECT u.notification_type FROM res_users u WHERE u.partner_id = p.id AND u.active ORDER BY u.share, u.id LIMIT 1) AS notif
       FROM res_partner p WHERE p.id = ANY($1::int[])`, [mailed.map((a) => a.partner)])).rows;
  for (const p of rows) {
    if (p.notif === "inbox") throw new NotPorted("calendar mail to a user notified in the inbox");
    if (p.lang && p.lang !== "en_US") throw new NotPorted(`calendar mail in ${p.lang} (translated template)`);
  }
  if ((env.lang ?? "en_US") !== "en_US") throw new NotPorted(`calendar mail rendered in ${env.lang}`);
  // the failed send goes to the author's user on the bus (src/mail/notify.ts notifyFailure): ported for the user only
  const organizers = (await env.cr.query<{ u: number | null }>(
    `SELECT (SELECT u2.id FROM res_users u2 WHERE u2.partner_id = u.partner_id AND u2.active ORDER BY u2.share, u2.id LIMIT 1) AS u
       FROM calendar_event e JOIN res_users u ON u.id = e.user_id WHERE e.id = ANY($1::int[])`, [[...new Set(mailed.map((a) => a.event))]])).rows;
  if (organizers.some((o) => o.u !== null && o.u !== env.uid && o.u !== 1)) throw new NotPorted("calendar mail of an event organized by another user (failure notification to that user)");
}

/** :181-193 the template's body (compute_lang: the partner's language), subject and sender for the attendee. */
async function renderFor(env: Environment, template: number, a: Attendee): Promise<Rendered> {
  const lang = (await env.cr.query<{ lang: string | null }>("SELECT lang FROM res_partner WHERE id = $1", [a.partner])).rows[0]?.lang || null;
  const body = await renderTemplateField(env, template, "body_html", a.id, lang, false);
  const subject = await renderTemplateField(env, template, "subject", a.id, lang, false);
  const emailFrom = await renderTemplateField(env, template, "email_from", a.id, null, false);
  // :194-196 author: the organizer's partner, else the user's
  const organizer = (await env.cr.query<{ p: number | null }>(
    "SELECT u.partner_id AS p FROM calendar_event e LEFT JOIN res_users u ON u.id = e.user_id WHERE e.id = $1", [a.event])).rows[0]?.p ?? null;
  return { attendee: a, body, subject, emailFrom, author: organizer ?? (await userInfo(env)).partnerId };
}

/** calendar_event.py:1915-1921 `find_partner_customer`: the first attendee's partner who is not the organizer's. */
export async function findPartnerCustomer(recs: PyRecords): Promise<PyRecords> {
  recs.ensureOne();
  const organizer = (await recs.path("user_id.partner_id")) as PyRecords;
  for (const att of ((await recs.field("attendee_ids")) as PyRecords).pyIter() as PyRecords[]) {
    const partner = (await att.field("partner_id")) as PyRecords;
    if (!partner.pyEquals(organizer)) return partner;
  }
  return new PyRecords(recs.env, "calendar.attendee", []);
}

/**
 * calendar_event.py:1962-1967 `get_display_time_tz(tz)` and :2088-2128 `_get_display_time`: the date in the context's
 * zone (`format_date` through `context_timestamp`), the times in the user's (`format_time` without tz, misc.py:1522).
 */
export async function getDisplayTimeTz(recs: PyRecords, args: unknown[], kwargs: ReadonlyMap<string, unknown>): Promise<string> {
  recs.ensureOne();
  const tzArg = args[0] ?? kwargs.get("tz") ?? false;
  if (tzArg !== false && tzArg !== null && typeof tzArg !== "string") throw new NotPorted("get_display_time_tz of a non-string tz");
  const env = tzArg ? recs.env.withContext({ ...recs.env.context, tz: tzArg }) : recs.env;
  const user = await userInfo(env);
  const valid = (tz: unknown): string | null => {
    if (typeof tz !== "string" || !tz) return null;
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch (e) { if (e instanceof RangeError) return null; throw e; }
  };
  const timezone = (typeof env.context["tz"] === "string" && env.context["tz"]) || user.tz || "UTC";
  const dateTz = valid(env.context["tz"] || user.tz) ?? "UTC";
  const timeTz = valid(user.tz || "UTC") ?? "UTC";
  const e = (await env.cr.query<{ start: string; stop: string; duration: number | null; allday: boolean | null }>(
    "SELECT to_char(start, 'YYYY-MM-DD HH24:MI:SS') AS start, to_char(stop, 'YYYY-MM-DD HH24:MI:SS') AS stop, duration, allday FROM calendar_event WHERE id = $1", [recs.ids[0]])).rows[0]!;
  const lang = await getLang(env);
  const date = (v: string): string => formatPosix(lang.dateFormat, wallClock(utc(v), dateTz), lang.code);
  const time = (v: string): string => formatPosix(lang.timeFormat.replace(":%S", ""), wallClock(utc(v), timeTz), lang.code);
  if (e.allday) return translate(env, "All Day, %(day)s").replace("%(day)s", date(e.start));
  if (Number(e.duration ?? 0) < 24) {
    return translate(env, "%(day)s at (%(start)s To %(end)s) (%(timezone)s)").replace("%(day)s", date(e.start)).replace("%(start)s", time(e.start))
      .replace("%(end)s", time(e.stop)).replace("%(timezone)s", String(timezone));
  }
  return translate(env, "%(date_start)s at %(time_start)s To\n %(date_end)s at %(time_end)s (%(timezone)s)").replace("%(date_start)s", date(e.start))
    .replace("%(time_start)s", time(e.start)).replace("%(date_end)s", date(e.stop)).replace("%(time_end)s", time(e.stop)).replace("%(timezone)s", String(timezone));
}
