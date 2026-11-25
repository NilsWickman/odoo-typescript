/**
 * Duplicating a user (Settings -> Users -> Duplicate) and the res.users create it runs. The Python MRO of `create`,
 * outermost first (gen/out/poc_erp/write_overrides.json):
 *   - project res_users.py:20-24, project_todo res_users.py:55-80: the personal stages of the internal users, then their
 *     onboarding to-do (as superuser, `mail_auto_subscribe_no_notify`);
 *   - digest res_users.py: internal users subscribed to the default digest (`digest.default_digest_emails`);
 *   - calendar res_users.py:80-84 `_generate_primary_calendar` (:45-60) of the internal users;
 *   - auth_signup res_users.py: the signup invitation unless `no_reset_password` (src/models/res_users_invite.ts: the
 *     mail fails at the connection and is rolled back, the signup is cancelled);
 *   - discuss res_users.py: `_subscribe_users_automatically` of the channels of the users' groups;
 *   - mail res_users.py: the portal access log of portal users (refused);
 *   - mail.thread (src/mail/write_hooks.ts: followers, "User created");
 *   - base UsersMultiCompany (nothing on create) and ResUsers :664-680 (the settings of internal users, the partner's
 *     company and active, the generated avatar of internal users without image).
 * `copy` (auth_signup res_users.py:328-332) sets `no_reset_password` unless the default gives an email; `copy_data`
 * (base res_users.py:781-789) names the copy "<name> (copy)" and "<login> (copy)".
 */
import { NotPorted } from "../errors";
import { registerMethod } from "../http/methods";
import { envFor } from "../web/common";
import { create, HOOKS_INSIDE } from "../orm/create";
import { registerOverrides, write } from "../orm/write";
import { deferredFlush } from "../orm/recompute";
import { impliedGroups } from "../orm/env";
import type { Environment } from "../orm/types";
import { copy } from "../web/save";
import { configParam } from "./tail_util";
import { avatarSeed, generateAvatarSvg } from "./avatar";
import { translateLang } from "./util";
import { loadTemplates } from "../qweb/templates";
import { render } from "../qweb/render";
import { PyRecords } from "../qweb/records";
import { inviteCreatedUsers } from "./res_users_invite";

const SUPERUSER_ID = 1;

/** translate.py `_("%s (copy)", v)`: only English is ported here. */
function markCopy(env: Environment, value: unknown): string {
  if (env.lang && env.lang !== "en_US") throw new NotPorted(`res.users copy name in ${env.lang}`);
  return `${String(value)} (copy)`;
}

registerOverrides("res.users", {
  // base res_users.py:781-789
  copyData: async (env, ids, valsList, given) => {
    const rows = new Map((await env.cr.query<{ id: number; login: string; name: string | null }>(
      "SELECT u.id, u.login, p.name FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = ANY($1::int[])", [[...ids]])).rows.map((r) => [r.id, r]));
    for (let i = 0; i < ids.length; i++) {
      const user = rows.get(ids[i]!)!;
      if (!("name" in given) && !("partner_id" in given)) valsList[i]!["name"] = markCopy(env, user.name ?? "");
      if (!("login" in given)) valsList[i]!["login"] = markCopy(env, user.login);
    }
  },
  create: async (env, valsList, next) => {
    const ids = await next(env, valsList);
    await baseAfterCreate(env, ids);
    await refusePortalLog(env, ids);
    await subscribeUsersAutomatically(env, ids);
    await inviteCreatedUsers(env, ids);
    const internal = await internalUsers(env, ids);
    await generatePrimaryCalendar(env, internal);
    await subscribeDefaultDigest(env, internal);
    await onboardIntoProject(env, internal);
    return ids;
  },
});

// the mail.thread steps ("User created", the followers) come inside base's create, before the modules' records
HOOKS_INSIDE.add("res.users");

/** The users among `ids` that are not share users, in the order of `ids` (`users.filtered(lambda u: not u.share)`). */
async function internalUsers(env: Environment, ids: readonly number[]): Promise<number[]> {
  const share = new Map((await env.cr.query<{ id: number; share: boolean | null }>("SELECT id, share FROM res_users WHERE id = ANY($1::int[])", [[...ids]])).rows.map((r) => [r.id, r.share]));
  return ids.filter((id) => !share.get(id));
}

