/**
 * Python behaviour reached by the Invoicing menus of the target map (account.move, account.journal, account.payment,
 * payment.provider, res.partner.bank, ...; odoo/addons/account*, payment). Rows in worker/COMPUTED.md.
 */
import { NotPorted } from "../errors";
import { PrivateRecords, PrivateSql } from "../orm/private_hooks";
import { registerMethod } from "../http/methods";
import { isInstalled } from "../http/modules";
import { str2bool } from "../orm/values";
import { and, cond, or } from "../orm/domain";
import { hooksOf, registerHooks } from "../orm/hooks";
import { hasGroup, hasGroups } from "../orm/env";
import { sql, type Sql } from "../orm/sql";
import { registerOverrides, write } from "../orm/write";
import { create, registerComputedX2manyLast } from "../orm/create";
import { DbRec, overlayOf, registerDefaults, registerRecordCompute, type Rec } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { configParam, defineComputes, filteredAccess, formatPosix, getLang, registerDefaultValued, withCompany as withCompanyEnv } from "./tail_util";
import { langNumber } from "../mail/tracking";
import { contextToday } from "./account_computes";
import { pyFloat } from "../orm/values";
import { sanitizeHtml } from "../orm/write_values";
import { availableUoms } from "./sale_computes";
import { companyData, currencyData, extraTaxData, formatAmount, pyFloats, taxData, withTaxEngineLabels } from "./account_taxes";
import { translate } from "./util";
import { pyFloatRepr } from "../http/json";
import { nextByCode } from "./sale_flow";
import { inverseRates } from "./res_currency";
import { accountTaxHelpers, type BaseLine, type BaseLineTaxData } from "./account_tax_engine";
import { roundPrecision } from "./account_tax_engine";
import { fiscalYear } from "./fiscal_year";
import * as priv from "../orm/dispatch_gen";
import { checkBaseLine, lineRecord, loadedOf } from "./account_tax_hooks";

/** account_payment account_move.py:30-35 _compute_authorized_transaction_ids (compute_sudo). */
async function authorizedTransactions(_env: Environment, rec: Rec): Promise<number[]> {
  const out: number[] = [];
  for (const t of await rec.rels("transaction_ids")) if ((await t.get("state")) === "authorized" && t.origin !== null) out.push(t.origin);
  return out;
}
defineComputes("account.move", {
  authorized_transaction_ids: authorizedTransactions,
  // account_payment account_move.py:37-40 _compute_transaction_count
  transaction_count: async (_env, rec) => (await rec.rels("transaction_ids")).length,
  // account_payment account_move.py:42-51 _compute_amount_paid: authorized or done transactions
  amount_paid: async (_env, rec) => {
    let total = 0;
    for (const t of await rec.rels("transaction_ids")) {
      if (["authorized", "done"].includes(String(await t.get("state")))) total += Number((await t.get("amount")) ?? 0);
    }
    return total;
  },
});

defineComputes("account.journal", {
  // account_journal.py:531-534 (False), account_peppol account_journal.py:37-47: Peppol purchase journals of a
  // receiving company that are not self-billing; l10n_pl_edi's extension refuses
  show_fetch_in_einvoices_button: async (env, rec) => {
    if ((env.reg.model("account.journal").modules ?? []).includes("l10n_pl_edi")) throw new NotPorted("show_fetch_in_einvoices_button with l10n_pl_edi");
    if (!(env.reg.model("account.journal").modules ?? []).includes("account_peppol")) return false;
    if (!(await rec.get("is_peppol_journal")) || (await rec.get("type")) !== "purchase" || (await rec.get("is_self_billing"))) return false;
    const company = await rec.rel("company_id");
    return company ? (await company.get("account_peppol_proxy_state")) === "receiver" : false;
  },
});

defineComputes("payment.provider", {
  // payment_provider.py:303-310 _compute_transaction_count: transactions per provider (as the user)
  transaction_count: async (env, rec) => (rec.id === null ? 0 : env.model("payment.transaction").searchCount(cond("provider_id", "in", [rec.id]))),
});

defineComputes("res.partner.bank", {
  // base res_partner_bank.py:177-180 _compute_color
  color: async (_env, rec) => ((await rec.get("allow_out_payment")) ? 10 : 1),
});

// fields_get domains of related fields whose target has a callable domain (fields_relational.py:125-167): the
// related field does not take the target's domain (Odoo answers [] for the method line's default account), and the
// statement line's message_ids (related to its move) has the mail.thread lambda without the o2m model condition
registerHooks("account.payment.method.line", { descriptionDomain: { default_account_id: async () => [] } });
registerHooks("account.bank.statement.line", {
  descriptionDomain: {
    message_ids: async () => [["message_type", "!=", "user_notification"]],
    // rating_mixin.py rating_ids lambda evaluated for the move (Odoo answers res_model account.move)
    rating_ids: async () => [["res_model", "=", "account.move"]],
  },
});

/** `(company or env.companies).mapped('account_fiscal_country_id.code')` joined by commas (countries deduplicated). */
async function fiscalCountryCodes(env: Environment, company: unknown): Promise<string> {
  const companies = typeof company === "number" && company ? [company] : [...await env.companies()];
  const rows = (await env.cr.query<{ id: number; country: number | null; code: string | null }>(
    `SELECT c.id, c.account_fiscal_country_id AS country, co.code FROM res_company c
       LEFT JOIN res_country co ON co.id = c.account_fiscal_country_id WHERE c.id = ANY($1::int[])`, [companies])).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const seen = new Set<number>();
  const codes: string[] = [];
  for (const c of companies) {
    const r = byId.get(c);
    if (!r || r.country === null || seen.has(r.country)) continue;
    seen.add(r.country);
    if (r.code) codes.push(r.code);
  }
  return codes.join(",");
}
defineComputes("account.payment.term", {
  // account_payment_term.py:46-51 _compute_fiscal_country_codes
  fiscal_country_codes: async (env, rec) => fiscalCountryCodes(env, await rec.get("company_id")),
  // account_payment_term.py:90-93 _compute_example_invalid
  example_invalid: async (_env, rec) => (await rec.rels("line_ids")).length === 0,
});

/**
 * sale account_move.py:73-100 `_compute_sale_warning_text` / purchase account_invoice.py:196-214
 * `_compute_purchase_warning_text`: for users of the warning group and the invoice type, the customer's, its
 * parent's and the invoiced products' warnings ("name - message", OrderedSet order).
 */
function invoiceWarning(group: string, moveType: string, partnerField: string, productField: string) {
  return async (env: Environment, rec: Rec): Promise<string> => {
    if (!(await hasGroup(env, group))) return "";
    if ((await rec.get("move_type")) !== moveType) return "";
    const out: string[] = [];
    const add = (line: string): void => { if (!out.includes(line)) out.push(line); };
    const partner = await rec.rel("partner_id");
    if (partner) {
      const msg = await partner.get(partnerField);
      if (msg) add(`${String((await partner.get("name")) || (await partner.get("display_name")))} - ${String(msg)}`);
      const parent = await partner.rel("parent_id");
      const pmsg = parent ? await parent.get(partnerField) : null;
      if (parent && pmsg) add(`${String((await parent.get("name")) || (await parent.get("display_name")))} - ${String(pmsg)}`);
    }
    const seen = new Set<number>();
    for (const line of await rec.rels("invoice_line_ids")) {
      const product = await line.rel("product_id");
      if (!product || product.origin === null || seen.has(product.origin)) continue;
      seen.add(product.origin);
      const msg = await product.get(productField);
      if (msg) add(`${String(await product.get("display_name"))} - ${String(msg)}`);
    }
    return out.join("\n");
  };
}
defineComputes("account.move", {
  sale_warning_text: invoiceWarning("sale.group_warning_sale", "out_invoice", "sale_warn_msg", "sale_line_warn_msg"),
  purchase_warning_text: invoiceWarning("purchase.group_warning_purchase", "in_invoice", "purchase_warn_msg", "purchase_line_warn_msg"),
});

/**
 * account company.py:784-880 lock dates: without any lock date on the company (and no parent company), no date is
 * locked; anything else (user exceptions, branches) is not ported.
 */
async function noLockDates(env: Environment, company: number): Promise<void> {
  const row = (await env.cr.query<{ n: number; parent: number | null }>(
    `SELECT (CASE WHEN fiscalyear_lock_date IS NULL AND tax_lock_date IS NULL AND sale_lock_date IS NULL
                   AND purchase_lock_date IS NULL AND hard_lock_date IS NULL THEN 0 ELSE 1 END) AS n, parent_id AS parent
       FROM res_company WHERE id = $1`, [company])).rows[0];
  if (!row || row.n !== 0 || row.parent !== null) throw new NotPorted("account.move lock date messages with lock dates or a parent company");
}

defineComputes("account.move", {
  // account_move.py:2019-2025 _compute_tax_lock_date_message with :7506-7522 _get_lock_date_message: False when no
  // lock date is violated
  tax_lock_date_message: async (env, rec) => {
    const company0 = await rec.get("company_id");
    const company = typeof company0 === "number" && company0 ? company0 : await env.company();
    const { violatedLockDates, accountingDateAfterLocks, affectsTaxReport, formatLockDates, formatDate } = await import("./account_locks");
    const anyLock = (await env.cr.query(
      `SELECT 1 FROM res_company c JOIN res_company p ON ('/' || c.parent_path) LIKE ('%/' || p.id || '/%') WHERE c.id = $1
          AND (p.fiscalyear_lock_date IS NOT NULL OR p.tax_lock_date IS NOT NULL OR p.sale_lock_date IS NOT NULL OR p.purchase_lock_date IS NOT NULL OR p.hard_lock_date IS NOT NULL) LIMIT 1`,
      [company])).rows.length;
    if (!anyLock) return false;
    if (rec.origin === null || rec.id === null) throw new NotPorted("account.move.tax_lock_date_message of a move in edition with lock dates (_affect_tax_report)");
    const date = String((await rec.get("date")) || await contextToday(env));
    const journal = await rec.rel("journal_id");
    const jtype = journal ? String(await journal.get("type")) : null;
    const hasTax = await affectsTaxReport(env, rec.origin);
    const locks = await violatedLockDates(env, company, date, hasTax, jtype);
    if (!locks.length) return false;
    const highest = ((await rec.get("highest_name")) || (await lastSequence(env, rec, true))) as string | null;
    const accounting = await accountingDateAfterLocks(SALE_R.includes(await moveType(rec)), date, await contextToday(env), highest || null, highest ? deduceReset(String(highest)) : "never", locks);
    return translate(env, "The date is being set prior to: %(lock_date_info)s. The Journal Entry will be accounted on %(invoice_date)s upon posting.")
      .replace("%(lock_date_info)s", await formatLockDates(env, locks)).replace("%(invoice_date)s", await formatDate(env, accounting));
  },
  // account_move.py:2089-2104 _compute_partner_credit_warning: '' unless a draft customer invoice of a company that
  // uses credit limits (the warning text is not ported)
  partner_credit_warning: async (_env, rec) => {
    if ((await rec.get("state")) !== "draft" || (await rec.get("move_type")) !== "out_invoice") return "";
    const company = await rec.rel("company_id");
    if (!company || !(await company.get("account_use_credit_limit"))) return "";
    throw new NotPorted("account.move.partner_credit_warning with credit limits (_build_credit_warning_message)");
  },
  // account_move.py:867-870 _compute_is_being_sent
  is_being_sent: async (_env, rec) => Boolean(await rec.get("sending_data")),
  // account_move.py:2470-2473 _compute_alerts with :2597-2659 _get_alerts
  alerts: async (env, rec) => {
    // the messages are account's `_()` (translated with account's .po, translate.py:981-989)
    const _ = (source: string): string => translate(env, source, "account");
    const alerts: Record<string, Record<string, unknown>> = {};
    const hasAccountGroup = await hasGroups(env, "account.group_account_readonly,account.group_account_invoice");
    if ((await rec.get("state")) === "draft") {
      const lockMessage = await rec.get("tax_lock_date_message");
      if (hasAccountGroup && lockMessage) alerts["account_tax_lock_date"] = { level: "warning", message: lockMessage };
      const autoPost = await rec.get("auto_post");
      if (autoPost === "at_date") {
        alerts["account_auto_post_at_date"] = { level: "info", message: _("This move is configured to be posted automatically at the accounting date: %s.").replace("%s", String(await rec.get("date"))) };
      }
      if (autoPost === "yearly" || autoPost === "quarterly" || autoPost === "monthly") {
        let message = _("%(auto_post_name)s auto-posting enabled. Next accounting date: %(move_date)s.")
          .replace("%(auto_post_name)s", String(autoPost)).replace("%(move_date)s", String(await rec.get("date")));
        const until = await rec.get("auto_post_until");
        if (until) message += " " + _("The recurrence will end on %s (included).").replace("%s", String(until));
        alerts["account_auto_post_on_period"] = { level: "info", message };
      }
      if (["in_invoice", "in_refund", "in_receipt"].includes(String(await rec.get("move_type")))) {
        const zero: number[] = [];
        for (const line of await rec.rels("invoice_line_ids")) {
          if (Number((await line.get("price_total")) ?? 0) === 0) zero.push(line.origin ?? 0);
        }
        if (zero.length >= 2) {
          if (zero.includes(0)) throw new NotPorted("account.move.alerts with new empty lines");
          alerts["account_remove_empty_lines"] = {
            level: "info", message: _("We've noticed some empty lines on your invoice."), action_text: _("Remove empty lines"),
            action_call: ["account.move.line", "unlink", zero],
          };
        }
      }
    }
    if (await rec.get("is_being_sent")) alerts["account_is_being_sent"] = { level: "info", message: _("This invoice is being sent in the background.") };
    const credit = await rec.get("partner_credit_warning");
    if (hasAccountGroup && credit) alerts["account_partner_credit_warning"] = { level: "warning", message: credit };
    const amountWarning = await rec.get("abnormal_amount_warning");
    if (amountWarning) alerts["account_abnormal_amount_warning"] = { level: "warning", message: amountWarning };
    const dateWarning = await rec.get("abnormal_date_warning");
    if (dateWarning) alerts["account_abnormal_date_warning"] = { level: "warning", message: dateWarning };
    // fields_misc.py Json: an empty dict is stored and read as False
    return Object.keys(alerts).length ? alerts : false;
  },
});

// account_move.py:7288-7330 move type helpers (get_sale_types / get_purchase_types / get_inbound_types)
const SALE = ["out_invoice", "out_refund"], SALE_R = [...SALE, "out_receipt"];
const PURCHASE = ["in_invoice", "in_refund"], PURCHASE_R = [...PURCHASE, "in_receipt"];
const INBOUND_R = ["out_invoice", "in_refund", "out_receipt"];
const moveType = async (rec: Rec): Promise<string> => String(await rec.get("move_type"));

/** account_move.py:2499-2531 _compute_reconciled_payment_ids: payments reconciled through receivable/payable lines. */
async function reconciledPayments(env: Environment, rec: Rec): Promise<number[]> {
  let linked: number[] = [];
  if (rec.id !== null) {
    const row = (await env.cr.query<{ ids: number[] | null }>(
      `SELECT ARRAY_AGG(DISTINCT payment.id) AS ids
         FROM account_payment payment
         JOIN account_move move ON move.id = payment.move_id
         JOIN account_move_line line ON line.move_id = move.id
         JOIN account_partial_reconcile part ON part.debit_move_id = line.id OR part.credit_move_id = line.id
         JOIN account_move_line counterpart_line ON part.debit_move_id = counterpart_line.id OR part.credit_move_id = counterpart_line.id
         JOIN account_move invoice ON invoice.id = counterpart_line.move_id
         JOIN account_account account ON account.id = line.account_id
        WHERE account.account_type IN ('asset_receivable', 'liability_payable')
          AND invoice.id = $1 AND line.id != counterpart_line.id
        GROUP BY invoice.id, invoice.move_type`, [rec.id])).rows[0];
    linked = row?.ids ?? [];
    if (linked.length) {
      const allowed = await filteredAccess(env, "account.payment", linked, "read");
      linked = linked.filter((id) => allowed.has(id));
    }
  }
  const matched = (await rec.rels("matched_payment_ids")).map((p) => p.origin).filter((id): id is number => id !== null);
  return [...new Set([...linked, ...matched])];
}

