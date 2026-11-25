/**
 * Time zone arithmetic for the read_group date granularities (`odoo/odoo/orm/fields_temporal.py:85-116`:
 * `timezone(tz, timezone('UTC', col))` then `date_trunc`) and the group labels (`addons/web/models/models.py:1434`:
 * `value.replace(tzinfo=tz).astimezone(UTC)`). Odoo only uses the context tz when it is in
 * `zoneinfo.available_timezones()` (`date_utils.all_timezones`); here `Intl` decides, which accepts a few more legacy
 * names (PORTING_odoo.md section 9, TS trap). Zone tables from tzdata (O5) would make it exact; see NEEDS.md.
 */

/** A naive wall-clock value, like a Python `datetime` without tzinfo. Month is 1-12. */
export interface Naive {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

export function isTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz === "") return false;
  try {
    formatter(tz);
    return true;
  } catch (e) {
    if (e instanceof RangeError) return false;
    throw e;
  }
}

function formatter(tz: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    FORMATTERS.set(tz, f);
  }
  return f;
}

/** `utc.astimezone(ZoneInfo(tz))` as wall-clock parts. */
export function utcToLocal(utc: Date, tz: string): Naive {
  const parts = formatter(tz).formatToParts(utc);
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    if (p === undefined) throw new Error(`Intl did not return ${type}`);
    return parseInt(p.value, 10);
  };
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

export function naiveToUtcDate(n: Naive): Date {
  return new Date(Date.UTC(n.year, n.month - 1, n.day, n.hour, n.minute, n.second));
}

export function dateToNaive(d: Date): Naive {
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(),
  };
}

/**
 * `naive.replace(tzinfo=ZoneInfo(tz)).astimezone(UTC)`: the instant whose wall clock in `tz` is `naive`. For a
 * wall-clock value in a DST gap or overlap, zoneinfo picks the pre-transition offset (`fold=0`); the two-step guess
 * below converges on the same choice for the zones in use.
 */
export function localToUtc(naive: Naive, tz: string): Date {
  const asUtc = naiveToUtcDate(naive).getTime();
  let guess = asUtc - offsetMs(new Date(asUtc), tz);
  const back = naiveToUtcDate(utcToLocal(new Date(guess), tz)).getTime();
  if (back !== asUtc) guess += asUtc - back;
  return new Date(guess);
}

function offsetMs(utc: Date, tz: string): number {
  return naiveToUtcDate(utcToLocal(utc, tz)).getTime() - utc.getTime();
}

/** `%Y-%m-%d %H:%M:%S` / `%Y-%m-%d` (DEFAULT_SERVER_DATETIME_FORMAT / DEFAULT_SERVER_DATE_FORMAT). */
export function formatNaive(n: Naive, withTime: boolean): string {
  const p = (x: number, w = 2): string => String(x).padStart(w, "0");
  const date = `${p(n.year, 4)}-${p(n.month)}-${p(n.day)}`;
  return withTime ? `${date} ${p(n.hour)}:${p(n.minute)}:${p(n.second)}` : date;
}

const RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/;

export function parseNaive(s: string): Naive | null {
  const m = RE.exec(s);
  if (m === null) return null;
  const n = (i: number): number => parseInt(m[i] ?? "0", 10);
  return { year: n(1), month: n(2), day: n(3), hour: n(4), minute: n(5), second: n(6) };
}
