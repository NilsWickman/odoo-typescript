/**
 * mail.thread write-side behaviour of crm.lead (WriteHooks, src/orm/hooks.ts; call shape in src/mail/WRITE_HOOKS.md):
 *  - create (odoo/addons/mail/models/mail_thread.py:346-410): the creator follows, `_message_auto_subscribe`
 *    (:5008) with the create values and `default_*` keys, and the creation message posted with crm's
 *    `_creation_subtype` (crm/models/crm_lead.py:2049, crm.mt_lead_create) and `_creation_message` (:2052);
 *  - write (mail_track_mixin.py:29 `_track_prepare`, mail_thread.py:415 `_message_auto_subscribe(vals)`), then the
 *    tracking log with crm's `_track_log_get_default_subtype` (crm_lead.py:2067): a subtype posts the tracking
 *    through `message_post` (mail_thread.py:628 `_track_log`), no subtype logs it (`_message_log_batch`);
 *  - unlink (crm_lead.py:971-983, mail_thread.py:431-437): meetings detached, then the generic thread cleanup of
 *    src/mail/write_hooks.ts (messages, followers, scheduled messages, activities).
 * The tracking log runs when the outermost write of crm.lead returns (the documented difference to Odoo's precommit,
 * src/mail/WRITE_HOOKS.md). The assignment notification of `_message_auto_subscribe_notify` (:4972,
 * template mail.message_user_assigned) is in src/models/crm_lead_notify.ts.
 */
import { NotPorted } from "../errors";
import { and, cond } from "../orm/domain";
import { write } from "../orm/write";
import { userInfo } from "../orm/env";
import { registerHooks, type WriteHooks } from "../orm/hooks";
import type { Environment } from "../orm/types";
import { insertFollowers } from "../mail/followers";
import { threadAfterUnlink, unlinkMessages } from "../mail/write_hooks";
import { computeAuthor, insertMessages, messageLogBatch, trackingMessageId, xmlid } from "../mail/message";
import { trackCollect, trackDiscard, trackDisabled, trackFinalize, trackPrepare } from "../mail/tracking";
import { notifyAssigned } from "./crm_lead_notify";
import { renderTemplate } from "../qweb";
import { PyEnv, PyRecords } from "../qweb/records";
import { htmlSanitize, type SanitizeOptions } from "../orm/html_sanitize";

/** mail_message.py `body = fields.Html('Contents', default='', sanitize_style=True)`: the Html field defaults otherwise. */
const BODY_SANITIZE: SanitizeOptions = { sanitizeTags: true, sanitizeAttributes: true, sanitizeStyle: true, sanitizeForm: true, stripStyle: false, stripClasses: false };

const MODEL = "crm.lead";

// ------------------------------------------------------------------------------------------------ message_post

/** `_message_compute_parent_id(False)` for a flat thread (mail_thread.py:3173-3196): the latest comment/email, else
 * the latest message, among the 200 most recent non-user_notification messages of the record. */
async function flatParent(env: Environment, model: string, resId: number): Promise<number | null> {
  const row = (await env.cr.query<{ id: number }>(
    `SELECT id FROM (SELECT id, message_type, date, create_date FROM mail_message
       WHERE res_id = $2 AND model = $1 AND message_type != 'user_notification'
       ORDER BY date DESC, id DESC LIMIT 200) m
     ORDER BY (message_type IN ('comment', 'email')) DESC, COALESCE(date, create_date) DESC NULLS LAST, id DESC LIMIT 1`,
    [model, resId])).rows[0];
  return row?.id ?? null;
}

/** No alias domain anywhere: `_notify_get_reply_to` (models.py:610) falls back to the default, the author's email;
 * crm's team aliases (crm_lead.py:2095) only give an address through an alias domain. */
async function assertNoAliasDomain(env: Environment): Promise<void> {
  const n = (await env.cr.query<{ n: string }>("SELECT count(*)::text AS n FROM mail_alias_domain")).rows[0]?.n ?? "0";
  if (Number(n) > 0) throw new NotPorted("crm.lead reply-to and record alias domains with mail alias domains");
}

