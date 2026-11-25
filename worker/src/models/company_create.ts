/**
 * `res.company.create` through the MRO of the ERP template (registry: sale, stock, account, payment,
 * partner_autocomplete, product, resource, web, base, mail.thread), with the helpers it reaches:
 *   base      res_company.py:348-396 (partner, users, currency, `install_l10n_modules` :264-311, `_init_company_defaults` :551-560)
 *   account   company.py:631-644 (chart of the root template, `_create_batch_payment_sequence` :611-629) and its
 *             `install_l10n_modules` (:1117-1132: `try_loading` of the country's template in a precommit)
 *   resource  res_company.py:31-58, product res_company.py:9-46, partner_autocomplete res_company.py:22-44,
 *   payment   res_company.py (providers copied), stock res_company.py:72-240, sale res_company.py:110-123
 * plus `ir.default.set` (ir_default.py:83-143), `ir.sequence.create` (ir_sequence.py:165-176) and the inverse of the
 * `company_default_for` fields (base res_company.py:19-48).
 *
 * Refused (NotPorted): a branch (`parent_id`), a localization module to install (`button_immediate_install`),
 * pricelists for users with the pricelist group, payment providers to copy.
 */
import { canonicalPhone } from "./phone";
import { NotPorted, UserError, ValidationError } from "../errors";
import { create, HOOKS_INSIDE } from "../orm/create";
import { cond, and } from "../orm/domain";
import { createEnvironment, hasGroup } from "../orm/env";
import { registerOverrides, write } from "../orm/write";
import type { Environment } from "../orm/types";
import { addPrecommit, runPrecommit, withPrecommit } from "./precommit";
import { registryLoading } from "../orm/signaling";
import { noteCommitPoint } from "../orm/created";
import { guessChartTemplate } from "./apps_data";
import { tryLoadingHooked } from "./chart_load";
import { translate } from "./util";
import { defineComputes } from "./tail_util";
import { fieldOrder } from "./base_import";
import { deferredFlush, NOT_ASSIGNED, registerOnchange, registerRecordCompute } from "../orm/recompute";
import { cacheEqual } from "../orm/convert";
import { registerCompanyLogoHook, storeAttachment } from "../orm/image_write";
import { dropHeldTracking, holdTracking, trackCollect, trackCommitPoint, trackPrepare } from "../mail/tracking";
import { closeTrackingScope, flushHeldTracking } from "../mail/write_hooks";
import { imageProcess } from "../image/wasm-process";
import { requestOfCursor } from "../http/context";
import { fetchStaticAsset } from "../controllers/static";
import countryTimezones from "../../gen/out/country_timezones.json";
import "./resource_calendar_create";
import { registerMethod } from "../http/methods";
import { envFor } from "../web/common";
import { isInstalled } from "../http/modules";
import { getAccount } from "./crm_iap_enrich";
import { mailProviderDomain } from "./crm_lead_write";
import { emailNormalize } from "./partner_pure_write";
import * as priv from "../orm/dispatch_gen";

type Vals = Record<string, unknown>;
const SUPERUSER_ID = 1;

async function one<T extends object>(env: Environment, text: string, params: unknown[]): Promise<T | undefined> {
  return (await env.cr.query<T>(text, params)).rows[0];
}

async function ref(env: Environment, xmlid: string): Promise<number | null> {
  const [module, name] = xmlid.split(".");
  return (await one<{ res_id: number }>(env, "SELECT res_id FROM ir_model_data WHERE module = $1 AND name = $2", [module, name]))?.res_id ?? null;
}

/** Python's `json.dumps(value, ensure_ascii=False)` of a scalar default. */
function pyJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  throw new NotPorted(`ir.default.set of ${JSON.stringify(value)}`);
}

