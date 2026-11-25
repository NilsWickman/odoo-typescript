/**
 * `lxml.etree.tostring(node, encoding='unicode')` byte for byte: attributes in insertion order, `<x/>` only when the
 * element has neither children nor text (`text == ''` serializes as `<x></x>`), libxml2's escaping (text: `& < >`
 * and `\r`; attributes: `& < > " \n \t \r`, never `'`), comments and PIs verbatim, and the node's tail
 * (lxml's default `with_tail=True`).
 */
import type { Node } from "./node";
import { NotPorted } from "../errors";

export function escapeText(s: string): string {
  return s.replace(/[&<>\r]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&#13;"));
}

export function escapeAttr(s: string): string {
  return s.replace(/[&<>"\n\t\r]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : c === "\n" ? "&#10;" : c === "\t" ? "&#9;" : "&#13;",
  );
}

function write(node: Node, out: string[]): void {
  if (node.kind === "element") {
    out.push("<", node.tag);
    for (const [k, v] of node.attrib) out.push(" ", k, '="', escapeAttr(v), '"');
    if (node.children.length === 0 && node.text === null) {
      out.push("/>");
    } else {
      out.push(">");
      if (node.text !== null) out.push(escapeText(node.text));
      for (const c of node.children) write(c, out);
      out.push("</", node.tag, ">");
    }
  } else if (node.kind === "comment") {
    out.push("<!--", node.text, "-->");
  } else {
    out.push("<?", node.target, node.text === "" ? "" : " " + node.text, "?>");
  }
  if (node.tail !== null) out.push(escapeText(node.tail));
}

/** Serialize `node` with its tail, like `etree.tostring(node, encoding='unicode')`. */
export function serializeXml(node: Node, opts: { withTail?: boolean } = {}): string {
  const out: string[] = [];
  if (opts.withTail === false) {
    const tail = node.tail;
    node.tail = null;
    try {
      write(node, out);
    } finally {
      node.tail = tail;
    }
  } else {
    write(node, out);
  }
  return out.join("");
}

/** libxml2's HTML 4 empty elements (HTMLparser.c html40ElementTable `empty`): no end tag in method='html'. */
const HTML_VOID = new Set(["area", "base", "basefont", "br", "col", "frame", "hr", "img", "input", "isindex", "link", "meta", "param"]);
/** Attributes libxml2 escapes as URIs in method='html' (HTMLtree.c htmlAttrDumpOutput). */
const HTML_URI_ATTRS = new Set(["href", "action", "src", "name"]);

function writeHtml(node: Node, out: string[]): void {
  if (node.kind === "element") {
    const tag = node.tag.toLowerCase();
    if (tag === "script" || tag === "style") throw new NotPorted(`html serialization of <${tag}> (raw content)`);
    out.push("<", node.tag);
    for (const [k, v] of node.attrib) {
      // HTMLtree.c htmlAttrDumpOutput: `"` as &quot; and `&` as &amp;; URI attributes are escaped as URIs, and the
      // other characters' handling (< > in values) is not reproduced here
      if (/[<>]/.test(v) || (HTML_URI_ATTRS.has(k.toLowerCase()) && /[^\x21-\x7e]/.test(v))) throw new NotPorted(`html serialization of attribute ${k}="${v.slice(0, 40)}"`);
      out.push(" ", k, '="', v.replace(/&/g, "&amp;").replace(/"/g, "&quot;"), '"');
    }
    out.push(">");
    if (HTML_VOID.has(tag)) {
      if (node.children.length || node.text) throw new NotPorted(`html serialization of a <${tag}> with content`);
    } else {
      if (node.text !== null) out.push(escapeHtmlText(node.text));
      for (const c of node.children) writeHtml(c, out);
      out.push("</", node.tag, ">");
    }
  } else if (node.kind === "comment") {
    out.push("<!--", node.text, "-->");
  } else {
    throw new NotPorted("html serialization of a processing instruction");
  }
  if (node.tail !== null) out.push(escapeHtmlText(node.tail));
}

/** HTMLtree.c text content: `& < >` as entities (encoding='unicode': no other character escaped); `\r` refuses. */
function escapeHtmlText(s: string): string {
  if (s.includes("\r")) throw new NotPorted("html serialization of a carriage return");
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

/** `etree.tostring(node, method='html', encoding='unicode')` with the node's tail (convert.py:134-135 type="html"). */
export function serializeHtml(node: Node): string {
  const out: string[] = [];
  writeHtml(node, out);
  return out.join("");
}
