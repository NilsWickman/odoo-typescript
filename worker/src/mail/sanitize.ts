/**
 * `html_sanitize` of mail.message bodies (odoo/odoo/tools/mail.py:425 with the Html field defaults of
 * fields_textual.py:609-616: sanitize_tags, sanitize_attributes -> `safe_attrs`) for the inputs a chatter composer
 * sends: text with inline markup. `html_normalize` (:361) parses with libxml2, whose HTML parser puts a leading text
 * run and the inline content after it into an implied `<p>`; `fromstring` (:291) returns a single top element as is
 * and wraps several in a `<span>` (no block tag); `\xa0` is written `&nbsp;` (:419).
 *
 * Bodies with other tags go through the general `html_sanitize` port (src/orm/html_sanitize.ts). Within the inline grammar, anything else raises NotPorted (PORTING_odoo.md 12.1, 12.11): block tags, comments, styles,
 * images, unknown entities, scripts, `javascript:` links, quote or signature markers (`tag_quote`, :178-275).
 * Checked against Odoo's own sanitizer (src/mail/write.test.ts cases come from it).
 */
import { NotPorted } from '../errors';
import { htmlSanitize, type SanitizeOptions } from '../orm/html_sanitize';

const INLINE = new Set(['a', 'b', 'i', 'u', 'em', 'strong', 's', 'code', 'span', 'br']);
const KEEP = new Set(['href', 'class', 'target', 'title', 'rel', 'data-oe-id', 'data-oe-model']);
/** Odoo's `safe_attrs` (tools/mail.py: lxml defs.safe_attrs + Odoo's data attributes): kept when present. */
const SAFE = new Set(['abbr', 'accept', 'accept-charset', 'accesskey', 'action', 'align', 'alt', 'axis', 'border', 'cellpadding', 'cellspacing', 'char', 'charoff', 'charset', 'checked', 'cite', 'class', 'clear', 'color', 'cols', 'colspan', 'compact', 'coords', 'datetime', 'dir', 'disabled', 'enctype', 'for', 'frame', 'headers', 'height', 'href', 'hreflang', 'hspace', 'id', 'ismap', 'label', 'lang', 'longdesc', 'maxlength', 'media', 'method', 'multiple', 'name', 'nohref', 'noshade', 'nowrap', 'prompt', 'readonly', 'rel', 'rev', 'rows', 'rowspan', 'rules', 'scope', 'selected', 'shape', 'size', 'span', 'src', 'start', 'style', 'summary', 'tabindex', 'target', 'title', 'type', 'usemap', 'valign', 'value', 'vspace', 'width']);

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);?/g, (m, e: string) => {
    if (!m.endsWith(';')) throw new NotPorted('html entity without semicolon');
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
    const v = ENTITIES[e];
    if (v === undefined) throw new NotPorted(`html entity &${e};`);
    return v;
  });
}

const escText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');

type Node = { kind: 'text'; text: string } | { kind: 'el'; html: string; block: false };

/** mail_message.py:175 `body = fields.Html(sanitize_style=True)`: the field's `sanitize_vals` (fields_textual.py:609-640). */
const BODY_OPTIONS: SanitizeOptions = { sanitizeTags: true, sanitizeAttributes: true, sanitizeStyle: true, sanitizeForm: true, stripStyle: false, stripClasses: false };

/** A body through the general sanitizer only (generated html with attributes the inline path refuses: OdooBot's icons). */
export function sanitizeBodyFull(src: string): string {
  return src === '' ? '' : htmlSanitize(src, BODY_OPTIONS);
}

/** The stored body of a composer body, or NotPorted. A body with block markup (`<p>`, lists, ...) goes through the
 *  general sanitizer (src/orm/html_sanitize.ts), which refuses what it does not reproduce. */
