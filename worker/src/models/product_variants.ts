/**
 * Product variants from attribute lines (rådet runda 12, åtgärd 7): product.template.attribute.line `create`
 * (odoo/addons/product/models/product_template_attribute_line.py:81-115) with `_update_product_template_attribute_values`
 * (:194-255), and the template's `_create_variant_ids` (product_template.py:1092-1223) for the case the port follows:
 * no existing variant is replaced or archived, no dynamic or multi-choice attribute, no exclusion, no reactivated
 * (archived) line or value. Everything else refuses before it is written.
 */
import { NotPorted, UserError } from "../errors";
import { create } from "../orm/create";
import { registerDefaults, registerRecordCompute } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { registerOverrides, write } from "../orm/write";
import { pyPercent } from "./ir_fields_converter";
import { translate } from "./util";

// product_template_attribute_value.py:19-20 `_get_default_color`: randint(1, 11), random as res.partner.category's
registerDefaults("product.template.attribute.value", {
  color: async () => {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return 1 + (buf[0]! % 11);
  },
});

// product_template_attribute_line.py:44-47 `_compute_value_count` (stored)
registerRecordCompute("product.template.attribute.line", {
  value_count: async (_env, rec) => {
    const values = await rec.get("value_ids");
    return Array.isArray(values) ? values.length : 0;
  },
});

registerOverrides("product.template.attribute.line", {
  create: async (env, valsList, next) => {
    // :92-111 an archived line of the same template and attribute is reactivated instead: refused
    for (const vals of valsList) {
      const archived = (await env.cr.query("SELECT 1 FROM product_template_attribute_line WHERE NOT active AND product_tmpl_id = $1 AND attribute_id = $2 LIMIT 1",
        [vals["product_tmpl_id"] ?? 0, vals["attribute_id"] ?? 0])).rows.length;
      if (archived) throw new NotPorted("product.template.attribute.line create reactivating an archived line");
    }
    const ids = await next(env, valsList);
    if (env.context["update_product_template_attribute_values"] !== false) await updateTemplateValues(env, ids);
    return ids;
  },
  // product_template_attribute_line.py:117-158 write
  write: async (env, ids, vals, next) => {
    if ("product_tmpl_id" in vals && ids.length) {
      const rows = (await env.cr.query<{ id: number; product_tmpl_id: number; attribute_id: number }>(
        "SELECT id, product_tmpl_id, attribute_id FROM product_template_attribute_line WHERE id = ANY($1::int[])", [[...ids]])).rows;
      for (const r of rows) {
        if (r.product_tmpl_id !== Number(vals["product_tmpl_id"])) {
          const aname = (await env.model("product.attribute").displayName([r.attribute_id])).get(r.attribute_id) ?? "";
          const tname = (await env.model("product.template").displayName([r.product_tmpl_id])).get(r.product_tmpl_id) ?? "";
          throw new UserError(pyPercent(translate(env, "You cannot move the attribute %(attribute)s from the product %(product_src)s to the product %(product_dest)s.", "product"), {
            attribute: aname, product_src: tname, product_dest: String(vals["product_tmpl_id"]),
          }));
        }
      }
    }
    if ("attribute_id" in vals && ids.length) {
      const rows = (await env.cr.query<{ id: number; product_tmpl_id: number; attribute_id: number }>(
        "SELECT id, product_tmpl_id, attribute_id FROM product_template_attribute_line WHERE id = ANY($1::int[])", [[...ids]])).rows;
      for (const r of rows) {
        if (r.attribute_id !== Number(vals["attribute_id"])) {
          const aname = (await env.model("product.attribute").displayName([r.attribute_id])).get(r.attribute_id) ?? "";
          const tname = (await env.model("product.template").displayName([r.product_tmpl_id])).get(r.product_tmpl_id) ?? "";
          throw new UserError(pyPercent(translate(env, "On the product %(product)s you cannot transform the attribute %(attribute_src)s into the attribute %(attribute_dest)s.", "product"), {
            product: tname, attribute_src: aname, attribute_dest: String(vals["attribute_id"]),
          }));
        }
      }
    }
    const writeVals = "active" in vals && !vals["active"] ? { ...vals, value_ids: [[5, 0, 0]] } : vals;
    await next(env, ids, writeVals);
    if (env.context["update_product_template_attribute_values"] !== false) await updateTemplateValues(env, ids);
  },
});

