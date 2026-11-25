/**
 * Node resolve hook for the plain `node --experimental-transform-types` test runs (ARCHITECTURE.md "Tests"): the
 * sources use extensionless relative imports (wrangler bundles them; tsconfig forbids `.ts` extensions), which Node's
 * ESM loader cannot resolve by itself. Registers a synchronous hook mapping `./x` to `./x.ts` or `./x/index.ts`.
 *   node --experimental-transform-types --import ./src/xml/resolve-hooks.ts --test "src/<dir>/*.test.ts"
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL !== undefined && context.parentURL.startsWith("file:")) {
      const base = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      if (!/\.[cm]?[jt]s$/.test(specifier) && !/\.json$/.test(specifier)) {
        const candidate = `${base}.ts`;
        if (existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context);
        const index = `${base}/index.ts`;
        if (existsSync(index)) return nextResolve(pathToFileURL(index).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