/** ir_default.py:83-143 `set` (no user, no condition): update the scoped default or create it. */
export async function irDefaultSet(env: Environment, modelName: string, fieldName: string, value: unknown, companyId: number | false): Promise<void> {
  const def = env.reg.model(modelName);
  const field = def.fields.get(fieldName);
  if (!field) throw new ValidationError(`Invalid field ${modelName}.${fieldName}`);
  if (field.type === "integer" && typeof value === "number" && !(-(2 ** 31) < value && value < 2 ** 31 - 1)) {
    throw new ValidationError(`Invalid value for ${modelName}.${fieldName}: ${value} is out of bounds (integers should be between -2,147,483,648 and 2,147,483,647)`);
  }
  const jsonValue = pyJson(value);
  const fieldId = (await one<{ id: number }>(env, "SELECT id FROM ir_model_fields WHERE model = $1 AND name = $2", [modelName, fieldName]))?.id;
  if (fieldId === undefined) throw new NotPorted(`ir.default.set: ${modelName}.${fieldName} has no ir_model_fields row`);
  const existing = await one<{ id: number; json_value: string }>(env,
    `SELECT id, json_value FROM ir_default WHERE field_id = $1 AND user_id IS NULL AND ${companyId === false ? "company_id IS NULL AND $2::int IS NULL" : "company_id = $2"} AND condition IS NULL ORDER BY id LIMIT 1`,
    [fieldId, companyId === false ? null : companyId]);
  if (existing) {
    if (existing.json_value !== jsonValue) await write(env.sudo(), "ir.default", [existing.id], { json_value: jsonValue });
  } else {
    await create(env.sudo(), "ir.default", [{ field_id: fieldId, user_id: false, company_id: companyId, condition: false, json_value: jsonValue }]);
  }
}

/** base res_company.py:19-48 `company_default_for`: the fields of the template and their target. */
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

/** `field.convert_to_cache(company[fname])` of the written value: a many2one is its id or None. */
function cacheValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.length ? value[0] : null;
  if (value === false || value === undefined) return null;
  return value;
}

const inverse: Record<string, (env: Environment, ids: readonly number[], vals: Readonly<Vals>) => Promise<void>> = {};
// base res_company.py:29-33 `_inverse_to_ir_default`, as superuser, for every company_default_for field written:
// one function for all of them (src/orm/write.ts runs a shared inverse once), in Odoo's inverse order
// (models.py:3868-3871 `_fields_update_order__`: write_sequence 0 for these fields, then the `_fields` index)
const companyDefaultInverse = async (env: Environment, ids: readonly number[], vals: Readonly<Vals>): Promise<void> => {
  const order = (await fieldOrder(env))["res.company"] ?? [];
  const index = (f: string) => { const i = order.indexOf(f); if (i < 0) throw new NotPorted(`res.company field order of ${f}`); return i; };
  const written = COMPANY_DEFAULT_FOR.filter(([fname]) => fname in vals).sort((a, b) => index(a[0]) - index(b[0]));
  for (const [fname, targetModel, targetFname] of written) {
    if (!env.reg.models.has(targetModel) || !env.reg.model(targetModel).fields.has(targetFname)) throw new NotPorted(`company_default_for ${targetModel}.${targetFname}`);
    for (const id of ids) await irDefaultSet(env.withUser(SUPERUSER_ID), targetModel, targetFname, cacheValue(vals[fname]), id);
  }
};
for (const [fname] of COMPANY_DEFAULT_FOR) inverse[fname] = companyDefaultInverse;

// base res_company.py:202-224 `_inverse_street` ... `_inverse_country`: `company.partner_id.<field> = company.<field>`
for (const fname of ["street", "street2", "zip", "city", "state_id", "country_id"]) {
  inverse[fname] = async (env, ids, vals) => {
    for (const id of ids) {
      const partner = (await one<{ p: number | null }>(env, "SELECT partner_id AS p FROM res_company WHERE id = $1", [id]))!.p;
      if (partner) await write(env, "res.partner", [partner], { [fname]: vals[fname] ?? false });
    }
  };
}

/** ir_sequence.py:165-176: a standard sequence gets its PostgreSQL sequence. */
registerOverrides("ir.sequence", {
  create: async (env, valsList, next) => {
    const ids = await next(env, valsList);
    for (const id of ids) {
      const s = (await one<{ implementation: string; number_increment: number | null; number_next: number | null }>(env,
        "SELECT implementation, number_increment, number_next FROM ir_sequence WHERE id = $1", [id]))!;
      if (s.implementation !== "standard") continue;
      const increment = s.number_increment || 1;
      if (increment === 0) throw new UserError("Step must not be zero.");
      await env.cr.query(`CREATE SEQUENCE "ir_sequence_${String(id).padStart(3, "0")}" INCREMENT BY ${Number(increment)} START WITH ${Number(s.number_next || 1)}`);
    }
    return ids;
  },
});

/** Cursors whose company create installed a localization (its tracking held after the install's commit). */
const RETRACKED = new WeakSet<object>();

