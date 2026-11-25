/**
 * The sale flow beyond the order form: the buttons of the order that open other documents and the advance payment
 * wizard's fields (sale/wizard/sale_make_invoice_advance.py). `create_invoices` needs account.move creation, which is
 * not here.
 */
import { pyPercent } from "./ir_fields_converter";
import { NotPorted, OdooError, UserError, ValidationError } from "../errors";
import { convertAmount } from "./currency_convert";
import { contextToday, uomQuantityRaw } from "./stock_engine";
import { registerMethod } from "../http/methods";
import type { Environment } from "../orm/types";
import { DbRec, NewRec, overlayOf, registerDefaults, registerOnchange, registerRecordCompute, type Rec, writeColumns } from "../orm/recompute";
import { floatRound, floatRoundRounding, floatRoundUp, roundMonetary } from "../orm/convert";
import { parseDomain } from "../orm/domain";
import { registerHooks } from "../orm/hooks";
import { registerOverrides, write } from "../orm/write";
import { create } from "../orm/create";
import { envTz, hasGroup } from "../orm/env";
import { envFor } from "../web/common";
import { onchangeCall } from "../web/onchange";
import { defaultGet } from "../web/defaults";
import { defineComputes, withCompany } from "./tail_util";
import { discountFeature, type PriceArgs, productRule, rulePrice, rulePriceBeforeDiscount, showDiscount } from "./pricelist";
import { pyFloatReprSimple, translate } from "./util";
import { isPyFloat, plainNumber } from "../orm/values";

const idOf = (v: unknown): number | null => (typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : null);

function one(ids: readonly number[] | null, what: string): number {
  if (!ids || ids.length !== 1) throw new NotPorted(`ensure_one on ${what}`);
  return ids[0]!;
}

async function actionOf(env: Environment, xmlid: string): Promise<Record<string, unknown>> {
  const { loadAction } = await import("../controllers/action");
  return loadAction({ cursor: () => env.cr, context: env.context, uid: env.uid }, xmlid, env);
}

// sale_stock/models/sale_order.py:235-236 action_view_delivery, :277-304 _get_action_view_picking
registerMethod("sale.order", "action_view_delivery", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = one(ids, "sale.order");
  const row = (await env.model("sale.order").read([id], ["picking_ids", "partner_id"], ""))[0]!;
  const pickings = (row["picking_ids"] as number[] | undefined) ?? [];
  const action = await actionOf(env, "stock.action_picking_tree_all");
  if (pickings.length > 1) action["domain"] = [["id", "in", pickings]];
  else if (pickings.length) {
    const form = await env.reg.xmlid(env.cr, "stock.view_picking_form");
    const views = (action["views"] as [unknown, string][] | undefined) ?? [];
    action["views"] = [[form, "form"], ...views.filter(([, mode]) => mode !== "form")];
    action["res_id"] = pickings[0];
  }
  if (!pickings.length) throw new OdooError("builtins.IndexError", "tuple index out of range");
  const types = await env.model("stock.picking").read(pickings, ["picking_type_id"], "");
  const codes = (await env.cr.query<{ id: number; code: string }>("SELECT id, code FROM stock_picking_type WHERE id = ANY($1::int[])", [types.map((t) => idOf(t["picking_type_id"]))])).rows;
  const outgoing = new Set(codes.filter((c) => c.code === "outgoing").map((c) => c.id));
  const chosen = types.find((t) => outgoing.has(idOf(t["picking_type_id"])!)) ?? types[0]!;
  action["context"] = { default_partner_id: idOf(row["partner_id"]) ?? false, default_picking_type_id: idOf(chosen["picking_type_id"]) ?? false };
  return action;
}, { apiModel: false });

// sale_project/models/sale_order.py:182-217 action_create_project
registerMethod("sale.order", "action_create_project", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = one(ids, "sale.order");
  if (!await hasGroup(env, "project.group_project_manager")) {
    return {
      type: "ir.actions.client",
      tag: "display_notification",
      params: {
        type: "danger",
        message: translate(env, "The project couldn't be created because you don't have the right to create a project", "sale_project"),
      },
    };
  }
  const row = (await env.model("sale.order").read([id], ["name", "partner_id", "company_id", "order_line"], ""))[0]!;
  const partnerId = idOf(row["partner_id"]);
  const companyId = idOf(row["company_id"]);
  const lineIds = (row["order_line"] as number[] | undefined) ?? [];
  const lineRows = lineIds.length
    ? (await env.cr.query<{ id: number; display_type: string | null; type: string | null; invoice_policy: string | null; service_type: string | null }>(
      `SELECT l.id, l.display_type, t.type, t.invoice_policy, t.service_type
         FROM sale_order_line l LEFT JOIN product_product p ON p.id = l.product_id LEFT JOIN product_template t ON t.id = p.product_tmpl_id
        WHERE l.id = ANY($1::int[]) ORDER BY l.sequence, l.id`, [lineIds])).rows
    : [];
  const defaultLine = lineRows.find((l) => !l.display_type && l.type === "service");
  const isMilestone = (l: { invoice_policy: string | null; service_type: string | null } | undefined): boolean =>
    l?.invoice_policy === "delivery" && l?.service_type === "milestones";
  const partnerName = partnerId
    ? (await env.cr.query<{ n: string | null }>("SELECT commercial_company_name AS n FROM res_partner WHERE id = $1", [partnerId])).rows[0]?.n
    : null;
  const viewId = await env.reg.xmlid(env.cr, "sale_project.sale_project_view_form_simplified_template");
  const { openProjectTemplateView } = await import("./project_project_create");
  const base = await openProjectTemplateView(env);
  return {
    ...base,
    name: translate(env, "Create a Project", "sale_project"),
    views: [[viewId ?? false, "form"]],
    context: {
      default_sale_order_id: id,
      default_reinvoiced_sale_order_id: id,
      default_sale_line_id: defaultLine?.id ?? false,
      default_partner_id: partnerId ?? false,
      default_user_ids: [env.uid],
      default_allow_billable: 1,
      hide_allow_billable: true,
      default_company_id: companyId ?? false,
      generate_milestone: isMilestone(defaultLine),
      default_name: `${String(row["name"] ?? "")} - ${partnerName ?? "False"}`,
      default_allow_milestones: lineRows.some(isMilestone),
      sale_company_id: companyId ?? false,
    },
  };
}, { apiModel: false });

// sale_project/models/sale_order.py:219-255 action_view_project_ids
registerMethod("sale.order", "action_view_project_ids", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = one(ids, "sale.order");
  const row = (await env.model("sale.order").read([id], ["project_ids", "partner_shipping_id", "partner_id", "order_line"], ""))[0]!;
  const projects = (row["project_ids"] as number[] | undefined) ?? [];
  const lines = (row["order_line"] as number[] | undefined) ?? [];
  const sorted = lines.length ? await env.model("sale.order.line").read(await env.model("sale.order.line").search({ kind: "cond", path: "id", op: "in", value: lines }, { order: "sequence, id" }), ["product_id"], "") : [];
  let saleLine: number | false = false;
  for (const l of sorted) {
    const product = idOf(l["product_id"]);
    if (product === null) continue;
    const t = (await env.cr.query<{ type: string }>("SELECT t.type FROM product_product p JOIN product_template t ON t.id = p.product_tmpl_id WHERE p.id = $1", [product])).rows[0]?.type;
    if (t === "service") { saleLine = Number(l["id"]); break; }
  }
  const partner = idOf(row["partner_shipping_id"]) ?? idOf(row["partner_id"]) ?? false;
  if (projects.length === 1) {
    const action = await actionOf(env.withContext({ ...env.context, active_id: projects[0] }), "project.act_project_project_2_project_task_all");
    action["context"] = {
      active_id: projects[0], default_partner_id: partner, default_project_id: projects[0], default_sale_line_id: saleLine,
      default_user_ids: [env.uid], search_default_sale_order_id: id,
    };
    return action;
  }
  const action = await actionOf(env, "project.open_view_project_all");
  action["domain"] = ["|", ["sale_order_id", "=", id], ["id", "in", projects]];
  action["context"] = {
    ...env.context, default_partner_id: partner, default_reinvoiced_sale_order_id: id, default_sale_line_id: saleLine,
    default_allow_billable: 1, from_sale_order_action: true,
  };
  return action;
}, { apiModel: false });

const ordersOf = async (rec: Rec): Promise<number[]> => (await rec.rels("sale_order_ids")).map((r) => r.origin).filter((x): x is number => x !== null);

// sale/wizard/sale_make_invoice_advance.py:72-124
defineComputes("sale.advance.payment.inv", {
  count: async (_env, rec) => (await rec.rels("sale_order_ids")).length,
  allow_invoice_overages: async (env, rec) => {
    const orders = await ordersOf(rec);
    if (!orders.length) return false;
    return (await env.model("sale.order").read(orders, ["has_overages"], "")).some((r) => r["has_overages"]);
  },
  invoice_overages: async (_env, rec) => Boolean(await rec.get("allow_invoice_overages")),
  has_down_payments: async (env, rec) => {
    const orders = await ordersOf(rec);
    return (await env.cr.query("SELECT 1 FROM sale_order_line WHERE order_id = ANY($1::int[]) AND is_downpayment LIMIT 1", [orders])).rows.length > 0;
  },
  display_draft_invoice_warning: async (env, rec) => {
    const orders = await ordersOf(rec);
    if (!orders.length) return false;
    const invoices = (await env.sudo().model("sale.order").read(orders, ["invoice_ids"], "")).flatMap((r) => (r["invoice_ids"] as number[]) ?? []);
    return (await env.cr.query("SELECT 1 FROM account_move WHERE id = ANY($1::int[]) AND state = 'draft' LIMIT 1", [invoices])).rows.length > 0;
  },
  amount_invoiced: async (env, rec) => {
    const orders = await ordersOf(rec);
    if (!orders.length) return 0;
    let sum = 0;
    for (const r of await env.model("sale.order").read(orders, ["amount_invoiced"], "")) {
      const v = r["amount_invoiced"];
      sum += typeof v === "number" ? v : v && typeof v === "object" && "float" in v ? Number((v as { float: number }).float) : 0;
    }
    return sum;
  },
  // the stored ones, on a new wizard: one order's currency and company
  currency_id: async (env, rec) => {
    const orders = await ordersOf(rec);
    return orders.length === 1 ? idOf((await env.model("sale.order").read(orders, ["currency_id"], ""))[0]?.["currency_id"]) : null;
  },
  company_id: async (env, rec) => {
    const orders = await ordersOf(rec);
    return orders.length === 1 ? idOf((await env.model("sale.order").read(orders, ["company_id"], ""))[0]?.["company_id"]) : null;
  },
});

// sale_order.py:1155-1158 and sale_order_line.py:1469-1485 `_compute_amount_invoiced`: posted invoice lines, signed, converted to line currency
defineComputes("sale.order", {
  amount_invoiced: async (env, rec) => {
    const orderId = rec.id ?? rec.origin;
    if (orderId === null) return 0;
    const rows = (await env.sudo().cr.query<{ total: string | number | null; move_type: string; il_cur: number | null; sl_cur: number | null; company_id: number; inv_date: string | null }>(
      `SELECT il.price_total AS total, m.move_type, il.currency_id AS il_cur, sl.currency_id AS sl_cur, sl.company_id,
              to_char(m.invoice_date, 'YYYY-MM-DD') AS inv_date
         FROM sale_order_line sl JOIN sale_order_line_invoice_rel r ON r.order_line_id = sl.id
         JOIN account_move_line il ON il.id = r.invoice_line_id JOIN account_move m ON m.id = il.move_id
        WHERE sl.order_id = $1 AND (m.state = 'posted' OR m.payment_state = 'invoicing_legacy')`, [orderId])).rows;
    let sum = 0;
    for (const r of rows) {
      let amount = Number(r.total ?? 0);
      if (r.il_cur !== null && r.sl_cur !== null && r.il_cur !== r.sl_cur) {
        const convDate = r.inv_date ?? await contextToday(env);
        amount = await convertAmount(env, amount, r.il_cur, r.sl_cur, r.company_id, convDate, true);
      }
      // `-invoice.direction_sign` (account_move.py `_compute_direction_sign`): 1 on inbound documents
      const inbound = ["out_invoice", "in_refund", "out_receipt"].includes(r.move_type);
      sum += amount * (inbound ? 1 : -1);
    }
    return currencyRound(env, rec, sum);
  },
});

/** Monetary.convert_to_cache (fields_numeric.py): an assigned value is rounded by the record's currency. */
async function currencyRound(env: Environment, rec: Rec, value: number): Promise<number> {
  const currency = idOf(await rec.get("currency_id"));
  if (!value || currency === null) return value;
  const rounding = (await env.cr.query<{ r: string }>("SELECT rounding::text AS r FROM res_currency WHERE id = $1", [currency])).rows[0]?.r;
  return rounding === undefined ? value : roundMonetary(value, Number(rounding));
}