/** base res_users.py:664-680, after super().create. */
async function baseAfterCreate(env: Environment, ids: readonly number[]): Promise<void> {
  const settings: Record<string, unknown>[] = [];
  const userGroup = await env.reg.xmlid(env.cr, "base.group_user");
  for (const id of ids) {
    const u = (await env.cr.query<{ partner_id: number; company_id: number | null; active: boolean | null; share: boolean | null;
      p_company: number | null; p_active: boolean | null; name: string | null }>(
      `SELECT u.partner_id, u.company_id, u.active, u.share, p.company_id AS p_company, p.active AS p_active, p.name
         FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1`, [id])).rows[0]!;
    // :668-669 `_is_internal()`: base.group_user among the user's groups (all_group_ids)
    const direct = (await env.cr.query<{ gid: number }>("SELECT gid FROM res_groups_users_rel WHERE uid = $1", [id])).rows.map((r) => r.gid);
    const implied = await impliedGroups(env);
    const all = new Set<number>(direct);
    for (const g of direct) for (const x of implied.get(g) ?? []) all.add(x);
    const hasSettings = (await env.cr.query("SELECT 1 FROM res_users_settings WHERE user_id = $1", [id])).rows.length > 0;
    if (!hasSettings && userGroup !== null && all.has(userGroup)) settings.push({ user_id: id });
    // :671-673 a partner of a company follows the user's company; the partner is as active as the user
    if (u.p_company !== null && u.p_company !== u.company_id) await write(env, "res.partner", [u.partner_id], { company_id: u.company_id ?? false });
    if (Boolean(u.p_active) !== Boolean(u.active)) await write(env, "res.partner", [u.partner_id], { active: Boolean(u.active) });
    // :675-676 the initials avatar of an internal user without image
    const image = (await env.cr.query("SELECT 1 FROM ir_attachment WHERE res_model = 'res.partner' AND res_field = 'image_1920' AND res_id = $1", [u.partner_id])).rows.length > 0;
    if (!image && !u.share && u.name) {
      await write(env, "res.users", [id], { image_1920: await partnerAvatarSvgBase64(env, u.partner_id) });
    }
  }
  if (settings.length) await create(env.sudo(), "res.users.settings", settings);
}

/** mail res_users.py create: a portal user's access is logged on the user (not ported). */
async function refusePortalLog(env: Environment, ids: readonly number[]): Promise<void> {
  if (env.context["mail_create_nolog"] || env.context["mail_notrack"]) return;
  const portal = await env.reg.xmlid(env.cr, "base.group_portal");
  if (portal === null) return;
  const implied = await impliedGroups(env);
  for (const id of ids) {
    const direct = (await env.cr.query<{ gid: number }>("SELECT gid FROM res_groups_users_rel WHERE uid = $1", [id])).rows.map((r) => r.gid);
    if (direct.includes(portal) || direct.some((g) => (implied.get(g) ?? []).includes(portal))) {
      throw new NotPorted("res.users create of a portal user (mail res_users.py portal access log)");
    }
  }
}

/**
 * discuss res_users.py create and discuss_channel.py:831-856 `_subscribe_users_automatically`: the channels with a
 * group among the users' groups get as members (sudo) the active partners of their groups' users who are not members.
 * The member's Store goes to the partner's bus (`_get_member_store_list`): the new users' partners, which no session
 * listens to; a partner with other users, a chat or group channel (named after members), or a sub-channel refuses.
 */
