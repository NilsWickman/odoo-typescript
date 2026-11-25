/**
 * The attendees' answers to an invitation (odoo/addons/calendar/models/calendar_attendee.py:220-242): `do_tentative`
 * writes the state; `do_accept` and `do_decline` first post "<name> has accepted/declined the invitation" on the event
 * per attendee, as the attendee's partner (mail_thread.py:2256-2449 `message_post` with `author_id` and
 * `subtype_xmlid='calendar.subtype_invitation'`, message type notification), then write the state. The attendee's
 * `write` (:71-74) checks write access on the events after it.
 *
 * Refused before anything is written: a post that would notify somebody (followers of the invitation subtype other than
 * the author), an author without an email (Odoo's UserError is not ported), record alias domains.
 */
import { NotPorted } from "../errors";
import { registerMethod } from "../http/methods";
import type { Environment } from "../orm/types";
import { write } from "../orm/write";
import { ModelImpl } from "../orm/model";
import { envFor } from "../web/common";
import { escapeText, insertMessages, partnerEmailFormatted, replyToDefault, trackingMessageId, xmlid } from "../mail/message";
import { sanitizeBody } from "../mail/sanitize";
import { flatThreadParent } from "../mail/thread_generic";
import { translate } from "./util";

interface Attendee { id: number; event_id: number; partner_id: number | null; common_name: string | null }

async function attendeesOf(env: Environment, ids: readonly number[]): Promise<Attendee[]> {
  // `self` in its order; the ORM read as the user (a missing or forbidden attendee raises there)
  const rows = await env.model("calendar.attendee").read([...ids], ["event_id", "partner_id", "common_name"], "");
  return rows.map((r) => ({
    id: Number(r["id"]), event_id: Number(Array.isArray(r["event_id"]) ? r["event_id"][0] : r["event_id"]),
    partner_id: Array.isArray(r["partner_id"]) ? Number(r["partner_id"][0]) : typeof r["partner_id"] === "number" ? r["partner_id"] : null,
    common_name: typeof r["common_name"] === "string" ? r["common_name"] : null,
  }));
}

/** :71-74 the attendee write, then `self.event_id.check_access('write')`. */
async function writeState(env: Environment, ids: readonly number[], state: string): Promise<void> {
  const events = [...new Set((await attendeesOf(env, ids)).map((a) => a.event_id))];
  await write(env, "calendar.attendee", ids, { state });
  await new ModelImpl(env, env.reg.model("calendar.event")).checkAccess(events, "write");
}

/** One `message_post` per attendee on its event (body a plain `_()` string: escaped, then the Html field's sanitize). */
async function postAnswers(env: Environment, attendees: readonly Attendee[], source: string): Promise<void> {
  const subtype = await xmlid(env, "calendar.subtype_invitation");
  if ((await env.cr.query("SELECT 1 FROM res_company WHERE id = $1 AND alias_domain_id IS NOT NULL", [await env.company()])).rows.length) {
    throw new NotPorted("record alias domains (_mail_get_alias_domains)");
  }
  for (const a of attendees) {
    if (a.partner_id === null) throw new NotPorted("an invitation answer of an attendee without a partner (author)");
    // mail_thread.py `_message_compute_author`: the author's formatted email, else a UserError
    const emailFrom = await partnerEmailFormatted(env, a.partner_id);
    if (!emailFrom) throw new NotPorted("an invitation answer of an author without an email (UserError)");
    // `_notify_get_recipients`: followers of the subtype (internal subtypes for internal partners), the author excluded
    const recipients = await env.cr.query(
      `SELECT 1 FROM mail_followers f JOIN mail_followers_mail_message_subtype_rel r ON r.mail_followers_id = f.id
         JOIN mail_message_subtype s ON s.id = r.mail_message_subtype_id JOIN res_partner p ON p.id = f.partner_id
        WHERE f.res_model = 'calendar.event' AND f.res_id = $1 AND s.id = $2 AND p.id != $3 AND p.active
          AND (s.internal IS NOT TRUE OR p.partner_share IS NOT TRUE) LIMIT 1`, [a.event_id, subtype, a.partner_id]);
    if (recipients.rows.length) throw new NotPorted("notifications of an invitation answer to the event's followers");
    const body = sanitizeBody(escapeText(translate(env, source, "calendar").replace("%s", a.common_name ?? "False")));
    await insertMessages(env.sudo(), [{
      model: "calendar.event", res_id: a.event_id, body, author_id: a.partner_id, email_from: emailFrom, message_type: "notification",
      subtype_id: subtype, email_add_signature: true, record_alias_domain_id: false, record_company_id: await env.company(),
      reply_to: await replyToDefault(env, emailFrom), parent_id: await flatThreadParent(env, "calendar.event", a.event_id),
      message_id: trackingMessageId(`${a.event_id}-calendar.event`),
    }]);
  }
}

registerMethod("calendar.attendee", "do_tentative", async (env0, ids, _args, kwargs) => {
  const { env } = envFor(env0, kwargs);
  await writeState(env, ids ?? [], "tentative");
  return true;
}, { apiModel: false });

registerMethod("calendar.attendee", "do_accept", async (env0, ids, _args, kwargs) => {
  const { env } = envFor(env0, kwargs);
  await postAnswers(env, await attendeesOf(env, ids ?? []), "%s has accepted the invitation");
  await writeState(env, ids ?? [], "accepted");
  return true;
}, { apiModel: false });

registerMethod("calendar.attendee", "do_decline", async (env0, ids, _args, kwargs) => {
  const { env } = envFor(env0, kwargs);
  await postAnswers(env, await attendeesOf(env, ids ?? []), "%s has declined the invitation");
  await writeState(env, ids ?? [], "declined");
  return true;
}, { apiModel: false });
