/**
 * res.partner on the write path for the modules of the poc_erp template that extend it (C2 `name_create`): field
 * defaults (account, calendar, purchase_stock), the stored routing computes of account_edi_ubl_cii and the create
 * hooks of account (customer/supplier rank from `res_partner_search_mode`), account_edi_ubl_cii
 * (`_clean_routing_endpoint`) and account_peppol (`_update_peppol_state_per_company`). On poc_corpus these fields
 * do not exist: defaults are only consulted for the model's own fields (src/web/defaults.ts) and the create hooks
 * check the field before acting, so S1/S2/S4 are unchanged.
 */
import { IDENTIFIER_VALIDATORS } from "./identifier_validators";
import { NotPorted } from "../errors";
import { overlayOf, registerDefaults, registerRecordCompute, type Rec } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { registerOverrides } from "../orm/write";
import { datetimeToString, dbNow } from "./util";
import { ADDITIONAL_IDENTIFIERS_METADATA, TIN_METADATA } from "./partner_identifiers";
import type { IdentifierMetadata } from "./identifiers_types";
import { runVatChecks, refuseIdentifierOverride } from "./res_partner_write";
import { suggestedEdiFormat } from "./partner_erp";
import * as priv from "../orm/dispatch_gen";

const MODEL = "res.partner";

registerDefaults(MODEL, {
  // account/models/partner.py:652-653
  supplier_rank: async () => 0,
  customer_rank: async () => 0,
  // account/models/partner.py:655-660 autopost_bills default='ask'
  autopost_bills: async () => "ask",
  // calendar/models/res_partner.py:20-21 default=fields.Datetime.now
  calendar_last_notif_ack: async (env) => datetimeToString(await dbNow(env)),
  // purchase_stock/models/res_partner.py:18-38
  suggest_based_on: async () => "30_days",
  suggest_days: async () => 7,
  suggest_percent: async () => 100,
  group_rfq: async () => "default",
  group_on: async () => "default",
});

/** account_edi_ubl_cii/tools/partner_identifiers.py:9-30 CORNER_CASE_IDENTIFIERS_METADATA (scheme and sequence). */
const CORNER_CASE: Readonly<Record<string, IdentifierMetadata>> = {
  EMAIL: { scheme: "EM", countries: false },
  GS1: { sequence: 200, scheme: "0209", countries: false },
  IBAN: { sequence: 200, scheme: "9918", countries: false },
};
/** account_edi_ubl_cii/tools/partner_identifiers.py:61-63 */
const DEPRECATED_SCHEMES = new Set(["0037", "0213", "9955", "0193"]);

/**
 * `_get_all_identifiers_metadata` (base res_partner.py:1701-1709 + account_edi_ubl_cii res_partner.py:196-199):
 * TIN_METADATA, `_get_all_additional_identifiers_metadata()` (:1728-1735, base's ADDITIONAL_IDENTIFIERS_METADATA; a
 * localization's override through callPrivate, l10n_co's CO_ADDITIONAL_IDENTIFIERS_METADATA), the corner cases.
 */
export async function allIdentifiersMetadata(env: Environment): Promise<Record<string, IdentifierMetadata>> {
  const additional = await priv.res_partner._get_all_additional_identifiers_metadata.call(env, [], [],
    async () => ({ ...ADDITIONAL_IDENTIFIERS_METADATA }));
  if (additional === null || typeof additional !== "object" || Array.isArray(additional)) {
    throw new NotPorted(`res.partner._get_all_additional_identifiers_metadata returning ${JSON.stringify(additional)}`);
  }
  return { ...TIN_METADATA, ...(additional as Record<string, IdentifierMetadata>), ...CORNER_CASE };
}

/** odoo/tools/partner_identifiers.py:978-999 get_deduced_identifiers. */
export function deducedIdentifiers(key: string, value: string): Record<string, string> {
  const strip = (cc: string) => value.startsWith(cc) ? value.slice(cc.length) : value; // get_non_prefixed_identifier
  switch (key) {
    case "AT_VAT": return { AT_EN: strip("AT") };
    case "BE_VAT": return { BE_EN: strip("BE") };
    case "DK_VAT": return { DK_CVR: strip("DK") };
    case "RO_VAT": return { RO_EN: strip("RO") };
    case "SG_GST": return { SG_UEN: value };
    case "HU_TIN": return { HU_VAT: (value.startsWith("HU") ? value : `HU${value}`).slice(0, 10) };
    // stdnum fr.siret.to_siren: compact (drop ' ' and '.', strip) then the first 9 characters
    case "FR_SIRET": return { FR_SIREN: value.replace(/[ .]/g, "").trim().slice(0, 9) };
    case "AU_ACN": throw new NotPorted("deduced AU_ABN (stdnum au.acn.to_abn)");
    default: return {};
  }
}

