/**
 * Journal entries of the Invoicing flows, restricted to documents in one currency (the company's): the entry of a
 * payment (account_payment.py:964-1010, :1145-1177, :353-428), its posting (account_move.py:6134-6393 with
 * sequence_mixin.py:427-449), the reconciliation of two journal items (account_move_line.py:3137-3300 with
 * `_compute_amount_residual` :1159-1219) and the stored amounts and payment state of the moves
 * (account_move.py:1195-1358). Rows are written as the ORM ends up leaving them, in one go; anything else (foreign
 * currencies, exchange differences, cash basis taxes, early payment discounts) refuses with NotPorted.
 */
import { NotPorted, UserError } from "../errors";
import { translate } from "./util";
import { hooksOf, registerHooks } from "../orm/hooks";
import * as D from "../orm/domain";
import { DbRec, NewRec } from "../orm/recompute";
import type { Environment, FieldDef, ModelDef } from "../orm/types";
import { floatRepr, floatRound, roundMonetary } from "../orm/convert";
import { computeAuthor, insertMessages, messageLogBatch, replyToDefault, trackingMessageId, xmlid } from "../mail/message";
import { flatThreadParent } from "../mail/thread_generic";
import { assertNoRecipients } from "../mail/post";
import { roundPrecision } from "./account_tax_engine";
import { currencyData } from "./account_taxes";
import { addressGet } from "./tail_util";
import { fiscalPositionFor } from "./sale_computes";
import { lockedNextSequence } from "./invoicing_computes";

import { pyFloatRepr } from "../http/json";
import { registerMethod } from "../http/methods";
import { checkModelAccess } from "../orm/access";
import { plainColumn } from "../orm/prefetch";
import { execute, sqlColumnType } from "../orm/sql";
import type { PendingValue } from "../pending_writes";
import { envFor } from "../web/common";
import { search, searchCount } from "../web/read_methods";
import { PySet } from "./pyset";
import { isRecordingWritten, markWritten, markWrittenTable } from "../orm/written_fields";
import { withSiteDefaults } from "../orm/site_defaults";

export type Row = Record<string, unknown>;

const NUMERIC_COLUMNS = new Map<string, Set<string>>();

/**
 * The numeric and float columns of a table: a JS number written there is sent as Python's repr(float) ("264.0"), as
 * psycopg2 sends the ORM's floats; a numeric column keeps the scale it is given ("264" would read back as an integer).
 */
async function numericColumns(env: Environment, table: string): Promise<Set<string>> {
  let cols = NUMERIC_COLUMNS.get(table);
  if (!cols) {
    cols = new Set((await env.cr.query<{ n: string }>(
      "SELECT attname AS n FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped AND atttypid IN ('numeric'::regtype, 'float8'::regtype)", [`"${table}"`])).rows.map((r) => r.n));
    NUMERIC_COLUMNS.set(table, cols);
  }
  return cols;
}

async function columnParams(env: Environment, table: string, vals: Row, cols: readonly string[], id: number | null): Promise<unknown[]> {
  const numeric = await numericColumns(env, table);
  const def = modelOfTable(env, table);
  const out: unknown[] = [];
  for (const c of cols) {
    const v = vals[c];
    const field = def?.fields.get(c);
    if (typeof v === "number" && field?.type === "monetary" && def) out.push(await monetaryColumn(env, def, field, v, vals, id));
    // fields_numeric.py:159-167 Float.convert_to_column: rounded and printed with the field's digits ("7.00")
    else if (typeof v === "number" && field?.type === "float" && field.digits && !field.companyDependent) out.push(floatRepr(floatRound(v, field.digits[1]), field.digits[1]));
    else out.push(typeof v === "number" && numeric.has(c) ? pyFloatRepr(v) : v);
  }
  return out;
}

const TABLE_MODELS = new WeakMap<object, Map<string, ModelDef>>();
function modelOfTable(env: Environment, table: string): ModelDef | undefined {
  let index = TABLE_MODELS.get(env.reg);
  if (!index) {
    index = new Map<string, ModelDef>();
    for (const d of env.reg.models.values()) if (!d.abstract && !index.has(d.table)) index.set(d.table, d);
    TABLE_MODELS.set(env.reg, index);
  }
  return index.get(table);
}

/**
 * fields_numeric.py:247-268 `Monetary.convert_to_column_insert`: the value rounded by the record's currency and printed
 * with its decimal places, the currency taken from the written values (also through the first step of a related
 * currency field) or else from the record (sudo). Summed floats (account_move.py:1212-1262 `_compute_amount`:
 * 200 + 33.33 = 233.32999999999998) are stored as Odoo stores them (233.33).
 */
async function monetaryColumn(env: Environment, def: ModelDef, field: FieldDef, value: number, vals: Row, id: number | null): Promise<string | number> {
  const cfName = field.currencyField ?? (def.fields.has("currency_id") ? "currency_id" : def.fields.has("x_currency_id") ? "x_currency_id" : null);
  const cf = cfName ? def.fields.get(cfName) : undefined;
  if (!cfName || !cf) throw new NotPorted(`monetary field ${def.name}.${field.name} without currency field`);
  const su = env.sudo();
  let currency: unknown = null;
  const head = cf.related?.split(".")[0];
  if (cfName in vals) currency = vals[cfName];
  else if (cf.related && head && head in vals) {
    let cur: unknown = vals[head];
    let model = def.fields.get(head)?.relation ?? null;
    for (const seg of cf.related.split(".").slice(1)) {
      if (typeof cur !== "number" || !model) { cur = null; break; }
      const d = su.reg.model(model);
      cur = await new DbRec(su, d, cur).get(seg);
      model = d.fields.get(seg)?.relation ?? null;
    }
    currency = cur;
  } else if (id !== null) currency = await new DbRec(su, def, id).get(cfName);
  else throw new NotPorted(`monetary column ${def.name}.${field.name} of a new row without its currency`);
  if (typeof currency !== "number") return pyFloatRepr(value);
  const row = (await env.cr.query<{ rounding: string }>("SELECT rounding FROM res_currency WHERE id = $1", [currency])).rows[0];
  if (row === undefined) return pyFloatRepr(value);
  const rounding = Number(row.rounding);
  const digits = Math.max(0, Math.ceil(Math.log10(1 / rounding))); // res_currency.py decimal_places
  return floatRepr(roundMonetary(value, rounding), digits);
}

/** INSERT of a row with the ORM's magic columns; values are given as they are stored. */
export async function insertRow(env: Environment, table: string, vals0: Row): Promise<number> {
  // the defaults of the site's new fields, which Odoo's create gives (orm/site_defaults.ts)
  const vals = await withSiteDefaults(env, table, vals0);
  const cols = Object.keys(vals);
  const params = await columnParams(env, table, vals, cols, null);
  const r = await env.cr.query<{ id: number }>(
    `INSERT INTO "${table}" (${[...cols.map((c) => `"${c}"`), "create_uid", "write_uid", "create_date", "write_date"].join(", ")})
     VALUES (${[...cols.map((_c, i) => `$${i + 1}`), `$${cols.length + 1}`, `$${cols.length + 1}`, "now() AT TIME ZONE 'UTC'", "now() AT TIME ZONE 'UTC'"].join(", ")})
     RETURNING id`, [...params, env.uid]);
  return r.rows[0]!.id;
}

/** UPDATE of stored columns with the ORM's write_uid/write_date. */
export async function updateRow(env: Environment, table: string, id: number, vals: Row): Promise<void> {
  const cols = Object.keys(vals);
  if (!cols.length) return;
  markWrittenTable(env, table, [id], [...cols, "write_uid", "write_date"]);
  const params = await columnParams(env, table, vals, cols, id);
  const def = modelOfTable(env, table);
  if (def && typeof env.cr.canBuffer === "function" && env.cr.canBuffer() && cols.every((c) => {
    const f = def.fields.get(c);
    return f !== undefined && f.column && !f.translate && !f.companyDependent;
  })) {
    const pendingCols = new Map<string, PendingValue>();
    const cacheCols = new Map<string, { readonly raw: unknown } | null>();
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i]!;
      const f = def.fields.get(c)!;
      const pgType = f.type === "float" && (f.digits !== null || (f.digitsRaw !== undefined && f.digitsRaw !== null)) ? "numeric" : sqlColumnType(f);
      pendingCols.set(c, { kind: "val", sqlVal: params[i], pgType });
      cacheCols.set(c, plainColumn(def, f) ? { raw: params[i] } : null);
    }
    pendingCols.set("write_uid", { kind: "val", sqlVal: env.uid, pgType: "int4" });
    cacheCols.set("write_uid", { raw: env.uid });
    pendingCols.set("write_date", { kind: "now" });
    cacheCols.set("write_date", null);
    env.cr.bufferUpdate(table, [[id, pendingCols]], [[id, cacheCols]]);
    return;
  }
  // nothing to read back: sent without waiting (src/orm/sql.ts execute)
  await execute(env,
    `UPDATE "${table}" SET ${cols.map((c, i) => `"${c}" = $${i + 2}`).join(", ")}, write_uid = $${cols.length + 2}, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1`,
    [id, ...params, env.uid]);
}

/** The mail.thread part of `create` on rows inserted directly (mail_thread.py:345-415 through the model's hooks). */
export async function mailAfterCreate(env: Environment, model: string, ids: number[], vals: Row[]): Promise<void> {
  for (const h of hooksOf(model).write ?? []) if (h.afterCreate) await h.afterCreate(env, ids, vals);
}

interface MoveRow {
  id: number; move_type: string; state: string; company_id: number; currency_id: number; partner_id: number | null; journal_id: number;
  date: string; ref: string | null; name: string | null; amount_total: number; amount_total_signed: number; amount_residual: number;
  payment_state: string | null; invoice_cash_rounding_id: number | null;
}
export async function moveRow(env: Environment, id: number): Promise<MoveRow> {
  const r = (await env.cr.query<MoveRow>(
    `SELECT id, move_type, state, company_id, currency_id, partner_id, journal_id, date::text AS date, ref, name, amount_total::float8 AS amount_total,
            amount_total_signed::float8 AS amount_total_signed, amount_residual::float8 AS amount_residual, payment_state, invoice_cash_rounding_id
       FROM account_move WHERE id = $1`, [id])).rows[0];
  if (!r) throw new NotPorted(`account.move ${id} missing`);
  return r;
}

export interface LineRow {
  id: number; move_id: number; account_id: number; partner_id: number | null; currency_id: number; company_id: number; company_currency_id: number;
  balance: number; amount_currency: number; amount_residual: number; amount_residual_currency: number; reconciled: boolean | null; date: string;
  date_maturity: string | null; display_type: string | null; name: string | null; account_type: string; account_reconcile: boolean | null;
  tax_line_id: number | null; parent_state: string | null; matching_number: string | null;
}
const LINE_SELECT = `SELECT l.id, l.move_id, l.account_id, l.partner_id, l.currency_id, l.company_id, l.company_currency_id, l.balance::float8 AS balance,
  l.amount_currency::float8 AS amount_currency, l.amount_residual::float8 AS amount_residual, l.amount_residual_currency::float8 AS amount_residual_currency,
  l.reconciled, l.date::text AS date, l.date_maturity::text AS date_maturity, l.display_type, l.name, a.account_type, a.reconcile AS account_reconcile,
  l.tax_line_id, l.parent_state, l.matching_number
  FROM account_move_line l JOIN account_account a ON a.id = l.account_id`;
export async function moveLines(env: Environment, moveId: number): Promise<LineRow[]> {
  return (await env.cr.query<LineRow>(`${LINE_SELECT} WHERE l.move_id = $1 ORDER BY l.sequence, l.id`, [moveId])).rows;
}
export async function linesById(env: Environment, ids: readonly number[]): Promise<LineRow[]> {
  const rows = (await env.cr.query<LineRow>(`${LINE_SELECT} WHERE l.id = ANY($1::int[])`, [[...ids]])).rows;
  return ids.map((id) => rows.find((r) => r.id === id)!).filter(Boolean);
}

const isZero = (v: number, rounding: number): boolean => v === 0 || Math.abs(roundPrecision(v, rounding)) < rounding;

/** account_move.py:1188-1193 `_compute_direction_sign`. */
export function directionSign(moveType: string): number {
  return moveType === "entry" || ["out_refund", "in_invoice", "in_receipt"].includes(moveType) ? 1 : -1;
}
const isInvoice = (t: string): boolean => ["out_invoice", "out_refund", "out_receipt", "in_invoice", "in_refund", "in_receipt"].includes(t);

