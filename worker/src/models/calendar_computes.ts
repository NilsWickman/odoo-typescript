/**
 * calendar.calendar and calendar.event computes, searches, selections and defaults
 * (odoo/addons/calendar/models/calendar_calendar.py, calendar_event.py).
 */
import { NotPorted, UserError } from "../errors";
import { registerMethod } from "../http/methods";
import { envFor } from "../web/common";
import { and, cond, FALSE, or } from "../orm/domain";
import { registerHooks } from "../orm/hooks";
import { DbRec, emptyValue, type Rec, type RecordCompute, registerDefaults, registerOnchange, registerRecordCompute, registerRemoveToCompute } from "../orm/recompute";
import { hasGroup, userInfo } from "../orm/env";
import { userFlags } from "../session/user";
import { registerOverrides, write } from "../orm/write";
import { create, HOOKS_INSIDE } from "../orm/create";
import { unlink } from "../orm/unlink";
import { isHtmlEmpty } from "../web/empty_list_help";
import { htmlSanitize } from "../orm/html_sanitize";
import { quotePlus } from "../qweb";
import { ModelImpl } from "../orm/model";
import { copy } from "../web/save";
import { deleteFollowers } from "../mail/followers";

const SANITIZE_DEFAULT = { sanitizeTags: true, sanitizeAttributes: true, sanitizeStyle: false, sanitizeForm: true, stripStyle: false, stripClasses: false };
import type { Domain, Environment } from "../orm/types";
import { datetimeToString, dbNow, htmlEscape, pyTruthy, todayInTz, translate, validTz } from "./util";
import { defaultGet, defaultGetBase } from "../web/defaults";
import { firstAlarmUser, setupAlarms } from "./calendar_alarm";
import { applyRecurrenceValues, breakRecurrence, eventRecurrenceValues, eventRruleTypeUi, readEvents, RECURRENT_FIELDS, recurrencesOfBase, rewriteRecurrence, selectNewBaseEvent, setupRecurrenceAlarms, TIME_FIELDS, updateFutureEvents } from "./calendar_recurrence";
import { registerActivityMixin } from "./crm_activity";
import { PySet } from "./pyset";
import { notifyAttendees, sendInvitationEmails } from "./calendar_invitation";
import { clearPending, markPending } from "./calendar_flush";
import { configParam, defineComputes, referenceIfExists, registerIsFollower, registerNeedaction, relatedSelection, searchMethod, registerDefaultValued } from "./tail_util";

/** The calendar.user rows of a calendar the user can see (`calendar.calendar_user_ids`, active_test). */
async function members(env: Environment, calendar: number): Promise<{ id: number; user_id: number | null; access_role: string | null; name: string | null }[]> {
  const ids = await env.model("calendar.user").search(cond("calendar_id", "=", calendar), { order: "id" });
  if (ids.length === 0) return [];
  return (await env.cr.query<{ id: number; user_id: number | null; access_role: string | null; name: string | null }>(
    "SELECT id, user_id, access_role, name FROM calendar_user WHERE id = ANY($1::int[]) ORDER BY id", [ids])).rows;
}

/** calendar_calendar.py:115-123 _compute_owner_id: the user of the owner memberships searched as the user. */
async function ownerOf(env: Environment, calendar: number): Promise<number | null> {
  const owners = await env.model("calendar.user").search(and([cond("access_role", "=", "owner"), cond("calendar_id", "in", [calendar])]));
  if (owners.length === 0) return null;
  const users = [...new Set((await env.cr.query<{ user_id: number | null }>(
    "SELECT user_id FROM calendar_user WHERE id = ANY($1::int[])", [owners])).rows.map((r) => r.user_id).filter((u): u is number => u !== null))];
  if (users.length > 1) throw new NotPorted("calendar.calendar with several owners (Expected singleton)");
  return users[0] ?? null;
}

defineComputes("calendar.calendar", {
  // calendar_calendar.py:69-74 _compute_calendar_user: the membership of env.user
  calendar_user_id: async (env, rec) => {
    if (rec.id === null) {
      const lines: Rec[] = [];
      for (const line of await rec.rels("calendar_user_ids")) if ((await line.get("user_id")) === env.uid) lines.push(line);
      if (lines.length > 1) throw new NotPorted("calendar.calendar with several memberships of one user (ValueError)");
      return lines[0] ?? null;
    }
    const mine = (await members(env, rec.id)).filter((m) => m.user_id === env.uid);
    if (mine.length > 1) throw new NotPorted("calendar.calendar with several memberships of one user (ValueError)");
    return mine[0]?.id ?? null;
  },
  // calendar_calendar.py:80-85 _compute_share_user_ids: users of the non-owner memberships
  share_user_ids: async (env, rec) => {
    if (rec.id === null) {
      const users: number[] = [];
      for (const line of await rec.rels("calendar_user_ids")) {
        const user = await line.get("user_id");
        if ((await line.get("access_role")) !== "owner" && typeof user === "number" && !users.includes(user)) users.push(user);
      }
      return users;
    }
    const out: number[] = [];
    for (const m of await members(env, rec.id)) if (m.access_role !== "owner" && m.user_id !== null && !out.includes(m.user_id)) out.push(m.user_id);
    return out;
  },
  // calendar_calendar.py:115-123 _compute_owner_id
  owner_id: async (env, rec) => (rec.id === null ? null : ownerOf(env, rec.id)),
});

// calendar_calendar.py:87-104 _inverse_share_user_ids, run from `write` where the assigned value is at hand; `create`
// refuses a non-empty value. calendar_calendar.py:61-70 the rights of `write`: refused for anybody but the owner.
registerOverrides("calendar.calendar", {
  create: async (env, valsList, next) => {
    for (const vals of valsList) {
      if (Array.isArray(vals["share_user_ids"]) && vals["share_user_ids"].length) throw new NotPorted("calendar.calendar created with shared users");
      delete vals["share_user_ids"];
    }
    const ids = await next(env, valsList);
    // the memberships recompute their users' res.users.primary_calendar_id (res_users.py:19-23): a field out of the
    // cache is flushed even when it stays the same (fields.py Field.write `_filter_not_equal`); the users of the
    // memberships created with the calendars (the creating user's own, or a new user's primary calendar)
    await env.cr.query(`UPDATE res_users SET write_uid = $1, write_date = now() AT TIME ZONE 'UTC'
      WHERE id IN (SELECT user_id FROM calendar_user WHERE calendar_id = ANY($2::int[]))`, [env.uid, ids]);
    return ids;
  },
  write: async (env, ids, vals0, next) => {
    if (!env.su) for (const id of ids) if ((await ownerOf(env, id)) !== env.uid) throw new NotPorted("calendar.calendar write by somebody else than the owner");
    const { share_user_ids: shared, ...vals } = vals0;
    if (Object.keys(vals).length) await next(env, ids, vals);
    if (shared === undefined) return;
    for (const id of ids) {
      const lines = (await members(env.sudo(), id)).filter((m) => m.access_role !== "owner");
      const before = lines.map((m) => m.user_id).filter((u): u is number => u !== null);
      const after = applyUserCommands(before, shared);
      const removed = lines.filter((m) => m.user_id !== null && !after.includes(m.user_id)).map((m) => m.id);
      if (removed.length) await unlink(env.sudo(), "calendar.user", removed);
      const name = (await env.cr.query<{ name: string | null }>("SELECT name FROM calendar_calendar WHERE id = $1", [id])).rows[0]?.name ?? false;
      const added = after.filter((u) => !before.includes(u));
      if (added.length) await create(env.sudo(), "calendar.user", added.map((user_id) => ({ access_role: "writer", calendar_id: id, name, user_id })));
    }
  },
});

/** The users of a many2many value after Command.link, unlink and set (or the plain ids of a cached value). */
function applyUserCommands(current: readonly number[], value: unknown): number[] {
  if (!Array.isArray(value)) throw new NotPorted("calendar.calendar.share_user_ids value");
  if (value.every((v) => typeof v === "number")) return value as number[];
  let out = [...current];
  for (const c of value as unknown[][]) {
    if (c[0] === 4) out = out.includes(c[1] as number) ? out : [...out, c[1] as number];
    else if (c[0] === 3) out = out.filter((u) => u !== c[1]);
    else if (c[0] === 6) out = [...(c[2] as number[])];
    else throw new NotPorted("calendar.calendar.share_user_ids command");
  }
  return out;
}

// calendar_calendar.py:106-113 _compute_display_name on a new calendar (records: the displayName hook below)
registerRecordCompute("calendar.calendar", {
  display_name: async (env, rec) => {
    if (rec.id !== null) return (await env.model("calendar.calendar").displayName([rec.id])).get(rec.id) ?? "";
    const membership = await rec.rel("calendar_user_id");
    return (membership && await membership.get("name")) || rec.get("name");
  },
});

// calendar res_users.py:19-23 _compute_primary_calendar
registerRecordCompute("res.users", {
  primary_calendar_id: async (env, rec) => {
    if (rec.id === null) throw new NotPorted("res.users.primary_calendar_id of a new user");
    return (await env.cr.query<{ calendar_id: number | null }>(
      "SELECT calendar_id FROM calendar_user WHERE user_id = $1 AND is_primary IS TRUE AND access_role = 'owner' ORDER BY id LIMIT 1", [rec.id])).rows[0]?.calendar_id ?? null;
  },
});

registerHooks("calendar.calendar", {
  // calendar_calendar.py:59 user_access_role = related calendar_user_id.access_role
  selection: { user_access_role: relatedSelection("calendar.user", "access_role") },
  search: {
    // calendar_calendar.py:76-79 _search_calendar_user_id: an @api.model method, so `self.ids` is empty and the
    // subquery `calendar_id in []` selects nothing
    calendar_user_id: async (env, operator) => {
      const none = await env.model("calendar.user").search(FALSE);
      return cond("id", operator, none);
    },
  },
  // calendar_calendar.py:106-113 _compute_display_name: the name for the owner, else the membership's name or the name
  displayName: async (env, ids) => {
    const out = new Map<number, string>();
    for (const id of ids) {
      const name = (await env.cr.query<{ name: string | null }>("SELECT name FROM calendar_calendar WHERE id = $1", [id])).rows[0]?.name ?? null;
      let value: string | null = name;
      if ((await ownerOf(env, id)) !== env.uid) {
        const mine = (await members(env, id)).filter((m) => m.user_id === env.uid);
        value = mine[0]?.name || name;
      }
      out.set(id, (value || false) as string); // an unnamed calendar has no display name (False)
    }
    return out;
  },
});

