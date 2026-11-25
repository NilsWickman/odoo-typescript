/**
 * The record methods the standard server actions of the list's Action menu call (src/models/inventory_flow.ts
 * runRecordsCode, rådet runda 12 åtgärd 4) that had no port: sale.order `action_quotation_sent`, account.move
 * `action_force_register_payment` and `action_validate_moves_with_confirmation`, stock.picking `do_unreserve`.
 */
import { NotPorted, UserError } from "../errors";
import { registerMethod } from "../http/methods";
import type { Environment } from "../orm/types";
import { write } from "../orm/write";
import { contextToday } from "./account_computes";
import { fetchRecords, postMoves } from "./account_buttons";
import { doUnreserve } from "./stock_engine";
import { translate } from "./util";

/** sale_order.py:1609-1617 `action_quotation_sent`: draft orders only, then `write({'state': 'sent'})`. */
registerMethod("sale.order", "action_quotation_sent", async (env, ids) => {
  const orders = ids ?? [];
  const states = (await env.cr.query<{ state: string | null }>("SELECT state FROM sale_order WHERE id = ANY($1::int[])", [orders])).rows;
  if (states.some((r) => r.state !== "draft")) throw new UserError(translate(env, "Only draft orders can be marked as sent directly.", "sale"));
  await write(env, "sale.order", orders, { state: "sent" });
  return null;
}, { apiModel: false });

/**
 * account_move.py:6733-6738 `action_force_register_payment`: no miscellaneous entries, no blocked invoices, then
 * account_move_line.py:1729-1747 `action_register_payment` of `self.line_ids` (the wizard action).
 */
registerMethod("account.move", "action_force_register_payment", async (env, ids) => {
  const moves = await fetchRecords(env, "account.move", ids ?? [], ["move_type", "payment_state", "line_ids"]);
  if (moves.some((m) => m["move_type"] === "entry")) throw new UserError(translate(env, "You cannot register payments for miscellaneous entries.", "account"));
  if (moves.some((m) => m["payment_state"] === "blocked")) throw new UserError(translate(env, "You cannot register payments for blocked invoices.", "account"));
  // `self.line_ids` of several moves (fields.py mapped, convert_to_record_multi): each move's lines in the one2many's
  // order (account.move.line `_order`), the moves in their order, without duplicates
  const byId = new Map(moves.map((m) => [Number(m["id"]), (m["line_ids"] as number[] | undefined) ?? []]));
  const lineIds: number[] = [];
  for (const id of ids ?? []) for (const l of byId.get(id) ?? []) if (!lineIds.includes(l)) lineIds.push(l);
  return {
    name: translate(env, "Pay", "account"),
    res_model: "account.payment.register",
    view_mode: "form",
    views: [[false, "form"]],
    context: { active_model: "account.move.line", active_ids: lineIds },
    target: "new",
    type: "ir.actions.act_window",
  };
}, { apiModel: false });

/**
 * account_move.py:6847-6880 `action_validate_moves_with_confirmation`: the draft moves with lines are posted
 * (`_post(soft=False)`), unless dated after today or in a hash-restricted journal (`_get_moves_requiring_confirmation`),
 * which open the validate.account.move wizard: refused.
 */
registerMethod("account.move", "action_validate_moves_with_confirmation", async (env, ids) => {
  const rows = (await env.cr.query<{ id: number; date: string | null; inv: string | null; restrict: boolean | null }>(
    `SELECT m.id, m.date::text AS date, m.invoice_date::text AS inv, j.restrict_mode_hash_table AS restrict
       FROM account_move m JOIN account_journal j ON j.id = m.journal_id
      WHERE m.id = ANY($1::int[]) AND m.state = 'draft' AND EXISTS (SELECT 1 FROM account_move_line l WHERE l.move_id = m.id)`, [ids ?? []])).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const drafts = (ids ?? []).filter((id) => byId.has(id));
  if (!drafts.length) throw new UserError(translate(env, "There are no journal items in the draft state to post.", "account"));
  const today = await contextToday(env);
  if (drafts.some((id) => { const r = byId.get(id)!; return ((r.date || r.inv) ?? "") > today || r.restrict; })) {
    throw new NotPorted("action_validate_moves_with_confirmation of future-dated or hash-restricted moves (validate.account.move wizard)");
  }
  await postMoves(env, drafts, false);
  return false;
}, { apiModel: false });

/** stock_picking.py:1173-1174 `do_unreserve`: `self.move_ids._do_unreserve()` (each transfer's moves in their _order). */
registerMethod("stock.picking", "do_unreserve", async (env: Environment, ids) => {
  const moves = (await env.cr.query<{ id: number }>(
    `SELECT m.id FROM stock_move m WHERE m.picking_id = ANY($1::int[])
      ORDER BY array_position($1::int[], m.picking_id), m.sequence, m.id`, [ids ?? []])).rows.map((r) => r.id);
  await doUnreserve(env, [...new Set(moves)]);
  return null;
}, { apiModel: false });
