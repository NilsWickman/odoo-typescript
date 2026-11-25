/**
 * The date names of a data file's eval context (odoo/odoo/tools/convert.py:49-62 `_get_eval_context`): `DateTime` and
 * `datetime` (the class `datetime.datetime`), `timedelta` and dateutil's `relativedelta`, as Community's data and demo
 * files use them (2021 expressions in 55 modules, e.g. `(DateTime.now() - timedelta(days=3)).strftime('%Y-%m-%d')`,
 * `DateTime.today() - relativedelta(days=10)`).
 *
 * Values are naive datetimes in microseconds since the epoch. `now()` and `today()` are Python's local time, UTC on
 * the server (odoo/__init__.py sets TZ=UTC): the transaction's now() stands for it, as for `time.strftime`
 * (src/modules/convert.ts). Operations: datetime +/- timedelta, datetime +/- relativedelta, `strftime` with the
 * directives below, and the value of a Date or Datetime field (fields_temporal.py `to_date` / `to_datetime`). Anything
 * else (other methods, comparisons, date objects, float arguments, relativedelta's leapdays/yearday/weekday objects)
 * refuses rather than approximates.
 */
import { NotPorted } from "../errors";
import { PyKwargs, PyObject } from "../pyexpr";
import type { Environment, FieldDef } from "../orm/types";
import { PreciseDatetime } from "../orm/values";
import { transactionNowUtc } from "../orm/signaling";

const US_PER_DAY = 86_400_000_000;
const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

interface Parts { year: number; month: number; day: number; hour: number; minute: number; second: number; microsecond: number }

function partsOf(us: number): Parts {
  const ms = Math.floor(us / 1000);
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), microsecond: us - ms * 1000 + d.getUTCMilliseconds() * 1000,
  };
}

function usOf(p: Parts): number {
  if (p.year < 1 || p.year > 9999) throw new NotPorted(`a datetime of year ${p.year} in a data file (OverflowError)`);
  const ms = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Date.UTC maps years 0-99 to 1900-1999
  const d = new Date(ms);
  if (p.year < 100) d.setUTCFullYear(p.year);
  return d.getTime() * 1000 + p.microsecond;
}

/** calendar.monthrange(year, month)[1] (Date.UTC maps 0-99 to 19xx, whose leap years are the same for 1-99) */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function int(v: unknown, what: string): number {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new NotPorted(`${what} with a value that is not an int in a data file`);
}

function kwargsOf(args: unknown[]): { pos: unknown[]; kw: Map<string, unknown> } {
  const last = args[args.length - 1];
  if (last instanceof PyKwargs) return { pos: args.slice(0, -1), kw: last.entries };
  return { pos: args, kw: new Map() };
}

