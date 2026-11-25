/**
 * `ir.ui.view.create` (odoo/addons/base/models/ir_ui_view.py:606-654) for views created from data files and the
 * client: the type from the arch's root tag, the default name and qweb key, `arch` stored as `arch_db` with
 * `arch_prev`, `_compute_defaults` (the mode from inherit_id), then `_check_xml` with partial validation.
 *
 * `_check_xml` (:441-) is ported as far as the Worker's view code goes: the inheritance must resolve
 * (`_get_combined_arch`), the buttons must pass `_validate_tag_button` (src/modules/view_buttons.ts) and a non-qweb
 * view must postprocess like `get_views` does. Odoo's other checks of `_validate_view` (field attributes, group names,
 * action buttons, ...) are not ported, so an arch Odoo refuses for one of those reasons is accepted here.
 */
import { loadingFromAddons } from "./install";
import { UserError, ValidationError } from "../errors";
import { registerOverrides } from "../orm/write";
import type { Environment } from "../orm/types";
import { NotPorted } from "../errors";
import { isElement, parseXml, serializeXml, type Element } from "../xml";
import { combinedArchTree } from "../views/combine";
import { postprocess } from "../views/postprocess";
import { loadView } from "../web/get_views";
import { viewErrorContext } from "./view_buttons";
import { validateView } from "./view_validate";
import { validView } from "./relaxng";

async function viewTypes(env: Environment): Promise<string[]> {
  return (await env.cr.query<{ value: string }>(
    `SELECT s.value FROM ir_model_fields_selection s JOIN ir_model_fields f ON f.id = s.field_id
      WHERE f.model = 'ir.ui.view' AND f.name = 'type' ORDER BY s.sequence, s.id`)).rows.map((r) => r.value);
}

function rootTag(arch: unknown): string | null {
  if (typeof arch !== "string") return null;
  try {
    return parseXml(arch).tag;
  } catch {
    return null; // :629-633 a parse error is left to _check_xml
  }
}

/**
 * `arch_db` is `fields.Text(translate=xml_translate)`: the cache value is `xml_translate(lambda t: None, value)`
 * (fields_textual.py:141-145, tools/translate.py:383-399), i.e. `etree.tostring(etree.fromstring(value))`: no XML
 * declaration, nothing after the root element.
 */
export function xmlTranslateNormalize(value: unknown): unknown {
  if (typeof value !== "string" || !value) return value;
  let root: Element;
  try {
    root = parseXml(value.replace(/^\s*<\?xml[^>]*\?>/, ""));
  } catch {
    throw new NotPorted("xml_translate of a value that is not XML (the HTML parser fallback)");
  }
  return serializeXml(root, { withTail: false });
}

/** :575-581 `_compute_defaults` (for create, where `self` is empty). */
function computeDefaults(values: Record<string, unknown>): void {
  if ("inherit_id" in values && !("mode" in values)) values["mode"] = values["inherit_id"] ? "extension" : "primary";
}

/**
 * `_check_xml` (:441-547): the inheritance resolves, `_validate_view` (src/modules/view_validate.ts) passes on the
 * combined arch, no `attrs`/`states` (:503-510), and the arch fits its RELAX NG schema (`valid_view`, :515-527). With
 * `partial` (create's `ir_ui_view_partial_validation`) only the view's own nodes are validated; otherwise (write) the
 * whole combined arch is. A non-qweb view must then also postprocess like `get_views` does (the port's own check: a
 * view it could not render refuses here rather than later).
 */
