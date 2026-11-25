/**
 * Wave 2 Worker 1 — Remaining In-App Wizards & Utility Buttons:
 *  1. Portal Access Wizard (`portal.wizard`, `portal.wizard.user`)
 *  2. Partner Merge Wizard (`base.partner.merge.automatic.wizard`)
 *  3. Change Password & Identity Check (`change.password.wizard`, `change.password.user`, `res.users.identitycheck`)
 *  4. Privacy Lookup Wizard (`privacy.lookup.wizard`, `privacy.lookup.wizard.line`, `privacy.log`)
 *  5. UTM Campaign Smart Buttons & Computes (`utm.campaign`)
 *  6. Technical / View / Server Action Utility Buttons (`ir.actions.report`, `ir.actions.server`, `ir.cron`,
 *     `server.action.history.wizard`, `reset.view.arch.wizard`, `wizard.ir.model.menu.create`)
 *
 * All implementations follow Odoo 20 Community Python source in `odoo/addons/` and `odoo/odoo/addons/base/`.
 */
import { createHmac } from "node:crypto";
import { storeVersion } from "../bus/presence";
import { NotPorted, OdooError, UserError, ValidationError } from "../errors";
import { requestOfCursor } from "../http/context";
import { callKw, registerMethod } from "../http/methods";
import { sendMails } from "../mail/mail_queue";
import { emailNormalize, escapeText, insertMessages, partnerEmailFormatted, replyToDefault, trackingMessageId } from "../mail/message";
import { Store } from "../mail/store";
import { sendMailBatch } from "../mail/template_send";
import { trackAbortLevel, trackPrepare } from "../mail/tracking";
import { closeTrackingScope } from "../mail/write_hooks";
import { create } from "../orm/create";
import { and, cond, or, TRUE } from "../orm/domain";
import { userInfoOf } from "../orm/env";
import { registerHooks } from "../orm/hooks";
import { LazyTerm } from "../orm/lazy_term";
import { DbRec, NOT_ASSIGNED, NewRec, type Rec, registerDefaults, registerOnchange, registerRecordCompute } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { unlink } from "../orm/unlink";
import { registerOverrides, write } from "../orm/write";
import { recordWritten } from "../orm/written_fields";
import { literalEval } from "../pyexpr";
import { registerPyMethod } from "../qweb/records";
import { envFor } from "../web/common";
import { userHasGroup } from "../web/groups";
import { fetchRecords, forXmlId, isAdmin } from "./account_buttons";
import { changePassword, checkIdentity } from "./res_users_password";
import { configParam, defineComputes } from "./tail_util";
import { databaseSecret, dbNow, pyStrRepr, translate } from "./util";

// ----------------------------------------------------------------------------------------------------------------
// Shared Helpers
// ----------------------------------------------------------------------------------------------------------------

type ButtonFn = (env: Environment, ids: number[], args: unknown[], kwargs: Record<string, unknown>) => Promise<unknown>;

function button(model: string, method: string, fn: ButtonFn, opts?: { readonly readonly?: boolean }): void {
  registerMethod(model, method, async (env0, ids, args, kwargs0) => {
    const { env, kwargs } = envFor(env0, kwargs0);
    return fn(env, ids ?? [], args, kwargs);
  }, { apiModel: false, ...(opts?.readonly ? { readonly: true } : {}) });
}

function ensureOne(ids: readonly number[], model: string): number {
  if (ids.length !== 1) {
    throw new OdooError("builtins.ValueError", `Expected singleton: ${model}(${ids.join(", ")}${ids.length === 1 ? "," : ""})`);
  }
  return ids[0]!;
}

function m2oId(v: unknown): number | null {
  if (Array.isArray(v)) return typeof v[0] === "number" ? v[0] : null;
  return typeof v === "number" && v > 0 ? v : null;
}

function getRecordsAction(
  env: Environment,
  model: string,
  ids: readonly number[],
  kwargs: Record<string, unknown> = {},
): Record<string, unknown> {
  let lengthDependent: Record<string, unknown>;
  if (ids.length === 0) {
    lengthDependent = { views: [[false, "form"]] };
  } else if (ids.length === 1) {
    lengthDependent = { views: [[false, "form"]], res_id: ids[0]! };
  } else {
    lengthDependent = {
      views: [[false, "list"], [false, "form"]],
      domain: [["id", "in", [...ids]]],
    };
  }
  return {
    type: "ir.actions.act_window",
    res_model: model,
    target: "current",
    context: { ...env.context },
    ...lengthDependent,
    ...kwargs,
  };
}

function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return pyStrRepr(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (typeof v === "object") {
    return `{${Object.entries(v as Record<string, unknown>).map(([k, val]) => `${pyRepr(k)}: ${pyRepr(val)}`).join(", ")}}`;
  }
  return String(v);
}

