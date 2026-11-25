/**
 * ir.module.module `search_panel_select_range` (the Apps search panel): base_import_module ir_module.py:623-630
 * (remote industry categories refused), base ir_module.py:938-985 (category_id: the visible top-level categories
 * with applications, counted), else web models.py:1860-1925 (module_type: the selection options, expanded, without
 * counters).
 */
import { NotPorted } from "../errors";
import { registerMethod } from "../http/methods";
import { and, cond, parseDomain, TRUE } from "../orm/domain";
import type { Domain } from "../orm/types";
import { envFor } from "../web/common";
import { userHasGroup } from "../web/groups";
import { appsRestricted, visibleModuleIds } from "../modules/apps_visible";

function domainArg(v: unknown): Domain {
  return v === undefined || v === null ? TRUE : parseDomain(v);
}

/** base_import_module ir_module.py `_domain_asks_for_industries`: a module_type condition on 'industries'. */
function asksForIndustries(raw: unknown): boolean {
  return JSON.stringify(raw ?? []).includes('"industries"');
}

registerMethod("ir.module.module", "search_panel_select_range", async (env0, _ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const fieldName = "field_name" in kwargs ? kwargs["field_name"] : args[0];
  if (fieldName === "category_id") {
    if (asksForIndustries(kwargs["category_domain"])) throw new NotPorted("Apps industry categories (fetched from apps.odoo.com)");
    const enableCounters = Boolean(kwargs["enable_counters"]);
    const excluded: number[] = [];
    const names = ["module_category_website_theme", "module_category_theme"];
    if (!(await userHasGroup(env, "base.group_no_one"))) names.push("module_category_hidden");
    for (const n of names) {
      const id = (await env.cr.query<{ res_id: number }>("SELECT res_id FROM ir_model_data WHERE module = 'base' AND name = $1", [n])).rows[0]?.res_id;
      if (id !== undefined) excluded.push(id);
    }
    // [('parent_id', '=', False), '|', ('module_ids.application', '!=', False), ('child_ids.module_ids', '!=', False)];
    // on the site (D25) `module_ids` goes through ir.module.module's `_search`, which shows only the modules it serves
    const visible = appsRestricted(env) ? await visibleModuleIds(env) : null;
    const only = visible === null ? "" : " AND m.id = ANY($3::int[])";
    const rows = (await env.cr.query<{ id: number; name: string }>(
      `SELECT c.id, COALESCE(c.name->>$2, c.name->>'en_US') AS name FROM ir_module_category c
        WHERE c.parent_id IS NULL AND NOT (c.id = ANY($1::int[]))
          AND (EXISTS (SELECT 1 FROM ir_module_module m WHERE m.category_id = c.id AND m.application IS TRUE${only})
               OR EXISTS (SELECT 1 FROM ir_module_category k JOIN ir_module_module m ON m.category_id = k.id WHERE k.parent_id = c.id${only}))
        ORDER BY c.sequence, c.id`, visible === null ? [excluded, env.lang ?? "en_US"] : [excluded, env.lang ?? "en_US", visible])).rows;
    const values: Record<string, unknown>[] = [];
    for (const r of rows) {
      const v: Record<string, unknown> = { id: r.id, display_name: r.name };
      if (enableCounters) {
        v["__count"] = await env.model("ir.module.module").searchCount(and([
          domainArg(kwargs["search_domain"]), domainArg(kwargs["category_domain"]), domainArg(kwargs["filter_domain"]),
          cond("category_id", "child_of", r.id), cond("category_id", "not in", excluded),
        ]));
      }
      values.push(v);
    }
    return { parent_field: "parent_id", values };
  }
  if (fieldName === "module_type") {
    // models.py:1918-1925 with :1811-1856 `_search_panel_selection_range`, expanded and without counters
    if (kwargs["enable_counters"] || !kwargs["expand"]) throw new NotPorted("module_type search panel with counters or unexpanded");
    const field = env.reg.model("ir.module.module").fields.get("module_type");
    if (!field?.selection) throw new NotPorted("ir.module.module.module_type selection");
    if (env.lang && env.lang !== "en_US") throw new NotPorted("translated module_type labels");
    return { parent_field: false, values: field.selection.map((s) => ({ id: s.value, display_name: s.label })) };
  }
  throw new NotPorted(`ir.module.module search panel on ${String(fieldName)}`);
}, { apiModel: true, readonly: true });
