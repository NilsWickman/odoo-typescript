import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PyStrSet } from "./pystrset";
import { expressionFieldNames } from "./fieldnames";

const load = <T>(name: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(`../../test/${name}`, import.meta.url).href), "utf8")) as T;

// fixtures written by CPython 3.12 with PYTHONHASHSEED=0 (the oracle's seed):
// test/pystrset_cases.json: `s = set(); for g in groups: t = set(); [t.add(w) for w in g]; s |= t`, then list(s);
// test/fieldnames_cases.json: 600 expressions of view attributes in odoo/addons/*/views/*.xml with at least two names,
// and list(get_expression_field_names(expr)) (odoo/odoo/tools/view_validation.py:229)
test("set unions iterate as CPython's", () => {
  for (const [groups, expected] of load<[string[][], string[]][]>("pystrset_cases.json")) {
    const s = new PyStrSet();
    for (const g of groups) s.update(PyStrSet.of(...g));
    assert.deepEqual([...s], expected, JSON.stringify(groups));
  }
});

test("view expressions' field names in Python's order", () => {
  for (const [expr, expected] of load<[string, string[]][]>("fieldnames_cases.json")) {
    assert.deepEqual([...expressionFieldNames(expr)], expected, expr);
  }
});
