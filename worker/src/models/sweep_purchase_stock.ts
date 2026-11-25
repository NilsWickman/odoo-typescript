/**
 * Purchase (`purchase.*`) and Inventory/Stock (`stock.*`) UI `<button type="object">` methods and companion wizard /
 * inverse / override hooks for poc_erp (Odoo 20 Community).
 */
import { NotPorted, RedirectWarning, UserError, ValidationError } from "../errors";
import { registerMethod } from "../http/methods";
import { checkCompany } from "../orm/check_company";
import { create } from "../orm/create";
import { and, cond, or, parseDomain } from "../orm/domain";
import { hasGroup } from "../orm/env";
import { evalExpr } from "../pyexpr";
import { floatRound } from "../orm/convert";
import { RecomputeQueue, recordCompute, registerRecordCompute } from "../orm/recompute";
import { withDbErrors } from "../orm/sql_errors";
import type { Environment } from "../orm/types";
import { unlink } from "../orm/unlink";
import { pyFloat } from "../orm/values";
import { registerOverrides, write } from "../orm/write";
import { renderTemplate } from "../qweb";
import { envFor, isRecord, recordIds } from "../web/common";
import { forXmlId } from "./account_buttons";
import { orderpointDefaultRoute, rulesFromLocation } from "./inventory_flow";
import { lineValues } from "./purchase_bill";
import { nextByCode, nextOfSequence, uomQuantity } from "./sale_flow";
import { actionAssign, postNote, uomCompare, unitDigits } from "./stock_engine";
import { actionApplyInventory, openQuants, pickingConfirm, quantsAction } from "./stock_inventory";
import { procureOrderpoints } from "./stock_procure";
import { quantitiesDict } from "./stock_quantities";
import { createReturn } from "./stock_return";
import { buttonValidate, movesDone } from "./stock_validate";
import { defineComputes, withCompany } from "./tail_util";
import { datetimeToString, dbNow, translate } from "./util";

const idOf = (v: unknown): number | null =>
  typeof v === "number" && v > 0 ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : null;

const numOf = (v: unknown): number =>
  typeof v === "object" && v !== null && "float" in v ? Number((v as { float: number }).float) : Number(v ?? 0);

function ensureOne(ids: readonly number[] | null, model: string): number {
  if (ids === null || ids.length !== 1) throw new NotPorted(`ensure_one on ${model}(${(ids ?? []).join(", ")})`);
  return ids[0]!;
}

async function rows<T extends object>(env: Environment, text: string, params: unknown[] = []): Promise<T[]> {
  return (await env.cr.query<T & Record<string, unknown>>(text, params)).rows;
}

async function refId(env: Environment, xmlid: string): Promise<number> {
  const id = await env.reg.xmlid(env.cr, xmlid);
  if (id === null) throw new NotPorted(`xmlid ${xmlid} not found`);
  return id;
}

async function refIdOrFalse(env: Environment, xmlid: string): Promise<number | false> {
  return (await env.reg.xmlid(env.cr, xmlid)) ?? false;
}

function cleanContext(ctx: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (!k.startsWith("default_")) out[k] = v;
  }
  return out;
}

function evalActionContext(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return { ...(raw as Record<string, unknown>) };
  if (typeof raw !== "string" || !raw.trim()) return {};
  const val = evalExpr(raw, new Map());
  if (val instanceof Map) return Object.fromEntries(val);
  if (val && typeof val === "object" && !Array.isArray(val)) return { ...(val as Record<string, unknown>) };
  return {};
}

function pyRecordsetRepr(model: string, ids: readonly number[]): string {
  if (ids.length === 1) return `${model}(${ids[0]},)`;
  return `${model}(${ids.join(", ")})`;
}

// =================================================================================================================
// PURCHASE (`purchase.order`, `purchase.order.line`, `purchase.bill.line.match`)
// =================================================================================================================

/** purchase_order_line.py:326-336 `_inverse_qty_received`. */
registerOverrides("purchase.order.line", {
  inverse: {
    qty_received: async (env, ids, vals) => {
      if (!ids.length) return;
      const lines = await env.model("purchase.order.line").read([...ids], ["qty_received_method", "qty_received"], "");
      const given = "qty_received" in vals ? numOf(vals["qty_received"]) : null;
      for (const l of lines) {
        const manual = l["qty_received_method"] === "manual" ? (given ?? numOf(l["qty_received"])) : 0;
        await write(env, "purchase.order.line", [Number(l["id"])], { qty_received_manual: manual });
      }
    },
  },
});

/** purchase_order.py:682-693 `action_receive`. */
registerMethod("purchase.order", "action_receive", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const ids = ids0 ?? [];
  if (!ids.length) return null;
  const orders = await env.model("purchase.order").read(ids, ["state", "order_line"], "");
  const byId = new Map(orders.map((o) => [Number(o["id"]), o]));
  const allLineIds = orders.flatMap((o) => (Array.isArray(o["order_line"]) ? (o["order_line"] as number[]) : []));
  const lineRows = allLineIds.length
    ? await env.model("purchase.order.line").read(allLineIds, ["qty_received_method", "product_qty"], "")
    : [];
  const lineById = new Map(lineRows.map((l) => [Number(l["id"]), l]));

  const invalid: number[] = [];
  for (const id of ids) {
    const o = byId.get(id);
    if (!o) continue;
    const oLines = (Array.isArray(o["order_line"]) ? (o["order_line"] as number[]) : []);
    if (o["state"] !== "purchase" || oLines.some((lid) => lineById.get(lid)?.["qty_received_method"] !== "manual")) {
      invalid.push(id);
    }
  }
  if (invalid.length) {
    throw new UserError(
      translate(env, "The following purchase orders %(invalid_orders)s can't be received. Cancelled all receptions.", "purchase")
        .replace("%(invalid_orders)s", pyRecordsetRepr("purchase.order", invalid)),
    );
  }
  for (const id of ids) {
    const o = byId.get(id);
    if (!o) continue;
    const oLines = (Array.isArray(o["order_line"]) ? (o["order_line"] as number[]) : []);
    for (const lid of oLines) {
      const qty = numOf(lineById.get(lid)?.["product_qty"]);
      await write(env, "purchase.order.line", [lid], { qty_received: qty });
    }
  }
  return null;
}, { apiModel: false });

/** sale_purchase/models/purchase_order.py:35-61 + sale_purchase_stock/models/purchase_order.py:14-15 `action_view_sale_orders`. */
registerMethod("purchase.order", "action_view_sale_orders", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "purchase.order");
  const [order] = await env.model("purchase.order").read([id], ["name", "order_line", "reference_ids"], "");
  const saleIds: number[] = [];
  const lineIds = (Array.isArray(order?.["order_line"]) ? (order!["order_line"] as number[]) : []);
  if (lineIds.length) {
    const lRows = await env.model("purchase.order.line").read(lineIds, ["sale_order_id"], "");
    const lById = new Map(lRows.map((r) => [Number(r["id"]), r]));
    for (const lid of lineIds) {
      const sid = idOf(lById.get(lid)?.["sale_order_id"]);
      if (sid !== null && !saleIds.includes(sid)) saleIds.push(sid);
    }
  }
  const refIds = (Array.isArray(order?.["reference_ids"]) ? (order!["reference_ids"] as number[]) : []);
  if (refIds.length) {
    const rRows = await rows<{ sale_id: number }>(
      env,
      "SELECT sale_id FROM stock_reference_sale_rel WHERE reference_id = ANY($1::int[]) ORDER BY sale_id",
      [refIds],
    );
    for (const r of rRows) {
      if (!saleIds.includes(r.sale_id)) saleIds.push(r.sale_id);
    }
  }
  const action: Record<string, unknown> = {
    res_model: "sale.order",
    type: "ir.actions.act_window",
  };
  if (saleIds.length === 1) {
    action["view_mode"] = "form";
    action["res_id"] = saleIds[0];
  } else {
    action["name"] = translate(env, "Sources Sale Orders %s", "sale_purchase").replace("%s", String(order?.["name"] ?? ""));
    action["domain"] = [["id", "in", saleIds]];
    action["view_mode"] = "list,form";
  }
  return action;
}, { apiModel: false });

/** purchase_order.py:739-749 `button_reset_date_order`. */
registerMethod("purchase.order", "button_reset_date_order", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "purchase.order");
  const [order] = await env.model("purchase.order").read([id], ["date_order", "order_line"], "");
  const prevDateStr = typeof order?.["date_order"] === "string" ? order["date_order"] : null;
  const rawNow = await dbNow(env);
  const nowDate = new Date(Math.floor(rawNow.getTime() / 1000) * 1000);
  const nowStr = datetimeToString(nowDate);
  await write(env, "purchase.order", [id], { date_order: nowStr });

  const lineIds = (Array.isArray(order?.["order_line"]) ? (order!["order_line"] as number[]) : []);
  if (lineIds.length) {
    const lines = await env.model("purchase.order.line").read(lineIds, ["selected_seller_id", "date_planned"], "");
    const lineById = new Map(lines.map((l) => [Number(l["id"]), l]));
    for (const lid of lineIds) {
      const l = lineById.get(lid);
      if (!l) continue;
      const sellerId = idOf(l["selected_seller_id"]);
      const plannedStr = typeof l["date_planned"] === "string" ? l["date_planned"] : null;
      let newPlanned: string;
      if (!sellerId && plannedStr && prevDateStr) {
        const diffMs = Date.parse(`${plannedStr.replace(" ", "T")}Z`) - Date.parse(`${prevDateStr.replace(" ", "T")}Z`);
        // Python timedelta.days >= 0 iff diffMs >= 0
        newPlanned = diffMs >= 0 ? datetimeToString(new Date(nowDate.getTime() + diffMs)) : nowStr;
      } else {
        let delay = 0;
        if (sellerId) {
          delay = (await rows<{ delay: number | null }>(env, "SELECT delay FROM product_supplierinfo WHERE id = $1", [sellerId]))[0]?.delay ?? 0;
        }
        newPlanned = datetimeToString(new Date(nowDate.getTime() + delay * 86400000));
      }
      await write(env, "purchase.order.line", [lid], { date_planned: newPlanned });
    }
  }
  return null;
}, { apiModel: false });

/**
 * product/models/product_catalog_mixin.py:17-57 + purchase/models/purchase_order.py:1205-1226
 * + purchase_stock/models/purchase_order.py:137-154 `action_add_from_catalog`.
 */
async function purchaseAddFromCatalog(env: Environment, id: number): Promise<Record<string, unknown>> {
  const childField = env.context["child_field"];
  if (!childField) {
    throw new ValidationError(translate(env, "Catalog missing the child field to update.", "product"));
  }
  const poDef = env.reg.model("purchase.order");
  if (typeof childField !== "string" || !poDef.fields.has(childField)) {
    throw new ValidationError(translate(env, "Wrong catalog child field!", "product"));
  }
  const [order] = await env.model("purchase.order").read(
    [id],
    ["company_id", "currency_id", "partner_id", "picking_type_id", "state"],
    "",
  );
  const companyId = idOf(order?.["company_id"]) ?? await env.company();
  const currencyId = idOf(order?.["currency_id"]) ?? (await rows<{ c: number }>(env, "SELECT currency_id AS c FROM res_company WHERE id = $1", [companyId]))[0]!.c;
  const partnerId = idOf(order?.["partner_id"]);
  const pickingTypeId = idOf(order?.["picking_type_id"]);
  const warehouseId = pickingTypeId
    ? ((await rows<{ w: number | null }>(env, "SELECT warehouse_id AS w FROM stock_picking_type WHERE id = $1", [pickingTypeId]))[0]?.w ?? false)
    : false;
  let vendorName: string | false = false;
  let suggestDays: unknown = 0;
  let suggestBasedOn: unknown = false;
  let suggestPercent: unknown = 0;
  if (partnerId) {
    vendorName = (await env.model("res.partner").displayName([partnerId])).get(partnerId) ?? false;
    const [pRow] = await env.model("res.partner").read([partnerId], ["suggest_days", "suggest_based_on", "suggest_percent"], "");
    suggestDays = pRow?.["suggest_days"] ?? 0;
    suggestBasedOn = pRow?.["suggest_based_on"] ?? false;
    suggestPercent = pRow?.["suggest_percent"] ?? 0;
  }
  const unitPrec = await unitDigits(env);

  const additionalContext: Record<string, unknown> = {
    product_catalog_order_id: id,
    product_catalog_order_model: "purchase.order",
    product_catalog_currency_id: currencyId,
    show_prices: true,
    show_sections: Boolean(id),
    precision: unitPrec,
    product_catalog_digits: false,
    is_purchase_document: true,
    search_default_sold_by_vendor_id: partnerId ?? false,
    partner_id: partnerId ?? false,
    warehouse_id: warehouseId,
    vendor_name: vendorName,
    vendor_suggest_days: suggestDays,
    vendor_suggest_based_on: suggestBasedOn,
    vendor_suggest_percent: suggestPercent,
    product_catalog_order_state: order?.["state"] ?? false,
    display_stock: true,
  };
  const context: Record<string, unknown> = { ...env.context, ...additionalContext };
  delete context["form_view_ref"];
  const kanbanViewId = await refId(env, "purchase_stock.product_view_kanban_catalog_purchase_only");
  const searchViewId = await refId(env, "purchase.product_view_search_catalog");
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Products", "product"),
    res_model: "product.product",
    views: [[kanbanViewId, "kanban"], [false, "form"]],
    search_view_id: [searchViewId, "search"],
    domain: [
      "&",
      "&",
      "|",
      ["company_id", "=", false],
      ["company_id", "parent_of", companyId],
      ["type", "!=", "combo"],
      ["purchase_ok", "=", true],
    ],
    context,
  };
}

registerMethod("purchase.order", "action_add_from_catalog", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "purchase.order");
  return purchaseAddFromCatalog(env, id);
}, { apiModel: false });

/** purchase_order_line.py:695-697 `action_add_from_catalog`. */
registerMethod("purchase.order.line", "action_add_from_catalog", async (env0, _ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const orderId = idOf(env.context["order_id"]);
  if (orderId === null) throw new NotPorted("purchase.order.line.action_add_from_catalog without order_id in context");
  return purchaseAddFromCatalog(env.withContext({ ...env.context, child_field: "order_line" }), orderId);
}, { apiModel: false });

