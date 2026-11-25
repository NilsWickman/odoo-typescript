/**
 * res.partner's write-side Python behaviour (odoo/odoo/addons/base/models/res_partner.py, with
 * base_address_extended, mail, phone_validation and partner_autocomplete): field defaults, record computes for new
 * records and stored computed fields, `@api.onchange` methods, `default_get`, `create`/`write` overrides with the
 * commercial/address synchronisation (`_fields_sync`), `name_create`, `@api.ondelete` and `autocomplete_by_field`.
 */
import { PrivateRecords } from "../orm/private_hooks";
import { REF_VAT, VAT_MODULES } from "./vat_stdnum";
import { IDENTIFIER_VALIDATORS } from "./identifier_validators";
import { deducedIdentifiers } from "./res_partner_erp_write";
import { TIN_METADATA } from "./partner_identifiers";
import { luhnChecksum } from "./luhn";
import { MissingError, NotPorted, OdooError, UserError, ValidationError } from "../errors";
import { registerMethod } from "../http/methods";
import { hooksOf } from "../orm/hooks";
import { cacheEqual, convertToCache } from "../orm/convert";
import * as D from "../orm/domain";
import { ModelImpl } from "../orm/model";
import { DbRec, NewRec, type Rec, registerDefaults, registerOnchange, registerRecordCompute } from "../orm/recompute";
import type { Domain, Environment } from "../orm/types";
import { binaryBytes } from "../orm/values";
import { create } from "../orm/create";
import { registerLoadRecordsCreate } from "../orm/load_records";
import { registerOverrides, write } from "../orm/write";
import { defaultGet } from "../web/defaults";
import { attachmentValues } from "./binary";
import { generateAvatarSvg, avatarSeed, partnerPlaceholderPath, placeholderValue } from "./avatar";
import { canonicalPhone, internationalPhone } from "./phone";
import { cleanWebsite, emailNormalize, streetSplit } from "./partner_pure_write";
import { erpAfterCreate, erpBeforeCreate } from "./res_partner_erp_write";
import { pyStrRepr, translate } from "./util";
import { refuseIdentifierMetadataOverride } from "./partner_form";
import * as priv from "../orm/dispatch_gen";

const MODEL = "res.partner";

// ------------------------------------------------------------------------------------------------ translations

type Metadata = Record<string, Record<string, unknown>>;
interface ContactData { identifiers: Metadata; translations: Record<string, Record<string, string>> }
let contacts: Promise<Record<string, ContactData>> | undefined;
async function contactData(env: Environment): Promise<ContactData> {
  contacts ??= import("../../gen/out/contacts.json", { with: { type: "json" } }).then((m) => m.default as Record<string, ContactData>);
  const found = (await contacts)[env.lang || "en_US"];
  if (!found) throw new NotPorted(`partner translations ${env.lang}`);
  return found;
}
/** `_()` in module base (gen/out/contacts.json from base/i18n/*.po). */
async function t(env: Environment, source: string): Promise<string> {
  return (await contactData(env)).translations["base"]?.[source] || source;
}

// ------------------------------------------------------------------------------------------------ helpers

async function str(rec: Rec, name: string): Promise<string | null> {
  const v = await rec.get(name);
  return typeof v === "string" ? v : null;
}

/** `self.type` labels of the selection in the env lang (`_description_selection`). */
function typeLabel(env: Environment, type: string | null): string {
  const field = env.reg.model(MODEL).fields.get("type")!;
  const opt = field.selection?.find((s) => s.value === type);
  return opt ? (opt.labels[env.lang ?? "en_US"] ?? opt.label) : "";
}

/** `partner.commercial_partner_id == partner`. */
async function isOwnCommercial(rec: Rec): Promise<boolean> {
  const v = await rec.get("commercial_partner_id");
  if (rec instanceof NewRec) return v === rec || (rec.origin !== null && v === rec.origin && !(await rec.get("parent_id")));
  return v === rec.id;
}

/** res_partner.py:469 _get_complete_name. */
async function completeName(env: Environment, rec: Rec): Promise<string> {
  let name = (await str(rec, "name")) ?? "";
  const parent = await rec.rel("parent_id");
  if (parent) {
    const type = await str(rec, "type");
    if (!name && type && ["invoice", "delivery", "other"].includes(type)) name = typeLabel(env, type);
    if (!(await rec.get("is_company")) && !env.context["partner_display_name_hide_company"]) {
      name = `${(await str(rec, "commercial_company_name")) || (await str(parent, "name")) || ""}, ${name}`;
    }
  }
  return name.trim();
}

/** phone_validation models.py:23 _phone_get_country / :86 company fallback: the country code for formatting. */
async function phoneCountryCode(env: Environment, rec: Rec): Promise<string | null> {
  const country = await rec.rel("country_id");
  if (country) return str(country, "code");
  const row = (await env.cr.query<{ code: string | null }>(
    `SELECT c.code FROM res_company co JOIN res_partner p ON p.id = co.partner_id LEFT JOIN res_country c ON c.id = p.country_id WHERE co.id = $1`,
    [await env.company()])).rows[0];
  return row?.code ?? null;
}

/** base/models/res_partner.py:937 _compute_has_vat. */
async function hasVat(rec: Rec): Promise<boolean> {
  const vat = await str(rec, "vat");
  return !!vat && !["/", "na", "NA"].includes(vat);
}

/** Read-side computes that do not depend on the record (they ignore the ids): reuse them for new records. */
async function recordIndependent(env: Environment, field: string): Promise<unknown> {
  const fn = hooksOf(MODEL).computed?.[field];
  if (!fn) throw new NotPorted(`compute ${MODEL}.${field}`);
  return (await fn(env, [0])).get(0) ?? null;
}

/** A fresh value object: Python's BinaryBytes compare by identity, so each computation is a new value. */
async function freshBinary(v: Awaited<ReturnType<typeof placeholderValue>>): Promise<ReturnType<typeof binaryBytes>> {
  return binaryBytes(await v.content(), v.filename, v.mimetype);
}

/** res_partner.py:446 _compute_avatar over avatar_mixin.py:47. */
function avatarCompute(size: number) {
  return async (env: Environment, rec: Rec): Promise<unknown> => {
    const image = rec.id !== null ? (await attachmentValues(env, MODEL, `image_${size}`, [rec.id])).get(rec.id) ?? null : await rec.get(`image_${size}`);
    const type = await str(rec, "type");
    const users = await rec.rels("user_ids");
    let internal = false;
    for (const u of users) if (!(await u.get("share"))) internal = true;
    if (type === "contact" || internal) {
      if (image) return image;
      const name = await str(rec, "name");
      if (rec.id !== null && name) {
        const cd = await rec.get("create_date");
        const text = typeof cd === "string" ? cd : null;
        const fraction = text?.split(".")[1] ?? "0";
        return generateAvatarSvg(name, avatarSeed(name, text ? new Date(text.replace(" ", "T") + "Z") : null, Number(fraction.padEnd(6, "0"))));
      }
      return freshBinary(await placeholderValue(partnerPlaceholderPath(!!(await rec.get("is_company")), type)));
    }
    if (!image) return freshBinary(await placeholderValue(partnerPlaceholderPath(!!(await rec.get("is_company")), type)));
    return image;
  };
}

// ------------------------------------------------------------------------------------------------ computes

