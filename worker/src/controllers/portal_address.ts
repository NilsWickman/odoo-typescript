/**
 * `POST /my/address/submit` (portal/controllers/portal.py:479-506 `portal_address_submit`): the address form of
 * `/my/account` (and `/my/address`) saves through it and reads back a JSON feedback, either `{"redirectUrl": ...}` or
 * `{"invalid_fields": [...], "messages": [...]}`. Ported with the overrides of the modules a portal database has:
 * account (`_validate_address_values` :277-289, the writable `invoice_sending_method`/`invoice_edi_format`),
 * account_peppol (`_validate_address_values` :33-77 and the writable routing fields), sale and account
 * (`_has_confirmed_documents`, `_can_edit_country`). What is not ported refuses with NotPorted: a partner the customer
 * may not edit (werkzeug's Forbidden page), Peppol sending, additional identifiers, a country that enforces its cities,
 * a new parent company from `parent_name` (`_create_parent_from_name`).
 */
import { NotPorted, ValidationError } from "../errors";
import type { RequestContext } from "../http/context";
import { route } from "../http/router";
import { parseDomain } from "../orm/domain";
import { create } from "../orm/create";
import type { Context, Environment } from "../orm/types";
import { write } from "../orm/write";
import { translate } from "../models/util";
import { runVatChecks } from "../models/res_partner_write";
import { ADDITIONAL_IDENTIFIERS_METADATA } from "../models/partner_identifiers";
import { PyStrSet } from "../web/pystrset";
import { pyJsonDumps } from "./translations";
import { frontendLangCookie } from "./report";

const _ = (env: Environment, s: string, module = "portal"): string => translate(env, s, module);

async function installed(env: Environment, module: string): Promise<boolean> {
  return (await env.sudo().cr.query("SELECT 1 FROM ir_module_module WHERE name = $1 AND state = 'installed'", [module])).rows.length > 0;
}

/** portal res_partner.py:11-19 `_get_frontend_writable_fields`, with account partner.py:926-930 and account_peppol res_partner.py:280-284. */
async function frontendWritableFields(env: Environment): Promise<Set<string>> {
  const out = new Set(["name", "phone", "email", "street", "street2", "city", "city_id", "state_id", "country_id", "zip", "zipcode", "vat", "parent_name"]);
  if (await installed(env, "account")) { out.add("invoice_sending_method"); out.add("invoice_edi_format"); }
  if (await installed(env, "account_peppol")) { out.add("routing_scheme"); out.add("routing_endpoint"); }
  for (const m of ["website_sale", "l10n_it_edi", "l10n_pe", "l10n_my_edi", "l10n_my_edi_pos", "l10n_sa_edi", "l10n_br", "l10n_ar"]) {
    if (await installed(env, m)) throw new NotPorted(`/my/address/submit with ${m} (_get_frontend_writable_fields)`);
  }
  return out;
}

interface Country { id: number; code: string | null; state_required: boolean | null; zip_applicability: string | null; enforce_cities: boolean | null }

async function countryOf(env: Environment, id: unknown): Promise<Country | null> {
  if (typeof id !== "number") return null;
  return (await env.sudo().cr.query<Country>(
    "SELECT id, code, state_required, zip_applicability, enforce_cities FROM res_country WHERE id = $1", [id])).rows[0] ?? null;
}

/** portal res_country.py:77-95 `_get_partner_city_field` / `_enforce_city_choice`. */
async function partnerCityField(env: Environment, c: Country | null): Promise<string> {
  if (c && ["BR", "CL", "PE", "CO", "TW"].includes(c.code ?? "") && c.enforce_cities
    && (await env.model("res.city").searchCount(parseDomain([["country_id", "=", c.id]]), 1)) > 0) return "city_id";
  return "city";
}

/** portal res_partner.py:141-156 `_get_mandatory_address_fields`. */
async function mandatoryAddressFields(env: Environment, c: Country | null): Promise<PyStrSet> {
  const s = PyStrSet.of("street", await partnerCityField(env, c), "country_id");
  if (c?.state_required) s.add("state_id");
  if (c?.zip_applicability === "required") s.add("zip");
  return s;
}

