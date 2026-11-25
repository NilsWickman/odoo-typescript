/**
 * Secured journals: account_move.py:4735-4747 `_hash_moves` on posting (write of state 'posted', :4106-4109, journals
 * that are not cash journals), :4749-4879 `_get_chain_info`/`_get_chains_to_hash` of the journal's sequence prefix,
 * :4881-4914 `_calculate_hashes` (hash version 4: "$4$" + sha256 of the previous hash and the sorted JSON of the
 * move's and its lines' integrity fields), and the "This journal entry has been secured." note of every hashed move.
 */
import { createHash } from "node:crypto";
import { NotPorted, UserError } from "../errors";
import { messageLogBatch } from "../mail/message";
import type { Environment } from "../orm/types";
import { translate } from "./util";

/** Python `json.dumps(..., ensure_ascii=True)` of a string. */
function jsonString(s: string): string {
  return JSON.stringify(s).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** `float_repr(value, decimal_places)`. */
function floatRepr(v: number, places: number): string {
  return v.toFixed(places);
}

interface ChainMove { id: number; name: string; date: string; journal_id: number; company_id: number; sequence_number: number; sequence_prefix: string }

/** `_calculate_hashes(previous_hash)` of moves in sequence order. */
async function calculateHashes(env: Environment, moves: ChainMove[], previous0: string | null): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  let previous = previous0 ?? "";
  for (const m of moves) {
    if (previous.startsWith("$")) previous = previous.split("$")[2] ?? "";
    const values: Record<string, string> = {
      name: m.name, date: m.date, journal_id: String(m.journal_id), company_id: String(m.company_id),
    };
    const lines = (await env.cr.query<{ id: number; name: string | null; debit: number; credit: number; account_id: number; partner_id: number | null; places: number }>(
      `SELECT l.id, l.name, l.debit::float8 AS debit, l.credit::float8 AS credit, l.account_id, l.partner_id, c.decimal_places AS places
         FROM account_move_line l JOIN res_currency c ON c.id = l.currency_id WHERE l.move_id = $1 ORDER BY l.sequence, l.id`, [m.id])).rows;
    for (const l of lines) {
      // `_getattrstring`: str() of the value, a many2one's id, a monetary field as float_repr in the record's currency
      values[`line_${l.id}_name`] = l.name === null ? "False" : l.name;
      values[`line_${l.id}_debit`] = floatRepr(l.debit, l.places);
      values[`line_${l.id}_credit`] = floatRepr(l.credit, l.places);
      values[`line_${l.id}_account_id`] = String(l.account_id);
      values[`line_${l.id}_partner_id`] = l.partner_id === null ? "False" : String(l.partner_id);
    }
    const record = `{${Object.keys(values).sort().map((k) => `${jsonString(k)}:${jsonString(values[k]!)}`).join(",")}}`;
    const hash = `$4$${createHash("sha256").update(previous + record, "utf8").digest("hex")}`;
    out.set(m.id, hash);
    previous = hash;
  }
  return out;
}

/** `_hash_moves()` (no force) of a posted move: the chain of its journal and sequence prefix up to it. */
export async function hashOnPost(env: Environment, moveId: number): Promise<void> {
  const [m] = (await env.cr.query<{ jtype: string; restrict: boolean | null; state: string }>(
    `SELECT m.state, j.type AS jtype, j.restrict_mode_hash_table AS restrict
       FROM account_move m JOIN account_journal j ON j.id = m.journal_id WHERE m.id = $1`, [moveId])).rows;
  if (!m || m.jtype === "cash") return;
  if (m.state !== "posted" || !m.restrict) return;
  await hashMoves(env, [moveId], { forceHash: false, raiseIfGap: true, raiseIfNoDocument: true });
}

export interface ChainInfo {
  readonly previousHash: string | null;
  readonly lastMoveHashed: { id: number; sequence_number: number; inalterable_hash: string } | null;
  readonly moves: ChainMove[];
  readonly remainingMoveIds: number[];
  readonly warnings: Set<string>;
  readonly journalRestrictMode: boolean;
}

/**
 * account_move.py:4749-4835 `_get_chain_info`: all `moveIds` belong to one (journal_id, sequence_prefix).
 * Returns null when the last move is not restricted/posted (under forceHash=false or draft).
 */
