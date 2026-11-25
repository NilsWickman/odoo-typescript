/**
 * `account.chart.template` loading (odoo/addons/account/models/chart_template.py): `try_loading` (:151-182), `_load`
 * (:184-261), `_pre_load_data` (:494-576), `_load_data` with `deref_values` and `delay` (:578-731), `_post_load_data`
 * (:733-807), `_setup_utility_bank_accounts` (:917-949), `_create_outstanding_accounts` (:951-978) and
 * `_load_translations` (:1516-1575). The template's data (`_get_chart_template_data`, the CSV files and the Python
 * template functions) is generated offline by worker/gen/chart_templates.py (gen/out/<template>/chart/<code>.json,
 * packaged under /__gen/); the database-dependent parts (`self.env.company.id`, the tax tags) are resolved here.
 *
 * Refused (NotPorted): a template whose file was not generated, a template module that is not installed
 * (`button_immediate_install`), a branch, a reload of the company's own template, a company that already has records
 * of the template models, demo data (`_install_demo`) and subsidiaries.
 */
import { PrivateRecords } from "../orm/private_hooks";
import { installDemo as installAccountDemo } from "./account_demo";
import { trackingHeld, trackSavepointFlush } from "../mail/tracking";
import { noteCommitPoint } from "../orm/created";
import { flushHeldTracking } from "../mail/write_hooks";
import { AccessError, NotPorted, UserError, ValidationError } from "../errors";
import { create } from "../orm/create";
import { registerRecordCompute } from "../orm/recompute";
import { and, cond } from "../orm/domain";
import { hasGroup } from "../orm/env";
import { loadRecords, type LoadData } from "../orm/load_records";
import { write } from "../orm/write";
import type { Environment, FieldDef } from "../orm/types";
import { genAssetJson } from "../gen_assets";
import { templateOf } from "../orm/template";
import { saveModelTranslations } from "./lang_install";
import { translate } from "./util";
import * as priv from "../orm/dispatch_gen";

export type Vals = Record<string, unknown>;
export type Key = string | number;
export type Data = Map<string, Map<Key, Vals>>;

export interface ChartFile {
  readonly code: string;
  readonly parents: readonly string[];
  readonly mapping: Readonly<Record<string, { country_id: number | false | null; module: string; name: string; parent: string | null }>>;
  readonly template_data: Readonly<Vals>;
  readonly data: readonly (readonly [string, readonly (readonly [string, Vals])[]])[];
  readonly res_company_by_state: Readonly<Record<string, Vals>>;
  /** lang -> model -> field -> xmlid -> value (`_get_field_translation`) */
  readonly translations: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>>>>;
  /** module -> lang -> source -> translation (`get_python_translation`) */
  readonly code_translations: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>>;
  readonly langs: readonly string[];
}

/** chart_template.py:22-29 */
export const TEMPLATE_MODELS = ["account.account", "account.fiscal.position", "account.tax.group", "account.tax", "account.journal", "account.reconcile.model"] as const;
/** chart_template.py:31 */
const TEMPLATE_DATA_KEYS = new Set(["name", "country", "code_digits", "parent", "sequence", "visible"]);
/** chart_template.py:33 */
const TAX_TAG_DELIMITER = "||";
/** The templates whose loading was compared with Odoo (proofs/scenarios/co_us.py, co_se.py); the others refuse. */
const VERIFIED = new Set(["us", "se"]);

const FILES = new Map<string, Promise<ChartFile>>();

export async function chartFile(env: Environment, code: string): Promise<ChartFile> {
  const t = await templateOf(env.cr);
  if (t.dir !== "poc_erp") throw new NotPorted(`chart template ${code} on a database of template ${t.dir || "poc_corpus"}`);
  // a code verified in the database's overlay is read from the overlay (compiler/sitebuild.py generates it there)
  const source = !VERIFIED.has(code) && t.overlay && (await overlayVerified(t.overlay))[code] ? t.overlay : "poc_erp";
  const key = `${source}/${code}`;
  let p = FILES.get(key);
  if (!p) {
    p = genAssetJson(`${source}/chart/${code}.json`).then((raw) => raw as ChartFile);
    p.catch(() => FILES.delete(key));
    FILES.set(key, p);
  }
  return p;
}

/**
 * The chart templates verified in an overlay (gen/out/<overlay>/chart/verified.json, written by compiler/chartverify.py
 * only from an IDENTICAL install proof with the full database comparison): code -> the proof and its result file.
 */
const OVERLAY_VERIFIED = new Map<string, Promise<Record<string, { proof: string; result: string }>>>();
async function overlayVerified(overlay: string): Promise<Record<string, { proof: string; result: string }>> {
  let p = OVERLAY_VERIFIED.get(overlay);
  if (!p) {
    p = genAssetJson(`${overlay}/chart/verified.json`).then((raw) => raw as Record<string, { proof: string; result: string }>, () => ({}));
    OVERLAY_VERIFIED.set(overlay, p);
  }
  return p;
}

/** Whether the chart template `code` may load in the database's template: compared with Odoo for the base, or in
 *  its overlay by the site's own install proof. */
async function chartVerified(env: Environment, code: string): Promise<boolean> {
  if (VERIFIED.has(code)) return true;
  const t = await templateOf(env.cr);
  return Boolean(t.overlay && (await overlayVerified(t.overlay))[code]);
}

const clone = <T>(v: T): T => structuredClone(v);
const isDict = (v: unknown): v is Vals => typeof v === "object" && v !== null && !Array.isArray(v);
/** Python truthiness of a template value. */
const truthy = (v: unknown): boolean => !(v === false || v === null || v === undefined || v === 0 || v === "" || (Array.isArray(v) && !v.length) || (isDict(v) && !Object.keys(v).length));

async function one<T extends object>(env: Environment, text: string, params: unknown[]): Promise<T | undefined> {
  return (await env.cr.query<T>(text, params)).rows[0];
}

export async function companyRow(env: Environment, company: number): Promise<Vals> {
  const r = await one<Vals>(env, `SELECT c.*, p.country_id, p.state_id, p.lang AS partner_lang, split_part(c.parent_path, '/', 1)::int AS root_id
    FROM res_company c JOIN res_partner p ON p.id = c.partner_id WHERE c.id = $1`, [company]);
  if (!r) throw new NotPorted(`res.company ${company} missing`);
  return r;
}

/** chart_template.py:1238-1242 `company_xmlid` */
export function companyXmlid(xmlid: string, company: number): string {
  return xmlid.includes(".") ? xmlid : `account.${company}_${xmlid}`;
}

