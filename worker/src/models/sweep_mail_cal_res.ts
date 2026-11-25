/**
 * UI button methods (`<button type="object">`) for Mail (`mail.*`), Calendar (`calendar.*`), and
 * Contacts/Users/Groups/Company/Settings (`res.*`), matching Odoo 20 Community source in `odoo/addons/`
 * and `odoo/odoo/addons/base/`.
 */
import { AccessError, MissingError, NotPorted, OdooError, UserError, ValidationError } from "../errors";
import { genAssetJson } from "../gen_assets";
import { requestOfCursor } from "../http/context";
import { callKw, registerMethod } from "../http/methods";
import { actionFeedback, createActivities, scheduleActivities } from "../mail/activity";
import { messageSubscribeApi } from "../mail/actions";
import { busSend } from "../mail/busnotify";
import { deleteFollowers } from "../mail/followers";
import { sendMails } from "../mail/mail_queue";
import { computeAuthor, emailNormalize, escapeText, insertMessages, partnerEmailFormatted, replyToDefault, trackingMessageId, xmlid } from "../mail/message";
import { notifyThread } from "../mail/notify";
import { Store } from "../mail/store";
import { sendMailBatch } from "../mail/template_send";
import { isGenericThread, permissionOn } from "../mail/thread_generic";
import { permission } from "../mail/thread";
import { setTrackLogMessage } from "../mail/tracking";
import { checkModelAccess } from "../orm/access";
import { create } from "../orm/create";
import { and, cond, parseDomain, TRUE } from "../orm/domain";
import { envTz, userInfo, userInfoOf } from "../orm/env";
import { registerHooks } from "../orm/hooks";
import { EMAIL_OUTGOING_XML } from "../orm/html_output";
import { htmlSanitize } from "../orm/html_sanitize";
import { registerDefaults, registerRecordCompute } from "../orm/recompute";
import { queryIds, searchDomainOf, searchQuery } from "../orm/sql";
import { templateOf } from "../orm/template";
import type { Domain, Environment } from "../orm/types";
import { unlink } from "../orm/unlink";
import { registerOverrides, write } from "../orm/write";
import { PySet } from "./pyset";
import { renderTemplateField } from "../qweb/mail_render";
import { envFor, intArg, optInt, optStr } from "../web/common";
import { isHtmlEmpty } from "../web/empty_list_help";
import { userHasGroup } from "../web/groups";
import { fetchRecords, forXmlId } from "./account_buttons";
import { notifyAttendees, type Attendee } from "./calendar_invitation";
import { activateLangs, loadManifestTerms, saveModelEntries, type ModelSave } from "./lang_install";
import { parseResIds } from "./mail_activity_schedule";
import { addDelay } from "./mail_activity_write";
import { checkIdentity } from "./res_users_password";
import { configParam, defineComputes, formatPosix, getLang, wallClock } from "./tail_util";
import { datetimeToString, dbNow, todayInTz, translate, validTz } from "./util";

// ----------------------------------------------------------------------------------------------------------------
// Common helpers
// ----------------------------------------------------------------------------------------------------------------

type ButtonFn = (env: Environment, ids: number[], args: unknown[], kwargs: Record<string, unknown>) => Promise<unknown>;

function button(model: string, method: string, fn: ButtonFn, opts?: { readonly readonly?: boolean }): void {
  registerMethod(model, method, async (env0, ids, args, kwargs0) => {
    const { env, kwargs } = envFor(env0, kwargs0);
    return fn(env, ids ?? [], args, kwargs);
  }, { apiModel: false, ...(opts?.readonly ? { readonly: true } : {}) });
}

function ensureOne(ids: readonly number[], model: string): number {
  if (ids.length !== 1) {
    throw new OdooError("builtins.ValueError", `Expected singleton: ${model}(${ids.join(", ")}${ids.length === 1 ? "," : ""})`);
  }
  return ids[0]!;
}

function m2oId(v: unknown): number | null {
  if (Array.isArray(v)) return typeof v[0] === "number" ? v[0] : null;
  return typeof v === "number" && v > 0 ? v : null;
}

function cleanContext(ctx: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) if (!k.startsWith("default_")) out[k] = v;
  return out;
}

async function contextToday(env: Environment): Promise<string> {
  const tz = validTz(env.context["tz"]) ?? validTz((await userInfo(env)).tz) ?? "UTC";
  return todayInTz(await dbNow(env), tz);
}

function shiftDateDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Python `date + relativedelta(weeks=1, weekday=MO(-1))`: always Monday of the next week. */
function nextWeekMonday(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  const mon0 = (dt.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  return shiftDateDays(isoDate, 7 - mon0);
}

function pyJsonDumps(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(pyJsonDumps).join(", ")}]`;
  if (typeof v === "object") {
    return `{${Object.entries(v as Record<string, unknown>).map(([k, val]) => `${JSON.stringify(k)}: ${pyJsonDumps(val)}`).join(", ")}}`;
  }
  return JSON.stringify(v);
}

function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (typeof v === "object") {
    return `{${Object.entries(v as Record<string, unknown>).map(([k, val]) => `${pyRepr(k)}: ${pyRepr(val)}`).join(", ")}}`;
  }
  return String(v);
}

async function hasModelAccess(env: Environment, model: string, op: "read" | "write" | "create" | "unlink"): Promise<boolean> {
  try {
    await checkModelAccess(env, env.reg.model(model), op);
    return true;
  } catch (e) {
    if (e instanceof AccessError) return false;
    throw e;
  }
}

async function hasRecordReadAccess(env: Environment, model: string, id: number): Promise<boolean> {
  try {
    const found = await env.model(model).search(cond("id", "=", id), { limit: 1, activeTest: false });
    return found.length > 0;
  } catch (e) {
    if (e instanceof AccessError) return false;
    throw e;
  }
}

/** mail/models/models.py:155-201 `_mail_get_customer` (with mail/models/res_partner.py:57-58 override). */
async function mailGetCustomer(env: Environment, model: string, id: number): Promise<number | null> {
  if (model === "res.partner") return id;
  const def = env.reg.model(model);
  const fnames = ["partner_id", "partner_ids"].filter((f) => def.fields.has(f));
  if (!fnames.length) return null;
  const row = (await env.model(model).read([id], fnames, ""))[0];
  if (!row) return null;
  for (const f of fnames) {
    const v = row[f];
    if (typeof v === "number" && v > 0) return v;
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "number") return v[0];
  }
  return null;
}

/** Sync calendar.event start when mail.activity.date_deadline is written (calendar/models/mail_activity.py:14-33). */
async function writeActivityDeadline(env: Environment, ids: readonly number[], dateDeadline: string): Promise<void> {
  if (!ids.length) return;
  await write(env, "mail.activity", ids, { date_deadline: dateDeadline });
  if (env.context["calendar_event_meeting_update"]) return;
  const evRows = (await env.cr.query<{ event_id: number; allday: boolean | null; start: string; start_date: string | null }>(
    `SELECT DISTINCT e.id AS event_id, e.allday, to_char(e.start, 'YYYY-MM-DD HH24:MI:SS') AS start, e.start_date::text AS start_date
       FROM mail_activity a JOIN calendar_event e ON e.id = a.calendar_event_id
      WHERE a.id = ANY($1::int[])`, [[...ids]])).rows;
  if (!evRows.length) return;
  const tz = await envTz(env);
  const cenv = env.withContext({ ...env.context, mail_activity_meeting_update: true });
  for (const ev of evRows) {
    let diffDays = 0;
    if (ev.allday) {
      if (!ev.start_date || ev.start_date === dateDeadline) continue;
      const a = Date.parse(`${dateDeadline}T00:00:00Z`), b = Date.parse(`${ev.start_date}T00:00:00Z`);
      diffDays = Math.round((a - b) / 86400000);
    } else {
      const startDt = new Date(`${ev.start.replace(" ", "T")}Z`);
      const oldDate = todayInTz(startDt, tz);
      const a = Date.parse(`${dateDeadline}T00:00:00Z`), b = Date.parse(`${oldDate}T00:00:00Z`);
      diffDays = Math.round((a - b) / 86400000);
    }
    if (diffDays === 0) continue;
    const newStart = new Date(Date.parse(`${ev.start.replace(" ", "T")}Z`) + diffDays * 86400000);
    await write(cenv, "calendar.event", [ev.event_id], { start: datetimeToString(newStart).slice(0, 19) });
  }
}

/** Shared helper for mail.activity.action_done (`self.filtered('active').action_feedback()`). */
async function doActivityDone(env: Environment, ids: readonly number[]): Promise<number | false> {
  if (!ids.length) return false;
  const rows = await fetchRecords(env, "mail.activity", ids, ["active"]);
  const activeIds = rows.filter((r) => r["active"]).map((r) => Number(r["id"]));
  let firstMsg: number | false = false;
  for (const id of activeIds) {
    const mid = await actionFeedback(env, [id], [], {});
    if (firstMsg === false && typeof mid === "number") firstMsg = mid;
  }
  return firstMsg;
}

/** Shared helper for mail.activity.action_create_calendar_event (calendar/models/mail_activity.py:35-59). */
async function activityCreateCalendarEvent(env: Environment, id: number): Promise<Record<string, unknown>> {
  const [a] = await fetchRecords(env, "mail.activity", [id], [
    "activity_type_id", "res_model", "res_id", "res_name", "note", "user_id", "date_deadline", "calendar_event_id",
  ]);
  const action = await forXmlId(env, "calendar.action_calendar_event");
  const defaultPartners: number[] = [];
  const uid = m2oId(a!["user_id"]);
  if (uid !== null) {
    const up = (await userInfoOf(env, uid)).partnerId;
    if (up && !defaultPartners.includes(up)) defaultPartners.push(up);
  }
  const resModel = typeof a!["res_model"] === "string" && a!["res_model"] ? a!["res_model"] : null;
  const resId = typeof a!["res_id"] === "number" && a!["res_id"] > 0 ? a!["res_id"] : null;
  if (resModel && resId && env.reg.models.has(resModel)) {
    if (await hasRecordReadAccess(env, resModel, resId)) {
      const cust = await mailGetCustomer(env, resModel, resId);
      if (cust !== null && !defaultPartners.includes(cust)) defaultPartners.push(cust);
    }
  }
  const note = a!["note"];
  action["context"] = {
    default_activity_type_id: m2oId(a!["activity_type_id"]) ?? false,
    default_res_id: env.context["default_res_id"] ?? null,
    default_res_model: env.context["default_res_model"] ?? null,
    default_name: a!["res_name"] || false,
    default_description: typeof note === "string" && !isHtmlEmpty(note) ? note : "",
    default_meeting_activity_ids: [[6, 0, [id]]],
    default_partner_ids: defaultPartners,
    default_user_id: uid ?? false,
    initial_date: a!["date_deadline"] || false,
    default_calendar_event_id: m2oId(a!["calendar_event_id"]) ?? false,
    orig_activity_ids: [id],
    return_to_parent_breadcrumb: true,
  };
  // crm/models/mail_activity.py:10-33: the activity's lead (its meeting's opportunity, else its document) adds the
  // lead's meeting context (`action_schedule_meeting(smart_calendar=False)`), the partners of both as a set
  if (env.reg.models.has("crm.lead")) {
    const eventId = m2oId(a!["calendar_event_id"]);
    let leadId: number | null = null;
    if (eventId !== null) {
      const opp = (await env.cr.query<{ o: number | null }>("SELECT opportunity_id AS o FROM calendar_event WHERE id = $1", [eventId])).rows[0]?.o;
      if (opp != null) leadId = opp;
    }
    if (leadId === null && resModel === "crm.lead" && resId !== null
      && (await env.cr.query("SELECT 1 FROM crm_lead WHERE id = $1", [resId])).rows.length) leadId = resId;
    if (leadId !== null) {
      const { scheduleMeetingContext } = await import("./crm_lead_actions");
      const leadCtx = await scheduleMeetingContext(env, leadId, false);
      if (eventId !== null) {
        leadCtx["initial_date"] = (await env.cr.query<{ s: string | null }>(
          "SELECT to_char(start, 'YYYY-MM-DD HH24:MI:SS') AS s FROM calendar_event WHERE id = $1", [eventId])).rows[0]?.s ?? false;
      }
      const ctx = action["context"] as Record<string, unknown>;
      const both = [...((ctx["default_partner_ids"] as number[]) ?? []), ...((leadCtx["default_partner_ids"] as number[]) ?? [])];
      leadCtx["default_partner_ids"] = PySet.fromList(both).order();
      Object.assign(ctx, leadCtx);
    }
  }
  return action;
}

// ----------------------------------------------------------------------------------------------------------------
// 1. Mail & Activities (`mail.*`)
// ----------------------------------------------------------------------------------------------------------------

// mail_activity.py:625-627
button("mail.activity", "action_done", async (env, ids) => doActivityDone(env, ids));

// mail_activity.py:804-811
button("mail.activity", "action_reschedule_today", async (env, ids) => {
  const rows = await fetchRecords(env, "mail.activity", ids, ["active"]);
  const active = rows.filter((r) => r["active"]).map((r) => Number(r["id"]));
  if (active.length) await writeActivityDeadline(env, active, await contextToday(env));
  return null;
});

button("mail.activity", "action_reschedule_tomorrow", async (env, ids) => {
  const rows = await fetchRecords(env, "mail.activity", ids, ["active"]);
  const active = rows.filter((r) => r["active"]).map((r) => Number(r["id"]));
  if (active.length) await writeActivityDeadline(env, active, shiftDateDays(await contextToday(env), 1));
  return null;
});

button("mail.activity", "action_reschedule_nextweek", async (env, ids) => {
  const rows = await fetchRecords(env, "mail.activity", ids, ["active"]);
  const active = rows.filter((r) => r["active"]).map((r) => Number(r["id"]));
  if (active.length) await writeActivityDeadline(env, active, nextWeekMonday(await contextToday(env)));
  return null;
});

// mail_activity.py:766-768
button("mail.activity", "action_close_dialog", async () => ({ type: "ir.actions.act_window_close" }), { readonly: true });

// calendar/models/mail_activity.py:35-59
button("mail.activity", "action_create_calendar_event", async (env, ids) => {
  const id = ensureOne(ids, "mail.activity");
  return activityCreateCalendarEvent(env, id);
});

// mail_activity.py:629-653
button("mail.activity", "action_done_redirect_to_other", async (env, ids) => {
  await doActivityDone(env, ids);
  const action = await forXmlId(env, "mail.mail_activity_without_access_action");
  const rawCtx = action["context"];
  let actionCtx: Record<string, unknown> = {};
  if (typeof rawCtx === "string" && rawCtx.trim() && rawCtx.trim() !== "{}") {
    actionCtx = JSON.parse(rawCtx.replace(/'/g, '"')) as Record<string, unknown>;
  } else if (typeof rawCtx === "object" && rawCtx !== null) {
    actionCtx = { ...(rawCtx as Record<string, unknown>) };
  }
  let activeIds: number[];
  if (env.context["active_model"] === "mail.activity") {
    activeIds = Array.isArray(env.context["active_ids"]) ? (env.context["active_ids"] as number[]) : [];
  } else {
    // Recompute active activities assigned to current user where user has no read access on underlying record (or personal)
    const rows = (await env.cr.query<{ id: number; res_model: string | null; res_id: number | null }>(
      `SELECT id, res_model, res_id FROM mail_activity WHERE active IS TRUE AND user_id = $1 ORDER BY id`, [env.uid])).rows;
    activeIds = [];
    for (const r of rows) {
      if (!r.res_model || !r.res_id) { activeIds.push(r.id); continue; }
      if (!env.reg.models.has(r.res_model) || !(await hasRecordReadAccess(env, r.res_model, r.res_id))) activeIds.push(r.id);
    }
  }
  action["context"] = { ...actionCtx, active_ids: activeIds, active_model: "mail.activity" };
  return action;
});

// mail_activity_schedule.py:428-429
button("mail.activity.schedule", "action_schedule_activities_done", async (env, ids) => {
  const actIds = await scheduleActivities(env, ids);
  await doActivityDone(env, actIds);
  return null;
});

// calendar/wizard/mail_activity_schedule.py:11-20
button("mail.activity.schedule", "action_create_calendar_event", async (env, ids) => {
  const id = ensureOne(ids, "mail.activity.schedule");
  const row = (await env.cr.query<{ res_model: string | null; res_ids: string | null }>(
    "SELECT res_model, res_ids FROM mail_activity_schedule WHERE id = $1", [id])).rows[0];
  if (!row) throw new MissingError(`Record does not exist or has been deleted.\n(Record: mail.activity.schedule(${id},), User: ${env.uid})`);
  const rids = parseResIds(row.res_ids);
  if (rids.length > 1) {
    throw new UserError(translate(env, "Scheduling an activity using the calendar is not possible on more than one record."));
  }
  if (!row.res_model) {
    const [actId] = await scheduleActivities(env, [id]);
    return activityCreateCalendarEvent(env, actId!);
  }
  const cenv = env.withContext({
    ...env.context,
    default_res_model: row.res_model || false,
    default_res_id: rids[0] ?? false,
  });
  const [actId] = await scheduleActivities(cenv, [id]);
  return activityCreateCalendarEvent(cenv, actId!);
});

// mail_activity_schedule.py:346-399
button("mail.activity.schedule", "action_schedule_plan", async (env, ids) => {
  const id = ensureOne(ids, "mail.activity.schedule");
  const w = (await env.cr.query<{
    res_model: string | null; res_ids: string | null; plan_id: number | null; plan_date: string | null;
    plan_on_demand_user_id: number | null; plan_on_demand_role_id: number | null; activity_user_id_fname: string | null;
    plan_name: string | null;
  }>(
    `SELECT w.res_model, w.res_ids, w.plan_id, w.plan_date::text AS plan_date,
            w.plan_on_demand_user_id, w.plan_on_demand_role_id, w.activity_user_id_fname, p.name AS plan_name
       FROM mail_activity_schedule w LEFT JOIN mail_activity_plan p ON p.id = w.plan_id WHERE w.id = $1`, [id])).rows[0];
  if (!w) throw new MissingError(`Record does not exist or has been deleted.\n(Record: mail.activity.schedule(${id},), User: ${env.uid})`);
  if (!w.res_model) {
    throw new OdooError("builtins.ValueError", translate(env, "Plan-based scheduling are available only on documents."));
  }
  const appliedIds = parseResIds(w.res_ids);
  if (!w.plan_id) throw new NotPorted("action_schedule_plan without plan_id");
  const lang = env.lang ?? "en_US";
  const templates = (await env.cr.query<{
    id: number; activity_type_id: number; plan_id: number; summary: string | null; note: string | null;
    delay_count: number; delay_unit: string; delay_from: string; responsible_type: string;
    responsible_id: number | null; role_id: number | null; type_name: string | null;
  }>(
    `SELECT t.id, t.activity_type_id, t.plan_id, COALESCE(t.summary->>$2, t.summary->>'en_US') AS summary,
            COALESCE(t.note->>$2, t.note->>'en_US') AS note, t.delay_count, t.delay_unit, t.delay_from,
            t.responsible_type, t.responsible_id, t.role_id,
            COALESCE(at.name->>$2, at.name->>'en_US') AS type_name
       FROM mail_activity_plan_template t JOIN mail_activity_type at ON at.id = t.activity_type_id
      WHERE t.plan_id = $1 ORDER BY t.sequence, t.id`, [w.plan_id, lang])).rows;

  const modelId = (await env.cr.query<{ id: number }>("SELECT id FROM ir_model WHERE model = $1", [w.res_model])).rows[0]!.id;
  const baseDate = w.plan_date || await contextToday(env);
  const langInfo = await getLang(env);
  const formatDateLocal = (iso: string): string => {
    const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
    return formatPosix(langInfo.dateFormat, wallClock(new Date(Date.UTC(y, m - 1, d, 12, 0, 0)), "UTC"), langInfo.code);
  };

  const activitiesValsList: Record<string, unknown>[] = [];
  for (const recId of appliedIds) {
    let body = escapeText(translate(env, 'The plan "%(plan_name)s" has been started').replace("%(plan_name)s", w.plan_name ?? ""));
    const descriptions: string[] = [];
    for (const tpl of templates) {
      let respId: number | null = null;
      let roleId: number | null = null;
      if (tpl.responsible_type === "other") {
        respId = tpl.responsible_id;
      } else if (tpl.responsible_type === "role") {
        roleId = tpl.role_id;
      } else if (tpl.responsible_type === "on_demand") {
        respId = w.plan_on_demand_user_id;
        roleId = w.plan_on_demand_role_id;
        if (!respId && !roleId && w.activity_user_id_fname) {
          const r = (await env.model(w.res_model).read([recId], [w.activity_user_id_fname], ""))[0];
          respId = m2oId(r?.[w.activity_user_id_fname]);
        }
      }
      const delta = tpl.delay_from === "after_plan_date" ? tpl.delay_count : -tpl.delay_count;
      const deadline = addDelay(baseDate, tpl.delay_unit, delta);
      activitiesValsList.push({
        activity_type_id: tpl.activity_type_id,
        activity_plan_id: tpl.plan_id,
        automated: false,
        date_deadline: deadline,
        summary: tpl.summary || false,
        note: tpl.note || false,
        user_id: respId ?? false,
        role_id: roleId ?? false,
        res_model_id: modelId,
        res_id: recId,
      });
      const respName = respId
        ? (await env.cr.query<{ name: string }>("SELECT p.name FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1", [respId])).rows[0]?.name ?? ""
        : "";
      const desc = translate(env, "%(activity)s, assigned to %(name)s, due on the %(deadline)s")
        .replace("%(activity)s", tpl.summary || tpl.type_name || "")
        .replace("%(name)s", respName)
        .replace("%(deadline)s", formatDateLocal(deadline));
      descriptions.push(desc);
    }
    if (descriptions.length) {
      body += `<ul>${descriptions.map((d) => `<li>${escapeText(d)}</li>`).join("")}</ul>`;
    }
    await callKw(env, w.res_model, "message_post", [[recId]], { body });
  }
  if (activitiesValsList.length) {
    await createActivities(env.withContext(cleanContext(env.context)), activitiesValsList, { inbox: true });
  }
  if (appliedIds.length === 1) {
    return { type: "ir.actions.client", tag: "soft_reload" };
  }
  return {
    type: "ir.actions.act_window",
    res_model: w.res_model,
    name: translate(env, "Launch Plans"),
    view_mode: "list,form",
    target: "current",
    domain: [["id", "in", appliedIds]],
  };
});

// project_todo/wizard/mail_activity_todo_create.py:10-38
registerDefaults("mail.activity.todo.create", {
  date_deadline: (env) => contextToday(env),
  user_id: async (env) => env.uid,
});

button("mail.activity.todo.create", "create_todo_activity", async (env, ids) => {
  const id = ensureOne(ids, "mail.activity.todo.create");
  const [w] = await fetchRecords(env, "mail.activity.todo.create", [id], ["summary", "note", "date_deadline", "user_id"]);
  const userId = m2oId(w!["user_id"]);
  const [todoId] = await create(env, "project.task", [{
    name: w!["summary"] || false,
    description: w!["note"] || false,
    date_deadline: w!["date_deadline"] || false,
    user_ids: userId ? [[6, 0, [userId]]] : [[6, 0, []]],
  }]);
  const modelId = (await env.cr.query<{ id: number }>("SELECT id FROM ir_model WHERE model = 'project.task'")).rows[0]!.id;
  const actType = (await env.cr.query<{ id: number }>(
    "SELECT id FROM mail_activity_type WHERE active IS TRUE AND (res_model = 'project.task' OR res_model IS NULL) ORDER BY sequence, id LIMIT 1")).rows[0]?.id;
  if (!actType) throw new NotPorted("create_todo_activity without default activity type for project.task");
  await createActivities(env, [{
    res_model_id: modelId,
    res_id: todoId!,
    summary: w!["summary"] || false,
    user_id: userId ?? false,
    date_deadline: w!["date_deadline"],
    activity_type_id: actType,
    note: false,
    role_id: false,
  }]);
  return {
    type: "ir.actions.client",
    tag: "display_notification",
    params: {
      type: "success",
      message: translate(env, "Your to-do has been successfully added to your pipeline."),
    },
  };
});

// mail/wizard/mail_followers_edit.py:29-80
button("mail.followers.edit", "edit_followers", async (env, ids) => {
  const wizards = await fetchRecords(env, "mail.followers.edit", ids, ["res_model", "res_ids", "operation", "partner_ids", "message", "notify"]);
  let lastOp = "add";
  for (const w of wizards) {
    lastOp = String(w["operation"] || "add");
    const resModel = String(w["res_model"] || "");
    const resIds = parseResIds(w["res_ids"]);
    if (!resIds.length) throw new UserError(translate(env, "No documents found for the selected records."));
    const partnerIds = Array.isArray(w["partner_ids"]) ? (w["partner_ids"] as number[]) : [];
    const generic = isGenericThread(resModel);
    if (resModel !== "res.partner" && !generic) throw new NotPorted(`mail.followers.edit on ${resModel}`);
    if (lastOp === "remove") {
      if (partnerIds.length) {
        const selfPartner = (await userInfo(env)).partnerId;
        const onlySelf = new Set(partnerIds).size === 1 && partnerIds[0] === selfPartner;
        if (!onlySelf) {
          for (const rid of resIds) {
            const ok = resModel === "res.partner" ? await permission(env, rid, "write") : await permissionOn(env, resModel, rid, "write");
            if (!ok) await env.model(resModel).checkAccess([rid], "write");
          }
        }
        await deleteFollowers(env, resModel, resIds, partnerIds);
      }
    } else {
      const userEmail = (await env.cr.query<{ email: string | null }>(
        "SELECT p.email FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1", [env.uid])).rows[0]?.email;
      if (!userEmail) {
        throw new UserError(translate(env, "Unable to post message, please configure the sender's email address."));
      }
      await messageSubscribeApi(env, resModel, resIds, partnerIds, null);
      if (w["notify"] && partnerIds.length) {
        const ctx = requestOfCursor(env.cr);
        if (!ctx) throw new NotPorted("mail.followers.edit notify outside a request");
        const modelName = (await env.cr.query<{ name: string }>(
          "SELECT COALESCE(name->>$2, name->>'en_US', model) AS name FROM ir_model WHERE model = $1", [resModel, env.lang ?? "en_US"])).rows[0]?.name ?? resModel;
        const dnames = await env.model(resModel).displayName(resIds);
        const docBody = resIds.length > 1
          ? `${resIds.map((rid) => dnames.get(rid) ?? "").join(", ")}\n${String(w["message"] || "")}`
          : String(w["message"] || "");
        const subject = resIds.length > 1
          ? translate(env, "You’ve been added as a follower of %(count)s %(document_model)s.")
            .replace("%(count)s", String(resIds.length)).replace("%(document_model)s", modelName)
          : translate(env, "You’ve been added as a follower of %(document_name)s")
            .replace("%(document_name)s", dnames.get(resIds[0]!) ?? "");
        const selfPartner = (await userInfo(env)).partnerId;
        const emailFrom = await partnerEmailFormatted(env, selfPartner);
        const [authorId] = await computeAuthor(env, selfPartner, emailFrom || null);
        const layoutXmlid = resIds.length > 1 ? "mail.mail_notification_multi_invite" : "mail.mail_notification_invite";
        const [mid] = await insertMessages(env, [{
          model: resModel, res_id: resIds[0]!, body: docBody, author_id: authorId, email_from: emailFrom,
          message_type: "user_notification", subtype_id: await xmlid(env, "mail.mt_note"), is_internal: true,
          subject, reply_to: emailFrom, reply_to_force_new: true, message_id: trackingMessageId("message-notify"),
          email_add_signature: false, record_alias_domain_id: false, record_company_id: await env.company(),
          email_layout_xmlid: layoutXmlid, partner_ids: partnerIds,
        }]);
        const notified = await notifyThread(ctx, env, resModel, resIds[0]!, mid!, { modelDescription: modelName });
        await notified.send();
      }
    }
  }
  return {
    type: "ir.actions.client",
    tag: "display_notification",
    params: {
      type: "success",
      message: lastOp === "add" ? translate(env, "Followers added") : translate(env, "Followers removed"),
      sticky: false,
      next: { type: "ir.actions.act_window_close" },
    },
  };
});

// mail_alias.py:411-429
button("mail.alias", "open_document", async (env, ids) => {
  const id = ensureOne(ids, "mail.alias");
  const [r] = await fetchRecords(env, "mail.alias", [id], ["alias_model_id", "alias_force_thread_id"]);
  const modelId = m2oId(r!["alias_model_id"]);
  const threadId = typeof r!["alias_force_thread_id"] === "number" ? r!["alias_force_thread_id"] : 0;
  if (!modelId || !threadId) return false;
  const model = (await env.cr.query<{ model: string }>("SELECT model FROM ir_model WHERE id = $1", [modelId])).rows[0]?.model;
  if (!model) return false;
  return { view_mode: "form", res_model: model, res_id: threadId, type: "ir.actions.act_window" };
});

button("mail.alias", "open_parent_document", async (env, ids) => {
  const id = ensureOne(ids, "mail.alias");
  const [r] = await fetchRecords(env, "mail.alias", [id], ["alias_parent_model_id", "alias_parent_thread_id"]);
  const modelId = m2oId(r!["alias_parent_model_id"]);
  const threadId = typeof r!["alias_parent_thread_id"] === "number" ? r!["alias_parent_thread_id"] : 0;
  if (!modelId || !threadId) return false;
  const model = (await env.cr.query<{ model: string }>("SELECT model FROM ir_model WHERE id = $1", [modelId])).rows[0]?.model;
  if (!model) return false;
  return { view_mode: "form", res_model: model, res_id: threadId, type: "ir.actions.act_window" };
});

// mail_blacklist.py:24-68 create/write/_search + 70-113 actions & mail_blacklist_remove.py:14-22
function normalizeBlacklistDomain(d: Domain): Domain {
  if (d.kind === "cond") {
    if (d.path === "email" && typeof d.value === "string") {
      const norm = emailNormalize(d.value);
      if (norm) return { ...d, value: norm };
    }
    return d;
  }
  if (d.kind === "not") return { kind: "not", arg: normalizeBlacklistDomain(d.arg) };
  if (d.kind === "and" || d.kind === "or") return { kind: d.kind, args: d.args.map(normalizeBlacklistDomain) };
  return d;
}

registerMethod("mail.blacklist", "search", async (env0, _ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const rawDomain = "domain" in kwargs ? kwargs["domain"] : args[0];
  const offset = intArg("offset" in kwargs ? kwargs["offset"] : args[1], "offset", 0);
  const limit = optInt("limit" in kwargs ? kwargs["limit"] : args[2], "limit");
  const order = optStr("order" in kwargs ? kwargs["order"] : args[3], "order");
  return env.model("mail.blacklist").search(normalizeBlacklistDomain(parseDomain(rawDomain ?? [])), { offset, limit, order });
}, { apiModel: true, readonly: true });

registerOverrides("mail.blacklist", {
  create: async (env, valsList, next) => {
    const newValues: Record<string, unknown>[] = [];
    const allEmails: string[] = [];
    for (const v of valsList) {
      const norm = emailNormalize(typeof v["email"] === "string" ? v["email"] : null);
      if (!norm) throw new UserError(translate(env, "Invalid email address “%s”").replace("%s", String(v["email"])));
      if (allEmails.includes(norm)) continue;
      allEmails.push(norm);
      newValues.push({ ...v, email: norm });
    }
    if (!newValues.length) return [];
    const existingRows = (await env.cr.query<{ email: string; id: number }>(
      "SELECT email, id FROM mail_blacklist WHERE email = ANY($1::text[])", [allEmails])).rows;
    const existingByEmail = new Map(existingRows.map((r) => [r.email, r.id]));
    const toCreate = newValues.filter((v) => !existingByEmail.has(String(v["email"])));
    const created = toCreate.length ? await next(env, toCreate) : [];
    return [...existingByEmail.values(), ...created];
  },
  write: async (env, ids, vals, next) => {
    const out = { ...vals };
    if ("email" in out) out["email"] = emailNormalize(typeof out["email"] === "string" ? out["email"] : null) || false;
    return next(env, ids, out);
  },
});

async function mailBlacklistAdd(env: Environment, email: string, message: string | null = null): Promise<number[]> {
  const normalized = emailNormalize(email);
  const existing = await env.withContext({ ...env.context, active_test: false }).model("mail.blacklist")
    .search(cond("email", "=", normalized || false), { activeTest: false });
  if (existing.length) {
    if (message) setTrackLogMessage(env.cr, "mail.blacklist", existing, message);
    await write(env, "mail.blacklist", existing, { active: true });
    return existing;
  }
  if (!normalized) throw new UserError(translate(env, "Invalid email address “%s”").replace("%s", String(email)));
  const [created] = await create(env, "mail.blacklist", [{ email: normalized }]);
  if (message) {
    const [authorId, emailFrom] = await computeAuthor(env, (await userInfo(env)).partnerId, null);
    await insertMessages(env, [{
      model: "mail.blacklist", res_id: created!, body: message, author_id: authorId, email_from: emailFrom,
      message_type: "notification", subtype_id: await xmlid(env, "mail.mt_note"), is_internal: true,
      subject: false, reply_to: await replyToDefault(env, emailFrom), message_id: trackingMessageId(`${created}-mail.blacklist`),
      email_add_signature: true, record_alias_domain_id: false, record_company_id: await env.company(),
    }]);
  }
  return [created!];
}

async function mailBlacklistRemove(env: Environment, email: string, message: string | null = null): Promise<number[]> {
  const normalized = emailNormalize(email);
  const existing = await env.withContext({ ...env.context, active_test: false }).model("mail.blacklist")
    .search(cond("email", "=", normalized || false), { activeTest: false });
  if (existing.length) {
    if (message) setTrackLogMessage(env.cr, "mail.blacklist", existing, message);
    await write(env, "mail.blacklist", existing, { active: false });
    return existing;
  }
  if (!normalized) throw new UserError(translate(env, "Invalid email address “%s”").replace("%s", String(email)));
  const [created] = await create(env, "mail.blacklist", [{ email: normalized, active: false }]);
  if (message) {
    const [authorId, emailFrom] = await computeAuthor(env, (await userInfo(env)).partnerId, null);
    await insertMessages(env, [{
      model: "mail.blacklist", res_id: created!, body: message, author_id: authorId, email_from: emailFrom,
      message_type: "notification", subtype_id: await xmlid(env, "mail.mt_note"), is_internal: true,
      subject: false, reply_to: await replyToDefault(env, emailFrom), message_id: trackingMessageId(`${created}-mail.blacklist`),
      email_add_signature: true, record_alias_domain_id: false, record_company_id: await env.company(),
    }]);
  }
  return [created!];
}

button("mail.blacklist", "action_add", async (env, ids) => {
  const id = ensureOne(ids, "mail.blacklist");
  const [r] = await fetchRecords(env, "mail.blacklist", [id], ["email"]);
  await mailBlacklistAdd(env, String(r!["email"] || ""));
  return null;
});

button("mail.blacklist", "mail_action_blacklist_remove", async (env) => ({
  name: translate(env, "Are you sure you want to unblacklist this email address?"),
  type: "ir.actions.act_window",
  view_mode: "form",
  res_model: "mail.blacklist.remove",
  target: "new",
  context: { dialog_size: "medium" },
}));

button("mail.blacklist.remove", "action_unblacklist_apply", async (env, ids) => {
  const id = ensureOne(ids, "mail.blacklist.remove");
  const [r] = await fetchRecords(env, "mail.blacklist.remove", [id], ["email", "reason"]);
  const reason = typeof r!["reason"] === "string" && r!["reason"] ? r!["reason"] : null;
  const message = reason
    ? `<p>${escapeText(translate(env, "Unblock Reason: %(reason)s").replace("%(reason)s", reason))}</p>`
    : null;
  return mailBlacklistRemove(env, String(r!["email"] || ""), message);
});

// mail_compose_message.py:19-30 `_reopen`
function reopenComposer(env: Environment, resId: number, model: string, extraCtx: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: translate(env, "Compose Email"),
    type: "ir.actions.act_window",
    view_mode: "form",
    res_id: resId,
    res_model: "mail.compose.message",
    target: "new",
    context: { ...env.context, ...extraCtx, default_model: model },
  };
}

// mail_compose_message.py:1010-1037
button("mail.compose.message", "create_mail_template", async (env, ids) => {
  const id = ensureOne(ids, "mail.compose.message");
  const w = (await env.cr.query<{ model: string | null; template_name: string | null; body: string | null }>(
    "SELECT model, template_name, body FROM mail_compose_message WHERE id = $1", [id])).rows[0];
  if (!w) throw new MissingError(`Record does not exist or has been deleted.\n(Record: mail.compose.message(${id},), User: ${env.uid})`);
  if (!w.model || !env.reg.models.has(w.model)) {
    throw new UserError(translate(env, "Template creation from composer requires a valid model."));
  }
  const modelId = (await env.cr.query<{ id: number }>("SELECT id FROM ir_model WHERE model = $1", [w.model])).rows[0]!.id;
  let templateBody: string | false = w.body || false;
  if (templateBody && templateBody.includes("o_mail_reply_container")) {
    throw new NotPorted("create_mail_template stripping o_mail_reply_container xpath");
  }
  const [tplId] = await create(env, "mail.template", [{
    name: w.template_name || false,
    body_html: templateBody,
    model_id: modelId,
    use_default_to: true,
    user_id: env.uid,
  }]);
  const wizAtts = (await env.cr.query<{ id: number; res_model: string | null; create_uid: number | null }>(
    `SELECT a.id, a.res_model, a.create_uid FROM mail_compose_message_ir_attachments_rel r
       JOIN ir_attachment a ON a.id = r.attachment_id WHERE r.wizard_id = $1 ORDER BY a.id`, [id])).rows;
  if (wizAtts.length) {
    const owned = wizAtts.filter((a) => a.res_model === "mail.compose.message" && a.create_uid === env.uid).map((a) => a.id);
    if (owned.length) {
      await write(env.sudo(), "ir.attachment", owned, { res_model: "mail.template", res_id: tplId });
      await write(env, "mail.template", [tplId!], { attachment_ids: [[6, 0, wizAtts.map((a) => a.id)]] });
    }
  }
  await env.cr.query(
    "UPDATE mail_compose_message SET template_id = $2, body = $3, write_uid = $4, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1",
    [id, tplId, w.body, env.uid]);
  return reopenComposer(env, id, w.model, { dialog_size: "large" });
});

// mail_compose_message.py:789-833
button("mail.compose.message", "action_schedule_message", async (env, ids) => {
  const wizards = (await env.cr.query<Record<string, unknown>>(
    "SELECT * FROM mail_compose_message WHERE id = ANY($1::int[]) ORDER BY array_position($1::int[], id)", [ids])).rows;
  for (const w of wizards) {
    const rids = parseResIds(w["res_ids"]);
    const isBatch = Boolean(w["res_domain"]) || rids.length > 1;
    if (w["composition_mode"] !== "comment" || isBatch) {
      throw new UserError(translate(env, "A message can only be scheduled in monocomment mode"));
    }
  }
  const nowStr = datetimeToString(await dbNow(env)).slice(0, 19);
  const scheduledDates = new Set<string>();
  const noteSubtype = await xmlid(env, "mail.mt_note");
  const commentSubtype = await xmlid(env, "mail.mt_comment");
  const cenv = env.withContext(cleanContext(env.context));
  for (const w of wizards) {
    const wid = Number(w["id"]);
    const model = String(w["model"] || "");
    const rids = parseResIds(w["res_ids"]);
    if (!rids.length) continue;
    const resId = rids[0]!;
    const schedRaw = w["scheduled_date"];
    if (!schedRaw || typeof schedRaw !== "string" || !schedRaw.trim()) {
      throw new UserError(translate(env, "A scheduled date is needed to schedule a message"));
    }
    const scheduledDate = schedRaw.trim().replace("T", " ").slice(0, 19);
    if (!env.reg.models.get(model)?.isMailThread) {
      throw new ValidationError(translate(env, "A message cannot be scheduled on a model that does not have a mail thread."));
    }
    if (scheduledDate < nowStr) {
      throw new ValidationError(translate(env, "A Scheduled Message cannot be scheduled in the past"));
    }
    const partnerIds = (await env.cr.query<{ partner_id: number }>(
      "SELECT partner_id FROM mail_compose_message_res_partner_rel WHERE wizard_id = $1 ORDER BY partner_id", [wid])).rows.map((r) => r.partner_id);
    const partnerCcIds = (await env.cr.query<{ partner_id: number }>(
      "SELECT partner_id FROM mail_compose_message_res_partner_cc_rel WHERE wizard_id = $1 ORDER BY partner_id", [wid])).rows.map((r) => r.partner_id);
    const attIds = (await env.cr.query<{ attachment_id: number }>(
      "SELECT attachment_id FROM mail_compose_message_ir_attachments_rel WHERE wizard_id = $1 ORDER BY attachment_id", [wid])).rows.map((r) => r.attachment_id);
    const authorId = m2oId(w["author_id"]) ?? (await userInfo(env)).partnerId;
    const isNote = m2oId(w["subtype_id"]) === noteSubtype;
    const notifParams: Record<string, unknown> = {
      mail_activity_type_id: m2oId(w["mail_activity_type_id"]) ?? false,
      mail_server_id: m2oId(w["mail_server_id"]) ?? false,
      message_type: w["message_type"] || "comment",
      parent_id: m2oId(w["parent_id"]) ?? false,
      reply_to_force_new: Boolean(w["reply_to_force_new"]),
      subtype_id: m2oId(w["subtype_id"]) ?? commentSubtype,
      email_add_signature: Boolean(w["email_add_signature"]),
      email_layout_xmlid: w["email_layout_xmlid"] || false,
      force_footer: false,
      force_header: false,
      force_send: w["force_send"] !== false,
      mail_auto_delete: Boolean(w["auto_delete"]),
      model_description: env.context["model_description"] ?? null,
      record_alias_domain_id: m2oId(w["record_alias_domain_id"]) ?? false,
      record_company_id: m2oId(w["record_company_id"]) ?? await env.company(),
      email_from: w["email_from"] || false,
      force_email_lang: w["lang"] || false,
      ...(w["reply_to"] ? { reply_to: w["reply_to"] } : {}),
    };
    const [smId] = await create(cenv, "mail.scheduled.message", [{
      attachment_ids: attIds.length ? [[6, 0, attIds]] : [],
      author_id: authorId,
      body: w["body"] || "",
      composition_comment_option: w["composition_comment_option"] || false,
      is_note: isNote,
      model,
      partner_cc_ids: partnerCcIds.length ? [[6, 0, partnerCcIds]] : [],
      partner_ids: partnerIds.length ? [[6, 0, partnerIds]] : [],
      res_id: resId,
      scheduled_date: scheduledDate,
      send_context: cleanContext(env.context),
      ...(env.reg.model("mail.scheduled.message").fields.has("send_method") ? { send_method: "email" } : {}),
      subject: w["subject"] || false,
      notification_parameters: pyJsonDumps(notifParams),
    }]);
    if (attIds.length) {
      await env.cr.query(
        `UPDATE ir_attachment SET res_model = 'mail.scheduled.message', res_id = $2, write_uid = $3, write_date = now() AT TIME ZONE 'UTC'
          WHERE id = ANY($1::int[]) AND res_model = 'mail.compose.message' AND create_uid = $3`,
        [attIds, smId, env.uid]);
    }
    scheduledDates.add(scheduledDate);
  }
  if (scheduledDates.size) {
    const cronId = await env.reg.xmlid(env.cr, "mail.ir_cron_post_scheduled_message");
    if (cronId) {
      for (const callAt of scheduledDates) {
        await create(env.sudo(), "ir.cron.trigger", [{ cron_id: cronId, call_at: callAt }]);
      }
    }
  }
  return { type: "ir.actions.act_window_close" };
});

// mail_compose_message.py:835-845 + mail_thread.py:5168-5273 `_message_update_content`
button("mail.compose.message", "action_update_message", async (env, ids) => {
  const id = ensureOne(ids, "mail.compose.message");
  const msgId = Number(env.context["default_message_id"]);
  if (!Number.isInteger(msgId) || msgId <= 0) throw new OdooError("builtins.KeyError", "'default_message_id'");
  const msg = (await env.cr.query<{ id: number; model: string | null; res_id: number | null; message_type: string | null; email_add_signature: boolean | null }>(
    "SELECT id, model, res_id, message_type, email_add_signature FROM mail_message WHERE id = $1", [msgId])).rows[0];
  if (!msg) throw new MissingError(`Record does not exist or has been deleted.\n(Record: mail.message(${msgId},), User: ${env.uid})`);
  if (msg.message_type === "tracking") throw new UserError(translate(env, "Messages with tracking values cannot be modified"));
  if (msg.message_type !== "comment") throw new UserError(translate(env, "Only messages type comment can have their content updated"));
  const w = (await env.cr.query<{ body: string | null }>("SELECT body FROM mail_compose_message WHERE id = $1", [id])).rows[0];
  const partnerIds = (await env.cr.query<{ partner_id: number }>(
    "SELECT partner_id FROM mail_compose_message_res_partner_rel WHERE wizard_id = $1 ORDER BY partner_id", [id])).rows.map((r) => r.partner_id);
  const attIds = (await env.cr.query<{ attachment_id: number }>(
    "SELECT attachment_id FROM mail_compose_message_ir_attachments_rel WHERE wizard_id = $1 ORDER BY attachment_id", [id])).rows.map((r) => r.attachment_id);
  if (attIds.length) throw new NotPorted("action_update_message with attachments");
  const rawBody = w?.body ?? "";
  let markedBody = rawBody;
  if (rawBody && !isHtmlEmpty(rawBody) && !rawBody.includes("data-o-mail-full-composer")) {
    markedBody = `<span data-o-mail-full-composer="1"></span>${rawBody}`;
  }
  const nowStr = datetimeToString(await dbNow(env)).slice(0, 19);
  const editedSpan = `<span class="o-mail-Message-edited" data-o-datetime="${nowStr}"></span>`;
  let finalBody: string;
  if (markedBody) {
    const m = /(<\/(?:p|div)>\s*)$/i.exec(markedBody);
    finalBody = m ? `${markedBody.slice(0, m.index)} ${editedSpan}${m[1]}` : `${markedBody}${editedSpan}`;
  } else {
    finalBody = "";
  }
  await write(env, "mail.message", [msgId], {
    body: finalBody,
    partner_ids: [[6, 0, partnerIds]],
  });
  // discard translations
  await env.cr.query("DELETE FROM mail_message_translation WHERE message_id = $1", [msgId]);
  const ctx = requestOfCursor(env.cr);
  if (ctx) {
    const store = new Store();
    store.add("mail.message", msgId, { body: finalBody });
    await busSend(ctx, env, { model: "res.users", id: env.uid }, "mail.record/insert", await store.asDict(env.cr));
  }
  return { type: "ir.actions.act_window_close" };
});

// mail_message.py:487-705 `_search_res_access` for create / write / unlink (read is in mail_activity_access.ts)
async function searchMessageResAccessOp(env: Environment, op: "create" | "write" | "unlink", operator: string): Promise<Domain> {
  if (!env.su) throw new Error("_search_res_access runs as superuser");
  if (operator !== "in") throw new NotPorted(`mail.message.res_access_${op} with operator ${operator}`);
  const def = env.reg.model("mail.message");
  const domain = searchDomainOf(env) ?? TRUE;
  const user = env.withUser(env.uid).withContext(env.context);
  if (!(await hasModelAccess(user, "mail.message", op))) return cond("id", "in", []);
  const internal = (await env.cr.query("SELECT 1 FROM res_users WHERE id = $1 AND share IS NOT TRUE", [env.uid])).rows.length > 0;
  if (!internal) throw new NotPorted(`mail.message ${op} access of a share user`);
  const sudo = env.withContext({ ...env.context, active_test: false });
  const ids = await queryIds(await searchQuery(sudo, def, domain, { activeTest: false, order: "id", limit: 10000 }));
  if (!ids.length) return cond("id", "in", []);
  const partner = (await env.cr.query<{ p: number }>("SELECT partner_id AS p FROM res_users WHERE id = $1", [env.uid])).rows[0]!.p;
  const rows = (await env.cr.query<{ id: number; model: string | null; res_id: number | null; author_id: number | null; message_type: string; notified: boolean }>(
    `SELECT m.id, m.model, m.res_id, m.author_id, m.message_type,
            EXISTS (SELECT 1 FROM mail_message_res_partner_rel r WHERE r.mail_message_id = m.id AND r.res_partner_id = $2)
         OR EXISTS (SELECT 1 FROM mail_message_res_partner_cc_rel r WHERE r.mail_message_id = m.id AND r.res_partner_id = $2)
         OR EXISTS (SELECT 1 FROM mail_notification n WHERE n.mail_message_id = m.id AND n.res_partner_id = $2) AS notified
       FROM mail_message m WHERE m.id = ANY($1::int[])`, [ids, partner])).rows;
  const ok = new Set<number>();
  for (const r of rows) {
    if (op === "write" && (r.author_id === partner || r.notified)) { ok.add(r.id); continue; }
    if (op === "create" && (!r.model || !r.res_id || r.message_type === "user_notification")) { ok.add(r.id); continue; }
    if (r.model && r.res_id && r.message_type !== "user_notification" && env.reg.models.has(r.model)) {
      const docOp = op === "create" && ["res.partner", "res.users", "crm.team", "sale.order", "discuss.channel", "account.move", "purchase.order", "project.task"].includes(r.model) ? "read" : "write";
      try {
        await user.model(r.model).checkAccess([r.res_id], docOp);
        ok.add(r.id);
      } catch (e) {
        if (!(e instanceof AccessError)) throw e;
      }
    }
  }
  return cond("id", "in", ids.filter((id) => ok.has(id)));
}

registerHooks("mail.message", {
  search: {
    res_access_create: (env, operator) => searchMessageResAccessOp(env, "create", operator),
    res_access_write: (env, operator) => searchMessageResAccessOp(env, "write", operator),
    res_access_unlink: (env, operator) => searchMessageResAccessOp(env, "unlink", operator),
  },
});

// mail_scheduled_message.py:121-135 `_search_res_access`
registerHooks("mail.scheduled.message", {
  search: {
    res_access: async (env, operator) => {
      if (!env.su) throw new Error("_search_res_access runs as superuser");
      if (operator !== "in") throw new NotPorted(`mail.scheduled.message.res_access with operator ${operator}`);
      const def = env.reg.model("mail.scheduled.message");
      const domain = searchDomainOf(env) ?? TRUE;
      const user = env.withUser(env.uid).withContext(env.context);
      if (!(await hasModelAccess(user, "mail.scheduled.message", "read"))) return cond("id", "in", []);
      const sudo = env.withContext({ ...env.context, active_test: false });
      const ids = await queryIds(await searchQuery(sudo, def, domain, { activeTest: false, order: "id", limit: 10000 }));
      if (!ids.length) return cond("id", "in", []);
      const rows = (await env.cr.query<{ id: number; model: string | null; res_id: number | null }>(
        "SELECT id, model, res_id FROM mail_scheduled_message WHERE id = ANY($1::int[])", [ids])).rows;
      const ok = new Set<number>();
      for (const r of rows) {
        if (r.model && r.res_id && env.reg.models.has(r.model)) {
          try {
            await user.model(r.model).checkAccess([r.res_id], "write");
            ok.add(r.id);
          } catch (e) {
            if (!(e instanceof AccessError)) throw e;
          }
        }
      }
      return cond("id", "in", ids.filter((id) => ok.has(id)));
    },
  },
});

// mail_mail.py:208-223, 813-823
button("mail.mail", "mark_outgoing", async (env, ids) => {
  await write(env, "mail.mail", ids, { state: "outgoing" });
  return true;
});

button("mail.mail", "action_retry", async (env, ids) => {
  const rows = await fetchRecords(env, "mail.mail", ids, ["state"]);
  const failed = rows.filter((r) => r["state"] === "exception").map((r) => Number(r["id"]));
  if (failed.length) await write(env, "mail.mail", failed, { state: "outgoing" });
  return null;
});

button("mail.mail", "action_send_and_close", async (env, ids) => {
  const ctx = requestOfCursor(env.cr);
  if (!ctx) throw new NotPorted("mail.mail.action_send_and_close outside a request");
  await fetchRecords(env, "mail.mail", ids, ["id"]);
  if (ids.length) await sendMails(env, ctx.env, ids);
  return {
    name: translate(env, "Emails"),
    res_model: "mail.mail",
    view_mode: "list",
    views: [[false, "list"], [false, "form"]],
    target: "main",
    type: "ir.actions.act_window",
  };
});

// mail_template.py:299-332
button("mail.template", "action_open_mail_preview", async (env, ids) => {
  const id = ensureOne(ids, "mail.template");
  const [tpl] = await fetchRecords(env, "mail.template", [id], ["name"]);
  const action = await forXmlId(env, "mail.mail_template_preview_action");
  action["name"] = translate(env, 'Template Preview: "%(template_name)s"').replace("%(template_name)s", String(tpl!["name"] || ""));
  return action;
});

button("mail.template", "create_action", async (env, ids) => {
  const viewId = await xmlid(env, "mail.email_compose_message_wizard_form");
  const rows = await fetchRecords(env, "mail.template", ids, ["name", "model", "model_id"]);
  for (const r of rows) {
    const tid = Number(r["id"]);
    const model = typeof r["model"] === "string" ? r["model"] : false;
    const modelId = m2oId(r["model_id"]) ?? false;
    const ctxStr = pyRepr({
      default_composition_mode: "mass_mail",
      default_model: model,
      default_template_id: tid,
    });
    const buttonName = translate(env, "Send Mail (%s)").replace("%s", String(r["name"] || ""));
    const [actId] = await create(env, "ir.actions.act_window", [{
      name: buttonName,
      type: "ir.actions.act_window",
      res_model: "mail.compose.message",
      context: ctxStr,
      view_mode: "form,list",
      view_id: viewId,
      target: "new",
      binding_model_id: modelId,
    }]);
    await write(env, "mail.template", [tid], { ref_ir_act_window: actId });
  }
  return true;
});

button("mail.template", "unlink_action", async (env, ids) => {
  const rows = await fetchRecords(env, "mail.template", ids, ["ref_ir_act_window"]);
  for (const r of rows) {
    const actId = m2oId(r["ref_ir_act_window"]);
    if (actId !== null) await unlink(env, "ir.actions.act_window", [actId]);
  }
  return true;
});

// mail_template_reset.py:13-29 + template_reset_mixin.py:70-97
button("mail.template.reset", "reset_template", async (env, ids) => {
  const id = ensureOne(ids, "mail.template.reset");
  const [w] = await fetchRecords(env, "mail.template.reset", [id], ["template_ids"]);
  const tplIds = Array.isArray(w!["template_ids"]) ? (w!["template_ids"] as number[]) : [];
  if (!tplIds.length) return false;
  const fsRows = (await env.cr.query<{ id: number; template_fs: string | null }>(
    "SELECT id, template_fs FROM mail_template WHERE id = ANY($1::int[]) AND template_fs IS NOT NULL AND template_fs != ''", [tplIds])).rows;
  if (fsRows.length) {
    throw new NotPorted("mail.template.reset_template from filesystem XML/PO source files (template_fs)");
  }
  const params = env.context["params"];
  const viewType = typeof params === "object" && params !== null ? (params as Record<string, unknown>)["view_type"] : null;
  const nextAction = viewType === "list"
    ? { type: "ir.actions.client", tag: "reload" }
    : { type: "ir.actions.act_window_close" };
  return {
    type: "ir.actions.client",
    tag: "display_notification",
    params: {
      type: "success",
      message: translate(env, "The email template(s) have been restored to their original settings."),
      next: nextAction,
    },
  };
});

// ----------------------------------------------------------------------------------------------------------------
// 2. Calendar (`calendar.*`)
// ----------------------------------------------------------------------------------------------------------------

// calendar_event.py:1489-1494 (frontend-intercepted dummy buttons)
button("calendar.event", "set_discuss_videocall_location", async () => true);
button("calendar.event", "clear_videocall_location", async () => true);

// calendar_event.py:1533-1538
button("calendar.event", "action_join_video_call", async (env, ids) => {
  const id = ensureOne(ids, "calendar.event");
  const [ev] = await fetchRecords(env, "calendar.event", [id], ["videocall_location"]);
  return { type: "ir.actions.act_url", url: ev!["videocall_location"] || false, target: "new" };
});

// calendar_event.py:1501-1506
button("calendar.event", "action_sendmail", async (env, ids) => {
  const userEmail = (await env.cr.query<{ email: string | null }>(
    "SELECT p.email FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1", [env.uid])).rows[0]?.email;
  if (userEmail && ids.length) {
    const attendees: Attendee[] = (await env.cr.query<{ id: number; partner_id: number; email: string | null; event_id: number }>(
      `SELECT a.id, a.partner_id, p.email, a.event_id FROM calendar_attendee a JOIN res_partner p ON p.id = a.partner_id
        WHERE a.event_id = ANY($1::int[]) ORDER BY a.create_date ASC, a.id ASC`, [ids])).rows
      .map((r) => ({ id: r.id, partner: r.partner_id, email: r.email, event: r.event_id }));
    await notifyAttendees(env, attendees, "calendar.calendar_template_meeting_invitation", false);
  }
  return true;
});

// calendar_event_archive_or_unlink_wizard.py:1-112
registerRecordCompute("calendar.event.archive.or.unlink.wizard", {
  recipient_ids: async (env, rec) => {
    const evId = m2oId(await rec.get("calendar_event_id"));
    if (evId === null) return [];
    const ev = (await env.cr.query<{ partner_id: number | null }>("SELECT u.partner_id FROM calendar_event e LEFT JOIN res_users u ON u.id = e.user_id WHERE e.id = $1", [evId])).rows[0];
    const attPids = (await env.cr.query<{ partner_id: number }>(
      "SELECT partner_id FROM calendar_attendee WHERE event_id = $1 ORDER BY create_date ASC, id ASC", [evId])).rows.map((r) => r.partner_id);
    const out: number[] = [];
    if (ev?.partner_id) out.push(ev.partner_id);
    for (const p of attPids) if (!out.includes(p)) out.push(p);
    return out;
  },
  template_id: async (env) => (await env.reg.xmlid(env.cr, "calendar.calendar_template_delete_event")) ?? false,
  lang: async (env, rec) => {
    const tplId = m2oId(await rec.get("template_id"));
    if (tplId === null) return false;
    const row = (await env.cr.query<{ lang: string | null }>("SELECT lang FROM mail_template WHERE id = $1", [tplId])).rows[0];
    return row?.lang || (await rec.prev("lang")) || false;
  },
  subject: async (env, rec) => {
    const tplId = m2oId(await rec.get("template_id"));
    const evId = m2oId(await rec.get("calendar_event_id"));
    if (tplId === null || evId === null) return rec.prev("subject");
    return renderTemplateField(env, tplId, "subject", evId, null, true);
  },
  body: async (env, rec) => {
    const tplId = m2oId(await rec.get("template_id"));
    const evId = m2oId(await rec.get("calendar_event_id"));
    if (tplId === null || evId === null) return rec.prev("body");
    const rendered = await renderTemplateField(env, tplId, "body_html", evId, null, true);
    return htmlSanitize(String(rendered), {
      sanitizeTags: false, sanitizeAttributes: false, sanitizeStyle: false, sanitizeForm: true,
      stripStyle: false, stripClasses: false, xmlOutput: EMAIL_OUTGOING_XML,
    });
  },
});

defineComputes("calendar.event.multi.archive.or.unlink.wizard", {
  has_recurrent_events: async (env, rec) => {
    const evs = (await rec.rels("calendar_event_ids")).map((r) => r.origin).filter((x): x is number => x !== null);
    if (!evs.length) return false;
    return (await env.cr.query("SELECT 1 FROM calendar_event WHERE id = ANY($1::int[]) AND recurrence_id IS NOT NULL LIMIT 1", [evs])).rows.length > 0;
  },
});

async function archiveWizardEventIds(env: Environment, eventId: number, choice: string | false): Promise<number[]> {
  if (!choice || choice === "self_only") return [eventId];
  const ev = (await env.cr.query<{ recurrence_id: number | null; start: string }>(
    "SELECT recurrence_id, to_char(start, 'YYYY-MM-DD HH24:MI:SS') AS start FROM calendar_event WHERE id = $1", [eventId])).rows[0];
  if (!ev?.recurrence_id) return [eventId];
  if (choice === "all_events") {
    return (await env.cr.query<{ id: number }>("SELECT id FROM calendar_event WHERE recurrence_id = $1 AND active IS TRUE ORDER BY id", [ev.recurrence_id])).rows.map((r) => r.id);
  }
  return (await env.cr.query<{ id: number }>(
    "SELECT id FROM calendar_event WHERE recurrence_id = $1 AND active IS TRUE AND to_char(start, 'YYYY-MM-DD HH24:MI:SS') >= $2 ORDER BY id",
    [ev.recurrence_id, ev.start])).rows.map((r) => r.id);
}

async function unlinkEventWithRecurrenceCheck(env: Environment, eventId: number, choice: string | null): Promise<void> {
  const ev = (await env.cr.query<{ recurrency: boolean | null; recurrence_id: number | null; start: string }>(
    "SELECT recurrency, recurrence_id, to_char(start, 'YYYY-MM-DD HH24:MI:SS') AS start FROM calendar_event WHERE id = $1", [eventId])).rows[0];
  if (!ev) return;
  if (ev.recurrency && choice && ev.recurrence_id) {
    if (choice === "all_events") {
      const evIds = (await env.cr.query<{ id: number }>("SELECT id FROM calendar_event WHERE recurrence_id = $1 ORDER BY id", [ev.recurrence_id])).rows.map((r) => r.id);
      await unlink(env, "calendar.recurrence", [ev.recurrence_id]);
      if (evIds.length) await unlink(env, "calendar.event", evIds);
      return;
    }
    if (choice === "future_events") {
      const evIds = (await env.cr.query<{ id: number }>(
        "SELECT id FROM calendar_event WHERE recurrence_id = $1 AND to_char(start, 'YYYY-MM-DD HH24:MI:SS') >= $2 ORDER BY id",
        [ev.recurrence_id, ev.start])).rows.map((r) => r.id);
      if (evIds.length) await unlink(env, "calendar.event", evIds);
      return;
    }
  }
  await unlink(env, "calendar.event", [eventId]);
}

async function sendSingleDeleteWizardMail(env: Environment, wizId: number): Promise<void> {
  const [w] = await fetchRecords(env, "calendar.event.archive.or.unlink.wizard", [wizId], [
    "calendar_event_id", "recipient_ids", "subject", "body",
  ]);
  const eventId = m2oId(w!["calendar_event_id"]);
  const tplId = await env.reg.xmlid(env.cr, "calendar.calendar_template_delete_event");
  if (!eventId || !tplId) return;
  const selfPartner = (await userInfo(env)).partnerId;
  const emailFrom = await partnerEmailFormatted(env, selfPartner);
  const recipients = Array.isArray(w!["recipient_ids"]) ? (w!["recipient_ids"] as number[]) : [];
  await sendMailBatch(env, tplId, [eventId], {
    emailLayoutXmlid: "mail.mail_notification_light",
    emailValues: {
      body_html: w!["body"] || "",
      email_from: emailFrom,
      recipient_ids: recipients.map((p) => [4, p]),
      res_id: false,
      subject: w!["subject"] || "",
    },
  });
}

button("calendar.event.archive.or.unlink.wizard", "action_archive", async (env, ids) => {
  const id = ensureOne(ids, "calendar.event.archive.or.unlink.wizard");
  const [w] = await fetchRecords(env, "calendar.event.archive.or.unlink.wizard", [id], ["calendar_event_id", "recurrence_choice"]);
  const eventId = m2oId(w!["calendar_event_id"]);
  if (eventId !== null) {
    const evIds = await archiveWizardEventIds(env, eventId, (w!["recurrence_choice"] as string | false) || false);
    if (evIds.length) await write(env, "calendar.event", evIds, { active: false });
  }
  return env.context["next_action"] ?? null;
});

button("calendar.event.archive.or.unlink.wizard", "action_unlink", async (env, ids) => {
  const id = ensureOne(ids, "calendar.event.archive.or.unlink.wizard");
  const [w] = await fetchRecords(env, "calendar.event.archive.or.unlink.wizard", [id], ["calendar_event_id", "recurrence_choice"]);
  const eventId = m2oId(w!["calendar_event_id"]);
  if (eventId !== null) {
    await unlinkEventWithRecurrenceCheck(env, eventId, typeof w!["recurrence_choice"] === "string" ? w!["recurrence_choice"] : null);
  }
  return env.context["next_action"] ?? null;
});

button("calendar.event.archive.or.unlink.wizard", "action_send_mail_and_archive", async (env, ids) => {
  const id = ensureOne(ids, "calendar.event.archive.or.unlink.wizard");
  await sendSingleDeleteWizardMail(env, id);
  const [w] = await fetchRecords(env, "calendar.event.archive.or.unlink.wizard", [id], ["calendar_event_id", "recurrence_choice"]);
  const eventId = m2oId(w!["calendar_event_id"]);
  if (eventId !== null) {
    const evIds = await archiveWizardEventIds(env, eventId, (w!["recurrence_choice"] as string | false) || false);
    if (evIds.length) await write(env, "calendar.event", evIds, { active: false });
  }
  return env.context["next_action"] ?? null;
});

button("calendar.event.archive.or.unlink.wizard", "action_send_mail_and_unlink", async (env, ids) => {
  const id = ensureOne(ids, "calendar.event.archive.or.unlink.wizard");
  await sendSingleDeleteWizardMail(env, id);
  const [w] = await fetchRecords(env, "calendar.event.archive.or.unlink.wizard", [id], ["calendar_event_id", "recurrence_choice"]);
  const eventId = m2oId(w!["calendar_event_id"]);
  if (eventId !== null) {
    await unlinkEventWithRecurrenceCheck(env, eventId, typeof w!["recurrence_choice"] === "string" ? w!["recurrence_choice"] : null);
  }
  return env.context["next_action"] ?? null;
});

// calendar_event_multi_archive_or_unlink_wizard.py:23-55
async function sendMultiDeleteWizardMails(env: Environment, eventIds: readonly number[]): Promise<void> {
  if (!eventIds.length) return;
  const tplId = await env.reg.xmlid(env.cr, "calendar.calendar_template_delete_event");
  if (!tplId) return;
  const nowStr = datetimeToString(await dbNow(env)).slice(0, 19);
  const selfPartner = (await userInfo(env)).partnerId;
  const rows = (await env.cr.query<{ id: number; start: string; is_draft: boolean | null; pids: number[] }>(
    `SELECT e.id, to_char(e.start, 'YYYY-MM-DD HH24:MI:SS') AS start, e.is_draft,
            COALESCE(array_agg(r.res_partner_id) FILTER (WHERE r.res_partner_id IS NOT NULL), '{}'::int[]) AS pids
       FROM calendar_event e LEFT JOIN calendar_event_res_partner_rel r ON r.calendar_event_id = e.id
      WHERE e.id = ANY($1::int[]) GROUP BY e.id ORDER BY array_position($1::int[], e.id)`, [[...eventIds]])).rows;
  const toNotify = rows
    .filter((r) => !(r.pids.length === 1 && r.pids[0] === selfPartner) && r.start > nowStr && !r.is_draft)
    .map((r) => r.id);
  if (toNotify.length) {
    await sendMailBatch(env, tplId, toNotify, { emailValues: { res_id: false } });
  }
}

button("calendar.event.multi.archive.or.unlink.wizard", "action_archive", async (env, ids) => {
  const id = ensureOne(ids, "calendar.event.multi.archive.or.unlink.wizard");
  const [w] = await fetchRecords(env, "calendar.event.multi.archive.or.unlink.wizard", [id], ["calendar_event_ids"]);
  const evIds = Array.isArray(w!["calendar_event_ids"]) ? (w!["calendar_event_ids"] as number[]) : [];
  if (evIds.length) await write(env, "calendar.event", evIds, { active: false });
  return env.context["next_action"] ?? null;
});

button("calendar.event.multi.archive.or.unlink.wizard", "action_unlink", async (env, ids) => {
  const id = ensureOne(ids, "calendar.event.multi.archive.or.unlink.wizard");
  const [w] = await fetchRecords(env, "calendar.event.multi.archive.or.unlink.wizard", [id], ["calendar_event_ids"]);
  const evIds = Array.isArray(w!["calendar_event_ids"]) ? (w!["calendar_event_ids"] as number[]) : [];
  if (evIds.length) await unlink(env, "calendar.event", evIds);
  return env.context["next_action"] ?? null;
});

button("calendar.event.multi.archive.or.unlink.wizard", "action_send_mails_and_archive", async (env, ids) => {
  const id = ensureOne(ids, "calendar.event.multi.archive.or.unlink.wizard");
  const [w] = await fetchRecords(env, "calendar.event.multi.archive.or.unlink.wizard", [id], ["calendar_event_ids"]);
  const evIds = Array.isArray(w!["calendar_event_ids"]) ? (w!["calendar_event_ids"] as number[]) : [];
  await sendMultiDeleteWizardMails(env, evIds);
  if (evIds.length) await write(env, "calendar.event", evIds, { active: false });
  return env.context["next_action"] ?? null;
});

button("calendar.event.multi.archive.or.unlink.wizard", "action_send_mails_and_unlink", async (env, ids) => {
  const id = ensureOne(ids, "calendar.event.multi.archive.or.unlink.wizard");
  const [w] = await fetchRecords(env, "calendar.event.multi.archive.or.unlink.wizard", [id], ["calendar_event_ids"]);
  const evIds = Array.isArray(w!["calendar_event_ids"]) ? (w!["calendar_event_ids"] as number[]) : [];
  await sendMultiDeleteWizardMails(env, evIds);
  if (evIds.length) await unlink(env, "calendar.event", evIds);
  return env.context["next_action"] ?? null;
});

// ----------------------------------------------------------------------------------------------------------------
// 3. Contacts, Users, Groups, Company & Settings (`res.*`)
// ----------------------------------------------------------------------------------------------------------------

// base/models/res_partner.py:1136-1144
button("res.partner", "open_commercial_entity", async (env, ids) => {
  const id = ensureOne(ids, "res.partner");
  const [p] = await fetchRecords(env, "res.partner", [id], ["commercial_partner_id"]);
  return {
    type: "ir.actions.act_window",
    res_model: "res.partner",
    view_mode: "form",
    res_id: m2oId(p!["commercial_partner_id"]) ?? false,
    target: "current",
  };
});

// stock/models/res_partner.py:21-29
button("res.partner", "action_view_stock_serial", async (env, ids) => {
  const action = await forXmlId(env, "stock.action_production_lot_form");
  action["domain"] = [["partner_ids", "child_of", [...ids]]];
  action["context"] = {
    display_complete: true,
    create: true,
    default_partner_ids: [...ids],
  };
  return action;
});

// mail/models/mail_thread_blacklist.py:110-123
button("res.partner", "mail_action_blacklist_remove", async (env) => {
  if (await hasModelAccess(env, "mail.blacklist", "write")) {
    return {
      name: translate(env, "Are you sure you want to unblacklist this Email Address?"),
      type: "ir.actions.act_window",
      view_mode: "form",
      res_model: "mail.blacklist.remove",
      target: "new",
    };
  }
  throw new AccessError(translate(env, "You do not have the access right to unblacklist emails. Please contact your administrator."));
});

// phone_validation/models/mail_thread_phone.py:228-241
button("res.partner", "phone_action_blacklist_remove", async (env) => {
  if (await hasModelAccess(env, "phone.blacklist", "write")) {
    return {
      name: translate(env, "Are you sure you want to unblacklist this Phone Number?"),
      type: "ir.actions.act_window",
      view_mode: "form",
      res_model: "phone.blacklist.remove",
      target: "new",
    };
  }
  throw new AccessError(translate(env, "You do not have the access right to unblacklist phone numbers. Please contact your administrator."));
});

// base/models/res_company.py:515-527
button("res.company", "action_all_company_branches", async (env, ids) => {
  const id = ensureOne(ids, "res.company");
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Branches"),
    res_model: "res.company",
    domain: [["parent_id", "=", id]],
    context: { active_test: false, default_parent_id: id },
    views: [[false, "list"], [false, "kanban"], [false, "form"]],
  };
});

/** onboarding/models/onboarding_onboarding_step.py:94-133 `action_validate_step`. */
async function validateOnboardingStep(env: Environment, stepXmlid: string): Promise<"NOT_FOUND" | "JUST_DONE" | "WAS_DONE"> {
  const stepId = await env.reg.xmlid(env.cr, stepXmlid);
  if (stepId === null) return "NOT_FOUND";
  const step = (await env.cr.query<{ is_per_company: boolean | null }>(
    "SELECT is_per_company FROM onboarding_onboarding_step WHERE id = $1", [stepId])).rows[0];
  if (!step) return "NOT_FOUND";
  const companyId = await env.company();
  const existing = (await env.cr.query<{ id: number; step_state: string | null }>(
    `SELECT id, step_state FROM onboarding_progress_step
      WHERE step_id = $1 AND (company_id IS NULL OR company_id = $2) ORDER BY id LIMIT 1`, [stepId, companyId])).rows[0];
  let progressStepId: number;
  let state: string;
  if (existing) {
    progressStepId = existing.id;
    state = existing.step_state ?? "not_done";
  } else {
    // _create_progress_steps: link to matching onboarding.progress records
    const onbIds = (await env.cr.query<{ onboarding_onboarding_id: number }>(
      "SELECT onboarding_onboarding_id FROM onboarding_onboarding_onboarding_onboarding_step_rel WHERE onboarding_onboarding_step_id = $1", [stepId]))
      .rows.map((r) => r.onboarding_onboarding_id);
    const progIds = onbIds.length
      ? (await env.cr.query<{ id: number }>(
        "SELECT id FROM onboarding_progress WHERE onboarding_id = ANY($1::int[]) AND (company_id IS NULL OR company_id = $2) ORDER BY id",
        [onbIds, companyId])).rows.map((r) => r.id)
      : [];
    const [created] = await create(env, "onboarding.progress.step", [{
      step_id: stepId,
      progress_ids: progIds.map((pid) => [4, pid]),
      company_id: step.is_per_company ? companyId : false,
    }]);
    progressStepId = created!;
    state = "not_done";
  }
  if (state !== "not_done") return "WAS_DONE";
  await write(env, "onboarding.progress.step", [progressStepId], { step_state: "just_done" });
  // Recompute stored onboarding.progress.onboarding_state for affected progress records
  const linkedProgs = (await env.cr.query<{ onboarding_progress_id: number; onboarding_id: number }>(
    `SELECT r.onboarding_progress_id, p.onboarding_id
       FROM onboarding_progress_onboarding_progress_step_rel r
       JOIN onboarding_progress p ON p.id = r.onboarding_progress_id
      WHERE r.onboarding_progress_step_id = $1`, [progressStepId])).rows;
  for (const lp of linkedProgs) {
    const totalSteps = Number((await env.cr.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM onboarding_onboarding_onboarding_onboarding_step_rel WHERE onboarding_onboarding_id = $1", [lp.onboarding_id])).rows[0]?.n ?? "0");
    const doneSteps = Number((await env.cr.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM onboarding_progress_onboarding_progress_step_rel r
         JOIN onboarding_progress_step s ON s.id = r.onboarding_progress_step_id
        WHERE r.onboarding_progress_id = $1 AND s.step_state IN ('just_done', 'done')`, [lp.onboarding_progress_id])).rows[0]?.n ?? "0");
    const newState = doneSteps === totalSteps ? "done" : "not_done";
    await env.cr.query(
      "UPDATE onboarding_progress SET onboarding_state = $2, write_uid = $3, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1 AND onboarding_state IS DISTINCT FROM $2",
      [lp.onboarding_progress_id, newState, env.uid]);
  }
  return "JUST_DONE";
}