/**
 * `_notify_thread` recipients (mail_thread.py `_notify_get_recipients`): followers of the record subscribed to the
 * subtype (internal subtypes only for non-share partners) and explicit partners, minus the author. Posting with any
 * recipient refuses (inbox/email notifications of tracking and creation messages are not ported).
 */
async function assertNoRecipients(env: Environment, resId: number, subtypeId: number, authorId: number | false): Promise<void> {
  const rows = (await env.cr.query<{ id: number }>(
    `SELECT DISTINCT p.id FROM mail_followers f
       JOIN mail_followers_mail_message_subtype_rel r ON r.mail_followers_id = f.id
       JOIN mail_message_subtype s ON s.id = r.mail_message_subtype_id
       JOIN res_partner p ON p.id = f.partner_id
      WHERE f.res_model = $1 AND f.res_id = $2 AND s.id = $3 AND p.active IS TRUE AND p.id != $4
        AND (s.internal IS NOT TRUE OR p.partner_share IS NOT TRUE)`,
    [MODEL, resId, subtypeId, authorId || 0])).rows;
  if (rows.length) throw new NotPorted("notifications of crm.lead followers (creation/tracking subtypes)");
}

/**
 * `message_post(body, subtype_id, message_type, author_id)` on one lead (mail_thread.py:2256-2430) for the system
 * messages crm posts (creation, tracking): no attachments or partner_ids, no author subscription (notification or
 * tracking types, :2408-2412), no recipients.
 */
async function postSystemMessage(env: Environment, resId: number, opts: { body: string; subtypeId: number; messageType: string; authorId: number | null }): Promise<number> {
  await assertNoAliasDomain(env);
  const [authorId, emailFrom] = await computeAuthor(env, opts.authorId, null);
  // `_mail_get_companies(default=env.company)`: the lead's company
  const company = (await env.cr.query<{ company_id: number | null }>("SELECT company_id FROM crm_lead WHERE id = $1", [resId])).rows[0]?.company_id
    ?? await env.company();
  const [id] = await insertMessages(env, [{
    model: MODEL, res_id: resId, body: opts.body, author_id: authorId, email_from: emailFrom,
    message_type: opts.messageType, subtype_id: opts.subtypeId, parent_id: await flatParent(env, MODEL, resId),
    subject: false, email_add_signature: true, record_alias_domain_id: false, record_company_id: company,
    reply_to: emailFrom, message_id: trackingMessageId(`${resId}-${MODEL}`),
  }]);
  await assertNoRecipients(env, resId, opts.subtypeId, authorId);
  return id!;
}

// ------------------------------------------------------------------------------------------------ tracking

/** `_track_set_log_message` targets (mail_thread.py `_track_set_log_message`): body prepended to the next tracking
 * message of the record, set by crm.lead.lost `action_lost_reason_apply` (crm/wizard/crm_lead_lost.py). */
const LOG_BODIES = new WeakMap<object, Map<number, string>>();

export function setTrackingLogMessage(env: Environment, resId: number, body: string): void {
  let m = LOG_BODIES.get(env.cr);
  if (!m) LOG_BODIES.set(env.cr, m = new Map());
  m.set(resId, body);
}

/** crm_lead.py:2067-2079 `_track_log_get_default_subtype` (end values of the lead). */
async function defaultSubtype(env: Environment, resId: number, changes: readonly string[]): Promise<number | null> {
  const lead = (await env.cr.query<{ won_status: string | null; lost_reason_id: number | null }>(
    "SELECT won_status, lost_reason_id FROM crm_lead WHERE id = $1", [resId])).rows[0];
  if (!lead) return null;
  if (changes.includes("stage_id") && lead.won_status === "won") return xmlid(env, "crm.mt_lead_won");
  if (changes.includes("lost_reason_id") && lead.lost_reason_id) return xmlid(env, "crm.mt_lead_lost");
  if (changes.includes("stage_id")) return xmlid(env, "crm.mt_lead_stage");
  if (changes.includes("won_status") && lead.won_status !== "lost") return xmlid(env, "crm.mt_lead_restored");
  if (changes.includes("won_status") && lead.won_status === "lost") return xmlid(env, "crm.mt_lead_lost");
  return null;
}

