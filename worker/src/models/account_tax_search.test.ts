import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTaxNameSearch } from "./account_tax_search";

// the docstring's examples (account_tax.py:465-473) and Python's output for the others (re.split, \\W, '%'.join)
test("_parse_name_search", () => {
  const cases: [string, string][] = [["0EUM", "0%E%U%M"], ["21M", "2%1%M"], ['21" M"', "2%1% M%"], ['21" M"co', "2%1% M%c%o"],
    ["15%", "1%5"], ["25% EU S", "2%5%E%U%S"], ["åäö 6", "å%ä%ö%6"], ["", ""], ['"a%b"', "%a_b%"]];
  for (const [given, expected] of cases) assert.equal(parseTaxNameSearch(given), expected, given);
});
