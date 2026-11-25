/**
 * project.project creation (odoo/addons/project/models/project_project.py:690-735 `create`, sale_project
 * project_project.py `create`, mail.alias.mixin create): the default task stages, the project stage, the favorite,
 * the alias creation values. The mail.thread part (creation message, `user_id` follower) is the generic one
 * (src/mail/write_hooks.ts, `mail_create_nosubscribe`).
 *
 * Refused: `default_stage_id`, collaborators (portal/invited privacy with a partner) and sale order links.
 */
import { MissingError, NotPorted, ValidationError } from "../errors";
import type { Environment } from "../orm/types";
import { userHasGroup } from "../web/groups";
import { registerDefaults, registerOnchange } from "../orm/recompute";
import { registerOverrides, write } from "../orm/write";
import { defineComputes } from "./tail_util";
import { datetimeToString, dbNow, translate } from "./util";
import { aliasMixinWrite, aliasOnlyWrite, baseAliasCreationValues, irModelId, registerAliasMixinUnlink, writeAliasCreationValues } from "../mail/alias_mixin";
import { unlink } from "../orm/unlink";
import { writeImplied } from "./res_config_settings_save";
import { dictEntries, isDict, literalEval, pyRepr } from "../pyexpr";
import { registerMethod } from "../http/methods";
import { create } from "../orm/create";
import { sanitizeAliasName } from "./crm_team";
import { and, cond, or } from "../orm/domain";
import { contextToday } from "./account_computes";
import { envFor } from "../web/common";
import { searchRead } from "./res_lang";
import { formatList } from "./display_names";

