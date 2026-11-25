/**
 * Project (`project.*`) and CRM (`crm.*`) UI button methods, wizard actions, and supporting computes/overrides.
 *
 * Project:
 *  - `project.template.create.wizard.create_project_from_template` & `project.project.action_create_from_template`
 *    (project/wizard/project_template_create_wizard.py:30-48, sale_project/wizard/project_template_create_wizard.py:44-48,
 *     project/models/project_project.py:1373-1414, crm_sale_project/models/project_project.py:16-21)
 *  - `project.milestone.action_view_sale_order` (sale_project/models/project_milestone.py:56-64)
 *  - `project.milestone.action_view_tasks` (project/models/project_milestone.py:101-110)
 *  - `project.project.action_customer_preview` (sale_project/models/project_project.py:209-215)
 *  - `project.project.action_view_all_rating` (project/models/project_project.py:1054-1069)
 *  - `project.project.action_view_lead` (crm_sale_project/models/project_project.py:23-31)
 *  - `project.project.action_view_sols` (sale_project/models/project_project.py:252-282)
 *  - `project.project.action_open_project_vendor_bills` (sale_project/models/project_project.py:486-506)
 *  - `project.project.action_open_share_project_wizard` (project/models/project_project.py:1001-1022)
 *  - `project.project.toggle_favorite` (project/models/project_project.py:1024-1035)
 *  - `project.project.stage.delete.wizard.{action_unlink,action_unarchive_project,action_archive}`
 *    + `project.project.stage.unlink_wizard` (project/wizard/project_project_stage_delete.py, project_project_stage.py:22-38)
 *  - `project.task.type.delete.wizard.{action_unlink,action_unarchive_task,action_archive,action_confirm}`
 *    + `project.task.type` personal-stage `beforeUnlink` (project/wizard/project_task_type_delete.py, project_task_type.py:123-189)
 *  - `project.share.wizard.{action_share_record,action_send_mail}` + defaults/computes/create override
 *    (project/wizard/project_share_wizard.py, portal/wizard/portal_share.py, project_share_collaborator_wizard.py)
 *  - `project.task.{action_open_task,action_project_sharing_open_task,action_convert_to_task,
 *     action_project_sharing_open_blocking,action_project_sharing_open_subtasks,
 *     action_project_sharing_recurring_tasks,action_project_sharing_toggle_assign,
 *     action_project_sharing_view_parent_task,action_project_sharing_view_so}`
 *    + `display_parent_task_button` & `display_sale_order_button` computes
 *
 * CRM:
 *  - `crm.lead.action_view_sale_order` (sale_crm/models/crm_lead.py:53-66)
 *  - `crm.lead.{action_view_project_ids,action_create_project}` (crm_sale_project/models/crm_lead.py:37-101)
 *  - `crm.lost.reason.action_lost_leads` (crm/models/crm_lost_reason.py:26-34)
 *  - `crm.lead.pls.update.action_update_crm_lead_probabilities` + defaults (crm/wizard/crm_lead_pls_update.py)
 *  - `crm.lead.mail_action_blacklist_remove` (mail/models/mail_thread_blacklist.py:110-124)
 *  - `crm.lead.phone_action_blacklist_remove` (phone_validation/models/mail_thread_phone.py:228-241)
 */
import { randomUUID } from "node:crypto";
import { AccessDenied, AccessError, NotPorted, UserError } from "../errors";
import { renderQweb } from "../controllers/report";
import { requestOfCursor } from "../http/context";
import { callKw, registerMethod } from "../http/methods";
import { computeAuthor, insertMessages, messageLogBatch, plaintextBody, replyToDefault, trackingMessageId, xmlid } from "../mail/message";
import { notifyThread, signupToken } from "../mail/notify";
import { recordCompany } from "../mail/thread_generic";
import { checkModelAccess } from "../orm/access";
import { create } from "../orm/create";
import { and, cond, or, TRUE } from "../orm/domain";
import { hasGroup, userInfo } from "../orm/env";
import { htmlSanitize } from "../orm/html_sanitize";
import { registerDefaults, writeColumns } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { unlink } from "../orm/unlink";
import { registerOverrides, write } from "../orm/write";
import { dictEntries, isDict, literalEval } from "../pyexpr";
import { PyRecords } from "../qweb/records";
import { envFor, isRecord, parseSpecification, recordIds } from "../web/common";
import { webRead } from "../web/read";
import { contextToday } from "./account_computes";
import { cronUpdateAutomatedProbabilities } from "./crm_lead_pls";
import { withPrecommit } from "./precommit";
import { copyProjects } from "./project_copy";
import { openProjectTemplateView, projectActionViewTasks, saleItems } from "./project_project_create";
import { configParam, defineComputes, filteredAccess, referenceIfExists } from "./tail_util";
import { translate } from "./util";

type Action = Record<string, unknown>;
type ButtonFn = (env: Environment, ids: number[], args: unknown[], kwargs: Record<string, unknown>) => Promise<unknown>;

function button(model: string, method: string, fn: ButtonFn, opts: { apiModel?: boolean; readonly?: boolean } = {}): void {
  registerMethod(model, method, async (env0, ids, args, kwargs0) => {
    const { env, kwargs } = envFor(env0, kwargs0);
    return fn(env, ids ?? [], args, kwargs);
  }, { apiModel: opts.apiModel ?? false, ...(opts.readonly !== undefined ? { readonly: opts.readonly } : {}) });
}

function ensureOne(ids: readonly number[], model: string, method: string): number {
  if (ids.length !== 1) throw new NotPorted(`${model}.${method} on ${ids.length} records (ensure_one)`);
  return ids[0]!;
}

const m2o = (v: unknown): number | false => (typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : false);

async function forXmlId(env: Environment, xmlid: string): Promise<Action> {
  const { loadAction } = await import("../controllers/action");
  return loadAction({ cursor: () => env.cr, context: env.context, uid: env.uid }, xmlid, env);
}

async function refId(env: Environment, xmlid: string): Promise<number | false> {
  const id = await env.reg.xmlid(env.cr, xmlid);
  return id ?? false;
}

function literalContext(raw: unknown, replacements: Record<string, string> = {}): Record<string, unknown> {
  let text = String(raw || "{}");
  for (const [k, v] of Object.entries(replacements)) text = text.split(k).join(v);
  const parsed = literalEval(text);
  if (!isDict(parsed)) throw new NotPorted("action context that is not a dict");
  return Object.fromEntries(dictEntries(parsed).map(([k, v]) => [String(k), v]));
}

async function isPortalUser(env: Environment): Promise<boolean> {
  return hasGroup(env, "base.group_portal");
}

async function isInternalUser(env: Environment): Promise<boolean> {
  return hasGroup(env, "base.group_user");
}

async function hasModelAccess(env: Environment, model: string, operation: "read" | "write" | "create" | "unlink"): Promise<boolean> {
  if (env.su) return true;
  try {
    await checkModelAccess(env, env.reg.model(model), operation);
    return true;
  } catch (e) {
    if (e instanceof AccessError) return false;
    throw e;
  }
}

/** portal_mixin.py:34-39 `_portal_ensure_token` with project_task.py:2358-2362 override. */
async function ensureTaskPortalToken(env: Environment, taskId: number): Promise<string> {
  const row = (await env.cr.query<{ token: string | null; vis: string | null }>(
    `SELECT t.access_token AS token, p.privacy_visibility AS vis
       FROM project_task t LEFT JOIN project_project p ON p.id = t.project_id
      WHERE t.id = $1`, [taskId])).rows[0];
  if (!row || row.vis !== "portal") return "";
  if (row.token) return row.token;
  const fresh = randomUUID();
  await write(env.sudo(), "project.task", [taskId], { access_token: fresh });
  return fresh;
}

/** project_task.py:2364-2372 `get_portal_url` (with portal_mixin.py:121-147). */
async function taskPortalUrl(env: Environment, taskId: number, queryString?: string): Promise<string> {
  const row = (await env.cr.query<{ vis: string | null }>(
    `SELECT p.privacy_visibility AS vis FROM project_task t LEFT JOIN project_project p ON p.id = t.project_id WHERE t.id = $1`, [taskId])).rows[0];
  const params: string[] = [];
  if (row?.vis === "portal") {
    const token = await ensureTaskPortalToken(env, taskId);
    params.push(`access_token=${token}`);
  }
  if (queryString) params.push(queryString.replace(/^&+/, ""));
  const base = `/my/tasks/${taskId}`;
  return params.length ? `${base}?${params.join("&")}` : base;
}

/** Distinct non-null project_id set equality with a singleton project_id (`tasks.project_id == self.project_id`). */
async function tasksHaveSameProject(env: Environment, taskIds: readonly number[], projectId: number | false): Promise<boolean> {
  if (!taskIds.length) return !projectId;
  const rows = (await env.cr.query<{ p: number | null }>(
    "SELECT DISTINCT project_id AS p FROM project_task WHERE id = ANY($1::int[]) AND project_id IS NOT NULL", [[...taskIds]])).rows;
  const projects = rows.map((r) => r.p!);
  if (!projectId) return projects.length === 0;
  return projects.length === 1 && projects[0] === projectId;
}

