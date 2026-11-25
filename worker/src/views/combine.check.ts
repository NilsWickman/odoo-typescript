/**
 * Compare combinedArch() with Odoo's own `_get_combined_arch()` for every view. Reference produced with the Odoo
 * shell on poc_corpus (see the report): one JSON line {id, arch} per view.
 *   node --experimental-transform-types --import ./src/xml/resolve-hooks.ts src/views/combine.check.ts combined_ref.jsonl [dsn]
 */
import { readFileSync } from "node:fs";
import pg from "pg";
import { combinedArch } from "./combine";

const path = process.argv[2];
if (path === undefined) throw new Error("usage: combine.check.ts <combined_ref.jsonl> [dsn]");
const dsn = process.argv[3] ?? "postgresql://odoo:odoo@127.0.0.1:5433/poc_corpus";
const client = new pg.Client({ connectionString: dsn });
await client.connect();
const cr = { query: client.query.bind(client) };
const groups = new Set<string>();
let same = 0;
let total = 0;
let inherited = 0;
let inheritedSame = 0;
const diffs: string[] = [];
const hasChildren = new Set((await client.query<{ inherit_id: number }>("select distinct inherit_id from ir_ui_view where inherit_id is not null")).rows.map((r) => r.inherit_id));
const withParent = new Set((await client.query<{ id: number }>("select id from ir_ui_view where inherit_id is not null and mode = 'primary'")).rows.map((r) => r.id));
for (const line of readFileSync(path, "utf8").split("\n")) {
  if (line.trim() === "") continue;
  const row = JSON.parse(line) as { id: number; arch?: string; error?: string };
  if (row.arch === undefined) continue;
  total++;
  const interesting = hasChildren.has(row.id) || withParent.has(row.id);
  if (interesting) inherited++;
  try {
    const ours = await combinedArch(cr, row.id, groups);
    if (ours === row.arch) {
      same++;
      if (interesting) inheritedSame++;
    } else {
      let i = 0;
      while (i < ours.length && ours[i] === row.arch[i]) i++;
      diffs.push(`view ${row.id}: differs at ${i}: odoo ${JSON.stringify(row.arch.slice(Math.max(0, i - 60), i + 60))}\n   ours ${JSON.stringify(ours.slice(Math.max(0, i - 60), i + 60))}`);
    }
  } catch (e) {
    diffs.push(`view ${row.id}: ${String(e)}`);
  }
}
console.log(`${same} of ${total} views match Odoo's _get_combined_arch; ${inheritedSame} of ${inherited} views with inheritance (parents of extensions or primary views with a parent)`);
for (const d of diffs.slice(0, 15)) console.log(d);
await client.end();
