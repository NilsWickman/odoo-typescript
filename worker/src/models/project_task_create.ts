/**
 * project.task creation (odoo/addons/project/models/project_task.py): stored computes reached on create and the
 * `create` override; the mail part is in src/mail/write_hooks.ts.
 */
import { NotPorted } from "../errors";
import { dictEntries, evalExpr, isDict } from "../pyexpr";
import { userHasGroup } from "../web/groups";
import { registerMethod } from "../http/methods";
import { envFor } from "../web/common";
import { and, cond, or } from "../orm/domain";
import { registerGroupExpand } from "../web/read_group";
import { floatRound, floatRoundRounding } from "../orm/convert";
import { NewRec, registerOnchange, type Rec, type RecordCompute } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { defineComputes } from "./tail_util";
import { datetimeToString, dbNow, translate } from "./util";

/** Microseconds since the epoch of a naive UTC datetime string (`YYYY-MM-DD HH:MM:SS[.ffffff]`). */
function usOf(s: string): number {
  const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) throw new NotPorted(`datetime value ${s}`);
  const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  return ms * 1000 + Number((m[7] ?? "").padEnd(6, "0"));
}
const DAY_US = 86400 * 1e6;

/**
 * resource_calendar.py:739-762 `get_work_duration_data(from, to, compute_leaves=True, domain)` for naive (UTC)
 * datetimes: `_work_intervals_batch` (:525-540) = the attendance intervals (:287-453) of each day in UTC minus the
 * leaves (:468-523), then `_get_attendance_intervals_days_data` (:583-623). Ported for fixed calendars whose
 * attendances are undated and not recurrent, and periods without any matching leave.
 */
interface CalAttendance { dayofweek: string; hour_from: number; hour_to: number; duration_based: boolean | null; duration_hours: number | null; dated: boolean; recurrency: boolean | null }

/**
 * `_work_intervals_batch` (resource_calendar.py:525-540) of a fixed calendar in UTC: per day (microseconds since the
 * epoch of 00:00 UTC) the attendance intervals (:287-453) clipped to the period, leaves refused when any applies.
 * `leaveCompanies`: the company domain of the leaves (`null`: no company condition).
 */
async function calendarWorkIntervals(env: Environment, calendarId: number, fromUs: number, toUs: number, leaveCompanies: readonly number[] | null):
  Promise<{ byDay: Map<number, [number, number][]>; atts: CalAttendance[]; hoursPerDay: number }> {
  const cal = (await env.cr.query<{ calendar_type: string | null; hours_per_day: string | null }>(
    "SELECT calendar_type, hours_per_day::text AS hours_per_day FROM resource_calendar WHERE id = $1", [calendarId])).rows[0];
  if (!cal || cal.calendar_type !== "fixed") throw new NotPorted("work intervals of a non-fixed resource calendar");
  const atts = (await env.cr.query<CalAttendance>(
    `SELECT dayofweek, hour_from::float8 AS hour_from, hour_to::float8 AS hour_to, duration_based, duration_hours::float8 AS duration_hours,
            date IS NOT NULL AS dated, recurrency FROM resource_calendar_attendance WHERE calendar_id = $1 ORDER BY sequence, dayofweek, hour_from, id`, [calendarId])).rows;
  if (atts.some((x) => x.dated || x.recurrency)) throw new NotPorted("work intervals with dated or recurrent attendances");
  // :468-492 leaves of the calendar or global, without resource, overlapping the period
  if (leaveCompanies === null || leaveCompanies.length) {
    const leaves = (await env.cr.query(
      `SELECT 1 FROM resource_calendar_leaves WHERE (calendar_id IS NULL OR calendar_id = $1) AND resource_id IS NULL
          AND date_from <= to_timestamp($2::float8 / 1e6) AT TIME ZONE 'UTC' AND date_to >= to_timestamp($3::float8 / 1e6) AT TIME ZONE 'UTC' LIMIT 1`,
      [calendarId, toUs, fromUs])).rows.length;
    if (leaves) throw new NotPorted("work intervals with leaves (Intervals difference)");
  }
  // tools/date_utils.py:77-90 float_to_time: minutes rounded half-up, a carried 60 minutes, 24:00 as time.max
  const hourUs = (h: number): number => {
    let hour = Math.trunc(h);
    let minute = floatRound(60 * (h - hour), 0);
    if (minute === 60) { hour += 1; minute = 0; }
    if (hour === 24 && minute === 0) return DAY_US - 1;
    if (hour < 0 || hour > 23) throw new NotPorted(`attendance hour ${h}`);
    return hour * 3600e6 + minute * 60e6;
  };
  const byDay = new Map<number, [number, number][]>();
  for (let day = Math.floor(fromUs / DAY_US) * DAY_US; day <= Math.floor(toUs / DAY_US) * DAY_US; day += DAY_US) {
    const weekday = (new Date(day / 1000).getUTCDay() + 6) % 7; // Python weekday(): Monday 0
    const dayAtts = atts.filter((x) => Number(x.dayofweek) === weekday);
    if (!dayAtts.length) continue;
    const intervals: [number, number][] = [];
    if (dayAtts.every((x) => x.duration_based)) {
      // :318-330 duration-based days are centred on noon, one after the other
      const total = dayAtts.reduce((t, x) => t + (x.duration_hours ?? 0), 0);
      let from = 12 - total / 2;
      for (const x of dayAtts) { intervals.push([day + hourUs(from), day + hourUs(from + (x.duration_hours ?? 0))]); from += x.duration_hours ?? 0; }
    } else {
      if (dayAtts.some((x) => x.duration_based)) throw new NotPorted("work intervals of days mixing duration-based attendances");
      for (const x of dayAtts) intervals.push([day + hourUs(x.hour_from), day + hourUs(x.hour_to)]);
    }
    // :346-352 clipped to the period; Intervals drop empty ones (tools/intervals.py:12-17), keep_distinct
    const clipped = intervals.map(([x, y]) => [Math.max(fromUs, x), Math.min(toUs, y)] as [number, number]).filter(([x, y]) => x < y).sort((u, v) => u[0] - v[0]);
    for (let i = 1; i < clipped.length; i++) if (clipped[i]![0] < clipped[i - 1]![1]) throw new NotPorted("work intervals of overlapping attendances");
    if (clipped.length) byDay.set(day, clipped);
  }
  return { byDay, atts, hoursPerDay: Number(cal.hours_per_day ?? 0) };
}

