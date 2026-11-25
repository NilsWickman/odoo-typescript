/**
 * Python behaviour of the account.* models the API corpus reaches (odoo/addons/account/models/, poc_erp): non-stored
 * computes, callable selections and relation domains. Rows in worker/COMPUTED.md. Branches whose answer needs more
 * of Odoo than ported here raise NotPorted.
 */
import { pyTuple } from "../pyexpr/values";
import { qrMethodRows } from "./qr_method_rows";
import { NotPorted, UserError } from "../errors";
import { pyFloatRepr } from "../http/json";
import { registerMethod } from "../http/methods";
import { envFor } from "../web/common";
import { userHasGroup } from "../web/groups";
import { and, cond, iterConditions, or } from "../orm/domain";
import { userInfo } from "../orm/env";
import { ident, raw, runSql, sql, type Sql } from "../orm/sql";
import { hooksOf, registerHooks } from "../orm/hooks";
import { registerAliasMixinUnlink } from "../mail/alias_mixin";
import { registerOnchange, registerRecordCompute, type Rec } from "../orm/recompute";
import { isPyFloat } from "../orm/values";
import { rawReadGroup } from "../web/read_group";
import { registerPortTable } from "../orm/table_sql";
import type { Environment } from "../orm/types";
import { dbNow } from "../session/user";
import { registerActivityMixin } from "./crm_activity";
import RELATED_SELECTIONS from "./related_selections.json";
import { defineComputes, filteredAccess, registerAliasMixin } from "./tail_util";
import { todayInTz, translate, validTz } from "./util";
import * as priv from "../orm/dispatch_gen";

/** fields.Date.context_today (fields_temporal.py:141): today in the context tz, else the user's. */
export async function contextToday(env: Environment): Promise<string> {
  const tz = typeof env.context.tz === "string" && env.context.tz ? env.context.tz : (await userInfo(env)).tz;
  return todayInTz(await dbNow(env.cr), validTz(tz) ?? "UTC");
}

function days(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
}

async function companyDependentBool(env: Environment, model: string, field: string, id: number): Promise<boolean> {
  const rows = await env.model(model).read([id], [field], "");
  return Boolean(rows[0]?.[field]);
}

/**
 * account_move.py:2363-2459 `_compute_abnormal_warnings` (both fields): draft purchase documents with an amount get
 * the bell-curve check of the partner's 10th-30th last posted invoices. The warning texts (format_date,
 * currency.format) are not ported: a record whose check fires refuses.
 */
async function abnormalWarnings(env: Environment, rec: Rec, which: "amount" | "date"): Promise<unknown> {
  if (env.context["disable_abnormal_invoice_detection"]) return false;
  if (rec.id === null) return false; // `m.id` falsy for new records
  const moveType = await rec.get("move_type");
  const state = await rec.get("state");
  const amountTotal = Number(await rec.get("amount_total") ?? 0);
  if (!(moveType === "in_invoice" || moveType === "in_refund") || state !== "draft" || !amountTotal) return false;
  const partner = await rec.rel("partner_id");
  const ignoreDate = partner ? await companyDependentBool(env, "res.partner", "ignore_abnormal_invoice_date", partner.id!) : false;
  const ignoreAmount = partner ? await companyDependentBool(env, "res.partner", "ignore_abnormal_invoice_amount", partner.id!) : false;
  if (ignoreDate && ignoreAmount) return false;
  const today = await contextToday(env);
  const rows = (await env.cr.query<{ last_invoice_date: string; date_diff_mean: string | null; date_diff_deviation: string | null; amount_mean: string | null; amount_deviation: string | null }>(`
    WITH previous_invoices AS (
          SELECT this.id, other.invoice_date, other.amount_total,
                 LAG(other.invoice_date) OVER invoice - other.invoice_date AS date_diff
            FROM account_move this
            JOIN account_move other USING (partner_id, move_type, company_id, currency_id)
           WHERE other.state = 'posted'
             AND other.invoice_date <= COALESCE(this.invoice_date, this.date, $1::date)
             AND this.id = ANY($2::int[])
             AND this.id != other.id
          WINDOW invoice AS (PARTITION BY this.id ORDER BY other.invoice_date DESC)
    ), stats AS (
          SELECT id, MAX(invoice_date) OVER invoice AS last_invoice_date, AVG(date_diff) OVER invoice AS date_diff_mean,
                 STDDEV_SAMP(date_diff) OVER invoice AS date_diff_deviation, AVG(amount_total) OVER invoice AS amount_mean,
                 STDDEV_SAMP(amount_total) OVER invoice AS amount_deviation, ROW_NUMBER() OVER invoice AS row_number
            FROM previous_invoices
          WINDOW invoice AS (PARTITION BY id ORDER BY invoice_date DESC)
    )
    SELECT last_invoice_date::text, date_diff_mean::text, date_diff_deviation::text, amount_mean::text, amount_deviation::text
      FROM stats WHERE row_number BETWEEN 10 AND 30 ORDER BY row_number ASC`, [today, [rec.id]])).rows;
  const invoiceDate = (await rec.get("invoice_date") as string | false) || today;
  // `{invoice: vals for ...}`: the last row (highest row_number) wins; default (invoice_date, 0, 1e10, 0, 1e10)
  const last = rows[rows.length - 1];
  const lastDate = last ? last.last_invoice_date : invoiceDate;
  const num = (v: string | null | undefined, d: number): number => (v === null || v === undefined ? d : Number(v));
  if (last && (last.date_diff_mean === null || last.date_diff_deviation === null || last.amount_deviation === null)) {
    throw new NotPorted("abnormal invoice warnings with NULL statistics (Decimal/None arithmetic)");
  }
  let dateMean = num(last?.date_diff_mean, 0), dateDev = num(last?.date_diff_deviation, 10000000000);
  const amountMean = num(last?.amount_mean, 0), amountDev = num(last?.amount_deviation, 10000000000);
  if (dateMean > 25) dateDev += 1;
  if (which === "date") {
    const fires = !ignoreDate && days(invoiceDate, lastDate) < Math.trunc(dateMean - 2 * dateDev);
    if (fires) throw new NotPorted("abnormal_date_warning text (format_date)");
    return false;
  }
  const wiggle = 2 * amountDev;
  const fires = !ignoreAmount && !(amountMean - wiggle <= amountTotal && amountTotal <= amountMean + wiggle);
  if (fires) throw new NotPorted("abnormal_amount_warning text (currency.format)");
  return false;
}

