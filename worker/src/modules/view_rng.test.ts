import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { schemaValid, viewSchemaFromFiles } from "./relaxng";
import { parseXml } from "../xml";

const files = (JSON.parse(readFileSync(fileURLToPath(new URL("../../gen/out/view_rng.json", import.meta.url).href), "utf8")) as { files: Record<string, string> }).files;

// lxml's RelaxNG(etree.parse("odoo/odoo/addons/base/rng/<type>_view.rng")).validate(etree.fromstring(arch)) in the
// oracle's environment (.venv)
const CASES: [string, boolean, string][] = [
  ["list", true, "<list><field name=\"name\"/></list>"],
  ["list", true, "<list editable=\"bottom\"><field name=\"name\" invisible=\"1\"/><button name=\"x\" type=\"object\"/></list>"],
  ["list", false, "<list><div/></list>"],
  ["list", false, "<list><field/></list>"],
  ["list", false, "<list foo=\"1\"><field name=\"a\"/></list>"],
  ["list", false, "<list limit=\"x\"><field name=\"a\"/></list>"],
  ["list", true, "<list limit=\"80\"><field name=\"a\"/></list>"],
  ["list", true, "<list><field name=\"a\" widget=\"x\" optional=\"show\"/><header><button name=\"b\" type=\"object\" string=\"B\"/></header></list>"],
  ["list", true, "<list><groupby name=\"a\"><field name=\"b\"/></groupby></list>"],
  ["list", true, "<list><control><create string=\"x\"/></control></list>"],
  ["search", true, "<search><field name=\"name\"/><filter name=\"f\" domain=\"[]\"/></search>"],
  ["search", false, "<search><div/></search>"],
  ["search", true, "<search><group><filter name=\"g\" context=\"{}\"/></group><separator/></search>"],
  ["search", true, "<search><searchpanel><field name=\"a\"/></searchpanel></search>"],
  ["search", true, "<search><field name=\"a\" filter_domain=\"[]\" operator=\"ilike\"/></search>"],
  ["graph", true, "<graph><field name=\"a\"/></graph>"],
  ["graph", true, "<graph type=\"pie\"><field name=\"a\" type=\"measure\"/></graph>"],
  ["graph", false, "<graph type=\"x\"><field name=\"a\"/></graph>"],
  ["graph", false, "<graph><div/></graph>"],
  ["pivot", true, "<pivot><field name=\"a\" type=\"row\"/></pivot>"],
  ["pivot", false, "<pivot><div/></pivot>"],
  ["calendar", true, "<calendar date_start=\"a\"><field name=\"b\"/></calendar>"],
  ["calendar", true, "<calendar><field name=\"b\"/></calendar>"],
  ["calendar", true, "<calendar date_start=\"a\" mode=\"month\"/>"],
];

test("view schemas as lxml's RelaxNG", () => {
  for (const [viewType, ok, arch] of CASES) {
    assert.equal(schemaValid(viewSchemaFromFiles(viewType, files), parseXml(arch)), ok, arch);
  }
});
