/**
 * account.move on new records and in creation: the stored computes of the header (account_move.py and
 * sale/models/account_move.py), as far as the draft invoice forms reach them. Unported branches refuse.
 */
import { NotPorted, UserError, ValidationError } from "../errors";
import { conversionRate, convertAmount } from "./currency_convert";
import { sanitizedAnalyticJson } from "../orm/create";
import { dumps } from "../http/json";
import { registerMethod } from "../http/methods";
import { onchangeCall } from "../web/onchange";
import { afterTracking, trackPrepare, trackRecordFinalize } from "../mail/tracking";
import { noteMoveCreateReset } from "../mail/write_hooks";
import { and, cond, mapConditions, or } from "../orm/domain";
import { hooksOf, registerHooks } from "../orm/hooks";
import { DbRec, NewRec, registerOnchange, registerRecordCompute, setOverlay, type Rec } from "../orm/recompute";
import type { Environment, FieldDef, ModelDef } from "../orm/types";
import { registerOverrides, write } from "../orm/write";
import { checkCompany, CompanyInconsistencyError } from "../orm/check_company";
import { createdInTransaction } from "../orm/created";
import { checkMoveWrite, prepareLineTracking, trackCreatedLine } from "./account_integrity";
import { isPyFloat } from "../orm/values";
import { contextToday } from "./account_computes";
import { accountTaxHelpers, roundPrecision } from "./account_tax_engine";
import { companyData, currencyData } from "./account_taxes";
import { deduceReset, dueDate, lastSequence, productBaseLine, sequenceMatchesDate } from "./invoicing_computes";
import { insertRow, splitSequence, touchSyncedInvoices, updateRow } from "./account_entries";
import { floatRound, pyTruthy } from "../orm/convert";
import { checkBalanced } from "./account_integrity";
import { movePartnerBank, updateSequenceGap } from "./account_move_ops";
import { defaultSalesTeam, fiscalPositionFor } from "./sale_computes";
import { adaptToDocumentTaxMode, mapTax, taxesOfCompany, uomPrice } from "./sale_flow";
import { addressGet, defineComputes, withCompany as withCompanyEnv } from "./tail_util";
import { contextDay, translate } from "./util";
import { parseTaxNameSearch } from "./account_tax_search";
import * as priv from "../orm/dispatch_gen";
import { PrivateRecords } from "../orm/private_hooks";
import { odooBaseLine, prepareBaseLine, prepareTaxLine, taxLineKey } from "./account_tax_hooks";

const SALE = ["out_invoice", "out_refund"], PURCHASE = ["in_invoice", "in_refund"];
const SALE_R = [...SALE, "out_receipt"], PURCHASE_R = [...PURCHASE, "in_receipt"];
const typeOf = async (rec: Rec): Promise<string> => String(await rec.get("move_type"));
const num = (v: unknown): number | null => (typeof v === "number" && v ? v : null);
const plainNumber = (v: unknown): number => (isPyFloat(v) ? v.float : Number(v ?? 0));

/**
 * A stored field the invoice line creation can write as given: no compute, not related, a scalar column (boolean,
 * char, text, integer, selection, many2one), and no stored computed field of the registry depends on it (a depends
 * path ending in its name), so that no recomputation is left out.
 */
function plainColumn(env: Environment, f: FieldDef): boolean {
  if (f.compute || f.related || !["boolean", "char", "text", "integer", "selection", "many2one"].includes(f.type) || f.translate || f.companyDependent) return false;
  for (const def of env.reg.models.values()) {
    for (const g of def.fields.values()) {
      if (g.store && g.compute && (g.depends ?? []).some((d) => d === f.name || d.endsWith(`.${f.name}`))) return false;
    }
  }
  return true;
}

/** account_move.py:946-953 `_get_valid_journal_types`. */
async function validJournalTypes(env: Environment, rec: Rec): Promise<string[]> {
  const t = await typeOf(rec);
  if (SALE_R.includes(t)) return ["sale"];
  if (PURCHASE_R.includes(t)) return ["purchase"];
  if ((await rec.get("origin_payment_id")) || (await rec.get("statement_line_id")) || env.context["is_payment"] || env.context["is_statement_line"]) return ["bank", "cash", "credit"];
  return ["general"];
}

/** account_move_line.py:1159-1219 `_compute_amount_residual` of one line: the partials subtracted from its amounts. */
async function lineResidual(env: Environment, rec: Rec): Promise<{ residual: number; residualCurrency: number; reconciled: boolean }> {
  const company = await rec.rel("company_id");
  const compCurrency = num(await rec.get("company_currency_id")) ?? (company ? num(await company.get("currency_id")) : null) ?? num(await new DbRec(env, env.reg.model("res.company"), await env.company()).get("currency_id"))!;
  const foreignCurrency = num(await rec.get("currency_id")) ?? compCurrency;
  let debit = 0, debitC = 0, credit = 0, creditC = 0;
  if (rec.origin !== null) {
    const rows = (await env.cr.query<{ flag: string; amount: number; amount_currency: number }>(
      `SELECT 'debit' AS flag, COALESCE(SUM(part.amount), 0.0)::float8 AS amount, ROUND(SUM(part.debit_amount_currency), curr.decimal_places)::float8 AS amount_currency
         FROM account_partial_reconcile part JOIN res_currency curr ON curr.id = part.debit_currency_id WHERE part.debit_move_id = $1 GROUP BY curr.decimal_places
       UNION ALL
       SELECT 'credit', COALESCE(SUM(part.amount), 0.0)::float8, ROUND(SUM(part.credit_amount_currency), curr.decimal_places)::float8
         FROM account_partial_reconcile part JOIN res_currency curr ON curr.id = part.credit_currency_id WHERE part.credit_move_id = $1 GROUP BY curr.decimal_places`,
      [rec.origin])).rows;
    if (rows.filter((r) => r.flag === "debit").length > 1 || rows.filter((r) => r.flag === "credit").length > 1) throw new NotPorted("partials of a line in currencies of different precision");
    for (const r of rows) {
      if (r.flag === "debit") { debit = r.amount; debitC = r.amount_currency; } else { credit = r.amount; creditC = r.amount_currency; }
    }
  }
  const cc = await currencyData(env, compCurrency), fc = await currencyData(env, foreignCurrency);
  const residual = roundPrecision(plainNumber(await rec.get("balance")) - debit + credit, cc.rounding);
  const residualCurrency = roundPrecision(plainNumber(await rec.get("amount_currency")) - debitC + creditC, fc.rounding);
  // float_is_zero: the value rounded to the currency is 0
  const zero = (v: number, r: number): boolean => roundPrecision(v, r) === 0;
  return { residual, residualCurrency, reconciled: zero(residual, cc.rounding) && zero(residualCurrency, fc.rounding) };
}

/**
 * account_move.py:7458-7495 `_get_accounting_date` with `_get_violated_lock_dates` (:7497-7504, company.py:817-880):
 * a date inside a locked period moves after the latest violated lock date, then the sequence's period rules apply (a
 * sale document keeps its date unless a lock date is violated). `hasTax` is `_affect_tax_report()` (:5468) when the
 * caller knows it (the journal's `accounting_date`: the context's has_tax, False); otherwise it is read from the stored
 * lines, and a move in edition whose tax lock date would decide refuses. Before round 13 any lock date set on the
 * company refused here, so no payment could be registered after the first closing (opus13_lock step 37).
 */
export async function accountingDate(env: Environment, rec: Rec, invoiceDate: string, hasTax: boolean | null = null): Promise<string> {
  const { violatedLockDates, accountingDateAfterLocks, affectsTaxReport } = await import("./account_locks");
  const company = Number(await rec.get("company_id"));
  const journal = await rec.rel("journal_id");
  const jtype = journal ? ((await journal.get("type")) as string | null) : null;
  let locks = await violatedLockDates(env, company, invoiceDate, false, jtype);
  if (hasTax !== false) {
    const withTax = await violatedLockDates(env, company, invoiceDate, true, jtype);
    if (withTax.length !== locks.length) {
      if (hasTax === null) {
        if (rec.origin === null || rec.id === null) throw new NotPorted("accounting date of a move in edition under a tax lock date (_affect_tax_report)");
        hasTax = await affectsTaxReport(env, rec.origin);
      }
      if (hasTax) locks = withTax;
    }
  }
  const today = await contextToday(env);
  const highest = ((await rec.get("highest_name")) || (await lastSequence(env, rec, true))) as string | null;
  const reset = highest ? deduceReset(String(highest)) : "never";
  return accountingDateAfterLocks(SALE_R.includes(await typeOf(rec)), invoiceDate, today, highest || null, reset, locks);
}

/** account_move.py:1212-1262 `_compute_amount` over the stored lines; lines still in edition are not ported. */
function moveAmount(which: string): (env: Environment, rec: Rec) => Promise<number> {
  return async (_env, rec) => {
    let untaxed = 0, untaxedC = 0, tax = 0, taxC = 0, total = 0, totalC = 0, reconciled = 0;
    const t = await typeOf(rec);
    const invoice = SALE_R.includes(t) || PURCHASE_R.includes(t);
    for (const line of await rec.rels("line_ids")) {
      if (line.origin === null) throw new NotPorted("account.move amounts of lines in edition");
      const dt = String(await line.get("display_type"));
      const b = plainNumber(await line.get("balance")), c = plainNumber(await line.get("amount_currency"));
      if (invoice) {
        if (dt === "tax" || dt === "non_deductible_tax" || (dt === "rounding" && (await line.get("tax_repartition_line_id")))) { tax += b; taxC += c; total += b; totalC += c; }
        else if (["product", "rounding", "non_deductible_product", "non_deductible_product_total"].includes(dt)) { untaxed += b; untaxedC += c; total += b; totalC += c; }
        else if (dt === "payment_term") reconciled += b - plainNumber(await line.get("amount_residual"));
      } else if (await line.get("debit")) { total += b; totalC += c; }
    }
    const sign = t === "entry" || ["out_refund", "in_invoice", "in_receipt"].includes(t) ? 1 : -1;
    const amountTotal = sign * totalC;
    const totals = (await rec.get("tax_totals")) as { total_amount?: unknown } | null;
    switch (which) {
      case "untaxed": return sign * untaxedC;
      case "tax": return sign * taxC;
      case "total": return amountTotal;
      case "untaxed_signed": return -untaxed;
      case "untaxed_currency_signed": return -untaxedC;
      case "tax_signed": return -tax;
      case "total_signed": return t === "entry" ? Math.abs(total) : -total;
      case "total_currency_signed": return t === "entry" ? Math.abs(amountTotal) : -(sign * amountTotal);
      default: return -sign * plainNumber(totals?.total_amount) - reconciled;
    }
  };
}

registerRecordCompute("account.move", {
  // account_move.py:984-987 _compute_is_storno: a refund of a storno company
  is_storno: async (_env, rec) => {
    if (await rec.prev("is_storno")) return true;
    if (!["out_refund", "in_refund"].includes(await typeOf(rec))) return false;
    const company = await rec.rel("company_id");
    return Boolean(company && (await company.get("account_storno")));
  },
  // account_move.py:932-940 _compute_company_id
  company_id: async (env, rec) => {
    const journal = await rec.rel("journal_id");
    const jc = journal ? num(await journal.get("company_id")) : null;
    const current = num(await rec.prev("company_id"));
    const parents = async (c: number | null): Promise<string[]> => {
      if (c === null) return [];
      return ((await env.cr.query<{ p: string }>("SELECT parent_path AS p FROM res_company WHERE id = $1", [c])).rows[0]?.p ?? "").split("/");
    };
    if (jc !== null && (await parents(current)).includes(String(jc))) return current;
    const company = await env.company();
    if (jc !== null && (await parents(company)).includes(String(jc))) return company;
    return jc ?? company;
  },
  // account_move.py:942-944 _compute_journal_id with :955-983 _search_default_journal (the currency branch needs a
  // currency in cache: not on a first compute)
  journal_id: async (env, rec) => {
    const types = await validJournalTypes(env, rec);
    const current = await rec.prev("journal_id");
    if (typeof current === "number" && current) {
      const type = (await env.cr.query<{ t: string }>("SELECT type AS t FROM account_journal WHERE id = $1", [current])).rows[0]?.t;
      if (type !== undefined && types.includes(type)) return current;
    }
    const company = num(await rec.get("company_id")) ?? await env.company();
    const found = await env.model("account.journal").search(and([cond("company_id", "in", [company, false]), cond("type", "in", types)]), { limit: 1 });
    if (!found[0]) throw new NotPorted("no journal for the move (_build_no_journal_error_msg)");
    return found[0];
  },
  // account_move.py:1150-1159 _compute_currency_id
  currency_id: async (_env, rec) => {
    const statement = await rec.rel("statement_line_id");
    const foreign = statement ? await statement.get("foreign_currency_id") : null;
    if (foreign) return foreign;
    const journal = await rec.rel("journal_id");
    const own = journal ? await journal.get("currency_id") : null;
    if (own) return own;
    const current = await rec.prev("currency_id");
    if (current) return current;
    const company = journal ? await journal.rel("company_id") : null;
    return company ? (await company.get("currency_id")) || null : null;
  },
  // account_move.py:902-917 _compute_date (:897-899 _get_accounting_date_source)
  date: async (env, rec) => {
    const current = await rec.prev("date");
    const invoiceDate = await rec.get("invoice_date");
    const source = invoiceDate || current;
    const t = await typeOf(rec);
    if (!source || !(SALE_R.includes(t) || PURCHASE_R.includes(t))) return current || contextToday(env);
    if (SALE_R.includes(t)) return source;
    return accountingDate(env, rec, String(source));
  },
  // account_move.py:994-1011 _compute_name without a number to assign
  name: async (env, rec) => {
    const current = await rec.prev("name");
    const state = await rec.get("state");
    if (state === "cancel") return current;
    const date = await rec.get("date");
    const hasName = current && current !== "/";
    if (!(await rec.get("posted_before")) && hasName && date && !(await sequenceMatchesDate(env, String(current), String(date)))) return null;
    if (date && !hasName && state !== "draft") throw new NotPorted("account.move.name of a posted move from the compute (_set_next_sequence)");
    return current;
  },
  // account_move.py:1066-1069 _compute_commercial_partner_id
  commercial_partner_id: async (_env, rec) => {
    const partner = await rec.rel("partner_id");
    return partner ? (await partner.get("commercial_partner_id")) || null : null;
  },
  // account_move.py:1071-1078 _compute_partner_shipping_id
  partner_shipping_id: async (env, rec) => {
    const t = await typeOf(rec);
    const partner = num(await rec.get("partner_id"));
    if (!(SALE_R.includes(t) || PURCHASE_R.includes(t)) || partner === null) return null;
    return (await addressGet(env, partner, ["delivery"]))["delivery"] ?? null;
  },
  // account_move.py:1080-1094 _compute_fiscal_position_id
  fiscal_position_id: async (env, rec) => {
    const company = num(await rec.get("company_id"));
    if (company === null) throw new NotPorted("account.move.fiscal_position_id without a company");
    if ((await typeOf(rec)) === "in_receipt") {
      const r = (await env.cr.query<{ f: number | null }>("SELECT account_purchase_receipt_fiscal_position_id AS f FROM res_company WHERE id = $1", [company])).rows[0]?.f;
      if (r) return r;
    }
    const partner = num(await rec.get("partner_id"));
    if (partner === null) return null;
    const delivery = num(await rec.get("partner_shipping_id")) ?? (await addressGet(env, partner, ["delivery"]))["delivery"] ?? null;
    return fiscalPositionFor(env, company, partner, delivery);
  },
  // account_move.py:851-866 _compute_invoice_default_sale_person
  invoice_user_id: async (env, rec) => {
    if (!SALE_R.includes(await typeOf(rec))) return null;
    const current = await rec.prev("invoice_user_id");
    const partner = await rec.rel("partner_id");
    if (!partner) return current;
    if (current) return current;
    const own = await partner.get("user_id");
    if (own) return own;
    const commercial = await partner.rel("commercial_partner_id");
    const cu = commercial ? await commercial.get("user_id") : null;
    if (cu) return cu;
    const share = (await env.cr.query<{ share: boolean }>("SELECT share FROM res_users WHERE id = $1", [env.uid])).rows[0]?.share;
    if (!share) return env.uid;
    return (await rec.get("create_uid")) || null;
  },
  // sale account_move.py:45-56 _compute_team_id
  team_id: async (env, rec) => {
    if (!SALE_R.includes(await typeOf(rec))) return rec.prev("team_id");
    const company = num(await rec.get("company_id"));
    const cenv = env.withContext({ ...env.context, allowed_company_ids: company === null ? [] : [company] });
    return defaultSalesTeam(cenv, num(await rec.get("invoice_user_id")), cond("id", "!=", 0));
  },
  // account_move.py:1113-1121 _compute_invoice_payment_term_id
  invoice_payment_term_id: async (env, rec) => {
    const t = await typeOf(rec);
    const current = await rec.prev("invoice_payment_term_id");
    const sale = SALE_R.includes(t), purchase = PURCHASE_R.includes(t);
    if (!sale && !purchase) return null;
    const partner = num(await rec.get("partner_id"));
    if (partner === null) return current;
    const company = num(await rec.get("company_id"));
    const cenv = company === null ? env : await withCompanyEnv(env, company);
    const term = await new DbRec(cenv, env.reg.model("res.partner"), partner).get(sale ? "property_payment_term_id" : "property_supplier_payment_term_id");
    return term || current;
  },
  // account_move.py:1095-1108 _compute_partner_bank_id
  partner_bank_id: async (env, rec) => {
    return movePartnerBank(env, await typeOf(rec), Number(await rec.get("company_id")), num(await rec.get("commercial_partner_id")),
      num(await rec.get("preferred_payment_method_line_id")));
  },
  // account_move.py:2066-2082 _compute_narration (account.use_invoice_terms off keeps the value)
  narration: async (env, rec) => {
    const on = (await env.cr.query<{ v: string }>("SELECT value AS v FROM ir_config_parameter WHERE key = 'account.use_invoice_terms'")).rows[0]?.v;
    if (on && on !== "False" && SALE_R.includes(await typeOf(rec))) throw new NotPorted("account.move.narration with invoice terms");
    return rec.prev("narration");
  },
  // account_move.py preferred_payment_method_line_id compute
  preferred_payment_method_line_id: async (env, rec) => {
    const partner = num(await rec.get("partner_id"));
    if (partner === null) return null;
    const company = num(await rec.get("company_id"));
    const cenv = company === null ? env : await withCompanyEnv(env, company);
    const field = SALE.includes(await typeOf(rec)) ? "property_inbound_payment_method_line_id" : "property_outbound_payment_method_line_id";
    return (await new DbRec(cenv, env.reg.model("res.partner"), partner).get(field)) || null;
  },
  // account_move.py:2336-2339 _compute_incoterm
  invoice_incoterm_id: async (env, rec) => {
    if (!(await typeOf(rec)).startsWith("out_")) return rec.prev("invoice_incoterm_id");
    const company = await rec.rel("company_id");
    return company ? (await company.get("incoterm_id")) || null : null;
  },
  // account_move.py:1138-1139 and :2355-2356: `pass`, the value stays
  incoterm_location: async (_env, rec) => rec.prev("incoterm_location"),
  taxable_supply_date: async (_env, rec) => rec.prev("taxable_supply_date"),
  // account_move.py:2568-2591 _compute_invoice_cash_rounding_id: a matching method is not ported
  invoice_cash_rounding_id: async (env, rec) => {
    const current = await rec.prev("invoice_cash_rounding_id");
    if (!SALE_R.includes(await typeOf(rec)) || (await rec.get("state")) !== "draft") return current;
    const partner = await rec.rel("partner_id");
    const categories = partner ? (await partner.get("category_id")) as number[] : [];
    const preferred = num(await rec.get("preferred_payment_method_line_id"));
    const found = await env.model("account.cash.rounding").search(and([
      cond("company_id", "in", [Number(await rec.get("company_id")), false]),
      or([cond("currency_ids", "in", [Number(await rec.get("currency_id"))]), cond("partner_category_ids", "in", categories),
        cond("payment_method_line_ids", "in", preferred === null ? [] : [preferred])]),
    ]));
    if (found.length) throw new NotPorted("automatic cash rounding of an invoice");
    return current;
  },
  // account_move.py:880-887 _compute_payment_reference: only posted customer invoices get one
  payment_reference: async (_env, rec) => {
    const current = await rec.prev("payment_reference");
    if ((await rec.get("state")) === "posted" && (await typeOf(rec)) === "out_invoice" && !current) throw new NotPorted("account.move.payment_reference from the compute");
    return current;
  },
  // account_peppol account_move.py:92-115 _compute_peppol_move_state
  peppol_move_state: async (_env, rec) => {
    if (((await rec.get("peppol_response_ids")) as unknown[] | null ?? []).length) throw new NotPorted("account.move.peppol_move_state with responses");
    const state = await rec.get("state");
    if (state === "posted") throw new NotPorted("account.move.peppol_move_state of a posted move from the compute");
    if (state === "draft" && SALE_R.includes(await typeOf(rec)) && !(await rec.get("peppol_is_sent"))) return null;
    return rec.prev("peppol_move_state");
  },
  // account_move.py:1123-1128 _compute_invoice_date_due with :1410-1480 _compute_needed_terms (only the maturity dates)
  invoice_date_due: async (env, rec) => {
    const current = await rec.prev("invoice_date_due");
    const t = await typeOf(rec);
    const invoiceDate = await rec.get("invoice_date");
    const fallback = current || invoiceDate || null;
    if (!(SALE_R.includes(t) || PURCHASE_R.includes(t)) || !((await rec.get("invoice_line_ids")) as unknown[] | null ?? []).length) return fallback;
    const term = await rec.rel("invoice_payment_term_id");
    if (!term) return fallback;
    const dateRef = String(invoiceDate || (await rec.get("date")) || await contextToday(env));
    let due: string | null = null;
    for (const line of await term.rels("line_ids")) {
      const date = await dueDate(line, dateRef);
      if (due === null || date > due) due = date;
    }
    return due ?? fallback;
  },
  // account_move.py:2560-2566 _compute_document_tax_mode
  document_tax_mode: async (env, rec) => {
    const t = await typeOf(rec);
    if (!(SALE_R.includes(t) || PURCHASE_R.includes(t))) return null;
    const current = await rec.prev("document_tax_mode");
    if (current) return current;
    const company = num(await rec.get("company_id")) ?? await env.company();
    return (await env.cr.query<{ m: string | null }>("SELECT account_price_include AS m FROM res_company WHERE id = $1", [company])).rows[0]?.m ?? null;
  },
  // account_move.py:845-848 _compute_qr_code_method
  qr_code_method: async (env, rec) => {
    const partner = num(await rec.get("commercial_partner_id"));
    if (partner === null) return null;
    const company = num(await rec.get("company_id"));
    const cenv = company === null ? env : await withCompanyEnv(env, company);
    return (await new DbRec(cenv, env.reg.model("res.partner"), partner).get("qr_code_method")) || null;
  },
  // sale_stock account_move.py:97-108 _compute_delivery_date (account: `pass`)
  // for a draft move: the latest effective date of the lines' orders, in the environment's zone (context_timestamp)
  delivery_date: async (env, rec) => {
    if ((await rec.get("state")) !== "draft") return rec.prev("delivery_date");
    let latest: string | null = null;
    for (const line of await rec.rels("line_ids")) {
      for (const saleLine of await line.rels("sale_line_ids")) {
        const order = await saleLine.rel("order_id");
        const effective = order ? await order.get("effective_date") : false;
        if (typeof effective === "string" && effective && (latest === null || effective > latest)) latest = effective;
      }
    }
    if (latest === null) return rec.prev("delivery_date");
    return contextDay(env, latest);
  },
  // account_move.py:1212-1262 _compute_amount of a move without journal items of its own yet: the tax summary gives
  // the residual; a stored move keeps the amounts of its lines (written with them)
  amount_residual: async (_env, rec) => {
    if (rec.id !== null && rec.origin !== null) return (await rec.prev("amount_residual")) ?? 0;
    if (rec.id === null && rec.origin !== null) {
      for (const line of await rec.rels("line_ids")) {
        if ((await line.get("display_type")) === "payment_term" && (await line.get("balance")) !== (await line.get("amount_residual"))) throw new NotPorted("amount_residual of a reconciled move in edition");
      }
    }
    const totals = (await rec.get("tax_totals")) as { total_amount_currency?: unknown } | null;
    return plainNumber(totals?.total_amount_currency);
  },
  // account_move.py:1265-1356 _compute_payment_state of a move without reconciliation
  payment_state: async (env, rec) => {
    const current = await rec.prev("payment_state");
    if (current === "invoicing_legacy" || current === "blocked") return current;
    if (rec.origin !== null) {
      const partial = await env.cr.query(
        `SELECT 1 FROM account_partial_reconcile p JOIN account_move_line l ON l.id = p.debit_move_id OR l.id = p.credit_move_id WHERE l.move_id = $1 LIMIT 1`, [rec.origin]);
      if (partial.rows.length) {
        // a stored move (a dependency changed: `reconciled_payment_ids.state`, its state): the reconciliation as stored
        if (rec.id === null) throw new NotPorted("account.move.payment_state of a reconciled move in edition");
        const { moveRow, paymentState } = await import("./account_entries");
        const { currencyData } = await import("./account_taxes");
        const row = await moveRow(env, rec.origin);
        const state = await rec.get("state"), residual = Number((await rec.get("amount_residual")) ?? 0);
        if (state !== row.state || (await rec.get("move_type")) !== row.move_type) throw new NotPorted("account.move.payment_state of a reconciled move changed in edition");
        return paymentState(env, { ...row, payment_state: String(current || "not_paid") }, residual, (await currencyData(env, row.currency_id)).rounding);
      }
    }
    return "not_paid";
  },
  // account_move.py:1055-1063 _compute_always_tax_exigible
  always_tax_exigible: async (_env, rec) => {
    const t = await typeOf(rec);
    if (SALE_R.includes(t) || PURCHASE_R.includes(t)) return false;
    if (((await rec.get("line_ids")) as unknown[] | null ?? []).length) throw new NotPorted("account.move.always_tax_exigible of an entry with lines (_collect_tax_cash_basis_values)");
    return true;
  },
  amount_untaxed: moveAmount("untaxed"), amount_tax: moveAmount("tax"), amount_total: moveAmount("total"),
  amount_untaxed_signed: moveAmount("untaxed_signed"), amount_untaxed_in_currency_signed: moveAmount("untaxed_currency_signed"), amount_tax_signed: moveAmount("tax_signed"),
  amount_total_signed: moveAmount("total_signed"), amount_total_in_currency_signed: moveAmount("total_currency_signed"), amount_residual_signed: moveAmount("residual_signed"),
  // account_move.py:1996-2004 _compute_invoice_partner_display_info
  invoice_partner_display_name: async (env, rec) => {
    const partner = await rec.rel("partner_id");
    const shown = partner ? await partner.get("display_name") : false;
    if (shown) return shown;
    const email = await rec.get("invoice_source_email");
    if (email) return translate(env, "@From: %(email)s").replace("%(email)s", String(email));
    const creator = num(await rec.get("create_uid")) ?? env.uid;
    const name = (await env.cr.query<{ n: string }>("SELECT p.name AS n FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1", [creator])).rows[0]?.n;
    return translate(env, "#Created by: %s").replace("%s", String(name));
  },
  // sequence_mixin.py:183-191 _compute_split_sequence
  sequence_prefix: async (_env, rec) => splitSequence(String((await rec.get("name")) || "")).prefix,
  sequence_number: async (_env, rec) => splitSequence(String((await rec.get("name")) || "")).number,
  // account_move.py:919-923 _compute_auto_post_until
  auto_post_until: async (_env, rec) => {
    const auto = await rec.get("auto_post");
    return auto === "no" || auto === "at_date" ? null : rec.prev("auto_post_until");
  },
  // account_move.py:1182-1186 _compute_invoice_currency_rate
  invoice_currency_rate: async (_env, rec) => {
    const t = await typeOf(rec);
    return SALE_R.includes(t) || PURCHASE_R.includes(t) ? rec.get("expected_currency_rate") : rec.prev("invoice_currency_rate");
  },
});

