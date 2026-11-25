// Keeps the Worker's bundle Latin-1 (postinstall). V8 stores a script's source with two bytes per character when it
// holds a single character above U+00FF, and the bundle is about 49 MB: one em dash in a comment of pg-protocol
// (dist/buffer-writer.js) doubled the isolate's script memory to about 98 MB against the 128 MB isolate limit
// (docs/perf-2026-11-07.md, perf-2). Only comments of the listed packages are rewritten, and only those characters.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const PACKAGES = ["pg-protocol/dist"];
const REPL = { "—": "--", "–": "-", "‘": "'", "’": "'", "“": '"', "”": '"', "…": "..." };
let changed = 0;
for (const dir of PACKAGES.map((p) => join(import.meta.dirname, "..", "node_modules", p))) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".js") && !n.endsWith(".test.js"))) {
    const path = join(dir, f);
    const src = readFileSync(path, "utf8");
    // line comments only: the characters seen are in `// ...` comments; code and strings are left alone
    const out = src.replace(/\/\/[^\n]*/g, (c) => c.replace(/[^\x00-\xff]/g, (ch) => REPL[ch] ?? "?"));
    if (out !== src) { writeFileSync(path, out); changed++; }
  }
}
if (changed) console.log(`latin1-deps: rewrote comments in ${changed} file(s)`);