/** :194-255: sync product.template.attribute.value rows for created or written lines, then the templates' variants. */
async function updateTemplateValues(env: Environment, lineIds: readonly number[]): Promise<void> {
  const toCreate: Record<string, unknown>[] = [];
  const toActivate: number[] = [];
  const templates: number[] = [];
  for (const line of lineIds) {
    const row = (await env.cr.query<{ t: number; a: number }>(
      "SELECT product_tmpl_id AS t, attribute_id AS a FROM product_template_attribute_line WHERE id = $1", [line])).rows[0];
    if (!row) continue;
    if (!templates.includes(row.t)) templates.push(row.t);
    const desired = new Set((await env.cr.query<{ id: number }>(
      "SELECT product_attribute_value_id AS id FROM product_attribute_value_product_template_attribute_line_rel WHERE product_template_attribute_line_id = $1", [line])).rows.map((r) => r.id));
    const existingPtavs = (await env.cr.query<{ id: number; pav: number; active: boolean | null }>(
      "SELECT id, product_attribute_value_id AS pav, ptav_active AS active FROM product_template_attribute_value WHERE attribute_line_id = $1 ORDER BY id", [line])).rows;
    const toUnlink: number[] = [];
    for (const ptav of existingPtavs) {
      if (!desired.has(ptav.pav)) {
        if (ptav.active) toUnlink.push(ptav.id);
      } else {
        desired.delete(ptav.pav);
        if (!ptav.active) toActivate.push(ptav.id);
      }
    }
    if (toUnlink.length) throw new NotPorted("product.template.attribute.line removing active attribute values");
    if (desired.size) {
      const archived = (await env.cr.query<{ id: number; pav: number }>(
        `SELECT id, product_attribute_value_id AS pav FROM product_template_attribute_value
          WHERE NOT ptav_active AND product_tmpl_id = $1 AND attribute_id = $2 AND product_attribute_value_id = ANY($3::int[]) ORDER BY id`,
        [row.t, row.a, [...desired]])).rows;
      for (const a of archived) {
        if (!desired.has(a.pav)) continue;
        await write(env, "product.template.attribute.value", [a.id], { ptav_active: true, attribute_line_id: line });
        desired.delete(a.pav);
      }
    }
    if (desired.size) {
      const values = (await env.cr.query<{ id: number; extra: number | null }>(
        "SELECT id, default_extra_price::float8 AS extra FROM product_attribute_value WHERE id = ANY($1::int[]) ORDER BY id", [[...desired]])).rows;
      for (const v of values) toCreate.push({ product_attribute_value_id: v.id, attribute_line_id: line, price_extra: v.extra ?? 0 });
    }
  }
  if (toActivate.length) await write(env, "product.template.attribute.value", toActivate, { ptav_active: true });
  if (toCreate.length) await create(env, "product.template.attribute.value", toCreate);
  if (env.context["create_product_product"] !== false) await createVariantIds(env, templates);
}

/**
 * product_template.py:1092-1223 `_create_variant_ids`: every combination of the active values of the lines that make
 * variants (`itertools.product` in the lines' order, the values in theirs) is an existing variant (activated) or a new
 * one (`_prepare_variant_values`); a template without lines gets one variant without values.
 */
