import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groupConsecutiveBy, parsePortalPage, safeLocalRedirect, sorting } from "../controllers/portal_home";
import { computeNextPaymentValues } from "../controllers/portal_invoice";
import { formatLocalizedUrl } from "../controllers/page";

describe("W4 ERP & Customer Portal fixes", () => {
  it("portal sorting falls back to first entry on unknown keys", () => {
    const map = { date: { order: "date desc" }, name: { order: "name asc" } };
    assert.deepEqual(sorting(map, "name"), { order: "name asc" });
    assert.deepEqual(sorting(map, "unknown_key"), { order: "date desc" });
    assert.deepEqual(sorting(map, "__proto__"), { order: "date desc" });
  });

  it("parsePortalPage handles query strings, numbers, and invalid values", () => {
    assert.equal(parsePortalPage(3), 3);
    assert.equal(parsePortalPage("4"), 4);
    assert.equal(parsePortalPage("0"), 1);
    assert.equal(parsePortalPage("-2"), 1);
    assert.equal(parsePortalPage("abc"), 1);
    assert.equal(parsePortalPage(null), 1);
  });

  it("groupConsecutiveBy groups adjacent matching items preserving order", () => {
    const items = [
      { id: 1, g: "a" },
      { id: 2, g: "a" },
      { id: 3, g: "b" },
      { id: 4, g: "a" },
    ];
    const groups = groupConsecutiveBy(items, (x) => x.g);
    assert.deepEqual(groups.map((g) => g.map((x) => x.id)), [[1, 2], [3], [4]]);
  });

  it("safeLocalRedirect blocks open redirects", () => {
    assert.equal(safeLocalRedirect("/my/orders"), "/my/orders");
    assert.equal(safeLocalRedirect("https://evil.com"), "/my");
    assert.equal(safeLocalRedirect("//evil.com"), "/my");
    assert.equal(safeLocalRedirect("/\\evil.com"), "/my");
    assert.equal(safeLocalRedirect("/my\r\nX: y"), "/my");
  });

  it("computeNextPaymentValues supports single line, EPD, and multi-installments", () => {
    // Early Payment Discount active
    const epd = computeNextPaymentValues({
      lines: [{
        id: 1, date_maturity: "2026-12-30", amount_residual_currency: 1000, amount_currency: 1000,
        reconciled: false, discount_date: "2026-12-10", discount_amount_currency: 980,
      }],
      paymentState: "not_paid", total: 1000, residual: 1000, dueDate: "2026-12-30", reference: "INV/1",
      today: "2026-12-01", unreconciledPaidAmount: 0, rounding: 0.01,
    });
    assert.equal(epd["installment_state"], "epd");
    assert.equal(epd["next_due_date"], "2026-12-10");

    // Multi-installment with one overdue
    const inst = computeNextPaymentValues({
      lines: [
        { id: 1, date_maturity: "2026-11-01", amount_residual_currency: 300, amount_currency: 300, reconciled: false, discount_date: null, discount_amount_currency: null },
        { id: 2, date_maturity: "2026-12-01", amount_residual_currency: 700, amount_currency: 700, reconciled: false, discount_date: null, discount_amount_currency: null },
      ],
      paymentState: "not_paid", total: 1000, residual: 1000, dueDate: "2026-12-01", reference: "INV/2",
      today: "2026-11-15", unreconciledPaidAmount: 0, rounding: 0.01,
    });
    assert.equal(inst["installment_state"], "overdue");
    assert.equal(inst["next_due_date"], "2026-11-01");
    assert.equal(inst["is_last_installment"], false);
  });

  it("formatLocalizedUrl omits prefix instead of emitting /undefined/ for unknown lang", () => {
    const langs = new Map<string, Record<string, unknown>>([
      ["sv_SE", { url_code: "sv" }],
    ]);
    assert.equal(formatLocalizedUrl(langs, "sv_SE", "/my/orders", "?page=2"), "/sv/my/orders?page=2");
    assert.equal(formatLocalizedUrl(langs, "xx_YY", "/my/orders", "?page=2"), "/my/orders?page=2");
  });
});