/** The tracked `payment_state` change as `_track_finalize` posts it (mail_thread.py:628-690 with account_move.py:8076-8083). */
export async function postTracking(env: Environment, moveId: number, company: number, body: string, subtypeXmlid: string): Promise<void> {
  const [authorId, emailFrom] = await computeAuthor(env, null, null);
  const replyTo = await replyToDefault(env, emailFrom);
  await insertMessages(env, [{
    model: "account.move", res_id: moveId, body, author_id: authorId, email_from: emailFrom, message_type: "tracking", subject: false,
    subtype_id: await xmlid(env, subtypeXmlid), email_add_signature: true, record_company_id: company,
    parent_id: await flatThreadParent(env, "account.move", moveId), message_id: trackingMessageId("message-notify"), reply_to: replyTo,
  }]);
}


/** account_move.py:1265-1358 `_compute_payment_state` for a posted or draft invoice (receivable/payable lines). */
export async function paymentState(env: Environment, move: MoveRow, residual: number, rounding: number): Promise<string> {
  if (move.payment_state === "invoicing_legacy" || move.payment_state === "blocked") return move.payment_state;
  const qualifies = isInvoice(move.move_type) && (move.state === "posted" || (move.state === "draft" && !isZero(move.amount_total, rounding)));
  if (!qualifies) return "not_paid";
  const rows = (await env.cr.query<{ type: string; types: string[]; matched: boolean; has_payment: boolean; has_st_line: boolean }>(
    `SELECT account.account_type AS type, ARRAY_AGG(counterpart_move.move_type) AS types,
            COALESCE(BOOL_AND(COALESCE(pay.is_matched, FALSE)) FILTER (WHERE counterpart_move.origin_payment_id IS NOT NULL), TRUE) AS matched,
            BOOL_OR(COALESCE(BOOL(pay.id), FALSE)) AS has_payment, BOOL_OR(COALESCE(BOOL(counterpart_move.statement_line_id), FALSE)) AS has_st_line
       FROM account_partial_reconcile part
       JOIN account_move_line source_line ON source_line.id IN (part.debit_move_id, part.credit_move_id)
       JOIN account_account account ON account.id = source_line.account_id
       JOIN account_move_line counterpart_line ON counterpart_line.id = (CASE WHEN source_line.id = part.debit_move_id THEN part.credit_move_id ELSE part.debit_move_id END)
       JOIN account_move counterpart_move ON counterpart_move.id = counterpart_line.move_id
       LEFT JOIN account_payment pay ON pay.id = counterpart_move.origin_payment_id
      WHERE source_line.move_id = $1 AND counterpart_line.move_id != source_line.move_id
      GROUP BY source_line.id, account.account_type`, [move.id])).rows
    .filter((r) => r.type === "asset_receivable" || r.type === "liability_payable");
  if (isZero(residual, rounding)) {
    if (rows.some((r) => r.has_payment || r.has_st_line)) return "paid"; // `_get_invoice_in_payment_state` is 'paid' without accountant
    const reverse = new Set(rows.flatMap((r) => r.types));
    const only = (...t: string[]): boolean => reverse.size === t.length && t.every((x) => reverse.has(x));
    const inRev = ["in_invoice", "in_receipt"].includes(move.move_type) && (only("in_refund") || only("in_refund", "entry"));
    const outRev = ["out_invoice", "out_receipt"].includes(move.move_type) && (only("out_refund") || only("out_refund", "entry"));
    const miscRev = ["entry", "out_refund", "in_refund"].includes(move.move_type) && only("entry");
    return inRev || outRev || miscRev ? "reversed" : "paid";
  }
  const matchedPaid = (await env.cr.query(
    `SELECT 1 FROM account_move__account_payment r JOIN account_payment p ON p.id = r.payment_id
      WHERE r.invoice_id = $1 AND p.move_id IS NULL AND p.state IN ('paid', 'reconciled') LIMIT 1`, [move.id])).rows.length;
  if (move.state === "posted" && matchedPaid) throw new NotPorted("payment_state with matched payments without journal entry");
  return rows.length ? "partial" : "not_paid";
}

/**
 * account_move.py:1195-1263 `_compute_amount` for the residual fields of a move whose lines changed, then its
 * `payment_state` with the tracking of the change. The totals of an invoice do not change here.
 */
/**
 * Tracking collected during a reconciliation inside `_post` instead of logged: Odoo logs it at precommit, the moves
 * (prepared by the posting) before the payments.
 */
export interface TrackingDefer {
  readonly states: Map<number, [string, string]>; readonly later: (() => Promise<void>)[];
  /** the payments' tracking, finalized after the moves' and their lines' (round 11: an unreconciliation in `_post`) */
  readonly payments?: (() => Promise<void>)[];
}

export async function refreshMoveResidual(env: Environment, moveId: number, defer?: TrackingDefer): Promise<void> {
  const move = await moveRow(env, moveId);
  if (move.invoice_cash_rounding_id) throw new NotPorted("residual of an invoice with cash rounding");
  const cur = await currencyData(env, move.currency_id);
  const sign = directionSign(move.move_type);
  let reconciled = 0, reconciledCurrency = 0;
  const invoice = isInvoice(move.move_type);
  for (const l of await moveLines(env, moveId)) {
    if (invoice && l.display_type === "payment_term") {
      reconciled += l.balance - l.amount_residual;
      reconciledCurrency += l.amount_currency - l.amount_residual_currency;
    }
  }
  const totalCurrency = invoice ? move.amount_total : 0, total = invoice ? Math.abs(move.amount_total_signed) : 0;
  const residual = roundPrecision(totalCurrency + sign * reconciledCurrency, cur.rounding);
  const residualSigned = roundPrecision(-sign * total - reconciled, cur.rounding);
  const state = await paymentState(env, move, residual, cur.rounding);
  await updateRow(env, "account_move", moveId, { amount_residual: residual, amount_residual_signed: residualSigned, payment_state: state });
  if (["paid", "in_payment"].includes(state) && invoice && !["paid", "in_payment"].includes(move.payment_state ?? "not_paid")) {
    await invoicePaidHook(env, moveId); // account_move_line.py:3106-3110 `_reconcile_post_hook`
  }
  if (state === "paid" && invoice && state !== (move.payment_state ?? "not_paid")) await settleEarlierPayments(env, moveId, defer);
  const before = move.payment_state ?? "not_paid";
  if (state === before) return;
  // the caller logs the tracking with the rest of the move's changes (one message per move at precommit)
  if (defer) { defer.states.set(moveId, [defer.states.get(moveId)?.[0] ?? before, state]); return; }
  await logPaymentState(env, moveId, before, state);
}

/** The tracking value of `payment_state` (account_move.py:597 tracking=True) in the mail_tracking_template form. */
export function paymentStateTracking(env: Environment, from: string, to: string): string {
  return `${trackedSelection(env, "account.move", "payment_state", from)} → <b>${trackedSelection(env, "account.move", "payment_state", to)}</b> <i>(${trackedLabel(env, "account.move", "payment_state")})</i>`;
}