/** purchase_order.py:764-782 `action_bill_matching`. */
registerMethod("purchase.order", "action_bill_matching", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "purchase.order");
  const [order] = await env.model("purchase.order").read([id], ["partner_id"], "");
  const partnerId = idOf(order?.["partner_id"]);
  const partnerIds: number[] = [];
  if (partnerId !== null) {
    partnerIds.push(partnerId);
    const comm = (await rows<{ c: number | null }>(env, "SELECT commercial_partner_id AS c FROM res_partner WHERE id = $1", [partnerId]))[0]?.c;
    if (comm && !partnerIds.includes(comm)) partnerIds.push(comm);
  }
  const companyId = await env.company();
  const viewId = await refId(env, "purchase.purchase_bill_line_match_tree");
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Bill Matching", "purchase"),
    res_model: "purchase.bill.line.match",
    context: { partner_id: partnerId ?? false },
    domain: [
      ["partner_id", "in", partnerIds],
      ["company_id", "in", [companyId]],
      "|",
      "|",
      ["purchase_order_id", "=", id],
      ["matching_id", "=", 0],
      ["aml_id.purchase_order_id", "=", id],
    ],
    views: [[viewId, "list"]],
  };
}, { apiModel: false });

/** purchase_order_line.py:725-743 `action_open_invoices`. */
registerMethod("purchase.order.line", "action_open_invoices", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "purchase.order.line");
  await env.model("purchase.order.line").read([id], ["id"], "");
  const moveRows = await rows<{ move_id: number }>(
    env,
    "SELECT move_id FROM account_move_line WHERE purchase_line_id = $1 ORDER BY id",
    [id],
  );
  const invoiceIds: number[] = [];
  for (const r of moveRows) if (!invoiceIds.includes(r.move_id)) invoiceIds.push(r.move_id);
  const action: Record<string, unknown> = {
    res_model: "account.move",
    type: "ir.actions.act_window",
  };
  if (invoiceIds.length === 1) {
    action["view_mode"] = "form";
    action["res_id"] = invoiceIds[0];
  } else {
    action["name"] = translate(env, "Matching Invoices", "purchase");
    action["domain"] = [["id", "in", invoiceIds]];
    action["view_mode"] = "list,form";
  }
  return action;
}, { apiModel: false });

/** Helper: decode purchase.bill.line.match ids (positive = purchase.order.line, negative = -account.move.line). */
async function readBillMatchLines(env: Environment, ids: readonly number[]): Promise<{
  polIds: number[];
  amlIds: number[];
  poIds: number[];
  partnerIds: number[];
}> {
  const polIds: number[] = [];
  const amlIds: number[] = [];
  for (const id of ids) {
    if (id > 0) polIds.push(id);
    else if (id < 0) amlIds.push(-id);
  }
  const poIds: number[] = [];
  const partnerIds: number[] = [];
  if (polIds.length) {
    const pRows = await rows<{ id: number; order_id: number; partner_id: number | null }>(
      env,
      "SELECT id, order_id, partner_id FROM purchase_order_line WHERE id = ANY($1::int[])",
      [polIds],
    );
    const byId = new Map(pRows.map((r) => [r.id, r]));
    for (const pid of polIds) {
      const r = byId.get(pid);
      if (!r) continue;
      if (!poIds.includes(r.order_id)) poIds.push(r.order_id);
      if (r.partner_id && !partnerIds.includes(r.partner_id)) partnerIds.push(r.partner_id);
    }
  }
  if (amlIds.length) {
    const aRows = await rows<{ id: number; partner_id: number | null }>(
      env,
      "SELECT l.id, m.partner_id FROM account_move_line l JOIN account_move m ON m.id = l.move_id WHERE l.id = ANY($1::int[])",
      [amlIds],
    );
    const byId = new Map(aRows.map((r) => [r.id, r]));
    for (const aid of amlIds) {
      const r = byId.get(aid);
      if (r?.partner_id && !partnerIds.includes(r.partner_id)) partnerIds.push(r.partner_id);
    }
  }
  return { polIds, amlIds, poIds, partnerIds };
}

/** purchase_bill_line_match.py:160-167 `action_open_line`. */
registerMethod("purchase.bill.line.match", "action_open_line", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "purchase.bill.line.match");
  if (id < 0) {
    const moveId = (await rows<{ m: number }>(env, "SELECT move_id AS m FROM account_move_line WHERE id = $1", [-id]))[0]?.m ?? false;
    return { type: "ir.actions.act_window", res_model: "account.move", view_mode: "form", res_id: moveId };
  }
  const orderId = (await rows<{ o: number }>(env, "SELECT order_id AS o FROM purchase_order_line WHERE id = $1", [id]))[0]?.o ?? false;
  return { type: "ir.actions.act_window", res_model: "purchase.order", view_mode: "form", res_id: orderId };
}, { apiModel: false });

/** purchase_bill_line_match.py:225-231 `action_unmatch_lines`. */
registerMethod("purchase.bill.line.match", "action_unmatch_lines", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const ids = ids0 ?? [];
  if (!ids.length) return null;
  // Group by matching_id: for pol_id, matching_id = pol.id; for aml_id, matching_id = aml.purchase_line_id
  const polSet = new Set(ids.filter((i) => i > 0));
  const amlIds = ids.filter((i) => i < 0).map((i) => -i);
  if (!amlIds.length) return null;
  const aRows = await rows<{ id: number; pl: number | null }>(
    env,
    "SELECT id, purchase_line_id AS pl FROM account_move_line WHERE id = ANY($1::int[])",
    [amlIds],
  );
  const toUnmatch: number[] = [];
  const affectedPols: number[] = [];
  for (const r of aRows) {
    if (r.pl && polSet.has(r.pl)) {
      toUnmatch.push(r.id);
      if (!affectedPols.includes(r.pl)) affectedPols.push(r.pl);
    }
  }
  if (toUnmatch.length) {
    await env.cr.query(
      "UPDATE account_move_line SET purchase_line_id = NULL, write_uid = $1, write_date = (now() AT TIME ZONE 'UTC') WHERE id = ANY($2::int[])",
      [env.uid, toUnmatch],
    );
    const q = new RecomputeQueue(env.sudo());
    await q.modified("purchase.order.line", affectedPols, ["invoice_lines"]);
    await q.run();
  }
  return null;
}, { apiModel: false });

/** purchase_bill_line_match.py:233-255 `action_add_to_po`. */
registerMethod("purchase.bill.line.match", "action_add_to_po", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const ids = ids0 ?? [];
  const { amlIds, poIds, partnerIds } = await readBillMatchLines(env, ids);
  if (!ids.length || !amlIds.length) {
    throw new UserError(translate(env, "Select Vendor Bill lines to add to a Purchase Order", "purchase"));
  }
  const commPartners = partnerIds.length
    ? [...new Set((await rows<{ c: number }>(env, "SELECT commercial_partner_id AS c FROM res_partner WHERE id = ANY($1::int[])", [partnerIds])).map((r) => r.c))]
    : [];
  if (commPartners.length > 1) {
    throw new UserError(translate(env, "Please select bill lines with the same vendor.", "purchase"));
  }
  if (poIds.length > 1) {
    throw new UserError(translate(env, "Vendor Bill lines can only be added to one Purchase Order.", "purchase"));
  }
  const hasProducts = (await rows(env, "SELECT 1 FROM account_move_line WHERE id = ANY($1::int[]) AND product_id IS NOT NULL LIMIT 1", [amlIds])).length > 0;
  const context: Record<string, unknown> = {
    default_partner_id: commPartners[0] ?? false,
    dialog_size: "medium",
    has_products: hasProducts,
  };
  if (poIds.length === 1) context["default_purchase_order_id"] = poIds[0];
  const viewId = await refId(env, "purchase.bill_to_po_wizard_form");
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Add to Purchase Order", "purchase"),
    res_model: "bill.to.po.wizard",
    target: "new",
    views: [[viewId, "form"]],
    context,
  };
}, { apiModel: false });

/** purchase_bill_line_match.py:169-224 `action_match_lines` + `_action_create_bill_from_po_lines`. */
registerMethod("purchase.bill.line.match", "action_match_lines", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const ids = ids0 ?? [];
  const { polIds, amlIds, partnerIds } = await readBillMatchLines(env, ids);
  if (!polIds.length) {
    throw new UserError(translate(env, "You must select at least one Purchase Order line to match or create bill.", "purchase"));
  }
  if (!amlIds.length) {
    // `_action_create_bill_from_po_lines(self.partner_id, self.pol_id)`
    const polRows = await rows<{ id: number; currency_id: number; company_id: number }>(
      env,
      "SELECT l.id, o.currency_id, l.company_id FROM purchase_order_line l JOIN purchase_order o ON o.id = l.order_id WHERE l.id = ANY($1::int[])",
      [polIds],
    );
    const currencies = [...new Set(polRows.map((r) => r.currency_id))];
    const companies = [...new Set(polRows.map((r) => r.company_id))];
    let currencyId: number;
    if (currencies.length === 1) currencyId = currencies[0]!;
    else if (companies.length === 1) {
      currencyId = (await rows<{ c: number }>(env, "SELECT currency_id AS c FROM res_company WHERE id = $1", [companies[0]]))[0]!.c;
    } else {
      currencyId = (await rows<{ c: number }>(env, "SELECT currency_id AS c FROM res_company WHERE id = $1", [await env.company()]))[0]!.c;
    }
    const lineCmds: unknown[] = [];
    for (const pid of polIds) {
      lineCmds.push([0, 0, await lineValues(env, pid)]);
    }
    const [billId] = await create(env, "account.move", [{
      move_type: "in_invoice",
      partner_id: partnerIds.length === 1 ? partnerIds[0] : (partnerIds[0] ?? false),
      currency_id: currencyId,
    }]);
    await write(env, "account.move", [billId!], { invoice_line_ids: lineCmds });
    await env.cr.query("UPDATE account_move SET is_manually_modified = true WHERE id = $1", [billId]);
    const q = new RecomputeQueue(env.sudo());
    await q.modified("purchase.order.line", polIds, ["invoice_lines"]);
    await q.run();
    // purchase/models/account_invoice.py:279-286: "This vendor bill has been modified from: ..."
    const poIdsForBill = [...new Set((await rows<{ o: number }>(
      env,
      "SELECT order_id AS o FROM purchase_order_line WHERE id = ANY($1::int[]) ORDER BY id",
      [polIds],
    )).map((r) => r.o))];
    if (poIdsForBill.length) {
      const poNames = await env.model("purchase.order").displayName(poIdsForBill);
      const esc = (v: string): string => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const refs = poIdsForBill.map((oid) => `<a href="#" data-oe-model="purchase.order" data-oe-id="${oid}">${esc(poNames.get(oid) ?? "")}</a>`).join(",");
      const intro = esc(translate(env, "This vendor bill has been modified from: ", "purchase"));
      await postNote(env, "account.move", billId!, `<p>${intro}${refs}</p>`);
    }
    // ir_ui_view.py:3307-3328 `_get_records_action`
    return {
      type: "ir.actions.act_window",
      res_model: "account.move",
      target: "current",
      context: { ...env.context },
      views: [[false, "form"]],
      res_id: billId,
    };
  }

  // Match POLs and AMLs by product_id
  const polData = await rows<{ id: number; product_id: number | null }>(
    env,
    "SELECT id, product_id FROM purchase_order_line WHERE id = ANY($1::int[])",
    [polIds],
  );
  const amlData = await rows<{ id: number; product_id: number | null; move_id: number }>(
    env,
    "SELECT id, product_id, move_id FROM account_move_line WHERE id = ANY($1::int[])",
    [amlIds],
  );
  const polMap = new Map(polData.map((r) => [r.id, r]));
  const amlMap = new Map(amlData.map((r) => [r.id, r]));
  const polByProduct = new Map<number | null, number[]>();
  for (const pid of polIds) {
    const p = polMap.get(pid)?.product_id ?? null;
    polByProduct.set(p, [...(polByProduct.get(p) ?? []), pid]);
  }
  const amlByProduct = new Map<number | null, number[]>();
  for (const aid of amlIds) {
    const p = amlMap.get(aid)?.product_id ?? null;
    amlByProduct.set(p, [...(amlByProduct.get(p) ?? []), aid]);
  }

  const matchedPols = new Set<number>();
  const matchedAmls = new Set<number>();
  const affectedPols = new Set<number>();
  for (const [product, pLines] of polByProduct) {
    const bLines = amlByProduct.get(product);
    if (!bLines?.length) continue;
    const count = Math.min(pLines.length, bLines.length);
    for (let i = 0; i < count; i++) {
      await env.cr.query(
        "UPDATE account_move_line SET purchase_line_id = $1, write_uid = $2, write_date = (now() AT TIME ZONE 'UTC') WHERE id = $3",
        [pLines[i]!, env.uid, bLines[i]!],
      );
      matchedPols.add(pLines[i]!);
      matchedAmls.add(bLines[i]!);
      affectedPols.add(pLines[i]!);
    }
    const remaining = bLines.slice(count);
    if (remaining.length) {
      const lastPol = pLines[pLines.length - 1]!;
      await env.cr.query(
        "UPDATE account_move_line SET purchase_line_id = $1, write_uid = $2, write_date = (now() AT TIME ZONE 'UTC') WHERE id = ANY($3::int[])",
        [lastPol, env.uid, remaining],
      );
      for (const r of remaining) matchedAmls.add(r);
      affectedPols.add(lastPol);
    }
  }
  const residualPols = polIds.filter((pid) => !matchedPols.has(pid));
  const residualAmls = amlIds.filter((aid) => !matchedAmls.has(aid));
  const moveIds = [...new Set(amlIds.map((aid) => amlMap.get(aid)?.move_id).filter((m): m is number => m !== undefined))];
  if (matchedAmls.size && moveIds.length) {
    await env.cr.query(
      "UPDATE account_move SET is_manually_modified = true, write_uid = $1, write_date = (now() AT TIME ZONE 'UTC') WHERE id = ANY($2::int[])",
      [env.uid, moveIds],
    );
  }
  if (moveIds.length === 1) {
    const billId = moveIds[0]!;
    if (residualAmls.length) await unlink(env, "account.move.line", residualAmls);
    if (residualPols.length) {
      const addCmds: unknown[] = [];
      for (const pid of residualPols) {
        addCmds.push([0, 0, await lineValues(env, pid)]);
        affectedPols.add(pid);
      }
      await write(env, "account.move", [billId], { invoice_line_ids: addCmds });
    }
  }
  if (affectedPols.size) {
    const q = new RecomputeQueue(env.sudo());
    await q.modified("purchase.order.line", [...affectedPols], ["invoice_lines"]);
    await q.run();
  }
  return null;
}, { apiModel: false });

// =================================================================================================================
// STOCK PICKING & PICKING TYPE (`stock.picking`, `stock.picking.type`)
// =================================================================================================================

