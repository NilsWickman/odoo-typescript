/**
 * `resource.calendar` creation (odoo/addons/resource/models/resource_calendar.py) as a new company gets it
 * (res_company.py:31-47 `_create_resource_calendar`): the stored computes of the calendar (:171-249) and of its
 * attendances (resource_calendar_attendance.py:297-360).
 *
 * `_compute_attendance_ids` (:181-186) and `_compute_global_leave_ids` (:188-194) are x2many computes on the new
 * record; they are applied here as the values Odoo assigns, given before the INSERT: the default 40 hours/week
 * (`_get_default_attendance_ids`, :686-694) and no global leaves, for a company without a calendar of its own. A
 * company whose calendar has attendances or leaves to copy refuses (NotPorted).
 */
import { NotPorted } from "../errors";
import { registerOverrides } from "../orm/write";
import { DbRec, NOT_ASSIGNED, registerRecordCompute } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { plainNumber } from "../orm/values";

type Vals = Record<string, unknown>;

async function companyCalendar(env: Environment, company: unknown): Promise<number | null> {
  if (typeof company !== "number" || !company) return null;
  return (await env.cr.query<{ c: number | null }>("SELECT resource_calendar_id AS c FROM res_company WHERE id = $1", [company])).rows[0]?.c ?? null;
}

registerOverrides("resource.calendar", {
  create: async (env, valsList, next) => {
    const list: Vals[] = [];
    for (const vals of valsList) {
      const v = { ...vals };
      const company = v["company_id"] ?? env.context["default_company_id"] ?? await env.company();
      const type = v["calendar_type"] ?? env.context["default_calendar_type"] ?? "fixed";
      if (!("attendance_ids" in v) && type === "fixed") {
        if (await companyCalendar(env, company) !== null) throw new NotPorted("resource.calendar attendances copied from the company's calendar");
        v["attendance_ids"] = [[5, 0, 0], ...[0, 1, 2, 3, 4].map((d) => [0, 0, { dayofweek: String(d), duration_hours: 8, hour_from: 0, hour_to: 0 }])];
      }
      if (!("global_leave_ids" in v)) {
        if (await companyCalendar(env, company) !== null) throw new NotPorted("resource.calendar global leaves copied from the company's calendar");
        v["global_leave_ids"] = [[5, 0, 0]];
      }
      list.push(v);
    }
    const ids = await next(env, list);
    // :273-276 `_get_attendances_to_unlink` (single occurrences already past, :102-116): none for new weekly lines
    if ((await env.cr.query("SELECT 1 FROM resource_calendar_attendance WHERE calendar_id = ANY($1::int[]) AND recurrency LIMIT 1", [ids])).rows.length) {
      throw new NotPorted("resource.calendar create with recurring attendances (_get_attendances_to_unlink)");
    }
    return ids;
  },
});

const num = (v: unknown): number => Number(plainNumber(v) ?? 0);

registerRecordCompute("resource.calendar", {
  // :196-204 (`_is_work_period` is True, resource_calendar_attendance.py:378-380)
  days_per_week: async (_env, rec) => {
    if ((await rec.get("calendar_type")) !== "fixed") return rec.prev("days_per_week");
    const days = new Set<unknown>();
    for (const a of await rec.rels("attendance_ids")) days.add(await a.get("dayofweek"));
    return (days.size);
  },
  // :211-219
  hours_per_week: async (_env, rec) => {
    if ((await rec.get("calendar_type")) !== "fixed") return rec.prev("hours_per_week");
    let total = 0;
    for (const a of await rec.rels("attendance_ids")) total += num(await a.get("duration_hours"));
    return (total);
  },
  // :206-209
  hours_per_day: async (_env, rec) => {
    const days = num(await rec.get("days_per_week"));
    return (days ? num(await rec.get("hours_per_week")) / days : 0);
  },
  // :171-179
  full_time_required_hours: async (_env, rec) => {
    const ref = await rec.rel("reference_calendar_id");
    if (ref) return (num(await ref.get("hours_per_week")));
    const company = await rec.rel("company_id");
    const cal = company ? await company.rel("resource_calendar_id") : null;
    if (cal) return (num(await cal.get("hours_per_week")));
    return (num(await rec.get("hours_per_week")));
  },
  // :245-250
  work_time_rate: async (_env, rec) => {
    const full = num(await rec.get("full_time_required_hours"));
    return (full ? num(await rec.get("hours_per_week")) / full : 1.0);
  },
});

