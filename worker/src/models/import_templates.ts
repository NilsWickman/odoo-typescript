/**
 * `get_import_templates` (base_import/models/base_import.py:87-95: `[]`) for every model, with the fixed-template
 * overrides of the installed modules (account.move by default_move_type). Other context-dependent overrides (account.move.line,
 * account.account, product.template with purchase) refuse; res.partner's lives in src/models/base_import.ts.
 */
import { NotPorted } from "../errors";
import { registerMethod } from "../http/methods";
import { translate } from "./util";
import { hasGroup } from "../orm/env";

const FIXED: Readonly<Record<string, readonly [string, string]>> = {
  "crm.lead": ["Template for Leads & Opportunities", "/crm/static/xls/crm_lead.xls"], // crm_lead.py:2146-2151
  "project.task": ["Template for Tasks", "/project/static/xls/tasks_import_template.xlsx"], // project_task.py:2392
  "product.supplierinfo": ["Template for Vendor Pricelists", "/product/static/xls/product_supplierinfo.xls"], // product_supplierinfo.py:120
  "stock.quant": ["Template for Inventory Adjustments", "/stock/static/xlsx/stock_quant.xlsx"], // stock_quant.py:373
  "product.pricelist": ["Template for Pricelists", "/product/static/xls/product_pricelist.xls"], // product_pricelist.py:472
  "sale.order": ["Template for Quotations", "/sale/static/xls/quotations_import_template.xlsx"], // sale_order.py:2798
  "purchase.order": ["Template for Requests for Quotation", "/purchase/static/xls/requests_for_quotation_import_template.xlsx"], // purchase_order.py:1407
};
const CONTEXTUAL = new Set(["account.move", "account.move.line", "account.account", "product.template", "product.product",
  "hr.employee", "account.analytic.line", "mailing.contact", "mrp.bom"]);

registerMethod("*", "get_import_templates", async (env, _ids, _args, _kwargs, model) => {
  if (model === "product.template") {
    // purchase product.py:39-46 (purchase_product_template), sale product_template.py:227-237
    // (sale_multi_pricelist_product_template with the pricelist group), product product_template.py:1807-1811
    if (env.context["purchase_product_template"]) return [{ label: translate(env, "Template for Products"), template: "/purchase/static/xls/products_import_template.xlsx" }];
    if (env.context["sale_multi_pricelist_product_template"] && await hasGroup(env, "product.group_product_pricelist")) {
      return [{ label: translate(env, "Import Template for Products"), template: "/product/static/xls/products_import_template.xlsx" }];
    }
    return [{ label: translate(env, "Template for Products"), template: "/product/static/xls/products_import_template.xlsx" }];
  }
  if (model === "product.product") return []; // no override: base_import's []
  if (model === "account.move") {
    // account_move.py:8284-8312: by default_move_type
    const t: Record<string, [string, string]> = {
      entry: ["Template for Misc. Operations", "/account/static/xls/misc_operations_import_template.xlsx"],
      out_invoice: ["Template for Invoices", "/account/static/xls/customer_invoices_credit_notes_import_template.xlsx"],
      out_refund: ["Template for Credit Notes", "/account/static/xls/customer_invoices_credit_notes_import_template.xlsx"],
      in_invoice: ["Template for Bills", "/account/static/xls/vendor_bills_refunds_import_template.xlsx"],
      in_refund: ["Template for Refunds", "/account/static/xls/vendor_bills_refunds_import_template.xlsx"],
    };
    const key = String(env.context["default_move_type"]);
    const hit = Object.hasOwn(t, key) ? t[key] : undefined;
    return hit ? [{ label: translate(env, hit[0]), template: hit[1] }] : [];
  }
  // hr_timesheet account_analytic_line.py:557-563 is the only override of the analytic lines: base_import's [] without it
  if (model === "account.analytic.line" && !env.reg.model(model).fields.has("task_id")) return [];
  if (CONTEXTUAL.has(model)) throw new NotPorted(`${model}.get_import_templates`);
  const fixed = FIXED[model];
  return fixed ? [{ label: translate(env, fixed[0]), template: fixed[1] }] : [];
}, { apiModel: true, readonly: true });
