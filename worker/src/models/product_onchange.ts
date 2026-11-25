/**
 * The `@api.onchange` methods of the product form (product.template), in the MRO Odoo 20 builds for poc_erp (measured
 * with the registry: `_onchange_type` is sale -> stock -> account -> product; `_trigger_uom_warning` sale -> purchase
 * -> stock -> product). In an onchange the record is a new record whose `_origin` is the saved template (if any): its
 * variants are read from the origin, as Odoo's new variant records map to their origins in the searches.
 */
import { NotPorted, UserError, ValidationError } from "../errors";
import { and, cond } from "../orm/domain";
import { DbRec, NewRec, NOT_ASSIGNED, registerOnchange, registerRecordCompute, type Rec } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { translate } from "./util";

const MODEL = "product.template";

const idOf = (v: unknown): number | null => (typeof v === "number" ? v : v instanceof NewRec ? v.origin : null);

/** `self.product_variant_ids.ids` of the template being edited (active_test as given), from its origin. */
async function variants(env: Environment, rec: NewRec, activeTest = true): Promise<number[]> {
  if (rec.origin === null) return [];
  return env.withContext({ ...env.context, active_test: activeTest }).model("product.product").search(cond("product_tmpl_id", "=", rec.origin), { activeTest });
}

// product_template.py:626-629
registerOnchange(MODEL, "_onchange_standard_price", ["standard_price"], async (env, rec) => {
  if (Number((await rec.get("standard_price")) ?? 0) < 0) throw new ValidationError(translate(env, "The cost of a product can't be negative.", "product"));
});

// product_template.py:631-643
registerOnchange(MODEL, "_onchange_default_code", ["default_code"], async (env, rec) => {
  const code = await rec.get("default_code");
  if (!code || typeof code !== "string") return;
  const domain = rec.origin !== null ? and([cond("default_code", "=", code), cond("id", "!=", rec.origin)]) : cond("default_code", "=", code);
  if ((await env.model(MODEL).search(domain, { limit: 1 })).length) {
    return { title: translate(env, "Note:", "product"), message: translate(env, "The Internal Reference '%s' already exists.", "product").split("%s").join(code) };
  }
});

// sale product_template.py:192-203 -> stock product.py:1074-1088 -> account product.py:264-269 -> product_template.py:671-684
registerOnchange(MODEL, "_onchange_type", ["type"], async (env, rec) => {
  const combo = (await rec.get("type")) === "combo";
  // account: the taxes of a combo product are cleared before super()
  if (combo) {
    await rec.set("taxes_id", []);
    await rec.set("supplier_taxes_id", []);
  }
  // product
  const variantIds = await variants(env, rec);
  if (combo) {
    const lines = await rec.get("attribute_line_ids");
    if (Array.isArray(lines) && lines.length) throw new UserError(translate(env, "Combo products can't have attributes.", "product"));
    if (variantIds.length && (await env.sudo().model("product.combo.item").search(cond("product_id", "in", variantIds), { limit: 1 })).length) {
      throw new UserError(translate(env, "This product is part of a combo, so its type can't be changed to \"combo\".", "product"));
    }
    await rec.set("purchase_ok", false);
  }
  let warning: { title: string; message: string } | undefined;
  // stock: `self.ids` (a new record's id is truthy) and the variants' (origin) move lines
  if (variantIds.length && (await env.sudo().model("stock.move.line").search(and([cond("product_id", "in", variantIds), cond("state", "!=", "cancel")]), { limit: 1 })).length) {
    warning = {
      title: translate(env, "Warning!", "stock"),
      message: translate(env, "This product has been used in at least one inventory movement. It is not advised to change the Product Type since it can lead to inconsistencies. A better solution could be to archive the product and create a new one instead.", "stock"),
    };
  }
  // sale (product_template.py:192-203) warns when `self._origin and self.sales_count > 0`, but in an onchange `self` is
  // a new record and its variants' `_compute_sales_count` gives 0 to a record whose id is a NewId (sale
  // product_product.py:19-42 `if not product.id`): the sale warning never applies here (measured: product 5's type
  // change gives stock's warning)
  return warning;
});

/** sale -> purchase -> stock -> product `_trigger_uom_warning` of the variants: any line or move of them. */
async function triggerUomWarning(env: Environment, variantIds: readonly number[]): Promise<boolean> {
  if (!variantIds.length) return false;
  for (const model of ["stock.move", "purchase.order.line", "sale.order.line"]) {
    if ((await env.sudo().model(model).search(cond("product_id", "in", [...variantIds]), { limit: 1 })).length) return true;
  }
  return false;
}

