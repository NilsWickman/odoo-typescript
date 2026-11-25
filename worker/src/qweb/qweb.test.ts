import { test } from "node:test";
import assert from "node:assert/strict";
import { parseXml } from "../xml/parse";
import { assetCallKey, renderLoaded, type TemplateSet } from "./index";
import { Markup } from "../pyexpr/values";
import { NotPorted } from "../errors";

/** A template set from inline archs keyed by t-name (what loadTemplates builds from ir_ui_view). */
function templates(archs: Record<string, string>, assets: Record<string, string[]> = {}): TemplateSet {
  const byRef = new Map<string | number, { id: number; key: string | null; tree: ReturnType<typeof parseXml> }>();
  let id = 1;
  for (const [key, arch] of Object.entries(archs)) {
    const t = { id: id++, key, tree: parseXml(arch) };
    byRef.set(key, t);
    byRef.set(t.id, t);
  }
  return { byRef, assets: new Map(Object.entries(assets)), rtl: false };
}

const r = (archs: Record<string, string>, values: Record<string, unknown> = {}, root = "t.main", assets: Record<string, string[]> = {}): Promise<string> =>
  renderLoaded(templates(archs, assets), root, new Map(Object.entries(values)));

test("static nodes: entities decoded in text, escaped in attributes, void elements", async () => {
  assert.equal(await r({ "t.main": `<t t-name="t.main">&lt;!DOCTYPE html&gt;\n<html><meta charset="utf-8"/><a href="/x?a=1&amp;b=2" title="it's">x &amp;copy; =&gt;</a></html></t>` }),
    `<!DOCTYPE html>\n<html><meta charset="utf-8"/><a href="/x?a=1&amp;b=2" title="it&#39;s">x &copy; =></a></html>`);
});

test("t-out escapes, Markup passes, None drops the tag unless there is default content", async () => {
  const arch = `<t t-name="t.main"><title t-out="title or 'Odoo'"/><span t-out="m"/><p t-out="none"/><q t-out="none">dflt</q><t t-out="n"/><b t-out="z"/></t>`;
  assert.equal(await r({ "t.main": arch }, { title: "<A&B>", m: new Markup("<i>x</i>"), n: 0, z: "" }), `<title>&lt;A&amp;B&gt;</title><span><i>x</i></span><q>dflt</q>0<b></b>`);
});

test("t-if / t-elif / t-else whitespace rules", async () => {
  const arch = `<t t-name="t.main"><div>
    <p t-if="a">A</p>
    <p t-elif="b">B</p>
    <!-- c -->
    <p t-else="">C</p>
    <t t-if="x">
        <i/>
    </t>
    <span t-if="y">Y</span>
</div></t>`;
  // measured on Odoo (ir.qweb._render, 2026-11-04): the tail of the comment between t-elif and t-else is output after
  // the chain (the loop of _compile_directive_inner_content runs over list(el) taken before the comment's removal)
  assert.equal(await r({ "t.main": arch }, { a: true, x: false, y: false }), `<div>\n    <p>A</p>\n    \n</div>`);
  assert.equal(await r({ "t.main": arch }, { b: true, x: true, y: true }), `<div>\n    <p>B</p>\n    \n        <i></i>\n    <span>Y</span>\n</div>`);
  assert.equal(await r({ "t.main": arch }, {}), `<div>\n    <p>C</p>\n    \n</div>`);
});

test("rstrip before a directive strips every trailing newline Python's `$` reaches", async () => {
  // measured on Odoo (ir.qweb._render, 2026-11-16): RSTRIP_REGEXP `\n[ \t]*$` with re.sub removes both newlines of
  // "</p>\n\n" (Python's `$` also matches before a final newline), lunch's supplier mail template
  const arch = (cond: string): string => `<t t-name="t.main"><div><p>a</p>\n\n<t t-if="${cond}">\n    <br/>\n</t>\n<b/></div></t>`;
  assert.equal(await r({ "t.main": arch("1") }), `<div><p>a</p>\n    <br/>\n<b></b></div>`);
  assert.equal(await r({ "t.main": arch("0") }), `<div><p>a</p>\n<b></b></div>`);
});

test("t-foreach loop variables, dicts, ints (a 0 attribute value is dropped like None)", async () => {
  const arch = `<t t-name="t.main"><ul><li t-foreach="items" t-as="i" t-att-data-x="i_index" t-att-class="i_parity"><t t-out="i"/><t t-if="i_last">!</t></li></ul><t t-foreach="d" t-as="k"><t t-out="k"/>=<t t-out="k_value"/>;</t><t t-foreach="3" t-as="n"><t t-out="n"/></t><t t-out="n_size"/></t>`;
  assert.equal(await r({ "t.main": arch }, { items: ["a", "b"], d: new Map([["x", 1], ["y", 2]]) }),
    `<ul><li class="even">a</li><li data-x="1" class="odd">b!</li></ul>x=1;y=2;0123`);
});

test("t-set: value, valuef, body as Markup, dict update", async () => {
  const arch = `<t t-name="t.main">
    <t t-set="a" t-value="1 + 1"/>
    <t t-set="b" t-valuef="v#{a}-{{a}}"/>
    <t t-set="c"><b t-out="b"/>
    </t>
    <t t-set="{'d': 4}"/>
    <t t-set="e"/><div t-out="c"/>|<t t-out="d"/>|<t t-out="e == ''"/>|<t t-out="'&lt;b&gt;' in c"/></t>`;
  assert.equal(await r({ "t.main": arch }), `<div><b>v2-2</b>\n    </div>|4|True|True`);
});

