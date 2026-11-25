/**
 * Recurring meetings: calendar.recurrence (odoo/addons/calendar/models/calendar_recurrence.py) and the recurrence parts
 * of calendar.event (calendar_event.py:629-662 `_compute_recurrence`, :809-968 create, :1000-1120 write, :1186-1210
 * unlink, :1695-1910 the recurrence methods). The rule is src/models/rrule.ts (dateutil), the order in which the
 * occurrences are created is CPython's set of `(start, stop)` ranges (src/models/pyhashset.ts).
 *
 * Refused: invitations and date-change mails to other attendees (the callers in calendar_computes.ts), email alarms
 * (cron triggers), video call channels, events created on a document (activities), all-day recurrences, a time change
 * of all events (`_rewrite_recurrence` with time values), `specific_values_creation`.
 */
import { NotPorted, UserError } from "../errors";
import { and, cond } from "../orm/domain";
import { create } from "../orm/create";
import { registerOverrides, write } from "../orm/write";
import { registerDefaults } from "../orm/recompute";
import { unlink } from "../orm/unlink";
import type { Environment } from "../orm/types";
import { copyDataOnly } from "../web/save";
import { dateToNaive, formatNaive, naiveToUtcDate, parseNaive, utcToLocal, type Naive } from "../web/tz";
import { notifyNextAlarm, setupAlarms } from "./calendar_alarm";
import { rangeSet, type DtRange, type PyHashSet } from "./pyhashset";
import { occurrences, parseRule, rruleString, weekdayOf, type Freq, type RRule } from "./rrule";
import { configParam, defineComputes } from "./tail_util";
import { translate } from "./util";

/** calendar_event.py:2129-2132 `_get_recurrent_fields`. */
export const RECURRENT_FIELDS = ["byday", "until", "rrule_type", "month_by", "event_tz", "rrule", "interval", "count", "end_type",
  "mon", "tue", "wed", "thu", "fri", "sat", "sun", "day", "weekday"] as const;
/** calendar_event.py:2135-2136 `_get_time_fields`. */
export const TIME_FIELDS = ["start", "stop", "start_date", "stop_date"] as const;
/** The dependencies of `_compute_rrule` (calendar_recurrence.py:206-214). */
const RRULE_DEPS = new Set(["byday", "until", "rrule_type", "month_by", "interval", "count", "end_type", "mon", "tue", "wed", "thu", "fri", "sat", "sun", "day", "weekday"]);
/** Index = dateutil weekday (MO = 0). */
const DAY_FIELDS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const WEEKDAY_KEYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
const MAX_RECURRENT_EVENT = 720;
const DAY_MS = 86400000;

export interface RecurrenceRow {
  id: number;
  rrule: string | null;
  rrule_type: string | null;
  end_type: string | null;
  interval: number;
  count: number;
  until: string | null;
  month_by: string | null;
  day: number;
  weekday: string | null;
  byday: string | null;
  event_tz: string | null;
  base_event_id: number | null;
  mon: boolean; tue: boolean; wed: boolean; thu: boolean; fri: boolean; sat: boolean; sun: boolean;
}

export async function readRecurrences(env: Environment, ids: readonly number[]): Promise<RecurrenceRow[]> {
  if (!ids.length) return [];
  const rows = (await env.cr.query<Record<string, unknown>>(
    `SELECT id, rrule, rrule_type, end_type, interval, count, until::text AS until, month_by, day, weekday, byday, event_tz, base_event_id,
            mon, tue, wed, thu, fri, sat, sun FROM calendar_recurrence WHERE id = ANY($1::int[]) ORDER BY id`, [ids])).rows;
  return rows.map((r) => ({
    id: Number(r["id"]), rrule: (r["rrule"] as string | null) ?? null, rrule_type: (r["rrule_type"] as string | null) ?? null,
    end_type: (r["end_type"] as string | null) ?? null, interval: Number(r["interval"] ?? 0), count: Number(r["count"] ?? 0),
    until: (r["until"] as string | null) ?? null, month_by: (r["month_by"] as string | null) ?? null, day: Number(r["day"] ?? 0),
    weekday: (r["weekday"] as string | null) ?? null, byday: (r["byday"] as string | null) ?? null, event_tz: (r["event_tz"] as string | null) ?? null,
    base_event_id: r["base_event_id"] === null || r["base_event_id"] === undefined ? null : Number(r["base_event_id"]),
    mon: r["mon"] === true, tue: r["tue"] === true, wed: r["wed"] === true, thu: r["thu"] === true, fri: r["fri"] === true, sat: r["sat"] === true, sun: r["sun"] === true,
  }));
}

export interface EventRow { id: number; start: string; stop: string; allday: boolean; start_date: string | null; recurrence_id: number | null; active: boolean; user_id: number | null }

