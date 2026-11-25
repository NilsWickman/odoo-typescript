/**
 * The `account.payment.register` wizard (account/wizard/account_payment_register.py) for one batch of journal items in
 * the company currency: its computes, and `action_create_payments` for the edit mode (one payment created, posted and
 * reconciled with the batch). Several batches, foreign currencies, early payment discounts and write-offs refuse.
 */
import { NotPorted, UserError, ValidationError } from "../errors";
import { registerMethod } from "../http/methods";
import { and, cond } from "../orm/domain";
import { trackPrepare } from "../mail/tracking";
import { hooksOf, registerHooks } from "../orm/hooks";
import { DbRec, recordCompute, registerDefaults, registerOnchange, registerRecordCompute, type Rec } from "../orm/recompute";
import type { Domain, Environment } from "../orm/types";
import { registerOverrides, write } from "../orm/write";
import { envFor } from "../web/common";
import { contextToday } from "./account_computes";
import { createPostedEntries, finalizeTracking, increaseRank, reconcileLines, type EntryVals, type TrackingDefer, insertRow, linesById, mailAfterCreate, moveRow, reconcilePair, updateRow, type LineRow } from "./account_entries";
import { roundPrecision } from "./account_tax_engine";
import { currencyData } from "./account_taxes";
import { conversionRate, convertAmount } from "./currency_convert";
import { defineComputes, withCompany as withCompanyEnv } from "./tail_util";
import { translate } from "./util";
import { addPrecommit } from "./precommit";
import { nextOfSequence } from "./sale_flow";
import type { EpdLine } from "./account_epd";

const VALID_ACCOUNT_TYPES = ["asset_receivable", "liability_payable"];
const SALE_R = ["out_invoice", "out_refund", "out_receipt"], PURCHASE_R = ["in_invoice", "in_refund", "in_receipt"];

interface Batch {
  lines: LineRow[]; partner_id: number | null; account_id: number; currency_id: number; partner_bank_id: number | null;
  partner_type: "customer" | "supplier"; payment_type: "inbound" | "outbound"; company_id: number; moves: number[];
}

const lineIdsOf = async (rec: Rec): Promise<number[]> => ((await rec.rels("line_ids")).map((l) => l.origin).filter((id): id is number => id !== null));

/** account_payment_register.py:343-417 `_compute_batches` / :263-281 `_get_line_batch_key`, a single batch only. */
async function batchOf(env: Environment, rec: Rec): Promise<Batch> {
  const ids = await lineIdsOf(rec);
  if (!ids.length) throw new UserError(translate(env, "You can't open the register payment wizard without at least one receivable/payable line."));
  const lines = await linesById(env, ids);
  const keys = new Set<string>();
  const banks = new Map<number, number | null>();
  // :365-374 the partner's bank accounts per direction (OrderedSet, in line order)
  const perPartner = new Map<string, { inbound: (number | null)[]; outbound: (number | null)[] }>();
  for (const l of lines) {
    const m = (await env.cr.query<{ move_type: string; partner_bank_id: number | null }>("SELECT move_type, partner_bank_id FROM account_move WHERE id = $1", [l.move_id])).rows[0]!;
    const bank = [...SALE_R, ...PURCHASE_R].includes(m.move_type) ? m.partner_bank_id : null;
    banks.set(l.id, bank);
    keys.add([l.partner_id, l.account_id, l.currency_id, bank, l.account_type].join("/"));
    const pb = perPartner.get(String(l.partner_id)) ?? { inbound: [], outbound: [] };
    const dir = l.balance > 0 ? pb.inbound : pb.outbound;
    if (!dir.includes(bank)) dir.push(bank);
    perPartner.set(String(l.partner_id), pb);
  }
  let mergedBank: number | null | undefined;
  if (keys.size !== 1) {
    // :376-405 batches differing only by the bank account are merged when the partner has one bank account in each
    // direction; the merged batch takes the bank of its payment direction
    const rest = new Set([...keys].map((k) => k.split("/").filter((_, i) => i !== 3).join("/")));
    const pb = perPartner.get(String(lines[0]!.partner_id))!;
    if (rest.size !== 1 || pb.inbound.length !== 1 || pb.outbound.length !== 1) throw new NotPorted("account.payment.register with several batches");
    const total = lines.reduce((t, l) => t + l.balance, 0);
    mergedBank = (total > 0 ? pb.inbound : pb.outbound)[0] ?? null;
  }
  const first = lines[0]!;
  const companies = new Set(lines.map((l) => l.company_id));
  if (companies.size !== 1) throw new NotPorted("account.payment.register across companies");
  const balance = lines.reduce((s, l) => s + l.balance, 0);
  return {
    lines, partner_id: first.partner_id, account_id: first.account_id, currency_id: first.currency_id, partner_bank_id: mergedBank !== undefined ? mergedBank : banks.get(first.id) ?? null,
    partner_type: first.account_type === "asset_receivable" ? "customer" : "supplier", payment_type: balance > 0 ? "inbound" : "outbound",
    company_id: first.company_id, moves: [...new Set(lines.map((l) => l.move_id))],
  };
}

/**
 * account_payment_register.py:185-200 `_get_communication` of the lines' moves: the move's reference for one move, the
 * sorted labels when one is outbound, else the company's next batch communication (company.py:393-399, its no_gap
 * sequence `GROUP/%(range_year)s/`).
 */
