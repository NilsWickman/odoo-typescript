/**
 * The server-side QWeb renderer, an interpreter equivalent to the Python code `IrQweb._generate_code` emits
 * (odoo/odoo/addons/base/models/ir_qweb.py, Odoo 20 commit dd5d3718; line numbers below refer to it). Odoo compiles
 * each template to a generator that accumulates static text in `_text_concat` and flushes it before dynamic code;
 * the rstrip/flush points decide the whitespace of the output, so this interpreter keeps the same pending-text
 * buffer and performs the same operations in the same order (`_append_text` 1421, `_rstrip_text` 1428,
 * `_flush_text` 1442). Directives: t-if/t-elif/t-else, t-foreach/t-as, t-set (t-value, t-valuef, body), t-out
 * (incl. the `0` slot), t-att, t-att-NAME, t-attf-NAME, t-call (args, `.f`, `.translate`, t-args), t-call-assets,
 * t-groups/groups, t-debug/t-log (ignored), t-translation/t-ignore/t-name (no effect), t-field, t-options and t-lang
 * (through the `field`/`widget` hooks of the caller). t-esc/t-raw (removed in Odoo 17+) raise NotPorted. Expressions
 * are evaluated asynchronously because records read from the database: the renderer is asynchronous as a whole.
 */
import { NotPorted } from "../errors";
import { evalExprAsync, type Scope } from "../pyexpr";
import { iterate } from "../pyexpr";
import { dictEntries, escape, isDict, isNone, Markup, pyBool, PyObject, pyStr, PyTuple, pyTuple } from "../pyexpr/values";
import { getNext, isElement, type Element, type Node } from "../xml/node";
import { assetCallKey, assetNodes, type AssetCall } from "./assets";
import { compileBool, idOrXmlid, type LoadedTemplate, type TemplateSet } from "./templates";

/** VOID_ELEMENTS (471-473). */
const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "keygen", "link", "menuitem", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT_ELEMENTS = new Set(["script", "style"]);
// 476 `re.compile(r'\n[ \t]*$')`: Python's `$` also matches before a final newline, and `RSTRIP_REGEXP.sub` replaces
// every match, so "</p>\n\n" loses both newlines (measured on the oracle: `<p>a</p>\n\n<t t-if="1">` renders
// `<p>a</p>\n    <br/>`); the lookahead is that `$`, the g flag that `sub`
const RSTRIP_REGEXP = /\n[ \t]*(?=\n?$)/g;
const LSTRIP_REGEXP = /^[ \t]*\n/; // 477
const FIRST_RSTRIP_REGEXP = /^(\n[ \t]*)+(\n[ \t])/; // 478
const VARNAME_REGEXP = /^[A-Za-z_][A-Za-z0-9_]*$/; // 479
/** FORMAT_REGEX (odoo/odoo/tools/translate.py:166): `#{expr}` or `{{expr}}`. */
const FORMAT_REGEX = /#\{(.+?)\}|\{\{(.+?)\}\}/g;
const T_CALL_SLOT = "0"; // 490
/** `_directives_eval_order` (1721-1761). */
const DIRECTIVES = ["elif", "else", "debug", "log", "groups", "as", "foreach", "if", "call-assets", "lang", "options", "call", "att", "field", "out", "tag-open", "set", "inner-content", "tag-close"] as const;
type Directive = (typeof DIRECTIVES)[number];
/** MALICIOUS_SCHEMES / WHITESPACE_REGEX (495-496), used by `_post_processing_att` (2845-2860). */
const MALICIOUS_SCHEMES = /javascript:(?!((window\.)?)history\.back\(\)$)/i;
const WHITESPACE_REGEX = /[\s\x00-\x08\x0B\x0C\x0E-\x19]+/g;

/**
 * `QwebContent` (613-678): the body of a t-set or t-call, rendered when first used. A Markup, so `escape()`
 * passes it through and string operations see its html.
 */
export class QwebContent extends Markup {
  private rendered: string | null = null;
  private readonly render: () => string;
  constructor(render: () => string) {
    super("");
    this.render = render;
  }
  override toString(): string {
    if (this.rendered === null) this.rendered = this.render();
    return this.rendered;
  }
  override __html__(): string {
    return this.toString();
  }
}

/** `json.scriptsafe.dumps` result (odoo/odoo/tools/json.py:10-58): plain JSON as str, HTML-safe escapes as html. */
export class ScriptSafe extends Markup {
  override __html__(): string {
    return this.html.replace(/[<>&\u2028\u2029]/g, (c) => ({ "<": "\\u003c", ">": "\\u003e", "&": "\\u0026", "\u2028": "\\u2028", "\u2029": "\\u2029" })[c] ?? c);
  }
}

/** What `_get_field` / `_get_widget` (2862-2916) return. */
export interface FieldRender {
  readonly attrs: Readonly<Record<string, unknown>>;
  readonly content: unknown;
  readonly forceDisplay: boolean;
}

