/**
 * The integrity rules of posted journal entries on every ORM write path (odoo/addons/account, Odoo 20 dd5d3718):
 * - account.move write (account_move.py:3995-4070): readonly fields of a posted move, journal changes, lock dates;
 * - account.move.line write (account_move_line.py:2100-2160): taxes of a posted item, lock dates, reconciliation;
 * - `_check_balanced` (account_move.py:2926-2965) after line writes;
 * - unlink of lines and moves (account_move_line.py:2305-2360 `_unlink_except_posted`, `_prevent_automatic_line_deletion`,
 *   `_except_hashed_entry_lines`; account_move.py:4170-4210).
 * Lines of invoices are re-synced by Odoo (`_sync_dynamic_lines`); that is not ported for direct line writes, so such a
 * write refuses instead of leaving the tax and payment term lines stale.
 */
import { checkLockDates } from "./account_locks";
import { checkHashedWrite } from "./account_hash";
import { NotPorted, UserError, ValidationError } from "../errors";
import { convertToCache, cacheEqual } from "../orm/convert";
import { plainNumber } from "../orm/values";
import { ModelImpl } from "../orm/model";
import type { Environment, FieldDef, ModelDef } from "../orm/types";
import { registerOverrides } from "../orm/write";
import type { TrackingDefer } from "./account_entries";
import { translate } from "./util";
import { trackDepth, trackDisabled, trackedFields, trackRecordDeleted, trackRecordFinalize, trackRecordPrepare, trackRecordAdd, afterTracking } from "../mail/tracking";

/** account_move.py:4001-4007 the fields of a posted move nobody may change. */
export const UNMODIFIABLE_MOVE_FIELDS = ["line_ids", "invoice_line_ids", "date", "invoice_date", "partner_id", "fiscal_position_id",
  "invoice_payment_term_id", "currency_id", "invoice_cash_rounding_id"];

/** account_move_line.py:3829-3842 `_get_lock_date_protected_fields`. */
const LOCK_TAX = ["balance", "tax_line_id", "tax_ids", "tax_tag_ids"];
const LOCK_FISCAL = [...LOCK_TAX, "account_id", "journal_id", "amount_currency", "currency_id", "partner_id"];
const LOCK_RECONCILIATION = ["account_id", "date", "balance", "amount_currency", "currency_id"];

/** The ids a many2many command list leaves (`record.new({fname: commands})[fname].ids`). */
function m2mAfter(current: readonly number[], commands: unknown): number[] | null {
  if (!Array.isArray(commands)) return null;
  let ids = [...current];
  for (const c of commands) {
    if (typeof c === "number") { if (!ids.includes(c)) ids.push(c); continue; }
    if (!Array.isArray(c)) return null;
    if (c[0] === 6) ids = [...((c[2] as number[] | undefined) ?? [])].map(Number);
    else if (c[0] === 4) { if (!ids.includes(Number(c[1]))) ids.push(Number(c[1])); }
    else if (c[0] === 3) ids = ids.filter((i) => i !== Number(c[1]));
    else if (c[0] === 5) ids = [];
    else return null;
  }
  return ids;
}

