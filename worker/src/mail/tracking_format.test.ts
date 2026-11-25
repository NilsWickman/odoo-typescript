import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatTrackingDate, formatTrackingDatetime } from "./tracking_format";

// babel 2.10.3 (the oracle's .venv) for en_US, fr_FR and sv_SE: worker/gen/zone_formats.py
const CASES = JSON.parse(readFileSync(fileURLToPath(new URL("../../test/tracking_format_cases.json", import.meta.url).href), "utf8")) as [string, string, string, string, string][];

test("_format_tracking_date and _format_tracking_datetime as babel", async () => {
  for (const [kind, lang, value, tz, expected] of CASES) {
    const got = kind === "date" ? await formatTrackingDate(value, lang) : await formatTrackingDatetime(value, tz, lang);
    assert.equal(got, expected, `${kind} ${lang} ${value} ${tz}`);
  }
});
