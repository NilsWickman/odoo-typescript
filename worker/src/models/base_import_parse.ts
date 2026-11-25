/**
 * Pure parts of `base_import.import` (odoo/addons/base_import/models/base_import.py): the CSV reader of `_read_csv`
 * (:609-674, Python's `csv.reader` with the excel dialect and the given quotechar/delimiter), the separator
 * sniffing, chardet's answer for the encodings this port recognises, the header type heuristics of
 * `_extract_header_types` (:677-767) with `check_patterns`/`to_re` (:1850-1890), and difflib's
 * `SequenceMatcher.ratio` used by `_get_distance` (:984-991).
 */
import { NotPorted } from "../errors";

/** Python `csv.reader(io.StringIO(text), quotechar=q, delimiter=d)` (excel dialect: doublequote, not strict). */
export function csvRead(text: string, delimiter: string, quotechar: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  // states of Modules/_csv.c: START_RECORD, START_FIELD, IN_FIELD, IN_QUOTED_FIELD, QUOTE_IN_QUOTED_FIELD
  let state: "start_record" | "start_field" | "in_field" | "in_quoted" | "quote_in_quoted" = "start_record";
  const endField = (): void => { row.push(field); field = ""; };
  const endRecord = (): void => { rows.push(row); row = []; };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const eol = c === "\n" || c === "\r";
    switch (state) {
      case "start_record":
        if (eol) {
          // an empty line is an empty row
          if (c === "\r" && text[i + 1] === "\n") i++;
          rows.push([]);
          i++;
          continue;
        }
        state = "start_field";
        continue;
      case "start_field":
        if (eol) { endField(); endRecord(); state = "start_record"; if (c === "\r" && text[i + 1] === "\n") i++; }
        else if (c === quotechar) state = "in_quoted";
        else if (c === delimiter) endField();
        else { field += c; state = "in_field"; }
        break;
      case "in_field":
        if (eol) { endField(); endRecord(); state = "start_record"; if (c === "\r" && text[i + 1] === "\n") i++; }
        else if (c === delimiter) { endField(); state = "start_field"; }
        else field += c;
        break;
      case "in_quoted":
        if (c === quotechar) state = "quote_in_quoted";
        else field += c;
        break;
      case "quote_in_quoted":
        if (c === quotechar) { field += c; state = "in_quoted"; }
        else if (c === delimiter) { endField(); state = "start_field"; }
        else if (eol) { endField(); endRecord(); state = "start_record"; if (c === "\r" && text[i + 1] === "\n") i++; }
        else { field += c; state = "in_field"; }
        break;
    }
    i++;
  }
  if (state !== "start_record") {
    if (state === "in_quoted") throw new NotPorted("csv: unexpected end of data inside a quoted field (csv.Error)");
    endField();
    endRecord();
  }
  return rows;
}

/** base_import.py:609-674 `_read_csv` separator sniffing: the first candidate giving equal widths >= 2. */
export function sniffSeparator(text: string, quotechar: string): string | null {
  for (const candidate of [",", ";", "\t", " ", "|", "\u001f"]) {
    let w: number | null = null;
    let ok = true;
    for (const row of csvRead(text, candidate, quotechar)) {
      const width = row.length;
      if (w === null) w = width;
      if (width === 1 || width !== w) { ok = false; break; }
    }
    if (ok) return candidate;
  }
  return null;
}

/**
 * `chardet.detect(data)['encoding'].lower()` for the inputs this port recognises: pure ASCII ('ascii'), a UTF-8 BOM
 * ('utf-8-sig'), and valid multi-byte UTF-8 ('utf-8', chardet's UTF-8 prober); anything else refuses.
 */
export function detectEncoding(data: Uint8Array): string {
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return "utf-8-sig";
  if (data.every((b) => b < 0x80)) return "ascii";
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data);
    return "utf-8";
  } catch {
    throw new NotPorted("chardet detection of a non-UTF-8 encoding");
  }
}

export function decode(data: Uint8Array, encoding: string): string {
  const e = encoding.toLowerCase().replace(/_/g, "-");
  if (e === "ascii" || e === "us-ascii") {
    if (!data.every((b) => b < 0x80)) throw new TypeError("ascii decode");
    return new TextDecoder("latin1").decode(data);
  }
  if (e === "utf-8-sig") return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data);
  if (e === "utf-8" || e === "utf8") return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  if (e === "latin1" || e === "latin-1" || e === "iso-8859-1") return new TextDecoder("latin1").decode(data);
  throw new NotPorted(`decoding import file as ${encoding}`);
}