export async function readEvents(env: Environment, ids: readonly number[]): Promise<EventRow[]> {
  if (!ids.length) return [];
  const rows = (await env.cr.query<Record<string, unknown>>(
    `SELECT id, to_char(start, 'YYYY-MM-DD HH24:MI:SS') AS start, to_char(stop, 'YYYY-MM-DD HH24:MI:SS') AS stop, allday,
            start_date::text AS start_date, recurrence_id, active, user_id FROM calendar_event WHERE id = ANY($1::int[])`, [ids])).rows;
  const byId = new Map(rows.map((r) => [Number(r["id"]), {
    id: Number(r["id"]), start: String(r["start"]), stop: String(r["stop"]), allday: r["allday"] === true,
    start_date: (r["start_date"] as string | null) ?? null, active: r["active"] === true,
    recurrence_id: r["recurrence_id"] === null ? null : Number(r["recurrence_id"]), user_id: r["user_id"] === null ? null : Number(r["user_id"]),
  }]));
  return ids.map((id) => byId.get(id)).filter((e): e is EventRow => e !== undefined);
}

/** The active events of a recurrence (`calendar_event_ids`, active_test), in the field's order (`start desc`, then id). */
export async function recurrenceEvents(env: Environment, recurrence: number): Promise<number[]> {
  return (await env.cr.query<{ id: number }>(
    "SELECT id FROM calendar_event WHERE recurrence_id = $1 AND active ORDER BY start DESC, id", [recurrence])).rows.map((r) => Number(r.id));
}

function naive(v: string): Naive {
  const n = parseNaive(v);
  if (n === null) throw new NotPorted(`calendar datetime ${v}`);
  return n;
}

function plusMs(n: Naive, ms: number): Naive {
  return dateToNaive(new Date(naiveToUtcDate(n).getTime() + ms));
}

function dateOf(n: Naive): string {
  return formatNaive(n, false);
}

// ---------------------------------------------------------------------------------------------------------------
// time zones: zoneinfo's fold semantics
// ---------------------------------------------------------------------------------------------------------------

function offsetMinutesAt(utcMs: number, tz: string): number {
  return Math.round((naiveToUtcDate(utcToLocal(new Date(utcMs), tz)).getTime() - utcMs) / 60000);
}

/** `wall.replace(tzinfo=ZoneInfo(tz), fold=0|1).utcoffset()` in minutes (PEP 495: in a gap fold 0 is the offset before
 *  the transition, in an overlap fold 0 is the earlier instant). */
function wallOffsets(wall: Naive, tz: string): { fold0: number; fold1: number } {
  const asUtc = naiveToUtcDate(wall).getTime();
  const before = offsetMinutesAt(asUtc - DAY_MS, tz), after = offsetMinutesAt(asUtc + DAY_MS, tz);
  const valid = [...new Set([before, after])].filter((o) => offsetMinutesAt(asUtc - o * 60000, tz) === o);
  if (valid.length === 2) return { fold0: Math.max(...valid), fold1: Math.min(...valid) };
  if (valid.length === 1) return { fold0: valid[0]!, fold1: valid[0]! };
  return { fold0: before, fold1: after };
}

/** `dt.replace(tzinfo=ZoneInfo(tz), fold=1).dst()` as minutes: the offset above the zone's standard offset of the year. */
function dstMinutes(wall: Naive, tz: string): number {
  const std = Math.min(offsetMinutesAt(Date.UTC(wall.year, 0, 15), tz), offsetMinutesAt(Date.UTC(wall.year, 6, 15), tz));
  return wallOffsets(wall, tz).fold1 - std;
}

function utcToWall(utc: Naive, tz: string): Naive {
  return utcToLocal(naiveToUtcDate(utc), tz);
}

/** calendar_recurrence.py:552-558: the smaller offset of the two folds (pytz's `is_dst=False`), then UTC. */
function wallToUtc(wall: Naive, tz: string): Naive {
  const { fold0, fold1 } = wallOffsets(wall, tz);
  return plusMs(wall, -Math.min(fold0, fold1) * 60000);
}

// ---------------------------------------------------------------------------------------------------------------
// calendar.recurrence: the rule, its name, the inverse
// ---------------------------------------------------------------------------------------------------------------

async function userLangWeekStart(env: Environment): Promise<number> {
  // calendar_recurrence.py:444-447 `_get_lang_week_start`: the user's language (not the context's)
  const row = (await env.cr.query<{ w: string | null }>(
    `SELECT l.week_start AS w FROM res_users u JOIN res_partner p ON p.id = u.partner_id LEFT JOIN res_lang l ON l.code = p.lang WHERE u.id = $1`, [env.uid])).rows[0];
  if (!row?.w) throw new NotPorted("calendar recurrence of a user without a language");
  return Number(row.w) - 1;
}

function recurrenceTz(env: Environment, r: Pick<RecurrenceRow, "event_tz">): string {
  // :513-514 `_get_timezone`
  const ctx = env.context["tz"];
  return r.event_tz || (typeof ctx === "string" && ctx ? ctx : "UTC");
}