registerDefaults("project.project", {
  // project_project.py:65-67 _default_stage_id: the first project stage (sequence, id) the user can see
  stage_id: async (env) => (await env.model("project.project.stage").search({ kind: "true" }, { limit: 1 }))[0] ?? false,
  // project_project.py:69-78 _default_type_ids (env._ in en_US)
  type_ids: async (env) => {
    if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated default project stages (${env.lang})`);
    return [["New", false], ["In Progress", false], ["Done", false], ["Cancelled", true]]
      .map(([name, fold], i) => [0, 0, { name, sequence: (i + 1) * 5, fold }]);
  },
});

// sale_project project_milestone.py:10-25 `_default_sale_line_id`: the context's sale line if it is delivered by
// milestones, else the first such line of the project's order (`project.sale_order_id`, related sale_line_id.order_id);
// searched as the user. Before round 11 the default refused, so no milestone could be created with sale_project.
registerDefaults("project.milestone", {
  sale_line_id: async (env) => {
    const given = env.context["default_sale_line_id"];
    if (given) {
      const [id] = await env.model("sale.order.line").search(and([cond("id", "=", given), cond("qty_delivered_method", "=", "milestones")]), { limit: 1 });
      return id ?? false;
    }
    const project = env.context["default_project_id"];
    if (!project) return false;
    if (typeof project !== "number") throw new NotPorted("project.milestone default_project_id that is not an id");
    const order = (await env.cr.query<{ o: number | null }>(
      "SELECT sl.order_id AS o FROM project_project p LEFT JOIN sale_order_line sl ON sl.id = p.sale_line_id WHERE p.id = $1", [project])).rows[0]?.o ?? false;
    const [id] = await env.model("sale.order.line").search(and([cond("order_id", "=", order), cond("qty_delivered_method", "=", "milestones")]), { limit: 1 });
    return id ?? false;
  },
});

registerDefaults("project.task.type", {
  // project_task_type.py:15-21 _get_default_project_ids / _default_user_id
  project_ids: async (env) => (env.context["default_project_id"] ? [[6, 0, [env.context["default_project_id"]]]] : false),
  user_id: async (env) => (env.context["default_project_id"] ? false : env.uid),
});

defineComputes("project.task.type", {
  // project_task_type.py:78-82 _compute_rating_request_deadline: now (seconds) + the period's days
  rating_request_deadline: async (env, rec) => {
    const periods: Record<string, number> = { daily: 1, weekly: 7, bimonthly: 15, monthly: 30, quarterly: 90, yearly: 365 };
    const days = periods[String(await rec.get("rating_status_period"))] ?? 0;
    const now = Math.floor((await dbNow(env)).getTime() / 1000) * 1000;
    return datetimeToString(new Date(now + days * 86_400_000));
  },
  // project_task_type.py:210-217 _compute_user_id (stored): a stage of projects has no owner
  user_id: async (_env, rec) => ((await rec.rels("project_ids")).length ? null : await rec.prev("user_id")),
  // sale_project project_task_type.py:9-12 _compute_show_rating_active: one of the stage's projects is billable
  show_rating_active: async (_env, rec) => {
    for (const project of await rec.rels("project_ids")) if (await project.get("allow_billable")) return true;
    return false;
  },
});

// sale_project project_task_type.py:14-17 `_onchange_project_ids`: no billable project, no ratings
registerOnchange("project.task.type", "_onchange_project_ids", ["project_ids"], async (_env, rec) => {
  for (const project of await rec.rels("project_ids")) if (await project.get("allow_billable")) return;
  await rec.set("rating_active", false);
});

defineComputes("project.project", {
  // sale_project project_project.py:171-186 _compute_real_cost: costs (negative analytic amounts) of the project account
  real_cost: async (env, rec) => (await realCost(env, rec)).cost,
  real_cost_ratio: async (env, rec) => (await realCost(env, rec)).ratio,
  sale_order_count: async (env, rec) => (await saleItems(env, rec)).orders,
  sale_order_line_count: async (env, rec) => (await saleItems(env, rec)).lines,
  sale_order_amount_total: async (env, rec) => (await saleItems(env, rec)).amount,
  // sale_project project_project.py:85-92 _compute_sale_line_id: a line of another customer goes
  sale_line_id: async (env, rec) => {
    const line = await rec.prev("sale_line_id");
    if (!line) return line;
    const partner = await rec.get("partner_id");
    const pid = typeof partner === "number" ? partner : Array.isArray(partner) ? partner[0] : null;
    if (!pid) return false;
    const same = (await env.cr.query(
      `SELECT 1 FROM sale_order_line l JOIN res_partner a ON a.id = l.order_partner_id JOIN res_partner b ON b.id = $2
        WHERE l.id = $1 AND a.commercial_partner_id = b.commercial_partner_id`, [line, pid])).rows.length;
    return same ? line : false;
  },
  // sale_project project_project.py:94-108 _compute_sale_warning_text: the customer's and its parent's warnings
  sale_warning_text: async (env, rec) => {
    if (!(await userHasGroup(env, "sale.group_warning_sale"))) return "";
    const partner = await rec.rel("partner_id");
    if (!partner) return "";
    const warnings: string[] = [];
    const add = (w: string): void => { if (!warnings.includes(w)) warnings.push(w); };
    const msg = await partner.get("sale_warn_msg");
    if (msg) add(`${String(await partner.get("name") || await partner.get("display_name"))} - ${String(msg)}`);
    const parent = await partner.rel("parent_id");
    const pmsg = parent ? await parent.get("sale_warn_msg") : null;
    if (parent && pmsg) add(`${String(await parent.get("name") || await parent.get("display_name"))} - ${String(pmsg)}`);
    return warnings.join("\n");
  },
  // project_project.py:452-461 _compute_show_ratings: a stage of the project asks for ratings
  show_ratings: async (env, rec) => rec.id !== null && (await env.cr.query(
    `SELECT 1 FROM project_task_type t JOIN project_task_type_rel r ON r.type_id = t.id
      WHERE r.project_id = $1 AND t.rating_active IS TRUE AND t.active IS TRUE LIMIT 1`, [rec.id])).rows.length > 0,
  // project_project.py:323-326 _compute_resource_calendar_id
  resource_calendar_id: async (env, rec) => {
    const company = await rec.get("company_id");
    const cid = typeof company === "number" ? company : Array.isArray(company) ? company[0] : null;
    const own = cid ? (await env.cr.query<{ c: number | null }>("SELECT resource_calendar_id AS c FROM res_company WHERE id = $1", [cid])).rows[0]?.c ?? null : null;
    if (own) return own;
    return (await env.cr.query<{ c: number | null }>("SELECT resource_calendar_id AS c FROM res_company WHERE id = $1", [await env.company()])).rows[0]?.c ?? false;
  },
  // project_project.py:349-353 _compute_last_update_status
  last_update_status: async (_env, rec) => {
    const update = await rec.rel("last_update_id");
    const status = update ? await update.get("status") : null;
    return typeof status === "string" && status ? status : "to_define";
  },
  // mail_tracking_duration_mixin.py:25-57 _compute_duration_tracking (project_project.py:36 `_track_duration_field`)
  duration_tracking: async (env, rec) => {
    const now = await dbNow(env);
    const prev = await rec.prev("duration_tracking");
    const dict: Record<string, unknown> = typeof prev === "object" && prev !== null && !Array.isArray(prev) ? { ...(prev as Record<string, unknown>) } : {};
    const last = dict["s"];
    if (last !== undefined && last !== null && typeof dict["d"] === "string") {
      const old = new Date(`${(dict["d"] as string).replace(" ", "T")}Z`);
      const key = String(last);
      dict[key] = (typeof dict[key] === "number" ? (dict[key] as number) : 0) + Math.trunc((now.getTime() - old.getTime()) / 60000);
    }
    const stage = await rec.get("stage_id");
    dict["s"] = (typeof stage === "number" ? stage : Array.isArray(stage) ? stage[0] : null) ?? 0;
    dict["d"] = datetimeToString(now);
    return dict;
  },
});

/**
 * sale_project project_project.py:144-154 `_compute_sale_order_count` with `_fetch_sale_order_items` (:360-443), the
 * single record path (`len(self) == 1`): the sale lines of the project, its open tasks, its milestones and the lines
 * of the orders of the project. Several projects computed together skip the allow_billable check: this port always
 * computes one project at a time.
 */
export async function saleItems(env: Environment, rec: { id: number | null; get(name: string): Promise<unknown> }): Promise<{ orders: number; lines: number; amount: number; lineIds: number[]; orderIds: number[] }> {
  const reinvoiced = await rec.get("reinvoiced_sale_order_id");
  const reinvoicedId = typeof reinvoiced === "number" ? reinvoiced : Array.isArray(reinvoiced) ? reinvoiced[0] as number : null;
  const lines = new Set<number>();
  if (await rec.get("allow_billable")) {
    const own = await rec.get("sale_line_id");
    const ownId = typeof own === "number" ? own : Array.isArray(own) ? own[0] as number : null;
    if (ownId) lines.add(ownId);
    if (rec.id !== null) {
      const tasks = await env.model("project.task").search(and([cond("project_id", "in", [rec.id]), cond("sale_line_id", "!=", false), cond("is_closed", "=", false)]));
      const milestones = await env.model("project.milestone").search(and([cond("project_id", "in", [rec.id]), cond("allow_billable", "=", true), cond("sale_line_id", "!=", false)]));
      for (const [table, ids] of [["project_task", tasks], ["project_milestone", milestones]] as const) {
        if (!ids.length) continue;
        for (const r of (await env.cr.query<{ l: number }>(`SELECT DISTINCT sale_line_id AS l FROM ${table} WHERE id = ANY($1::int[])`, [ids])).rows) lines.add(r.l);
      }
      for (const r of (await env.cr.query<{ id: number }>(
        `SELECT l.id FROM sale_order_line l JOIN sale_order o ON o.id = l.order_id
          WHERE l.display_type IS NULL AND (o.project_id = $1 OR o.id = $2)`, [rec.id, reinvoicedId])).rows) lines.add(r.id);
    } else if (reinvoicedId !== null) {
      for (const r of (await env.cr.query<{ id: number }>(
        `SELECT id FROM sale_order_line WHERE display_type IS NULL AND order_id = $1`, [reinvoicedId])).rows) lines.add(r.id);
    }
  }
  const ids = [...lines].sort((a, b) => a - b); // `SELECT DISTINCT sale_line_id` (:441-443) comes out sorted
  const orders = ids.length
    ? (await env.cr.query<{ id: number; amount: string | null }>(
      `SELECT DISTINCT o.id, o.amount_total::text AS amount FROM sale_order o JOIN sale_order_line l ON l.order_id = o.id WHERE l.id = ANY($1::int[]) ORDER BY o.id`, [ids])).rows
    : reinvoicedId ? (await env.cr.query<{ id: number; amount: string | null }>("SELECT id, amount_total::text AS amount FROM sale_order WHERE id = $1", [reinvoicedId])).rows : [];
  return { orders: orders.length, lines: ids.length, amount: orders.reduce((t, o) => t + Number(o.amount ?? 0), 0), lineIds: ids, orderIds: orders.map((o) => o.id) };
}

async function realCost(env: Environment, rec: { get(name: string): Promise<unknown> }): Promise<{ cost: number; ratio: number }> {
  const account = await rec.get("account_id");
  const id = typeof account === "number" ? account : Array.isArray(account) ? account[0] : null;
  if (!id) return { cost: 0, ratio: 0 };
  const row = (await env.cr.query<{ cost: string | null; revenue: string | null }>(
    `SELECT SUM(amount) FILTER (WHERE amount < 0)::text AS cost, SUM(amount) FILTER (WHERE amount >= 0)::text AS revenue
       FROM account_analytic_line WHERE account_id = $1`, [id])).rows[0];
  const cost = Math.abs(Number(row?.cost ?? 0));
  const total = cost + Number(row?.revenue ?? 0);
  return { cost, ratio: total ? 100 * (cost / total) : 0 };
}

/**
 * project_project.py:881-910 `_check_project_group_with_field`: base.group_user implies the group exactly when an
 * (active) project has the feature; the change is written (`implied_ids` link, or unlink and the group's explicit
 * users cleared). True when added, false when removed, null when unchanged.
 */
async function checkProjectGroup(env: Environment, field: string, group: string): Promise<boolean | null> {
  const gid = await env.reg.xmlid(env.cr, group), userGroup = await env.reg.xmlid(env.cr, "base.group_user");
  if (gid === null || userGroup === null) throw new NotPorted(`project.project ${field}: missing group ${group} (ValueError)`);
  // `self.env.user.has_group(group_name)` after any earlier change in this request (the groups ormcache is cleared
  // by an implied_ids write, res_groups.py:21)
  const hasUserGroup = (await env.cr.query(
    `WITH RECURSIVE g(id) AS (SELECT gid FROM res_groups_users_rel WHERE uid = $1
       UNION SELECT r.hid FROM res_groups_implied_rel r JOIN g ON r.gid = g.id) SELECT 1 FROM g WHERE id = $2 LIMIT 1`, [env.uid, gid])).rows.length > 0;
  // `sudo().search_count([(field_name, '=', True)], limit=1)`: active projects only
  const hasSet = (await env.cr.query(`SELECT 1 FROM project_project WHERE "${field}" IS TRUE AND active IS TRUE LIMIT 1`)).rows.length > 0;
  let res: boolean | null = null;
  if (!hasUserGroup && hasSet) {
    await writeImplied(env, [userGroup], [4, gid]);
    res = true;
  } else if (hasUserGroup && !hasSet) {
    await writeImplied(env, [userGroup], [3, gid]);
    await write(env.sudo(), "res.groups", [gid], { user_ids: [[5, 0, 0]] });
    res = false;
  }
  if (res !== null) {
    // the request's own caches of the users' groups (src/web/groups.ts, src/orm/env.ts userInfo)
    for (const k of [...env.cache.keys()]) if (k.startsWith("web.groups.user_group_ids:") || k === "orm.users") env.cache.delete(k);
  }
  return res;
}

/** project_task.py:436-439 OPEN_STATES: the task states but the closed ones. */
const OPEN_STATES = ["01_in_progress", "02_changes_requested", "03_approved", "04_waiting_normal"];

/**
 * project_project.py:463-491 `_inverse_allow_task_dependencies`: the open tasks with an open dependency of the projects
 * with the feature wait, the waiting tasks of the others go back in progress; then the group, and with a change the
 * waiting subtypes shown or hidden.
 */
async function inverseAllowTaskDependencies(env: Environment, ids: readonly number[]): Promise<void> {
  const rows = (await env.cr.query<{ id: number; a: boolean | null }>("SELECT id, allow_task_dependencies AS a FROM project_project WHERE id = ANY($1::int[])", [[...ids]])).rows;
  const withFeature = rows.filter((r) => r.a).map((r) => r.id), without = rows.filter((r) => !r.a).map((r) => r.id);
  const Task = env.model("project.task");
  if (withFeature.length) {
    const open = await Task.search(and([cond("project_id", "in", withFeature), cond("depend_on_ids.state", "in", OPEN_STATES), cond("state", "in", OPEN_STATES)]));
    if (open.length) await write(env, "project.task", open, { state: "04_waiting_normal" });
  }
  if (without.length) {
    const waiting = await Task.search(and([cond("project_id", "in", without), cond("state", "=", "04_waiting_normal")]));
    if (waiting.length) await write(env, "project.task", waiting, { state: "01_in_progress" });
  }
  const res = await checkProjectGroup(env, "allow_task_dependencies", "project.group_project_task_dependencies");
  if (res !== null) {
    for (const x of ["project.mt_task_waiting", "project.mt_project_task_waiting"]) {
      const id = await env.reg.xmlid(env.cr, x);
      if (id === null) throw new NotPorted(`missing subtype ${x} (ValueError)`);
      await write(env.sudo(), "mail.message.subtype", [id], { hidden: !res });
    }
  }
}

/** project_project.py:312-320 `_compute_allowed_internal_user_ids`, a stored many2many the recompute queue does not reach. */
async function syncAllowedUsers(env: Environment, ids: readonly number[]): Promise<void> {
  for (const id of ids) {
    const p = (await env.cr.query<{ company_id: number | null; user_id: number | null; v: string | null }>(
      "SELECT company_id, user_id, privacy_visibility AS v FROM project_project WHERE id = $1", [id])).rows[0];
    if (!p) continue;
    if (p.company_id !== null) {
      await env.cr.query(
        `DELETE FROM project_allowed_internal_users_rel r WHERE r.project_project_id = $1
           AND NOT EXISTS (SELECT 1 FROM res_company_users_rel c WHERE c.user_id = r.res_users_id AND c.cid = $2)`, [id, p.company_id]);
    }
    if (p.user_id !== null && (p.v === "followers" || p.v === "invited_users")) {
      await env.cr.query("INSERT INTO project_allowed_internal_users_rel (project_project_id, res_users_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [id, p.user_id]);
    }
  }
}

/** mail.alias.mixin `_alias_get_creation_values` with project_project.py:845-851's (alias_model_id, project_id default). */
async function projectAliasValues(env: Environment, id: number): Promise<Record<string, unknown>> {
  const values = await baseAliasCreationValues(env, "project.project", id);
  values["alias_model_id"] = await irModelId(env, "project.task");
  const row = (await env.sudo().model("project.project").read([id], ["alias_defaults"], ""))[0]!;
  const parsed = literalEval(String(row["alias_defaults"] || "{}"));
  if (!isDict(parsed)) throw new NotPorted("project alias_defaults that is not a dict");
  const defaults = new Map<unknown, unknown>(dictEntries(parsed));
  defaults.set("project_id", id);
  values["alias_defaults"] = pyRepr(defaults);
  return values;
}

/** project_project.py:816-820: the three feature groups checked in turn. */
async function inverseGroupsOnly(env: Environment): Promise<void> {
  await checkProjectGroup(env, "allow_task_dependencies", "project.group_project_task_dependencies");
  await checkProjectGroup(env, "allow_milestones", "project.group_project_milestone");
  await checkProjectGroup(env, "allow_recurring_tasks", "project.group_project_recurring_tasks");
}

registerOverrides("project.project", {
  skipsCore: aliasOnlyWrite,
  write: async (env, ids, vals, next) => {
    // the super() of project_project.py:752 is mail_alias_mixin_optional.py:108's write (src/mail/alias_mixin.ts)
    await aliasMixinWrite(env, "project.project", ids, vals, next, projectAliasValues);
    // :754-755 (after the inverse, which already moved these tasks back)
    if ("allow_task_dependencies" in vals && !vals["allow_task_dependencies"]) {
      const waiting = await env.model("project.task").search(and([cond("project_id", "in", [...ids]), cond("state", "=", "04_waiting_normal")]));
      if (waiting.length) await write(env, "project.task", waiting, { state: "01_in_progress" });
    }
    // :757-758 the recurring tasks stop recurring (project_task.py:1358-1361 unlinks their recurrences: not ported)
    if ("allow_recurring_tasks" in vals && !vals["allow_recurring_tasks"]) {
      const recurring = await env.model("project.task").search(and([cond("project_id", "in", [...ids]), cond("recurring_task", "=", true)]));
      if (recurring.length) throw new NotPorted("project.project allow_recurring_tasks off with recurring tasks (their recurrences are unlinked)");
    }
    if (["user_id", "company_id", "privacy_visibility"].some((k) => k in vals) && !("allowed_internal_user_ids" in vals)) await syncAllowedUsers(env, ids);
  },
  // project_project.py:799-814 unlink: the embedded action settings (sudo), the tasks (archived ones too), then
  // super() (mail.alias.mixin's: the aliases after), then the empty analytic accounts (not ported: refused)
  unlink: async (env, ids, next) => {
    const su = env.sudo();
    const settings = await su.model("res.users.settings.embedded.action").search(and([cond("res_id", "in", [...ids]), cond("res_model", "=", "project.project")]));
    if (settings.length) await unlink(su, "res.users.settings.embedded.action", settings);
    const accounts = (await env.cr.query<{ id: number }>(
      `SELECT DISTINCT a.id FROM project_project p JOIN account_analytic_account a ON a.id = p.account_id WHERE p.id = ANY($1::int[])
          AND NOT EXISTS (SELECT 1 FROM account_analytic_line l WHERE l.account_id = a.id)
          AND NOT EXISTS (SELECT 1 FROM project_project o WHERE o.account_id = a.id AND NOT (o.id = ANY($1::int[])))`, [[...ids]])).rows;
    if (accounts.length) throw new NotPorted("project.project unlink deleting its empty analytic account");
    const all = env.withContext({ ...env.context, active_test: false });
    const tasks = await all.model("project.task").search(cond("project_id", "in", [...ids]), { activeTest: false });
    if (tasks.length) {
      // project_task.py:1471-1480: the subtasks join the batch, the recurrence of a recurrence's last task is unlinked
      const outside = (await env.cr.query(
        `SELECT 1 FROM project_task WHERE (parent_id = ANY($1::int[]) AND NOT (id = ANY($1::int[]))) OR (id = ANY($1::int[]) AND recurrence_id IS NOT NULL) LIMIT 1`,
        [tasks])).rows.length;
      if (outside) throw new NotPorted("project.project unlink with subtasks in other projects or recurring tasks");
      await unlink(all, "project.task", tasks);
    }
    await next(env, ids);
  },
  // project_project.py:816-820 `_check_project_group_at_removal` (before the delete: the projects still count)
  beforeUnlink: async (env) => {
    await inverseGroupsOnly(env);
  },
  inverse: {
    // project_project.py:497-501
    allow_milestones: async (env) => { await checkProjectGroup(env, "allow_milestones", "project.group_project_milestone"); },
    allow_recurring_tasks: async (env) => { await checkProjectGroup(env, "allow_recurring_tasks", "project.group_project_recurring_tasks"); },
    allow_task_dependencies: async (env, ids) => inverseAllowTaskDependencies(env, ids),
    // project_project.py:328-347 _inverse_company_id
    company_id: async (env, ids) => {
      const rows = (await env.cr.query<{ company_id: number | null; pc: number | null; account_id: number | null }>(
        `SELECT p.company_id, rp.company_id AS pc, p.account_id FROM project_project p LEFT JOIN res_partner rp ON rp.id = p.partner_id
          WHERE p.id = ANY($1::int[])`, [[...ids]])).rows;
      for (const r of rows) {
        if (r.pc && r.company_id && r.pc !== r.company_id) throw new NotPorted("project and partner of different companies (UserError)");
        if (r.account_id) throw new NotPorted("project.project company of its analytic account");
      }
    },
  },
  create: async (env0, valsList, next) => {
    const env = env0.withContext({ ...env0.context, mail_create_nosubscribe: true });
    for (const vals of valsList) {
      if ("label_tasks" in vals && !vals["label_tasks"]) {
        if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated project label_tasks (${env.lang})`);
        vals["label_tasks"] = "Tasks";
      }
    }
    // mail_alias_mixin_optional.py:52-92 with mail_alias_mixin.py `_require_new_alias`: an alias per record without one;
    // the mail.alias fields of the values go on it, with the record-agnostic creation values
    const aliasFields = env.reg.model("mail.alias").fields;
    const defaultCompany = typeof env.context["default_company_id"] === "number" ? env.context["default_company_id"] as number : await env.company();
    for (let i = 0; i < valsList.length; i++) {
      const vals = valsList[i]!;
      if (vals["alias_name"]) vals["alias_name"] = sanitizeAliasName(vals["alias_name"]);
      if (vals["alias_id"]) continue;
      const aliasVals: Record<string, unknown> = {}, recordVals: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(vals)) (aliasFields.has(k) ? aliasVals : recordVals)[k] = v;
      const company = (vals["company_id"] as number | undefined) || defaultCompany;
      const domain = "alias_domain_id" in aliasVals ? aliasVals["alias_domain_id"]
        : (await env.cr.query<{ d: number | null }>("SELECT alias_domain_id AS d FROM res_company WHERE id = $1", [company])).rows[0]?.d ?? false;
      Object.assign(aliasVals, await baseAliasCreationValues(env.withContext({ ...env.context, default_alias_domain_id: domain }), "project.project", null),
        { alias_model_id: await irModelId(env, "project.task") });
      const [alias] = await create(env.sudo(), "mail.alias", [aliasVals]);
      for (const k of Object.keys(vals)) delete vals[k];
      Object.assign(vals, recordVals, { alias_id: alias });
    }
    if (await userHasGroup(env, "project.group_project_stages")) {
      if ("default_stage_id" in env.context) throw new NotPorted("project.project create with default_stage_id");
      const companies = [...new Set(valsList.map((v) => v["company_id"] || null))];
      const stages = (await env.model("project.project.stage").read(
        await env.model("project.project.stage").search({ kind: "cond", path: "company_id", op: "in", value: [...companies.filter((c) => c !== null), false] }),
        ["company_id"], "")).map((r) => ({ id: Number(r["id"]), company: Array.isArray(r["company_id"]) ? r["company_id"][0] : r["company_id"] || false }));
      for (const vals of valsList) {
        if (vals["stage_id"]) continue;
        const allowed = "company_id" in vals ? [false, vals["company_id"] || false] : [false];
        vals["stage_id"] = stages.find((s) => allowed.includes(s.company))?.id ?? false;
      }
    }
    for (const vals of valsList) {
      if ("is_favorite" in vals) {
        const fav = vals["is_favorite"];
        delete vals["is_favorite"];
        if (fav) vals["favorite_user_ids"] = [[6, 0, [env.uid]]];
      }
    }
    const ids = await next(env, valsList);
    await syncAllowedUsers(env, ids.filter((_id, i) => !("allowed_internal_user_ids" in valsList[i]!)));
    // project_task_type.py:210-217 _compute_user_id: the stages created and linked through `type_ids` lose the owner
    // their default gave them (the recompute triggered by the many2many link)
    await env.cr.query(`UPDATE project_task_type t SET user_id = NULL FROM project_task_type_rel r
      WHERE r.type_id = t.id AND r.project_id = ANY($1::int[]) AND t.user_id IS NOT NULL`, [ids]);
    // mail.alias.mixin create (:99-103) with project_project.py:845-851 `_alias_get_creation_values`
    await writeAliasCreationValues(env, "project.project", ids, (id) => projectAliasValues(env, id));
    // project_project.py:682-692 collaborators of portal/invited projects with a partner
    const collabRows = (await env.cr.query<{ id: number; partner_id: number }>(
      "SELECT id, partner_id FROM project_project WHERE id = ANY($1::int[]) AND privacy_visibility IN ('portal', 'invited_users') AND partner_id IS NOT NULL ORDER BY array_position($1::int[], id)",
      [ids])).rows;
    if (collabRows.length) {
      await create(env, "project.collaborator", collabRows.map((r) => ({ project_id: r.id, partner_id: r.partner_id, access_mode: "view" })));
    }
    // sale_project project_project.py:231-238: link project back to sale_order_id or reinvoiced_sale_order_id if unset
    if (env.reg.model("project.project").fields.has("reinvoiced_sale_order_id")) {
      const linked = (await env.cr.query<{ id: number; so: number | null; so_proj: number | null; rso: number | null; rso_proj: number | null }>(
        `SELECT p.id, sl.order_id AS so, o1.project_id AS so_proj, p.reinvoiced_sale_order_id AS rso, o2.project_id AS rso_proj
           FROM project_project p
           LEFT JOIN sale_order_line sl ON sl.id = p.sale_line_id
           LEFT JOIN sale_order o1 ON o1.id = sl.order_id
           LEFT JOIN sale_order o2 ON o2.id = p.reinvoiced_sale_order_id
          WHERE p.id = ANY($1::int[]) ORDER BY array_position($1::int[], p.id)`, [ids])).rows;
      for (const r of linked) {
        if (r.so && !r.so_proj) {
          await write(env, "sale.order", [r.so], { project_id: r.id });
        } else if (r.rso && !r.rso_proj) {
          await write(env.sudo(), "sale.order", [r.rso], { project_id: r.id });
        }
      }
    }
    return ids;
  },
});

