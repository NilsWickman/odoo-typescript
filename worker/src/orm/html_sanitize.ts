/**
 * `html_sanitize` (odoo/odoo/tools/mail.py:425) = `html_normalize` (:361: libxml2's HTML parser through
 * lxml `fromstring` :291, quote detection `tag_quote` :178, serialisation) + lxml_html_clean's `Cleaner`
 * (lxml_html_clean/clean.py:305 `__call__`) with Odoo's `_Cleaner` (:99) options.
 *
 * libxml2's HTML parser repairs any tag soup; this port parses a well-formed subset exactly and refuses
 * (NotPorted) every input whose repair it does not reproduce: unknown tags, mismatched end tags (other than closing
 * inline elements or `p`/`li` implicitly; an end tag of no open element is ignored, as libxml2 does), block elements
 * opened inside inline ones, comments, doctypes, unknown entities. `tag_quote` (the quote and signature markers) is
 * ported. The behaviours were checked
 * against the reference Python (lxml 5.2.1, libxml2) with worker/src/orm/html_sanitize.test.ts.
 */
import { NotPorted } from "../errors";

export interface SanitizeOptions {
  readonly sanitizeTags: boolean;
  readonly sanitizeAttributes: boolean;
  readonly sanitizeStyle: boolean;
  readonly sanitizeForm: boolean;
  readonly stripStyle: boolean;
  readonly stripClasses: boolean;
  /** `sanitize_output_method='xml'` (sanitize='email_outgoing', fields_textual.py:628): lxml's xml serialisation. */
  readonly xmlOutput?: boolean;
}

interface El { tag: string; attrs: [string, string][]; children: Node[] }
type Node = El | string;

/** lxml.html.defs.tags + mail.py:92 semantic tags. */
const KNOWN = new Set(("a abbr acronym address applet area article aside audio b base basefont bdo big blink blockquote body br button "
  + "canvas caption center cite code col colgroup command datalist dd del details dfn dir div dl dt em embed fieldset figcaption "
  + "figure font footer form frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins isindex kbd keygen label "
  + "legend li link map mark marquee math menu meta meter nav noscript object ol optgroup option output p param pre progress q rp rt "
  + "ruby s samp script section select small source span strike strong style sub summary sup svg table tbody td textarea tfoot th "
  + "thead time title tr track tt u ul var video wbr bdi main").split(" "));
/** mail.py:103-122 `_Cleaner._style_whitelist`. */
const STYLE_WHITELIST = new Set([
  "font-size", "font-family", "font-weight", "font-style", "background-color", "color", "text-align",
  "line-height", "letter-spacing", "text-transform", "text-decoration", "opacity",
  "float", "vertical-align", "display", "object-fit", "direction",
  "padding", "padding-top", "padding-left", "padding-bottom", "padding-right",
  "margin", "margin-top", "margin-left", "margin-bottom", "margin-right",
  "white-space",
  "background-image", "background-position", "background-size", "background-repeat", "background-origin",
  "border", "border-color", "border-radius", "border-style", "border-width", "border-top", "border-bottom",
  "height", "width", "max-width", "min-width", "min-height",
  "border-collapse", "border-spacing", "caption-side", "empty-cells", "table-layout",
  ...["top", "bottom", "left", "right"].flatMap((p) => ["style", "color", "width", "left-radius", "right-radius"].map((a) => `border-${p}-${a}`)),
]);
/** lxml.html.defs.empty_tags. */
const VOID = new Set("area base basefont br col frame hr img input isindex link meta param source track wbr".split(" "));
/** lxml.html.defs.block_tags (`_contains_block_level_tag`). */
const BLOCK = new Set(("address blockquote caption center col colgroup dd del dir div dl dt fieldset form h1 h2 h3 h4 h5 h6 hr ins "
  + "isindex legend li menu noscript ol optgroup option p pre table tbody td tfoot th thead tr ul").split(" "));
/** Start tags that close an open `p` (checked: ul div table h1 blockquote pre hr p). */
const CLOSES_P = new Set("address blockquote center dir div dl fieldset form h1 h2 h3 h4 h5 h6 hr menu ol p pre table ul".split(" "));
/** Elements whose content model the subset parser accepts nesting blocks in. */
const INLINE = new Set(("a abbr acronym b bdi bdo big cite code dfn em font i kbd label mark q s samp small span strike strong "
  + "sub sup tt u var time").split(" "));