registerRecordCompute(MODEL, {
  // res_partner.py:598 _compute_commercial_partner
  commercial_partner_id: async (_env, rec) => {
    const parent = await rec.rel("parent_id");
    if (!parent) return rec instanceof NewRec ? (rec.origin ?? rec) : rec.id;
    const v = await parent.get("commercial_partner_id");
    return v instanceof NewRec ? v : v;
  },
  // res_partner.py:937
  has_vat: async (_env, rec) => hasVat(rec),
  // res_partner.py:946 _compute_is_company
  is_company: async (_env, rec) => (await isOwnCommercial(rec)) && (await hasVat(rec)),
  // res_partner.py:483 _compute_complete_name with_context({})
  complete_name: async (env, rec) => completeName(env.withContext({}), rec),
  // res_partner.py:1151 _compute_display_name (the plain branch)
  display_name: async (env, rec) => {
    const ctx = env.context;
    if (ctx["formatted_display_name"] || ctx["show_address"] || ctx["show_identifier"]) throw new NotPorted("partner display_name context on a new record");
    let name = await completeName(env, rec);
    if (ctx["partner_show_db_id"]) name = `${name} (${rec.id ?? false})`;
    const email = await str(rec, "email");
    if (ctx["show_email"] && email) name = `${name} <${email}>`;
    return name.replace(/\s+\n/g, "\n").trim();
  },
  // mail_thread_blacklist.py:61 _compute_email_normalized (email_normalize(strict=True))
  email_normalized: async (_env, rec) => emailNormalize(await str(rec, "email")),
  // mail_thread_blacklist.py:83
  is_blacklisted: async (env, rec) => {
    const email = await rec.get("email_normalized");
    if (!email) return false;
    return (await env.cr.query("SELECT 1 FROM mail_blacklist WHERE active AND email = $1", [email])).rows.length > 0;
  },
  // mail_thread_phone.py:148 _compute_phone_sanitized (E164 via phonenumbers; invalid -> False)
  phone_sanitized: async (env, rec) => (await canonicalPhone(await str(rec, "phone"), await phoneCountryCode(env, rec))) || null,
  // mail_thread_phone.py:159
  phone_formatted: async (_env, rec) => (await internationalPhone((await rec.get("phone_sanitized")) as string | null)) || null,
  // mail_thread_phone.py:164 _compute_blacklisted
  phone_sanitized_blacklisted: async (env, rec) => {
    const n = await rec.get("phone_sanitized");
    return !!n && (await env.cr.query("SELECT 1 FROM phone_blacklist WHERE active AND number = $1", [n])).rows.length > 0;
  },
  phone_blacklisted: async (env, rec) => {
    const n = await rec.get("phone_sanitized");
    if (!n) return false;
    const listed = (await env.cr.query("SELECT 1 FROM phone_blacklist WHERE active AND number = $1", [n])).rows.length > 0;
    return listed && (await canonicalPhone(await str(rec, "phone"), await phoneCountryCode(env, rec))) === n;
  },
  // res_partner.py:575
  type_address_label: async (env, rec) => {
    const type = await str(rec, "type");
    return t(env, type === "invoice" ? "Invoice Address" : type === "delivery" ? "Delivery Address" : "Address");
  },
  vat_label: async (env) => recordIndependent(env, "vat_label"),
  active_lang_count: async (env) => recordIndependent(env, "active_lang_count"),
  properties_base_definition_id: async (env) => recordIndependent(env, "properties_base_definition_id"),
  // res_partner.py:1633 _compute_available_additional_identifiers_metadata (same rule as partner_form.ts)
  available_additional_identifiers_metadata: async (env, rec) => {
    refuseIdentifierMetadataOverride(env);
    const meta = (await contactData(env)).identifiers;
    const country = await rec.rel("country_id");
    const code = country ? await str(country, "code") : null;
    const stored = ((await rec.get("additional_identifiers")) || {}) as Record<string, unknown>;
    const selected = Object.fromEntries(Object.entries(meta).filter(([key, m]) => !m["countries"] || (m["countries"] as string[]).includes(String(code === null ? false : code)) || key in stored));
    if (Object.entries(selected).some(([k, m]) => k !== "OTHER" && m["category"] === "EN")) delete selected["OTHER"];
    return selected;
  },
  // res_partner.py:541 _compute_same_vat_partner_id: only the "no Tax ID / child contact" branch
  same_vat_partner_id: async (_env, rec) => {
    // res_partner.py:541-569, with _origin for onchange
    if (!(await hasVat(rec)) || (await rec.get("parent_id"))) return null;
    const env = _env;
    const vat = (await str(rec, "vat")) ?? "";
    const vats = [vat];
    const country = await rec.rel("country_id");
    const countryId = country ? country.id : null;
    if (country && countryId !== null) {
      const eu = (await env.cr.query("SELECT 1 FROM res_country_res_country_group_rel r JOIN res_country_group g ON g.id = r.res_country_group_id WHERE r.res_country_id = $1 AND g.code = 'EU_PREFIX'", [countryId])).rows.length > 0;
      if (eu) {
        const code = (await str(country, "code")) ?? "";
        if (/^[A-Za-z]{2}/.test(vat)) vats.push(vat.slice(2));
        else {
          vats.push(code + vat);
          const extra = ({ GR: "EL", GB: "XI" } as Record<string, string>)[code]; // EU_EXTRA_VAT_CODES (:49)
          if (extra) vats.push(extra + vat);
        }
      }
    }
    const parts: Domain[] = [D.cond("vat", "in", vats)];
    if (country) parts.push(D.cond("country_id", "in", [countryId, false]));
    const company = await rec.get("company_id");
    if (typeof company === "number") parts.push(D.cond("company_id", "in", [false, company]));
    const origin = rec.origin;
    if (origin !== null) parts.push(D.cond("id", "!=", origin), D.not(D.cond("id", "child_of", origin)));
    const found = await env.sudo().withContext({ ...env.context, active_test: false }).model(MODEL).search(D.and(parts), { limit: 1, activeTest: false });
    return found[0] ?? null;
  },
  // res_partner.py:488 _compute_lang
  lang: async (env, rec) => {
    const parent = await rec.rel("parent_id");
    if (parent) {
      return (await parent.get("lang")) || (await defaultGet(env, MODEL, ["lang"]))["lang"] || env.lang || null;
    }
    const current = await rec.prev("lang");
    if (!current) return (await defaultGet(env, MODEL, ["lang"]))["lang"] || env.lang || null;
    return current;
  },
  // res_partner.py:509 _compute_user_id
  user_id: async (_env, rec) => {
    const current = await rec.prev("user_id");
    const parent = await rec.rel("parent_id");
    if (!current && !(await rec.get("is_company")) && parent) {
      const pu = await parent.get("user_id");
      if (pu) return pu;
    }
    return current || null;
  },
  // res_partner.py:533 _compute_partner_share (superuser's partner is never shared)
  partner_share: async (env, rec) => {
    const su = (await env.cr.query<{ partner_id: number }>("SELECT partner_id FROM res_users WHERE id = 1")).rows[0]?.partner_id;
    if (rec.id !== null && rec.id === su) return false;
    const users = await rec.rels("user_ids");
    if (!users.length) return true;
    for (const u of users) if (!(await u.get("share"))) return false;
    return true;
  },
  // fields_properties.py Properties compute: a definition without properties leaves the value as it is
  properties: async (env, rec) => {
    const def = await rec.get("properties_base_definition_id");
    if (def) {
      const row = (await env.cr.query<{ d: unknown }>("SELECT properties_definition AS d FROM properties_base_definition WHERE id = $1", [def])).rows[0];
      if (row && Array.isArray(row.d) && row.d.length) throw new NotPorted("properties default values from a non-empty definition");
    }
    return rec.prev("properties");
  },
  // base_address_extended/models/res_partner.py:32 _compute_street_data
  street_name: async (_env, rec) => streetSplit(await str(rec, "street")).street_name,
  street_number: async (_env, rec) => streetSplit(await str(rec, "street")).street_number,
  street_number2: async (_env, rec) => streetSplit(await str(rec, "street")).street_number2,
  ...Object.fromEntries([128, 256, 512, 1024, 1920].map((s) => [`avatar_${s}`, avatarCompute(s)])),
});

// ------------------------------------------------------------------------------------------------ defaults

registerDefaults(MODEL, {
  // res_partner.py:308 tz default=lambda self: self.env.context.get('tz')
  tz: async (env) => env.context.tz ?? null,
  // res_partner.py:281 _default_category: browse(context.get('category_id'))
  category_id: async (env) => {
    const c = env.context["category_id"];
    if (c === undefined || c === null || c === false) return [];
    if (typeof c === "number") return [c];
    throw new NotPorted("context category_id default");
  },
  active: async () => true, // :341
  type: async () => "contact", // :349
  is_company: async () => false, // :367
  color: async () => 0, // :372
  // mail/models/mail_thread_blacklist.py message_bounce default=0
  message_bounce: async () => 0,
});

// ------------------------------------------------------------------------------------------------ onchange

const ADDRESS_FIELDS = ["street", "street2", "zip", "city", "state_id", "country_id", "city_id"]; // :46 + base_address_extended :21

/** res_partner.py:709 _get_address_values in write format, or {} when no address field is set. */
async function addressValues(rec: Rec): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  let any = false;
  for (const f of ADDRESS_FIELDS) {
    const v = await rec.get(f);
    if (v !== null && v !== false && v !== "") any = true;
    out[f] = v === null ? false : v;
  }
  return any ? out : {};
}

// Methods in getmembers() (alphabetical) order, models.py:594.
registerOnchange(MODEL, "_onchange_city_id", ["city_id"], async (_env, rec) => {
  // base_address_extended/models/res_partner.py:47
  const city = await rec.rel("city_id");
  if (city) throw new NotPorted("_onchange_city_id with a city");
  if (rec.origin !== null) {
    await rec.set("city", null); await rec.set("zip", null); await rec.set("state_id", null);
  }
});
registerOnchange(MODEL, "_onchange_company_id", ["parent_id", "company_id"], async (_env, rec) => {
  // res_partner.py:649
  const parent = await rec.rel("parent_id");
  if (parent) await rec.set("company_id", await parent.get("company_id"));
});
registerOnchange(MODEL, "_onchange_country_id", ["country_id"], async (_env, rec) => {
  // res_partner.py:639 then base_address_extended res_partner.py:60
  const country = await rec.get("country_id");
  const state = await rec.rel("state_id");
  if (country && country !== (state ? await state.get("country_id") : null)) await rec.set("state_id", null);
  const city = await rec.rel("city_id");
  if (country && country !== (city ? await city.get("country_id") : null)) await rec.set("city_id", null);
});
registerOnchange(MODEL, "_onchange_state", ["state_id"], async (_env, rec) => {
  // res_partner.py:644
  const state = await rec.rel("state_id");
  const sc = state ? await state.get("country_id") : null;
  if (sc && (await rec.get("country_id")) !== sc) await rec.set("country_id", sc);
});
registerOnchange(MODEL, "_onchange_vat", ["vat", "country_id"], async (_env, rec) => {
  // res_partner.py:1387 _check_vat(validation=False): _run_vat_checks returns the vat unchanged without country/vat
  // res_partner.py:599-604 `_compute_commercial_partner`: a partner without a parent is its own commercial partner (the
  // form's record, with the country of the form), else the parent's
  const commercial = (await rec.get("parent_id")) ? await rec.rel("commercial_partner_id") : rec;
  const country = commercial && commercial !== rec ? await commercial.get("country_id") : await rec.get("country_id");
  const vat = await str(rec, "vat");
  if (!country || !vat) return;
  const code = await countryCode(_env, country);
  const checked = await runVatChecks(_env, code, vat, false);
  if (checked !== vat) await rec.set("vat", checked); // _check_vat: `if vat != partner.vat: partner.vat = vat`
});
registerOnchange(MODEL, "onchange_l10n_se_default_vendor_payment_ref", ["l10n_se_default_vendor_payment_ref"], async (env, rec) => {
  // l10n_se/models/res_partner.py:14-21: `not ref == ""` is also true for an unset (False) reference, which
  // luhn.validate refuses (`not bool(number)`), as it refuses a non-digit or a wrong checksum (stdnum luhn.py:61-71)
  const ref = await rec.get("l10n_se_default_vendor_payment_ref");
  if (ref === "" || !(await rec.get("l10n_se_check_vendor_ocr"))) return;
  let valid = false;
  if (typeof ref === "string" && ref) { try { valid = luhnChecksum(ref) === 0; } catch { valid = false; } }
  if (!valid) return { title: translate(env, "Warning", "l10n_se"), message: translate(env, "Default vendor OCR number isn't a valid OCR number.", "l10n_se") };
});
registerOnchange(MODEL, "onchange_parent_id", ["parent_id"], async (env, rec) => {
  // res_partner.py:624: returns {'value': parent_address} for contacts, applied by _apply_onchange_methods
  const parent = await rec.rel("parent_id");
  if (!parent) return;
  const originType = rec.origin !== null ? await new DbRec(env, rec.def, rec.origin).get("type") : null;
  const address = await addressValues(parent);
  if (((originType as string | null) || (await str(rec, "type"))) === "contact" && Object.keys(address).length) {
    for (const [k, v] of Object.entries(address)) await rec.set(k, convertToCache(rec.def.fields.get(k)!, v, MODEL));
  }
});

// ------------------------------------------------------------------------------------------------ ORM overrides

/** res_partner.py:726 _commercial_fields / :736 _synced_commercial_fields. */
const COMMERCIAL_FIELDS = ["vat", "additional_identifiers", "industry_id"];
const SYNCED_COMMERCIAL_FIELDS = ["vat", "additional_identifiers"];

async function valuesOf(env: Environment, id: number, names: readonly string[]): Promise<Record<string, unknown>> {
  const rec = new DbRec(env.sudo(), env.reg.model(MODEL), id);
  const out: Record<string, unknown> = {};
  for (const n of names) { const v = await rec.get(n); out[n] = v === null ? false : v; }
  return out;
}

