/**
 * The html a PDF engine gets for a report (base_report_wkhtmltox ir_actions_report.py:156-238
 * `_prepare_wkhtmltopdf_html`): the rendered report is parsed with lxml.html, the header and footer divs are moved
 * out, each article is rendered on its own in `web.minimal_layout`, and the root's `data-report-*` attributes are
 * the paper format arguments.
 *
 * lxml.html is libxml2's HTML parser (lxml 5.2.1 with libxml2 2.12.6 on the oracle). The parser here covers what
 * QWeb emits for reports: elements, void elements, character data, entities, comments, scripts and the doctype. What
 * libxml2 would repair (an end tag that does not match, an element that closes an open paragraph or list item, an
 * unquoted attribute) refuses: the tree would differ.
 */
import { NotPorted } from "../errors";

export interface HEl { tag: string; attrs: [string, string][]; children: HNode[] }
export interface HComment { comment: string }
export type HNode = HEl | HComment | string;

const isEl = (n: HNode | undefined): n is HEl => typeof n === "object" && n !== null && "tag" in n;

/** libxml2 HTMLparser.c html40ElementTable entries with `empty` set (no end tag, no content). */
const VOID = new Set("area base basefont br col frame hr img input isindex link meta param embed source track wbr".split(" "));
/** Start tags that close an open <p> (HTMLparser.c htmlStartClose, the entries for "p"). */
const CLOSES_P = new Set(("address blockquote center dir div dl fieldset form h1 h2 h3 h4 h5 h6 hr isindex listing menu ol p pre "
  + "table ul xmp dd dt li frameset noframes").split(" "));
/** HTMLparser.c htmlIsBooleanAttr. */
const BOOLEAN = new Set("checked compact declare defer disabled ismap multiple nohref noresize noshade nowrap readonly selected".split(" "));
const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function refuse(what: string): never {
  throw new NotPorted(`report html for the PDF engine: ${what} (lxml.html parser case)`);
}

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);?/g, (m, body: string) => {
    if (!m.endsWith(";")) refuse(`entity without ';' (${m})`);
    if (body.startsWith("#x")) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10));
    const v = ENTITIES[body];
    if (v === undefined) refuse(`entity &${body};`);
    return v;
  });
}

