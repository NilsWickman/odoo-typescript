/**
 * The Accounting / Invoicing dashboard's journal cards (account/models/account_journal_dashboard.py): the computed
 * fields `kanban_dashboard` (:64-67 `_kanban_dashboard` over :574-591 `_get_journal_dashboard_data_batched` and the
 * `_fill_*_dashboard_data` methods), `kanban_dashboard_graph` (:69-87, the bank/cash graph :453-512 and the
 * sale/purchase graph :514-572) and the helper computes they read (`has_entries`, `has_posted_entries`,
 * `has_sequence_holes`, `has_unhashed_entries`, `current_statement_balance`, `has_statement_lines`,
 * `last_statement_id`, account_journal.py `has_invalid_statements`) and the KPI cards above the journals
 * (`get_account_dashboard_kpis` :183-260, companies of one currency only).
 *
 * Every query is Odoo's own SQL (or the SQL of its `_read_group`/`_search`, with `_check_company_domain` of the
 * models: `company_id in env.companies + [False]`). Refused: amounts in another currency than the journal's
 * (`_convert`), hashed journals (`_get_chains_to_hash`), a just-done onboarding step (its consolidation writes)
 * and the modules that extend the batch
 * (account_check_printing, hr_expense, l10n_es_edi_verifactu, l10n_in_edi, l10n_fr_pdp, l10n_pk).
 */
import { AccessError, NotPorted, OdooError, UserError } from "../errors";
import { registerMethod } from "../http/methods";
import { isInstalled } from "../http/modules";
import * as D from "../orm/domain";
import { envTz, hasGroup } from "../orm/env";
import { registerHooks } from "../orm/hooks";
import { ident, runSql, searchQuery, sql } from "../orm/sql";
import type { Environment } from "../orm/types";
import { pyFloat } from "../orm/values";
import { jsonDumps } from "../pyexpr";
import { envFor } from "../web/common";
import { cldrLocale, weekNumber } from "../web/labels";
import { langNumber } from "../mail/tracking";
import "../web/cldr";
import { roundPrecision } from "./account_tax_engine";
import { formatAmount } from "./account_taxes";
import { fiscalYear } from "./fiscal_year";
import { openCompanyPeppolForm } from "./peppol_registration";
import { getLang } from "./tail_util";
import { dbNow, langOf, todayInTz, translate, translatedSql } from "./util";

type Row = Record<string, unknown>;
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const DATE_MIN = "0001-01-01";

/** Modules whose overrides of the batch the port does not have. */
const EXTENDING_MODULES = ["account_check_printing", "hr_expense", "l10n_es_edi_verifactu", "l10n_in_edi", "l10n_fr_pdp", "l10n_pk"];

async function refuseExtensions(env: Environment): Promise<void> {
  for (const m of EXTENDING_MODULES) {
    if (await isInstalled(env.cr, m)) throw new NotPorted(`account.journal dashboard with ${m} installed (its override of the dashboard data)`);
  }
}

interface Currency { id: number; rounding: number }
interface Journal {
  id: number; type: string; companyId: number; currencyId: number | null; companyCurrencyId: number;
  companyName: string; defaultAccountId: number | null; bankStatementsSource: string | null;
  disableGraph: boolean; restrictHash: boolean; fiscalyearLockDate: string | null; countryCode: string | null;
}

async function journals(env: Environment, ids: readonly number[]): Promise<Journal[]> {
  const rows = (await env.cr.query<Row>(
    `SELECT j.id, j.type, j.company_id, j.currency_id, c.currency_id AS company_currency_id, c.name AS company_name,
            j.default_account_id, j.bank_statements_source, j.disable_dashboard_graph, j.restrict_mode_hash_table,
            to_char(c.fiscalyear_lock_date, 'YYYY-MM-DD') AS fiscalyear_lock_date, country.code AS country_code
       FROM account_journal j
       JOIN res_company c ON c.id = j.company_id
  LEFT JOIN res_country country ON country.id = c.account_fiscal_country_id
      WHERE j.id = ANY($1::int[])`, [[...ids]])).rows;
  const byId = new Map(rows.map((r) => [Number(r["id"]), r]));
  return ids.filter((id) => byId.has(id)).map((id) => {
    const r = byId.get(id)!;
    return {
      id, type: String(r["type"]), companyId: Number(r["company_id"]),
      currencyId: r["currency_id"] === null ? null : Number(r["currency_id"]), companyCurrencyId: Number(r["company_currency_id"]),
      companyName: String(r["company_name"] ?? ""), defaultAccountId: r["default_account_id"] === null ? null : Number(r["default_account_id"]),
      bankStatementsSource: (r["bank_statements_source"] as string | null) ?? null, disableGraph: Boolean(r["disable_dashboard_graph"]),
      restrictHash: Boolean(r["restrict_mode_hash_table"]), fiscalyearLockDate: (r["fiscalyear_lock_date"] as string | null) ?? null,
      countryCode: (r["country_code"] as string | null) ?? null,
    };
  });
}

const currencies = new WeakMap<Environment, Map<number, Currency>>();
async function currency(env: Environment, id: number): Promise<Currency> {
  let cache = currencies.get(env);
  if (!cache) currencies.set(env, cache = new Map());
  const hit = cache.get(id);
  if (hit) return hit;
  const row = (await env.cr.query<{ rounding: string }>("SELECT rounding::text AS rounding FROM res_currency WHERE id = $1", [id])).rows[0];
  if (!row) throw new NotPorted(`res.currency ${id}`);
  const c = { id, rounding: Number(row.rounding) };
  cache.set(id, c);
  return c;
}

/** `journal.currency_id or journal.company_id.sudo().currency_id`. */
function currencyOf(env: Environment, j: Journal): Promise<Currency> {
  return currency(env, j.currencyId ?? j.companyCurrencyId);
}

async function contextToday(env: Environment): Promise<string> {
  return todayInTz(await dbNow(env), await envTz(env));
}

/** account_journal_dashboard.py:1374-1401 `_count_results_and_sum_amounts`. */
async function countAndSum(env: Environment, rows: readonly Row[], target: Currency): Promise<[number, number]> {
  if (!rows.length) return [0, 0];
  let total = 0;
  let count = 0;
  const company = await env.company();
  for (const r of rows) {
    const docCompany = r["company_id"] === null || r["company_id"] === undefined ? company : Number(r["company_id"]);
    count += r["count"] === undefined ? 1 : num(r["count"]);
    const companyCurrency = (await env.cr.query<{ currency_id: number }>("SELECT currency_id FROM res_company WHERE id = $1", [docCompany])).rows[0]?.currency_id;
    if (companyCurrency === target.id) total += num(r["amount_total_company"]);
    else throw new NotPorted("account.journal dashboard: amounts of another company currency (res.currency._convert)");
  }
  return [count, roundPrecision(total, target.rounding)];
}

const groupByJournal = (rows: readonly Row[]): Map<number, Row[]> => {
  const out = new Map<number, Row[]>();
  for (const r of rows) {
    const k = Number(r["journal_id"]);
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push(r);
  }
  return out;
};

/** `currency.format(amount)` (res_currency.py:275-284, misc.py format_amount). */
const fmt = (env: Environment, amount: number, c: Currency): Promise<string> => formatAmount(env, amount + 0.0, c.id);

const INVOICE_TYPES = ["out_invoice", "out_refund", "in_invoice", "in_refund", "out_receipt", "in_receipt"];

// ---------------------------------------------------------------------------------------------------------------
// helper computes
// ---------------------------------------------------------------------------------------------------------------