const isVoid = (v: unknown): boolean => !v || ["/", "na", "NA", "N/A", "not applicable"].includes(String(v)); // :1018-1022

/** base res_partner.py:1684-1698 `_get_all_identifiers(enrich=True)` of a commercial partner. */
export async function allIdentifiers(commercial: Rec): Promise<Record<string, unknown>> {
  const extra = await commercial.get("additional_identifiers");
  let identifiers: Record<string, unknown> = typeof extra === "object" && extra !== null && !Array.isArray(extra) ? { ...(extra as Record<string, unknown>) } : {};
  const vat = await commercial.get("vat");
  if (!isVoid(vat)) {
    const countryCode = await commercial.get("country_code");
    const tin = Object.entries(TIN_METADATA).find(([, m]) => Array.isArray(m["countries"]) && (m["countries"] as readonly unknown[]).includes(countryCode));
    identifiers = { [tin ? tin[0] : "TIN"]: vat, ...identifiers };
  }
  const enriched: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(identifiers)) Object.assign(enriched, deducedIdentifiers(k, String(v)));
  const all: Record<string, unknown> = { ...enriched, ...identifiers };
  return all;
}

/**
 * account_edi_ubl_cii res_partner.py:149-154 `_compute_routing_scheme_endpoint` through
 * `_get_preferred_routing_identifier_vals(force_recompute=True)` (:234-254): the commercial partner's identifiers
 * (`_get_all_identifiers(enrich=True)`, base res_partner.py:1684-1698 and the routing one :226-232), the lowest
 * (sequence, key) whose metadata carries a non-deprecated routing scheme (`_pick_preferred_identifier` :1608-1631).
 */
async function preferredRouting(rec: Rec): Promise<{ scheme: string; value: string } | null> {
  // a hook (l10n_ro_edi's RO_EN with scheme 9947, l10n_fr_pdp): the hand port's below, with force_recompute=True
  const id = typeof rec.id === "number" ? rec.id : null;
  const v = await priv.res_partner._get_preferred_routing_identifier_vals.call(rec.env, id === null ? [] : [id], [true], async (_env, _ids, args) => {
    if (args[0] !== true) throw new NotPorted("_get_preferred_routing_identifier_vals without force_recompute");
    return (await handPreferredRouting(rec)) ?? {};
  }, undefined, id === null ? [rec] : undefined);
  if (v === null || typeof v !== "object" || Array.isArray(v) || v instanceof Map) throw new NotPorted("_get_preferred_routing_identifier_vals giving other than a dict");
  const o = v as Record<string, unknown>;
  // :152-153 `identifier_vals.get('scheme') or False`
  if (!o["scheme"] && !o["value"]) return null;
  if ((o["scheme"] && typeof o["scheme"] !== "string") || (o["value"] && typeof o["value"] !== "string") || !o["scheme"] || !o["value"]) {
    throw new NotPorted("_get_preferred_routing_identifier_vals giving a scheme without a value");
  }
  return { scheme: o["scheme"] as string, value: o["value"] as string };
}

/**
 * res_partner.py:234-254 `_get_preferred_routing_identifier_vals(force_recompute=False)` of a stored partner `rec`
 * (the peppol.registration wizard's `_compute_peppol_eas_endpoint`), through the localization hooks: the commercial
 * partner's stored routing identifier when its scheme is a known one, else the preferred identifier as above.
 * Null: the empty dict.
 */
