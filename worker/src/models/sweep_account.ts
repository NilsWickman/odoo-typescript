/**
 * Accounting (`account.*`) & Payments (`payment.*`) UI object-button methods & supporting computes,
 * matching Odoo 20 Community source in `odoo/addons/{account,account_payment,payment,sale,purchase,project,analytic,stock_account}`.
 */
import { NotPorted, OdooError, UserError, ValidationError } from "../errors";
import { cleanAction } from "../controllers/call_button";
import { registerMethod } from "../http/methods";
import { create } from "../orm/create";
import { and, cond } from "../orm/domain";
import { DbRec, registerRecordCompute } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { unlink } from "../orm/unlink";
import { registerOverrides, write } from "../orm/write";
import { dictEntries, isDict, literalEval } from "../pyexpr";
import { envFor } from "../web/common";
import { userHasGroup } from "../web/groups";
import { fetchRecords, forXmlId, postMoves, xmlidId } from "./account_buttons";
import { contextToday } from "./account_computes";
import { getChainInfo, hashMoves } from "./account_hash";
import { DATE_MIN, SOFT_LOCK_DATE_FIELDS } from "./account_locks";
import { refreshInvoiceCurrencyRate, updateFposValues } from "./account_move_create";
import { postProcessWithLock } from "./payment_flow";
import { defineComputes } from "./tail_util";
import { dbNow, translate } from "./util";
import { escapeText, messageLogBatch } from "../mail/message";
import { trackingBody } from "../mail/tracking";
import { formatTrackingDate, formatTrackingDatetime } from "../mail/tracking_format";

const PURCHASE_TYPES_WITH_RECEIPTS = ["in_invoice", "in_refund", "in_receipt"];
const PURCHASE_TYPES = ["in_invoice", "in_refund"];
const SALE_TYPES = ["out_invoice", "out_refund"];

type MethodFn = (env: Environment, ids: number[], args: unknown[], kwargs: Record<string, unknown>) => Promise<unknown>;

function btn(model: string, method: string, fn: MethodFn): void {
  registerMethod(model, method, async (env0, ids, args, kwargs0) => {
    const { env, kwargs } = envFor(env0, kwargs0);
    return fn(env, ids ?? [], args, kwargs);
  }, { apiModel: false });
}

function ensureOne(ids: readonly number[], model: string): number {
  if (ids.length !== 1) {
    throw new OdooError("builtins.ValueError", `Expected singleton: ${model}(${ids.join(", ")}${ids.length ? "," : ""})`);
  }
  return ids[0]!;
}

function m2oId(v: unknown): number | null {
  if (Array.isArray(v)) return typeof v[0] === "number" ? v[0] : null;
  return typeof v === "number" && v > 0 ? v : null;
}

/** base/models/ir_ui_view.py:3307-3328 `_get_records_action(**kwargs)`. */
function getRecordsAction(
  env: Environment,
  model: string,
  ids: readonly number[],
  kwargs: Record<string, unknown> = {},
): Record<string, unknown> {
  let lengthDependent: Record<string, unknown>;
  if (ids.length === 0) {
    lengthDependent = { views: [[false, "form"]] };
  } else if (ids.length === 1) {
    lengthDependent = { views: [[false, "form"]], res_id: ids[0]! };
  } else {
    lengthDependent = {
      views: [[false, "list"], [false, "form"]],
      domain: [["id", "in", [...ids]]],
    };
  }
  return {
    type: "ir.actions.act_window",
    res_model: model,
    target: "current",
    context: { ...env.context },
    ...lengthDependent,
    ...kwargs,
  };
}

/** Parse a Python dict/list literal string (as stored in `ir_act_window.context` / `domain`) into plain JS. */
export function pyLiteralToJs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = literalEval(trimmed);
  return toPlain(parsed);
}

function toPlain(v: unknown): unknown {
  if (v === null || v === undefined || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(toPlain);
  if (v instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of v) out[String(k)] = toPlain(val);
    return out;
  }
  if (isDict(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of dictEntries(v)) out[String(k)] = toPlain(val);
    return out;
  }
  // PyTuple or array-like iterable
  if (Symbol.iterator in (v as object)) return [...(v as Iterable<unknown>)].map(toPlain);
  return v;
}