// account/models/company.py:1096-1105
button("res.company", "action_save_onboarding_sale_tax", async (env) => {
  await validateOnboardingStep(env, "account.onboarding_onboarding_step_sales_tax");
  return null;
});

button("res.company", "action_save_onboarding_company_data", async (env, ids) => {
  const id = ensureOne(ids, "res.company");
  const [co] = await fetchRecords(env, "res.company", [id], ["street"]);
  if (co!["street"]) {
    const cenv = env.withContext({ ...env.context, allowed_company_ids: [id] });
    await validateOnboardingStep(cenv, "account.onboarding_onboarding_step_company_data");
  }
  return { type: "ir.actions.client", tag: "soft_reload" };
});

// base/models/res_users.py:1121-1130
button("res.users", "action_change_password_wizard", async (env, ids) =>
  checkIdentity(env, "res.users", ids, "action_change_password_wizard", async () => ({
    type: "ir.actions.act_window",
    target: "new",
    res_model: "change.password.wizard",
    view_mode: "form",
    name: "Change Password",
    context: { active_ids: [...ids], active_model: "res.users" },
  })),
);

/** res_users.py:486-488 `all_group_ids`: user's direct group_ids then their implied groups (`all_implied_ids`). */
async function userAllGroupIds(env: Environment, uid: number): Promise<number[]> {
  // res_groups.py:346 `g.ids + group_definitions.get_superset_ids(g.ids)` per group in user.group_ids order
  const direct = (await env.cr.query<{ gid: number }>(
    `SELECT g.id AS gid FROM res_groups_users_rel r JOIN res_groups g ON g.id = r.gid
       LEFT JOIN res_groups_privilege p ON p.id = g.privilege_id
      WHERE r.uid = $1 ORDER BY p.sequence, COALESCE(p.name->>'en_US', ''), p.id, g.sequence, COALESCE(g.name->>'en_US', ''), g.id`, [uid])).rows.map((r) => r.gid);
  const edges = new Map<number, number[]>();
  for (const { gid, hid } of (await env.cr.query<{ gid: number; hid: number }>("SELECT gid, hid FROM res_groups_implied_rel")).rows) {
    edges.set(gid, [...(edges.get(gid) ?? []), hid]);
  }
  const seen = new Set<number>();
  const out: number[] = [];
  for (const g of direct) {
    if (!seen.has(g)) { seen.add(g); out.push(g); }
    const sub = new Set<number>();
    const stack = [...(edges.get(g) ?? [])];
    while (stack.length) {
      const x = stack.pop()!;
      if (sub.has(x) || x === g) continue;
      sub.add(x);
      stack.push(...(edges.get(x) ?? []));
    }
    for (const x of [...sub].sort((a, b) => a - b)) {
      if (!seen.has(x)) { seen.add(x); out.push(x); }
    }
  }
  return out;
}