defineComputes("account.move", {
  abnormal_amount_warning: (env, rec) => abnormalWarnings(env, rec, "amount"),
  abnormal_date_warning: (env, rec) => abnormalWarnings(env, rec, "date"),
  // account_move.py:1390-1393
  adjusting_entries_count: async (_env, rec) => (await rec.rels("adjusting_entries_move_ids")).length,
});

const INVOICE_TYPES = ["out_invoice", "out_refund", "in_invoice", "in_refund"]; // account_move.py:7285-7306 (no receipts)

defineComputes("account.move", {
  // portal_mixin.py:30-32, extended by account_move.py:2059-2063
  access_url: async (_env, rec) => {
    if (!INVOICE_TYPES.includes(String(await rec.get("move_type")))) return "#";
    if (rec.id === null) throw new NotPorted("access_url of a new invoice ('/my/invoices/' + NewId)");
    return `/my/invoices/${rec.id}`;
  },
  // account_move.py:1401-1408
  adjusting_entry_origin_label: async (env, rec) => {
    const origins = await rec.rels("adjusting_entry_origin_move_ids");
    if (origins.length !== 1) return false;
    const moveType = String(await origins[0]!.get("move_type"));
    const sel = env.reg.model("account.move").fields.get("move_type")!.selection ?? [];
    const item = sel.find((x) => x.value === moveType);
    if (!item) throw new NotPorted(`move_type label of ${moveType}`);
    return item.labels[env.lang ?? "en_US"] ?? item.label;
  },
  // account_move.py:2172-2177 with `_fetch_duplicate_reference` (:2182-2243) and the SQL conditions (:2245-2293)
  duplicated_ref_ids: async (env, rec) => {
    const moveType = String(await rec.get("move_type"));
    const sale = ["out_invoice", "out_refund", "out_receipt"].includes(moveType);
    const purchase = ["in_invoice", "in_refund", "in_receipt"].includes(moveType);
    if (!sale && !purchase) return [];
    const cond = sale
      ? `move.amount_total = duplicate_move.amount_total AND move.invoice_date = duplicate_move.invoice_date
         AND (move.commercial_partner_id = duplicate_move.commercial_partner_id OR (move.commercial_partner_id IS NULL AND duplicate_move.state = 'draft'))`
      : `duplicate_move.move_type in ('in_invoice', 'in_refund', 'in_receipt') AND (
           (move.ref = duplicate_move.ref
            AND (move.invoice_date IS NULL OR duplicate_move.invoice_date IS NULL
                 OR date_part('year', move.invoice_date) = date_part('year', duplicate_move.invoice_date))
            AND (move.commercial_partner_id = duplicate_move.commercial_partner_id
                 OR (move.commercial_partner_id IS NULL AND duplicate_move.state = 'draft')))
           OR (move.commercial_partner_id = duplicate_move.commercial_partner_id AND move.amount_total = duplicate_move.amount_total
               AND move.amount_total != 0.0 AND move.invoice_date = duplicate_move.invoice_date))`;
    // :2193-2212: a record in edition or under creation is not in the table yet: its values replace it
    const params: unknown[] = [rec.origin ?? rec.id ?? 0];
    let moveTable = "account_move AS move";
    if (rec.id === null) {
      const col = async (f: string): Promise<unknown> => (await rec.get(f)) || null;
      const totals = (await rec.get("tax_totals")) as { total_amount_currency?: unknown } | null;
      params.push(await col("ref"), await col("move_type"), await col("partner_id"), await col("invoice_date"), await col("currency_id"),
        await col("commercial_partner_id"), await col("company_id"), ((t: unknown) => (isPyFloat(t) ? t.float : Number(t ?? 0)))(totals?.total_amount_currency), await col("state"));
      moveTable = `(VALUES ($2::varchar, $3::varchar, $4::int4, $5::date, $6::int4, $7::int4, $8::int4, $9::numeric, $10::varchar, $1::int4))
        AS move(ref, move_type, partner_id, invoice_date, currency_id, commercial_partner_id, company_id, amount_total, state, id)`;
    }
    const rows = (await env.cr.query<{ duplicate_ids: number[] }>(`
      SELECT array_agg(duplicate_move.id) AS duplicate_ids
        FROM ${moveTable}
        JOIN account_move AS duplicate_move
          ON move.company_id = duplicate_move.company_id AND move.id != duplicate_move.id
         AND duplicate_move.state IN ('draft', 'posted')
         AND (move.move_type = duplicate_move.move_type
              OR (move.move_type IN ('in_invoice', 'in_receipt') AND duplicate_move.move_type IN ('in_invoice', 'in_receipt'))
              OR (move.move_type IN ('out_invoice', 'out_receipt') AND duplicate_move.move_type IN ('out_invoice', 'out_receipt')))
         AND move.currency_id = duplicate_move.currency_id
         AND (${cond})
       WHERE move.id = $1 GROUP BY move.id`, params)).rows;
    const ids = rows[0]?.duplicate_ids ?? [];
    if (!ids.length) return [];
    // `._filtered_access('read')`, in array_agg order
    const allowed = await filteredAccess(env, "account.move", ids, "read");
    return ids.filter((id) => allowed.has(id));
  },
});

relatedSelections("account.move", ["tax_calculation_rounding_method"]);
relatedSelections("account.journal", ["account_peppol_proxy_state"]);

defineComputes("account.journal", {
  // portal_mixin.py:30-32 (no account.journal override)
  access_url: async () => "#",
  // account_journal.py:537-539 (False), account_peppol account_journal.py:20-35: sale journals (or self-billing
  // purchase ones) of a company whose Peppol proxy can send (account_edi_proxy_user.py:167-168); l10n_dk is not installed
  show_refresh_out_einvoices_status_button: async (_env, rec) => {
    const company = await rec.rel("company_id");
    const state = company ? await company.get("account_peppol_proxy_state") : null;
    if (!["sender", "smp_registration", "receiver"].includes(String(state))) return false;
    const type = await rec.get("type");
    return type === "sale" || (type === "purchase" && Boolean(await rec.get("is_self_billing")));
  },
});
// account.journal inherits mail.alias.mixin.optional (account_journal.py): alias_email, its search, alias_contact
registerAliasMixin("account.journal");