export interface RenderOptions {
  /** `self._get_field(record, field_name, expression, tagName, options, values)` for `t-field`. */
  readonly field?: (record: unknown, field: string, expression: string, tag: string, options: Map<unknown, unknown>, values: Scope) => Promise<FieldRender>;
  /** `self._get_widget(value, expression, tagName, options, values)` for `t-out` with a `widget` option. */
  readonly widget?: (value: unknown, expression: string, tag: string, options: Map<unknown, unknown>, values: Scope) => Promise<FieldRender>;
  /** Loads a template named by a dynamic `t-call` (`_get_template`) into the set. */
  readonly loadTemplate?: (ref: string | number) => Promise<void>;
  /** `lang` of the rendering environment, for `t-lang`. */
  readonly lang?: string;
  /** `self.env.user.has_groups(groups)` for `t-groups`/`groups` attributes (2356-2374); NotPorted when absent. */
  readonly hasGroups?: (groups: string) => boolean | Promise<boolean>;
  /** `debug` of the session (asset links, `values['debug']` default). */
  readonly debug?: string;
  /** Escape `<`, `>`, `&` in static text/tail nodes (except inside `<script>`/`<style>`) for HTML-parsed templates. */
  readonly escapeText?: boolean;
  /**
   * A `t-call` with `t-lang` (`t-options-lang`) to another language (2745-2748, `_render_iterall` 816-818
   * `irQweb.with_context(**params.context)`): the callee compiled and rendered by an IrQweb whose environment is in
   * that language (its template terms, field converters and `_()`); NotPorted when absent.
   */
  readonly callInLang?: (lang: string, template: string | number, values: Scope) => Promise<string>;
}

/** Per-element render flags: the technical attributes Odoo sets on the element (1806-1823) and consumes. */
interface Flags {
  tagOpen: string | null;
  tagClose: string | null;
  innerContent: boolean;
  elseValid: boolean;
  /** `attrs` built by the `att` directive for `tag-open`. */
  attrs: Map<string, unknown> | null;
  /** `values['__qweb_options__']` of the `options` directive (t-options, t-options-*, t-lang). */
  options: Map<unknown, unknown> | null;
}

/** `_compile_to_str` (1705-1719). */
function compileToStr(v: unknown): string {
  if (isNone(v) || v === false) return "";
  if (typeof v === "string") return v;
  return pyStr(v);
}

/** `_is_static_node` (1462-1470). */
function isStaticNode(el: Element): boolean {
  if (el.tag === "t" || el.attrib.has("groups")) return false;
  for (const a of el.attrib.keys()) if (a.startsWith("t-")) return false;
  return true;
}

/** `_post_processing_att` for dynamic attributes (2845-2860). */
function postProcessingAtt(attrs: Map<string, unknown>): Map<string, unknown> {
  const href = pyStr(attrs.get("href") ?? "");
  let decoded = href;
  try {
    decoded = decodeURIComponent(href.replace(/\+/g, " "));
  } catch {
    decoded = href;
  }
  if (MALICIOUS_SCHEMES.test(decoded.replace(WHITESPACE_REGEX, ""))) attrs.set("href", "");
  return attrs;
}

/** The t-else / t-elif element following a t-if (2306-2330), skipping comments; null when there is none. */
function elseSibling(el: Element): Element | null {
  if (!el.attrib.has("t-if") && !el.attrib.has("t-elif")) return null;
  let next: Node | null = getNext(el);
  while (next !== null && next.kind === "comment") next = getNext(next);
  if (next !== null && next.kind === "element" && (next.attrib.has("t-else") || next.attrib.has("t-elif"))) return next;
  return null;
}

class Renderer {
  private out: string[] = [];
  /** `compile_context['_text_concat']`. */
  private pending: string[] = [];
  private depth = 0;

  constructor(
    private readonly templates: TemplateSet,
    private readonly opts: RenderOptions,
  ) {}

  // -- the text buffer (1421-1460)

  private appendText(text: string): void {
    this.pending.push(text);
  }

  private rstripText(): string {
    const last = this.pending[this.pending.length - 1];
    if (last === undefined) return "";
    // `RSTRIP_REGEXP.search(...)`: the first match
    const m = last.match(new RegExp(RSTRIP_REGEXP.source));
    const strip = m !== null ? m[0] : "";
    this.pending[this.pending.length - 1] = last.replace(RSTRIP_REGEXP, "");
    return strip;
  }

  private flush(rstrip = false): void {
    if (this.pending.length === 0) return;
    if (rstrip) this.rstripText();
    const text = this.pending.join("");
    this.pending = [];
    if (text !== "") this.out.push(text);
  }

  /** Run `body` into a separate output (a compiled sub-function: t-set body, t-call body, a template). */
  /**
   * The compiled function's local `attrs` left set by an element whose tag was not written: a `t-out` without a widget,
   * whose value is None or False and which has no default content, never runs its tag-open (2567-2614), so its
   * attributes stay in `attrs` until an element assigns it (`attrs = {}` of the att directive, 2075), writes it (the
   * tag-open of the next element with directives, 2114-2122) or merges into it (`attrs.update(field_attrs)` of the next
   * t-field or widget, 2515-2520). portal.side_content: the class of the empty `user_id.parent_name` lands on the
   * contact t-field after it.
   */
  private leftAttrs: Map<string, unknown> | null = null;