/** calendar_recurrence.py:592-636 `_get_rrule`. */
async function ruleOf(env: Environment, r: RecurrenceRow, dtstart: Naive): Promise<RRule> {
  const freq = r.rrule_type as Freq;
  if (!["daily", "weekly", "monthly", "yearly"].includes(freq)) throw new NotPorted(`calendar recurrence of type ${String(r.rrule_type)}`);
  const rule: RRule = { freq, dtstart, interval: r.interval, wkst: null, count: null, until: null, byweekday: null, bynweekday: null, bymonthday: null };
  const weekdays = DAY_FIELDS.map((f, i) => (r[f] ? i : -1)).filter((i) => i >= 0);
  if (freq === "monthly" && r.month_by === "date") rule.bymonthday = r.day;
  else if (freq === "monthly" && r.month_by === "day") {
    const wd = WEEKDAY_KEYS.indexOf((r.weekday ?? "") as (typeof WEEKDAY_KEYS)[number]);
    if (wd < 0 || !r.byday) throw new NotPorted("a monthly recurrence by day without weekday or position (KeyError)");
    rule.bynweekday = [wd, Number(r.byday)];
  } else if (freq === "weekly") {
    if (!weekdays.length) throw new UserError(translate(env, "You have to choose at least one day in the week"));
    rule.byweekday = weekdays;
    rule.wkst = await userLangWeekStart(env);
  }
  // ir_config_parameter.py:108-113 get_int, default 15
  const limitParam = await configParam(env.sudo(), "calendar.max_recurrence_years");
  const limitYears = limitParam !== null && /^\s*[-+]?\d+\s*$/.test(limitParam) ? parseInt(limitParam, 10) : 15;
  if (r.end_type === "count") rule.count = Math.min(r.count, MAX_RECURRENT_EVENT);
  else if (r.end_type === "forever") {
    if (freq === "yearly") rule.count = Math.min(limitYears, MAX_RECURRENT_EVENT);
    else if (freq === "monthly") rule.count = Math.min(limitYears * 12, MAX_RECURRENT_EVENT);
    else if (freq === "weekly") rule.count = Math.min(Math.floor(Math.floor(limitYears * 365 / 7) * weekdays.length / Math.max(r.interval, 1)), MAX_RECURRENT_EVENT);
    else rule.count = Math.min(Math.floor(limitYears * 365 / Math.max(r.interval, 1)), MAX_RECURRENT_EVENT);
  } else if (r.end_type === "end_date") {
    if (!r.until) throw new NotPorted("a recurrence ending on a date without a date (TypeError)");
    const u = naive(r.until);
    rule.until = { year: u.year, month: u.month, day: u.day };
  } else throw new NotPorted(`calendar recurrence end type ${String(r.end_type)}`);
  return rule;
}

/** calendar_recurrence.py:316-327 `_rrule_serialize`: `str(rrule)` with dateutil's DTSTART of `datetime.now()`. */
async function serializeRule(env: Environment, r: RecurrenceRow): Promise<string> {
  if (r.interval <= 0) throw new UserError(translate(env, "The interval cannot be negative."));
  if (r.end_type === "count" && r.count <= 0) throw new UserError(translate(env, "The number of repetitions cannot be negative."));
  if (!r.rrule_type) return "";
  const now = (await env.cr.query<{ n: string }>("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS n")).rows[0]!.n;
  return rruleString(await ruleOf(env, r, naive(now)));
}

async function selectionLabel(env: Environment, field: string, value: string | null): Promise<string> {
  const sel = (await env.model("calendar.recurrence").fieldsGet([field], ["selection"]))[field]?.["selection"];
  const hit = Array.isArray(sel) ? sel.find((s) => Array.isArray(s) && s[0] === value) : undefined;
  if (!Array.isArray(hit)) throw new NotPorted(`calendar.recurrence.${field} label of ${String(value)} (KeyError)`);
  return String(hit[1]);
}

/** calendar_recurrence.py:136-196 `get_recurrence_name`. */
export async function recurrenceName(env: Environment, r: RecurrenceRow): Promise<string | false> {
  const fill = (text: string, args: Record<string, string | number>): string =>
    translate(env, text).replace(/%\((\w+)\)s/g, (_m, k: string) => String(args[k]));
  const until = r.until ?? "False";
  const kind = (count: string, untilText: string, plain: string, args: Record<string, string | number>): string =>
    r.end_type === "count" ? fill(count, { ...args, count: r.count }) : r.end_type === "end_date" ? fill(untilText, { ...args, until }) : fill(plain, args);
  switch (r.rrule_type) {
    case "daily":
      return kind("Every %(interval)s Days for %(count)s events", "Every %(interval)s Days until %(until)s", "Every %(interval)s Days", { interval: r.interval });
    case "weekly": {
      const labels: string[] = [];
      for (const [i, f] of DAY_FIELDS.entries()) if (r[f]) labels.push(await selectionLabel(env, "weekday", WEEKDAY_KEYS[i]!));
      return kind("Every %(interval)s Weeks on %(days)s for %(count)s events", "Every %(interval)s Weeks on %(days)s until %(until)s",
        "Every %(interval)s Weeks on %(days)s", { interval: r.interval, days: labels.join(", ") });
    }
    case "monthly":
      if (r.month_by === "day") {
        const args = { interval: r.interval, position: await selectionLabel(env, "byday", r.byday), weekday: await selectionLabel(env, "weekday", r.weekday) };
        return kind("Every %(interval)s Months on the %(position)s %(weekday)s for %(count)s events",
          "Every %(interval)s Months on the %(position)s %(weekday)s until %(until)s", "Every %(interval)s Months on the %(position)s %(weekday)s", args);
      }
      return kind("Every %(interval)s Months day %(day)s for %(count)s events", "Every %(interval)s Months day %(day)s until %(until)s",
        "Every %(interval)s Months day %(day)s", { interval: r.interval, day: r.day });
    case "yearly":
      return kind("Every %(interval)s Years for %(count)s events", "Every %(interval)s Years until %(until)s", "Every %(interval)s Years", { interval: r.interval });
    default:
      return false;
  }
}