/** :1002-1046 `_get_journal_dashboard_bank_running_balance`: (has_statement_lines, current_statement_balance). */
async function runningBalance(env: Environment, ids: readonly number[]): Promise<Map<number, [boolean, number]>> {
  const companies = [...await env.companies()];
  const rows = (await env.cr.query<Row>(
    `SELECT journal.id AS journal_id, statement.id AS statement_id,
            COALESCE(statement.balance_end_real, 0)::text AS balance_end_real,
            without_statement.amount::text AS unlinked_amount, without_statement.count::int AS unlinked_count,
            journal.currency_id, cur.rounding::text AS rounding
       FROM account_journal journal
  LEFT JOIN res_currency cur ON cur.id = journal.currency_id
  LEFT JOIN LATERAL (
              SELECT id, first_line_index, balance_end_real
                FROM account_bank_statement
               WHERE journal_id = journal.id AND company_id = ANY($1::int[]) AND first_line_index IS NOT NULL
            ORDER BY date DESC, id DESC
               LIMIT 1
            ) statement ON TRUE
  LEFT JOIN LATERAL (
              SELECT COALESCE(SUM(stl.amount), 0.0) AS amount, COUNT(*)
                FROM account_bank_statement_line stl
                JOIN account_move move ON move.id = stl.move_id
               WHERE stl.statement_id IS NULL AND move.state != 'cancel' AND stl.journal_id = journal.id
                 AND stl.company_id = ANY($1::int[]) AND stl.internal_index >= COALESCE(statement.first_line_index, '')
               LIMIT 1
            ) without_statement ON TRUE
      WHERE journal.id = ANY($2::int[])`, [companies, [...ids]])).rows;
  const out = new Map<number, [boolean, number]>();
  for (const r of rows) {
    let balance = num(r["balance_end_real"]) + num(r["unlinked_amount"]);
    // fields_numeric.py Monetary.convert_to_cache: rounded to the record's currency (the journal's), when it has one
    if (r["rounding"] !== null) balance = roundPrecision(balance, Number(r["rounding"]));
    out.set(Number(r["journal_id"]), [Boolean(r["statement_id"] !== null || num(r["unlinked_count"])), balance]);
  }
  return out;
}

/** :45-62 `_compute_last_bank_statement`: the statement id, its date and balance_end_real. */
async function lastStatements(env: Environment, ids: readonly number[]): Promise<Map<number, { id: number; date: string | null; balanceEndReal: number }>> {
  const rows = (await env.cr.query<Row>(
    `SELECT journal.id AS journal_id, statement.id AS statement_id, to_char(statement.date, 'YYYY-MM-DD') AS date,
            statement.balance_end_real::text AS balance_end_real
       FROM account_journal journal
       JOIN LATERAL (
              SELECT id, company_id, date, balance_end_real FROM account_bank_statement
               WHERE journal_id = journal.id AND first_line_index IS NOT NULL
            ORDER BY first_line_index DESC LIMIT 1
            ) statement ON TRUE
      WHERE journal.id = ANY($1::int[]) AND statement.company_id = ANY($2::int[])`, [[...ids], [...await env.companies()]])).rows;
  return new Map(rows.map((r) => [Number(r["journal_id"]), {
    id: Number(r["statement_id"]), date: (r["date"] as string | null) ?? null, balanceEndReal: num(r["balance_end_real"]),
  }]));
}

/** :399-426 `_compute_has_entries`: (has_posted_entries, has_entries). */
async function hasEntries(env: Environment, ids: readonly number[]): Promise<Map<number, [boolean, boolean]>> {
  if (!ids.length) return new Map();
  const rows = (await env.cr.query<Row>(
    `SELECT j.id,
            EXISTS(SELECT 1 FROM account_move m WHERE m.journal_id = j.id AND m.state = 'posted') AS posted,
            EXISTS(SELECT 1 FROM account_move m WHERE m.journal_id = j.id) AS any
       FROM account_journal j WHERE j.id = ANY($1::int[])`, [[...ids]])).rows;
  return new Map(rows.map((r) => [Number(r["id"]), [Boolean(r["posted"]), Boolean(r["any"])]]));
}

/** company.py:784-796 `_get_user_fiscal_lock_date(journal, ignore_exceptions=True)` (:749-782 over the parents). */
async function userFiscalLockDate(env: Environment, j: Journal): Promise<string> {
  const row = (await env.cr.query<Row>(
    `SELECT to_char(GREATEST(MAX(fiscalyear_lock_date), MAX(hard_lock_date),
                             MAX(CASE WHEN $2 = 'sale' THEN sale_lock_date WHEN $2 = 'purchase' THEN purchase_lock_date END)), 'YYYY-MM-DD') AS d
       FROM res_company WHERE id::text = ANY(string_to_array((SELECT parent_path FROM res_company WHERE id = $1), '/'))`,
    [j.companyId, j.type])).rows[0];
  return (row?.["d"] as string | null) ?? DATE_MIN;
}

/** :345-375 `_query_has_sequence_holes`: the (journal, sequence prefix) pairs, in the query's order. */
async function sequenceHolePairs(env: Environment, js: readonly Journal[]): Promise<[number, string | null][]> {
  const out: [number, string | null][] = [];
  const byLock = new Map<string, Journal[]>();
  for (const j of js) {
    const lock = await userFiscalLockDate(env, j);
    if (!byLock.has(lock)) byLock.set(lock, []);
    byLock.get(lock)!.push(j);
  }
  for (const [lock, group] of byLock) {
    const rows = (await env.cr.query<{ journal_id: number; sequence_prefix: string | null }>(
      `SELECT move.journal_id, move.sequence_prefix FROM account_move move
        WHERE move.journal_id = ANY($1::int[])
          AND move.company_id IN (SELECT c.id FROM res_company c WHERE c.active AND EXISTS (
                SELECT 1 FROM res_company p WHERE p.id = ANY($2::int[]) AND c.parent_path LIKE p.parent_path || '%'))
          AND move.made_sequence_gap IS TRUE AND move.date > $3::date
     GROUP BY move.journal_id, move.sequence_prefix`,
      [group.map((j) => j.id), [...new Set(group.map((j) => j.companyId))], lock])).rows;
    for (const r of rows) out.push([Number(r.journal_id), r.sequence_prefix]);
  }
  return out;
}

/** :391-394 `_compute_has_sequence_holes`. */
async function sequenceHoles(env: Environment, js: readonly Journal[]): Promise<Set<number>> {
  return new Set((await sequenceHolePairs(env, js)).map(([j]) => j));
}

/** :396-401 `_compute_has_unhashed_entries`: only journals without the hash restriction. */
function unhashed(j: Journal): boolean {
  if (j.restrictHash) throw new NotPorted("account.journal has_unhashed_entries of a hashed journal (_get_chains_to_hash)");
  return false;
}

/** account_journal.py:300-308 `_compute_has_invalid_statements` (account_bank_statement.py:325-358, is_complete stored). */
async function invalidStatements(env: Environment, ids: readonly number[]): Promise<Set<number>> {
  const rows = (await env.cr.query<{ journal_id: number }>(
    `WITH statements AS (
       SELECT st.id, st.balance_start, st.journal_id,
              LAG(st.balance_end_real) OVER (PARTITION BY st.journal_id ORDER BY st.first_line_index) AS prev_balance_end_real,
              currency.decimal_places
         FROM account_bank_statement st
    LEFT JOIN res_company co ON st.company_id = co.id
    LEFT JOIN account_journal j ON st.journal_id = j.id
    LEFT JOIN res_currency currency ON COALESCE(j.currency_id, co.currency_id) = currency.id
        WHERE st.first_line_index IS NOT NULL
     ), invalid AS (
       SELECT id FROM statements
        WHERE prev_balance_end_real IS NOT NULL
          AND ROUND(prev_balance_end_real, decimal_places) != ROUND(balance_start, decimal_places)
     )
     SELECT DISTINCT st.journal_id FROM account_bank_statement st
      WHERE st.journal_id = ANY($1::int[]) AND st.company_id = ANY($2::int[])
        AND (st.id IN (SELECT id FROM invalid) OR st.is_complete IS NOT TRUE)`, [[...ids], [...await env.companies()]])).rows;
  return new Set(rows.map((r) => Number(r.journal_id)));
}

// ---------------------------------------------------------------------------------------------------------------
// kanban_dashboard
// ---------------------------------------------------------------------------------------------------------------

