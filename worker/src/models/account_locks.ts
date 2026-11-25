/**
 * Lock dates of companies: account company.py:539-577 the `user_*_lock_date` computes over `_get_user_lock_date`
 * (:749-782, the company and its parents; lock date exceptions refuse) and :690-747 `_validate_locks`, run by the
 * company's write before anything else (:898). The consequences of a lock date on entries (`_check_fiscal_lock_dates`,
 * the accounting date at posting) are refused where they are checked (src/models/account_integrity.ts and others).
 */
import { NotPorted, RedirectWarning, UserError } from "../errors";
import type { Environment } from "../orm/types";
import type { Rec } from "../orm/recompute";
import { defineComputes } from "./tail_util";
import { translate } from "./util";

export const SOFT_LOCK_DATE_FIELDS = ["fiscalyear_lock_date", "tax_lock_date", "sale_lock_date", "purchase_lock_date"] as const;
export const LOCK_DATE_FIELDS = [...SOFT_LOCK_DATE_FIELDS, "hard_lock_date"] as const;

/** Python `str(date.min)` as Odoo serializes it (`strftime('%Y-%m-%d')` of year 1 on glibc). */
export const DATE_MIN = "1-01-01";
const maxDate = (a: string, b: string): string => (a === DATE_MIN ? b : b === DATE_MIN ? a : a > b ? a : b);

async function parents(env: Environment, company: number): Promise<number[]> {
  const row = (await env.cr.query<{ p: string | null }>("SELECT parent_path AS p FROM res_company WHERE id = $1", [company])).rows[0];
  return (row?.p ?? `${company}/`).split("/").filter(Boolean).map(Number);
}

/** company.py:749-782 `_get_user_lock_date`. */
export async function userLockDate(env: Environment, company: number, field: (typeof SOFT_LOCK_DATE_FIELDS)[number]): Promise<string> {
  let lock = DATE_MIN;
  for (const c of await parents(env, company)) {
    const [row] = (await env.cr.query<{ d: string | null }>(`SELECT to_char(${field}, 'YYYY-MM-DD') AS d FROM res_company WHERE id = $1`, [c])).rows;
    if (!row?.d) continue;
    const exceptions = (await env.cr.query("SELECT 1 FROM account_lock_exception WHERE company_id = $1 LIMIT 1", [c])).rows.length;
    if (exceptions) throw new NotPorted("lock date exceptions (account.lock_exception)");
    lock = maxDate(lock, row.d);
  }
  return lock;
}

/** company.py:571-577 `_compute_user_hard_lock_date`. */
export async function userHardLockDate(env: Environment, company: number): Promise<string> {
  let lock = DATE_MIN;
  for (const c of await parents(env, company)) {
    const [row] = (await env.cr.query<{ d: string | null }>("SELECT to_char(hard_lock_date, 'YYYY-MM-DD') AS d FROM res_company WHERE id = $1", [c])).rows;
    if (row?.d) lock = maxDate(lock, row.d);
  }
  return lock;
}

const soft = (field: (typeof SOFT_LOCK_DATE_FIELDS)[number]) => async (env: Environment, rec: Rec): Promise<unknown> =>
  rec.origin === null ? DATE_MIN : userLockDate(env, rec.origin, field);
defineComputes("res.company", {
  user_fiscalyear_lock_date: soft("fiscalyear_lock_date"),
  user_tax_lock_date: soft("tax_lock_date"),
  user_sale_lock_date: soft("sale_lock_date"),
  user_purchase_lock_date: soft("purchase_lock_date"),
  user_hard_lock_date: async (env, rec) => (rec.origin === null ? DATE_MIN : userHardLockDate(env, rec.origin)),
});

const dateOf = (v: unknown): string | null => (typeof v === "string" && v ? v.slice(0, 10) : null);