/** stock_picking.py:304-313 `_compute_show_lots_text`. */
defineComputes("stock.picking", {
  show_lots_text: async (env, rec) => {
    const groupEnabled = await hasGroup(env, "stock.group_production_lot");
    const pt = await rec.rel("picking_type_id");
    const useCreate = pt ? Boolean(await pt.get("use_create_lots")) : false;
    const useExisting = pt ? Boolean(await pt.get("use_existing_lots")) : false;
    const mlIds = (Array.isArray(await rec.get("move_line_ids")) ? (await rec.get("move_line_ids")) as number[] : []);
    if (!mlIds.length && !useCreate) return false;
    return groupEnabled && useCreate && !useExisting && (await rec.get("state")) !== "done";
  },
});

/** stock_picking.py:862-882 `action_detailed_operations`. */
registerMethod("stock.picking", "action_detailed_operations", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.picking");
  const [p] = await env.model("stock.picking").read(
    [id],
    ["location_id", "location_dest_id", "company_id", "show_lots_text", "picking_type_code", "state"],
    "",
  );
  const moveStates = (await rows<{ state: string }>(env, "SELECT state FROM stock_move WHERE picking_id = $1", [id])).map((r) => r.state);
  const viewId = await refId(env, "stock.view_stock_move_line_detailed_operation_tree");
  return {
    name: translate(env, "Detailed Operations", "stock"),
    view_mode: "list",
    type: "ir.actions.act_window",
    res_model: "stock.move.line",
    views: [[viewId, "list"]],
    domain: [["picking_id", "=", id]],
    context: {
      sml_specific_default: true,
      default_picking_id: id,
      default_location_id: idOf(p?.["location_id"]) ?? false,
      default_location_dest_id: idOf(p?.["location_dest_id"]) ?? false,
      default_company_id: idOf(p?.["company_id"]) ?? false,
      show_lots_text: Boolean(p?.["show_lots_text"]),
      picking_code: p?.["picking_type_code"] ?? false,
      create: !["done", "cancel"].includes(String(p?.["state"] ?? "")),
      hide_put_in_pack: moveStates.every((s) => s === "done" || s === "cancel"),
    },
  };
}, { apiModel: false });

/** stock_picking.py:1805-1812 `action_picking_move_tree`. */
registerMethod("stock.picking", "action_picking_move_tree", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const ids = ids0 ?? [];
  const action = await forXmlId(env, "stock.stock_move_action");
  const viewId = await refId(env, "stock.view_picking_move_tree");
  action["views"] = [[viewId, "list"]];
  action["context"] = { ...env.context };
  action["domain"] = [["picking_id", "in", ids]];
  return action;
}, { apiModel: false });

/** stock_picking.py:552-555 `_get_next_transfers` + :884-900 `action_next_transfer`. */
registerMethod("stock.picking", "action_next_transfer", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const ids = ids0 ?? [];
  if (ids.length) await env.model("stock.picking").read(ids, ["id"], "");
  const nextRows = ids.length
    ? await rows<{ id: number }>(
        env,
        `SELECT DISTINCT md.picking_id AS id
           FROM stock_move m
           JOIN stock_move_move_rel rel ON rel.move_orig_id = m.id
           JOIN stock_move md ON md.id = rel.move_dest_id
          WHERE m.picking_id = ANY($1::int[]) AND md.picking_id IS NOT NULL
            AND md.picking_id NOT IN (SELECT id FROM stock_picking WHERE return_id = ANY($1::int[]))
          ORDER BY md.picking_id`,
        [ids],
      )
    : [];
  const nextIds = nextRows.map((r) => r.id);
  if (nextIds.length === 1) {
    return {
      type: "ir.actions.act_window",
      res_model: "stock.picking",
      views: [[false, "form"]],
      res_id: nextIds[0],
    };
  }
  return {
    name: translate(env, "Next Transfers", "stock"),
    type: "ir.actions.act_window",
    res_model: "stock.picking",
    views: [[false, "list"], [false, "form"]],
    domain: [["id", "in", nextIds]],
  };
}, { apiModel: false });

/** stock_picking.py:1848-1863 `action_see_returns`. */
registerMethod("stock.picking", "action_see_returns", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.picking");
  await env.model("stock.picking").read([id], ["id"], "");
  const returnIds = await env.model("stock.picking").search(cond("return_id", "=", id), { order: "id" });
  if (returnIds.length === 1) {
    return {
      type: "ir.actions.act_window",
      res_model: "stock.picking",
      views: [[false, "form"]],
      res_id: returnIds[0],
    };
  }
  return {
    name: translate(env, "Returns", "stock"),
    type: "ir.actions.act_window",
    res_model: "stock.picking",
    views: [[false, "list"], [false, "form"]],
    domain: [["id", "in", returnIds]],
  };
}, { apiModel: false });

/** stock_picking.py:1762-1772 `action_see_move_scrap`. */
registerMethod("stock.picking", "action_see_move_scrap", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.picking");
  await env.model("stock.picking").read([id], ["id"], "");
  const listView = await refId(env, "stock.view_scrap_move_list");
  const formView = await refId(env, "stock.view_scrap_move_form");
  return {
    type: "ir.actions.act_window",
    name: "Scraps",
    res_model: "stock.move",
    views: [[listView, "list"], [formView, "form"]],
    domain: [["picking_id", "=", id], ["is_scrap", "=", true]],
    context: { ...env.context, create: false },
  };
}, { apiModel: false });

/** stock_picking.py:1717-1745 `action_scrap`. */
registerMethod("stock.picking", "action_scrap", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.picking");
  const [p] = await env.model("stock.picking").read(
    [id],
    ["name", "state", "company_id", "location_id", "location_dest_id"],
    "",
  );
  const viewId = await refId(env, "stock.view_scrap_move_form");
  const prodRows = await rows<{ product_id: number }>(
    env,
    `SELECT m.product_id FROM stock_move m
       JOIN product_product pp ON pp.id = m.product_id
       JOIN product_template pt ON pt.id = pp.product_tmpl_id
      WHERE m.picking_id = $1 AND m.state NOT IN ('draft', 'cancel') AND pt.type = 'consu'
      ORDER BY m.sequence, m.id`,
    [id],
  );
  const productIds: number[] = [];
  for (const r of prodRows) if (!productIds.includes(r.product_id)) productIds.push(r.product_id);
  const lotRows = await rows<{ lot_id: number }>(
    env,
    "SELECT lot_id FROM stock_move_line WHERE picking_id = $1 AND lot_id IS NOT NULL ORDER BY id",
    [id],
  );
  const lotIds: number[] = [];
  for (const r of lotRows) if (!lotIds.includes(r.lot_id)) lotIds.push(r.lot_id);
  const companyId = await env.company();
  const scrapLoc = (await rows<{ s: number | null }>(env, "SELECT scrap_location_id AS s FROM res_company WHERE id = $1", [companyId]))[0]?.s ?? false;
  return {
    name: translate(env, "Scrap Products", "stock"),
    view_mode: "form",
    res_model: "stock.move",
    view_id: viewId,
    views: [[viewId, "form"]],
    type: "ir.actions.act_window",
    context: {
      from_order: true,
      product_ids: productIds,
      lot_ids: lotIds,
      default_is_scrap: true,
      default_picking_id: id,
      default_company_id: idOf(p?.["company_id"]) ?? false,
      default_location_id: p?.["state"] === "done" ? (idOf(p?.["location_dest_id"]) ?? false) : (idOf(p?.["location_id"]) ?? false),
      default_location_dest_id: scrapLoc,
      default_origin: p?.["name"] ?? false,
      default_state: "draft",
    },
    target: "new",
  };
}, { apiModel: false });

/** stock_picking.py:838-841 `action_clear_return`. */
registerMethod("stock.picking", "action_clear_return", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.picking");
  const [p] = await env.model("stock.picking").read([id], ["return_id", "move_ids"], "");
  if (idOf(p?.["return_id"]) !== null) {
    const moveIds = (Array.isArray(p?.["move_ids"]) ? (p!["move_ids"] as number[]) : []);
    if (moveIds.length) await write(env, "stock.move", moveIds, { product_uom_qty: 0 });
  }
  return null;
}, { apiModel: false });

/** stock_picking.py:823-836 `action_return_all`. */
registerMethod("stock.picking", "action_return_all", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.picking");
  const [p] = await env.model("stock.picking").read([id], ["return_id"], "");
  if (idOf(p?.["return_id"]) !== null) {
    const moves = await rows<{ id: number; state: string; origin_returned_move_id: number | null }>(
      env,
      `SELECT m.id, m.state, m.origin_returned_move_id
         FROM stock_move m
        WHERE m.picking_id = $1 AND m.state NOT IN ('done', 'cancel') ORDER BY m.sequence, m.id`,
      [id],
    );
    const digits = await unitDigits(env);
    for (const rm of moves) {
      let qty = 0;
      if (rm.origin_returned_move_id) {
        qty = (await rows<{ q: number }>(env, "SELECT COALESCE(quantity, 0)::float8 AS q FROM stock_move WHERE id = $1", [rm.origin_returned_move_id]))[0]?.q ?? 0;
        const dests = await rows<{ id: number; origin_returned_move_id: number | null; q: number }>(
          env,
          `SELECT md.id, md.origin_returned_move_id, COALESCE(md.quantity, 0)::float8 AS q
             FROM stock_move_move_rel rel JOIN stock_move md ON md.id = rel.move_dest_id
            WHERE rel.move_orig_id = $1 AND md.id != $2`,
          [rm.origin_returned_move_id, rm.id],
        );
        for (const d of dests) {
          if (d.origin_returned_move_id === rm.origin_returned_move_id) qty -= d.q;
        }
      }
      await write(env, "stock.move", [rm.id], { product_uom_qty: floatRound(qty, digits) });
    }
  }
  return null;
}, { apiModel: false });

/** stock_picking.py:843-860 `action_exchange`. */
registerMethod("stock.picking", "action_exchange", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.picking");
  const [p] = await env.model("stock.picking").read([id], ["return_id"], "");
  if (idOf(p?.["return_id"]) === null) return null;
  const newPickingId = await createReturn(env, id);
  const newMoves = (await rows<{ id: number }>(env, "SELECT id FROM stock_move WHERE picking_id = $1 ORDER BY id", [newPickingId])).map((r) => r.id);
  if (newMoves.length) {
    await write(env, "stock.move", newMoves, { origin_returned_move_id: false, move_orig_ids: [[5, 0, 0]] });
  }
  await pickingConfirm(env, [newPickingId]);
  // stock_picking.py:787-800 `action_assign`
  const openMoves = await rows<{ id: number; priority: string | null; deadline: string | null; date: string }>(
    env,
    `SELECT id, priority, to_char(date_deadline, 'YYYY-MM-DD HH24:MI:SS.US') AS deadline, to_char(date, 'YYYY-MM-DD HH24:MI:SS.US') AS date
       FROM stock_move WHERE picking_id = $1 AND state NOT IN ('draft', 'cancel', 'done')`,
    [newPickingId],
  );
  if (!openMoves.length) throw new UserError(translate(env, "There is nothing to reserve.", "stock"));
  const cmp = (a: string | null, b: string | null): number => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1);
  openMoves.sort((a, b) => (-Number(a.priority ?? 0)) - (-Number(b.priority ?? 0))
    || Number(a.deadline === null) - Number(b.deadline === null) || cmp(a.deadline, b.deadline) || cmp(a.date, b.date) || a.id - b.id);
  await actionAssign(env, openMoves.map((m) => m.id));
  return {
    name: translate(env, "Returned Picking", "stock"),
    type: "ir.actions.act_window",
    res_model: "stock.picking",
    res_id: newPickingId,
    view_mode: "form",
    context: { ...env.context },
  };
}, { apiModel: false });

/** stock_picking.py:1774-1789 `action_see_packages`. */
registerMethod("stock.picking", "action_see_packages", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.picking");
  const [p] = await env.model("stock.picking").read([id], ["location_id", "picking_type_code"], "");
  const listView = await refId(env, "stock.stock_package_view_list_editable");
  return {
    name: translate(env, "Packages", "stock"),
    res_model: "stock.package",
    view_mode: "list,kanban,form",
    views: [[listView, "list"], [false, "kanban"], [false, "form"]],
    type: "ir.actions.act_window",
    domain: [["picking_ids", "in", [id]]],
    context: {
      picking_ids: [id],
      location_id: idOf(p?.["location_id"]) ?? false,
      can_add_entire_packs: p?.["picking_type_code"] !== "incoming",
      search_default_main_packages: true,
    },
  };
}, { apiModel: false });

/** stock_picking.py:1791-1803 `action_see_package_histories`. */
registerMethod("stock.picking", "action_see_package_histories", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.picking");
  await env.model("stock.picking").read([id], ["id"], "");
  return {
    name: translate(env, "Packages", "stock"),
    res_model: "stock.package.history",
    view_mode: "list",
    views: [[false, "list"]],
    type: "ir.actions.act_window",
    domain: [["picking_ids", "=", id]],
    context: {
      search_default_main_packages: 1,
    },
  };
}, { apiModel: false });

/** stock_picking.py:1814-1815 `action_view_allocation_report`. */
registerMethod("stock.picking", "action_view_allocation_report", async (env0, _ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  return forXmlId(env, "stock.allocation_report_action");
}, { apiModel: false });

/** stock_package.py:278-287 `create` (default name from package_type sequence or `stock.package` sequence). */
async function nextPackageName(env: Environment, packageTypeId: number | null): Promise<string> {
  if (packageTypeId) {
    const seq = (await rows<{ id: number; prefix: string | null; suffix: string | null; padding: number; implementation: string; use_date_range: boolean | null }>(
      env,
      `SELECT s.id, s.prefix, s.suffix, s.padding, s.implementation, s.use_date_range
         FROM stock_package_type pt JOIN ir_sequence s ON s.id = pt.sequence_id WHERE pt.id = $1`,
      [packageTypeId],
    ))[0];
    if (seq) return nextOfSequence(env, seq, "stock.package.type");
  }
  return (await nextByCode(env, "stock.package")) || "PACK";
}

