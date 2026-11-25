/**
 * The XML side of the UBL import (src/models/ubl_import.ts): lxml's ElementPath for the paths account_edi_ubl_cii uses,
 * the file's tree as `_get_xml_tree` parses it, and the decoder its type selects. No ORM: unit tested on its own
 * (ubl_import.test.ts).
 */
import { NotPorted } from "../errors";
import { parseXml, XmlSyntaxError, type Element, type Node } from "../xml";

// ------------------------------------------------------------------------------------------------ the XML tree

/**
 * lxml's ElementPath for the paths the import uses: `{*}name` steps (any namespace: src/xml keeps prefixes in tag
 * names, so a step matches the local name), `/` children, `//` descendants, a leading `.` or `./`, and one
 * `[@attr='value']` predicate. Results in document order, as ElementTree gives them.
 */
interface Step { readonly desc: boolean; readonly name: string; readonly attr: readonly [string, string] | null }

export function parsePath(path: string): Step[] {
  let p = path;
  let desc = false;
  if (p.startsWith(".//")) { desc = true; p = p.slice(3); } else if (p.startsWith("./")) p = p.slice(2);
  const steps: Step[] = [];
  const re = /^\{\*\}([A-Za-z0-9_]+)(?:\[@([A-Za-z_]+)=(?:'([^']*)'|"([^"]*)")\])?(\/\/|\/)?/;
  while (p.length) {
    const m = re.exec(p);
    if (!m) throw new Error(`ElementPath not handled: ${path}`);
    steps.push({ desc, name: m[1]!, attr: m[2] ? [m[2], m[3] ?? m[4] ?? ""] : null });
    desc = m[5] === "//";
    p = p.slice(m[0].length);
  }
  return steps;
}

export const localName = (tag: string): string => tag.slice(tag.indexOf(":") + 1);
export const elements = (nodes: readonly Node[]): Element[] => nodes.filter((n): n is Element => n.kind === "element");

export function descendants(el: Element, out: Element[] = []): Element[] {
  for (const c of elements(el.children)) { out.push(c); descendants(c, out); }
  return out;
}

export function findall(el: Element, path: string): Element[] {
  let current = [el];
  for (const step of parsePath(path)) {
    const next: Element[] = [];
    const seen = new Set<Element>();
    for (const c of current) {
      for (const e of step.desc ? descendants(c) : elements(c.children)) {
        if (localName(e.tag) !== step.name || seen.has(e)) continue;
        if (step.attr && e.attrib.get(step.attr[0]) !== step.attr[1]) continue;
        seen.add(e);
        next.push(e);
      }
    }
    current = next;
  }
  return current;
}

export function find(el: Element, path: string): Element | null {
  return findall(el, path)[0] ?? null;
}

/** `findtext`: the element's text ('' without text), null without the element. */
export function findtext(el: Element, path: string): string | null {
  const e = find(el, path);
  return e === null ? null : e.text ?? "";
}

/** The namespace URI of an element's tag, from the `xmlns` declarations of it and its ancestors. */
export function namespaceOf(el: Element): string | null {
  const i = el.tag.indexOf(":");
  const attr = i < 0 ? "xmlns" : `xmlns:${el.tag.slice(0, i)}`;
  for (let e: Element | null = el; e; e = e.parent) {
    const v = e.attrib.get(attr);
    if (v !== undefined) return v;
  }
  return null;
}

/** `etree.QName(el).text`: `{uri}local`. */
export const qname = (el: Element): string => `{${namespaceOf(el) ?? ""}}${localName(el.tag)}`.replace(/^\{\}/, "");

/** Python's `float(str)` for the decimals of a UBL file; anything else (exponents, `inf`, `1_0`) refuses. */
export function pyFloat(s: string): number {
  const t = s.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) throw new NotPorted(`a UBL amount written as ${JSON.stringify(s)}`);
  return Number(t);
}

/** `fields.Date.from_string`: an ISO date (anything else refuses). */
export function isoDate(s: string): string {
  const t = s.slice(0, 10);
  const d = new Date(`${t}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t) throw new NotPorted(`a UBL date written as ${JSON.stringify(s)}`);
  return t;
}

/**
 * The tree `_get_xml_tree` (account_document_import_mixin.py:468-488) parses, as lxml with `remove_comments=True,
 * resolve_entities=False`, for UTF-8 files; another encoding, comments or processing instructions inside the document
 * (lxml joins the text around a removed comment) and a file lxml may read otherwise refuse.
 */
export function parseFile(data: Uint8Array): Element {
  let bytes = data;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) throw new NotPorted("a UTF-16 XML file");
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
  const enc = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/.exec(head)?.[1];
  if (enc !== undefined && !/^utf-?8$/i.test(enc)) throw new NotPorted(`an XML file in ${enc}`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new NotPorted("an XML file that is not UTF-8");
  }
  let root: Element;
  try {
    root = parseXml(text);
  } catch (e) {
    if (e instanceof XmlSyntaxError) throw new NotPorted(`an XML file the port does not parse (${e.message})`);
    throw e;
  }
  const walk = (el: Element): void => {
    for (const c of el.children) {
      if (c.kind !== "element") throw new NotPorted("an XML file with comments or processing instructions inside its document");
      walk(c);
    }
  };
  walk(root);
  return root;
}

export const BIS3 = "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0";

/**
 * account_edi_ubl_cii account_move.py:214-242 `_get_import_file_type` of the tree, and the decoder it selects
 * (:307-324: the children of account.edi.xml.ubl_20 and .cii, priority 20). Only account.edi.xml.ubl_bis3 is ported:
 * the tree is returned for it, every other type the decoders take refuses, and an XML file no decoder takes refuses
 * too (step 1 keeps refusing it, src/mail/move_import.ts).
 */
export function bis3Tree(data: Uint8Array): Element {
  const tree = parseFile(data);
  if (localName(tree.tag) === "AttachedDocument") throw new NotPorted("a UBL AttachedDocument (account.edi.xml.ubl.attached_document)");
  if (qname(tree) === "{urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100}CrossIndustryInvoice") throw new NotPorted("a CII invoice (account.edi.xml.cii)");
  const customization = findtext(tree, "{*}CustomizationID");
  if (customization) {
    if (customization.includes("xrechnung")) throw new NotPorted("an XRechnung invoice (account.edi.xml.ubl_de)");
    if (customization === "urn:cen.eu:en16931:2017#compliant#urn:fdc:nen.nl:nlcius:v1.0") throw new NotPorted("an NLCIUS invoice (account.edi.xml.ubl_nl)");
    if (customization === "urn:cen.eu:en16931:2017#conformant#urn:fdc:peppol.eu:2017:poacc:billing:international:aunz:3.0") throw new NotPorted("an A-NZ invoice (account.edi.xml.ubl_a_nz)");
    if (customization === "urn:cen.eu:en16931:2017#conformant#urn:fdc:peppol.eu:2017:poacc:billing:international:sg:3.0") throw new NotPorted("an SG invoice (account.edi.xml.ubl_sg)");
    if (customization === BIS3) return tree;
  }
  const version = findtext(tree, "{*}UBLVersionID");
  if (version === "2.0") throw new NotPorted("a UBL 2.0 invoice (account.edi.xml.ubl_20)");
  if (version === "2.1" || version === "2.2" || version === "2.3") throw new NotPorted("a UBL 2.1 invoice (account.edi.xml.ubl_21)");
  if (customization && customization.includes("urn:cen.eu:en16931:2017")) return tree;
  throw new NotPorted("an XML file on an invoice that no EDI decoder takes");
}