// project_collaborator.py:28-57: toggle project_task_rule_portal_project_sharing when first created / last unlinked
async function toggleProjectSharingRule(env: Environment, active: boolean): Promise<void> {
  const ruleId = await env.reg.xmlid(env.cr, "project.project_task_rule_portal_project_sharing");
  if (!ruleId) return;
  const cur = (await env.cr.query<{ active: boolean }>("SELECT active FROM ir_access WHERE id = $1", [ruleId])).rows[0];
  if (cur && cur.active !== active) await write(env.sudo(), "ir.access", [ruleId], { active });
}
registerOverrides("project.collaborator", {
  create: async (env, valsList, next) => {
    const hadAny = (await env.model("project.collaborator").search({ kind: "true" }, { limit: 1 })).length > 0;
    const ids = await next(env, valsList);
    if (!hadAny) await toggleProjectSharingRule(env, true);
    return ids;
  },
  unlink: async (env, ids, next) => {
    await next(env, ids);
    const hasAny = (await env.model("project.collaborator").search({ kind: "true" }, { limit: 1 })).length > 0;
    if (!hasAny) await toggleProjectSharingRule(env, false);
  },
});

registerAliasMixinUnlink("project.project");

/**
 * project_project.py:1036-1052 `action_view_tasks` with sale_project's override (:459-484; hr_timesheet is not
 * installed): the tasks action of the project, its context with the project's flags.
 */