/** stock_package.py:92-105 `_compute_complete_name` & `_compute_dest_complete_name`, :156-169 `_compute_package_info`. */
registerRecordCompute("stock.package", {
  complete_name: async (_env, rec) => {
    const name = String((await rec.get("name")) ?? "");
    const parent = await rec.rel("parent_package_id");
    if (parent) {
      const pName = String((await parent.get("complete_name")) ?? "");
      return `${pName} > ${name}`;
    }
    return name;
  },
  dest_complete_name: async (_env, rec) => {
    const name = String((await rec.get("name")) ?? "");
    const parent = await rec.rel("package_dest_id");
    if (parent) {
      const pName = String((await parent.get("dest_complete_name")) ?? "");
      return `${pName} > ${name}`;
    }
    return name;
  },
  location_id: async (env, rec) => {
    if (rec.origin === null) return false;
    const qs = await rows<{ location_id: number; quantity: number }>(
      env,
      "SELECT location_id, quantity::float8 AS quantity FROM stock_quant WHERE package_id = $1 ORDER BY id",
      [rec.origin],
    );
    for (const q of qs) {
      if ((await uomCompare(env, q.quantity, 0)) > 0) return q.location_id;
    }
    const child = (await rows<{ location_id: number | null }>(
      env,
      "SELECT location_id FROM stock_package WHERE parent_package_id = $1 ORDER BY id LIMIT 1",
      [rec.origin],
    ))[0];
    return child?.location_id ?? false;
  },
  company_id: async (env, rec) => {
    if (rec.origin === null) return false;
    const qs = await rows<{ company_id: number | null; quantity: number }>(
      env,
      "SELECT company_id, quantity::float8 AS quantity FROM stock_quant WHERE package_id = $1 ORDER BY id",
      [rec.origin],
    );
    const pos = [];
    for (const q of qs) if ((await uomCompare(env, q.quantity, 0)) > 0) pos.push(q);
    if (pos.length) {
      const c = pos[0]!.company_id;
      return qs.every((q) => q.company_id === c) ? (c ?? false) : false;
    }
    const children = await rows<{ company_id: number | null }>(
      env,
      "SELECT company_id FROM stock_package WHERE parent_package_id = $1 ORDER BY id",
      [rec.origin],
    );
    if (children.length) {
      const c = children[0]!.company_id;
      return children.every((ch) => ch.company_id === c) ? (c ?? false) : false;
    }
    return false;
  },
});

registerOverrides("stock.package", {
  create: async (env, valsList, next) => {
    const prepared = [];
    for (const v0 of valsList) {
      const v = { ...v0 };
      if (v["complete_name"]) {
        v["name"] = v["complete_name"];
        delete v["complete_name"];
      }
      if (!v["name"]) {
        v["name"] = await nextPackageName(env, idOf(v["package_type_id"]));
      }
      prepared.push(v);
    }
    return next(env, prepared);
  },
});

/** stock_move_line.py:1068-1202 `action_put_in_pack` + stock_picking.py:1592-1597 + stock_package.py:347-368. */
async function moveLinesPutInPack(
  env: Environment,
  lineIds0: readonly number[],
  opts: { package_id?: number | false | undefined; package_type_id?: number | false | undefined; package_name?: string | false | undefined; package_capacity?: number | null | undefined } = {},
): Promise<unknown> {
  let lineIds = [...lineIds0];
  const pkgId = idOf(opts.package_id);
  const pkgTypeId = idOf(opts.package_type_id);
  const pkgName = typeof opts.package_name === "string" && opts.package_name ? opts.package_name : false;

  if (opts.package_capacity && lineIds.length === 1) {
    const [ml] = await rows<{ quantity: number }>(env, "SELECT COALESCE(quantity, 0)::float8 AS quantity FROM stock_move_line WHERE id = $1", [lineIds[0]]);
    if (ml && opts.package_capacity !== ml.quantity) {
      throw new NotPorted("stock.move.line.action_put_in_pack with package_capacity splitting");
    }
  }
  if (Array.isArray(env.context["all_move_line_ids"])) {
    lineIds = (env.context["all_move_line_ids"] as number[]).map(Number);
  }
  const forceMoveLines = Boolean(env.context["force_move_lines"]);
  if (!lineIds.length) return null;

  const mlRows = await rows<{
    id: number; state: string; quantity: number; picked: boolean | null; result_package_id: number | null;
    location_dest_id: number; picking_id: number | null; picking_type_id: number | null; move_id: number | null;
    set_package_type: boolean | null; auto_print_package_label: boolean | null;
  }>(
    env,
    `SELECT ml.id, ml.state, COALESCE(ml.quantity, 0)::float8 AS quantity, ml.picked, ml.result_package_id,
            ml.location_dest_id, ml.picking_id, p.picking_type_id, ml.move_id,
            pt.set_package_type, pt.auto_print_package_label
       FROM stock_move_line ml
       LEFT JOIN stock_picking p ON p.id = ml.picking_id
       LEFT JOIN stock_picking_type pt ON pt.id = p.picking_type_id
      WHERE ml.id = ANY($1::int[]) ORDER BY ml.id`,
    [lineIds],
  );
  const byId = new Map(mlRows.map((r) => [r.id, r]));
  const ordered = lineIds.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => r !== undefined);

  const ptIds = [...new Set(ordered.map((r) => r.picking_type_id).filter((x): x is number => x !== null))];
  if (ptIds.length > 1) {
    throw new UserError(translate(env, "You cannot pack products into the same package when they are from different transfers with different operation types", "stock"));
  }
  let qtyLines = [];
  for (const r of ordered) {
    if (r.state !== "done" && r.state !== "cancel" && (await uomCompare(env, r.quantity, 0)) > 0) qtyLines.push(r);
  }
  if (!forceMoveLines) {
    const picked = qtyLines.filter((r) => r.picked);
    if (picked.length) qtyLines = picked;
  }
  const linesToPack = qtyLines.filter((r) => !r.result_package_id);
  const packedLines = qtyLines.filter((r) => r.result_package_id);

  let donePack: number | null = null;
  if (linesToPack.length) {
    const checkLines = forceMoveLines ? ordered : linesToPack;
    const destLocs = [...new Set(checkLines.map((r) => r.location_dest_id))];
    if (destLocs.length > 1) {
      const viewId = await refId(env, "stock.stock_package_destination_form_view");
      const [wizId] = await create(env, "stock.package.destination", [{
        move_line_ids: [[6, 0, checkLines.map((r) => r.id)]],
        location_dest_id: checkLines[0]!.location_dest_id,
      }]);
      return {
        name: translate(env, "Choose destination location", "stock"),
        view_mode: "form",
        res_model: "stock.package.destination",
        view_id: viewId,
        views: [[viewId, "form"]],
        type: "ir.actions.act_window",
        res_id: wizId,
        target: "new",
      };
    }
    const linePtIds = [...new Set(linesToPack.map((r) => r.picking_type_id).filter((x): x is number => x !== null))];
    const shouldDisplayWizard = linePtIds.length === 1 && Boolean(linesToPack[0]?.set_package_type)
      && !env.context["from_package_wizard"] && !pkgId && !pkgTypeId && !pkgName;
    if (shouldDisplayWizard) {
      const action = await forXmlId(env, "stock.action_put_in_pack_wizard");
      const baseCtx = evalActionContext(action["context"]);
      const pickIds = [...new Set(ordered.map((r) => r.picking_id).filter((x): x is number => x !== null))];
      action["context"] = {
        ...baseCtx,
        all_move_line_ids: ordered.map((r) => r.id),
        default_move_line_ids: linesToPack.map((r) => r.id),
        default_location_dest_id: linesToPack[0]!.location_dest_id,
        picking_ids: pickIds,
      };
      return action;
    }
    // `_put_in_pack`
    let createdPkgId: number;
    if (pkgId) {
      createdPkgId = pkgId;
    } else if (pkgTypeId) {
      createdPkgId = (await create(env, "stock.package", [{ name: pkgName, package_type_id: pkgTypeId }]))[0]!;
    } else {
      const vals: Record<string, unknown> = { name: pkgName };
      const moveIds = [...new Set(linesToPack.map((r) => r.move_id).filter((x): x is number => x !== null))];
      if (moveIds.length) {
        const pkgTypes = [...new Set((await rows<{ pt: number | null }>(
          env,
          "SELECT u.package_type_id AS pt FROM stock_move m JOIN uom_uom u ON u.id = m.packaging_uom_id WHERE m.id = ANY($1::int[]) AND u.package_type_id IS NOT NULL",
          [moveIds],
        )).map((r) => r.pt).filter((x): x is number => x !== null))];
        if (pkgTypes.length === 1) vals["package_type_id"] = pkgTypes[0];
      }
      createdPkgId = (await create(env, "stock.package", [vals]))[0]!;
    }
    await write(env, "stock.move.line", linesToPack.map((r) => r.id), { result_package_id: createdPkgId });
    if (linesToPack.some((r) => r.auto_print_package_label)) {
      throw new NotPorted("stock.move.line._post_put_in_pack_hook auto_print_package_label");
    }
    donePack = createdPkgId;
  }
  if (donePack !== null && !forceMoveLines) return donePack;
  if (packedLines.length) {
    // Nested package packing
    const pkgIds = [...new Set(packedLines.map((r) => r.result_package_id!).filter((p) => p !== donePack))];
    if (pkgIds.length) {
      const targetPkg = donePack ?? pkgId ?? (await create(env, "stock.package", [{ name: pkgName, package_type_id: pkgTypeId ?? false }]))[0]!;
      await write(env, "stock.package", pkgIds, { package_dest_id: targetPkg });
      return targetPkg;
    }
  }
  return null;
}

registerMethod("stock.picking", "action_put_in_pack", async (env0, ids0, _args, kwargs0) => {
  const { env: env1, kwargs } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.picking");
  const env = env1.context["sml_specific_default"] ? env1.withContext(cleanContext(env1.context)) : env1;
  const [p] = await env.model("stock.picking").read([id], ["state", "move_line_ids"], "");
  if (p && !["done", "cancel"].includes(String(p["state"]))) {
    const mlIds = (Array.isArray(p["move_line_ids"]) ? (p["move_line_ids"] as number[]) : []);
    return moveLinesPutInPack(env, mlIds, {
      package_id: kwargs["package_id"] as number | false | undefined,
      package_type_id: kwargs["package_type_id"] as number | false | undefined,
      package_name: kwargs["package_name"] as string | false | undefined,
    });
  }
  return null;
}, { apiModel: false });

registerMethod("stock.move.line", "action_put_in_pack", async (env0, ids0, _args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  return moveLinesPutInPack(env, ids0 ?? [], {
    package_id: kwargs["package_id"] as number | false | undefined,
    package_type_id: kwargs["package_type_id"] as number | false | undefined,
    package_name: kwargs["package_name"] as string | false | undefined,
    package_capacity: kwargs["package_capacity"] as number | null | undefined,
  });
}, { apiModel: false });

registerMethod("stock.put.in.pack", "action_put_in_pack", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.put.in.pack");
  const [w] = await env.model("stock.put.in.pack").read(
    [id],
    ["move_line_ids", "package_ids", "result_package_id", "package_type_id", "package_capacity"],
    "",
  );
  const wEnv = env.withContext({ ...env.context, from_package_wizard: true });
  const pkgIds = (Array.isArray(w?.["package_ids"]) ? (w!["package_ids"] as number[]) : []);
  if (pkgIds.length) {
    const targetPkg = idOf(w?.["result_package_id"])
      ?? (await create(wEnv, "stock.package", [{ package_type_id: idOf(w?.["package_type_id"]) ?? false, name: false }]))[0]!;
    await write(wEnv, "stock.package", pkgIds, { package_dest_id: targetPkg });
    return targetPkg;
  }
  const mlIds = (Array.isArray(w?.["move_line_ids"]) ? (w!["move_line_ids"] as number[]) : []);
  return moveLinesPutInPack(wEnv, mlIds, {
    package_id: idOf(w?.["result_package_id"]) ?? false,
    package_type_id: idOf(w?.["package_type_id"]) ?? false,
    package_capacity: w?.["package_capacity"] ? numOf(w["package_capacity"]) : null,
  });
}, { apiModel: false });

/** stock_picking_type.py:581-637 `_get_action` + `get_action_picking_tree_*` + `get_stock_picking_action_picking_type`. */
async function pickingTypeGetAction(env: Environment, ids: readonly number[], actionXmlid: string): Promise<Record<string, unknown>> {
  const action = await forXmlId(env, actionXmlid);
  const context: Record<string, unknown> = {};
  let code: string | false = false;
  let ptId: number | false = false;
  if (ids.length) {
    const id = ids[0]!;
    ptId = id;
    const [pt] = await env.model("stock.picking.type").read([id], ["display_name", "company_id", "code"], "");
    action["display_name"] = pt?.["display_name"] ?? "";
    context["default_picking_type_id"] = id;
    context["default_company_id"] = idOf(pt?.["company_id"]) ?? false;
    code = (typeof pt?.["code"] === "string" ? pt["code"] : false);
  } else {
    const allowed = env.context["allowed_company_ids"];
    if (Array.isArray(allowed) && allowed.length) context["default_company_id"] = allowed[0];
  }
  const actionCtx = evalActionContext(action["context"]);
  const merged = { ...actionCtx, ...context };
  action["context"] = merged;
  action["domain"] = [["picking_type_id", "=", ptId]];
  action["help"] = await renderTemplate(
    env.cr,
    "stock.help_message_template",
    { picking_type_code: merged["restricted_picking_type_code"] || code },
    { lang: env.lang ?? "en_US" },
  );
  return action;
}

registerMethod("stock.picking.type", "get_action_picking_tree_ready", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  return pickingTypeGetAction(env, ids0 ?? [], "stock.action_picking_tree_ready");
}, { apiModel: false });

registerMethod("stock.picking.type", "get_action_picking_tree_late", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  return pickingTypeGetAction(env, ids0 ?? [], "stock.action_picking_tree_late");
}, { apiModel: false });

registerMethod("stock.picking.type", "get_action_picking_tree_backorder", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  return pickingTypeGetAction(env, ids0 ?? [], "stock.action_picking_tree_backorder");
}, { apiModel: false });

registerMethod("stock.picking.type", "get_action_picking_tree_waiting", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  return pickingTypeGetAction(env, ids0 ?? [], "stock.action_picking_tree_waiting");
}, { apiModel: false });

registerMethod("stock.picking.type", "get_stock_picking_action_picking_type", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const ids = ids0 ?? [];
  let code: string | null = null;
  if (ids.length === 1) {
    const [pt] = await env.model("stock.picking.type").read(ids, ["code"], "");
    code = typeof pt?.["code"] === "string" ? pt["code"] : null;
  }
  if (code === "incoming") return pickingTypeGetAction(env, ids, "stock.action_picking_tree_incoming");
  if (code === "outgoing") return pickingTypeGetAction(env, ids, "stock.action_picking_tree_outgoing");
  if (code === "internal") return pickingTypeGetAction(env, ids, "stock.action_picking_tree_internal");
  return pickingTypeGetAction(env, ids, "stock.stock_picking_action_picking_type");
}, { apiModel: false });

