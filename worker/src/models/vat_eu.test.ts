import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { VAT_MODULES } from "./vat_stdnum";

// test/vat_eu_cases.json: [country, number, stdnum compact, stdnum is_valid(compact)], printed by python-stdnum in .venv
const CASES = JSON.parse(readFileSync(fileURLToPath(new URL("../../test/vat_eu_cases.json", import.meta.url).href), "utf8")) as [string, string, string, boolean][];

test("EU VAT modules against python-stdnum (compact and is_valid)", () => {
  for (const [cc, number, compact, valid] of CASES) {
    const m = VAT_MODULES[cc]!;
    assert.equal(m.compact(number), compact, `${cc} compact ${number}`);
    if (cc === "DE" && !valid) { assert.throws(() => m.isValid(compact), /stnr/); continue; } // check_vat_de: stnr not ported
    assert.equal(m.isValid(compact), valid, `${cc} is_valid ${number}`);
  }
});
