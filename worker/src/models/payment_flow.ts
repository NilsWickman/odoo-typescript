/**
 * The online payment flow of the payment module (odoo/addons/payment, account_payment) for the providers a site
 * installs: the provider's setup on install (payment/__init__.py `setup_provider`). The private methods a provider
 * module overrides run through callPrivate (src/orm/private_hooks.ts, private_hooks.json).
 */
import { NotPorted } from "../errors";
import { and, cond, parseDomain } from "../orm/domain";
import { create } from "../orm/create";
import { registerOverrides, write } from "../orm/write";
import { idsModel, PrivateKwargs, PrivateRecords } from "../orm/private_hooks";
import { Markup } from "../pyexpr/values";
import { registerMethod } from "../http/methods";
import { envFor } from "../web/common";
import { copy } from "../web/save";
import type { Domain, Environment } from "../orm/types";
import { translate } from "./util";
import { formatAmount } from "./account_taxes";
import { defineComputes } from "./tail_util";
import { registerPyMethod } from "../qweb/records";
import { commitProgress, registerCronJob } from "./ir_cron";
import { unlink } from "../orm/unlink";
import { isPyFloat, plainNumber } from "../orm/values";
import { withProcessedImages } from "../orm/image_write";
import { withPrecommit } from "./precommit";
import * as priv from "../orm/dispatch_gen";

// base ir_ui_view.py:411-417 `_compute_xml_id`: the first of the view's xml ids in ir.model.data `_order` (module,
// model, name), '' without one (the payment form reads its provider's inline form view's)
defineComputes("ir.ui.view", {
  xml_id: async (env, rec) => {
    if (rec.id === null) return "";
    const r = (await env.sudo().cr.query<{ x: string }>(
      "SELECT module || '.' || name AS x FROM ir_model_data WHERE model = 'ir.ui.view' AND res_id = $1 ORDER BY module, model, name LIMIT 1", [rec.id])).rows[0];
    return r?.x ?? "";
  },
});

// payment_provider.py:1245-1254 `_get_code` (the template payment.form): the code (account_payment_custom's override
// is a private method without a hook: a site with it is not built)
registerPyMethod("payment.provider", "_get_code", async (recs) => {
  recs.ensureOne();
  return providerCode(recs.env, recs.ids[0]!);
});

/** payment_provider.py:1245-1254 `_get_code` through its hook (account_payment_custom: a wire transfer's custom_mode). */
export async function providerCode(env: Environment, provider: number): Promise<string> {
  const c = await priv.payment_provider._get_code.call(env, [provider], [], async (e, ids) => {
    const [r] = await e.sudo().model("payment.provider").read([...ids], ["code"], "");
    return r?.["code"] ?? null;
  });
  if (typeof c !== "string") throw new NotPorted("payment.provider._get_code() returned something else than a code");
  return c;
}

const P = "payment.provider";
const PM = "payment.method";

const idOf = (v: unknown): number | null => (typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : null);

/**
 * payment_method.py:188-203 `write` of `active`: the brands follow; an archived method archives its tokens (the hand
 * port creates none: an active token refuses).
 */
async function writeMethodsActive(env: Environment, ids: readonly number[], active: boolean): Promise<void> {
  if (!ids.length) return;
  const brands = (await env.cr.query<{ id: number }>("SELECT id FROM payment_method WHERE primary_payment_method_id = ANY($1::int[]) ORDER BY id", [[...ids]])).rows.map((r) => r.id);
  if (brands.length) await write(env, PM, brands, { active });
  if (!active && (await env.cr.query("SELECT 1 FROM payment_token WHERE active AND payment_method_id = ANY($1::int[]) LIMIT 1", [[...ids, ...brands]])).rows.length) {
    throw new NotPorted("payment.method archived with active tokens");
  }
  await write(env, PM, ids, { active });
}

/** payment_provider.py:253-272 `_compute_primary_payment_method_ids`: the provider's methods without a primary one, not 'unknown' (in id order). */
async function primaryMethods(env: Environment, provider: number): Promise<number[]> {
  return (await env.cr.query<{ id: number }>(
    "SELECT id FROM payment_method WHERE provider_id = $1 AND primary_payment_method_id IS NULL AND code != 'unknown' ORDER BY id", [provider])).rows.map((r) => r.id);
}

/**
 * payment_provider.py:514-527 `_activate_default_pms`: the primary methods compatible with the provider's capture,
 * whose code is among `_get_default_payment_method_codes()` (callPrivate: payment's empty set as the hand), and
 * their brands, activated.
 */
async function activateDefaultPms(env: Environment, provider: number): Promise<void> {
  const [prov] = await env.model(P).read([provider], ["capture_manually"], "");
  const pms = await primaryMethods(env, provider);
  if (!pms.length) return;
  const rows = await env.withContext({ ...env.context, active_test: false }).model(PM).read(pms, ["code", "support_manual_capture"], "");
  const compatible = rows.filter((r) => r["support_manual_capture"] !== "none" || !prov?.["capture_manually"]);
  const codes = await priv.payment_provider._get_default_payment_method_codes.call(env, [provider], [], async () => []);
  if (!Array.isArray(codes) || codes.some((c) => typeof c !== "string")) throw new NotPorted("payment.provider._get_default_payment_method_codes() returned something else than codes");
  const activate = compatible.filter((r) => codes.includes(String(r["code"]))).map((r) => Number(r["id"]));
  if (!activate.length) return;
  const brands = (await env.cr.query<{ id: number }>("SELECT id FROM payment_method WHERE primary_payment_method_id = ANY($1::int[]) ORDER BY id", [activate])).rows.map((r) => r.id);
  await writeMethodsActive(env, [...activate, ...brands], true);
}

/**
 * payment_provider.py:540-560 `copy` and `copy_data` (with payment_custom's): the providers copied (a copy without a name or company in the
 * default is renamed "(copy)": refused), then their primary payment methods copied onto the new provider and the
 * brands of each onto the new primary one.
 */
export async function copyProviders(env: Environment, ids: readonly number[], defaults: Record<string, unknown>): Promise<number[]> {
  const out: number[] = [];
  const customMode = env.reg.model(P).fields.has("custom_mode");
  for (const src of ids) {
    // payment_custom payment_provider.py:51-58 `copy_data`: a wire transfer provider's copy is live
    const wire = customMode && (await env.cr.query<{ m: string | null }>("SELECT custom_mode AS m FROM payment_provider WHERE id = $1", [src])).rows[0]?.m === "wire_transfer";
    const [created] = await copy(env, P, [src], wire ? { ...defaults, is_live: true } : defaults);
    const srcPrimary = (await env.cr.query<{ id: number }>(
      "SELECT id FROM payment_method WHERE provider_id = $1 AND primary_payment_method_id IS NULL ORDER BY id", [src])).rows.map((r) => r.id);
    if (srcPrimary.length) {
      const newPrimary = await copy(env.withContext({ ...env.context, active_test: false }), PM, srcPrimary, { provider_id: created! });
      for (let i = 0; i < srcPrimary.length; i++) {
        const brands = (await env.cr.query<{ id: number }>("SELECT id FROM payment_method WHERE primary_payment_method_id = $1 ORDER BY id", [srcPrimary[i]])).rows.map((r) => r.id);
        if (brands.length) await copy(env.withContext({ ...env.context, active_test: false }), PM, brands, { provider_id: created!, primary_payment_method_id: newPrimary[i]! });
      }
    }
    out.push(created!);
  }
  return out;
}

