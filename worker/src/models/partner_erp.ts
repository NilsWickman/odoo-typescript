/**
 * res.partner on the poc_erp template (C3 contacts kanban, form and smart buttons): the read-side Python of the
 * installed apps extending res.partner. Each compute cites its source; data the computes would need porting for
 * (meetings ahead, on-time purchase lines, posted receivables, edi proxy users) refuses with NotPorted.
 * Registered only when the module is installed (the model's `modules`, gen/out/<template>/models.json), so the
 * poc_corpus behaviour of src/models/partner_read.ts stays as it was.
 */
import { qrMethods } from "./account_computes";
import { NotPorted } from "../errors";
import { registerMethod } from "../http/methods";
import { and, cond } from "../orm/domain";
import { hasGroup, userInfo } from "../orm/env";
import { registerHooks } from "../orm/hooks";
import { pySetOrder } from "../orm/pyset";
import { type PrivateRecs } from "../orm/private_hooks";
import { isPyFloat } from "../orm/values";
import type { Domain, Environment } from "../orm/types";
import { dbNow, todayInTz, translate, validTz } from "./util";
import * as priv from "../orm/dispatch_gen";

const num = (v: unknown): number => (typeof v === "number" ? v : isPyFloat(v) ? v.float : 0);

const MODEL = "res.partner";

function each(ids: readonly number[], fn: (id: number) => unknown): Map<number, unknown> {
  return new Map(ids.map((id) => [id, fn(id)]));
}

/** Python `while partner: ...; partner = partner.parent_id`: the partner and all its ancestors. */
async function ancestors(env: Environment, id: number): Promise<number[]> {
  const row = (await env.cr.query<{ parent_path: string | null }>(
    `WITH RECURSIVE up(id, parent_id) AS (SELECT id, parent_id FROM res_partner WHERE id = $1
       UNION ALL SELECT p.id, p.parent_id FROM res_partner p JOIN up ON p.id = up.parent_id)
     SELECT string_agg(id::text, '/') AS parent_path FROM up`, [id])).rows[0];
  return (row?.parent_path ?? "").split("/").filter(Boolean).map(Number);
}

/**
 * The "children partners" counters (account partner.py:1208 `_compute_account_move_count`, :691, crm
 * res_partner.py:26, sale :67, purchase :20, project :29): `_read_group` as the user of `model` on the partner and its
 * children (`child_of`, active_test=False), each count added to every ancestor among `ids`.
 */
async function childCounts(env: Environment, ids: readonly number[], model: string, extra: Domain | null, modelEnv?: Environment): Promise<Map<number, number>> {
  const out = new Map<number, number>(ids.map((id) => [id, 0]));
  if (ids.length === 0) return out;
  const all = await env.withContext({ ...env.context, active_test: false }).model(MODEL).search(cond("id", "child_of", [...ids]), { activeTest: false });
  const domain = extra === null ? cond("partner_id", "in", all) : and([extra, cond("partner_id", "in", all)]);
  const recs = await (modelEnv ?? env).model(model).search(domain);
  if (recs.length === 0) return out;
  const def = env.reg.model(model);
  const rows = (await env.cr.query<{ partner_id: number; n: string }>(
    `SELECT partner_id, count(*)::text AS n FROM "${def.table}" WHERE id = ANY($1::int[]) AND partner_id IS NOT NULL GROUP BY partner_id`, [recs])).rows;
  const self = new Set(ids);
  for (const r of rows) {
    for (const p of await ancestors(env, r.partner_id)) if (self.has(p)) out.set(p, (out.get(p) ?? 0) + Number(r.n));
  }
  return out;
}

/**
 * account partner.py:760-763 `_get_suggested_invoice_edi_format` of a commercial partner (False in the installed
 * modules; l10n_dk's oioubl_21 for a Danish partner, l10n_it_edi, l10n_fr_pdp ...): a hook. `recs` for a new one.
 */
export async function suggestedEdiFormat(env: Environment, id: number | null, recs?: PrivateRecs): Promise<string | false> {
  const v = await priv.res_partner._get_suggested_invoice_edi_format.call(env, id === null ? [] : [id], [], async () => false, undefined, recs);
  if (v !== false && v !== null && typeof v !== "string") throw new NotPorted(`_get_suggested_invoice_edi_format giving ${JSON.stringify(v)}`);
  return v || false;
}

export const accountMoveCount = (env: Environment, ids: readonly number[]): Promise<Map<number, number>> =>
  childCounts(env, ids, "account.move", cond("move_type", "in", ["out_invoice", "out_refund"]));

/** account partner.py:691-708 (with `_check_company_domain(env.company)`: company_id in (False, company)). */
async function supplierInvoiceCount(env: Environment, ids: readonly number[]): Promise<Map<number, number>> {
  return childCounts(env, ids, "account.move", and([
    cond("company_id", "in", [false, await env.company()]), cond("move_type", "in", ["in_invoice", "in_refund"])]));
}

const opportunityCount = async (env: Environment, ids: readonly number[]): Promise<Map<number, number>> => {
  if (!(await hasGroup(env, "sales_team.group_sale_salesman"))) return new Map(ids.map((id) => [id, 0]));
  return childCounts(env, ids, "crm.lead", null, env.withContext({ ...env.context, active_test: false }));
};

