/**
 * The computed fields the Settings page (res.config.settings, a new record) reads, and the company and country fields
 * they reach. Each cites its Odoo compute; the constants come from gen/settings_fields.py (`data`). Anything the
 * template's data does not cover refuses.
 */
import { NotPorted, UserError } from "../errors";
import { envTz } from "../orm/env";
import { parseDomain } from "../orm/domain";
import { hooksOf } from "../orm/hooks";
import { registerOnchange, registerRecordCompute, type Rec } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { defineComputes } from "./tail_util";
import { dbNow, todayInTz, translate } from "./util";

interface SettingsConstants { peppol_list: string[]; stripe_countries: string[]; mercado_pago_countries: string[] }
let constants: Promise<SettingsConstants> | null = null;
function settingsConstants(): Promise<SettingsConstants> {
  constants ??= import("../../gen/out/poc_erp/settings_fields.json", { with: { type: "json" } }).then((m) => (m.default as unknown as { data: SettingsConstants }).data);
  return constants;
}

const id = (v: unknown): number | null => (typeof v === "number" && v ? v : null);

/** account_peppol res_company.py: `_compute_account_peppol_edi_user`, the company's peppol proxy users (o2m: active). */
export async function peppolProxyStateCanSend(env: Environment, company: number): Promise<boolean> {
  // account_peppol res_company.py `_compute_peppol_can_send` with `_get_can_send_domain` (account_edi_proxy_user.py)
  const s = (await env.cr.query<{ s: string | null }>("SELECT account_peppol_proxy_state AS s FROM res_company WHERE id = $1", [company])).rows[0]?.s ?? null;
  return s !== null && ["sender", "smp_registration", "receiver"].includes(s);
}

/** base res_company.py `_compute_parent_ids`: the ids of `parent_path`, root first (the company itself without one). */
async function parentIds(env: Environment, company: number): Promise<number[]> {
  const p = (await env.cr.query<{ p: string | null }>("SELECT parent_path AS p FROM res_company WHERE id = $1", [company])).rows[0]?.p ?? null;
  return p ? p.split("/").filter((x) => x).map(Number) : [company];
}

/** account_peppol res_company.py `_compute_peppol_parent_company_id` (routing_identifier is partner_id's). */
export async function peppolParent(env: Environment, company: number): Promise<number | null> {
  // account_edi_ubl_cii res_partner.py `_compute_routing_identifier`: "<scheme>:<endpoint>" when both are set
  const routing = async (c: number): Promise<string | null> => {
    const r = (await env.cr.query<{ s: string | null; e: string | null }>(
      "SELECT p.routing_scheme AS s, p.routing_endpoint AS e FROM res_company c JOIN res_partner p ON p.id = c.partner_id WHERE c.id = $1", [c])).rows[0];
    return r?.s && r.e ? `${r.s}:${r.e}` : null;
  };
  const own = await routing(company);
  for (const parent of (await parentIds(env, company)).reverse().slice(1)) {
    const theirs = await routing(parent);
    if ((own && own === theirs) || (!own && theirs)) return parent;
  }
  return null;
}

defineComputes("res.company", {
  account_peppol_edi_user: async (env, rec) => {
    const rows = (await env.cr.query<{ id: number }>(
      "SELECT id FROM account_edi_proxy_client_user WHERE company_id = $1 AND active AND proxy_type = 'peppol' ORDER BY id", [rec.origin])).rows;
    if (rows.length > 1) throw new NotPorted("res.company.account_peppol_edi_user with several peppol proxy users");
    return rows[0]?.id ?? false;
  },
  // account company.py `_compute_vat_disabled_available`
  vat_disabled_available: async (env, rec) => {
    const codes = await rec.get("account_fiscal_country_group_codes");
    if (Array.isArray(codes) && codes.includes("EU")) return true;
    return (await rec.get("country_code")) === "CH";
  },
  // payment res_company.py `_compute_onboarding_payment_module`
  onboarding_payment_module: async (env, rec) => {
    const currency = await rec.rel("currency_id");
    if (currency && (await currency.get("name")) === "INR") return "razorpay";
    const country = await rec.rel("country_id");
    const code = country ? String(await country.get("code")) : null;
    const c = await settingsConstants();
    if (code && c.stripe_countries.includes(code)) return "stripe";
    if (code && c.mercado_pago_countries.includes(code)) return "mercado_pago";
    return false;
  },
});