/** res_partner.py:851 _fields_sync for one partner (values: the updated values that trigger the sync). */
async function fieldsSync(env: Environment, id: number, values: Record<string, unknown>): Promise<void> {
  const def = env.reg.model(MODEL);
  let rec = new DbRec(env, def, id);
  const parentId = (await rec.get("parent_id")) as number | null;
  // 1. from upstream
  if (values["parent_id"] || values["type"] === "contact") {
    if (values["parent_id"]) {
      const address = await addressValues(rec);
      const parentAddress = parentId ? await addressValues(new DbRec(env, def, parentId)) : {};
      if ((await rec.get("type")) === "contact" && Object.keys(address).length && Object.keys(parentAddress).length && !cacheEqual(address, parentAddress)) {
        await write(env, MODEL, [id], { type: "other" });
        rec = new DbRec(env, def, id);
      }
      await commercialSyncFromCompany(env.sudo(), id);
      rec = new DbRec(env, def, id);
    }
    if (parentId && (await rec.get("type")) === "contact") {
      const parentAddress = await addressValues(new DbRec(env, def, parentId));
      // res_partner.py:717 _update_address: super().write (no partner override, mail.thread still applies)
      if (Object.keys(parentAddress).length) await updateAddress(env, [id], parentAddress);
    }
  }
  rec = new DbRec(env, def, id);
  // 2. to upstream
  if (parentId && (await rec.get("type")) === "contact" && (ADDRESS_FIELDS.some((f) => f in values) || "parent_id" in values)) {
    const parent = new DbRec(env, def, parentId);
    let differs = false;
    for (const f of ADDRESS_FIELDS) if (!cacheEqual(await rec.get(f), await parent.get(f))) differs = true;
    if (differs) await write(env, MODEL, [parentId], await valuesOf(env, id, ADDRESS_FIELDS).then((v) => addressOrEmpty(v)));
  }
  rec = new DbRec(env, def, id);
  if (parentId && !(await isOwnCommercial(rec)) && (SYNCED_COMMERCIAL_FIELDS.some((f) => f in values) || "parent_id" in values)) {
    const parent = new DbRec(env, def, parentId);
    let differs = false;
    for (const f of SYNCED_COMMERCIAL_FIELDS) if (!cacheEqual(await rec.get(f), await parent.get(f))) differs = true;
    if (differs) {
      // :904-906 with :751-757 `_get_synced_commercial_values` and :783-798 `_write_commercial_sync` of a parent without identifiers
      const synced = await valuesOf(env, id, SYNCED_COMMERCIAL_FIELDS);
      const vals = Object.fromEntries(Object.entries(synced).filter(([, v]) => truthy(v)));
      if ("additional_identifiers" in vals || truthy(await parent.get("additional_identifiers"))) throw new NotPorted("additional identifiers synced to the parent (_apply_synced_identifiers)");
      await write(env, MODEL, [parentId], vals); // :798 `self.write(sync_vals)`, also when empty (it still sets write_date)
    }
  }
  // 3. to downstream
  await childrenSync(env, id, values);
}

function addressOrEmpty(v: Record<string, unknown>): Record<string, unknown> {
  return Object.values(v).some((x) => x !== false && x !== "") ? v : {};
}

/**
 * res_partner.py:717 _update_address: `super().write(addr_vals)` skips the partner override and mail.thread's write,
 * so mail's override (mail/models/res_partner.py:48-55) prepares the tracking of `contact_address_inline` itself when
 * an address field is in the values. Its `_track_finalize` runs at precommit, after the outer write's records (the
 * scope is closed here: inside a res.partner write that only lowers the write depth, the outer write logs them).
 */
async function updateAddress(env: Environment, ids: readonly number[], vals: Record<string, unknown>): Promise<void> {
  const addr: Record<string, unknown> = {};
  for (const k of ADDRESS_FIELDS) if (k in vals) addr[k] = vals[k];
  const { trackPrepare } = await import("../mail/tracking");
  const { closeTrackingScope } = await import("../mail/write_hooks");
  // `any(fname in vals for fname in self._address_fields())`: the keys of vals, before the filter of addr_vals
  const track = ids.length > 0 && ADDRESS_FIELDS.some((f) => f in vals);
  if (track) await trackPrepare(env, MODEL, ids, ["contact_address_inline"]);
  if (Object.keys(addr).length) await writeSuper(env, ids, addr);
  if (track) await closeTrackingScope(env, MODEL);
}

/**
 * `super().write(vals)` from base ResPartner: in the MRO mail.thread (mail/models/res_partner.py:16 `_inherit =
 * ['mail.thread.blacklist', 'res.partner', ...]`) comes before base ResPartner, so super() is the ORM core only.
 */
async function writeSuper(env: Environment, ids: readonly number[], vals: Record<string, unknown>): Promise<void> {
  const { writeCore } = await import("../orm/write");
  await writeCore(env, MODEL, ids, vals);
}

/**
 * `_commercial_fields` of the installed modules: base res_partner.py:726-740, then every Community module's
 * `super() + [its own fields]` (account partner.py:770-773, the localizations': worker/src/orm/private_hooks.json
 * `covered`, compiler/private_hooks_check.py), the fields the registry has: a module's field is there only when the
 * module is installed, so the union filtered is the MRO's list for any module set.
 */
const MODULE_COMMERCIAL_FIELDS = [
  // account
  "property_account_payable_id", "property_account_receivable_id", "property_account_position_id",
  "property_payment_term_id", "property_supplier_payment_term_id", "credit_limit",
  "l10n_ar_afip_responsibility_type_id", "l10n_cl_sii_taxpayer_type", "l10n_eg_building_no", "l10n_hu_group_vat",
  "l10n_in_gst_treatment", "l10n_in_pan_entity_id", "l10n_in_tan", "l10n_ke_exemption_number", "l10n_kr_default_issuance_type",
  "l10n_my_identification_type", "l10n_my_identification_number", "l10n_my_edi_industrial_classification", "l10n_my_edi_malaysian_tin",
  "sst_registration_number", "ttx_registration_number", "l10n_ph_branch_code", "nrc",
  "l10n_sa_edi_building_number", "l10n_sa_edi_plot_identification", "l10n_sa_edi_additional_identification_scheme",
  "l10n_sa_edi_additional_identification_number", "l10n_tw_edi_require_paper_format",
];
function commercialFields(env: Environment): string[] {
  const fields = env.reg.model(MODEL).fields;
  return [...COMMERCIAL_FIELDS, ...MODULE_COMMERCIAL_FIELDS].filter((f) => fields.has(f));
}

/** `_convert_fields_to_values` (models.py): convert_to_write of the record's values (many2one -> id, empty -> False). */
async function writeValues(rec: DbRec, names: readonly string[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const n of names) {
    const v = await rec.get(n);
    const field = rec.def.fields.get(n)!;
    if (field.type === "one2many" || field.type === "many2many") throw new NotPorted(`commercial sync of x2many ${n}`);
    out[n] = v === null || v === undefined ? false : v;
  }
  return out;
}

const truthy = (v: unknown): boolean => v !== null && v !== undefined && v !== false && v !== "" && v !== 0
  && !(Array.isArray(v) && !v.length) && !(typeof v === "object" && v !== null && !Array.isArray(v) && !Object.keys(v).length);

/**
 * res_partner.py:807-830 _commercial_sync_from_company: the commercial entity's set commercial values written on
 * the contact (`_write_commercial_sync` :783-798, no individual identifiers on a new contact), then the
 * company-dependent ones written in every other company (`_company_dependent_commercial_sync` :818-830).
 */
async function commercialSyncFromCompany(env: Environment, id: number): Promise<void> {
  const def = env.reg.model(MODEL);
  const rec = new DbRec(env, def, id);
  const commercial = (await rec.get("commercial_partner_id")) as number | null;
  if (commercial === id || commercial === null) return;
  const cp = new DbRec(env, def, commercial);
  const fields = commercialFields(env);
  const set: string[] = [];
  for (const f of fields) if (truthy(await cp.get(f))) set.push(f);
  if (set.length) {
    const syncVals = await writeValues(cp, set);
    if ("additional_identifiers" in syncVals) throw new NotPorted("commercial sync of additional_identifiers (_apply_synced_identifiers)");
    const own = await rec.get("additional_identifiers");
    if ("vat" in syncVals && own && typeof own === "object" && Object.keys(own).length) throw new NotPorted("commercial sync on a contact with individual identifiers");
    await write(env, MODEL, [id], syncVals);
    // :815 `self._commercial_sync_to_descendants()` with every commercial field (:836-837), the contact's own
    // non-company children (a contact created with its own child addresses, all in the company's create)
    await commercialSyncToDescendants(env, commercial, id, fields);
  }
  const cd = fields.filter((f) => def.fields.get(f)?.companyDependent);
  if (!cd.length) return;
  const current = await env.company();
  const companies = (await env.cr.query<{ id: number }>("SELECT id FROM res_company WHERE active ORDER BY sequence, name, id")).rows.map((r) => r.id);
  for (const company of companies) {
    if (company === current) continue;
    const inCompany = env.withContext({ ...env.context, allowed_company_ids: [company, ...((env.context.allowed_company_ids as number[] | undefined) ?? []).filter((c) => c !== company)] });
    const commercialIn = new DbRec(inCompany, def, commercial);
    await write(inCompany, MODEL, [id], await writeValues(commercialIn, cd));
  }
}

/** res_partner.py:902 _children_sync. */
async function childrenSync(env: Environment, id: number, values: Record<string, unknown>): Promise<void> {
  const def = env.reg.model(MODEL);
  const children = await new ModelImpl(env.sudo().withContext({ ...env.context, active_test: false }), def).search(D.and([D.cond("parent_id", "=", id), D.cond("active", "=", true)]));
  if (!children.length) return;
  const rec = new DbRec(env, def, id);
  if (await isOwnCommercial(rec)) {
    // :827-830 `fields_to_sync = values.keys() & self._commercial_fields()` (account adds its fields, partner.py:770-773)
    const fields = Object.keys(values).filter((k) => commercialFields(env).includes(k));
    if (fields.length) await commercialSyncToDescendants(env.sudo(), id, id, fields);
  }
  if (ADDRESS_FIELDS.some((f) => f in values)) {
    const contacts: number[] = [];
    for (const child of children) if ((await new DbRec(env, def, child).get("type")) === "contact") contacts.push(child);
    if (contacts.length) await updateAddress(env, contacts, values);
  }
}

/**
 * res_partner.py:832-849 `_commercial_sync_to_descendants(fields_to_sync)`: the commercial entity's values written on
 * the non-company active children that differ (after their own descendants), through `_write_commercial_sync`
 * (:783-798: synced identifiers and individual identifiers are not ported and refuse).
 */
async function commercialSyncToDescendants(env: Environment, commercial: number, id: number, fields: readonly string[]): Promise<void> {
  const def = env.reg.model(MODEL);
  const sync = await writeValues(new DbRec(env, def, commercial), fields);
  // `self.child_ids` (active children, child_ids domain active=True) without companies
  const children = await new ModelImpl(env, def).search(D.and([D.cond("parent_id", "=", id), D.cond("is_company", "=", false)]));
  const toSync: number[] = [];
  for (const child of children) {
    const values = await writeValues(new DbRec(env, def, child), fields);
    if (fields.some((f) => !cacheEqual(values[f] === false ? null : values[f], sync[f] === false ? null : sync[f]))) toSync.push(child);
    await commercialSyncToDescendants(env, commercial, child, fields);
  }
  if (!toSync.length) return;
  if ("additional_identifiers" in sync) {
    // :788-790 `_apply_synced_identifiers` (:759-781): without identifiers on the commercial entity nor on the
    // children, `merged` is `{}` like `existing` and nothing is written; any identifier refuses
    for (const child of toSync) if (truthy(await new DbRec(env, def, child).get("additional_identifiers"))) throw new NotPorted("commercial sync of additional_identifiers to children (_apply_synced_identifiers)");
    if (truthy(sync["additional_identifiers"])) throw new NotPorted("commercial sync of additional_identifiers to children (_apply_synced_identifiers)");
    delete sync["additional_identifiers"];
  }
  if ("vat" in sync) {
    for (const child of toSync) {
      const own = await new DbRec(env, def, child).get("additional_identifiers");
      if (own && typeof own === "object" && Object.keys(own).length) throw new NotPorted("commercial sync of vat to a contact with identifiers");
    }
  }
  await write(env, MODEL, toSync, sync);
}

