/**
 * mail.canned.response, mail.activity.type and mail.activity.plan computes and callable selections
 * (odoo/addons/mail/models/mail_canned_response.py, mail_activity_type.py, mail_activity_plan.py).
 */
import { cond } from "../orm/domain";
import { hooksOf, registerHooks } from "../orm/hooks";
import { registerRecordCompute } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { canCreate, defineComputes, filteredAccess, registerDefaultValued } from "./tail_util";

defineComputes("mail.canned.response", {
  // mail_canned_response.py:52-59 _compute_is_editable: creating records need create access, others write access
  is_editable: async (env, rec) => {
    if (rec.id === null) return canCreate(env, "mail.canned.response");
    return (await filteredAccess(env, "mail.canned.response", [rec.id], "write")).has(rec.id);
  },
});
registerRecordCompute("mail.canned.response", {
  // mail_canned_response.py:46-50 _compute_is_shared (stored, compute_sudo): bool(group_ids)
  is_shared: async (_env, rec) => (await rec.rels("group_ids")).length > 0,
});

/**
 * `ir.model.sudo().search(domain)` as (model, name) in mail's ir.model `_order` (mail/models/ir_model.py:10
 * `is_mail_thread DESC, name ASC`, name in env.lang).
 */
async function irModels(env: Environment, flag: "is_mail_thread" | "is_mail_activity"): Promise<readonly [string, string][]> {
  const lang = env.lang ?? "en_US";
  const rows = await env.cr.query<{ model: string; name: string }>(
    `SELECT model, COALESCE(name->>$1, name->>'en_US') AS name FROM ir_model WHERE ${flag} IS TRUE AND transient IS NOT TRUE
     ORDER BY is_mail_thread DESC, COALESCE(name->>$1, name->>'en_US') ASC`, [lang]);
  return rows.rows.map((r) => [r.model, r.name] as [string, string]);
}

// mail_activity_type.py:20-25 _get_model_selection: mail.thread models, not transient
const activityTypeModels = (env: Environment): Promise<readonly [string, string][]> => irModels(env, "is_mail_thread");
registerHooks("mail.activity.type", { selection: { res_model: activityTypeModels, initial_res_model: activityTypeModels } });
// mail_activity_plan.py:11-16 _get_model_selection: mail.activity.mixin models, not transient
registerHooks("mail.activity.plan", { selection: { res_model: (env) => irModels(env, "is_mail_activity") } });

defineComputes("mail.activity.type", {
  // mail_activity_type.py:98-104 _compute_delay_label: "<delay_count> <translated delay_unit label>"
  delay_label: async (env, rec) => {
    const unit = await rec.get("delay_unit");
    const sel = env.reg.model("mail.activity.type").fields.get("delay_unit")?.selection ?? [];
    const lang = env.lang ?? "en_US";
    const entry = sel.find((s) => s.value === unit);
    // `selection_description_values[unit]` raises KeyError for an empty unit (required field)
    if (!entry) throw new Error(`KeyError: ${String(unit)}`);
    return `${String(await rec.get("delay_count"))} ${entry.labels[lang] ?? entry.label}`;
  },
  // mail_activity_type.py:93-96 _compute_initial_res_model
  initial_res_model: async (_env, rec) => rec.get("res_model"),
});
registerDefaultValued("mail.activity.type", "res_model_change"); // mail_activity_type.py:82 store=False, default=False

/**
 * `env.user.all_group_ids.ids` in recordset order (base res_users.py:486-488 `group_ids.all_implied_ids`, mapped over
 * the user's groups in res.groups `_order`; res_groups.py:342-346 each group then its implied groups sorted by id,
 * odoo/tools/set_expression.py:168-180).
 */
async function allGroupIdsOrdered(env: Environment): Promise<number[]> {
  const direct = (await env.cr.query<{ gid: number }>("SELECT gid FROM res_groups_users_rel WHERE uid = $1", [env.uid])).rows.map((r) => r.gid);
  if (direct.length === 0) return [];
  const ordered = await env.sudo().withContext({ ...env.context, active_test: false }).model("res.groups")
    .search(cond("id", "in", direct), { order: "privilege_id, sequence, name, id", activeTest: false });
  const out: number[] = [];
  for (const g of ordered) {
    const implied = (await env.cr.query<{ id: number }>(
      `WITH RECURSIVE c(id) AS (SELECT hid FROM res_groups_implied_rel WHERE gid = $1
         UNION SELECT r.hid FROM res_groups_implied_rel r JOIN c ON r.gid = c.id) SELECT id FROM c WHERE id != $1 ORDER BY id`, [g])).rows.map((r) => r.id);
    for (const id of [g, ...implied]) if (!out.includes(id)) out.push(id);
  }
  return out;
}
registerHooks("mail.canned.response", {
  descriptionDomain: {
    ...hooksOf("mail.canned.response").descriptionDomain,
    // mail_canned_response.py:31-35 group_ids domain=lambda self: [("id", "in", self.env.user.all_group_ids.ids)]
    group_ids: async (env) => [["id", "in", await allGroupIdsOrdered(env)]],
  },
});
