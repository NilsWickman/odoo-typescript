import { test } from "node:test";
import assert from "node:assert/strict";
import { relevantState } from "./stock_states";
import { formatTrackingDatetime } from "../mail/tracking_format";

test("_get_relevant_state_among_moves", () => {
  assert.equal(relevantState([], "direct"), "assigned");
  // a reserved receipt, a partially reserved delivery (direct: partially_available, which _compute_state shows as assigned)
  assert.equal(relevantState([{ state: "assigned", qty: 4 }], "direct"), "assigned");
  assert.equal(relevantState([{ state: "partially_available", qty: 5 }], "direct"), "partially_available");
  assert.equal(relevantState([{ state: "confirmed", qty: 5 }, { state: "assigned", qty: 1 }], "direct"), "partially_available");
  assert.equal(relevantState([{ state: "confirmed", qty: 5 }, { state: "assigned", qty: 1 }], "one"), "confirmed");
  assert.equal(relevantState([{ state: "confirmed", qty: 5 }], "direct"), "confirmed");
  assert.equal(relevantState([{ state: "done", qty: 5 }, { state: "cancel", qty: 1 }], "direct"), "assigned");
});

test("_format_tracking_datetime in en_US", async () => {
  // measured on the oracle: date_done 22:09 UTC in Europe/Brussels (winter time)
  assert.equal(await formatTrackingDatetime("2026-11-04 22:09:13", "Europe/Brussels"), "Nov 4, 2026, 11:09 PM (GMT+01:00)");
  assert.equal(await formatTrackingDatetime("2026-07-01 00:30:00", "Europe/Brussels"), "Jul 1, 2026, 2:30 AM (GMT+02:00)");
  assert.equal(await formatTrackingDatetime("2026-07-01 12:00:00", "UTC"), "Jul 1, 2026, 12:00 PM (GMT+00:00)");
  assert.equal(await formatTrackingDatetime("2026-01-15 03:05:00", "America/New_York"), "Jan 14, 2026, 10:05 PM (GMT-05:00)");
});
