/**
 * Deleting a user (Settings -> Users -> Delete). The Python MRO of res.users `unlink`, outermost first
 * (gen/out/poc_erp/write_overrides.json):
 *   - calendar res_users.py:86-90: the user's calendar memberships as superuser (calendar.user unlink,
 *     calendar_user.py:42-46: the calendars of which they were the last members go too);
 *   - discuss res_users.py:31-33 `_unsubscribe_from_non_public_channels` (:35-52);
 *   - rating and mail.thread (src/mail/write_hooks.ts: the users' messages, followers and activities);
 *   - BaseModel.unlink: check_access, then the `@api.ondelete` methods in name order (`getmembers`):
 *     auth_signup res_users.py:322-326 `_ondelete_signup_cancel` and base res_users.py:745-757
 *     `_unlink_except_master_data`; the DELETE (the database's cascades and set nulls).
 * Every error rolls the request back, so the access check and the protected users are checked first here: the steps
 * Odoo runs before them only delete, and the port could refuse in them where Odoo reaches the error.
 */
import { AccessError, NotPorted, UserError } from "../errors";
import { translateLang } from "./util";
import { userInfoOf } from "../orm/env";
import { checkUnlinkAccess, unlink } from "../orm/unlink";
import { registerOverrides, write } from "../orm/write";
import type { Environment } from "../orm/types";
import { unlinkMembers } from "../mail/channel_write";
import { withStoreVersionAtEnd } from "../mail/busnotify";
import { requestOfCursor } from "../http/context";

const SUPERUSER_ID = 1;