// sale_order.py:1150-1153 `_compute_amount_to_invoice`: the sum of the lines' (pos_sale's override is not installed)
defineComputes("sale.order", {
  amount_to_invoice: async (env, rec) => {
    let sum = 0;
    for (const line of await rec.rels("order_line")) sum += Number((await line.get("amount_to_invoice")) ?? 0);
    return currencyRound(env, rec, sum);
  },
});

defineComputes("sale.order.line", {
  // sale_order_line.py:1311-1332 `_compute_qty_invoiced_posted`: the posted invoice lines, signed by `-direction_sign`
  qty_invoiced_posted: async (env, rec) => {
    const accrual = env.context["accrual_entry_date"];
    const accrualDate = typeof accrual === "string" && accrual ? accrual.slice(0, 10) : null;
    const lineUom = idOf(await rec.get("product_uom_id"));
    let qty = 0;
    for (const il of await rec.rels("invoice_lines")) {
      const move = await il.rel("move_id");
      if (!move) continue;
      if (accrualDate) {
        const invDate = await move.get("invoice_date");
        if (typeof invDate !== "string" || !invDate || invDate.slice(0, 10) > accrualDate) continue;
      }
      if ((await move.get("state")) !== "posted" && (await move.get("payment_state")) !== "invoicing_legacy") continue;
      const ilUom = idOf(await il.get("product_uom_id"));
      const rawQty = Number((await il.get("quantity")) ?? 0);
      const qtyUnsigned = ilUom !== null && lineUom !== null && ilUom !== lineUom
        ? await uomQuantity(env, rawQty, ilUom, lineUom, "UP")
        : rawQty;
      // account_move.py `_compute_direction_sign`: 1 for entries and outbound documents, else -1
      const inbound = ["out_invoice", "in_refund", "out_receipt"].includes(String(await move.get("move_type")));
      qty += qtyUnsigned * (inbound ? 1 : -1);
    }
    return qty;
  },
  // :1565-1576 `_compute_amount_to_invoice`
  amount_to_invoice: async (env, rec) => {
    const ordered = Number((await rec.get("product_uom_qty")) ?? 0);
    if (!ordered) return 0;
    const unit = Number((await rec.get("price_total")) ?? 0) / ordered;
    return currencyRound(env, rec, unit * (ordered - Number((await rec.get("qty_invoiced_posted")) ?? 0)));
  },
});

// sale_make_invoice_advance.py:87-89 `_inverse_invoice_overages`: the orders of the wizard take its value. The
// assignment always writes (fields.py:2024-2028 `__set__` calls `write` without comparing), so an order whose column
// is NULL gets False (measured on Odoo: `/tmp/fix6/s_ovg.py`)
async function setOverages(env: Environment, wizard: number, value: boolean): Promise<void> {
  const orders = ((await env.model("sale.advance.payment.inv").read([wizard], ["sale_order_ids"], ""))[0]?.["sale_order_ids"] as number[]) ?? [];
  if (!orders.length) return;
  await write(env, "sale.order", orders, { invoice_overages: value });
}
registerOverrides("sale.advance.payment.inv", {
  create: async (env, valsList, next) => {
    const assigned = valsList.map((vals) => {
      if (!("invoice_overages" in vals)) return null;
      const v = Boolean(vals["invoice_overages"]);
      delete vals["invoice_overages"];
      return v;
    });
    const ids = await next(env, valsList);
    for (const [i, id] of ids.entries()) if (assigned[i] !== null) await setOverages(env, id, assigned[i]!);
    return ids;
  },
  inverse: {
    invoice_overages: async (env, ids) => {
      const overlay = overlayOf(env, "sale.advance.payment.inv", "invoice_overages");
      for (const id of ids) await setOverages(env, id, Boolean(overlay?.get(id)));
    },
  },
});

/** sale_order_line.py:570-615 `_get_sale_order_line_multiline_description_variants`. */
async function descriptionVariants(env: Environment, rec: Rec): Promise<string> {
  const noVariant = (await rec.rels("product_no_variant_attribute_value_ids")).map((r) => r.origin).filter((x): x is number => x !== null);
  const rows = noVariant.length ? (await env.cr.query<{ id: number; display_type: string; value_count: number }>(
    `SELECT v.id, a.display_type, l.value_count FROM product_template_attribute_value v
       JOIN product_attribute_value pav ON pav.id = v.product_attribute_value_id JOIN product_attribute a ON a.id = pav.attribute_id
       JOIN product_template_attribute_line l ON l.id = v.attribute_line_id WHERE v.id = ANY($1::int[])`, [noVariant])).rows : [];
  const chosen = rows.filter((r) => r.display_type === "multi" || r.value_count > 1);
  const custom = await rec.rels("product_custom_attribute_value_ids");
  if (!custom.length && !chosen.length) return "";
  const lines: string[] = [];
  const customPtavs: number[] = [];
  for (const c of custom) customPtavs.push(idOf(await c.get("custom_product_template_attribute_value_id"))!);
  const multiSet = new Set(chosen.filter((r) => r.display_type === "multi").map((r) => r.id));
  const plain = noVariant.filter((id) => chosen.some((r) => r.id === id) && !multiSet.has(id) && !customPtavs.includes(id));
  if (plain.length) {
    const names = await env.model("product.template.attribute.value").displayName(plain);
    for (const id of plain) lines.push(names.get(id) ?? "");
  }
  // :590, 597-604 multi-checkbox attributes: sorted by PTAV _order, grouped by attribute_id
  if (multiSet.size) {
    const multiIds = [...multiSet];
    const sortedMulti = multiIds.length > 1
      ? await env.model("product.template.attribute.value").search(parseDomain([["id", "in", multiIds]]))
      : multiIds;
    const lang = env.lang ?? "en_US";
    const multiRows = (await env.cr.query<{ id: number; attr_id: number; attr_name: string; val_name: string }>(
      `SELECT v.id, v.attribute_id AS attr_id,
              COALESCE(a.name->>$2, a.name->>'en_US') AS attr_name,
              COALESCE(pav.name->>$2, pav.name->>'en_US') AS val_name
         FROM product_template_attribute_value v
         JOIN product_attribute_value pav ON pav.id = v.product_attribute_value_id
         JOIN product_attribute a ON a.id = v.attribute_id
        WHERE v.id = ANY($1::int[])`, [sortedMulti, lang])).rows;
    const byId = new Map(multiRows.map((r) => [r.id, r]));
    const groups = new Map<number, { attr: string; vals: string[] }>();
    for (const id of sortedMulti) {
      const r = byId.get(id);
      if (!r) continue;
      const g = groups.get(r.attr_id) ?? { attr: r.attr_name, vals: [] };
      g.vals.push(r.val_name);
      groups.set(r.attr_id, g);
    }
    const tmpl = translate(env, "%(attribute)s: %(values)s", "sale");
    for (const g of groups.values()) {
      lines.push(tmpl.replace("%(attribute)s", g.attr).replace("%(values)s", g.vals.join(", ")));
    }
  }
  // the custom values, by product.template.attribute.value `_order`, as "<value>: <custom text>" (name of
  // product.attribute.custom.value, product_attribute_custom_value.py:21-26)
  const sorted = customPtavs.length > 1 ? await env.model("product.template.attribute.value").search(parseDomain([["id", "in", customPtavs]])) : customPtavs;
  const names = sorted.length ? await env.model("product.template.attribute.value").displayName(sorted) : new Map<number, string>();
  for (const ptav of sorted) {
    for (const c of custom) {
      if (idOf(await c.get("custom_product_template_attribute_value_id")) !== ptav) continue;
      const text = String((await c.get("custom_value")) || "").trim();
      const display = names.get(ptav);
      lines.push(display ? `${display}: ${text}` : text);
    }
  }
  return lines.join("\n");
}

/**
 * ir_sequence.py:295-308 next_by_code with :277-280 `_next`, :256-258 get_next_char: `standard` sequences without date
 * ranges and without interpolated prefix or suffix; anything else refuses.
 */
export async function nextByCode(env: Environment, code: string): Promise<string | false> {
  const seq = (await env.cr.query<{ id: number; prefix: string | null; suffix: string | null; padding: number; implementation: string; use_date_range: boolean | null }>(
    `SELECT id, prefix, suffix, padding, implementation, use_date_range FROM ir_sequence
      WHERE code = $1 AND (company_id = $2 OR company_id IS NULL) AND active ORDER BY company_id NULLS LAST, id LIMIT 1`, [code, await env.company()])).rows[0];
  if (!seq) return false;
  return nextOfSequence(env, seq, code);
}

/**
 * ir_sequence.py:289-292 next_by_id of a sequence row, with :277-288 `_next`: a `standard` sequence without date ranges
 * draws from its PostgreSQL sequence; a `no_gap` one (with or without date ranges, :57-64 `_update_nogap`, :330-387 the
 * date range's `_next`) from its `number_next` column. A `standard` sequence with date ranges refuses.
 */
export async function nextOfSequence(env: Environment, seq: { id: number; prefix: string | null; suffix: string | null; padding: number; implementation: string; use_date_range: boolean | null }, label: string): Promise<string> {
  if (seq.implementation === "standard" && !seq.use_date_range) {
    const name = `ir_sequence_${String(seq.id).padStart(3, "0")}`;
    const row = (await env.cr.query<{ n: string }>(`SELECT nextval('${name}')::text AS n`)).rows[0]!;
    return await interpolated(env, seq, label, null) + row.n.padStart(seq.padding, "0") + await interpolated(env, seq, label, null, "suffix");
  }
  if (seq.implementation !== "no_gap") throw new NotPorted(`ir.sequence ${label}: ${seq.implementation}, date ranges`);
  const increment = Number((await env.cr.query<{ i: number }>("SELECT number_increment AS i FROM ir_sequence WHERE id = $1", [seq.id])).rows[0]?.i ?? 1);
  if (!seq.use_date_range) {
    const n = await updateNogap(env, "ir_sequence", seq.id, increment);
    return await interpolated(env, seq, label, null) + String(n).padStart(seq.padding, "0") + await interpolated(env, seq, label, null, "suffix");
  }
  // :277-288 `dt = context ir_sequence_date or fields.Datetime.now()`: the day of the database's clock (UTC)
  const ctxDate = env.context["ir_sequence_date"];
  const today = typeof ctxDate === "string" && ctxDate
    ? ctxDate.slice(0, 10)
    : (await env.cr.query<{ d: string }>("SELECT to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS d")).rows[0]!.d;
  let range = (await env.cr.query<{ id: number; date_from: string }>(
    "SELECT id, to_char(date_from, 'YYYY-MM-DD') AS date_from FROM ir_sequence_date_range WHERE sequence_id = $1 AND date_from <= $2 AND date_to >= $2 ORDER BY id LIMIT 1", [seq.id, today])).rows[0];
  if (!range) {
    // :262-276 `_create_date_range_seq`: the calendar year, shortened by the neighbouring ranges
    const year = today.slice(0, 4);
    let dateFrom = `${year}-01-01`, dateTo = `${year}-12-31`;
    const after = (await env.cr.query<{ d: string }>(
      "SELECT to_char(date_from - 1, 'YYYY-MM-DD') AS d FROM ir_sequence_date_range WHERE sequence_id = $1 AND date_from >= $2 AND date_from <= $3 ORDER BY date_from DESC LIMIT 1", [seq.id, today, dateTo])).rows[0];
    if (after) dateTo = after.d;
    const before = (await env.cr.query<{ d: string }>(
      "SELECT to_char(date_to + 1, 'YYYY-MM-DD') AS d FROM ir_sequence_date_range WHERE sequence_id = $1 AND date_to >= $2 AND date_to <= $3 ORDER BY date_to DESC LIMIT 1", [seq.id, dateFrom, today])).rows[0];
    if (before) dateFrom = before.d;
    const [id] = await create(env.sudo(), "ir.sequence.date_range", [{ date_from: dateFrom, date_to: dateTo, sequence_id: seq.id }]);
    range = { id: id!, date_from: dateFrom };
  }
  const n = await updateNogap(env, "ir_sequence_date_range", range.id, increment);
  return await interpolated(env, seq, label, range.date_from, "prefix", today) + String(n).padStart(seq.padding, "0") + await interpolated(env, seq, label, range.date_from, "suffix", today);
}

/** ir_sequence.py:57-64 `_update_nogap`: the current number, then a raw increment (no write_date). */
async function updateNogap(env: Environment, table: "ir_sequence" | "ir_sequence_date_range", id: number, increment: number): Promise<number> {
  const n = Number((await env.cr.query<{ n: number }>(`SELECT number_next AS n FROM ${table} WHERE id = $1 FOR UPDATE NOWAIT`, [id])).rows[0]!.n);
  await env.cr.query(`UPDATE ${table} SET number_next = number_next + $1 WHERE id = $2`, [increment, id]);
  return n;
}

