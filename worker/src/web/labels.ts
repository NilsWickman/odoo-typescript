/**
 * Group labels of date/datetime groupbys (`odoo/addons/web/models/models.py:1428-1470` formatter_time_granularity):
 * `babel.dates.format_date/format_datetime` with `READ_GROUP_DISPLAY_FORMAT` (odoo/odoo/orm/models.py:344) and the
 * week rule of `odoo/odoo/tools/date_utils.py:449 weeknumber`. The CLDR names come from stream G's tables
 * (worker/gen/out/cldr.json, generated from babel's locale-data per ruling O1); this module only consumes the
 * `CldrLocale` interface below and refuses to format without data (no hand-typed tables).
 */
import { NotPorted } from "../errors";
import { isRecord } from "./common";
import { type Naive, formatNaive } from "./tz";

export interface CldrLocale {
  readonly code: string;
  /** `Locale.months['format']['wide'][1..12]` */
  readonly monthsWide: readonly string[];
  /** `Locale.months['format']['abbreviated'][1..12]` */
  readonly monthsAbbreviated: readonly string[];
  /** `Locale.quarters['format']['abbreviated'][1..4]` */
  readonly quartersAbbreviated: readonly string[];
  /** `Locale.first_week_day`: 0 = Monday ... 6 = Sunday */
  readonly firstWeekDay: number;
  /** `Locale.min_week_days` */
  readonly minWeekDays: number;
}

export type Granularity = "hour" | "day" | "week" | "month" | "quarter" | "year";

/** models.py:344 READ_GROUP_DISPLAY_FORMAT (the week format is replaced by weeknumber(), models.py:1452). */
export const READ_GROUP_DISPLAY_FORMAT: Readonly<Record<Granularity, string>> = {
  hour: "HH:00 dd MMM",
  day: "dd MMM yyyy",
  week: "'W'w YYYY",
  month: "MMMM yyyy",
  quarter: "QQQ yyyy",
  year: "yyyy",
};

export function isGranularity(s: string): s is Granularity {
  return s in READ_GROUP_DISPLAY_FORMAT;
}

type CldrProvider = (code: string) => Promise<CldrLocale>;

let provider: CldrProvider = async (code) => {
  throw new NotPorted(`CLDR tables for ${code} (worker/gen/out/cldr.json from stream G, wire with setCldrProvider)`);
};

export function setCldrProvider(p: CldrProvider): void {
  provider = p;
}

export function cldrLocale(code: string): Promise<CldrLocale> {
  return provider(code);
}

/** Validates one locale entry of gen/out/cldr.json (shape agreed in NEEDS.md). */
export function cldrFromJson(code: string, raw: unknown): CldrLocale {
  if (!isRecord(raw)) throw new NotPorted(`cldr.json: entry ${code} is not an object`);
  const months = raw["months"];
  const quarters = raw["quarters"];
  const strings = (v: unknown, n: number, what: string): string[] => {
    if (!Array.isArray(v) || v.length !== n || !v.every((x) => typeof x === "string")) throw new NotPorted(`cldr.json ${code}: ${what}`);
    return v.map(String);
  };
  if (!isRecord(months) || !isRecord(quarters)) throw new NotPorted(`cldr.json ${code}: months/quarters`);
  const int = (v: unknown, what: string): number => {
    if (typeof v !== "number" || !Number.isInteger(v)) throw new NotPorted(`cldr.json ${code}: ${what}`);
    return v;
  };
  return {
    code,
    monthsWide: strings(months["wide"], 12, "months.wide"),
    monthsAbbreviated: strings(months["abbreviated"], 12, "months.abbreviated"),
    quartersAbbreviated: strings(quarters["abbreviated"], 4, "quarters.abbreviated"),
    firstWeekDay: int(raw["first_week_day"], "first_week_day"),
    minWeekDays: int(raw["min_week_days"], "min_week_days"),
  };
}

const pad = (x: number, w = 2): string => String(x).padStart(w, "0");

