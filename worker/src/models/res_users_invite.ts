/**
 * Inviting users and resetting their password (auth_signup, base_setup):
 *  - Settings -> General Settings -> Invite New Users: `web_create_users(emails)`, auth_signup res_users.py:296-303 over
 *    base_setup res_users.py:12-39 (the archived users of the addresses reactivated, the invited ones invited again, the
 *    others created with `signup_valid`);
 *  - the invitation of a created user (auth_signup res_users.py:305-315 `create`, src/models/res_users_create.ts);
 *  - Settings -> Users -> Send Password Reset Instructions / Send an Invitation Email (`action_reset_password`,
 *    :146-155) and Copy Invite Link (`get_reset_password_link`, :157-170).
 * `_action_reset_password` (:172-262) prepares the partners' signup (`signup_prepare`, a write of `signup_type`), then
 * renders and sends each user's mail inside `contextlib.closing(cr.savepoint())`, which always rolls back
 * (sql_db.py:121-155 `close(rollback=True)`): the mail.mail and its mail.message never stay, sent or not, only their
 * ids are spent. The port spends the same two ids and does not render the mail: there is no mail server at
 * localhost:25 (D9), so the invitation (`send_mail_batch(..., force_send=True, raise_exception=True)`) raises
 * MailDeliveryException at the connection (mail_mail.py:780-786) and the reset mail (`mail.send()`) is marked failed,
 * then rolled back. A configured ir.mail_server, or a reachable SMTP server, refuses.
 */
import { NotPorted, UserError } from "../errors";
import { registerMethod } from "../http/methods";
import { envFor } from "../web/common";
import { create } from "../orm/create";
import { write } from "../orm/write";
import { userInfoOf } from "../orm/env";
import type { Environment } from "../orm/types";
import { smtpConnectFailure } from "../mail/notify";
import { parseContactFromEmail } from "../mail/thread_generic";
import { trackingHeld, trackSavepointFlush } from "../mail/tracking";
import { flushHeldTracking } from "../mail/write_hooks";
import { noteCommitPoint } from "../orm/created";
import { runPrecommit } from "./precommit";
import { translate } from "./util";
import { partnerSignupUrl } from "./sweep2_wizards";

/** base ir_mail_server.py MailDeliveryException(msg, exc): here always the refused connection (args[1]). */
export class MailDeliveryException extends Error {
  readonly connectionRefused = true;
}

/** sql_db.py:158-163 `_FlushingSavepoint.__init__`: `cr.flush()` runs the precommit (held tracking with it). */
async function savepointFlush(env: Environment): Promise<void> {
  await runPrecommit(env.cr);
  if (trackingHeld(env.cr)) await flushHeldTracking(env, true);
  noteCommitPoint(env.cr);
  trackSavepointFlush(env.cr);
}

let savepoints = 0;

/**
 * One user's mail inside `contextlib.closing(self.env.cr.savepoint())`: the mail.mail created as sudo (its mail.message
 * through `_inherits`: one id of each sequence), the connection refused, everything rolled back. `raise` is the
 * template's `raise_exception=True`.
 */
async function sendRolledBack(env: Environment, raise: boolean): Promise<void> {
  await savepointFlush(env);
  const sp = `reset_password_${++savepoints}`;
  await env.cr.query(`SAVEPOINT ${sp}`);
  try {
    // mail_mail.py:770-790 `send`: `_connect__` of the configured server, else localhost:25 (ir_mail_server.py)
    if ((await env.cr.query("SELECT 1 FROM ir_mail_server WHERE active LIMIT 1")).rows.length) {
      throw new NotPorted("res.users invitation or password reset mail through a configured ir.mail_server");
    }
    await env.cr.query("SELECT nextval('mail_message_id_seq'), nextval('mail_mail_id_seq')");
    await smtpConnectFailure();
    if (raise) throw new MailDeliveryException("Unable to connect to SMTP Server");
  } finally {
    // the savepoint's close: always rolled back (`contextlib.closing`)
    await env.cr.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    await env.cr.query(`RELEASE SAVEPOINT ${sp}`);
  }
}

/** The record of an xml id and its model (`env.ref(xmlid, raise_if_not_found=False)`), null when missing. */
async function refOf(env: Environment, xmlid: string): Promise<{ model: string; id: number } | null> {
  const [module, name] = xmlid.split(".");
  const row = (await env.cr.query<{ model: string; res_id: number }>(
    "SELECT model, res_id FROM ir_model_data WHERE module = $1 AND name = $2", [module, name])).rows[0];
  if (!row) return null;
  const table = row.model.replace(/\./g, "_");
  if (!env.reg.models.has(row.model)) return null;
  if (!(await env.cr.query(`SELECT 1 FROM "${table}" WHERE id = $1`, [row.res_id])).rows.length) return null;
  return { model: row.model, id: row.res_id };
}

/** `_is_internal` (base res_users.py:1271-1273): base.group_user among the user's groups. */
async function isInternal(env: Environment, uid: number): Promise<boolean> {
  const group = await env.reg.xmlid(env.cr, "base.group_user");
  return typeof group === "number" && (await userInfoOf(env, uid)).groupIds.includes(group);
}