export async function projectActionViewTasks(env: Environment, id: number): Promise<Record<string, unknown>> {
  // sale_project :460-470 generate_milestone
  if (env.context["generate_milestone"]) {
    const lineId = env.context["default_sale_line_id"];
    if (typeof lineId === "number") {
      const line = (await env.cr.query<{ name: string | null; task_id: number | null; service_tracking: string | null }>(
        `SELECT l.name, l.task_id, t.service_tracking FROM sale_order_line l
           LEFT JOIN product_product p ON p.id = l.product_id LEFT JOIN product_template t ON t.id = p.product_tmpl_id
          WHERE l.id = $1`, [lineId])).rows[0];
      const [milestoneId] = await create(env, "project.milestone", [{
        name: line?.name ?? false, project_id: id, sale_line_id: lineId, quantity_percentage: 1,
      }]);
      if (line?.service_tracking === "task_in_project" && line.task_id && milestoneId) {
        await write(env, "project.task", [line.task_id], { milestone_id: milestoneId });
      }
    }
  }
  const { loadAction } = await import("../controllers/action");
  const actx = { ...env.context, active_id: id };
  const action = await loadAction({ cursor: () => env.cr, context: actx, uid: env.uid }, "project.act_project_project_2_project_task_all", env.withContext(actx));
  const p = (await env.model("project.project").read([id], ["name", "active", "allow_milestones", "allow_task_dependencies", "allow_billable", "is_template", "sale_order_id", "reinvoiced_sale_order_id"], ""))[0];
  if (!p) throw new NotPorted("action_view_tasks on a missing project (MissingError)");
  action["display_name"] = p["name"];
  // ast.literal_eval(action['context'].replace('active_id', str(self.id)))
  const raw = String(action["context"] ?? "{}").split("active_id").join(String(id));
  const parsed = literalEval(raw);
  if (!isDict(parsed)) throw new NotPorted("action_view_tasks context that is not a dict");
  const ctx: Record<string, unknown> = {};
  for (const [k, v] of dictEntries(parsed)) ctx[String(k)] = v;
  Object.assign(ctx, {
    create: p["active"], active_test: p["active"], active_id: id,
    allow_milestones: p["allow_milestones"], allow_task_dependencies: p["allow_task_dependencies"],
  });
  action["context"] = ctx;
  if (p["is_template"]) { // :1049-1051
    ctx["template_project"] = true;
    if (!Array.isArray(action["views"])) throw new NotPorted("action_view_tasks without views");
    action["views"] = (action["views"] as [unknown, string][]).filter(([, type]) => type !== "pivot" && type !== "graph");
  }
  // sale_project :473-484 (`_get_hide_partner` :450-451)
  ctx["hide_partner"] = !p["allow_billable"];
  ctx["allow_billable"] = p["allow_billable"];
  if (env.context["from_sale_order_action"]) {
    delete ctx["search_default_open_tasks"];
    const rso = Array.isArray(p["reinvoiced_sale_order_id"]) ? p["reinvoiced_sale_order_id"][0] : p["reinvoiced_sale_order_id"];
    const saleOrderId = env.context["default_reinvoiced_sale_order_id"] || rso;
    if (saleOrderId) ctx["search_default_sale_order_id"] = saleOrderId;
    if (!p["sale_order_id"]) {
      const aid = env.context["active_id"];
      ctx["default_sale_order_id"] = typeof aid === "number" ? aid : false;
    }
  }
  return action;
}

