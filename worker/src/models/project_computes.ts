/**
 * project.project and project.task non-stored computes and searches (odoo/addons/project/models/,
 * html_editor/models/html_field_history_mixin.py, mail alias/activity mixins).
 */
import { NotPorted } from "../errors";
import { and, cond, isNegativeOperator, not, or } from "../orm/domain";
import { envTz } from "../orm/env";
import { hooksOf, registerHooks } from "../orm/hooks";
import { DbRec, NewRec, type Rec, registerDefaults, registerOnchange, registerRecordCompute } from "../orm/recompute";
import { userHasGroup } from "../web/groups";
import type { Domain, Environment } from "../orm/types";
import { sql, type Sql, type Table } from "../orm/sql";
import { registerOverrides } from "../orm/write";
import { registerActivityMixin, registerActivityMixinNewRecords } from "./crm_activity";
import { defineComputes, filteredAccess, formatPosix, getLang, registerAliasMixin, registerIsFollower, registerNeedaction, searchMethod } from "./tail_util";
import { formatAddress } from "./mail_address";
import { rottingOf } from "./rotting";
import { datetimeToString, dbNow, htmlEscape, todayInTz, translate } from "./util";

/** project_task.py:85-88 CLOSED_STATES */
const CLOSED_STATES = new Set(["1_done", "1_canceled"]);

defineComputes("project.task", {
  // project_task.py:462-470 _compute_personal_stage_id: the user's personal stage of the task (searched as the user)
  personal_stage_id: async (env, rec) => {
    if (rec.id === null) return null;
    const stages = await env.model("project.task.stage.personal").search(and([cond("user_id", "=", env.uid), cond("task_id", "in", [rec.id])]));
    if (stages.length === 0) return null;
    // the last assignment wins (`for personal_stage in personal_stages: ... = personal_stage`), in the model's _order
    return stages[stages.length - 1] ?? null;
  },
  // html_field_history_mixin.py:28-40 _compute_metadata: the revisions without their patch
  html_field_history_metadata: async (_env, rec) => htmlHistoryMetadata(await rec.get("html_field_history")),
});

/** html_field_history_mixin.py:28-40 */
export function htmlHistoryMetadata(history: unknown): unknown {
  if (!history || typeof history !== "object" || Array.isArray(history) || Object.keys(history).length === 0) return null;
  const out: Record<string, unknown[]> = {};
  for (const [field, revisions] of Object.entries(history as Record<string, unknown>)) {
    if (!Array.isArray(revisions)) throw new NotPorted(`html_field_history of ${field} is not a list`);
    out[field] = revisions.map((r: unknown) => {
      if (!r || typeof r !== "object") throw new NotPorted("html_field_history revision is not a dict");
      const copy: Record<string, unknown> = { ...(r as Record<string, unknown>) };
      if (!("patch" in copy)) throw new Error("KeyError: 'patch'");
      delete copy["patch"];
      return copy;
    });
  }
  return out;
}

registerHooks("project.task", {
  search: {
    // project_task.py:472-478 _search_personal_stage_id
    personal_stage_id: searchMethod("project.task", "personal_stage_id", async (env, operator, value) => {
      if (isNegativeOperator(operator)) return null;
      const values = Array.isArray(value) ? value : [value];
      const fieldName = values.some((v) => typeof v === "string") || value === "" ? "display_name" : "id";
      const stages = await env.model("project.task.stage.personal").search(and([cond(fieldName, operator, value), cond("user_id", "=", env.uid)]));
      const tasks = stages.length === 0 ? [] : (await env.cr.query<{ task_id: number }>(
        "SELECT task_id FROM project_task_user_rel WHERE id = ANY($1::int[])", [stages])).rows.map((r) => r.task_id);
      return cond("id", "in", tasks);
    }),
  },
});

/** project_project.py:259-296 _compute_next_milestone_id (with project_milestone.py:42-46 is_deadline_exceeded). */
async function milestoneInfo(env: Environment, rec: Rec): Promise<{ next: number | null; exceeded: boolean; done: boolean }> {
  if (rec.id === null) return { next: null, exceeded: false, done: false };
  const milestones = await env.model("project.milestone").search(and([cond("project_id", "in", [rec.id]), cond("is_reached", "=", false)]));
  if (milestones.length === 0) return { next: null, exceeded: false, done: false };
  const tasks = await env.model("project.task").search(and([cond("milestone_id.project_id", "in", [rec.id]), cond("milestone_id.is_reached", "=", false)]));
  const counts = new Map<number, [number, number]>();
  if (tasks.length) {
    for (const t of (await env.cr.query<{ milestone_id: number; state: string | null }>(
      "SELECT milestone_id, state FROM project_task WHERE id = ANY($1::int[])", [tasks])).rows) {
      const [open, closed] = counts.get(t.milestone_id) ?? [0, 0];
      counts.set(t.milestone_id, t.state !== null && CLOSED_STATES.has(t.state) ? [open, closed + 1] : [open + 1, closed]);
    }
  }
  const rows = new Map((await env.cr.query<{ id: number; deadline: string | null; is_reached: boolean | null }>(
    "SELECT id, deadline::text AS deadline, is_reached FROM project_milestone WHERE id = ANY($1::int[])", [milestones])).rows.map((r) => [r.id, r]));
  const today = todayInTz(await dbNow(env), await envTz(env));
  let exceeded = false, done = false;
  for (const id of milestones) {
    const m = rows.get(id)!;
    const [open, closed] = counts.get(id) ?? [0, 0];
    const deadlineExceeded = !m.is_reached && m.deadline !== null && m.deadline < today;
    if (!exceeded && deadlineExceeded && (open > 0 || closed === 0)) { exceeded = true; break; }
    if (!done && open === 0 && closed > 0) done = true;
  }
  return { next: milestones[0] ?? null, exceeded, done };
}