/** :776-822 `_fill_bank_cash_dashboard_data`'s per-journal queries for the payments. */
async function paymentTotals(env: Environment, ids: readonly number[], direct: boolean): Promise<Map<number, Row[]>> {
  const companies = [...await env.companies()];
  // :1048-1074 `_get_direct_bank_payments` / :1076-1100 `_get_journal_dashboard_outstanding_payments`
  const rows = direct
    ? (await env.cr.query<Row>(
      `SELECT move.journal_id, move.company_id, move.currency_id AS currency,
              SUM(CASE WHEN payment.payment_type = 'outbound' THEN -payment.amount ELSE payment.amount END)::text AS amount_total,
              SUM(amount_company_currency_signed)::text AS amount_total_company
         FROM account_payment payment
         JOIN account_move move ON move.origin_payment_id = payment.id
         JOIN account_journal journal ON move.journal_id = journal.id
        WHERE payment.is_matched IS TRUE AND move.state = 'posted' AND payment.journal_id = ANY($1::int[])
          AND payment.company_id = ANY($2::int[]) AND payment.outstanding_account_id = journal.default_account_id
     GROUP BY move.company_id, move.journal_id, move.currency_id`, [[...ids], companies])).rows
    : (await env.cr.query<Row>(
      `SELECT payment.journal_id, payment.company_id, payment.currency_id AS currency,
              SUM(CASE WHEN payment.payment_type = 'outbound' THEN -payment.amount ELSE payment.amount END)::text AS amount_total,
              SUM(amount_company_currency_signed)::text AS amount_total_company
         FROM account_payment payment
         JOIN account_move move ON move.origin_payment_id = payment.id
        WHERE payment.is_matched IS NOT TRUE AND move.state = 'posted' AND payment.journal_id = ANY($1::int[])
          AND payment.company_id = ANY($2::int[])
     GROUP BY payment.company_id, payment.journal_id, payment.currency_id`, [[...ids], companies])).rows;
  return groupByJournal(rows);
}

async function fillBankCash(env: Environment, js: readonly Journal[], data: Map<number, Map<string, unknown>>): Promise<void> {
  const bank = js.filter((j) => ["bank", "cash", "credit"].includes(j.type));
  if (!bank.length) return;
  const ids = bank.map((j) => j.id);
  const companies = [...await env.companies()];
  // :627-642 number to reconcile
  const toReconcile = new Map((await env.cr.query<Row>(
    `SELECT st_line.journal_id, COUNT(st_line.id)::int AS n
       FROM account_bank_statement_line st_line
       JOIN account_move st_line_move ON st_line_move.id = st_line.move_id
      WHERE st_line.journal_id = ANY($1::int[]) AND st_line.company_id = ANY($2::int[]) AND st_line.is_reconciled IS NOT TRUE
        AND (st_line_move.review_state IS NULL OR st_line_move.review_state NOT IN ('todo', 'anomaly'))
        AND st_line_move.state = 'posted'
   GROUP BY st_line.journal_id`, [ids, companies])).rows.map((r) => [Number(r["journal_id"]), num(r["n"])]));
  const last = await lastStatements(env, ids);
  const outstanding = await paymentTotals(env, ids, false);
  const direct = await paymentTotals(env, ids, true);
  const running = await runningBalance(env, ids);
  const invalid = await invalidStatements(env, ids);

  // :653-674 misc entries: journal items of the default account without a statement line or payment
  const conds: string[] = [];
  const params: unknown[] = [companies];
  for (const j of bank) {
    const limit = last.get(j.id)?.date ?? j.fiscalyearLockDate;
    const acc = j.defaultAccountId === null ? "aml.account_id IS NULL" : `aml.account_id = $${params.push(j.defaultAccountId)}`;
    conds.push(limit ? `(${acc} AND aml.date > $${params.push(limit)}::date)` : `(${acc})`);
  }
  const misc = new Map<number | null, { balance: number; count: number; currencies: number[] }>();
  for (const r of (await env.cr.query<Row>(
    `SELECT aml.account_id, SUM(aml.amount_currency)::text AS balance, COUNT(aml.id)::int AS n,
            array_agg(DISTINCT aml.currency_id) FILTER (WHERE aml.currency_id IS NOT NULL) AS currencies
       FROM account_move_line aml
      WHERE (aml.company_id = ANY($1::int[]) OR aml.company_id IS NULL) AND aml.statement_line_id IS NULL
        AND aml.parent_state = 'posted' AND aml.payment_id IS NULL AND (${conds.join(" OR ")})
   GROUP BY aml.account_id`, params)).rows) {
    misc.set(r["account_id"] === null ? null : Number(r["account_id"]), {
      balance: num(r["balance"]), count: num(r["n"]), currencies: ((r["currencies"] as unknown[] | null) ?? []).map(Number),
    });
  }

  // :676-689 to check
  const toCheck = new Map((await env.cr.query<Row>(
    `SELECT st.journal_id, SUM(st.amount)::text AS amount, COUNT(*)::int AS n
       FROM account_bank_statement_line st JOIN account_move m ON m.id = st.move_id
      WHERE st.journal_id = ANY($1::int[]) AND m.company_id = ANY($2::int[]) AND m.review_state IN ('todo', 'anomaly')
        AND m.state = 'posted' AND (st.company_id = ANY($2::int[]) OR st.company_id IS NULL)
   GROUP BY st.journal_id`, [ids, companies])).rows.map((r) => [Number(r["journal_id"]), [num(r["amount"]), num(r["n"])] as [number, number]]));

  for (const j of bank) {
    const cur = await currencyOf(env, j);
    const [hasOutstanding, outstandingBalance] = await countAndSum(env, outstanding.get(j.id) ?? [], cur);
    const [toCheckBalance, numberToCheck] = toCheck.get(j.id) ?? [0, 0];
    const m = misc.get(j.defaultAccountId) ?? { balance: 0, count: 0, currencies: [cur.id] };
    const consistent = m.currencies.length === 1 && m.currencies[0] === cur.id;
    const accessible = companies.includes(j.companyId);
    const [nbDirect, directBalance] = await countAndSum(env, direct.get(j.id) ?? [], cur);
    const [hasLines, balance] = running.get(j.id) ?? [false, 0];
    const st = last.get(j.id);
    const lock = j.fiscalyearLockDate;
    const lastVisible = !lock || (st?.date ? lock < st.date : false);
    const d = data.get(j.id)!;
    d.set("number_to_check", numberToCheck);
    d.set("to_check_balance", await fmt(env, toCheckBalance, cur));
    d.set("number_to_reconcile", toReconcile.get(j.id) ?? 0);
    d.set("account_balance", await fmt(env, balance + directBalance, cur));
    d.set("has_at_least_one_statement", Boolean(st));
    d.set("nb_lines_bank_account_balance", (hasLines || Boolean(nbDirect)) && accessible);
    d.set("outstanding_pay_account_balance", await fmt(env, outstandingBalance, cur));
    d.set("nb_lines_outstanding_pay_account_balance", hasOutstanding);
    d.set("last_balance", await fmt(env, st?.balanceEndReal ?? 0, cur));
    d.set("last_statement_id", st?.id ?? false);
    d.set("last_statement_visible", lastVisible);
    d.set("has_invalid_statements", invalid.has(j.id));
    d.set("bank_statements_source", j.bankStatementsSource ?? false);
    d.set("is_sample_data", hasLines);
    d.set("nb_misc_operations", m.count);
    d.set("misc_class", consistent ? "" : "text-warning");
    d.set("misc_operations_balance", consistent ? await fmt(env, m.balance, cur) : null);
    d.set("drag_drop_settings", {
      image: j.type === "bank" || j.type === "credit" ? "/account/static/src/img/bank.svg" : "/web/static/img/rfq.svg",
      text: translate(env, "Drop to import transactions", "account"),
    });
  }
}

