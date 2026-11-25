import { test } from "node:test";
import assert from "node:assert/strict";
import { truncate } from "./labels";

const at = (year: number, month: number, day: number, hour = 0) => ({ year, month, day, hour, minute: 0, second: 0 });

// Postgres on the oracle's database: date_trunc('week', d::timestamp - INTERVAL '-1 DAY') + INTERVAL '-1 DAY'
// (fields_temporal.py:100-108, en_US: week_start 7, so days_offset 1) gives the Sunday on or before the date
test("week start on Sunday (en_US) as fields_temporal.py", () => {
  assert.deepEqual(truncate(at(2026, 9, 16), "week", 1), at(2026, 9, 13)); // Wednesday -> Sunday 13
  assert.deepEqual(truncate(at(2026, 9, 13), "week", 1), at(2026, 9, 13)); // Sunday stays
  assert.deepEqual(truncate(at(2026, 9, 19, 23), "week", 1), at(2026, 9, 13)); // Saturday evening
  assert.deepEqual(truncate(at(2026, 9, 20), "week", 1), at(2026, 9, 20)); // the next Sunday
  assert.deepEqual(truncate(at(2026, 1, 1), "week", 1), at(2025, 12, 28)); // over the year
});

test("week start on Monday (fr_FR, sv_SE): no offset", () => {
  assert.deepEqual(truncate(at(2026, 9, 16), "week", 0), at(2026, 9, 14));
  assert.deepEqual(truncate(at(2026, 9, 13), "week", 0), at(2026, 9, 7));
  assert.deepEqual(truncate(at(2026, 9, 14), "week", 0), at(2026, 9, 14));
});

// week_start 6 (Saturday): first_week_day 5, days_offset 2
test("week start on Saturday", () => {
  assert.deepEqual(truncate(at(2026, 9, 16), "week", 2), at(2026, 9, 12));
  assert.deepEqual(truncate(at(2026, 9, 12), "week", 2), at(2026, 9, 12));
  assert.deepEqual(truncate(at(2026, 9, 11), "week", 2), at(2026, 9, 5));
});
