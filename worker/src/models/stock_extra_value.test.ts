// stock_extra_value.ts: `_get_value_from_extra`'s value from a compiled override (stock_landed_costs: 0 + 40.0 is a
// PyFloat in the runtime); before K2-base round 4 it refused, now it is its number; other values refuse.
import assert from "node:assert/strict";
import { test } from "node:test";
import { extraValue } from "./stock_extra_value";

test("_get_value_from_extra's value: a number or an integral float's PyFloat; anything else refuses", () => {
  assert.equal(extraValue({ value: 0, quantity: 0, description: false }), 0);
  assert.equal(extraValue({ value: { float: 40 }, quantity: 0, description: "Additional landed costs" }), 40);
  assert.equal(extraValue({ value: 12.5 }), 12.5);
  for (const bad of [null, [], {}, { value: "40" }, { value: null }, { value: { float: 40, x: 1 } }]) {
    assert.throws(() => extraValue(bad), (e: unknown) => e instanceof Error && e.constructor.name === "NotPorted");
  }
});