registerDefaults("calendar.calendar", {
  // calendar_calendar.py:30
  calendar_default_privacy: async (env) => (await configParam(env, "calendar.default_privacy")) ?? "private",
  // calendar_calendar.py:9-19, 35
  calendar_user_ids: async (env) => [[0, 0, {
    user_id: env.uid, access_role: "owner", is_filter_active: true, is_filter_checked: true, name: translate(env, "Calendar"),
  }]],
});

// calendar_user.py:11-12
registerDefaults("calendar.user", { filter_color: async () => 1 + Math.floor(Math.random() * 11) });

defineComputes("calendar.event", {
  // calendar_event.py:518-524 _compute_res_record
  res_record: async (env, rec) => {
    const model = await rec.get("res_model"), id = await rec.get("res_id");
    return typeof model === "string" && model && typeof id === "number" && id ? referenceIfExists(env, model, id) : null;
  },
});

/** calendar_event.py:382-399 _compute_attendees_count: attendee states and the number of partners. */
function attendeeCount(which: "accepted" | "declined" | "tentative" | "attendees" | "awaiting") {
  return async (_env: Environment, rec: Rec): Promise<number> => {
    const attendees = await rec.rels("attendee_ids");
    const counts = new Map<string, number>();
    for (const a of attendees) {
      const s = String(await a.get("state"));
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    const accepted = counts.get("accepted") ?? 0, declined = counts.get("declined") ?? 0, tentative = counts.get("tentative") ?? 0;
    const total = (await rec.rels("partner_ids")).length;
    switch (which) {
      case "accepted": return accepted;
      case "declined": return declined;
      case "tentative": return tentative;
      case "attendees": return total;
      case "awaiting": return total - accepted - declined - tentative;
    }
  };
}
defineComputes("calendar.event", {
  accepted_count: attendeeCount("accepted"),
  declined_count: attendeeCount("declined"),
  tentative_count: attendeeCount("tentative"),
  attendees_count: attendeeCount("attendees"),
  awaiting_count: attendeeCount("awaiting"),
});

registerHooks("calendar.event", {
  selection: {
    // calendar_event.py:159-166 _get_model_selection
    res_record: async (env) => {
      const lang = env.lang ?? "en_US";
      const rows = await env.cr.query<{ model: string; name: string }>(
        `SELECT model, COALESCE(name->>$1, name->>'en_US') AS name FROM ir_model
         WHERE is_mail_activity IS TRUE AND abstract IS NOT TRUE AND transient IS NOT TRUE
           AND model NOT IN ('ir.cron', 'ir.actions.server', 'base.automation')
         ORDER BY is_mail_thread DESC, COALESCE(name->>$1, name->>'en_US') ASC`, [lang]);
      return rows.rows.map((r) => [r.model, r.name] as [string, string]);
    },
  },
});
registerNeedaction("calendar.event");
registerIsFollower("calendar.event");
registerActivityMixin("calendar.event");

registerRecordCompute("calendar.alarm", {
  // calendar_alarm.py:31-41 _compute_duration_minutes (stored)
  duration_minutes: async (_env, rec) => {
    const interval = await rec.get("interval");
    const duration = Number((await rec.get("duration")) ?? 0);
    if (interval === "minutes") return duration;
    if (interval === "hours") return duration * 60;
    if (interval === "days") return duration * 60 * 24;
    return 0;
  },
  // calendar_alarm.py:43-49 _compute_mail_template_id (stored)
  mail_template_id: async (env, rec) => {
    const type = await rec.get("alarm_type");
    // the field's own value before recomputation (a value given on create)
    const current = await rec.prev("mail_template_id");
    if (type === "email" && !current) return (await env.reg.xmlid(env.cr, "calendar.calendar_template_meeting_reminder")) ?? null;
    if (type !== "email" || !current) return null;
    return current;
  },
});

/** calendar_event.py:640-662 _compute_recurrence: every recurrence field False, or the recurrence's (src/models/calendar_recurrence.ts). */
const recurrenceComputes: Record<string, RecordCompute> = {};
for (const name of RECURRENT_FIELDS) {
  recurrenceComputes[name] = async (env, rec) => {
    if (await rec.get("recurrency")) {
      const start = await rec.get("start");
      const recurrence = await rec.get("recurrence_id");
      const values = await eventRecurrenceValues(env, {
        start: typeof start === "string" && start ? start.slice(0, 19) : null, allday: Boolean(await rec.get("allday")),
        recurrence_id: typeof recurrence === "number" ? recurrence : Array.isArray(recurrence) && typeof recurrence[0] === "number" ? recurrence[0] : null,
      });
      const v = values[name];
      return v === false || v === undefined ? emptyValue(env.reg.model("calendar.event").fields.get(name)!) : v;
    }
    return emptyValue(env.reg.model("calendar.event").fields.get(name)!);
  };
}
defineComputes("calendar.event", recurrenceComputes);

/** The calendar default privacy of a calendar (as superuser). */
async function calendarPrivacy(env: Environment, calendar: number | null): Promise<string | null> {
  if (calendar === null) return null;
  return (await env.cr.query<{ p: string | null }>("SELECT calendar_default_privacy AS p FROM calendar_calendar WHERE id = $1", [calendar])).rows[0]?.p ?? null;
}

defineComputes("calendar.event", {
  // calendar_event.py:425-431 _compute_effective_privacy: `(privacy or calendar default or the organizer's primary
  // calendar default) if user_id else 'public'`
  effective_privacy: async (env, rec) => {
    const user = await rec.get("user_id");
    if (!user) return "public";
    const privacy = await rec.get("privacy");
    if (privacy) return privacy;
    const calendar = await rec.get("calendar_id");
    const fromCalendar = await calendarPrivacy(env, typeof calendar === "number" ? calendar : null);
    if (fromCalendar) return fromCalendar;
    const primary = (await env.cr.query<{ primary_calendar_id: number | null }>(
      "SELECT primary_calendar_id FROM res_users WHERE id = $1", [user])).rows[0]?.primary_calendar_id ?? null;
    if (primary === null) throw new NotPorted("calendar.event effective privacy creating the organizer's primary calendar");
    return calendarPrivacy(env, primary);
  },
  // calendar_event.py:663-666 _compute_display_description
  display_description: async (_env, rec) => !isHtmlEmpty(await rec.get("description")),
  // calendar_event.py:401-417 _compute_user_can_edit
  user_can_edit: async (env, rec) => {
    const calendar = await rec.get("calendar_id");
    const privacy = await rec.get("privacy");
    if (typeof calendar === "number" && calendar) {
      if ((await ownerOf(env, calendar)) === env.uid) return true;
      const writable = (await env.cr.query<{ calendar_id: number }>(
        "SELECT calendar_id FROM calendar_user WHERE user_id = $1 AND access_role IN ('owner', 'writer')", [env.uid])).rows.map((r) => r.calendar_id);
      if (writable.includes(calendar) && privacy !== "private") return true;
    }
    const usersOf = async (partners: readonly number[]): Promise<number[]> => partners.length === 0 ? [] : (await env.cr.query<{ id: number }>(
      "SELECT id FROM res_users WHERE partner_id = ANY($1::int[]) AND active", [partners])).rows.map((r) => r.id);
    const partnerIds = (await rec.rels("partner_ids")).map((p) => p.origin).filter((p): p is number => p !== null);
    const candidates = new Set<number>(await usersOf(partnerIds));
    const organizer = await rec.get("user_id");
    if (typeof organizer === "number" && organizer) candidates.add(organizer);
    const creator = await rec.get("create_uid");
    candidates.add(typeof creator === "number" && creator ? creator : env.uid);
    if (rec.origin !== null && rec.id === null) {
      const originPartners = (await env.cr.query<{ res_partner_id: number }>(
        "SELECT res_partner_id FROM calendar_event_res_partner_rel WHERE calendar_event_id = $1", [rec.origin])).rows.map((r) => r.res_partner_id);
      for (const u of await usersOf(originPartners)) candidates.add(u);
    }
    if (await hasGroup(env, "base.group_system") && privacy !== "private") candidates.add(env.uid);
    return candidates.has(env.uid);
  },
});

registerHooks("calendar.event", {
  // calendar_event.py:295-296 event_tz = Selection(_tz_get): base res_partner.py:133 `_tzs`
  // a callable selection is not translated (fields_selection.py:206-209): the `(tz, tz)` pairs of `_tzs` as they are
  selection: { event_tz: async (env) => (env.reg.model("res.partner").fields.get("tz")?.selection ?? []).map((s) => [s.value, s.label] as [string, string]) },
  search: {
    // calendar_event.py:433-460 _search_effective_privacy
    effective_privacy: searchMethod("calendar.event", "effective_privacy", async (_env, operator, value) => {
      if (operator !== "in" && operator !== "not in") return null;
      return or([
        cond("privacy", operator, value),
        and([cond("privacy", "=", false), cond("calendar_id.calendar_default_privacy", operator, value)]),
        and([cond("privacy", "=", false), cond("calendar_id.calendar_default_privacy", "=", false), cond("user_id.primary_calendar_id.calendar_default_privacy", operator, value)]),
        and([cond("user_id", "=", false), cond("privacy", "=", false), cond("calendar_id.calendar_default_privacy", "=", false)]),
      ]);
    }),
  },
});

defineComputes("calendar.event", {
  // calendar_event.py:358-363 _compute_current_attendee: the first attendee of the user's partner
  current_attendee: async (env, rec) => {
    const partner = (await env.cr.query<{ partner_id: number }>("SELECT partner_id FROM res_users WHERE id = $1", [env.uid])).rows[0]?.partner_id;
    for (const a of await rec.rels("attendee_ids")) if ((await a.get("partner_id")) === partner) return a.origin;
    return null;
  },
});
registerHooks("calendar.event", {
  search: {
    // calendar_event.py:365-371 _search_current_attendee
    current_attendee: async (env, operator, value) => {
      const partner = (await env.cr.query<{ partner_id: number }>("SELECT partner_id FROM res_users WHERE id = $1", [env.uid])).rows[0]?.partner_id ?? false;
      return cond("attendee_ids", "any", and([cond("partner_id", "=", partner), cond("id", operator, value)]));
    },
  },
});

registerRecordCompute("calendar.alarm", {
  // calendar_sms calendar_alarm.py:19-25 _compute_sms_template_id (stored)
  sms_template_id: async (env, rec) => {
    const type = await rec.get("alarm_type");
    const current = await rec.prev("sms_template_id");
    if (type === "sms" && !current) return (await env.reg.xmlid(env.cr, "calendar_sms.sms_template_data_calendar_reminder")) ?? null;
    if (type !== "sms" || !current) return null;
    return current;
  },
});

/** calendar_alarm.py:11 `_interval_selection` (English labels, not translated). */
const ALARM_INTERVALS: Readonly<Record<string, string>> = { minutes: "Minutes", hours: "Hours", days: "Days" };
// calendar_alarm.py:67-78 _onchange_duration_interval
registerOnchange("calendar.alarm", "_onchange_duration_interval", ["duration", "interval", "alarm_type", "notify_responsible"], async (env, rec) => {
  const type = await rec.get("alarm_type");
  if ((await rec.get("notify_responsible")) && (type === "email" || type === "notification")) await rec.set("notify_responsible", false);
  const interval = await rec.get("interval");
  const displayInterval = typeof interval === "string" ? ALARM_INTERVALS[interval] ?? "" : "";
  const sel = env.reg.model("calendar.alarm").fields.get("alarm_type")?.selection ?? [];
  const entry = sel.find((s) => s.value === type);
  const displayType = entry ? entry.labels[env.lang ?? "en_US"] ?? entry.label : "";
  const duration = await rec.get("duration");
  let name = `${displayType} - ${typeof duration === "number" ? duration : "False"} ${displayInterval}`;
  if (await rec.get("notify_responsible")) name += ` - ${translate(env, "Notify Responsible")}`;
  await rec.set("name", name);
});
registerHooks("calendar.alarm", {
  search: {
    // calendar_alarm.py:51-65 _search_duration_minutes
    duration_minutes: searchMethod("calendar.alarm", "duration_minutes", async function search(_env, operator, value): Promise<Domain | null> {
      if (operator === "in" && Array.isArray(value)) {
        const parts: Domain[] = [];
        for (const v of value) { const d = await search(_env, "=", v); if (d === null) return null; parts.push(d); }
        return or(parts);
      }
      if (operator === "=") {
        if (!value) return cond("duration", "=", false);
      } else if (![">=", "<=", "<", ">"].includes(operator)) return null;
      const n = Number(value);
      return or([
        and([cond("interval", "=", "minutes"), cond("duration", operator, n)]),
        and([cond("interval", "=", "hours"), cond("duration", operator, n / 60)]),
        and([cond("interval", "=", "days"), cond("duration", operator, n / 60 / 24)]),
      ]);
    }),
  },
});

/** odoo/tools/mail.py:797 single_email_re */
const SINGLE_EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}\n?$/; // Python `$` also matches before a final newline
defineComputes("calendar.event", {
  // calendar_event.py:419-424 _compute_invalid_email_partner_ids
  invalid_email_partner_ids: async (_env, rec) => {
    const out: number[] = [];
    for (const p of await rec.rels("partner_ids")) {
      const email = await p.get("email");
      if (!(typeof email === "string" && email && SINGLE_EMAIL_RE.test(email)) && p.origin !== null) out.push(p.origin);
    }
    return out;
  },
});