  private async capture(body: () => Promise<void>, rstripEnd: boolean): Promise<string> {
    const savedOut = this.out;
    const savedPending = this.pending;
    const savedAttrs = this.leftAttrs;
    this.out = [];
    this.pending = [];
    this.leftAttrs = null; // each compiled function starts with `attrs = None` (1185, 2683, 2196)
    try {
      await body();
      this.flush(rstripEnd);
      return this.out.join("");
    } finally {
      this.out = savedOut;
      this.pending = savedPending;
      this.leftAttrs = savedAttrs;
    }
  }

  // -- templates

  private async template(ref: string | number): Promise<LoadedTemplate> {
    let t = this.templates.byRef.get(idOrXmlid(ref));
    if (t === undefined && this.opts.loadTemplate !== undefined) {
      await this.opts.loadTemplate(ref);
      t = this.templates.byRef.get(idOrXmlid(ref));
    }
    if (t === undefined) throw new NotPorted(`qweb template ${String(ref)} is not preloaded (dynamic t-call target)`);
    return t;
  }

  /** The body of a t-set or t-call, rendered at once; an error surfaces where the content is used, as with the lazy `QwebContent`. */
  private async content(body: () => Promise<string>): Promise<QwebContent> {
    try {
      const html = await body();
      return new QwebContent(() => html);
    } catch (e) {
      return new QwebContent(() => { throw e; });
    }
  }

  /** The compiled template function (1189-1200) plus `_compile_root` (1763-1767). */
  async renderTemplate(ref: string | number, values: Scope): Promise<string> {
    if (++this.depth > 50) throw new Error("Qweb template infinite recursion"); // 785
    try {
      const t = await this.template(ref);
      if (!values.has("xmlid")) {
        values.set("xmlid", t.key);
        values.set("viewid", t.id);
      }
      return await this.capture(async () => {
        this.appendText("");
        const root = t.tree;
        const text = root.text !== null ? root.text.replace(FIRST_RSTRIP_REGEXP, "$2") : null;
        await this.renderNode(root, values, { rootText: text, dropAttrs: new Set(["t-name"]) });
      }, true);
    } finally {
      this.depth--;
    }
  }

  // -- nodes

  /** `_compile_node` (1769-1823). */
  private async renderNode(el: Element, values: Scope, ctx: { rootText?: string | null; dropAttrs?: Set<string>; elseValid?: boolean } = {}): Promise<void> {
    const drop = ctx.dropAttrs;
    const attrib = drop === undefined ? el.attrib : new Map([...el.attrib].filter(([k]) => !drop.has(k)));
    const view: ElView = { el, attrib, text: ctx.rootText === undefined ? el.text : ctx.rootText };
    if (isStaticNode(el) && drop === undefined) {
      await this.renderStatic(view, values);
      return;
    }
    const flags: Flags = {
      tagOpen: el.tag !== "t" ? el.tag : null,
      tagClose: el.tag !== "t" && !VOID_ELEMENTS.has(el.tag) ? el.tag : null,
      innerContent: !attrib.has("t-out") && !attrib.has("t-field"),
      elseValid: ctx.elseValid === true,
      attrs: null,
      options: null,
    };
    if (isStaticNode(el)) {
      // the root with its t-name removed is static: `_compile_directives` falls back to the static path (1899-1903)
      await this.renderStatic(view, values);
      return;
    }
    await this.renderDirectives(view, flags, values, 0);
  }

  /** `_compile_static_node` (1825-1890). */
  private async renderStatic(view: ElView, values: Scope): Promise<void> {
    const el = view.el;
    if (el.tag !== "t") {
      let attrs = "";
      for (const [name, value] of view.attrib) {
        // `_pre_processing_att` removes the `.translate` suffix (1472-1480)
        attrs += ` ${name.endsWith(".translate") ? name.slice(0, -10) : name}="${escape(value).toString()}"`;
      }
      this.appendText(`<${el.tag}${attrs}`);
      this.appendText(VOID_ELEMENTS.has(el.tag) ? "/>" : ">");
    }
    await this.renderInnerContent(view, values);
    if (el.tag !== "t" && !VOID_ELEMENTS.has(el.tag)) this.appendText(`</${el.tag}>`);
  }

