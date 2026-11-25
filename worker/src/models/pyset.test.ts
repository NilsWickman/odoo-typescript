import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PySet, pySetOrder } from "./pyset";

// list(set(ids)) of CPython 3.12 (the oracle's .venv), ids inserted in the given order
const CASES: [number[], number[]][] = [
  [[251, 249], [249, 251]],
  [[241, 243, 245], [241, 243, 245]],
  [[257, 259, 255], [257, 259, 255]],
  [[1, 9], [1, 9]],
  [[9, 1], [9, 1]],
  [[8, 16, 24], [8, 16, 24]],
  [[3, 11, 19, 27], [11, 19, 3, 27]],
  [[100, 4, 12], [12, 100, 4]],
  [[131, 380, 184, 354], [184, 354, 131, 380]],
  [[334, 272, 15, 239], [272, 239, 334, 15]],
  [[333, 27], [27, 333]],
  [[58, 191], [58, 191]],
  [[127, 195, 279], [195, 279, 127]],
  [[294, 128], [128, 294]],
  [[375, 111], [111, 375]],
  [[144, 94, 393], [144, 393, 94]],
];

test("pySetOrder: the iteration order of a small Python set of ints", () => {
  for (const [ids, order] of CASES) assert.deepEqual(pySetOrder(ids), order, JSON.stringify(ids));
});

// worker/test/pyset_cases.py: random sets of 1 to 300 ids (resizes, linear probes) and `set().update(s)` (set_merge)
const RANDOM = JSON.parse(readFileSync(fileURLToPath(new URL("../../test/pyset_cases.json", import.meta.url).href), "utf8")) as [number[], number[], number[]][];

test("PySet: list(set(ids)) and set().update(set(ids)) as CPython 3.12", () => {
  for (const [ids, order, merged] of RANDOM) {
    assert.deepEqual(pySetOrder(ids), order, JSON.stringify(ids));
    const all = new PySet();
    all.update(PySet.fromList(ids));
    assert.deepEqual(all.order(), merged, `update ${JSON.stringify(ids)}`);
  }
});

// `list(set(a) - set(b))` and `list(set(b) - set(a))` of CPython 3.12.3 (random.seed(7), and the users of a group)
const DIFFERENCES: [number[], number[], number[], number[]][] = [[[20, 51, 84, 7, 10, 106, 69, 13, 47, 75, 8], [5, 12, 56, 51, 7, 8], [69, 10, 75, 106, 13, 47, 20, 84], [56, 12, 5]], [[55, 8, 106, 73, 16, 29, 81, 81, 75, 8, 74, 75, 51, 7, 29, 6, 72, 110], [38, 54, 110], [6, 7, 8, 73, 106, 75, 74, 72, 16, 81, 51, 55, 29], [38, 54]], [[74, 40, 72, 105], [14, 75, 72], [40, 105, 74], [75, 14]], [[71, 92, 9, 73], [73], [9, 92, 71], []], [[69, 55, 100, 41, 60, 75, 119, 59, 47, 39, 32, 102, 24, 90, 100, 32, 11, 74, 39, 68, 64, 113], [94, 58, 37, 78, 10], [11, 24, 32, 39, 41, 47, 55, 59, 60, 64, 68, 69, 74, 75, 90, 100, 102, 113, 119], [37, 10, 78, 58, 94]], [[54, 22, 97, 44, 20, 63, 54, 6, 86, 10, 98, 72, 74, 102, 113, 105, 41], [89, 45, 77, 64, 75, 97, 41, 20], [98, 102, 6, 72, 105, 10, 74, 44, 113, 54, 22, 86, 63], [64, 75, 45, 77, 89]], [[90, 86, 9, 8, 94, 90, 40, 83, 74, 88, 106, 58, 37, 92, 50, 114], [3, 60, 46, 22, 79], [37, 90, 8, 9, 40, 74, 106, 50, 83, 114, 86, 88, 58, 92, 94], [3, 46, 79, 22, 60]], [[8, 28, 99, 37, 17, 95, 32, 51, 51, 118, 112, 64, 11, 22, 58, 52], [114, 18, 105, 56, 22, 95], [32, 64, 99, 37, 8, 11, 112, 17, 51, 52, 118, 58, 28], [56, 105, 114, 18]], [[114, 49, 30, 20, 11, 23, 20, 30, 85, 30, 2, 63, 107, 76, 24, 34, 37, 1, 19, 54, 69, 48], [17, 89, 110, 66, 80], [1, 2, 11, 19, 20, 23, 24, 30, 34, 37, 48, 49, 54, 63, 69, 76, 85, 107, 114], [66, 110, 80, 17, 89]], [[116, 112, 100, 112, 88, 103, 72, 51, 51, 52, 51, 14, 62, 82, 52], [112], [100, 103, 72, 14, 82, 51, 116, 52, 88, 62], []], [[57, 21, 15, 44, 77, 7, 14], [77], [7, 44, 14, 15, 21, 57], []], [[47, 79, 4, 10], [79, 49, 20, 4, 10], [47], [49, 20]], [[61, 16, 15, 109, 63, 60, 62, 62, 40, 11, 19, 14], [95, 34, 62, 107, 89, 40], [11, 109, 14, 15, 16, 19, 60, 61, 63], [89, 34, 107, 95]], [[27], [19, 89, 70, 118, 4, 27], [], [4, 70, 19, 118, 89]], [[8, 5, 6], [5], [8, 6], []]];

test("PySet.difference: the iteration order of `a - b` (set_difference, set_copy_and_difference)", () => {
  for (const [a, b, ab, ba] of DIFFERENCES) {
    const A = PySet.fromList(a), B = PySet.fromList(b);
    assert.deepEqual(A.difference(B).order(), ab, `${JSON.stringify(a)} - ${JSON.stringify(b)}`);
    assert.deepEqual(B.difference(A).order(), ba, `${JSON.stringify(b)} - ${JSON.stringify(a)}`);
  }
});
