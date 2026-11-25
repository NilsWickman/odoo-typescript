// relaxng.ts against lxml: test/relaxng_cases.json holds XML data files (hand cases, Odoo's own small data files and
// seeded mutations of them) with the AssertionError message lxml gives with Odoo's import_xml.rng, or null when the
// file is valid (test/relaxng_cases.py writes it). RELAXNG_CASES=<jsonl> checks another file, e.g. the --all set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseXml } from "../xml/parse";
import { schemaFromText, validateWith } from "./relaxng";

const rng = (JSON.parse(readFileSync(fileURLToPath(new URL("../../gen/out/import_xml_rng.json", import.meta.url).href), "utf8")) as { rng: string }).rng;
const schema = schemaFromText(rng);

type Case = { xml: string; expected: string | null; source?: string };
function cases(): Case[] {
  const other = globalThis.process.env["RELAXNG_CASES"];
  if (other) return readFileSync(other, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Case);
  return JSON.parse(readFileSync(fileURLToPath(new URL("../../test/relaxng_cases.json", import.meta.url).href), "utf8")) as Case[];
}

test("import_xml.rng: the same verdict and message as lxml", () => {
  const all = cases();
  const wrong: string[] = [];
  for (const c of all) {
    let got: string | null;
    try { got = validateWith(schema, parseXml(c.xml)); } catch (e) { got = `throws ${e instanceof Error ? e.message : String(e)}`; }
    if (got !== c.expected) wrong.push(`${c.source ?? "hand"}: expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(got)}\n  ${c.xml.slice(0, 300)}`);
  }
  assert.equal(wrong.length, 0, `${wrong.length} of ${all.length} differ:\n${wrong.slice(0, 15).join("\n")}`);
});

test("the parser's source lines are libxml2's (the line of the start tag's closing '>')", () => {
  const root = parseXml('<odoo\n>\n<a\n b="1"\n/>\n<!-- c\n -->\n<c/></odoo>');
  assert.deepEqual([root.sourceline, ...root.children.filter((n) => n.kind === "element").map((e) => e.sourceline)], [2, 5, 8]);
});