/**
 * ir_sequence.py:213-244 `_get_prefix_suffix`: `%(year)s`-style keys. Through a date range (:277-288) the effective date
 * is `ir_sequence_date` or `fields.Datetime.now()` (UTC) and `range_*` the range's start; without one, `effective_date`
 * respects `ir_sequence_date` in context, `range_*` respects `ir_sequence_date_range`, and `current_*` is now in `env.tz`.
 */
async function interpolated(env: Environment, seq: { prefix: string | null; suffix: string | null }, label: string, rangeFrom: string | null, which: "prefix" | "suffix" = "prefix", effDate: string | null = null): Promise<string> {
  const s = seq[which];
  if (!s) return "";
  if (!s.includes("%")) return s;
  const tz = await envTz(env);
  const now = (await env.cr.query<{ d: string }>("SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') AS d", [tz])).rows[0]!.d;
  const ctxDate = env.context["ir_sequence_date"];
  const ctxRange = env.context["ir_sequence_date_range"];
  const effStr = effDate ?? (typeof ctxDate === "string" && ctxDate ? ctxDate.slice(0, 10) : now);
  const rangeStr = rangeFrom ?? (typeof ctxRange === "string" && ctxRange ? ctxRange.slice(0, 10) : now);
  const parts = (d: string): Record<string, string> => ({ year: d.slice(0, 4), month: d.slice(5, 7), day: d.slice(8, 10), y: d.slice(2, 4) });
  const eff = parts(effStr), range = parts(rangeStr), current = parts(now);
  return s.replace(/%\((\w+)\)s|%%|%/g, (m, key: string | undefined) => {
    if (m === "%%") return "%";
    const k = key ?? "";
    const [src, name] = k.startsWith("range_") ? [range, k.slice(6)] : k.startsWith("current_") ? [current, k.slice(8)] : [eff, k];
    const v = Object.hasOwn(src, name) ? src[name] : undefined;
    if (v === undefined) throw new NotPorted(`ir.sequence ${label} with the interpolation ${m}`);
    return v;
  });
}

// sale_order.py:1453-1467 create: the name from the sequence of the order's company
registerOverrides("sale.order", {
  // sale_stock sale_order.py:146-184 write: before super, a new commitment date becomes the deadline of the open moves
  // to customers of the order's lines (:159-166; the order's expected date when it is emptied). The decreased
  // quantities (:148-150, :169-183) and the delivery address (:152-157) are the guard's (src/orm/override_status.ts).
  write: async (env, ids, vals, next) => {
    if ("commitment_date" in vals && env.reg.models.get("stock.move")?.fields.has("sale_line_id")) {
      const deadline = vals["commitment_date"];
      for (const id of ids) {
        // `order.order_line.move_ids`: the lines in their order, each one's moves in the move order (sequence, id)
        const moves = (await env.cr.query<{ id: number }>(
          `SELECT m.id FROM sale_order_line l JOIN stock_move m ON m.sale_line_id = l.id JOIN stock_location d ON d.id = m.location_dest_id
            WHERE l.order_id = $1 AND m.state NOT IN ('done', 'cancel') AND d.usage = 'customer'
            ORDER BY l.sequence, l.id, m.sequence, m.id`, [id])).rows.map((r) => r.id);
        if (!moves.length) continue;
        let value: unknown = deadline;
        if (!value) {
          // `order.expected_date`, a datetime: `_set_date_deadline` compares it with the next moves' deadlines
          if ((await env.cr.query("SELECT 1 FROM stock_move_move_rel WHERE move_orig_id = ANY($1::int[]) OR move_dest_id = ANY($1::int[]) LIMIT 1", [moves])).rows.length) {
            throw new NotPorted("sale.order commitment_date emptied with chained moves (the expected date propagated)");
          }
          value = (await env.model("sale.order").read([id], ["expected_date"]))[0]?.["expected_date"] ?? false;
        }
        await write(env, "stock.move", [...new Set(moves)], { date_deadline: value });
      }
    }
    await next(env, ids, vals);
  },
  // sale_order.py:1486-1495 `_unlink_except_draft_or_cancel`
  beforeUnlink: async (env, ids) => {
    const states = (await env.cr.query<{ state: string | null }>("SELECT state FROM sale_order WHERE id = ANY($1::int[]) ORDER BY id", [[...ids]])).rows;
    if (states.some((r) => r.state !== "draft" && r.state !== "cancel")) {
      throw new UserError(translate(env, "You can not delete a sent quotation or a confirmed sales order. You must first cancel it.", "sale"));
    }
  },
  create: async (env, valsList, next) => {
    for (const vals of valsList) {
      if ("name" in vals && vals["name"] !== "New") continue;
      const company = idOf(vals["company_id"]);
      vals["name"] = (await nextByCode(company ? await withCompany(env, company) : env, "sale.order")) || "New";
    }
    const ids = await next(env, valsList);
    // the stored related line currency (sale_order_line.py), when the order's own is computed after its lines
    await env.cr.query(
      `UPDATE sale_order_line l SET currency_id = o.currency_id FROM sale_order o
        WHERE l.order_id = o.id AND o.id = ANY($1::int[]) AND l.currency_id IS NULL`, [ids]);
    return ids;
  },
});

/** The line's analytic_distribution compute (:1481-1492): `_get_distribution` finds nothing without distribution models. */
export async function analyticDistribution(env: Environment, rec: Rec): Promise<unknown> {
  const n = (await env.cr.query<{ n: string }>("SELECT count(*)::text AS n FROM account_analytic_distribution_model")).rows[0]?.n;
  if (Number(n)) throw new NotPorted(`${rec.def.name}.analytic_distribution with distribution models`);
  return rec.prev("analytic_distribution");
}

/**
 * sale_project sale_order_line.py:94-117 `_compute_analytic_distribution`: a product line of a project (the context's,
 * the product's in the line's company, or the order's) without distribution gets the project's accounts
 * (analytic_line.py:57-73 `_get_analytic_distribution`).
 */
async function saleLineAnalyticDistribution(env: Environment, rec: Rec): Promise<unknown> {
  const base = await analyticDistribution(env, rec);
  if (!env.reg.models.get("sale.order.line")?.fields.has("project_id")) return base;
  if ((await rec.get("display_type")) || (await rec.get("is_downpayment"))) return base;
  let project: number | null = typeof env.context["project_id"] === "number" ? env.context["project_id"] : null;
  if (project === null) {
    const product = await rec.rel("product_id");
    const company = idOf(await rec.get("company_id"));
    if (product && company) {
      const tmpl = await product.rel("product_tmpl_id");
      const raw = tmpl ? (await env.cr.query<{ p: Record<string, number> | null }>("SELECT project_id AS p FROM product_template WHERE id = $1", [tmpl.origin])).rows[0]?.p : null;
      project = raw?.[String(company)] ?? null;
    }
  }
  if (project === null) {
    const order = await rec.rel("order_id");
    project = order ? idOf(await order.get("project_id")) : null;
  }
  if (project === null) return base;
  const [p] = (await env.cr.query<{ a: number | null; x2: number | null; x3: number | null }>(
    "SELECT account_id AS a, x_plan2_id AS x2, x_plan3_id AS x3 FROM project_project WHERE id = $1", [project])).rows;
  if (p && (p.x2 || p.x3)) throw new NotPorted("sale.order.line.analytic_distribution of a project with accounts in several plans");
  const projectDistribution = p?.a ? { [String(p.a)]: 100 } : {};
  const current = base && typeof base === "object" && Object.keys(base).length ? base as Record<string, unknown> : null;
  if (current === null) return Object.keys(projectDistribution).length ? projectDistribution : base;
  // an existing distribution gets the project's accounts of the plans it lacks
  if (JSON.stringify(current) === JSON.stringify(projectDistribution) || !p?.a) return base;
  throw new NotPorted("sale.order.line.analytic_distribution adding the project's accounts to another distribution");
}

/** analytic_mixin.py:23-25 analytic_precision's default. */
export async function analyticPrecision(env: Environment): Promise<number> {
  return (await env.cr.query<{ digits: number }>("SELECT digits FROM decimal_precision WHERE name = 'Percentage Analytic'")).rows[0]?.digits ?? 2;
}
registerDefaults("sale.order.line", { analytic_precision: analyticPrecision });

/** The order's pricelist of a line, or null. */
async function linePricelist(rec: Rec): Promise<number | null> {
  const order = await rec.rel("order_id");
  return order ? idOf(await order.get("pricelist_id")) : null;
}

/** :896-902 `_get_pricelist_kwargs` with :904-914 `_get_product_price_context` (the no_variant values). */
async function pricelistArgs(env: Environment, rec: Rec, product: Rec): Promise<PriceArgs> {
  const order = await rec.rel("order_id");
  const date = order ? await order.get("date_order") : null;
  const company = idOf(await rec.get("company_id")) ?? await env.company();
  const currency = idOf(await rec.get("currency_id"))
    ?? (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [company])).rows[0]!.c;
  const chosen = (((await rec.get("product_no_variant_attribute_value_ids")) as unknown[] | null) ?? []).map(idOf).filter((v): v is number => v !== null);
  return {
    product, quantity: Number((await rec.get("product_uom_qty")) ?? 0) || 1.0, uom: idOf(await rec.get("product_uom_id")),
    date: typeof date === "string" && date ? date : await dbNowString(env), currency, chosen,
  };
}

/** `fields.Datetime.now()` of the database clock (the rules' fallback date, product_pricelist.py:189-191). */
async function dbNowString(env: Environment): Promise<string> {
  return (await env.cr.query<{ n: string }>("SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS n")).rows[0]!.n;
}

// the field is not stored: reads of database lines compute it (src/orm/model.ts `computed` hooks)
registerHooks("sale.order.line", {
  computed: {
    pricelist_item_id: async (env, ids) => {
      const def = env.reg.model("sale.order.line");
      const out = new Map<number, unknown>();
      for (const id of ids) out.set(id, (await linePricelistItem(env, new DbRec(env, def, id))) ?? false);
      return out;
    },
  },
});

/** :748-758 `_compute_pricelist_item_id`: the pricelist's rule for the line (`_get_product_rule`). */
async function linePricelistItem(env: Environment, rec: Rec): Promise<number | null> {
  const product = await rec.rel("product_id");
  const pricelist = await linePricelist(rec);
  if (!product || (await rec.get("display_type")) || pricelist === null) return null;
  return productRule(env, pricelist, await pricelistArgs(env, rec, product));
}

/** account_tax.py:4968-4980 `_filter_taxes_by_company`: up the company hierarchy until a tax is found. */
export async function taxesOfCompany(env: Environment, taxes: Rec[], company: number): Promise<Rec[]> {
  if (!taxes.length) return [];
  const companies = new Map<Rec, number | null>();
  for (const t of taxes) companies.set(t, idOf(await t.get("company_id")));
  for (let c: number | null = company; c;) {
    const found = taxes.filter((t) => companies.get(t) === c);
    if (found.length) return found;
    c = (await env.cr.query<{ parent_id: number | null }>("SELECT parent_id FROM res_company WHERE id = $1", [c])).rows[0]?.parent_id ?? null;
  }
  return [];
}

async function orderFiscalPosition(rec: Rec): Promise<Rec | null> {
  const order = await rec.rel("order_id");
  return order ? order.rel("fiscal_position_id") : null;
}

/** sale_order_line.py:711-725: the taxes `_compute_tax_ids` maps through the order's fiscal position (none: no taxes). */
async function lineTaxesToMap(env: Environment, rec: Rec): Promise<Rec[]> {
  if ((await rec.get("product_type")) === "combo") return [];
  const company = idOf(await rec.get("company_id")) ?? await env.company();
  const product = await rec.rel("product_id");
  let taxes: Rec[] = [];
  if (product) taxes = await taxesOfCompany(env, await product.rels("taxes_id"), company);
  if (!taxes.length && !product && !(await rec.get("display_type"))) {
    const row = (await env.cr.query<{ tax: number | null }>("SELECT account_sale_tax_id AS tax FROM res_company WHERE id = $1", [company])).rows[0];
    if (row?.tax) taxes = [new DbRec(env, env.reg.model("account.tax"), row.tax)];
  }
  return taxes;
}

/** partner.py:161-175 map_tax, with :105-112 `_compute_tax_map`. */
export async function mapTax(position: Rec | null, taxes: Rec[]): Promise<number[]> {
  const ids = taxes.map((t) => t.origin!);
  if (!position) return ids;
  const taxMap = new Map<number, number[]>();
  for (const dest of await position.rels("tax_ids")) {
    for (const src of await dest.rels("original_tax_ids")) taxMap.set(src.origin!, [...(taxMap.get(src.origin!) ?? []), dest.origin!]);
  }
  const mapped: number[] = [];
  for (const tax of taxes) {
    const positions = (await tax.rels("fiscal_position_ids")).map((p) => p.origin);
    const own = !positions.length || positions.includes(position.origin);
    mapped.push(...(taxMap.get(tax.origin!) ?? (own ? [tax.origin!] : [])));
  }
  return [...new Set(mapped)];
}

