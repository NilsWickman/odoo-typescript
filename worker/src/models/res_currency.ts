/**
 * `res.currency` non-stored rate fields (odoo/odoo/addons/base/models/res_currency.py:66-72 `rate`, `inverse_rate`,
 * `rate_date`, `rate_string`, computed by `_compute_current_rate` :219-238 over `_get_rates` :171-212). The web
 * client reads `inverse_rate`/`rate_date` with `to_currency` in the context (C1: monetary fields in pivot/list).
 */
import { NotPorted } from "../errors";
import { registerHooks } from "../orm/hooks";
import { userInfo } from "../orm/env";
import type { Environment } from "../orm/types";
import { dbNow, todayInTz, validTz } from "./util";

interface Rates {
  readonly rate: Map<number, number>;
  readonly date: Map<number, string | null>;
  readonly companyCurrency: number;
  readonly toCurrency: number;
  readonly names: Map<number, string>;
}

function ctxInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

async function rates(env: Environment, ids: readonly number[]): Promise<Rates> {
  const ctx = env.context;
  // :221 date = context 'date' or fields.Date.context_today(self) (fields_temporal.py:141: in the context tz)
  let date: string;
  if (typeof ctx["date"] === "string" && /^\d{4}-\d{2}-\d{2}/.test(ctx["date"])) date = ctx["date"].slice(0, 10);
  else if (ctx["date"] !== undefined && ctx["date"] !== false && ctx["date"] !== null) throw new NotPorted(`res.currency rates with context date=${JSON.stringify(ctx["date"])}`);
  else date = todayInTz(await dbNow(env), validTz(typeof ctx.tz === "string" ? ctx.tz : (await userInfo(env)).tz) ?? "UTC");
  // :222 company = browse(context company_id) or env.company; :224 _get_rates(self.env.company, date) uses env.company
  const envCompany = await env.company();
  const company = ctxInt(ctx["company_id"]) ?? envCompany;
  const comp = (await env.cr.query<{ currency_id: number }>("SELECT currency_id FROM res_company WHERE id = $1", [company])).rows[0];
  if (comp === undefined) throw new NotPorted(`res.currency rates for missing company ${company}`);
  const toCurrency = ctxInt(ctx["to_currency"]) ?? comp.currency_id;
  // :173 company.root_id of env.company
  const root = (await env.cr.query<{ root: number }>(
    "SELECT split_part(parent_path, '/', 1)::int AS root FROM res_company WHERE id = $1", [envCompany])).rows[0];
  if (root === undefined) throw new NotPorted(`res.currency rates for missing company ${envCompany}`);
  const all = [...new Set([...ids, toCurrency])];
  // :182-209: latest rate strictly before `date` of the root company or none (order company_id.id, name DESC),
  // else the earliest one; COALESCE(.., 1.0)
  const rows = (await env.cr.query<{ id: number; rate: string | number | null; name: string | null; cname: string }>(
    `SELECT c.id, c.name AS cname, COALESCE(b.rate, a.rate, 1.0) AS rate, to_char(COALESCE(b.name, a.name), 'YYYY-MM-DD') AS name
     FROM res_currency c
     LEFT JOIN LATERAL (SELECT r.rate, r.name FROM res_currency_rate r WHERE r.currency_id = c.id AND r.name < $2::date
       AND (r.company_id IS NULL OR r.company_id = $3) ORDER BY r.company_id, r.name DESC LIMIT 1) b ON TRUE
     LEFT JOIN LATERAL (SELECT r.rate, r.name FROM res_currency_rate r WHERE r.currency_id = c.id
       AND (r.company_id IS NULL OR r.company_id = $3) ORDER BY r.company_id, r.name ASC LIMIT 1) a ON TRUE
     WHERE c.id = ANY($1::int[])`, [all, date, root.root])).rows;
  const raw = new Map<number, number>();
  const dates = new Map<number, string | null>();
  const names = new Map<number, string>();
  for (const r of rows) {
    raw.set(r.id, Number(r.rate) || 1.0); // :203 `rate or 1.0`
    dates.set(r.id, r.name);
    names.set(r.id, r.cname);
  }
  const toRate = raw.get(toCurrency) ?? 1.0;
  const rate = new Map<number, number>();
  for (const id of ids) rate.set(id, (raw.get(id) ?? 1.0) / toRate); // :231
  return { rate, date: dates, companyCurrency: comp.currency_id, toCurrency, names };
}

/** Python `'%.6f' % x`. */
function fmt6(x: number): string {
  return x.toFixed(6);
}

/** `inverse_rate` for the env's context (to_currency, date): res_currency.py:232. */
export async function inverseRates(env: Environment, ids: readonly number[]): Promise<Map<number, number>> {
  const r = await rates(env, ids);
  return new Map(ids.map((id) => [id, 1 / (r.rate.get(id) ?? 1.0)]));
}

registerHooks("res.currency", {
  computed: {
    rate: async (env, ids) => new Map((await rates(env, ids)).rate),
    inverse_rate: async (env, ids) => {
      const r = await rates(env, ids);
      return new Map(ids.map((id) => [id, 1 / (r.rate.get(id) ?? 1.0)])); // :232
    },
    rate_date: async (env, ids) => {
      const r = await rates(env, ids);
      return new Map(ids.map((id) => [id, r.date.get(id) ?? false])); // :233
    },
    rate_string: async (env, ids) => {
      const r = await rates(env, ids);
      // :234-237
      return new Map(ids.map((id) => [id, id !== r.companyCurrency
        ? `1 ${r.names.get(r.toCurrency) ?? ""} = ${fmt6(r.rate.get(id) ?? 1.0)} ${r.names.get(id) ?? ""}` : ""]));
    },
  },
});