// ================================================================================================================
// 1. project.template.create.wizard & project.project.action_create_from_template
// ================================================================================================================

const PROJECT_TEMPLATE_CONTEXT_WHITELIST = new Set([
  "allow_milestones",
  "allow_billable",
  "from_sale_order_action",
  "lead_id",
]);

function addDateDays(isoDate: string, days: number): string {
  const ms = Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function diffDateDays(a: string, b: string): number {
  return Math.round((Date.parse(`${a.slice(0, 10)}T00:00:00Z`) - Date.parse(`${b.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

/** project/models/project_project.py:1391-1414 `action_create_from_template`. */
export async function actionCreateProjectFromTemplate(
  env: Environment,
  templateId: number,
  valuesArg?: Record<string, unknown>,
  roleToUsersMapping?: Map<number, number[]> | Record<string, number[]> | null,
): Promise<number> {
  const tpl = (await env.model("project.project").read([templateId], ["name", "date_start", "date"], ""))[0];
  if (!tpl) throw new NotPorted("project.project.action_create_from_template on a missing template");
  const values: Record<string, unknown> = { ...(valuesArg ?? {}) };
  if (typeof tpl["date_start"] === "string" && tpl["date_start"] && typeof tpl["date"] === "string" && tpl["date"]) {
    if (!values["date_start"]) values["date_start"] = await contextToday(env);
    if (!values["date"]) values["date"] = addDateDays(String(values["date_start"]), diffDateDays(tpl["date"], tpl["date_start"]));
  }
  const dflt: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(env.context)) {
    if (k.startsWith("default_")) {
      const fname = k.slice(8);
      if (PROJECT_TEMPLATE_CONTEXT_WHITELIST.has(fname)) dflt[fname] = v;
    }
  }
  Object.assign(dflt, values);

  const copyCtx: Record<string, unknown> = {
    ...env.context,
    copy_from_template: true,
    copy_from_project_template: templateId,
  };
  if (roleToUsersMapping !== undefined && roleToUsersMapping !== null) {
    copyCtx["role_to_users_mapping"] = roleToUsersMapping;
  }
  return withPrecommit(env.cr, async () => {
    const [projectId] = await copyProjects(env.withContext(copyCtx), [templateId], dflt);
    const body = translate(env, "Project created from template %(name)s.", "project").replace("%(name)s", String(tpl["name"] ?? ""));
    await callKw(env, "project.project", "message_post", [[projectId!]], { body });
    return projectId!;
  });
}

/** project/wizard/project_template_create_wizard.py:36-44 + sale_project override :44-48 `_create_project_from_template`. */
export async function createProjectFromTemplateWizard(env: Environment, wizardId: number): Promise<number> {
  const wiz = (await env.model("project.template.create.wizard").read(
    [wizardId],
    ["name", "date_start", "date", "alias_name", "alias_domain_id", "partner_id", "template_id", "allow_billable", "role_to_users_ids"],
    "",
  ))[0];
  if (!wiz) throw new NotPorted("project.template.create.wizard missing record");
  const templateId = m2o(wiz["template_id"]);
  if (!templateId) throw new NotPorted("project.template.create.wizard without template_id");
  const whitelist = ["name", "date_start", "date", "alias_name", "alias_domain_id"];
  if (wiz["allow_billable"]) whitelist.push("partner_id");
  const def = env.reg.model("project.template.create.wizard");
  const fieldValues: Record<string, unknown> = {};
  for (const fname of whitelist) {
    if (!def.fields.has(fname)) continue;
    const f = def.fields.get(fname)!;
    const v = wiz[fname];
    fieldValues[fname] = f.type === "many2one" ? m2o(v) : (v ?? false);
  }
  const mapIds = Array.isArray(wiz["role_to_users_ids"]) ? (wiz["role_to_users_ids"] as number[]) : [];
  const roleMap = new Map<number, number[]>();
  if (mapIds.length) {
    const entries = await env.model("project.template.role.to.users.map").read(mapIds, ["role_id", "user_ids"], "");
    for (const e of entries) {
      const rid = m2o(e["role_id"]);
      const uids = Array.isArray(e["user_ids"]) ? (e["user_ids"] as number[]) : [];
      if (rid && uids.length) roleMap.set(rid, uids);
    }
  }
  return actionCreateProjectFromTemplate(env, templateId, fieldValues, roleMap);
}

button("project.project", "action_create_from_template", async (env, ids, args, kwargs) => {
  const id = ensureOne(ids, "project.project", "action_create_from_template");
  const values = (kwargs["values"] ?? args[0]) as Record<string, unknown> | undefined;
  const mapping = kwargs["role_to_users_mapping"] ?? args[1];
  if (mapping !== undefined && mapping !== null) throw new NotPorted("project.project.action_create_from_template RPC with role_to_users_mapping");
  return [await actionCreateProjectFromTemplate(env, id, values)];
});

button("project.template.create.wizard", "create_project_from_template", async (env, ids) => {
  const id = ensureOne(ids, "project.template.create.wizard", "create_project_from_template");
  const projectId = await createProjectFromTemplateWizard(env, id);
  return projectActionViewTasks(env, projectId);
});

// ================================================================================================================
// 2. project.milestone
// ================================================================================================================

// sale_project/models/project_milestone.py:56-64
button("project.milestone", "action_view_sale_order", async (env, ids) => {
  const id = ensureOne(ids, "project.milestone", "action_view_sale_order");
  const row = (await env.model("project.milestone").read([id], ["sale_line_id"], ""))[0];
  if (!row) throw new NotPorted("project.milestone.action_view_sale_order on missing record");
  const lineId = m2o(row["sale_line_id"]);
  let orderId: number | false = false;
  if (lineId) {
    const line = (await env.model("sale.order.line").read([lineId], ["order_id"], ""))[0];
    orderId = m2o(line?.["order_id"]);
  }
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Sales Order", "sale_project"),
    res_model: "sale.order",
    res_id: orderId,
    view_mode: "form",
  };
});

// project/models/project_milestone.py:101-110
button("project.milestone", "action_view_tasks", async (env, ids) => {
  const id = ensureOne(ids, "project.milestone", "action_view_tasks");
  const row = (await env.model("project.milestone").read([id], ["project_id", "task_count", "task_ids"], ""))[0];
  if (!row) throw new NotPorted("project.milestone.action_view_tasks on missing record");
  const action = await forXmlId(env, "project.action_view_task_from_milestone");
  action["context"] = { default_project_id: m2o(row["project_id"]), default_milestone_id: id };
  if (row["task_count"] === 1) {
    const taskIds = Array.isArray(row["task_ids"]) ? (row["task_ids"] as number[]) : [];
    action["view_mode"] = "form";
    action["res_id"] = taskIds[0] ?? false;
    if (Array.isArray(action["views"])) {
      action["views"] = (action["views"] as [unknown, string][]).filter(([, vt]) => vt === "form");
    }
  }
  return action;
});

// ================================================================================================================
// 3. project.project
// ================================================================================================================

// sale_project/models/project_project.py:209-215 + project_project.py:1256-1257 get_portal_url(share_token=False)
button("project.project", "action_customer_preview", async (env, ids) => {
  const id = ensureOne(ids, "project.project", "action_customer_preview");
  const rows = await env.model("project.project").read([id], ["access_url"], "");
  if (!rows.length) throw new NotPorted("project.project.action_customer_preview on missing record");
  return {
    type: "ir.actions.act_url",
    target: "self",
    url: String(rows[0]!["access_url"] || `/my/projects/${id}`),
  };
});

// project/models/project_project.py:1054-1069
button("project.project", "action_view_all_rating", async (env, ids) => {
  const id = ensureOne(ids, "project.project", "action_view_all_rating");
  const project = (await env.model("project.project").read([id], ["name", "rating_count"], ""))[0];
  if (!project) throw new NotPorted("project.project.action_view_all_rating on missing record");
  const action = await forXmlId(env, "project.rating_rating_action_view_project_rating");
  action["display_name"] = translate(env, "%(name)s's Rating", "project").replace("%(name)s", String(project["name"] ?? ""));
  const ctx: Record<string, unknown> = {
    ...(action["context"] ? literalContext(action["context"]) : {}),
    ...env.context,
    search_default_filter_write_date: "custom_write_date_last_30_days",
  };
  delete ctx["group_by"];
  action["domain"] = [["consumed", "=", true], ["parent_res_model", "=", "project.project"], ["parent_res_id", "=", id]];
  if (project["rating_count"] === 1) {
    const ratingIds = await env.sudo().model("rating.rating").search(
      and([cond("parent_res_model", "=", "project.project"), cond("parent_res_id", "=", id)]),
      { limit: 1 },
    );
    action["view_mode"] = "form";
    if (Array.isArray(action["views"])) {
      action["views"] = (action["views"] as [unknown, string][]).filter(([, vt]) => vt === "form");
    }
    action["res_id"] = ratingIds[0] ?? false;
  }
  return { ...action, context: ctx };
});

// crm_sale_project/models/project_project.py:23-31
button("project.project", "action_view_lead", async (env, ids) => {
  const id = ensureOne(ids, "project.project", "action_view_lead");
  const project = (await env.model("project.project").read([id], ["lead_id"], ""))[0];
  if (!project) throw new NotPorted("project.project.action_view_lead on missing record");
  return {
    type: "ir.actions.act_window",
    res_model: "crm.lead",
    view_mode: "form",
    res_id: m2o(project["lead_id"]),
    context: { create: false },
  };
});

// sale_project/models/project_project.py:252-282
button("project.project", "action_view_sols", async (env, ids) => {
  const id = ensureOne(ids, "project.project", "action_view_sols");
  const project = (await env.model("project.project").read([id], ["partner_id", "company_id", "sale_order_id", "allow_billable", "reinvoiced_sale_order_id", "sale_line_id"], ""))[0];
  if (!project) throw new NotPorted("project.project.action_view_sols on missing record");
  const rec = await saleItems(env, { id, get: async (n) => project[n] });
  const formView = await refId(env, "sale_project.sale_order_line_view_form_editable");
  const ctx: Record<string, unknown> = {
    show_sale: true,
    link_to_project: id,
    form_view_ref: "sale_project.sale_order_line_view_form_editable",
    action_view_sols: true,
    default_partner_id: m2o(project["partner_id"]),
    default_company_id: m2o(project["company_id"]),
    default_order_id: m2o(project["sale_order_id"]),
  };
  const action: Action = {
    type: "ir.actions.act_window",
    res_model: "sale.order.line",
    name: translate(env, "Sales Order Items", "sale_project"),
    context: ctx,
    views: [[formView, "form"]],
  };
  if (rec.lineIds.length <= 1) action["res_id"] = rec.lineIds[0] ?? false;
  if (rec.lineIds.length > 1 || !m2o(project["partner_id"])) {
    const listView = await refId(env, "sale_project.view_order_line_tree_with_create");
    action["domain"] = [["id", "in", rec.lineIds]];
    action["views"] = [[listView, "list"], [formView, "form"]];
    if (!m2o(project["partner_id"])) ctx["create"] = false;
  }
  return action;
});

// sale_project/models/project_project.py:486-506
button("project.project", "action_open_project_vendor_bills", async (env, ids) => {
  const projects = await env.model("project.project").read(ids, ["account_id"], "");
  const accountIds = projects.map((p) => m2o(p["account_id"])).filter((a): a is number => typeof a === "number");
  let billIds: number[] = [];
  if (accountIds.length) {
    // analytic_distribution ?| ARRAY[account_ids] (analytic_mixin._search_analytic_distribution)
    const matchingLines = (await env.cr.query<{ id: number }>(
      `SELECT l.id FROM account_move_line l JOIN account_move m ON m.id = l.move_id
        WHERE l.parent_state != 'cancel' AND m.move_type IN ('in_invoice', 'in_refund')
          AND l.analytic_distribution ?| $1::text[]`,
      [accountIds.map(String)],
    )).rows.map((r) => r.id);
    if (matchingLines.length) {
      const readable = await env.model("account.move.line").search(cond("id", "in", matchingLines));
      const lineRows = readable.length ? await env.model("account.move.line").read(readable, ["move_id"], "") : [];
      for (const r of lineRows) {
        const mid = m2o(r["move_id"]);
        if (mid && !billIds.includes(mid)) billIds.push(mid);
      }
    }
  }
  const action = await forXmlId(env, "account.action_move_in_invoice");
  action["display_name"] = translate(env, "Vendor Bills", "sale_project");
  action["domain"] = [["id", "in", billIds]];
  action["context"] = { ...literalContext(action["context"]), project_id: ids.length === 1 ? ids[0]! : false };
  if (!env.context["from_embedded_action"] && billIds.length === 1) {
    action["views"] = [[false, "form"]];
    action["res_id"] = billIds[0]!;
  }
  return action;
});

// project/models/project_project.py:1001-1022
button("project.project", "action_open_share_project_wizard", async (env, ids) => {
  const id = ensureOne(ids, "project.project", "action_open_share_project_wizard");
  const project = (await env.model("project.project").read([id], ["privacy_visibility", "is_template"], ""))[0];
  if (!project) throw new NotPorted("project.project.action_open_share_project_wizard on missing record");
  if (project["privacy_visibility"] === "followers" || project["privacy_visibility"] === "employees" || project["is_template"]) {
    return {
      type: "ir.actions.client",
      tag: "display_notification",
      params: {
        type: "danger",
        message: translate(env, "This project can’t be shared with external people.", "project"),
      },
    };
  }
  const action = await forXmlId(env, "project.project_share_wizard_action");
  if (env.context["default_access_mode"]) action["name"] = translate(env, "Share Project", "project");
  action["context"] = {
    ...env.context,
    default_template_id: false,
    default_email_layout_xmlid: "mail.mail_notification_light",
    active_id: id,
    active_model: "project.project",
  };
  return action;
});

// project/models/project_project.py:1024-1035
button("project.project", "toggle_favorite", async (env, ids) => {
  const projects = await env.model("project.project").read(ids, ["favorite_user_ids"], "");
  const fav: number[] = [];
  const notFav: number[] = [];
  for (const p of projects) {
    const users = Array.isArray(p["favorite_user_ids"]) ? (p["favorite_user_ids"] as number[]) : [];
    if (users.includes(env.uid)) fav.push(Number(p["id"]));
    else notFav.push(Number(p["id"]));
  }
  if (notFav.length) await write(env.sudo(), "project.project", notFav, { favorite_user_ids: [[4, env.uid, 0]] });
  if (fav.length) await write(env.sudo(), "project.project", fav, { favorite_user_ids: [[3, env.uid, 0]] });
  return null;
});

// ================================================================================================================
// 4. project.project.stage.delete.wizard & project.project.stage.unlink_wizard
// ================================================================================================================

defineComputes("project.project.stage.delete.wizard", {
  projects_count: async (env, rec) => {
    const stageIds = (await rec.rels("stage_ids")).map((r) => r.id).filter((x): x is number => x !== null);
    if (!stageIds.length) return 0;
    return env.withContext({ ...env.context, active_test: false }).model("project.project").searchCount(cond("stage_id", "in", stageIds));
  },
  stages_active: async (_env, rec) => {
    const stages = await rec.rels("stage_ids");
    for (const s of stages) if (!(await s.get("active"))) return false;
    return true;
  },
});

async function stageDeleteWizardStageIds(env: Environment, ids: readonly number[]): Promise<number[]> {
  const rows = await env.withContext({ ...env.context, active_test: false }).model("project.project.stage.delete.wizard").read([...ids], ["stage_ids"], "");
  const out: number[] = [];
  for (const r of rows) for (const s of (Array.isArray(r["stage_ids"]) ? r["stage_ids"] : []) as number[]) if (!out.includes(s)) out.push(s);
  return out;
}

async function projectStageDeleteGetAction(env: Environment): Promise<Action> {
  const action = await forXmlId(
    env,
    env.context["stage_view"] ? "project.project_project_stage_configure" : "project.open_view_project_all_group_stage",
  );
  const ctx = literalContext(action["context"] ?? "{}", { uid: String(env.uid) });
  ctx["active_test"] = true;
  action["context"] = ctx;
  action["target"] = "main";
  return action;
}

// project/wizard/project_project_stage_delete.py:25-50
button("project.project.stage.delete.wizard", "action_archive", async (env, ids) => {
  const stageIds = await stageDeleteWizardStageIds(env, ids);
  const projects = stageIds.length
    ? await env.model("project.project").search(cond("stage_id", "in", stageIds), { activeTest: false })
    : [];
  if (projects.length) await write(env, "project.project", projects, { active: false });
  if (stageIds.length) await write(env, "project.project.stage", stageIds, { active: false });
  return projectStageDeleteGetAction(env);
});

button("project.project.stage.delete.wizard", "action_unarchive_project", async (env, ids) => {
  const stageIds = await stageDeleteWizardStageIds(env, ids);
  const inactive = stageIds.length
    ? await env.model("project.project").search(and([cond("active", "=", false), cond("stage_id", "in", stageIds)]), { activeTest: false })
    : [];
  if (inactive.length) await write(env, "project.project", inactive, { active: true });
  return null;
});

button("project.project.stage.delete.wizard", "action_unlink", async (env, ids) => {
  const stageIds = await stageDeleteWizardStageIds(env, ids);
  if (stageIds.length) await unlink(env, "project.project.stage", stageIds);
  return projectStageDeleteGetAction(env);
});

// project/models/project_project_stage.py:22-38
button("project.project.stage", "unlink_wizard", async (env, ids, args, kwargs) => {
  const stageView = Boolean(kwargs["stage_view"] ?? args[0] ?? false);
  const [wizId] = await create(env.withContext({ ...env.context, active_test: false }), "project.project.stage.delete.wizard", [
    { stage_ids: [[6, 0, [...ids]]] },
  ]);
  return {
    name: translate(env, "Delete Project Stage", "project"),
    view_mode: "form",
    res_model: "project.project.stage.delete.wizard",
    views: [[await refId(env, "project.view_project_project_stage_delete_wizard"), "form"]],
    type: "ir.actions.act_window",
    res_id: wizId!,
    target: "new",
    context: { ...env.context, stage_view: stageView },
  };
});

// ================================================================================================================
// 5. project.task.type.delete.wizard & project.task.type beforeUnlink
// ================================================================================================================

// project/models/project_task_type.py:123-189 `_unlink_if_remaining_personal_stages`
registerOverrides("project.task.type", {
  beforeUnlink: async (env, ids) => {
    if (!ids.length) return;
    const rows = (await env.cr.query<{ id: number; user_id: number | null; sequence: number }>(
      "SELECT id, user_id, COALESCE(sequence, 0) AS sequence FROM project_task_type WHERE id = ANY($1::int[]) AND user_id IS NOT NULL ORDER BY sequence, id",
      [[...ids]],
    )).rows;
    if (!rows.length) return;
    const userIds = [...new Set(rows.map((r) => r.user_id!))];
    const users = (await env.cr.query<{ id: number; active: boolean | null; share: boolean | null }>(
      "SELECT id, active, share FROM res_users WHERE id = ANY($1::int[])", [userIds])).rows;
    const userMap = new Map(users.map((u) => [u.id, u]));
    const remRows = (await env.cr.query<{ id: number; user_id: number; sequence: number }>(
      `SELECT id, user_id, COALESCE(sequence, 0) AS sequence FROM project_task_type
        WHERE user_id = ANY($1::int[]) AND id != ALL($2::int[]) AND active IS TRUE
        ORDER BY user_id, sequence DESC, id DESC`,
      [userIds, [...ids]],
    )).rows;
    const remByUser = new Map<number, { id: number; seq: number }[]>();
    for (const r of remRows) {
      const list = remByUser.get(r.user_id) ?? [];
      list.push({ id: r.id, seq: r.sequence });
      remByUser.set(r.user_id, list);
    }
    const personalStageIds = rows.map((r) => r.id);
    const pRows = (await env.cr.query<{ id: number; stage_id: number }>(
      "SELECT id, stage_id FROM project_task_stage_personal WHERE stage_id = ANY($1::int[]) ORDER BY id",
      [personalStageIds],
    )).rows;
    const personalByStage = new Map<number, number[]>();
    for (const p of pRows) {
      const list = personalByStage.get(p.stage_id) ?? [];
      list.push(p.id);
      personalByStage.set(p.stage_id, list);
    }
    for (const uid of userIds) {
      const u = userMap.get(uid);
      if (!u || !u.active || u.share) continue;
      const rem = [...(remByUser.get(uid) ?? [])];
      if (!rem.length) {
        throw new UserError(translate(env, "Each user should have at least one personal stage. Create a new stage to which the tasks can be transferred after the selected ones are deleted.", "project"));
      }
      const toDelete = rows.filter((r) => r.user_id === uid).sort((a, b) => a.sequence - b.sequence);
      let replacementId = rem.pop()!.id;
      let nextRep = rem.length ? rem.pop() : undefined;
      for (const st of toDelete) {
        while (nextRep && nextRep.seq < st.sequence) {
          replacementId = nextRep.id;
          nextRep = rem.length ? rem.pop() : undefined;
        }
        const recs = personalByStage.get(st.id);
        if (recs?.length) await write(env, "project.task.stage.personal", recs, { stage_id: replacementId });
      }
    }
  },
});

defineComputes("project.task.type.delete.wizard", {
  tasks_count: async (env, rec) => {
    const stageIds = (await rec.rels("stage_ids")).map((r) => r.id).filter((x): x is number => x !== null);
    if (!stageIds.length) return 0;
    return env.withContext({ ...env.context, active_test: false }).model("project.task").searchCount(cond("stage_id", "in", stageIds));
  },
  stages_active: async (_env, rec) => {
    const stages = await rec.rels("stage_ids");
    for (const s of stages) if (!(await s.get("active"))) return false;
    return true;
  },
});

async function taskTypeDeleteWizardStageIds(env: Environment, ids: readonly number[]): Promise<number[]> {
  // project_task_type_delete.py:12 stage_ids has NO active_test=False on the field (unlike project.project.stage.delete.wizard)
  const rows = await env.model("project.task.type.delete.wizard").read([...ids], ["stage_ids"], "");
  const out: number[] = [];
  for (const r of rows) for (const s of (Array.isArray(r["stage_ids"]) ? r["stage_ids"] : []) as number[]) if (!out.includes(s)) out.push(s);
  return out;
}

const TASK_TYPE_DELETE_CLOSE: Action = { type: "ir.actions.act_window_close", infos: { success: true } };

// project/wizard/project_task_type_delete.py:26-62
button("project.task.type.delete.wizard", "action_confirm", async (env, ids) => {
  const stageIds = await taskTypeDeleteWizardStageIds(env, ids);
  const tasks = stageIds.length
    ? await env.model("project.task").search(cond("stage_id", "in", stageIds), { activeTest: false })
    : [];
  if (tasks.length) await write(env, "project.task", tasks, { active: false });
  if (stageIds.length) await write(env, "project.task.type", stageIds, { active: false });
  return { ...TASK_TYPE_DELETE_CLOSE, infos: { success: true } };
});

button("project.task.type.delete.wizard", "action_archive", async (env, ids) => {
  const rows = await env.model("project.task.type.delete.wizard").read(ids, ["project_ids"], "");
  const projectIds = new Set<number>();
  for (const r of rows) for (const p of (Array.isArray(r["project_ids"]) ? r["project_ids"] : []) as number[]) projectIds.add(p);
  if (projectIds.size <= 1) {
    const stageIds = await taskTypeDeleteWizardStageIds(env, ids);
    const tasks = stageIds.length
      ? await env.model("project.task").search(cond("stage_id", "in", stageIds), { activeTest: false })
      : [];
    if (tasks.length) await write(env, "project.task", tasks, { active: false });
    if (stageIds.length) await write(env, "project.task.type", stageIds, { active: false });
    return { ...TASK_TYPE_DELETE_CLOSE, infos: { success: true } };
  }
  const id = ensureOne(ids, "project.task.type.delete.wizard", "action_archive");
  return {
    name: translate(env, "Confirmation", "project"),
    view_mode: "form",
    res_model: "project.task.type.delete.wizard",
    views: [[await refId(env, "project.view_project_task_type_delete_confirmation_wizard"), "form"]],
    type: "ir.actions.act_window",
    res_id: id,
    target: "new",
    context: env.context,
  };
});

button("project.task.type.delete.wizard", "action_unarchive_task", async (env, ids) => {
  const stageIds = await taskTypeDeleteWizardStageIds(env, ids);
  const inactive = stageIds.length
    ? await env.model("project.task").search(and([cond("active", "=", false), cond("stage_id", "in", stageIds)]), { activeTest: false })
    : [];
  if (inactive.length) await write(env, "project.task", inactive, { active: true });
  return null;
});

button("project.task.type.delete.wizard", "action_unlink", async (env, ids) => {
  const stageIds = await taskTypeDeleteWizardStageIds(env, ids);
  if (stageIds.length) await unlink(env, "project.task.type", stageIds);
  return { ...TASK_TYPE_DELETE_CLOSE, infos: { success: true } };
});

// ================================================================================================================
// 6. project.share.wizard & project.share.collaborator.wizard
// ================================================================================================================

async function projectShareLink(env: Environment, resModel: string, resId: number): Promise<string> {
  const base = (await configParam(env.sudo(), "web.base.url")) ?? "";
  // portal_mixin._get_share_url(redirect=True, share_token=False) -> /mail/view?model=...&res_id=...
  const params = new URLSearchParams({ model: resModel, res_id: String(resId) }).toString();
  return `${base}/mail/view?${params}`;
}

defineComputes("project.share.wizard", {
  resource_ref: async (env, rec) => {
    const model = await rec.get("res_model");
    const id = await rec.get("res_id");
    if (model === "project.project") return referenceIfExists(env, "project.project", typeof id === "number" ? id : 0);
    return null;
  },
  existing_partner_ids: async (_env, rec) => {
    const collabs = await rec.rels("collaborator_ids");
    const out: number[] = [];
    for (const c of collabs) {
      const pid = m2o(await c.get("partner_id"));
      if (pid && !out.includes(pid)) out.push(pid);
    }
    return out;
  },
  share_link: async (env, rec) => {
    const model = await rec.get("res_model");
    const id = await rec.get("res_id");
    if (model === "project.project" && typeof id === "number" && id) return projectShareLink(env, model, id);
    return false;
  },
  access_warning: async () => "",
});

defineComputes("project.share.collaborator.wizard", {
  send_invitation: async (env, rec) => {
    const prev = await rec.prev("send_invitation");
    const wizard = await rec.rel("parent_wizard_id");
    const projectId = wizard ? m2o(await wizard.get("res_id")) : false;
    const pid = m2o(await rec.get("partner_id"));
    if (projectId && pid) {
      const existing = (await env.cr.query(
        "SELECT 1 FROM project_collaborator WHERE project_id = $1 AND partner_id = $2 LIMIT 1", [projectId, pid])).rows;
      if (!existing.length) return true;
    }
    return Boolean(prev);
  },
});

registerOverrides("project.share.wizard", {
  // project/wizard/project_share_wizard.py:13-39 + portal_share.py:11-19 default_get
  defaultGet: async (env, fields, vals) => {
    let activeModel = typeof env.context["active_model"] === "string" ? env.context["active_model"] : "";
    let activeId: unknown = env.context["active_id"] ?? false;
    if (activeModel === "project.collaborator") {
      activeModel = "project.project";
      activeId = env.context["default_project_id"] ?? false;
    }
    const resModel = activeModel || false;
    const resId = typeof activeId === "number" && activeId ? activeId : false;
    if (fields.includes("res_model")) vals["res_model"] = resModel;
    if (fields.includes("res_id")) vals["res_id"] = resId;
    if (resModel && resId) {
      if (fields.includes("share_link")) vals["share_link"] = await projectShareLink(env, resModel, resId);
      if (fields.includes("collaborator_ids") && resModel === "project.project") {
        const collabs = await env.model("project.collaborator").search(cond("project_id", "=", resId));
        if (collabs.length) {
          const cRows = await env.model("project.collaborator").read(collabs, ["partner_id", "access_mode"], "");
          const pids = cRows.map((c) => m2o(c["partner_id"])).filter((p): p is number => typeof p === "number");
          const names = pids.length ? await env.model("res.partner").displayName(pids) : new Map<number, string>();
          const items = cRows.map((c) => {
            const pid = m2o(c["partner_id"]) as number;
            return { partner_id: pid, partner_name: names.get(pid) ?? "", access_mode: String(c["access_mode"] ?? "view") };
          });
          items.sort((a, b) => (a.partner_name < b.partner_name ? -1 : a.partner_name > b.partner_name ? 1 : 0));
          vals["collaborator_ids"] = items.map((c) => [0, 0, { partner_id: c.partner_id, access_mode: c.access_mode, send_invitation: false }]);
        }
      }
    }
  },
  // project/wizard/project_share_wizard.py:63-100 create
  create: async (env, valsList, next) => {
    const ids = await next(env, valsList);
    for (const wizId of ids) {
      const wiz = (await env.model("project.share.wizard").read([wizId], ["res_model", "res_id", "collaborator_ids"], ""))[0];
      if (!wiz || wiz["res_model"] !== "project.project" || typeof wiz["res_id"] !== "number") continue;
      const projectId = wiz["res_id"];
      const wizCollabIds = Array.isArray(wiz["collaborator_ids"]) ? (wiz["collaborator_ids"] as number[]) : [];
      const wizCollabs = wizCollabIds.length
        ? await env.model("project.share.collaborator.wizard").read(wizCollabIds, ["partner_id", "access_mode"], "")
        : [];
      const wizPartnerIds = new Set(wizCollabs.map((c) => m2o(c["partner_id"])).filter((p): p is number => typeof p === "number"));

      const projCollabIds = await env.model("project.collaborator").search(cond("project_id", "=", projectId));
      const projCollabs = projCollabIds.length
        ? await env.model("project.collaborator").read(projCollabIds, ["partner_id", "access_mode"], "")
        : [];
      const byPartner = new Map<number, { id: number; access_mode: string }>();
      const toRemove: number[] = [];
      for (const c of projCollabs) {
        const pid = m2o(c["partner_id"]);
        if (!pid) continue;
        byPartner.set(pid, { id: Number(c["id"]), access_mode: String(c["access_mode"] ?? "view") });
        if (!wizPartnerIds.has(pid)) toRemove.push(Number(c["id"]));
      }

      const toAdd: [number, string][] = [];
      const commands: unknown[] = [];
      for (const c of wizCollabs) {
        const pid = m2o(c["partner_id"]);
        if (!pid) continue;
        const mode = String(c["access_mode"] ?? "view");
        const existing = byPartner.get(pid);
        if (!existing) toAdd.push([pid, mode]);
        else if (existing.access_mode !== mode) commands.push([1, existing.id, { access_mode: mode }]);
      }
      if (toAdd.length) {
        // project._get_new_collaborators: partner not in existing collaborators and partner_share is True
        const addPids = [...new Set(toAdd.map(([p]) => p))];
        const shareRows = (await env.cr.query<{ id: number }>(
          "SELECT id FROM res_partner WHERE id = ANY($1::int[]) AND partner_share IS TRUE", [addPids])).rows;
        const allowed = new Set(shareRows.map((r) => r.id).filter((p) => !byPartner.has(p)));
        for (const [pid, mode] of toAdd) {
          if (allowed.has(pid)) commands.push([0, 0, { partner_id: pid, access_mode: mode }]);
        }
      }
      for (const cid of toRemove) commands.push([2, cid, 0]);
      if (commands.length) await write(env, "project.project", [projectId], { collaborator_ids: commands });
    }
    return ids;
  },
});

// Model-specific create & web_save for project.share.wizard so override_guard passes (its create override is ported above).
button("project.share.wizard", "create", async (env, _ids, args, kwargs) => {
  const raw = kwargs["vals_list"] ?? args[0];
  if (isRecord(raw)) {
    const [id] = await create(env, "project.share.wizard", [raw]);
    return id!;
  }
  if (!Array.isArray(raw) || raw.some((v) => !isRecord(v))) throw new NotPorted("project.share.wizard.create vals_list");
  return create(env, "project.share.wizard", raw as Record<string, unknown>[]);
}, { apiModel: true });

button("project.share.wizard", "web_save", async (env, ids, args, kwargs) => {
  const vals = kwargs["vals"] ?? args[0];
  if (!isRecord(vals)) throw new NotPorted("project.share.wizard.web_save vals");
  const spec = parseSpecification(kwargs["specification"] ?? args[1]);
  const recIds = recordIds(ids, [], "web_save");
  const outIds = recIds.length
    ? (await write(env, "project.share.wizard", recIds, vals), recIds)
    : await create(env, "project.share.wizard", [vals]);
  return webRead(env, "project.share.wizard", outIds, spec);
});

/** `werkzeug.urls.url_encode` preserving key order (spaces as '+', unreserved chars unescaped). */
function urlEncodeOrdered(entries: ReadonlyArray<[string, string]>): string {
  const q = (v: string): string => {
    let out = "";
    for (const b of Buffer.from(v, "utf8")) {
      const c = String.fromCharCode(b);
      out += /[A-Za-z0-9_.~-]/.test(c) ? c : b === 0x20 ? "+" : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
    return out;
  };
  return entries.map(([k, v]) => `${q(k)}=${q(v)}`).join("&");
}

const SHARE_MSG_BODY = { sanitizeTags: true, sanitizeAttributes: true, sanitizeStyle: true, sanitizeForm: true, stripStyle: false, stripClasses: false };

function formatEnList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

async function shareWizardSendMail(env: Environment, wizardId: number): Promise<Action> {
  const wiz = (await env.model("project.share.wizard").read([wizardId], ["res_model", "res_id", "note", "collaborator_ids"], ""))[0];
  const cIds = Array.isArray(wiz?.["collaborator_ids"]) ? (wiz!["collaborator_ids"] as number[]) : [];
  if (cIds.length) {
    const collabs = await env.model("project.share.collaborator.wizard").read(cIds, ["partner_id", "send_invitation"], "");
    // `self.collaborator_ids.filtered('send_invitation').partner_id`: unique partners in collaborator order
    const toInvite: number[] = [];
    for (const c of collabs) {
      if (!c["send_invitation"]) continue;
      const pid = m2o(c["partner_id"]);
      if (typeof pid === "number" && !toInvite.includes(pid)) toInvite.push(pid);
    }
    if (toInvite.length) {
      const resModel = String(wiz?.["res_model"] ?? "");
      const resId = typeof wiz?.["res_id"] === "number" ? wiz["res_id"] : 0;
      if (!resModel || !resId) throw new NotPorted("project.share.wizard.action_send_mail without res_model/res_id");
      const ctx = requestOfCursor(env.cr);
      if (ctx === null) throw new NotPorted("project.share.wizard.action_send_mail outside a request");
      // portal_share.py:86-111 `_send_signup_link(partners=partners_to_invite.with_context({'signup_valid': True}))`
      const isInternalOrAdmin = (await env.cr.query("SELECT 1 FROM res_users WHERE id = $1 AND share IS NOT TRUE", [env.uid])).rows.length > 0;
      if (!isInternalOrAdmin) throw new AccessDenied();
      const baseUrl = (await configParam(env.sudo(), "web.base.url")) ?? "";
      const db = ctx.db ?? "";
      const noteText = typeof wiz?.["note"] === "string" && wiz["note"] ? wiz["note"] : false;
      const noteSubtype = await xmlid(env, "mail.mt_note");
      const companyId = await env.company();
      const recDisplayName = (await env.model(resModel).displayName([resId])).get(resId) ?? "";
      for (const pid of toInvite) {
        const users = (await env.cr.query<{ id: number }>(
          "SELECT id FROM res_users WHERE partner_id = $1 AND active ORDER BY id", [pid])).rows;
        // signup_get_auth_param (b2c) + _get_signup_url_for_action with signup_valid=True -> signup_prepare when no active users
        if (!users.length) {
          await write(env.sudo(), "res.partner", [pid], { signup_type: "signup" });
        }
        const pRow = (await env.cr.query<{ signup_type: string | null; lang: string | null }>(
          "SELECT signup_type, lang FROM res_partner WHERE id = $1", [pid])).rows[0];
        let route = "login";
        const queryEntries: [string, string][] = [["db", db]];
        const signupType = pRow?.signup_type || "";
        if (signupType) {
          route = signupType === "reset" ? "reset_password" : signupType;
          if (users.length) throw new NotPorted("project.share.wizard signup token for partner with active users");
          queryEntries.push(["token", await signupToken(env, pid)]);
        }
        const redirect = `/mail/view?${urlEncodeOrdered([["model", resModel], ["res_id", String(resId)]])}`;
        queryEntries.push(["redirect", redirect]);
        const shareLink = `${baseUrl}/web/${route}?${urlEncodeOrdered(queryEntries)}`;
        const partnerLang = pRow?.lang || env.lang || "en_US";
        const langEnv = partnerLang !== env.lang ? env.withContext({ ...env.context, lang: partnerLang }) : env;
        const modelDesc = (await env.cr.query<{ name: string }>(
          "SELECT COALESCE(name->>$2, name->>'en_US') AS name FROM ir_model WHERE model = $1", [resModel, partnerLang])).rows[0]?.name ?? resModel;
        const bodyHtml = await renderQweb(langEnv, "portal.portal_share_template", {
          partner: new PyRecords(langEnv, "res.partner", [pid]),
          note: noteText,
          record: new PyRecords(langEnv, resModel, [resId]),
          share_link: shareLink,
          model_description: modelDesc.toLowerCase(),
          user: new PyRecords(langEnv, "res.users", [env.uid]),
          company: new PyRecords(langEnv, "res.company", [companyId]),
        }, false);
        const [authorId, emailFrom] = await computeAuthor(langEnv, null, null);
        const subject = translate(langEnv, "Invitation to access %s", "portal").replace("%s", recDisplayName);
        const [mid] = await insertMessages(langEnv, [{
          model: resModel, res_id: resId,
          body: htmlSanitize(bodyHtml, SHARE_MSG_BODY),
          author_id: authorId, email_from: emailFrom,
          message_type: "user_notification", subtype_id: noteSubtype, is_internal: true,
          subject, reply_to: await replyToDefault(langEnv, emailFrom),
          message_id: trackingMessageId("message-notify"),
          email_add_signature: true, record_alias_domain_id: false,
          record_company_id: await recordCompany(langEnv, resModel, resId),
          email_layout_xmlid: "mail.mail_notification_light",
          partner_ids: [pid],
        }]);
        const nr = await notifyThread(ctx, langEnv, resModel, resId, mid!, { light: true, notifyAuthorMention: true });
        await nr.send();
      }
      // portal_share.py:113-122 `_log_share_message(partners_to_invite)`
      const envLang = env.lang ?? "en_US";
      const modelName = (await env.cr.query<{ name: string }>(
        "SELECT COALESCE(name->>$2, name->>'en_US') AS name FROM ir_model WHERE model = $1", [resModel, envLang])).rows[0]?.name ?? resModel;
      const pInfoRows = (await env.cr.query<{ id: number; name: string | null; email: string | null }>(
        "SELECT id, name, email FROM res_partner WHERE id = ANY($1::int[])", [toInvite])).rows;
      const pInfoMap = new Map(pInfoRows.map((r) => [r.id, r]));
      const labels = toInvite.map((pid) => {
        const p = pInfoMap.get(pid);
        return p?.email ? `${p.name ?? ""} (${p.email})` : (p?.name ?? "");
      });
      const logText = translate(env, "%(model_name)s shared with %(partner_names)s", "portal")
        .replace("%(model_name)s", modelName)
        .replace("%(partner_names)s", formatEnList(labels));
      await messageLogBatch(env, resModel, new Map([[resId, plaintextBody(logText)]]));
    }
  }
  return {
    type: "ir.actions.client",
    tag: "display_notification",
    params: {
      type: "success",
      message: translate(env, "Project shared with your collaborators.", "project"),
      next: { type: "ir.actions.act_window_close" },
    },
  };
}

// project/wizard/project_share_wizard.py:102-135
button("project.share.wizard", "action_share_record", async (env, ids) => {
  const id = ensureOne(ids, "project.share.wizard", "action_share_record");
  const wiz = (await env.model("project.share.wizard").read([id], ["collaborator_ids"], ""))[0];
  const cIds = Array.isArray(wiz?.["collaborator_ids"]) ? (wiz!["collaborator_ids"] as number[]) : [];
  if (!cIds.length) return null;
  const scope = (await configParam(env.sudo(), "auth_signup.invitation_scope")) || "b2b";
  const onInvite = scope === "b2b";
  let hasNewPortalUser = false;
  if (onInvite) {
    const collabs = await env.model("project.share.collaborator.wizard").read(cIds, ["partner_id", "send_invitation"], "");
    const invitePids = collabs.filter((c) => Boolean(c["send_invitation"])).map((c) => m2o(c["partner_id"])).filter((p): p is number => typeof p === "number");
    if (invitePids.length) {
      const withUsers = new Set(
        (await env.cr.query<{ partner_id: number }>(
          "SELECT DISTINCT partner_id FROM res_users WHERE partner_id = ANY($1::int[]) AND active IS TRUE", [invitePids])).rows.map((r) => r.partner_id),
      );
      hasNewPortalUser = invitePids.some((pid) => !withUsers.has(pid));
    }
  }
  if (!hasNewPortalUser) return shareWizardSendMail(env, id);
  return {
    name: translate(env, "Confirmation", "project"),
    type: "ir.actions.act_window",
    view_mode: "form",
    views: [[await refId(env, "project.project_share_wizard_confirm_form"), "form"]],
    res_model: "project.share.wizard",
    res_id: id,
    target: "new",
    context: env.context,
  };
});

button("project.share.wizard", "action_send_mail", async (env, ids) => {
  const id = ensureOne(ids, "project.share.wizard", "action_send_mail");
  return shareWizardSendMail(env, id);
});

// ================================================================================================================
// 7. project.task actions & computes
// ================================================================================================================

defineComputes("project.task", {
  // project/models/project_task.py:750-753 `_compute_display_parent_task_button` (compute_sudo=True)
  display_parent_task_button: async (env, rec) => {
    const parentId = m2o(await rec.get("parent_id"));
    if (!parentId) return false;
    return (await filteredAccess(env, "project.task", [parentId], "read")).has(parentId);
  },
  // sale_project/models/project_task.py:153-163 `_compute_display_sale_order_button`
  display_sale_order_button: async (env, rec) => {
    const soId = m2o(await rec.get("sale_order_id"));
    if (!soId) return false;
    try {
      const found = await env.model("sale.order").search(cond("id", "in", [soId]));
      return found.includes(soId);
    } catch (e) {
      if (e instanceof AccessError) return false;
      throw e;
    }
  },
});

// project/models/project_task.py:1921-1928
button("project.task", "action_open_task", async (env, ids) => {
  const id = ensureOne(ids, "project.task", "action_open_task");
  return {
    view_mode: "form",
    res_model: "project.task",
    res_id: id,
    type: "ir.actions.act_window",
    context: env.context,
  };
});

// project/models/project_task.py:1955-1958
button("project.task", "action_project_sharing_open_task", async (env, ids) => {
  const id = ensureOne(ids, "project.task", "action_project_sharing_open_task");
  return {
    view_mode: "form",
    res_model: "project.task",
    res_id: id,
    type: "ir.actions.act_window",
    context: env.context,
    views: [[await refId(env, "project.project_sharing_project_task_view_form"), "form"]],
  };
});

// project_todo/models/project_task.py:24-32
button("project.task", "action_convert_to_task", async (env, ids) => {
  const id = ensureOne(ids, "project.task", "action_convert_to_task");
  const task = (await env.model("project.task").read([id], ["project_id", "company_id", "user_ids"], ""))[0];
  if (!task) throw new NotPorted("project.task.action_convert_to_task on missing record");
  const projId = m2o(task["project_id"]);
  let companyId: number | false = false;
  if (projId) {
    const proj = (await env.model("project.project").read([projId], ["company_id"], ""))[0];
    companyId = m2o(proj?.["company_id"]);
  }
  await env.model("project.task").checkAccess([id], "write");
  const curCompany = m2o(task["company_id"]);
  if (curCompany !== companyId) {
    await writeColumns(env, env.reg.model("project.task"), [[id, { company_id: companyId || null }]], true);
    // project_task.py:1407-1409: keep only assignees belonging to the new company
    if (companyId) {
      const uids = Array.isArray(task["user_ids"]) ? (task["user_ids"] as number[]) : [];
      if (uids.length) {
        const allowed = new Set((await env.cr.query<{ u: number }>(
          "SELECT user_id AS u FROM res_company_users_rel WHERE cid = $1 AND user_id = ANY($2::int[])",
          [companyId, uids])).rows.map((r) => r.u));
        const filtered = uids.filter((u) => allowed.has(u));
        if (filtered.length !== uids.length) await write(env, "project.task", [id], { user_ids: [[6, 0, filtered]] });
      }
    }
  }
  return {
    view_mode: "form",
    res_model: "project.task",
    res_id: id,
    type: "ir.actions.act_window",
  };
});

// project/models/project_task.py:1976-1984
button("project.task", "action_project_sharing_open_blocking", async (env, ids) => {
  const id = ensureOne(ids, "project.task", "action_project_sharing_open_blocking");
  const task = (await env.model("project.task").read([id], ["dependent_ids"], ""))[0];
  if (!task) throw new NotPorted("project.task.action_project_sharing_open_blocking on missing record");
  const blockings = Array.isArray(task["dependent_ids"]) ? (task["dependent_ids"] as number[]) : [];
  const action = await forXmlId(env, "project.project_sharing_project_task_action_blocking_tasks");
  if (blockings.length === 1) {
    action["view_mode"] = "form";
    if (Array.isArray(action["views"])) {
      action["views"] = (action["views"] as [unknown, string][]).filter(([, vt]) => vt === "form");
    }
    action["res_id"] = blockings[0]!;
  }
  return action;
});

// project/models/project_task.py:1960-1974
button("project.task", "action_project_sharing_open_subtasks", async (env, ids) => {
  const id = ensureOne(ids, "project.task", "action_project_sharing_open_subtasks");
  const task = (await env.model("project.task").read([id], ["project_id"], ""))[0];
  if (!task) throw new NotPorted("project.task.action_project_sharing_open_subtasks on missing record");
  const projId = m2o(task["project_id"]);
  const subtasks = await env.model("project.task").search(and([cond("id", "child_of", [id]), cond("id", "!=", id)]));
  if (await tasksHaveSameProject(env, subtasks, projId)) {
    const action = await forXmlId(env, "project.project_sharing_project_task_action_sub_task");
    if (subtasks.length === 1) {
      action["view_mode"] = "form";
      if (Array.isArray(action["views"])) {
        action["views"] = (action["views"] as [unknown, string][]).filter(([, vt]) => vt === "form");
      }
      action["res_id"] = subtasks[0]!;
    }
    return action;
  }
  if (subtasks.length === 0) throw new NotPorted("action_project_sharing_open_subtasks with no subtasks (Expected singleton)");
  const url = subtasks.length > 1
    ? `/my/projects/${projId === false ? "False" : projId}/task/${id}/subtasks`
    : await taskPortalUrl(env, subtasks[0]!, "project_sharing=1");
  return { name: "Portal Sub-tasks", type: "ir.actions.act_url", url };
});

// project/models/project_task.py:2007-2026
button("project.task", "action_project_sharing_recurring_tasks", async (env, ids) => {
  const id = ensureOne(ids, "project.task", "action_project_sharing_recurring_tasks");
  const task = (await env.model("project.task").read([id], ["project_id", "recurrence_id"], ""))[0];
  if (!task) throw new NotPorted("project.task.action_project_sharing_recurring_tasks on missing record");
  const projId = m2o(task["project_id"]);
  const recId = m2o(task["recurrence_id"]);
  const recIds = recId ? [recId] : [];
  const recurrentTasks = await env.model("project.task").search(cond("recurrence_id", "in", recIds));
  if (await tasksHaveSameProject(env, recurrentTasks, projId)) {
    const action = await forXmlId(env, "project.project_sharing_project_task_recurring_tasks_action");
    action["context"] = { default_project_id: projId };
    action["domain"] = [["project_id", "=", projId], ["recurrence_id", "in", recIds]];
    return action;
  }
  return {
    name: "Portal Recurrent Tasks",
    type: "ir.actions.act_url",
    url: `/my/projects/${projId === false ? "False" : projId}/task/${id}/recurrent_tasks`,
  };
});

// project/models/project_task.py:2297-2305
button("project.task", "action_project_sharing_toggle_assign", async (env, ids) => {
  const id = ensureOne(ids, "project.task", "action_project_sharing_toggle_assign");
  await env.model("project.task").checkAccess([id], "write");
  const task = (await env.model("project.task").read([id], ["user_ids"], ""))[0];
  if (!task) throw new NotPorted("project.task.action_project_sharing_toggle_assign on missing record");
  const userIds = Array.isArray(task["user_ids"]) ? (task["user_ids"] as number[]) : [];
  const cmd = userIds.includes(env.uid) ? [[3, env.uid, 0]] : [[4, env.uid, 0]];
  const targetEnv = (await isPortalUser(env)) ? env.sudo() : env;
  await write(targetEnv, "project.task", [id], { user_ids: cmd });
  return true;
});

/** project/models/project_project.py:1190-1196 `_check_project_sharing_access`. */
async function checkProjectSharingAccess(env: Environment, projectId: number): Promise<boolean> {
  const row = (await env.cr.query<{ vis: string | null }>("SELECT privacy_visibility AS vis FROM project_project WHERE id = $1", [projectId])).rows[0];
  if (!row || (row.vis !== "invited_users" && row.vis !== "portal")) return false;
  if (await isPortalUser(env)) {
    const pid = (await userInfo(env)).partnerId;
    const found = await env.model("project.collaborator").search(and([cond("project_id", "=", projectId), cond("partner_id", "=", pid)]), { limit: 1 });
    return found.length > 0;
  }
  return isInternalUser(env);
}

// project/models/project_task.py:1893-1915
button("project.task", "action_project_sharing_view_parent_task", async (env, ids) => {
  const id = ensureOne(ids, "project.task", "action_project_sharing_view_parent_task");
  const task = (await env.model("project.task").read([id], ["project_id", "parent_id", "display_parent_task_button"], ""))[0];
  if (!task) throw new NotPorted("project.task.action_project_sharing_view_parent_task on missing record");
  const projId = m2o(task["project_id"]);
  const parentId = m2o(task["parent_id"]);
  let parentProjId: number | false = false;
  if (parentId) {
    const pRow = (await env.sudo().model("project.task").read([parentId], ["project_id"], ""))[0];
    parentProjId = m2o(pRow?.["project_id"]);
  }
  if (parentProjId !== projId && await isPortalUser(env)) {
    const readableProj = parentProjId ? (await filteredAccess(env, "project.project", [parentProjId], "read")).has(parentProjId) : false;
    if (readableProj && parentProjId && parentId) {
      const sharing = await checkProjectSharingAccess(env, parentProjId);
      const url = sharing ? `/my/projects/${parentProjId}?task_id=${parentId}` : `/my/projects/${parentProjId}/task/${parentId}`;
      return { name: "Portal Parent Task", type: "ir.actions.act_url", url };
    }
    if (task["display_parent_task_button"] && parentId) {
      return taskPortalUrl(env, parentId);
    }
    return {};
  }
  // project_task.py:1909-1915: `self.with_context({...})` replaces context, keeping only allowed_company_ids.
  return {
    name: translate(env, "Parent Task", "project"),
    view_mode: "form",
    res_model: "project.task",
    res_id: parentId,
    type: "ir.actions.act_window",
    context: {
      ...(env.context["allowed_company_ids"] !== undefined ? { allowed_company_ids: env.context["allowed_company_ids"] } : {}),
      search_view_ref: "project.project_sharing_project_task_view_search",
      default_project_id: projId,
    },
    views: [[await refId(env, "project.project_sharing_project_task_view_form"), "form"]],
    search_view_id: await refId(env, "project.project_sharing_project_task_view_search"),
  };
});

// sale_project/models/project_task.py:199-207
button("project.task", "action_project_sharing_view_so", async (env, ids) => {
  const id = ensureOne(ids, "project.task", "action_project_sharing_view_so");
  const task = (await env.model("project.task").read([id], ["display_sale_order_button", "sale_order_id"], ""))[0];
  if (!task || !task["display_sale_order_button"]) return {};
  const soId = m2o(task["sale_order_id"]);
  return {
    name: translate(env, "Portal Sale Order", "sale_project"),
    type: "ir.actions.act_url",
    url: soId ? `/my/orders/${soId}` : "#",
  };
});

// ================================================================================================================
// 8. crm.lead
// ================================================================================================================

// sale_crm/models/crm_lead.py:53-66
button("crm.lead", "action_view_sale_order", async (env, ids) => {
  const id = ensureOne(ids, "crm.lead", "action_view_sale_order");
  const lead = (await env.model("crm.lead").read([id], ["partner_id"], ""))[0];
  if (!lead) throw new NotPorted("crm.lead.action_view_sale_order on missing record");
  const partnerId = m2o(lead["partner_id"]);
  const action = await forXmlId(env, "sale.action_orders");
  action["context"] = {
    search_default_partner_id: partnerId,
    default_partner_id: partnerId,
    default_opportunity_id: id,
  };
  action["domain"] = ["&", ["opportunity_id", "=", id], ["state", "not in", ["draft", "sent", "cancel"]]];
  const orders = await env.model("sale.order").search(
    and([cond("opportunity_id", "=", id), cond("state", "not in", ["draft", "sent", "cancel"])]),
  );
  if (orders.length === 1) {
    action["views"] = [[await refId(env, "sale.view_order_form"), "form"]];
    action["res_id"] = orders[0]!;
  }
  return action;
});

/** crm_sale_project/models/crm_lead.py:37-70 `_get_project_create_from_lead_context`. */
async function projectCreateFromLeadContext(env: Environment, id: number): Promise<Record<string, unknown>> {
  const lead = (await env.model("crm.lead").read([id], ["company_id", "partner_id", "order_ids"], ""))[0];
  if (!lead) throw new NotPorted("crm.lead project context on missing record");
  const orderIds = Array.isArray(lead["order_ids"]) ? (lead["order_ids"] as number[]) : [];
  let saleLineId: number | false = false;
  let defaultOrderId: number | false = false;
  if (orderIds.length) {
    const lines = await env.model("sale.order.line").search(and([
      cond("order_id", "in", orderIds),
      cond("is_service", "=", true),
      cond("qty_delivered_method", "in", ["timesheets", "milestones", "manual"]),
    ]));
    if (lines.length) {
      const lRows = await env.model("sale.order.line").read(lines, ["qty_delivered_method", "order_id"], "");
      const pick = (m: string) => lRows.find((r) => r["qty_delivered_method"] === m);
      const chosen = pick("timesheets") ?? pick("milestones") ?? pick("manual");
      if (chosen) {
        saleLineId = Number(chosen["id"]);
        defaultOrderId = m2o(chosen["order_id"]);
      }
    }
    if (!saleLineId) defaultOrderId = orderIds[0] ?? false;
  }
  return {
    default_company_id: m2o(lead["company_id"]),
    default_lead_id: id,
    default_partner_id: m2o(lead["partner_id"]),
    default_allow_billable: true,
    default_reinvoiced_sale_order_id: defaultOrderId,
    default_sale_line_id: saleLineId,
    lead_company_id: m2o(lead["company_id"]),
  };
}

// crm_sale_project/models/crm_lead.py:72-83
button("crm.lead", "action_create_project", async (env, ids) => {
  const id = ensureOne(ids, "crm.lead", "action_create_project");
  const lead = (await env.model("crm.lead").read([id], ["name"], ""))[0];
  if (!lead) throw new NotPorted("crm.lead.action_create_project on missing record");
  const base = await openProjectTemplateView(env);
  const viewId = await refId(env, "crm_sale_project.crm_project_view_form_simplified_template");
  return {
    ...base,
    name: translate(env, "Create a Project", "crm_sale_project"),
    views: [[viewId, "form"]],
    context: {
      ...(await projectCreateFromLeadContext(env, id)),
      default_name: lead["name"],
    },
  };
});

// crm_sale_project/models/crm_lead.py:85-101
button("crm.lead", "action_view_project_ids", async (env, ids) => {
  const id = ensureOne(ids, "crm.lead", "action_view_project_ids");
  const projectIds = await env.model("project.project").search(cond("lead_id", "=", id));
  const leadCtx = await projectCreateFromLeadContext(env, id);
  if (projectIds.length === 1) {
    const action = await projectActionViewTasks(env, projectIds[0]!);
    action["context"] = { ...(action["context"] as Record<string, unknown>), ...leadCtx };
    return action;
  }
  const action = await forXmlId(env, "project.open_view_project_all");
  return {
    ...action,
    domain: ["|", ["lead_id", "=", id], ["id", "in", projectIds]],
    context: leadCtx,
  };
});

// mail/models/mail_thread_blacklist.py:110-124
button("crm.lead", "mail_action_blacklist_remove", async (env) => {
  if (await hasModelAccess(env, "mail.blacklist", "write")) {
    return {
      name: translate(env, "Are you sure you want to unblacklist this Email Address?", "mail"),
      type: "ir.actions.act_window",
      view_mode: "form",
      res_model: "mail.blacklist.remove",
      target: "new",
    };
  }
  throw new AccessError(translate(env, "You do not have the access right to unblacklist emails. Please contact your administrator.", "mail"));
});

// phone_validation/models/mail_thread_phone.py:228-241
button("crm.lead", "phone_action_blacklist_remove", async (env) => {
  if (await hasModelAccess(env, "phone.blacklist", "write")) {
    return {
      name: translate(env, "Are you sure you want to unblacklist this Phone Number?", "phone_validation"),
      type: "ir.actions.act_window",
      view_mode: "form",
      res_model: "phone.blacklist.remove",
      target: "new",
    };
  }
  throw new AccessError(translate(env, "You do not have the access right to unblacklist phone numbers. Please contact your administrator.", "phone_validation"));
});

// ================================================================================================================
// 9. crm.lost.reason
// ================================================================================================================

// crm/models/crm_lost_reason.py:26-34
button("crm.lost.reason", "action_lost_leads", async (env, ids) => ({
  name: translate(env, "Leads", "crm"),
  view_mode: "list,form",
  domain: [["lost_reason_id", "in", [...ids]]],
  res_model: "crm.lead",
  type: "ir.actions.act_window",
  context: { create: false, active_test: false },
}));

// ================================================================================================================
// 10. crm.lead.pls.update
// ================================================================================================================

registerDefaults("crm.lead.pls.update", {
  // crm/wizard/crm_lead_pls_update.py:11-22
  pls_start_date: async (env) => {
    const raw = await configParam(env.sudo(), "crm.pls_start_date");
    if (!raw || !/^\d{4}-\d{2}-\d{2}/.test(raw)) return false;
    return raw.slice(0, 10);
  },
  pls_fields: async (env) => {
    const raw = await configParam(env.sudo(), "crm.pls_fields");
    if (!raw) return false;
    const names = raw.split(",");
    const fieldIds = await env.model("ir.model.fields").search(and([cond("name", "in", names), cond("model", "=", "crm.lead")]));
    if (!fieldIds.length) return [];
    const ids = await env.model("crm.lead.scoring.frequency.field").search(cond("field_id", "in", fieldIds));
    return ids.length ? [[6, 0, ids]] : [];
  },
});

/** base/models/ir_config_parameter.py:78-97 `set_str(key, value)` as sudo. */
async function setConfigStr(env: Environment, key: string, value: string): Promise<void> {
  const sudo = env.sudo();
  const row = (await sudo.cr.query<{ id: number; value: string | null }>(
    "SELECT id, value FROM ir_config_parameter WHERE key = $1 ORDER BY id LIMIT 1", [key])).rows[0];
  if (!row) {
    await create(sudo, "ir.config_parameter", [{ key, value }]);
  } else if ((row.value ?? "") !== value) {
    await write(sudo, "ir.config_parameter", [row.id], { value });
  }
}

// crm/wizard/crm_lead_pls_update.py:27-36
button("crm.lead.pls.update", "action_update_crm_lead_probabilities", async (env, ids) => {
  const isAdmin = env.su || env.uid === 1 || await hasGroup(env, "base.group_erp_manager");
  if (!isAdmin) return null;
  const id = ensureOne(ids, "crm.lead.pls.update", "action_update_crm_lead_probabilities");
  const wiz = (await env.model("crm.lead.pls.update").read([id], ["pls_start_date", "pls_fields"], ""))[0];
  if (!wiz) throw new NotPorted("crm.lead.pls.update on missing record");
  const fieldRecIds = Array.isArray(wiz["pls_fields"]) ? (wiz["pls_fields"] as number[]) : [];
  if (fieldRecIds.length) {
    const fRows = await env.model("crm.lead.scoring.frequency.field").read(fieldRecIds, ["field_id"], "");
    const imfIds: number[] = [];
    for (const r of fRows) {
      const fid = m2o(r["field_id"]);
      if (fid && !imfIds.includes(fid)) imfIds.push(fid);
    }
    const nameRows = imfIds.length ? await env.sudo().model("ir.model.fields").read(imfIds, ["name"], "") : [];
    const byId = new Map(nameRows.map((r) => [Number(r["id"]), String(r["name"] ?? "")]));
    const names = imfIds.map((fid) => byId.get(fid) ?? "").filter(Boolean);
    await setConfigStr(env, "crm.pls_fields", names.join(","));
  } else {
    await setConfigStr(env, "crm.pls_fields", "");
  }
  await setConfigStr(env, "crm.pls_start_date", String(wiz["pls_start_date"] ?? ""));
  await cronUpdateAutomatedProbabilities(env.sudo());
  return null;
});