export async function getChainInfo(env: Environment, moveIds: readonly number[], opts: {
  readonly forceHash?: boolean;
  readonly includePreLastHash?: boolean;
  readonly computeWarnings?: boolean;
} = {}): Promise<ChainInfo | null> {
  if (!moveIds.length) return null;
  const forceHash = opts.forceHash ?? false;
  const includePreLastHash = opts.includePreLastHash ?? false;
  const computeWarnings = opts.computeWarnings ?? (env.context["chain_info_warnings"] !== false);
  const [lastInChain] = (await env.cr.query<ChainMove & { state: string; restrict: boolean | null }>(
    `SELECT m.id, m.name, to_char(m.date, 'YYYY-MM-DD') AS date, m.journal_id, m.company_id,
            m.sequence_number, m.sequence_prefix, m.state, j.restrict_mode_hash_table AS restrict
       FROM account_move m JOIN account_journal j ON j.id = m.journal_id
      WHERE m.id = ANY($1::int[]) ORDER BY m.sequence_number DESC, m.id DESC LIMIT 1`, [[...moveIds]])).rows;
  if (!lastInChain) return null;
  if (lastInChain.state !== "posted" || (!forceHash && !lastInChain.restrict)) return null;

  const [lastHashed] = (await env.cr.query<{ id: number; sequence_number: number; inalterable_hash: string }>(
    `SELECT id, sequence_number, inalterable_hash FROM account_move
      WHERE journal_id = $1 AND sequence_prefix = $2 AND inalterable_hash IS NOT NULL
      ORDER BY sequence_number DESC LIMIT 1`, [lastInChain.journal_id, lastInChain.sequence_prefix])).rows;

  const toHash = (await env.cr.query<ChainMove>(
    `SELECT id, name, to_char(date, 'YYYY-MM-DD') AS date, journal_id, company_id, sequence_number, sequence_prefix
       FROM account_move
      WHERE journal_id = $1 AND sequence_prefix = $2 AND sequence_number <= $3
        AND inalterable_hash IS NULL AND state = 'posted'
        AND ($4::int IS NULL OR sequence_number > $4)
      ORDER BY sequence_number`,
    [lastInChain.journal_id, lastInChain.sequence_prefix, lastInChain.sequence_number,
      lastHashed && !includePreLastHash ? lastHashed.sequence_number : null])).rows;

  const warnings = new Set<string>();
  if (computeWarnings) {
    if (toHash.length) {
      const first = lastHashed ? lastHashed.sequence_number : toHash[0]!.sequence_number;
      const difference = lastHashed ? toHash.length : toHash.length - 1;
      const last = toHash[toHash.length - 1]!.sequence_number;
      if (first + difference !== last) warnings.add("gap");
      const unreconciled = (await env.cr.query(
        "SELECT 1 FROM account_bank_statement_line WHERE move_id = ANY($1::int[]) AND NOT COALESCE(is_reconciled, false) LIMIT 1",
        [toHash.map((x) => x.id)])).rows.length;
      if (unreconciled) warnings.add("unreconciled");
    } else {
      warnings.add("no_document");
    }
  }
  const hashedSet = new Set(toHash.map((x) => x.id));
  return {
    previousHash: lastHashed?.inalterable_hash ?? null,
    lastMoveHashed: lastHashed ?? null,
    moves: toHash,
    remainingMoveIds: moveIds.filter((id) => !hashedSet.has(id)),
    warnings,
    journalRestrictMode: Boolean(lastInChain.restrict),
  };
}