/** Format JS Date (UTC) as Odoo datetime string 'YYYY-MM-DD HH:MM:SS'. */
function fmtUtcDatetime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** Add days to an ISO date string 'YYYY-MM-DD'. */
function addDays(isoDate: string, delta: number): string {
  const dt = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

// ============================================================================================================
// 1. account.move & account.move.line
// ============================================================================================================

/** sale/models/account_move.py:202-213 `action_view_source_sale_orders`. */
btn("account.move", "action_view_source_sale_orders", async (env, ids) => {
  const id = ensureOne(ids, "account.move");
  await fetchRecords(env, "account.move", [id], ["id"]);
  const rows = (await env.cr.query<{ order_id: number }>(
    `SELECT sol.order_id
       FROM account_move_line aml
       JOIN sale_order_line_invoice_rel rel ON rel.invoice_line_id = aml.id
       JOIN sale_order_line sol ON sol.id = rel.order_line_id
      WHERE aml.move_id = $1 AND sol.order_id IS NOT NULL
      ORDER BY aml.date DESC, aml.move_name DESC, aml.id, sol.order_id, sol.sequence, sol.id`,
    [id],
  )).rows;
  const orderIds: number[] = [];
  for (const r of rows) if (!orderIds.includes(r.order_id)) orderIds.push(r.order_id);
  if (orderIds.length === 0) return { type: "ir.actions.act_window_close" };
  const result = await forXmlId(env, "sale.action_orders");
  if (orderIds.length > 1) {
    result["domain"] = [["id", "in", orderIds]];
  } else {
    const viewId = await env.reg.xmlid(env.cr, "sale.view_order_form");
    result["views"] = [[viewId ?? false, "form"]];
    result["res_id"] = orderIds[0]!;
  }
  return result;
});

/** purchase/models/account_invoice.py:246-257 `action_view_source_purchase_orders`. */
btn("account.move", "action_view_source_purchase_orders", async (env, ids) => {
  const id = ensureOne(ids, "account.move");
  await fetchRecords(env, "account.move", [id], ["id"]);
  const rows = (await env.cr.query<{ order_id: number }>(
    `SELECT pol.order_id
       FROM account_move_line aml
       JOIN purchase_order_line pol ON pol.id = aml.purchase_line_id
      WHERE aml.move_id = $1 AND pol.order_id IS NOT NULL
      ORDER BY aml.date DESC, aml.move_name DESC, aml.id`,
    [id],
  )).rows;
  const orderIds: number[] = [];
  for (const r of rows) if (!orderIds.includes(r.order_id)) orderIds.push(r.order_id);
  if (orderIds.length === 0) return { type: "ir.actions.act_window_close" };
  const result = await forXmlId(env, "purchase.purchase_form_action");
  if (orderIds.length > 1) {
    result["domain"] = [["id", "in", orderIds]];
  } else {
    const viewId = await env.reg.xmlid(env.cr, "purchase.purchase_order_form");
    result["views"] = [[viewId ?? false, "form"]];
    result["res_id"] = orderIds[0]!;
  }
  return result;
});

/** account/models/account_move.py:6679-6682 `action_open_reversed_entry`. */
btn("account.move", "action_open_reversed_entry", async (env, ids) => {
  const moves = await fetchRecords(env, "account.move", ids, ["reversed_entry_id", "move_type"]);
  const reversedIds: number[] = [];
  for (const m of moves) {
    const rid = m2oId(m["reversed_entry_id"]);
    if (rid !== null && !reversedIds.includes(rid)) reversedIds.push(rid);
  }
  // `self.is_purchase_document(include_receipts=True)` accesses `self.move_type` (singleton on >1)
  if (moves.length > 1) ensureOne(ids, "account.move");
  const isPurchase = moves.length === 1 && PURCHASE_TYPES_WITH_RECEIPTS.includes(String(moves[0]!["move_type"]));
  const name = isPurchase ? translate(env, "Invoices") : translate(env, "Vendor Bills");
  return getRecordsAction(env, "account.move", reversedIds, { name });
});

/** account_payment/models/account_move.py:119-129 `action_view_payment_transactions`. */
btn("account.move", "action_view_payment_transactions", async (env, ids) => {
  const moves = await fetchRecords(env, "account.move", ids, ["transaction_ids"]);
  const txIds: number[] = [];
  for (const m of moves) {
    for (const tid of (m["transaction_ids"] as number[] | undefined) ?? []) {
      if (!txIds.includes(tid)) txIds.push(tid);
    }
  }
  const action = await forXmlId(env, "payment.action_payment_transaction");
  if (txIds.length === 1) {
    action["view_mode"] = "form";
    action["res_id"] = txIds[0]!;
    // In Python, `action['views'] = []` is falsy so `clean_action` regenerates `[[view_id or False, 'form']]`;
    // delete `views` so `call_button.ts`'s `cleanAction` (`!action['views']`) produces the exact same `views`.
    delete action["views"];
  } else {
    action["domain"] = [["id", "in", txIds]];
  }
  return action;
});

/** sale/models/account_move.py:215-219 `action_view_services_analytic_lines`. */
btn("account.move", "action_view_services_analytic_lines", async (env, ids) => {
  const id = ensureOne(ids, "account.move");
  await fetchRecords(env, "account.move", [id], ["id"]);
  const result = await forXmlId(env, "sale.action_service_material");
  result["domain"] = [["reinvoice_move_id", "in", [id]]];
  return result;
});

/** account/models/account_move_line.py:3737-3761 `_all_reconciled_lines` + :4055-4059 `open_reconcile_view`. */
async function openReconcileViewLines(env: Environment, lineIds: readonly number[]): Promise<Record<string, unknown>> {
  const action = await forXmlId(env, "account.action_account_moves_all_grouped_matching");
  if (!lineIds.length) {
    action["domain"] = [["id", "in", []]];
    return cleanAction(action, env);
  }
  const lines = await fetchRecords(env, "account.move.line", lineIds, ["matching_number"]);
  const matchNums = new Set<string>();
  for (const l of lines) {
    const mn = l["matching_number"];
    if (typeof mn === "string" && mn && !mn.startsWith("I")) matchNums.add(mn);
  }
  const allIds: number[] = [...lineIds];
  const seen = new Set<number>(lineIds);
  if (matchNums.size) {
    // `_reconciled_by_number` groups by matching_number (sorted by matching_number), then id:recordset
    const matched = (await env.cr.query<{ id: number }>(
      `SELECT id FROM account_move_line WHERE matching_number = ANY($1::varchar[]) ORDER BY matching_number, id`,
      [[...matchNums]],
    )).rows;
    for (const r of matched) {
      if (!seen.has(r.id)) { seen.add(r.id); allIds.push(r.id); }
    }
  }
  // `.filtered(lambda l: l.matched_debit_ids or l.matched_credit_ids)`
  const hasPartial = new Set<number>(
    (await env.cr.query<{ id: number }>(
      `SELECT DISTINCT id FROM (
         SELECT debit_move_id AS id FROM account_partial_reconcile WHERE debit_move_id = ANY($1::int[])
         UNION
         SELECT credit_move_id AS id FROM account_partial_reconcile WHERE credit_move_id = ANY($1::int[])
       ) t`,
      [allIds],
    )).rows.map((r) => r.id),
  );
  const filtered = allIds.filter((id) => hasPartial.has(id));
  action["domain"] = [["id", "in", filtered]];
  return cleanAction(action, env);
}

/** account/models/account_move.py:6580-6581 `open_reconcile_view`. */
btn("account.move", "open_reconcile_view", async (env, ids) => {
  const moves = await fetchRecords(env, "account.move", ids, ["line_ids"]);
  const lineIds: number[] = [];
  for (const m of moves) {
    for (const lid of (m["line_ids"] as number[] | undefined) ?? []) {
      if (!lineIds.includes(lid)) lineIds.push(lid);
    }
  }
  return openReconcileViewLines(env, lineIds);
});

/** account/models/account_move_line.py:4055-4059 `open_reconcile_view`. */
btn("account.move.line", "open_reconcile_view", async (env, ids) => openReconcileViewLines(env, ids));

/** account/models/account_move_line.py:1729-1748 `action_register_payment`. */
function moveLineRegisterPaymentAction(env: Environment, ids: readonly number[], extraCtx?: Record<string, unknown>): Record<string, unknown> {
  const context: Record<string, unknown> = {
    active_model: "account.move.line",
    active_ids: [...ids],
    ...(extraCtx ?? {}),
  };
  return {
    name: translate(env, "Pay"),
    res_model: "account.payment.register",
    view_mode: "form",
    views: [[false, "form"]],
    context,
    target: "new",
    type: "ir.actions.act_window",
  };
}

btn("account.move.line", "action_register_payment", async (env, ids, args, kwargs) => {
  const ctx = (args[0] ?? kwargs["ctx"]) as Record<string, unknown> | undefined;
  return moveLineRegisterPaymentAction(env, ids, ctx && typeof ctx === "object" ? ctx : undefined);
});

/** account/models/account_move_line.py:1726-1727 `action_payment_items_register_payment`. */
btn("account.move.line", "action_payment_items_register_payment", async (env, ids) =>
  moveLineRegisterPaymentAction(env, ids, { default_group_payment: true }));

/** account/models/account_move.py:6912-6914 `set_moves_checked(is_checked=True)`. */
btn("account.move", "set_moves_checked", async (env, ids, args, kwargs) => {
  const isChecked = args.length ? Boolean(args[0]) : "is_checked" in kwargs ? Boolean(kwargs["is_checked"]) : true;
  const moves = await fetchRecords(env, "account.move", ids, ["state"]);
  const reviewState = isChecked ? "reviewed" : "todo";
  for (const m of moves) {
    if (m["state"] === "posted") {
      await write(env, "account.move", [Number(m["id"])], { review_state: reviewState });
    }
  }
  return null;
});

/** account/models/account_move.py:7094-7099 `action_activate_currency`. */
btn("account.move", "action_activate_currency", async (env, ids) => {
  await fetchRecords(env, "account.move", ids, ["id"]);
  const curRows = ids.length ? (await env.cr.query<{ cid: number }>(
    `SELECT DISTINCT m.currency_id AS cid
       FROM account_move m JOIN res_currency c ON c.id = m.currency_id
      WHERE m.id = ANY($1::int[]) AND NOT COALESCE(c.active, false)
      ORDER BY m.currency_id`,
    [ids],
  )).rows : [];
  if (curRows.length) {
    await write(
      env.withContext({ ...env.context, active_test: false }),
      "res.currency",
      curRows.map((r) => r.cid),
      { active: true },
    );
  }
  return { type: "ir.actions.client", tag: "reload" };
});

/**
 * product/models/product_catalog_mixin.py:17-57, account/models/product_catalog_mixin.py:18-24,
 * account/models/account_move.py:3039-3069, purchase/models/account_invoice.py:649-654.
 */
async function moveAddFromCatalog(env: Environment, ids: readonly number[]): Promise<Record<string, unknown>> {
  const id = ensureOne(ids, "account.move");
  const childField = env.context["child_field"];
  if (!childField) throw new ValidationError(translate(env, "Catalog missing the child field to update."));
  if (!env.reg.model("account.move").fields.has(String(childField))) {
    throw new ValidationError(translate(env, "Wrong catalog child field!"));
  }
  const [move] = await fetchRecords(env, "account.move", [id], ["move_type", "currency_id", "company_id", "partner_id"]);
  const kanbanViewId = await xmlidId(env, "product.product_view_kanban_catalog");
  const searchViewId = await xmlidId(env, "product.product_view_search_catalog");
  const companyId = m2oId(move!["company_id"]) ?? await env.company();
  let currencyId = m2oId(move!["currency_id"]);
  if (currencyId === null) {
    currencyId = (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [companyId])).rows[0]!.c;
  }
  const priceUnitDigits = env.reg.model("account.move.line").fields.get("price_unit")?.digits ?? false;
  const moveType = String(move!["move_type"]);
  const isPurchase = PURCHASE_TYPES.includes(moveType);
  const isSale = SALE_TYPES.includes(moveType);

  const additionalContext: Record<string, unknown> = {
    product_catalog_order_id: id,
    product_catalog_order_model: "account.move",
    product_catalog_currency_id: currencyId,
    show_prices: true,
    show_sections: true,
  };
  if (isPurchase) {
    additionalContext["is_purchase_document"] = true;
    const partnerId = m2oId(move!["partner_id"]);
    if (partnerId !== null) {
      if (env.reg.model("account.move").modules?.includes("purchase")) {
        additionalContext["search_default_sold_by_vendor_id"] = partnerId;
      } else {
        const pname = (await env.cr.query<{ name: string }>("SELECT name FROM res_partner WHERE id = $1", [partnerId])).rows[0]?.name;
        if (pname) additionalContext["search_default_seller_ids"] = pname;
      }
    }
  }
  additionalContext["product_catalog_digits"] = priceUnitDigits;
  const context: Record<string, unknown> = { ...env.context, ...additionalContext };
  delete context["form_view_ref"];

  // Domain simplification matching Odoo 20's Domain `&` / `|` (`list(domain)`):
  // ((company_id = False | company_id parent_of companyId) & type != 'combo') [& sale_ok/purchase_ok = True]
  const domain: unknown[] = isSale
    ? ["&", "&", "|", ["company_id", "=", false], ["company_id", "parent_of", companyId], ["type", "!=", "combo"], ["sale_ok", "=", true]]
    : isPurchase
      ? ["&", "&", "|", ["company_id", "=", false], ["company_id", "parent_of", companyId], ["type", "!=", "combo"], ["purchase_ok", "=", true]]
      : ["&", "|", ["company_id", "=", false], ["company_id", "parent_of", companyId], ["type", "!=", "combo"]];

  return {
    type: "ir.actions.act_window",
    name: translate(env, "Products"),
    res_model: "product.product",
    views: [[kanbanViewId, "kanban"], [false, "form"]],
    search_view_id: [searchViewId, "search"],
    domain,
    context,
  };
}

btn("account.move", "action_add_from_catalog", async (env, ids) => moveAddFromCatalog(env, ids));

/** account/models/account_move_line.py:4077-4080 `action_add_from_catalog`. */
btn("account.move.line", "action_add_from_catalog", async (env) => {
  const orderId = env.context["order_id"];
  const moveIds = typeof orderId === "number" && orderId > 0 ? [orderId] : [];
  return moveAddFromCatalog(env.withContext({ ...env.context, child_field: "line_ids" }), moveIds);
});