/** company.py:690-747 `_validate_locks`. */
export async function validateLocks(env: Environment, ids: readonly number[], vals: Readonly<Record<string, unknown>>): Promise<void> {
  if (!LOCK_DATE_FIELDS.some((f) => f in vals)) return;
  const fiscalyear = dateOf(vals["fiscalyear_lock_date"]), hard = dateOf(vals["hard_lock_date"]);
  const fiscal = fiscalyear || hard ? maxDate(fiscalyear ?? DATE_MIN, hard ?? DATE_MIN) : null;
  if ("hard_lock_date" in vals) {
    for (const id of ids) {
      const [c] = (await env.cr.query<{ d: string | null }>("SELECT to_char(hard_lock_date, 'YYYY-MM-DD') AS d FROM res_company WHERE id = $1", [id])).rows;
      if (!c?.d) continue;
      if (!hard) throw new UserError(translate(env, "The Hard Lock Date cannot be removed.", "account"));
      if (hard < c.d) throw new UserError(translate(env, "A new Hard Lock Date must be posterior (or equal) to the previous one.", "account"));
    }
  }
  const children = `SELECT c.id FROM res_company c JOIN res_company p ON ('/' || c.parent_path) LIKE ('%/' || p.id || '/%') WHERE p.id = ANY($1::int[])`;
  if (hard) {
    const drafts = (await env.cr.query<{ id: number }>(
      `SELECT id FROM account_move WHERE company_id IN (${children}) AND state = 'draft' AND date <= $2::date ORDER BY date DESC, name DESC, id DESC`, [[...ids], hard])).rows;
    if (drafts.length) throw new NotPorted("hard lock date over draft entries (RedirectWarning with the entries' views)");
  }
  if (fiscal) {
    // `_get_unreconciled_statement_lines_domain`, searched in the statement lines' order (date desc, sequence desc, id desc)
    const lines = (await env.cr.query<{ id: number }>(
      `SELECT l.id FROM account_bank_statement_line l JOIN account_move m ON m.id = l.move_id
        WHERE l.company_id IN (${children}) AND NOT COALESCE(l.is_reconciled, false) AND m.date <= $2::date AND m.state IN ('draft', 'posted')
        ORDER BY l.internal_index DESC, l.id DESC`, [[...ids], fiscal])).rows.map((r) => r.id);
    if (lines.length) {
      const action: Record<string, unknown> = { name: translate(env, "Unreconciled Transactions", "account"), type: "ir.actions.act_window", res_model: "account.bank.statement.line", context: { create: false } };
      if (lines.length === 1) Object.assign(action, { view_mode: "form", res_id: lines[0] });
      else Object.assign(action, { view_mode: "list,form", domain: [["id", "in", lines]] });
      const head = `{'name': '${String(action["name"]).replace(/'/g, "\\'")}', 'type': 'ir.actions.act_window', 'res_model': 'account.bank.statement.line', 'context': {'create': False}`;
      const repr = lines.length === 1 ? `${head}, 'view_mode': 'form', 'res_id': ${lines[0]}}` : `${head}, 'view_mode': 'list,form', 'domain': [('id', 'in', [${lines.join(", ")}])]}`;
      throw new RedirectWarning(translate(env, "There are still unreconciled bank statement lines in the period you want to lock.You should either reconcile or delete them.", "account"),
        action, translate(env, "Show Unreconciled Bank Statement Line", "account"), repr);
    }
  }
}

/** account company.py:900-912: writes the account module does more with than store them. */
export async function refuseAccountCompanyWrites(env: Environment, ids: readonly number[], vals: Readonly<Record<string, unknown>>): Promise<void> {
  for (const f of ["bank_account_code_prefix", "cash_account_code_prefix"]) {
    if (!vals[f]) continue;
    // company.py:668-679 `reflect_code_prefix_change` does nothing for a company without a prefix yet
    const changed = (await env.cr.query(`SELECT 1 FROM res_company WHERE id = ANY($1::int[]) AND ${f} IS NOT NULL AND ${f} IS DISTINCT FROM $2 LIMIT 1`, [[...ids], vals[f]])).rows.length;
    if (changed) throw new NotPorted(`res.company write of ${f} (reflect_code_prefix_change)`);
  }
  // company.py:902-905, per company: a new currency is a UserError once the root company's tree has journal items
  // (`_existing_accounting`, company.py:1134-1138); without them the guard refuses the change (src/orm/override_status.ts)
  if ("currency_id" in vals) {
    for (const id of ids) {
      if (!(await currencyChanges(env, id, vals["currency_id"]))) continue;
      if (await existingAccounting(env, id)) throw new UserError(translate(env, "You cannot change the currency of the company since some journal items already exist", "account"));
    }
  }
}