registerMethod("project.project", "action_view_tasks", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  if (!ids || ids.length !== 1) throw new NotPorted("project.project.action_view_tasks on several projects (ensure_one)");
  return projectActionViewTasks(env, ids[0]!);
}, { apiModel: false });

/** project/wizard/project_template_create_wizard.py:50-67 + sale_project override :50-61 `action_open_template_view`. */
export async function openProjectTemplateView(env: Environment): Promise<Record<string, unknown>> {
  const viewId = await env.reg.xmlid(env.cr, "project.project_project_view_form_simplified_template");
  if (!viewId) return {};
  const ctx: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(env.context)) if (!k.startsWith("default_")) ctx[k] = v;
  if (env.context["from_sale_order_action"]) {
    ctx["default_partner_id"] = env.context["default_partner_id"] ?? null;
    ctx["default_reinvoiced_sale_order_id"] = env.context["default_reinvoiced_sale_order_id"] ?? null;
    ctx["default_sale_line_id"] = env.context["default_sale_line_id"] ?? null;
  }
  const tplName = env.context["template_name"];
  return {
    name: translate(env, "Create Project (Template: %s)", "project").replace("%s", tplName === undefined || tplName === null ? "None" : String(tplName)),
    type: "ir.actions.act_window",
    view_mode: "form",
    views: [[viewId, "form"]],
    res_model: "project.template.create.wizard",
    target: "new",
    context: ctx,
  };
}

registerDefaults("project.template.create.wizard", {
  template_id: async (env) => env.context["template_id"] ?? false,
  role_to_users_ids: async (env) => {
    const tid = env.context["template_id"];
    if (typeof tid !== "number") return [];
    const roles = (await env.cr.query<{ role_id: number }>(
      `SELECT DISTINCT r.project_role_id AS role_id FROM project_task t
         JOIN project_role_project_task_rel r ON r.project_task_id = t.id
        WHERE t.project_id = $1 AND t.active ORDER BY 1`, [tid])).rows;
    return roles.map((r) => [0, 0, { role_id: r.role_id }]);
  },
});

defineComputes("project.template.create.wizard", {
  template_has_dates: async (_env, rec) => {
    const tpl = await rec.rel("template_id");
    if (!tpl) return false;
    return Boolean((await tpl.get("date_start")) && (await tpl.get("date")));
  },
  role_to_users_ids: async (env, rec) => {
    const tpl = await rec.rel("template_id");
    if (!tpl || tpl.origin === null) return [[5, 0, 0]];
    const roles = (await env.cr.query<{ role_id: number }>(
      `SELECT DISTINCT r.project_role_id AS role_id FROM project_task t
         JOIN project_role_project_task_rel r ON r.project_task_id = t.id
        WHERE t.project_id = $1 AND t.active ORDER BY 1`, [tpl.origin])).rows;
    return [[5, 0, 0], ...roles.map((r) => [0, 0, { role_id: r.role_id, user_ids: [[5, 0, 0]] }])];
  },
  sale_warning_text: async (env, rec) => {
    if (!await userHasGroup(env, "sale.group_warning_sale")) return "";
    const partner = await rec.rel("partner_id");
    if (!partner) return "";
    const warnings: string[] = [];
    const addWarn = async (p: typeof partner) => {
      const msg = await p.get("sale_warn_msg");
      if (typeof msg === "string" && msg) {
        const label = String((await p.get("name")) || (await p.get("display_name")) || "");
        const text = `${label} - ${msg}`;
        if (!warnings.includes(text)) warnings.push(text);
      }
    };
    await addWarn(partner);
    const parent = await partner.rel("parent_id");
    if (parent) await addWarn(parent);
    return warnings.join("\n");
  },
});

registerMethod("project.template.create.wizard", "action_open_template_view", async (env0, _ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  return openProjectTemplateView(env);
}, { apiModel: true });