/** calendar_recurrence.py:384-438 `_rrule_parse` of the rule the recurrence just wrote. */
function parsedValues(text: string): Partial<RecurrenceRow> {
  const rule = parseRule(text);
  const data: Record<string, unknown> = { rrule_type: rule.freq, count: rule.count ?? 0, interval: rule.interval,
    until: rule.until ? formatNaive({ ...rule.until }, false) : null };
  if (rule.byweekday) {
    for (const f of DAY_FIELDS) data[f] = false;
    for (const wd of rule.byweekday) data[DAY_FIELDS[wd]!] = true;
    data["rrule_type"] = "weekly";
  }
  if (rule.bynweekday) {
    const [wd, n] = rule.bynweekday[0]!;
    data["weekday"] = WEEKDAY_KEYS[wd];
    data["byday"] = String(n);
    data["month_by"] = "day";
    data["rrule_type"] = "monthly";
  }
  if (rule.bymonthday && data["rrule_type"] === "monthly") {
    data["day"] = rule.bymonthday[0];
    data["month_by"] = "date";
  }
  data["end_type"] = data["until"] ? "end_date" : data["count"] ? "count" : "forever";
  return data as Partial<RecurrenceRow>;
}

const SYNC_KEY = "__calendar_rrule_sync";

/**
 * `_compute_rrule` (:206-214), which writes the serialized rule when it differs, `_inverse_rrule` (:216-220) on that
 * write (the parsed rule written back with dont_notify) and `_compute_name` (:198-201) after both: the values end as
 * the parsed rule says (a forever rule becomes its count, a rule until a date has count 0).
 */
async function syncRules(env: Environment, ids: readonly number[]): Promise<void> {
  for (const r of await readRecurrences(env, ids)) {
    const rule = await serializeRule(env, r);
    if (rule === r.rrule) continue;
    let after: RecurrenceRow = r;
    const vals: Record<string, unknown> = {};
    if (rule) {
      const parsed = parsedValues(rule);
      after = { ...r, ...parsed };
      Object.assign(vals, parsed);
    }
    vals["rrule"] = after.rrule_type ? await serializeRule(env, after) : rule;
    vals["name"] = await recurrenceName(env, after);
    await write(env.withContext({ ...env.context, dont_notify: true, [SYNC_KEY]: true }), "calendar.recurrence", [r.id], vals);
  }
}

defineComputes("calendar.recurrence", {
  // the stored rule and name are written by syncRules after each create and write of their dependencies (the
  // compute that writes itself, its inverse, then the name): the ORM's own recompute keeps the value
  rrule: async (_env, rec) => rec.prev("rrule"),
  name: async (_env, rec) => rec.prev("name"),
  // :202-206 `_compute_dtstart`: the first start among the recurrence's events the user reads (active ones)
  dtstart: async (env, rec) => {
    if (rec.id === null) return false;
    const ids = await env.model("calendar.event").search(cond("recurrence_id", "in", [rec.id]));
    if (!ids.length) return false;
    return (await env.cr.query<{ s: string }>("SELECT to_char(min(start), 'YYYY-MM-DD HH24:MI:SS') AS s FROM calendar_event WHERE id = ANY($1::int[])", [ids])).rows[0]?.s ?? false;
  },
});

registerOverrides("calendar.recurrence", {
  // `_inverse_rrule` (:216-220): syncRules writes the parsed values with the rule itself
  inverse: { rrule: async () => {} },
  create: async (env, valsList, next) => {
    for (const vals of valsList) if ("rrule" in vals && vals["rrule"]) throw new NotPorted("calendar.recurrence created with a rule string (_inverse_rrule of a given rule)");
    const ids = await next(env, valsList);
    await syncRules(env, ids);
    return ids;
  },
  write: async (env, ids, vals, next) => {
    if (env.context[SYNC_KEY]) {
      const { [SYNC_KEY]: _drop, ...ctx } = env.context;
      return next(env.withContext(ctx), ids, vals);
    }
    if ("rrule" in vals) throw new NotPorted("calendar.recurrence.rrule written (_inverse_rrule of a given rule)");
    await next(env, ids, vals);
    if (Object.keys(vals).some((k) => RRULE_DEPS.has(k))) await syncRules(env, ids);
  },
});

// ---------------------------------------------------------------------------------------------------------------
// occurrences
// ---------------------------------------------------------------------------------------------------------------

/** calendar_recurrence.py:449-469 `_get_start_of_period` of a datetime (naive UTC, read as the zone's wall clock). */
async function startOfPeriod(env: Environment, r: RecurrenceRow, dt: Naive): Promise<Naive> {
  let start = dt;
  if (r.rrule_type === "weekly") {
    const ws = await userLangWeekStart(env);
    const back = (weekdayOf(dt.year, dt.month, dt.day) - ws + 7) % 7;
    start = plusMs(dt, -back * DAY_MS);
  } else if (r.rrule_type === "monthly") {
    start = { ...dt, day: 1 };
  }
  const tz = recurrenceTz(env, r);
  if (dstMinutes(dt, tz) !== dstMinutes(start, tz)) start = dt;
  return start;
}

