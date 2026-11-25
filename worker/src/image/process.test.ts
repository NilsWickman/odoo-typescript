import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createImageProcess } from "./process";

const NodeModule = WebAssembly.Module as unknown as { new(bytes: Uint8Array): WebAssembly.Module };
const process = createImageProcess(new NodeModule(readFileSync(fileURLToPath(new URL("./odoo-image.wasm", import.meta.url).href))));
const files = fileURLToPath(new URL("../../../harness/corpus/runtime/files/", import.meta.url).href);
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

// sha256 of odoo.tools.image.image_process on the Odoo server (worker/image/README.md, `refs.py`)
const REFS: Record<string, Record<string, string>> = {
  "photo.jpg": {
    "1920": "6dec48543c4d8c71bf0fc991caf6a849f77e603241750ed4cbf4df906995e034",
    "1920>1024": "dd294ac0bf20ed7523532f3e24f4c2b5a92c6389d3f419f360a4f8d2e6aa10f5",
    "1920>512": "be647031fda23912de6ea8a691d416f718690396cbb8c29b0839f5429da16525",
    "1920>256": "e2355fb12d345f510237f794d546400a36728be96c7616ac664aaf2076a11ab9",
    "1920>128": "0802cf0040260dc72ab0f5c0ac8aa217505acc77e7b6e4db4fb6f3c636594a9c",
    "1024": "804a1824236ef1601bec7fe8f72788ba7891906ad1c0eb54c68ed1c2fe82ba2a",
    "512": "aebe29682408cab7d6c95155ac67fe86c123caa75df1966d78254f1f09358887",
    "256": "b167b34a6be0f3aeef55bbf99525ed68518925523d3c59c0aac182de0027c112",
    "128": "3b1d8673be95a006abdf0eb93ab314570ccd53b6990e0ffdbd9d976ca8cc2028",
  },
  "logo.png": {
    "1920": "91ca062f484f450a0c0237d8e3719ff1c66d5017780a13417189f7f99bb91953",
    "1920>1024": "91ca062f484f450a0c0237d8e3719ff1c66d5017780a13417189f7f99bb91953",
    "1920>512": "d361dd9c4b1b90c84f7464bae085bc4fd957a0fca6ccc19abe2d3c05fb45e545",
    "1920>256": "9700997a67f2ed7c97a6c6c0544096cf29a1b675597a487f79dcf79089f0dba7",
    "1920>128": "5fd7bb0ccb70221cf609071772385807d5bdf839c1dbaaf7f237146e69fa8c5a",
    "1024": "91ca062f484f450a0c0237d8e3719ff1c66d5017780a13417189f7f99bb91953",
    "512": "d361dd9c4b1b90c84f7464bae085bc4fd957a0fca6ccc19abe2d3c05fb45e545",
    "256": "9700997a67f2ed7c97a6c6c0544096cf29a1b675597a487f79dcf79089f0dba7",
    "128": "5fd7bb0ccb70221cf609071772385807d5bdf839c1dbaaf7f237146e69fa8c5a",
  },
};

test("image_process is byte-identical to Odoo's Pillow for the S6 uploads (every image.mixin size)", () => {
  for (const [name, refs] of Object.entries(REFS)) {
    const src = new Uint8Array(readFileSync(files + name));
    const i1920 = process(src, 1920, 1920);
    for (const [key, ref] of Object.entries(refs)) {
      const [a, b] = key.split(">");
      const out = b ? process(i1920, Number(b), Number(b)) : process(src, Number(a), Number(a));
      assert.equal(sha(out), ref, `${name} ${key}`);
    }
  }
});

test("inputs outside the verified subset refuse", () => {
  assert.throws(() => process(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0]), 128, 128), /NotPorted|not ported/);
});

