/**
 * Write-side Python defaults of the Contacts configuration models (S4): res.partner.category
 * (base/models/res_partner.py:225-262), res.partner.industry (:2412-2419), res.city
 * (base_address_extended/models/res_city.py), res.country.state and res.country (base/models/res_country.py).
 * None of them overrides create/write/unlink or has onchange methods; parent_path of tags is the generic
 * `_parent_store` maintenance (src/orm/create.ts, src/orm/write.ts).
 */
import { NotPorted } from "../errors";
import type { Domain, Environment } from "../orm/types";
import { cond } from "../orm/domain";
import * as D from "../orm/domain";
import { registerHooks } from "../orm/hooks";
import { type Rec, registerDefaults, registerRecordCompute } from "../orm/recompute";
import { searchDisplayNameDefault, sql } from "../orm/sql";

/** Python `random.randint(1, 11)` (inclusive bounds). */
function randint(lo: number, hi: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return lo + (buf[0]! % (hi - lo + 1));
}

registerDefaults("res.partner.category", {
  // res_partner.py:233 _get_default_color: randint(1, 11) (harness N9: compared as a placeholder)
  color: async () => randint(1, 11),
  active: async () => true, // :240
});

registerDefaults("res.partner.industry", {
  active: async () => true, // res_partner.py:2419
});

// base_address_extended/models/res_city.py:12-16: no field defaults
registerDefaults("res.city", {});
// res_country.py:228-236 (res.country.state): no field defaults
registerDefaults("res.country.state", {});

// res_partner.py:257 ResPartnerCategory._search_display_name: like-operators match the tags and their children
registerHooks("res.partner.category", {
  searchDisplayName: async (env, operator, value) => {
    const domain = searchDisplayNameDefault(env, env.reg.model("res.partner.category"), operator, value);
    if (!operator.endsWith("like")) return domain;
    if (operator.startsWith("not")) throw new NotPorted("res.partner.category _search_display_name NotImplemented fallback");
    return cond("id", "child_of", await env.model("res.partner.category").search(domain));
  },
});

/** res_country.py:12 FLAG_MAPPING and :25 NO_FLAG_COUNTRIES. */
const FLAG_MAPPING: Readonly<Record<string, string>> = { GF: "fr", BV: "no", BQ: "nl", GP: "fr", HM: "au", YT: "fr", RE: "fr", MF: "fr", UM: "us", XI: "uk" };
const NO_FLAG_COUNTRIES = new Set(["AQ", "SJ"]);

// res_country.py:168 _compute_image_url
registerHooks("res.country", {
  computed: {
    image_url: async (env, ids) => {
      const rows = (await env.cr.query<{ id: number; code: string | null }>("SELECT id, code FROM res_country WHERE id = ANY($1::int[])", [ids])).rows;
      return new Map(rows.map((r) => [r.id, !r.code || NO_FLAG_COUNTRIES.has(r.code) ? false : `/base/static/img/country_flags/${FLAG_MAPPING[r.code] ?? r.code.toLowerCase()}.png`]));
    },
  },
});

// res_partner.py:244 ResPartnerCategory._compute_display_name on new records (the read side uses SQL)
registerRecordCompute("res.partner.category", {
  display_name: async (env, rec) => {
    if (rec.id !== null) return (await env.model("res.partner.category").displayName([rec.id])).get(rec.id) ?? "";
    const names: string[] = [];
    let cur: Rec | null = rec;
    for (let guard = 0; cur && guard < 100; guard++) {
      const n = await cur.get("name");
      names.push(typeof n === "string" ? n : "");
      cur = await cur.rel("parent_id");
    }
    return names.reverse().join(" / ");
  },
});

/** Python `f"{value}"` of a cache value (False/None print as "False"/"None"). */
function pyFormat(v: unknown): string {
  if (v === null || v === undefined || v === false) return "False";
  return String(v);
}