/** :525-530 `_is_allday`: a majority of all-day events (ties included). */
async function isAllday(env: Environment, recurrence: number): Promise<boolean> {
  const rows = (await env.cr.query<{ a: boolean }>("SELECT allday AS a FROM calendar_event WHERE recurrence_id = $1 AND active", [recurrence])).rows;
  return rows.reduce((s, x) => s + (x.a ? 1 : -1), 0) >= 0;
}

/** calendar_recurrence.py:519-558 `_get_occurrences` (naive UTC datetimes). */
async function getOccurrences(env: Environment, r: RecurrenceRow, dtstart: Naive): Promise<Naive[]> {
  const start = await startOfPeriod(env, r, dtstart);
  if (await isAllday(env, r.id)) throw new NotPorted("an all-day recurrence");
  const tz = recurrenceTz(env, r);
  return occurrences(await ruleOf(env, r, utcToWall(start, tz))).map((o) => wallToUtc(o, tz));
}

/** :482-503 `_range_calculation`. */
async function rangeCalculation(env: Environment, r: RecurrenceRow, start: Naive, durationMs: number): Promise<PyHashSet<DtRange>> {
  const ranges = async (row: RecurrenceRow): Promise<PyHashSet<DtRange>> => {
    const s = rangeSet();
    for (const o of await getOccurrences(env, row, start)) s.add([o, plusMs(o, durationMs)]);
    return s;
  };
  const startDate = dateOf(start);
  const inFuture = (x: DtRange): boolean => dateOf(x[0]) >= startDate && dateOf(x[1]) >= startDate;
  const originalCount = r.end_type === "count" ? r.count : 0;
  let all = await ranges(r);
  const future = [...all].filter(inFuture).length;
  if (originalCount && future < originalCount) {
    // the count raised for the dismissed past values, then set back (the same rule in the end)
    all = await ranges({ ...r, count: 2 * originalCount - future });
  }
  const kept = rangeSet();
  for (const x of all) if (inFuture(x)) kept.add(x);
  return kept;
}

/** :471-480 `_get_outliers` of one recurrence: its events whose start the rule from the first start does not give. */
async function outliers(env: Environment, r: RecurrenceRow, events: readonly EventRow[]): Promise<Set<number>> {
  if (!events.length) return new Set();
  const first = events.map((e) => e.start).sort()[0]!;
  const starts = new Set((await getOccurrences(env, r, naive(first))).map((o) => formatNaive(o, true)));
  return new Set(events.filter((e) => !starts.has(e.start)).map((e) => e.id));
}

/** :236-241 `_select_new_base_event` with :463-469 `_get_first_event(include_outliers=False)`. */
async function selectNewBaseEvent(env: Environment, recurrences: readonly number[]): Promise<void> {
  for (const r of await readRecurrences(env, recurrences)) {
    const events = (await readEvents(env, await recurrenceEvents(env, r.id))).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    const out = await outliers(env, r, events);
    const first = events.find((e) => !out.has(e.id));
    await write(env, "calendar.recurrence", [r.id], { base_event_id: first?.id ?? false });
  }
}

/** :316-321 `_detach_events`. */
async function detachEvents(env: Environment, ids: readonly number[]): Promise<void> {
  if (ids.length) await write(env.withContext({ ...env.context, dont_notify: true }), "calendar.event", ids, { recurrence_id: false, recurrency: true });
}

/** tools/misc.py clean_context: without the `default_*` keys. */
function cleanContext(env: Environment): Record<string, unknown> {
  return Object.fromEntries(Object.entries(env.context).filter(([k]) => !k.startsWith("default_")));
}

/** :243-283 `_apply_recurrence`: the missing occurrences created, the events off the rule detached (returned). */
async function applyRecurrence(env: Environment, recurrences: readonly number[]): Promise<number[]> {
  const eventVals: Record<string, unknown>[] = [];
  const keep = new Set<number>();
  for (const r of await readRecurrences(env, recurrences)) {
    if (r.base_event_id === null) continue;
    // `recurrence.calendar_event_ids |= recurrence.base_event_id`
    const [base] = await readEvents(env, [r.base_event_id]);
    if (!base) throw new NotPorted("a recurrence whose base event is gone");
    if (base.recurrence_id !== r.id) await write(env, "calendar.event", [base.id], { recurrence_id: r.id });
    if (base.allday) throw new NotPorted("an all-day recurrence");
    const start = naive(base.start), stop = naive(base.stop);
    const duration = naiveToUtcDate(stop).getTime() - naiveToUtcDate(start).getTime();
    // :221-233 `_reconcile_events`: `set(ranges)`, the events already on a range kept, the others' ranges in set order
    const ranges = (await rangeCalculation(env, r, start, duration)).copy();
    const events = await readEvents(env, await recurrenceEvents(env, r.id));
    const existing = new Set<string>();
    for (const e of events) {
      if (ranges.has([naive(e.start), naive(e.stop)])) { keep.add(e.id); existing.add(`${e.start}|${e.stop}`); }
    }
    const [baseValues] = await copyDataOnly(env, "calendar.event", [base.id], {});
    for (const [s, e] of ranges) {
      const key = `${formatNaive(s, true)}|${formatNaive(e, true)}`;
      if (existing.has(key)) continue;
      eventVals.push({ ...baseValues, start: formatNaive(s, true), stop: formatNaive(e, true), recurrence_id: r.id, follow_recurrence: true });
    }
  }
  const all: number[] = [];
  for (const id of recurrences) all.push(...await recurrenceEvents(env, id));
  const detached = all.filter((id) => !keep.has(id));
  await detachEvents(env, detached);
  if (eventVals.length) {
    await create(env.withContext({ ...cleanContext(env), no_mail_to_attendees: true, mail_create_nolog: true }), "calendar.event", eventVals);
  }
  return detached;
}

