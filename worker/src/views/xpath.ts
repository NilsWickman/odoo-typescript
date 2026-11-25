/**
 * The XPath subset `ir.ui.view` inheritance uses (`etree.ETXPath(expr)(arch)` in
 * odoo/odoo/tools/template_inheritance.py:84-93 `locate_node`). Supported, because these are the forms the poc_corpus
 * inherit specs contain (survey of `select arch_db from ir_ui_view where inherit_id is not null`):
 *   `.`                                    the context node (the arch root)
 *   `//step`, `//step/step`, `//a//b`      descendant-or-self from the document, then child/descendant steps
 *   `/step/...`                            absolute child steps from the document node (root element = first step)
 *   step = name | `*`, followed by predicates `[...]`:
 *     `@attr='v'` / `@attr="v"`, `@attr` (exists), `p1 and p2`, `p1 or p2`, `not(p)`,
 *     `n` (position), `last()`, `hasclass('a', 'b')`, `contains(@attr, 'v')`, `.//path` (existence)
 *   also `p1|p2` (union), a leading `./` or `.//` (relative to the arch root), the `..` parent step, `parent::name`
 * Anything else raises NotPorted with the expression. Positional predicates follow XPath 1.0: the position is the
 * node's index in the node-set selected by the step from one context node (e.g. `//form[1]` is every form that is
 * the first form child of its parent, `//form/div[1]`) and predicates apply left to right.
 */
import { NotPorted } from "../errors";
import { childElements, type Element } from "../xml/node";

type Predicate =
  | { kind: "attrEq"; name: string; value: string }
  | { kind: "attrNum"; name: string; value: number }
  | { kind: "attrExists"; name: string }
  | { kind: "and"; left: Predicate; right: Predicate }
  | { kind: "or"; left: Predicate; right: Predicate }
  | { kind: "not"; arg: Predicate }
  | { kind: "position"; n: number }
  | { kind: "last" }
  | { kind: "hasclass"; classes: string[] }
  | { kind: "contains"; name: string; value: string }
  /** `.//step...` / `./step...`: true when the relative location path selects a node (XPath boolean of a node-set),
   *  e.g. mail's `//div[hasclass('o_outlined')][.//field[@name='date_deadline']]`. */
  | { kind: "exists"; steps: Step[] };

interface Step {
  /** `descendant-or-self::node()/child::` when true (`//`), `child::` when false (`/`). */
  readonly deep: boolean;
  /** `ancestor::name` instead of the child axis (portal's `//button[...]//ancestor::setting`). */
  readonly ancestor?: boolean;
  /** `parent::name` instead of the child axis (project's `//field[@name='publisher_comment']/parent::div`). */
  readonly parent?: boolean;
  readonly name: string | "*";
  readonly predicates: Predicate[];
}

interface Path {
  readonly self: boolean; // `.`
  readonly steps: Step[];
  /** `./step` or `.//step`: relative to the context node (the arch root), not the document. */
  readonly relative?: boolean;
}

class XPathParser {
  pos = 0;
  constructor(readonly src: string) {}

  fail(what: string): never {
    throw new NotPorted(`xpath ${JSON.stringify(this.src)}: ${what} at ${this.pos}`);
  }

  ws(): void {
    while (this.src[this.pos] === " ") this.pos++;
  }

  eat(s: string): boolean {
    if (this.src.startsWith(s, this.pos)) {
      this.pos += s.length;
      return true;
    }
    return false;
  }

