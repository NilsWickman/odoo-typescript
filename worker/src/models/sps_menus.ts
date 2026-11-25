/**
 * Buttons and small methods of the Sales, Purchase and Inventory configuration menus (stream CRM, admin map).
 */
import { NotPorted } from "../errors";
import { dictEntries, evalExpr, isDict } from "../pyexpr";
import { registerMethod } from "../http/methods";
import { and, cond, localMidnightToUtc, parseDomain, PyDate } from "../orm/domain";
import { envTz, hasGroup } from "../orm/env";
import { DbRec, NewRec, registerDefaults, registerOnchange, registerRecordCompute, type Rec } from "../orm/recompute";
import { hooksOf, registerHooks } from "../orm/hooks";
import type { Environment } from "../orm/types";
import { envFor } from "../web/common";
import { dbNow, todayInTz, translate } from "./util";
import { defineComputes, searchMethod } from "./tail_util";
import { searchRead } from "./res_lang";
import { moveForecast } from "./stock_forecast";
import "./account_journal_dashboard";

const idOf = (v: unknown): number | null => (typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : null);
const idsOf = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : []);

function one(ids: readonly number[] | null, what: string): number {
  if (!ids || ids.length !== 1) throw new NotPorted(`ensure_one on ${what}`);
  return ids[0]!;
}

// product/models/product_attribute.py:156-164
registerMethod("product.attribute", "action_open_product_template_attribute_lines", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = one(ids, "product.attribute");
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Products"),
    res_model: "product.template.attribute.line",
    view_mode: "list,form",
    domain: [["attribute_id", "=", id], ["product_tmpl_id.active", "=", true]],
  };
}, { apiModel: false });

/**
 * stock_warehouse.py:1146-1150 `_get_all_routes` with purchase_stock stock.py:130-133 (buy route) and
 * stock_location.py:600-614 `_get_routes_with_no_warehouse` (non push/pull rule actions: purchase_stock's 'buy').
 */
async function allRoutes(env: Environment, ids: readonly number[]): Promise<number[]> {
  const out: number[] = [];
  const add = (xs: Iterable<number>) => { for (const x of xs) if (!out.includes(x)) out.push(x); };
  const rows = await env.model("stock.warehouse").read([...ids], ["route_ids", "mto_pull_id", "buy_to_resupply", "buy_pull_id"], "");
  for (const r of rows) add(idsOf(r["route_ids"]));
  const pulls = rows.map((r) => idOf(r["mto_pull_id"])).filter((x): x is number => x !== null);
  if (pulls.length) add((await env.model("stock.rule").read(pulls, ["route_id"], "")).map((r) => idOf(r["route_id"])).filter((x): x is number => x !== null));
  const company = await env.company();
  const warehousesOfCompany = await env.model("stock.warehouse").search(parseDomain([["company_id", "=", company]]));
  add(await env.model("stock.route").search(parseDomain([
    ["warehouse_selectable", "=", true], ["rule_ids.action", "in", ["buy"]], ["company_id", "in", [false, company]],
    "|", ["warehouse_ids", "=", false], ["warehouse_ids", "not in", warehousesOfCompany]])));
  add(await env.withContext({ ...env.context, active_test: false }).model("stock.route").search(parseDomain([["supplied_wh_id", "in", [...ids]]]), { activeTest: false }));
  const buyPulls = rows.filter((r) => r["buy_to_resupply"]).map((r) => idOf(r["buy_pull_id"])).filter((x): x is number => x !== null);
  if (buyPulls.length) add((await env.model("stock.rule").read(buyPulls, ["route_id"], "")).map((r) => idOf(r["route_id"])).filter((x): x is number => x !== null));
  return out;
}

// stock_warehouse.py:1152-1163
registerMethod("stock.warehouse", "action_view_all_routes", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  return {
    name: translate(env, "Warehouse's Routes"),
    domain: [["id", "in", await allRoutes(env, ids ?? [])]],
    res_model: "stock.route",
    type: "ir.actions.act_window",
    view_id: false,
    view_mode: "list,form",
    limit: 20,
    context: { ...env.context, default_warehouse_selectable: true, default_warehouse_ids: [...(ids ?? [])] },
  };
}, { apiModel: false });

// stock_move_line.py:1055-1066 and stock_move.py:2841-2858 (the picking when readable, else the record itself)
registerMethod("stock.move.line", "action_open_reference", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = one(ids, "stock.move.line");
  const move = idOf((await env.model("stock.move.line").read([id], ["move_id"], ""))[0]?.["move_id"]);
  if (move !== null) {
    const picking = idOf((await env.model("stock.move").read([move], ["picking_id"], ""))[0]?.["picking_id"]);
    const domain = await env.model("stock.picking").accessDomain("read");
    if (picking !== null && (domain === null || domain.kind !== "false")) {
      return { res_model: "stock.picking", type: "ir.actions.act_window", views: [[false, "form"]], res_id: picking };
    }
  }
  return { res_model: "stock.move.line", type: "ir.actions.act_window", views: [[false, "form"]], res_id: id };
}, { apiModel: false });

// purchase_stock/models/stock.py:83-86 _compute_buy_to_resupply
defineComputes("stock.warehouse", {
  buy_to_resupply: async (_env, rec) => {
    const pull = await rec.rel("buy_pull_id");
    const route = pull ? await pull.rel("route_id") : null;
    if (!route) return false;
    const warehouses = (await route.rels("warehouse_ids")).map((w) => w.id);
    return warehouses.includes(rec.id) || (Boolean(await route.get("warehouse_selectable")) && !warehouses.length);
  },
});

// ---------------------------------------------------------------------------------------------------------------
// stock.picking.type dashboard (stock/models/stock_picking_type.py:370-408 `_compute_picking_count`, :428-434
// `_compute_open_button_style`, :521-540 and :639-690 the kanban graph, stock_picking.py:1630-1670
// `calculate_date_category`); stock_picking_batch is not installed: count_picking_batch is 0, the button primary
// ---------------------------------------------------------------------------------------------------------------