registerMethod("stock.picking.type", "action_detailed_moves", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.picking.type");
  const [pt] = await env.model("stock.picking.type").read([id], ["name"], "");
  const action = await forXmlId(env, "stock.action_picking_detailed_moves");
  action["display_name"] = translate(env, "%(picking_type)s : Detailed Moves", "stock").replace("%(picking_type)s", String(pt?.["name"] ?? ""));
  return action;
}, { apiModel: false });

registerMethod("stock.picking.type", "get_action_picking_type_moves_analysis", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.picking.type");
  const action = await forXmlId(env, "stock.stock_move_action");
  const existing = Array.isArray(action["domain"]) ? (action["domain"] as unknown[]) : [];
  action["domain"] = existing.length ? ["&", ...existing, ["picking_type_id", "=", id]] : [["picking_type_id", "=", id]];
  return action;
}, { apiModel: false });

// =================================================================================================================
// STOCK MOVE (`stock.move`, `stock.warn.insufficient.qty.scrap`)
// =================================================================================================================

/** stock_move.py:1038-1063 `action_show_details`. */
registerMethod("stock.move", "action_show_details", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.move");
  const [m] = await env.model("stock.move").read([id], ["picked", "picking_id"], "");
  const viewId = await refId(env, "stock.view_stock_move_operations");
  const ctx: Record<string, unknown> = {
    ...env.context,
    auto_pick_move_lines: Boolean(m?.["picked"]),
  };
  const action: Record<string, unknown> = {
    name: translate(env, "Detailed Operations", "stock"),
    type: "ir.actions.act_window",
    view_mode: "form",
    res_model: "stock.move",
    views: [[viewId, "form"]],
    view_id: viewId,
    target: "new",
    res_id: id,
    context: ctx,
  };
  const pickingId = idOf(m?.["picking_id"]);
  if (env.context["show_picking"] && pickingId) {
    const batch = (await rows<{ b: number | null }>(env, "SELECT batch_id AS b FROM stock_picking WHERE id = $1", [pickingId]))[0]?.b;
    if (batch) {
      action["name"] = translate(env, "Open: Stock Move", "stock");
      ctx["default_picking_id"] = pickingId;
      ctx["display_name_partner"] = true;
    }
  }
  return action;
}, { apiModel: false });

/** stock_move.py:2928-2973 `check_available_qty` + `_action_scrap` + :2975-3000 `action_scrap`. */
async function moveActionScrapInternal(env: Environment, id: number): Promise<number[]> {
  await checkCompany(env, env.reg.model("stock.move"), [id], null);
  const [m] = await env.model("stock.move").read([id], ["product_id", "should_replenish_scrapped"], "");
  const productId = idOf(m?.["product_id"]);
  const prodName = productId ? ((await env.model("product.product").displayName([productId])).get(productId) ?? "") : "";
  const ref = (await nextByCode(env, "stock.scrap"))
    || translate(env, "Scrap of %s", "stock").replace("%s", prodName);
  await write(env, "stock.move", [id], { picked: true, is_scrap: true, reference: ref });
  const done = await movesDone(env, [id], false);
  if (m?.["should_replenish_scrapped"]) {
    throw new NotPorted("stock.move._action_scrap with should_replenish_scrapped (_action_replenish)");
  }
  return done;
}

registerMethod("stock.move", "action_scrap", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.move");
  const [m] = await env.model("stock.move").read(
    [id],
    ["quantity", "uom_id", "product_id", "location_id", "lot_ids"],
    "",
  );
  const quantity = numOf(m?.["quantity"]);
  if ((await uomCompare(env, quantity, 0)) === 0) {
    throw new UserError(translate(env, "You can only enter positive quantities.", "stock"));
  }
  const productId = idOf(m?.["product_id"])!;
  const [prod] = await rows<{ is_storable: boolean | null; tracking: string | null; uom_id: number; uom_name: string | null }>(
    env,
    `SELECT t.is_storable, t.tracking, t.uom_id, COALESCE(u.name->>$2, u.name->>'en_US') AS uom_name
       FROM product_product p JOIN product_template t ON t.id = p.product_tmpl_id LEFT JOIN uom_uom u ON u.id = t.uom_id
      WHERE p.id = $1`,
    [productId, env.lang ?? "en_US"],
  );
  const lotIds = (Array.isArray(m?.["lot_ids"]) ? (m!["lot_ids"] as number[]) : []);
  if ((prod?.tracking === "lot" || prod?.tracking === "serial") && !lotIds.length) {
    throw new UserError(translate(env, "You must select a lot/serial number.", "stock"));
  }
  const locationId = idOf(m?.["location_id"])!;
  let hasEnough = true;
  if (prod?.is_storable) {
    const pkgIds = (await rows<{ p: number }>(
      env,
      "SELECT DISTINCT package_id AS p FROM stock_move_line WHERE move_id = $1 AND package_id IS NOT NULL",
      [id],
    )).map((r) => r.p);
    const baseCtx: Record<string, unknown> = {
      ...env.context,
      location: locationId,
      strict: true,
    };
    if (pkgIds.length === 1) baseCtx["package_id"] = pkgIds[0];
    let available = 0;
    if (!lotIds.length) {
      available = (await quantitiesDict(env.withContext(baseCtx), [productId])).get(productId)?.qty_available ?? 0;
    } else {
      for (const lid of lotIds) {
        available += (await quantitiesDict(env.withContext({ ...baseCtx, lot_id: lid }), [productId])).get(productId)?.qty_available ?? 0;
      }
    }
    const moveUom = idOf(m?.["uom_id"]) ?? prod.uom_id;
    const scrapQty = await uomQuantity(env, quantity, moveUom, prod.uom_id, "HALF-UP");
    hasEnough = (await uomCompare(env, available, scrapQty)) >= 0;
  }
  if (hasEnough) {
    return moveActionScrapInternal(env, id);
  }
  const prodName = (await env.model("product.product").displayName([productId])).get(productId) ?? "";
  const viewId = await refId(env, "stock.stock_warn_insufficient_qty_scrap_form_view");
  return {
    name: translate(env, "%(product)s: Insufficient Quantity To Scrap", "stock").replace("%(product)s", prodName),
    view_mode: "form",
    res_model: "stock.warn.insufficient.qty.scrap",
    view_id: viewId,
    type: "ir.actions.act_window",
    context: {
      ...env.context,
      default_product_id: productId,
      default_location_id: locationId,
      default_scrap_move_id: id,
      default_quantity: pyFloat(quantity),
      default_product_uom_name: prod?.uom_name ?? "",
    },
    target: "new",
  };
}, { apiModel: false });

/** stock_warn_insufficient_qty.py:45-51 `action_done` & `action_cancel`. */
registerMethod("stock.warn.insufficient.qty.scrap", "action_done", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.warn.insufficient.qty.scrap");
  const [w] = await env.model("stock.warn.insufficient.qty.scrap").read([id], ["scrap_move_id"], "");
  const moveId = idOf(w?.["scrap_move_id"]);
  if (moveId === null) return null;
  return moveActionScrapInternal(env.withContext(cleanContext(env.context)), moveId);
}, { apiModel: false });

registerMethod("stock.warn.insufficient.qty.scrap", "action_cancel", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  if (env.context["not_unlink_on_discard"]) return true;
  const ids = ids0 ?? [];
  const wRows = ids.length ? await env.model("stock.warn.insufficient.qty.scrap").read(ids, ["scrap_move_id"], "") : [];
  const moveIds = [...new Set(wRows.map((w) => idOf(w["scrap_move_id"])).filter((x): x is number => x !== null))];
  if (moveIds.length) await unlink(env.sudo(), "stock.move", moveIds);
  return true;
}, { apiModel: false });

// =================================================================================================================
// STOCK QUANT & INVENTORY WIZARDS
// (`stock.quant`, `stock.quant.relocate`, `stock.request.count`, `stock.inventory.conflict`, `stock.inventory.warning`,
//  `stock.inventory.adjustment.name`, `stock.zero.demand.confirmation`)
// =================================================================================================================

/** stock_quant.py:577-581 `action_clear_inventory_quantity`. */
async function clearQuantInventoryQty(env: Environment, ids: readonly number[]): Promise<void> {
  if (!ids.length) return;
  await write(env, "stock.quant", ids, {
    inventory_quantity: 0,
    inventory_diff_quantity: 0,
    inventory_quantity_set: false,
    user_id: false,
  });
}

registerMethod("stock.quant", "action_clear_inventory_quantity", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  await clearQuantInventoryQty(env, ids0 ?? []);
  return null;
}, { apiModel: false });

/** stock_quant.py:428-432 `action_view_quants`. */
registerMethod("stock.quant", "action_view_quants", async (env0, _ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  return quantsAction(env);
}, { apiModel: true });

/** stock_quant.py:529-548 `action_set_inventory_quantity`. */
async function setQuantInventoryQty(env: Environment, ids: readonly number[]): Promise<Record<string, unknown> | null> {
  if (!ids.length) return null;
  const qRows = await env.model("stock.quant").read([...ids], ["inventory_quantity_set", "quantity"], "");
  if (qRows.some((q) => Boolean(q["inventory_quantity_set"]))) {
    const viewId = await refIdOrFalse(env, "stock.inventory_warning_set_view");
    return {
      name: translate(env, "Quantities Already Set", "stock"),
      type: "ir.actions.act_window",
      view_mode: "form",
      views: [[viewId, "form"]],
      view_id: viewId,
      res_model: "stock.inventory.warning",
      target: "new",
      context: { ...env.context, default_quant_ids: [...ids] },
    };
  }
  if (!env.context["from_request_count"]) {
    for (const q of qRows) {
      await write(env, "stock.quant", [Number(q["id"])], { inventory_quantity: numOf(q["quantity"]) });
    }
  }
  await write(env, "stock.quant", ids, { user_id: env.uid, inventory_quantity_set: true });
  return null;
}

registerMethod("stock.quant", "action_set_inventory_quantity", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  return setQuantInventoryQty(env, ids0 ?? []);
}, { apiModel: false });

/** stock_quant.py:583-588 `action_set_inventory_quantity_zero`. */
registerMethod("stock.quant", "action_set_inventory_quantity_zero", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const ids = ids0 ?? [];
  await write(env, "stock.quant", ids, { inventory_quantity: 0 });
  if (env.context["inventory_report_mode"]) {
    await actionApplyInventory(env, ids, null);
  } else {
    await write(env, "stock.quant", ids, { user_id: env.uid });
  }
  return null;
}, { apiModel: false });

/** stock_quant.py:550-561 `action_apply_all`. */
registerMethod("stock.quant", "action_apply_all", async (env0, _ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const activeDomain = env.context["active_domain"];
  const quantIds = await env.model("stock.quant").search(parseDomain(Array.isArray(activeDomain) ? activeDomain : []));
  const viewId = await refIdOrFalse(env, "stock.stock_inventory_adjustment_name_form_view");
  return {
    name: translate(env, "Inventory Adjustment", "stock"),
    type: "ir.actions.act_window",
    views: [[viewId, "form"]],
    res_model: "stock.inventory.adjustment.name",
    target: "new",
    context: { ...env.context, default_quant_ids: quantIds },
  };
}, { apiModel: false });

/** stock_inventory_adjustment_name.py:21-23 `action_apply`. */
registerMethod("stock.inventory.adjustment.name", "action_apply", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.inventory.adjustment.name");
  const [w] = await env.model("stock.inventory.adjustment.name").read(
    [id],
    ["quant_ids", "inventory_adjustment_name", "counting_date"],
    "",
  );
  const qIds = (Array.isArray(w?.["quant_ids"]) ? (w!["quant_ids"] as number[]) : []);
  const setQuants = qIds.length
    ? (await env.model("stock.quant").read(qIds, ["inventory_quantity_set"], ""))
        .filter((q) => Boolean(q["inventory_quantity_set"]))
        .map((q) => Number(q["id"]))
    : [];
  const countingDate = typeof w?.["counting_date"] === "string" && w["counting_date"] ? w["counting_date"] : null;
  const ctxEnv = env.withContext({
    ...env.context,
    inventory_name: w?.["inventory_adjustment_name"] ?? false,
    counting_date: countingDate ?? false,
  });
  return actionApplyInventory(ctxEnv, setQuants, countingDate);
}, { apiModel: false });

/** stock_quant.py:563-575 `action_reset`. */
registerMethod("stock.quant", "action_reset", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const viewId = await refIdOrFalse(env, "stock.inventory_warning_reset_view");
  return {
    name: translate(env, "Quantities To Reset", "stock"),
    type: "ir.actions.act_window",
    view_mode: "form",
    views: [[viewId, "form"]],
    view_id: viewId,
    res_model: "stock.inventory.warning",
    target: "new",
    context: { ...env.context, default_quant_ids: [...(ids0 ?? [])] },
  };
}, { apiModel: false });

/** stock_quant.py:500-527 `action_inventory_history`. */
registerMethod("stock.quant", "action_inventory_history", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.quant");
  const [q] = await env.model("stock.quant").read(
    [id],
    ["product_id", "company_id", "location_id", "lot_id", "package_id", "owner_id"],
    "",
  );
  const viewId = await refId(env, "stock.view_move_line_tree");
  const ctx: Record<string, unknown> = {
    search_default_inventory: 1,
    search_default_done: 1,
    search_default_product_id: idOf(q?.["product_id"]) ?? false,
  };
  const lotId = idOf(q?.["lot_id"]);
  const pkgId = idOf(q?.["package_id"]);
  const ownerId = idOf(q?.["owner_id"]);
  if (lotId !== null) ctx["search_default_lot_id"] = lotId;
  if (pkgId !== null) {
    ctx["search_default_package_id"] = pkgId;
    ctx["search_default_result_package_id"] = pkgId;
  }
  if (ownerId !== null) ctx["search_default_owner_id"] = ownerId;
  const locId = idOf(q?.["location_id"]) ?? false;
  return {
    name: translate(env, "History", "stock"),
    view_mode: "list,form",
    res_model: "stock.move.line",
    views: [[viewId, "list"], [false, "form"]],
    type: "ir.actions.act_window",
    context: ctx,
    domain: [
      ["company_id", "=", idOf(q?.["company_id"]) ?? false],
      "|",
      ["location_id", "=", locId],
      ["location_dest_id", "=", locId],
    ],
  };
}, { apiModel: false });