/**
 * chart_template.py:863-867 `_get_account_parent_id(code_prefix)` of the company: the private
 * `_get_account_parent_xmlid(code_prefix, company.chart_template)` (:860, None in account) through the private hook,
 * so a site's compiled override (l10n_kr: its bank prefixes' parent account) runs around it, then
 * `self.ref(xmlid, raise_if_not_found=False)` (:1244-1248: the company's XML id, else its root's). False when either is.
 */
export async function accountParentId(envIn: Environment, company: number, codePrefix: unknown): Promise<number | false> {
  const env = envIn.withContext({ ...envIn.context, allowed_company_ids: [company] });
  const c = await companyRow(env, company);
  const xmlid = await priv.account_chart_template._get_account_parent_xmlid.call(env, [], [codePrefix, c["chart_template"] ?? false], async () => null);
  if (!xmlid) return false;
  if (typeof xmlid !== "string") throw new NotPorted(`_get_account_parent_xmlid returning ${JSON.stringify(xmlid)}`);
  const parent = await envRef(env, companyXmlid(xmlid, company)) ?? await envRef(env, companyXmlid(xmlid, Number(c["root_id"])));
  return parent ? parent.id : false;
}

/** `env.ref(xmlid, raise_if_not_found=False)`: the record when the XML id exists and its record too. */
async function envRef(env: Environment, xmlid: string): Promise<{ model: string; id: number } | null> {
  const dot = xmlid.indexOf(".");
  if (dot < 0) throw new NotPorted(`env.ref of ${xmlid} without a module`);
  const r = await one<{ model: string; res_id: number }>(env, "SELECT model, res_id FROM ir_model_data WHERE module = $1 AND name = $2", [xmlid.slice(0, dot), xmlid.slice(dot + 1)]);
  if (!r || !env.reg.models.has(r.model)) return null;
  const table = env.reg.model(r.model).table;
  return (await one(env, `SELECT 1 FROM "${table}" WHERE id = $1`, [r.res_id])) ? { model: r.model, id: r.res_id } : null;
}

export class Loader {
  readonly env: Environment;
  readonly company: number;
  readonly root: number;
  constructor(env: Environment, company: number, root: number) {
    this.env = env;
    this.company = company;
    this.root = root;
  }

  /** chart_template.py:1244-1248 `ref`: the company's XML id, else the root company's (`parent_ids[0]`). */
  async ref(xmlid: string, raiseIfNotFound = true): Promise<number | null> {
    const r = await envRef(this.env, companyXmlid(xmlid, this.company)) ?? await envRef(this.env, companyXmlid(xmlid, this.root));
    if (!r && raiseIfNotFound) throw new ValueErrorRef(`External ID not found in the system: ${companyXmlid(xmlid, this.root)}`);
    return r?.id ?? null;
  }

  fields(model: string): ReadonlyMap<string, FieldDef> {
    return this.env.reg.model(model).fields;
  }
}

/** The ValueError `env.ref` raises (ir_model.py `_xmlid_lookup`). */
class ValueErrorRef extends Error {}

const RELATIONAL = new Set(["many2one", "one2many", "many2many"]);
const COMMANDS = new Set([0, 1, 2, 3, 4, 5, 6]);

/** chart_template.py:589-635 `deref_values` */
async function derefValues(ld: Loader, values: Vals, model: string): Promise<Vals> {
  const fields = ld.fields(model);
  const failed: string[] = [];
  for (const [fname, value] of Object.entries(values)) {
    const field = fields.get(fname);
    if (!field) continue;
    if (!truthy(value)) {
      values[fname] = false;
    } else if (typeof value === "string" && (field.type === "many2one" || ((field.type === "integer" || field.type === "many2one_reference") && !/^\d+$/.test(value)))) {
      try {
        values[fname] = ["", "False", "None"].includes(value) ? false : await ld.ref(value);
      } catch (e) {
        if (!(e instanceof ValueErrorRef)) throw e;
        if (model === "res.company") throw new NotPorted(`res.company ${fname}: fallback on the company's own value for a missing ${value}`);
        failed.push(fname);
        values[fname] = false;
      }
    } else if ((field.type === "one2many" || field.type === "many2many") && Array.isArray(value) && Array.isArray(value[0])) {
      for (let i = 0; i < value.length; i++) {
        const cmd = value[i] as unknown[];
        const [command, id, last] = cmd;
        if ((command === 0 || command === 1) && isDict(last)) {
          await derefValues(ld, last, field.relation!);
        } else if (command === 6 && Array.isArray(last)) {
          for (let j = 0; j < last.length; j++) if (typeof last[j] === "string") last[j] = await ld.ref(last[j] as string);
        } else if (command === 4 && typeof id === "string") {
          value[i] = [4, await ld.ref(id)];
        }
      }
    } else if ((field.type === "one2many" || field.type === "many2many") && typeof value === "string") {
      const ids: number[] = [];
      for (const v of value.split(",")) if (v) ids.push((await ld.ref(v))!);
      values[fname] = [[6, 0, ids]];
    }
  }
  for (const f of failed) delete values[f];
  return values;
}

/** chart_template.py:640-660 `should_delay` */
function shouldDelay(ld: Loader, created: Set<string>, yet: readonly string[], model: string, fname: string, fval: unknown, parentsIn: readonly string[] = []): boolean {
  const parents = [...parentsIn, model];
  const field = ld.fields(model).get(fname);
  if (!field || !RELATIONAL.has(field.type) || created.has(field.relation!) || typeof fval === "number") return false;
  const yetToBeCreated = parents.includes(field.relation!) || yet.includes(field.relation!);
  if (!Array.isArray(fval)) return yetToBeCreated;
  for (const element of fval) {
    if (!Array.isArray(element)) continue;
    if (element.length === 3 && element[0] === 0 && isDict(element[2])) {
      for (const [k, v] of Object.entries(element[2])) if (shouldDelay(ld, created, yet, field.relation!, k, v, parents)) return true;
    } else if (typeof element[0] === "number" && COMMANDS.has(element[0])) {
      if (yetToBeCreated) return true;
    }
  }
  return false;
}

