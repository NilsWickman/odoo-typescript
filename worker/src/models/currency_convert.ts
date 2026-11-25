/**
 * Currency conversion: res_currency.py:345-354 `_get_conversion_rate` (the `inverse_rate` of `from` towards `to` for
 * the company's root at the date) and :356-375 `_convert` (rounded to the target currency unless `round=False`).
 */
import type { Environment } from "../orm/types";
import { currencyData } from "./account_taxes";
import { roundPrecision } from "./account_tax_engine";
import { inverseRates } from "./res_currency";
import { withCompany } from "./tail_util";

/** `_get_conversion_rate(from_currency, to_currency, company, date)`. */
export async function conversionRate(env: Environment, from: number, to: number, company: number, date: string): Promise<number> {
  if (from === to) return 1;
  // :350 company.root_id (rates live on the root); `with_company(company)` puts it first in the allowed companies
  const root = (await env.cr.query<{ root: number }>("SELECT split_part(parent_path, '/', 1)::int AS root FROM res_company WHERE id = $1", [company])).rows[0]?.root ?? company;
  const cenv = await withCompany(env.sudo(), root);
  const rates = await inverseRates(cenv.withContext({ ...cenv.context, to_currency: to, date: date.slice(0, 10) }), [from]);
  return rates.get(from) ?? 1;
}

/** `from_currency._convert(amount, to_currency, company, date, round)`. */
export async function convertAmount(env: Environment, amount: number, from: number, to: number, company: number, date: string, round = true): Promise<number> {
  if (!amount) return 0.0;
  const value = amount * (await conversionRate(env, from, to, company, date));
  return round ? roundPrecision(value, (await currencyData(env, to)).rounding) : value;
}