/**
 * base res_company.py:264-311 and account company.py:1117-1132 `install_l10n_modules`. With modules to install,
 * `button_immediate_install` (src/modules/install.ts) commits the transaction (ir_module.py:645: its precommit hooks
 * run), loads them on the new registry and goes on there (:646-651): the environment returned is on the new registry.
 */
async function installL10nModules(env0: Environment, companies: readonly number[]): Promise<Environment> {
  let env = env0;
  if (env.context["chart_template_load"]) return env;
  // :265-298 `_compute_uninstalled_l10n_module_ids`
  const rows = (await env.cr.query<{ company: number; modules: number[] }>(
    `SELECT c.id AS company, ARRAY_AGG(module.id ORDER BY module.id) AS modules
       FROM res_company c JOIN res_partner p ON p.id = c.partner_id, ir_module_module module
      WHERE c.id = ANY($1::int[]) AND module.auto_install AND module.state NOT IN ('installed', 'to install', 'to upgrade')
        AND NOT EXISTS (SELECT 1 FROM ir_module_module_dependency d JOIN ir_module_module mdep ON (d.name = mdep.name)
                         WHERE d.module_id = module.id AND d.auto_install_required AND mdep.state NOT IN ('installed', 'to install', 'to upgrade'))
        AND EXISTS (SELECT 1 FROM module_country mc WHERE mc.module_id = module.id AND mc.country_id = p.country_id)
      GROUP BY c.id`, [[...companies]])).rows;
  // :302-307 `registry.ready`: not while a module install loads (its demo companies)
  const ready = !env.context["install_mode"] && !env.context["import_file"] && !registryLoading(env.cr);
  const modules = [...new Set(rows.flatMap((r) => r.modules))];
  if (modules.length && ready) {
    // `self.uninstalled_l10n_module_ids` of the companies (one recordset: ids in their order)
    const { buttonImmediateInstall } = await import("../modules/install");
    // :645 `cr.commit()`: the precommit hooks run, the partners' tracking so far is logged (mail_track_mixin.py:76-133)
    await closeTrackingScope(env, "res.partner");
    await runPrecommit(env.cr);
    noteCommitPoint(env.cr);
    trackCommitPoint(env.cr);
    await buttonImmediateInstall(env, modules, { answer: false });
    env = await createEnvironment({ cr: env.cr, uid: env.uid, su: env.su, context: env.context });
    // after the rollback (:647) the tracking starts again with the next tracked write: held until the commit, each
    // model logged in the order and the environment of its first tracking (the chart's, in the new company)
    holdTracking(env.cr);
    RETRACKED.add(env.cr);
  }
  if (!ready) return env;
  for (const company of companies) {
    const c = (await one<{ country: number | null; chart: string | null; parent: number | null }>(env,
      "SELECT p.country_id AS country, c.chart_template AS chart, c.parent_id AS parent FROM res_company c JOIN res_partner p ON p.id = c.partner_id WHERE c.id = $1", [company]))!;
    if (!c.country || c.chart) continue;
    let code: string | null = null;
    if (c.parent) code = (await one<{ chart: string | null }>(env, "SELECT chart_template AS chart FROM res_company WHERE id = $1", [c.parent]))?.chart ?? null;
    code ||= (await guessChartTemplate(env, c.country)).code;
    if (code === "generic_coa") continue;
    const tmpl = code;
    // the hook's pending recomputations are flushed by the transaction's default environment (uid 1)
    const lenv = env;
    await addPrecommit(env.cr, () => deferredFlush(lenv, SUPERUSER_ID, () => tryLoadingHooked(lenv, tmpl, company)));
  }
  return env;
}