  /** `_compile_directive_inner_content` (2226-2258): text, children (comments and PIs dropped, their tails kept). */
  private async renderInnerContent(view: ElView, values: Scope): Promise<void> {
    const esc = (s: string): string =>
      !this.opts.escapeText || RAW_TEXT_ELEMENTS.has(view.el.tag)
        ? s
        : s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (view.text !== null) this.appendText(esc(view.text));
    const children = view.el.children;
    for (let i = 0; i < children.length; i++) {
      const item = children[i]!;
      let last: Node = item;
      if (item.kind === "element") {
        await this.renderNode(item, values);
        // a t-if renders its t-elif/t-else chain itself (2306-2330): the chain members are skipped here
        // (`t-qweb-skip`) and only the last member keeps its tail (`el.tail = None` for every member that has a
        // successor). The comments between them are removed from the tree, but this loop runs over `list(el)` taken
        // before (2246): each removed comment still adds its tail (2256-2257), after the whole chain
        let cur: Element = item;
        const start = i;
        for (let other = elseSibling(cur); other !== null; other = elseSibling(cur)) {
          if (cur.tail !== null && cur.tail.trim() !== "") throw new Error("Unexpected non-whitespace characters between t-if and t-else directives");
          cur = other;
          i = children.indexOf(other);
        }
        for (let j = start + 1; j < i; j++) {
          const between = children[j]!;
          if (between.kind === "comment" && between.tail !== null) this.appendText(esc(between.tail));
        }
        last = cur;
      }
      if (last.tail !== null) this.appendText(esc(last.tail));
    }
  }

  /** `_compile_directives` (1892-1931): the directives still present, in evaluation order from `start`. */
  private async renderDirectives(view: ElView, flags: Flags, values: Scope, start: number): Promise<void> {
    const attrib = view.attrib;
    for (let i = start; i < DIRECTIVES.length; i++) {
      const d: Directive = DIRECTIVES[i]!;
      switch (d) {
        case "elif":
        case "else":
          if (attrib.has(`t-${d}`)) {
            if (!flags.elseValid) throw new Error("t-elif directive must be preceded by t-if or t-elif directive");
            flags.elseValid = false;
            if (d === "elif") {
              await this.directiveIf(view, flags, values, i + 1, "t-elif");
              return;
            }
          }
          break;
        case "debug":
        case "log":
          break; // 1947-1960 / 2801-2827: only effective in dev mode
        case "groups":
          if (attrib.has("t-groups") || attrib.has("groups")) {
            await this.directiveGroups(view, flags, values, i + 1);
            return;
          }
          break;
        case "as":
          if (attrib.has("t-as") && !attrib.has("t-foreach")) throw new Error("t-as must be on the same node of t-foreach");
          break;
        case "foreach":
          if (attrib.has("t-foreach")) {
            await this.directiveForeach(view, flags, values, i + 1);
            return;
          }
          break;
        case "if":
          if (attrib.has("t-if")) {
            await this.directiveIf(view, flags, values, i + 1, "t-if");
            return;
          }
          break;
        case "call-assets":
          if (attrib.has("t-call-assets")) this.directiveCallAssets(view, values);
          break;
        case "lang":
          // `_compile_directive_lang` (2744-2748): an alias of t-options-lang on a t-call
          if (attrib.has("t-lang") && !attrib.has("t-call")) throw new Error("t-lang is an alias of t-options-lang but only available on the same node of t-call");
          break;
        case "options":
          await this.directiveOptions(view, flags, values);
          break;
        case "call":
          if (attrib.has("t-call")) {
            await this.directiveCall(view, flags, values);
            // the body was compiled into the `0` slot: `t-inner-content` is consumed (2690, 2226); att/tag-open emit nothing for a <t>
            flags.innerContent = false;
          }
          break;
        case "att":
          await this.directiveAtt(view, flags, values);
          break;
        case "field":
          if (attrib.has("t-field")) {
            await this.directiveField(view, flags, values);
            return;
          }
          break;
        case "out":
          if (attrib.has("t-out")) {
            await this.directiveOut(view, flags, values);
            return; // t-out emits tag-open, inner-content (default) and tag-close itself (2467-2614)
          }
          if (attrib.has("t-esc") || attrib.has("t-raw")) throw new NotPorted(`${attrib.has("t-esc") ? "t-esc" : "t-raw"} (removed in Odoo 17)`);
          break;
        case "tag-open":
          this.tagOpen(view, flags);
          break;
        case "set":
          if (attrib.has("t-set")) await this.directiveSet(view, flags, values);
          else if (attrib.has("t-value") || attrib.has("t-valuef")) throw new Error("t-value must be on the same node of t-set");
          break;
        case "inner-content":
          if (flags.innerContent) await this.renderInnerContent(view, values);
          break;
        case "tag-close":
          if (flags.tagClose !== null) this.appendText(`</${flags.tagClose}>`);
          break;
        default: {
          const never: never = d;
          return never;
        }
      }
    }
  }

  // -- directives