/**
 * Runs `fn` as one tracking scope over `ids`: Odoo finalizes tracking at precommit (mail_track_mixin.py:133), so
 * several writes of one method log one message per record with all its changes (measured: gcrawl G214u convert to
 * opportunity, type and contact in one message); the port otherwise finalizes per outermost write.
 */
export async function inTrackingScope<T>(env: Environment, ids: readonly number[], fn: () => Promise<T>): Promise<T> {
  await trackPrepare(env, MODEL, ids);
  const result = await fn();
  if (trackDisabled(env)) await trackCollect(env, MODEL); else await trackLog(env);
  return result;
}

/** `_track_log` (mail_thread.py:628-690): posts with a subtype in record order, then one log batch. */
async function trackLog(env: Environment): Promise<void> {
  const collected = await trackCollect(env, MODEL);
  if (!collected || !collected.changes.size) return;
  const bodies = LOG_BODIES.get(env.cr);
  const logs = new Map<number, string>();
  for (const [id, c] of collected.changes) {
    const prefix = bodies?.get(id);
    if (prefix !== undefined) bodies?.delete(id);
    const subtype = await defaultSubtype(collected.env, id, c.changes);
    // `_message_compute_body_with_trackings` (:3144): append_content_to_html(body, tracking html)
    const body = (prefix ?? "") + c.body;
    if (subtype !== null) {
      await postSystemMessage(collected.env, id, { body, subtypeId: subtype, messageType: "tracking", authorId: null });
    } else {
      logs.set(id, body);
    }
  }
  if (logs.size) await messageLogBatch(collected.env, MODEL, logs, { messageType: "tracking" });
}

// ------------------------------------------------------------------------------------------------ auto subscription

interface AutoSub { childIds: number[]; defIds: number[]; internalIds: number[]; parent: Map<number, number>; relation: Map<string, Set<string>> }

/** mail_message_subtype.py:47 `_get_auto_subscription_subtypes(model)` (search order: sequence, id). */
async function autoSubscriptionSubtypes(env: Environment, model: string): Promise<AutoSub> {
  const rows = (await env.cr.query<{ id: number; res_model: string | null; default: boolean | null; internal: boolean | null; relation_field: string | null; parent_id: number | null }>(
    `SELECT s.id, s.res_model, s."default", s.internal, s.relation_field, s.parent_id FROM mail_message_subtype s
       LEFT JOIN mail_message_subtype p ON p.id = s.parent_id
      WHERE s.res_model IS NULL OR s.res_model = $1 OR p.res_model = $1 ORDER BY s.sequence, s.id`, [model])).rows;
  const out: AutoSub = { childIds: [], defIds: [], internalIds: [], parent: new Map(), relation: new Map() };
  for (const s of rows) {
    if (!s.res_model || s.res_model === model) {
      out.childIds.push(s.id);
      if (s.default) out.defIds.push(s.id);
    }
    if (s.relation_field) {
      out.parent.set(s.id, s.parent_id ?? 0);
      const set = out.relation.get(s.res_model ?? "") ?? new Set<string>();
      set.add(s.relation_field);
      out.relation.set(s.res_model ?? "", set);
    }
    if (s.internal) out.internalIds.push(s.id);
  }
  return out;
}

