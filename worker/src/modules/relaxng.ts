/**
 * RELAX NG validation of Odoo's XML data files, as `convert_xml_import` does before loading one
 * (odoo/odoo/tools/convert.py:792-797: `etree.RelaxNG(etree.parse('import_xml.rng')).assert_(doc)`).
 *
 * Validity is decided with the derivative algorithm of the RELAX NG specification's author (James Clark, "An algorithm
 * for RELAX NG validation", 2002), on the schema compiled from Odoo's own `import_xml.rng` (copied verbatim into
 * gen/out/import_xml_rng.json by gen/import_xml_rng.py). Only the schema constructs that file uses are compiled; any
 * other construct throws NotPorted when the schema is compiled, never a guessed pattern.
 *
 * The error message is libxml2's (lxml's `assert_` raises `AssertionError(error_log._buildExceptionMessage(...))`,
 * the first error with its line). libxml2 validates the root's content as one compiled content model, so every
 * content error anywhere in the document is reported on the root, at its first child that is not blank text, a
 * comment or a processing instruction. Measured with the oracle's lxml (5.x, libxml2 2.x) on Odoo's data files and
 * their mutations (worker/test/relaxng_cases.py, src/modules/relaxng.test.ts):
 *   - root not odoo/openerp/data:         "Document does not comply with schema" (no line)
 *   - any content error:                  "Element <root> has extra content: <first child>, line <n>"; an element child
 *                                         by its local name and its line, text as "text" with the root's line
 *                                         (libxml2's __xmlRaiseError takes a non-element node's line from its parent)
 *   - else an attribute the root may not have: "Invalid attribute <local name> for element <root>, line <root's line>"
 * `xmlns` declarations are not attributes in libxml2's tree, so they are not validated.
 */
import { NotPorted } from "../errors";
import { isElement, type Element, type Node } from "../xml";
import { parseXml } from "../xml/parse";

// ---- patterns (interned, so equal patterns are the same object and `choice` can drop duplicates) ----

type Datatype = { kind: "string"; pattern: RegExp | null } | { kind: "token" } | { kind: "int" } | { kind: "float" };

type NameClass = { kind: "any" } | { kind: "name"; ns: string; local: string } | { kind: "choice"; a: NameClass; b: NameClass };

type Pattern =
  | { readonly id: number; readonly t: "empty" | "notAllowed" | "text"; readonly nullable: boolean }
  | { readonly id: number; readonly t: "choice" | "group" | "interleave" | "after"; readonly a: Pattern; readonly b: Pattern; readonly nullable: boolean }
  | { readonly id: number; readonly t: "oneOrMore"; readonly a: Pattern; readonly nullable: boolean }
  | { readonly id: number; readonly t: "data"; readonly dt: Datatype; readonly nullable: boolean }
  | { readonly id: number; readonly t: "value"; readonly dt: Datatype; readonly value: string; readonly nullable: boolean }
  | { readonly id: number; readonly t: "attribute"; readonly nc: NameClass; readonly a: Pattern; readonly nullable: boolean }
  | { readonly id: number; readonly t: "element"; readonly nc: NameClass; readonly content: () => Pattern; readonly nullable: boolean };

class Patterns {
  private next = 0;
  private readonly interned = new Map<string, Pattern>();
  readonly empty: Pattern = { id: this.next++, t: "empty", nullable: true };
  readonly notAllowed: Pattern = { id: this.next++, t: "notAllowed", nullable: false };
  readonly text: Pattern = { id: this.next++, t: "text", nullable: true };

  private intern<P extends Pattern>(key: string, make: (id: number) => P): Pattern {
    let p = this.interned.get(key);
    if (!p) { p = make(this.next++); this.interned.set(key, p); }
    return p;
  }