const saleOrderCount = async (env: Environment, ids: readonly number[]): Promise<Map<number, number>> => {
  if (!(await hasGroup(env, "sales_team.group_sale_salesman"))) return new Map(ids.map((id) => [id, 0]));
  return childCounts(env, ids, "sale.order", null); // _get_sale_order_domain_count: [] (sale res_partner.py:56)
};

const purchaseOrderCount = (env: Environment, ids: readonly number[]): Promise<Map<number, number>> =>
  childCounts(env, ids, "purchase.order", null);

/** calendar res_partner.py:56-80 `_compute_meeting`: the valid events of the partner and its children. */
async function meetingCounts(env: Environment, ids: readonly number[]): Promise<Map<number, number>> {
  const all = await env.withContext({ ...env.context, active_test: false }).model(MODEL).search(cond("id", "child_of", [...ids]), { activeTest: false });
  const events = new Set(await env.model("calendar.event").search(cond("res_model", "!=", "hr.leave")));
  const links = (await env.cr.query<{ res_partner_id: number; calendar_event_id: number }>(
    "SELECT DISTINCT res_partner_id, calendar_event_id FROM calendar_event_res_partner_rel WHERE res_partner_id = ANY($1::int[])", [all])).rows
    .filter((l) => events.has(l.calendar_event_id));
  const meetings = new Map<number, Set<number>>();
  for (const l of links) meetings.set(l.res_partner_id, new Set([...(meetings.get(l.res_partner_id) ?? []), l.calendar_event_id]));
  const allSet = new Set(all), self = new Set(ids);
  // :72-78: add each partner's events to its ancestors inside all_partners that are in self
  for (const p of [...meetings.keys()]) {
    const chain = await ancestors(env, p);
    for (const a of chain.slice(1)) {
      if (!allSet.has(a)) break;
      if (self.has(a)) meetings.set(a, new Set([...(meetings.get(a) ?? []), ...(meetings.get(p) ?? [])]));
    }
  }
  return new Map(ids.map((id) => [id, meetings.get(id)?.size ?? 0]));
}

/** calendar res_partner.py:28-45 `_compute_meeting_display`. */
async function meetingDisplay(env: Environment, ids: readonly number[], which: "label" | "date"): Promise<Map<number, unknown>> {
  const now = await dbNow(env);
  const upcoming = await env.model("calendar.event").search(and([cond("res_model", "!=", "hr.leave"),
    cond("start", ">=", now.toISOString().slice(0, 19).replace("T", " "))]));
  const linked = upcoming.length === 0 ? [] : (await env.cr.query<{ res_partner_id: number }>(
    "SELECT DISTINCT res_partner_id FROM calendar_event_res_partner_rel WHERE calendar_event_id = ANY($1::int[]) AND res_partner_id = ANY($2::int[])",
    [upcoming, ids])).rows.map((r) => r.res_partner_id);
  if (linked.length) throw new NotPorted("res.partner next meeting date (context_timestamp of the next event)");
  const counts = await meetingCounts(env, ids);
  return each(ids, (id) => (which === "date" ? false : translate(env, (counts.get(id) ?? 0) ? "Meetings" : "No Meetings")));
}

async function companyCurrency(env: Environment): Promise<number | false> {
  return (await env.cr.query<{ currency_id: number }>("SELECT currency_id FROM res_company WHERE id = $1", [await env.company()])).rows[0]?.currency_id ?? false;
}

/** product product_pricelist.py:375-417 `_get_country_pricelist_multi` for the env's company (no `country_code`). */
export async function countryPricelists(env: Environment, countryIds: readonly (number | null)[]): Promise<Map<number | null, number | false>> {
  if (env.context["country_code"]) throw new NotPorted("product.pricelist _get_country_pricelist_multi with a country_code context");
  const company = await env.company();
  // :462-466 the domain hook, in the pricelists' order (sequence, id, name)
  const first = async (extra: string, params: unknown[]): Promise<number | false> => (await env.cr.query<{ id: number }>(
    `SELECT p.id FROM product_pricelist p WHERE p.active AND (p.company_id = $1 OR p.company_id IS NULL) ${extra}
      ORDER BY p.sequence, p.id, p.name->>'en_US' LIMIT 1`, [company, ...params])).rows[0]?.id ?? false;
  let fallback = await first("AND NOT EXISTS (SELECT 1 FROM res_country_group_pricelist_rel r WHERE r.pricelist_id = p.id)", []);
  if (fallback === false) {
    const icp = async (key: string): Promise<number | false> => {
      const v = (await env.cr.query<{ value: string }>("SELECT value FROM ir_config_parameter WHERE key = $1", [key])).rows[0]?.value;
      const n = v === undefined ? 0 : parseInt(v, 10);
      if (!n) return false;
      return (await env.cr.query("SELECT 1 FROM product_pricelist WHERE id = $1", [n])).rows.length ? n : false;
    };
    fallback = await icp(`res.partner.property_product_pricelist_${company}`) || await icp("res.partner.property_product_pricelist") || await first("", []);
  }
  const out = new Map<number | null, number | false>();
  for (const country of countryIds) {
    if (country === null) continue;
    const pl = await first(`AND EXISTS (SELECT 1 FROM res_country_group_pricelist_rel r JOIN res_country_res_country_group_rel cg
      ON cg.res_country_group_id = r.res_country_group_id WHERE r.pricelist_id = p.id AND cg.res_country_id = $2)`, [country]);
    out.set(country, pl || fallback);
  }
  out.set(null, fallback);
  return out;
}

