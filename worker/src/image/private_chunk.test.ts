/**
 * base/static/img/res_company_logo.png (a new company's default logo) carries a private PNG chunk ("orNT"), which
 * Pillow skips (PngImagePlugin.py PngImageFile._open) and the Wasm build now skips too. The checksums are Odoo's
 * (`image_process` in the oracle's Python, and the ir_attachment rows of proofs/scenarios/co_us.py).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createImageProcess } from "./process";

const here = new URL(".", import.meta.url).pathname;
const sha1 = (b: Uint8Array) => createHash("sha1").update(b).digest("hex");

// the Workers types declare WebAssembly.Module abstract; Node constructs it (as src/image/process.test.ts does)
const NodeModule = WebAssembly.Module as unknown as { new(bytes: Uint8Array): WebAssembly.Module };

test("the default company logo resizes byte for byte as Odoo's Pillow", () => {
  const process = createImageProcess(new NodeModule(readFileSync(`${here}odoo-image.wasm`)));
  const logo = new Uint8Array(readFileSync(`${here}../../../odoo/odoo/addons/base/static/img/res_company_logo.png`));
  const i1920 = process(logo, 1920, 1920, { verifyResolution: true });
  assert.equal(sha1(i1920), "b6a3cdaa2cec346455710636e1f000edcff7d706");
  assert.equal(sha1(process(i1920, 512, 512)), "b6a3cdaa2cec346455710636e1f000edcff7d706");
  assert.equal(sha1(process(i1920, 256, 256)), "0ce8c97df3ec768af51696ede284aac75b0eec18");
  assert.equal(sha1(process(i1920, 128, 128)), "60a2a24a2fcfd3b3045bbaa75c5d68815df9d541");
  assert.equal(sha1(process(i1920, 180, 0)), "d1745321b15b979842193a53cbb9eedf8925e18c");
});