const escapeTracking = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The label of a tracked field in a tracking body (mail_track_mixin.py `_track_get_fields_info`: fields_get's `string`
 * in the environment's language), escaped. A language whose labels are not loaded refuses: English there would be a
 * silently wrong chatter line.
 */
export function trackedLabel(env: Environment, model: string, field: string): string {
  const f = env.reg.model(model).fields.get(field);
  if (!f) throw new NotPorted(`tracking label of ${model}.${field}`);
  const lang = env.lang ?? "en_US";
  const t = lang === "en_US" ? f.string : f.strings[lang];
  if (!t) throw new NotPorted(`tracking label of ${model}.${field} in ${lang}`);
  return escapeTracking(t);
}

/** A selection value's label in the environment's language for a tracking body (`dict(field._description_selection(env))`). */
export function trackedSelection(env: Environment, model: string, field: string, value: string): string {
  const sel = env.reg.model(model).fields.get(field)?.selection?.find((x) => x.value === value);
  if (!sel) throw new NotPorted(`tracking selection ${model}.${field} = ${value}`);
  const lang = env.lang ?? "en_US";
  const t = lang === "en_US" ? sel.label : sel.labels[lang];
  if (!t) throw new NotPorted(`tracking selection ${model}.${field} = ${value} in ${lang}`);
  return escapeTracking(t);
}

/** The tracking message of a payment_state change alone. */
export async function logPaymentState(env: Environment, moveId: number, from: string, to: string): Promise<void> {
  if (from === to) return;
  const move = await moveRow(env, moveId);
  const invoice = isInvoice(move.move_type);
  // `_track_log_get_default_subtype` (account_move.py:8076-8083): mt_invoice_paid when an invoice becomes paid
  const body = `<div>${paymentStateTracking(env, from, to)}\n</div>`;
  if (to === "paid" && invoice) await postTracking(env, moveId, move.company_id, body, "account.mt_invoice_paid");
  // mail.thread `_track_log_get_default_subtype` False: `_message_log` of the tracking (mail_thread.py _track_finalize)
  else if (invoice) await messageLogBatch(env, "account.move", new Map([[moveId, body]]), { messageType: "tracking" });
}

/**
 * sale account_move.py:181-190 `_invoice_paid_hook`: every sale order of the invoice's lines gets "Invoice %s paid"
 * through `message_post` (a plain text body is escaped, mt_note, mail_thread.py:2256-2420). Followers that would be
 * notified refuse (assertNoRecipients); several orders are posted in order id (Odoo iterates a set).
 */
async function invoicePaidHook(env: Environment, moveId: number): Promise<void> {
  const rows = (await env.cr.query<{ order_id: number; company_id: number | null; name: string }>(
    `SELECT DISTINCT so.id AS order_id, so.company_id, m.name FROM account_move_line l
       JOIN sale_order_line_invoice_rel r ON r.invoice_line_id = l.id JOIN sale_order_line sl ON sl.id = r.order_line_id
       JOIN sale_order so ON so.id = sl.order_id JOIN account_move m ON m.id = l.move_id
      WHERE l.move_id = $1 AND l.display_type IN ('product', 'line_section', 'line_subsection', 'line_note') ORDER BY so.id`, [moveId])).rows;
  if (!rows.length) return;
  const note = await xmlid(env, "mail.mt_note");
  const [authorId, emailFrom] = await computeAuthor(env, null, null);
  for (const r of rows) {
    await assertNoRecipients(env, "sale.order", r.order_id, note, []);
    // `self.env._("Invoice %s paid", name)`: sale's .po in the environment's language
    const body = `<p>${translate(env, "Invoice %s paid", "sale").replace("%s", r.name).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;").replace(/'/g, "&#39;")}</p>`; // html field: the text in a paragraph
    await insertMessages(env, [{
      model: "sale.order", res_id: r.order_id, body, author_id: authorId, email_from: emailFrom, message_type: "notification", subject: false,
      subtype_id: note, email_add_signature: true, record_company_id: r.company_id ?? false,
      parent_id: await flatThreadParent(env, "sale.order", r.order_id), message_id: trackingMessageId("message-notify"), reply_to: await replyToDefault(env, emailFrom),
    }]);
  }
}

/**
 * account_payment.py:496-518 `_compute_state` of the payments already matched to an invoice that just became paid:
 * paid -> reconciled when every invoice they settle is paid and their outstanding account is not a cash account, with
 * the tracking of the state (logged before the invoice's own tracking, as Odoo finalizes them).
 */
async function settleEarlierPayments(env: Environment, moveId: number, defer?: TrackingDefer): Promise<void> {
  const payments = (await env.cr.query<{ id: number; type: string | null }>(
    `SELECT p.id, a.account_type AS type FROM account_move__account_payment r JOIN account_payment p ON p.id = r.payment_id
       LEFT JOIN account_account a ON a.id = p.outstanding_account_id
      WHERE r.invoice_id = $1 AND p.state = 'paid' ORDER BY p.id`, [moveId])).rows;
  for (const p of payments) {
    if (p.type === "asset_cash") continue;
    const open = (await env.cr.query(
      `SELECT 1 FROM account_move__account_payment r JOIN account_move m ON m.id = r.invoice_id
        WHERE r.payment_id = $1 AND m.id != $2 AND m.payment_state != 'paid' LIMIT 1`, [p.id, moveId])).rows.length;
    if (open) continue;
    await updateRow(env, "account_payment", p.id, { state: "reconciled" });
    const log = (): Promise<unknown> => messageLogBatch(env, "account.payment", new Map([[p.id, "<div>Paid → <b>Reconciled</b> <i>(State)</i>\n</div>"]]), { messageType: "tracking" });
    if (defer) defer.later.push(async () => { await log(); });
    else await log();
  }
}

/**
 * Entering `_sync_dynamic_lines` (account_move.py:3827-3845) with invoices in the container writes their non-stored
 * dirty flags (:3685): `needed_terms_dirty` of the moves and `discount_allocation_dirty`/`epd_dirty` of their non-COGS
 * lines, all computed True (:1416, account_move_line.py:1390, :1439). Those are ORM writes: write_uid/write_date of the
 * rows, and `is_manually_modified` of the moves (account_move.py:4083-4084) unless `skip_is_manually_modified`. Odoo
 * enters it when an invoice is copied (`copy` creates from the original record, :3982) and in `_reconcile_plan`
 * (account_move_line.py:3133). The line writes also snapshot tracking, which logs nothing here (no tracked field changes).
 */
export async function touchSyncedInvoices(env: Environment, moveIds: readonly number[]): Promise<void> {
  if (!moveIds.length) return;
  const manual = env.context["skip_is_manually_modified"] ? "" : ", is_manually_modified = TRUE";
  if (isRecordingWritten(env.cr)) {
    // a Store version's written fields: the rows the two UPDATEs below reach
    const moves = (await env.cr.query<{ id: number }>("SELECT id FROM account_move WHERE id = ANY($1::int[]) AND move_type != 'entry' ORDER BY id", [[...moveIds]])).rows.map((r) => r.id);
    markWritten(env, "account.move", moves, [...(manual ? ["is_manually_modified"] : []), "write_uid", "write_date"]);
    const lines = (await env.cr.query<{ id: number }>(
      `SELECT l.id FROM account_move_line l JOIN account_move m ON m.id = l.move_id
        WHERE m.id = ANY($1::int[]) AND m.move_type != 'entry' AND l.display_type IS DISTINCT FROM 'cogs' ORDER BY l.id`, [[...moveIds]])).rows.map((r) => r.id);
    markWritten(env, "account.move.line", lines, ["write_uid", "write_date"]);
  }
  await env.cr.query(
    `UPDATE account_move SET write_uid = $2, write_date = now() AT TIME ZONE 'UTC'${manual} WHERE id = ANY($1::int[]) AND move_type != 'entry'`, [[...moveIds], env.uid]);
  await env.cr.query(
    `UPDATE account_move_line l SET write_uid = $2, write_date = now() AT TIME ZONE 'UTC' FROM account_move m
      WHERE m.id = l.move_id AND m.id = ANY($1::int[]) AND m.move_type != 'entry' AND l.display_type IS DISTINCT FROM 'cogs'`, [[...moveIds], env.uid]);
}

/** account_move_line.py:1159-1219 `_compute_amount_residual` for lines after a partial changed. */
async function refreshLineResidual(env: Environment, line: LineRow): Promise<void> {
  const rows = (await env.cr.query<{ d: number; dc: number; c: number; cc: number }>(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE debit_move_id = $1), 0)::float8 AS d, COALESCE(SUM(debit_amount_currency) FILTER (WHERE debit_move_id = $1), 0)::float8 AS dc,
            COALESCE(SUM(amount) FILTER (WHERE credit_move_id = $1), 0)::float8 AS c, COALESCE(SUM(credit_amount_currency) FILTER (WHERE credit_move_id = $1), 0)::float8 AS cc
       FROM account_partial_reconcile WHERE debit_move_id = $1 OR credit_move_id = $1`, [line.id])).rows[0]!;
  const cc = await currencyData(env, line.company_currency_id), fc = await currencyData(env, line.currency_id);
  const residual = roundPrecision(line.balance - rows.d + rows.c, cc.rounding);
  const residualCurrency = roundPrecision(line.amount_currency - rows.dc + rows.cc, fc.rounding);
  await updateRow(env, "account_move_line", line.id, {
    amount_residual: residual, amount_residual_currency: residualCurrency,
    reconciled: isZero(residual, cc.rounding) && isZero(residualCurrency, fc.rounding),
  });
}

/**
 * `(debit + credit).reconcile()` of two lines in the same currency (account_move_line.py:3137-3300): one partial for
 * the smaller residual, then a full reconcile when both are at zero; the moves' residuals follow.
 */
export async function reconcilePair(env: Environment, a: LineRow, b: LineRow, defer?: TrackingDefer): Promise<void> {
  const company = a.company_currency_id;
  const foreign = a.currency_id !== company || b.currency_id !== company;
  const cross = a.currency_id !== b.currency_id;
  // two different currencies: both foreign (the partial in the company currency, crossPartial), or a company currency
  // line against a foreign one (the partial in the foreign currency at `get_odoo_rate`, mixedPartial)
  const mixed = cross && (a.currency_id === company || b.currency_id === company);
  const debit = a.amount_residual > 0 ? a : b, credit = debit === a ? b : a;
  if (!(debit.amount_residual > 0) || !(credit.amount_residual < 0)) throw new NotPorted("reconciliation of lines of the same sign");
  const taxes = (await env.cr.query(
    `SELECT 1 FROM account_move_line l JOIN account_tax t ON t.id = l.tax_line_id WHERE l.move_id = ANY($1::int[]) AND t.tax_exigibility = 'on_payment' LIMIT 1`,
    [[debit.move_id, credit.move_id]])).rows.length;
  if (taxes) throw new NotPorted("reconciliation with cash basis taxes (_create_tax_cash_basis_moves)");
  await touchSyncedInvoices(env, [...new Set([debit.move_id, credit.move_id])]);
  const moves = new Set([debit.move_id, credit.move_id]);
  if (!foreign) {
    const amount = Math.min(debit.amount_residual, -credit.amount_residual);
    await insertPartial(env, debit, credit, amount, amount, amount);
  } else {
    const plan = mixed ? await mixedPartial(env, debit, credit) : cross ? await crossPartial(env, debit, credit) : await foreignPartial(env, debit, credit);
    const partial = await insertPartial(env, debit, credit, plan.amount, plan.debitAmountCurrency, plan.creditAmountCurrency);
    await refreshLineResidual(env, debit);
    await refreshLineResidual(env, credit);
    if (plan.fixes.length) {
      // :3137-3195 `_reconcile_plan_with_sync`: the exchange difference entry after the partials, linked to the partial
      const exchange = await createExchangeMove(env, plan.fixes, plan.exchangeDate);
      await env.cr.query("UPDATE account_partial_reconcile SET exchange_move_id = $1 WHERE id = $2", [exchange, partial]);
      moves.add(exchange);
    }
  }
  await refreshLineResidual(env, debit);
  await refreshLineResidual(env, credit);
  // account_partial_reconcile.py:193-233 `_update_matching_number` over the graph of lines joined by partials, and
  // account_move_line.py `_create_full_reconcile` when every line of the graph is reconciled
  const graph = await reconciliationGraph(env, [debit.id, credit.id]);
  const states = (await env.cr.query<{ id: number; reconciled: boolean; full: number | null }>(
    "SELECT id, reconciled, full_reconcile_id AS full FROM account_move_line WHERE id = ANY($1::int[])", [graph.lines])).rows;
  // a full reconcile made by the exchange entry's own reconciliation (createExchangeMove) is replaced below
  if (states.some((r) => r.full !== null && !innerFullsOf(env).has(r.full))) throw new NotPorted("reconciliation of a line already in a full reconcile");
  if (states.every((r) => r.reconciled)) {
    await fullReconcile(env, graph);
  } else {
    for (const id of graph.lines) await updateRow(env, "account_move_line", id, { matching_number: `P${Math.min(...graph.partials)}` });
  }
  for (const m of moves) await refreshMoveResidual(env, m, defer);
}

/**
 * :3264-3285 the full reconcile of a graph whose lines are all reconciled (`Command.link` of its partials and lines:
 * an earlier full reconcile of the same lines stays as an orphan row).
 */
async function fullReconcile(env: Environment, graph: { lines: number[]; partials: number[] }): Promise<number> {
  const full = await insertRow(env, "account_full_reconcile", {});
  await env.cr.query("UPDATE account_partial_reconcile SET full_reconcile_id = $1 WHERE id = ANY($2::int[])", [full, graph.partials]);
  for (const id of graph.lines) await updateRow(env, "account_move_line", id, { full_reconcile_id: full, matching_number: String(full) });
  return full;
}

/** Full reconciles created by an exchange entry's reconciliation in this request (superseded by the outer one). */
const INNER_FULLS = new WeakMap<object, Set<number>>();
function innerFullsOf(env: Environment): Set<number> {
  let set = INNER_FULLS.get(env.cr);
  if (!set) { set = new Set(); INNER_FULLS.set(env.cr, set); }
  return set;
}

async function insertPartial(env: Environment, debit: LineRow, credit: LineRow, amount0: number, debitCurrency0: number, creditCurrency0: number): Promise<number> {
  // monetary fields are rounded to their currency when written (fields_numeric.py Monetary.convert_to_column)
  const amount = roundPrecision(amount0, (await currencyData(env, debit.company_currency_id)).rounding);
  const debitCurrency = roundPrecision(debitCurrency0, (await currencyData(env, debit.currency_id)).rounding);
  const creditCurrency = roundPrecision(creditCurrency0, (await currencyData(env, credit.currency_id)).rounding);
  return insertRow(env, "account_partial_reconcile", {
    amount, debit_amount_currency: debitCurrency, credit_amount_currency: creditCurrency, debit_currency_id: debit.currency_id, credit_currency_id: credit.currency_id,
    debit_move_id: debit.id, credit_move_id: credit.id, company_id: debit.company_id, max_date: debit.date > credit.date ? debit.date : credit.date,
  });
}

interface ExchangeFix { line: LineRow; amountResidual: number }

/**
 * account_move_line.py:2554-2860 `_prepare_reconciliation_single_partial` of two lines in the same foreign currency,
 * both with a residual in it (`_prepare_move_line_residual_amounts` :2477-2552): the partial in that currency at each
 * line's accounting rate, and the company amounts left to fix by an exchange difference.
 */
async function foreignPartial(env: Environment, debit: LineRow, credit: LineRow): Promise<{ amount: number; debitAmountCurrency: number; creditAmountCurrency: number; fixes: ExchangeFix[]; exchangeDate: string }> {
  if (env.context["no_exchange_difference"] || env.context["no_exchange_difference_no_recursive"] || env.context["forced_rate_from_register_payment"]) {
    throw new NotPorted("reconciliation in a foreign currency without exchange difference or with a forced rate");
  }
  const comp = await currencyData(env, debit.company_currency_id), cur = await currencyData(env, debit.currency_id);
  const zero = (v: number, r: number): boolean => Math.abs(roundPrecision(v, r)) < r;
  const cmp = (x: number, y: number, r: number): number => { const d = roundPrecision(x - y, r); return Math.abs(d) < r ? 0 : d > 0 ? 1 : -1; };
  for (const l of [debit, credit]) {
    if (zero(l.amount_residual_currency, cur.rounding) || zero(l.amount_residual, comp.rounding) || zero(l.balance, comp.rounding) || zero(l.amount_currency, cur.rounding)) {
      throw new NotPorted("reconciliation in a foreign currency of a line without residual in one currency (exchange line mode)");
    }
  }
  let remDebit = debit.amount_residual, remCredit = credit.amount_residual;
  // get_accounting_rate: |amount_currency / balance|
  const debitRate = Math.abs(debit.amount_currency / debit.balance), creditRate = Math.abs(credit.amount_currency / credit.balance);
  const reconDebit = debit.amount_residual_currency, reconCredit = -credit.amount_residual_currency;
  const compare = cmp(reconDebit, reconCredit, cur.rounding);
  const minRecon = Math.min(reconDebit, reconCredit);
  const debitFull = compare <= 0, creditFull = compare >= 0;
  // get_amount_range_after_rate
  const range = (amount: number, rate: number): [number, number, number] => {
    const half = cur.rounding / 2;
    return [roundPrecision((amount - half) * rate, comp.rounding), roundPrecision(amount * rate, comp.rounding), roundPrecision((amount + half) * rate, comp.rounding)];
  };
  const dRange = range(minRecon, 1 / debitRate), cRange = range(minRecon, 1 / creditRate);
  let partialDebit = Math.min(dRange[1], remDebit);
  let partialCredit = Math.min(cRange[1], -remCredit);
  let amount = Math.min(partialDebit, partialCredit);
  if (cmp(partialDebit, cRange[2], comp.rounding) <= 0 && cmp(partialDebit, cRange[0], comp.rounding) >= 0
      && cmp(partialCredit, dRange[2], comp.rounding) <= 0 && cmp(partialCredit, dRange[0], comp.rounding) >= 0) {
    amount = Math.min(remDebit, -remCredit);
    partialDebit = amount; partialCredit = amount;
  }
  const fixes: ExchangeFix[] = [];
  if (debitFull) {
    const x = remDebit - amount;
    if (!zero(x, comp.rounding)) { fixes.push({ line: debit, amountResidual: x }); remDebit -= x; }
  } else {
    const x = partialDebit - amount;
    if (cmp(x, 0, comp.rounding) > 0) { fixes.push({ line: debit, amountResidual: x }); remDebit -= x; }
  }
  if (creditFull) {
    const x = remCredit + amount;
    if (!zero(x, comp.rounding)) { fixes.push({ line: credit, amountResidual: x }); remCredit -= x; }
  } else {
    const x = amount - partialCredit;
    if (cmp(x, 0, comp.rounding) < 0) { fixes.push({ line: credit, amountResidual: x }); remCredit -= x; }
  }
  if (fixes.length && !(debit.parent_state === "posted" && credit.parent_state === "posted")) throw new NotPorted("exchange difference of a draft entry (to_post False)");
  return { amount, debitAmountCurrency: minRecon, creditAmountCurrency: minRecon, fixes, exchangeDate: debit.date > credit.date ? debit.date : credit.date };
}

/**
 * account_move_line.py:2554-2860 `_prepare_reconciliation_single_partial` of two lines in two different foreign
 * currencies: neither line has a residual in the other's currency (`_prepare_move_line_residual_amounts` :2524-2551
 * adds the counterpart currency only to a company currency line or a line in that currency), so the reconciliation is
 * in the company currency (:2600-2611), and each line's foreign amount follows at its accounting rate (:2652-2672).
 * A difference left in a foreign currency would need an exchange entry on `amount_residual_currency` (:2765-2777),
 * which is not ported.
 */
async function crossPartial(env: Environment, debit: LineRow, credit: LineRow): Promise<{ amount: number; debitAmountCurrency: number; creditAmountCurrency: number; fixes: ExchangeFix[]; exchangeDate: string }> {
  if (env.context["no_exchange_difference"] || env.context["no_exchange_difference_no_recursive"] || env.context["forced_rate_from_register_payment"]) {
    throw new NotPorted("reconciliation in two currencies without exchange difference or with a forced rate");
  }
  const comp = await currencyData(env, debit.company_currency_id);
  const dcur = await currencyData(env, debit.currency_id), ccur = await currencyData(env, credit.currency_id);
  const zero = (v: number, r: number): boolean => Math.abs(roundPrecision(v, r)) < r;
  const cmp = (x: number, y: number, r: number): number => { const d = roundPrecision(x - y, r); return Math.abs(d) < r ? 0 : d > 0 ? 1 : -1; };
  // :2519-2523 the company currency is available when the company residual is not zero (else nothing to reconcile)
  if (zero(debit.amount_residual, comp.rounding) || zero(credit.amount_residual, comp.rounding)) throw new NotPorted("reconciliation in two currencies of a line without company residual");
  // :2503-2507 get_accounting_rate: None when the balance or the amount in currency is zero (no foreign amount then)
  const rate = (l: LineRow, r: number): number | null => (zero(l.balance, comp.rounding) || zero(l.amount_currency, r) || zero(l.amount_residual_currency, r) ? null : Math.abs(l.amount_currency / l.balance));
  const debitRate = rate(debit, dcur.rounding), creditRate = rate(credit, ccur.rounding);
  const reconDebit = debit.amount_residual, reconCredit = -credit.amount_residual;
  const compare = cmp(reconDebit, reconCredit, comp.rounding);
  const minRecon = Math.min(reconDebit, reconCredit);
  const debitFull = compare <= 0, creditFull = compare >= 0;
  const remDebitCur = debit.amount_residual_currency, remCreditCur = credit.amount_residual_currency;
  // :2652-2672
  const debitAmountCurrency = debitRate ? Math.min(roundPrecision(debitRate * minRecon, dcur.rounding), remDebitCur) : 0;
  const creditAmountCurrency = creditRate ? Math.min(roundPrecision(creditRate * minRecon, ccur.rounding), -remCreditCur) : 0;
  // :2765-2777: what a fully matched line keeps in its foreign currency goes to an exchange difference
  if (debitFull && !zero(remDebitCur - debitAmountCurrency, dcur.rounding)) throw new NotPorted("exchange difference on a residual in a foreign currency (reconciliation in two currencies)");
  if (creditFull && !zero(remCreditCur + creditAmountCurrency, ccur.rounding)) throw new NotPorted("exchange difference on a residual in a foreign currency (reconciliation in two currencies)");
  return { amount: minRecon, debitAmountCurrency, creditAmountCurrency, fixes: [], exchangeDate: debit.date > credit.date ? debit.date : credit.date };
}

/**
 * account_move_line.py:2554-2860 `_prepare_reconciliation_single_partial` of a line in the company currency against a
 * line in a foreign currency (a USD payment of an EUR invoice). `_prepare_move_line_residual_amounts` (:2479-2552): the
 * foreign line offers its company residual (rate 1) and its foreign residual (accounting rate); the company line its
 * company residual and, on a receivable/payable account, that residual in the foreign currency at `get_odoo_rate`
 * (:2492-2501: the payment's accounting rate when only the other line is a payment, else the rate at the invoice date
 * or the line's date). The foreign currency is then available on both sides and the reconciliation is in it
 * (:2598-2611); the company line's foreign amount is the partial in company currency (:2733-2740).
 */
async function mixedPartial(env: Environment, debit: LineRow, credit: LineRow): Promise<{ amount: number; debitAmountCurrency: number; creditAmountCurrency: number; fixes: ExchangeFix[]; exchangeDate: string }> {
  if (env.context["no_exchange_difference"] || env.context["no_exchange_difference_no_recursive"] || env.context["forced_rate_from_register_payment"]) {
    throw new NotPorted("reconciliation of a company currency line with a foreign currency line without exchange difference or with a forced rate");
  }
  const companyCur = debit.company_currency_id;
  const comp = await currencyData(env, companyCur);
  const zero = (v: number, r: number): boolean => Math.abs(roundPrecision(v, r)) < r;
  const cmp = (x: number, y: number, r: number): number => { const d = roundPrecision(x - y, r); return Math.abs(d) < r ? 0 : d > 0 ? 1 : -1; };
  const companyLine = debit.currency_id === companyCur ? debit : credit, foreignLine = companyLine === debit ? credit : debit;
  const foreignCur = foreignLine.currency_id;
  const fcur = await currencyData(env, foreignCur);
  const moves = new Map((await env.cr.query<{ id: number; move_type: string; invoice_date: string | null; pay: boolean }>(
    `SELECT id, move_type, invoice_date::text AS invoice_date, (origin_payment_id IS NOT NULL OR statement_line_id IS NOT NULL) AS pay
       FROM account_move WHERE id = ANY($1::int[])`, [[debit.move_id, credit.move_id]])).rows.map((m) => [m.id, m]));
  // get_accounting_rate (:2503-2507): None when the balance or the amount in currency is zero
  const accountingRate = (l: LineRow, r: number): number | null => (zero(l.balance, comp.rounding) || zero(l.amount_currency, r) ? null : Math.abs(l.amount_currency / l.balance));
  // the foreign line's offer (:2522-2531): its currency at the accounting rate when its foreign residual is not zero
  const foreignOffer = zero(foreignLine.amount_residual_currency, fcur.rounding) ? null
    : { residual: foreignLine.amount_residual_currency, rate: accountingRate(foreignLine, fcur.rounding) };
  // the company line's offer (:2533-2544)
  let companyOffer: { residual: number; rate: number | null } | null = null;
  const recPay = companyLine.account_type === "asset_receivable" || companyLine.account_type === "liability_payable";
  if (recPay && !zero(companyLine.amount_residual, comp.rounding)) {
    const own = moves.get(companyLine.move_id)!, other = moves.get(foreignLine.move_id)!;
    let rate: number | null;
    if (!own.pay && other.pay) rate = accountingRate(foreignLine, fcur.rounding);
    else {
      const date = isInvoice(own.move_type) ? own.invoice_date : companyLine.date; // is_invoice(include_receipts=True)
      if (date === null) throw new NotPorted("reconciliation of a company currency invoice line without invoice date");
      const { conversionRate } = await import("./currency_convert");
      rate = await conversionRate(env, companyCur, foreignCur, companyLine.company_id, date);
    }
    const residual = rate === null ? 0 : roundPrecision(companyLine.amount_residual * rate, fcur.rounding);
    if (!zero(residual, fcur.rounding)) companyOffer = { residual, rate };
  }
  if (!foreignOffer || !companyOffer) {
    // :2598-2611 the company currency: a partial in it with the foreign line's amount at its rate and an exchange
    // difference on `amount_residual_currency` (:2765-2777), or nothing to reconcile on a side (:2616-2626)
    throw new NotPorted("reconciliation of a company currency line with a foreign currency line in the company currency");
  }
  const debitOffer = debit === foreignLine ? foreignOffer : companyOffer, creditOffer = credit === foreignLine ? foreignOffer : companyOffer;
  const reconDebit = debitOffer.residual, reconCredit = -creditOffer.residual;
  const compare = cmp(reconDebit, reconCredit, fcur.rounding);
  const minRecon = Math.min(reconDebit, reconCredit);
  const debitFull = compare <= 0, creditFull = compare >= 0;
  let remDebit = debit.amount_residual, remCredit = credit.amount_residual;
  // :2649-2660 get_amount_range_after_rate, from the line's own currency (the half rounding of the company currency
  // for the company line) into the company currency
  const range = (from: number, amount: number, rate: number | null): [number, number, number] => {
    if (!rate) return [0, 0, 0];
    const half = from / 2;
    return [roundPrecision((amount - half) * rate, comp.rounding), roundPrecision(amount * rate, comp.rounding), roundPrecision((amount + half) * rate, comp.rounding)];
  };
  const roundingOf = (l: LineRow): number => (l === foreignLine ? fcur.rounding : comp.rounding);
  const dRange = range(roundingOf(debit), minRecon, debitOffer.rate ? 1 / debitOffer.rate : null);
  const cRange = range(roundingOf(credit), minRecon, creditOffer.rate ? 1 / creditOffer.rate : null);
  let partialDebit = Math.min(dRange[1], remDebit);
  let partialCredit = Math.min(cRange[1], -remCredit);
  let amount = Math.min(partialDebit, partialCredit);
  if (cmp(partialDebit, cRange[2], comp.rounding) <= 0 && cmp(partialDebit, cRange[0], comp.rounding) >= 0
      && cmp(partialCredit, dRange[2], comp.rounding) <= 0 && cmp(partialCredit, dRange[0], comp.rounding) >= 0) {
    amount = Math.min(remDebit, -remCredit);
    partialDebit = amount; partialCredit = amount;
  }
  // :2733-2740 a company currency line mimics the foreign currency with the company amount
  const debitAmountCurrency = debit === companyLine ? amount : minRecon;
  const creditAmountCurrency = credit === companyLine ? amount : minRecon;
  // :2779-2828 the exchange differences on the company residuals
  const fixes: ExchangeFix[] = [];
  if (debitFull) {
    const x = remDebit - amount;
    if (!zero(x, comp.rounding)) { fixes.push({ line: debit, amountResidual: x }); remDebit -= x; }
  } else {
    const x = partialDebit - amount;
    if (cmp(x, 0, comp.rounding) > 0) { fixes.push({ line: debit, amountResidual: x }); remDebit -= x; }
  }
  if (creditFull) {
    const x = remCredit + amount;
    if (!zero(x, comp.rounding)) { fixes.push({ line: credit, amountResidual: x }); remCredit -= x; }
  } else {
    const x = amount - partialCredit;
    if (cmp(x, 0, comp.rounding) < 0) { fixes.push({ line: credit, amountResidual: x }); remCredit -= x; }
  }
  if (fixes.length && !(debit.parent_state === "posted" && credit.parent_state === "posted")) throw new NotPorted("exchange difference of a draft entry (to_post False)");
  return { amount, debitAmountCurrency, creditAmountCurrency, fixes, exchangeDate: debit.date > credit.date ? debit.date : credit.date };
}

/**
 * account_move_line.py:3319-3416 `_prepare_exchange_difference_move_vals` and :3418-3470
 * `_create_exchange_difference_moves`: an entry of the company's exchange journal fixing each line's company residual,
 * its counterpart on the exchange gain or loss account, posted; each fixing line is reconciled with the line it fixes
 * (`reconciled_lines_ids`, in the company currency only: the exchange line has no residual in the foreign currency).
 */
async function createExchangeMove(env: Environment, fixes: ExchangeFix[], exchangeDate: string): Promise<number> {
  const company = fixes[0]!.line.company_id;
  if (fixes.some((f) => f.line.company_id !== company)) throw new NotPorted("exchange difference over several companies");
  const [c] = (await env.cr.query<{ journal: number | null; expense: number | null; income: number | null; currency: number }>(
    `SELECT currency_exchange_journal_id AS journal, expense_currency_exchange_account_id AS expense, income_currency_exchange_account_id AS income, currency_id AS currency
       FROM res_company WHERE id = $1`, [company])).rows;
  if (!c!.journal) throw new UserError(translate(env, "You have to configure the 'Exchange Gain or Loss Journal' in your company settings, to manage automatically the booking of accounting entries related to differences between exchange rates."));
  if (!c!.expense) throw new UserError(translate(env, "You should configure the 'Loss Exchange Rate Account' in your company settings, to manage automatically the booking of accounting entries related to differences between exchange rates."));
  if (!c!.income) throw new UserError(translate(env, "You should configure the 'Gain Exchange Rate Account' in your company settings, to manage automatically the booking of accounting entries related to differences between exchange rates."));
  // account_move_line.py:3337 `journal.with_context(move_date=exchange_date).accounting_date` (account_journal.py:523-529):
  // `_get_accounting_date(move_date, has_tax=False)` of `account.move.new({'journal_id': journal})`, an entry dated
  // today (account_move.py `_compute_date`) with its `highest_name`: not a sale document, so a date in a month before
  // the current one gives that month's last day and a date in the current month `max(date, today)`
  // (account_move.py:7458-7494; `has_tax` is the context's, False, so the tax lock date does not count). Before round 9 the port took the date
  // itself: an exchange difference of a payment made today on an invoice dated earlier this month got the invoice date.
  const { accountingDate } = await import("./account_move_create");
  const { contextToday } = await import("./account_computes");
  const temp = new NewRec(env, env.reg.model("account.move"), null);
  await temp.set("journal_id", c!.journal);
  await temp.set("move_type", "entry");
  await temp.set("date", await contextToday(env));
  await temp.set("company_id", company);
  await temp.set("origin_payment_id", null);
  await temp.set("partner_id", null);
  let date = await accountingDate(env, temp, exchangeDate, false);
  const refs: string[] = [];
  const lines: EntryLine[] = [];
  const toReconcile: [LineRow, number][] = [];
  if ((env.lang ?? "en_US") !== "en_US") throw new NotPorted("the exchange difference label in another language");
  for (const f of fixes) {
    const [m] = (await env.cr.query<{ name: string | null }>("SELECT name FROM account_move WHERE id = $1", [f.line.move_id])).rows;
    if (m?.name && !refs.includes(m.name)) refs.push(m.name);
    if (f.line.date > date) date = f.line.date;
    const residual = roundPrecision(f.amountResidual, (await currencyData(env, c!.currency)).rounding);
    const residualCurrency = f.line.currency_id === c!.currency ? residual : 0.0;
    const exchangeAccount = residual > 0 ? c!.expense : c!.income;
    const seq = lines.length;
    lines.push({ name: "Currency exchange rate difference", account_id: f.line.account_id, partner_id: f.line.partner_id, balance: -residual, amount_currency: -residualCurrency,
      currency_id: f.line.currency_id, date_maturity: null, sequence: seq });
    lines.push({ name: "Currency exchange rate difference", account_id: exchangeAccount, partner_id: f.line.partner_id, balance: residual, amount_currency: residualCurrency,
      currency_id: f.line.currency_id, date_maturity: null, sequence: seq + 1 });
    toReconcile.push([f.line, seq]);
  }
  // `','.join(refs)` of a Python set: the order of several names is not reproducible
  if (refs.length > 1) throw new NotPorted("exchange difference entry fixing lines of several moves (ref of a set)");
  const move = await createPostedEntry(env, {
    ref: refs[0] ?? null, date, journal_id: c!.journal, company_id: company, partner_id: null, currency_id: c!.currency,
    partner_bank_id: null, origin_payment_id: null, lines,
  });
  const created = (await env.cr.query<{ id: number }>("SELECT id FROM account_move_line WHERE move_id = $1 ORDER BY id", [move])).rows.map((r) => r.id);
  // account_move.py `_post`: the partners of receivable/payable lines get their rank
  for (const l of await linesById(env, created)) {
    if (l.partner_id !== null && (l.account_type === "asset_receivable" || l.account_type === "liability_payable")) {
      await increaseRank(env, l.partner_id, l.account_type === "asset_receivable" ? "customer_rank" : "supplier_rank");
    }
  }
  for (const [fixed, seq] of toReconcile) {
    const [exchangeLine] = await linesById(env, [created[seq]!]);
    const [current] = await linesById(env, [fixed.id]);
    const d = current!.amount_residual > 0 ? current! : exchangeLine!, cr = d === current ? exchangeLine! : current!;
    // the reconciliation through `reconciled_lines_ids` runs with `no_exchange_difference` (:3456), so in the company
    // currency (:2598-2599): a foreign line and its exchange line (no residual in the foreign currency) are in exchange
    // line mode (:2632-2638), the company amounts only; a company currency line keeps its rate 1 (:2681-2688)
    const amount = Math.min(d.amount_residual, -cr.amount_residual);
    const inCompany = fixed.currency_id === fixed.company_currency_id;
    await insertPartial(env, d, cr, amount, inCompany ? amount : 0.0, inCompany ? amount : 0.0);
    await refreshLineResidual(env, exchangeLine!);
    await refreshLineResidual(env, current!);
    // this reconciliation is a `_reconcile_plan` of its own: its graph may be fully reconciled already
    const graph = await reconciliationGraph(env, [fixed.id, exchangeLine!.id]);
    const states = (await env.cr.query<{ reconciled: boolean; full: number | null }>(
      "SELECT reconciled, full_reconcile_id AS full FROM account_move_line WHERE id = ANY($1::int[])", [graph.lines])).rows;
    if (states.some((r) => r.full !== null)) throw new NotPorted("exchange difference on a line already in a full reconcile");
    if (states.every((r) => r.reconciled)) innerFullsOf(env).add(await fullReconcile(env, graph));
  }
  return move;
}

/** The lines and partials connected to `lines` through account.partial.reconcile (`_all_reconciled_lines`). */
async function reconciliationGraph(env: Environment, lines: readonly number[]): Promise<{ lines: number[]; partials: number[] }> {
  const seen = new Set(lines), partials = new Set<number>();
  let frontier = [...lines];
  while (frontier.length) {
    const rows = (await env.cr.query<{ id: number; d: number; c: number }>(
      "SELECT id, debit_move_id AS d, credit_move_id AS c FROM account_partial_reconcile WHERE debit_move_id = ANY($1::int[]) OR credit_move_id = ANY($1::int[])", [frontier])).rows;
    frontier = [];
    for (const r of rows) {
      partials.add(r.id);
      for (const l of [r.d, r.c]) if (!seen.has(l)) { seen.add(l); frontier.push(l); }
    }
  }
  return { lines: [...seen].sort((a, b) => a - b), partials: [...partials].sort((a, b) => a - b) };
}

/**
 * account_move_line.py:3476-3478 `remove_move_reconcile`: `(matched_debit_ids + matched_credit_ids).unlink()`, with
 * account_partial_reconcile.py:107-153 `unlink`: the partials, then their full reconciles, the lines' residuals
 * (`_compute_amount_residual`), the matching numbers of what stays connected (`_update_matching_number` :193-235: the
 * lines still in a graph by SQL, the others written False), and the stored computes that follow: the moves' residual
 * and payment state (tracked), the payments' state and reconciliation status (account_payment.py:495-548). Exchange
 * difference and cash basis entries (`_unlink_or_reverse`), and payments without journal entry, refuse.
 * Before round 11 the method was not registered.
 */
export async function removeMoveReconcile(env: Environment, lineIds: readonly number[], defer?: TrackingDefer): Promise<void> {
  if (!lineIds.length) return;
  const partials = (await env.cr.query<{ id: number; d: number; c: number; full: number | null; exchange: number | null }>(
    `SELECT id, debit_move_id AS d, credit_move_id AS c, full_reconcile_id AS full, exchange_move_id AS exchange FROM account_partial_reconcile
      WHERE debit_move_id = ANY($1::int[]) OR credit_move_id = ANY($1::int[]) ORDER BY id`, [[...lineIds]])).rows;
  if (!partials.length) return;
  await checkModelAccess(env, env.reg.model("account.partial.reconcile"), "unlink");
  const pids = partials.map((p) => p.id);
  if (partials.some((p) => p.exchange !== null)) throw new NotPorted("remove_move_reconcile of a partial with an exchange difference entry (_unlink_or_reverse)");
  if ((await env.cr.query("SELECT 1 FROM account_move WHERE tax_cash_basis_rec_id = ANY($1::int[]) LIMIT 1", [pids])).rows.length) {
    throw new NotPorted("remove_move_reconcile of a partial with cash basis entries (_unlink_or_reverse)");
  }
  const lines = [...new Set(partials.flatMap((p) => [p.d, p.c]))];
  const moves = (await env.cr.query<{ m: number }>("SELECT DISTINCT move_id AS m FROM account_move_line WHERE id = ANY($1::int[]) ORDER BY move_id", [lines])).rows.map((r) => r.m);
  // :117 `_get_to_update_payments(from_state='reconciled')`: payments without a journal entry
  if ((await env.cr.query(
    `SELECT 1 FROM account_move__account_payment r JOIN account_payment p ON p.id = r.payment_id
      WHERE r.invoice_id = ANY($1::int[]) AND p.outstanding_account_id IS NULL AND p.state = 'reconciled' LIMIT 1`, [moves])).rows.length) {
    throw new NotPorted("remove_move_reconcile of an invoice settled by a payment without journal entry");
  }
  const fulls = [...new Set(partials.map((p) => p.full).filter((f): f is number => f !== null))];
  await env.cr.query("DELETE FROM account_partial_reconcile WHERE id = ANY($1::int[])", [pids]);
  // the lines' full_reconcile_id is ON DELETE SET NULL
  if (fulls.length) await env.cr.query("DELETE FROM account_full_reconcile WHERE id = ANY($1::int[])", [fulls]);
  for (const l of await linesById(env, lines)) await refreshLineResidual(env, l);
  // `_update_matching_number(all_reconciled)`: numbered graphs over the partials left, the others False
  const graph = await reconciliationGraph(env, lines);
  const numbered = new Set<number>();
  if (graph.partials.length) {
    const left = (await env.cr.query<{ id: number; d: number; c: number }>(
      "SELECT id, debit_move_id AS d, credit_move_id AS c FROM account_partial_reconcile WHERE id = ANY($1::int[]) ORDER BY id", [graph.partials])).rows;
    const number = new Map<number, number>(), members = new Map<number, number[]>();
    for (const p of left) {
      const dn = number.get(p.d), cn = number.get(p.c);
      if (dn !== undefined && cn !== undefined) {
        if (dn !== cn) {
          const lo = Math.min(dn, cn), hi = Math.max(dn, cn);
          for (const l of members.get(hi)!) number.set(l, lo);
          members.get(lo)!.push(...members.get(hi)!); members.delete(hi);
        }
      } else if (dn !== undefined) { members.get(dn)!.push(p.c); number.set(p.c, dn); }
      else if (cn !== undefined) { members.get(cn)!.push(p.d); number.set(p.d, cn); }
      else { members.set(p.id, [p.d, p.c]); number.set(p.d, p.id); number.set(p.c, p.id); }
    }
    for (const [n, ids] of members) {
      await env.cr.query(
        "UPDATE account_move_line SET matching_number = CASE WHEN full_reconcile_id IS NOT NULL THEN full_reconcile_id::text ELSE 'P' || $1::text END WHERE id = ANY($2::int[])", [n, ids]);
      for (const id of ids) numbered.add(id);
    }
  }
  for (const id of graph.lines) if (!numbered.has(id)) await updateRow(env, "account_move_line", id, { matching_number: null });
  for (const m of moves) await refreshMoveResidual(env, m, defer);
  await refreshPaymentStatus(env, await affectedPayments(env, moves), defer);
}

/**
 * The payments whose stored computes depend on the moves (account_payment.py:495 `move_id.line_ids.amount_residual`,
 * `reconciled_invoice_ids.payment_state`): the payments of the moves and those reconciled with them.
 */
async function affectedPayments(env: Environment, moves: readonly number[]): Promise<number[]> {
  return (await env.cr.query<{ id: number }>(
    `SELECT p.id FROM account_payment p WHERE p.move_id = ANY($1::int[])
        OR EXISTS (SELECT 1 FROM account_move_line pl JOIN account_partial_reconcile pr ON pl.id IN (pr.debit_move_id, pr.credit_move_id)
                     JOIN account_move_line o ON o.id IN (pr.debit_move_id, pr.credit_move_id) AND o.id != pl.id
                    WHERE pl.move_id = p.move_id AND o.move_id = ANY($1::int[]))
      ORDER BY p.id`, [[...moves]])).rows.map((r) => r.id);
}

/**
 * account_payment.py:743-802 `_compute_stat_buttons_from_reconciliation`: `reconciled_invoice_ids` /
 * `reconciled_bill_ids` are the payment's matched invoices (`invoice_ids`, kept after an unreconciliation) of each kind,
 * with the invoices reconciled with any receivable/payable line of its entry. Their ids and payment states.
 */
async function reconciledDocuments(env: Environment, paymentId: number): Promise<{ invoices: { id: number; s: string | null }[]; bills: { id: number; s: string | null }[] }> {
  const rows = (await env.cr.query<{ id: number; t: string; s: string | null }>(
    `SELECT m.id, m.move_type AS t, m.payment_state AS s FROM account_move m
      WHERE m.id IN (SELECT r.invoice_id FROM account_move__account_payment r WHERE r.payment_id = $1
                     UNION
                     SELECT invoice.id FROM account_payment payment
                       JOIN account_move_line line ON line.move_id = payment.move_id
                       JOIN account_partial_reconcile part ON part.debit_move_id = line.id OR part.credit_move_id = line.id
                       JOIN account_move_line counterpart_line ON part.debit_move_id = counterpart_line.id OR part.credit_move_id = counterpart_line.id
                       JOIN account_move invoice ON invoice.id = counterpart_line.move_id
                       JOIN account_account account ON account.id = line.account_id
                      WHERE payment.id = $1 AND account.account_type IN ('asset_receivable', 'liability_payable') AND line.id != counterpart_line.id
                        AND invoice.move_type IN ('out_invoice', 'out_refund', 'in_invoice', 'in_refund', 'out_receipt', 'in_receipt'))
      ORDER BY m.id`, [paymentId])).rows;
  return { invoices: rows.filter((r) => ["out_invoice", "out_refund", "out_receipt"].includes(r.t)), bills: rows.filter((r) => ["in_invoice", "in_refund", "in_receipt"].includes(r.t)) };
}

/**
 * account_payment.py:495-518 `_compute_state` of a saved payment from its state `state`: with a journal entry a paid or
 * reconciled payment is 'reconciled' when its liquidity lines have no residual left (company currency), else 'paid';
 * a paid payment whose reconciled invoices (or bills) are all paid is 'reconciled' unless its outstanding account is
 * a cash account.
 */
export async function paymentComputedState(env: Environment, paymentId: number, state0: string | null): Promise<string> {
  let state = state0 || "draft";
  const p = (await env.cr.query<{ move_id: number | null; company_currency: number; out_type: string | null }>(
    `SELECT p.move_id, c.currency_id AS company_currency, a.account_type AS out_type FROM account_payment p JOIN res_company c ON c.id = p.company_id
       LEFT JOIN account_account a ON a.id = p.outstanding_account_id WHERE p.id = $1`, [paymentId])).rows[0]!;
  if (p.move_id && (state === "paid" || state === "reconciled")) {
    const { liquidity } = await seekForLines(env, paymentId);
    const cc = await currencyData(env, p.company_currency);
    state = isZero(liquidity.reduce((a, l) => a + l.amount_residual, 0), cc.rounding) ? "reconciled" : "paid";
  }
  if (state !== "paid" || p.out_type === "asset_cash") return state;
  const { invoices, bills } = await reconciledDocuments(env, paymentId);
  const allPaid = (ds: { s: string | null }[]): boolean => ds.length > 0 && ds.every((d) => d.s === "paid");
  return allPaid(invoices) || allPaid(bills) ? "reconciled" : state;
}

/**
 * account_payment.py:495-518 `_compute_state` (paid <-> reconciled) and :520-548 `_compute_reconciliation_status` of
 * payments with a journal entry of one liquidity and one counterpart line (`_seek_for_lines`), with the tracking of
 * the state.
 */
async function refreshPaymentStatus(env: Environment, payments: readonly number[], defer?: TrackingDefer): Promise<void> {
  for (const id of payments) {
    const p = (await env.cr.query<{ state: string; move_id: number; outstanding_account_id: number | null; destination_account_id: number | null; currency_id: number; company_currency: number; amount: number; journal_default: number | null; out_type: string | null }>(
      `SELECT p.state, p.move_id, p.outstanding_account_id, p.destination_account_id, p.currency_id, c.currency_id AS company_currency, p.amount::float8 AS amount,
              j.default_account_id AS journal_default, a.account_type AS out_type
         FROM account_payment p JOIN res_company c ON c.id = p.company_id JOIN account_journal j ON j.id = p.journal_id
         LEFT JOIN account_account a ON a.id = p.outstanding_account_id WHERE p.id = $1`, [id])).rows[0]!;
    const all = await moveLines(env, p.move_id);
    const liquidity = all.filter((l) => l.account_id === p.outstanding_account_id);
    const counterpart = all.filter((l) => l.account_id === p.destination_account_id && l.account_id !== p.outstanding_account_id);
    if (!p.outstanding_account_id || liquidity.length !== 1 || counterpart.length !== 1 || all.length !== 2) throw new NotPorted("account.payment state of a payment whose entry is not one liquidity and one counterpart line (_seek_for_lines)");
    const cc = await currencyData(env, p.company_currency), pc = await currencyData(env, p.currency_id);
    const zeroC = (v: number): boolean => isZero(v, cc.rounding), zeroP = (v: number): boolean => isZero(v, pc.rounding);
    const state = await paymentComputedState(env, id, p.state);
    const residual = (l: LineRow): number => (p.currency_id === p.company_currency ? l.amount_residual : l.amount_residual_currency);
    const isMatched = zeroP(p.amount) || p.journal_default === p.outstanding_account_id || zeroP(residual(liquidity[0]!));
    const isReconciled = zeroP(p.amount) || (await env.cr.query<{ r: boolean }>("SELECT reconcile AS r FROM account_account WHERE id = $1", [counterpart[0]!.account_id])).rows[0]?.r !== true || zeroP(residual(counterpart[0]!));
    const vals: Row = {};
    if (state !== p.state) vals["state"] = state;
    const cur = (await env.cr.query<{ r: boolean | null; m: boolean | null }>("SELECT is_reconciled AS r, is_matched AS m FROM account_payment WHERE id = $1", [id])).rows[0]!;
    if (Boolean(cur.r) !== isReconciled) vals["is_reconciled"] = isReconciled;
    if (Boolean(cur.m) !== isMatched) vals["is_matched"] = isMatched;
    if (Object.keys(vals).length) await updateRow(env, "account_payment", id, vals);
    if (state !== p.state) {
      const body = `<div>${trackedSelection(env, "account.payment", "state", p.state)} → <b>${trackedSelection(env, "account.payment", "state", state)}</b> <i>(${trackedLabel(env, "account.payment", "state")})</i>\n</div>`;
      const log = async (): Promise<void> => { await messageLogBatch(env, "account.payment", new Map([[id, body]]), { messageType: "tracking" }); };
      if (defer) (defer.payments ?? defer.later).push(log); else await log();
    }
  }
}

/**
 * account_payment.py:250-279 `_seek_for_lines` of a saved payment: its entry's lines (`move_id.line_ids`, the line
 * order) on the liquidity accounts (:281-289 `_get_valid_liquidity_accounts`: the journal's default account, the
 * payment method line's account, every inbound/outbound method line's account of the journal, the outstanding account),
 * the counterpart ones (receivable/payable or the company's transfer account) and the write-offs; one write-off stands
 * in for a missing liquidity or counterpart line.
 */
export async function seekForLines(env: Environment, paymentId: number): Promise<{ liquidity: LineRow[]; counterpart: LineRow[]; writeoff: LineRow[] }> {
  const p = (await env.cr.query<{ move_id: number | null; accounts: (number | null)[] }>(
    `SELECT p.move_id, ARRAY[j.default_account_id, pml.payment_account_id, p.outstanding_account_id]
              || ARRAY(SELECT l.payment_account_id FROM account_payment_method_line l JOIN account_payment_method m ON m.id = l.payment_method_id
                        WHERE l.journal_id = j.id AND m.payment_type IN ('inbound', 'outbound')) AS accounts
       FROM account_payment p JOIN account_journal j ON j.id = p.journal_id
       LEFT JOIN account_payment_method_line pml ON pml.id = p.payment_method_line_id WHERE p.id = $1`, [paymentId])).rows[0];
  if (!p?.move_id) return { liquidity: [], counterpart: [], writeoff: [] };
  const valid = new Set(p.accounts.filter((a): a is number => a !== null));
  const lines = (await env.cr.query<LineRow & { transfer: number | null }>(
    `${LINE_SELECT} JOIN res_company c ON c.id = l.company_id WHERE l.move_id = $1 ORDER BY l.date DESC, l.move_name DESC, l.id`.replace(
      "SELECT l.id,", "SELECT c.transfer_account_id AS transfer, l.id,"), [p.move_id])).rows;
  let liquidity: LineRow[] = [], counterpart: LineRow[] = [], writeoff: LineRow[] = [];
  for (const l of lines) {
    if (valid.has(l.account_id)) liquidity.push(l);
    else if (l.account_type === "asset_receivable" || l.account_type === "liability_payable" || l.account_id === l.transfer) counterpart.push(l);
    else writeoff.push(l);
  }
  if (writeoff.length === 1) {
    if (!liquidity.length) [liquidity, writeoff] = [writeoff, liquidity];
    else if (!counterpart.length) [counterpart, writeoff] = [writeoff, counterpart];
  }
  return { liquidity, counterpart, writeoff };
}

registerMethod("account.move.line", "remove_move_reconcile", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  await removeMoveReconcile(env, ids ?? []);
  return null;
}, { apiModel: false });

/** account_move.py:1029-1044 and sequence_mixin.py:184-191 `_compute_split_sequence`: prefix and number of a name. */
export function splitSequence(name: string): { prefix: string; number: number } {
  const m = /^(.*?)(\d{0,9})(\D*?)$/.exec(name)!;
  return { prefix: m[1]!, number: Number(m[2] || 0) };
}

/** `partner._increase_rank` of the partner and its commercial entity (partner.py:891-925). */
export async function increaseRank(env: Environment, partner: number, field: "customer_rank" | "supplier_rank", n = 1): Promise<void> {
  const ids = (await env.cr.query<{ id: number; commercial_partner_id: number | null }>("SELECT id, commercial_partner_id FROM res_partner WHERE id = $1", [partner])).rows[0];
  if (!ids) return;
  // account partner.py:891-924 `_increase_rank`: a partner that already has a rank gets the increase after the commit,
  // in its own transaction (no serialization failure on a partner every posting touches); a rank of 0 is raised now so
  // the customer/supplier filters see it. Errors of the late update are swallowed (OperationalError, :923).
  const key = `account.res.partner.increase_rank.${field}`;
  let data = env.cr.postcommitData.get(key) as Map<number, number> | undefined;
  const alreadyRegistered = data !== undefined && data.size > 0;
  if (!data) { data = new Map(); env.cr.postcommitData.set(key, data); }
  for (const id of new Set([ids.id, ...(ids.commercial_partner_id ? [ids.commercial_partner_id] : [])])) {
    const rank = Number((await env.cr.query<{ r: number | null }>(`SELECT ${field} AS r FROM res_partner WHERE id = $1`, [id])).rows[0]?.r ?? 0);
    if (rank) data.set(id, (data.get(id) ?? 0) + n);
    else await env.cr.query(`UPDATE res_partner SET ${field} = COALESCE(${field}, 0) + $3, write_uid = $2, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1`, [id, env.uid, n]);
  }
  if (alreadyRegistered || !data.size) return;
  const pending = data, uid = env.uid, cr0 = env.cr;
  cr0.postcommit.push(async () => {
    const cr = cr0.fresh();
    try {
      for (const [id, add] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
        await cr.query(`UPDATE res_partner SET ${field} = COALESCE(${field}, 0) + $3, write_uid = $2, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1`, [id, uid, add]);
      }
      pending.clear();
      await cr.commit();
    } catch (e) {
      await cr.rollback().catch(() => undefined);
      const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
      // psycopg2 OperationalError: connection, resources, lock, serialization and deadlock failures
      if (!/^(08|40|53|55|57)/.test(code)) throw e;
    } finally {
      await cr.close();
    }
  });
}

export interface EntryLine {
  name: string | null; account_id: number; partner_id: number | null; balance: number; payment_id?: number;
  /** the amount in the line's currency (the balance when absent) */
  amount_currency?: number; currency_id?: number; date_maturity?: string | null; sequence?: number;
  /** a payment's early payment discount write-off: its taxes and tags, or the refund repartition line of a tax line */
  tax_ids?: number[]; tax_tag_ids?: number[]; tax_repartition_line_id?: number | null; price_total?: number;
}

/** account_move.py:1079-1093 `_compute_fiscal_position_id` on an entry. */
async function moveFiscalPosition(env: Environment, company: number, partner: number | null): Promise<number | null> {
  if (partner === null) return null;
  const delivery = (await addressGet(env, partner, ["delivery"]))["delivery"]!;
  return fiscalPositionFor(env, company, partner, delivery);
}

/**
 * A payment's journal entry created and posted (account_payment.py:1157-1177 `_generate_move_vals`, then `_post`):
 * one currency, the company's. The name comes from the journal's payment sequence.
 */
export async function createPostedEntry(env: Environment, vals: EntryVals): Promise<number> {
  return (await createPostedEntries(env, [vals]))[0]!;
}

export interface EntryVals {
  ref: string | null; date: string; journal_id: number; company_id: number; partner_id: number | null; currency_id: number;
  partner_bank_id: number | null; origin_payment_id: number | null; lines: EntryLine[];
}

/**
 * Several payments' entries (account_payment.py:965-1003 `create` generates each payment's entry in turn, then
 * account_payment_register.py:1249-1262 `_post_payments` posts them together): each entry is created with its chatter,
 * then `_post` names them in `_compute_name`'s order (account_move.py:995-996: date, ref, id).
 */
export async function createPostedEntries(env: Environment, list: readonly EntryVals[]): Promise<number[]> {
  const created: { id: number; vals: EntryVals; companyCurrency: number; journalType: string | undefined }[] = [];
  for (const vals of list) {
    const commercial = vals.partner_id === null ? null : (await env.cr.query<{ c: number | null }>("SELECT commercial_partner_id AS c FROM res_partner WHERE id = $1", [vals.partner_id])).rows[0]?.c ?? null;
    // account_move.py `_compute_invoice_partner_display_name`: the partner, else "#Created by: <creator>"
    const partnerName = vals.partner_id === null
      ? `#Created by: ${String((await env.sudo().model("res.users").read([env.uid], ["name"], ""))[0]?.["name"] ?? "")}`
      : String((await env.sudo().model("res.partner").displayName([vals.partner_id])).get(vals.partner_id) ?? "");
    const companyCurrency = (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [vals.company_id])).rows[0]!.c;
    // account_move.py `_compute_amount` of an entry: the debit lines' balances and amounts in currency
    const total = vals.lines.filter((l) => l.balance > 0).reduce((s, l) => s + l.balance, 0);
    const totalCurrency = vals.lines.filter((l) => l.balance > 0).reduce((s, l) => s + (l.amount_currency ?? l.balance), 0);
    const journalType = (await env.cr.query<{ t: string }>("SELECT type AS t FROM account_journal WHERE id = $1", [vals.journal_id])).rows[0]?.t;
    const moveVals: Row = {
      move_type: "entry", state: "draft", name: "/", ref: vals.ref, date: vals.date, journal_id: vals.journal_id, company_id: vals.company_id,
      partner_id: vals.partner_id, commercial_partner_id: commercial, currency_id: vals.currency_id, partner_bank_id: vals.partner_bank_id,
      origin_payment_id: vals.origin_payment_id, auto_post: "no", always_tax_exigible: true, amount_untaxed: 0, amount_tax: 0, amount_total: totalCurrency,
      amount_residual: 0, amount_untaxed_signed: 0, amount_tax_signed: 0, amount_total_signed: total, amount_residual_signed: 0,
      amount_untaxed_in_currency_signed: 0, amount_total_in_currency_signed: totalCurrency, payment_state: "not_paid", review_state: "no_review",
      invoice_currency_rate: 0, inventory_closing: false, is_manually_modified: false, posted_before: false, fiscal_position_id: await moveFiscalPosition(env, vals.company_id, vals.partner_id),
      invoice_partner_display_name: partnerName, sequence_prefix: "", sequence_number: 0,
    };
    const id = await insertRow(env, "account_move", moveVals);
    await mailAfterCreate(env, "account.move", [id], [{ move_type: "entry", partner_id: vals.partner_id, journal_id: vals.journal_id }]);
    created.push({ id, vals, companyCurrency, journalType });
  }
  const names = new Map<number, string>();
  const byName = [...created].sort((a, b) => (a.vals.date < b.vals.date ? -1 : a.vals.date > b.vals.date ? 1 : (a.vals.ref ?? "") < (b.vals.ref ?? "") ? -1 : (a.vals.ref ?? "") > (b.vals.ref ?? "") ? 1 : a.id - b.id));
  for (const { id } of byName) {
    const rec = new DbRec(env, env.reg.model("account.move"), id);
    const name = await lockedNextSequence(env, rec, id);
    const { prefix, number } = splitSequence(name);
    await updateRow(env, "account_move", id, { name, state: "posted", posted_before: true, sequence_prefix: prefix, sequence_number: number });
    names.set(id, name);
  }
  for (const { id, vals, companyCurrency, journalType } of created) {
    const name = names.get(id)!;
    for (const l of vals.lines) {
      const amount = l.amount_currency ?? l.balance;
      // the tax line of a write-off: the repartition line's tax and its tax group (stored related fields)
      const rep = l.tax_repartition_line_id ? (await env.cr.query<{ tax: number; grp: number }>(
        "SELECT r.tax_id AS tax, t.tax_group_id AS grp FROM account_tax_repartition_line r JOIN account_tax t ON t.id = r.tax_id WHERE r.id = $1", [l.tax_repartition_line_id])).rows[0] : undefined;
      const lineId = await insertRow(env, "account_move_line", {
        move_id: id, move_name: name, name: l.name, account_id: l.account_id, partner_id: l.partner_id, currency_id: l.currency_id ?? vals.currency_id,
        company_currency_id: companyCurrency, company_id: vals.company_id, journal_id: vals.journal_id, date: vals.date, date_maturity: l.date_maturity === undefined ? vals.date : l.date_maturity,
        balance: l.balance, amount_currency: amount, debit: l.balance > 0 ? l.balance : 0, credit: l.balance < 0 ? -l.balance : 0,
        amount_residual: l.balance, amount_residual_currency: amount, reconciled: false, display_type: "product", parent_state: "posted", ref: vals.ref,
        sequence: l.sequence ?? 100, quantity: 1, price_unit: 0, discount: 0, price_subtotal: amount, price_total: l.price_total ?? amount, deductible_percentage: 1,
        // account_move_line.py `_compute_no_followup`: lines of miscellaneous journals
        is_storno: false, no_followup: journalType === "general", payment_id: l.payment_id ?? null,
        ...(rep ? { tax_repartition_line_id: l.tax_repartition_line_id, tax_line_id: rep.tax, tax_group_id: rep.grp } : {}),
      });
      for (const t of l.tax_ids ?? []) await env.cr.query("INSERT INTO account_move_line_account_tax_rel (account_move_line_id, account_tax_id) VALUES ($1, $2)", [lineId, t]);
      for (const t of l.tax_tag_ids ?? []) await env.cr.query("INSERT INTO account_account_tag_account_move_line_rel (account_move_line_id, account_account_tag_id) VALUES ($1, $2)", [lineId, t]);
    }
  }
  return created.map((c) => c.id);
}


