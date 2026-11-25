/**
 * Pure helpers of the export controller (`odoo/addons/web/controllers/export.py`): the CSV writer of
 * `CSVExport.from_data` (:546-566, Python's `csv.writer(fp, quoting=1)`), the `Content-Disposition` header of
 * `ExportFormat.base` (:511-516, `odoo/odoo/http/stream.py:34-50 content_disposition` with
 * `odoo/odoo/tools/osutil.py:23-51 clean_filename`), and the cell values of `_export_rows`.
 */
import { pyFloatRepr } from "../http/json";

/** A cell of `_export_rows`: what `convert_to_export` returns (str, int, float, bool) or `''`. */
export type ExportCell = string | number | boolean | { readonly float: number };

/** Python `str(value)` of a cell (csv.writer stringifies non-str fields with `str()`). */
export function pyStr(v: ExportCell): string {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  return pyFloatRepr(v.float);
}

/** `csv.writer(quoting=QUOTE_ALL)` with the default dialect: `"` quotes, doubled inside, `\r\n` terminator. */
export function csvRow(fields: readonly string[]): string {
  return fields.map((f) => `"${f.replace(/"/g, '""')}"`).join(",") + "\r\n";
}

/**
 * export.py:546-566 `from_data`: header row, then each row with None/False as '', bytes decoded, and a `'` before
 * strings starting with `=`, `-` or `+` (spreadsheet formula guard).
 */
export function csvFromData(columnsHeaders: readonly string[], rows: readonly (readonly (ExportCell | null)[])[]): string {
  let out = csvRow(columnsHeaders);
  for (const data of rows) {
    const row: string[] = [];
    for (const d0 of data) {
      let d: ExportCell = d0 === null || d0 === false ? "" : d0;
      if (typeof d === "string" && (d.startsWith("=") || d.startsWith("-") || d.startsWith("+") || d.startsWith("@"))) d = "'" + d;
      row.push(pyStr(d));
    }
    out += csvRow(row);
  }
  return out;
}

const WINDOWS_RESERVED = /^(:?CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(:?\..*)?$/i;

/** osutil.py:23-51 `clean_filename(name)`: `[^\w_.()\[\] -]+` removed (unicode \w), leading `.`/`-` stripped. */
export function cleanFilename(name: string): string {
  if (WINDOWS_RESERVED.test(name)) return "Untitled";
  const cleaned = name.replace(/[^\p{L}\p{N}_.()[\] -]+/gu, "").replace(/^[.-]+/, "");
  return cleaned === "" ? "Untitled" : cleaned;
}

/** werkzeug `url_quote` as Odoo vendors it (odoo/_monkeypatches/werkzeug.py:594-630): bytes outside `safe` as %XX. */
export function urlQuote(s: string, safe: string, unsafe: string): string {
  const always = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
  const allowed = new Set([...safe, ...always].filter((c) => !unsafe.includes(c)).map((c) => c.charCodeAt(0)));
  let out = "";
  for (const byte of new TextEncoder().encode(s)) {
    out += allowed.has(byte) ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** stream.py:34-50 `content_disposition(filename, 'attachment')`. */
export function contentDispositionAttachment(filename: string): string {
  return `attachment; filename*=UTF-8''${urlQuote(filename, "", "()<>@,;:\"/[]?={}\\*'%")}`;
}
