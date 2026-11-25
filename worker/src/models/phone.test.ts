// canonicalPhone against Odoo's phone_parse (E164 or False) on phonenumbers' example numbers of every region
// (test/phone_cases.py -> test/phone_cases.json): written as E164, with a national prefix after the country code
// ("+32 010 12 34 56", l10n_uk's demo company), nationally with the region and with another country's region.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { canonicalPhone } from "./phone";

const { cases } = JSON.parse(readFileSync(new URL("../../test/phone_cases.json", import.meta.url).pathname, "utf8")) as { cases: [string, string | null, string | false][] };

test("canonicalPhone is phone_parse's E164 for the example numbers of every region", async () => {
  assert.ok(cases.length > 3000);
  const bad: string[] = [];
  for (const [n, region, want] of cases) {
    let got: unknown;
    try { got = await canonicalPhone(n, region); } catch (e) { got = `refused: ${(e as Error).message}`; }
    if (got !== want) bad.push(`${n} [${region}]: ${String(got)} != ${String(want)}`);
  }
  assert.equal(bad.length, 0, `${bad.length} of ${cases.length} differ:\n${bad.slice(0, 40).join("\n")}`);
});
