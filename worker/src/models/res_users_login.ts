/**
 * The write side of `res.users._login` (odoo/odoo/addons/base/models/res_users.py:856-884): on a first login (no
 * `login_date`) or without a time zone, the browser's `tz` cookie is written on the user (`user.tz = tz`, as the
 * user itself in sudo, :865 `user.with_user(user).sudo()`), then `_update_last_login` (:839-843) creates the
 * res.users.log row. mail tracks the write (mail_track_mixin.py:29 `_track_prepare`) and finalizes at precommit,
 * after the log row exists, so a first login logs "Invited -> Confirmed (Status)" (auth_signup res_users.py:24-41,
 * `state` tracking=4). The port's tracking finalizes at the outermost write (src/mail/WRITE_HOOKS.md), so the
 * snapshot is opened around both steps here to keep Odoo's precommit order.
 */
import type { Cursor } from "../db";
import { trackFinalize, trackPrepare } from "../mail/tracking";
import { createEnvironment } from "../orm/env";
import { write } from "../orm/write";

/** `tz in all_timezones` (date_utils.py:24-32): the keys of the `tz` selection (res_partner.py:131-134). */
export async function isKnownTimezone(cr: Cursor, tz: string): Promise<boolean> {
  const r = await cr.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ir_model_fields_selection s JOIN ir_model_fields f ON f.id = s.field_id
      WHERE f.model = 'res.partner' AND f.name = 'tz' AND s.value = $1`, [tz]);
  return (r.rows[0]?.n ?? 0) > 0;
}

/** `user.login_date` (related `log_ids.create_date`, res_users.py:222): whether the user has a res.users.log row. */
export async function hasLoggedIn(cr: Cursor, uid: number): Promise<boolean> {
  const r = await cr.query<{ n: number }>("SELECT count(*)::int AS n FROM res_users_log WHERE create_uid = $1", [uid]);
  return (r.rows[0]?.n ?? 0) > 0;
}

/** res_users.py:874-877: `user.tz = tz` then `_update_last_login()` (given as `updateLastLogin`). */
export async function writeLoginTz(cr: Cursor, uid: number, tz: string, updateLastLogin: () => Promise<void>): Promise<void> {
  const env = await createEnvironment({ cr, uid, su: true, context: {} });
  await trackPrepare(env, "res.users", [uid]);
  await write(env, "res.users", [uid], { tz });
  await updateLastLogin();
  await trackFinalize(env, "res.users");
}