  choice(a: Pattern, b: Pattern): Pattern {
    if (a.t === "notAllowed") return b;
    if (b.t === "notAllowed") return a;
    if (a === b) return a;
    // flatten and sort the alternatives, so choice(x, choice(y, x)) is choice(x, y)
    const alts = new Map<number, Pattern>();
    const add = (p: Pattern): void => { if (p.t === "choice") { add(p.a); add(p.b); } else alts.set(p.id, p); };
    add(a); add(b);
    const sorted = [...alts.values()].sort((x, y) => x.id - y.id);
    let out = sorted[0]!;
    for (const p of sorted.slice(1)) {
      const l = out, r = p;
      out = this.intern(`c${l.id},${r.id}`, (id) => ({ id, t: "choice", a: l, b: r, nullable: l.nullable || r.nullable }));
    }
    return out;
  }

  group(a: Pattern, b: Pattern): Pattern {
    if (a.t === "notAllowed" || b.t === "notAllowed") return this.notAllowed;
    if (a.t === "empty") return b;
    if (b.t === "empty") return a;
    return this.intern(`g${a.id},${b.id}`, (id) => ({ id, t: "group", a, b, nullable: a.nullable && b.nullable }));
  }

  interleave(a: Pattern, b: Pattern): Pattern {
    if (a.t === "notAllowed" || b.t === "notAllowed") return this.notAllowed;
    if (a.t === "empty") return b;
    if (b.t === "empty") return a;
    return this.intern(`i${a.id},${b.id}`, (id) => ({ id, t: "interleave", a, b, nullable: a.nullable && b.nullable }));
  }

  after(a: Pattern, b: Pattern): Pattern {
    if (a.t === "notAllowed" || b.t === "notAllowed") return this.notAllowed;
    return this.intern(`a${a.id},${b.id}`, (id) => ({ id, t: "after", a, b, nullable: false }));
  }

  oneOrMore(a: Pattern): Pattern {
    if (a.t === "notAllowed") return this.notAllowed;
    return this.intern(`o${a.id}`, (id) => ({ id, t: "oneOrMore", a, nullable: a.nullable }));
  }

  /** Data, value, attribute and element patterns are keyed by the schema node they were compiled from. */
  leaf(key: string, make: (id: number) => Pattern): Pattern {
    return this.intern(key, make);
  }
}

// ---- datatypes (XML Schema part 2 as libxml2's xmlschemastypes.c checks them) ----

const XSD = "http://www.w3.org/2001/XMLSchema-datatypes";
const isWsp = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
const collapse = (s: string): string => s.replace(/[ \t\n\r]+/g, " ").replace(/^ | $/g, "");

function datatypeAllows(dt: Datatype, s: string): boolean {
  switch (dt.kind) {
    case "string": return dt.pattern === null || dt.pattern.test(s);
    case "token": return true;
    case "int": {
      // xsd:int: an optional sign and digits after whitespace collapsing, in [-2^31, 2^31 - 1]
      const v = collapse(s);
      if (!/^[+-]?[0-9]+$/.test(v)) return false;
      const n = BigInt(v.startsWith("+") ? v.slice(1) : v);
      return n >= -2147483648n && n <= 2147483647n;
    }
    case "float": {
      // xmlSchemaValAtomicType, XML_SCHEMAS_FLOAT: "NaN", "INF" and "-INF" literally; otherwise an optional sign,
      // digits with an optional fraction (at least one digit), and an optional exponent whose digits may be absent
      const v = collapse(s);
      if (v === "NaN" || v === "INF" || v === "-INF") return true;
      return /^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]*)?$/.test(v);
    }
  }
}

function datatypeEqual(dt: Datatype, value: string, s: string): boolean {
  if (dt.kind === "token") return collapse(value) === collapse(s);
  if (dt.kind === "string") return value === s;
  throw new NotPorted(`RELAX NG <value> of type ${dt.kind}`);
}

// ---- the schema ----

interface Schema {
  readonly ps: Patterns;
  readonly start: Pattern;
}

const RNG = "http://relaxng.org/ns/structure/1.0";

function rngChildren(el: Element): Element[] {
  return el.children.filter(isElement);
}

function localOf(tag: string): string {
  const i = tag.indexOf(":");
  return i < 0 ? tag : tag.slice(i + 1);
}

