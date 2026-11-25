/**
 * calendar.alarm_manager (calendar/models/calendar_alarm_manager.py): the next reminders of a user, sent on the bus when
 * an event changes (`_setup_alarms`, calendar_event.py:1647-1668) and answered on `/calendar/notify`. Email alarms need
 * a cron trigger: refused. The texts exist in en_US only here (others refuse).
 */
import { NotPorted } from "../errors";
import { requestOfCursor } from "../http/context";
import { registerMethod } from "../http/methods";
import { jsonRoute } from "../http/router";
import { busSend } from "../mail/busnotify";
import { cond } from "../orm/domain";
import { userInfo } from "../orm/env";
import type { Environment } from "../orm/types";
import { write } from "../orm/write";
import { envFor } from "../web/common";
import { datetimeToString, dbNow, htmlEscape, translate } from "./util";
import { flushPendingAs } from "./calendar_flush";

const SECOND = 1000, MINUTE = 60 * SECOND;
const utc = (s: string): Date => new Date(`${s.replace(" ", "T")}Z`);
const nowSeconds = async (env: Environment): Promise<Date> => new Date(Math.floor((await dbNow(env)).getTime() / SECOND) * SECOND);

/** misc.py format_date(value, 'd MMMM'), format_time(value, 'short') (res.lang en_US `%I:%M %p`), Date.context_today. */
const dayMonth = (d: Date, tz: string): string => new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric", month: "long" }).formatToParts(d)
  .filter((p) => p.type === "day" || p.type === "month").sort((a, b) => (a.type === "day" ? -1 : b.type === "day" ? 1 : 0)).map((p) => p.value).join(" ");
const clock = (d: Date, tz: string): string => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: true }).formatToParts(d);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("hour").padStart(2, "0")}:${part("minute")} ${part("dayPeriod")}`;
};
const isoDay = (d: Date, tz: string): string => new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

interface Meeting { id: number; name: string | null; start: string; stop: string; location: string | null; duration: number | null }

/** calendar_alarm_manager.py:244-267 `_format_notification_message`. */
function notificationMessage(env: Environment, e: Meeting, body: string | null, now: Date, contextTz: string, userTz: string): string {
  const start = utc(e.start), stop = utc(e.stop);
  const today = isoDay(start, contextTz) === isoDay(now, contextTz);
  const [dateStart, timeStart] = [dayMonth(start, contextTz), clock(start, userTz)];
  const [dateStop, timeStop] = [dayMonth(stop, contextTz), clock(stop, userTz)];
  let schedule: string;
  if (today) schedule = dateStart === dateStop ? `${timeStart} - ${timeStop}` : `${timeStart} - ${dateStop}, ${timeStop}`;
  else schedule = Number(e.duration ?? 0) < 24 ? `${dateStart}, ${timeStart} - ${timeStop}` : `${dateStart}, ${timeStart} - ${dateStop}, ${timeStop}`;
  return `<br/>${htmlEscape(schedule)}<br/>${htmlEscape(e.location || translate(env, "Online"))}<br/>${htmlEscape(body ?? "")}`;
}

/** calendar_alarm_manager.py:198-215 `get_next_notif` with :14-96 `_get_next_potential_limit_alarm` and :98-126. */
export async function nextNotif(env: Environment): Promise<Record<string, unknown>[]> {
  if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated calendar reminders (${env.lang})`);
  const partner = (await userInfo(env)).partnerId;
  const candidates = (await env.cr.query<{ id: number }>(
    `WITH calcul_delta AS (
       SELECT rel.calendar_event_id, max(alarm.duration_minutes) AS max_delta, min(alarm.duration_minutes) AS min_delta
         FROM calendar_alarm_calendar_event_rel rel LEFT JOIN calendar_alarm alarm ON alarm.id = rel.calendar_alarm_id
        WHERE alarm.alarm_type = 'notification' GROUP BY rel.calendar_event_id)
     SELECT cal.id FROM calendar_event cal JOIN calcul_delta d ON d.calendar_event_id = cal.id
       JOIN calendar_event_res_partner_rel p ON p.calendar_event_id = cal.id AND p.res_partner_id = $1
      WHERE cal.active AND cal.start - interval '1' minute * d.max_delta < COALESCE((
              SELECT MIN(c.start - interval '1' minute * x.max_delta) FROM calendar_event c RIGHT JOIN calcul_delta x ON x.calendar_event_id = c.id
               WHERE c.start - interval '1' minute * x.max_delta > now() AT TIME ZONE 'UTC') + interval '3' minute, now() AT TIME ZONE 'UTC')
        AND cal.stop - interval '1' minute * d.min_delta > now() AT TIME ZONE 'UTC'`, [partner])).rows.map((r) => r.id);
  if (!candidates.length) return [];
  const readable = await env.model("calendar.event").search(cond("id", "in", candidates));
  const now = await nowSeconds(env);
  const me = (await env.cr.query<{ tz: string | null; ack: string | null }>(
    `SELECT tz, to_char(calendar_last_notif_ack, 'YYYY-MM-DD HH24:MI:SS') AS ack FROM res_partner WHERE id = $1`, [partner])).rows[0];
  const userTz = me?.tz || "UTC";
  const contextTz = typeof env.context["tz"] === "string" && env.context["tz"] ? env.context["tz"] : userTz;
  const out: Record<string, unknown>[] = [];
  for (const id of candidates.filter((c) => readable.includes(c))) {
    const e = (await env.cr.query<Meeting>(
      `SELECT id, name, to_char(start, 'YYYY-MM-DD HH24:MI:SS') AS start, to_char(stop, 'YYYY-MM-DD HH24:MI:SS') AS stop, location, duration FROM calendar_event WHERE id = $1`, [id])).rows[0]!;
    const start = utc(e.start);
    // do_check_alarm_for_one_date with missing=False: `past` is the start of the event
    if (now.getTime() + 86_400 * SECOND <= start.getTime()) continue;
    if (me?.ack && start.getTime() <= utc(me.ack).getTime()) continue;
    const alarms = await env.sudo().model("calendar.alarm").search(cond("id", "in", (await env.cr.query<{ a: number }>(
      "SELECT calendar_alarm_id AS a FROM calendar_alarm_calendar_event_rel WHERE calendar_event_id = $1", [id])).rows.map((r) => r.a)));
    const rows = (await env.cr.query<{ id: number; alarm_type: string; duration_minutes: number | null; body: string | null }>(
      "SELECT id, alarm_type, duration_minutes, body FROM calendar_alarm WHERE id = ANY($1::int[])", [alarms])).rows;
    for (const alarmId of alarms) {
      const alarm = rows.find((r) => r.id === alarmId)!;
      if (alarm.alarm_type !== "notification") continue;
      const notifyAt = new Date(start.getTime() - Number(alarm.duration_minutes ?? 0) * MINUTE);
      out.push({
        alarm_id: alarm.id, event_id: e.id, title: e.name ?? false, message: notificationMessage(env, e, alarm.body, now, contextTz, userTz),
        timer: Math.floor((notifyAt.getTime() - now.getTime()) / SECOND), notify_at: datetimeToString(notifyAt),
      });
    }
  }
  return out;
}