defineComputes("account.move", {
  reconciled_payment_ids: reconciledPayments,
  // account_move.py:1385-1388
  payment_count: async (env, rec) => (await reconciledPayments(env.sudo(), rec)).length,
  // account_move.py:1490-1493
  reversal_move_count: async (_env, rec) => (await rec.rels("reversal_move_ids")).length,
  // account_move.py:2541-2550 _compute_no_followup: an invoice's first receivable or payable line's flag (line_ids
  // in account.move.line's order: one date and name per move, so by id), True without one and for other moves
  no_followup: async (_env, rec) => {
    if (![...SALE, ...PURCHASE].includes(await moveType(rec))) return true;
    for (const line of await rec.rels("line_ids")) {
      const account = await line.rel("account_id");
      const type = account ? await account.get("account_type") : null;
      if (type === "asset_receivable" || type === "liability_payable") return Boolean(await line.get("no_followup"));
    }
    return true;
  },
  // account_move.py:2011-2017
  bank_partner_id: async (_env, rec) => {
    if (INBOUND_R.includes(await moveType(rec))) {
      const company = await rec.rel("company_id");
      return company ? (await company.get("partner_id")) || null : null;
    }
    return (await rec.get("commercial_partner_id")) || null;
  },
  // account_move.py:2314-2320
  display_qr_code: async (_env, rec) => {
    if (!["out_invoice", "out_receipt", "in_invoice", "in_receipt"].includes(await moveType(rec))) return false;
    const company = await rec.rel("company_id");
    return company ? Boolean(await company.get("qr_code")) : false;
  },
  // account_move.py:2489-2492, account_peppol account_move.py:85-90 (self-billing export refuses)
  display_send_button: async (_env, rec) => {
    const type = await moveType(rec), state = await rec.get("state");
    if (state === "posted" && PURCHASE.includes(type)) {
      const journal = await rec.rel("journal_id");
      if (journal && (await journal.get("is_self_billing"))) throw new NotPorted("display_send_button of a self-billing bill (_is_exportable_as_self_invoice)");
    }
    return SALE.includes(type) && state === "posted";
  },
  // account_move.py:2341-2353 _compute_linked_attachment_id('invoice_pdf_report_id', 'invoice_pdf_report_file')
  invoice_pdf_report_id: async (env, rec) => {
    const id = rec.id ?? rec.origin;
    if (id === null) return null;
    const found = await env.model("ir.attachment").search(and([
      cond("res_model", "=", "account.move"), cond("res_id", "in", [id]), cond("res_field", "=", "invoice_pdf_report_file")]));
    return found.length ? found[found.length - 1]! : null;
  },
  // account_edi_ubl_cii account_move.py:26-31 the same helper for ('ubl_cii_xml_id', 'ubl_cii_xml_file')
  ubl_cii_xml_id: async (env, rec) => {
    const id = rec.id ?? rec.origin;
    if (id === null) return null;
    const found = await env.model("ir.attachment").search(and([
      cond("res_model", "=", "account.move"), cond("res_id", "in", [id]), cond("res_field", "=", "ubl_cii_xml_file")]));
    return found.length ? found[found.length - 1]! : null;
  },
  // account_move.py:2494-2497
  highlight_send_button: async (_env, rec) => !(await rec.get("is_being_sent")) && !(await rec.get("invoice_pdf_report_id")),
  // account_move.py:2006-2009 with :7275-7282
  invoice_filter_type_domain: async (_env, rec) => {
    const type = await moveType(rec);
    return SALE_R.includes(type) ? "sale" : PURCHASE_R.includes(type) ? "purchase" : false;
  },
  // account_move.py:2358-2361
  invoice_incoterm_placeholder: async (env, rec) => {
    const company = await rec.rel("company_id");
    const incoterm = company ? await company.rel("incoterm_id") : null;
    if (incoterm) return incoterm.get("display_name");
    return translate(env, "Define a default in the settings", "account");
  },
  // account_move.py:1133-1136
  show_delivery_date: async (_env, rec) => Boolean(await rec.get("delivery_date")) && SALE.includes(await moveType(rec)),
  // account_move.py:1990-1993, purchase account_invoice.py:216-222
  show_invoice_vendor_bill: async (env, rec) => (await rec.get("state")) === "draft" && PURCHASE.includes(await moveType(rec))
    && !(await hasGroup(env, "purchase.group_purchase_user")),
  // account_move.py:1141-1147
  show_taxable_supply_date: async () => false,
  taxable_supply_date_placeholder: async () => "",
  // account_move.py:924-929
  hide_post_button: async (env, rec) => {
    if ((await rec.get("state")) !== "draft") return true;
    const date = await rec.get("date");
    return (await rec.get("auto_post")) !== "no" && Boolean(date) && String(date) > await contextToday(env);
  },
  // account_move.py:2154-2165
  quick_edit_mode: async (_env, rec) => {
    const company = await rec.rel("company_id");
    if (!company || !(await company.get("quick_edit_mode_enabled"))) return false;
    const mode = await company.get("quick_edit_mode");
    const journal = await rec.rel("journal_id");
    const jtype = journal ? await journal.get("type") : null;
    if (jtype === "sale") return mode === "out_invoices" || mode === "out_and_in_invoices";
    if (jtype === "purchase") return mode === "in_invoices" || mode === "out_and_in_invoices";
    return false;
  },
  // account_move.py:1482-1488
  show_journal: async (_env, rec) => {
    const suitable = (await rec.get("suitable_journal_ids")) as number[] | null ?? [];
    const journal = await rec.get("journal_id");
    // account_move.py:1482-1488: on a new record the lines of suitable_journal_ids are new records too, so `journal_id` is never `in` them
    if (rec.id === null && rec.origin === null) return suitable.length > 1 || Boolean(journal);
    return suitable.length > 1 || (Boolean(journal) && !suitable.includes(Number(journal)));
  },
  // account_move.py:2051-2057; account_peppol :124-128 (sent Peppol sale documents); account_edi :113-119 (EDI
  // documents refuse)
  show_reset_to_draft_button: async (env, rec) => {
    const modules = env.reg.model("account.move").modules ?? [];
    if (modules.includes("account_edi") && (await rec.rels("edi_document_ids")).length) throw new NotPorted("show_reset_to_draft_button with EDI documents");
    const state = await rec.get("state");
    let show = !(await rec.get("inalterable_hash")) && (state === "cancel" || (state === "posted" && !(await rec.get("need_cancel_request"))));
    if (show && modules.includes("account_peppol") && (await rec.get("peppol_is_sent")) && SALE_R.includes(await moveType(rec))) show = false;
    return show;
  },
  // account_move.py:2046-2049 with account_move_line.py:3730-3735 _reconciled_lines
  has_reconciled_entries: async (_env, rec) => {
    const ids: number[] = [];
    for (const line of await rec.rels("line_ids")) {
      if (!(await line.get("reconciled"))) continue;
      if (Number((await line.get("credit")) ?? 0) > 0) {
        for (const r of await line.rels("matched_debit_ids")) ids.push(Number(await r.get("debit_move_id")));
      } else {
        for (const r of await line.rels("matched_credit_ids")) ids.push(Number(await r.get("credit_move_id")));
      }
      ids.push(line.origin ?? 0);
    }
    return ids.length > 1;
  },
});

/** purchase account_invoice.py:164-171 _compute_is_purchase_matched over the product lines. */
async function purchaseMatch(rec: Rec): Promise<{ total: number; matched: number }> {
  let total = 0, matched = 0;
  for (const line of await rec.rels("invoice_line_ids")) {
    if ((await line.get("display_type")) !== "product") continue;
    total++;
    if (await line.get("purchase_line_id")) matched++;
  }
  return { total, matched };
}
/** `move.invoice_line_ids.purchase_line_id.order_id` (purchase account_invoice.py:183-194), in line order. */
async function invoicePurchaseOrders(rec: Rec): Promise<Rec[]> {
  const out: Rec[] = [];
  const seen = new Set<number>();
  for (const line of await rec.rels("invoice_line_ids")) {
    const pol = await line.rel("purchase_line_id");
    const order = pol ? await pol.rel("order_id") : null;
    if (order && order.origin !== null && !seen.has(order.origin)) { seen.add(order.origin); out.push(order); }
  }
  return out;
}
defineComputes("account.move", {
  purchase_matched_ratio: async (_env, rec) => { const m = await purchaseMatch(rec); return m.total ? 100.0 * m.matched / m.total : 0.0; },
  is_purchase_matched: async (_env, rec) => { const m = await purchaseMatch(rec); return m.matched === m.total && m.total > 0; },
  purchase_order_count: async (_env, rec) => (await invoicePurchaseOrders(rec)).length,
  // purchase_order_id of the lines is related to purchase_line_id.order_id
  purchase_order_name: async (_env, rec) => {
    const orders = await invoicePurchaseOrders(rec);
    return orders.length === 1 ? orders[0]!.get("display_name") : false;
  },
});

defineComputes("account.move", {
  // sale account_move.py:58-61 _compute_origin_so_count: the orders of the lines' sale lines (compute_sudo)
  sale_order_count: async (_env, rec) => {
    const orders = new Set<number>();
    for (const line of await rec.rels("line_ids")) {
      for (const sol of await line.rels("sale_line_ids")) {
        const order = await sol.get("order_id");
        if (typeof order === "number") orders.add(order);
      }
    }
    return orders.size;
  },
  // sale account_move.py:63-73 _compute_service_line_count: analytic lines reinvoiced on the move (sale_timesheet
  // account_move.py:95-97 leaves the timesheets out); compute_sudo
  service_line_count: async (env, rec) => {
    if (rec.id === null) return 0;
    let domain = cond("reinvoice_move_id", "in", [rec.id]);
    if ((env.reg.model("account.move").modules ?? []).includes("sale_timesheet")) domain = and([domain, cond("project_id", "=", false)]);
    return env.sudo().model("account.analytic.line").searchCount(domain);
  },
});

defineComputes("account.journal", {
  // account_journal.py:581-597 _compute_name_placeholder
  name_placeholder: async (env, rec) => {
    if (env.lang && env.lang !== "en_US") throw new NotPorted("account.journal.name_placeholder outside en_US");
    const names: Record<string, string> = {
      sale: "Customer Invoices", purchase: "Vendor Bills", cash: "Cash", bank: "Bank", credit: "Credit Card", general: "Miscellaneous Operations",
    };
    const type = await rec.get("type");
    if (!type) return "Select a type";
    const code = await rec.get("code");
    const m = /[0-9]+$/.exec(typeof code === "string" ? code : "");
    return `${names[String(type)]} (${m ? m[0] : "1"})`;
  },
});
registerRecordCompute("account.journal", {
  // account_journal.py:510-520 _compute_suspense_account_id (stored): bank, cash and credit journals keep theirs or
  // take the company's suspense account
  suspense_account_id: async (_env, rec) => {
    if (!["bank", "cash", "credit"].includes(String(await rec.get("type")))) return null;
    const current = await rec.prev("suspense_account_id");
    if (current) return current;
    const company = await rec.rel("company_id");
    return company ? (await company.get("account_journal_suspense_account_id")) || null : null;
  },
});
registerRecordCompute("account.tax", {
  // account_tax.py:274-277 _compute_country_id (stored): the company's fiscal country, else its country, else unchanged
  country_id: async (_env, rec) => {
    const company = await rec.rel("company_id");
    const fromCompany = company ? (await company.get("account_fiscal_country_id")) || (await company.get("country_id")) : null;
    return fromCompany || (await rec.prev("country_id")) || null;
  },
  // account_tax.py:318-321 _compute_is_domestic (stored)
  is_domestic: async (_env, rec) => {
    const fps = (await rec.rels("fiscal_position_ids")).map((r) => r.origin);
    if (fps.length === 0) return true;
    const company = await rec.rel("company_id");
    const domestic = company ? await company.get("domestic_fiscal_position_id") : null;
    return typeof domestic === "number" && fps.includes(domestic);
  },
});
registerRecordCompute("res.company", {
  // account company.py:436-446 _compute_domestic_fiscal_position_id (stored): the company's fiscal positions for its
  // country (or for one of its country groups without a country), by sequence then country
  domestic_fiscal_position_id: async (_env, rec) => {
    const country = (await rec.get("country_id")) || false;
    const countryRec = await rec.rel("country_id");
    const groups = countryRec ? ((await countryRec.get("country_group_ids")) as number[] | null ?? []) : [];
    const candidates: { id: number; seq: number; country: number; pos: number }[] = [];
    let pos = 0;
    for (const fp of await rec.rels("fiscal_position_ids")) {
      const fpCountry = (await fp.get("country_id")) || false;
      const group = await fp.get("country_group_id");
      const ok = fpCountry === country || (!fpCountry && typeof group === "number" && groups.includes(group));
      if (ok && fp.origin !== null) {
        candidates.push({ id: fp.origin, seq: Number((await fp.get("sequence")) ?? 0), country: typeof fpCountry === "number" ? fpCountry : Infinity, pos: pos++ });
      }
    }
    candidates.sort((a, b) => a.country - b.country || a.pos - b.pos);
    candidates.forEach((c, i) => { c.pos = i; });
    candidates.sort((a, b) => a.seq - b.seq || a.pos - b.pos);
    return candidates[0]?.id ?? null;
  },
});

/** account_payment.py:742-800: the customer invoices of payments (their invoice_ids and the reconciled ones). */
async function paymentsReconciledInvoices(env: Environment, paymentIds: number[]): Promise<number[]> {
  if (paymentIds.length === 0) return [];
  const out = new Set<number>();
  const fromM2m = (await env.cr.query<{ id: number }>(
    `SELECT m.id FROM account_move m JOIN account_move__account_payment rel ON rel.invoice_id = m.id
      WHERE rel.payment_id = ANY($1::int[]) AND m.move_type = ANY($2::text[])`, [paymentIds, SALE_R])).rows;
  for (const r of fromM2m) out.add(r.id);
  const rows = (await env.cr.query<{ ids: number[] }>(
    `SELECT ARRAY_AGG(DISTINCT invoice.id) AS ids
       FROM account_payment payment
       JOIN account_move move ON move.id = payment.move_id
       JOIN account_move_line line ON line.move_id = move.id
       JOIN account_partial_reconcile part ON part.debit_move_id = line.id OR part.credit_move_id = line.id
       JOIN account_move_line counterpart_line ON part.debit_move_id = counterpart_line.id OR part.credit_move_id = counterpart_line.id
       JOIN account_move invoice ON invoice.id = counterpart_line.move_id
       JOIN account_account account ON account.id = line.account_id
      WHERE account.account_type IN ('asset_receivable', 'liability_payable')
        AND payment.id = ANY($1::int[]) AND line.id != counterpart_line.id
        AND invoice.move_type = ANY($2::text[])
      GROUP BY payment.id, invoice.move_type`, [paymentIds, SALE_R])).rows;
  for (const r of rows) for (const id of r.ids ?? []) out.add(id);
  return [...out];
}
registerHooks("account.move", {
  search: {
    // account_move.py:2665-2669 _search_reconciled_payment_ids: `in` / `=` only
    reconciled_payment_ids: async (env, operator, value) => {
      if (operator !== "in" && operator !== "=") return null;
      const ids = (Array.isArray(value) ? value : [value]).filter((v): v is number => typeof v === "number");
      return cond("id", "in", await paymentsReconciledInvoices(env, ids));
    },
  },
});

