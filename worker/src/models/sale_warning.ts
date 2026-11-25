/**
 * sale.order `sale_warning_text` (odoo/addons/sale/models/sale_order.py:1222-1239) and sale.order.line
 * `sale_line_warn_msg` (sale_order_line.py:693-700): the partner, parent partner and product warnings, for users of
 * `sale.group_warning_sale` only. A warning text is joined in OrderedSet order.
 */
import { hasGroup } from "../orm/env";
import { registerHooks } from "../orm/hooks";
import { registerRecordCompute, type Rec } from "../orm/recompute";
import type { Environment } from "../orm/types";

async function partnerWarnings(env: Environment, partner: Rec | null, out: string[]): Promise<void> {
  if (!partner) return;
  const add = async (p: Rec): Promise<void> => {
    const msg = await p.get("sale_warn_msg");
    if (typeof msg === "string" && msg) {
      const name = (await p.get("name")) || (await p.get("display_name"));
      const line = `${String(name)} - ${msg}`;
      if (!out.includes(line)) out.push(line);
    }
  };
  await add(partner);
  const parent = await partner.rel("parent_id");
  if (parent) await add(parent);
  void env;
}

async function orderWarning(env: Environment, rec: Rec): Promise<string> {
  if (!(await hasGroup(env, "sale.group_warning_sale"))) return "";
  const out: string[] = [];
  await partnerWarnings(env, await rec.rel("partner_id"), out);
  for (const line of await rec.rels("order_line")) {
    const product = await line.rel("product_id");
    const msg = product ? await product.get("sale_line_warn_msg") : null;
    // sale_order.py:1234-1236: `line.product_id.display_name + " - " + line.sale_line_warn_msg`, each once
    if (product && typeof msg === "string" && msg) {
      const warning = `${String(await product.get("display_name"))} - ${msg}`;
      if (!out.includes(warning)) out.push(warning);
    }
  }
  return out.join("\n");
}

registerRecordCompute("sale.order", { sale_warning_text: async (env, rec) => orderWarning(env, rec) });
registerRecordCompute("sale.order.line", {
  sale_line_warn_msg: async (env, rec) => {
    if (!(await hasGroup(env, "sale.group_warning_sale"))) return "";
    const product = await rec.rel("product_id");
    const msg = product ? await product.get("sale_line_warn_msg") : null;
    return typeof msg === "string" ? msg : null;
  },
});
registerHooks("sale.order", {
  computed: {
    sale_warning_text: async (env, ids) => {
      const { DbRec } = await import("../orm/recompute");
      const def = env.reg.model("sale.order");
      const out = new Map<number, unknown>();
      for (const id of ids) out.set(id, await orderWarning(env, new DbRec(env, def, id)));
      return out;
    },
  },
});
