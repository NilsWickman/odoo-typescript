/**
 * The Python methods the delivery slip calls (stock/report/report_deliveryslip.xml `stock.report_delivery_document`,
 * with sale_stock/report/stock_report_deliveryslip.xml).
 */
import { NotPorted } from "../errors";
import { type PyRecords, registerPyMethod } from "../qweb/records";
import { asFloat, isPyFloat, toNumber } from "../pyexpr/values";
import { floatRound, floatRoundUp } from "../orm/convert";
import { loadCodeTranslations } from "../orm/code_translations";
import { translate } from "./util";
import { registerRecordCompute } from "../orm/recompute";

const rel = async (r: PyRecords, f: string): Promise<PyRecords> => (await r.field(f)) as PyRecords;
const num = (v: unknown): number => (isPyFloat(v) ? v.float : v === false || v === null || v === undefined ? 0 : toNumber(v));
const one = (r: PyRecords, id: number): PyRecords => r.browse([id]);
const unique = (ids: readonly number[]): number[] => [...new Set(ids)];

/** fields_relational.py:41-71 `records.field` of several records: the union of the values, in order (`unique`). */
async function mapped(r: PyRecords, f: string): Promise<PyRecords> {
  const ids: number[] = [];
  let model: PyRecords | null = null;
  for (const id of r.ids) {
    const v = await rel(one(r, id), f);
    model ??= v;
    ids.push(...v.ids);
  }
  if (model === null) return rel(r.browse([]), f);
  return model.browse(unique(ids));
}

async function productUnitDigits(r: PyRecords): Promise<number> {
  return (await r.env.cr.query<{ digits: number }>("SELECT digits FROM decimal_precision WHERE name = 'Product Unit'")).rows[0]?.digits ?? 2;
}

/** uom_uom.py:139-169 `_compute_quantity(qty, to_unit)` (round, 'UP'). */
async function computeQuantity(from: PyRecords, qty: number, to: PyRecords): Promise<number> {
  if (!from.ids.length || !qty) return qty;
  from.ensureOne();
  let amount = qty;
  if (!(to.ids.length === 1 && to.ids[0] === from.ids[0])) {
    amount = qty * num(await from.field("factor"));
    if (to.ids.length) amount = amount / num(await to.field("factor"));
  }
  if (to.ids.length) amount = floatRoundUp(amount, await productUnitDigits(from));
  return amount;
}

/** uom_uom.py:108-112 `round(value)`: 'Product Unit' digits, HALF-UP; `ensure_one` on an empty unit raises. */
async function uomRound(uom: PyRecords, value: number): Promise<number> {
  if (uom.ids.length !== 1) throw new Error(`ValueError: Expected singleton: ${uom.pyToString()}`);
  return floatRound(value, await productUnitDigits(uom));
}

// stock_picking.py:738-744 `should_print_delivery_address` (with `_is_to_external_location`)
registerPyMethod("stock.picking", "should_print_delivery_address", async (recs) => {
  recs.ensureOne();
  const moves = await rel(recs, "move_ids");
  if (!moves.ids.length) return moves;
  const partner = await rel(one(moves, moves.ids[0]!), "partner_id");
  const either = partner.ids.length ? partner : await rel(recs, "partner_id");
  if (!either.ids.length) return either;
  return (await recs.field("picking_type_code")) === "outgoing";
});

// stock_picking.py:1868-1870 `_get_deliveryslip_report_title`, stock_picking_type.py:692-699 `_get_code_report_name`
registerPyMethod("stock.picking", "_get_deliveryslip_report_title", async (recs) => {
  recs.ensureOne();
  const type = await rel(recs, "picking_type_id");
  type.ensureOne();
  const code = await type.field("code");
  const source = ({ outgoing: "Delivery Note", incoming: "Goods Receipt Note", internal: "Internal Move" } as Record<string, string>)[String(code)];
  if (source === undefined) return null;
  if (recs.env.lang && recs.env.lang !== "en_US") await loadCodeTranslations(recs.env.cr, recs.env.lang);
  return translate(recs.env, source, "stock");
});