const ACTIVE = ["assigned", "waiting", "confirmed"];

async function pickingsByType(env: Environment, typeIds: readonly number[], extra: unknown[]): Promise<Map<number, number>> {
  const ids = await env.model("stock.picking").search(parseDomain([["state", "not in", ["done", "cancel"]], ["picking_type_id", "in", [...typeIds]], ...extra]));
  const out = new Map<number, number>();
  if (!ids.length) return out;
  for (const r of await env.model("stock.picking").read(ids, ["picking_type_id"], "")) {
    const t = idOf(r["picking_type_id"]);
    if (t !== null) out.set(t, (out.get(t) ?? 0) + 1);
  }
  return out;
}

const countField = (extra: (env: Environment) => Promise<unknown[]>) => async (env: Environment, ids: readonly number[]): Promise<Map<number, unknown>> => {
  const counts = await pickingsByType(env, ids, await extra(env));
  return new Map(ids.map((id) => [id, counts.get(id) ?? 0]));
};

async function graphs(env: Environment, ids: readonly number[]): Promise<Map<number, unknown>> {
  const pickings = await env.model("stock.picking").search(parseDomain([["picking_type_id", "in", [...ids]], ["state", "in", ACTIVE]]));
  const dates = new Map<number, (string | null)[]>(ids.map((id) => [id, []]));
  if (pickings.length) {
    for (const r of await env.model("stock.picking").read(pickings, ["picking_type_id", "scheduled_date"], "")) {
      const t = idOf(r["picking_type_id"]);
      if (t !== null && dates.has(t)) dates.get(t)!.push(typeof r["scheduled_date"] === "string" ? r["scheduled_date"] : null);
    }
  }
  const tz = await envTz(env);
  const today = todayInTz(await dbNow(env), tz);
  const startToday = localMidnightToUtc(new PyDate(Date.parse(`${today}T00:00:00Z`)), tz).ms;
  const DAY = 86_400_000;
  const keys = ["before", "yesterday", "today", "day_1", "day_2", "after"] as const;
  const labels: Record<(typeof keys)[number], [string, string]> = {
    before: ["Before", "past"], yesterday: ["Yesterday", "past"], today: ["Today", "present"],
    day_1: ["Tomorrow", "future"], day_2: ["The day after tomorrow", "future"], after: ["After", "future"],
  };
  const out = new Map<number, unknown>();
  for (const id of ids) {
    const totals: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
    for (const d of dates.get(id) ?? []) {
      if (!d) continue;
      const t = Date.parse(d.replace(" ", "T") + "Z");
      const k = t < startToday - DAY ? "before" : t < startToday ? "yesterday" : t < startToday + DAY ? "today"
        : t < startToday + 2 * DAY ? "day_1" : t < startToday + 3 * DAY ? "day_2" : "after";
      totals[k]! += 1;
    }
    const empty = keys.every((k) => totals[k] === 0);
    const graph = [{
      key: translate(env, empty ? "Sample data" : "Transfers"),
      picking_type_id: empty ? null : id,
      values: keys.map((k) => ({ label: translate(env, labels[k][0]), type: empty ? "sample" : labels[k][1], value: totals[k] })),
    }];
    out.set(id, pyJsonDumps(graph));
  }
  return out;
}

