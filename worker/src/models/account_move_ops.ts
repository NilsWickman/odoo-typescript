/**
 * account.move operations on existing documents: posting a draft (account_move.py:6134-6393), reset to draft
 * (:6920-6940), the credit note wizard (wizard/account_move_reversal.py with :5891-5930 `_reverse_moves`), and the
 * sequence gap flag (:6412-6505). Documents in the company currency; the branches that would need more refuse.
 */
import { PrivateRecords } from "../orm/private_hooks";
import * as priv from "../orm/dispatch_gen";
import { contextDay } from "./util";
import { checkMoveWrite } from "./account_integrity";
import { luhnCheckDigit } from "./luhn";
import { NotPorted, UserError } from "../errors";
import { registerMethod } from "../http/methods";
import { evalExpr } from "../pyexpr";
import { and, cond, parseDomain } from "../orm/domain";
import { DbRec, RecomputeQueue, registerDefaults, registerRecordCompute, type Rec } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { registerOverrides } from "../orm/write";
import { envFor } from "../web/common";
import { computeAuthor, escapeText, insertMessages, messageLogBatch, replyToDefault, trackingMessageId, xmlid } from "../mail/message";
import { formatTrackingDate } from "../mail/tracking_format";
import { flatThreadParent } from "../mail/thread_generic";
import { contextToday } from "./account_computes";
import { directionSign, increaseRank, insertRow, linesById, logPaymentState, mailAfterCreate, moveLines, moveRow, paymentStateTracking, trackedLabel, trackedSelection, reconcileLines, reconcilePair, splitSequence, touchSyncedInvoices, updateRow, type Row, type TrackingDefer } from "./account_entries";
import { deduceReset, lastSequence, lockedNextSequence } from "./invoicing_computes";
import { hashMoves } from "./account_hash";
import { installmentName } from "./account_move_create";
import { accountingDateAfterLocks, affectsTaxReport, formatDate, violatedLockDates } from "./account_locks";
import { defineComputes, withCompany } from "./tail_util";
import { translate, translateLang } from "./util";
import { createdInTransaction, noteCreated } from "../orm/created";
import { userHasGroup } from "../web/groups";
import { unlink } from "../orm/unlink";

/** l10n_se: Swedish OCR reference (se_ocr2 / se_ocr3) with length digit and Luhn check digit. */
export function swedishOcrReference(id: number | string, model: "se_ocr2" | "se_ocr3"): string {
  let ref = String(id);
  if (model === "se_ocr3") ref += String((ref.length + 2) % 10);
  return ref + luhnCheckDigit(ref);
}

const SALE = ["out_invoice", "out_refund"], PURCHASE = ["in_invoice", "in_refund"];
const SALE_R = [...SALE, "out_receipt"], PURCHASE_R = [...PURCHASE, "in_receipt"];
const isInvoice = (t: string): boolean => SALE_R.includes(t) || PURCHASE_R.includes(t);
/** account_move.py:67-75 `TYPE_REVERSE_MAP` of the invoices. */
const TYPE_REVERSE_MAP: Record<string, string> = { out_invoice: "out_refund", out_refund: "out_invoice", in_invoice: "in_refund", in_refund: "in_invoice", out_receipt: "out_refund", in_receipt: "in_refund" };

interface SeqRow { id: number; name: string | null; state: string; sequence_number: number | null; made_sequence_gap: boolean | null }

/** account_move.py:6412-6505 `_update_sequence_made_gap(invalidate_current)` for one move. */
/**
 * `opts.asWrite`: the flags are assigned through account.move.write (`move.made_sequence_gap = ...`), which marks the
 * moves `is_manually_modified` unless the context says `skip_is_manually_modified` (account_move.py:4085-4086).
 */
export async function updateSequenceGap(env: Environment, moveId: number, opts: { invalidate?: boolean; computedWithMixin?: boolean; asWrite?: boolean } = {}): Promise<void> {
  const cur = (await env.cr.query<SeqRow & { journal_id: number; sequence_prefix: string | null }>(
    "SELECT id, name, state, sequence_number, made_sequence_gap, journal_id, sequence_prefix FROM account_move WHERE id = $1", [moveId])).rows[0]!;
  const near = async (op: string, dir: string): Promise<SeqRow[]> => (await env.cr.query<SeqRow>(
    `SELECT id, name, state, sequence_number, made_sequence_gap FROM account_move other
      WHERE other.journal_id = $1 AND other.sequence_prefix = $2 AND other.sequence_number ${op} $3 AND other.name LIKE '%' || other.sequence_number
      ORDER BY other.sequence_number ${dir} LIMIT 2`, [cur.journal_id, cur.sequence_prefix, cur.sequence_number])).rows;
  const named = (m: SeqRow | undefined): boolean => Boolean(m && m.name && m.name !== "/");
  const check = (prev: SeqRow | undefined, c: SeqRow, next: SeqRow | undefined): boolean => named(c) && (
    (named(prev) && c.sequence_number !== prev!.sequence_number! + 1) || (next !== undefined && c.state !== "posted" && prev?.state === "posted"));
  const set = async (m: SeqRow, v: boolean): Promise<void> => {
    if (Boolean(m.made_sequence_gap) === v) return;
    await updateRow(env, "account_move", m.id, opts.asWrite && !env.context["skip_is_manually_modified"] ? { made_sequence_gap: v, is_manually_modified: true } : { made_sequence_gap: v });
  };
  const [p1, p2] = await near("<", "DESC"), [n1, n2] = await near(">", "ASC");
  const invalidate = opts.invalidate ?? false, mixin = opts.computedWithMixin ?? false;
  await set(cur, (!mixin || cur.state !== "posted") && check(p1, cur, n1));
  if (n1) await set(n1, (invalidate && p1 !== undefined) || check(invalidate ? undefined : cur, n1, n2));
  if (p1 && (!mixin || cur.state !== "posted" || p1.state !== "posted")) await set(p1, check(p2, p1, invalidate ? undefined : cur));
}

async function trackingLog(env: Environment, moveId: number, body: string): Promise<void> {
  await messageLogBatch(env, "account.move", new Map([[moveId, body]]), { messageType: "tracking" });
}

/**
 * account product.py:194-205 product.template `_compute_valuation` (depends_context company) for a product.product
 * (related `product_tmpl_id.valuation`): False when not storable, else the category's company-dependent
 * `property_valuation` for the product's company (the current one when it has none or the current one is a child),
 * else that company's `inventory_valuation` (`company_default_for`, the ir.default of the category field).
 */
export async function productValuation(env: Environment, productId: number): Promise<string | false> {
  const t = (await env.cr.query<{ t: number }>("SELECT product_tmpl_id AS t FROM product_product WHERE id = $1", [productId])).rows[0];
  return t ? templateValuation(env, t.t) : false;
}

/** The same for a product.template (the compute itself). */
export async function templateValuation(env: Environment, templateId: number): Promise<string | false> {
  const row = (await env.cr.query<{ storable: boolean | null; company: number | null; categ: number | null }>(
    `SELECT t.is_storable AS storable, t.company_id AS company, t.categ_id AS categ FROM product_template t WHERE t.id = $1`, [templateId])).rows[0];
  if (!row || !row.storable) return false;
  const current = await env.company();
  let company = row.company ?? current;
  if (row.company !== null && row.company !== current) {
    // `self.env.company.filtered_domain([('id', 'child_of', company.id)])`
    const path = (await env.cr.query<{ p: string | null }>("SELECT parent_path AS p FROM res_company WHERE id = $1", [current])).rows[0]?.p ?? "";
    if (`/${path}`.includes(`/${row.company}/`)) company = current;
  }
  const cenv = await withCompany(env, company);
  const categ = row.categ === null ? null : await new DbRec(cenv, env.reg.model("product.category"), row.categ).get("property_valuation");
  if (typeof categ === "string" && categ) return categ;
  const fallback = await new DbRec(cenv, env.reg.model("res.company"), company).get("inventory_valuation");
  return typeof fallback === "string" && fallback ? fallback : false;
}

/** The stored sale.order.line computes on `invoice_lines.move_id.state`, recomputed (with their dependents) after a state change. */
export async function recomputeSaleLines(env: Environment, moveId: number): Promise<void> {
  if (!env.reg.models.has("sale.order.line")) return;
  const lines = (await env.cr.query<{ id: number }>(
    `SELECT DISTINCT r.order_line_id AS id FROM sale_order_line_invoice_rel r JOIN account_move_line l ON l.id = r.invoice_line_id
      WHERE l.move_id = $1 ORDER BY 1`, [moveId])).rows.map((r) => r.id);
  if (!lines.length) return;
  const def = env.reg.model("sale.order.line");
  const queue = new RecomputeQueue(env);
  // models.py `modified` marks the fields depending on these transitively: `invoice_status` (on `qty_invoiced`,
  // sale_order_line.py:1377) is computed again with them (a down payment line becomes "to invoice" once posted)
  for (const f of ["qty_invoiced", "untaxed_amount_invoiced", "untaxed_amount_to_invoice", "invoice_status"]) if (def.fields.get(f)?.store) queue.add("sale.order.line", f, lines);
  await queue.run();
}

/**
 * account_move.py:6352-6365: the lines of the reversed entry and its reversal that are not reconciled and whose account
 * is reconcilable (or was reconciled before), grouped by (account, currency, tax line), are reconciled
 * (`_reconcile_plan`). Groups where all lines share one sign (or have zero residual) produce no partial, matching
 * Odoo's `_prepare_reconciliation_amls`.
 */
async function reconcileReversals(
  env: Environment,
  pairs: readonly { reversed: number; reverse: number }[],
  accounts: ReadonlySet<number>,
  defer: TrackingDefer,
): Promise<void> {
  if (!pairs.length) return;
  const planGroups: number[][] = [];
  for (const { reversed, reverse } of pairs) {
    const rows = (await env.cr.query<{ id: number; account_id: number; currency_id: number; tax_line_id: number | null; reconcile: boolean | null; caba: number | null }>(
      `SELECT l.id, l.account_id, l.currency_id, l.tax_line_id, a.reconcile, t.cash_basis_transition_account_id AS caba
         FROM account_move_line l JOIN account_account a ON a.id = l.account_id LEFT JOIN account_tax t ON t.id = l.tax_line_id
        WHERE l.move_id = ANY($1::int[]) AND NOT COALESCE(l.reconciled, FALSE)
        ORDER BY array_position($1::int[], l.move_id), l.date DESC, l.move_name DESC, l.id`, [[reversed, reverse]])).rows
      .filter((l) => l.reconcile || accounts.has(l.account_id) || l.caba);
    const groups = new Map<string, number[]>();
    for (const l of rows) {
      const key = `${l.account_id}/${l.currency_id}/${l.tax_line_id ?? ""}`;
      groups.set(key, [...(groups.get(key) ?? []), l.id]);
    }
    for (const ids of groups.values()) {
      if (ids.length >= 2) planGroups.push(ids);
    }
  }
  for (const ids of planGroups) {
    const lines = await linesById(env, ids);
    const hasDebit = lines.some((l) => l.amount_residual > 0 || l.amount_residual_currency > 0);
    const hasCredit = lines.some((l) => l.amount_residual < 0 || l.amount_residual_currency < 0);
    if (!hasDebit || !hasCredit) {
      // Odoo `_reconcile_plan` enters `_sync_dynamic_lines` for all_amls.move_id, then creates 0 partials
      await touchSyncedInvoices(env, [...new Set(lines.map((l) => l.move_id))]);
      continue;
    }
    if (lines.length === 2) {
      await reconcilePair(env, lines[0]!, lines[1]!, defer);
    } else {
      await reconcileLines(env, lines, defer);
    }
  }
}

const isInvoiceNoReceipts = (t: string): boolean => SALE.includes(t) || PURCHASE.includes(t);

interface PostExtra {
  reversed: number | null;
  restrict: boolean | null;
  jtype: string | null;
  review: string | null;
  set_to_review: boolean | null;
  auto: string | null;
  date: string;
  uuid: string | null;
  inv_date: string | null;
  invoice_reference_type: string | null;
  invoice_reference_model: string | null;
  payment_reference: string | null;
  ref: string | null;
}

