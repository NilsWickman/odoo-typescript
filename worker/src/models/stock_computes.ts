/**
 * Python behaviour of the stock.* models the API corpus reaches (odoo/addons/stock/models/, poc_erp): non-stored
 * computes, callable selections and SQL of computed fields. Rows in worker/COMPUTED.md.
 */
import { NotPorted } from "../errors";
import { registerHooks } from "../orm/hooks";
import { userHasGroup } from "../web/groups";
import { searchDisplayNameDefault, sql } from "../orm/sql";
import { and, cond, isNegativeOperator, or } from "../orm/domain";
import { DbRec, type Rec, readFieldBatch, registerOnchange, registerRecordCompute } from "../orm/recompute";
import { translate } from "./util";
import type { Domain, Environment, ModelDef } from "../orm/types";
import { relatedSelections } from "./account_computes";
import { registerActivityMixin } from "./crm_activity";
import { defineComputes, filteredAccess } from "./tail_util";

// stock_picking_type.py:12-35, :146-161 `_get_product_label_format_selection` (labels are plain strings, not _())
const BARCODE: readonly [string, string][] = [["barcode", "Barcode"], ["qr", "QR"]];
const SHEET: readonly [string, string][] = [["dymo", "Dymo"], ["2x7", "2 x 7"], ["4x7", "4 x 7"], ["4x12", "4 x 12"]];
const ZPL: readonly [string, string][] = [["normal", "ZPL Labels - Normal"], ["small", "ZPL Labels - Small"], ["alternative", "ZPL Labels - Alternative"], ["jewelry", "ZPL Labels - Jewelry"]];
const VARIANTS: readonly [string, string][] = [["", ""], ["_price", ", with price"], ["_price_packaging", ", with price, with packaging"]];
function productLabelFormats(): [string, string][] {
  const out: [string, string][] = [];
  for (const [bf, bl] of BARCODE) {
    for (const [pf, pl] of SHEET) for (const [vs, ls] of VARIANTS) out.push([`${bf}_${pf}${vs}`, `${bl} ${pl}${ls}`]);
    for (const [zt, zl] of ZPL) for (const [vs, ls] of VARIANTS) out.push([`${bf}_zpl_${zt}${vs}`, `${bl} ${zl}${ls}`]);
  }
  return out;
}

async function pickingTypeNameDomain(env: Environment, def: ModelDef, operator: string, value: unknown): Promise<Domain> {
  const parts = typeof value === "string" ? value.split(": ") : null;
  if (parts && parts.length === 2) return and([cond("warehouse_id.name", operator, parts[0]), cond("name", operator, parts[1])]);
  if (operator === "=") return searchDisplayNameDefault(env, def, "in", [value]);
  return searchDisplayNameDefault(env, def, operator, value);
}

registerHooks("stock.picking.type", {
  // stock_picking_type.py:449-461 `_search_display_name`: reverse "Warehouse: Type"
  searchDisplayName: async (env, operator, value) => {
    const def = env.reg.model("stock.picking.type");
    if (operator === "in") {
      if (!Array.isArray(value)) throw new NotPorted("stock.picking.type _search_display_name 'in' with a non-list value");
      const parts: Domain[] = [];
      for (const v of value) parts.push(await pickingTypeNameDomain(env, def, "=", v));
      return or(parts);
    }
    if (operator === "not in") throw new NotPorted("stock.picking.type _search_display_name NotImplemented for 'not in'");
    return pickingTypeNameDomain(env, def, operator, value);
  },
  selection: { product_label_format: async () => productLabelFormats() },
  // stock_picking_type.py:359-363 `_compute_sql_is_favorite`
  computeSql: {
    is_favorite: async (table) => sql`(${table.id} IN (SELECT picking_type_id FROM picking_type_favorite_user_rel WHERE user_id = ${table.env.uid}))`,
  },
});

defineComputes("stock.picking.type", {
  // stock_picking_type.py:365-369
  hide_reservation_method: async (_env, rec) => (await rec.get("code")) === "incoming",
  // :348-350 `_compute_is_favorite` (compute_sudo)
  is_favorite: async (env, rec) => {
    if (rec.origin === null) return false;
    const r = await env.cr.query("SELECT 1 FROM picking_type_favorite_user_rel WHERE picking_type_id = $1 AND user_id = $2", [rec.origin, env.uid]);
    return r.rows.length > 0;
  },
});

