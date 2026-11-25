/**
 * res.partner smart-button methods of the poc_erp apps: account `action_view_partner_invoices`
 * (account/models/partner.py:775-784), project `action_view_tasks` (project/models/res_partner.py:65-82) and calendar
 * `action_schedule_meeting` (calendar/models/res_partner.py:118-133 with `_compute_meeting` :49-79). The action dicts
 * come from `_for_xml_id` (the same dict as /web/action/load).
 */
import { NotPorted } from "../errors";
import { registerMethod } from "../http/methods";
import { cond } from "../orm/domain";
import { userInfo } from "../orm/env";
import type { Environment } from "../orm/types";
import { translate } from "./util";

const MODEL = "res.partner";

async function forXmlId(env: Environment, xmlid: string): Promise<Record<string, unknown>> {
  const { loadAction } = await import("../controllers/action");
  return loadAction({ cursor: () => env.cr, context: env.context, uid: env.uid }, xmlid);
}

function one(ids: number[] | null): number {
  if (!ids || ids.length !== 1) throw new NotPorted("res.partner smart button on several records (ensure_one)");
  return ids[0]!;
}

/** `self.with_context(active_test=False).search([('id', 'child_of', self.ids)])`, in the model's order. */
async function allChildren(env: Environment, id: number): Promise<number[]> {
  return env.withContext({ ...env.context, active_test: false }).model(MODEL).search(cond("id", "child_of", [id]), { activeTest: false });
}

registerMethod(MODEL, "action_view_partner_invoices", async (env, ids) => {
  const id = one(ids);
  const action = await forXmlId(env, "account.action_move_out_invoice_type");
  action["domain"] = [["move_type", "in", ["out_invoice", "out_refund"]], ["partner_id", "in", await allChildren(env, id)]];
  action["context"] = { default_move_type: "out_invoice", move_type: "out_invoice", journal_type: "sale", search_default_unpaid: 1, search_default_posted: 1 };
  return action;
}, { apiModel: false });

registerMethod(MODEL, "action_view_tasks", async (env, ids) => {
  const id = one(ids);
  const base = await forXmlId(env, "project.project_task_action_from_partner");
  const name = (await env.model(MODEL).read([id], ["name"], ""))[0]?.["name"];
  const action: Record<string, unknown> = {
    ...base,
    display_name: translate(env, "%(partner_name)s's Tasks").replace("%(partner_name)s", String(name || false)),
    context: { default_partner_id: id },
  };
  const children = await allChildren(env, id);
  const searchIds = [id, ...children.filter((c) => c !== id)];
  const taskCount = (await env.model(MODEL).read([id], ["task_count"], ""))[0]?.["task_count"];
  if (typeof taskCount === "number" && taskCount <= 1) {
    const task = await env.model("project.task").search(cond("partner_id", "in", searchIds), { limit: 1 });
    action["res_id"] = task[0] ?? false;
    const views = Array.isArray(action["views"]) ? (action["views"] as [unknown, string][]) : [];
    action["views"] = views.filter((v) => v[1] === "form");
  } else {
    action["domain"] = [["partner_id", "in", searchIds]];
  }
  return action;
}, { apiModel: false });

registerMethod(MODEL, "action_schedule_meeting", async (env, ids) => {
  const id = one(ids);
  const me = (await userInfo(env)).partnerId;
  const action = await forXmlId(env, "calendar.action_calendar_event");
  action["context"] = { default_partner_ids: [id, me], calendar_include_user_events: true };
  const vals = (await env.model(MODEL).read([id], ["meeting_next_date", "meeting_count"], ""))[0] ?? {};
  if (!vals["meeting_next_date"] && vals["meeting_count"]) {
    const views = Array.isArray(action["views"]) ? [...(action["views"] as [unknown, string][])] : [];
    action["views"] = [...views.filter((v) => v[1] === "list"), ...views.filter((v) => v[1] !== "list")];
  }
  // _compute_meeting()[self.id]: the valid events (as the user) of the partner and its descendants
  const all = await allChildren(env, id);
  const visible = await env.model("calendar.event").search(cond("res_model", "!=", "hr.leave"));
  const rows = (await env.cr.query<{ p: number; e: number }>(
    `SELECT res_partner_id AS p, calendar_event_id AS e FROM calendar_event_res_partner_rel
      WHERE res_partner_id = ANY($1::int[]) AND calendar_event_id = ANY($2::int[]) GROUP BY 1, 2`, [all, visible])).rows;
  const meetings = new Set<number>();
  if (rows.length) {
    const parents = new Map((await env.sudo().withContext({ ...env.context, active_test: false }).model(MODEL).read(all, ["parent_id"], ""))
      .map((r) => [Number(r["id"]), r["parent_id"]]));
    for (const r of rows) {
      // climb the parents inside `all_partners` until the requested partner
      let p: unknown = r.p;
      while (typeof p === "number" && p !== id) p = all.includes(p) ? parents.get(p) : null;
      if (p === id) meetings.add(r.e);
    }
  }
  // list(set(...)) of small ints iterates in ascending order
  action["domain"] = ["&", ["res_model", "!=", "hr.leave"], "|", ["id", "in", [...meetings].sort((a, b) => a - b)], ["partner_ids", "in", [id]]];
  return action;
}, { apiModel: false });