defineComputes("account.tax", {
  // account_tax.py:323-332
  display_alternative_taxes_field: async (_env, rec) => {
    if ((await rec.rels("original_tax_ids")).length) return true;
    const fps = (await rec.rels("fiscal_position_ids")).map((r) => r.origin);
    if (!fps.length) return false;
    const company = await rec.rel("company_id");
    const domestic = company ? await company.get("domestic_fiscal_position_id") : false;
    // recordset comparison: `fiscal_position_ids._origin != company.domestic_fiscal_position_id`
    return !(fps.length === 1 && fps[0] === domestic) && !(fps.length === 0 && !domestic);
  },
});

for (const model of ["account.move", "account.payment", "account.journal"]) registerActivityMixin(model);

/** account_move.py:2296-2312 `_compute_duplicate_move_status` (both fields). */
async function duplicateStatus(env: Environment, rec: Rec, which: "draft" | "exact"): Promise<boolean> {
  const dupIds = (await rec.get("duplicated_ref_ids")) as number[];
  if (!Array.isArray(dupIds) || !dupIds.length) return false;
  const dups = await env.model("account.move").read(dupIds, ["state", "ref", "move_type", "partner_id", "invoice_date", "amount_total"], "");
  if (which === "draft") return dups.some((d) => d["state"] === "draft");
  const ref = await rec.get("ref");
  const mt = String(await rec.get("move_type"));
  const partner = await rec.get("partner_id");
  const date = await rec.get("invoice_date");
  const total = Number(await rec.get("amount_total"));
  const purchase = mt === "in_invoice" || mt === "in_refund";
  const sameType = (o: string): boolean => mt === o || (["in_invoice", "in_receipt"].includes(mt) && ["in_invoice", "in_receipt"].includes(o))
    || (["out_invoice", "out_receipt"].includes(mt) && ["out_invoice", "out_receipt"].includes(o));
  return dups.some((d) => Boolean(ref) && ref === d["ref"] && sameType(String(d["move_type"])) && (partner || false) === (d["partner_id"] || false)
    && (date || false) === (d["invoice_date"] || false) && total === Number(d["amount_total"]) && purchase);
}

defineComputes("account.move", {
  // account_move.py:1395-1398
  adjusting_entry_origin_moves_count: async (_env, rec) => (await rec.rels("adjusting_entry_origin_move_ids")).length,
  has_draft_move_duplicate: (env, rec) => duplicateStatus(env, rec, "draft"),
  is_exact_move_duplicate: (env, rec) => duplicateStatus(env, rec, "exact"),
  // portal_mixin.py:26-28 (no account override)
  access_warning: async () => "",
});

/**
 * res_partner_bank.py:278-295 `get_available_qr_methods_in_sequence`: `_get_available_qr_methods()` through the
 * private hook (src/orm/private_hooks.ts), so a site's compiled override (account_qr_code_emv: emv_qr, 30; l10n_ch:
 * ch_qr, 10) appends its methods, then sorted by sequence (a stable sort). The hand port's is account's ([]) with
 * account_qr_code_sepa's (res_bank.py:77-80: sct_qr, 20) when installed: wherever sepa sits in the MRO it only appends
 * a method of sequence 20, which no other method shares, so its place does not change the sorted result.
 */
export async function qrMethods(env: Environment): Promise<[string, string][]> {
  const out = await priv.res_partner_bank._get_available_qr_methods.call(env, [], [], async (e) => {
    const modules = e.reg.model("res.partner.bank").modules ?? [];
    return modules.includes("account_qr_code_sepa") ? [pyTuple(["sct_qr", translate(e, "SEPA Credit Transfer QR", "account_qr_code_sepa"), 20])] : [];
  });
  const rows = qrMethodRows(out);
  return rows.map((r, i) => [r, i] as const).sort((a, b) => a[0][2] - b[0][2] || a[1] - b[1]).map(([[c, n]]) => [c, n]);
}

registerHooks("account.move", { selection: { qr_code_method: qrMethods } });
registerHooks("res.partner", { selection: { qr_code_method: qrMethods } });

defineComputes("account.tax", {
  // account_tax.py:456-460
  has_negative_factor: async (_env, rec) => {
    for (const line of await rec.rels("invoice_repartition_line_ids")) {
      if ((await line.get("repartition_type")) === "tax" && Number(await line.get("factor")) < 0) return true;
    }
    return false;
  },
});

/**
 * sale_project/models/account_analytic_line.py:26-43 `_selection_billable_type` with the installed overrides
 * sale_project_stock (:9-13) and sale_purchase_project (:7-8), sorted by (sequence, value, label).
 */
registerHooks("account.analytic.line", {
  selection: {
    billable_type: async (env) => {
      const t = (s: string): string => translate(env, s);
      const types: [number, string, string][] = [
        [10, "01_revenues_fixed", t("Service Revenue (Fixed Price)")], [20, "10_service_revenues", t("Service Revenue (Time & Materials)")],
        [30, "05_revenues_milestones", t("Service Revenue (Milestones)")], [40, "07_revenues_manual", t("Service Revenue (Manual)")],
        [70, "19_materials", t("Materials")], [90, "11_other_revenues", t("Other Revenue")], [180, "12_vendor_bill", t("Vendor Bills")],
        [200, "30_other_costs", t("Other Costs")],
        [80, "15_picking_entry_positive", t("Inventory Transfers (Revenue)")], [190, "16_picking_entry_negative", t("Inventory Transfers (Costs)")],
        [150, "20_purchase_order", t("Purchase Orders")],
      ];
      types.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
      return types.map(([, v, l]) => [v, l] as [string, string]);
    },
  },
});

relatedSelections("account.bank.statement.line", ["activity_exception_decoration", "state", "move_type", "auto_post"]);

defineComputes("account.tax", {
  // account_edi_ubl_cii/models/account_tax.py:123-126
  ubl_cii_requires_exemption_reason: async (_env, rec) => ["AE", "E", "G", "O", "K"].includes(String(await rec.get("ubl_cii_tax_category_code"))),
});

defineComputes("account.tax", {
  // account_tax.py:298-305
  price_include: async (_env, rec) => {
    const override = await rec.get("price_include_override");
    if (override === "tax_included") return true;
    const company = await rec.rel("company_id");
    return !override && (company ? await company.get("account_price_include") : false) === "tax_included";
  },
});

