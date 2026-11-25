/**
 * Header buttons of the stock.picking form (`/web/dataset/call_button`) as far as the API corpus reaches them in
 * poc_erp. Confirming, reserving, validating, returning and cancelling (moves, quants, procurement) are not ported.
 * Rows in worker/COMPUTED.md.
 */
import { NotPorted } from "../errors";
import { registerMethod } from "../http/methods";
import { write } from "../orm/write";
import { fetchRecords, reportAction, xmlidId } from "./account_buttons";

/** stock_picking.py:1348-1351 action_toggle_is_locked (the write override :683-722 adds nothing for is_locked). */
registerMethod("stock.picking", "action_toggle_is_locked", async (env, ids) => {
  if (ids === null || ids.length !== 1) throw new NotPorted(`ensure_one on stock.picking(${(ids ?? []).join(", ")})`);
  const [picking] = await fetchRecords(env, "stock.picking", ids, ["is_locked"]);
  await write(env, "stock.picking", ids, { is_locked: !picking!["is_locked"] });
  return true;
}, { apiModel: false });

/** stock_picking.py:734-736 do_print_picking: `printed` written, then the picking operations report (config=True). */
registerMethod("stock.picking", "do_print_picking", async (env, ids) => {
  await write(env, "stock.picking", ids ?? [], { printed: true });
  return reportAction(env, await xmlidId(env, "stock.action_report_picking"), ids ?? []);
}, { apiModel: false });