// :553-559 `copy_data`: without a name or company in the default, the copy's name is marked "(copy)" in each language
// (translate.py mark_as_copy): refused on every copy path (copy, copy_data over RPC)
registerOverrides(P, {
  copyDefaults: (given) => {
    if (!("name" in given) && !("company_id" in given)) throw new NotPorted("payment.provider copy renamed '(copy)' (copy_data mark_as_copy)");
    return { ...given };
  },
});

registerMethod(P, "copy", async (env0, ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const dflt = kwargs["default"] ?? args[0];
  if (dflt !== undefined && dflt !== null && dflt !== false && (typeof dflt !== "object" || Array.isArray(dflt))) throw new NotPorted("copy default");
  return copyProviders(env, ids ?? [], (dflt && typeof dflt === "object" ? dflt : {}) as Record<string, unknown>);
}, { apiModel: false });

/** payment_provider.py:1222-1243 `_toggle_post_processing_cron`. */
async function togglePostProcessingCron(env: Environment): Promise<void> {
  const cron = await env.reg.xmlid(env.cr, "payment.post_processing_cron");
  if (typeof cron !== "number") return;
  const su = env.sudo();
  const installed = (await su.model(P).search(
    parseDomain(["|", ["module_state", "in", ["installed", "to install"]], ["module_id", "=", false]]), { limit: 1 })).length > 0;
  await write(su.withContext({ ...su.context, active_test: false }), "ir.cron", [cron], { active: installed });
}

/**
 * payment/__init__.py `setup_provider(env, code)`: payment_provider.py:1148-1170 `_setup_provider` (the default
 * methods of the first provider of the code, the provider copied into each root company without one, the
 * post-processing cron) and account_payment's (payment_provider.py:160-175: the account.payment.method of the code).
 */
export async function setupProvider(env: Environment, code: string, kwargs: Readonly<Record<string, unknown>> = {}): Promise<void> {
  // a site's override (account_payment_custom: the wire transfer cron after super()) runs around the hand's
  await priv.payment_provider._setup_provider.call(env, [], [code, new PrivateKwargs({ ...kwargs })], async (e, _ids, args) => {
    const last = args[args.length - 1];
    const kw = last instanceof PrivateKwargs ? last.values : {};
    await setupProviderHand(e, String(args[0]), kw);
    return null;
  });
}

/** payment_provider.py:1192-1200 `_get_provider_domain(provider_code, **kwargs)`: `[('code', '=', code)]` as the hand. */
async function providerDomain(env: Environment, code: string, kwargs: Readonly<Record<string, unknown>>): Promise<Domain> {
  const d = await priv.payment_provider._get_provider_domain.call(env, [], [code, new PrivateKwargs({ ...kwargs })], async (_e, _ids, args) => [["code", "=", args[0]]]);
  if (!Array.isArray(d)) throw new NotPorted("payment.provider._get_provider_domain() returned something else than a domain");
  return parseDomain(d as never);
}

async function setupProviderHand(env: Environment, code: string, kwargs: Readonly<Record<string, unknown>>): Promise<void> {
  const existing = await env.model(P).search(await providerDomain(env, code, kwargs));
  const main = existing[0];
  if (main !== undefined) await activateDefaultPms(env, main);
  const companies = new Set((await env.model(P).read([...existing], ["company_id"], "")).map((r) => idOf(r["company_id"])));
  const needing = await env.model("res.company").search(and([cond("id", "not in", [...companies].filter((c): c is number => c !== null)), cond("parent_id", "=", false)]));
  // the copies' related images are computed at the flush after them (measured: after every copy)
  await withProcessedImages(env, async () => {
    for (const company of needing) {
      if (main === undefined) throw new NotPorted("payment.provider._setup_provider without a provider of the code (copy of an empty recordset)");
      await copyProviders(env, [main], { company_id: company });
    }
  });
  await togglePostProcessingCron(env);
  // account_payment payment_provider.py:166-175 `_setup_payment_method`
  if (code !== "none" && code !== "custom") {
    // :126-127 `_get_provider_payment_method`: by code only
    const existingMethod = await env.model("account.payment.method").search(cond("code", "=", code), { limit: 1 });
    if (!existingMethod.length) {
      // `dict(self._fields['code']._description_selection(self.env))[code]`, the install's environment: no language
      if (env.lang && env.lang !== "en_US") throw new NotPorted("account.payment.method of a provider set up in another language");
      const label = (await env.cr.query<{ l: string }>(
        `SELECT s.name->>'en_US' AS l FROM ir_model_fields_selection s JOIN ir_model_fields f ON f.id = s.field_id
          WHERE f.model = 'payment.provider' AND f.name = 'code' AND s.value = $1`, [code])).rows[0]?.l;
      if (label === undefined) throw new NotPorted(`payment provider code ${code} without its label`);
      await create(env.sudo(), "account.payment.method", [{ name: label, code, payment_type: "inbound" }]);
    }
  }
}

/** payment/utils.py:60-93 `add_to_report`: {category: Map(record id -> {available, reason})}, in the order added. */
export interface AvailabilityReport { providers?: Map<number, { available: boolean; reason: string }>; payment_methods?: Map<number, { available: boolean; reason: string }> }

function addToReport(report: AvailabilityReport, category: "providers" | "payment_methods", ids: readonly number[], available = true, reason = ""): void {
  if (!ids.length) return;
  const m = report[category] ?? new Map();
  report[category] = m;
  for (const id of ids) m.set(id, { available, reason });
}

/** The values of payment/controllers/portal.py:198-272 `_prepare_payment_form_values` for a payment (not a validation, nor express). */
export interface PaymentFormValues {
  providers: number[];
  paymentMethods: number[];
  tokens: number[];
  showTokenizeInput: Map<number, boolean>;
  report: AvailabilityReport;
}

/** payment const.py:541-551 REPORT_REASONS_MAPPING (`_lt`), in the environment's language. */
const reason = (env: Environment, text: string): string => translate(env, text, "payment");