/** float_utils.py:143 `float_round(..., rounding_method='DOWN')`. */
function floatRoundDown(value: number, digits: number): number {
  if (value === 0) return 0;
  const factor = 10 ** digits;
  const normalized = digits > 0 ? value * factor : value / 10 ** -digits;
  const epsilon = 2 ** (Math.log2(Math.abs(normalized)) - 50);
  const rounded = Math.trunc(normalized + Math.sign(normalized) * epsilon);
  return digits > 0 ? rounded / factor : rounded * 10 ** -digits;
}

/** uom_uom.py:139-168 `_compute_quantity(qty, to_unit)` with round=True (Product Unit digits). */
export async function uomQuantity(env: Environment, qty: number, from: number | null, to: number | null, method: "UP" | "HALF-UP" | "DOWN" = "UP"): Promise<number> {
  if (!from || !qty) return qty;
  let amount = qty;
  if (from !== to) {
    const rows = (await env.cr.query<{ id: number; factor: number }>("SELECT id, factor::float8 AS factor FROM uom_uom WHERE id = ANY($1::int[])", [[from, to ?? from]])).rows;
    const factor = (id: number): number => rows.find((r) => r.id === id)!.factor;
    amount = qty * factor(from);
    if (to) amount = amount / factor(to);
  }
  if (!to) return amount;
  const digits = (await env.cr.query<{ digits: number }>("SELECT digits FROM decimal_precision WHERE name = 'Product Unit'")).rows[0]!.digits;
  return method === "UP" ? floatRoundUp(amount, digits) : method === "DOWN" ? floatRoundDown(amount, digits) : floatRound(amount, digits);
}

/** uom_uom.py:189-196 `_compute_price`. */
export async function uomPrice(env: Environment, price: number, from: number | null, to: number | null): Promise<number> {
  if (!from || !price || !to || from === to) return price;
  const rows = (await env.cr.query<{ id: number; factor: number }>("SELECT id, factor::float8 AS factor FROM uom_uom WHERE id = ANY($1::int[])", [[from, to]])).rows;
  const factor = (id: number): number => rows.find((r) => r.id === id)!.factor;
  return price * factor(to) / factor(from);
}

async function isGlobalDiscount(rec: Rec): Promise<boolean> {
  const extra = await rec.get("extra_tax_data");
  if (!extra || typeof extra !== "object") return false;
  return String((extra as Record<string, unknown>)["computation_key"] ?? "").startsWith("global_discount,");
}

/** :2213-2224 `_is_product_line`; `_is_delivery` is False without the delivery module. */
async function isProductLine(env: Environment, rec: Rec): Promise<boolean> {
  if ((await rec.get("display_type")) || (await rec.get("is_downpayment"))) return false;
  const product = idOf(await rec.get("product_id"));
  if (!product) return true;
  const company = idOf(await rec.get("company_id"));
  const row = company ? (await env.cr.query<{ p: number | null }>("SELECT sale_discount_product_id AS p FROM res_company WHERE id = $1", [company])).rows[0] : undefined;
  return row?.p !== product;
}

/** res.currency compare_amounts (float_compare with the currency's rounding), `currency` as in `has_manual_price` :762-767. */
async function currencyDiffers(env: Environment, rec: Rec, a: number, b: number): Promise<boolean> {
  let currency = idOf(await rec.get("currency_id"));
  const company = idOf(await rec.get("company_id")) ?? await env.company();
  if (!currency) currency = (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [company])).rows[0]!.c;
  const rounding = Number((await env.cr.query<{ r: string }>("SELECT rounding::text AS r FROM res_currency WHERE id = $1", [currency])).rows[0]!.r);
  const delta = floatRoundRounding(a, rounding) - floatRoundRounding(b, rounding);
  return floatRoundRounding(delta, rounding) !== 0;
}

/** product_product.py:1326-1372 `_price_compute('list_price', uom)` with the no_variant values of the combination that are not on the variant. */
export async function productListPrice(env: Environment, product: Rec, chosen: readonly number[], uom: number | null): Promise<number> {
  const listPrice = Number((await product.get("list_price")) ?? 0);
  const own = new Set(((await product.get("product_template_attribute_value_ids")) as number[] | null) ?? []);
  let noVariantExtra = 0;
  if (chosen.length) {
    const template = idOf(await product.get("product_tmpl_id"));
    const rows = (await env.cr.query<{ id: number; price_extra: number | null; tmpl: number }>(
      "SELECT id, price_extra::float8 AS price_extra, product_tmpl_id AS tmpl FROM product_template_attribute_value WHERE id = ANY($1::int[])", [[...chosen]])).rows;
    for (const r of rows) if (r.price_extra && r.tmpl === template && !own.has(r.id)) noVariantExtra += r.price_extra;
  }
  const extra = Number((await product.get("lst_price")) ?? 0) - listPrice + noVariantExtra;
  return uomPrice(env, listPrice + extra, idOf(await product.get("uom_id")), uom);
}

/**
 * :824-840 `_reset_price_unit` without a pricelist: `_get_display_price` :842-880 of the empty rule, which is
 * product_pricelist_item.py:546-606 `_compute_price` over :608-652 `_compute_base_price` and product_product.py:1343-1372
 * `_price_compute('list_price', uom=...)`, then the fiscal position (account product.py:426-446) and the document tax mode (:456-484).
 */
async function displayUnitPrice(env0: Environment, rec: Rec, product: Rec): Promise<number> {
  if ((await rec.get("product_type")) === "combo") return 0;
  if (await rec.get("combo_item_id")) throw new NotPorted("sale.order.line price of a combo item");
  const company = idOf(await rec.get("company_id")) ?? await env0.company();
  // :824-827 `line.with_company(line.company_id)._get_display_price()` (:842-880): the pricelist rule's price (the
  // empty rule: the list price in the order's currency, src/models/pricelist.ts), the price before the discount when
  // the rule shows its discount
  const env = await withCompany(env0, company);
  const ruleId = await linePricelistItem(env0, rec);
  const args = await pricelistArgs(env, rec, product);
  const pricelistPrice = await rulePrice(env, ruleId, args);
  const price = (await showDiscount(env, ruleId)) ? Math.max(await rulePriceBeforeDiscount(env, ruleId!, args), pricelistPrice) : pricelistPrice;

  const taxes = await taxesOfCompany(env, await product.rels("taxes_id"), company);
  const mode = await rec.get("document_tax_mode");
  const overrides = (await env.cr.query<{ o: string | null; n: boolean }>(
    `SELECT t.price_include_override AS o,
            EXISTS(SELECT 1 FROM account_tax_repartition_line r WHERE r.tax_id = t.id AND r.repartition_type = 'tax' AND r.factor_percent < 0) AS n
       FROM account_tax t WHERE t.id = ANY($1::int[])`, [taxes.map((t) => t.origin)])).rows;
  const included = (o: { o: string | null; n: boolean }): boolean => !o.n && (o.o ? o.o === "tax_included" : mode === "tax_included");
  const position = await orderFiscalPosition(rec);
  if (taxes.length && position) {
    const mapped = await mapTax(position, taxes);
    const same = mapped.length === taxes.length && mapped.every((id, i) => id === taxes[i]!.origin);
    if (!same && overrides.every(included)) throw new NotPorted("sale.order.line price through a fiscal position mapping included taxes (_adapt_price_unit_to_another_taxes)");
  }
  return adaptToDocumentTaxMode(env, product, taxes, mode, price);
}

/**
 * account product.py:456-484 `_adapt_price_unit_to_document_tax_mode` (sale_order_line.py:837-839): the price in the
 * product company's tax mode (an empty company has none, `False`: the taxes' own `price_include`) moved to the
 * document's, through the tax engine's `_get_tax_details` (src/models/account_tax_engine.js, round_globally). Also
 * the invoice line's (product.py:403-408 in `_get_tax_included_unit_price`, src/models/account_move_create.ts).
 */
export async function adaptToDocumentTaxMode(env: Environment, product: Rec, taxes: Rec[], mode: unknown, price: number): Promise<number> {
  const productCompany = idOf(await product.get("company_id"));
  const companyMode = productCompany ? (await env.cr.query<{ m: string | null }>("SELECT account_price_include AS m FROM res_company WHERE id = $1", [productCompany])).rows[0]?.m ?? false : false;
  if ((mode || false) === (companyMode || false)) return price;
  const { taxData } = await import("./account_taxes");
  const { accountTaxHelpers } = await import("./account_tax_engine");
  const results = accountTaxHelpers.get_tax_details(await taxData(env, taxes.map((t) => t.origin!)), price, 1.0, {
    precision_rounding: 0.01, rounding_method: "round_globally", document_tax_mode: companyMode || null,
  });
  let out: number;
  if (mode === "tax_included") {
    out = results.total_included;
    for (const t of results.taxes_data) if (t.tax.price_include_override === "tax_excluded") out -= t.tax_amount;
  } else {
    out = results.total_excluded;
    for (const t of results.taxes_data) if (t.tax.price_include_override === "tax_included") out += t.tax_amount;
  }
  return out;
}

/**
 * sale_stock_margin sale_order_line.py:10-36 `_compute_purchase_price` of a line with valued moves of an average or
 * FIFO product: the delivered quantity at the done moves' unit value (stock_move.py:810-824 `_get_price_unit_delivery`,
 * dropships refuse), the rest at the product's cost, in the line's unit and currency.
 */
async function costedPurchasePrice(env: Environment, rec: Rec, product: Rec): Promise<number> {
  const company = idOf(await rec.get("company_id")) ?? await env.company();
  const cenv = await withCompany(env, company);
  const cproduct = new DbRec(cenv, cenv.reg.model("product.product"), product.origin!);
  const std = Number((await cproduct.get("standard_price")) ?? 0);
  const delivered = Number((await rec.get("qty_delivered")) ?? 0);
  let price: number;
  if (delivered <= 0) price = std;
  else {
    const done = (await env.cr.query<{ id: number }>("SELECT id FROM stock_move WHERE sale_line_id = $1 AND state = 'done' ORDER BY id", [rec.origin])).rows.map((r) => r.id);
    const { priceUnit } = await import("./stock_valuation");
    const fromDelivery = await priceUnit(cenv, done);
    const fromStd = Math.max(Number((await rec.get("product_uom_qty")) ?? 0) - delivered, 0);
    price = (delivered * fromDelivery + fromStd * std) / (delivered + fromStd);
  }
  const cost = await uomPrice(env, price, idOf(await product.get("uom_id")), idOf(await rec.get("product_uom_id")));
  const to = idOf(await rec.get("currency_id"));
  const from = idOf(await cproduct.get("cost_currency_id"));
  if (from && to && from !== to) {
    const order = await rec.rel("order_id");
    const rawDate = order ? await order.get("date_order") : null;
    const date = typeof rawDate === "string" && rawDate ? rawDate : await contextToday(env);
    return convertAmount(env, cost, from, to, company, date, false);
  }
  return cost;
}

/** sale_margin sale_order_line.py:104-126 `_get_subtotal` and `_get_product_qty`. */
async function marginBase(rec: Rec): Promise<{ subtotal: number; qty: number }> {
  const delivered = Number((await rec.get("qty_delivered")) ?? 0), qty = Number((await rec.get("product_uom_qty")) ?? 0);
  if (delivered && !qty) return { subtotal: Number((await rec.get("price_unit")) ?? 0) * delivered, qty: delivered };
  return { subtotal: Number((await rec.get("price_subtotal")) ?? 0), qty };
}

// :1749-1758 `onchange`: the first call of a line passes sale_onchange_first_call to its onchange methods
registerMethod("sale.order.line", "onchange", async (env, ids, args, kwargs, model) => {
  const names = kwargs["field_names"] ?? args[1];
  const first = Array.isArray(names) && names.length === 0;
  return onchangeCall(first ? env.withContext({ ...env.context, sale_onchange_first_call: true }) : env, ids, args, kwargs, model);
}, { apiModel: false });

// :1760-1766
registerOnchange("sale.order.line", "_onchange_product_id", ["product_id"], async (env, rec) => {
  if (env.context["sale_onchange_first_call"] || !(await isProductLine(env, rec))) return;
  const product = await rec.rel("product_id");
  if (!product) { await rec.set("name", ""); return; }
  const price = await displayUnitPrice(env, rec, product);
  await rec.set("price_unit", price);
  await rec.set("technical_price_unit", price);
});
// :1768-1773
registerOnchange("sale.order.line", "_onchange_product_template_id", ["product_template_id"], async (env, rec) => {
  if (env.context["sale_onchange_first_call"] || !(await isProductLine(env, rec))) return;
  if (!(await rec.get("product_template_id"))) { await rec.set("product_id", false); await rec.set("name", ""); }
});