export async function preferredRoutingIdentifier(rec: Rec): Promise<{ scheme: string; value: string } | null> {
  const id = typeof rec.id === "number" ? rec.id : null;
  if (id === null) throw new NotPorted("_get_preferred_routing_identifier_vals of a new partner outside its write");
  const v = await priv.res_partner._get_preferred_routing_identifier_vals.call(rec.env, [id], [], async () => {
    const commercial = (await rec.rel("commercial_partner_id")) ?? rec;
    const scheme = await commercial.get("routing_scheme");
    const endpoint = await commercial.get("routing_endpoint");
    // :242-243 `_get_all_identifiers_metadata_by_scheme()` (base res_partner.py:1720-1725) keys the metadata by scheme
    if (scheme && endpoint && Object.values(await allIdentifiersMetadata(rec.env)).some((m) => m["scheme"] === scheme)) {
      return { scheme, value: endpoint };
    }
    return (await handPreferredRouting(rec, false)) ?? {};
  });
  if (v === null || typeof v !== "object" || Array.isArray(v) || v instanceof Map) throw new NotPorted("_get_preferred_routing_identifier_vals giving other than a dict");
  const o = v as Record<string, unknown>;
  if (!o["scheme"] && !o["value"]) return null;
  if (typeof o["scheme"] !== "string" || typeof o["value"] !== "string" || !o["scheme"] || !o["value"]) {
    throw new NotPorted("_get_preferred_routing_identifier_vals giving a scheme without a value");
  }
  return { scheme: o["scheme"], value: o["value"] };
}