/** `vals['currency_id'] != company.currency_id.id`. */
export async function currencyChanges(env: Environment, company: number, currency: unknown): Promise<boolean> {
  const cur = (await env.cr.query<{ c: number | null }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [company])).rows[0]?.c ?? null;
  return (cur ?? false) !== (currency === null || currency === undefined ? false : currency);
}

/** company.py:1134-1138 `root_id._existing_accounting()`: a journal item in the root company or one of its children. */
export async function existingAccounting(env: Environment, company: number): Promise<boolean> {
  return (await env.cr.query(
    `SELECT 1 FROM account_move_line l WHERE l.company_id IN (
       SELECT c.id FROM res_company c, res_company me
        WHERE me.id = $1 AND c.parent_path LIKE (split_part(me.parent_path, '/', 1) || '/%')) LIMIT 1`, [company])).rows.length > 0;
}

type LockField = (typeof LOCK_DATE_FIELDS)[number];

/** company.py:799-815 `_get_violated_soft_lock_date` (without exceptions both lock dates are the same) and :817-852. */
export async function lockDateViolations(env: Environment, company: number, date: string | null,
  opts: { fiscalyear: boolean; sale: boolean; purchase: boolean; tax: boolean; hard: boolean }): Promise<[string, LockField][]> {
  if (!date) return [];
  const out: [string, LockField][] = [];
  for (const [field, check] of [["fiscalyear_lock_date", opts.fiscalyear], ["sale_lock_date", opts.sale], ["purchase_lock_date", opts.purchase], ["tax_lock_date", opts.tax]] as const) {
    if (!check) continue;
    const lock = await userLockDate(env, company, field);
    if (lock !== DATE_MIN && date <= lock) out.push([lock, field]);
  }
  if (opts.hard) {
    const lock = await userHardLockDate(env, company);
    if (lock !== DATE_MIN && date <= lock) out.push([lock, "hard_lock_date"]);
  }
  return out;
}

/** company.py:865-880 `_get_violated_lock_dates`, sorted. */
export async function violatedLockDates(env: Environment, company: number, date: string | null, hasTax: boolean, journalType: string | null): Promise<[string, LockField][]> {
  const locks = await lockDateViolations(env, company, date, { fiscalyear: true, sale: journalType === "sale", purchase: journalType === "purchase", tax: hasTax, hard: true });
  return locks.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
}

/** tools/misc.py:1379 `format_date` with the language's date format (babel, the posix format as LDML). */
export async function formatDate(env: Environment, date: string): Promise<string> {
  const lang = env.lang ?? "en_US";
  const fmt = (await env.cr.query<{ f: string }>("SELECT date_format AS f FROM res_lang WHERE code = $1", [lang])).rows[0]?.f ?? "%m/%d/%Y";
  const [y, m, d] = date.slice(0, 10).split("-");
  if (!/^(%[dmY]|[/.\- ])+$/.test(fmt)) throw new NotPorted(`format_date with the date format ${fmt}`);
  return fmt.replace(/%d/g, d!).replace(/%m/g, m!).replace(/%Y/g, y!.padStart(4, "0"));
}

/** tools/i18n.py `format_list` (babel 'standard' style). */
function formatList(env: Environment, items: string[]): string {
  if (items.length <= 1) return items.join("");
  const lang = (env.lang ?? "en_US").replace(/_/g, "-");
  try {
    return new Intl.ListFormat(lang, { style: "long", type: "conjunction" }).format(items);
  } catch {
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
  }
}

/** company.py:854-863 `_format_lock_dates`: "<field label> (<date>)", sorted, as a list. */
export async function formatLockDates(env: Environment, locks: [string, LockField][]): Promise<string> {
  const def = env.reg.model("res.company");
  const lang = env.lang ?? "en_US";
  const sorted = [...locks].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  const parts: string[] = [];
  for (const [date, field] of sorted) {
    const f = def.fields.get(field);
    if (!f) throw new NotPorted(`res.company.${field}`);
    const label = lang === "en_US" ? f.string : (f.strings[lang] ?? f.string);
    parts.push(`${label} (${await formatDate(env, date)})`);
  }
  return formatList(env, parts);
}