/**
 * payment_provider.py:671-802 `_find_available_providers` (with account_payment's pricelist filter, payment_provider.py
 * :131-155), :804-881 `_find_available_payment_methods`, payment_method.py:222-273 `_deduplicate_by_code`, :883-895
 * `_find_available_tokens` and portal.py:274-291 `_compute_show_tokenize_input_mapping`, as superuser (the controller's
 * sudo), for `env.uid`'s internal or not status. Providers or methods with countries, currencies or amount limits, and a
 * tokenization requirement, refuse where they would filter.
 */
export async function paymentFormValues(env: Environment, companyId: number, partnerId: number, amount: number, currencyId: number | null,
  extra: Readonly<Record<string, unknown>> = {}): Promise<PaymentFormValues> {
  const report: AvailabilityReport = {};
  const providers = await availableProviders(env, companyId, partnerId, amount, currencyId, extra, report);
  return paymentFormRest(env, partnerId, currencyId, amount, providers, report);
}

/** payment's and account_payment's `_find_available_providers` (the hand of the hook below), its report entries added. */
async function handProviders(env: Environment, companyId: number, partnerId: number, currencyId: number | null, report: AvailabilityReport): Promise<number[]> {
  const su = env.sudo();
  const path = (await su.cr.query<{ parent_path: string }>("SELECT parent_path FROM res_company WHERE id = $1", [companyId])).rows[0]!.parent_path;
  const parents = path.split("/").slice(0, -1).map(Number);
  let providers = await su.model(P).search(parseDomain(["|", ["module_state", "=", "installed"], ["module_id", "=", false], ["company_id", "in", [...parents, false]]]));
  addToReport(report, "providers", providers);
  // :697-698 `self.env.user._is_internal()` of the requesting user (the env is sudoed, not its user)
  const internal = (await env.cr.query("SELECT 1 FROM res_groups_users_rel r JOIN ir_model_data d ON d.model = 'res.groups' AND d.res_id = r.gid AND d.module = 'base' AND d.name = 'group_user' WHERE r.uid = $1", [env.uid])).rows.length > 0;
  if (!internal && providers.length) {
    providers = (await su.cr.query<{ id: number }>("SELECT id FROM payment_provider WHERE id = ANY($1::int[]) AND is_published", [providers])).rows.map((r) => r.id).sort((a, b) => providers.indexOf(a) - providers.indexOf(b));
  }
  if (providers.length) {
    const [partner] = await su.model("res.partner").read([partnerId], ["country_id", "property_product_pricelist"], "");
    const country = idOf(partner?.["country_id"]);
    const restricted = async (table: string, col: string, ids: number[]): Promise<boolean> =>
      (await su.cr.query(`SELECT 1 FROM ${table} WHERE ${col} = ANY($1::int[]) LIMIT 1`, [ids])).rows.length > 0;
    if (country !== null && await restricted("payment_country_rel", "payment_id", providers)) throw new NotPorted("payment providers with available countries");
    if (currencyId !== null && await restricted("payment_currency_rel", "payment_provider_id", providers)) throw new NotPorted("payment providers with available currencies");
    const limits = (await su.cr.query("SELECT 1 FROM payment_provider WHERE id = ANY($1::int[]) AND (COALESCE(minimum_amount, 0) != 0 OR COALESCE(maximum_amount, 0) != 0) LIMIT 1", [providers])).rows.length;
    if (limits && currencyId !== null) throw new NotPorted("payment providers with minimum or maximum amounts");
    // account_payment's pricelist filter
    const pricelist = idOf(partner?.["property_product_pricelist"]);
    if (pricelist !== null && await restricted("payment_provider_product_pricelist_rel", "payment_provider_id", providers)) throw new NotPorted("payment providers with available pricelists");
  }
  return providers;
}

/**
 * payment_provider.py:671-802 `_find_available_providers(company_id, partner_id, amount, *, currency_id, force_tokenization,
 * is_express_checkout, is_validation, report, **kwargs)` through callPrivate (account_payment_custom's pay-on-invoice
 * filter for invoices). The report is a dict keyed by records, which the bridge carries as a Map keyed by PrivateRecords
 * and refills in place with the override's entries. The bridge gives a compiled super() copies of its arguments, so
 * the hand's own entries (payment utils.py `add_to_report`) are in the report before the call: the same dict an
 * override finds after its super(), which is where account_payment_custom reads and writes it. The hand, as that
 * super(), checks it is called with the caller's arguments and gives the same providers.
 */
async function availableProviders(env: Environment, companyId: number, partnerId: number, amount: number, currencyId: number | null,
  extra: Readonly<Record<string, unknown>>, report: AvailabilityReport): Promise<number[]> {
  const su = env.sudo();
  const providers = await handProviders(env, companyId, partnerId, currencyId, report);
  const toKeyed = (m: Map<number, { available: boolean; reason: string }> | undefined, model: string): Map<PrivateRecords, unknown> =>
    new Map([...(m ?? new Map())].map(([id, v]) => [new PrivateRecords(model, [id]), { ...v }]));
  const pyReport: Record<string, unknown> = {};
  if (report.providers) pyReport["providers"] = toKeyed(report.providers, P);
  if (report.payment_methods) pyReport["payment_methods"] = toKeyed(report.payment_methods, "payment.method");
  const kw = { currency_id: currencyId ?? null, force_tokenization: false, is_express_checkout: false, is_validation: false, report: pyReport, ...extra };
  const out = await priv.payment_provider._find_available_providers.call(su, [], [companyId, partnerId, amount, new PrivateKwargs(kw)], async (_env, _ids, args) => {
    const last = args[args.length - 1];
    const got = last instanceof PrivateKwargs ? last.values : {};
    const same = args.length === 4 && args[0] === companyId && args[1] === partnerId && (isPyFloat(args[2]) ? args[2].float : args[2]) === amount
      && Object.keys(kw).every((k) => k === "report" || got[k] === (kw as Record<string, unknown>)[k])
      && Object.keys(got).every((k) => k in kw);
    if (!same) throw new NotPorted("_find_available_providers through a compiled super() with other arguments than the caller's");
    return new PrivateRecords(P, providers);
  });
  const ids = out instanceof PrivateRecords && out.model === P ? [...out.ids] : Array.isArray(out) && idsModel(out) === P ? out as number[] : null;
  if (ids === null) throw new NotPorted("_find_available_providers giving other than providers");
  // the report back, in its order: a lazy reason (REPORT_REASONS_MAPPING) in the request's language
  const back = (x: unknown): Map<number, { available: boolean; reason: string }> | undefined => {
    if (x === undefined) return undefined;
    if (!(x instanceof Map)) throw new NotPorted("an availability report category not keyed by records");
    const m = new Map<number, { available: boolean; reason: string }>();
    for (const [k, v] of x) {
      const id = k instanceof PrivateRecords && k.ids.length === 1 ? k.ids[0]! : null;
      const o = v as Record<string, unknown>;
      if (id === null || o === null || typeof o !== "object") throw new NotPorted("an availability report entry of other than one record");
      const r = o["reason"] as unknown;
      const text = typeof r === "string" ? r
        : r !== null && typeof r === "object" && (r as Record<string, unknown>)["kind"] === "lazy" ? translate(env, String((r as Record<string, unknown>)["source"]), String((r as Record<string, unknown>)["module"]))
        : null;
      if (text === null || typeof o["available"] !== "boolean") throw new NotPorted("an availability report entry with another reason");
      m.set(id, { available: o["available"] as boolean, reason: text });
    }
    return m;
  };
  for (const k of Object.keys(pyReport)) if (k !== "providers" && k !== "payment_methods") throw new NotPorted(`availability report category ${k}`);
  const providersBack = back(pyReport["providers"]);
  const methodsBack = back(pyReport["payment_methods"]);
  delete report.providers;
  delete report.payment_methods;
  if (providersBack) report.providers = providersBack;
  if (methodsBack) report.payment_methods = methodsBack;
  return ids;
}