/** :845-922 `_fill_sale_purchase_dashboard_data` with :1287-1372 its queries. */
async function fillSalePurchase(env: Environment, js: readonly Journal[], data: Map<number, Map<string, unknown>>): Promise<void> {
  const sp = js.filter((j) => j.type === "sale" || j.type === "purchase");
  if (!sp.length) return;
  const ids = sp.map((j) => j.id);
  const companies = [...await env.companies()];
  const today = await contextToday(env);
  const companyCheck = "(account_move.company_id = ANY($2::int[]) OR account_move.company_id IS NULL)";
  // :1287-1309 drafts
  const drafts = groupByJournal((await env.cr.query<Row>(
    `SELECT account_move.journal_id,
            ((CASE WHEN account_move.move_type IN ('out_refund', 'in_refund') THEN -1 ELSE 1 END) * account_move.amount_total)::text AS amount_total,
            ((CASE WHEN account_move.move_type IN ('in_invoice', 'in_refund', 'in_receipt') THEN -1 ELSE 1 END) * account_move.amount_total_signed)::text AS amount_total_company,
            account_move.currency_id AS currency, account_move.company_id
       FROM account_move
      WHERE ${companyCheck} AND account_move.journal_id = ANY($1::int[]) AND account_move.state = 'draft'
        AND account_move.move_type = ANY($3::text[])
   ORDER BY account_move.id`, [ids, companies, INVOICE_TYPES])).rows);
  // :1314-1340 open invoices, :1342-1360 to check
  const grouped = async (where: string, residual: boolean): Promise<Map<number, Row[]>> => groupByJournal((await env.cr.query<Row>(
    `SELECT journal_id, company_id, currency_id AS currency, invoice_date_due < $4::date AS late,
            SUM(${residual ? "amount_residual_signed" : "amount_total_signed"})::text AS amount_total_company,
            SUM((CASE WHEN move_type = 'in_invoice' THEN -1 ELSE 1 END) * ${residual ? "amount_residual" : "amount_total"})::text AS amount_total,
            COUNT(*)::int AS count
       FROM account_move
      WHERE ${companyCheck} AND account_move.journal_id = ANY($1::int[]) AND ${where}
   GROUP BY account_move.company_id, account_move.journal_id, account_move.currency_id, late`,
    [ids, companies, INVOICE_TYPES, today])).rows);
  const open = await grouped("payment_state IN ('not_paid', 'partial') AND state = 'posted' AND move_type = ANY($3::text[])", true);
  const toCheck = await grouped("review_state IN ('todo', 'anomaly') AND state = 'posted' AND cardinality($3::text[]) > 0", false);
  const sample = new Map((await env.cr.query<Row>(
    `SELECT journal.id, EXISTS(SELECT 1 FROM account_move move WHERE move.journal_id = journal.id AND move.company_id = ANY($2::int[])) AS moves_exists
       FROM account_journal journal WHERE journal.id = ANY($1::int[])`, [ids, companies])).rows.map((r) => [Number(r["id"]), !r["moves_exists"]]));
  const holes = await sequenceHoles(env, sp);
  const peppol = await isInstalled(env.cr, "account_peppol");

  for (const j of sp) {
    const cur = await currencyOf(env, j);
    const rows = open.get(j.id) ?? [];
    const [numberWaiting, sumWaiting] = await countAndSum(env, rows, cur);
    const [numberDraft, sumDraft] = await countAndSum(env, drafts.get(j.id) ?? [], cur);
    const [numberLate, sumLate] = await countAndSum(env, rows.filter((r) => r["late"] === true), cur);
    const [numberToCheck, sumToCheck] = await countAndSum(env, toCheck.get(j.id) ?? [], cur);
    const purchase = j.type === "purchase";
    const sign = purchase ? -1 : 1;
    const d = data.get(j.id)!;
    d.set("number_to_check", numberToCheck);
    d.set("to_check_balance", await fmt(env, sumToCheck, cur));
    d.set("title", translate(env, purchase ? "Bills to pay" : "Invoices owed to you", "account"));
    d.set("number_draft", numberDraft);
    d.set("number_waiting", numberWaiting);
    d.set("number_late", numberLate);
    d.set("sum_draft", await fmt(env, sumDraft, cur));
    d.set("sum_waiting", await fmt(env, sumWaiting * sign, cur));
    d.set("sum_late", await fmt(env, sumLate * sign, cur));
    d.set("has_sequence_holes", holes.has(j.id));
    d.set("title_has_sequence_holes", translate(env, purchase
      ? "Irregularities due to draft, cancelled or deleted bills with a sequence number since last lock date."
      : "Irregularities due to draft, cancelled or deleted invoices with a sequence number since last lock date.", "account"));
    d.set("has_unhashed_entries", unhashed(j));
    d.set("is_sample_data", sample.get(j.id) ?? true);
    d.set("has_entries", !(sample.get(j.id) ?? true));
    d.set("drag_drop_settings", purchase
      ? { image: "/account/static/src/img/bill.svg", text: translate(env, "Drop and let the AI process your bills automatically.", "account") }
      : { image: "/web/static/img/quotation.svg", text: translate(env, "Drop to import your invoices.", "account") });
    d.set("onboarding_action_data", purchase ? {} : await onboardingActionData(env, j, peppol));
  }
}

const PEPPOL_DEFAULT_COUNTRIES = ["AT", "BE", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "IE", "IS", "LT", "LU", "LV", "MT", "NL", "NO", "SE", "SI"];

/**
 * ir_actions.py `_get_action_dict`: the readable fields of `sudo().read()[0]`, so in the model's field order (the
 * order `json.dumps` keeps); `/web/action/load` (src/controllers/action.ts) gives the same values in another order.
 */
async function actionDict(env: Environment, xmlid: string): Promise<Record<string, unknown>> {
  const { forXmlId } = await import("./account_buttons");
  const { fieldOrder } = await import("./base_import");
  const action = await forXmlId(env, xmlid);
  const order = (await fieldOrder(env))[String(action["type"])];
  if (!order) throw new NotPorted(`field order of ${String(action["type"])}`);
  const unknown = Object.keys(action).filter((k) => !order.includes(k));
  if (unknown.length) throw new NotPorted(`_get_action_dict of ${xmlid}: keys ${unknown.join(", ")} are no fields`);
  return Object.fromEntries(order.filter((k) => k in action).map((k) => [k, action[k]]));
}

/** :1394-1401 `_get_onboarding_action_data` with account_peppol account_journal.py:70-82. */
async function onboardingActionData(env: Environment, j: Journal, peppol: boolean): Promise<Record<string, unknown>> {
  if (peppol && j.countryCode !== null && PEPPOL_DEFAULT_COUNTRIES.includes(j.countryCode)) {
    const state = (await env.cr.query<{ s: string | null }>("SELECT account_peppol_proxy_state AS s FROM res_company WHERE id = $1", [j.companyId])).rows[0]?.s;
    if (state === "not_registered") {
      return { title: translate(env, "Activate Peppol", "account_peppol"), action: await openCompanyPeppolForm(env, j.companyId) };
    }
    return { title: translate(env, "Peppol Settings", "account_peppol"), action: await actionDict(env, "account.action_account_config") };
  }
  return { title: translate(env, "Activate E-Invoicing", "account"), action: await actionDict(env, "account.action_account_config") };
}

/** :924-951 `_fill_general_dashboard_data`. */
async function fillGeneral(env: Environment, js: readonly Journal[], data: Map<number, Map<string, unknown>>): Promise<void> {
  const general = js.filter((j) => j.type === "general");
  if (!general.length) return;
  const drafts = new Map((await env.cr.query<Row>(
    `SELECT journal_id, COUNT(*)::int AS n FROM account_move
      WHERE (company_id = ANY($2::int[]) OR company_id IS NULL) AND journal_id = ANY($1::int[]) AND state = 'draft' AND auto_post = 'no'
   GROUP BY journal_id`, [general.map((j) => j.id), [...await env.companies()]])).rows.map((r) => [Number(r["journal_id"]), num(r["n"])]));
  for (const j of general) {
    const d = data.get(j.id)!;
    d.set("number_draft", drafts.get(j.id) ?? 0);
    d.set("drag_drop_settings", {
      image: "/web/static/img/folder.svg",
      text: translate(env, "Drop to create journal entries with attachments.", "account"),
      group: "account.group_account_user",
    });
  }
}