/** account/models/account_move.py:6614-6642 `action_update_fpos_values`. */
btn("account.move", "action_update_fpos_values", async (env, ids) => {
  await updateFposValues(env, ids);
  return null;
});

/** account/models/account_move.py:6724-6726 `refresh_invoice_currency_rate`. */
btn("account.move", "refresh_invoice_currency_rate", async (env, ids) => {
  await refreshInvoiceCurrencyRate(env, ids);
  return null;
});

/** account/models/account_move.py:7101-7103 `action_delete_duplicates`. */
btn("account.move", "action_delete_duplicates", async (env, ids) => {
  const moves = await fetchRecords(env, "account.move", ids, ["duplicated_ref_ids"]);
  for (const m of moves) {
    const dups = (m["duplicated_ref_ids"] as number[] | undefined) ?? [];
    if (dups.length) await unlink(env, "account.move", dups);
  }
  return null;
});

/** stock_account/models/account_move.py:90-98 `action_show_product_value`. */
btn("account.move", "action_show_product_value", async (env, ids) => {
  const id = ensureOne(ids, "account.move");
  await fetchRecords(env, "account.move", [id], ["id"]);
  const rows = (await env.cr.query<{ id: number }>("SELECT id FROM product_value WHERE account_move_id = $1 ORDER BY id", [id])).rows;
  if (rows.length > 1) ensureOne(rows.map((r) => r.id), "product.value");
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Product Value"),
    res_model: "product.value",
    res_id: rows[0]?.id ?? false,
    view_mode: "form",
  };
});

/** account/models/account_move.py:7061-7062 `button_hash`. */
btn("account.move", "button_hash", async (env, ids) => {
  await fetchRecords(env, "account.move", ids, ["id"]);
  await hashMoves(env, ids, { forceHash: true, raiseIfGap: true, raiseIfNoDocument: true });
  return null;
});

/** account/models/account_move.py:6654-6656 `open_adjusting_entries`. */
btn("account.move", "open_adjusting_entries", async (env, ids) => {
  const id = ensureOne(ids, "account.move");
  const [move] = await fetchRecords(env, "account.move", [id], ["adjusting_entries_move_ids"]);
  const adjIds = (move!["adjusting_entries_move_ids"] as number[] | undefined) ?? [];
  return getRecordsAction(env, "account.move", adjIds, { name: "Adjusting Entries" });
});

/** account/models/account_move.py:6658-6661 `open_adjusting_entry_origin_moves`. */
btn("account.move", "open_adjusting_entry_origin_moves", async (env, ids) => {
  const id = ensureOne(ids, "account.move");
  const [move] = await fetchRecords(env, "account.move", [id], [
    "adjusting_entries_move_ids", "adjusting_entry_origin_move_ids", "adjusting_entry_origin_label",
  ]);
  const adjIds = (move!["adjusting_entries_move_ids"] as number[] | undefined) ?? [];
  const originIds = (move!["adjusting_entry_origin_move_ids"] as number[] | undefined) ?? [];
  const label = adjIds.length === 1 ? move!["adjusting_entry_origin_label"] : "Invoices";
  return getRecordsAction(env, "account.move", originIds, { name: label });
});

/** account/models/account_move.py:6643-6652 `open_created_caba_entries`. */
btn("account.move", "open_created_caba_entries", async (env, ids) => {
  const id = ensureOne(ids, "account.move");
  const [move] = await fetchRecords(env, "account.move", [id], ["tax_cash_basis_created_move_ids"]);
  const cabaIds = (move!["tax_cash_basis_created_move_ids"] as number[] | undefined) ?? [];
  const listViewId = await xmlidId(env, "account.view_move_tree");
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Cash Basis Entries"),
    res_model: "account.move",
    view_mode: "form",
    domain: [["id", "in", cabaIds]],
    views: [[listViewId, "list"], [false, "form"]],
  };
});

// ============================================================================================================
// 2. account.payment & account.payment.register
// ============================================================================================================

/** account/models/account_payment.py:1249-1258 `button_open_invoices`. */
btn("account.payment", "button_open_invoices", async (env, ids) => {
  const id = ensureOne(ids, "account.payment");
  const [pay] = await fetchRecords(env, "account.payment", [id], ["reconciled_invoice_ids"]);
  const invIds = (pay!["reconciled_invoice_ids"] as number[] | undefined) ?? [];
  return getRecordsAction(
    env.withContext({ ...env.context, create: false }),
    "account.move",
    invIds,
    { name: translate(env, "Paid Invoices") },
  );
});

/** account/models/account_payment.py:1260-1282 `button_open_bills`. */
btn("account.payment", "button_open_bills", async (env, ids) => {
  const id = ensureOne(ids, "account.payment");
  const [pay] = await fetchRecords(env, "account.payment", [id], ["reconciled_bill_ids"]);
  const billIds = (pay!["reconciled_bill_ids"] as number[] | undefined) ?? [];
  const action: Record<string, unknown> = {
    name: translate(env, "Paid Bills"),
    type: "ir.actions.act_window",
    res_model: "account.move",
    context: { create: false },
  };
  if (billIds.length === 1) {
    action["view_mode"] = "form";
    action["res_id"] = billIds[0]!;
  } else {
    action["view_mode"] = "list,form";
    action["domain"] = [["id", "in", billIds]];
  }
  return action;
});

/** account/models/account_payment.py:1308-1320 `button_open_journal_entry`. */
btn("account.payment", "button_open_journal_entry", async (env, ids) => {
  const id = ensureOne(ids, "account.payment");
  const [pay] = await fetchRecords(env, "account.payment", [id], ["move_id"]);
  return {
    name: translate(env, "Journal Entry"),
    type: "ir.actions.act_window",
    res_model: "account.move",
    context: { create: false },
    view_mode: "form",
    res_id: m2oId(pay!["move_id"]) ?? false,
  };
});

/** account/models/account_payment.py:1284-1306 `button_open_statement_lines`. */
btn("account.payment", "button_open_statement_lines", async (env, ids) => {
  const id = ensureOne(ids, "account.payment");
  const [pay] = await fetchRecords(env, "account.payment", [id], ["reconciled_statement_line_ids"]);
  const stIds = (pay!["reconciled_statement_line_ids"] as number[] | undefined) ?? [];
  const action: Record<string, unknown> = {
    name: translate(env, "Matched Transactions"),
    type: "ir.actions.act_window",
    res_model: "account.bank.statement.line",
    context: { create: false },
  };
  if (stIds.length === 1) {
    action["view_mode"] = "form";
    action["res_id"] = stIds[0]!;
  } else {
    action["view_mode"] = "list,form";
    action["domain"] = [["id", "in", stIds]];
  }
  return action;
});

/** account_payment/models/account_payment.py:158-174 `action_view_refunds`. */
btn("account.payment", "action_view_refunds", async (env, ids) => {
  const id = ensureOne(ids, "account.payment");
  const [pay] = await fetchRecords(env, "account.payment", [id], ["refunds_count"]);
  const action: Record<string, unknown> = {
    name: translate(env, "Refund"),
    res_model: "account.payment",
    type: "ir.actions.act_window",
  };
  if (Number(pay!["refunds_count"] ?? 0) === 1) {
    const found = await env.model("account.payment").search(cond("source_payment_id", "=", id), { limit: 1 });
    action["res_id"] = found[0] ?? false;
    action["view_mode"] = "form";
  } else {
    action["view_mode"] = "list,form";
    action["domain"] = [["source_payment_id", "=", id]];
  }
  return action;
});

/** account/wizard/account_payment_register.py:1441-1447 `action_open_missing_account_partners`. */
btn("account.payment.register", "action_open_missing_account_partners", async (env, ids) => {
  const id = ensureOne(ids, "account.payment.register");
  const [wiz] = await fetchRecords(env, "account.payment.register", [id], ["missing_account_partners"]);
  const partnerIds = (wiz!["missing_account_partners"] as number[] | undefined) ?? [];
  const vals: Record<string, unknown> = {};
  if (partnerIds.length > 1) {
    const listViewId = await xmlidId(env, "account.partner_missing_account_list_view");
    vals["views"] = [[listViewId, "list"], [false, "form"]];
  }
  return getRecordsAction(env, "res.partner", partnerIds, vals);
});

/** account/wizard/account_payment_register.py:1421-1439 `action_open_untrusted_bank_accounts`. */
btn("account.payment.register", "action_open_untrusted_bank_accounts", async (env, ids) => {
  const id = ensureOne(ids, "account.payment.register");
  const [wiz] = await fetchRecords(env, "account.payment.register", [id], ["untrusted_bank_ids"]);
  const bankIds = (wiz!["untrusted_bank_ids"] as number[] | undefined) ?? [];
  const formViewId = await xmlidId(env, "account.view_partner_bank_form_inherit_account");
  if (bankIds.length === 1) {
    return {
      view_mode: "form",
      res_model: "res.partner.bank",
      type: "ir.actions.act_window",
      res_id: bankIds[0]!,
      views: [[formViewId, "form"]],
    };
  }
  return {
    type: "ir.actions.act_window",
    res_model: "res.partner.bank",
    views: [[false, "list"], [formViewId, "form"]],
    domain: [["id", "in", bankIds]],
  };
});

