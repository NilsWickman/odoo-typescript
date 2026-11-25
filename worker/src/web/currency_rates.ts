/**
 * Currency rates for the `sum_currency` read_group aggregate: `res.currency._current_rate_sql`
 * (odoo/odoo/addons/base/models/res_currency.py:148-169) over `_get_rates` (:171-212), evaluated in JS for the
 * JS `_read_group` fallback of src/web/read_group.ts: the SQL `SUM(field / COALESCE(rate, 1.0))` becomes a per-row
 * division by the rate of the row's currency.
 */
import { envCache, userInfo } from "../orm/env";
import type { Environment } from "../orm/types";
import { dbNow, todayInTz, validTz } from "../models/util";

/**
 * Rates relative to the company currency (`sql_rates` of :156-160): currency id -> rate / company_rate, only for
 * currencies whose rate differs from the company's. A currency missing from the map has rate 1.0 (:169 COALESCE).
 */
export function currentRates(env: Environment): Promise<ReadonlyMap<number, number>> {
  return envCache(env, `currency.current_rates:${JSON.stringify(env.context.allowed_company_ids ?? null)}:${env.context.tz ?? ""}`, async () => {
    const company = await env.company();
    // `company.root_id` (:173): the top of the company's parent_path
    const root = (await env.cr.query<{ root: number; currency_id: number }>(
      `SELECT split_part(parent_path, '/', 1)::int AS root, currency_id FROM res_company WHERE id = $1`, [company])).rows[0];
    if (root === undefined) throw new Error(`company ${company} not found`);
    // fields.Date.context_today (:150, fields_temporal.py): today in the context tz, else the user's
    const today = todayInTz(await dbNow(env), validTz(env.context.tz || (await userInfo(env)).tz) || "UTC");
    // :182-209: per currency (active_test=False), the latest rate strictly before today of the root company or no
    // company (`order='company_id.id, name DESC'`: the company's own rate first, NULL company last), else the first one
    const rows = (await env.cr.query<{ id: number; rate: number | string }>(
      `SELECT c.id, COALESCE(b.rate, a.rate, 1.0) AS rate FROM res_currency c
       LEFT JOIN LATERAL (SELECT r.rate FROM res_currency_rate r WHERE r.currency_id = c.id AND r.name < $1::date
         AND (r.company_id IS NULL OR r.company_id = $2) ORDER BY r.company_id, r.name DESC LIMIT 1) b ON TRUE
       LEFT JOIN LATERAL (SELECT r.rate FROM res_currency_rate r WHERE r.currency_id = c.id
         AND (r.company_id IS NULL OR r.company_id = $2) ORDER BY r.company_id, r.name ASC LIMIT 1) a ON TRUE`,
      [today, root.root])).rows;
    const all = new Map<number, number>(rows.map((r) => [r.id, Number(r.rate) || 1.0]));
    const companyRate = all.get(root.currency_id) ?? 1.0;
    const out = new Map<number, number>();
    for (const [c, r] of all) if (r !== companyRate) out.set(c, r / companyRate);
    return out;
  });
}
