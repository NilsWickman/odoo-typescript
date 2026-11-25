/**
 * base_setup/controllers/main.py:10-51 `/base_setup/data` (the user counters of the Settings page), with auth_signup's
 * override (auth_signup/controllers/main.py:200-204: `resend_invitation`).
 */
import { AccessError, NotPorted } from "../errors";
import { isInstalled } from "../http/modules";
import { jsonRoute } from "../http/router";
import { translate } from "../models/util";
import { hasGroup } from "../orm/env";

jsonRoute("/base_setup/data", async (ctx) => {
  const env = await ctx.orm();
  if (!(await isInstalled(env.cr, "base_setup"))) throw new NotPorted("/base_setup/data without base_setup");
  if (!(await hasGroup(env, "base.group_erp_manager"))) throw new AccessError(translate(env, "Access Denied", "base_setup"));
  const active = (await env.cr.query<{ count: string }>("SELECT count(*)::text AS count FROM res_users WHERE active = true AND share = false")).rows[0]!;
  const pendingWhere = "active = true AND share = false AND NOT exists(SELECT 1 FROM res_users_log WHERE create_uid = u.id)";
  const pending = (await env.cr.query<{ count: string }>(`SELECT count(u.*)::text AS count FROM res_users u WHERE ${pendingWhere}`)).rows[0]!;
  const users = (await env.cr.query<{ id: number; login: string }>(`SELECT id, login FROM res_users u WHERE ${pendingWhere} ORDER BY id desc LIMIT 10`)).rows;
  // base res_users.py:1235-1245 `_action_show`
  const view = (await env.cr.query<{ res_id: number }>("SELECT res_id FROM ir_model_data WHERE module = 'base' AND name = 'view_users_form'")).rows[0]?.res_id;
  if (view === undefined) throw new NotPorted("base.view_users_form missing");
  const out: Record<string, unknown> = {
    active_users: Number(active.count),
    pending_count: Number(pending.count),
    pending_users: users.map((u) => [u.id, u.login]),
    action_pending_users: {
      type: "ir.actions.act_window", res_model: "res.users", context: { create: false }, name: translate(env, "Users", "base"),
      view_mode: "form", views: [[view, "form"]], domain: [["id", "in", users.map((u) => u.id)]],
    },
  };
  if (await isInstalled(env.cr, "auth_signup")) out["resend_invitation"] = true;
  return out;
}, { auth: "user" });