defineComputes("project.project", {
  next_milestone_id: async (env, rec) => (await milestoneInfo(env, rec)).next,
  can_mark_milestone_as_done: async (env, rec) => (await milestoneInfo(env, rec)).done,
  is_milestone_deadline_exceeded: async (env, rec) => (await milestoneInfo(env, rec)).exceeded,
  // project_project.py:427-437 _compute_access_instruction_message
  access_instruction_message: async (env, rec) => {
    switch (await rec.get("privacy_visibility")) {
      case "portal": return translate(env, "All internal users have access to the project. Invite portal users as collaborators to give them access. They can also access tasks they follow.");
      case "followers": return translate(env, "Add internal users as team members to give them access to the project. They can also access tasks they follow.");
      case "invited_users": return translate(env, "Add internal users as team members and invite portal users as collaborators to give them access to the project. They can also access tasks they follow.");
      default: return "";
    }
  },
});

registerAliasMixin("project.project");
for (const model of ["project.project", "project.task", "project.update"]) {
  registerActivityMixin(model);
  registerActivityMixinNewRecords(model);
  registerNeedaction(model);
  registerIsFollower(model);
}

/** `context['default_project_id']` when it is a project id. */
function defaultProject(env: Environment): number | null {
  const v = env.context["default_project_id"];
  if (v === undefined || v === null || v === false || v === 0) return null;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new NotPorted(`project.task default with default_project_id=${String(v)}`);
  return v;
}

registerDefaults("project.task", {
  // project_task.py:121-127 _get_default_stage_id with project_project.py:1151-1157 _get_default_task_stage
  stage_id: async (env) => {
    const project = defaultProject(env);
    if (project === null) return false;
    const [stage] = await env.model("project.task.type").search(cond("project_ids", "=", project), { order: "fold, sequence, id", limit: 1 });
    return stage ?? false;
  },
  // project_task.py:129-131 _default_user_ids
  user_ids: async (env) =>
    "default_personal_stage_type_ids" in env.context || "default_personal_stage_type_id" in env.context ? [[6, 0, [env.uid]]] : [[6, 0, []]],
  // project_task.py:133-137 _default_company_id: the default project's company
  company_id: async (env) => {
    const project = defaultProject(env);
    if (project === null) return false;
    const [row] = await env.model("project.project").read([project], ["company_id"], "");
    return row?.["company_id"] ?? false;
  },
});

async function groupId(env: Environment, xmlid: string): Promise<number> {
  const id = await env.reg.xmlid(env.cr, xmlid);
  if (id === null) throw new NotPorted(`env.ref('${xmlid}') of a missing record (ValueError)`);
  return id;
}

registerHooks("project.project", {
  // registerHooks replaces descriptionDomain as a whole (hooks.ts): keep the ones registered before
  descriptionDomain: {
    ...hooksOf("project.project").descriptionDomain,
    // project_project.py:164 the f-string domain with env.ref('project.group_project_user').id
    allowed_internal_user_ids: async (env) =>
      `[('share', '=', False), ('group_ids', 'in', ${await groupId(env, "project.group_project_user")}), ('company_ids', '=?', company_id)]`,
  },
});
registerHooks("project.role", {
  // registerHooks replaces descriptionDomain as a whole (hooks.ts): keep the ones registered before
  descriptionDomain: {
    ...hooksOf("project.role").descriptionDomain,
    // project_role.py:23
    user_ids: async (env) => [["all_group_ids", "=", await groupId(env, "project.group_project_user")]],
  },
});

/**
 * project_project.py:36-63 `__compute_task_count`: tasks of the project without template ancestor, counted as the
 * user with active_test = the project's `active` (Python: any project of the batch active; a single record here).
 */
function taskCount(extra: "all" | "open" | "closed") {
  return async (env: Environment, rec: Rec): Promise<number> => {
    if (rec.id === null) return 0;
    const parts = [cond("project_id", "in", [rec.id]), cond("has_template_ancestor", "=", false)];
    if (extra !== "all") {
      const states = (env.reg.model("project.task").fields.get("state")?.selection ?? []).map((s) => s.value);
      parts.push(cond("state", "in", extra === "closed" ? [...CLOSED_STATES] : states.filter((s) => !CLOSED_STATES.has(s))));
    }
    const active = Boolean(await rec.get("active"));
    return env.withContext({ ...env.context, active_test: active }).model("project.task").searchCount(and(parts));
  };
}

defineComputes("project.project", {
  task_count: taskCount("all"),
  open_task_count: taskCount("open"),
  closed_task_count: taskCount("closed"),
  // project_project.py:86-89 _compute_is_favorite: the project is in env.user.favorite_project_ids
  is_favorite: async (env, rec) => {
    if (rec.id === null) return false; // a new record is not in a recordset of database records
    return (await env.cr.query("SELECT 1 FROM project_favorite_user_rel WHERE project_id = $1 AND user_id = $2", [rec.id, env.uid])).rows.length > 0;
  },
});
registerHooks("project.project", {
  search: {
    // project_project.py:80-84 _search_is_favorite: only `in`, whatever the value
    is_favorite: searchMethod("project.project", "is_favorite", async (env, operator) =>
      operator === "in" ? cond("favorite_user_ids", "in", [env.uid]) : null),
  },
  computeSql: {
    // project_project.py:91-95 _compute_sql_is_favorite
    is_favorite: async (table: Table): Promise<Sql> =>
      sql`${table.id} IN (SELECT project_id FROM project_favorite_user_rel WHERE user_id = ${table.env.uid})`,
  },
});