  name(): string {
    const m = /^[A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?/.exec(this.src.slice(this.pos));
    if (m === null) this.fail("expected a name");
    this.pos += m[0].length;
    return m[0];
  }

  literal(): string {
    const q = this.src[this.pos];
    if (q !== "'" && q !== '"') this.fail("expected a string literal");
    const end = this.src.indexOf(q, this.pos + 1);
    if (end < 0) this.fail("unterminated string literal");
    const s = this.src.slice(this.pos + 1, end);
    this.pos = end + 1;
    return s;
  }

  path(): Path {
    this.ws();
    if (this.src.startsWith("./", this.pos)) {
      this.pos += 1;
      return { self: false, steps: this.relativeSteps(), relative: true };
    }
    if (this.eat(".")) {
      this.ws();
      if (this.pos !== this.src.length && this.src[this.pos] !== "|") this.fail("only a bare `.` is supported");
      return { self: true, steps: [] };
    }
    const steps: Step[] = [];
    if (/^[A-Za-z_*]/.test(this.src.slice(this.pos))) {
      // a bare relative path (`field[@name='city']`, crm/report/crm_opportunity_report_views.xml): child steps of
      // the context node, i.e. `./field[...]`
      const name = this.eat("*") ? "*" : this.name();
      const predicates: Predicate[] = [];
      while (this.eat("[")) {
        predicates.push(this.orExpr());
        this.ws();
        if (!this.eat("]")) this.fail("expected `]`");
      }
      const first: Step = { deep: false, name, predicates };
      const rest = this.src.startsWith("/", this.pos) ? this.relativeSteps() : [];
      return { self: false, steps: [first, ...rest], relative: true };
    }
    if (!this.src.startsWith("/", this.pos)) this.fail("relative paths other than `.` are not supported");
    while (this.pos < this.src.length && this.src[this.pos] !== "|") {
      let deep = false;
      if (this.eat("//")) deep = true;
      else if (!this.eat("/")) this.fail("expected `/`");
      if (!deep && this.eat("..")) { steps.push({ deep: false, name: "..", predicates: [] }); continue; }
      const ancestor = this.eat("ancestor::");
      const parent = !ancestor && !deep && this.eat("parent::");
      const name = this.eat("*") ? "*" : this.name();
      const predicates: Predicate[] = [];
      while (this.eat("[")) {
        predicates.push(this.orExpr());
        this.ws();
        if (!this.eat("]")) this.fail("expected `]`");
      }
      if ((ancestor || parent) && predicates.some((p) => p.kind === "position" || p.kind === "last")) this.fail("positional predicates on the ancestor or parent axis");
      steps.push({ deep, name, predicates, ...(ancestor ? { ancestor } : {}), ...(parent ? { parent } : {}) });
    }
    return { self: false, steps };
  }

  /** Steps of a relative path inside a predicate, after its leading `.`: stops at `]`, `)`, a space or the end. */
  relativeSteps(): Step[] {
    const steps: Step[] = [];
    while (this.src.startsWith("/", this.pos)) {
      const deep = this.eat("//") || (this.eat("/") && false);
      if (!deep && this.eat("..")) { steps.push({ deep: false, name: "..", predicates: [] }); continue; }
      const name = this.eat("*") ? "*" : this.name();
      const predicates: Predicate[] = [];
      while (this.eat("[")) {
        predicates.push(this.orExpr());
        this.ws();
        if (!this.eat("]")) this.fail("expected `]`");
      }
      steps.push({ deep, name, predicates });
    }
    if (steps.length === 0) this.fail("expected a relative path after `.`");
    return steps;
  }

  orExpr(): Predicate {
    let left = this.andExpr();
    for (;;) {
      this.ws();
      if (/^or\b/.test(this.src.slice(this.pos))) {
        this.pos += 2;
        left = { kind: "or", left, right: this.andExpr() };
      } else return left;
    }
  }

  andExpr(): Predicate {
    let left = this.primary();
    for (;;) {
      this.ws();
      if (/^and\b/.test(this.src.slice(this.pos))) {
        this.pos += 3;
        left = { kind: "and", left, right: this.primary() };
      } else return left;
    }
  }

  primary(): Predicate {
    this.ws();
    if (this.eat("@")) {
      const name = this.name();
      this.ws();
      if (this.eat("=")) {
        this.ws();
        // `@attr=70`: XPath 1.0 compares the attribute as a number (portal's `@name=%(xmlid)d` after substitution)
        const n = /^-?\d+(\.\d+)?/.exec(this.src.slice(this.pos));
        if (n !== null) {
          this.pos += n[0].length;
          return { kind: "attrNum", name, value: Number(n[0]) };
        }
        return { kind: "attrEq", name, value: this.literal() };
      }
      return { kind: "attrExists", name };
    }
    const num = /^\d+/.exec(this.src.slice(this.pos));
    if (num !== null) {
      this.pos += num[0].length;
      return { kind: "position", n: parseInt(num[0], 10) };
    }
    if (this.eat("last()")) return { kind: "last" };
    if (this.src.startsWith("./", this.pos)) {
      this.pos += 1;
      return { kind: "exists", steps: this.relativeSteps() };
    }
    if (this.eat("not(")) {
      const arg = this.orExpr();
      this.ws();
      if (!this.eat(")")) this.fail("expected `)`");
      return { kind: "not", arg };
    }
    if (this.eat("hasclass(")) {
      const classes: string[] = [];
      for (;;) {
        this.ws();
        classes.push(this.literal());
        this.ws();
        if (this.eat(",")) continue;
        if (this.eat(")")) break;
        this.fail("expected `,` or `)` in hasclass()");
      }
      return { kind: "hasclass", classes };
    }
    if (this.eat("contains(")) {
      this.ws();
      if (!this.eat("@")) this.fail("contains() is only supported on an attribute");
      const name = this.name();
      this.ws();
      if (!this.eat(",")) this.fail("expected `,` in contains()");
      this.ws();
      const value = this.literal();
      this.ws();
      if (!this.eat(")")) this.fail("expected `)`");
      return { kind: "contains", name, value };
    }
    if (/^[A-Za-z_*]/.test(this.src.slice(this.pos)) && !/^(and|or)\b/.test(this.src.slice(this.pos))) {
      // a bare relative path (`group[group[@name='legal_notes']]`, l10n_us_account): true when it selects a node
      const name = this.eat("*") ? "*" : this.name();
      const predicates: Predicate[] = [];
      while (this.eat("[")) {
        predicates.push(this.orExpr());
        this.ws();
        if (!this.eat("]")) this.fail("expected `]`");
      }
      const rest = this.src.startsWith("/", this.pos) ? this.relativeSteps() : [];
      return { kind: "exists", steps: [{ deep: false, name, predicates }, ...rest] };
    }
    this.fail("unsupported predicate");
  }
}

function test(p: Predicate, el: Element, position: number, size: number): boolean {
  switch (p.kind) {
    case "attrEq":
      return el.attrib.get(p.name) === p.value;
    case "attrNum": {
      // number(@attr) = n: a missing attribute selects nothing; a non-numeric one is NaN
      const v = el.attrib.get(p.name);
      return v !== undefined && v.trim() !== "" && Number(v) === p.value;
    }
    case "attrExists":
      return el.attrib.has(p.name);
    case "and":
      return test(p.left, el, position, size) && test(p.right, el, position, size);
    case "or":
      return test(p.left, el, position, size) || test(p.right, el, position, size);
    case "not":
      return !test(p.arg, el, position, size);
    case "position":
      return position === p.n;
    case "last":
      return position === size;
    case "hasclass": {
      // odoo/odoo/tools/xml_utils.py / ir_ui_view.py `hasclass`: every class present in the class attribute
      const classes = (el.attrib.get("class") ?? "").split(/\s+/).filter((c) => c !== "");
      return p.classes.every((c) => classes.includes(c));
    }
    case "contains":
      return (el.attrib.get(p.name) ?? "").includes(p.value);
    case "exists":
      return selectSteps([el], p.steps).length > 0;
    default: {
      const never: never = p;
      return never;
    }
  }
}

/** Document order of `root` and its descendants, used to sort node-set unions. */
function documentOrder(root: Element): Map<Element, number> {
  const order = new Map<Element, number>();
  const walk = (el: Element): void => {
    order.set(el, order.size);
    for (const c of childElements(el)) walk(c);
  };
  walk(root);
  return order;
}

function* descendantsOrSelf(el: Element): Generator<Element> {
  yield el;
  for (const c of childElements(el)) yield* descendantsOrSelf(c);
}

/** Apply location steps to context nodes (`null` = the document node, whose only child is `root`). */
function selectSteps(start: (Element | null)[], steps: readonly Step[], root?: Element, orderIn?: Map<Element, number>): (Element | null)[] {
  let contexts = start;
  const order = orderIn ?? new Map<Element, number>();
  for (const step of steps) {
    const selected = new Set<Element>();
    for (const ctx of contexts) {
      if (ctx === null && root === undefined) continue;
      // `..` (abbreviated parent::node()): the parent element; the root's parent is the document (dropped)
      if (step.name === "..") {
        if (ctx !== null && ctx.parent !== null) selected.add(ctx.parent);
        continue;
      }
      if (step.parent) {
        const up = ctx?.parent ?? null;
        if (up !== null && (step.name === "*" || up.tag === step.name) && step.predicates.every((pred) => test(pred, up, 0, 0))) selected.add(up);
        continue;
      }
      // `ancestor::name` (after `/` the context's ancestors; after `//` those of its descendants-or-self)
      if (step.ancestor) {
        if (ctx === null) continue;
        for (const base of step.deep ? descendantsOrSelf(ctx) : [ctx]) {
          for (let a = base.parent; a !== null; a = a.parent) {
            if ((step.name === "*" || a.tag === step.name) && step.predicates.every((pred) => test(pred, a!, 0, 0))) selected.add(a);
          }
        }
        continue;
      }
      // the nodes whose children the step selects from
      const bases: (Element | null)[] = step.deep ? [ctx, ...(ctx === null ? descendantsOrSelf(root as Element) : [...descendantsOrSelf(ctx)].slice(1))] : [ctx];
      for (const base of bases) {
        let set = (base === null ? [root as Element] : childElements(base)).filter((c) => step.name === "*" || c.tag === step.name);
        for (const pred of step.predicates) {
          const size = set.length;
          set = set.filter((el, i) => test(pred, el, i + 1, size));
        }
        for (const el of set) selected.add(el);
      }
    }
    contexts = orderIn === undefined ? [...selected] : [...selected].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }
  return contexts;
}

/**
 * Evaluate `expr` against the tree whose root element is `root`, like `etree.ETXPath(expr)(root)`: `//` and `/`
 * are relative to the document, so the root element itself is a candidate. Returns elements in document order.
 */
export function xpath(root: Element, expr: string): Element[] {
  // `p1|p2`: the union of the paths' node-sets in document order (XPath 1.0 union operator)
  const parser = new XPathParser(expr);
  const paths: Path[] = [];
  for (;;) {
    paths.push(parser.path());
    parser.ws();
    if (!parser.eat("|")) break;
  }
  if (parser.pos !== expr.length) parser.fail("trailing input");
  const order = documentOrder(root);
  const out = new Set<Element>();
  for (const path of paths) {
    if (path.self) { out.add(root); continue; }
    // the document node is the context of the first step; `null` stands for it (its only child is `root`)
    for (const c of selectSteps([path.relative ? root : null], path.steps, root, order)) if (c !== null) out.add(c);
  }
  return [...out].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}
