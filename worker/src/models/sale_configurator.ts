/**
 * /sale/product_configurator/get_values (sale/controllers/product_configurator.py:9-120, :260-455) without a pricelist,
 * on templates whose first combination is an existing variant: `_get_first_available_combination` (product_template.py:
 * 1566-1578, :1682-1715), exclusions and archived combinations refuse with NotPorted.
 */
import { NotPorted } from "../errors";
import { jsonRoute } from "../http/router";
import { cond, parseDomain } from "../orm/domain";
import { hasGroup } from "../orm/env";
import { DbRec, type Rec } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { pyFloat } from "../orm/values";
import { productListPrice } from "./sale_flow";

const idOf = (v: unknown): number | null => (typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : null);
const rec = (env: Environment, model: string, id: number): DbRec => new DbRec(env, env.reg.model(model), id);
const ids = (v: unknown): number[] => (Array.isArray(v) ? v.map(idOf).filter((x): x is number => x !== null) : []);

interface Line { id: number; attribute: number; create_variant: string; display_type: string; values: number[]; active: Set<number> }

/** `attribute_line_ids` with their values, in the models' `_order`. */
async function linesOf(env: Environment, template: number): Promise<Line[]> {
  const out: Line[] = [];
  const lineIds = await env.sudo().model("product.template.attribute.line").search(cond("product_tmpl_id", "=", template));
  for (const id of lineIds) {
    const a = (await env.cr.query<{ attribute: number; create_variant: string; display_type: string }>(
      `SELECT l.attribute_id AS attribute, a.create_variant, a.display_type FROM product_template_attribute_line l
         JOIN product_attribute a ON a.id = l.attribute_id WHERE l.id = $1`, [id])).rows[0]!;
    const values = await env.sudo().model("product.template.attribute.value").search(cond("attribute_line_id", "=", id));
    const active = new Set((await env.cr.query<{ id: number }>("SELECT id FROM product_template_attribute_value WHERE id = ANY($1::int[]) AND ptav_active", [values])).rows.map((r) => r.id));
    out.push({ id, ...a, values, active });
  }
  return out;
}

/** product_template.py:1682-1715: the first value of each line, multi-checkbox lines start empty; impossible ones refuse. */
async function firstCombination(env: Environment, template: number, lines: Line[]): Promise<{ combination: number[]; variant: number | null }> {
  const combination: number[] = [];
  for (const line of lines) {
    if (line.display_type === "multi") continue;
    const first = line.values.find((v) => line.active.has(v));
    if (first === undefined) throw new NotPorted("product configurator with a line without active values");
    combination.push(first);
  }
  const noVariant = new Set(lines.filter((l) => l.create_variant === "no_variant").flatMap((l) => l.values));
  const key = combination.filter((v) => !noVariant.has(v)).sort((a, b) => a - b).join(",");
  // :1529-1543 `_get_variant_id_for_combination`
  const row = (await env.cr.query<{ id: number; active: boolean }>(
    `SELECT id, active FROM product_product WHERE product_tmpl_id = $1 AND COALESCE(combination_indices, '') = $2 ORDER BY active DESC NULLS LAST, id LIMIT 1`, [template, key])).rows[0];
  if (!row?.active) throw new NotPorted("product configurator: the first combination has no active variant");
  return { combination, variant: row.id };
}

