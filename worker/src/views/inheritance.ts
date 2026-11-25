/**
 * Port of odoo/odoo/tools/template_inheritance.py (Odoo 20, commit dd5d3718): `locate_node` and
 * `apply_inheritance_specs` with positions inside, after, before, replace (outer and inner), attributes
 * (incl. add/remove/separator) and the nested `position="move"`. `inherit_branding` is not ported (website
 * editor only); `$0` replacement keeps the plain copy. Line numbers below refer to that file.
 */
import { NotPorted, ValidationError } from "../errors";
import {
  addNext,
  addPrevious,
  append,
  deepcopy,
  detach,
  element,
  getPrevious,
  insert,
  isElement,
  iter,
  precedingSiblings,
  type Element,
  type Node,
} from "../xml/node";
import { serializeXml } from "../xml/serialize";
import { xpath } from "./xpath";

/** `RSTRIP_REGEXP = re.compile(r'\n[ \t]*$')` (line 17). */
const RSTRIP_REGEXP = /\n[ \t]*$/;
/** Attribute names that contain Python expressions (line 20). */
const PYTHON_ATTRIBUTES = new Set(["readonly", "required", "invisible", "column_invisible", "t-if", "t-elif"]);

/** Python `str.rstrip()` (all whitespace). */
function rstrip(s: string): string {
  return s.replace(/[\s]+$/u, "");
}

/** Python `str.strip()`. */
function strip(s: string): string {
  return s.replace(/^[\s]+|[\s]+$/gu, "");
}

/** Python `str.split(sep)` with `sep=None` meaning "split on whitespace runs, no empty items". */
function pySplit(s: string, sep: string | null): string[] {
  if (sep === null) return s.split(/\s+/).filter((x) => x !== "");
  return s.split(sep);
}

/** `add_stripped_items_before(node, spec, extract)` (lines 23-49). */
function addStrippedItemsBefore(node: Node, spec: Element, extract: (spec: Element) => Element): void {
  const text = spec.text ?? "";
  let beforeText = "";
  // the previous sibling that is not the branding removal marker PI (we never create those)
  let prev: Node | null = null;
  for (const n of precedingSiblings(node)) {
    if (n.kind === "pi" && n.target === "apply-inheritance-specs-node-removal") continue;
    prev = n;
    break;
  }
  if (prev === null) {
    const parent = node.parent;
    if (parent === null) throw new Error("addStrippedItemsBefore: node has no parent");
    const result = parent.text !== null ? RSTRIP_REGEXP.exec(parent.text) : null;
    beforeText = result !== null ? result[0] : "";
    const fallbackText = spec.text === null ? null : "";
    const joined = rstrip(parent.text ?? "") + text;
    parent.text = joined !== "" ? joined : fallbackText;
  } else {
    const result = prev.tail !== null ? RSTRIP_REGEXP.exec(prev.tail) : null;
    beforeText = result !== null ? result[0] : "";
    prev.tail = rstrip(prev.tail ?? "") + text;
  }

  if (spec.children.length > 0) {
    const last = spec.children[spec.children.length - 1]!;
    last.tail = rstrip(last.tail ?? "") + beforeText;
  } else {
    spec.text = rstrip(spec.text ?? "") + beforeText;
  }

  for (let child of [...spec.children]) {
    if (child.kind === "element" && child.attrib.get("position") === "move") {
      const tail = child.tail;
      child = extract(child);
      child.tail = tail;
    }
    addPrevious(node, child);
  }
}

/** `add_text_before(node, text)` (lines 52-61). */
function addTextBefore(node: Node, text: string | null): void {
  if (text === null) return;
  const prev = getPrevious(node);
  if (prev !== null) {
    prev.tail = (prev.tail ?? "") + text;
  } else {
    const parent = node.parent;
    if (parent === null) throw new Error("addTextBefore: node has no parent");
    parent.text = rstrip(parent.text ?? "") + text;
  }
}

/** `remove_element(node)`: remove the node but keep its tail in place (lines 64-68). */
export function removeElement(node: Node): void {
  addTextBefore(node, node.tail);
  node.tail = null;
  detach(node);
}

