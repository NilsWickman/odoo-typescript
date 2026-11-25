import { test } from "node:test";
import assert from "node:assert/strict";
import { parseXml } from "./parse";
import { serializeXml } from "./serialize";
import { element } from "./node";

test("round trip of lxml-shaped archs", () => {
  const src = `<form string="A &amp; B" x="1&gt;2&#10;t&quot;q"><!-- c --> t&amp;x&gt;&lt; <b/>tail<?pi data?>&#13;<t t-out="'a'"/></form>`;
  assert.equal(serializeXml(parseXml(src)), src);
});

test("text and attribute semantics", () => {
  const el = parseXml(`<a x='q"q' y="a&#10;b">&lt;!DOCTYPE html&gt;<![CDATA[x<y]]></a>`);
  assert.equal(el.attrib.get("x"), 'q"q');
  assert.equal(el.attrib.get("y"), "a\nb");
  assert.equal(el.text, "<!DOCTYPE html>x<y");
  assert.equal(serializeXml(el), `<a x="q&quot;q" y="a&#10;b">&lt;!DOCTYPE html&gt;x&lt;y</a>`);
});

test("empty text serializes as an open/close pair, null text self-closes", () => {
  const a = element("a");
  assert.equal(serializeXml(a), "<a/>");
  a.text = "";
  assert.equal(serializeXml(a), "<a></a>");
});

test("prolog and declaration are dropped, comments and PIs keep tails", () => {
  const el = parseXml(`<?xml version="1.0"?>\n<!-- top -->\n<r><!--c-->tail<?pi?>x</r>`);
  assert.equal(serializeXml(el), "<r><!--c-->tail<?pi?>x</r>");
  assert.equal(el.children.length, 2);
});

test("errors", () => {
  assert.throws(() => parseXml("<a>&nbsp;</a>"));
  assert.throws(() => parseXml("<a><b></a>"));
});
