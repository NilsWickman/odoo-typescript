/**
 * Duplicating a sales order: sale_order.py:1469-1484 `copy_data` (the lines that are not down payments, in the
 * order's line order, each `Command.create` of its own copy_data) and sale_project sale_order_line.py:160-165 (a line
 * whose analytic distribution is the project's is copied without it). The generic copy is src/web/save.ts.
 */
import { NotPorted } from "../errors";
import { registerOverrides } from "../orm/write";
import { copyData } from "../web/save";

registerOverrides("sale.order", {
  // :1474-1477 `default.setdefault("order_line", [])` before super(): the generic copy does not copy the lines
  copyDefaults: (defaults) => ("order_line" in defaults ? { ...defaults } : { ...defaults, order_line: [] }),
  copyData: async (env, ids, valsList, defaults) => {
    if ("order_line" in defaults) return; // :1478 `default_has_no_order_line`
    for (let i = 0; i < ids.length; i++) {
      // `_get_copiable_order_lines` (:1469-1471): `order.order_line` (_order "order_id, sequence, id") without down payments
      const lines = (await env.cr.query<{ id: number }>(
        "SELECT id FROM sale_order_line WHERE order_id = $1 AND NOT COALESCE(is_downpayment, false) ORDER BY sequence, id", [ids[i]])).rows.map((r) => r.id);
      const linesVals = lines.length ? await copyData(env, "sale.order.line", lines, {}) : [];
      valsList[i]!["order_line"] = linesVals.map((l) => [0, 0, l]);
    }
  },
});

registerOverrides("sale.order.line", {
  copyData: async (env, ids, valsList) => {
    // sale_project sale_order_line.py:160-165: `origin.analytic_distribution == project._get_analytic_distribution()`;
    // a line without a distribution is copied without one either way, one with a distribution needs the project's
    const rows = (await env.cr.query<{ id: number; a: unknown }>("SELECT id, analytic_distribution AS a FROM sale_order_line WHERE id = ANY($1::int[])", [[...ids]])).rows;
    for (let i = 0; i < ids.length; i++) {
      const a = rows.find((r) => r.id === ids[i])?.a;
      if (a !== null && a !== undefined) throw new NotPorted("copy of a sale order line with an analytic distribution (project _get_analytic_distribution)");
      valsList[i]!["analytic_distribution"] = false; // NULL is copied as False either way
    }
  },
});