/** `locate_node(arch, spec)` (lines 71-106). */
export function locateNode(arch: Element, spec: Element): Element | null {
  if (spec.tag === "xpath") {
    const expr = spec.attrib.get("expr");
    if (expr === undefined) throw new ValidationError("Missing 'expr' attribute in xpath specification");
    const nodes = xpath(arch, expr);
    return nodes[0] ?? null;
  }
  if (spec.tag === "field") {
    // Only compare the field name: a field can be only once in a given view at a given level (line 95)
    for (const node of iter(arch, "field")) {
      if (node.attrib.get("name") === spec.attrib.get("name")) return node;
    }
    return null;
  }
  for (const node of iter(arch, spec.tag)) {
    let all = true;
    for (const [attr, value] of spec.attrib) {
      if (attr === "position") continue;
      if (node.attrib.get(attr) !== value) {
        all = false;
        break;
      }
    }
    if (all) return node;
  }
  return null;
}

function specTag(spec: Element): string {
  const attrs = [...spec.attrib].filter(([a]) => a !== "position").map(([a, v]) => ` ${a}="${escapeHtml(v)}"`).join("");
  return `<${spec.tag}${attrs}>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[c] ?? c);
}

/**
 * `apply_inheritance_specs(source, specs_tree)` (lines 109-346). Mutates `source` and returns the (possibly new) root.
 * `ValueError`s of the original are raised as ValidationError (ir_ui_view.py:954-978 `_raise_view_error`).
 */
export function applyInheritanceSpecs(source: Element, specsTree: Element | Node[]): Element {
  const specs: Node[] = Array.isArray(specsTree) ? [...specsTree] : [specsTree];

  const extract = (spec: Element): Element => {
    if (spec.children.length > 0) {
      throw new ValidationError(`Invalid specification for moved nodes: “${serializeXml(spec, { withTail: false })}”`);
    }
    const toExtract = locateNode(source, spec);
    if (toExtract !== null) {
      removeElement(toExtract);
      return toExtract;
    }
    throw new ValidationError(`Element “${serializeXml(spec, { withTail: false })}” cannot be located in parent view`);
  };

  while (specs.length > 0) {
    const spec = specs.shift()!;
    if (!isElement(spec)) continue; // SKIPPED_ELEMENT_TYPES: comments, PIs (line 151)
    if (spec.tag === "data") {
      specs.push(...spec.children);
      continue;
    }
    const node = locateNode(source, spec);
    if (node === null) {
      throw new ValidationError(`Element '${specTag(spec)}' cannot be located in parent view`);
    }
    const pos = spec.attrib.get("position") ?? "inside";
    if (pos === "replace") {
      const mode = spec.attrib.get("mode") ?? "outer";
      if (mode === "outer") {
        // `.//*[text()='$0']`: descendants whose text is exactly "$0" get a copy of the replaced node (lines 163-172)
        for (const loc of iter(spec)) {
          if (loc !== spec && loc.text === "$0") {
            loc.text = "";
            append(loc, deepcopy(node));
          }
        }
        if (node.parent === null) {
          // replacing the root: the first non-comment child of the spec becomes the new root (lines 173-191)
          let specContent: Element | null = null;
          let commentNode: Node | null = null;
          for (const content of spec.children) {
            if (content.kind !== "comment") {
              if (content.kind === "element") specContent = content;
              break;
            } else {
              commentNode = content;
            }
          }
          if (specContent === null) throw new ValidationError("replace of the root node without a replacement element");
          source = deepcopy(specContent);
          const tName = node.attrib.get("t-name");
          if (tName !== undefined && tName !== "") source.attrib.set("t-name", tName);
          if (commentNode !== null) {
            const text = source.text;
            source.text = null;
            const c = deepcopy(commentNode);
            c.tail = text;
            insert(source, 0, c);
          }
        } else {
          for (let child of [...spec.children]) {
            if (child.kind === "element" && child.attrib.get("position") === "move") child = extract(child);
            addPrevious(node, child);
          }
          detach(node);
        }
      } else if (mode === "inner") {
        // keep the existing children behind a sentinel so they can be moved into the new content (lines 214-232)
        const sentinel = element("sentinel");
        if (node.children.length > 0) addPrevious(node.children[0]!, sentinel);
        else append(node, sentinel);
        node.text = null;
        addStrippedItemsBefore(sentinel, deepcopy(spec), extract);
        for (const child of [...node.children].reverse()) {
          detach(child);
          if (child === sentinel) break;
        }
      } else {
        throw new ValidationError(`Invalid mode attribute: “${mode}”`);
      }
    } else if (pos === "attributes") {
      for (const child of iter(spec, "attribute")) {
        const unknown = [...child.attrib.keys()].filter((k) => !["name", "add", "remove", "separator"].includes(k) && !k.startsWith("data-oe-"));
        if (unknown.length > 0) {
          throw new ValidationError(`Invalid attributes ${unknown.map((u) => `'${u}'`).join(", ")} in element <attribute>`);
        }
        const attribute = child.attrib.get("name");
        if (attribute === undefined) throw new ValidationError("<attribute> without name");
        let value: string;
        const add = child.attrib.get("add") ?? "";
        const remove = child.attrib.get("remove") ?? "";
        if (add !== "" || remove !== "") {
          if (child.text !== null && child.text !== "") {
            throw new ValidationError(`Element <attribute> with 'add' or 'remove' cannot contain text '${child.text}'`);
          }
          value = node.attrib.get(attribute) ?? "";
          let separator = child.attrib.get("separator") ?? null;
          if (PYTHON_ATTRIBUTES.has(attribute) || attribute.startsWith("decoration-")) {
            // attribute containing a python expression (lines 267-292)
            separator = strip(separator ?? "");
            if (separator !== "and" && separator !== "or") {
              throw new ValidationError(`Invalid separator '${separator}' for python expression '${attribute}'; valid values are 'and' and 'or'`);
            }
            if (remove !== "") {
              if (new RegExp(`^\\(*${remove}\\)*$`).test(value)) {
                value = "";
              } else {
                const patterns = [`(${remove}) ${separator} `, ` ${separator} (${remove})`, `${remove} ${separator} `, ` ${separator} ${remove}`];
                for (const pattern of patterns) {
                  const index = value.indexOf(pattern);
                  if (index !== -1) {
                    value = value.slice(0, index) + value.slice(index + pattern.length);
                    break;
                  }
                }
              }
            }
            if (add !== "") value = value !== "" ? `(${value}) ${separator} (${add})` : add;
          } else {
            // list-like attribute (classes, ...) (lines 294-304)
            if (separator === null) separator = ",";
            else if (separator === " ") separator = null; // squash spaces
            const values = pySplit(value, separator).map(strip);
            const toAdd = pySplit(add, separator).map(strip).filter((s) => s !== "");
            const toRemove = new Set(pySplit(remove, separator).map(strip));
            value = [...values.filter((v) => v !== "" && !toRemove.has(v)), ...toAdd].join(separator ?? " ");
          }
        } else {
          value = child.text ?? "";
        }
        if (value !== "") node.attrib.set(attribute, value);
        else node.attrib.delete(attribute);
      }
    } else if (pos === "inside") {
      const sentinel = element("sentinel");
      append(node, sentinel);
      addStrippedItemsBefore(sentinel, spec, extract);
      removeElement(sentinel);
    } else if (pos === "after") {
      const sentinel = element("sentinel");
      addNext(node, sentinel);
      if (node.tail !== null) {
        // for lxml >= 5.1 (line 324): the tail stays after the inserted content
        sentinel.tail = node.tail;
        node.tail = null;
      }
      addStrippedItemsBefore(sentinel, spec, extract);
      removeElement(sentinel);
    } else if (pos === "before") {
      addStrippedItemsBefore(node, spec, extract);
    } else {
      throw new ValidationError(`Invalid position attribute: '${pos}'`);
    }
  }
  return source;
}