/**
 * Compile the subset of RELAX NG's full syntax that import_xml.rng and the view schemas (base/rng/*.rng) use (all
 * names in the null namespace). `includes` holds the text of the files an `<include href>` may name (the view schemas
 * include common.rng); an included grammar contributes its defines (and a start when the including one has none), and
 * a define both grammars have (which needs `combine`, or overrides inside the include element) refuses.
 */
function compileSchema(text: string, includes: Readonly<Record<string, string>> = {}): Schema {
  const ps = new Patterns();
  const defines = new Map<string, Element>();
  let start: Element | null = null;
  const load = (src: string, depth: number): void => {
    const root = parseXml(src.replace(/^<\?xml[^>]*\?>/, ""));
    // `<rng:grammar xmlns:rng=...>` (import_xml.rng and most view schemas) or `<grammar xmlns=...>` (activity_view.rng)
    const rngNs = root.tag.includes(":") ? root.attrib.get(`xmlns:${root.tag.slice(0, root.tag.indexOf(":"))}`) : root.attrib.get("xmlns");
    if (localOf(root.tag) !== "grammar" || rngNs !== RNG) throw new NotPorted("RELAX NG schema without an rng:grammar root");
    for (const c of rngChildren(root)) {
      const tag = localOf(c.tag);
      if (tag === "define") {
        const name = c.attrib.get("name")!;
        if (defines.has(name) || c.attrib.has("combine")) throw new NotPorted(`RELAX NG define ${name} in two grammars (combine)`);
        defines.set(name, c);
      } else if (tag === "start") {
        if (start !== null) throw new NotPorted("RELAX NG start in two grammars (combine)");
        start = c;
      } else if (tag === "include") {
        const href = c.attrib.get("href") ?? "";
        const inc = includes[href];
        if (inc === undefined || depth > 4) throw new NotPorted(`RELAX NG include of ${href}`);
        if (rngChildren(c).length) throw new NotPorted(`RELAX NG include of ${href} with overrides`);
        load(inc, depth + 1);
      } else throw new NotPorted(`RELAX NG grammar child <${tag}>`);
    }
  };
  load(text, 0);
  if (!start) throw new NotPorted("RELAX NG grammar without <start>");
  let seq = 0;
  const keys = new WeakMap<Element, string>();
  const keyOf = (el: Element): string => { let k = keys.get(el); if (!k) { k = `n${seq++}`; keys.set(el, k); } return k; };
  const lib = (el: Element): string => {
    for (let e: Element | null = el; e; e = e.parent) { const l = e.attrib.get("datatypeLibrary"); if (l !== undefined) return l; }
    return "";
  };
  const datatype = (el: Element, type: string | undefined): Datatype => {
    const l = lib(el);
    if (type === undefined) return { kind: "token" };
    if (l === "" && (type === "token" || type === "string")) return type === "token" ? { kind: "token" } : { kind: "string", pattern: null };
    if (l !== XSD) throw new NotPorted(`RELAX NG datatype library ${l}`);
    if (type === "int") return { kind: "int" };
    if (type === "float") return { kind: "float" };
    if (type === "token") return { kind: "token" };
    if (type === "string") {
      const params = rngChildren(el).filter((p) => localOf(p.tag) === "param");
      let pattern: RegExp | null = null;
      for (const p of params) {
        if (p.attrib.get("name") !== "pattern") throw new NotPorted(`RELAX NG xsd:string facet ${p.attrib.get("name")}`);
        // XML Schema patterns are implicitly anchored; this one ([a-z]+(,[a-z]+)*)? is also a JS regex
        pattern = new RegExp(`^(?:${p.text ?? ""})$`, "u");
      }
      return { kind: "string", pattern };
    }
    throw new NotPorted(`RELAX NG datatype xsd:${type}`);
  };
  const nameClass = (el: Element): NameClass => {
    const tag = localOf(el.tag);
    if (tag === "anyName") {
      if (rngChildren(el).length) throw new NotPorted("RELAX NG anyName with except");
      return { kind: "any" };
    }
    if (tag === "name") return { kind: "name", ns: "", local: (el.text ?? "").trim() };
    if (tag === "choice") {
      const cs = rngChildren(el).map(nameClass);
      return cs.reduce((a, b) => ({ kind: "choice", a, b }));
    }
    throw new NotPorted(`RELAX NG name class <${tag}>`);
  };
  /** The element's or attribute's name class and the children that make up its pattern. */
  const named = (el: Element): [NameClass, Element[]] => {
    const name = el.attrib.get("name");
    const cs = rngChildren(el);
    if (name !== undefined) {
      if (name.includes(":")) throw new NotPorted("RELAX NG prefixed name");
      return [{ kind: "name", ns: "", local: name }, cs];
    }
    return [nameClass(cs[0]!), cs.slice(1)];
  };
  const seqOf = (els: Element[], combine: (a: Pattern, b: Pattern) => Pattern): Pattern =>
    els.length === 0 ? ps.empty : els.map(compile).reduce(combine);
  const group = (els: Element[]): Pattern => seqOf(els, (a, b) => ps.group(a, b));
  function compile(el: Element): Pattern {
    const tag = localOf(el.tag);
    const cs = rngChildren(el);
    switch (tag) {
      case "empty": return ps.empty;
      case "notAllowed": return ps.notAllowed;
      case "text": return ps.text;
      case "group": return group(cs);
      case "choice": return seqOf(cs, (a, b) => ps.choice(a, b));
      case "interleave": return seqOf(cs, (a, b) => ps.interleave(a, b));
      case "optional": return ps.choice(group(cs), ps.empty);
      case "zeroOrMore": return ps.choice(ps.oneOrMore(group(cs)), ps.empty);
      case "oneOrMore": return ps.oneOrMore(group(cs));
      case "ref": {
        const def = defines.get(el.attrib.get("name")!);
        if (!def) throw new NotPorted(`RELAX NG ref to an undefined pattern ${el.attrib.get("name")}`);
        return group(rngChildren(def));
      }
      case "data": {
        const dt = datatype(el, el.attrib.get("type"));
        return ps.leaf(keyOf(el), (id) => ({ id, t: "data", dt, nullable: false }));
      }
      case "value": {
        const dt = datatype(el, el.attrib.get("type"));
        const value = el.text ?? "";
        return ps.leaf(keyOf(el), (id) => ({ id, t: "value", dt, value, nullable: false }));
      }
      case "attribute": {
        const [nc, body] = named(el);
        const a = body.length ? group(body) : ps.text;
        return ps.leaf(keyOf(el), (id) => ({ id, t: "attribute", nc, a, nullable: false }));
      }
      case "element": {
        const [nc, body] = named(el);
        let content: Pattern | null = null;
        // recursive definitions (any, field -> record -> field, function, submenuitem) compile on first use
        return ps.leaf(keyOf(el), (id) => ({ id, t: "element", nc, content: () => (content ??= group(body)), nullable: false }));
      }
      default: throw new NotPorted(`RELAX NG pattern <${tag}>`);
    }
  }
  return { ps, start: group(rngChildren(start as Element)) };
}

