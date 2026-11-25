/**
 * Backorders: the wizard stock_backorder_confirmation.py (`default_get` :25-34, `process` :47-63), stock_picking.py
 * `_action_generate_backorder_wizard` (:1335-1346), `_create_backorder` (:1397-1432) with `_create_backorder_picking`
 * (:1387-1395), and stock_move.py `_create_backorder` (:2440-2455) with `_split` (:2485-2532) and
 * `_prepare_move_split_vals` (:2471-2483, purchase_stock stock_move.py:114-120). Moves in another unit than their
 * product's, chained or make-to-order moves, packages and "no backorder" (`process_cancel_backorder`, a line not to
 * backorder: `_log_less_quantities_than_expected`) refuse with NotPorted.
 */
import { NotPorted, UserError } from "../errors";
import { registerMethod } from "../http/methods";
import { computeAuthor, insertMessages, replyToDefault, trackingMessageId, xmlid } from "../mail/message";
import { assertNoRecipients } from "../mail/post";
import { flatThreadParent } from "../mail/thread_generic";
import { floatRound } from "../orm/convert";
import { create } from "../orm/create";
import { RecomputeQueue } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { registerOverrides, write } from "../orm/write";
import { copy, copyData } from "../web/save";
import { actionAssign, actionConfirm, moveRows, postNote, recomputeState, unitDigits, uomCompare } from "./stock_engine";
import { pyFloatReprSimple, translate } from "./util";
import { createActivities } from "../mail/activity";