/** product res_partner.py:41-53 via product.pricelist `_get_partner_pricelist_multi` (product_pricelist.py:421-460). */
export async function pricelists(env: Environment, ids: readonly number[]): Promise<Map<number, unknown>> {
  // res_groups.py:574-575 `_is_feature_enabled`: the superuser has the pricelist group
  const enabled = await superuserHasGroup(env, "product.group_product_pricelist");
  if (!enabled) return each(ids, () => false);
  const company = await env.company();
  const out = new Map<number, unknown>();
  const remaining: { id: number; country: number | null }[] = [];
  for (const id of ids) {
    const r = (await env.cr.query<{ specific: number | null; active: boolean | null; country: number | null }>(
      `SELECT pl.id AS specific, pl.active, p.country_id AS country FROM res_partner p
         LEFT JOIN product_pricelist pl ON pl.id = (p.specific_property_product_pricelist->>$2::text)::int WHERE p.id = $1`, [id, String(company)])).rows[0];
    if (r?.specific && r.active) out.set(id, r.specific);
    else remaining.push({ id, country: r?.country ?? null });
  }
  if (remaining.length) {
    const byCountry = await countryPricelists(env, [...new Set(remaining.map((r) => r.country))]);
    for (const r of remaining) out.set(r.id, byCountry.get(r.country) ?? false);
  }
  return out;
}

/** `res.users.browse(SUPERUSER_ID)._has_group(xmlid)`: the group or one implying it (res_users.py). */
export async function superuserHasGroup(env: Environment, xmlid: string): Promise<boolean> {
  const [module, name] = xmlid.split(".");
  const r = await env.cr.query(
    `WITH RECURSIVE g(id) AS (SELECT gid FROM res_groups_users_rel WHERE uid = 1
       UNION SELECT r.hid FROM res_groups_implied_rel r JOIN g ON g.id = r.gid)
     SELECT 1 FROM g JOIN ir_model_data d ON d.res_id = g.id AND d.model = 'res.groups' WHERE d.module = $1 AND d.name = $2 LIMIT 1`, [module, name]);
  return r.rows.length > 0;
}

/** base res_partner.py:58-122 `_ref_vat`: example VAT numbers per country code (the `_lt` ones are translatable). */
export const REF_VAT: Readonly<Record<string, string>> = {
  al: "ALJ91402501L",
  ar: "20055361682",
  at: "ATU12345675",
  au: "83 914 571 673",
  be: "BE0477472701",
  bg: "BG1234567892",
  br: "either 11 digits for CPF or 14 characters for CNPJ",
  ca: "123456782 or 123456782RT0001",
  cr: "3101012009",
  ch: "CHE-123.456.788 TVA or CHE-123.456.788 MWST or CHE-123.456.788 IVA",
  cl: "76086428-5",
  co: "213123432-1",
  cy: "CY10259033P",
  cz: "CZ12345679",
  de: "DE123456788 or 12/345/67890",
  dk: "DK12345674",
  do: "1-01-85004-3 or 101850043",
  ec: "1792060346001 or 1792060346",
  ee: "EE123456780",
  es: "ESA12345674",
  fi: "FI12345671",
  fr: "FR23334175221",
  gb: "GB123456782 or XI123456782",
  gr: "EL123456783",
  hu: "HU12345676 or 12345678-1-11 or 8071592153",
  hr: "HR01234567896",
  id: "1234567890123456",
  ie: "IE1234567FA",
  il: "XXXXXXXXX [9 digits] and it should respect the Luhn algorithm checksum",
  in: "12AAAAA1234AAZA",
  is: "IS062199",
  it: "IT12345670017",
  jp: "T7000012050002",
  kr: "123-45-67890 or 1234567890",
  lt: "LT123456715",
  lu: "LU12345613",
  lv: "LV41234567891",
  ma: "12345678",
  mc: "FR53000004605",
  mt: "MT12345634",
  mx: "GODE561231GR8",
  nl: "NL123456782B90",
  no: "NO123456785",
  nz: "49-098-576 or 49098576",
  pe: "10XXXXXXXXY or 20XXXXXXXXY or 15XXXXXXXXY or 16XXXXXXXXY or 17XXXXXXXXY",
  ph: "123-456-789-123",
  pk: "1234567 or B594380 or 1234567-8 or 12345-1234567-8",
  pl: "PL1234567883",
  pt: "PT123456789",
  ro: "RO1234567897 or 8001011234567 or 9000123456789",
  rs: "RS101134702",
  ru: "123456789047",
  se: "SE123456789701",
  si: "SI12345679",
  sk: "SK2022749619",
  sm: "SM24165",
  th: "0123456789016 or 1234545678781 [13 digits]",
  tr: "11111111111 (NIN) or 2222222222 (VKN)",
  ua: "12345678 or UA12345678 (EDRPOU), 1234567890 (RNOPP) or 123456789012 (IPN)",
  uy: 'Example: \'219999830019\' (format: 12 digits, all numbers, valid check digit)',
  uz: "123456789 (TIN) or 12345678901234 (PINFL)",
  ve: "V-12345678-1, V123456781, V-12.345.678-1",
  xi: "XI123456782",
  sa: '310175397400003 [Fifteen digits, first and last digits should be "3"]',
};

