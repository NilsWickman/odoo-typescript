import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { occurrences, parseRule, rruleString, type Freq } from "./rrule";
import { formatNaive, parseNaive } from "../web/tz";

interface Spec {
  freq: Freq; dtstart: string; interval: number; wkst: number | null; count: number | null; until: string | null;
  byweekday: number[] | null; bynweekday: [number, number] | null; bymonthday: number | null;
}
// test/rrule_cases.json: dateutil 2.8.2 `list(rrule(...))` and `str(rrule(...))` of 250 random rules (test/rrule_cases.py)
const CASES = JSON.parse(readFileSync(fileURLToPath(new URL("../../test/rrule_cases.json", import.meta.url).href), "utf8")) as [Spec, string[], string][];

test("rrule occurrences and str() as dateutil", () => {
  for (const [spec, expected, str] of CASES) {
    const until = spec.until ? parseNaive(spec.until)! : null;
    const rule = {
      freq: spec.freq, dtstart: parseNaive(spec.dtstart)!, interval: spec.interval, wkst: spec.wkst, count: spec.count,
      until: until && { year: until.year, month: until.month, day: until.day },
      byweekday: spec.byweekday, bynweekday: spec.bynweekday, bymonthday: spec.bymonthday,
    };
    assert.deepEqual(occurrences(rule).map((n) => formatNaive(n, true)), expected, JSON.stringify(spec));
    assert.equal(rruleString(rule), str, JSON.stringify(spec));
    const parsed = parseRule(str);
    assert.equal(parsed.freq, spec.freq);
    assert.equal(parsed.count, spec.count);
    assert.equal(parsed.interval, spec.interval);
  }
});