/** portal res_partner.py:96-135 `_get_required_address_fields` (`_needs_address` is True). */
async function requiredAddressFields(env: Environment, addressType: string, c: Country | null, useDeliveryAsBilling: boolean): Promise<PyStrSet> {
  const mandatory = async (): Promise<PyStrSet> => {
    const base = PyStrSet.of("name", "email");
    base.add("phone");
    return new PyStrSet().update(base).update(await mandatoryAddressFields(env, c));
  };
  const required = new PyStrSet();
  if (addressType === "delivery" || useDeliveryAsBilling) required.update(await mandatory());
  if (addressType === "billing" || useDeliveryAsBilling) required.update(await mandatory());
  return required;
}

/** tools/misc.py:439-460 `str2bool` without a default. */
function str2bool(s: string): boolean {
  const l = s.toLowerCase();
  if (["y", "yes", "1", "true", "t", "on"].includes(l)) return true;
  if (["n", "no", "0", "false", "f", "off"].includes(l)) return false;
  throw new NotPorted(`/my/address/submit with use_delivery_as_billing=${JSON.stringify(s)} (str2bool raises ValueError)`);
}

const SINGLE_EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}$/;

interface PartnerState {
  id: number; name: string | null; email: string | null; parentId: number | null; commercialId: number;
  countryId: number | null; isCompany: boolean;
}

async function partnerState(env: Environment, id: number): Promise<PartnerState | null> {
  const r = (await env.sudo().cr.query<{ name: string | null; email: string | null; parent_id: number | null; commercial_partner_id: number | null; country_id: number | null }>(
    "SELECT name, email, parent_id, commercial_partner_id, country_id FROM res_partner WHERE id = $1", [id])).rows[0];
  if (!r) return null;
  const commercialId = r.commercial_partner_id ?? id;
  const isCompany = (await env.sudo().cr.query<{ is_company: boolean | null }>("SELECT is_company FROM res_partner WHERE id = $1", [commercialId])).rows[0]?.is_company ?? false;
  return { id, name: r.name, email: r.email, parentId: r.parent_id, commercialId, countryId: r.country_id, isCompany: Boolean(isCompany) };
}

/** sale res_partner.py:69-77 `_has_order`. */
async function hasOrder(env: Environment, domain: unknown[]): Promise<boolean> {
  if (!await installed(env, "sale")) return false;
  return (await env.sudo().model("sale.order").search(parseDomain([...domain, ["state", "in", ["sent", "sale"]]]), { limit: 1 })).length > 0;
}

/** account partner.py:786-798 `_has_invoice`. */
async function hasInvoice(env: Environment, domain: unknown[]): Promise<boolean> {
  if (!await installed(env, "account")) return false;
  return (await env.sudo().model("account.move").search(parseDomain([...domain, ["move_type", "in", ["out_invoice", "out_refund"]], ["state", "=", "posted"]]), { limit: 1 })).length > 0;
}

/** account partner.py:806-810 and sale res_partner.py:87-91 `_has_confirmed_documents` (account's runs first: sale's super). */
async function hasConfirmedDocuments(env: Environment, p: PartnerState): Promise<boolean> {
  const childOf = [["partner_id", "child_of", p.commercialId]];
  return await hasInvoice(env, childOf) || await hasOrder(env, childOf);
}

/** account partner.py:800-804 and sale res_partner.py:79-85 `_can_edit_country`. */
async function canEditCountry(env: Environment, id: number): Promise<boolean> {
  return !await hasInvoice(env, [["partner_id", "=", id]]) && !await hasOrder(env, ["|", ["partner_invoice_id", "=", id], ["partner_id", "=", id]]);
}

/** portal res_partner.py:30-42 `_is_main_contact`. */
async function isMainContact(env: Environment, p: PartnerState): Promise<boolean> {
  if (!p.parentId) return true;
  const children = (await env.sudo().cr.query<{ id: number }>("SELECT id FROM res_partner WHERE parent_id = $1 AND active AND type = 'contact'", [p.commercialId])).rows.map((r) => r.id);
  const users = (await env.sudo().cr.query("SELECT 1 FROM res_users WHERE partner_id = $1 AND active LIMIT 1", [p.commercialId])).rows.length > 0;
  return children.length === 1 && children[0] === p.id && !users;
}