// ---- the derivatives (Clark 2002, section 6) ----

/** A qualified name: namespace URI and local name. */
interface QName { readonly ns: string; readonly local: string }

function contains(nc: NameClass, q: QName): boolean {
  switch (nc.kind) {
    case "any": return true;
    case "name": return nc.ns === q.ns && nc.local === q.local;
    case "choice": return contains(nc.a, q) || contains(nc.b, q);
  }
}

class Validator {
  constructor(private readonly ps: Patterns) {}

  private applyAfter(f: (p: Pattern) => Pattern, p: Pattern): Pattern {
    if (p.t === "after") return this.ps.after(p.a, f(p.b));
    if (p.t === "choice") return this.ps.choice(this.applyAfter(f, p.a), this.applyAfter(f, p.b));
    return this.ps.notAllowed;
  }

  textDeriv(p: Pattern, s: string): Pattern {
    const ps = this.ps;
    switch (p.t) {
      case "choice": return ps.choice(this.textDeriv(p.a, s), this.textDeriv(p.b, s));
      case "interleave": return ps.choice(ps.interleave(this.textDeriv(p.a, s), p.b), ps.interleave(p.a, this.textDeriv(p.b, s)));
      case "group": {
        const x = ps.group(this.textDeriv(p.a, s), p.b);
        return p.a.nullable ? ps.choice(x, this.textDeriv(p.b, s)) : x;
      }
      case "after": return ps.after(this.textDeriv(p.a, s), p.b);
      case "oneOrMore": return ps.group(this.textDeriv(p.a, s), ps.choice(p, ps.empty));
      case "text": return p;
      case "value": return datatypeEqual(p.dt, p.value, s) ? ps.empty : ps.notAllowed;
      case "data": return datatypeAllows(p.dt, s) ? ps.empty : ps.notAllowed;
      default: return ps.notAllowed;
    }
  }