/** :953-984 `_fill_onboarding_data` with onboarding_onboarding.py:125-135 and onboarding_progress.py:53-78. */
async function fillOnboarding(env: Environment, js: readonly Journal[], data: Map<number, Map<string, unknown>>): Promise<void> {
  const routes: Record<string, string> = { sale: "account_invoice", general: "account_return_dashboard" };
  const lang = langOf(env);
  const current = await env.company();
  const progresses = (await env.cr.query<Row>(
    `SELECT p.id, p.company_id, p.onboarding_id, o.route_name, o.panel_close_action_name, o.text_completed
       FROM onboarding_progress p JOIN onboarding_onboarding o ON o.id = p.onboarding_id
      WHERE o.route_name = ANY($1::text[]) AND p.company_id = ANY($2::int[])
   ORDER BY p.id`, [Object.values(routes), [...new Set(js.map((j) => j.companyId))]])).rows;
  const byCompany = new Map<number, Map<string, Map<string, unknown>>>();
  for (const p of progresses) {
    const company = Number(p["company_id"]);
    const onboarding = Number(p["onboarding_id"]);
    const steps = (await env.cr.query<Row>(
      `SELECT s.id, ${translatedSql("s.title", 2)} AS title, ${translatedSql("s.description", 2)} AS description, s.panel_step_open_action_name AS action
         FROM onboarding_onboarding_step s
         JOIN onboarding_onboarding_onboarding_onboarding_step_rel r ON r.onboarding_onboarding_step_id = s.id
        WHERE r.onboarding_onboarding_id = $1
     ORDER BY s.sequence, s.id`, [onboarding, lang])).rows;
    // onboarding_onboarding_step.py:47-63 `current_step_state` in the progress's company
    const states = new Map((await env.cr.query<Row>(
      `SELECT step_id, step_state FROM onboarding_progress_step
        WHERE step_id = ANY($1::int[]) AND (company_id IS NULL OR company_id = $2) ORDER BY id`,
      [steps.map((s) => Number(s["id"])), company])).rows.map((r) => [Number(r["step_id"]), String(r["step_state"])]));
    const state = new Map<unknown, unknown>();
    const justDoneSteps: number[] = [];
    for (const s of steps) {
      const sid = Number(s["id"]);
      const st = states.get(sid) ?? "not_done";
      if (st === "just_done") justDoneSteps.push(sid);
      state.set(sid, st);
    }
    if (justDoneSteps.length) {
      await env.cr.query(
        `UPDATE onboarding_progress_step
            SET step_state = 'done', write_uid = $3, write_date = (now() AT TIME ZONE 'UTC')
          WHERE step_id = ANY($1::int[]) AND (company_id IS NULL OR company_id = $2) AND step_state = 'just_done'`,
        [justDoneSteps, company, env.uid],
      );
    }
    // onboarding_onboarding.py:55-67 `_compute_current_progress` of the panel's company, then of env.company
    const progressOf = async (c: number): Promise<Row | undefined> => (await env.cr.query<Row>(
      `SELECT id, onboarding_state, is_onboarding_closed FROM onboarding_progress
        WHERE onboarding_id = $1 AND (company_id IS NULL OR company_id = $2) ORDER BY id`, [onboarding, c])).rows[0];
    const own = await progressOf(company);
    if (own?.["is_onboarding_closed"]) state.set("onboarding_state", "closed");
    else if (own?.["onboarding_state"] === "done") state.set("onboarding_state", "done");
    else if (own?.["onboarding_state"] === "just_done") {
      state.set("onboarding_state", "just_done");
      await env.cr.query(
        `UPDATE onboarding_progress
            SET onboarding_state = 'done', write_uid = $2, write_date = (now() AT TIME ZONE 'UTC')
          WHERE id = $1 AND onboarding_state = 'just_done'`,
        [Number(own["id"]), env.uid],
      );
    }
    const mine = await progressOf(current);
    if (!byCompany.has(company)) byCompany.set(company, new Map());
    byCompany.get(company)!.set(String(p["route_name"]), new Map<string, unknown>([
      ["close_method", p["panel_close_action_name"] ?? false],
      ["close_model", "onboarding.onboarding"],
      ["steps", steps.map((s) => ({
        id: Number(s["id"]), title: s["title"] ?? false, description: s["description"] ?? false,
        state: state.get(Number(s["id"])), action: s["action"] ?? false,
      }))],
      ["state", state],
      ["text_completed", p["text_completed"] ?? false],
      ["current_onboarding_state", (mine?.["onboarding_state"] as string | undefined) ?? "not_done"],
    ]));
  }
  for (const j of js) {
    const route = routes[j.type];
    data.get(j.id)!.set("onboarding", (route && byCompany.get(j.companyId)?.get(route)) ?? null);
  }
}

/** :574-591 `_get_journal_dashboard_data_batched`. */
async function kanbanDashboard(env: Environment, ids: readonly number[]): Promise<Map<number, unknown>> {
  await refuseExtensions(env);
  const js = await journals(env, ids);
  const companies = await env.companies();
  const company = await env.company();
  const data = new Map<number, Map<string, unknown>>();
  for (const j of js) {
    data.set(j.id, new Map<string, unknown>([
      ["currency_id", j.currencyId ?? j.companyCurrencyId],
      ["show_company", companies.length > 1 || j.companyId !== company],
      ["company_name", j.companyName],
    ]));
  }
  await fillBankCash(env, js, data);
  await fillSalePurchase(env, js, data);
  await fillGeneral(env, js, data);
  await fillOnboarding(env, js, data);
  return new Map(js.map((j) => [j.id, jsonDumps(data.get(j.id))]));
}

// ---------------------------------------------------------------------------------------------------------------
// kanban_dashboard_graph
// ---------------------------------------------------------------------------------------------------------------

const DAY = 86_400_000;
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** babel `format_date(date, 'd LLLL Y')` and `'d MMM'` (week-based year `Y`, babel dates.py format_year). */
export async function babelDay(code: string, day: string): Promise<{ name: string; short: string }> {
  const loc = await cldrLocale(code);
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  // babel's `Y` moves the first days of January and the last of December to the year of their week
  let year = y;
  if ((m === 1 && d < 7) || (m === 12 && d > 25)) {
    const [wy] = weekNumber(loc, { year: y, month: m, day: d, hour: 0, minute: 0, second: 0 });
    year = wy;
  }
  return { name: `${d} ${loc.monthsWide[m - 1]} ${year}`, short: `${d} ${loc.monthsAbbreviated[m - 1]}` };
}

function graphKey(env: Environment, type: string): string {
  // :443-451 `_graph_title_and_key`
  if (type === "cash") return translate(env, "Cash: Balance", "account");
  if (type === "bank") return translate(env, "Bank: Balance", "account");
  if (type === "credit") return translate(env, "Credit Card: Balance", "account");
  return translate(env, "Total", "account");
}

/** :453-512 `_get_bank_cash_graph_data` (`datetime.today()`: the server's UTC clock, here the database's). */
async function bankCashGraph(env: Environment, js: readonly Journal[]): Promise<Map<number, unknown>> {
  const out = new Map<number, unknown>();
  if (!js.length) return out;
  const now = (await dbNow(env)).getTime();
  const today = isoDay(now);
  const lastMonth = isoDay(now - 30 * DAY);
  const locale = (await getLang(env)).code;
  const rows = groupByJournal((await env.cr.query<Row>(
    `SELECT move.journal_id, to_char(move.date, 'YYYY-MM-DD') AS date, SUM(st_line.amount)::text AS amount
       FROM account_bank_statement_line st_line JOIN account_move move ON move.id = st_line.move_id
      WHERE move.journal_id = ANY($1::int[]) AND move.date > $2::date AND move.company_id = ANY($3::int[])
   GROUP BY move.date, move.journal_id
   ORDER BY move.date DESC`, [js.map((j) => j.id), lastMonth, [...await env.companies()]])).rows);
  const running = await runningBalance(env, js.map((j) => j.id));
  for (const j of js) {
    const cur = await currencyOf(env, j);
    const point = async (day: string, amount: number): Promise<Record<string, unknown>> => {
      const { name, short } = await babelDay(locale, day);
      return { x: short, y: pyFloat(roundPrecision(amount, cur.rounding)), name };
    };
    const result = rows.get(j.id) ?? [];
    const [hasLines, lastBalance] = running.get(j.id) ?? [false, 0];
    const sample = !result.length && !hasLines;
    let key = graphKey(env, j.type);
    const data: unknown[] = [];
    if (sample) {
      // random.randint(-5, 15): sample points, random in Odoo too
      for (let i = 30; i > 0; i -= 5) {
        data.push(await point(isoDay(now - i * DAY), -5 + Math.floor(Math.random() * 21)));
        key = translate(env, "Sample data", "account");
      }
    } else {
      if (!result.length || String(result[0]!["date"]) < today) data.push(await point(today, lastBalance));
      let date = today;
      let amount = lastBalance;
      for (const r of result) {
        date = String(r["date"]);
        data.unshift(await point(date, amount));
        amount -= num(r["amount"]);
      }
      if (date !== lastMonth) data.unshift(await point(lastMonth, amount));
    }
    out.set(j.id, jsonDumps([{ values: data, title: "", key, area: true, color: "#7c7bad", is_sample_data: sample }]));
  }
  return out;
}