// sale_project/wizard/project_template_create_wizard.py:63-91 action_create_project_from_so
registerMethod("project.template.create.wizard", "action_create_project_from_so", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  if (!ids || ids.length !== 1) throw new NotPorted("project.template.create.wizard.action_create_project_from_so on several records");
  const wiz = (await env.model("project.template.create.wizard").read([ids[0]!], ["template_id"], ""))[0]!;
  const soName = String(env.context["default_name"] ?? "None");
  if (wiz["template_id"]) {
    const tid = Array.isArray(wiz["template_id"]) ? wiz["template_id"][0] as number : wiz["template_id"] as number;
    const tplName = (await env.model("project.project").read([tid], ["name"], ""))[0]?.["name"];
    await write(env, "project.template.create.wizard", [ids[0]!], { name: `${soName} - ${String(tplName ?? "")}` });
    const { createProjectFromTemplateWizard } = await import("./sweep_project_crm");
    const projectId = await createProjectFromTemplateWizard(env, ids[0]!);
    return projectActionViewTasks(env, projectId);
  }
  const orderId = env.context["default_sale_order_id"];
  if (typeof orderId !== "number") throw new NotPorted("action_create_project_from_so without default_sale_order_id");
  const order = (await env.model("sale.order").read([orderId], ["partner_id", "company_id", "order_line"], ""))[0]!;
  const partnerId = Array.isArray(order["partner_id"]) ? order["partner_id"][0] as number : (order["partner_id"] as number | false);
  const companyId = Array.isArray(order["company_id"]) ? order["company_id"][0] as number : (order["company_id"] as number | false);
  const lines = (order["order_line"] as number[] | undefined) ?? [];
  const values: Record<string, unknown> = { partner_id: partnerId || false, company_id: companyId || false };
  if (lines.length === 1) {
    const lineRow = (await env.cr.query<{ name: string | null; product_id: number | null; default_code: string | null; pname: Record<string, string> | null; tpl_id: number | null }>(
      `SELECT l.name, l.product_id, p.default_code, t.name AS pname, t.project_template_id AS tpl_id
         FROM sale_order_line l LEFT JOIN product_product p ON p.id = l.product_id LEFT JOIN product_template t ON t.id = p.product_tmpl_id
        WHERE l.id = $1`, [lines[0]!])).rows[0];
    const parts = (lineRow?.name ?? "").split("\n");
    const productDisplay = lineRow?.product_id ? (await env.model("product.product").displayName([lineRow.product_id])).get(lineRow.product_id) ?? "" : "";
    if (parts.length && parts[0] === productDisplay) parts.shift();
    let name: string;
    if (parts.length === 1 && parts[0]) {
      name = parts[0]!;
    } else {
      const pname = lineRow?.pname?.[env.lang ?? "en_US"] ?? lineRow?.pname?.["en_US"] ?? "";
      name = lineRow?.default_code ? `[${lineRow.default_code}] ${pname}` : pname;
      values["description"] = parts.join("<br/>");
    }
    const tplName = lineRow?.tpl_id
      ? (await env.cr.query<{ name: Record<string, string> | null }>("SELECT name FROM project_project WHERE id = $1", [lineRow.tpl_id])).rows[0]?.name
      : null;
    const tplLabel = tplName?.[env.lang ?? "en_US"] ?? tplName?.["en_US"] ?? "";
    values["name"] = `${soName} - ${tplLabel || name}`;
  } else {
    values["name"] = soName;
  }
  const [projectId] = await create(env, "project.project", [values]);
  return projectActionViewTasks(env, projectId!);
}, { apiModel: false });

/** project_project.py:868-878 `get_template_tasks`. */
registerMethod("project.project", "get_template_tasks", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  if (!ids || ids.length !== 1) throw new NotPorted("project.project.get_template_tasks on several projects (ensure_one)");
  return searchRead(env, "project.task", [], {
    domain: [["project_id", "in", [ids[0], false]], ["is_template", "=", true], ["parent_id", "=", false]],
    fields: ["id", "name"], order: "project_id",
  });
}, { apiModel: false, readonly: true });

/** project_project.py:908-928 `check_features_enabled(updated_features)` (`_get_project_features_mapping`). */
registerMethod("project.project", "check_features_enabled", async (env0, _ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  if (!(await userHasGroup(env, "project.group_project_user"))) return {};
  const updated = "updated_features" in kwargs ? kwargs["updated_features"] : args[0];
  const out: Record<string, boolean> = {};
  for (const [field, group] of [["allow_task_dependencies", "project.group_project_task_dependencies"], ["allow_milestones", "project.group_project_milestone"], ["allow_recurring_tasks", "project.group_project_recurring_tasks"]] as const) {
    if (Array.isArray(updated) && updated.length && !updated.includes(field)) continue;
    out[field] = await userHasGroup(env, group);
  }
  return out;
}, { apiModel: true, readonly: true });

type Action = Record<string, unknown>;

async function projectAction(env: Environment, xmlid: string, ids: number[] | null): Promise<{ env: Environment; id: number; project: Record<string, unknown>; action: Action }> {
  if (!ids || ids.length !== 1) throw new NotPorted("project.project action on several projects (ensure_one)");
  if (env.lang && env.lang !== "en_US") throw new NotPorted("translated project action names");
  const { loadAction } = await import("../controllers/action");
  const action = await loadAction({ cursor: () => env.cr, context: env.context, uid: env.uid }, xmlid, env);
  const project = (await env.model("project.project").read([ids[0]!], ["name", "partner_id", "account_id", "allow_billable", "is_template"], ""))[0];
  if (!project) throw new NotPorted("project action on a missing project (MissingError)");
  return { env, id: ids[0]!, project, action };
}

/** `ast.literal_eval(context)` as a plain object, key order kept. */
function literalContext(raw: unknown, id?: number): Record<string, unknown> {
  const text = id === undefined ? String(raw || "{}") : String(raw || "{}").split("active_id").join(String(id));
  const parsed = literalEval(text);
  if (!isDict(parsed)) throw new NotPorted("action context that is not a dict");
  return Object.fromEntries(dictEntries(parsed).map(([k, v]) => [String(k), v]));
}

const m2oId = (v: unknown): number | false => (typeof v === "number" ? v : Array.isArray(v) ? v[0] as number : false);

async function refId(env: Environment, xmlid: string): Promise<number | null> {
  const [module, name] = xmlid.split(".");
  return (await env.cr.query<{ id: number }>("SELECT res_id AS id FROM ir_model_data WHERE module = $1 AND name = $2", [module, name])).rows[0]?.id ?? null;
}

// project_project.py:996-999
registerMethod("project.project", "project_update_all_action", async (env0, ids, _a, kw) => {
  const { action, project } = await projectAction(envFor(env0, kw).env, "project.project_update_all_action", ids);
  action["display_name"] = `${String(project["name"])} Updates`;
  return action;
}, { apiModel: false });

// project_project.py:1079-1086 with sale_project project_project.py:306-310
registerMethod("project.project", "action_get_list_view", async (env0, ids, _a, kw) => {
  const { env, id, action, project } = await projectAction(envFor(env0, kw).env, "project.project_milestone_action", ids);
  action["display_name"] = `${String(project["name"])}'s Milestones`;
  action["context"] = { ...literalContext(action["context"], id), is_project_template: project["is_template"] };
  if (project["allow_billable"]) {
    const view = await refId(env, "sale_project.project_milestone_view_tree");
    action["views"] = (action["views"] as [unknown, string][]).map(([v, t]) => [t === "list" ? view : v, t]);
  }
  return action;
}, { apiModel: false });

// project_project.py:975-989
registerMethod("project.project", "action_project_task_burndown_chart_report", async (env0, ids, _a, kw) => {
  const { env, id, action, project } = await projectAction(envFor(env0, kw).env, "project.action_project_task_burndown_chart_report", ids);
  action["display_name"] = `${String(project["name"])}'s Burndown Chart`;
  const stages = (await env.cr.query<{ id: number; sequence: number; name: string }>(
    `SELECT t.id, t.sequence, COALESCE(t.name->>$2, t.name->>'en_US') AS name FROM project_task_type t JOIN project_task_type_rel r ON r.type_id = t.id
      WHERE r.project_id = $1 AND t.active IS TRUE ORDER BY t.sequence, t.id`, [id, env.lang ?? "en_US"])).rows;
  action["context"] = { ...literalContext(action["context"], id),
    stage_name_and_sequence_per_id: Object.fromEntries(stages.map((s) => [String(s.id), { sequence: s.sequence, name: s.name }])) };
  return action;
}, { apiModel: false });