/**
 * account_move_line.py:3472-3474 `reconcile` of two journal items through RPC (`_reconcile_plan([self])`), after
 * `_check_amls_exigibility_for_reconciliation` (:2973-3003). Any other number of lines refuses.
 */
registerMethod("account.move.line", "reconcile", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  return reconcileRpc(env, ids ?? []);
}, { apiModel: false });

/**
 * account_move.py:6883-6892 `js_assign_outstanding_line(line_id)` (the invoice's "Add" on an outstanding credit or
 * debit): the given line and the invoice's unreconciled lines of its account (in `line_ids` order), reconciled.
 */
registerMethod("account.move", "js_assign_outstanding_line", async (env0, ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  if (ids?.length !== 1) throw new NotPorted("js_assign_outstanding_line on several moves (ensure_one)");
  const lineId = "line_id" in kwargs ? kwargs["line_id"] : args[0];
  if (typeof lineId !== "number" || !Number.isInteger(lineId)) throw new NotPorted("js_assign_outstanding_line with a line_id that is not an integer");
  const [first] = await linesById(env, [lineId]);
  if (!first) throw new NotPorted("js_assign_outstanding_line of a journal item that does not exist (MissingError)");
  const own = await env.model("account.move.line").search(D.and([D.cond("move_id", "=", ids[0]!), D.cond("account_id", "=", first.account_id)]));
  const rows = (await env.cr.query<{ id: number; reconciled: boolean | null }>("SELECT id, reconciled FROM account_move_line WHERE id = ANY($1::int[])", [own])).rows;
  const open = own.filter((id) => !rows.find((r) => r.id === id)?.reconciled);
  if (open.includes(lineId)) throw new NotPorted("js_assign_outstanding_line of one of the invoice's own lines (a recordset with the line twice)");
  return reconcileRpc(env, [lineId, ...open]);
}, { apiModel: false });