/**
 * tools/partner_identifier_validation.py:42-58 `sg_uen_validate`: the UEN's stdnum.sg.uen form, or one of the SGNIC
 * SMP's Peppol prefixes (SG_PEPPOL_PREFIX_RE) around a UEN (SGUEN, SGUXN) or around anything (SGTST, SGGST, ..UID);
 * null where it raises.
 */
function sgUenValidate(v: string): string | null {
  const sg = VAT_MODULES["SG"]!;
  if (sg.isValid(v)) return sg.compact(v);
  const prefix = v.slice(0, 5).toUpperCase(), rest = v.slice(5);
  if (/^(SGUEN|SGUXN)$/.test(prefix)) return sg.isValid(rest) ? prefix + sg.compact(rest) : null;
  if (/^(SGTST|SGGST|[A-Z]{2}UID)$/.test(prefix) && rest) return prefix + rest;
  return null;
}

/**
 * base res_partner.py:1545-1586 `_validate_identifier(key, value, validation)`, inlined in the identifier cleaning,
 * deduction and checks of this file and in src/models/res_partner_erp_write.ts: a hook, and a module's override
 * (l10n_fr_pdp: the test identifiers of a test PDP accepted) refuses where it would run.
 */
export async function refuseIdentifierOverride(env: Environment): Promise<void> {
  if (await priv.res_partner._validate_identifier.overridden(env)) throw new NotPorted("partner identifiers with a module's _validate_identifier");
}

/** res_partner.py:1827 _clean_additional_identifiers (FR_SIRET's format error and SE_EN; other keys refuse). */
function cleanAdditionalIdentifiers(env: Environment, vals: Record<string, unknown>): void {
  const v = vals["additional_identifiers"];
  if (v === undefined || typeof v !== "object" || v === null || Array.isArray(v)) return;
  const cleaned: Record<string, string> = {};
  for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
    // normalize_identifier (partner_identifiers.py:1025): void placeholders are no value
    const value = typeof raw === "string" && !["", "/", "na", "NA", "N/A", "not applicable"].includes(raw) ? raw.trim() : null;
    if (!value) continue;
    // _validate_identifier(validation='error') (res_partner.py:1545-1585): stdnum.fr.siret.validate compacts
    // (clean ' .') and refuses non-digits with InvalidFormat -> ValidationError (validation_error_message, :1030)
    if (key === "FR_SIRET" && !/^\d+$/.test(value.replace(/[ .]/g, ""))) {
      if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated identifier error (${env.lang})`);
      throw new ValidationError(`Invalid identifier: ${value} (SIRET).\nExample: 33417522101010`);
    }
    // SE_EN: stdnum.se.orgnr.validate (compact: ' -.' removed and stripped; ten digits, Luhn); no identifier is
    // deduced from it (partner_identifiers.py:978-1024 `get_deduced_identifiers`)
    if (key === "SE_EN") {
      const compact = value.replace(/[ .\-]/g, "").trim();
      if (!/^\d{10}$/.test(compact) || luhnChecksum(compact) !== 0) {
        if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated identifier error (${env.lang})`);
        throw new ValidationError(`Invalid identifier: ${value} (Company ID).\nExample: 1234567897`);
      }
      cleaned[key] = compact;
      continue;
    }
    // AT_EN: stdnum.at.uid.validate (partner_identifiers.py:480-488), the compact value kept; no identifier is deduced
    // from it. An invalid one refuses (its ValidationError text is not ported)
    if (key === "AT_EN") {
      if (!VAT_MODULES["AT"]!.isValid(value)) throw new NotPorted("the ValidationError of an invalid AT_EN identifier");
      cleaned[key] = VAT_MODULES["AT"]!.compact(value);
      continue;
    }
    // SG_UEN: tools/partner_identifier_validation.py:42-58 `sg_uen_validate`, its normalized value kept; nothing is
    // deduced from it. An invalid one refuses (its ValidationError text is not ported)
    if (key === "SG_UEN") {
      const normalized = sgUenValidate(value);
      if (normalized === null) throw new NotPorted("the ValidationError of an invalid SG_UEN identifier");
      cleaned[key] = normalized;
      continue;
    }
    // BE_EN, DK_CVR: be_vat.validate, dk_cvr.validate (partner_identifiers.py:513, :570), the compact value kept;
    // nothing is deduced from them. An invalid one refuses (its ValidationError text is not ported)
    if (key === "BE_EN" || key === "DK_CVR") {
      const normalized = IDENTIFIER_VALIDATORS[key]!(value);
      if (normalized === null) throw new NotPorted(`the ValidationError of an invalid ${key} identifier`);
      cleaned[key] = normalized;
      continue;
    }
    throw new NotPorted(`additional identifiers validation of ${key}`);
  }
  vals["additional_identifiers"] = cleaned;
}

/** base res_partner.py:1403-1474 `_run_vat_checks` for the countries without a stdnum vat module nor a
 * check_vat_/format_vat_ method (the VAT is kept as given and valid), and France with validation=False
 * (stdnum.fr.tva.compact). The EU-prefix branches and the other countries are not ported. */
const NO_VAT_MODULE = new Set(("ae af ag ai am ao aq as aw ax az ba bb bd bf bh bi bj bl bm bn bo bq bs bt bv bw bz cc cd cf cg ci ck cm cu " +
  "cv cw cx dj dm eh er et fj fk fm ga gd ge gf gg gi gl gm gp gq gs gu gw gy hk hm hn ht im io iq ir je jm jo kg kh ki km kn kp kw ky kz la " +
  "lb lc li lk lr ls ly md mf mg mh ml mm mn mo mp mq mr ms mu mv mw my mz na nc ne nf ng ni np nr nu om pa pf pg pm pn pr ps pw qa re rw sb " +
  "sc sd sh sj sl sn so sr ss st sx sy sz tc td tf tg tj tk tl tm to tt tv tz ug um us va vc vg vi vu wf ws xk ye yt za zm zw").split(" "));
const EU_PREFIX = new Set("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE CH NO GB SM".split(" "));
/** stdnum.me.pib (Montenegro): compact strips spaces; 8 digits with a mod-11 check digit (weights 8..2). */
function mePibValid(n: string): boolean {
  if (n.length !== 8 || !/^\d+$/.test(n)) return false;
  const sum = [8, 7, 6, 5, 4, 3, 2].reduce((acc, w, i) => acc + w * Number(n[i]), 0);
  return n[7] === String((((-sum) % 11) + 11) % 11 % 10);
}