async function paymentFormRest(env: Environment, partnerId: number, currencyId: number | null, amount: number, providers: number[],
  report: AvailabilityReport): Promise<PaymentFormValues> {
  const su = env.sudo();
  // :822-881 the providers' active primary methods (`primary_payment_method_ids`: each provider's by id, :253-272,
  // in the providers' order)
  const pms: number[] = [];
  for (const p of providers) {
    pms.push(...(await su.cr.query<{ id: number }>(
      "SELECT id FROM payment_method WHERE provider_id = $1 AND primary_payment_method_id IS NULL AND code != 'unknown' AND active ORDER BY id", [p])).rows.map((r) => r.id));
  }
  addToReport(report, "payment_methods", pms);
  if (pms.length) {
    const [partner] = await su.model("res.partner").read([partnerId], ["country_id"], "");
    const restricted = async (table: string): Promise<boolean> =>
      (await su.cr.query(`SELECT 1 FROM ${table} WHERE payment_method_id = ANY($1::int[]) LIMIT 1`, [pms])).rows.length > 0;
    if (idOf(partner?.["country_id"]) !== null && await restricted("payment_method_res_country_rel")) throw new NotPorted("payment methods with supported countries");
    if (currencyId !== null && await restricted("payment_method_res_currency_rel")) throw new NotPorted("payment methods with supported currencies");
  }
  // payment_method.py:222-273 `_deduplicate_by_code`: sorted by (provider sequence, provider name, sequence, name),
  // the first of each code kept, in the order of the codes' first appearance; the report's methods re-sorted
  const lang = env.lang ?? "en_US";
  const rows = pms.length ? (await su.cr.query<{ id: number; code: string; ps: number | null; pn: string; s: number | null; n: string }>(
    `SELECT m.id, m.code, p.sequence AS ps, COALESCE(p.name->>$2, p.name->>'en_US') AS pn, m.sequence AS s, COALESCE(m.name->>$2, m.name->>'en_US') AS n
       FROM payment_method m JOIN payment_provider p ON p.id = m.provider_id WHERE m.id = ANY($1::int[])`, [pms, lang])).rows : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
  // Python's sort of the key tuples (stable); a missing sequence (None) does not compare with an int: refused
  for (const r of rows) if (r.ps === null || r.s === null) throw new NotPorted("payment method display order with an empty sequence");
  const sortDisplay = (ids: readonly number[]): number[] => [...ids].sort((a, b) => {
    const x = byId.get(a)!, y = byId.get(b)!;
    return (x.ps! - y.ps!) || cmp(x.pn, y.pn) || (x.s! - y.s!) || cmp(x.n, y.n);
  });
  const sorted = sortDisplay(pms);
  const firstOfCode = new Map<string, number>();
  for (const id of sorted) if (!firstOfCode.has(byId.get(id)!.code)) firstOfCode.set(byId.get(id)!.code, id);
  const paymentMethods = [...firstOfCode.values()];
  addToReport(report, "payment_methods", pms.filter((id) => !paymentMethods.includes(id)), false, reason(env, "Payment method with duplicate code"));
  if (report.payment_methods) {
    const before = report.payment_methods;
    const reportIds = [...before.keys()];
    for (const id of reportIds) if (!byId.has(id)) throw new NotPorted("availability report of a payment method outside the available ones");
    report.payment_methods = new Map(sortDisplay(reportIds).map((id) => [id, before.get(id)!]));
  }
  // :883-895 the partner's tokens of the providers (payment.token `_order` partner_id, id desc)
  const tokens = providers.length ? (await su.cr.query<{ id: number }>(
    "SELECT id FROM payment_token WHERE active AND provider_id = ANY($1::int[]) AND partner_id = $2 ORDER BY partner_id, id DESC", [providers, partnerId])).rows.map((r) => r.id) : [];
  if (tokens.length) throw new NotPorted("payment form with saved tokens (payment.token_form)");
  // portal.py:274-291: `allow_tokenization and not _is_tokenization_required()` (payment's False)
  const showTokenizeInput = new Map<number, boolean>();
  for (const r of (await su.cr.query<{ id: number; t: boolean | null }>("SELECT id, allow_tokenization AS t FROM payment_provider WHERE id = ANY($1::int[])", [providers])).rows) {
    showTokenizeInput.set(r.id, Boolean(r.t));
  }
  void amount;
  return { providers, paymentMethods, tokens, showTokenizeInput: new Map(providers.map((p) => [p, showTokenizeInput.get(p)!])), report };
}

const escHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;").replace(/'/g, "&#39;");

/**
 * `record.message_post(body=message, author_id=author)` of a payment message (a Markup body, type notification,
 * subtype Note): the message as the chatter stores it, without notified partners (an internal note).
 */
async function postAs(env: Environment, model: string, id: number, body: string, authorId: number): Promise<void> {
  const { computeAuthor, insertMessages, replyToDefault, trackingMessageId, xmlid } = await import("../mail/message");
  const { flatThreadParent } = await import("../mail/thread_generic");
  const { sanitizeBody } = await import("../mail/sanitize");
  const [author, emailFrom] = await computeAuthor(env, authorId, null);
  const company = (await env.cr.query<{ c: number | null }>(`SELECT company_id AS c FROM "${env.reg.model(model).table}" WHERE id = $1`, [id])).rows[0]?.c ?? false;
  await insertMessages(env, [{
    model, res_id: id, body: sanitizeBody(body), author_id: author, email_from: emailFrom, message_type: "notification", subject: false,
    subtype_id: await xmlid(env, "mail.mt_note"), email_add_signature: true, record_company_id: company, parent_id: await flatThreadParent(env, model, id),
    message_id: trackingMessageId("message-notify"), reply_to: await replyToDefault(env, emailFrom),
  }]);
}