/** portal res_partner.py:44-54 `_can_be_edited_by_current_customer`. */
async function canBeEditedBy(env: Environment, id: number, current: PartnerState): Promise<boolean> {
  if (id === current.id) return true;
  const ids = await env.sudo().model("res.partner").search(parseDomain([["id", "child_of", current.commercialId], ["type", "in", ["invoice", "delivery", "other"]]]));
  return ids.includes(id);
}

/** `field.convert_to_cache(record[field])` of the fields the form writes: an id or None, a string, or None. */
async function cacheValues(env: Environment, id: number, fields: readonly string[]): Promise<Record<string, unknown>> {
  if (!fields.length) return {};
  const row = (await env.sudo().model("res.partner").read([id], [...fields]))[0] ?? {};
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = (row as Record<string, unknown>)[f];
    out[f] = Array.isArray(v) ? v[0] : v === false || v === undefined ? null : v;
  }
  return out;
}

const truthy = (v: unknown): boolean => v !== null && v !== undefined && v !== false && v !== "" && v !== 0;

route("/my/address/submit", async (ctx: RequestContext) => {
  const env = await ctx.orm();
  frontendLangCookie(ctx, env);
  const su = env.sudo();
  const params = ctx.params as Record<string, unknown>;
  // `portal_address_submit(partner_id=None, **form_data)`, then `_create_or_update_address(partner_sudo,
  // address_type='billing', use_delivery_as_billing=False, callback='/my/addresses', required_fields=False,
  // verify_address_values=True, **form_data)`
  const named = new Set(["partner_id", "address_type", "use_delivery_as_billing", "callback", "required_fields", "verify_address_values"]);
  const formData: [string, unknown][] = Object.entries(params).filter(([k]) => !named.has(k));
  if (formData.some(([, v]) => typeof v !== "string")) throw new NotPorted("/my/address/submit with a file in the form");
  const str = (k: string): string | undefined => (typeof params[k] === "string" ? params[k] as string : undefined);
  const rawPartner = str("partner_id") ?? "";
  if (rawPartner && !/^\s*[+-]?\d+\s*$/.test(rawPartner)) throw new NotPorted("/my/address/submit with a partner_id that is not a number (int() raises)");
  const partnerId = rawPartner ? Number(rawPartner) : null;

  const currentId = (await su.cr.query<{ partner_id: number }>("SELECT partner_id FROM res_users WHERE id = $1", [env.uid])).rows[0]!.partner_id;
  const current = (await partnerState(env, currentId))!;
  const partner = partnerId ? await partnerState(env, partnerId) : null;
  if (partnerId) {
    if (!partner) throw new NotPorted("/my/address/submit of a partner that does not exist");
    if (!await canBeEditedBy(env, partnerId, current)) throw new NotPorted("/my/address/submit of a partner the customer cannot edit (werkzeug Forbidden page)");
  }

  const addressType = str("address_type") ?? "billing";
  const useDeliveryAsBilling = str2bool(str("use_delivery_as_billing") || "false");
  const callback = "callback" in params ? str("callback")! : "/my/addresses";
  const requiredFields = str("required_fields") || "";
  const verify = "verify_address_values" in params ? truthy(params["verify_address_values"]) : true;

  // :580-627 `_parse_form_data`
  const def = env.reg.model("res.partner");
  const writable = await frontendWritableFields(env);
  const identifierKeys = new Set(Object.keys(ADDITIONAL_IDENTIFIERS_METADATA));
  const values = new Map<string, unknown>();
  const extra = new Map<string, string>();
  for (const [key, raw] of formData) {
    const value = (raw as string).trim();
    const field = def.fields.get(key);
    if (field && writable.has(key)) {
      if (field.type === "many2one") values.set(key, /^\d+$/.test(value) ? Number(value) : null);
      else if (field.type === "selection") {
        const keys = field.selection?.map((s) => s.value);
        if (keys === undefined || keys === null) throw new NotPorted(`/my/address/submit of a callable selection ${key}`);
        if (value === "" && !keys.includes("")) values.set(key, false);
        else if (!keys.includes(value)) throw new NotPorted(`/my/address/submit with ${key}=${JSON.stringify(value)} (convert_to_cache raises ValueError)`);
        else values.set(key, value);
      } else if (field.type === "char") values.set(key, value);
      else throw new NotPorted(`/my/address/submit of a ${field.type} field ${key}`);
    } else if (identifierKeys.has(key.toUpperCase())) {
      throw new NotPorted("/my/address/submit with additional identifiers");
    } else if (value) extra.set(key, value);
  }
  if (formData.some(([k]) => k === "zipcode") && !str("zip")) {
    throw new NotPorted("/my/address/submit with zipcode and no zip");
  }
  const country = await countryOf(env, values.get("country_id"));
  if (await partnerCityField(env, country) === "city_id") throw new NotPorted("/my/address/submit for a country that enforces its cities");

  if (verify) {
    // :683-866 `_validate_address_values` with account's (:277-289) and account_peppol's (:33-77) overrides
    const invalid = new PyStrSet(), missing = new PyStrSet();
    const messages: string[] = [];
    let mainContact: boolean;
    if (partner) {
      const nameChange = values.has("name") && truthy(partner.name) && values.get("name") !== partner.name!.trim();
      const countryChange = values.has("country_id") && partner.countryId !== null && values.get("country_id") !== partner.countryId;
      const emailChange = values.has("email") && truthy(partner.email) && values.get("email") !== partner.email;
      if (countryChange && !await canEditCountry(env, partner.id)) {
        invalid.add("country_id");
        messages.push(_(env, "Changing your country is not allowed once document(s) have been issued for your account. Please contact us directly for this operation."));
      }
      if (nameChange || emailChange) {
        const shares = (await su.cr.query<{ share: boolean | null }>("SELECT share FROM res_users WHERE partner_id = $1 AND active", [partner.id])).rows;
        if (!shares.every((r) => r.share)) {
          if (nameChange) invalid.add("name");
          if (emailChange) invalid.add("email");
          messages.push(_(env, "If you are ordering for an external person, please place your order via the backend. If you wish to change your name or email address, please do so in the account settings or contact your administrator."));
        }
      }
      mainContact = partner.id === current.id && await isMainContact(env, current);
      const confirmed = await hasConfirmedDocuments(env, current);
      if (!mainContact || confirmed) {
        // the commercial fields (`_commercial_fields` less additional_identifiers) the form can carry: vat
        if (values.has("vat")) {
          const had = (await cacheValues(env, partner.id, ["vat"]))["vat"];
          if (!(mainContact && !truthy(had))) {
            const now = values.get("vat");
            if (had !== now && (truthy(had) || truthy(now))) {
              invalid.add("vat");
              // `self.env._(msg)` without arguments: the placeholder stays as it is
              if (partner.isCompany) {
                messages.push(_(env, "The %(field_description)s is managed on your company account."));
              } else if (current.id !== partner.id) messages.push(_(env, "The %(field_description)s is managed on your main account address."));
              else messages.push(_(env, "Changing %(field_description)s is not allowed once document(s) have been issued for your account. Please contact us directly for this operation."));
            } else values.delete("vat");
          }
        }
        if (partner.id !== current.id) values.delete("parent_name");
      }
    } else {
      mainContact = false; // `not current_partner`: auth='user' always has one
    }
    const email = values.get("email");
    if (truthy(email) && !SINGLE_EMAIL_RE.test(String(email))) {
      invalid.add("email");
      messages.push(_(env, "Invalid Email! Please enter a valid email address."));
    }
    const vat = values.get("vat");
    if (truthy(vat) && !invalid.has("vat")) {
      // `ResPartnerSudo.new({country_id, vat})._check_vat()`: the new partner is its own commercial partner
      try {
        await runVatChecks(su, country?.code ?? null, String(vat), "error", "");
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e;
        invalid.add("vat");
        messages.push(e.message);
      }
    }
    const required = new PyStrSet();
    for (const f of requiredFields.split(",")) if (f) required.add(f);
    required.update(await requiredAddressFields(env, addressType, country, useDeliveryAsBilling));
    if ((addressType === "billing" || useDeliveryAsBilling) && !mainContact && required.has("vat") && !values.has("vat")) {
      throw new NotPorted("/my/address/submit requiring vat on a contact that is not the main one (set.remove)");
    }
    const addressFields = await mandatoryAddressFields(env, country);
    if ([...addressFields].some((f) => truthy(values.get(f)))) required.update(addressFields);
    for (const f of required) if (!truthy(values.get(f))) missing.add(f);
    if (missing.size) messages.push(_(env, "Some required fields are empty."));
    // account_peppol
    if (values.get("invoice_sending_method") === "peppol") throw new NotPorted("/my/address/submit with Peppol sending");
    if (messages.length) {
      const fields = [...new PyStrSet().update(invalid).update(missing)];
      return json(pyJsonDumps({ invalid_fields: fields, messages }, false));
    }
  }

  const parentName = values.get("parent_name");
  values.delete("parent_name");
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(env.context)) if (!k.startsWith("default_")) cleaned[k] = v;
  cleaned["no_vat_validation"] = true;
  const penv = su.withContext(cleaned as Context);

  let id: number;
  if (!partner) {
    // :880-910 `_complete_address_values`
    const vals: Record<string, unknown> = Object.fromEntries(values);
    vals["lang"] = env.lang ?? "en_US";
    vals["company_id"] = (await su.cr.query<{ company_id: number | null }>("SELECT company_id FROM res_partner WHERE id = $1", [current.id])).rows[0]?.company_id ?? false;
    if (useDeliveryAsBilling) vals["type"] = "other";
    else if (addressType === "billing") vals["type"] = "invoice";
    else if (addressType === "delivery") vals["type"] = "delivery";
    const commercialActive = (await su.cr.query<{ active: boolean | null }>("SELECT active FROM res_partner WHERE id = $1", [current.commercialId])).rows[0]?.active;
    if (commercialActive) vals["parent_id"] = current.commercialId;
    id = (await create(penv, "res.partner", [vals]))[0]!;
  } else {
    id = partner.id;
    // :912-919 `_are_same_addresses`
    const keys = [...values.keys()];
    const had = await cacheValues(env, id, keys);
    const same = keys.every((k) => { const n = values.get(k), o = had[k]; return !(n !== o && (truthy(o) || truthy(n))); });
    if (!same) {
      if (!values.has("name")) throw new NotPorted("/my/address/submit without a name (KeyError)");
      if (String(values.get("name")).trim() === (partner.name ?? "").trim()) values.delete("name");
      await write(penv, "res.partner", [id], Object.fromEntries(values));
    }
  }

  if (truthy(parentName)) {
    const p = (await partnerState(env, id))!;
    if (p.commercialId !== p.id) {
      if (p.isCompany) {
        const companyName = (await su.cr.query<{ name: string | null }>("SELECT name FROM res_partner WHERE id = $1", [p.commercialId])).rows[0]?.name;
        if (companyName !== parentName) await write(su, "res.partner", [p.commercialId], { name: parentName });
      }
    } else {
      const contacts = p.parentId ? [] : (await su.cr.query("SELECT 1 FROM res_partner WHERE parent_id = $1 AND active AND type = 'contact' LIMIT 1", [p.id])).rows;
      if (!p.parentId && contacts.length) {
        if (p.name !== parentName) await write(su, "res.partner", [p.id], { name: parentName });
      } else throw new NotPorted("/my/address/submit creating a parent company from parent_name (_create_parent_from_name)");
    }
  }
  return json(pyJsonDumps({ redirectUrl: callback }, false));
}, { auth: "user", methods: ["POST"] });

/** An http route that returns a str: werkzeug's Response with its default mimetype. */
function json(body: string): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