/** account_move.py:7847-7865 `_field_will_change(record, vals, field_name)`. */
export async function fieldWillChange(env: Environment, def: ModelDef, id: number, vals: Record<string, unknown>, fname: string): Promise<boolean> {
  if (!(fname in vals)) return false;
  const field: FieldDef | undefined = def.fields.get(fname);
  if (!field) return false;
  if (field.type === "one2many") return true;
  const current = (await new ModelImpl(env.sudo(), def).values([id], field)).get(id) ?? null;
  const value = vals[fname];
  if (field.type === "many2one") return (typeof current === "number" ? current : false) !== (typeof value === "number" ? value : value || false);
  if (field.type === "many2many") {
    const cur = Array.isArray(current) ? current.map(Number) : [];
    const after = m2mAfter(cur, value);
    if (after === null) throw new NotPorted(`_field_will_change of ${def.name}.${fname} with these commands`);
    return cur.length !== after.length || cur.some((i) => !after.includes(i));
  }
  if (field.type === "monetary") {
    const cf = field.currencyField;
    const currency = cf ? (await new ModelImpl(env.sudo(), def).values([id], def.fields.get(cf)!)).get(id) : null;
    if (typeof currency === "number" && currency) {
      const rounding = Number((await env.cr.query<{ r: string }>("SELECT rounding::text AS r FROM res_currency WHERE id = $1", [currency])).rows[0]?.r ?? 0.01);
      // res_currency.py is_zero: float_is_zero(amount, precision_rounding=rounding)
      const diff = Number(current ?? 0) - Number(value || 0);
      return Math.abs(Math.round(diff / rounding) * rounding) >= rounding / 2 && Math.round(diff / rounding) !== 0;
    }
  }
  if (field.type === "date" || field.type === "datetime") {
    // :7865 `record[f] != vals[f]`: a date object against the string of the RPC values is always unequal; only two
    // empty values (False == False) compare equal
    const empty = (v: unknown): boolean => v === null || v === undefined || v === false || v === "";
    return !(empty(current) && empty(value));
  }
  return !cacheEqual(current, convertToCache(field, value, def.name));
}

/** The en_US (or env.lang) label of a field (`_description_string(env)`). */
function label(env: Environment, field: FieldDef): string {
  const lang = env.lang ?? "en_US";
  if (lang === "en_US") return field.string;
  const t = field.strings[lang];
  if (!t) throw new NotPorted(`field label of ${field.name} in ${lang}`);
  return t;
}

/** account_move.py:2967-2985 `_check_fiscal_lock_dates` and account_move_line.py:1884-1901 `_check_tax_lock_date`. */
async function refuseLockDates(env: Environment, moveIds: readonly number[]): Promise<void> {
  if (!moveIds.length) return;
  await checkLockDates(env, moveIds);
}

interface MoveRow { id: number; state: string; name: string | null; ref: string | null; posted_before: boolean | null; journal_id: number | null;
  sequence_number: number | null; inalterable_hash: string | null; document_sequence_editable: boolean | null; regex: string | null }

/** account_move.py:3995-4070 the checks of account.move.write before the write. */
export async function checkMoveWrite(env: Environment, ids: readonly number[], vals: Record<string, unknown>): Promise<void> {
  const def = env.reg.model("account.move");
  const rows = (await env.cr.query<MoveRow>(
    `SELECT m.id, m.state, m.name, m.ref, m.posted_before, m.journal_id, m.sequence_number, m.inalterable_hash,
            c.document_sequence_editable, j.sequence_override_regex AS regex
       FROM account_move m JOIN res_company c ON c.id = m.company_id LEFT JOIN account_journal j ON j.id = m.journal_id
      WHERE m.id = ANY($1::int[]) ORDER BY m.id`, [[...ids]])).rows;
  const journalChange = (m: MoveRow): boolean => "journal_id" in vals && m.journal_id !== (vals["journal_id"] || null);
  const nameRemoved = "name" in vals && (vals["name"] === "/" || !vals["name"]);
  for (const m of rows) {
    if (m.inalterable_hash) await checkHashedWrite(env, [m.id], vals);
    if (m.posted_before && journalChange(m) && !(m.name === "/" || !m.name || nameRemoved)) {
      throw new UserError(translate(env, 'You cannot edit the journal of a journal entry if it has been posted once, unless the name is removed or set to "/". This might create a gap in the sequence.'));
    }
    if (m.name && m.name !== "/" && ![0, 1].includes(Number(m.sequence_number ?? 0)) && journalChange(m) && !m.document_sequence_editable && !nameRemoved) {
      throw new UserError(translate(env, 'You cannot edit the journal of a journal entry with a sequence number assigned, unless the name is removed or set to "/". This might create a gap in the sequence.'));
    }
    if (m.state === "posted" && (("name" in vals && m.name !== vals["name"]) || ("date" in vals && await fieldWillChange(env, def, m.id, vals, "date")))) await refuseLockDates(env, [m.id]);
    if ("state" in vals && m.state === "posted" && vals["state"] !== "posted") await refuseLockDates(env, [m.id]);
    const state = typeof vals["state"] === "string" ? vals["state"] : m.state;
    if (!env.context["skip_readonly_check"] && state === "posted") {
      const modified: string[] = [];
      for (const f of UNMODIFIABLE_MOVE_FIELDS) if (await fieldWillChange(env, def, m.id, vals, f)) modified.push(f);
      if (modified.length) {
        const move = m.name || m.ref || String(m.id);
        throw new UserError(`${translate(env, "You cannot modify the following readonly fields on the posted move")} ${move}: ${modified.map((f) => label(env, def.fields.get(f)!)).join(", ")}`);
      }
    }
    if (m.regex && vals["name"] && vals["name"] !== "/") throw new NotPorted("account.move name against the journal's sequence_override_regex");
  }
}