/** account/models/company.py:37-53 PEPPOL_LIST. */
const PEPPOL_LIST = new Set(["AT", "BE", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "IE", "IS", "LT", "LU", "LV", "MT", "NL", "NO",
  "SE", "SI", "AD", "AL", "AX", "BA", "BG", "BL", "GB", "GF", "GP", "GR", "HR", "HU", "IT", "LI", "MC", "ME", "MF", "MK", "MQ", "NC", "PF", "PL",
  "PM", "PT", "RE", "RO", "RS", "SK", "SM", "TF", "TR", "VA", "WF", "YT"]);

/** account_edi_ubl_cii/tools/partner_identifiers.py:61 */
const DEPRECATED_EAS = new Set(["0037", "0213", "9955", "0193"]);

async function partnerRows(env: Environment, ids: readonly number[]): Promise<Map<number, Record<string, unknown>>> {
  const rows = await env.sudo().withContext({ ...env.context, active_test: false }).model(MODEL).read([...ids],
    ["country_id", "invoice_sending_method", "routing_scheme", "commercial_partner_id", "company_id", "credit_limit"], "");
  return new Map(rows.map((r) => [Number(r["id"]), r]));
}

function selectionKeys(env: Environment, field: string): string[] {
  return (env.reg.model(MODEL).fields.get(field)?.selection ?? []).map((s) => s.value);
}

async function checkCompanyDomain(env: Environment, paymentType: string): Promise<string> {
  const company = await env.company();
  return `['|', ('company_id', '=', False), ('company_id', 'parent_of', [allowed_company_ids[0]])] + `
    + `[('journal_id.active', '=', True), ('payment_type', '=', '${paymentType}'), ('company_id', 'parent_of', ${company})]`;
}

/** account partner.py:361-368 for one record: the fiscal countries of its company (else env.companies) and its own
 * country code, `",".join(set(...))`. */
export async function fiscalCountryCodes(env: Environment, company: number | null, countryCode: string | null): Promise<string> {
  const companies = company !== null ? [company] : [...await env.companies()];
  // `allowed_companies.mapped('account_fiscal_country_id.code')`: the countries in company order, once each
  const rows = (await env.cr.query<{ id: number; fc: number | null; code: string | null }>(
    `SELECT co.id, co.account_fiscal_country_id AS fc, c.code FROM res_company co LEFT JOIN res_country c ON c.id = co.account_fiscal_country_id WHERE co.id = ANY($1::int[])`, [companies])).rows;
  const byCompany = new Map(rows.map((x) => [x.id, x]));
  const seen = new Set<number>();
  const codes: string[] = [];
  for (const c of companies) {
    const f = byCompany.get(c);
    if (!f?.fc || seen.has(f.fc)) continue;
    seen.add(f.fc);
    if (f.code) codes.push(f.code);
  }
  if (countryCode) codes.push(countryCode);
  // `",".join(set(country_codes))`: the order of the Python set (src/orm/pyset.ts, PYTHONHASHSEED=0)
  return pySetOrder(codes).join(",");
}