defineComputes("calendar.event", {
  // calendar_event.py:461-465 _compute_privacy_placeholder: the effective privacy's label, else "User default"
  privacy_placeholder: async (env, rec) => {
    const privacy = await rec.get("effective_privacy");
    const entry = (env.reg.model("calendar.event").fields.get("effective_privacy")?.selection ?? []).find((s) => s.value === privacy);
    return entry ? entry.labels[env.lang ?? "en_US"] ?? entry.label : translate(env, "User default");
  },
});
registerDefaultValued("calendar.event", "recurrence_update"); // calendar_event.py:276-280 store=False, default='self_only'

defineComputes("calendar.event", {
  // calendar_event.py:630-638 _compute_rrule_type_ui: only recurring events get a value
  rrule_type_ui: async (env, rec) => {
    if (await rec.get("recurrency")) {
      const recurrence = await rec.get("recurrence_id");
      return eventRruleTypeUi(env, typeof recurrence === "number" ? recurrence : Array.isArray(recurrence) && typeof recurrence[0] === "number" ? recurrence[0] : null);
    }
    return rec.prev("rrule_type_ui");
  },
});

defineComputes("calendar.event", {
  // calendar_event.py:353-357 _compute_should_show_status: an attendee of the user and another attendee
  should_show_status: async (env, rec) => {
    const partner = (await env.cr.query<{ partner_id: number }>("SELECT partner_id FROM res_users WHERE id = $1", [env.uid])).rows[0]?.partner_id;
    const attendees = await rec.rels("attendee_ids");
    const partners = [];
    for (const a of attendees) partners.push(await a.get("partner_id"));
    return partners.includes(partner) && partners.some((p) => p !== partner);
  },
});

/** calendar_event.py:146-150 `_default_start`: now rounded up to the next half hour. */
async function defaultStart(env: Environment): Promise<Date> {
  const now = (await dbNow(env)).getTime();
  const half = 30 * 60 * 1000;
  // (datetime.min - now) % 30 minutes: the time to the next boundary (0 on a boundary)
  return new Date(now + ((half - (now % half)) % half));
}
/** calendar_event.py:2155-2161 get_default_duration: ir.default for duration (user+company, user, company, any), else 1. */
async function defaultDuration(env: Environment): Promise<number> {
  const rows = (await env.cr.query<{ json_value: string; user_id: number | null; company_id: number | null }>(
    `SELECT d.json_value, d.user_id, d.company_id FROM ir_default d JOIN ir_model_fields f ON f.id = d.field_id
      WHERE f.model = 'calendar.event' AND f.name = 'duration' AND d.condition IS NULL`)).rows;
  if (rows.length) throw new NotPorted("calendar.event default duration from ir.default");
  return 1;
}

registerDefaults("calendar.event", {
  // calendar_event.py:138-144 _default_partners: the user's partner, plus the active partner
  partner_ids: async (env) => {
    const partners = [(await userInfo(env)).partnerId];
    const activeId = env.context["active_id"];
    if (env.context["active_model"] === "res.partner" && typeof activeId === "number" && activeId && !partners.includes(activeId)) partners.push(activeId);
    return [[6, 0, partners]];
  },
  start: async (env) => datetimeToString(await defaultStart(env)),
  // calendar_event.py:152-157 _default_stop
  stop: async (env) => datetimeToString(new Date((await defaultStart(env)).getTime() + (await defaultDuration(env)) * 3600 * 1000)),
});

registerOverrides("calendar.event", {
  // calendar_event.py:110-136 default_get, under crm's (crm/models/calendar.py:10-24: an opportunity given by
  // default_opportunity_id becomes the event's document); the context both complete goes to the ORM's default_get
  defaultGet: async (env0, fields, defaults) => {
    let ctx: Record<string, unknown> = { ...env0.context };
    const crm = env0.reg.model("calendar.event").fields.has("opportunity_id");
    if (crm && ctx["default_opportunity_id"]) {
      const leadModel = await irModelId(env0, "crm.lead");
      ctx = { ...ctx, default_res_model_id: leadModel, default_res_id: ctx["default_opportunity_id"] };
    }
    const crmCtx = ctx;
    if (ctx["default_res_model"] && !ctx["default_res_model_id"]) {
      ctx = { ...ctx, default_res_model_id: await irModelId(env0, String(ctx["default_res_model"])) };
    }
    if (ctx["default_res_model_id"] && !ctx["default_res_model"]) {
      const model = (await env0.cr.query<{ model: string }>("SELECT model FROM ir_model WHERE id = $1", [ctx["default_res_model_id"]])).rows[0]?.model;
      if (model === undefined) throw new NotPorted(`ir.model ${String(ctx["default_res_model_id"])} (missing model)`);
      ctx = { ...ctx, default_res_model: model };
    }
    if (Object.keys(ctx).some((k) => ctx[k] !== env0.context[k])) {
      const base = await defaultGetBase(env0.withContext(ctx), "calendar.event", fields);
      for (const k of Object.keys(defaults)) delete defaults[k];
      Object.assign(defaults, base);
    }
    const activeModel = ctx["active_model"];
    if (!("res_model_id" in defaults) && fields.includes("res_model_id") && typeof activeModel === "string" && activeModel && activeModel !== "calendar.event") {
      defaults["res_model_id"] = await irModelId(env0, activeModel);
      defaults["res_model"] = activeModel;
    }
    if (!("res_id" in defaults) && fields.includes("res_id") && defaults["res_model_id"] && ctx["active_id"]) defaults["res_id"] = ctx["active_id"];
    if (defaults["is_draft"] && fields.includes("show_as") && !("default_show_as" in ctx)) defaults["show_as"] = "free";
    // crm/models/calendar.py:18-22 `_is_crm_lead` of the defaults or crm's context: the opportunity is the document
    if (crm && !("opportunity_id" in defaults)) {
      const resModel = defaults["res_model"] || crmCtx["default_res_model"];
      const resModelId = defaults["res_model_id"] || crmCtx["default_res_model_id"];
      let isLead = Boolean(resModel) && resModel === "crm.lead";
      if (!isLead && resModelId) {
        isLead = (await env0.cr.query<{ model: string }>("SELECT model FROM ir_model WHERE id = $1", [resModelId])).rows[0]?.model === "crm.lead";
      }
      if (isLead) defaults["opportunity_id"] = defaults["res_id"] || crmCtx["default_res_id"] || false;
    }
  },
});