/** A naive `datetime.datetime`. */
export class PyDataDatetime extends PyObject {
  constructor(readonly us: number) { super(); }
  static of(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, microsecond = 0): PyDataDatetime {
    return new PyDataDatetime(usOf({ year, month, day, hour, minute, second, microsecond }));
  }
  pyGetAttr(name: string): unknown {
    const p = partsOf(this.us);
    switch (name) {
      case "year": case "month": case "day": case "hour": case "minute": case "second": case "microsecond": return p[name];
      case "strftime": return (fmt: unknown) => {
        if (typeof fmt !== "string") throw new NotPorted("datetime.strftime of a format that is not a string");
        return fmt.replace(/%(.)/g, (_m, d: string) => {
          switch (d) {
            case "Y": return pad(p.year, 4);
            case "y": return pad(p.year % 100);
            case "m": return pad(p.month);
            case "d": return pad(p.day);
            case "H": return pad(p.hour);
            case "M": return pad(p.minute);
            case "S": return pad(p.second);
            case "%": return "%";
            default: throw new NotPorted(`datetime.strftime directive %${d} in a data file`);
          }
        });
      };
      default: throw new NotPorted(`datetime.${name} in a data file`);
    }
  }
  override pyAdd(other: unknown): unknown {
    if (other instanceof PyTimedelta) return new PyDataDatetime(this.us + other.us);
    if (other instanceof PyRelativedelta) return other.addTo(this);
    throw new NotPorted("datetime + a value other than timedelta or relativedelta in a data file");
  }
  override pySub(other: unknown): unknown {
    if (other instanceof PyTimedelta) return new PyDataDatetime(this.us - other.us);
    if (other instanceof PyRelativedelta) return other.negated().addTo(this);
    throw new NotPorted("datetime - a value other than timedelta or relativedelta in a data file");
  }
  override pyEquals(_other: unknown): boolean { throw new NotPorted("comparing datetimes in a data file"); }
  override pyToString(): string { throw new NotPorted("str() of a datetime in a data file"); }
  /** `str(dt)` without and with microseconds (datetime.isoformat(' ')). */
  text(): string {
    const p = partsOf(this.us);
    const base = `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
    return p.microsecond ? `${base}.${pad(p.microsecond, 6)}` : base;
  }
}

/** `datetime.timedelta(days, seconds, microseconds, milliseconds, minutes, hours, weeks)` with int arguments. */
export class PyTimedelta extends PyObject {
  constructor(readonly us: number) { super(); }
  static make(...args: unknown[]): PyTimedelta {
    const { pos, kw } = kwargsOf(args);
    const names = ["days", "seconds", "microseconds", "milliseconds", "minutes", "hours", "weeks"];
    if (pos.length > names.length) throw new NotPorted("timedelta with more than 7 arguments");
    const v: Record<string, number> = {};
    pos.forEach((a, i) => { v[names[i]!] = int(a, "timedelta"); });
    for (const [k, a] of kw) {
      if (!names.includes(k)) throw new NotPorted(`timedelta(${k}=...)`);
      if (k in v) throw new NotPorted(`timedelta with ${k} twice`);
      v[k] = int(a, "timedelta");
    }
    const g = (k: string): number => v[k] ?? 0;
    return new PyTimedelta(((g("weeks") * 7 + g("days")) * 86400 + g("hours") * 3600 + g("minutes") * 60 + g("seconds")) * 1_000_000
      + g("milliseconds") * 1000 + g("microseconds"));
  }
  pyGetAttr(name: string): unknown { throw new NotPorted(`timedelta.${name} in a data file`); }
  override pyAdd(other: unknown): unknown {
    if (other instanceof PyTimedelta) return new PyTimedelta(this.us + other.us);
    throw new NotPorted("timedelta + a value other than timedelta in a data file");
  }
  override pySub(other: unknown): unknown {
    if (other instanceof PyTimedelta) return new PyTimedelta(this.us - other.us);
    throw new NotPorted("timedelta - a value other than timedelta in a data file");
  }
}

const REL = ["years", "months", "days", "leapdays", "weeks", "hours", "minutes", "seconds", "microseconds"] as const;
const ABS = ["year", "month", "day", "weekday", "yearday", "nlyearday", "hour", "minute", "second", "microsecond"] as const;

/**
 * dateutil 2.x `relativedelta(**kwargs)` (relativedelta.py `__init__`, `_fix`, `__add__`, `__neg__`) with int
 * arguments; `weekday` as an int (MO..SU with n=None). leapdays, yearday, nlyearday, a weekday object and the
 * two-datetime form refuse.
 */
export class PyRelativedelta extends PyObject {
  constructor(readonly rel: Readonly<Record<(typeof REL)[number], number>>, readonly abs: Readonly<Partial<Record<(typeof ABS)[number], number>>>) { super(); }
  static make(...args: unknown[]): PyRelativedelta {
    const { pos, kw } = kwargsOf(args);
    if (pos.length) throw new NotPorted("relativedelta(dt1, dt2) in a data file");
    const rel: Record<string, number> = Object.fromEntries(REL.map((k) => [k, 0]));
    const abs: Record<string, number> = {};
    for (const [k, a] of kw) {
      if ((REL as readonly string[]).includes(k)) rel[k] = int(a, `relativedelta(${k}=...)`);
      else if ((ABS as readonly string[]).includes(k)) { if (a !== null) abs[k] = int(a, `relativedelta(${k}=...)`); }
      else throw new NotPorted(`relativedelta(${k}=...)`);
    }
    if (rel["leapdays"] || "yearday" in abs || "nlyearday" in abs) throw new NotPorted("relativedelta with leapdays or yearday in a data file");
    if ("weekday" in abs && (abs["weekday"]! < 0 || abs["weekday"]! > 6)) throw new NotPorted("relativedelta(weekday=...) outside 0-6");
    // __init__: days += weeks * 7; then _fix (the carries; the time parts carry into days, the months into years)
    rel["days"]! += rel["weeks"]! * 7;
    rel["weeks"] = 0;
    const carry = (small: string, big: string, base: number): void => {
      if (Math.abs(rel[small]!) > base - 1) {
        const s = Math.sign(rel[small]!);
        const div = Math.floor((rel[small]! * s) / base), mod = (rel[small]! * s) % base;
        rel[small] = mod * s;
        rel[big]! += div * s;
      }
    };
    carry("microseconds", "seconds", 1_000_000);
    carry("seconds", "minutes", 60);
    carry("minutes", "hours", 60);
    carry("hours", "days", 24);
    carry("months", "years", 12);
    return new PyRelativedelta(rel as Record<(typeof REL)[number], number>, abs);
  }
  pyGetAttr(name: string): unknown { throw new NotPorted(`relativedelta.${name} in a data file`); }
  /** `__neg__`: the relative parts negated, the absolute ones kept. */
  negated(): PyRelativedelta {
    return new PyRelativedelta(Object.fromEntries(REL.map((k) => [k, -this.rel[k]])) as Record<(typeof REL)[number], number>, this.abs);
  }
  /** `__add__(datetime)` (relativedelta.py:391-430). */
  addTo(dt: PyDataDatetime): PyDataDatetime {
    const p = partsOf(dt.us);
    let year = (this.abs.year ?? p.year) + this.rel.years;
    let month = this.abs.month ?? p.month;
    if (this.rel.months) {
      month += this.rel.months;
      if (month > 12) { year += 1; month -= 12; } else if (month < 1) { year -= 1; month += 12; }
    }
    if (year < 1 || year > 9999) throw new NotPorted(`a datetime of year ${year} in a data file (ValueError)`);
    const day = Math.min(daysInMonth(year, month), this.abs.day ?? p.day);
    const replaced: Parts = {
      year, month, day,
      hour: this.abs.hour ?? p.hour, minute: this.abs.minute ?? p.minute, second: this.abs.second ?? p.second,
      microsecond: this.abs.microsecond ?? p.microsecond,
    };
    for (const k of ["hour", "minute", "second"] as const) if (replaced[k] < 0 || replaced[k] > (k === "hour" ? 23 : 59)) throw new NotPorted(`relativedelta(${k}=...) out of range`);
    let us = usOf(replaced) + this.rel.days * US_PER_DAY
      + ((this.rel.hours * 60 + this.rel.minutes) * 60 + this.rel.seconds) * 1_000_000 + this.rel.microseconds;
    if (this.abs.weekday !== undefined) {
      // weekday(n=None): nth = 1, jumpdays = (7 - ret.weekday() + weekday) % 7
      const wd = (new Date(Math.floor(us / 1000)).getUTCDay() + 6) % 7;
      us += ((7 - wd + this.abs.weekday) % 7) * US_PER_DAY;
    }
    return new PyDataDatetime(us);
  }
  override pyAdd(other: unknown): unknown {
    if (other instanceof PyDataDatetime) return this.addTo(other);
    throw new NotPorted("relativedelta + a value other than a datetime in a data file");
  }
}

/** The class `datetime.datetime` as `DateTime` and `datetime`: `now()` and `today()`. */
export class PyDatetimeClass extends PyObject {
  constructor(private readonly env: Environment) { super(); }
  pyGetAttr(name: string): unknown {
    if (name !== "now" && name !== "today") throw new NotPorted(`datetime.${name} in a data file`);
    return async (...args: unknown[]) => {
      if (args.length) throw new NotPorted(`datetime.${name}() with arguments in a data file`);
      const text = await transactionNowUtc(this.env.cr); // 'YYYY-MM-DDTHH:MM:SS.ffffffZ'
      const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)\.(\d{6})Z$/.exec(text);
      if (!m) throw new NotPorted(`the transaction's now ${text}`);
      return new PyDataDatetime(usOf({ year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: +m[4]!, minute: +m[5]!, second: +m[6]!, microsecond: +m[7]! }));
    };
  }
}

/** A name of the eval context the port does not provide (`pytz`): any use refuses. */
export class PyUnported extends PyObject {
  constructor(private readonly what: string) { super(); }
  pyGetAttr(name: string): unknown { throw new NotPorted(`${this.what}.${name} in a data file`); }
}

export function isDataDateValue(v: unknown): boolean {
  return v instanceof PyDataDatetime || v instanceof PyTimedelta || v instanceof PyRelativedelta || v instanceof PyDatetimeClass;
}

/**
 * The value of an evaluated datetime for a field (fields_temporal.py `Date.to_date` of a datetime: its date;
 * `Datetime.to_datetime`: the datetime, microseconds kept as PreciseDatetime); any other field refuses.
 */
export function dataDateFieldValue(field: FieldDef | undefined, value: PyDataDatetime): unknown {
  if (field?.type === "date") return value.text().slice(0, 10);
  if (field?.type === "datetime") {
    const t = value.text();
    return t.includes(".") ? new PreciseDatetime(t) : t;
  }
  throw new NotPorted(`a datetime value for ${field ? `a ${field.type} field` : "an unknown field"} in a data file`);
}