// Fleet's 67 brand logos (odoo/addons/fleet/static/img/brand_*-image.png, fleet.vehicle.model.brand.image_128,
// max 128x128): 65 RGB and 2 palette PNGs, all within 128 px. Odoo's image_process(size=(128, 128),
// verify_resolution=True), with LOAD_TRUNCATED_IMAGES as the server sets it, returns every one unchanged, raises a
// UserError for brand_ferrari with a broken IHDR CRC, and resizes every logo at 64 (measured 2026-11-15 on the Odoo
// venv: Pillow 10.2.0, worker/image/README.md).
test("Fleet's brand logos: the source unchanged within the size, palette images refuse an operation", () => {
  const dir = fileURLToPath(new URL("../../../odoo/addons/fleet/static/img/", import.meta.url).href);
  const logos = readdirSync(dir).filter((f) => /^brand_.*-image\.png$/.test(f)).sort();
  assert.equal(logos.length, 67);
  let palette = 0;
  for (const f of logos) {
    const src = new Uint8Array(readFileSync(dir + f));
    assert.equal(sha(process(src, 128, 128)), sha(src), f);
    if (src[25] === 3) {
      palette++;
      assert.throws(() => process(src, 64, 64), /not ported/, `${f} at 64`);
    }
  }
  assert.equal(palette, 2);
  const bad = new Uint8Array(readFileSync(dir + "brand_ferrari-image.png"));
  bad[29] = bad[29]! ^ 0xff;
  assert.throws(() => process(bad, 128, 128), /fail to decode/);
});

// Lunch's 29 images (odoo/addons/lunch/static/img/*.png, the categories' and products' image_1920, 128x128): 4 RGBA
// PNGs with tEXt and iTXt, 25 palette PNGs with zTXt and tEXt (Pillow 10.2 chunk_zTXt/chunk_iTXt: info only). Odoo's
// image_process(size=(s, s), verify_resolution=True) with LOAD_TRUNCATED_IMAGES returns each unchanged at 1920 and 128,
// and resizes the RGBA ones at 64 to these (measured 2026-11-15 on the Odoo venv, Pillow 10.2.0).
const LUNCH_RGBA_64: Record<string, string> = {
  "burger.png": "294e9b9045712e72228e210cefb777ed5b19d09ef1aac209ee0cca6c99138bcc",
  "drink.png": "33035f87a9acec1386edcd25a6ffa9b2eec4f4d5a31232149ec8691eaf85dde9",
  "lunch.png": "e300de5b79192cb6ebbbfe3a5b5b1318ce4a54abc8374d9092a8bc19295effac",
  "pizza.png": "f79eecfdb0a3d0a2a25594de0cfbb2dbe74d25f992949481ecff4ebe8a0f3cca"
};
test("Lunch's images: text chunks (zTXt, iTXt) are info only; unchanged within the size, RGBA resized as Pillow", () => {
  const dir = fileURLToPath(new URL("../../../odoo/addons/lunch/static/img/", import.meta.url).href);
  const images = readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
  assert.equal(images.length, 29);
  for (const f of images) {
    const src = new Uint8Array(readFileSync(dir + f));
    assert.equal(sha(process(src, 1920, 1920)), sha(src), f);
    assert.equal(sha(process(src, 128, 128)), sha(src), f);
    if (f in LUNCH_RGBA_64) assert.equal(sha(process(src, 64, 64)), LUNCH_RGBA_64[f], `${f} at 64`);
    else assert.throws(() => process(src, 64, 64), /not ported/, `${f} at 64`);
  }
  // zTXt with a compression method other than 0 (Pillow: SyntaxError) refuses
  const z = new Uint8Array(readFileSync(dir + "club.png"));
  const at = Buffer.from(z).indexOf("zTXt");
  const len = Buffer.from(z).readUInt32BE(at - 4);
  const nul = z.subarray(at + 4, at + 4 + len).indexOf(0);
  z[at + 4 + nul + 1] = 1;
  assert.throws(() => process(z, 128, 128), /not ported/);
});