/** chart_template.py:578-731 `_load_data` */
export async function loadData(ld: Loader, data: Data): Promise<void> {
  const queue: [string, Map<Key, Vals>][] = [...clone(data).entries()];
  const created = new Set<string>();
  while (queue.length) {
    const [model, mdata] = queue.shift()!;
    const yet = queue.filter(([, d]) => d.size).map(([m]) => m);
    const toDelay = new Map<Key, Vals>();
    for (const [xmlid, vals] of mdata) {
      const remove: string[] = [];
      for (const [fname, fvalIn] of Object.entries(vals)) {
        let fval = fvalIn;
        const field = ld.fields(model).get(fname);
        if (shouldDelay(ld, created, yet, model, fname, fval)) {
          // :687-697 the default repartition lines of a new tax are cleared before the delayed ones
          if (model === "account.tax" && fname.includes("repartition_line_ids") && typeof xmlid === "string" && await ld.ref(xmlid, false) === null
              && Array.isArray(fval) && fval.every((x) => Array.isArray(x) && x.length && typeof x[0] === "number")) {
            fval = [[5, 0, 0], ...fval];
          }
          remove.push(fname);
          const d = toDelay.get(xmlid) ?? {};
          d[fname] = fval;
          toDelay.set(xmlid, d);
        }
        if (field?.type === "many2one_reference") {
          // :675-693 the reference waits with its model field when the model it points to is yet to be created
          const mf0 = ld.fields(model).get(field.modelField ?? "");
          if (!mf0) throw new NotPorted(`chart template ${model}.${fname}: a many2one_reference without its model field`);
          let mfName = mf0.name;
          let resModel: unknown;
          if (mf0.related) {
            const [first, path] = [mf0.related.split(".")[0]!, mf0.related.split(".").slice(1).join(".")];
            if (path !== "model") throw new NotPorted(`chart template ${model}.${fname}: model field related through ${mf0.related}`);
            mfName = first;
            const v = vals[first];
            const modelId = typeof v === "string" ? await ld.ref(v) : v;
            resModel = (await ld.env.cr.query<{ model: string }>("SELECT model FROM ir_model WHERE id = $1", [modelId])).rows[0]?.model;
          } else {
            resModel = vals[mfName];
          }
          if (typeof resModel === "string" && yet.includes(resModel)) {
            remove.push(mfName, fname);
            const d = toDelay.get(xmlid) ?? {};
            d[fname] = vals[fname];
            d[mfName] = vals[mfName];
            toDelay.set(xmlid, d);
          }
        }
      }
      for (const f of remove) delete vals[f];
    }
    if ([...toDelay.values()].some((v) => Object.keys(v).length)) queue.push([model, toDelay]);
    // the generator yields before marking the model created
    const all: LoadData[] = [];
    for (const [xmlidIn, recordVals] of mdata) {
      for (const key of Object.keys(recordVals)) if (key.includes("@") || key === "__translation_module__") delete recordVals[key];
      let xmlid: Key | false = xmlidIn;
      if (typeof xmlid === "string") {
        const rec = await ld.ref(xmlid, false);
        if (rec !== null) xmlid = rec;
      }
      if (typeof xmlid === "number") {
        recordVals["id"] = xmlid;
        xmlid = false;
      } else {
        xmlid = companyXmlid(xmlid, ld.company);
      }
      const values = await derefValues(ld, recordVals, model);
      all.push(xmlid === false ? { values, noupdate: true } : { xml_id: xmlid, values, noupdate: true });
    }
    await loadRecords(ld.env.withContext({ ...ld.env.context, lang: "en_US" }), model, all, false);
    created.add(model);
  }
}

async function existingAccounting(env: Environment, root: number): Promise<boolean> {
  // company.py:1134-1138: any journal item in the company or its children (active_test=False)
  return !!(await one(env, `SELECT 1 FROM account_move_line l JOIN res_company c ON c.id = l.company_id
    WHERE c.parent_path LIKE (SELECT parent_path FROM res_company WHERE id = $1) || '%' LIMIT 1`, [root]));
}

/** chart_template.py:494-576 `_pre_load_data` */
async function preLoadData(ld: Loader, file: ChartFile, templateData: Vals, data: Data): Promise<Data> {
  const env = ld.env;
  const c = await companyRow(env, ld.company);
  const companyVals = data.get("res.company")?.get(ld.company);
  let fiscalCountry: number | null;
  if (companyVals && "account_fiscal_country_id" in companyVals) {
    fiscalCountry = await ld.ref(String(companyVals["account_fiscal_country_id"]));
  } else {
    fiscalCountry = (c["account_fiscal_country_id"] as number | null) ?? null;
  }
  const vals: Vals = {};
  if (!await existingAccounting(env, ld.root)) {
    if (c["parent_id"]) throw new NotPorted("chart template on a branch");
    vals["currency_id"] = fiscalCountry ? (await one<{ c: number | null }>(env, "SELECT currency_id AS c FROM res_country WHERE id = $1", [fiscalCountry]))?.c ?? false : false;
  }
  if (!c["country_id"]) vals["country_id"] = fiscalCountry ?? false;
  if (Object.keys(templateData).length && !("anglo_saxon_accounting" in vals)) vals["anglo_saxon_accounting"] = false;
  await write(env, "res.company", [ld.company], vals);

  const codeDigits = parseInt(String(templateData["code_digits"] ?? 6), 10);
  for (const [, account] of data.get("account.account") ?? new Map<Key, Vals>()) {
    if ("code" in account) {
      // f'{code:<0{code_digits}}' for active accounts only
      const active = "active" in account ? truthy(account["active"]) : true;
      if (active) account["code"] = String(account["code"]).padEnd(codeDigits, "0");
    }
  }
  for (const model of ["account.fiscal.position", "account.reconcile.model"]) {
    const d = data.get(model);
    if (d) { data.delete(model); data.set(model, d); }
  }
  for (const key of Object.keys(templateData)) if (!TEMPLATE_DATA_KEYS.has(key)) delete templateData[key];
  for (const [modelName, records] of data) {
    const fields = ld.fields(modelName);
    for (const [, record] of records) {
      for (const key of Object.keys(record)) {
        if (key === "__translation_module__") continue;
        const fname = key.includes("@") ? key.split("@")[0]! : key;
        if (!fields.has(fname)) delete record[key];
      }
    }
  }
  // :563-574 the untranslatable fields translated anyway (the journals' codes), into the partner's language
  const lang = (c["partner_lang"] as string | null) || env.lang || "en_US";
  const codes = file.translations[lang]?.["account.journal"]?.["code"] ?? {};
  for (const [xmlid, record] of data.get("account.journal") ?? new Map<Key, Vals>()) {
    if (!("code" in record) || typeof xmlid !== "string") continue;
    const t = codes[xmlid];
    if (t) record["code"] = t;
  }
  return data;
}

async function search(env: Environment, model: string, domain: Parameters<typeof and>[0], opts: { limit?: number; order?: string } = {}): Promise<number[]> {
  return env.model(model).search(and(domain), { limit: opts.limit ?? null, order: opts.order ?? null });
}

/** models.py:162-178 `check_company_domain_parent_of` on a root company. */
const companyDomain = (company: number) => cond("company_id", "in", [company, false]);

/** A company argument of a private hook: the hand port's marker (no override) or the ids an override passes on. */
export function isCompany(arg: unknown, company: number): boolean {
  if (arg instanceof PrivateRecords) return arg.model === "res.company" && arg.ids.length === 1 && arg.ids[0] === company;
  return Array.isArray(arg) && arg.length === 1 && arg[0] === company;
}