/** calendar_recurrence.py:285-314 `_setup_alarms` (the triggers are the email alarms', which refuse). */
export async function setupRecurrenceAlarms(env: Environment, recurrences: readonly number[]): Promise<void> {
  const ids: number[] = [];
  for (const r of recurrences) ids.push(...await recurrenceEvents(env, r));
  if (!ids.length) return;
  const now = typeof env.context["date"] === "string" ? env.context["date"]
    : (await env.cr.query<{ n: string }>("SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS n")).rows[0]!.n;
  const next = (await env.cr.query<{ event_id: number }>(
    `SELECT DISTINCT ON (recurrence_id) id AS event_id, recurrence_id FROM calendar_event WHERE start > $1 AND id = ANY($2::int[])
      ORDER BY recurrence_id, start ASC`, [now, ids])).rows.map((r) => Number(r.event_id));
  if (next.length) await setupAlarms(env, next);
}

/** calendar_event.py:1720-1741 `_get_recurrence_params_by_date`, with :80-92 `get_weekday_occurence`. */
export function recurrenceParamsByDate(date: string): Record<string, unknown> {
  const d = naive(date);
  const wd = weekdayOf(d.year, d.month, d.day);
  const occ = Math.ceil(d.day / 7);
  return { [DAY_FIELDS[wd]!]: true, weekday: WEEKDAY_KEYS[wd], byday: String(occ === 4 || occ === 5 ? -1 : occ), day: d.day };
}

/** calendar_event.py:1886-1898 `_get_start_date` of a recurring event with a zone. */
function startDateOf(e: Pick<EventRow, "start" | "allday">, eventTz: string | null): string {
  if (!eventTz) return e.start.slice(0, 10);
  const s = naive(e.start);
  return dateOf(utcToWall(e.allday ? { ...s, hour: 12 } : s, eventTz));
}

/** calendar_recurrence.py:102-104: `self.env.context.get('tz') or self.env.user.tz`. */
async function defaultEventTz(env: Environment): Promise<string | false> {
  const ctxTz = env.context["tz"];
  if (typeof ctxTz === "string" && ctxTz) return ctxTz;
  return (await env.cr.query<{ tz: string | null }>("SELECT p.tz FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1", [env.uid])).rows[0]?.tz || false;
}

registerDefaults("calendar.recurrence", { event_tz: defaultEventTz });

/** `calendar.recurrence` default_get of the recurrent fields (calendar_recurrence.py:101-125). */
export async function recurrenceDefaults(env: Environment): Promise<Record<string, unknown>> {
  return { event_tz: await defaultEventTz(env), rrule_type: "weekly", end_type: "forever", interval: 1, count: 1, month_by: "date", day: 1 };
}

/** calendar_event.py:640-662 `_compute_recurrence` of a recurring event: every recurrent field. */
export async function eventRecurrenceValues(env: Environment, event: { start: string | null; allday: boolean; recurrence_id: number | null }): Promise<Record<string, unknown>> {
  const defaults = await recurrenceDefaults(env);
  const falseValues = Object.fromEntries(RECURRENT_FIELDS.map((f) => [f, false]));
  const [r] = event.recurrence_id === null ? [] : await readRecurrences(env, [event.recurrence_id]);
  // `event.update(defaults)` comes before `_get_recurrence_params`, so the start date is in the default zone
  const today = (await env.cr.query<{ d: string }>("SELECT (now() AT TIME ZONE 'UTC')::date::text AS d")).rows[0]!.d;
  const eventValues = recurrenceParamsByDate(event.start ? startDateOf({ start: event.start, allday: event.allday }, (defaults["event_tz"] as string) || null) : today);
  let rruleValues: Record<string, unknown> = {};
  if (r) for (const f of RECURRENT_FIELDS) { const v = r[f as keyof RecurrenceRow]; if (v !== null && v !== false && v !== 0 && v !== "") rruleValues[f] = v; }
  if (!Object.keys(rruleValues).length) rruleValues = { ...defaults };
  // rrule_type_ui is the recurrence's type (interval 1) or 'custom', whose current_rrule reads the protected field: False
  const current = r ? (r.interval !== 1 ? false : r.rrule_type) : defaults["rrule_type"];
  rruleValues["rrule_type"] = current || rruleValues["rrule_type"] || defaults["rrule_type"];
  return { ...falseValues, ...defaults, ...eventValues, ...rruleValues };
}

/** calendar_event.py:630-638 `_compute_rrule_type_ui` of a recurring event. */
export async function eventRruleTypeUi(env: Environment, recurrence: number | null): Promise<string> {
  const [r] = recurrence === null ? [] : await readRecurrences(env, [recurrence]);
  if (!r) return "weekly";
  return r.interval !== 1 ? "custom" : String(r.rrule_type);
}