export function sanitizeBody(src: string): string {
  if (src === '') return '';
  for (const m of src.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)) {
    if (!INLINE.has(m[1]!.toLowerCase())) return htmlSanitize(src, BODY_OPTIONS);
  }
  if (/<!--|<!|<\?/.test(src)) throw new NotPorted('html comments or declarations in a message body');
  if (/--|\n>|^>/.test(src.replace(/<[^>]*>/g, ''))) throw new NotPorted('quote or signature markers (tag_quote)');
  // tokens: text, <tag attrs>, </tag>; an attribute value quoted or not (libxml2 reads `href=#` to the next space or `>`:
  // `_get_html_link`'s `<a href=# data-oe-model='...'>`)
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>|([^<]+)|(<)/g;
  const top: Node[] = [];
  const stack: { tag: string; parts: string[] }[] = [];
  const emit = (s: string): void => { if (stack.length) stack[stack.length - 1]!.parts.push(s); };
  for (const m of src.matchAll(re)) {
    if (m[4] !== undefined || m[3] !== undefined) {
      // libxml2 keeps a `<` that cannot start a tag as text
      if (m[4] !== undefined && /^<[a-zA-Z/!?]/.test(src.slice(m.index))) throw new NotPorted('malformed tag in a message body');
      const text = m[4] !== undefined ? '<' : decodeEntities(m[3]!);
      if (stack.length) emit(escText(text)); else top.push({ kind: 'text', text });
      continue;
    }
    const tag = m[1]!.toLowerCase();
    if (!INLINE.has(tag)) throw new NotPorted(`<${tag}> in a message body`);
    if (tag === 'a' && !m[0].startsWith('</') && stack.some(e => e.tag === 'a')) throw new NotPorted('nested links (the HTML parser closes the outer one)');
    const closing = m[0].startsWith('</');
    if (closing) {
      const open = stack.pop();
      if (!open || open.tag !== tag) throw new NotPorted('unbalanced html in a message body');
      const html = `${open.parts[0]}${open.parts.slice(1).join('')}</${tag}>`;
      if (stack.length) emit(html); else top.push({ kind: 'el', html, block: false });
      continue;
    }
    let attrs = '';
    for (const a of (m[2] ?? '').matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      const name = a[1]!.toLowerCase();
      const value = a[2] === undefined ? '' : decodeEntities(a[3] ?? a[4] ?? a[5] ?? '');
      if (!SAFE.has(name) && !name.startsWith('data-')) continue; // the Cleaner drops attributes outside safe_attrs
      if (!KEEP.has(name)) throw new NotPorted(`attribute ${name} in a message body`);
      if (/[<>&"]/.test(value)) throw new NotPorted('attribute values with <, >, & or quotes');
      if (name === 'href' && !/^(https?:\/\/|mailto:|\/|#)/i.test(value) && /:/.test(value)) throw new NotPorted(`link scheme of ${value}`);
      if (name === 'class' && /gmail|signature|SkyDrive|yahoo|stopSpelling/i.test(value)) throw new NotPorted('quote marker classes');
      attrs += ` ${name}="${value}"`;
    }
    const start = `<${tag}${attrs}>`;
    if (tag === 'br') { if (stack.length) emit(start); else top.push({ kind: 'el', html: start, block: false }); continue; }
    if (m[0].endsWith('/>')) throw new NotPorted('self-closing non-void tag');
    stack.push({ tag, parts: [start] });
  }
  if (stack.length) throw new NotPorted('unclosed html in a message body');
  // libxml2 skips leading whitespace at the start of the body
  while (top.length && top[0]!.kind === 'text') {
    const t = (top[0] as { text: string }).text.replace(/^[ \t\n\r\f]+/, '');
    if (t) { (top[0] as { text: string }).text = t; break; }
    top.shift();
  }
  if (!top.length) throw new NotPorted('whitespace-only message body');
  const out = top.map(n => n.kind === 'text' ? escText(n.text) : n.html).join('');
  if (top[0]!.kind === 'text') return `<p>${out}</p>`; // implied paragraph around inline content
  const last = top[top.length - 1]!;
  if (top.length === 1) return out;
  if (top.length === 2 && last.kind === 'text' && !last.text.trim()) throw new NotPorted('single element followed by whitespace');
  return `<span>${out}</span>`;
}