defineComputes("account.payment", {
  // account_payment account_payment.py:50-70 _compute_amount_available_for_refund
  amount_available_for_refund: async (env, rec) => {
    const tx = await rec.rel("payment_transaction_id");
    if (!tx) return 0;
    const su = env.sudo();
    const txs = new DbRec(su, su.reg.model("payment.transaction"), tx.origin!);
    const method = await txs.rel("payment_method_id");
    const primary = method ? await method.rel("primary_payment_method_id") : null;
    const pm = primary ?? method;
    const provider = await txs.rel("provider_id");
    if (!provider || (await provider.get("support_refund")) === "none" || !pm || (await pm.get("support_refund")) === "none"
      || (await txs.get("operation")) === "refund") return 0;
    const refunds = rec.origin === null ? [] : await env.model("account.payment").search(cond("source_payment_id", "=", rec.origin));
    let refunded = 0;
    for (const id of refunds) refunded += Number((await new DbRec(env, env.reg.model("account.payment"), id).get("amount")) ?? 0);
    return Number((await rec.get("amount")) ?? 0) - Math.abs(refunded);
  },
});
defineComputes("account.payment", {
  // account_payment account_payment.py:95-106 _compute_refunds_count: refund payments of a source (`payment.id` of a
  // record in edition is a NewId: 0)
  refunds_count: async (env, rec) => {
    if (rec.id === null) return 0;
    return (await env.cr.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM account_payment p JOIN payment_transaction t ON t.id = p.payment_transaction_id
        WHERE p.source_payment_id = $1 AND t.operation = 'refund'`, [rec.id])).rows[0]?.n ?? 0;
  },
});
registerDefaultValued("account.move", "show_name_warning");

// payment.provider's feature support fields: src/models/inventory_flow.ts (registered once: a site's compiled override
// of `_compute_feature_support_fields` replaces that registration, src/orm/keys.ts replaceKey)
defineComputes("payment.provider", {
  // payment_provider.py:274-301 _compute_processed_amount: done transactions (no children, or refunds of a source),
  // per currency, converted to the provider's main currency (a conversion between currencies refuses)
  processed_amount: async (env, rec) => {
    if (rec.id === null) return 0;
    const ids = await env.model("payment.transaction").search(and([
      cond("provider_id", "in", [rec.id]), cond("state", "=", "done"),
      or([cond("child_transaction_ids", "=", false), cond("source_transaction_id", "!=", false)]),
    ]));
    if (ids.length === 0) return 0;
    const main = await rec.get("main_currency_id");
    const rows = (await env.cr.query<{ currency_id: number | null; total: string | null }>(
      "SELECT currency_id, sum(amount)::text AS total FROM payment_transaction WHERE id = ANY($1::int[]) GROUP BY currency_id ORDER BY currency_id", [ids])).rows;
    let total = 0;
    for (const r of rows) {
      if (r.currency_id !== main) throw new NotPorted("payment.provider.processed_amount across currencies (res.currency._convert)");
      // res_currency.py:356-375 _convert: rate 1, then to_currency.round
      total += Number(r.total ?? 0) ? roundPrecision(Number(r.total), (await currencyData(env, Number(main))).rounding) : 0;
    }
    return total;
  },
});

/**
 * account_move.py:1160-1162 `_get_invoice_currency_rate_date` through the private hook (l10n_hu_edi: the delivery date
 * of a Hungarian move): account's `invoice_date or context_today` as the hand. `rec` may be new.
 */
export async function invoiceRateDate(env: Environment, rec: Rec): Promise<string> {
  const id = typeof rec.id === "number" ? rec.id : null;
  const v = await priv.account_move._get_invoice_currency_rate_date.call(env, id === null ? [] : [id], [],
    async () => String((await rec.get("invoice_date")) || await contextToday(env)), undefined, id === null ? [rec] : undefined);
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new NotPorted(`_get_invoice_currency_rate_date giving ${JSON.stringify(v)}`);
  return v;
}

defineComputes("account.move", {
  // account_move.py:1976-1988 _compute_need_cancel_request: the hook is False without an EDI localization override
  need_cancel_request: async (env) => {
    const mods = env.reg.model("account.move").modules ?? [];
    for (const m of ["l10n_my_edi", "l10n_tw_edi_ecpay", "l10n_hu_edi", "l10n_es_edi_sii"]) if (mods.includes(m)) throw new NotPorted(`need_cancel_request with ${m}`);
    return false;
  },
  // account_move.py:1173-1179 _compute_expected_currency_rate with :1160-1171 and res_currency.py:345-355 `_get_conversion_rate`
  expected_currency_rate: async (env, rec) => {
    const currency = await rec.get("currency_id");
    if (!currency) return 1;
    const companyCurrency = await rec.get("company_currency_id");
    if (currency === companyCurrency) return 1;
    const date = await invoiceRateDate(env, rec);
    const cenv = env.withContext({ ...env.context, to_currency: Number(currency), date });
    return (await inverseRates(cenv, [Number(companyCurrency)])).get(Number(companyCurrency)) ?? 1;
  },
});

/** account_move.py:1495-1554 _compute_payments_widget_to_reconcile_info (same currency only). */
async function outstandingWidget(env: Environment, rec: Rec): Promise<unknown> {
  const state = await rec.get("state"), payState = await rec.get("payment_state"), type = await moveType(rec);
  if (!(state === "draft" || state === "posted") || !(payState === "not_paid" || payState === "partial") || ![...SALE_R, ...PURCHASE_R].includes(type)) return false;
  const accounts: number[] = [];
  for (const line of await rec.rels("line_ids")) {
    const acc = await line.rel("account_id");
    if (acc && ["asset_receivable", "liability_payable"].includes(String(await acc.get("account_type"))) && acc.origin !== null && !accounts.includes(acc.origin)) accounts.push(acc.origin);
  }
  const company = Number(await rec.get("company_id"));
  const inbound = INBOUND_R.includes(type);
  const ids = await env.model("account.move.line").search(and([
    cond("account_id", "in", accounts), cond("parent_state", "=", "posted"),
    or([cond("company_id", "in", [company, false]), cond("company_id", "child_of", company)]),
    cond("partner_id", "=", (await rec.get("commercial_partner_id")) || false), cond("reconciled", "=", false),
    cond("balance", inbound ? "<" : ">", 0.0),
    or([cond("amount_residual", "!=", 0.0), cond("amount_residual_currency", "!=", 0.0)]),
  ]));
  const currency = await rec.get("currency_id");
  const cur = await currencyData(env, Number(currency));
  const content: Record<string, unknown>[] = [];
  for (const id of ids) {
    const line = new DbRec(env, env.reg.model("account.move.line"), id);
    if ((await line.get("currency_id")) !== currency) throw new NotPorted("outstanding credits in another currency (res.currency._convert)");
    const amount = Math.abs(Number((await line.get("amount_residual_currency")) ?? 0));
    if (Math.abs(roundPrecision(amount, cur.rounding)) < cur.rounding) continue; // currency.is_zero
    const move = await line.rel("move_id");
    content.push({
      move_name: move ? await move.get("name") : false, amount: pyFloat(amount), currency_id: currency, id,
      move_id: move?.origin ?? false, date: await line.get("date"), account_payment_id: (await line.get("payment_id")) || false,
      ref: (await line.get("ref")) || "",
    });
  }
  if (!content.length) return false;
  if (env.lang && env.lang !== "en_US") throw new NotPorted("outstanding widget title outside en_US");
  return { outstanding: true, content, move_id: rec.origin ?? false, title: inbound ? "Outstanding credits" : "Outstanding debits" };
}
interface PartialRow { partial_id: number; aml_id: number; aml_move_id: number; is_exchange: string; exchange_move_id: number | null; part_amount: string; part_amount_currency: string; part_currency_id: number; part_company_currency_id: number }
/**
 * account_move.py:5528-5718 `_get_all_reconciled_invoice_partials` of the receivable/payable lines: the partials, and
 * the exchange difference lines reconciled with their counterparts. Partials of tax lines (cash basis) refuse.
 */
async function reconciledPartials(env: Environment, moveId: number): Promise<(PartialRow & { exchange: boolean; amount: number; currency: number })[]> {
  const taxed = (await env.cr.query(
    `SELECT 1 FROM account_move_line l JOIN account_partial_reconcile p ON p.debit_move_id = l.id OR p.credit_move_id = l.id
      WHERE l.move_id = $1 AND l.tax_repartition_line_id IS NOT NULL LIMIT 1`, [moveId])).rows.length;
  if (taxed) throw new NotPorted("reconciled partials of tax lines (cash basis entries)");
  const lines = `SELECT l.id FROM account_move_line l JOIN account_account a ON a.id = l.account_id WHERE l.move_id = $1 AND a.account_type IN ('asset_receivable', 'liability_payable')`;
  const rows = (await env.cr.query<PartialRow>(
    `SELECT part.id AS partial_id, cl.id AS aml_id, cl.move_id AS aml_move_id, 'undefined' AS is_exchange, part.exchange_move_id, part.amount::text AS part_amount,
            part.debit_amount_currency::text AS part_amount_currency, part.debit_currency_id AS part_currency_id, cl.company_currency_id AS part_company_currency_id
       FROM account_partial_reconcile part JOIN account_move_line cl ON cl.id = part.credit_move_id WHERE part.debit_move_id IN (${lines})
     UNION ALL
     SELECT part.id, cl.id, cl.move_id, 'undefined', part.exchange_move_id, part.amount::text, part.credit_amount_currency::text, part.credit_currency_id, cl.company_currency_id
       FROM account_partial_reconcile part JOIN account_move_line cl ON cl.id = part.debit_move_id WHERE part.credit_move_id IN (${lines})
     UNION ALL
     SELECT part2.id, el.id, el.move_id, 'true', NULL, part2.amount::text, part2.debit_amount_currency::text, part2.debit_currency_id, cl.company_currency_id
       FROM account_partial_reconcile part JOIN account_move_line cl ON cl.id = part.credit_move_id
       JOIN account_partial_reconcile part2 ON part2.credit_move_id = cl.id
       JOIN account_move_line el ON el.id = part2.debit_move_id AND el.move_id = part.exchange_move_id
      WHERE part.debit_move_id IN (${lines}) AND part.exchange_move_id IS NOT NULL
     UNION ALL
     SELECT part2.id, el.id, el.move_id, 'true', NULL, part2.amount::text, part2.credit_amount_currency::text, part2.credit_currency_id, cl.company_currency_id
       FROM account_partial_reconcile part JOIN account_move_line cl ON cl.id = part.debit_move_id
       JOIN account_partial_reconcile part2 ON part2.debit_move_id = cl.id
       JOIN account_move_line el ON el.id = part2.credit_move_id AND el.move_id = part.exchange_move_id
      WHERE part.credit_move_id IN (${lines}) AND part.exchange_move_id IS NOT NULL`, [moveId])).rows;
  const exchangeMoves = new Set(rows.map((r) => r.exchange_move_id).filter((m): m is number => m !== null));
  return rows.map((r) => {
    const exchange = r.is_exchange === "true" || (r.is_exchange === "undefined" && exchangeMoves.has(r.aml_move_id));
    return { ...r, exchange, amount: Number(exchange ? r.part_amount : r.part_amount_currency), currency: exchange ? r.part_company_currency_id : r.part_currency_id };
  });
}

defineComputes("account.move", {
  // account_peppol account_move.py:119-122
  peppol_is_sent: async (_env, rec) => {
    const st = await rec.get("peppol_move_state");
    return !(st === false || st === null || ["ready", "to_send", "error", "skipped"].includes(String(st)));
  },
  invoice_outstanding_credits_debits_widget: outstandingWidget,
  // account_move.py:1556-1559
  invoice_has_outstanding: async (env, rec) => Boolean(await outstandingWidget(env, rec)),
  // account_move.py:1569-1658 _compute_payments_widget_reconciled_info with `_prepare_payments_widget_reconciled_info`
  invoice_payments_widget: async (env, rec) => {
    const state = await rec.get("state");
    if (!(state === "draft" || state === "posted") || ![...SALE_R, ...PURCHASE_R].includes(await moveType(rec))) return false;
    if (rec.origin === null) return false;
    const partials = await reconciledPartials(env, rec.origin);
    if (!partials.length) return false;
    const companyId = Number(await rec.get("company_id"));
    const companyCurrency = Number(await rec.get("company_currency_id"));
    const content: Record<string, unknown>[] = [];
    const exchangeLines: number[] = [];
    let exchangeAmount = 0.0;
    for (const p of partials) {
      const su = env.sudo();
      const line = new DbRec(su, su.reg.model("account.move.line"), p.aml_id);
      if (p.exchange) {
        exchangeLines.push(p.aml_id);
        exchangeAmount += Number(await line.get("balance"));
        continue;
      }
      // account_move.py:1570-1614 _prepare_payments_widget_reconciled_info(partial_info): through callPrivate, so that a
      // module's compiled override (point_of_sale, l10n_account_withholding_tax) adds its keys (private_hooks.json)
      const partialInfo = { aml: new PrivateRecords("account.move.line", [p.aml_id]), amount: pyFloat(p.amount),
        currency: new PrivateRecords("res.currency", [p.currency]), partial_id: p.partial_id, is_exchange: false };
      content.push(await priv.account_move._prepare_payments_widget_reconciled_info.call(env, [rec.origin], [partialInfo],
        async () => {
      const move = (await line.rel("move_id"))!;
      const journal = await line.rel("journal_id");
      const payment = await line.rel("payment_id");
      const method = payment ? await payment.rel("payment_method_line_id") : null;
      const moveName = await move.get("name"), moveRef = await move.get("ref");
      const jc = journal ? await journal.get("company_id") : null;
      const lineCompany = await line.rel("company_id");
      const foreign = (await line.get("amount_currency")) && (await line.get("currency_id")) !== (lineCompany ? await lineCompany.get("currency_id") : null)
        ? Number(await line.get("currency_id")) : null;
      const amountType = String(await move.get("move_type"));
      return {
        name: (await line.get("name")) || false, journal_name: journal ? await journal.get("name") : false,
        company_name: jc !== companyId && journal ? (await (await journal.rel("company_id"))?.get("name")) ?? false : false,
        amount: pyFloat(p.amount), currency_id: p.currency, date: await line.get("date"), partial_id: p.partial_id,
        account_payment_id: payment?.origin ?? false, payment_method_name: method ? await method.get("name") : false,
        move_id: move.origin, is_refund: amountType === "in_refund" || amountType === "out_refund",
        ref: moveRef ? `${String(moveName)} (${String(moveRef)})` : moveName, is_exchange: false,
        amount_company_currency: await formatAmount(env, Math.abs(Number(await line.get("balance"))), companyCurrency),
        amount_foreign_currency: foreign ? await formatAmount(env, Math.abs(Number(await line.get("amount_currency"))), foreign) : null,
      };
        }) as Record<string, unknown>);
    }
    if (!content.length) return false;
    const cmp = Math.abs(roundPrecision(exchangeAmount, (await currencyData(env, companyCurrency)).rounding)) < (await currencyData(env, companyCurrency)).rounding ? 0 : exchangeAmount > 0 ? 1 : -1;
    const label = cmp === 0 ? (exchangeLines.length ? translate(env, "See exchange information") : "") : cmp > 0 ? translate(env, "Exchange Profit") : translate(env, "Exchange Loss");
    return {
      title: translate(env, "Less Payment"), outstanding: false,
      content: content.map((c, i) => [c, i] as const).sort((a, b) => String(a[0]["date"]).localeCompare(String(b[0]["date"])) || a[1] - b[1]).map(([c]) => c),
      exchange_info: { line_ids: exchangeLines, exchange_amount: pyFloat(exchangeAmount), label, exchange_amount_formatted: await formatAmount(env, Math.abs(exchangeAmount), companyCurrency) },
    };
  },
});

defineComputes("account.move", {
  // account_move.py:2027-2030 _compute_display_inactive_currency_warning (active_test=False)
  display_inactive_currency_warning: async (env, rec) => {
    if ((await rec.get("state")) !== "draft") return false;
    const currency = await rec.get("currency_id");
    if (!currency) return false;
    const row = (await env.cr.query<{ active: boolean }>("SELECT active FROM res_currency WHERE id = $1", [currency])).rows[0];
    return row ? !row.active : false;
  },
  // account_move.py:2032-2039 _compute_tax_country_id: the foreign-VAT fiscal position's country, else the company's
  // fiscal country
  tax_country_id: async (_env, rec) => {
    const fp = await rec.rel("fiscal_position_id");
    if (fp && (await fp.get("foreign_vat"))) return (await fp.get("country_id")) || null;
    const company = await rec.rel("company_id");
    return company ? (await company.get("account_fiscal_country_id")) || null : null;
  },
  // account_move.py:2167-2170 with :4572-4583 _get_quick_edit_suggestions: False outside quick edit or without a total
  quick_encoding_vals: async (_env, rec) => {
    if (!(await rec.get("quick_edit_mode")) || !(await rec.get("quick_edit_total_amount"))) return false;
    throw new NotPorted("account.move.quick_encoding_vals with a quick edit total (_get_frequent_account_and_taxes)");
  },
});
defineComputes("account.move", {
  // account_move.py:2041-2044
  tax_country_code: async (_env, rec) => {
    const c = await rec.rel("tax_country_id");
    return c ? (await c.get("code")) || false : false;
  },
});
// non-stored fields without compute (fields.py:1973-1987): account_move.py:665, :800; purchase account_invoice.py:20-28
// account_move.py:665 `invoice_vendor_bill_id` (store=False): a write only puts the value in the cache (fields.py
// Field.write, the account.move write override of src/models/account_move_create.ts), read back in the same request
registerHooks("account.move", {
  computed: {
    invoice_vendor_bill_id: async (env, ids) => {
      const written = overlayOf(env, "account.move", "invoice_vendor_bill_id");
      const { defaultGet } = await import("../web/defaults");
      const missing = ids.filter((id) => !written?.has(id));
      const values = missing.length ? await defaultGet(env, "account.move", ["invoice_vendor_bill_id"]) : {};
      const fallback = "invoice_vendor_bill_id" in values ? values["invoice_vendor_bill_id"] : null;
      return new Map(ids.map((id) => [id, written?.has(id) ? written.get(id) : fallback]));
    },
  },
});
registerDefaultValued("account.move", "show_update_fpos");
for (const f of ["purchase_id", "purchase_vendor_bill_id"]) registerDefaultValued("account.move", f);

defineComputes("account.move.line", {
  // account_move_line.py:885-888 _compute_same_currency
  is_same_currency: async (_env, rec) => (await rec.get("currency_id")) === (await rec.get("company_currency_id")),
  // account_move_line.py:1121-1141 _compute_sql_residual_at_date without `recon_limit`
  residual_at_date: async (env, rec) => {
    if (env.context["recon_limit"]) throw new NotPorted("residual_at_date with recon_limit");
    return rec.get("amount_residual");
  },
  residual_currency_at_date: async (env, rec) => {
    if (env.context["recon_limit"]) throw new NotPorted("residual_currency_at_date with recon_limit");
    return rec.get("amount_residual_currency");
  },
});
defineComputes("account.move.line", {
  // account_move_line.py:695-713 _compute_label: the product's display name (in the move's partner language) before
  // the description, unless the description starts with it
  label: async (env, rec) => {
    const name = await rec.get("name");
    const product = await rec.get("product_id");
    if (typeof product !== "number" || !product) return name || false;
    const move = await rec.rel("move_id");
    let lang: unknown = false;
    if (move) {
      const partner = await move.rel("partner_id");
      lang = partner ? await partner.get("lang") : false;
      if (!lang) { const cp = await move.rel("commercial_partner_id"); lang = cp ? await cp.get("lang") : false; }
    }
    if ((lang || "en_US") !== (env.lang ?? "en_US")) throw new NotPorted("account.move.line.label in the partner's language");
    const penv = env.withContext({ ...env.context, display_default_code: env.context["display_default_code"] ?? true });
    const display = String((await penv.model("product.product").displayName([product])).get(product) ?? "");
    if (!name) return display;
    const text = String(name);
    if (text.split(/\r\n|\r|\n/)[0] === display) return text;
    return `${display}\n${text}`;
  },
});

defineComputes("account.move.line", {
  // account_move_line.py:1221-1224 with product _get_available_uoms (sale_computes availableUoms)
  allowed_uom_ids: async (env, rec) => availableUoms(env, await rec.rel("product_id")),
  // purchase account_invoice.py:695-699
  purchase_line_warn_msg: async (env, rec) => {
    if (!(await hasGroup(env, "purchase.group_warning_purchase"))) return "";
    const p = await rec.rel("product_id");
    return p ? (await p.get("purchase_line_warn_msg")) || false : false;
  },
  // sale account_move_line.py:23-29
  sale_line_warn_msg: async (env, rec) => {
    if (!(await hasGroup(env, "sale.group_warning_sale"))) return "";
    const p = await rec.rel("product_id");
    return p ? (await p.get("sale_line_warn_msg")) || false : false;
  },
  // account_move_line.py:1563-1586 `_compute_is_refund`
  is_refund: async (_env, rec) => {
    const move = await rec.rel("move_id");
    const type = move ? String(await move.get("move_type")) : "entry";
    if (type === "out_refund" || type === "in_refund") return true;
    if (type !== "entry") return false;
    const rep = await rec.rel("tax_repartition_line_id");
    if (rep) return (await rep.get("document_type")) === "refund";
    const taxes = await rec.rels("tax_ids");
    const uses: string[] = [];
    for (const t of taxes) uses.push(String(await t.get("type_tax_use")));
    let refund = false;
    if (uses.includes("sale") && uses.includes("purchase")) refund = Number((await rec.get("credit")) ?? 0) === 0;
    else if ((uses[0] === "sale" && Number((await rec.get("credit")) ?? 0) === 0) || (uses[0] === "purchase" && Number((await rec.get("debit")) ?? 0) === 0)) refund = true;
    if (taxes.length && move && (await move.get("reversed_entry_id"))) refund = !refund;
    return refund;
  },
  // purchase account_invoice.py:701-728 `_compute_purchase_matching_issue_msg`: the price and quantity mismatches against
  // the purchase line; the batch (`self`) is the line's own move (one line per purchase line, else it refuses)
  purchase_matching_issue_msg: async (env, rec) => {
    if (!(await rec.get("product_id"))) return false;
    const po = await rec.rel("purchase_line_id");
    if (!po || po.origin === null) return false;
    const move = typeof (await rec.get("move_id")) === "number" ? (await rec.get("move_id")) as number : null;
    const siblings = move === null ? [] : (await env.cr.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM account_move_line WHERE move_id = $1 AND purchase_line_id = $2", [move, po.origin])).rows;
    if ((siblings[0]?.n ?? 0) > 1) throw new NotPorted("account.move.line.purchase_matching_issue_msg of several lines of one purchase line (batch sums)");
    const poUom = typeof (await po.get("uom_id")) === "number" ? (await po.get("uom_id")) as number : null;
    const lineUom = typeof (await rec.get("product_uom_id")) === "number" ? (await rec.get("product_uom_id")) as number : null;
    if (poUom !== lineUom) throw new NotPorted("account.move.line.purchase_matching_issue_msg in another unit");
    const refund = Boolean(await rec.get("is_refund"));
    const qty = Number((await rec.get("quantity")) ?? 0);
    const amlQty = refund ? -qty : qty;
    // `_prepare_qty_invoiced` with excluded_aml_ids=self.ids (a new line's NewId excludes nothing)
    const excluded = rec.id === null ? [] : [rec.id];
    const others = (await env.cr.query<{ qty: number; move_type: string; state: string; payment_state: string | null; uom: number | null }>(
      `SELECT l.quantity::float8 AS qty, m.move_type, m.state, m.payment_state, l.product_uom_id AS uom FROM account_move_line l JOIN account_move m ON m.id = l.move_id
        WHERE l.purchase_line_id = $1 AND l.id != ALL($2::int[]) ORDER BY l.id`, [po.origin, excluded])).rows;
    let invoiced = 0;
    for (const o of others) {
      if (o.state === "cancel" && o.payment_state !== "invoicing_legacy") continue;
      if (o.uom !== poUom) throw new NotPorted("purchase.order.line._prepare_qty_invoiced in another unit");
      if (o.move_type === "in_invoice") invoiced += o.qty; else if (o.move_type === "in_refund") invoiced -= o.qty;
    }
    let msg = "";
    const currency = typeof (await rec.get("currency_id")) === "number" ? (await rec.get("currency_id")) as number : null;
    const poCurrency = typeof (await po.get("currency_id")) === "number" ? (await po.get("currency_id")) as number : null;
    const discounted = Number((await rec.get("price_unit")) ?? 0) * (1 - Number((await rec.get("discount")) ?? 0) / 100);
    const poDiscounted = Number((await po.get("price_unit_discounted")) ?? 0);
    if (currency !== null) {
      const d = (await env.cr.query<{ d: number }>("SELECT decimal_places AS d FROM res_currency WHERE id = $1", [currency])).rows[0]!.d;
      const a = Math.round(poDiscounted * 10 ** d), b = Math.round(discounted * 10 ** d);
      if (a !== b) msg += ` ${a > b ? "⬇" : "⬆"} ${await formatAmount(env, poDiscounted, poCurrency ?? currency)}`;
    }
    const product = await po.rel("product_id");
    const polQty = product && (await product.get("purchase_method")) === "purchase" ? Number((await po.get("product_qty")) ?? 0) : Number((await po.get("qty_received")) ?? 0);
    const digits = (await env.cr.query<{ d: number }>("SELECT digits AS d FROM decimal_precision WHERE name = 'Product Unit'")).rows[0]?.d ?? 2;
    const r = (x: number): number => Math.round(x * 10 ** digits);
    if (r(invoiced + amlQty) !== r(polQty)) {
      const expected = polQty - (invoiced + amlQty - amlQty);
      const uomName = (await env.model("uom.uom").displayName([poUom!])).get(poUom!) ?? "";
      msg += ` ⚠ ${pyFloatRepr(expected)} ${uomName}`;
    }
    return msg;
  },
});

defineComputes("payment.provider", {
  // payment_provider.py:252-272 _compute_primary_payment_method_ids: the provider's payment methods without a primary
  // method, except 'unknown' (active_test=False, as the user), by id (ARRAY_AGG ORDER BY id)
  primary_payment_method_ids: async (env, rec) => {
    if (rec.id === null) return [];
    const ids = await env.withContext({ ...env.context, active_test: false }).model("payment.method").search(and([
      cond("provider_id", "in", [rec.id]), cond("primary_payment_method_id", "=", false), cond("code", "!=", "unknown"),
    ]), { activeTest: false });
    return [...ids].sort((a, b) => a - b);
  },
});

// ------------------------------------------------------------------------------------------------ payment terms

/** Dates as [y, m, d] (UTC Date arithmetic for relativedelta). */
const ymd = (d: string): Date => new Date(`${d}T00:00:00Z`);
const iso = (d: Date): string => d.toISOString().slice(0, 10);
const addDaysUtc = (d: Date, n: number): Date => new Date(d.getTime() + n * 86400000);
const endOfMonth = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
/** relativedelta(months=n[, day=day]): the day clamped to the target month's length. */
function addMonths(d: Date, n: number, day?: number): Date {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day ?? d.getUTCDate(), last)));
}

/** account_payment_term.py:303-320 _get_due_date. */
export async function dueDate(line: Rec, dateRef: string): Promise<string> {
  const due = ymd(dateRef);
  const nb = Number((await line.get("nb_days")) ?? 0);
  const type = await line.get("delay_type");
  if (type === "days_after_end_of_month") return iso(addDaysUtc(endOfMonth(due), nb));
  if (type === "days_after_end_of_next_month") return iso(addDaysUtc(endOfMonth(addMonths(due, 1)), nb));
  if (type === "days_end_of_month_on_the") {
    const raw = String((await line.get("days_next_month")) ?? "");
    const parsed = /^\s*[-+]?\d+\s*$/.test(raw) ? parseInt(raw, 10) : 1;
    if (parsed <= 0) return iso(endOfMonth(addDaysUtc(due, nb)));
    return iso(addMonths(addDaysUtc(due, nb), 1, parsed));
  }
  return iso(addDaysUtc(due, nb));
}

/** misc.py:1379-1419 format_date with the lang's date_format. */
export async function formatDate(env: Environment, value: string): Promise<string> {
  const lang = await getLang(env);
  const [y, mo, d] = value.split("-").map(Number) as [number, number, number];
  return formatPosix(lang.dateFormat, { y, mo, d, h: 0, mi: 0, s: 0 }, lang.code);
}

/** The payment term's currency (account_payment_term.py:53-57): the company's, else env.company's. */
async function termCurrency(env: Environment, rec: Rec): Promise<number> {
  const company = await rec.rel("company_id");
  const c = company ? await company.get("currency_id") : null;
  if (c) return Number(c);
  return Number((await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [await env.company()])).rows[0]!.c);
}

async function termPreview(env: Environment, rec: Rec): Promise<{ preview: string; discount: string }> {
  if (env.lang && env.lang !== "en_US") throw new NotPorted("account.payment.term example preview outside en_US");
  const currencyId = await termCurrency(env, rec);
  const cur = await currencyData(env, currencyId);
  const round = (v: number): number => roundPrecision(v, cur.rounding);
  const amount = Number((await rec.get("example_amount")) ?? 1000);
  const dateRef = String((await rec.get("example_date")) || await contextToday(env));
  let discount = "";
  const early = Boolean(await rec.get("early_discount"));
  if (early) {
    const days = Number((await rec.get("discount_days")) ?? 0);
    const date = await formatDate(env, iso(addDaysUtc(ymd(dateRef), days)));
    // _get_amount_due_after_discount(example_amount, 0.0): tax 0
    const pct = Number((await rec.get("discount_percentage")) ?? 0) / 100.0;
    const due = round(amount - amount * pct);
    discount = `Early Payment Discount: <b>${await formatLangAmount(env, due, currencyId)}</b> if paid before <b>${date}</b>`;
  }
  let preview = "";
  const lines = await rec.rels("line_ids");
  if (lines.length) {
    // _compute_terms with tax 0 and sign 1: percentage lines round the share, the last line takes the balance
    let residual = amount;
    const terms: { date: string; amount: number }[] = [];
    for (const [i, line] of lines.entries()) {
      const date = await dueDate(line, dateRef);
      let value: number;
      if (i === lines.length - 1) value = residual;
      else if ((await line.get("value")) === "fixed") value = round(Number((await line.get("value_amount")) ?? 0));
      else value = round(amount * (Number((await line.get("value_amount")) ?? 0) / 100.0));
      residual -= value;
      terms.push({ date, amount: value });
    }
    // _get_amount_by_date: grouped by date in date order (stable sort), amounts summed
    const sorted = [...terms].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const byDate = new Map<string, number>();
    for (const t of sorted) byDate.set(t.date, (byDate.get(t.date) ?? 0) + t.amount);
    let i = 0;
    for (const [date, value] of byDate) {
      i++;
      preview += `<div><b>${i}#</b> Installment of <b>${await formatLangAmount(env, value, currencyId)}</b> due on <b style='color: #704A66;'>${await formatDate(env, date)}</b></div>`;
    }
  }
  return { preview, discount };
}

async function htmlCache(env: Environment, model: string, fname: string, value: string): Promise<string | false> {
  if (!value) return value;
  const def = env.reg.model(model);
  return sanitizeHtml(env, def, def.fields.get(fname)!, value);
}

/** misc.py formatLang(env, value, currency_obj=currency): the currency's digits, grouping, symbol by position. */
async function formatLangAmount(env: Environment, value: number, currencyId: number): Promise<string> {
  const c = (await env.cr.query<{ symbol: string | null; position: string; decimal_places: number }>(
    "SELECT symbol, position, decimal_places FROM res_currency WHERE id = $1", [currencyId])).rows[0]!;
  const lang = (await getLang(env)).code;
  const num = await langNumber(env, lang, value, c.decimal_places);
  return c.position === "before" ? `${c.symbol ?? ""}\u00a0${num}` : `${num}\u00a0${c.symbol ?? ""}`;
}

defineComputes("account.payment.term", {
  // account_payment_term.py:95-132 _compute_example_preview (both fields)
  // assigned Html values are sanitized into the cache (fields_textual.py:731 _validated_cache_value)
  example_preview: async (env, rec) => htmlCache(env, "account.payment.term", "example_preview", (await termPreview(env, rec)).preview),
  example_preview_discount: async (env, rec) => htmlCache(env, "account.payment.term", "example_preview_discount", (await termPreview(env, rec)).discount),
  // account_payment_term.py:53-57 _compute_currency_id
  currency_id: async (env, rec) => termCurrency(env, rec),
});
defineComputes("account.payment.term.line", {
  // account_payment_term.py:331-334
  display_days_next_month: async (_env, rec) => (await rec.get("delay_type")) === "days_end_of_month_on_the",
});
// example_amount (default 1000) and example_date (default context today) are non-stored defaulted fields
registerDefaultValued("account.payment.term", "example_amount");
registerDefaultValued("account.payment.term", "example_date");

registerDefaults("account.payment.term", {
  // account_payment_term.py:15-16 _default_line_ids
  line_ids: async () => [[0, 0, { value: "percent", value_amount: 100.0, nb_days: 0 }]],
  // account_payment_term.py:18-19 _default_example_date
  example_date: async (env) => env.context["example_date"] || await contextToday(env),
});
registerRecordCompute("account.payment.term", {
  // account_payment_term.py:79-88 _compute_discount_computation (stored): by the company's country
  early_pay_discount_computation: async (env, rec) => {
    const company = await rec.rel("company_id");
    let code = company ? await company.get("country_code") : null;
    if (!code) code = (await env.cr.query<{ code: string | null }>(
      "SELECT c.code FROM res_company co JOIN res_partner p ON p.id = co.partner_id LEFT JOIN res_country c ON c.id = p.country_id WHERE co.id = $1",
      [await env.company()])).rows[0]?.code ?? null;
    return code === "BE" ? "mixed" : code === "NL" ? "excluded" : "included";
  },
});

registerRecordCompute("account.payment.term.line", {
  // account_payment_term.py:351-360 _compute_value_amount (stored): 0 for fixed lines, else what remains to 100% after
  // the term's percentage lines (the line being computed counts with its current value)
  value_amount: async (_env, rec) => {
    if ((await rec.get("value")) === "fixed") return 0;
    const term = await rec.rel("payment_id");
    let amount = 0;
    for (const line of term ? await term.rels("line_ids") : []) {
      const self = line === rec || (line.origin !== null && line.origin === rec.origin && rec.origin !== null);
      if (self) { if ((await rec.get("value")) === "percent") amount += Number((await rec.prev("value_amount")) ?? 0); continue; }
      if ((await line.get("value")) === "percent") amount += Number((await line.get("value_amount")) ?? 0);
    }
    return 100 - amount;
  },
});

registerRecordCompute("account.payment.term.line", {
  // account_payment_term.py:342-349 _compute_days (stored): a new line without days follows the previous line by 30
  nb_days: async (_env, rec) => {
    const current = Number((await rec.prev("nb_days")) ?? 0);
    const term = await rec.rel("payment_id");
    let lines = term ? await term.rels("line_ids") : [];
    // a new line set on a new term is in the term's lines (the inverse of payment_id in the new() cache)
    if (term && rec.id === null && !lines.includes(rec) && !(rec.origin !== null && lines.some((l) => l.origin === rec.origin))) lines = [...lines, rec];
    if (!current && lines.length > 1) return Number((await lines[lines.length - 2]!.get("nb_days")) ?? 0) + 30;
    return current;
  },
});

// ------------------------------------------------------------------------------------------------ move sequences

/** sequence_mixin.py:32-49 regexes (Python syntax; `(?P<` becomes `(?<` for JavaScript) and their placeholders. */
const SEQ_RE: Record<string, { py: string; places: string[] }> = {
  year_range_month: { py: String.raw`^(?P<prefix1>.*?)(?P<year>((?<=\D)|(?<=^))((19|20|21)\d{2}|(\d{2}(?=\D))))(?P<prefix2>\D)(?P<year_end>((?<=\D)|(?<=^))((19|20|21)\d{2}|(\d{2}(?=\D))))(?P<prefix3>\D)(?P<month>(0[1-9]|1[0-2]))(?P<prefix4>\D+?)(?P<seq>\d*)(?P<suffix>\D*?)$`, places: ["prefix1", "year", "prefix2", "year_end", "prefix3", "month", "prefix4", "seq", "suffix"] },
  year_range: { py: String.raw`^(?:(?P<prefix1>.*?)(?P<year>((?<=\D)|(?<=^))((19|20|21)\d{2}|(\d{2}(?=\D))))(?P<prefix2>\D)(?P<year_end>((?<=\D)|(?<=^))((19|20|21)\d{2}|(\d{2}(?=\D))))(?P<prefix3>\D+?))?(?P<seq>\d*)(?P<suffix>\D*?)$`, places: ["prefix1", "year", "prefix2", "year_end", "prefix3", "seq", "suffix"] },
  month: { py: String.raw`^(?P<prefix1>.*?)(?P<year>((?<=\D)|(?<=^))((19|20|21)\d{2}|(\d{2}(?=\D))))(?P<prefix2>\D*?)(?P<month>(0[1-9]|1[0-2]))(?P<prefix3>\D+?)(?P<seq>\d*)(?P<suffix>\D*?)$`, places: ["prefix1", "year", "prefix2", "month", "prefix3", "seq", "suffix"] },
  year: { py: String.raw`^(?P<prefix1>.*?)(?P<year>((?<=\D)|(?<=^))((19|20|21)?\d{2}))(?P<prefix2>\D+?)(?P<seq>\d*)(?P<suffix>\D*?)$`, places: ["prefix1", "year", "prefix2", "seq", "suffix"] },
  never: { py: String.raw`^(?P<prefix1>.*?)(?P<seq>\d{0,9})(?P<suffix>\D*?)$`, places: ["prefix1", "seq", "suffix"] },
};
const jsRe = (py: string): RegExp => new RegExp(py.replace(/\(\?P</g, "(?<"));
/** sequence_mixin.py:230-244 + account_move.py:4339-4349: the anti-regexes of yearly and fixed sequences (for PostgreSQL). */
const ANTI_YEAR = String.raw`^(?:.*?)(?:((?<=\D)|(?<=^))((19|20|21)\d{2}|(\d{2}(?=\D))))(?:\D*?)(?:(0[1-9]|1[0-2]))(?:\D+?)$`;
const ANTI_NEVER = String.raw`^(?:.*?)(?:((?<=\D)|(?<=^))((19|20|21)?\d{2}))(?:\D+?)$`;

/** sequence_mixin.py:193-225 _deduce_sequence_number_reset. */
export function deduceReset(name: string): string {
  const requirements: [string, string[]][] = [
    ["year_range_month", ["seq", "year", "year_end", "month"]], ["month", ["seq", "month", "year"]],
    ["year_range", ["seq", "year", "year_end"]], ["year", ["seq", "year"]], ["never", ["seq"]],
  ];
  for (const [ret, reqs] of requirements) {
    const m = jsRe(SEQ_RE[ret]!.py).exec(name);
    if (!m) continue;
    const g = m.groups ?? {};
    if (g["year_end"] && g["year"]) {
      const y = g["year"], ye = g["year_end"];
      // _validate_fiscalyear_difference: (int(year) + 1) % 10**len(year) == int(year_end)
      if (y.length < ye.length || (Number(y) + 1) % 10 ** y.length !== Number(ye)) continue;
    }
    if (reqs.every((r) => g[r] !== undefined)) return ret;
  }
  throw new NotPorted(`sequence without a seq group: ${name}`);
}

interface SeqFormat { places: string[]; values: Record<string, string | number> }
/** sequence_mixin.py:314-355 _get_sequence_format_param. */
function formatParam(previous: string): SeqFormat {
  const reset = deduceReset(previous);
  const spec = SEQ_RE[reset]!;
  const g = { ...(jsRe(spec.py).exec(previous)!.groups ?? {}) } as Record<string, string | undefined>;
  const values: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(g)) values[k] = v ?? "";
  values["seq_length"] = (g["seq"] ?? "").length;
  values["year_length"] = (g["year"] ?? "").length;
  values["year_end_length"] = (g["year_end"] ?? "").length;
  if (!g["seq"] && "prefix1" in g && "suffix" in g) { values["prefix1"] = g["suffix"] ?? ""; values["suffix"] = ""; }
  for (const f of ["seq", "year", "month", "year_end"]) values[f] = Number(g[f] || 0);
  return { places: spec.places, values };
}
const zpad = (n: number, len: number): string => (n < 0 ? "-" + String(-n).padStart(Math.max(len - 1, 0), "0") : String(n).padStart(len, "0"));
function renderSeq(f: SeqFormat): string {
  const v = f.values;
  return f.places.map((p) => p === "seq" ? zpad(Number(v["seq"]), Number(v["seq_length"]))
    : p === "month" ? zpad(Number(v["month"]), 2)
    : p === "year" ? zpad(Number(v["year"]), Number(v["year_length"]))
    : p === "year_end" ? zpad(Number(v["year_end"]), Number(v["year_end_length"]))
    : String(v[p] ?? "")).join("");
}

const daysIn = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * account company.py:1257-1265 `compute_fiscalyear_dates` of `env.company` (its last day and month). A company with
 * fiscal year records (account.fiscal.year, a module overriding the computation) refuses.
 */
async function fiscalYearDates(env: Environment, date: string): Promise<[string, string]> {
  const company = await env.company();
  const row = (await env.cr.query<{ d: number; m: string }>("SELECT fiscalyear_last_day AS d, fiscalyear_last_month AS m FROM res_company WHERE id = $1", [company])).rows[0];
  const fy = env.reg.models.has("account.fiscal.year")
    ? (await env.cr.query("SELECT 1 FROM account_fiscal_year WHERE company_id = $1 LIMIT 1", [company])).rows.length : 0;
  if (!row || fy) throw new NotPorted("move sequences with fiscal year records (compute_fiscalyear_dates)");
  return fiscalYear(date, Number(row.d), Number(row.m));
}

/**
 * sequence_mixin.py:120-128 + account_move.py:4422-4449 `_get_sequence_date_range`: the range and the forced years
 * (`year_range_month`: the fiscal year's first and last year) or null.
 */
async function seqDateRange(env: Environment, reset: string, date: string): Promise<[string, string, number | null, number | null]> {
  const y = date.slice(0, 4);
  const monthRange = (): [string, string] => [`${date.slice(0, 7)}-01`, iso(endOfMonth(ymd(date)))];
  if (reset === "year_range" || reset === "year_range_month") {
    const [from, to] = await fiscalYearDates(env, date);
    if (reset === "year_range") return [from, to, null, null];
    const lastDay = Number(to.slice(8, 10)), lastMonth = Number(to.slice(5, 7));
    const forcedStart = Number(from.slice(0, 4)), forcedEnd = Number(to.slice(0, 4));
    const [ms, me] = monthRange();
    if (lastDay < daysIn(Number(y), lastMonth) && lastMonth === Number(date.slice(5, 7))) {
      if (Number(date.slice(8, 10)) <= lastDay) return [ms, `${date.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`, forcedStart, forcedEnd];
      return [`${date.slice(0, 7)}-${String(lastDay + 1).padStart(2, "0")}`, me, forcedStart, forcedEnd];
    }
    return [ms, me, forcedStart, forcedEnd];
  }
  if (reset === "year") return [`${y}-01-01`, `${y}-12-31`, null, null];
  if (reset === "month") return [...monthRange(), null, null];
  return ["0001-01-01", "9999-12-31", null, null];
}

/** account_move.py:4310-4377 _get_last_sequence_domain as SQL text and parameters. */
async function lastSequenceCondition(env: Environment, rec: Rec, relaxed: boolean): Promise<{ sql: string; params: unknown[] } | null> {
  const date = await rec.get("date"), journal = await rec.rel("journal_id");
  if (!date || !journal) return null;
  if (await journal.get("is_self_billing")) throw new NotPorted("move sequences of self-billing journals");
  const params: unknown[] = [journal.origin];
  let sql = "journal_id = $1 AND name != '/'";
  const isPayment = Boolean(await rec.get("origin_payment_id")) || Boolean(env.context["is_payment"]);
  const refundSeq = Boolean(await journal.get("refund_sequence")), paymentSeq = Boolean(await journal.get("payment_sequence"));
  const type = await moveType(rec);
  const isRefund = ["out_refund", "in_refund"].includes(type);
  if (!relaxed) {
    const selfId = rec.id ?? rec.origin;
    let domain = and([cond("journal_id", "=", journal.origin), cond("id", "!=", selfId ?? false), cond("name", "not in", ["/", "", false])]);
    if (refundSeq) domain = and([domain, cond("move_type", isRefund ? "in" : "not in", ["out_refund", "in_refund"])]);
    if (paymentSeq) domain = and([domain, cond("origin_payment_id", isPayment ? "!=" : "=", false)]);
    const su = env.sudo();
    let ref = await su.model("account.move").search(and([domain, cond("date", "<=", date)]), { order: "date desc", limit: 1 });
    if (!ref.length) ref = await su.model("account.move").search(domain, { order: "date asc", limit: 1 });
    const refName = ref.length ? String((await new DbRec(su, su.reg.model("account.move"), ref[0]!).get("name")) || "") : "";
    const reset = deduceReset(refName);
    const [start, end] = await seqDateRange(env, reset, String(date));
    params.push(start, end);
    sql += ` AND date BETWEEN $${params.length - 1} AND $${params.length}`;
    const anti = reset === "year" || reset === "year_range" ? ANTI_YEAR : reset === "never" ? ANTI_NEVER : null;
    if (anti && !(await journal.get("sequence_override_regex")) && !env.context["no_anti_regex"]) {
      params.push(anti);
      sql += ` AND sequence_prefix !~ $${params.length}`;
    }
  }
  if (refundSeq) sql += isRefund ? " AND move_type IN ('out_refund', 'in_refund')" : " AND move_type NOT IN ('out_refund', 'in_refund')";
  else if (paymentSeq) sql += isPayment ? " AND origin_payment_id IS NOT NULL" : " AND origin_payment_id IS NULL";
  return { sql, params };
}

/**
 * `self._get_last_sequence_domain(relaxed)` through callPrivate (private_hooks.json): account's definition is the
 * hand's (lastSequenceCondition; `SQL("FALSE")` without a date or journal), a module's compiled override runs around it
 * (account_debit_note: the debit notes' own sequence). The record may be new (highest_name, name_placeholder).
 */
async function lastSequenceDomain(env: Environment, rec: Rec, relaxed: boolean): Promise<PrivateSql> {
  const out = await priv.account_move._get_last_sequence_domain.call(env, rec.id !== null ? [rec.id] : [], [relaxed],
    async (e, _ids, args) => {
      const c = await lastSequenceCondition(e, rec, Boolean(args[0]));
      return c === null ? new PrivateSql("FALSE", []) : new PrivateSql(c.sql, c.params);
    }, undefined, [rec]);
  if (!(out instanceof PrivateSql)) throw new NotPorted("account.move._get_last_sequence_domain() returned something else than an SQL");
  return out;
}

/** sequence_mixin.py:272-312 _get_last_sequence (sudo query, without the record itself). */
export async function lastSequence(env: Environment, rec: Rec, relaxed: boolean): Promise<string | null> {
  const c = await lastSequenceDomain(env, rec, relaxed);
  // :296 `if condition := ...`: FALSE finds nothing (no query needed), an empty SQL adds no condition
  if (c.sql === "FALSE" && !c.params.length) return null;
  let where = c.sql === "" ? "TRUE" : `(${c.sql})`;
  const params = [...c.params];
  const selfId = rec.id ?? rec.origin;
  if (selfId !== null) { params.push(selfId); where += ` AND id != $${params.length}`; }
  const row = (await env.cr.query<{ name: string }>(
    `SELECT name FROM account_move WHERE ${where}
        AND sequence_prefix = (SELECT sequence_prefix FROM account_move WHERE ${where} ORDER BY id DESC LIMIT 1)
      ORDER BY sequence_number DESC LIMIT 1`, params)).rows[0];
  return row ? row.name : null;
}

/** `self._get_starting_sequence()` through callPrivate (private_hooks.json): account's definition is the hand's below. */
async function startingSequence(env: Environment, rec: Rec): Promise<string> {
  const out = await priv.account_move._get_starting_sequence.call(env, rec.id !== null ? [rec.id] : [], [],
    async (e) => accountStartingSequence(e, rec), undefined, [rec]);
  if (typeof out !== "string") throw new NotPorted("account.move._get_starting_sequence() returned something else than a str");
  return out;
}

/** account_move.py:4392-4420 _get_starting_sequence with :4379-4390 `_get_sequence_date_info`. */
async function accountStartingSequence(env: Environment, rec: Rec): Promise<string> {
  // :4383 `compute_fiscalyear_dates(self.date)` of the move's own date
  const moveDate = await rec.get("date");
  // a move without a journal (a new form whose journal was emptied): its fields read False, `"%s" % False` is "False"
  const journal = await rec.rel("journal_id");
  const jget = async (f: string): Promise<unknown> => journal ? journal.get(f) : false;
  const date = String((await rec.get("date")) || (await rec.get("invoice_date")) || await contextToday(env));
  const codeV = await jget("code");
  const code = codeV === false || codeV === null || codeV === undefined ? "False" : String(codeV);
  const jtype = await jget("type");
  if (await jget("is_self_billing")) throw new NotPorted("the starting sequence of a self-billing journal");
  let yearPart = date.slice(0, 4);
  let staggered = false;
  // Odoo's get_fiscal_year(False) raises (AttributeError): refused
  if (!moveDate) throw new NotPorted("the starting sequence of a move without a date (compute_fiscalyear_dates(False))");
  const [from, to] = await fiscalYearDates(env, String(moveDate));
  staggered = from.slice(0, 4) !== to.slice(0, 4);
  if (staggered) yearPart = `${from.slice(2, 4)}-${to.slice(2, 4)}`;
  let start = ["sale", "bank", "cash", "credit"].includes(String(jtype)) ? `${code}/${yearPart}/${staggered ? "0000" : "00000"}` : `${code}/${yearPart}/${date.slice(5, 7)}/0000`;
  if ((await jget("refund_sequence")) && ["out_refund", "in_refund"].includes(await moveType(rec))) start = "R" + start;
  if (((await jget("payment_sequence")) && (await rec.get("origin_payment_id"))) || env.context["is_payment"]) start = "P" + start;
  return start;
}

defineComputes("account.move", {
  // account_move.py:1023-1026 _compute_highest_name
  highest_name: async (env, rec) => (await lastSequence(env, rec, false)) || false,
  // account_move.py:1013-1021 _compute_name_placeholder with sequence_mixin.py:451-475 _get_next_sequence_format
  name_placeholder: async (env, rec) => {
    const name = await rec.get("name");
    const date = await rec.get("date");
    if ((name && name !== "/") || !date || (await lastSequence(env, rec, false))) return false;
    return nextSequenceName(env, rec);
  },
});

/** sequence_mixin.py:139-155 `_sequence_matches_date`. */
export async function sequenceMatchesDate(env: Environment, sequence: string, date: string): Promise<boolean> {
  const reset = deduceReset(sequence);
  const v = formatParam(sequence).values;
  const [start, end, forcedStart, forcedEnd] = await seqDateRange(env, reset, date);
  const yearMatch = (value: number, year: number): boolean => value === year % 10 ** String(value).length;
  const year = Number(v["year"]), yearEnd = Number(v["year_end"]), month = Number(v["month"]);
  return (!year || yearMatch(year, forcedStart || Number(start.slice(0, 4)))) && (!yearEnd || yearMatch(yearEnd, forcedEnd || Number(end.slice(0, 4))))
    && (!month || month === Number(date.slice(5, 7)));
}

/** sequence_mixin.py:451-475 `_get_next_sequence_format`: the format and its values, `seq` the last number used. */
async function nextSequenceFormat(env: Environment, rec: Rec): Promise<SeqFormat> {
  const previous = await lastSequence(env, rec, false);
  const last = previous || (await lastSequence(env, rec, true)) || await startingSequence(env, rec);
  const f = formatParam(last);
  if (!previous) {
    const date = String(await rec.get("date"));
    const [start, end, forcedStart, forcedEnd] = await seqDateRange(env, deduceReset(last), date);
    f.values["seq"] = 0;
    f.values["year"] = (forcedStart || Number(start.slice(0, 4))) % 10 ** Number(f.values["year_length"]);
    f.values["year_end"] = (forcedEnd || Number(end.slice(0, 4))) % 10 ** Number(f.values["year_end_length"]);
    f.values["month"] = Number(date.slice(5, 7));
  }
  return f;
}

/** The next name without taking it (the placeholder shown on a draft, `_compute_name_placeholder`). */
export async function nextSequenceName(env: Environment, rec: Rec): Promise<string> {
  const f = await nextSequenceFormat(env, rec);
  f.values["seq"] = Number(f.values["seq"]) + 1;
  return renderSeq(f);
}

let savepoints = 0;

/**
 * sequence_mixin.py:427-449 `_set_next_sequence` with :357-425 `_locked_increment`: write the next name on the posted
 * move inside a savepoint. The UPDATE puts the row under the unique index `account_move_unique_name` (state posted,
 * name not '/'), which locks the index entry: a concurrent transaction holding the same number makes this one wait,
 * and once it committed the UPDATE fails with a unique violation; the savepoint is rolled back and the next number is
 * tried, until a free one is found. Returns the name written.
 */
export async function lockedNextSequence(env: Environment, rec: Rec, id: number): Promise<string> {
  const f = await nextSequenceFormat(env, rec);
  let seq = Number(f.values["seq"]);
  const sp = `seq_${++savepoints}`;
  await env.cr.query(`SAVEPOINT ${sp}`);
  for (;;) {
    seq += 1;
    f.values["seq"] = seq;
    const name = renderSeq(f);
    try {
      await env.cr.query("UPDATE account_move SET state = 'posted', name = $1 WHERE id = $2", [name, id]);
      await env.cr.query(`RELEASE SAVEPOINT ${sp}`);
      return name;
    } catch (e) {
      // :421 except (pgerrors.ExclusionViolation, pgerrors.UniqueViolation): sp.rollback()
      const code = typeof e === "object" && e !== null && "code" in e ? (e as { code: unknown }).code : null;
      if (code !== "23505" && code !== "23P01") throw e;
      await env.cr.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    }
  }
}

// ------------------------------------------------------------------------------------------------ move tax totals

/**
 * account_move.py:1899-1941 _compute_tax_totals for a stored invoice with :1852-1897 _get_rounded_base_and_tax_lines:
 * its product lines as base lines (:1665-1691), through the engine, checked against its tax journal items (the manual
 * tax amount adjustment of `_round_base_lines_tax_details(tax_lines=...)` is not ported: a difference refuses).
 * Early payment, cash rounding and non-deductible lines, extra tax data and new moves refuse.
 */
function repartitionLines(document: string): () => Promise<unknown> {
  return async () => [[0, 0, { document_type: document, repartition_type: "base", tag_ids: [], factor_percent: 100, sequence: 1 }], [0, 0, { document_type: document, repartition_type: "tax", tag_ids: [], factor_percent: 100, sequence: 1 }]];
}

/**
 * account_move.py:1665-1691 `_prepare_product_base_line_for_taxes_computation`; a compiled override of
 * `_prepare_base_line_for_taxes_computation` runs on it (src/models/account_tax_hooks.ts checkBaseLine) unless the
 * caller dispatches the line itself (`dispatched`: syncInvoice).
 */
export async function productBaseLine(env: Environment, line: Rec, doc: { sign: number; rate: number; currency: Awaited<ReturnType<typeof currencyData>>; mode: unknown;
  dispatched?: boolean; entry?: boolean }): Promise<BaseLine> {
  // account_move.py:1685-1689: the special type from the computation key
  const extra = extraTaxData(await line.get("extra_tax_data"), null);
  const taxIds = (await line.rels("tax_ids")).map((t) => t.origin).filter((id): id is number => id !== null);
  const taxes = (await taxData(env, taxIds)).sort((a, b) => a.sequence - b.sequence || a.id - b.id);
  const lineCurrency = await line.get("currency_id");
  // account_move.py:1660-1683: a line of a move that is no invoice is its amount in the move's currency, once, with
  // the rate of its own amounts and the 'total_excluded' special mode
  const amountCurrency = doc.entry ? Number((await line.get("amount_currency")) ?? 0) : 0;
  const balance = doc.entry ? Number((await line.get("balance")) ?? 0) : 0;
  const priceUnit = doc.entry ? amountCurrency : Number((await line.get("price_unit")) ?? 0);
  const quantity = doc.entry ? 1 : Number((await line.get("quantity")) ?? 0);
  const discount = doc.entry ? 0 : Number((await line.get("discount")) ?? 0);
  const rate = doc.entry ? (balance ? Math.abs(amountCurrency / balance) : 0) : doc.rate;
  const specialMode = doc.entry ? "total_excluded" : false;
  const base = accountTaxHelpers.prepare_base_line_for_taxes_computation({
    id: line.origin ?? 0, tax_ids: taxes, price_unit: priceUnit, quantity, discount,
    currency_id: typeof lineCurrency === "number" && lineCurrency ? await currencyData(env, lineCurrency) : doc.currency,
    rate, product_id: {}, product_uom_id: {}, document_tax_mode: typeof doc.mode === "string" && doc.mode ? doc.mode : null,
    extra_tax_data: extra.extra_tax_data,
  }, { sign: doc.sign, special_type: extra.special_type, ...(specialMode ? { special_mode: specialMode, price_unit: priceUnit, quantity, discount, rate } : {}) });
  if (!doc.dispatched) {
    await checkBaseLine(env, base, async () => {
      const kwargs: Record<string, unknown> = { price_unit: priceUnit, quantity, discount, rate, sign: doc.sign, special_mode: specialMode, name: (await line.get("name")) || false,
        ...(extra.special_type ? { special_type: extra.special_type } : {}) };
      const move = await line.rel("move_id");
      const type = move ? String(await move.get("move_type")) : "";
      return { record: lineRecord("account.move.line", line), kwargs, loaded: await loadedOf(line, {}, type === "out_refund" || type === "in_refund") };
    });
  }
  return base;
}

/** A tax journal item as `_prepare_tax_line_for_taxes_computation` gives it (amounts with the move's direction sign). */
interface TaxLineAmounts { readonly tax: number; readonly currency: number; readonly isRefund: boolean; readonly amountCurrency: number; readonly balance: number }

/**
 * account_tax.py:2126-2203 `_round_tax_details_tax_amounts_from_tax_lines` (python-side only): per tax, currency and
 * refund flag, the delta between the tax journal items and the rounded tax details is distributed smoothly over the
 * base lines' tax data, in the document currency and in the company's. A base line's `is_refund` is its move's
 * (account_move_line.py:1564-1568 on an invoice).
 */
export function roundTaxAmountsFromTaxLines(bases: readonly BaseLine[], company: Awaited<ReturnType<typeof companyData>>, taxLines: readonly TaxLineAmounts[], isRefund: boolean): void {
  if (!taxLines.length) return;
  const key = (tax: number, currency: number, refund: boolean): string => `${tax}|${currency}|${refund}`;
  const targets = new Map<string, { currency: number; balance: number }>();
  for (const t of taxLines) {
    const k = key(t.tax, t.currency, t.isRefund);
    const v = targets.get(k) ?? { currency: 0, balance: 0 };
    v.currency += t.amountCurrency; v.balance += t.balance;
    targets.set(k, v);
  }
  // `_aggregate_base_lines_tax_details` + `_aggregate_base_lines_aggregated_values`: the tax data per key, in the order
  // of the base lines and of their taxes
  const groups = new Map<string, { decimals: number; data: BaseLineTaxData[] }>();
  for (const b of bases) {
    for (const td of b.tax_details.taxes_data) {
      const k = key(td.tax.id, b.currency_id.id, isRefund);
      const g = groups.get(k) ?? { decimals: b.currency_id.decimal_places, data: [] };
      g.data.push(td);
      groups.set(k, g);
    }
  }
  for (const [k, g] of groups) {
    const target = targets.get(k);
    if (!target) continue;
    for (const [field, decimals, wanted] of [["tax_amount_currency", g.decimals, target.currency], ["tax_amount", company.currency_id.decimal_places, target.balance]] as const) {
      const current = g.data.reduce((sum, td) => sum + td[field], 0);
      if (!current) continue;
      const amounts = accountTaxHelpers.distribute_delta_amount_smoothly(decimals, wanted - current, g.data.map((td) => ({ factor: td[field] })));
      g.data.forEach((td, i) => { td[field] += amounts[i]!; });
    }
  }
}

async function moveTaxTotals(env: Environment, rec: Rec): Promise<unknown> {
  const type = await moveType(rec);
  if (![...SALE_R, ...PURCHASE_R].includes(type)) return null;
  // the labels are account's `_()` and the tax groups' names in env.lang (withTaxEngineLabels, taxData)
  if (await rec.get("invoice_cash_rounding_id")) throw new NotPorted("account.move.tax_totals with cash rounding");
  const companyId = Number(await rec.get("company_id"));
  const company = await companyData(env, companyId);
  const currencyId = Number(await rec.get("currency_id")) || 0;
  // :1923 `currency=move.currency_id`: a new invoice without a journal has none (:1150-1158), an empty recordset whose
  // id is False and rounding 0.0 in the summary (account_tax.py:2810-2811); nothing is rounded with it when there are
  // no base lines and no cash rounding (:2948 `currency.round` is the cash rounding's)
  const currency = currencyId ? await currencyData(env, currencyId) : { id: 0, rounding: 0, decimal_places: 0 };
  const sign = type === "entry" || ["out_refund", "in_invoice", "in_receipt"].includes(type) ? 1 : -1; // direction_sign
  const rate = Number((await rec.get("invoice_currency_rate")) ?? 0);
  const mode = await rec.get("document_tax_mode");
  const bases: BaseLine[] = [];
  const taxLines: TaxLineAmounts[] = [];
  // :1866-1869 a move not stored yet only has its invoice lines
  if (rec.id === null) {
    const term = await rec.rel("invoice_payment_term_id");
    if (term && (await term.get("early_discount"))) throw new NotPorted("account.move.tax_totals of an unsaved move with an early payment discount");
  }
  for (const line of await rec.rels(rec.id === null ? "invoice_line_ids" : "line_ids")) {
    const dt = await line.get("display_type");
    if (rec.id === null && Number((await line.get("deductible_percentage")) ?? 1) !== 1) throw new NotPorted("account.move.tax_totals of an unsaved move with non deductible lines");
    if (["epd", "rounding", "non_deductible_product", "non_deductible_product_total"].includes(String(dt))) throw new NotPorted(`account.move.tax_totals with ${String(dt)} lines`);
    const rep = await line.rel("tax_repartition_line_id");
    if (rep) {
      // account_tax.py `_prepare_tax_line_for_taxes_computation` with the move's direction sign (account_move.py:1777-1780)
      taxLines.push({
        tax: Number(await rep.get("tax_id")), currency: Number(await line.get("currency_id")) || 0, isRefund: (await rep.get("document_type")) === "refund",
        amountCurrency: sign * Number((await line.get("amount_currency")) ?? 0), balance: sign * Number((await line.get("balance")) ?? 0),
      });
      continue;
    }
    if (dt !== "product") continue;
    bases.push(await productBaseLine(env, line, { sign, rate, currency, mode }));
  }
  if (!currencyId && bases.length) throw new NotPorted("account.move.tax_totals of invoice lines without a currency");
  accountTaxHelpers.add_tax_details_in_base_lines(bases, company);
  accountTaxHelpers.round_base_lines_tax_details(bases, company);
  // account_move.py:1872-1890: a stored move keeps the amounts of its tax journal items
  if (rec.id !== null) roundTaxAmountsFromTaxLines(bases, company, taxLines, type === "out_refund" || type === "in_refund");
  // account_tax.py:2837 `_("Untaxed Amount")` in the user's language (src/models/account_taxes.ts withTaxEngineLabels)
  const summary = withTaxEngineLabels(env, () => accountTaxHelpers.get_tax_totals_summary(bases, currency, company)) as Record<string, unknown>;
  if (!currencyId) summary["currency_id"] = false;
  const companyRec = await rec.rel("company_id");
  summary["display_in_company_currency"] = Boolean(companyRec && (await companyRec.get("display_invoice_tax_company_currency"))
    && (await rec.get("company_currency_id")) !== currencyId && summary["has_tax_groups"] && SALE_R.includes(type));
  return pyFloats(summary);
}
defineComputes("account.move", { tax_totals: moveTaxTotals });

registerRecordCompute("account.payment", {
  // account_payment.py:463-466 _compute_commercial_partner_id (stored)
  commercial_partner_id: async (_env, rec) => {
    const partner = await rec.rel("partner_id");
    return partner ? (await partner.get("commercial_partner_id")) || null : null;
  },
});
defineComputes("account.payment", {
  // account_payment.py:854-857 _compute_alerts: {} (read as False)
  alerts: async (env) => {
    const mods = env.reg.model("account.payment").modules ?? [];
    if (mods.some((m) => m.startsWith("l10n_"))) throw new NotPorted("account.payment.alerts with a localization override");
    return false;
  },
});

defineComputes("account.payment", {
  // account_payment.py:846-852 with :865-923 _fetch_duplicate_reference: draft or paid payments of the same company,
  // commercial partner, date, type and amount (the record's current values, as for records in edition)
  duplicate_payment_ids: async (_env, rec) => {
    const env = _env;
    const amount = Number((await rec.get("amount")) ?? 0);
    if (!(await rec.get("partner_id")) || !amount || (await rec.get("state")) === "paid") return [];
    const vals = [await rec.get("company_id"), await rec.get("commercial_partner_id"), await rec.get("date"), await rec.get("payment_type")];
    if (vals.some((v) => v === null || v === false || v === undefined)) return [];
    const row = (await env.cr.query<{ ids: number[] | null }>(
      `SELECT ARRAY_AGG(DISTINCT d.id) AS ids FROM account_payment d
        WHERE d.id != $1 AND d.company_id = $2 AND d.commercial_partner_id = $3 AND d.date = $4::date
          AND d.payment_type = $5 AND d.amount = $6::numeric AND d.state IN ('draft', 'paid')`,
      [rec.origin ?? rec.id ?? 0, ...vals, amount])).rows[0];
    return row?.ids ?? [];
  },
});

/** account_payment.py:571-580 _compute_show_require_partner_bank (method codes: 'manual' uses a bank account, none needs one). */
async function showPartnerBank(rec: Rec): Promise<boolean> {
  const journal = await rec.rel("journal_id");
  if (journal && (await journal.get("type")) === "cash") return false;
  return (await rec.get("payment_method_code")) === "manual";
}
defineComputes("account.payment", {
  show_partner_bank_account: async (_env, rec) => showPartnerBank(rec),
  require_partner_bank_account: async () => false,
});
/**
 * account_payment.py:520-548 `_compute_reconciliation_status` of a saved payment with a journal entry (its lines as
 * stored: `_seek_for_lines`). Amounts in the payment's currency are compared with its rounding.
 */
async function reconciliationStatus(env: Environment, rec: Rec): Promise<{ reconciled: boolean; matched: boolean }> {
  if (rec.origin === null && rec.id === null) throw new NotPorted("account.payment reconciliation status of a new record");
  const id = (rec.origin ?? rec.id)!;
  const stored = (await env.cr.query<{ move_id: number | null; currency_id: number; company_currency: number; journal_default: number | null }>(
    `SELECT p.move_id, p.currency_id, c.currency_id AS company_currency, j.default_account_id AS journal_default
       FROM account_payment p JOIN res_company c ON c.id = p.company_id JOIN account_journal j ON j.id = p.journal_id WHERE p.id = $1`, [id])).rows[0];
  const moveId = await rec.get("move_id"), currency = await rec.get("currency_id"), journal = await rec.get("journal_id"), company = await rec.get("company_id");
  if (!stored || stored.move_id !== moveId || stored.currency_id !== currency) throw new NotPorted("account.payment reconciliation status of a payment changed in edition");
  const journalDefault = (await env.cr.query<{ a: number | null; c: number }>(
    "SELECT j.default_account_id AS a, c.currency_id AS c FROM account_journal j, res_company c WHERE j.id = $1 AND c.id = $2", [journal, company])).rows[0];
  const { seekForLines } = await import("./account_entries");
  const { liquidity, counterpart, writeoff } = await seekForLines(env, id);
  const { currencyData } = await import("./account_taxes");
  const { roundPrecision } = await import("./account_tax_engine");
  const rounding = (await currencyData(env, Number(currency))).rounding;
  const zero = (v: number): boolean => v === 0 || Math.abs(roundPrecision(v, rounding)) < rounding;
  if (zero(Number((await rec.get("amount")) ?? 0))) return { reconciled: true, matched: true };
  const residual = (l: { amount_residual: number; amount_residual_currency: number }): number =>
    (Number(currency) === journalDefault?.c ? l.amount_residual : l.amount_residual_currency);
  const sum = (ls: readonly { amount_residual: number; amount_residual_currency: number }[]): number => ls.reduce((a, l) => a + residual(l), 0);
  // the journal's default account among the liquidity lines' accounts: payments managed without statement lines
  const matched = (journalDefault?.a != null && liquidity.some((l) => l.account_id === journalDefault.a)) || zero(sum(liquidity));
  const reconciled = zero(sum([...counterpart, ...writeoff].filter((l) => l.account_reconcile)));
  return { reconciled, matched };
}

registerRecordCompute("account.payment", {
  // account_payment.py:550-552 (unchanged) and account_payment account_payment.py:107-112 (the transaction's reference)
  transaction_uuid: async (_env, rec) => {
    const tx = await rec.rel("payment_transaction_id");
    return tx ? (await tx.get("provider_reference")) || false : rec.prev("transaction_uuid");
  },
  // account_payment.py:520-548 _compute_reconciliation_status on records without journal entry (new ones); saved
  // payments with lines are not ported
  is_reconciled: async (env, rec) => {
    if (!(await rec.get("outstanding_account_id"))) return false;
    if (!(await rec.get("currency_id")) || rec.id === null || !(await rec.get("move_id"))) return false;
    return (await reconciliationStatus(env, rec)).reconciled;
  },
  is_matched: async (env, rec) => {
    if (!(await rec.get("outstanding_account_id"))) return (await rec.get("state")) === "reconciled";
    if (!(await rec.get("currency_id")) || rec.id === null || !(await rec.get("move_id"))) return false;
    return (await reconciliationStatus(env, rec)).matched;
  },
});

defineComputes("account.payment", {
  // account_payment.py:651-657 with account_journal.py:1243-1258: the journal's inbound/outbound method lines
  // (one2many with domain payment_type, order sequence, id); no code is excluded without an override
  available_payment_method_line_ids: async (env, rec) => {
    const journal = await rec.get("journal_id");
    if (typeof journal !== "number" || !journal) return [];
    const type = (await rec.get("payment_type")) === "inbound" ? "inbound" : "outbound";
    return env.model("account.payment.method.line").search(and([cond("journal_id", "=", journal), cond("payment_type", "=", type)]),
      { order: "sequence, id" });
  },
});
registerRecordCompute("account.payment", {
  // account_payment.py:686-689 _compute_outstanding_account_id (stored)
  outstanding_account_id: async (_env, rec) => {
    const line = await rec.rel("payment_method_line_id");
    return line ? (await line.get("payment_account_id")) || null : null;
  },
});

/** account_payment.py:604-616 _compute_available_partner_bank_ids: [company banks, partner banks] by payment type. */
async function paymentBanks(rec: Rec): Promise<{ available: number[]; ret: number[] }> {
  const journal = await rec.rel("journal_id");
  const companyBank = journal ? await journal.get("bank_account_id") : null;
  const companyBanks = typeof companyBank === "number" && companyBank ? [companyBank] : [];
  const company = await rec.get("company_id");
  const partner = await rec.rel("commercial_partner_id");
  const partnerBanks: number[] = [];
  for (const b of partner ? await partner.rels("bank_ids") : []) {
    const bc = await b.get("company_id");
    if ((!bc || bc === company) && b.origin !== null) partnerBanks.push(b.origin);
  }
  return (await rec.get("payment_type")) === "inbound" ? { available: companyBanks, ret: partnerBanks } : { available: partnerBanks, ret: companyBanks };
}
defineComputes("account.payment", {
  available_partner_bank_ids: async (_env, rec) => (await paymentBanks(rec)).available,
  available_return_partner_bank_ids: async (_env, rec) => (await paymentBanks(rec)).ret,
});
registerRecordCompute("account.payment", {
  // account_payment.py:631-649 _compute_payment_method_line_id (stored)
  payment_method_line_id: async (env, rec) => {
    const available = (await rec.get("available_payment_method_line_ids")) as number[] | null ?? [];
    const partner = await rec.rel("commercial_partner_id");
    const type = await rec.get("payment_type");
    const inbound = partner ? await partner.get("property_inbound_payment_method_line_id") : null;
    const outbound = partner ? await partner.get("property_outbound_payment_method_line_id") : null;
    if (type === "inbound" && typeof inbound === "number" && available.includes(inbound)) return inbound;
    if (type === "outbound" && typeof outbound === "number" && available.includes(outbound)) return outbound;
    const current = await rec.prev("payment_method_line_id");
    if (typeof current === "number" && available.includes(current)) return current;
    void env;
    return available[0] ?? null;
  },
});

/** account_payment.py:742-845 _compute_stat_buttons_from_reconciliation for one payment. */
async function paymentStats(env: Environment, rec: Rec): Promise<{ invoices: number[]; bills: number[]; statements: number[]; type: string | false }> {
  if (rec.id === null) return { invoices: [], bills: [], statements: [], type: false };
  const invoices: number[] = [], bills: number[] = [];
  const typeOf = new Map<number, string>();
  for (const m of await rec.rels("invoice_ids")) {
    if (m.origin === null) continue;
    const t = String(await m.get("move_type"));
    typeOf.set(m.origin, t);
    if (SALE_R.includes(t)) invoices.push(m.origin); else if (PURCHASE_R.includes(t)) bills.push(m.origin);
  }
  const rows = (await env.cr.query<{ ids: number[]; move_type: string }>(
    `SELECT ARRAY_AGG(DISTINCT invoice.id) AS ids, invoice.move_type
       FROM account_payment payment
       JOIN account_move move ON move.id = payment.move_id
       JOIN account_move_line line ON line.move_id = move.id
       JOIN account_partial_reconcile part ON part.debit_move_id = line.id OR part.credit_move_id = line.id
       JOIN account_move_line counterpart_line ON part.debit_move_id = counterpart_line.id OR part.credit_move_id = counterpart_line.id
       JOIN account_move invoice ON invoice.id = counterpart_line.move_id
       JOIN account_account account ON account.id = line.account_id
      WHERE account.account_type IN ('asset_receivable', 'liability_payable') AND payment.id = $1 AND line.id != counterpart_line.id
        AND invoice.move_type IN ('out_invoice', 'out_refund', 'in_invoice', 'in_refund', 'out_receipt', 'in_receipt')
      GROUP BY payment.id, invoice.move_type`, [rec.id])).rows;
  for (const r of rows) {
    const target = SALE_R.includes(r.move_type) ? invoices : bills;
    for (const id of r.ids) { typeOf.set(id, r.move_type); if (!target.includes(id)) target.push(id); }
  }
  const st = (await env.cr.query<{ ids: number[] }>(
    `SELECT ARRAY_AGG(DISTINCT counterpart_line.statement_line_id) AS ids
       FROM account_payment payment
       JOIN account_move move ON move.id = payment.move_id
       JOIN account_move_line line ON line.move_id = move.id
       JOIN account_account account ON account.id = line.account_id
       JOIN account_partial_reconcile part ON part.debit_move_id = line.id OR part.credit_move_id = line.id
       JOIN account_move_line counterpart_line ON part.debit_move_id = counterpart_line.id OR part.credit_move_id = counterpart_line.id
      WHERE account.id = payment.outstanding_account_id AND payment.id = $1 AND line.id != counterpart_line.id
        AND counterpart_line.statement_line_id IS NOT NULL
      GROUP BY payment.id`, [rec.id])).rows[0];
  const types = new Set(invoices.map((id) => typeOf.get(id)));
  const type = types.size === 1 && typeOf.get(invoices[0]!) === "out_refund" ? "credit_note" : "invoice";
  return { invoices, bills, statements: st?.ids ?? [], type };
}
defineComputes("account.payment", {
  reconciled_invoice_ids: async (env, rec) => (await paymentStats(env, rec)).invoices,
  reconciled_invoices_count: async (env, rec) => (await paymentStats(env, rec)).invoices.length,
  reconciled_bill_ids: async (env, rec) => (await paymentStats(env, rec)).bills,
  reconciled_bills_count: async (env, rec) => (await paymentStats(env, rec)).bills.length,
  reconciled_statement_line_ids: async (env, rec) => (await paymentStats(env, rec)).statements,
  reconciled_statement_lines_count: async (env, rec) => (await paymentStats(env, rec)).statements.length,
  reconciled_invoices_type: async (env, rec) => (await paymentStats(env, rec)).type,
});
registerRecordCompute("account.payment", {
  // account_payment.py:468-487 _compute_journal_id (stored): a new payment takes its partner's default method line's
  // journal, else a bank/cash/credit journal of the company when the current one does not fit
  journal_id: async (env, rec) => {
    const partner = await rec.rel("commercial_partner_id");
    const type = await rec.get("payment_type");
    const ptype = type === "inbound" || type === "outbound" ? type : null;
    const companyField = await rec.get("company_id");
    if (rec.id === null && rec.origin === null && (partner || ptype)) {
      if (partner && ptype) {
        const cenv = typeof companyField === "number" && companyField ? await withCompanyEnv(env, companyField) : env;
        const line = await new DbRec(cenv, env.reg.model("res.partner"), partner.origin!).rel(`property_${ptype}_payment_method_line_id`);
        const journal = line ? await line.get("journal_id") : null;
        if (journal) return journal;
      } else if (!ptype) throw new NotPorted("account.payment.journal_id without a payment type (property_None_payment_method_line_id)");
    }
    const company = typeof companyField === "number" && companyField ? companyField : await env.company();
    const current = await rec.prev("journal_id");
    if (typeof current === "number" && current) {
      const jc = (await env.cr.query<{ c: number }>("SELECT company_id AS c FROM account_journal WHERE id = $1", [current])).rows[0]?.c;
      if (jc === company) return current;
    }
    const found = await env.model("account.journal").search(and([cond("company_id", "in", [company, false]), cond("type", "in", ["bank", "cash", "credit"])]), { limit: 1 });
    return found[0] ?? null;
  },
  // account_payment.py:489-493 _compute_company_id (stored, with res_company.py:484-504 _accessible_branches for
  // a company without branches)
  company_id: async (env, rec) => {
    const journal = await rec.rel("journal_id");
    const jc = journal ? await journal.get("company_id") : null;
    const current = await rec.prev("company_id");
    if (typeof jc === "number" && jc && typeof current === "number" && current) {
      const path = (await env.cr.query<{ p: string }>("SELECT parent_path AS p FROM res_company WHERE id = $1", [current])).rows[0]?.p ?? "";
      if (path.split("/").includes(String(jc))) return current;
    }
    const base = typeof jc === "number" && jc ? jc : await env.company();
    if ((await env.cr.query("SELECT 1 FROM res_company WHERE parent_id = $1", [base])).rows.length) throw new NotPorted("account.payment.company_id of a company with branches (_accessible_branches)");
    return base;
  },
  // account_payment.py:451-461 _compute_name (stored): the journal entry's number once paid
  name: async (env, rec) => {
    const current = await rec.prev("name");
    if (rec.id === null || !["paid", "reconciled"].includes(String(await rec.get("state")))) return current;
    const move = await rec.rel("move_id");
    const moveName = move ? await move.get("name") : false;
    if (current && !(move && current !== moveName)) return current;
    if (moveName) return moveName;
    // :455-460 next_by_code('account.payment', sequence_date=payment.date) in the payment's company
    return (await nextByCode(await withCompanyEnv(env, Number(await rec.get("company_id"))), "account.payment")) || null;
  },
  // account_payment.py:681-684 _compute_currency_id (stored)
  currency_id: async (_env, rec) => {
    const journal = await rec.rel("journal_id");
    if (!journal) return null;
    const own = await journal.get("currency_id");
    if (own) return own;
    const company = await journal.rel("company_id");
    return company ? (await company.get("currency_id")) || null : null;
  },
});

defineComputes("account.payment", {
  // account_payment.py:659-674 _compute_available_journal_ids: bank/cash/credit journals of the company tree having
  // method lines of the payment's direction
  available_journal_ids: async (env, rec) => {
    const company = await env.company();
    const journals = await env.model("account.journal").search(and([
      or([cond("company_id", "parent_of", [company]), cond("company_id", "child_of", [company])]),
      cond("type", "in", ["bank", "cash", "credit"]),
    ]));
    const field = (await rec.get("payment_type")) === "inbound" ? "inbound_payment_method_line_ids" : "outbound_payment_method_line_ids";
    const out: number[] = [];
    for (const j of journals) if (((await new DbRec(env, env.reg.model("account.journal"), j).get(field)) as unknown[] | null ?? []).length) out.push(j);
    return out;
  },
});

registerRecordCompute("account.tax.repartition.line", {
  // account_tax.py _compute_use_in_tax_closing (stored)
  use_in_tax_closing: async (_env, rec) => {
    if ((await rec.get("repartition_type")) !== "tax") return false;
    const account = await rec.rel("account_id");
    if (!account) return false;
    return !["income", "expense"].includes(String(await account.get("internal_group")));
  },
});

defineComputes("res.company", {
  // account company.py:592-596 _compute_has_ledger
  has_ledger: async (env) => (await env.model("account.journal.group").search(cond("id", "!=", 0), { limit: 1 })).length > 0,
});
defineComputes("account.account", {
  // account_account.py:691-694 with :707-708: the first part of the account type
  internal_group: async (_env, rec) => {
    const type = await rec.get("account_type");
    return type ? String(type).split("_")[0]! : false;
  },
});
registerRecordCompute("account.tax", {
  // account_tax.py:279-296 _compute_tax_group_id
  tax_group_id: async (env, rec) => {
    const current = await rec.prev("tax_group_id");
    const country = await rec.get("country_id"), company = await rec.get("company_id");
    if (typeof current === "number" && current) {
      const g = (await env.cr.query<{ c: number | null; co: number | null }>("SELECT company_id AS co, country_id AS c FROM account_tax_group WHERE id = $1", [current])).rows[0];
      if (g && g.c === (country || null) && g.co === (company || null)) return current;
    }
    if (typeof company !== "number" || !company) throw new NotPorted("account.tax.tax_group_id without a company");
    const path = ((await env.cr.query<{ p: string }>("SELECT parent_path AS p FROM res_company WHERE id = $1", [company])).rows[0]?.p ?? "").split("/").filter(Boolean).map(Number);
    const found = await env.model("account.tax.group").search(and([cond("company_id", "in", path), cond("country_id", "=", country || false)]), { limit: 1 });
    if (found[0]) return found[0];
    return (await env.model("account.tax.group").search(and([cond("company_id", "in", path), cond("country_id", "=", false)]), { limit: 1 }))[0] ?? null;
  },
});

async function availableInvoiceReports(env: Environment): Promise<number[]> {
  const rows = (await env.cr.query<{ id: number; domain: string | null }>("SELECT id, domain FROM ir_act_report_xml WHERE model = 'account.move' AND is_invoice_report ORDER BY id")).rows;
  if (rows.some((r) => r.domain && r.domain !== "[]")) throw new NotPorted("invoice report with a domain (filtered_domain on new moves)");
  if (!rows.length) throw new NotPorted("no invoice report");
  return rows.map((r) => r.id);
}

registerHooks("account.move.line", {
  // account_move_line.py:2393-2395 `_compute_display_name` with :2373-2390 `_format_aml_name(line.name or
  // line.product_id.display_name, line.ref, line.move_id.name)`
  displayName: async (env, ids) => {
    const rows = (await env.cr.query<{ id: number; name: string | null; ref: string | null; move: string | null; product: number | null }>(
      `SELECT l.id, l.name, l.ref, m.name AS move, l.product_id AS product
         FROM account_move_line l LEFT JOIN account_move m ON m.id = l.move_id WHERE l.id = ANY($1::int[])`, [[...ids]])).rows;
    const products = [...new Set(rows.filter((r) => !r.name && r.product).map((r) => r.product!))];
    const productNames = products.length ? await env.model("product.product").displayName(products) : new Map<number, string>();
    const out = new Map<number, string>();
    for (const r of rows) {
      const lineName = r.name || (r.product ? productNames.get(r.product) ?? "" : "");
      const names: string[] = [];
      if (r.move && r.move !== "/") names.push(r.move);
      if (r.ref && r.ref !== "/") names.push(`(${r.ref})`);
      if (lineName && !["/", r.move, `${r.ref} - ${r.move}`, r.ref].includes(lineName)) names.push(lineName);
      out.set(r.id, names.join(" ") || translate(env, "Draft Entry"));
    }
    return out;
  },
  // account_move_line.py:1121-1141 _compute_sql_residual_at_date / _currency_at_date without `recon_limit`
  computeSql: {
    residual_at_date: async (table) => table.field("amount_residual"),
    residual_currency_at_date: async (table) => table.field("amount_residual_currency"),
  },
});
/** account_account.py:418-448 `_compute_sql_field_path` on the root company's codes. */
async function accountPath(table: Parameters<NonNullable<NonNullable<ReturnType<typeof hooksOf>["computeSql"]>[string]>>[0], which: "code" | "name"): Promise<Sql> {
  const env = table.env;
  const root = (await env.cr.query<{ r: number }>("SELECT split_part(parent_path, '/', 1)::int AS r FROM res_company WHERE id = $1", [await env.company()])).rows[0]!.r;
  const path = await table.field("parent_path");
  const code = String(root), lang = env.lang ?? "en_US";
  const value = which === "code"
    ? sql`CASE WHEN COUNT(anc.code_store->>${code}) = COUNT(anc.id) THEN STRING_AGG(anc.code_store->>${code}, ' / ' ORDER BY t.ord) END`
    : sql`STRING_AGG(COALESCE(anc.name->>${lang}, anc.name->>'en_US'), ' / ' ORDER BY t.ord)`;
  return sql`(SELECT ${value} FROM UNNEST(STRING_TO_ARRAY(RTRIM(${path}, '/'), '/')) WITH ORDINALITY AS t(id, ord) JOIN account_account anc ON anc.id = t.id::int)`;
}
registerHooks("account.account", {
  computeSql: { code_path: async (table) => accountPath(table, "code"), name_path: async (table) => accountPath(table, "name") },
});
// base res_currency.py:443-452 `_sanitize_vals` of rates
function sanitizeRate(vals: Record<string, unknown>): Record<string, unknown> {
  const out = { ...vals };
  if ("inverse_company_rate" in out && ("company_rate" in out || "rate" in out)) delete out["inverse_company_rate"];
  if ("company_rate" in out && "rate" in out) delete out["company_rate"];
  return out;
}
registerOverrides("res.currency.rate", {
  create: async (env, valsList, next) => next(env, valsList.map(sanitizeRate)),
  write: async (env, ids, vals, next) => next(env, ids, sanitizeRate(vals)),
});

/**
 * base res_currency.py:111-127 `_toggle_group_multi_currency` with product res_currency.py:10-16 and product res_company.py:15-34
 * `_activate_or_create_pricelists`; removing the group again (one active currency left) is not ported.
 */
async function toggleMultiCurrency(env: Environment, excluded: readonly number[] = []): Promise<void> {
  const active = (await env.cr.query<{ n: number }>("SELECT count(*)::int AS n FROM res_currency WHERE active AND NOT (id = ANY($1::int[]))", [[...excluded]])).rows[0]!.n;
  const su = env.sudo();
  const ref = async (name: string): Promise<number> => (await env.cr.query<{ id: number }>("SELECT res_id AS id FROM ir_model_data WHERE module = $1 AND name = $2", name.split("."))).rows[0]!.id;
  const groupUser = await ref("base.group_user"), multi = await ref("base.group_multi_currency"), pricelist = await ref("product.group_product_pricelist");
  const implied = async (hid: number): Promise<boolean> => (await env.cr.query(
    `WITH RECURSIVE g(id) AS (SELECT hid FROM res_groups_implied_rel WHERE gid = $1 UNION SELECT r.hid FROM res_groups_implied_rel r JOIN g ON g.id = r.gid) SELECT 1 FROM g WHERE id = $2 LIMIT 1`, [groupUser, hid])).rows.length > 0;
  if (active <= 1) {
    if (await implied(multi)) throw new NotPorted("removing base.group_multi_currency (_deactivate_group_multi_currency)");
    return;
  }
  if (!(await implied(multi))) {
    await write(su, "res.groups", [groupUser], { implied_ids: [[4, multi]] });
    env.cache.delete("orm.users");
  }
  if (await hasGroup(env, "product.group_product_pricelist")) return;
  if (!(await implied(pricelist))) {
    await write(su, "res.groups", [groupUser], { implied_ids: [[4, pricelist]] });
    // `_apply_group` writes implied_ids, which clears the 'groups' ormcache (res_groups.py): the request's users again
    env.cache.delete("orm.users");
  }
  await activateOrCreatePricelists(env);
}

/** product res_company.py:15-34 `_activate_or_create_pricelists` for every company (`self` empty). */
export async function activateOrCreatePricelists(env: Environment): Promise<void> {
  if (env.context["disable_company_pricelist_creation"]) return;
  if (!(await hasGroup(env, "product.group_product_pricelist"))) return;
  const su = env.sudo();
  const companies = await su.model("res.company").search(cond("id", "!=", 0));
  const lists = (await env.cr.query<{ company_id: number; active: boolean }>(
    `SELECT p.company_id, p.active FROM product_pricelist p JOIN res_company c ON c.id = p.company_id
      WHERE c.currency_id = p.currency_id AND NOT EXISTS (SELECT 1 FROM product_pricelist_item i WHERE i.pricelist_id = p.id)`)).rows;
  if (lists.some((l) => !l.active)) throw new NotPorted("archived default pricelists (action_unarchive)");
  const covered = new Set(lists.map((l) => l.company_id));
  const vals: Record<string, unknown>[] = [];
  for (const c of companies) {
    if (covered.has(c)) continue;
    const currency = (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [c])).rows[0]!.c;
    vals.push({ name: translate(env, "Default"), currency_id: currency, company_id: c, sequence: 10 });
  }
  if (vals.length) await create(su, "product.pricelist", vals);
}
registerOverrides("res.currency", {
  create: async (env, valsList, next) => { const ids = await next(env, valsList); await toggleMultiCurrency(env); return ids; },
  write: async (env, ids, vals, next) => { await next(env, ids, vals); if ("active" in vals) await toggleMultiCurrency(env); },
  beforeUnlink: async (env, ids) => { await toggleMultiCurrency(env, ids); },
});