/** base res_users.py:745-757 `_unlink_except_master_data`. */
async function exceptMasterData(env: Environment, ids: readonly number[]): Promise<void> {
  const ref = (x: string): Promise<number | false | null> => env.reg.xmlid(env.cr, x) as Promise<number | false | null>;
  const message = (m: string): string => {
    if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated res.users unlink error (${env.lang})`);
    return m;
  };
  const portalTemplate = await ref("base.template_portal_user_id");
  const publicUser = await ref("base.public_user");
  if (ids.includes(SUPERUSER_ID)) {
    throw new UserError(message("You can not remove the admin user as it is used internally for resources created by Odoo (updates, module installation, ...)"));
  }
  const admin = await ref("base.user_admin");
  if (typeof admin === "number" && ids.includes(admin)) {
    throw new UserError(message("You cannot delete the admin user because it is utilized in various places (such as security configurations,...). Instead, archive it."));
  }
  if (typeof portalTemplate === "number" && ids.includes(portalTemplate)) {
    throw new UserError(message("Deleting the template users is not allowed. Deleting this profile will compromise critical functionalities."));
  }
  if (typeof publicUser === "number" && ids.includes(publicUser)) {
    throw new UserError(message("Deleting the public user is not allowed. Deleting this profile will compromise critical functionalities."));
  }
}

/**
 * calendar_user.py:42-46 calendar.user unlink: the calendars all of whose members are deleted go after them, as
 * superuser (calendar_calendar.py:135-143: their events and recurrences first, refused by the guard when there are any;
 * `_unlink_except_primary` reads the calendars' members after the delete, so the deleted primary ones do not count).
 */
export async function unlinkCalendarUsers(env: Environment, ids: readonly number[], next: (env: Environment, ids: readonly number[]) => Promise<void>): Promise<void> {
  if (!ids.length) return;
  const calendars = (await env.cr.query<{ id: number }>(
    `SELECT DISTINCT c.calendar_id AS id FROM calendar_user c WHERE c.id = ANY($1::int[])
        AND NOT EXISTS (SELECT 1 FROM calendar_user o WHERE o.calendar_id = c.calendar_id AND NOT (o.id = ANY($1::int[])))
      ORDER BY 1`, [[...ids]])).rows.map((r) => r.id);
  await next(env, ids);
  if (!calendars.length) return;
  const su = env.sudo();
  const { guardOverride } = await import("../orm/override_guard");
  await guardOverride(su, "calendar.calendar", "unlink", calendars, []);
  await unlink(su, "calendar.calendar", calendars);
}

/**
 * discuss res_users.py:35-52 `_unsubscribe_from_non_public_channels` (without reset_role): the members by which the
 * users' partners leave the group-restricted channels (channel_type 'channel') whose group none of the partner's other active users has
 * (`all_group_ids`), as superuser, members in discuss.channel.member's `_order` (id).
 */
export async function nonPublicMembers(env: Environment, ids: readonly number[]): Promise<number[]> {
  const members = (await env.cr.query<{ id: number; partner_id: number; group: number }>(
    `SELECT m.id, m.partner_id, c.group_public_id AS group FROM discuss_channel_member m JOIN discuss_channel c ON c.id = m.channel_id
      WHERE m.partner_id IN (SELECT partner_id FROM res_users WHERE id = ANY($1::int[]))
        AND c.channel_type = 'channel' AND c.group_public_id IS NOT NULL ORDER BY m.id`, [[...ids]])).rows;
  const leave: number[] = [];
  for (const m of members) {
    const others = (await env.cr.query<{ id: number }>("SELECT id FROM res_users WHERE partner_id = $1 AND active AND NOT (id = ANY($2::int[])) ORDER BY id", [m.partner_id, [...ids]])).rows;
    let kept = false;
    for (const o of others) if ((await userInfoOf(env, o.id)).groupIds.includes(m.group)) { kept = true; break; }
    if (!kept) leave.push(m.id);
  }
  return leave;
}

registerOverrides("res.users", {
  unlink: async (env, ids, next) => {
    await checkUnlinkAccess(env, env.reg.model("res.users"), ids); // models.py:3666
    await exceptMasterData(env, ids);
    const steps = async (): Promise<void> => {
      if (env.reg.models.has("calendar.user")) {
        // `self.calendar_user_ids.sudo().unlink()` (One2many in calendar.user's `_order`, id)
        const cu = (await env.cr.query<{ id: number }>("SELECT id FROM calendar_user WHERE user_id = ANY($1::int[]) ORDER BY id", [[...ids]])).rows.map((r) => r.id);
        if (cu.length) await unlink(env.sudo(), "calendar.user", cu);
      }
      await unlinkMembers(env.sudo(), leave);
      await next(env, ids);
    };
    // (the calendar step does not change the memberships)
    const leave = await nonPublicMembers(env, ids);
    if (!leave.length) return steps();
    // the members' Stores carry the version Odoo formats at precommit: the fields the whole unlink wrote
    const ctx = requestOfCursor(env.cr);
    if (!ctx) throw new NotPorted("res.users unlink leaving channels outside a request");
    await withStoreVersionAtEnd(ctx, env, steps);
  },
  beforeUnlink: async (env, ids) => {
    // auth_signup `_ondelete_signup_cancel`: `user.partner_id.signup_cancel()` (res_partner.py:112-113) per user
    if (env.reg.model("res.partner").fields.has("signup_type")) {
      const partners = (await env.cr.query<{ partner_id: number | null }>(
        "SELECT partner_id FROM res_users WHERE id = ANY($1::int[]) ORDER BY array_position($1::int[], id)", [[...ids]])).rows;
      // (fields.py `_filter_not_equal`: an empty signup_type stays clean, the write still logs write_date)
      for (const p of partners) {
        if (p.partner_id === null) continue;
        const cur = (await env.cr.query<{ t: string | null }>("SELECT signup_type AS t FROM res_partner WHERE id = $1", [p.partner_id])).rows[0]?.t ?? null;
        await write(env, "res.partner", [p.partner_id], cur === null ? {} : { signup_type: false });
      }
    }
    await exceptMasterData(env, ids);
  },
});

// calendar_user.py:35-40 write: outside the writeable fields (`_get_writeable_fields` :48-50: the side panel's filter
// fields and the label) only the superuser writes; the user's AccessError names the fields in the values' order
const CALENDAR_USER_WRITEABLE = new Set(["is_filter_active", "is_filter_checked", "filter_color", "name"]);

registerOverrides("calendar.user", {
  unlink: (env, ids, next) => unlinkCalendarUsers(env, ids, next),
  write: async (env, ids, vals, next) => {
    const blacklisted = Object.keys(vals).filter((k) => !CALENDAR_USER_WRITEABLE.has(k));
    if (blacklisted.length && !env.su) {
      throw new AccessError(translateLang(env.lang ?? "en_US", "These fields cannot be modified: %(fields)s", "calendar").replace("%(fields)s", () => blacklisted.join(", ")));
    }
    await next(env, ids, vals);
  },
});