defineComputes("account.move", {
  // account_move.py:1360-1373
  status_in_payment: async (_env, rec) => {
    const state = await rec.get("state");
    const ps = await rec.get("payment_state");
    let out: unknown = false;
    if (state === "posted") {
      if (["partial", "in_payment", "paid", "reversed", "blocked"].includes(String(ps))) out = ps;
      else if (await rec.get("is_move_sent")) out = "sent";
    } else if (state === "draft" && ["partial", "in_payment", "paid", "blocked"].includes(String(ps))) out = ps;
    return out || state;
  },
});
registerHooks("account.move", {
  // :1375-1383 `_compute_sql_status_in_payment`
  computeSql: {
    status_in_payment: async (table) => {
      const st = await table.field("state");
      const ps = await table.field("payment_state");
      return sql`(CASE WHEN ${st} = 'draft' THEN 'draft' WHEN ${st} = 'cancel' THEN 'cancel' ELSE ${ps} END)`;
    },
  },
});

defineComputes("account.move", {
  // account_move.py:872-875 (with compute_sql :877-878 below)
  move_sent_values: async (_env, rec) => ((await rec.get("is_move_sent")) ? "sent" : "not_sent"),
});
registerHooks("account.move", {
  computeSql: { move_sent_values: async (table) => sql`(CASE WHEN ${await table.field("is_move_sent")} THEN 'sent' ELSE 'not_sent' END)` },
});

defineComputes("account.tax.repartition.line", {
  // account_tax.py:5234-5237
  factor: async (_env, rec) => Number(await rec.get("factor_percent")) / 100.0,
});

defineComputes("res.company", {
  // account/models/company.py:448-453, base res_country.py:186-193 `_compute_country_group_codes`
  account_fiscal_country_group_codes: async (_env, rec) => {
    const country = await rec.rel("account_fiscal_country_id");
    if (!country) return [""];
    const codes: string[] = [];
    for (const g of await country.rels("country_group_ids")) {
      const code = await g.get("code");
      if (code) codes.push(String(code));
    }
    return codes.length ? codes : [""];
  },
});

/** account/models/partner.py:90-103 `_compute_foreign_vat_header_mode`, :86-88 `_compute_states_count`. */
defineComputes("account.fiscal.position", {
  states_count: async (_env, rec) => {
    const country = await rec.rel("country_id");
    return country ? (await country.rels("state_ids")).length : 0;
  },
  foreign_vat_header_mode: async (env, rec) => {
    const country = await rec.rel("country_id");
    if (!(await rec.get("foreign_vat")) || !country) return false;
    const taxes = await env.model("account.tax").search(cond("country_id", "=", country.id), { limit: 1 });
    if (taxes.length) return false;
    const { guessChartTemplate } = await import("./apps_data");
    const template = await guessChartTemplate(env, country.origin!);
    const installed = (await env.cr.query("SELECT 1 FROM ir_module_module WHERE name = $1 AND state = 'installed'", [template.module])).rows.length > 0;
    return installed ? "templates_found" : "no_template";
  },
});

/**
 * The selection of a related Selection field (fields.py `_setup_related_full` copies the target's `selection`):
 * the target field's static selection with its labels in the env language, or the target's selection hook.
 */
export function relatedSelection(model: string, field: string): (env: Environment) => Promise<readonly [string, string][]> {
  return async (env) => {
    const def = env.reg.model(model).fields.get(field);
    if (!def?.related) throw new NotPorted(`related selection ${model}.${field}`);
    let m = model;
    const path = def.related.split(".");
    for (const step of path.slice(0, -1)) {
      const f = env.reg.model(m).fields.get(step);
      if (!f?.relation) throw new NotPorted(`related selection path ${model}.${def.related}`);
      m = f.relation;
    }
    const target = env.reg.model(m).fields.get(path[path.length - 1]!);
    if (!target) throw new NotPorted(`related selection target ${m}.${path[path.length - 1]}`);
    const lang = env.lang ?? "en_US";
    if (target.selection) return target.selection.map((s) => [s.value, s.labels[lang] ?? s.label] as [string, string]);
    const hook = hooksOf(m).selection?.[target.name];
    if (target.related) return relatedSelection(m, target.name)(env);
    if (!hook) throw new NotPorted(`selection of ${m}.${target.name} (target of ${model}.${field})`);
    return hook(env);
  };
}

export function relatedSelections(model: string, fields: readonly string[]): void {
  registerHooks(model, { selection: Object.fromEntries(fields.map((f) => [f, relatedSelection(model, f)])) });
}

relatedSelections("account.tax", ["company_price_include"]);
relatedSelections("account.move", ["company_price_include"]);
relatedSelections("account.payment", ["outstanding_account_type"]);
relatedSelections("account.bank.statement.line", ["activity_state"]);

// account_journal.py:57-58 `_get_bank_statements_available_sources` (no installed module extends it)
registerHooks("account.journal", {
  selection: { bank_statements_source: async (env) => [["undefined", translate(env, "Undefined Yet")]] },
});

// mail_alias_mixin_optional.py:143-148: the journals' aliases are deleted after them (account_journal.py:734-743 the
// journal's own unlink: src/models/account_journal_create.ts)
registerAliasMixinUnlink("account.journal");

/**
 * models.py:2798 `read(fields=None, load='_classic_read')` over call_kw for the models of these apps, none of which
 * overrides read/_read_format/fetch in the installed modules except account.move (account_move.py: an empty
 * `fields` becomes `_get_default_read_fields()`, refused here).
 */
/** account_move.py:3850-3853 `_get_default_read_fields`: `fields_get(attributes=())` without three heavy fields. */
async function moveDefaultReadFields(env: Environment): Promise<string[]> {
  const weirdos = new Set(["needed_terms", "quick_encoding_vals", "payment_term_details"]);
  return Object.keys(await env.model("account.move").fieldsGet(null, [])).filter((f) => !weirdos.has(f));
}

// account_move.py:3859-3862 search_read: no fields means the default read fields, then the generic search_read
registerMethod("account.move", "search_read", async (env0, _ids, args0, kwargs0) => {
  const { env, kwargs: kw } = envFor(env0, kwargs0);
  const args = [...args0];
  const kwargs = { ...kw };
  const given = "fields" in kwargs ? kwargs["fields"] : args[1];
  if (!given || (Array.isArray(given) && !given.length)) {
    const fields = await moveDefaultReadFields(env);
    if ("fields" in kwargs || args.length < 2) kwargs["fields"] = fields;
    else args[1] = fields;
  }
  const { searchRead } = await import("./res_lang");
  return searchRead(env, "account.move", args, kwargs);
}, { apiModel: true, readonly: true });

