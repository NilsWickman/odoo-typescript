/**
 * Python behaviour of the purchase.* models the API corpus reaches (odoo/addons/purchase/models/, poc_erp).
 * Rows in worker/COMPUTED.md.
 */
import { NotPorted } from "../errors";
import { and, cond } from "../orm/domain";
import { DbRec, type Rec } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { userHasGroup } from "../web/groups";
import { relatedSelections } from "./account_computes";
import { registerActivityMixin } from "./crm_activity";
import { defineComputes } from "./tail_util";
import { hooksOf, registerHooks } from "../orm/hooks";

defineComputes("purchase.order", {
  // portal_mixin.py:30-32 extended by purchase_order.py:222-226
  access_url: async (_env, rec) => {
    if (rec.id === null) throw new NotPorted("access_url of a new purchase order ('/my/purchase/' + NewId)");
    return `/my/purchase/${rec.id}`;
  },
});

relatedSelections("purchase.order", ["lock_confirmed_po", "tax_calculation_rounding_method", "company_price_include", "default_location_dest_id_usage"]);

defineComputes("purchase.order", {
  // purchase_order.py:228-237 `_compute_bill_matched_ratio`
  bill_matched_ratio: async (_env, rec) => {
    const lines = [];
    for (const l of await rec.rels("order_line")) if (!(await l.get("display_type"))) lines.push(l);
    if (!lines.length) return 0;
    let sum = 0;
    for (const line of lines) {
      const product = await line.rel("product_id");
      const method = product ? await product.get("purchase_method") : false;
      const base = Number(method === "purchase" ? await line.get("product_qty") : await line.get("qty_received"));
      sum += base ? Number(await line.get("qty_invoiced")) / base : 0;
    }
    return (sum / lines.length) * 100;
  },
  // purchase_order.py:379-418 `_compute_duplicated_order_ids` / `_fetch_duplicate_orders`
  duplicated_order_ids: async (env, rec) => {
    if ((await rec.get("state")) !== "draft") return [];
    if (rec.id === null || !(await rec.get("partner_ref"))) return [];
    const rows = (await env.cr.query<{ ids: number[] }>(`
      SELECT array_agg(duplicate_po.id) AS ids FROM purchase_order po
        JOIN purchase_order AS duplicate_po ON po.company_id = duplicate_po.company_id AND po.id != duplicate_po.id
         AND duplicate_po.state != 'cancel' AND po.partner_id = duplicate_po.partner_id
         AND (po.origin = duplicate_po.name OR po.partner_ref = duplicate_po.partner_ref)
       WHERE po.id = $1 GROUP BY po.id`, [rec.id])).rows;
    // `set(duplicate_ids)` then Command.set: the order of a Python set of ints is not the array order
    const ids = [...new Set(rows[0]?.ids ?? [])];
    if (ids.length > 1) throw new NotPorted("duplicated_order_ids with several duplicates (Python set order)");
    return ids;
  },
});
registerActivityMixin("purchase.order");

/**
 * sale_purchase/models/purchase_order.py:20-24 `_compute_sale_order_count` with `_get_sale_orders` (:60-61) and the
 * installed sale_purchase_stock override (:14-15): order_line.sale_order_id | reference_ids.sale_ids.
 */
async function saleOrders(rec: Rec): Promise<Set<number>> {
  const ids = new Set<number>();
  for (const line of await rec.rels("order_line")) {
    const so = await line.get("sale_order_id");
    if (typeof so === "number" && so > 0) ids.add(so);
  }
  for (const ref of await rec.rels("reference_ids")) for (const so of await ref.rels("sale_ids")) if (so.id !== null) ids.add(so.id);
  return ids;
}
/** purchase_stock/models/purchase_order.py:37-45 `_compute_picking_ids` / `_compute_incoming_picking_count`. */
async function pickings(rec: Rec): Promise<number[]> {
  const out: number[] = [];
  for (const line of await rec.rels("order_line")) {
    for (const move of await line.rels("move_ids")) {
      const p = await move.get("picking_id");
      if (typeof p === "number" && p > 0 && !out.includes(p)) out.push(p);
    }
  }
  return out;
}
defineComputes("purchase.order", {
  picking_ids: async (_env, rec) => pickings(rec),
  incoming_picking_count: async (_env, rec) => (await pickings(rec)).length,
  // purchase_stock/models/purchase_order.py:53-59
  is_shipped: async (env, rec) => {
    const ids = await pickings(rec);
    if (!ids.length) return false;
    const rows = await env.model("stock.picking").read(ids, ["state"], "");
    return rows.every((r) => r["state"] === "done" || r["state"] === "cancel");
  },
  sale_order_count: async (_env, rec) => (await saleOrders(rec)).size,
  has_sale_order: async (_env, rec) => (await saleOrders(rec)).size > 0,
});