// sale_project project_project.py:284-304
registerMethod("project.project", "action_view_sos", async (env0, ids, _a, kw) => {
  const { env, id, action, project } = await projectAction(envFor(env0, kw).env, "sale.action_orders", ids);
  const rec = await saleItems(env, { id, get: async (n) => (await env.model("project.project").read([id], [n], ""))[0]?.[n] });
  const embedded = env.context["from_embedded_action"] ?? false;
  action["domain"] = [["id", "in", rec.orderIds]];
  action["context"] = { ...literalContext(action["context"]), create: env.context["create_for_project_id"] ?? embedded, show_sale: true,
    default_partner_id: m2oId(project["partner_id"]), default_project_id: id, create_for_project_id: embedded ? false : id, from_embedded_action: embedded };
  if (rec.orderIds.length <= 1 && !embedded) Object.assign(action, { res_id: rec.orderIds[0] ?? false, views: [[false, "form"]] });
  return action;
}, { apiModel: false });

// sale_project_margin project_project.py:17-28
registerMethod("project.project", "action_estimated_margin", async (env0, ids, _a, kw) => {
  const { env, id, action, project } = await projectAction(envFor(env0, kw).env, "sale_project_margin.action_project_forecast_margin", ids);
  const rec = await saleItems(env, { id, get: async (n) => (await env.model("project.project").read([id], [n], ""))[0]?.[n] });
  const embedded = env.context["from_embedded_action"] ?? false;
  action["display_name"] = `${String(project["name"])}'s Forecast Margins`;
  action["domain"] = [["id", "in", rec.lineIds]];
  action["context"] = { from_embedded_action: embedded, search_default_filter_order_date: !embedded };
  return action;
}, { apiModel: false });

// sale_project project_project.py:537-561
registerMethod("project.project", "action_real_margin", async (env0, ids, _a, kw) => {
  const { env, action, project } = await projectAction(envFor(env0, kw).env, "sale_project.action_analytic_reporting_inherit_sale_project", ids);
  const embedded = env.context["from_embedded_action"] ?? false;
  const perType: Record<string, number | null> = {
    pivot: await refId(env, "sale_project.view_account_analytic_line_inherit_sale_project_pivot_single"),
    list: await refId(env, "sale_project.account_analytic_line_view_list_margins_no_group"),
    graph: await refId(env, "sale_project.account_analytic_line_view_graph_for_single_project"),
  };
  action["views"] = (action["views"] as [unknown, string][]).map(([v, t]) => [perType[t] ?? v, t]);
  action["display_name"] = `${String(project["name"])}'s Margins`;
  const account = m2oId(project["account_id"]);
  action["domain"] = [["account_id", "in", account ? [account] : []]];
  action["context"] = { ...literalContext(action["context"]), from_embedded_action: embedded, ...(embedded ? { search_default_month: 0 } : {}) };
  return action;
}, { apiModel: false });

/**
 * project_update.py:88-97 `create`: the update becomes its project's last one (as sudo, which recomputes the project's
 * `last_update_status`), then it records the project's task counts (`task_count`, and the closed ones as the
 * difference with `open_task_count`, read as the user).
 */
registerOverrides("project.update", {
  // project_update.py:27-42 default_get: the project of the context's active_id, its last update's progress and
  // status ('on_track' for a project without one) and the default description (`_build_description`)
  defaultGet: async (env, fields, vals) => {
    if (fields.includes("project_id") && !vals["project_id"]) vals["project_id"] = env.context["active_id"] ?? null;
    const projectId = vals["project_id"];
    if (!projectId) return;
    if (typeof projectId !== "number") throw new NotPorted("project.update default_get with a project that is not an id");
    const [project] = await env.model("project.project").read([projectId], ["last_update_id", "last_update_status", "allow_milestones"], "");
    if (!project) throw new NotPorted("project.update default_get of a missing project (MissingError)");
    const last = Array.isArray(project["last_update_id"]) ? project["last_update_id"][0] : project["last_update_id"];
    if (fields.includes("progress") && !vals["progress"]) {
      vals["progress"] = last ? ((await env.model("project.update").read([last as number], ["progress"], ""))[0]?.["progress"] ?? 0) : 0;
    }
    if (fields.includes("description") && !vals["description"]) {
      vals["description"] = await updateDescription(env, projectId, project["allow_milestones"] === true, typeof last === "number" ? last : null);
    }
    if (fields.includes("status") && !vals["status"]) {
      vals["status"] = project["last_update_status"] !== "to_define" ? project["last_update_status"] : "on_track";
    }
  },
  create: async (env, valsList, next) => {
    const ids = await next(env, valsList);
    const { write } = await import("../orm/write");
    for (const id of ids) {
      const project = (await env.cr.query<{ p: number | null }>("SELECT project_id AS p FROM project_update WHERE id = $1", [id])).rows[0]?.p ?? null;
      if (project === null) throw new NotPorted("project.update without a project");
      await write(env.sudo(), "project.project", [project], { last_update_id: id });
      const [counts] = await env.model("project.project").read([project], ["task_count", "open_task_count"], "");
      const taskCount = Number(counts?.["task_count"] ?? 0), open = Number(counts?.["open_task_count"] ?? 0);
      await write(env, "project.update", [id], { task_count: taskCount, closed_task_count: taskCount - open });
    }
    return ids;
  },
});