/** stock_quant.py:404-421 `action_view_stock_moves`. */
registerMethod("stock.quant", "action_view_stock_moves", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.quant");
  const [q] = await env.model("stock.quant").read([id], ["location_id", "lot_id", "package_id", "product_id"], "");
  const action = await forXmlId(env, "stock.stock_move_line_action");
  const locId = idOf(q?.["location_id"]) ?? false;
  const domain: unknown[] = [
    "|",
    ["location_id", "=", locId],
    ["location_dest_id", "=", locId],
    ["lot_id", "=", idOf(q?.["lot_id"]) ?? false],
  ];
  const pkgId = idOf(q?.["package_id"]);
  if (pkgId !== null) {
    domain.push("|", ["package_id", "=", pkgId], ["result_package_id", "=", pkgId]);
  }
  action["domain"] = domain;
  const ctx = evalActionContext(action["context"]);
  ctx["search_default_product_id"] = idOf(q?.["product_id"]) ?? false;
  action["context"] = ctx;
  return action;
}, { apiModel: false });

/** stock_quant.py:484-498 `action_stock_quant_relocate`. */
registerMethod("stock.quant", "action_stock_quant_relocate", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const ids = ids0 ?? [];
  const qRows = ids.length ? await env.model("stock.quant").read(ids, ["company_id", "quantity"], "") : [];
  const companies = new Set(qRows.map((q) => idOf(q["company_id"])).filter((c): c is number => c !== null));
  if (companies.size > 1 || qRows.some((q) => idOf(q["company_id"]) === null) || qRows.some((q) => numOf(q["quantity"]) <= 0)) {
    throw new UserError(translate(env, "You can only move positive quantities stored in locations used by a single company per relocation.", "stock"));
  }
  return {
    res_model: "stock.quant.relocate",
    views: [[false, "form"]],
    target: "new",
    type: "ir.actions.act_window",
    context: {
      default_quant_ids: [...ids],
      default_lot_id: env.context["default_lot_id"] ?? false,
      single_product: env.context["single_product"] ?? false,
    },
  };
}, { apiModel: false });

/** stock_quant.py:1566-1600 `move_quants`. */
async function moveQuants(
  env: Environment,
  quantIds: readonly number[],
  opts: { locationDestId?: number | null; packageDestId?: number | null; message?: string | null; unpack?: boolean } = {},
): Promise<void> {
  if (!quantIds.length) return;
  const message = opts.message || translate(env, "Quantity Relocated", "stock");
  const qRows = await rows<{
    id: number; product_id: number; uom_id: number; quantity: number; company_id: number | null;
    location_id: number; lot_id: number | null; package_id: number | null; owner_id: number | null;
  }>(
    env,
    `SELECT q.id, q.product_id, t.uom_id, q.quantity::float8 AS quantity, q.company_id,
            q.location_id, q.lot_id, q.package_id, q.owner_id
       FROM stock_quant q JOIN product_product p ON p.id = q.product_id JOIN product_template t ON t.id = p.product_tmpl_id
      WHERE q.id = ANY($1::int[])`,
    [[...quantIds]],
  );
  const byId = new Map(qRows.map((r) => [r.id, r]));
  const ordered = quantIds.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => r !== undefined);
  const defaultCompany = await env.company();
  const moveVals: Record<string, unknown>[] = [];
  for (const q of ordered) {
    let resultPkgId: number | null = opts.packageDestId ?? null;
    if (!opts.unpack && !opts.packageDestId) {
      resultPkgId = q.package_id;
    }
    const company = q.company_id ?? defaultCompany;
    const destLoc = opts.locationDestId ?? q.location_id;
    moveVals.push({
      product_id: q.product_id,
      uom_id: q.uom_id,
      product_uom_qty: q.quantity,
      company_id: company,
      state: "confirmed",
      location_id: q.location_id,
      location_dest_id: destLoc,
      restrict_partner_id: q.owner_id ?? false,
      is_inventory: true,
      picked: true,
      inventory_name: message,
      move_line_ids: [[0, 0, {
        product_id: q.product_id,
        uom_id: q.uom_id,
        quantity: q.quantity,
        location_id: q.location_id,
        location_dest_id: destLoc,
        company_id: company,
        lot_id: q.lot_id ?? false,
        package_id: q.package_id ?? false,
        result_package_id: resultPkgId ?? false,
        owner_id: q.owner_id ?? false,
      }]],
    });
  }
  const moveIds = await create(env.withContext({ ...env.context, inventory_name: message }), "stock.move", moveVals);
  await movesDone(env, moveIds, false);
}

registerMethod("stock.quant", "move_quants", async (env0, ids0, _args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  await moveQuants(env, ids0 ?? [], {
    locationDestId: idOf(kwargs["location_dest_id"]),
    packageDestId: idOf(kwargs["package_dest_id"]),
    message: typeof kwargs["message"] === "string" ? kwargs["message"] : null,
    unpack: Boolean(kwargs["unpack"]),
  });
  return null;
}, { apiModel: false });

/** stock_quant_relocate.py:51-55 `_compute_dest_package_id`. */
registerRecordCompute("stock.quant.relocate", {
  dest_package_id: async (_env, rec) => idOf(await rec.prev("dest_package_id")) ?? null,
});

/** stock_quant_relocate.py:23-56 computes + :57-76 `action_relocate_quants`. */
defineComputes("stock.quant.relocate", {
  is_partial_package: async (env, rec) => {
    const qIds = (Array.isArray(await rec.get("quant_ids")) ? (await rec.get("quant_ids")) as number[] : []);
    if (!qIds.length) return false;
    const pkgIds = [...new Set((await rows<{ p: number }>(env, "SELECT package_id AS p FROM stock_quant WHERE id = ANY($1::int[]) AND package_id IS NOT NULL", [qIds])).map((r) => r.p))];
    if (!pkgIds.length) return false;
    const outside = await rows(env, "SELECT 1 FROM stock_quant WHERE package_id = ANY($1::int[]) AND NOT (id = ANY($2::int[])) LIMIT 1", [pkgIds, qIds]);
    return outside.length > 0;
  },
  partial_package_names: async (env, rec) => {
    const qIds = (Array.isArray(await rec.get("quant_ids")) ? (await rec.get("quant_ids")) as number[] : []);
    if (!qIds.length) return "";
    const pkgIds = [...new Set((await rows<{ p: number }>(env, "SELECT package_id AS p FROM stock_quant WHERE id = ANY($1::int[]) AND package_id IS NOT NULL", [qIds])).map((r) => r.p))];
    if (!pkgIds.length) return "";
    const inc = (await rows<{ p: number }>(env, "SELECT DISTINCT package_id AS p FROM stock_quant WHERE package_id = ANY($1::int[]) AND NOT (id = ANY($2::int[])) ORDER BY p", [pkgIds, qIds])).map((r) => r.p);
    if (!inc.length) return "";
    const dn = await env.model("stock.package").displayName(inc);
    return inc.map((p) => dn.get(p) ?? "").join(", ");
  },
  is_multi_location: async (env, rec) => {
    if (idOf(await rec.get("dest_location_id")) !== null) return false;
    const qIds = (Array.isArray(await rec.get("quant_ids")) ? (await rec.get("quant_ids")) as number[] : []);
    if (qIds.length < 2) return false;
    const locs = await rows<{ l: number }>(env, "SELECT DISTINCT location_id AS l FROM stock_quant WHERE id = ANY($1::int[])", [qIds]);
    return locs.length > 1;
  },
  dest_package_id_domain: async (env, rec) => {
    const comp = idOf(await rec.get("company_id")) ?? false;
    const domain: unknown[] = ["|", ["company_id", "=", comp], ["company_id", "=", false]];
    const dest = idOf(await rec.get("dest_location_id"));
    if (dest !== null) {
      domain.push("|", ["location_id", "=", false], ["location_id", "=", dest]);
    } else {
      const qIds = (Array.isArray(await rec.get("quant_ids")) ? (await rec.get("quant_ids")) as number[] : []);
      if (qIds.length) {
        const locs = (await rows<{ l: number }>(env, "SELECT DISTINCT location_id AS l FROM stock_quant WHERE id = ANY($1::int[])", [qIds])).map((r) => r.l);
        if (locs.length === 1) domain.push("|", ["location_id", "=", false], ["location_id", "=", locs[0]]);
      }
    }
    return JSON.stringify(domain);
  },
});

registerMethod("stock.quant.relocate", "action_relocate_quants", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.quant.relocate");
  const [w] = await env.model("stock.quant.relocate").read(
    [id],
    ["quant_ids", "dest_location_id", "dest_package_id", "message", "is_partial_package"],
    "",
  );
  const destLoc = idOf(w?.["dest_location_id"]);
  const destPkg = idOf(w?.["dest_package_id"]);
  if (destLoc === null && destPkg === null) return null;
  let quantIds = (Array.isArray(w?.["quant_ids"]) ? (w!["quant_ids"] as number[]) : []);
  const qMeta = quantIds.length
    ? await rows<{ id: number; lot_id: number | null; product_id: number; package_id: number | null }>(
        env,
        "SELECT id, lot_id, product_id, package_id FROM stock_quant WHERE id = ANY($1::int[])",
        [quantIds],
      )
    : [];
  const lotIds = [...new Set(qMeta.map((q) => q.lot_id).filter((x): x is number => x !== null))];
  const productIds = [...new Set(qMeta.map((q) => q.product_id))];
  const message = typeof w?.["message"] === "string" && w["message"] ? w["message"] : null;

  await clearQuantInventoryQty(env, quantIds);
  if (Boolean(w?.["is_partial_package"]) && destPkg === null) {
    const qSet = new Set(quantIds);
    const toUnpack: number[] = [];
    for (const q of qMeta) {
      if (!q.package_id) continue;
      const pkgQuants = (await rows<{ id: number }>(env, "SELECT id FROM stock_quant WHERE package_id = $1", [q.package_id])).map((r) => r.id);
      if (pkgQuants.some((pq) => !qSet.has(pq))) toUnpack.push(q.id);
    }
    if (toUnpack.length) {
      await moveQuants(env, toUnpack, { locationDestId: destLoc, message, unpack: true });
      const unpackSet = new Set(toUnpack);
      quantIds = quantIds.filter((qid) => !unpackSet.has(qid));
    }
  }
  await moveQuants(env, quantIds, { locationDestId: destLoc, packageDestId: destPkg, message });

  if (env.context["default_lot_id"] && lotIds.length === 1) {
    return lotOpenQuants(env, lotIds[0]!);
  }
  if (env.context["single_product"] && productIds.length === 1) {
    return openQuants(env, productIds);
  }
  return quantsAction(env.withContext({ ...env.context, always_show_loc: 1 }));
}, { apiModel: false });

/** stock_request_count.py:19-54 `show_expected_quantity` compute/inverse + `action_request_count`. */
defineComputes("stock.request.count", {
  show_expected_quantity: async (env) => {
    const v = (await rows<{ v: string }>(env, "SELECT value AS v FROM ir_config_parameter WHERE key = 'stock.show_expected_quantity_count'"))[0]?.v;
    const { str2bool } = await import("../session/user");
    return v !== undefined && str2bool(v);
  },
});

registerOverrides("stock.request.count", {
  inverse: {
    show_expected_quantity: async (env, _ids, vals) => {
      const flag = Boolean(vals["show_expected_quantity"]);
      const existing = await env.sudo().model("ir.config_parameter").search(cond("key", "=", "stock.show_expected_quantity_count"), { limit: 1 });
      if (existing.length) await write(env.sudo(), "ir.config_parameter", existing, { value: flag ? "True" : "False" });
      else await create(env.sudo(), "ir.config_parameter", [{ key: "stock.show_expected_quantity_count", value: flag ? "True" : "False" }]);
    },
  },
});

registerMethod("stock.request.count", "action_request_count", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const ids = ids0 ?? [];
  const hasLots = await hasGroup(env, "stock.group_production_lot");
  for (const id of ids) {
    const [w] = await env.model("stock.request.count").read([id], ["quant_ids", "inventory_date", "user_id"], "");
    const qIds = [...(Array.isArray(w?.["quant_ids"]) ? (w!["quant_ids"] as number[]) : [])];
    if (hasLots && qIds.length) {
      const tracked = await rows<{ product_id: number; location_id: number }>(
        env,
        `SELECT q.product_id, q.location_id FROM stock_quant q
           JOIN product_product p ON p.id = q.product_id JOIN product_template t ON t.id = p.product_tmpl_id
          WHERE q.id = ANY($1::int[]) AND t.tracking IN ('lot', 'serial')`,
        [qIds],
      );
      if (tracked.length) {
        const domain = or(tracked.map((t) => and([cond("product_id", "=", t.product_id), cond("location_id", "=", t.location_id)])));
        for (const sib of await env.model("stock.quant").search(domain)) {
          if (!qIds.includes(sib)) qIds.push(sib);
        }
      }
    }
    const vals: Record<string, unknown> = { inventory_date: w?.["inventory_date"] ?? false };
    const uid = idOf(w?.["user_id"]);
    if (uid !== null) vals["user_id"] = uid;
    if (qIds.length) {
      await write(env.withContext({ ...env.context, inventory_mode: true }), "stock.quant", qIds, vals);
    }
  }
  return null;
}, { apiModel: false });

/** stock_inventory_conflict.py:16-24 `action_keep_counted_quantity` & `action_keep_difference`. */
registerMethod("stock.inventory.conflict", "action_keep_counted_quantity", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const ids = ids0 ?? [];
  const wRows = ids.length ? await env.model("stock.inventory.conflict").read(ids, ["quant_ids"], "") : [];
  const qIds = [...new Set(wRows.flatMap((w) => (Array.isArray(w["quant_ids"]) ? (w["quant_ids"] as number[]) : [])))];
  if (qIds.length) {
    const quants = await env.model("stock.quant").read(qIds, ["inventory_quantity", "quantity"], "");
    for (const q of quants) {
      await write(env, "stock.quant", [Number(q["id"])], {
        inventory_diff_quantity: numOf(q["inventory_quantity"]) - numOf(q["quantity"]),
      });
    }
  }
  return actionApplyInventory(env, qIds, null);
}, { apiModel: false });

registerMethod("stock.inventory.conflict", "action_keep_difference", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const ids = ids0 ?? [];
  const wRows = ids.length ? await env.model("stock.inventory.conflict").read(ids, ["quant_ids"], "") : [];
  const qIds = [...new Set(wRows.flatMap((w) => (Array.isArray(w["quant_ids"]) ? (w["quant_ids"] as number[]) : [])))];
  if (qIds.length) {
    const quants = await env.model("stock.quant").read(qIds, ["inventory_diff_quantity", "quantity"], "");
    for (const q of quants) {
      await write(env, "stock.quant", [Number(q["id"])], {
        inventory_quantity: numOf(q["quantity"]) + numOf(q["inventory_diff_quantity"]),
      });
    }
  }
  return actionApplyInventory(env, qIds, null);
}, { apiModel: false });