async function subscribeUsersAutomatically(env: Environment, ids: readonly number[]): Promise<void> {
  const implied = await impliedGroups(env);
  const groupsOf = async (uid: number): Promise<Set<number>> => {
    const direct = (await env.cr.query<{ gid: number }>("SELECT gid FROM res_groups_users_rel WHERE uid = $1", [uid])).rows.map((r) => r.gid);
    const all = new Set<number>(direct);
    for (const g of direct) for (const x of implied.get(g) ?? []) all.add(x);
    return all;
  };
  const mine = new Set<number>();
  for (const id of ids) for (const g of await groupsOf(id)) mine.add(g);
  if (!mine.size) return;
  // `search([("group_ids", "in", ...)])`: discuss.channel has no `_order` (id)
  const channels = (await env.cr.query<{ id: number; channel_type: string | null; parent: number | null }>(
    `SELECT c.id, c.channel_type, c.parent_channel_id AS parent FROM discuss_channel c
      WHERE EXISTS (SELECT 1 FROM discuss_channel_res_groups_rel r WHERE r.discuss_channel_id = c.id AND r.res_groups_id = ANY($1::int[]))
      ORDER BY c.id`, [[...mine]])).rows;
  if (!channels.length) return;
  const ordered = channels.map((c) => c.id);
  // `all_user_ids` is computed with active_test=False (res_groups.py:313-315), but reading the many2many in the
  // caller's environment drops the archived users (fields_relational.py:720-724): an archived user's partner, active
  // and no longer a member (discuss unsubscribes it on archiving), does not join
  const activeTest = env.context["active_test"] === undefined || !!env.context["active_test"];
  const users = (await env.cr.query<{ id: number; partner_id: number }>(
    `SELECT id, partner_id FROM res_users${activeTest ? " WHERE active" : ""}`)).rows;
  const toCreate: { channel_id: number; partner_id: number }[] = [];
  for (const cid of ordered) {
    const c = channels.find((x) => x.id === cid)!;
    if (c.channel_type !== "channel" || c.parent !== null) throw new NotPorted(`discuss.channel ${c.id} auto-subscription of a ${c.channel_type} or sub-channel`);
    const cgroups = (await env.cr.query<{ g: number }>("SELECT res_groups_id AS g FROM discuss_channel_res_groups_rel WHERE discuss_channel_id = $1", [c.id])).rows.map((r) => r.g);
    // `channel.group_ids.all_user_ids.partner_id`: the partners of the users having one of the groups (implied
    // included), the active ones, minus the members
    const partners = new Set<number>();
    for (const u of users) {
      const gs = await groupsOf(u.id);
      if (cgroups.some((g) => gs.has(g))) partners.add(u.partner_id);
    }
    const members = new Set((await env.cr.query<{ p: number }>("SELECT partner_id AS p FROM discuss_channel_member WHERE channel_id = $1 AND partner_id IS NOT NULL", [c.id])).rows.map((r) => r.p));
    const active = (await env.cr.query<{ id: number }>("SELECT id FROM res_partner WHERE id = ANY($1::int[]) AND active ORDER BY id", [[...partners]])).rows.map((r) => r.id);
    const joining = active.filter((p) => !members.has(p));
    // their order is the union of the groups' `all_implied_by_ids.user_ids` (res.users `_order` per group): not
    // ported, so a channel that several partners would join refuses
    if (joining.length > 1) throw new NotPorted(`discuss.channel ${c.id} auto-subscription of several partners (their order)`);
    for (const p of joining) toCreate.push({ channel_id: c.id, partner_id: p });
  }
  if (!toCreate.length) return;
  const newPartners = new Set((await env.cr.query<{ p: number }>("SELECT partner_id AS p FROM res_users WHERE id = ANY($1::int[])", [[...ids]])).rows.map((r) => r.p));
  for (const m of toCreate) {
    if (!newPartners.has(m.partner_id)) throw new NotPorted(`discuss.channel ${m.channel_id} would auto-subscribe an existing user's partner ${m.partner_id}`);
    const others = (await env.cr.query("SELECT 1 FROM res_users WHERE partner_id = $1 AND NOT (id = ANY($2::int[])) LIMIT 1", [m.partner_id, [...ids]])).rows;
    if (others.length) throw new NotPorted(`discuss.channel member of partner ${m.partner_id} with other users (its Store to their bus)`);
  }
  await create(env.sudo(), "discuss.channel.member", toCreate);
}

/** calendar res_users.py:45-60 `_generate_primary_calendar` (sudo), one calendar per user with its owner. */
async function generatePrimaryCalendar(env: Environment, ids: readonly number[]): Promise<void> {
  if (!ids.length) return;
  const privacy = (await configParam(env.sudo(), "calendar.default_privacy")) ?? "public";
  const names = await env.model("res.users").displayName(ids);
  await create(env.sudo(), "calendar.calendar", ids.map((id) => ({
    name: names.get(id) ?? false,
    calendar_default_privacy: privacy,
    calendar_user_ids: [[0, 0, { user_id: id, is_primary: true, access_role: "owner", is_filter_active: true, is_filter_checked: true, name: names.get(id) ?? false }]],
  })));
}

/** digest res_users.py create: the internal users subscribed to the default digest when the setting is on. */
async function subscribeDefaultDigest(env: Environment, ids: readonly number[]): Promise<void> {
  if (!ids.length) return;
  // ir_config_parameter.py get_bool / get_int
  const emails = await configParam(env.sudo(), "digest.default_digest_emails");
  const digestRaw = await configParam(env.sudo(), "digest.default_digest_id");
  if (emails === null || digestRaw === null) return;
  if (emails !== "True" && emails !== "False") throw new NotPorted(`digest.default_digest_emails = ${emails}`);
  if (!/^\d+$/.test(digestRaw)) throw new NotPorted(`digest.default_digest_id = ${digestRaw}`);
  const digest = Number(digestRaw);
  if (emails !== "True" || !digest) return;
  if (!(await env.cr.query("SELECT 1 FROM digest_digest WHERE id = $1", [digest])).rows.length) return;
  // `users_to_subscribe.digest_ids |= digest`: a write of each user's digests
  await write(env.sudo(), "res.users", ids, { digest_ids: [[4, digest]] });
}