/** :514-572 `_get_sale_purchase_graph_data`. */
async function salePurchaseGraph(env: Environment, js: readonly Journal[]): Promise<Map<number, unknown>> {
  const out = new Map<number, unknown>();
  if (!js.length) return out;
  const today = await contextToday(env);
  const [ty, tm] = today.split("-").map(Number) as [number, number];
  const months: string[] = [];
  for (let i = 0; i < 13; i++) {
    const k = ty * 12 + (tm - 1) - 12 + i;
    months.push(`${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}-01`);
  }
  const endK = ty * 12 + tm;
  const endMonth = `${Math.floor(endK / 12)}-${String((endK % 12) + 1).padStart(2, "0")}-01`;
  const loc = await cldrLocale((await getLang(env)).code);
  const labels = months.map((m) => loc.monthsAbbreviated[Number(m.slice(5, 7)) - 1]!);
  const rows = (await env.cr.query<Row>(
    `SELECT move.journal_id, move.company_id, move.currency_id, to_char(date_trunc('month', move.invoice_date)::date, 'YYYY-MM-DD') AS invoice_month,
            COALESCE(SUM(move.amount_total_signed), 0)::text AS total_amount_company
       FROM account_move move
      WHERE move.journal_id = ANY($1::int[]) AND move.state = 'posted' AND move.move_type IN ('out_invoice', 'in_invoice')
        AND move.invoice_date >= $2::date AND move.invoice_date < $3::date AND move.company_id = ANY($4::int[])
   GROUP BY move.journal_id, move.company_id, move.currency_id, invoice_month`,
    [js.map((j) => j.id), months[0], endMonth, [...await env.companies()]])).rows;
  for (const j of js) {
    const cur = await currencyOf(env, j);
    if (cur.id !== j.companyCurrencyId) throw new NotPorted("account.journal sale/purchase graph of a journal in another currency (res.currency._convert)");
    const sign = j.type === "sale" ? 1 : -1;
    const values = months.map((m) => {
      let total = 0;
      for (const r of rows) if (Number(r["journal_id"]) === j.id && r["invoice_month"] === m) total += num(r["total_amount_company"]);
      return pyFloat(roundPrecision(sign * total, cur.rounding));
    });
    out.set(j.id, jsonDumps([{ type: "monthly_total", labels, values, title: "", key: graphKey(env, j.type) }]));
  }
  return out;
}

/** :69-87 `_kanban_dashboard_graph`. */
async function kanbanDashboardGraph(env: Environment, ids: readonly number[]): Promise<Map<number, unknown>> {
  const js = await journals(env, ids);
  const out = new Map<number, unknown>(js.map((j) => [j.id, false]));
  for (const [k, v] of await bankCashGraph(env, js.filter((j) => ["bank", "cash", "credit"].includes(j.type)))) out.set(k, v);
  for (const [k, v] of await salePurchaseGraph(env, js.filter((j) => (j.type === "sale" || j.type === "purchase") && !j.disableGraph))) out.set(k, v);
  return out;
}

registerHooks("account.journal", {
  computed: {
    kanban_dashboard: kanbanDashboard,
    kanban_dashboard_graph: kanbanDashboardGraph,
    has_entries: async (env, ids) => { const r = await hasEntries(env, ids); return new Map(ids.map((id) => [id, r.get(id)?.[1] ?? false])); },
    has_posted_entries: async (env, ids) => { const r = await hasEntries(env, ids); return new Map(ids.map((id) => [id, r.get(id)?.[0] ?? false])); },
    has_sequence_holes: async (env, ids) => { const h = await sequenceHoles(env, await journals(env, ids)); return new Map(ids.map((id) => [id, h.has(id)])); },
    has_unhashed_entries: async (env, ids) => new Map((await journals(env, ids)).map((j) => [j.id, unhashed(j)])),
    current_statement_balance: async (env, ids) => { const r = await runningBalance(env, ids); return new Map(ids.map((id) => [id, r.get(id)?.[1] ?? 0])); },
    has_statement_lines: async (env, ids) => { const r = await runningBalance(env, ids); return new Map(ids.map((id) => [id, r.get(id)?.[0] ?? false])); },
    last_statement_id: async (env, ids) => { const r = await lastStatements(env, ids); return new Map(ids.map((id) => [id, r.get(id)?.id ?? false])); },
    has_invalid_statements: async (env, ids) => { const r = await invalidStatements(env, ids); return new Map(ids.map((id) => [id, r.has(id)])); },
  },
});

// ---------------------------------------------------------------------------------------------------------------
// the cards' buttons (open_action and action_create_new are src/models/sweep_account.ts's)
// ---------------------------------------------------------------------------------------------------------------

/** `self.id` of a journal recordset: False when empty, the singleton error of several. */
function selfId(ids: readonly number[]): number | false {
  if (ids.length > 1) throw new OdooError("builtins.ValueError", `Expected singleton: account.journal(${ids.join(", ")})`);
  return ids[0] ?? false;
}

function ensureOne(ids: readonly number[]): number {
  if (ids.length !== 1) throw new OdooError("builtins.ValueError", `Expected singleton: account.journal(${ids.join(", ")}${ids.length ? "," : ""})`);
  return ids[0]!;
}

function button(method: string, fn: (env: Environment, ids: number[], args: unknown[], kwargs: Record<string, unknown>) => Promise<unknown>): void {
  registerMethod("account.journal", method, async (env0, ids, args, kwargs0) => {
    const { env, kwargs } = envFor(env0, kwargs0);
    return fn(env, ids ?? [], args, kwargs);
  }, { apiModel: false });
}

async function journalType(env: Environment, id: number | false): Promise<string | false> {
  if (id === false) return false;
  const r = (await env.cr.query<{ type: string }>("SELECT type FROM account_journal WHERE id = $1", [id])).rows[0];
  if (!r) throw new NotPorted(`account.journal ${id} that does not exist`);
  return r.type;
}

/** :1101-1115 `_get_move_action_context`. */
async function moveActionContext(env: Environment, ids: readonly number[]): Promise<Record<string, unknown>> {
  const ctx: Record<string, unknown> = { ...env.context };
  let journal: number | false;
  if (!ctx["default_journal_id"]) {
    journal = selfId(ids);
    ctx["default_journal_id"] = journal;
  } else if (!ids.length) {
    const d = ctx["default_journal_id"];
    if (typeof d !== "number") throw new NotPorted("_get_move_action_context with a default_journal_id that is no id");
    journal = d;
  } else {
    journal = selfId(ids);
  }
  const type = await journalType(env, journal);
  if (type === "sale") ctx["default_move_type"] = ctx["refund"] ? "out_refund" : "out_invoice";
  else if (type === "purchase") ctx["default_move_type"] = ctx["refund"] ? "in_refund" : "in_invoice";
  else {
    ctx["default_move_type"] = "entry";
    ctx["view_no_maturity"] = true;
  }
  return ctx;
}

async function xmlAction(env: Environment, xmlid: string): Promise<Record<string, unknown>> {
  const { forXmlId } = await import("./account_buttons");
  return forXmlId(env, xmlid);
}

async function literal(raw: unknown): Promise<Record<string, unknown>> {
  const { pyLiteralToJs } = await import("./sweep_account");
  const v = pyLiteralToJs(raw);
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new NotPorted(`ast.literal_eval of an action context ${JSON.stringify(raw)}`);
  return v as Record<string, unknown>;
}

/** :1274-1292 `open_payments_action(payment_type=False, mode='list')`. */
async function openPayments(env: Environment, ids: readonly number[], paymentType: unknown, mode: unknown): Promise<Record<string, unknown>> {
  const ref = paymentType === "outbound" ? "account.action_account_payments_payable"
    : paymentType === "transfer" ? "account.action_account_payments_transfer"
    : paymentType === "inbound" ? "account.action_account_payments"
    : "account.action_account_all_payments";
  const action = await xmlAction(env, ref);
  const id = selfId(ids);
  const ctx: Record<string, unknown> = { ...await literal(action["context"]), default_journal_id: id, search_default_journal_id: id };
  if (paymentType === "transfer") {
    const partner = id === false ? false : (await env.cr.query<{ p: number }>(
      "SELECT c.partner_id AS p FROM account_journal j JOIN res_company c ON c.id = j.company_id WHERE j.id = $1", [id])).rows[0]?.p ?? false;
    ctx["default_partner_id"] = partner;
    ctx["default_is_internal_transfer"] = true;
  }
  action["context"] = ctx;
  if (mode === "form") action["views"] = [[false, "form"]];
  return action;
}

button("open_payments_action", (env, ids, args, kwargs) =>
  openPayments(env, ids, args[0] ?? kwargs["payment_type"] ?? false, args[1] ?? kwargs["mode"] ?? "list"));