async function rows<T extends object>(env: Environment, text: string, params: unknown[]): Promise<T[]> {
  return (await env.cr.query<T & Record<string, unknown>>(text, params)).rows;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/** stock_picking.py:1335-1346 `_action_generate_backorder_wizard`. */
export async function backorderWizardAction(env: Environment, pickingIds: readonly number[], showTransfers: boolean): Promise<Record<string, unknown>> {
  const view = await xmlid(env, "stock.view_backorder_confirmation");
  return {
    name: translate(env, "Create Backorder?"), type: "ir.actions.act_window", view_mode: "form", res_model: "stock.backorder.confirmation",
    views: [[view, "form"]], view_id: view, target: "new",
    context: { ...env.context, default_show_transfers: showTransfers, default_pick_ids: pickingIds.map((id) => [4, id]) },
  };
}

// stock_backorder_confirmation.py:25-34 `default_get`: one line to backorder per transfer (`res['pick_ids'][0][2]`)
registerOverrides("stock.backorder.confirmation", {
  defaultGet: async (_env, fields, values) => {
    const picks = values["pick_ids"];
    if (!fields.includes("backorder_confirmation_line_ids") || !Array.isArray(picks) || !picks.length) return;
    const first = picks[0];
    if (!Array.isArray(first) || first[0] !== 6 || !Array.isArray(first[2])) throw new NotPorted("stock.backorder.confirmation default_get of pick_ids not as (6, 0, ids)");
    values["backorder_confirmation_line_ids"] = (first[2] as number[]).map((id) => [0, 0, { to_backorder: true, picking_id: id }]);
  },
});

/** stock_backorder_confirmation.py:47-63 `process`. */
async function process(env: Environment, ids: readonly number[]): Promise<unknown> {
  const lines = await rows<{ picking_id: number | null; to_backorder: boolean | null }>(env,
    "SELECT picking_id, to_backorder FROM stock_backorder_confirmation_line WHERE backorder_confirmation_id = ANY($1::int[]) ORDER BY id", [[...ids]]);
  if (lines.some((l) => l.to_backorder !== true)) throw new NotPorted("stock.backorder.confirmation.process of a transfer not to backorder (_check_less_quantities_than_expected)");
  const toValidate = env.context["button_validate_picking_ids"];
  if (!Array.isArray(toValidate) || !toValidate.length) return true;
  const { buttonValidate } = await import("./stock_validate");
  return buttonValidate(env.withContext({ ...env.context, skip_backorder: true }), toValidate as number[]);
}

registerMethod("stock.backorder.confirmation", "process", async (env, ids) => process(env, ids ?? []), { apiModel: false });
/** markupsafe.escape of a value put into a template; values with characters it would change refuse (no guess). */
function plain(s: string): string {
  if (/[&<>"']/.test(s)) throw new NotPorted(`escaped value ${JSON.stringify(s)} in a stock note`);
  return s;
}

/**
 * stock_backorder_confirmation.py:36-47 `_check_less_quantities_than_expected` -> stock_picking.py:1534-1564
 * `_log_less_quantities_than_expected` with sale_stock's override (sale_stock stock.py:361-397): a warning activity
 * on each sale order of the moves, for the order's salesperson, with the `sale_stock.exception_on_picking` note.
 */
async function checkLessQuantitiesThanExpected(env: Environment, pickingIds: readonly number[]): Promise<void> {
  for (const pick of pickingIds) {
    const moves = await rows<{ id: number; product_uom_qty: number; quantity: number; picked: boolean | null; sale_line_id: number | null; dests: number }>(env,
      `SELECT m.id, m.product_uom_qty, m.quantity, m.picked, m.sale_line_id,
              (SELECT count(*)::int FROM stock_move_move_rel r WHERE r.move_orig_id = m.id) AS dests
         FROM stock_move m WHERE m.picking_id = $1 ORDER BY m.sequence, m.id`, [pick]);
    const toLog: { id: number; picked: number; demand: number; sale_line_id: number | null; dests: number }[] = [];
    for (const m of moves) {
      // stock_move.py:2064-2074 `_get_picked_quantity`
      let picked = Number(m.quantity);
      if (m.picked && (await rows(env, "SELECT 1 FROM stock_move_line WHERE move_id = $1 AND NOT COALESCE(picked, false) LIMIT 1", [m.id])).length) {
        throw new NotPorted("_get_picked_quantity of a move with unpicked lines");
      }
      if ((await uomCompare(env, Number(m.product_uom_qty), picked)) > 0) toLog.push({ id: m.id, picked, demand: Number(m.product_uom_qty), sale_line_id: m.sale_line_id, dests: m.dests });
    }
    if (!toLog.length) continue;
    if (env.context["skip_activity"]) continue; // stock_picking.py:1461-1462 (both overrides)
    // stock_picking.py:1562-1564: the following documents through move_dest_ids; mrp adds productions
    if (toLog.some((m) => m.dests > 0)) throw new NotPorted("_log_less_quantities_than_expected on chained moves (next transfers impacted)");
    if ((await rows(env, "SELECT 1 FROM ir_module_module WHERE name = 'mrp' AND state = 'installed'", [])).length) throw new NotPorted("mrp _less_quantities_than_expected_add_documents");
    // sale_stock stock.py:394: grouped by (order, salesperson) of the moves' sale lines
    const withLine = toLog.filter((m) => m.sale_line_id !== null);
    if (!withLine.length) continue;
    const groups = new Map<string, { order: number; user: number | null; moves: typeof withLine }>();
    for (const m of withLine) {
      const [o] = await rows<{ order_id: number; user_id: number | null }>(env, "SELECT l.order_id, o.user_id FROM sale_order_line l JOIN sale_order o ON o.id = l.order_id WHERE l.id = $1", [m.sale_line_id]);
      if (!o) continue;
      const k = `${o.order_id}:${o.user_id}`;
      const g = groups.get(k) ?? { order: o.order_id, user: o.user_id, moves: [] };
      g.moves.push(m);
      groups.set(k, g);
    }
    const [picking] = await rows<{ name: string }>(env, "SELECT name FROM stock_picking WHERE id = $1", [pick]);
    const type = await xmlid(env, "mail.mail_activity_data_warning");
    const [orderModel] = await rows<{ id: number }>(env, "SELECT id FROM ir_model WHERE model = 'sale.order'", []);
    if (env.lang && env.lang !== "en_US") throw new NotPorted("sale_stock.exception_on_picking outside en_US (template terms)");
    for (const g of groups.values()) {
      if (g.moves.length !== 1) throw new NotPorted("sale_stock.exception_on_picking with several moves of one order (one <ul> per move)");
      const m = g.moves[0]!;
      const [info] = await rows<{ product_id: number; uom: string }>(env,
        `SELECT m.product_id, COALESCE(u.name->>$2, u.name->>'en_US') AS uom FROM stock_move m JOIN uom_uom u ON u.id = m.uom_id WHERE m.id = $1`, [m.id, env.lang ?? "en_US"]);
      const product = (await env.sudo().model("product.product").displayName([info!.product_id])).get(info!.product_id) ?? "";
      // sale_stock/data/mail_templates.xml:38-56 as rendered by ir.qweb and stored by html_sanitize
      const note = `<div>\n                ${translate(env, "Exception(s) occurred on the picking:", "sale_stock")}\n`
        + `                <a href="#" data-oe-model="stock.picking" data-oe-id="${pick}">${plain(picking!.name)}</a>.\n`
        + `                ${translate(env, "Manual actions may be needed.", "sale_stock")}\n`
        + `                <div class="mt16">\n                    <p>${translate(env, "Exception(s):", "sale_stock")}</p>\n`
        + `                    <ul>\n                        <li>\n                        ${pyFloatReprSimple(m.picked)} ${plain(info!.uom)}\n`
        + `                        ${translate(env, "of", "sale_stock")} ${plain(product)} ${translate(env, "processed instead of", "sale_stock")} ${pyFloatReprSimple(m.demand)} ${plain(info!.uom)}</li>\n`
        + `                    </ul>\n                </div>\n            </div>`;
      // mail_activity_mixin.py:355-426 `_activity_schedule_create_vals` on the order (sudo), `date.today()` (the
      // server's date: UTC here)
      const [type0] = await rows<{ summary: string | null; res_model: string | null }>(env, "SELECT summary->>'en_US' AS summary, res_model FROM mail_activity_type WHERE id = $1", [type]);
      if (type0?.res_model && type0.res_model !== "sale.order") throw new NotPorted("warning activity type of another model");
      const [today] = await rows<{ d: string }>(env, "SELECT (now() AT TIME ZONE 'UTC')::date::text AS d", []);
      await createActivities(env.sudo(), [{
        activity_type_id: type, summary: type0?.summary || false, automated: true, note, date_deadline: today!.d,
        res_model_id: orderModel!.id, res_id: g.order, user_id: g.user ?? false,
      }], { sanitizedNote: true });
    }
  }
}

/** stock_backorder_confirmation.py:67-75 `process_cancel_backorder`. */
registerMethod("stock.backorder.confirmation", "process_cancel_backorder", async (env, ids) => {
  const toValidate = env.context["button_validate_picking_ids"];
  if (!Array.isArray(toValidate) || !toValidate.length) return true;
  await checkLessQuantitiesThanExpected(env, toValidate as number[]);
  const picks = (await rows<{ id: number }>(env,
    "SELECT stock_picking_id AS id FROM stock_picking_backorder_rel WHERE stock_backorder_confirmation_id = ANY($1::int[]) ORDER BY stock_picking_id", [ids ?? []])).map((r) => r.id);
  const { buttonValidate } = await import("./stock_validate");
  return buttonValidate(env.withContext({ ...env.context, skip_backorder: true, picking_ids_not_to_backorder: picks }), toValidate as number[]);
}, { apiModel: false });

/** stock_move.py:2485-2532 `_split` of a move in its product's unit: the values of the new move. */
async function split(env: Environment, moveId: number, qty: number): Promise<Record<string, unknown>[]> {
  const [m] = await moveRows(env, [moveId]);
  if (["done", "cancel"].includes(m!.state)) throw new UserError(translate(env, "You cannot split a stock move that has been set to 'Done' or 'Cancel'."));
  if (m!.state === "draft") throw new UserError(translate(env, "You cannot split a draft move. It needs to be confirmed first."));
  if ((await uomCompare(env, qty, 0)) === 0) return [];
  if (m!.uom_id !== m!.product_uom) throw new NotPorted("stock.move._split of a move in another unit than its product's");
  if (m!.orig || m!.dests) throw new NotPorted("stock.move._split of a chained move (move_orig_ids, move_dest_ids)");
  if (m!.procure_method === "make_to_order") throw new NotPorted("stock.move._split of a make-to-order move (created_purchase_line_ids)");
  if (env.context["force_split_uom_id"]) throw new NotPorted("stock.move._split with force_split_uom_id");
  const [extra] = await rows<{ origin_returned_move_id: number | null; price_unit: number | null; date_deadline: string | null; purchase_line_id: number | null }>(env,
    "SELECT origin_returned_move_id, price_unit::float8 AS price_unit, to_char(date_deadline, 'YYYY-MM-DD HH24:MI:SS') AS date_deadline, purchase_line_id FROM stock_move WHERE id = $1", [moveId]);
  // `_prepare_move_split_vals` (+ purchase_stock: the purchase line); the move's unit is the product's, so uom_qty == qty
  const defaults: Record<string, unknown> = {
    product_uom_qty: qty, procure_method: m!.procure_method, move_dest_ids: [], move_orig_ids: [],
    origin_returned_move_id: extra!.origin_returned_move_id ?? false, price_unit: extra!.price_unit ?? false,
    date_deadline: extra!.date_deadline ?? false, purchase_line_id: extra!.purchase_line_id ?? false,
  };
  const vals = await copyData(env, "stock.move", [moveId], defaults);
  const digits = await unitDigits(env);
  const newQty = floatRound(Math.max(0, m!.product_qty - qty), digits);
  await write(env.withContext({ ...env.context, do_not_unreserve: true }), "stock.move", [moveId], { product_uom_qty: newQty });
  await recomputeState(env, [moveId]);
  return vals;
}

/** stock_move.py:2440-2455 `_create_backorder` of the moves being done: the remainders as new confirmed moves. */
export async function splitRemainders(env: Environment, moveIds: readonly number[]): Promise<number[]> {
  const digits = await unitDigits(env);
  const valsList: Record<string, unknown>[] = [];
  for (const m of await moveRows(env, moveIds)) {
    if (floatRound(m.quantity, digits) >= floatRound(m.product_uom_qty, digits)) continue;
    if (m.uom_id !== m.product_uom) throw new NotPorted("stock.move._create_backorder of a move in another unit than its product's");
    // uom._compute_quantity(product_uom_qty - quantity, product unit, HALF-UP) in the same unit
    valsList.push(...(await split(env, m.id, floatRound(m.product_uom_qty - m.quantity, digits))));
  }
  if (!valsList.length) return [];
  const created = await create(env, "stock.move", valsList);
  // `_action_confirm(merge=False, create_proc=False)` with bypass_entire_pack
  await actionConfirm(env.withContext({ ...env.context, bypass_entire_pack: true }), created, { merge: false });
  return created;
}

/** `message_post(body, subtype_xmlid=...)` of a Markup body by the current user, nobody to notify (else NotPorted). */
export async function postOnPicking(env: Environment, picking: number, body: string, subtype: string): Promise<void> {
  const subtypeId = await xmlid(env, subtype);
  await assertNoRecipients(env, "stock.picking", picking, subtypeId, []);
  const [author, emailFrom] = await computeAuthor(env, null, null);
  const [row] = await rows<{ c: number | null }>(env, "SELECT company_id AS c FROM stock_picking WHERE id = $1", [picking]);
  await insertMessages(env, [{
    model: "stock.picking", res_id: picking, body, author_id: author, email_from: emailFrom, message_type: "notification", subject: false,
    subtype_id: subtypeId, email_add_signature: true, record_company_id: row?.c ?? false, parent_id: await flatThreadParent(env, "stock.picking", picking),
    message_id: trackingMessageId("message-notify"), reply_to: await replyToDefault(env, emailFrom),
  }]);
}

/** stock_picking.py:1397-1432 `_create_backorder` (moves not done nor cancelled go to a copy of the transfer). */
export async function createBackorders(env: Environment, pickingIds: readonly number[]): Promise<number[]> {
  if (env.context["pickings_to_detach"]) throw new NotPorted("stock.picking._create_backorder with pickings_to_detach (batches)");
  const backorders: number[] = [];
  const toAssign: number[] = [];
  for (const picking of pickingIds) {
    const [p] = await rows<{ batch_id: number | null; return_id: number | null; name: string; reservation_method: string | null }>(env,
      `SELECT p.batch_id, p.return_id, p.name, t.reservation_method FROM stock_picking p JOIN stock_picking_type t ON t.id = p.picking_type_id WHERE p.id = $1`, [picking]);
    if (p!.batch_id) throw new NotPorted("stock.picking._create_backorder of a transfer in a batch");
    const moves = (await rows<{ id: number }>(env, "SELECT id FROM stock_move WHERE picking_id = $1 AND state NOT IN ('done', 'cancel') ORDER BY sequence, id", [picking])).map((r) => r.id);
    await recomputeState(env, moves);
    if (!moves.length) continue;
    // `_create_backorder_picking`
    const [backorder] = await copy(env, "stock.picking", [picking], { name: "/", move_ids: [], move_line_ids: [], backorder_id: picking, return_id: p!.return_id ?? false });
    await write(env, "stock.move", moves, { picking_id: backorder, picked: false });
    const lines = (await rows<{ id: number }>(env, "SELECT id FROM stock_move_line WHERE move_id = ANY($1::int[]) ORDER BY id", [moves])).map((r) => r.id);
    if (lines.length) await write(env, "stock.move.line", lines, { picking_id: backorder });
    // the transfers' one2many `move_ids` changed with the moves' picking_id (models.py `modified` through the inverse)
    const queue = new RecomputeQueue(env.sudo());
    // (`move_line_ids` only when lines moved: the write on an empty recordset modifies nothing, so the copied
    // shipping_weight, a stored compute with readonly=False and so copied, stays as copied)
    await queue.modified("stock.picking", [picking, backorder!], lines.length ? ["move_ids", "move_line_ids"] : ["move_ids"]);
    await queue.run();
    backorders.push(backorder!);
    await write(env, "stock.picking", [backorder!], { user_id: false });
    const [bo] = await rows<{ name: string }>(env, "SELECT name FROM stock_picking WHERE id = $1", [backorder]);
    if ((env.lang ?? "en_US") !== "en_US") throw new NotPorted("the backorder message in another language");
    // `_get_html_link`: <a href="#" data-oe-model=... data-oe-id=...>display_name</a>
    await postOnPicking(env, picking, `<p>The backorder <a href="#" data-oe-model="stock.picking" data-oe-id="${backorder}">${esc(bo!.name)}</a> has been created.</p>`, "stock.mt_picking_state");
    if (p!.reservation_method === "at_confirm") toAssign.push(backorder!);
    else throw new NotPorted("stock.picking._create_backorder of a transfer type not reserving at confirmation");
  }
  if (toAssign.length) {
    // `action_assign` of the backorders (stock_picking.py:787-800): their open moves by priority, deadline, date and id
    const draft = await rows(env, "SELECT 1 FROM stock_picking WHERE id = ANY($1::int[]) AND state = 'draft' LIMIT 1", [toAssign]);
    if (draft.length) throw new NotPorted("stock.picking.action_assign of a draft backorder");
    const open = await rows<{ id: number; priority: string | null; deadline: string | null; date: string }>(env,
      `SELECT id, priority, to_char(date_deadline, 'YYYY-MM-DD HH24:MI:SS.US') AS deadline, to_char(date, 'YYYY-MM-DD HH24:MI:SS.US') AS date
         FROM stock_move WHERE picking_id = ANY($1::int[]) AND state NOT IN ('draft', 'cancel', 'done')`, [toAssign]);
    const cmp = (a: string | null, b: string | null): number => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1);
    open.sort((a, b) => (-Number(a.priority ?? 0)) - (-Number(b.priority ?? 0))
      || Number(a.deadline === null) - Number(b.deadline === null) || cmp(a.deadline, b.deadline) || cmp(a.date, b.date) || a.id - b.id);
    await actionAssign(env, open.map((m) => m.id));
  }
  return backorders;
}