/** account_move.py:2926-2943 `_check_balanced` of the moves (2945-2965 `_get_unbalanced_moves`). */
export async function checkBalanced(env: Environment, moveIds: readonly number[]): Promise<void> {
  if (!moveIds.length || env.context["check_move_validity"] === false) return;
  const unbalanced = (await env.cr.query<{ move_id: number; name: string | null }>(
    `SELECT line.move_id, move.name FROM account_move_line line
       JOIN account_move move ON move.id = line.move_id
       JOIN res_company company ON company.id = move.company_id
       JOIN res_currency currency ON currency.id = company.currency_id
      WHERE line.move_id = ANY($1::int[])
      GROUP BY line.move_id, move.name, currency.decimal_places
     HAVING ROUND(SUM(line.balance), currency.decimal_places) != 0 ORDER BY line.move_id`, [[...moveIds]])).rows;
  if (!unbalanced.length) return;
  if (unbalanced.length === 1) throw new UserError(translate(env, "The entry is not balanced."));
  throw new UserError(`${translate(env, "The following entries are unbalanced:\n\n")}${unbalanced.map((u) => `  - ${u.name ?? "False"}\n`).join("")}`);
}

interface LineRow { id: number; move_id: number; state: string; move_type: string; matching_number: string | null; hash: string | null;
  balance: string | null; amount_currency: string | null; display_type: string | null; posted_before: boolean | null }

async function lineRows(env: Environment, ids: readonly number[]): Promise<LineRow[]> {
  return (await env.cr.query<LineRow>(
    `SELECT l.id, l.move_id, m.state, m.move_type, l.matching_number, m.inalterable_hash AS hash, l.balance::text AS balance,
            l.amount_currency::text AS amount_currency, l.display_type, m.posted_before
       FROM account_move_line l JOIN account_move m ON m.id = l.move_id WHERE l.id = ANY($1::int[]) ORDER BY l.id`, [[...ids]])).rows;
}

/**
 * `_("Journal Item %s updated", line._get_html_link(title=f"#{line.id}"))` (account_move_line.py:2272, models.py
 * `_get_html_link`): the translation is escaped because the argument is Markup (tools/translate.py:995).
 */
export function lineLogBody(env: Environment, id: number, what: "updated" | "deleted"): string {
  const text = translate(env, `Journal Item %s ${what}`).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text.replace("%s", `<a href="#" data-oe-model="account.move.line" data-oe-id="${id}">#${id}</a>`);
}

/**
 * `_track_record` of journal items on their move (account_move_line.py:2266-2272), prepared for:
 * - every non-COGS line of the invoices among `moveIds` that were posted once: `_sync_dynamic_lines` writes the
 *   dirty flags `discount_allocation_dirty` and `epd_dirty` of all of them (account_move.py:3685, :3805-3820,
 *   computed True by account_move_line.py:1390, :1439), and that write tracks them;
 * - `lineIds`, the written lines of moves posted once.
 * Changes of any of these lines in the request (a recomputed label too) are logged when the move's tracking is.
 * Must be closed by `trackRecordFinalize(env, "account.move.line")`.
 */