// base/models/res_users.py:1247-1269
button("res.users", "action_show_groups", async (env, ids) => {
  const id = ensureOne(ids, "res.users");
  await fetchRecords(env, "res.users", [id], ["id"]);
  return {
    name: translate(env, "Groups"),
    view_mode: "list,form",
    res_model: "res.groups",
    type: "ir.actions.act_window",
    context: { create: false, delete: false },
    domain: [["id", "in", await userAllGroupIds(env, id)]],
    target: "current",
  };
});

button("res.users", "action_show_accesses", async (env, ids) => {
  const id = ensureOne(ids, "res.users");
  await fetchRecords(env, "res.users", [id], ["id"]);
  return {
    name: translate(env, "Access Rights"),
    view_mode: "list,form",
    res_model: "ir.access",
    type: "ir.actions.act_window",
    context: { create: false, delete: false },
    domain: [["group_id", "in", await userAllGroupIds(env, id)]],
    target: "current",
  };
});

// res.users action_reset_password: src/models/res_users_invite.ts

// base/models/res_groups.py:599-627
button("res.groups", "action_view_implied_ids", async (env, ids) => {
  const id = ensureOne(ids, "res.groups");
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Implying Groups"),
    res_model: "res.groups",
    views: [[false, "list"], [false, "form"]],
    domain: [["implied_by_ids", "in", [id]]],
  };
});