/**
 * resource_calendar.py:739-762 `get_work_duration_data(from, to, compute_leaves=True, domain)` for naive (UTC)
 * datetimes, then `_get_attendance_intervals_days_data` (:583-623).
 */
async function workDurationData(env: Environment, calendarId: number, fromUs: number, toUs: number, companyIds: readonly number[]): Promise<{ hours: number; days: number }> {
  const { byDay, atts, hoursPerDay } = await calendarWorkIntervals(env, calendarId, fromUs, toUs, companyIds);
  const dayHours = new Map<number, number>();
  const dayDays = new Map<number, number>();
  for (const [day, clipped] of byDay) for (const [a, b] of clipped) dayHours.set(day, (dayHours.get(day) ?? 0) + (b - a) / 1e6 / 3600);
  for (const [day, hours] of dayHours) {
    const weekday = (new Date(day / 1000).getUTCDay() + 6) % 7;
    const based = atts.filter((a) => a.duration_based && Number(a.dayofweek) === weekday);
    if (based.length) {
      const per = based.reduce((t, a) => t + (a.duration_hours ?? 0), 0);
      dayDays.set(day, (dayDays.get(day) ?? 0) + (per ? hours / per : 0));
    } else {
      dayDays.set(day, hours <= (hoursPerDay * 3) / 4 ? 0.5 : 1);
    }
  }
  let days = 0;
  for (const v of dayDays.values()) days += v;
  let hours = 0;
  for (const v of dayHours.values()) hours += v;
  return { days: floatRoundRounding(days, 0.001), hours };
}

/**
 * project_task.py:2235-2240 `get_unusual_days(date_from, date_to)`: the company calendar's `_get_unusual_days`
 * (resource_calendar.py:666-684) from date_from 00:00 to date_to 23:59:59.999999 UTC: a day is unusual without work.
 */
registerMethod("project.task", "get_unusual_days", async (env0, _ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const from = "date_from" in kwargs ? kwargs["date_from"] : args[0];
  const to = "date_to" in kwargs ? kwargs["date_to"] : args[1];
  if (typeof from !== "string" || typeof to !== "string") throw new NotPorted("get_unusual_days without both dates");
  const calendar = (await env.cr.query<{ c: number | null }>("SELECT resource_calendar_id AS c FROM res_company WHERE id = $1", [await env.company()])).rows[0]?.c ?? null;
  if (calendar === null) throw new NotPorted("get_unusual_days without a company calendar");
  const fromUs = usOf(`${from.slice(0, 10)} 00:00:00`);
  const toUs = usOf(`${to.slice(0, 10)} 00:00:00`) + DAY_US - 1;
  const { byDay } = await calendarWorkIntervals(env, calendar, fromUs, toUs, null);
  const out: Record<string, boolean> = {};
  for (let day = fromUs; day <= toUs; day += DAY_US) out[new Date(day / 1000).toISOString().slice(0, 10)] = !byDay.has(day);
  return out;
}, { apiModel: true, readonly: true });