/** The body of `account.move.line.reconcile` for RPC callers (see above). */
async function reconcileRpc(env: Environment, list: readonly number[]): Promise<null> {
  if (!env.su) {
    // the partial is created through the ORM (account.partial.reconcile `create`), which checks the model access
    await checkModelAccess(env, env.reg.model("account.partial.reconcile"), "create");
    await env.model("account.move.line").checkAccess([...list], "write");
  }
  const lines = await linesById(env, list);
  if (lines.length !== list.length) throw new NotPorted("reconcile of journal items that do not exist");
  const partialP = new Set(lines.filter((l) => !l.reconciled && l.matching_number?.startsWith("P")).map((l) => l.matching_number));
  const checked = lines.filter((l) => !l.reconciled || !partialP.has(l.matching_number));
  if (checked.some((l) => l.reconciled)) throw new UserError(translate(env, "You are trying to reconcile some entries that are already reconciled.", "account"));
  if (checked.some((l) => l.parent_state === "cancel")) throw new UserError(translate(env, "You can not reconcile cancelled entries.", "account"));
  // account_move_line.py:2992-2997 on the plan's amls (:3036-3042 sorted by maturity or date, currency, amounts): the
  // accounts in that order (`mapped`), by display name
  const accounts = [...new Set(checked.map((l, i) => ({ l, i })).sort((a, b) => {
    const da = a.l.date_maturity || a.l.date, db = b.l.date_maturity || b.l.date;
    return (da < db ? -1 : da > db ? 1 : 0) || (a.l.currency_id - b.l.currency_id) || (a.l.amount_currency - b.l.amount_currency) || (a.l.balance - b.l.balance) || (a.i - b.i);
  }).map((x) => x.l.account_id))];
  if (accounts.length > 1) {
    if (new Set(checked.map((l) => l.currency_id)).size > 1) throw new NotPorted("reconcile of entries of several accounts and currencies (the plan's nodes)");
    const names = await env.model("account.account").displayName(accounts);
    throw new UserError(translate(env, "Entries are not from the same account: %s", "account").replace("%s", accounts.map((a) => names.get(a) ?? "").join(", ")));
  }
  if (new Set(checked.map((l) => l.company_id)).size > 1) throw new NotPorted("reconcile of entries of several companies");
  // at precommit the payments' state follows the moves' payment state (round 11, second pass: `opus11_acc`, a paid
  // payment reconciled again by hand becomes 'reconciled' after its invoice's "Not Paid → Paid")
  // (the earlier payments settled by an invoice becoming paid too: `settleEarlierPayments` logs them in `later`)
  const defer: TrackingDefer = { states: new Map(), later: [], payments: [] };
  const moveOrder = await reconcileLines(env, lines, defer);
  await finalizeTracking(env, { states: defer.states, later: [] }, moveOrder);
  for (const fn of [...defer.later, ...(defer.payments ?? [])]) await fn();
  // the reconciliation status of the payments involved (is_reconciled, is_matched; their state is settled above);
  // before round 11 a payment reconciled here kept is_reconciled false
  await refreshPaymentStatus(env, await affectedPayments(env, [...new Set(lines.map((l) => l.move_id))]));
  return null;
}