  startTagOpenDeriv(p: Pattern, q: QName): Pattern {
    const ps = this.ps;
    switch (p.t) {
      case "choice": return ps.choice(this.startTagOpenDeriv(p.a, q), this.startTagOpenDeriv(p.b, q));
      case "element": return contains(p.nc, q) ? ps.after(p.content(), ps.empty) : ps.notAllowed;
      case "interleave":
        return ps.choice(
          this.applyAfter((x) => ps.interleave(x, p.b), this.startTagOpenDeriv(p.a, q)),
          this.applyAfter((x) => ps.interleave(p.a, x), this.startTagOpenDeriv(p.b, q)));
      case "oneOrMore": return this.applyAfter((x) => ps.group(x, ps.choice(p, ps.empty)), this.startTagOpenDeriv(p.a, q));
      case "group": {
        const x = this.applyAfter((y) => ps.group(y, p.b), this.startTagOpenDeriv(p.a, q));
        return p.a.nullable ? ps.choice(x, this.startTagOpenDeriv(p.b, q)) : x;
      }
      case "after": return this.applyAfter((x) => ps.after(x, p.b), this.startTagOpenDeriv(p.a, q));
      default: return ps.notAllowed;
    }
  }

  attDeriv(p: Pattern, q: QName, value: string): Pattern {
    const ps = this.ps;
    switch (p.t) {
      case "after": return ps.after(this.attDeriv(p.a, q, value), p.b);
      case "choice": return ps.choice(this.attDeriv(p.a, q, value), this.attDeriv(p.b, q, value));
      case "group": return ps.choice(ps.group(this.attDeriv(p.a, q, value), p.b), ps.group(p.a, this.attDeriv(p.b, q, value)));
      case "interleave": return ps.choice(ps.interleave(this.attDeriv(p.a, q, value), p.b), ps.interleave(p.a, this.attDeriv(p.b, q, value)));
      case "oneOrMore": return ps.group(this.attDeriv(p.a, q, value), ps.choice(p, ps.empty));
      case "attribute": return contains(p.nc, q) && this.valueMatch(p.a, value) ? ps.empty : ps.notAllowed;
      default: return ps.notAllowed;
    }
  }

  private valueMatch(p: Pattern, s: string): boolean {
    return (p.nullable && [...s].every(isWsp)) || this.textDeriv(p, s).nullable;
  }

  startTagCloseDeriv(p: Pattern): Pattern {
    const ps = this.ps;
    switch (p.t) {
      case "after": return ps.after(this.startTagCloseDeriv(p.a), p.b);
      case "choice": return ps.choice(this.startTagCloseDeriv(p.a), this.startTagCloseDeriv(p.b));
      case "group": return ps.group(this.startTagCloseDeriv(p.a), this.startTagCloseDeriv(p.b));
      case "interleave": return ps.interleave(this.startTagCloseDeriv(p.a), this.startTagCloseDeriv(p.b));
      case "oneOrMore": return ps.oneOrMore(this.startTagCloseDeriv(p.a));
      case "attribute": return ps.notAllowed;
      default: return p;
    }
  }

  endTagDeriv(p: Pattern): Pattern {
    if (p.t === "choice") return this.ps.choice(this.endTagDeriv(p.a), this.endTagDeriv(p.b));
    if (p.t === "after") return p.a.nullable ? p.b : this.ps.notAllowed;
    return this.ps.notAllowed;
  }