registerRecordCompute("resource.calendar.attendance", {
  // resource_calendar_attendance.py:299-303
  duration_based: async (_env, rec) => !num(await rec.get("hour_from")) && !num(await rec.get("hour_to")),
  // :325-330
  duration_hours: async (_env, rec) => ((await rec.get("duration_based")) ? rec.prev("duration_hours")
    : (Math.max(0, num(await rec.get("hour_to")) - num(await rec.get("hour_from"))))),
  // :332-336
  hour_from: async (_env, rec) => ((await rec.get("duration_based")) ? (0) : rec.prev("hour_from")),
  hour_to: async (_env, rec) => ((await rec.get("duration_based")) ? (0) : rec.prev("hour_to")),
  // :305-316
  day_period: async (_env, rec) => {
    const cal = await rec.rel("calendar_id");
    const perDay = cal ? num(await cal.get("hours_per_day")) : 0;
    const from = num(await rec.get("hour_from")), to = num(await rec.get("hour_to"));
    if (num(await rec.get("duration_hours")) > 0.75 * perDay || await rec.get("duration_based")) return "full_day";
    if (from && to) return from > 12 || 12 - from <= to - 12 ? "afternoon" : "morning";
    return "morning";
  },
  // :338-350: a weekly line without recurrency takes its date
  recurrency_until: async (_env, rec) => {
    if (!(await rec.get("recurrency"))) return rec.get("date");
    throw new NotPorted("resource.calendar.attendance recurrency_until of a recurring line");
  },
  // :292-297 `_compute_dayofweek` from the date: only lines with a date
  dayofweek: async (_env, rec) => {
    if (await rec.get("date")) throw new NotPorted("resource.calendar.attendance dayofweek of a dated line");
    return rec.prev("dayofweek");
  },
});

// stock stock_location.py:127-134, :163-177, :185-189: the stored computes of a new location (stock res_company.py
// creates four per company)
registerRecordCompute("stock.location", {
  complete_name: async (_env, rec) => {
    const parent = await rec.rel("location_id");
    if (parent && (await rec.get("usage")) !== "view") return `${String(await parent.get("complete_name"))}/${String(await rec.get("name"))}`;
    return rec.get("name");
  },
  warehouse_id: async (env, rec) => {
    // the warehouses whose view location is a parent of the location, the deepest first
    if (rec.id === null) throw new NotPorted("stock.location warehouse_id of a new record");
    const r = (await env.cr.query<{ w: number }>(
      `SELECT w.id AS w FROM stock_warehouse w JOIN stock_location v ON v.id = w.view_location_id JOIN stock_location l ON l.id = $1
        WHERE l.parent_path LIKE v.parent_path || '%' ORDER BY v.parent_path DESC LIMIT 1`, [rec.id])).rows[0];
    return r?.w ?? false;
  },
  // stock_location.py:185-189: an internal location is not assigned, so a new one keeps NULL (not False) in the column
  replenish_location: async (_env, rec) => ((await rec.get("usage")) !== "internal" ? false : rec instanceof DbRec ? NOT_ASSIGNED : rec.prev("replenish_location")),
});

// product product_product.py:252-273 `_compute_write_date`: a template's write moves its variants' write_date to now
registerRecordCompute("product.product", {
  write_date: async (env) => (await env.cr.query<{ n: string }>("SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS n")).rows[0]!.n,
});
