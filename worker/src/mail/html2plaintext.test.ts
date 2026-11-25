import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { html2plaintext, pySplitlines } from "./html2plaintext";

// [html_sanitize(html), html2plaintext(...)] of odoo.tools.mail (test/html2plaintext_cases.py)
const CASES = JSON.parse(readFileSync(fileURLToPath(new URL("../../test/html2plaintext_cases.json", import.meta.url).href), "utf8")) as [string, string][];

test("html2plaintext as odoo.tools.mail", () => {
  for (const [html, expected] of CASES) assert.equal(html2plaintext(html), expected, html);
});

test("str.splitlines", () => {
  assert.deepEqual(pySplitlines("a\n\n\n"), ["a", "", ""]);
  assert.deepEqual(pySplitlines("a\r\nb\rc\x0bd"), ["a", "b", "c", "d"]);
  assert.deepEqual(pySplitlines(""), []);
  assert.deepEqual(pySplitlines("\n"), [""]);
});