/** mail_thread.py:5008-5074 `_message_auto_subscribe(updated_values, followers_existing_policy)` for crm.lead. */
async function autoSubscribe(env: Environment, ids: readonly number[], values: Readonly<Record<string, unknown>>, policy: "skip" | "update"): Promise<void> {
  if (!ids.length) return;
  const sub = await autoSubscriptionSubtypes(env, MODEL);
  const newSubtypes = new Map<number, number[]>();
  // parent documents' followers (crm.team followers of mt_salesteam_* subtypes)
  for (const [resModel, fnames] of sub.relation) {
    for (const fname of fnames) {
      const docId = values[fname];
      if (!docId) continue;
      if (typeof docId !== "number") throw new NotPorted(`auto-subscription through ${fname} = ${JSON.stringify(docId)}`);
      // mail_followers.py `_get_subscription_data(doc_data, None, include_pshare, include_active)`
      const rows = (await env.cr.query<{ partner_id: number | null; sids: number[] | null; pshare: boolean | null; active: boolean | null }>(
        `SELECT f.partner_id, array_remove(array_agg(r.mail_message_subtype_id ORDER BY r.mail_message_subtype_id), NULL) AS sids,
                p.partner_share AS pshare, p.active
           FROM mail_followers f LEFT JOIN mail_followers_mail_message_subtype_rel r ON r.mail_followers_id = f.id
           LEFT JOIN res_partner p ON p.id = f.partner_id
          WHERE f.res_model = $1 AND f.res_id = $2 GROUP BY f.id, p.partner_share, p.active ORDER BY f.id`, [resModel, docId])).rows;
      for (const r of rows) {
        const sids = r.sids ?? [];
        const mapped = [...sids.filter((s) => sub.parent.get(s)).map((s) => sub.parent.get(s)!), ...sids.filter((s) => !sub.parent.has(s) && sub.childIds.includes(s))];
        if (r.partner_id && r.active) {
          newSubtypes.set(r.partner_id, r.pshare ? mapped.filter((s) => !sub.internalIds.includes(s)) : mapped);
        }
      }
    }
  }
  if (newSubtypes.size) throw new NotPorted("crm.lead auto-subscription of sales team followers (subtype set order)");
  // :4935-4970 `_message_auto_subscribe_followers`: the tracked user_id is subscribed, notified when not the env user
  const notify: { partnerId: number; lang: string | null }[] = [];
  const userId = values["user_id"];
  if (userId) {
    if (typeof userId !== "number") throw new NotPorted(`auto-subscription of user_id ${JSON.stringify(userId)}`);
    const user = (await env.cr.query<{ active: boolean; partner_id: number; lang: string | null }>(
      "SELECT u.active, u.partner_id, p.lang FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1", [userId])).rows[0];
    if (user?.active) {
      if (!newSubtypes.has(user.partner_id)) newSubtypes.set(user.partner_id, sub.defIds);
      if (userId !== env.uid) notify.push({ partnerId: user.partner_id, lang: user.lang });
    }
  }
  if (newSubtypes.size) {
    await insertFollowers(env, MODEL, ids, [...newSubtypes.keys()], newSubtypes, { checkExisting: true, policy });
  }
  // :5071-5072 grouped by (template, lang)
  const byLang = new Map<string | null, number[]>();
  for (const n of notify) byLang.set(n.lang, [...(byLang.get(n.lang) ?? []), n.partnerId]);
  for (const [lang, pids] of byLang) {
    if (env.context["mail_auto_subscribe_no_notify"] || env.context["install_demo"]) continue;
    await notifyAssigned(lang ? env.withContext({ ...env.context, lang }) : env, ids, pids);
  }
}

// ------------------------------------------------------------------------------------------------ hooks