/**
 * payment_transaction.py `_get_sent_message` / `_get_received_message` (the transaction's html link and its formatted
 * amount), logged by account_payment's `_log_message_on_linked_documents` (payment_transaction.py:217-242: on the
 * invoices, by the partner, or the user's own partner for the superuser) and sale's (its orders: refused here).
 */
export async function logMessageOnLinkedDocuments(env: Environment, txId: number, kind: "sent" | "received" | { readonly body: string }): Promise<void> {
  const su = env.sudo();
  const [tx] = await su.model("payment.transaction").read([txId], ["operation", "amount", "currency_id", "reference", "state", "state_message", "partner_id", "source_transaction_id", "invoice_ids", "sale_order_ids"], "");
  if (!tx) throw new NotPorted(`payment.transaction ${txId} missing`);
  if ((tx["sale_order_ids"] as number[] | undefined)?.length) throw new NotPorted("payment messages on sales orders");
  if (idOf(tx["source_transaction_id"]) !== null) throw new NotPorted("payment messages of a child transaction (the source's invoices and payment)");
  let body: string | null;
  if (typeof kind === "object") body = kind.body;
  else {
    const link = `<a href="#" data-oe-model="payment.transaction" data-oe-id="${txId}">${escHtml(String(tx["reference"]))}</a>`;
    const currency = idOf(tx["currency_id"])!;
    const amount = Number(plainNumber(tx["amount"]));
    const op = String(tx["operation"]);
    const fmt = async (a: number): Promise<string> => escHtml(await formatAmount(env, a + 0, currency));
    if (kind === "sent") {
      // payment_transaction.py:1445-1470 `_get_sent_message` through its hook (payment_custom: the provider's name);
      // the hand's message is html (Markup), a str an override returns is escaped by message_post
      const sent = await priv.payment_transaction._get_sent_message.call(env, [txId], [], async () => {
        if (["online_redirect", "online_direct", "online_token", "offline"].includes(op)) return new Markup(escHtml(translate(env, "The transaction %(ref)s of %(formatted_amount)s has been initiated.", "payment")).replace("%(ref)s", link).replace("%(formatted_amount)s", await fmt(amount)));
        if (op === "refund") throw new NotPorted("the refund's sent message");
        return null;
      });
      body = sent === null || sent === false || sent === undefined ? null : sent instanceof Markup ? sent.toString() : typeof sent === "string" ? escHtml(sent) : (() => { throw new NotPorted("payment.transaction._get_sent_message() returned something else than a message"); })();
    } else {
      if (op === "validation") body = null;
      else {
        const texts: Record<string, string> = {
          pending: "The %(tx_label)s %(ref)s of %(formatted_amount)s is pending.",
          authorized: "The %(tx_label)s %(ref)s of %(formatted_amount)s has been authorized.",
          done: "The %(tx_label)s %(ref)s of %(formatted_amount)s has been confirmed.",
          cancel: "The %(tx_label)s %(ref)s of %(formatted_amount)s has been canceled.",
          error: "The %(tx_label)s %(ref)s of %(formatted_amount)s encountered an error.",
        };
        const t = texts[String(tx["state"])];
        if (t === undefined) body = null;
        else {
          body = escHtml(translate(env, t, "payment")).replace("%(tx_label)s", op === "refund" ? "refund" : "transaction").replace("%(ref)s", link).replace("%(formatted_amount)s", await fmt(amount));
          // :1453-1455 the state message of a canceled or failed transaction, after a <br/> (escaped: a str)
          if (["cancel", "error"].includes(String(tx["state"])) && tx["state_message"]) body += `<br>${escHtml(String(tx["state_message"]))}`;
        }
      }
    }
  }
  if (body === null) return;
  // :219-222 the author: the user's partner for the superuser or a backend action, else the transaction's partner
  const author = env.uid === 1 || env.context["payment_backend_action"]
    ? (await su.cr.query<{ p: number }>("SELECT partner_id AS p FROM res_users WHERE id = $1", [env.uid])).rows[0]!.p
    : idOf(tx["partner_id"])!;
  for (const inv of (tx["invoice_ids"] as number[] | undefined) ?? []) await postAs(su, "account.move", inv, `<p>${body}</p>`, author);
}

/** payment_transaction.py:599-654 `_get_processing_values` of a direct flow (payment's `_get_specific_processing_values`: none). */
export async function processingValues(env: Environment, txId: number): Promise<Record<string, unknown>> {
  const su = env.sudo();
  const [tx] = await su.model("payment.transaction").read([txId], ["provider_id", "provider_code", "reference", "amount", "currency_id", "partner_id", "tokenize", "operation", "state", "state_message"], "");
  if (!tx) throw new NotPorted(`payment.transaction ${txId} missing`);
  if (tx["operation"] === "validation") throw new NotPorted("the redirect form of a validation transaction");
  const values: Record<string, unknown> = {
    provider_id: idOf(tx["provider_id"]), provider_code: tx["provider_code"], reference: tx["reference"], amount: tx["amount"],
    currency_id: idOf(tx["currency_id"]), partner_id: idOf(tx["partner_id"]), should_tokenize: Boolean(tx["tokenize"]),
  };
  if (tx["operation"] === "online_redirect") {
    // :639-648 the redirect form: payment_provider.py `_get_redirect_form_view` (the provider's redirect_form_view_id),
    // rendered with `_get_specific_rendering_values` (through its hook: payment_custom's api_url and url_params)
    const provider = idOf(tx["provider_id"])!;
    const [prov] = await su.model("payment.provider").read([provider], ["redirect_form_view_id"], "");
    const view = idOf(prov?.["redirect_form_view_id"]);
    if (view !== null) {
      const rendering = await priv.payment_transaction._get_specific_rendering_values.call(env, [txId], [{ ...values }], async () => ({}));
      if (rendering === null || typeof rendering !== "object" || Array.isArray(rendering)) throw new NotPorted("payment.transaction._get_specific_rendering_values() returned something else than a dict");
      const { renderTemplate } = await import("../qweb/index");
      values["redirect_form_html"] = await renderTemplate(su.cr, view, rendering as Record<string, unknown>, { lang: env.lang ?? "en_US" });
    }
  }
  return { ...values, state: tx["state"], state_message: tx["state_message"] ?? false };
}

/** ir_cron.py:750-805 `_trigger()` of a cron by xml id: a trigger now, unless the cron is inactive. */
export async function triggerCron(env: Environment, xmlid: string): Promise<void> {
  const cron = await env.reg.xmlid(env.cr, xmlid);
  if (typeof cron !== "number") throw new NotPorted(`cron ${xmlid} missing`);
  const active = (await env.cr.query<{ a: boolean }>("SELECT active AS a FROM ir_cron WHERE id = $1", [cron])).rows[0]?.a;
  if (!active) return; // :794-796 a trigger at now of an inactive cron is skipped
  await create(env.sudo(), "ir.cron.trigger", [{ cron_id: cron, call_at: (await env.cr.query<{ n: string }>("SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS n")).rows[0]!.n }]);
}