/** account_move.py:2967-2985 `_check_fiscal_lock_dates`. */
export async function checkFiscalLockDates(env: Environment, moveIds: readonly number[]): Promise<void> {
  if (env.context["bypass_lock_check"]) throw new NotPorted("bypass_lock_check in the context");
  for (const id of moveIds) {
    const [m] = (await env.cr.query<{ company_id: number; date: string | null; jtype: string | null }>(
      "SELECT m.company_id, to_char(m.date, 'YYYY-MM-DD') AS date, j.type AS jtype FROM account_move m LEFT JOIN account_journal j ON j.id = m.journal_id WHERE m.id = $1", [id])).rows;
    if (!m) continue;
    const locks = await lockDateViolations(env, m.company_id, m.date, { fiscalyear: true, sale: m.jtype === "sale", purchase: m.jtype === "purchase", tax: false, hard: true });
    if (locks.length) throw new UserError(translate(env, "You cannot add/modify entries prior to and inclusive of: %(lock_date_info)s.", "account").replace("%(lock_date_info)s", await formatLockDates(env, locks)));
  }
}

const lastDayOfMonth = (d: string): string => {
  const [y, m] = d.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const nextDay = (d: string): string => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

/**
 * account_move.py:7458-7495 `_get_accounting_date`: past the latest violated lock date, the end of its period
 * (month or year of the sequence) for sale documents, else as for purchase documents.
 */
export async function accountingDateAfterLocks(sale: boolean, invoiceDate0: string, today: string, highest: string | null,
  reset: string, locks: [string, string][]): Promise<string> {
  let invoiceDate = invoiceDate0;
  if (locks.length) invoiceDate = nextDay(locks[locks.length - 1]![0]);
  if (sale) {
    if (locks.length) {
      if (!highest || reset === "month") return today < lastDayOfMonth(invoiceDate) ? today : lastDayOfMonth(invoiceDate);
      if (reset === "year") { const end = `${invoiceDate.slice(0, 4)}-12-31`; return today < end ? today : end; }
    }
    return invoiceDate;
  }
  const later = invoiceDate > today ? invoiceDate : today;
  if (!highest || reset === "month" || reset === "year_range_month") {
    if (today.slice(0, 7) > invoiceDate.slice(0, 7)) return lastDayOfMonth(invoiceDate);
    return later;
  }
  if (reset === "year") return today.slice(0, 4) > invoiceDate.slice(0, 4) ? `${invoiceDate.slice(0, 4)}-12-31` : later;
  return invoiceDate;
}

/** account_move_line.py `_affect_tax_report` of the move's lines (account_move.py:5468-5469). */
export async function affectsTaxReport(env: Environment, moveId: number): Promise<boolean> {
  return (await env.cr.query(
    `SELECT 1 FROM account_move_line l WHERE l.move_id = $1 AND (l.tax_line_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM account_move_line_account_tax_rel r WHERE r.account_move_line_id = l.id)
        OR EXISTS (SELECT 1 FROM account_account_tag_account_move_line_rel r JOIN account_account_tag t ON t.id = r.account_account_tag_id
                    WHERE r.account_move_line_id = l.id AND t.applicability = 'taxes')) LIMIT 1`, [moveId])).rows.length > 0;
}

/** account_move_line.py:1884-1901 `_check_tax_lock_date` of the lines of posted moves that affect the tax report. */
export async function checkTaxLockDate(env: Environment, moveIds: readonly number[]): Promise<void> {
  for (const id of moveIds) {
    const [m] = (await env.cr.query<{ company_id: number; date: string | null; state: string }>(
      "SELECT company_id, to_char(date, 'YYYY-MM-DD') AS date, state FROM account_move WHERE id = $1", [id])).rows;
    if (!m || m.state !== "posted") continue;
    const locks = await lockDateViolations(env, m.company_id, m.date, { fiscalyear: false, sale: false, purchase: false, tax: true, hard: true });
    if (locks.length && (await affectsTaxReport(env, id))) {
      throw new UserError(translate(env, "The operation is refused as it would impact an already issued tax statement. Please change the journal entry date or the following lock dates to proceed: %(lock_date_info)s.", "account")
        .replace("%(lock_date_info)s", await formatLockDates(env, locks)));
    }
  }
}

/** `_check_fiscal_lock_dates()` then `line_ids._check_tax_lock_date()` of moves (account_move.py:4048-4060, :4099-4104). */
export async function checkLockDates(env: Environment, moveIds: readonly number[]): Promise<void> {
  await checkFiscalLockDates(env, moveIds);
  await checkTaxLockDate(env, moveIds);
}