/** stock res_company.py:72-127 and :178-205 for one company (as superuser). */
async function stockPerCompany(env: Environment, company: number, interCompany: number): Promise<void> {
  const su = env.sudo();
  const [transit] = await create(su, "stock.location", [{ name: translate(su, "Inter-warehouse transit", "stock"), usage: "transit", company_id: company, active: false }]);
  await write(su, "res.company", [company], { internal_transit_location_id: transit });
  const [loss] = await create(su, "stock.location", [{ name: "Inventory adjustment", usage: "inventory", company_id: company }]);
  await irDefaultSet(su, "product.template", "property_stock_inventory", loss, company);
  const [production] = await create(su, "stock.location", [{ name: "Production", usage: "production", company_id: company }]);
  await irDefaultSet(su, "product.template", "property_stock_production", production, company);
  await create(su, "stock.location", [{ name: "Scrap", usage: "inventory", company_id: company }]);
  const name = (await one<{ name: string }>(env, "SELECT name FROM res_company WHERE id = $1", [company]))!.name;
  await create(su, "ir.sequence", [{ name: `${name} Sequence scrap`, code: "stock.scrap", company_id: company, prefix: "SP/", padding: 5, number_next: 1, number_increment: 1 }]);
  // :208-229 `_set_per_company_inter_company_locations`
  if (!await hasGroup(su, "base.group_multi_company")) return;
  const others = (await env.cr.query<{ id: number; partner: number }>("SELECT id, partner_id AS partner FROM res_company WHERE id != $1 ORDER BY sequence, name, id", [company])).rows;
  const warehousePartners = (await env.cr.query<{ p: number }>(
    "SELECT partner_id AS p FROM stock_warehouse WHERE company_id != $1 AND active ORDER BY sequence, id", [company])).rows.map((r) => r.p).filter((p) => p);
  const partners: number[] = [];
  for (const p of [...others.map((o) => o.partner), ...warehousePartners]) if (!partners.includes(p)) partners.push(p);
  const vals = { property_stock_customer: interCompany, property_stock_supplier: interCompany };
  const withCompany = (e: Environment, c: number) => e.withContext({ ...e.context, allowed_company_ids: [c] });
  await write(withCompany(su, company), "res.partner", partners, { ...vals });
  const own = (await one<{ p: number }>(env, "SELECT partner_id AS p FROM res_company WHERE id = $1", [company]))!.p;
  for (const o of others) await write(withCompany(su, o.id), "res.partner", [own], { ...vals });
}

async function companyCreate(env: Environment, valsListIn: Vals[], next: (env: Environment, valsList: Vals[]) => Promise<number[]>): Promise<number[]> {
  // the partners' tracking is logged at precommit (mail_track_mixin.py:76-133), after account's `try_loading`
  // (registered first, by `install_l10n_modules`): the partners stock writes for the new company see its accounts
  await trackPrepare(env, "res.partner", []);
  let ids: number[];
  try {
    ids = await companyCreateInner(env, valsListIn, next);
  } catch (e) {
    if (RETRACKED.delete(env.cr)) dropHeldTracking(env.cr);
    else await trackCollect(env, "res.partner");
    throw e;
  }
  // a localization installed by the create closed the partners' level at its commit and held the tracking after
  if (RETRACKED.delete(env.cr)) await flushHeldTracking(env);
  else await closeTrackingScope(env, "res.partner");
  return ids;
}

