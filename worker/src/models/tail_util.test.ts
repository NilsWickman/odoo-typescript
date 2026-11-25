import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPosix } from "./tail_util";
import { avatarInitials } from "./discuss_computes";
import { htmlHistoryMetadata } from "./project_computes";

const w = { y: 2026, mo: 10, d: 27, h: 18, mi: 35, s: 39 };

test("format_datetime medium with the en_US and fr_FR res.lang formats", () => {
  // the corpus answer for discuss.call.history name_search: "Demo Call Channel - 10/27/2026 06:35:39 PM"
  assert.equal(formatPosix("%m/%d/%Y %I:%M:%S %p", w, "en_US"), "10/27/2026 06:35:39 PM");
  assert.equal(formatPosix("%d/%m/%Y %H:%M:%S", w, "fr_FR"), "27/10/2026 18:35:39");
  assert.equal(formatPosix("%I %p", { ...w, h: 0 }, "en_US"), "12 AM");
  assert.throws(() => formatPosix("%b", w, "en_US"), /directive/);
});

test("avatar_initials", () => {
  assert.equal(avatarInitials("Demo Call Channel"), "DC");
  assert.equal(avatarInitials("general"), "G");
  assert.equal(avatarInitials("  "), "");
});

test("html field history metadata drops the patches", () => {
  assert.equal(htmlHistoryMetadata(null), null);
  assert.equal(htmlHistoryMetadata({}), null);
  assert.deepEqual(htmlHistoryMetadata({ description: [{ patch: "x", revision_id: 1 }] }), { description: [{ revision_id: 1 }] });
});