export function registerPlainRead(model: string): void {
  registerMethod(model, "read", async (env0, ids, args, kwargs0) => {
    const { env, kwargs } = envFor(env0, kwargs0);
    for (const k of Object.keys(kwargs)) if (k !== "fields" && k !== "load") throw new NotPorted(`read keyword ${k}`);
    const rawFields = "fields" in kwargs ? kwargs["fields"] : args[0];
    let fields: string[] = [];
    if (rawFields === undefined || rawFields === null || rawFields === false) fields = [];
    else if (Array.isArray(rawFields) && rawFields.every((f): f is string => typeof f === "string")) fields = rawFields;
    else throw new NotPorted(`read fields=${JSON.stringify(rawFields)}`);
    if (model === "account.move" && !fields.length) fields = await moveDefaultReadFields(env); // account_move.py:3855-3857
    const rawLoad = "load" in kwargs ? kwargs["load"] : args.length > 1 ? args[1] : "_classic_read";
    const load = rawLoad === "_classic_read" ? "_classic_read" : rawLoad === "" || rawLoad === null || rawLoad === false ? "" : null;
    if (load === null) throw new NotPorted(`read load=${JSON.stringify(rawLoad)}`);
    return env.model(model).read(ids ?? [], fields, load);
  }, { apiModel: false, readonly: true });
}

for (const model of ["account.analytic.line", "account.bank.statement.line", "account.fiscal.position", "account.journal", "account.move",
  "account.payment", "account.payment.term", "account.tax", "payment.provider", "purchase.order", "stock.lot", "stock.move",
  "stock.move.line", "stock.picking", "stock.picking.type", "stock.warehouse"]) registerPlainRead(model);

const DRAFT_LABELS: Readonly<Record<string, string>> = {
  out_invoice: "Draft Invoice", out_refund: "Draft Credit Note", in_invoice: "Draft Bill", in_refund: "Draft Vendor Credit Note",
  out_receipt: "Draft Sales Receipt", in_receipt: "Draft Purchase Receipt", entry: "Draft Entry",
};

/** account_move.py `_get_move_display_name(show_ref=True)` without the amount variants. */
function moveDisplayName(env: Environment, r: { state: string; move_type: string; name: string | null; ref: string | null; partner: string | null; date: string | null }): string {
  let name = r.state === "draft" ? translate(env, DRAFT_LABELS[r.move_type]!) : "";
  if (r.name && r.name !== "/") {
    name = `${name} ${r.name}`.trim();
    if (env.context["input_full_display_name"]) {
      if (r.partner) name += `, ${r.partner}`;
      if (r.date) throw new NotPorted("account.move input_full_display_name date (format_date)");
    }
  }
  if (r.ref) {
    // textwrap.shorten(ref, width=50): whitespace collapsed; longer texts get the " [...]" placeholder
    const ref = r.ref.split(/\s+/).filter((w) => w).join(" ");
    if (ref.length > 50) throw new NotPorted("account.move display name with a reference over 50 characters (textwrap.shorten)");
    name += ` (${ref})`;
  }
  return name;
}
/** account_move.py:4212-4215 `_compute_display_name` via `_get_move_display_name(show_ref=True)` (:5471-5509). */
registerHooks("account.move", {
  displayName: async (env, ids) => {
    if (env.context["name_as_amount_residual"] || env.context["name_as_amount_total"]) throw new NotPorted("account.move display name with amounts (currency.format)");
    const rows = (await env.cr.query<{ id: number; state: string; move_type: string; name: string | null; ref: string | null; partner: string | null; date: string | null }>(`
      SELECT m.id, m.state, m.move_type, m.name, m.ref, p.name AS partner, m.date::text AS date
        FROM account_move m LEFT JOIN res_partner p ON p.id = m.partner_id WHERE m.id = ANY($1::int[])`, [ids])).rows;
    const out = new Map<number, string>();
    for (const r of rows) out.set(r.id, moveDisplayName(env, r));
    return out;
  },
});
registerRecordCompute("account.move", {
  // the same on a record in edition or under creation
  display_name: async (env, rec) => {
    if (env.context["name_as_amount_residual"] || env.context["name_as_amount_total"]) throw new NotPorted("account.move display name with amounts (currency.format)");
    const partner = await rec.rel("partner_id");
    const text = async (f: string): Promise<string | null> => ((await rec.get(f)) as string | false | null) || null;
    return moveDisplayName(env, { state: String(await rec.get("state")), move_type: String(await rec.get("move_type")), name: await text("name"), ref: await text("ref"),
      partner: partner ? String(await partner.get("name")) : null, date: await text("date") });
  },
});

relatedSelections("account.bank.statement.line", ["review_state"]);

defineComputes("account.tax.repartition.line", {
  // account_tax.py:5219-5223 `_compute_tag_ids_domain`
  tag_ids_domain: async (_env, rec) => {
    const company = await rec.rel("company_id");
    const countries: (number | false)[] = [false, company ? ((await company.get("account_fiscal_country_id")) as number | false) || false : false];
    if (company) for (const c of await company.rels("multi_vat_foreign_country_ids")) countries.push(c.id ?? false);
    return [["applicability", "=", "taxes"], ["country_id", "in", countries]];
  },
});

defineComputes("account.move", {
  // account_move.py:989-992 with `_get_suitable_journal_ids` (:7267-7273) and `_check_company_domain`
  // (models.py check_company_domain_parent_of: company_id False or a parent of the company)
  suitable_journal_ids: async (env, rec) => {
    const mt = String(await rec.get("move_type"));
    const type = ["out_invoice", "out_refund", "out_receipt"].includes(mt) ? "sale" : ["in_invoice", "in_refund", "in_receipt"].includes(mt) ? "purchase" : "general";
    const company = ((await rec.get("company_id")) as number | false) || await env.company();
    return env.model("account.journal").search(and([or([cond("company_id", "=", false), cond("company_id", "parent_of", [company])]), cond("type", "=", type)]));
  },
});

/**
 * The remaining related/delegated Selection fields of the account/stock/purchase/payment models (the table of
 * src/models/gen_related_selections.py, which src/models/related_selections.ts leaves to this stream): the target's
 * selection, unless a hook above already gives the field's selection.
 */
for (const entry of RELATED_SELECTIONS as unknown[]) {
  if (!Array.isArray(entry) || entry.length !== 4 || !entry.every((v) => typeof v === "string")) continue;
  const [model, field] = entry as [string, string, string, string];
  if (!/^(account|stock|purchase|payment)\./.test(model) || hooksOf(model).selection?.[field] !== undefined) continue;
  relatedSelections(model, [field]);
}