/** `json.dumps` with Python's default separators (", " and ": "). */
function pyJsonDumps(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(pyJsonDumps).join(", ")}]`;
  if (typeof v === "object") return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${JSON.stringify(k)}: ${pyJsonDumps(x)}`).join(", ")}}`;
  return JSON.stringify(v).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

registerHooks("stock.picking.type", {
  computed: {
    count_picking_draft: countField(async () => [["state", "=", "draft"]]),
    count_picking_waiting: countField(async () => [["state", "in", ["confirmed", "waiting"]]]),
    count_picking_ready: countField(async () => [["state", "=", "assigned"]]),
    count_picking: countField(async () => [["state", "in", ACTIVE]]),
    // `fields.Date.today()`: the server's (UTC) date
    count_picking_late: countField(async (env) => [["state", "in", ACTIVE], "|",
      ["scheduled_date", "<", (await dbNow(env)).toISOString().slice(0, 10)], ["has_deadline_issue", "=", true]]),
    count_picking_backorders: countField(async () => [["backorder_id", "!=", false], ["state", "in", ACTIVE]]),
    count_picking_batch: async (_env, ids) => new Map(ids.map((id) => [id, 0])),
    open_button_style: async (_env, ids) => new Map(ids.map((id) => [id, "primary"])),
    kanban_dashboard_graph: graphs,
  },
});

// sale/models/sale_order_line.py:198 `selected_combo_items = fields.Char(store=False)`: no compute, nothing in cache
// on read -> False
registerHooks("sale.order.line", { computed: { selected_combo_items: async (_env, ids) => new Map(ids.map((id) => [id, false])) } });

// sale_management/models/sale_order_template.py:338-352 get_section_templates (`_check_company_domain`, models.py:3339)
registerMethod("sale.order.template", "get_section_templates", async (env0, _ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const company = args[0] ?? kwargs["company_id"];
  const companies = typeof company === "number" && company ? [company, false] : [false];
  const domain = companies.length > 1
    ? [["template_type", "=", "section"], ["user_has_access", "=", true], ["company_id", "in", companies]]
    : [["template_type", "=", "section"], ["user_has_access", "=", true], ["company_id", "=", false]];
  const ids = await env.model("sale.order.template").search(parseDomain(domain));
  if (!ids.length) return [];
  return env.model("sale.order.template").read(ids, ["id", "name", "create_uid"], "");
}, { apiModel: true });

// ---------------------------------------------------------------------------------------------------------------
// sale.order.line fields of the order form not computed elsewhere
// ---------------------------------------------------------------------------------------------------------------

/** sale_order.py:2789-2795 `_get_lang` of the line's order. */
async function orderLang(env: Environment, rec: Rec): Promise<string> {
  const order = await rec.rel("order_id");
  const partner = order ? await order.rel("partner_id") : null;
  if (partner) {
    const lang = await partner.get("lang");
    // res_partner.py `_compute_is_public`: one of its users (active or not) is in base.group_public
    const isPublic = (await env.cr.query(
      `SELECT 1 FROM res_users u JOIN res_groups_users_rel r ON r.uid = u.id JOIN ir_model_data d ON d.res_id = r.gid
        AND d.model = 'res.groups' AND d.module = 'base' AND d.name = 'group_public' WHERE u.partner_id = $1 LIMIT 1`, [partner.id])).rows.length > 0;
    if (lang && !isPublic) return String(lang);
  }
  return env.lang ?? "en_US";
}

defineComputes("sale.order.line", {
  // sale_order_line.py:650-664 _compute_label
  label: async (env, rec) => {
    const name = await rec.get("name");
    const product = idOf(await rec.get("product_id"));
    if (product === null) return name ?? null;
    const lang = await orderLang(env, rec);
    const display = (await env.withContext({ ...env.context, lang }).model("product.product").displayName([product])).get(product) ?? "";
    if (!name) return display;
    if (String(name).split(/\r\n|\n|\r/)[0] === display) return name;
    return `${display}\n${String(name)}`;
  },
  // :1147-1153
  qty_delivered_percent: async (_env, rec) => {
    const qty = Number(await rec.get("product_uom_qty") ?? 0);
    return qty ? Number(await rec.get("qty_delivered") ?? 0) / qty : 1;
  },
  // :693-699
  sale_line_warn_msg: async (env, rec) => {
    if (!(await hasGroup(env, "sale.group_warning_sale"))) return "";
    const product = await rec.rel("product_id");
    return product ? (await product.get("sale_line_warn_msg")) ?? null : null;
  },
  // sale_stock sale_order_line.py:48-58 _compute_qty_to_deliver (both fields)
  qty_to_deliver: async (_env, rec) => Number(await rec.get("product_uom_qty") ?? 0) - Number(await rec.get("qty_delivered") ?? 0),
  display_qty_widget: async (_env, rec) => displayQtyWidget(rec),
  // :150-178 _compute_is_mto: False without the widget
  is_mto: async (env, rec) => {
    if (!(await displayQtyWidget(rec))) return false;
    const product = await rec.rel("product_id");
    let routes = (await rec.rels("route_ids")).map((r) => r.id);
    if (!routes.length && product) {
      routes = (await product.rels("route_ids")).map((r) => r.id);
      const categ = await product.rel("categ_id");
      if (categ) routes.push(...(await categ.rels("total_route_ids")).map((r) => r.id));
    }
    // the warehouse's MTO rule route (sudo), else stock.route_warehouse0_mto (stock_warehouse.py:388-402, create=False)
    const wh = await rec.rel("warehouse_id");
    const pull = wh ? await new DbRec(env.sudo(), wh.def, wh.id!).rel("mto_pull_id") : null;
    let mto: number | null = pull ? idOf(await pull.get("route_id")) : null;
    if (mto === null) {
      const ref = (await env.cr.query<{ id: number; company_id: number | null }>(
        `SELECT r.id, r.company_id FROM ir_model_data d JOIN stock_route r ON r.id = d.res_id
          WHERE d.module = 'stock' AND d.name = 'route_warehouse0_mto' AND d.model = 'stock.route'`)).rows[0];
      const company = idOf(await rec.get("company_id")) ?? await env.company();
      if (ref && (ref.company_id === null || ref.company_id === company)) mto = ref.id;
      else throw new NotPorted("sale.order.line.is_mto with the MTO route looked up by name");
    }
    return mto !== null && routes.includes(mto);
  },
});

async function displayQtyWidget(rec: Rec): Promise<boolean> {
  const state = String(await rec.get("state"));
  const toDeliver = Number(await rec.get("product_uom_qty") ?? 0) - Number(await rec.get("qty_delivered") ?? 0);
  if (!["draft", "sent", "sale"].includes(state) || !(await rec.get("is_storable")) || !(await rec.get("product_uom_id")) || !(toDeliver > 0)) return false;
  if (state !== "sale") return true;
  const moves = await rec.rels("move_ids");
  for (const m of moves) if (!["done", "cancel"].includes(String(await m.get("state")))) return true;
  return false;
}

type QtyAtDate = Record<"free_qty_today" | "qty_available_today" | "virtual_available_at_date" | "scheduled_date" | "forecast_expected_date", unknown>;
const QTY_FIELDS = ["free_qty_today", "qty_available_today", "virtual_available_at_date", "scheduled_date", "forecast_expected_date"] as const;
const REMAINING: QtyAtDate = { free_qty_today: null, qty_available_today: null, virtual_available_at_date: null, scheduled_date: null, forecast_expected_date: null };

const fmt = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/** sale_order_line.py:2007-2013 `_expected_date` (as epoch ms). */
async function expectedDate(env: Environment, rec: Rec): Promise<number> {
  const order = await rec.rel("order_id");
  const dateOrder = order ? await order.get("date_order") : null;
  const base = (await rec.get("state")) === "sale" && typeof dateOrder === "string" ? Date.parse(dateOrder.replace(" ", "T") + "Z") : (await dbNow(env)).getTime();
  return base + Number(await rec.get("customer_lead") ?? 0) * 86_400_000;
}

/**
 * sale_stock sale_order_line.py:73-147 `_compute_qty_at_date` for `lines` in recordset order. Confirmed lines take
 * their moves' forecast (src/models/stock_forecast.ts; no origin moves); quotation lines read the product quantities at the scheduled date in their warehouse, minus the quantities
 * of the previous lines of the same product.
 */
async function qtyAtDate(env: Environment, lines: readonly Rec[]): Promise<QtyAtDate[]> {
  const out: QtyAtDate[] = lines.map(() => ({ ...REMAINING }));
  const groups = new Map<string, { wh: number | null; date: number; idx: number[] }>();
  for (const [i, line] of lines.entries()) {
    const state = String(await line.get("state"));
    if (state === "sale") {
      if (!(await displayQtyWidget(line))) continue;
      const product = idOf(await line.get("product_id"));
      const uom = idOf(await line.get("product_uom_id"));
      let qty = 0, free = 0;
      let expected: string | false = false;
      for (const m of await line.rels("move_ids")) {
        if (idOf(await m.get("product_id")) !== product || ["cancel", "done"].includes(String(await m.get("state")))) continue;
        if ((await m.rels("move_orig_ids")).length) throw new NotPorted("sale.order.line quantities through origin moves (_rollup_move_origs)");
        const productUom = idOf(await (await m.rel("product_id"))?.get("uom_id"));
        if (idOf(await m.get("uom_id")) !== uom || productUom !== uom) throw new NotPorted("sale.order.line quantities across units of measure");
        qty += Number(await m.get("quantity") ?? 0);
        const f = (await moveForecast(env, [m.id!])).get(m.id!)!;
        free += f.availability;
        if (f.expected && (!expected || f.expected > expected)) expected = f.expected;
      }
      const order = await line.rel("order_id");
      const commitment = order ? await order.get("commitment_date") : null;
      out[i] = { forecast_expected_date: expected || null, qty_available_today: qty, free_qty_today: free, scheduled_date: typeof commitment === "string" ? commitment : fmt(await expectedDate(env, line)), virtual_available_at_date: null };
      continue;
    }
    if (!["draft", "sent"].includes(state) || !(await line.get("product_id")) || !(await displayQtyWidget(line))) continue;
    const order = await line.rel("order_id");
    const commitment = order ? await order.get("commitment_date") : null;
    const date = typeof commitment === "string" ? Date.parse(commitment.replace(" ", "T") + "Z") : await expectedDate(env, line);
    const wh = idOf(await line.get("warehouse_id"));
    const key = `${wh}|${date}`;
    const g = groups.get(key) ?? { wh, date, idx: [] };
    g.idx.push(i);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const products = [...new Set(await Promise.all(g.idx.map(async (i) => idOf(await lines[i]!.get("product_id"))!)))];
    const qenv = env.sudo().withContext({ ...env.context, to_date: fmt(g.date), warehouse_id: g.wh ?? false });
    const rows = await qenv.model("product.product").read(products, ["qty_available", "free_qty", "virtual_available", "uom_id"], "");
    const byId = new Map(rows.map((r) => [Number(r["id"]), r]));
    const processed = new Map<number, number>();
    for (const i of g.idx) {
      const line = lines[i]!;
      const product = idOf(await line.get("product_id"))!;
      const r = byId.get(product)!;
      if (idOf(await line.get("product_uom_id")) !== idOf(r["uom_id"])) throw new NotPorted("sale.order.line quantities at date across units of measure");
      const done = processed.get(product) ?? 0;
      out[i] = {
        scheduled_date: fmt(g.date), forecast_expected_date: null,
        qty_available_today: num(r["qty_available"]) - done, free_qty_today: num(r["free_qty"]) - done,
        virtual_available_at_date: num(r["virtual_available"]) - done,
      };
      processed.set(product, done + Number(await line.get("product_uom_qty") ?? 0));
    }
  }
  return out;
}

const num = (v: unknown): number => (typeof v === "number" ? v : v && typeof v === "object" && "float" in v ? Number((v as { float: number }).float) : 0);

registerHooks("sale.order.line", {
  computed: Object.fromEntries(QTY_FIELDS.map((f) => [f, async (env: Environment, ids: readonly number[]) => {
    const def = env.reg.model("sale.order.line");
    const values = await qtyAtDate(env, ids.map((id) => new DbRec(env, def, id)));
    return new Map(ids.map((id, i) => [id, values[i]![f]]));
  }])),
});
registerRecordCompute("sale.order.line", Object.fromEntries(QTY_FIELDS.map((f) => [f, async (env: Environment, rec: Rec) => (await qtyAtDate(env, [rec]))[0]![f]])));

// sale_pdf_quote_builder sale_order_line.py:38-65 (compute_sudo): the PDF documents of the product, then of the
// template, each by sequence (the `_read_group` groups ordered by res_model, sequence; ARRAY_AGG ordered by id)
registerHooks("sale.order.line", {
  computed: {
    available_product_document_ids: async (env, ids) => {
      const lines = await env.sudo().model("sale.order.line").read([...ids], ["product_id", "product_template_id"], "");
      const products = lines.map((l) => idOf(l["product_id"])).filter((x): x is number => x !== null);
      const templates = lines.map((l) => idOf(l["product_template_id"])).filter((x): x is number => x !== null);
      const docs = (await env.cr.query<{ id: number; res_model: string; res_id: number }>(
        `SELECT d.id, a.res_model, a.res_id FROM product_document d JOIN ir_attachment a ON a.id = d.ir_attachment_id
          WHERE d.active AND a.type = 'binary' AND a.file_size > 0 AND a.mimetype = 'application/pdf'
            AND ((a.res_model = 'product.product' AND a.res_id = ANY($1::int[])) OR (a.res_model = 'product.template' AND a.res_id = ANY($2::int[])))
          ORDER BY a.res_model, d.sequence, d.id`, [products, templates])).rows;
      const by = new Map<string, number[]>();
      for (const d of docs) by.set(`${d.res_model},${d.res_id}`, [...(by.get(`${d.res_model},${d.res_id}`) ?? []), d.id]);
      return new Map(lines.map((l) => [Number(l["id"]), [
        ...(by.get(`product.product,${idOf(l["product_id"])}`) ?? []), ...(by.get(`product.template,${idOf(l["product_template_id"])}`) ?? []),
      ]]));
    },
  },
});

// purchase_stock/models/purchase_order.py:16-18 `_default_picking_type`, :378-384 `_get_picking_type`
registerDefaults("purchase.order", {
  picking_type_id: async (env) => {
    const company = typeof env.context["company_id"] === "number" && env.context["company_id"] ? env.context["company_id"] as number : await env.company();
    const model = env.model("stock.picking.type");
    let found = await model.search(parseDomain([["code", "=", "incoming"], ["warehouse_id.company_id", "=", company]]));
    if (!found.length) found = await model.search(parseDomain([["code", "=", "incoming"], ["warehouse_id", "=", false]]));
    if (!found.length) found = await env.withContext({ ...env.context, active_test: false }).model("stock.picking.type").search(parseDomain([["code", "=", "incoming"], ["warehouse_id", "=", false]]), { activeTest: false });
    return found[0] ?? false;
  },
});

// product_product.py:1018-1023 `_search`: the context's search_default_categ_id adds `categ_id child_of` it; the rest
// of search, search_count and search_read is the plain ORM's (models.py:5232), as gen/orm_methods.py finds no other
// override on product.product
registerHooks("product.product", {
  searchOverride: async (env, domain, next) => {
    const categ = env.context["search_default_categ_id"];
    return next(categ ? and([domain, cond("categ_id", "child_of", categ)]) : domain);
  },
});
registerMethod("product.product", "search_read", async (env0, _ids, args, kwargs0, name) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  return searchRead(env, name, args, kwargs);
}, { apiModel: true, readonly: true });
registerMethod("product.product", "search", async (env0, _ids, args, kwargs0, name) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const { search } = await import("../web/read_methods");
  return search(env, name, args, kwargs);
}, { apiModel: true, readonly: true });
registerMethod("product.product", "search_count", async (env0, _ids, args, kwargs0, name) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const { searchCount } = await import("../web/read_methods");
  return searchCount(env, name, args, kwargs);
}, { apiModel: true, readonly: true });

// stock_picking_type.py:342-346 _search_is_favorite (operator 'in' only; NotImplemented otherwise)
registerHooks("stock.picking.type", {
  search: {
    is_favorite: searchMethod("stock.picking.type", "is_favorite", async (env, operator) =>
      operator === "in" ? parseDomain([["favorite_user_ids", "in", [env.uid]]]) : null),
  },
});

// stock_move_line.py:92 `quant_id = fields.Many2one(store=False)`: a dummy field without compute, False on read
registerHooks("stock.move.line", { computed: { quant_id: async (_env, ids) => new Map(ids.map((id) => [id, false])) } });

// stock_account/models/stock_lot.py:21-45 _compute_value (compute_sudo): lots that are not valuated per lot are worth
// 0; valuation per lot (standard/average/FIFO runs) is not ported
defineComputes("stock.lot", {
  company_currency_id: async (env) => (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [await env.company()])).rows[0]?.c ?? null,
  total_value: async (_env, rec) => {
    // a lot-valuated lot without quantity is worth 0 too (`uom_id.is_zero(qty_valued)`)
    if (await rec.get("lot_valuated") && Number(await rec.get("product_qty") ?? 0) !== 0) throw new NotPorted("stock.lot.total_value of a lot-valuated product in stock");
    return 0;
  },
  avg_cost: async (_env, rec) => {
    // a lot-valuated lot without quantity is worth 0 too (`uom_id.is_zero(qty_valued)`)
    if (await rec.get("lot_valuated") && Number(await rec.get("product_qty") ?? 0) !== 0) throw new NotPorted("stock.lot.avg_cost of a lot-valuated product in stock");
    return 0;
  },
});

// stock/models/stock_lot.py:148-154 _compute_company_id
registerRecordCompute("stock.lot", {
  // stock_lot.py:67-70 _compute_name: kept when set, else the product's lot sequence
  name: async (_env, rec) => {
    const current = await rec.prev("name");
    if (current) return current;
    const product = await rec.rel("product_id");
    if (product && (await product.get("lot_sequence_id"))) throw new NotPorted("stock.lot.name from the product's lot sequence (next_by_id)");
    return null;
  },
  company_id: async (env, rec) => {
    const product = await rec.rel("product_id");
    const pcompany = product ? idOf(await product.get("company_id")) : null;
    if (pcompany !== null) {
      const company = await env.company();
      const children = (await env.cr.query<{ id: number }>(
        "SELECT c.id FROM res_company c JOIN res_company p ON p.id = $1 WHERE c.parent_path LIKE p.parent_path || '%'", [pcompany])).rows.map((r) => r.id);
      if (children.includes(company) && !(await env.companies()).includes(pcompany)) return company;
    }
    return pcompany;
  },
});

// stock_picking_type.py:419-426 _compute_display_name and :485-491 _compute_print_label, on new records (the
// database records' display_name is the hook of config_write.ts)
registerRecordCompute("stock.picking.type", {
  // :502-509 _compute_warehouse_id: kept when set, else the company's first warehouse
  warehouse_id: async (env, rec) => {
    const current = idOf(await rec.prev("warehouse_id"));
    if (current !== null) return current;
    const company = idOf(await rec.get("company_id"));
    if (company === null) return current;
    return (await env.model("stock.warehouse").search(parseDomain([["company_id", "=", company]]), { limit: 1 }))[0] ?? null;
  },
  display_name: async (_env, rec) => {
    const wh = await rec.rel("warehouse_id");
    const name = await rec.get("name");
    const shown = name === null || name === undefined || name === false ? "False" : String(name);
    return wh ? `${String(await wh.get("name") ?? "False")}: ${shown}` : (name ?? null);
  },
  print_label: async (_env, rec) => {
    const code = await rec.get("code");
    if (code === "incoming" || code === "internal") return false;
    if (code === "outgoing") return true;
    return rec.prev("print_label");
  },
});

// stock_warehouse.py:31-33 _default_name
registerDefaults("stock.warehouse", {
  name: async (env) => {
    const company = await env.company();
    const count = (await env.withContext({ ...env.context, active_test: false }).model("stock.warehouse").search(parseDomain([["company_id", "=", company]]), { activeTest: false })).length;
    const name = String((await env.cr.query<{ name: string }>("SELECT name FROM res_company WHERE id = $1", [company])).rows[0]?.name ?? "");
    return count ? `${name} - warehouse # ${count + 1}` : name;
  },
});