// ---------------------------------------------------------------------------------------------------------------
// calendar.event: applying, splitting and breaking recurrences
// ---------------------------------------------------------------------------------------------------------------

/** calendar_event.py:1695-1718 `_apply_recurrence_values`: the detached events. */
export async function applyRecurrenceValues(env: Environment, eventIds: readonly number[], values: Record<string, unknown>, future = true): Promise<number[]> {
  if (!Object.keys(values).length) return [];
  const recurrenceVals: Record<string, unknown>[] = [];
  const toUpdate: number[] = [];
  for (const e of await readEvents(env, eventIds)) {
    if (e.recurrence_id === null) recurrenceVals.push({ ...values, base_event_id: e.id, calendar_event_ids: [[4, e.id]] });
    else if (future) {
      const split = await splitFrom(env, e.recurrence_id, e, values);
      if (split !== null) toUpdate.push(split);
    }
  }
  await write(env, "calendar.event", eventIds, { recurrency: true, follow_recurrence: true });
  if (recurrenceVals.length) toUpdate.push(...await create(env, "calendar.recurrence", recurrenceVals));
  return applyRecurrence(env, toUpdate);
}

/** calendar_recurrence.py:322-340 `_stop_at`: the event and the following ones detached (returned). */
async function stopAt(env: Environment, recurrence: number, event: EventRow): Promise<number[]> {
  const ids = await recurrenceEvents(env, recurrence);
  const events = ids.length ? await env.model("calendar.event").search(and([cond("id", "in", ids), cond("start", ">=", event.start)])) : [];
  await detachEvents(env, events);
  if (!(await recurrenceEvents(env, recurrence)).length) {
    await unlink(env.withContext({ ...env.context, archive_on_error: true }), "calendar.recurrence", [recurrence]);
    return events;
  }
  const [r] = await readRecurrences(env, [recurrence]);
  if (event.allday) throw new NotPorted("an all-day recurrence stopped");
  const start = await startOfPeriod(env, r!, naive(event.start));
  const untilWall = utcToWall(start, recurrenceTz(env, r!));
  const until = dateOf(plusMs({ ...untilWall, hour: 0, minute: 0, second: 0 }, -DAY_MS));
  await write(env, "calendar.recurrence", [recurrence], { end_type: "end_date", until });
  return events;
}

/** calendar_recurrence.py:300-320 `_split_from`: a new recurrence from the event on (its id, or null). */
async function splitFrom(env: Environment, recurrence: number, event: EventRow, recurrenceValues: Record<string, unknown>): Promise<number | null> {
  const [values] = await copyDataOnly(env, "calendar.recurrence", [recurrence], {});
  const detached = await stopAt(env, recurrence, event);
  const count = Number(recurrenceValues["count"] ?? 0) || detached.length;
  const [id] = await create(env, "calendar.recurrence", [{ ...values, ...recurrenceValues, base_event_id: event.id, calendar_event_ids: [[6, 0, detached]], count: Math.max(count, 1) }]);
  return id ?? null;
}

/** calendar_event.py:1743-1762 `_break_recurrence`: the detached events other than the given ones. */
export async function breakRecurrence(env: Environment, eventIds: readonly number[], future: boolean): Promise<number[]> {
  const toUnlink: number[] = [];
  const detached = new Set<number>();
  for (const e of await readEvents(env, eventIds)) {
    if (e.recurrence_id === null) continue;
    if (future) for (const id of await stopAt(env, e.recurrence_id, e)) detached.add(id);
    else {
      const ids = await recurrenceEvents(env, e.recurrence_id);
      for (const id of ids) detached.add(id);
      if (ids.length) await write(env, "calendar.event", ids, { recurrence_id: false });
      toUnlink.push(e.recurrence_id);
    }
  }
  if (toUnlink.length) await unlink(env.withContext({ ...env.context, archive_on_error: true }), "calendar.recurrence", [...new Set(toUnlink)]);
  return [...detached].filter((id) => !eventIds.includes(id));
}

/** calendar_event.py:1764-1791 `_get_time_update_dict` (naive UTC strings and dates). */
function timeUpdateDict(base: EventRow, self: EventRow, timeValues: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const ms = (v: string): number => naiveToUtcDate(naive(v)).getTime();
  const shift = (v: string, delta: number): string => formatNaive(plusMs(naive(v), delta), true);
  const shiftDate = (v: string, days: number): string => dateOf(plusMs(naive(v.slice(0, 10)), days * DAY_MS));
  const dayDelta = (a: string, b: string): number => Math.round((ms(a.slice(0, 10)) - ms(b.slice(0, 10))) / DAY_MS);
  const startUpdate = typeof timeValues["start"] === "string" ? timeValues["start"] : null;
  const stopUpdate = typeof timeValues["stop"] === "string" ? timeValues["stop"] : null;
  if (startUpdate) {
    const d = ms(startUpdate) - ms(self.start), days = dayDelta(startUpdate, self.start);
    Object.assign(out, { start: shift(base.start, d), start_date: shiftDate(base.start, days), stop: shift(base.stop, d), stop_date: shiftDate(base.stop, days) });
  }
  if (stopUpdate) {
    if (!startUpdate) {
      const d = ms(stopUpdate) - ms(self.stop), days = dayDelta(stopUpdate, self.stop);
      Object.assign(out, { start: shift(base.start, d), start_date: shiftDate(base.start, days) });
    }
    const d = ms(stopUpdate) - ms(self.stop), days = dayDelta(stopUpdate, self.stop);
    Object.assign(out, { stop: shift(base.stop, d), stop_date: shiftDate(base.stop, days) });
  }
  return out;
}

