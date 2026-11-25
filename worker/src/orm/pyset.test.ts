import { test } from "node:test";
import assert from "node:assert/strict";
import { pyStrHash, pySetOrder } from "./pyset";

// expected values printed by CPython 3.12.3 with PYTHONHASHSEED=0 (hash(s) and list(set(items)))
test("hash(str) with seed 0", () => {
  assert.equal(pyStrHash("EU"), 17295395063398690839n);
  assert.equal(pyStrHash(""), 0n);
  assert.equal(pyStrHash("abcdefghijk"), 1450545860578130900n);
  assert.equal(pyStrHash("Åland"), 7823915343795836024n);
  assert.equal(pyStrHash("日本"), 6243316497235261705n);
  assert.equal(pyStrHash("😀x"), 9520015811591012698n);
});
test("set iteration order", () => {
  assert.deepEqual(pySetOrder(["EU", "EU-VAT", "EU_PREFIX", "INTRASTAT", "SEPA"]), ["SEPA", "EU_PREFIX", "EU-VAT", "INTRASTAT", "EU"]);
  assert.deepEqual(pySetOrder(["", "EU", "EU-VAT", "EU_PREFIX", "INTRASTAT", "SEPA"]), ["", "SEPA", "EU_PREFIX", "EU-VAT", "INTRASTAT", "EU"]);
  assert.deepEqual(pySetOrder(["US", "BE", "SE", "FR"]), ["US", "SE", "BE", "FR"]);
  assert.deepEqual(pySetOrder(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"]), ["d", "f", "g", "h", "k", "b", "i", "c", "a", "j", "e", "l"]);
  assert.deepEqual(pySetOrder(["Åland", "日本", "😀x", "abcdefghijklmnop"]), ["Åland", "日本", "😀x", "abcdefghijklmnop"]);
});