/** purchase_order.py:362-378 `_compute_purchase_warning_text` (warnings in an OrderedSet, joined by newlines). */
defineComputes("purchase.order", {
  purchase_warning_text: async (env, rec) => {
    if (!(await userHasGroup(env, "purchase.group_warning_purchase"))) return "";
    const warnings: string[] = [];
    const add = (w: string): void => { if (!warnings.includes(w)) warnings.push(w); };
    const partner = await rec.rel("partner_id");
    const label = async (p: Rec): Promise<string> => String((await p.get("name")) || (await p.get("display_name")) || "");
    if (partner) {
      const msg = await partner.get("purchase_warn_msg");
      if (msg) add(`${await label(partner)} - ${String(msg)}`);
      const parent = await partner.rel("parent_id");
      const pmsg = parent ? await parent.get("purchase_warn_msg") : false;
      if (parent && pmsg) add(`${await label(parent)} - ${String(pmsg)}`);
    }
    for (const line of await rec.rels("order_line")) {
      const msg = await line.get("purchase_line_warn_msg");
      if (msg) {
        const product = await line.rel("product_id");
        add(`${product ? String(await product.get("display_name")) : "False"} - ${String(msg)}`);
      }
    }
    return warnings.join("\n");
  },
});

defineComputes("purchase.order", {
  // purchase_order.py:341-350 `_compute_show_comparison`: another confirmed order line has one of the products
  show_comparison: async (env, rec) => {
    const products = new Set<number>();
    for (const line of await rec.rels("order_line")) {
      const p = await line.get("product_id");
      if (typeof p === "number" && p > 0) products.add(p);
    }
    if (!products.size) return false;
    const lines = await env.model("purchase.order.line").search(and([cond("product_id", "in", [...products]), cond("state", "=", "purchase")]));
    if (!lines.length) return false;
    const rows = await env.model("purchase.order.line").read(lines, ["product_id", "order_id"], "");
    const byProduct = new Map<number, Set<number>>();
    for (const r of rows) {
      const set = byProduct.get(Number(r["product_id"])) ?? new Set<number>();
      set.add(Number(r["order_id"]));
      byProduct.set(Number(r["product_id"]), set);
    }
    const self = rec.id === null ? [] : [rec.id];
    for (const p of products) {
      const set = byProduct.get(p);
      if (set && !(set.size === self.length && self.every((x) => set.has(x)))) return true;
    }
    return false;
  },
});

defineComputes("purchase.order", {
  // purchase_order.py:353-360 `_compute_show_receive_button`
  show_receive_button: async (_env, rec) => {
    if ((await rec.get("state")) !== "purchase") return false;
    const lines = await rec.rels("order_line");
    let anyShort = false;
    for (const l of lines) if (Number(await l.get("qty_received")) < Number(await l.get("product_qty"))) anyShort = true;
    if (!anyShort) return false;
    for (const l of lines) if ((await l.get("qty_received_method")) !== "manual") return false;
    return true;
  },
});

defineComputes("purchase.order", {
  // purchase_order.py:319-325 `_compute_tax_country_id`
  tax_country_id: async (_env, rec) => {
    const fp = await rec.rel("fiscal_position_id");
    if (fp && (await fp.get("foreign_vat"))) return (await fp.get("country_id")) || false;
    const company = await rec.rel("company_id");
    return company ? ((await company.get("account_fiscal_country_id")) || false) : false;
  },
});

/**
 * purchase_stock/models/stock.py:370-379 `_compute_purchase_order_ids` on stock.lot: the orders of the done move
 * lines of the lot whose picking comes from a supplier/transit location, in move line search order.
 */
async function lotPurchaseOrders(env: Environment, rec: Rec): Promise<number[]> {
  if (rec.origin === null) return [];
  const lines = await env.model("stock.move.line").search(and([cond("lot_id", "in", [rec.origin]), cond("state", "=", "done")]));
  const out: number[] = [];
  const def = env.reg.model("stock.move.line");
  for (const id of lines) {
    const line = new DbRec(env, def, id);
    const move = await line.rel("move_id");
    if (!move) continue;
    const picking = await move.rel("picking_id");
    const loc = picking ? await picking.rel("location_id") : null;
    const usage = loc ? await loc.get("usage") : false;
    const pol = await move.rel("purchase_line_id");
    const order = pol ? await pol.get("order_id") : false;
    if ((usage === "supplier" || usage === "transit") && typeof order === "number" && order > 0 && !out.includes(order)) out.push(order);
  }
  return out;
}
defineComputes("stock.lot", {
  purchase_order_ids: (env, rec) => lotPurchaseOrders(env, rec),
  purchase_order_count: async (env, rec) => (await lotPurchaseOrders(env, rec)).length,
});

// purchase_stock/models/purchase_order.py:23 picking_type_id's callable domain, with `_get_allowed_picking_code`
// (:374-375 ['incoming']; stock_dropshipping, which adds 'dropship', is not installed)
registerHooks("purchase.order", {
  descriptionDomain: {
    ...hooksOf("purchase.order").descriptionDomain,
    picking_type_id: async (env) => [["code", "in", ["incoming"]], "|", ["warehouse_id.company_id", "in", [...await env.companies()]], ["warehouse_id", "=", false]],
  },
});
