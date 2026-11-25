/**
 * The Python methods the sale order report templates call (sale/report/ir_actions_report_templates.xml,
 * sale/views/sale_portal_templates.xml).
 */
import { NotPorted } from "../errors";
import { userHasGroup } from "../web/groups";
import { type PyRecords, registerPyMethod } from "../qweb/records";
import { plainNumber, pyFloat } from "../orm/values";

// sale_order.py:2320-2339 `_get_order_lines_to_report`
registerPyMethod("sale.order", "_get_order_lines_to_report", async (recs) => {
  const lines = (await recs.field("order_line")) as PyRecords;
  const keep: number[] = [];
  for (const line of lines.pyIter() as PyRecords[]) {
    if (await line.field("is_downpayment")) throw new NotPorted("sale report with down payment lines (_get_downpayment_state)");
    if ((await line.field("display_type")) === "line_section") { keep.push(line.ids[0]!); continue; }
    const parent = (await line.field("parent_id")) as PyRecords;
    if (parent.ids.length) {
      if (await parent.field("collapse_composition")) continue;
      const grand = (await parent.field("parent_id")) as PyRecords;
      if (grand.ids.length && (await grand.field("collapse_composition"))) continue;
    }
    keep.push(line.ids[0]!);
  }
  return lines.browse(keep);
});

// sale_order_line.py:2161-2168 `_has_taxes`
// (a section, subsection or note: whether a line of `_get_section_lines` has taxes)
/** sale_order_line.py:2170-2172 `_get_section_lines`: the order's lines in the section, in the order's line order
 * (product_catalog_line_mixin.py:36-46 `_is_line_in_section`: its children and, for a section, its subsections'). */
async function sectionLines(recs: PyRecords): Promise<PyRecords[]> {
  const id = recs.ensureOne();
  const kind = await recs.field("display_type");
  const lines = (await ((await recs.field("order_id")) as PyRecords).field("order_line")) as PyRecords;
  const out: PyRecords[] = [];
  for (const line of lines.pyIter() as PyRecords[]) {
    const parent = (await line.field("parent_id")) as PyRecords;
    const parentId = parent.ids[0];
    let inSection = parentId === id;
    if (!inSection && kind === "line_section" && parentId !== undefined && (await parent.field("display_type")) === "line_subsection") {
      inSection = ((await parent.field("parent_id")) as PyRecords).ids[0] === id;
    }
    if (inSection) out.push(line);
  }
  return out;
}
async function hasTaxes(recs: PyRecords): Promise<boolean> {
  recs.ensureOne();
  if (((await recs.field("tax_ids")) as PyRecords).ids.length) return true;
  if (!(await recs.field("display_type"))) return false;
  for (const line of await sectionLines(recs)) if (await hasTaxes(line)) return true;
  return false;
}
// sale_order_line.py:2147-2151 `_get_section_totals(totals_field)`: Python's sum over the section's lines (the integer
// 0 when there are none)
registerPyMethod("sale.order.line", "_get_section_totals", async (recs, args, kwargs) => {
  const name = String(args[0] ?? kwargs.get("totals_field"));
  if (!["price_subtotal", "price_total"].includes(name)) throw new NotPorted(`sale.order.line._get_section_totals(${name})`);
  const lines = await sectionLines(recs);
  let total = 0;
  for (const line of lines) {
    const v = plainNumber(await line.field(name));
    total += typeof v === "number" ? v : Number(v);
  }
  return lines.length ? pyFloat(total) : 0;
});
registerPyMethod("sale.order.line", "_has_taxes", (recs) => hasTaxes(recs));

// base ir_config_parameter.py:124-129 `get_str(key, default='')` (templates call it through sudo())
registerPyMethod("ir.config_parameter", "get_str", async (recs, args, kwargs) => {
  if (!recs.env.su && !(await userHasGroup(recs.env, "base.group_system"))) throw new NotPorted("ir.config_parameter.get_str without sudo (check_access)");
  const key = String(args[0] ?? kwargs.get("key"));
  const dflt = args.length > 1 ? args[1] : kwargs.has("default") ? kwargs.get("default") : "";
  const row = (await recs.env.cr.query<{ value: string | null }>("SELECT value FROM ir_config_parameter WHERE key = $1", [key])).rows[0];
  return row?.value ?? dflt;
});

// stock_picking.py:1865-1866 `_get_report_lang`: the first move's partner's language (moves in `_order`, sequence, id),
// else the picking's partner's, else the environment's
registerPyMethod("stock.picking", "_get_report_lang", async (recs) => {
  const moves = (await recs.field("move_ids")) as PyRecords;
  const first = moves.ids.length ? moves.browse([moves.ids[0]!]) : null;
  const moveLang = first ? await ((await first.field("partner_id")) as PyRecords).field("lang") : false;
  if (moveLang) return moveLang;
  const lang = await ((await recs.field("partner_id")) as PyRecords).field("lang");
  return lang || recs.env.lang || false;
});
