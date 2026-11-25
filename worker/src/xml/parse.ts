/**
 * A small XML parser for Odoo view and template archs (`ir_ui_view.arch_db`), producing the lxml-shaped tree of
 * node.ts. No DOMParser on Workers. Scope: what `lxml.etree.fromstring` accepts in the corpus: elements,
 * attributes (both quote styles), text with the predefined entities and character references, comments,
 * processing instructions, CDATA (kept as text, as lxml does), an XML declaration and a DOCTYPE without an
 * internal subset (both dropped). Namespace prefixes are kept verbatim in tag and attribute names; `xmlns`
 * declarations are ordinary attributes (the stored archs already have them in lxml's serialization order).
 */
import { NotPorted } from "../errors";
import { append, comment, element, pi, type Element, type Node } from "./node";

export class XmlSyntaxError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = "XmlSyntaxError";
    this.offset = offset;
  }
}

const NAME_START = /[A-Za-z_:\u00c0-\uffff]/;
const NAME_CHAR = /[A-Za-z0-9_:.\-\u00b7\u00c0-\uffff]/;

const PREDEFINED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decode `&...;` references; unknown named entities are an error, as in libxml2 without a DTD. */
export function decodeEntities(s: string, offset: number): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (m, ref: string) => {
    if (ref.startsWith("#x")) return String.fromCodePoint(parseInt(ref.slice(2), 16));
    if (ref.startsWith("#")) return String.fromCodePoint(parseInt(ref.slice(1), 10));
    const v = PREDEFINED[ref];
    if (v === undefined) throw new XmlSyntaxError(`undefined entity &${ref}; in ${JSON.stringify(m)}`, offset);
    return v;
  });
}

/**
 * libxml2's HTML parser's empty elements (HTMLparser.c html40ElementTable, `empty`): a start tag without `/>` has no
 * content. `source`, `track` and `wbr` are left out: not verified against lxml, they refuse in HTML mode.
 */
const HTML_EMPTY = new Set(["area", "base", "basefont", "br", "col", "embed", "frame", "hr", "img", "input", "isindex", "link", "meta", "param"]);
const HTML_UNVERIFIED_EMPTY = new Set(["source", "track", "wbr"]);

class Parser {
  pos = 0;
  private lnPos = 0;
  private ln = 1;
  /** `html`: parse as lxml.html does for the subset of parseHtmlFragment, refusing what it would repair. */
  constructor(readonly src: string, readonly html = false) {}

  /** The 1-based line of `pos` (positions only grow while parsing, so this counts each newline once). */
  line(): number {
    for (let i = this.src.indexOf("\n", this.lnPos); i >= 0 && i < this.pos; i = this.src.indexOf("\n", i + 1)) this.ln++;
    this.lnPos = this.pos;
    return this.ln;
  }

  fail(msg: string): never {
    throw new XmlSyntaxError(msg, this.pos);
  }

  peek(s: string): boolean {
    return this.src.startsWith(s, this.pos);
  }