  /** The derivative of `p` with respect to the element `el` (its attributes and content); `skipAttrs` leaves the
   * element's attributes out, to tell a content error from an attribute error on the root. */
  elementDeriv(p: Pattern, el: Element, scope: Map<string, string>, skipAttrs = false): Pattern {
    const ns = namespaces(el, scope);
    let x = this.startTagOpenDeriv(p, qname(el.tag, ns, true));
    if (!skipAttrs) for (const [name, value] of attributes(el)) {
      x = this.attDeriv(x, qname(name, ns, false), value);
      if (x.t === "notAllowed") return x;
    }
    x = this.startTagCloseDeriv(x);
    x = this.childrenDeriv(x, contentOf(el), ns);
    return this.endTagDeriv(x);
  }

  private childrenDeriv(p: Pattern, children: (Element | string)[], scope: Map<string, string>): Pattern {
    if (children.length === 0) children = [""];
    if (children.length === 1 && typeof children[0] === "string") {
      const s = children[0];
      const p1 = this.textDeriv(p, s);
      return [...s].every(isWsp) ? this.ps.choice(p, p1) : p1;
    }
    let x = p;
    for (const c of children) {
      if (typeof c === "string") {
        if ([...c].every(isWsp)) continue;
        x = this.textDeriv(x, c);
      } else {
        x = this.elementDeriv(x, c, scope);
      }
      if (x.t === "notAllowed") return x;
    }
    return x;
  }
}

/** The element's content in RELAX NG's data model: comments and processing instructions dropped, adjacent text
 * merged into one text node. */
function contentOf(el: Element): (Element | string)[] {
  const out: (Element | string)[] = [];
  const text = (s: string | null): void => {
    if (!s) return;
    const last = out[out.length - 1];
    if (typeof last === "string") out[out.length - 1] = last + s;
    else out.push(s);
  };
  text(el.text);
  for (const c of el.children) {
    if (isElement(c)) out.push(c);
    text(c.tail);
  }
  return out;
}

function namespaces(el: Element, scope: Map<string, string>): Map<string, string> {
  let ns = scope;
  for (const [k, v] of el.attrib) {
    if (k === "xmlns" || k.startsWith("xmlns:")) {
      if (ns === scope) ns = new Map(scope);
      ns.set(k === "xmlns" ? "" : k.slice(6), v);
    }
  }
  return ns;
}

/** The attributes libxml2 has on the node: namespace declarations are not attributes. */
function attributes(el: Element): [string, string][] {
  return [...el.attrib].filter(([k]) => k !== "xmlns" && !k.startsWith("xmlns:"));
}

function qname(name: string, ns: Map<string, string>, isElementName: boolean): QName {
  const i = name.indexOf(":");
  if (i < 0) return { ns: isElementName ? (ns.get("") ?? "") : "", local: name };
  const prefix = name.slice(0, i);
  const uri = prefix === "xml" ? "http://www.w3.org/XML/1998/namespace" : ns.get(prefix);
  if (uri === undefined) throw new NotPorted(`XML data file with an undeclared namespace prefix ${prefix}`);
  return { ns: uri, local: name.slice(i + 1) };
}

// ---- libxml2's message ----

let schema: Schema | null = null;

async function loadSchema(): Promise<Schema> {
  if (!schema) {
    const gen: { rng: string } = (await import("../../gen/out/import_xml_rng.json", { with: { type: "json" } })).default;
    schema = compileSchema(gen.rng);
  }
  return schema;
}

/** For tests: compile the schema from its text. */
export function schemaFromText(rng: string): Schema {
  return compileSchema(rng);
}

const ROOT_TAGS = ["odoo", "openerp", "data"];