/**
 * The arguments a site's compiled override of a chart template's private method passes to `super()` (the hand port's
 * implementation, bound to this load): the same template code and the same company, else the hook refuses.
 */
function sameLoad(ld: Loader, file: ChartFile, method: string, args: readonly unknown[]): void {
  if (args[0] !== file.code || !isCompany(args[1], ld.company)) {
    throw new NotPorted(`account.chart.template.${method} called by an override with another template or company than the load's (${JSON.stringify(args.slice(0, 2))})`);
  }
}

/**
 * chart_template.py:917-978 `_setup_utility_bank_accounts(template_code, company, template_data)` through the private
 * hook (src/orm/private_hooks.ts): a site's compiled override (l10n_at, l10n_lt: the tags of the suspense and transfer
 * accounts) runs around account's, `setupUtilityBankAccountsOf`.
 */
async function setupUtilityBankAccounts(ld: Loader, file: ChartFile, templateData: Vals): Promise<void> {
  await priv.account_chart_template._setup_utility_bank_accounts.call(ld.env, [], [file.code, new PrivateRecords("res.company", [ld.company]), templateData],
    async (_e, _ids, args) => {
      sameLoad(ld, file, "_setup_utility_bank_accounts", args);
      await setupUtilityBankAccountsOf(ld, file, (args[2] ?? {}) as Vals);
      return null;
    });
}

/** chart_template.py:917-978 `_setup_utility_bank_accounts` and `_create_outstanding_accounts` */
async function setupUtilityBankAccountsOf(ld: Loader, file: ChartFile, templateData: Vals): Promise<void> {
  const env = ld.env;
  const c = await companyRow(env, ld.company);
  const bankPrefix = (c["bank_account_code_prefix"] as string | null) ?? false;
  const codeDigits = parseInt(String(templateData["code_digits"] ?? 6), 10);
  const t = (s: string) => translate(env, s, "account");
  // :925 `self._get_accounts_data_values(company, template_data, bank_prefix=bank_prefix, code_digits=code_digits)`
  // through the private hook: a site's compiled override (l10n_mx: the cash difference accounts) runs around it
  const data = await priv.account_chart_template._get_accounts_data_values.call(env, [],
    [new PrivateRecords("res.company", [ld.company]), templateData, bankPrefix, codeDigits],
    async (_e, _ids, args) => {
      if (!(args[0] instanceof PrivateRecords) || args[0].ids[0] !== ld.company || args.length > 4) throw new NotPorted("_get_accounts_data_values of another company or with more arguments");
      // :870-871 the arguments, else the company's prefix and the template's digits
      const prefix = (args[2] || bankPrefix) as string | false;
      const digits = (args[3] || codeDigits) as number;
      return Object.fromEntries(await accountsDataValues(env, ld, c, (args[1] ?? {}) as Vals, prefix, digits, t));
    });
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new NotPorted(`_get_accounts_data_values returning ${JSON.stringify(data)}`);
  const accounts = Object.entries(data as Record<string, Vals>);
  // the US override of `_get_accounts_data_values` (l10n_us_account template_us.py:98-104) only renames the transfer
  // account, for a US fiscal country, with the same text (no code translation in l10n_us_account)
  const todo = accounts.filter(([fname]) => !c[fname]);
  const ids = await loadRecords(env, "account.account", todo.map(([xmlid, values]) => ({ xml_id: companyXmlid(xmlid, ld.company), values, noupdate: true })), false);
  for (let i = 0; i < todo.length; i++) await write(env, "res.company", [ld.company], { [todo[i]![0]]: ids[i] });
  const outstanding: [string, Vals][] = [
    ["account_journal_payment_debit_account_id", { name: t("Outstanding Receipts"), parent_id: await accountParentId(env, ld.company, bankPrefix), prefix: bankPrefix, code_digits: codeDigits, account_type: "asset_current", reconcile: true }],
    ["account_journal_payment_credit_account_id", { name: t("Outstanding Payments"), parent_id: await accountParentId(env, ld.company, bankPrefix), prefix: bankPrefix, code_digits: codeDigits, account_type: "asset_current", reconcile: true }],
  ];
  await loadRecords(env, "account.account", outstanding.map(([xmlid, values]) => ({ xml_id: companyXmlid(xmlid, ld.company), values, noupdate: true })), false);
}

/** chart_template.py:869-911 account's `_get_accounts_data_values` (the hook's hand implementation). */
async function accountsDataValues(env: Environment, ld: Loader, c: Record<string, unknown>, _templateData: Vals, bankPrefix: string | false,
  codeDigits: number, t: (s: string) => string): Promise<[string, Vals][]> {
  return [
    ["account_journal_suspense_account_id", { name: t("Bank Suspense Account"), parent_id: await accountParentId(env, ld.company, bankPrefix), prefix: bankPrefix, code_digits: codeDigits, account_type: "asset_current" }],
    ["account_journal_early_pay_discount_loss_account_id", { name: t("Cash Discount Loss"), code: "999998", account_type: "expense" }],
    ["account_journal_early_pay_discount_gain_account_id", { name: t("Cash Discount Gain"), code: "999997", account_type: "income_other" }],
    ["default_cash_difference_income_account_id", { name: t("Cash Difference Gain"), prefix: "999", code_digits: codeDigits, account_type: "income_other", tag_ids: [[6, 0, [await xmlidOf(env, "account.account_tag_investing")]]] }],
    ["default_cash_difference_expense_account_id", { name: t("Cash Difference Loss"), prefix: "999", code_digits: codeDigits, account_type: "expense", tag_ids: [[6, 0, [await xmlidOf(env, "account.account_tag_investing")]]] }],
    ["transfer_account_id", { name: t("Funds in Transit"), parent_id: await accountParentId(env, ld.company, c["transfer_account_code_prefix"] ?? false), prefix: (c["transfer_account_code_prefix"] as string | null) ?? false, code_digits: codeDigits, account_type: "asset_current", reconcile: true }],
  ];
}

async function xmlidOf(env: Environment, xmlid: string): Promise<number> {
  const r = await envRef(env, xmlid);
  if (!r) throw new NotPorted(`env.ref(${xmlid}) missing`);
  return r.id;
}