// product/models/product_supplierinfo.py:77-87: the template follows the variant; `self.env.get('default_product_id')`
// looks up a model (never a context key), so product_id keeps its value
registerRecordCompute("product.supplierinfo", {
  product_tmpl_id: async (_env, rec) => {
    const product = await rec.rel("product_id");
    return product ? idOf(await product.get("product_tmpl_id")) : idOf(await rec.prev("product_tmpl_id"));
  },
  product_id: async (_env, rec) => idOf(await rec.prev("product_id")),
  // :60-64 _compute_uom_id: kept when set, else the variant's (or template's) unit
  uom_id: async (_env, rec) => {
    const current = idOf(await rec.prev("uom_id"));
    if (current !== null) return current;
    const product = (await rec.rel("product_id")) ?? (await rec.rel("product_tmpl_id"));
    return product ? idOf(await product.get("uom_id")) : null;
  },
});
// :89-93 _onchange_product_tmpl_id
registerOnchange("product.supplierinfo", "_onchange_product_tmpl_id", ["product_tmpl_id"], async (_env, rec) => {
  const product = await rec.rel("product_id");
  if (!product) return;
  const tmpl = idOf(await rec.get("product_tmpl_id"));
  if (idOf(await product.get("product_tmpl_id")) !== tmpl) await rec.set("product_id", null);
});
// purchase product.py:279-281 `_onchange_partner_id`: the vendor's purchase currency (company-dependent, the
// environment's company), else the company's currency
registerOnchange("product.supplierinfo", "_onchange_partner_id", ["partner_id"], async (env, rec) => {
  const partner = await rec.rel("partner_id");
  let currency = partner ? idOf(await partner.get("property_purchase_currency_id")) : null;
  if (currency === null) {
    currency = (await env.cr.query<{ c: number | null }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [await env.company()])).rows[0]?.c ?? null;
  }
  await rec.set("currency_id", currency ?? false);
});