// ============================================================================================================
// 3. account.journal, account.payment.method.line & res.company bank setup
// ============================================================================================================

/** account/models/account_journal_dashboard.py:1222-1272 `open_action`. */
btn("account.journal", "open_action", async (env, ids) => {
  const id = ensureOne(ids, "account.journal");
  const [journal] = await fetchRecords(env, "account.journal", [id], ["type"]);
  const jtype = String(journal!["type"]);
  const ctxAction = env.context["action_name"];
  let actionName: string;
  if (typeof ctxAction === "string" && ctxAction) {
    actionName = ctxAction;
  } else if (jtype === "bank") {
    actionName = "action_bank_statement_tree";
  } else if (jtype === "credit") {
    actionName = "action_credit_statement_tree";
  } else if (jtype === "cash") {
    actionName = "action_view_bank_statement_tree";
  } else if (jtype === "sale") {
    actionName = "action_move_out_invoice_type";
  } else if (jtype === "purchase") {
    actionName = "action_move_in_invoice_type";
  } else {
    actionName = "action_move_journal_line";
  }
  if (!actionName.startsWith("account.")) actionName = `account.${actionName}`;
  const action = await forXmlId(env, actionName);
  const rawCtx = action["context"];
  const actionContext = (typeof rawCtx === "string" ? pyLiteralToJs(rawCtx) : rawCtx ?? {}) as Record<string, unknown>;
  action["context"] = {
    ...actionContext,
    ...env.context,
    default_journal_id: id,
  };
  const domainTypeField = action["res_model"] === "account.move.line" ? "move_id.move_type" : "move_type";
  if (typeof action["domain"] === "string" && action["domain"]) {
    action["domain"] = pyLiteralToJs(action["domain"] || "[]");
  }
  if (!ctxAction) {
    if (jtype === "sale") {
      action["domain"] = [[domainTypeField, "in", ["out_invoice", "out_refund", "out_receipt", "entry"]]];
    } else if (jtype === "purchase") {
      action["domain"] = [[domainTypeField, "in", ["in_invoice", "in_refund", "in_receipt", "entry"]]];
    }
  }
  const existingDomain = Array.isArray(action["domain"]) ? action["domain"] : [];
  action["domain"] = [...existingDomain, ["journal_id", "=", id]];
  return action;
});

/** account/models/account_journal_dashboard.py:1101-1125 `action_create_new`. */
btn("account.journal", "action_create_new", async (env, ids) => {
  const ctx: Record<string, unknown> = { ...env.context };
  let journalId: number | false = ids.length === 1 ? ids[0]! : ids.length === 0 ? false : ensureOne(ids, "account.journal");
  if (!ctx["default_journal_id"]) {
    ctx["default_journal_id"] = journalId;
  } else if (!journalId && typeof ctx["default_journal_id"] === "number") {
    journalId = ctx["default_journal_id"];
  }
  let jtype: string | null = null;
  if (typeof journalId === "number") {
    const [j] = await fetchRecords(env, "account.journal", [journalId], ["type"]);
    jtype = String(j!["type"]);
  }
  if (jtype === "sale") {
    ctx["default_move_type"] = ctx["refund"] ? "out_refund" : "out_invoice";
  } else if (jtype === "purchase") {
    ctx["default_move_type"] = ctx["refund"] ? "in_refund" : "in_invoice";
  } else {
    ctx["default_move_type"] = "entry";
    ctx["view_no_maturity"] = true;
  }
  return {
    name: translate(env, "Create invoice/bill"),
    type: "ir.actions.act_window",
    view_mode: "form",
    res_model: "account.move",
    view_id: await xmlidId(env, "account.view_move_form"),
    context: ctx,
  };
});

/** account/models/company.py:919-931 `setting_init_bank_account_action`. */
async function settingInitBankAccountAction(env: Environment): Promise<Record<string, unknown>> {
  const viewId = await xmlidId(env, "account.setup_bank_account_wizard");
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Setup Bank Account"),
    res_model: "account.setup.bank.manual.config",
    target: "new",
    view_mode: "form",
    views: [[viewId, "form"]],
    context: { dialog_size: "medium", ...env.context },
  };
}

registerMethod("res.company", "setting_init_bank_account_action", async (env0, _ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  return settingInitBankAccountAction(env);
}, { apiModel: false });

/** account/models/account_journal.py:1131-1136 `action_configure_bank_journal`. */
btn("account.journal", "action_configure_bank_journal", async (env, ids) => {
  const journalId: number | false = ids.length === 1 ? ids[0]! : ids.length === 0 ? false : ensureOne(ids, "account.journal");
  return settingInitBankAccountAction(env.withContext({ ...env.context, default_linked_journal_id: journalId }));
});

/** account_payment/models/account_payment_method_line.py:75-84 `action_open_provider_form`. */
btn("account.payment.method.line", "action_open_provider_form", async (env, ids) => {
  const id = ensureOne(ids, "account.payment.method.line");
  const [line] = await fetchRecords(env, "account.payment.method.line", [id], ["payment_provider_id"]);
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Provider"),
    view_mode: "form",
    res_model: "payment.provider",
    target: "current",
    res_id: m2oId(line!["payment_provider_id"]) ?? false,
  };
});

// ============================================================================================================
// 4. account.analytic.account & account.analytic.plan
// ============================================================================================================

/** project/models/account_analytic_account.py:31-44 `action_view_projects`. */
btn("account.analytic.account", "action_view_projects", async (env, ids) => {
  const id = ensureOne(ids, "account.analytic.account");
  const [acc] = await fetchRecords(env, "account.analytic.account", [id], ["project_ids"]);
  const projectIds = (acc!["project_ids"] as number[] | undefined) ?? [];
  const kanbanViewId = await xmlidId(env, "project.view_project_kanban");
  const result: Record<string, unknown> = {
    type: "ir.actions.act_window",
    res_model: "project.project",
    views: [[kanbanViewId, "kanban"], [false, "form"]],
    domain: [["account_id", "=", id]],
    context: { create: false },
    name: translate(env, "Projects"),
  };
  if (projectIds.length === 1) {
    result["views"] = [[false, "form"]];
    result["res_id"] = projectIds[0]!;
  }
  return result;
});

/** analytic/models/analytic_plan.py:113-120 `_column_name` (and `_get_all_plans` project plan). */
async function analyticPlanColumnName(env: Environment, planId: number): Promise<string> {
  const row = (await env.cr.query<{ root: number }>(
    "SELECT COALESCE(NULLIF(split_part(parent_path, '/', 1), '')::int, id) AS root FROM account_analytic_plan WHERE id = $1",
    [planId],
  )).rows[0];
  const rootId = row?.root ?? planId;
  const projectPlan = await env.reg.xmlid(env.cr, "analytic.analytic_plan_projects");
  return rootId === projectPlan ? "account_id" : `x_plan${rootId}_id`;
}

/** purchase/models/analytic_account.py:19-34 `action_view_purchase_orders`. */
btn("account.analytic.account", "action_view_purchase_orders", async (env, ids) => {
  const id = ensureOne(ids, "account.analytic.account");
  const [acc] = await fetchRecords(env, "account.analytic.account", [id], ["plan_id"]);
  const planId = m2oId(acc!["plan_id"]);
  let poIds: number[] = [];
  if (planId !== null) {
    const col = await analyticPlanColumnName(env, planId);
    poIds = await env.model("purchase.order").search(cond(`order_line.invoice_lines.analytic_line_ids.${col}`, "=", id));
  }
  const result: Record<string, unknown> = {
    type: "ir.actions.act_window",
    res_model: "purchase.order",
    domain: [["id", "in", poIds]],
    name: translate(env, "Purchase Orders"),
    view_mode: "list,form",
  };
  if (poIds.length === 1) {
    result["view_mode"] = "form";
    result["res_id"] = poIds[0]!;
  }
  return result;
});

/** account/models/account_analytic_account.py:65-78 `action_view_vendor_bill`. */
btn("account.analytic.account", "action_view_vendor_bill", async (env, ids) => {
  const id = ensureOne(ids, "account.analytic.account");
  await fetchRecords(env, "account.analytic.account", [id], ["id"]);
  // analytic_mixin.py:111-117 `_search_analytic_distribution`: jsonb keys split by comma contain str(id)
  const matchingLines = (await env.cr.query<{ id: number }>(
    `SELECT l.id
       FROM account_move_line l
       JOIN account_move m ON m.id = l.move_id
      WHERE m.move_type IN ('in_invoice', 'in_refund', 'in_receipt')
        AND l.analytic_distribution IS NOT NULL
        AND EXISTS (
          SELECT 1
            FROM jsonb_object_keys(l.analytic_distribution) AS k
           WHERE $1::text = ANY(string_to_array(k, ','))
        )
      ORDER BY l.date DESC, l.move_name DESC, l.id`,
    [String(id)],
  )).rows.map((r) => r.id);
  const moveIds: number[] = [];
  if (matchingLines.length) {
    // Respect record rules & access on account.move.line
    const visible = await env.model("account.move.line").search(cond("id", "in", matchingLines));
    if (visible.length) {
      const rows = await env.model("account.move.line").read(visible, ["move_id"], "");
      for (const r of rows) {
        const mid = m2oId(r["move_id"]);
        if (mid !== null && !moveIds.includes(mid)) moveIds.push(mid);
      }
    }
  }
  return {
    type: "ir.actions.act_window",
    res_model: "account.move",
    domain: [["id", "in", moveIds]],
    context: { create: false, default_move_type: "in_invoice" },
    name: translate(env, "Vendor Bills"),
    view_mode: "list,form",
  };
});

