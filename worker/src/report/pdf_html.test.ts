import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { splitReportHtml } from "./pdf_html";

// pdf_html_cases.json: lxml 5.2.1 (libxml2 2.12.6, the oracle's) on small documents, by the same steps as
// base_report_wkhtmltox `_prepare_wkhtmltopdf_html` (headers and footers moved with their tails, articles with theirs)
interface Case { html: string; articles: string[]; bodyFallback: string | null; header: string; footer: string; args: [string, string][] }
const cases = JSON.parse(readFileSync(fileURLToPath(new URL("./pdf_html_cases.json", import.meta.url).href), "utf8")) as Case[];

test("the report html splits as lxml.html does", () => {
  for (const c of cases) {
    const p = splitReportHtml(c.html);
    assert.deepEqual(p.articles.map((a) => a.html), c.articles);
    assert.equal(p.bodyFallback, c.bodyFallback);
    assert.equal(p.header, c.header);
    assert.equal(p.footer, c.footer);
    assert.deepEqual(p.args, c.args);
  }
});

test("what libxml2 would repair refuses", () => {
  assert.throws(() => splitReportHtml("<html><body><main><p>a<div>b</div></p></main></body></html>"), /open <p>/);
  assert.throws(() => splitReportHtml("<html><body><main><span>a</div></main></body></html>"), /end tag/);
});