/** sale_order_line.py:1269-1309 `_compute_qty_invoiced` / `_prepare_qty_invoiced` (`_affects_qty_invoiced` is True). */
async function qtyInvoiced(env: Environment, rec: Rec): Promise<number> {
  const accrual = env.context["accrual_entry_date"];
  const accrualDate = typeof accrual === "string" && accrual ? accrual.slice(0, 10) : null;
  const lineUom = idOf(await rec.get("product_uom_id"));
  let qty = 0;
  for (const il of await rec.rels("invoice_lines")) {
    const move = await il.rel("move_id");
    if (!move) continue;
    if (accrualDate) {
      const invDate = await move.get("invoice_date");
      if (typeof invDate !== "string" || !invDate || invDate.slice(0, 10) > accrualDate) continue;
    }
    if ((await move.get("state")) === "cancel" && (await move.get("payment_state")) !== "invoicing_legacy") continue;
    const ilUom = idOf(await il.get("product_uom_id"));
    const rawQ = Number((await il.get("quantity")) ?? 0);
    const q = ilUom !== null && lineUom !== null && ilUom !== lineUom ? await uomQuantityRaw(env, rawQ, ilUom, lineUom) : rawQ;
    const type = await move.get("move_type");
    if (type === "out_invoice") qty += q;
    else if (type === "out_refund") qty -= q;
  }
  return qty;
}

/** sale_order_line.py:1434-1465 `_compute_untaxed_amount_invoiced` in the line's currency. */
async function untaxedAmountInvoiced(env: Environment, rec: Rec): Promise<number> {
  const accrual = env.context["accrual_entry_date"];
  const accrualDate = typeof accrual === "string" && accrual ? accrual.slice(0, 10) : null;
  const currency = idOf(await rec.get("currency_id"));
  const company = idOf(await rec.get("company_id")) ?? await env.company();
  let amount = 0;
  for (const il of await rec.rels("invoice_lines")) {
    const move = await il.rel("move_id");
    if (!move) continue;
    const rawInvDate = await move.get("invoice_date");
    const invDate = typeof rawInvDate === "string" && rawInvDate ? rawInvDate.slice(0, 10) : null;
    if (accrualDate && (!invDate || invDate > accrualDate)) continue;
    if ((await move.get("state")) !== "posted" && (await move.get("payment_state")) !== "invoicing_legacy") continue;
    const ilCur = idOf(await il.get("currency_id"));
    let sub = Number((await il.get("price_subtotal")) ?? 0);
    if (ilCur !== null && currency !== null && ilCur !== currency) {
      sub = await convertAmount(env, sub, ilCur, currency, company, invDate ?? await contextToday(env), true);
    }
    const type = await move.get("move_type");
    if (type === "out_invoice") amount += sub;
    else if (type === "out_refund") amount -= sub;
  }
  return amount;
}

/**
 * sale_order_line.py:1140-1145 `_compute_qty_delivered` with sale_stock sale_order_line.py:184-209 `_prepare_qty_delivered`
 * and :318-360 `_get_outgoing_incoming_moves` (strict): the done moves to an outgoing location (a customer location or
 * one inside the inter-company transit, stock_location.py:464-470) less the refunded returns. Analytic, milestone and
 * re-invoiced lines refuse.
 */
async function qtyDelivered(env: Environment, rec: Rec): Promise<unknown> {
  if (rec.origin === null || rec.id === null) return zeroOnNewLine(rec, "qty_delivered");
  const method = await rec.get("qty_delivered_method");
  const product = await rec.rel("product_id");
  if (method === "manual") return Number((await rec.prev("qty_delivered")) ?? 0) ? rec.prev("qty_delivered") : 0;
  if (method !== "stock_move") return zeroOnNewLine(rec, "qty_delivered");
  if (product && (await product.get("reinvoice_policy")) && (await product.get("reinvoice_policy")) !== "no") throw new NotPorted("sale.order.line.qty_delivered of a re-invoiced product (analytic)");
  if (env.context["accrual_entry_date"]) throw new NotPorted("sale.order.line.qty_delivered at an accrual date");
  const moveRecs = await rec.rels("move_ids");
  const productId = product?.origin ?? null;
  const lineUom = typeof (await rec.get("product_uom_id")) === "number" ? (await rec.get("product_uom_id")) as number : null;
  const demand = Number((await rec.get("product_uom_qty")) ?? 0);
  let interPrefix: string | null | undefined;
  // stock_location.py:464-470 `_is_outgoing`: a customer location, or one under `stock.stock_location_inter_company`
  // (`_child_of`: its parent_path starts with the inter-company location's)
  const outgoingLoc = async (loc: Rec | null, usage: string): Promise<boolean> => {
    if (usage === "customer") return true;
    if (interPrefix === undefined) {
      interPrefix = (await env.cr.query<{ p: string | null }>(
        `SELECT l.parent_path AS p FROM stock_location l JOIN ir_model_data d ON d.res_id = l.id
          WHERE d.module = 'stock' AND d.name = 'stock_location_inter_company' AND d.model = 'stock.location' LIMIT 1`)).rows[0]?.p ?? null;
    }
    if (interPrefix === null) throw new NotPorted("stock.location._is_outgoing without stock.stock_location_inter_company");
    return String((await loc?.get("parent_path")) ?? "").startsWith(interPrefix);
  };
  let qty = 0;
  for (const m of moveRecs) {
    if (idOf(await m.get("product_id")) !== productId) continue;
    const dstLoc = await m.rel("location_dest_id");
    const dst = String((await dstLoc?.get("usage")) ?? "");
    if (dst === "inventory") continue;
    const state = String((await m.get("state")) ?? "");
    if (state === "cancel") continue;
    const srcLoc = await m.rel("location_id");
    const src = String((await srcLoc?.get("usage")) ?? "");
    // stock_account stock_move.py:684-712: a transit location without company counts as a partner's
    const srcPartner = src === "transit" && idOf(await srcLoc?.get("company_id")) === null;
    const dstPartner = dst === "transit" && idOf(await dstLoc?.get("company_id")) === null;
    const dropshipped = (src === "supplier" || srcPartner) && (dst === "customer" || dstPartner);
    const dropshippedReturned = (src === "customer" || srcPartner) && (dst === "supplier" || dstPartner);
    // stock stock_move.py:2916-2920 with stock_account :706-707 `_is_incoming`
    const incoming = (["customer", "supplier"].includes(src) || srcPartner) && !dropshipped;
    const returned = idOf(await m.get("origin_returned_move_id"));
    const toRefund = Boolean(await m.get("to_refund"));
    const quantity = Number((await m.get("quantity")) ?? 0);
    const uomId = idOf(await m.get("uom_id"));
    // sale_stock sale_order_line.py:345-358 `_get_outgoing_incoming_moves(strict=True)`
    if (!dropshippedReturned && await outgoingLoc(dstLoc, dst)) {
      if (returned && !toRefund) continue;
      if (state !== "done") continue;
      qty += await uomQuantity(env, quantity, uomId, lineUom, "HALF-UP");
    } else if (toRefund && (incoming || await outgoingLoc(srcLoc, src))) {
      if (state !== "done") continue;
      // :198-207: an incoming move that is no return (no returned move, not from an outgoing location, no return
      // transfer) is a dropship receipt and does not count
      if (!returned && demand > 0 && !(await outgoingLoc(srcLoc, src))) {
        const picking = await m.rel("picking_id");
        if (!(picking ? idOf(await picking.get("return_id")) : null)) continue;
      }
      qty -= await uomQuantity(env, quantity, uomId, lineUom, "HALF-UP");
    }
  }
  return qty;
}

/** The invoiced and delivered quantities of a line without invoice lines and without moves; other stored lines refuse. */
async function zeroOnNewLine(rec: Rec, field: string): Promise<unknown> {
  if (rec.origin === null) return 0;
  if (((await rec.get("invoice_lines")) as unknown[] | null)?.length || ((await rec.get("move_ids")) as unknown[] | null)?.length) {
    throw new NotPorted(`sale.order.line.${field} recompute of a stored line with invoices or moves`);
  }
  return field === "qty_delivered" && (await rec.get("qty_delivered_method")) === "manual" ? rec.prev(field) : 0;
}

/** sale_order_line.py:666-674 `_inverse_label`: the name is the label without the product's display name. */
async function nameFromLabel(env: Environment, product: number | null, label: unknown): Promise<unknown> {
  if (product === null || !label) return label ?? null;
  const display = (await env.model("product.product").displayName([product])).get(product) ?? "";
  const text = String(label);
  const rest = text.startsWith(display) ? text.slice(display.length) : text;
  return rest.startsWith("\n") ? rest.slice(1) : rest;
}
// :1775-1780 `_onchange_label`: the inverse, at once on the new line
registerOnchange("sale.order.line", "_onchange_label", ["label"], async (env, rec) => {
  await rec.set("name", await nameFromLabel(env, idOf(await rec.get("product_id")), await rec.get("label")));
});
registerOverrides("sale.order.line", {
  inverse: {
    // sale_stock sale_order_line.py:265-269 _inverse_customer_lead: the deadline of the moves of a confirmed line
    customer_lead: async (env, ids) => {
      const rows = (await env.cr.query<{ id: number }>(
        `SELECT l.id FROM sale_order_line l JOIN sale_order o ON o.id = l.order_id JOIN stock_move m ON m.sale_line_id = l.id
          WHERE l.id = ANY($1::int[]) AND l.state = 'sale' AND o.commitment_date IS NULL LIMIT 1`, [[...ids]])).rows;
      if (rows.length) throw new NotPorted("sale.order.line customer_lead on a confirmed line with moves");
    },
  },
  create: async (env, valsList, next) => {
    for (const vals of valsList) {
      // sale_order_line.py:1785-1798: a section/note line has no quantity (the table's CHECK accountable_required_fields);
      // `default_get(["display_type"])` is the context's default_display_type (the field has no other default)
      if (vals["display_type"] || env.context["default_display_type"]) vals["product_uom_qty"] = 0;
      if ("technical_price_unit" in vals && !("price_unit" in vals)) delete vals["technical_price_unit"];
      if (env.context["import_file"] && vals["combo_item_id"]) throw new NotPorted("sale.order.line import with combo_item_id");
      if (!("label" in vals)) continue;
      vals["name"] = await nameFromLabel(env, idOf(vals["product_id"]), vals["label"]);
      delete vals["label"];
    }
    // the orders' tracking (amounts) is one message per order at precommit (mail_track_mixin.py:133), as in the write
    // below; before round 11 a line created through RPC logged "Untaxed Amount" and "Total" in two messages. The order
    // is the line's after the create: the given one or the default's (default_order_id, models.py:1625; rådet runda 13)
    const dflt = valsList.some((v) => !("order_id" in v)) ? idOf((await defaultGet(env, "sale.order.line", ["order_id"]))["order_id"]) : null;
    const orders = [...new Set(valsList.map((v) => ("order_id" in v ? idOf(v["order_id"]) : dflt)).filter((o): o is number => o !== null))].sort((a, b) => a - b);
    if (!orders.length) return launchCreated(env, await afterLineCreate(env, await next(env, valsList)));
    const { trackPrepare } = await import("../mail/tracking");
    const { closeTrackingScope } = await import("../mail/write_hooks");
    await trackPrepare(env, "sale.order", orders);
    const ids = await launchCreated(env, await afterLineCreate(env, await next(env, valsList)));
    await closeTrackingScope(env, "sale.order");
    return ids;
  },
  write: async (env, ids, vals0, next) => {
    let vals = vals0;
    // sale_stock sale_order_line.py:247-256 + sale_project sale_order_line.py:143-158
    let launch: number[] = [];
    let zeroServiceOrders: { o: number; c: number }[] = [];
    const hasQty = "product_uom_qty" in vals;
    const newQty = hasQty ? Number(plainNumber(vals["product_uom_qty"]) || 0) : 0;
    if (hasQty) {
      const before = (await env.cr.query<{ id: number; order_id: number; company_id: number; state: string | null; is_expense: boolean | null; is_service: boolean | null; qty: number }>(
        "SELECT id, order_id, company_id, state, is_expense, is_service, COALESCE(product_uom_qty, 0)::float8 AS qty FROM sale_order_line WHERE id = ANY($1::int[])", [[...ids]])).rows;
      launch = ids.filter((id) => before.some((r) => r.id === id && r.state === "sale" && !r.is_expense));
      if (newQty > 0) {
        const seen = new Set<number>();
        for (const r of before) {
          if (r.qty === 0 && r.is_service && r.state === "sale" && !r.is_expense && !seen.has(r.order_id)) {
            seen.add(r.order_id);
            zeroServiceOrders.push({ o: r.order_id, c: r.company_id });
          }
        }
      }
    }
    // the orders' tracking (amounts) is logged once, after the procurement's notes, as at Odoo's precommit
    // (mail_track_mixin.py:133): a scope over the orders of the lines
    const orders0 = (await env.cr.query<{ o: number }>("SELECT DISTINCT order_id AS o FROM sale_order_line WHERE id = ANY($1::int[]) ORDER BY 1", [[...ids]])).rows.map((r) => r.o);
    const target = idOf(vals["order_id"]);
    if (target !== null && !orders0.includes(target)) orders0.push(target);
    const { trackPrepare } = await import("../mail/tracking");
    const { closeTrackingScope } = await import("../mail/write_hooks");
    await trackPrepare(env, "sale.order", orders0);
    vals = await saleLineWriteChecks(env, ids, vals);
    if ("label" in vals) {
      const { label, ...rest } = vals;
      await next(env, ids, rest);
      const rows = await env.model("sale.order.line").read([...ids], ["product_id"], "");
      for (const row of rows) await next(env, [Number(row["id"])], { name: await nameFromLabel(env, idOf(row["product_id"]), label) });
    } else await next(env, ids, vals);
    if (launch.length && !env.context["skip_procurement"]) {
      const { launchStockRule, orderRow } = await import("./sale_confirm");
      const orders = (await env.cr.query<{ o: number; c: number }>(
        "SELECT DISTINCT order_id AS o, company_id AS c FROM sale_order_line WHERE id = ANY($1::int[]) ORDER BY order_id", [launch])).rows;
      for (const { o, c } of orders) {
        const order = await orderRow(env, o);
        await launchStockRule((await withCompany(env, c)).sudo(), order, launch);
      }
    }
    if (zeroServiceOrders.length) {
      const { timesheetServiceGeneration } = await import("./sale_service");
      for (const { o, c } of zeroServiceOrders) {
        await timesheetServiceGeneration((await withCompany(env, c)).sudo(), o);
      }
    }
    await closeTrackingScope(env, "sale.order");
    // sale_project sale_order_line.py:153-157: changing ordered qty updates allocated_hours on linked service task
    if (hasQty && !env.context["no_update_allocated_hours"] && env.reg.model("sale.order.line").fields.has("task_id")) {
      const taskLines = (await env.cr.query<{ id: number; task_id: number; qty: number }>(
        `SELECT l.id, l.task_id, COALESCE(l.product_uom_qty, 0)::float8 AS qty
           FROM sale_order_line l JOIN product_product p ON p.id = l.product_id JOIN product_template t ON t.id = p.product_tmpl_id
          WHERE l.id = ANY($1::int[]) AND l.task_id IS NOT NULL AND t.type = 'service'`, [[...ids]])).rows;
      const byId = new Map(taskLines.map((r) => [r.id, r]));
      const toWrite = ids.map((id) => byId.get(id)).filter((l): l is NonNullable<typeof l> => l !== undefined);
      if (toWrite.length) {
        const { afterTracking, trackDepth } = await import("../mail/tracking");
        const deferTaskTrack = trackDepth(env.cr, "sale.order") > 0;
        if (deferTaskTrack) await trackPrepare(env, "project.task", toWrite.map((l) => l.task_id));
        for (const l of toWrite) await write(env, "project.task", [l.task_id], { allocated_hours: l.qty });
        if (deferTaskTrack) afterTracking(env.cr, "sale.order", () => closeTrackingScope(env, "project.task"));
      }
    }
  },
});