/** project_task.py:619-646 `_compute_elapsed` with the project's resource calendar. */
async function elapsedData(env: Environment, rec: Rec): Promise<Record<string, number>> {
  const zero = { working_hours_open: 0, working_days_open: 0, working_hours_close: 0, working_days_close: 0 };
  const project = await rec.rel("project_id");
  if (!project) return zero;
  const calendar = await project.get("resource_calendar_id");
  const calendarId = typeof calendar === "number" ? calendar : Array.isArray(calendar) ? calendar[0] as number : null;
  if (!calendarId || rec.id === null) return zero;
  const row = (await env.cr.query<{ c: string | null }>("SELECT create_date::text AS c FROM project_task WHERE id = $1", [rec.id])).rows[0];
  if (!row?.c) return zero;
  const company = await project.get("company_id");
  const companyIds = typeof company === "number" ? [company] : Array.isArray(company) ? [company[0] as number] : [];
  const out = { ...zero };
  const assign = await rec.get("date_assign"), end = await rec.get("date_end");
  const asString = (v: unknown): string => (typeof v === "string" ? v : v instanceof Date ? datetimeToString(v) : String(v));
  if (assign) {
    const d = await workDurationData(env, calendarId, usOf(row.c), usOf(asString(assign)), companyIds);
    out.working_hours_open = d.hours; out.working_days_open = d.days;
  }
  if (end) {
    const d = await workDurationData(env, calendarId, usOf(row.c), usOf(asString(end)), companyIds);
    out.working_hours_close = d.hours; out.working_days_close = d.days;
  }
  return out;
}
const elapsed = (field: string): RecordCompute => async (env, rec) => (await elapsedData(env, rec))[field];
defineComputes("project.task", {
  working_hours_open: elapsed("working_hours_open"),
  working_hours_close: elapsed("working_hours_close"),
  working_days_open: elapsed("working_days_open"),
  working_days_close: elapsed("working_days_close"),
});

/** rating_mixin.py:51-59 `_compute_rating_stats` (compute_sudo): consumed ratings of at least RATING_LIMIT_MIN (1). */
async function ratingStats(env: Environment, rec: Rec): Promise<{ count: number; avg: number }> {
  if (rec.id === null) return { count: 0, avg: 0 };
  const row = (await env.cr.query<{ n: string; a: number | null }>(
    `SELECT count(*)::text AS n, avg(rating) AS a FROM rating_rating
      WHERE res_model = 'project.task' AND res_id = $1 AND consumed IS TRUE AND rating >= 1`, [rec.id])).rows[0];
  return { count: Number(row?.n ?? 0), avg: Number(row?.n ?? 0) ? Number(row?.a ?? 0) : 0 };
}
/** tools/float_utils.py:216-260 `float_compare(a, b, precision_digits)`. */
function floatCompare(a: number, b: number, digits: number): -1 | 0 | 1 {
  if (a === b) return 0;
  const delta = floatRound(a, digits) - floatRound(b, digits);
  if (floatRound(delta, digits) === 0) return 0;
  return delta < 0 ? -1 : 1;
}
defineComputes("project.task", {
  rating_count: async (env, rec) => (await ratingStats(env, rec)).count,
  rating_avg: async (env, rec) => (await ratingStats(env, rec)).avg,
  // rating_mixin.py:75-78 _compute_rating_avg_text (rating_data.py:9-11, 45-52 `_rating_avg_to_text`)
  rating_avg_text: async (env, rec) => {
    const avg = (await ratingStats(env, rec)).avg;
    if (floatCompare(avg, 3.66, 2) >= 0) return "top";
    if (floatCompare(avg, 2.33, 2) >= 0) return "ok";
    if (floatCompare(avg, 1, 2) >= 0) return "ko";
    return "none";
  },
});

defineComputes("project.task", {
  // project_task.py:536-539 _compute_allow_task_dependencies (compute_sudo)
  allow_task_dependencies: async (env, rec) => {
    const project = await rec.rel("project_id");
    if (project) return Boolean(await project.get("allow_task_dependencies"));
    return Boolean(await rec.get("is_template"));
  },
  // project_task.py:1512-1523 _compute_has_late_and_unreached_milestone
  has_late_and_unreached_milestone: async (env, rec) => {
    if (!(await rec.get("allow_milestones"))) return false;
    const milestone = await rec.get("milestone_id");
    const mid = typeof milestone === "number" ? milestone : Array.isArray(milestone) ? milestone[0] as number : null;
    if (!mid) return false;
    const late = await env.sudo().model("project.milestone").search(and([cond("id", "in", [mid]), cond("is_reached", "=", false), cond("deadline", "<=", "today")]));
    return late.includes(mid);
  },
});