// base/models/res_company.py:188-192 _compute_parent_ids (compute_sudo, active_test=False): the companies of the
// parent_path, root first
async function companyPath(env: Environment, rec: Rec): Promise<number[]> {
  const path = rec.id === null ? null : (await env.cr.query<{ p: string | null }>("SELECT parent_path AS p FROM res_company WHERE id = $1", [rec.id])).rows[0]?.p ?? null;
  if (!path) return rec.id === null ? [] : [rec.id];
  return path.split("/").filter(Boolean).map(Number);
}
defineComputes("res.company", {
  parent_ids: async (env, rec) => companyPath(env, rec),
  root_id: async (env, rec) => (await companyPath(env, rec))[0] ?? null,
});

// base/models/res_partner_bank.py:177-180 _compute_color
defineComputes("res.partner.bank", { color: async (_env, rec) => ((await rec.get("allow_out_payment")) ? 10 : 1) });

// sale_management/models/sale_order_template_line.py:305-318 _compute_label (product display name in the env lang)
defineComputes("sale.order.template.line", {
  label: async (env, rec) => {
    const name = await rec.get("name");
    const product = idOf(await rec.get("product_id"));
    if (product === null) return name ?? null;
    const display = (await env.model("product.product").displayName([product])).get(product) ?? "";
    if (!name) return display;
    if (String(name).split(/\r\n|\n|\r/)[0] === display) return name;
    return `${display}\n${String(name)}`;
  },
});