  /** `_compile_directive_if` (2260-2331). */
  private async directiveIf(view: ElView, flags: Flags, values: Scope, next: number, attr: "t-if" | "t-elif"): Promise<void> {
    const expr = view.attrib.get(attr) ?? "";
    if (expr.trim() === "") throw new Error("t-if or t-elif expression should not be empty.");
    let strip = this.rstripText(); // the whitespace is visible only when a content is displayed
    if (view.el.tag === "t" && view.text !== null && view.text !== "" && LSTRIP_REGEXP.test(view.text)) strip = ""; // remove technical spaces
    this.flush();
    if (pyBool(await evalExprAsync(expr, values))) {
      if (strip !== "") this.appendText(strip);
      await this.renderDirectives(view, flags, values, next);
      this.flush(true);
      return;
    }
    const other = elseSibling(view.el);
    if (other !== null) {
      if (strip !== "") this.appendText(strip);
      await this.renderNode(other, values, { elseValid: true });
      this.flush(true);
    }
  }

  /** `_compile_directive_groups` (2356-2374). */
  private async directiveGroups(view: ElView, flags: Flags, values: Scope, next: number): Promise<void> {
    const groups = view.attrib.get("t-groups") ?? view.attrib.get("groups") ?? "";
    const strip = this.rstripText();
    this.flush();
    if (this.opts.hasGroups === undefined) throw new NotPorted(`groups="${groups}" without a hasGroups callback`);
    if (await this.opts.hasGroups(groups)) {
      if (strip !== "" && view.el.tag !== "t") this.appendText(strip);
      await this.renderDirectives(view, flags, values, next);
      this.flush(true);
    }
  }

  /** `_compile_directive_foreach` (2376-2455). */
  private async directiveForeach(view: ElView, flags: Flags, values: Scope, next: number): Promise<void> {
    const exprForeach = view.attrib.get("t-foreach") ?? "";
    const as = view.attrib.get("t-as") ?? "";
    if (as === "") throw new Error("KeyError: 't-as'");
    if (!VARNAME_REGEXP.test(as)) throw new Error(`The varname '${as}' can only contain alphanumeric characters and underscores.`);
    if (view.el.tag === "t") this.rstripText();
    this.flush();

    let items: unknown[];
    let size: number | null;
    let hasValue = false;
    if (/^\d+$/.test(exprForeach)) {
      size = parseInt(exprForeach, 10);
      items = Array.from({ length: size }, (_, i) => i);
    } else {
      let v = await evalExprAsync(exprForeach, values);
      if (!pyBool(v)) v = [];
      if (v instanceof PyObject) v = iterate(v, "t-foreach");
      if (typeof v === "number" && Number.isInteger(v)) {
        size = v;
        items = Array.from({ length: Math.max(0, v) }, (_, i) => i);
      } else if (isDict(v)) {
        const entries = dictEntries(v);
        size = entries.length;
        items = entries.map(([k, val]) => pyTuple([k, val]));
        hasValue = true;
      } else if (Array.isArray(v)) {
        size = v.length;
        items = v;
      } else if (typeof v === "string" || v instanceof Markup) {
        const chars = [...v.toString()];
        size = chars.length;
        items = chars;
      } else {
        throw new NotPorted(`t-foreach over a ${typeof v} value`);
      }
    }
    if (size !== null) values.set(`${as}_size`, size);
    for (const [index, item] of items.entries()) {
      values.set(`${as}_index`, index);
      if (hasValue) {
        const pair = item as PyTuple;
        values.set(as, pair[0]);
        values.set(`${as}_value`, pair[1]);
      } else {
        values.set(as, item);
        values.set(`${as}_value`, item);
      }
      values.set(`${as}_first`, index === 0);
      if (size !== null) values.set(`${as}_last`, index + 1 === size);
      values.set(`${as}_odd`, index % 2);
      values.set(`${as}_even`, index % 2 === 0);
      values.set(`${as}_parity`, index % 2 === 1 ? "odd" : "even");
      const iterFlags: Flags = { ...flags, attrs: null };
      await this.renderDirectives(view, iterFlags, values, next);
      this.leftAttrs = null;
      this.flush(true);
    }
  }

  /** `_compile_directive_call_assets` (2750-2799). */
  private directiveCallAssets(view: ElView, values: Scope): void {
    if (view.el.children.some(isElement)) throw new Error("t-call-assets cannot contain children nodes");
    this.flush();
    const call: AssetCall = {
      bundle: view.attrib.get("t-call-assets") ?? "",
      css: compileBool(view.attrib.get("t-css"), true),
      js: compileBool(view.attrib.get("t-js"), true),
      binary: compileBool(view.attrib.get("t-binary"), false),
      autoprefix: compileBool(view.attrib.get("t-autoprefix"), false),
    };
    const links = this.templates.assets.get(assetCallKey(call));
    if (links === undefined) throw new NotPorted(`t-call-assets ${call.bundle} was not preloaded`);
    if (links instanceof NotPorted) throw links;
    const debug = pyStr(values.get("debug") ?? "");
    if (debug.includes("assets")) throw new NotPorted("debug=assets bundles");
    const nodes = assetNodes(links, call, {
      deferLoad: compileBool(view.attrib.get("defer_load"), false),
      lazyLoad: compileBool(view.attrib.get("lazy_load"), false),
      media: view.attrib.get("media") ?? null,
    });
    nodes.forEach(([tagName, attrs], index) => {
      if (index > 0) this.out.push("\n        ");
      this.out.push("<", tagName);
      for (const [name, value] of attrs) {
        if (value !== null && (value !== "" || typeof value === "string")) this.out.push(` ${escape(name).toString()}="${escape(value).toString()}"`);
      }
      if (VOID_ELEMENTS.has(tagName)) this.out.push("/>");
      else this.out.push(">", "</", tagName, ">");
    });
  }

