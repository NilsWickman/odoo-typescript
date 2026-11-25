/**
 * `mail.mail.create` and `write` (mail/models/mail_mail.py:152-180): `is_notification` when the mail is made for an
 * existing message, `scheduled_date` parsed into a naive UTC datetime (`_parse_scheduled_datetime` :328-360), and the
 * read access to the attachments checked after the write. The mail.message part goes through `_inherits` and its
 * own create override (src/models/mail_message_create.ts).
 */
import { NotPorted } from "../errors";
import type { Environment } from "../orm/types";
import { registerOverrides } from "../orm/write";
import { computeAuthor } from "./message";

/**
 * :328-360 `_parse_scheduled_datetime` of a string: dateutil's `parse(yearfirst=True)`, microseconds dropped, a naive
 * value taken as UTC, stored without timezone. Only the ISO-like forms ("YYYY-MM-DD", "YYYY-MM-DD HH:MM[:SS[.ffffff]]",
 * with a T) are ported; an unparsable string is False there, any other form refuses here.
 */
export function parseScheduledDatetime(value: unknown): string | false {
  if (value === false || value === null || value === undefined || value === "") return false;
  if (typeof value !== "string") throw new NotPorted(`mail.mail scheduled_date of type ${typeof value}`);
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?)?\s*$/.exec(value);
  if (!m) throw new NotPorted(`mail.mail scheduled_date ${JSON.stringify(value)} (dateutil parse)`);
  const [, y, mo, d, h = "00", mi = "00", s = "00"] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  if (date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d) || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) {
    throw new NotPorted(`mail.mail scheduled_date ${JSON.stringify(value)} out of range (dateutil parse)`);
  }
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

const hasAttachments = (v: Readonly<Record<string, unknown>>): boolean => Array.isArray(v["attachment_ids"]) ? v["attachment_ids"].length > 0 : Boolean(v["attachment_ids"]);

/** `attachment_ids.check_access('read')` (:166-170, :179-180): the superuser passes; other users refuse here. */
function checkAttachments(env: Environment, valsList: readonly Readonly<Record<string, unknown>>[]): void {
  if (!env.su && valsList.some(hasAttachments)) throw new NotPorted("mail.mail with attachments created by a non-superuser (their read access)");
}

/** mail_message.py:159-170 `default_get`: a missing author and email from `_message_compute_author` of the defaults. */
registerOverrides("mail.message", {
  defaultGet: async (env, fields, values) => {
    const missingAuthor = fields.includes("author_id") && !("author_id" in values);
    const missingEmail = fields.includes("email_from") && !("email_from" in values);
    if (!missingAuthor && !missingEmail) return;
    const author = values["author_id"], email = values["email_from"];
    const [authorId, emailFrom] = await computeAuthor(env, typeof author === "number" && author ? author : null, typeof email === "string" && email ? email : null);
    if (missingEmail) values["email_from"] = emailFrom;
    if (missingAuthor) values["author_id"] = authorId;
  },
});

const MAIL_STATES = ["outgoing", "sent", "received", "exception", "cancel"];

registerOverrides("mail.mail", {
  // :43-51 `default_get`: a `default_type` or `default_state` of another model's selection leaking from an action context
  defaultGet: async (env, fields, values) => {
    const type = env.context["default_type"];
    if (type !== undefined && type !== null && fields.length) throw new NotPorted("mail.mail default_get with default_type in the context");
    const state = env.context["default_state"];
    if (fields.includes("state") && state !== undefined && !MAIL_STATES.includes(String(state))) values["state"] = "outgoing";
  },
  create: async (env, valsList, next) => {
    for (const values of valsList) {
      // :155-157
      if (!("is_notification" in values) && values["mail_message_id"]) values["is_notification"] = true;
      // :158-162 (a void string crashes: False)
      values["scheduled_date"] = values["scheduled_date"] ? parseScheduledDatetime(values["scheduled_date"]) : false;
    }
    checkAttachments(env, valsList);
    return next(env, valsList);
  },
  write: async (env, ids, vals, next) => {
    // :175-177
    if (vals["scheduled_date"]) vals["scheduled_date"] = parseScheduledDatetime(vals["scheduled_date"]);
    checkAttachments(env, [vals]);
    await next(env, ids, vals);
  },
});
