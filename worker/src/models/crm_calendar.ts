/**
 * The calendar view the CRM "Meeting" smart button opens (crm.lead action_schedule_meeting): the calendar model's
 * RPCs whose answers do not depend on synchronisation providers (none installed on poc_erp):
 * calendar/models/calendar_filter.py:30-62 init_partner_filters, res_partner.py:81-105 get_attendee_detail,
 * res_users.py:184-202 get_calendar_model_data with calendar_event.py:2155-2161 get_default_duration.
 */
import { NotPorted } from "../errors";
import { registerMethod } from "../http/methods";
import { and, cond } from "../orm/domain";
import { userInfo } from "../orm/env";
import { envFor } from "../web/common";
import { registerHooks } from "../orm/hooks";
import { registerOverrides, write } from "../orm/write";
import { create } from "../orm/create";
import type { Environment } from "../orm/types";

registerMethod("calendar.filters", "init_partner_filters", async (env0, _ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const raw = env.context["default_partner_ids"];
  const self = await userInfo(env);
  const requested = new Set((Array.isArray(raw) ? raw : []).filter((x): x is number => typeof x === "number" && x !== self.partnerId));
  // update_partner_filters (:37-65): existing filters of the user (active_test=False); new partners get a filter,
  // the requested ones are activated and the others deactivated (active=False, not unlinked)
  const existing = await env.model("calendar.filters").search(cond("user_id", "=", env.uid), { activeTest: false });
  const rows = existing.length ? await env.model("calendar.filters").read(existing, ["partner_id", "active"], "") : [];
  const partnerOf = (r: Record<string, unknown>): number | null => (Array.isArray(r["partner_id"]) ? r["partner_id"][0] : r["partner_id"]) as number | null;
  const known = new Set(rows.map(partnerOf));
  // a Python set of small ints iterates in ascending order
  const created = [...requested].filter((p) => !known.has(p)).sort((a, b) => a - b);
  if (created.length) await create(env, "calendar.filters", created.map((p) => ({ active: true, partner_id: p, user_id: env.uid })));
  const activate = rows.filter((r) => requested.has(partnerOf(r) as number) && !r["active"]).map((r) => Number(r["id"]));
  const deactivate = rows.filter((r) => !requested.has(partnerOf(r) as number) && r["active"]).map((r) => Number(r["id"]));
  if (activate.length) await write(env, "calendar.filters", activate, { active: true });
  if (deactivate.length) await write(env, "calendar.filters", deactivate, { active: false });
  return null;
}, { apiModel: true });

registerMethod("res.partner", "get_attendee_detail", async (env0, ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const raw = "meeting_ids" in kwargs ? kwargs["meeting_ids"] : args[0];
  const meetings = [...new Set((Array.isArray(raw) ? raw : []).filter(Boolean))];
  if (!meetings.length) return [];
  if (!meetings.every((m): m is number => typeof m === "number")) throw new NotPorted("get_attendee_detail meeting ids");
  const partners = new Set(ids ?? []);
  const self = await userInfo(env);
  // `meetings.attendee_ids`: each meeting's attendees in calendar.attendee order (create_date), without duplicates
  const out: Record<string, unknown>[] = [];
  for (const m of meetings) {
    const ev = (await env.model("calendar.event").read([m], ["attendee_ids", "user_id", "partner_id"], ""))[0];
    if (!ev) throw new NotPorted("get_attendee_detail on a missing meeting (MissingError)");
    const attIds = Array.isArray(ev["attendee_ids"]) ? (ev["attendee_ids"] as number[]) : [];
    if (!attIds.length) continue;
    const atts = (await env.cr.query<{ id: number; partner_id: number | null; state: string | null }>(
      "SELECT id, partner_id, state FROM calendar_attendee WHERE id = ANY($1::int[]) ORDER BY create_date, id", [attIds])).rows;
    const idOf = (v: unknown): number | null => (typeof v === "number" ? v : Array.isArray(v) ? v[0] as number : null);
    const organizerUser = idOf(ev["user_id"]);
    const organizerUserPartner = organizerUser ? (await env.cr.query<{ p: number }>("SELECT partner_id AS p FROM res_users WHERE id = $1", [organizerUser])).rows[0]?.p ?? null : null;
    const eventPartner = idOf(ev["partner_id"]);
    // calendar_event.py:481-492 `_compute_is_organizer_alone`
    const others = atts.filter((a) => a.partner_id !== eventPartner);
    const alone = atts.length > 1 && !others.some((a) => a.state !== "declined");
    for (const a of atts) {
      if (a.partner_id === null || !partners.has(a.partner_id)) continue;
      const isOrganizerUser = env.uid === organizerUser && a.partner_id === self.partnerId;
      out.push({
        id: a.partner_id, name: (await env.model("res.partner").displayName([a.partner_id])).get(a.partner_id) ?? "",
        status: a.state ?? false, event_id: m, attendee_id: a.id, is_alone: alone && isOrganizerUser,
        is_organizer: a.partner_id === organizerUserPartner ? 1 : 0,
      });
    }
  }
  return out;
}, { apiModel: false });