// ------------------------------------------------------------------------------------------------ account.move.line

const NOTES = ["line_section", "line_subsection", "line_note"];
const moveOf = (line: Rec): Promise<Rec | null> => line.rel("move_id");
const moveTypeOf = async (line: Rec): Promise<string> => { const m = await moveOf(line); return m ? typeOf(m) : ""; };

/** account_move.py:8130-8133 `_get_lang`, as the env to read the product in. */
async function productEnv(env: Environment, move: Rec | null): Promise<Environment> {
  const partner = move ? await move.rel("partner_id") : null;
  const commercial = move ? await move.rel("commercial_partner_id") : null;
  const lang = (partner ? await partner.get("lang") : null) || (commercial ? await commercial.get("lang") : null);
  return lang && lang !== env.lang ? env.withContext({ ...env.context, lang: String(lang) }) : env;
}

/** account_move_line.py:654-666 `get_name` of `_compute_name`. */
async function lineProductName(env: Environment, line: Rec): Promise<string | false> {
  const product = await line.rel("product_id");
  if (!product || product.origin === null) return false;
  const move = await moveOf(line);
  const penv = await productEnv(env, move);
  const p = new DbRec(penv, env.reg.model("product.product"), product.origin);
  const journal = await line.rel("journal_id");
  const type = journal ? await journal.get("type") : null;
  const text = type === "sale" ? await p.get("description_sale") : type === "purchase" ? await p.get("description_purchase") : null;
  return typeof text === "string" && text ? text : false;
}

/** account product.py:125-164 `_get_product_accounts` with :166-174 `get_product_accounts` (the income and expense accounts). */
async function productAccount(env: Environment, line: Rec, kind: "income" | "expense" | "stock_valuation", move: Rec): Promise<number | null> {
  const product = await line.rel("product_id");
  const company = num(await line.get("company_id")) ?? await env.company();
  return mapAccount(await move.rel("fiscal_position_id"), await productAccountOf(env, product!, company, kind));
}

/**
 * account product.py:125-164 `_get_product_accounts` of a product in a company, without fiscal position. `stock_valuation`:
 * :135-136, the category hierarchy's `property_stock_valuation_account_id`, else the product's company's (or the
 * environment company's) `account_stock_valuation_id`.
 */
export async function productAccountOf(env: Environment, product: Rec, company: number, kind: "income" | "expense" | "stock_valuation"): Promise<number | null> {
  const cenv = await withCompanyEnv(env, company);
  const tmpl = new DbRec(cenv, env.reg.model("product.template"), Number(await product.get("product_tmpl_id")));
  if (kind === "stock_valuation") {
    let account: number | null = null;
    let categ = await tmpl.rel("categ_id");
    while (categ && account === null) {
      account = num(await categ.get("property_stock_valuation_account_id"));
      categ = await categ.rel("parent_id");
    }
    if (account === null) {
      const owner = num(await tmpl.get("company_id")) ?? await cenv.company();
      account = num(await new DbRec(cenv, env.reg.model("res.company"), owner).get("account_stock_valuation_id"));
    }
    return account;
  }
  let account = num(await tmpl.get(kind === "income" ? "property_account_income_id" : "property_account_expense_id"));
  if (account === null) {
    let categ = await tmpl.rel("categ_id");
    while (categ && account === null) {
      account = num(await categ.get(kind === "income" ? "property_account_income_categ_id" : "property_account_expense_categ_id"));
      categ = await categ.rel("parent_id");
    }
  }
  if (account === null) {
    const owner = num(await tmpl.get("company_id")) ?? await cenv.company();
    account = num(await new DbRec(cenv, env.reg.model("res.company"), owner).get(kind === "income" ? "income_account_id" : "expense_account_id"));
  }
  return account;
}

/** partner.py:177-178 map_account (:115-117 `_compute_account_map`). */
async function mapAccount(position: Rec | null, account: number | null): Promise<number | null> {
  if (!position || account === null) return account;
  for (const l of await position.rels("account_ids")) if ((await l.get("account_src_id")) === account) return Number(await l.get("account_dest_id"));
  return account;
}

/** account_move_line.py:1303-1344 `_get_computed_taxes` of a line of a sale or purchase document. */
async function computedTaxes(env: Environment, line: Rec, move: Rec): Promise<number[]> {
  const t = await typeOf(move);
  const sale = SALE_R.includes(t), purchase = PURCHASE_R.includes(t);
  const company = await line.rel("company_id");
  const companyId = company?.origin ?? null;
  if (company && sale && (await company.get("vat_disabled"))) throw new NotPorted("taxes of a company not subject to VAT");
  const account = await line.rel("account_id");
  const accountTaxes = account ? new DbRec(env.sudo(), env.reg.model("account.account"), account.origin!) : null;
  const allAccount = accountTaxes ? await accountTaxes.rels("tax_ids") : [];
  const product = await line.rel("product_id");
  let taxes: Rec[] = [];
  if (sale || purchase) {
    const su = product ? new DbRec(env.sudo(), env.reg.model("product.product"), product.origin!) : null;
    const own = su ? await su.rels(sale ? "taxes_id" : "supplier_taxes_id") : [];
    const companies = companyId === null ? [] : ((await env.cr.query<{ p: string }>("SELECT parent_path AS p FROM res_company WHERE id = $1", [companyId])).rows[0]?.p ?? "").split("/").filter(Boolean).map(Number);
    const filtered: Rec[] = [];
    for (const tax of own) if (companies.includes(Number(await tax.get("company_id")))) filtered.push(tax);
    const fromAccount: Rec[] = [];
    for (const tax of allAccount) if ((await tax.get("type_tax_use")) === (sale ? "sale" : "purchase")) fromAccount.push(tax);
    taxes = filtered.length ? filtered : fromAccount;
    if (sale && !taxes.length && !product && env.context["from_invoice_tab"] && !(await move.get("quick_edit_mode"))) {
      const dflt = company ? await company.rel("account_sale_tax_id") : null;
      if (dflt) taxes = [dflt];
    }
  } else if (!env.context["account_default_taxes"] && (env.context["skip_computed_taxes"] || (await move.get("move_type")) === "entry")) {
    taxes = []; // account_move_line.py:1330-1331: no computed taxes on a journal entry
  } else throw new NotPorted("account.move.line.tax_ids of a journal entry with the account's taxes");
  if (companyId !== null && taxes.length) taxes = await taxesOfCompany(env, taxes, companyId);
  const position = await move.rel("fiscal_position_id");
  return taxes.length ? mapTax(position, taxes) : [];
}

registerRecordCompute("account.move.line", {
  // account_move_line.py:622-635 _compute_display_type
  display_type: async (env, rec) => {
    const current = await rec.prev("display_type");
    if (current) return current;
    const t = await moveTypeOf(rec);
    if (!(SALE.includes(t) || PURCHASE.includes(t))) return "product";
    if (rec instanceof NewRec && rec.values.has("tax_line_id") && rec.values.get("tax_line_id")) return "tax";
    if (rec instanceof NewRec && rec.values.has("account_id") && rec.values.get("account_id")) {
      const type = (await env.cr.query<{ t: string }>("SELECT account_type AS t FROM account_account WHERE id = $1", [rec.values.get("account_id")])).rows[0]?.t;
      if (type === "asset_receivable" || type === "liability_payable") return "payment_term";
    }
    return "product";
  },
  // account_move_line.py:827-837 _compute_is_storno: nothing assigned outside a storno company
  is_storno: async (_env, rec) => {
    const company = await rec.rel("company_id");
    if (company && (await company.get("account_storno"))) throw new NotPorted("account.move.line.is_storno in a storno company");
    return rec.prev("is_storno");
  },
  // account_move_line.py:1696-1699 _compute_no_followup
  no_followup: async (_env, rec) => {
    const journal = await rec.rel("journal_id");
    return journal !== null && (await journal.get("type")) === "general";
  },
  // account_move_line.py:638-640 _compute_partner_id
  partner_id: async (_env, rec) => {
    const move = await moveOf(rec);
    const partner = move ? await move.rel("partner_id") : null;
    return partner ? (await partner.get("commercial_partner_id")) || null : null;
  },
  // account_move_line.py:1159-1219 _compute_amount_residual (amount_residual, amount_residual_currency, reconciled)
  amount_residual: async (env, rec) => (await lineResidual(env, rec)).residual,
  amount_residual_currency: async (env, rec) => (await lineResidual(env, rec)).residualCurrency,
  reconciled: async (env, rec) => (await lineResidual(env, rec)).reconciled,
  // account_move_line.py:890-896 _compute_amount_currency: the value already there stays; a line of an entry in the
  // company currency follows its balance. `line.amount_currency is False` never holds: the cache of a Monetary is a
  // float (fields_numeric.py:271-273 `float(value or 0.0)`), also the protected default of a new line without one
  // (measured on the oracle: a new line with a balance of 100 reads 0.0, in an entry in another currency too)
  amount_currency: async (_env, rec) => {
    const prev = await rec.prev("amount_currency");
    let value: unknown = prev;
    if (value === null || value === false || value === undefined) value = 0.0;
    const move = await moveOf(rec);
    const t = move ? await typeOf(move) : "";
    const company = await rec.rel("company_id");
    const companyCurrency = company ? await company.get("currency_id") : null;
    if ((await rec.get("currency_id")) === companyCurrency && !(SALE_R.includes(t) || PURCHASE_R.includes(t))) value = await rec.get("balance");
    return value;
  },
  // account_move_line.py:642-650 _compute_currency_id
  currency_id: async (_env, rec) => {
    if ((await rec.get("display_type")) === "cogs") return rec.get("company_currency_id");
    const move = await moveOf(rec);
    const t = move ? await typeOf(move) : "";
    if (SALE_R.includes(t) || PURCHASE_R.includes(t)) return (await move!.get("currency_id")) || null;
    const current = await rec.prev("currency_id");
    if (current) return current;
    const company = await rec.rel("company_id");
    return company ? (await company.get("currency_id")) || null : null;
  },
  // account_move_line.py:652-693 _compute_name of product lines (terms are written with their lines)
  name: async (env, rec) => {
    const current = await rec.prev("name");
    const dt = await rec.get("display_type");
    const move = await moveOf(rec);
    if (move && (await move.get("inalterable_hash"))) return current;
    if (dt === "payment_term" && move) {
      const term = await move.rel("invoice_payment_term_id");
      const reference = await move.get("payment_reference"), ref = await move.get("ref");
      let name = reference && ref && reference !== ref ? `${String(ref)} - ${String(reference)}`
        : reference ? reference : ["in_invoice", "in_refund"].includes(await typeOf(move)) && ref ? ref : false;
      if (term && (await term.rels("line_ids")).length > 1) {
        // :683-686 the line's place among the move's term lines by maturity (a new line comes last)
        if (!(rec instanceof DbRec) || move.origin === null) throw new NotPorted("account.move.line.name of an installment of a new record");
        const order = (await env.cr.query<{ id: number }>(
          "SELECT id FROM account_move_line WHERE move_id = $1 AND display_type = 'payment_term' ORDER BY COALESCE(date_maturity, '9999-12-31'::date), id", [move.origin])).rows.map((r) => r.id);
        const index = order.indexOf(rec.id!);
        name = installmentName(env, name ? String(name) : null, (index < 0 ? order.length : index) + 1);
      }
      return (name as string | false) || current;
    }
    const product = await rec.rel("product_id");
    if (!product || NOTES.includes(String(dt))) return current;
    // `line._origin`: a stored record recomputed after a write is its own origin (recomputing it when `move_id.ref`
    // changes keeps a label typed by hand)
    const origin = rec instanceof NewRec ? rec.originRec : rec instanceof DbRec ? rec : null;
    const originProduct = origin ? await origin.get("product_id") : null;
    const stale = origin ? (await origin.get("name")) === (await lineProductName(env, origin)) : !current;
    if (!current || stale || product.origin !== originProduct) return (await lineProductName(env, rec)) || null;
    return current;
  },
  // account_move_line.py:723-... _compute_account_id without payment term lines
  account_id: async (env, rec) => {
    const dt = await rec.get("display_type");
    if (dt === "payment_term") throw new NotPorted("account.move.line.account_id of a payment term line from the compute");
    const current = num(await rec.prev("account_id"));
    const move = await moveOf(rec);
    if (!move) return current;
    const t = await typeOf(move);
    const sale = SALE_R.includes(t), purchase = PURCHASE_R.includes(t);
    let account = current;
    if (dt === "product" && (sale || purchase) && (await rec.get("product_id"))) {
      if (sale) account = (await productAccount(env, rec, "income", move)) ?? account;
      else {
        account = (await productAccount(env, rec, "expense", move)) ?? account;
        // :789-791 a stored product valued in real time (`_use_inventory_valuation` :3818-3827; stock_dropshipping's and
        // repair's overrides are not in the templates, and a site's would be a refused key): the stock valuation account
        const product = (await rec.rel("product_id"))!;
        if ((await product.get("valuation")) === "real_time" && (await product.get("is_storable"))) {
          account = (await productAccount(env, rec, "stock_valuation", move)) ?? account;
        }
      }
    }
    if (account !== null || NOTES.includes(String(dt))) return account;
    const siblings: number[] = [];
    for (const l of await move.rels("line_ids")) {
      const a = num(await l.get("account_id"));
      if (a !== null && (await l.get("display_type")) === dt) siblings.push(a);
    }
    const lastTwo = new Set(siblings.slice(-2));
    if (lastTwo.size === 1 && (await move.rels("line_ids")).length > 2) return [...lastTwo][0]!;
    const journal = await move.rel("journal_id");
    return journal ? num(await journal.get("default_account_id")) : null;
  },
  // account_move_line.py:1226-1234 _compute_product_uom_id
  product_uom_id: async (env, rec) => {
    const current = await rec.prev("product_uom_id");
    const move = await moveOf(rec);
    if ((move ? await move.get("state") : "draft") !== "draft") return current;
    const product = await rec.rel("product_id");
    if (!product) return null;
    if (PURCHASE.includes(await moveTypeOf(rec))) {
      // product_supplierinfo.py:143-145 `_get_filtered_supplier`
      const company = num(await rec.get("company_id"));
      const sellers = await new DbRec(env.sudo(), env.reg.model("product.product"), product.origin!).rels("seller_ids");
      for (const s of sellers) {
        const sc = num(await s.get("company_id")), sp = num(await s.get("product_id"));
        const partner = await s.rel("partner_id");
        if ((sc !== null && sc !== company) || !partner || !(await partner.get("active")) || (sp !== null && sp !== product.origin)) continue;
        if (partner.origin !== num(await rec.get("partner_id"))) continue;
        const uom = await s.get("uom_id");
        if (uom) return uom;
        break;
      }
    }
    return (await product.get("uom_id")) || null;
  },
  // account_move_line.py:1236-1242 _compute_quantity
  quantity: async (_env, rec) => {
    if ((await rec.get("display_type")) !== "product") return false;
    return (await rec.prev("quantity")) || 1;
  },
  // account_move_line.py:1244-1252 _compute_sequence
  sequence: async (_env, rec) => ({ tax: 10000, rounding: 11000, payment_term: 12000 } as Record<string, number>)[String(await rec.get("display_type"))] ?? 100,
  // account_move_line.py:1273-1292 _compute_price_unit with account product.py:362-424 `_get_tax_included_unit_price`
  price_unit: async (env, rec) => {
    const current = await rec.prev("price_unit");
    const product = await rec.rel("product_id");
    if (!product || NOTES.includes(String(await rec.get("display_type"))) || (await rec.get("is_imported"))) return current;
    const move = (await moveOf(rec))!;
    const t = await typeOf(move);
    const sale = SALE_R.includes(t), purchase = PURCHASE_R.includes(t);
    if (!sale && !purchase) return 0;
    const company = Number(await move.get("company_id"));
    const cenv = await withCompanyEnv(env, company);
    const p = new DbRec(cenv, env.reg.model("product.product"), product.origin!);
    const companyCurrency = (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [company])).rows[0]!.c;
    const productCurrency = sale ? await p.get("currency_id") : companyCurrency;
    let price = plainNumber(await p.get(sale ? "lst_price" : "standard_price"));
    const taxes = await taxesOfCompany(env, await new DbRec(env.sudo(), env.reg.model("product.product"), product.origin!).rels(sale ? "taxes_id" : "supplier_taxes_id"), company);
    const uom = num(await rec.get("product_uom_id")), productUom = num(await p.get("uom_id"));
    if (uom !== null && uom !== productUom) price = await uomPrice(env, price, productUom, uom);
    const mode = await rec.get("document_tax_mode");
    if (mode) price = await adaptToDocumentTaxMode(env, p, taxes, mode, price);
    const position = await move.rel("fiscal_position_id");
    if (taxes.length && position) {
      const mapped = await mapTax(position, taxes);
      const same = mapped.length === taxes.length && mapped.every((id, i) => id === taxes[i]!.origin);
      if (!same && (await env.cr.query("SELECT 1 FROM account_tax WHERE id = ANY($1::int[]) AND price_include_override = 'tax_included'", [taxes.map((x) => x.origin)])).rows.length) {
        throw new NotPorted("account.move.line price through a fiscal position mapping included taxes (_adapt_price_unit_to_another_taxes)");
      }
      if (!same && mode === "tax_included") throw new NotPorted("account.move.line price of a tax included document through a fiscal position mapping");
    }
    // product.py:420-422: the price converted unrounded at the move's date (`_get_conversion_rate`: today without one)
    const moveCurrency = await move.get("currency_id");
    if (moveCurrency !== productCurrency) {
      if (typeof moveCurrency !== "number" || typeof productCurrency !== "number") throw new NotPorted("account.move.line price without a currency");
      const date = ((await move.get("date")) as string | false | null) || await contextToday(env);
      price = await convertAmount(env, price, productCurrency, moveCurrency, company, String(date), false);
    }
    return price;
  },
  // account_move_line.py:1294-1301 _compute_tax_ids
  tax_ids: async (env, rec) => {
    const current = (await rec.prev("tax_ids")) as number[] | null ?? [];
    const dt = await rec.get("display_type");
    if ([...NOTES, "payment_term", "cogs"].includes(String(dt)) || (await rec.get("is_imported"))) return current;
    const move = await moveOf(rec);
    if (!move) return current;
    const account = await rec.rel("account_id");
    const accountTaxes = account ? ((await new DbRec(env.sudo(), env.reg.model("account.account"), account.origin!).get("tax_ids")) as number[]) : [];
    if ((await rec.get("product_id")) || (dt !== "discount" && (accountTaxes.length || !current.length))) return computedTaxes(env, rec, move);
    return current;
  },
  // account_move_line.py:1254-1271 _compute_totals
  price_subtotal: async (env, rec) => (await lineTotals(env, rec)).subtotal,
  price_total: async (env, rec) => (await lineTotals(env, rec)).total,
});
defineComputes("account.move.line", {
  // account_move_line.py:695-713 _compute_label
  label: async (env, rec) => {
    const name = (await rec.get("name")) as string | false | null;
    const product = await rec.rel("product_id");
    if (!product || product.origin === null) return name || false;
    const penv = await productEnv(env, await moveOf(rec));
    const display = String((await new DbRec(penv.withContext({ ...penv.context, display_default_code: env.context["display_default_code"] ?? true }), env.reg.model("product.product"), product.origin).get("display_name")));
    if (!name) return display;
    return name.split(/\r\n|\r|\n/)[0] === display ? name : `${display}\n${name}`;
  },
});