/**
 * account_move_line.py:2017-2040 `_search` / `search_fetch`: every search of journal items gets an explicit `, id` when
 * its order names no `id` (`order or self._order`); an `open_on` condition sets `recon_limit` (not ported: refuses).
 * The cumulated balance context keys only matter to `cumulated_balance`, whose compute is not ported (it refuses).
 */
function refuseOpenOn(domain: unknown): void {
  if (JSON.stringify(domain ?? []).includes("open_on")) throw new NotPorted("account.move.line search on open_on (recon_limit)");
}

registerHooks("account.move.line", {
  searchFetch: async (env, domain, opts, next) => {
    refuseOpenOn(D.toList(domain));
    let order = opts.order || env.reg.model("account.move.line").order;
    if (!/\bid\b/.test(order)) order += ", id";
    return next(domain, { ...opts, order });
  },
});

/** account_move_line.py:1983-1985 `_get_default_read_fields`: `fields_get(attributes=())` without the five weirdos. */
async function lineDefaultReadFields(env: Environment): Promise<string[]> {
  const weirdos = new Set(["term_key", "epd_key", "epd_needed", "discount_allocation_key", "discount_allocation_needed"]);
  return Object.keys(await env.model("account.move.line").fieldsGet(null, [])).filter((f) => !weirdos.has(f));
}