/** payment_transaction.py:922-940 `_record(payment_data)`: the data stored for the processing cron, triggered. */
export async function recordPaymentData(env: Environment, txId: number, data: Record<string, unknown>): Promise<void> {
  await create(env.sudo(), "payment.data", [{ transaction_id: txId, payload: data }]);
  await triggerCron(env, "payment.processing_cron");
}

/** account_payment payment_transaction.py:105-117 `_should_create_payment`. */
export async function shouldCreatePayment(env: Environment, txId: number): Promise<boolean> {
  // through its hook (account_payment_custom: not for pay on invoice)
  const v = await priv.payment_transaction._should_create_payment.call(env, [txId], [], async (e) => shouldCreatePaymentHand(e, txId));
  if (typeof v !== "boolean") throw new NotPorted("payment.transaction._should_create_payment() returned something else than a bool");
  return v;
}

async function shouldCreatePaymentHand(env: Environment, txId: number): Promise<boolean> {
  const row = (await env.sudo().cr.query<{ p: number | null; op: string; children: boolean }>(
    `SELECT t.payment_id AS p, t.operation AS op,
            EXISTS (SELECT 1 FROM payment_transaction c WHERE c.source_transaction_id = t.id AND c.state IN ('done', 'cancel')) AS children
       FROM payment_transaction t WHERE t.id = $1`, [txId])).rows[0];
  if (!row) throw new NotPorted(`payment.transaction ${txId} missing`);
  return row.p === null && row.op !== "validation" && !row.children;
}

registerPyMethod("payment.transaction", "_should_create_payment", async (recs) => {
  recs.ensureOne();
  return shouldCreatePayment(recs.env, recs.ids[0]!);
});

// ---------------------------------------------------------------------------------------------------------------
// Processing and post-processing (payment_data.py `_cron_process`, payment_transaction.py `_process`, `_post_process`)
// ---------------------------------------------------------------------------------------------------------------

/** models.py `try_lock_for_update()`: the rows locked FOR NO KEY UPDATE SKIP LOCKED, the ones got. */
async function tryLock(env: Environment, table: string, ids: readonly number[]): Promise<number[]> {
  if (!ids.length) return [];
  return (await env.cr.query<{ id: number }>(`SELECT id FROM "${table}" WHERE id = ANY($1::int[]) ORDER BY id FOR NO KEY UPDATE SKIP LOCKED`, [[...ids]])).rows.map((r) => r.id);
}

/**
 * payment_transaction.py:961-982 `_process(payment_data)`: `_apply_updates` through callPrivate (payment's does
 * nothing; a provider's override updates the state, the compiled `_set_*` chain), then for a successful one
 * `_validate_amount` (:984-1035) with `_extract_amount_data` through callPrivate (None skips it); tokenization refuses.
 */
async function processTransaction(env: Environment, txId: number, data: unknown): Promise<void> {
  await priv.payment_transaction._apply_updates.call(env, [txId], [data], async () => null);
  const state = async (): Promise<{ state: string; operation: string; tokenize: boolean }> =>
    (await env.cr.query<{ state: string; operation: string; tokenize: boolean }>("SELECT state, operation, COALESCE(tokenize, false) AS tokenize FROM payment_transaction WHERE id = $1", [txId])).rows[0]!;
  let s = await state();
  if (s.state === "authorized" || s.state === "done") {
    if (s.operation !== "validation") {
      const amountData = await priv.payment_transaction._extract_amount_data.call(env, [txId], [data], async () => ({}));
      if (amountData !== null && amountData !== undefined) throw new NotPorted("payment.transaction._validate_amount of provider data (the amount check)");
    }
    s = await state();
    if (s.state === "error") return;
    if (s.tokenize) throw new NotPorted("payment.transaction._tokenize");
  }
}

/** bus.listener.mixin `_bus_send` of payment_transaction.py:1356-1369 `_notify_status`, inserted with the job's commit. */
async function notifyStatus(env: Environment, txId: number, worker: unknown): Promise<void> {
  const [tx] = await env.sudo().model("payment.transaction").read([txId], ["reference", "provider_code", "state", "landing_route"], "");
  const { BusValues, dispatchRows } = await import("../bus/bus");
  const bus = new BusValues(env.cr.db);
  bus.sendone({ model: "payment.transaction", id: txId }, "payment.transaction_status", {
    reference: tx?.["reference"], provider_code: tx?.["provider_code"], state: tx?.["state"], landing_route: tx?.["landing_route"],
  });
  const rows = await bus.create(env.cr, env.uid);
  env.cr.postcommit.push(async () => dispatchRows(worker as never, env.cr.db, rows));
}

/** account_payment payment_provider.py:37-91 `_ensure_payment_method_line` of a provider without a line of a journal. */
async function ensurePaymentMethodLine(env: Environment, providerId: number, journal: number | null): Promise<void> {
  const su = env.sudo();
  const [prov] = await su.model(P).read([providerId], ["code", "name", "company_id"], "");
  const code = await providerCode(su, providerId);
  const method = (await su.model("account.payment.method").search(cond("code", "=", code), { limit: 1 }))[0];
  if (method === undefined) return;
  const own = await su.model("account.payment.method.line").search(and([cond("payment_provider_id", "=", providerId), cond("journal_id", "!=", false)]), { limit: 1 });
  if (journal === null) {
    if (own.length) throw new NotPorted("payment.provider without a journal: its method line unlinked");
    return;
  }
  if (own.length) throw new NotPorted("_ensure_payment_method_line of a provider with a line");
  const company = idOf(prov?.["company_id"]);
  const companyDomain = cond("company_id", "in", [company ?? false, false]);
  const free = await su.model("account.payment.method.line").search(and([companyDomain, cond("code", "=", code), cond("payment_provider_id", "=", false), cond("journal_id", "!=", false)]), { limit: 1 });
  if (free.length) throw new NotPorted("_ensure_payment_method_line taking a line of the same code");
  if (code === "sepa_direct_debit") throw new NotPorted("the Online SEPA method line");
  // :93-101 `_get_payment_method_outstanding_account_id`: the chart's inbound outstanding account of the root company,
  // else the company's transfer account
  let outstanding: number | false = false;
  // :93-101 `_get_payment_method_outstanding_account_id`: by the provider's own code field
  if (prov?.["code"] !== "custom") {
    const root = Number((await su.cr.query<{ p: string }>("SELECT parent_path AS p FROM res_company WHERE id = $1", [company])).rows[0]!.p.split("/")[0]);
    const ref = (await su.cr.query<{ id: number }>("SELECT res_id AS id FROM ir_model_data WHERE module = 'account' AND name = $1", [`${root}_account_journal_payment_debit_account_id`])).rows[0]?.id;
    outstanding = ref ?? idOf((await su.model("res.company").read([company!], ["transfer_account_id"], ""))[0]?.["transfer_account_id"]) ?? false;
  }
  const sameCode = await su.model("account.payment.method.line").search(and([companyDomain, cond("code", "=", code)]), { limit: 1 });
  if (sameCode.length) outstanding = idOf((await su.model("account.payment.method.line").read(sameCode, ["payment_account_id"], ""))[0]?.["payment_account_id"]) ?? false;
  await create(su, "account.payment.method.line", [{ name: prov?.["name"], payment_method_id: method, journal_id: journal, payment_provider_id: providerId, payment_account_id: outstanding }]);
}