function urlEncode(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k).replace(/%20/g, "+")}=${encodeURIComponent(v).replace(/%20/g, "+")}`)
    .join("&");
}

// ================================================================================================================
// 1. Portal Access Wizard (portal/wizard/portal_wizard.py)
// ================================================================================================================

async function portalWizardOpenModal(env: Environment, wizardId: number): Promise<Record<string, unknown>> {
  return {
    name: translate(env, "Portal Access Management", "portal"),
    type: "ir.actions.act_window",
    res_model: "portal.wizard",
    view_mode: "form",
    res_id: wizardId,
    target: "new",
  };
}

/** portal/wizard/portal_wizard.py:24-31 `_default_partner_ids`. */
registerDefaults("portal.wizard", {
  partner_ids: async (env) => {
    const raw = (Array.isArray(env.context["default_partner_ids"]) && (env.context["default_partner_ids"] as unknown[]).length
      ? env.context["default_partner_ids"]
      : env.context["active_ids"]) as unknown;
    const partnerIds = Array.isArray(raw) ? raw.filter((x): x is number => typeof x === "number" && x > 0) : [];
    if (!partnerIds.length) return [];
    const contactIds = new Set<number>();
    const existing = (await env.cr.query<{ id: number }>("SELECT id FROM res_partner WHERE id = ANY($1::int[])", [partnerIds])).rows;
    const existSet = new Set(existing.map((r) => r.id));
    for (const pid of partnerIds) {
      if (!existSet.has(pid)) continue;
      const children = (await env.cr.query<{ id: number }>(
        "SELECT id FROM res_partner WHERE parent_id = $1 AND active IS TRUE AND type IN ('contact', 'other') ORDER BY complete_name ASC, id DESC",
        [pid],
      )).rows;
      for (const c of children) contactIds.add(c.id);
      contactIds.add(pid);
    }
    return [...contactIds].sort((a, b) => a - b).map((id) => [4, id]);
  },
});

async function populatePortalWizardUsers(env: Environment, wizardId: number): Promise<void> {
  // Read partner_ids in res.partner._order (complete_name ASC, id DESC)
  const partners = (await env.cr.query<{ id: number; email: string | null }>(
    `SELECT p.id, p.email FROM portal_wizard_res_partner_rel r
       JOIN res_partner p ON p.id = r.res_partner_id
      WHERE r.portal_wizard_id = $1
      ORDER BY p.complete_name ASC, p.id DESC`,
    [wizardId],
  )).rows;
  if (!partners.length) return;
  await create(
    env.sudo(),
    "portal.wizard.user",
    partners.map((p) => ({ wizard_id: wizardId, partner_id: p.id, email: p.email ?? false })),
  );
}

/** portal/wizard/portal_wizard.py:37-46 `_compute_user_ids` (stored One2many compute: create.ts skips o2m computes). */
registerOverrides("portal.wizard", {
  create: async (env, valsList, next) => {
    const ids = await next(env, valsList);
    for (let i = 0; i < ids.length; i++) {
      if (!("user_ids" in valsList[i]!)) {
        await populatePortalWizardUsers(env, ids[i]!);
      }
    }
    return ids;
  },
  write: async (env, ids, vals, next) => {
    await next(env, ids, vals);
    if ("partner_ids" in vals && !("user_ids" in vals)) {
      for (const id of ids) {
        const existing = (await env.cr.query<{ id: number }>(
          "SELECT id FROM portal_wizard_user WHERE wizard_id = $1 ORDER BY id",
          [id],
        )).rows.map((r) => r.id);
        if (existing.length) await unlink(env.sudo(), "portal.wizard.user", existing);
        await populatePortalWizardUsers(env, id);
      }
    }
  },
});

registerRecordCompute("portal.wizard", {
  user_ids: async (env, rec) => {
    if (rec.id !== null) return NOT_ASSIGNED;
    const rels = await rec.rels("partner_ids");
    const partnerIds = rels.map((r) => r.origin ?? r.id).filter((id): id is number => typeof id === "number" && id > 0);
    if (!partnerIds.length) return [];
    const partners = (await env.cr.query<{ id: number; email: string | null }>(
      "SELECT id, email FROM res_partner WHERE id = ANY($1::int[]) ORDER BY complete_name ASC, id DESC",
      [partnerIds],
    )).rows;
    return partners.map((p) => [0, 0, { partner_id: p.id, email: p.email ?? false }]);
  },
});

/** portal/wizard/portal_wizard.py:48-60 `action_open_wizard`. */
registerMethod("portal.wizard", "action_open_wizard", async (env0, _ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const [wizId] = await create(env, "portal.wizard", [{}]);
  return portalWizardOpenModal(env, wizId!);
}, { apiModel: true });

async function portalUserForPartner(env: Environment, partnerId: number | null): Promise<{ id: number; active: boolean } | null> {
  if (!partnerId) return null;
  // res.users._order = 'name, login' (active_test=False, sudo)
  const row = (await env.cr.query<{ id: number; active: boolean | null }>(
    `SELECT u.id, u.active FROM res_users u JOIN res_partner p ON p.id = u.partner_id
      WHERE u.partner_id = $1 ORDER BY p.name, u.login, u.id LIMIT 1`,
    [partnerId],
  )).rows[0];
  return row ? { id: row.id, active: Boolean(row.active) } : null;
}

async function portalUserGroupFlags(env: Environment, user: { id: number; active: boolean } | null): Promise<{ isInternal: boolean; isPortal: boolean }> {
  if (!user) return { isInternal: false, isPortal: false };
  const [groupUser, groupPortal] = await Promise.all([
    env.reg.xmlid(env.cr, "base.group_user"),
    env.reg.xmlid(env.cr, "base.group_portal"),
  ]);
  const info = await userInfoOf(env.sudo(), user.id);
  const gset = new Set(info.groupIds);
  if (groupUser !== null && gset.has(groupUser)) return { isInternal: true, isPortal: false };
  if (user.active && groupPortal !== null && gset.has(groupPortal)) return { isInternal: false, isPortal: true };
  return { isInternal: false, isPortal: false };
}

async function computeEmailState(env: Environment, email: unknown, userId: number | null): Promise<"ok" | "ko" | "exist"> {
  const norm = typeof email === "string" ? emailNormalize(email) : false;
  if (!norm) return "ko";
  const rows = (await env.cr.query<{ id: number }>("SELECT id FROM res_users WHERE login = $1", [norm])).rows;
  for (const r of rows) {
    if (r.id !== userId) return "exist";
  }
  return "ok";
}

defineComputes("portal.wizard.user", {
  user_id: async (env, rec) => {
    const pid = m2oId(await rec.get("partner_id"));
    const u = await portalUserForPartner(env, pid);
    return u ? u.id : false;
  },
  is_internal: async (env, rec) => {
    const pid = m2oId(await rec.get("partner_id"));
    const u = await portalUserForPartner(env, pid);
    return (await portalUserGroupFlags(env, u)).isInternal;
  },
  is_portal: async (env, rec) => {
    const pid = m2oId(await rec.get("partner_id"));
    const u = await portalUserForPartner(env, pid);
    return (await portalUserGroupFlags(env, u)).isPortal;
  },
  email_state: async (env, rec) => {
    const email = await rec.get("email");
    const pid = m2oId(await rec.get("partner_id"));
    const u = await portalUserForPartner(env, pid);
    return computeEmailState(env, email, u ? u.id : null);
  },
});

/** auth_signup/models/res_partner.py:165-193 `_generate_signup_token` and :29-88 `_get_signup_url`. */
async function generatePartnerSignupToken(env: Environment, partnerId: number, signupType: string): Promise<string> {
  const paramKey = signupType === "reset" ? "auth_signup.reset_password.validity.hours" : "auth_signup.signup.validity.hours";
  const defaultHours = signupType === "reset" ? 4 : 144;
  const rawHours = await configParam(env.sudo(), paramKey);
  const h = rawHours && /^\s*\d+\s*$/.test(rawHours) ? Number(rawHours.trim()) : 0;
  const expiration = Math.floor(Date.now() / 1000 + (h || defaultHours) * 3600);
  // active users of the partner in res.users order
  const userRows = (await env.cr.query<{ id: number; login_date: string | null }>(
    `SELECT u.id, (SELECT max(l.create_date)::text FROM res_users_log l WHERE l.create_uid = u.id) AS login_date
       FROM res_users u JOIN res_partner p ON p.id = u.partner_id
      WHERE u.partner_id = $1 AND u.active IS TRUE
      ORDER BY p.name, u.login, u.id`,
    [partnerId],
  )).rows;
  const userIds = userRows.map((u) => u.id);
  const timestamps = userRows
    .map((u) => (u.login_date ? Math.floor(new Date(u.login_date.replace(" ", "T") + "Z").getTime() / 1000) : null))
    .filter((t): t is number => t !== null && Number.isFinite(t));
  const loginTs = timestamps.length ? Math.max(...timestamps) : null;
  const message = `[${partnerId}, [${userIds.join(", ")}], ${loginTs === null ? "null" : loginTs}, ${JSON.stringify(signupType)}]`;
  const secret = await databaseSecret(env);
  const digest = createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(Buffer.from(pyRepr(["signup", `1:${message}:${expiration}`]), "utf8"))
    .digest();
  const exp = Buffer.alloc(8);
  exp.writeBigUInt64LE(BigInt(expiration));
  return Buffer.concat([Buffer.from([1]), exp, digest, Buffer.from(message, "utf8")]).toString("base64url");
}

registerPyMethod("res.partner", "_get_signup_url", async (recs) => partnerSignupUrl(recs.env, recs.ensureOne()));

/** auth_signup res_partner.py:29-88 `_get_signup_url` of one partner (the write access check passes for an admin). */
export async function partnerSignupUrl(env: Environment, pid: number): Promise<string | false> {
  const baseUrl = (await configParam(env.sudo(), "web.base.url")) ?? "";
  const partnerRow = (await env.cr.query<{ email: string | null; signup_type: string | null }>(
    "SELECT email, signup_type FROM res_partner WHERE id = $1",
    [pid],
  )).rows[0];
  if (!partnerRow) return false;
  const dbName = String(env.context["dbname"] || env.cr.db || "");
  const query: Record<string, string> = { db: dbName };
  if (env.context["create_user"]) query["signup_email"] = partnerRow.email ?? "";
  const signupType = String(env.context["signup_force_type_in_url"] || partnerRow.signup_type || "");
  let route = "login";
  if (signupType) {
    route = signupType === "reset" ? "reset_password" : signupType;
    query["token"] = await generatePartnerSignupToken(env, pid, signupType);
  }
  const rel = `/web/${route}?${urlEncode(query)}`;
  if (env.context["relative_url"]) return rel;
  return baseUrl.replace(/\/+$/, "") + rel;
}

async function portalLoadWizardUser(env: Environment, id: number): Promise<{
  id: number; wizardId: number; partnerId: number; partnerName: string; partnerEmail: string | null;
  partnerCompanyId: number | null; email: string | null; welcomeMessage: string | null;
  user: { id: number; active: boolean } | null; isInternal: boolean; isPortal: boolean; emailState: "ok" | "ko" | "exist";
}> {
  const row = (await env.cr.query<{
    id: number; wizard_id: number; partner_id: number; email: string | null;
    p_name: string | null; p_email: string | null; p_company_id: number | null; welcome_message: string | null;
  }>(
    `SELECT u.id, u.wizard_id, u.partner_id, u.email, p.name AS p_name, p.email AS p_email,
            p.company_id AS p_company_id, w.welcome_message
       FROM portal_wizard_user u
       JOIN portal_wizard w ON w.id = u.wizard_id
       JOIN res_partner p ON p.id = u.partner_id
      WHERE u.id = $1`,
    [id],
  )).rows[0];
  if (!row) throw new NotPorted(`portal.wizard.user(${id}) missing`);
  const user = await portalUserForPartner(env, row.partner_id);
  const { isInternal, isPortal } = await portalUserGroupFlags(env, user);
  const emailState = await computeEmailState(env, row.email, user ? user.id : null);
  return {
    id: row.id, wizardId: row.wizard_id, partnerId: row.partner_id,
    partnerName: row.p_name ?? "", partnerEmail: row.p_email, partnerCompanyId: row.p_company_id,
    email: row.email, welcomeMessage: row.welcome_message,
    user, isInternal, isPortal, emailState,
  };
}

function assertPortalEmailUniqueness(env: Environment, wu: { partnerName: string; emailState: "ok" | "ko" | "exist" }): void {
  if (wu.emailState === "ko") {
    throw new UserError(translate(env, 'The contact "%s" does not have a valid email.', "portal").replace("%s", wu.partnerName));
  }
  if (wu.emailState === "exist") {
    throw new UserError(translate(env, 'The contact "%s" has the same email as an existing user', "portal").replace("%s", wu.partnerName));
  }
}

async function updatePortalPartnerEmail(env: Environment, wu: { partnerId: number; partnerEmail: string | null; email: string | null; emailState: "ok" | "ko" | "exist" }): Promise<void> {
  const norm = wu.email ? emailNormalize(wu.email) : false;
  const curNorm = wu.partnerEmail ? emailNormalize(wu.partnerEmail) : false;
  if (wu.emailState === "ok" && norm && curNorm !== norm) {
    await write(env, "res.partner", [wu.partnerId], { email: norm });
  }
}

async function postPortalAccessTracking(
  env: Environment,
  userId: number,
  partnerId: number,
  companyId: number,
  parentMessageId: number | false,
): Promise<void> {
  const selfPartner = (await env.cr.query<{ partner_id: number }>("SELECT partner_id FROM res_users WHERE id = $1", [env.uid])).rows[0]!.partner_id;
  const emailFrom = (await partnerEmailFormatted(env, selfPartner)) || "";
  const mtNote = await env.reg.xmlid(env.cr, "mail.mt_note");
  const pEmail = (await env.cr.query<{ email: string | null }>("SELECT email FROM res_partner WHERE id = $1", [partnerId])).rows[0]?.email;
  const baseBody = translate(env, "Portal Access Granted", "mail");
  const text = pEmail ? `${baseBody} (${pEmail})` : baseBody;
  await insertMessages(env, [{
    model: "res.users",
    res_id: userId,
    body: `<p>${escapeText(text)}</p>`,
    author_id: selfPartner,
    email_from: emailFrom,
    message_type: "tracking",
    subtype_id: mtNote ?? false,
    parent_id: parentMessageId,
    is_internal: null,
    email_add_signature: true,
    reply_to: await replyToDefault(env, emailFrom),
    message_id: trackingMessageId(`${userId}-res.users`),
    record_alias_domain_id: false,
    record_company_id: companyId,
  }]);
}

/** portal_wizard.py:208-218 `_create_user` -> auth_signup `_create_user_from_template`. */
async function createPortalUserFromTemplate(
  env: Environment,
  partnerId: number,
  emailNorm: string,
  companyId: number,
): Promise<number> {
  const rawTpl = await configParam(env.sudo(), "base.template_portal_user_id");
  const tplId = rawTpl && /^\s*\d+\s*$/.test(rawTpl) ? Number(rawTpl.trim()) : 0;
  const tpl = tplId
    ? (await env.cr.query<{
        id: number; notification_type: string | null; odoobot_state: string | null; signature: string | null;
        action_id: number | null;
      }>("SELECT id, notification_type, odoobot_state, signature, action_id FROM res_users WHERE id = $1", [tplId])).rows[0]
    : undefined;
  if (!tpl) throw new OdooError("builtins.ValueError", translate(env, "Signup: invalid template user", "auth_signup"));
  const tplGroups = (await env.cr.query<{ gid: number }>("SELECT gid FROM res_groups_users_rel WHERE uid = $1 ORDER BY gid", [tplId])).rows.map((r) => r.gid);
  const newUid = (await env.cr.query<{ id: number }>(
    `INSERT INTO res_users (active, login, company_id, partner_id, share, notification_type, odoobot_state, odoobot_failed, tour_enabled, signature, action_id, create_uid, write_uid, create_date, write_date)
     VALUES (TRUE, $1, $2, $3, TRUE, $4, $5, FALSE, FALSE, $6, $7, $8, $8, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')
     RETURNING id`,
    [emailNorm, companyId, partnerId, tpl.notification_type ?? "email", tpl.odoobot_state, tpl.signature ?? "", tpl.action_id, env.uid],
  )).rows[0]!.id;
  await env.cr.query("INSERT INTO res_company_users_rel (cid, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [companyId, newUid]);
  for (const gid of tplGroups) {
    await env.cr.query("INSERT INTO res_groups_users_rel (gid, uid) VALUES ($1, $2) ON CONFLICT DO NOTHING", [gid, newUid]);
  }
  await env.cr.query("UPDATE res_partner SET partner_share = TRUE WHERE id = $1 AND partner_share IS DISTINCT FROM TRUE", [partnerId]);
  // mail.thread create: auto-follow creator + "<p>User created</p>" notification message
  const selfPartner = (await env.cr.query<{ partner_id: number }>("SELECT partner_id FROM res_users WHERE id = $1", [env.uid])).rows[0]!.partner_id;
  const fid = (await env.cr.query<{ id: number }>(
    `INSERT INTO mail_followers (res_model, res_id, partner_id, create_uid, write_uid, create_date, write_date)
     VALUES ('res.users', $1, $2, $3, $3, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC') RETURNING id`,
    [newUid, selfPartner, env.uid],
  )).rows[0]!.id;
  const mtComment = await env.reg.xmlid(env.cr, "mail.mt_comment");
  if (mtComment !== null) {
    await env.cr.query("INSERT INTO mail_followers_mail_message_subtype_rel (mail_followers_id, mail_message_subtype_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [fid, mtComment]);
  }
  let createMsgId: number | false = false;
  if (!env.context["mail_create_nolog"]) {
    const emailFrom = (await partnerEmailFormatted(env, selfPartner)) || "";
    const mtNote = await env.reg.xmlid(env.cr, "mail.mt_note");
    const [mid] = await insertMessages(env, [{
      model: "res.users",
      res_id: newUid,
      body: `<p>${escapeText(translate(env, "User created", "mail"))}</p>`,
      author_id: selfPartner,
      email_from: emailFrom,
      message_type: "notification",
      subtype_id: mtNote ?? false,
      is_internal: true,
      email_add_signature: false,
      reply_to: await replyToDefault(env, emailFrom),
      message_id: trackingMessageId(`${newUid}-res.users`),
      record_alias_domain_id: false,
      record_company_id: false,
    }]);
    createMsgId = mid ?? false;
  }
  // mail/models/res_users.py:198-206: log portal access granted tracking message on the newly created portal user
  if (!env.context["mail_create_nolog"] && !env.context["mail_notrack"]) {
    const groupPortal = await env.reg.xmlid(env.cr, "base.group_portal");
    if (groupPortal !== null && tplGroups.includes(groupPortal)) {
      await postPortalAccessTracking(env, newUid, partnerId, companyId, createMsgId);
    }
  }
  return newUid;
}

/** portal_wizard.py:220-243 `_send_email`. */
async function sendPortalInviteEmail(env: Environment, userId: number, partnerId: number, welcomeMessage: string | null): Promise<void> {
  const templateId = await env.reg.xmlid(env.cr, "auth_signup.portal_set_password_email");
  if (templateId === null) {
    throw new UserError(translate(env, 'The template "Portal: new user" not found for sending email to the portal user.', "portal"));
  }
  const uRow = (await env.cr.query<{ name: string | null; lang: string | null }>(
    "SELECT p.name, p.lang FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1",
    [userId],
  )).rows[0];
  await write(env.sudo(), "res.partner", [partnerId], { signup_type: "signup" });
  const mailEnv = env.withContext({
    ...env.context,
    active_test: true,
    dbname: env.cr.db,
    email_notification_force_header: true,
    email_notification_force_footer: true,
    email_notification_subtitles: [new LazyTerm("Your Account", "portal"), uRow?.name || ""],
    email_notification_subtitles_highlight_index: 1,
    lang: uRow?.lang || env.lang || "en_US",
    medium: "portalinvite",
    welcome_message: welcomeMessage || false,
  });
  const mailIds = await sendMailBatch(mailEnv, templateId, [userId], {
    forceSend: false,
    emailLayoutXmlid: "mail.mail_notification_layout",
  });
  const reqCtx = requestOfCursor(env.cr);
  if (mailIds.length && reqCtx) {
    await sendMails(env.sudo(), reqCtx.env, mailIds);
  }
}

