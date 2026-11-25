/**
 * sale.order.line `_compute_display_name` (odoo/addons/sale/models/sale_order_line.py:445-470): "<order> -
 * <description>" and the commercial partner (`_additional_name_per_id` :2181-2182, `_get_partner_display`
 * :2176-2179). The description is the first line of the line's name, or the product's display name when the name is
 * the default description (`_get_sale_order_line_multiline_description_sale` :538-560, the product's sale
 * description). Ported for lines without no_variant/custom attribute values or linked lines, in en_US.
 */
import { NotPorted } from "../errors";
import { registerHooks } from "../orm/hooks";
import type { Environment } from "../orm/types";

registerHooks("sale.order.line", {
  // sale_service sale_order_line.py:40-54: formatted service lines "<order> - <product> --(<customer>)--"
  displayName: async (env, ids) => {
    if (!env.context["formatted_display_name"] || !ids.length) return plainNames(env, ids);
    const rows = (await env.cr.query<{ id: number; is_service: boolean | null; order_name: string | null; product_id: number | null; pname: string | null }>(
      `SELECT l.id, l.is_service, o.name AS order_name, l.product_id, p.name AS pname FROM sale_order_line l JOIN sale_order o ON o.id = l.order_id
         LEFT JOIN res_partner p ON p.id = l.order_partner_id WHERE l.id = ANY($1::int[])`, [[...ids]])).rows;
    const service = rows.filter((r) => r.is_service);
    if (service.length && env.context["with_price_unit"]) throw new NotPorted("sale.order.line formatted display name with_price_unit (format_amount)");
    const products = [...new Set(service.map((r) => r.product_id).filter((p): p is number => p !== null))];
    const pnames = products.length ? await env.model("product.product").displayName(products) : new Map<number, string>();
    const out = await plainNames(env, rows.filter((r) => !r.is_service).map((r) => r.id));
    for (const r of service) {
      out.set(r.id, `${r.order_name ?? "False"} - ${r.product_id === null ? "" : pnames.get(r.product_id) ?? ""} --(${r.pname ?? "False"})--`);
    }
    return new Map(ids.filter((id) => out.has(id)).map((id) => [id, out.get(id)!]));
  },
});

async function plainNames(env: Environment, ids: readonly number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    if (!ids.length) return out;
    const su = env.sudo();
    const rows = (await su.cr.query<{ id: number; name: string | null; product_id: number | null; order_name: string | null; lang: string | null;
      linked: number | null; ref: string | null; cname: string | null; dsale: string | null; nv: string }>(
      `SELECT l.id, l.name, l.product_id, o.name AS order_name, p.lang, l.linked_line_id AS linked, c.ref, c.name AS cname,
              COALESCE(t.description_sale->>'en_US', NULL) AS dsale,
              (SELECT count(*)::text FROM product_template_attribute_value_sale_order_line_rel r WHERE r.sale_order_line_id = l.id) AS nv
         FROM sale_order_line l JOIN sale_order o ON o.id = l.order_id
         LEFT JOIN res_partner p ON p.id = l.order_partner_id
         LEFT JOIN res_partner c ON c.id = p.commercial_partner_id
         LEFT JOIN product_product pp ON pp.id = l.product_id LEFT JOIN product_template t ON t.id = pp.product_tmpl_id
        WHERE l.id = ANY($1::int[])`, [[...ids]])).rows;
    const custom = (await su.cr.query<{ id: number }>(
      "SELECT DISTINCT sale_order_line_id AS id FROM product_attribute_custom_value WHERE sale_order_line_id = ANY($1::int[])", [[...ids]])).rows;
    if (custom.length) throw new NotPorted("sale.order.line display name with custom attribute values");
    const productNames = new Map<number, string>();
    const products = [...new Set(rows.map((r) => r.product_id).filter((p): p is number => p !== null))];
    if (products.length) for (const [k, v] of await su.withContext({ ...su.context, lang: "en_US" }).model("product.product").displayName(products)) productNames.set(k, v);
    for (const id of ids) {
      const r = rows.find((x) => x.id === id);
      if (!r) continue;
      if (r.lang && r.lang !== "en_US") throw new NotPorted("sale.order.line display name in the customer's language");
      if ((env.lang ?? "en_US") !== "en_US") throw new NotPorted("sale.order.line display name outside en_US");
      if (Number(r.nv) || r.linked) throw new NotPorted("sale.order.line display name with variant values or a linked line");
      let description = (r.name ?? "").split("\n", 1)[0] ?? "";
      if (r.product_id !== null) {
        const pname = productNames.get(r.product_id) ?? "";
        // product_product.py:1381-1390 `get_product_multiline_description_sale(with_display_name=False)`
        const defaultName = r.dsale ?? "";
        if (r.name !== null && [defaultName, `${pname}\n${defaultName}`, pname].includes(r.name)) description = pname;
      }
      let name = `${r.order_name ?? ""} - ${description}`;
      // `f"({commercial_partner.ref or commercial_partner.name})"`, never empty
      name = `${name} (${r.ref || r.cname || "False"})`;
      out.set(id, name);
    }
    return out;
}
