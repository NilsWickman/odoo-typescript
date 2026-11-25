import { test } from "node:test";
import assert from "node:assert/strict";
import { lineLogBody } from "./account_integrity";
import { trackingBody } from "../mail/tracking";
import type { Environment } from "../orm/types";

test("Journal Item updated: Odoo's body of a label change on a posted invoice (account_move_line.py:2272)", () => {
  // the stored body Odoo 20 wrote for INV/2026/00001 line 23 (dev_fix_p5b_o, 2026-11-04)
  const env = { lang: "en_US" } as unknown as Environment;
  const body = `<p>${lineLogBody(env, 23, "updated")}</p>` + trackingBody([{ name: "name", sequence: 100, label: "Description", old: "Big table seats 10–12 for team discussions", new: "new label" }]);
  assert.equal(body, '<p>Journal Item <a href="#" data-oe-model="account.move.line" data-oe-id="23">#23</a> updated</p><div>Big table seats 10–12 for team discussions → <b>new label</b> <i>(Description)</i>\n</div>');
});

test("Journal Item updated refuses outside en_US without a translation table", () => {
  assert.throws(() => lineLogBody({ lang: "sv_SE" } as unknown as Environment, 1, "updated"), /not ported/);
});