button("portal.wizard.user", "action_grant_access", async (env, ids) => {
  const id = ensureOne(ids, "portal.wizard.user");
  const wu = await portalLoadWizardUser(env, id);
  assertPortalEmailUniqueness(env, wu);
  if (wu.isPortal || wu.isInternal) {
    throw new UserError(translate(env, 'The partner "%s" already has the portal access.', "portal").replace("%s", wu.partnerName));
  }
  const groupPortal = await env.reg.xmlid(env.cr, "base.group_portal");
  const groupPublic = await env.reg.xmlid(env.cr, "base.group_public");
  if (groupPortal === null || groupPublic === null) throw new NotPorted("base.group_portal or base.group_public missing");

  await updatePortalPartnerEmail(env, wu);
  const emailNorm = emailNormalize(wu.email ?? "") || "";
  let userId = wu.user?.id ?? null;
  if (userId === null) {
    const companyId = wu.partnerCompanyId ?? await env.company();
    userId = await createPortalUserFromTemplate(env, wu.partnerId, emailNorm, companyId);
  }
  // portal_wizard.py:160 user_sudo.write({'active': True, 'group_ids': [(4, group_portal.id), (3, group_public.id)]})
  // Unarchive partner first if needed (base res_users.py:688-690)
  const pActive = (await env.cr.query<{ active: boolean | null }>("SELECT active FROM res_partner WHERE id = $1", [wu.partnerId])).rows[0]?.active;
  if (!pActive) await write(env.sudo(), "res.partner", [wu.partnerId], { active: true });
  const beforeGroups = new Set((await env.cr.query<{ gid: number }>("SELECT gid FROM res_groups_users_rel WHERE uid = $1", [userId])).rows.map((r) => r.gid));
  const wasPortal = beforeGroups.has(groupPortal);
  const hadPublic = beforeGroups.has(groupPublic);
  await env.cr.query("UPDATE res_users SET active = TRUE, write_uid = $2, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1", [userId, env.uid]);
  if (!wasPortal) {
    await env.cr.query("INSERT INTO res_groups_users_rel (gid, uid) VALUES ($1, $2) ON CONFLICT DO NOTHING", [groupPortal, userId]);
  }
  if (hadPublic) {
    await env.cr.query("DELETE FROM res_groups_users_rel WHERE gid = $1 AND uid = $2", [groupPublic, userId]);
  }
  if (!wasPortal && !env.context["mail_create_nolog"] && !env.context["mail_notrack"]) {
    const uCompany = (await env.cr.query<{ company_id: number }>("SELECT company_id FROM res_users WHERE id = $1", [userId])).rows[0]?.company_id ?? await env.company();
    const firstMsg = (await env.cr.query<{ id: number }>(
      "SELECT id FROM mail_message WHERE model = 'res.users' AND res_id = $1 ORDER BY id ASC LIMIT 1",
      [userId],
    )).rows[0]?.id ?? false;
    await postPortalAccessTracking(env, userId, wu.partnerId, uCompany, firstMsg);
  }
  // signup_prepare + _send_email
  await write(env.sudo(), "res.partner", [wu.partnerId], { signup_type: "signup" });
  await sendPortalInviteEmail(env, userId, wu.partnerId, wu.welcomeMessage);
  return portalWizardOpenModal(env, wu.wizardId);
});

button("portal.wizard.user", "action_revoke_access", async (env, ids) => {
  const id = ensureOne(ids, "portal.wizard.user");
  const wu = await portalLoadWizardUser(env, id);
  if (!wu.isPortal) {
    throw new UserError(translate(env, 'The partner "%s" has no portal access or is internal.', "portal").replace("%s", wu.partnerName));
  }
  await updatePortalPartnerEmail(env, wu);
  await write(env.sudo(), "res.partner", [wu.partnerId], { signup_type: false });
  if (wu.user) {
    await write(env.sudo(), "res.users", [wu.user.id], { active: false });
  }
  return portalWizardOpenModal(env, wu.wizardId);
});

button("portal.wizard.user", "action_invite_again", async (env, ids) => {
  const id = ensureOne(ids, "portal.wizard.user");
  const wu = await portalLoadWizardUser(env, id);
  assertPortalEmailUniqueness(env, wu);
  if (!wu.isPortal) {
    throw new UserError(translate(env, 'You should first grant the portal access to the partner "%s".', "portal").replace("%s", wu.partnerName));
  }
  await updatePortalPartnerEmail(env, wu);
  await sendPortalInviteEmail(env, wu.user!.id, wu.partnerId, wu.welcomeMessage);
  return portalWizardOpenModal(env, wu.wizardId);
});

button("portal.wizard.user", "action_refresh_modal", async (env, ids) => {
  const id = ensureOne(ids, "portal.wizard.user");
  const [row] = await fetchRecords(env, "portal.wizard.user", [id], ["wizard_id"]);
  return portalWizardOpenModal(env, m2oId(row!["wizard_id"])!);
});

// ================================================================================================================
// 2. Partner Merge Wizard (base/wizard/base_partner_merge.py + mail + account)
// ================================================================================================================

/** base_partner_merge.py:583-591 `_get_ordered_partner`: sorted by `(not active, create_date or 1970-01-01)` desc. */
async function getOrderedPartners(env: Environment, partnerIds: readonly number[]): Promise<number[]> {
  if (!partnerIds.length) return [];
  const rows = (await env.cr.query<{ id: number; active: boolean | null; create_date: string | null }>(
    "SELECT id, active, create_date::text FROM res_partner WHERE id = ANY($1::int[])",
    [[...partnerIds]],
  )).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Keep only existing, in original browse order, then stable sort descending by (not active, create_date)
  const items = partnerIds
    .filter((id) => byId.has(id))
    .map((id, idx) => {
      const r = byId.get(id)!;
      const inactive = r.active ? 0 : 1;
      const dt = r.create_date ?? "1970-01-01 00:00:00";
      return { id, inactive, dt, idx };
    });
  items.sort((a, b) => {
    if (b.inactive !== a.inactive) return b.inactive - a.inactive;
    if (b.dt !== a.dt) return b.dt < a.dt ? -1 : 1;
    return a.idx - b.idx; // Python sort is stable
  });
  return items.map((x) => x.id);
}

registerOverrides("base.partner.merge.automatic.wizard", {
  defaultGet: async (env, fields, values) => {
    const activeIds = env.context["active_ids"];
    if (env.context["active_model"] === "res.partner" && Array.isArray(activeIds) && activeIds.length) {
      const ids = activeIds.filter((x): x is number => typeof x === "number" && x > 0);
      if (ids.length) {
        if (fields.includes("state")) values["state"] = "selection";
        if (fields.includes("partner_ids")) values["partner_ids"] = [[6, 0, ids]];
        if (fields.includes("dst_partner_id")) {
          const ordered = await getOrderedPartners(env, ids);
          if (ordered.length) values["dst_partner_id"] = ordered[ordered.length - 1]!;
        }
      }
    }
  },
});

async function getFkOn(env: Environment, table: string): Promise<{ table: string; column: string }[]> {
  return (await env.cr.query<{ table: string; column: string }>(
    `SELECT cl1.relname AS table, att1.attname AS column
       FROM pg_constraint AS con, pg_class AS cl1, pg_class AS cl2, pg_attribute AS att1, pg_attribute AS att2
      WHERE con.conrelid = cl1.oid
        AND con.confrelid = cl2.oid
        AND array_lower(con.conkey, 1) = 1
        AND con.conkey[1] = att1.attnum
        AND att1.attrelid = cl1.oid
        AND cl2.relname = $1
        AND cl2.relnamespace = current_schema::regnamespace
        AND att2.attname = 'id'
        AND array_lower(con.confkey, 1) = 1
        AND con.confkey[1] = att2.attnum
        AND att2.attrelid = cl2.oid
        AND con.contype = 'f'`,
    [table],
  )).rows;
}

async function hasCheckOrUniqueConstraint(env: Environment, table: string, column: string): Promise<boolean> {
  const r = await env.cr.query(
    `SELECT 1
       FROM pg_constraint c
       JOIN pg_class r ON (c.conrelid = r.oid)
       CROSS JOIN LATERAL unnest(c.conkey) AS cattr(attnum)
       JOIN pg_attribute a ON (a.attrelid = c.conrelid AND a.attnum = cattr.attnum)
      WHERE c.contype IN ('c', 'u')
        AND r.relname = $1
        AND r.relnamespace = current_schema::regnamespace
        AND a.attname = $2
      LIMIT 1`,
    [table, column],
  );
  return r.rows.length > 0;
}

async function tableColumns(env: Environment, table: string): Promise<string[]> {
  return (await env.cr.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [table],
  )).rows.map((r) => r.column_name);
}

async function withSavepoint(env: Environment, fn: () => Promise<void>): Promise<void> {
  const sp = `sp_merge_${Math.random().toString(36).slice(2, 10)}`;
  await env.cr.query(`SAVEPOINT ${sp}`);
  try {
    await fn();
    await env.cr.query(`RELEASE SAVEPOINT ${sp}`);
  } catch (e) {
    await env.cr.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    await env.cr.query(`RELEASE SAVEPOINT ${sp}`);
    throw e;
  }
}

/** base_partner_merge.py:118-196 `_update_foreign_keys_generic`. */
async function updateForeignKeysGeneric(env: Environment, model: string, srcIds: readonly number[], dstId: number): Promise<void> {
  if (!srcIds.length) return;
  const tableName = env.reg.model(model).table;
  const relations = await getFkOn(env, tableName);
  for (const { table, column } of relations) {
    if (table.includes("base_partner_merge_")) continue;
    const cols = (await tableColumns(env, table)).filter((c) => c !== column);
    const hasRows = (await env.cr.query(`SELECT 1 FROM "${table}" WHERE "${column}" = ANY($1::int[]) LIMIT 1`, [[...srcIds]])).rows.length > 0;
    if (!hasRows) continue;
    if (cols.length <= 1 && cols.length === 1) {
      const valCol = cols[0]!;
      await env.cr.query(
        `UPDATE "${table}" AS ___tu
            SET "${column}" = $1
          WHERE "${column}" = ANY($2::int[])
            AND NOT EXISTS (
              SELECT 1 FROM "${table}" AS ___tw
               WHERE "${column}" = $1 AND ___tu."${valCol}" = ___tw."${valCol}"
            )`,
        [dstId, [...srcIds]],
      );
    } else if (!(await hasCheckOrUniqueConstraint(env, table, column))) {
      await env.cr.query(`UPDATE "${table}" SET "${column}" = $1 WHERE "${column}" = ANY($2::int[])`, [dstId, [...srcIds]]);
    } else {
      try {
        await withSavepoint(env, async () => {
          await env.cr.query(`UPDATE "${table}" SET "${column}" = $1 WHERE "${column}" = ANY($2::int[])`, [dstId, [...srcIds]]);
        });
      } catch {
        await env.cr.query(`DELETE FROM "${table}" WHERE "${column}" = ANY($1::int[])`, [[...srcIds]]);
      }
    }
  }
}

/** base_partner_merge.py:197-332 `_update_reference_fields_generic`. */
async function updateReferenceFieldsGeneric(env: Environment, referencedModel: string, srcIds: readonly number[], dstId: number): Promise<void> {
  if (!srcIds.length) return;
  const updateRecords = async (model: string, srcId: number, fieldModel = "model", fieldId = "res_id"): Promise<void> => {
    if (!env.reg.models.has(model)) return;
    const def = env.reg.model(model);
    const ids = await env.sudo().model(model).search(and([cond(fieldModel, "=", referencedModel), cond(fieldId, "=", srcId)]));
    if (!ids.length) return;
    if (!(await hasCheckOrUniqueConstraint(env, def.table, fieldId))) {
      await write(env.sudo(), model, ids, { [fieldId]: dstId });
      return;
    }
    try {
      await withSavepoint(env, async () => {
        await write(env.sudo(), model, ids, { [fieldId]: dstId });
      });
    } catch {
      await unlink(env.sudo(), model, ids);
    }
  };
  for (const srcId of srcIds) {
    await updateRecords("ir.attachment", srcId, "res_model");
    await updateRecords("mail.followers", srcId, "res_model");
    await updateRecords("mail.activity", srcId, "res_model");
    await updateRecords("mail.message", srcId);
    await updateRecords("ir.model.data", srcId);
  }
  // Stored non-computed reference fields
  const refFields = (await env.cr.query<{ model: string; name: string }>(
    "SELECT model, name FROM ir_model_fields WHERE ttype = 'reference' AND store IS TRUE",
  )).rows;
  for (const rf of refFields) {
    if (!env.reg.models.has(rf.model)) continue;
    const def = env.reg.model(rf.model);
    const field = def.fields.get(rf.name);
    if (!field || def.abstract || field.compute) continue;
    for (const srcId of srcIds) {
      const refVal = `${referencedModel},${srcId}`;
      const matchIds = await env.sudo().model(rf.model).search(cond(rf.name, "=", refVal));
      if (matchIds.length) {
        await write(env.sudo(), rf.model, matchIds, { [rf.name]: `${referencedModel},${dstId}` });
      }
    }
  }
  // Company-dependent many2one fields referring to referencedModel
  await withoutWriteWatch(env, async () => {
    for (const [, def] of env.reg.models) {
      if (def.abstract || def.transient || !def.table) continue;
      for (const [fname, field] of def.fields) {
        if (field.companyDependent && field.type === "many2one" && field.relation === referencedModel && field.column) {
          await env.cr.query(
            `UPDATE "${def.table}"
                SET "${fname}" = (
                  SELECT jsonb_object_agg(key,
                    CASE WHEN value::int = ANY($1::int[]) THEN $2 ELSE value::int END)
                    FROM jsonb_each_text("${fname}")
                )
              WHERE "${fname}" IS NOT NULL`,
            [[...srcIds], dstId],
          );
        }
      }
    }
    // ir_default fallbacks for company-dependent many2one fields
    await env.cr.query(
      `UPDATE ir_default
          SET json_value = CASE WHEN json_value::int = ANY($1::int[]) THEN $2 ELSE json_value END
         FROM ir_model_fields f
        WHERE f.id = ir_default.field_id
          AND f.company_dependent
          AND f.relation = $3
          AND f.ttype = 'many2one'
          AND json_value ~ '^[0-9]+$'`,
      [[...srcIds], String(dstId), referencedModel],
    );
    // Company-dependent fields of merged records themselves
    const dstDef = env.reg.model(referencedModel);
    for (const [fname, field] of dstDef.fields) {
      if (!field.companyDependent || !field.column) continue;
      await env.cr.query(
        `WITH source AS (
           SELECT "${fname}" FROM "${dstDef.table}" WHERE id = ANY($1::int[]) ORDER BY id
         ), source_agg AS (
           SELECT jsonb_object_agg(key, value) AS value FROM source, jsonb_each("${fname}")
         )
         UPDATE "${dstDef.table}"
            SET "${fname}" = source_agg.value || COALESCE("${dstDef.table}"."${fname}", '{}'::jsonb)
           FROM source_agg
          WHERE id = $2 AND source_agg.value IS NOT NULL`,
        [[...srcIds], dstId],
      );
    }
  });
}

