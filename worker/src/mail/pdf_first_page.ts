/**
 * `odoo.tools.pdf.extract_page(attachment, 0)` (odoo/odoo/tools/pdf/__init__.py:202-212) as Odoo runs it with
 * PyPDF2 2.12.1 (.venv: `PdfFileReader(stream).pages[0]` added to a `BrandedFileWriter`, :120-126, then `write`).
 * The output is PyPDF2's serialization, reproduced byte for byte for the subset ported here:
 *  - reader (PyPDF2/_reader.py, generic/*): one classic xref table (no /Prev, no xref or object streams, no
 *    encryption), objects made of dictionaries, arrays, names without '#', numbers, references, booleans, null,
 *    literal strings of printable ASCII, and streams whose /Length is exact; the page tree flattening with its
 *    inherited attributes (_reader.py `_flatten`);
 *  - writer (PyPDF2/_writer.py): objects 1 /Pages, 2 info, 3 the page, 4 /Catalog, then the objects found by
 *    `_sweep_indirect_references` (:1011-1090, depth-first from the root with its stack, the `_idnum_hash`
 *    de-duplication by `hash_value` and its bookkeeping), `_write_header` (:942), the xref table (:965) and the
 *    trailer (:974); `write_to_stream` of each generic object (generic/_base.py, _data_structures.py).
 * Anything outside the subset raises NotPorted.
 */
import { NotPorted } from "../errors";

type PObj = PDict | PArr | PName | PInt | PFloat | PStr | PHex | PBool | PNull | PRef;
interface PHex { readonly t: "hex"; readonly v: string }
interface PDict { readonly t: "dict"; cls: string; entries: Map<string, PObj>; data?: Uint8Array }
interface PArr { readonly t: "array"; items: PObj[] }
interface PName { readonly t: "name"; readonly v: string }
interface PInt { readonly t: "int"; readonly v: bigint }
interface PFloat { readonly t: "float"; readonly repr: string }
interface PStr { readonly t: "str"; readonly v: string }
interface PBool { readonly t: "bool"; readonly v: boolean }
interface PNull { readonly t: "null" }
interface PRef { readonly t: "ref"; readonly num: number; readonly gen: number; readonly pdf: "R" | "W" }

const enc = new TextEncoder();
const WS = new Set([0x20, 0x0a, 0x0d, 0x09, 0x00]); // _utils.py:328 WHITESPACES
const isSpace = (c: number): boolean => c === 0x20 || (c >= 0x09 && c <= 0x0d); // regex \s (bytes)
const NAME_DELIMS = new Set([...("()<>[]{}/%")].map((c) => c.charCodeAt(0)));

/** FloatObject.__repr__ (generic/_base.py:242-249) of the decimal written in the file. */
function floatRepr(token: string): string {
  const m = /^([+-]?)(\d*)\.?(\d*)$/.exec(token);
  if (m === null) throw new NotPorted(`PDF number ${token}`);
  const sign = m[1] === "-" ? "-" : "";
  const intPart = (m[2] ?? "").replace(/^0+(?=\d)/, "") || "0";
  const frac = (m[3] ?? "").replace(/0+$/, "");
  return frac === "" ? `${sign}${intPart}` : `${sign}${intPart}.${frac}`;
}

class Reader {
  pos = 0;
  readonly xref = new Map<number, { offset: number; gen: number }>();
  readonly cache = new Map<string, PObj>();
  trailer: PDict | null = null;
  header = "";

  constructor(readonly buf: Uint8Array) {}

  private peek(): number { return this.buf[this.pos] ?? -1; }
  private text(from: number, to: number): string { return String.fromCharCode(...this.buf.subarray(from, to)); }

  /** _utils.py read_non_whitespace: the next non-whitespace byte (consumed). */
  private nonWs(): number {
    while (this.pos < this.buf.length && WS.has(this.buf[this.pos]!)) this.pos++;
    return this.buf[this.pos++] ?? -1;
  }