/** ir_model.py `_get_id`: the id of an installed model (a missing one raises: not ported). */
async function irModelId(env: Environment, model: string): Promise<number> {
  const id = (await env.cr.query<{ id: number }>("SELECT id FROM ir_model WHERE model = $1", [model])).rows[0]?.id;
  if (id === undefined) throw new NotPorted(`ir.model._get_id of ${model} (missing model)`);
  return id;
}

registerRecordCompute("calendar.event", {
  // calendar_event.py:373-380 _compute_alarm_ids (stored): the default notification alarm unless all day or customised
  alarm_ids: async (env, rec) => {
    const def = await env.reg.xmlid(env.cr, "calendar.alarm_notif_1");
    const prev = await rec.prev("alarm_ids");
    const current = Array.isArray(prev) ? prev : [];
    if (current.some((a) => typeof a !== "number")) throw new NotPorted("calendar.event.alarm_ids with new alarms");
    if (current.length && !(current.length === 1 && current[0] === def)) return current;
    return (await rec.get("allday")) || def === null ? [] : [def];
  },
  // calendar_event.py:697-701 _compute_videocall_location (stored): the discuss route for discuss video calls
  videocall_location: async (_env, rec) => {
    if ((await rec.get("videocall_source")) === "discuss") throw new NotPorted("calendar.event discuss videocall location (base url, access token write)");
    return rec.prev("videocall_location");
  },
});

defineComputes("calendar.event", {
  // calendar_event.py:468-478 _compute_is_highlighted
  is_highlighted: async (env, rec) => {
    if (env.context["active_model"] !== "res.partner") return false;
    return (await rec.rels("partner_ids")).some((p) => p.origin === env.context["active_id"]);
  },
  // calendar_event.py:730-737 _compute_videocall_source: 'discuss' for a discuss route location
  videocall_source: async (_env, rec) => {
    const loc = await rec.get("videocall_location");
    return typeof loc === "string" && loc && loc.includes("calendar/join_videocall") ? "discuss" : "custom";
  },
});

registerRecordCompute("calendar.event", {
  // calendar_event.py:342-346 _compute_calendar_id (stored): the organizer's primary calendar when the calendar is
  // not the organizer's (calendar res_users.py:36-43 `_find_or_create_primary_calendar`)
  calendar_id: async (env, rec) => {
    const user = await rec.get("user_id");
    const calendar = await rec.prev("calendar_id");
    const owner = typeof calendar === "number" && calendar ? await ownerOf(env, calendar) : null;
    if ((typeof user === "number" && user ? user : null) === owner) return calendar || null;
    if (typeof user !== "number" || !user) return null;
    const primary = (await env.cr.query<{ primary_calendar_id: number | null }>("SELECT primary_calendar_id FROM res_users WHERE id = $1", [user])).rows[0]?.primary_calendar_id ?? null;
    if (primary === null) throw new NotPorted("calendar.event calendar creating the organizer's primary calendar");
    return primary;
  },
});

defineComputes("calendar.event", {
  // calendar_event.py:686-695 _compute_unavailable_partner_ids with res_partner.py:135-154 _get_busy_calendar_events
  // (busy events searched as the user over the event's interval) and odoo/tools/intervals.py:151-160 intervals_overlap
  unavailable_partner_ids: async (env, rec) => {
    const start = await rec.get("start"), stop = await rec.get("stop");
    if (typeof start !== "string" || !start || typeof stop !== "string" || !stop) return [];
    const partners = (await rec.rels("partner_ids")).map((p) => p.origin).filter((p): p is number => p !== null);
    if (partners.length === 0) return [];
    const events = await env.model("calendar.event").search(and([
      cond("stop", ">=", start), cond("start", "<=", stop), cond("partner_ids", "in", partners), cond("show_as", "=", "busy")]));
    const others = events.filter((e) => e !== rec.origin || rec.id === null);
    if (others.length === 0) return [];
    const rows = (await env.cr.query<{ id: number; start: string | null; stop: string | null }>(
      `SELECT id, to_char(start, 'YYYY-MM-DD HH24:MI:SS') AS start, to_char(stop, 'YYYY-MM-DD HH24:MI:SS') AS stop
         FROM calendar_event WHERE id = ANY($1::int[])`, [others])).rows;
    const overlapping = rows.filter((r) => r.start !== null && r.stop !== null && start < r.stop && stop > r.start).map((r) => r.id);
    if (overlapping.length === 0) return [];
    const links = (await env.cr.query<{ res_partner_id: number }>(
      "SELECT DISTINCT res_partner_id FROM calendar_event_res_partner_rel WHERE calendar_event_id = ANY($1::int[])", [overlapping])).rows;
    const busy = new Set(links.map((l) => l.res_partner_id));
    return partners.filter((p) => busy.has(p));
  },
});

/** calendar_event.py:2129-2148 `_get_public_fields`; `_get_custom_fields` are the manual fields, named x_*. */
const PUBLIC_FIELDS = new Set([
  "byday", "until", "rrule_type", "month_by", "event_tz", "rrule", "interval", "count", "end_type", "mon", "tue", "wed", "thu", "fri",
  "sat", "sun", "day", "weekday", "start", "stop", "start_date", "stop_date", "id", "active", "allday", "duration", "user_id",
  "partner_id", "calendar_id", "recurrence_id", "show_as", "privacy", "create_uid",
]);

/** calendar_event.py:1121-1150 `_check_private_event_conditions`; the conditions on the event itself first (all give False). */
export async function othersPrivate(env: Environment, id: number): Promise<boolean> {
  const key = `calendar.event.private:${env.uid}:${id}`;
  const known = env.cache.get(key) as boolean | undefined;
  if (known !== undefined) return known;
  const partner = (await userInfo(env)).partnerId;
  const row = (await env.cr.query<{ user_id: number | null; create_uid: number | null; calendar_id: number | null; attending: boolean }>(
    `SELECT e.user_id, e.create_uid, e.calendar_id, EXISTS (SELECT 1 FROM calendar_event_res_partner_rel r
       WHERE r.calendar_event_id = e.id AND r.res_partner_id = $2) AS attending FROM calendar_event e WHERE e.id = $1`, [id, partner])).rows[0];
  let result = false;
  if (row && row.user_id !== env.uid && row.create_uid !== env.uid && !row.attending) {
    const privacy = await new DbRec(env.sudo(), env.reg.model("calendar.event"), id).get("effective_privacy");
    const role = row.calendar_id === null ? null : (await env.cr.query<{ access_role: string | null }>(
      "SELECT access_role FROM calendar_user WHERE calendar_id = $1 AND user_id = $2", [row.calendar_id, env.uid])).rows[0]?.access_role ?? null;
    if (privacy === "public" || (privacy === "confidential" && (await userFlags(env.cr, env.uid)).isInternal) || role === "owner") result = false;
    else result = privacy !== "members_only" || role !== "writer";
  }
  env.cache.set(key, result);
  return result;
}

// calendar_event.py:974-998 _fetch_query: the private fields of the private events of others, 'Busy' as their name
registerHooks("calendar.event", {
  fetchFilter: async (env, field, values) => {
    if (PUBLIC_FIELDS.has(field.name) || field.name.startsWith("x_")) return values;
    const out = new Map(values);
    for (const id of values.keys()) {
      if (await othersPrivate(env, id)) out.set(id, field.name === "name" ? translate(env, "Busy") : emptyValue(field));
    }
    return out;
  },
});

/** Python `round(x)` of a float: an exact tie goes to the even neighbour. */
const roundEven = (x: number): number => (Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : Math.round(x));
const naiveMs = (s: string): number => Date.parse(`${s.replace(" ", "T").slice(0, 19)}Z`);

// calendar_event.py:513-516 _compute_duration and :535-552 _compute_stop depend on each other; Odoo breaks the cycle
// with env.remove_to_compute (:544-545): stop reads the duration in cache (registerRemoveToCompute, also on a new
// record of an onchange: a changed start keeps the duration and moves the stop).
registerRecordCompute("calendar.event", {
  duration: async (_env, rec) => {
    // :2121-2126 _get_duration
    const start = await rec.get("start"), stop = await rec.get("stop");
    if (typeof start !== "string" || !start || typeof stop !== "string" || !stop) return 0;
    return roundEven((naiveMs(stop) - naiveMs(start)) / 36000) / 100;
  },
  stop: async (_env, rec) => {
    const start = await rec.get("start");
    if (typeof start !== "string" || !start) {
      if (await rec.get("allday")) throw new NotPorted("calendar.event all-day stop without a start (TypeError)");
      return null;
    }
    const minutes = roundEven((Number(await rec.get("duration")) || 1) * 60);
    return datetimeToString(new Date(naiveMs(start) + minutes * 60000 - ((await rec.get("allday")) ? 1000 : 0)));
  },
});
registerRemoveToCompute("calendar.event", "stop", ["duration"]);


/** calendar_event.py:498-511 _compute_dates (stored): the UTC dates of all-day events. */
function eventDate(field: "start" | "stop") {
  return async (_env: Environment, rec: Rec): Promise<string | null> => {
    const start = await rec.get("start"), stop = await rec.get("stop");
    if (!(await rec.get("allday")) || typeof start !== "string" || !start || typeof stop !== "string" || !stop) return null;
    return (field === "start" ? start : stop).slice(0, 10);
  };
}
registerRecordCompute("calendar.event", { start_date: eventDate("start"), stop_date: eventDate("stop") });

