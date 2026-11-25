import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { OVERRIDE_STATUS } from "./override_status";

// Every entry of the guard's table (src/orm/override_status.ts) names an override that exists in a template
// (gen/write_overrides.py), with a source and a decision; a stale entry would document a port of nothing.
const GEN = fileURLToPath(new URL("../../gen/out/", import.meta.url).href);
type Gen = { classes: Record<string, Record<string, unknown>> };
const gens: Gen[] = ["write_overrides.json", "poc_erp/write_overrides.json"].map((p) => JSON.parse(readFileSync(GEN + p, "utf8")) as Gen);

test("every override status names an override of a template, with a decision", () => {
  const bad: string[] = [];
  for (const [key, st] of Object.entries(OVERRIDE_STATUS)) {
    const [method, cls] = key.split(" ") as [string, string];
    let found = false;
    for (const g of gens) {
      if (method === "ondelete") {
        const dot = cls.lastIndexOf(".");
        const ondelete = g.classes[`odoo.addons.${cls.slice(0, dot)}`]?.["ondelete"] as Record<string, unknown> | undefined;
        found ||= Boolean(ondelete?.[cls.slice(dot + 1)]);
      } else found ||= method in (g.classes[`odoo.addons.${cls}`] ?? {});
    }
    if (!found) bad.push(`${key}: no such override in gen/out[/poc_erp]/write_overrides.json`);
    if (!(st.ported || st.when || st.acts)) bad.push(`${key}: neither ported nor a condition`);
    if (!st.src) bad.push(`${key}: no source`);
    // `reads` gives `acts` the created record's defaults (override_guard.ts withDefaults): only a create's condition has them
    if (st.reads && (method !== "create" || !st.acts)) bad.push(`${key}: reads without a create condition`);
  }
  assert.deepEqual(bad, []);
});
