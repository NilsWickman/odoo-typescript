import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseHtmlFragment, parseXml, XmlSyntaxError } from "./parse";
import type { Node } from "./node";

/** worker/test/mail_template_parse_cases.py: [xmlid, lang, method, body, lxml.html tree] of every mail template. */
type Tree = [string, string[][], string, Tree[], string] | ["<!--", string, string];
const CASES = JSON.parse(readFileSync(fileURLToPath(new URL("../../test/mail_template_parse_cases.json", import.meta.url).href), "utf8")) as
  [string, string, "xml" | "html", string, Tree][];

function canon(n: Node): Tree {
  if (n.kind === "comment") return ["<!--", n.text, n.tail ?? ""];
  if (n.kind === "pi") throw new Error("processing instruction");
  return [n.tag, [...n.attrib].map(([k, v]) => [k, v]), n.text ?? "", n.children.map(canon), n.tail ?? ""];
}

test("parseHtmlFragment gives lxml.html's tree of every mail template, in both serializations", () => {
  assert.equal(CASES.length, 96);
  for (const [xmlid, lang, method, body, tree] of CASES) {
    assert.deepEqual(canon(parseHtmlFragment(body)), tree, `${xmlid} ${lang} ${method}`);
  }
});

test("on the xml serialization (Odoo before 9710d237f) it is the tree parseXml gives", () => {
  for (const [xmlid, lang, method, body] of CASES.filter((c) => c[2] === "xml")) {
    assert.deepEqual(canon(parseHtmlFragment(body)), canon(parseXml(`<div>${body}</div>`)), `${xmlid} ${lang} ${method}`);
  }
});

test("what libxml2 would repair refuses", () => {
  for (const src of ["<p>a", "<b><i>x</b></i>", "<p>a<p>b", "<td x=1>", "<input checked>", "<DIV>x</DIV>", "a&nbsp;b",
    "<![CDATA[x]]>", "<?pi x?>", "<wbr>", "</br>"]) {
    assert.throws(() => parseHtmlFragment(src), XmlSyntaxError, src);
  }
  assert.deepEqual(canon(parseHtmlFragment("a<br>b<img src='x'><t t-out='y'/>c")), ["div", [], "a", [["br", [], "", [], "b"],
    ["img", [["src", "x"]], "", [], ""], ["t", [["t-out", "y"]], "", [], "c"]], ""]);
  assert.deepEqual(canon(parseHtmlFragment('<a title="x\ny">z</a>')), ["div", [], "", [["a", [["title", "x\ny"]], "z", [], ""]], ""]);
});

test("both serializations of a template give one tree (mail/task_create.ts isAckBody relies on it)", () => {
  const byKey = new Map<string, Tree[]>();
  for (const [xmlid, lang, , , tree] of CASES) byKey.set(`${xmlid} ${lang}`, [...(byKey.get(`${xmlid} ${lang}`) ?? []), tree]);
  let pairs = 0;
  for (const [key, trees] of byKey) {
    if (trees.length < 2) continue;
    pairs++;
    assert.deepEqual(trees[1], trees[0], key);
  }
  assert.ok(pairs > 0);
  assert.ok(CASES.some((c) => c[0] === "project.mail_template_data_project_task"));
});