export async function checkXml(env: Environment, ids: readonly number[], partial = true): Promise<void> {
  for (const id of ids) {
    const v = (await env.cr.query<{ type: string; model: string | null; inherit_id: number | null; arch: string | null; name: string | null; key: string | null; arch_fs: string | null; xmlid: string | null }>(
      `SELECT type, model, inherit_id, arch_db->>'en_US' AS arch, name, key, arch_fs,
              (SELECT d.module || '.' || d.name FROM ir_model_data d WHERE d.model = 'ir.ui.view' AND d.res_id = v.id ORDER BY d.id LIMIT 1) AS xmlid
         FROM ir_ui_view v WHERE id = $1`, [id])).rows[0];
    if (!v) continue;
    if (partial && !v.arch) continue; // :451 partial validation skips views without arch
    let combined: Element;
    try {
      parseXml(v.arch ?? "<data/>");
      combined = await combinedArchTree(env.cr, id, new Set());
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      throw new ValidationError(e instanceof Error ? e.message : String(e));
    }
    if (v.type === "qweb") continue;
    if (!v.model) throw new NotPorted(`_check_xml of the ${v.type} view ${id} without a model`);
    // :499 `view._validate_view(combined_arch, view.model)` on the combined arch with the validation flags; it takes
    // sub-views out of the arch it validates, which the checks after it then see without them
    const validated = await combinedArchTree(env.cr, id, new Set(), { validateId: partial ? id : true });
    await validateView(env, validated, v.model, { id, type: v.type, key: v.key, context: viewErrorContext(env, id, v) });
    const viewName = v.xmlid ? `${v.name} (${v.xmlid})` : `${v.name}`;
    const lang = typeof env.context["lang"] === "string" ? env.context["lang"] : "en_US";
    const any = (e: Element, attr: string): boolean => e.attrib.has(attr) || e.children.some((c) => isElement(c) && any(c, attr));
    if (any(validated, "attrs") || any(validated, "states")) {
      if (lang !== "en_US") throw new NotPorted(`view validation error in ${lang}: attrs and states`);
      throw new ValidationError(`Since 17.0, the "attrs" and "states" attributes are no longer used.\nView: ${viewName} in ${v.arch_fs || "False"}`);
    }
    // :515-527: each arch of a <data> wrapper, without the flags, against its schema
    const archs = validated.tag === "data" ? validated.children.filter(isElement) : [validated];
    for (const arch of archs) {
      const strip = (e: Element): void => { e.attrib.delete("__validate__"); for (const c of e.children) if (isElement(c)) strip(c); };
      strip(arch);
      if (!(await validView(arch))) {
        if (lang !== "en_US") throw new NotPorted(`view validation error in ${lang}: invalid view definition`);
        throw new ValidationError(`Invalid view ${viewName} definition in ${v.arch_fs || "False"}`);
      }
    }
    await postprocess(env, combined, v.model, async (m, t, i, ctx) => (await loadView(ctx ? env.withContext(ctx) : env, m, t, i)).arch);
  }
}