relatedSelections("stock.move", ["location_usage", "location_dest_usage"]);
relatedSelections("stock.move.line", ["location_usage", "location_dest_usage"]);

registerHooks("stock.picking.type", {
  // stock_picking_type.py:37-42, :163-165 `_get_lot_label_format_selection`
  selection: { lot_label_format: async () => [["4x12_lots", "4 x 12 - One per lot/SN"], ["4x12_units", "4 x 12 - One per unit"], ["zpl_lots", "ZPL Labels - One per lot/SN"], ["zpl_units", "ZPL Labels - One per unit"]] },
  // :419-426 `_compute_display_name`
  displayName: async (env, ids) => {
    const rows = (await env.cr.query<{ id: number; name: unknown; wh: string | null }>(
      "SELECT t.id, t.name, w.name AS wh FROM stock_picking_type t LEFT JOIN stock_warehouse w ON w.id = t.warehouse_id WHERE t.id = ANY($1::int[])", [ids])).rows;
    const lang = env.lang ?? "en_US";
    const tr = (v: unknown): string => (v && typeof v === "object" ? String((v as Record<string, unknown>)[lang] ?? (v as Record<string, unknown>)["en_US"] ?? "") : String(v ?? ""));
    return new Map(rows.map((r) => [r.id, r.wh ? `${r.wh}: ${tr(r.name)}` : tr(r.name)]));
  },
});

defineComputes("stock.picking.type", {
  // stock_picking_type.py:510-514
  show_picking_type: async (_env, rec) => ["incoming", "outgoing", "internal"].includes(String(await rec.get("code"))),
});

defineComputes("stock.move.line", {
  // stock_move_line.py:128-133
  picking_type_id: async (_env, rec) => {
    const picking = await rec.rel("picking_id");
    return picking ? (await picking.get("picking_type_id")) || false : false;
  },
});

defineComputes("stock.picking", {
  // stock_picking.py:448-457 `_has_scrap_move`
  has_scrap_move: async (env, rec) => {
    if (rec.origin === null) return false;
    const found = await env.model("stock.move").search(and([cond("picking_id", "in", [rec.origin]), cond("is_scrap", "=", true)]), { limit: 1 });
    return found.length > 0;
  },
});

for (const model of ["stock.lot", "stock.picking"]) registerActivityMixin(model);

relatedSelections("stock.move", ["has_tracking", "picking_code"]);
relatedSelections("stock.move.line", ["picking_code", "state", "tracking"]);

registerHooks("stock.move.line", {
  // stock_move_line.py:147-150 `_search_picking_type_id`
  search: {
    picking_type_id: async (_env, operator, value) => {
      if (isNegativeOperator(operator)) throw new NotPorted(`stock.move.line.picking_type_id ${operator} (NotImplemented)`);
      return cond("picking_id.picking_type_id", operator, value);
    },
  },
});

defineComputes("stock.picking.type", {
  // stock_picking_type.py:516-519
  show_return_picking_type: async (_env, rec) => ["incoming", "outgoing", "internal"].includes(String(await rec.get("code"))),
});

defineComputes("stock.picking", {
  // stock_picking.py:263-269
  is_date_editable: async (_env, rec) => {
    const state = await rec.get("state");
    if (state === "done" || state === "cancel") return !(await rec.get("is_locked"));
    return true;
  },
});

/** stock_move.py:820-826 `_compute_display_name`; product.product `code` (product_product.py:469-485) is the
 * default_code unless a supplier info of the context partner applies. */
registerHooks("stock.move", {
  displayName: async (env, ids) => {
    if (env.context["partner_id"]) throw new NotPorted("stock.move display_name with a context partner (product code from supplier info)");
    const rows = (await env.cr.query<{ id: number; origin: string | null; code: string | null; src: string | null; dest: string | null }>(`
      SELECT m.id, pk.origin, pp.default_code AS code, ls.name AS src, ld.name AS dest
        FROM stock_move m LEFT JOIN stock_picking pk ON pk.id = m.picking_id LEFT JOIN product_product pp ON pp.id = m.product_id
        LEFT JOIN stock_location ls ON ls.id = m.location_id LEFT JOIN stock_location ld ON ld.id = m.location_dest_id
       WHERE m.id = ANY($1::int[])`, [ids])).rows;
    return new Map(rows.map((r) => [r.id, `${r.origin ? `${r.origin}/` : ""}${r.code ? `${r.code}: ` : ""}${r.src ?? "False"}>${r.dest ?? "False"}`]));
  },
});