/** calendar_event.py:1878-1884 `_reset_attendees_status`. */
async function resetAttendeesStatus(env: Environment, eventId: number): Promise<void> {
  const self = (await env.cr.query<{ p: number }>("SELECT partner_id AS p FROM res_users WHERE id = $1", [env.uid])).rows[0]?.p;
  const rows = (await env.cr.query<{ id: number; partner_id: number }>("SELECT id, partner_id FROM calendar_attendee WHERE event_id = $1 ORDER BY id", [eventId])).rows;
  for (const a of rows) await write(env, "calendar.attendee", [Number(a.id)], { state: Number(a.partner_id) === self ? "accepted" : "needsAction" });
}

/** calendar_event.py:1814-1853 `_update_future_events` (this event and the following ones). */
export async function updateFutureEvents(env: Environment, self: EventRow, values: Record<string, unknown>, timeValues0: Record<string, unknown>,
  recurrenceValues: Record<string, unknown>): Promise<void> {
  if (self.recurrence_id === null) throw new NotPorted("future events of an event without recurrence");
  const timeValues = { ...timeValues0, ...timeUpdateDict(self, self, timeValues0) };
  const startDate = typeof timeValues["start"] === "string" ? timeValues["start"].slice(0, 10) : self.start.slice(0, 10);
  // :1806-1811 `_get_updated_recurrence_values`
  const [previous] = await copyDataOnly(env, "calendar.recurrence", [self.recurrence_id], {});
  const s = naive(self.start), n = naive(startDate);
  if (weekdayOf(s.year, s.month, s.day) !== weekdayOf(n.year, n.month, n.day)) delete previous![DAY_FIELDS[weekdayOf(s.year, s.month, s.day)]!];
  const detached = await stopAt(env, self.recurrence_id, self);
  const others = detached.filter((id) => id !== self.id);
  if (others.length) await write(env, "calendar.event", others, { active: false });
  if (Object.keys(values).length || Object.keys(timeValues).length) {
    await write(env, "calendar.event", [self.id], { ...timeValues, ...values });
    if (Object.keys(timeValues).length) await resetAttendeesStatus(env, self.id);
  }
  const newValues: Record<string, unknown> = { ...previous, ...recurrenceParamsByDate(startDate), ...recurrenceValues,
    count: Number(recurrenceValues["count"] ?? 0) || detached.length };
  delete newValues["rrule"];
  await applyRecurrenceValues(env, [self.id], newValues);
}

/** calendar_event.py:1855-1898 `_rewrite_recurrence` without time or recurrence values: `_write_events` (:342-349). */
export async function rewriteRecurrence(env: Environment, self: EventRow, values: Record<string, unknown>, timeValues: Record<string, unknown>,
  recurrenceValues: Record<string, unknown>): Promise<void> {
  if (self.recurrence_id === null) throw new NotPorted("all events of an event without recurrence");
  if (Object.keys(timeValues).length || Object.keys(recurrenceValues).length) {
    throw new NotPorted("a time or rule change of all the events of a recurrence (_rewrite_recurrence: archive and recreate)");
  }
  const events = await recurrenceEvents(env, self.recurrence_id);
  if (events.length) {
    await write(env.withContext({ ...env.context, no_mail_to_attendees: true, dont_notify: true }), "calendar.event", events, { ...values, recurrence_update: "self_only" });
  }
}

/** The recurrences whose base event is one of `ids` (`calendar.recurrence.search([('base_event_id', 'in', ids)])`). */
export async function recurrencesOfBase(env: Environment, ids: readonly number[]): Promise<number[]> {
  return env.model("calendar.recurrence").search(cond("base_event_id", "in", [...ids]));
}

export { selectNewBaseEvent };

/** calendar_event.py:1186-1210 unlink: the recurrences of a deleted base event take a new one, the attendees with an
 *  alarm on the deleted events get their next alarm. */
registerOverrides("calendar.event", {
  unlink: async (env, ids, next) => {
    if (!ids.length) return next(env, ids);
    const videocall = (await env.cr.query("SELECT 1 FROM calendar_event WHERE id = ANY($1::int[]) AND videocall_channel_id IS NOT NULL LIMIT 1", [ids])).rows;
    if (videocall.length) throw new NotPorted("calendar.event unlink with a video call channel (_unlink_orphan_meeting_channels)");
    const withAlarms = await env.model("calendar.event").search(and([cond("id", "in", [...ids]), cond("alarm_ids", "!=", false)]));
    const partners = withAlarms.length ? (await env.cr.query<{ p: number }>(
      "SELECT DISTINCT res_partner_id AS p FROM calendar_event_res_partner_rel WHERE calendar_event_id = ANY($1::int[]) ORDER BY 1", [withAlarms])).rows.map((r) => Number(r.p)) : [];
    const recurrences = await recurrencesOfBase(env, ids);
    await next(env, ids);
    if (recurrences.length) await selectNewBaseEvent(env, recurrences);
    if (partners.length) await notifyNextAlarm(env, partners);
  },
});

