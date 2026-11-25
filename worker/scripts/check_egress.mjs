#!/usr/bin/env node
// Egress guard (npm test): the Worker reaches the outside world only where it is meant to.
//  - a global `fetch(` call (also `globalThis.fetch(` / `self.fetch(`) only in FETCH_ALLOWED;
//  - an import of `cloudflare:sockets` (static, dynamic or a type import) only in SOCKETS_ALLOWED.
// By file, never by line number. Comments are ignored; `.fetch(` (a binding's or object's own fetch, as ASSETS.fetch
// or a Durable Object stub) is not a global fetch; a method named fetch (`async fetch(...) {`) is a definition, not a
// call; demo/pages.ts holds browser-side HTML/JS templates. A file whose own parameter or variable is named `fetch`
// (SHADOWED) calls that, not the global; the guard checks the binding is still there.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");

const FETCH_ALLOWED = new Set(["src/filestore.ts", "src/demo/turnstile.ts"]);
const SOCKETS_ALLOWED = new Set(["src/index.ts", "src/mail/notify.ts"]);
const SKIPPED = new Set(["src/demo/pages.ts"]);
const SHADOWED = new Map([["src/orm/model.ts", /[(,]\s*fetch\s*[:?,)]/]]);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|mts|js|mjs)$/.test(name) && !/\.(test|check)\.(ts|mts|js|mjs)$/.test(name)) yield p;
  }
}

/** The source with comments blanked (strings kept, so a `//` inside a string is not a comment). */
export function stripComments(code) {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const n = code[i + 1];
    if (c === "/" && n === "/") {
      while (i < code.length && code[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      const end = code.indexOf("*/", i + 2);
      const stop = end < 0 ? code.length : end + 2;
      out += code.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      // a quote or apostrophe string ends at its line's end at the latest (so a quote inside a regex literal costs
      // at most the rest of its line)
      while (j < code.length && code[j] !== c && (c === "`" || code[j] !== "\n")) j += code[j] === "\\" ? 2 : 1;
      out += code.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const GLOBAL_FETCH = /(^|[^\w$.])(?:(?:globalThis|self|window)\s*\.\s*)?fetch\s*\(/g;
const METHOD_DEF = /^\s*(?:(?:public|private|protected|static|override|async)\s+)*fetch\s*\([^)]*\)\s*(?::[^={]+)?\{/;
const SOCKETS = /cloudflare:sockets/;

export function findViolations(rel, code) {
  const out = [];
  if (SKIPPED.has(rel)) return out;
  const clean = stripComments(code);
  const lines = clean.split("\n");
  const shadow = SHADOWED.get(rel);
  if (shadow && !shadow.test(clean)) out.push(`${rel}: listed as shadowing fetch, but no local fetch binding is left; remove it from SHADOWED`);
  lines.forEach((line, i) => {
    if (!FETCH_ALLOWED.has(rel) && !shadow) {
      for (const m of line.matchAll(GLOBAL_FETCH)) {
        const prefixWord = /(?:async|override|static|public|private|protected)\s*$/.test(line.slice(0, m.index + m[1].length));
        if (prefixWord || METHOD_DEF.test(line)) continue;
        out.push(`${rel}:${i + 1}: global fetch( outside ${[...FETCH_ALLOWED].join(", ")}`);
      }
    }
    if (!SOCKETS_ALLOWED.has(rel) && SOCKETS.test(line)) out.push(`${rel}:${i + 1}: cloudflare:sockets outside ${[...SOCKETS_ALLOWED].join(", ")}`);
  });
  return out;
}

/** The guard's own fixtures, checked on every run so a regex change cannot silently blind it. */
function selfTest() {
  const flagged = {
    "const r = await fetch(url);": 1,
    "x = globalThis.fetch(u)": 1,
    'const s = "// not a comment"; fetch(y)': 1,
    'import { connect } from "cloudflare:sockets";': 1,
    "const m = await import('cloudflare:sockets');": 1,
    "env.ASSETS.fetch(req); // fetch(x)\n/* fetch( */": 0,
    "  async fetch(request: Request): Promise<Response> {": 0,
    "prefetch(a); searchFetch(b); stub.fetch(c)": 0,
  };
  for (const [code, want] of Object.entries(flagged)) {
    const got = findViolations("src/fixture.ts", code).length;
    if (got !== want) throw new Error(`egress guard self-test: ${JSON.stringify(code)} gave ${got} violation(s), expected ${want}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  selfTest();
  const violations = [];
  let files = 0;
  for (const p of walk(src)) {
    files++;
    violations.push(...findViolations(relative(root, p).split("\\").join("/"), readFileSync(p, "utf8")));
  }
  if (violations.length) {
    console.error(`egress guard: ${violations.length} violation(s)\n  ${violations.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`egress guard: ok (${files} files)`);
}