/** base_partner_merge.py:427-443 `_merge_bank_accounts`. */
async function mergeBankAccounts(env: Environment, srcIds: readonly number[], dstId: number): Promise<void> {
  if (!srcIds.length) return;
  const srcBanks = (await env.cr.query<{ id: number; sanitized_account_number: string | null }>(
    "SELECT id, sanitized_account_number FROM res_partner_bank WHERE partner_id = ANY($1::int[]) ORDER BY sequence, id",
    [[...srcIds]],
  )).rows;
  if (!srcBanks.length) return;
  const dstBanks = (await env.cr.query<{ id: number; sanitized_account_number: string | null }>(
    "SELECT id, sanitized_account_number FROM res_partner_bank WHERE partner_id = $1 ORDER BY sequence, id",
    [dstId],
  )).rows;
  for (const sb of srcBanks) {
    const dup = dstBanks.find((db) => db.sanitized_account_number === sb.sanitized_account_number);
    if (dup) {
      await updateForeignKeysGeneric(env, "res.partner.bank", [sb.id], dup.id);
      await updateReferenceFieldsGeneric(env, "res.partner.bank", [sb.id], dup.id);
      await unlink(env.sudo(), "res.partner.bank", [sb.id]);
    } else {
      await write(env.sudo(), "res.partner.bank", [sb.id], { partner_id: dstId });
      dstBanks.push(sb);
    }
  }
}

/** base_partner_merge.py:356-426 `_merge_values` + `_update_values` (with account's summable_fields). */
async function updateMergedPartnerValues(env: Environment, srcIds: readonly number[], dstId: number): Promise<void> {
  const def = env.reg.model("res.partner");
  const summable = new Set<string>(
    def.fields.has("customer_rank") ? ["customer_rank", "supplier_rank"] : [],
  );
  const readableFields: string[] = [];
  for (const [fname, field] of def.fields) {
    if (!field.copy || !field.store || field.compute || field.related || field.companyDependent) continue;
    if (field.type === "many2many" || field.type === "one2many" || field.type === "binary" || field.type === "image") continue;
    readableFields.push(fname);
  }
  const allIds = [...srcIds, dstId];
  const rows = await env.model("res.partner").read(allIds, readableFields, "");
  const byId = new Map(rows.map((r) => [Number(r["id"]), r]));
  const dstRow = byId.get(dstId) ?? {};
  const values: Record<string, unknown> = {};
  for (const col of readableFields) {
    const field = def.fields.get(col)!;
    for (const pid of allIds) {
      const row = byId.get(pid);
      if (!row) continue;
      const raw = row[col];
      if (raw !== false && raw !== null && raw !== undefined && raw !== "" && raw !== 0) {
        const serialized = field.type === "many2one" ? (m2oId(raw) ?? false) : raw;
        if (field.type === "reference") {
          values[col] = raw;
        } else if (summable.has(col) && typeof values[col] === "number" && typeof serialized === "number") {
          values[col] = (values[col] as number) + serialized;
        } else {
          values[col] = serialized;
        }
      }
    }
  }
  delete values["id"];
  const parentId = m2oId(values["parent_id"]);
  delete values["parent_id"];
  // Keep only fields whose value differs from dst_partner's current value (matches Field.write _filter_not_equal)
  const diffValues: Record<string, unknown> = {};
  for (const [col, val] of Object.entries(values)) {
    const field = def.fields.get(col)!;
    const curRaw = dstRow[col];
    const cur = field.type === "many2one" ? (m2oId(curRaw) ?? false) : curRaw;
    if (JSON.stringify(val) !== JSON.stringify(cur)) diffValues[col] = val;
  }
  if (Object.keys(diffValues).length) {
    await write(env, "res.partner", [dstId], diffValues);
  }
  const curParentId = m2oId(dstRow["parent_id"]);
  if (parentId && parentId !== dstId && parentId !== curParentId) {
    try {
      await write(env, "res.partner", [dstId], { parent_id: parentId });
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
    }
  }
}

/** Suspend Cursor.writeWatch while running raw SQL UPDATEs (matches Odoo's cr.execute bypassing Base._flush). */
async function withoutWriteWatch<T>(env: Environment, fn: () => Promise<T>): Promise<T> {
  const prev = env.cr.writeWatch;
  env.cr.writeWatch = null;
  try {
    return await fn();
  } finally {
    env.cr.writeWatch = prev;
  }
}