/** company.py:977-1007 `get_unaffected_earnings_account` */
async function unaffectedEarningsAccount(env: Environment, company: number): Promise<void> {
  const accountDomain = cond("company_ids", "in", [company]);
  const found = await search(env, "account.account", [accountDomain, cond("account_type", "=", "equity_unaffected")], { limit: 1 });
  if (found.length) return;
  // :991-995 `code` is computed from the root company's code_store (account_account.py:315-322 `_compute_sql_code`)
  let code = 999999;
  const taken = async (c: string): Promise<boolean> => (await env.cr.query(
    `SELECT 1 FROM account_account a JOIN account_account_res_company_rel rel ON rel.account_account_id = a.id
      WHERE rel.res_company_id = $1 AND a.code_store->>split_part((SELECT parent_path FROM res_company WHERE id = $1), '/', 1) = $2 LIMIT 1`, [company, c])).rows.length > 0;
  while (await taken(String(code))) code -= 1;
  await loadRecords(env, "account.account", [{
    xml_id: `account.${company}_unaffected_earnings_account`,
    values: { code: String(code), name: translate(env, "Profit or Loss Appropriation", "account"), account_type: "equity_unaffected", company_ids: [[4, company]] },
    noupdate: true,
  }], false);
}

/**
 * chart_template.py:733-807 `_post_load_data(template_code, company, template_data)` through the private hook: a site's
 * compiled override (l10n_ie, l10n_nl: the cash tag of the suspense and transfer accounts; l10n_ma: the outstanding
 * accounts of the bank journals' payment method lines; l10n_uk: Northern Ireland's taxes) runs around account's,
 * `postLoadDataOf`. l10n_be's, in the base, acts only for be_comp and be_asso, which refuse there.
 */
async function postLoadData(ld: Loader, file: ChartFile, templateData: Vals): Promise<void> {
  await priv.account_chart_template._post_load_data.call(ld.env, [], [file.code, new PrivateRecords("res.company", [ld.company]), templateData],
    async (_e, _ids, args) => {
      sameLoad(ld, file, "_post_load_data", args);
      await postLoadDataOf(ld, file, (args[2] ?? {}) as Vals);
      return null;
    });
}

/** chart_template.py:809-813 account's `_get_bank_fees_reco_account` with l10n_be's (template_be.py:73-77) when installed. */
async function bankFeesRecoAccount(ld: Loader, company: number): Promise<number | null> {
  const env = ld.env;
  const acc = env.withContext({ ...env.context, allowed_company_ids: [company] });
  const be = (await one(env, "SELECT 1 FROM ir_module_module WHERE name = 'l10n_be' AND state = 'installed'", [])) ? await ld.ref("a6560", false) : null;
  if (be !== null) return be;
  const [byName] = await search(acc, "account.account", [cond("company_ids", "in", [company]), cond("name", "like", "Bank Fees")], { limit: 1 });
  return byName ?? (await search(acc, "account.account", [cond("company_ids", "in", [company]), cond("account_type", "=", "expense")], { limit: 1 }))[0] ?? null;
}

/** chart_template.py:733-807 account's `_post_load_data` */
async function postLoadDataOf(ld: Loader, file: ChartFile, templateData: Vals): Promise<void> {
  // l10n_be template_be.py:90-95: the purchase journal's non-deductible account of be_comp and be_asso (not ported)
  if ((file.code === "be_comp" || file.code === "be_asso") && await one(ld.env, "SELECT 1 FROM ir_module_module WHERE name = 'l10n_be' AND state = 'installed'", [])) {
    throw new NotPorted(`l10n_be's _post_load_data of ${file.code} (the purchase journal's non-deductible account)`);
  }
  const env = ld.env;
  const company = ld.company;
  await setupUtilityBankAccounts(ld, file, templateData);
  await unaffectedEarningsAccount(env, company);
  let c = await companyRow(env, company);
  for (const journal of await search(env, "account.journal", [cond("type", "in", ["cash", "bank", "credit"]), cond("company_id", "=", company)])) {
    const j = (await one<Vals>(env, "SELECT suspense_account_id, profit_account_id, loss_account_id FROM account_journal WHERE id = $1", [journal]))!;
    await write(env, "account.journal", [journal], { suspense_account_id: j["suspense_account_id"] || c["account_journal_suspense_account_id"] || false });
    await write(env, "account.journal", [journal], { profit_account_id: j["profit_account_id"] || c["default_cash_difference_income_account_id"] || false });
    await write(env, "account.journal", [journal], { loss_account_id: j["loss_account_id"] || c["default_cash_difference_expense_account_id"] || false });
  }
  if (!c["tax_cash_basis_journal_id"]) await write(env, "res.company", [company], { tax_cash_basis_journal_id: await ld.ref("caba", false) ?? false });
  if (!c["currency_exchange_journal_id"]) await write(env, "res.company", [company], { currency_exchange_journal_id: await ld.ref("exch", false) ?? false });
  c = await companyRow(env, company);
  for (const [xmlid, fname] of [["sale", "income_account_id"], ["purchase", "expense_account_id"]] as const) {
    const journal = await ld.ref(xmlid, false);
    const account = await accountOfCompany(env, company, fname);
    if (journal === null || !account) continue;
    const j = (await one<{ d: number | null; same: boolean }>(env, "SELECT default_account_id AS d, write_date = create_date AS same FROM account_journal WHERE id = $1", [journal]))!;
    if (!j.d && j.same) await write(env, "account.journal", [journal], { default_account_id: account });
  }
  for (const [fname, uses] of [["account_sale_tax_id", ["sale", "all"]], ["account_purchase_tax_id", ["purchase", "all"]]] as const) {
    if (c[fname]) continue;
    const [tax] = await search(env, "account.tax", [companyDomain(company), cond("type_tax_use", "in", [...uses])], { limit: 1 });
    await write(env, "res.company", [company], { [fname]: tax ?? false });
  }
  c = await companyRow(env, company);
  // :772-791 default taxes on the products that have taxes in other companies only (product.py:271-289)
  for (const [taxField, prodField] of [["account_sale_tax_id", "taxes_id"], ["account_purchase_tax_id", "supplier_taxes_id"]] as const) {
    if (!c[taxField]) continue;
    const products = await search(env.sudo(), "product.template", [companyDomain(company), cond(prodField, "!=", false), cond(prodField, "not any", companyDomain(company))]);
    if (products.length) await write(env.sudo(), "product.template", products, { [prodField]: [[4, c[taxField]]] });
  }
  if (!c["parent_id"] && await env.model("account.tax").searchCount(cond("tax_exigibility", "=", "on_payment"), 1)) {
    await write(env, "res.company", [company], { tax_exigibility: true });
  }
  const reco = await ld.ref("internal_transfer_reco", false);
  if (reco !== null) {
    const lines = (await env.cr.query<{ id: number }>("SELECT id FROM account_reconcile_model_line WHERE model_id = $1 ORDER BY sequence, id", [reco])).rows.map((r) => r.id);
    await write(env.sudo(), "account.reconcile.model.line", lines, { account_id: c["transfer_account_id"] ?? false });
  }
  const fees = await ld.ref("bank_fees_reco", false);
  if (fees !== null) {
    const lines = (await env.cr.query<{ id: number }>("SELECT id FROM account_reconcile_model_line WHERE model_id = $1 ORDER BY sequence, id", [fees])).rows.map((r) => r.id);
    // :809-813 `_get_bank_fees_reco_account(company)` through the private hook: a site's compiled override (l10n_lu: its
    // 613330 account) runs around account's with l10n_be's (template_be.py:73-77, in the base: the company's `a6560`
    // when it exists, whatever the template), `bankFeesRecoAccount`
    const out = await priv.account_chart_template._get_bank_fees_reco_account.call(env, [], [new PrivateRecords("res.company", [company])], async (_e, _ids, args) => {
      if (!isCompany(args[0], company)) throw new NotPorted("account.chart.template._get_bank_fees_reco_account called by an override with another company");
      const account = await bankFeesRecoAccount(ld, company);
      return new PrivateRecords("account.account", account === null ? [] : [account]);
    });
    const ids = out instanceof PrivateRecords ? out.ids : Array.isArray(out) ? out as number[] : null;
    if (ids === null || ids.length > 1 || ids.some((i) => typeof i !== "number")) throw new NotPorted(`_get_bank_fees_reco_account returning ${JSON.stringify(out)}`);
    // `.id`: False for an empty recordset
    await write(env.sudo(), "account.reconcile.model.line", lines, { account_id: ids[0] ?? false });
  }
  // company.py:602-609 `_initiate_account_onboardings`: onboarding_onboarding.py:107-123 for the onboardings without a
  // progress of the company (`_compute_current_progress`, :56-69), in their order (`sequence asc, id desc`)
  const onboardings = (await env.cr.query<{ id: number; per: boolean }>(
    `SELECT o.id, (EXISTS (SELECT 1 FROM onboarding_progress p WHERE p.onboarding_id = o.id AND p.company_id IS NOT NULL)
                OR EXISTS (SELECT 1 FROM onboarding_onboarding_onboarding_onboarding_step_rel r JOIN onboarding_onboarding_step s ON s.id = r.onboarding_onboarding_step_id
                            WHERE r.onboarding_onboarding_id = o.id AND s.is_per_company)) AS per
       FROM onboarding_onboarding o WHERE o.route_name IN ('account_dashboard', 'account_return_dashboard') ORDER BY o.sequence ASC, o.id DESC`)).rows;
  const missing = [];
  for (const o of onboardings) {
    if (await one(env, "SELECT 1 FROM onboarding_progress WHERE onboarding_id = $1 AND (company_id IS NULL OR company_id = $2)", [o.id, company])) continue;
    missing.push(o);
  }
  if (missing.length) {
    const vals = [];
    for (const o of missing) {
      const steps = (await env.cr.query<{ id: number }>(
        `SELECT ps.id FROM onboarding_onboarding_onboarding_onboarding_step_rel r JOIN onboarding_progress_step ps ON ps.step_id = r.onboarding_onboarding_step_id
          WHERE r.onboarding_onboarding_id = $1 AND (ps.company_id IS NULL OR ps.company_id = $2) ORDER BY ps.id`, [o.id, company])).rows.map((r) => r.id);
      vals.push({ company_id: o.per ? company : false, onboarding_id: o.id, progress_step_ids: [[6, 0, steps]] });
    }
    await create(env.withContext({ ...env.context, allowed_company_ids: [company] }).sudo(), "onboarding.progress", vals);
  }
}