const hooks: WriteHooks = {
  afterCreate: async (env, ids, valsList) => {
    if (!ids.length) return;
    if (env.context["tracking_disable"]) { await trackDiscard(env, MODEL, ids); return; } // :357-360
    let postEnv = env;
    if (env.context["mail_create_nosubscribe"] && !("mail_post_autofollow_author_skip" in env.context)) {
      postEnv = env.withContext({ ...env.context, mail_post_autofollow_author_skip: true }); // :353-354
    }
    const user = await userInfo(env);
    if (!env.context["mail_create_nosubscribe"] && user.active && !user.share) {
      await insertFollowers(env, MODEL, ids, [user.partnerId], null, { customerIds: [], checkExisting: false, policy: "skip" });
    }
    for (let i = 0; i < ids.length; i++) {
      const createValues: Record<string, unknown> = { ...valsList[i] };
      for (const [k, v] of Object.entries(env.context)) if (k.startsWith("default_") && !(k.slice(8) in createValues)) createValues[k.slice(8)] = v;
      await autoSubscribe(postEnv, [ids[i]!], createValues, "update");
    }
    if (!env.context["mail_create_nolog"]) {
      const subtype = await xmlid(env, "crm.mt_lead_create");
      for (const id of ids) {
        // crm_lead.py:2052-2059 `_creation_message`: '' when the lead has a partner or no custom creation data
        const lead = (await env.cr.query<Record<string, unknown>>(
          `SELECT partner_id, partner_name, contact_name, function, website, street, street2, city, zip, state_id, country_id
             FROM crm_lead WHERE id = $1`, [id])).rows[0] ?? {};
        const custom = ["partner_name", "contact_name", "function", "website", "street", "street2", "city", "zip", "state_id", "country_id"].some((f) => lead[f]);
        // otherwise the QWeb template crm.crm_lead_creation_message rendered for the lead (crm_lead.py:2054-2055)
        let message = "";
        if (!lead["partner_id"] && custom) {
          if (env.lang && env.lang !== "en_US") throw new NotPorted(`crm.lead creation message in ${env.lang}`);
          message = await renderTemplate(env.cr, "crm.crm_lead_creation_message", { lead: new PyRecords(env, MODEL, [id]), env: new PyEnv(env) }, { lang: "en_US" });
        }
        // mail_thread.py:386-389: sudo message_post, author the user's partner, Markup('<div><p>%s</p></div>') % message;
        // mail.message.body is an Html field (sanitize, sanitize_style)
        const body = message ? htmlSanitize(`<div><p>${message}</p></div>`, BODY_SANITIZE) : "<div><p></p></div>";
        await postSystemMessage(postEnv.sudo(), id, { body, subtypeId: subtype, messageType: "notification", authorId: user.partnerId });
      }
    }
    await trackDiscard(env, MODEL, ids);
    // `_track_prepare_for_template`: crm.lead has no `_track_template` (no stage mail templates in crm)
  },
  beforeWrite: async (env, ids) => {
    await trackPrepare(env, MODEL, ids);
  },
  afterWrite: async (env, ids, vals) => {
    if (!env.context["tracking_disable"]) await autoSubscribe(env, ids, vals, "skip"); // :418-419
    if (trackDisabled(env)) {
      await trackCollect(env, MODEL); // keep the nesting depth balanced
      return;
    }
    await trackLog(env);
  },
  // crm_lead.py:971-983: the leads' meetings lose their document, then mail.thread unlink (mail_thread.py:431-437)
  beforeUnlink: async (env, ids) => {
    if (!ids.length) return;
    const meetings = await env.model("calendar.event").search(and([cond("res_id", "in", [...ids]), cond("res_model", "=", MODEL)]));
    if (meetings.length) await write(env, "calendar.event", meetings, { res_id: false, res_model_id: false });
    await trackDiscard(env, MODEL, ids);
    await unlinkMessages(env, MODEL, ids);
  },
  afterUnlink: (env, ids) => threadAfterUnlink(env, MODEL, ids),
};

registerHooks(MODEL, { write: [hooks] });

/**
 * The partner writes of a lead creation (the email_from/phone inverses, crm_lead.py:456-479) are tracked like
 * Odoo's precommit (mail_track_mixin.py:91-133): one tracking message per partner, logged after the lead's creation
 * message. The partner tracking is held open around the whole create (depth +1) and closed after the creation hook.
 */
registerHooks(MODEL, {
  write: [{
    beforeCreate: async (env) => { await trackPrepare(env, "res.partner", []); },
    // res.partner has no `_track_log_get_default_subtype`: the generic log (src/mail/write_hooks.ts afterWrite)
    afterCreate: async (env) => { await trackFinalize(env, "res.partner"); },
  }],
});

/**
 * Run `fn` as one tracking unit for crm.lead: Odoo tracks every write of a transaction together and logs at
 * precommit (mail_track_mixin.py:76-133), so a method doing several writes (crm_lead.py:1042 `action_restore`:
 * unarchive then probability; :1051 `action_set_lost`: archive then write) logs one message per lead. The port
 * finalizes at the outermost write (src/mail/tracking.ts), so such methods run inside this scope.
 */
export async function withLeadTracking<T>(env: Environment, fn: () => Promise<T>): Promise<T> {
  await trackPrepare(env, MODEL, []); // opens a nesting level without snapshotting
  let result: T;
  try {
    result = await fn();
  } catch (e) {
    await trackCollect(env, MODEL); // close the level; the request rolls back
    throw e;
  }
  if (trackDisabled(env)) await trackCollect(env, MODEL);
  else await trackLog(env);
  return result;
}