// stock_move.py:2583-2588 `_get_report_description_picking`
registerPyMethod("stock.move", "_get_report_description_picking", async (recs) => {
  recs.ensureOne();
  let description = String((await recs.field("description_picking")) || "");
  const display = String(await (await rel(recs, "product_id")).field("display_name") || "");
  if (description.startsWith(display)) description = pyStrip(description.slice(display.length));
  return description;
});

/** Python's `str.strip()` (whitespace, as `str.isspace`). */
function pyStrip(s: string): string {
  return s.replace(/^[\s\x1c-\x1f\x85]+|[\s\x1c-\x1f\x85]+$/gu, "");
}

type Props = Map<string, unknown>;

/** stock_move_line.py:894-918 `_get_aggregated_properties(move_line=False, move=False)`. */
async function aggregatedProperties(moveLine: PyRecords | null, moveIn: PyRecords | null): Promise<Props> {
  const move = moveIn ?? (await rel(moveLine!, "move_id"));
  const moveUom = await rel(move, "uom_id");
  const uom = moveUom.ids.length ? moveUom : await rel(moveLine!, "uom_id");
  const packaging = await rel(move, "packaging_uom_id");
  const product = await rel(move, "product_id");
  const name = product.ids.length ? String(await product.field("display_name") || "") : "";
  let description = String((await move.field("description_picking")) || "");
  const productName = product.ids.length ? String(await product.field("name") || "") : "";
  if (!product.ids.length) throw new NotPorted("delivery slip of a move without product (_get_aggregated_properties)");
  if (description.startsWith(name)) description = pyStrip(description.slice(name.length));
  else if (description.startsWith(productName)) description = pyStrip(description.slice(productName.length));
  const id = (r: PyRecords): string => (r.ids.length ? String(r.ids[0]) : "False");
  const props: Props = new Map<string, unknown>([
    ["line_key", `${id(product)}_${name}_${description}_${id(uom)}_${id(packaging)}`],
    ["name", name], ["description", description], ["uom_id", uom], ["packaging_uom_id", packaging], ["move", move],
  ]);
  if (moveLine && (await rel(moveLine, "result_package_id")).ids.length) {
    throw new NotPorted("delivery slip of a move line with a destination package (_get_aggregated_properties)");
  }
  return props;
}