/** auth_signup res_users.py:172-262 `_action_reset_password(signup_type)` of `ids` (in their order). */
export async function actionResetPasswordCore(env: Environment, ids: readonly number[], signupType: "signup" | "reset"): Promise<Record<string, unknown> | null> {
  if (env.context["install_mode"] || env.context["import_file"]) return null;
  const rows = new Map((await env.cr.query<{ id: number; active: boolean | null; partner_id: number; email: string | null; name: string | null }>(
    `SELECT u.id, u.active, u.partner_id, p.email, p.name FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = ANY($1::int[])`,
    [[...ids]])).rows.map((r) => [r.id, r]));
  const users = ids.map((id) => {
    const u = rows.get(id);
    if (!u) throw new NotPorted(`res.users ${id} that does not exist (MissingError)`);
    return u;
  });
  if (users.some((u) => !u.active)) throw new UserError(translate(env, "You cannot perform this action on an archived user.", "auth_signup"));
  const createMode = Boolean(env.context["create_user"]);
  // :184 `self.mapped('partner_id').signup_prepare(signup_type=...)` (res_partner.py:115-118)
  const partners = [...new Set(users.map((u) => u.partner_id))];
  await write(env, "res.partner", partners, { signup_type: signupType });
  // :187-201 the templates of the created accounts
  let internalTemplate = false;
  let portalTemplate = false;
  if (createMode) {
    const internal = new Map<number, boolean>();
    for (const u of users) internal.set(u.id, await isInternal(env, u.id));
    if (users.some((u) => internal.get(u.id))) {
      const ref = await refOf(env, "auth_signup.set_password_email");
      if (ref && ref.model !== "mail.template") throw new NotPorted("auth_signup.set_password_email that is not a mail.template (logged, nothing sent)");
      internalTemplate = ref !== null;
    }
    if (users.some((u) => !internal.get(u.id))) {
      const ref = await refOf(env, "auth_signup.portal_set_password_email");
      if (ref && ref.model !== "mail.template") throw new NotPorted("auth_signup.portal_set_password_email that is not a mail.template (logged, nothing sent)");
      portalTemplate = ref !== null;
    }
  }
  let message: string | null = null;
  for (const u of users) {
    if (!u.email) {
      throw new UserError(translate(env, "Cannot send email: user %s has no email address.", "auth_signup").replace("%s", u.name ?? ""));
    }
    const template = (await isInternal(env, u.id)) ? internalTemplate : portalTemplate;
    if (!template) {
      // :226-248 the reset mail (auth_signup.reset_password_email): the template must exist (env.ref raises)
      if (!(await refOf(env, "auth_signup.reset_password_email"))) throw new NotPorted("auth_signup.reset_password_email missing (ValueError)");
    }
    await sendRolledBack(env, template);
    message = signupType === "reset"
      ? translate(env, "A reset password link was sent by email", "auth_signup")
      : translate(env, "Sign-up link sent by email!", "auth_signup");
  }
  if (message === null) throw new NotPorted("_action_reset_password of no users (UnboundLocalError)");
  return { type: "ir.actions.client", tag: "display_notification", params: { message, sticky: false } };
}

/** auth_signup res_users.py:146-155 `action_reset_password`. */
export async function actionResetPassword(env: Environment, ids: readonly number[]): Promise<Record<string, unknown> | null> {
  const flag = env.context["create_user"];
  try {
    return await actionResetPasswordCore(env, ids, flag === 1 || flag === true ? "signup" : "reset");
  } catch (e) {
    if (!(e instanceof MailDeliveryException)) throw e;
    throw new UserError(e.connectionRefused
      ? translate(env, "Could not contact the mail server, please check your outgoing email server configuration", "auth_signup")
      : translate(env, "There was an error when trying to deliver your Email, please check your configuration", "auth_signup"));
  }
}

/** auth_signup res_users.py:305-315 `create`: the users with an email invited to sign up, unless `no_reset_password`. */
export async function inviteCreatedUsers(env: Environment, ids: readonly number[]): Promise<void> {
  if (env.context["no_reset_password"]) return;
  const emails = new Map((await env.cr.query<{ id: number; email: string | null; partner_id: number }>(
    "SELECT u.id, p.email, u.partner_id FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = ANY($1::int[])", [[...ids]])).rows.map((r) => [r.id, r]));
  const withEmail = ids.filter((id) => emails.get(id)?.email);
  if (!withEmail.length) return;
  const cenv = env.withContext({ ...env.context, create_user: true });
  try {
    await actionResetPasswordCore(cenv, withEmail, "signup");
  } catch (e) {
    if (!(e instanceof MailDeliveryException)) throw e;
    // `users_with_email.partner_id.with_context(create_user=True).signup_cancel()` (res_partner.py:112-113)
    const partners = [...new Set(withEmail.map((id) => emails.get(id)!.partner_id))];
    await write(cenv, "res.partner", partners, { signup_type: false });
  }
}