/**
 * sale_order_line.py:1805-1822, after super().create: a line linked through `linked_virtual_id` (the client's id of a
 * line not yet saved, `_get_linked_line` :2248-2265) gets `linked_line_id` (a given `linked_line_id` is written again
 * with the same value: no change); then, unless `sale_no_log_for_new_lines`, every product line of a confirmed order is
 * logged on the order, "Extra line with <product>" (message_post, a note, in the user's language).
 */
async function afterLineCreate(env: Environment, ids: number[]): Promise<number[]> {
  if (!ids.length) return ids;
  const rows = (await env.cr.query<{ id: number; order_id: number; display_type: string | null; state: string | null; product_id: number | null; name: string | null;
    linked_line_id: number | null; linked_virtual_id: string | null }>(
    `SELECT id, order_id, display_type, state, product_id, name, linked_line_id, linked_virtual_id FROM sale_order_line WHERE id = ANY($1::int[])`, [ids])).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    const r = byId.get(id);
    if (!r || r.linked_line_id !== null || !r.linked_virtual_id) continue;
    const linked = (await env.cr.query<{ id: number }>("SELECT id FROM sale_order_line WHERE order_id = $1 AND virtual_id = $2", [r.order_id, r.linked_virtual_id])).rows;
    // `.ensure_one()`: no line or several with that virtual id raise ValueError in Odoo
    if (linked.length !== 1) throw new NotPorted(`sale.order.line linked_virtual_id matching ${linked.length} lines`);
    await write(env, "sale.order.line", [id], { linked_line_id: linked[0]!.id });
  }
  if (env.context["sale_no_log_for_new_lines"] || env.context["skip_intercompany_sync"]) return ids;
  const { postNote } = await import("./stock_engine");
  for (const id of ids) {
    const r = byId.get(id);
    if (!r || r.display_type || r.state !== "sale") continue;
    const shown = (r.product_id ? (await env.model("product.product").displayName([r.product_id])).get(r.product_id) : "") || r.name || "";
    await postNote(env, "sale.order", r.order_id, `<p>${escHtml(pyPercent(translate(env, "Extra line with %s", "sale"), [shown]))}</p>`);
  }
  return ids;
}

/**
 * sale_stock sale_order_line.py:239-245 create: the new lines of a confirmed order (`state == 'sale'`) with a goods
 * product get their procurement (`_action_launch_stock_rule`, which skips locked orders, other product types and the
 * skip_procurement context, :383-390), per order in the line's company as the write's launch below. A line on a draft
 * order gets it at the order's confirmation.
 */
async function launchCreated(env: Environment, ids: number[]): Promise<number[]> {
  if (!ids.length || env.context["skip_procurement"]) return ids;
  const rows = (await env.cr.query<{ id: number; o: number; c: number }>(
    `SELECT l.id, l.order_id AS o, l.company_id AS c FROM sale_order_line l JOIN product_product p ON p.id = l.product_id
       JOIN product_template t ON t.id = p.product_tmpl_id
      WHERE l.id = ANY($1::int[]) AND l.state = 'sale' AND t.type = 'consu' ORDER BY l.order_id, l.id`, [ids])).rows;
  if (!rows.length) return ids;
  const { launchStockRule, orderRow } = await import("./sale_confirm");
  const orders = [...new Map(rows.map((r) => [r.o, r.c] as const))];
  for (const [o, c] of orders) {
    const order = await orderRow(env, o);
    await launchStockRule((await withCompany(env, c)).sudo(), order, rows.filter((r) => r.o === o).map((r) => r.id));
  }
  return ids;
}

/** Python's str() of a written number: an int as such, a float as repr (6 -> "6", 6.0 -> "6.0"). */
function pyNumberStr(v: unknown): string {
  if (isPyFloat(v)) return pyFloatReprSimple(v.float);
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatReprSimple(v);
  if (v === false || v === null || v === undefined) return "False";
  throw new NotPorted(`str() of ${JSON.stringify(v)} in the ordered-quantity note`);
}

const escHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;").replace(/'/g, "&#39;");

/**
 * sale_order_line.py:1831-1897 write (before super): the display type and product guards, `_update_line_quantity`
 * (:1918-1942, with sale_stock's check :418-423) on the confirmed lines whose quantity changes, the locked-order guard.
 * sale_project's and sale_purchase's writes of a quantity (allocated hours of a task, subcontracted purchase lines) refuse.
 */
async function saleLineWriteChecks(env: Environment, ids: readonly number[], vals: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!ids.length) return vals;
  const rows = (await env.cr.query<{ id: number; order_id: number; display_type: string | null; product_id: number | null; state: string | null; qty: number; delivered: number;
    invoiced: number; type: string | null; locked: boolean | null; is_downpayment: boolean | null; task_id: number | null; service_tracking: string | null }>(
    `SELECT l.id, l.order_id, l.display_type, l.product_id, l.state, COALESCE(l.product_uom_qty, 0)::float8 AS qty, COALESCE(l.qty_delivered, 0)::float8 AS delivered,
            COALESCE(l.qty_invoiced, 0)::float8 AS invoiced, t.type, o.locked, l.is_downpayment, ${env.reg.model("sale.order.line").fields.has("task_id") ? "l.task_id" : "NULL::int"} AS task_id,
            t.service_tracking
       FROM sale_order_line l JOIN sale_order o ON o.id = l.order_id LEFT JOIN product_product p ON p.id = l.product_id LEFT JOIN product_template t ON t.id = p.product_tmpl_id
      WHERE l.id = ANY($1::int[])`, [[...ids]])).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const lines = ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => r !== undefined);
  if ("display_type" in vals) {
    const t = vals["display_type"] || null;
    if (lines.some((l) => (l.display_type ?? null) !== t && !(l.display_type === "line_subsection" && t === "line_section"))) {
      throw new UserError(translate(env, "You cannot change the type of a sale order line. Instead you should delete the current line and create a new line of the proper type.", "sale"));
    }
  }
  if ("product_id" in vals) {
    const changed = lines.filter((l) => l.product_id !== idOf(vals["product_id"]));
    if (changed.length) {
      const updatable = await env.sudo().model("sale.order.line").read(changed.map((l) => l.id), ["product_updatable"], "");
      if (updatable.some((r) => !r["product_updatable"])) throw new UserError(translate(env, "You cannot modify the product of this order line.", "sale"));
    }
  }
  if ("product_uom_qty" in vals) {
    const raw = vals["product_uom_qty"];
    const qty = Number(plainNumber(raw) || 0);
    const digits = (await env.cr.query<{ d: number }>("SELECT digits AS d FROM decimal_precision WHERE name = 'Product Unit'")).rows[0]?.d ?? 2;
    if (lines.some((l) => l.service_tracking === "subcontract")) throw new NotPorted("sale_purchase sale.order.line write of product_uom_qty of a subcontracted service");
    const changed = env.context["skip_intercompany_sync"] ? [] : lines.filter((l) => l.state === "sale" && floatRound(l.qty, digits) !== floatRound(qty, digits));
    if (changed.length) {
      // sale_stock :418-423: not below what was delivered of the goods
      const goods = changed.filter((l) => l.type === "consu");
      if (goods.length && floatRound(qty, digits) < floatRound(Math.max(...goods.map((l) => l.delivered)), digits)) {
        throw new UserError(translate(env, "The ordered quantity of a sale order line cannot be decreased below the amount already delivered. Instead, create a return in your inventory.", "sale_stock"));
      }
      // the texts are `self.env._(...)` of sale's frame (sale_order_line.py:1922-1937), in the writer's language
      const T = (source: string): string => translate(env, source, "sale");
      const orders: number[] = [];
      for (const l of changed) if (!orders.includes(l.order_id)) orders.push(l.order_id);
      const { postNote } = await import("./stock_engine");
      for (const order of orders) {
        let msg = `<b>${escHtml(T("The ordered quantity has been updated."))}</b><ul>`;
        for (const l of changed.filter((x) => x.order_id === order)) {
          if ("product_id" in vals && idOf(vals["product_id"]) !== l.product_id) continue;
          const name = l.product_id ? (await env.model("product.product").displayName([l.product_id])).get(l.product_id) ?? "" : "";
          msg += `<li> ${escHtml(name)}: <br>`;
          // a str added to the Markup is escaped whole (`->` becomes `-&gt;`)
          msg += `${escHtml(pyPercent(T("Ordered Quantity: %(old_qty)s -> %(new_qty)s"), { old_qty: pyFloatReprSimple(l.qty), new_qty: pyNumberStr(raw) }))}<br>`;
          if (l.type === "consu") msg += `${escHtml(pyPercent(T("Delivered Quantity: %s"), [pyFloatReprSimple(l.delivered)]))}<br>`;
          // the `<li>` is left open by the Markup; html_sanitize (lxml) closes it before the next one or `</ul>`
          msg += `${escHtml(pyPercent(T("Invoiced Quantity: %s"), [pyFloatReprSimple(l.invoiced)]))}<br></li>`;
        }
        msg += "</ul>";
        await postNote(env, "sale.order", order, msg);
      }
    }
  }
  // :1863-1871 a technical price without its price is not written (the client did not send the read-only price)
  if ("technical_price_unit" in vals && !("price_unit" in vals) && !env.context["sale_write_from_compute"]) {
    const { technical_price_unit: _drop, ...rest } = vals;
    vals = rest;
  }
  // :1868-1895 a locked order: its protected fields cannot change (the down payment's name may)
  const protectedFields = ["product_id", "name", "price_unit", "product_uom_id", "product_uom_qty", "tax_ids", "analytic_distribution", "discount", "order_id"];
  if (lines.some((l) => l.locked) && protectedFields.some((f) => f in vals)) {
    const modified = protectedFields.filter((f) => f in vals && !(f === "name" && lines.every((l) => l.is_downpayment)));
    const fields = (await env.cr.query<{ d: string }>(
      "SELECT COALESCE(field_description->>$2, field_description->>'en_US') AS d FROM ir_model_fields WHERE model = 'sale.order.line' AND name = ANY($1::text[]) ORDER BY name, id",
      [modified, env.lang ?? "en_US"])).rows;
    if (fields.length) {
      throw new UserError(translate(env, "It is forbidden to modify the following fields in a locked order:\n%s", "sale").replace("%s", fields.map((f) => f.d).join("\n")));
    }
  }
  return vals;
}