relatedSelections("account.bank.statement.line", ["qr_code_method"]);

defineComputes("res.company", {
  /**
   * account/models/company.py:455-469 `_compute_multi_vat_foreign_country`: the countries of the company's fiscal
   * positions with a foreign VAT (`country_id:array_agg` grouped by company_id; several countries refuse: array order).
   */
  multi_vat_foreign_country_ids: async (env, rec) => {
    if (rec.origin === null) return [];
    const fps = await env.model("account.fiscal.position").search(and([cond("company_id", "=", rec.origin), cond("foreign_vat", "!=", false)]));
    if (!fps.length) return [];
    const rows = await env.model("account.fiscal.position").read(fps, ["country_id"], "");
    const countries = [...new Set(rows.map((r) => r["country_id"]).filter((c): c is number => typeof c === "number"))];
    if (countries.length > 1 || rows.some((r) => !r["country_id"])) throw new NotPorted("multi_vat_foreign_country_ids with several or empty countries (array_agg order)");
    return countries;
  },
});

/** account_tax.py:334-343 `_compute_is_used` with purchase/models/account_tax.py:16-21 (purchase order lines). */
async function taxIsUsed(env: Environment, id: number): Promise<boolean> {
  const su = env.sudo();
  const used = await su.model("account.tax").search(and([cond("id", "in", [id]),
    or([cond("account_move_line_ids", "!=", false), cond("account_reconcile_model_line_ids", "!=", false), cond("purchase_order_line_ids", "!=", false)])]), { activeTest: false });
  return used.length > 0;
}

function pyStrRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/\\/g, "\\\\").replace(new RegExp(q, "g"), `\\${q}`).replace(/\n/g, "\\n") + q;
}

defineComputes("account.tax", {
  is_used: async (env, rec) => (rec.origin === null ? false : taxIsUsed(env, rec.origin)),
  /**
   * account_tax.py:345-367 `_compute_repartition_lines_str`: `str()` of a dict keyed by (document_type, n) of the
   * repartition lines' factor, account, tax grids and closing flag, for used taxes; "" otherwise.
   */
  repartition_lines_str: async (env, rec) => {
    if (rec.origin === null || !(await taxIsUsed(env, rec.origin))) return "";
    const lines: { doc: string; seq: number; rec: Rec }[] = [];
    for (const l of await rec.rels("repartition_line_ids")) lines.push({ doc: String(await l.get("document_type")), seq: Number(await l.get("sequence")), rec: l });
    lines.sort((a, b) => (a.doc < b.doc ? -1 : a.doc > b.doc ? 1 : a.seq - b.seq));
    let inv = 0, ref = 0;
    const parts: string[] = [];
    for (const { doc, rec: l } of lines) {
      const n = doc === "invoice" ? ++inv : ++ref;
      const account = await l.get("account_id");
      const accountName = typeof account === "number" && account > 0 ? (await env.model("account.account").displayName([account])).get(account) ?? "" : "";
      const tags: string[] = [];
      for (const t of await l.rels("tag_ids")) tags.push(String(await t.get("name")));
      const fp = pyFloatRepr(Number(await l.get("factor_percent")));
      parts.push(`(${pyStrRepr(doc)}, ${n}): {${pyStrRepr(translate(env, "Factor Percent"))}: ${fp}, ${pyStrRepr(translate(env, "Account"))}: ${pyStrRepr(accountName || translate(env, "None"))}, `
        + `${pyStrRepr(translate(env, "Tax Grids"))}: ${tags.length ? `[${tags.map(pyStrRepr).join(", ")}]` : pyStrRepr(translate(env, "None"))}, `
        + `${pyStrRepr(translate(env, "Use in tax closing"))}: ${pyStrRepr(translate(env, (await l.get("use_in_tax_closing")) ? "True" : "False"))}}`);
    }
    return `{${parts.join(", ")}}`;
  },
});


/**
 * account_account.py:46, :320-322 `_compute_sql_code`: `code` in domains, orders and groupings is the `code_store`
 * (company-dependent, no fallback without an ir.default) of the env company's root company, as superuser.
 */
async function rootCompany(env: Environment): Promise<string> {
  const company = await env.company();
  return (await env.cr.query<{ root: string }>("SELECT split_part(parent_path, '/', 1) AS root FROM res_company WHERE id = $1", [company])).rows[0]?.root ?? String(company);
}

async function refuseCodeFallback(env: Environment): Promise<void> {
  const fallback = (await env.cr.query("SELECT 1 FROM ir_default d JOIN ir_model_fields f ON f.id = d.field_id WHERE f.model = 'account.account' AND f.name = 'code_store' LIMIT 1")).rows.length;
  if (fallback) throw new NotPorted("account.account.code_store with an ir.default fallback (company-dependent to_sql)");
}

registerHooks("account.account", {
  // :315-318 `_compute_code` of stored records (the read path; new records in a form refuse as before)
  computed: {
    code: async (env, ids) => {
      await refuseCodeFallback(env);
      const root = await rootCompany(env);
      const rows = (await env.cr.query<{ id: number; code: string | null }>("SELECT id, code_store->>$2 AS code FROM account_account WHERE id = ANY($1::int[])", [ids, root])).rows;
      const byId = new Map(rows.map((r) => [r.id, r.code]));
      return new Map(ids.map((id) => [id, byId.get(id) ?? false]));
    },
  },
  computeSql: {
    code: async (table) => {
      await refuseCodeFallback(table.env);
      const root = await rootCompany(table.env);
      return sql`(${ident(table.alias, "code_store")} ->> ${root})`;
    },
  },
});

/**
 * account_account.py:348-392 `_compute_sql_placeholder_code`: the code of the env company's root company, else the code
 * of the account's first company among the user's (`_get_company_ids`, lowest id) with that company's name in brackets.
 * The join `account_first_company` is a correlated subquery here (one row per account either way).
 */
async function placeholderCodeSql(env: Environment, alias: Sql): Promise<Sql> {
  await refuseCodeFallback(env);
  const root = await rootCompany(env);
  const companies = [...(await userInfo(env)).companyIds];
  const first = (col: "root" | "name"): Sql => sql`(SELECT ${col === "root" ? sql`SPLIT_PART(c.parent_path, '/', 1)` : sql`c.name`}
      FROM account_account_res_company_rel rel JOIN res_company c ON c.id = rel.res_company_id
     WHERE rel.account_account_id = ${alias}.id AND rel.res_company_id = ANY(${companies}::int[])
  ORDER BY rel.res_company_id LIMIT 1)`;
  return sql`COALESCE(${alias}.code_store->>${root}, ${alias}.code_store->>${first("root")} || ' (' || ${first("name")} || ')')`;
}