registerRecordCompute("project.project", {
  // project_project.py:303-310 _compute_company_id (stored): the analytic account's company, else the customer's
  company_id: async (_env, rec) => {
    let company = await rec.prev("company_id");
    const account = await rec.rel("account_id");
    const accountCompany = account ? await account.get("company_id") : null;
    if (accountCompany) company = accountCompany;
    if (!company) {
      const partner = await rec.rel("partner_id");
      const partnerCompany = partner ? await partner.get("company_id") : null;
      if (partnerCompany) company = partnerCompany;
    }
    return company || null;
  },
  // project_project.py:312-320 _compute_allowed_internal_user_ids (stored): keep the users of the company, add the
  // project manager for private visibilities
  allowed_internal_user_ids: async (env, rec) => {
    const prev = await rec.prev("allowed_internal_user_ids");
    let users = Array.isArray(prev) ? prev.filter((u): u is number => typeof u === "number") : [];
    if (Array.isArray(prev) && users.length !== prev.length) throw new NotPorted("project.project.allowed_internal_user_ids with new users");
    const company = await rec.get("company_id");
    if (company && users.length) {
      const rows = (await env.cr.query<{ user_id: number }>(
        "SELECT user_id FROM res_company_users_rel WHERE cid = $1 AND user_id = ANY($2::int[])", [company, users])).rows;
      const keep = new Set(rows.map((r) => r.user_id));
      users = users.filter((u) => keep.has(u));
    }
    const manager = await rec.get("user_id");
    const visibility = await rec.get("privacy_visibility");
    if (typeof manager === "number" && manager && (visibility === "followers" || visibility === "invited_users") && !users.includes(manager)) users.push(manager);
    return users;
  },
});

defineComputes("project.project", {
  // project_project.py:378-387 _compute_is_milestone_exceeded: unreached milestones due by today (as the user)
  is_milestone_exceeded: async (env, rec) => {
    if (rec.id === null || !(await rec.get("allow_milestones"))) return false;
    const today = todayInTz(await dbNow(env), await envTz(env));
    return (await env.model("project.milestone").searchCount(and([
      cond("project_id", "in", [rec.id]), cond("is_reached", "=", false), cond("deadline", "<=", today)]))) > 0;
  },
});
registerHooks("project.project", {
  search: {
    // project_project.py:401-413 _search_is_milestone_exceeded: `id any (SQL subquery)`, the subquery's ids here
    is_milestone_exceeded: searchMethod("project.project", "is_milestone_exceeded", async (env, operator) => {
      if (operator !== "in") return null;
      const ids = (await env.cr.query<{ id: number }>(
        `SELECT P.id FROM project_project P LEFT JOIN project_milestone M ON P.id = M.project_id
          WHERE M.is_reached IS false AND P.allow_milestones IS true AND M.deadline <= CAST(now() AS date)`)).rows.map((r) => r.id);
      return cond("id", "in", [...new Set(ids)]);
    }),
  },
});

defineComputes("project.task", {
  // project_task.py:847-850 _compute_has_template_ancestor
  has_template_ancestor: async (env, rec) => {
    if (await rec.get("is_template")) return true;
    const parent = await rec.rel("parent_id");
    if (!parent || parent.origin === null) return false;
    return Boolean(await new DbRec(env.sudo(), env.reg.model("project.task"), parent.origin).get("has_template_ancestor"));
  },
});
registerHooks("project.task", {
  search: {
    // project_task.py:857-864 _search_has_template_ancestor ('=' / '!=' with a bool; `in` reaches it through the
    // '='-compatibility path of domains.py:1101, one value at a time)
    has_template_ancestor: async (env, operator, value) => {
      const one = async (op: string, v: unknown): Promise<Domain> => {
        if ((op !== "=" && op !== "!=") || typeof v !== "boolean") throw new NotPorted(`project.task.has_template_ancestor ${op} ${String(v)} (NotImplemented)`);
        const templates = await env.sudo().withContext({ ...env.context, active_test: false }).model("project.task")
          .search(cond("is_template", "=", true), { activeTest: false });
        const domain = cond("id", "child_of", templates);
        return (op === "=") !== v ? not(domain) : domain;
      };
      if ((operator === "in" || operator === "not in") && Array.isArray(value)) {
        const parts: Domain[] = [];
        for (const v of value) parts.push(await one(operator === "in" ? "=" : "!=", v));
        return operator === "in" ? or(parts) : and(parts);
      }
      return one(operator, value);
    },
  },
});

/** project_update.py:9-18 STATUS_COLOR */
const STATUS_COLOR: Readonly<Record<string, number>> = { on_track: 20, at_risk: 22, off_track: 23, on_hold: 21, done: 24, to_define: 0 };

defineComputes("project.project", {
  // project_project.py:355-358 _compute_last_update_color
  last_update_color: async (_env, rec) => {
    const status = await rec.get("last_update_status");
    if (!status) return 0; // STATUS_COLOR[False]
    const color = STATUS_COLOR[String(status)];
    if (color === undefined) throw new Error(`KeyError: '${String(status)}'`);
    return color;
  },
  // sale_project project_project.py:167-170 _compute_display_sales_stat_buttons: `allow_billable and partner_id`
  display_sales_stat_buttons: async (_env, rec) => Boolean((await rec.get("allow_billable")) && (await rec.get("partner_id"))),
  // project_project.py:389-394 _compute_currency_id (compute_sudo): the company's currency, else env.company's
  currency_id: async (env, rec) => {
    const company = await rec.get("company_id");
    const id = typeof company === "number" && company ? company : null;
    const currencyOf = async (c: number): Promise<number | null> =>
      (await env.cr.query<{ currency_id: number | null }>("SELECT currency_id FROM res_company WHERE id = $1", [c])).rows[0]?.currency_id ?? null;
    return (id !== null ? await currencyOf(id) : null) ?? currencyOf(await env.company());
  },
});
registerHooks("project.project", {
  computeSql: {
    // project_project.py:396-397 _compute_sql_currency_id
    currency_id: async (table: Table): Promise<Sql> => {
      const env = table.env;
      const current = (await env.cr.query<{ currency_id: number | null }>("SELECT currency_id FROM res_company WHERE id = $1", [await env.company()])).rows[0]?.currency_id ?? null;
      return sql`COALESCE((SELECT c.currency_id FROM res_company c WHERE c.id = ${await table.field("company_id")}), ${current}::int)`;
    },
  },
});

