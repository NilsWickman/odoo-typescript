/**
 * `xml_translate` (odoo/tools/translate.py:179-399) and `StoredTranslations.translated` (:771-856) for the term
 * translations of an install (D23 path B, B2 step 2, compiler/VAGB.md): a view's arch translated term by term on this
 * database's own value, so that an arch holding the ids its data file gave (`%(xmlid)d`) is translated here as Odoo
 * translates it, without the build's precomputed result.
 *
 * In scope: what lxml's XML tree gives without its HTML parser. Odoo parses a translated term with lxml's HTML parser
 * (`parse_html(f"<div>{result}</div>")`, :285); the result replaces the whole stripped term, so it is plain text
 * unless the translation itself holds markup or an entity (`<`, `&`): that refuses (NotPorted), as does a value that
 * is not XML (the HTML fallback, :392-397) and a `t-` attribute's format expressions. A term with inline markup
 * (b, span, ...) translated to plain text replaces its inline nodes, as in Odoo.
 */
import { NotPorted } from "../errors";
import { append, element, insert, isElement, parseXml, serializeXml, type Element, type Node } from "../xml";

export type TermCallback = (term: string) => string | null | undefined;

const SKIPPED_ELEMENTS = new Set(["script", "style", "title"]);
const TRANSLATED_ELEMENTS = new Set([
  "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "del", "dfn", "em",
  "font", "i", "ins", "kbd", "keygen", "mark", "math", "meter", "output",
  "progress", "q", "ruby", "s", "samp", "small", "span", "strong", "sub",
  "sup", "time", "u", "var", "wbr", "text",
]);
const BASE_ATTRS = ["string", "add-label", "help", "sum", "avg", "confirm", "placeholder", "alt", "title", "aria-label",
  "aria-keyshortcuts", "aria-placeholder", "aria-roledescription", "aria-valuetext",
  "value_label", "data-tooltip", "label", "confirm-label", "cancel-label", "confirm-title"];
const TRANSLATED_ATTRS = new Set([...BASE_ATTRS, ...BASE_ATTRS.map((a) => `t-attf-${a}`)]);

/** Python's `str.isspace` characters (the `\s` of a str regex), with web_editor's ﻿ (translate.py:157). */
const SPACE = "\\s\\x1c-\\x1f\\x85\\uFEFF";
const ONLY_SPACE = new RegExp(`^[${SPACE}]*$`);
/** Python's `str.isspace` (JS's `\s` holds \uFEFF, Python's does not; Python's holds \x1c-\x1f and \x85). */
function pySpace(c: string): boolean {
  return c !== "\uFEFF" && /[\s\x1c-\x1f\x85]/.test(c);
}
/** Python's `str.strip()`. */
function pyStrip(s: string): string {
  let i = 0, j = s.length;
  while (i < j && pySpace(s[i]!)) i++;
  while (j > i && pySpace(s[j - 1]!)) j--;
  return s.slice(i, j);
}

function attrs(n: Node): Map<string, string> {
  return isElement(n) ? n.attrib : new Map();
}

function isTranslatableAttrib(key: string | undefined, node: Node): boolean {
  if (!key) return false;
  if (!attrs(node).has("t-call") && TRANSLATED_ATTRS.has(key)) return true;
  return key.endsWith(".translate");
}

function isTranslatableAttribValue(node: Node): boolean {
  if (!isElement(node)) return false;
  const classes = (node.attrib.get("class") ?? "").split(" ");
  return (node.tag === "input" && (node.attrib.get("type") ?? "text") === "text" && !classes.includes("datetimepicker-input"))
    || (node.tag === "input" && node.attrib.get("type") === "hidden" && classes.includes("o_translatable_input_hidden"));
}

function isTranslatableAttribText(node: Node): boolean {
  return isElement(node) && node.tag === "field" && (node.attrib.get("widget") ?? "") === "url";
}