async function companyCreateInner(env: Environment, valsListIn: Vals[], next: (env: Environment, valsList: Vals[]) => Promise<number[]>): Promise<number[]> {
  return withPrecommit(env.cr, async () => {
    const valsList = valsListIn.map((v) => ({ ...v }));
    // base :350-371 the missing partners
    const noPartner = valsList.filter((v) => v["name"] && !v["partner_id"]);
    if (noPartner.length) {
      const penv = env.withContext({ ...env.context, default_parent_id: false });
      const partners = await create(penv, "res.partner", noPartner.map((v) => ({
        name: v["name"], image_1920: v["logo"] ?? false, email: v["email"] ?? false, phone: v["phone"] ?? false,
        website: v["website"] ?? false, vat: v["vat"] ?? false, country_id: v["country_id"] ?? false,
      })));
      noPartner.forEach((v, i) => { v["partner_id"] = partners[i]; });
    }
    if (valsList.some((v) => v["parent_id"])) throw new NotPorted("res.company create of a branch (delegated fields copied from the root)");
    const ids = await next(env, valsList);
    // base :376-389
    const users = env.uid === SUPERUSER_ID ? [SUPERUSER_ID] : [env.uid, SUPERUSER_ID];
    await write(env, "res.users", users, { company_ids: ids.map((c) => [4, c]) });
    const inactive = (await env.cr.query<{ id: number }>(
      "SELECT DISTINCT cur.id FROM res_company c JOIN res_currency cur ON cur.id = c.currency_id WHERE c.id = ANY($1::int[]) AND NOT cur.active ORDER BY cur.id", [ids])).rows.map((r) => r.id);
    if (inactive.length) await write(env.sudo(), "res.currency", inactive, { active: true });
    const withCountry = (await env.cr.query<{ id: number }>(
      "SELECT c.id FROM res_company c JOIN res_partner p ON p.id = c.partner_id WHERE c.id = ANY($1::int[]) AND p.country_id IS NOT NULL", [ids])).rows.map((r) => r.id);
    const ordered = ids.filter((id) => withCountry.includes(id));
    if (ordered.length) env = await installL10nModules(env, ordered);
    // :551-560 `_init_company_defaults`: the defaults of the company_default_for fields were set by their inverse
    // in the create above; a field with a default and no ir.default would be set here
    // resource :49-58
    const su = env.sudo();
    for (const id of ids) {
      const c = (await one<{ cal: number | null }>(env, "SELECT resource_calendar_id AS cal FROM res_company WHERE id = $1", [id]))!;
      if (!c.cal) {
        const [cal] = await create(su, "resource.calendar", [{ name: translate(su, "40 hours/week", "resource"), company_id: id }]);
        await write(su, "res.company", [id], { resource_calendar_id: cal });
      }
      const cal = (await one<{ cal: number | null; co: number | null }>(env,
        "SELECT c.resource_calendar_id AS cal, r.company_id AS co FROM res_company c LEFT JOIN resource_calendar r ON r.id = c.resource_calendar_id WHERE c.id = $1", [id]))!;
      if (cal.cal && !cal.co) await write(env, "resource.calendar", [cal.cal], { company_id: id });
    }
    // product :9-35 `_activate_or_create_pricelists`
    if (!env.context["disable_company_pricelist_creation"] && await hasGroup(env, "product.group_product_pricelist")) {
      // the new companies' pricelists without items in their currency are unarchived, the others get "Default"
      const existing = (await env.cr.query<{ company_id: number; active: boolean }>(
        `SELECT p.company_id, p.active FROM product_pricelist p JOIN res_company c ON c.id = p.company_id
          WHERE p.company_id = ANY($1::int[]) AND p.currency_id = c.currency_id
            AND NOT EXISTS (SELECT 1 FROM product_pricelist_item i WHERE i.pricelist_id = p.id)`, [ids])).rows;
      if (existing.some((r) => !r.active)) throw new NotPorted("archived default pricelists of a new company (action_unarchive)");
      const vals = [];
      for (const id of ids) {
        if (existing.some((r) => r.company_id === id)) continue;
        const currency = (await one<{ c: number }>(env, "SELECT currency_id AS c FROM res_company WHERE id = $1", [id]))!.c;
        vals.push({ name: translate(env, "Default", "product"), currency_id: currency, company_id: id, sequence: 10 });
      }
      if (vals.length) await create(su, "product.pricelist", vals);
    }
    // partner_autocomplete :22-44
    if (await hasGroup(env, "base.group_system") && !env.context["install_demo"]) {
      for (const id of ids) {
        const c = (await one<{ done: boolean | null; email: string | null; website: string | null }>(env,
          "SELECT c.iap_enrich_auto_done AS done, p.email, p.website FROM res_company c JOIN res_partner p ON p.id = c.partner_id WHERE c.id = $1", [id]))!;
        if (!c.done) await iapEnrich(env, c.email, c.website);
      }
      await write(env, "res.company", ids, { iap_enrich_auto_done: true });
    }
    // payment: the installed providers of the user's company are copied
    const userCompany = (await one<{ c: number }>(env, "SELECT company_id AS c FROM res_users WHERE id = $1", [env.uid]))!.c;
    if ((await env.cr.query(`SELECT 1 FROM payment_provider pp JOIN ir_module_module m ON m.id = pp.module_id
        WHERE pp.company_id = $1 AND m.state = 'installed' LIMIT 1`, [userCompany])).rows.length) throw new NotPorted("payment providers copied to a new company");
    // account company.py:631-644
    for (const id of ids) {
      const root = (await one<{ chart: string | null; parent: number | null }>(env,
        "SELECT r.chart_template AS chart, c.parent_id AS parent FROM res_company c JOIN res_company r ON r.id = split_part(c.parent_path, '/', 1)::int WHERE c.id = $1", [id]))!;
      if (root.chart) throw new NotPorted("res.company create: the root company's chart loaded on the new company");
      const seq = (await one<{ s: number | null }>(env, "SELECT batch_payment_sequence_id AS s FROM res_company WHERE id = $1", [id]))!.s;
      if (!seq) {
        const [s] = await create(su, "ir.sequence", [{ name: translate(env, "Group Payments Number Sequence", "account"), implementation: "no_gap", padding: 5, use_date_range: true, company_id: id, prefix: "GROUP/%(range_year)s/" }]);
        await write(env, "res.company", [id], { batch_payment_sequence_id: s });
      }
    }
    // stock :190-205
    const interCompany = await ref(env, "stock.stock_location_inter_company");
    if (interCompany === null) throw new NotPorted("stock.stock_location_inter_company missing");
    if (!(await one<{ a: boolean }>(env, "SELECT active AS a FROM stock_location WHERE id = $1", [interCompany]))!.a) await write(su, "stock.location", [interCompany], { active: true });
    for (const id of ids) await stockPerCompany(env, id, interCompany);
    // sale :118-123 `_sync_automatic_invoice_cron`
    const cron = await ref(env, "sale.send_invoice_cron");
    if (cron !== null) {
      const active = !!(await env.model("res.company").searchCount(and([cond("sale_automatic_invoice", "=", true)]), 1));
      await write(su, "ir.cron", [cron], { active });
    }
    return ids;
  });
}