/** calendar_event.py:566-594 _inverse_dates: an all-day event's start and stop follow its dates, at 8:00 and 18:00. */
async function inverseDates(env: Environment, ids: readonly number[]): Promise<void> {
  for (const id of ids) {
    const e = (await env.cr.query<{ allday: boolean | null; start_date: string | null; stop_date: string | null; start: string; stop: string }>(
      `SELECT allday, start_date::text, stop_date::text, to_char(start, 'YYYY-MM-DD') AS start, to_char(stop, 'YYYY-MM-DD') AS stop FROM calendar_event WHERE id = $1`, [id])).rows[0];
    if (!e?.allday) continue;
    const full = (await env.cr.query<{ s: string; e: string }>(
      "SELECT to_char(start, 'YYYY-MM-DD HH24:MI:SS') AS s, to_char(stop, 'YYYY-MM-DD HH24:MI:SS') AS e FROM calendar_event WHERE id = $1", [id])).rows[0]!;
    const [start, stop] = [`${e.start_date ?? e.start} 08:00:00`, `${e.stop_date ?? e.stop} 18:00:00`];
    if (start === full.s && stop === full.e && e.start_date && e.stop_date) continue; // `Field.write` drops what does not change
    await write(env, "calendar.event", [id], e.start_date && e.stop_date ? { start, stop } : { start_date: start, stop_date: stop });
  }
}
/** calendar_event.py:2038-2053 `_get_contact_details_description`, :2063-2071 `_prepare_partner_contact_details_html`. */
async function contactDescription(env: Environment, organizer: number | null, partners: readonly number[]): Promise<string> {
  const details = async (title: string, partner: number): Promise<string[]> => {
    const p = (await env.cr.query<{ name: string | null; email: string | null; phone: string | null }>("SELECT name, email, phone FROM res_partner WHERE id = $1", [partner])).rows[0];
    const lines = [p?.name ? htmlEscape(p.name) : "", p?.email ? `<a href='mailto:${htmlEscape(p.email)}'>${htmlEscape(p.email)}</a>` : "",
      p?.phone ? `<a href='tel:${htmlEscape(p.phone)}'>${htmlEscape(p.phone)}</a>` : ""].filter(Boolean);
    return lines.length ? [`<strong>${htmlEscape(translate(env, title))}</strong>`, ...lines] : [];
  };
  const root = await env.reg.xmlid(env.cr, "base.user_root");
  const rootPartner = (await env.cr.query<{ p: number }>("SELECT partner_id AS p FROM res_users WHERE id = $1", [root])).rows[0]?.p ?? null;
  const organizerPartner = organizer === null ? null : (await env.cr.query<{ p: number }>("SELECT partner_id AS p FROM res_users WHERE id = $1", [organizer])).rows[0]?.p ?? null;
  const out: string[] = [];
  if (organizer !== null && organizer !== root && organizerPartner !== null) out.push(...(await details("Organized by", organizerPartner)));
  const contacts = partners.filter((p) => p !== rootPartner && p !== organizerPartner);
  if (contacts.length === 1) {
    if (out.length) out.push("");
    out.push(...(await details("Contact Details", contacts[0]!)));
  }
  return out.join("<br/>");
}

// calendar_event.py:337-340 _onchange_allday
registerOnchange("calendar.event", "_onchange_allday", ["allday"], async (_env, rec) => {
  if (await rec.get("allday")) await rec.set("show_as", "free");
});

// calendar_event.py:753-767 _onchange_name_extract_time: only the quick create form of an all-day event reads a time
// in the title (`_parse_time_from_title`, babel's parse_time in the user's locale), which is not ported
registerOnchange("calendar.event", "_onchange_name_extract_time", ["name"], async (env, rec) => {
  if (!pyTruthy(env.context["is_quick_create_form"]) || !(await rec.get("name")) || !(await rec.get("allday"))) return;
  throw new NotPorted("calendar.event time in the title of an all-day quick create (_parse_time_from_title)");
});

// calendar_event.py:553-564 _onchange_date; `stop` is assigned after `start`, not recomputed from it
registerOnchange("calendar.event", "_onchange_date", ["start_date", "stop_date"], async (_env, rec) => {
  const start = await rec.get("start_date"), stop = await rec.get("stop_date");
  if (typeof start !== "string" || !start || typeof stop !== "string" || !stop) return;
  rec.protectedFields.add("stop");
  await rec.set("start", `${start} 08:00:00`);
  await rec.set("stop", `${stop} 18:00:00`);
  rec.protectedFields.delete("stop");
});

/** calendar_event.py:1560-1578 `action_mass_archive` of an event without recurrence. */
registerMethod("calendar.event", "action_mass_archive", async (env0, ids, args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const setting = args[0] ?? kwargs0["recurrence_update_setting"];
  if (ids?.length !== 1) throw new NotPorted("action_mass_archive on several events (Expected singleton)");
  const recurrence = (await env.cr.query<{ r: number | null }>("SELECT recurrence_id AS r FROM calendar_event WHERE id = $1", [ids[0]])).rows[0]?.r ?? null;
  if (setting !== "all_events" && setting !== "future_events" && setting !== "self_only") return null;
  if (setting !== "self_only" || recurrence !== null) throw new NotPorted("action_mass_archive of a recurrence");
  await write(env, "calendar.event", ids, { active: false });
  return null;
}, { apiModel: false });

/**
 * calendar_event.py:1300-1338 `_attendees_values` of a new event: the partners to add, a set command's in the order of
 * `set(command[2]) - set(self.partner_ids.ids)` (CPython's set iteration, `self` empty).
 */
function partnersOfCommands(commands: unknown): number[] {
  if (!Array.isArray(commands) || !commands.length) return [];
  const added = (ids: readonly number[]): number[] => PySet.fromList(ids).difference(new PySet()).order();
  if (typeof commands[0] === "number") return added(commands as number[]);
  const out: number[] = [];
  for (const c of commands as unknown[][]) {
    if (c[0] === 6) out.push(...added(c[2] as number[]));
    else if (c[0] === 4) out.push(c[1] as number);
    else throw new NotPorted(`calendar.event partner command ${String(c[0])} on create`);
  }
  return out;
}

/**
 * calendar_event.py:1300-1338 `_attendees_values` of existing events: the attendees of the removed partners deleted
 * (`[2, id]`, found by a search in the attendee `_order`), one created per added partner, in the order of the commands
 * (a set command's added partners in CPython's set iteration of `set(command[2]) - set(self.partner_ids.ids)`).
 */
async function attendeesValues(env: Environment, ids: readonly number[], commands: readonly unknown[]): Promise<unknown[]> {
  // `self.partner_ids.ids`: the events' partners as the field reads them (active ones; only membership counts below)
  const field = env.reg.model("calendar.event").fields.get("partner_ids")!;
  const values = await new ModelImpl(env, env.reg.model("calendar.event")).values(ids, field);
  const current: number[] = [];
  for (const id of ids) for (const p of (values.get(id) as number[] | undefined) ?? []) if (!current.includes(p)) current.push(p);
  const removed: number[] = [], added: number[] = [];
  for (const command of commands) {
    if (!Array.isArray(command)) throw new NotPorted("calendar.event partner_ids command that is not a list");
    const op = command[0];
    if (op === 2 || op === 3) removed.push(command[1] as number);
    else if (op === 6) {
      const given = PySet.fromList(command[2] as number[]), mine = PySet.fromList(current);
      removed.push(...mine.difference(given).order());
      added.push(...given.difference(mine).order());
    } else if (op === 4) {
      if (!current.includes(command[1] as number)) added.push(command[1] as number);
    } else throw new NotPorted(`calendar.event partner_ids command ${String(op)}`); // 0 and 1: a partner created or updated, no attendee
  }
  const toUnlink = removed.length ? (await env.cr.query<{ id: number }>(
    "SELECT id FROM calendar_attendee WHERE event_id = ANY($1::int[]) AND partner_id = ANY($2::int[]) ORDER BY create_date, id", [ids, removed])).rows.map((r) => r.id) : [];
  return [...toUnlink.map((id) => [2, id]), ...added.map((partner_id) => [0, 0, { partner_id }])];
}

/** calendar_event.py:526-533 _inverse_res_record, here where the assigned value is at hand. */
function resRecordValues(vals: Record<string, unknown>): Record<string, unknown> {
  if (!("res_record" in vals)) return vals;
  const { res_record: value, ...rest } = vals;
  if (value) throw new NotPorted("calendar.event.res_record with a document");
  return { ...rest, res_model_id: rest["res_model_id"] ?? false, res_id: rest["res_id"] ?? false };
}