test("t-att, t-att-*, t-attf-*, falsy attributes dropped, static first", async () => {
  const arch = `<t t-name="t.main"><form t-attf-class="f #{'' if login else 'd-none'}" role="form" t-att-action="act" t-att-autofocus="None" t-att-x="False" t-att-y="0" t-att-z="''" t-att="{'style': 's'}"/></t>`;
  assert.equal(await r({ "t.main": arch }, { act: "/web/login" }), `<form role="form" class="f d-none" action="/web/login" z="" style="s"></form>`);
  assert.equal(await r({ "t.main": `<t t-name="t.main"><a t-att-href="h">x</a></t>` }, { h: "javascript:alert(1)" }), `<a href="">x</a>`);
});

test("t-call with slot, arguments and body whitespace", async () => {
  const archs = {
    "t.main": `<t t-name="t.main">
    <t t-call="t.layout" title="'T'" cls.f="c#{1}">
        <p>body</p>
    </t>
</t>`,
    "t.layout": `<t t-name="t.layout">
<html t-att-class="cls"><title t-out="title"/><body>
    <t t-out="0"/>
</body></html>
</t>`,
  };
  // the callee's root text "\n" stays (FIRST_RSTRIP only collapses several blank lines); the body keeps its last tail
  // (`_append_text('')` before the rstrip flush, 2688-2690) and the template output is rstripped
  assert.equal(await r(archs), `\n<html class="c1"><title>T</title><body>\n    \n        <p>body</p>\n    \n</body></html>`);
  // the slot is '' without a body; values do not leak back to the caller
  assert.equal(await r({ "t.main": `<t t-name="t.main"><t t-call="t.sub"/><t t-out="v"/></t>`, "t.sub": `<t t-name="t.sub"><t t-set="v" t-value="1"/>[<t t-out="0"/>]</t>` }), `[]`);
  assert.equal(await r({ "t.main": `<t t-name="t.main"><t t-out="xmlid"/></t>` }), `t.main`);
});

test("t-call-assets renders the bundle links as Odoo does", async () => {
  const archs = { "t.main": `<t t-name="t.main"><head>
        <t t-call-assets="web.a" t-binary="True"/>
        <t t-call-assets="web.b" t-js="false"/>
        <t t-call-assets="web.c" t-css="false" defer_load="True"/>
        <t t-call-assets="web.d" t-css="false" lazy_load="True"/>
        <t t-call-assets="web.e" media="print" t-js="false"/>
        <t t-call-assets="web.f"/>
    </head></t>` };
  const assets = {
    [assetCallKey({ bundle: "web.a", css: true, js: true, binary: true })]: ["/web/assets/1/web.a.min.woff2", "/web/assets/1/x.woff"],
    [assetCallKey({ bundle: "web.b", css: true, js: false, binary: false })]: ["/web/assets/2/web.b.min.css"],
    [assetCallKey({ bundle: "web.c", css: false, js: true, binary: false })]: ["/web/assets/3/web.c.min.js"],
    [assetCallKey({ bundle: "web.d", css: false, js: true, binary: false })]: ["/web/assets/4/web.d.min.js"],
    [assetCallKey({ bundle: "web.e", css: true, js: false, binary: false })]: ["/web/assets/5/web.e.min.css"],
    [assetCallKey({ bundle: "web.f", css: true, js: true, binary: false })]: ["/web/assets/6/web.f.min.css", "/web/assets/6/web.f.min.js"],
  };
  assert.equal(await r(archs, {}, "t.main", assets), `<head>
        <link rel="preload" href="/web/assets/1/web.a.min.woff2" as="font" crossorigin=""/>
        <link type="text/css" rel="stylesheet" href="/web/assets/2/web.b.min.css"/>
        <script type="text/javascript" defer="defer" src="/web/assets/3/web.c.min.js" onerror="__odooAssetError=1"></script>
        <script type="text/javascript" data-src="/web/assets/4/web.d.min.js" onerror="__odooAssetError=1"></script>
        <link type="text/css" rel="stylesheet" href="/web/assets/5/web.e.min.css" media="print"/>
        <link type="text/css" rel="stylesheet" href="/web/assets/6/web.f.min.css"/>
        <script type="text/javascript" src="/web/assets/6/web.f.min.js" onerror="__odooAssetError=1"></script>
    </head>`);
});

test("json.dumps is script-safe in t-out and plain in attributes", async () => {
  const arch = `<t t-name="t.main"><script>x = <t t-out="json.dumps(d)"/>;</script><owl t-att-props="json.dumps(d)"/></t>`;
  assert.equal(await r({ "t.main": arch }, { d: { a: "<b>&", f: { float: 2 } } }), `<script>x = {"a": "\\u003cb\\u003e\\u0026", "f": 2.0};</script><owl props="{&#34;a&#34;: &#34;&lt;b&gt;&amp;&#34;, &#34;f&#34;: 2.0}"></owl>`);
});

test("unsupported directives are NotPorted", async () => {
  await assert.rejects(async () => r({ "t.main": `<t t-name="t.main"><span t-field="r.name"/></t>` }), NotPorted);
  await assert.rejects(async () => r({ "t.main": `<t t-name="t.main"><span t-out="x" t-options-widget="'float'"/></t>` }), NotPorted);
  await assert.rejects(async () => r({ "t.main": `<t t-name="t.main"><t t-call="t.{{x}}"/></t>` }, { x: "y" }), NotPorted);
  await assert.rejects(async () => r({ "t.main": `<t t-name="t.main"><div groups="base.group_user"/></t>` }), NotPorted);
});