/** account_payment payment_provider.py:102-119 `_compute_journal_id` of a stored provider, its method line ensured. */
export async function providerJournal(env: Environment, providerId: number): Promise<number | null> {
  const su = env.sudo();
  const line = await su.model("account.payment.method.line").search(and([cond("payment_provider_id", "=", providerId), cond("journal_id", "!=", false)]), { limit: 1 });
  if (line.length) return idOf((await su.model("account.payment.method.line").read(line, ["journal_id"], ""))[0]?.["journal_id"]);
  const [prov] = await su.model(P).read([providerId], ["company_id"], "");
  const journal = (await su.model("account.journal").search(and([cond("company_id", "=", idOf(prov?.["company_id"]) ?? false), cond("type", "=", "bank")]), { limit: 1 }))[0] ?? null;
  await ensurePaymentMethodLine(env, providerId, journal);
  return journal;
}

/** account_payment payment_transaction.py:119-196 `_create_payment` of a transaction of invoices (no early payment discount). */
async function createPayment(env: Environment, txId: number): Promise<number> {
  const su = env.sudo();
  const [tx] = await su.model("payment.transaction").read([txId], ["provider_id", "amount", "currency_id", "partner_id", "token_id", "reference", "invoice_ids", "operation", "source_transaction_id"], "");
  const provider = idOf(tx!["provider_id"])!;
  const journal = await providerJournal(env, provider);
  const methodLine = (await su.cr.query<{ id: number }>(
    "SELECT id FROM account_payment_method_line WHERE journal_id = $1 AND payment_provider_id = $2 AND payment_method_id IN (SELECT id FROM account_payment_method WHERE payment_type = 'inbound') ORDER BY sequence, id LIMIT 1", [journal, provider])).rows[0]?.id ?? false;
  const [prov] = await su.model(P).read([provider], ["company_id"], "");
  const amount = Number(plainNumber(tx!["amount"]));
  const commercial = (await su.cr.query<{ c: number }>("SELECT commercial_partner_id AS c FROM res_partner WHERE id = $1", [idOf(tx!["partner_id"])])).rows[0]!.c;
  const invoices = (tx!["invoice_ids"] as number[]) ?? [];
  for (const inv of invoices) {
    const [m] = await su.model("account.move").read([inv], ["state"], "");
    if (m?.["state"] !== "posted") continue;
    const discount = (await su.cr.query("SELECT 1 FROM account_move_line WHERE move_id = $1 AND display_type = 'payment_term' AND discount_date IS NOT NULL LIMIT 1", [inv])).rows.length;
    if (discount) throw new NotPorted("payment of an invoice with an early payment discount (write-off lines)");
  }
  const termAccount = invoices.length ? (await su.cr.query<{ a: number }>(
    "SELECT account_id AS a FROM account_move_line WHERE move_id = ANY($1::int[]) AND display_type = 'payment_term' ORDER BY move_id, sequence, id LIMIT 1", [invoices])).rows[0]?.a : undefined;
  if (termAccount === undefined) throw new NotPorted("payment of a transaction without invoices (no destination account from them)");
  if (journal === null || methodLine === false) throw new NotPorted("payment of a transaction without a journal or method line");
  if (idOf(tx!["source_transaction_id"]) !== null) throw new NotPorted("payment of a child transaction (the source's invoices)");
  if (idOf(tx!["token_id"]) !== null) throw new NotPorted("payment of a token transaction");
  const company = idOf(prov?.["company_id"])!;
  const open = (await su.cr.query<{ id: number; state: string }>("SELECT id, state FROM account_move WHERE id = ANY($1::int[]) AND state != 'cancel' ORDER BY id", [invoices])).rows;
  if (open.some((m) => m.state === "draft")) throw new NotPorted("payment of draft invoices (action_post)");
  const { DbRec } = await import("../orm/recompute");
  const { linesById } = await import("./account_entries");
  const { createPaymentsFromPlans } = await import("./account_payment_register");
  const { contextToday } = await import("./account_computes");
  // the invoices' unreconciled lines on the destination account (reconciled with the payment's, :184-189)
  const lineIds = (await su.cr.query<{ id: number }>(
    "SELECT id FROM account_move_line WHERE move_id = ANY($1::int[]) AND account_id = $2 AND NOT COALESCE(reconciled, false) ORDER BY id", [open.map((m) => m.id), termAccount])).rows.map((r) => r.id);
  const accountType = (await su.cr.query<{ t: string }>("SELECT account_type AS t FROM account_account WHERE id = $1", [termAccount])).rows[0]!.t;
  // account_payment.py:605-623 the payment's bank account: the journal's for an inbound payment
  const type = amount > 0 ? "inbound" : "outbound";
  if (type !== "inbound") throw new NotPorted("an outbound payment of a transaction (refund)");
  const partnerBank = (await su.cr.query<{ b: number | null }>("SELECT bank_account_id AS b FROM account_journal WHERE id = $1", [journal])).rows[0]?.b ?? null;
  const [payment] = await createPaymentsFromPlans(su, [{
    extra: { payment_transaction_id: txId, transaction_uuid: (await su.cr.query<{ r: string | null }>("SELECT provider_reference AS r FROM payment_transaction WHERE id = $1", [txId])).rows[0]?.r ?? null },
    date: await contextToday(su), amount: Math.abs(amount), type, partnerType: "customer", memo: String(tx!["reference"]), journal, company,
    currency: idOf(tx!["currency_id"])!, partner: commercial, commercial, partnerBank, methodLine: new DbRec(su, su.reg.model("account.payment.method.line"), methodLine),
    account: termAccount, accountType, writeOff: [], lines: await linesById(su, lineIds), moves: open.map((m) => m.id),
  }]);
  // :178 `self.payment_id = payment`
  await write(su, "payment.transaction", [txId], { payment_id: payment });
  return payment!;
}