/**
 * account_move_line.py:2169-2178: a line created on a move posted before is tracked on the move from empty values
 * (`empty_line[fname]`: False, 0.0 or no records). The line is then written by the invoice's sync in the same write
 * (`_sync_invoice`), whose `_track_record` replaces the body with "updated" (:2271-2272), as Odoo logs it.
 */
export async function trackCreatedLine(env: Environment, lineId: number): Promise<void> {
  if (trackDisabled(env)) return;
  const posted = (await env.cr.query<{ m: number; p: boolean | null }>(
    "SELECT m.id AS m, m.posted_before AS p FROM account_move_line l JOIN account_move m ON m.id = l.move_id WHERE l.id = $1", [lineId])).rows[0];
  if (!posted?.p) return;
  const tracked = (await trackedFields(env, "account.move.line")).filter((f) => !f.related);
  const empty: Record<string, unknown> = {};
  for (const f of tracked) {
    if (f.type === "many2many" || f.type === "one2many") empty[f.name] = [];
    else if (f.type === "monetary" || f.type === "float" || f.type === "integer") empty[f.name] = 0;
    else empty[f.name] = false;
  }
  trackRecordAdd(env.cr, "account.move.line", tracked, new Map([[lineId, empty]]),
    new Map([[lineId, { model: "account.move", id: posted.m, body: lineLogBody(env, lineId, "updated") }]]));
}

export async function prepareLineTracking(env: Environment, moveIds: readonly number[], lineIds: readonly number[]): Promise<void> {
  const tracked = trackDisabled(env) ? [] : (await trackedFields(env, "account.move.line")).filter((f) => !f.related);
  const rows = tracked.length && (moveIds.length || lineIds.length) ? (await env.cr.query<{ id: number; move_id: number }>(
    `SELECT l.id, l.move_id FROM account_move_line l JOIN account_move m ON m.id = l.move_id
      WHERE m.posted_before AND ((m.id = ANY($1::int[]) AND m.move_type != 'entry' AND l.display_type IS DISTINCT FROM 'cogs') OR l.id = ANY($2::int[]))
      ORDER BY array_position($1::int[], m.id), l.date DESC, l.move_name DESC, l.id`, [[...moveIds], [...lineIds]])).rows : [];
  await trackRecordPrepare(env, "account.move.line", tracked,
    new Map(rows.map((l) => [l.id, { model: "account.move", id: l.move_id, body: lineLogBody(env, l.id, "updated") }])));
}

/** Invoice lines the move's own line sync may unlink (per transaction). */
export const INVOICE_SYNC_UNLINK = new WeakMap<object, Set<number>>();

