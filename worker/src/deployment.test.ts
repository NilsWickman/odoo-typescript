import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("the read-only experiment has no billable R2 binding", () => {
  // Wrangler validates JSONC in the build gate; these checks protect the cost-sensitive settings.
  const config = readFileSync(fileURLToPath(new URL("../wrangler.jsonc", import.meta.url).href), "utf8");
  assert.doesNotMatch(config, /"r2_buckets"\s*:/,
    "R2's free allowance can incur overage charges; use the packaged Static Assets filestore");
  assert.match(config, /"new_sqlite_classes"\s*:\s*\["SessionStore",\s*"BusDispatcher"\]/,
    "Workers Free requires SQLite-backed Durable Objects");
});