  /** `_compile_directive_call` (2640-2742). */
  private async directiveCall(view: ElView, flags: Flags, values: Scope): Promise<void> {
    const expr = view.attrib.get("t-call") ?? "";
    if (view.el.tag !== "t") throw new Error(`t-call must be on a <t> element (actually on <${view.el.tag}>).`);
    this.flush(true);
    const callValues: Scope = new Map();
    const hasBody = view.el.children.length > 0 || (view.text !== null && view.text !== "");
    if (hasBody) {
      const snapshot: Scope = new Map(values);
      callValues.set(T_CALL_SLOT, await this.content(() => this.capture(async () => {
        await this.renderInnerContent(view, snapshot);
        this.appendText("");
      }, true)));
    } else {
      callValues.set(T_CALL_SLOT, "");
    }
    for (const [key, value] of view.attrib) {
      if (key.endsWith(".f")) callValues.set(key.slice(0, -2), await this.format(value, values));
      else if (key.endsWith(".translate")) callValues.set(key.slice(0, -10).replace(/\.f$/, ""), await this.format(value, values));
      else if (!key.startsWith("t-")) callValues.set(key, await evalExprAsync(value, values));
      else if (key === "t-args") {
        const v = await evalExprAsync(value, values);
        for (const [k, val] of attsEntries(v)) callValues.set(pyStr(k), val);
      }
    }
    // QwebCallParameters with options (t-lang): the callee renders in that language
    const lang = flags.options?.get("lang");
    const otherLang = pyBool(lang) && pyStr(lang) !== (this.opts.lang ?? "en_US") ? pyStr(lang) : null;
    if (otherLang !== null && this.opts.callInLang === undefined) throw new NotPorted(`t-lang to another language (${otherLang})`);
    let template: string | number = /^\d+$/.test(expr) ? parseInt(expr, 10) : await this.format(expr, values);
    if (typeof template === "string" && FORMAT_REGEX.test(expr) && /^\d+$/.test(template)) template = parseInt(template, 10);
    FORMAT_REGEX.lastIndex = 0;
    // QwebCallParameters with scope=True (2740, 834-841): a copy of the caller's values updated with the arguments
    const calleeValues: Scope = new Map(values);
    for (const [k, v] of callValues) calleeValues.set(k, v);
    if (otherLang !== null) {
      if (++this.depth > 50) throw new Error("Qweb template infinite recursion");
      try {
        this.out.push(await this.opts.callInLang!(otherLang, template, calleeValues));
      } finally {
        this.depth--;
      }
      return;
    }
    this.out.push(await this.renderTemplate(template, calleeValues));
  }

  /** `_compile_directive_att` (1992-2079). */
  private async directiveAtt(view: ElView, flags: Flags, values: Scope): Promise<void> {
    const el = view.el;
    // an invisible <t> only consumes attributes through a widget (t-options, 2013-2020), which is NotPorted anyway
    if (el.tag === "t") return;
    const attrs = new Map<string, unknown>();
    let created = false;
    for (const [key, value] of view.attrib) {
      // `groups` was popped by _compile_directive_groups (ir_qweb.py:2363)
      if (!key.startsWith("t-") && key !== "groups") {
        attrs.set(key.endsWith(".translate") ? key.slice(0, -10) : key, value);
        created = true;
      }
    }
    for (const [key, value] of view.attrib) {
      if (key.startsWith("t-attf-")) {
        attrs.set(key.slice(7), await this.format(value, values));
        created = true;
      } else if (key.startsWith("t-att-")) {
        attrs.set(key.slice(6), await evalExprAsync(value, values));
        created = true;
      } else if (key === "t-att") {
        for (const [k, v] of attsEntries(await evalExprAsync(value, values))) attrs.set(pyStr(k), v);
        created = true;
      }
    }
    if (created) {
      flags.attrs = attrs;
      this.leftAttrs = null;
    }
  }

  /** `_compile_directive_tag_open` (2081-2133). */
  private tagOpen(view: ElView, flags: Flags): void {
    if (flags.tagOpen === null) return;
    this.appendText(`<${flags.tagOpen}`);
    if (flags.attrs === null && this.leftAttrs !== null && this.leftAttrs.size) flags.attrs = this.leftAttrs;
    this.leftAttrs = null;
    if (flags.attrs !== null) {
      this.flush();
      for (const [name, value] of postProcessingAtt(flags.attrs)) {
        if (pyBool(value) || typeof value === "string" || value instanceof Markup) {
          this.out.push(` ${escape(pyStr(name)).toString()}="${escape(pyStr(value)).toString()}"`);
        }
      }
      flags.attrs = null;
    }
    this.appendText(flags.tagClose !== null ? ">" : "/>");
    flags.tagOpen = null;
  }