/** res_partner.py:1482-1514 `_build_vat_error_message`; `expected` is `_ref_vat[code]` (res_partner.py:60-140) when it has one. */
async function vatErrorMessage(env: Environment, code: string, wrongVat: string, partnerName: string, expected?: string): Promise<string> {
  if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated VAT error message (${env.lang})`);
  if (env.context["company_id"]) throw new NotPorted("VAT error message with company_id in the context");
  const company = (await env.cr.query<{ code: string | null; label: string | null }>(
    `SELECT c.code, c.vat_label->>'en_US' AS label FROM res_company co JOIN res_partner p ON p.id = co.partner_id
       LEFT JOIN res_country c ON c.id = p.country_id WHERE co.id = $1`, [await env.company()])).rows[0];
  const vatLabel = company?.code === code && company.label ? company.label : "VAT";
  const label = `partner${partnerName ? ` [${partnerName}]` : ""}`;
  const note = expected ? ` \nNote: the expected format is ${expected}` : "";
  return label.includes("False")
    ? `\nThe ${vatLabel} number [${wrongVat}] does not seem to be valid. ${note}`
    : `\nThe ${vatLabel} number [${wrongVat}] for ${label} does not seem to be valid. ${note}`;
}

/** stdnum 1.19 util.clean(number, deletechars).upper().strip() for ASCII input (the unicode dash/space folding of
 *  `_clean_chars` is not ported: non-ASCII input refuses). */
function stdnumClean(n: string, chars: string): string {
  if (/[^\x20-\x7e]/.test(n)) throw new NotPorted("stdnum clean of a non-ASCII number");
  return [...n].filter((c) => !chars.includes(c)).join("");
}

/**
 * res_partner.py:2072-2096 `check_vat_mx`: `_check_vat_mx_re` fullmatched (3-4 letters, Ñ ñ or &; an optional
 * separator; YYMMDD; an optional separator; 3 letters, digits, & Ñ ñ), and a real date (a year above 30 in the 1900s).
 */
export function checkVatMx(vat: string): boolean {
  const m = /^([A-Za-z\u00d1\u00f1&]{3,4})[ \-_]?([0-9]{2})([01][0-9])([0-3][0-9])[ \-_]?([A-Za-z0-9&\u00d1\u00f1]{3})$/.exec(vat);
  if (!m) return false;
  let year = Number(m[2]);
  year = year > 30 ? 1900 + year : 2000 + year;
  const month = Number(m[3]), day = Number(m[4]);
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** res_partner.py:2195-2196 `check_vat_tr`: stdnum.tr.tckimlik.is_valid or stdnum.tr.vkn.is_valid (stdnum 1.19). */
export function checkVatTr(vat: string): boolean {
  const n = vat.trim();
  if (!/^[0-9]+$/.test(n)) return false;
  // tckimlik: 11 digits, not starting with 0, two check digits
  if (n.length === 11 && n[0] !== "0") {
    const d = [...n].map(Number);
    const check1 = (((10 - d.slice(0, 9).reduce((s, x, i) => s + (i % 2 === 0 ? 3 : 1) * x, 0)) % 10) + 10) % 10;
    const check2 = (check1 + d.slice(0, 9).reduce((s, x) => s + x, 0)) % 10;
    if (`${check1}${check2}` === n.slice(-2)) return true;
  }
  // vkn: 10 digits, one check digit
  if (n.length === 10) {
    let s = 0;
    [...n.slice(0, 9)].reverse().forEach((ch, idx) => {
      const i = idx + 1;
      const c1 = (Number(ch) + i) % 10;
      if (c1) s += (c1 * 2 ** i) % 9 || 9;
    });
    if (String((10 - (s % 10)) % 10) === n[9]) return true;
  }
  return false;
}

/** stdnum.se.vat.compact (stdnum 1.19 se/vat.py). */
function seVatCompact(n: string): string {
  const c = stdnumClean(n, " -.").toUpperCase().trim();
  return c.startsWith("SE") ? c.slice(2) : c;
}

/** stdnum.luhn.is_valid over the digits. */
function luhnValid(n: string): boolean {
  let sum = 0;
  for (let i = 0; i < n.length; i++) {
    let d = Number(n[n.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** stdnum.se.vat.is_valid: 12 digits ending in 01, the first ten a Luhn-valid organisation number (se/orgnr.py). */
function seVatValid(n: string): boolean {
  const c = seVatCompact(n);
  if (!/^[0-9]+$/.test(c) || c.slice(-2) !== "01") return false;
  const org = c.slice(0, -2).trim(); // orgnr.compact: clean(' -.').strip()
  return /^[0-9]+$/.test(org) && org.length === 10 && luhnValid(org);
}

/** tools/business_data.py:34-73 `split_vat(vat)` without a default country, for the prefixes ported here. */
function splitVat(vat: string): [string, string] {
  if (/[^\x20-\x7e]/.test(vat)) throw new NotPorted("split_vat of a non-ASCII VAT");
  const cc = /^[A-Za-z]{2}/.test(vat) ? vat.slice(0, 2).toUpperCase() : "";
  if (cc === "SE") return [cc, seVatCompact(vat)]; // get_cc_module('SE', 'vat').compact
  if (VAT_MODULES[cc]) return [cc, VAT_MODULES[cc]!.compact(vat)];
  if (cc && !["CH", "RO", "RS", "SM", "US"].includes(cc)) throw new NotPorted(`split_vat with the stdnum vat module of ${cc}`);
  let n = stdnumClean(vat, " .-").toUpperCase();
  if (cc) n = n.startsWith(cc) ? n.slice(cc.length) : n;
  return [cc, n];
}

/** res_partner.py:1403-1474 `_run_vat_checks` for a Swedish partner or a VAT with the SE prefix. */
async function runVatChecksSe(env: Environment, code: string, vat: string, validation: false | "error", partnerName: string): Promise<string> {
  const [prefix, number] = splitVat(vat);
  if (prefix === "EU") throw new NotPorted("_run_vat_checks of an EU-prefixed VAT");
  // :1435-1446: the EU_PREFIX country group (res_country_group code), the prefix's country (EL -> GR, XI -> GB)
  const prefixCountry = prefix === "EL" ? "GR" : prefix === "XI" ? "GB" : prefix;
  const group = (await env.cr.query<{ code: string }>(
    `SELECT c.code FROM res_country_group g JOIN res_country_res_country_group_rel r ON r.res_country_group_id = g.id
       JOIN res_country c ON c.id = r.res_country_id WHERE g.code = 'EU_PREFIX'`)).rows.map((r) => r.code);
  let prefixed = "";
  let digits = vat;
  if (group.includes(prefixCountry)) {
    const own = (await env.cr.query(
      `SELECT 1 FROM res_country c JOIN res_country_res_country_group_rel r ON r.res_country_id = c.id
         JOIN res_country_group g ON g.id = r.res_country_group_id WHERE c.code = $1 AND g.code = 'EU_PREFIX'`, [code])).rows.length > 0;
    if (own && prefix) { digits = number; prefixed = prefix; } else return doEuCheck(env, code, vat, prefix, number, validation, partnerName);
  }
  const toCheck = prefixed || code;
  if (toCheck !== "SE") throw new NotPorted(`_run_vat_checks for ${toCheck}`);
  digits = seVatCompact(digits); // _format_vat_number: no format_vat_se, stdnum.se.vat.compact
  const out = prefixed + digits;
  if (validation === false || env.context["no_vat_validation"]) return out;
  const doublePrefix = Boolean(prefixed) && out.startsWith(prefixed + prefixed);
  if (!seVatValid(digits) || doublePrefix) throw new ValidationError(await vatErrorMessage(env, toCheck, out, partnerName, "SE123456789701"));
  return out;
}

/** stdnum 1.19 ad/nrt.py `validate`: 8 characters, a letter of ACDEFGLOPU, six digits, a letter (F up to 699999, A and L
 *  between 700000 and 799999); the number is the compact one. */
function adNrtValid(n: string): boolean {
  if (n.length !== 8 || !/^[A-Za-z]$/.test(n[0]!) || !/^[A-Za-z]$/.test(n[7]!) || !/^[0-9]{6}$/.test(n.slice(1, 7))) return false;
  const mid = n.slice(1, 7);
  if (!"ACDEFGLOPU".includes(n[0]!)) return false;
  if (n[0] === "F" && mid > "699999") return false;
  if ("AL".includes(n[0]!) && !("699999" < mid && mid < "800000")) return false;
  return true;
}

/**
 * res_partner.py:1534-1542 `_format_vat_number` and :1476-1480 `_check_vat_number` of a country whose check the port
 * has, for the do_eu_check path (the whole VAT, its prefix of another country included): a country without a stdnum
 * vat module nor a `format_vat_`/`check_vat_` method keeps the VAT and accepts it; Andorra is stdnum's ad.nrt; the
 * stdnum modules of src/models/vat_stdnum.ts. null: not ported.
 */
function otherCountryVat(code: string, vat: string): { formatted: string; valid: boolean } | null {
  const lower = code.toLowerCase();
  if (NO_VAT_MODULE.has(lower)) return { formatted: vat, valid: true };
  if (lower === "ad") {
    const c = stdnumClean(vat, " -.").toUpperCase().trim();
    return { formatted: c, valid: adNrtValid(c) };
  }
  const mod = VAT_MODULES[code];
  if (mod) {
    const c = mod.compact(vat);
    return { formatted: c, valid: mod.isValid(c) };
  }
  return null;
}

/**
 * res_partner.py:1435-1474 `_run_vat_checks` with `do_eu_check`: the VAT has the prefix of a country of the EU_PREFIX
 * group and the partner's country is not of the group. The VAT is formatted and checked for the partner's country
 * (`code_to_check = country.code`, no prefix kept); a valid one is returned as formatted, an invalid one is checked
 * again for the prefix's country (`res.country` searched by code, the VAT `vat_prefix + vat_number`), whose
 * ValidationError becomes the partner's country's message with the European example (:1462-1468).
 */
async function doEuCheck(env: Environment, code: string, vat: string, vatPrefix: string, vatNumber: string, validation: false | "error", partnerName: string): Promise<string> {
  const other = otherCountryVat(code, vat);
  if (!other) throw new NotPorted(`_run_vat_checks for ${code} with another country's EU prefix (do_eu_check)`);
  if (validation === false || env.context["no_vat_validation"]) return other.formatted;
  if (other.valid) return other.formatted;
  // EU_EXTRA_VAT_CODES_INV (tools/business_data.py): EL is Greece, XI Northern Ireland (GB)
  const prefixCountry = vatPrefix === "EL" ? "GR" : vatPrefix === "XI" ? "GB" : vatPrefix;
  const exists = (await env.cr.query("SELECT 1 FROM res_country WHERE code = $1 LIMIT 1", [prefixCountry])).rows.length > 0;
  if (!exists) return vatPrefix + vatNumber; // `if not country`: returned as it is
  const european = prefixCountry === "SE" ? "SE123456789701" : REF_VAT[prefixCountry];
  if (european === undefined) throw new NotPorted(`_ref_vat of ${prefixCountry}`);
  try {
    return await runVatChecks(env, prefixCountry, vatPrefix + vatNumber, validation, partnerName);
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    const msg = await vatErrorMessage(env, code, other.formatted, partnerName, REF_VAT[code]);
    throw new ValidationError(`${msg}\n\nIf you are trying to input a European number, this is the expected format: ${european}`);
  }
}

/**
 * res_partner.py:1403-1474 `_run_vat_checks` where the country checked is one of src/models/vat_stdnum.ts (IE, NL,
 * AT, LT): the VAT of a partner of that country with or without its prefix (a prefix of the EU_PREFIX group on a
 * partner of a country of the group is kept: `prefixed_country`); `_format_vat_number` is stdnum's `compact` (no
 * `format_vat_<cc>` for these) and `_check_vat_number` its `is_valid` (check_vat_ie is stdnum's). null: another country
 * is checked. A number valid only through `do_eu_check` (another country's prefix) refuses.
 */
async function runVatChecksStd(env: Environment, code: string, vat: string, validation: false | "error", partnerName: string): Promise<string | null> {
  const [vatPrefix, vatNumber] = splitVat(vat);
  if (vatPrefix === "EU") throw new NotPorted("_run_vat_checks of an EU-prefixed VAT");
  const countryCode = vatPrefix === "EL" ? "GR" : vatPrefix === "XI" ? "GB" : vatPrefix;
  const group = (await env.cr.query<{ code: string }>(
    `SELECT c.code FROM res_country_group g JOIN res_country_res_country_group_rel r ON r.res_country_group_id = g.id
       JOIN res_country c ON c.id = r.res_country_id WHERE g.code = 'EU_PREFIX' ORDER BY g.id`)).rows.map((r) => r.code);
  let doEu = false;
  let prefixed = "";
  let number = vat;
  if (group.includes(countryCode)) {
    const own = (await env.cr.query(
      `SELECT 1 FROM res_country c JOIN res_country_res_country_group_rel r ON r.res_country_id = c.id
         JOIN res_country_group g ON g.id = r.res_country_group_id WHERE c.code = $1 AND g.code = 'EU_PREFIX'`, [code])).rows.length > 0;
    if (own && vatPrefix) { number = vatNumber; prefixed = vatPrefix; } else doEu = true;
  }
  if (doEu) return doEuCheck(env, code, vat, vatPrefix, vatNumber, validation, partnerName);
  const toCheck = prefixed || code;
  const mod = VAT_MODULES[toCheck];
  if (!mod) return null;
  number = mod.compact(number);
  const out = prefixed + number; // GR -> EL: no Greek module here
  if (validation === false || env.context["no_vat_validation"]) return out;
  const doublePrefix = Boolean(prefixed) && out.startsWith(prefixed + prefixed);
  if (!mod.isValid(number) || doublePrefix) {
    throw new ValidationError(await vatErrorMessage(env, toCheck, out, partnerName, REF_VAT[toCheck]));
  }
  return out;
}

export async function runVatChecks(env: Environment, code: string | null, vat: string, validation: false | "error", partnerName = ""): Promise<string> {
  if (!code || !vat) return vat;
  if (vat.length <= 2) throw new NotPorted("_run_vat_checks of a 1-2 character VAT");
  const prefix = /^[A-Za-z]{2}/.test(vat) ? vat.slice(0, 2).toUpperCase() : "";
  const prefixCountry = prefix === "EL" ? "GR" : prefix === "XI" ? "GB" : prefix;
  if (code === "SE" || prefix === "SE") return runVatChecksSe(env, code, vat, validation, partnerName);
  if (VAT_MODULES[code] || VAT_MODULES[prefix]) {
    const std = await runVatChecksStd(env, code, vat, validation, partnerName);
    if (std !== null) return std;
  }
  if (prefix === "EU" || EU_PREFIX.has(prefixCountry)) throw new NotPorted("_run_vat_checks with an EU country prefix");
  const lower = code.toLowerCase();
  if (NO_VAT_MODULE.has(lower)) return vat;
  if (lower === "fr" && validation === false) {
    let n = vat.replace(/[ \-.]/g, "").toUpperCase().trim();
    if (n.startsWith("FR")) n = n.slice(2);
    return n;
  }
  if (lower === "tr") {
    // :1534-1542: stdnum.tr.vkn.compact (clean, strip); :2195-2196 check_vat_tr: a T.C. Kimlik or a VKN number
    const compact = stdnumClean(vat, "").trim();
    if (validation === false || env.context["no_vat_validation"]) return compact;
    if (!checkVatTr(compact)) throw new ValidationError(await vatErrorMessage(env, code, compact, partnerName, REF_VAT["TR"]));
    return compact;
  }
  if (lower === "mx") {
    // :1534-1542 `_format_vat_number`: stdnum.mx.rfc.compact (clean '-_ ', upper, strip); :1476-1480 check_vat_mx
    const compact = stdnumClean(vat, "-_ ").toUpperCase().trim();
    if (validation === false || env.context["no_vat_validation"]) return compact;
    if (!checkVatMx(compact)) throw new ValidationError(await vatErrorMessage(env, code, compact, partnerName, REF_VAT["MX"]));
    return compact;
  }
  if (lower === "me") {
    const compact = vat.replace(/ /g, "").trim();
    if (validation === false || env.context["no_vat_validation"]) return compact;
    if (!mePibValid(compact)) throw new ValidationError(await vatErrorMessage(env, code, compact, partnerName));
    return compact;
  }
  throw new NotPorted(`_run_vat_checks for ${code}`);
}