/** `relaxng.assert_(doc)` (convert.py:796): null when the document is valid, else lxml's AssertionError message. */
export function validateWith(s: Schema, root: Element): string | null {
  const v = new Validator(s.ps);
  const empty = new Map<string, string>();
  if (v.elementDeriv(s.start, root, empty).nullable) return null;
  const ns = namespaces(root, empty);
  const rq = qname(root.tag, ns, true);
  const line = (el: Element): number => {
    if (el.sourceline === undefined) throw new NotPorted("RELAX NG error on an element without a source line");
    return el.sourceline;
  };
  if (rq.ns !== "" || !ROOT_TAGS.includes(rq.local)) return "Document does not comply with schema";
  if (!v.elementDeriv(s.start, root, empty, true).nullable) {
    const first = firstContentNode(root);
    if (first === null) throw new NotPorted("RELAX NG content error on a root without content");
    if (typeof first === "string") return `Element ${rq.local} has extra content: text, line ${line(root)}`;
    return `Element ${rq.local} has extra content: ${qname(first.tag, namespaces(first, ns), true).local}, line ${line(first)}`;
  }
  for (const [name] of attributes(root)) {
    const q = qname(name, ns, false);
    if (q.ns !== "" || !["noupdate", "auto_sequence", "uid", "context"].includes(q.local)) {
      return `Invalid attribute ${q.local} for element ${rq.local}, line ${line(root)}`;
    }
  }
  // the root's attributes are all optional, so a document that fails must fail on its content or an attribute
  throw new NotPorted("RELAX NG error that is neither the root's content nor its attributes");
}

/** The first child libxml2's content model stops on: not blank text, not a comment, not a processing instruction. */
function firstContentNode(root: Element): Element | string | null {
  const blank = (s: string | null): boolean => s === null || [...s].every(isWsp);
  if (!blank(root.text)) return root.text!;
  for (const c of root.children as Node[]) {
    if (isElement(c)) return c;
    if (!blank(c.tail)) return c.tail!;
  }
  return null;
}

const VIEW_SCHEMAS: ReadonlySet<string> = new Set(["calendar", "graph", "pivot", "search", "list", "activity"]);
const viewSchemas = new Map<string, Schema>();
let viewRng: Promise<Readonly<Record<string, string>>> | null = null;

/**
 * `valid_view(arch)` (odoo/odoo/tools/view_validation.py:282-325): the arch of a calendar, graph, pivot, search, list
 * or activity view must fit its schema `base/rng/<type>_view.rng` (lxml's `RelaxNG.validate`, a bool); other view
 * types have no schema and are valid. The schemas are Odoo's files verbatim (gen/view_rng.py).
 */
export async function validView(root: Element): Promise<boolean> {
  if (!VIEW_SCHEMAS.has(root.tag)) return true;
  let s = viewSchemas.get(root.tag);
  if (!s) {
    viewRng ??= import("../../gen/out/view_rng.json", { with: { type: "json" } }).then((m) => (m.default as { files: Record<string, string> }).files);
    const files = await viewRng;
    const text = files[`${root.tag}_view.rng`];
    if (text === undefined) throw new NotPorted(`view schema ${root.tag}_view.rng`);
    s = compileSchema(text, files);
    viewSchemas.set(root.tag, s);
  }
  return new Validator(s.ps).elementDeriv(s.start, root, new Map()).nullable;
}

/** For tests: compile a view schema from Odoo's files. */
export function viewSchemaFromFiles(viewType: string, files: Readonly<Record<string, string>>): Schema {
  const text = files[`${viewType}_view.rng`];
  if (text === undefined) throw new NotPorted(`view schema ${viewType}_view.rng`);
  return compileSchema(text, files);
}

/** For tests: `RelaxNG.validate(root)` with a compiled schema. */
export function schemaValid(s: Schema, root: Element): boolean {
  return new Validator(s.ps).elementDeriv(s.start, root, new Map()).nullable;
}

export class PyAssertionError extends Error {
  constructor(message: string) { super(message); this.name = "AssertionError"; }
}

/** convert.py:792-797: validate a data file's tree before loading it; raise lxml's AssertionError when it does not fit. */
export async function assertImportXml(root: Element): Promise<void> {
  const msg = validateWith(await loadSchema(), root);
  if (msg !== null) throw new PyAssertionError(msg);
}