/** base/models/res_groups.py:437-474 `_apply_group_regular`. */
async function applyGroupRegular(env: Environment): Promise<void> {
  const su = env.sudo();
  const regularId = await su.reg.xmlid(su.cr, "base.group_user_regular");
  if (typeof regularId !== "number") return;
  const lightXmlIds = [
    "account.group_cash_rounding", "account.group_delivery_invoice_address",
    "analytic.group_analytic_accounting",
    "base.default_user_group", "base.group_everyone", "base.group_multi_currency",
    "base.group_no_one", "base.group_portal", "base.group_public", "base.group_user",
    "crm.group_use_lead", "crm.group_use_recurring_revenues",
    "hr_attendance.group_hr_attendance_own", "hr_attendance.group_hr_attendance_own_reader",
    "hr_holidays.group_hr_holidays_employee", "hr_recruitment.group_applicant_cv_display",
    "l10n_in.group_l10n_in_reseller", "lunch.group_lunch_user",
    "mail.group_mail_notification_type_inbox", "mass_mailing.group_mass_mailing_campaign",
    "mrp.group_mrp_byproducts", "mrp.group_mrp_routings", "mrp.group_unlocked_by_default",
    "point_of_sale.group_pos_preset",
    "product.group_product_pricelist", "product.group_product_variant", "product.group_show_uom_price",
    "product_expiry.group_expiry_date_on_delivery_slip",
    "project.group_project_milestone", "project.group_project_recurring_tasks",
    "project.group_project_stages", "project.group_project_task_dependencies",
    "purchase.group_send_reminder", "purchase.group_warning_purchase",
    "sale.group_auto_done_setting", "sale.group_discount_per_so_line", "sale.group_proforma_sales",
    "sale.group_services_and_material", "sale.group_warning_sale",
    "stock.group_adv_location", "stock.group_lot_on_delivery_slip", "stock.group_production_lot",
    "stock.group_stock_lot_print_gs1", "stock.group_stock_multi_locations", "stock.group_stock_picking_batch",
    "stock.group_stock_sign_delivery", "stock.group_tracking_lot", "stock.group_tracking_owner",
    "stock.group_warning_stock", "stock_account.group_lot_on_invoice",
    "uom.group_uom", "website.group_multi_website",
    "website_sale.group_product_feed", "website_sale.group_product_price_comparison",
  ];
  const lightIds = new Set<number>([regularId]);
  for (const x of lightXmlIds) {
    const id = await su.reg.xmlid(su.cr, x);
    if (typeof id === "number") lightIds.add(id);
  }
  const { hierarchy } = await import("./res_groups_hierarchy");
  const h = await hierarchy(su) as {
    groups: Record<string, { id: number; privilege_id: number | false; implied_ids: number[] }>;
    privileges: Record<string, { id: number; group_ids: number[] }>;
  };
  const regularGroupIds = new Set<number>();
  for (const g of Object.values(h.groups)) {
    if (!lightIds.has(g.id)) regularGroupIds.add(g.id);
  }
  const sortKey = (gid: number): number => {
    const pid = h.groups[String(gid)]?.privilege_id;
    if (!pid) return 0;
    const list = h.privileges[String(pid)]?.group_ids ?? [];
    return list.indexOf(gid);
  };
  const sorted = [...regularGroupIds].sort((a, b) => sortKey(a) - sortKey(b) || a - b);
  const seenPrivs = new Set<number>();
  const targetIds: number[] = [];
  for (const gid of sorted) {
    const g = h.groups[String(gid)]!;
    const pid = g.privilege_id;
    const impliesRegular = g.implied_ids.some((i) => regularGroupIds.has(i));
    if (!pid || !impliesRegular) {
      targetIds.push(gid);
    } else if (!seenPrivs.has(pid)) {
      targetIds.push(gid);
      seenPrivs.add(pid);
    }
  }
  const current = (await su.cr.query<{ gid: number }>("SELECT gid FROM res_groups_implied_rel WHERE hid = $1", [regularId])).rows.map((r) => r.gid);
  const curSet = new Set(current);
  const tgtSet = new Set(targetIds);
  const same = curSet.size === tgtSet.size && [...curSet].every((x) => tgtSet.has(x));
  if (!same) {
    const { write } = await import("../orm/write");
    await write(su, "res.groups", [regularId], { implied_by_ids: [[6, 0, targetIds]] });
  }
}

/** account/models/res_users.py:10-21 `res.groups._activate_group_account_secured`. */
async function activateGroupAccountSecured(env: Environment): Promise<void> {
  const secured = await env.reg.xmlid(env.cr, "account.group_account_secured");
  if (typeof secured !== "number") return;
  const su = env.sudo();
  const { write } = await import("../orm/write");
  const { impliedGroups } = await import("../orm/env");
  let changed = false;
  for (const xmlid of ["account.group_account_readonly", "account.group_account_invoice"]) {
    const gid = await env.reg.xmlid(env.cr, xmlid);
    if (typeof gid !== "number") continue;
    const imp = await impliedGroups(su);
    const seen = new Set<number>([gid]);
    const stack = [...(imp.get(gid) ?? [])];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(imp.get(cur) ?? []));
    }
    if (!seen.has(secured)) {
      await write(su, "res.groups", [gid], { implied_ids: [[4, secured, 0]] });
      changed = true;
    }
  }
  if (changed) await applyGroupRegular(su);
}

/**
 * account_move.py:4735-4747 `_hash_moves` + :4837-4879 `_get_chains_to_hash`.
 */