  open(): void {
    this.header = this.text(0, 8);
    const tail = this.text(Math.max(0, this.buf.length - 1024), this.buf.length);
    const at = tail.lastIndexOf("startxref");
    if (at < 0 || !tail.includes("%%EOF")) throw new NotPorted("PDF without startxref/%%EOF");
    const m = /^startxref\s+(\d+)/.exec(tail.slice(at));
    if (m === null) throw new NotPorted("PDF startxref");
    this.pos = Number(m[1]);
    if (this.text(this.pos, this.pos + 4) !== "xref") throw new NotPorted("PDF cross-reference stream");
    this.pos += 4;
    for (;;) {
      const c = this.nonWs();
      if (c === "t".charCodeAt(0)) { this.pos--; break; }
      this.pos--;
      const head = /^(\d+)\s+(\d+)/.exec(this.text(this.pos, this.pos + 40));
      if (head === null) throw new NotPorted("PDF xref subsection");
      this.pos += head[0].length;
      const start = Number(head[1]), count = Number(head[2]);
      for (let i = 0; i < count; i++) {
        while (WS.has(this.buf[this.pos]!)) this.pos++;
        const e = /^(\d{10}) (\d{5}) ([nf])/.exec(this.text(this.pos, this.pos + 18));
        if (e === null) throw new NotPorted("PDF xref entry");
        this.pos += 18;
        if (e[3] === "n" && !this.xref.has(start + i)) this.xref.set(start + i, { offset: Number(e[1]), gen: Number(e[2]) });
      }
    }
    if (this.text(this.pos, this.pos + 7) !== "trailer") throw new NotPorted("PDF trailer");
    this.pos += 7;
    this.nonWs(); this.pos--;
    const trailer = this.readObject();
    if (trailer.t !== "dict") throw new NotPorted("PDF trailer dictionary");
    for (const k of ["/Prev", "/XRefStm", "/Encrypt"]) if (trailer.entries.has(k)) throw new NotPorted(`PDF trailer ${k}`);
    this.trailer = trailer;
  }