/** base_partner_merge.py:444-508 `_merge` + mail `_log_merge_operation`. */
async function mergePartners(env: Environment, rawPartnerIds: readonly number[], dstPartnerId: number | null, extraChecks0 = true): Promise<void> {
  const extraChecks = (await isAdmin(env)) ? false : extraChecks0;
  // Deduplicate and keep only existing partners in order
  const uniqueIds = [...new Set(rawPartnerIds)];
  if (!uniqueIds.length) return;
  const existingRows = (await env.cr.query<{ id: number; name: string | null; email: string | null; company_id: number | null }>(
    "SELECT id, name, email, company_id FROM res_partner WHERE id = ANY($1::int[])",
    [uniqueIds],
  )).rows;
  const byId = new Map(existingRows.map((r) => [r.id, r]));
  const partnerIds = uniqueIds.filter((id) => byId.has(id));
  if (partnerIds.length < 2) return;
  if (partnerIds.length > 3) {
    throw new UserError(translate(env, "For safety reasons, you cannot merge more than 3 contacts together. You can re-open the wizard several times if needed.", "base"));
  }
  // Check parent/child hierarchy via recursive CTE on res_partner.parent_id
  const descendants = (await env.cr.query<{ id: number }>(
    `WITH RECURSIVE tree AS (
       SELECT id, id AS root_id FROM res_partner WHERE id = ANY($1::int[])
       UNION ALL
       SELECT p.id, t.root_id FROM res_partner p JOIN tree t ON p.parent_id = t.id
     )
     SELECT id FROM tree WHERE id != root_id`,
    [partnerIds],
  )).rows;
  const idSet = new Set(partnerIds);
  if (descendants.some((d) => idSet.has(d.id))) {
    throw new UserError(translate(env, "You cannot merge a contact with one of his parent.", "base"));
  }
  // Check linked users (active_test=False)
  const linkedUsers = (await env.cr.query<{ id: number; partner_id: number }>(
    "SELECT id, partner_id FROM res_users WHERE partner_id = ANY($1::int[])",
    [partnerIds],
  )).rows;
  if (linkedUsers.length > 1) {
    throw new UserError(translate(env, "You cannot merge contacts linked to more than one user even if only one is active.", "base"));
  }
  if (extraChecks) {
    const emails = new Set(partnerIds.map((pid) => byId.get(pid)!.email ?? false));
    if (emails.size > 1) {
      throw new UserError(translate(env, "All contacts must have the same email. Only the Administrator can merge contacts with different emails.", "base"));
    }
  }
  let dstId: number;
  let srcIds: number[];
  if (dstPartnerId && idSet.has(dstPartnerId)) {
    dstId = dstPartnerId;
    srcIds = partnerIds.filter((id) => id !== dstId);
  } else {
    const ordered = await getOrderedPartners(env, partnerIds);
    dstId = ordered[ordered.length - 1]!;
    srcIds = ordered.slice(0, -1);
  }
  const dstRow = byId.get(dstId)!;
  if (dstRow.company_id && linkedUsers.length) {
    const activeUserIds = (await env.cr.query<{ id: number }>(
      "SELECT id FROM res_users WHERE partner_id = ANY($1::int[]) AND active IS TRUE",
      [partnerIds],
    )).rows.map((r) => r.id);
    if (activeUserIds.length) {
      await withoutWriteWatch(env, async () => {
        for (const uid of activeUserIds) {
          await env.cr.query("INSERT INTO res_company_users_rel (cid, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [dstRow.company_id, uid]);
          await env.cr.query("UPDATE res_users SET company_id = $1, write_uid = $2, write_date = now() AT TIME ZONE 'UTC' WHERE id = $3", [dstRow.company_id, env.uid, uid]);
        }
      });
    }
  }
  await mergeBankAccounts(env, srcIds, dstId);
  await withoutWriteWatch(env, () => updateForeignKeysGeneric(env, "res.partner", srcIds, dstId));
  await updateReferenceFieldsGeneric(env, "res.partner", srcIds, dstId);

  // Hold res.partner tracking scope open so field-change tracking logs at precommit (after _log_merge_operation),
  // matching Odoo's mail_track_mixin precommit flush order (same pattern as src/models/ir_actions_server.ts:157-166).
  await trackPrepare(env, "res.partner", []);
  try {
    await updateMergedPartnerValues(env, srcIds, dstId);

    // Recompute partner_share on dst_partner
    const hasInternalUser = (await env.cr.query(
      "SELECT 1 FROM res_users WHERE partner_id = $1 AND active IS TRUE AND share IS NOT TRUE LIMIT 1",
      [dstId],
    )).rows.length > 0;
    await withoutWriteWatch(env, () => env.cr.query("UPDATE res_partner SET partner_share = $1 WHERE id = $2", [!hasInternalUser, dstId]));

    // mail/wizard/base_partner_merge_automatic_wizard.py:11-21 `_log_merge_operation`
    const parts = srcIds.map((sid) => {
      const sr = byId.get(sid)!;
      const item = translate(env, "%(partner)s <%(email)s> (ID %(id)s)", "mail")
        .replace("%(partner)s", sr.name ?? "False")
        .replace("%(email)s", sr.email || "n/a")
        .replace("%(id)s", String(sid));
      return pyStrRepr(item);
    });
    const logBody = translate(env, "Merged with the following partners: %s", "mail").replace("%s", `[${parts.join(", ")}]`);
    await callKw(env, "res.partner", "message_post", [[dstId]], { body: logBody });
  } catch (e) {
    trackAbortLevel(env.cr, "res.partner");
    throw e;
  }
  await closeTrackingScope(env, "res.partner");

  // Delete source partners
  await unlink(env.sudo(), "res.partner", srcIds);
}

/** base_partner_merge.py:612-645 + mail `_action_next_screen` (write phase, returns nextAction, deleteIds, and flushed wizard fields). */
async function partnerMergeNextScreenBody(
  env: Environment,
  wizardId: number,
  priorWizardFields: readonly string[] = [],
): Promise<{ nextAction: Record<string, unknown>; deleteIds: number[]; wizardId: number; wizardWritten: string[] }> {
  const lines = (await env.cr.query<{ id: number; aggr_ids: string }>(
    "SELECT id, aggr_ids FROM base_partner_merge_line WHERE wizard_id = $1 ORDER BY min_id ASC, id ASC",
    [wizardId],
  )).rows;
  let flush2: string[];
  if (lines.length) {
    const cur = lines[0]!;
    const parsed = literalEval(cur.aggr_ids);
    const currentPartnerIds = Array.isArray(parsed) ? parsed.filter((x): x is number => typeof x === "number") : [];
    const ordered = await getOrderedPartners(env, currentPartnerIds);
    const dstId = ordered.length ? ordered[ordered.length - 1]! : false;
    await write(env, "base.partner.merge.automatic.wizard", [wizardId], {
      current_line_id: cur.id,
      partner_ids: [[6, 0, currentPartnerIds]],
      dst_partner_id: dstId,
      state: "selection",
    });
    // After self.env.invalidate_all() in _action_next_screen, Odoo marks every written column + write_uid + write_date
    flush2 = ["state", "current_line_id", "dst_partner_id", "write_uid", "write_date"];
  } else {
    await write(env, "base.partner.merge.automatic.wizard", [wizardId], {
      current_line_id: false,
      partner_ids: [],
      state: "finished",
    });
    flush2 = ["state", "current_line_id", "write_uid", "write_date"];
  }
  const wizardWritten = [...priorWizardFields];
  for (const f of flush2) if (!wizardWritten.includes(f)) wizardWritten.push(f);

  const nextAction: Record<string, unknown> = {
    type: "ir.actions.act_window",
    res_model: "base.partner.merge.automatic.wizard",
    res_id: wizardId,
    views: [[false, "form"]],
    view_mode: "form",
    target: "new",
  };
  const wizPartners = (await env.cr.query<{ id: number }>(
    `SELECT p.id FROM base_partner_merge_automatic_wizard_res_partner_rel r
       JOIN res_partner p ON p.id = r.res_partner_id
      WHERE r.base_partner_merge_automatic_wizard_id = $1
      ORDER BY p.complete_name ASC, p.id DESC`,
    [wizardId],
  )).rows.map((r) => r.id);
  const dstRow = (await env.cr.query<{ dst_partner_id: number | null }>(
    "SELECT dst_partner_id FROM base_partner_merge_automatic_wizard WHERE id = $1",
    [wizardId],
  )).rows[0];
  const deleteIds = [...wizPartners];
  if (dstRow?.dst_partner_id && !deleteIds.includes(dstRow.dst_partner_id)) deleteIds.push(dstRow.dst_partner_id);
  return { nextAction, deleteIds, wizardId, wizardWritten };
}

async function partnerMergeWrapStore(
  env: Environment,
  fn: () => Promise<{ nextAction: Record<string, unknown>; deleteIds: number[]; wizardId: number; wizardWritten: string[] }>,
): Promise<Record<string, unknown>> {
  const { out, written } = await recordWritten(env, fn);
  if (out.wizardWritten.length) {
    written["base.partner.merge.automatic.wizard"] ??= {};
    written["base.partner.merge.automatic.wizard"]![String(out.wizardId)] = out.wizardWritten;
  }
  const store = new Store();
  for (const pid of out.deleteIds) {
    store.add("mail.thread", pid, { _DELETE: true, model: "res.partner" }, true);
  }
  const storeValues = out.deleteIds.length ? await store.asDict(env.cr) : {};
  if (out.deleteIds.length && storeValues["__store_version__"]) {
    storeValues["__store_version__"] = await storeVersion(env.cr, written);
  }
  return {
    params: {
      store_values: storeValues,
      next_action: out.nextAction,
    },
    tag: "mail.store_insert",
    type: "ir.actions.client",
  };
}

const MERGE_GROUPBY_FIELDS = ["email", "name", "is_company", "vat", "parent_id"] as const;

async function partnerMergeProcessQuery(
  env: Environment,
  wizardId: number,
  rows: readonly { min_id: number; aggr_ids: number[] }[],
  excludeContact: boolean,
  excludeJournalItem: boolean,
): Promise<void> {
  let counter = 0;
  for (const r of rows) {
    const partners = await env.model("res.partner").search(cond("id", "in", r.aggr_ids));
    if (partners.length < 2) continue;
    if (excludeContact) {
      const n = await env.model("res.users").searchCount(cond("partner_id", "in", partners));
      if (n > 0) continue;
    }
    if (excludeJournalItem && env.reg.models.has("account.move.line")) {
      const n = await env.model("account.move.line").searchCount(cond("partner_id", "in", partners));
      if (n > 0) continue;
    }
    await create(env, "base.partner.merge.line", [{
      wizard_id: wizardId,
      min_id: r.min_id,
      aggr_ids: `[${partners.join(", ")}]`,
    }]);
    counter += 1;
  }
  await write(env, "base.partner.merge.automatic.wizard", [wizardId], {
    state: "selection",
    number_group: counter,
  });
}

async function partnerMergeStartManual(env: Environment, wizardId: number): Promise<{ nextAction: Record<string, unknown>; deleteIds: number[]; wizardId: number; wizardWritten: string[] }> {
  const row = (await env.cr.query<{
    group_by_email: boolean | null; group_by_name: boolean | null; group_by_is_company: boolean | null;
    group_by_vat: boolean | null; group_by_parent_id: boolean | null;
    exclude_contact: boolean | null; exclude_journal_item: boolean | null; maximum_group: number | null;
  }>(
    `SELECT group_by_email, group_by_name, group_by_is_company, group_by_vat, group_by_parent_id,
            exclude_contact, exclude_journal_item, maximum_group
       FROM base_partner_merge_automatic_wizard WHERE id = $1`,
    [wizardId],
  )).rows[0];
  if (!row) throw new NotPorted(`base.partner.merge.automatic.wizard(${wizardId}) missing`);
  const groups: string[] = [];
  for (const g of MERGE_GROUPBY_FIELDS) {
    if (row[`group_by_${g}` as keyof typeof row]) groups.push(g);
  }
  if (!groups.length) {
    throw new UserError(translate(env, "You have to specify a filter for your selection.", "base"));
  }
  const sqlFields = groups.map((f) => {
    if (f === "email" || f === "name") return `lower("${f}")`;
    if (f === "vat") return `replace("${f}", ' ', '')`;
    return `"${f}"`;
  });
  const criteria = groups.filter((f) => f === "email" || f === "name" || f === "vat").map((f) => `"${f}" IS NOT NULL`);
  const whereClause = criteria.length ? `WHERE ${criteria.join(" AND ")}` : "";
  const limitClause = row.maximum_group && row.maximum_group > 0 ? `LIMIT ${Math.floor(row.maximum_group)}` : "";
  const queryRows = (await env.cr.query<{ min_id: number; aggr_ids: number[] }>(
    `SELECT min(id) AS min_id, array_agg(id) AS aggr_ids
       FROM res_partner
       ${whereClause}
      GROUP BY ${sqlFields.join(", ")}
     HAVING COUNT(*) >= 2
      ORDER BY min(id)
      ${limitClause}`,
  )).rows;
  await partnerMergeProcessQuery(env, wizardId, queryRows, Boolean(row.exclude_contact), Boolean(row.exclude_journal_item));
  return partnerMergeNextScreenBody(env, wizardId, ["state", "number_group", "write_date"]);
}

button("base.partner.merge.automatic.wizard", "action_skip", async (env, ids) => {
  const id = ensureOne(ids, "base.partner.merge.automatic.wizard");
  return partnerMergeWrapStore(env, async () => {
    const curLine = (await env.cr.query<{ current_line_id: number | null }>(
      "SELECT current_line_id FROM base_partner_merge_automatic_wizard WHERE id = $1",
      [id],
    )).rows[0]?.current_line_id;
    if (curLine) await unlink(env, "base.partner.merge.line", [curLine]);
    return partnerMergeNextScreenBody(env, id);
  });
});

button("base.partner.merge.automatic.wizard", "action_start_manual_process", async (env, ids) => {
  const id = ensureOne(ids, "base.partner.merge.automatic.wizard");
  return partnerMergeWrapStore(env, () => partnerMergeStartManual(env, id));
});

async function partnerMergeStartAutomatic(env: Environment, wizardId: number): Promise<Record<string, unknown>> {
  await partnerMergeStartManual(env, wizardId);
  const lines = (await env.cr.query<{ id: number; aggr_ids: string }>(
    "SELECT id, aggr_ids FROM base_partner_merge_line WHERE wizard_id = $1 ORDER BY min_id ASC, id ASC",
    [wizardId],
  )).rows;
  for (const line of lines) {
    const parsed = literalEval(line.aggr_ids);
    const partnerIds = Array.isArray(parsed) ? parsed.filter((x): x is number => typeof x === "number") : [];
    await mergePartners(env, partnerIds, null);
    await unlink(env, "base.partner.merge.line", [line.id]);
  }
  await write(env, "base.partner.merge.automatic.wizard", [wizardId], { state: "finished" });
  return {
    type: "ir.actions.act_window",
    res_model: "base.partner.merge.automatic.wizard",
    res_id: wizardId,
    view_mode: "form",
    target: "new",
  };
}

button("base.partner.merge.automatic.wizard", "action_start_automatic_process", async (env, ids) => {
  const id = ensureOne(ids, "base.partner.merge.automatic.wizard");
  return partnerMergeStartAutomatic(env, id);
});

button("base.partner.merge.automatic.wizard", "action_update_all_process", async (env, ids) => {
  const id = ensureOne(ids, "base.partner.merge.automatic.wizard");
  return partnerMergeWrapStore(env, async () => {
    const row = (await env.cr.query<{ exclude_contact: boolean | null; exclude_journal_item: boolean | null }>(
      "SELECT exclude_contact, exclude_journal_item FROM base_partner_merge_automatic_wizard WHERE id = $1",
      [id],
    )).rows[0];
    const queryRows = (await env.cr.query<{ min_id: number; aggr_ids: number[] }>(
      `SELECT min(p1.id) AS min_id, array_agg(DISTINCT p1.id) AS aggr_ids
         FROM res_partner AS p1
         INNER JOIN res_partner AS p2
            ON p1.email = p2.email AND p1.name = p2.name
           AND (p1.parent_id = p2.id OR p1.id = p2.parent_id)
        WHERE p2.id IS NOT NULL
        GROUP BY p1.email, p1.name, CASE WHEN p1.parent_id = p2.id THEN p2.id ELSE p1.id END
       HAVING COUNT(*) >= 2
        ORDER BY min(p1.id)`,
    )).rows;
    await partnerMergeProcessQuery(env, id, queryRows, Boolean(row?.exclude_contact), Boolean(row?.exclude_journal_item));
    const lines = (await env.cr.query<{ id: number; aggr_ids: string }>(
      "SELECT id, aggr_ids FROM base_partner_merge_line WHERE wizard_id = $1 ORDER BY min_id ASC, id ASC",
      [id],
    )).rows;
    for (const line of lines) {
      const parsed = literalEval(line.aggr_ids);
      const partnerIds = Array.isArray(parsed) ? parsed.filter((x): x is number => typeof x === "number") : [];
      await mergePartners(env, partnerIds, null);
      await unlink(env, "base.partner.merge.line", [line.id]);
    }
    await write(env, "base.partner.merge.automatic.wizard", [id], { state: "finished" });
    await withoutWriteWatch(env, () => env.cr.query("UPDATE res_partner SET parent_id = NULL WHERE parent_id = id"));
    const [wiz2] = await create(env, "base.partner.merge.automatic.wizard", [{
      group_by_vat: true,
      group_by_email: true,
      group_by_name: true,
    }]);
    await partnerMergeStartAutomatic(env, wiz2!);
    return partnerMergeNextScreenBody(env, id);
  });
});

button("base.partner.merge.automatic.wizard", "action_merge", async (env, ids) => {
  const id = ensureOne(ids, "base.partner.merge.automatic.wizard");
  const partnerIds = (await env.cr.query<{ id: number }>(
    `SELECT p.id FROM base_partner_merge_automatic_wizard_res_partner_rel r
       JOIN res_partner p ON p.id = r.res_partner_id
      WHERE r.base_partner_merge_automatic_wizard_id = $1
      ORDER BY p.complete_name ASC, p.id DESC`,
    [id],
  )).rows.map((r) => r.id);
  if (!partnerIds.length) {
    await write(env, "base.partner.merge.automatic.wizard", [id], { state: "finished" });
    return {
      type: "ir.actions.act_window",
      res_model: "base.partner.merge.automatic.wizard",
      res_id: id,
      view_mode: "form",
      target: "new",
    };
  }
  return partnerMergeWrapStore(env, async () => {
    const wizRow = (await env.cr.query<{ dst_partner_id: number | null; current_line_id: number | null }>(
      "SELECT dst_partner_id, current_line_id FROM base_partner_merge_automatic_wizard WHERE id = $1",
      [id],
    )).rows[0]!;
    await mergePartners(env, partnerIds, wizRow.dst_partner_id);
    if (wizRow.current_line_id) {
      await unlink(env, "base.partner.merge.line", [wizRow.current_line_id]);
    }
    return partnerMergeNextScreenBody(env, id);
  });
});

// ================================================================================================================
// 3. Change Password Wizard & Identity Check (base/models/res_users.py:1533-1572, auth_passkey)
// ================================================================================================================

registerDefaults("change.password.wizard", {
  user_ids: async (env) => {
    if (env.context["active_model"] !== "res.users") return [];
    const raw = env.context["active_ids"];
    const activeIds = Array.isArray(raw) ? raw.filter((x): x is number => typeof x === "number" && x > 0) : [];
    if (!activeIds.length) return [];
    const rows = (await env.cr.query<{ id: number; login: string }>(
      "SELECT id, login FROM res_users WHERE id = ANY($1::int[])",
      [activeIds],
    )).rows;
    const byId = new Map(rows.map((r) => [r.id, r.login]));
    return activeIds
      .filter((uid) => byId.has(uid))
      .map((uid) => [0, 0, { user_id: uid, user_login: byId.get(uid)! }]);
  },
});

async function changePasswordUserButton(env: Environment, ids: number[]): Promise<unknown> {
  return checkIdentity(env, "change.password.user", ids, "change_password_button", async () => {
    const ctx = requestOfCursor(env.cr);
    if (!ctx) throw new NotPorted("change.password.user.change_password_button outside a request");
    if (!ids.length) return { type: "ir.actions.act_window_close" };
    const rows = (await env.cr.query<{ id: number; user_id: number; new_passwd: string | null }>(
      "SELECT id, user_id, new_passwd FROM change_password_user WHERE id = ANY($1::int[]) ORDER BY array_position($1::int[], id)",
      [ids],
    )).rows;
    for (const line of rows) {
      if (line.new_passwd) {
        await changePassword(env, ctx, line.new_passwd, line.user_id);
      }
    }
    await write(env, "change.password.user", ids, { new_passwd: false });
    if (rows.some((r) => r.user_id === env.uid)) {
      return { type: "ir.actions.client", tag: "reload" };
    }
    return { type: "ir.actions.act_window_close" };
  });
}

button("change.password.wizard", "change_password_button", async (env, ids) => {
  const id = ensureOne(ids, "change.password.wizard");
  const lineIds = (await env.cr.query<{ id: number }>(
    "SELECT id FROM change_password_user WHERE wizard_id = $1 ORDER BY id",
    [id],
  )).rows.map((r) => r.id);
  return changePasswordUserButton(env, lineIds);
});

button("change.password.user", "change_password_button", (env, ids) => changePasswordUserButton(env, ids));

/** auth_passkey/models/res_users_identitycheck.py:30-41 `action_use_password`. */
button("res.users.identitycheck", "action_use_password", async (env, ids) => {
  const id = ensureOne(ids, "res.users.identitycheck");
  await write(env, "res.users.identitycheck", [id], { auth_method: "password" });
  return {
    type: "ir.actions.act_window",
    res_model: "res.users.identitycheck",
    res_id: id,
    name: translate(env, "Security Control", "auth_passkey"),
    target: "new",
    views: [[false, "form"]],
  };
});

// ================================================================================================================
// 4. Privacy Lookup Wizard (privacy_lookup/wizard/privacy_lookup_wizard.py & models/privacy_log.py)
// ================================================================================================================

function anonymizeEmail(env: Environment, label: string): string {
  if (!label || !label.includes("@")) {
    throw new UserError(translate(env, "This email address is not valid (%s)", "privacy_lookup").replace("%s", label));
  }
  const [user = "", domain = ""] = label.split("@");
  const anonUser = user.split(".").filter(Boolean).map((e) => e[0] + "*".repeat(e.length - 1)).join(".");
  let anonDomain = domain;
  if (!["gmail.com", "hotmail.com", "yahoo.com"].includes(domain)) {
    const parts = domain.split(".");
    const head = parts.slice(0, -1).filter(Boolean).map((e) => e[0] + "*".repeat(e.length - 1));
    anonDomain = [...head, parts[parts.length - 1]!].join(".");
  }
  return `${anonUser}@${anonDomain}`;
}

function anonymizeName(env: Environment, label: string): string {
  if (!label) return "";
  if (label.includes("@")) return anonymizeEmail(env, label);
  return label.split(" ").filter(Boolean).map((e) => e[0] + "*".repeat(e.length - 1)).join(" ");
}

registerOverrides("privacy.log", {
  create: async (env, valsList, next) => {
    for (const vals of valsList) {
      if (typeof vals["anonymized_name"] === "string") vals["anonymized_name"] = anonymizeName(env, vals["anonymized_name"]);
      if (typeof vals["anonymized_email"] === "string") vals["anonymized_email"] = anonymizeEmail(env, vals["anonymized_email"]);
    }
    return next(env, valsList);
  },
});

const PRIVACY_BLACKLIST = new Set([
  "res.partner", "res.users",
  "mail.notification", "mail.followers", "discuss.channel.member",
  "mail.message",
  "account.return.type", "account.report",
]);

async function computePrivacyRecordsDescription(env: Environment, wizardId: number): Promise<string> {
  const lines = (await env.cr.query<{ res_model_id: number | null; res_id: number; model: string | null; model_name: string | null }>(
    `SELECT l.res_model_id, l.res_id, m.model, COALESCE(m.name->>$2, m.name->>'en_US') AS model_name
       FROM privacy_lookup_wizard_line l
       LEFT JOIN ir_model m ON m.id = l.res_model_id
      WHERE l.wizard_id = $1
      ORDER BY l.id`,
    [wizardId, env.lang ?? "en_US"],
  )).rows;
  if (!lines.length) return "";
  const isNoOne = await userHasGroup(env, "base.group_no_one");
  const byModel = new Map<number, { name: string; model: string; ids: number[] }>();
  for (const l of lines) {
    if (l.res_model_id === null) continue;
    let entry = byModel.get(l.res_model_id);
    if (!entry) {
      entry = { name: l.model_name ?? "", model: l.model ?? "", ids: [] };
      byModel.set(l.res_model_id, entry);
    }
    entry.ids.push(l.res_id);
  }
  const out: string[] = [];
  for (const entry of byModel.values()) {
    const label = isNoOne ? `${entry.name} - ${entry.model}` : entry.name;
    out.push(`${label} (${entry.ids.length}): ${entry.ids.map((i) => `#${i}`).join(", ")}`);
  }
  return out.join("\n");
}

defineComputes("privacy.lookup.wizard", {
  line_count: async (env, rec) => {
    if (rec.id === null) return (await rec.rels("line_ids")).length;
    const r = await env.cr.query<{ c: string }>("SELECT count(*)::text AS c FROM privacy_lookup_wizard_line WHERE wizard_id = $1", [rec.id]);
    return Number(r.rows[0]?.c ?? 0);
  },
  records_description: async (env, rec) => {
    if (rec.id === null) return "";
    return computePrivacyRecordsDescription(env, rec.id);
  },
});

registerRecordCompute("privacy.lookup.wizard", {
  execution_details: async (env, rec) => {
    if (rec.id === null) return "";
    const details = (await env.cr.query<{ execution_details: string | null }>(
      "SELECT execution_details FROM privacy_lookup_wizard_line WHERE wizard_id = $1 ORDER BY id",
      [rec.id],
    )).rows.map((r) => r.execution_details).filter((s): s is string => Boolean(s)).join("\n");
    // _post_log (privacy_lookup_wizard.py:175-186)
    const w = (await env.cr.query<{ log_id: number | null; name: string | null; email: string | null }>(
      "SELECT log_id, name, email FROM privacy_lookup_wizard WHERE id = $1",
      [rec.id],
    )).rows[0];
    if (w) {
      const recordsDesc = await computePrivacyRecordsDescription(env, rec.id);
      if (!w.log_id && details) {
        const [logId] = await create(env, "privacy.log", [{
          anonymized_name: w.name ?? "",
          anonymized_email: w.email ?? "",
          execution_details: details,
          records_description: recordsDesc,
        }]);
        await env.cr.query("UPDATE privacy_lookup_wizard SET log_id = $1 WHERE id = $2", [logId, rec.id]);
      } else if (w.log_id) {
        await write(env, "privacy.log", [w.log_id], {
          execution_details: details,
          records_description: recordsDesc,
        });
      }
    }
    return details;
  },
});

async function privacyOpenLines(env: Environment, wizardId: number): Promise<Record<string, unknown>> {
  const action = await forXmlId(env, "privacy_lookup.action_privacy_lookup_wizard_line");
  action["domain"] = [["wizard_id", "=", wizardId]];
  return action;
}

button("privacy.lookup.wizard", "action_lookup", async (env, ids) => {
  const id = ensureOne(ids, "privacy.lookup.wizard");
  const w = (await env.cr.query<{ name: string | null; email: string | null }>(
    "SELECT name, email FROM privacy_lookup_wizard WHERE id = $1",
    [id],
  )).rows[0];
  if (!w) throw new NotPorted(`privacy.lookup.wizard(${id}) missing`);
  const rawName = (w.name ?? "").trim();
  const rawEmail = (w.email ?? "").trim();
  const emailLike = `%${rawEmail}%`;
  const emailNorm = emailNormalize(rawEmail);
  if (!emailNorm) {
    throw new UserError(translate(env, "Invalid email address “%s”", "privacy_lookup").replace("%s", w.email ?? ""));
  }
  const [partnerModelId, usersModelId, msgModelId] = await Promise.all([
    env.reg.xmlid(env.cr, "base.model_res_partner"),
    env.reg.xmlid(env.cr, "base.model_res_users"),
    env.reg.xmlid(env.cr, "mail.model_mail_message"),
  ]);
  const params: unknown[] = [emailNorm, rawName, partnerModelId, usersModelId, emailLike, emailLike, rawName, msgModelId];
  const parts: string[] = [
    `WITH indirect_references AS (
       SELECT id FROM res_partner WHERE email_normalized = $1 OR name ilike $2
     )
     SELECT $3::int AS res_model_id, id AS res_id, active AS is_active
       FROM res_partner WHERE id IN (SELECT id FROM indirect_references)
     UNION ALL
     SELECT $4::int AS res_model_id, id AS res_id, active AS is_active
       FROM res_users
      WHERE (login ilike $5) OR (partner_id IN (SELECT id FROM res_partner WHERE email ilike $6 OR name ilike $7))
     UNION ALL
     SELECT $8::int AS res_model_id, id AS res_id, TRUE AS is_active
       FROM mail_message WHERE author_id IN (SELECT id FROM indirect_references)`,
  ];

  // Step 3: iterate models in ir_model id order (module load order), keeping only BASE TABLE (auto=True) models
  const baseTables = new Set((await env.cr.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'",
  )).rows.map((r) => r.table_name));
  const modelRows = (await env.cr.query<{ id: number; model: string }>("SELECT id, model FROM ir_model ORDER BY id")).rows;
  for (const mr of modelRows) {
    const modelName = mr.model;
    if (PRIVACY_BLACKLIST.has(modelName) || !env.reg.models.has(modelName)) continue;
    const def = env.reg.model(modelName);
    if (def.transient || def.abstract || !def.table || !baseTables.has(def.table)) continue;
    const conditions: string[] = [];
    for (const fname of ["email_normalized", "email", "email_from", "company_email"]) {
      const f = def.fields.get(fname);
      if (f && f.store && f.column) {
        const recName = def.recName || "name";
        const isNorm = fname === "email_normalized" || (modelName === "mailing.trace" && fname === "email");
        params.push(isNorm ? emailNorm : emailLike);
        conditions.push(`"${fname}" ${isNorm ? "=" : "ilike"} $${params.length}`);
        const rnField = def.fields.get(recName);
        if (rnField && rnField.store && rnField.column && rnField.type === "char" && !rnField.translate) {
          params.push(rawName);
          conditions.push(`"${recName}" ilike $${params.length}`);
        }
        if (isNorm) break;
      }
    }
    for (const [fname, f] of def.fields) {
      if (f.type === "many2one" && f.relation === "res.partner" && f.store && f.column && f.ondelete !== "cascade") {
        conditions.push(`"${fname}" IN (SELECT id FROM indirect_references)`);
      }
    }
    if (conditions.length) {
      params.push(mr.id);
      const midIdx = params.length;
      const activeExpr = def.fields.has("active") && def.fields.get("active")!.column ? `"active"` : "TRUE";
      parts.push(
        `SELECT $${midIdx}::int AS res_model_id, id AS res_id, ${activeExpr} AS is_active
           FROM "${def.table}" WHERE ${conditions.join(" OR ")}`,
      );
    }
  }

  const results = (await env.cr.query<{ res_model_id: number; res_id: number; is_active: boolean | null }>(
    parts.join("\nUNION ALL\n"),
    params,
  )).rows;
  await write(env, "privacy.lookup.wizard", [id], {
    line_ids: [
      [5, 0, 0],
      ...results.map((r) => [0, 0, { res_model_id: r.res_model_id, res_id: r.res_id, is_active: Boolean(r.is_active) }]),
    ],
  });
  return privacyOpenLines(env, id);
});

button("privacy.lookup.wizard", "action_open_lines", async (env, ids) => {
  const id = ensureOne(ids, "privacy.lookup.wizard");
  return privacyOpenLines(env, id);
});

registerHooks("privacy.lookup.wizard.line", {
  selection: {
    resource_ref: async (env) => {
      const lang = env.lang ?? "en_US";
      const rows = (await env.cr.query<{ model: string; name: string }>(
        `SELECT model, COALESCE(name->>$1, name->>'en_US') AS name FROM ir_model
          ORDER BY is_mail_thread DESC, COALESCE(name->>$1, name->>'en_US') ASC`,
        [lang],
      )).rows;
      return rows.map((r) => [r.model, r.name] as [string, string]);
    },
  },
});

registerRecordCompute("privacy.lookup.wizard.line", {
  has_active: async (env, rec) => {
    const mid = m2oId(await rec.get("res_model_id"));
    if (!mid) return false;
    const model = (await env.cr.query<{ model: string }>("SELECT model FROM ir_model WHERE id = $1", [mid])).rows[0]?.model;
    return Boolean(model && env.reg.models.has(model) && env.reg.model(model).fields.has("active"));
  },
  res_name: async (env, rec) => {
    const resId = await rec.get("res_id");
    let model = await rec.get("res_model");
    const mid = m2oId(await rec.get("res_model_id"));
    if (!model && mid) {
      model = (await env.cr.query<{ model: string }>("SELECT model FROM ir_model WHERE id = $1", [mid])).rows[0]?.model ?? false;
    }
    if (!resId || typeof resId !== "number" || !model || typeof model !== "string" || !env.reg.models.has(model)) {
      return NOT_ASSIGNED;
    }
    const def = env.reg.model(model);
    const exists = (await env.cr.query(`SELECT 1 FROM "${def.table}" WHERE id = $1`, [resId])).rows.length > 0;
    if (!exists) return NOT_ASSIGNED;
    const dn = (await env.sudo().model(model).displayName([resId])).get(resId);
    if (dn) return dn;
    const mName = mid
      ? (await env.cr.query<{ n: string }>("SELECT COALESCE(name->>$2, name->>'en_US') AS n FROM ir_model WHERE id = $1", [mid, env.lang ?? "en_US"])).rows[0]?.n ?? model
      : model;
    return `${mName}/${resId}`;
  },
});

defineComputes("privacy.lookup.wizard.line", {
  resource_ref: async (env, rec) => {
    const model = await rec.get("res_model");
    const resId = await rec.get("res_id");
    const isUnlinked = await rec.get("is_unlinked");
    if (typeof model === "string" && model && env.reg.models.has(model) && !isUnlinked && typeof resId === "number") {
      try {
        await env.model(model).checkAccess([resId], "read");
        return `${model},${resId || 0}`;
      } catch {
        return false;
      }
    }
    return false;
  },
});

registerOverrides("privacy.lookup.wizard.line", {
  inverse: {
    resource_ref: async (env, ids, vals) => {
      const ref = vals["resource_ref"];
      if (typeof ref === "string" && ref.includes(",")) {
        const rid = Number(ref.split(",")[1]);
        if (Number.isInteger(rid)) await write(env, "privacy.lookup.wizard.line", ids, { res_id: rid });
      }
    },
  },
});

registerOnchange("privacy.lookup.wizard.line", "_onchange_is_active", ["is_active"], async (env, rec) => {
  if (!(rec instanceof NewRec)) return;
  const mid = m2oId(await rec.get("res_model_id"));
  const resId = await rec.get("res_id");
  if (!mid || typeof resId !== "number" || !resId) return;
  const mr = (await env.cr.query<{ model: string; n: string }>(
    "SELECT model, COALESCE(name->>$2, name->>'en_US') AS n FROM ir_model WHERE id = $1",
    [mid, env.lang ?? "en_US"],
  )).rows[0];
  if (!mr || !env.reg.models.has(mr.model)) return;
  const isActive = Boolean(await rec.get("is_active"));
  const actionLabel = translate(env, isActive ? "Unarchived" : "Archived", "privacy_lookup");
  await rec.set("execution_details", `${actionLabel} ${mr.n} #${resId}`);
  await write(env.sudo(), mr.model, [resId], { active: isActive });
});

button("privacy.lookup.wizard.line", "action_open_record", async (env, ids) => {
  const id = ensureOne(ids, "privacy.lookup.wizard.line");
  const [line] = await fetchRecords(env, "privacy.lookup.wizard.line", [id], ["res_id", "res_model"]);
  return {
    type: "ir.actions.act_window",
    view_mode: "form",
    res_id: line!["res_id"],
    res_model: line!["res_model"],
  };
});

button("privacy.lookup.wizard.line", "action_unlink", async (env, ids) => {
  const id = ensureOne(ids, "privacy.lookup.wizard.line");
  const row = (await env.cr.query<{ res_model: string | null; res_id: number; is_unlinked: boolean | null; m_name: string | null }>(
    `SELECT l.res_model, l.res_id, l.is_unlinked, COALESCE(m.name->>$2, m.name->>'en_US') AS m_name
       FROM privacy_lookup_wizard_line l LEFT JOIN ir_model m ON m.id = l.res_model_id
      WHERE l.id = $1`,
    [id, env.lang ?? "en_US"],
  )).rows[0];
  if (!row) throw new NotPorted(`privacy.lookup.wizard.line(${id}) missing`);
  if (row.is_unlinked) throw new UserError(translate(env, "The record is already unlinked.", "privacy_lookup"));
  if (row.res_model) await unlink(env.sudo(), row.res_model, [row.res_id]);
  const delLabel = translate(env, "Deleted", "privacy_lookup");
  await write(env, "privacy.lookup.wizard.line", [id], {
    execution_details: `${delLabel} ${row.m_name ?? ""} #${row.res_id}`,
    is_unlinked: true,
  });
  return null;
});

button("privacy.lookup.wizard.line", "action_archive_all", async (env, ids) => {
  if (!ids.length) return null;
  const rows = (await env.cr.query<{ id: number; has_active: boolean | null; is_active: boolean | null; res_model: string | null; res_id: number; m_name: string | null }>(
    `SELECT l.id, l.has_active, l.is_active, l.res_model, l.res_id, COALESCE(m.name->>$2, m.name->>'en_US') AS m_name
       FROM privacy_lookup_wizard_line l LEFT JOIN ir_model m ON m.id = l.res_model_id
      WHERE l.id = ANY($1::int[]) ORDER BY array_position($1::int[], l.id)`,
    [ids, env.lang ?? "en_US"],
  )).rows;
  const archLabel = translate(env, "Archived", "privacy_lookup");
  for (const r of rows) {
    if (!r.has_active || !r.is_active || !r.res_model) continue;
    await write(env.sudo(), r.res_model, [r.res_id], { active: false });
    await write(env, "privacy.lookup.wizard.line", [r.id], {
      is_active: false,
      execution_details: `${archLabel} ${r.m_name ?? ""} #${r.res_id}`,
    });
  }
  return null;
});

button("privacy.lookup.wizard.line", "action_unlink_all", async (env, ids) => {
  for (const id of ids) {
    const r = (await env.cr.query<{ is_unlinked: boolean | null }>("SELECT is_unlinked FROM privacy_lookup_wizard_line WHERE id = $1", [id])).rows[0];
    if (r && !r.is_unlinked) await callKw(env, "privacy.lookup.wizard.line", "action_unlink", [[id]], {});
  }
  return null;
});

// ================================================================================================================
// 5. UTM Campaign Smart Buttons & Computes (crm/models/utm.py, sale/models/utm_campaign.py)
// ================================================================================================================

defineComputes("utm.campaign", {
  use_leads: async (env) => userHasGroup(env, "crm.group_use_lead"),
  crm_lead_count: async (env, rec) => {
    if (rec.id === null) return 0;
    return env.withContext({ ...env.context, active_test: false }).model("crm.lead").searchCount(cond("campaign_id", "=", rec.id));
  },
  quotation_count: async (env, rec) => {
    if (rec.id === null) return 0;
    return env.sudo().model("sale.order").searchCount(and([cond("campaign_id", "=", rec.id), cond("state", "!=", "cancel")]));
  },
  currency_id: async (env) => {
    const cid = await env.company();
    return (await env.cr.query<{ currency_id: number | null }>("SELECT currency_id FROM res_company WHERE id = $1", [cid])).rows[0]?.currency_id ?? false;
  },
  invoiced_amount: async (env, rec) => {
    if (rec.id === null) return 0;
    const r = (await env.cr.query<{ s: string | null }>(
      `SELECT SUM(
                (CASE WHEN move.move_type = 'out_refund' THEN -line.price_total ELSE line.price_total END)
                / COALESCE(currency_rate.rate, 1)
              )::text AS s
         FROM account_move_line line
   INNER JOIN account_move move ON line.move_id = move.id
    LEFT JOIN LATERAL (
              SELECT rate FROM res_currency_rate
               WHERE company_id = line.company_id
                 AND currency_id = line.currency_id
                 AND name <= line.date
               ORDER BY name DESC
               LIMIT 1
              ) currency_rate ON TRUE
        WHERE move.state NOT IN ('draft', 'cancel')
          AND move.campaign_id = $1
          AND move.move_type IN ('out_invoice', 'out_refund')
          AND line.account_id IS NOT NULL
          AND line.display_type = 'product'`,
      [rec.id],
    )).rows[0];
    return r?.s ? Number(r.s) : 0;
  },
});

/** crm/models/utm.py:24-30 `action_redirect_to_leads_opportunities`. */
button("utm.campaign", "action_redirect_to_leads_opportunities", async (env, ids) => {
  const useLeads = await userHasGroup(env, "crm.group_use_lead");
  const action = await forXmlId(env, useLeads ? "crm.crm_lead_all_leads" : "crm.crm_lead_opportunities");
  action["view_mode"] = "list,kanban,graph,pivot,form,calendar";
  action["domain"] = [["campaign_id", "in", [...ids]]];
  action["context"] = { active_test: false, create: false };
  return action;
});

/** sale/models/utm_campaign.py:94-100 `action_redirect_to_quotations`. */
button("utm.campaign", "action_redirect_to_quotations", async (env, ids) => {
  const id = ensureOne(ids, "utm.campaign");
  const action = await forXmlId(env, "sale.action_quotations_with_onboarding");
  action["domain"] = [["campaign_id", "=", id]];
  action["context"] = { default_campaign_id: id, search_default_filter_not_cancelled: 1 };
  return action;
});

/** sale/models/utm_campaign.py:102-122 `action_redirect_to_invoiced`. */
button("utm.campaign", "action_redirect_to_invoiced", async (env, ids) => {
  const id = ensureOne(ids, "utm.campaign");
  const action = await forXmlId(env, "account.action_move_journal_line");
  const invoices = await env.model("account.move").search(cond("campaign_id", "=", id));
  action["context"] = { create: false, edit: false, view_no_maturity: true };
  action["domain"] = [
    ["id", "in", invoices],
    ["move_type", "in", ["out_invoice", "out_refund", "in_invoice", "in_refund", "out_receipt", "in_receipt"]],
    ["state", "not in", ["draft", "cancel"]],
  ];
  return action;
});

// ================================================================================================================
// 6. Technical / View / Server Action Utility Buttons
// ================================================================================================================

/** base/models/ir_actions_report.py:74-80 `_compute_linked_view_ids` and :130-135 `associated_view`. */
async function reportLinkedViewIds(env: Environment, reportName: unknown): Promise<number[]> {
  if (typeof reportName !== "string" || !reportName.includes(".")) return [];
  const suffix = reportName.split(".")[1];
  if (!suffix) return [];
  return env.model("ir.ui.view").search(and([cond("type", "=", "qweb"), cond("name", "ilike", suffix)]));
}

defineComputes("ir.actions.report", {
  linked_view_ids: async (env, rec) => reportLinkedViewIds(env, await rec.get("report_name")),
  linked_view_count: async (env, rec) => (await reportLinkedViewIds(env, await rec.get("report_name"))).length,
});

button("ir.actions.report", "associated_view", async (env, ids) => {
  const id = ensureOne(ids, "ir.actions.report");
  const [row] = await fetchRecords(env, "ir.actions.report", [id], ["report_name"]);
  const viewIds = await reportLinkedViewIds(env, row!["report_name"]);
  return getRecordsAction(env, "ir.ui.view", viewIds);
});

/** base/models/ir_actions.py:1365-1381 `action_open_parent_action`, `action_open_scheduled_action`, :1004-1013 `history_wizard_action`. */
button("ir.actions.server", "action_open_parent_action", async (env, ids) => {
  const rows = await fetchRecords(env, "ir.actions.server", ids, ["parent_id"]);
  const parentIds = [...new Set(rows.map((r) => m2oId(r["parent_id"])).filter((p): p is number => p !== null))];
  const parentId = parentIds.length === 0 ? false : ensureOne(parentIds, "ir.actions.server");
  return {
    type: "ir.actions.act_window",
    target: "current",
    views: [[false, "form"]],
    res_model: "ir.actions.server",
    res_id: parentId,
  };
});

button("ir.actions.server", "action_open_scheduled_action", async (env, ids) => {
  const crons = (await env.cr.query<{ id: number }>(
    `SELECT c.id FROM ir_cron c JOIN ir_act_server s ON s.id = c.ir_actions_server_id
      WHERE c.ir_actions_server_id = ANY($1::int[])
      ORDER BY COALESCE(s.name->>$2, s.name->>'en_US'), c.id`,
    [ids, env.lang ?? "en_US"],
  )).rows.map((r) => r.id);
  if (!crons.length) throw new OdooError("builtins.IndexError", "list index out of range");
  return {
    type: "ir.actions.act_window",
    target: "current",
    views: [[false, "form"]],
    res_model: "ir.cron",
    res_id: crons[0]!,
  };
});

button("ir.actions.server", "history_wizard_action", async (env, ids) => {
  const id = ensureOne(ids, "ir.actions.server");
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Code History", "base"),
    target: "new",
    views: [[false, "form"]],
    res_model: "server.action.history.wizard",
    context: { default_action_id: id },
  };
});