export async function hashMoves(env: Environment, moveIds: readonly number[], opts: {
  readonly forceHash?: boolean;
  readonly raiseIfGap?: boolean;
  readonly raiseIfNoDocument?: boolean;
  readonly includePreLastHash?: boolean;
} = {}): Promise<void> {
  if (!moveIds.length) return;
  const forceHash = opts.forceHash ?? false;
  const raiseIfGap = opts.raiseIfGap ?? true;
  const raiseIfNoDocument = opts.raiseIfNoDocument ?? true;
  const includePreLastHash = opts.includePreLastHash ?? false;

  const rows = (await env.cr.query<{ id: number; journal_id: number; sequence_prefix: string | null }>(
    `SELECT id, journal_id, sequence_prefix FROM account_move WHERE id = ANY($1::int[]) ORDER BY array_position($1::int[], id)`,
    [[...moveIds]])).rows;
  // Group preserving first-seen journal_id, then first-seen sequence_prefix (matching Python `grouped`)
  const byJournal = new Map<number, Map<string, number[]>>();
  for (const r of rows) {
    let byPrefix = byJournal.get(r.journal_id);
    if (!byPrefix) { byPrefix = new Map(); byJournal.set(r.journal_id, byPrefix); }
    const pref = r.sequence_prefix ?? "";
    const list = byPrefix.get(pref);
    if (list) list.push(r.id); else byPrefix.set(pref, [r.id]);
  }
  const chains: ChainInfo[] = [];
  for (const byPrefix of byJournal.values()) {
    for (const ids of byPrefix.values()) {
      const info = await getChainInfo(env, ids, { forceHash, includePreLastHash });
      if (!info) continue;
      if (info.warnings.has("unreconciled")) {
        throw new UserError(translate(env, "An error occurred when computing the inalterability. All entries have to be reconciled."));
      }
      if (raiseIfNoDocument && info.warnings.has("no_document")) {
        throw new UserError(translate(env, "This move could not be locked either because some move with the same sequence prefix has a higher number. You may need to resequence it."));
      }
      if (raiseIfGap && info.warnings.has("gap")) {
        throw new UserError(translate(env, "An error occurred when computing the inalterability. A gap has been detected in the sequence."));
      }
      chains.push(info);
    }
  }
  let grantSecureGroupAccess = false;
  for (const chain of chains) {
    if (!chain.moves.length) continue;
    const companies = new Set(chain.moves.map((x) => x.company_id));
    if (companies.size > 1) throw new NotPorted("hash chain over several companies");
    const hashes = await calculateHashes(env.sudo(), chain.moves, chain.previousHash);
    const manual = forceHash && !env.context["skip_is_manually_modified"];
    if (forceHash && !env.context["skip_invoice_sync"]) {
      const { touchSyncedInvoices } = await import("./account_entries");
      await touchSyncedInvoices(env, chain.moves.map((x) => x.id));
    }
    for (const [id, hash] of hashes) {
      if (manual) {
        await env.cr.query("UPDATE account_move SET inalterable_hash = $2, is_manually_modified = true, write_uid = $3, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1", [id, hash, env.uid]);
      } else {
        await env.cr.query("UPDATE account_move SET inalterable_hash = $2, write_uid = $3, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1", [id, hash, env.uid]);
      }
    }
    if (!chain.journalRestrictMode) grantSecureGroupAccess = true;
    if ((env.lang ?? "en_US") !== "en_US") throw new NotPorted("the secured note in another language");
    await messageLogBatch(env, "account.move", new Map(chain.moves.map((x) => [x.id, "<p>This journal entry has been secured.</p>"])));
  }
  if (grantSecureGroupAccess) await activateGroupAccountSecured(env);
}

/** account_move.py:4026-4032 write of hash fields on a hashed move. */
export async function checkHashedWrite(env: Environment, moveIds: readonly number[], vals: Readonly<Record<string, unknown>>): Promise<void> {
  const fields = ["name", "date", "journal_id", "company_id", "inalterable_hash"].filter((f) => f in vals);
  if (!fields.length) return;
  const hashed = (await env.cr.query("SELECT 1 FROM account_move WHERE id = ANY($1::int[]) AND inalterable_hash IS NOT NULL LIMIT 1", [[...moveIds]])).rows.length;
  if (!hashed) return;
  const def = env.reg.model("account.move");
  if ((env.lang ?? "en_US") !== "en_US") throw new NotPorted("hash protection message in another language");
  // `fields_get(violated_fields)` iterates the model's fields in their order
  const labels = [...def.fields.values()].filter((f) => fields.includes(f.name)).map((f) => f.string);
  throw new UserError(translate(env, "This document is protected by a hash. Therefore, you cannot edit the following fields: %s.").replace("%s", labels.join(", ")));
}

/** account_journal.py:801-808: the option cannot be removed once the journal has hashed entries. */
export async function checkJournalHashWrite(env: Environment, ids: readonly number[], vals: Readonly<Record<string, unknown>>): Promise<void> {
  if (!("restrict_mode_hash_table" in vals) || vals["restrict_mode_hash_table"]) return;
  for (const id of ids) {
    const hashed = (await env.cr.query("SELECT 1 FROM account_move m JOIN account_journal j ON j.id = m.journal_id WHERE m.journal_id = $1 AND m.inalterable_hash IS NOT NULL AND m.state = 'posted' AND j.restrict_mode_hash_table LIMIT 1", [id])).rows.length;
    if (hashed) {
      const label = env.reg.model("account.journal").fields.get("restrict_mode_hash_table")!.string;
      if ((env.lang ?? "en_US") !== "en_US") throw new NotPorted("journal hash message in another language");
      throw new UserError(translate(env, "You cannot modify the field %s of a journal that already has accounting entries.").replace("%s", label));
    }
  }
}

// the journal's write override (with checkJournalHashWrite) is src/models/account_journal_create.ts journalWrite
