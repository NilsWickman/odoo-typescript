// node stackmap.mjs <index.js.map> <line:column> [<line:column> ...]: where a position of the deployed, minified bundle
// is in the sources. deploy.sh keeps each deploy's map under results/deploy/<stamp>/ (it is not uploaded), and a stack
// trace from `wrangler tail` names index.js:line:column.
import { readFileSync } from "node:fs";
import { SourceMap } from "node:module";
const [file, ...positions] = process.argv.slice(2);
if (!file || !positions.length) { console.error("usage: node stackmap.mjs <index.js.map> <line:column> ..."); process.exit(2); }
const map = new SourceMap(JSON.parse(readFileSync(file, "utf8")));
for (const p of positions) {
  const [line, column] = p.replace(/^.*?(\d+):(\d+)\)?$/, "$1:$2").split(":").map(Number);
  const e = map.findEntry(line - 1, column - 1);  // the map counts from 0, a stack trace from 1
  console.log(`${p} -> ${e.originalSource ? `${e.originalSource}:${e.originalLine + 1}:${e.originalColumn + 1}${e.name ? ` (${e.name})` : ""}` : "not in the map"}`);
}