// res_country.py:293 ResCountryState._compute_display_name on new records
registerRecordCompute("res.country.state", {
  display_name: async (env, rec) => {
    if (rec.id !== null) return (await env.model("res.country.state").displayName([rec.id])).get(rec.id) ?? "";
    const country = await rec.rel("country_id");
    const code = country ? await country.get("code") : false;
    const name = await rec.get("name");
    return env.context["formatted_display_name"] ? `${pyFormat(name)} \t --${pyFormat(code)}--` : `${pyFormat(name)} (${pyFormat(code)})`;
  },
});

// base/models/res_groups.py:169 _compute_full_name (the _rec_name of res.groups): "<privilege> / <name>"
registerHooks("res.groups", {
  computed: {
    full_name: async (env, ids) => {
      const lang = env.lang ?? "en_US";
      const rows = (await env.cr.query<{ id: number; name: string | null; privilege: string | null }>(
        `SELECT g.id, COALESCE(g.name->>$2, g.name->>'en_US') AS name, COALESCE(p.name->>$2, p.name->>'en_US') AS privilege
         FROM res_groups g LEFT JOIN res_groups_privilege p ON p.id = g.privilege_id WHERE g.id = ANY($1::int[])`, [ids, lang])).rows;
      const short = !!env.context["short_display_name"];
      return new Map(rows.map((r) => [r.id, r.privilege !== null && !short ? `${r.privilege} / ${r.name ?? ""}` : (r.name ?? false)]));
    },
  },
});

// product/models/product_template.py:948 ProductTemplate._compute_display_name
registerHooks("product.template", {
  displayName: async (env, ids) => {
    const lang = env.lang ?? "en_US";
    const rows = (await env.cr.query<{ id: number; name: string | null; code: string | null }>(
      `SELECT id, COALESCE(name->>$2, name->>'en_US') AS name, default_code AS code FROM product_template WHERE id = ANY($1::int[])`, [ids, lang])).rows;
    return new Map(rows.map((r) => [r.id, productDisplayName(env, r.name, r.code)]));
  },
});

// The same computes on new records (onchange): product_template.py:950-960 and product_product.py:1059-1086,
// where a new variant has no attribute values and the supplier branches are refused as above
registerRecordCompute("product.template", {
  display_name: async (env, rec) => {
    const name = await rec.get("name");
    if (!name) return false;
    return productDisplayName(env, String(name), (await rec.get("default_code") as string | false | null) || null);
  },
});
registerRecordCompute("product.product", {
  display_name: async (env, rec) => {
    if (env.context["partner_id"] || env.context["seller_id"]) throw new NotPorted("product.product display_name with supplier names");
    if (((await rec.get("product_template_attribute_value_ids")) as unknown[] | null)?.length) {
      throw new NotPorted("product.product display_name of a new record with attribute values (_get_combination_name)");
    }
    const name = await rec.get("name");
    const code = (await rec.get("default_code") as string | false | null) || null;
    // get_display_name(False, code): "[code] False" when only the code is set
    if (!name) return code && env.context["display_default_code"] !== false ? productDisplayName(env, "False", code) : false;
    return productDisplayName(env, String(name), code);
  },
});

/** `get_display_name(name, code)` (product_product.py:1029) / the template's rule (product_template.py:950-960). */
function productDisplayName(env: Environment, name: string | null, code: string | null): string {
  if (!name) return "";
  if (env.context["display_default_code"] === false || !code) return name;
  return env.context["formatted_display_name"] ? `${name}\t--${code}--` : `[${code}] ${name}`;
}

