/**
 * The early payment discount of a payment within the discount date: the write-off lines of the payment's entry,
 * account_move.py:5218-5389 `_get_invoice_counterpart_amls_for_early_payment_discount_per_payment_term_line` and
 * :5391-5470 `_get_invoice_counterpart_amls_for_early_payment_discount`, for the 'included' computation (the tax
 * amounts discounted with the base). The invoice's lines are taken again with their unit price reduced by the
 * discount; the base write-off per discount account and taxes, and the tax write-off per refund repartition line, both
 * scaled by the part of the term line still due, the rounding put on the biggest base line.
 * Analytic distributions, distribution models, included, group or base-changing (include_base_amount) taxes, several tax
 * repartition lines, foreign currencies and exchange differences refuse.
 */
import { NotPorted } from "../errors";
import type { Environment } from "../orm/types";
import { plainNumber } from "../orm/values";
import { accountTaxHelpers, roundPrecision, type BaseLine } from "./account_tax_engine";
import { companyData, currencyData, extraTaxData, taxData } from "./account_taxes";
import { translate } from "./util";
import { refuseTaxEngineOverride } from "./account_tax_hooks";

export interface EpdLine {
  name: string; account_id: number; partner_id: number | null; currency_id: number; amount_currency: number; balance: number;
  tax_ids: number[]; tax_tag_ids: number[]; tax_repartition_line_id: number | null; price_total: number;
}

type TaxesData = readonly { readonly tax: { readonly id: number }; readonly tax_amount_currency: number; readonly tax_amount: number }[];
type Details = BaseLine["tax_details"] & { readonly taxes_data?: TaxesData };
const detailsOf = (b: BaseLine): Details => b.tax_details as Details;
const taxesOf = (b: BaseLine): TaxesData => {
  const t = detailsOf(b).taxes_data;
  if (!Array.isArray(t)) throw new Error("tax engine: a base line without taxes_data");
  return t;
};