  getObject(ref: PRef): PObj {
    const key = `${ref.num} ${ref.gen}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const entry = this.xref.get(ref.num);
    if (entry === undefined || entry.gen !== ref.gen) throw new NotPorted(`PDF object ${key} not in the xref table`);
    const save = this.pos;
    this.pos = entry.offset;
    const head = /^(\d+)\s+(\d+)\s+obj/.exec(this.text(this.pos, this.pos + 40));
    if (head === null || Number(head[1]) !== ref.num || Number(head[2]) !== ref.gen) throw new NotPorted(`PDF object header ${key}`);
    this.pos += head[0].length;
    this.nonWs(); this.pos--;
    const obj = this.readObject();
    this.pos = save;
    this.cache.set(key, obj);
    return obj;
  }

  resolve(o: PObj): PObj { return o.t === "ref" ? this.getObject(o) : o; }

  /** generic/_data_structures.py:826 read_object. */
  readObject(): PObj {
    const c = this.peek();
    const ch = String.fromCharCode(c);
    if (ch === "/") return this.readName();
    if (ch === "<") {
      if (this.buf[this.pos + 1] === 0x3c) return this.readDict();
      // _utils.py read_hex_string_from_stream: kept as bytes; writing one is not ported (only the trailer's /ID has them)
      const end = this.buf.indexOf(0x3e, this.pos);
      if (end < 0) throw new NotPorted("PDF truncated hexadecimal string");
      const hex = this.text(this.pos + 1, end).replace(/\s+/g, "");
      this.pos = end + 1;
      return { t: "hex", v: hex };
    }
    if (ch === "[") return this.readArray();
    if (ch === "t" || ch === "f") {
      const word = this.text(this.pos, this.pos + (ch === "t" ? 4 : 5));
      if (word !== "true" && word !== "false") throw new NotPorted(`PDF token ${word}`);
      this.pos += word.length;
      return { t: "bool", v: word === "true" };
    }
    if (ch === "(") return this.readString();
    if (ch === "n") {
      if (this.text(this.pos, this.pos + 4) !== "null") throw new NotPorted("PDF token n");
      this.pos += 4;
      return { t: "null" };
    }
    if (ch === "%") throw new NotPorted("PDF comment inside an object");
    if ("0123456789+-.".includes(ch)) {
      const peek = this.text(this.pos, this.pos + 20);
      const m = /^[+-]?(\d+)\s+(\d+)\s+R[^a-zA-Z]/.exec(peek); // IndirectPattern (:72)
      if (m !== null) {
        const r = /^[+-]?(\d+)\s+(\d+)\s+R/.exec(peek)!;
        this.pos += r[0].length;
        return { t: "ref", num: Number(m[1]), gen: Number(m[2]), pdf: "R" };
      }
      let end = this.pos;
      while (end < this.buf.length && "+-.0123456789".includes(String.fromCharCode(this.buf[end]!))) end++;
      const tok = this.text(this.pos, end);
      this.pos = end;
      if (tok.includes(".")) return { t: "float", repr: floatRepr(tok) };
      if (!/^[+-]?\d+$/.test(tok)) throw new NotPorted(`PDF number ${tok}`);
      return { t: "int", v: BigInt(tok) };
    }
    throw new NotPorted(`PDF token ${JSON.stringify(ch)}`);
  }

  private readName(): PName {
    let end = this.pos + 1;
    while (end < this.buf.length && !isSpace(this.buf[end]!) && !NAME_DELIMS.has(this.buf[end]!)) end++;
    const name = this.text(this.pos, end);
    this.pos = end;
    if (name.includes("#") || /[^\x21-\x7e]/.test(name)) throw new NotPorted(`PDF name ${name}`);
    return { t: "name", v: name };
  }

  private readArray(): PArr {
    this.pos++;
    const items: PObj[] = [];
    for (;;) {
      const c = this.nonWs();
      if (c === 0x5d) break;
      if (c < 0) throw new NotPorted("PDF truncated array");
      this.pos--;
      items.push(this.readObject());
    }
    return { t: "array", items };
  }

  private readString(): PStr {
    this.pos++;
    let depth = 1;
    const out: number[] = [];
    const simple: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "/": 47, "\\": 92, " ": 32, "%": 37, "<": 60, ">": 62, "[": 91, "]": 93, "#": 35, _: 95, "&": 38, $: 36 };
    for (;;) {
      const c = this.buf[this.pos++];
      if (c === undefined) throw new NotPorted("PDF truncated string");
      if (c === 0x28) depth++;
      else if (c === 0x29) { depth--; if (depth === 0) break; }
      else if (c === 0x5c) {
        const e = String.fromCharCode(this.buf[this.pos++] ?? 0);
        const v = simple[e];
        if (v !== undefined) { out.push(v); continue; }
        if (e >= "0" && e <= "7") {
          let oct = e;
          for (let i = 0; i < 2 && /[0-7]/.test(String.fromCharCode(this.buf[this.pos] ?? 0)); i++) oct += String.fromCharCode(this.buf[this.pos++]!);
          out.push(parseInt(oct, 8));
          continue;
        }
        throw new NotPorted(`PDF string escape \\${e}`);
      }
      out.push(c);
    }
    if (out.some((b) => b < 0x20 || b > 0x7e)) throw new NotPorted("PDF string outside printable ASCII");
    return { t: "str", v: String.fromCharCode(...out) };
  }

  /** DictionaryObject.read_from_stream (:214), with the stream branch and StreamObject.initialize_from_dictionary. */
  private readDict(): PDict {
    this.pos += 2;
    const entries = new Map<string, PObj>();
    for (;;) {
      const c = this.nonWs();
      if (c === 0x00) continue;
      if (c === 0x25) {
        // skip_over_comment
        while (this.pos < this.buf.length && this.buf[this.pos] !== 0x0a && this.buf[this.pos] !== 0x0d) this.pos++;
        continue;
      }
      if (c < 0) throw new NotPorted("PDF truncated dictionary");
      if (c === 0x3e) { this.pos++; break; }
      this.pos--;
      const key = this.readObject();
      if (key.t !== "name") throw new NotPorted("PDF dictionary key that is not a name");
      this.nonWs(); this.pos--;
      const value = this.readObject();
      // `if not data.get(key): data[key] = value` (:268): a falsy previous value is replaced
      if (entries.has(key.v)) throw new NotPorted(`PDF duplicate dictionary key ${key.v}`);
      entries.set(key.v, value);
    }
    const save = this.pos;
    const s = this.nonWs();
    if (s === 0x73 && this.text(this.pos, this.pos + 5) === "tream") {
      this.pos += 5;
      let eol = this.buf[this.pos++];
      while (eol === 0x20) eol = this.buf[this.pos++];
      if (eol !== 0x0a && eol !== 0x0d) throw new NotPorted("PDF stream keyword not followed by a newline");
      if (eol === 0x0d && this.buf[this.pos] === 0x0a) this.pos++;
      let length = entries.get("/Length");
      if (length === undefined) throw new NotPorted("PDF stream without /Length");
      if (length.t === "ref") length = this.getObject(length);
      if (length.t !== "int") throw new NotPorted("PDF stream /Length");
      const n = Number(length.v);
      const data = this.buf.slice(this.pos, this.pos + n);
      this.pos += n;
      const e = this.nonWs();
      if (String.fromCharCode(e) + this.text(this.pos, this.pos + 8) !== "endstream") throw new NotPorted("PDF stream /Length does not end at endstream");
      this.pos += 8;
      entries.delete("/Length");
      return { t: "dict", cls: entries.has("/Filter") ? "EncodedStreamObject" : "DecodedStreamObject", entries, data };
    }
    this.pos = save;
    return { t: "dict", cls: "DictionaryObject", entries };
  }

  /** _reader.py `_flatten` up to the first page. */
  firstPage(): PDict {
    const root = this.resolve(this.trailer!.entries.get("/Root") ?? { t: "null" });
    if (root.t !== "dict") throw new NotPorted("PDF /Root");
    const pages = this.resolve(root.entries.get("/Pages") ?? { t: "null" });
    if (pages.t !== "dict") throw new NotPorted("PDF /Pages");
    const found: PDict[] = [];
    const inherit = new Map<string, PObj>(); // shared between siblings, as in PyPDF2
    const walk = (node: PDict): void => {
      const type = node.entries.get("/Type");
      const t = type === undefined ? "/Pages" : type.t === "name" ? type.v : "";
      if (t === "/Pages") {
        for (const attr of ["/Resources", "/MediaBox", "/CropBox", "/Rotate"]) {
          const v = node.entries.get(attr);
          if (v !== undefined) inherit.set(attr, v);
        }
        const kids = node.entries.get("/Kids");
        if (kids === undefined || kids.t !== "array") throw new NotPorted("PDF /Kids");
        for (const kid of kids.items) {
          const k = this.resolve(kid);
          if (k.t !== "dict") throw new NotPorted("PDF page tree node");
          walk(k);
          if (found.length > 0) return;
        }
      } else if (t === "/Page") {
        for (const [attr, value] of inherit) if (!node.entries.has(attr)) node.entries.set(attr, value);
        found.push({ t: "dict", cls: "PageObject", entries: new Map(node.entries) });
      }
    };
    walk(pages);
    const page = found[0];
    if (page === undefined) throw new NotPorted("PDF without pages");
    return page;
  }
}

/** `"%s" % obj` (Python repr of the PyPDF2 objects) for hash_value (generic/_base.py:57-67). */
function repr(o: PObj): string {
  switch (o.t) {
    case "dict": return `{${[...o.entries].map(([k, v]) => `'${k}': ${repr(v)}`).join(", ")}}`;
    case "array": return `[${o.items.map(repr).join(", ")}]`;
    case "name": return `'${o.v}'`;
    case "int": return o.v.toString();
    case "float": return `F${o.repr}`;
    case "str": return JSON.stringify(o.v);
    case "hex": return `b'${o.v}'`;
    case "bool": return o.v ? "True" : "False";
    case "null": return "NullObject";
    case "ref": return `IndirectObject(${o.num}, ${o.gen}, ${o.pdf})`;
  }
}
function hashValue(o: PObj): string {
  const cls = o.t === "dict" ? o.cls : o.t === "array" ? "ArrayObject" : o.t;
  const data = o.t === "dict" && o.data !== undefined ? `|${Buffer.from(o.data).toString("hex")}` : "";
  return `${cls}:${repr(o)}${data}`;
}

function sameObject(a: PObj | undefined, b: PObj): boolean {
  if (a === b) return true;
  if (a === undefined) return false;
  if (a.t === "ref" && b.t === "ref") return a.num === b.num && a.gen === b.gen && a.pdf === b.pdf;
  return false;
}

function serialize(o: PObj, out: number[][]): void {
  const w = (s: string): void => { out.push([...enc.encode(s)]); };
  switch (o.t) {
    case "dict": {
      if (o.data !== undefined) o.entries.set("/Length", { t: "int", v: BigInt(o.data.length) });
      w("<<\n");
      for (const [k, v] of o.entries) { w(k); w(" "); serialize(v, out); w("\n"); }
      w(">>");
      if (o.data !== undefined) {
        o.entries.delete("/Length");
        w("\nstream\n");
        out.push([...o.data]);
        w("\nendstream");
      }
      return;
    }
    case "array": w("["); for (const it of o.items) { w(" "); serialize(it, out); } w(" ]"); return;
    case "name": w(o.v); return;
    case "int": w(o.v.toString()); return;
    case "float": w(o.repr); return;
    case "str": {
      // TextStringObject.write_to_stream (generic/_base.py:371-398): alphanumerics as is, the rest octal-escaped
      let s = "(";
      for (const ch of o.v) s += /[A-Za-z0-9]/.test(ch) ? ch : `\\${ch.charCodeAt(0).toString(8).padStart(3, "0")}`;
      w(`${s})`);
      return;
    }
    case "hex": throw new NotPorted("writing a PDF byte string (ByteStringObject)");
    case "bool": w(o.v ? "true" : "false"); return;
    case "null": w("null"); return;
    case "ref": w(`${o.num} ${o.gen} R`); return;
  }
}

/** The first page of `pdf` as PyPDF2 2.12.1 writes it through Odoo's BrandedFileWriter. */
export function extractFirstPage(pdf: Uint8Array): Uint8Array {
  const reader = new Reader(pdf);
  reader.open();
  const page = reader.firstPage();

  const objects: PObj[] = [];
  const add = (o: PObj): PRef => { objects.push(o); return { t: "ref", num: objects.length, gen: 0, pdf: "W" }; };
  const pagesDict: PDict = { t: "dict", cls: "DictionaryObject", entries: new Map<string, PObj>([["/Type", { t: "name", v: "/Pages" }], ["/Count", { t: "int", v: 0n }], ["/Kids", { t: "array", items: [] }]]) };
  const pagesRef = add(pagesDict);
  const info: PDict = { t: "dict", cls: "DictionaryObject", entries: new Map<string, PObj>([["/Producer", { t: "str", v: "PyPDF2" }]]) };
  const infoRef = add(info);
  // _add_page (:236-251)
  page.entries.set("/Parent", pagesRef);
  const pageRef = add(page);
  (pagesDict.entries.get("/Kids") as PArr).items.push(pageRef);
  pagesDict.entries.set("/Count", { t: "int", v: 1n });
  // BrandedFileWriter.write_stream: add_metadata({'/Creator': "Odoo", '/Producer': "Odoo"})
  info.entries.set("/Creator", { t: "str", v: "Odoo" });
  info.entries.set("/Producer", { t: "str", v: "Odoo" });
  const catalog: PDict = { t: "dict", cls: "DictionaryObject", entries: new Map<string, PObj>([["/Type", { t: "name", v: "/Catalog" }], ["/Pages", pagesRef]]) };
  const rootRef = add(catalog);

  // _sweep_indirect_references (:1011-1090)
  const idnumHash = new Map<string, PRef>();
  const getObject = (r: PRef): PObj => (r.pdf === "W" ? objects[r.num - 1]! : reader.getObject(r));
  const resolveRef = (r: PRef): PRef => {
    const real = getObject(r);
    const h = hashValue(real);
    const known = idnumHash.get(h);
    if (known !== undefined) return known;
    const mapped = r.pdf === "W" ? { t: "ref" as const, num: r.num, gen: 0, pdf: "W" as const } : add(real);
    idnumHash.set(h, mapped);
    return mapped;
  };
  type Container = PDict | PArr;
  const getItem = (c: Container, k: string | number): PObj | undefined => (c.t === "dict" ? c.entries.get(k as string) : c.items[k as number]);
  const setItem = (c: Container, k: string | number, v: PObj): void => { if (c.t === "dict") c.entries.set(k as string, v); else c.items[k as number] = v; };
  const stack: [PObj, Container | null, string | number | null, Container[]][] = [[rootRef, null, null, []]];
  const discovered = new Set<string>();
  while (stack.length > 0) {
    let [data, parent, key, grantParents] = stack.pop()!;
    if (data.t === "dict" || data.t === "array") {
      const items: [string | number, PObj][] = data.t === "dict" ? [...data.entries] : data.items.map((v, i) => [i, v]);
      for (const [k, v] of items) stack.push([v, data, k, parent !== null ? [...grantParents, parent] : []]);
    } else if (data.t === "ref") {
      data = resolveRef(data);
      const id = repr(data);
      if (!discovered.has(id)) {
        discovered.add(id);
        stack.push([getObject(data), null, null, []]);
      }
    }
    if (parent !== null && key !== null) {
      if (data.t === "dict" && data.data !== undefined) data = resolveRef(add(data)); // streams must be indirect
      if (!sameObject(getItem(parent, key), data)) {
        const updateHashes = [hashValue(parent), ...grantParents.map(hashValue)];
        setItem(parent, key, data);
        for (const old of updateHashes) {
          const ref = idnumHash.get(old);
          if (ref === undefined) continue;
          idnumHash.delete(old);
          idnumHash.set(hashValue(getObject(ref)), ref);
        }
      }
    }
  }

  // _write_header, _write_xref_table, _write_trailer (:942-988)
  const versions = ["%PDF-1.3", "%PDF-1.4", "%PDF-1.5", "%PDF-1.6", "%PDF-1.7", "%PDF-2.0"];
  const header = versions[Math.max(0, versions.indexOf(reader.header))]!;
  const chunks: number[][] = [];
  let size = 0;
  const write = (bytes: number[] | Uint8Array): void => { const a = [...bytes]; chunks.push(a); size += a.length; };
  write(enc.encode(`${header}\n`));
  write([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]);
  const positions: number[] = [];
  objects.forEach((obj, i) => {
    positions.push(size);
    write(enc.encode(`${i + 1} 0 obj\n`));
    const parts: number[][] = [];
    serialize(obj, parts);
    for (const p of parts) write(p);
    write(enc.encode("\nendobj\n"));
  });
  const xrefAt = size;
  write(enc.encode(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`));
  for (const p of positions) write(enc.encode(`${String(p).padStart(10, "0")} 00000 n \n`));
  write(enc.encode("trailer\n"));
  const trailer: PDict = { t: "dict", cls: "DictionaryObject", entries: new Map<string, PObj>([["/Size", { t: "int", v: BigInt(objects.length + 1) }], ["/Root", rootRef], ["/Info", infoRef]]) };
  const parts: number[][] = [];
  serialize(trailer, parts);
  for (const p of parts) write(p);
  write(enc.encode(`\nstartxref\n${xrefAt}\n%%EOF\n`));
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