registerHooks("account.account", {
  computed: {
    // :336-346 `_compute_placeholder_code` (compute_sudo): the code, else the code in the first of the account's
    // companies the user belongs to (by id), followed by that company's name
    placeholder_code: async (env, ids) => {
      await refuseCodeFallback(env);
      const root = await rootCompany(env);
      const companies = [...(await userInfo(env)).companyIds];
      const rows = (await env.cr.query<{ id: number; code: string | null; other: string | null; company: string | null }>(
        `SELECT a.id, a.code_store->>$2 AS code, f.other, f.company
           FROM account_account a
           LEFT JOIN LATERAL (SELECT a.code_store->>SPLIT_PART(c.parent_path, '/', 1) AS other, c.name AS company
                                FROM account_account_res_company_rel rel JOIN res_company c ON c.id = rel.res_company_id
                               WHERE rel.account_account_id = a.id AND rel.res_company_id = ANY($3::int[])
                            ORDER BY rel.res_company_id LIMIT 1) f ON TRUE
          WHERE a.id = ANY($1::int[])`, [ids, root, companies])).rows;
      const byId = new Map(rows.map((r) => [r.id, r.code ? r.code : r.other ? `${r.other} (${r.company})` : false]));
      return new Map(ids.map((id) => [id, byId.get(id) ?? false]));
    },
    // :154-155 `display_mapping_tab`, neither stored nor computed: a read takes its default, the user has several
    // companies
    display_mapping_tab: async (env, ids) => {
      const several = (await userInfo(env)).companyIds.length > 1;
      return new Map(ids.map((id) => [id, several]));
    },
    // :587-597 `_compute_current_balance`: the posted balance of the env company's (and its branches') lines
    current_balance: async (env, ids) => {
      const rows = await rawReadGroup(env, "account.move.line", and([cond("account_id", "in", [...ids]), cond("parent_state", "=", "posted"),
        cond("company_id", "child_of", await env.company())]), ["account_id"], ["balance:sum"]);
      const balances = new Map(rows.map((r) => [r[0] as number, isPyFloat(r[1]) ? r[1].float : r[1]]));
      return new Map(ids.map((id) => [id, balances.get(id) ?? 0]));
    },
    // :600-605 `_compute_related_taxes_amount` (not compute_sudo): the taxes of the env company (and its parents,
    // or shared) with a repartition line on the account, counted with the user's rules
    related_taxes_amount: async (env, ids) => {
      const company = await env.company();
      const path = [...((await env.cr.query<{ p: string }>("SELECT parent_path AS p FROM res_company WHERE id = $1", [company])).rows[0]?.p ?? "")
        .split("/").filter(Boolean).map(Number), false];
      const out = new Map<number, unknown>();
      for (const id of ids) {
        out.set(id, await env.model("account.tax").searchCount(and([cond("company_id", "in", path), cond("repartition_line_ids.account_id", "in", [id])])));
      }
      return out;
    },
  },
  computeSql: {
    placeholder_code: async (table) => placeholderCodeSql(table.env, ident(table.alias)),
  },
  search: {
    // :394-403 `_search_placeholder_code`: `id in (SELECT ... WHERE placeholder_code ILIKE value | IN value)`
    placeholder_code: async (env, operator, value) => {
      if (operator !== "=ilike" && operator !== "in") return null;
      const expr = await placeholderCodeSql(env, raw("a"));
      const where = operator === "in"
        ? sql`${expr} = ANY(${(value as unknown[]).map((v) => String(v))}::text[])`
        : sql`${expr} ILIKE ${String(value)}`;
      const q = sql`SELECT a.id FROM account_account a WHERE ${where}`;
      const ids = (await runSql<{ id: number }>(env, q)).map((r) => r.id);
      return cond("id", "in", ids);
    },
    // :456-473 `_search_account_root`: one `placeholder_code =ilike` per root, a prefix match unless a top-level root
    // is asked with `in`
    root_id: async (_env, operator, value) => {
      if (operator === "any") throw new NotPorted("account.account.root_id any (a display_name domain on account.root)");
      if (operator !== "in" && operator !== "child_of") return null;
      const roots = (Array.isArray(value) ? value : [value]).map((v) => {
        if (v === false || v === null || v === "") throw new NotPorted("account.account.root_id search for no root (root_id = False)");
        return String(v);
      });
      if (!roots.length) return cond("id", "in", []);
      return or(roots.map((r) => cond("placeholder_code", "=ilike", r + (operator === "in" && r.length <= 1 ? "" : "%"))));
    },
  },
});

/**
 * account_code_mapping.py: `account.code.mapping`, a table-less model for the form's "Consolidation" tab. Its `_search`
 * (:52-71) takes the first `account_id in ids` of the domain and answers one record per account and per company of the
 * user (active ones, by sequence then name), id `account * 10000 + company`; the rest of the domain filters them
 * (refused here unless it is empty). The fields are computed from the id (:73-86); `code` is the account's code in that
 * company's root company.
 */