/** stock_inventory_warning.py:13-18 `action_reset` & `action_set`. */
registerMethod("stock.inventory.warning", "action_reset", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const ids = ids0 ?? [];
  const wRows = ids.length ? await env.model("stock.inventory.warning").read(ids, ["quant_ids"], "") : [];
  const qIds = [...new Set(wRows.flatMap((w) => (Array.isArray(w["quant_ids"]) ? (w["quant_ids"] as number[]) : [])))];
  await clearQuantInventoryQty(env, qIds);
  return null;
}, { apiModel: false });

registerMethod("stock.inventory.warning", "action_set", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const ids = ids0 ?? [];
  const wRows = ids.length ? await env.model("stock.inventory.warning").read(ids, ["quant_ids"], "") : [];
  const qIds = [...new Set(wRows.flatMap((w) => (Array.isArray(w["quant_ids"]) ? (w["quant_ids"] as number[]) : [])))];
  const valid = qIds.length
    ? (await env.model("stock.quant").read(qIds, ["inventory_quantity_set"], ""))
        .filter((q) => !q["inventory_quantity_set"])
        .map((q) => Number(q["id"]))
    : [];
  return setQuantInventoryQty(env, valid);
}, { apiModel: false });

/** stock_zero_demand_confirmation.py:10-19 `process` & `process_without_zero_moves`. */
async function zeroDemandProcess(env: Environment, pickingIds: readonly number[]): Promise<unknown> {
  if (!pickingIds.length) return true;
  const skipEnv = env.withContext({ ...env.context, skip_zero_demand_check: true });
  if (env.context["to_validate"]) return buttonValidate(skipEnv, pickingIds);
  return pickingConfirm(skipEnv, pickingIds);
}

registerMethod("stock.zero.demand.confirmation", "process", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const ids = ids0 ?? [];
  const wRows = ids.length ? await env.model("stock.zero.demand.confirmation").read(ids, ["picking_ids"], "") : [];
  const pickingIds = [...new Set(wRows.flatMap((w) => (Array.isArray(w["picking_ids"]) ? (w["picking_ids"] as number[]) : [])))];
  return zeroDemandProcess(env, pickingIds);
}, { apiModel: false });

registerMethod("stock.zero.demand.confirmation", "process_without_zero_moves", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const ids = ids0 ?? [];
  const wRows = ids.length ? await env.model("stock.zero.demand.confirmation").read(ids, ["picking_ids"], "") : [];
  const pickingIds = [...new Set(wRows.flatMap((w) => (Array.isArray(w["picking_ids"]) ? (w["picking_ids"] as number[]) : [])))];
  if (pickingIds.length) {
    const zeroMoves = (await rows<{ id: number }>(
      env,
      "SELECT id FROM stock_move WHERE picking_id = ANY($1::int[]) AND product_uom_qty <= 0 ORDER BY id",
      [pickingIds],
    )).map((r) => r.id);
    if (zeroMoves.length) await unlink(env, "stock.move", zeroMoves);
  }
  await zeroDemandProcess(env, pickingIds);
  return null;
}, { apiModel: false });

// =================================================================================================================
// STOCK LOT & WAREHOUSE (`stock.lot`, `stock.warehouse`)
// =================================================================================================================

/** stock_lot.py:291-295 `action_lot_open_quants`. */
async function lotOpenQuants(env0: Environment, lotId: number | false): Promise<Record<string, unknown>> {
  const ctx: Record<string, unknown> = { ...env0.context, search_default_lot_id: lotId, create: false };
  if (await hasGroup(env0, "stock.group_stock_manager")) ctx["inventory_mode"] = true;
  return quantsAction(env0.withContext(ctx));
}

registerMethod("stock.lot", "action_lot_open_quants", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const lotId = ids0 && ids0.length === 1 ? ids0[0]! : false;
  return lotOpenQuants(env, lotId);
}, { apiModel: false });

/** stock_lot.py:297-385 `action_lot_open_transfers` + `_get_delivery_move_lines_by_lot`. */
registerMethod("stock.lot", "action_lot_open_transfers", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.lot");
  await env.model("stock.lot").read([id], ["id"], "");
  const allLots = new Set<number>([id]);
  const barrenLines = new Map<number, Set<number>>();
  const parentMap = new Map<number, Set<number>>();
  let queue: number[] = [id];
  const outgoingDomain = or([
    cond("picking_code", "=", "outgoing"),
    cond("move_id.picking_code", "=", "outgoing"),
    cond("produce_line_ids", "!=", false),
    cond("location_dest_usage", "in", ["customer", "transit"]),
  ]);
  while (queue.length) {
    const mlIds = await env.model("stock.move.line").search(and([cond("lot_id", "in", queue), cond("state", "=", "done"), outgoingDomain]));
    queue = [];
    if (!mlIds.length) break;
    const mlRows = await env.model("stock.move.line").read(mlIds, ["lot_id", "produce_line_ids"], "");
    for (const line of mlRows) {
      const lid = idOf(line["lot_id"]);
      if (lid === null) continue;
      const prodLineIds = (Array.isArray(line["produce_line_ids"]) ? (line["produce_line_ids"] as number[]) : []);
      let childLots: number[] = [];
      if (prodLineIds.length) {
        const plRows = await env.model("stock.move.line").read(prodLineIds, ["lot_id"], "");
        childLots = [...new Set(plRows.map((r) => idOf(r["lot_id"])).filter((x): x is number => x !== null))];
      }
      if (childLots.length) {
        for (const cl of childLots) {
          if (!parentMap.has(cl)) parentMap.set(cl, new Set());
          parentMap.get(cl)!.add(lid);
        }
      } else {
        if (!barrenLines.has(lid)) barrenLines.set(lid, new Set());
        barrenLines.get(lid)!.add(Number(line["id"]));
      }
      for (const cl of childLots) {
        if (!allLots.has(cl)) {
          allLots.add(cl);
          queue.push(cl);
        }
      }
    }
  }
  const byLot = new Map<number, Set<number>>([...allLots].map((l) => [l, new Set<number>()]));
  const toProp = new Set<number>();
  for (const [lid, s] of barrenLines) {
    if (s.size) {
      for (const ml of s) byLot.get(lid)!.add(ml);
      toProp.add(lid);
    }
  }
  while (toProp.size) {
    const lid = toProp.values().next().value!;
    toProp.delete(lid);
    for (const parent of parentMap.get(lid) ?? []) {
      const target = byLot.get(parent)!;
      let added = false;
      for (const ml of byLot.get(lid)!) {
        if (!target.has(ml)) { target.add(ml); added = true; }
      }
      if (added) toProp.add(parent);
    }
  }
  const delivered = [...(byLot.get(id) ?? [])];
  const listView = await refId(env, "stock.stock_move_line_view_list");
  const displayName = (await env.model("stock.lot").displayName([id])).get(id) ?? "";
  return {
    name: translate(env, "Delivery move lines of %s", "stock").replace("%s", displayName),
    res_model: "stock.move.line",
    type: "ir.actions.act_window",
    views: [[listView, "list"], [false, "form"]],
    view_mode: "list,form",
    domain: [
      ["id", "in", delivered],
      ["location_dest_usage", "in", ["customer", "transit"]],
    ],
  };
}, { apiModel: false });

/** stock_lot.py:399-407 `action_open_scrap_moves`. */
registerMethod("stock.lot", "action_open_scrap_moves", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.lot");
  const [lot] = await env.model("stock.lot").read([id], ["name"], "");
  const listView = await refId(env, "stock.view_scrap_move_list");
  const formView = await refId(env, "stock.view_scrap_move_form");
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Scraps of %s", "stock").replace("%s", String(lot?.["name"] ?? "")),
    res_model: "stock.move",
    views: [[listView, "list"], [formView, "form"]],
    domain: [["move_line_ids.lot_id", "=", id], ["is_scrap", "=", true]],
  };
}, { apiModel: false });

/** stock_lot.py:409-431 `action_scrap`. */
registerMethod("stock.lot", "action_scrap", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.lot");
  const [lot] = await env.model("stock.lot").read([id], ["name", "product_id", "product_qty", "company_id", "location_id"], "");
  const compId = await env.company();
  const scrapLoc = (await rows<{ s: number | null }>(env, "SELECT scrap_location_id AS s FROM res_company WHERE id = $1", [compId]))[0]?.s ?? false;
  const prodId = idOf(lot?.["product_id"]);
  const ctx: Record<string, unknown> = {
    default_is_scrap: true,
    default_product_id: prodId ?? false,
    default_quantity: numOf(lot?.["product_qty"]),
    default_lot_ids: [id],
    default_location_dest_id: scrapLoc,
    default_state: "draft",
    default_company_id: idOf(lot?.["company_id"]) ?? compId,
    product_ids: prodId !== null ? [prodId] : [],
    lot_ids: [id],
  };
  const locId = idOf(lot?.["location_id"]);
  if (locId !== null) ctx["default_location_id"] = locId;
  const formView = await refId(env, "stock.view_scrap_move_form");
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Scrap %(lot_name)s", "stock").replace("%(lot_name)s", String(lot?.["name"] ?? "")),
    res_model: "stock.move",
    views: [[formView, "form"]],
    context: ctx,
    target: "new",
  };
}, { apiModel: false });

/** stock_warehouse.py:1165-1169 `action_open_internal_locations`. */
registerMethod("stock.warehouse", "action_open_internal_locations", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.warehouse");
  const [wh] = await env.model("stock.warehouse").read([id], ["view_location_id"], "");
  const action = await forXmlId(env, "stock.action_location_form");
  action["domain"] = [["id", "child_of", idOf(wh?.["view_location_id"]) ?? false]];
  return action;
}, { apiModel: false });

// =================================================================================================================
// ORDERPOINTS & REPLENISHMENT
// (`stock.warehouse.orderpoint`, `stock.orderpoint.snooze`, `stock.replenishment.info`, `stock.replenishment.option`)
// =================================================================================================================

// orderpoint_forecast.ts natively supports route_id via rulesFromLocation(..., op.route).

/** stock_orderpoint.py:336-344 `write`, :435-442 `_inverse_qty_to_order` + purchase_stock/models/stock.py:172-176,214-217. */
registerOverrides("stock.warehouse.orderpoint", {
  write: async (env, ids, vals, next) => {
    if ("company_id" in vals && ids.length) {
      const targetCompany = idOf(vals["company_id"]);
      const ops = await rows<{ id: number; company_id: number }>(
        env,
        "SELECT id, company_id FROM stock_warehouse_orderpoint WHERE id = ANY($1::int[])",
        [[...ids]],
      );
      if (ops.some((o) => o.company_id !== targetCompany)) {
        throw new UserError(translate(env, "Changing the company of this record is forbidden at this point, you should rather archive it and create a new one.", "stock"));
      }
    }
    if ("snoozed_until" in vals && ids.length) {
      const auto = await rows(env, "SELECT 1 FROM stock_warehouse_orderpoint WHERE id = ANY($1::int[]) AND trigger = 'auto' LIMIT 1", [[...ids]]);
      if (auto.length) {
        throw new UserError(translate(env, "You can only snooze manual orderpoints. You should rather archive 'auto-trigger' orderpoints if you do not want them to be triggered.", "stock"));
      }
    }
    return next(env, ids, vals);
  },
  inverse: {
    qty_to_order: async (env, ids, vals) => {
      if (!ids.length) return;
      const given = "qty_to_order" in vals ? numOf(vals["qty_to_order"]) : null;
      const ops = await env.model("stock.warehouse.orderpoint").read(
        [...ids],
        ["trigger", "qty_to_order_manual", "qty_to_order_computed", "qty_to_order"],
        "",
      );
      for (const op of ops) {
        const oid = Number(op["id"]);
        const qty = given ?? numOf(op["qty_to_order"]);
        const manual = numOf(op["qty_to_order_manual"]);
        const computed = numOf(op["qty_to_order_computed"]);
        if (op["trigger"] === "auto") {
          await write(env, "stock.warehouse.orderpoint", [oid], { qty_to_order_manual: 0 });
        } else if (!manual && !qty) {
          // cache-only reset to computed
        } else if (qty !== computed) {
          await write(env, "stock.warehouse.orderpoint", [oid], { qty_to_order_manual: qty });
        }
      }
    },
    route_id: async (env, ids) => {
      if (!ids.length) return;
      const ops = await rows<{ id: number; route_id: number | null }>(
        env,
        "SELECT id, route_id FROM stock_warehouse_orderpoint WHERE id = ANY($1::int[])",
        [[...ids]],
      );
      const cleared = ops.filter((o) => !o.route_id).map((o) => o.id);
      if (cleared.length) await write(env, "stock.warehouse.orderpoint", cleared, { supplier_id: false });
    },
    supplier_id: async (env, ids) => {
      if (!ids.length) return;
      const ops = await rows<{ id: number; route_id: number | null; supplier_id: number | null; product_id: number | null; location_id: number | null; company_id: number }>(
        env,
        "SELECT id, route_id, supplier_id, product_id, location_id, company_id FROM stock_warehouse_orderpoint WHERE id = ANY($1::int[])",
        [[...ids]],
      );
      for (const o of ops) {
        if (!o.route_id && o.supplier_id) {
          const defRoute = await orderpointDefaultRoute(env, o.product_id, o.location_id, { company: o.company_id, route: null });
          if (defRoute) await write(env, "stock.warehouse.orderpoint", [o.id], { route_id: defRoute });
        }
      }
    },
  },
});

/** stock_orderpoint.py:336-344 RPC `write` (override_guard.ts:23-24: model-specific RPC method is its own port). */
registerMethod("stock.warehouse.orderpoint", "write", (env0, ids, args, kwargs0) => withDbErrors(env0, async () => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const recIds = recordIds(ids, [], "write");
  const raw = kwargs["vals"] ?? args[0];
  if (!isRecord(raw)) throw new NotPorted(`write: values of type ${typeof raw}`);
  await write(env, "stock.warehouse.orderpoint", recIds, raw);
  return true;
}), { apiModel: false });

/** stock_orderpoint.py:672-673 `action_remove_manual_qty_to_order`. */
registerMethod("stock.warehouse.orderpoint", "action_remove_manual_qty_to_order", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const ids = ids0 ?? [];
  if (ids.length) await write(env, "stock.warehouse.orderpoint", ids, { qty_to_order_manual: 0 });
  return null;
}, { apiModel: false });