// sale_order_template_line.py on new lines: :218-245 attribute values (cleared without product; the validation
// against the template's valid values is not ported), :251-259 unit, :169-173 name (the default description without
// attribute values), :288-303 section quantity and unit, :261-280 parent section
async function keptX2many(rec: Rec, field: string): Promise<unknown> {
  const product = await rec.rel("product_id");
  if (!product) return [];
  const current = await rec.prev(field);
  if (!Array.isArray(current) || !current.length) return current ?? [];
  // the values of the template's lines that have values (valid_product_template_attribute_line_ids)
  const valid = new Set((await rec.env.cr.query<{ id: number }>(
    `SELECT v.id FROM product_template_attribute_value v JOIN product_template_attribute_line l ON l.id = v.attribute_line_id
      WHERE l.product_tmpl_id = $1 AND v.ptav_active`, [idOf(await product.get("product_tmpl_id"))])).rows.map((r) => r.id));
  const kept: unknown[] = [];
  for (const item of current) {
    if (field === "product_no_variant_attribute_value_ids") {
      if (typeof item !== "number") throw new NotPorted(`${rec.def.name}.${field} with a new value`);
      if (valid.has(item)) kept.push(item);
    } else if (item instanceof NewRec) {
      if (valid.has(idOf(await item.get("custom_product_template_attribute_value_id")) ?? 0)) kept.push(item);
    } else throw new NotPorted(`${rec.def.name}.${field} with stored custom values`);
  }
  return kept;
}
// sale/models/sale_order_line.py:493-519 the same computes on new order lines
registerRecordCompute("sale.order.line", {
  product_custom_attribute_value_ids: async (_env, rec) => keptX2many(rec, "product_custom_attribute_value_ids"),
  product_no_variant_attribute_value_ids: async (_env, rec) => keptX2many(rec, "product_no_variant_attribute_value_ids"),
});
registerRecordCompute("sale.order.template.line", {
  product_custom_attribute_value_ids: async (_env, rec) => keptX2many(rec, "product_custom_attribute_value_ids"),
  product_no_variant_attribute_value_ids: async (_env, rec) => keptX2many(rec, "product_no_variant_attribute_value_ids"),
  product_uom_id: async (env, rec) => {
    if (await rec.get("display_type")) return null;
    const product = await rec.rel("product_id");
    if (product) return idOf(await product.get("uom_id"));
    // product.template `_default_uom_id`: uom.product_uom_unit
    return (await env.cr.query<{ id: number }>("SELECT res_id AS id FROM ir_model_data WHERE module = 'uom' AND name = 'product_uom_unit'")).rows[0]?.id ?? null;
  },
  name: async (_env, rec) => {
    const product = await rec.rel("product_id");
    if (!product) return rec.prev("name");
    const custom = await rec.get("product_custom_attribute_value_ids");
    const noVariant = await rec.get("product_no_variant_attribute_value_ids");
    if ((Array.isArray(custom) && custom.length) || (Array.isArray(noVariant) && noVariant.length)) throw new NotPorted("sale.order.template.line.name with attribute values");
    const description = (await product.get("description_sale")) || "";
    return String(description).replace(/^\n/, "") || "";
  },
  section_qty: async (_env, rec) => (["line_section", "line_subsection"].includes(String(await rec.get("display_type"))) ? 1 : null),
  section_uom_id: async (env, rec) => {
    if (!["line_section", "line_subsection"].includes(String(await rec.get("display_type")))) return null;
    return (await env.cr.query<{ id: number }>("SELECT res_id AS id FROM ir_model_data WHERE module = 'uom' AND name = 'product_uom_unit'")).rows[0]?.id ?? null;
  },
});