registerMethod("account.move.line", "search", async (env0, _ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  return search(env, "account.move.line", args, kwargs);
}, { apiModel: true, readonly: true });

// `search_count` -> `_search` (account_move_line.py:2018-2023): only the recon_limit of an open_on condition
registerMethod("account.move.line", "search_count", async (env0, _ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  refuseOpenOn("domain" in kwargs ? kwargs["domain"] : args[0]);
  return searchCount(env, "account.move.line", args, kwargs);
}, { apiModel: true, readonly: true });

// account_move_line.py:1987-1989 read: no fields means the default read fields
registerMethod("account.move.line", "read", async (env0, ids, args0, kwargs0) => {
  const { env, kwargs: kw } = envFor(env0, kwargs0);
  const args = [...args0], kwargs = { ...kw };
  const given = "fields" in kwargs ? kwargs["fields"] : args[0];
  if (!given || (Array.isArray(given) && !given.length)) {
    if ("fields" in kwargs || !args.length) kwargs["fields"] = await lineDefaultReadFields(env);
    else args[0] = await lineDefaultReadFields(env);
  }
  const { readMethod } = await import("../web/read_methods");
  return readMethod(env, "account.move.line", ids ?? [], args, kwargs);
}, { apiModel: false, readonly: true });

// account_move_line.py:1991-1994 search_read: no fields means the default read fields, then the generic search_read
registerMethod("account.move.line", "search_read", async (env0, _ids, args0, kwargs0) => {
  const { env, kwargs: kw } = envFor(env0, kwargs0);
  const args = [...args0], kwargs = { ...kw };
  const given = "fields" in kwargs ? kwargs["fields"] : args[1];
  if (!given || (Array.isArray(given) && !given.length)) {
    if ("fields" in kwargs || args.length < 2) kwargs["fields"] = await lineDefaultReadFields(env);
    else args[1] = await lineDefaultReadFields(env);
  }
  const { searchRead } = await import("./res_lang");
  return searchRead(env, "account.move.line", args, kwargs);
}, { apiModel: true, readonly: true });