defineComputes("stock.picking", {
  // stock_picking.py:223-226
  has_tracking: async (_env, rec) => {
    for (const move of await rec.rels("move_ids")) {
      const product = await move.rel("product_id");
      if (product && ["lot", "serial"].includes(String(await product.get("tracking")))) return true;
    }
    return false;
  },
});

defineComputes("stock.move", {
  // stock_move.py:630-639 `_compute_lot_ids`: lot_id:array_agg of the move's lines with a lot and a quantity
  lot_ids: async (env, rec) => {
    if (rec.origin === null) return [];
    const lines = await env.model("stock.move.line").search(and([cond("move_id", "in", [rec.origin]), cond("lot_id", "!=", false), cond("quantity", "!=", 0)]), { order: "id" });
    if (!lines.length) return [];
    const rows = await env.model("stock.move.line").read(lines, ["lot_id"], "");
    const lots = [...new Set(rows.map((r) => Number(r["lot_id"])))];
    if (lots.length > 1) throw new NotPorted("stock.move.lot_ids with several lots (array_agg order)");
    return lots;
  },
});

defineComputes("stock.lot", {
  // stock_account/models/stock_lot.py:21-26 `_compute_value`: company_currency_id = env.company.currency_id
  company_currency_id: async (env) => {
    const company = await env.company();
    const r = (await env.cr.query<{ currency_id: number }>("SELECT currency_id FROM res_company WHERE id = $1", [company])).rows[0];
    return r?.currency_id ?? false;
  },
});
relatedSelections("stock.picking", ["picking_type_code"]);

/** stock_location.py:104-116 `_compute_display_name` (formatted with show_empty refuses: `is_empty`). */
registerHooks("stock.location", {
  displayName: async (env, ids) => {
    const formatted = !!env.context["formatted_display_name"];
    if (formatted && env.context["show_empty"]) throw new NotPorted("stock.location formatted_display_name with show_empty (is_empty)");
    const rows = (await env.cr.query<{ id: number; name: string | null; usage: string | null; parent: string | null; has_parent: boolean }>(`
      SELECT l.id, l.name, l.usage, p.complete_name AS parent, l.location_id IS NOT NULL AS has_parent
        FROM stock_location l LEFT JOIN stock_location p ON p.id = l.location_id WHERE l.id = ANY($1::int[])`, [ids])).rows;
    // super(): the _rec_name `name`; a parent outside a view location prefixes its complete_name
    return new Map(rows.map((r) => [r.id, r.has_parent && r.usage !== "view"
      ? (formatted ? `--${r.parent ?? "False"}/--${r.name ?? "False"}` : `${r.parent ?? "False"}/${r.name ?? "False"}`) : (r.name ?? "")]));
  },
});

defineComputes("stock.lot", {
  /**
   * stock_lot.py:165-170 `_compute_delivery_ids` through `_get_delivery_move_lines_by_lot` (:323-385) and
   * `_get_outgoing_domain` (:314-321): done outgoing lines of the lot. Lines produced from other lots (produce_line_ids,
   * the tree walk) refuse.
   */
  delivery_count: async (env, rec) => (await deliveryPickings(env, rec)).length,
  delivery_ids: async (env, rec) => {
    const pickings = await deliveryPickings(env, rec);
    if (pickings.length > 1) throw new NotPorted("stock.lot.delivery_ids with several pickings (Python set order)");
    return pickings;
  },
});

async function deliveryPickings(env: Environment, rec: Rec): Promise<number[]> {
  if (rec.origin === null) return [];
  const domain = and([cond("lot_id", "in", [rec.origin]), cond("state", "=", "done"),
    or([cond("picking_code", "=", "outgoing"), cond("move_id.picking_code", "=", "outgoing"), cond("produce_line_ids", "!=", false),
      cond("location_dest_usage", "in", ["customer", "transit"])])]);
  const lines = await env.model("stock.move.line").search(domain);
  if (!lines.length) return [];
  const rows = await env.model("stock.move.line").read(lines, ["produce_line_ids", "picking_id"], "");
  if (rows.some((r) => Array.isArray(r["produce_line_ids"]) && r["produce_line_ids"].length)) throw new NotPorted("stock.lot deliveries through produced lots");
  return [...new Set(rows.map((r) => r["picking_id"]).filter((p): p is number => typeof p === "number" && p > 0))];
}

