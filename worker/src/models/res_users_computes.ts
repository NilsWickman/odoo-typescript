/**
 * Base models' list/form computes, selections and defaults of the poc_erp template: res.users access counters and
 * default groups, res.company/resource time zones, res.currency rounding warning and fiscal country codes
 * (odoo/odoo/addons/base/models/res_users.py, resource/models/res_company.py, account/models/res_currency.py).
 */
import { NotPorted, UserError } from "../errors";
import { userInfoOf } from "../orm/env";
import { hooksOf, registerHooks } from "../orm/hooks";
import { registerActivityMixin } from "./crm_activity";
import { DbRec, NewRec, type Rec, registerDefaults, registerOnchange, registerRecordCompute } from "../orm/recompute";
import { and, cond, TRUE } from "../orm/domain";
import { formatAddr } from "../mail/message";
import { ATTACHMENT_COLUMNS, attachmentValue, type AttachmentRow, binaryBytes } from "./binary";
import type { Environment } from "../orm/types";
import { defineComputes, registerDefaultValued, registerIsFollower, registerNeedaction, withCompany } from "./tail_util";
import { companyDependentFallback } from "../orm/sql";
import { REF_VAT } from "./partner_erp";
import { translate } from "./util";

/** res_users.py:569-574 _compute_accesses_count (compute_sudo): ir.access rows of all_group_ids, and their number. */
async function accessCounts(env: Environment, rec: Rec): Promise<{ accesses: number; groups: number }> {
  let groups: readonly number[];
  if (rec.id !== null) groups = (await userInfoOf(env, rec.id)).groupIds;
  else {
    // a new user: `group_ids.all_implied_ids`, the transitive closure of res_groups_implied_rel (res_groups.py:342-346)
    const direct = (await rec.rels("group_ids")).map((g) => g.origin).filter((g): g is number => g !== null);
    groups = direct.length === 0 ? [] : (await env.cr.query<{ id: number }>(
      `WITH RECURSIVE c(id) AS (SELECT unnest($1::int[]) UNION SELECT r.hid FROM res_groups_implied_rel r JOIN c ON r.gid = c.id)
       SELECT id FROM c`, [direct])).rows.map((r) => r.id);
  }
  if (groups.length === 0) return { accesses: 0, groups: 0 };
  // `groups.access_ids`: One2many('ir.access', 'group_id') with active_test (ir.access has `active`)
  const n = (await env.cr.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM ir_access WHERE group_id = ANY($1::int[]) AND active", [groups])).rows[0]?.n ?? "0";
  return { accesses: Number(n), groups: groups.length };
}

defineComputes("res.users", {
  accesses_count: async (env, rec) => (await accessCounts(env, rec)).accesses,
  groups_count: async (env, rec) => (await accessCounts(env, rec)).groups,
});

registerDefaults("res.users", {
  // res_users.py:191-200 _default_groups: base.group_user plus the implied groups of base.default_user_group
  group_ids: async (env) => {
    const user = await env.reg.xmlid(env.cr, "base.group_user");
    if (user === null) throw new NotPorted("res.users default groups without base.group_user (ValueError)");
    const ids = [user];
    const def = await env.reg.xmlid(env.cr, "base.default_user_group");
    if (def !== null) {
      // `implied_ids` reads in the order of the groups (`_order`)
      const implied = (await env.cr.query<{ hid: number }>("SELECT hid FROM res_groups_implied_rel WHERE gid = $1", [def])).rows.map((r) => r.hid);
      for (const id of await env.sudo().model("res.groups").search(cond("id", "in", implied))) if (!ids.includes(id)) ids.push(id);
    }
    return [[6, 0, ids]];
  },
});

/** base res_partner.py:133-134 `_tz_get` returns `_tzs`, the static selection of res.partner.tz. */
async function tzSelection(env: Environment): Promise<readonly [string, string][]> {
  const sel = env.reg.model("res.partner").fields.get("tz")?.selection;
  if (!sel) throw new NotPorted("res.partner.tz selection");
  // `selection=_tz_get` is a callable: fields_selection.py:206-209 returns its labels untranslated
  return sel.map((s) => [s.value, s.label] as [string, string]);
}
// resource res_company.py:15-17, resource_resource.py:62-64, resource_mixin.py:25 (selection=_tz_get)
for (const model of ["res.company", "resource.resource", "resource.calendar", "resource.calendar.leaves"]) {
  registerHooks(model, { selection: { tz: tzSelection } });
}

defineComputes("res.currency", {
  // account res_currency.py:20-26 _compute_display_rounding_warning: `_origin.id and _origin.rounding != rounding`
  display_rounding_warning: async (env, rec) => {
    if (rec.origin === null) return false;
    if (rec.id !== null) return false; // a database record is its own origin
    const origin = await new DbRec(env, env.reg.model("res.currency"), rec.origin).get("rounding");
    return origin !== (await rec.get("rounding"));
  },
});

/** The fiscal country codes of env.companies (`env.companies.mapped("account_fiscal_country_id.code")` joined by ","). */
export async function fiscalCountryCodes(env: Environment): Promise<string> {
    const companies = await env.companies();
    const rows = (await env.cr.query<{ id: number; code: string | null }>(
      `SELECT c.id, co.code FROM res_company c LEFT JOIN res_country co ON co.id = c.account_fiscal_country_id
        WHERE c.id = ANY($1::int[])`, [companies])).rows;
    const byCompany = new Map(rows.map((r) => [r.id, r.code]));
    // `companies.mapped('account_fiscal_country_id')` keeps the first occurrence of each country, empty ones dropped
    const codes: string[] = [];
    const seen = new Set<string>();
    for (const c of companies) {
      const code = byCompany.get(c);
      if (code === null || code === undefined || seen.has(code)) continue;
      seen.add(code);
      codes.push(code);
    }
    return codes.join(",");
}

registerDefaults("res.currency", {
  // account res_currency.py:14-15 _get_fiscal_country_codes: the fiscal country codes of env.companies
  fiscal_country_codes: async (env) => fiscalCountryCodes(env),
});

// account uom_uom.py:38-43 `_compute_fiscal_country_codes`
// account_edi_ubl_cii uom_uom.py:31-39 `_compute_is_unece_code_supported`: env.company's fiscal country is in the list
const UNECE_COUNTRIES = new Set(["AL", "AD", "AM", "AT", "AZ", "BY", "BE", "BA", "BG", "CA", "HR", "CY", "CZ",
  "DK", "EE", "FI", "FR", "GE", "DE", "GR", "HU", "IS", "IE", "IL", "IT", "KZ",
  "KG", "LV", "LI", "LT", "LU", "MT", "MD", "MC", "ME", "NL", "MK", "NO", "PL",
  "PT", "RO", "RU", "SM", "RS", "SK", "SI", "ES", "SE", "CH", "TJ", "TR", "TM",
  "UA", "GB", "US", "UZ", "JO", "JP", "AU", "NZ", "MY", "SA", "SG"]);
defineComputes("uom.uom", {
  fiscal_country_codes: async (env) => fiscalCountryCodes(env),
  is_unece_code_supported: async (env) => {
    const code = (await env.cr.query<{ code: string | null }>(
      "SELECT co.code FROM res_company c LEFT JOIN res_country co ON co.id = c.account_fiscal_country_id WHERE c.id = $1", [await env.company()])).rows[0]?.code;
    return typeof code === "string" && UNECE_COUNTRIES.has(code);
  },
});

/** mail_alias_domain.py:53-63: `<alias>@<domain name>`, '' without the alias. */
function aliasAddress(alias: "bounce_alias" | "catchall_alias") {
  return async (_env: Environment, rec: Rec): Promise<string> => {
    const left = await rec.get(alias);
    return left ? `${String(left)}@${String(await rec.get("name"))}` : "";
  };
}
defineComputes("mail.alias.domain", {
  bounce_email: aliasAddress("bounce_alias"),
  catchall_email: aliasAddress("catchall_alias"),
});

/** mail res_company.py:34-53 _compute_bounce / _compute_catchall: the alias domain's address, formatted with the name. */
function companyAlias(which: "bounce_email" | "catchall_email", formatted: boolean) {
  return async (env: Environment, rec: Rec): Promise<string> => {
    const domain = await rec.rel("alias_domain_id");
    if (!domain) return "";
    const email = String(await (which === "catchall_email" ? new DbRec(env.sudo(), domain.def, domain.origin ?? 0) : domain).get(which) || "");
    if (!formatted) return email;
    return formatAddr(String((await rec.get("name")) || ""), email);
  };
}
defineComputes("res.company", {
  bounce_email: companyAlias("bounce_email", false),
  bounce_formatted: companyAlias("bounce_email", true),
  catchall_email: companyAlias("catchall_email", false),
  catchall_formatted: companyAlias("catchall_email", true),
});

registerDefaults("res.company", {
  // mail res_company.py:10-11 _default_alias_domain_id: the first alias domain (as the user)
  alias_domain_id: async (env) => (await env.model("mail.alias.domain").search(TRUE, { limit: 1 }))[0] ?? false,
});

defineComputes("res.users", {
  // res_users.py:560-563 _compute_companies_count: search_count([]) of res.company as superuser
  companies_count: async (env) => env.sudo().model("res.company").searchCount(TRUE),
});
defineComputes("res.currency", {
  // base res_currency.py:214-217 _compute_is_current_company_currency
  is_current_company_currency: async (env, rec) => {
    const row = (await env.cr.query<{ currency_id: number | null }>("SELECT currency_id FROM res_company WHERE id = $1", [await env.company()])).rows[0];
    return rec.id !== null && row?.currency_id === rec.id; // a new record never equals a database record
  },
});

registerRecordCompute("res.currency", {
  // base res_currency.py:238-244 _compute_decimal_places (stored): ceil(log10(1/rounding)) for 0 < rounding < 1
  decimal_places: async (_env, rec) => {
    const rounding = Number((await rec.get("rounding")) ?? 0);
    return rounding > 0 && rounding < 1 ? Math.ceil(Math.log10(1 / rounding)) : 0;
  },
});

defineComputes("res.currency.rate", {
  // base res_currency.py:505-509 _compute_company_currency_id: (company_id or env.company.root_id).currency_id
  company_currency_id: async (env, rec) => {
    let company = await rec.get("company_id");
    if (typeof company !== "number" || !company) {
      const path = (await env.cr.query<{ parent_path: string | null }>("SELECT parent_path FROM res_company WHERE id = $1", [await env.company()])).rows[0]?.parent_path ?? "";
      company = Number(path.split("/")[0]) || null;
    }
    if (company === null) return null;
    return (await env.cr.query<{ currency_id: number | null }>("SELECT currency_id FROM res_company WHERE id = $1", [company])).rows[0]?.currency_id ?? null;
  },
});

/** The root company of a company (`root_id`, res_company.py:186-192: the first id of parent_path). */
async function rootCompany(env: Environment, company: number): Promise<number> {
  const path = (await env.cr.query<{ parent_path: string | null }>("SELECT parent_path FROM res_company WHERE id = $1", [company])).rows[0]?.parent_path ?? "";
  return Number(path.split("/")[0]) || company;
}

/** res_currency.py:474-481 `_get_last_rates_for_companies`: the latest non-zero rate of the company currency. */
async function lastCompanyRate(env: Environment, company: number): Promise<number> {
  const row = (await env.cr.query<{ rate: string | null }>(
    `SELECT r.rate::text AS rate FROM res_currency_rate r JOIN res_company c ON c.currency_id = r.currency_id
      WHERE c.id = $1 AND r.rate IS NOT NULL AND r.rate != 0 AND (r.company_id = $1 OR r.company_id IS NULL)
      ORDER BY r.name DESC, r.id DESC LIMIT 1`, [company])).rows[0];
  return row?.rate ? Number(row.rate) : 1;
}

/** res_currency.py:483-489 `_compute_company_rate` (with `_get_latest_rate`, :464-472). */
async function companyRate(env: Environment, rec: Rec): Promise<number> {
  const companyField = await rec.get("company_id");
  const company = typeof companyField === "number" && companyField ? companyField : await rootCompany(env, await env.company());
  let rate = Number((await rec.get("rate")) ?? 0);
  if (!rate) {
    const name = await rec.get("name");
    if (!name) throw new UserError("The name for the current rate is empty.\nPlease set it.");
    // a currency under creation (the parent form of the rate line) has no stored rates
    const currency = (await rec.rel("currency_id"))?.origin ?? null;
    const row = currency === null ? undefined : (await env.cr.query<{ rate: string | null }>(
      `SELECT rate::text AS rate FROM res_currency_rate WHERE currency_id = $1 AND rate IS NOT NULL AND rate != 0
         AND (company_id = $2 OR company_id IS NULL) AND name < $3 ORDER BY name DESC, id DESC LIMIT 1`, [currency, company, name])).rows[0];
    rate = row?.rate ? Number(row.rate) : 0;
  }
  return (rate || 1.0) / await lastCompanyRate(env, company);
}
// res_currency.py:491-496 @api.onchange('company_rate') _inverse_company_rate
registerOnchange("res.currency.rate", "_inverse_company_rate", ["company_rate"], async (env, rec) => {
  if (!(rec instanceof NewRec)) return;
  const companyField = await rec.get("company_id");
  const company = typeof companyField === "number" && companyField ? companyField : await rootCompany(env, await env.company());
  await rec.set("rate", Number((await rec.get("company_rate")) ?? 0) * await lastCompanyRate(env, company));
});
defineComputes("res.currency.rate", {
  company_rate: companyRate,
  // res_currency.py:498-503 _compute_inverse_company_rate
  inverse_company_rate: async (env, rec) => {
    const r = await companyRate(env, rec);
    return 1.0 / (r || 1.0);
  },
});
registerDefaultValued("res.currency", "fiscal_country_codes"); // account res_currency.py:18 store=False, default=_get_fiscal_country_codes
registerDefaultValued("ir.module.module", "total_lines_of_code");

// res.users inherits mail.thread and mail.activity.mixin itself (mail/models/res_users.py): activity, needaction and
// follower computes on its own records (res_model 'res.users'), unless a users module registered them
if (hooksOf("res.users").computed?.["activity_state"] === undefined) registerActivityMixin("res.users");
if (hooksOf("res.users").computed?.["message_needaction"] === undefined) registerNeedaction("res.users");
registerIsFollower("res.users");

// account partner.py:662-674: the payment method line domains of res.partner; on res.users the fields are delegated
// (`inherited=True` related fields have no check_company), so their description domain is the raw lambda result
registerHooks("res.users", {
  descriptionDomain: {
    ...hooksOf("res.users").descriptionDomain,
    property_outbound_payment_method_line_id: async (env) =>
      [["journal_id.active", "=", true], ["payment_type", "=", "outbound"], ["company_id", "parent_of", await env.company()]],
    property_inbound_payment_method_line_id: async (env) =>
      [["journal_id.active", "=", true], ["payment_type", "=", "inbound"], ["company_id", "parent_of", await env.company()]],
  },
});

defineComputes("res.company", {
  // account company.py:477-488 _compute_account_enabled_tax_country_ids: countries of the foreign-VAT fiscal positions
  // (searched as the user) and the fiscal country, for the user's companies
  account_enabled_tax_country_ids: async (env, rec) => {
    if (rec.id === null) return []; // a new company is not in the user's companies (:480-482)
    const companies = (await env.cr.query<{ cid: number }>("SELECT cid FROM res_company_users_rel WHERE user_id = $1", [env.uid])).rows.map((r) => r.cid);
    if (!companies.includes(rec.id)) return [];
    const fpos = await env.model("account.fiscal.position").search(and([cond("company_id", "in", [rec.id, false]), cond("foreign_vat", "!=", false)]));
    const out: number[] = [];
    if (fpos.length) {
      // `foreign_vat_fpos.country_id`: the countries in the fiscal positions' order
      const rows = (await env.cr.query<{ id: number; country_id: number | null }>(
        "SELECT id, country_id FROM account_fiscal_position WHERE id = ANY($1::int[])", [fpos])).rows;
      const byId = new Map(rows.map((r) => [r.id, r.country_id]));
      for (const f of fpos) { const c = byId.get(f); if (c && !out.includes(c)) out.push(c); }
    }
    const fiscal = await rec.get("account_fiscal_country_id");
    if (typeof fiscal === "number" && fiscal && !out.includes(fiscal)) out.push(fiscal);
    return out;
  },
});

/**
 * base res_company.py:194-200 _compute_address: the address fields (:173-176) of the partner's contact address
 * (res_partner.py:1236-1273 `address_get(['contact'])`; the company partner itself when its type is 'contact').
 */
function companyAddress(field: string) {
  return async (env: Environment, rec: Rec): Promise<unknown> => {
    const partner = await rec.get("partner_id");
    if (typeof partner !== "number" || !partner) return rec.prev(field);
    const type = (await env.cr.query<{ type: string | null }>("SELECT type FROM res_partner WHERE id = $1", [partner])).rows[0]?.type ?? null;
    if (type !== "contact") throw new NotPorted("res.company address from a non-contact partner (address_get descendants)");
    return new DbRec(env.sudo(), env.reg.model("res.partner"), partner).get(field);
  };
}
for (const field of ["street", "street2", "city", "zip", "state_id", "country_id"]) {
  if (hooksOf("res.company").computed?.[field] === undefined) defineComputes("res.company", { [field]: companyAddress(field) });
}

registerDefaults("res.company", {
  // base res_company.py:77-82 _default_currency_id: the user's company currency
  currency_id: async (env) => {
    const company = (await env.cr.query<{ currency_id: number | null }>(
      "SELECT c.currency_id FROM res_users u JOIN res_company c ON c.id = u.company_id WHERE u.id = $1", [env.uid])).rows[0]?.currency_id ?? null;
    return company ?? false;
  },
});

if (hooksOf("ir.attachment").computed?.["raw"] === undefined) {
  defineComputes("ir.attachment", {
    // base ir_attachment.py:379-385 _compute_raw: the filestore file (LocalBinaryFile, :1184-1228: the attachment's
    // name and checksum) or the database bytes (BinaryBytes with the name)
    raw: async (env, rec) => {
      if (rec.origin === null) throw new NotPorted("ir.attachment.raw of a new attachment");
      const row = (await env.cr.query<AttachmentRow>(`SELECT ${ATTACHMENT_COLUMNS} FROM ir_attachment WHERE id = $1`, [rec.origin])).rows[0];
      if (!row) return null;
      if (row.store_fname) return attachmentValue(env, { ...row, res_field: null });
      return row.db_datas && row.db_datas.byteLength ? binaryBytes(row.db_datas, row.name ?? "") : binaryBytes(new Uint8Array(), row.name ?? "");
    },
  });
}

registerRecordCompute("res.company", {
  // account company.py:471-475 _compute_account_tax_fiscal_country
  account_fiscal_country_id: async (_env, rec) => (await rec.prev("account_fiscal_country_id")) || rec.get("country_id"),
});

defineComputes("res.company", {
  // base res_company.py:238-241 _compute_color: the root company partner's color, else the root id modulo 12
  color: async (env, rec) => {
    if (rec.origin === null) return 0; // `root_id._origin.id % 12` of no record
    const root = await rootCompany(env, rec.origin);
    const color = (await env.cr.query<{ color: number | null }>(
      "SELECT p.color FROM res_company c JOIN res_partner p ON p.id = c.partner_id WHERE c.id = $1", [root])).rows[0]?.color ?? 0;
    return color || root % 12;
  },
});

registerRecordCompute("res.country", {
  // base res_country.py:168-175 _compute_image_url on a new country (the read side is src/models/config_write.ts),
  // with :12 FLAG_MAPPING and :25 NO_FLAG_COUNTRIES
  image_url: async (_env, rec) => {
    const code = await rec.get("code");
    if (typeof code !== "string" || !code || code === "AQ" || code === "SJ") return false;
    const mapping: Readonly<Record<string, string>> = { GF: "fr", BV: "no", BQ: "nl", GP: "fr", HM: "au", YT: "fr", RE: "fr", MF: "fr", UM: "us", XI: "uk" };
    return `/base/static/img/country_flags/${mapping[code] ?? code.toLowerCase()}.png`;
  },
});

defineComputes("res.company", {
  // account company.py:1267-1276 _compute_company_vat_placeholder: the example VAT of the country (or fiscal
  // country), base res_partner.py:58-120 `_ref_vat`, translated
  company_vat_placeholder: async (env, rec) => {
    const country = await rec.rel("country_id");
    const fiscal = await rec.rel("account_fiscal_country_id");
    let expected = "";
    if (country || fiscal) {
      const code = (country ? await country.get("code") : null) || (fiscal ? await fiscal.get("code") : null);
      expected = typeof code === "string" ? REF_VAT[code.toLowerCase()] ?? "" : "";
    }
    return expected ? translate(env, expected) : "";
  },
});

if (!hooksOf("res.config.settings").displayName) {
  registerHooks("res.config.settings", {
    // base res_config.py:411-416 _compute_display_name: the name of the first window action of the model, else _name
    displayName: async (env, ids) => {
      const lang = env.lang ?? "en_US";
      const actions = await env.model("ir.actions.act_window").search(cond("res_model", "=", "res.config.settings"), { limit: 1 });
      let name = "res.config.settings";
      if (actions.length) {
        const row = (await env.cr.query<{ name: string | null }>(
          "SELECT COALESCE(name->>$2, name->>'en_US') AS name FROM ir_act_window WHERE id = $1", [actions[0], lang])).rows[0];
        if (row?.name) name = row.name;
      }
      return new Map(ids.map((id) => [id, name]));
    },
  });
}

/**
 * base res_company.py:19-28 `company_default_for(fname, target_model, target_fname)`: the company field is the
 * ir.default fallback of a company-dependent field (fields.py:914-921 get_company_dependent_fallback) with the
 * company as env.company; many2one values that no longer exist are dropped (`exists()`). The users of the helper
 * (account company.py, sale/purchase/mrp_account res_company.py) are listed here; fields not in the registry are
 * never read.
 */
const COMPANY_DEFAULT_FOR: readonly (readonly [string, string, string])[] = [
  ["account_invoices_to_issue_id", "product.category", "property_account_invoices_to_issue_id"],
  ["account_invoiced_not_delivered_id", "product.category", "property_account_invoiced_not_delivered_id"],
  ["account_credit_limit", "res.partner", "credit_limit"],
  ["income_account_id", "product.category", "property_account_income_categ_id"],
  ["expense_account_id", "product.category", "property_account_expense_categ_id"],
  ["receivable_account_id", "res.partner", "property_account_receivable_id"],
  ["payable_account_id", "res.partner", "property_account_payable_id"],
  ["account_stock_valuation_id", "product.category", "property_stock_valuation_account_id"],
  ["inventory_valuation", "product.category", "property_valuation"],
  ["account_stock_journal_id", "product.category", "property_stock_journal"],
  ["cost_method", "product.category", "property_cost_method"],
  ["cash_rounding_profit_account_id", "account.cash.rounding", "profit_account_id"],
  ["cash_rounding_loss_account_id", "account.cash.rounding", "loss_account_id"],
  ["stock_account_production_cost_id", "product.category", "property_stock_account_production_cost_id"],
  ["account_bills_to_receive_id", "product.category", "property_account_bills_to_receive_id"],
  ["account_billed_not_received_id", "product.category", "property_account_billed_not_received_id"],
];
for (const [fname, targetModel, targetFname] of COMPANY_DEFAULT_FOR) {
  if (hooksOf("res.company").computed?.[fname] !== undefined) continue;
  defineComputes("res.company", {
    [fname]: async (env, rec) => {
      if (rec.id === null) throw new NotPorted(`res.company.${fname} of a new company (company_default_for)`);
      const tdef = env.reg.model(targetModel);
      const field = tdef.fields.get(targetFname);
      if (!field) throw new NotPorted(`company_default_for: ${targetModel}.${targetFname} is not in the registry`);
      const value = await companyDependentFallback(await withCompany(env, rec.id), tdef, field);
      if (field.type === "many2one") {
        if (typeof value !== "number" || !value) return null;
        const co = env.reg.model(field.relation!);
        const found = (await env.cr.query(`SELECT 1 FROM "${co.table}" WHERE id = $1`, [value])).rows.length;
        return found ? value : null;
      }
      return value;
    },
  });
}

// base res_company.py:247-255 `_onchange_state` and `_onchange_country_id`
registerOnchange("res.company", "_onchange_state", ["state_id"], async (_env, rec) => {
  const state = await rec.rel("state_id");
  const country = state ? await state.get("country_id") : null;
  if (country) await rec.set("country_id", country);
});
registerOnchange("res.company", "_onchange_country_id", ["country_id"], async (_env, rec) => {
  const country = await rec.rel("country_id");
  if (country) await rec.set("currency_id", (await country.get("currency_id")) || false);
});

// res_users.py:586-589 on_change_login: a login that is an e-mail address becomes the e-mail (tools/mail.py:797
// `single_email_re`; Python's `$` also matches before a final newline)
registerOnchange("res.users", "on_change_login", ["login"], async (_env, rec) => {
  const login = await rec.get("login");
  if (typeof login !== "string" || !login) return;
  const s = login.endsWith("\n") ? login.slice(0, -1) : login;
  if (/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}$/.test(s)) await rec.set("email", login);
});