  /** `_compile_directive_set` (2144-2208). */
  private async directiveSet(view: ElView, flags: Flags, values: Scope): Promise<void> {
    this.flush(view.el.tag.toLowerCase() === "t");
    const varname = view.attrib.get("t-set") ?? "";
    if (varname === "") throw new Error("KeyError: 't-set'");
    if (varname !== T_CALL_SLOT && varname[0] !== "{" && !VARNAME_REGEXP.test(varname)) throw new Error("The varname can only contain alphanumeric characters and underscores.");
    if (varname.includes("__")) throw new Error(`Using variable names with '__' is not allowed: '${varname}'`);
    const attrib = view.attrib;
    if (attrib.has("t-value") || attrib.has("t-valuef") || attrib.has("t-valuef.translate") || varname[0] === "{") {
      flags.innerContent = false; // the content is considered empty
      if (varname === T_CALL_SLOT) throw new Error('t-set="0" should not be set from t-value or t-valuef');
    }
    if (attrib.has("t-value")) {
      const expr = attrib.get("t-value") ?? "";
      values.set(varname, await evalExprAsync(expr === "" ? "None" : expr, values));
    } else if (attrib.has("t-valuef")) {
      values.set(varname, await this.format(attrib.get("t-valuef") ?? "", values));
    } else if (attrib.has("t-valuef.translate")) {
      values.set(varname, await this.format(attrib.get("t-valuef.translate") ?? "", values));
    } else if (varname[0] === "{") {
      for (const [k, v] of attsEntries(await evalExprAsync(varname, values))) values.set(pyStr(k), v);
    } else {
      // the body is the value (2186-2206): a QwebContent over a copy of the values; '' when there is no content
      const hasContent = (view.text !== null && view.text !== "") || view.el.children.some((c) => c.kind === "element" || (c.tail !== null && c.tail !== ""));
      flags.innerContent = false;
      if (hasContent) {
        const snapshot: Scope = new Map(values);
        values.set(varname, await this.content(() => this.capture(() => this.renderInnerContent(view, snapshot), false)));
      } else {
        values.set(varname, "");
      }
    }
  }

  /** `_compile_directive_options` (1962-1990): the options of the node. */
  private async directiveOptions(view: ElView, flags: Flags, values: Scope): Promise<void> {
    const attrib = view.attrib;
    const named = [...attrib.keys()].filter((k) => k.startsWith("t-options-"));
    const lang = attrib.get("t-lang");
    if (!attrib.has("t-options") && named.length === 0 && lang === undefined) return;
    const options = new Map<unknown, unknown>();
    const base = attrib.get("t-options");
    if (base !== undefined) {
      const v = await evalExprAsync(base, values);
      if (!isDict(v)) throw new NotPorted(`t-options that is not a dict on <${view.el.tag}>`);
      for (const [k, val] of dictEntries(v)) options.set(k, val);
    }
    for (const key of named) options.set(key.slice(10), await evalExprAsync(attrib.get(key)!, values));
    if (lang !== undefined) options.set("lang", await evalExprAsync(lang, values));
    flags.options = options;
  }

  /** The tag with its content or its default body (the end of `_compile_directive_out`, 2570-2612). */
  private async outContent(view: ElView, flags: Flags, values: Scope, content: unknown, forceDisplay: boolean, dependent: boolean): Promise<void> {
    if (!isNone(content) && content !== false) {
      this.tagOpen(view, flags);
      this.flush();
      this.out.push(content instanceof Markup ? content.__html__() : escape(content).toString());
      if (flags.tagClose !== null) this.appendText(`</${flags.tagClose}>`);
      this.flush();
      return;
    }
    const hasDefault = (view.text !== null && view.text !== "") || view.el.children.some((c) => c.kind === "element" || (c.tail !== null && c.tail !== ""));
    if (hasDefault) {
      this.tagOpen(view, flags);
      this.flush();
      await this.renderInnerContent(view, values);
      this.flush();
      if (flags.tagClose !== null) this.appendText(`</${flags.tagClose}>`);
      this.flush();
    } else if (forceDisplay) {
      this.tagOpen(view, flags);
      this.flush();
      if (flags.tagClose !== null) this.appendText(`</${flags.tagClose}>`);
      this.flush();
    } else if (dependent) {
      this.leftAttrs = null; // `else: attrs = None` (2612)
    } else if (flags.attrs !== null) {
      this.leftAttrs = flags.attrs;
    }
  }

  private mergeAttrs(flags: Flags, attrs: Readonly<Record<string, unknown>>): void {
    if (flags.attrs === null && this.leftAttrs !== null) flags.attrs = this.leftAttrs;
    this.leftAttrs = null;
    if (Object.keys(attrs).length === 0) return;
    flags.attrs = flags.attrs ?? new Map<string, unknown>();
    for (const [k, v] of Object.entries(attrs)) flags.attrs.set(k, v);
  }

