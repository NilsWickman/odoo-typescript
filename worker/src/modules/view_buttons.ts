/**
 * Helpers of the view validation (src/modules/view_validate.ts): the view error with its context
 * (`_raise_view_error`, odoo/addons/base/models/ir_ui_view.py:831-852), which object-button names `_validate_tag_button`
 * (:2063-2101) accepts, and the partial-validation flags of `_add_validation_flag` (:907-951).
 *
 * Which names a button may use is generated from Odoo's classes by gen/button_names.py for poc_erp; on another template
 * a name that is not callable there refuses (NotPorted).
 */
import { NotPorted, ValidationError } from "../errors";
import type { Environment } from "../orm/types";
import { templateKey, templateOf } from "../orm/template";
import { withOverlay } from "../orm/overlay";
import { isElement, type Element } from "../xml";
import { pyStrRepr } from "../models/util";

/**
 * A view error with the context `_raise_view_error` attaches (ir_ui_view.py:844-852): the values as Python reprs.
 * `_check_xml` keeps it on the ValidationError (:536 `err.context = e.context`).
 */
export class ViewValidationError extends ValidationError {
  constructor(message: string, readonly context: Readonly<Record<string, string>>) {
    super(message);
  }
}

/** `pprint.pformat(dict)` (width 80, sorted keys) of reprs: one line when it fits, else one item per line. */
export function pformatDict(d: Readonly<Record<string, string>>): string {
  const items = Object.keys(d).sort().map((k) => `${pyStrRepr(k)}: ${d[k]}`);
  const one = `{${items.join(", ")}}`;
  if (one.length <= 80) return one;
  if (items.some((i) => i.length + 2 > 80)) throw new NotPorted("pprint of a view error context with a value wider than the line");
  return `{${items.join(",\n ")}}`;
}

interface ButtonNames {
  common: { ok: string[]; private: string[]; error: string[] };
  models: Record<string, { ok?: string[]; private?: string[]; error?: string[] }>;
}
let names: Promise<ButtonNames> | null = null;
const overlays = new Map<string, Promise<ButtonNames>>();

/** poc_erp's names, with an overlay template's models over them (gen/template_delta.py, src/orm/overlay.ts). */
async function namesOf(env: Environment): Promise<ButtonNames> {
  names ??= import("../../gen/out/poc_erp/button_names.json").then((m) => m.default as unknown as ButtonNames);
  const template = await templateOf(env.cr);
  if (!template.overlay || template.dir !== "poc_erp") return names;
  let p = overlays.get(templateKey(template));
  if (!p) {
    p = (async () => withOverlay(template, "button_names.json", await names!, "models"))();
    overlays.set(templateKey(template), p);
  }
  return p;
}

export type Verdict = "ok" | "private" | "invalid";

/** ir_ui_view.py:2078-2091: `getattr(model, name)` falsy -> not a valid action; `_x` or `_api_private` -> private. */
export async function verdict(env: Environment, model: string, name: string): Promise<Verdict> {
  const n = await namesOf(env);
  const own = n.models[model];
  if (own === undefined) throw new NotPorted(`button validation on model ${model} (gen/button_names.py)`);
  const has = (k: "ok" | "private" | "error"): boolean => n.common[k].includes(name) || (own[k]?.includes(name) ?? false);
  if (has("error")) throw new NotPorted(`button validation of ${model}.${name} (getattr raises)`);
  const v: Verdict = has("ok") ? "ok" : has("private") ? "private" : "invalid";
  // another template has more modules (more methods): only a name callable on poc_erp (or its overlay, generated from
  // that module set) is known to stay callable
  if (v !== "ok" && (await templateOf(env.cr)).dir !== "poc_erp") throw new NotPorted(`button validation of ${model}.${name} on another template`);
  return v;
}

/**
 * `_add_validation_flag(combined_arch, view, arch)` (:907-951) with `validate_view_ids` = [the view being validated],
 * for an inheriting `view` about to be applied: the elements it inserts, everything when it replaces, the element whose
 * attributes it changes. (The combine root being the validated view flags the root: src/views/combine.ts.)
 */
export function flagInheritingArch(combined: Element, arch: Element): void {
  for (const node of descendants(arch)) {
    const pos = node.attrib.get("position");
    if (pos === "after" || pos === "before" || pos === "inside") {
      for (const child of node.children) if (isElement(child) && !child.attrib.has("position")) child.attrib.set("__validate__", "1");
    }
    if (pos === "replace") {
      combined.attrib.set("__validate__", "1");
      break;
    }
    if (pos === "attributes") {
      const attr: Element = { kind: "element", tag: "attribute", attrib: new Map([["name", "__validate__"]]), text: "1", children: [], tail: null, parent: node };
      node.children.push(attr);
    }
  }
}

/** `arch.xpath('//*[@position]')`: the elements in document order, the root included. */
function descendants(root: Element): Element[] {
  const out: Element[] = [];
  const walk = (e: Element): void => {
    out.push(e);
    for (const c of e.children) if (isElement(c)) walk(c);
  };
  walk(root);
  return out;
}

/** :831-850 `_raise_view_error`: the error's `context` (without the line), which convert prints as "View error context" (convert.py:634-638). */
export function viewErrorContext(env: Environment, viewId: number, row: { name: string | null; model: string | null; inherit_id: number | null; xmlid: string | null } | undefined): Record<string, string> {
  const file = env.context["install_filename"];
  return {
    view: `ir.ui.view(${viewId},)`, name: row?.name === null || row?.name === undefined ? "None" : pyStrRepr(row.name), xmlid: pyStrRepr(row?.xmlid ?? ""),
    "view.model": row?.model ? pyStrRepr(row.model) : "False", "view.parent": row?.inherit_id ? `ir.ui.view(${row.inherit_id},)` : "ir.ui.view()",
    file: typeof file === "string" ? pyStrRepr(file) : "None",
  };
}