function nonspace(text: string | null | undefined): boolean {
  return Boolean(text) && !ONLY_SPACE.test(text!);
}

function isForceInline(node: Node): boolean {
  return (attrs(node).get("class") ?? "").split(/\s+/).includes("o_translate_inline");
}

function translatable(node: Node, forceInline = false): boolean {
  if (!isElement(node)) {
    if (forceInline) throw new NotPorted("xml_translate: a comment inside an o_translate_inline node");
    return false;
  }
  const force = forceInline || isForceInline(node);
  return (force || TRANSLATED_ELEMENTS.has(node.tag))
    && ![...node.attrib.keys()].some((k) => k.startsWith("t-") || k === "groups" || k.endsWith(".translate"))
    && node.children.every((c) => translatable(c, force));
}

function hastext(node: Element, pos = 0, forceInline = false): boolean {
  const force = forceInline || isForceInline(node);
  if (nonspace(pos ? node.children[pos - 1]!.tail : node.text)) return true;
  if (pos >= node.children.length) return false;
  const child = node.children[pos]!;
  if (!translatable(child, force)) return false;
  for (const [key, val] of attrs(child)) {
    if (val && (isTranslatableAttrib(key, node) || (key === "value" && isTranslatableAttribValue(child)) || (key === "text" && isTranslatableAttribText(child)))) return true;
  }
  return (isElement(child) && hastext(child, 0, force)) || hastext(node, pos + 1, force);
}

/**
 * `parse_html(f"<div>{result}</div>")` (translate.py:372-377, lxml's HTML parser) for a translation with markup,
 * through the XML parser where both give the same tree: well-formed, lowercase tags, only XML's entities (libxml2's
 * HTML parser also takes `<x/>` as an empty element, HTMLparser.c "Empty Element labeled the XML/SGML way").
 * Anything else refuses (NotPorted).
 */