defineComputes("res.country", {
  // base res_country.py:186-193 `_compute_country_group_codes`: the codes of its groups, in res.country.group's order
  // (no _order: id; EU, EU_PREFIX, SEPA, EU-VAT, INTRASTAT for Sweden, measured on the oracle)
  country_group_codes: async (env, rec) => {
    const rows = (await env.cr.query<{ code: string | null }>(
      `SELECT g.code FROM res_country_group g JOIN res_country_res_country_group_rel r ON r.res_country_group_id = g.id
        WHERE r.res_country_id = $1 ORDER BY g.id`, [rec.origin])).rows;
    const codes = rows.map((r) => r.code).filter((c): c is string => !!c);
    return codes.length ? codes : [""];
  },
});

async function settingsCompany(rec: Rec): Promise<number> {
  const c = id(await rec.get("company_id"));
  if (c === null) throw new NotPorted("res.config.settings compute without a company");
  return c;
}

/** crm res_config_settings.py `_compute_crm_auto_assignment_data`. */
async function crmAssignment(env: Environment, rec: Rec): Promise<{ action: string; type: string; number: number; run: string | false }> {
  const cron = (await env.cr.query<{ active: boolean; interval_type: string | null; interval_number: number | null; nextcall: string | null }>(
    `SELECT c.active, c.interval_type, c.interval_number, to_char(c.nextcall, 'YYYY-MM-DD HH24:MI:SS') AS nextcall
       FROM ir_model_data d JOIN ir_cron c ON c.id = d.res_id WHERE d.module = 'crm' AND d.name = 'ir_cron_crm_lead_assign'`)).rows[0];
  if ((await rec.get("crm_use_auto_assignment")) && cron) {
    return { action: cron.active ? "auto" : "manual", type: cron.interval_type || "days", number: cron.interval_number || 1, run: cron.nextcall ?? false };
  }
  return { action: "manual", type: "days", number: 1, run: false };
}

/** crm res_config_settings.py `_compute_pls_fields`: crm.lead.scoring.frequency.field of the names in the config. */
async function plsFieldNames(env: Environment, rec: Rec): Promise<string[] | null> {
  const str = await rec.get("predictive_lead_scoring_fields_str");
  if (!str) return null;
  const names = String(str).split(",");
  const lang = env.lang ?? "en_US";
  const rows = (await env.cr.query<{ name: string | null }>(
    `SELECT COALESCE(f.field_description->>$2, f.field_description->>'en_US') AS name
       FROM crm_lead_scoring_frequency_field s JOIN ir_model_fields f ON f.id = s.field_id
      WHERE f.model = 'crm.lead' AND f.name = ANY($1::text[]) ORDER BY s.id`, [names, lang])).rows;
  return rows.map((r) => r.name ?? "");
}

/** odoo/tools/i18n.py format_list with babel's 'standard' list patterns of the language (gen/cldr.py). */
async function formatList(env: Environment, items: string[]): Promise<string> {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  const cldr = (await import("../../gen/out/cldr.json", { with: { type: "json" } })).default as unknown as { locales: Record<string, { list_patterns?: { standard: Record<string, string> } }> };
  const p = cldr.locales[env.lang ?? "en_US"]?.list_patterns?.standard;
  if (!p) throw new NotPorted(`format_list in ${env.lang ?? "en_US"} (gen/cldr.py list patterns)`);
  const fill = (pattern: string, a: string, b: string): string => pattern.replace("{0}", a).replace("{1}", b);
  if (items.length === 2) return fill(p["2"]!, items[0]!, items[1]!);
  let out = fill(p["start"]!, items[0]!, items[1]!);
  for (const x of items.slice(2, -1)) out = fill(p["middle"]!, out, x);
  return fill(p["end"]!, out, items[items.length - 1]!);
}

