import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

async function exists(url) {
  try {
    await access(fileURLToPath(url));
    return true;
  } catch {
    return false;
  }
}

export async function resolve(specifier, context, next) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z]+$/.test(specifier) && context.parentURL) {
    const base = new URL(specifier, context.parentURL);
    // esbuild (the Workers bundler) also finds a plain `.js` module (src/models/account_tax_engine.js, typed by its
    // .d.ts): without it every module that reaches one failed to load in Node (compiler/checks.sh since cron-keys)
    for (const suffix of [".ts", ".js", "/index.ts"]) {
      const candidate = new URL(base.href + suffix);
      if (await exists(candidate)) return next(candidate.href, context);
    }
  }
  return next(specifier, context);
}

// Workers import `.wasm` files as precompiled WebAssembly.Module default exports (wrangler CompiledWasm rule);
// the tests get the same shape.
export async function load(url, context, next) {
  // Workers import a models.pack as an ArrayBuffer default export (wrangler.jsonc's Data rule, src/gen_models.ts)
  if (url.endsWith(".pack")) {
    return {
      format: "module",
      shortCircuit: true,
      source: `import { readFileSync } from "node:fs"; const b = readFileSync(new URL(${JSON.stringify(url)})); export default b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);`,
    };
  }
  if (url.endsWith(".json")) {
    return {
      format: "module",
      shortCircuit: true,
      source: `import { readFileSync } from "node:fs"; export default JSON.parse(readFileSync(new URL(${JSON.stringify(url)}), "utf8"));`,
    };
  }
  if (url.endsWith(".wasm")) {
    return {
      format: "module",
      shortCircuit: true,
      source: `import { readFileSync } from "node:fs"; export default new WebAssembly.Module(readFileSync(new URL(${JSON.stringify(url)})));`,
    };
  }
  return next(url, context);
}
