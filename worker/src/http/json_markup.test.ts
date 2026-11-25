// http/json.ts dumps: a Markup (markupsafe's str subclass) is written as its text, as CPython's json.dumps and odoo's
// scriptsafe.dumps write it ({"a": "<b>é</b>"}, {"a": "<b>é</b>"}); before K2-base round 4 it was walked as an
// object, {"a": {"html": "<b>é</b>"}}.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Markup } from "../pyexpr/values";
import { dumpsResponse, dumpsScriptSafe } from "./json";

test("a Markup in a response is its text", () => {
  assert.equal(dumpsResponse({ a: new Markup("<b>é</b>") }), '{"a": "<b>é</b>"}');
  assert.equal(dumpsScriptSafe({ a: new Markup("<b>é</b>") }), dumpsScriptSafe({ a: "<b>é</b>" }));
  assert.equal(dumpsResponse([new Markup(""), { float: 2 }]), '["", 2.0]');
});