registerRecordCompute("project.project", {
  // sale_project project_project.py:78-83 _compute_partner_id (stored): cleared without billing or across companies
  partner_id: async (env, rec) => {
    const partner = await rec.prev("partner_id");
    if (!(await rec.get("allow_billable"))) return null;
    const company = await rec.get("company_id");
    if (company && typeof partner === "number" && partner) {
      const partnerCompany = (await env.cr.query<{ company_id: number | null }>("SELECT company_id FROM res_partner WHERE id = $1", [partner])).rows[0]?.company_id ?? null;
      if (partnerCompany && partnerCompany !== company) return null;
    }
    return partner || null;
  },
});

defineComputes("project.task", {
  // portal_mixin.py:30-32 then project_task.py:648-651 _compute_access_url
  access_url: async (_env, rec) => {
    if (rec.id === null) throw new NotPorted("project.task.access_url of a new task (NewId repr)");
    return `/my/tasks/${rec.id}`;
  },
});
defineComputes("project.project", {
  // portal_mixin.py:30-32 then project_project.py:297-301 _compute_access_url
  access_url: async (_env, rec) => {
    if (rec.id === null) throw new NotPorted("project.project.access_url of a new project (NewId repr)");
    return `/my/projects/${rec.id}`;
  },
});

/** project_project.py:360-377: milestones of the project (as the user), all and reached. */
async function milestoneCounts(env: Environment, rec: Rec): Promise<{ all: number; reached: number }> {
  if (rec.id === null) return { all: 0, reached: 0 };
  const all = await env.model("project.milestone").searchCount(cond("project_id", "in", [rec.id]));
  const reached = await env.model("project.milestone").searchCount(and([cond("project_id", "in", [rec.id]), cond("is_reached", "=", true)]));
  return { all, reached };
}
defineComputes("project.project", {
  milestone_count: async (env, rec) => (await milestoneCounts(env, rec)).all,
  milestone_count_reached: async (env, rec) => (await milestoneCounts(env, rec)).reached,
  // `milestone_count and reached * 100 // milestone_count`
  milestone_progress: async (env, rec) => {
    const c = await milestoneCounts(env, rec);
    return c.all ? Math.floor((c.reached * 100) / c.all) : 0;
  },
});

/** project_task.py:658-678 _compute_subtask_count. */
async function subtaskCounts(env: Environment, rec: Rec): Promise<[number, number]> {
  if (rec.id === null) {
    const children = await rec.rels("child_ids");
    let closed = 0;
    for (const c of children) if (CLOSED_STATES.has(String(await c.get("state")))) closed++;
    return [children.length, closed];
  }
  const ids = await env.model("project.task").search(and([
    cond("parent_id", "in", [rec.id]),
    or([cond("parent_id.is_template", "=", true), cond("is_template", "=", false)]),
  ]));
  if (ids.length === 0) return [0, 0];
  const rows = (await env.cr.query<{ state: string | null }>("SELECT state FROM project_task WHERE id = ANY($1::int[])", [ids])).rows;
  return [ids.length, rows.filter((r) => r.state !== null && CLOSED_STATES.has(r.state)).length];
}
defineComputes("project.task", {
  subtask_count: async (env, rec) => (await subtaskCounts(env, rec))[0],
  closed_subtask_count: async (env, rec) => (await subtaskCounts(env, rec))[1],
});

registerHooks("project.milestone", {
  // project_milestone.py:132-141 _compute_display_name: the name, with the deadline (format_date, misc.py:1378-1419)
  // when the context asks for it
  displayName: async (env, ids) => {
    const rows = (await env.cr.query<{ id: number; name: string | null; deadline: string | null }>(
      "SELECT id, name, deadline::text AS deadline FROM project_milestone WHERE id = ANY($1::int[])", [ids])).rows;
    const out = new Map<number, string>();
    const withDeadline = Boolean(env.context["display_milestone_deadline"]);
    const lang = withDeadline ? await getLang(env) : null;
    for (const r of rows) {
      let name = r.name ?? "";
      if (withDeadline && r.deadline && lang) {
        const [y, mo, d] = r.deadline.split("-").map(Number) as [number, number, number];
        const date = formatPosix(lang.dateFormat, { y, mo, d, h: 0, mi: 0, s: 0 }, lang.code);
        name = env.context["formatted_display_name"] ? `${name} \t --${date}--` : `${name} - ${date}`;
      }
      out.set(r.id, name);
    }
    return out;
  },
});

