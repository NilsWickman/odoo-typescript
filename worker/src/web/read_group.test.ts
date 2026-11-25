import { test } from "node:test";
import assert from "node:assert/strict";
import { exactInAnyOrder } from "./read_group";

// PostgreSQL's SUM(float8) adds in its plan's row order: 0.1 + 0.2 + 0.3 is 0.6000000000000001 one way, 0.6 the other
test("exactInAnyOrder: decimals whose partial sums round are not", () => {
  assert.equal((0.1 + 0.2) + 0.3 === (0.3 + 0.2) + 0.1, false);
  assert.equal(exactInAnyOrder([0.1, 0.2, 0.3]), false);
  assert.equal(exactInAnyOrder([10.1, 20.2, 30.3, 0.7]), false);
});

test("exactInAnyOrder: integers, halves and quarters within 2**53 units are", () => {
  assert.equal(exactInAnyOrder([]), true);
  assert.equal(exactInAnyOrder([0, -0]), true);
  assert.equal(exactInAnyOrder([20, 32, 10, 8, 15, 76, 0.25, 2]), true);
  assert.equal(exactInAnyOrder([100, -3.5, 0.125]), true);
  assert.equal(exactInAnyOrder([2 ** 52, 2 ** 52]), true);
  assert.equal(exactInAnyOrder([2 ** 53, 1]), false);
  assert.equal(exactInAnyOrder([1, Number.NaN]), false);
  assert.equal(exactInAnyOrder([1, Infinity]), false);
});