/** analytic/models/analytic_plan.py:188-197 `action_view_analytical_accounts`. */
btn("account.analytic.plan", "action_view_analytical_accounts", async (env, ids) => {
  const id = ensureOne(ids, "account.analytic.plan");
  return {
    type: "ir.actions.act_window",
    res_model: "account.analytic.account",
    domain: [["plan_id", "child_of", id]],
    context: { default_plan_id: id },
    name: translate(env, "Analytical Accounts"),
    view_mode: "list,form",
  };
});

/** analytic/models/analytic_plan.py:199-209 `action_view_children_plans`. */
btn("account.analytic.plan", "action_view_children_plans", async (env, ids) => {
  const id = ensureOne(ids, "account.analytic.plan");
  const [plan] = await fetchRecords(env, "account.analytic.plan", [id], ["color"]);
  return {
    type: "ir.actions.act_window",
    res_model: "account.analytic.plan",
    domain: [["parent_id", "=", id]],
    context: { default_parent_id: id, default_color: plan!["color"] ?? 0 },
    name: translate(env, "Analytical Plans"),
    view_mode: "list,form",
  };
});

// ============================================================================================================
// 5. account.lock_exception
// ============================================================================================================

const DATE_MAX = "9999-12-31";
const lockDateCompute = (field: string) => async (_env: Environment, rec: { get(f: string): Promise<unknown> }): Promise<unknown> =>
  (await rec.get("lock_date_field")) === field ? (await rec.get("lock_date")) || false : DATE_MAX;

defineComputes("account.lock_exception", {
  // account_lock_exception.py:104-112 `_compute_state`
  state: async (env, rec) => {
    if (!(await rec.get("active"))) return "revoked";
    const end = await rec.get("end_datetime");
    if (typeof end === "string" && end) {
      const now = fmtUtcDatetime(await dbNow(env));
      if (end.slice(0, 19) < now) return "expired";
    }
    return "active";
  },
  fiscalyear_lock_date: lockDateCompute("fiscalyear_lock_date"),
  tax_lock_date: lockDateCompute("tax_lock_date"),
  sale_lock_date: lockDateCompute("sale_lock_date"),
  purchase_lock_date: lockDateCompute("purchase_lock_date"),
});

registerOverrides("account.lock_exception", {
  // account_lock_exception.py:165-211 create: parse lock date args, snapshot company_lock_date, log on company chatter
  create: async (env, valsList, next) => {
    const defaultCompany = await env.company();
    const prepared: Record<string, unknown>[] = [];
    for (const v0 of valsList) {
      const v = { ...v0 };
      if (!("lock_date" in v) || !("lock_date_field" in v)) {
        const changed = SOFT_LOCK_DATE_FIELDS.filter((f) => f in v);
        if (changed.length !== 1) {
          throw new ValidationError(translate(env, "A single exception must change exactly one lock date field."));
        }
        const field = changed[0]!;
        v["lock_date_field"] = field;
        v["lock_date"] = v[field];
        delete v[field];
      }
      const companyId = m2oId(v["company_id"]) ?? defaultCompany;
      if (!("company_id" in v)) v["company_id"] = companyId;
      if (!("user_id" in v)) v["user_id"] = env.uid;
      const fieldName = String(v["lock_date_field"]);
      if (!("company_lock_date" in v)) {
        const cur = (await env.cr.query<{ d: string | null }>(
          `SELECT to_char(${fieldName}, 'YYYY-MM-DD') AS d FROM res_company WHERE id = $1`, [companyId])).rows[0]?.d ?? false;
        v["company_lock_date"] = cur;
      }
      prepared.push(v);
    }
    const ids = await next(env, prepared);
    const lang = env.lang ?? "en_US";
    const tz = typeof env.context.tz === "string" ? env.context.tz : "UTC";
    const compDef = env.reg.model("res.company");
    for (const id of ids) {
      const [exc] = await env.sudo().model("account.lock_exception").read(
        [id], ["company_id", "user_id", "lock_date_field", "lock_date", "end_datetime", "reason"], "",
      );
      if (!exc) continue;
      const companyId = m2oId(exc["company_id"])!;
      const fieldName = String(exc["lock_date_field"]);
      const compDate = (await env.cr.query<{ d: string | null }>(
        `SELECT to_char(${fieldName}, 'YYYY-MM-DD') AS d FROM res_company WHERE id = $1`, [companyId])).rows[0]?.d ?? null;
      const excDate = typeof exc["lock_date"] === "string" && exc["lock_date"] ? exc["lock_date"] : null;
      if (compDate === excDate) continue;
      const uid = m2oId(exc["user_id"]);
      let userName = translate(env, "everyone");
      if (uid !== null) {
        const names = await env.sudo().model("res.users").displayName([uid]);
        userName = names.get(uid) ?? "";
      }
      const endDt = typeof exc["end_datetime"] === "string" && exc["end_datetime"] ? exc["end_datetime"] : null;
      const endStr = endDt ? translate(env, " valid until %s").replace("%s", await formatTrackingDatetime(endDt, tz, lang)) : "";
      const reasonStr = exc["reason"] ? translate(env, " for '%s'").replace("%s", String(exc["reason"])) : "";
      const link = `<a href="#" data-oe-model="account.lock_exception" data-oe-id="${id}">${escapeText(translate(env, "Exception"))}</a>`;
      const msg = escapeText(translate(env, "%(exception)s for %(user)s%(end_datetime_string)s%(reason)s."))
        .replace("%(exception)s", link)
        .replace("%(user)s", escapeText(userName))
        .replace("%(end_datetime_string)s", escapeText(endStr))
        .replace("%(reason)s", escapeText(reasonStr));
      const fdef = compDef.fields.get(fieldName)!;
      const oldDisp = compDate ? await formatTrackingDate(compDate, lang) : "None";
      const newDisp = excDate ? await formatTrackingDate(excDate, lang) : "None";
      const body = `${msg}${trackingBody([{ name: fieldName, sequence: fdef.trackingSequence ?? 100, label: fdef.string, old: oldDisp, new: newDisp }])}`;
      await messageLogBatch(env, "res.company", new Map([[companyId, body]]), { messageType: "tracking" });
    }
    return ids;
  },
});

registerMethod("account.lock_exception", "create", async (env0, _ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const raw = kwargs["vals_list"] ?? args[0];
  const list = (Array.isArray(raw) ? raw : [raw]) as Record<string, unknown>[];
  const ids = await create(env, "account.lock_exception", list);
  return Array.isArray(raw) ? ids : ids[0];
}, { apiModel: true });

/** account/models/account_lock_exception.py:229-238 `action_revoke`. */
btn("account.lock_exception", "action_revoke", async (env, ids) => {
  if (!env.su && !(await userHasGroup(env, "account.group_account_manager"))) {
    throw new UserError(translate(env, "You cannot revoke Lock Date Exceptions. Ask someone with the 'Adviser' role."));
  }
  const rows = await fetchRecords(env, "account.lock_exception", ids, ["active", "end_datetime"]);
  const nowStr = fmtUtcDatetime(await dbNow(env));
  const su = env.sudo();
  for (const r of rows) {
    const active = Boolean(r["active"]);
    const end = typeof r["end_datetime"] === "string" ? r["end_datetime"] : null;
    const state = !active ? "revoked" : (end && end.slice(0, 19) < nowStr) ? "expired" : "active";
    if (state === "active") {
      await write(su, "account.lock_exception", [Number(r["id"])], { active: false, end_datetime: nowStr });
    }
  }
  return null;
});

/** account/models/account_lock_exception.py:252-280 `action_show_audit_trail_during_exception`. */
btn("account.lock_exception", "action_show_audit_trail_during_exception", async (env, ids) => {
  const id = ensureOne(ids, "account.lock_exception");
  const [exc] = await fetchRecords(env, "account.lock_exception", [id], [
    "company_id", "create_date", "user_id", "lock_date", "company_lock_date",
  ]);
  const companyId = m2oId(exc!["company_id"]) ?? false;
  const domain: unknown[] = [
    ["account_audit_log_move_id.company_id", "child_of", companyId],
    ["create_date", ">=", exc!["create_date"] ?? false],
  ];
  const userId = m2oId(exc!["user_id"]);
  if (userId !== null) {
    const partnerId = (await env.cr.query<{ p: number | null }>("SELECT partner_id AS p FROM res_users WHERE id = $1", [userId])).rows[0]?.p ?? false;
    domain.push(["author_id", "=", partnerId]);
  }
  const minDate = exc!["lock_date"];
  const maxDate = exc!["company_lock_date"];
  if (minDate) domain.push(["account_audit_log_move_id.date", ">=", minDate]);
  if (maxDate) domain.push(["account_audit_log_move_id.date", "<=", maxDate]);
  return {
    name: translate(env, "Audit Trail"),
    type: "ir.actions.act_window",
    res_model: "mail.message",
    view_id: await xmlidId(env, "account.view_message_tree_audit_log"),
    view_mode: "list",
    domain,
  };
});