/** `company.income_account_id` / `expense_account_id` (base res_company.py:19-27 `_compute_from_ir_default`): the
 * product.category fallback of the company in ir.default (ir_default.py `_get_model_defaults`, the user's and the
 * company's rows first), an account that still exists. */
async function accountOfCompany(env: Environment, company: number, fname: string): Promise<number | null> {
  const target = ({ income_account_id: "property_account_income_categ_id", expense_account_id: "property_account_expense_categ_id" } as Record<string, string>)[fname];
  if (!target) throw new NotPorted(`res.company ${fname} default`);
  const r = (await env.cr.query<{ v: string }>(
    `SELECT d.json_value AS v FROM ir_default d JOIN ir_model_fields f ON f.id = d.field_id
      WHERE f.model = 'product.category' AND f.name = $1 AND (d.user_id IS NULL OR d.user_id = $2) AND (d.company_id IS NULL OR d.company_id = $3)
        AND d.condition IS NULL ORDER BY d.user_id, d.company_id, d.id LIMIT 1`, [target, env.uid, company])).rows[0];
  const id = r ? JSON.parse(r.v) as unknown : null;
  if (typeof id !== "number") return null;
  return (await one(env, "SELECT 1 FROM account_account WHERE id = $1", [id])) ? id : null;
}

