/**
 * The xlsx body of `/web/export/xlsx` (odoo/addons/web/controllers/export.py:167-247 ExportXlsxWriter, :600-606
 * from_data): one worksheet "Sheet1", a bold header row, then one row per exported line, written as xlsxwriter
 * writes them (numbers with `%.16G`, booleans as boolean cells, strings inline, dates/datetimes as serial numbers
 * with the `yyyy-mm-dd` / `yyyy-mm-dd hh:mm:ss` formats, empty values as blank cells with the base style).
 * The harness compares xlsx answers by their sheets' cell text (NORMALIZATION.md N16), not by bytes: this writer
 * produces the same cells, in a minimal package (stored zip entries, no compression).
 */
import { NotPorted } from "../errors";
import type { ExportCell } from "./export_csv";

/** xlsxwriter worksheet.py xls_strmax. */
export const XLS_STRMAX = 32767;

export type XlsxCell = ExportCell | null;
/** A line of cells, or a group title of `GroupExportXlsxWriter._write_group_header` (export.py:271-287). */
export type XlsxRow = readonly XlsxCell[] | { readonly groupHeader: readonly XlsxCell[] };

const enc = new TextEncoder();

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function colName(i: number): string {
  let n = i + 1, s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** Python `"%.16G" % number` (xlsxwriter worksheet.py _write_number). */
function numberText(n: number): string {
  if (!Number.isFinite(n)) throw new NotPorted(`xlsx export of a non-finite number ${n}`);
  if (n === 0) return "0";
  const exp = Math.floor(Math.log10(Math.abs(n)));
  if (exp < -5 || exp >= 16) {
    // %G switches to the exponent form: mantissa without trailing zeros, two-digit exponent at least
    const [m, e] = n.toExponential(15).split("e");
    const mant = (m ?? "").replace(/\.?0+$/, "");
    const ev = Number(e);
    return `${mant}E${ev < 0 ? "-" : "+"}${String(Math.abs(ev)).padStart(2, "0")}`;
  }
  return String(Number(n.toPrecision(16)));
}

/** Excel serial date (1900 system) of a "YYYY-MM-DD[ HH:MM:SS]" naive value (xlsxwriter utility _datetime_to_excel_datetime). */
function excelSerial(v: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/.exec(v);
  if (!m) throw new NotPorted(`xlsx export of the date value ${JSON.stringify(v)}`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  const days = ms / 86_400_000 + 25569; // 1970-01-01 is serial 25569 (dates after 1900-03-01)
  return days;
}

// style indexes of styles.xml below
const S_HEADER = 1, S_BASE = 2, S_DATE = 3, S_DATETIME = 4, S_FLOAT = 5, S_MONETARY = 6, S_GROUP = 7, S_GROUP_FLOAT = 8, S_GROUP_MONETARY = 9;

function stylesXml(monetaryDecimals: number): string {
  const money = `#,##0.${"0".repeat(monetaryDecimals)}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="4"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm:ss"/><numFmt numFmtId="166" formatCode="#,##0.00"/><numFmt numFmtId="167" formatCode="${xmlEscape(money)}"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE9ECEF"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="10"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment wrapText="1"/></xf><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment wrapText="1"/></xf><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment wrapText="1"/></xf><xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1"/></xf><xf numFmtId="166" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1"/></xf><xf numFmtId="167" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1"/></xf></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

/**
 * The worksheet cells: `fieldTypes[i]` is the type of column i (the export dialog's `fields[i].type`), which decides
 * the date/datetime/float/monetary styles as `write_cell` does from the Python value type.
 */
export function buildXlsx(headers: readonly string[], rows: readonly XlsxRow[], fieldTypes: readonly string[],
  monetaryDecimals: number, tooLong: string): Uint8Array {
  const out: string[] = [];
  let maxCol = headers.length - 1;
  const cell = (r: number, c: number, v: XlsxCell, type: string | null): string => {
    const ref = `${colName(c)}${r + 1}`;
    if (type === null) { // header: worksheet.write(..., header_style)
      if (typeof v !== "string") throw new NotPorted("non-string xlsx header");
      return v === "" ? `<c r="${ref}" s="${S_HEADER}"/>` : `<c r="${ref}" s="${S_HEADER}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
    }
    if (v === null || v === "") return `<c r="${ref}" s="${S_BASE}"/>`; // write_blank with the base style
    if (typeof v === "boolean") return `<c r="${ref}" s="${S_BASE}" t="b"><v>${v ? 1 : 0}</v></c>`;
    if (typeof v === "string") {
      if (type === "date") return `<c r="${ref}" s="${S_DATE}"><v>${numberText(excelSerial(v))}</v></c>`;
      if (type === "datetime") return `<c r="${ref}" s="${S_DATETIME}"><v>${numberText(excelSerial(v))}</v></c>`;
      const s = v.length > XLS_STRMAX ? tooLong : v.replace(/\r/g, " ");
      return `<c r="${ref}" s="${S_BASE}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(s)}</t></is></c>`;
    }
    if (typeof v === "number") return `<c r="${ref}" s="${S_BASE}"><v>${numberText(v)}</v></c>`; // ints keep the base style
    // a Python float: float or monetary style (export.py:242-244)
    return `<c r="${ref}" s="${type === "monetary" ? S_MONETARY : S_FLOAT}"><v>${numberText(v.float)}</v></c>`;
  };
  /** export.py:280-286: a group title takes the bold style of its field type, without the styles of `write_cell`. */
  const groupCell = (r: number, c: number, v: XlsxCell): string => {
    const ref = `${colName(c)}${r + 1}`;
    const type = c === 0 ? "char" : fieldTypes[c];
    const style = type === "monetary" ? S_GROUP_MONETARY : type === "float" ? S_GROUP_FLOAT : S_GROUP;
    if (v === null || v === "") return `<c r="${ref}" s="${style}"/>`;
    if (typeof v === "string") return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
    if (typeof v === "number") return `<c r="${ref}" s="${style}"><v>${numberText(v)}</v></c>`;
    throw new NotPorted("xlsx group title cell of an unknown type");
  };
  out.push(`<row r="1">${headers.map((h, i) => cell(0, i, h, null)).join("")}</row>`);
  rows.forEach((row, ri) => {
    if ("groupHeader" in row) {
      maxCol = Math.max(maxCol, row.groupHeader.length - 1);
      out.push(`<row r="${ri + 2}">${row.groupHeader.map((v, ci) => groupCell(ri + 1, ci, v)).join("")}</row>`);
      return;
    }
    maxCol = Math.max(maxCol, row.length - 1);
    out.push(`<row r="${ri + 2}">${row.map((v, ci) => cell(ri + 1, ci, v, fieldTypes[ci] ?? "char")).join("")}</row>`);
  });
  const dim = `A1:${colName(Math.max(0, maxCol))}${rows.length + 1}`;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="${dim}"/><cols><col min="1" max="${Math.max(1, headers.length)}" width="30.7109375" customWidth="1"/></cols><sheetData>${out.join("")}</sheetData></worksheet>`;
  const files: [string, string][] = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", stylesXml(monetaryDecimals)],
    ["xl/worksheets/sheet1.xml", sheet],
  ];
  return zipStored(files.map(([n, s]) => [n, enc.encode(s)]));
}

// ------------------------------------------------------------------------------------------------ zip (stored)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStored(entries: readonly [string, Uint8Array][]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, 0, true); lv.setUint16(12, 0x21, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, nameBytes.length, true); lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true); cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cen.set(nameBytes, 46);
    parts.push(local, data);
    central.push(cen);
    offset += local.length + data.length;
  }
  const cenSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cenSize, true); ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}
