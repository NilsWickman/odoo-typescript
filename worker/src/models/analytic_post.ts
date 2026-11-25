/**
 * account_move_line.py:3548-3646 `_create_analytic_lines` of a move being posted (account_move.py:6273-6274): one
 * account.analytic.line per distribution key of each journal item with an analytic distribution (`_prepare_analytic_lines`,
 * `_prepare_analytic_distribution_line`), the amounts rounded with the rounding error spread
 * (`_round_analytic_distribution_line`), created with `skip_analytic_sync` and without `default_account_id`.
 * An invoiced line's revenue items get its first sale line (sale account_move_line.py:76-82).
 * Refused: `validate_analytic` in the context (the mandatory plans of `_validate_distribution`, which the web client's
 * Post button asks for) and a cost line sale would re-invoice (sale account_move_line.py:51-84 `_sale_can_be_reinvoice`).
 */
import { NotPorted } from "../errors";
import { floatRound } from "../orm/convert";
import type { Environment } from "../orm/types";
import { create } from "../orm/create";

interface ItemRow {
  id: number; name: string | null; ref: string | null; date: string; partner_id: number | null; partner_name: string | null; quantity: number;
  product_id: number | null; product_uom_id: number | null; balance: number; debit: number; credit: number; account_id: number; company_id: number | null;
  rounding: number; invoice_user_id: number | null; move_type: string; sold: boolean; reinvoice: string | null;
}