registerOverrides("ir.ui.view", {
  create: async (env, valsList, next) => {
    let types: string[] | null = null;
    for (const values of valsList) {
      if ("arch_db" in values && !values["arch_db"]) delete values["arch_db"];
      if (!values["type"]) {
        if (values["inherit_id"]) {
          values["type"] = (await env.cr.query<{ type: string }>("SELECT type FROM ir_ui_view WHERE id = $1", [values["inherit_id"]])).rows[0]?.type ?? false;
        } else {
          if (!values["arch"] && !values["arch_base"]) throw new ValidationError("Missing view architecture.");
          const tag = rootTag(values["arch"] || values["arch_base"]);
          if (tag !== null) {
            types ??= await viewTypes(env);
            if (!types.includes(tag)) {
              throw new ValidationError(`Invalid view type: '${tag}'.\nYou might have used an invalid starting tag in the architecture.\nAllowed types are: ${types.join(", ")}`);
            }
            values["type"] = tag;
          }
        }
      }
      if (!values["key"] && values["type"] === "qweb") values["key"] = `gen_key.${crypto.randomUUID().slice(0, 6)}`;
      if (!values["name"]) values["name"] = `${values["model"] ?? "False"} ${values["type"]}`;
      values["arch_prev"] = values["arch_base"] || values["arch_db"] || values["arch"];
      if ("arch" in values) {
        values["arch_db"] = values["arch"];
        delete values["arch"];
      }
      if ("arch_db" in values) {
        values["arch_db"] = xmlTranslateNormalize(values["arch_db"]);
        // :261-281 `_inverse_arch`: arch_fs only for files under an addons path (a module install,
        // src/modules/install.ts), not for imported data modules
        if (typeof env.context["install_filename"] === "string" && loadingFromAddons(env)) {
          values["arch_fs"] = env.context["install_filename"];
          values["arch_updated"] = false;
        }
      }
      computeDefaults(values);
    }
    const ids = await next(env, valsList);
    await checkXml(env, ids);
    return ids;
  },
  // :656-677 write, with `_inverse_arch` (:261-281) and `_inverse_arch_base` (:288-291) of a written arch done here:
  // the arch becomes `arch_db`, whose write saves `arch_prev` and runs the full `_check_xml`
  write: async (env, ids, values, next) => {
    const vals = { ...values };
    if (!("arch_updated" in vals) && ("arch" in vals || "arch_base" in vals) && !("install_filename" in env.context)) vals["arch_updated"] = true;
    if ((await env.cr.query("SELECT 1 FROM ir_ui_view_custom WHERE ref_id = ANY($1::int[]) LIMIT 1", [[...ids]])).rows.length) {
      throw new NotPorted("ir.ui.view.write of a view with customizations (ir.ui.view.custom unlink)");
    }
    if ("arch" in vals || "arch_base" in vals) {
      if ("arch" in vals && "arch_base" in vals) throw new NotPorted("ir.ui.view.write of both arch and arch_base");
      const arch = "arch" in vals ? vals["arch"] : vals["arch_base"];
      // arch is written in the context's language (arch_base without one): another language is a translation update
      if ("arch" in vals && env.lang && env.lang !== "en_US") throw new NotPorted(`ir.ui.view.write of the arch in ${env.lang}`);
      if ("arch_db" in vals) throw new NotPorted("ir.ui.view.write of arch and arch_db together");
      // :598-603 _validate_xml_encoding
      if (typeof arch === "string" && /<\?xml[^>]*encoding=.*?\?>/i.test(arch)) {
        throw new UserError("Unicode strings with encoding declaration are not supported in XML.\nRemove the encoding declaration.");
      }
      // :265-271 a module file's view (an upgrade, src/modules/upgrade.ts): the file's path in the module, not modified
      // since; an imported data module has no path on the addons path (`get_resource_from_path` is None)
      if ("install_filename" in env.context) {
        if (loadingFromAddons(env)) {
          vals["arch_fs"] = String(env.context["install_filename"]);
          vals["arch_updated"] = false;
        }
      }
      delete vals["arch"];
      delete vals["arch_base"];
      vals["arch_db"] = arch;
    }
    if ("arch_db" in vals) {
      vals["arch_db"] = xmlTranslateNormalize(vals["arch_db"]);
      if (!env.context["no_save_prev"]) {
        // `vals['arch_prev'] = self.arch_db`: a singleton, in the context's language
        if (ids.length !== 1) throw new NotPorted("ir.ui.view.write of arch_db on several views (self.arch_db of a recordset)");
        if (env.lang && env.lang !== "en_US") throw new NotPorted(`ir.ui.view.write of arch_db in ${env.lang}`);
        vals["arch_prev"] = (await env.cr.query<{ a: string | null }>("SELECT arch_db->>'en_US' AS a FROM ir_ui_view WHERE id = $1", [ids[0]])).rows[0]?.a ?? false;
      }
    }
    computeDefaults(vals);
    await next(env, ids, vals);
    // :673-675 the xml of a view that is re-activated or changed
    if ("active" in vals || "arch_db" in vals || "inherit_id" in vals) await checkXml(env, ids, false);
  },
});