HOOKS_INSIDE.add("res.company");

/** account company.py:55 */
const STORNO_MANDATORY_COUNTRIES = new Set(["BA", "CN", "CZ", "HR", "PL", "RO", "RS", "RU", "SI", "SK", "UA"]);

registerRecordCompute("res.company", {
  // base res_company.py:182-186: a branch copies its parent's details, otherwise the field is not assigned
  company_details: async (_env, rec) => {
    const parent = await rec.rel("parent_id");
    const own = await rec.prev("company_details");
    return parent && !own ? parent.get("company_details") : own;
  },
  // account company.py:495-499 the same for vat_disabled
  vat_disabled: async (_env, rec) => {
    const parent = await rec.rel("parent_id");
    // not assigned without a parent: a new company keeps the column empty
    return parent ? parent.get("vat_disabled") : NOT_ASSIGNED;
  },
  // account company.py:578-582
  account_storno: async (_env, rec) => {
    const country = await rec.rel("account_fiscal_country_id");
    return STORNO_MANDATORY_COUNTRIES.has(String(country ? await country.get("code") : ""));
  },
  // account company.py:533-541: the default terms are rendered only for terms_type 'html'
  invoice_terms_html: async (_env, rec) => {
    const own = await rec.prev("invoice_terms_html");
    if ((await rec.get("terms_type")) === "html" && !own) throw new NotPorted("res.company invoice_terms_html (account.account_default_terms_and_conditions)");
    return own;
  },
  // account_peppol res_company.py:226-241
  account_peppol_contact_email: async (_env, rec) => (await rec.prev("account_peppol_contact_email")) || rec.get("email"),
  account_peppol_phone_number: async (_env, rec) => {
    const own = await rec.prev("account_peppol_phone_number");
    const phone = await rec.get("phone");
    if (own || !phone) return own;
    // :117 `_check_phonenumbers_import` through its hook (l10n_dk's): account_peppol's raises only without the
    // phonenumbers library, which is installed (the hand: nothing)
    await priv.res_company._check_phonenumbers_import.call(_env, [], [], async () => null);
    // `_sanitize_peppol_phone_number` (:111-132): '+' prepended, phonenumbers.parse without a region and
    // is_valid_number; an invalid number raises the ValidationError the compute catches (the field stays empty)
    const number = String(phone);
    return (await canonicalPhone(number.startsWith("+") ? number : `+${number}`, null)) ? number : own;
  },
  // account_peppol res_company.py:197-206: only for a company that can send through Peppol
  peppol_purchase_journal_id: async (_env, rec) => {
    const own = await rec.prev("peppol_purchase_journal_id");
    const state = await rec.get("account_peppol_proxy_state");
    if (!own && state && state !== "not_registered") throw new NotPorted("res.company peppol_purchase_journal_id of a Peppol company");
    return own;
  },
  // base res_company.py:226-235: both follow the partner's image_1920, set when it is written (the hook below)
  logo_web: async (_env, rec) => rec.prev("logo_web"),
  uses_default_logo: async (_env, rec) => rec.prev("uses_default_logo"),
  // account company.py:589-590 `_compute_qr_code`: pass
  qr_code: async (_env, rec) => rec.prev("qr_code"),
  // resource res_company.py:18-27
  tz: async (env, rec) => {
    let tz: unknown = env.context.tz || (await env.cr.query<{ tz: string | null }>(
      "SELECT p.tz FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1", [env.uid])).rows[0]?.tz || "UTC";
    const country = await rec.rel("country_id");
    if (country) {
      const zones = (countryTimezones as Record<string, string[]>)[String(await country.get("code"))] ?? [];
      if (zones.length === 1) tz = zones[0];
    }
    return tz;
  },
});