/** The internal users `_notify_next_alarm` notifies, in its order (res.users 'name, login'). */
async function alarmUsers(env: Environment, partners: readonly number[]): Promise<number[]> {
  const users = await env.model("res.users").search(cond("partner_id", "in", [...partners]));
  const share = new Set((await env.cr.query<{ id: number }>("SELECT id FROM res_users WHERE id = ANY($1::int[]) AND share", [users])).rows.map((r) => r.id));
  return users.filter((u) => !share.has(u));
}

/** The user whose `get_next_notif` flushes first when the alarms of these partners are notified (null: none). */
export async function firstAlarmUser(env: Environment, partners: readonly number[]): Promise<number | null> {
  return partners.length ? (await alarmUsers(env, partners))[0] ?? null : null;
}

/** calendar_alarm_manager.py:234-242 `_notify_next_alarm`. */
export async function notifyNextAlarm(env: Environment, partners: readonly number[]): Promise<void> {
  const request = requestOfCursor(env.cr);
  if (request === null) throw new NotPorted("calendar reminders outside a request");
  const users = await env.model("res.users").search(cond("partner_id", "in", [...partners]));
  for (const user of users) {
    const row = (await env.cr.query<{ share: boolean | null }>("SELECT share FROM res_users WHERE id = $1", [user])).rows[0];
    if (row?.share) continue;
    const companies = (await env.cr.query<{ cid: number }>("SELECT cid FROM res_company_users_rel WHERE user_id = $1 ORDER BY cid", [user])).rows.map((r) => r.cid);
    const asUser = env.withUser(user).withContext({ ...env.context, allowed_company_ids: companies });
    // :205 `get_next_notif` -> :16-18, :65 flush in the user's environment: what is pending gets the user's uid
    await flushPendingAs(env, user);
    await busSend(request, env, { model: "res.users", id: user }, "calendar.alarm", await nextNotif(asUser));
  }
}

/** calendar_event.py:1647-1668 `_setup_alarms` of events with notification alarms only (email alarms refuse). */
export async function setupAlarms(env: Environment, ids: readonly number[]): Promise<void> {
  const now = datetimeToString(await nowSeconds(env));
  const partners = new Set<number>();
  for (const id of ids) {
    const e = (await env.cr.query<{ r: number | null; stop: string }>(
      "SELECT recurrence_id AS r, to_char(stop, 'YYYY-MM-DD HH24:MI:SS') AS stop FROM calendar_event WHERE id = $1", [id])).rows[0];
    if (!e) continue;
    const types = (await env.cr.query<{ t: string }>(
      `SELECT a.alarm_type AS t FROM calendar_alarm_calendar_event_rel r JOIN calendar_alarm a ON a.id = r.calendar_alarm_id WHERE r.calendar_event_id = $1`, [id])).rows.map((r) => r.t);
    // the recurrence's trigger (`existing_trigger`, :1655) only matters to the email alarms' cron triggers
    if (types.includes("email")) throw new NotPorted(`calendar.event with an email alarm (cron trigger${e.r !== null ? " of a recurrence" : ""})`);
    if (!types.includes("notification") || e.stop < now) continue;
    for (const r of (await env.cr.query<{ p: number }>("SELECT res_partner_id AS p FROM calendar_event_res_partner_rel WHERE calendar_event_id = $1", [id])).rows) partners.add(r.p);
  }
  if (partners.size) await notifyNextAlarm(env, [...partners]);
}

registerMethod("calendar.alarm_manager", "get_next_notif", async (env0, _ids, _args, kwargs0) => nextNotif(envFor(env0, kwargs0).env), { apiModel: true });

// calendar/controllers/main.py:114-120
jsonRoute("/calendar/notify", async (ctx) => nextNotif(await ctx.orm()));
jsonRoute("/calendar/notify_ack", async (ctx) => {
  const env = await ctx.orm();
  await write(env.sudo(), "res.partner", [(await userInfo(env)).partnerId], { calendar_last_notif_ack: datetimeToString(await dbNow(env)) });
  return null;
});
