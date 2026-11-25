import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Exercise the actual shell launcher, replacing only the external servers. A harness-supplied {db}
// used to acquire an extra closing brace; the default DSN path hid that bug in direct dev runs.
test("start.sh preserves the harness DSN placeholder in Wrangler's arguments", () => {
  const dir = mkdtempSync(join(tmpdir(), "odoo-start-test-"));
  writeFileSync(join(dir, "python3"), '#!/bin/sh\nif [ "$1" = "-c" ]; then echo 18099; fi\n', { mode: 0o700 });
  writeFileSync(join(dir, "npx"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
  const dsn = "postgresql://track_rw:track_rw@127.0.0.1:5433/{db}";
  for (const supplied of [true, false]) {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}:${process.env["PATH"]}` };
    env["ODOO_FILESTORE_MODE"] = "assets";
    delete env["ODOO_PG_DSN_TEMPLATE"];
    delete env["ODOO_TS_PG_PORT"]; // the default DSN below is odoo-port-pg's (start.sh reads the variable for the server in RAM)
    if (supplied) env["ODOO_PG_DSN_TEMPLATE"] = dsn;
    const run = spawnSync("bash", [fileURLToPath(new URL("../../start.sh", import.meta.url).href)], { env, encoding: "utf8", timeout: 30000 });  // 5 s was passed under load 14 (5.0 s, 2026-11-11); the test is about the arguments, not the time
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.split("\n").includes(`PG_DSN_TEMPLATE:${dsn}`), run.stdout);
    assert.ok(!run.stdout.includes("FILESTORE_URL:"), "S1 must exercise the deployed Static Assets backend");
  }
});
