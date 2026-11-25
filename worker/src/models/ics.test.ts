import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serializeIcs, type IcsEvent } from "./ics";

// [the event's values, `cal.serialize()` of vobject 0.9.6.1] (test/ics_cases.py)
const CASES = JSON.parse(readFileSync(fileURLToPath(new URL("../../test/ics_cases.json", import.meta.url).href), "utf8")) as [IcsEvent, string][];

test("calendar file as vobject serializes it", () => {
  assert.equal(CASES.length, 40);
  for (const [event, expected] of CASES) assert.equal(Buffer.from(serializeIcs(event)).toString("utf8"), expected, JSON.stringify(event));
});