async function lineTotals(env: Environment, rec: Rec): Promise<{ subtotal: unknown; total: unknown }> {
  const move = await moveOf(rec);
  // account_move_line.py:1262-1264 `price_total = price_subtotal = False`: a Monetary's cache of False is 0.0
  // (fields_numeric.py:271-273 `float(value or 0.0)`)
  if (!["product", "cogs", "non_deductible_product", "non_deductible_product_total"].includes(String(await rec.get("display_type"))) || !move) return { subtotal: 0, total: 0 };
  const company = await companyData(env, num(await rec.get("company_id")) ?? await env.company());
  const t = await typeOf(move);
  const sign = t === "entry" || ["out_refund", "in_invoice", "in_receipt"].includes(t) ? 1 : -1;
  const currency = await currencyData(env, Number(await rec.get("currency_id")));
  const base = await productBaseLine(env, rec, { sign, rate: plainNumber(await move.get("invoice_currency_rate")), currency, mode: await rec.get("document_tax_mode"),
    // a stored line of a move that is no invoice (a new move type); a new entry line's totals are its amount, set by
    // its create (createEntryLine), whose balance is not known yet here
    entry: rec.id !== null && !(SALE_R.includes(t) || PURCHASE_R.includes(t)) });
  accountTaxHelpers.add_tax_details_in_base_lines([base], company);
  accountTaxHelpers.round_base_lines_tax_details([base], company);
  const details = base.tax_details as unknown as { total_excluded_currency: number; total_included_currency: number };
  return { subtotal: details.total_excluded_currency, total: details.total_included_currency };
}

// ------------------------------------------------------------------------------------------------ writing invoices

type Row = Record<string, unknown>;
const round = (v: number, r: number): number => roundPrecision(v, r);

/** account_move.py:1410-1480 `_compute_needed_terms` of a saved draft: [maturity, balance, amount_currency]. */
/** account_move_line.py:686 `_('%(name)s installment #%(number)s', ...).lstrip()` (account's .po in the env's language). */
export function installmentName(env: Environment | null, name: string | null, number: number): string {
  const text = env === null ? "%(name)s installment #%(number)s" : translate(env, "%(name)s installment #%(number)s", "account");
  return text.replace("%(name)s", () => name ?? "").replace("%(number)s", String(number)).trimStart();
}

interface NeededTerm { date: string | null; balance: number; amount: number; discountDate: string | null; discountBalance: number; discountAmount: number }