// stock_move_line.py:920-1010 `_get_aggregated_product_quantities(**kwargs)`
registerPyMethod("stock.move.line", "_get_aggregated_product_quantities", async (recs, args, kwargs) => {
  if (args.length) throw new NotPorted("_get_aggregated_product_quantities with positional arguments");
  for (const k of kwargs.keys()) if (k !== "strict" && k !== "except_package") throw new NotPorted(`_get_aggregated_product_quantities(${k}=...)`);
  const strict = Boolean(kwargs.get("strict"));
  const exceptPackage = Boolean(kwargs.get("except_package"));
  const out = new Map<string, Props>();
  // :932-937 the backorders, their backorders, ...
  let backorderIds: number[] = [];
  let pickings = await mapped(recs, "picking_id");
  for (;;) {
    const next = await mapped(pickings, "backorder_ids");
    if (!next.ids.length) break;
    backorderIds = unique([...backorderIds, ...next.ids]);
    pickings = next;
  }
  const backorders = (await mapped(recs, "picking_id")).browse(backorderIds);
  const startsWith = async (key: string, ml: PyRecords): Promise<boolean> =>
    key.startsWith(String((await aggregatedProperties(null, await rel(ml, "move_id"))).get("line_key")));
  for (const id of recs.ids) {
    const ml = one(recs, id);
    if (exceptPackage && (await rel(ml, "result_package_id")).ids.length) continue;
    const props = await aggregatedProperties(ml, null);
    const key = String(props.get("line_key"));
    const uom = props.get("uom_id") as PyRecords;
    const move = await rel(ml, "move_id");
    const packaging = await rel(move, "packaging_uom_id");
    const quantity = await computeQuantity(await rel(ml, "uom_id"), num(await ml.field("quantity")), uom);
    const packagingQuantity = await computeQuantity(uom, quantity, packaging);
    const entry = out.get(key);
    if (entry === undefined) {
      let ordered: number | null = null;
      let packagingOrdered: number | null = null;
      if (!strict) {
        ordered = num(await move.field("product_uom_qty"));
        if (backorders.ids.length) {
          const following: number[] = [];
          for (const b of (await mapped(backorders, "move_line_ids")).ids) if (await startsWith(key, one(recs, b))) following.push(b);
          for (const m of (await mapped(recs.browse(following), "move_id")).ids) ordered += num(await one(await rel(ml, "move_id"), m).field("product_uom_qty"));
        }
        // :961-965 the done quantities of the move's other move lines
        let previous = 0;
        for (const other of (await rel(move, "move_line_ids")).ids) {
          if (other === id) continue;
          const o = one(recs, other);
          if (!(await startsWith(key, o))) continue;
          previous += await computeQuantity(await rel(o, "uom_id"), num(await o.field("quantity")), uom);
        }
        ordered = await uomRound(uom, ordered - previous);
        packagingOrdered = await computeQuantity(uom, ordered, packaging);
      }
      out.set(key, new Map<string, unknown>([...props,
        ["quantity", asFloat(quantity)], ["packaging_quantity", asFloat(packagingQuantity)],
        ["qty_ordered", asFloat(ordered ?? quantity)], ["packaging_qty_ordered", asFloat(packagingOrdered ?? packagingQuantity)],
        ["product", await rel(ml, "product_id")]]));
    } else {
      entry.set("qty_ordered", asFloat(await uomRound(uom, num(entry.get("qty_ordered")) + quantity)));
      entry.set("packaging_qty_ordered", asFloat(await uomRound(packaging, num(entry.get("packaging_qty_ordered")) + packagingQuantity)));
      entry.set("quantity", asFloat(await uomRound(uom, num(entry.get("quantity")) + quantity)));
      entry.set("packaging_quantity", asFloat(await uomRound(packaging, num(entry.get("packaging_quantity")) + packagingQuantity)));
    }
  }
  if (strict) return out;
  // :977-1010 the empty moves (split when the transfer is done) for the ordered quantity
  const all = (await mapped(recs, "picking_id")).browse(unique([...(await mapped(recs, "picking_id")).ids, ...backorderIds]));
  const moves = await mapped(all, "move_ids");
  for (const mid of moves.ids) {
    const move = one(moves, mid);
    let bypass = false;
    const uomOfMove = await rel(move, "uom_id");
    const demand = num(await move.field("product_uom_qty"));
    const done = num(await move.field("quantity"));
    if (!(demand && uomOfMove.ids.length === 1 && Math.abs(floatRound(done, await productUnitDigits(move))) === 0)) continue;
    const state = await move.field("state");
    if (state !== "cancel") {
      if (state !== "confirmed" || (await rel(move, "move_line_ids")).ids.length) continue;
      bypass = true;
    }
    const props = await aggregatedProperties(null, move);
    const key = String(props.get("line_key"));
    const uom = props.get("uom_id") as PyRecords;
    const keys = [...out.keys()];
    if (!keys.some((k) => k.startsWith(key)) && !bypass) {
      out.set(key, new Map<string, unknown>([...props, ["quantity", false], ["packaging_quantity", 0], ["packaging_qty_ordered", 0],
        ["qty_ordered", asFloat(demand)], ["product", await rel(move, "product_id")]]));
    } else if (out.has(key)) {
      const e = out.get(key)!;
      e.set("qty_ordered", asFloat(await uomRound(uom, num(e.get("qty_ordered")) + demand)));
    } else {
      const k = keys.find((x) => x.startsWith(key));
      if (k !== undefined) {
        const e = out.get(k)!;
        e.set("qty_ordered", asFloat(await uomRound(uom, num(e.get("qty_ordered")) + demand)));
      }
    }
  }
  return out;
});

// stock_picking.py:459-477 `_compute_packages_count`: a done transfer counts its package histories (`_read_group` on
// the many2many `picking_ids`); the packages of an open transfer (`stock.package` searched on its computed
// `picking_ids`) are not ported
registerRecordCompute("stock.picking", {
  packages_count: async (env, rec) => {
    if ((await rec.get("state")) !== "done") throw new NotPorted("stock.picking.packages_count of a transfer not done (stock.package picking_ids)");
    if (rec.origin === null) return 0;
    return Number((await env.cr.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM stock_package_history_stock_picking_rel WHERE stock_picking_id = $1", [rec.origin])).rows[0]?.n ?? 0);
  },
});