/** The write-off lines of the payment term line `termId` (the whole residual paid at the discounted amount). */
export async function epdWriteOff(env: Environment, termId: number): Promise<EpdLine[]> {
  // account_move.py:5240-5390: the base lines and the tax lines' grouping keys of the tax engine, which the hand port's
  // write-off lines here do not carry: a compiled override of one of them refuses
  await refuseTaxEngineOverride(env, "an early payment discount");
  const term = (await env.cr.query<{ move_id: number; amount_currency: number; balance: number; discount_amount_currency: number | null; discount_balance: number | null;
    amount_residual_currency: number; currency_id: number; company_currency_id: number }>(
    `SELECT move_id, amount_currency::float8 AS amount_currency, balance::float8 AS balance, discount_amount_currency::float8 AS discount_amount_currency,
            discount_balance::float8 AS discount_balance, amount_residual_currency::float8 AS amount_residual_currency, currency_id, company_currency_id
       FROM account_move_line WHERE id = $1`, [termId])).rows[0]!;
  const move = (await env.cr.query<{ id: number; move_type: string; company_id: number; currency_id: number; commercial_partner_id: number | null; amount_total: number;
    pct: number | null; computation: string | null; document_tax_mode: string | null }>(
    `SELECT m.id, m.move_type, m.company_id, m.currency_id, m.commercial_partner_id, m.amount_total::float8 AS amount_total, m.document_tax_mode,
            t.discount_percentage::float8 AS pct, t.early_pay_discount_computation AS computation
       FROM account_move m JOIN account_payment_term t ON t.id = m.invoice_payment_term_id WHERE m.id = $1`, [term.move_id])).rows[0]!;
  if (move.computation !== "included") throw new NotPorted(`early payment discount computed ${String(move.computation)}`);
  if (term.currency_id !== term.company_currency_id) throw new NotPorted("early payment discount in a foreign currency (exchange difference lines)");
  const pct = Number(move.pct ?? 0);
  if (!pct) return [];
  const inbound = ["out_invoice", "in_refund", "out_receipt"].includes(move.move_type);
  const directionSign = ["out_refund", "in_invoice", "in_receipt"].includes(move.move_type) ? 1 : -1;
  const company = (await env.cr.query<{ loss: number | null; gain: number | null }>(
    "SELECT account_journal_early_pay_discount_loss_account_id AS loss, account_journal_early_pay_discount_gain_account_id AS gain FROM res_company WHERE id = $1",
    [move.company_id])).rows[0]!;
  const account = inbound ? company.loss : company.gain;
  if (!account) throw new NotPorted("early payment discount without the company's discount account");
  // :5288-5293 `_get_distribution` of the discount account
  if (Number((await env.cr.query<{ n: string }>("SELECT count(*)::text AS n FROM account_analytic_distribution_model")).rows[0]?.n ?? 0)) {
    throw new NotPorted("early payment discount with analytic distribution models");
  }
  const lines = (await env.cr.query<{ id: number; display_type: string | null; amount_currency: number; balance: number; price_unit: number | null; quantity: number | null;
    discount: number | null; analytic: unknown; extra: unknown; tax_repartition_line_id: number | null; partner_id: number | null }>(
    `SELECT id, display_type, amount_currency::float8 AS amount_currency, balance::float8 AS balance, price_unit::float8 AS price_unit, quantity::float8 AS quantity,
            discount::float8 AS discount, analytic_distribution AS analytic, extra_tax_data AS extra, tax_repartition_line_id, partner_id
       FROM account_move_line WHERE move_id = $1 ORDER BY id`, [move.id])).rows;
  if (lines.some((l) => l.analytic && Object.keys(l.analytic as object).length)) throw new NotPorted("early payment discount of an invoice with analytic distributions");
  const products = lines.filter((l) => l.display_type === "product");
  const taxLines = lines.filter((l) => l.tax_repartition_line_id !== null);
  const currency = await currencyData(env, move.currency_id);
  const comp = await companyData(env, move.company_id);
  // :5232-5237 `inverse_tax_rep`: the refund repartition line at the invoice one's position, per tax
  const refundRep = async (rep: number): Promise<number> => {
    const r = (await env.cr.query<{ id: number }>(
      `WITH o AS (SELECT tax_id, document_type, (SELECT count(*) FROM account_tax_repartition_line x WHERE x.tax_id = l.tax_id AND x.document_type = l.document_type
                   AND (x.sequence, x.id) < (l.sequence, l.id)) AS pos FROM account_tax_repartition_line l WHERE l.id = $1)
       SELECT n.id FROM o JOIN LATERAL (SELECT id FROM account_tax_repartition_line n WHERE n.tax_id = o.tax_id
         AND n.document_type = CASE WHEN o.document_type = 'refund' THEN 'invoice' ELSE 'refund' END ORDER BY n.sequence, n.id OFFSET o.pos LIMIT 1) n ON true`, [rep])).rows[0];
    if (!r) throw new NotPorted("early payment discount: the inverse repartition line of a tax");
    return r.id;
  };
  const oldTax = new Map<number, { amount: number; balance: number }>();
  for (const l of taxLines) {
    const k = await refundRep(l.tax_repartition_line_id!);
    const e = oldTax.get(k) ?? { amount: 0, balance: 0 };
    e.amount += l.amount_currency; e.balance += l.balance;
    oldTax.set(k, e);
  }
  // :5264-5281 the invoice lines as refunds, their non-fixed taxes, the unit price reduced by the discount
  const remaining = (100 - pct) / 100.0;
  const bases: { line: (typeof products)[number]; base: BaseLine; taxes: number[] }[] = [];
  for (const l of products) {
    const taxIds = (await env.cr.query<{ t: number }>("SELECT account_tax_id AS t FROM account_move_line_account_tax_rel WHERE account_move_line_id = $1", [l.id])).rows.map((r) => r.t);
    const taxes = (await taxData(env, taxIds)).filter((t) => t.amount_type !== "fixed").sort((a, b) => a.sequence - b.sequence || a.id - b.id);
    for (const t of taxes) {
      if (t.amount_type !== "percent" || t.price_include || t.include_base_amount) throw new NotPorted("early payment discount with taxes other than plain percentages");
    }
    const extra = extraTaxData(l.extra, null);
    if (extra.special_type) throw new NotPorted("early payment discount of a down payment invoice");
    const base = accountTaxHelpers.prepare_base_line_for_taxes_computation({
      id: l.id, tax_ids: taxes, price_unit: Number(plainNumber(l.price_unit) ?? 0) * remaining, quantity: Number(l.quantity ?? 0), discount: Number(l.discount ?? 0),
      currency_id: currency, rate: 1, product_id: {}, product_uom_id: {}, document_tax_mode: move.document_tax_mode, extra_tax_data: {},
    }, { sign: directionSign, special_type: null });
    bases.push({ line: l, base, taxes: taxes.map((t) => t.id) });
  }
  accountTaxHelpers.add_tax_details_in_base_lines(bases.map((b) => b.base), comp);
  accountTaxHelpers.round_base_lines_tax_details(bases.map((b) => b.base), comp);
  const tags = async (taxIds: readonly number[], kind: "base" | "tax", rep?: number): Promise<number[]> => (await env.cr.query<{ t: number }>(
    kind === "base"
      ? `SELECT DISTINCT x.account_account_tag_id AS t FROM account_tax_repartition_line r JOIN account_account_tag_account_tax_repartition_line_rel x
           ON x.account_tax_repartition_line_id = r.id WHERE r.tax_id = ANY($1::int[]) AND r.document_type = 'refund' AND r.repartition_type = 'base' ORDER BY 1`
      : "SELECT account_account_tag_id AS t FROM account_account_tag_account_tax_repartition_line_rel WHERE account_tax_repartition_line_id = $1 ORDER BY 1",
    kind === "base" ? [[...taxIds]] : [rep])).rows.map((r) => r.t);
  const round = (v: number): number => roundPrecision(v, currency.rounding);
  const percentagePaid = Math.abs(term.amount_residual_currency / move.amount_total);
  // :5302-5331 the base write-offs, grouped by partner, currency, account, taxes and tags
  const baseOut = new Map<string, EpdLine>();
  for (const { line, base, taxes } of bases) {
    const d = detailsOf(base);
    const tagIds = await tags(taxes, "base");
    const key = JSON.stringify([line.partner_id, move.currency_id, account, [...taxes].sort((a, b) => a - b), tagIds]);
    const e = baseOut.get(key) ?? {
      name: translate(env, "Early Payment Discount", "account"), account_id: account, partner_id: line.partner_id, currency_id: move.currency_id,
      amount_currency: 0, balance: 0, tax_ids: taxes, tax_tag_ids: tagIds, tax_repartition_line_id: null, price_total: 0,
    };
    e.amount_currency += round(directionSign * d.total_excluded_currency - line.amount_currency);
    e.balance += round(directionSign * d.total_excluded - line.balance);
    baseOut.set(key, e);
  }
  // :5333-5368 the tax write-offs: per refund repartition line, the discounted tax amount minus the invoice's
  const newTax = new Map<number, { amount: number; balance: number; tax: number }>();
  for (const { base } of bases) {
    for (const td of taxesOf(base)) {
      const reps = (await env.cr.query<{ id: number; factor: number }>(
        "SELECT id, factor_percent::float8 AS factor FROM account_tax_repartition_line WHERE tax_id = $1 AND document_type = 'refund' AND repartition_type = 'tax' ORDER BY sequence, id",
        [td.tax.id])).rows;
      if (reps.length !== 1 || reps[0]!.factor !== 100) throw new NotPorted("early payment discount with a tax of several repartition lines");
      const e = newTax.get(reps[0]!.id) ?? { amount: 0, balance: 0, tax: td.tax.id };
      e.amount += directionSign * td.tax_amount_currency; e.balance += directionSign * td.tax_amount;
      newTax.set(reps[0]!.id, e);
    }
  }
  const taxOut: EpdLine[] = [];
  for (const [rep, n] of newTax) {
    const old = oldTax.get(rep);
    if (!old) continue;
    const r = (await env.cr.query<{ account: number | null; name: string }>(
      `SELECT r.account_id AS account, COALESCE(t.name->>$2, t.name->>'en_US') AS name FROM account_tax_repartition_line r JOIN account_tax t ON t.id = r.tax_id WHERE r.id = $1`,
      [rep, env.lang ?? "en_US"])).rows[0]!;
    if (r.account === null) throw new NotPorted("early payment discount with a tax repartition line without an account");
    const amount = round(n.amount) - old.amount, balance = round(n.balance) - old.balance;
    taxOut.push({
      name: translate(env, "Early Payment Discount (%s)", "account").replace("%s", () => r.name), account_id: r.account, partner_id: move.commercial_partner_id,
      currency_id: move.currency_id, amount_currency: round(amount * percentagePaid), balance: round(balance * percentagePaid),
      tax_ids: [], tax_tag_ids: await tags([], "tax", rep), tax_repartition_line_id: rep, price_total: 0,
    });
  }
  const baseList = [...baseOut.values()].map((b) => ({ ...b, amount_currency: round(b.amount_currency * percentagePaid), balance: round(b.balance * percentagePaid) }));
  if (!baseList.length) throw new NotPorted("early payment discount of an invoice without product lines");
  // :5376-5387 the rounding left on the biggest base line (`max` keeps the first of equal ones)
  const termAmount = term.amount_currency - Number(term.discount_amount_currency ?? 0);
  const termBalance = term.balance - Number(term.discount_balance ?? 0);
  const sum = (xs: readonly EpdLine[], k: "amount_currency" | "balance"): number => xs.reduce((t, x) => t + x[k], 0);
  let biggest = baseList[0]!;
  for (const b of baseList) if (b.amount_currency > biggest.amount_currency) biggest = b;
  biggest.amount_currency += termAmount - sum(baseList, "amount_currency") - sum(taxOut, "amount_currency");
  biggest.balance += termBalance - sum(baseList, "balance") - sum(taxOut, "balance");
  // account_move_line.py:1255-1271 `_compute_totals` of the entry's lines: the base write-off with its taxes
  for (const b of baseList) {
    const taxes = await taxData(env, b.tax_ids);
    const bl = accountTaxHelpers.prepare_base_line_for_taxes_computation({
      id: 0, tax_ids: taxes, price_unit: b.amount_currency, quantity: 1, discount: 0, currency_id: currency, rate: 1, product_id: {}, product_uom_id: {},
      document_tax_mode: null, extra_tax_data: {},
    }, { sign: 1, special_type: null });
    accountTaxHelpers.add_tax_details_in_base_lines([bl], comp);
    accountTaxHelpers.round_base_lines_tax_details([bl], comp);
    b.price_total = detailsOf(bl).total_included_currency;
  }
  for (const t of taxOut) t.price_total = t.amount_currency;
  return [...baseList, ...taxOut];
}