/** mail.py:68-86 safe_attrs (lxml defs.safe_attrs + Odoo's). */
const SAFE_ATTRS = new Set([...("abbr accept accept-charset accesskey action align alt axis border cellpadding cellspacing char charoff charset "
  + "checked cite class clear color cols colspan compact coords data-ai-field data-ai-record-id data-attachment-id data-behavior-props "
  + "data-bs-toggle data-class data-embedded data-embedded-editable data-embedded-props data-file-name data-format-mimetype "
  + "data-gl-filter data-heading-link-id data-height data-icon data-id data-interval data-language-id data-last-history-commits "
  + "data-member_id data-mimetype data-mimetype-before-conversion data-o-datetime data-o-mail-full-composer data-o-mail-quote "
  + "data-o-mail-quote-node data-oe-aria-label data-oe-expression data-oe-field data-oe-id data-oe-model data-oe-nodeid "
  + "data-oe-protected data-oe-role data-oe-transient-content data-oe-translation-source-sha data-oe-type data-oe-version "
  + "data-original-id data-original-mimetype data-original-src data-prop-name data-publish data-quality data-res_id "
  + "data-resize-width data-scale-x data-scale-y data-scroll-background-ratio data-shape data-shape-colors data-view-id "
  + "data-width data-x data-y datetime dir disabled enctype for frame headers height href hreflang hspace id ismap label lang "
  + "longdesc maxlength media method multiple name nohref noshade nowrap prompt readonly rel rev rows rowspan rules scope "
  + "selected shape size span src start style summary tabindex target title type usemap valign value vspace width").split(" "),
  // odoo/_monkeypatches/lxml.py:7-36: the ARIA attributes and `role` added to lxml's safe_attrs (lxml < 6.1.0) before
  // tools/mail.py builds its own
  ...("aria-activedescendant aria-atomic aria-autocomplete aria-braillelabel aria-brailleroledescription aria-busy aria-checked "
  + "aria-colcount aria-colindex aria-colindextext aria-colspan aria-controls aria-current aria-describedby aria-description "
  + "aria-details aria-disabled aria-dropeffect aria-errormessage aria-expanded aria-flowto aria-grabbed aria-haspopup aria-hidden "
  + "aria-invalid aria-keyshortcuts aria-label aria-labelledby aria-level aria-live aria-modal aria-multiline aria-multiselectable "
  + "aria-orientation aria-owns aria-placeholder aria-posinset aria-pressed aria-readonly aria-relevant aria-required "
  + "aria-roledescription aria-rowcount aria-rowindex aria-rowindextext aria-rowspan aria-selected aria-setsize aria-sort "
  + "aria-valuemax aria-valuemin aria-valuenow aria-valuetext role tabindex").split(" ")]);
/** lxml.html.defs.link_attrs (+ xlink:href, mail.py:88). */
const LINK_ATTRS = new Set("action archive background cite classid codebase data href longdesc profile src usemap dynsrc lowsrc xlink:href".split(" "));
/** libxml2 htmlAttrDumpOutput: attributes serialised through xmlURIEscapeStr. */
const URI_ATTRS = new Set(["href", "action", "src"]);

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

function refuse(what: string): never {
  throw new NotPorted(`html_sanitize: ${what}`);
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);?/g, (m, body: string) => {
    if (!m.endsWith(";")) {
      if (body.startsWith("#") || body in ENTITIES) refuse(`entity without ';' (${m})`);
      return m;
    }
    if (body.startsWith("#x") || body.startsWith("#")) {
      const cp = body.startsWith("#x") ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isInteger(cp) || cp < 0 || cp > 0x10FFFF) return "\uFFFD";
      return String.fromCodePoint(cp);
    }
    const v = ENTITIES[body];
    if (v === undefined) refuse(`entity &${body};`);
    return v;
  });
}

/**
 * libxml2 HTML parser over the subset, as lxml `document_fromstring`: the children of <body>. `qweb`: a `<t>` element
 * is parsed (libxml2 keeps an unknown tag as an element that auto-closes nothing and is closed by nothing but its own
 * end tag or an enclosing one), for the cleaner without sanitize_tags, which keeps it (sanitize='email_outgoing': a mail
 * template's qweb body, lunch's lunch_order_mail_supplier).
 */