defineComputes("project.task", {
  // project_task.py:2277-2286 _compute_project_sharing_portal_user_ids: share users of the edit collaborators
  project_sharing_portal_user_ids: async (env, rec) => {
    const project = await rec.get("project_id");
    if (!project) return [];
    const collabs = (await env.cr.query<{ partner_id: number }>(
      "SELECT partner_id FROM project_collaborator WHERE project_id = $1 AND access_mode IN ('edit', 'advanced_edit') ORDER BY id", [project])).rows;
    const out: number[] = [];
    for (const c of collabs) {
      // res.partner.user_ids (active users), in res.users _order (name, login: the partner's name is shared)
      const users = (await env.cr.query<{ id: number; share: boolean | null }>(
        "SELECT u.id, u.share FROM res_users u WHERE u.partner_id = $1 AND u.active ORDER BY u.login", [c.partner_id])).rows;
      if (users.length > 1) throw new NotPorted("project.task.project_sharing_portal_user_ids with several users per partner");
      for (const u of users) if (u.share && !out.includes(u.id)) out.push(u.id);
    }
    return out;
  },
});

/**
 * sale_project project_project.py:372-444 `_fetch_sale_order_items({'project.task': [('is_closed', '=', False)]})`:
 * the distinct sale lines of the project, its open tasks, its billable milestones and the lines of its orders.
 */
async function projectSaleLines(env: Environment, rec: Rec): Promise<number[]> {
  if (rec.id === null || !(await rec.get("allow_billable"))) return [];
  const p = rec.id;
  const lines = new Set<number>();
  const add = async (model: string, domain: Domain, column: string): Promise<void> => {
    const ids = await env.model(model).search(domain);
    if (ids.length === 0) return;
    const table = env.reg.model(model).table;
    for (const r of (await env.cr.query<{ v: number | null }>(`SELECT "${column}" AS v FROM "${table}" WHERE id = ANY($1::int[])`, [ids])).rows) if (r.v) lines.add(r.v);
  };
  await add("project.project", and([cond("id", "in", [p]), cond("sale_line_id", "!=", false)]), "sale_line_id");
  await add("project.task", and([cond("is_closed", "=", false), cond("project_id", "in", [p]), cond("sale_line_id", "!=", false)]), "sale_line_id");
  await add("project.milestone", and([cond("project_id", "in", [p]), cond("allow_billable", "=", true), cond("sale_line_id", "!=", false)]), "sale_line_id");
  const reinvoiced = await rec.get("reinvoiced_sale_order_id");
  const orderDomain = or([cond("id", "in", typeof reinvoiced === "number" && reinvoiced ? [reinvoiced] : []), cond("project_id", "in", [p])]);
  // bypass_access=True: the lines whatever the user's rights
  for (const id of await env.sudo().model("sale.order.line").search(and([cond("display_type", "=", false), cond("order_id", "any", orderDomain)]))) lines.add(id);
  return [...lines].sort((a, b) => a - b);
}

/** sale_project_margin project_project.py:10-15 _compute_estimated_cost */
async function estimatedCost(env: Environment, rec: Rec): Promise<{ cost: number; ratio: number }> {
  const lines = await projectSaleLines(env, rec);
  if (lines.length === 0) return { cost: 0, ratio: 0 };
  // the lines are read as the user (mapped on the browsed records)
  if ((await filteredAccess(env, "sale.order.line", lines, "read")).size !== lines.length) throw new NotPorted("project.project.estimated_cost over sale lines the user cannot read (AccessError)");
  const rows = (await env.cr.query<{ id: number; price_subtotal: number | null; purchase_price: number | null; product_uom_qty: number | null }>(
    "SELECT id, price_subtotal::float8 AS price_subtotal, purchase_price::float8 AS purchase_price, product_uom_qty::float8 AS product_uom_qty FROM sale_order_line WHERE id = ANY($1::int[]) ORDER BY id", [lines])).rows;
  let sold = 0, cost = 0;
  for (const r of rows) { sold += r.price_subtotal ?? 0; cost += (r.purchase_price ?? 0) * (r.product_uom_qty ?? 0); }
  return { cost, ratio: sold ? 100 * (cost / sold) : 0 };
}
defineComputes("project.project", {
  estimated_cost: async (env, rec) => (await estimatedCost(env, rec)).cost,
  estimated_cost_ratio: async (env, rec) => (await estimatedCost(env, rec)).ratio,
});

defineComputes("project.task", {
  // project_task.py:415-418 _compute_is_closed
  is_closed: async (_env, rec) => CLOSED_STATES.has(String(await rec.get("state"))),
});
registerHooks("project.task", {
  search: {
    // project_task.py:420-427 _search_is_closed (the value is not looked at)
    is_closed: searchMethod("project.task", "is_closed", async (env, operator) => {
      if (operator === "in") return cond("state", "in", [...CLOSED_STATES]);
      if (operator === "not in") {
        const states = (env.reg.model("project.task").fields.get("state")?.selection ?? []).map((s) => s.value);
        return cond("state", "in", states.filter((s) => !CLOSED_STATES.has(s)));
      }
      return null;
    }),
  },
});

/** werkzeug url_encode as patched by odoo/_monkeypatches/werkzeug.py:465-490, 560-591 (quote_plus of the UTF-8 bytes). */
function urlEncode(pairs: readonly [string, string][]): string {
  const quote = (s: string): string => {
    let out = "";
    for (const c of Buffer.from(s, "utf8")) {
      const ch = String.fromCharCode(c);
      if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
      else if (ch === " ") out += "+";
      else out += `%${c.toString(16).toUpperCase().padStart(2, "0")}`;
    }
    return out;
  };
  return pairs.map(([k, v]) => `${quote(k)}=${quote(v)}`).join("&");
}