  /** `_compile_directive_field` (2616-2640) through `_compile_directive_out`. */
  private async directiveField(view: ElView, flags: Flags, values: Scope): Promise<void> {
    const expr = view.attrib.get("t-field") ?? "";
    if (["table", "tbody", "thead", "tfoot", "tr", "td", "li", "ul", "ol", "dl", "dt", "dd"].includes(view.el.tag)) throw new Error(`QWeb widgets do not work correctly on '${view.el.tag}' elements`);
    if (view.el.tag === "t") throw new Error("t-field can not be used on a t element, provide an actual HTML node");
    const dot = expr.lastIndexOf(".");
    if (dot < 0) throw new Error("t-field must have at least a dot like 'record.field_name'");
    if (this.opts.field === undefined) throw new NotPorted(`t-field="${expr}" without a field renderer`);
    this.flush();
    const record = await evalExprAsync(expr.slice(0, dot), values);
    const r = await this.opts.field(record, expr.slice(dot + 1), expr, view.el.tag, flags.options ?? new Map(), values);
    this.mergeAttrs(flags, r.attrs);
    const content = isNone(r.content) || r.content === false ? r.content : r.content instanceof Markup ? r.content : compileToStr(r.content);
    await this.outContent(view, flags, values, content, r.forceDisplay, true);
  }

  /** `_compile_directive_out` (2467-2614). */
  private async directiveOut(view: ElView, flags: Flags, values: Scope): Promise<void> {
    const expr = view.attrib.get("t-out") ?? "";
    this.flush();
    const isSlot = expr === T_CALL_SLOT && flags.options === null;
    if (isSlot) {
      this.tagOpen(view, flags);
      this.flush();
      const slot = values.get(T_CALL_SLOT);
      this.out.push(isNone(slot) ? "" : slot instanceof Markup ? slot.toString() : pyStr(slot));
      if (flags.tagClose !== null) this.appendText(`</${flags.tagClose}>`);
      this.flush();
      return;
    }
    let content = expr === T_CALL_SLOT ? values.get(T_CALL_SLOT) ?? "" : await evalExprAsync(expr, values);
    let forceDisplay = false;
    const dependent = flags.options !== null;
    if (flags.options !== null) {
      if (!flags.options.has("widget")) {
        // without a widget the options are only consumed (`_get_widget` needs field_options['widget'])
        throw new NotPorted(`t-options without a widget on t-out="${expr}"`);
      }
      if (this.opts.widget === undefined) throw new NotPorted(`t-out="${expr}" with a widget without a widget renderer`);
      const r = await this.opts.widget(content, expr, view.el.tag, flags.options, values);
      this.mergeAttrs(flags, r.attrs);
      content = r.content instanceof Markup ? r.content : compileToStr(r.content);
      forceDisplay = r.forceDisplay;
    }
    await this.outContent(view, flags, values, content, forceDisplay, dependent);
  }

  /** `_compile_format` (1482-1498): `#{expr}` / `{{expr}}` substituted with `_compile_to_str(value)`. */
  private async format(expr: string, values: Scope): Promise<string> {
    let out = "";
    let last = 0;
    for (const m of expr.matchAll(FORMAT_REGEX)) {
      out += expr.slice(last, m.index) + compileToStr(await evalExprAsync((m[1] ?? m[2])!, values));
      last = m.index + m[0].length;
    }
    return out + expr.slice(last);
  }
}

/** The element being rendered, with the attributes and text the compile step may have altered (root). */
interface ElView {
  readonly el: Element;
  readonly attrib: Map<string, string>;
  readonly text: string | null;
}

/** `attrs.update(...)` of t-att / t-args (2064-2074, 2726-2736): a dict, a (name, value) pair, or pairs. */
function attsEntries(v: unknown): [unknown, unknown][] {
  if (isDict(v)) return dictEntries(v);
  if (Array.isArray(v)) {
    if (v.length > 0 && !Array.isArray(v[0])) return [[v[0], v[1]]];
    return v.map((pair) => {
      const p = pair as unknown[];
      return [p[0], p[1]];
    });
  }
  if (isNone(v)) return [];
  throw new Error(`TypeError: '${typeof v}' object is not iterable`);
}

/** Render `ref` with the preloaded templates (`_render`, 711-762: `true`/`false` are always set). */
export function render(templates: TemplateSet, ref: string | number, values: Scope, opts: RenderOptions = {}): Promise<string> {
  values.set("true", true);
  values.set("false", false);
  if (values.has(T_CALL_SLOT)) values.delete(T_CALL_SLOT); // 739-741
  return new Renderer(templates, opts).renderTemplate(ref, values);
}

/** A t-call's callee rendered by another IrQweb (`callInLang`): the caller's values as given, the `0` slot kept. */
export function renderCall(templates: TemplateSet, ref: string | number, values: Scope, opts: RenderOptions = {}): Promise<string> {
  return new Renderer(templates, opts).renderTemplate(ref, values);
}
