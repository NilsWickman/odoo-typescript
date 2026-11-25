import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";

test("the Session Durable Object cannot pull Odoo or database dependencies into its bundle", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url).href);
  const result = await build({
    absWorkingDir: root, entryPoints: ["src/do/session.ts"], bundle: true,
    write: false, metafile: true, format: "esm", platform: "neutral",
    packages: "external", external: ["*.wasm"], logLevel: "silent",
  });
  for (const file of Object.keys(result.metafile.inputs)) {
    assert.doesNotMatch(file, /^src\/(db\.ts$|orm\/|http\/|controllers\/|qweb\/|views\/)/);
  }
  for (const output of Object.values(result.metafile.outputs)) {
    for (const dependency of output.imports) {
      assert.ok(dependency.path === "cloudflare:workers" || dependency.path.endsWith(".wasm"),
        `Session DO acquired an unexpected external dependency: ${dependency.path}`);
    }
  }
});