// l10n_se res_company.py:10-19 `_compute_org_number` (not stored): the VAT's digits without the last two, as NNNNNN-NNNN
defineComputes("res.company", {
  org_number: async (_env, rec) => {
    if (!rec.def.fields.has("org_number")) throw new NotPorted("res.company.org_number without l10n_se");
    const country = await rec.rel("account_fiscal_country_id");
    const vat = await rec.get("vat");
    if (country && (await country.get("code")) === "SE" && typeof vat === "string" && vat) {
      const digits = vat.replace(/\D/g, "").slice(0, -2);
      return `${digits.slice(0, 6)}-${digits.slice(6)}`;
    }
    return "";
  },
});

// base res_company.py:226-235 `_compute_logo_web` and `_compute_uses_default_logo` when the partner's image is written
registerCompanyLogoHook(async (env, companies, image1920) => {
  const request = requestOfCursor(env.cr);
  if (request === null) throw new NotPorted("res.company logo outside a request");
  const file = await fetchStaticAsset(request.env, "/base/static/img/res_company_logo.png");
  if (file === null) throw new NotPorted("base/static/img/res_company_logo.png missing from the assets");
  const isDefault = Buffer.compare(Buffer.from(file.data), Buffer.from(image1920)) === 0;
  const logo = imageProcess(image1920, 180, 0);
  for (const company of companies) {
    await storeAttachment(env.sudo(), "res.company", "logo_web", company, logo, "logo.png");
    await env.cr.query("UPDATE res_company SET uses_default_logo = $2 WHERE id = $1", [company, isDefault]);
  }
});
export { companyCreate, inverse as companyDefaultForInverse };

// base res_company.py:257-262 _onchange_parent_id with :163-171 and account company.py:401-407
// `_get_company_root_delegated_field_names`: a branch takes its parent's delegated fields (those the registry has)
registerOnchange("res.company", "_onchange_parent_id", ["parent_id"], async (env, rec) => {
  const parent = await rec.rel("parent_id");
  if (!parent) return;
  const names = ["currency_id", "fiscalyear_last_day", "fiscalyear_last_month", "account_storno", "tax_exigibility"].filter((f) => env.reg.model("res.company").fields.has(f));
  for (const f of names) {
    const theirs = await parent.get(f);
    if (!cacheEqual(await rec.get(f), theirs)) await rec.set(f, theirs);
  }
});

/**
 * Python's `urlparse(url).hostname` (urllib/parse.py urlsplit and `_hostinfo`): the netloc after `scheme:` when the
 * rest starts with `//`, after its last `@`, without the port, lowercased; null without one.
 */