button("res.groups", "action_view_implied_by_ids", async (env, ids) => {
  const id = ensureOne(ids, "res.groups");
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Implied Groups"),
    res_model: "res.groups",
    views: [[false, "list"], [false, "form"]],
    domain: [["implied_ids", "in", [id]]],
  };
});

button("res.groups", "action_view_access_ids", async (env, ids) => {
  const id = ensureOne(ids, "res.groups");
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Access Rules"),
    res_model: "ir.access",
    views: [[false, "list"], [false, "kanban"], [false, "form"]],
    domain: [["group_id", "in", [id]]],
  };
});

interface LangTermsSave {
  readonly model: string; readonly table: string; readonly field: string;
  readonly rows: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, readonly [Record<string, string | null>, Record<string, string | null>]>>>>>>;
}
interface LangImporterSave {
  readonly overwrite: boolean; readonly force_overwrite: boolean; readonly caller: readonly string[];
  readonly model: readonly ModelSave[]; readonly terms: readonly LangTermsSave[];
}
interface LangInstallData {
  readonly guard: { readonly companies: readonly [number, string | null][] };
  readonly saves: readonly LangImporterSave[];
}

async function langFingerprint(values: Record<string, unknown>, lang: string): Promise<string> {
  const keep: Record<string, unknown> = {};
  for (const k of ["en_US", "_en_US", lang, `_${lang}`]) if (k in values) keep[k] = values[k];
  const canon = `{${Object.keys(keep).sort().map((k) => `${JSON.stringify(k)}:${JSON.stringify(keep[k])}`).join(",")}}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** res_lang.py:375-384 `action_unarchive` -> activate + load module & manifest translations (overwrite=False). */
async function unarchiveAndLoadLangs(env: Environment, ids: readonly number[]): Promise<void> {
  if (!ids.length) return;
  const inactive = (await env.cr.query<{ id: number; code: string }>(
    "SELECT id, code FROM res_lang WHERE id = ANY($1::int[]) AND active IS NOT TRUE ORDER BY active DESC, name, id", [[...ids]])).rows;
  if (!inactive.length) return;
  const template = await templateOf(env.cr);
  const dir = template.overlay ?? template.dir;
  const data = new Map<string, LangInstallData>();
  for (const { code } of inactive) {
    if (code === "en_US") continue;
    if (!dir) throw new NotPorted(`res.lang.action_activate_langs for ${code} on ${template.name}`);
    const raw = await genAssetJson(`${dir}/lang/${code}.json`) as LangInstallData | null;
    if (!raw || !Array.isArray(raw.saves)) throw new NotPorted(`res.lang.action_activate_langs: no lang data for ${code}`);
    data.set(code, raw);
  }
  await activateLangs(env, inactive.map((l) => l.id));
  for (const [code, d] of data) {
    for (const save of d.saves) {
      // res_lang.action_unarchive calls mods._update_translations(active_lang) with overwrite=False
      const doOverwrite = save.force_overwrite;
      for (const t of save.terms) {
        const xmlids = Object.keys(t.rows);
        const ident = (s: string): string => `"${s.replace(/"/g, '""')}"`;
        for (let i = 0; i < xmlids.length; i += 1000) {
          const chunk = xmlids.slice(i, i + 1000);
          const mods = chunk.map((x) => x.slice(0, x.indexOf(".")));
          const names = chunk.map((x) => x.slice(x.indexOf(".") + 1));
          const found = (await env.cr.query<{ id: number; xmlid: string; values: Record<string, unknown> | null; noupdate: boolean | null }>(
            `SELECT m.id, imd.module || '.' || imd.name AS xmlid, m.${ident(t.field)} AS values, imd.noupdate
               FROM ${ident(t.table)} m, "ir_model_data" imd
              WHERE m.id = imd.res_id AND (imd.module, imd.name) IN (SELECT * FROM unnest($1::text[], $2::text[]))`, [mods, names])).rows;
          const params: [number, string][] = [];
          for (const r of found) {
            if (!r.values || !(r.values["_en_US"] ?? r.values["en_US"])) continue;
            const fp = await langFingerprint(r.values, code);
            const result = t.rows[r.xmlid]?.[String(r.id)]?.[fp];
            if (result === undefined) continue;
            const changed = result[doOverwrite ? 1 : 0];
            if (Object.keys(changed).length) params.push([r.id, JSON.stringify(changed)]);
          }
          if (params.length) {
            await env.cr.query(
              `UPDATE ${ident(t.table)} AS m SET ${ident(t.field)} = jsonb_strip_nulls(${ident(t.field)} || t.value)
                 FROM (SELECT * FROM unnest($1::int[], $2::jsonb[])) AS t(id, value) WHERE m.id = t.id`,
              [params.map((p) => p[0]), params.map((p) => p[1])]);
          }
        }
      }
      for (const m of save.model) await saveModelEntries(env, m, false, save.force_overwrite);
    }
    await env.cr.query(
      `UPDATE account_account_tag tag
          SET name = tag.name || jsonb_build_object($1::text, substring(tag.name->>'en_US' FOR 1) || (report_line.name->>$1::text))
         FROM account_report_line report_line JOIN account_report report ON report.id = report_line.report_id
        WHERE tag.applicability = 'taxes' AND tag.country_id = report.country_id
          AND tag.name->>'en_US' = substring(tag.name->>'en_US' FOR 1) || (report_line.name->>'en_US')
          AND tag.name->>$1::text != substring(tag.name->>'en_US' FOR 1) || (report_line.name->>$1::text)`, [code]);
    await loadManifestTerms(env, code);
  }
}