/** base/models/ir_cron.py:923-927 delegate to ir_actions_server_id. */
button("ir.cron", "action_open_parent_action", async (env, ids) => {
  const rows = await fetchRecords(env, "ir.cron", ids, ["ir_actions_server_id"]);
  const serverIds = [...new Set(rows.map((r) => m2oId(r["ir_actions_server_id"])).filter((x): x is number => x !== null))];
  return callKw(env, "ir.actions.server", "action_open_parent_action", [serverIds], {});
});

button("ir.cron", "action_open_scheduled_action", async (env, ids) => {
  const rows = await fetchRecords(env, "ir.cron", ids, ["ir_actions_server_id"]);
  const serverIds = [...new Set(rows.map((r) => m2oId(r["ir_actions_server_id"])).filter((x): x is number => x !== null))];
  return callKw(env, "ir.actions.server", "action_open_scheduled_action", [serverIds], {});
});

/** base/models/ir_actions.py:448-480 `server.action.history.wizard`. */
registerDefaults("server.action.history.wizard", {
  revision: async (env) => {
    const actionId = env.context["default_action_id"];
    if (typeof actionId !== "number" || !actionId) return false;
    const actionCode = (await env.cr.query<{ code: string | null }>("SELECT code FROM ir_act_server WHERE id = $1", [actionId])).rows[0]?.code ?? null;
    const dom = actionCode === null
      ? and([cond("action_id", "=", actionId), cond("code", "!=", false)])
      : and([cond("action_id", "=", actionId), cond("code", "!=", actionCode)]);
    const found = await env.model("ir.actions.server.history").search(dom, { limit: 1, order: "create_date desc, id desc" });
    return found[0] ?? false;
  },
});

