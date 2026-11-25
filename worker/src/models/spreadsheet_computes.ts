/**
 * spreadsheet dashboards (odoo/addons/spreadsheet_dashboard/models/spreadsheet_dashboard.py).
 * The `spreadsheet_binary_data` default (spreadsheet_mixin.py:27, a BinaryBytes value) needs binary values in
 * convert_to_cache (src/orm/convert.ts), which the write core refuses; it is not registered here.
 */
import { hooksOf, registerHooks } from "../orm/hooks";
import { defineComputes } from "./tail_util";

registerHooks("spreadsheet.dashboard", {
  // spreadsheet_dashboard.py:20-25 favorite_user_ids domain=lambda self: [('id', '=', self.env.uid)]
  descriptionDomain: { ...hooksOf("spreadsheet.dashboard").descriptionDomain, favorite_user_ids: async (env) => [["id", "=", env.uid]] },
});

// spreadsheet_dashboard.py:34-38 _compute_is_favorite (depends_context uid)
defineComputes("spreadsheet.dashboard", {
  is_favorite: async (env, rec) => (await rec.rels("favorite_user_ids")).some((u) => u.origin === env.uid),
});