// base/models/res_lang.py:472-486
button("res.lang", "action_activate_langs", async (env, ids) => {
  await unarchiveAndLoadLangs(env, ids);
  return {
    type: "ir.actions.client",
    tag: "display_notification",
    target: "new",
    params: {
      message: translate(env, "The languages that you selected have been successfully installed. Users can choose their favorite language in their preferences."),
      type: "success",
      sticky: false,
      next: { type: "ir.actions.act_window_close" },
    },
  };
});

// res.config.settings actions
// base_setup/models/res_config_settings.py:45-53
button("res.config.settings", "open_company", async (env) => ({
  type: "ir.actions.act_window",
  name: "My Company",
  view_mode: "form",
  res_model: "res.company",
  res_id: await env.company(),
  target: "current",
}));

// mail/models/res_config_settings.py:179-192
button("res.config.settings", "open_email_layout", async (env) => {
  const layoutId = await env.reg.xmlid(env.cr, "mail.mail_notification_layout");
  if (layoutId === null) throw new UserError(translate(env, "This layout seems to no longer exist."));
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Mail Layout"),
    view_mode: "form",
    res_id: layoutId,
    res_model: "ir.ui.view",
  };
});

button("res.config.settings", "open_mail_templates", async (env) =>
  forXmlId(env, "mail.action_email_template_tree_all"),
);