async function countryCode(env: Environment, country: unknown): Promise<string | null> {
  if (typeof country !== "number") return null;
  return (await env.cr.query<{ code: string }>("SELECT code FROM res_country WHERE id = $1", [country])).rows[0]?.code ?? null;
}

async function linkedUsers(env: Environment, ids: readonly number[], activeOnly: boolean): Promise<{ id: number; name: string }[]> {
  const rows = (await env.cr.query<{ id: number }>(`SELECT id FROM res_users WHERE partner_id = ANY($1::int[]) ${activeOnly ? "AND active" : ""} ORDER BY id`, [ids])).rows;
  const names = await env.sudo().model("res.users").displayName(rows.map((r) => r.id));
  return rows.map((r) => ({ id: r.id, name: names.get(r.id) ?? "" }));
}

/** res_partner.py:1056-1069 `_unlink_except_user`. */
async function unlinkExceptUser(env: Environment, ids: readonly number[]): Promise<void> {
  const users = await linkedUsers(env, ids, false);
  if (!users.length) return;
  if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated unlink error (${env.lang})`);
  const access = await env.model("res.users").accessDomain("write");
  const canWrite = access === null || access.kind !== "false";
  const names = users.map((u) => u.name).join(", ");
  if (canWrite) {
    throw await usersRedirect(env, users.map((u) => u.id), `You cannot delete contacts linked to an active user.\nYou should rather archive them after archiving their associated user.\n\nLinked active users : ${names}`);
  }
  throw new ValidationError(`You cannot delete contacts linked to an active user.\nAsk an administrator to archive their associated user first.\n\nLinked active users :\n${names}`);
}

/** res_partner.py:963-1040 write (base), the core of the partner's write. */
async function baseWrite(env: Environment, ids: readonly number[], vals: Record<string, unknown>,
  next: (env: Environment, ids: readonly number[], vals: Record<string, unknown>) => Promise<void>): Promise<void> {
    if (vals["additional_identifiers"] !== undefined) await refuseIdentifierOverride(env);
    cleanAdditionalIdentifiers(env, vals);
    // res_partner.py:993 `partner[fname] for fname in vals` reads every key first: an unknown one is a KeyError
    const unknown = Object.keys(vals).find((k) => !env.reg.model(MODEL).fields.has(k));
    // str(KeyError(key)) is the repr of the key: 'x_opus'
    if (unknown !== undefined && ids.length) throw new OdooError("builtins.KeyError", pyStrRepr(unknown));
    if (vals["active"] === false) {
      const users = await linkedUsers(env, ids, true);
      if (users.length) {
        if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated archive error (${env.lang})`);
        const names = users.map((u) => u.name).join(", ");
        // res_partner.py:973-985: users.sudo(False).has_access('write') on the users
        let canWrite = true;
        try { await new ModelImpl(env.withUser(env.uid), env.reg.model("res.users")).checkAccess(users.map((u) => u.id), "write"); } catch { canWrite = false; }
        if (env.su) canWrite = true;
        if (canWrite) {
          throw await usersRedirect(env, users.map((u) => u.id), `You cannot archive contacts linked to an active user.\nYou first need to archive their associated user.\n\nLinked active users : ${names}`);
        }
        throw new ValidationError(`You cannot archive contacts linked to an active user.\nAsk an administrator to archive their associated user first.\n\nLinked active users :\n${names}`);
      }
    }
    if (typeof vals["website"] === "string" && vals["website"]) vals["website"] = cleanWebsite(vals["website"]); // res_partner.py:987
    // res_partner.py:988-999 read the records as the user (`partner.bank_ids`, `partner[fname]`) before BaseModel.write's
    // check_access('write') (models.py:3849): a contact the user may not read raises the 'read' AccessError
    if (!env.su && Object.keys(vals).length) await new ModelImpl(env, env.reg.model(MODEL)).checkAccess(ids, "read");
    if (vals["name"]) {
      const banks = (await env.cr.query("SELECT 1 FROM res_partner_bank b JOIN res_partner p ON p.id = b.partner_id WHERE b.partner_id = ANY($1::int[]) AND b.holder_name = p.name", [ids])).rows;
      if (banks.length) throw new NotPorted("bank holder name sync");
    }
    const pre = new Map<number, Record<string, unknown>>();
    for (const id of ids) pre.set(id, await valuesOf(env, id, Object.keys(vals).filter((k) => env.reg.model(MODEL).fields.has(k))));
    if ("company_id" in vals) {
      for (const id of ids) {
        if (vals["company_id"] && (await linkedUsers(env, [id], false)).length) throw new NotPorted("partner company change with users");
        const children = await new ModelImpl(env.sudo().withContext({ ...env.context, active_test: false }), env.reg.model(MODEL)).search(D.cond("parent_id", "=", id));
        if (children.length) await write(env, MODEL, children, { company_id: vals["company_id"] });
      }
    }
    await next(env, ids, vals);
    await refreshMovePartnerNames(env, ids, vals);
    await refreshTaskPartnerPhones(env, ids, vals);
    for (const id of ids) {
      const internal = (await env.cr.query<{ id: number }>("SELECT u.id FROM res_users u WHERE u.partner_id = $1 AND u.active AND NOT u.share AND u.id != $2", [id, env.uid])).rows;
      if (internal.length) await new ModelImpl(env, env.reg.model("res.users")).checkAccess(internal.map((r) => r.id), "write");
      const now = await valuesOf(env, id, Object.keys(pre.get(id)!));
      const updated: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(vals)) if (k in now && !cacheEqual(now[k], pre.get(id)![k])) updated[k] = v;
      if (Object.keys(updated).length) await fieldsSync(env, id, updated);
    }
}

/** The id of a many2one value as written (an id, false). */
function idOfValue(v: unknown): number | null {
  return typeof v === "number" && v ? v : null;
}