async function communicationOf(env: Environment, moves: readonly number[], company: number): Promise<string | false> {
  const rows = (await env.cr.query<{ id: number; move_type: string; payment_reference: string | null; ref: string | null; name: string | null }>(
    "SELECT id, move_type, payment_reference, ref, name FROM account_move WHERE id = ANY($1::int[])", [[...moves]])).rows;
  const label = (m: { payment_reference: string | null; ref: string | null; name: string | null }): string | null => m.payment_reference || m.ref || m.name || null;
  if (rows.length === 1) return label(rows[0]!) ?? false;
  if (rows.some((m) => ["in_invoice", "out_refund", "in_receipt"].includes(m.move_type))) {
    // Python's sorted() of str: code point order
    return [...new Set(rows.map(label).filter((l): l is string => !!l))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(", ");
  }
  const seq = (await env.cr.query<{ id: number; prefix: string | null; suffix: string | null; padding: number; implementation: string; use_date_range: boolean | null }>(
    "SELECT s.id, s.prefix, s.suffix, s.padding, s.implementation, s.use_date_range FROM res_company c JOIN ir_sequence s ON s.id = c.batch_payment_sequence_id WHERE c.id = $1", [company])).rows[0];
  if (!seq) throw new NotPorted("account.payment.register batch communication of a company without its sequence");
  return nextOfSequence(env.sudo(), seq, "batch payment communication");
}

interface Totals { amount_by_default: number; full_amount: number; amount_for_difference: number; full_amount_for_difference: number; installment_mode: string | false; lines: number[]; epd_applied: boolean }

/** account_payment_register.py:659-741 `_get_total_amounts_to_pay` with account_move_line.py:3654-3715 `_get_installments_data`. */
async function totals(env: Environment, rec: Rec, batch: Batch): Promise<Totals> {
  const currency = Number(await rec.get("currency_id"));
  const payDate = String((await rec.get("payment_date")) || await contextToday(env));
  const company = Number(await rec.get("company_id")) || batch.company_id;
  // :629-658 `_convert_to_wizard_currency`: the residuals summed per currency of the lines (in order of appearance),
  // each sum in the wizard's currency: as is in that currency, else converted from the company amount at the payment date
  const toWizard = async (lines: readonly LineRow[]): Promise<number> => {
    const per = new Map<number, { residual: number; residualCurrency: number; comp: number }>();
    for (const l of lines) {
      const t = per.get(l.currency_id) ?? { residual: 0, residualCurrency: 0, comp: l.company_currency_id };
      t.residual += l.amount_residual; t.residualCurrency += l.amount_residual_currency;
      per.set(l.currency_id, t);
    }
    let total = 0;
    for (const [cur, t] of per) {
      if (cur === currency) total += t.residualCurrency;
      else if (cur !== t.comp && currency === t.comp) total += await convertAmount(env, t.residualCurrency, cur, t.comp, company, payDate);
      else total += await convertAmount(env, t.residual, t.comp, currency, company, payDate);
    }
    return total;
  };
  if (env.context["active_domain"]) {
    for (const d of env.context["active_domain"] as unknown[]) if (Array.isArray(d) && d[0] === "next_payment_date") throw new NotPorted("account.payment.register with next_payment_date in the active domain");
  }
  const common: LineRow[] = [], full: LineRow[] = [], byDefault: LineRow[] = [], forDifference: LineRow[] = [];
  let first: string | false = false, epd = false;
  const out: number[] = [];
  for (const moveId of [...batch.moves].sort((a, b) => a - b)) {
    // account_move.py:3074-3089 `_is_eligible_for_early_payment_discount`: the early payment discount mode (its write-off
    // lines per tax) is not ported; a payment after the discount date, in another currency or after a partial payment
    // is a payment of the residual as without the discount
    const term = (await env.cr.query<{ early: boolean | null; currency: number; type: string; inv: string | null; dd: string | null; matched: boolean }>(
      `SELECT t.early_discount AS early, m.currency_id AS currency, m.move_type AS type, m.invoice_date::text AS inv,
              (SELECT l.discount_date::text FROM account_move_line l WHERE l.move_id = m.id AND l.display_type = 'payment_term' ORDER BY l.date_maturity NULLS FIRST, l.id LIMIT 1) AS dd,
              EXISTS (SELECT 1 FROM account_move_line l JOIN account_partial_reconcile p ON p.debit_move_id = l.id OR p.credit_move_id = l.id
                       WHERE l.move_id = m.id AND l.display_type = 'payment_term') AS matched
         FROM account_move m JOIN account_payment_term t ON t.id = m.invoice_payment_term_id WHERE m.id = $1`, [moveId])).rows[0];
    const eligible = Boolean(term?.early && term.currency === currency && ["out_invoice", "out_receipt", "in_invoice", "in_receipt"].includes(term.type)
      && (!payDate || !term.inv || (term.dd !== null && payDate <= term.dd)) && !term.matched);
    const lines = batch.lines.filter((l) => l.move_id === moveId)
      .sort((a, b) => ((a.date_maturity ?? "9999") < (b.date_maturity ?? "9999") ? -1 : (a.date_maturity ?? "9999") > (b.date_maturity ?? "9999") ? 1 : a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (eligible) {
      // account_move_line.py:3683-3695 the early payment discount installment: the discounted residual by default, the
      // full one for the difference (account_payment_register.py:677-685)
      for (const line of lines) {
        if (line.reconciled) continue;
        const d = (await env.cr.query<{ b: number | null; a: number | null }>(
          "SELECT discount_balance::float8 AS b, discount_amount_currency::float8 AS a FROM account_move_line WHERE id = $1", [line.id])).rows[0]!;
        epd = true;
        byDefault.push({ ...line, amount_residual: Number(d.b ?? 0), amount_residual_currency: Number(d.a ?? 0) });
        forDifference.push(line);
        out.push(line.id);
      }
      continue;
    }
    let firstMode: string | false = false, currentMode: string | false = false, lastMode: string | false = false;
    for (const line of lines) {
      if (line.reconciled) continue;
      let type = "other";
      if (line.display_type === "payment_term") {
        const when = line.date_maturity ?? line.date;
        if (when < payDate) firstMode = currentMode = "overdue";
        else if (!firstMode) firstMode = currentMode = "next";
        else if (currentMode === "overdue") currentMode = "next";
        type = String(currentMode);
      }
      if (line.display_type === "payment_term" && (type === "overdue" || type === "next")) {
        if (type === "overdue") { common.push(line); out.push(line.id); }
        else if (lastMode === "next" || lastMode === "overdue") full.push(line);
        else if (!lastMode) { common.push(line); out.push(line.id); first = "next"; }
        lastMode = type;
        first = first || lastMode;
        continue;
      }
      common.push(line);
      out.push(line.id);
    }
  }
  const c = await toWizard(common), f = await toWizard(full), bd = await toWizard(byDefault), fd = await toWizard(forDifference);
  return { amount_by_default: Math.abs(c + bd), full_amount: Math.abs(c + bd + f), amount_for_difference: Math.abs(c + fd), full_amount_for_difference: Math.abs(c + fd + f),
    installment_mode: first, lines: out, epd_applied: epd };
}

/** The filter of `_compute_actionable_errors` / `_compute_unreconciled_paid_amount` (:517-534, :610-625). */
async function unreconciledPaid(env: Environment, batch: Batch): Promise<number> {
  const rows = (await env.cr.query(
    `SELECT 1 FROM account_move__account_payment r JOIN account_payment p ON p.id = r.payment_id
      WHERE r.invoice_id = ANY($1::int[]) AND NOT COALESCE(p.is_reconciled, false) AND NOT COALESCE(p.is_matched, false) AND p.state = 'paid' LIMIT 1`, [batch.moves])).rows.length;
  if (rows) throw new NotPorted("account.payment.register with unreconciled paid payments");
  return 0;
}

/** The method line's code is a provider code (the selection of payment.provider.code). */
async function electronicCode(env: Environment, rec: Rec): Promise<boolean> {
  const line = await rec.rel("payment_method_line_id");
  const code = line ? await line.get("code") : null;
  const selection = env.reg.model("payment.provider").fields.get("code")?.selection;
  if (!Array.isArray(selection)) throw new NotPorted("payment.provider.code selection");
  return selection.some((s) => s.value === code);
}

async function availableJournals(env: Environment, batch: Batch): Promise<number[]> {
  const journals = await env.model("account.journal").search(and([cond("company_id", "in", [batch.company_id, false]), cond("type", "in", ["bank", "cash", "credit"])]));
  const field = batch.payment_type === "inbound" ? "inbound_payment_method_line_ids" : "outbound_payment_method_line_ids";
  const def = env.reg.model("account.journal");
  const out: number[] = [];
  for (const j of journals) if (((await new DbRec(env, def, j).get(field)) as unknown[] | null ?? []).length) out.push(j);
  return out;
}

async function methodLines(env: Environment, journal: unknown, type: string): Promise<number[]> {
  if (typeof journal !== "number" || !journal) return [];
  return env.model("account.payment.method.line").search(and([cond("journal_id", "=", journal), cond("payment_type", "=", type)]), { order: "sequence, id" });
}

async function preferredMethod(env: Environment, batch: Batch): Promise<number | null> {
  const r = (await env.cr.query<{ p: number | null }>("SELECT DISTINCT preferred_payment_method_line_id AS p FROM account_move WHERE id = ANY($1::int[]) AND preferred_payment_method_line_id IS NOT NULL", [batch.moves])).rows;
  return r.length === 1 ? r[0]!.p : null;
}

/** account_payment_register.py:233-268 `_get_batch_journal`. */
async function batchJournal(env: Environment, batch: Batch, available: number[]): Promise<number | null> {
  const base = and([cond("company_id", "in", [batch.company_id, false]), cond("type", "in", ["bank", "cash", "credit"]), cond("id", "in", available)]);
  const currency = cond("currency_id", "=", batch.currency_id), bank = cond("bank_account_id", "=", batch.partner_bank_id ?? false);
  const extras = batch.partner_bank_id ? [and([currency, bank]), bank, currency, null] : [currency, null];
  for (const e of extras) {
    const found = await env.model("account.journal").search(e ? and([base, e]) : base, { limit: 1 });
    if (found.length) return found[0]!;
  }
  return null;
}

/** account_payment_register.py:270-280 `_get_batch_available_partner_banks`. */
async function batchBanks(env: Environment, batch: Batch, journal: unknown): Promise<number[]> {
  if (batch.payment_type === "inbound") {
    if (typeof journal !== "number" || !journal) return [];
    const b = (await env.cr.query<{ b: number | null }>("SELECT bank_account_id AS b FROM account_journal WHERE id = $1", [journal])).rows[0]?.b;
    return b ? [b] : [];
  }
  const ids = [...new Set(batch.lines.map((l) => l.partner_id).filter((p): p is number => p !== null))];
  const out: number[] = [];
  const def = env.reg.model("res.partner");
  for (const p of ids) {
    for (const b of (await new DbRec(env, def, p).rels("bank_ids"))) {
      const c = await b.get("company_id");
      if ((!c || c === batch.company_id) && b.origin !== null && !out.includes(b.origin)) out.push(b.origin);
    }
  }
  return out;
}

registerDefaults("account.payment.register", {
  // account_payment_register.py:19-20 default=fields.Date.context_today
  payment_date: async (env) => contextToday(env),
});

registerOverrides("account.payment.register", {
  // account_payment_register.py:1007-1059 default_get: the lines with a residual from the context
  defaultGet: async (env, fields, values) => {
    if (!fields.includes("line_ids") || "line_ids" in values) return;
    const activeModel = env.context["active_model"], activeIds = (env.context["active_ids"] as number[] | undefined) ?? [];
    let ids: number[];
    if (activeModel === "account.move") ids = (await env.cr.query<{ id: number }>("SELECT id FROM account_move_line WHERE move_id = ANY($1::int[]) ORDER BY id", [activeIds])).rows.map((r) => r.id);
    else if (activeModel === "account.move.line") ids = activeIds;
    else throw new UserError(translate(env, "The register payment wizard should only be called on account.move or account.move.line records."));
    if ("journal_id" in values) throw new NotPorted("account.payment.register with a default journal");
    const available: number[] = [];
    const types = new Set<string>();
    for (const l of await linesById(env, ids)) {
      if (!VALID_ACCOUNT_TYPES.includes(l.account_type)) continue;
      const cur = await currencyData(env, l.currency_id);
      if (Math.abs(roundPrecision(l.amount_residual_currency, cur.rounding)) < cur.rounding) continue;
      available.push(l.id);
      types.add(l.account_type);
    }
    if (!available.length) throw new UserError(translate(env, "There's nothing left to pay for the selected journal items, so no payment registration is necessary. You've got your finances under control like a boss!"));
    if (types.size > 1) throw new UserError(translate(env, "You can't register payments for both inbound and outbound moves at the same time."));
    values["line_ids"] = [[6, 0, available]];
  },
});

registerRecordCompute("account.payment.register", {
  // :419-446 `_compute_from_lines` (`_get_wizard_values_from_batch`, :283-309) for one batch
  company_id: async (env, rec) => (await batchOf(env, rec)).company_id,
  partner_id: async (env, rec) => (await batchOf(env, rec)).partner_id,
  partner_type: async (env, rec) => (await batchOf(env, rec)).partner_type,
  payment_type: async (env, rec) => (await batchOf(env, rec)).payment_type,
  source_currency_id: async (env, rec) => (await batchOf(env, rec)).currency_id,
  source_amount: async (env, rec) => Math.abs((await batchOf(env, rec)).lines.reduce((s, l) => s + l.amount_residual, 0)),
  source_amount_currency: async (env, rec) => {
    const b = await batchOf(env, rec);
    return Math.abs(b.lines.reduce((s, l) => s + (b.currency_id === l.company_currency_id ? l.amount_residual : l.amount_residual_currency), 0));
  },
  can_edit_wizard: async (env, rec) => { await batchOf(env, rec); return true; },
  // :448-461
  can_group_payments: async (env, rec) => {
    const b = await batchOf(env, rec);
    if (b.lines.length === 1 || b.moves.length !== 1) return b.lines.length !== 1;
    const t = (await moveRow(env, b.moves[0]!)).move_type;
    return ![...SALE_R, ...PURCHASE_R].includes(t);
  },
  // :474-478
  group_payment: async (env, rec) => (await batchOf(env, rec)).moves.length === 1,
  // :480-483
  currency_id: async (env, rec) => {
    const journal = await rec.rel("journal_id");
    const jc = journal ? await journal.get("currency_id") : null;
    return jc || (await rec.get("source_currency_id")) || null;
  },
  // :493-508
  journal_id: async (env, rec) => {
    const batch = await batchOf(env, rec);
    const available = await availableJournals(env, batch);
    const current = await rec.prev("journal_id");
    if (typeof current === "number" && available.includes(current)) return current;
    const preferred = await preferredMethod(env, batch);
    if (preferred) return (await env.cr.query<{ j: number }>("SELECT journal_id AS j FROM account_payment_method_line WHERE id = $1", [preferred])).rows[0]?.j ?? null;
    return batchJournal(env, batch, available);
  },
  // :519-529
  partner_bank_id: async (env, rec) => {
    const batch = await batchOf(env, rec);
    const available = await batchBanks(env, batch, await rec.get("journal_id"));
    if (batch.partner_bank_id && available.includes(batch.partner_bank_id)) return batch.partner_bank_id;
    return available[0] ?? null;
  },
  // :545-564
  payment_method_line_id: async (env, rec) => {
    const lines = await methodLines(env, await rec.get("journal_id"), String(await rec.get("payment_type")));
    const current = await rec.prev("payment_method_line_id");
    if (typeof current === "number" && lines.includes(current)) return current;
    if (!lines.length) return null;
    const preferred = await preferredMethod(env, await batchOf(env, rec));
    return preferred && lines.includes(preferred) ? preferred : lines[0]!;
  },
  // :775-785 _compute_amount
  amount: async (env, rec) => {
    if (!(await rec.get("journal_id")) || !(await rec.get("currency_id")) || !(await rec.get("payment_date")) || (await rec.get("custom_user_amount"))) return rec.prev("amount");
    const batch = await batchOf(env, rec);
    const t = await totals(env, rec, batch);
    if (t.epd_applied) return t.amount_by_default;
    return Math.max(0, t.amount_by_default - await unreconciledPaid(env, batch));
  },
  // :787-797 _compute_installments_mode
  installments_mode: async (env, rec) => {
    if (!(await rec.get("journal_id")) || !(await rec.get("currency_id"))) return rec.prev("installments_mode");
    const t = await totals(env, rec, await batchOf(env, rec));
    const amount = Number((await rec.get("amount")) ?? 0);
    const cur = await currencyData(env, Number(await rec.get("currency_id")));
    const eq = (a: number, b: number): boolean => Math.abs(roundPrecision(a - b, cur.rounding)) < cur.rounding;
    if (eq(amount, t.full_amount)) return "full";
    if (eq(amount, t.amount_by_default)) return t.installment_mode || null;
    return "full";
  },
  // :462-472 _compute_communication with :195-208 `_get_communication`
  communication: async (env, rec) => {
    const batch = await batchOf(env, rec);
    let moves = batch.moves;
    if (!((await rec.get("installments_mode")) === "full" || (await rec.get("custom_user_amount")))) {
      const t = await totals(env, rec, batch);
      moves = [...new Set(batch.lines.filter((l) => t.lines.includes(l.id)).map((l) => l.move_id))];
    }
    return communicationOf(env, moves, Number(await rec.get("company_id")));
  },
  // :895-901 _compute_payment_difference_handling (can_edit_wizard is always true here)
  payment_difference_handling: async (_env, rec) => ((await rec.get("early_payment_discount_mode")) ? "reconcile" : "open"),
});

defineComputes("account.payment.register", {
  available_journal_ids: async (env, rec) => availableJournals(env, await batchOf(env, rec)),
  available_partner_bank_ids: async (env, rec) => batchBanks(env, await batchOf(env, rec), await rec.get("journal_id")),
  available_payment_method_line_ids: async (env, rec) => methodLines(env, await rec.get("journal_id"), String(await rec.get("payment_type"))),
  hide_payment_method: async (env, rec) => (await methodLines(env, await rec.get("journal_id"), String(await rec.get("payment_type")))).length <= 1,
  show_partner_bank_account: async (_env, rec) => {
    const journal = await rec.rel("journal_id");
    if (journal && (await journal.get("type")) === "cash") return false;
    const line = await rec.rel("payment_method_line_id");
    return line ? (await line.get("code")) === "manual" : false;
  },
  require_partner_bank_account: async () => false,
  // :853-865 _compute_early_payment_discount_mode: the discount applies and the amount is the discounted or the full one
  early_payment_discount_mode: async (env, rec) => {
    if (!(await rec.get("journal_id")) || !(await rec.get("currency_id")) || !(await rec.get("payment_date"))) return rec.prev("early_payment_discount_mode");
    const t = await totals(env, rec, await batchOf(env, rec));
    if (!t.epd_applied) return false;
    const cur = await currencyData(env, Number(await rec.get("currency_id")));
    const amount = Number((await rec.get("amount")) ?? 0);
    const eq = (a: number, b: number): boolean => Math.abs(roundPrecision(a - b, cur.rounding)) < cur.rounding;
    return eq(amount, t.amount_by_default) || eq(amount, t.full_amount);
  },
  // :904-907 _compute_hide_writeoff_section
  hide_writeoff_section: async (_env, rec) => Boolean(await rec.get("early_payment_discount_mode")),
  // :882-894 `_compute_writeoff_is_exchange_account`
  writeoff_is_exchange_account: async (env, rec) => {
    if (!(await rec.get("can_edit_wizard")) || (await rec.get("payment_difference_handling")) !== "reconcile") return false;
    if ((await rec.get("currency_id")) === (await rec.get("source_currency_id"))) return false;
    const account = await rec.get("writeoff_account_id");
    if (!account) return false;
    const c = (await env.cr.query<{ e: number | null; i: number | null }>(
      "SELECT expense_currency_exchange_account_id AS e, income_currency_exchange_account_id AS i FROM res_company WHERE id = $1", [await rec.get("company_id")])).rows[0];
    return account === c?.e || account === c?.i;
  },
  payment_difference: async (env, rec) => {
    if (!(await rec.get("payment_date"))) return 0;
    const t = await totals(env, rec, await batchOf(env, rec));
    const amount = Number((await rec.get("amount")) ?? 0);
    const diff = (await rec.get("installments_mode")) === "full" ? t.full_amount_for_difference - amount : t.amount_for_difference - amount;
    // fields_numeric.py Monetary.convert_to_cache: rounded with the wizard's currency
    const cur = await currencyData(env, Number(await rec.get("currency_id")));
    return roundPrecision(diff, cur.rounding);
  },
  show_payment_difference: async (_env, rec) => {
    if (Number((await rec.get("payment_difference")) ?? 0) === 0) return false;
    if (!(await rec.get("can_edit_wizard")) || ((await rec.get("can_group_payments")) && !(await rec.get("group_payment")))) return false;
    const line = await rec.rel("payment_method_line_id");
    return Boolean(line && (await line.get("payment_account_id")));
  },
  installments_switch_amount: async (env, rec) => {
    if ((await rec.get("installments_mode")) !== "full") throw new NotPorted("account.payment.register installment switch");
    const t = await totals(env, rec, await batchOf(env, rec));
    const amount = Number((await rec.get("amount")) ?? 0);
    const cur = await currencyData(env, Number(await rec.get("currency_id")));
    const zero = (v: number): boolean => Math.abs(roundPrecision(v, cur.rounding)) < cur.rounding;
    if (zero(t.full_amount - amount) && zero(t.full_amount - t.amount_by_default)) return 0;
    if (!zero(amount)) throw new NotPorted("account.payment.register installment switch text");
    return t.amount_by_default;
  },
  installments_switch_html: async () => "",
  unreconciled_paid_amount: async (env, rec) => unreconciledPaid(env, await batchOf(env, rec)),
  actionable_errors: async (env, rec) => { await unreconciledPaid(env, await batchOf(env, rec)); return false; },
  // :966-979 _compute_exchange_rate
  exchange_rate: async (env, rec) => {
    const batch = await batchOf(env, rec);
    const company = batch.lines[0]!.company_currency_id, cur = await rec.get("currency_id");
    const target = cur !== company ? cur : batch.currency_id;
    if (target === company) return 1.0;
    return conversionRate(env, company, Number(target), Number(await rec.get("company_id")), String((await rec.get("payment_date")) || await contextToday(env)));
  },
  qr_code: async () => false,
  duplicate_payment_ids: async (env, rec) => {
    const amount = Number((await rec.get("amount")) ?? 0);
    const partner = await rec.rel("partner_id");
    if (!partner || !amount) return [];
    const row = (await env.cr.query<{ ids: number[] | null }>(
      `SELECT ARRAY_AGG(DISTINCT d.id) AS ids FROM account_payment d
        WHERE d.company_id = $1 AND d.commercial_partner_id = $2 AND d.date = $3::date AND d.payment_type = $4 AND d.amount = $5::numeric AND d.state IN ('draft', 'posted')`,
      [await rec.get("company_id"), await partner.get("commercial_partner_id"), await rec.get("payment_date"), await rec.get("payment_type"), amount])).rows[0];
    return row?.ids ?? [];
  },
  total_payments_amount: async (env, rec) => {
    if (await rec.get("group_payment")) return 1;
    return (await totals(env, rec, await batchOf(env, rec))).lines.length;
  },
  untrusted_payments_count: async () => 0,
  untrusted_bank_ids: async () => [],
  missing_account_partners: async () => [],
  is_register_payment_on_draft: async (env, rec) => (await batchOf(env, rec)).lines.some((l) => l.parent_state === "draft"),
  // account_payment wizards/account_payment_register.py:58-64 and :34-56
  use_electronic_payment_method: async (env, rec) => electronicCode(env, rec),
  suitable_payment_token_ids: async (env, rec) => {
    if (await electronicCode(env, rec)) throw new NotPorted("account.payment.register with an electronic payment method (tokens)");
    return [];
  },
});
defineComputes("account.payment", {
  // account_payment account_payment.py:87-93 _compute_use_electronic_payment_method and :73-85
  // _compute_suitable_payment_token_ids
  use_electronic_payment_method: async (env, rec) => electronicCode(env, rec),
  suitable_payment_token_ids: async (env, rec) => {
    if (await electronicCode(env, rec)) throw new NotPorted("account.payment with an electronic payment method (tokens)");
    return [];
  },
});
registerRecordCompute("account.payment.register", {
  // account_payment wizards/account_payment_register.py:66-76 _compute_payment_token_id
  payment_token_id: async (env, rec) => {
    if (await electronicCode(env, rec)) throw new NotPorted("account.payment.register with an electronic payment method (tokens)");
    return null;
  },
});

/** account_payment.py:1012-1021 `_get_outstanding_account`, used when the method line has no account. */
async function outstandingAccount(env: Environment, company: number, type: string): Promise<number> {
  const name = `${company}_account_journal_payment_${type === "inbound" ? "debit" : "credit"}_account_id`;
  const r = (await env.cr.query<{ id: number }>("SELECT res_id AS id FROM ir_model_data WHERE module = 'account' AND name = $1", [name])).rows[0];
  if (r) return r.id;
  const t = (await env.cr.query<{ t: number | null }>("SELECT transfer_account_id AS t FROM res_company WHERE id = $1", [company])).rows[0]?.t;
  if (!t) throw new UserError(translate(env, "No outstanding account could be found to make the payment"));
  return t;
}

/** Payments created from the form: stored computes, display name and the outstanding account of `create`. */
function paymentBank(field: string, available: string): (env: Environment, rec: Rec) => Promise<unknown> {
  return async (_env, rec) => {
    const banks = (await rec.get(available)) as number[] | null ?? [];
    const current = await rec.prev(field);
    return typeof current === "number" && banks.includes(current) ? current : banks[0] ?? null;
  };
}
/** account_payment.py:691-712 _compute_destination_account_id, the type-only branch. */
async function defaultCounterpart(env: Environment, company: number, type: string): Promise<number | null> {
  // account_account.py:29 _order on the root company (:418-448 _compute_sql_field_path, code_store of the root)
  if ((await env.cr.query<{ p: number | null }>("SELECT parent_id AS p FROM res_company WHERE id = $1", [company])).rows[0]?.p) throw new NotPorted("default counterpart account of a branch");
  const r = (await env.cr.query<{ id: number }>(
    `SELECT a.id FROM account_account a
       JOIN account_account_res_company_rel rel ON rel.account_account_id = a.id AND rel.res_company_id = $1
       JOIN LATERAL (
         SELECT CASE WHEN COUNT(anc.code_store->>$1::text) = COUNT(anc.id) THEN STRING_AGG(anc.code_store->>$1::text, ' / ' ORDER BY t.ord) END AS code_path,
                STRING_AGG(COALESCE(anc.name->>$3, anc.name->>'en_US'), ' / ' ORDER BY t.ord) AS name_path
           FROM UNNEST(STRING_TO_ARRAY(RTRIM(a.parent_path, '/'), '/')) WITH ORDINALITY AS t(id, ord)
           JOIN account_account anc ON anc.id = t.id::int) p ON true
      WHERE a.account_type = $2 ORDER BY p.code_path, a.account_type, p.name_path LIMIT 1`, [company, type, env.lang ?? "en_US"])).rows[0];
  return r?.id ?? null;
}
async function amountSigned(rec: Rec): Promise<number> {
  const amount = Number((await rec.get("amount")) ?? 0);
  return (await rec.get("payment_type")) === "outbound" ? -amount : amount;
}
registerRecordCompute("account.payment", {
  // account_payment.py:618-623 and :625-629
  partner_bank_id: paymentBank("partner_bank_id", "available_partner_bank_ids"),
  return_partner_bank_id: paymentBank("return_partner_bank_id", "available_return_partner_bank_ids"),
  // account_payment.py:691-712 _compute_destination_account_id (stored)
  destination_account_id: async (env, rec) => {
    const partnerType = await rec.get("partner_type");
    if (partnerType !== "customer" && partnerType !== "supplier") return null;
    const company = Number(await rec.get("company_id"));
    const partner = await rec.get("commercial_partner_id");
    if (typeof partner === "number" && partner) {
      const cenv = await withCompanyEnv(env, company);
      const field = partnerType === "customer" ? "property_account_receivable_id" : "property_account_payable_id";
      return (await new DbRec(cenv, env.reg.model("res.partner"), partner).get(field)) || null;
    }
    return defaultCounterpart(env, company, partnerType === "customer" ? "asset_receivable" : "liability_payable");
  },
  // account_payment.py:495-518 _compute_state before a journal entry exists
  // (with a journal entry, only the states :502-516 leave as they are: neither 'paid' nor 'reconciled')
  state: async (env, rec) => {
    const state = (await rec.prev("state")) || "draft";
    const id = rec.origin ?? rec.id;
    if (!(await rec.get("move_id")) && state !== "paid") return state;
    // a saved payment as stored (its entry's lines, its reconciled invoices)
    const stored = id === null ? undefined : (await env.cr.query<{ m: number | null; o: number | null }>("SELECT move_id AS m, outstanding_account_id AS o FROM account_payment WHERE id = $1", [id])).rows[0];
    if (!stored || stored.m !== ((await rec.get("move_id")) || null) || stored.o !== ((await rec.get("outstanding_account_id")) || null)) {
      throw new NotPorted("account.payment.state of a paid payment in edition (_seek_for_lines, reconciled_invoice_ids)");
    }
    const { paymentComputedState } = await import("./account_entries");
    return paymentComputedState(env, id!, String(state));
  },
  // account_payment.py:582-594 _compute_amount_company_currency_signed without a journal entry
  amount_company_currency_signed: async (env, rec) => {
    // :585-587 with a journal entry: the sum of its liquidity lines' balances (the stored lines of a saved payment)
    if (await rec.get("move_id")) {
      const id = rec.origin ?? rec.id;
      const stored = id === null ? undefined : (await env.cr.query<{ m: number | null }>("SELECT move_id AS m FROM account_payment WHERE id = $1", [id])).rows[0];
      if (!stored || stored.m !== (await rec.get("move_id"))) throw new NotPorted("account.payment.amount_company_currency_signed of a journal entry changed in edition (_seek_for_lines)");
      const { seekForLines } = await import("./account_entries");
      return (await seekForLines(env, id!)).liquidity.reduce((a, l) => a + l.balance, 0);
    }
    const signed = await amountSigned(rec);
    if (signed !== 0 && (await rec.get("currency_id")) !== (await rec.get("company_currency_id"))) throw new NotPorted("account.payment in a foreign currency (_convert)");
    return signed;
  },
});
defineComputes("account.payment", {
  // account_payment.py:714-739 _compute_qr_code (QR generation not available -> False)
  qr_code: async () => false,
  // account_payment.py:596-601 _compute_amount_signed
  amount_signed: async (_env, rec) => amountSigned(rec),
  // account_payment.py:837-844 _compute_payment_receipt_title
  payment_receipt_title: async (env, rec) => {
    const type = await rec.get("payment_type"), partnerType = await rec.get("partner_type");
    if (type === "outbound" && partnerType === "supplier") return translate(env, "Remittance Advice");
    if ((type === "outbound" && partnerType === "customer") || (type === "inbound" && partnerType === "supplier")) return translate(env, "Refund Confirmation");
    return translate(env, "Payment Receipt");
  },
});
/** account_payment.py:859-863 _search_reconciled_invoice_ids (also on reconciled_bill_ids). */
async function searchReconciled(env: Environment, operator: string, value: unknown): Promise<Domain | null> {
  if (operator !== "in" && operator !== "=") return null;
  const moves = (Array.isArray(value) ? value : [value]).filter((v): v is number => typeof v === "number");
  const out = new Set<number>();
  for (const m of moves) for (const p of (await new DbRec(env, env.reg.model("account.move"), m).get("reconciled_payment_ids")) as number[] | null ?? []) out.add(p);
  return cond("id", "in", [...out]);
}
registerRecordCompute("account.payment", {
  display_name: async (env, rec) => (await rec.get("name")) || translate(env, "Draft Payment"),
});
registerHooks("account.payment", {
  search: { reconciled_invoice_ids: searchReconciled, reconciled_bill_ids: searchReconciled },
  // account_payment.py:1042-1045 _compute_display_name
  displayName: async (env, ids) => {
    const out = new Map<number, string>();
    if (!ids.length) return out;
    const rows = (await env.cr.query<{ id: number; name: string | null }>("SELECT id, name FROM account_payment WHERE id = ANY($1::int[])", [[...ids]])).rows;
    for (const r of rows) out.set(r.id, r.name || translate(env, "Draft Payment"));
    return out;
  },
});
registerOverrides("account.payment", {
  // account_payment.py:929-933 _inverse_memo
  inverse: {
    memo: async (env, ids) => {
      for (const id of ids) {
        const rec = new DbRec(env, env.reg.model("account.payment"), id);
        const move = await rec.get("move_id");
        if (typeof move === "number" && move) await write(env, "account.move", [move], { ref: (await rec.get("memo")) || false });
      }
    },
  },
  constraints: [
    // account_payment.py:939-948 _check_payment_method_line_id
    {
      fields: ["payment_method_line_id"],
      fn: async (env, ids) => {
        for (const id of ids) {
          const rec = new DbRec(env, env.reg.model("account.payment"), id);
          const line = await rec.rel("payment_method_line_id");
          if (!line) throw new ValidationError(translate(env, "Please define a payment method line on your payment."));
          const journal = await line.get("journal_id");
          if (journal && journal !== (await rec.get("journal_id"))) throw new ValidationError(translate(env, "The selected payment method is not available for this payment, please select the payment method again."));
        }
      },
    },
    // account_payment.py:950-958 _check_move_id
    {
      fields: ["state", "move_id"],
      fn: async (env, ids) => {
        for (const id of ids) {
          const rec = new DbRec(env, env.reg.model("account.payment"), id);
          if (!["draft", "canceled"].includes(String(await rec.get("state"))) && !(await rec.get("move_id")) && (await rec.get("outstanding_account_id"))) {
            throw new ValidationError(translate(env, "A payment with an outstanding account cannot be confirmed without having a journal entry."));
          }
        }
      },
    },
  ],
  // the stored computes behind the non stored available_payment_method_line_ids: fields.py triggers are transitive through
  // it (journal_id -> payment_method_line_id -> outstanding_account_id), so a partner change recomputes them
  write: async (env, ids, vals, next) => {
    if (!["partner_id", "journal_id", "payment_type", "company_id"].some((f) => f in vals)) { await next(env, ids, vals); return; }
    await trackPrepare(env, "account.payment", ids);
    await next(env, ids, vals);
    const def = env.reg.model("account.payment");
    for (const id of ids) {
      const sudoEnv = env.sudo();
      if (!("payment_method_line_id" in vals)) {
        const line = await recordCompute("account.payment", "payment_method_line_id")!(sudoEnv, new DbRec(sudoEnv, def, id));
        await updateRow(env, "account_payment", id, { payment_method_line_id: line });
      }
      const outstanding = await recordCompute("account.payment", "outstanding_account_id")!(sudoEnv, new DbRec(sudoEnv, def, id));
      await updateRow(env, "account_payment", id, { outstanding_account_id: outstanding });
    }
    for (const h of hooksOf("account.payment").write ?? []) if (h.afterWrite) await h.afterWrite(env, ids, {}, new Map());
  },
  // account_payment.py:964-1009 create: no reconciliation without accounting, so the outstanding account is forced
  // (`_get_invoice_in_payment_state` is 'paid'); write-off, forced balance and line hacks are not ported
  create: async (env, valsList, next) => {
    for (const vals of valsList) {
      if (["write_off_line_vals", "force_balance", "line_ids"].some((k) => k in vals)) throw new NotPorted("account.payment.create with journal entry values");
    }
    const ids = await next(env, valsList);
    for (const id of ids) {
      const rec = new DbRec(env, env.reg.model("account.payment"), id);
      if (await rec.get("outstanding_account_id")) continue;
      const account = await outstandingAccount(env, Number(await rec.get("company_id")), String(await rec.get("payment_type")));
      // the creation discarded the tracking of this record (mail_thread.py:402)
      await updateRow(env, "account_payment", id, { outstanding_account_id: account });
    }
    return ids;
  },
});

export interface PaymentPlan {
  /** columns of the payment row given by the caller (a transaction's payment) */
  extra?: Record<string, unknown>;
  date: string; amount: number; type: string; partnerType: unknown; memo: string | null; journal: number; company: number; currency: number;
  partner: number | null; commercial: number | null; partnerBank: number | null; methodLine: Rec; account: number; accountType: string;
  writeOff: { name: string | null; account_id: number; partner_id: number | null; currency_id: number; amount_currency: number; balance: number;
    tax_ids?: number[]; tax_tag_ids?: number[]; tax_repartition_line_id?: number | null; price_total?: number }[];
  lines: LineRow[]; moves: number[];
}

/** `_get_payment_display_partner` (account_payment_register.py:1063-1067): the moves' partner when there is one. */
async function displayPartner(env: Environment, moves: readonly number[], fallback: number | null): Promise<number | null> {
  const display = (await env.cr.query<{ p: number | null }>("SELECT DISTINCT partner_id AS p FROM account_move WHERE id = ANY($1::int[])", [[...moves]])).rows;
  return display.length === 1 && display[0]!.p ? display[0]!.p : fallback;
}

const commercialOf = async (env: Environment, partner: number | null): Promise<number | null> =>
  partner === null ? null : (await env.cr.query<{ c: number | null }>("SELECT commercial_partner_id AS c FROM res_partner WHERE id = $1", [partner])).rows[0]?.c ?? null;

/** :1069-1127 `_create_payment_vals_from_wizard` (the edit mode): one payment from the wizard's values. */
async function planFromWizard(env: Environment, rec: Rec, batch: Batch): Promise<PaymentPlan> {
  const difference = Number((await rec.get("payment_difference")) ?? 0);
  // "Mark as fully paid" adds a write-off line for the difference
  const company0 = Number(await rec.get("company_id")), currency0 = Number(await rec.get("currency_id"));
  const writeOff: PaymentPlan["writeOff"] = [];
  if ((await rec.get("payment_difference_handling")) === "reconcile") {
    const cur = await currencyData(env, currency0);
    if (await rec.get("early_payment_discount_mode")) {
      // :1086-1101 the early payment discount's write-off lines of the eligible moves' lines (base and tax lines)
      const { epdWriteOff } = await import("./account_epd");
      const companyCur = (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [company0])).rows[0]!.c;
      if (currency0 !== companyCur) throw new NotPorted("action_create_payments with an early payment discount in a foreign currency");
      const payDate = String(await rec.get("payment_date"));
      let open = (await rec.get("payment_type")) === "outbound" ? -difference : difference;
      const bases: EpdLine[] = [], taxes: EpdLine[] = [];
      for (const l of batch.lines) {
        const m = (await env.cr.query<{ early: boolean | null; currency: number; type: string; inv: string | null; dd: string | null; matched: boolean }>(
          `SELECT t.early_discount AS early, m.currency_id AS currency, m.move_type AS type, m.invoice_date::text AS inv,
                  (SELECT x.discount_date::text FROM account_move_line x WHERE x.move_id = m.id AND x.display_type = 'payment_term' ORDER BY x.date_maturity NULLS FIRST, x.id LIMIT 1) AS dd,
                  EXISTS (SELECT 1 FROM account_move_line x JOIN account_partial_reconcile p ON p.debit_move_id = x.id OR p.credit_move_id = x.id
                           WHERE x.move_id = m.id AND x.display_type = 'payment_term') AS matched
             FROM account_move m LEFT JOIN account_payment_term t ON t.id = m.invoice_payment_term_id WHERE m.id = $1`, [l.move_id])).rows[0]!;
        const eligible = Boolean(m.early && m.currency === currency0 && ["out_invoice", "out_receipt", "in_invoice", "in_receipt"].includes(m.type)
          && (!m.inv || (m.dd !== null && payDate <= m.dd)) && !m.matched);
        if (!eligible) continue;
        for (const w of await epdWriteOff(env, l.id)) {
          (w.tax_repartition_line_id === null ? bases : taxes).push(w);
          open -= w.balance;
        }
      }
      // :5437-5455 an exchange difference line for what the discount leaves open
      if (Math.abs(roundPrecision(open, cur.rounding)) >= cur.rounding) throw new NotPorted("early payment discount with an exchange difference line");
      // :5457-5467 the lines of the same grouping are summed across the moves: one move here
      if (batch.moves.length !== 1) throw new NotPorted("early payment discount over several invoices");
      for (const w of [...bases, ...taxes]) {
        writeOff.push({ name: w.name, account_id: w.account_id, partner_id: w.partner_id, currency_id: w.currency_id, amount_currency: w.amount_currency, balance: w.balance,
          tax_ids: w.tax_ids, tax_tag_ids: w.tax_tag_ids, tax_repartition_line_id: w.tax_repartition_line_id, price_total: w.price_total });
      }
    } else if (Math.abs(roundPrecision(difference, cur.rounding)) >= cur.rounding) {
      if (await rec.get("writeoff_is_exchange_account")) throw new NotPorted("action_create_payments with a write-off on an exchange account (force_balance, forced rate)");
      const account = Number(await rec.get("writeoff_account_id"));
      if (!account) throw new NotPorted("action_create_payments with a write-off without an account");
      const amountCurrency = (await rec.get("payment_type")) === "inbound" ? difference : -difference;
      const commercial0 = await commercialOf(env, (await rec.get("partner_id")) as number | null);
      const companyCur = (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [company0])).rows[0]!.c;
      const label = await rec.get("writeoff_label");
      writeOff.push({
        name: typeof label === "string" && label ? label : null, account_id: account, partner_id: commercial0, currency_id: currency0, amount_currency: amountCurrency,
        balance: await convertAmount(env, amountCurrency, currency0, companyCur, company0, String(await rec.get("payment_date"))),
      });
    }
  }
  const methodLine = await rec.rel("payment_method_line_id");
  if (!methodLine || methodLine.origin === null) throw new NotPorted("action_create_payments without a payment method");
  const partner = await displayPartner(env, batch.moves, batch.partner_id);
  return {
    date: String(await rec.get("payment_date")), amount: Number(await rec.get("amount")), type: String(await rec.get("payment_type")),
    partnerType: await rec.get("partner_type"), memo: ((await rec.get("communication")) || null) as string | null,
    journal: Number(await rec.get("journal_id")), company: Number(await rec.get("company_id")), currency: Number(await rec.get("currency_id")),
    partner, commercial: await commercialOf(env, partner), partnerBank: ((await rec.get("partner_bank_id")) as number | null) || null, methodLine,
    account: batch.account_id, accountType: batch.lines[0]!.account_type, writeOff, lines: batch.lines, moves: batch.moves,
  };
}

/**
 * :1130-1185 `_create_payment_vals_from_batch` for the batches of `_create_payments` (:1325-1346) without grouping: one
 * payment per move, of the move's residual, with its reference as memo.
 */
async function plansPerMove(env: Environment, rec: Rec, batch: Batch): Promise<PaymentPlan[]> {
  if ((await rec.get("installments_mode")) !== "full") throw new NotPorted("action_create_payments of installments without grouping");
  // a new request reads `line_ids._origin` from the database: account.move.line `_order` (account_move_line.py:33)
  const order = (await env.cr.query<{ id: number }>(
    "SELECT id FROM account_move_line WHERE id = ANY($1::int[]) ORDER BY date DESC, move_name DESC, id", [batch.lines.map((l) => l.id)])).rows.map((r) => r.id);
  const lines = order.map((id) => batch.lines.find((l) => l.id === id)!);
  const subs = new Map<number, LineRow[]>();
  for (const l of lines) subs.set(l.move_id, [...(subs.get(l.move_id) ?? []), l]);
  const journal = Number(await rec.get("journal_id"));
  const methodLine = await rec.rel("payment_method_line_id");
  if (!methodLine || methodLine.origin === null) throw new NotPorted("action_create_payments without a payment method");
  const plans: PaymentPlan[] = [];
  for (const [move, sub] of subs) {
    // `payment_type` of the sub-batch: its first line's balance (:1337-1340)
    const type = sub[0]!.balance > 0 ? "inbound" : "outbound";
    if (type !== (await methodLine.get("payment_type"))) throw new NotPorted("action_create_payments with a move of the other direction (another payment method line)");
    // :1133-1136 the journal's bank account for an inbound payment, else the batch's; an empty one is computed by the payment
    const partnerBank = type === "inbound"
      ? (await env.cr.query<{ b: number | null }>("SELECT bank_account_id AS b FROM account_journal WHERE id = $1", [journal])).rows[0]?.b ?? null
      : batch.partner_bank_id;
    if (!partnerBank) throw new NotPorted("action_create_payments without a bank account (account.payment._compute_partner_bank_id)");
    const residual = sub.reduce((t, l) => t + l.amount_residual, 0);
    const residualCurrency = sub.reduce((t, l) => t + l.amount_residual_currency, 0);
    const companyCurrency = sub[0]!.company_currency_id;
    const partner = await displayPartner(env, [move], batch.partner_id);
    plans.push({
      date: String(await rec.get("payment_date")), amount: Math.abs(batch.currency_id === companyCurrency ? residual : residualCurrency), type,
      partnerType: batch.partner_type, memo: (await communicationOf(env, [move], batch.company_id)) || null, journal, company: Number(await rec.get("company_id")),
      currency: batch.currency_id, partner, commercial: await commercialOf(env, partner), partnerBank, methodLine,
      account: sub[0]!.account_id, accountType: sub[0]!.account_type, writeOff: [], lines: sub, moves: [move],
    });
  }
  return plans;
}

registerMethod("account.payment.register", "action_create_payments", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  if (ids?.length !== 1) throw new NotPorted("action_create_payments on several wizards");
  const rec = new DbRec(env, env.reg.model("account.payment.register"), ids[0]!);
  const batch = await batchOf(env, rec);
  if (batch.lines.some((l) => l.parent_state === "draft")) throw new NotPorted("register payment on a draft move");
  // :1312 the edit mode: one batch (can_edit_wizard) of one line, or grouped
  const editMode = batch.lines.length === 1 || !!(await rec.get("group_payment"));
  const plans = editMode ? [await planFromWizard(env, rec, batch)] : await plansPerMove(env, rec, batch);
  const payments = await createPaymentsFromPlans(env, plans);
  if (env.context["dont_redirect_to_payments"]) return true;
  const action: Record<string, unknown> = { name: translate(env, "Payments"), type: "ir.actions.act_window", res_model: "account.payment", context: { create: false } };
  // :1404-1414 one payment opens its form, several a list
  if (payments.length === 1) return { ...action, view_mode: "form", res_id: payments[0] };
  return { ...action, view_mode: "list,form", domain: [["id", "in", payments]] };
}, { apiModel: false });