/** chart_template.py:1516-1575 `_load_translations` for one company, with the generated `_get_field_translation`. */
async function loadTranslations(ld: Loader, file: ChartFile, data: Data, langsIn?: readonly string[]): Promise<void> {
  const env = ld.env;
  // :1525 `langs or [code for code, _name in res.lang.get_installed()]`
  const langs = langsIn ?? (await env.cr.query<{ code: string }>("SELECT code FROM res_lang WHERE active ORDER BY name")).rows.map((r) => r.code);
  for (const l of langs) if (!file.langs.includes(l)) throw new NotPorted(`chart template translations into ${l}`);
  // model -> field -> xmlid -> lang -> value, in the importer's insertion order
  const out = new Map<string, Map<string, Map<string, Record<string, string>>>>();
  const put = (model: string, field: string, xmlid: string, lang: string, value: string) => {
    const m = out.get(model) ?? new Map<string, Map<string, Record<string, string>>>(); out.set(model, m);
    const f = m.get(field) ?? new Map<string, Record<string, string>>(); m.set(field, f);
    const x = f.get(xmlid) ?? {}; f.set(xmlid, x);
    x[lang] = value;
  };
  for (const [mname, records] of data) {
    if (mname === "res.company") continue;
    const fields = ld.fields(mname);
    for (const [xmlid, record] of records) {
      if (typeof xmlid !== "string") throw new NotPorted(`translations of ${mname} by database id`);
      const fnames = [...new Set(Object.keys(record).filter((k) => k !== "__translation_module__").map((k) => k.split("@")[0]!))];
      for (const lang of langs) {
        for (const fname of fnames) {
          const field = fields.get(fname);
          if (!field || !field.translate) continue;
          const t = file.translations[lang]?.[mname]?.[fname]?.[xmlid];
          if (t) put(mname, fname, xmlid.includes(".") ? xmlid : companyXmlid(xmlid, ld.company), lang, t);
        }
      }
    }
  }
  const trLangs = langs.filter((l) => l !== "en_US");
  if (trLangs.length) {
    // :1421-1491 records of the template models of the company with a missing translation
    for (const model of TEMPLATE_MODELS) {
      const def = env.reg.model(model);
      const tfields = [...def.fields.values()].filter((f) => f.translate && f.column).map((f) => f.name);
      if (!tfields.length) continue;
      const companyCol = model === "account.account" ? "company_ids" : "company_id";
      const ids = await env.withContext({ ...env.context, active_test: false }).sudo().model(model).search(cond(companyCol, "in", [ld.company]), { order: null });
      if (!ids.length) continue;
      const missing = tfields.flatMap((f) => trLangs.map((l) => `(t.${f} ->> '${l}') IS NULL`)).join(" OR ");
      const rows = (await env.cr.query<{ name: string; module: string; fields: Record<string, Record<string, string> | null> }>(
        `SELECT d.name, d.module, json_build_object(${tfields.map((f) => `'${f}', t.${f}`).join(", ")}) AS fields
           FROM "${def.table}" t JOIN ir_model_data d ON d.model = $1 AND d.res_id = t.id
          WHERE t.id = ANY($2::int[]) AND (${missing})`, [model, ids])).rows;
      for (const row of rows) {
        for (const [field, value] of Object.entries(row.fields)) {
          if (!value || !("en_US" in value)) continue;
          const en = value["en_US"]!;
          const xmlid = `${row.module}.${row.name}`;
          for (const lang of trLangs.filter((l) => !(l in value))) {
            if (out.get(model)?.get(field)?.get(xmlid)?.[lang] !== undefined) continue;
            for (const codeModule of row.module !== "account" ? [row.module, "account"] : ["account"]) {
              const table = file.code_translations[codeModule]?.[lang];
              if (table === undefined && codeModule !== "account") throw new NotPorted(`code translations of module ${codeModule}`);
              let tr = table?.[en];
              if (!tr && /^<div>.*<\/div>$/s.test(en)) {
                const inner = table?.[en.slice(5, -6)];
                if (inner) tr = `<div>${inner}</div>`;
              }
              if (tr) { put(model, field, xmlid, lang, tr); break; }
            }
          }
        }
      }
    }
  }
  for (const [model, fields] of out) {
    const table = env.reg.model(model).table;
    for (const [field, xmlids] of fields) {
      await saveModelTranslations(env, model, table, field, [...xmlids].map(([x, v]) => {
        const dot = x.indexOf(".");
        return [x.slice(0, dot), x.slice(dot + 1), v] as [string, string, Record<string, string>];
      }), false);
    }
  }
}

/**
 * chart_template.py:1516-1575 `_load_translations(langs, companies=company)` for a company with a chart template that
 * the generated install data of a language does not cover (account's delayed translator after a module install,
 * src/models/lang_install.ts loadAccountTranslations): `_get_chart_template_data(company.chart_template)` as the
 * company's template data, the template's generated translations.
 */
export async function loadCompanyTranslations(envIn: Environment, company: number, langs: readonly string[]): Promise<void> {
  const env = envIn.sudo();
  const c = await companyRow(env, company);
  const code = String(c["chart_template"]);
  if (!await chartVerified(env, code)) throw new NotPorted(`translations of the chart template ${code} (compared with Odoo: ${[...VERIFIED].join(", ")}, and the codes of the database's overlay in its chart/verified.json)`);
  if (c["parent_id"]) throw new NotPorted("chart template translations of a branch");
  const file = await chartFile(env, code);
  const { data } = await templateDataFor(env, file, company);
  await loadTranslations(new Loader(env, company, Number(c["root_id"])), file, data, langs);
}

/** The data of `_get_chart_template_data(code)` for this company. */
export async function templateDataFor(env: Environment, file: ChartFile, company: number): Promise<{ templateData: Vals; data: Data }> {
  const data: Data = new Map();
  const c = await companyRow(env, company);
  let stateCode: string | null = null;
  if (c["state_id"]) stateCode = (await one<{ code: string }>(env, "SELECT code FROM res_country_state WHERE id = $1", [c["state_id"]]))?.code ?? null;
  for (const [model, rows] of file.data) {
    const m = new Map<Key, Vals>();
    for (const [xmlid, vals] of rows) {
      if (xmlid === "__company__") {
        const variant = stateCode !== null ? file.res_company_by_state[stateCode] : undefined;
        m.set(company, clone(variant ?? vals));
      } else {
        m.set(xmlid, clone(vals));
      }
    }
    data.set(model, m);
  }
  return { templateData: clone(file.template_data) as Vals, data };
}

/** chart_template.py:184-261 `_load` */
export async function loadChartTemplate(envIn: Environment, code: string, company: number, installDemo: boolean): Promise<void> {
  if (!envIn.su && !await hasGroup(envIn, "base.group_system")) throw new AccessError("Only administrators can install chart templates");
  if (!await chartVerified(envIn, code)) throw new NotPorted(`loading the chart template ${code} (compared with Odoo: ${[...VERIFIED].join(", ")}, and the codes of the database's overlay in its chart/verified.json)`);
  let env = envIn.sudo();
  const file = await chartFile(env, code);
  const mapping = file.mapping[code];
  if (!mapping) throw new NotPorted(`chart template ${code} is not in its generated file`);
  let c = await companyRow(env, company);
  if (!c["country_id"]) await write(env, "res.company", [company], { country_id: mapping.country_id ?? false });
  const module = await one<{ state: string }>(env, "SELECT state FROM ir_module_module WHERE name = $1", [mapping.module]);
  if (module?.state === "uninstalled") throw new NotPorted(`button_immediate_install of ${mapping.module} from the chart template`);
  env = env.withContext({ ...env.context, default_company_id: company, allowed_company_ids: [company], tracking_disable: true, lang: "en_US", chart_template_load: true });
  c = await companyRow(env, company);
  const reload = code === c["chart_template"];
  if (reload) throw new NotPorted("reloading the company's own chart template (_pre_reload_data)");
  await write(env, "res.company", [company], { chart_template: code });
  const root = c["root_id"] as number;
  if (!await existingAccounting(env, root) || installDemo) {
    // :226-236 the records of the template models (and moves) of the company and its children are deleted
    const all = env.withContext({ ...env.context, active_test: false });
    for (const model of ["account.move", ...[...TEMPLATE_MODELS].reverse()]) {
      const field = model === "account.account" ? "company_ids" : "company_id";
      const ids = await all.model(model).search(cond(field, "child_of", [company]), { order: null });
      if (ids.length) throw new NotPorted(`chart template on a company that already has ${model} records`);
    }
  }
  const { templateData, data } = await templateDataFor(env, file, company);
  if (c["parent_id"]) throw new NotPorted("chart template on a branch");
  const ld = new Loader(env, company, root);
  await derefTaxTags(ld, file, data);
  const loaded = await preLoadData(ld, file, templateData, data);
  await loadData(ld, loaded);
  await postLoadData(ld, file, templateData);
  await loadTranslations(ld, file, loaded);
  if (installDemo) {
    // :256-262 `with self.env.cr.savepoint()`: the savepoint flushes on entry, the precommit with it (held tracking)
    if (trackingHeld(env.cr)) await flushHeldTracking(env, true);
    // the precommit's `_track_finalize` (mail_track_mixin.py:133-) pops the `_track_discard` of the records created so
    // far (sql_db.py:295-304 `flush`): their later writes are tracked again (l10n_cn's second demo company's partners
    // write the first one's partner)
    noteCommitPoint(env.cr);
    trackSavepointFlush(env.cr);
    // :256-262 the demo in the original language (the rest of the chart's context kept), a failure only logged
    const { lang: _lang, ...ctx } = env.context;
    const denv = env.withContext(envIn.context["lang"] === undefined ? ctx : { ...ctx, lang: envIn.context["lang"] });
    const sp = `install_demo_${company}`;
    await env.cr.query(`SAVEPOINT ${sp}`);
    try {
      await installAccountDemo(new Loader(denv, company, root), company, file.code, (e) => new Loader(e, company, root));
      await env.cr.query(`RELEASE SAVEPOINT ${sp}`);
      // the savepoint's close flushes too (sql_db.py:144-178): the demo's records are tracked again
      noteCommitPoint(env.cr);
      trackSavepointFlush(env.cr);
    } catch (e) {
      if (!(e instanceof UserError || e instanceof ValidationError)) throw e;
      await env.cr.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      throw new NotPorted(`a failing _install_demo (Odoo logs it and goes on): ${e.message}`);
    }
  }
  if ((await env.cr.query("SELECT 1 FROM res_company WHERE parent_id = $1", [company])).rows.length) throw new NotPorted("chart template on a company with branches");
}