registerOverrides("calendar.event", {
  inverse: { start_date: inverseDates, stop_date: inverseDates },
  // calendar_event.py:1000-1120 (recurrences: src/models/calendar_recurrence.ts); the attendees of `partner_ids`
  // (`_attendees_values`), mails to other attendees, activities and video call channels refuse
  write: async (env, ids, vals0, next) => {
    const vals: Record<string, unknown> = { ...resRecordValues(vals0) };
    const setting = "recurrence_update" in vals ? vals["recurrence_update"] : null;
    delete vals["recurrence_update"];
    const before = await readEvents(env, ids);
    const single = ids.length === 1 ? before[0] : undefined;
    const updateRecurrence = (setting === "all_events" || setting === "future_events") && single !== undefined && single.recurrence_id !== null;
    const breaking = vals["recurrency"] === false;
    const recurrent = new Set<string>(RECURRENT_FIELDS);
    if (Object.keys(vals).some((k) => recurrent.has(k)) && !(updateRecurrence || vals["recurrency"])) {
      throw new UserError(translate(env, 'Unable to save the recurrence with "This Event"'));
    }
    const keys = Object.keys(vals);
    if (keys.length === 1 && keys[0] === "videocall_channel_id") return next(env, ids, vals);
    // :1018-1035 the attendees of the partners given (`_attendees_values`), a plain list of ids being a `Command.set`
    const partnersGiven = pyTruthy(vals["partner_ids"]);
    if (partnersGiven) {
      if (!Array.isArray(vals["partner_ids"])) throw new NotPorted("calendar.event write of partner_ids that is not a list of commands");
      if (typeof vals["partner_ids"][0] === "number") vals["partner_ids"] = [[6, 0, vals["partner_ids"]]];
      if (updateRecurrence || (setting !== "self_only" && setting !== "all_events" && RECURRENT_FIELDS.some((f) => f in vals))) {
        throw new NotPorted("calendar.event write of partner_ids with a recurrence rewrite");
      }
      if ((await env.cr.query("SELECT 1 FROM calendar_event WHERE id = ANY($1::int[]) AND videocall_channel_id IS NOT NULL LIMIT 1", [ids])).rows.length) {
        throw new NotPorted("calendar.event write of partner_ids with a video call channel (_add_members)");
      }
      vals["attendee_ids"] = await attendeesValues(env, ids, vals["partner_ids"] as unknown[]);
    }
    const timeFields = new Set<string>(TIME_FIELDS);
    const updateTime = TIME_FIELDS.some((k) => vals[k]);
    const updateAlarms = partnersGiven || updateTime || "alarm_ids" in vals;
    // :1043-1045: `any({...})` iterates the keys: any time field given
    if ((!setting || (setting === "self_only" && ids.length === 1)) && !("follow_recurrence" in vals) && keys.some((k) => timeFields.has(k))) vals["follow_recurrence"] = false;
    const previous = await attendeesOf(env, ids);
    // the recurrence rewrites (`_break_recurrence`, `_rewrite_recurrence`, `_update_future_events`, new occurrences):
    // their mails stay refused, and so does a change of the times when another internal attendee's alarm notification
    // would flush first (Odoo stamps what those rewrites leave pending with that user's uid, src/models/calendar_flush.ts)
    const structural = (updateRecurrence && single !== undefined)
      || (setting !== "self_only" && setting !== "all_events" && RECURRENT_FIELDS.some((f) => f in vals));
    if (structural && updateAlarms && !env.context["dont_notify"]) {
      const flusher = await firstAlarmUser(env, await recurrencePartners(env, ids));
      if (flusher !== null && flusher !== env.uid) throw new NotPorted("calendar recurrence rewrite of the times with another internal attendee notified first (its flush)");
    }
    const durations = updateAlarms && !structural ? await eventDurations(env, ids) : null;
    if (structural) NESTED_REFUSAL.add(env.cr);
    try {
    const recurrenceValues: Record<string, unknown> = {};
    for (const f of RECURRENT_FIELDS) if (f in vals) { recurrenceValues[f] = vals[f]; delete vals[f]; }
    let futureEdge = false;
    if (setting === "future_events" && single?.recurrence_id) {
      futureEdge = (await env.cr.query<{ b: number | null }>("SELECT base_event_id AS b FROM calendar_recurrence WHERE id = $1", [single.recurrence_id])).rows[0]?.b === single.id;
    }
    const detached: number[] = [];
    if (updateRecurrence && single) {
      if (breaking) detached.push(...await breakRecurrence(env, ids, setting === "future_events"));
      else {
        const timeValues: Record<string, unknown> = {};
        for (const f of TIME_FIELDS) if (f in vals) { timeValues[f] = vals[f]; delete vals[f]; }
        delete vals["access_token"];
        if (setting === "all_events" || futureEdge) await rewriteRecurrence(env, single, vals, timeValues, recurrenceValues);
        else await updateFutureEvents(env, single, vals, timeValues, recurrenceValues);
      }
    } else {
      await next(env, ids, vals);
      // :1070 `_sync_activities` (:1597-1617): the meeting activities follow the name, draft, description, start, user
      await syncActivities(env, ids, new Set(Object.keys(vals)));
    }
    if (setting !== "self_only" && setting !== "all_events" && !futureEdge && !breaking) {
      detached.push(...await applyRecurrenceValues(env, ids, recurrenceValues, setting === "future_events"));
    }
    const mine = detached.filter((id) => ids.includes(id)), others = detached.filter((id) => !ids.includes(id));
    if (mine.length) await write(env, "calendar.event", mine, { active: false });
    if (others.length) await unlink(env.withContext({ ...env.context, archive_on_error: true }), "calendar.event", others);
    const after = await readEvents(env, ids);
    if (durations !== null) {
      // a changed `duration` (stored compute of start and stop) is still pending at the alarms' flush
      const now = await eventDurations(env, ids);
      markPending(env, "calendar.event", ids.filter((id) => now.get(id) !== durations.get(id)));
    }
    if (!env.context["dont_notify"] && updateAlarms) {
      const recurrences = [...new Set(after.map((e) => e.recurrence_id).filter((r): r is number => r !== null))];
      if (recurrences.length) await setupRecurrenceAlarms(env, recurrences);
      else await setupAlarms(env, ids);
    }
    // :1088-1093: another user's change of the time sets the organizer's attendee back to needsAction;
    // `self.user_id.partner_id == att.partner_id` holds only when the events have one organizer
    const otherOrganized = after.filter((e) => e.user_id !== null && e.user_id !== env.uid).map((e) => e.id);
    const organizers = [...new Set(after.map((e) => e.user_id).filter((u): u is number => u !== null))];
    if (updateTime && otherOrganized.length && organizers.length === 1) {
      const partner = (await env.cr.query<{ p: number }>("SELECT partner_id AS p FROM res_users WHERE id = $1", [organizers[0]])).rows[0]?.p;
      const toReset = (await attendeesOf(env, otherOrganized)).filter((a) => a.partner === partner).map((a) => a.id);
      if (toReset.length) await write(env, "calendar.attendee", toReset, { state: "needsAction" });
    }
    const current = await attendeesOf(env, after.filter((e) => e.active).map((e) => e.id));
    const skip = Boolean(env.context["skip_attendee_notification"]);
    clearPending(env); // the mails below are flushed by the request, as the user
    // :1094-1095 `_get_new_invited_attendees`, :1096-1104 the date-change mail for a future start
    const invited = vals0["is_draft"] === false ? current : current.filter((a) => !previous.some((p) => p.id === a.id));
    if (!skip && invited.length) {
      if (structural) await refuseAttendeeMails(env, invited, true, "calendar invitation emails of a recurrence rewrite");
      else await sendInvitationEmails(env, invited);
    }
    if (!skip && !env.context["is_calendar_event_new"] && "start" in vals && typeof vals["start"] === "string" && vals["start"]) {
      const now = datetimeToString(await dbNow(env));
      if (vals["start"].slice(0, 19) >= now) {
        const kept = current.filter((a) => previous.some((p) => p.id === a.id));
        if (structural) await refuseAttendeeMails(env, kept, false, "calendar date change emails of a recurrence rewrite");
        // :1100-1102 sets `calendar_template_ignore_recurrence` on the attendees, but the template renders in the
        // environment of the template record (`self.env.ref(...)` here, mail_render_mixin `_render_eval_context`), whose
        // context does not have it: the recurrence's "When" row always shows (measured: opus11_cal's self_only move)
        else await notifyAttendees(env, kept, "calendar.calendar_template_meeting_changedate", true);
      }
    }
    if ((await env.cr.query("SELECT 1 FROM calendar_event WHERE id = ANY($1::int[]) AND videocall_channel_id IS NOT NULL LIMIT 1", [ids])).rows.length
      && ("name" in vals || updateTime || "videocall_location" in vals)) throw new NotPorted("calendar.event write with a video call channel");
    if (vals["active"] === false) {
      const recurrences = await recurrencesOfBase(env, ids);
      if (recurrences.length) await selectNewBaseEvent(env, recurrences);
    }
    } finally {
      if (structural) NESTED_REFUSAL.delete(env.cr);
      clearPending(env);
    }
  },
  // calendar_event.py:809-968 for events without activity or other attendees to invite
  create: async (env0, valsList, next) => {
    const env = env0.withContext({ ...env0.context, is_calendar_event_new: true });
    const defaults = await defaultGet(env, "calendar.event", ["meeting_activity_ids", "allday", "description", "name", "partner_ids", "res_model_id", "res_id", "start", "user_id"]);
    const self = (await userInfo(env)).partnerId;
    const prepared = valsList.map((vals0) => ({
      ...resRecordValues(vals0), allday: vals0["allday"] ?? defaults["allday"] ?? false, description: vals0["description"] ?? defaults["description"] ?? false,
      is_draft: vals0["is_draft"] ?? false, name: vals0["name"] ?? defaults["name"] ?? false, res_id: vals0["res_id"] || defaults["res_id"] || 0,
      res_model: vals0["res_model"] ?? defaults["res_model"] ?? false, res_model_id: vals0["res_model_id"] ?? defaults["res_model_id"] ?? false,
      start: vals0["start"] ?? defaults["start"] ?? false, user_id: vals0["user_id"] ?? defaults["user_id"] ?? env.uid,
      ...((vals0["meeting_activity_ids"] ?? defaults["meeting_activity_ids"]) !== undefined ? { meeting_activity_ids: vals0["meeting_activity_ids"] ?? defaults["meeting_activity_ids"] } : {}),
    } as Record<string, unknown>));
    await meetingActivityValues(env, prepared);
    const attendeesOfVals: number[][] = [];
    for (const vals of prepared) {
      // :891-899 attendee commands given are kept as they are; only the empty set of `copy` (:1226) is ported
      const givenAttendees = vals["attendee_ids"];
      const emptySet = Array.isArray(givenAttendees) && givenAttendees.length === 1 && Array.isArray(givenAttendees[0])
        && givenAttendees[0][0] === 6 && Array.isArray(givenAttendees[0][2]) && givenAttendees[0][2].length === 0;
      if (pyTruthy(givenAttendees) && !emptySet) throw new NotPorted("calendar.event created with attendee commands");
      if (vals["recurrency"] && vals["allday"]) throw new NotPorted("an all-day recurrence");
      if (typeof vals["videocall_location"] === "string" && vals["videocall_location"] && !/^https?:/.test(vals["videocall_location"])) {
        // :720-729 _set_videocall_location: a relative url on the base url
        const base = (await configParam(env, "web.base.url")) ?? "";
        const path = vals["videocall_location"];
        vals["videocall_location"] = `${base}${path.startsWith("/") ? "" : "/"}${path}`;
      }
      const partners = emptySet ? [] : partnersOfCommands(vals["partner_ids"] ?? defaults["partner_ids"] ?? [[4, self]]);
      attendeesOfVals.push(partners);
      if (!emptySet) vals["attendee_ids"] = partners.map((partner_id) => [0, 0, { partner_id }]);
      if (!env.context["skip_contact_description"]) {
        const contact = await contactDescription(env, typeof vals["user_id"] === "number" ? vals["user_id"] : null, partners);
        if (!isHtmlEmpty(contact)) {
          const base = isHtmlEmpty(vals["description"]) ? "" : `${String(vals["description"])}<br/>`;
          vals["description"] = `<div>${base}${contact}</div>`;
        }
      }
    }
    // :929-938: the events without recurrence first, then the recurring ones (follow_recurrence), each with super().create;
    // the recurrent fields (non-stored computes) are popped for the recurrence
    const order = [...prepared.keys()].filter((i) => !prepared[i]!["recurrency"]).concat([...prepared.keys()].filter((i) => prepared[i]!["recurrency"]));
    const recurrenceValuesOf = new Map<number, Record<string, unknown>>();
    for (const i of order) {
      const vals = prepared[i]!;
      if (vals["recurrency"]) vals["follow_recurrence"] = true;
      const rv: Record<string, unknown> = {};
      for (const f of RECURRENT_FIELDS) if (f in vals) { rv[f] = vals[f]; delete vals[f]; }
      recurrenceValuesOf.set(i, rv);
    }
    const plain = order.filter((i) => !prepared[i]!["recurrency"]), recurring = order.filter((i) => prepared[i]!["recurrency"]);
    const idOf = new Map<number, number>();
    for (const group of [plain, recurring]) {
      if (!group.length) continue;
      const created = await next(env, group.map((i) => prepared[i]!));
      group.forEach((i, k) => idOf.set(i, created[k]!));
    }
    // :373-380 _compute_alarm_ids, a stored many2many the recompute queue does not reach
    const alarm = await env.reg.xmlid(env.cr, "calendar.alarm_notif_1");
    for (const i of order) {
      if (alarm !== null && !prepared[i]!["alarm_ids"] && !prepared[i]!["allday"]) {
        await env.cr.query("INSERT INTO calendar_alarm_calendar_event_rel (calendar_event_id, calendar_alarm_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [idOf.get(i), alarm]);
      }
    }
    // :940-944 `_apply_recurrence_values` of each recurring event; the events it detaches are archived
    for (const i of recurring) {
      const detached = await applyRecurrenceValues(env.withContext({ ...env.context, skip_contact_description: true }), [idOf.get(i)!], recurrenceValuesOf.get(i)!);
      if (detached.length) await write(env, "calendar.event", detached, { active: false });
    }
    // :946 _send_invitation_emails, calendar_attendee.py:114-121, for a future event
    const ids = order.map((i) => idOf.get(i)!);
    try {
    if (NESTED_REFUSAL.has(env.cr)) await refuseAttendeeMails(env, await attendeesOf(env, ids), true, "calendar invitation emails of a recurrence rewrite");
    else {
      // pending at the first alarm notification's flush (src/models/calendar_flush.ts): the events (their stored computes),
      // the attendees of them and of their occurrences, the recurrences; then the invitations' attachments
      const recurrences = [...new Set((await readEvents(env, ids)).map((e) => e.recurrence_id).filter((r): r is number => r !== null))];
      const all = [...new Set([...ids, ...(await env.cr.query<{ id: number }>("SELECT id FROM calendar_event WHERE recurrence_id = ANY($1::int[])", [recurrences])).rows.map((r) => r.id)])];
      markPending(env, "calendar.event", ids);
      markPending(env, "calendar.recurrence", recurrences);
      markPending(env, "calendar.attendee", (await env.cr.query<{ id: number }>("SELECT id FROM calendar_attendee WHERE event_id = ANY($1::int[])", [all])).rows.map((r) => r.id));
      await sendInvitationEmails(env, await attendeesOf(env, ids));
    }
    // :948-955 the activities of the events given existing ones (a command other than a creation) follow the event
    const toSync = order.filter((i) => Array.isArray(prepared[i]!["meeting_activity_ids"])
      && (prepared[i]!["meeting_activity_ids"] as unknown[]).some((c) => !Array.isArray(c) || c[0] !== 0)).map((i) => idOf.get(i)!);
    if (toSync.length) await syncActivities(env, toSync, new Set(prepared.flatMap((v) => Object.keys(v))));
    // :960-966: an all-day event comes here through its dates' inverse (`write`); the recurring ones by their recurrence
    if (!env.context["dont_notify"]) {
      const alarmEvents = await readEvents(env, order.filter((i) => !prepared[i]!["allday"]).map((i) => idOf.get(i)!));
      const recurrences = [...new Set(alarmEvents.map((e) => e.recurrence_id).filter((r): r is number => r !== null))];
      if (recurrences.length) await setupRecurrenceAlarms(env, recurrences);
      await setupAlarms(env, alarmEvents.filter((e) => e.recurrence_id === null).map((e) => e.id));
    }
    } finally {
      clearPending(env);
    }
    return ids;
  },
});

/** calendar_event.py:1620-1628 `_get_activity_deadline_from_start`: the start's day in the context's zone (not all day). */
function activityDeadline(env: Environment, start: string, allday: boolean): string {
  const tz = typeof env.context["tz"] === "string" && env.context["tz"] ? env.context["tz"] : null;
  if (!tz || allday) return start.slice(0, 10);
  if (validTz(tz) === null) throw new NotPorted(`calendar activity deadline in the unknown zone ${tz}`);
  return todayInTz(new Date(`${start.slice(0, 19).replace(" ", "T")}Z`), tz);
}

/**
 * calendar_event.py:834-887: an event created on a document (res_model_id/res_id of a model with activities) gets a
 * meeting activity there, unless created from activities (`meeting_activity_ids`) other than the one being
 * rescheduled (`orig_activity_ids`, the activity's own type kept).
 */
async function meetingActivityValues(env: Environment, valsList: Record<string, unknown>[]): Promise<void> {
  const typeIds = await env.model("mail.activity.type").search(cond("category", "=", "meeting"));
  if (!typeIds.length) return;
  const typeModel = new Map((await env.cr.query<{ id: number; res_model: string | null }>(
    "SELECT id, res_model FROM mail_activity_type WHERE id = ANY($1::int[])", [typeIds])).rows.map((r) => [r.id, r.res_model]));
  const modelIds = [...new Set(valsList.map((v) => v["res_model_id"]).filter((m): m is number => typeof m === "number" && m > 0))];
  const models = new Map((await env.cr.query<{ id: number; model: string; is_mail_activity: boolean | null }>(
    "SELECT id, model, is_mail_activity FROM ir_model WHERE id = ANY($1::int[])", [modelIds])).rows.map((r) => [r.id, r]));
  let existingEvent = false, existingType: { id: number; res_model: string | null } | null = null;
  const orig = env.context["orig_activity_ids"];
  if (Array.isArray(orig) && orig.length === 1) {
    const row = (await env.cr.query<{ ev: number | null; type: number | null; category: string | null; res_model: string | null }>(
      `SELECT a.calendar_event_id AS ev, t.id AS type, t.category, t.res_model FROM mail_activity a
         LEFT JOIN mail_activity_type t ON t.id = a.activity_type_id WHERE a.id = $1`, [orig[0]])).rows[0];
    existingEvent = row?.ev != null;
    if (existingEvent && row!.category === "meeting" && row!.type !== null) existingType = { id: row!.type, res_model: row!.res_model };
  } else if (Array.isArray(orig) && orig.length > 1) throw new NotPorted("calendar.event create with several orig_activity_ids");
  for (const values of valsList) {
    if (pyTruthy(values["meeting_activity_ids"]) && !existingEvent) continue;
    const model = typeof values["res_model_id"] === "number" ? models.get(values["res_model_id"]) : undefined;
    const resId = values["res_id"];
    if (!model || !resId || !model.is_mail_activity) continue;
    let typeId: number | null = null;
    if (existingType && (existingType.res_model === null || existingType.res_model === model.model)) typeId = existingType.id;
    if (typeId === null) typeId = typeIds.find((t) => { const m = typeModel.get(t); return m === null || m === model.model; }) ?? null;
    if (typeId === null) continue;
    const activity: Record<string, unknown> = { res_model_id: values["res_model_id"], res_id: resId, activity_type_id: typeId };
    if (values["description"]) activity["note"] = values["description"];
    if (values["is_draft"] && values["name"]) activity["summary"] = translate(env, "[Draft] %s").replace("%s", String(values["name"]));
    else if (values["is_draft"]) activity["summary"] = translate(env, "[Draft]");
    else if (values["name"]) activity["summary"] = values["name"];
    if (values["start"]) {
      if (typeof values["start"] !== "string") throw new NotPorted("calendar.event meeting activity of a start that is not a string");
      activity["date_deadline"] = activityDeadline(env, values["start"], Boolean(values["allday"]));
    }
    if (values["user_id"]) activity["user_id"] = values["user_id"];
    values["meeting_activity_ids"] = [[0, 0, activity]];
  }
}

/** calendar_event.py:1597-1617 `_sync_activities`: the events' meeting activities follow their summary, note, day, user. */
async function syncActivities(env: Environment, ids: readonly number[], fields: ReadonlySet<string>): Promise<void> {
  for (const id of ids) {
    const acts = (await env.cr.query<{ id: number }>("SELECT id FROM mail_activity WHERE calendar_event_id = $1 ORDER BY id", [id])).rows.map((r) => r.id);
    if (!acts.length) continue;
    const row = (await env.cr.query<{ is_draft: boolean | null; name: string | null; description: string | null; start: string | null; allday: boolean | null; user_id: number | null }>(
      "SELECT is_draft, name, description, to_char(start, 'YYYY-MM-DD HH24:MI:SS') AS start, allday, user_id FROM calendar_event WHERE id = $1", [id])).rows[0]!;
    const v: Record<string, unknown> = {};
    if (fields.has("is_draft") || fields.has("name")) {
      if (row.is_draft && row.name) v["summary"] = translate(env, "[Draft] %s").replace("%s", row.name);
      else if (row.is_draft) v["summary"] = translate(env, "[Draft]");
      else if (row.name) v["summary"] = row.name;
    }
    if (fields.has("description")) v["note"] = row.description ?? false;
    if (fields.has("start") && !env.context["mail_activity_meeting_update"]) {
      if (row.start === null) throw new NotPorted("calendar.event meeting activity of an event without start");
      v["date_deadline"] = activityDeadline(env, row.start, Boolean(row.allday));
    }
    if (fields.has("user_id")) v["user_id"] = row.user_id ?? false;
    if (Object.keys(v).length) await write(env.withContext({ ...env.context, calendar_event_meeting_update: true }), "mail.activity", acts, v);
  }
}

/** Whether a create of these values gives the event a meeting activity (crm/models/calendar.py:38-44 logs the meeting
 *  on the opportunity otherwise). */
export async function getsMeetingActivity(env: Environment, vals: Readonly<Record<string, unknown>>): Promise<boolean> {
  if (pyTruthy(vals["meeting_activity_ids"])) return true;
  const copy: Record<string, unknown>[] = [{ ...vals }];
  await meetingActivityValues(env, copy);
  return pyTruthy(copy[0]!["meeting_activity_ids"]);
}

// mail.thread's create (followers, the creation message) is inside `super().create()`, before the recurrence's
// occurrences are created (calendar_event.py:929-944)
HOOKS_INSIDE.add("calendar.event");

/** The attendees of the events (calendar.attendee ids with their partner, email and event). */
async function attendeesOf(env: Environment, ids: readonly number[]): Promise<{ id: number; partner: number; email: string | null; event: number }[]> {
  if (!ids.length) return [];
  return (await env.cr.query<{ id: number; partner: number; email: string | null; event: number }>(
    `SELECT a.id, a.partner_id AS partner, p.email, a.event_id AS event FROM calendar_attendee a JOIN res_partner p ON p.id = a.partner_id
      WHERE a.event_id = ANY($1::int[]) ORDER BY a.id`, [ids])).rows.map((r) => ({ id: Number(r.id), partner: Number(r.partner), email: r.email, event: Number(r.event) }));
}

/** The cursors inside a recurrence rewrite of `write`, whose nested creates keep refusing the invitations. */
const NESTED_REFUSAL = new WeakSet<object>();

async function eventDurations(env: Environment, ids: readonly number[]): Promise<Map<number, string | null>> {
  return new Map((await env.cr.query<{ id: number; d: string | null }>("SELECT id, duration::text AS d FROM calendar_event WHERE id = ANY($1::int[])", [ids])).rows.map((r) => [r.id, r.d]));
}

/** The partners of the events and of their recurrences' events (archived too). */
async function recurrencePartners(env: Environment, ids: readonly number[]): Promise<number[]> {
  return (await env.cr.query<{ p: number }>(
    `SELECT DISTINCT rel.res_partner_id AS p FROM calendar_event_res_partner_rel rel JOIN calendar_event e ON e.id = rel.calendar_event_id
      WHERE e.id = ANY($1::int[]) OR e.recurrence_id IN (SELECT recurrence_id FROM calendar_event WHERE id = ANY($1::int[]) AND recurrence_id IS NOT NULL)`, [ids])).rows.map((r) => r.p);
}

/**
 * calendar_attendee.py:114-210 `_send_invitation_emails` / `_notify_attendees`: a mail goes to every attendee with an
 * email other than the user, of a non-draft event (`_skip_send_mail_status_update`), unless `calendar.block_mail` or
 * `no_mail_to_attendees`; invitations only for future events. Not ported: refused when one would go.
 */
async function refuseAttendeeMails(env: Environment, attendees: readonly { partner: number; email: string | null; event: number }[], futureOnly: boolean, what: string): Promise<void> {
  if (env.context["no_mail_to_attendees"]) return;
  const self = (await userInfo(env)).partnerId;
  const others = attendees.filter((a) => a.email && a.partner !== self);
  if (!others.length) return;
  // ir_config_parameter.py:100-105 get_bool: a typed value (not ported: refused when set at all)
  if ((await configParam(env.sudo(), "calendar.block_mail")) !== null) throw new NotPorted("calendar.block_mail set");
  const now = datetimeToString(await dbNow(env));
  const events = (await env.cr.query<{ id: number; draft: boolean | null; start: string }>(
    "SELECT id, is_draft AS draft, to_char(start, 'YYYY-MM-DD HH24:MI:SS') AS start FROM calendar_event WHERE id = ANY($1::int[])", [[...new Set(others.map((a) => a.event))]])).rows;
  if (events.some((e) => !e.draft && (!futureOnly || e.start > now))) throw new NotPorted(what);
}

defineComputes("calendar.attendee", {
  // calendar_attendee.py:46-49, :51-53
  common_name: async (_env, rec) => {
    const partner = await rec.rel("partner_id");
    return (partner && await partner.get("name")) || rec.get("email");
  },
  mail_tz: async (_env, rec) => (await rec.rel("partner_id"))?.get("tz") ?? false,
});

registerDefaults("calendar.attendee", { access_token: async () => crypto.randomUUID().replace(/-/g, "") }); // calendar_attendee.py _default_access_token

// calendar_attendee.py:56-69 create: the organizer's own attendee is accepted
registerOverrides("calendar.attendee", {
  create: async (env, valsList, next) => {
    const self = (await userInfo(env)).partnerId;
    for (const vals of valsList) {
      if (!("state" in vals) && vals["partner_id"] === self) vals["state"] = "accepted";
      if (!vals["email"] && vals["common_name"]) throw new NotPorted("calendar.attendee with a common name and no email");
    }
    return next(env, valsList);
  },
  // calendar_attendee.py:76-78 unlink, :83-87 `_unsubscribe_partner`: the attendees' partners that follow the event
  // stop following it (`message_unsubscribe`, mail_thread.py:4917-4933)
  unlink: async (env, ids, next) => {
    const rows = (await env.cr.query<{ event: number | null; partner: number | null }>(
      `SELECT a.event_id AS event, a.partner_id AS partner FROM calendar_attendee a
        JOIN mail_followers f ON f.res_model = 'calendar.event' AND f.res_id = a.event_id AND f.partner_id = a.partner_id
        WHERE a.id = ANY($1::int[]) ORDER BY a.event_id`, [[...ids]])).rows;
    const byEvent = new Map<number, number[]>();
    for (const r of rows) if (r.event !== null && r.partner !== null) (byEvent.get(r.event) ?? byEvent.set(r.event, []).get(r.event)!).push(r.partner);
    const self = (await userInfo(env)).partnerId;
    for (const [event, partners] of byEvent) {
      // :4925-4928 others need write access on the event, an internal user may unfollow themselves
      if (!(new Set(partners).size === 1 && partners[0] === self)) await env.model("calendar.event").checkAccess([event], "write");
      else if (!(await userFlags(env.cr, env.uid)).isInternal) await env.model("calendar.event").checkAccess([event], "read");
      await deleteFollowers(env, "calendar.event", [event], partners);
    }
    return next(env, ids);
  },
});

/**
 * calendar_event.py:1219-1230 `copy`: the events copied without attendees (`skip_contact_description`), then each
 * copy's `partner_ids` set to its original's (the `write` above makes their attendees, invitations and alarms).
 * Events of a recurrence or with a video call channel refuse (their copies would share them).
 */
async function copyEvents(env: Environment, ids: readonly number[], dflt: Record<string, unknown>): Promise<number[]> {
  if ((await env.cr.query("SELECT 1 FROM calendar_event WHERE id = ANY($1::int[]) AND (recurrence_id IS NOT NULL OR videocall_channel_id IS NOT NULL) LIMIT 1", [[...ids]])).rows.length) {
    throw new NotPorted("copy of a calendar.event of a recurrence or with a video call channel");
  }
  const field = env.reg.model("calendar.event").fields.get("partner_ids")!;
  const created = await copy(env.withContext({ ...env.context, skip_contact_description: true }), "calendar.event", ids,
    { ...dflt, partner_ids: [[6, 0, []]], attendee_ids: [[6, 0, []]] }, true);
  const partners = await new ModelImpl(env, env.reg.model("calendar.event")).values(ids, field);
  for (let i = 0; i < ids.length && i < created.length; i++) {
    await write(env.withContext({ ...env.context, skip_contact_description: true }), "calendar.event", [created[i]!], { partner_ids: [[6, 0, (partners.get(ids[i]!) as number[] | undefined) ?? []]] });
  }
  return created;
}

registerMethod("calendar.event", "copy", async (env0, ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const dflt = kwargs["default"] ?? args[0];
  if (dflt !== undefined && dflt !== null && dflt !== false && (typeof dflt !== "object" || Array.isArray(dflt))) throw new NotPorted("copy default");
  return copyEvents(env, ids ?? [], (dflt && typeof dflt === "object" ? dflt : {}) as Record<string, unknown>);
}, { apiModel: false });

defineComputes("calendar.event", {
  // calendar_event.py:668-684 `_compute_google_calendar_url` (werkzeug url_encode: quote_plus per value), with
  // `_get_customer_summary` / `_get_customer_description` (:2073-2085)
  google_calendar_url: async (_env, rec) => {
    const compact = (v: unknown): string => String(v ?? "").replace(/[-: ]/g, "");
    const allday = Boolean(await rec.get("allday"));
    const start = allday ? compact(await rec.get("start_date")) : `${compact(String(await rec.get("start")).slice(0, 19)).replace(/^(\d{8})/, "$1T")}Z`;
    const stop = allday ? compact(await rec.get("stop_date")) : `${compact(String(await rec.get("stop")).slice(0, 19)).replace(/^(\d{8})/, "$1T")}Z`;
    const description = await rec.get("description");
    const details = isHtmlEmpty(description) ? "" : htmlSanitize(String(description), SANITIZE_DEFAULT);
    const params: [string, string][] = [["action", "TEMPLATE"], ["text", String((await rec.get("name")) || "")], ["dates", `${start}/${stop}`], ["details", details]];
    const location = await rec.get("location");
    if (location) params.push(["location", String(location).replaceAll(", ", " ")]);
    return `https://www.google.com/calendar/render?${params.map(([k, v]) => `${quotePlus(k)}=${quotePlus(v)}`).join("&")}`;
  },
});