registerOverrides(MODEL, {
  // res_partner.py:284 default_get
  defaultGet: async (env, fields, values) => {
    if (fields.includes("parent_id") && values["parent_id"]) {
      const parent = values["parent_id"] as number;
      const company = (await new DbRec(env, env.reg.model(MODEL), parent).get("company_id")) as number | null;
      values["company_id"] = company ?? false;
    }
    if (fields.includes("type") && values["type"]) {
      const sel = env.reg.model(MODEL).fields.get("type")!.selection ?? [];
      if (!sel.some((s) => s.value === values["type"])) values["type"] = false;
    }
  },
  // res_partner.py:1028 create (with mail/models/res_partner.py:65 mail_create_nosubscribe context)
  create: async (env, valsList, next) => {
    // res_partner.py:1339-1356 `_check_import_consistency` compares each state's country with the country read from
    // that same state (search_read of the states), so it never replaces a value; only an unreadable state differs
    // (StopIteration in `next()`)
    if (env.context["import_file"]) {
      const states = valsList.map((v) => v["state_id"]).filter((x): x is number => typeof x === "number" && x > 0);
      if (states.length) {
        const readable = await env.model("res.country.state").search({ kind: "cond", path: "id", op: "in", value: states });
        if (states.some((s) => !readable.includes(s))) throw new NotPorted("partner import consistency check of an unreadable state");
      }
    }
    for (const vals of valsList) {
      if (vals["additional_identifiers"] !== undefined) await refuseIdentifierOverride(env);
      cleanAdditionalIdentifiers(env, vals);
      if (typeof vals["website"] === "string" && vals["website"]) vals["website"] = cleanWebsite(vals["website"]); // res_partner.py:1033
    }
    const parentNames = valsList.map((vals) => {
      const name = vals["parent_name"];
      if (vals["parent_additional_values"]) throw new NotPorted("_create_parent_from_name with additional values");
      delete vals["parent_name"];
      return name;
    });
    await erpBeforeCreate(env, valsList); // poc_erp modules' create (src/models/res_partner_erp_write.ts)
    // models.py create `_add_precomputed_values` before the INSERT: res_partner.py:509-514 `_compute_user_id`
    // (precompute) reads `partner.parent_id.user_id` of the contacts without a salesperson, so a parent that does not
    // exist raises MissingError before any row (or id) is made (measured on Odoo: the sequence does not move)
    const parents = [...new Set(valsList.filter((v) => !v["user_id"] && !v["is_company"] && typeof v["parent_id"] === "number" && v["parent_id"] > 0)
      .map((v) => v["parent_id"] as number))];
    if (parents.length) {
      const found = new Set((await env.cr.query<{ id: number }>("SELECT id FROM res_partner WHERE id = ANY($1::int[])", [parents])).rows.map((r) => r.id));
      const missing = parents.filter((id) => !found.has(id));
      if (missing.length) throw new MissingError(`Record does not exist or has been deleted.\n(Record: ${MODEL}(${missing.join(", ")},), User: ${env.uid})`);
    }
    const ids = await next(env, valsList);
    await erpAfterCreate(env, ids);
    // res_partner.py:1041-1046 with :1110-1129 `_create_parent_from_name` through the private hook (l10n_it_edi: the
    // contact's codice fiscale and PA index on the new company): the new company takes the contact's address
    for (let i = 0; i < ids.length; i++) {
      if (!parentNames[i] || valsList[i]!["parent_id"]) continue;
      const pid = ids[i]!, pname = parentNames[i];
      const parent = await priv.res_partner._create_parent_from_name.call(env, [pid], [pname, null], async (_e, hids, a) => {
        if (hids.length !== 1 || hids[0] !== pid || a[0] !== pname || (a[1] !== null && a[1] !== undefined && a[1] !== false)) {
          throw new NotPorted("_create_parent_from_name through a compiled super() with other arguments");
        }
        return new PrivateRecords(MODEL, [await createParentFromName(env, pid, String(pname))]);
      });
      const pids = parent instanceof PrivateRecords ? parent.ids : Array.isArray(parent) ? parent as number[] : null;
      if (pids?.length !== 1) throw new NotPorted(`_create_parent_from_name returning ${JSON.stringify(parent)}`);
    }    for (let i = 0; i < ids.length; i++) {
      if (!("lang" in valsList[i]!)) {
        // "due to ir.default, compute is not called as there is a default value": _compute_lang by hand
        const rec = new DbRec(env, env.reg.model(MODEL), ids[i]!);
        const parent = await rec.rel("parent_id");
        if (parent || !(await rec.get("lang"))) {
          const { recordCompute } = await import("../orm/recompute");
          const lang = await recordCompute(MODEL, "lang")!(env, rec);
          if (!cacheEqual(lang, await rec.get("lang"))) await write(env, MODEL, [ids[i]!], { lang: lang ?? false });
        }
      }
    }
    if (env.context["_partners_skip_fields_sync"]) return ids;
    for (let i = 0; i < ids.length; i++) {
      // _add_missing_default_values(vals) then _fields_sync
      const { addMissingDefaultValues } = await import("../orm/create");
      const vals = await addMissingDefaultValues(env, env.reg.model(MODEL), { ...valsList[i]! });
      await fieldsSync(env, ids[i]!, vals);
    }
    return ids;
  },
  // res_partner.py:963 write, inside account partner.py:840-864
  write: async (env, ids, vals, next) => {
    // account partner.py:841-849: the partners whose parent changes and that have journal items; a different VAT than
    // the new parent's is a UserError (its label is not ported: refused)
    let parentWrite: number[] = [];
    if ("parent_id" in vals && env.reg.models.has("account.move.line")) {
      const target = idOfValue(vals["parent_id"]);
      parentWrite = (await env.cr.query<{ id: number }>(
        `SELECT p.id FROM res_partner p WHERE p.id = ANY($1::int[]) AND p.parent_id IS DISTINCT FROM $2
            AND EXISTS (SELECT 1 FROM account_move_line l WHERE l.partner_id = p.id) ORDER BY p.id`, [[...ids], target])).rows.map((r) => r.id);
      if (parentWrite.length && target !== null) {
        const differs = (await env.cr.query(
          `SELECT 1 FROM res_partner p, res_partner q WHERE p.id = ANY($1::int[]) AND q.id = $2 AND COALESCE(p.vat, '') != COALESCE(q.vat, '') LIMIT 1`,
          [parentWrite, target])).rows.length;
        if (differs) throw new NotPorted("res.partner parent with another VAT on a partner with journal items (the vat_label UserError)");
      }
    }
    await baseWrite(env, ids, vals, next);
    // :853-863 after super: the journal items follow the new commercial partner, a note is logged: not ported (the
    // request rolls back; a recursive hierarchy raised its ValidationError in the write above)
    if (parentWrite.length) throw new NotPorted("res.partner parent change of a partner with journal items (their commercial partner)");
    // purchase res_partner.py:63-67 (above account's in the MRO): after super, the vendor pricelists of the partners
    // (searched as the user) take the new supplier currency
    if ("property_purchase_currency_id" in vals && env.reg.models.has("product.supplierinfo")) {
      const infos = await env.model("product.supplierinfo").search(D.cond("partner_id", "in", [...ids]));
      // an emptied currency fails on the required column (the request's IntegrityError, src/orm/sql_errors.ts)
      if (infos.length) await write(env, "product.supplierinfo", infos, { currency_id: vals["property_purchase_currency_id"] ?? false });
    }
  },
  // res_partner.py:1056 _unlink_except_user, then (by name, `_ondelete_methods` sorts them) account partner.py:877
  // _unlink_if_partner_in_account_move
  beforeUnlink: async (env, ids) => {
    await unlinkExceptUser(env, ids);
    if (env.reg.models.has("account.move")) {
      const used = (await env.cr.query("SELECT 1 FROM account_move WHERE partner_id = ANY($1::int[]) AND state IN ('draft', 'posted') LIMIT 1", [[...ids]])).rows.length;
      if (used) throw new UserError(translate(env, "The partner cannot be deleted because it is used in Accounting", "account"));
    }
  },
  inverse: {
    // res_partner.py:1391 _inverse_vat: _check_vat + _deduce_additional_identifiers_from_vat (no-ops without vat)
    vat: async (env, ids) => inverseVat(env, ids),
    country_id: async (env, ids) => inverseVat(env, ids),
    // base_address_extended/models/res_partner.py:24 _inverse_street_data
    street_name: async (env, ids) => inverseStreet(env, ids),
    street_number: async (env, ids) => inverseStreet(env, ids),
    street_number2: async (env, ids) => inverseStreet(env, ids),
  },
  constraints: [
    // res_partner.py:606 _check_parent_id (_has_cycle)
    { fields: ["parent_id"], fn: async (env, ids) => {
      for (const id of ids) {
        const seen = new Set<number>([id]);
        let cur = (await new DbRec(env, env.reg.model(MODEL), id).get("parent_id")) as number | null;
        while (cur) {
          if (seen.has(cur)) {
            if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated recursion error (${env.lang})`);
            throw new ValidationError("You cannot create recursive Partner hierarchies.");
          }
          seen.add(cur);
          cur = (await new DbRec(env, env.reg.model(MODEL), cur).get("parent_id")) as number | null;
        }
      }
    } },
    // res_partner.py:611 _check_partner_company
    { fields: ["company_id"], fn: async (env, ids) => {
      const rows = (await env.cr.query("SELECT 1 FROM res_partner p JOIN res_company c ON c.partner_id = p.id WHERE p.id = ANY($1::int[]) AND p.is_company AND p.company_id IS NOT NULL AND p.company_id != c.id", [ids])).rows;
      if (rows.length) throw new NotPorted("_check_partner_company error message");
      void env;
    } },
    // res_partner.py:687 _check_barcode_unicity (company-dependent barcode)
    { fields: ["barcode"], fn: async (env, ids) => {
      const values = await new ModelImpl(env, env.reg.model(MODEL)).values(ids, env.reg.model(MODEL).fields.get("barcode")!);
      for (const id of ids) {
        const barcode = values.get(id);
        if (!barcode) continue;
        if ((await env.model(MODEL).searchCount(D.cond("barcode", "=", barcode))) > 1) {
          if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated barcode error (${env.lang})`);
          throw new ValidationError("Another partner already has this barcode");
        }
      }
    } },
    // res_partner.py:1378 _check_additional_identifiers
    { fields: ["additional_identifiers"], fn: async (env, ids) => {
      await refuseIdentifierOverride(env);
      const rows = (await env.cr.query<{ v: unknown }>("SELECT additional_identifiers AS v FROM res_partner WHERE id = ANY($1::int[])", [ids])).rows;
      for (const r of rows) {
        if (!r.v || typeof r.v !== "object") continue;
        for (const [key, value] of Object.entries(r.v as Record<string, unknown>)) {
          // `_validate_identifier(key, value, validation='error')`: SE_EN as cleaned; other keys refuse
          if (key === "AT_EN") {
            // stdnum.at.uid.validate as cleaned
            if (value && !VAT_MODULES["AT"]!.isValid(String(value))) throw new NotPorted("_check_additional_identifiers: an invalid AT_EN stored");
            continue;
          }
          if (key === "SG_UEN") {
            // `sg_uen_validate` as cleaned (the void placeholders are no value: normalize_identifier)
            const v = typeof value === "string" ? value.trim() : "";
            if (v && !["/", "na", "NA", "N/A", "not applicable"].includes(v) && sgUenValidate(v) === null) throw new NotPorted("_check_additional_identifiers: an invalid SG_UEN stored");
            continue;
          }
          if (key === "BE_EN" || key === "DK_CVR") {
            // be_vat.validate, dk_cvr.validate as cleaned (the void placeholders are no value)
            const v = typeof value === "string" ? value.trim() : "";
            if (v && !["/", "na", "NA", "N/A", "not applicable"].includes(v) && IDENTIFIER_VALIDATORS[key]!(v) === null) throw new NotPorted(`_check_additional_identifiers: an invalid ${key} stored`);
            continue;
          }
          if (key !== "SE_EN") throw new NotPorted(`_check_additional_identifiers of ${key}`);
          const compact = String(value ?? "").replace(/[ .\-]/g, "").trim();
          if (!compact) continue;
          if (!/^\d{10}$/.test(compact) || luhnChecksum(compact) !== 0) throw new NotPorted("_check_additional_identifiers: an invalid SE_EN stored");
        }
      }
    } },
  ],
  // res_partner.py:1187 name_create: "Name <email>" parsing
  nameCreate: async (env, name) => {
    let ctx = env.context;
    const dt = ctx["default_type"];
    if (dt && !(env.reg.model(MODEL).fields.get("type")!.selection ?? []).some((s) => s.value === dt)) {
      ctx = { ...ctx }; delete (ctx as Record<string, unknown>)["default_type"];
    }
    const e = env.withContext(ctx);
    // odoo/tools/mail.py:1111 parse_contact_from_email: text without '@' is the name
    // odoo/tools/mail.py:1111 parse_contact_from_email over email_split_tuples (getaddresses): the plain
    // "Name <email>", '"Name" <email>' and "email" forms; anything else with an '@' refuses
    let parsedName = name, email = "";
    if (name.includes("@")) {
      const angle = /^\s*(?:"([^"<>]*)"|([^"<>@,;]*?))\s*<([^<>\s@,;"]+@[^<>\s@,;"]+)>\s*$/.exec(name);
      const plain = /^\s*([^<>\s@,;"()]+@[^<>\s@,;"()]+)\s*$/.exec(name);
      if (angle) { parsedName = (angle[1] ?? angle[2] ?? "").trim(); email = angle[3]!; }
      else if (plain) { parsedName = ""; email = plain[1]!; }
      else throw new NotPorted("name_create with an email address (parse_contact_from_email)");
      email = emailNormalize(email) ?? email;
    } else if (!name.trim()) parsedName = "";
    if (e.context["force_email"] && !email) {
      if (e.lang && e.lang !== "en_US") throw new NotPorted(`translated force_email error (${e.lang})`);
      throw new ValidationError("Couldn't create contact without email address!");
    }
    const values: Record<string, unknown> = { name: parsedName || email };
    if (email) values["email"] = email;
    const [id] = await create(e, MODEL, [values]);
    return [id!, (await e.model(MODEL).displayName([id!])).get(id!) ?? ""];
  },
});

/**
 * res_partner.py:1799-1823 `_deduce_additional_identifiers_from_vat`: the identifiers derivable from the VAT of the
 * partner's country's TIN key (AT_VAT => AT_EN), kept when they differ from the stored ones and are valid
 * (`_validate_identifier`, :1545-1586: AT_EN by stdnum at.uid), written with mail_notrack. A deduced identifier whose
 * validator is not ported refuses.
 */