export async function createVariantIds(env: Environment, templateIds: readonly number[]): Promise<void> {
  const toCreate: Record<string, unknown>[] = [];
  const toActivate: number[] = [];
  for (const tmpl of templateIds) {
    const t = (await env.cr.query<{ active: boolean | null; base: number | null }>(
      "SELECT active, base_unit_count::float8 AS base FROM product_template WHERE id = $1", [tmpl])).rows[0];
    if (!t) continue;
    // `valid_product_template_attribute_line_ids`: the lines with values, in the line `_order` (sequence, attribute_id, id)
    const lines = (await env.cr.query<{ id: number; create_variant: string | null; display_type: string | null }>(
      `SELECT l.id, a.create_variant, a.display_type FROM product_template_attribute_line l JOIN product_attribute a ON a.id = l.attribute_id
        WHERE l.product_tmpl_id = $1 AND l.active
          AND EXISTS (SELECT 1 FROM product_attribute_value_product_template_attribute_line_rel r WHERE r.product_template_attribute_line_id = l.id)
        ORDER BY l.sequence, l.attribute_id, l.id`, [tmpl])).rows;
    const dynamic = lines.some((l) => l.create_variant === "dynamic"); // `has_dynamic_attributes` (:1234-1242)
    // `exclude_for` / `excluded_value_ids` of the template's active values (product_template.py:1324-1395)
    const exclusionRows = (await env.cr.query<{ a: number; b: number }>(
      `SELECT r.product_template_attribute_value_id AS a, r.excluded_product_template_attribute_value_id AS b
         FROM product_template_attribute_excluded_value_ids_rel r
         JOIN product_template_attribute_value va ON va.id = r.product_template_attribute_value_id
         JOIN product_template_attribute_value vb ON vb.id = r.excluded_product_template_attribute_value_id
        WHERE va.product_tmpl_id = $1 AND va.ptav_active AND vb.ptav_active`, [tmpl])).rows;
    const excludedBy = new Map<number, Set<number>>();
    for (const e of exclusionRows) {
      let s = excludedBy.get(e.a);
      if (!s) { s = new Set(); excludedBy.set(e.a, s); }
      s.add(e.b);
    }
    const variantLines = lines.filter((l) => l.create_variant !== "no_variant");
    // `_filter_combinations_impossible_by_config` (:1361-1390) treats the multi-checkbox lines that make variants apart
    if (variantLines.some((l) => l.display_type === "multi")) throw new NotPorted("product.template._create_variant_ids with a multi-checkbox attribute making variants");
    // the active values of each line in the value `_order` (sequence of the attribute value, line, value, id)
    const perLine: number[][] = [];
    for (const l of variantLines) {
      perLine.push((await env.cr.query<{ id: number }>(
        `SELECT v.id FROM product_template_attribute_value v JOIN product_attribute_value pav ON pav.id = v.product_attribute_value_id
          WHERE v.attribute_line_id = $1 AND v.ptav_active ORDER BY pav.sequence, v.attribute_line_id, v.product_attribute_value_id, v.id`, [l.id])).rows.map((r) => r.id));
    }
    const variants = (await env.cr.query<{ id: number; key: string }>(
      `SELECT p.id, COALESCE((SELECT string_agg(c.product_template_attribute_value_id::text, ',' ORDER BY c.product_template_attribute_value_id)
                               FROM product_variant_combination c WHERE c.product_product_id = p.id), '') AS key
         FROM product_product p WHERE p.product_tmpl_id = $1 ORDER BY p.active, p.id DESC`, [tmpl])).rows;
    // :1114-1135 the value of a single-value line is written onto the existing variants that lack it: refused (a
    // variant already carrying it, as after the line's own create, changes nothing)
    const single = perLine.filter((v) => v.length === 1).map((v) => v[0]!);
    if (single.some((ptav) => variants.some((v) => !v.key.split(",").includes(String(ptav))))) {
      throw new NotPorted("product.template._create_variant_ids adding a single-value line to existing variants");
    }
    const existing = new Map(variants.map((v) => [v.key, v.id]));
    const activated: number[] = [];
    let combos: number[][] = [[]];
    for (const values of perLine) combos = combos.flatMap((c) => values.map((v) => [...c, v]));
    if (excludedBy.size) {
      combos = combos.filter((combo) => {
        const set = new Set(combo);
        for (const id of combo) {
          const ex = excludedBy.get(id);
          if (ex) for (const b of ex) if (set.has(b)) return false;
        }
        return true;
      });
    }
    // :1144-1176 with a dynamic attribute no variant is made in advance: the existing ones are kept (no exclusions)
    if (dynamic) combos = [];
    if (dynamic) activated.push(...variants.map((v) => v.id));
    for (const combo of combos) {
      const key = [...combo].sort((a, b) => a - b).join(",");
      const found = existing.get(key);
      if (found !== undefined) activated.push(found);
      else toCreate.push({ product_tmpl_id: tmpl, product_template_attribute_value_ids: [[6, 0, combo]], active: t.active ?? false, base_unit_count: t.base ?? 0 });
    }
    // :1188-1210 the variants no combination keeps are unlinked or archived (`_unlink_or_archive`): refused
    if (variants.some((v) => !activated.includes(v.id))) throw new NotPorted("product.template._create_variant_ids replacing existing variants (_unlink_or_archive)");
    if (t.active) toActivate.push(...activated);
  }
  // :1180-1185 the kept variants of active templates are (re)activated, then the new ones created together
  if (toActivate.length) await write(env, "product.product", toActivate, { active: true });
  if (toCreate.length) await create(env, "product.product", toCreate);
}