/** The loader's tax data as the compiled side sees it: a handle it can only pass on (`_deref_account_tags`). */
class TaxDataHandle {
  constructor(readonly data: Data) {}
}

/**
 * chart_template.py:1308-1315 `_deref_account_tags(template_code, tax_data)` (called by `_get_account_tax` with the
 * loaded code, skipped by the generator) through the private hook: a site's compiled override (l10n_uk: xi's tags
 * are uk's) runs around account's. The tax data goes as a handle: an override that reads or changes it refuses.
 */
export async function derefTaxTags(ld: Loader, file: ChartFile, data: Data): Promise<void> {
  await priv.account_chart_template._deref_account_tags.call(ld.env, [], [file.code, new TaxDataHandle(data)], async (_e, _ids, args) => {
    const code = args[0];
    if (typeof code !== "string" || !(args[1] instanceof TaxDataHandle) || args[1].data !== data) {
      throw new NotPorted(`account.chart.template._deref_account_tags called by an override with other tax data (${JSON.stringify(code)})`);
    }
    await derefTaxTagsOf(ld, file, code, data);
    return null;
  });
}

/** chart_template.py:1258-1315 `_get_tag_mapper` and account's `_deref_account_tags`. */
async function derefTaxTagsOf(ld: Loader, file: ChartFile, code: string, data: Data): Promise<void> {
  const taxes = data.get("account.tax");
  if (!taxes) return;
  if (!file.mapping[code]) throw new NotPorted(`_deref_account_tags of ${code}: not in the chart file's mapping of ${file.code}`);
  const country = file.mapping[code]?.country_id ?? null;
  const tags = new Map<string, number>();
  for (const r of (await ld.env.cr.query<{ id: number; name: string }>(
    "SELECT id, name->>'en_US' AS name FROM account_account_tag WHERE applicability = 'taxes' AND country_id IS NOT DISTINCT FROM $1 ORDER BY id", [country || null])).rows) {
    tags.set(r.name, r.id); // a dict comprehension: the last record of a name wins
  }
  for (const [, tax] of taxes) {
    for (const fname of ["repartition_line_ids", "invoice_repartition_line_ids", "refund_repartition_line_ids"]) {
      const lines = tax[fname];
      if (!Array.isArray(lines)) continue;
      for (const element of lines) {
        if (!Array.isArray(element) || typeof element[0] !== "number" || !COMMANDS.has(element[0]) || !isDict(element[2]) || typeof element[2]["tag_ids"] !== "string") continue;
        const res: (number | string)[] = [];
        for (const tag of (element[2]["tag_ids"] as string).split(TAX_TAG_DELIMITER)) {
          const m = /^(\w+)\.\w+$/.exec(tag);
          if (m && (await one(ld.env, "SELECT 1 FROM ir_module_module WHERE name = $1", [m[1]]))) { res.push(tag); continue; }
          const formatted = tag.trim().replace(/\s+/g, " ");
          const id = tags.get(formatted);
          if (!id) throw new NotPorted(`chart template ${file.code}: the RedirectWarning for the missing tax tag ${formatted}`);
          res.push(id);
        }
        element[2]["tag_ids"] = [[6, 0, res]];
      }
    }
  }
}

/** chart_template.py:151-182 `try_loading` */
export async function tryLoading(env: Environment, code: string | null, company: number, installDemo = false): Promise<void> {
  if (!company) return;
  if (!code) throw new NotPorted("try_loading without a template code (_guess_chart_template)");
  if (code === "syscohada" || code === "syscebnl") throw new NotPorted("try_loading of syscohada/syscebnl");
  await loadChartTemplate(env, code, company, installDemo);
}


registerRecordCompute("onboarding.progress", {
  // onboarding_progress.py:29-38: done when every step of the onboarding has a done (or just done) progress step
  onboarding_state: async (env, rec) => {
    if (rec.id === null) throw new NotPorted("onboarding.progress onboarding_state of a new record");
    const r = (await env.cr.query<{ done: string; steps: string }>(
      `SELECT (SELECT count(*) FROM onboarding_progress_onboarding_progress_step_rel rel JOIN onboarding_progress_step ps ON ps.id = rel.onboarding_progress_step_id
                WHERE rel.onboarding_progress_id = p.id AND ps.step_state IN ('just_done', 'done')) AS done,
              (SELECT count(*) FROM onboarding_onboarding_onboarding_onboarding_step_rel r WHERE r.onboarding_onboarding_id = p.onboarding_id) AS steps
         FROM onboarding_progress p WHERE p.id = $1`, [rec.id])).rows[0]!;
    return Number(r.done) !== Number(r.steps) ? "not_done" : "done";
  },
});