/**
 * The payments of the plans as account_payment_register.py:1187-1293 `_init_payments`, `_post_payments` and
 * `_reconcile_payments` create them (also account_payment's `_create_payment` of a transaction, src/models/payment_flow.ts:
 * one payment of its invoices, `extra` its own columns): each payment with its journal entry, posted, reconciled with
 * the plan's lines, and its state.
 */
export async function createPaymentsFromPlans(env: Environment, plans: readonly PaymentPlan[]): Promise<number[]> {
  // :1187-1247 `_init_payments`: the payments, each generating its journal entry (account_payment.py:965-1003)
  const prepared: { plan: PaymentPlan; payment: number; signed: number; signedCompany: number; companyCurrency: number; outstanding: number }[] = [];
  for (const plan of plans) {
    const { type, amount, currency, company, date, journal, commercial } = plan;
    const outstanding = Number((await plan.methodLine.get("payment_account_id")) || await outstandingAccount(env, company, type));
    const signed = type === "inbound" ? amount : -amount;
    // account_payment.py:582-594 `_compute_amount_company_currency_signed` and :870-935 `_prepare_move_line_default_vals`:
    // the liquidity line's balance is the amount converted at the payment date
    const companyCurrency = plan.lines[0]!.company_currency_id;
    const signedCompany = currency === companyCurrency ? signed : await convertAmount(env, signed, currency, companyCurrency, company, date);
    // account_payment.py:604-629 `_compute_available_partner_bank_ids` / `_compute_return_partner_bank_id`: the first of the
    // commercial partner's active bank accounts of the company (inbound), else the journal's bank account (outbound)
    const returnBank = type === "inbound"
      ? (await env.cr.query<{ id: number }>(
        "SELECT id FROM res_partner_bank WHERE partner_id = $1 AND active AND (company_id IS NULL OR company_id = $2) ORDER BY sequence, id LIMIT 1", [commercial, company])).rows[0]?.id ?? null
      : (await env.cr.query<{ b: number | null }>("SELECT bank_account_id AS b FROM account_journal WHERE id = $1", [journal])).rows[0]?.b ?? null;
    const payment = await insertRow(env, "account_payment", {
      ...(plan.extra ?? {}),
      return_partner_bank_id: returnBank,
      date, amount, payment_type: type, partner_type: plan.partnerType, memo: plan.memo, journal_id: journal, company_id: company, currency_id: currency,
      partner_id: plan.partner, commercial_partner_id: commercial, partner_bank_id: plan.partnerBank, payment_method_line_id: plan.methodLine.origin,
      payment_method_id: (await plan.methodLine.get("payment_method_id")) || null, destination_account_id: plan.account, outstanding_account_id: outstanding,
      amount_company_currency_signed: signedCompany, state: "draft", is_matched: false, is_reconciled: false,
    });
    prepared.push({ plan, payment, signed, signedCompany, companyCurrency, outstanding });
  }
  await mailAfterCreate(env, "account.payment", prepared.map((p) => p.payment), prepared.map((p) => ({ partner_id: p.plan.partner, journal_id: p.plan.journal })));
  const entries: EntryVals[] = [];
  for (const { plan, payment, signed, signedCompany, outstanding } of prepared) {
    const { memo, commercial } = plan;
    const lineName = memo ? `${String(await plan.methodLine.get("name"))}: ${String(memo)}` : String(await plan.methodLine.get("name"));
    const wb = plan.writeOff.reduce((t, w) => t + w.balance, 0), wc = plan.writeOff.reduce((t, w) => t + w.amount_currency, 0);
    entries.push({
      ref: memo === null ? null : String(memo), date: plan.date, journal_id: plan.journal, company_id: plan.company, partner_id: commercial, currency_id: plan.currency,
      partner_bank_id: plan.partnerBank, origin_payment_id: payment,
      // account_payment.py `_prepare_move_lines_per_type`: the counterpart takes what the write-off lines do not
      lines: [
        { name: lineName, account_id: outstanding, partner_id: commercial, balance: signedCompany, amount_currency: signed, payment_id: payment, date_maturity: plan.date },
        { name: lineName, account_id: plan.account, partner_id: commercial, balance: -signedCompany - wb, amount_currency: -signed - wc, payment_id: payment, date_maturity: plan.date },
        ...plan.writeOff.map((w) => ({ name: w.name, account_id: w.account_id, partner_id: w.partner_id, balance: w.balance, amount_currency: w.amount_currency, currency_id: w.currency_id, payment_id: payment, date_maturity: null,
          tax_ids: w.tax_ids ?? [], tax_tag_ids: w.tax_tag_ids ?? [], tax_repartition_line_id: w.tax_repartition_line_id ?? null, price_total: w.price_total ?? w.amount_currency })),
      ],
    });
  }
  // :1249-1262 `_post_payments`: the entries posted together
  const moves = await createPostedEntries(env, entries);
  for (const [i, { plan, payment }] of prepared.entries()) {
    await updateRow(env, "account_payment", payment, { move_id: moves[i], state: "paid", name: (await moveRow(env, moves[i]!)).name });
    // _post: the entry's receivable/payable partners get their rank (account_move.py:6364-6377)
    if (plan.commercial !== null) await increaseRank(env, plan.commercial, plan.account && plan.accountType === "asset_receivable" ? "customer_rank" : "supplier_rank");
  }
  // :1264-1293 `_reconcile_payments`, payment by payment: per account of the payment's open receivable/payable lines,
  // those lines with the batch's (`reconcile()`); the tracking is logged at precommit (`finalizeTracking`)
  const defer: TrackingDefer = { states: new Map(), later: [] };
  const trackOrder: number[] = [];
  for (const [i, { plan, payment }] of prepared.entries()) {
    const payLines = (await env.cr.query<{ id: number; account_id: number }>(
      `SELECT l.id, l.account_id FROM account_move_line l JOIN account_account a ON a.id = l.account_id
        WHERE l.move_id = $1 AND l.parent_state = 'posted' AND a.account_type IN ('asset_receivable', 'liability_payable') AND NOT COALESCE(l.reconciled, FALSE)
        ORDER BY l.id`, [moves[i]])).rows;
    for (const account of [...new Set(payLines.map((l) => l.account_id))]) {
      const ids = [...payLines.filter((l) => l.account_id === account).map((l) => l.id), ...plan.lines.filter((l) => l.account_id === account).map((l) => l.id)];
      const group = (await linesById(env, ids)).filter((l) => !l.reconciled);
      trackOrder.push(...await reconcileLines(env, group, defer));
    }
    // :1293 `lines.move_id.matched_payment_ids = [Command.link(payment.id)]`: an account.move write, which marks the
    // invoices manually modified (account_move.py:4083-4084)
    for (const m of plan.moves) {
      await env.cr.query("INSERT INTO account_move__account_payment (invoice_id, payment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [m, payment]);
      if (!env.context["skip_is_manually_modified"]) await updateRow(env, "account_move", m, { is_manually_modified: true });
    }
  }
  // at once, or when an owner of the precommit hooks returns (the payment flow's post-processing)
  await addPrecommit(env.cr, () => finalizeTracking(env, defer, trackOrder));
  // sale account_move.py:181-190 `_invoice_paid_hook`: in refreshMoveResidual (account_entries.ts) when an invoice becomes paid
  // account_payment.py:495-518 `_compute_state` and :520-548 `_compute_reconciliation_status`
  for (const [i, { plan, payment, companyCurrency, outstanding }] of prepared.entries()) {
    const payLines = (await env.cr.query<{ id: number }>("SELECT id FROM account_move_line WHERE move_id = $1 ORDER BY id", [moves[i]])).rows.map((r) => r.id);
    const [liq, cp] = await linesById(env, payLines) as [LineRow, LineRow];
    const rounding = (await currencyData(env, plan.currency)).rounding;
    const zero = (v: number): boolean => Math.abs(roundPrecision(v, rounding)) < rounding;
    // account_payment.py:539 the residual in the payment's currency
    const residualOf = (l: LineRow): number => (plan.currency === companyCurrency ? l.amount_residual : l.amount_residual_currency);
    const accountType = (await env.cr.query<{ t: string }>("SELECT account_type AS t FROM account_account WHERE id = $1", [outstanding])).rows[0]?.t;
    const docsPaid = (await env.cr.query<{ s: string }>(
      "SELECT m.payment_state AS s FROM account_move__account_payment r JOIN account_move m ON m.id = r.invoice_id WHERE r.payment_id = $1", [payment])).rows.every((r) => r.s === "paid");
    const defaultAccount = (await env.cr.query<{ a: number | null }>("SELECT default_account_id AS a FROM account_journal WHERE id = $1", [plan.journal])).rows[0]?.a;
    await updateRow(env, "account_payment", payment, {
      state: zero(liq.amount_residual) || (accountType !== "asset_cash" && docsPaid) ? "reconciled" : "paid",
      is_reconciled: zero(residualOf(cp)), is_matched: defaultAccount === outstanding || zero(residualOf(liq)),
    });
  }
  return prepared.map((p) => p.payment);
}

// The @api.onchange methods (models.py:594 getmembers order), account_payment_register.py:735-770.
const isZero = (v: number, rounding: number): boolean => Math.abs(roundPrecision(v, rounding)) < rounding; // res.currency is_zero
registerOnchange("account.payment.register", "_onchange_amount", ["amount"], async (env, rec) => {
  const currency = await rec.get("currency_id");
  if (!(await rec.get("can_edit_wizard")) || !currency) return;
  const t = await totals(env, rec, await batchOf(env, rec));
  const amount = Number((await rec.get("amount")) ?? 0);
  const { rounding } = await currencyData(env, Number(currency));
  const custom = [t.amount_by_default, t.amount_for_difference, t.full_amount, t.full_amount_for_difference].every((v) => !isZero(amount - v, rounding));
  await rec.set("custom_user_amount", custom ? amount : null);
  await rec.set("custom_user_currency_id", custom ? currency : null);
});
registerOnchange("account.payment.register", "_onchange_currency_id", ["currency_id"], async (env, rec) => {
  const custom = Number((await rec.get("custom_user_amount")) ?? 0);
  if (!(await rec.get("can_edit_wizard")) || !(await rec.get("currency_id")) || !(await rec.get("payment_date")) || !custom) return;
  const from = await rec.get("custom_user_currency_id");
  if (typeof from !== "number") throw new NotPorted("account.payment.register currency change without the custom amount's currency");
  const value = await convertAmount(env, custom, from, Number(await rec.get("currency_id")), Number(await rec.get("company_id")), String(await rec.get("payment_date")));
  await rec.set("custom_user_amount", value);
  await rec.set("amount", value);
});
registerOnchange("account.payment.register", "_onchange_payment_date", ["payment_date"], async (_env, rec) => {
  const custom = await rec.get("custom_user_amount");
  if (!(await rec.get("can_edit_wizard")) || !(await rec.get("currency_id")) || !(await rec.get("payment_date")) || !custom) return;
  await rec.set("amount", custom);
});