defineComputes("project.project", {
  // project_project.py:245-258 _compute_google_map_iframe: the customer's address (res_partner.py:1291-1323
  // `_display_address(without_name=True, separator=' ')`) in an embedded map
  google_map_iframe: async (env, rec) => {
    const partner = await rec.get("partner_id");
    if (typeof partner !== "number" || !partner) return false;
    const lang = env.lang ?? "en_US";
    const r = (await env.cr.query<{ street: string | null; street2: string | null; zip: string | null; city: string | null;
      state_code: string | null; state_name: string | null; country_code: string | null; country_name: string | null; address_format: string | null }>(
      `SELECT p.street, p.street2, p.zip, p.city, s.code AS state_code, s.name AS state_name, c.code AS country_code,
              COALESCE(c.name->>$2, c.name->>'en_US') AS country_name, c.address_format
         FROM res_partner p LEFT JOIN res_country_state s ON s.id = p.state_id LEFT JOIN res_country c ON c.id = p.country_id
        WHERE p.id = $1`, [partner, lang])).rows[0];
    if (!r) return false;
    if ((env.reg.model("res.partner").modules ?? []).includes("base_address_extended") && /street_(name|number)/.test(r.address_format ?? "")) {
      throw new NotPorted("project.project.google_map_iframe with a base_address_extended street format");
    }
    const address = formatAddress(r.address_format || "%(street)s\n%(street2)s\n%(city)s %(state_code)s %(zip)s\n%(country_name)s", {
      street: r.street ?? "", street2: r.street2 ?? "", zip: r.zip ?? "", city: r.city ?? "", state_code: r.state_code ?? "",
      state_name: r.state_name ?? "", country_code: r.country_code ?? "", country_name: r.country_name ?? "", parent_name: "",
    }, " ");
    if (!address) return false;
    // Markup.format escapes the plain-str query string (markupsafe escape: & < > " ')
    const params = htmlEscape(urlEncode([["q", address], ["output", "embed"]]));
    return `\n                <iframe\n                    loading="lazy"\n                    src="https://www.google.com/maps?${params}">\n                </iframe>\n            `;
  },
});

registerOverrides("project.task", {
  // project_task.py:1038-1076 default_get
  defaultGet: async (env, fields, vals) => {
    if (fields.includes("state") && vals["state"] === "04_waiting_normal") vals["state"] = "01_in_progress";
    if (fields.includes("repeat_until")) {
      const today = todayInTz(await dbNow(env), await envTz(env));
      vals["repeat_until"] = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
    }
    if ("partner_id" in vals && !vals["partner_id"]) {
      const parentId = "parent_id" in vals ? vals["parent_id"] : env.context["default_parent_id"];
      const projId = vals["project_id"];
      if (projId || parentId) {
        // project_task.py:115-120 _get_default_partner_id: parent's partner, else project's partner
        let partnerId: number | null = null;
        if (typeof parentId === "number" && parentId) {
          partnerId = (await env.cr.query<{ p: number | null }>("SELECT partner_id AS p FROM project_task WHERE id = $1", [parentId])).rows[0]?.p ?? null;
        }
        if (!partnerId && typeof projId === "number" && projId) {
          partnerId = (await env.cr.query<{ p: number | null }>("SELECT partner_id AS p FROM project_project WHERE id = $1", [projId])).rows[0]?.p ?? null;
        }
        if (partnerId) vals["partner_id"] = partnerId;
      }
    }
    const projectId = "project_id" in vals ? vals["project_id"] : env.context["default_project_id"];
    if (projectId) {
      if (fields.includes("company_id") && !("default_project_id" in env.context)) {
        if (typeof projectId !== "number") throw new NotPorted("project.task default_get with a non-id project");
        const c = (await env.cr.query<{ company_id: number | null }>("SELECT company_id FROM project_project WHERE id = $1", [projectId])).rows[0]?.company_id ?? null;
        vals["company_id"] = c ?? false;
      }
    } else if (!("default_user_ids" in env.context) && fields.includes("user_ids")) {
      const current = vals["user_ids"];
      const list = Array.isArray(current) ? [...current] : [];
      list.push([4, env.uid, 0]); // Command.link(env.user.id)
      vals["user_ids"] = list;
    }
    const parentId = "parent_id" in vals ? vals["parent_id"] : env.context["default_parent_id"];
    if (typeof parentId === "number" && parentId && !vals["tag_ids"]) {
      const tags = (await env.cr.query<{ tag_id: number }>(
        "SELECT project_tags_id AS tag_id FROM project_tags_project_task_rel WHERE project_task_id = $1 ORDER BY project_tags_id", [parentId])).rows.map((r) => r.tag_id);
      if (tags.length) vals["tag_ids"] = [[6, 0, tags]];
    }
  },
});

defineComputes("project.project", {
  // sale_project project_project.py:134-143 _compute_has_any_so_to_invoice with :110-132 _get_projects_for_invoice_status
  has_any_so_to_invoice: async (env, rec) => {
    if (rec.id === null) return false;
    const rows = (await env.cr.query(
      `SELECT id FROM project_project pp WHERE pp.active = true
         AND (EXISTS(SELECT 1 FROM sale_order so JOIN project_task pt ON pt.sale_order_id = so.id
                      WHERE pt.project_id = pp.id AND pt.active = true AND so.invoice_status = 'to invoice')
              OR EXISTS(SELECT 1 FROM sale_order so JOIN sale_order_line sol ON sol.order_id = so.id
                      WHERE sol.id = pp.sale_line_id AND so.invoice_status = 'to invoice'))
         AND id = $1`, [rec.id])).rows;
    return rows.length > 0;
  },
});

