/**
 * mail.activity.plan and its templates on the write path (the CRM "Activity Plans" configuration menu):
 * odoo/addons/mail/models/mail_activity_plan.py:35-58 and mail_activity_plan_template.py:89-121 record computes.
 */
import { registerRecordCompute, type Rec } from "../orm/recompute";
import { defineComputes } from "./tail_util";

const idOf = (v: unknown): number | null => (typeof v === "number" ? v : null);

registerRecordCompute("mail.activity.plan", {
  // :35-43 _compute_res_model_id (ir.model _get_id)
  res_model_id: async (env, rec) => {
    const model = await rec.get("res_model");
    if (typeof model !== "string" || !model) return null;
    return (await env.cr.query<{ id: number }>("SELECT id FROM ir_model WHERE model = $1", [model])).rows[0]?.id ?? null;
  },
});

// :49-52, :54-58 (non-stored: read side too)
defineComputes("mail.activity.plan", {
  steps_count: async (_env, rec) => (await rec.rels("template_ids")).length,
  has_user_on_demand: async (_env, rec) => {
    for (const t of await rec.rels("template_ids")) if ((await t.get("responsible_type")) === "on_demand") return true;
    return false;
  },
});

async function activityType(rec: Rec): Promise<Rec | null> {
  return rec.rel("activity_type_id");
}

registerRecordCompute("mail.activity.plan.template", {
  note: async (_env, rec) => { const t = await activityType(rec); return t ? t.get("default_note") : null; },
  responsible_id: async (_env, rec) => {
    const t = await activityType(rec);
    const v = t ? idOf(await t.get("default_user_id")) : null;
    return (await rec.get("responsible_type")) !== "other" && v ? null : v;
  },
  role_id: async (_env, rec) => {
    const t = await activityType(rec);
    const v = t ? idOf(await t.get("default_role_id")) : null;
    return (await rec.get("responsible_type")) !== "role" && v ? null : v;
  },
  responsible_type: async (_env, rec) => {
    const t = await activityType(rec);
    if (t && idOf(await t.get("default_user_id"))) return "other";
    if (t && idOf(await t.get("default_role_id"))) return "role";
    return "on_demand";
  },
  summary: async (_env, rec) => { const t = await activityType(rec); return t ? t.get("summary") : null; },
});
