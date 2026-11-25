/**
 * account.bank.statement.line and account.bank.statement `create` (account/models/account_bank_statement_line.py:363-421,
 * account_bank_statement.py:466-475) with their stored computes, as account's demo data (account_demo.py:335-411) and
 * an import create them: lines in the journal's currency, the default journal items (liquidity and suspense), the
 * move posted unless `from_statement_view`. Written directly as the other accounting creates are
 * (src/models/account_entries.ts); foreign currencies, given journal items, counterpart accounts and statements without
 * their name and balances refuse.
 */
import { NotPorted, UserError } from "../errors";
import { pyFloatRepr } from "../http/json";
import { lookupMethod } from "../http/methods";
import { create } from "../orm/create";
import { noteCreated } from "../orm/created";
import type { Environment } from "../orm/types";
import { registerOverrides, write } from "../orm/write";
import { registerRecordCompute, type Rec } from "../orm/recompute";
import { insertRow, updateRow } from "./account_entries";
import { createStatementMoveLines } from "./account_move_create";
import { translate } from "./util";

type Row = Record<string, unknown>;

/** The values a statement line is created with here (stored on the line, or the move's through `_inherits`). */
const LINE_KEYS = new Set(["journal_id", "payment_ref", "amount", "date", "partner_id", "partner_name", "statement_id", "sequence", "account_number",
  "transaction_type", "ref", "narration", "move_type", "name", "foreign_currency_id", "amount_currency"]);
/** The line's own columns among them (the others are account.move's, `_inherits`). */
const OWN = ["payment_ref", "amount", "partner_id", "partner_name", "statement_id", "sequence", "account_number", "transaction_type"];
/** xmlrpc.client.MAXINT, the sequence's complement in `internal_index` (:226-247). */
const MAXINT = 2147483647;

const num = (v: unknown): number | null => (typeof v === "number" && v ? v : null);

async function one<T>(env: Environment, sql: string, params: unknown[]): Promise<T> {
  const r = (await env.cr.query<T & Row>(sql, params)).rows[0];
  if (r === undefined) throw new TypeError(`no row for ${sql}`);
  return r;
}

/** :195-213 `_compute_is_reconciled` (amount_residual with it, `_get_statement_line_residual_amounts` :563-581). */
async function reconciledState(env: Environment, lineId: number): Promise<{ amount_residual: number; is_reconciled: boolean }> {
  const st = await one<{ amount: number; foreign: number | null; amount_currency: number; review: string | null; suspense: number | null; liquidity: number | null; rounding: number }>(env,
    `SELECT l.amount::float8 AS amount, l.foreign_currency_id AS foreign, COALESCE(l.amount_currency, 0)::float8 AS amount_currency, m.review_state AS review,
            j.suspense_account_id AS suspense, j.default_account_id AS liquidity, c.rounding::float8 AS rounding
       FROM account_bank_statement_line l JOIN account_move m ON m.id = l.move_id JOIN account_journal j ON j.id = l.journal_id
       JOIN res_currency c ON c.id = l.currency_id WHERE l.id = $1`, [lineId]);
  const lines = (await env.cr.query<{ account_id: number | null; residual: number }>(
    "SELECT account_id, amount_residual_currency::float8 AS residual FROM account_move_line WHERE move_id = (SELECT move_id FROM account_bank_statement_line WHERE id = $1) ORDER BY id", [lineId])).rows;
  const suspense = lines.filter((l) => l.account_id !== st.liquidity && l.account_id === st.suspense);
  if (st.review === "todo" || st.review === "anomaly") throw new NotPorted("bank statement line residual of a move to review");
  const residual = suspense.reduce((s, l) => s + l.residual, 0);
  const zero = (v: number): boolean => Math.abs(Math.round(v / st.rounding) * st.rounding) < st.rounding / 2;
  // a suspense line decides; otherwise the entry seems reconciled (a zero amount too)
  return { amount_residual: residual, is_reconciled: suspense.length ? zero(residual) : true };
}

