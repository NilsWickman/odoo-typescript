import { test } from "node:test";
import assert from "node:assert/strict";
import { luhnCheckDigit, luhnChecksum } from "./luhn";

// the values of python-stdnum 1.x in the oracle's environment (`luhn.calc_check_digit`, `luhn.checksum`)
test("luhn check digits as stdnum", () => {
  assert.equal(luhnCheckDigit("114"), "9"); // INV/2026/00010 of proofs/scenarios/se_inv.py: payment reference 1149
  assert.equal(luhnCheckDigit("7992739871"), "3");
  assert.equal(luhnCheckDigit("0"), "0");
  assert.equal(luhnChecksum("79927398713"), 0);
});
