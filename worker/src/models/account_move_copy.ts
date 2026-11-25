/**
 * Duplicating invoices, bills and credit notes: account_move.py:3864-3895 `copy_data`/`copy`, account_move_line.py
 * :2422-2438 `copy_data` and stock_account account_move.py:19-33. The generic copy is src/web/save.ts; the creation
 * of an invoice from the copied `line_ids` (product, note, tax and payment term lines in their order) is
 * src/models/account_move_create.ts, and of a journal entry from all its lines (their balance kept). Anglo-saxon (cogs)
 * lines, lock dates and recurring entries refuse; `include_business_fields` carries the sale and purchase lines.
 */
import { NotPorted } from "../errors";
import { registerMethod } from "../http/methods";
import { messageLogBatch, escapeText } from "../mail/message";
import { withDbErrors } from "../orm/sql_errors";
import { registerOverrides } from "../orm/write";
import { copy } from "../web/save";
import { envFor } from "../web/common";
import { touchSyncedInvoices } from "./account_entries";
import * as priv from "../orm/dispatch_gen";

const INVOICE_TYPES = ["out_invoice", "out_refund", "in_invoice", "in_refund", "out_receipt", "in_receipt"];
const NOTES = ["line_section", "line_subsection", "line_note"];

registerOverrides("account.move.line", {
  copyData: async (env, ids, valsList) => {
    const rows = (await env.cr.query<{ id: number; display_type: string | null; move_type: string; purchase_line_id: number | null }>(
      "SELECT l.id, l.display_type, m.move_type, l.purchase_line_id FROM account_move_line l JOIN account_move m ON m.id = l.move_id WHERE l.id = ANY($1::int[])", [[...ids]])).rows;
    for (let i = 0; i < ids.length; i++) {
      const r = rows.find((x) => x.id === ids[i])!;
      const vals = valsList[i]!;
      // :2436-2437 `_copy_data_extend_business_fields` with include_business_fields: sale's order lines
      // (sale account_move_line.py:41-43) and purchase's line (purchase account_invoice.py:667-670)
      const invoice = INVOICE_TYPES.includes(r.move_type); // is_invoice(include_receipts=True)
      if (r.display_type === "payment_term" && invoice) delete vals["name"]; // :2426-2428
      if (r.display_type && NOTES.includes(r.display_type)) { delete vals["balance"]; delete vals["account_id"]; } // :2429-2432
      if (r.display_type === "product" && invoice) delete vals["balance"]; // :2433-2435
      if (env.context["include_business_fields"]) {
        // :2436-2437 `line._copy_data_extend_business_fields(vals)` through callPrivate (private_hooks.json): the
        // values dict changed in place, sale's and purchase's as the hand; a site's override adds its own (l10n_cn's
        // balance deductions), given back by the bridge
        const sale = (await env.cr.query<{ o: number }>("SELECT order_line_id AS o FROM sale_order_line_invoice_rel WHERE invoice_line_id = $1 ORDER BY order_line_id", [r.id])).rows.map((x) => x.o);
        await priv.account_move_line._copy_data_extend_business_fields.call(env, [r.id], [vals], async (_e, _ids, a) => {
          const v = a[0] as Record<string, unknown>;
          v["sale_line_ids"] = [[6, null, sale]];
          v["purchase_line_id"] = r.purchase_line_id ?? false;
          return null;
        });
      }
    }
  },
});

registerOverrides("account.move", {
  copyData: async (env, ids, valsList, given) => {
    const rows = (await env.cr.query<{ id: number; move_type: string; date: string | null; company_id: number; journal_active: boolean | null; origin: number | null }>(
      `SELECT m.id, m.move_type, m.date::text AS date, m.company_id, j.active AS journal_active, m.auto_post_origin_id AS origin
         FROM account_move m LEFT JOIN account_journal j ON j.id = m.journal_id WHERE m.id = ANY($1::int[])`, [[...ids]])).rows;
    for (let i = 0; i < ids.length; i++) {
      const move = rows.find((x) => x.id === ids[i])!;
      const vals = valsList[i]!;
      if (!INVOICE_TYPES.includes(move.move_type) && move.move_type !== "entry") throw new NotPorted(`account.move copy of a move of type ${move.move_type}`);
      const lines = (vals["line_ids"] as unknown[][] | undefined) ?? [];
      // stock_account :19-33 and account :3869-3874: the anglo-saxon lines
      if (lines.some((c) => (c[2] as Record<string, unknown> | undefined)?.["display_type"] === "cogs")) throw new NotPorted("account.move copy with cogs lines");
      if (move.move_type === "out_invoice" || move.move_type === "in_invoice") vals["line_ids"] = lines.filter((c) => c[0] === 0);
      // :3875-3877 a journal entry's copy has no partner (its lines keep theirs), unless a reversal's cancel gives one
      else if (move.move_type === "entry" && (!("partner_id" in vals) || !env.context["move_reverse_cancel"])) vals["partner_id"] = false;
      // :3878-3880 `_get_user_fiscal_lock_date`: only without lock dates here
      const lock = (await env.cr.query<Record<string, string | null>>(
        "SELECT fiscalyear_lock_date, sale_lock_date, purchase_lock_date, tax_lock_date, hard_lock_date FROM res_company WHERE id = $1", [move.company_id])).rows[0];
      if (lock && Object.values(lock).some((v) => v !== null)) throw new NotPorted("account.move copy in a company with lock dates (_get_user_fiscal_lock_date)");
      if (!move.journal_active && "journal_id" in vals) delete vals["journal_id"]; // :3881-3882
      if (move.origin && !("auto_post_origin_id" in given)) throw new NotPorted("account.move copy of a recurring entry");
    }
  },
});

/**
 * :3885-3895 copy: BaseModel's, then "This entry has been duplicated from <link>" (`_get_copy_message_content`
 * :3897-3906; "reversed" with a `reversed_entry_id` default) logged on each copy (`_message_log_batch`).
 */
registerMethod("account.move", "copy", async (env0, ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const dflt = kwargs["default"] ?? args[0];
  if (dflt !== undefined && dflt !== null && dflt !== false && (typeof dflt !== "object" || Array.isArray(dflt))) throw new NotPorted("copy default");
  const defaults = (dflt && typeof dflt === "object" ? dflt : {}) as Record<string, unknown>;
  const source = [...(ids ?? [])];
  if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated copy message (${env.lang})`);
  // `copy` creates from the original records: the `_sync_dynamic_lines` container holds them (account_entries.ts)
  await touchSyncedInvoices(env, source);
  const created = await withDbErrors(env, () => copy(env, "account.move", source, defaults));
  const names = await env.model("account.move").displayName(source);
  const verb = defaults["reversed_entry_id"] ? "reversed" : "duplicated";
  const bodies = new Map<number, string>();
  for (let i = 0; i < source.length; i++) {
    // models.py `_get_html_link`: `<a href="#" data-oe-model=... data-oe-id=...>display_name</a>`
    const link = `<a href="#" data-oe-model="account.move" data-oe-id="${source[i]}">${escapeText(names.get(source[i]!) ?? "")}</a>`;
    bodies.set(created[i]!, `<p>This entry has been ${verb} from ${link}</p>`);
  }
  await messageLogBatch(env, "account.move", bodies);
  return created;
}, { apiModel: false });
