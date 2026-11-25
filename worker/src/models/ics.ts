/**
 * The iCalendar text `vobject` 0.9.6.1 serializes for calendar_event.py:1969-2040 `_get_ics_file` (pure, no
 * database): VCALENDAR with VERSION and PRODID first (icalendar.py:928 `sortFirst`), one VEVENT whose properties are
 * `uid, dtstart, dtend` first and the others by lowercase name (icalendar.py:1121, base.py:647-655, insertion order
 * within a name), VALARMs with the implicit `ACTION:AUDIO` (icalendar.py:1310-1324) and their properties by name.
 * TEXT values are backslash-escaped (base.py:1218-1220; icalendar.py:1598-1601 lists them), parameters sorted by name
 * and double-quoted when they hold `,;:` (base.py:929-938, :1022-1028), each line folded at 75 bytes without
 * splitting a UTF-8 sequence, unless it has fewer than 75 characters (base.py:941-988), CRLF after each line.
 */
import { NotPorted } from "../errors";

export interface IcsAlarm {
  /** `alarm.interval`: days, hours or minutes. */
  readonly interval: string;
  readonly duration: number;
  /** `alarm.name or 'Odoo'`. */
  readonly description: string;
}

export interface IcsEvent {
  /** The implicit UID (icalendar.py:714-726): `<now> - <int(random() * 100000)>@<host>`. */
  readonly uid: string;
  /** UTC "YYYY-MM-DD HH:MM:SS" values. */
  readonly created: string;
  readonly dtstamp: string;
  readonly dtstart: string;
  readonly dtend: string;
  readonly summary: string;
  readonly description: string | null;
  readonly location: string | null;
  readonly url: string | null;
  /** The rule without `RRULE:`. */
  readonly rrule: string | null;
  readonly alarms: readonly IcsAlarm[];
  /** `MAILTO:<email>` values in attendee order. */
  readonly attendees: readonly string[];
  readonly organizer: { readonly value: string; readonly cn: string | null } | null;
}

/** icalendar.py:1672-1688 `dateTimeToString` of an aware UTC datetime. */
export function icsDateTime(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (!m) throw new NotPorted(`calendar file date ${value}`);
  return `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}${m[6]}Z`;
}

/** base.py:1218-1220 `backslashEscape`. */
const textEscape = (s: string): string =>
  s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n/g, "\\n").replace(/\n/g, "\\n").replace(/\r/g, "\\n");

/** base.py:929-938 `dquoteEscape`. */
function paramEscape(p: string): string {
  if (p.includes('"')) throw new NotPorted("double quotes in a calendar file parameter (VObjectError)");
  return /[,;:]/.test(p) ? `"${p}"` : p;
}

/** icalendar.py:1622-1652 `timedeltaToString` of `-delta` (the alarm is before the start). */
function triggerOf(a: IcsAlarm): string {
  const unit = a.interval === "days" ? 86_400 : a.interval === "hours" ? 3_600 : a.interval === "minutes" ? 60 : null;
  if (unit === null) throw new NotPorted(`calendar alarm interval ${a.interval}`);
  if (!Number.isInteger(a.duration)) throw new NotPorted("calendar alarm with a non-integer duration");
  const total = -a.duration * unit;
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const days = Math.floor(abs / 86_400), secs = abs % 86_400;
  const hours = Math.floor(secs / 3600), minutes = Math.floor((secs % 3600) / 60), seconds = secs % 60;
  let out = sign === -1 ? "-P" : "P";
  if (days) out += `${days}D`;
  if (hours || minutes || seconds) out += "T";
  else if (!days) out += "T0S";
  if (hours) out += `${hours}H`;
  if (minutes) out += `${minutes}M`;
  if (seconds) out += `${seconds}S`;
  return out;
}

/** base.py:941-988 `foldOneLine`, with the CRLF after the line. */
export function foldLine(line: string): string {
  const chars = [...line];
  if (chars.length < 75) return `${line}\r\n`;
  let out = "", counter = 0;
  for (const ch of chars) {
    const size = Buffer.byteLength(ch, "utf8");
    if (counter + size > 75) {
      out += "\r\n ";
      counter = 1;
    }
    out += ch;
    counter += size;
  }
  return `${out}\r\n`;
}

interface Line { readonly name: string; readonly params?: readonly [string, string][]; readonly value: string }

function contentLine(l: Line): string {
  const params = [...(l.params ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `;${k}=${paramEscape(v)}`).join("");
  return foldLine(`${l.name.toUpperCase()}${params}:${l.value}`);
}

/** `cal.serialize().encode('utf-8')` of the calendar `_get_ics_file` builds. */
export function serializeIcs(e: IcsEvent): Uint8Array {
  const props: Line[] = [];
  for (const a of e.attendees) props.push({ name: "attendee", value: a });
  props.push({ name: "created", value: icsDateTime(e.created) });
  if (e.description) props.push({ name: "description", value: textEscape(e.description) });
  props.push({ name: "dtstamp", value: icsDateTime(e.dtstamp) });
  if (e.location) props.push({ name: "location", value: textEscape(e.location) });
  if (e.organizer) props.push({ name: "organizer", params: e.organizer.cn !== null ? [["CN", e.organizer.cn]] : [], value: e.organizer.value });
  if (e.rrule !== null) props.push({ name: "rrule", value: e.rrule });
  props.push({ name: "summary", value: textEscape(e.summary) });
  if (e.url) props.push({ name: "url", value: e.url });
  let out = foldLine("BEGIN:VCALENDAR") + foldLine("VERSION:2.0") + foldLine("PRODID:-//PYVOBJECT//NONSGML Version 1//EN") + foldLine("BEGIN:VEVENT");
  out += contentLine({ name: "uid", value: textEscape(e.uid) });
  out += contentLine({ name: "dtstart", value: icsDateTime(e.dtstart) });
  out += contentLine({ name: "dtend", value: icsDateTime(e.dtend) });
  // sorted by name, stable within a name (the order the properties were added)
  const sorted = props.map((p, i) => ({ p, i })).sort((a, b) => (a.p.name < b.p.name ? -1 : a.p.name > b.p.name ? 1 : a.i - b.i));
  for (const { p } of sorted) out += contentLine(p);
  for (const a of e.alarms) {
    out += foldLine("BEGIN:VALARM");
    out += contentLine({ name: "action", value: "AUDIO" });
    out += contentLine({ name: "description", value: textEscape(a.description) });
    out += contentLine({ name: "trigger", params: [["related", "START"]], value: triggerOf(a) });
    out += foldLine("END:VALARM");
  }
  out += foldLine("END:VEVENT") + foldLine("END:VCALENDAR");
  return new Uint8Array(Buffer.from(out, "utf8"));
}