// ---------------------------------------------------------------------------------------------------------------
// dates (base_import.py:1820-1890)
// ---------------------------------------------------------------------------------------------------------------

const SEPARATORS = [" ", "/", "-", ".", ""];
const PATTERN_BASELINE: readonly (readonly string[])[] = [["%m", "%d", "%Y"], ["%d", "%m", "%Y"], ["%Y", "%m", "%d"], ["%Y", "%d", "%m"]];
/** DATE_FORMATS: each baseline and its short-year variant (Odoo builds them in a set: the order between the two is
 * set-iteration order; only the first matching pattern's identity can depend on it). */
const DATE_FORMATS: string[][] = PATTERN_BASELINE.flatMap((ps) => [[...ps], ps.map((p) => (p === "%Y" ? "%y" : p))]);
export const DATE_PATTERNS: readonly string[] = SEPARATORS.flatMap((sep) => DATE_FORMATS.map((f) => f.join(sep)));
export const TIME_PATTERNS: readonly string[] = ["%H:%M:%S", "%H:%M", "%H", "%I:%M:%S %p", "%I:%M %p", "%I %p"];

const P_TO_RE: Readonly<Record<string, string>> = {
  d: "(3[0-1]|[1-2]\\d|0[1-9]|[1-9]| [1-9])", H: "(2[0-3]|[0-1]\\d|\\d)", I: "(1[0-2]|0[1-9]|[1-9])",
  m: "(1[0-2]|0[1-9]|[1-9])", M: "([0-5]\\d|\\d)", S: "(6[0-1]|[0-5]\\d|\\d)", y: "(\\d\\d)", Y: "(\\d\\d\\d\\d)",
  p: "(am|pm)", "%": "%",
};

/** base_import.py `to_re(pattern)`; throws KeyError-like for unknown directives. */
export function toRe(pattern: string): RegExp {
  let p = pattern.replace(/([\\.^$*+?(){}[\]|])/g, "\\$1");
  p = p.replace(/\s+/g, "\\s+");
  p = p.replace(/%([a-z])/gi, (_m, d: string) => {
    const r = P_TO_RE[d];
    if (r === undefined) throw new RangeError(`KeyError: '${d}'`);
    return r;
  });
  return new RegExp(`^${p}$`, "i");
}

/** base_import.py `check_patterns(patterns, values)`. */
export function checkPatterns(patterns: readonly string[], values: readonly string[]): string | null {
  for (const pattern of patterns) {
    const re = toRe(pattern);
    if (values.every((v) => !v || re.test(v))) return pattern;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// difflib.SequenceMatcher(None, a, b).ratio()
// ---------------------------------------------------------------------------------------------------------------

/** CPython Lib/difflib.py SequenceMatcher (isjunk=None, autojunk=True): `ratio()`. */
export function sequenceRatio(a: string, b: string): number {
  const A = [...a];
  const B = [...b];
  const b2j = new Map<string, number[]>();
  B.forEach((ch, i) => { const l = b2j.get(ch); if (l) l.push(i); else b2j.set(ch, [i]); });
  const n = B.length;
  if (n >= 200) {
    const ntest = Math.floor(n / 100) + 1;
    for (const [ch, idxs] of [...b2j]) if (idxs.length > ntest) b2j.delete(ch);
  }
  const findLongest = (alo: number, ahi: number, blo: number, bhi: number): [number, number, number] => {
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      for (const j of b2j.get(A[i]!) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
      j2len = newj2len;
    }
    // isbjunk is empty (isjunk=None): popular elements are extended over like any equal element
    while (besti > alo && bestj > blo && A[besti - 1] === B[bestj - 1]) { besti--; bestj--; bestsize++; }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && A[besti + bestsize] === B[bestj + bestsize]) bestsize++;
    return [besti, bestj, bestsize];
  };
  let matches = 0;
  const queue: [number, number, number, number][] = [[0, A.length, 0, B.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = findLongest(alo, ahi, blo, bhi);
    if (k) {
      matches += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  const total = A.length + B.length;
  return total ? (2 * matches) / total : 1;
}

/** Python `str.isdigit()` for a whole (non-empty) string. */
export function isDigit(s: string): boolean {
  return s !== "" && /^[\p{Nd}\u00b2\u00b3\u00b9\u2070-\u2079\u2080-\u2089]+$/u.test(s);
}
