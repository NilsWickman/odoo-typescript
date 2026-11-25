/**
 * mail_track_mixin.py:625-640 `_format_tracking_date` and `_format_tracking_datetime`: babel's medium date of the
 * language, and "{1}{sep}{0}" of the medium date and the short time (Locale.datetime_formats) followed by " (ZZZZ)",
 * the localized GMT offset, in the given time zone. The patterns, month names and day periods are babel's
 * (gen/out/cldr.json), the GMT format too (gen/out/zone_formats.json); the pattern letters these patterns use are
 * rendered as babel.dates does (DateTimeFormat.__getitem__), any other letter refuses.
 * Checked against babel 2.10.3 for en_US, fr_FR and sv_SE (tracking_format.test.ts, worker/gen/zone_formats.py).
 */
import { NotPorted } from '../errors';

interface LocaleData {
  readonly date_formats: Readonly<Record<string, string>>;
  readonly time_formats: Readonly<Record<string, string>>;
  readonly datetime_formats: Readonly<Record<string, string>>;
  readonly months: { readonly format: { readonly abbreviated: Readonly<Record<string, string>>; readonly wide: Readonly<Record<string, string>> } };
  readonly day_periods: { readonly format: { readonly abbreviated: Readonly<Record<string, string>> } };
}

let tables: Promise<[Record<string, LocaleData>, Record<string, { gmt: string }>]> | null = null;

/** The generated tables, imported at first use (no big tables at the top level of the Worker). */
async function localeOf(lang: string): Promise<{ data: LocaleData; gmt: string }> {
  tables ??= Promise.all([import('../../gen/out/cldr.json', { with: { type: 'json' } }), import('../../gen/out/zone_formats.json', { with: { type: 'json' } })]).then(([c, z]) => [
    (c.default as unknown as { locales: Record<string, LocaleData> }).locales,
    (z.default as unknown as { locales: Record<string, { gmt: string }> }).locales,
  ]);
  const [locales, zones] = await tables;
  const data = locales[lang];
  const gmt = zones[lang]?.gmt;
  if (!data || !gmt) throw new NotPorted(`babel date formats of ${lang} (gen/cldr.py, gen/zone_formats.py)`);
  return { data, gmt };
}

interface Parts { y: number; mo: number; d: number; h: number; mi: number; s: number; offsetSec: number | null }

/** babel.dates.get_timezone_gmt(width='long'): `gmt % ('%+03d:%02d' % (hours, seconds // 60))` of divmod(offset, 3600). */
function gmtString(gmt: string, offsetSec: number): string {
  const hours = Math.floor(offsetSec / 3600);
  const minutes = Math.floor((offsetSec - hours * 3600) / 60);
  const h = `${hours < 0 ? '-' : '+'}${String(Math.abs(hours)).padStart(2, '0')}`;
  return gmt.replace('%s', `${h}:${String(minutes).padStart(2, '0')}`);
}

/** babel.dates.format_datetime(pattern) for the letters d, M, y, H, h, m, s, a and ZZZZ; quoted text is literal. */
function render(pattern: string, p: Parts, loc: { data: LocaleData; gmt: string }): string {
  let out = '';
  for (let i = 0; i < pattern.length;) {
    const c = pattern[i]!;
    if (c === "'") {
      const j = pattern.indexOf("'", i + 1);
      if (j < 0) throw new NotPorted(`babel pattern ${pattern}`);
      out += j === i + 1 ? "'" : pattern.slice(i + 1, j);
      i = j + 1;
      continue;
    }
    if (!/[A-Za-z]/.test(c)) { out += c; i++; continue; }
    let n = 1;
    while (pattern[i + n] === c) n++;
    const pad = (v: number): string => String(v).padStart(n, '0');
    switch (c) {
      case 'd': out += pad(p.d); break;
      case 'M':
        if (n <= 2) out += pad(p.mo);
        else if (n === 3) out += loc.data.months.format.abbreviated[String(p.mo)] ?? '';
        else if (n === 4) out += loc.data.months.format.wide[String(p.mo)] ?? '';
        else throw new NotPorted(`babel pattern letter ${c.repeat(n)}`);
        break;
      case 'y':
        if (n === 2) out += String(p.y % 100).padStart(2, '0');
        else out += pad(p.y);
        break;
      case 'H': out += pad(p.h); break;
      case 'h': out += pad(p.h % 12 || 12); break;
      case 'm': out += pad(p.mi); break;
      case 's': out += pad(p.s); break;
      case 'a': out += loc.data.day_periods.format.abbreviated[p.h < 12 ? 'am' : 'pm'] ?? ''; break;
      case 'Z':
        if (n !== 4 || p.offsetSec === null) throw new NotPorted(`babel pattern letter ${c.repeat(n)}`);
        out += gmtString(loc.gmt, p.offsetSec);
        break;
      default: throw new NotPorted(`babel pattern letter ${c.repeat(n)}`);
    }
    i += n;
  }
  return out;
}

/** The wall-clock parts of a naive UTC datetime in `tz`, with its offset in seconds. */
function localParts(value: string, tz: string): Parts {
  const utc = new Date(`${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(utc.getTime())) throw new NotPorted(`tracking datetime ${value}`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(utc);
  const get = (t: string): number => Number(parts.find(x => x.type === t)?.value ?? 0);
  const [y, mo, d, h, mi, s] = [get('year'), get('month'), get('day'), get('hour') % 24, get('minute'), get('second')];
  const offsetSec = Math.round((Date.UTC(y, mo - 1, d, h, mi, s) - Math.floor(utc.getTime() / 1000) * 1000) / 1000);
  return { y, mo, d, h, mi, s, offsetSec };
}

/** `_format_tracking_datetime(value)` with env.lang and env.tz. */
export async function formatTrackingDatetime(value: string, tz: string, lang = 'en_US'): Promise<string> {
  const loc = await localeOf(lang);
  const medium = loc.data.datetime_formats['medium'], date = loc.data.date_formats['medium'], time = loc.data.time_formats['short'];
  if (medium === undefined || date === undefined || time === undefined) throw new NotPorted(`babel date formats of ${lang}`);
  // dt_format.format(time_format, date_format): {0} is the time, {1} the date
  const pattern = `${medium.replace('{0}', '\u0000').replace('{1}', date).replace('\u0000', time)} (ZZZZ)`;
  return render(pattern, localParts(value, tz), loc);
}

/** `_format_tracking_date(value)` with env.lang: format_date(env, value, date_format=<medium date>). */
export async function formatTrackingDate(value: string, lang = 'en_US'): Promise<string> {
  const loc = await localeOf(lang);
  const pattern = loc.data.date_formats['medium'];
  if (pattern === undefined) throw new NotPorted(`babel date formats of ${lang}`);
  const [y, mo, d] = value.split('-').map(Number) as [number, number, number];
  return render(pattern, { y, mo, d, h: 0, mi: 0, s: 0, offsetSec: null }, loc);
}