async function neededTerms(env: Environment, move: Row, total: number, totalCurrency: number): Promise<NeededTerm[]> {
  const term = move["invoice_payment_term_id"] as number | null;
  const due = (move["invoice_date_due"] as string | null) ?? (move["invoice_date"] as string | null) ?? null;
  // account_move.py:1469-1476 without a payment term: one term line maturing on `invoice_date_due` (False when unset)
  // (also of a zero total without a due date: before round 11 none, so a bill of nothing received had no payment term line)
  if (!term) return [{ date: due, balance: total, amount: totalCurrency, discountDate: null, discountBalance: 0, discountAmount: 0 }];
  const rec = new DbRec(env, env.reg.model("account.payment.term"), term);
  const lines = await rec.rels("line_ids");
  const dateRef = String(move["invoice_date"] ?? move["date"] ?? await contextToday(env));
  const company = await currencyData(env, Number(move["company_currency_id"]));
  const currency = await currencyData(env, Number(move["currency_id"]));
  // account_payment_term.py:190-206 the early discount: its date (the reference date plus the discount days) and the
  // amount due after it on every term line (account_move.py:1451-1463); 'included' discounts the total, 'excluded'
  // and 'mixed' only the untaxed amount ('mixed' also adds lines to the invoice: not ported, nor 'excluded' here)
  let discountDate: string | null = null, discountBalance = 0, discountAmount = 0;
  if (await rec.get("early_discount")) {
    const computation = await rec.get("early_pay_discount_computation");
    if (computation !== "included") throw new NotPorted(`payment terms with an early discount computed ${String(computation)} (_compute_terms)`);
    if (lines.length !== 1) throw new NotPorted("payment terms with an early discount and several lines");
    const pct = Number(plainNumber(await rec.get("discount_percentage")) ?? 0) / 100.0;
    const days = Number((await rec.get("discount_days")) ?? 0);
    const d = new Date(`${dateRef}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    discountDate = d.toISOString().slice(0, 10);
    discountBalance = round(total * (1 - pct), company.rounding);
    discountAmount = round(totalCurrency * (1 - pct), currency.rounding);
  }
  const sign = (await isInbound(String(move["move_type"]))) ? 1 : -1;
  const rate = total ? Math.abs(totalCurrency / total) : 0;
  let residual = total, residualC = totalCurrency;
  const out = new Map<string, NeededTerm>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const date = await dueDate(line, dateRef);
    let balance: number, amount: number;
    if (i === lines.length - 1) { balance = residual; amount = residualC; }
    else if ((await line.get("value")) === "fixed") {
      const value = plainNumber(await line.get("value_amount"));
      balance = rate ? sign * round(value / rate, company.rounding) : 0;
      amount = sign * round(value, currency.rounding);
    } else {
      const value = plainNumber(await line.get("value_amount"));
      balance = round(total * (value / 100), company.rounding);
      amount = round(totalCurrency * (value / 100), currency.rounding);
    }
    residual -= balance; residualC -= amount;
    const e = out.get(date);
    if (e) { e.balance += balance; e.amount += amount; } else out.set(date, { date, balance, amount, discountDate, discountBalance, discountAmount });
  }
  return [...out.values()];
}
const isInbound = async (t: string): Promise<boolean> => ["out_invoice", "in_refund", "out_receipt"].includes(t);

/** Creation of a product line of an invoice: the stored fields of `account.move.line` (balance and tax lines come from the sync). */
async function createInvoiceLine(env: Environment, moveId: number, vals: Row): Promise<number> {
  const def = env.reg.model("account.move.line");
  const line = new NewRec(env, def, null);
  const saleLines: number[] = [];
  // models.py create: the fields given in the values are protected from their computes (an empty name stays empty)
  for (const k of Object.keys(vals)) if (k !== "label" && def.fields.has(k)) line.protectedFields.add(k);
  await line.set("move_id", moveId);
  for (const [k, v] of Object.entries(vals)) {
    if (k === "tax_ids") {
      // the commands on an empty set (Command.clear on a new line leaves it empty, round 11)
      const ids = taxesAfter([], v);
      await line.set("tax_ids", ids);
    } else if (k === "sale_line_ids") {
      // sale account_move_line.py: Command.link of the order lines, or Command.set (a copy's business fields)
      for (const c of v as unknown[][]) {
        if (c[0] === 4) saleLines.push(Number(c[1]));
        else if (c[0] === 6) { for (const id of (c[2] as number[]) ?? []) if (!saleLines.includes(Number(id))) saleLines.push(Number(id)); }
        else throw new NotPorted("sale_line_ids commands of a new invoice line");
      }
    } else if (k !== "label") await line.set(k, v);
  }
  // account_move_line.py:715-723 _inverse_label
  if ("label" in vals) {
    const label = vals["label"] as string | false | null;
    const product = await line.rel("product_id");
    if (product && label) {
      const penv = await productEnv(env, await moveOf(line));
      const display = String(await new DbRec(penv, env.reg.model("product.product"), product.origin!).get("display_name"));
      await line.set("name", (label.startsWith(display) ? label.slice(display.length) : label).replace(/^\n/, ""));
    } else await line.set("name", label ?? false); // :723 `line.name = line.label`: an empty label stays empty
  }
  const m = (await env.cr.query<{ r: Row }>("SELECT row_to_json(x) AS r FROM (SELECT m.*, c.currency_id AS company_currency_id FROM account_move m JOIN res_company c ON c.id = m.company_id WHERE m.id = $1) x", [moveId])).rows[0]!.r;
  const value = async (f: string): Promise<unknown> => { const v = await line.get(f); return v === false || v === undefined ? null : v; };

  // analytic_mixin.py `_compute_analytic_distribution` (precomputed when not given), account_move_line.py:1599-1612 with
  // sale account_move_line.py:45-49 `_related_analytic_distribution`: a product line takes its first sale line's
  // distribution, as the order line holds it (not sanitized: an order line's computed {"27": 100} stays an integer),
  // `| _get_distribution(...)` (no distribution models) `or line.analytic_distribution` (none on a new line)
  let relatedAnalytic: string | null = null;
  if (!("analytic_distribution" in vals) && saleLines.length && (await line.get("display_type")) === "product") {
    const first = (await env.cr.query<{ t: string | null }>(
      "SELECT analytic_distribution::text AS t FROM sale_order_line WHERE id = ANY($1::int[]) ORDER BY order_id, sequence, id LIMIT 1", [saleLines])).rows[0];
    if (first?.t && first.t !== "{}") {
      const models = (await env.cr.query<{ n: string }>("SELECT count(*)::text AS n FROM account_analytic_distribution_model")).rows[0]?.n;
      if (Number(models ?? 0)) throw new NotPorted("account.move.line analytic distribution models (_get_distribution)");
      // sale_project account_move_line.py:17-23: the context's project overrides the computed distribution
      if (env.context["project_id"]) throw new NotPorted("account.move.line analytic distribution with a project_id in the context");
      relatedAnalytic = first.t;
      await line.set("analytic_distribution", JSON.parse(first.t));
    }
  }
  // a Char given as '' is stored as '' (fields_textual.py:110-118 only maps None/False to NULL): the record cache reads it as false
  const given = (await line.get("name")) === false && ("label" in vals ? vals["label"] === "" : vals["name"] === "") ? "" : undefined;
  // a Boolean given in the create values is stored as given (fields_misc.py:27 `bool(value)`); absent, the column stays NULL
  const flag = async (f: string): Promise<unknown> => (f in vals ? Boolean(vals[f]) : value(f));
  const id = await insertRow(env, "account_move_line", {
    move_id: moveId, journal_id: m["journal_id"], company_id: m["company_id"], company_currency_id: m["company_currency_id"], move_name: m["name"], parent_state: m["state"],
    ref: m["ref"], date: m["date"], invoice_date: m["invoice_date"], display_type: await value("display_type"), sequence: await value("sequence"), account_id: await value("account_id"),
    currency_id: await value("currency_id"), partner_id: await value("partner_id"), product_id: await value("product_id"), product_uom_id: await value("product_uom_id"), name: given ?? await value("name"),
    // a Float False is stored as 0.0 (fields_numeric.py Float.convert_to_column): the quantity of a section or note
    quantity: (await line.get("quantity")) === false ? 0 : await value("quantity"), price_unit: plainNumber(await line.get("price_unit")), discount: plainNumber(await line.get("discount")), deductible_percentage: plainNumber((await line.get("deductible_percentage")) ?? 1),
    price_subtotal: plainNumber(await line.get("price_subtotal")), price_total: plainNumber(await line.get("price_total")), debit: 0, credit: 0, balance: 0, amount_currency: 0,
    // account_move_line.py:1213-1216 `reconciled` is a zero residual: a section or note line (no amounts) is reconciled
    amount_residual: 0, amount_residual_currency: 0, reconciled: NOTES.includes(String(await line.get("display_type"))), is_storno: false, no_followup: false, collapse_composition: await flag("collapse_composition"),
    collapse_prices: await flag("collapse_prices"), is_downpayment: await flag("is_downpayment"), is_imported: await flag("is_imported"),
    // analytic_mixin.py:175-180 create `_sanitize_values`: rounded Python floats
    analytic_distribution: vals["analytic_distribution"] ? await sanitizedAnalyticJson(env, vals["analytic_distribution"]) : relatedAnalytic,
    // fields_misc.py:70-77 Json: the given value (a down payment's manual tax amounts, sale_order_line.py:2070), floats
    // with their decimal point; falsy is NULL
    extra_tax_data: vals["extra_tax_data"] && typeof vals["extra_tax_data"] === "object" && Object.keys(vals["extra_tax_data"] as object).length ? dumps(vals["extra_tax_data"]) : null,
  });
  // the other stored fields given in the values: the purchase line (purchase account_invoice.py) is a plain column; any
  // other one would be dropped here, so it refuses (the balance is the synced amount, checked by the caller)
  // the stored columns a copy gives (account_move_line.py:2422 copy_data), written as given (the amounts below are the
  // sync's; a copied amount_currency must be the one the sync computes, checked there)
  const copied: Row = {};
  for (const k of ["tax_base_amount", "discount_amount_currency", "discount_balance", "discount_date", "date_maturity", "group_tax_id", "tax_repartition_line_id", "stock_move_id", "is_storno", "no_followup"]) {
    // Float fields hold 0.0 for False (fields_numeric.py convert_to_cache), dates and many2ones NULL
    const floats = ["tax_base_amount", "discount_amount_currency", "discount_balance"];
    if (k in vals) copied[k] = vals[k] === false ? (["is_storno", "no_followup"].includes(k) ? false : floats.includes(k) ? 0 : null) : plainNumber(vals[k]);
  }
  if (Object.keys(copied).length) await updateRow(env, "account_move_line", id, copied);
  if ("tax_tag_ids" in vals) {
    const tags = ((vals["tax_tag_ids"] as unknown[][] | false) || []).flatMap((c) => (c[0] === 6 ? (c[2] as number[]) : c[0] === 4 ? [Number(c[1])] : []));
    for (const t of tags) await env.cr.query("INSERT INTO account_account_tag_account_move_line_rel (account_move_line_id, account_account_tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [id, t]);
  }
  // only a product line's amount is the sync's to check (a section or note line has none)
  if ("amount_currency" in vals && (await line.get("display_type")) === "product") givenAmountsOf(env).set(id, Number(plainNumber(vals["amount_currency"])));
  const inserted = new Set(["tax_base_amount", "discount_amount_currency", "discount_balance", "discount_date", "date_maturity", "group_tax_id", "tax_repartition_line_id",
    "stock_move_id", "extra_tax_data", "tax_tag_ids", "amount_currency", "move_id", "journal_id", "company_id", "company_currency_id", "move_name", "parent_state", "ref", "date", "invoice_date", "display_type", "sequence", "account_id",
    "currency_id", "partner_id", "product_id", "product_uom_id", "name", "quantity", "price_unit", "discount", "deductible_percentage", "price_subtotal", "price_total", "debit", "credit",
    "balance", "amount_currency", "amount_residual", "amount_residual_currency", "reconciled", "is_storno", "no_followup", "collapse_composition", "collapse_prices", "is_downpayment",
    "is_imported", "analytic_distribution", "tax_ids", "sale_line_ids", "label"]);
  for (const k of Object.keys(vals)) {
    const f = def.fields.get(k);
    if (inserted.has(k) || !f || !f.store || f.inheritedFrom) continue;
    if (k === "purchase_line_id") { await updateRow(env, "account_move_line", id, { purchase_line_id: vals[k] || null }); continue; }
    // a plain stored field (a module's flag: stock_landed_costs' is_landed_costs_line) that nothing stored is computed
    // from: its column as given (convert_to_column; False is NULL, a boolean's is false)
    if (plainColumn(env, f)) {
      const v = vals[k];
      await updateRow(env, "account_move_line", id, { [k]: f.type === "boolean" ? Boolean(v) : v === false || v === undefined ? null : v });
      continue;
    }
    throw new NotPorted(`account.move.line field ${k} given at creation of an invoice line`);
  }
  for (const sale of saleLines) await env.cr.query("INSERT INTO sale_order_line_invoice_rel (invoice_line_id, order_line_id) VALUES ($1, $2)", [id, sale]);
  for (const tax of (await line.get("tax_ids")) as number[]) await env.cr.query("INSERT INTO account_move_line_account_tax_rel (account_move_line_id, account_tax_id) VALUES ($1, $2)", [id, tax]);
  return id;
}

/**
 * account_move.py:3724-3757 `_sync_dynamic_lines` of a draft invoice in the company currency: base amounts and tax lines
 * (`_sync_tax_lines`, account_tax.py `_prepare_tax_lines`), payment terms (`_sync_dynamic_line`), and the amounts.
 */
/**
 * The values a journal entry line may be created with here: its account, amounts in the company currency and label;
 * a product with its quantity (stock_landed_costs' `_prepare_account_move_line_values`: its unit, account_move_line.py
 * :1227-1236, and no taxes on an entry, :1331-1332), and an empty analytic distribution.
 */
const ENTRY_LINE_KEYS = new Set(["account_id", "debit", "credit", "balance", "name", "partner_id", "product_id", "quantity", "analytic_distribution", "currency_id", "amount_currency", "display_type"]);
/**
 * The other stored values a copied entry line has (account_move_line.py:2422-2438 copy_data), written as given by
 * createInvoiceLine (a given value is protected from its compute); its taxes refuse.
 */
const ENTRY_COPY_KEYS = new Set(["sequence", "is_storno", "is_imported", "tax_ids", "group_tax_id", "tax_base_amount", "tax_repartition_line_id", "tax_tag_ids",
  "extra_tax_data", "collapse_composition", "collapse_prices", "product_uom_id", "date_maturity", "price_unit", "discount", "deductible_percentage", "discount_date",
  "discount_amount_currency", "discount_balance", "no_followup", "is_downpayment", "stock_move_id"]);

/**
 * A line of a journal entry (account_move_line.py create with `_compute_balance`, `_compute_debit_credit`,
 * `_compute_amount_currency`, `_compute_amount_residual`, `_compute_totals` of an entry without taxes, the price
 * being the amount in the move's currency, and `_compute_no_followup`).
 */
async function createEntryLine(env: Environment, moveId: number, vals: Row): Promise<number> {
  const [m] = (await env.cr.query<{ cur: number; ccur: number; jtype: string; places: number }>(
    `SELECT m.currency_id AS cur, c.currency_id AS ccur, j.type AS jtype, rc.decimal_places AS places FROM account_move m JOIN res_company c ON c.id = m.company_id
       JOIN account_journal j ON j.id = m.journal_id JOIN res_currency rc ON rc.id = c.currency_id WHERE m.id = $1`, [moveId])).rows;
  if (!m) throw new NotPorted("account.move entry line without a journal");
  const lineCur = typeof vals["currency_id"] === "number" ? vals["currency_id"] : m.cur;
  if (lineCur !== m.ccur && !("amount_currency" in vals)) throw new NotPorted("journal entry lines in a foreign currency without amount_currency");
  const round = (x: number): number => floatRound(x, m.places);
  const debit = Number(vals["debit"] ?? 0), credit = Number(vals["credit"] ?? 0);
  const balance = round("balance" in vals ? Number(vals["balance"] ?? 0) : debit - credit);
  if ("balance" in vals && ("debit" in vals || "credit" in vals) && round(debit - credit) !== balance) throw new NotPorted("entry line with both a balance and debit/credit");
  let amountCurrency = balance;
  if ("amount_currency" in vals && vals["amount_currency"] !== null && vals["amount_currency"] !== false && vals["amount_currency"] !== undefined) {
    const fcPlaces = lineCur === m.ccur ? m.places
      : ((await env.cr.query<{ p: number }>("SELECT decimal_places AS p FROM res_currency WHERE id = $1", [lineCur])).rows[0]?.p ?? 2);
    amountCurrency = floatRound(Number(vals["amount_currency"]), fcPlaces);
  }
  const { balance: _b, debit: _d, credit: _c, currency_id: _cur, amount_currency: _ac, display_type: givenDt, ...rest } = vals;
  // fields_misc.py:70-73 Json `convert_to_cache`: an empty distribution is None (the column NULL), not '{}'
  if ("analytic_distribution" in rest && !pyTruthy(rest["analytic_distribution"])) rest["analytic_distribution"] = false;
  const id = await createInvoiceLine(env, moveId, rest);
  const upd: Row = {
    currency_id: lineCur,
    balance, debit: balance > 0 ? balance : 0, credit: balance < 0 ? -balance : 0,
    amount_currency: amountCurrency, amount_residual: balance, amount_residual_currency: amountCurrency,
    // `_compute_no_followup` (stored, readonly=False): a given value (a copy's) is kept
    price_subtotal: amountCurrency, price_total: amountCurrency, no_followup: "no_followup" in vals ? Boolean(vals["no_followup"]) : m.jtype === "general",
  };
  if (typeof givenDt === "string" && givenDt) upd["display_type"] = givenDt;
  await updateRow(env, "account_move_line", id, upd);
  return id;
}

/** account_move.py:1212-1262 `_compute_amount` of a journal entry: the total of the debit lines. */
async function entryAmounts(env: Environment, moveId: number): Promise<void> {
  const [t] = (await env.cr.query<{ b: number; c: number }>(
    "SELECT COALESCE(sum(balance), 0)::float8 AS b, COALESCE(sum(amount_currency), 0)::float8 AS c FROM account_move_line WHERE move_id = $1 AND debit != 0", [moveId])).rows;
  await updateRow(env, "account_move", moveId, {
    amount_untaxed: 0, amount_tax: 0, amount_total: t!.c, amount_residual: 0, amount_untaxed_signed: 0, amount_untaxed_in_currency_signed: 0, amount_tax_signed: 0,
    amount_total_signed: Math.abs(t!.b), amount_residual_signed: 0, amount_total_in_currency_signed: Math.abs(t!.c),
  });
}

/**
 * The journal items of a bank statement line's move (account_bank_statement_line.py:405 `account.move.line.create`
 * of `_prepare_move_line_default_vals`): a liquidity and a counterpart line in the company currency, then the move's
 * amounts. A line in another currency refuses (createEntryLine).
 */
export async function createStatementMoveLines(env: Environment, moveId: number, valsList: readonly Row[]): Promise<number[]> {
  const ccur = (await env.cr.query<{ c: number }>("SELECT c.currency_id AS c FROM account_move m JOIN res_company c ON c.id = m.company_id WHERE m.id = $1", [moveId])).rows[0]!.c;
  const ids: number[] = [];
  for (const v of valsList) {
    const { currency_id: cur, amount_currency: amount, move_id: _m, ...rest } = v;
    const balance = Number(rest["debit"] ?? 0) - Number(rest["credit"] ?? 0);
    if (cur !== ccur || Number(amount) !== balance) throw new NotPorted("bank statement line in a foreign currency (its journal items)");
    const id = await createEntryLine(env, moveId, rest);
    await checkLineCompany(env, id);
    ids.push(id);
  }
  await entryAmounts(env, moveId);
  return ids;
}

/**
 * Copied product line amounts (amount_currency given at creation), checked against the sync's values: per cursor (a
 * module-level map keyed by line id let an amount left by one request meet another database's line of the same id).
 */
const GIVEN_AMOUNTS = new WeakMap<object, Map<number, number>>();
function givenAmountsOf(env: Environment): Map<number, number> {
  let m = GIVEN_AMOUNTS.get(env.cr);
  if (!m) GIVEN_AMOUNTS.set(env.cr, m = new Map());
  return m;
}

/**
 * A tax or payment term line given in an invoice's `line_ids` (its copy): the given values with the move's columns,
 * `tax_line_id`/`tax_group_id` of the repartition line (related stored), the residual of its balance. The sync
 * (syncInvoice, givenDynamic) checks them against the needed lines.
 */
async function createGivenDynamicLine(env: Environment, moveId: number, vals0: Row): Promise<number> {
  // the business fields a copy with include_business_fields adds to every line (sale account_move_line.py:41-43
  // `[(6, None, self.sale_line_ids.ids)]`, purchase account_invoice.py:667-670 `self.purchase_line_id.id`): on a tax or
  // payment term line they are empty and write nothing (account_debit_note's copy_lines, a debit note of an invoice)
  const vals: Row = { ...vals0 };
  const sl = vals["sale_line_ids"];
  if (Array.isArray(sl) && sl.every((c) => Array.isArray(c) && c[0] === 6 && Array.isArray(c[2]) && (c[2] as unknown[]).length === 0)) delete vals["sale_line_ids"];
  if ("purchase_line_id" in vals && !vals["purchase_line_id"]) delete vals["purchase_line_id"];
  const known = new Set(["display_type", "sequence", "account_id", "name", "tax_repartition_line_id", "tax_base_amount", "amount_currency", "balance", "date_maturity", "discount_date",
    "discount_amount_currency", "discount_balance", "quantity", "price_unit", "discount", "currency_id", "partner_id", "product_id", "product_uom_id", "deductible_percentage", "is_storno",
    "no_followup", "collapse_composition", "collapse_prices", "is_downpayment", "is_imported", "extra_tax_data", "group_tax_id", "analytic_distribution", "stock_move_id", "tax_ids", "tax_tag_ids"]);
  const extra = Object.keys(vals).filter((k) => !known.has(k));
  if (extra.length) throw new NotPorted(`account.move.line ${extra.join(", ")} given on a ${String(vals["display_type"])} line`);
  for (const k of ["product_id", "analytic_distribution", "extra_tax_data", "group_tax_id", "stock_move_id"]) if (vals[k]) throw new NotPorted(`account.move.line ${k} on a given ${String(vals["display_type"])} line`);
  const m = (await env.cr.query<{ r: Row }>("SELECT row_to_json(x) AS r FROM (SELECT m.*, c.currency_id AS company_currency_id FROM account_move m JOIN res_company c ON c.id = m.company_id WHERE m.id = $1) x", [moveId])).rows[0]!.r;
  const num = (k: string): number => Number(plainNumber(vals[k] ?? 0)) || 0;
  // account_move_line.py:669-688 `_compute_name` of a payment term line whose name the copy dropped
  // (account_move.py:2426-2428): the move's payment reference and ref, a bill's ref; several installments refuse
  let name = vals["name"] || null;
  if (vals["display_type"] === "payment_term" && !("name" in vals)) {
    const termCount = m["invoice_payment_term_id"] ? Number((await env.cr.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM account_payment_term_line WHERE payment_id = $1", [m["invoice_payment_term_id"]])).rows[0]!.n) : 0;
    if (termCount > 1) throw new NotPorted("the name of a copied payment term line of several installments");
    const reference = (m["payment_reference"] as string | null) || null, ref = (m["ref"] as string | null) || null;
    name = reference && ref && reference !== ref ? `${ref} - ${reference}` : reference ?? (["in_invoice", "in_refund"].includes(String(m["move_type"])) ? ref : null);
  }
  const rep = vals["tax_repartition_line_id"] ? Number(vals["tax_repartition_line_id"]) : null;
  const tax = rep ? (await env.cr.query<{ t: number; g: number | null }>("SELECT r.tax_id AS t, x.tax_group_id AS g FROM account_tax_repartition_line r JOIN account_tax x ON x.id = r.tax_id WHERE r.id = $1", [rep])).rows[0] : undefined;
  const balance = num("balance"), amount = num("amount_currency");
  const id = await insertRow(env, "account_move_line", {
    move_id: moveId, journal_id: m["journal_id"], company_id: m["company_id"], company_currency_id: m["company_currency_id"], move_name: m["name"], parent_state: m["state"],
    ref: m["ref"], date: m["date"], invoice_date: m["invoice_date"], display_type: vals["display_type"], sequence: vals["sequence"] ?? null, account_id: vals["account_id"] || null,
    name, tax_repartition_line_id: rep, tax_line_id: tax?.t ?? null, tax_group_id: tax?.g ?? null, tax_base_amount: num("tax_base_amount"),
    currency_id: vals["currency_id"] || m["currency_id"], partner_id: vals["partner_id"] || null, product_uom_id: vals["product_uom_id"] || null,
    amount_currency: amount, balance, debit: balance > 0 ? balance : 0, credit: balance < 0 ? -balance : 0, amount_residual: balance, amount_residual_currency: amount,
    date_maturity: vals["date_maturity"] || null, discount_date: vals["discount_date"] || null, discount_amount_currency: num("discount_amount_currency"), discount_balance: num("discount_balance"),
    quantity: num("quantity"), price_unit: num("price_unit"), discount: num("discount"), price_subtotal: 0, price_total: 0, deductible_percentage: vals["deductible_percentage"] ?? 1,
    reconciled: false, is_storno: Boolean(vals["is_storno"]), no_followup: Boolean(vals["no_followup"]), collapse_composition: Boolean(vals["collapse_composition"]),
    collapse_prices: Boolean(vals["collapse_prices"]), is_downpayment: Boolean(vals["is_downpayment"]), is_imported: Boolean(vals["is_imported"]),
  });
  const m2m = (k: string): number[] => ((vals[k] as unknown[][] | false | undefined) || []).flatMap((c) => (c[0] === 6 ? (c[2] as number[]) : c[0] === 4 ? [Number(c[1])] : []));
  for (const t of m2m("tax_ids")) await env.cr.query("INSERT INTO account_move_line_account_tax_rel (account_move_line_id, account_tax_id) VALUES ($1, $2)", [id, t]);
  for (const t of m2m("tax_tag_ids")) await env.cr.query("INSERT INTO account_account_tag_account_move_line_rel (account_move_line_id, account_account_tag_id) VALUES ($1, $2)", [id, t]);
  return id;
}

/**
 * Storno accounting (res.company `account_storno`, the countries of STORNO_MANDATORY_COUNTRIES): the lines' `is_storno`
 * (account_move_line.py:827-837 `_compute_is_storno` with account_move.py:985-987: a refund of such a company is storno,
 * a customer or vendor invoice is not, an invoice line of a move that is not storno follows the sign of its quantity
 * times its price) and their debit and credit (:859-866: a storno line keeps its balance's sign on its own side). The
 * port's line writers set the lines of other companies; this pass runs after them, on the moves' lines of companies
 * with storno accounting only.
 */
export async function applyStorno(env: Environment, moveIds: readonly number[]): Promise<void> {
  if (!moveIds.length) return;
  const rows = (await env.cr.query<{ id: number; is_storno: boolean | null; display_type: string | null; quantity: number | null; price_unit: number | null;
    balance: number | null; debit: number | null; credit: number | null; move_type: string; move_storno: boolean }>(
    `SELECT l.id, l.is_storno, l.display_type, l.quantity::float8 AS quantity, l.price_unit::float8 AS price_unit, l.balance::float8 AS balance,
            l.debit::float8 AS debit, l.credit::float8 AS credit, m.move_type,
            (m.move_type IN ('out_refund', 'in_refund') AND COALESCE(mc.account_storno, FALSE)) AS move_storno
       FROM account_move_line l JOIN account_move m ON m.id = l.move_id JOIN res_company c ON c.id = l.company_id JOIN res_company mc ON mc.id = m.company_id
      WHERE l.move_id = ANY($1::int[]) AND c.account_storno ORDER BY l.id`, [[...moveIds]])).rows;
  for (const r of rows) {
    let storno = Boolean(r.is_storno || r.move_storno) && !["in_invoice", "out_invoice"].includes(r.move_type);
    const product = ["product", "line_section", "line_note", "line_subsection"].includes(String(r.display_type));
    const signed = (r.quantity ?? 0) * (r.price_unit ?? 0);
    if (!r.move_storno && product && signed) storno = signed < 0;
    const b = r.balance ?? 0;
    const debit = storno ? (b < 0 ? b : 0) : (b > 0 ? b : 0);
    const credit = storno ? (b > 0 ? -b : 0) : (b < 0 ? -b : 0);
    if (storno !== Boolean(r.is_storno) || debit !== (r.debit ?? 0) || credit !== (r.credit ?? 0)) {
      await updateRow(env, "account_move_line", r.id, { is_storno: storno, debit, credit });
    }
  }
}

/** The sale orders linked to an invoice's lines. */
async function linkedSaleOrders(env: Environment, moveId: number): Promise<number[]> {
  if (!env.reg.models.has("sale.order.line")) return [];
  return (await env.cr.query<{ o: number }>(
    `SELECT DISTINCT sl.order_id AS o FROM account_move_line l JOIN sale_order_line_invoice_rel r ON r.invoice_line_id = l.id JOIN sale_order_line sl ON sl.id = r.order_line_id
      WHERE l.move_id = $1 ORDER BY 1`, [moveId])).rows.map((r) => r.o);
}

/**
 * account_move.py:3431-3460: the base lines changed or removed by the commands (and the new ones) all without taxes
 * make `round_from_tax_lines` true (the tax lines' amounts are kept, lines given with amounts skip the sync): refused.
 */
async function refuseRoundFromTaxLines(env: Environment, moveId: number, commands: readonly unknown[][]): Promise<void> {
  const touched = commands.filter((c) => c[0] === 1 || c[0] === 2).map((c) => Number(c[1]));
  const taxed = (await env.cr.query<{ id: number }>(
    `SELECT DISTINCT l.id FROM account_move_line l JOIN account_move_line_account_tax_rel r ON r.account_move_line_id = l.id
      WHERE l.move_id = $1 AND l.id = ANY($2::int[]) AND l.display_type = 'product'`, [moveId, touched])).rows.length;
  const products = (await env.cr.query<{ id: number }>(
    "SELECT id FROM account_move_line WHERE move_id = $1 AND id = ANY($2::int[]) AND display_type = 'product'", [moveId, touched])).rows.length;
  // a removed taxed line, or a changed taxed line, recomputes the taxes from the base lines (round_from_tax_lines False);
  // a line given taxes counts as taxed (`line.tax_ids` after the write, :3448-3451)
  if (taxed) return;
  if (commands.some((c) => c[0] === 1 && c[2] && typeof c[2] === "object" && "tax_ids" in (c[2] as Row) && taxesAfter([], (c[2] as Row)["tax_ids"]).length)) return;
  // a product change recomputes the line's taxes (`_compute_tax_ids`): whether the line is taxed after it is not known here
  if (commands.some((c) => c[0] === 1 && c[2] && typeof c[2] === "object" && "product_id" in (c[2] as Row) && !("tax_ids" in (c[2] as Row)))) {
    throw new NotPorted("product change of an untaxed invoice line (round_from_tax_lines after _compute_tax_ids)");
  }
  // only notes, sections or untaxed lines: new lines with taxes would still recompute
  const created = commands.filter((c) => c[0] === 0).length;
  if (!products) return;
  // a move without tax lines and without taxed lines has no tax amounts to keep: rounding from the tax lines
  // (:3431-3460) and recomputing them give the same (no) tax lines
  if (!created && !(await env.cr.query(
    `SELECT 1 FROM account_move_line l WHERE l.move_id = $1 AND (l.display_type = 'tax'
        OR EXISTS (SELECT 1 FROM account_move_line_account_tax_rel r WHERE r.account_move_line_id = l.id)) LIMIT 1`, [moveId])).rows.length
    && !commands.some((c) => c[0] === 1 && c[2] && typeof c[2] === "object" && "tax_ids" in (c[2] as Row))) return;
  if (created) throw new NotPorted("invoice_line_ids commands mixing new lines with changed untaxed lines (round_from_tax_lines)");
  throw new NotPorted("invoice line changes of untaxed lines only (_sync_tax_lines round_from_tax_lines)");
}

const LINE_WRITABLE = ["quantity", "price_unit", "discount", "name", "sequence", "tax_ids", "product_id", "partner_id"];

/**
 * The taxes of a line after `tax_ids` commands (fields_relational.py `_Many2many.write_real`): 5 clears, 6 replaces,
 * 3 unlinks, 4 links. Other commands (creating or editing taxes from the line) refuse.
 */
function taxesAfter(before: readonly number[], commands: unknown): number[] {
  if (!Array.isArray(commands)) throw new NotPorted("invoice line tax_ids that is not a list of commands");
  let out = [...before];
  for (const c of commands) {
    if (!Array.isArray(c)) throw new NotPorted("invoice line tax_ids with a bare id");
    const [op, id, ids] = c as [number, unknown, unknown];
    if (op === 5) out = [];
    else if (op === 6 && Array.isArray(ids) && ids.every((x) => typeof x === "number")) out = [...new Set(ids as number[])];
    else if (op === 3 && typeof id === "number") out = out.filter((x) => x !== id);
    else if (op === 4 && typeof id === "number") { if (!out.includes(id)) out.push(id); }
    else throw new NotPorted(`invoice line tax_ids command ${String(op)}`);
  }
  return out;
}

/**
 * A `Command.update` of a product line of a draft invoice (the form's edit of quantity, price or discount): the values
 * converted as the ORM does (fields_numeric.py:169 the Float digits), the line's `_compute_totals`
 * (account_move_line.py:1254-1271); the dynamic lines follow in `syncInvoice`. Other fields refuse.
 */
async function updateInvoiceLine(env: Environment, moveId: number, lineId: number, vals: Row): Promise<void> {
  const [l] = (await env.cr.query<{ move_id: number; display_type: string | null; posted_before: boolean | null; purchase: number | null }>(
    `SELECT l.move_id, l.display_type, m.posted_before, ${env.reg.model("account.move.line").fields.has("purchase_line_id") ? "l.purchase_line_id" : "NULL::int"} AS purchase
       FROM account_move_line l JOIN account_move m ON m.id = l.move_id WHERE l.id = $1`, [lineId])).rows;
  if (!l || l.move_id !== moveId) throw new NotPorted("invoice_line_ids command 1 of a line of another move");
  if (NOTES.includes(String(l.display_type))) {
    const badNote = Object.keys(vals).filter((k) => k !== "name" && k !== "sequence");
    if (badNote.length) throw new NotPorted(`invoice_line_ids command 1 of ${badNote.join(", ")} on a ${String(l.display_type)} line`);
    const noteRow: Row = {};
    if ("name" in vals) noteRow["name"] = vals["name"] || null;
    if ("sequence" in vals) noteRow["sequence"] = Number(plainNumber(vals["sequence"]) || 0);
    if (Object.keys(noteRow).length) await updateRow(env, "account_move_line", lineId, noteRow);
    return;
  }
  // extra_tax_data: `action_switch_move_type` reverses it with the quantity (account_move.py:6704-6707)
  const bad = Object.keys(vals).filter((k) => !LINE_WRITABLE.includes(k) && k !== "extra_tax_data");
  if (bad.length) throw new NotPorted(`invoice_line_ids command 1 of ${bad.join(", ")}`);
  if (l.display_type !== "product") throw new NotPorted(`invoice_line_ids command 1 on a ${String(l.display_type)} line`);
  // an invoice posted once logs the changes of its journal items (prepareLineTracking, around the move's write)
  if (l.purchase !== null && Object.keys(vals).some((k) => k !== "name" && k !== "sequence")) throw new NotPorted("invoice_line_ids command 1 of a bill line linked to a purchase line (qty_invoiced)");
  const def = env.reg.model("account.move.line");
  const row: Row = {};
  if ("product_id" in vals) await changeLineProduct(env, lineId, vals);
  if ("tax_ids" in vals) {
    // the line's taxes (account_move_line_account_tax_rel), then its totals and the move's tax lines in the sync
    const before = (await env.cr.query<{ t: number }>("SELECT account_tax_id AS t FROM account_move_line_account_tax_rel WHERE account_move_line_id = $1 ORDER BY account_tax_id", [lineId])).rows.map((r) => r.t);
    const after = taxesAfter(before, vals["tax_ids"]);
    const company = (await env.cr.query<{ c: number }>("SELECT company_id AS c FROM account_move_line WHERE id = $1", [lineId])).rows[0]!.c;
    if (after.length && (await env.cr.query("SELECT 1 FROM account_tax WHERE id = ANY($1::int[]) AND (company_id != $2 OR NOT active)", [after, company])).rows.length) {
      throw new NotPorted("invoice line tax_ids of another company or archived (_check_company)");
    }
    await env.cr.query("DELETE FROM account_move_line_account_tax_rel WHERE account_move_line_id = $1 AND NOT (account_tax_id = ANY($2::int[]))", [lineId, after]);
    for (const t of after) if (!before.includes(t)) await env.cr.query("INSERT INTO account_move_line_account_tax_rel (account_move_line_id, account_tax_id) VALUES ($1, $2)", [lineId, t]);
  }
  for (const [k, v] of Object.entries(vals)) {
    if (k === "tax_ids" || k === "product_id") continue;
    if (k === "name" || k === "partner_id") row[k] = v || null;
    else if (k === "sequence") row[k] = Number(plainNumber(v) || 0);
    // fields_misc.py:70-77 Json: the given value, its floats with their decimal point; falsy is NULL
    else if (k === "extra_tax_data") row[k] = v && typeof v === "object" && Object.keys(v as object).length ? dumps(v) : null;
    else {
      const f = def.fields.get(k)!;
      const n = Number(plainNumber(v) || 0);
      row[k] = f.digits ? floatRound(n, f.digits[1]) : n;
    }
  }
  await updateRow(env, "account_move_line", lineId, row);
  const totals = await lineTotals(env, new DbRec(env, def, lineId));
  await updateRow(env, "account_move_line", lineId, { price_subtotal: plainNumber(totals.subtotal), price_total: plainNumber(totals.total) });
}

/**
 * The write of `product_id` on a product line of a draft invoice: the product (checked against the line's company,
 * `_check_company`), then the stored computes depending on it that the write does not give, in their dependency order
 * (account_move_line.py:1226-1234 `product_uom_id`, :1273-1292 `price_unit` on the product and its unit, :1294-1301
 * `tax_ids`, :652-693 `name`: a stored line is its own `_origin`, so its label stays unless it is empty or is already
 * the new product's description). `account_id` has no dependency (computed at creation only); the analytic
 * distribution (:1599-1612) keeps its value without distribution models (with some, refused).
 */
async function changeLineProduct(env: Environment, lineId: number, vals: Row): Promise<void> {
  const product = vals["product_id"];
  if (typeof product !== "number" || !product) throw new NotPorted("invoice_line_ids command 1 removing the product");
  const row = (await env.cr.query<{ company_id: number; pc: number | null; active: boolean | null }>(
    `SELECT l.company_id, t.company_id AS pc, p.active FROM account_move_line l, product_product p JOIN product_template t ON t.id = p.product_tmpl_id
      WHERE l.id = $1 AND p.id = $2`, [lineId, product])).rows[0];
  if (!row) throw new NotPorted("invoice line product that does not exist (MissingError)");
  if (row.pc !== null && row.pc !== row.company_id) throw new NotPorted("invoice line product of another company (_check_company)");
  const models = (await env.cr.query<{ n: string }>("SELECT count(*)::text AS n FROM account_analytic_distribution_model")).rows[0]?.n;
  if (Number(models ?? 0)) throw new NotPorted("account.move.line analytic distribution models (_get_distribution)");
  await updateRow(env, "account_move_line", lineId, { product_id: product });
  const def = env.reg.model("account.move.line");
  const { recordCompute } = await import("../orm/recompute");
  for (const f of ["product_uom_id", "price_unit", "tax_ids", "name"]) {
    if (f in vals) continue;
    const value = await recordCompute("account.move.line", f)!(env, new DbRec(env, def, lineId));
    if (f === "tax_ids") {
      const after = ((value as unknown[] | null) ?? []).map((t) => (typeof t === "number" ? t : Number((t as { origin?: number }).origin ?? t)));
      await env.cr.query("DELETE FROM account_move_line_account_tax_rel WHERE account_move_line_id = $1 AND NOT (account_tax_id = ANY($2::int[]))", [lineId, after]);
      for (const t of after) await env.cr.query("INSERT INTO account_move_line_account_tax_rel (account_move_line_id, account_tax_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [lineId, t]);
    } else if (f === "price_unit") {
      const digits = def.fields.get("price_unit")!.digits;
      const n = plainNumber(value);
      await updateRow(env, "account_move_line", lineId, { price_unit: digits ? floatRound(n, digits[1]) : n });
    } else {
      await updateRow(env, "account_move_line", lineId, { [f]: typeof value === "object" && value !== null && "origin" in value ? (value as { origin: number }).origin : (value || null) });
    }
  }
}

/**
 * account_move_line.py:2238-2280 write of product lines of draft invoices (quantity, price, discount): the move's
 * `_sync_dynamic_lines` around the lines' write (the dirty flags of the move and its lines, the tax and payment term
 * lines, the amounts), then the order lines' invoiced quantities.
 */
export async function writeInvoiceLines(env: Environment, lineIds: readonly number[], vals: Row): Promise<void> {
  const byMove = new Map<number, number[]>();
  for (const r of (await env.cr.query<{ id: number; move_id: number }>("SELECT id, move_id FROM account_move_line WHERE id = ANY($1::int[]) ORDER BY id", [[...lineIds]])).rows) {
    byMove.set(r.move_id, [...(byMove.get(r.move_id) ?? []), r.id]);
  }
  // the moves' tracked fields (the amounts) are logged once, at the precommit, as for the move's own write
  await trackPrepare(env, "account.move", [...byMove.keys()]);
  // the sync's dirty flags are written on the moves through their write: `is_manually_modified` too (measured)
  if (!env.context["skip_invoice_sync"]) await touchSyncedInvoices(env, [...byMove.keys()]);
  for (const [moveId, ids] of byMove) {
    const commands = ids.map((id) => [1, id, vals]);
    await refuseRoundFromTaxLines(env, moveId, commands);
    const orders = await linkedSaleOrders(env, moveId);
    for (const id of ids) await updateInvoiceLine(env, moveId, id, vals);
    await syncInvoice(env, moveId, { resync: true });
    const after = await linkedSaleOrders(env, moveId);
    const touched = [...new Set([...orders, ...after])];
    if (touched.length) {
      const { refreshInvoiced } = await import("./sale_invoice");
      await refreshInvoiced(env, touched);
    }
  }
  const { closeTrackingScope } = await import("../mail/write_hooks");
  await closeTrackingScope(env, "account.move");
}

/** A `Command.delete` of a product, note or section line of a draft invoice (account_move_line.py unlink). */
async function unlinkInvoiceLine(env: Environment, moveId: number, lineId: number, removed: Set<number>): Promise<void> {
  const [l] = (await env.cr.query<{ move_id: number; display_type: string | null; posted_before: boolean | null }>(
    "SELECT l.move_id, l.display_type, m.posted_before FROM account_move_line l JOIN account_move m ON m.id = l.move_id WHERE l.id = $1", [lineId])).rows;
  if (!l || l.move_id !== moveId) throw new NotPorted("invoice_line_ids command 2 of a line of another move");
  if (l.display_type !== "product" && !NOTES.includes(String(l.display_type))) throw new NotPorted(`invoice_line_ids command 2 of a ${String(l.display_type)} line`);
  if (l.posted_before) throw new NotPorted("invoice_line_ids command 2 on an invoice posted once (\"Journal Item deleted\" tracking)");
  removed.add(lineId);
}

/** Unlink of invoice lines by the move's own sync (`dynamic_unlink`). */
async function syncUnlink(env: Environment, lineIds: readonly number[]): Promise<void> {
  const { INVOICE_SYNC_UNLINK } = await import("./account_integrity");
  const set = INVOICE_SYNC_UNLINK.get(env.cr) ?? new Set<number>();
  for (const id of lineIds) set.add(id);
  INVOICE_SYNC_UNLINK.set(env.cr, set);
  const { unlink } = await import("../orm/unlink");
  try {
    await unlink(env.withContext({ ...env.context, dynamic_unlink: true }), "account.move.line", lineIds);
  } finally {
    for (const id of lineIds) set.delete(id);
  }
}

/** One tax line to create or update: the sum of the repartition data sharing its grouping key. */
interface NeededTaxLine {
  key: string; tax: number; rep: number; account: number; group: number | null; name: string; base: number; amount: number; balance: number; tags: number[];
  /** the key carries the base line's analytic distribution (tax.analytic or a repartition line outside the tax closing) */
  analytic: boolean;
  /** the keys a compiled override added to the grouping key (account_fleet's `vehicle_id`): the created line's values */
  extras: Row;
  /** `__keep_zero_line` (l10n_us_account): a zero line is kept, refused here */
  keep: boolean;
}

/** account_tax.py:3123-3133: a zero tax line is removed unless its key keeps it (l10n_us_account), which refuses. */
function zeroTaxLine(e: NeededTaxLine, foreign: boolean, rounding: number, companyRounding: number): boolean {
  const zero = round(e.amount, rounding) === 0 && (!foreign || round(e.balance, companyRounding) === 0);
  if (zero && e.keep) throw new NotPorted("a zero tax line kept for the US tax report (l10n_us_account `__keep_zero_line`)");
  return zero;
}

/**
 * The columns of a created tax line for the keys a compiled override added to its grouping key (account_move.py:3540-3545
 * `{**tax_line_vals, ...}`): stored scalar fields nothing stored is computed from, as given (False is NULL).
 */
function extraColumns(env: Environment, extras: Row): Row {
  const def = env.reg.model("account.move.line");
  const out: Row = {};
  for (const [k, v] of Object.entries(extras)) {
    const f = def.fields.get(k);
    if (!f || !f.store || f.inheritedFrom || !createdColumn(def, f)) throw new NotPorted(`a tax line's grouping key with ${k} (not a plain stored field of account.move.line)`);
    if (v !== false && v !== null && typeof v !== "number" && typeof v !== "string" && typeof v !== "boolean") throw new NotPorted(`a tax line's grouping key with ${k} ${JSON.stringify(v)}`);
    out[k] = f.type === "boolean" ? Boolean(v) : v === false ? null : v;
  }
  return out;
}

/**
 * A field a created line can take as its column: a scalar stored field without compute, and no stored computed field of
 * the line itself depends on it (a depends path starting with it). A stored field of another model depending on it
 * reaches the line through a relation of that model's records (fleet.vehicle.log.services `account_move_line_id.vehicle_id`),
 * and no record points to a line being created.
 */
function createdColumn(def: ModelDef, f: FieldDef): boolean {
  if (f.compute || f.related || !["boolean", "char", "text", "integer", "selection", "many2one"].includes(f.type) || f.translate || f.companyDependent) return false;
  return ![...def.fields.values()].some((g) => g.store && (g.compute || g.related)
    && [...(g.depends ?? []), ...(g.related ? [g.related] : [])].some((d) => d.split(".")[0] === f.name));
}

/** A given tax line's columns against the keys an override added to the needed line's grouping key. */
function sameExtras(env: Environment, l: Row, extras: Row): boolean {
  const cols = extraColumns(env, extras);
  return Object.entries(cols).every(([k, v]) => k in l && (l[k] ?? null) === v);
}

/**
 * account_tax.py:2389-2523 `_add_accounting_data_to_base_line_tax_details` for one tax data of a base line: the base
 * line's tags of the tax (not for the reverse-charge copy of a tax, :2432-2433), and one repartition data per tax
 * repartition line of the document type (the positive factors, or the negative ones with the sign -1 for the
 * reverse-charge copy, :2436-2441), each amount rounded and the rounding delta spread over them
 * (`_distribute_delta_amount_smoothly`, :2464-2495), signed as `_prepare_tax_lines` sums them (:3130-3142).
 * Cash-basis taxes, taxes affecting the base and product tags refuse; a kept tax line that would carry the base line's
 * analytic distribution (`tax.analytic` or a repartition line outside the tax closing, :2355-2359) refuses where it
 * is created or updated.
 */
async function taxRepartitionData(env: Environment, td: { tax: { id: number }; tax_amount_currency: number; tax_amount: number; base_amount: number },
  o: { line: Row; refund: boolean; reverse: boolean; foreign: boolean; sign: number; account: number; analytic: unknown; partner: number | null; currencyId: number;
    currency: { rounding: number; decimal_places: number }; company: { currency_id: { rounding: number; decimal_places: number } }; baseTags: Set<number> }): Promise<NeededTaxLine[]> {
  const docType = o.refund ? "refund" : "invoice";
  const tax = (await env.cr.query<{ name: string; tax_group_id: number | null; exig: string; include_base: boolean | null; analytic: boolean | null }>(
    `SELECT COALESCE(name->>$2, name->>'en_US', '') AS name, tax_group_id, tax_exigibility AS exig, include_base_amount AS include_base, analytic FROM account_tax WHERE id = $1`,
    [td.tax.id, env.lang ?? "en_US"])).rows[0]!;
  if (tax.exig === "on_payment" || tax.include_base) throw new NotPorted("invoice taxes on payment or affecting the base");
  const tagsOf = async (repIds: readonly number[]): Promise<number[]> => (await env.cr.query<{ t: number }>(
    `SELECT DISTINCT account_account_tag_id AS t FROM account_account_tag_account_tax_repartition_line_rel WHERE account_tax_repartition_line_id = ANY($1::int[]) ORDER BY 1`, [[...repIds]])).rows.map((r) => r.t);
  // account_tax.py:5186 the repartition lines' order: document_type, repartition_type, sequence, id
  const reps = (await env.cr.query<{ id: number; repartition_type: string; factor: number; account_id: number | null; closing: boolean | null }>(
    `SELECT id, repartition_type, factor_percent::float8 / 100.0 AS factor, account_id, use_in_tax_closing AS closing FROM account_tax_repartition_line
      WHERE tax_id = $1 AND document_type = $2 ORDER BY repartition_type, sequence, id`, [td.tax.id, docType])).rows;
  if (!o.reverse) for (const t of await tagsOf(reps.filter((r) => r.repartition_type === "base").map((r) => r.id))) o.baseTags.add(t);
  const taxReps = reps.filter((r) => r.repartition_type === "tax" && (o.reverse ? r.factor < 0 : r.factor >= 0));
  const repSign = o.reverse ? -1 : 1;
  const companyCurrency = o.company.currency_id;
  // the company amount of a document in the company currency is its currency amount (the engine's tax_amount is the same)
  const companyAmount = o.foreign ? td.tax_amount : td.tax_amount_currency;
  const data = taxReps.map((r) => ({
    rep: r, currency: roundPrecision(td.tax_amount_currency * r.factor * repSign, o.currency.rounding),
    company: roundPrecision(companyAmount * r.factor * repSign, companyCurrency.rounding),
  }));
  const sorted = [...data].sort((a, b) => (Math.abs(b.currency) - Math.abs(a.currency)) || (Math.abs(b.company) - Math.abs(a.company)));
  for (const [field, total, digits] of [["currency", td.tax_amount_currency, o.currency.decimal_places], ["company", companyAmount, companyCurrency.decimal_places]] as const) {
    const delta = total - data.reduce((s, d) => s + d[field], 0);
    const targets = sorted.map((d) => ({ factor: d[field] }));
    const spread = accountTaxHelpers.distribute_delta_amount_smoothly(digits, delta, targets);
    sorted.forEach((d, i) => { d[field] += spread[i] ?? 0; });
  }
  const out: NeededTaxLine[] = [];
  // the tax data as Odoo's dict (`_add_tax_details_in_base_line`, :2185-2230): the tax, no group (the hand port writes
  // no group_tax_id) and no subsequent taxes (affecting the base refuses above)
  const taxData: Row = { ...(td as unknown as Row), tax: new PrivateRecords("account.tax", [td.tax.id]), group: new PrivateRecords("account.tax", []),
    taxes: new PrivateRecords("account.tax", []) };
  delete taxData["tax_reps_data"];
  for (const d of data) {
    // :2355-2359 the base line's analytic distribution is in the key (and on the tax line) for an analytic tax or a
    // repartition line outside the tax closing; such a line that is kept (not zero) refuses where it is created
    const analytic = Boolean(o.analytic && (tax.analytic || !d.rep.closing));
    const account = d.rep.account_id ?? o.account;
    // :2502-2505 the tax line's tags: the repartition line's (an on-invoice tax, no product tags)
    const tags = await tagsOf([d.rep.id]);
    // :2511-2518 the grouping key, through the tax engine's dispatch points
    const repData: Row = { tax_rep: new PrivateRecords("account.tax.repartition.line", [d.rep.id]),
      account: new PrivateRecords("account.account", d.rep.account_id ? [d.rep.account_id] : []), taxes: new PrivateRecords("account.tax", []),
      tax_tags: new PrivateRecords("account.account.tag", tags), tax_amount_currency: d.currency, tax_amount: d.company };
    const baseKey = await priv.account_tax._prepare_base_line_grouping_key.invoke(env, o.line);
    const k = taxLineKey(await priv.account_tax._prepare_base_line_tax_repartition_grouping_key.invoke(env, o.line, baseKey, taxData, repData),
      "account.tax._prepare_base_line_tax_repartition_grouping_key");
    // the created line has the hand port's values: a compiled override changing one of account's keys refuses
    const own = { rep: d.rep.id, account, partner: o.partner, currency: o.currencyId, group: null } as const;
    const changed = (Object.keys(own) as (keyof typeof own)[]).filter((f) => k[f] !== own[f]);
    if (k.taxIds.length) changed.push("tax_ids" as never);
    if (JSON.stringify([...k.tags].sort((a, b) => a - b)) !== JSON.stringify(tags)) changed.push("tax_tag_ids" as never);
    if ((k.analytic !== null) !== analytic || (analytic && JSON.stringify(k.analytic) !== JSON.stringify(o.analytic))) changed.push("analytic_distribution" as never);
    if (changed.length) throw new NotPorted(`a compiled override changing ${changed.join(", ")} of a tax line's grouping key`);
    out.push({ key: k.key, tax: td.tax.id, rep: d.rep.id, account,
      group: tax.tax_group_id, name: tax.name, base: o.sign * td.base_amount, amount: o.sign * d.currency, balance: o.sign * d.company, tags, analytic, extras: k.extras, keep: k.keep });
  }
  return out;
}

export async function syncInvoice(env: Environment, moveId: number, opts: { readonly givenDynamic?: boolean; readonly resync?: boolean; readonly removed?: ReadonlySet<number>;
  /** account_move.py:3724-3757 on a batch: `_sync_tax_lines` of every move before `_sync_dynamic_line` of their payment
   *  terms; the payment term part of this move is pushed here to run after the batch's tax lines. */
  readonly terms?: (() => Promise<void>)[] } = {}): Promise<void> {
  const move = (await env.cr.query<{ r: Row }>("SELECT row_to_json(m) AS r FROM account_move m WHERE id = $1", [moveId])).rows[0]!.r;
  const t = String(move["move_type"]);
  if (!(SALE_R.includes(t) || PURCHASE_R.includes(t)) || move["state"] !== "draft") return;
  const companyCurrency = (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [move["company_id"]])).rows[0]!.c;
  move["company_currency_id"] = companyCurrency;
  if (move["invoice_cash_rounding_id"]) throw new NotPorted("invoice lines with cash rounding");
  const rec = new DbRec(env, env.reg.model("account.move"), moveId);
  // account_move_line.py:869-874 `currency_rate` of invoice lines: the invoice's rate (company currency -> currency)
  const foreign = move["currency_id"] !== companyCurrency;
  const rate = foreign ? plainNumber(await rec.get("invoice_currency_rate")) || 1.0 : 1;
  const removed = opts.removed ?? new Set<number>();
  const rows = (await env.cr.query<{ r: Row }>("SELECT row_to_json(l) AS r FROM account_move_line l WHERE move_id = $1 ORDER BY id", [moveId])).rows.map((x) => x.r)
    .filter((l) => !removed.has(Number(l["id"])));
  const products = rows.filter((l) => l["display_type"] === "product");
  if (rows.some((l) => !["product", "tax", "payment_term", ...NOTES].includes(String(l["display_type"])))) throw new NotPorted("invoice with epd, rounding or discount lines");
  const sign = t === "entry" || ["out_refund", "in_invoice", "in_receipt"].includes(t) ? 1 : -1;
  const company = await companyData(env, Number(move["company_id"]));
  const currency = await currencyData(env, Number(move["currency_id"]));
  const lineDef = env.reg.model("account.move.line");
  const bases = [];
  for (const l of products) bases.push(await productBaseLine(env, new DbRec(env, lineDef, Number(l["id"])), { sign, rate, currency, mode: move["document_tax_mode"], dispatched: true }));
  accountTaxHelpers.add_tax_details_in_base_lines(bases, company);
  accountTaxHelpers.round_base_lines_tax_details(bases, company);
  // the tax lines, one per accounting grouping key (account_tax.py:3079-3148 `_prepare_tax_lines`, the keys of
  // `_prepare_base_line_tax_repartition_grouping_key`, :2335-2365), in the order the base lines, their taxes and the
  // taxes' repartition lines give them
  const needed = new Map<string, NeededTaxLine>();
  let untaxed = 0, untaxedBalance = 0;
  const refund = t === "out_refund" || t === "in_refund";
  for (let i = 0; i < products.length; i++) {
    const l = products[i]!, base = bases[i]!;
    const details = base.tax_details as unknown as { total_excluded_currency: number; delta_total_excluded_currency: number; total_excluded: number; delta_total_excluded: number;
      taxes_data: { tax: { id: number }; tax_amount_currency: number; tax_amount: number; base_amount: number; is_reverse_charge?: boolean }[] };
    const amount = sign * (details.total_excluded_currency + details.delta_total_excluded_currency);
    // account_tax.py `_prepare_tax_lines`: the base line's balance is its amount in the company currency
    const balance = foreign ? sign * (details.total_excluded + details.delta_total_excluded) : amount;
    untaxed += amount; untaxedBalance += balance;
    const id = Number(l["id"]);
    const givenAmounts = givenAmountsOf(env);
    if (givenAmounts.has(id)) {
      const given = givenAmounts.get(id)!;
      givenAmounts.delete(id);
      if (round(given, currency.rounding) !== round(amount, currency.rounding)) throw new NotPorted("invoice line created with an amount_currency other than its price's (copy of an edited line)");
    }
    await updateRow(env, "account_move_line", id, { amount_currency: amount, balance, debit: balance > 0 ? balance : 0, credit: balance < 0 ? -balance : 0, amount_residual: balance, amount_residual_currency: amount });
    // account_tax.py:2412-2433 `_add_accounting_data_to_base_line_tax_details`: the base line's tags are the product's
    // account tags (refused here) and the base repartition lines' tags of its on-invoice taxes
    if (l["product_id"] && (await env.cr.query("SELECT 1 FROM account_account_tag_product_template_rel r JOIN product_product p ON p.product_tmpl_id = r.product_template_id WHERE p.id = $1 LIMIT 1", [l["product_id"]])).rows.length) {
      throw new NotPorted("invoice lines of a product with account tags");
    }
    const baseTags = new Set<number>();
    const analytic = l["analytic_distribution"] && Object.keys(l["analytic_distribution"] as object).length ? l["analytic_distribution"] : null;
    // account_move.py:1665-1691 `_prepare_product_base_line_for_taxes_computation`: the base line as Odoo's dict,
    // through `_prepare_base_line_for_taxes_computation` (an override's added keys reach the grouping keys); its partner
    // is the move's commercial partner, the hand port's for the tax lines (account_move_line.py `_compute_partner_id`)
    const record = new PrivateRecords("account.move.line", [id]);
    const special = (base as unknown as Row)["special_type"];
    const kwargs: Row = { price_unit: Number(l["price_unit"] ?? 0), quantity: Number(l["quantity"] ?? 0), discount: Number(l["discount"] ?? 0), rate, sign,
      special_mode: false, name: l["name"] || false, ...(special ? { special_type: special } : {}) };
    const { line } = await prepareBaseLine(env, record, kwargs, odooBaseLine(base, record, kwargs, {
      product_id: num(l["product_id"]) ?? false, product_uom_id: num(l["product_uom_id"]) ?? false, partner_id: num(move["commercial_partner_id"]) ?? false,
      account_id: num(l["account_id"]) ?? false, analytic_distribution: l["analytic_distribution"] ?? null, is_refund: refund,
    }));
    for (const td of details.taxes_data) {
      const reverse = Boolean(td.is_reverse_charge);
      for (const t of await taxRepartitionData(env, td, { line, refund, reverse, foreign, sign, account: Number(l["account_id"]), analytic, partner: (move["commercial_partner_id"] as number | null) ?? null,
        currencyId: Number(move["currency_id"]), currency, company, baseTags })) {
        const e = needed.get(t.key);
        if (e) { e.base += t.base; e.amount += t.amount; e.balance += t.balance; } else needed.set(t.key, t);
      }
    }
    // account_move.py:5316 the base line's `tax_tag_ids` [Command.set(...)]
    await env.cr.query("DELETE FROM account_account_tag_account_move_line_rel WHERE account_move_line_id = $1", [id]);
    for (const t of [...baseTags].sort((a, b) => a - b)) {
      await env.cr.query("INSERT INTO account_account_tag_account_move_line_rel (account_move_line_id, account_account_tag_id) VALUES ($1, $2)", [id, t]);
    }
  }
  let taxTotal = 0, taxBalance = 0, taxTotalGiven = 0, taxBalanceGiven = 0;
  const existingTax = rows.filter((l) => l["display_type"] === "tax");
  if (existingTax.length && !opts.givenDynamic && !opts.resync) throw new NotPorted("updating the tax lines of a saved invoice (_sync_tax_lines)");
  if (opts.givenDynamic) {
    // the given tax lines (a copy's) must be the needed ones, one per repartition line, with their amounts
    const kept = [...needed.entries()].filter(([, e]) => !zeroTaxLine(e, foreign, currency.rounding, company.currency_id.rounding));
    if (kept.some(([, e]) => e.analytic)) throw new NotPorted("tax lines with the base line's analytic distribution (tax.analytic or a repartition line outside the tax closing)");
    const same = existingTax.length === kept.length && kept.every(([, e]) => existingTax.some((l) => Number(l["tax_repartition_line_id"]) === e.rep
      && round(Number(l["amount_currency"]), currency.rounding) === round(e.amount, currency.rounding) && round(Number(l["balance"]), currency.rounding) === round(e.balance, currency.rounding)
      && round(Number(l["tax_base_amount"] ?? 0), currency.rounding) === round(e.base, currency.rounding) && Number(l["account_id"]) === e.account && sameExtras(env, l, e.extras)));
    if (!same) throw new NotPorted("invoice created with tax lines other than the computed ones (_sync_tax_lines on given lines)");
    needed.clear();
    for (const [, e] of kept) { taxTotalGiven += e.amount; taxBalanceGiven += e.balance; }
  }
  const partner = (move["commercial_partner_id"] as number | null) ?? null;
  const common: Row = {
    move_id: moveId, journal_id: move["journal_id"], company_id: move["company_id"], company_currency_id: move["company_currency_id"], move_name: move["name"], parent_state: "draft",
    ref: move["ref"], date: move["date"], invoice_date: move["invoice_date"], currency_id: move["currency_id"], partner_id: partner, reconciled: false, is_storno: false, no_followup: false, deductible_percentage: 1,
  };
  const taxLinesToDelete: number[] = [];
  if (opts.resync && !opts.givenDynamic) {
    // account_tax.py:3079-3172 `_prepare_tax_lines(tax_lines=...)`: an existing tax line whose grouping key
    // (`_prepare_tax_line_repartition_grouping_key`, :2367-2385) is needed is updated with the new amounts (and the
    // tax's name), the others are deleted; the needed keys left are created below (account_move.py:3536-3553: the
    // updates, then the deletions, then the creations)
    // the base lines' analytic distributions only reach a tax line's grouping key through `tax.analytic` or a
    // repartition line outside the tax closing (account_tax.py:2355-2359), refused below as at creation
    const wanted = new Set<string>();
    for (const [k, e] of needed) {
      if (zeroTaxLine(e, foreign, currency.rounding, company.currency_id.rounding)) continue;
      if (e.analytic) throw new NotPorted("tax lines with the base line's analytic distribution (tax.analytic or a repartition line outside the tax closing)");
      wanted.add(k);
    }
    const toDelete: number[] = [];
    for (const l of existingTax) {
      const id = Number(l["id"]);
      const taxIds = (await env.cr.query<{ t: number }>("SELECT account_tax_id AS t FROM account_move_line_account_tax_rel WHERE account_move_line_id = $1", [id])).rows.map((r) => r.t);
      const tags = (await env.cr.query<{ t: number }>("SELECT account_account_tag_id AS t FROM account_account_tag_account_move_line_rel WHERE account_move_line_id = $1", [id])).rows.map((r) => r.t);
      // account_move.py:1770-1779 `_prepare_tax_line_for_taxes_computation(tax_line, sign=direction_sign)`, then
      // account_tax.py:3159 its grouping key, through the tax engine's dispatch points
      const taxLine = await prepareTaxLine(env, l, taxIds, tags, { sign });
      const k = taxLineKey(await priv.account_tax._prepare_tax_line_repartition_grouping_key.invoke(env, taxLine), "account.tax._prepare_tax_line_repartition_grouping_key").key;
      if (!wanted.has(k)) { toDelete.push(id); continue; }
      wanted.delete(k);
      const e = needed.get(k)!;
      needed.delete(k);
      taxTotal += e.amount; taxBalance += e.balance;
      // account_move.py:3528-3531 `is_write_needed`: only changed values are written
      const vals: Row = {};
      if (round(Number(l["tax_base_amount"] ?? 0), currency.rounding) !== round(e.base, currency.rounding)) vals["tax_base_amount"] = e.base;
      if (Number(l["amount_currency"]) !== round(e.amount, currency.rounding)) vals["amount_currency"] = e.amount;
      if (Number(l["balance"]) !== round(e.balance, company.currency_id.rounding)) {
        Object.assign(vals, { balance: e.balance, debit: e.balance > 0 ? e.balance : 0, credit: e.balance < 0 ? -e.balance : 0, amount_residual: e.balance });
      }
      if ("amount_currency" in vals) vals["amount_residual_currency"] = e.amount;
      if ((l["name"] ?? "") !== e.name) vals["name"] = e.name;
      if (Object.keys(vals).length) await updateRow(env, "account_move_line", id, vals);
    }
    // the needed keys not matched by an existing line stay in `needed` (created below); the zero ones are skipped there
    for (const k of [...needed.keys()]) if (!wanted.has(k)) needed.delete(k);
    taxLinesToDelete.push(...toDelete);
  }
  for (const e of needed.values()) {
    if (zeroTaxLine(e, foreign, currency.rounding, company.currency_id.rounding)) continue; // account_tax.py: zero tax lines are removed
    if (e.analytic) throw new NotPorted("tax lines with the base line's analytic distribution (tax.analytic or a repartition line outside the tax closing)");
    if (foreign && round(e.amount, currency.rounding) === 0) throw new NotPorted("a tax line with a company amount only (foreign currency rounding)");
    taxTotal += e.amount; taxBalance += e.balance;
    const taxLine = await insertRow(env, "account_move_line", {
      ...common, display_type: "tax", sequence: 10000, account_id: e.account, name: e.name, tax_repartition_line_id: e.rep, tax_line_id: e.tax, tax_group_id: e.group, tax_base_amount: e.base,
      amount_currency: e.amount, balance: e.balance, debit: e.balance > 0 ? e.balance : 0, credit: e.balance < 0 ? -e.balance : 0, amount_residual: e.balance, amount_residual_currency: e.amount, quantity: 0, price_unit: 0, price_subtotal: 0, price_total: 0, discount: 0,
      ...extraColumns(env, e.extras),
    });
    for (const t of e.tags) await env.cr.query("INSERT INTO account_account_tag_account_move_line_rel (account_move_line_id, account_account_tag_id) VALUES ($1, $2)", [taxLine, t]);
  }
  taxTotal += taxTotalGiven; taxBalance += taxBalanceGiven;
  const total = untaxed + taxTotal, totalBalance = untaxedBalance + taxBalance;
  const needs = products.length ? await neededTerms(env, move, -totalBalance, -total) : [];
  const terms = rows.filter((l) => l["display_type"] === "payment_term");
  if (opts.givenDynamic && !terms.length && needs.length) throw new NotPorted("invoice created with line_ids without its payment term line");
  if (terms.length) {
    // account_move.py:3651-3754 `_sync_dynamic_line` of the payment terms: the key (move, date_maturity,
    // discount_date) of the one needed term is the existing line's, so the line is written with the needed values
    // (balance, amount_currency and the discount amounts, here 0); other shapes (new or removed terms, discounts,
    // several installments) refuse
    const n = needs[0];
    const term = terms[0]!;
    if (opts.givenDynamic && n && needs.length === 1 && terms.length === 1 && Number(term["balance"]) === n.balance && Number(term["amount_currency"]) === n.amount
      && !term["discount_date"] && !Number(term["discount_amount_currency"] ?? 0) && !Number(term["discount_balance"] ?? 0)) {
      // a copy's payment term line: its maturity moves to the new date (the copy has no invoice date)
      if (String(term["date_maturity"] ?? "") !== String(n.date ?? "")) await updateRow(env, "account_move_line", Number(term["id"]), { date_maturity: n.date });
    } else if (opts.givenDynamic) {
      throw new NotPorted("invoice created with payment term lines other than the computed one (_sync_dynamic_line on given lines)");
    } else if (needs.length !== 1 || terms.length !== 1 || !n || String(term["date_maturity"] ?? "") !== String(n.date ?? "")
      || String(term["discount_date"] ?? "") !== String(n.discountDate ?? "")) {
      throw new NotPorted("updating the payment term lines of a saved invoice other than one term of the same date (_sync_dynamic_line)");
    }
    // the key (date_maturity, discount_date) is the line's: written with the needed amounts and discount amounts
    const vals: Row = {};
    if (Number(term["balance"]) !== n.balance || Number(term["amount_currency"]) !== n.amount) {
      Object.assign(vals, { amount_currency: n.amount, balance: n.balance, debit: n.balance > 0 ? n.balance : 0, credit: n.balance < 0 ? -n.balance : 0,
        amount_residual: n.balance, amount_residual_currency: n.amount });
    }
    if (Number(term["discount_balance"] ?? 0) !== n.discountBalance) vals["discount_balance"] = n.discountBalance;
    if (Number(term["discount_amount_currency"] ?? 0) !== n.discountAmount) vals["discount_amount_currency"] = n.discountAmount;
    if (Object.keys(vals).length) await updateRow(env, "account_move_line", Number(term["id"]), vals);
  }
  const sale = SALE_R.includes(t);
  let account: number | null = null;
  if (needs.length) {
    const cenv = await withCompanyEnv(env, Number(move["company_id"]));
    const field = sale ? "property_account_receivable_id" : "property_account_payable_id";
    if (partner !== null) account = num(await new DbRec(cenv, env.reg.model("res.partner"), partner).get(field));
    if (account === null) {
      const companyPartner = (await env.cr.query<{ p: number }>("SELECT partner_id AS p FROM res_company WHERE id = $1", [move["company_id"]])).rows[0]!.p;
      account = num(await new DbRec(cenv, env.reg.model("res.partner"), companyPartner).get(field));
    }
    if (account === null) throw new NotPorted("payment term account from the chart fallback");
    account = await mapAccount(await rec.rel("fiscal_position_id"), account);
  }
  const reference = (move["payment_reference"] as string | null) ?? null, ref = (move["ref"] as string | null) ?? null;
  const name = reference && ref && reference !== ref ? `${ref} - ${reference}` : reference ?? (["in_invoice", "in_refund"].includes(t) ? ref : null);
  // account_move_line.py:669-688 with several term lines in the payment term: "<name> installment #<n>", numbered by
  // maturity (stable on the creation order); before round 11 several installments refused
  const termCount = move["invoice_payment_term_id"] ? Number((await env.cr.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM account_payment_term_line WHERE payment_id = $1", [move["invoice_payment_term_id"]])).rows[0]!.n) : 0;
  const byMaturity = needs.map((n, i) => ({ n, i })).sort((a, b) => (a.n.date ?? "9999-12-31").localeCompare(b.n.date ?? "9999-12-31") || a.i - b.i).map((x) => x.n);
  const finish = async (): Promise<void> => {
  for (const n of terms.length ? [] : needs) {
    const lineName = termCount > 1 ? installmentName(env, name, byMaturity.indexOf(n) + 1) : name;
    await insertRow(env, "account_move_line", {
      ...common, display_type: "payment_term", sequence: 12000, account_id: account, name: lineName, date_maturity: n.date,
      discount_date: n.discountDate, discount_amount_currency: n.discountAmount, discount_balance: n.discountBalance,
      amount_currency: n.amount, balance: n.balance, debit: n.balance > 0 ? n.balance : 0, credit: n.balance < 0 ? -n.balance : 0, amount_residual: n.balance, amount_residual_currency: n.amount, quantity: 0, price_unit: 0, price_subtotal: 0, price_total: 0, discount: 0,
    });
  }
  const totalAbs = sign * total;
  await updateRow(env, "account_move", moveId, {
    amount_untaxed: sign * untaxed, amount_tax: sign * taxTotal, amount_total: totalAbs, amount_residual: totalAbs,
    amount_untaxed_signed: -untaxedBalance, amount_untaxed_in_currency_signed: -untaxed, amount_tax_signed: -taxBalance,
    amount_total_signed: -totalBalance, amount_total_in_currency_signed: -total, amount_residual_signed: -totalBalance,
    // :1124-1128 `max(date_maturity) or invoice_date_due or invoice_date`
    invoice_date_due: (needs.map((n) => n.date).filter((d): d is string => !!d).sort().at(-1) ?? null) || move["invoice_date_due"] || move["invoice_date"] || null,
  });
  // the removed product lines (the write's `Command.delete`) and the tax lines no longer needed
  // (account_move.py:3550-3551 `dynamic_unlink`), once the lines left are synced
  const gone = [...removed, ...taxLinesToDelete];
  if (gone.length) await syncUnlink(env, gone);
  // account_move_line.py:1213-1219 `_compute_amount_residual`: `reconciled` is a zero residual in both currencies on any
  // account, so a synced line of zero amount (a free product, a zero tax or payment term) is reconciled. The lines here
  // are inserted with `reconciled` false and their amounts written afterwards; before round 11 it stayed false.
  await env.cr.query(`UPDATE account_move_line l SET reconciled = z.zero
      FROM (SELECT l2.id, (round(abs(l2.amount_residual) / cc.rounding) = 0 AND round(abs(l2.amount_residual_currency) / fc.rounding) = 0) AS zero
              FROM account_move_line l2 JOIN res_currency cc ON cc.id = l2.company_currency_id JOIN res_currency fc ON fc.id = COALESCE(l2.currency_id, l2.company_currency_id)
             WHERE l2.move_id = $1
               AND NOT EXISTS (SELECT 1 FROM account_partial_reconcile p WHERE p.debit_move_id = l2.id OR p.credit_move_id = l2.id)) z
     WHERE l.id = z.id AND l.reconciled IS DISTINCT FROM z.zero`, [moveId]);
    await applyStorno(env, [moveId]);
  };
  if (opts.terms) opts.terms.push(finish);
  else await finish();
}

/** account_move_line.py:1254-1271 `_compute_totals` of a move's product lines again (a new move type or tax mode). */
async function refreshLineTotals(env: Environment, moveId: number): Promise<void> {
  const def = env.reg.model("account.move.line");
  const lines = (await env.cr.query<{ id: number; s: number | null; t: number | null }>(
    "SELECT id, price_subtotal::float8 AS s, price_total::float8 AS t FROM account_move_line WHERE move_id = $1 AND display_type IN ('product', 'cogs') ORDER BY id", [moveId])).rows;
  for (const l of lines) {
    const totals = await lineTotals(env, new DbRec(env, def, l.id));
    const s = plainNumber(totals.subtotal), t = plainNumber(totals.total);
    if (s !== l.s || t !== l.t) await updateRow(env, "account_move_line", l.id, { price_subtotal: s, price_total: t });
  }
}

/**
 * account_move.py:1211-1262 `_compute_amount` of a posted invoice whose lines' totals moved (its tax mode written):
 * the journal items stay, the residual is the tax summary's total (rounded from the tax journal items,
 * :1872-1890) plus the reconciled amount of the payment term lines; `_compute_payment_state` follows the residual.
 */
async function refreshResidualFromTaxTotals(env: Environment, moveId: number): Promise<void> {
  const { directionSign, moveRow, paymentState } = await import("./account_entries");
  const isInvoice = (t: string): boolean => [...SALE, ...PURCHASE].includes(t); // account_move.py `is_invoice()`
  const { currencyData } = await import("./account_taxes");
  const move = await moveRow(env, moveId);
  const totals = (await new DbRec(env, env.reg.model("account.move"), moveId).get("tax_totals")) as { total_amount_currency?: unknown; total_amount?: unknown } | null;
  // the reconciled amount of an invoice's payment term lines (a journal entry has none, :1229-1243)
  const terms = isInvoice(move.move_type) ? (await env.cr.query<{ b: number; c: number }>(
    `SELECT COALESCE(sum(balance - amount_residual), 0)::float8 AS b, COALESCE(sum(amount_currency - amount_residual_currency), 0)::float8 AS c
       FROM account_move_line WHERE move_id = $1 AND display_type = 'payment_term'`, [moveId])).rows[0]! : { b: 0, c: 0 };
  const sign = directionSign(move.move_type);
  const cur = await currencyData(env, move.currency_id);
  const residual = floatRound(plainNumber(totals?.total_amount_currency) + sign * terms.c, cur.decimal_places);
  // amount_residual_signed is in the company currency (its currency_field, account_move.py)
  const companyCurrency = (await env.cr.query<{ c: number }>("SELECT c.currency_id AS c FROM account_move m JOIN res_company c ON c.id = m.company_id WHERE m.id = $1", [moveId])).rows[0]!.c;
  const residualSigned = floatRound(-sign * plainNumber(totals?.total_amount) - terms.b, (await currencyData(env, companyCurrency)).decimal_places);
  const state = await paymentState(env, move, residual, cur.rounding);
  if (state !== (move.payment_state ?? "not_paid")) throw new NotPorted("account.move payment state moved by a new tax mode on a posted invoice");
  await updateRow(env, "account_move", moveId, { amount_residual: residual, amount_residual_signed: residualSigned });
}

/**
 * account_move.py:3724-3757 `_sync_dynamic_lines` after a new invoice date on a draft invoice whose lines are synced: the
 * needed terms (:1410-1480) of the same total, compared with the payment term lines; only their maturity dates move
 * (and `invoice_date_due`, :1123-1128). Different amounts or a different number of terms refuse.
 */
export async function redateTerms(env: Environment, moveId: number, keepDue = false): Promise<void> {
  const move = (await env.cr.query<{ r: Row }>("SELECT row_to_json(m) AS r FROM account_move m WHERE id = $1", [moveId])).rows[0]!.r;
  const t = String(move["move_type"]);
  if (!(SALE_R.includes(t) || PURCHASE_R.includes(t))) return;
  const companyCurrency = (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [move["company_id"]])).rows[0]!.c;
  move["company_currency_id"] = companyCurrency;
  if (move["currency_id"] !== companyCurrency) {
    // account_move.py:1160-1186 the invoice's rate follows the new date (`expected_currency_rate` at the invoice date):
    // the same rate keeps every amount, only the maturities move; another rate (amounts in the company currency
    // recomputed) refuses
    if (await priv.account_move._get_invoice_currency_rate_date.overridden(env)) throw new NotPorted("the invoice's rate at a redated invoice with a module's _get_invoice_currency_rate_date");
    const date = String(move["invoice_date"] ?? move["date"] ?? await contextToday(env));
    const rate = await conversionRate(env, companyCurrency, Number(move["currency_id"]), Number(move["company_id"]), date);
    if (Math.abs(rate - Number(move["invoice_currency_rate"] ?? 0)) > 1e-12) throw new NotPorted("invoice date changing the currency rate of an invoice in a foreign currency");
  }
  const terms = (await env.cr.query<{ id: number; balance: number; amount: number; date: string | null; dd: string | null; db: number | null; da: number | null }>(
    `SELECT id, balance::float8 AS balance, amount_currency::float8 AS amount, date_maturity::text AS date, discount_date::text AS dd,
            discount_balance::float8 AS db, discount_amount_currency::float8 AS da
       FROM account_move_line WHERE move_id = $1 AND display_type = 'payment_term' ORDER BY date_maturity NULLS FIRST, id`, [moveId])).rows;
  if (!terms.length) return;
  const [others] = (await env.cr.query<{ b: number; a: number }>(
    "SELECT COALESCE(sum(balance), 0)::float8 AS b, COALESCE(sum(amount_currency), 0)::float8 AS a FROM account_move_line WHERE move_id = $1 AND display_type != 'payment_term'", [moveId])).rows;
  const needs = await neededTerms(env, move, -others!.b, -others!.a);
  if (needs.length !== terms.length || needs.some((n, i) => Math.abs(n.balance - terms[i]!.balance) > 1e-9 || Math.abs(n.amount - terms[i]!.amount) > 1e-9)) {
    throw new NotPorted("invoice date changing the payment term amounts (_sync_dynamic_line)");
  }
  for (let i = 0; i < terms.length; i++) {
    const n = needs[i]!, t = terms[i]!;
    // the key (date_maturity, discount_date) moves with the date: `_sync_dynamic_line` rewrites the one line
    const vals: Row = {};
    if (n.date !== t.date) vals["date_maturity"] = n.date;
    if (n.discountDate !== t.dd) vals["discount_date"] = n.discountDate;
    if (n.discountBalance !== Number(t.db ?? 0)) vals["discount_balance"] = n.discountBalance;
    if (n.discountAmount !== Number(t.da ?? 0)) vals["discount_amount_currency"] = n.discountAmount;
    if (Object.keys(vals).length) await updateRow(env, "account_move_line", t.id, vals);
  }
  const due = (needs.map((n) => n.date).filter((d): d is string => !!d).sort().at(-1) ?? null) || move["invoice_date_due"] || move["invoice_date"] || null;
  if (!keepDue && due !== move["invoice_date_due"]) await updateRow(env, "account_move", moveId, { invoice_date_due: due });
}

// account_move_line.py:652-693 `_compute_name` depends on move_id.ref and move_id.payment_reference: in the form, a product
// line with an empty name takes the product's text again
registerOnchange("account.move", "_compute_name_of_lines", ["ref", "payment_reference"], async (env, rec) => {
      if (!(rec instanceof NewRec)) return;
      const lines = (await rec.get("invoice_line_ids")) as unknown[] | null ?? [];
      const def = env.reg.model("account.move.line");
      const out: unknown[] = [];
      for (const id of lines) {
        if (typeof id !== "number") { out.push(id); continue; }
        const line = new DbRec(env, def, id);
        const name = await line.get("name");
        if (await line.get("product_id") && !name && !NOTES.includes(String(await line.get("display_type")))) {
          const value = await lineProductName(env, line);
          if (value !== name) {
            const edited = new NewRec(env, def, id);
            edited.put("name", value);
            out.push(edited);
            continue;
          }
        }
        out.push(id);
      }
      if (out.some((x) => typeof x !== "number")) rec.put("invoice_line_ids", out);
});

/** account_move.py:2678-2706 `_inverse_tax_totals`: only tax amounts edited by hand change anything (refused). */
async function refuseManualTaxTotals(env: Environment, moveId: number, totals: unknown): Promise<void> {
  const t = (await env.cr.query<{ t: string }>("SELECT move_type AS t FROM account_move WHERE id = $1", [moveId])).rows[0]?.t ?? "";
  if (!(SALE_R.includes(t) || PURCHASE_R.includes(t))) return;
  const sign = ["out_invoice", "in_refund", "out_receipt"].includes(t) ? -1 : 1;
  for (const subtotal of (totals as { subtotals?: { tax_groups?: { id: number; tax_amount_currency: number }[] }[] }).subtotals ?? []) {
    for (const group of subtotal.tax_groups ?? []) {
      const r = (await env.cr.query<{ s: number | null }>("SELECT SUM(amount_currency)::float8 AS s FROM account_move_line WHERE move_id = $1 AND tax_group_id = $2", [moveId, group.id])).rows[0]?.s;
      if (r === null || r === undefined) continue;
      if (Math.abs(r * sign - group.tax_amount_currency) >= 0.005) throw new NotPorted("tax amounts edited by hand (_inverse_tax_totals)");
    }
  }
}

/** account.move.line `_check_company_auto` (account_move_line.py): models.py:4232 `_check_company()` of the created line. */
async function checkLineCompany(env: Environment, lineId: number): Promise<void> {
  await checkCompany(env, env.reg.model("account.move.line"), [lineId], null);
}

/**
 * Moves created in this transaction with a company and a journal of another company: the given fields are protected
 * during the create, so `_inverse_journal_id`/`_inverse_company_id` recompute neither (account_move.py:2756-2760,
 * `_conditional_add_to_compute` skips protected fields) and the create ends with `_check_company`'s UserError
 * (models.py:4232, src/orm/create.ts). True when that check fails for them (the inverse then does nothing).
 */
async function failingCreatedCompanyCheck(env: Environment, ids: readonly number[]): Promise<boolean> {
  if (!ids.every((id) => createdInTransaction(env.cr, "account.move", id))) return false;
  try {
    await checkCompany(env, env.reg.model("account.move"), ids, null);
  } catch (e) {
    if (e instanceof UserError) return true;
    throw e;
  }
  return false;
}

registerOverrides("account.move", {
  inverse: {
    // account_move.py:952-960 and the sibling inverses: the moves that would need a recompute refuse
    company_id: async (env, ids) => {
      for (const r of (await env.cr.query<{ c: number | null; jc: number | null }>(
        "SELECT m.company_id AS c, j.company_id AS jc FROM account_move m LEFT JOIN account_journal j ON j.id = m.journal_id WHERE m.id = ANY($1::int[])", [ids])).rows) {
        if (!r.c) throw new ValidationError(translate(env, "We can't leave this document without any company. Please select a company for this document."));
        if (r.jc !== null && r.jc !== r.c && !(await failingCreatedCompanyCheck(env, ids))) throw new NotPorted("account.move journal of another company (_inverse_company_id)");
      }
    },
    journal_id: async (env, ids) => {
      const bad = (await env.cr.query<{ id: number; company: boolean }>(
        `SELECT m.id, m.company_id IS DISTINCT FROM j.company_id AS company FROM account_move m JOIN account_journal j ON j.id = m.journal_id
          WHERE m.id = ANY($1::int[]) AND (m.company_id IS DISTINCT FROM j.company_id OR m.currency_id IS NULL OR (j.currency_id IS NOT NULL AND m.currency_id != j.currency_id))`, [ids])).rows;
      // a move created with its company and a journal of another one: the company is protected during the create (its
      // `_conditional_add_to_compute` skips protected fields, account_move.py:2756-2760), so nothing is recomputed and
      // the create ends with `_check_company`'s UserError (models.py:4232, src/orm/create.ts); only a check that would
      // pass refuses (the company would then stay as given)
      const created = bad.filter((r) => r.company && createdInTransaction(env.cr, "account.move", r.id)).map((r) => r.id);
      if (created.length && !(await failingCreatedCompanyCheck(env, created))) throw new NotPorted("account.move created with a company and a journal of another one passing _check_company");
      if (bad.some((r) => !created.includes(r.id))) throw new NotPorted("account.move journal change moving company or currency (_inverse_journal_id)");
    },
    currency_id: async (env, ids) => {
      const bad = await env.cr.query("SELECT 1 FROM account_move_line l JOIN account_move m ON m.id = l.move_id WHERE m.id = ANY($1::int[]) AND m.move_type != 'entry' AND l.currency_id IS DISTINCT FROM m.currency_id LIMIT 1", [ids]);
      if (bad.rows.length) throw new NotPorted("account.move currency change with lines (_inverse_currency_id)");
    },
    partner_id: async (env, ids) => {
      await env.cr.query(`UPDATE account_move_line l SET partner_id = m.commercial_partner_id FROM account_move m
        WHERE l.move_id = m.id AND m.id = ANY($1::int[]) AND m.move_type != 'entry' AND l.partner_id IS DISTINCT FROM m.commercial_partner_id`, [ids]);
    },
    payment_reference: async () => undefined, // the term lines take it when they are created
    invoice_payment_term_id: async () => undefined,
    // account_move.py:2778-2782 _inverse_name: the payment reference compute only acts on posted invoices
    name: async (env, ids) => { for (const id of ids) await updateSequenceGap(env, id); },
    // account_move.py:2080-2082: `_set_links_to_new_tab` only touches links
    narration: async (env, ids) => {
      // ::text: narration is jsonb where a module translates it (l10n_gcc_invoice account_move.py:20): any language
      const links = await env.cr.query("SELECT 1 FROM account_move WHERE id = ANY($1::int[]) AND narration::text ILIKE '%<a %' LIMIT 1", [ids]);
      if (links.rows.length) throw new NotPorted("account.move.narration with links (_set_links_to_new_tab)");
    },
    // account_move.py:2675-2676 `_inverse_delivery_date` (account's `pass`) through the private hook (l10n_hu_edi: the
    // rate of a Hungarian move recomputed)
    delivery_date: async (env, ids) => { await priv.account_move._inverse_delivery_date.call(env, ids, [], async () => null); },
    amount_total: async (env, ids) => {
      const lines = await env.cr.query("SELECT m.id FROM account_move m JOIN account_move_line l ON l.move_id = m.id WHERE m.id = ANY($1::int[]) AND m.move_type = 'entry' GROUP BY m.id HAVING count(*) = 2 LIMIT 1", [ids]);
      if (lines.rows.length) throw new NotPorted("account.move.amount_total written on a two line entry");
    },
  },
  constraints: [
    // account_move.py:2993-2999 _check_journal_move_type
    {
      fields: ["journal_id", "move_type"],
      fn: async (env, ids) => {
        for (const r of (await env.cr.query<{ t: string; j: string | null }>(
          "SELECT m.move_type AS t, j.type AS j FROM account_move m LEFT JOIN account_journal j ON j.id = m.journal_id WHERE m.id = ANY($1::int[])", [ids])).rows) {
          if (PURCHASE_R.includes(r.t) && r.j !== "purchase") throw new ValidationError(translate(env, "Cannot create a purchase document in a non purchase journal"));
          if (SALE_R.includes(r.t) && r.j !== "sale") throw new ValidationError(translate(env, "Cannot create a sale document in a non sale journal"));
        }
      },
    },
  ],
  // account_move.py:3976-3993 create, the lines after the move (`_sync_dynamic_lines` around it)
  create: async (env, valsList, next) => {
    if (valsList.some((v) => v["state"] === "posted")) throw new UserError(translate(env, "You cannot create a move already in the posted state. Please create a draft move and post it after."));
    // journal entries with their lines (line_ids) as accounts and amounts; invoices give theirs as invoice_line_ids
    const entryLines = valsList.map((v) => (v["line_ids"] as unknown[][] | undefined) ?? []);
    for (let i = 0; i < valsList.length; i++) {
      if (!entryLines[i]!.length) continue;
      const v = valsList[i]!;
      const type = v["move_type"] ?? env.context["default_move_type"] ?? "entry";
      if ((v["invoice_line_ids"] as unknown[] | undefined)?.length) throw new NotPorted("account.move.create with both line_ids and invoice_line_ids");
      if (type !== "entry") {
        // an invoice given all its lines, as its copy gives them (src/models/account_move_copy.ts): product and note
        // lines, then the tax and payment term lines with their values, created in their order
        for (const c of entryLines[i]!) {
          if (!Array.isArray(c) || c[0] !== 0 || !c[2] || typeof c[2] !== "object") throw new NotPorted("account.move.create of an invoice with line_ids commands other than create");
          const dt = (c[2] as Row)["display_type"];
          if (!["product", "tax", "payment_term", ...NOTES].includes(String(dt))) throw new NotPorted(`account.move.create of an invoice with a ${String(dt)} line in line_ids`);
        }
        continue;
      }
      const lineDef = env.reg.model("account.move.line");
      for (const c of entryLines[i]!) {
        if (!Array.isArray(c) || c[0] !== 0 || !c[2] || typeof c[2] !== "object") throw new NotPorted("account.move.create with line_ids commands other than create");
        // models.py copy_data of a one2many (a copied entry, src/models/account_move_copy.ts): the lines carry their
        // old parent (Command.create sets the new one) and the non-stored computed fields, which create drops
        const lv = c[2] as Row;
        for (const k of Object.keys(lv)) if (k === "move_id" || lineDef.fields.get(k)?.store === false) delete lv[k];
        const extra = Object.keys(lv).filter((k) => !ENTRY_LINE_KEYS.has(k) && !ENTRY_COPY_KEYS.has(k));
        if (extra.length) throw new NotPorted(`account.move.create of entry lines with ${extra.join(", ")}`);
        // taxes on an entry line make tax lines (`_sync_tax_lines`): not here
        if (taxesAfter([], lv["tax_ids"] ?? []).length || lv["tax_repartition_line_id"] || lv["group_tax_id"]) throw new NotPorted("account.move.create of entry lines with taxes");
      }
    }
    const lines = valsList.map((v) => (v["invoice_line_ids"] as unknown[][] | undefined) ?? []);
    let ids: number[];
    try {
      ids = await next(env, valsList.map((v) => { const { invoice_line_ids: _i, line_ids: _l, tax_totals: _t, ...rest } = v; return rest; }));
    } catch (e) {
      // models.py:4192-4233: `_create` inserts the moves and creates their x2many lines before the inverses and
      // `_check_company`; when that check fails the transaction rolls back, but the lines' ids stay consumed (a
      // Postgres sequence is not transactional). The port creates the lines after, so it takes their ids here.
      if (e instanceof CompanyInconsistencyError) {
        const n = valsList.reduce((k, _v, i) => k + [...lines[i]!, ...entryLines[i]!].filter((c) => Array.isArray(c) && c[0] === 0).length, 0);
        if (n) await env.cr.query("SELECT nextval('account_move_line_id_seq') FROM generate_series(1, $1)", [n]);
      }
      throw e;
    }
    const isEntry = (i: number): boolean => (valsList[i]!["move_type"] ?? env.context["default_move_type"] ?? "entry") === "entry";
    for (let i = 0; i < ids.length; i++) {
      if (!entryLines[i]!.length || isEntry(i)) continue;
      for (const c of entryLines[i]!) {
        // models.py copy_data of a one2many: the lines carry their old parent (Command.create sets the new one) and
        // the non-stored computed fields, which create drops (no inverse)
        const lineDef = env.reg.model("account.move.line");
        const lv = Object.fromEntries(Object.entries(c[2] as Row).filter(([k]) => k !== "move_id" && (lineDef.fields.get(k)?.store ?? true))) as Row;
        const dt = String(lv["display_type"]);
        await checkLineCompany(env, dt === "tax" || dt === "payment_term" ? await createGivenDynamicLine(env, ids[i]!, lv) : await createInvoiceLine(env, ids[i]!, lv));
      }
      // given tax or payment term lines (a copy's) are checked against the needed ones; product lines alone (the
      // credit note wizard's "modify", account_move_reversal.py:159-160) get them from the sync as invoice lines do
      const dynamic = entryLines[i]!.some((c) => ["tax", "payment_term"].includes(String((c[2] as Row)["display_type"])));
      await syncInvoice(env, ids[i]!, { givenDynamic: dynamic });
    }
    for (let i = 0; i < ids.length; i++) {
      if (!entryLines[i]!.length || !isEntry(i)) continue;
      for (const c of entryLines[i]!) await checkLineCompany(env, await createEntryLine(env, ids[i]!, c[2] as Row));
      await entryAmounts(env, ids[i]!);
    }
    // account_move.py:3981 `_check_balanced` around the creation: an unbalanced entry rolls the whole create back,
    // after mail.thread's create (the creation message and follower of each move, mail_thread.py:357-398) has run
    const entries = ids.filter((_id, i) => entryLines[i]!.length && isEntry(i));
    try {
      await checkBalanced(env, entries);
    } catch (e) {
      for (const h of hooksOf("account.move").write ?? []) if (h.afterCreate) await h.afterCreate(env, ids, valsList);
      throw e;
    }
    // models.py `_create`: the invoice lines of every move, then account_move.py:3724-3757 `_sync_dynamic_lines` on
    // the batch: the tax lines of every move, then their payment term lines
    for (let i = 0; i < ids.length; i++) {
      for (const c of lines[i]!) {
        if (c[0] !== 0) throw new NotPorted(`invoice_line_ids command ${String(c[0])} at creation`);
        await checkLineCompany(env, await createInvoiceLine(env, ids[i]!, c[2] as Row));
      }
    }
    const terms: (() => Promise<void>)[] = [];
    for (let i = 0; i < ids.length; i++) if (lines[i]!.length) await syncInvoice(env, ids[i]!, { terms });
    for (const t of terms) await t();
    await applyStorno(env, ids);
    for (let i = 0; i < ids.length; i++) {
      if (lines[i]!.length && valsList[i]!["tax_totals"]) await refuseManualTaxTotals(env, ids[i]!, valsList[i]!["tax_totals"]);
    }
    await env.cr.query("UPDATE account_move SET is_manually_modified = FALSE WHERE id = ANY($1::int[])", [ids]);
    noteMoveCreateReset(env.cr, ids); // repeated after mail.thread's create (src/mail/write_hooks.ts)
    return ids;
  },
  // account_move.py:3995-4110 write on draft moves
  write: async (env, ids, vals0, next) => {
    if (!Object.keys(vals0).length) return; // :3996-3997
    await checkMoveWrite(env, ids, vals0);
    const vals = { ...vals0 };
    if ((vals["line_ids"] as unknown[] | undefined)?.length) throw new NotPorted("account.move.write of line_ids");
    const commands = (vals["invoice_line_ids"] as unknown[][] | undefined) ?? [];
    // :665 `invoice_vendor_bill_id` is not stored and has no inverse: the write puts it in the cache only (fields.py
    // Field.write), its onchange (:2793-2806) is the form's; read back through src/models/invoicing_computes.ts
    if ("invoice_vendor_bill_id" in vals) {
      const bill = vals["invoice_vendor_bill_id"];
      if (bill !== false && bill !== null && typeof bill !== "number") throw new NotPorted(`account.move.invoice_vendor_bill_id written as ${JSON.stringify(bill)}`);
      // models.py write `_check_company` of the check_company field (:665): a bill of another company is not ported
      if (bill && (await env.cr.query("SELECT 1 FROM account_move m, account_move b WHERE m.id = ANY($1::int[]) AND b.id = $2 AND m.company_id IS DISTINCT FROM b.company_id", [ids, bill])).rows.length) {
        throw new NotPorted("account.move.invoice_vendor_bill_id of another company (_check_company)");
      }
      setOverlay(env, "account.move", "invoice_vendor_bill_id", ids, bill || null);
      delete vals["invoice_vendor_bill_id"];
    }
    const taxTotals = vals["tax_totals"];
    delete vals["invoice_line_ids"]; delete vals["line_ids"]; delete vals["tax_totals"];
    const states = (await env.cr.query<{ state: string }>("SELECT state FROM account_move WHERE id = ANY($1::int[])", [ids])).rows;
    const accounting = ["date", "invoice_date", "partner_id", "fiscal_position_id", "invoice_payment_term_id", "currency_id", "invoice_cash_rounding_id"];
    if (commands.length && states.some((s) => s.state !== "draft")) throw new NotPorted("account.move lines written on a posted move");
    if (states.some((s) => s.state === "posted") && accounting.some((f) => f in vals)) throw new NotPorted("account.move accounting fields written on a posted move");
    // account_move.py:3724-3757: these fields move the dynamic lines of an invoice that has lines (only a first set of lines is synced here)
    const dynamic = ["date", "invoice_date", "invoice_date_due", "partner_id", "fiscal_position_id", "invoice_payment_term_id", "currency_id", "invoice_cash_rounding_id"].filter((f) => f in vals);
    // on a draft invoice the invoice date, the due date, the payment term and the customer may move its dynamic lines
    // here when the amounts stay: the terms are re-dated (`_sync_dynamic_line` reusing the one term line) and the lines
    // follow the customer (account_move_line.py:637-640 `_compute_partner_id`); a customer bringing another fiscal
    // position or currency (taxes and accounts mapped again) refuses after the write
    const REDATING = ["invoice_date", "invoice_date_due", "invoice_payment_term_id", "partner_id"];
    // on a posted invoice only the due date may be given (:4000-4008 refuse the others): its payment term lines are
    // re-dated the same way (account_move_line.py:3721-3728, a maturity is no hashed field of a journal item)
    const redate = dynamic.length > 0 && dynamic.every((f) => REDATING.includes(f)) && !commands.length
      && (states.every((st) => st.state === "draft") || dynamic.every((f) => f === "invoice_date_due"));
    const before = new Map((await env.cr.query<{ id: number; fp: number | null; cur: number | null; cp: number | null }>(
      "SELECT id, fiscal_position_id AS fp, currency_id AS cur, commercial_partner_id AS cp FROM account_move WHERE id = ANY($1::int[])", [ids])).rows.map((r) => [r.id, r]));
    if (dynamic.length && !redate && (await env.cr.query("SELECT 1 FROM account_move_line WHERE move_id = ANY($1::int[]) LIMIT 1", [ids])).rows.length) {
      throw new NotPorted("account.move accounting fields written on a move with lines (_sync_dynamic_lines)");
    }
    // :4083 entering `_sync_dynamic_lines` (unless skip_invoice_sync, :3828) writes the dirty flags of the invoices and
    // their lines: every write on an invoice writes its lines (measured on Odoo for sending_data, ref, access_token)
    if (!env.context["skip_invoice_sync"]) await touchSyncedInvoices(env, ids);
    if (!("is_manually_modified" in vals) && !env.context["skip_is_manually_modified"]) vals["is_manually_modified"] = true;
    // :4084 `_sync_dynamic_lines`: the journal items of invoices posted once are tracked on the move, logged after it
    await prepareLineTracking(env, ids, []);
    afterTracking(env.cr, "account.move", () => trackRecordFinalize(env, "account.move.line"));
    await trackPrepare(env, "account.move", ids);
    // account_move.py:3390-3437 `_sync_tax_lines`: a draft invoice whose tax mode changes is synced again without
    // rounding from its tax lines (a posted one only gets its lines' totals, account_move_line.py:1254)
    const taxMode = "document_tax_mode" in vals && !commands.length ? (await env.cr.query<{ id: number }>(
      `SELECT id FROM account_move WHERE id = ANY($1::int[]) AND state = 'draft' AND move_type != 'entry'
          AND document_tax_mode IS DISTINCT FROM $2`, [ids, vals["document_tax_mode"] || null])).rows.map((r) => r.id) : [];
    const postedTaxMode = "document_tax_mode" in vals && !commands.length ? (await env.cr.query<{ id: number }>(
      `SELECT id FROM account_move WHERE id = ANY($1::int[]) AND state != 'draft' AND move_type != 'entry'
          AND document_tax_mode IS DISTINCT FROM $2`, [ids, vals["document_tax_mode"] || null])).rows.map((r) => r.id) : [];
    // the move type: the lines' totals follow the new direction sign (account_move.py:1660-1690
    // `_prepare_product_base_line_for_taxes_computation`), a draft invoice is synced again (:3431-3437, the tax lines
    // of the refund repartition), a posted one keeps its journal items and gets its amounts again (:1211-1262)
    const typed = "move_type" in vals ? (await env.cr.query<{ id: number; state: string; t: string }>(
      "SELECT id, state, move_type AS t FROM account_move WHERE id = ANY($1::int[]) AND move_type IS DISTINCT FROM $2", [ids, vals["move_type"]])).rows : [];
    for (const t of typed) {
      // ported: a draft invoice becoming the refund of its side or back (its lines synced again), a posted invoice
      // becoming a journal entry (Odoo keeps its journal items). Another type on a posted invoice re-syncs its payment
      // terms (`_sync_dynamic_line` with needed terms of the new sign), a draft entry or a side change maps its
      // journal and accounts again: not ported
      const to = String(vals["move_type"]);
      const sameSide = (SALE.includes(t.t) && SALE.includes(to)) || (PURCHASE.includes(t.t) && PURCHASE.includes(to));
      if (commands.length || (t.state === "draft" ? !sameSide : !([...SALE, ...PURCHASE].includes(t.t) && to === "entry"))) {
        throw new NotPorted(`account.move.move_type written from ${t.t} to ${to} on a ${t.state} move`);
      }
    }
    await next(env, ids, vals);
    for (const t of typed) {
      await refreshLineTotals(env, t.id);
      if (t.state === "draft") await syncInvoice(env, t.id, { resync: true });
      else await refreshResidualFromTaxTotals(env, t.id);
    }
    for (const id of taxMode) await syncInvoice(env, id, { resync: true });
    for (const id of postedTaxMode) await refreshResidualFromTaxTotals(env, id);
    if (redate) {
      for (const id of ids) {
        // the lines a fiscal position or currency maps again: an entry's lines without product keep their accounts
        // and taxes (`_compute_account_id`/`_compute_tax_ids` act on product lines, `_sync_dynamic_lines` on
        // invoices: a bank statement line's move taking its partner, account_bank_statement_line.py:832-836)
        const [now] = (await env.cr.query<{ fp: number | null; cur: number | null; cp: number | null; lines: number }>(
          `SELECT fiscal_position_id AS fp, currency_id AS cur, commercial_partner_id AS cp,
                  (SELECT count(*)::int FROM account_move_line WHERE move_id = $1 AND (m.move_type != 'entry' OR product_id IS NOT NULL)) AS lines
             FROM account_move m WHERE id = $1`, [id])).rows;
        const was = before.get(id);
        if (now && was && now.lines && (now.fp !== was.fp || now.cur !== was.cur)) {
          throw new NotPorted("account.move customer change bringing another fiscal position or currency on a move with lines (taxes and accounts mapped again)");
        }
        if (now && was && now.cp !== was.cp) {
          // `_compute_partner_id` of every line (the cogs lines included): the move's commercial partner
          const lines = (await env.cr.query<{ id: number }>("SELECT id FROM account_move_line WHERE move_id = $1 AND partner_id IS DISTINCT FROM $2 ORDER BY id", [id, now.cp])).rows;
          for (const l of lines) await updateRow(env, "account_move_line", l.id, { partner_id: now.cp });
        }
        // the due date written is protected (models.py write): only the maturities follow it
        await redateTerms(env, id, "invoice_date_due" in vals);
      }
    }
    for (const id of ids) {
      const nameOnly = (c: unknown[]): boolean => c[0] === 1 && Object.keys(c[2] as Row).every((k) => k === "name");
      const layoutOnly = (c: unknown[]): boolean => c[0] === 1 && Object.keys(c[2] as Row).every((k) => k === "name" || k === "sequence");
      const synced = commands.some((c) => !layoutOnly(c));
      // account_move.py:3431-3460 `_sync_tax_lines`: a change of base lines that all lack taxes rounds from the tax lines
      // (`round_from_tax_lines`) and keeps the amounts of lines given with them: not ported
      if (synced && commands.some((c) => c[0] === 1 || c[0] === 2)) await refuseRoundFromTaxLines(env, id, commands);
      const orders = await linkedSaleOrders(env, id);
      // the removed lines are unlinked at the end of the sync: the ORM's recompute of the move's amounts after an
      // unlink (Odoo's flush, after `_sync_dynamic_lines`) must see the synced tax and payment term lines
      const removed = new Set<number>();
      for (const c of commands) {
        if (c[0] === 0) {
          const line = await createInvoiceLine(env, id, c[2] as Row);
          await checkLineCompany(env, line);
          await trackCreatedLine(env, line);
        }
        else if (nameOnly(c)) await updateRow(env, "account_move_line", Number(c[1]), { name: (c[2] as Row)["name"] || null });
        else if (c[0] === 1) await updateInvoiceLine(env, id, Number(c[1]), c[2] as Row);
        else if (c[0] === 2) await unlinkInvoiceLine(env, id, Number(c[1]), removed);
        else throw new NotPorted(`invoice_line_ids command ${String(c[0])}`);
      }
      if (synced) await syncInvoice(env, id, { resync: commands.some((c) => c[0] === 0 || c[0] === 1 || c[0] === 2), removed });
      // a move the sync leaves alone (not an invoice, not a draft) still loses its removed lines
      const left = removed.size ? (await env.cr.query<{ id: number }>("SELECT id FROM account_move_line WHERE id = ANY($1::int[])", [[...removed]])).rows.map((r) => r.id) : [];
      if (left.length) await syncUnlink(env, left);
      if (taxTotals) await refuseManualTaxTotals(env, id, taxTotals);
      // the invoiced quantities of the order lines depend on the invoice lines (sale_order_line.py:1278-1292)
      const after = await linkedSaleOrders(env, id);
      const touched = [...new Set([...orders, ...after])];
      if (touched.length && commands.some((c) => c[0] === 0 || c[0] === 1 || c[0] === 2)) {
        const { refreshInvoiced } = await import("./sale_invoice");
        await refreshInvoiced(env, touched);
      }
    }
    await applyStorno(env, ids);
    for (const h of hooksOf("account.move").write ?? []) if (h.afterWrite) await h.afterWrite(env, ids, {}, new Map());
  },
});

// ------------------------------------------------------------------------------------------------ account.tax

/** account_tax.py:579-612 `_sanitize_vals`: the document type of the repartition lines (a plain text description is not ported). */
function sanitizeTax(vals: Row): Row {
  const out = { ...vals };
  // :583-590 a plain-text description (no tag) is wrapped in <div>; translate.py:918-944 for a str value (a dict
  // of languages refuses)
  if (out["description"]) {
    const d = out["description"];
    if (typeof d !== "string") throw new NotPorted("account.tax description given per language (adapt_translated_field_value)");
    if (!/<[^>]+>/.test(d)) out["description"] = `<div>${d}</div>`;
  }
  if ("repartition_line_ids" in out && ("invoice_repartition_line_ids" in out || "refund_repartition_line_ids" in out)) delete out["repartition_line_ids"];
  for (const doc of ["invoice", "refund"]) {
    const field = `${doc}_repartition_line_ids`;
    if (!(field in out)) continue;
    const repartition = (out["repartition_line_ids"] as unknown[][] | undefined) ?? [];
    for (const c of out[field] as unknown[][]) {
      if (c[0] === 0) repartition.push([0, c[1], { document_type: doc, ...(c[2] as Row) }]);
      else if (c[0] === 1) repartition.push([1, c[1], { document_type: doc, ...(c[2] as Row) }]);
      else repartition.push(c);
    }
    out["repartition_line_ids"] = repartition;
    delete out[field];
  }
  // :438-454 `_compute_invoice/refund_repartition_line_ids` only fill a tax without lines of that document type:
  // lines given through repartition_line_ids keep the defaults (src/models/invoicing_computes.ts) away
  if (Array.isArray(out["repartition_line_ids"])) {
    for (const doc of ["invoice", "refund"]) {
      const given = (out["repartition_line_ids"] as unknown[][]).some((c) => c[0] === 0 && (c[2] as Row | undefined)?.["document_type"] === doc);
      if (given && !(`${doc}_repartition_line_ids` in out)) out[`${doc}_repartition_line_ids`] = [];
    }
  }
  return out;
}

interface RepLine { id: number; document_type: string; repartition_type: string; factor_percent: number; sequence: number }
registerOverrides("account.tax", {
  // account_tax.py:614-624 create
  create: async (env, valsList, next) => next(env.withContext({
    ...env.context, mail_create_nosubscribe: true, mail_auto_subscribe_no_notify: true, mail_create_nolog: true, from_account_tax_creation: true,
  }), valsList.map(sanitizeTax)),
  write: async (env, ids, vals, next) => next(env, ids, sanitizeTax(vals)),
  constraints: [
    // account_tax.py:218-245 _constrains_name
    {
      fields: ["company_id", "name", "type_tax_use", "tax_scope", "country_id"],
      fn: async (env, ids) => {
        const rows = (await env.cr.query<{ name: string; company: string }>(
          `SELECT COALESCE(d.name->>$2, d.name->>'en_US') AS name, c.name AS company
             FROM account_tax t JOIN res_company tc ON tc.id = t.company_id
             JOIN account_tax d ON d.id != t.id AND d.name->>'en_US' = t.name->>'en_US' AND d.type_tax_use = t.type_tax_use
                  AND d.tax_scope IS NOT DISTINCT FROM t.tax_scope AND d.country_id IS NOT DISTINCT FROM t.country_id
             JOIN res_company c ON c.id = d.company_id AND c.parent_path LIKE split_part(tc.parent_path, '/', 1) || '/%'
            WHERE t.id = ANY($1::int[]) AND t.type_tax_use != 'none' ORDER BY d.sequence, d.id`, [ids, env.lang ?? "en_US"])).rows;
        if (rows.length) throw new ValidationError(`${translate(env, "Tax names must be unique!")}\n${rows.map((r) => `- ${r.name} in ${r.company}`).join("\n")}`);
      },
    },
    // account_tax.py:247-251 validate_tax_group_id
    {
      fields: ["tax_group_id"],
      fn: async (env, ids) => {
        const bad = await env.cr.query(`SELECT 1 FROM account_tax t JOIN account_tax_group g ON g.id = t.tax_group_id
          WHERE t.id = ANY($1::int[]) AND g.country_id IS NOT NULL AND g.country_id IS DISTINCT FROM t.country_id LIMIT 1`, [ids]);
        if (bad.rows.length) throw new ValidationError(translate(env, "The tax group must have the same country_id as the tax using it."));
      },
    },
    // account_tax.py:503-545 `_check_repartition_lines` and `_validate_repartition_lines`
    {
      fields: ["invoice_repartition_line_ids", "refund_repartition_line_ids", "repartition_line_ids"],
      fn: async (env, ids) => {
        for (const id of ids) {
          const lines = (await env.cr.query<RepLine>(
            `SELECT id, document_type, repartition_type, factor_percent::float8 AS factor_percent, sequence FROM account_tax_repartition_line WHERE tax_id = $1 ORDER BY sequence, id`, [id])).rows;
          const inv = lines.filter((l) => l.document_type === "invoice"), ref = lines.filter((l) => l.document_type === "refund");
          const type = (await env.cr.query<{ t: string }>("SELECT amount_type AS t FROM account_tax WHERE id = $1", [id])).rows[0]?.t;
          if (type === "group" && !inv.length && !ref.length) continue;
          for (const list of [inv, ref]) {
            if (list.filter((l) => l.repartition_type === "base").length !== 1) throw new ValidationError(translate(env, "Invoice and credit note distribution should each contain exactly one line for the base."));
          }
          if (inv.length !== ref.length) throw new ValidationError(translate(env, "Invoice and credit note distribution should have the same number of lines."));
          if (!inv.some((l) => l.repartition_type === "tax") || !ref.some((l) => l.repartition_type === "tax")) throw new ValidationError(translate(env, "Invoice and credit note repartition should have at least one tax repartition line."));
          for (let i = 0; i < inv.length; i++) {
            if (inv[i]!.repartition_type !== ref[i]!.repartition_type || inv[i]!.factor_percent !== ref[i]!.factor_percent) throw new ValidationError(translate(env, "Invoice and credit note distribution should match (same percentages, in the same order)."));
          }
          const taxes = inv.filter((l) => l.repartition_type === "tax");
          const pos = taxes.filter((l) => l.factor_percent > 0).reduce((a, l) => a + l.factor_percent / 100, 0);
          if (Math.abs(pos - 1) >= 0.005) throw new ValidationError(translate(env, "Invoice and credit note distribution should have a total factor (+) equals to 100."));
          const neg = taxes.filter((l) => l.factor_percent < 0).reduce((a, l) => a + l.factor_percent / 100, 0);
          if (neg && Math.abs(neg + 1) >= 0.005) throw new ValidationError(translate(env, "Invoice and credit note distribution should have a total factor (-) equals to 100."));
        }
      },
    },
  ],
});

// account_tax.py:486-501 `_search`: a `like`/`ilike` condition on name or display_name with a string searches the
// parsed name (map_conditions does not enter `any` sub-domains, nor a negated operator)
registerHooks("account.tax", {
  searchDomain: (_env, domain) => mapConditions(domain, (c) => ["name", "display_name"].includes(c.path) && ["like", "ilike"].includes(c.op) && typeof c.value === "string"
    ? cond(c.path, c.op, parseTaxNameSearch(c.value)) : c),
});

// account_tax.py:255-272 name_search: the taxes usable with the fiscal position of the invoice line
registerHooks("account.tax", {
  nameSearch: async (env, name, domain, operator, limit) => {
    let d = domain;
    const Tax = env.model("account.tax");
    if ("search_default_domestictax" in env.context) d = and([d, or([cond("fiscal_position_ids", "=", false), cond("fiscal_position_ids.is_domestic", "=", true)])]);
    const fp = env.context["dynamic_fiscal_position_id"];
    if (fp) d = and([d, or([cond("fiscal_position_ids", "=", false), cond("fiscal_position_ids", "in", [Number(fp)])])]);
    if (env.context["hide_original_tax_ids"] && fp) {
      const shown = await Tax.search(d);
      const hidden = (await env.cr.query<{ id: number }>(
        `SELECT DISTINCT a.src_tax_id AS id FROM account_tax_alternatives a
          WHERE a.dest_tax_id = ANY($1::int[]) AND a.src_tax_id != a.dest_tax_id
            AND NOT EXISTS (SELECT 1 FROM account_tax_alternatives s WHERE s.src_tax_id = a.src_tax_id AND s.dest_tax_id = a.src_tax_id)`, [shown])).rows.map((r) => r.id);
      if (hidden.length) d = and([d, cond("id", "not in", hidden)]);
    }
    const ids = await Tax.search(and([cond("display_name", operator, name), d]), { limit });
    const names = await env.sudo().model("account.tax").displayName(ids);
    return ids.map((id) => [id, names.get(id) ?? ""] as [number, string]);
  },
});

// account_move.py:4217-4227 `onchange`: one tab changes at a time, so the other tab's lines leave the values and the spec
registerMethod("account.move", "onchange", async (env, ids, args, kwargs, model) => {
  const raw = kwargs["field_names"] ?? args[1];
  const names = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  const drop = names.includes("line_ids") ? "invoice_line_ids" : names.includes("invoice_line_ids") ? "line_ids" : null;
  if (drop === null) return onchangeCall(env, ids, args, kwargs, model);
  const without = (v: unknown): unknown => (typeof v === "object" && v !== null && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== drop)) : v);
  const a = [...args];
  const kw = { ...kwargs };
  if ("values" in kw) kw["values"] = without(kw["values"]); else if (a.length > 0) a[0] = without(a[0]);
  if ("fields_spec" in kw) kw["fields_spec"] = without(kw["fields_spec"]); else if (a.length > 2) a[2] = without(a[2]);
  return onchangeCall(env, ids, a, kw, model);
}, { apiModel: false });

