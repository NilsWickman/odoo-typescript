/**
 * account.analytic.line computes of the installed modules (no hr_timesheet): analytic/models/analytic_line.py,
 * account/models/account_analytic_line.py, sale/models/account_analytic_line.py.
 */
import { NotPorted, ValidationError } from "../errors";
import { registerHooks } from "../orm/hooks";
import { registerOnchange, registerRecordCompute } from "../orm/recompute";
import { registerOverrides } from "../orm/write";
import { defineComputes } from "./tail_util";
import { availableUoms } from "./sale_computes";
import { productAccountOf } from "./account_move_create";
import type { Environment } from "../orm/types";
import { translate } from "./util";

registerRecordCompute("account.analytic.line", {
  // account_analytic_line.py:87-90 _compute_partner_id
  partner_id: async (_env, rec) => {
    const line = await rec.rel("move_line_id");
    return (line && await line.get("partner_id")) || rec.prev("partner_id");
  },
  // :76-79 _compute_general_account_id
  general_account_id: async (_env, rec) => {
    const line = await rec.rel("move_line_id");
    return line ? line.get("account_id") : null;
  },
  // :63-74 _compute_product_uom_id after analytic_line.py:276-277, which assigns nothing
  product_uom_id: async (env, rec) => {
    const current = await rec.prev("product_uom_id");
    const product = await rec.rel("product_id");
    if (!product) return current;
    const allowed = await availableUoms(env, product);
    return current && allowed.includes(current as number) ? current : product.get("uom_id");
  },
  // sale_project account_analytic_line.py:45-79 _compute_project_billable_type with sale_project_stock :15-29 and
  // sale_purchase_project :13-16
  billable_type: async (_env, rec) => {
    const category = await rec.get("category");
    if (Number((await rec.get("amount")) || 0) >= 0 && Number((await rec.get("unit_amount")) || 0) >= 0) {
      if (category === "picking_entry") return "15_picking_entry_positive";
      const own = await rec.rel("product_id");
      const line = own ? null : await rec.rel("so_line");
      const product = own ?? (line ? await line.rel("product_id") : null);
      const type = product ? await product.get("type") : false;
      if (type === "consu") return "19_materials";
      if (type !== "service") return "11_other_revenues";
      const policy = await product!.get("invoice_policy");
      if (policy === "delivery") {
        const service = await product!.get("service_type");
        return service === "timesheet" ? "10_service_revenues" : service === "milestones" ? "05_revenues_milestones"
          : service === "manual" ? "07_revenues_manual" : "01_revenues_fixed";
      }
      return policy === "order" ? "01_revenues_fixed" : "11_other_revenues";
    }
    if (category === "picking_entry") return "16_picking_entry_negative";
    if (category === "vendor_bill") {
      const move = await rec.rel("move_line_id");
      return move && await move.get("purchase_line_id") ? "20_purchase_order" : "12_vendor_bill";
    }
    return "30_other_costs";
  },
  // sale_project :84-90 _compute_category_report, sale_project_stock :15-19
  category_report: async (_env, rec) => {
    const type = await rec.get("billable_type");
    return ["01_revenues_fixed", "10_service_revenues", "05_revenues_milestones", "07_revenues_manual", "19_materials", "11_other_revenues", "15_picking_entry_positive"]
      .includes(String(type)) ? "revenues" : "costs";
  },
  // sale account_analytic_line.py:38-39, :45-46 _compute_so_line and _compute_order_id assign nothing here
  so_line: async (_env, rec) => rec.prev("so_line"),
  order_id: async (_env, rec) => rec.prev("order_id"),
});

defineComputes("account.analytic.line", {
  // :92-95 _compute_allowed_uom_ids
  allowed_uom_ids: async (env, rec) => availableUoms(env, await rec.rel("product_id")),
  // analytic_line.py:34-38 _compute_auto_account
  auto_account_id: async (env, rec) => {
    if (env.context["analytic_plan_id"]) throw new NotPorted("account.analytic.line.auto_account_id of a plan");
    return null;
  },
});

// analytic_line.py:93-98 _check_account_id; `_get_plan_fnames` (:57-59): the column of each plan
const PLAN_FIELDS = ["account_id", "x_plan1_id", "x_plan2_id", "x_plan3_id"];
registerHooks("account.analytic.line", {
  write: [{
    beforeUnlink: async (env, ids) => {
      if (!env.context["skip_analytic_sync"] && await moveLines(env, ids)) throw new NotPorted("account.analytic.line unlink of a journal item (_update_analytic_distribution)");
    },
  }],
});

/** account_analytic_line.py:172-185 `self.move_line_id` before super, and `_update_analytic_distribution` after: refused. */
async function moveLines(env: Environment, ids: readonly number[]): Promise<boolean> {
  return (await env.model("account.analytic.line").read([...ids], ["move_line_id"], "")).some((r) => r["move_line_id"]);
}

registerOverrides("account.analytic.line", {
  write: async (env, ids, vals, next) => {
    if (await moveLines(env, ids) && ["amount", "move_line_id", "account_id", "x_plan1_id", "x_plan2_id", "x_plan3_id"].some((k) => k in vals)) {
      throw new NotPorted("account.analytic.line write on a journal item (_update_analytic_distribution)");
    }
    await next(env, ids, vals);
  },
  constraints: [{
    fields: PLAN_FIELDS,
    fn: async (env, ids) => {
      const def = env.reg.model("account.analytic.line");
      const names = [...def.fields.keys()].filter((n) => n === "account_id" || /^x_plan\d+(_\d+)?_id$/.test(n)).filter((n) => def.fields.get(n)?.column);
      const { rows } = await env.cr.query<Record<string, number | null>>(
        `SELECT ${names.map((n) => `"${n}"`).join(", ")} FROM account_analytic_line WHERE id = ANY($1::int[])`, [[...ids]]);
      if (rows.some((r) => names.every((n) => !r[n]))) throw new ValidationError(translate(env, "At least one analytic account must be set"));
    },
  }],
});

// account_analytic_line.py:138-155 on_change_unit_amount; a quantity (`_price_compute`) refuses
registerOnchange("account.analytic.line", "on_change_unit_amount", ["product_id", "product_uom_id", "unit_amount", "currency_id"], async (env, rec) => {
  const product = await rec.rel("product_id");
  if (!product) return;
  if (Number((await rec.get("unit_amount")) || 0) !== 0) throw new NotPorted("account.analytic.line amount of a quantity (_price_compute)");
  const company = await rec.get("company_id");
  await rec.set("amount", 0);
  await rec.set("general_account_id", await productAccountOf(env, product, typeof company === "number" && company ? company : await env.company(), "expense"));
  await rec.set("product_uom_id", (await rec.get("product_uom_id")) || (await product.get("uom_id")));
});

// analytic_account.py:105-113 _compute_display_name
registerHooks("account.analytic.account", {
  displayName: async (env, ids) => {
    const rows = await env.sudo().model("account.analytic.account").read([...ids], ["name", "code", "partner_id"], "");
    const out = new Map<number, string>();
    for (const r of rows) {
      let name = String(r["name"] ?? "");
      if (r["code"]) name = `[${String(r["code"])}] ${name}`;
      const partner = r["partner_id"];
      if (typeof partner === "number" && partner) {
        const commercial = (await env.cr.query<{ n: string | null }>(
          "SELECT c.name AS n FROM res_partner p JOIN res_partner c ON c.id = p.commercial_partner_id WHERE p.id = $1", [partner])).rows[0]?.n;
        if (commercial) name = `${name} - ${commercial}`;
      }
      out.set(Number(r["id"]), name);
    }
    return out;
  },
});