registerHooks(MODEL, {
  selection: {
    qr_code_method: qrMethods, // account partner.py:353-358 (src/models/account_computes.ts)
  },
  descriptionDomain: {
    // product/models/res_partner.py:20 `domain=lambda self: [('company_id', 'in', (self.env.company.id, False))]`
    property_product_pricelist: async (env) => [["company_id", "in", [await env.company(), false]]],
    // account/models/partner.py:662-674, check_company + company_dependent (fields_relational.py:125-153): the
    // string `f"{company_domain} + {domain}"` with `_check_company_domain(companies=unquote('[allowed_company_ids[0]]'))`
    property_outbound_payment_method_line_id: async (env) => checkCompanyDomain(env, "outbound"),
    property_inbound_payment_method_line_id: async (env) => checkCompanyDomain(env, "inbound"),
  },
  computed: {
    // base res_partner.py:407-416 with the hooks of account (partner.py:748), crm (res_partner.py:41), purchase
    // (res_partner.py:54) and sale (res_partner.py:57), in module order; an empty list caches as None
    application_statistics: async (env, ids) => {
      const modules = env.reg.model(MODEL).modules ?? [];
      for (const m of ["point_of_sale", "repair"]) if (modules.includes(m)) throw new NotPorted(`${m} application statistics`);
      const data = new Map<number, unknown[]>(ids.map((id) => [id, []]));
      if (modules.includes("account") && await hasGroup(env, "account.group_account_invoice")) {
        const a = await accountMoveCount(env, ids), s = await supplierInvoiceCount(env, ids);
        for (const id of ids) {
          const n = (a.get(id) ?? 0) + (s.get(id) ?? 0);
          if (n) data.get(id)!.push({ icon: "edit_square", value: n, label: translate(env, "Invoices/Bills/Mandates") });
        }
      }
      if (modules.includes("crm") && await hasGroup(env, "sales_team.group_sale_salesman")) {
        const o = await opportunityCount(env, ids);
        for (const id of ids) if (o.get(id)) data.get(id)!.push({ icon: "star", iconClass: "oi-filled", value: o.get(id), label: translate(env, "Opportunities") });
      }
      if (modules.includes("purchase") && await hasGroup(env, "purchase.group_purchase_user")) {
        const p = await purchaseOrderCount(env, ids);
        for (const id of ids) if (p.get(id)) data.get(id)!.push({ icon: "credit_card", value: p.get(id), label: translate(env, "Purchases") });
      }
      if (modules.includes("sale") && await hasGroup(env, "sales_team.group_sale_salesman")) {
        const so = await saleOrderCount(env, ids);
        for (const id of ids) if (so.get(id)) data.get(id)!.push({ icon: "shopping_cart", value: so.get(id), label: translate(env, "Sale Orders") });
      }
      return each(ids, (id) => (data.get(id)!.length ? data.get(id) : null));
    },
    opportunity_count: async (env, ids) => opportunityCount(env, ids),
    sale_order_count: async (env, ids) => saleOrderCount(env, ids),
    purchase_order_count: async (env, ids) => purchaseOrderCount(env, ids),
    supplier_invoice_count: async (env, ids) => supplierInvoiceCount(env, ids),
    // project res_partner.py:29-46
    task_count: async (env, ids) => childCounts(env, ids, "project.task", null),
    // payment res_partner.py:17-23 (no child_of)
    payment_token_count: async (env, ids) => {
      const tokens = await env.model("payment.token").search(cond("partner_id", "in", [...ids]));
      if (tokens.length) throw new NotPorted("res.partner.payment_token_count with tokens");
      return each(ids, () => 0);
    },
    // account partner.py:685-689
    bank_account_count: async (env, ids) => {
      const banks = await env.model("res.partner.bank").search(cond("partner_id", "in", [...ids]));
      const rows = banks.length ? (await env.cr.query<{ partner_id: number; n: string }>(
        "SELECT partner_id, count(*)::text AS n FROM res_partner_bank WHERE id = ANY($1::int[]) GROUP BY partner_id", [banks])).rows : [];
      const by = new Map(rows.map((r) => [r.partner_id, Number(r.n)]));
      return each(ids, (id) => by.get(id) ?? 0);
    },
    meeting_count: async (env, ids) => meetingCounts(env, ids),
    meeting_display_label: async (env, ids) => meetingDisplay(env, ids, "label"),
    meeting_next_date: async (env, ids) => meetingDisplay(env, ids, "date"),
    // account partner.py:542-544 `_get_company_currency`
    currency_id: async (env, ids) => {
      const rows = await partnerRows(env, ids);
      const fallback = await companyCurrency(env);
      const out = new Map<number, unknown>();
      for (const id of ids) {
        const c = rows.get(id)?.["company_id"];
        out.set(id, typeof c === "number"
          ? (await env.cr.query<{ currency_id: number }>("SELECT currency_id FROM res_company WHERE id = $1", [c])).rows[0]?.currency_id ?? fallback
          : fallback);
      }
      return out;
    },
    // account partner.py:474-512 `_invoice_total` (the same SQL)
    total_invoiced: async (env, ids) => {
      const rows = (await env.cr.query<{ partner_id: number; total: string | number }>(
        `SELECT move.partner_id, SUM(move.amount_total_signed * COALESCE(currency_rate.rate, 1)) AS total
           FROM account_move move
           LEFT JOIN res_partner partner ON partner.id = move.partner_id
           LEFT JOIN res_company company ON company.id = COALESCE(partner.company_id, $3)
           LEFT JOIN LATERAL (SELECT rate FROM res_currency_rate WHERE company_id = move.company_id AND currency_id = company.currency_id
                               AND name < move.date ORDER BY name DESC LIMIT 1) currency_rate ON TRUE
          WHERE move.state NOT IN ('draft', 'cancel') AND move.company_id = ANY($1::int[]) AND move.partner_id = ANY($2::int[])
            AND move.move_type IN ('out_invoice', 'out_refund')
          GROUP BY move.partner_id`, [[...await env.companies()], ids, await env.company()])).rows;
      const by = new Map(rows.map((r) => [r.partner_id, Number(r.total)]));
      return each(ids, (id) => by.get(id) ?? 0);
    },
    // account partner.py:390-431 `_credit_debit_get`
    credit: async (env, ids) => receivablesOf(env, ids, "credit"),
    debit: async (env, ids) => receivablesOf(env, ids, "debit"),
    // account partner.py:513-530: credit / sale-type totals * days since the oldest invoice; 0 without credit
    // the sale-type moves (get_sale_types(include_receipts=True)) of env.company grouped by commercial partner; the
    // lookup is by the partner itself (`commercial_partners.get(partner)`), so only commercial partners match
    days_sales_outstanding: async (env, ids) => {
      const credit = await receivablesOf(env, ids, "credit");
      const rows = (await env.cr.query<{ cp: number; dmin: string | null; total: string | number | null }>(
        `SELECT commercial_partner_id AS cp, min(invoice_date)::text AS dmin, sum(amount_total_signed) AS total FROM account_move
          WHERE state NOT IN ('draft', 'cancel') AND move_type IN ('out_invoice', 'out_refund', 'out_receipt')
            AND company_id = $1 AND commercial_partner_id = ANY($2::int[]) GROUP BY commercial_partner_id`,
        [await env.company(), ids])).rows;
      const by = new Map(rows.map((r) => [r.cp, r]));
      const today = todayInTz(await dbNow(env), validTz(env.context.tz) ?? validTz((await userInfo(env)).tz) ?? "UTC");
      return each(ids, (id) => {
        const r = by.get(id);
        const total = r ? Number(r.total ?? 0) : 0;
        if (!total) return 0;
        if (!r?.dmin) throw new NotPorted("days_sales_outstanding without invoice dates");
        const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${r.dmin}T00:00:00Z`)) / 86_400_000);
        const c = credit.get(id);
        const cv = typeof c === "number" ? c : isPyFloat(c) ? c.float : 0;
        return (cv / total) * days;
      });
    },
    // account partner.py:731-736: credit_limit != the company-dependent fallback
    use_partner_credit_limit: async (env, ids) => {
      const fallback = (await env.cr.query<{ json_value: string | null }>(
        `SELECT d.json_value FROM ir_default d JOIN ir_model_fields f ON f.id = d.field_id WHERE f.model = 'res.partner'
          AND f.name = 'credit_limit' AND d.user_id IS NULL AND (d.company_id IS NULL OR d.company_id = $1) AND d.condition IS NULL
          ORDER BY d.company_id NULLS LAST LIMIT 1`, [await env.company()])).rows[0]?.json_value;
      const limit = fallback ? Number(JSON.parse(fallback)) : 0;
      const rows = await partnerRows(env, ids);
      return each(ids, (id) => {
        const v = rows.get(id)?.["credit_limit"];
        return (typeof v === "number" ? v : isPyFloat(v) ? v.float : 0) !== limit;
      });
    },
    // account partner.py:744-746
    show_credit_limit: async (env, ids) => {
      const v = (await env.cr.query<{ v: boolean | null }>("SELECT account_use_credit_limit AS v FROM res_company WHERE id = $1", [await env.company()])).rows[0]?.v;
      return each(ids, () => v === true);
    },
    // account partner.py:532-540, account_move.py:7242-7254, :7745-7757: the invoice reports whose domain the new
    // out_invoice/out_refund/out_receipt moves satisfy
    available_invoice_template_pdf_report_ids: async (env, ids) => invoiceReports(env, ids),
    display_invoice_template_pdf_report_id: async (env, ids) => {
      const r = await invoiceReports(env, ids);
      return each(ids, (id) => ((r.get(id) as number[] | undefined)?.length ?? 0) > 1);
    },
    // account partner.py:676-679 `_get_additional_identifier('EAN_GLN')`
    global_location_number: async (env, ids) => {
      const rows = await env.sudo().model(MODEL).read([...ids], ["additional_identifiers"], "");
      return new Map(rows.map((r) => {
        const v = r["additional_identifiers"];
        const gln = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>)["EAN_GLN"] : undefined;
        return [Number(r["id"]), gln || false];
      }));
    },
    // account partner.py:1194-1201
    partner_vat_placeholder: async (env, ids) => {
      const rows = await partnerRows(env, ids);
      const out = new Map<number, unknown>();
      for (const id of ids) {
        const c = rows.get(id)?.["country_id"];
        if (typeof c === "number") {
          const code = (await env.cr.query<{ code: string }>("SELECT code FROM res_country WHERE id = $1", [c])).rows[0]?.code?.toLowerCase() ?? "";
          // `self.env._(expected_vat)`: the example in the env lang (util.translate refuses other languages)
          out.set(id, translate(env, REF_VAT[code] ?? "", "account"));
          continue;
        }
        out.set(id, translate(env, "", "account"));
      }
      return out;
    },
    // account partner.py:361-368: the fiscal countries of the record's company (else the allowed companies) and the
    // record's country, `",".join(set(...))`
    fiscal_country_codes: async (env, ids) => {
      const rows = await env.sudo().withContext({ ...env.context, active_test: false }).model(MODEL).read([...ids], ["company_id", "country_code"], "");
      const out = new Map<number, unknown>();
      for (const r of rows) {
        out.set(Number(r["id"]), await fiscalCountryCodes(env, typeof r["company_id"] === "number" ? r["company_id"] : null, r["country_code"] ? String(r["country_code"]) : null));
      }
      return out;
    },
    // account partner.py:637: a non-stored field without compute reads its default (fields.py:1858):
    // `len(invoice_edi_format._description_selection(env))`, as a Boolean
    display_invoice_edi_format: async (env, ids) => {
      const sel = env.reg.model(MODEL).fields.get("invoice_edi_format")?.selection;
      if (sel === null || sel === undefined) throw new NotPorted("dynamic invoice_edi_format selection");
      return each(ids, () => sel.length > 0);
    },
    // account partner.py:713-719: the commercial partner's stored format, else its suggested one
    invoice_edi_format: async (env, ids) => {
      const rows = await partnerRows(env, ids);
      // the commercial partners' stored formats read together (their prefetch, as `partner.commercial_partner_id`)
      const cps = [...new Set(ids.map((id) => rows.get(id)?.["commercial_partner_id"]).filter((cp): cp is number => typeof cp === "number"))];
      const stored = new Map((cps.length ? await env.sudo().withContext({ ...env.context, active_test: false }).model(MODEL).read(cps, ["invoice_edi_format_store"], "") : [])
        .map((r) => [Number(r["id"]), r["invoice_edi_format_store"]]));
      const out = new Map<number, unknown>();
      for (const id of ids) {
        const cp = rows.get(id)?.["commercial_partner_id"];
        if (typeof cp !== "number") { out.set(id, false); continue; }
        const store = stored.get(cp) || null;
        out.set(id, store === "none" ? false : store || await suggestedEdiFormat(env, cp));
      }
      return out;
    },
    // account_peppol res_partner.py:53-59
    available_peppol_sending_methods: async (env, ids) => {
      const code = (await env.cr.query<{ code: string | null }>(
        `SELECT c.code FROM res_company co JOIN res_partner p ON p.id = co.partner_id LEFT JOIN res_country c ON c.id = p.country_id WHERE co.id = $1`,
        [await env.company()])).rows[0]?.code ?? null;
      const methods = selectionKeys(env, "invoice_sending_method").filter((m) => m !== "peppol" || (code !== null && PEPPOL_LIST.has(code)));
      return each(ids, () => methods);
    },
    // account_peppol res_partner.py:61-68
    available_peppol_edi_formats: async (env, ids) => {
      const rows = await partnerRows(env, ids);
      return each(ids, (id) => {
        if (rows.get(id)?.["invoice_sending_method"] === "peppol") throw new NotPorted("peppol edi formats (_get_peppol_formats)");
        return selectionKeys(env, "invoice_edi_format");
      });
    },
    // account_edi_ubl_cii res_partner.py:177-184 with account_peppol res_partner.py:70-77
    available_routing_schemes: async (env, ids) => {
      const rows = await partnerRows(env, ids);
      const proxies = (await env.cr.query<{ n: string }>("SELECT count(*)::text AS n FROM account_edi_proxy_client_user WHERE company_id = $1",
        [await env.company()])).rows[0]?.n ?? "0";
      if (Number(proxies) > 0) throw new NotPorted("peppol edi mode of a company with proxy users");
      const companyScheme = (await env.cr.query<{ s: string | null }>(
        "SELECT p.routing_scheme AS s FROM res_company co JOIN res_partner p ON p.id = co.partner_id WHERE co.id = $1", [await env.company()])).rows[0]?.s ?? null;
      const param = (await env.cr.query<{ value: string | null }>("SELECT value FROM ir_config_parameter WHERE key = 'account_peppol.edi.mode'")).rows[0]?.value ?? null;
      const mode = companyScheme === "odemo" ? "demo" : param || "prod"; // res_company.py:283-289
      return each(ids, (id) => {
        const scheme = rows.get(id)?.["routing_scheme"];
        const list = selectionKeys(env, "routing_scheme").filter((eas) => !DEPRECATED_EAS.has(eas) || eas === scheme);
        return mode !== "demo" ? list.filter((e) => e !== "odemo") : list;
      });
    },
    // account_peppol res_partner.py:79-86
    peppol_response_support: async (env, ids) => {
      const rows = await env.sudo().model(MODEL).read([...ids], ["peppol_verification_state", "peppol_supported_documents"], "");
      return new Map(rows.map((r) => {
        if (r["peppol_verification_state"] === "valid" && r["peppol_supported_documents"]) throw new NotPorted("peppol response support of verified partners");
        return [Number(r["id"]), false];
      }));
    },
    property_product_pricelist: async (env, ids) => pricelists(env, ids),
    // purchase_stock res_partner.py:40-73
    on_time_rate: async (env, ids) => {
      const param = (await env.cr.query<{ value: string }>("SELECT value FROM ir_config_parameter WHERE key = 'purchase_stock.on_time_delivery_days'")).rows[0]?.value;
      const days = (param && Number.parseInt(param, 10)) || 365;
      const today = (await dbNow(env)).getTime(); // fields.Date.today(): the server's (UTC) date
      const since = new Date(Date.UTC(new Date(today).getUTCFullYear(), new Date(today).getUTCMonth(), new Date(today).getUTCDate()) - days * 86_400_000).toISOString().slice(0, 10);
      const goods = await env.sudo().model("product.product").search(cond("type", "!=", "service"), { activeTest: true });
      const lines = await env.model("purchase.order.line").search(and([cond("partner_id", "in", [...ids]), cond("date_order", ">", since),
        cond("qty_received", "!=", 0), cond("order_id.state", "=", "purchase"), cond("date_promised", "!=", false), cond("product_id", "in", goods)]));
      const out = new Map<number, unknown>(ids.map((id) => [id, -1])); // no data
      if (!lines.length) return out;
      const lineRows = await env.model("purchase.order.line").read(lines, ["date_promised", "partner_id", "product_uom_qty"], "");
      const promised = new Map(lineRows.map((r) => [Number(r["id"]), String(r["date_promised"]).slice(0, 10)]));
      const moves = await env.model("stock.move").search(and([cond("purchase_line_id", "in", lines), cond("state", "=", "done")]));
      const onTimeQty = new Map<number, number>();
      if (moves.length) {
        for (const m of await env.model("stock.move").read(moves, ["purchase_line_id", "date", "quantity"], "")) {
          const line = Number(m["purchase_line_id"]);
          if (String(m["date"]).slice(0, 10) > (promised.get(line) ?? "")) continue;
          onTimeQty.set(line, (onTimeQty.get(line) ?? 0) + num(m["quantity"]));
        }
      }
      const perPartner = new Map<number, [number, number]>();
      for (const r of lineRows) {
        const partner = Number(r["partner_id"]);
        const [onTime, ordered] = perPartner.get(partner) ?? [0, 0];
        perPartner.set(partner, [onTime + (onTimeQty.get(Number(r["id"])) ?? 0), ordered + num(r["product_uom_qty"])]);
      }
      for (const [partner, [onTime, ordered]] of perPartner) if (out.has(partner)) out.set(partner, ordered ? (onTime / ordered) * 100 : -1);
      return out;
    },
  },
});

/**
 * account partner.py:390-431 `_credit_debit_get`: the residual of unreconciled posted receivable (credit) and payable
 * (debit, negated) lines of the companies under the current root company.
 */
async function receivablesOf(env: Environment, ids: readonly number[], which: "credit" | "debit"): Promise<Map<number, unknown>> {
  const root = (await env.cr.query<{ root: number }>("SELECT split_part(parent_path, '/', 1)::int AS root FROM res_company WHERE id = $1",
    [await env.company()])).rows[0]?.root ?? 0;
  const rows = (await env.cr.query<{ partner_id: number; account_type: string; val: string | number }>(
    `SELECT l.partner_id, a.account_type, SUM(l.amount_residual) AS val FROM account_move_line l
       LEFT JOIN account_account a ON a.id = l.account_id
       JOIN res_company c ON c.id = l.company_id
      WHERE a.account_type IN ('asset_receivable', 'liability_payable') AND l.partner_id = ANY($1::int[]) AND l.reconciled IS NOT TRUE
        AND l.parent_state = 'posted' AND (c.parent_path LIKE $2 || '/%')
      GROUP BY l.partner_id, a.account_type`, [ids, String(root)])).rows;
  const out = new Map<number, unknown>(ids.map((id) => [id, 0]));
  for (const r of rows) {
    if (which === "credit" && r.account_type === "asset_receivable") out.set(r.partner_id, Number(r.val));
    if (which === "debit" && r.account_type === "liability_payable") out.set(r.partner_id, -Number(r.val));
  }
  return out;
}

async function invoiceReports(env: Environment, ids: readonly number[]): Promise<Map<number, unknown>> {
  const reports = await env.model("ir.actions.report").search(and([cond("model", "=", "account.move"), cond("is_invoice_report", "=", true)]));
  const rows = await env.sudo().model("ir.actions.report").read(reports, ["domain"], "");
  const available: number[] = [];
  for (const r of rows) {
    const d = r["domain"];
    if (d && String(d).trim() !== "[]") throw new NotPorted("invoice report domains (filtered_domain on new moves)");
    available.push(Number(r["id"]));
  }
  if (available.length === 0) throw new NotPorted("no invoice template (UserError)");
  return each(ids, () => available);
}

// crm res_partner.py:52-64 `action_view_opportunity`
registerMethod(MODEL, "action_view_opportunity", async (env, ids) => {
  if (!ids) throw new NotPorted("action_view_opportunity without records");
  // ir_actions.py:206-226 `_for_xml_id` -> `_get_action_dict` (the same dict as /web/action/load)
  const { loadAction } = await import("../controllers/action");
  const action = await loadAction({ cursor: () => env.cr, context: env.context, uid: env.uid }, "crm.crm_lead_opportunities");
  action["context"] = { search_default_filter_won: 1, search_default_filter_ongoing: 1, search_default_filter_lost: 1 };
  const views = Array.isArray(action["views"]) ? [...(action["views"] as [unknown, string][])] : [];
  // sorted(views, key=lambda view: view[1] != 'list'): stable, list views first
  action["views"] = [...views.filter((v) => v[1] === "list"), ...views.filter((v) => v[1] !== "list")];
  // `_get_contact_opportunities_domain` (:23): the partners and their children (active_test=False)
  const all = await env.withContext({ ...env.context, active_test: false }).model(MODEL).search(cond("id", "child_of", ids), { activeTest: false });
  action["domain"] = [["active", "in", [true, false]], ["partner_id", "in", all]];
  return action;
}, { apiModel: false });

