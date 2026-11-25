import { strict as assert } from "node:assert";
import { test } from "node:test";
import { pyStr } from "./pystr";

// Expected values printed by CPython 3.12 `str(value)`.
test("str() of the search panel's context dict", () => {
  assert.equal(pyStr({ group_by: [], list_optional_show: ["email", "phone"] }), "{'group_by': [], 'list_optional_show': ['email', 'phone']}");
});

test("str() quoting of nested strings", () => {
  assert.equal(pyStr(["it's", 'say "hi"', "both ' and \""]), `["it's", 'say "hi"', 'both \\' and "']`);
  assert.equal(pyStr({ a: true, b: null, c: { float: 1.5 }, d: { float: 2 }, e: 3, f: "é\n\t\\" }), "{'a': True, 'b': None, 'c': 1.5, 'd': 2.0, 'e': 3, 'f': 'é\\n\\t\\\\'}");
  assert.equal(pyStr("plain"), "plain");
});