// base_setup/models/res_config_settings.py:55-76
button("res.config.settings", "open_new_user_default_groups", async (env) => {
  let groupId = await env.reg.xmlid(env.cr, "base.default_user_group");
  if (groupId === null) {
    const [createdGroup] = await create(env, "res.groups", [{ name: translate(env, "Default access for new users") }]);
    groupId = createdGroup!;
    await create(env, "ir.model.data", [{
      name: "default_user_group",
      module: "base",
      res_id: groupId,
      model: "res.groups",
      noupdate: true,
    }]);
  }
  const viewId = await xmlid(env, "base.view_default_groups_form");
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Edit new user default group"),
    view_mode: "form",
    res_model: "res.groups",
    res_id: groupId,
    views: [[viewId, "form"]],
    target: "new",
  };
});

// base_setup/models/res_config_settings.py:78-91
button("res.config.settings", "edit_external_header", async (env, ids) => {
  const id = ensureOne(ids, "res.config.settings");
  const [s] = await fetchRecords(env, "res.config.settings", [id], ["external_report_layout_id"]);
  const layoutId = m2oId(s!["external_report_layout_id"]);
  if (layoutId === null) return false;
  const key = (await env.cr.query<{ key: string | null }>("SELECT key FROM ir_ui_view WHERE id = $1", [layoutId])).rows[0]?.key;
  if (!key) throw new NotPorted("edit_external_header with a layout view without key");
  const targetId = await env.reg.xmlid(env.cr, key);
  if (targetId === null) throw new OdooError("builtins.ValueError", `External ID not found in the system: ${key}`);
  return {
    type: "ir.actions.act_window",
    res_model: "ir.ui.view",
    view_mode: "form",
    res_id: targetId,
  };
});

