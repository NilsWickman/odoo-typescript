import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { genModelsFile, isLazyRecord, packedModels } from "./gen_models";

/**
 * The Worker bundles the model metadata as models.pack (gen/models_pack.py), not the models.json beside it that the
 * generators, the compiler and the other tests read. The two must say the same: every model of the JSON comes out of
 * the pack equal, in the same order. A models.json written without its pack fails here: python3 gen/models_pack.py.
 */
const file = (path: string): string => fileURLToPath(new URL(path, import.meta.url).href);

for (const dir of ["../gen/out", "../gen/out/poc_erp"]) {
  test(`${dir}/models.pack holds every model of models.json`, () => {
    const text = readFileSync(file(`${dir}/models.json`), "utf8");
    const whole = (JSON.parse(text) as { models: Record<string, unknown> }).models;
    const pack = readFileSync(file(`${dir}/models.pack`));
    const lazy = packedModels(pack);
    assert.ok(isLazyRecord(lazy));
    assert.deepEqual(Object.keys(lazy), Object.keys(whole), "the pack is not of this models.json: python3 gen/models_pack.py");
    for (const name of Object.keys(whole)) assert.deepEqual(lazy[name], whole[name], `${name}: the pack is not of this models.json: python3 gen/models_pack.py`);
    assert.equal(lazy["no.such.model"], undefined);
    assert.ok(pack.length < 0.1 * text.length, `the pack is ${pack.length} bytes of ${text.length}`);
  });
}

test("a pack that is cut short or is something else is refused", () => {
  const pack = readFileSync(file("../gen/out/models.pack"));
  assert.throws(() => packedModels(pack.subarray(0, pack.length - 1)), /bytes, the head line says/);
  assert.throws(() => packedModels(new TextEncoder().encode('{"models":{}}\n')), /not a models.pack\/1 file/);
  assert.throws(() => packedModels(new TextEncoder().encode("no newline")), /no head line/);
});

test("the modules the Worker imports are the packs", async () => {
  for (const dir of ["", "poc_erp"] as const) {
    const { models } = await genModelsFile(dir);
    assert.ok(isLazyRecord(models));
    assert.equal(typeof (models["res.partner"] as { fields?: unknown }).fields, "object");
  }
});