function parse(src: string, qweb = false): Node[] {
  const root: Node[] = [];
  const stack: El[] = [];
  let started = false;
  const add = (n: Node): void => {
    const list = stack.length ? stack[stack.length - 1]!.children : root;
    if (typeof n === "string" && typeof list[list.length - 1] === "string") list[list.length - 1] += n;
    else list.push(n);
  };
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    const next = lt < 0 ? src.length : lt;
    // a '<' not starting a tag is character data (libxml2 htmlParseCharData)
    if (lt >= 0 && !/^<(\/?[A-Za-z]|!|\?)/.test(src.slice(lt, lt + 3))) {
      const text = src.slice(i, lt + 1);
      i = lt + 1;
      handleText(text);
      continue;
    }
    if (next > i) handleText(src.slice(i, next));
    if (lt < 0) break;
    if (src.startsWith("<!--", lt) && !started) {
      // a comment before the body's content: libxml2 places it outside <body>, so the sanitized fragment drops it
      // (mail.py html_normalize; lunch's act_window help `<!-- TODO: better help message -->`). Only a well-formed
      // comment (no `--` inside, not `<!-->` or `<!--->`, not ending in `-`); a comment inside the content refuses.
      const end = src.indexOf("-->", lt + 4);
      const body = end < 0 ? "" : src.slice(lt + 4, end);
      if (end < 0 || body.startsWith(">") || body.startsWith("->") || body.includes("--") || body.endsWith("-")) refuse("comment of an unusual form");
      i = end + 3;
      continue;
    }
    if (src.startsWith("<!", lt) || src.startsWith("<?", lt)) refuse("comment, doctype or processing instruction");
    const m = /^<(\/?)([A-Za-z][A-Za-z0-9]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/.exec(src.slice(lt));
    if (!m) refuse(`tag at ${lt}`);
    i = lt + m[0].length;
    const tag = m[2]!.toLowerCase();
    if (!KNOWN.has(tag) && !(qweb && tag === "t")) refuse(`unknown tag <${tag}>`);
    if (m[1]) {
      endTag(tag);
      continue;
    }
    const attrs: [string, string][] = [];
    const re = /([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
    let am: RegExpExecArray | null;
    while ((am = re.exec(m[3]!)) !== null) {
      if (am[2] === undefined) refuse(`attribute without value (${am[1]})`);
      const raw = am[2].startsWith('"') || am[2].startsWith("'") ? am[2].slice(1, -1) : am[2];
      const name = am[1]!.toLowerCase();
      if (attrs.some(([n]) => n === name)) refuse(`duplicate attribute ${name}`);
      attrs.push([name, decodeEntities(raw)]);
    }
    if (m[4] && !VOID.has(tag)) {
      // libxml2's HTML parser ends an element written `<tag .../>` at once (htmlParseElementInternal, the "XML/SGML way"
      // empty element): measured on Odoo for OdooBot's `<i class='oi' .../>` icons (mail_bot.py:52-54), kept as
      // `<i ...></i>`; for inline tags only, the others refuse
      if (!INLINE.has(tag)) refuse(`self-closing <${tag}/>`);
      startTag(tag, attrs);
      const top = stack[stack.length - 1];
      if (top?.tag === tag) stack.pop();
      continue;
    }
    if (tag === "script" || tag === "style") {
      // raw text up to the end tag (libxml2 htmlParseScript)
      const end = src.slice(i).search(new RegExp(`</${tag}\\s*>`, "i"));
      if (end < 0) refuse(`unclosed <${tag}>`);
      started = true;
      add({ tag, attrs, children: [src.slice(i, i + end)] });
      i += end + src.slice(i + end).indexOf(">") + 1;
      continue;
    }
    startTag(tag, attrs);
  }
  return root;

  function handleText(raw: string): void {
    let text = decodeEntities(raw);
    if (!started) {
      // libxml2 skips blanks before the body content, then wraps leading character data in an implied <p>
      text = text.replace(/^[ \t\r\n]+/, "");
      if (!text) return;
      started = true;
      const p: El = { tag: "p", attrs: [], children: [] };
      root.push(p);
      stack.push(p);
    }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) refuse("control characters");
    add(text);
  }

  function startTag(tag: string, attrs: [string, string][]): void {
    started = true;
    if (["html", "head", "body", "frameset", "title", "meta", "link", "base", "noscript", "textarea", "select", "option", "optgroup", "math", "svg", "applet", "object", "embed", "param", "iframe", "button", "input", "form", "keygen"].includes(tag)) {
      refuse(`<${tag}> (parser special case)`);
    }
    const top = stack[stack.length - 1];
    if (top?.tag === "p" && CLOSES_P.has(tag)) stack.pop();
    else if (top?.tag === "li" && tag === "li") stack.pop();
    else if (top?.tag === "p" && BLOCK.has(tag)) refuse(`<${tag}> inside <p>`);
    if (BLOCK.has(tag)) {
      // libxml2's auto-close of an open inline element by a block start tag, as lxml shows it through html_sanitize
      // (2026-11-04, also with a <p> further up): div, h1, ul and pre close none; p closes b, i, u, small and keeps
      // span, a, strong, em, font, label, code; table closes a. Untested pairs refuse.
      for (const e of stack) {
        // an open <p> below an inline element stays open (lxml: <p>q<span>t<div>x</div></span></p> is kept)
        if (!INLINE.has(e.tag)) continue;
        if (["div", "h1", "ul", "pre"].includes(tag) && INLINE.has(e.tag)) continue;
        if (tag === "p" && ["span", "a", "strong", "em", "font", "label", "code"].includes(e.tag)) continue;
        if (tag === "table" && ["b", "span", "strong", "i", "em", "font", "u", "small", "label", "code"].includes(e.tag)) continue;
        refuse(`block <${tag}> inside <${e.tag}>`);
      }
    }
    if (["li", "dd", "dt", "td", "th", "tr", "tbody", "thead", "tfoot", "caption", "col", "colgroup", "legend"].includes(tag)) {
      const parent = stack[stack.length - 1]?.tag;
      const ok: Record<string, readonly string[]> = {
        li: ["ul", "ol", "menu", "dir"], dd: ["dl"], dt: ["dl"], td: ["tr"], th: ["tr"], tr: ["table", "tbody", "thead", "tfoot"],
        tbody: ["table"], thead: ["table"], tfoot: ["table"], caption: ["table"], col: ["table", "colgroup"], colgroup: ["table"], legend: ["fieldset"],
      };
      if (!parent || !ok[tag]!.includes(parent)) refuse(`<${tag}> outside its parent`);
    }
    const el: El = { tag, attrs, children: [] };
    add(el);
    if (!VOID.has(tag)) stack.push(el);
  }

  function endTag(tag: string): void {
    if (VOID.has(tag)) refuse(`end tag </${tag}>`);
    if (tag === "html" || tag === "body" || tag === "head") refuse(`end tag </${tag}>`);
    const idx = stack.map((e) => e.tag).lastIndexOf(tag);
    // libxml2 htmlParseEndTag: an end tag of no open element is an error and ignored ("Unexpected end tag"; checked:
    // </p>, </div>, </span>, </b>, </li> in a div, a p, a span and at the top level, 2026-11-07)
    if (idx < 0) return;
    // closing inline elements (and an implied p/li) on the way is what libxml2 does (checked: <p>a<b>b</p>)
    for (const e of stack.slice(idx + 1)) if (!INLINE.has(e.tag) && e.tag !== "p" && e.tag !== "li") refuse(`</${tag}> closing <${e.tag}>`);
    stack.length = idx;
  }
}

/** Python's `\s` for str patterns (sre: str.isspace), which JavaScript's `\s` differs from (\x1c-\x1f, \x85, \ufeff). */
const PY_WS = "[ \\t\\n\\r\\f\\v\\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
/** mail.py:259 signature_begin `((?:(?:^|\n)[-]{2}[\s]?$))`: Python's `$` also matches before a final newline. */
const SIGNATURE_BEGIN = new RegExp(`(?:^|\\n)-{2}${PY_WS}?(?=\\n?$)`);
/** mail.py:267 text_complete_regex. */
const TEXT_COMPLETE = new RegExp(`(?:\\n>+[^\\n\\r]*)+|(?:(?:^|\\n)-{2}${PY_WS}?[\\r\\n]{1,2}[\\s\\S]+)`, "g");

/**
 * mail.py:178-288 `tag_quote`, run by html_normalize (:398-399) on every element of the parsed document in document
 * order (`doc.iter()`, which also visits the spans it inserts). `hidden` is the parent lxml keeps for the document
 * element (the <body> of a single element, the <html> of the wrapper): attributes set on it are not serialised.
 */
function tagQuote(doc: El, hidden: El): void {
  const parent = new Map<El, El>([[doc, hidden]]);
  const elems = (el: El): El[] => el.children.filter((c): c is El => typeof c !== "string");
  const get = (el: El, name: string): string | undefined => el.attrs.find(([n]) => n === name)?.[1];
  const set = (el: El, name: string, value: string): void => {
    const a = el.attrs.find(([n]) => n === name);
    if (a) a[1] = value; else el.attrs.push([name, value]); // lxml appends a new attribute
  };
  const textOf = (el: El): string => (typeof el.children[0] === "string" ? el.children[0] : "");
  const textContent = (el: El): string => el.children.map((c) => (typeof c === "string" ? c : textContent(c))).join("");
  const previous = (el: El): El | null => {
    const sib = elems(parent.get(el)!);
    const i = sib.indexOf(el);
    return i > 0 ? sib[i - 1]! : null;
  };
  const quote = (el: El): void => {
    const p = parent.get(el)!;
    const cls = get(el, "class") ?? "";
    const id = get(el, "id") ?? "";
    // :213-226 gmail, outlook, msoffice and yahoo markers
    if (cls.includes("gmail_extra") || cls.includes("SkyDrivePlaceholder")) { set(el, "data-o-mail-quote", "1"); set(p, "data-o-mail-quote-container", "1"); }
    if ((el.tag === "hr" && (cls.includes("stopSpelling") || id.includes("stopSpelling"))) || cls.includes("yahoo_quoted")) {
      set(el, "data-o-mail-quote", "1");
      const sib = elems(p);
      for (const s of sib.slice(sib.indexOf(el) + 1)) set(s, "data-o-mail-quote", "1");
    }
    // :229-256 signature wrappers, reply quotes, outlook auto messages
    const signatureWrapper = cls.includes("odoo_signature_wrapper") || cls.includes("gmail_signature") || id === "Signature" || Boolean(get(el, "data-smartmail"));
    const outlookAuto = id.includes("appendonsend");
    const outlookReply = id.includes("divRplyFwdMsg");
    if (signatureWrapper || cls.includes("gmail_quote") || outlookReply) { set(el, "data-o-mail-quote-container", "1"); set(el, "data-o-mail-quote", "1"); }
    if (outlookReply) {
      const sib = elems(p);
      const i = sib.indexOf(el);
      if (i > 0 && sib[i - 1]!.tag === "hr") set(sib[i - 1]!, "data-o-mail-quote", "1");
      if (i + 1 < sib.length) { set(sib[i + 1]!, "data-o-mail-quote-container", "1"); set(sib[i + 1]!, "data-o-mail-quote", "1"); }
    }
    if (outlookAuto && !textOf(el).trim()) { set(el, "data-o-mail-quote-container", "1"); set(el, "data-o-mail-quote", "1"); }
    // :258-264 html signature (-- <br />blah)
    if (textOf(el) && elems(el).some((c) => c.tag === "br") && SIGNATURE_BEGIN.test(textOf(el))) {
      set(el, "data-o-mail-quote", "1");
      set(p, "data-o-mail-quote-container", "1");
    }
    // :266-269 `_tag_matching_regex_in_text`: the text-based quotes of el.text in spans
    if (!get(el, "data-o-mail-quote")) {
      const text = textOf(el);
      const parts: Node[] = [];
      let idx = 0;
      for (const m of text.matchAll(TEXT_COMPLETE)) {
        if (m.index! > idx) parts.push(text.slice(idx, m.index!));
        parts.push({ tag: "span", attrs: [["data-o-mail-quote", "1"]], children: [m[0]] });
        idx = m.index! + m[0].length;
      }
      if (parts.length) {
        if (idx < text.length) parts.push(text.slice(idx));
        el.children.splice(0, 1, ...parts);
      }
    }
    // :271-274 blockquote
    if (el.tag === "blockquote") { set(el, "data-o-mail-quote-node", "1"); set(el, "data-o-mail-quote", "1"); }
    // :275-286 quoted parent, or a container whose first quoted child comes before this one
    if (!get(p, "data-o-mail-quote-node")) {
      if (get(p, "data-o-mail-quote")) set(el, "data-o-mail-quote", "1");
      else if (get(p, "data-o-mail-quote-container")) {
        const sib = elems(p);
        const first = sib.findIndex((s) => get(s, "data-o-mail-quote") !== undefined);
        if (first >= 0 && first < sib.indexOf(el)) set(el, "data-o-mail-quote", "1");
      }
    }
    // :287-288 an empty element after a quoted one
    const prev = previous(el);
    if (prev && get(prev, "data-o-mail-quote") && !textContent(el).trim()) set(el, "data-o-mail-quote", "1");
  };
  const visit = (el: El): void => {
    quote(el);
    for (const c of elems(el)) { parent.set(c, el); visit(c); }
  };
  visit(doc);
}

/** urllib.parse.unquote_plus. */
function unquotePlus(s: string): string {
  const bytes: number[] = [];
  const str = s.replace(/\+/g, " ");
  for (let i = 0; i < str.length; i++) {
    if (str[i] === "%" && /^[0-9a-fA-F]{2}$/.test(str.slice(i + 1, i + 3))) { bytes.push(parseInt(str.slice(i + 1, i + 3), 16)); i += 2; }
    else for (const b of Buffer.from(str[i]!, "utf8")) bytes.push(b);
  }
  return Buffer.from(bytes).toString("utf8");
}

/** clean.py:66 _has_javascript_scheme. */
function hasJavascriptScheme(s: string): boolean {
  let safe = 0;
  for (const m of s.matchAll(/data:image\/(.+?);base64,/gi)) {
    if (/(xml|svg)/i.test(m[1]!)) return true;
    safe++;
  }
  return (s.match(/(javascript|jscript|livescript|vbscript|data|about|mocha):/gi) ?? []).length > safe;
}

/** clean.py:576 _remove_javascript_link. */
function removeJavascriptLink(link: string): string {
  const s = unquotePlus(link).replace(/[\s\x00-\x08\x0B\x0C\x0E-\x19]+/g, "");
  return hasJavascriptScheme(s) ? "" : link;
}

const KILL_ALWAYS = ["base", "embed", "frame", "head", "iframe", "link", "meta", "noscript", "object", "script", "style", "title", "applet", "frameset"];
const REMOVE_ALWAYS = ["html", "body", "head", "title", "blink", "marquee", "iframe", "embed", "layer", "object", "param"];

/** mail.py:99 _Cleaner with the html_sanitize kwargs (mail.py:431-470) over lxml_html_clean clean.py:305. */
function clean(root: El, o: SanitizeOptions): El {
  const kill = new Set<string>(["script", "link", "meta", "applet", "frameset", "frame", "iframe"]);
  const remove = new Set<string>(["head", "html", "title", "iframe", "embed", "layer", "object", "param", "blink", "marquee"]);
  if (o.sanitizeTags) { for (const t of KILL_ALWAYS) kill.add(t); for (const t of REMOVE_ALWAYS) remove.add(t); }
  if (o.stripStyle) kill.add("style");
  if (o.sanitizeForm) { remove.add("form"); for (const t of ["button", "input", "select", "textarea"]) kill.add(t); }
  kill.add("base");
  const attrsOk = (name: string): boolean => o.sanitizeAttributes ? (SAFE_ATTRS.has(name) && !(o.stripClasses && name === "class")) : !name.startsWith("on");
  const walk = (el: El): void => {
    el.attrs = el.attrs.filter(([n]) => attrsOk(n));
    if (o.stripStyle) el.attrs = el.attrs.filter(([n]) => n !== "style");
    for (const a of el.attrs) {
      if (LINK_ATTRS.has(a[0])) {
        // lxml rewrite_links: the stripped link through _remove_javascript_link, written back when it differs
        const stripped = a[1].replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
        const nv = removeJavascriptLink(stripped);
        if (nv !== a[1]) a[1] = nv;
      }
      if (a[0] === "style") {
        if (/url\s*\(|expression|@|\\|\/\*|</i.test(a[1])) refuse(`style attribute ${JSON.stringify(a[1].slice(0, 40))}`);
        if (hasJavascriptScheme(a[1].replace(/[\s\x00-\x08\x0B\x0C\x0E-\x19]+/g, "").toLowerCase())) el.attrs = el.attrs.filter(([n]) => n !== "style");
      }
    }
    if (o.sanitizeStyle && !o.stripStyle) {
      // mail.py:145-157 `_Cleaner.parse_style`: whitelisted declarations, last value per (lowercased) name in first
      // position, rewritten as "name:value; name:value"; none left drops the attribute
      const st = el.attrs.find(([n]) => n === "style");
      if (st && st[1]) {
        const valid = new Map<string, string>();
        for (const m of st[1].matchAll(/([\w-]+)\s*:\s*((?:[^;"']|"[^";]*"|'[^';]*')+)/g)) {
          const key = m[1]!.toLowerCase();
          if (STYLE_WHITELIST.has(key)) valid.set(key, m[2]!);
        }
        if (valid.size) st[1] = [...valid].map(([k, v]) => `${k}:${v}`).join("; ");
        else el.attrs = el.attrs.filter(([n]) => n !== "style");
      }
    }
    const next: Node[] = [];
    for (const c of el.children) {
      if (typeof c === "string") { pushText(next, c); continue; }
      if (kill.has(c.tag)) continue; // drop_tree: the tail (next text node) stays
      walk(c);
      if (remove.has(c.tag)) { for (const g of c.children) typeof g === "string" ? pushText(next, g) : next.push(g); continue; }
      next.push(c);
    }
    el.children = next;
  };
  if (kill.has(root.tag)) return { tag: "div", attrs: [], children: [] };
  walk(root);
  if (remove.has(root.tag)) { root.tag = "div"; root.attrs = []; }
  return root;
}

function pushText(list: Node[], t: string): void {
  if (typeof list[list.length - 1] === "string") list[list.length - 1] += t;
  else list.push(t);
}

function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** libxml2 xmlURIEscapeStr(value, "@/:=?;#%&,+"): other non-unreserved bytes as %XX. */
function uriEscape(v: string): string {
  let out = "";
  for (const b of Buffer.from(v, "utf8")) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-_.!~*'()@/:=?;#%&,+]/.test(c) && b < 128) out += c;
    else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

function attrText(name: string, value: string): string {
  let v = URI_ATTRS.has(name) ? uriEscape(value) : value;
  v = v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (v.includes('"') && !v.includes("'")) return `${name}='${v}'`;
  return `${name}="${v.replace(/"/g, "&quot;")}"`;
}

function serialize(n: Node): string {
  if (typeof n === "string") return escText(n);
  if (n.tag === "script" || n.tag === "style") refuse(`serialisation of a kept <${n.tag}>`);
  const attrs = n.attrs.map(([k, v]) => " " + (v === "" && ["checked", "selected", "disabled", "readonly", "multiple", "nowrap", "noshade", "compact", "ismap", "nohref"].includes(k) ? refuse(`boolean attribute ${k}`) : attrText(k, v))).join("");
  if (VOID.has(n.tag)) return `<${n.tag}${attrs}>`;
  if (n.tag === "pre" && typeof n.children[0] === "string" && n.children[0].startsWith("\n")) refuse("<pre> starting with a newline");
  return `<${n.tag}${attrs}>${n.children.map(serialize).join("")}</${n.tag}>`;
}

/** `html.tostring(doc, method='xml')`. */
function serializeXhtml(n: Node): string {
  if (typeof n === "string") return escText(n);
  const attrs = n.attrs.map(([k, v]) => ` ${k}="${v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}"`).join("");
  if (!n.children.length) return `<${n.tag}${attrs}/>`;
  return `<${n.tag}${attrs}>${n.children.map(serializeXhtml).join("")}</${n.tag}>`;
}

function containsBlock(nodes: Node[]): boolean {
  return nodes.some((n) => typeof n !== "string" && (BLOCK.has(n.tag) || containsBlock(n.children)));
}

const WS = "[ \\t\\r\\n]*";
const ATTRS = `((?:\\s+[A-Za-z][\\w:-]*\\s*=\\s*"[^"<>]*")*)\\s*`;
const DOC_HEAD = new RegExp(`^${WS}<html${ATTRS}>(${WS})<head>(${WS})((?:<meta(?:\\s+[A-Za-z][\\w:-]*\\s*=\\s*"[^"<>]*")*\\s*/?>${WS})*)</head>(${WS})<body${ATTRS}>`, "i");
const DOC_TAIL = new RegExp(`</body>(${WS})</html>${WS}$`, "i");

function attrList(raw: string): [string, string][] {
  return [...raw.matchAll(/([A-Za-z][\w:-]*)\s*=\s*"([^"<>]*)"/g)].map((m) => [m[1]!.toLowerCase(), decodeEntities(m[2]!)] as [string, string]);
}

/**
 * mail.py:291-310 `fromstring` of a full document (`_looks_like_full_html_unicode`: `<html` first): the <html> element
 * itself as libxml2 builds it, over one shape only: <html> with blank text, a <head> of <meta> elements, blank text,
 * <body>...</body>, blank text, </html>. Blanks before <html> and after </html> are dropped; the text after <html> is
 * the html's text, after </head> the head's tail, after </body> the body's tail, inside the head the head's text and
 * each meta's tail (checked with lxml 5.2.1 on the email layouts' output, 2026-11-11). Null for a fragment.
 */
function parseDocument(src: string): El | null {
  if (!/^\s*<(html|!doctype)/i.test(src)) return null;
  const h = DOC_HEAD.exec(src);
  const t = DOC_TAIL.exec(src);
  if (!h || !t || t.index < h[0].length) refuse("full html document other than <html><head><meta/></head><body>...</body></html>");
  const head: El = { tag: "head", attrs: [], children: h[3] ? [h[3]] : [] };
  for (const m of h[4]!.matchAll(/<meta((?:\s+[A-Za-z][\w:-]*\s*=\s*"[^"<>]*")*)\s*\/?>([ \t\r\n]*)/gi)) {
    head.children.push({ tag: "meta", attrs: attrList(m[1]!), children: [] });
    if (m[2]) head.children.push(m[2]);
  }
  const inner = src.slice(h[0].length, t.index);
  // explicit body: its blank text is kept (no implied <p> for it); leading character data refuses
  if (/^[ \t\r\n]*[^<\s]/.test(inner)) refuse("character data first in <body>");
  const lead = /^[ \t\r\n]*/.exec(inner)![0];
  const body: El = { tag: "body", attrs: attrList(h[6]!), children: [] };
  if (lead) body.children.push(lead);
  for (const n of parse(inner.slice(lead.length))) pushNode(body.children, n);
  const children: Node[] = [];
  if (h[2]) children.push(h[2]);
  children.push(head);
  if (h[5]) children.push(h[5]);
  children.push(body);
  if (t[1]) children.push(t[1]);
  return { tag: "html", attrs: attrList(h[1]!), children };
}

function pushNode(list: Node[], n: Node): void {
  if (typeof n === "string") pushText(list, n);
  else list.push(n);
}

/** mail.py:425 html_sanitize(src, silent=True, ...) for the field options; `src` is a non-empty string. */
export function htmlSanitize(srcIn: string, o: SanitizeOptions): string {
  if (!srcIn) return srcIn;
  // mail.py:378-386 html_normalize pre-processing
  if (/encoding=/i.test(srcIn) || srcIn.includes("--!>") || /<\/?o:/.test(srcIn)) refuse("html_normalize pre-processing cases");
  const doc = parseDocument(srcIn);
  if (doc) {
    // a full document is never a single body element (mail.py:309-310): the cleaner turns the <html> it cannot drop
    // into a <div> (mail.py:410-419), dropped from the output
    tagQuote(doc, { tag: "#document", attrs: [], children: [doc] });
    let out = (o.xmlOutput ? serializeXhtml : serialize)(clean(doc, o));
    if (out.startsWith("<div>") && out.endsWith("</div>")) out = out.slice(5, -6);
    return out.replace(/\u00a0/g, "&nbsp;");
  }
  const nodes = parse(srcIn, !o.sanitizeTags);
  // mail.py:394: an empty document -> ""
  if (!nodes.length) return "";
  // mail.py:291 fromstring: a single element (with blank text around) is the document itself, else a wrapper
  const elements = nodes.filter((n): n is El => typeof n !== "string");
  const lead = typeof nodes[0] === "string" ? nodes[0] : "";
  const tail = typeof nodes[nodes.length - 1] === "string" && nodes.length > 1 ? (nodes[nodes.length - 1] as string) : "";
  const single = elements.length === 1 && !lead.trim() && !tail.trim() && nodes.length <= 3 && nodes.indexOf(elements[0]!) <= 1;
  const write = o.xmlOutput ? serializeXhtml : serialize;
  let out: string;
  if (single) {
    if (lead) refuse("blank text before a single element");
    tagQuote(elements[0]!, { tag: "body", attrs: [], children: nodes });
    const el = clean(elements[0]!, o);
    // lxml tostring includes the element's tail
    out = write(el) + escText(tail);
  } else {
    const wrapper: El = { tag: containsBlock(nodes) ? "div" : "span", attrs: [], children: nodes };
    tagQuote(wrapper, { tag: "html", attrs: [], children: [wrapper] });
    const el = clean(wrapper, o);
    out = write(el);
    // mail.py:410-419: the <div> wrapper is dropped
    if (out.startsWith("<div>") && out.endsWith("</div>")) out = out.slice(5, -6);
  }
  return out.replace(/\u00a0/g, "&nbsp;");
}

/** An element of `parseHtmlBody`'s tree: lowercase tag, attributes in source order (entities decoded), children. */
export interface HtmlElement { tag: string; attrs: [string, string][]; children: HtmlNode[] }
export type HtmlNode = HtmlElement | string;

/**
 * The children of <body> as `etree.fromstring(src, parser=etree.HTMLParser())` builds them (libxml2's HTML parser),
 * over the subset `parse` reproduces (other input refuses with NotPorted). Text nodes hold decoded text.
 */
export function parseHtmlBody(src: string): HtmlNode[] {
  return parse(src);
}