// base res_currency.py:335-342 get_all_currencies
registerMethod("res.currency", "get_all_currencies", async (env0) => {
  const rows = (await env0.cr.query<{ id: number; name: string; symbol: string; position: string; decimal_places: number }>(
    "SELECT id, name, symbol, position, decimal_places FROM res_currency WHERE active ORDER BY id")).rows;
  return Object.fromEntries(rows.map((c) => [String(c.id), { name: c.name, symbol: c.symbol, position: c.position, digits: [69, c.decimal_places] }]));
}, { apiModel: true });

// account/models/account_tax.py:438-454 the default repartition lines of a new tax: stored computes in Odoo, run at
// the recompute after every record's repartition_line_ids commands, the invoice field then the refund field (a batch
// of taxes, a chart template's: the "Out of Scope" tax with invoice lines only gets its refund lines last)
registerDefaults("account.tax", {
  invoice_repartition_line_ids: repartitionLines("invoice"),
  refund_repartition_line_ids: repartitionLines("refund"),
});
registerComputedX2manyLast("account.tax", ["invoice_repartition_line_ids", "refund_repartition_line_ids"]);
registerRecordCompute("account.fiscal.position", {
  // account/models/partner.py:81-84 _compute_is_domestic (stored)
  is_domestic: async (_env, rec) => {
    const company = await rec.rel("company_id");
    return Boolean(company && rec.origin !== null && (await company.get("domestic_fiscal_position_id")) === rec.origin);
  },
});
// account/models/partner.py:293-309 action_open_related_taxes
registerMethod("account.fiscal.position", "action_open_related_taxes", async (env, ids) => {
  if (ids?.length !== 1) throw new NotPorted("action_open_related_taxes on several positions");
  const rec = new DbRec(env, env.reg.model("account.fiscal.position"), ids[0]!);
  const view = (await env.cr.query<{ id: number }>("SELECT res_id AS id FROM ir_model_data WHERE module = 'account' AND name = 'account_tax_fiscal_position_view_tree'")).rows[0]?.id ?? false;
  const company = Number(await rec.get("company_id"));
  // orm models.py check_company_domain_parent_of: the company's parents and False
  const path = [...((await env.cr.query<{ p: string }>("SELECT parent_path AS p FROM res_company WHERE id = $1", [company])).rows[0]?.p ?? "").split("/").filter(Boolean).map(Number), false];
  return {
    type: "ir.actions.act_window", name: translate(env, "%s taxes").replace("%s", String(await rec.get("display_name"))), res_model: "account.tax",
    views: [[view, "list"], [false, "form"]],
    domain: [["company_id", "in", path], "|", ["id", "in", (await rec.get("tax_ids")) as number[]], ["fiscal_position_ids", "=", false]],
    context: { active_test: false },
  };
}, { apiModel: false });