// product_template.py:686-698
registerOnchange(MODEL, "_onchange_uom_id", ["uom_id"], async (env, rec) => {
  const uom = idOf(await rec.get("uom_id"));
  const old = rec.origin !== null ? idOf(await new DbRec(env, env.reg.model(MODEL), rec.origin).get("uom_id")) : null;
  if (old === uom || !(await triggerUomWarning(env, await variants(env, rec, false)))) return;
  const names = await env.model("uom.uom").displayName([old, uom].filter((x): x is number => x !== null));
  const message = translate(env, "Changing the unit of measure for your product will apply a conversion 1 %(old_uom_name)s = 1 %(new_uom_name)s.\nAll existing records (Sales orders, Purchase orders, etc.) using this product will be updated by replacing the unit name.", "product")
    .split("%(old_uom_name)s").join(old === null ? "" : names.get(old) ?? "").split("%(new_uom_name)s").join(uom === null ? "" : names.get(uom) ?? "");
  return { title: translate(env, "What to expect ?", "product"), message };
});

// purchase_stock product.py:16-29
registerOnchange(MODEL, "_onchange_buy_route", ["route_ids", "purchase_ok"], async (env, rec) => {
  if (await rec.get("purchase_ok")) return;
  const rules = await env.model("stock.rule").search(and([cond("action", "=", "buy"), cond("picking_type_id.code", "=", "incoming"), cond("active", "=", true)]));
  if (!rules.length) return;
  const buy = new Set((await env.cr.query<{ r: number | null }>("SELECT route_id AS r FROM stock_rule WHERE id = ANY($1::int[])", [rules])).rows.map((r) => r.r));
  const routes = await rec.get("route_ids");
  const current = (Array.isArray(routes) ? routes : []).map(idOf);
  if (current.some((r) => r !== null && buy.has(r))) {
    return { title: translate(env, "Warning!", "purchase_stock"), message: translate(env, "This product has the \"Buy\" route checked but is not purchasable.", "purchase_stock") };
  }
});

// sale_project product_template.py:129-137
registerOnchange(MODEL, "_onchange_service_tracking", ["service_tracking"], async (_env, rec) => {
  const t = await rec.get("service_tracking");
  if (t === "no") {
    await rec.set("project_id", false);
    await rec.set("project_template_id", false);
  } else if (t === "task_global_project") await rec.set("project_template_id", false);
  else if (t === "task_in_project" || t === "project_only") await rec.set("project_id", false);
});

// sale_project product_template.py:91-112 `_inverse_service_policy` (an onchange of service_policy)
const SERVICE_TO_GENERAL: Readonly<Record<string, [string, string]>> = {
  ordered_prepaid: ["order", "manual"], delivered_milestones: ["delivery", "milestones"], delivered_manual: ["delivery", "manual"],
};
registerOnchange(MODEL, "_inverse_service_policy", ["service_policy"], async (_env, rec) => {
  const policy = await rec.get("service_policy");
  if (!policy) return;
  const [invoice, type] = SERVICE_TO_GENERAL[String(policy)] ?? [false, false];
  await rec.set("invoice_policy", invoice);
  await rec.set("service_type", type);
});

// stock product.py:1037-1039 -> :546-552 on the variants: store_by (the template's, inherited) and their quantity on hand
registerOnchange(MODEL, "_onchange_tracking", ["tracking", "store_by"], async (env, rec) => {
  const storeBy = await rec.get("store_by");
  if (storeBy !== "lot" && storeBy !== "serial") return;
  const def = env.reg.model("product.product");
  for (const v of await variants(env, rec)) {
    if (Number((await new DbRec(env, def, v).get("qty_available")) ?? 0) > 0) {
      return {
        title: translate(env, "Warning!", "stock"),
        message: translate(env, "You have product(s) in stock that have no lot/serial number. You can assign lot/serial numbers by doing an inventory adjustment.", "stock"),
      };
    }
  }
});

/** What a compute that leaves a record unassigned gives: the column for a saved record, the cache for a new one. */
async function unassigned(rec: Rec, field: string): Promise<unknown> {
  return rec instanceof DbRec ? NOT_ASSIGNED : rec.prev(field);
}

