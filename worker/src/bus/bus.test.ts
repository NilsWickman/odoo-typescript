import { test } from "node:test";
import assert from "node:assert/strict";
import { channelWithDb, jsonDump } from "./bus";

test("channel_with_db (bus.py:41-48)", () => {
  assert.deepEqual(channelWithDb("db", "broadcast"), ["db", "broadcast"]);
  assert.deepEqual(channelWithDb("db", { model: "res.users", id: 2 }), ["db", "res.users", 2]);
  assert.deepEqual(channelWithDb("db", { model: "res.users", id: 2, sub: "presence" }), ["db", "res.users", 2, "presence"]);
});

test("json_dump matches json.dumps(separators=(',', ':')) with ensure_ascii", () => {
  assert.equal(jsonDump(["db", "res.users", 2, "presence"]), '["db","res.users",2,"presence"]');
  assert.equal(jsonDump({ type: "t", payload: { a: "é", b: "€", c: "😀" } }),
    '{"type":"t","payload":{"a":"\\u00e9","b":"\\u20ac","c":"\\ud83d\\ude00"}}');
});
