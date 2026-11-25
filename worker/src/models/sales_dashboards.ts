/**
 * The list-view dashboards of Sales and Purchase:
 * - sale.order `retrieve_sale_dashboard(period_days)` (odoo/addons/sale/models/sale_order.py:2836-2925), with
 *   `is_unfulfilled` searched as in `_search_is_unfulfilled` (:1125-1137);
 * - purchase.order `retrieve_dashboard()` (purchase/models/purchase_order.py:1035-1119) extended by purchase_stock
 *   (purchase_stock/models/purchase_order.py:274-297, `_get_domain_is_late` :299-303).
 * Counts go through the ORM search (record rules, allowed companies); the `Domain.custom` SQL parts select the
 * candidate ids.
 */
import { NotPorted } from "../errors";
import { registerMethod } from "../http/methods";
import { floatRepr, floatRound } from "../orm/convert";
import { pyFloat } from "../orm/values";
import { parseDomain } from "../orm/domain";
import { userInfo } from "../orm/env";
import type { Environment } from "../orm/types";
import { envFor } from "../web/common";
import { translate } from "./util";

async function count(env: Environment, model: string, domain: unknown[]): Promise<number> {
  return (await env.model(model).search(parseDomain(domain))).length;
}

/** `fields.Datetime.now()` on the database clock, as a naive UTC string. */
async function nowUtc(env: Environment, shift = ""): Promise<string> {
  const r = await env.cr.query<{ t: string }>(`SELECT to_char((now() AT TIME ZONE 'UTC')${shift}, 'YYYY-MM-DD HH24:MI:SS') AS t`);
  return r.rows[0]!.t;
}

const num = (v: unknown): number => (typeof v === "number" ? v : v && typeof v === "object" && "float" in v ? Number((v as { float: number }).float) : 0);

registerMethod("sale.order", "retrieve_sale_dashboard", async (env0, _ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const periodDays = Number(args[0] ?? kwargs["period_days"]);
  if (!Number.isInteger(periodDays)) throw new NotPorted("retrieve_sale_dashboard with a non-integer period");
  const company = await env.company();
  const currency = (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [company])).rows[0]?.c ?? false;
  // :2906-2925 sale.report `_read_group(price_total:sum, order_reference:count_distinct)` over the period
  const totals = async (previous: boolean): Promise<{ orders: number; sales_amount: number }> => {
    const period = previous
      ? [["date", ">", `today -${periodDays * 2}d +1d`], ["date", "<", `today -${periodDays}d +1d`]]
      : [["date", ">", `today -${periodDays}d +1d`]];
    const ids = await env.model("sale.report").search(parseDomain([...period, ["state", "=", "sale"]]));
    const rows = ids.length ? await env.model("sale.report").read(ids, ["price_total", "order_reference"], "") : [];
    let sum = 0;
    const refs = new Set<string>();
    for (const r of rows) {
      sum += num(r["price_total"]);
      if (r["order_reference"]) refs.add(String(r["order_reference"]));
    }
    return { orders: refs.size, sales_amount: floatRound(sum, 2) };
  };
  const current = await totals(false), previous = await totals(true);
  // float_round returns a Python float (1400.0 in the JSON)
  const gain = (cur: number, prev: number): ReturnType<typeof pyFloat> | null => (prev ? pyFloat(floatRound(((cur - prev) / prev) * 100, 2)) : null);
  // :1125-1137 is_unfulfilled: confirmed orders with a line delivered short of a non-service product
  const unfulfilled = (await env.cr.query<{ id: number }>(
    `SELECT DISTINCT l.order_id AS id FROM sale_order_line l
      WHERE l.qty_delivered < l.product_uom_qty
        AND NOT EXISTS (SELECT 1 FROM product_product p JOIN product_template t ON t.id = p.product_tmpl_id
                         WHERE p.id = l.product_id AND t.type = 'service')`)).rows.map((r) => r.id);
  return {
    sales_amount: { total: pyFloat(current.sales_amount), gain: gain(current.sales_amount, previous.sales_amount) },
    orders: { total: current.orders, gain: gain(current.orders, previous.orders) },
    to_upsell: await count(env, "sale.order", [["invoice_status", "=", "upselling"], ["state", "=", "sale"]]),
    to_fulfill: await count(env, "sale.order", [["state", "=", "sale"], ["id", "in", unfulfilled], ["state", "=", "sale"]]),
    to_confirm: await count(env, "sale.order", [["state", "in", ["sent"]]]),
    to_invoice: await count(env, "sale.order", [["invoice_status", "=", "to invoice"], ["state", "=", "sale"]]),
    currency_id: currency,
  };
}, { apiModel: true });