/** `_post` of draft moves after the validation messages (account_move.py:6260-6393) with their tracking. */
export async function postDrafts(env: Environment, idsIn: readonly number[], opts: { readonly later?: (() => Promise<void>)[]; readonly last?: (() => Promise<void>)[] } = {}): Promise<void> {
  if (!idsIn.length) return;
  const ids: number[] = [...idsIn];

  const loadMeta = async (id: number) => {
    const m = await moveRow(env, id);
    const extra = (await env.cr.query<PostExtra>(
      `SELECT m.reversed_entry_id AS reversed, j.restrict_mode_hash_table AS restrict, j.type AS jtype,
              m.review_state AS review, co.set_to_review_documents AS set_to_review, m.auto_post AS auto, m.date::text AS date,
              m.peppol_message_uuid AS uuid, m.invoice_date::text AS inv_date, j.invoice_reference_type, j.invoice_reference_model, m.payment_reference, m.ref
         FROM account_move m JOIN account_journal j ON j.id = m.journal_id JOIN res_company co ON co.id = m.company_id
        WHERE m.id = $1`, [id])).rows[0]!;
    if (extra.uuid) throw new NotPorted("_post with a Peppol response");
    return { m, extra };
  };

  const metas = new Map<number, { m: Awaited<ReturnType<typeof moveRow>>; extra: PostExtra }>();
  for (const id of ids) metas.set(id, await loadMeta(id));

  // :6267-6271 lock date adjustments per move
  const dateLines = new Map<number, string>();
  const today = await contextToday(env);
  for (const id of ids) {
    const { m, extra } = metas.get(id)!;
    const locks = await violatedLockDates(env, m.company_id, extra.date, await affectsTaxReport(env, id), extra.jtype);
    if (locks.length) {
      const rec = new DbRec(env, env.reg.model("account.move"), id);
      const highest = ((await rec.get("highest_name")) || (await lastSequence(env, rec, true))) as string | null;
      const date = await accountingDateAfterLocks(SALE_R.includes(m.move_type), extra.inv_date ?? extra.date, today, highest || null,
        highest ? deduceReset(String(highest)) : "never", locks);
      if (date !== extra.date) {
        await updateRow(env, "account_move", id, { date });
        await env.cr.query("UPDATE account_move_line SET date = $2 WHERE move_id = $1", [id, date]);
        const lang = env.lang ?? "en_US";
        const [fromFmt, toFmt] = await Promise.all([formatTrackingDate(extra.date, lang), formatTrackingDate(date, lang)]);
        dateLines.set(id, `${escapeText(fromFmt)} → <b>${escapeText(toFmt)}</b> <i>(${escapeText(trackedLabel(env, "account.move", "date"))})</i><br>`);
        extra.date = date;
      }
    }
  }

  // :6274 batch analytic line creation across all moves in to_post
  const hasAnalytic = (await env.cr.query<{ ok: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM account_move_line WHERE move_id = ANY($1::int[]) AND analytic_distribution IS NOT NULL) AS ok", [ids])).rows[0]!.ok;
  if (hasAnalytic) {
    const { createAnalyticLines } = await import("./analytic_post");
    await createAnalyticLines(env, ids);
  }

  // :6280-6285 fix partner inconsistencies on invoice lines (_get_lines_with_wrong_partner)
  for (const id of ids) {
    const { m } = metas.get(id)!;
    if (!isInvoiceNoReceipts(m.move_type)) continue;
    const comm = (await env.cr.query<{ p: number | null }>("SELECT commercial_partner_id AS p FROM account_move WHERE id = $1", [id])).rows[0]?.p ?? null;
    const wrong = (await env.cr.query<{ id: number }>(
      `SELECT id FROM account_move_line
        WHERE move_id = $1 AND partner_id IS DISTINCT FROM $2
          AND (display_type IS NULL OR display_type NOT IN ('line_section', 'line_subsection', 'line_note'))
        ORDER BY id`, [id, comm])).rows;
    for (const w of wrong) {
      await updateRow(env, "account_move_line", w.id, { partner_id: comm });
    }
  }

  // :6288-6296 collect draft_reverse_moves & previously reconciled accounts
  const draftReversePairs: { reversed: number; reverse: number }[] = [];
  for (const id of ids) {
    const { extra } = metas.get(id)!;
    if (extra.reversed && (await moveRow(env, extra.reversed)).state === "posted") {
      draftReversePairs.push({ reversed: extra.reversed, reverse: id });
    }
  }
  const reconcileAccounts = new Set<number>();
  if (draftReversePairs.length) {
    const pairMoveIds = [...new Set(draftReversePairs.flatMap((p) => [p.reversed, p.reverse]))];
    const accRows = (await env.cr.query<{ a: number }>(
      "SELECT DISTINCT account_id AS a FROM account_move_line WHERE move_id = ANY($1::int[]) AND reconciled", [pairMoveIds])).rows;
    for (const r of accRows) reconcileAccounts.add(r.a);
  }
  const defer: TrackingDefer = { states: new Map(), later: [], payments: [] };
  if (draftReversePairs.length && env.context["move_reverse_cancel"]) {
    const { removeMoveReconcile } = await import("./account_entries");
    const reversedIds = [...new Set(draftReversePairs.map((p) => p.reversed))];
    const revLineIds = (await env.cr.query<{ id: number }>(
      "SELECT id FROM account_move_line WHERE move_id = ANY($1::int[]) ORDER BY array_position($1::int[], move_id), id", [reversedIds])).rows.map((r) => r.id);
    if (revLineIds.length) await removeMoveReconcile(env, revLineIds, defer);
  }

  // :6299-6325 deal with related draft moves on already-reconciled lines (exchange moves / CABA)
  const partialRows = (await env.cr.query<{
    id: number; exchange_move_id: number | null; exchange_state: string | null;
    draft_caba: unknown; counterpart_move_id: number; counterpart_state: string;
    move_id: number; has_caba_move: boolean;
  }>(
    `SELECT p.id, p.exchange_move_id, em.state AS exchange_state, p.draft_caba_move_vals AS draft_caba,
            CASE WHEN l.id = p.debit_move_id THEN cl.move_id ELSE dl.move_id END AS counterpart_move_id,
            CASE WHEN l.id = p.debit_move_id THEN cm.state ELSE dm.state END AS counterpart_state,
            l.move_id,
            EXISTS (SELECT 1 FROM account_move x WHERE x.tax_cash_basis_rec_id = p.id) AS has_caba_move
       FROM account_move_line l
       JOIN account_partial_reconcile p ON p.debit_move_id = l.id OR p.credit_move_id = l.id
       JOIN account_move_line dl ON dl.id = p.debit_move_id
       JOIN account_move_line cl ON cl.id = p.credit_move_id
       JOIN account_move dm ON dm.id = dl.move_id
       JOIN account_move cm ON cm.id = cl.move_id
       LEFT JOIN account_move em ON em.id = p.exchange_move_id
      WHERE l.move_id = ANY($1::int[])
      ORDER BY p.id`, [ids])).rows;
  const idSet = new Set(ids);
  for (const pr of partialRows) {
    if (pr.counterpart_state === "posted" || idSet.has(pr.counterpart_move_id)) {
      if (pr.draft_caba !== null || pr.has_caba_move) {
        throw new NotPorted("_post of a move with cash-basis reconciled lines");
      }
      if (pr.exchange_move_id && pr.exchange_state === "draft" && !idSet.has(pr.exchange_move_id)) {
        ids.push(pr.exchange_move_id);
        idSet.add(pr.exchange_move_id);
        metas.set(pr.exchange_move_id, await loadMeta(pr.exchange_move_id));
      }
    }
  }

  // :6006-6016 COGS / price-difference check
  for (const id of ids) {
    const { m } = metas.get(id)!;
    const anglo = PURCHASE_R.includes(m.move_type)
      && Boolean((await env.cr.query<{ a: boolean | null }>("SELECT anglo_saxon_accounting AS a FROM res_company WHERE id = $1", [m.company_id])).rows[0]?.a);
    if (SALE_R.includes(m.move_type) || anglo) {
      const products = (await env.cr.query<{ p: number }>(
        "SELECT DISTINCT product_id AS p FROM account_move_line WHERE move_id = $1 AND display_type = 'product' AND product_id IS NOT NULL ORDER BY 1", [id])).rows;
      const cenv = await withCompany(env, m.company_id);
      for (const { p } of products) {
        if ((await productValuation(cenv, p)) !== "real_time") continue;
        if (SALE_R.includes(m.move_type)) throw new NotPorted("_post with COGS lines (_create_cogs_lines, _get_cogs_lines_vals)");
        const [r] = await cenv.sudo().model("product.product").read([p], ["cost_method", "categ_id"], "");
        if (r?.["cost_method"] !== "standard") continue;
        const categ = Array.isArray(r["categ_id"]) ? Number(r["categ_id"][0]) : typeof r["categ_id"] === "number" ? r["categ_id"] : null;
        const [c] = categ ? await cenv.sudo().model("product.category").read([categ], ["property_price_difference_account_id"], "") : [];
        if (c?.["property_price_difference_account_id"]) throw new NotPorted("_post with price difference lines (_create_cogs_lines, _get_price_difference_lines_vals)");
      }
    }
  }

  // :4010-4024 review_state update on posting (account_move.py write)
  const isUserAbleToReview = env.su
    || (await userHasGroup(env, "account.group_account_user"))
    || (await userHasGroup(env, "account.group_account_manager"));

  // :6327-6330 post each move, assign sequence & payment_reference, update lines
  const postedInfo = new Map<number, {
    name: string;
    reference: string | null;
    termNamed: Map<number, string | null>;
  }>();
  const toHash: number[] = [];

  for (const id of ids) {
    const { m, extra } = metas.get(id)!;
    const lines = await moveLines(env, id);
    let name = m.name;
    let computed = false;
    const rec = new DbRec(env, env.reg.model("account.move"), id);
    if (!name || name === "/") {
      name = await lockedNextSequence(env, rec, id);
      computed = true;
    } else if (!(await rec.get("posted_before"))) {
      // account_move.py:1002-1009: keep manual name if sequence matches date, else reset & compute next
      const { prefix: curPref } = splitSequence(name);
      const yearMatch = /\b(19|20)\d{2}\b/.exec(curPref);
      if (yearMatch && yearMatch[0] !== extra.date.slice(0, 4)) {
        name = await lockedNextSequence(env, rec, id);
        computed = true;
      }
    }
    const { prefix, number } = splitSequence(name);
    let reference: string | null = extra.payment_reference;
    if (m.move_type === "out_invoice" && !reference) {
      if (extra.invoice_reference_model === "odoo" && extra.invoice_reference_type === "invoice") reference = name;
      else if (extra.invoice_reference_type === "invoice" && (extra.invoice_reference_model === "se_ocr2" || extra.invoice_reference_model === "se_ocr3")) {
        reference = swedishOcrReference(id, extra.invoice_reference_model);
      } else if (extra.invoice_reference_type === "none") {
        reference = null;
      } else throw new NotPorted("payment reference of the journal's reference model");
    }
    const moveUpd: Row = { name, state: "posted", posted_before: true, sequence_prefix: prefix, sequence_number: number, payment_reference: reference };
    // :4017-4022, :4110-4111 review_state transition when posting
    if (extra.auto === "no") {
      if (isUserAbleToReview) {
        if (extra.review && extra.review !== "no_review") moveUpd["review_state"] = "reviewed";
      } else if (extra.set_to_review) {
        moveUpd["review_state"] = "todo";
      }
    }
    await updateRow(env, "account_move", id, moveUpd);

    const termCount = Number((await env.cr.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM account_payment_term_line pl JOIN account_move m ON m.invoice_payment_term_id = pl.payment_id WHERE m.id = $1", [id])).rows[0]!.n);
    const termOrder = (await env.cr.query<{ id: number }>(
      "SELECT id FROM account_move_line WHERE move_id = $1 AND display_type = 'payment_term' ORDER BY COALESCE(date_maturity, '9999-12-31'::date), id", [id])).rows.map((r) => r.id);
    const termBefore = new Map((await env.cr.query<{ id: number; name: string | null }>(
      "SELECT id, name FROM account_move_line WHERE move_id = $1 AND display_type = 'payment_term'", [id])).rows.map((r) => [r.id, r.name]));
    const termNamed = new Map<number, string | null>();
    for (const l of lines) {
      const vals: Row = { parent_state: "posted", move_name: name };
      if (l.display_type === "payment_term") {
        let n = reference && extra.ref && reference !== extra.ref ? `${extra.ref} - ${reference}` : reference || (PURCHASE.includes(m.move_type) && extra.ref ? extra.ref : null);
        // untranslated, as before 9cebe072: measured on Odoo (r12_credit, posted with lang sv_SE in the call's context) the
        // posted lines are named in English; the recompute runs at a flush outside the call's context
        if (termCount > 1) n = installmentName(null, n, termOrder.indexOf(l.id) + 1);
        if (n) vals["name"] = n;
        if (n && n !== (termBefore.get(l.id) ?? null)) termNamed.set(l.id, termBefore.get(l.id) ?? null);
      }
      await updateRow(env, "account_move_line", l.id, vals);
    }
    for (const n of (await env.cr.query<{ id: number }>("SELECT id FROM account_move_line WHERE move_id = $1 AND account_id IS NULL ORDER BY sequence, id", [id])).rows) {
      await updateRow(env, "account_move_line", n.id, { parent_state: "posted", move_name: name });
    }
    await updateSequenceGap(env, id, { computedWithMixin: computed });
    if (extra.jtype !== "cash" && extra.restrict) toHash.push(id);
    postedInfo.set(id, { name, reference, termNamed });
  }

  // :4106-4109 one hashing pass for all secured non-cash moves
  if (toHash.length) {
    await hashMoves(env, toHash, { forceHash: false, raiseIfGap: true, raiseIfNoDocument: true });
  }

  // sale_order_line.py:1268, :1431 stored fields of sale lines depending on invoice_lines.move_id.state
  for (const id of ids) await recomputeSaleLines(env, id);

  // :6352-6367 one reconciliation plan across all draft_reverse_moves
  if (draftReversePairs.length) {
    await reconcileReversals(env, draftReversePairs, reconcileAccounts, defer);
  }

  // Line tracking for payment term lines named by reversal posting
  const reversedMoveSet = new Set(draftReversePairs.map((p) => p.reverse));
  for (const id of ids) {
    const { termNamed } = postedInfo.get(id)!;
    if (reversedMoveSet.has(id) && termNamed.size && !env.context["move_reverse_cancel"] && !createdInTransaction(env.cr, "account.move", id)) {
      const { trackedFields, trackRecordPrepare, trackRecordAdd, readTracked } = await import("../mail/tracking");
      const { lineLogBody } = await import("./account_integrity");
      const fields = (await trackedFields(env, "account.move.line")).filter((f) => !f.related);
      const termIds = [...termNamed.keys()];
      const current = await readTracked(env, "account.move.line", termIds, fields);
      const init = new Map(termIds.map((n) => {
        const snap = { ...(current.get(n) ?? {}) };
        if ("name" in snap) snap["name"] = termNamed.get(n) ?? false;
        return [n, snap] as const;
      }));
      const targets = new Map(termIds.map((n) => [n, { model: "account.move", id, body: lineLogBody(env, n, "updated") }]));
      defer.later.unshift(async () => {
        const { trackRecordFinalize } = await import("../mail/tracking");
        await trackRecordPrepare(env, "account.move.line", [], targets);
        trackRecordAdd(env.cr, "account.move.line", fields, init, targets);
        await trackRecordFinalize(env, "account.move.line");
      });
    }
  }

  // Tracking messages for the posted moves themselves
  const L = (f: string): string => trackedLabel(env, "account.move", f);
  const postedIdSet = new Set(ids);
  for (const id of ids) {
    const { m, extra } = metas.get(id)!;
    const { name, reference } = postedInfo.get(id)!;
    const dateLine = dateLines.get(id) ?? "";
    const paid = defer.states.get(id);
    const refLine = reference !== extra.payment_reference ? `${extra.payment_reference ?? "None"} → <b>${reference}</b> <i>(${L("payment_reference")})</i><br>` : "";
    const stateLine = paid && paid[0] !== paid[1] ? `${paymentStateTracking(env, paid[0], paid[1])}<br>` : "";
    const nameLine = name !== m.name ? `${m.name ?? "None"} → <b>${name}</b> <i>(${L("name")})</i><br>` : "";
    const body = `<div>${dateLine}${nameLine}${refLine}${stateLine}${trackedSelection(env, "account.move", "state", "draft")} → <b>${trackedSelection(env, "account.move", "state", "posted")}</b> <i>(${L("state")})</i>\n</div>`;
    const subtype = stateLine && paid![1] === "paid" && isInvoice(m.move_type) ? "account.mt_invoice_paid" : SALE_R.includes(m.move_type) ? "account.mt_invoice_validated" : null;
    if (createdInTransaction(env.cr, "account.move", id)) { /* no tracking message */ } else if (subtype) {
      const [authorId, emailFrom] = await computeAuthor(env, null, null);
      await insertMessages(env, [{
        model: "account.move", res_id: id, body, author_id: authorId, email_from: emailFrom, message_type: "tracking", subject: false,
        subtype_id: await xmlid(env, subtype), email_add_signature: true, record_company_id: m.company_id,
        parent_id: await flatThreadParent(env, "account.move", id), message_id: trackingMessageId("message-notify"), reply_to: await replyToDefault(env, emailFrom),
      }]);
    } else await trackingLog(env, id, body);
  }

  const others = async (): Promise<void> => {
    for (const [other, [from, to]] of defer.states) if (!postedIdSet.has(other)) await logPaymentState(env, other, from, to);
    for (const fn of defer.later) await fn();
  };
  if (opts.later) opts.later.push(others); else await others();
  const payments = async (): Promise<void> => { for (const fn of defer.payments ?? []) await fn(); };
  if (opts.last) opts.last.push(payments); else if (opts.later) opts.later.push(payments); else await payments();

  // :6370-6386 partner ranks aggregated across all posted moves
  const customerCount = new Map<number, number>();
  const supplierCount = new Map<number, number>();
  for (const id of ids) {
    const { m } = metas.get(id)!;
    if (m.partner_id !== null && SALE.includes(m.move_type)) {
      customerCount.set(m.partner_id, (customerCount.get(m.partner_id) ?? 0) + 1);
    } else if (m.partner_id !== null && PURCHASE.includes(m.move_type)) {
      supplierCount.set(m.partner_id, (supplierCount.get(m.partner_id) ?? 0) + 1);
    } else if (m.move_type === "entry") {
      for (const [type, map] of [["asset_receivable", customerCount], ["liability_payable", supplierCount]] as const) {
        const partners = (await env.cr.query<{ p: number }>(
          `SELECT l.partner_id AS p, min(l.id) AS first FROM account_move_line l JOIN account_account a ON a.id = l.account_id
            WHERE l.move_id = $1 AND l.partner_id IS NOT NULL AND a.account_type = $2 GROUP BY l.partner_id ORDER BY first`, [id, type])).rows;
        for (const r of partners) map.set(r.p, (map.get(r.p) ?? 0) + 1);
      }
    }
  }
  for (const [partner, count] of customerCount) await increaseRank(env, partner, "customer_rank", count);
  for (const [partner, count] of supplierCount) await increaseRank(env, partner, "supplier_rank", count);

  // stock_account account_move.py:38-50: the incoming moves of the posted lines valued again
  if (!env.context["move_reverse_cancel"]) {
    const { revalueCogsMoves } = await import("./stock_validate");
    await revalueCogsMoves(env, ids);
  }
}

registerMethod("account.move", "button_draft", async (env0, ids, _a, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  await buttonDraft(env, ids ?? [], true);
  return true;
}, { apiModel: false });

/**
 * account_move.py:6989-7011 `_detach_attachments` through the private hook: detaches invoice PDF/EDI fields
 * by clearing `res_field` and renaming each attachment with "(detached by <user> on <date>)".
 */
async function detachAttachments(env: Environment, ids: readonly number[]): Promise<void> {
  await priv.account_move._detach_attachments.call(env, ids, [], async (e, hids) => {
    const moves: number[] = [];
    for (const id of hids) {
      const v = await priv.account_move._should_detach_attachments.call(e, [id], [], async () => SALE.includes((await moveRow(e, id)).move_type));
      if (v) moves.push(id);
    }
    const fields = await priv.account_move._get_fields_to_detach.call(e, [...hids], [], async () => ["invoice_pdf_report_file"]);
    if (!Array.isArray(fields) || fields.some((f) => typeof f !== "string")) throw new NotPorted("_get_fields_to_detach giving other than field names");
    if (!moves.length || !fields.length) return null;
    const atts = (await e.sudo().cr.query<{ id: number; name: string }>(
      "SELECT id, name FROM ir_attachment WHERE res_model = 'account.move' AND res_id = ANY($1::int[]) AND res_field = ANY($2::text[]) ORDER BY id DESC",
      [moves, fields])).rows;
    if (!atts.length) return null;
    const { write } = await import("../orm/write");
    const today = await formatDate(e, await contextToday(e));
    const userName = (await e.sudo().cr.query<{ name: string }>(
      "SELECT p.name FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1", [e.uid])).rows[0]?.name ?? "";
    const tmpl = translate(e, "%(attachment_name)s (detached by %(user)s on %(date)s)%(attachment_extension)s", "account");
    for (const att of atts) {
      // Python os.path.splitext
      const dot = att.name.lastIndexOf(".");
      const isExt = dot > 0 && !att.name.slice(0, dot).split("").every((ch) => ch === ".");
      const base = isExt ? att.name.slice(0, dot) : att.name;
      const ext = isExt ? att.name.slice(dot) : "";
      const newName = tmpl
        .replace("%(attachment_name)s", () => base)
        .replace("%(attachment_extension)s", () => ext)
        .replace("%(user)s", () => userName)
        .replace("%(date)s", () => today);
      await write(e.sudo(), "ir.attachment", [att.id], { res_field: false, name: newName });
    }
    return null;
  });
}

/**
 * account_move.py:6918-6945 `button_draft`. `log` false: the state change is tracked by the caller's open scope
 * (button_cancel, whose tracking at precommit compares the first state with the last: "Posted → Cancelled").
 */
export async function buttonDraft(env: Environment, ids: readonly number[], log: boolean): Promise<void> {
  // account_move.py:6921 `move.state` reads the records (record rules, companies); `self.state = 'draft'` writes them
  // through account.move.write (:3995-4070: lock dates, hashed entries)
  await env.model("account.move").checkAccess(ids ?? [], "read");
  const all = [...(ids ?? [])];
  for (const id of all) {
    const m = await moveRow(env, id);
    if (m.state !== "cancel" && m.state !== "posted") throw new UserError(translate(env, "Only posted/cancelled journal entries can be reset to draft."));
  }
  // :6923-6924 `_is_draft_disabled`: the move's need_cancel_request (a site's EDI localization: its compute)
  if (all.length) {
    for (const r of await env.model("account.move").read(all, ["need_cancel_request"], "")) {
      if (r["need_cancel_request"]) throw new UserError(translate(env, "You can't reset to draft those journal entries. You need to request a cancellation instead."));
    }
  }
  // :6926 `_check_draftable` through the private hook (l10n_it_edi: invoices sent to the SdI), account's as the hand
  // (:7041-7059: an exchange difference entry, a locked entry, move by move)
  await priv.account_move._check_draftable.call(env, all, [], async (_e, hids) => {
    for (const id of hids) {
      const row = (await env.cr.query<{ hash: string | null; exchange: boolean }>(
        `SELECT m.inalterable_hash AS hash, EXISTS (SELECT 1 FROM account_partial_reconcile p WHERE p.exchange_move_id = m.id) AS exchange
           FROM account_move m WHERE m.id = $1`, [id])).rows[0]!;
      if (row.exchange) throw new UserError(translate(env, "You cannot reset to draft an exchange difference journal entry."));
      if (row.hash) throw new UserError(translate(env, "You cannot reset to draft a locked journal entry."));
    }
    return null;
  });
  for (const id of all) {
    const m = await moveRow(env, id);
    const row = (await env.cr.query<{ origin: number | null; cogs: boolean }>(
      `SELECT m.auto_post_origin_id AS origin,
              EXISTS (SELECT 1 FROM account_move_line l WHERE l.move_id = m.id AND l.display_type = 'cogs') AS cogs
         FROM account_move m WHERE m.id = $1`, [id])).rows[0]!;
    if (row.origin || row.cogs) throw new NotPorted("button_draft with recurring entries or COGS lines");
    // :6930 remove all analytic lines linked to this move's lines with skip_analytic_sync=True
    const analyticIds = (await env.cr.query<{ id: number }>(
      `SELECT a.id FROM account_analytic_line a JOIN account_move_line l ON l.id = a.move_line_id
        WHERE l.move_id = $1 ORDER BY a.id`, [id])).rows.map((r) => r.id);
    if (analyticIds.length) {
      await unlink(env.withContext({ ...env.context, skip_analytic_sync: true }), "account.analytic.line", analyticIds);
    }
    // :6931-6933 `_update_standard_price` / `_update_qty_available` of the posted ones: stock_account (installed)
    // overrides both with `return` (stock_account/models/account_move.py:72-76); a cancelled move only changes state
    await env.model("account.move").checkAccess([id], "write");
    await checkMoveWrite(env, [id], { state: "draft" });
    await updateRow(env, "account_move", id, { state: "draft", is_manually_modified: true, sending_data: null });
    for (const l of await moveLines(env, id)) await updateRow(env, "account_move_line", l.id, { parent_state: "draft" });
    // the section and note lines (no account): `parent_state` is related to the move's state for every line
    for (const n of (await env.cr.query<{ id: number }>("SELECT id FROM account_move_line WHERE move_id = $1 AND account_id IS NULL ORDER BY sequence, id", [id])).rows) {
      await updateRow(env, "account_move_line", n.id, { parent_state: "draft" });
    }
    await updateSequenceGap(env, id);
    if (log) await trackingLog(env, id, `<div>${trackedSelection(env, "account.move", "state", m.state)} → <b>${trackedSelection(env, "account.move", "state", "draft")}</b> <i>(${trackedLabel(env, "account.move", "state")})</i>\n</div>`);
  }
  await detachAttachments(env, all);
  // stock_account account_move.py:52-56: the incoming moves of the lines valued again (without this bill)
  const { revalueCogsMoves } = await import("./stock_validate");
  await revalueCogsMoves(env, ids);
  // sale account_move.py:133-139: the description of the down payment lines
  const { downPaymentAfterState } = await import("./sale_down_payment");
  await downPaymentAfterState(env, ids, "draft");
}

/**
 * account_move.py:7070-7082 `button_cancel`: the posted moves are reset to draft, then every move must be a draft;
 * their reconciliations removed (none here: reconciled lines refuse), their payments cancelled (moves with payments
 * refuse), then `write({'auto_post': 'no', 'state': 'cancel'})`. The state is tracked once, from the state before
 * the reset (the tracking of the reset and of the write meet at precommit).
 */
registerMethod("account.move", "button_cancel", async (env0, ids0, _a, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const ids = ids0 ?? [];
  if (!ids.length) return null;
  await env.model("account.move").checkAccess(ids, "read");
  const { trackPrepare } = await import("../mail/tracking");
  const { closeTrackingScope } = await import("../mail/write_hooks");
  await trackPrepare(env, "account.move", ids);
  const states = new Map((await env.cr.query<{ id: number; state: string }>("SELECT id, state FROM account_move WHERE id = ANY($1::int[])", [[...ids]])).rows.map((r) => [r.id, r.state]));
  const posted = ids.filter((id) => states.get(id) === "posted");
  if (posted.length) await buttonDraft(env, posted, false);
  const after = (await env.cr.query<{ state: string }>("SELECT state FROM account_move WHERE id = ANY($1::int[])", [[...ids]])).rows;
  if (after.some((r) => r.state !== "draft")) throw new UserError(translate(env, "Only draft journal entries can be cancelled.", "account"));
  const blocked = (await env.cr.query<{ partial: boolean; payment: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM account_move_line l JOIN account_partial_reconcile p ON p.debit_move_id = l.id OR p.credit_move_id = l.id WHERE l.move_id = ANY($1::int[])) AS partial,
            EXISTS (SELECT 1 FROM account_payment p WHERE p.move_id = ANY($1::int[])) OR EXISTS (SELECT 1 FROM account_move m WHERE m.id = ANY($1::int[]) AND m.origin_payment_id IS NOT NULL) AS payment`,
    [[...ids]])).rows[0]!;
  if (blocked.payment) throw new NotPorted("button_cancel of a payment's move (payment_ids.state)");
  const defer: TrackingDefer = { states: new Map(), later: [], payments: [] };
  if (blocked.partial) {
    const { removeMoveReconcile } = await import("./account_entries");
    const lineIds = (await env.cr.query<{ id: number }>(
      "SELECT id FROM account_move_line WHERE move_id = ANY($1::int[]) ORDER BY array_position($1::int[], move_id), id", [[...ids]])).rows.map((r) => r.id);
    if (lineIds.length) await removeMoveReconcile(env, lineIds, defer);
  }
  const { write } = await import("../orm/write");
  await write(env, "account.move", ids, { auto_post: "no", state: "cancel" });
  await env.cr.query("UPDATE account_move_line SET parent_state = 'cancel' WHERE move_id = ANY($1::int[])", [[...ids]]);
  // stock_account account_move.py:58-70: the COGS lines (refused at posting) and the incoming moves valued again
  const { revalueCogsMoves } = await import("./stock_validate");
  await revalueCogsMoves(env, ids);
  // sale account_move.py:141-161: the down payment lines' description and unit price
  const { downPaymentAfterState } = await import("./sale_down_payment");
  await downPaymentAfterState(env, ids, "cancel");
  await closeTrackingScope(env, "account.move");
  const cancelSet = new Set(ids);
  for (const [other, [from, to]] of defer.states) if (!cancelSet.has(other)) await logPaymentState(env, other, from, to);
  for (const fn of [...defer.later, ...(defer.payments ?? [])]) await fn();
  return null;
}, { apiModel: false });

// ------------------------------------------------------------------------------------------------ reversal wizard

registerDefaults("account.move.reversal", {
  // wizard/account_move_reversal.py:17 default=fields.Date.context_today
  date: async (env) => contextToday(env),
});
registerOverrides("account.move.reversal", {
  // account_move_reversal.py:65-82 default_get
  defaultGet: async (env, fields, values) => {
    const ids = env.context["active_model"] === "account.move" ? (env.context["active_ids"] as number[] | undefined) ?? [] : [];
    const moves = ids.length ? (await env.cr.query<{ company_id: number; state: string }>("SELECT company_id, state FROM account_move WHERE id = ANY($1::int[])", [ids])).rows : [];
    if (new Set(moves.map((m) => m.company_id)).size > 1) throw new UserError(translate(env, "All selected moves for reversal must belong to the same company."));
    if (moves.some((m) => m.state !== "posted")) throw new UserError(translate(env, "To reverse a journal entry, it has to be posted first."));
    if (fields.includes("company_id")) values["company_id"] = moves[0]?.company_id ?? await env.company();
    if (fields.includes("move_ids")) values["move_ids"] = [[6, 0, ids]];
  },
});
const reversalMoves = async (rec: Rec): Promise<number[]> => (await rec.rels("move_ids")).map((m) => m.origin).filter((id): id is number => id !== null);
registerRecordCompute("account.move.reversal", {
  // :36-43 _compute_journal_id
  journal_id: async (env, rec) => {
    const current = await rec.prev("journal_id");
    if (current) return current;
    const ids = await reversalMoves(rec);
    const rows = (await env.cr.query<{ id: number; active: boolean }>(
      "SELECT DISTINCT j.id, j.active FROM account_move m JOIN account_journal j ON j.id = m.journal_id WHERE m.id = ANY($1::int[]) ORDER BY j.id", [ids])).rows;
    return rows.find((r) => r.active)?.id ?? null;
  },
});
defineComputes("account.move.reversal", {
  // :45-56 _compute_available_journal_ids
  available_journal_ids: async (env, rec) => {
    const ids = await reversalMoves(rec);
    const company = (await rec.get("company_id")) || false;
    const base = cond("company_id", "in", [company, false]);
    if (!ids.length) return env.model("account.journal").search(base);
    const types = (await env.cr.query<{ t: string }>("SELECT DISTINCT j.type AS t FROM account_move m JOIN account_journal j ON j.id = m.journal_id WHERE m.id = ANY($1::int[])", [ids])).rows.map((r) => r.t);
    return env.model("account.journal").search(and([base, cond("type", "in", types)]));
  },
  // :84-94 _compute_from_moves
  residual: async (env, rec) => {
    const ids = await reversalMoves(rec);
    return ids.length === 1 ? (await moveRow(env, ids[0]!)).amount_residual : 0;
  },
  currency_id: async (env, rec) => {
    const ids = await reversalMoves(rec);
    const rows = (await env.cr.query<{ c: number }>("SELECT DISTINCT currency_id AS c FROM account_move WHERE id = ANY($1::int[])", [ids])).rows;
    return rows.length === 1 ? rows[0]!.c : false;
  },
  move_type: async (env, rec) => {
    const ids = await reversalMoves(rec);
    const types = (await env.cr.query<{ t: string }>("SELECT move_type AS t FROM account_move WHERE id = ANY($1::int[])", [ids])).rows.map((r) => r.t);
    if (ids.length === 1) return types[0] ?? false;
    if (types.every((t) => t === "entry")) return "entry";
    return types.some((t) => t === "in_invoice" || t === "out_invoice") ? "some_invoice" : false;
  },
});

/** account_move.py:1095-1110 `_compute_partner_bank_id` of a move whose type, company and commercial partner are known. */
export async function movePartnerBank(env: Environment, moveType: string, company: number, commercial: number | null, preferred: number | null = null): Promise<number | null> {
  const inbound = ["out_invoice", "in_refund", "out_receipt"].includes(moveType);
  const bankPartner = inbound ? (await env.cr.query<{ p: number }>("SELECT partner_id AS p FROM res_company WHERE id = $1", [company])).rows[0]!.p : commercial;
  if (inbound) {
    // :1098-1105 the preferred payment method line, else the bank partner's inbound one: its journal's bank account
    const cenv = env.withContext({ ...env.context, allowed_company_ids: [company] });
    const method = preferred !== null ? new DbRec(cenv, env.reg.model("account.payment.method.line"), preferred)
      : bankPartner === null ? null : await new DbRec(cenv, env.reg.model("res.partner"), bankPartner).rel("property_inbound_payment_method_line_id");
    const journal = method ? await method.rel("journal_id") : null;
    if (journal) return ((await journal.get("bank_account_id")) as number | null) || null;
  }
  if (bankPartner === null) return null;
  const banks = (await env.cr.query<{ id: number; ok: boolean | null }>(
    `SELECT id, allow_out_payment AS ok FROM res_partner_bank WHERE partner_id = $1 AND active AND (company_id = $2 OR company_id IS NULL) ORDER BY sequence, id`, [bankPartner, company])).rows;
  const sorted = [...banks.filter((b) => b.ok), ...banks.filter((b) => !b.ok)];
  return sorted[0]?.id ?? null;
}

/**
 * account_move_reversal.py:97-104 `_prepare_default_reversal` 'ref': "Reversal of: %(move_name)s, %(reason)s" (or
 * "Reversal of: %s" without a reason) in the language of the move's partner, else the environment's.
 */
function reversalRef(lang: string | null, name: string, reason: string | null): string {
  if (reason) return translateLang(lang, "Reversal of: %(move_name)s, %(reason)s", "account").replace(/%\((\w+)\)s/g, (_m, k: string) => (k === "move_name" ? name : reason));
  return translateLang(lang, "Reversal of: %s", "account").replace("%s", () => name);
}

/**
 * The tags `_sync_dynamic_lines` gives the credit note's lines (account_tax.py:2389-2523
 * `_add_accounting_data_to_base_line_tax_details` with `is_refund`): a product line gets the base tags of its taxes'
 * refund repartition lines, a tax line its refund repartition line's tags. Product tags and cash-basis taxes refuse.
 */
async function reversedTags(env: Environment, src: Row, line: number, refundRep: number | null, tracked: boolean, toDoc: "invoice" | "refund" = "refund"): Promise<void> {
  const dt = src["display_type"];
  let tags: number[] = [];
  if (dt === "tax") {
    if (refundRep === null) throw new NotPorted("reversal: a tax line without its refund repartition line");
    const [t] = (await env.cr.query<{ exig: string }>("SELECT tax_exigibility AS exig FROM account_tax WHERE id = $1", [src["tax_line_id"]])).rows;
    if (t?.exig !== "on_invoice") throw new NotPorted("reversal with cash-basis tax tags");
    tags = (await env.cr.query<{ t: number }>("SELECT account_account_tag_id AS t FROM account_account_tag_account_tax_repartition_line_rel WHERE account_tax_repartition_line_id = $1 ORDER BY 1", [refundRep])).rows.map((r) => r.t);
  } else if (dt === "product") {
    if (src["product_id"] && (await env.cr.query("SELECT 1 FROM account_account_tag_product_template_rel r JOIN product_product p ON p.product_tmpl_id = r.product_template_id WHERE p.id = $1 LIMIT 1", [src["product_id"]])).rows.length) {
      throw new NotPorted("reversal of lines of a product with account tags");
    }
    const taxes = (await env.cr.query<{ exig: string; tags: number[] | null }>(
      `SELECT t.tax_exigibility AS exig, ARRAY(SELECT x.account_account_tag_id FROM account_tax_repartition_line r JOIN account_account_tag_account_tax_repartition_line_rel x
          ON x.account_tax_repartition_line_id = r.id WHERE r.tax_id = t.id AND r.document_type = $2 AND r.repartition_type = 'base') AS tags
         FROM account_move_line_account_tax_rel l JOIN account_tax t ON t.id = l.account_tax_id WHERE l.account_move_line_id = $1`, [src["id"], toDoc])).rows;
    if (taxes.some((t) => t.exig !== "on_invoice")) throw new NotPorted("reversal with cash-basis tax tags");
    tags = [...new Set(taxes.flatMap((t) => t.tags ?? []))].sort((a, b) => a - b);
    // the cancelling reversal tracks the copied lines from the copy's values (the invoice's tags)
    const before = (await env.cr.query<{ t: number }>("SELECT account_account_tag_id AS t FROM account_account_tag_account_move_line_rel WHERE account_move_line_id = $1 ORDER BY 1", [src["id"]])).rows.map((r) => r.t);
    if (tracked && before.join() !== tags.join()) throw new NotPorted("cancelling reversal whose refund tags differ from the invoice's (tracked tax_tag_ids)");
  } else if ((await env.cr.query("SELECT 1 FROM account_account_tag_account_move_line_rel WHERE account_move_line_id = $1 LIMIT 1", [src["id"]])).rows.length) {
    throw new NotPorted(`reversal of a ${String(dt)} line with tax tags`);
  }
  for (const t of tags) await env.cr.query("INSERT INTO account_account_tag_account_move_line_rel (account_move_line_id, account_account_tag_id) VALUES ($1, $2)", [line, t]);
}

/** The reversal wizard's record and values. */
interface Wiz { id: number; date: string; reason: string | null; journal: number }

/**
 * account_move_reversal.py:121-126 the default values of a move's reversal (`partner_bank_id` reset, then
 * `_prepare_default_reversal`, :97-114, through the private hook: l10n_hu_edi adds the delivery date of a Hungarian
 * company's move), as the wizard gives them to `_reverse_moves`; `hand` is the hand port's own part.
 */
async function reversalDefaults(env: Environment, moveId: number, wizard: Wiz): Promise<{ all: Row; hand: Row }> {
  const hand = await handReversalDefaults(env, moveId, wizard);
  const v = await priv.account_move_reversal._prepare_default_reversal.call(env, [wizard.id], [new PrivateRecords("account.move", [moveId])], async (_e, ids, args) => {
    const m = args[0];
    const id = m instanceof PrivateRecords ? m.ids : Array.isArray(m) ? m as number[] : null;
    if (ids.length !== 1 || ids[0] !== wizard.id || id?.length !== 1 || id[0] !== moveId) throw new NotPorted("_prepare_default_reversal of another wizard or move");
    const { partner_bank_id: _drop, ...rest } = hand;
    return { ...rest };
  });
  if (v === null || typeof v !== "object" || Array.isArray(v) || v instanceof Map) throw new NotPorted("_prepare_default_reversal giving other than a dict");
  return { all: { partner_bank_id: false, ...(v as Row) }, hand };
}

async function handReversalDefaults(env: Environment, moveId: number, wizard: Wiz): Promise<Row> {
  const m = (await env.cr.query<{ name: string; type: string; date: string; user: number | null; origin: string | null; rate: number | null; lang: string | null; term: number | null; mixed: boolean }>(
    `SELECT m.name, m.move_type AS type, m.date::text AS date, m.invoice_user_id AS user, m.invoice_origin AS origin, m.invoice_currency_rate::float8 AS rate,
            p.lang, m.invoice_payment_term_id AS term, COALESCE(t.early_pay_discount_computation = 'mixed', FALSE) AS mixed
       FROM account_move m LEFT JOIN res_partner p ON p.id = m.partner_id LEFT JOIN account_payment_term t ON t.id = m.invoice_payment_term_id WHERE m.id = $1`, [moveId])).rows[0]!;
  const today = await contextToday(env);
  return {
    partner_bank_id: false,
    ref: reversalRef(m.lang || env.lang, m.name, wizard.reason), date: wizard.date, invoice_date_due: wizard.date,
    invoice_date: isInvoice(m.type) ? (wizard.date || m.date) : false, journal_id: wizard.journal,
    invoice_payment_term_id: m.mixed ? m.term : null, invoice_user_id: m.user ?? false, auto_post: wizard.date > today ? "at_date" : "no",
    invoice_origin: m.origin ?? false, invoice_currency_rate: m.rate ?? 0,
  };
}

/**
 * account_move.py:5891-5930 `_reverse_moves(default_values_list, cancel)` of one move through its hook (l10n_es: the
 * reversal's invoice type): the hand's reversal (`run`) with the default values an override adds as the new move's
 * values; a value an override changes refuses. sale's definition, above the new modules in the MRO, adds the UTM
 * fields, which the hand's copy keeps from the source (private_hooks.json `above`).
 */
async function reverseMovesHook(env: Environment, moveId: number, wizard: Wiz, cancel: boolean,
  run: (extra: Row) => Promise<number>): Promise<number> {
  const { all: defaults, hand } = await reversalDefaults(env, moveId, wizard);
  let created: number | null = null;
  await priv.account_move._reverse_moves.call(env, [moveId], [[{ ...defaults }], cancel], async (_e, ids, args) => {
    if (ids.length !== 1 || ids[0] !== moveId) throw new NotPorted("account.move._reverse_moves of other moves than the reversed one");
    const list = args[0];
    const given = (Array.isArray(list) && list.length === 1 ? list[0] : defaults) as Row;
    if (args[1] !== undefined && Boolean(args[1]) !== cancel) throw new NotPorted("account.move._reverse_moves with another cancel");
    const extra: Row = {};
    // the values the overrides added (`_prepare_default_reversal`'s and `_reverse_moves`'), against the hand's own
    for (const [k, v] of Object.entries(given)) {
      if (!(k in hand)) extra[k] = v;
      else if (JSON.stringify(v ?? false) !== JSON.stringify(hand[k] ?? false)) throw new NotPorted(`account.move._reverse_moves with ${k} changed by an override`);
    }
    created = await run(extra);
    return [created];
  });
  if (created === null) throw new NotPorted("account.move._reverse_moves whose override did not call super()");
  return created;
}

/**
 * The reversal's columns of fields only the site has (a copy of the source row otherwise): an override's default
 * value, the source's for a copied field (`copy=True`), else none, so that insertRow gives its default
 * (orm/site_defaults.ts); the computed ones are returned, computed after the insert as `copy` computes them.
 * A default value of an override for a field that is not a plain column refuses.
 */
async function siteCopyColumns(env: Environment, vals: Row, extra: Row): Promise<string[]> {
  const def = env.reg.model("account.move");
  for (const [k, v] of Object.entries(extra)) {
    const f = def.fields.get(k);
    if (!f || !f.store || !f.column) throw new NotPorted(`a reversal's default value of account.move.${k}`);
    vals[k] = v === false && f.type !== "boolean" ? null : v;
  }
  const { siteOnlyFields } = await import("../orm/genmeta");
  const { isComputed } = await import("../orm/recompute");
  const recompute: string[] = [];
  for (const name of await siteOnlyFields(env, "account.move")) {
    const f = def.fields.get(name);
    if (!f || !f.store || !f.column || name in extra || f.copy) continue;
    delete vals[name];
    if (isComputed(f)) recompute.push(name);
  }
  return recompute;
}

async function recomputeSite(env: Environment, move: number, fields: readonly string[]): Promise<void> {
  if (!fields.length) return;
  const queue = new RecomputeQueue(env);
  for (const f of fields) queue.add("account.move", f, [move]);
  await queue.run();
}

/** account_move.py:5891-5930 `_reverse_moves` of an invoice without cancel: a draft copy with the opposite amounts. */
async function reverseInvoice(env: Environment, moveId: number, wizard: Wiz,
  cancel: { readonly later: (() => Promise<void>)[] } | null = null, extra: Row = {}): Promise<number> {
  const src = (await env.cr.query<{ r: Row }>("SELECT row_to_json(m) AS r FROM account_move m WHERE id = $1", [moveId])).rows[0]!.r;
  const type = String(src["move_type"]);
  // account_move.py:67-75 TYPE_REVERSE_MAP: an invoice becomes a credit note and a credit note an invoice; the
  // credit note's lines take the other document type's repartition lines and tags
  const newType = TYPE_REVERSE_MAP[type];
  if (!isInvoice(type) || !newType) throw new NotPorted(`reversal of a ${type}`);
  const fromDoc = type.endsWith("_refund") ? "refund" : "invoice", toDoc = newType.endsWith("_refund") ? "refund" : "invoice";
  if (src["invoice_cash_rounding_id"]) throw new NotPorted("reversal with cash rounding");
  if (src["auto_post"] !== "no") throw new NotPorted("reversal of an auto-posted move");
  const today = await contextToday(env);
  const autoPost = wizard.date > today ? "at_date" : "no";
  if (autoPost !== "no" && cancel) throw new NotPorted("cancelling reversal dated in the future");
  const term = src["invoice_payment_term_id"];
  const mixed = term ? (await env.cr.query<{ c: string | null }>("SELECT early_pay_discount_computation AS c FROM account_payment_term WHERE id = $1", [term])).rows[0]?.c === "mixed" : false;
  if (mixed) throw new NotPorted("reversal with a mixed early payment discount");
  const name = String(src["name"]);
  const partnerLang = src["partner_id"] ? (await env.cr.query<{ l: string | null }>("SELECT lang AS l FROM res_partner WHERE id = $1", [src["partner_id"]])).rows[0]?.l : null;
  // `copy` creates from the original record: its `_sync_dynamic_lines` container holds the reversed invoice
  await touchSyncedInvoices(env, [moveId]);
  const ref = reversalRef(partnerLang || env.lang, name, wizard.reason);
  const skip = new Set(["id", "create_uid", "write_uid", "create_date", "write_date"]);
  const vals: Row = {};
  for (const [k, v] of Object.entries(src)) if (!skip.has(k)) vals[k] = v;
  // jsonb columns come back parsed from row_to_json
  for (const k of Object.keys(vals)) if (vals[k] !== null && typeof vals[k] === "object") vals[k] = JSON.stringify(vals[k]);
  const srcLines = (await env.cr.query<{ r: Row }>("SELECT row_to_json(l) AS r FROM account_move_line l WHERE move_id = $1 ORDER BY id", [moveId])).rows.map((x) => x.r);
  const terms = srcLines.filter((l) => l["display_type"] === "payment_term");
  if (!terms.length) throw new NotPorted("reversal of an invoice without a payment term line");
  // several installments (a payment term with several lines): the copy has one line per installment, then
  // `_sync_dynamic_lines` (account_move.py `_sync_dynamic_line`: `while to_delete and to_create`, `to_delete.pop()`)
  // rewrites the last of them as the single line of the credit note (no payment term, due on its date) and deletes
  // the others, whose ids stay used (measured, proofs/scenarios/sol12_credit_terms.py). With the cancelling
  // reversal the copied lines are also tracked: refused there.
  if (terms.length > 1 && cancel) throw new NotPorted("cancelling reversal of an invoice with several installments");
  const lastTerm = terms[terms.length - 1]!;
  const termBalance = terms.reduce((a, l) => a + Number(l["balance"]), 0);
  const termCurrency = terms.reduce((a, l) => a + Number(l["amount_currency"]), 0);
  const sign = directionSign(newType);
  // account_move.py:1211-1262 `_compute_amount` of the draft copy: the unsigned amounts and the in-currency signed ones
  // from `amount_currency` (the document's currency), the signed ones from `balance` (the company's); before round 13
  // every amount came from `balance`, so a credit note in EUR of a company in USD had its totals in USD (opus13_fx)
  let totalUntaxed = 0, totalTax = 0, untaxedCur = 0, taxCur = 0;
  for (const l of srcLines) {
    const b = -Number(l["balance"]), c = -Number(l["amount_currency"]);
    if (l["display_type"] === "tax") { totalTax += b; taxCur += c; }
    else if (l["display_type"] === "product") { totalUntaxed += b; untaxedCur += c; }
    else if (l["display_type"] !== "payment_term" && !["line_section", "line_subsection", "line_note"].includes(String(l["display_type"]))) throw new NotPorted(`reversal with ${String(l["display_type"])} lines`);
  }
  const total = totalUntaxed + totalTax, totalCur = untaxedCur + taxCur;
  Object.assign(vals, {
    move_type: newType, reversed_entry_id: moveId, name: null, state: "draft", posted_before: null, ref, date: wizard.date, invoice_date: wizard.date, invoice_date_due: wizard.date,
    journal_id: wizard.journal, invoice_payment_term_id: null, partner_bank_id: await movePartnerBank(env, newType, Number(src["company_id"]), (src["commercial_partner_id"] as number | null) ?? null),
    auto_post: autoPost,
    payment_state: "not_paid", payment_reference: null, sequence_prefix: "", sequence_number: 0, made_sequence_gap: false, access_token: null,
    message_main_attachment_id: null, delivery_date: null, has_grouped_lines: false, quick_edit_total_amount: 0, is_manually_modified: true, is_move_sent: null,
    inalterable_hash: null, secure_sequence_number: null, sending_data: null, peppol_message_uuid: null, peppol_move_state: null,
    amount_untaxed: sign * untaxedCur, amount_tax: sign * taxCur, amount_total: sign * totalCur, amount_residual: sign * totalCur,
    amount_untaxed_signed: -totalUntaxed, amount_untaxed_in_currency_signed: -untaxedCur, amount_tax_signed: -totalTax,
    amount_total_signed: -total, amount_total_in_currency_signed: -totalCur, amount_residual_signed: -total,
  });
  const recompute = await siteCopyColumns(env, vals, extra);
  const newMove = await insertRow(env, "account_move", vals);
  await recomputeSite(env, newMove, recompute);
  // the copy creates the lines in the source's order; its tax lines are created again by the sync after the others
  const ordered = [...srcLines.filter((l) => l["display_type"] !== "tax"), ...srcLines.filter((l) => l["display_type"] === "tax")];
  const copyLine = async (l: Row): Promise<number> => {
    const v: Row = {};
    for (const [k, x] of Object.entries(l)) if (!skip.has(k)) v[k] = x !== null && typeof x === "object" ? JSON.stringify(x) : x;
    // the copy creates its lines with the values: analytic_mixin.py:175-180 `_sanitize_values` makes each share of the
    // distribution a rounded Python float (an invoice line computing its sale line's {"27": 100} gives 100.0 here)
    if (l["analytic_distribution"] && typeof l["analytic_distribution"] === "object") {
      const { sanitizedAnalyticJson } = await import("../orm/create");
      v["analytic_distribution"] = await sanitizedAnalyticJson(env, l["analytic_distribution"]);
    }
    // the Json values Python floats wrote keep their decimal point (`extra_tax_data`: a down payment's manual amounts)
    if (l["extra_tax_data"] && typeof l["extra_tax_data"] === "object" && !skip.has("extra_tax_data")) {
      const { pyExtraTaxData } = await import("./sale_down_payment");
      const { dumps } = await import("../http/json");
      v["extra_tax_data"] = dumps(pyExtraTaxData(l["extra_tax_data"] as Record<string, unknown>));
    }
    const dt = l["display_type"];
    const b = dt === "payment_term" ? -termBalance : -Number(l["balance"]), c = dt === "payment_term" ? -termCurrency : -Number(l["amount_currency"]);
    Object.assign(v, {
      move_id: newMove, move_name: null, journal_id: wizard.journal, ref, date: wizard.date, invoice_date: wizard.date, parent_state: "draft", balance: b, amount_currency: c,
      debit: b > 0 ? b : 0, credit: b < 0 ? -b : 0, amount_residual: b, amount_residual_currency: c, reconciled: false, full_reconcile_id: null, matching_number: null,
      // copy_data: a down payment line stays one (sale account_move_line.py:11, copied)
      collapse_composition: false, collapse_prices: false, is_downpayment: Boolean(l["is_downpayment"]), is_imported: false, tax_base_amount: l["tax_base_amount"] === null ? 0 : -Number(l["tax_base_amount"]),
    });
    if (dt === "product") Object.assign(v, { discount_amount_currency: 0, discount_balance: 0 });
    // a section or note line: no amounts, so a zero residual (`reconciled`, account_move_line.py:1213-1216), and the
    // discount amounts the copy recomputes as 0.0 (measured, proofs/scenarios/modify.py)
    if (["line_section", "line_subsection", "line_note"].includes(String(dt))) Object.assign(v, { reconciled: true, discount_amount_currency: 0, discount_balance: 0 });
    if (dt === "payment_term") {
      v["date_maturity"] = wizard.date;
      v["name"] = PURCHASE.includes(newType) ? ref : null;
    }
    if (dt === "tax") {
      // the refund repartition line at the same position (account_tax.py `_get_tax_details` on `is_refund`): the
      // invoice and refund repartition lines match one by one in their order (account_tax.py:5186 `_order`, the
      // constraint `_validate_repartition_lines`), so the tax line `_sync_tax_lines` creates again for the credit
      // note has the refund line at the invoice line's position, its account (or the base line's, as the invoice's
      // had) and its tags
      const r = (await env.cr.query<{ id: number; account: number | null; old_account: number | null }>(
        `WITH o AS (SELECT tax_id, repartition_type, account_id, (SELECT count(*) FROM account_tax_repartition_line x WHERE x.tax_id = l.tax_id AND x.document_type = l.document_type
                     AND x.repartition_type = l.repartition_type AND (x.sequence, x.id) < (l.sequence, l.id)) AS pos FROM account_tax_repartition_line l WHERE l.id = $1 AND l.document_type = $2)
         SELECT n.id, n.account_id AS account, o.account_id AS old_account FROM o JOIN LATERAL (SELECT id, account_id FROM account_tax_repartition_line n WHERE n.tax_id = o.tax_id
           AND n.document_type = $3 AND n.repartition_type = o.repartition_type ORDER BY n.sequence, n.id OFFSET o.pos LIMIT 1) n ON true`, [l["tax_repartition_line_id"], fromDoc, toDoc])).rows;
      if (r.length !== 1) throw new NotPorted("reversal: refund repartition line of a tax");
      v["tax_repartition_line_id"] = r[0]!.id;
      // a repartition line with an account on one side only groups the tax lines by other accounts
      if ((r[0]!.account === null) !== (r[0]!.old_account === null)) throw new NotPorted("reversal: invoice and refund repartition lines with and without an account");
      if (r[0]!.account !== null) v["account_id"] = r[0]!.account;
      refundReps.set(Number(l["id"]), r[0]!.id);
      // the tax lines are created again by `_sync_dynamic_lines` (account_move.py), not copied: the Booleans the copy
      // carries stay NULL (measured, gcrawl G162)
      Object.assign(v, { collapse_composition: null, collapse_prices: null, is_downpayment: null, is_imported: null });
    }
    return insertRow(env, "account_move_line", v);
  };
  const idMap = new Map<number, number>();
  const refundReps = new Map<number, number>();
  // the synchronized tax lines are created again by `_sync_dynamic_lines`: their first copies leave a gap in the ids,
  // at their place in the source's order (measured with the tax before the payment term and products after it)
  for (const l of srcLines) {
    if (l["display_type"] === "tax" || (l["display_type"] === "payment_term" && l !== lastTerm)) await env.cr.query("SELECT nextval('account_move_line_id_seq')");
    else idMap.set(Number(l["id"]), await copyLine(l));
  }
  for (const l of ordered) if (l["display_type"] === "tax") idMap.set(Number(l["id"]), await copyLine(l));
  // a site's override of `_copy_data_extend_business_fields` (l10n_cn's balance deductions) would add values to these
  // copies: the lines are copied in SQL here, so it refuses (private_hooks.json)
  if (await priv.account_move_line._copy_data_extend_business_fields.overridden(env)) throw new NotPorted("a reversal's line copies with a site's _copy_data_extend_business_fields");
  const saleOrders = new Set<number>();
  for (const [o, n] of idMap) {
    // `_reverse_moves` copies with include_business_fields: sale `_copy_data_extend_business_fields`
    // (sale/models/account_move_line.py:41-43) keeps the order lines of each line (purchase_line_id is a column, copied above)
    const links = (await env.cr.query<{ l: number; o: number }>(
      `INSERT INTO sale_order_line_invoice_rel (invoice_line_id, order_line_id) SELECT $2, r.order_line_id FROM sale_order_line_invoice_rel r WHERE r.invoice_line_id = $1
       RETURNING order_line_id AS l, (SELECT order_id FROM sale_order_line WHERE id = order_line_id) AS o`, [o, n])).rows;
    for (const x of links) saleOrders.add(x.o);
    await env.cr.query("INSERT INTO account_move_line_account_tax_rel (account_move_line_id, account_tax_id) SELECT $2, account_tax_id FROM account_move_line_account_tax_rel WHERE account_move_line_id = $1", [o, n]);
    await reversedTags(env, srcLines.find((l) => Number(l["id"]) === o)!, n, refundReps.get(o) ?? null, cancel !== null, toDoc);
  }
  // the order lines' stored quantities that follow their invoice lines (sale_invoice.ts)
  if (saleOrders.size) {
    await (await import("./sale_invoice")).refreshInvoiced(env, [...saleOrders].sort((a, b) => a - b));
    // sale_stock account_move.py:98-108 `_compute_delivery_date` of the draft credit note: the orders' latest effective date
    const [e] = (await env.cr.query<{ d: string | null }>("SELECT max(effective_date)::text AS d FROM sale_order WHERE id = ANY($1::int[])", [[...saleOrders]])).rows;
    if (e?.d) await updateRow(env, "account_move", newMove, { delivery_date: await contextDay(env, e.d) });
  }
  await mailAfterCreate(env, "account.move", [newMove], [{ move_type: newType, partner_id: src["partner_id"], journal_id: wizard.journal }]);
  // `move._get_html_link()`: the title is the reversed move's display_name (with its reference, `_get_move_display_name(show_ref=True)`)
  const shown = String((await env.model("account.move").read([moveId], ["display_name"], ""))[0]?.["display_name"] ?? name);
  // account_move.py:3896-3904 `_get_copy_message_content`, `_()` in the environment's language
  const from = translate(env, "This entry has been reversed from %s", "account").replace("%s", () => `<a href="#" data-oe-model="account.move" data-oe-id="${moveId}">${escapeText(shown)}</a>`);
  await messageLogBatch(env, "account.move", new Map([[newMove, `<p>${from}</p>`]]));
  if (cancel) {
    // :5926-5928 `_post(soft=False)` with move_reverse_cancel: posted and reconciled with the invoice, then the
    // wizard's "reversed by <name>" (account_move_reversal.py:144-155). The credit note was created in the
    // transaction: its own tracking is discarded (`_track_discard`), but its copied journal items are tracked from
    // the values the copy gave them (a product line without balance, the source's payment term line) once it is
    // posted: logged at precommit, products then payment terms, after the reversed invoice's payment state (measured
    // on Odoo, proofs/scenarios/modify.py). The tax lines, created again, are not.
    noteCreated(env.cr, "account.move", [newMove]);
    const { trackedFields, trackRecordPrepare, trackRecordAdd, trackRecordFinalize, readTracked } = await import("../mail/tracking");
    const { lineLogBody } = await import("./account_integrity");
    const fields = (await trackedFields(env, "account.move.line")).filter((f) => !f.related);
    const copied = [...idMap].filter(([o]) => srcLines.find((l) => Number(l["id"]) === o)?.["display_type"] !== "tax");
    const order = [...copied.filter(([o]) => srcLines.find((l) => Number(l["id"]) === o)?.["display_type"] !== "payment_term"),
      ...copied.filter(([o]) => srcLines.find((l) => Number(l["id"]) === o)?.["display_type"] === "payment_term")];
    const init = new Map<number, Record<string, unknown>>();
    const current = await readTracked(env, "account.move.line", order.map(([, n]) => n), fields);
    for (const [o, n] of order) {
      const src = srcLines.find((l) => Number(l["id"]) === o)!;
      const snap = { ...(current.get(n) ?? {}) };
      if (src["display_type"] === "payment_term") {
        if ("balance" in snap) snap["balance"] = Number(src["balance"]);
        if ("date_maturity" in snap) snap["date_maturity"] = src["date_maturity"] ?? false;
      } else if (src["display_type"] === "product") {
        if ("balance" in snap) snap["balance"] = 0;
      }
      init.set(n, snap);
    }
    const targets = new Map(order.map(([, n]) => [n, { model: "account.move", id: newMove, body: lineLogBody(env, n, "updated") }]));
    await trackRecordPrepare(env, "account.move.line", [], targets);
    trackRecordAdd(env.cr, "account.move.line", fields, init, targets);
    const last: (() => Promise<void>)[] = [];
    // `_post(soft=False)`: a module's compiled override of it runs first (src/orm/private_hooks.ts)
    await priv.account_move._post.call(env.withContext({ ...env.context, move_reverse_cancel: true }), [newMove], [false],
      (e, ids) => postDrafts(e, ids, { later: cancel.later, last }));
    cancel.later.push(() => trackRecordFinalize(env, "account.move.line"));
    cancel.later.push(async () => { for (const fn of last) await fn(); });
    const posted = (await moveRow(env, newMove)).name;
    const by = translate(env, "This entry has been reversed by %s", "account").replace("%s", () => `<a href="#" data-oe-model="account.move" data-oe-id="${newMove}">${escapeText(String(posted))}</a>`);
    await messageLogBatch(env, "account.move", new Map([[moveId, `<p>${by}</p>`]]));
    return newMove;
  }
  // account_move_reversal.py:144-152 `move.env._('This entry has been %s', link(title=_("reversed")))`
  const link = `<a href="#" data-oe-model="account.move" data-oe-id="${newMove}">${escapeText(translate(env, "reversed", "account"))}</a>`;
  await messageLogBatch(env, "account.move", new Map([[moveId, `<p>${translate(env, "This entry has been %s", "account").replace("%s", () => link)}</p>`]]));
  return newMove;
}

/**
 * account_move.py:5891-5930 `_reverse_moves` of a journal entry: when `cancel` is true (date <= today),
 * posts at once and reconciles with the entry; when `cancel` is false (future date -> `auto_post='at_date'`),
 * creates a draft reversal entry without posting immediately.
 */
async function reverseEntry(env: Environment, moveId: number, wizard: Wiz, cancel: boolean, extra: Row = {}): Promise<number> {
  const src = (await env.cr.query<{ r: Row }>("SELECT row_to_json(m) AS r FROM account_move m WHERE id = $1", [moveId])).rows[0]!.r;
  if (src["move_type"] !== "entry") throw new NotPorted(`reversal of a ${String(src["move_type"])} as an entry`);
  if (src["auto_post"] !== "no" || src["auto_post_origin_id"]) throw new NotPorted("reversal of an auto-posted entry");
  const today = await contextToday(env);
  const autoPost = wizard.date > today ? "at_date" : "no";
  const company = Number(src["company_id"]);
  const co = (await env.cr.query<{ storno: boolean | null; locks: boolean }>(
    `SELECT account_storno AS storno, GREATEST(fiscalyear_lock_date, sale_lock_date, purchase_lock_date, tax_lock_date, hard_lock_date) >= $2::date AS locks
       FROM res_company WHERE id = $1`, [company, wizard.date])).rows[0]!;
  if (co.storno) throw new NotPorted("reversal with storno accounting (is_storno)");
  if (co.locks) throw new NotPorted("reversal dated inside a lock date (copy_data moves the date)");
  if (!(await env.cr.query<{ a: boolean }>("SELECT active AS a FROM account_journal WHERE id = $1", [wizard.journal])).rows[0]?.a) throw new NotPorted("reversal into an archived journal");
  const name = String(src["name"]);
  const srcLines = (await env.cr.query<{ r: Row }>("SELECT row_to_json(l) AS r FROM account_move_line l WHERE move_id = $1 ORDER BY id", [moveId])).rows.map((x) => x.r);
  for (const l of srcLines) {
    if (l["tax_line_id"] || l["tax_repartition_line_id"] || l["analytic_distribution"] || l["display_type"] !== "product") throw new NotPorted("reversal of an entry with tax, analytic or non-product lines");
    if (l["currency_id"] !== l["company_currency_id"]) throw new NotPorted("reversal of an entry in a foreign currency");
    if (l["reconciled"] || l["matching_number"]) throw new NotPorted("reversal of an entry with reconciled lines");
  }
  const taxed = (await env.cr.query(
    `SELECT 1 FROM account_move_line_account_tax_rel r JOIN account_move_line l ON l.id = r.account_move_line_id WHERE l.move_id = $1
     UNION ALL SELECT 1 FROM account_account_tag_account_move_line_rel t JOIN account_move_line l ON l.id = t.account_move_line_id WHERE l.move_id = $1 LIMIT 1`, [moveId])).rows.length;
  if (taxed) throw new NotPorted("reversal of an entry with taxes or tax tags");
  const ref = reversalRef(env.lang, name, wizard.reason);
  const skip = new Set(["id", "create_uid", "write_uid", "create_date", "write_date"]);
  const vals: Row = {};
  for (const [k, v] of Object.entries(src)) if (!skip.has(k)) vals[k] = v !== null && typeof v === "object" ? JSON.stringify(v) : v;
  Object.assign(vals, {
    reversed_entry_id: moveId, name: null, state: "draft", posted_before: null, ref, date: wizard.date, invoice_date: null, invoice_date_due: wizard.date,
    journal_id: wizard.journal, invoice_payment_term_id: null, partner_id: null, partner_bank_id: null, auto_post: autoPost,
    payment_state: "not_paid", sequence_prefix: "", sequence_number: 0, made_sequence_gap: false, access_token: null, message_main_attachment_id: null,
    has_grouped_lines: false, quick_edit_total_amount: 0, is_move_sent: null, inalterable_hash: null, secure_sequence_number: null, sending_data: null,
    peppol_message_uuid: null, peppol_move_state: null,
    // :5916-5923 the write of the lines' balances marks the move as modified by hand (`_compute_is_manually_modified`)
    is_manually_modified: true,
  });
  const recompute = await siteCopyColumns(env, vals, extra);
  const newMove = await insertRow(env, "account_move", vals);
  await recomputeSite(env, newMove, recompute);
  noteCreated(env.cr, "account.move", [newMove]);
  for (const l of srcLines) {
    const v: Row = {};
    for (const [k, x] of Object.entries(l)) if (!skip.has(k)) v[k] = x !== null && typeof x === "object" ? JSON.stringify(x) : x;
    const b = -Number(l["balance"]), c = -Number(l["amount_currency"]);
    Object.assign(v, {
      move_id: newMove, move_name: null, journal_id: wizard.journal, ref, date: wizard.date, parent_state: "draft", balance: b, amount_currency: c,
      debit: b > 0 ? b : 0, credit: b < 0 ? -b : 0, amount_residual: b, amount_residual_currency: c, reconciled: false, full_reconcile_id: null, matching_number: null,
      price_subtotal: -Number(l["price_subtotal"] ?? 0), price_total: -Number(l["price_total"] ?? 0),
      collapse_composition: false, collapse_prices: false, is_downpayment: false, is_imported: false, tax_base_amount: 0,
      discount_amount_currency: 0, discount_balance: 0,
    });
    await insertRow(env, "account_move_line", v);
  }
  await mailAfterCreate(env, "account.move", [newMove], [{ move_type: "entry", partner_id: false, journal_id: wizard.journal }]);
  const shown = String((await env.model("account.move").read([moveId], ["display_name"], ""))[0]?.["display_name"] ?? name);
  // account_move.py:3896-3904 `_get_copy_message_content`, `_()` in the environment's language
  const from = translate(env, "This entry has been reversed from %s", "account").replace("%s", () => `<a href="#" data-oe-model="account.move" data-oe-id="${moveId}">${escapeText(shown)}</a>`);
  await messageLogBatch(env, "account.move", new Map([[newMove, `<p>${from}</p>`]]));
  if (cancel) {
    await priv.account_move._post.call(env.withContext({ ...env.context, move_reverse_cancel: true }), [newMove], [false],
      (e, ids) => postDrafts(e, ids));
    const posted = (await moveRow(env, newMove)).name;
    const by = translate(env, "This entry has been reversed by %s", "account").replace("%s", () => `<a href="#" data-oe-model="account.move" data-oe-id="${newMove}">${escapeText(String(posted))}</a>`);
    await messageLogBatch(env, "account.move", new Map([[moveId, `<p>${by}</p>`]]));
  } else {
    const link = `<a href="#" data-oe-model="account.move" data-oe-id="${newMove}">${escapeText(translate(env, "reversed", "account"))}</a>`;
    await messageLogBatch(env, "account.move", new Map([[moveId, `<p>${translate(env, "This entry has been %s", "account").replace("%s", () => link)}</p>`]]));
  }
  return newMove;
}

/**
 * account_move_reversal.py:194-195 `modify_moves` -> `reverse_moves(is_modify=True)` (:116-189) for one customer or
 * vendor document dated today or earlier: the credit note is posted and reconciled with it (`_reverse_moves(cancel=True)`),
 * then a draft copy of its product, section and note lines (`copy_data` with include_business_fields and
 * `_modify_default_reverse_values` :197-211) is created and opened. A vendor bill with a main attachment refuses.
 */
registerMethod("account.move.reversal", "modify_moves", async (env0, ids, _a, kwargs0) => modifyMoves(env0, ids, kwargs0), { apiModel: false });

async function modifyMoves(env0: Environment, ids: number[] | null, kwargs0: Record<string, unknown>): Promise<unknown> {
  const { env } = envFor(env0, kwargs0);
  if (ids?.length !== 1) throw new NotPorted("modify_moves on several wizards");
  const rec = new DbRec(env, env.reg.model("account.move.reversal"), ids[0]!);
  const moves = await reversalMoves(rec);
  if (moves.length !== 1) throw new NotPorted("modify_moves on several moves");
  const date = String(await rec.get("date"));
  const reason = (await rec.get("reason")) as string | false | null;
  const src = await moveRow(env, moves[0]!);
  if (!isInvoice(src.move_type)) throw new NotPorted(`modify_moves of a ${src.move_type}`);
  // :133-137 a future date posts the reversal later (auto_post at_date): no cancel then
  if (date > await contextToday(env)) throw new NotPorted("modify_moves dated in the future (auto_post at_date)");
  const extra = (await env.cr.query<{ origin: string | null; main: number | null }>(
    "SELECT invoice_origin AS origin, message_main_attachment_id AS main FROM account_move WHERE id = $1", [moves[0]])).rows[0]!;
  if (src.move_type.startsWith("in_") && extra.main) throw new NotPorted("modify_moves of a bill with its vendor attachment (copied)");
  const wiz: Wiz = { id: ids[0]!, date, reason: reason || null, journal: Number(await rec.get("journal_id")) };
  const later: (() => Promise<void>)[] = [];
  await reverseMovesHook(env, moves[0]!, wiz, true, (extra) => reverseInvoice(env, moves[0]!, wiz, { later }, extra));
  // :156-163 copy_data of the move with the reverse values, only its product, section and note lines, then create
  const { copyData } = await import("../web/save");
  const { create } = await import("../orm/create");
  const benv = env.withContext({ ...env.context, include_business_fields: true });
  const [data] = await copyData(benv.withContext({ ...benv.context, active_test: false }), "account.move", [moves[0]!], { date, invoice_origin: extra.origin ?? false });
  const lines = ((data!["line_ids"] as unknown[][] | undefined) ?? []).filter((c) => ["product", "line_section", "line_subsection", "line_note"].includes(String((c[2] as Row | undefined)?.["display_type"])));
  const [newInvoice] = await create(benv, "account.move", [{ ...data!, line_ids: lines }]);
  // :163 `new_moves._compute_partner_bank_id()` called directly assigns the field, i.e. writes it: the write marks the
  // invoice as modified by hand and enters `_sync_dynamic_lines` (the dirty flags); the value is the one create computed
  await touchSyncedInvoices(env, [newInvoice!]);
  // precommit: the tracking of the reversed invoice and of the credit note's journal items
  for (const fn of later) await fn();
  await env.cr.query("INSERT INTO account_move_reversal_new_move (reversal_id, new_move_id) VALUES ($1, $2)", [ids[0], newInvoice]);
  const type = (await moveRow(env, newInvoice!)).move_type;
  return { name: translate(env, "Reverse Moves"), type: "ir.actions.act_window", res_model: "account.move", view_mode: "form", res_id: newInvoice, context: { default_move_type: type } };
}

registerMethod("account.move.reversal", "refund_moves", async (env0, ids, _a, kwargs0) => refundMoves(env0, ids, kwargs0), { apiModel: false });

/**
 * account_move_reversal.py:116-189 `reverse_moves(is_modify=False)`, the button of the entries' wizard: `refund_moves`
 * and `modify_moves` are its two wrappers (:191-195). Before round 11 the method itself was not registered.
 */
registerMethod("account.move.reversal", "reverse_moves", async (env0, ids, args, kwargs0) => {
  if (args.length > 1) throw new NotPorted("reverse_moves with more than one positional argument");
  const { is_modify: kwModify, ...rest } = kwargs0;
  const isModify = args.length ? args[0] : kwModify;
  return isModify ? modifyMoves(env0, ids, rest) : refundMoves(env0, ids, rest);
}, { apiModel: false });

async function refundMoves(env0: Environment, ids: number[] | null, kwargs0: Record<string, unknown>): Promise<unknown> {
  const { env } = envFor(env0, kwargs0);
  if (ids?.length !== 1) throw new NotPorted("refund_moves on several wizards");
  const rec = new DbRec(env, env.reg.model("account.move.reversal"), ids[0]!);
  const moves = await reversalMoves(rec);
  if (moves.length !== 1) throw new NotPorted("refund_moves on several moves");
  const date = String(await rec.get("date"));
  const reason = (await rec.get("reason")) as string | false | null;
  const srcType = (await moveRow(env, moves[0]!)).move_type;
  const wiz: Wiz = { id: ids[0]!, date, reason: reason || null, journal: Number(await rec.get("journal_id")) };
  const isCancel = srcType === "entry" && date <= await contextToday(env);
  const newMove = await reverseMovesHook(env, moves[0]!, wiz, isCancel,
    (extra) => srcType === "entry" ? reverseEntry(env, moves[0]!, wiz, isCancel, extra) : reverseInvoice(env, moves[0]!, wiz, null, extra));
  await env.cr.query("INSERT INTO account_move_reversal_new_move (reversal_id, new_move_id) VALUES ($1, $2)", [ids[0], newMove]);
  const type = (await moveRow(env, newMove)).move_type;
  return { name: translate(env, "Reverse Moves"), type: "ir.actions.act_window", res_model: "account.move", view_mode: "form", res_id: newMove, context: { default_move_type: type } };
}


// ------------------------------------------------------------------------------------------------ stat buttons

/** ir_ui_view.py:3307-3328 `_get_records_action`. */
function recordsAction(env: Environment, model: string, ids: readonly number[], kwargs: Row): Row {
  const dep: Row = ids.length === 1 ? { views: [[false, "form"]], res_id: ids[0] }
    : ids.length === 0 ? { views: [[false, "form"]] } : { views: [[false, "list"], [false, "form"]], domain: [["id", "in", [...ids]]] };
  return { type: "ir.actions.act_window", res_model: model, target: "current", context: { ...env.context }, ...dep, ...kwargs };
}
const single = (ids: number[] | null): number => {
  if (ids?.length !== 1) throw new NotPorted("ensure_one on account.move");
  return ids[0]!;
};
registerMethod("account.move", "open_payments", async (env0, ids, _a, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = single(ids);
  const payments = (await new DbRec(env, env.reg.model("account.move"), id).get("reconciled_payment_ids")) as number[];
  return recordsAction(env, "account.payment", payments, { name: translate(env, "Payments") });
}, { apiModel: false });
registerMethod("account.move", "open_journal_items", async (env0, ids, _a, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = single(ids);
  return {
    name: translate(env, "Journal Items"), type: "ir.actions.act_window", res_model: "account.move.line", target: "current", views: [[false, "list"]],
    domain: [["move_id", "=", id], ["display_type", "not in", ["line_section", "line_subsection", "line_note"]]],
  };
}, { apiModel: false });
registerMethod("account.move", "action_open_reversal_moves", async (env0, ids, _a, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = single(ids);
  const type = (await moveRow(env, id)).move_type;
  const rows = await env.model("account.move").search(cond("reversed_entry_id", "=", id));
  return recordsAction(env, "account.move", rows, { name: translate(env, SALE_R.includes(type) ? "Credit Notes" : "Refunds") });
}, { apiModel: false });
registerMethod("account.move", "action_open_business_doc", async (env0, ids, _a, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = single(ids);
  const r = (await env.cr.query<{ p: number | null; s: number | null }>("SELECT origin_payment_id AS p, statement_line_id AS s FROM account_move WHERE id = $1", [id])).rows[0]!;
  const [name, model, resId] = r.p ? ["Payment", "account.payment", r.p] : r.s ? ["Bank Transaction", "account.bank.statement.line", r.s] : ["Journal Entry", "account.move", id];
  return { name: translate(env, String(name)), type: "ir.actions.act_window", view_mode: "form", views: [[false, "form"]], res_model: model, res_id: resId, target: "current" };
}, { apiModel: false });
// account_move.py:8235-8238: the Print menu has no extra items without an override
registerMethod("account.move", "get_extra_print_items", async () => [], { apiModel: false });

// ------------------------------------------------------------------------------------------------ list and print helpers

/** base ir_actions_report.py:904-916 get_valid_action_reports: actions with a domain need a matching record. */
registerMethod("ir.actions.report", "get_valid_action_reports", async (env0, ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const model = String(kwargs["model"] ?? args[0]);
  const records = (kwargs["record_ids"] ?? args[1]) as number[];
  const rows = (await env.cr.query<{ id: number; domain: string | null }>("SELECT id, domain FROM ir_act_report_xml WHERE id = ANY($1::int[]) ORDER BY id", [ids ?? []])).rows;
  const byId = new Map(rows.map((r) => [r.id, r.domain]));
  const free = (ids ?? []).filter((id) => !byId.get(id));
  for (const id of ids ?? []) {
    const domain = byId.get(id);
    if (!domain) continue;
    const parsed = evalExpr(domain, new Map());
    if (!Array.isArray(parsed)) throw new NotPorted("report domain that is not a list");
    if ((await env.model(model).search(and([cond("id", "in", records), parseDomain(parsed)]))).length) free.push(id);
  }
  return free;
}, { apiModel: false });

/** account_move.py:4125-4126 check_move_sequence_chain with sequence_mixin.py:489-513 `_is_end_of_seq_chain`. */
registerMethod("account.move", "check_move_sequence_chain", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const named = (await env.cr.query<{ id: number; name: string; journal_id: number; sequence_prefix: string | null; sequence_number: number }>(
    `SELECT id, name, journal_id, sequence_prefix, COALESCE(sequence_number, 0) AS sequence_number
       FROM account_move
      WHERE id = ANY($1::int[]) AND name IS NOT NULL AND name != '' AND name != '/'`, [ids ?? []])).rows;
  if (!named.length) return true;
  const batches = new Map<string, { journal_id: number; prefix: string; seqs: number[]; lastRec: typeof named[0] }>();
  for (const r of named) {
    const prefix = r.sequence_prefix ?? splitSequence(r.name).prefix;
    const seq = r.sequence_number || splitSequence(r.name).number;
    const key = `${r.journal_id}/${prefix}`;
    const b = batches.get(key);
    if (!b) {
      batches.set(key, { journal_id: r.journal_id, prefix, seqs: [seq], lastRec: r });
    } else {
      b.seqs.push(seq);
      if (b.lastRec.sequence_number <= seq) b.lastRec = r;
    }
  }
  for (const b of batches.values()) {
    const min = Math.min(...b.seqs);
    const max = Math.max(...b.seqs);
    if (max - min !== b.seqs.length - 1) return false;
    // _is_last_from_seq_chain: no other move in same journal+prefix has sequence_number > lastRec.sequence_number
    const higher = (await env.cr.query(
      `SELECT 1 FROM account_move
        WHERE journal_id = $1 AND sequence_prefix = $2 AND sequence_number > $3
          AND name IS NOT NULL AND name != '' AND name != '/'
        LIMIT 1`, [b.journal_id, b.prefix, max])).rows.length;
    if (higher) return false;
  }
  return true;
}, { apiModel: false });

/** web models.py:1860-1990 search_panel_select_range with account_move_line.py:2440-2462 and account_root.py: the accounts' first two digits and their parents. */
registerMethod("account.move.line", "search_panel_select_range", async (env0, _ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const fieldName = kwargs["field_name"] ?? args[0];
  if (fieldName !== "account_root_id" || kwargs["enable_counters"] || kwargs["expand"] || kwargs["hierarchize"] === false || kwargs["comodel_domain"]) {
    throw new NotPorted(`account.move.line search panel on ${String(fieldName)}`);
  }
  const domains = [kwargs["search_domain"], kwargs["category_domain"], kwargs["filter_domain"]].filter((d) => d !== undefined && d !== null).map((d) => parseDomain(d));
  const lines = await env.model("account.move.line").search(domains.length ? and(domains) : parseDomain([]));
  const companies = await env.companies();
  const root = (await env.cr.query<{ r: number }>("SELECT split_part(parent_path, '/', 1)::int AS r FROM res_company WHERE id = $1", [await env.company()])).rows[0]!.r;
  const codes = (await env.cr.query<{ c: string }>(
    `SELECT DISTINCT a.code_store->>$3::text AS c FROM account_account a
       JOIN account_account_res_company_rel rel ON rel.account_account_id = a.id AND rel.res_company_id = ANY($2::int[])
      WHERE a.code_store->>$3::text IS NOT NULL AND EXISTS (SELECT 1 FROM account_move_line l WHERE l.account_id = a.id AND l.id = ANY($1::int[]))`,
    [lines, companies, root])).rows;
  const ids = new Set<string>();
  for (const { c } of codes) { const two = c.slice(0, 2); for (let i = 1; i <= two.length; i++) ids.add(two.slice(0, i)); }
  const values = [...ids].sort().map((id) => ({ id, display_name: id, parent_id: id.length > 1 ? id.slice(0, -1) : false }));
  return { parent_field: "parent_id", values };
}, { apiModel: true });

// account product.py:195-205 product.template `_compute_valuation` (product.product.valuation is related to it)
defineComputes("product.template", {
  valuation: async (env, rec) => {
    if (rec.origin === null) throw new NotPorted("product.template.valuation of a new product");
    return templateValuation(env, rec.origin);
  },
});