/** account_move.py:6724-6726 `refresh_invoice_currency_rate`: writes `expected_currency_rate` and syncs lines. */
export async function refreshInvoiceCurrencyRate(env: Environment, moveIds: readonly number[]): Promise<void> {
  if (!moveIds.length) return;
  const def = env.reg.model("account.move");
  for (const id of moveIds) {
    const rec = new DbRec(env, def, id);
    const expected = plainNumber(await rec.get("expected_currency_rate"));
    const prev = (await env.cr.query<{ r: string | null; state: string; move_type: string }>(
      "SELECT invoice_currency_rate::text AS r, state, move_type FROM account_move WHERE id = $1", [id])).rows[0];
    await write(env, "account.move", [id], { invoice_currency_rate: expected });
    if (prev && prev.state === "draft" && (SALE_R.includes(prev.move_type) || PURCHASE_R.includes(prev.move_type))) {
      const hasLines = (await env.cr.query("SELECT 1 FROM account_move_line WHERE move_id = $1 LIMIT 1", [id])).rows.length > 0;
      if (hasLines && Math.abs(Number(prev.r ?? 0) - expected) > 1e-12) {
        await syncInvoice(env, id, { resync: true });
      }
    }
  }
}

/**
 * account_move.py:6614-6642 `action_update_fpos_values`: recomputes `tax_ids`, `account_id` (and `price_unit` for
 * zero-price lines) after a fiscal position change, then syncs dynamic lines and checks balance.
 */