/** res_users_settings_embedded_action.py:54-66 `_embedded_action_settings_format`. */
async function embeddedActionSettingsFormat(env: Environment, ids: readonly number[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (!ids.length) return out;
  const rows = await env.model("res.users.settings.embedded.action").read([...ids],
    ["action_id", "res_id", "embedded_actions_order", "embedded_actions_visibility", "embedded_visibility"], "");
  const list = (v: unknown): (number | false)[] => (typeof v === "string" && v ? v.split(",").map((a) => (a === "false" ? false : Number.parseInt(a, 10))) : []);
  for (const r of rows) {
    const action = Array.isArray(r["action_id"]) ? r["action_id"][0] : r["action_id"];
    out[`${String(action)}+${r["res_id"] ? String(r["res_id"]) : ""}`] = {
      embedded_actions_order: list(r["embedded_actions_order"]),
      embedded_actions_visibility: list(r["embedded_actions_visibility"]),
      embedded_visibility: r["embedded_visibility"],
    };
  }
  return out;
}

// web res_users_settings.py:16-18 `get_embedded_actions_settings`, with project res_users_settings.py:7-36: on a
// project (context res_model/res_id) a user who is not its manager also gets the manager's configurations, copied
// to the user's settings (refused here: a copy is a write)
registerMethod("res.users.settings", "get_embedded_actions_settings", async (env0, ids, _a, kw) => {
  const { env } = envFor(env0, kw);
  if (!ids || ids.length !== 1) throw new NotPorted("res.users.settings.get_embedded_actions_settings on several settings (ensure_one)");
  const id = ids[0]!;
  const own = await env.model("res.users.settings.embedded.action").search(cond("user_setting_id", "=", id));
  const result = await embeddedActionSettingsFormat(env, own);
  const resModel = env.context["res_model"], resId = env.context["res_id"];
  if (!(resModel === "project.project" && resId)) return result;
  if (typeof resId !== "number") throw new NotPorted("get_embedded_actions_settings with a res_id that is not an id");
  const [project] = await env.model("project.project").read([resId], ["user_id"], "");
  // `browse(res_id).user_id` of a deleted project: the MissingError of the prefetch
  if (!project) throw new MissingError(`Record does not exist or has been deleted.\n(Record: project.project(${resId},), User: ${env.uid})`);
  const manager = project ? (Array.isArray(project["user_id"]) ? project["user_id"][0] : project["user_id"]) || false : false;
  const [settings] = await env.model("res.users.settings").read([id], ["user_id"], "");
  const settingsUser = settings ? (Array.isArray(settings["user_id"]) ? settings["user_id"][0] : settings["user_id"]) || false : false;
  if (settingsUser === manager) return result;
  const userConfigs = await env.model("res.users.settings.embedded.action").search(
    and([cond("user_setting_id", "=", id), cond("res_model", "=", resModel), cond("res_id", "=", resId)]));
  const userActions = userConfigs.length ? (await env.model("res.users.settings.embedded.action").read(userConfigs, ["action_id"], ""))
    .map((r) => (Array.isArray(r["action_id"]) ? r["action_id"][0] : r["action_id"])) : [];
  const managerSettings = manager ? (await env.cr.query<{ id: number }>("SELECT id FROM res_users_settings WHERE user_id = $1 ORDER BY id LIMIT 1", [manager])).rows[0]?.id ?? false : false;
  const managerConfigs = await env.sudo().model("res.users.settings.embedded.action").search(and([
    cond("user_setting_id", "=", managerSettings), cond("res_model", "=", resModel), cond("res_id", "=", resId),
    cond("action_id", "not in", userActions)]));
  if (managerConfigs.length) throw new NotPorted("get_embedded_actions_settings copying the project manager's embedded action settings");
  return result;
}, { apiModel: false });

// web res_users_settings.py:20-39 `set_embedded_actions_setting`: the lists as comma-separated ids ('false' for
// False), written on the user's setting of the action and record, or a new setting
registerMethod("res.users.settings", "set_embedded_actions_setting", async (env0, ids, args, kw) => {
  const { env, kwargs } = envFor(env0, kw);
  if (!ids || ids.length !== 1) throw new NotPorted("res.users.settings.set_embedded_actions_setting on several settings (ensure_one)");
  const names = ["action_id", "res_id", "vals"];
  const [actionId, resId, vals] = names.map((n, i) => (i < args.length ? args[i] : kwargs[n]));
  if (typeof actionId !== "number" || !(typeof resId === "number" || resId === false) || typeof vals !== "object" || vals === null || Array.isArray(vals)) {
    throw new NotPorted("set_embedded_actions_setting arguments");
  }
  const model = "res.users.settings.embedded.action";
  const [found] = await env.model(model).search(and([cond("user_setting_id", "=", ids[0]!), cond("action_id", "=", actionId), cond("res_id", "=", resId)]), { limit: 1 });
  const newVals: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(vals as Record<string, unknown>)) {
    if (field === "embedded_actions_order" || field === "embedded_actions_visibility") {
      if (!Array.isArray(value)) throw new NotPorted(`set_embedded_actions_setting ${field} that is not a list`);
      // `'false' if action_id is False else str(action_id)`
      newVals[field] = value.map((a) => {
        if (a === false) return "false";
        if (typeof a === "number" && Number.isInteger(a)) return String(a);
        if (typeof a === "string") return a;
        if (a === true) return "True";
        if (a === null) return "None";
        throw new NotPorted(`set_embedded_actions_setting ${field} item ${JSON.stringify(a)}`);
      }).join(",");
    } else {
      newVals[field] = value;
    }
  }
  if (found !== undefined) await write(env, model, [found], newVals);
  else await create(env, model, [{ ...newVals, user_setting_id: ids[0], action_id: actionId, res_id: resId }]);
  return null;
}, { apiModel: false });

// web res_users_settings_embedded_action.py:21-48 `_check_embedded_actions_order` / `_visibility`: the ids of the
// list are unique, and integers or 'false'
const embeddedActionsFormat = (field: string) => ({
  fields: [field],
  fn: async (env: Environment, ids: readonly number[]): Promise<void> => {
    const rows = await env.model("res.users.settings.embedded.action").read([...ids], [field], "");
    for (const r of rows) {
      const value = r[field];
      if (!value) return; // the Python method returns at the first empty value
      const parts = String(value).split(",");
      if (new Set(parts).size !== parts.length) {
        throw new ValidationError(translate(env, "The ids in %(field_name)s must not be duplicated: “%(action_ids)s”", "web")
          .replace("%(field_name)s", field).replace("%(action_ids)s", formatList(env, parts)));
      }
      for (const a of parts) {
        if (!(/^[0-9]+$/.test(a) || a === "false")) {
          throw new ValidationError(translate(env, "The ids in %(field_name)s must only be integers or \"false\": “%(action_ids)s”", "web")
            .replace("%(field_name)s", field).replace("%(action_ids)s", formatList(env, parts)));
        }
      }
    }
  },
});
registerOverrides("res.users.settings.embedded.action", {
  constraints: [embeddedActionsFormat("embedded_actions_order"), embeddedActionsFormat("embedded_actions_visibility")],
});

/**
 * project_update.py:110-147 `_build_description`: project.project_update_default_description rendered with
 * `_get_template_values` (the template reads only `show_activities` and `milestones`): `_get_milestone_values`, the
 * milestones due within a year (or without deadline) and those created since the last update, as
 * project_milestone.py:113-121 `_get_data_list`.
 */
async function updateDescription(env: Environment, projectId: number, milestones: boolean, lastUpdate: number | null): Promise<string> {
  const values = { show_activities: false, milestones: await milestoneValues(env, projectId, milestones, lastUpdate) };
  values.show_activities = values.milestones.show_section;
  // `ir.qweb._render`: with the field converters (the milestone dates' `t-options='{"widget": "date"}'`)
  const { renderQweb } = await import("../controllers/report");
  return renderQweb(env, "project.project_update_default_description", values);
}

// project_milestone.py:113-114 `_get_fields_to_export`, with sale_project project_milestone.py:52-54
const MILESTONE_EXPORT = ["id", "name", "deadline", "is_reached", "reached_date", "is_deadline_exceeded", "is_deadline_future", "can_be_marked_as_done", "sequence"];
const MILESTONE_EXPORT_SALE = ["allow_billable", "quantity_percentage", "sale_line_display_name"];

async function milestoneValues(env: Environment, projectId: number, allow: boolean, lastUpdate: number | null):
  Promise<{ show_section: boolean; list: Record<string, unknown>[]; last_update_date: unknown; created: Record<string, unknown>[] }> {
  if (!allow) return { show_section: false, list: [], last_update_date: null, created: [] };
  const fields = [...MILESTONE_EXPORT, ...(env.reg.model("project.milestone").fields.has("sale_line_display_name") ? MILESTONE_EXPORT_SALE : [])];
  const dataList = async (ids: number[]): Promise<Record<string, unknown>[]> => {
    if (!ids.length) return [];
    const rows = await env.model("project.milestone").read(ids, fields, "");
    const byId = new Map(rows.map((r) => [r["id"], r]));
    return ids.map((id) => Object.fromEntries(fields.map((f) => [f, byId.get(id)?.[f] ?? false])));
  };
  // fields.Date.context_today(self) + relativedelta(years=1): February 29 becomes the 28th
  const today = await contextToday(env);
  const [y, m, d] = today.split("-");
  const yearOn = `${Number(y) + 1}-${m}-${m === "02" && d === "29" ? "28" : d}`;
  const list = await dataList(await env.model("project.milestone").search(and([cond("project_id", "=", projectId),
    or([cond("deadline", "<", yearOn), cond("deadline", "=", false)])])));
  // `create_date > last update's` compares whole seconds (domains.py:1681-1716 `_optimize_type_datetime`: `>=` the
  // next second): a milestone created in the update's second is not "added"
  const lastCreate = lastUpdate ? ((await env.model("project.update").read([lastUpdate], ["create_date"], ""))[0]?.["create_date"] ?? false) : false;
  let domain = cond("project_id", "=", projectId);
  if (lastCreate) domain = and([domain, cond("create_date", ">", lastCreate)]);
  const created = await dataList(await env.model("project.milestone").search(domain));
  return { show_section: list.length > 0 || created.length > 0, list, last_update_date: lastCreate || null, created };
}