/** res_partner.py `_compute_is_public`: one of the partner's users (archived included) is a public user. */
async function partnerIsPublic(env: Environment, partner: Rec): Promise<boolean> {
  const id = partner.origin;
  if (id === null) return false;
  return (await env.cr.query(
    `SELECT 1 FROM res_users u JOIN res_groups_users_rel r ON r.uid = u.id JOIN ir_model_data d ON d.model = 'res.groups' AND d.res_id = r.gid
      WHERE u.partner_id = $1 AND d.module = 'base' AND d.name = 'group_public' LIMIT 1`, [id])).rows.length > 0;
}

registerRecordCompute("sale.order.line", {
  // sale_order_line.py:521-536 _compute_name with :538-568 `_get_sale_order_line_multiline_description_sale`
  name: async (env, rec) => {
    const product = await rec.rel("product_id");
    if (!product) {
      if (await rec.get("is_downpayment")) throw new NotPorted("sale.order.line name of a down payment on a new line");
      return rec.prev("name");
    }
    const order = await rec.rel("order_id");
    const partner = order ? await order.rel("partner_id") : null;
    // :527-529 `line.order_id._get_lang()` (sale_order.py:2789-2795): the customer's language unless the customer is
    // public, else the environment's; the description is read in it
    let lang = env.lang ?? "en_US";
    const partnerLang = partner ? await partner.get("lang") : null;
    if (partner && typeof partnerLang === "string" && partnerLang && !(await partnerIsPublic(env, partner))) lang = partnerLang;
    const parts: string[] = [];
    let description: unknown;
    if (lang === (env.lang ?? "en_US")) description = await product.get("description_sale");
    else {
      // a translated field in another language: its value in that language, else en_US (fields.py _get_translation)
      const pid = product.origin;
      if (pid === null) throw new NotPorted("sale.order.line name in the customer's language for a new product");
      description = (await env.cr.query<{ d: string | null }>(
        `SELECT COALESCE(t.description_sale->>$2, t.description_sale->>'en_US') AS d FROM product_product p JOIN product_template t ON t.id = p.product_tmpl_id WHERE p.id = $1`,
        [pid, lang])).rows[0]?.d ?? null;
    }
    if (description) parts.push(String(description));
    const variants = await descriptionVariants(env, rec);
    if (variants && lang !== (env.lang ?? "en_US")) throw new NotPorted("sale.order.line variant description in the customer's language");
    if (variants) parts.push(variants);
    if (await rec.get("linked_line_id")) {
      if (!(await rec.get("combo_item_id"))) throw new NotPorted("sale.order.line name of an optional product line");
    }
    return parts.join("\n");
  },
  // a new line has no invoice lines, deliveries or analytic lines yet (:1269-1296, :1139-1145, :1433-1450)
  qty_invoiced: async (env, rec) => qtyInvoiced(env, rec),
  qty_delivered: async (env, rec) => qtyDelivered(env, rec),
  untaxed_amount_invoiced: async (env, rec) => untaxedAmountInvoiced(env, rec),
  // :1094-1097 _compute_customer_lead (`sale_delay` is not company dependent)
  customer_lead: async (_env, rec) => {
    const product = await rec.rel("product_id");
    return product ? Number((await product.get("sale_delay")) ?? 0) : 0;
  },
  // :1099-1127 with sale_stock sale_order_line.py:177-178 (consumables through stock moves)
  qty_delivered_method: async (_env, rec) => {
    if (await rec.get("is_expense")) return "analytic";
    const product = await rec.rel("product_id");
    let method = "manual";
    if (product) {
      const type = await product.get("type");
      if (type === "service") method = String((await product.get("service_type")) ?? "");
      else if (type === "consu") method = "stock_move";
      if (method === "manual" && (await product.get("reinvoice_policy")) !== "no") method = "analytic";
    }
    return method;
  },
  // :1080-1092
  price_reduce_taxexcl: async (_env, rec) => {
    const qty = Number((await rec.get("product_uom_qty")) ?? 0);
    return qty ? Number((await rec.get("price_subtotal")) ?? 0) / qty : 0;
  },
  price_reduce_taxinc: async (_env, rec) => {
    const qty = Number((await rec.get("product_uom_qty")) ?? 0);
    return qty ? Number((await rec.get("price_total")) ?? 0) / qty : 0;
  },
  // :748-758 _compute_pricelist_item_id
  pricelist_item_id: async (env, rec) => linePricelistItem(env, rec),
  // :707-742 _compute_tax_ids
  tax_ids: async (env, rec) => {
    const taxes = await lineTaxesToMap(env, rec);
    if (!taxes.length) return [];
    return mapTax(await orderFiscalPosition(rec), taxes);
  },
  // :760-797 _compute_price_unit
  price_unit: async (env, rec) => {
    const previous = Number((await rec.prev("price_unit")) ?? 0);
    if (!(await rec.get("order_id")) || (await rec.get("is_downpayment")) || (await isGlobalDiscount(rec))) return previous;
    if (Number((await rec.get("qty_invoiced")) ?? 0) > 0) return previous;
    const product = await rec.rel("product_id");
    if (product && (await rec.get("is_expense")) && (await product.get("reinvoice_policy")) === "cost") return previous;
    const manual = await currencyDiffers(env, rec, Number((await rec.get("technical_price_unit")) ?? 0), previous);
    const force = Boolean(env.context["force_price_recomputation"]);
    if (manual && (!force || !product)) return previous;
    const price = product && (await rec.get("product_uom_id")) ? await displayUnitPrice(env, rec, product) : 0;
    if (rec instanceof NewRec) rec.put("technical_price_unit", price);
    else if (Number((await rec.get("technical_price_unit")) ?? 0) !== price) {
      // :838 `line.update({"price_unit": price_unit, "technical_price_unit": price_unit})`: the compute assigns both, the
      // flush writes them together (the queue writes price_unit with the record's write_uid/write_date)
      await writeColumns(env, env.reg.model("sale.order.line"), [[rec.id!, { technical_price_unit: price }]], false, true);
    }
    return price;
  },
  // :673-682 _compute_product_uom_id, with product_template.py `_default_uom_id`
  product_uom_id: async (env, rec) => {
    if (await rec.get("display_type")) return null;
    const product = await rec.rel("product_id");
    if (product) return idOf(await product.get("uom_id"));
    if (await rec.get("is_downpayment")) return null;
    return env.reg.xmlid(env.cr, "uom.product_uom_unit");
  },
  // :666-670 _compute_product_uom_qty
  product_uom_qty: async (_env, rec) => ((await rec.get("display_type")) ? 0 : rec.prev("product_uom_qty")),
  // sale_stock sale_order_line.py:26-46 _compute_warehouse_id
  warehouse_id: async (env, rec) => {
    const order = await rec.rel("order_id");
    const orderWh = order ? idOf(await order.get("warehouse_id")) : null;
    const routes = (((await rec.get("route_ids")) as unknown[] | null) ?? []).map(idOf).filter((x): x is number => x !== null);
    if (routes.length) {
      const shipping = order ? await order.rel("partner_shipping_id") : null;
      const custLoc = shipping ? idOf(await shipping.get("property_stock_customer")) : null;
      if (custLoc !== null) {
        const rules = (await env.cr.query<{ wh: number | null }>(
          `SELECT ls.warehouse_id AS wh
             FROM stock_rule r
             JOIN stock_route rt ON rt.id = r.route_id
             LEFT JOIN stock_location ls ON ls.id = r.location_src_id
            WHERE r.active AND r.route_id = ANY($1::int[]) AND r.location_dest_id = $2 AND r.action != 'push'
            ORDER BY (CASE WHEN ls.warehouse_id IS NULL OR ls.warehouse_id = $3 THEN 0 ELSE 1 END), rt.sequence, r.sequence, r.id
            LIMIT 1`,
          [routes, custLoc, orderWh])).rows;
        if (rules.length) return rules[0]!.wh ?? null;
      }
    }
    return orderWh;
  },
  // sale_project sale_order_line.py `_compute_is_service`
  is_service: async (_env, rec) => (await rec.get("product_type")) === "service",
  analytic_distribution: saleLineAnalyticDistribution,
  // :1003-1035 _compute_discount
  discount: async (env, rec) => {
    const product = await rec.rel("product_id");
    const reset = !product || Boolean(await rec.get("display_type"));
    const pricelist = await linePricelist(rec);
    if (!(pricelist !== null && (await discountFeature(env)) && (await rec.get("product_uom_id")))) return reset ? 0 : rec.prev("discount");
    if (await rec.get("combo_item_id")) throw new NotPorted("sale.order.line discount of a combo item (_get_linked_line)");
    const ruleId = await linePricelistItem(env, rec);
    if (!product || !(await showDiscount(env, ruleId))) return 0;
    const cenv = await withCompany(env, idOf(await rec.get("company_id")) ?? await env.company());
    const args = await pricelistArgs(cenv, rec, product);
    const pricelistPrice = await rulePrice(cenv, ruleId, args);
    const base = await rulePriceBeforeDiscount(cenv, ruleId!, args);
    if (base === 0) return 0;
    const discount = (base - pricelistPrice) / base * 100;
    // only a negative discount of a negative price is shown, a surcharge otherwise is not
    return (discount > 0 && base > 0) || (discount < 0 && base < 0) ? discount : 0;
  },
  // sale_margin sale_order_line.py:41-57 _compute_purchase_price, with sale_stock_margin sale_order_line.py:10-36: a line
  // with confirmed moves (`has_valued_move_ids`) keeps its cost under the standard cost method
  purchase_price: async (env, rec) => {
    // the moves of `_action_launch_stock_rule` are created in draft and confirmed in the same call: Odoo computes this
    // field at flush, after `_action_confirm`, when they are valued (src/models/sale_confirm.ts sets the key)
    if (rec.id !== null && env.context["sale_stock_launching_moves"]) {
      const product = await rec.rel("product_id");
      const categ = product ? await product.rel("categ_id") : null;
      const method = categ ? await categ.get("property_cost_method") : null;
      if (product && categ && method !== "standard") return costedPurchasePrice(env, rec, product);
      if (!(!Number((await rec.get("product_uom_qty")) ?? 0) && Number((await rec.get("qty_delivered")) ?? 0))) return rec.prev("purchase_price");
    }
    if (rec.id !== null) {
      let valued = false;
      if (rec.def.fields.has("move_ids")) {
        for (const m of await rec.rels("move_ids")) {
          const st = await m.get("state");
          if (st !== "cancel" && st !== "draft") { valued = true; break; }
        }
      }
      if (valued) {
        const product = await rec.rel("product_id");
        const categ = product ? await product.rel("categ_id") : null;
        const method = categ ? await categ.get("property_cost_method") : null;
        if (product && categ && method !== "standard") return costedPurchasePrice(env, rec, product);
        if (product && categ) return rec.prev("purchase_price");
        // `elif not line.product_uom_qty and line.qty_delivered`: to super; otherwise kept
        if (!(!Number((await rec.get("product_uom_qty")) ?? 0) && Number((await rec.get("qty_delivered")) ?? 0))) return rec.prev("purchase_price");
      }
    }
    if (!(await isProductLine(env, rec))) return 0;
    const product = await rec.rel("product_id");
    if (!product) return rec.prev("purchase_price");
    const lineCompany = idOf(await rec.get("company_id")) ?? await env.company();
    const envCompany = await env.company();
    const cproduct = lineCompany !== envCompany && product.origin !== null
      ? new DbRec(await withCompany(env, lineCompany), env.reg.model("product.product"), product.origin)
      : product;
    const cost = await uomPrice(env, Number((await cproduct.get("standard_price")) ?? 0), idOf(await cproduct.get("uom_id")), idOf(await rec.get("product_uom_id")));
    const to = idOf(await rec.get("currency_id"));
    const from = idOf(await cproduct.get("cost_currency_id"));
    // :2186-2207 `_convert_to_sol_currency`: `_convert(round=False)` at the order date for the line's company
    if (from && to && from !== to) {
      const order = await rec.rel("order_id");
      const rawDate = order ? await order.get("date_order") : null;
      const date = typeof rawDate === "string" && rawDate ? rawDate : await contextToday(env);
      return convertAmount(env, cost, from, to, lineCompany, date, false);
    }
    return cost;
  },
  // sale_margin sale_order_line.py:59-63 _compute_margin
  margin: async (_env, rec) => {
    const { subtotal, qty } = await marginBase(rec);
    return subtotal - Number((await rec.get("purchase_price")) ?? 0) * qty;
  },
  // :65-71 _compute_margin_percent
  margin_percent: async (_env, rec) => {
    const { subtotal } = await marginBase(rec);
    return subtotal ? floatRound(Number((await rec.get("margin")) ?? 0) / subtotal, 4) : 0;
  },
  // :1712-1727 section quantity and unit
  section_qty: async (_env, rec) => (["line_section", "line_subsection"].includes(String(await rec.get("display_type"))) ? 1 : null),
  section_uom_id: async (env, rec) => {
    if (!["line_section", "line_subsection"].includes(String(await rec.get("display_type")))) return null;
    return env.reg.xmlid(env.cr, "uom.product_uom_unit");
  },
  // sale_pdf_quote_builder sale_order_line.py:38-65 on a new line
  available_product_document_ids: async (env, rec) => {
    const product = idOf(await rec.get("product_id")), template = idOf(await rec.get("product_template_id"));
    const docs = (await env.cr.query<{ id: number; res_model: string }>(
      `SELECT d.id, a.res_model FROM product_document d JOIN ir_attachment a ON a.id = d.ir_attachment_id
        WHERE d.active AND a.type = 'binary' AND a.file_size > 0 AND a.mimetype = 'application/pdf'
          AND ((a.res_model = 'product.product' AND a.res_id = $1) OR (a.res_model = 'product.template' AND a.res_id = $2))
        ORDER BY a.res_model, d.sequence, d.id`, [product ?? 0, template ?? 0])).rows;
    return [...docs.filter((d) => d.res_model === "product.product"), ...docs.filter((d) => d.res_model === "product.template")].map((d) => d.id);
  },
});

