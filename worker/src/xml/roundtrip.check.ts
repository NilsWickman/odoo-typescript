/**
 * Round-trip check against the oracle's serialization: every line of the input is `{"id": .., "arch": ..}` with
 * `arch` as stored in `ir_ui_view.arch_db->>'en_US'` (which is lxml's own `tostring` output). Prints the count of
 * archs that parse+serialize to the identical text and the first differences.
 *   docker exec odoo-port-pg psql -U odoo -d poc_corpus -At \
 *     -c "select json_build_object('id',id,'arch',arch_db->>'en_US') from ir_ui_view order by id" > archs.jsonl
 *   node --experimental-transform-types src/xml/roundtrip.check.ts archs.jsonl
 */
import { readFileSync } from "node:fs";
import { parseXml } from "./parse";
import { serializeXml } from "./serialize";

const path = process.argv[2];
if (path === undefined) throw new Error("usage: roundtrip.check.ts <archs.jsonl>");
let same = 0;
let total = 0;
const diffs: string[] = [];
for (const line of readFileSync(path, "utf8").split("\n")) {
  if (line.trim() === "") continue;
  const row = JSON.parse(line) as { id: number; arch: string | null };
  if (row.arch === null) continue;
  total++;
  let out: string;
  try {
    out = serializeXml(parseXml(row.arch));
  } catch (e) {
    diffs.push(`view ${row.id}: ${String(e)}`);
    continue;
  }
  if (out === row.arch) same++;
  else {
    let i = 0;
    while (i < out.length && out[i] === row.arch[i]) i++;
    diffs.push(`view ${row.id}: differs at ${i}: stored ${JSON.stringify(row.arch.slice(Math.max(0, i - 30), i + 40))} ours ${JSON.stringify(out.slice(Math.max(0, i - 30), i + 40))}`);
  }
}
console.log(`${same} of ${total} archs round-trip identically`);
for (const d of diffs.slice(0, 20)) console.log(d);