  skipWs(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) this.pos++;
  }

  name(): string {
    const start = this.pos;
    if (this.pos >= this.src.length || !NAME_START.test(this.src[this.pos]!)) this.fail("expected a name");
    this.pos++;
    while (this.pos < this.src.length && NAME_CHAR.test(this.src[this.pos]!)) this.pos++;
    const n = this.src.slice(start, this.pos);
    // libxml2's HTML parser lowercases names; a stored template is lxml's serialization (lowercase): refuse otherwise
    if (this.html && n !== n.toLowerCase()) this.fail(`uppercase name ${n} in HTML`);
    return n;
  }

  until(terminator: string, what: string): string {
    const end = this.src.indexOf(terminator, this.pos);
    if (end < 0) this.fail(`unterminated ${what}`);
    const s = this.src.slice(this.pos, end);
    this.pos = end + terminator.length;
    return s;
  }

  /** Prolog: XML declaration, comments, PIs, whitespace, DOCTYPE; returns the root element. */
  document(): Element {
    let root: Element | null = null;
    while (this.pos < this.src.length) {
      this.skipWs();
      if (this.pos >= this.src.length) break;
      if (this.peek("<?xml")) {
        this.until("?>", "XML declaration");
      } else if (this.peek("<!--")) {
        this.pos += 4;
        this.until("-->", "comment"); // prolog comments are not part of the element tree lxml returns
      } else if (this.peek("<!DOCTYPE")) {
        const start = this.pos;
        const end = this.src.indexOf(">", this.pos);
        if (end < 0) this.fail("unterminated DOCTYPE");
        if (this.src.slice(start, end).includes("[")) throw new NotPorted("DOCTYPE with an internal subset");
        this.pos = end + 1;
      } else if (this.peek("<?")) {
        this.pos += 2;
        this.until("?>", "processing instruction");
      } else if (this.peek("<")) {
        if (root !== null) this.fail("junk after document element");
        root = this.element();
      } else {
        this.fail("text outside the root element");
      }
    }
    if (root === null) this.fail("no root element");
    return root;
  }

  element(): Element {
    this.pos++; // '<'
    const el = element(this.name());
    for (;;) {
      const before = this.pos;
      this.skipWs();
      if (this.peek("/>")) {
        el.sourceline = this.line();
        this.pos += 2;
        return el;
      }
      if (this.peek(">")) {
        el.sourceline = this.line();
        this.pos++;
        if (this.html && HTML_UNVERIFIED_EMPTY.has(el.tag)) this.fail(`<${el.tag}> without '/>' in HTML`);
        if (this.html && HTML_EMPTY.has(el.tag)) return el; // an empty element has no content and no end tag
        break;
      }
      if (this.pos === before) this.fail("expected whitespace before attribute");
      const an = this.name();
      this.skipWs();
      if (!this.peek("=")) this.fail(`expected '=' after attribute ${an}`);
      this.pos++;
      this.skipWs();
      const q = this.src[this.pos];
      if (q !== '"' && q !== "'") this.fail("expected a quoted attribute value");
      this.pos++;
      const raw = this.until(q, "attribute value");
      if (raw.includes("<")) this.fail("'<' in attribute value");
      // attribute-value normalization (XML 1.0 section 3.3.3): literal whitespace characters become spaces; libxml2's
      // HTML parser keeps them
      const value = decodeEntities(this.html ? raw : raw.replace(/[\t\n\r]/g, " "), this.pos);
      if (el.attrib.has(an)) this.fail(`duplicate attribute ${an}`);
      el.attrib.set(an, value);
    }
    this.content(el);
    return el;
  }

  /** Children and text up to and including the matching end tag. */
  content(el: Element): void {
    let last: Node | null = null;
    const addText = (t: string): void => {
      if (t === "") return;
      if (last === null) el.text = (el.text ?? "") + t;
      else last.tail = (last.tail ?? "") + t;
    };
    for (;;) {
      if (this.pos >= this.src.length) this.fail(`unclosed element <${el.tag}>`);
      const lt = this.src.indexOf("<", this.pos);
      if (lt < 0) this.fail(`unclosed element <${el.tag}>`);
      if (lt > this.pos) {
        const raw = this.src.slice(this.pos, lt);
        if (raw.includes("]]>")) this.fail("']]>' in text");
        addText(decodeEntities(raw, this.pos));
        this.pos = lt;
      }
      if (this.peek("</")) {
        this.pos += 2;
        const n = this.name();
        if (n !== el.tag) this.fail(`mismatched end tag </${n}> for <${el.tag}>`);
        this.skipWs();
        if (!this.peek(">")) this.fail("expected '>'");
        this.pos++;
        return;
      }
      if (this.peek("<!--")) {
        this.pos += 4;
        const c = comment(this.until("-->", "comment"));
        append(el, c);
        last = c;
      } else if (this.peek("<![CDATA[")) {
        if (this.html) this.fail("CDATA section in HTML");
        this.pos += 9;
        addText(this.until("]]>", "CDATA section"));
      } else if (this.peek("<?")) {
        if (this.html) this.fail("processing instruction in HTML");
        this.pos += 2;
        const target = this.name();
        const before = this.pos;
        this.skipWs();
        const body = this.until("?>", "processing instruction");
        const p = pi(target, this.pos - 2 === before ? "" : body);
        append(el, p);
        last = p;
      } else {
        const child = this.element();
        append(el, child);
        last = child;
      }
    }
  }
}

/**
 * `lxml.html.fragment_fromstring(src, create_parent='div')` (libxml2's HTML parser) for what mail templates use, as
 * Odoo parses them (mail_render_mixin.py:315, :409): any tag (QWeb's `t`), `/>` closing any element, the empty
 * elements without content, comments, attribute values verbatim. What libxml2 would repair (a mismatched or missing
 * end tag, implicit closing of `p`/`li`/`td`, unquoted or valueless attributes, uppercase names, named entities other
 * than XML's, CDATA) raises XmlSyntaxError instead. worker/test/mail_template_parse_cases.py checks it against lxml
 * on the mail templates of both serializations (Odoo 9710d237f stores them as HTML, before it as XML).
 */
export function parseHtmlFragment(src: string): Element {
  const text = `<div>${src}</div>`;
  return new Parser(text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text, true).document();
}

/** `lxml.etree.fromstring(text)`: the root element of the document. */
export function parseXml(text: string): Element {
  // end-of-line normalization (XML 1.0 section 2.11)
  const src = text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
  return new Parser(src).document();
}
