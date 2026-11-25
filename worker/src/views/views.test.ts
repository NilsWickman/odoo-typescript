import { test } from "node:test";
import assert from "node:assert/strict";
import { parseXml } from "../xml/parse";
import { serializeXml } from "../xml/serialize";
import { xpath } from "./xpath";
import { applyInheritanceSpecs, locateNode } from "./inheritance";
import { combine, type ViewRow } from "./combine";
import { NotPorted } from "../errors";

const apply = (source: string, spec: string): string => serializeXml(applyInheritanceSpecs(parseXml(source), parseXml(spec)));

test("xpath subset", () => {
  const arch = parseXml(`<form><sheet><div class="oe_button_box x"/><group name="g"><field name="a"/><field name="b" widget="w"/></group></sheet><div><form/></div></form>`);
  assert.equal(xpath(arch, "//field[@name='b']")[0]?.attrib.get("widget"), "w");
  assert.equal(xpath(arch, "//field[@name='b'][@widget='w']").length, 1);
  assert.equal(xpath(arch, "//field[@name='a' and @widget='w']").length, 0);
  assert.equal(xpath(arch, "//div[hasclass('oe_button_box')]").length, 1);
  assert.equal(xpath(arch, "//group[@name='g']/*[1]")[0]?.attrib.get("name"), "a");
  assert.equal(xpath(arch, "//group/field[last()]")[0]?.attrib.get("name"), "b");
  assert.equal(xpath(arch, "//form[1]").length, 2); // the root and the nested one are both first form children
  assert.equal(xpath(arch, "//form/div[1]")[0]?.children.length, 1);
  assert.equal(xpath(arch, ".")[0], arch);
  assert.equal(xpath(arch, "//sheet//field[@name='a']").length, 1);
  assert.equal(xpath(arch, "//field[contains(@widget, 'w')]").length, 1);
  assert.throws(() => xpath(arch, "//field[text()='x']"), NotPorted);
  // a bare relative path selects children of the context node (the arch root), like `./field`
  assert.deepEqual(xpath(arch, "sheet"), xpath(arch, "./sheet"));
  assert.throws(() => xpath(arch, "field[text()='x']"), NotPorted);
});

test("locate_node by tag and attributes", () => {
  const arch = parseXml(`<form><field name="a"/><div id="x"/></form>`);
  assert.equal(locateNode(arch, parseXml(`<field name="a" position="after"/>`))?.tag, "field");
  assert.equal(locateNode(arch, parseXml(`<div id="x" position="inside"/>`))?.tag, "div");
  assert.equal(locateNode(arch, parseXml(`<div id="y"/>`)), null);
});

test("positions after/before/inside/replace keep lxml whitespace", () => {
  const src = `<form>\n    <field name="a"/>\n    <field name="b"/>\n</form>`;
  assert.equal(apply(src, `<field name="a" position="after">\n        <field name="x"/>\n    </field>`), `<form>\n    <field name="a"/>\n        <field name="x"/>\n    <field name="b"/>\n</form>`);
  // before: the previous sibling's trailing whitespace moves behind the inserted content (add_stripped_items_before)
  assert.equal(apply(src, `<field name="b" position="before"><field name="x"/></field>`), `<form>\n    <field name="a"/><field name="x"/>\n    <field name="b"/>\n</form>`);
  assert.equal(apply(src, `<form position="inside"><footer/></form>`), `<form>\n    <field name="a"/>\n    <field name="b"/><footer/>\n</form>`);
  // replace (outer): the replaced node goes away with its tail (lxml `remove`)
  assert.equal(apply(src, `<field name="a" position="replace"><field name="z"/></field>`), `<form>\n    <field name="z"/><field name="b"/>\n</form>`);
  assert.equal(apply(src, `<field name="a" position="replace"/>`), `<form>\n    <field name="b"/>\n</form>`);
  assert.equal(apply(src, `<data><xpath expr="//field[@name='b']" position="replace" mode="inner">X<field name="a" position="move"/></xpath></data>`), `<form>\n    <field name="b">X<field name="a"/></field>\n</form>`);
});

test("root replace keeps t-name; $0 copies the node", () => {
  assert.equal(apply(`<t t-name="a.b"><p/></t>`, `<xpath expr="." position="replace"><div><q>$0</q></div></xpath>`), `<div t-name="a.b"><q><t t-name="a.b"><p/></t></q></div>`);
});

test("attributes: set, remove, add/remove with separators", () => {
  const src = `<form><field name="a" class="x y" invisible="c1"/></form>`;
  assert.equal(apply(src, `<field name="a" position="attributes"><attribute name="string">S</attribute><attribute name="class"/></field>`), `<form><field name="a" invisible="c1" string="S"/></form>`);
  assert.equal(apply(src, `<field name="a" position="attributes"><attribute name="class" add="z" remove="x" separator=" "/></field>`), `<form><field name="a" class="y z" invisible="c1"/></form>`);
  assert.equal(apply(src, `<field name="a" position="attributes"><attribute name="invisible" add="c2" separator="or"/></field>`), `<form><field name="a" class="x y" invisible="(c1) or (c2)"/></form>`);
  assert.equal(apply(src, `<field name="a" position="attributes"><attribute name="invisible" remove="c1" separator="or"/></field>`), `<form><field name="a" class="x y"/></form>`);
  assert.throws(() => apply(src, `<field name="zz" position="attributes"/>`));
});

test("_combine order: extensions by priority then id, primaries last", () => {
  const row = (id: number, inheritId: number | null, mode: "primary" | "extension", priority: number, arch: string): ViewRow => ({ id, inheritId, mode, priority, key: null, model: null, type: null, active: true, arch });
  const root = row(1, null, "primary", 16, `<form><a/></form>`);
  const ext1 = row(2, 1, "extension", 16, `<a position="after"><b1/></a>`);
  const ext2 = row(3, 1, "extension", 10, `<a position="after"><b2/></a>`);
  const sub = row(4, 2, "extension", 16, `<b1 position="attributes"><attribute name="x">1</attribute></b1>`);
  const prim = row(5, 1, "primary", 1, `<a position="attributes"><attribute name="p">1</attribute></a>`);
  // hierarchy as children_views would give it: (priority, id) ordered
  const hierarchy = new Map<number, ViewRow[]>([[1, [prim, ext2, ext1]], [2, [sub]]]);
  // ext2 (priority 10) is applied first, then ext1 whose "after a" lands before b2, then ext1's own extension, then the primary child
  assert.equal(serializeXml(combine(root, hierarchy)), `<form><a p="1"/><b1 x="1"/><b2/></form>`);
});