async function deduceIdentifiersFromVat(env: Environment, ids: readonly number[]): Promise<void> {
  await refuseIdentifierOverride(env);
  const validators: Record<string, (v: string) => boolean> = {
    AT_EN: (v) => VAT_MODULES["AT"]!.isValid(v),
    // partner_identifiers.py:513, :570: be_vat.validate, dk_cvr.validate (src/models/identifier_validators.ts)
    BE_EN: (v) => IDENTIFIER_VALIDATORS["BE_EN"]!(v) !== null,
    DK_CVR: (v) => IDENTIFIER_VALIDATORS["DK_CVR"]!(v) !== null,
    // tools/partner_identifier_validation.py:42-58 `sg_uen_validate`: a UEN, or one of the SGNIC SMP's Peppol prefixes
    // (SG_PEPPOL_PREFIX_RE) around a UEN (SGUEN, SGUXN) or around anything (SGTST, SGGST, ..UID)
    SG_UEN: (v) => sgUenValidate(v) !== null,
  };
  for (const id of ids) {
    const rec = new DbRec(env, env.reg.model(MODEL), id);
    const vat = await str(rec, "vat");
    const country = await countryCode(env, await rec.get("country_id"));
    if (!vat || !country) continue;
    const key = Object.entries(TIN_METADATA).find(([, m]) => Array.isArray(m["countries"]) && (m["countries"] as readonly unknown[]).includes(country))?.[0];
    if (!key) continue;
    const deduced = deducedIdentifiers(key, vat);
    if (!Object.keys(deduced).length) continue;
    const stored = await rec.get("additional_identifiers");
    const identifiers = typeof stored === "object" && stored !== null && !Array.isArray(stored) ? stored as Record<string, unknown> : {};
    const update: Record<string, string> = {};
    for (const [k, v] of Object.entries(deduced)) {
      if (identifiers[k] === v) continue;
      const valid = validators[k];
      if (!valid) throw new NotPorted(`_deduce_additional_identifiers_from_vat: the validation of ${k}`);
      const value = v.trim(); // normalize_identifier (partner_identifiers.py:1025-1027)
      if (!value || env.context["no_vat_validation"] || valid(value)) update[k] = v;
    }
    if (!Object.keys(update).length) continue;
    await write(env.withContext({ ...env.context, mail_notrack: true }), MODEL, [id], { additional_identifiers: { ...identifiers, ...update } });
  }
}

async function inverseVat(env: Environment, ids: readonly number[]): Promise<void> {
  await checkVat(env, ids);
  // res_partner.py:1391-1393 `_inverse_vat`: `_check_vat()` then `_deduce_additional_identifiers_from_vat()`
  await deduceIdentifiersFromVat(env, ids);
}

async function checkVat(env: Environment, ids: readonly number[]): Promise<void> {
  for (const id of ids) {
    const rec = new DbRec(env, env.reg.model(MODEL), id);
    const vat = await str(rec, "vat");
    if (!vat) continue;
    // res_partner.py:1395-1400 `_check_vat(validation='error')` on the commercial partner's country
    const commercial = await rec.rel("commercial_partner_id");
    const country = commercial ? await commercial.get("country_id") : null;
    const code = await countryCode(env, country);
    if (code === null) continue;
    const checked = await runVatChecks(env, code, vat, "error", (await str(rec, "name")) ?? "");
    if (checked !== vat) await write(env, MODEL, [id], { vat: checked });
  }
}

async function inverseStreet(env: Environment, ids: readonly number[]): Promise<void> {
  for (const id of ids) {
    const rec = new DbRec(env, env.reg.model(MODEL), id);
    let street = `${(await str(rec, "street_name")) ?? ""} ${(await str(rec, "street_number")) ?? ""}`.trim();
    const n2 = await str(rec, "street_number2");
    if (n2) street = `${street} - ${n2}`;
    if (street !== ((await str(rec, "street")) ?? "")) await write(env, MODEL, [id], { street });
  }
}

// partner_autocomplete/models/res_partner.py:88 autocomplete_by_field -> _request_partner_autocomplete: the IAP
// endpoint is unreachable from the deployment (as from the reference oracle), RequestException -> [] (:47, :112)
registerMethod(MODEL, "autocomplete_by_field", async (_env, _ids, args) => {
  const [field] = args;
  if (typeof field !== "string") throw new NotPorted("autocomplete_by_field arguments");
  return [];
}, { apiModel: true });

/**
 * `RedirectWarning(msg, users._action_show(), _('Go to users'))` (res_partner.py:982, :1066; res_users.py:1235
 * `_action_show`): the JSON-RPC message is `exception_to_unicode` (odoo/loglevels.py:10), the arguments joined
 * with newlines in their Python `str()` form.
 */
async function usersRedirect(env: Environment, userIds: readonly number[], message: string): Promise<OdooError> {
  const viewId = await env.reg.xmlid(env.cr, "base.view_users_form");
  if (viewId === null) throw new NotPorted("base.view_users_form missing");
  const action = { type: "ir.actions.act_window", res_model: "res.users", context: { create: false }, name: "Users", view_mode: "form",
    views: [[viewId, "form"]], domain: [["id", "in", [...userIds]]] };
  const pyAction = `{'type': 'ir.actions.act_window', 'res_model': 'res.users', 'context': {'create': False}, 'name': 'Users', 'view_mode': 'form', 'views': [[${viewId}, 'form']], 'domain': [('id', 'in', [${userIds.join(", ")}])]}`;
  return new OdooError("odoo.exceptions.RedirectWarning", `${message}\n${pyAction}\nGo to users\nNone`, [message, action, "Go to users", null]);
}

/**
 * account_move.py:1995-2004 `_compute_invoice_partner_display_info` (stored, depends partner_id.display_name; the
 * partner's display name depends on complete_name, email, vat, additional_identifiers, state_id, country_id,
 * res_partner.py:1146): Odoo recomputes it on every move of the written partner at flush and writes the column with
 * write_date/write_uid even when the name stays the same (measured in an Odoo shell: 21 moves of partner 10 after an
 * email change, gcrawl G208/G217).
 */
const DISPLAY_NAME_DEPS = ["name", "email", "vat", "additional_identifiers", "state_id", "country_id", "parent_id", "is_company", "type", "company_name"];
async function refreshMovePartnerNames(env: Environment, ids: readonly number[], vals: Record<string, unknown>): Promise<void> {
  if (!ids.length || !DISPLAY_NAME_DEPS.some((f) => f in vals) || !env.reg.models.has("account.move")) return;
  if (["name", "parent_id", "is_company", "type", "company_name"].some((f) => f in vals)) {
    const childMoves = (await env.cr.query(
      "SELECT 1 FROM account_move m JOIN res_partner c ON c.id = m.partner_id WHERE c.parent_id = ANY($1::int[]) LIMIT 1", [[...ids]])).rows.length;
    if (childMoves) throw new NotPorted("invoice_partner_display_name of the moves of child contacts (complete_name)");
  }
  const moves = (await env.cr.query<{ id: number; partner_id: number }>(
    "SELECT id, partner_id FROM account_move WHERE partner_id = ANY($1::int[]) ORDER BY id", [[...ids]])).rows;
  if (!moves.length) return;
  const names = await env.sudo().model("res.partner").displayName([...new Set(moves.map((m) => m.partner_id))]);
  for (const m of moves) {
    await env.cr.query(
      "UPDATE account_move SET invoice_partner_display_name = $2, write_uid = $3, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1",
      [m.id, names.get(m.partner_id) ?? null, env.uid]);
  }
}

/** project_task.py:680-683 `_compute_partner_phone` (stored, depends partner_id.phone): recomputed on the partner's tasks. */
async function refreshTaskPartnerPhones(env: Environment, ids: readonly number[], vals: Record<string, unknown>): Promise<void> {
  if (!ids.length || !("phone" in vals) || !env.reg.models.has("project.task")) return;
  await env.cr.query(
    `UPDATE project_task t SET partner_phone = p.phone, write_uid = $2, write_date = now() AT TIME ZONE 'UTC'
       FROM res_partner p WHERE p.id = t.partner_id AND t.partner_id = ANY($1::int[])`, [[...ids], env.uid]);
}

/**
 * res_partner.py:1072-1108 `_load_records_create` (load() and the import): the plain create without `_fields_sync`,
 * then per (commercial partner, address parent) group the commercial fields of the commercial partner and the parent's
 * set address fields written on the children (sudo), then `_children_sync(vals)` and `_handle_first_contact_creation`
 * (:915-927) per partner, in the order of the rows.
 */
registerLoadRecordsCreate(MODEL, async (env, valsList) => {
  const def = env.reg.model(MODEL);
  const ids = await create(env.withContext({ ...env.context, _partners_skip_fields_sync: true }), MODEL, valsList);
  const groups = new Map<string, { cp: number | null; add: number | null; children: number[] }>();
  for (let i = 0; i < ids.length; i++) {
    const rec = new DbRec(env, def, ids[i]!);
    const commercial = (await rec.get("commercial_partner_id")) as number | null;
    const cp = valsList[i]!["parent_id"] && commercial !== ids[i] ? commercial : null;
    const parent = (await rec.get("parent_id")) as number | null;
    const add = parent && (await rec.get("type")) === "contact" ? parent : null;
    const key = `${cp},${add}`;
    const g = groups.get(key) ?? { cp, add, children: [] };
    g.children.push(ids[i]!);
    groups.set(key, g);
  }
  for (const { cp, add, children } of groups.values()) {
    let toWrite: Record<string, unknown> = {};
    if (cp !== null) toWrite = await writeValues(new DbRec(env.sudo(), def, cp), commercialFields(env));
    if (add !== null) {
      const parent = new DbRec(env, def, add);
      for (const f of ADDRESS_FIELDS) {
        const v = await parent.get(f);
        if (v !== null && v !== false && v !== "") toWrite[f] = v;
      }
    }
    if (Object.keys(toWrite).length) await write(env.sudo(), MODEL, children, toWrite);
  }
  for (let i = 0; i < ids.length; i++) {
    await childrenSync(env, ids[i]!, valsList[i]!);
    // :915-927 `_handle_first_contact_creation`
    const rec = new DbRec(env, def, ids[i]!);
    const parentId = (await rec.get("parent_id")) as number | null;
    if (parentId === null) continue;
    const parent = new DbRec(env, def, parentId);
    const filled = async (r: DbRec): Promise<boolean> => {
      for (const f of ADDRESS_FIELDS) { const v = await r.get(f); if (v !== null && v !== false && v !== "") return true; }
      return false;
    };
    if (((await parent.get("is_company")) || !(await parent.get("parent_id"))) && (await filled(rec)) && !(await filled(parent))
      && (await env.sudo().model(MODEL).search(D.and([D.cond("parent_id", "=", parentId), D.cond("active", "=", true)]))).length === 1) {
      await updateAddress(env, [parentId], await valuesOf(env, ids[i]!, ADDRESS_FIELDS));
    }
  }
  return ids;
});

/** base res_partner.py:1110-1129 `_create_parent_from_name` (the hook's hand): the new company of a contact's parent name. */
async function createParentFromName(env: Environment, pid: number, name: string): Promise<number> {
  const fields = ["vat", "lang", "street", "street2", "zip", "city", "state_id", "country_id"];
  const [row] = await env.model(MODEL).read([pid], fields, "");
  const values: Record<string, unknown> = { name };
  for (const f of fields) values[f] = Array.isArray(row?.[f]) ? (row[f] as unknown[])[0] : row?.[f] ?? false;
  // :1131-1134 `_create_contact_parent_company(values)` through the private hook: a site's compiled override
  // (l10n_eu_account_vies: the contact's vies_valid on the new company) runs around base's `self.create(values)`
  const out = await priv.res_partner._create_contact_parent_company.call(env, [pid], [values], async (e, _ids, a) => {
    const [made] = await create(e, MODEL, [(a[0] ?? {}) as Record<string, unknown>]);
    return new PrivateRecords(MODEL, [made!]);
  });
  const made = out instanceof PrivateRecords ? out.ids : Array.isArray(out) ? out as number[] : null;
  if (made === null || made.length !== 1) throw new NotPorted(`_create_contact_parent_company returning ${JSON.stringify(out)}`);
  const company = made[0]!;
  await write(env, MODEL, [pid], { parent_id: company });
  return company;
}
