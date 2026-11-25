/**
 * Record versions (for new records in onchange) of the poc_erp res.partner computes of src/models/partner_erp.ts.
 * A new record has no database rows behind it: its one2many-based counters are those of an empty recordset
 * (0, `-1` on_time_rate, "No Meetings"), its record-dependent fields follow the values assigned in the form, and the
 * fields that only depend on the environment reuse the id-based compute (called with a placeholder id). A new record
 * with an origin keeps the origin's counters (they depend on other tables only).
 */
import { NotPorted } from "../errors";
import { hooksOf, registerHooks } from "../orm/hooks";
import { sql, type Sql, type Table } from "../orm/sql";
import { DbRec, NewRec, type Rec, registerRecordCompute } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { translate } from "./util";
import { fiscalCountryCodes, REF_VAT, suggestedEdiFormat } from "./partner_erp";

const MODEL = "res.partner";

/** The id-based compute of `field` for one id (0 stands for "no record": the compute must not read rows). */
async function viaHook(env: Environment, field: string, id: number): Promise<unknown> {
  const hook = hooksOf(MODEL).computed?.[field];
  if (!hook) throw new NotPorted(`res.partner.${field}: no compute`);
  return (await hook(env, [id])).get(id) ?? false;
}

/** Counters of related records: the origin's, else the empty recordset's value. */
function counter(field: string, empty: (env: Environment) => unknown) {
  return async (env: Environment, rec: Rec): Promise<unknown> => {
    if (rec instanceof NewRec && rec.origin !== null) return new DbRec(env, rec.def, rec.origin).get(field);
    if (rec.id !== null) return viaHook(env, field, rec.id);
    return empty(env);
  };
}

/** Fields that only depend on the environment (company settings, selections, reports). */
function envOnly(field: string) {
  return async (env: Environment, rec: Rec): Promise<unknown> => viaHook(env, field, rec.id ?? rec.origin ?? 0);
}

async function str(rec: Rec, name: string): Promise<string | null> {
  const v = await rec.get(name);
  return typeof v === "string" && v !== "" ? v : null;
}

registerRecordCompute(MODEL, {
  ...Object.fromEntries(["opportunity_count", "sale_order_count", "purchase_order_count", "supplier_invoice_count", "task_count",
    "payment_token_count", "bank_account_count", "meeting_count"].map((f) => [f, counter(f, () => 0)])),
  total_invoiced: counter("total_invoiced", () => 0),
  credit: counter("credit", () => 0),
  debit: counter("debit", () => 0),
  days_sales_outstanding: counter("days_sales_outstanding", () => 0),
  // purchase_stock res_partner.py:40-73: no purchase lines -> -1
  on_time_rate: counter("on_time_rate", () => -1),
  // calendar res_partner.py:29-44: no meetings
  meeting_display_label: counter("meeting_display_label", (env) => translate(env, "No Meetings")),
  meeting_next_date: counter("meeting_next_date", () => null),
  ...Object.fromEntries(["available_peppol_sending_methods", "display_invoice_edi_format", "show_credit_limit",
    "available_invoice_template_pdf_report_ids", "display_invoice_template_pdf_report_id"].map((f) => [f, envOnly(f)])),
  // account partner.py:461-470 _compute_currency: the company's currency, else env.company's
  currency_id: async (env, rec) => {
    const company = await rec.rel("company_id");
    if (company) return company.get("currency_id");
    const row = (await env.cr.query<{ currency_id: number }>("SELECT currency_id FROM res_company WHERE id = $1", [await env.company()])).rows[0];
    return row?.currency_id ?? null;
  },
  // account partner.py:676-679
  global_location_number: async (_env, rec) => {
    const v = await rec.get("additional_identifiers");
    const gln = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>)["EAN_GLN"] : undefined;
    return gln || null;
  },
  // account partner.py:1194-1201: the example for the country (computed by the id compute from a country id)
  partner_vat_placeholder: async (env, rec) => {
    const country = await rec.rel("country_id");
    if (!country) return translate(env, "", "account");
    const code = ((await str(country, "code")) ?? "").toLowerCase();
    return translate(env, REF_VAT[code] ?? "", "account");
  },
  // account partner.py:731-736 use_partner_credit_limit: credit_limit differs from the company-dependent fallback
  use_partner_credit_limit: async (env, rec) => {
    const fallback = (await env.cr.query<{ json_value: string | null }>(
      `SELECT d.json_value FROM ir_default d JOIN ir_model_fields f ON f.id = d.field_id WHERE f.model = 'res.partner'
        AND f.name = 'credit_limit' AND d.user_id IS NULL AND (d.company_id IS NULL OR d.company_id = $1) AND d.condition IS NULL
        ORDER BY d.company_id NULLS LAST LIMIT 1`, [await env.company()])).rows[0]?.json_value;
    const limit = fallback ? Number(JSON.parse(fallback)) : 0;
    const v = await rec.get("credit_limit");
    return (typeof v === "number" ? v : 0) !== limit;
  },
  // account partner.py:713-719: the commercial partner's stored format, else its suggested one (a new record is its own
  // commercial partner)
  invoice_edi_format: async (env, rec) => {
    const commercial = await rec.rel("commercial_partner_id");
    if (!commercial) return null;
    const store = await str(commercial, "invoice_edi_format_store");
    if (store === "none") return null;
    if (store) return store;
    const id = typeof commercial.id === "number" ? commercial.id : null;
    return (await suggestedEdiFormat(env, id, id === null ? [commercial] : undefined)) || null;
  },
  // account_peppol res_partner.py:61-68
  available_peppol_edi_formats: async (env, rec) => {
    if ((await rec.get("invoice_sending_method")) === "peppol") throw new NotPorted("peppol edi formats (_get_peppol_formats)");
    const sel = env.reg.model(MODEL).fields.get("invoice_edi_format")?.selection;
    if (!sel) throw new NotPorted("dynamic invoice_edi_format selection");
    return sel.map((s) => s.value);
  },
  // account_edi_ubl_cii res_partner.py:177-184 with account_peppol :70-77: the id compute reads routing_scheme only
  // to keep a deprecated scheme the record already uses
  available_routing_schemes: async (env, rec) => {
    const scheme = await str(rec, "routing_scheme");
    if (scheme !== null && ["0037", "0213", "9955", "0193"].includes(scheme)) throw new NotPorted("deprecated routing scheme on a new record");
    return viaHook(env, "available_routing_schemes", 0);
  },
  // account_peppol res_partner.py:79-86
  peppol_response_support: async (_env, rec) => {
    if ((await rec.get("peppol_verification_state")) === "valid" && (await rec.get("peppol_supported_documents"))) {
      throw new NotPorted("peppol response support of verified partners");
    }
    return false;
  },
  // account partner.py:361-368: the record's company (else env.companies) and its country
  fiscal_country_codes: async (env, rec) => {
    const company = await rec.get("company_id");
    const country = await rec.rel("country_id");
    return fiscalCountryCodes(env, typeof company === "number" ? company : null, country ? await str(country, "code") : null);
  },
  // sale res_partner.py: no pricelist in the database -> False (the id compute refuses otherwise)
  property_product_pricelist: envOnly("property_product_pricelist"),
});

// base res_partner.py:943-944 _compute_sql_has_vat (compute_sudo: the plain column)
registerHooks(MODEL, {
  computeSql: {
    has_vat: async (table: Table): Promise<Sql> => sql`(${await table.field("vat")} NOT IN ('/', 'na', 'NA', ''))`,
  },
});