registerMethod("purchase.order", "retrieve_dashboard", async (env0, _ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const user = await userInfo(env);
  if (user.share) throw new NotPorted("purchase.order.retrieve_dashboard for a non-internal user (AccessDenied)");
  const block = () => ({ all: 0, priority: 0 });
  const part = () => ({ draft: block(), sent: block(), late: block(), not_acknowledged: block(), late_receipt: block(), days_to_order: 0 as unknown });
  const result: Record<string, Record<string, unknown>> & { days_to_purchase?: unknown } = { global: part(), my: part() };
  const now = await nowUtc(env);
  const update = async (key: string, domain: unknown[]): Promise<void> => {
    const ids = await env.model("purchase.order").search(parseDomain(domain));
    if (!ids.length) return;
    const rows = await env.model("purchase.order").read(ids, ["priority", "user_id"], "");
    for (const r of rows) {
      const g = result["global"]![key] as { all: number; priority: number };
      const m = result["my"]![key] as { all: number; priority: number };
      g.all += 1;
      if (r["priority"] !== "0") g.priority += 1;
      if (r["user_id"] !== env.uid) continue;
      m.all += 1;
      if (r["priority"] !== "0") m.priority += 1;
    }
  };
  await update("draft", [["state", "=", "draft"]]);
  await update("sent", [["state", "=", "sent"]]);
  await update("late", [["state", "in", ["draft", "sent", "to approve"]], ["date_order", "<", now]]);
  await update("not_acknowledged", [["state", "in", ["purchase", "done"]], ["acknowledged", "=", false]]);
  // is_late (:436-450 with purchase_stock :299-303): a line received short of an order that is late and not received
  const shortLines = (await env.cr.query<{ id: number }>(
    "SELECT DISTINCT order_id AS id FROM purchase_order_line WHERE qty_received < product_qty")).rows.map((r) => r.id);
  const lateOrders = await env.sudo().withContext({ ...env.context, active_test: false }).model("purchase.order").search(parseDomain([
    ["id", "in", shortLines], ["state", "=", "purchase"], ["date_planned", "<=", now],
    "|", ["picking_ids", "=", false], ["picking_ids.state", "not in", ["done", "cancel"]]]));
  await update("late_receipt", [["state", "in", ["purchase", "done"]], ["id", "in", lateOrders]]);
  const threeMonthsAgo = await nowUtc(env, " - interval '3 months'");
  const days = (secs: number) => floatRepr(secs / 60 / 60 / 24, 2);
  const approved = await env.model("purchase.order").search(parseDomain([["state", "=", "purchase"], ["create_date", ">=", threeMonthsAgo], ["date_approve", "!=", false]]));
  let global = 0, mine = 0, mineCount = 0;
  if (approved.length) {
    const rows = (await env.cr.query<{ id: number; s: number; user_id: number | null }>(
      "SELECT id, EXTRACT(EPOCH FROM date_approve - create_date) AS s, user_id FROM purchase_order WHERE id = ANY($1::int[])", [approved])).rows;
    for (const r of rows) {
      global += Number(r.s);
      if (r.user_id === env.uid) { mine += Number(r.s); mineCount += 1; }
    }
  }
  result["global"]!["days_to_order"] = days(approved.length ? global / approved.length : 0);
  result["my"]!["days_to_order"] = days(mineCount ? mine / mineCount : 0);
  // purchase_stock: on-time delivery over the last three months
  const promised = await env.model("purchase.order").search(parseDomain([["state", "=", "purchase"], ["date_promised", ">=", threeMonthsAgo]]));
  let otd = 0, myCount = 0, myOtd = 0;
  if (promised.length) {
    const rows = (await env.cr.query<{ ok: boolean; user_id: number | null }>(
      `SELECT (effective_date IS NOT NULL AND effective_date::date <= date_promised::date) AS ok, user_id
         FROM purchase_order WHERE id = ANY($1::int[])`, [promised])).rows;
    for (const r of rows) {
      if (r.user_id === env.uid) myCount += 1;
      if (!r.ok) continue;
      otd += 1;
      if (r.user_id === env.uid) myOtd += 1;
    }
  }
  const pct = (v: number) => translate(env, "%(otd)s %%").replace("%(otd)s", floatRepr(v, 0)).replace("%%", "%");
  result["global"]!["otd"] = pct(promised.length ? (otd / promised.length) * 100 : 100);
  result["my"]!["otd"] = pct(myCount ? (myOtd / myCount) * 100 : 100);
  result.days_to_purchase = (await env.cr.query<{ d: number | null }>("SELECT days_to_purchase AS d FROM res_company WHERE id = $1", [await env.company()])).rows[0]?.d ?? 0;
  return result;
}, { apiModel: true });