export async function createAnalyticLines(env: Environment, moveIds0: number | readonly number[]): Promise<void> {
  if (env.context["validate_analytic"]) throw new NotPorted("_post with validate_analytic (_validate_analytic_distribution of the mandatory plans)");
  const moveIds = typeof moveIds0 === "number" ? [moveIds0] : [...moveIds0];
  if (!moveIds.length) return;
  const items = (await env.cr.query<ItemRow>(
    `SELECT l.id, l.name, l.ref, l.date::text AS date, l.partner_id, p.name AS partner_name, COALESCE(l.quantity, 0)::float8 AS quantity, l.product_id, l.product_uom_id,
            COALESCE(l.balance, 0)::float8 AS balance, COALESCE(l.debit, 0)::float8 AS debit, COALESCE(l.credit, 0)::float8 AS credit, l.account_id, l.company_id,
            c.rounding::float8 AS rounding, m.invoice_user_id, m.move_type,
            EXISTS (SELECT 1 FROM sale_order_line_invoice_rel r WHERE r.invoice_line_id = l.id) AS sold,
            (SELECT t.reinvoice_policy FROM product_product pp JOIN product_template t ON t.id = pp.product_tmpl_id WHERE pp.id = l.product_id) AS reinvoice
       FROM account_move_line l JOIN account_move m ON m.id = l.move_id LEFT JOIN res_partner p ON p.id = l.partner_id
       JOIN res_currency c ON c.id = l.company_currency_id
      WHERE l.move_id = ANY($1::int[]) AND l.analytic_distribution IS NOT NULL
      ORDER BY array_position($1::int[], l.move_id), l.date DESC, l.move_name DESC, l.id`, [moveIds])).rows;
  const projectPlan = Number((await env.cr.query<{ v: string | null }>("SELECT value AS v FROM ir_config_parameter WHERE key = 'analytic.project_plan'")).rows[0]?.v ?? 0);
  const pct = (await env.cr.query<{ d: number }>("SELECT digits AS d FROM decimal_precision WHERE name = 'Percentage Analytic'")).rows[0]?.d ?? 2;
  const unitDigits = (await env.cr.query<{ d: number }>("SELECT digits AS d FROM decimal_precision WHERE name = 'Product Unit'")).rows[0]?.d ?? 2;
  const vals: Record<string, unknown>[] = [];
  for (const item of items) {
    const round = (v: number): number => floatRound(v, Math.max(0, Math.round(-Math.log10(item.rounding))));
    const isZero = (v: number): boolean => round(v) === 0;
    // the distribution's keys in the stored order (Python's dict of the jsonb)
    const entries = (await env.cr.query<{ key: string; value: number }>(
      "SELECT e.key, e.value::text::float8 AS value FROM account_move_line l, jsonb_each(l.analytic_distribution) e WHERE l.id = $1", [item.id])).rows;
    const lineVals: Record<string, unknown>[] = [];
    const onEachPlan = new Map<number, number>();
    for (const { key, value } of entries) {
      const ids = key.split(",").map((x) => parseInt(x, 10));
      // `browse(...).exists()`, in the key's order
      const accounts = (await env.cr.query<{ id: number; root: number | null }>(
        "SELECT a.id, split_part(pl.parent_path, '/', 1)::int AS root FROM account_analytic_account a JOIN account_analytic_plan pl ON pl.id = a.plan_id WHERE a.id = ANY($1::int[])", [ids])).rows;
      const fields: Record<string, number> = {};
      let amount = 0;
      for (const id of ids) {
        const account = accounts.find((a) => a.id === id);
        if (!account || account.root === null) continue;
        const before = onEachPlan.get(account.root) ?? 0;
        const plan = before + value;
        // float_compare(distribution_plan, 100, precision_digits=<Percentage Analytic>) == 0
        amount = floatRound(plan, pct) === 100 ? -item.balance * (100 - before) / 100.0 : -item.balance * value / 100.0;
        onEachPlan.set(account.root, plan);
        // analytic_plan.py:113-119 `_column_name` of the account's plan: its root's
        fields[account.root === projectPlan ? "account_id" : `x_plan${account.root}_id`] = account.id;
      }
      if (isZero(amount)) continue;
      lineVals.push({
        // `self.name or (self.ref or '/' + ' -- ' + (partner name or '/'))`
        name: item.name || item.ref || `/ -- ${item.partner_id ? item.partner_name ?? "" : "/"}`,
        date: item.date, ...fields, partner_id: item.partner_id ?? false, unit_amount: item.quantity, product_id: item.product_id ?? false,
        product_uom_id: item.product_uom_id ?? false, amount, general_account_id: item.account_id, ref: item.ref ?? false, move_line_id: item.id,
        user_id: item.invoice_user_id ?? env.uid, company_id: item.company_id ?? await env.company(),
        category: ["out_invoice", "out_refund"].includes(item.move_type) ? "invoice" : ["in_invoice", "in_refund"].includes(item.move_type) ? "vendor_bill" : "other",
      });
    }
    // :3624-3646 `_round_analytic_distribution_line`
    let error = 0;
    for (const v of lineVals) { const r = round(v["amount"] as number); error += r - (v["amount"] as number); v["amount"] = r; }
    for (const v of lineVals) {
      if (isZero(error)) break;
      const amt = Math.max(item.rounding, Math.abs(round(error / lineVals.length)));
      if (error < 0) { v["amount"] = (v["amount"] as number) + amt; error += amt; } else { v["amount"] = (v["amount"] as number) - amt; error -= amt; }
    }
    // sale account_move_line.py:86-98 `_sale_can_be_reinvoice`: no sale line, not a credit, a re-invoiced product
    if (lineVals.length && !item.sold && floatRound(item.credit, unitDigits) <= floatRound(item.debit, unitDigits) && item.reinvoice && item.reinvoice !== "no") {
      throw new NotPorted("_post of a cost line re-invoiced to a sale order (_sale_create_reinvoice_sale_line)");
    }
    // sale account_move_line.py:76-82: an invoiced line's positive analytic items (revenue) get its first sale line
    // (`sale_line_ids` in sale.order.line's `_order`: order_id, sequence, id)
    if (item.sold) {
      const [first] = (await env.cr.query<{ id: number }>(
        `SELECT s.id FROM sale_order_line_invoice_rel r JOIN sale_order_line s ON s.id = r.order_line_id WHERE r.invoice_line_id = $1
          ORDER BY s.order_id, s.sequence, s.id LIMIT 1`, [item.id])).rows;
      for (const v of lineVals) if ((v["amount"] as number) > 0 && (v["unit_amount"] as number) >= 0 && !("so_line" in v)) v["so_line"] = first!.id;
    }
    vals.push(...lineVals);
  }
  if (!vals.length) return;
  const { default_account_id: _drop, ...ctx } = env.context;
  await create(env.withContext({ ...ctx, skip_analytic_sync: true }), "account.analytic.line", vals);
}