// ------------------------------------------------------------------------- the other @api.onchange methods of the order

// sale_order.py:1292-1301 `onchange`: the first call runs with sale_onchange_first_call and the customer search mode
registerMethod("sale.order", "onchange", async (env, ids, args, kwargs, model) => {
  const names = kwargs["field_names"] ?? args[1];
  const first = Array.isArray(names) && names.length === 0;
  return onchangeCall(first ? env.withContext({ ...env.context, sale_onchange_first_call: true, res_partner_search_mode: "customer" }) : env, ids, args, kwargs, model);
}, { apiModel: false });

/** `env._(...)` of the sale module (en_US, or the .po tables, src/models/util.ts). */
const _s = (env: Environment, text: string): string => translate(env, text, "sale");

// :1303-1319
registerOnchange("sale.order", "_onchange_commitment_date", ["commitment_date", "expected_date"], async (env, rec) => {
  const c = await rec.get("commitment_date"), e = await rec.get("expected_date");
  if (c && e && String(c) < String(e)) {
    return { title: _s(env, "Requested date is too soon."), message: _s(env, "The delivery date is sooner than the expected date. You may be unable to honor the delivery date.") };
  }
});
// :1337-1348
registerOnchange("sale.order", "_onchange_company_id", ["company_id"], async (env, rec) => {
  if (!(await rec.get("company_id"))) throw new ValidationError(_s(env, "The company is required, please select one before making any other changes to the sale order."));
});
// :1321-1335
registerOnchange("sale.order", "_onchange_company_id_warning", ["company_id"], async (env, rec) => {
  if (env.context["sale_onchange_first_call"]) return;
  if ((await rec.rels("order_line")).length && (await rec.get("state")) === "draft") {
    return {
      title: _s(env, "Warning for the change of your quotation's company"),
      message: _s(env, "Changing the company of an existing quotation might need some manual adjustments in the details of the lines. You might consider updating the prices."),
    };
  }
});
// :1350-1353 with :1808-1811 `_recompute_taxes`
registerOnchange("sale.order", "_onchange_fpos_id_recompute_taxes", ["fiscal_position_id"], async (env, rec) => {
  if (!(await rec.rels("order_line")).length) return;
  // map_tax reads the fiscal position's mapping as the user (partner.py:105-112): a fiscal position the record rules
  // hide (another company's) raises Odoo's AccessError at the first line with taxes; the port's reads are not checked
  const position = await rec.rel("fiscal_position_id");
  let checked = position === null;
  // `_recompute_taxes`: `_compute_tax_ids` called on the lines without display type, with
  // `recompute_unit_price_on_tax_change` (sale_order_line.py:735-739): a line whose taxes change gets its unit price
  // recomputed. The lines are the order's lines in the form, stored lines as new copies (their changes are UPDATE
  // commands of the answer); the assignment `line.tax_ids = result` marks its dependents (totals) as modified.
  const asSet = (v: unknown): Set<number> => new Set((Array.isArray(v) ? v : []).map((x) => (typeof x === "number" ? x : x instanceof DbRec || x instanceof NewRec ? x.origin ?? -1 : -1)));
  for (const line of await rec.lineCopies("order_line")) {
    if (await line.get("display_type")) continue;
    if (!checked && (await lineTaxesToMap(env, line)).length) {
      if (!(position instanceof DbRec)) throw new NotPorted("sale.order fiscal position as a new record (_recompute_taxes)");
      await env.model("account.fiscal.position").checkAccess([position.id], "read");
      checked = true;
    }
    if (line.protectedFields.has("tax_ids")) throw new NotPorted("sale.order fiscal position change over a line whose taxes are being computed");
    const before = asSet(await line.get("tax_ids"));
    line.addToCompute("tax_ids");
    const result = await line.get("tax_ids");
    await line.set("tax_ids", result);
    const after = asSet(result);
    if (before.size !== after.size || [...before].some((t) => !after.has(t))) line.addToCompute("price_unit");
  }
});
// :1368-1440
registerOnchange("sale.order", "_onchange_order_line", ["order_line"], async (_env, rec) => {
  const lines = await rec.rels("order_line");
  // the combo item lines (`_get_linked_lines_by_line` filtered on combo_item_id) are deleted, re-created or synced
  for (const line of lines) if (await line.get("combo_item_id")) throw new NotPorted("sale.order combo item lines in the form");
  for (const line of lines) {
    if ((await line.get("display_type")) === "line_subsection" && !(await line.get("parent_id"))) {
      if (!(line instanceof NewRec) || line.cascaded) throw new NotPorted("sale.order subsection without a section on a stored line");
      await line.set("display_type", "line_section");
    }
    const template = await line.rel("product_template_id");
    if (template && (await template.get("type")) === "combo" && (await line.get("selected_combo_items"))) {
      throw new NotPorted("sale.order combo product with selected items (combo item lines)");
    }
  }
});
// sale_management sale_order.py:90-112
registerOnchange("sale.order", "_onchange_partner_id", ["partner_id"], async (env, rec) => {
  if (rec.origin !== null || !(await rec.get("sale_order_template_id")) || env.context["sale_onchange_first_call"]) return;
  throw new NotPorted("sale.order customer change reloading the quotation template");
});
// sale_stock sale_order.py:220-233
registerOnchange("sale.order", "_onchange_partner_shipping_id", ["partner_shipping_id"], async (env, rec) => {
  const shipping = idOf(await rec.get("partner_shipping_id"));
  const names: string[] = [];
  for (const p of await rec.rels("picking_ids")) {
    if (!["done", "cancel"].includes(String(await p.get("state"))) && idOf(await p.get("partner_id")) !== shipping) names.push(String(await p.get("name")));
  }
  if (!names.length) return;
  return { title: translate(env, "Warning!", "sale_stock"), message: translate(env, "Do not forget to change the partner on the following delivery orders: %s", "sale_stock").replace("%s", names.join(",")) };
});
// :1363-1366
registerOnchange("sale.order", "_onchange_prepayment_amount", ["prepayment_amount"], async (_env, rec) => {
  const total = Number((await rec.get("amount_total")) ?? 0);
  if (total) await rec.set("prepayment_percent", Number((await rec.get("prepayment_amount")) ?? 0) / total);
});
// :1355-1361 with :1813-1821 `_recompute_prices`
registerOnchange("sale.order", "_onchange_pricelist_id_recompute_prices", ["pricelist_id"], async (env, rec) => {
  if (env.context["sale_onchange_first_call"]) return;
  const lines = await rec.lineCopies("order_line");
  const forceEnv = env.withContext({ ...env.context, force_price_recomputation: true });
  for (const line of lines) {
    if (await line.get("display_type")) continue;
    line.addToCompute("pricelist_item_id");
    // Recompute price_unit with force_price_recomputation
    const product = await line.rel("product_id");
    if (product && !(await line.get("is_downpayment")) && !(await isGlobalDiscount(line)) && !(Number((await line.get("qty_invoiced")) ?? 0) > 0)) {
      const price = (await line.get("product_uom_id")) ? await displayUnitPrice(forceEnv, line, product) : 0;
      await line.set("price_unit", price);
      await line.set("technical_price_unit", price);
    }
    await line.set("discount", 0.0);
    line.addToCompute("discount");
    const disc = await line.get("discount");
    await line.set("discount", disc);
  }
});
// sale_pdf_quote_builder sale_order.py:72-83 over sale_management sale_order.py:66-88
registerOnchange("sale.order", "_onchange_sale_order_template_id", ["sale_order_template_id"], async (_env, rec) => {
  if (await rec.get("sale_order_template_id")) throw new NotPorted("sale.order quotation template lines (_onchange_sale_order_template_id)");
  // `self.quotation_document_ids &= self.available_quotation_document_ids`
  const docs = (await rec.get("quotation_document_ids")) as unknown[] | null;
  if (docs?.length) throw new NotPorted("sale.order quotation documents against the available ones");
  await rec.set("quotation_document_ids", docs ?? []);
});

// ------------------------------------------------------------------------------ the other @api.onchange methods of the line

/** res.currency compare_amounts(a, b) == 0 of the line's currency (float_compare, float_utils.py:216-260). */
async function sameAmount(env: Environment, rec: Rec, a: number, b: number): Promise<boolean> {
  const currency = idOf(await rec.get("currency_id"));
  if (!currency) throw new NotPorted("sale.order.line margin without a currency (ensure_one)");
  if (a === b) return true;
  const rounding = Number((await env.cr.query<{ r: string }>("SELECT rounding::text AS r FROM res_currency WHERE id = $1", [currency])).rows[0]!.r);
  return Math.abs(floatRoundRounding(floatRoundRounding(a, rounding) - floatRoundRounding(b, rounding), rounding)) < rounding;
}
// sale_margin sale_order_line.py:73-85
registerOnchange("sale.order.line", "_onchange_margin", ["margin"], async (env, rec) => {
  const { subtotal, qty } = await marginBase(rec);
  if (!qty) return;
  const computed = subtotal - Number((await rec.get("purchase_price")) ?? 0) * qty;
  if (await sameAmount(env, rec, computed, Number((await rec.get("margin")) ?? 0))) return; // triggered by the compute
  throw new NotPorted("sale.order.line margin typed in the form (_set_price_incl_taxes)");
});
// sale_margin sale_order_line.py:87-102
registerOnchange("sale.order.line", "_onchange_margin_percent", ["margin_percent"], async (env, rec) => {
  const { subtotal } = await marginBase(rec);
  if (!subtotal || await sameAmount(env, rec, Number((await rec.get("margin_percent")) ?? 0), Number((await rec.get("margin")) ?? 0) / subtotal)) return;
  throw new NotPorted("sale.order.line margin percentage typed in the form (_set_price_incl_taxes)");
});
// sale_pdf_quote_builder sale_order_line.py:29-35
registerOnchange("sale.order.line", "_onchange_product", ["product_id", "product_template_id"], async (_env, rec) => {
  const docs = (await rec.get("product_document_ids")) as unknown[] | null;
  if (docs?.length) throw new NotPorted("sale.order.line product documents against the available ones");
  await rec.set("product_document_ids", docs ?? []);
});
// :1155-1158
registerOnchange("sale.order.line", "_onchange_qty_delivered_percent", ["qty_delivered_percent"], async (_env, rec) => {
  await rec.set("qty_delivered", Number((await rec.get("qty_delivered_percent")) ?? 0) * Number((await rec.get("product_uom_qty")) ?? 0));
});
// sale_purchase sale_order_line.py:25-35
registerOnchange("sale.order.line", "_onchange_service_product_uom_qty", ["product_uom_qty"], async (_env, rec) => {
  if ((await rec.get("state")) !== "sale") return;
  const product = await rec.rel("product_id");
  // service_tracking is not company dependent, so `with_company(_purchase_service_get_company())` reads the same value
  if (!product || (await product.get("type")) !== "service" || (await product.get("service_tracking")) !== "subcontract") return;
  throw new NotPorted("sale.order.line quantity of a confirmed subcontracted service line (decrease warning)");
});

// sale_make_invoice_advance.py:127-131: `{"value": {"amount": default_get(["amount"]).get("amount")}}`, applied by
// `_apply_onchange_methods` (models.py:6503-6506, None when there is no default)
registerOnchange("sale.advance.payment.inv", "_onchange_advance_payment_method", ["advance_payment_method"], async (env, rec) => {
  if ((await rec.get("advance_payment_method")) !== "percentage") return;
  const defaults = await defaultGet(env, "sale.advance.payment.inv", ["amount"]);
  const v = defaults["amount"];
  await rec.set("amount", v === undefined || v === false || v === null ? null : Number(v));
});