function htmlLikeXml(result: string): Element {
  for (const m of result.matchAll(/<\/?([A-Za-z][\w.:-]*)/g)) {
    if (m[1] !== m[1]!.toLowerCase()) throw new NotPorted(`xml_translate: a translated term with the tag <${m[1]}> (lxml's HTML parser lowercases it)`);
  }
  for (const m of result.matchAll(/&(#?[a-zA-Z0-9]+);/g)) {
    if (!["amp", "lt", "gt", "quot", "apos"].includes(m[1]!) && !m[1]!.startsWith("#")) {
      throw new NotPorted(`xml_translate: a translated term with the entity &${m[1]}; (lxml's HTML parser)`);
    }
  }
  let div: Element;
  try {
    div = parseXml(`<div>${result}</div>`);
  } catch {
    throw new NotPorted(`xml_translate: a translated term that is not well-formed XML (lxml's HTML parser): ${JSON.stringify(result.slice(0, 160))}`);
  }
  for (const n of iterAll(div)) {
    if (!isElement(n)) throw new NotPorted("xml_translate: a comment or processing instruction in a translated term");
  }
  div.tag = "span";
  return div;
}

function* iterAll(el: Element): Generator<Node> {
  for (const c of el.children) {
    yield c;
    if (isElement(c)) yield* iterAll(c);
  }
}

/** translate.py:166-177 `translate_format_string_expression`: the `#{...}` / `{{...}}` expressions of a `t-attf-`
 *  value replaced by `{{<n>}}` for the callback, and put back in its translation (an unknown one gives 'None'). */
const FORMAT_REGEX = /(?:#\{(.+?)\})|(?:\{\{(.+?)\}\})/g;
function translateFormatString(term: string, callback: TermCallback): string | null | undefined {
  const expressions = new Map<string, string>();
  const withoutPy = term.replace(FORMAT_REGEX, (g) => {
    const index = String(expressions.size);
    expressions.set(index, g);
    return `{{${index}}}`;
  });
  const translated = callback(withoutPy);
  if (translated) return translated.replace(FORMAT_REGEX, (g) => expressions.get(g.slice(2, -2)) ?? "None");
  return undefined;
}

/** translate.py:179-322 `translate_xml_node` with `parse_xml`/`serialize_xml`. */
function translateNode(root: Element, callback: TermCallback): void {
  const process = (node: Node): void => {
    if (!isElement(node)) return; // SKIPPED_ELEMENT_TYPES: comments and processing instructions
    if (SKIPPED_ELEMENTS.has(node.tag) || pyStrip(node.attrib.get("t-translation") ?? "") === "off") return;
    if (node.tag === "attribute" && !["value", "text"].includes(node.attrib.get("name") ?? "") && !isTranslatableAttrib(node.attrib.get("name"), node)) return;
    if (node.parent === null && /^\s*<!DOCTYPE/i.test(node.text ?? "")) return;
    let pos = 0;
    for (;;) {
      if (hastext(node, pos)) {
        const div = element("div");
        div.text = (pos ? node.children[pos - 1]!.tail : node.text) ?? "";
        while (pos < node.children.length && translatable(node.children[pos]!, isForceInline(node))) append(div, node.children[pos]!);
        const content = serializeXml(div).slice(5, -6);
        const original = pyStrip(content);
        const translated = callback(original);
        if (translated && original) {
          // `content.replace(original, translated)`: the whole stripped term is replaced, so the result is the
          // translation between the term's leading and trailing space, plain text unless the translation holds markup
          // or an entity (then lxml's HTML parser decides, :285: refused)
          const result = content.split(original).join(translated);
          // parse_html(f"<div>{result}</div>"), its tag made a span: it replaces the term when it is translatable and has
          // text (:283-306), its children taking the place of the term's inline nodes
          const parsed = /[&<]/.test(translated) ? htmlLikeXml(result) : (() => { const e = element("span"); e.text = result; return e; })();
          if (translatable(parsed) && hastext(parsed)) {
            if (pos) node.children[pos - 1]!.tail = parsed.text;
            else node.text = parsed.text;
            for (const c of div.children.splice(0)) c.parent = null;
            while (parsed.children.length) append(div, parsed.children[0]!);
          }
        }
        while (div.children.length) insert(node, pos++, div.children[0]!);
      }
      if (pos >= node.children.length) break;
      process(node.children[pos]!);
      pos += 1;
    }
    for (const [key, val] of [...node.attrib]) {
      if (!nonspace(val)) continue;
      if (isTranslatableAttrib(key, node) || (key === "value" && isTranslatableAttribValue(node)) || (key === "text" && isTranslatableAttribText(node))) {
        const value = key.startsWith("t-") ? translateFormatString(pyStrip(val), callback) : callback(pyStrip(val));
        node.attrib.set(key, value || val);
      }
    }
  };
  process(root);
}

/** translate.py:383-399 `xml_translate(callback, value)` on a value that parses as XML. */
export function xmlTranslate(callback: TermCallback, value: string | null): string | null {
  if (!value) return value;
  let root: Element;
  try {
    root = parseXml(value);
  } catch {
    throw new NotPorted("xml_translate of a value that is not XML (the HTML parser fallback)");
  }
  translateNode(root, callback);
  return serializeXml(root, { withTail: false });
}

/** `ParsedTranslation(field, value).terms` (translate.py:903-915). */
export function xmlTerms(value: string): string[] {
  const terms: string[] = [];
  xmlTranslate((t) => { terms.push(t); return "X"; }, value);
  return terms;
}

type Stored = Map<string, string>;

/** StoredTranslations.__getitem__ (translate.py:535-564). */
function getLang(v: Stored, key: string): string | undefined {
  const own = v.get(key);
  if (own !== undefined) return own;
  if (key.startsWith("_")) {
    const plain = v.get(key.slice(1));
    if (plain !== undefined) return plain;
    const en = v.get("_en_US");
    if (en !== undefined) return en;
  }
  return v.get("en_US");
}

/** `_validate(check_structure=False, auto_fix=True)` (translate.py:583-646) for a term-translated field. */
function validate(values: Record<string, unknown>, activeLangs: ReadonlySet<string>): Stored | null {
  const valid = new Set([...activeLangs, "en_US"]);
  for (const l of [...valid]) valid.add(`_${l}`);
  const out: Stored = new Map();
  for (const [k, v] of Object.entries(values)) {
    if (!valid.has(k) || v === null || v === undefined) continue;
    if (typeof v !== "string") throw new NotPorted("term translation: a stored translation that is not a string");
    out.set(k, v);
  }
  if (!out.has("en_US")) {
    if (!out.size) return null;
    out.set("en_US", out.values().next().value!);
  }
  for (const k of [...out.keys()]) if (k.startsWith("_") && !out.has(k.slice(1))) out.set(k.slice(1), out.get("en_US")!);
  return out;
}

/** `_get_translation_dictionary` (translate.py:500-533): {source term: {lang: term}}. */
function translationDictionary(fromValue: string | undefined, toValues: Map<string, string>): Map<string, Map<string, string>> {
  const dict = new Map<string, Map<string, string>>();
  if (typeof fromValue !== "string" || !fromValue) return dict;
  const fromTerms = xmlTerms(fromValue);
  for (const t of fromTerms) if (!dict.has(t)) dict.set(t, new Map());
  if (!fromTerms.length) return dict;
  for (const [lang, toValue] of toValues) {
    const toTerms = toValue ? xmlTerms(toValue) : [];
    if (fromTerms.length !== toTerms.length) {
      for (const t of fromTerms) dict.get(t)!.set(lang, t);
    } else {
      fromTerms.forEach((t, i) => dict.get(t)!.set(lang, toTerms[i]!));
    }
  }
  return dict;
}

/**
 * The values `TranslationImporter.save` writes for one record (translate.py:2230-2253): `StoredTranslations(values)
 * .translated(env, field, 'en_US', term_updates, overwrite=...)` (:771-856, source language en_US, no digest, not
 * delayed), then the languages updated whose value changed, and their technical `_lang` dropped.
 */
export function translatedChanges(values: Record<string, unknown>, termUpdates: ReadonlyMap<string, ReadonlyMap<string, string>>,
  activeLangs: ReadonlySet<string>, overwrite: boolean): Record<string, string | null> {
  const self = validate(values, activeLangs);
  if (!self) throw new NotPorted("term translation of a value without en_US");
  for (const lang of termUpdates.keys()) {
    const tech = self.get(`_${lang}`);
    if (tech !== undefined) { self.delete(`_${lang}`); self.set(lang, tech); }
  }
  const updates = [...termUpdates].filter(([, m]) => m.size);
  if (updates.length) {
    const oldSource = getLang(self, "_en_US");
    const toTranslate = new Map<string, string>();
    for (const [lang] of updates) {
      const v = getLang(self, `_${lang}`);
      if (v !== oldSource && v !== undefined) toTranslate.set(lang, v);
    }
    const oldDict = translationDictionary(oldSource, toTranslate);
    for (const [lang, src2term] of updates) {
      const old = new Map<string, string>();
      for (const [src, byLang] of oldDict) {
        const term = byLang.get(lang);
        if (term && term !== src) old.set(src, term);
      }
      const merged = overwrite ? new Map([...old, ...src2term]) : new Map([...src2term, ...old]);
      self.set(lang, xmlTranslate((t) => merged.get(t), oldSource ?? null) ?? "");
    }
  }
  const changed: Record<string, string | null> = {};
  for (const lang of termUpdates.keys()) {
    const now = self.get(lang) ?? null;
    if ((values[lang] ?? null) !== now) changed[lang] = now;
    if (`_${lang}` in values) changed[`_${lang}`] = null;
  }
  return changed;
}