const COMPANY_OFFSET = 10000;
registerPortTable("account.code.mapping", raw(`(SELECT a.id * ${COMPANY_OFFSET} + c.id AS id FROM account_account a CROSS JOIN res_company c)`));
registerHooks("account.code.mapping", {
  searchOverride: async (env, domain) => {
    // the port's `_filtered_access('read')` of the co-records (src/orm/model.ts fetchRelation) searches `id in`
    // them, where Odoo keeps them without a search (no record rule): they are the ones just found
    if (domain.kind === "cond" && domain.path === "id" && domain.op === "in" && Array.isArray(domain.value)) {
      return (domain.value as unknown[]).filter((v): v is number => typeof v === "number" && v % COMPANY_OFFSET > 0);
    }
    const accountIds: number[] = [];
    let rest = 0;
    for (const c of iterConditions(domain)) {
      if (!accountIds.length && c.path === "account_id" && c.op === "in" && Array.isArray(c.value) && c.value.length) {
        for (const v of c.value) {
          if (typeof v !== "number") throw new NotPorted("account.code.mapping search on account_id with a non-integer id");
          accountIds.push(v);
        }
      } else rest++;
    }
    if (!accountIds.length) {
      throw new UserError(translate(env, "Account Code Mapping cannot be accessed directly. It is designed to be used only through the Chart of Accounts."));
    }
    if (rest || domain.kind === "or" || domain.kind === "not") throw new NotPorted("account.code.mapping search with more than account_id in (filtered_domain)");
    const companies = (await env.cr.query<{ id: number; sequence: number | null; name: string }>(
      `SELECT c.id, c.sequence, c.name FROM res_company_users_rel r JOIN res_company c ON c.id = r.cid
        WHERE r.user_id = $1 AND c.active`, [env.uid])).rows;
    companies.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return accountIds.flatMap((a) => companies.map((c) => a * COMPANY_OFFSET + c.id));
  },
  computed: {
    account_id: async (_env, ids) => new Map(ids.map((id) => [id, Math.floor(id / COMPANY_OFFSET)])),
    company_id: async (_env, ids) => new Map(ids.map((id) => [id, id % COMPANY_OFFSET])),
    code: async (env, ids) => {
      const rows = (await env.cr.query<{ id: number; code: string | null }>(
        `SELECT m.id, a.code_store->>SPLIT_PART(c.parent_path, '/', 1) AS code
           FROM UNNEST($1::int[]) AS m(id) JOIN account_account a ON a.id = m.id / ${COMPANY_OFFSET}
           JOIN res_company c ON c.id = m.id % ${COMPANY_OFFSET}`, [ids])).rows;
      await refuseCodeFallback(env);
      const byId = new Map(rows.map((r) => [r.id, r.code ?? false]));
      return new Map(ids.map((id) => [id, byId.get(id) ?? false]));
    },
  },
});

/**
 * account_account.py:910-930 `_compute_display_name` without formatted_display_name: "<code> <name>" when the account
 * has a code and the user has account.group_account_readonly, else the name. `code` (:314-318 `_compute_code`) is
 * `code_store` (company-dependent) of the env company's root company.
 */
registerHooks("account.account", {
  displayName: async (env, ids) => {
    const formatted = env.context["formatted_display_name"];
    if (formatted && (env.context["preferred_account_ids"] || (env.context["move_type"] && env.context["partner_id"]))) throw new NotPorted("account.account formatted_display_name with preferred accounts");
    const company = await env.company();
    const root = (await env.cr.query<{ root: string }>("SELECT split_part(parent_path, '/', 1) AS root FROM res_company WHERE id = $1", [company])).rows[0]?.root ?? String(company);
    const lang = env.lang ?? "en_US";
    const rows = (await env.cr.query<{ id: number; code: string | null; name: string | null }>(
      "SELECT id, code_store->>$2 AS code, COALESCE(name->>$3, name->>'en_US') AS name FROM account_account WHERE id = ANY($1::int[])", [ids, root, lang])).rows;
    const readonly = await userHasGroup(env, "account.group_account_readonly");
    if (formatted) {
      // :922-928 "<code> <name_path>" with the description on a new line (the asset tag is False without account_asset)
      const paths = (await env.cr.query<{ id: number; path: string | null; description: string | null }>(
        `SELECT a.id, a.description, (SELECT STRING_AGG(COALESCE(anc.name->>$2, anc.name->>'en_US'), ' / ' ORDER BY t.ord)
           FROM UNNEST(STRING_TO_ARRAY(RTRIM(a.parent_path, '/'), '/')) WITH ORDINALITY AS t(id, ord) JOIN account_account anc ON anc.id = t.id::int) AS path
           FROM account_account a WHERE a.id = ANY($1::int[])`, [ids, lang])).rows;
      const byId = new Map(paths.map((p) => [p.id, p]));
      return new Map(rows.map((r) => {
        const p = byId.get(r.id);
        return [r.id, `${(readonly && r.code) || ""} ${p?.path ?? ""}${p?.description ? `\n--${p.description}--` : ""}`];
      }));
    }
    return new Map(rows.map((r) => [r.id, r.code && readonly ? `${r.code} ${r.name ?? ""}` : (r.name ?? "")]));
  },
});

/**
 * account_account.py:406-416 `_compute_parent_ids` and `_compute_field_path` (compute_sudo): the names or codes of the
 * account's parents (`parent_path`, the root first, the account itself last) joined by " / ", False when one of them is
 * empty. The name in the env's language (en_US when untranslated), the code the env company's root company's (`code`,
 * :314-318). Searching and ordering use the SQL form (invoicing_computes.ts `accountPath`); this is the value read on a
 * record (compiled `_compute_display_name` with formatted_display_name reads `account.name_path`).
 */
async function fieldPath(env: Environment, rec: Rec, which: "code" | "name"): Promise<string | false> {
  if (rec.id === null) throw new NotPorted(`account.account.${which}_path of a new record`);
  const company = await env.company();
  const root = (await env.cr.query<{ root: string }>("SELECT split_part(parent_path, '/', 1) AS root FROM res_company WHERE id = $1", [company])).rows[0]?.root ?? String(company);
  const lang = env.lang ?? "en_US";
  const values = (await env.cr.query<{ v: string | null }>(
    `SELECT ${which === "code" ? "anc.code_store->>$2::text" : "COALESCE(anc.name->>$2::text, anc.name->>'en_US')"} AS v
       FROM account_account a CROSS JOIN LATERAL UNNEST(STRING_TO_ARRAY(RTRIM(a.parent_path, '/'), '/')) WITH ORDINALITY AS t(id, ord)
       JOIN account_account anc ON anc.id = t.id::int WHERE a.id = $1 ORDER BY t.ord`, [rec.id, which === "code" ? root : lang])).rows.map((r) => r.v);
  return values.every((v) => v) ? values.join(" / ") : false;
}
defineComputes("account.account", {
  code_path: async (env, rec) => fieldPath(env, rec, "code"),
  name_path: async (env, rec) => fieldPath(env, rec, "name"),
});

// account_tax.py:670-676 onchange_amount_type: a tax that is no group loses its children, a group its label
registerOnchange("account.tax", "onchange_amount_type", ["amount_type"], async (_env, rec) => {
  const type = await rec.get("amount_type");
  if (type !== "group") await rec.set("children_tax_ids", []);
  if (type === "group") await rec.set("invoice_label", null);
});
// account_tax.py:678-681 onchange_price_include
registerOnchange("account.tax", "onchange_price_include", ["price_include"], async (_env, rec) => {
  if (await rec.get("price_include")) await rec.set("include_base_amount", true);
});