defineComputes("account.journal", {
  // account_journal.py:393-449 _compute_available_payment_method_ids with account_payment_method.py:65-81: 'manual' is
  // the only method without an electronic provider code in the database
  available_payment_method_ids: async (env, rec) => {
    const type = String(await rec.get("type"));
    if (!["bank", "cash", "credit"].includes(type)) return [];
    const codes = (env.reg.model("payment.provider").fields.get("code")?.selection ?? []).map((s) => s.value).filter((c) => c !== "none" && c !== "custom");
    if (codes.length) throw new NotPorted("account.journal.available_payment_method_ids with electronic payment methods");
    return (await env.cr.query<{ id: number }>("SELECT id FROM account_payment_method WHERE code = 'manual' ORDER BY id")).rows.map((r) => r.id);
  },
  // account_journal.py:726-732 with account_move.py:7745-7759 and :7242-7254 `_get_available_action_reports`
  available_invoice_template_pdf_report_ids: async (env) => availableInvoiceReports(env),
  display_invoice_template_pdf_report_id: async (env) => (await availableInvoiceReports(env)).length > 1,
  // account_journal.py:310-311 _compute_display_alias_fields
  display_alias_fields: async (env) => (await env.cr.query("SELECT 1 FROM mail_alias_domain LIMIT 1")).rows.length > 0,
  // account_journal.py:500-508 _compute_selected_payment_method_codes
  selected_payment_method_codes: async (_env, rec) => {
    const codes: string[] = [];
    for (const f of ["inbound_payment_method_line_ids", "outbound_payment_method_line_ids"]) {
      for (const line of await rec.rels(f)) { const c = await line.get("code"); if (c) codes.push(String(c)); }
    }
    return `,${codes.join(",")},`;
  },
  // account_journal.py:451-462 _compute_default_account_type
  default_account_type: async (_env, rec) => ({ bank: "asset_cash", cash: "asset_cash", sale: "income%", purchase: "expense%", credit: "liability_credit_card" } as Record<string, string>)[String(await rec.get("type"))] ?? "%",
});
// account_journal.py:1058-1074 create needs `_fill_missing_values` (default accounts, aliases) and the payment method lines
registerRecordCompute("account.journal", {
  // account_journal.py:721-724 _compute_payment_sequence (stored)
  payment_sequence: async (_env, rec) => ["bank", "cash", "credit"].includes(String(await rec.get("type"))),
  // account_journal.py:716-719 _compute_refund_sequence (stored)
  refund_sequence: async (_env, rec) => ["sale", "purchase"].includes(String(await rec.get("type"))),
});
defineComputes("payment.provider", {
  // payment_provider.py:312-319 _compute_token_count (as the user)
  token_count: async (env, rec) => (rec.id === null ? 0 : env.model("payment.token").searchCount(cond("provider_id", "in", [rec.id]))),
});

// web ir_http.py:82-85 + account ir_http.py:8-11 `lazy_session_info` (hr_attendance's extension refuses)
registerMethod("ir.http", "lazy_session_info", async (env0) => {
  const env = env0.sudo();
  if (await isInstalled(env.cr, "hr_attendance")) throw new NotPorted("ir.http.lazy_session_info with hr_attendance");
  const demo = await env.model("ir.module.module").searchCount(cond("demo", "=", true));
  const res: Record<string, unknown> = { is_demo: demo > 0 };
  if (await isInstalled(env.cr, "account")) {
    const v = await configParam(env, "account.show_sale_receipts");
    res["show_sale_receipts"] = v !== null && str2bool(v, false);
  }
  return res;
}, { apiModel: true, readonly: true });