/** stock_orderpoint.py:685-708 + purchase_stock/models/stock.py:308-329 `_get_replenishment_order_notification`. */
async function replenishmentOrderNotification(env: Environment, id: number, writtenAfter: string): Promise<Record<string, unknown> | false> {
  // purchase_stock override first: check purchase.order.line
  const poLines = await env.model("purchase.order.line").search(
    and([cond("orderpoint_id", "in", [id]), cond("write_date", ">=", writtenAfter)]),
    { limit: 1 },
  );
  if (poLines.length) {
    const [pol] = await env.model("purchase.order.line").read([poLines[0]!], ["order_id"], "");
    const orderId = idOf(pol?.["order_id"]);
    if (orderId !== null) {
      const label = (await env.model("purchase.order").displayName([orderId])).get(orderId) ?? "";
      return {
        type: "ir.actions.client",
        tag: "display_notification",
        params: {
          title: translate(env, "The following replenishment order has been generated", "purchase_stock"),
          message: "%s",
          links: [{
            label,
            url: `/odoo/action-purchase.action_rfq_form/${orderId}`,
          }],
          sticky: false,
          next: { type: "ir.actions.act_window_close" },
        },
      };
    }
  }
  // stock fallback: inter-warehouse transfer move
  const moves = await env.model("stock.move").search(
    and([cond("orderpoint_id", "in", [id]), cond("write_date", ">=", writtenAfter)]),
    { limit: 1 },
  );
  if (moves.length) {
    const [mv] = await rows<{ picking_id: number | null; picking_name: string | null; loc_wh: number | null; loc_usage: string | null; op_wh: number | null }>(
      env,
      `SELECT m.picking_id, p.name AS picking_name, l.warehouse_id AS loc_wh, l.usage AS loc_usage, op.warehouse_id AS op_wh
         FROM stock_move m
         LEFT JOIN stock_picking p ON p.id = m.picking_id
         LEFT JOIN stock_location l ON l.id = m.location_id
         LEFT JOIN stock_warehouse_orderpoint op ON op.id = m.orderpoint_id
        WHERE m.id = $1`,
      [moves[0]],
    );
    if (mv?.picking_id && ((mv.loc_wh && mv.loc_wh !== mv.op_wh) || mv.loc_usage === "transit")) {
      return {
        type: "ir.actions.client",
        tag: "display_notification",
        params: {
          title: translate(env, "The inter-warehouse transfers have been generated", "stock"),
          message: "%s",
          links: [{
            label: mv.picking_name ?? "",
            url: `/odoo/action-stock.stock_picking_action_picking_type/${mv.picking_id}`,
          }],
          sticky: false,
          next: { type: "ir.actions.act_window_close" },
        },
      };
    }
  }
  return false;
}

/** stock_orderpoint.py:380-403 `action_replenish`. */
async function orderpointReplenish(env: Environment, ids: readonly number[]): Promise<Record<string, unknown> | false> {
  if (!ids.length) return false;
  const nowStr = datetimeToString(await dbNow(env));
  const ops = await env.model("stock.warehouse.orderpoint").read(
    [...ids],
    ["qty_to_order_manual", "qty_to_order_to_max", "product_id", "create_uid", "trigger"],
    "",
  );
  const byId = new Map(ops.map((o) => [Number(o["id"]), o]));
  const qtyOverride = new Map<number, number>();
  for (const id of ids) {
    const op = byId.get(id);
    if (!op) continue;
    const targetQty = numOf(op["qty_to_order_manual"]) || numOf(op["qty_to_order_to_max"]);
    await write(env, "stock.warehouse.orderpoint", [id], { qty_to_order: targetQty });
    qtyOverride.set(id, targetQty);
  }
  const companyId = await env.company();
  try {
    await procureOrderpoints(
      env.withContext({ ...env.context, manual_replenishment: true }),
      ids,
      new Map(),
      companyId,
      qtyOverride,
    );
  } catch (e) {
    if (e instanceof UserError && ids.length === 1) {
      const prodId = idOf(byId.get(ids[0]!)?.["product_id"])!;
      const prodName = (await env.model("product.product").displayName([prodId])).get(prodId) ?? "";
      const formView = await refId(env, "product.product_normal_form_view");
      const action = {
        name: prodName,
        type: "ir.actions.act_window",
        res_model: "product.product",
        res_id: prodId,
        views: [[formView, "form"]],
      };
      const pyAction = `{'name': ${JSON.stringify(prodName).replace(/"/g, "'")}, 'type': 'ir.actions.act_window', 'res_model': 'product.product', 'res_id': ${prodId}, 'views': [(${formView}, 'form')]}`;
      throw new RedirectWarning(e.message, action, translate(env, "Edit Product", "stock"), pyAction);
    }
    throw e;
  }
  let notification: Record<string, unknown> | false = false;
  if (ids.length === 1) {
    notification = await replenishmentOrderNotification(env, ids[0]!, nowStr);
  }
  await write(env, "stock.warehouse.orderpoint", ids, { qty_to_order_manual: 0 });
  const after = await env.model("stock.warehouse.orderpoint").read([...ids], ["create_uid", "qty_to_order", "trigger"], "");
  const toUnlink = after
    .filter((o) => idOf(o["create_uid"]) === 1 && numOf(o["qty_to_order"]) <= 0 && o["trigger"] === "manual")
    .map((o) => Number(o["id"]));
  if (toUnlink.length) await unlink(env, "stock.warehouse.orderpoint", toUnlink);
  return notification;
}

registerMethod("stock.warehouse.orderpoint", "action_replenish", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  return orderpointReplenish(env, ids0 ?? []);
}, { apiModel: false });

/** stock_orderpoint.py:405-407 `action_replenish_auto`. */
registerMethod("stock.warehouse.orderpoint", "action_replenish_auto", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const ids = ids0 ?? [];
  if (ids.length) await write(env, "stock.warehouse.orderpoint", ids, { trigger: "auto" });
  return orderpointReplenish(env, ids);
}, { apiModel: false });

/** stock_replenishment_info.py:112-120 inverses + purchase_stock/wizard/stock_replenishment_info.py:15-19 compute. */
registerOverrides("stock.replenishment.info", {
  inverse: {
    based_on: async (env, ids) => {
      if (!ids.length) return;
      const infos = await rows<{ orderpoint_id: number | null; based_on: string | null }>(
        env,
        "SELECT orderpoint_id, based_on FROM stock_replenishment_info WHERE id = ANY($1::int[])",
        [[...ids]],
      );
      for (const info of infos) {
        if (!info.orderpoint_id) continue;
        const [op] = await rows<{ m: string | null }>(env, "SELECT min_max_based_on AS m FROM stock_warehouse_orderpoint WHERE id = $1", [info.orderpoint_id]);
        if (op && op.m !== info.based_on) {
          await write(env, "stock.warehouse.orderpoint", [info.orderpoint_id], { min_max_based_on: info.based_on });
        }
      }
    },
    percent_factor: async (env, ids) => {
      if (!ids.length) return;
      const infos = await rows<{ orderpoint_id: number | null; percent_factor: number | null }>(
        env,
        "SELECT orderpoint_id, percent_factor FROM stock_replenishment_info WHERE id = ANY($1::int[])",
        [[...ids]],
      );
      for (const info of infos) {
        if (!info.orderpoint_id) continue;
        const [op] = await rows<{ f: number | null }>(env, "SELECT min_max_based_on_factor AS f FROM stock_warehouse_orderpoint WHERE id = $1", [info.orderpoint_id]);
        if (op && op.f !== info.percent_factor) {
          await write(env, "stock.warehouse.orderpoint", [info.orderpoint_id], { min_max_based_on_factor: info.percent_factor });
        }
      }
    },
  },
});

defineComputes("stock.replenishment.info", {
  supplierinfo_ids: async (env, rec) => {
    const op = await rec.rel("orderpoint_id");
    const prodId = op ? idOf(await op.get("product_id")) : null;
    if (!prodId) return [];
    const tmpl = (await rows<{ t: number }>(env, "SELECT product_tmpl_id AS t FROM product_product WHERE id = $1", [prodId]))[0]?.t;
    if (!tmpl) return [];
    return (await rows<{ id: number }>(
      env,
      "SELECT id FROM product_supplierinfo WHERE product_tmpl_id = $1 AND (product_id IS NULL OR product_id = $2) ORDER BY sequence, min_qty DESC, price, id",
      [tmpl, prodId],
    )).map((r) => r.id);
  },
});

defineComputes("stock.replenishment.option", {
  free_qty: async (env, rec) => {
    const prodId = idOf(await rec.get("product_id"));
    const routeId = idOf(await rec.get("route_id"));
    if (!prodId) return 0;
    const locId = routeId
      ? ((await rows<{ l: number | null }>(
          env,
          "SELECT w.lot_stock_id AS l FROM stock_route r LEFT JOIN stock_warehouse w ON w.id = r.supplier_wh_id WHERE r.id = $1",
          [routeId],
        ))[0]?.l ?? null)
      : null;
    const qEnv = locId ? env.sudo().withContext({ ...env.context, location: locId }) : env.sudo();
    return (await quantitiesDict(qEnv, [prodId])).get(prodId)?.free_qty ?? 0;
  },
  warning_message: async (env, rec) => {
    const freeQty = numOf(await rec.get("free_qty"));
    const qtyToOrder = numOf(await rec.get("qty_to_order"));
    if (freeQty < qtyToOrder) {
      const routeId = idOf(await rec.get("route_id"));
      const whName = routeId
        ? ((await rows<{ n: string | null }>(env, "SELECT w.name AS n FROM stock_route r LEFT JOIN stock_warehouse w ON w.id = r.supplier_wh_id WHERE r.id = $1", [routeId]))[0]?.n ?? "")
        : "";
      const uom = String((await rec.get("uom")) ?? "");
      return translate(env, "%(warehouse)s can only provide %(free_qty)s %(uom)s, while the quantity to order is %(qty_to_order)s %(uom)s.", "stock")
        .replace("%(warehouse)s", whName)
        .replace("%(free_qty)s", String(freeQty))
        .replace(/%\(uom\)s/g, uom)
        .replace("%(qty_to_order)s", String(qtyToOrder));
    }
    return "";
  },
});

/** stock_orderpoint.py:364-378 `action_stock_replenishment_info`. */
registerMethod("stock.warehouse.orderpoint", "action_stock_replenishment_info", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.warehouse.orderpoint");
  const [op] = await env.model("stock.warehouse.orderpoint").read(
    [id],
    ["product_id", "warehouse_id", "min_max_based_on", "min_max_based_on_factor"],
    "",
  );
  const prodId = idOf(op?.["product_id"]);
  const whId = idOf(op?.["warehouse_id"]);
  const prodName = prodId ? ((await env.model("product.product").displayName([prodId])).get(prodId) ?? "") : "";
  const whName = whId ? ((await env.model("stock.warehouse").displayName([whId])).get(whId) ?? "") : "";
  const action = await forXmlId(env, "stock.action_stock_replenishment_info");
  action["name"] = translate(env, "Replenishment Information for %(product)s in %(warehouse)s", "stock")
    .replace("%(product)s", prodName)
    .replace("%(warehouse)s", whName);
  const [infoId] = await create(env, "stock.replenishment.info", [{
    orderpoint_id: id,
    based_on: op?.["min_max_based_on"] ?? "one_month",
    percent_factor: op?.["min_max_based_on_factor"] ?? 100,
  }]);
  action["res_id"] = infoId;
  return action;
}, { apiModel: false });

/** stock_orderpoint_snooze.py:31-34 `action_snooze`. */
registerMethod("stock.orderpoint.snooze", "action_snooze", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const ids = ids0 ?? [];
  const wRows = ids.length ? await env.model("stock.orderpoint.snooze").read(ids, ["orderpoint_ids", "snoozed_until"], "") : [];
  for (const w of wRows) {
    const opIds = (Array.isArray(w["orderpoint_ids"]) ? (w["orderpoint_ids"] as number[]) : []);
    if (opIds.length) {
      await write(env, "stock.warehouse.orderpoint", opIds, { snoozed_until: w["snoozed_until"] || false });
    }
  }
  return null;
}, { apiModel: false });

/** stock_replenishment_info.py:235-254 + purchase_stock/wizard/stock_replenishment_info.py:33-45. */
async function optionOrderAll(env: Environment, id: number): Promise<Record<string, unknown>> {
  const [opt] = await env.model("stock.replenishment.option").read([id], ["replenishment_info_id", "route_id"], "");
  const infoId = idOf(opt?.["replenishment_info_id"]);
  const opId = infoId
    ? ((await rows<{ o: number | null }>(env, "SELECT orderpoint_id AS o FROM stock_replenishment_info WHERE id = $1", [infoId]))[0]?.o ?? null)
    : null;
  if (opId !== null) {
    await write(env, "stock.warehouse.orderpoint", [opId], { route_id: idOf(opt?.["route_id"]) ?? false });
  }
  return { type: "ir.actions.act_window_close" };
}

registerMethod("stock.replenishment.option", "order_all", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.replenishment.option");
  return optionOrderAll(env, id);
}, { apiModel: false });

registerMethod("stock.replenishment.option", "order_avbl", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.replenishment.option");
  const [opt] = await env.model("stock.replenishment.option").read([id], ["replenishment_info_id", "route_id", "free_qty"], "");
  const infoId = idOf(opt?.["replenishment_info_id"]);
  const opId = infoId
    ? ((await rows<{ o: number | null }>(env, "SELECT orderpoint_id AS o FROM stock_replenishment_info WHERE id = $1", [infoId]))[0]?.o ?? null)
    : null;
  if (opId !== null) {
    await write(env, "stock.warehouse.orderpoint", [opId], { route_id: idOf(opt?.["route_id"]) ?? false });
    await write(env, "stock.warehouse.orderpoint", [opId], { qty_to_order: numOf(opt?.["free_qty"]) });
  }
  return { type: "ir.actions.act_window_close" };
}, { apiModel: false });

registerMethod("stock.replenishment.option", "select_route", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.replenishment.option");
  const [opt] = await env.model("stock.replenishment.option").read([id], ["route_id", "free_qty", "qty_to_order"], "");
  const replenishId = idOf(env.context["replenish_id"]);
  if (replenishId !== null) {
    await write(env, "product.replenish", [replenishId], { route_id: idOf(opt?.["route_id"]) ?? false });
    return {
      type: "ir.actions.act_window",
      name: "Replenish",
      res_model: "product.replenish",
      res_id: replenishId,
      target: "new",
      view_mode: "form",
    };
  }
  if (numOf(opt?.["free_qty"]) < numOf(opt?.["qty_to_order"])) {
    const viewId = await refId(env, "stock.replenishment_option_warning_view");
    return {
      type: "ir.actions.act_window",
      res_model: "stock.replenishment.option",
      res_id: id,
      views: [[viewId, "form"]],
      target: "new",
      name: translate(env, "Quantity available too low", "stock"),
    };
  }
  return optionOrderAll(env, id);
}, { apiModel: false });