/**
 * `_optimize_reconciliation_plan` (account_move_line.py:3005-3097): the lines sorted by (date_maturity or date,
 * currency, amount in currency, balance), then `self.browse(set(ids))`. The moves of that order are the container of
 * `_sync_dynamic_lines` (account_move.py:3827), whose dirty-flag write prepares their tracking in that order.
 */
function planOrder(lines: readonly LineRow[]): { sorted: LineRow[]; moves: number[] } {
  const key = (l: LineRow): [string, number, number, number] => [l.date_maturity ?? l.date, l.currency_id, l.amount_currency, l.balance];
  const sorted = [...lines].sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < 4; i++) if (ka[i] !== kb[i]) return ka[i]! < kb[i]! ? -1 : 1;
    return 0;
  });
  // `results['aml_ids'] = set(sorted_amls.ids)`, then `all_aml_ids = set(); all_aml_ids.update(...)` and
  // `self.browse(all_aml_ids)`: the order of the merged set (set_merge copies or re-inserts the table)
  const all = new PySet();
  all.update(PySet.fromList(sorted.map((l) => l.id)));
  const order = all.order();
  return { sorted, moves: [...new Set(order.map((id) => lines.find((l) => l.id === id)!.move_id))] };
}

/**
 * `reconcile()` of journal items (account_move_line.py:3113-3300 `_reconcile_plan`): two lines go through
 * `reconcilePair`; more are ported in one currency, the company's, without earlier partials or cash basis taxes:
 * `_prepare_reconciliation_amls` (:2867-2932) matches the sorted debit and credit lines in turn, the partials are created
 * together, then the full reconcile of the plan when every line is reconciled, else the matching numbers of the graphs
 * (account_partial_reconcile.py:193-237). Returns the moves in their tracking order (`planOrder`).
 */
export async function reconcileLines(env: Environment, lines: readonly LineRow[], defer?: TrackingDefer): Promise<number[]> {
  const { sorted, moves } = planOrder(lines);
  if (lines.length === 2) {
    await reconcilePair(env, lines[0]!, lines[1]!, defer);
    return moves;
  }
  if (lines.length < 2) throw new NotPorted(`reconcile of ${lines.length} journal item`);
  if (lines.some((l) => l.currency_id !== l.company_currency_id)) throw new NotPorted("reconciliation of more than two lines in a foreign currency");
  if (lines.some((l) => l.matching_number)) throw new NotPorted("reconciliation of more than two lines with earlier partials");
  if (new Set(lines.map((l) => l.account_id)).size > 1) throw new NotPorted("reconciliation of more than two lines of several accounts");
  const moveIds = [...new Set(lines.map((l) => l.move_id))];
  const taxes = (await env.cr.query(
    `SELECT 1 FROM account_move_line l JOIN account_tax t ON t.id = l.tax_line_id WHERE l.move_id = ANY($1::int[]) AND t.tax_exigibility = 'on_payment' LIMIT 1`, [moveIds])).rows.length;
  if (taxes) throw new NotPorted("reconciliation with cash basis taxes (_create_tax_cash_basis_moves)");
  const cur = await currencyData(env, lines[0]!.company_currency_id);
  const zero = (v: number): boolean => isZero(v, cur.rounding);
  await touchSyncedInvoices(env, moves);
  const residual = new Map(lines.map((l) => [l.id, l.amount_residual]));
  const debits = sorted.filter((l) => l.balance > 0 || l.amount_currency > 0), credits = sorted.filter((l) => l.balance < 0 || l.amount_currency < 0);
  const partials: { debit: LineRow; credit: LineRow; amount: number }[] = [];
  let di = 0, ci = 0;
  while (di < debits.length && ci < credits.length) {
    const d = debits[di]!, c = credits[ci]!;
    const dr = residual.get(d.id)!, cr = -residual.get(c.id)!;
    // :2616-2627 nothing left on a side: move to its next line
    let skip = false;
    if (zero(dr)) { di++; skip = true; }
    if (zero(cr)) { ci++; skip = true; }
    if (skip) continue;
    const cmp = zero(dr - cr) ? 0 : dr < cr ? -1 : 1;
    const amount = Math.min(dr, cr);
    partials.push({ debit: d, credit: c, amount });
    residual.set(d.id, dr - amount);
    residual.set(c.id, -(cr - amount));
    if (cmp <= 0) di++;
    if (cmp >= 0) ci++;
  }
  const partialIds: number[] = [];
  for (const p of partials) partialIds.push(await insertPartial(env, p.debit, p.credit, p.amount, p.amount, p.amount));
  for (const l of lines) await refreshLineResidual(env, l);
  const graph = await reconciliationGraph(env, lines.map((l) => l.id));
  const states = (await env.cr.query<{ id: number; reconciled: boolean; residual: number }>(
    "SELECT id, reconciled, amount_residual_currency::float8 AS residual FROM account_move_line WHERE id = ANY($1::int[])", [graph.lines])).rows;
  const touched = new Set(partials.flatMap((p) => [p.debit.id, p.credit.id]));
  // :3233-3242 `is_line_reconciled`: reconciled, or matched with a zero residual in its currency
  const isReconciled = (r: { id: number; reconciled: boolean; residual: number }): boolean => r.reconciled || (touched.has(r.id) && zero(r.residual));
  if (states.every(isReconciled)) {
    await fullReconcile(env, graph);
  } else {
    // `_update_matching_number`: each graph of partials gets the smallest partial id of its edges
    const rows = (await env.cr.query<{ id: number; d: number; c: number }>(
      "SELECT id, debit_move_id AS d, credit_move_id AS c FROM account_partial_reconcile WHERE id = ANY($1::int[]) ORDER BY id", [graph.partials])).rows;
    const number = new Map<number, number>();
    for (const r of rows) {
      const dn = number.get(r.d), cn = number.get(r.c);
      if (dn !== undefined && cn !== undefined) {
        if (dn !== cn) { const lo = Math.min(dn, cn), hi = Math.max(dn, cn); for (const [k, v] of number) if (v === hi) number.set(k, lo); }
      } else if (dn !== undefined) number.set(r.c, dn);
      else if (cn !== undefined) number.set(r.d, cn);
      else { number.set(r.d, r.id); number.set(r.c, r.id); }
    }
    for (const [id, n] of number) await updateRow(env, "account_move_line", id, { matching_number: `P${n}` });
  }
  for (const m of moves) await refreshMoveResidual(env, m, defer);
  return moves;
}

/**
 * mail_thread.py:628-690 `_track_log` at precommit for the moves whose payment state a reconciliation changed (in the
 * order their tracking was prepared): the changes with a subtype (an invoice becoming paid) are posted record by record,
 * the others logged together after them; the payments' own tracking (another model, prepared later) follows.
 */
export async function finalizeTracking(env: Environment, defer: TrackingDefer, moveOrder: readonly number[]): Promise<void> {
  const order = [...new Set([...moveOrder, ...defer.states.keys()])].filter((m) => defer.states.has(m));
  const posts: number[] = [], logs: number[] = [];
  for (const m of order) (defer.states.get(m)![1] === "paid" && isInvoice((await moveRow(env, m)).move_type) ? posts : logs).push(m);
  // the earlier payments' state (settleEarlierPayments) is logged before the invoices' tracking, as without a defer
  for (const fn of defer.later) await fn();
  for (const m of [...posts, ...logs]) await logPaymentState(env, m, ...defer.states.get(m)!);
}