// :1395-1401
button("create_customer_payment", (env, ids) => openPayments(env, ids, "inbound", "form"));
button("create_supplier_payment", (env, ids) => openPayments(env, ids, "outbound", "form"));

/** :1294-1297 `action_post_all_entries`: the journal's moves (account.move's order) through the validate button. */
button("action_post_all_entries", async (env, ids) => {
  const id = selfId(ids);
  const { cond } = await import("../orm/domain");
  const { lookupMethod } = await import("../http/methods");
  const moves = await env.model("account.move").search(cond("journal_id", "=", id));
  const ctx = env.withContext({ ...env.context, active_model: "account.journal", active_id: id });
  const validate = lookupMethod("account.move", "action_validate_moves_with_confirmation");
  if (!validate) throw new NotPorted("account.move.action_validate_moves_with_confirmation");
  return validate.fn(ctx, [...moves], [], {}, "account.move");
});

/** :1299-1317 `open_action_with_context`. */
button("open_action_with_context", async (env, ids) => {
  const name = env.context["action_name"];
  if (!name) return false;
  const id = selfId(ids);
  const ctx: Record<string, unknown> = { ...env.context, default_journal_id: id, from_statement_view: true };
  if (ctx["search_default_journal"]) {
    ctx["search_default_journal_id"] = id;
    ctx["search_default_journal"] = false;
  }
  delete ctx["group_by"];
  const action = await xmlAction(env, `account.${String(name)}`);
  action["context"] = ctx;
  const useDomain = ctx["use_domain"];
  if (useDomain) {
    action["domain"] = Array.isArray(useDomain) && useDomain.length ? useDomain : ["|", ["journal_id", "=", id], ["journal_id", "=", false]];
    const journalName = id === false ? false : (await env.cr.query<{ n: string | null }>(
      `SELECT ${translatedSql("name", 2)} AS n FROM account_journal WHERE id = $1`, [id, langOf(env)])).rows[0]?.n ?? false;
    action["name"] = translate(env, "%(action)s for journal %(journal)s", "account")
      .replace("%(action)s", String(action["name"])).replace("%(journal)s", String(journalName));
  }
  return action;
});

/** :1319-1335 `open_bank_difference_action`. */
button("open_bank_difference_action", async (env, ids) => {
  const id = ensureOne(ids);
  const [j] = await journals(env, [id]);
  const action = await xmlAction(env, "account.action_account_moves_all_a");
  const ctx: Record<string, unknown> = {
    search_default_account_id: j!.defaultAccountId ?? false,
    search_default_group_by_move: false,
    search_default_no_st_line_id: true,
    search_default_posted: false,
  };
  const dateFrom = (await lastStatements(env, [id])).get(id)?.date ?? j!.fiscalyearLockDate;
  if (dateFrom) Object.assign(ctx, { date_from: dateFrom, date_to: await contextToday(env), search_default_date_between: true });
  action["context"] = ctx;
  return action;
});

/** :1337-1339 `open_invalid_statements_action`. */
button("open_invalid_statements_action", async (env, ids) => {
  ensureOne(ids);
  return xmlAction(env, "account.action_bank_statement_tree");
});

/** Domain's list form (orm/domains.py): an n-ary operator is n-1 prefix operators before its children. */
function nary(op: "&" | "|", children: unknown[][]): unknown[] {
  return children.length === 1 ? children[0]! : [...Array<string>(children.length - 1).fill(op), ...children.flat(1)];
}

/** :1341-1366 `show_sequence_holes` over `_show_sequence_holes`. */
button("show_sequence_holes", async (env, ids) => {
  if (!ids.length) throw new OdooError("psycopg2.ProgrammingError", "can't execute an empty query");
  const pairs = await sequenceHolePairs(env, await journals(env, ids));
  // `_check_company_domain(env.companies)` & OR(journal & prefix): Domain.AND flattens the ANDs, an empty OR is FALSE
  const company = [["company_id", "in", [...await env.companies(), false]]];
  let domain: unknown[];
  if (!pairs.length) domain = [[0, "=", 1]];
  else {
    if (pairs.some(([, p]) => p === null)) throw new NotPorted("show_sequence_holes of a move without sequence prefix");
    const ands = pairs.map(([j, p]) => [["journal_id", "=", j], ["sequence_prefix", "=", p]]);
    domain = ands.length === 1 ? nary("&", [...company, ...ands[0]!].map((c) => [c])) : nary("&", [company, nary("|", ands.map((a) => nary("&", a.map((c) => [c]))))]);
  }
  const { xmlidId } = await import("./account_buttons");
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Journal Entries", "account"),
    res_model: "account.move",
    search_view_id: [await xmlidId(env, "account.view_account_move_with_gaps_in_sequence_filter"), "search"],
    view_mode: "list,form",
    domain,
    context: { ...await moveActionContext(env, ids), search_default_group_by_sequence_prefix: 1, search_default_irregular_sequences: 1, expand: 1 },
  };
});

/** :1368-1384 `show_unhashed_entries`: a journal without the hash restriction has no move to hash. */
button("show_unhashed_entries", async (env, ids) => {
  const id = ensureOne(ids);
  const [j] = await journals(env, [id]);
  if (j!.restrictHash) throw new NotPorted("show_unhashed_entries of a hashed journal (_get_chains_to_hash)");
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Journal Entries to Hash", "account"),
    res_model: "account.move",
    domain: [["id", "in", []]],
    views: [[false, "list"], [false, "form"]],
  };
});

/**
 * :1134-1211 `action_create_vendor_bill`, the vendor bills' "try our sample": its checks; the sample bill itself
 * (account.bill_preview rendered to a PDF with the report's engine, posted on the bill) is refused.
 */
button("action_create_vendor_bill", async (env) => {
  const d = env.context["default_journal_id"];
  let purchase = typeof d === "number" && d ? d : null;
  if (purchase === null) {
    const { cond } = await import("../orm/domain");
    purchase = (await env.model("account.journal").search(cond("type", "=", "purchase"), { limit: 1 }))[0] ?? null;
  }
  if (purchase === null) {
    const company = await env.company();
    const name = (await env.model("res.company").read([company], ["display_name"], ""))[0]?.["display_name"];
    throw new UserError(translate(env, "No journal could be found in company %(company_name)s for any of those types: %(journal_types)s", "account")
      .replace("%(company_name)s", String(name)).replace("%(journal_types)s", "purchase"));
  }
  const partner = (await env.cr.query("SELECT 1 FROM ir_model_data WHERE module = 'base' AND name = 'res_partner_2'")).rows.length;
  if (!partner) throw new UserError(translate(env, "You may only use samples in demo mode, try uploading one of your invoices instead.", "account"));
  throw new NotPorted("action_create_vendor_bill's sample bill (account.bill_preview rendered to a PDF)");
});

// ---------------------------------------------------------------------------------------------------------------
// the KPI cards above the journals (:89-260 `get_account_dashboard_kpis` and its helpers)
// ---------------------------------------------------------------------------------------------------------------

/** account_move_line.py:898-901 `_compute_sql_consolidation_rate`: 1 for companies of one currency; else refused. */
async function refuseConsolidation(env: Environment): Promise<void> {
  const n = (await env.cr.query<{ n: number }>("SELECT COUNT(DISTINCT currency_id)::int AS n FROM res_company WHERE id = ANY($1::int[])", [[...await env.companies()]])).rows[0]?.n ?? 0;
  if (n > 1) throw new NotPorted("account dashboard KPIs of companies in several currencies (consolidation_rate)");
}