defineComputes("project.project", {
  // sale_project project_project.py:312-321 _compute_has_any_so_with_nothing_to_invoice (:110-132 with 'no')
  has_any_so_with_nothing_to_invoice: async (env, rec) => {
    if (rec.id === null) return false;
    return (await env.cr.query(
      `SELECT id FROM project_project pp WHERE pp.active = true
         AND (EXISTS(SELECT 1 FROM sale_order so JOIN project_task pt ON pt.sale_order_id = so.id
                      WHERE pt.project_id = pp.id AND pt.active = true AND so.invoice_status = 'no')
              OR EXISTS(SELECT 1 FROM sale_order so JOIN sale_order_line sol ON sol.order_id = so.id
                      WHERE sol.id = pp.sale_line_id AND so.invoice_status = 'no'))
         AND id = $1`, [rec.id])).rows.length > 0;
  },
});

/** project_milestone.py:42-46 _compute_is_deadline_exceeded */
export async function milestoneDeadlineExceeded(env: Environment, m: Rec): Promise<boolean> {
  const deadline = await m.get("deadline");
  if (await m.get("is_reached") || typeof deadline !== "string" || !deadline) return false;
  return deadline < todayInTz(await dbNow(env), await envTz(env));
}
/** project_milestone.py:64-88 _compute_can_be_marked_as_done (tasks counted as the user) */
export async function milestoneCanBeDone(env: Environment, m: Rec): Promise<boolean> {
  if (await m.get("is_reached")) return false;
  if (m.id === null) {
    for (const t of await m.rels("task_ids")) if (!CLOSED_STATES.has(String(await t.get("state")))) return false;
    return true;
  }
  const tasks = await env.model("project.task").search(cond("milestone_id", "in", [m.id]));
  if (tasks.length === 0) return false;
  const states = (await env.cr.query<{ state: string | null }>("SELECT state FROM project_task WHERE id = ANY($1::int[])", [tasks])).rows;
  const closed = states.filter((s) => s.state !== null && CLOSED_STATES.has(s.state)).length;
  return closed > 0 && closed === states.length;
}
// the other computes of project.milestone: src/models/project_milestone.ts (round 11)
// project_update.py:65-68 _compute_color
defineComputes("project.update", {
  color: async (_env, rec) => {
    const status = await rec.get("status");
    if (!status) return 0;
    const color = STATUS_COLOR[String(status)];
    if (color === undefined) throw new NotPorted(`project.update color of status ${String(status)}`);
    return color;
  },
});
defineComputes("project.project", {
  // project_project.py:232-243 _compute_next_milestone_info
  next_milestone_status: async (env, rec) => {
    const next = (await milestoneInfo(env, rec)).next;
    if (next === null) return false;
    const m = new DbRec(env, env.reg.model("project.milestone"), next);
    if (await milestoneDeadlineExceeded(env, m)) return "off_track";
    if (await milestoneCanBeDone(env, m)) return "next_track";
    return "on_track";
  },
});

/**
 * rating_parent_mixin.py:31-55 _compute_rating_percentage_satisfaction (compute_sudo) with project_project.py:35
 * `_rating_satisfaction_days = 30` and rating_data.py:57-64 `_rating_to_grade`.
 */
async function parentRatingStats(env: Environment, rec: Rec): Promise<{ count: number; satisfaction: number; avg: number }> {
  if (rec.id === null) return { count: 0, satisfaction: -1, avg: 0 };
  const since = datetimeToString(new Date(Math.floor((await dbNow(env)).getTime() / 1000) * 1000 - 30 * 86400000));
  const rows = (await env.cr.query<{ rating: number; n: string }>(
    `SELECT rating::float8 AS rating, count(*)::text AS n FROM rating_rating
      WHERE parent_res_model = 'project.project' AND parent_res_id = $1 AND rating >= 1 AND consumed IS TRUE AND write_date >= $2
      GROUP BY rating`, [rec.id, since])).rows;
  let count = 0, great = 0, score = 0;
  for (const r of rows) {
    const n = Number(r.n);
    count += n; score += r.rating * n;
    if (r.rating >= 4) great += n;
  }
  return { count, satisfaction: count ? Math.trunc((great * 100) / count) : -1, avg: count ? score / count : 0 };
}
defineComputes("project.project", {
  rating_count: async (env, rec) => (await parentRatingStats(env, rec)).count,
  rating_percentage_satisfaction: async (env, rec) => (await parentRatingStats(env, rec)).satisfaction,
  rating_avg: async (env, rec) => (await parentRatingStats(env, rec)).avg,
  rating_avg_percentage: async (env, rec) => (await parentRatingStats(env, rec)).avg / 5,
  // project_purchase project_project.py:8-37 _compute_purchase_orders_count
  purchase_orders_count: async (env, rec) => {
    if (rec.id === null) return 0;
    const orders = await env.model("purchase.order").search(and([cond("project_id", "in", [rec.id]), cond("order_line", "!=", false)]));
    const account = await rec.get("account_id");
    if (typeof account !== "number" || !account) return orders.length;
    // :35 keys the order counts by account: another project on the same account in the batch overrides it
    const shared = await env.cr.query("SELECT 1 FROM project_project WHERE account_id = $1 AND id <> $2 LIMIT 1", [account, rec.id]);
    if (shared.rows.length) throw new NotPorted("project.project.purchase_orders_count of projects sharing an analytic account");
    // :20-29 lines whose distribution keys hold the account (analytic_mixin.py:43-47, 109-116), outside those orders,
    // grouped by account over DISTINCT order_id (analytic_mixin.py:126-143, 152-157): the count of their orders
    const lines = (await env.cr.query<{ id: number; order_id: number; project_id: number | null }>(
      `SELECT l.id, l.order_id, o.project_id FROM purchase_order_line l JOIN purchase_order o ON o.id = l.order_id
        WHERE $1 = ANY(regexp_split_to_array(jsonb_path_query_array(l.analytic_distribution, '$.keyvalue()."key"')::text, '\\D+'))
          AND NOT (l.order_id = ANY($2::int[])) ORDER BY l.id`, [String(account), orders])).rows;
    // the excluded orders are those of the whole batch (:23): an order of another project depends on the batch
    if (lines.some((l) => l.project_id !== null && l.project_id !== rec.id)) {
      throw new NotPorted("project.project.purchase_orders_count with purchase lines on orders of another project");
    }
    const visible = new Set(lines.length ? await env.model("purchase.order.line").search(cond("id", "in", lines.map((l) => l.id))) : []);
    return orders.length + new Set(lines.filter((l) => visible.has(l.id)).map((l) => l.order_id)).size;
  },
});