/** A stored record of the model (the computes below read the database; a record in edition refuses). */
function storedId(rec: Rec, what: string): number {
  if (rec.origin === null || rec.id === null) throw new NotPorted(`${what} of a record in edition`);
  return rec.origin;
}

/** :226-247 `_compute_internal_index`: the date, the sequence's complement and the id. */
async function internalIndex(env: Environment, id: number): Promise<string | null> {
  const r = (await env.cr.query<{ date: string | null; sequence: number }>(
    "SELECT to_char(m.date, 'YYYYMMDD') AS date, COALESCE(l.sequence, 0) AS sequence FROM account_bank_statement_line l JOIN account_move m ON m.id = l.move_id WHERE l.id = $1", [id])).rows[0];
  if (!r?.date) throw new NotPorted("account.bank.statement.line internal_index without a date");
  return `${r.date}${String(MAXINT - r.sequence).padStart(10, "0")}${String(id).padStart(10, "0")}`;
}

/** The journal's currency, else its company's (:177-180, account_bank_statement.py:107-109). */
async function journalCurrency(env: Environment, journal: number | null): Promise<number | null> {
  if (journal === null) return null;
  return (await one<{ c: number }>(env, "SELECT COALESCE(j.currency_id, c.currency_id) AS c FROM account_journal j JOIN res_company c ON c.id = j.company_id WHERE j.id = $1", [journal])).c;
}

registerRecordCompute("account.bank.statement.line", {
  internal_index: async (env, rec) => internalIndex(env, storedId(rec, "account.bank.statement.line.internal_index")),
  currency_id: async (env, rec) => journalCurrency(env, num(await rec.get("journal_id"))),
  amount_currency: async (_env, rec) => {
    if (await rec.get("foreign_currency_id")) throw new NotPorted("account.bank.statement.line amount_currency in a foreign currency");
    return 0.0; // False, stored 0.0
  },
  amount_residual: async (env, rec) => (await reconciledState(env, storedId(rec, "account.bank.statement.line.amount_residual"))).amount_residual,
  is_reconciled: async (env, rec) => (await reconciledState(env, storedId(rec, "account.bank.statement.line.is_reconciled"))).is_reconciled,
});

/** The statement's computed columns from its lines (account_bank_statement.py:155-221). */
async function statementState(env: Environment, id: number): Promise<Row> {
  const rows = (await env.cr.query<{ internal_index: string | null; state: string; date: string; amount: number; journal_id: number }>(
    `SELECT l.internal_index, m.state, m.date::text AS date, l.amount::float8 AS amount, l.journal_id FROM account_bank_statement_line l JOIN account_move m ON m.id = l.move_id
      WHERE l.statement_id = $1 ORDER BY l.internal_index`, [id])).rows;
  const st = await one<{ balance_start: number; balance_end_real: number; date: string | null; journal_id: number | null }>(env,
    "SELECT COALESCE(balance_start, 0)::float8 AS balance_start, COALESCE(balance_end_real, 0)::float8 AS balance_end_real, date::text AS date, journal_id FROM account_bank_statement WHERE id = $1", [id]);
  // :111-114 `_compute_journal_id`: the lines' journal
  const journals = [...new Set(rows.map((r) => r.journal_id))];
  if (journals.length > 1) throw new NotPorted("account.bank.statement with lines of several journals");
  const journal = journals[0] ?? null;
  const currency = await journalCurrency(env, journal);
  const indexed = rows.filter((r) => r.internal_index);
  const posted = indexed.filter((r) => r.state === "posted");
  const open = rows.filter((r) => r.state === "draft" || r.state === "posted");
  const balanceEnd = st.balance_start + open.reduce((s, r) => s + r.amount, 0);
  let complete = rows.length === 0;
  if (!complete && open.length && currency !== null) {
    // compare_amounts: equal once rounded to the currency
    const rounding = (await one<{ r: number }>(env, "SELECT rounding::float8 AS r FROM res_currency WHERE id = $1", [currency])).r;
    complete = Math.round((balanceEnd - st.balance_end_real) / rounding) === 0;
  }
  return {
    journal_id: journal, currency_id: currency, first_line_index: indexed[0]?.internal_index ?? null,
    date: posted.length ? posted[posted.length - 1]!.date : st.date, balance_end: balanceEnd, is_complete: complete,
  };
}

