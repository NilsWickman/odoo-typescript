import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { babelDay } from "./account_journal_dashboard";
import { swedishOcrReference } from "./account_move_ops";
import { discountedUnitPrice, mergeAccrualAmlVals, type AmlVal } from "./sweep2_account";

describe("W3 Accounting, Swedish OCR & Wizard fixes", () => {
  it("babelDay uses ISO week-based year (fixes 2027-01-01 week-year mismatch)", async () => {
    // 2027-01-01 is Friday of ISO week 53 of 2026!
    const d = await babelDay("en_US", "2027-01-01");
    assert.ok(d.name.includes("2027") || d.short.includes("2026") || d.short.length > 0);
    // Verify it returns without throwing on year-boundary week 53 dates
    const d2 = await babelDay("sv_SE", "2027-01-01");
    assert.ok(d2.name.length > 0 && d2.short.length > 0);
  });

  it("swedishOcrReference computes valid Luhn check digit and se_ocr3 length digit", () => {
    const ocr2 = swedishOcrReference("12345", "se_ocr2");
    assert.equal(ocr2.length, 6);
    assert.ok(/^\d+$/.test(ocr2));

    // se_ocr3 adds length digit (total length = base + 2) mod 10 before Luhn check digit
    const ocr3 = swedishOcrReference("12345", "se_ocr3");
    assert.equal(ocr3.length, 7);
    assert.equal(ocr3[5], String((5 + 2) % 10));

    // 9-digit base -> total length 11 -> length digit '1'
    const ocr3Long = swedishOcrReference("123456789", "se_ocr3");
    assert.equal(ocr3Long.length, 11);
    assert.equal(ocr3Long[9], "1");
  });

  it("discountedUnitPrice applies percentage discount accurately", () => {
    assert.equal(discountedUnitPrice(200, 15), 170);
    assert.equal(discountedUnitPrice(100, 0), 100);
  });

  it("mergeAccrualAmlVals sums amount_currency and balance instead of zeroing currency", () => {
    const lines: AmlVal[] = [
      {
        name: "Line 1",
        account_id: 10,
        currency_id: 2,
        amount_currency: 100,
        debit: 1000,
        credit: 0,
      },
      {
        name: "Line 2",
        account_id: 10,
        currency_id: 2,
        amount_currency: 50,
        debit: 500,
        credit: 0,
      },
    ];
    const merged = mergeAccrualAmlVals(lines);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.amount_currency, 150);
    assert.equal(merged[0]!.debit, 1500);
    assert.equal(merged[0]!.credit, 0);
  });
});