async function productInformation(env: Environment, template: number, quantity: unknown, uomParam: number | null, currency: number | null, showPrice: boolean): Promise<Record<string, unknown>> {
  if (await hasGroup(env, "uom.group_uom")) throw new NotPorted("product configurator with available_uoms (uom.group_uom)");
  const lines = await linesOf(env, template);
  const { combination, variant } = await firstCombination(env, template, lines);
  for (const v of lines.flatMap((l) => l.values)) {
    if (((await rec(env, "product.template.attribute.value", v).get("excluded_value_ids")) as unknown[] | null)?.length) throw new NotPorted("product configurator with attribute exclusions");
  }
  const archived = (await env.cr.query("SELECT 1 FROM product_product WHERE product_tmpl_id = $1 AND NOT active AND COALESCE(combination_indices, '') <> '' LIMIT 1", [template])).rows.length;
  if (archived) throw new NotPorted("product configurator with archived combinations");
  const product = rec(env, "product.product", variant!);
  const [read] = await env.model("product.product").read([variant!], ["description_sale"], "");
  const display = (await env.model("product.product").displayName([variant!])).get(variant!) ?? "";
  const uom = uomParam ?? idOf(await product.get("uom_id"));
  const productCurrency = idOf(await product.get("currency_id"));
  if (showPrice && currency !== productCurrency) throw new NotPorted("product configurator in another currency than the product's");
  const price = showPrice ? await productListPrice(env, product as Rec, combination, uom) : 0;
  const attributeLines: Record<string, unknown>[] = [];
  const exclusions: Record<string, unknown[]> = {};
  for (const line of lines) {
    const attr = (await env.model("product.attribute").read([line.attribute], ["name", "display_type"], ""))[0]!;
    const values: Record<string, unknown>[] = [];
    for (const v of line.values) {
      if (!line.active.has(v) && !combination.includes(v)) continue;
      const row = (await env.sudo().model("product.template.attribute.value").read([v], ["name", "html_color", "image", "is_custom"], ""))[0]!;
      const extra = Number((await rec(env, "product.template.attribute.value", v).get("price_extra")) ?? 0);
      values.push({ id: v, name: row["name"], html_color: row["html_color"] ?? false, image: row["image"] ?? false, is_custom: row["is_custom"] ?? false, price_extra: pyFloat(showPrice ? extra : 0) });
      exclusions[String(v)] = [];
    }
    attributeLines.push({
      id: line.id, attribute: { id: line.attribute, name: attr["name"], display_type: attr["display_type"] }, attribute_values: values,
      selected_attribute_value_ids: combination.filter((c) => line.values.includes(c)), create_variant: line.create_variant,
    });
  }
  return {
    product_tmpl_id: template, id: variant, description_sale: read?.["description_sale"] ?? false, display_name: display, price: pyFloat(price), quantity,
    uom: { id: uom, display_name: uom === null ? false : (await env.sudo().model("uom.uom").displayName([uom])).get(uom) ?? false },
    attribute_lines: attributeLines, exclusions, archived_combinations: [],
  };
}

jsonRoute("/sale/product_configurator/get_values", async (ctx) => {
  const p = ctx.jsonParams ?? {};
  if (p["context"] && typeof p["context"] === "object" && !Array.isArray(p["context"])) ctx.updateContext(p["context"] as Record<string, unknown>);
  const showPrice = p["show_price"] !== false;
  ctx.updateContext({ show_price: showPrice });
  if (p["company_id"]) ctx.updateContext({ allowed_company_ids: [p["company_id"]] });
  if (p["pricelist_id"]) throw new NotPorted("product configurator with a pricelist");
  if (Array.isArray(p["ptav_ids"]) && p["ptav_ids"].length) throw new NotPorted("product configurator with a chosen combination");
  const env = await ctx.orm();
  const template = Number(p["product_template_id"]);
  const tmpl = (await env.model("product.template").read([template], ["product_variant_count", "has_configurable_attributes", "product_variant_id", "type", "optional_product_ids"], ""))[0];
  if (!tmpl) throw new NotPorted("product configurator of a missing product");
  const optional = ids(tmpl["optional_product_ids"]);
  const res: Record<string, unknown> = {};
  if (tmpl["product_variant_count"] === 1 && !tmpl["has_configurable_attributes"]) {
    const variant = idOf(tmpl["product_variant_id"])!;
    // sale product_template.py:279-289, with `_get_possible_variants` of templates without exclusions
    let hasOptional = false;
    for (const op of optional) {
      if ((await env.model("product.product").search(parseDomain([["product_tmpl_id", "=", op]]))).length) hasOptional = true;
    }
    Object.assign(res, { product_id: variant, product_name: (await env.model("product.product").displayName([variant])).get(variant) ?? "", has_optional_products: hasOptional, is_combo: tmpl["type"] === "combo" });
  }
  if (res["product_id"] && !res["has_optional_products"]) return res;
  const currency = typeof p["currency_id"] === "number" ? p["currency_id"] : null;
  res["products"] = [await productInformation(env, template, p["quantity"], typeof p["product_uom_id"] === "number" ? p["product_uom_id"] : null, currency, showPrice)];
  const options: Record<string, unknown>[] = [];
  if (!p["only_main_product"]) {
    for (const op of optional) options.push({ ...(await productInformation(env, op, 1, null, currency, showPrice)), parent_product_tmpl_id: template });
  }
  res["optional_products"] = options;
  res["currency_id"] = p["currency_id"] ?? null;
  return res;
});