/** `lxml.html.fromstring(html)` of a whole document: the <html> element. */
export function parseHtmlDocument(src: string): HEl {
  let i = 0;
  const doctype = /^\s*<!DOCTYPE html>/i.exec(src);
  if (doctype) i = doctype[0].length;
  const stack: HEl[] = [];
  let root: HEl | null = null;
  const top = (): HEl | undefined => stack[stack.length - 1];
  const append = (n: HNode): void => {
    const parent = top();
    if (!parent) {
      if (typeof n === "string") { if (n.trim()) refuse("text outside <html>"); return; }
      refuse("node outside <html>");
    }
    const last = parent.children[parent.children.length - 1];
    if (typeof n === "string" && typeof last === "string") parent.children[parent.children.length - 1] = last + n;
    else parent.children.push(n);
  };
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    const end = lt < 0 ? src.length : lt;
    if (end > i) {
      const raw = src.slice(i, end);
      i = end;
      // HTMLparser.c areBlanks decides between `characters` and `ignorableWhitespace`, but lxml's parser keeps
      // blanks (keepBlanks), so both add the text (measured: whitespace in <table> and <tr> is kept)
      if (/^[ \t\r\n]+$/.test(raw)) { if (top()) append(raw); }
      else {
        if (!top() || top()!.tag === "html" || top()!.tag === "head") refuse("character data outside the body (implied <p>)");
        append(decode(raw));
      }
      continue;
    }
    if (src.startsWith("<!--", lt)) {
      const close = src.indexOf("-->", lt + 4);
      if (close < 0) refuse("unclosed comment");
      if (top()) top()!.children.push({ comment: src.slice(lt + 4, close) });
      i = close + 3;
      continue;
    }
    if (src.startsWith("<!", lt) || src.startsWith("<?", lt)) refuse("declaration or processing instruction inside the document");
    const m = /^<(\/?)([A-Za-z][A-Za-z0-9]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/.exec(src.slice(lt, lt + 200000));
    if (!m) refuse(`tag at offset ${lt}`);
    i = lt + m[0].length;
    const tag = m[2]!.toLowerCase();
    if (m[1]) {
      if (VOID.has(tag)) refuse(`end tag </${tag}>`);
      if (top()?.tag !== tag) refuse(`end tag </${tag}> closing <${top()?.tag ?? "nothing"}>`);
      const el = stack.pop()!;
      if (el === root) break;
      continue;
    }
    const attrs: [string, string][] = [];
    const re = /([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'))?/g;
    let am: RegExpExecArray | null;
    while ((am = re.exec(m[3]!)) !== null) {
      const name = am[1]!.toLowerCase();
      if (am[2] === undefined || BOOLEAN.has(name)) refuse(`attribute ${name} without a value or boolean`);
      if (attrs.some(([n]) => n === name)) refuse(`duplicate attribute ${name}`);
      attrs.push([name, decode(am[2].slice(1, -1))]);
    }
    if (m[4] && !VOID.has(tag)) refuse(`self-closing <${tag}/>`);
    const parent = top();
    if (parent?.tag === "p" && CLOSES_P.has(tag)) refuse(`<${tag}> inside an open <p>`);
    if (parent && parent.tag === tag && ["li", "tr", "td", "th", "dt", "dd", "option"].includes(tag)) refuse(`<${tag}> inside <${tag}>`);
    if (parent && ["td", "th"].includes(tag) && ["td", "th"].includes(parent.tag)) refuse(`<${tag}> inside <${parent.tag}>`);
    const el: HEl = { tag, attrs, children: [] };
    if (!root) {
      if (tag !== "html") refuse(`document root <${tag}>`);
      root = el;
      stack.push(el);
      continue;
    }
    if (tag === "html" || tag === "head" && stack.length !== 1 || tag === "body" && stack.length !== 1) refuse(`<${tag}> in another place`);
    append(el);
    if (tag === "script" || tag === "style") {
      const close = src.slice(i).search(new RegExp(`</${tag}\\s*>`, "i"));
      if (close < 0) refuse(`unclosed <${tag}>`);
      if (close > 0) el.children.push(src.slice(i, i + close));
      i += close + src.slice(i + close).indexOf(">") + 1;
      continue;
    }
    if (!VOID.has(tag)) stack.push(el);
  }
  if (!root) refuse("no <html> element");
  if (stack.length && stack[0] === root && stack.length > 1) refuse("unclosed elements");
  return root;
}

function escText(s: string): string {
  if (s.includes("\r")) refuse("carriage return in text");
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** libxml2 xmlURIEscapeStr(value, "@/:=?;#%&,+<>"): other bytes outside the unreserved set as %XX. */
function uriEscape(v: string): string {
  let out = "";
  for (const b of Buffer.from(v.replace(/^[ \t\r\n]+/, ""), "utf8")) {
    const c = String.fromCharCode(b);
    if (b < 128 && /[A-Za-z0-9\-_.!~*'()@/:=?;#%&,+<>]/.test(c)) out += c;
    else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/** HTMLtree.c htmlAttrDumpOutput (xmlNodeListGetString escaping, then xmlBufWriteQuotedString). */
function attrText(tag: string, name: string, value: string): string {
  const uri = name === "href" || name === "action" || name === "src" || (name === "name" && tag === "a");
  let v = (uri ? uriEscape(value) : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (v.includes("\r") || v.includes("\n") && !uri) v = v.replace(/\r/g, "&#13;").replace(/\n/g, "&#10;");
  if (v.includes('"')) {
    if (!v.includes("'")) return `${name}='${v}'`;
    return `${name}="${v.replace(/"/g, "&quot;")}"`;
  }
  return `${name}="${v}"`;
}

/** `lxml.html.tostring(node, encoding='unicode')` without the tail (HTMLtree.c htmlNodeDumpFormatOutput, format 0). */
export function tostring(n: HNode, parentTag = ""): string {
  if (typeof n === "string") return parentTag === "script" || parentTag === "style" ? n : escText(n);
  if (!isEl(n)) {
    if (n.comment.includes("--")) refuse("comment with --");
    return `<!--${n.comment}-->`;
  }
  const attrs = n.attrs.map(([k, v]) => " " + attrText(n.tag, k, v)).join("");
  if (VOID.has(n.tag)) {
    if (n.children.length) refuse(`content in <${n.tag}>`);
    return `<${n.tag}${attrs}>`;
  }
  return `<${n.tag}${attrs}>${n.children.map((c) => tostring(c, n.tag)).join("")}</${n.tag}>`;
}

/** An element and its parent (its tail is the parent's next string). */
interface Located { el: HEl; parent: HEl }

function hasClass(el: HEl, klass: string): boolean {
  const c = el.attrs.find(([k]) => k === "class")?.[1];
  // XPath `contains(concat(' ', normalize-space(@class), ' '), ' x ')`
  return c !== undefined && ` ${c.replace(/[ \t\r\n]+/g, " ").trim()} `.includes(` ${klass} `);
}

function findAll(root: HEl, pred: (el: HEl) => boolean): Located[] {
  const out: Located[] = [];
  const walk = (el: HEl): void => {
    for (const c of el.children) {
      if (!isEl(c)) continue;
      if (pred(c)) out.push({ el: c, parent: el });
      walk(c);
    }
  };
  walk(root);
  return out;
}

/** `node.getparent().remove(node)` moves the node with its tail; the tail stays attached to the node. */
function detachWithTail(loc: Located): [HEl, string] {
  const idx = loc.parent.children.indexOf(loc.el);
  if (idx < 0) refuse("a header or footer moved twice");
  const next = loc.parent.children[idx + 1];
  const tail = typeof next === "string" ? next : "";
  loc.parent.children.splice(idx, tail ? 2 : 1);
  return [loc.el, tail];
}

export interface PdfHtmlParts {
  /** Each article as `lxml.html.tostring(node)` (with its tail), its `data-oe-lang`, model and id. */
  articles: { html: string; lang: string | null; model: string | null; id: string | null }[];
  /** The children of the body's parent when there is no article. */
  bodyFallback: string | null;
  /** `<div id="minimal_layout_report_headers">...</div>` and the footers alike. */
  header: string;
  footer: string;
  /** Each moved header and footer div alone (the minimal layout's `subst()` shows the one of the article's index). */
  headers: string[];
  footers: string[];
  /** The root's `data-report-*` attributes, in document order. */
  args: [string, string][];
}

/** The lxml part of `_prepare_wkhtmltopdf_html` (base_report_wkhtmltox ir_actions_report.py:171-221). */
export function splitReportHtml(html: string): PdfHtmlParts {
  const root = parseHtmlDocument(html);
  const mains = findAll(root, (el) => el.tag === "main");
  if (!mains.length) refuse("no <main>");
  let bodyParent = mains[0]!.el;
  const headerNode: HEl = { tag: "div", attrs: [["id", "minimal_layout_report_headers"]], children: [] };
  const footerNode: HEl = { tag: "div", attrs: [["id", "minimal_layout_report_footers"]], children: [] };
  const single: Record<string, string[]> = { header: [], footer: [] };
  for (const [klass, target] of [["header", headerNode], ["footer", footerNode]] as const) {
    for (const loc of findAll(root, (el) => el.tag === "div" && hasClass(el, klass))) {
      bodyParent = loc.parent;
      const [el, tail] = detachWithTail(loc);
      target.children.push(el);
      if (tail) target.children.push(tail);
      single[klass]!.push(tostring(el));
    }
  }
  const articles: PdfHtmlParts["articles"] = [];
  for (const loc of findAll(root, (el) => el.tag === "div" && hasClass(el, "article"))) {
    const idx = loc.parent.children.indexOf(loc.el);
    const next = loc.parent.children[idx + 1];
    const attr = (k: string): string | null => loc.el.attrs.find(([n]) => n === k)?.[1] ?? null;
    articles.push({ html: tostring(loc.el) + (typeof next === "string" ? escText(next) : ""), lang: attr("data-oe-lang"), model: attr("data-oe-model"), id: attr("data-oe-id") });
  }
  // `''.join(lxml.html.tostring(c) for c in body_parent.getchildren())`: the element and comment children with their tails
  let bodyFallback: string | null = null;
  if (!articles.length) {
    bodyFallback = "";
    bodyParent.children.forEach((c, k) => {
      if (typeof c === "string") return;
      const next = bodyParent.children[k + 1];
      bodyFallback += tostring(c) + (typeof next === "string" ? escText(next) : "");
    });
  }
  return {
    articles, bodyFallback,
    header: tostring(headerNode), footer: tostring(footerNode), headers: single["header"]!, footers: single["footer"]!,
    args: root.attrs.filter(([k]) => k.startsWith("data-report-")),
  };
}