// purchase/models/purchase_order.py on new orders: :71-78 _compute_invoice (the bills of the lines),
// :520-527 _compute_currency_id (the vendor's purchase currency in the order's company, else the company's)
/** `partner.with_company(company)[field]` (company-dependent partner fields read in the order's company). */
async function partnerInCompany(env: Environment, rec: Rec, field: string): Promise<unknown> {
  const partner = idOf(await rec.get("partner_id"));
  if (partner === null) return null;
  const company = idOf(await rec.get("company_id"));
  const cenv = company === null ? env : env.withContext({ ...env.context, allowed_company_ids: [company, ...((env.context.allowed_company_ids as number[] | undefined) ?? []).filter((c) => c !== company)] });
  return (await cenv.model("res.partner").read([partner], [field], ""))[0]?.[field] ?? null;
}

registerRecordCompute("purchase.order", {
  // :258-266 the earliest planned date of the product lines
  date_planned: async (_env, rec) => {
    let min: string | null = null;
    for (const line of await rec.rels("order_line")) {
      if (await line.get("display_type")) continue;
      const d = await line.get("date_planned");
      if (typeof d === "string" && (min === null || d < min)) min = d;
    }
    return min;
  },
  // :292-296 _compute_receipt_reminder_email (both fields)
  receipt_reminder_email: async (env, rec) => partnerInCompany(env, rec, "receipt_reminder_email"),
  reminder_date_before_receipt: async (env, rec) => partnerInCompany(env, rec, "reminder_date_before_receipt"),
  invoice_ids: async (_env, rec) => {
    const out: number[] = [];
    for (const line of await rec.rels("order_line")) {
      for (const il of await line.rels("invoice_lines")) {
        const move = idOf(await il.get("move_id"));
        if (move !== null && !out.includes(move)) out.push(move);
      }
    }
    return out;
  },
  currency_id: async (env, rec) => {
    const company = idOf(await rec.get("company_id"));
    const companyCurrency = company === null ? null : (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [company])).rows[0]?.c ?? null;
    const partner = idOf(await rec.get("partner_id"));
    if (partner === null) return companyCurrency;
    const cenv = company === null ? env : env.withContext({ ...env.context, allowed_company_ids: [company, ...((env.context.allowed_company_ids as number[] | undefined) ?? []).filter((c) => c !== company)] });
    const value = idOf((await cenv.model("res.partner").read([partner], ["property_purchase_currency_id"], ""))[0]?.["property_purchase_currency_id"]);
    return value ?? companyCurrency;
  },
});

// stock/models/stock_picking.py:117-121 user_id's callable domain
registerHooks("stock.picking", {
  descriptionDomain: {
    ...hooksOf("stock.picking").descriptionDomain,
    user_id: async (env) => [["all_group_ids", "in", await env.reg.xmlid(env.cr, "stock.group_stock_user")]],
  },
});

// account/models/product.py:207-218 product.template._compute_cost_method: the category's costing method in the
// product's company (the current one when the product has none or the current one is a branch of it), else the
// company's
defineComputes("product.template", {
  cost_method: async (env, rec) => {
    let company = idOf(await rec.get("company_id"));
    const current = await env.company();
    if (company === null) company = current;
    else {
      const branch = (await env.cr.query("SELECT 1 FROM res_company c JOIN res_company p ON p.id = $2 WHERE c.id = $1 AND c.parent_path LIKE p.parent_path || '%'", [current, company])).rows.length;
      if (branch) company = current;
    }
    const categ = idOf(await rec.get("categ_id"));
    const cenv = env.sudo().withContext({ ...env.context, allowed_company_ids: [company] });
    const fromCateg = categ === null ? null : (await cenv.model("product.category").read([categ], ["property_cost_method"], ""))[0]?.["property_cost_method"];
    if (fromCateg) return fromCateg;
    return (await env.sudo().model("res.company").read([company], ["cost_method"], ""))[0]?.["cost_method"] ?? null;
  },
});

// stock_warehouse.py:1170-1172 get_current_warehouses
registerMethod("stock.warehouse", "get_current_warehouses", async (env0, _ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const ids = await env.model("stock.warehouse").search(parseDomain([]));
  return ids.length ? env.model("stock.warehouse").read(ids, ["id", "name", "code"]) : [];
}, { apiModel: true });