defineComputes("stock.lot", {
  // stock_lot.py:156-164
  display_complete: async (env, rec) => Boolean(rec.id) || Boolean(env.context["display_complete"]),
});

defineComputes("stock.lot", {
  // stock_lot.py:185-190 `_compute_is_scrap`
  is_scrap: async (env, rec) => {
    if (rec.origin === null) return false;
    return (await env.model("stock.move.line").search(and([cond("lot_id", "in", [rec.origin]), cond("is_scrap", "=", true)]), { limit: 1 })).length > 0;
  },
});

/**
 * stock_lot.py:227-254 `_product_qty` for the default context (no location/warehouse/owner/package/owners/to_date/
 * strict): product.py:349-401 `_get_domain_locations` takes the view locations of the warehouses of env.companies and
 * `_get_domain_locations_new` their descendants; the lot's quants there, `quantity:sum`.
 */
defineComputes("stock.lot", {
  product_qty: async (env, rec) => {
    for (const k of ["location", "search_location", "warehouse_id", "search_warehouse", "owner_id", "package_id", "to_date", "owners", "strict"]) {
      if (env.context[k] !== undefined && env.context[k] !== false && env.context[k] !== null) throw new NotPorted(`stock.lot.product_qty with context ${k}`);
    }
    if (rec.origin === null) return 0;
    const companies = await env.companies();
    const whs = await env.model("stock.warehouse").search(cond("company_id", "in", [...companies]));
    if (!whs.length) return 0;
    const views = (await env.model("stock.warehouse").read(whs, ["view_location_id"], "")).map((r) => r["view_location_id"]).filter((v): v is number => typeof v === "number");
    if (!views.length) return 0;
    const quants = await env.model("stock.quant").search(and([cond("lot_id", "in", [rec.origin]), cond("location_id", "child_of", views)]));
    if (!quants.length) return 0;
    const rows = await env.model("stock.quant").read(quants, ["quantity"], "");
    let total = 0;
    for (const r of rows) total += Number((r["quantity"] as { float?: number })?.float ?? r["quantity"]);
    return total;
  },
});

/** stock_picking.py:252-257 `_compute_delay_alert_date`: max delay_alert_date of the picking's moves (read_group). */
async function pickingDelayAlert(env: Environment, rec: Rec): Promise<string | false> {
  if (rec.id === null) return false;
  return (await pickingDelayAlerts(env, [rec.id])).get(rec.id) ?? false;
}

/**
 * `_compute_delay_alert_date` of a recordset (stock_picking.py:252-257): one `_read_group` over all their moves
 * (`self.move_ids.ids`), the max date per picking.
 */
async function pickingDelayAlerts(env: Environment, ids: readonly number[]): Promise<Map<number, string | false>> {
  const out = new Map<number, string | false>(ids.map((id) => [id, false]));
  if (!ids.length) return out;
  const movesOf = await readFieldBatch(env, env.reg.model("stock.picking"), ids, "move_ids");
  const moves = [...new Set([...movesOf.values()].flatMap((v) => (Array.isArray(v) ? v.map(Number) : [])))];
  if (!moves.length) return out;
  const found = await env.model("stock.move").search(and([cond("id", "in", moves), cond("delay_alert_date", "!=", false)]));
  if (!found.length) return out;
  for (const r of await env.model("stock.move").read(found, ["delay_alert_date", "picking_id"], "")) {
    const picking = r["picking_id"];
    if (typeof picking !== "number" || !out.has(picking)) continue;
    const date = String(r["delay_alert_date"]);
    const max = out.get(picking);
    if (!max || date > max) out.set(picking, date);
  }
  return out;
}

/** stock_picking.py:314-328 `_compute_json_popover`: False without an alert; the popover payload refuses. */
async function pickingJsonPopovers(env: Environment, ids: readonly number[]): Promise<Map<number, unknown>> {
  const states = await readFieldBatch(env, env.reg.model("stock.picking"), ids, "state");
  const alerts = await pickingDelayAlerts(env, ids);
  const out = new Map<number, unknown>();
  for (const id of ids) {
    const state = states.get(id);
    if (state === "done" || state === "cancel" || !alerts.get(id)) out.set(id, false);
    else throw new NotPorted("stock.picking json_popover with a delay alert (format_datetime, _delay_alert_get_documents)");
  }
  return out;
}