/** :89-131 `_get_profitability_kpi_amounts`: posted income and expenses of the fiscal year of env.company (sudo). */
async function profitabilityKpi(env: Environment): Promise<{ income: number; expenses: number }> {
  const company = await env.company();
  const today = await contextToday(env);
  const fy = (await env.cr.query<{ d: number; m: string }>("SELECT fiscalyear_last_day AS d, fiscalyear_last_month AS m FROM res_company WHERE id = $1", [company])).rows[0];
  if (!fy) throw new NotPorted(`res.company ${company}`);
  const [from, to] = fiscalYear(today, Number(fy.d), Number(fy.m));
  const sudo = env.sudo();
  const query = await searchQuery(sudo, sudo.reg.model("account.move.line"), D.and([
    D.cond("parent_state", "=", "posted"), D.cond("date", ">=", from), D.cond("date", "<=", to),
    D.cond("company_id", "in", [...await env.companies()]),
    D.cond("account_id.account_type", "in", ["income", "expense", "expense_direct_cost", "expense_depreciation"]),
  ]), {});
  const balances = new Map<string, number>();
  if (!query.isEmpty()) {
    // `_read_group(groupby=['account_id.account_type'], aggregates=['consolidation_balance:sum'])`
    const alias = "account_move_line__account_id";
    query.addJoin("LEFT JOIN", alias, ident("account_account"), sql`${ident(alias, "id")} = ${query.table.column("account_id")}`);
    const rows = await runSql<{ t: string | null; s: number | null }>(sudo, sql`${query.select(
      sql`${ident(alias, "account_type")} AS t`, sql`SUM(1 * ${query.table.column("balance")})::float8 AS s`)} GROUP BY ${ident(alias, "account_type")}`);
    for (const r of rows) if (r.t !== null) balances.set(r.t, r.s ?? 0);
  }
  const b = (k: string): number => balances.get(k) ?? 0;
  return { income: -b("income"), expenses: b("expense") + b("expense_direct_cost") + b("expense_depreciation") };
}

/** :133-162 `_get_sale_purchase_kpi_amounts`: the open invoices and bills (`_get_open_sale_purchase_query`) in env.company's currency. */
async function salePurchaseKpi(env: Environment, target: Currency): Promise<{ sale: number; purchase: number }> {
  const amounts = { sale: 0, purchase: 0 };
  const companies = [...await env.companies()];
  const ids = await env.model("account.journal").search(D.and([D.cond("type", "in", ["sale", "purchase"]), D.cond("company_id", "in", companies)]));
  if (!ids.length) return amounts;
  const js = await journals(env, ids);
  const rows = groupByJournal((await env.cr.query<Row>(
    `SELECT journal_id, company_id, currency_id AS currency, invoice_date_due < $4::date AS late,
            SUM(amount_residual_signed)::float8 AS amount_total_company,
            SUM((CASE WHEN move_type = 'in_invoice' THEN -1 ELSE 1 END) * amount_residual)::float8 AS amount_total,
            COUNT(*)::int AS count, TRUE AS to_pay
       FROM account_move
      WHERE (account_move.company_id = ANY($2::int[]) OR account_move.company_id IS NULL) AND account_move.journal_id = ANY($1::int[])
        AND payment_state IN ('not_paid', 'partial') AND state = 'posted' AND move_type = ANY($3::text[])
   GROUP BY account_move.company_id, account_move.journal_id, account_move.currency_id, late, to_pay`,
    [ids, companies, INVOICE_TYPES, await contextToday(env)])).rows);
  for (const type of ["sale", "purchase"] as const) {
    const toPay = js.filter((j) => j.type === type).flatMap((j) => (rows.get(j.id) ?? []).filter((r) => r["to_pay"]));
    amounts[type] = (await countAndSum(env, toPay, target))[1];
  }
  return amounts;
}

/** relativedelta(months=-12) of a date: the same day a year before, the 29th of February clipped to the 28th. */
function yearBefore(date: string): string {
  const y = Number(date.slice(0, 4)) - 1, m = Number(date.slice(5, 7)), d = Number(date.slice(8, 10));
  const max = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${String(y).padStart(4, "0")}-${date.slice(5, 7)}-${String(Math.min(d, max)).padStart(2, "0")}`;
}

/** :164-181 `_get_cashflow_kpi_amount`: money in minus money out of the bank, cash and credit journals over twelve months. */
async function cashflowKpi(env: Environment): Promise<number> {
  const query = await searchQuery(env, env.reg.model("account.move.line"), D.and([
    D.cond("company_id", "in", [...await env.companies()]),
    D.cond("journal_id.type", "in", ["bank", "cash", "credit"]),
    D.cond("date", ">=", yearBefore(await contextToday(env))),
  ]), {});
  if (query.isEmpty()) return 0;
  const alias = "account_move_line__statement_line_id";
  query.addJoin("LEFT JOIN", alias, ident("account_bank_statement_line"), sql`${query.table.column("statement_line_id")} = ${ident(alias, "id")}`);
  const balance = sql`(1 * ${query.table.column("balance")})`;
  const amount = ident(alias, "amount");
  const [r] = await runSql<{ i: number; o: number }>(env, query.select(
    sql`COALESCE(SUM(${balance}) FILTER (WHERE ${amount} > 0 AND ${balance} > 0), 0.0)::float8 AS i`,
    sql`COALESCE(SUM(-${balance}) FILTER (WHERE ${amount} < 0 AND ${balance} < 0), 0.0)::float8 AS o`));
  return Number(r?.i ?? 0) - Number(r?.o ?? 0);
}

/** misc.py:1306-1376 `formatLang(env, currency.round(amount), currency_obj=currency)`: no space or minus rewritten. */
async function formatKpi(env: Environment, amount: number, c: Currency): Promise<string> {
  const row = (await env.cr.query<{ symbol: string | null; position: string | null; decimal_places: number }>(
    "SELECT symbol, position, decimal_places FROM res_currency WHERE id = $1", [c.id])).rows[0]!;
  // currency.round, then float_round HALF-EVEN to the decimal places (a no-op on a rounded amount; -0.0 becomes 0.0)
  const rounded = roundPrecision(amount, c.rounding) + 0;
  const formatted = await langNumber(env, (await getLang(env)).code, rounded, row.decimal_places);
  if (!row.symbol) return formatted;
  return row.position === "after" ? `${formatted} ${row.symbol}` : `${row.symbol} ${formatted}`;
}

/** ir_config_parameter.py:100-105 `get_bool` (str2bool, misc.py:439-466; an invalid value is the default). */
async function configBool(env: Environment, key: string): Promise<boolean> {
  const v = (await env.cr.query<{ value: string | null }>("SELECT value FROM ir_config_parameter WHERE key = $1", [key])).rows[0]?.value;
  return typeof v === "string" && ["y", "yes", "1", "true", "t", "on"].includes(v.toLowerCase());
}

/** :183-260 `get_account_dashboard_kpis` (@api.model). */
registerMethod("account.journal", "get_account_dashboard_kpis", async (env0, _ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  if (!await hasGroup(env, "account.group_account_basic")) throw new AccessError(translate(env, "You do not have access to the Accounting Dashboard.", "account"));
  if (await configBool(env, "account.disable_dashboard_kpis")) return [];
  const company = await env.company();
  const co = (await env.cr.query<{ currency_id: number; layout: number | null }>(
    "SELECT currency_id, external_report_layout_id AS layout FROM res_company WHERE id = $1", [company])).rows[0];
  if (!co) throw new NotPorted(`res.company ${company}`);
  const cur = await currency(env, co.currency_id);
  await refuseConsolidation(env);
  const { income, expenses } = await profitabilityKpi(env);
  const ref = async (xmlid: string): Promise<number | false> => (await env.reg.xmlid(env.cr, xmlid)) ?? false;
  const invoiceAnalysis = await ref("account.action_account_invoice_report_all");
  const profitAndLoss = await ref("account_reports.action_account_report_pl");
  const agedReceivable = await ref("account_reports.action_account_report_ar");
  const agedPayable = await ref("account_reports.action_account_report_ap");
  const cashflowAnalysis = await ref("account.action_account_cashflow_analysis");
  const invoiceLayout = await ref("account.action_base_document_layout_configurator");
  const unpaid = await salePurchaseKpi(env, cur);
  const cashflow = await cashflowKpi(env);
  const card = async (id: string, name: string, amount: number, action: number | false): Promise<Record<string, unknown>> =>
    ({ id, name: translate(env, name, "account"), value: await formatKpi(env, amount, cur), action_id: action });
  const cards: Record<string, unknown>[] = [
    await card("invoices", "Invoices", income, invoiceAnalysis),
    await card("expenses", "Expenses", expenses, profitAndLoss),
    await card("cash", "Cash", cashflow, cashflowAnalysis),
    await card("receivable", "Receivable", unpaid.sale, agedReceivable),
    await card("payable", "Payable", -unpaid.purchase, agedPayable),
  ];
  if (co.layout === null) {
    cards.push({
      id: "invoice_layout", name: translate(env, "Setup Your Invoice Layout", "account"), is_invoice_layout_card: true,
      image: "/web/static/img/mimetypes/document.svg", action_id: invoiceLayout,
    });
  }
  return cards;
}, { apiModel: true });