function simpleHtmlDiff(fromText: string, fromName: string, toText: string, toName: string, dark = false): string {
  const colors = dark
    ? ["#7f2d2f", "#406a2d", "#51232f", "#3f483b"]
    : ["#ffc1c0", "#abf2bc", "#ffebe9", "#e6ffec"];
  const esc = (s: string) => escapeText(s).replace(/ /g, "&nbsp;");
  const a = fromText.split(/\r?\n/);
  const b = toText.split(/\r?\n/);
  const max = Math.max(a.length, b.length);
  const rows: string[] = [];
  for (let i = 0; i < max; i++) {
    const la = i < a.length ? a[i]! : "";
    const lb = i < b.length ? b[i]! : "";
    const same = i < a.length && i < b.length && la === lb;
    rows.push(
      `<tr><td class="diff_next d-none"></td><td class="diff_header bg-600 text-light text-center align-top px-2">${i < a.length ? i + 1 : ""}</td><td>${same ? esc(la) : `<span class="diff_sub">${esc(la)}</span>`}</td><td class="diff_next d-none"></td><td class="diff_header bg-600 text-light text-center align-top px-2">${i < b.length ? i + 1 : ""}</td><td>${same ? esc(lb) : `<span class="diff_add">${esc(lb)}</span>`}</td></tr>`,
    );
  }
  return `<table class="diff" cellspacing="0" cellpadding="0" rules="groups"><thead><tr><th class="diff_next d-none"><br /></th><th colspan="2" class="diff_header bg-600 text-light text-center align-top px-2">${fromName}</th><th class="diff_next d-none"><br /></th><th colspan="2" class="diff_header bg-600 text-light text-center align-top px-2">${toName}</th></tr></thead><tbody>${rows.join("")}</tbody></table>
            <style>
                .modal-dialog.modal-lg:has(table.diff) { max-width: 1600px; padding-left: 1.75rem; padding-right: 1.75rem; }
                table.diff { width: 100%; }
                table.diff th.diff_header { width: 50%; }
                table.diff td.diff_header { white-space: nowrap; }
                table.diff td.diff_header + td { width: 50%; }
                table.diff td { word-break: break-all; vertical-align: top; }
                table.diff .diff_chg, table.diff .diff_sub, table.diff .diff_add { display: inline-block; color: inherit; }
                table.diff .diff_sub, table.diff td:nth-child(3) > .diff_chg { background-color: ${colors[0]} }
                table.diff .diff_add, table.diff td:nth-child(6) > .diff_chg { background-color: ${colors[1]} }
                table.diff td:nth-child(3):has(>.diff_chg, .diff_sub) { background-color: ${colors[2]} }
                table.diff td:nth-child(6):has(>.diff_chg, .diff_add) { background-color: ${colors[3]} }
            </style>`;
}

