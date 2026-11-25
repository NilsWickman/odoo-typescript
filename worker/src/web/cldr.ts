/**
 * Wires the read_group label tables (src/web/labels.ts `setCldrProvider`) to gen/out/cldr.json (gen/cldr.py, babel
 * 2.10.3 locale data per ruling O1): `months['format']` and `quarters['format']` (the contexts babel's format_date
 * uses for `MMMM`/`MMM`/`QQQ`, babel/dates.py DateTimeFormat.format_month/format_quarter) and `week` (first_week_day,
 * min_week_days). Loaded lazily once per isolate.
 */
import { NotPorted } from "../errors";
import { isRecord } from "./common";
import { setCldrProvider, type CldrLocale } from "./labels";

let data: Promise<Record<string, unknown>> | null = null;

function ordered(v: unknown, n: number, what: string): string[] {
  if (!isRecord(v)) throw new NotPorted(`cldr.json: ${what}`);
  const out: string[] = [];
  for (let i = 1; i <= n; i++) {
    const x = v[String(i)];
    if (typeof x !== "string") throw new NotPorted(`cldr.json: ${what}[${i}]`);
    out.push(x);
  }
  return out;
}

setCldrProvider(async (code: string): Promise<CldrLocale> => {
  data ??= import("../../gen/out/cldr.json").then((m) => {
    const raw: unknown = m.default;
    if (!isRecord(raw) || !isRecord(raw["locales"])) throw new NotPorted("cldr.json: locales");
    return raw["locales"];
  });
  const loc = (await data)[code];
  if (!isRecord(loc)) throw new NotPorted(`CLDR tables for ${code} (gen/cldr.py generates en_US, fr_FR and sv_SE)`);
  const months = loc["months"], quarters = loc["quarters"], week = loc["week"];
  if (!isRecord(months) || !isRecord(months["format"]) || !isRecord(quarters) || !isRecord(quarters["format"]) || !isRecord(week)) {
    throw new NotPorted(`cldr.json ${code}: months/quarters/week`);
  }
  const fwd = week["first_week_day"], mwd = week["min_week_days"];
  if (typeof fwd !== "number" || typeof mwd !== "number") throw new NotPorted(`cldr.json ${code}: week`);
  return {
    code,
    monthsWide: ordered(months["format"]["wide"], 12, "months.format.wide"),
    monthsAbbreviated: ordered(months["format"]["abbreviated"], 12, "months.format.abbreviated"),
    quartersAbbreviated: ordered(quarters["format"]["abbreviated"], 4, "quarters.format.abbreviated"),
    firstWeekDay: fwd,
    minWeekDays: mwd,
  };
});