/** res.users `_order` 'name, login' over ids (the name is the partner's). */
async function ordered(env: Environment, ids: readonly number[]): Promise<number[]> {
  if (!ids.length) return [];
  return env.withContext({ ...env.context, active_test: false }).model("res.users").search({ kind: "cond", path: "id", op: "in", value: [...ids] });
}

/** base_setup res_users.py:12-39 `web_create_users`. */
async function baseSetupWebCreateUsers(env: Environment, emails: readonly string[]): Promise<boolean> {
  const parse = (e: string): [string, string] => (!e || !e.trim() ? ["", ""] : parseContactFromEmail(e));
  const normalized = emails.map((e) => parse(e)[1]);
  // the archived users of these logins or addresses (`active_test=False`)
  const cands = (await env.cr.query<{ id: number }>(
    `SELECT u.id FROM res_users u JOIN res_partner p ON p.id = u.partner_id
      WHERE u.active IS NOT TRUE AND (u.login = ANY($1::text[]) OR p.email_normalized = ANY($2::text[]))`,
    [[...emails, ...normalized], normalized])).rows.map((r) => r.id);
  const deactivated = await ordered(env, cands);
  const aenv = env.withContext({ ...env.context, active_test: false });
  for (const id of deactivated) await write(aenv, "res.users", [id], { active: true });
  const info = (await env.cr.query<{ email: string | null; en: string | null }>(
    "SELECT p.email, p.email_normalized AS en FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = ANY($1::int[])", [deactivated])).rows;
  const done = new Set(info.map((r) => r.en).filter((x): x is string => Boolean(x)));
  const gone = new Set(info.map((r) => r.email).filter((x): x is string => Boolean(x)));
  const fresh = [...new Set(emails)].filter((e) => !gone.has(e));
  // `for email in new_emails`, a Python set: the order of several creations is the strings' hashes
  if (fresh.filter((e) => !done.has(parse(e)[1])).length > 1) throw new NotPorted("web_create_users of several new addresses (their order is a Python set's)");
  for (const email of fresh) {
    const [name, en] = parse(email);
    if (done.has(en)) continue;
    await create(env.withContext({ ...env.context, signup_valid: true }), "res.users", [{ login: en, name: name || en, email: en, active: true }]);
  }
  return true;
}

registerMethod("res.users", "web_create_users", async (env0, _ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const emails = kwargs["emails"] ?? args[0];
  if (!Array.isArray(emails) || emails.some((e) => typeof e !== "string")) throw new NotPorted("web_create_users of something else than a list of strings");
  // base_setup: email_normalized is a field when mail is installed
  if (!env.reg.model("res.users").fields.has("email_normalized")) throw new NotPorted("web_create_users without mail (UserError)");
  // auth_signup res_users.py:296-303: the invited users (`state` 'new': active, never logged in) of these logins or
  // addresses get their invitation again
  const cands = (await env.cr.query<{ id: number }>(
    `SELECT u.id FROM res_users u JOIN res_partner p ON p.id = u.partner_id
      WHERE u.active AND NOT EXISTS (SELECT 1 FROM res_users_log l WHERE l.create_uid = u.id)
        AND (u.login = ANY($1::text[]) OR p.email = ANY($1::text[]))`, [emails])).rows.map((r) => r.id);
  const inactive = cands.length ? await env.model("res.users").search({ kind: "cond", path: "id", op: "in", value: cands }) : [];
  const theirs = new Set((await env.cr.query<{ email: string | null }>(
    "SELECT p.email FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = ANY($1::int[])", [inactive])).rows.map((r) => r.email));
  // `list(new_emails)`, a set: its order only matters for the creations (refused below for several)
  const fresh = [...new Set(emails as string[])].filter((e) => !theirs.has(e));
  const res = await baseSetupWebCreateUsers(env, fresh);
  if (inactive.length) await actionResetPassword(env.withContext({ ...env.context, create_user: true }), inactive);
  return res;
}, { apiModel: true });

registerMethod("res.users", "action_reset_password", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  return actionResetPassword(env, ids ?? []);
}, { apiModel: false });

/** auth_signup res_users.py:157-170 `get_reset_password_link`. */
registerMethod("res.users", "get_reset_password_link", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  if ((ids ?? []).length !== 1) throw new NotPorted("get_reset_password_link of other than one user (ensure_one)");
  const id = ids![0]!;
  // `if not self.env.is_admin:` tests the bound method, always true: no check
  if (id === env.uid) throw new UserError(translate(env, "You cannot perform this action on your own user.", "auth_signup"));
  const u = (await env.cr.query<{ active: boolean | null; partner_id: number }>("SELECT active, partner_id FROM res_users WHERE id = $1", [id])).rows[0];
  if (!u) throw new NotPorted(`res.users ${id} that does not exist (MissingError)`);
  if (!u.active) throw new UserError(translate(env, "You cannot perform this action on an archived user.", "auth_signup"));
  await write(env, "res.partner", [u.partner_id], { signup_type: "reset" });
  return partnerSignupUrl(env, u.partner_id);
}, { apiModel: false });
