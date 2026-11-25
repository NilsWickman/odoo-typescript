/**
 * project.milestone's computes (odoo/addons/project/models/project_milestone.py:36-95) with sale_project's
 * (sale_project/models/project_milestone.py:39-52). Before round 11 none was ported, so a milestone could neither be
 * created nor read. Tasks are counted through the ORM as the user (`_read_group`), CLOSED_STATES as project_task.py.
 */
import { and, cond } from "../orm/domain";
import type { Environment } from "../orm/types";
import type { Rec } from "../orm/recompute";
import { plainNumber } from "../orm/values";
import { contextToday } from "./account_computes";
import { defineComputes } from "./tail_util";
import { milestoneCanBeDone, milestoneDeadlineExceeded } from "./project_computes";

const CLOSED_STATES = ["1_done", "1_canceled"];
const m2o = (v: unknown): number | null => (typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : null);

/** The states of the tasks of the milestone the user can read, with an extra condition. */
async function taskStates(env: Environment, milestone: number, extra: boolean): Promise<string[]> {
  const domain = [cond("milestone_id", "in", [milestone])];
  if (extra) domain.push(cond("allow_milestones", "=", true));
  const ids = await env.model("project.task").search(and(domain));
  if (!ids.length) return [];
  return (await env.model("project.task").read(ids, ["state"], "")).map((r) => String(r["state"]));
}

async function saleLineQty(env: Environment, rec: Rec): Promise<number> {
  const line = m2o(await rec.get("sale_line_id"));
  if (line === null) return 0;
  const raw = (await env.sudo().model("sale.order.line").read([line], ["product_uom_qty"], ""))[0]?.["product_uom_qty"];
  return Number(plainNumber(raw) ?? 0);
}

defineComputes("project.milestone", {
  // :36-39 `ms.is_reached and context_today`
  reached_date: async (env, rec) => ((await rec.get("is_reached")) ? contextToday(env) : false),
  // :41-45 not reached and the deadline before today
  is_deadline_exceeded: milestoneDeadlineExceeded,
  // :47-50
  is_deadline_future: async (env, rec) => {
    const deadline = await rec.get("deadline");
    return typeof deadline === "string" && !!deadline && deadline > await contextToday(env);
  },
  // :53-63 the tasks of a project allowing milestones, and the closed ones among them
  task_count: async (env, rec) => (rec.id === null ? 0 : (await taskStates(env, rec.id, true)).length),
  done_task_count: async (env, rec) => (rec.id === null ? 0 : (await taskStates(env, rec.id, true)).filter((s) => CLOSED_STATES.includes(s)).length),
  // :65-89 unreached with closed tasks and none open (a new record: all its tasks closed)
  can_be_marked_as_done: milestoneCanBeDone,
  // :90-93 (compute_sudo)
  project_allow_milestones: async (env, rec) => {
    const project = m2o(await rec.get("project_id"));
    if (project === null) return false;
    return !!(await env.sudo().model("project.project").read([project], ["allow_milestones"], ""))[0]?.["allow_milestones"];
  },
  // sale_project :39-42 `sale_line_id.product_uom_qty and product_uom_qty / sale_line_id.product_uom_qty`
  quantity_percentage: async (env, rec) => {
    const qty = await saleLineQty(env, rec);
    if (!qty) return 0;
    return Number(plainNumber(await rec.get("product_uom_qty")) ?? 0) / qty;
  },
  // sale_project :44-50 (compute_sudo); read prev("quantity_percentage") on DbRec to avoid circular recursion during create
  product_uom_qty: async (env, rec) => {
    const rawPct = rec.id === null ? await rec.get("quantity_percentage") : await rec.prev("quantity_percentage");
    const pct = Number(plainNumber(rawPct) ?? 0);
    const qty = await saleLineQty(env.sudo(), rec);
    return pct ? pct * qty : qty;
  },
});