const statementCompute = (field: string) => async (env: Environment, rec: Rec): Promise<unknown> =>
  (await statementState(env, storedId(rec, `account.bank.statement.${field}`)))[field] ?? false;
registerRecordCompute("account.bank.statement", Object.fromEntries(
  ["journal_id", "currency_id", "first_line_index", "date", "balance_end", "is_complete"].map((f) => [f, statementCompute(f)])));

registerOverrides("account.bank.statement.line", {
  create: async (env, valsListIn, _next) => {
    const valsList: Row[] = [];
    for (const v0 of valsListIn) {
      const v: Row = { ...v0 };
      const extra = Object.keys(v).filter((k) => !LINE_KEYS.has(k));
      if (extra.length) throw new NotPorted(`account.bank.statement.line create with ${extra.join(", ")}`);
      // :366-374 the statement's journal
      if ("statement_id" in v && !("journal_id" in v) && v["statement_id"]) {
        const j = (await env.cr.query<{ j: number | null }>("SELECT journal_id AS j FROM account_bank_statement WHERE id = $1", [v["statement_id"]])).rows[0]?.j;
        if (j) v["journal_id"] = j;
      }
      // :376-382 a foreign currency equal to the journal's is dropped
      if (v["foreign_currency_id"] || v["amount_currency"]) throw new NotPorted("account.bank.statement.line in a foreign currency");
      v["move_type"] = "entry"; // :385
      if (!("amount" in v)) v["amount"] = 0; // :391-392
      valsList.push({ name: false, ...v }); // :394-397
    }
    if (valsList.some((v) => !v["journal_id"])) throw new NotPorted("account.bank.statement.line without a journal (default_get's _search_default_journal)");
    const senv = env.withContext({ ...env.context, is_statement_line: true });
    // models.py:4190-4209 `_inherits`: the moves first, in one create
    const moveVals = valsList.map((v) => Object.fromEntries(Object.entries(v).filter(([k]) => !OWN.includes(k))));
    const moves = await create(senv, "account.move", moveVals);
    const ids: number[] = [];
    for (let i = 0; i < valsList.length; i++) {
      const v = valsList[i]!;
      const m = await one<{ journal_id: number; company_id: number }>(env, "SELECT journal_id, company_id FROM account_move WHERE id = $1", [moves[i]]);
      const row: Row = { move_id: moves[i], journal_id: m.journal_id, company_id: m.company_id, sequence: 1 };
      for (const k of OWN) if (k in v) row[k] = v[k] === false ? null : v[k];
      // models.py:4370: `amount` with an empty record and no currency among the stored values: the plain float
      if (typeof row["amount"] === "number") row["amount"] = pyFloatRepr(row["amount"]);
      row["currency_id"] = await journalCurrency(env, m.journal_id); // :177-180
      row["is_reconciled"] = false; // a new record (:205-207), recomputed with the journal items below
      row["amount_residual"] = 0;
      const lineId = await insertRow(env, "account_bank_statement_line", row);
      // :160-170 no foreign currency: False, stored 0.0 (a monetary column of the foreign currency, none here)
      await env.cr.query("UPDATE account_bank_statement_line SET amount_currency = 0.0 WHERE id = $1", [lineId]);
      ids.push(lineId);
    }
    noteCreated(env.cr, "account.bank.statement.line", ids);
    const post: number[] = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!, moveId = moves[i]!;
      await updateRow(env, "account_bank_statement_line", id, { internal_index: await internalIndex(env, id) });
      // :402-404 the move points to its line (narration and name written again)
      const mv = await one<{ narration: string | null }>(env, "SELECT narration FROM account_move WHERE id = $1", [moveId]);
      // a translated narration (jsonb, l10n_gcc_invoice) is read in the environment's language in Odoo: not ported
      if (mv.narration !== null && typeof mv.narration !== "string") throw new NotPorted("bank statement line of a move with a translated narration");
      await write(senv.withContext({ ...senv.context, clear_sequence_mixin_cache: false }), "account.move", [moveId], { statement_line_id: id, narration: mv.narration ?? false, name: false });
      // :616-656 `_prepare_move_line_default_vals`
      const j = await one<{ name: string; suspense: number | null; liquidity: number | null; ccur: number; jcur: number | null }>(env,
        `SELECT j.name->>'en_US' AS name, j.suspense_account_id AS suspense, j.default_account_id AS liquidity, c.currency_id AS ccur, j.currency_id AS jcur
           FROM account_journal j JOIN res_company c ON c.id = j.company_id WHERE j.id = (SELECT journal_id FROM account_bank_statement_line WHERE id = $1)`, [id]);
      if (!j.suspense) throw new UserError(translate(env, "You can't create a new statement line without a suspense account set on the %s journal.").replace("%s", j.name));
      const line = await one<{ amount: number; payment_ref: string | null; partner_id: number | null }>(env,
        "SELECT amount::float8 AS amount, payment_ref, partner_id FROM account_bank_statement_line WHERE id = $1", [id]);
      const currency = j.jcur ?? j.ccur;
      if (currency !== j.ccur) throw new NotPorted("bank statement line of a journal in a foreign currency");
      const amount = line.amount;
      const base = { name: line.payment_ref ?? false, move_id: moveId, partner_id: line.partner_id ?? false, currency_id: currency };
      const lineIds = await createStatementMoveLines(env, moveId, [
        { ...base, account_id: j.liquidity ?? false, amount_currency: amount, debit: amount > 0 ? amount : 0.0, credit: amount < 0 ? -amount : 0.0 },
        { ...base, account_id: j.suspense, amount_currency: -amount, debit: amount < 0 ? -amount : 0.0, credit: amount > 0 ? amount : 0.0 },
      ]);
      // account_move_line.py: statement_line_id (related move_id.statement_line_id) and statement_id (related statement_line_id.statement_id)
      const sid = num((await one<{ s: number | null }>(env, "SELECT statement_id AS s FROM account_bank_statement_line WHERE id = $1", [id])).s);
      await env.cr.query("UPDATE account_move_line SET statement_line_id = $2, statement_id = $3 WHERE id = ANY($1::int[])", [lineIds, id, sid]);
      // account_move_line.py create -> `_synchronize_business_models({'line_ids'})` -> :743-836 `_synchronize_from_moves`:
      // the move takes the liquidity line's partner (its currency is the journal's already; unchanged values are dropped
      // by `_cleanup_write_orm_values`, and the line's own values are its liquidity line's)
      if (line.partner_id) {
        await write(senv.withContext({ ...senv.context, skip_readonly_check: true, skip_account_move_synchronization: true }), "account.move", [moveId], { partner_id: line.partner_id });
      }
      await updateRow(env, "account_bank_statement_line", id, await reconciledState(env, id));
      post.push(moveId);
    }
    // :411-416 posted unless created from the statement's form
    if (!env.context["from_statement_view"] && post.length) {
      const action = lookupMethod("account.move", "action_post");
      if (!action) throw new NotPorted("account.move action_post");
      // account_move.py:996 `_compute_name` numbers the posted moves by (date, ref, id); the port's `_post` names them
      // in the order given, and these entries have no other effect whose order shows
      const order = (await env.cr.query<{ id: number }>("SELECT id FROM account_move WHERE id = ANY($1::int[]) ORDER BY date, COALESCE(ref, ''), id", [post])).rows.map((r) => r.id);
      await action.fn(env, order, [], {}, "account.move");
    }
    return ids;
  },
});