/** project_task.py:564-586 `_compute_depend_on_count` (compute_sudo): the tasks it depends on, and the closed ones. */
async function dependOn(env: Environment, rec: Rec): Promise<[number, number]> {
  if (!(await rec.get("allow_task_dependencies"))) return [0, 0];
  if (rec.id === null) {
    const deps = await rec.get("depend_on_ids");
    if (Array.isArray(deps) && deps.length) throw new NotPorted("project.task depend_on_count of a new record with dependencies");
    return [0, 0];
  }
  const ids = await env.sudo().model("project.task").search(cond("dependent_ids", "in", [rec.id]));
  if (!ids.length) return [0, 0];
  const closed = (await env.cr.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM project_task WHERE id = ANY($1::int[]) AND state IN ('1_done', '1_canceled')", [ids])).rows[0];
  return [ids.length, Number(closed?.n ?? 0)];
}
defineComputes("project.task", {
  depend_on_count: async (env, rec) => (await dependOn(env, rec))[0],
  closed_depend_on_count: async (env, rec) => (await dependOn(env, rec))[1],
  // project_task.py:588-602 `_compute_dependent_tasks_count`: open tasks blocked by this one (the user's rules)
  dependent_tasks_count: async (env, rec) => {
    if (!(await rec.get("allow_task_dependencies")) || rec.id === null) return 0;
    return env.model("project.task").searchCount(and([cond("depend_on_ids", "in", [rec.id]), cond("is_closed", "=", false)]));
  },
});

defineComputes("project.task", {
  // sale_project project_task.py:105-120 _compute_sale_warning_text: the customer's and its parent's warnings
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
});

/** project_task.py:541-553 `_compute_repeat` (compute_sudo): the recurrence's values, the defaults of a recurrent task, else False. */
async function repeatValue(env: Environment, rec: Rec, field: "repeat_interval" | "repeat_unit" | "repeat_type" | "repeat_until"): Promise<unknown> {
  const recurrence = await rec.rel("recurrence_id");
  if (recurrence) return recurrence.get(field);
  if (await rec.get("recurring_task")) {
    // default_get(rec_fields): the context defaults first, then the field defaults (:303-314)
    if (`default_${field}` in env.context) throw new NotPorted(`project.task ${field} from a context default`);
    return { repeat_interval: 1, repeat_unit: "week", repeat_type: "forever", repeat_until: false }[field];
  }
  return field === "repeat_interval" ? 0 : false; // False in an Integer field's cache is 0
}
defineComputes("project.task", {
  repeat_interval: (env, rec) => repeatValue(env, rec, "repeat_interval"),
  repeat_unit: (env, rec) => repeatValue(env, rec, "repeat_unit"),
  repeat_type: (env, rec) => repeatValue(env, rec, "repeat_type"),
  repeat_until: (env, rec) => repeatValue(env, rec, "repeat_until"),
  // project_task.py:555-562 _compute_recurring_count: the tasks of the recurrence (the user's rules)
  recurring_count: async (env, rec) => {
    const recurrence = await rec.get("recurrence_id");
    const rid = typeof recurrence === "number" ? recurrence : Array.isArray(recurrence) ? recurrence[0] as number : null;
    if (!rid) return 0;
    return env.model("project.task").searchCount(cond("recurrence_id", "in", [rid]));
  },
  // project_task.py:851-855 _compute_allow_recurring_tasks (compute_sudo)
  allow_recurring_tasks: async (_env, rec) => {
    const project = await rec.rel("project_id");
    if (project) return Boolean(await project.get("allow_recurring_tasks"));
    return Boolean(await rec.get("is_template"));
  },
  // project_task.py:2307-2310 _compute_subtask_completion_percentage: `subtask_count and closed / count`
  subtask_completion_percentage: async (_env, rec) => {
    const count = Number(await rec.get("subtask_count") || 0);
    return count ? Number(await rec.get("closed_subtask_count") || 0) / count : 0;
  },
});



defineComputes("project.task", {
  // project_task.py:399-413 _compute_state: blocked by an open dependency -> waiting (unless closed); unblocked
  // waiting -> in progress; otherwise unchanged
  state: async (_env, rec) => {
    const current = await rec.prev("state");
    let open = false;
    if (await rec.get("allow_task_dependencies")) {
      for (const dep of await rec.rels("depend_on_ids")) {
        if (!["1_done", "1_canceled"].includes(String(await dep.get("state")))) { open = true; break; }
      }
    }
    if (open) return ["1_done", "1_canceled"].includes(String(current)) ? current : "04_waiting_normal";
    if (current === "04_waiting_normal") return "01_in_progress";
    return current;
  },
});

defineComputes("project.task", {
  // project_task.py:366-374 _compute_project_id: without a parent the value stays; subtasks (the parent's project,
  // and `remove_to_compute(display_in_project)`) refuse. The cached value itself is returned: a converted empty value
  // would count as a change in the onchange loop.
  project_id: async (env, rec) => {
    const current = await rec.prev("project_id");
    // a new record whose parent is only the context's default (parent_id not in the form): Odoo's answer depends on
    // the order its lazy computes run in (display_in_project, then _onchange_project_id; an odoo-bin shell and the
    // HTTP server gave different projects for one call, 2026-11-22), so it is refused
    if (rec instanceof NewRec && rec.originRec === null && !rec.values.has("parent_id") && env.context["default_parent_id"]) {
      throw new NotPorted("project.task new record with its parent from default_parent_id outside the form");
    }
    const parent = await rec.rel("parent_id");
    if (!parent) return current;
    // a subtask hidden from the project follows its parent's project (`remove_to_compute(display_in_project)`: the
    // value it has now), unless the parent has none and the task is no template
    const parentProject = idOf(await parent.get("project_id"));
    // `remove_to_compute(display_in_project)` then `task.display_in_project`: the cached value; a new record without
    // one computes it (with project_id, being computed, at its cached value), project_task.py:376-381
    const shown = rec instanceof NewRec && !rec.hasCacheValue("display_in_project") ? await rec.get("display_in_project") : await rec.prev("display_in_project");
    if (!shown && parentProject !== idOf(current)) {
      if (!parentProject && !(await rec.get("is_template"))) return current;
      return parentProject;
    }
    return current;
  },
});

// project_task.py:139-147 `_read_group_stage_ids` (stage_id group_expand): the stages of the groups, plus the
// default project's stages in a project kanban (not for subtasks)
registerGroupExpand("project.task", "stage_id", async (env, _model, values) => {
  let domain = cond("id", "in", [...values]);
  if ("default_project_id" in env.context && !env.context["subtask_action"] && "project_kanban" in env.context) {
    domain = or([cond("project_ids", "=", env.context["default_project_id"]), domain]);
  }
  return env.model("project.task.type").search(domain);
});
// project_task.py:149-151 `_read_group_personal_stage_type_ids`: the stages of the groups and the user's personal stages
for (const field of ["personal_stage_type_id", "personal_stage_type_ids"]) {
  registerGroupExpand("project.task", field, async (env, _model, values) =>
    env.model("project.task.type").search(or([cond("id", "in", [...values]), cond("user_id", "=", env.uid)])));
}

const idOf = (v: unknown): number | null => (typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : null);

defineComputes("project.task", {
  // project_task.py:376-381 _compute_display_in_project
  display_in_project: async (_env, rec) => {
    const project = idOf(await rec.get("project_id"));
    if (!project) return true;
    const parent = await rec.rel("parent_id");
    if (!parent) return true;
    return project !== idOf(await parent.get("project_id"));
  },
  // mail_tracking_duration_mixin.py:25-57 _compute_duration_tracking (project_task.py:108 `_track_duration_field`),
  // as src/models/crm_lead_write.ts computes it for crm.lead
  duration_tracking: async (env, rec) => {
    const now = await dbNow(env);
    const prev = await rec.prev("duration_tracking");
    const dict: Record<string, unknown> = typeof prev === "object" && prev !== null && !Array.isArray(prev) ? { ...(prev as Record<string, unknown>) } : {};
    const last = dict["s"];
    if (last !== undefined && last !== null && typeof dict["d"] === "string") {
      const old = new Date(`${(dict["d"] as string).replace(" ", "T")}Z`);
      const key = String(last);
      const prevMinutes = typeof dict[key] === "number" ? (dict[key] as number) : 0;
      dict[key] = prevMinutes + Math.trunc((now.getTime() - old.getTime()) / 60000);
    }
    dict["s"] = idOf(await rec.get("stage_id")) ?? 0;
    dict["d"] = datetimeToString(now);
    return dict;
  },
  // sale_project project_task.py:100-104 over project_task.py:1492-1505 _compute_partner_id (stored, readonly=False)
  partner_id: async (_env, rec) => {
    const current = idOf(await rec.prev("partner_id"));
    const parent = await rec.rel("parent_id");
    const project = await rec.rel("project_id");
    const billable = Boolean(await rec.get("allow_billable")) || (rec.origin === null && Boolean(parent && await parent.get("allow_billable")));
    if (!billable) return null;
    if (await rec.get("has_template_ancestor")) return current;
    if (current && !(project || parent)) return null;
    if (current) return current;
    // project_task.py:115-120 _get_default_partner_id: the parent's partner, else the project's
    const fromParent = parent ? idOf(await parent.get("partner_id")) : null;
    if (fromParent) return fromParent;
    return project ? idOf(await project.get("partner_id")) : null;
  },
  // project_task.py:680-683 _compute_partner_phone
  partner_phone: async (_env, rec) => {
    const partner = await rec.rel("partner_id");
    const phone = partner ? await partner.get("phone") : null;
    return typeof phone === "string" && phone ? phone : null;
  },
  // project_task.py:1507-1511 _compute_milestone_id
  milestone_id: async (_env, rec) => {
    const project = idOf(await rec.get("project_id"));
    const milestone = await rec.rel("milestone_id");
    const milestoneProject = milestone ? idOf(await milestone.get("project_id")) : null;
    if (project === milestoneProject) return milestone ? milestone.origin : null;
    const parent = await rec.rel("parent_id");
    if (!parent) return null; // parent.project_id (empty) == project_id only when both are empty: False
    if (idOf(await parent.get("project_id")) !== project) return null;
    return idOf(await parent.get("milestone_id"));
  },
  // sale_project project_task.py:134-151 _compute_sale_line (stored, readonly=False: keeps a set value)
  sale_line_id: async (env, rec) => {
    const parent = await rec.rel("parent_id");
    const billable = Boolean(await rec.get("allow_billable")) || Boolean(parent && await parent.get("allow_billable"));
    if (!billable) return null;
    const current = idOf(await rec.prev("sale_line_id"));
    if (current) return current;
    const commercial = async (p: unknown): Promise<number | null> => {
      const id = idOf(p);
      if (!id) return null;
      return idOf((await env.cr.query<{ c: number | null }>("SELECT commercial_partner_id AS c FROM res_partner WHERE id = $1", [id])).rows[0]?.c ?? null);
    };
    const taskCommercial = await commercial(await rec.get("partner_id"));
    if (parent) {
      const pLine = idOf(await parent.get("sale_line_id"));
      if (pLine && (await commercial(await parent.get("partner_id"))) === taskCommercial) return pLine;
    }
    const milestone = await rec.rel("milestone_id");
    if (milestone) {
      const mLine = idOf(await milestone.get("sale_line_id"));
      if (mLine) return mLine;
    }
    const project = await rec.rel("project_id");
    if (project) {
      const projLine = idOf(await project.get("sale_line_id"));
      if (projLine && (await commercial(await project.get("partner_id"))) === taskCommercial) return projLine;
    }
    return null;
  },
  // sale_project project_task.py:76-98 _compute_sale_order_id
  sale_order_id: async (env, rec) => {
    if (!(await rec.get("allow_billable")) || !idOf(await rec.get("sale_line_id"))) return null;
    const line = await rec.rel("sale_line_id");
    const order = line ? await line.rel("order_id") : null;
    if (!order) throw new NotPorted("project.task sale_order_id from the project's sale order (no order on the sale line)");
    if (!idOf(await rec.get("partner_id"))) throw new NotPorted("project.task sale_order_id setting the task's partner from the order");
    // :90-98 the order is kept when the task's commercial partner is one of the order's partners'
    const commercial = async (p: unknown): Promise<number | null> => {
      const id = idOf(p);
      if (!id) return null;
      return idOf((await env.cr.query<{ c: number | null }>("SELECT commercial_partner_id AS c FROM res_partner WHERE id = $1", [id])).rows[0]?.c ?? null);
    };
    const consistent = new Set<number | null>([await commercial(await order.get("partner_id")), await commercial(await order.get("partner_invoice_id")), await commercial(await order.get("partner_shipping_id"))]);
    const mine = await commercial(await rec.get("partner_id"));
    if (mine !== null && consistent.has(mine)) return order.origin;
    return null;
  },
});

type TaskAction = Record<string, unknown>;
const one = (ids: number[] | null, method: string): number => {
  if (!ids || ids.length !== 1) throw new NotPorted(`project.task.${method} on several tasks (ensure_one)`);
  return ids[0]!;
};
const labelOf = (env: Environment, text: string, module = "project"): string => translate(env, text, module);
async function forXml(env: Environment, xmlid: string): Promise<TaskAction> {
  const { loadAction } = await import("../controllers/action");
  return loadAction({ cursor: () => env.cr, context: env.context, uid: env.uid }, xmlid, env);
}
const taskRow = async (env: Environment, id: number, fields: string[]): Promise<Record<string, unknown>> => {
  const r = (await env.model("project.task").read([id], fields, ""))[0];
  if (!r) throw new NotPorted("task action on a missing task (MissingError)");
  return r;
};
const m2o = (v: unknown): number | false => (typeof v === "number" ? v : Array.isArray(v) ? v[0] as number : false);

// sale_project project_task.py:180-197
registerMethod("project.task", "action_view_so", async (env0, ids, _a, kw) => {
  const { env } = envFor(env0, kw);
  const so = m2o((await taskRow(env, one(ids, "action_view_so"), ["sale_order_id"]))["sale_order_id"]);
  const soIds = so ? [so] : [];
  const action: TaskAction = { type: "ir.actions.act_window", res_model: "sale.order", name: labelOf(env, "Sales Order", "sale_project"),
    views: [[false, "list"], [false, "kanban"], [false, "form"]], context: { create: false, show_sale: true }, domain: [["id", "in", soIds]] };
  if (soIds.length === 1) Object.assign(action, { views: [[false, "form"]], res_id: soIds[0] });
  return action;
}, { apiModel: false });

// project_task.py:1883-1891
registerMethod("project.task", "action_open_parent_task", async (env0, ids, _a, kw) => {
  const { env } = envFor(env0, kw);
  const parent = m2o((await taskRow(env, one(ids, "action_open_parent_task"), ["parent_id"]))["parent_id"]);
  return { name: labelOf(env, "Parent Task"), view_mode: "form", res_model: "project.task", res_id: parent, type: "ir.actions.act_window", context: env.context };
}, { apiModel: false });

// project_task.py:1930-1958
registerMethod("project.task", "action_open_subtasks", async (env0, ids, _a, kw) => {
  const { env } = envFor(env0, kw);
  const id = one(ids, "action_open_subtasks");
  const t = await taskRow(env, id, ["project_id", "user_ids", "milestone_id", "is_template"]);
  const action = await forXml(env, "project.project_task_action_sub_task");
  const parsed = evalExpr(String(action["context"] ?? "{}").split("active_id").join(String(id)), new Map());
  if (!isDict(parsed)) throw new NotPorted("action context that is not a dict");
  action["context"] = { ...Object.fromEntries(dictEntries(parsed).map(([k, v]) => [String(k), v])),
    default_project_id: m2o(t["project_id"]), default_user_ids: t["user_ids"], default_milestone_id: m2o(t["milestone_id"]),
    subtask_action: true, default_is_template: t["is_template"] };
  action["domain"] = [["id", "child_of", id], ["id", "!=", id], ...(t["is_template"] ? [] : [["is_template", "=", false]])];
  if (!t["project_id"]) {
    const listView = await env.reg.xmlid(env.cr, "project.project_task_view_tree_base");
    const kanbanView = await env.reg.xmlid(env.cr, "project.view_task_kanban_no_default_grouping");
    action["views"] = (action["views"] as [unknown, string][]).map(([vid, vtype]) =>
      vtype === "list" ? [listView, "list"] : vtype === "kanban" ? [kanbanView, "kanban"] : [vid, vtype]);
  }
  return action;
}, { apiModel: false });

// project_task.py:1986-1995
registerMethod("project.task", "action_dependent_tasks", async (env0, ids, _a, kw) => {
  const { env } = envFor(env0, kw);
  const id = one(ids, "action_dependent_tasks");
  return { res_model: "project.task", type: "ir.actions.act_window",
    context: { ...env.context, default_depend_on_ids: [[4, id, 0]], show_project_update: false, search_default_open_tasks: true },
    domain: [["depend_on_ids", "=", id]], name: labelOf(env, "Dependent Tasks"), view_mode: "list,form,kanban,calendar,pivot,graph,activity" };
}, { apiModel: false });

// project_task.py:1997-2005
registerMethod("project.task", "action_recurring_tasks", async (env0, ids, _a, kw) => {
  const { env } = envFor(env0, kw);
  const r = m2o((await taskRow(env, one(ids, "action_recurring_tasks"), ["recurrence_id"]))["recurrence_id"]);
  return { name: labelOf(env, "Tasks in Recurrence"), type: "ir.actions.act_window", res_model: "project.task",
    view_mode: "list,form,kanban,calendar,pivot,graph,activity", context: { create: false }, domain: [["recurrence_id", "in", r ? [r] : []]] };
}, { apiModel: false });

// project_task.py:2028-2037
registerMethod("project.task", "action_open_ratings", async (env0, ids, _a, kw) => {
  const { env } = envFor(env0, kw);
  const id = one(ids, "action_open_ratings");
  const action = await forXml(env, "project.rating_rating_action_task");
  const count = await taskRow(env, id, ["rating_count"]);
  if (count["rating_count"] !== 1) return action;
  const ratingIds = await env.sudo().model("rating.rating").search(
    and([cond("res_model", "=", "project.task"), cond("res_id", "=", id)]), { limit: 1 });
  action["view_mode"] = "form";
  action["res_id"] = ratingIds[0] ?? false;
  action["views"] = [[await env.reg.xmlid(env.cr, "project.rating_rating_view_form_project"), "form"]];
  return action;
}, { apiModel: false });

// ------------------------------------------------------------------------------------------------ onchange methods

const m2oId = (v: unknown): number | null => (typeof v === "number" ? v : v instanceof NewRec ? (v.origin ?? null) : null);

/**
 * `task.project_id` as an id: a new project the form has not saved (no origin) is refused, its
 * `_get_default_task_stage` and partner would be the unsaved form's.
 */
async function projectOf(rec: Rec): Promise<number | null> {
  const project = await rec.get("project_id");
  if (project instanceof NewRec && project.origin === null) throw new NotPorted("project.task of a new project");
  return m2oId(project);
}

/**
 * `task.parent_id.project_id` as an id. The parent of a subtask line is the unsaved form record (a new record with
 * the form's values, fields_relational.py:342-343), so its project is the form's, not the database's.
 */
async function parentProjectOf(rec: Rec): Promise<number | null> {
  const parent = await rec.rel("parent_id");
  return parent ? projectOf(parent) : null;
}

/** project_task.py:440-452 `_onchange_project_id`. */
registerOnchange("project.task", "_onchange_project_id", ["project_id"], async (env, rec) => {
  const state = await rec.get("state");
  const originStage = rec.originRec ? m2oId(await rec.originRec.get("stage_id")) : null;
  // project_task.py:85-88 CLOSED_STATES
  if (state !== "04_waiting_normal" && m2oId(await rec.get("stage_id")) !== originStage && state !== "1_done" && state !== "1_canceled") {
    await rec.set("state", "01_in_progress");
  }
  const users = await rec.get("user_ids");
  if (!(await projectOf(rec)) && !(Array.isArray(users) && users.length)) await rec.set("user_ids", [env.uid]);
  const parent = await rec.rel("parent_id");
  if (!(await projectOf(rec)) && parent) {
    const parentProject = await projectOf(parent);
    if (parentProject) {
      await rec.set("project_id", parentProject);
      await rec.set("display_in_project", false);
    }
  }
  const project = await rec.rel("project_id");
  if (rec.origin === null && !parent && project) {
    const partner = m2oId(await project.get("partner_id"));
    if (partner) await rec.set("partner_id", partner);
  }
});

/** project_task.py:690-697 `_onchange_task_company`. */
registerOnchange("project.task", "_onchange_task_company", ["company_id"], async (env, rec) => {
  if (rec.values.get("project_id") instanceof NewRec || rec.values.get("company_id") instanceof NewRec) throw new NotPorted("project.task onchange with a new project or company");
  const company = m2oId(await rec.get("company_id"));
  const project = m2oId(await rec.get("project_id"));
  if (project) {
    const projectCompany = (await env.cr.query<{ c: number | null }>("SELECT company_id AS c FROM project_project WHERE id = $1", [project])).rows[0]?.c ?? null;
    if (projectCompany && projectCompany !== company) await rec.set("project_id", false);
  }
  if (company) {
    const users = await rec.get("user_ids");
    const ids = Array.isArray(users) ? users : [];
    if (ids.some((u) => typeof u !== "number")) throw new NotPorted("project.task company change with new assignees");
    const allowed = new Set((await env.cr.query<{ u: number }>("SELECT user_id AS u FROM res_company_users_rel WHERE cid = $1 AND user_id = ANY($2::int[])", [company, ids])).rows.map((r) => r.u));
    await rec.set("user_ids", ids.filter((u) => allowed.has(u as number)));
  }
});

/** sale_project project_task.py:233-236 `_onchange_partner_id`. */
registerOnchange("project.task", "_onchange_partner_id", ["sale_line_id"], async (env, rec) => {
  const line = m2oId(await rec.get("sale_line_id"));
  if (rec.values.get("sale_line_id") instanceof NewRec) throw new NotPorted("project.task onchange with a new sale line");
  if (m2oId(await rec.get("partner_id")) || rec.values.get("partner_id") instanceof NewRec || !line) return;
  const partner = (await env.cr.query<{ p: number | null }>("SELECT order_partner_id AS p FROM sale_order_line WHERE id = $1", [line])).rows[0]?.p ?? null;
  await rec.set("partner_id", partner ?? false);
});

defineComputes("project.task", {
  // project_task.py:706-717 _compute_stage_id: a stage of the project (or the parent's project) stays, another is
  // replaced by the project's default stage (project_project.py:1151-1157 `_get_default_task_stage`)
  stage_id: async (env, rec) => {
    const own = await projectOf(rec);
    if (!own && (await rec.get("is_template"))) return null;
    const project = own ?? (await parentProjectOf(rec));
    if (!project) return null;
    const stage = m2oId(await rec.prev("stage_id"));
    if (stage && (await env.cr.query("SELECT 1 FROM project_task_type_rel WHERE type_id = $1 AND project_id = $2", [stage, project])).rows.length) return stage;
    const first = (await env.cr.query<{ id: number }>(
      `SELECT t.id FROM project_task_type t JOIN project_task_type_rel r ON r.type_id = t.id
        WHERE r.project_id = $1 AND t.active IS TRUE ORDER BY COALESCE(t.fold, false), t.sequence, t.id LIMIT 1`, [project])).rows[0]?.id ?? null;
    return first;
  },
});