// a record computes them alone (registerRecordCompute), a list for all its records at once, as Odoo's compute methods
// (each key registered once: compiled modules replace them by key)
registerRecordCompute("stock.picking", {
  delay_alert_date: async (env, rec) => pickingDelayAlert(env, rec),
  // stock_picking.py:314-328 `_compute_json_popover`: False without an alert; the popover payload refuses
  json_popover: async (env, rec) => {
    const state = await rec.get("state");
    if (state === "done" || state === "cancel" || !(await pickingDelayAlert(env, rec))) return false;
    throw new NotPorted("stock.picking json_popover with a delay alert (format_datetime, _delay_alert_get_documents)");
  },
});
registerHooks("stock.picking", { computed: { delay_alert_date: pickingDelayAlerts, json_popover: pickingJsonPopovers } });

defineComputes("stock.picking", {
  // stock_picking.py:539-550 `_compute_picking_warning_text`
  picking_warning_text: async (env, rec) => {
    if (!(await userHasGroup(env, "stock.group_warning_stock"))) return "";
    let text = "";
    const partner = await rec.rel("partner_id");
    if (partner) {
      const msg = await partner.get("picking_warn_msg");
      if (msg) text += `${String(msg)}\n`;
      const parent = await partner.rel("parent_id");
      const pmsg = parent ? await parent.get("picking_warn_msg") : false;
      if (pmsg) text += `${String(pmsg)}\n`;
    }
    return text;
  },
});

/**
 * sale_stock/models/stock.py:418-434 `_compute_sale_order_ids` on stock.lot: the readable sale orders of the lot's
 * done lines delivered to customer/transit locations (a Python set: several orders refuse for sale_order_ids order).
 */
async function lotSaleOrders(env: Environment, rec: Rec): Promise<number[]> {
  if (rec.origin === null) return [];
  const lines = await env.model("stock.move.line").search(and([cond("lot_id", "in", [rec.origin]), cond("state", "=", "done"),
    cond("move_id.sale_line_id.order_id", "!=", false), cond("move_id.picking_id.location_dest_id.usage", "in", ["customer", "transit"])]));
  const orders = new Set<number>();
  const def = env.reg.model("stock.move.line");
  for (const id of lines) {
    const move = await new DbRec(env, def, id).rel("move_id");
    const sol = move ? await move.rel("sale_line_id") : null;
    const so = sol ? await sol.get("order_id") : false;
    if (typeof so === "number" && so > 0 && (await filteredAccess(env, "sale.order", [so], "read")).has(so)) orders.add(so);
  }
  return [...orders];
}
defineComputes("stock.lot", {
  sale_order_count: async (env, rec) => (await lotSaleOrders(env, rec)).length,
  sale_order_ids: async (env, rec) => {
    const ids = await lotSaleOrders(env, rec);
    if (ids.length > 1) throw new NotPorted("stock.lot.sale_order_ids with several orders (Python set order)");
    return ids;
  },
});

// stock_picking_type.py:542-557 _onchange_sequence_code: another operation type of the company (or none) with the prefix
// and another sequence gives Odoo's warning (title `_("Warning")`, models.py:6508-6512)
registerOnchange("stock.picking.type", "_onchange_sequence_code", ["sequence_code"], async (env, rec) => {
  const code = await rec.get("sequence_code");
  if (!code) return;
  const company = await rec.get("company_id");
  let domain: Domain = and([cond("sequence_code", "=", code as string), or([cond("company_id", "=", typeof company === "number" ? company : false), cond("company_id", "=", false)])]);
  if (rec.origin !== null) domain = and([domain, cond("id", "!=", rec.origin)]);
  const [other] = await env.model("stock.picking.type").search(domain, { limit: 1 });
  if (other === undefined) return;
  const theirs = (await env.cr.query<{ s: number | null }>("SELECT sequence_id AS s FROM stock_picking_type WHERE id = $1", [other])).rows[0]?.s ?? null;
  const own = await rec.get("sequence_id");
  if (theirs === (typeof own === "number" ? own : null)) return;
  return {
    title: translate(env, "Warning"),
    message: translate(env, "This sequence prefix is already being used by another operation type. It is recommended that you select a unique prefix to avoid issues and/or repeated reference values or assign the existing reference sequence to this operation type."),
  };
});
