/**
 * `odoo.tools.date_utils.parse_date` (odoo/odoo/tools/date_utils.py:129-215) for the relative values of domain
 * conditions on date/datetime fields ("today", "-1y", "=1d", "+monday", ...), which domains.py resolves at the
 * DYNAMIC_VALUES level (`_optimize_type_date_relative` :1629, `_optimize_type_datetime_relative` :1739).
 * "now" is the database clock (`Datetime.now()` = `cr.now()` under the harness's frozen clock) seen in the
 * context/user tz; the result is a naive date, or a naive UTC datetime.
 */
import { PyDate, PyDateTime, PyValueError } from "./domain";
import { envCache, userInfo } from "./env";
import { transactionNowUtc } from "./signaling";
import type { Environment } from "./types";

const WEEKDAY_NUMBER: Readonly<Record<string, number>> = {
  monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6,
};
const UNIT: Readonly<Record<string, string>> = { d: "days", m: "months", y: "years", w: "weeks", H: "hours", M: "minutes", S: "seconds" };

/** Wall-clock parts of an instant in `tz`. */
function wall(ms: number, tz: string): [number, number, number, number, number, number] {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const g = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return [g("year"), g("month"), g("day"), g("hour"), g("minute"), g("second")];
}

/** The UTC instant of a wall-clock time in `tz` (the earliest matching offset, as ZoneInfo's fold=0). */
function fromWall(w: number[], tz: string): number {
  const guess = Date.UTC(w[0]!, w[1]! - 1, w[2]!, w[3]!, w[4]!, w[5]!);
  let ms = guess;
  for (let i = 0; i < 3; i++) {
    const back = wall(ms, tz);
    const diff = Date.UTC(back[0], back[1] - 1, back[2], back[3], back[4], back[5]) - guess;
    if (diff === 0) break;
    ms -= diff;
  }
  return ms;
}

export function isRelativeDate(value: string): boolean {
  return !/^\d+-/.test(value);
}

export async function parseRelativeDate(env: Environment, value: string): Promise<PyDate | PyDateTime> {
  const terms = value.split(/\s+/).filter((t) => t !== "");
  if (!terms.length) throw new PyValueError("Empty date value");
  const nowMs = await envCache(env, "orm.db_now_ms", async () => {
    // the request's signaling statement reads it (src/orm/signaling.ts SEQUENCES_SQL)
    return Date.parse(await transactionNowUtc(env.cr));
  });
  const user = await userInfo(env);
  const ctxTz = typeof env.context.tz === "string" && env.context.tz ? env.context.tz : null;
  let tz = ctxTz ?? user.tz ?? "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = "UTC"; }
  // the date in wall-clock parts; `isDate` for 'today' (Date.context_today)
  let w = wall(nowMs, tz);
  let isDate = false;
  if (terms[0] === "today" || terms[0] === "now") {
    isDate = terms.shift() === "today";
    if (isDate) w = [w[0], w[1], w[2], 0, 0, 0];
  }
  const weekday = (): number => (new Date(Date.UTC(w[0], w[1] - 1, w[2])).getUTCDay() + 6) % 7; // Monday = 0
  const addDays = (n: number): void => {
    const d = new Date(Date.UTC(w[0], w[1] - 1, w[2] + n, w[3], w[4], w[5]));
    w = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()];
  };
  const truncateToday = (): void => { if (!isDate) w = [w[0], w[1], w[2], 0, 0, 0]; };
  for (const term of terms) {
    const op = term[0];
    if (!op || !"+-=".includes(op) || term.length < 3) throw new PyValueError(`Invalid term '${term}' in expression date: '${value}'`);
    const dayname = term.slice(1);
    if (dayname in WEEKDAY_NUMBER || dayname === "week_start") {
      const lang = user.lang ?? "en_US";
      const ws = Number((await env.cr.query<{ week_start: string }>("SELECT week_start FROM res_lang WHERE code = $1", [lang])).rows[0]?.week_start ?? 7) - 1;
      const target = dayname === "week_start" ? ws : WEEKDAY_NUMBER[dayname]!;
      let offset = (((target - ws) % 7) + 7) % 7 - (((weekday() - ws) % 7) + 7) % 7;
      if (op === "+" && offset < 0) offset += 7;
      else if (op === "-" && offset > 0) offset -= 7;
      else if (op === "=") truncateToday();
      addDays(offset);
      continue;
    }
    const unitKey = term[term.length - 1] ?? "";
    const unit = UNIT[unitKey];
    const numText = op === "=" ? term.slice(1, -1) : term.slice(0, -1);
    if (unit === undefined || !/^[+-]?\d+$/.test(numText)) throw new PyValueError(`Invalid term '${term}' in expression date: '${value}'`);
    const number = parseInt(numText, 10);
    if (op === "=") {
      // relativedelta(<unit>=N) sets the field; datetimes are first truncated (TRUNCATE_UNIT)
      if (!isDate) {
        if (["days", "months", "years", "weeks"].includes(unit)) w = [w[0], w[1], w[2], 0, 0, 0];
        else if (unit === "hours") w = [w[0], w[1], w[2], w[3], 0, 0];
        else if (unit === "minutes") w = [w[0], w[1], w[2], w[3], w[4], 0];
      }
      if (unit === "weeks") throw new PyValueError(`Invalid term '${term}' in expression date: '${value}'`); // relativedelta(week=)
      const idx = { years: 0, months: 1, days: 2, hours: 3, minutes: 4, seconds: 5 }[unit as "years"]!;
      if (isDate && idx > 2) throw new PyValueError(`Invalid term '${term}' in expression date: '${value}'`);
      w = [...w] as typeof w;
      w[idx] = number;
      // relativedelta clamps the day to the month's length
      const last = new Date(Date.UTC(w[0], w[1], 0)).getUTCDate();
      if (w[2] > last) w[2] = last;
      continue;
    }
    if (isDate && ["hours", "minutes", "seconds"].includes(unit)) throw new PyValueError(`Invalid term '${term}' in expression date: '${value}'`);
    if (unit === "months" || unit === "years") {
      const months = unit === "years" ? number * 12 : number;
      const total = w[0] * 12 + (w[1] - 1) + months;
      const y = Math.floor(total / 12), m = total - y * 12 + 1;
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      w = [y, m, Math.min(w[2], last), w[3], w[4], w[5]];
    } else if (unit === "days" || unit === "weeks") {
      addDays(unit === "weeks" ? number * 7 : number);
    } else {
      const sec = unit === "hours" ? 3600 : unit === "minutes" ? 60 : 1;
      if (isDate) throw new PyValueError(`Invalid term '${term}' in expression date: '${value}'`);
      // aware datetime + timedelta: wall-clock addition in the zone (no DST normalization, as Python)
      const d = new Date(Date.UTC(w[0], w[1] - 1, w[2], w[3], w[4], w[5]) + number * sec * 1000);
      w = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()];
    }
  }
  if (isDate) return new PyDate(Date.UTC(w[0], w[1] - 1, w[2]));
  return new PyDateTime(fromWall(w, tz));
}