/** product_product.py:1132-1182: the context's seller, else the supplier infos of the context's partner for the variant, else for the template. */
async function displaySellers(env: Environment, product: number, template: number): Promise<{ product_name: string | null; product_code: string | null }[]> {
  const seller = env.context["seller_id"], partner = env.context["partner_id"];
  if (seller) {
    if (typeof seller !== "number") throw new NotPorted("product.product display_name with several sellers in the context");
    return (await env.cr.query<{ product_name: string | null; product_code: string | null }>("SELECT product_name, product_code FROM product_supplierinfo WHERE id = $1", [seller])).rows;
  }
  if (!partner) return [];
  if (typeof partner !== "number") throw new NotPorted("product.product display_name with a non-integer partner in the context");
  const infos = (await env.cr.query<{ product_id: number | null; company_id: number | null; product_name: string | null; product_code: string | null }>(
    `SELECT s.product_id, s.company_id, s.product_name, s.product_code FROM product_supplierinfo s
      WHERE s.product_tmpl_id = $1 AND s.partner_id IN ($2, (SELECT commercial_partner_id FROM res_partner WHERE id = $2))
      ORDER BY s.sequence, s.min_qty DESC, s.price, s.id`, [template, partner])).rows;
  let sellers = infos.filter((s) => s.product_id === product);
  if (!sellers.length) sellers = infos.filter((s) => s.product_id === null);
  const company = env.context["company_id"];
  return company ? sellers.filter((s) => s.company_id === null || s.company_id === company) : sellers;
}

/**
 * product_template_attribute_value.py:177-206 `_get_combination_name` of each variant's
 * `product_template_attribute_value_ids` (in the comodel's order, as read): values of no_variant attributes and of
 * single value lines left out.
 */
export async function combinationNames(env: Environment, ids: readonly number[]): Promise<Map<number, string>> {
  const lang = env.lang ?? "en_US";
  const su = env.sudo();
  const ptavByProduct = new Map((await su.model("product.product").read([...ids], ["product_template_attribute_value_ids"], "web"))
    .map((r) => [Number(r["id"]), (r["product_template_attribute_value_ids"] as number[]) ?? []]));
  const allPtav = [...new Set([...ptavByProduct.values()].flat())];
  const info = new Map((await env.cr.query<{ id: number; active: boolean; line: number; create_variant: string | null; name: string | null }>(
    `SELECT v.id, v.ptav_active AS active, v.attribute_line_id AS line, a.create_variant, COALESCE(pav.name->>$2, pav.name->>'en_US') AS name
     FROM product_template_attribute_value v JOIN product_attribute a ON a.id = v.attribute_id
     JOIN product_attribute_value pav ON pav.id = v.product_attribute_value_id WHERE v.id = ANY($1::int[])`, [allPtav, lang])).rows.map((r) => [r.id, r]));
  const lines = [...new Set([...info.values()].map((r) => r.line))];
  const lineValues = new Map<number, { active: boolean }[]>();
  for (const r of (await env.cr.query<{ line: number; active: boolean }>(
    "SELECT attribute_line_id AS line, ptav_active AS active FROM product_template_attribute_value WHERE attribute_line_id = ANY($1::int[])", [lines])).rows) {
    lineValues.set(r.line, [...(lineValues.get(r.line) ?? []), { active: r.active }]);
  }
  const out = new Map<number, string>();
  for (const id of ids) {
    // _without_no_variant_attributes, then _filter_single_value_lines
    let ptavs = (ptavByProduct.get(id) ?? []).map((v) => info.get(v)!).filter((v) => v && v.create_variant !== "no_variant");
    const onlyActive = ptavs.every((v) => v.active);
    ptavs = ptavs.filter((v) => {
      const values = lineValues.get(v.line) ?? [];
      return !((onlyActive ? values.filter((x) => x.active).length : values.length) === 1);
    });
    out.set(id, ptavs.map((v) => v.name ?? "").join(", "));
  }
  return out;
}

// product/models/product_product.py:1027 ProductProduct._compute_display_name: the variant's `_get_combination_name`
// (product_template_attribute_value.py:177-206)
registerHooks("product.product", {
  displayName: async (env, ids) => {
    const lang = env.lang ?? "en_US";
    const rows = (await env.cr.query<{ id: number; tmpl: number; name: string | null; code: string | null }>(
      `SELECT p.id, p.product_tmpl_id AS tmpl, COALESCE(t.name->>$2, t.name->>'en_US') AS name, p.default_code AS code
       FROM product_product p JOIN product_template t ON t.id = p.product_tmpl_id WHERE p.id = ANY($1::int[])`, [ids, lang])).rows;
    const combinations = await combinationNames(env, rows.map((r) => r.id));
    const out = new Map<number, string>();
    for (const r of rows) {
      const variant = combinations.get(r.id) ?? "";
      const name = variant ? `${r.name ?? "False"} (${variant})` : r.name;
      const sellers = await displaySellers(env, r.id, r.tmpl);
      if (sellers.length) {
        const parts = sellers.map((s) => productDisplayName(env, (s.product_name ? (variant ? `${s.product_name} (${variant})` : s.product_name) : null) ?? name ?? "False", s.product_code || r.code));
        out.set(r.id, [...new Set(parts)].join(", "));
        continue;
      }
      out.set(r.id, name ? productDisplayName(env, name, r.code) : "");
    }
    return out;
  },
});

