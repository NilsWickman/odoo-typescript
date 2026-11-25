/**
 * An lxml-shaped tree (`lxml.etree`): every element has `text` (before its first child) and `tail` (after its
 * closing tag); comments and processing instructions are children too. The tail belongs to the node it follows,
 * so moving or removing a node moves or removes its tail, exactly as lxml does (odoo/odoo/tools/template_inheritance.py
 * relies on that in `remove_element`, `add_stripped_items_before`).
 */

export interface Element {
  readonly kind: "element";
  tag: string;
  /** Insertion-ordered, like lxml's `attrib` (libxml2 keeps document order). */
  readonly attrib: Map<string, string>;
  text: string | null;
  readonly children: Node[];
  tail: string | null;
  parent: Element | null;
  /** libxml2's `node->line` (lxml `sourceline`), set by the parser: the line of the `>` that closes the start tag,
   * where libxml2's SAX start-element callback reads `ctxt->input->line`. */
  sourceline?: number;
}

export interface Comment {
  readonly kind: "comment";
  text: string;
  tail: string | null;
  parent: Element | null;
}

export interface ProcessingInstruction {
  readonly kind: "pi";
  target: string;
  text: string;
  tail: string | null;
  parent: Element | null;
}

export type Node = Element | Comment | ProcessingInstruction;

export function element(tag: string, attrib?: Iterable<readonly [string, string]>): Element {
  return { kind: "element", tag, attrib: new Map(attrib ?? []), text: null, children: [], tail: null, parent: null };
}

export function comment(text: string): Comment {
  return { kind: "comment", text, tail: null, parent: null };
}

export function pi(target: string, text: string): ProcessingInstruction {
  return { kind: "pi", target, text, tail: null, parent: null };
}

export function isElement(n: Node | null | undefined): n is Element {
  return n !== null && n !== undefined && n.kind === "element";
}

/** Detach `node` (with its tail) from its parent; `lxml` `parent.remove(node)`. */
export function detach(node: Node): void {
  const p = node.parent;
  if (p === null) return;
  const i = p.children.indexOf(node);
  if (i >= 0) p.children.splice(i, 1);
  node.parent = null;
}

/** `parent.append(child)`: moves `child` (with its tail) to the end. */
export function append(parent: Element, child: Node): void {
  detach(child);
  child.parent = parent;
  parent.children.push(child);
}

/** `parent.insert(index, child)`. */
export function insert(parent: Element, index: number, child: Node): void {
  detach(child);
  child.parent = parent;
  parent.children.splice(index, 0, child);
}

/** `node.addprevious(sibling)`: moves `sibling` (with its tail) right before `node`. */
export function addPrevious(node: Node, sibling: Node): void {
  const p = node.parent;
  if (p === null) throw new Error("addPrevious: node has no parent");
  detach(sibling);
  sibling.parent = p;
  p.children.splice(p.children.indexOf(node), 0, sibling);
}

/** `node.addnext(sibling)` of lxml >= 5.1: inserted after `node`, the tail of `node` stays with `node`. */
export function addNext(node: Node, sibling: Node): void {
  const p = node.parent;
  if (p === null) throw new Error("addNext: node has no parent");
  detach(sibling);
  sibling.parent = p;
  p.children.splice(p.children.indexOf(node) + 1, 0, sibling);
}

export function getPrevious(node: Node): Node | null {
  const p = node.parent;
  if (p === null) return null;
  const i = p.children.indexOf(node);
  return i > 0 ? (p.children[i - 1] ?? null) : null;
}

export function getNext(node: Node): Node | null {
  const p = node.parent;
  if (p === null) return null;
  const i = p.children.indexOf(node);
  return p.children[i + 1] ?? null;
}

/** `node.itersiblings(preceding=True)`: previous siblings, nearest first. */
export function* precedingSiblings(node: Node): Generator<Node> {
  const p = node.parent;
  if (p === null) return;
  for (let i = p.children.indexOf(node) - 1; i >= 0; i--) {
    const c = p.children[i];
    if (c !== undefined) yield c;
  }
}

/** Child elements only (lxml `iterchildren(tag=etree.Element)`). */
export function childElements(el: Element): Element[] {
  return el.children.filter(isElement);
}

/** `el.iter(tag?)`: the element itself and all descendant elements in document order. */
export function* iter(el: Element, tag?: string): Generator<Element> {
  if (tag === undefined || el.tag === tag) yield el;
  for (const c of el.children) if (c.kind === "element") yield* iter(c, tag);
}

/** `copy.deepcopy(node)`: a detached copy (lxml copies the tail too). */
export function deepcopy<T extends Node>(node: T): T {
  if (node.kind === "element") {
    const e = element(node.tag, node.attrib);
    e.text = node.text;
    e.tail = node.tail;
    for (const c of node.children) append(e, deepcopy(c));
    return e as T;
  }
  if (node.kind === "comment") {
    const c = comment(node.text);
    c.tail = node.tail;
    return c as T;
  }
  const p = pi(node.target, node.text);
  p.tail = node.tail;
  return p as T;
}

/** `etree.ElementTree.getpath(el)`-style path for error messages (tag[index] per level). */
export function getPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur !== null) {
    const parent: Element | null = cur.parent;
    if (parent === null) {
      parts.unshift(`/${cur.tag}`);
    } else {
      const same = childElements(parent).filter((c) => c.tag === cur!.tag);
      parts.unshift(same.length > 1 ? `${cur.tag}[${same.indexOf(cur) + 1}]` : cur.tag);
    }
    cur = parent;
  }
  return parts.join("/").replace(/^\/\//, "/");
}