/** `writing`: `rec` is being written, its own routing fields read as before the write (the stored compute's case). */
async function handPreferredRouting(rec: Rec, writing = true): Promise<{ scheme: string; value: string } | null> {
  const commercial = (await rec.rel("commercial_partner_id")) ?? rec;
  const self = writing && commercial.id === rec.id;
  const all = await allIdentifiers(commercial);
  const metadata = await allIdentifiersMetadata(rec.env);
  // :226-232 the partner's own routing identifier, when set and known by scheme
  const scheme0 = self ? await rec.prev("routing_scheme") : await commercial.get("routing_scheme");
  const endpoint0 = self ? await rec.prev("routing_endpoint") : await commercial.get("routing_endpoint");
  if (scheme0 && endpoint0) {
    const byScheme = Object.entries(metadata).find(([, m]) => m["scheme"] === scheme0);
    if (byScheme && !(byScheme[0] in all)) all[byScheme[0]] = endpoint0;
  }
  const registrable = new Set((rec.env.reg.model(MODEL).fields.get("routing_scheme")?.selection ?? []).map((o) => o.value).filter((c) => !DEPRECATED_SCHEMES.has(c)));
  const candidates = Object.entries(all)
    .map(([k, v]) => ({ k, v, m: metadata[k] ?? {} }))
    .filter((c) => typeof c.m["scheme"] === "string" && registrable.has(c.m["scheme"] as string) && c.v);
  if (!candidates.length) return null;
  const seq = (m: IdentifierMetadata): number => typeof m["sequence"] === "number" ? m["sequence"] as number : 100;
  candidates.sort((a, b) => seq(a.m) - seq(b.m) || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  return { scheme: candidates[0]!.m["scheme"] as string, value: String(candidates[0]!.v) };
}

const routing = (field: "routing_scheme" | "routing_endpoint") => async (_env: Environment, rec: Rec): Promise<unknown> => {
  const vals = await preferredRouting(rec);
  if (!vals) return null;
  return field === "routing_scheme" ? vals.scheme : vals.value;
};
registerRecordCompute(MODEL, { routing_scheme: routing("routing_scheme"), routing_endpoint: routing("routing_endpoint") });

/** Before `super().create` (account partner.py:864-875, account_edi_ubl_cii res_partner.py:186-190). */
export async function erpBeforeCreate(env: Environment, valsList: Record<string, unknown>[]): Promise<void> {
  const fields = env.reg.model(MODEL).fields;
  if (fields.has("customer_rank")) {
    const mode = env.context["res_partner_search_mode"];
    if (mode) {
      for (const vals of valsList) {
        if (mode === "customer" && !("customer_rank" in vals)) vals["customer_rank"] = 1;
        else if (mode === "supplier" && !("supplier_rank" in vals)) vals["supplier_rank"] = 1;
      }
    }
  }
  for (const vals of valsList) {
    if (vals["global_location_number"]) throw new NotPorted("res.partner create with a global_location_number (_set_additional_identifier validation)");
    if (vals["invoice_edi_format"]) throw new NotPorted("res.partner create with an invoice_edi_format (inverse)");
    if ("credit_limit" in vals && "use_partner_credit_limit" in vals && !vals["use_partner_credit_limit"]
      && Number(vals["credit_limit"] || 0) !== await creditLimitFallback(env)) {
      throw new NotPorted("res.partner create resetting credit_limit (use_partner_credit_limit inverse)");
    }
  }
  if (fields.has("routing_scheme")) {
    for (const vals of valsList) {
      const scheme = vals["routing_scheme"], endpoint = vals["routing_endpoint"];
      if (scheme && endpoint) vals["routing_endpoint"] = await validateByScheme(env, String(scheme), String(endpoint)) ?? false;
    }
  }
}

/** `credit_limit` company-dependent fallback (ir.default of the company, else of all companies, else 0). */
async function creditLimitFallback(env: Environment): Promise<number> {
  const fallback = (await env.cr.query<{ json_value: string | null }>(
    `SELECT d.json_value FROM ir_default d JOIN ir_model_fields f ON f.id = d.field_id WHERE f.model = 'res.partner'
      AND f.name = 'credit_limit' AND d.user_id IS NULL AND (d.company_id IS NULL OR d.company_id = $1) AND d.condition IS NULL
      ORDER BY d.company_id NULLS LAST LIMIT 1`, [await env.company()])).rows[0]?.json_value;
  return fallback ? Number(JSON.parse(fallback)) : 0;
}

/** account_edi_ubl_cii/tools/partner_identifiers.py:68-79 ELECTRONIC_ADDRESS_SCHEMES_CODELIST */
const ELECTRONIC_ADDRESS_SCHEMES = new Set(("0002 0007 0009 0037 0060 0088 0096 0097 0106 0130 0135 0142 0147 0151 0154 0158 0170 0177 " +
  "0183 0184 0188 0190 0191 0192 0193 0194 0195 0196 0198 0199 0200 0201 0202 0203 0204 0205 0208 0209 0210 0211 0212 0213 0215 0216 " +
  "0217 0218 0221 0225 0230 0235 0240 0244 0245 9910 9913 9914 9915 9918 9919 9920 9922 9923 9924 9925 9926 9927 9928 9929 9930 9931 " +
  "9932 9933 9934 9935 9936 9937 9938 9939 9940 9941 9942 9943 9944 9945 9946 9947 9948 9949 9950 9951 9952 9953 9957 9959").split(" "));

/**
 * `_clean_routing_endpoint` (account_edi_ubl_cii res_partner.py:200-208) through `_validate_identifier_by_scheme`
 * (base res_partner.py:1588-1596, :1545-1586 `_validate_identifier`, validation='error'; ubl :210-224): the endpoint
 * of a TIN scheme goes through `_run_vat_checks`; identifiers with a validation function are not ported.
 */
async function validateByScheme(env: Environment, scheme: string, endpoint: string): Promise<string | null> {
  const meta = Object.entries(await allIdentifiersMetadata(env)).find(([, m]) => m["scheme"] === scheme);
  if (!meta) return endpoint; // e.g. the `odemo` scheme
  const [key, metadata] = meta;
  let value: string | null = isVoid(endpoint) ? null : endpoint.trim();
  if (!value || env.context["no_vat_validation"]) return value;
  await refuseIdentifierOverride(env);
  const tinCountries = TIN_METADATA[key]?.["countries"];
  if (Array.isArray(tinCountries) && tinCountries.length) {
    value = await runVatChecks(env, String(tinCountries[0]), value, "error");
  } else if (metadata["validation_function"] && IDENTIFIER_VALIDATORS[key]) {
    // :1572-1586 the identifier's validator (src/models/identifier_validators.ts); invalid raises ValidationError
    value = IDENTIFIER_VALIDATORS[key]!(value);
    if (value === null) throw new NotPorted(`an invalid ${key} routing endpoint (validation_error_message)`);
  } else if (metadata["validation_function"] || metadata["category"] === "VAT") {
    throw new NotPorted(`routing endpoint validation of ${key}`);
  }
  if (value && ELECTRONIC_ADDRESS_SCHEMES.has(scheme)) {
    value = value.replace(/[^a-zA-Z\d\-._~]/g, "");
    if (!(value.length >= 1 && value.length <= 50)) throw new NotPorted("invalid routing endpoint (validation_error_message)");
  }
  return value;
}

/** account/models/company.py:37-53 PEPPOL_LIST */
const PEPPOL_LIST = ["AT", "BE", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "IE", "IS", "LT", "LU", "LV", "MT", "NL", "NO", "SE",
  "SI", "AD", "AL", "AX", "BA", "BG", "BL", "GB", "GF", "GP", "GR", "HR", "HU", "IT", "LI", "MC", "ME", "MF", "MK", "MQ", "NC", "PF", "PL",
  "PM", "PT", "RE", "RO", "RS", "SK", "SM", "TF", "TR", "VA", "WF", "YT"];

/** After `super().create` (account_peppol res_partner.py:218-223 `_update_peppol_state_per_company`). */
export async function erpAfterCreate(env: Environment, ids: readonly number[]): Promise<void> {
  if (!env.reg.model(MODEL).fields.has("peppol_verification_state") || !ids.length) return;
  // :194 only partners with a routing scheme and endpoint are checked (a network call to the Peppol SML)
  // and `p.country_code in PEPPOL_LIST` (account/models/company.py:37-53); `is_ubl_format` is not evaluated here
  const rows = (await env.cr.query<{ id: number; company_id: number | null }>(
    `SELECT p.id, p.company_id FROM res_partner p JOIN res_country c ON c.id = p.country_id WHERE p.id = ANY($1::int[])
       AND p.routing_scheme IS NOT NULL AND p.routing_endpoint IS NOT NULL AND c.code = ANY($2::text[])`, [ids, PEPPOL_LIST])).rows;
  if (!rows.length) return;
  // :198-210: a partner of a company is checked for it (the SML lookup, refused here, also when `is_ubl_format` would
  // skip it); the others for each company using Peppol (`account_peppol_proxy_state` in `_get_can_send_domain`,
  // account_edi_proxy_user.py:167-168), none in a database without Peppol companies
  if (rows.some((r) => r.company_id !== null)) throw new NotPorted("account_peppol partner endpoint check on create (a partner of a company)");
  const peppol = (await env.cr.query("SELECT 1 FROM res_company WHERE account_peppol_proxy_state IN ('sender', 'smp_registration', 'receiver') LIMIT 1")).rows.length;
  if (peppol) throw new NotPorted("account_peppol partner endpoint check on create (companies on Peppol)");
}

// account partner.py:681-683 `_inverse_global_location_number` -> base `_set_additional_identifier('EAN_GLN', value)`
// (res_partner.py:1666-1682): an empty value drops the key, which changes nothing when it is not there
registerOverrides(MODEL, {
  inverse: {
    global_location_number: async (env, ids) => {
      // the assigned value: written values stay in the overlay; create refuses a non-empty one (erpBeforeCreate)
      const overlay = overlayOf(env, MODEL, "global_location_number");
      const rows = await env.sudo().model(MODEL).read([...ids], ["additional_identifiers"], "");
      for (const r of rows) {
        const current = r["additional_identifiers"];
        const has = typeof current === "object" && current !== null && "EAN_GLN" in (current as Record<string, unknown>);
        if (overlay?.get(Number(r["id"])) || has) throw new NotPorted("res.partner._set_additional_identifier('EAN_GLN') with a value to set or drop");
      }
    },
    // account partner.py:738-742 `_inverse_use_partner_credit_limit`: unchecked, the credit limit goes back to the
    // company fallback, which changes nothing when it already is the fallback (use_partner_credit_limit False)
    use_partner_credit_limit: async (env, ids) => {
      const overlay = overlayOf(env, MODEL, "use_partner_credit_limit");
      const rows = await env.model(MODEL).read([...ids], ["use_partner_credit_limit"], "");
      for (const r of rows) {
        const assigned = overlay?.has(Number(r["id"])) ? overlay.get(Number(r["id"])) : false;
        if (!assigned && r["use_partner_credit_limit"]) throw new NotPorted("res.partner credit_limit reset to the company fallback");
      }
    },
    // account partner.py:721-730 `_inverse_invoice_edi_format`: an empty format equal to the commercial partner's
    // suggested one (False) stores False on it, a no-op when its company value is already empty; against a suggested
    // format it would store 'none' (refused)
    invoice_edi_format: async (env, ids) => {
      const overlay = overlayOf(env, MODEL, "invoice_edi_format");
      const rows = await env.model(MODEL).read([...ids], ["commercial_partner_id"], "");
      for (const r of rows) {
        if (overlay?.get(Number(r["id"]))) throw new NotPorted("res.partner invoice_edi_format inverse with a format");
        const commercial = typeof r["commercial_partner_id"] === "number" ? r["commercial_partner_id"] : Number(r["id"]);
        if (await suggestedEdiFormat(env, commercial)) throw new NotPorted("res.partner invoice_edi_format inverse against a suggested format");
        const store = (await env.model(MODEL).read([commercial], ["invoice_edi_format_store"], ""))[0]?.["invoice_edi_format_store"];
        if (store) throw new NotPorted("res.partner invoice_edi_format inverse clearing a stored format");
      }
    },
  },
});