export async function updateFposValues(env: Environment, moveIds: readonly number[]): Promise<void> {
  if (!moveIds.length) return;
  const moveDef = env.reg.model("account.move");
  const lineDef = env.reg.model("account.move.line");
  const { recordCompute } = await import("../orm/recompute");
  const { checkBalanced } = await import("./account_integrity");
  await trackPrepare(env, "account.move", [...moveIds]);
  if (!env.context["skip_invoice_sync"]) await touchSyncedInvoices(env, [...moveIds]);
  for (const moveId of moveIds) {
    const moveRec = new DbRec(env, moveDef, moveId);
    const allLines = (await env.cr.query<{ id: number; display_type: string | null; price_unit: string | null; document_tax_mode: string | null }>(
      `SELECT l.id, l.display_type, l.price_unit::text AS price_unit, m.document_tax_mode
         FROM account_move_line l JOIN account_move m ON m.id = l.move_id
        WHERE l.move_id = $1 ORDER BY l.sequence, l.id`, [moveId])).rows;
    const invoiceLines = allLines.filter((l) => !["tax", "payment_term", "rounding", "epd", "cogs"].includes(String(l.display_type ?? "")));
    const recomputePriceUnit = new Set<number>();
    for (const l of invoiceLines) {
      if (l.display_type === "line_section" || l.display_type === "line_note" || l.display_type === "line_subsection") continue;
      if (!Number(l.price_unit ?? 0)) {
        recomputePriceUnit.add(l.id);
        continue;
      }
      const lineRec = new DbRec(env, lineDef, l.id);
      const newTaxes = await computedTaxes(env, lineRec, moveRec);
      const curTaxes = (await env.cr.query<{ t: number }>(
        "SELECT account_tax_id AS t FROM account_move_line_account_tax_rel WHERE account_move_line_id = $1 ORDER BY account_tax_id", [l.id])).rows.map((r) => r.t);
      const priceIncluded = async (taxIds: number[]): Promise<number[]> => {
        if (!taxIds.length) return [];
        const rows = (await env.cr.query<{ id: number; amount_type: string; price_include_override: string | null; company_price_include: string | null }>(
          `SELECT t.id, t.amount_type, t.price_include_override, c.account_price_include AS company_price_include
             FROM account_tax t LEFT JOIN res_company c ON c.id = t.company_id
            WHERE t.id = ANY($1::int[]) ORDER BY t.id`, [taxIds])).rows;
        if (rows.some((r) => r.amount_type === "group")) throw new NotPorted("action_update_fpos_values with group taxes (flatten_taxes_hierarchy)");
        return rows.filter((r) => {
          if (r.price_include_override) return r.price_include_override === "tax_included";
          if (l.document_tax_mode) return l.document_tax_mode === "tax_included";
          return r.company_price_include === "tax_included";
        }).map((r) => r.id);
      };
      const beforeInc = await priceIncluded(curTaxes);
      const afterInc = await priceIncluded(newTaxes);
      if (beforeInc.length !== afterInc.length || beforeInc.some((x, i) => x !== afterInc[i])) {
        throw new NotPorted("action_update_fpos_values with price-included tax adaptation (_get_tax_included_unit_price_from_price)");
      }
    }
    // Recompute price_unit (for zero-price lines), tax_ids (for invoice_line_ids), account_id (for line_ids)
    for (const lineId of recomputePriceUnit) {
      const val = await recordCompute("account.move.line", "price_unit")!(env, new DbRec(env, lineDef, lineId));
      const digits = lineDef.fields.get("price_unit")!.digits;
      const n = plainNumber(val);
      await updateRow(env, "account_move_line", lineId, { price_unit: digits ? floatRound(n, digits[1]) : n });
    }
    for (const l of invoiceLines) {
      const val = await recordCompute("account.move.line", "tax_ids")!(env, new DbRec(env, lineDef, l.id));
      const after = ((val as unknown[] | null) ?? []).map((t) => (typeof t === "number" ? t : Number((t as { origin?: number }).origin ?? t)));
      await env.cr.query("DELETE FROM account_move_line_account_tax_rel WHERE account_move_line_id = $1 AND NOT (account_tax_id = ANY($2::int[]))", [l.id, after]);
      for (const t of after) await env.cr.query("INSERT INTO account_move_line_account_tax_rel (account_move_line_id, account_tax_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [l.id, t]);
    }
    for (const l of invoiceLines) {
      if (l.display_type === "line_section" || l.display_type === "line_note" || l.display_type === "line_subsection") continue;
      const acc = await recordCompute("account.move.line", "account_id")!(env, new DbRec(env, lineDef, l.id));
      if (typeof acc === "number" && acc) await updateRow(env, "account_move_line", l.id, { account_id: acc });
    }
    for (const l of invoiceLines) {
      if (l.display_type !== "product") continue;
      const totals = await lineTotals(env, new DbRec(env, lineDef, l.id));
      await updateRow(env, "account_move_line", l.id, { price_subtotal: plainNumber(totals.subtotal), price_total: plainNumber(totals.total) });
    }
    await syncInvoice(env, moveId, { resync: true });
  }
  await checkBalanced(env, moveIds);
  const { closeTrackingScope } = await import("../mail/write_hooks");
  await closeTrackingScope(env, "account.move");
}
