import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { setGenAssets } from "../gen_assets";
import { genModelsFile } from "../gen_models";
import { withOverlay } from "./overlay";
import { templateKey, type TemplateInfo } from "./template";

/**
 * VAGB B0: while fleet's data loads in the install of fleet and account_fleet, the registry is the one after fleet
 * (gen/out/poc_erp_fleet/install_steps.json, written by gen/install_capture.py from Odoo's registry at that step):
 * account_fleet's `amount` (computed, with an inverse) is fleet's plain Monetary field there.
 */
const gen = (path: string): string => fileURLToPath(new URL(`../../gen/out/${path}`, import.meta.url).href);
const fetcher = {
  fetch: async (req: Request): Promise<Response> => {
    const path = gen(new URL(req.url).pathname.replace(/^\/__gen\//, ""));
    return existsSync(path) ? new Response(readFileSync(path, "utf8")) : new Response("", { status: 404 });
  },
} as unknown as Fetcher;
setGenAssets(fetcher);

const FLEET: TemplateInfo = { name: "poc_erp_fleet", dir: "poc_erp", overlay: "poc_erp_fleet" };
type Models = { models: Readonly<Record<string, { fields: Record<string, { compute: boolean; inverse: boolean; store: boolean }> } | undefined>> };

async function models(t: TemplateInfo): Promise<Models["models"]> {
  const base = { models: (await genModelsFile("poc_erp")).models } as Models;
  return (await withOverlay(t, "models.json", base, "models")).models;
}

test("the step's registry: fleet's amount before account_fleet loads, the final one after", async () => {
  const final = (await models(FLEET))["fleet.vehicle.log.services"]!.fields["amount"]!;
  assert.equal(final.compute, true);
  assert.equal(final.inverse, true);
  const step = (await models({ ...FLEET, step: "fleet" }))["fleet.vehicle.log.services"]!.fields;
  assert.equal(step["amount"]!.compute, false);
  assert.equal(step["amount"]!.inverse, false);
  assert.equal(step["amount"]!.store, true);
  // account_fleet's own fields are not in the step's registry
  assert.equal(step["account_move_line_id"], undefined);
  // a model fleet does not touch is the base's at the step
  const base = (await genModelsFile("poc_erp")).models["account.account"];
  assert.deepEqual((await models({ ...FLEET, step: "fleet" }))["account.account"], base);
});

test("a step's top-level file (write_defaults.json) and its cache key", async () => {
  const base = JSON.parse(readFileSync(gen("poc_erp/write_defaults.json"), "utf8")) as Record<string, unknown>;
  const final = await withOverlay(FLEET, "write_defaults.json", base, null);
  const step = await withOverlay({ ...FLEET, step: "fleet" }, "write_defaults.json", base, null);
  assert.ok("fleet.vehicle.log.services" in final);
  assert.ok("fleet.vehicle.log.services" in step);
  assert.notEqual(templateKey({ ...FLEET, step: "fleet" }), templateKey(FLEET));
});

test("a step the capture did not record refuses", async () => {
  await assert.rejects(models({ ...FLEET, step: "account_fleet" }), /not in its install_steps.json/);
});