/**
 * The post-processing of payment, account_payment and sale (payment_transaction.py:1345-1353, account_payment
 * :79-103, sale :50-117, sale above account_payment above payment): the transactions flagged, a confirmed one's
 * payment created and posted with its message, a draft, canceled or failed one's payment canceled. Sales orders, an
 * authorized transaction and the automatic invoicing refuse.
 */
async function postProcess(env: Environment, txIds: readonly number[]): Promise<void> {
  const su = env.sudo();
  const rows = (await su.cr.query<{ id: number; state: string; operation: string; company_id: number; payment_id: number | null; orders: boolean }>(
    `SELECT t.id, t.state, t.operation, t.company_id, t.payment_id,
            EXISTS (SELECT 1 FROM sale_order_transaction_rel r WHERE r.transaction_id = t.id) AS orders
       FROM payment_transaction t WHERE t.id = ANY($1::int[]) ORDER BY t.id`, [[...txIds]])).rows;
  if (rows.some((r) => r.orders)) throw new NotPorted("post-processing of transactions of sales orders");
  if (rows.some((r) => r.state === "authorized")) throw new NotPorted("post-processing of an authorized transaction");
  const flag = async (ids: number[]): Promise<void> => { if (ids.length) await write(su, "payment.transaction", ids, { is_post_processed: true }); };
  // sale: the pending ones' super() (account_payment's flags them; its done/cancel branches do not apply)
  await flag(rows.filter((r) => r.state === "pending").map((r) => r.id));
  // sale's super() of the others but pending/authorized/done: account_payment's flag, then their payment canceled
  const others = rows.filter((r) => !["pending", "authorized", "done"].includes(r.state));
  await flag(others.map((r) => r.id));
  for (const r of others) {
    if (["draft", "cancel", "error"].includes(r.state) && r.payment_id !== null) throw new NotPorted("the payment of a failed transaction canceled");
  }
  // sale's done loop: one super() per transaction (account_payment's), after the automatic invoicing
  for (const r of rows.filter((x) => x.state === "done")) {
    const auto = (await su.cr.query<{ a: boolean | null }>("SELECT sale_automatic_invoice AS a FROM res_company WHERE id = $1", [r.company_id])).rows[0]?.a;
    if (auto) throw new NotPorted("the automatic invoicing of a paid transaction (sale_automatic_invoice)");
    await flag([r.id]);
    const invoices = (await su.cr.query<{ id: number }>("SELECT invoice_id AS id FROM account_invoice_transaction_rel WHERE transaction_id = $1", [r.id])).rows.map((x) => x.id);
    if ((await su.cr.query("SELECT 1 FROM account_move WHERE id = ANY($1::int[]) AND state = 'draft' LIMIT 1", [invoices])).rows.length) throw new NotPorted("post-processing posting draft invoices");
    if (await shouldCreatePayment(env, r.id)) await createPayment(env.withContext({ ...env.context, allowed_company_ids: [r.company_id] }), r.id);
    const payment = (await su.cr.query<{ p: number | null }>("SELECT payment_id AS p FROM payment_transaction WHERE id = $1", [r.id])).rows[0]?.p ?? null;
    if (payment !== null) {
      const [tx] = await su.model("payment.transaction").read([r.id], ["reference"], "");
      const [pay] = await su.model("account.payment").read([payment], ["display_name"], "");
      const txLink = `<a href="#" data-oe-model="payment.transaction" data-oe-id="${r.id}">${escHtml(String(tx?.["reference"]))}</a>`;
      const payLink = `<a href="#" data-oe-model="account.payment" data-oe-id="${payment}">${escHtml(String(pay?.["display_name"]))}</a>`;
      const body = escHtml(translate(env, "The payment related to transaction %(ref)s has been posted: %(link)s", "account_payment")).replace("%(ref)s", txLink).replace("%(link)s", payLink);
      await logMessageOnLinkedDocuments(env, r.id, { body });
    }
  }
}

/** payment_transaction.py:1327-1343 `_post_process_with_lock`. */
export async function postProcessWithLock(env: Environment, txIds: readonly number[]): Promise<number[]> {
  if (!txIds.length) return [];
  const locked = await tryLock(env, "payment_transaction", txIds);
  if (!locked.length) return [];
  const todo = (await env.cr.query<{ id: number }>(
    "SELECT id FROM payment_transaction WHERE id = ANY($1::int[]) AND NOT COALESCE(is_post_processed, false) ORDER BY id",
    [locked])).rows.map((r) => r.id);
  if (todo.length) {
    await postProcess(env.withContext({ ...env.context, payment_safe_write: true }), todo);
  }
  return todo;
}

// payment data.xml `processing_cron`: payment_data.py:40-121 `_cron_process`, each payment data processed then its
// transaction post-processed, the progress committed between them; a failure (Odoo's errored record or deferral to
// the post-processing cron) refuses
registerCronJob("payment.data|model._cron_process()", async (env, worker) => {
  for (;;) {
    const pending = await env.model("payment.data").search(cond("errored", "=", false), { limit: 1000 });
    if (!pending.length) return;
    await commitProgress(env, 0, pending.length);
    for (const pd of pending) {
      const row = (await env.cr.query<{ tx: number; payload: unknown }>("SELECT transaction_id AS tx, payload FROM payment_data WHERE id = $1", [pd])).rows[0]!;
      const source = (await env.cr.query<{ s: number | null }>("SELECT source_transaction_id AS s FROM payment_transaction WHERE id = $1", [row.tx])).rows[0]?.s ?? null;
      const toLock = source === null ? [row.tx] : [row.tx, source];
      const locked = await tryLock(env, "payment_transaction", toLock);
      const lockedData = await tryLock(env, "payment_data", [pd]);
      if (locked.length !== toLock.length || !lockedData.length) throw new NotPorted("payment data of a transaction locked elsewhere (_rollback_progress)");
      await processTransaction(env.withContext({ ...env.context, payment_safe_write: true }), row.tx, row.payload);
      await unlink(env, "payment.data", [pd]);
      await commitProgress(env, 0);
      // :94-121 `_post_process_transaction`: `_post_process_with_lock` of the transaction and its source
      const txs = await tryLock(env, "payment_transaction", toLock);
      const todo = txs.length ? (await env.cr.query<{ id: number }>("SELECT id FROM payment_transaction WHERE id = ANY($1::int[]) AND NOT COALESCE(is_post_processed, false) ORDER BY id", [txs])).rows.map((r) => r.id) : [];
      // the precommit hooks (the invoices' payment_state tracking) run at the commit below, after the post-processing
      if (todo.length) await withPrecommit(env.cr, () => postProcess(env.withContext({ ...env.context, payment_safe_write: true }), todo));
      await notifyStatus(env, row.tx, worker);
      await commitProgress(env, 1);
    }
  }
});
