/**
 * Partners for the emails of a message's recipients: mail_thread.py:2057-2174 `_partner_find_from_emails_single` on
 * one record (or the mail.thread tool, `model` null), with res_partner.py:101-215 `_find_or_create_from_emails`:
 * the active partners holding each normalized email, sorted by the record's preferences (the user, the record's
 * followers, internal, with users, of the record's company, the exact formatted address, without company). Unless
 * `noCreate` (users who are not partner managers: the emails nobody holds are dropped), an email nobody holds would
 * get a new partner, which refuses (see below). Emails that do not normalize (res_partner.py:144-150, a partner
 * found or created by the raw text) refuse.
 */
import { NotPorted } from '../errors';
import { cond } from '../orm/domain';
import { userInfo } from '../orm/env';
import type { Environment } from '../orm/types';
import { emailNormalize } from './message';
import { aliasMatcher, parseContactFromEmail } from './thread_generic';

interface Found { id: number; email: string | null; email_normalized: string | null; name: string | null; partner_share: boolean | null; company_id: number | null; has_user: boolean }

/** The record's company (`_mail_get_companies()` without default, models.py:137-153): null without one. */
async function recordCompanyOrNull(env: Environment, model: string | null, resId: number | null): Promise<number | null> {
  if (model === null || resId === null) return null;
  const def = env.reg.model(model);
  if (!def.fields.has('company_id')) return null;
  const v = (await env.sudo().model(model).read([resId], ['company_id'], ''))[0]?.['company_id'];
  return typeof v === 'number' && v ? v : Array.isArray(v) ? Number(v[0]) : null;
}

/** The partners found for the emails, in the emails' order (none for an email nobody holds), as `_find_or_create_from_emails`. */
export async function partnerFindFromEmails(env: Environment, model: string | null, resId: number | null, emails: readonly string[],
  noCreate: boolean): Promise<number[]> {
  if (!emails.length) return [];
  // mail_thread.py:2111-2125: the record's company per email key
  const company = await recordCompanyOrNull(env, model, resId);
  for (const mail of emails) {
    if (!emailNormalize(mail)) throw new NotPorted('finding or creating a partner for a recipient that is not a valid email');
  }
  // :2137-2139 followers (as sudo) and the alias addresses banned from linking
  const followers = model !== null && resId !== null
    ? new Set((await env.cr.query<{ partner_id: number }>('SELECT partner_id FROM mail_followers WHERE res_model = $1 AND res_id = $2', [model, resId])).rows.map((r) => r.partner_id))
    : new Set<number>();
  const isAlias = await aliasMatcher(env);
  // res_partner.py:150-170: name / normalized email of each input, the partners holding them (as the user, id ASC)
  const nameEmails = emails.map((e) => parseContactFromEmail(e));
  const wanted = [...new Set(nameEmails.map(([, n]) => n).filter((n) => n && !isAlias(n)))];
  const ids = wanted.length ? await env.model('res.partner').search(cond('email_normalized', 'in', wanted), { order: 'id ASC' }) : [];
  if (!noCreate) {
    // :172-197 a new partner per normalized email nobody holds (with the record's company and customer information):
    // refused. Created and compared on 2026-11-17 (proofs/scenarios/nt_send_message.py) the database was identical,
    // but the answer's Store version lists the new partners' fields in the order Odoo's cache flushed them during
    // the request (mail/models/models.py:28-33 `_flush`, several flushes whose points the port has no cache to know)
    const have = new Set((await rows(env, ids)).map((r) => r.email_normalized));
    const missing = nameEmails.map(([, n]) => n).filter((n) => n && !have.has(n) && !isAlias(n));
    if (missing.length) throw new NotPorted(`creating a contact for the recipient ${missing[0]} (the Store version of a new contact)`);
  }
  // :201-202 then mail_thread.py:2142-2153 sort_key, reversed (False < True; Python's sort is stable)
  const user = (await userInfo(env)).partnerId;
  const found = await rows(env, ids);
  const sortKey = (p: Found): boolean[] => [
    p.id === user, followers.has(p.id), !p.partner_share, p.has_user,
    (p.company_id ?? false) === (company !== null && p.email_normalized !== null ? company : false),
    // `email_formatted in emails_set`: always `"name" <email>` (base res_partner.py:677-680, `name or "False"`), never
    // one of the plain emails this path accepts
    false,
    p.company_id === null,
  ];
  const sorted = found.map((p, i) => ({ p, k: sortKey(p), i })).sort((a, b) => {
    for (let j = 0; j < a.k.length; j++) if (a.k[j] !== b.k[j]) return a.k[j] ? -1 : 1;
    return a.i - b.i;
  }).map((x) => x.p);
  // :204-213 the first partner of each email (a void one when none)
  return nameEmails.map(([, normalized]) => sorted.find((p) => p.email_normalized === normalized)?.id ?? 0).filter((id) => id !== 0);
}

/** The partners in `ids`' order with the fields the sort reads (`user_ids`: active users). */
async function rows(env: Environment, ids: readonly number[]): Promise<Found[]> {
  if (!ids.length) return [];
  const r = (await env.cr.query<Found>(
    `SELECT p.id, p.email, p.email_normalized, p.name, p.partner_share, p.company_id,
            EXISTS (SELECT 1 FROM res_users u WHERE u.partner_id = p.id AND u.active) AS has_user
       FROM res_partner p WHERE p.id = ANY($1::int[])`, [[...ids]])).rows;
  const byId = new Map(r.map((x) => [x.id, x]));
  return ids.map((id) => byId.get(id)!).filter(Boolean);
}