// ============================================================================================================
// 6. account.autopost.bills.wizard
// ============================================================================================================

async function setAutopostBills(env: Environment, ids: readonly number[], value: "always" | "ask" | "never"): Promise<null> {
  const rows = await fetchRecords(env, "account.autopost.bills.wizard", ids, ["partner_id"]);
  for (const r of rows) {
    const pid = m2oId(r["partner_id"]);
    if (pid !== null) await write(env, "res.partner", [pid], { autopost_bills: value });
  }
  return null;
}

/** account/wizard/account_autopost_bills_wizard.py:12-22. */
btn("account.autopost.bills.wizard", "action_automate_partner", async (env, ids) => setAutopostBills(env, ids, "always"));
btn("account.autopost.bills.wizard", "action_ask_later", async (env, ids) => setAutopostBills(env, ids, "ask"));
btn("account.autopost.bills.wizard", "action_never_automate_partner", async (env, ids) => setAutopostBills(env, ids, "never"));

// ============================================================================================================
// 7. account.reconcile.model
// ============================================================================================================

/** account/models/account_reconcile_model.py:210-214. */
btn("account.reconcile.model", "action_set_manual", async (env, ids) => {
  await write(env, "account.reconcile.model", ids, { trigger: "manual" });
  return null;
});

btn("account.reconcile.model", "action_set_auto_reconcile", async (env, ids) => {
  await write(env, "account.reconcile.model", ids, { trigger: "auto_reconcile" });
  return null;
});

/** account/models/account_reconcile_model.py:216-229 `action_reconcile_stat`. */
btn("account.reconcile.model", "action_reconcile_stat", async (env, ids) => {
  const id = ensureOne(ids, "account.reconcile.model");
  await fetchRecords(env, "account.reconcile.model", [id], ["id"]);
  const action = await forXmlId(env, "account.action_move_journal_line");
  const agg = (await env.cr.query<{ ids: number[] | null }>(
    "SELECT ARRAY_AGG(DISTINCT move_id) AS ids FROM account_move_line WHERE reconcile_model_id = $1",
    [id],
  )).rows[0]?.ids ?? null;
  action["context"] = {};
  action["domain"] = [["id", "in", agg]];
  action["help"] = `<p class="o_view_nocontent_empty_folder">${translate(env, "This reconciliation model has created no entry so far")}</p>`;
  return action;
});

// ============================================================================================================
// 8. account.account.action_validate_opening_move
// ============================================================================================================

/** account/models/account_account.py:1182-1194 `action_validate_opening_move`. */
btn("account.account", "action_validate_opening_move", async (env) => {
  const companyId = await env.company();
  const openingMoveId = (await env.cr.query<{ m: number | null }>(
    "SELECT account_opening_move_id AS m FROM res_company WHERE id = $1",
    [companyId],
  )).rows[0]?.m ?? null;
  if (!openingMoveId) {
    throw new UserError(translate(env, "Even magicians can't post nothing!"));
  }
  await postMoves(env, [openingMoveId], false);
  const { downPaymentAfterState } = await import("./sale_down_payment");
  await downPaymentAfterState(env, [openingMoveId], "post");
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Chart of Accounts"),
    res_model: "account.account",
    view_mode: "list",
    context: { no_breadcrumbs: true },
  };
});

// ============================================================================================================
// 9. account.financial.year.op (setup_wizards.py)
// ============================================================================================================

const FY_COMPANY_FIELDS = ["fiscalyear_last_day", "fiscalyear_last_month", "opening_date"] as const;

async function updateFiscalYearCompany(env: Environment, companyId: number, vals: Record<string, unknown>): Promise<void> {
  const compVals: Record<string, unknown> = {};
  if ("fiscalyear_last_day" in vals) compVals["fiscalyear_last_day"] = vals["fiscalyear_last_day"];
  if ("fiscalyear_last_month" in vals) compVals["fiscalyear_last_month"] = vals["fiscalyear_last_month"];
  if ("opening_date" in vals) compVals["account_opening_date"] = vals["opening_date"];
  // setup_wizards.py:55 always calls company_id.write({...}), updating write_date even when empty
  await write(env, "res.company", [companyId], compVals);
  const row = (await env.cr.query<{ d: string | null; m: number | null; st: string | null }>(
    `SELECT to_char(c.account_opening_date, 'YYYY-MM-DD') AS d, c.account_opening_move_id AS m, am.state AS st
       FROM res_company c LEFT JOIN account_move am ON am.id = c.account_opening_move_id
      WHERE c.id = $1`,
    [companyId],
  )).rows[0];
  const openingDate = (typeof vals["opening_date"] === "string" && vals["opening_date"]) ? vals["opening_date"] : row?.d ?? null;
  if (openingDate && row?.m && row.st === "draft") {
    await write(env, "account.move", [row.m], { date: addDays(openingDate, -1) });
  }
}

defineComputes("account.financial.year.op", {
  // setup_wizards.py:24-27 `_compute_opening_move_posted` -> company.py `opening_move_posted()`
  opening_move_posted: async (env, rec) => {
    const cid = m2oId(await rec.get("company_id"));
    if (cid === null) return false;
    const st = (await env.cr.query<{ st: string | null }>(
      `SELECT am.state AS st FROM res_company c JOIN account_move am ON am.id = c.account_opening_move_id WHERE c.id = $1`,
      [cid],
    )).rows[0]?.st;
    return st === "posted";
  },
});

registerOverrides("account.financial.year.op", {
  create: async (env, valsList, next) => {
    const cleaned = valsList.map((v) => ({ ...v }));
    for (const vals of cleaned) {
      const cid = m2oId(vals["company_id"]);
      if (cid !== null) {
        await updateFiscalYearCompany(env, cid, vals);
        delete vals["fiscalyear_last_day"];
        delete vals["fiscalyear_last_month"];
      }
    }
    return next(env, cleaned);
  },
  write: async (env, ids, vals, next) => {
    const rows = await fetchRecords(env, "account.financial.year.op", ids, ["company_id"]);
    for (const r of rows) {
      const cid = m2oId(r["company_id"]);
      if (cid !== null) await updateFiscalYearCompany(env, cid, vals);
    }
    const rest = { ...vals };
    for (const k of FY_COMPANY_FIELDS) delete rest[k];
    await next(env, ids, rest);
  },
});

registerMethod("account.financial.year.op", "create", async (env0, _ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const raw = kwargs["vals_list"] ?? args[0];
  const list = (Array.isArray(raw) ? raw : [raw]) as Record<string, unknown>[];
  const ids = await create(env, "account.financial.year.op", list);
  return Array.isArray(raw) ? ids : ids[0];
}, { apiModel: true });

registerMethod("account.financial.year.op", "write", async (env0, ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const vals = (kwargs["vals"] ?? args[0]) as Record<string, unknown>;
  await write(env, "account.financial.year.op", ids ?? [], vals);
  return true;
}, { apiModel: false });

