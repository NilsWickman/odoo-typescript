/**
 * Write-side Python defaults of the CRM configuration models (C3): crm.tag (sales_team/models/crm_tag.py:11-16,
 * `_get_default_color` = randint(1, 11), harness N9 masks it) and crm.lost.reason (crm/models/crm_lost_reason.py:13
 * active=True). Neither overrides create/write or has onchange methods.
 */
import { registerDefaults } from "../orm/recompute";

/** Python `random.randint(1, 11)` (inclusive bounds). */
function randint(lo: number, hi: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return lo + ((buf[0] ?? 0) % (hi - lo + 1));
}

registerDefaults("crm.tag", {
  color: async () => randint(1, 11), // crm_tag.py:11-16
});

registerDefaults("crm.lost.reason", {
  active: async () => true, // crm_lost_reason.py:13
});