registerOverrides("account.move.line", {
  // account_move_line.py write: the checks, the write, then `_check_balanced` of the moves
  write: async (env, ids, vals, next) => {
    const def = env.reg.model("account.move.line");
    const lines = await lineRows(env, ids);
    if (vals["account_id"]) {
      const active = (await env.cr.query<{ a: boolean }>("SELECT active AS a FROM account_account WHERE id = $1", [vals["account_id"]])).rows[0]?.a;
      if (active === false) throw new UserError(translate(env, "You cannot use an archived account."));
    }
    if (lines.some((l) => l.hash)) throw new NotPorted("write on journal items of a hashed entry");
    const written: LineRow[] = [];
    // account_move_line.py:2238-2246: a product line of a draft invoice written directly goes through its move's
    // `_sync_dynamic_lines` too (src/models/account_move_create.ts `writeInvoiceLines`)
    const INVOICE_LINE_WRITABLE = ["quantity", "price_unit", "discount", "name", "sequence", "product_id", "partner_id"];
    if (lines.length && lines.every((l) => l.move_type !== "entry" && l.state === "draft" && l.display_type === "product") && Object.keys(vals).every((k) => INVOICE_LINE_WRITABLE.includes(k))
      && Object.keys(vals).some((k) => k !== "name")) {
      if (lines.some((l) => l.hash)) throw new NotPorted("write on journal items of a hashed entry");
      const { writeInvoiceLines } = await import("./account_move_create");
      await prepareLineTracking(env, [...new Set(lines.map((l) => l.move_id))], lines.filter((l) => l.posted_before).map((l) => l.id));
      try {
        await writeInvoiceLines(env, ids, vals);
      } finally {
        if (trackDepth(env.cr, "account.move") > 0) afterTracking(env.cr, "account.move", () => trackRecordFinalize(env, "account.move.line"));
        else await trackRecordFinalize(env, "account.move.line");
      }
      return;
    }
    // account_move.py:3348-3363 `_sync_tax_lines`: a field a compiled override adds to the base lines' grouping key
    // syncs the tax lines of a draft move when written on one of its base lines, which this write does not do: refused
    if (lines.some((l) => l.state === "draft" && ["product", "epd", "rounding", "non_deductible_product"].includes(String(l.display_type)))) {
      const { addedGroupingFields } = await import("./account_tax_hooks");
      const added = await addedGroupingFields(env);
      const hit = Object.keys(vals).filter((k) => added.includes(k));
      if (hit.length) throw new NotPorted(`writing ${hit.join(", ")} on a base line of a draft move (_sync_tax_lines: a key a compiled override adds to the tax lines' grouping)`);
    }
    // account_move_line.py:2065-2084 `_sanitize_vals` before the checks (:2208): debit and credit are the balance
    // (`debit - credit`, a missing one 0), so the lock dates protect them as `balance`. The values written below stay
    // as given (the writes that pass are of draft entries); before round 13 a debit written on a posted line in a
    // locked period refused as NotPorted instead of Odoo's lock date UserError (opus13_lock step 10).
    let checkVals: Readonly<Record<string, unknown>> = vals;
    if ("debit" in vals || "credit" in vals) {
      const { debit, credit, ...rest } = vals;
      if (vals["move_id"] && (await env.cr.query("SELECT 1 FROM account_move m JOIN res_company c ON c.id = m.company_id WHERE m.id = $1 AND c.account_storno", [vals["move_id"]])).rows.length) {
        throw new NotPorted("debit/credit written on a journal item of a storno company (is_storno)");
      }
      checkVals = "balance" in vals ? rest : { ...rest, balance: Number(plainNumber(debit ?? 0)) - Number(plainNumber(credit ?? 0)) };
    }
    for (const l of lines) {
      const changing: string[] = [];
      for (const f of Object.keys(checkVals)) if (await fieldWillChange(env, def, l.id, checkVals, f)) changing.push(f);
      if (!changing.length) continue;
      written.push(l);
      if (l.state === "posted") {
        if (changing.includes("tax_ids") || changing.includes("tax_line_id")) {
          throw new UserError(translate(env, "You cannot modify the taxes related to a posted journal item, you should reset the journal entry to draft to do so."));
        }
        if (changing.some((f) => LOCK_FISCAL.includes(f))) await refuseLockDates(env, [l.move_id]);
      }
      if (l.matching_number && changing.some((f) => LOCK_RECONCILIATION.includes(f))) throw new NotPorted("write on a reconciled journal item (remove_move_reconcile)");
      // `_sync_dynamic_lines` of invoices and the line's own computes after an accounting change are not ported here
      const others = changing.filter((f) => f !== "name");
      if (others.length && (l.state === "posted" || l.move_type !== "entry")) {
        throw new NotPorted(`write of ${others.join(", ")} on a journal item of ${l.state === "posted" ? "a posted entry" : "an invoice"} (_sync_dynamic_lines)`);
      }
      // account_move.py:3263-3303, 3346: a draft entry with taxes (before or after the write) has its tax lines and an
      // "Automatic Balancing Line" (`_get_automatic_balancing_account`) synced by `_sync_dynamic_lines`, not ported:
      // before this the taxes were written alone (measured: Odoo added a 15% tax line and a balancing line)
      if (others.length && l.move_type === "entry" && (changing.includes("tax_ids") || (await env.cr.query(
        `SELECT 1 FROM account_move_line ml WHERE ml.move_id = $1 AND (ml.tax_line_id IS NOT NULL
            OR EXISTS (SELECT 1 FROM account_move_line_account_tax_rel r WHERE r.account_move_line_id = ml.id)) LIMIT 1`, [l.move_id])).rows.length)) {
        throw new NotPorted("write on a journal item of a draft entry with taxes (_sync_tax_lines, _sync_unbalanced_lines)");
      }
    }
    // :2266-2272 the changes of lines whose move was posted once are logged on the move (`_track_record`); the
    // move's `_sync_dynamic_lines` (:2244) first snapshots every line of an invoice posted once
    await prepareLineTracking(env, [...new Set(lines.map((l) => l.move_id))], written.filter((l) => l.posted_before).map((l) => l.id));
    try {
      await next(env, ids, vals);
      await checkBalanced(env, [...new Set(lines.map((l) => l.move_id))]);
    } finally {
      // the precommit `_track_finalize` of the lines runs after the one of an open account.move write (added earlier)
      if (trackDepth(env.cr, "account.move") > 0) afterTracking(env.cr, "account.move", () => trackRecordFinalize(env, "account.move.line"));
      else await trackRecordFinalize(env, "account.move.line");
    }
  },
  create: async (env, valsList, next) => {
    const moves = [...new Set(valsList.map((v) => Number(v["move_id"])).filter((m) => m))];
    if (moves.length) {
      const posted = (await env.cr.query("SELECT 1 FROM account_move WHERE id = ANY($1::int[]) AND (state = 'posted' OR move_type != 'entry') LIMIT 1", [moves])).rows.length;
      if (posted) throw new NotPorted("journal items created on a posted entry or an invoice (_sync_dynamic_lines)");
      const once = (await env.cr.query("SELECT 1 FROM account_move WHERE id = ANY($1::int[]) AND posted_before LIMIT 1", [moves])).rows.length;
      if (once && !trackDisabled(env)) throw new NotPorted("journal items created on an entry posted once (\"Journal Item created\" tracking, account_move_line.py:2170)");
    }
    const ids = await next(env, valsList);
    await checkBalanced(env, moves);
    return ids;
  },
  // account_move_line.py:2305-2335 the ondelete methods, then unlink's lock dates and `_check_balanced`
  beforeUnlink: async (env, ids) => {
    const lines = await lineRows(env, ids);
    if (!env.context["force_delete"]) {
      const restricted = lines.some((l) => (Number(l.balance ?? 0) || Number(l.amount_currency ?? 0)) && l.state === "posted");
      if (restricted) throw new UserError(translate(env, "You can't delete a posted journal item. Don’t play games with your accounting records; reset the journal entry to draft before deleting it."));
    }
    if (!env.context["dynamic_unlink"]) {
      for (const l of lines) {
        if (l.display_type === "tax") {
          const taxed = (await env.cr.query("SELECT 1 FROM account_move_line ml JOIN account_move_line_account_tax_rel r ON r.account_move_line_id = ml.id WHERE ml.move_id = $1 LIMIT 1", [l.move_id])).rows.length;
          if (taxed) throw new ValidationError(translate(env, "You cannot delete a tax line as it would impact the tax report"));
        } else if (l.display_type === "payment_term") {
          throw new ValidationError(translate(env, "You cannot delete a payable/receivable line as it would not be consistent with the payment terms"));
        }
      }
    }
    if (lines.some((l) => l.hash)) throw new UserError(translate(env, "You cannot delete journal items belonging to a locked journal entry."));
    if (lines.some((l) => l.matching_number)) throw new NotPorted("unlink of reconciled journal items (remove_move_reconcile)");
    // an invoice's lines are removed through its write (a `Command.delete` of `invoice_line_ids`, then the move's
    // `_sync_dynamic_lines`: src/models/account_move_create.ts) or by that sync itself
    const synced = INVOICE_SYNC_UNLINK.get(env.cr), withMove = MOVE_UNLINK_LINES.get(env.cr);
    if (lines.some((l) => l.move_type !== "entry" && !synced?.has(l.id) && !withMove?.has(l.id))) throw new NotPorted("unlink of invoice lines (_sync_dynamic_lines)");
    if (lines.some((l) => l.posted_before && !withMove?.has(l.id)) && !trackDisabled(env)) throw new NotPorted("unlink of journal items of an entry posted once (\"Journal Item deleted\" tracking, account_move_line.py:2350)");
  },
});

