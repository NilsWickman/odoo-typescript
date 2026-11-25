/**
 * The subset of dateutil 2.8.2's `rrule` (dateutil/rrule.py) that calendar_recurrence.py:592-636 `_get_rrule` builds:
 * DAILY, WEEKLY (BYDAY of plain weekdays, WKST), MONTHLY (BYMONTHDAY of one positive day, or BYDAY of one weekday with
 * an occurrence +1..+4 or -1), YEARLY (no BY rule: dateutil fills BYMONTH and BYMONTHDAY from DTSTART), with INTERVAL,
 * COUNT or UNTIL; its iteration (`_iter`: periods from DTSTART, the days of each period in order at DTSTART's time,
 * counted from DTSTART on), `__str__` (:700-760) and the parts of `rrulestr` that `_rrule_parse` reads back.
 * Checked against dateutil on random rules (src/models/rrule.test.ts).
 */
import { NotPorted } from "../errors";
import type { Naive } from "../web/tz";

export type Freq = "daily" | "weekly" | "monthly" | "yearly";
const FREQ_NAMES: Record<Freq, string> = { daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY", yearly: "YEARLY" };
/** dateutil weekday indexes: 0 = MO ... 6 = SU. */
export const WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

export interface RRule {
  freq: Freq;
  dtstart: Naive;
  interval: number;
  /** `wkst=None` is calendar.firstweekday(), Monday (0). */
  wkst: number | null;
  count: number | null;
  /** `datetime.combine(until, time.max)`: every time of this date is before it. */
  until: { year: number; month: number; day: number } | null;
  /** WEEKLY: plain weekdays, in the order given. */
  byweekday: number[] | null;
  /** MONTHLY: one weekday with its occurrence in the month. */
  bynweekday: [number, number] | null;
  /** MONTHLY: one day of the month (1-31). */
  bymonthday: number | null;
}

function ordinal(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function fromOrdinal(o: number): { year: number; month: number; day: number } {
  const dt = new Date(o * 86400000);
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

/** Python's `date.weekday()`: Monday 0. */
export function weekdayOf(y: number, m: number, d: number): number {
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

function monthLength(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function cmpNaive(a: Naive, b: Naive): number {
  const ka = [a.year, a.month, a.day, a.hour, a.minute, a.second], kb = [b.year, b.month, b.day, b.hour, b.minute, b.second];
  for (let i = 0; i < 6; i++) if (ka[i] !== kb[i]) return ka[i]! - kb[i]!;
  return 0;
}

const MAXYEAR = 9999;

/** `list(rrule)` (bounded by COUNT or UNTIL, as every rule Odoo builds is). */
export function occurrences(r: RRule): Naive[] {
  if (r.count === null && r.until === null) throw new NotPorted("an rrule without COUNT or UNTIL");
  if (r.interval < 1) throw new NotPorted(`rrule interval ${r.interval}`);
  const s = r.dtstart;
  const time = { hour: s.hour, minute: s.minute, second: s.second };
  const wkst = r.wkst ?? 0;
  // rrule.py:470-490 the defaults of a rule without BY parts
  const byweekday = r.freq === "weekly" ? (r.byweekday ?? [weekdayOf(s.year, s.month, s.day)]) : null;
  const yearlyMonth = s.month, yearlyDay = s.day;
  const out: Naive[] = [];
  let count = r.count;
  const untilOrd = r.until ? ordinal(r.until.year, r.until.month, r.until.day) : null;
  const startOrd = ordinal(s.year, s.month, s.day);

  /** The period's days in order; false when the iteration is over. */
  const emit = (days: number[]): boolean => {
    for (const o of days) {
      if (untilOrd !== null && o > untilOrd) return false;
      const d = fromOrdinal(o);
      const res: Naive = { ...d, ...time };
      if (cmpNaive(res, s) >= 0) {
        if (count !== null) {
          count -= 1;
          if (count < 0) return false;
        }
        out.push(res);
      }
    }
    return true;
  };

  for (let k = 0; ; k++) {
    let days: number[];
    let year: number;
    switch (r.freq) {
      case "daily": {
        const o = startOrd + k * r.interval;
        year = fromOrdinal(o).year;
        days = [o];
        break;
      }
      case "weekly": {
        // rrule.py:1130-1146 wdayset: the first period runs from DTSTART to the day before the next WKST; the next ones
        // start on WKST (rrule.py:866-872: back to the week start, then INTERVAL weeks on)
        const wd = weekdayOf(s.year, s.month, s.day);
        let first: number, len: number;
        if (k === 0) {
          first = startOrd;
          len = 0;
          for (let j = 0; j < 7; j++) {
            len++;
            if ((wd + j + 1) % 7 === wkst) break;
          }
        } else {
          first = startOrd - ((wd - wkst + 7) % 7) + k * r.interval * 7;
          len = 7;
        }
        year = fromOrdinal(first).year;
        days = [];
        for (let i = 0; i < len; i++) {
          const o = first + i;
          const d = fromOrdinal(o);
          if (byweekday!.includes(weekdayOf(d.year, d.month, d.day))) days.push(o);
        }
        break;
      }
      case "monthly": {
        const mIndex = s.month - 1 + k * r.interval;
        year = s.year + Math.floor(mIndex / 12);
        const month = (mIndex % 12) + 1;
        const len = monthLength(year, month);
        days = [];
        if (r.bymonthday !== null) {
          if (r.bymonthday >= 1 && r.bymonthday <= len) days.push(ordinal(year, month, r.bymonthday));
        } else if (r.bynweekday !== null) {
          const [wdTarget, n] = r.bynweekday;
          const matching: number[] = [];
          for (let d = 1; d <= len; d++) if (weekdayOf(year, month, d) === wdTarget) matching.push(ordinal(year, month, d));
          const pick = n > 0 ? matching[n - 1] : matching[matching.length + n];
          if (pick !== undefined) days.push(pick);
        } else {
          if (s.day <= len) days.push(ordinal(year, month, s.day));
        }
        break;
      }
      case "yearly": {
        year = s.year + k * r.interval;
        days = yearlyDay <= monthLength(year, yearlyMonth) ? [ordinal(year, yearlyMonth, yearlyDay)] : [];
        break;
      }
    }
    if (year > MAXYEAR) break;
    if (!emit(days)) break;
  }
  return out;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

function compact(n: Naive): string {
  return `${pad(n.year, 4)}${pad(n.month)}${pad(n.day)}T${pad(n.hour)}${pad(n.minute)}${pad(n.second)}`;
}

/** rrule.py:700-760 `__str__`. */
export function rruleString(r: RRule): string {
  const parts = [`FREQ=${FREQ_NAMES[r.freq]}`];
  if (r.interval !== 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.wkst) parts.push(`WKST=${WEEKDAY_CODES[r.wkst]}`); // Monday (0) is falsy: not written
  if (r.count !== null) parts.push(`COUNT=${r.count}`);
  if (r.until) parts.push(`UNTIL=${compact({ ...r.until, hour: 23, minute: 59, second: 59 })}`);
  if (r.bymonthday !== null) parts.push(`BYMONTHDAY=${r.bymonthday}`);
  // rrule.py:530-540: `_original_rule["byweekday"]` is the sorted weekdays
  if (r.byweekday !== null) parts.push(`BYDAY=${[...new Set(r.byweekday)].sort((a, b) => a - b).map((w) => WEEKDAY_CODES[w]).join(",")}`);
  else if (r.bynweekday !== null) parts.push(`BYDAY=${r.bynweekday[1] > 0 ? "+" : ""}${r.bynweekday[1]}${WEEKDAY_CODES[r.bynweekday[0]]}`);
  return `DTSTART:${compact(r.dtstart)}\nRRULE:${parts.join(";")}`;
}

/** What calendar_recurrence.py:384-438 `_rrule_parse` reads from `rrulestr(rule)`: the rule's own parts. */
export interface ParsedRule {
  freq: Freq;
  interval: number;
  count: number | null;
  until: { year: number; month: number; day: number; hour: number; minute: number; second: number } | null;
  byweekday: number[] | null;
  bynweekday: [number, number][] | null;
  bymonthday: number[] | null;
  dtstart: Naive | null;
}

/** `rrulestr` of a "DTSTART:...\nRRULE:..." string as `rruleString` writes it (other forms refuse). */
export function parseRule(text: string): ParsedRule {
  let dtstart: Naive | null = null;
  let rule: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("DTSTART:")) {
      const m = /^DTSTART:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(line);
      if (m === null) throw new NotPorted(`rrule DTSTART ${line}`);
      dtstart = { year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: +m[4]!, minute: +m[5]!, second: +m[6]! };
    } else if (line.startsWith("RRULE:")) {
      if (rule !== null) throw new NotPorted("several RRULE lines");
      rule = line.slice(6);
    } else if (line.trim()) throw new NotPorted(`rrule line ${line}`);
  }
  if (rule === null) throw new NotPorted(`rrule without RRULE: ${text}`);
  const out: ParsedRule = { freq: "daily", interval: 1, count: null, until: null, byweekday: null, bynweekday: null, bymonthday: null, dtstart };
  let freqSeen = false;
  for (const part of rule.split(";")) {
    const [name, value] = part.split("=") as [string, string | undefined];
    if (value === undefined) throw new NotPorted(`rrule part ${part}`);
    switch (name) {
      case "FREQ": {
        const f = (Object.entries(FREQ_NAMES) as [Freq, string][]).find(([, v]) => v === value);
        if (!f) throw new NotPorted(`rrule FREQ=${value}`);
        out.freq = f[0];
        freqSeen = true;
        break;
      }
      case "INTERVAL": out.interval = Number(value); break;
      case "COUNT": out.count = Number(value); break;
      case "WKST": break;
      case "UNTIL": {
        const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(value);
        if (m === null) throw new NotPorted(`rrule UNTIL=${value}`);
        out.until = { year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: +m[4]!, minute: +m[5]!, second: +m[6]! };
        break;
      }
      case "BYMONTHDAY": out.bymonthday = value.split(",").map(Number); break;
      case "BYDAY": {
        const plain: number[] = [], nth: [number, number][] = [];
        for (const v of value.split(",")) {
          const m = /^([+-]?\d)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(v);
          if (m === null) throw new NotPorted(`rrule BYDAY=${value}`);
          const wd = WEEKDAY_CODES.indexOf(m[2] as (typeof WEEKDAY_CODES)[number]);
          if (m[1] === undefined) plain.push(wd);
          else nth.push([wd, Number(m[1])]);
        }
        // rrule.py:543-560: plain weekdays go to _byweekday, numbered ones (outside WEEKLY) to _bynweekday
        if (plain.length) out.byweekday = plain;
        if (nth.length) out.bynweekday = nth;
        break;
      }
      default: throw new NotPorted(`rrule part ${name}`);
    }
  }
  if (!freqSeen) throw new NotPorted(`rrule without FREQ: ${text}`);
  return out;
}