function urlHostname(url: string): string | null {
  // urlsplit strips leading C0 controls and spaces and removes tabs and newlines
  let rest = url.replace(/^[\x00-\x20]+/, "").replace(/[\t\r\n]/g, "");
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(rest);
  if (scheme) rest = rest.slice(scheme[0].length);
  if (!rest.startsWith("//")) return null;
  rest = rest.slice(2);
  const end = rest.search(/[/?#]/);
  const netloc = end < 0 ? rest : rest.slice(0, end);
  const hostinfo = netloc.slice(netloc.lastIndexOf("@") + 1);
  const br = hostinfo.indexOf("[");
  let hostname = br >= 0 ? hostinfo.slice(br + 1).split("]")[0]! : hostinfo.split(":")[0]!;
  if (!hostname) return null;
  const pct = hostname.indexOf("%");
  hostname = pct < 0 ? hostname.toLowerCase() : hostname.slice(0, pct).toLowerCase() + hostname.slice(pct);
  return hostname;
}

/**
 * partner_autocomplete res_partner.py:354-376 `_get_partner_domain`: the domain of the email (tools/mail.py:998-1007
 * `email_domain_extract`) unless a mail provider (iap_tools._MAIL_PROVIDERS), else the last two labels of the
 * website's host (`url_domain_extract` :1016-1026) unless localhost or example.com.
 */
export function partnerDomain(email: string | null, website: string | null): string | null {
  const normalized = email ? emailNormalize(email) : null;
  const fromEmail = normalized ? normalized.split("@")[1]! : null;
  if (fromEmail && !mailProviderDomain(fromEmail)) return fromEmail;
  const host = website ? urlHostname(website) : null;
  const fromUrl = host && host.includes(".") ? host.split(".").slice(-2).join(".") : null;
  if (!fromUrl || fromUrl === "localhost" || fromUrl === "example.com") return null;
  return fromUrl;
}

/**
 * partner_autocomplete res_company.py:46-66 `_enrich` of a company whose partner has `email` and `website`, as the
 * oracle runs it (no outbound network: proofs/oracle.sh points http(s)_proxy at a closed port): without a domain it
 * returns False; with one `enrich_by_domain` (res_partner.py:224-228) reaches `_contact_iap`
 * (iap_autocomplete_api.py:18-33), whose `iap.account.get('partner_autocomplete')` creates the account when there is
 * none (iap_account.py:177-223, crm_iap_enrich.ts getAccount); the request then fails with a RequestException,
 * `_request_partner_autocomplete` (:35-55) answers (False, error), `_process_enriched_response` an error and `_enrich`
 * False: nothing else is written.
 */
async function iapEnrich(env: Environment, email: string | null, website: string | null): Promise<void> {
  if (!partnerDomain(email, website)) return;
  await getAccount(env, "partner_autocomplete");
}

// partner_autocomplete res_company.py:37-44 `iap_enrich_auto` (the web client calls it on load while the user's
// company has `iap_enrich_auto_done` unset, web_company_autocomplete.js:10)
registerMethod("res.company", "iap_enrich_auto", async (env0, ids, _args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  if (Object.keys(kwargs).length) throw new NotPorted(`res.company.iap_enrich_auto with ${Object.keys(kwargs).join(", ")}`);
  if (!env.reg.model("res.company").fields.has("iap_enrich_auto_done")) throw new NotPorted("res.company.iap_enrich_auto without partner_autocomplete");
  const companyIds = ids ?? [];
  // `self.env.user._is_system()`, `self.env.registry.ready`, not `install_demo`
  if (!(await hasGroup(env, "base.group_system")) || registryLoading(env.cr) || env.context["install_demo"]) return true;
  if (!companyIds.length) return true;
  const rows = (await env.model("res.company").read(companyIds, ["iap_enrich_auto_done", "partner_id"], "")) as Array<Record<string, unknown>>;
  for (const r of rows) {
    if (r["iap_enrich_auto_done"]) continue;
    const raw = r["partner_id"];
    const partner = Array.isArray(raw) ? Number(raw[0]) : typeof raw === "number" ? raw : null;
    if (partner === null) throw new NotPorted("iap_enrich_auto of a company without partner");
    const [p] = await env.model("res.partner").read([partner], ["email", "website"], "");
    await iapEnrich(env, (p?.["email"] || null) as string | null, (p?.["website"] || null) as string | null);
  }
  // `self.iap_enrich_auto_done = True` (Field.__set__ writes every record, done or not)
  await write(env, "res.company", companyIds, { iap_enrich_auto_done: true });
  return true;
}, { apiModel: false });

// account company.py:55-56 STORNO_MANDATORY_COUNTRIES | STORNO_OPTIONAL_COUNTRIES
const STORNO_COUNTRIES: ReadonlySet<string> = new Set(["BA", "CN", "CZ", "HR", "PL", "RO", "RS", "RU", "SI", "SK", "UA", "AT", "CH", "DE", "IT", "MK"]);

defineComputes("res.company", {
  // account company.py:584-587 `_compute_display_account_storno`: the fiscal country allows storno accounting
  display_account_storno: async (_env, rec) => {
    const country = await rec.rel("account_fiscal_country_id");
    return country ? STORNO_COUNTRIES.has(String((await country.get("code")) || "")) : false;
  },
  // account company.py:432-434 `_compute_force_restrictive_audit_trail`: False; l10n_de (res_company.py:32-35) and
  // l10n_in (company.py:130) override it
  force_restrictive_audit_trail: async (env) => {
    for (const m of ["l10n_de", "l10n_in"]) if (await isInstalled(env.cr, m)) throw new NotPorted(`res.company.force_restrictive_audit_trail with ${m}`);
    return false;
  },
});