/** Days since 1970-01-01 of a civil date (proleptic Gregorian), for weekday and day arithmetic. */
function dayNumber(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

/** Python `date.weekday()`: Monday = 0. 1970-01-01 was a Thursday (3). */
function weekday(year: number, month: number, day: number): number {
  return (((dayNumber(year, month, day) + 3) % 7) + 7) % 7;
}

/** `datetime.date.isocalendar()[:2]`. */
export function isoWeek(year: number, month: number, day: number): [number, number] {
  const dn = dayNumber(year, month, day);
  const wd = weekday(year, month, day); // 0 = Monday
  const thursday = dn - wd + 3;
  const t = new Date(thursday * 86_400_000);
  const isoYear = t.getUTCFullYear();
  const jan1 = dayNumber(isoYear, 1, 1);
  return [isoYear, Math.floor((thursday - jan1) / 7) + 1];
}

/**
 * date_utils.py:449 weeknumber(locale, date): ISO for Monday/4 locales; otherwise "non-split first-day-of-year"
 * weeks: the week containing January 1st is week 1 and the days of the previous year in it belong to the new year.
 */
export function weekNumber(locale: CldrLocale, n: Naive): [number, number] {
  if (locale.firstWeekDay === 0 && locale.minWeekDays === 4) return isoWeek(n.year, n.month, n.day);
  // relativedelta(weekday=WD(-1)): the last `firstWeekDay` on or before the date
  const backToWeekStart = (year: number, month: number, day: number): number => {
    const dn = dayNumber(year, month, day);
    const wd = weekday(year, month, day);
    return dn - (((wd - locale.firstWeekDay) % 7) + 7) % 7;
  };
  const today = dayNumber(n.year, n.month, n.day);
  const fdny = backToWeekStart(n.year + 1, 1, 1);
  if (today >= fdny) return [n.year + 1, 1];
  const fdow = backToWeekStart(n.year, 1, 1);
  return [n.year, Math.floor((today - fdow) / 7) + 1];
}

/**
 * `babel.dates.format_date(value, READ_GROUP_DISPLAY_FORMAT[granularity], locale)` for the six patterns Odoo uses
 * (and `format_datetime` of the already tz-converted wall clock, models.py:1442). Field tokens per LDML:
 * HH hour 00-23, dd day, MMM/MMMM month abbreviated/wide, QQQ quarter abbreviated, yyyy year; `w YYYY` is replaced
 * by `W{week} {year:04}` from weeknumber (models.py:1452-1457).
 */
export function formatGroupLabel(granularity: Granularity, value: Naive, locale: CldrLocale): string {
  const month = (names: readonly string[]): string => {
    const name = names[value.month - 1];
    if (name === undefined) throw new NotPorted(`CLDR ${locale.code}: no month ${value.month}`);
    return name;
  };
  switch (granularity) {
    case "hour": return `${pad(value.hour)}:00 ${pad(value.day)} ${month(locale.monthsAbbreviated)}`;
    case "day": return `${pad(value.day)} ${month(locale.monthsAbbreviated)} ${pad(value.year, 4)}`;
    case "week": {
      const [year, week] = weekNumber(locale, value);
      return `W${week} ${pad(year, 4)}`;
    }
    case "month": return `${month(locale.monthsWide)} ${pad(value.year, 4)}`;
    case "quarter": {
      const q = locale.quartersAbbreviated[Math.floor((value.month - 1) / 3)];
      if (q === undefined) throw new NotPorted(`CLDR ${locale.code}: quarters`);
      return `${q} ${pad(value.year, 4)}`;
    }
    case "year": return pad(value.year, 4);
    default: {
      const never: never = granularity;
      throw new TypeError(String(never));
    }
  }
}

/** `date_utils.start_of`-style truncation of a wall-clock value, `date_trunc(granularity, ts)` (fields_temporal.py:110). */
export function truncate(n: Naive, granularity: Granularity, weekStartOffsetDays = 0): Naive {
  switch (granularity) {
    case "hour": return { ...n, minute: 0, second: 0 };
    case "day": return { ...n, hour: 0, minute: 0, second: 0 };
    case "week": {
      // fields_temporal.py:100-108: date_trunc('week', ts - INTERVAL '-n DAY') + INTERVAL '-n DAY', i.e. the offset is
      // added before the truncation and taken off after it (en_US, weeks from Sunday: n = 1); Postgres weeks start on
      // Monday
      const dn = dayNumber(n.year, n.month, n.day) + weekStartOffsetDays;
      const wd = (((dn + 3) % 7) + 7) % 7;
      const start = new Date((dn - wd - weekStartOffsetDays) * 86_400_000);
      return { year: start.getUTCFullYear(), month: start.getUTCMonth() + 1, day: start.getUTCDate(), hour: 0, minute: 0, second: 0 };
    }
    case "month": return { year: n.year, month: n.month, day: 1, hour: 0, minute: 0, second: 0 };
    case "quarter": return { year: n.year, month: Math.floor((n.month - 1) / 3) * 3 + 1, day: 1, hour: 0, minute: 0, second: 0 };
    case "year": return { year: n.year, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
    default: {
      const never: never = granularity;
      throw new TypeError(String(never));
    }
  }
}

/** `value + READ_GROUP_TIME_GRANULARITY[granularity]` (odoo/odoo/orm/utils.py:26, dateutil relativedelta). */
export function addInterval(n: Naive, granularity: Granularity): Naive {
  switch (granularity) {
    case "hour": return fromMs(toMs(n) + 3_600_000);
    case "day": return fromMs(toMs(n) + 86_400_000);
    case "week": return fromMs(toMs(n) + 7 * 86_400_000);
    case "month":
    case "quarter": {
      const months = granularity === "month" ? 1 : 3;
      const total = n.year * 12 + (n.month - 1) + months;
      const year = Math.floor(total / 12);
      const month = (total % 12) + 1;
      // relativedelta clamps the day to the month's length
      const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
      return { ...n, year, month, day: Math.min(n.day, last) };
    }
    case "year": {
      const last = new Date(Date.UTC(n.year + 1, n.month, 0)).getUTCDate();
      return { ...n, year: n.year + 1, day: Math.min(n.day, last) };
    }
    default: {
      const never: never = granularity;
      throw new TypeError(String(never));
    }
  }
}

function toMs(n: Naive): number {
  return Date.UTC(n.year, n.month - 1, n.day, n.hour, n.minute, n.second);
}

function fromMs(ms: number): Naive {
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
}

export { formatNaive };
