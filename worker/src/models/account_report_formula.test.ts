import { test } from "node:test";
import assert from "node:assert/strict";
import { accountCodesFormulaValid } from "./account_report_create";

// [formula, valid] from account_report.py:751-758 run in Python 3 (ACCOUNT_CODES_ENGINE_SPLIT_REGEX and _TERM_REGEX,
// 2026-11-13): the account_codes formulas of Odoo's own XML data and edge cases of the term syntax
const CASES: [string, boolean][] = [
  ["", true],
  ["+", false],
  ["-", false],
  ["--1", false],
  ["-10\\(101,102)", true],
  ["-2407", true],
  ["-92", true],
  ["1,2", false],
  ["1-2+-3", false],
  ["10C", true],
  ["10D", true],
  ["10DC", false],
  ["10\\(", false],
  ["10\\(101)C", true],
  ["110202", true],
  ["1407", true],
  ["1486", true],
  ["1CD", false],
  ["1\\(1)\\(2)", false],
  ["200307", true],
  ["4531 + 4532 + 4534 + 4538 + 4539", true],
  ["C", false],
  ["D", false],
  ["\\(1)", false],
  ["a b + c", true],
  ["tag()", false],
  ["tag(x.y)", true],
  ["tag(x.y)D", true],
  ["x.y.z", true],
];

test("account_codes formula check as Odoo's", () => {
  for (const [formula, valid] of CASES) assert.equal(accountCodesFormulaValid(formula), valid, formula);
});