defineComputes("project.project", {
  // project_project.py:1244-1247 _compute_task_completion_percentage: `task_count and closed / task_count`
  task_completion_percentage: async (env, rec) => {
    const all = await taskCount("all")(env, rec);
    return all ? (await taskCount("closed")(env, rec)) / all : 0;
  },
});

// mail_tracking_duration_mixin.py:90-125 _compute_rotting (src/models/rotting.ts). project.task: project_task.py:432-433
// `is_closed = False` (the state is not a closed one, :411-413). project.project: project_project.py:643-647, a project
// that is no template and whose stage is not folded; its fields carry groups="project.group_project_stages"
// (:186-187), read once Settings > Project Stages is on (the stage-grouped kanban, project_project_views.xml:640-652).
defineComputes("project.task", {
  is_rotting: async (env, rec) => (await rottingOf(env, rec, async (r) => !CLOSED_STATES.has(String(await r.get("state"))))).is_rotting,
  rotting_days: async (env, rec) => (await rottingOf(env, rec, async (r) => !CLOSED_STATES.has(String(await r.get("state"))))).rotting_days,
});
async function projectRots(rec: Rec): Promise<boolean> {
  if (await rec.get("is_template")) return false;
  const stage = await rec.rel("stage_id");
  return !(stage && (await stage.get("fold")));
}
defineComputes("project.project", {
  is_rotting: async (env, rec) => (await rottingOf(env, rec, projectRots)).is_rotting,
  rotting_days: async (env, rec) => (await rottingOf(env, rec, projectRots)).rotting_days,
});

/** A many2one value on a form record: its id, null when empty; a new co-record refuses. */
function m2oOf(value: unknown, what: string): number | null {
  if (typeof value === "number") return value;
  if (value === null || value === false || value === undefined) return null;
  if (value instanceof NewRec && value.origin !== null) return value.origin;
  throw new NotPorted(`${what}: a new record as value`);
}
// project_project.py:220-230 `_onchange_company_id`: with project stages, a stage of another company gives way to the
// first stage of the project's company or of none (`sequence asc` then the stage `_order`); a manager who is not in
// the new company is emptied (`self.user_id.company_ids`, read as the user)
registerOnchange("project.project", "_onchange_company_id", ["company_id"], async (env, rec) => {
  const company = m2oOf(await rec.get("company_id"), "project.project._onchange_company_id company_id");
  if (await userHasGroup(env, "project.group_project_stages")) {
    const stage = await rec.rel("stage_id");
    const stageCompany = stage ? m2oOf(await stage.get("company_id"), "project.project._onchange_company_id stage company") : null;
    if (stageCompany !== null && stageCompany !== company) {
      const stages = env.model("project.project.stage");
      const found = await stages.search(cond("company_id", "in", [company ?? false, false]), { order: `sequence asc, ${env.reg.model("project.project.stage").order}`, limit: 1 });
      await rec.set("stage_id", found[0] ?? false);
    }
  }
  const user = m2oOf(await rec.get("user_id"), "project.project._onchange_company_id user_id");
  if (company !== null && user !== null) {
    const companies = (await env.cr.query<{ cid: number }>("SELECT cid FROM res_company_users_rel WHERE user_id = $1", [user])).rows.map((r) => r.cid);
    const readable = await filteredAccess(env, "res.company", companies, "read");
    if (!readable.has(company)) await rec.set("user_id", false);
  }
});
// sale_project project_project.py:74-76 `_onchange_partner_id`
registerOnchange("project.project", "_onchange_partner_id", ["partner_id"], async (_env, rec) => {
  await rec.set("allow_billable", m2oOf(await rec.get("partner_id"), "project.project._onchange_partner_id") !== null);
});
// sale_project project_project.py:217-223 `_onchange_reinvoiced_sale_order_id`: without a sales order item, the order's
// first service line (its lines read as the user, `filtered('is_service')`) refuses
registerOnchange("project.project", "_onchange_reinvoiced_sale_order_id", ["reinvoiced_sale_order_id"], async (_env, rec) => {
  if (m2oOf(await rec.get("sale_line_id"), "project.project sale_line_id") !== null) return;
  if (m2oOf(await rec.get("reinvoiced_sale_order_id"), "project.project reinvoiced_sale_order_id") === null) return;
  throw new NotPorted("project.project._onchange_reinvoiced_sale_order_id with an order (its first service line)");
});
// sale_project project_project.py:225-228 `_onchange_sale_line_id`
registerOnchange("project.project", "_onchange_sale_line_id", ["sale_line_id"], async (_env, rec) => {
  if (m2oOf(await rec.get("reinvoiced_sale_order_id"), "project.project reinvoiced_sale_order_id") !== null) return;
  const line = await rec.rel("sale_line_id");
  if (line === null) return;
  await rec.set("reinvoiced_sale_order_id", m2oOf(await line.get("order_id"), "project.project._onchange_sale_line_id order") ?? false);
});