/** project res_users.py:26-38 `_onboard_users_into_project`, project_todo res_users.py:55-80. */
async function onboardIntoProject(env: Environment, ids: readonly number[]): Promise<void> {
  if (!ids.length) return;
  const vals: Record<string, unknown>[] = [];
  for (const id of ids) vals.push(...await personalStageVals(env, id));
  if (vals.length) {
    const { default_project_id: _drop, ...ctx } = env.context;
    await create(env.sudo().withContext({ ...ctx, default_project_id: false }), "project.task.type", vals);
  }
  await generateOnboardingTodo(env, ids);
}

/** avatar_mixin.py:78-87 `_avatar_generate_svg` of the partner (its name and create_date), in base64. */
async function partnerAvatarSvgBase64(env: Environment, partner: number): Promise<string> {
  const p = (await env.cr.query<{ name: string | null; cd: string | null }>(
    "SELECT name, create_date::text AS cd FROM res_partner WHERE id = $1", [partner])).rows[0]!;
  const name = p.name ?? "";
  const fraction = p.cd?.split(".")[1] ?? "0";
  const svg = generateAvatarSvg(name, avatarSeed(name, p.cd ? new Date(`${p.cd.slice(0, 19).replace(" ", "T")}Z`) : null, Number(fraction.padEnd(6, "0"))));
  return Buffer.from(await svg.content()).toString("base64");
}

/** project_task.py:481-490 `_get_default_personal_stage_create_vals` in the user's language. */
async function personalStageVals(env: Environment, user: number): Promise<Record<string, unknown>[]> {
  const lang = (await env.cr.query<{ lang: string | null }>("SELECT p.lang FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1", [user])).rows[0]?.lang ?? null;
  const t = (s: string): string => translateLang(lang, s, "project");
  return [
    { sequence: 1, name: t("Inbox"), user_id: user, fold: false },
    { sequence: 2, name: t("Today"), user_id: user, fold: false },
    { sequence: 3, name: t("This Week"), user_id: user, fold: false },
    { sequence: 4, name: t("This Month"), user_id: user, fold: false },
    { sequence: 5, name: t("Later"), user_id: user, fold: false },
    { sequence: 6, name: t("Done"), user_id: user, fold: true },
    { sequence: 7, name: t("Cancelled"), user_id: user, fold: true },
  ];
}

/**
 * project_todo res_users.py:61-80 `_generate_onboarding_todo`: `project_todo.todo_user_onboarding` rendered for each
 * user in their language (else the current user's), a private task "Welcome <name>!" assigned to them, created as the
 * superuser with `mail_auto_subscribe_no_notify`.
 */
async function generateOnboardingTodo(env: Environment, ids: readonly number[]): Promise<void> {
  const view = await env.reg.xmlid(env.cr, "project_todo.todo_user_onboarding");
  if (view === null) return; // raise_if_not_found=False: no body, no to-do
  const mine = (await env.cr.query<{ lang: string | null }>("SELECT p.lang FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1", [env.uid])).rows[0]?.lang ?? null;
  const vals: Record<string, unknown>[] = [];
  for (const id of ids) {
    const u = (await env.cr.query<{ lang: string | null; name: string | null }>("SELECT p.lang, p.name FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1", [id])).rows[0]!;
    const lang = u.lang || mine || "en_US";
    const langEnv = env.withContext({ ...env.context, lang });
    const templates = await loadTemplates(env.cr, "project_todo.todo_user_onboarding", { lang });
    // minimal_qcontext: only the given values
    const body = await render(templates, "project_todo.todo_user_onboarding", new Map<string, unknown>([["object", new PyRecords(langEnv, "res.users", [id])]]), { lang });
    if (!body) continue;
    vals.push({ user_ids: [id], description: body, name: translateLang(lang, "Welcome %s!", "project_todo").replace("%s", u.name ?? "") });
  }
  if (!vals.length) return;
  const su = env.withUser(SUPERUSER_ID).sudo(); // api.py Environment: uid 1 is the superuser (su=True)
  // the to-do's stored computes left dirty by the superuser's create are flushed later by the request's user, whose
  // uid `_write_multi` writes (models.py:4008-4011): measured, the to-do's write_uid is the duplicating user
  await deferredFlush(env, env.uid, () => create(su.withContext({ ...su.context, mail_auto_subscribe_no_notify: true }), "project.task", vals));
}

/** auth_signup res_users.py:328-332 copy over models.py copy. */
registerMethod("res.users", "copy", async (env0, ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const dflt = kwargs["default"] ?? args[0];
  if (dflt !== undefined && dflt !== null && dflt !== false && (typeof dflt !== "object" || Array.isArray(dflt))) throw new NotPorted("copy default");
  const given = (dflt && typeof dflt === "object" ? dflt : {}) as Record<string, unknown>;
  const copyEnv = !given["email"] ? env.withContext({ ...env.context, no_reset_password: true }) : env;
  return copy(copyEnv, "res.users", ids ?? [], given, true);
}, { apiModel: false });