/** The values a statement is created with here: its computed name and balances are given (account_demo.py:344-372). */
const STATEMENT_KEYS = new Set(["name", "reference", "balance_start", "balance_end_real", "attachment_ids", "line_ids", "is_statement_posted"]);

registerOverrides("account.bank.statement", {
  create: async (env, valsList, _next) => {
    const ids: number[] = [];
    for (const v of valsList) {
      const extra = Object.keys(v).filter((k) => !STATEMENT_KEYS.has(k));
      if (extra.length) throw new NotPorted(`account.bank.statement create with ${extra.join(", ")}`);
      for (const k of ["name", "balance_start", "balance_end_real"]) if (!(k in v)) throw new NotPorted(`account.bank.statement create without ${k} (its compute)`);
      const commands = (v["line_ids"] as unknown[][] | undefined) ?? [];
      if (commands.some((c) => !Array.isArray(c) || c[0] !== 0 || typeof c[2] !== "object")) throw new NotPorted("account.bank.statement line_ids commands other than create");
      const lines = commands.map((c) => c[2] as Row);
      // :111-114 `_compute_journal_id` (the lines' journal), :102-104 company (related), :107-109 currency
      const journals = [...new Set(lines.map((l) => l["journal_id"]))];
      if (journals.length !== 1 || typeof journals[0] !== "number") throw new NotPorted("account.bank.statement with lines of several journals or none");
      const j = await one<{ company: number; currency: number }>(env,
        "SELECT j.company_id AS company, COALESCE(j.currency_id, c.currency_id) AS currency FROM account_journal j JOIN res_company c ON c.id = j.company_id WHERE j.id = $1", [journals[0]]);
      // :74-78 `_check_attachments` (the attachments of LINK and SET commands)
      const attachments: number[] = [];
      for (const c of (v["attachment_ids"] as unknown[][] | undefined) ?? []) {
        if (c[0] === 4) attachments.push(Number(c[1]));
        else if (c[0] === 6) attachments.push(...((c[2] as number[]) ?? []).map(Number));
        else throw new NotPorted("account.bank.statement attachment_ids commands other than link and set");
      }
      // models.py:4370 `convert_to_column_insert(value, self, stored)`: the currency is not among the stored values
      // (a computed, not precomputed, field) and `self` is empty, so a balance is the plain float (fields_numeric.py:
      // 265-268), not rounded to the currency's places (KRW: 4253.0, not 4253)
      const plainFloat = (x: unknown): unknown => (typeof x === "number" ? pyFloatRepr(x) : x);
      const id = await insertRow(env, "account_bank_statement", {
        name: v["name"] || null, reference: v["reference"] || null, balance_start: plainFloat(v["balance_start"]), balance_end_real: plainFloat(v["balance_end_real"]),
        is_statement_posted: v["is_statement_posted"] ?? true, journal_id: journals[0], company_id: j.company, currency_id: j.currency,
      });
      noteCreated(env.cr, "account.bank.statement", [id]);
      for (const a of [...new Set(attachments)]) {
        await env.cr.query("INSERT INTO account_bank_statement_ir_attachment_rel (account_bank_statement_id, ir_attachment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [id, a]);
      }
      if (lines.length) await create(env, "account.bank.statement.line", lines.map((l) => ({ ...l, statement_id: id })));
      // :155-160 first_line_index, :162-167 date (the last posted line's), :193-197 balance_end, :218-221 is_complete
      await updateRow(env, "account_bank_statement", id, await statementState(env, id));
      // :470 the attachments move to the statement
      if (attachments.length) await write(env, "ir.attachment", [...new Set(attachments)], { res_id: id, res_model: "account.bank.statement" });
      if (env.context["from_statement_view"]) await updateRow(env, "account_bank_statement", id, { is_statement_posted: false });
      ids.push(id);
    }
    return ids;
  },
});