// stock/models/stock_move.py on new moves: :428-448 quantity (the sum of the move lines, onchange branch) and
// :821-826 display_name "<origin>/<code>: <source>><destination>"
registerRecordCompute("stock.move", {
  // :213-216 _compute_uom_id
  uom_id: async (_env, rec) => { const p = await rec.rel("product_id"); return p ? idOf(await p.get("uom_id")) : null; },
  quantity: async (env, rec) => {
    const uom = idOf(await rec.get("uom_id"));
    let total = 0;
    for (const line of await rec.rels("move_line_ids")) {
      const lineUom = idOf(await line.get("uom_id"));
      const q = Number(await line.get("quantity") ?? 0);
      if (lineUom !== null && uom !== null && lineUom !== uom) {
        const { uomQuantityRaw } = await import("./stock_engine");
        total += await uomQuantityRaw(env, q, lineUom, uom);
      } else {
        total += q;
      }
    }
    return total;
  },
  display_name: async (_env, rec) => {
    const picking = await rec.rel("picking_id");
    const origin = picking ? await picking.get("origin") : null;
    const product = await rec.rel("product_id");
    const code = product ? await product.get("code") : null;
    const src = await rec.rel("location_id"), dst = await rec.rel("location_dest_id");
    const nameOf = async (l: Rec | null) => { const n = l ? await l.get("name") : null; return n === null || n === undefined || n === false ? "False" : String(n); };
    return `${origin ? `${String(origin)}/` : ""}${code ? `${String(code)}: ` : ""}${await nameOf(src)}>${await nameOf(dst)}`;
  },
});

// product/models/product_product.py:468-485 _compute_product_code: the internal reference, or the vendor's product
// code of the context's partner (not ported)
defineComputes("product.product", {
  code: async (env, rec) => {
    if (env.context["partner_id"]) throw new NotPorted("product.product.code for a context partner (vendor product codes)");
    return (await rec.get("default_code")) ?? null;
  },
});

// product_template.py:415-445 with multi_variant=True (weight :536-538, volume :529-531): the variants' common value,
// else unchanged
async function fromVariantsMulti(env: Environment, rec: Rec, fname: string): Promise<unknown> {
  const tmpl = rec.id ?? rec.origin;
  if (tmpl === null) return rec.prev(fname);
  let variants = await env.model("product.product").search(parseDomain([["product_tmpl_id", "=", tmpl]]));
  if (!variants.length && env.context["active_test"] !== false) {
    variants = await env.withContext({ ...env.context, active_test: false }).model("product.product").search(parseDomain([["product_tmpl_id", "=", tmpl]]), { activeTest: false });
  }
  const values = variants.length ? (await env.model("product.product").read(variants, [fname], "")).map((r) => r[fname]) : [];
  const distinct = [...new Set(values.map((v) => JSON.stringify(v)))];
  return distinct.length === 1 ? values[0] : rec.prev(fname);
}
registerRecordCompute("product.template", {
  weight: async (env, rec) => fromVariantsMulti(env, rec, "weight"),
  volume: async (env, rec) => fromVariantsMulti(env, rec, "volume"),
});

// sale/models/product_template.py:179-190 action_view_sales
registerMethod("product.template", "action_view_sales", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const { loadAction } = await import("../controllers/action");
  const action = await loadAction({ cursor: () => env.cr, context: env.context, uid: env.uid }, "sale.report_all_channels_sales_action");
  action["domain"] = [["product_tmpl_id", "in", [...(ids ?? [])]]];
  action["context"] = {
    pivot_measures: ["product_uom_qty"], active_id: env.context["active_id"] ?? null, active_model: "sale.report",
    search_default_Sales: 1, search_default_filter_order_date: 1, search_default_group_by_date: 1,
  };
  return action;
}, { apiModel: false });

// stock.warehouse search_read: no read/search override in stock, purchase_stock, sale_stock, mrp
registerMethod("stock.warehouse", "search_read", async (env0, _ids, args, kwargs0, name) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  return searchRead(env, name, args, kwargs);
}, { apiModel: true, readonly: true });

export async function actionOf(env: Environment, xmlid: string): Promise<Record<string, unknown>> {
  const { loadAction } = await import("../controllers/action");
  return loadAction({ cursor: () => env.cr, context: env.context, uid: env.uid }, xmlid);
}
export async function variantsOf(env: Environment, tmpl: readonly number[], activeTest = true): Promise<number[]> {
  const venv = activeTest ? env : env.withContext({ ...env.context, active_test: false });
  return venv.model("product.product").search(parseDomain([["product_tmpl_id", "in", [...tmpl]]]), activeTest ? {} : { activeTest: false });
}

// purchase/models/product.py:48-55 action_view_po
registerMethod("product.template", "action_view_po", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = one(ids, "product.template");
  const action = await actionOf(env, "purchase.action_purchase_history");
  action["domain"] = ["&", ["state", "=", "purchase"], ["product_id", "in", await variantsOf(env, [id], false)]];
  const name = (await env.model("product.template").displayName([id])).get(id) ?? "";
  action["display_name"] = translate(env, "Purchase History for %s").replace("%s", name);
  return action;
}, { apiModel: false });

// stock/models/product.py:1230-1234 (template) action_view_stock_move_lines
registerMethod("product.template", "action_view_stock_move_lines", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  one(ids, "product.template");
  const action = await actionOf(env, "stock.stock_move_line_action");
  action["domain"] = [["product_id.product_tmpl_id", "in", [...(ids ?? [])]]];
  return action;
}, { apiModel: false });

// stock/models/product.py:1227-1228 -> :595-609 action_view_orderpoints of the variants
registerMethod("product.template", "action_view_orderpoints", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const variants = await variantsOf(env, ids ?? []);
  const action = await actionOf(env, "stock.action_orderpoint");
  const raw = action["context"];
  const ctx = typeof raw === "string" ? evalExpr(raw, new Map([["uid", env.uid]])) : raw;
  if (!isDict(ctx)) throw new NotPorted("stock.action_orderpoint context that is not a dict");
  const context = new Map<unknown, unknown>(dictEntries(ctx));
  context.delete("search_default_trigger");
  context.set("search_default_filter_not_snoozed", true);
  if (variants.length === 1) {
    context.set("default_product_id", variants[0]);
    context.set("search_default_product_id", variants[0]);
  } else {
    if (action["domain"]) throw new NotPorted("action_view_orderpoints over several variants with a domain on the action");
    action["domain"] = [["product_id", "in", variants]];
  }
  action["context"] = Object.fromEntries(context as Map<string, unknown>);
  return action;
}, { apiModel: false });
