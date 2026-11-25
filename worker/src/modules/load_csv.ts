/**
 * `convert_csv_import` (odoo/tools/convert.py:725-780) after the context is set: Python's `csv.reader` with
 * quotechar '"' and delimiter ',', translation columns (`field@lang`) and empty lines dropped, then `load()`.
 */
import { load } from "../orm/load";
import type { Environment } from "../orm/types";

/** `csv.reader(io.StringIO(text), quotechar='"', delimiter=',')` (excel dialect, doublequote, no escapechar). */
export function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let inQuotes = false;
  let i = 0;
  const endRow = () => { row.push(cell); rows.push(row); row = []; cell = ""; quoted = false; };
  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      cell += c; i++; continue;
    }
    if (c === '"' && cell === "" && !quoted) { inQuotes = true; quoted = true; i++; continue; }
    if (c === ",") { row.push(cell); cell = ""; quoted = false; i++; continue; }
    if (c === "\r" || c === "\n") {
      endRow();
      if (c === "\r" && text[i + 1] === "\n") i++;
      i++;
      continue;
    }
    cell += c; i++;
  }
  if (cell !== "" || row.length || quoted) endRow();
  return rows;
}

export async function loadRows(env: Environment, model: string, text: string, mode: string, module: string): Promise<void> {
  const [header, ...lines] = readCsv(text);
  if (!header) return;
  if (!(mode === "init" || header.includes("id"))) return; // logged as an error by Odoo, nothing is loaded
  const drop = new Set(header.flatMap((f, i) => (f.includes("@") ? [i] : [])));
  const keep = <T,>(r: T[]): T[] => r.filter((_, i) => !drop.has(i));
  const fields = keep(header);
  if (!fields.length) return;
  const datas = lines.map(keep).filter((r) => r.some((c) => c !== ""));
  const result = await load(env, model, fields, datas);
  if (result.messages.some((m) => m["type"] === "error")) {
    const msg = result.messages.map((m) => String(m["message"])).join("\n");
    throw new Error(`Module loading ${module} failed: file ${String(env.context["install_filename"])} could not be processed:\n${msg}`);
  }
}
