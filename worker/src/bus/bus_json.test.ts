import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonDump } from "./bus";

// bus.py json_dump: json.dumps(separators=(',', ':')) with ensure_ascii; a Store's float field (PyFloat) keeps its ".0"
test("jsonDump: compact JSON, escaped non-ASCII, Python floats", () => {
  assert.equal(jsonDump({ a: { float: 0 }, b: "é", c: [1, undefined, { float: 2.5 }], d: undefined, e: null }), '{"a":0.0,"b":"\\u00e9","c":[1,null,2.5],"e":null}');
  assert.equal(jsonDump(["x", 3, true]), '["x",3,true]');
});