defineComputes("server.action.history.wizard", {
  code_diff: async (env, rec) => {
    const rev = await rec.rel("revision");
    const act = await rec.rel("action_id");
    const revCode = rev ? ((await rev.get("code")) || false) : false;
    const actualCode = act ? ((await act.get("code")) || false) : false;
    if (actualCode === revCode) return false;
    return simpleHtmlDiff(
      String(actualCode || ""),
      translate(env, "Actual Code", "base"),
      String(revCode || ""),
      translate(env, "Revision Code", "base"),
    );
  },
});

button("server.action.history.wizard", "restore_revision", async (env, ids) => {
  const id = ensureOne(ids, "server.action.history.wizard");
  const row = (await env.cr.query<{ action_id: number | null; rev_code: string | null }>(
    `SELECT w.action_id, h.code AS rev_code
       FROM server_action_history_wizard w
       LEFT JOIN ir_actions_server_history h ON h.id = w.revision
      WHERE w.id = $1`,
    [id],
  )).rows[0];
  if (!row || !row.action_id) throw new NotPorted(`server.action.history.wizard(${id}) missing action_id`);
  await write(env, "ir.actions.server", [row.action_id], { code: row.rev_code ?? false });
  return null;
});

/** base/models/ir_ui_view.py:2711-2790 `reset.view.arch.wizard`. */
registerOverrides("reset.view.arch.wizard", {
  defaultGet: async (env, _fields, values) => {
    const raw = env.context["active_model"] === "ir.ui.view" ? env.context["active_ids"] : [];
    const viewIds = Array.isArray(raw) ? raw.filter((x): x is number => typeof x === "number" && x > 0) : [];
    if (viewIds.length > 2) {
      throw new ValidationError(translate(env, "Can't compare more than two views.", "base"));
    }
    values["view_id"] = viewIds.length ? viewIds[0]! : false;
    if (viewIds.length === 2) {
      values["reset_mode"] = "other_view";
      values["compare_view_id"] = viewIds[1]!;
    }
  },
});

async function computeResetViewDiff(env: Environment, rec: Rec): Promise<{ archToCompare: string | false; hasDiff: boolean; archDiff: string | false }> {
  const mode = String((await rec.get("reset_mode")) || "soft");
  const viewId = m2oId(await rec.get("view_id"));
  const compareViewId = m2oId(await rec.get("compare_view_id"));
  let diffTo: string | false = false;
  let diffToName = "";
  if (mode === "soft" && viewId) {
    const prev = (await env.cr.query<{ arch_prev: string | null }>("SELECT arch_prev FROM ir_ui_view WHERE id = $1", [viewId])).rows[0]?.arch_prev;
    diffTo = prev || false;
    diffToName = translate(env, "Previous Arch", "base");
  } else if (mode === "other_view" && compareViewId) {
    const row = (await env.cr.query<{ a: string | null; name: string | null }>("SELECT arch_db->>'en_US' AS a, name FROM ir_ui_view WHERE id = $1", [compareViewId])).rows[0];
    diffTo = row?.a || false;
    diffToName = row?.name || "";
  } else if (mode === "hard" && viewId) {
    const fs = (await env.cr.query<{ arch_fs: string | null }>("SELECT arch_fs FROM ir_ui_view WHERE id = $1", [viewId])).rows[0]?.arch_fs;
    if (fs) throw new NotPorted("reset.view.arch.wizard hard reset diff from addons file (read_arch_from_file)");
  }
  if (!diffTo) return { archToCompare: false, hasDiff: false, archDiff: false };
  const curArch = viewId
    ? ((await env.cr.query<{ a: string | null }>("SELECT arch_db->>'en_US' AS a FROM ir_ui_view WHERE id = $1", [viewId])).rows[0]?.a ?? "")
    : "";
  return {
    archToCompare: diffTo,
    hasDiff: curArch !== diffTo,
    archDiff: simpleHtmlDiff(curArch, translate(env, "Current Arch", "base"), diffTo, diffToName),
  };
}

defineComputes("reset.view.arch.wizard", {
  arch_to_compare: async (env, rec) => (await computeResetViewDiff(env, rec)).archToCompare,
  has_diff: async (env, rec) => (await computeResetViewDiff(env, rec)).hasDiff,
  arch_diff: async (env, rec) => (await computeResetViewDiff(env, rec)).archDiff,
});

button("reset.view.arch.wizard", "reset_view_button", async (env, ids) => {
  const id = ensureOne(ids, "reset.view.arch.wizard");
  const row = (await env.cr.query<{ view_id: number | null; reset_mode: string | null; compare_view_id: number | null }>(
    "SELECT view_id, reset_mode, compare_view_id FROM reset_view_arch_wizard WHERE id = $1",
    [id],
  )).rows[0];
  if (!row) throw new NotPorted(`reset.view.arch.wizard(${id}) missing`);
  if (row.view_id) {
    if (row.reset_mode === "other_view") {
      const archToCompare = row.compare_view_id
        ? ((await env.cr.query<{ a: string | null }>("SELECT arch_db->>'en_US' AS a FROM ir_ui_view WHERE id = $1", [row.compare_view_id])).rows[0]?.a ?? false)
        : false;
      await write(env, "ir.ui.view", [row.view_id], { arch_db: archToCompare });
    } else if (row.reset_mode === "soft") {
      const archPrev = (await env.cr.query<{ arch_prev: string | null }>("SELECT arch_prev FROM ir_ui_view WHERE id = $1", [row.view_id])).rows[0]?.arch_prev;
      if (archPrev) {
        const { lang: _dropLang, ...restCtx } = env.context;
        const noSaveEnv = env.withContext({ ...restCtx, no_save_prev: true });
        await write(noSaveEnv, "ir.ui.view", [row.view_id], { arch_db: archPrev });
      }
    } else if (row.reset_mode === "hard") {
      const archFs = (await env.cr.query<{ arch_fs: string | null }>("SELECT arch_fs FROM ir_ui_view WHERE id = $1", [row.view_id])).rows[0]?.arch_fs;
      if (archFs) {
        throw new NotPorted("reset.view.arch.wizard hard reset from addons file (read_arch_from_file)");
      }
    }
  }
  return { type: "ir.actions.act_window_close" };
});

/** base/wizard/wizard_ir_model_menu_create.py:11-25 `menu_create`. */
button("wizard.ir.model.menu.create", "menu_create", async (env, ids) => {
  const modelId = env.context["model_id"];
  const modelRow = typeof modelId === "number" && modelId > 0
    ? (await env.cr.query<{ model: string }>("SELECT model FROM ir_model WHERE id = $1", [modelId])).rows[0]
    : undefined;
  const rows = (await env.cr.query<{ id: number; name: string; menu_id: number }>(
    "SELECT id, name, menu_id FROM wizard_ir_model_menu_create WHERE id = ANY($1::int[]) ORDER BY array_position($1::int[], id)",
    [ids],
  )).rows;
  for (const menu of rows) {
    const [actId] = await create(env, "ir.actions.act_window", [{
      name: menu.name,
      res_model: modelRow?.model ?? false,
      view_mode: "list,form",
    }]);
    await create(env, "ir.ui.menu", [{
      name: menu.name,
      parent_id: menu.menu_id,
      action: `ir.actions.act_window,${actId}`,
    }]);
  }
  return { type: "ir.actions.act_window_close" };
});

// Silence unused imports if any helper is kept for parity
void DbRec;
void dbNow;
void or;
void TRUE;