registerRecordCompute("res.config.settings", {
  // base res_config.py:411-416 `_compute_display_name` (the hook of src/models/res_users_computes.ts)
  display_name: async (env) => {
    const hook = hooksOf("res.config.settings").displayName;
    if (!hook) throw new NotPorted("res.config.settings display_name");
    return (await hook(env, [0])).get(0) ?? false;
  },
  // account_peppol res_config_settings.py `_compute_account_peppol_contact_email`
  account_peppol_contact_email: async (_env, rec) => {
    const company = await rec.rel("company_id");
    return company ? (await company.get("account_peppol_contact_email")) || false : false;
  },
  // base_setup res_config_settings.py:102-113: counted as superuser, with active_test
  active_user_count: async (env) => Number((await env.cr.query<{ n: string }>("SELECT count(*)::text AS n FROM res_users WHERE active AND NOT share")).rows[0]?.n ?? 0),
  company_count: async (env) => Number((await env.cr.query<{ n: string }>("SELECT count(*)::text AS n FROM res_company WHERE active")).rows[0]?.n ?? 0),
  // base_setup res_config_settings.py:115-120: `len(res.lang.get_installed())`
  language_count: async (env) => Number((await env.cr.query<{ n: string }>("SELECT count(*)::text AS n FROM res_lang WHERE active")).rows[0]?.n ?? 0),
  // base_setup res_config_settings.py:73-88 `_compute_company_informations`
  company_informations: async (env, rec) => {
    const company = await rec.rel("company_id");
    if (!company) throw new NotPorted("company_informations without a company");
    const street = await company.get("street"), street2 = await company.get("street2"), zip = await company.get("zip"), city = await company.get("city");
    let s = street ? `${String(street)}\n` : "";
    s += street2 ? `${String(street2)}\n` : "";
    s += zip ? String(zip) : "";
    s += zip && !city ? "\n" : "";
    s += zip && city ? " - " : "";
    s += city ? `${String(city)}\n` : "";
    const state = id(await company.get("state_id"));
    if (state !== null) s += `${(await env.model("res.country.state").displayName([state])).get(state) ?? ""}\n`;
    const country = id(await company.get("country_id"));
    if (country !== null) s += (await env.model("res.country").displayName([country])).get(country) ?? "";
    let vatLabel = "";
    if (country !== null) {
      vatLabel = (await env.cr.query<{ l: string | null }>("SELECT COALESCE(vat_label->>$2, vat_label->>'en_US') AS l FROM res_country WHERE id = $1", [country, env.lang ?? "en_US"])).rows[0]?.l ?? "";
    }
    const vat = await company.get("vat");
    const display = `\n${vatLabel || translate(env, "VAT", "base_setup")}: `;
    s += vat ? `${display} ${String(vat)}` : "";
    return s;
  },
  crm_auto_assignment_action: async (env, rec) => (await crmAssignment(env, rec)).action,
  crm_auto_assignment_interval_type: async (env, rec) => (await crmAssignment(env, rec)).type,
  crm_auto_assignment_interval_number: async (env, rec) => (await crmAssignment(env, rec)).number,
  crm_auto_assignment_run_datetime: async (env, rec) => (await crmAssignment(env, rec)).run,
  // account res_config_settings.py `_compute_has_chart_of_accounts`
  has_chart_of_accounts: async (env, rec) => {
    const company = await rec.rel("company_id");
    return Boolean(company && (await company.get("chart_template")));
  },
  has_accounting_entries: async (env, rec) => {
    // res_company `_existing_accounting` on root_id: the root and its children (active_test=False), any journal item
    const root = (await parentIds(env, await settingsCompany(rec)))[0]!;
    const r = await env.cr.query(
      `SELECT 1 FROM account_move_line WHERE company_id IN (SELECT id FROM res_company WHERE parent_path LIKE (SELECT parent_path FROM res_company WHERE id = $1) || '%') LIMIT 1`, [root]);
    return r.rows.length > 0;
  },
  // payment res_config_settings.py `_compute_installed_provider_id` with `_get_installed_providers_domain`
  installed_provider_id: async (env, rec) => {
    const company = await settingsCompany(rec);
    const found = await env.model("payment.provider").search(parseDomain(["&", ["module_state", "=", "installed"], "|", ["company_id", "=", false], ["company_id", "parent_of", [company]]]), { limit: 1 });
    return found[0] ?? false;
  },
  // account res_config_settings.py `_compute_is_account_peppol_eligible`
  is_account_peppol_eligible: async (_env, rec) => (await settingsConstants()).peppol_list.includes(String(await rec.get("country_code"))),
  // account_peppol res_config_settings.py `_compute_peppol_use_parent_company`
  peppol_use_parent_company: async (env, rec) => {
    const company = await settingsCompany(rec);
    const parent = await peppolParent(env, company);
    return parent !== null && parent !== company && (await peppolProxyStateCanSend(env, company)) && (await peppolProxyStateCanSend(env, parent));
  },
  peppol_parent_company_name: async (env, rec) => {
    const company = await settingsCompany(rec);
    const parent = await peppolParent(env, company);
    if (parent === null || parent === company || !(await peppolProxyStateCanSend(env, company)) || !(await peppolProxyStateCanSend(env, parent))) return false;
    return (await env.cr.query<{ name: string }>("SELECT name FROM res_company WHERE id = $1", [parent])).rows[0]?.name ?? false;
  },
  // account_peppol res_config_settings.py `_compute_peppol_participation_role` (the company's state)
  peppol_participation_role: async (env, rec) => {
    const s = (await env.cr.query<{ s: string | null }>("SELECT account_peppol_proxy_state AS s FROM res_company WHERE id = $1", [await settingsCompany(rec)])).rows[0]?.s;
    return s === "sender" ? "sending_only" : s === "smp_registration" || s === "receiver" ? "sending_and_receiving" : false;
  },
  peppol_purchase_journal_required: async (_env, rec) => ["smp_registration", "receiver"].includes(String(await rec.get("account_peppol_proxy_state"))),
  // crm res_config_settings.py `_compute_predictive_lead_scoring_field_labels`
  predictive_lead_scoring_field_labels: async (env, rec) => {
    const names = await plsFieldNames(env, rec);
    const stage = translate(env, "Stage", "crm");
    return names && names.length ? formatList(env, [stage, ...names]) : stage;
  },
  // crm res_config_settings.py `_compute_pls_start_date`
  predictive_lead_scoring_start_date: async (env, rec) => {
    const str = await rec.get("predictive_lead_scoring_start_date_str");
    const today = todayInTz(await dbNow(env), await envTz(env));
    const minus8 = (): string => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 8); return d.toISOString().slice(0, 10); };
    if (!str) return minus8();
    // fields.Date.to_date: the first 10 characters as an ISO date, else ValueError
    const s = String(str).slice(0, 10);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return minus8();
    const d = new Date(`${s}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return minus8();
    return s;
  },
  // account res_config_settings.py `_compute_terms_preview` (env.company's terms_type)
  preview_ready: async (env, rec) => {
    const own = (await env.cr.query<{ t: string | null }>("SELECT terms_type AS t FROM res_company WHERE id = $1", [await env.company()])).rows[0]?.t;
    return own === "html" && (await rec.get("terms_type")) === "html";
  },
  // stock res_config_settings.py `_compute_replenish_on_order`
  replenish_on_order: async (env) => {
    const r = (await env.cr.query<{ active: boolean }>(
      `SELECT r.active FROM ir_model_data d JOIN stock_route r ON r.id = d.res_id WHERE d.module = 'stock' AND d.name = 'route_warehouse0_mto' AND d.model = 'stock.route'`)).rows[0];
    if (!r) throw new NotPorted("replenish_on_order without the MTO route (the compute assigns nothing)");
    return r.active;
  },
});

// ---- the `@api.onchange` methods of res.config.settings in the template, in `dir()` order (Odoo collects them by name)
const S = "res.config.settings";
const on = (name: string, fields: string[], fn: Parameters<typeof registerOnchange>[3]): void => registerOnchange(S, name, fields, fn);
// auth_totp_mail res_config_settings.py
on("_onchange_auth_totp_enforce", ["auth_totp_enforce"], async (_env, rec) => {
  if (await rec.get("auth_totp_enforce")) await rec.set("auth_totp_policy", (await rec.get("auth_totp_policy")) || "employee_required");
  else await rec.set("auth_totp_policy", false);
});
// crm res_config_settings.py:71-81 with :166-171 `_get_crm_auto_assignmment_run_datetime`
on("_onchange_crm_auto_assignment_run_datetime", ["crm_auto_assignment_interval_type", "crm_auto_assignment_interval_number"], async (env, rec) => {
  const n = Number((await rec.get("crm_auto_assignment_interval_number")) || 0);
  if (n <= 0) throw new UserError(translate(env, "Repeat frequency should be positive.", "crm"));
  if (n >= 100) throw new UserError(translate(env, "Invalid repeat frequency. Consider changing frequency type instead of using large numbers.", "crm"));
  const interval = await rec.get("crm_auto_assignment_interval_type");
  let value: unknown;
  if (!interval) value = false;
  else if (interval === "manual") value = (await rec.get("crm_auto_assignment_run_datetime")) || false;
  else {
    // fields.Datetime.now() (the transaction's now, second precision) + relativedelta(<interval>=n)
    const now = await dbNow(env);
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds()));
    if (interval === "minutes") d.setUTCMinutes(d.getUTCMinutes() + n);
    else if (interval === "hours") d.setUTCHours(d.getUTCHours() + n);
    else if (interval === "days") d.setUTCDate(d.getUTCDate() + n);
    else if (interval === "weeks") d.setUTCDate(d.getUTCDate() + 7 * n);
    else throw new NotPorted(`crm_auto_assignment_interval_type ${String(interval)}`);
    value = d.toISOString().slice(0, 19).replace("T", " ");
  }
  await rec.set("crm_auto_assignment_run_datetime", value);
});
// sale wizard/res_config_settings.py
on("_onchange_group_product_variant", ["group_product_variant"], async (_env, rec) => {
  if ((await rec.get("module_sale_product_matrix")) && !(await rec.get("group_product_variant"))) await rec.set("module_sale_product_matrix", false);
});
// purchase res_config_settings.py
on("_onchange_group_product_variant_purchase", ["group_product_variant"], async (_env, rec) => {
  if ((await rec.get("module_purchase_product_matrix")) && !(await rec.get("group_product_variant"))) await rec.set("module_purchase_product_matrix", false);
});
// product res_config_settings.py
on("_onchange_group_sale_pricelist", ["group_product_pricelist"], async (env, rec) => {
  if (await rec.get("group_product_pricelist")) return undefined;
  if (!(await env.cr.query("SELECT 1 FROM product_pricelist WHERE active LIMIT 1")).rows.length) return undefined;
  return { title: "", message: translate(env, "You are deactivating the pricelist feature. Every active pricelist will be archived.", "product"), type: "" };
});
// stock res_config_settings.py
on("_onchange_group_stock_multi_locations", ["group_stock_multi_locations"], async (_env, rec) => {
  if (!(await rec.get("group_stock_multi_locations"))) await rec.set("group_stock_adv_location", false);
});
on("_onchange_group_stock_picking_batch", ["group_stock_picking_batch"], async (_env, rec) => {
  if (!(await rec.get("group_stock_picking_batch"))) await rec.set("module_stock_fleet", false);
});
on("_onchange_group_stock_production_lot", ["group_stock_production_lot"], async (_env, rec) => {
  if (!(await rec.get("group_stock_production_lot"))) { await rec.set("group_lot_on_delivery_slip", false); await rec.set("module_product_expiry", false); }
});
on("_onchange_module_purchase_product_matrix", ["module_purchase_product_matrix"], async (_env, rec) => {
  if ((await rec.get("module_purchase_product_matrix")) && !(await rec.get("group_product_variant"))) await rec.set("group_product_variant", true);
});
on("_onchange_module_stock_fleet", ["module_stock_fleet"], async (_env, rec) => {
  if ((await rec.get("module_stock_fleet")) && !(await rec.get("group_stock_picking_batch"))) await rec.set("group_stock_picking_batch", true);
});
// sale wizard/res_config_settings.py
on("_onchange_portal_confirmation_pay", ["portal_confirmation_pay"], async (_env, rec) => {
  await rec.set("prepayment_percent", (await rec.get("prepayment_percent")) || 1.0);
});
on("_onchange_prepayment_percent", ["prepayment_percent"], async (_env, rec) => {
  if (!(await rec.get("prepayment_percent"))) await rec.set("portal_confirmation_pay", false);
});
on("_onchange_quotation_validity_days", ["quotation_validity_days"], async (_env, rec) => {
  if (Number((await rec.get("quotation_validity_days")) || 0) < 0) throw new NotPorted("negative quotation_validity_days (res.company default_get)");
});
on("_onchange_sale_invoice_policy", ["sale_invoice_policy"], async (_env, rec) => {
  if ((await rec.get("sale_invoice_policy")) !== "order") await rec.set("sale_automatic_invoice", false);
});
// stock res_config_settings.py
on("_onchange_stock_confirmation_fields", ["stock_confirmation_type", "stock_text_confirmation"], async (_env, rec) => {
  if ((await rec.get("stock_text_confirmation")) && (await rec.get("stock_confirmation_type")) === "sms") await rec.set("module_stock_sms", true);
});
// account res_config_settings.py: a cash-basis tax of env.company's (check_company domain) keeps the setting on
on("_onchange_tax_exigibility", ["tax_exigibility"], async (env, rec) => {
  if (await rec.get("tax_exigibility")) return undefined;
  const company = await env.company();
  const tax = await env.model("account.tax").search(parseDomain(["&", "|", ["company_id", "=", false], ["company_id", "parent_of", [company]], ["tax_exigibility", "=", "on_payment"]]), { limit: 1 });
  if (!tax.length) return undefined;
  await rec.set("tax_exigibility", true);
  return { title: translate(env, "Error!", "account"), message: translate(env, "You cannot disable this setting because some of your taxes are cash basis. Modify your taxes first before disabling this setting.", "account"), type: "" };
});
// sale_stock res_config_settings.py
on("_onchange_use_security_lead", ["use_security_lead"], async (_env, rec) => {
  if (!(await rec.get("use_security_lead"))) await rec.set("security_lead", 0.0);
});
// stock / account res_config_settings.py
on("onchange_adv_location", ["group_stock_adv_location"], async (_env, rec) => {
  if ((await rec.get("group_stock_adv_location")) && !(await rec.get("group_stock_multi_locations"))) await rec.set("group_stock_multi_locations", true);
});
on("onchange_analytic_accounting", ["group_analytic_accounting"], async (_env, rec) => {
  if (await rec.get("group_analytic_accounting")) await rec.set("module_account_accountant", true);
});
on("onchange_module_account_budget", ["module_account_budget"], async (_env, rec) => {
  if (await rec.get("module_account_budget")) await rec.set("group_analytic_accounting", true);
});
on("onchange_module_product_barcodelookup", ["module_product_barcodelookup"], async (_env, rec) => {
  if (!(await rec.get("module_product_barcodelookup"))) await rec.set("module_stock_barcode_barcodelookup", false);
});
on("onchange_module_stock_barcode_barcodelookup", ["module_stock_barcode_barcodelookup"], async (_env, rec) => {
  if (await rec.get("module_stock_barcode_barcodelookup")) await rec.set("module_product_barcodelookup", true);
});