registerMethod("res.users", "get_calendar_model_data", async (env0, _ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  // ir.default _get('calendar.event', 'duration', user_id=True/company_id=True, ...) in that order
  const company = await env.company();
  const rows = (await env.cr.query<{ json_value: string; user_id: number | null; company_id: number | null }>(
    `SELECT d.json_value, d.user_id, d.company_id FROM ir_default d JOIN ir_model_fields f ON f.id = d.field_id
     WHERE f.model = 'calendar.event' AND f.name = 'duration' AND d.condition IS NULL
       AND (d.user_id IS NULL OR d.user_id = $1) AND (d.company_id IS NULL OR d.company_id = $2)`, [env.uid, company])).rows;
  const pick = (u: boolean, c: boolean): unknown => {
    const r = rows.find((x) => (u ? x.user_id === env.uid : x.user_id === null) && (c ? x.company_id === company : x.company_id === null));
    return r ? JSON.parse(r.json_value) : null;
  };
  const duration = pick(true, true) || pick(true, false) || pick(false, true) || pick(false, false) || 1;
  return { credential_status: {}, sync_status: {}, sync_email: false, default_duration: duration };
}, { apiModel: true, readonly: true });



// calendar/models/res_users.py:25-33 _compute_calendar_ids: the calendars of the user's calendar.user lines
// (sudo search in calendar.user order), by access role
function calendarIds(roles: readonly string[] | null) {
  return async (env: Environment, ids: readonly number[]): Promise<Map<number, unknown>> => {
    const lines = await env.sudo().model("calendar.user").search(cond("user_id", "in", [...ids]));
    const rows = await env.sudo().model("calendar.user").read(lines, ["user_id", "calendar_id", "access_role"], "");
    const out = new Map<number, unknown>(ids.map((id) => [id, [] as number[]]));
    for (const r of rows) {
      if (roles !== null && !roles.includes(String(r["access_role"]))) continue;
      const list = out.get(Number(r["user_id"])) as number[] | undefined;
      const cal = r["calendar_id"];
      if (list && typeof cal === "number" && !list.includes(cal)) list.push(cal);
    }
    return out;
  };
}
registerHooks("res.users", {
  computed: {
    calendar_ids: calendarIds(null),
    owned_calendar_ids: calendarIds(["owner"]),
    writable_calendar_ids: calendarIds(["owner", "writer"]),
  },
});

// base/models/res_country.py:211-221 res.country.group `_sanitize_vals`: the code is stored upper-case
registerOverrides("res.country.group", {
  create: async (env, valsList, next) => {
    for (const vals of valsList) if (typeof vals["code"] === "string" && vals["code"]) vals["code"] = vals["code"].toUpperCase();
    return next(env, valsList);
  },
  write: async (env, ids, vals, next) => {
    if (typeof vals["code"] === "string" && vals["code"]) vals["code"] = vals["code"].toUpperCase();
    return next(env, ids, vals);
  },
});