/** onboarding_onboarding_step.py:94-133 `action_validate_step` + onboarding_onboarding.py:125-135 `_prepare_rendering_values`. */
async function validateOnboardingStepAndConsolidate(env: Environment, companyId: number, stepXmlId: string, onboardingXmlId: string): Promise<void> {
  const stepId = await env.reg.xmlid(env.cr, stepXmlId);
  if (typeof stepId !== "number") return;
  const su = env.sudo().withContext({ ...env.context, allowed_company_ids: [companyId] });
  const existing = (await su.cr.query<{ id: number; step_state: string }>(
    "SELECT id, step_state FROM onboarding_progress_step WHERE step_id = $1 AND (company_id IS NULL OR company_id = $2)",
    [stepId, companyId],
  )).rows[0];
  let justDone = false;
  if (existing) {
    if (existing.step_state === "not_done") {
      await write(su, "onboarding.progress.step", [existing.id], { step_state: "just_done" });
      justDone = true;
    }
  } else {
    const stepRow = (await su.cr.query<{ is_per_company: boolean }>(
      "SELECT is_per_company FROM onboarding_onboarding_step WHERE id = $1", [stepId])).rows[0];
    const progresses = (await su.cr.query<{ id: number }>(
      `SELECT p.id FROM onboarding_progress p WHERE p.onboarding_id IN (
         SELECT onboarding_onboarding_id FROM onboarding_onboarding_onboarding_onboarding_step_rel WHERE onboarding_onboarding_step_id = $1)
         AND (p.company_id IS NULL OR p.company_id = $2) ORDER BY p.id`,
      [stepId, companyId],
    )).rows;
    const [psId] = await create(su, "onboarding.progress.step", [{
      step_id: stepId,
      company_id: stepRow?.is_per_company ? companyId : false,
      progress_ids: progresses.map((p) => [4, p.id, 0]),
    }]);
    await write(su, "onboarding.progress.step", [psId!], { step_state: "just_done" });
    justDone = true;
  }
  if (!justDone) return;
  // `_prepare_rendering_values` -> `current_progress_id._get_and_update_onboarding_state()`:
  // consolidates all 'just_done' steps of this onboarding into 'done'
  const onboardingId = await env.reg.xmlid(env.cr, onboardingXmlId);
  if (typeof onboardingId !== "number") return;
  const prog = (await su.cr.query<{ id: number }>(
    "SELECT id FROM onboarding_progress WHERE onboarding_id = $1 AND (company_id IS NULL OR company_id = $2) ORDER BY id LIMIT 1",
    [onboardingId, companyId],
  )).rows[0];
  if (!prog) return;
  const toConsolidate = (await su.cr.query<{ id: number }>(
    `SELECT ps.id
       FROM onboarding_onboarding_onboarding_onboarding_step_rel r
       JOIN onboarding_progress_step ps ON ps.step_id = r.onboarding_onboarding_step_id
      WHERE r.onboarding_onboarding_id = $1
        AND (ps.company_id IS NULL OR ps.company_id = $2)
        AND ps.step_state = 'just_done'
      ORDER BY ps.id`,
    [onboardingId, companyId],
  )).rows.map((r) => r.id);
  if (toConsolidate.length) {
    await write(su, "onboarding.progress.step", toConsolidate, { step_state: "done" });
  }
  // Recompute stored onboarding_progress.onboarding_state
  const totalSteps = Number((await su.cr.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM onboarding_onboarding_onboarding_onboarding_step_rel WHERE onboarding_onboarding_id = $1",
    [onboardingId],
  )).rows[0]?.n ?? 0);
  const doneSteps = Number((await su.cr.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM onboarding_progress_onboarding_progress_step_rel r
       JOIN onboarding_progress_step ps ON ps.id = r.onboarding_progress_step_id
      WHERE r.onboarding_progress_id = $1 AND ps.step_state IN ('just_done', 'done')`,
    [prog.id],
  )).rows[0]?.n ?? 0);
  const newState = doneSteps === totalSteps ? "done" : "not_done";
  await su.cr.query("UPDATE onboarding_progress SET onboarding_state = $2 WHERE id = $1 AND onboarding_state IS DISTINCT FROM $2", [prog.id, newState]);
}

/** account/wizard/setup_wizards.py:87-92 `action_save_onboarding_fiscal_year`. */
btn("account.financial.year.op", "action_save_onboarding_fiscal_year", async (env, ids) => {
  const rows = await fetchRecords(env, "account.financial.year.op", ids, ["company_id"]);
  const companyId = rows.length === 1 ? (m2oId(rows[0]!["company_id"]) ?? await env.company()) : await env.company();
  await validateOnboardingStepAndConsolidate(
    env,
    companyId,
    "account.onboarding_onboarding_step_fiscal_year",
    "account.onboarding_onboarding_account_dashboard",
  );
  return { type: "ir.actions.client", tag: "soft_reload" };
});

// ============================================================================================================
// 10. account.secure.entries.wizard
// ============================================================================================================

interface SecureEntriesData {
  readonly moveToHashIds: number[];
  readonly notHashableUnlockedIds: number[];
  readonly unreconciledStLineIds: number[];
  readonly chainsWithGaps: { first_move_id: number; last_move_id: number }[];
}

/** account_secure_entries_wizard.py:86-152 `_get_chains_to_hash` + `_compute_data`. */
async function computeSecureEntriesData(env: Environment, companyId: number, hashDate: string | null, computeWarnings = true): Promise<SecureEntriesData> {
  if (!companyId || !hashDate) {
    return { moveToHashIds: [], notHashableUnlockedIds: [], unreconciledStLineIds: [], chainsWithGaps: [] };
  }
  const hardLock = (await env.cr.query<{ d: string | null }>(
    `SELECT max(to_char(c.hard_lock_date, 'YYYY-MM-DD')) AS d
       FROM res_company c
      WHERE c.id = ANY(string_to_array(trim(trailing '/' from (SELECT parent_path FROM res_company WHERE id = $1)), '/')::int[])
        AND c.hard_lock_date IS NOT NULL`,
    [companyId],
  )).rows[0]?.d ?? DATE_MIN;

  const groups = (await env.cr.query<{ journal_id: number; sequence_prefix: string | null; ids: number[] }>(
    `SELECT m.journal_id, m.sequence_prefix, array_agg(m.id ORDER BY m.id) AS ids
       FROM account_move m
       JOIN res_company c ON c.id = m.company_id
      WHERE ('/' || c.parent_path) LIKE ('%/' || $1::text || '/%')
        AND m.date <= $2::date
        AND m.inalterable_hash IS NULL
        AND m.state = 'posted'
      GROUP BY m.journal_id, m.sequence_prefix
      ORDER BY m.journal_id, m.sequence_prefix`,
    [companyId, hashDate],
  )).rows;

  const moveToHashIds: number[] = [];
  const notHashableUnlockedIds: number[] = [];
  const chainsWithGaps: { first_move_id: number; last_move_id: number }[] = [];

  for (const g of groups) {
    const info = await getChainInfo(env, g.ids, { forceHash: true, computeWarnings });
    if (!info) continue;
    let remaining = info.remainingMoveIds;
    if (remaining.length && hardLock !== DATE_MIN) {
      remaining = (await env.cr.query<{ id: number }>(
        "SELECT id FROM account_move WHERE id = ANY($1::int[]) AND date > $2::date ORDER BY id",
        [remaining, hardLock],
      )).rows.map((r) => r.id);
    }
    notHashableUnlockedIds.push(...remaining);
    if (computeWarnings && info.warnings.has("gap") && info.moves.length) {
      const firstId = info.lastMoveHashed ? info.lastMoveHashed.id : info.moves[0]!.id;
      const lastId = info.moves[info.moves.length - 1]!.id;
      chainsWithGaps.push({ first_move_id: firstId, last_move_id: lastId });
    }
    for (const m of info.moves) moveToHashIds.push(m.id);
  }

  const unreconciledStLineIds = moveToHashIds.length ? (await env.cr.query<{ id: number }>(
    `SELECT id FROM account_bank_statement_line WHERE move_id = ANY($1::int[]) AND NOT COALESCE(is_reconciled, false) ORDER BY internal_index DESC, id DESC`,
    [moveToHashIds],
  )).rows.map((r) => r.id) : [];

  return { moveToHashIds, notHashableUnlockedIds, unreconciledStLineIds, chainsWithGaps };
}

defineComputes("account.secure.entries.wizard", {
  max_hash_date: async (env, rec) => {
    const companyId = m2oId(await rec.get("company_id")) ?? await env.company();
    const today = await contextToday(env);
    const data = await computeSecureEntriesData(env, companyId, today, false);
    const all = [...data.moveToHashIds, ...data.notHashableUnlockedIds];
    if (!all.length) return false;
    const minDate = (await env.cr.query<{ d: string | null }>(
      "SELECT to_char(MIN(date), 'YYYY-MM-DD') AS d FROM account_move WHERE id = ANY($1::int[])",
      [all],
    )).rows[0]?.d;
    return minDate ? addDays(minDate, -1) : false;
  },
  move_to_hash_ids: async (env, rec) => {
    const companyId = m2oId(await rec.get("company_id")) ?? await env.company();
    const hashDate = (await rec.get("hash_date")) as string | false | null;
    return (await computeSecureEntriesData(env, companyId, hashDate || null)).moveToHashIds;
  },
  not_hashable_unlocked_move_ids: async (env, rec) => {
    const companyId = m2oId(await rec.get("company_id")) ?? await env.company();
    const hashDate = (await rec.get("hash_date")) as string | false | null;
    return (await computeSecureEntriesData(env, companyId, hashDate || null)).notHashableUnlockedIds;
  },
  unreconciled_bank_statement_line_ids: async (env, rec) => {
    const companyId = m2oId(await rec.get("company_id")) ?? await env.company();
    const hashDate = (await rec.get("hash_date")) as string | false | null;
    return (await computeSecureEntriesData(env, companyId, hashDate || null)).unreconciledStLineIds;
  },
  chains_to_hash_with_gaps: async (env, rec) => {
    const companyId = m2oId(await rec.get("company_id")) ?? await env.company();
    const hashDate = (await rec.get("hash_date")) as string | false | null;
    return (await computeSecureEntriesData(env, companyId, hashDate || null)).chainsWithGaps;
  },
});

registerRecordCompute("account.secure.entries.wizard", {
  hash_date: async (env, rec) => {
    const prev = await rec.prev("hash_date");
    if (prev) return prev;
    return (await rec.get("max_hash_date")) || await contextToday(env);
  },
});

/** account/wizard/account_secure_entries_wizard.py:261-270 `action_secure_entries`. */
btn("account.secure.entries.wizard", "action_secure_entries", async (env, ids) => {
  const id = ensureOne(ids, "account.secure.entries.wizard");
  const [wiz] = await fetchRecords(env, "account.secure.entries.wizard", [id], ["hash_date", "company_id"]);
  const hashDate = wiz!["hash_date"];
  if (!hashDate || typeof hashDate !== "string") {
    throw new UserError(translate(env, "Set a date. The moves will be secured up to including this date."));
  }
  const companyId = m2oId(wiz!["company_id"]) ?? await env.company();
  const data = await computeSecureEntriesData(env, companyId, hashDate);
  if (!data.moveToHashIds.length) return null;
  await hashMoves(env, data.moveToHashIds, { forceHash: true, raiseIfGap: false, raiseIfNoDocument: true });
  return null;
});

// ============================================================================================================
// 11. payment.provider
// ============================================================================================================

/** payment/models/payment_provider.py:639-645 `action_toggle_is_published`. */
btn("payment.provider", "action_toggle_is_published", async (env, ids) => {
  const id = ensureOne(ids, "payment.provider");
  const [prov] = await fetchRecords(env, "payment.provider", [id], ["is_published"]);
  await write(env, "payment.provider", [id], { is_published: !prov!["is_published"] });
  return null;
});

/** payment/models/payment_provider.py:657-666 `action_view_payment_tokens`. */
btn("payment.provider", "action_view_payment_tokens", async (env, ids) => {
  const id = ensureOne(ids, "payment.provider");
  await fetchRecords(env, "payment.provider", [id], ["id"]);
  const tokenIds = await env.withContext({ ...env.context, active_test: false })
    .model("payment.token")
    .search(cond("provider_id", "=", id));
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Payment Tokens"),
    res_model: "payment.token",
    view_mode: "list,form",
    domain: [["id", "in", tokenIds]],
    context: { create: false },
  };
});

/** payment/models/payment_provider.py:647-655 `action_view_payment_transactions`. */
btn("payment.provider", "action_view_payment_transactions", async (env, ids) => {
  const id = ensureOne(ids, "payment.provider");
  await fetchRecords(env, "payment.provider", [id], ["id"]);
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Payment History"),
    res_model: "payment.transaction",
    view_mode: "list,form",
    context: { create: false, search_default_provider_id: id },
  };
});

// ============================================================================================================
// 12. payment.transaction
// ============================================================================================================

defineComputes("payment.transaction", {
  // payment_transaction.py:183-212
  payment_data_count: async (env, rec) => {
    if (rec.id === null) return 0;
    return Number((await env.cr.query<{ n: string }>("SELECT count(*)::text AS n FROM payment_data WHERE transaction_id = $1", [rec.id])).rows[0]?.n ?? 0);
  },
  refunds_count: async (env, rec) => {
    if (rec.id === null) return 0;
    return Number((await env.cr.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM payment_transaction WHERE source_transaction_id = $1 AND operation = 'refund'", [rec.id])).rows[0]?.n ?? 0);
  },
  child_transaction_count: async (env, rec) => {
    if (rec.id === null) return 0;
    return Number((await env.cr.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM payment_transaction WHERE source_transaction_id = $1", [rec.id])).rows[0]?.n ?? 0);
  },
});

registerOverrides("payment.transaction", {
  // payment_transaction.py:242-272 create: duplicate partner fields, is_live, company_id, last_state_change
  create: async (env, valsList, next) => {
    const su = env.sudo();
    const nowStr = fmtUtcDatetime(await dbNow(env));
    const prepared = [];
    for (const v0 of valsList) {
      const v = { ...v0 };
      const providerId = m2oId(v["provider_id"]);
      if (providerId !== null) {
        const prov = (await su.cr.query<{ l: boolean | null; c: number | null }>(
          "SELECT is_live AS l, company_id AS c FROM payment_provider WHERE id = $1", [providerId])).rows[0];
        if (!("is_live" in v)) v["is_live"] = Boolean(prov?.l);
        if (!("company_id" in v) && prov?.c != null) v["company_id"] = prov.c;
      }
      if (!("last_state_change" in v)) v["last_state_change"] = nowStr;
      const partnerId = m2oId(v["partner_id"]);
      if (partnerId !== null && !("partner_name" in v)) {
        const [p] = await su.model("res.partner").read(
          [partnerId], ["name", "parent_id", "lang", "email", "street", "street2", "zip", "city", "state_id", "country_id", "phone"], "",
        );
        if (p) {
          let partnerName = p["name"] || false;
          const parentId = m2oId(p["parent_id"]);
          if (!partnerName && parentId !== null) {
            partnerName = (await su.model("res.partner").read([parentId], ["name"], ""))[0]?.["name"] ?? false;
          }
          const email = typeof p["email"] === "string" ? p["email"].trim().toLowerCase() : "";
          const address = `${(p["street"] as string) || ""} ${(p["street2"] as string) || ""}`.trim();
          Object.assign(v, {
            partner_name: partnerName,
            partner_lang: p["lang"] || false,
            partner_email: email || false,
            partner_address: address,
            partner_zip: p["zip"] || false,
            partner_city: p["city"] || false,
            partner_state_id: m2oId(p["state_id"]) ?? false,
            partner_country_id: m2oId(p["country_id"]) ?? false,
            partner_phone: p["phone"] || false,
          });
        }
      }
      prepared.push(v);
    }
    return next(env, prepared);
  },
});

registerMethod("payment.transaction", "create", async (env0, _ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const raw = kwargs["vals_list"] ?? args[0];
  const list = (Array.isArray(raw) ? raw : [raw]) as Record<string, unknown>[];
  const ids = await create(env, "payment.transaction", list);
  return Array.isArray(raw) ? ids : ids[0];
}, { apiModel: true });

registerMethod("payment.transaction", "write", async (env0, ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const vals = (kwargs["vals"] ?? args[0]) as Record<string, unknown>;
  await write(env, "payment.transaction", ids ?? [], vals);
  return true;
}, { apiModel: false });

/** account_payment/models/payment_transaction.py:39-64 `action_view_invoices`. */
btn("payment.transaction", "action_view_invoices", async (env, ids) => {
  const id = ensureOne(ids, "payment.transaction");
  const [tx] = await fetchRecords(env, "payment.transaction", [id], ["invoice_ids"]);
  const invoiceIds = (tx!["invoice_ids"] as number[] | undefined) ?? [];
  const action: Record<string, unknown> = {
    name: translate(env, "Invoices"),
    type: "ir.actions.act_window",
    res_model: "account.move",
    target: "current",
  };
  if (invoiceIds.length === 1) {
    action["res_id"] = invoiceIds[0]!;
    action["view_mode"] = "form";
    action["views"] = [[await xmlidId(env, "account.view_move_form"), "form"]];
  } else {
    action["view_mode"] = "list,form";
    action["domain"] = [["id", "in", invoiceIds]];
  }
  return action;
});

/** sale/models/payment_transaction.py:261-275 `action_view_sales_orders`. */
btn("payment.transaction", "action_view_sales_orders", async (env, ids) => {
  const txs = await fetchRecords(env, "payment.transaction", ids, ["sale_order_ids"]);
  const saleOrderIds: number[] = [];
  for (const tx of txs) {
    for (const sid of (tx["sale_order_ids"] as number[] | undefined) ?? []) {
      if (!saleOrderIds.includes(sid)) saleOrderIds.push(sid);
    }
  }
  const action: Record<string, unknown> = {
    name: translate(env, "Sales Order(s)"),
    type: "ir.actions.act_window",
    res_model: "sale.order",
    target: "current",
  };
  if (saleOrderIds.length === 1) {
    action["res_id"] = saleOrderIds[0]!;
    action["view_mode"] = "form";
  } else {
    action["view_mode"] = "list,form";
    action["domain"] = [["id", "in", saleOrderIds]];
  }
  return action;
});

/** payment/models/payment_transaction.py:314-338 `action_view_refunds`. */
btn("payment.transaction", "action_view_refunds", async (env, ids) => {
  const id = ensureOne(ids, "payment.transaction");
  const [tx] = await fetchRecords(env, "payment.transaction", [id], ["refunds_count"]);
  const action: Record<string, unknown> = {
    name: translate(env, "Refund"),
    res_model: "payment.transaction",
    type: "ir.actions.act_window",
  };
  if (Number(tx!["refunds_count"] ?? 0) === 1) {
    const found = await env.model("payment.transaction").search(cond("source_transaction_id", "=", id));
    action["res_id"] = found[0] ?? false;
    action["view_mode"] = "form";
  } else {
    action["view_mode"] = "list,form";
    action["domain"] = [["source_transaction_id", "=", id]];
  }
  return action;
});

/** payment/models/payment_transaction.py:358-371 `action_view_child_transactions`. */
btn("payment.transaction", "action_view_child_transactions", async (env, ids) => {
  const id = ensureOne(ids, "payment.transaction");
  await fetchRecords(env, "payment.transaction", [id], ["id"]);
  return {
    name: translate(env, "Operations"),
    type: "ir.actions.act_window",
    res_model: "payment.transaction",
    view_mode: "list,form",
    domain: [["source_transaction_id", "=", id]],
  };
});

/** payment/models/payment_transaction.py:340-356 `action_view_payment_data`. */
btn("payment.transaction", "action_view_payment_data", async (env, ids) => {
  const id = ensureOne(ids, "payment.transaction");
  const [tx] = await fetchRecords(env, "payment.transaction", [id], ["payment_data_count", "payment_data_ids"]);
  const pdIds = (tx!["payment_data_ids"] as number[] | undefined) ?? [];
  const action: Record<string, unknown> = {
    name: translate(env, "Pending Updates"),
    type: "ir.actions.act_window",
    domain: [["transaction_id", "=", id]],
    res_model: "payment.data",
    view_mode: "list,form",
  };
  if (Number(tx!["payment_data_count"] ?? 0) === 1) {
    action["view_mode"] = "form";
    action["res_id"] = pdIds[0] ?? false;
  }
  return action;
});

/** payment/models/payment_transaction.py:487-494 `action_post_process`. */
btn("payment.transaction", "action_post_process", async (env, ids) => {
  await fetchRecords(env, "payment.transaction", ids, ["id"]);
  await postProcessWithLock(env, ids);
  return { type: "ir.actions.client", tag: "soft_reload" };
});