registerOverrides("account.move", {
  /**
   * account_move.py:4200-4210 `unlink` (with sale account_move.py:36-43 above it): `_update_sequence_made_gap`, then with
   * `skip_invoice_sync`/`dynamic_unlink` the lines' reconciliations removed and the lines unlinked
   * (account_move_line.py:2336-2370: lock dates, the "Journal Item deleted" tracking of moves posted once, the lines'
   * ondelete methods), then `super().unlink()` (mail.thread, the moves' ondelete methods below, the ORM).
   */
  unlink: async (env0, ids, next) => {
    const downpayment = (await env0.cr.query(
      `SELECT 1 FROM account_move_line l JOIN sale_order_line_invoice_rel r ON r.invoice_line_id = l.id JOIN sale_order_line s ON s.id = r.order_line_id
        WHERE l.move_id = ANY($1::int[]) AND s.is_downpayment LIMIT 1`, [[...ids]])).rows.length;
    if (downpayment) throw new NotPorted("unlink of an invoice with down payment lines (sale account_move.py:36-43)");
    const { updateSequenceGap } = await import("./account_move_ops");
    for (const id of ids) await updateSequenceGap(env0, id, { invalidate: true, asWrite: true });
    // the moves' tracking (the amounts the lines' removal recomputes) is logged at precommit in Odoo, when the moves are
    // gone (mail.thread's unlink discards them): a scope keeps it until then
    const { trackPrepare } = await import("../mail/tracking");
    const { closeTrackingScope } = await import("../mail/write_hooks");
    await trackPrepare(env0, "account.move", []);
    const env = env0.withContext({ ...env0.context, skip_invoice_sync: true, dynamic_unlink: true });
    const lines = (await env.cr.query<{ id: number }>(
      "SELECT id FROM account_move_line WHERE move_id = ANY($1::int[]) ORDER BY array_position($1::int[], move_id), date DESC, move_name DESC, id", [[...ids]])).rows.map((r) => r.id);
    // the payment states the reconciliations' removal changes are tracked at precommit (after the lines' "deleted"
    // logs); a caller with its own tracking scope open (account.payment action_cancel) flushes them after it
    const outer = UNLINK_TRACKING.get(env.cr);
    const defer: TrackingDefer = outer ?? { states: new Map(), later: [], payments: [] };
    if (lines.length) {
      const { removeMoveReconcile } = await import("./account_entries");
      await removeMoveReconcile(env, lines, defer);
      // account_move_line.py:2340-2349 (its own remove_move_reconcile has nothing left): the fiscal lock dates of the
      // posted moves with a non-zero line, the tax lock date of every line (all lines of the moves go)
      const posted = (await env.cr.query<{ m: number }>(
        `SELECT DISTINCT l.move_id AS m FROM account_move_line l JOIN account_move m ON m.id = l.move_id
          WHERE l.id = ANY($1::int[]) AND m.state = 'posted' AND (l.balance != 0 OR l.amount_currency != 0) ORDER BY 1`, [lines])).rows.map((r) => r.m);
      const { checkFiscalLockDates, checkTaxLockDate } = await import("./account_locks");
      await checkFiscalLockDates(env, posted);
      await checkTaxLockDate(env, ids);
      // :2351-2363 a line of a move posted once is tracked on its move against its empty values, at once
      if (!trackDisabled(env)) {
        const tracked = (await trackedFields(env, "account.move.line")).filter((f) => !f.related);
        const once = (await env.cr.query<{ id: number; move_id: number }>(
          `SELECT l.id, l.move_id FROM account_move_line l JOIN account_move m ON m.id = l.move_id
            WHERE l.id = ANY($1::int[]) AND m.posted_before ORDER BY array_position($1::int[], l.id)`, [lines])).rows;
        for (const l of once) {
          await trackRecordDeleted(env, "account.move.line", tracked, new Map([[l.id, { model: "account.move", id: l.move_id, body: lineLogBody(env, l.id, "deleted") }]]));
        }
      }
      MOVE_UNLINK_LINES.set(env.cr, new Set(lines));
      try {
        const { unlink } = await import("../orm/unlink");
        await unlink(env, "account.move.line", lines);
      } finally {
        MOVE_UNLINK_LINES.delete(env.cr);
      }
    }
    await next(env, ids);
    await closeTrackingScope(env0, "account.move");
    if (!outer) await flushUnlinkTracking(env, defer);
  },
  // the moves' `@api.ondelete` methods (account_move.py:4169-4198)
  beforeUnlink: async (env, ids) => {
    const lines = (await env.cr.query<{ id: number }>("SELECT id FROM account_move_line WHERE move_id = ANY($1::int[]) ORDER BY id", [[...ids]])).rows.map((r) => r.id);
    if (lines.length) throw new NotPorted("unlink of a move whose lines were not unlinked first (account.move unlink)");
    // :4169-4187 `_unlink_forbid_parts_of_chain`: a billing user may only delete the last move of a sequence chain
    const { hasGroup } = await import("../orm/env");
    if (!(await hasGroup(env, "account.group_account_manager")) && !env.context["force_delete"]) {
      const editable = (await env.cr.query(
        "SELECT 1 FROM account_move m JOIN res_company c ON c.id = m.company_id WHERE m.id = ANY($1::int[]) AND c.document_sequence_editable LIMIT 1", [[...ids]])).rows.length;
      const numbered = (await env.cr.query("SELECT 1 FROM account_move WHERE id = ANY($1::int[]) AND name IS NOT NULL AND name != '/' LIMIT 1", [[...ids]])).rows.length;
      if (!editable && numbered) throw new NotPorted("unlink of a numbered move by a user who is not an accounting manager (_is_end_of_seq_chain)");
    }
    // :4189-4198 `_unlink_account_audit_trail_except_once_post`
    if (!env.context["force_delete"]) {
      const audited = (await env.cr.query(
        "SELECT 1 FROM account_move m JOIN res_company c ON c.id = m.company_id WHERE m.id = ANY($1::int[]) AND m.posted_before AND c.restrictive_audit_trail LIMIT 1", [[...ids]])).rows.length;
      if (audited) throw new UserError(translate(env, "To keep the restrictive audit trail, you can not delete journal entries once they have been posted.\nInstead, you can cancel the journal entry."));
    }
  },
});

/** A tracking defer an account.move unlink uses instead of flushing its own (see `flushUnlinkTracking`). */
export const UNLINK_TRACKING = new WeakMap<object, TrackingDefer>();

/** The deferred tracking of an unlink's reconciliation removal: the moves' payment states, then the payments' states. */
export async function flushUnlinkTracking(env: Environment, defer: TrackingDefer): Promise<void> {
  const { finalizeTracking } = await import("./account_entries");
  await finalizeTracking(env, defer, []);
  for (const fn of defer.payments ?? []) await fn();
}

/** The lines an account.move unlink deletes (their invoice sync is skipped: `dynamic_unlink`, `skip_invoice_sync`). */
const MOVE_UNLINK_LINES = new WeakMap<object, Set<number>>();
