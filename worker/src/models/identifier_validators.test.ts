import { strict as assert } from "node:assert";
import { test } from "node:test";
import { IDENTIFIER_VALIDATORS } from "./identifier_validators";

// Expected values printed by python-stdnum's se.orgnr.validate in .venv (None where it raises).
test("SE_EN: stdnum.se.orgnr.validate", () => {
  const v = IDENTIFIER_VALIDATORS["SE_EN"]!;
  const cases: [string, string | null][] = [
    ["5560125790", "5560125790"], ["556012-5790", "5560125790"], ["556012 5790", "5560125790"],
    ["5560125791", null], ["556012579", null], ["55601257900", null], ["abcdefghij", null],
  ];
  for (const [input, out] of cases) assert.equal(v(input), out, input);
});