// stock/models/res_config_settings.py:160-163
button("res.config.settings", "action_view_delivery_methods", async (env) => {
  const actId = await env.reg.xmlid(env.cr, "delivery.action_delivery_carrier_form");
  if (actId === null) return null;
  return forXmlId(env, "delivery.action_delivery_carrier_form");
});

// payment/wizards/res_config_settings.py:43-51
button("res.config.settings", "action_view_installed_provider", async (env, ids) => {
  const rows = await fetchRecords(env, "res.config.settings", ids, ["installed_provider_id"]);
  const provIds = [...new Set(rows.map((r) => m2oId(r["installed_provider_id"])).filter((p): p is number => p !== null))];
  const providerId = ensureOne(provIds, "payment.provider");
  return {
    type: "ir.actions.act_window",
    view_mode: "form",
    res_model: "payment.provider",
    views: [[false, "form"]],
    res_id: providerId,
  };
});

// base/models/res_config.py:552-560
button("res.config.settings", "action_open_template_user", async (env) => {
  const action = await forXmlId(env, "base.action_res_users");
  const raw = await configParam(env.sudo(), "base.template_portal_user_id");
  const tplUid = raw !== null && /^-?\d+$/.test(raw.trim()) ? Number(raw.trim()) : 0;
  const exists = tplUid > 0 && (await env.cr.query("SELECT 1 FROM res_users WHERE id = $1", [tplUid])).rows.length > 0;
  if (!exists) throw new UserError(translate(env, "Invalid template user. It seems it has been deleted."));
  action["res_id"] = tplUid;
  action["views"] = [[await xmlid(env, "base.view_users_form"), "form"]];
  return action;
});

// account/models/res_config_settings.py:318-330
button("res.config.settings", "action_update_terms", async (env, ids) => {
  const id = ensureOne(ids, "res.config.settings");
  const [s] = await fetchRecords(env, "res.config.settings", [id], ["company_id"]);
  if (env.reg.model("res.config.settings").fields.has("website_id") && await userHasGroup(env, "website.group_website_designer")) {
    throw new NotPorted("res.config.settings.action_update_terms with website installed");
  }
  const viewId = await env.reg.xmlid(env.cr, "account.res_company_view_form_terms");
  return {
    name: translate(env, "Update Terms & Conditions"),
    type: "ir.actions.act_window",
    view_mode: "form",
    res_model: "res.company",
    view_id: viewId ?? false,
    target: "new",
    res_id: m2oId(s!["company_id"]) ?? false,
  };
});

// crm/models/res_config_settings.py:173-175
button("res.config.settings", "action_crm_assign_leads", async (env, ids) => {
  ensureOne(ids, "res.config.settings");
  const teamIds = await env.model("crm.team").search(cond("assignment_optout", "=", false));
  return callKw(env, "crm.team", "action_assign_leads", [teamIds], {});
});

// Keep unused imports referenced if needed
void and;
void TRUE;
