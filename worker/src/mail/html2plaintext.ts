/**
 * `tools.mail.html2plaintext(html)` (odoo/odoo/tools/mail.py:610-690) with `body_id=None` and `include_references=True`:
 * libxml2's HTML parse (the subset of `src/orm/html_sanitize.ts parseHtmlBody`, other input refuses), the links and
 * images turned into numbered spans, lxml's XML serialisation of <body>, then the string replacements, the stripped
 * lines and the reference list, with Python's `str.splitlines` and `str.strip`.
 */
import { NotPorted } from "../errors";
import { parseHtmlBody, type HtmlElement, type HtmlNode } from "../orm/html_sanitize";

/** Python's `str.isspace` characters (`strip()` without argument). */
const PY_WS = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");
/** Python's `str.splitlines` boundaries. */
const LINE_BOUNDARY = /\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/;

export const pyStrip = (s: string): string => s.replace(STRIP, "");

/** `str.splitlines()`: a final boundary does not start an empty line. */
export function pySplitlines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split(new RegExp(LINE_BOUNDARY.source, "g"));
  if (LINE_BOUNDARY.test(s.slice(-1)) && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** `str.replace(old, new)`: non-overlapping, left to right. */
const replaceAll = (s: string, from: string, to: string): string => s.split(from).join(to);

function* iterElements(nodes: readonly HtmlNode[]): Generator<HtmlElement> {
  for (const n of nodes) {
    if (typeof n === "string") continue;
    yield n;
    yield* iterElements(n.children);
  }
}

const attr = (el: HtmlElement, name: string): string | undefined => el.attrs.find(([k]) => k === name)?.[1];

/** `element.text = value`: the text before the first child element. */
function setText(el: HtmlElement, value: string): void {
  if (typeof el.children[0] === "string") el.children[0] = value;
  else el.children.unshift(value);
}

const escText = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string): string => escText(s).replace(/"/g, "&quot;").replace(/\n/g, "&#10;").replace(/\r/g, "&#13;").replace(/\t/g, "&#9;");

/** `etree.tostring(el, encoding="unicode")` (the xml method: empty elements self-close; `\r` in text is `&#13;`). */
function serialize(n: HtmlNode): string {
  if (typeof n === "string") return escText(n).replace(/\r/g, "&#13;");
  const attrs = n.attrs.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join("");
  if (!n.children.length) return `<${n.tag}${attrs}/>`;
  return `<${n.tag}${attrs}>${n.children.map(serialize).join("")}</${n.tag}>`;
}

export function html2plaintext(html: string | false | null | undefined): string {
  if (!html || !pyStrip(html)) return "";
  if (/[\u2028\u2029]/.test(html)) throw new NotPorted("html2plaintext of text with U+2028/U+2029 (regex '.' differs)");
  const body: HtmlElement = { tag: "body", attrs: [], children: parseHtmlBody(html) };
  const urls: string[] = [];
  let ref = 0;
  // :644-659 `tree.findall('.//a')`, then `.//img`, in document order; an empty href or src is skipped
  for (const link of [...iterElements(body.children)].filter((e) => e.tag === "a")) {
    const url = attr(link, "href");
    if (!url) continue;
    link.tag = "span";
    const text = typeof link.children[0] === "string" ? link.children[0] : "None";
    setText(link, `${text} [${++ref}]`);
    urls.push(url);
  }
  for (const img of [...iterElements(body.children)].filter((e) => e.tag === "img")) {
    const src = attr(img, "src");
    if (!src) continue;
    img.tag = "span";
    // `re.search(r'[^/]+(?=\.[a-zA-Z]+(?:\?|$))', src)`, none for a data: url
    const name = src.startsWith("data:") ? null : /[^/]+(?=\.[a-zA-Z]+(?:\?|$))/.exec(src);
    setText(img, `${name ? name[0] : "Image"} [${++ref}]`);
    urls.push(src);
  }
  let s = serialize(body);
  s = replaceAll(s, "&#13;", "");
  for (const [from, to] of [["<strong>", "*"], ["</strong>", "*"], ["<b>", "*"], ["</b>", "*"], ["<h3>", "*"], ["</h3>", "*"],
    ["<h2>", "**"], ["</h2>", "**"], ["<h1>", "**"], ["</h1>", "**"], ["<em>", "/"], ["</em>", "/"], ["<tr>", "\n"], ["</p>", "\n"]] as const) {
    s = replaceAll(s, from, to);
  }
  s = s.replace(/<br\s*\/?>/g, "\n");
  s = s.replace(/<[^\n]*?>/g, " "); // Python's '.' is anything but '\n'
  s = replaceAll(s, "  ", " ");
  s = replaceAll(s, "&gt;", ">");
  s = replaceAll(s, "&lt;", "<");
  s = replaceAll(s, "&amp;", "&");
  s = replaceAll(s, "&nbsp;", " ");
  s = pySplitlines(s).map(pyStrip).join("\n");
  s = replaceAll(s, "\n\n", "\n");
  if (urls.length) {
    s += "\n\n";
    urls.forEach((u, i) => { s += `[${i + 1}] ${u}\n`; });
  }
  return pyStrip(s);
}