registerRecordCompute(MODEL, {
  // product_template.py:477-480 `_compute_is_storable`: only a goods product can be tracked in inventory
  is_storable: async (_env, rec) => {
    if ((await rec.get("type")) !== "consu" && (await rec.prev("is_storable"))) return false;
    return unassigned(rec, "is_storable");
  },
  // stock product.py:1041-1044 `_compute_tracking`: `is_storable and tracking` (assigned for every record)
  tracking: async (_env, rec) => ((await rec.get("is_storable")) ? (await rec.prev("tracking")) || false : false),
  // product_template.py:273-274 (`pass`) -> sale_purchase product_template.py:15-18: a subcontracted service is purchasable
  purchase_ok: async (_env, rec) => {
    const prev = await rec.prev("purchase_ok");
    if ((await rec.get("service_tracking")) === "subcontract" && !prev) return true;
    return unassigned(rec, "purchase_ok");
  },
  // sale product_template.py:116-118 -> sale_stock product_template.py:10-13 (-> sale_expense :37-40): 'no' for a
  // product that is not sold or is storable, else unassigned
  reinvoice_policy: async (env, rec) => {
    const modules = env.reg.model(MODEL).modules ?? [];
    if (modules.includes("sale_expense")) throw new NotPorted("sale_expense product.template._compute_reinvoice_policy");
    if (!(await rec.get("sale_ok"))) return "no";
    if (modules.includes("sale_stock") && (await rec.get("is_storable"))) return "no";
    return unassigned(rec, "reinvoice_policy");
  },
  // product_template.py:270-271 -> sale product_template.py:103-106 -> sale_purchase product_template.py:20-23
  service_tracking: async (_env, rec) => {
    let value: unknown = await rec.prev("service_tracking");
    let assigned = false;
    if ((await rec.get("type")) !== "service") { value = "no"; assigned = true; }
    if (!(await rec.get("sale_ok"))) { value = "no"; assigned = true; }
    if (value === "subcontract" && (!(await rec.get("purchase_ok")) || (await rec.get("reinvoice_policy")) !== "no")) { value = "no"; assigned = true; }
    return assigned ? value : unassigned(rec, "service_tracking");
  },
});

// -------------------------------------------------------------------------------------------------------------------
// product.product: the variant form's own `@api.onchange` methods (gen/out/poc_erp/onchange_methods.json). A new
// variant's inherited fields are read from its new template (orm/recompute.ts DELEGATE_PARENT_MODELS), and `self.ids`
// of a new variant searched in a domain is its origin, as for the template's variants above.
// -------------------------------------------------------------------------------------------------------------------
const VARIANT = "product.product";

// `_onchange_standard_price` and `_onchange_default_code` of the variant: product_computes.ts

// sale product_product.py:87-98: `self._origin and self.sales_count > 0`, where `_compute_sales_count` (:19-42) gives
// 0 to a record whose id is a NewId (`if not product.id`): in an onchange the warning never applies
registerOnchange(VARIANT, "_onchange_type", ["type"], async () => undefined);

// product_product.py:603-617 with sale :157-170, purchase product.py:186-193, stock product.py:806-813
// `_trigger_uom_warning` on `self.ids` (the origin of the new variant)
registerOnchange(VARIANT, "_onchange_uom_id", ["uom_id"], async (env, rec) => {
  const uom = idOf(await rec.get("uom_id"));
  const old = rec.origin !== null ? idOf(await new DbRec(env, env.reg.model(VARIANT), rec.origin).get("uom_id")) : null;
  if (old === uom || !(await triggerUomWarning(env, rec.origin !== null ? [rec.origin] : []))) return;
  const names = await env.model("uom.uom").displayName([old, uom].filter((x): x is number => x !== null));
  const message = translate(env, "Changing the unit of measure for your product will apply a conversion 1 %(old_uom_name)s = 1 %(new_uom_name)s.\nAll existing records (Sales orders, Purchase orders, etc.) using this product will be updated by replacing the unit name.", "product")
    .split("%(old_uom_name)s").join(old === null ? "" : names.get(old) ?? "").split("%(new_uom_name)s").join(uom === null ? "" : names.get(uom) ?? "");
  return { title: translate(env, "What to expect ?", "product"), message };
});

// sale_project product_product.py:9-17
registerOnchange(VARIANT, "_onchange_service_tracking", ["service_tracking"], async (_env, rec) => {
  const t = await rec.get("service_tracking");
  if (t === "no") {
    await rec.set("project_id", false);
    await rec.set("project_template_id", false);
  } else if (t === "task_global_project") await rec.set("project_template_id", false);
  else if (t === "task_in_project" || t === "project_only") await rec.set("project_id", false);
});

// stock product.py:546-552
registerOnchange(VARIANT, "_onchange_tracking", ["tracking", "store_by"], async (env, rec) => {
  const storeBy = await rec.get("store_by");
  if (storeBy !== "lot" && storeBy !== "serial") return;
  // `qty_available` of a new variant without origin is computed from its NewId: not measured
  if (rec.origin === null) throw new NotPorted("product.product _onchange_tracking of a new variant (qty_available)");
  if (Number((await new DbRec(env, env.reg.model(VARIANT), rec.origin).get("qty_available")) ?? 0) > 0) {
    return {
      title: translate(env, "Warning!", "stock"),
      message: translate(env, "You have product(s) in stock that have no lot/serial number. You can assign lot/serial numbers by doing an inventory adjustment.", "stock"),
    };
  }
});
