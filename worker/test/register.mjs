// Test runner support: `node --experimental-strip-types` cannot resolve extensionless relative imports, and the
// Workers bundler (esbuild) resolves them fine, so the sources stay extensionless and this hook adds `.ts`.
import { register } from "node:module";
register("./resolve.mjs", import.meta.url);