// stock/models/stock_picking_type.py:420 _compute_display_name: "<warehouse>: <name>"
registerHooks("stock.picking.type", {
  displayName: async (env, ids) => {
    const lang = env.lang ?? "en_US";
    const rows = (await env.cr.query<{ id: number; name: string | null; wh: string | null }>(
      `SELECT t.id, COALESCE(t.name->>$2, t.name->>'en_US') AS name, w.name AS wh FROM stock_picking_type t
       LEFT JOIN stock_warehouse w ON w.id = t.warehouse_id WHERE t.id = ANY($1::int[])`, [ids, lang])).rows;
    return new Map(rows.map((r) => [r.id, r.wh !== null ? `${r.wh}: ${r.name ?? "False"}` : (r.name ?? "")]));
  },
});

// stock/models/stock_picking_type.py:360 _compute_sql_is_favorite (is_favorite is in stock.picking.type's _order)
registerHooks("stock.picking.type", {
  computeSql: {
    is_favorite: async (table) => sql`${table.id} IN (SELECT picking_type_id FROM picking_type_favorite_user_rel WHERE user_id = ${table.env.uid})`,
  },
});

// product_product.py:1088-1143 `_search_display_name`: the template's name, the variant's code, its barcode, a
// "[code]" in the value and (partner_id in context) the vendor's product code or name; one UNION of searches without
// active_test, written as the equivalent disjunction
registerHooks("product.product", {
  searchDisplayName: async (env, operator, value) => {
    const negative = operator.startsWith("not") || operator === "!=";
    const template = cond("product_tmpl_id.name", operator, value);
    const product: Domain[] = [cond("default_code", operator, value)];
    if (operator === "in") {
      product.push(cond("barcode", "in", value));
      for (const v of (Array.isArray(value) ? value : [])) {
        const m = typeof v === "string" ? /(\[(.*?)\])/.exec(v) : null;
        if (m) product.push(cond("default_code", "=", m[2]));
      }
    } else if (operator.endsWith("like") && !negative) {
      product.push(cond("barcode", "in", [value]));
      const m = typeof value === "string" ? /\[(.*?)\]/.exec(value) : null;
      if (m) product.push(cond("default_code", "=", m[1]));
    }
    const partner = env.context["partner_id"];
    const supplier = partner ? D.and([cond("partner_id", "=", partner), D.or([cond("product_code", operator, value), cond("product_name", operator, value)])]) : null;
    if (negative) {
      const parts = [template, ...product];
      if (supplier) parts.push(cond("product_tmpl_id.seller_ids", "any", supplier));
      return D.and(parts);
    }
    const parts = [template, D.or(product)];
    if (supplier) parts.push(cond("product_tmpl_id.seller_ids", "any", supplier));
    return D.or(parts);
  },
});

// product_template.py:962-975 `_search_display_name`: also the variants' (search_product_product, by default when
// there is a value); :977-984 `name_search` without it when the domain matches template ids
registerHooks("product.template", {
  searchDisplayName: async (env, operator, value) => {
    const domain = searchDisplayNameDefault(env, env.reg.model("product.template"), operator, value);
    const flag = "search_product_product" in env.context ? Boolean(env.context["search_product_product"]) : Boolean(value);
    if (!flag) return domain;
    const variants = cond("product_variant_ids", operator, value);
    return operator.startsWith("not") || operator === "!=" ? D.and([domain, variants]) : D.or([domain, variants]);
  },
});
