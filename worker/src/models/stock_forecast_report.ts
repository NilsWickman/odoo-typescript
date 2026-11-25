/**
 * The forecasted report of a product (stock/report/stock_forecasted.py:10-518, `stock.forecasted_product_product` and
 * `stock.forecasted_product_template`) with the extensions of the installed modules: sale_stock (draft quotations and
 * the order of a delivery, :1-55), purchase_stock (requests for quotation, :1-38) and stock_account (the stock value,
 * :1-35). The lines come from `reportLines` (stock_forecast.ts); chained moves, other units and dated vendors refuse.
 */
import { NotPorted } from "../errors";
import { registerMethod } from "../http/methods";
import { floatRepr } from "../orm/convert";
import { parseDomain } from "../orm/domain";
import { hasGroup } from "../orm/env";
import { DbRec } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { pyFloat } from "../orm/values";
import { rulesFromLocation } from "./inventory_flow";
import { selectSeller } from "./purchase_flow";
import { reportLines, type Line } from "./stock_forecast";
import { contextDay, dbNow, datetimeToString, translate } from "./util";
import { formatDate } from "./invoicing_computes";
import { combinationNames } from "./config_write";
import { filteredAccess } from "./tail_util";

type Dict = Record<string, unknown>;
const idOf = (v: unknown): number | null => (typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : null);
const num = (v: unknown): number => (typeof v === "number" ? v : v && typeof v === "object" && "float" in v ? Number((v as { float: number }).float) : Number(v ?? 0));

async function rows<T extends object>(env: Environment, text: string, params: unknown[]): Promise<T[]> {
  return (await env.cr.query<T & Record<string, unknown>>(text, params)).rows;
}

async function precision(env: Environment): Promise<number> {
  return (await rows<{ digits: number }>(env, "SELECT digits FROM decimal_precision WHERE name = 'Product Unit'", []))[0]?.digits ?? 2;
}

/** `_get_warehouse`: the context's warehouse, else the first active one. */
async function warehouseOf(env: Environment): Promise<{ id: number; view: number; stock: number }> {
  const wid = env.context["warehouse_id"];
  let id: number | undefined;
  if (typeof wid === "number" && wid) id = wid;
  else if (wid) throw new NotPorted("stock forecasted report with a warehouse given otherwise than by id");
  else id = (await env.model("stock.warehouse").search(parseDomain([["active", "=", true]])))[0];
  if (id === undefined) throw new NotPorted("stock forecasted report without a warehouse (IndexError)");
  const [w] = await rows<{ v: number; s: number }>(env, "SELECT view_location_id AS v, lot_stock_id AS s FROM stock_warehouse WHERE id = $1", [id]);
  if (!w) throw new NotPorted("stock forecasted report of a missing warehouse");
  return { id, view: w.v, stock: w.s };
}

/** stock_rule.py:388-419 `_get_lead_days` with purchase_stock stock_rule.py:180-207, with the descriptions. */
async function leadtime(env: Environment, product: number, location: number): Promise<Dict> {
  const [p] = await rows<{ t: number; c: number }>(env, "SELECT p.product_tmpl_id AS t, t.categ_id AS c FROM product_product p JOIN product_template t ON t.id = p.product_tmpl_id WHERE p.id = $1", [product]);
  const rules = await rulesFromLocation(env, { template: p!.t, categ: p!.c }, location, await env.company());
  const delays = new Map<string, number>();
  const add = (k: string, v: number): void => { delays.set(k, (delays.get(k) ?? 0) + v); };
  const details: unknown[] = [];
  const delaying = rules.filter((r) => ["pull", "pull_push"].includes(r.action) && r.delay);
  if (delaying.length) {
    add("total_delay", delaying.reduce((a, r) => a + (r.delay ?? 0), 0));
    for (const r of delaying) {
      const [n] = await env.model("stock.rule").read([r.id], ["name"], "");
      details.push([translate(env, "Delay on %s").replace("%s", String(n?.["name"] ?? "")), translate(env, "+ %d days").replace("%d", String(Math.trunc(r.delay ?? 0)))]);
    }
  }
  if (!env.context["bypass_global_horizon_days"]) {
    const ctx = env.context["global_horizon_days"];
    const horizon = ctx !== undefined ? Number(ctx || 0)
      : Number((await rows<{ h: number | null }>(env, "SELECT horizon_days AS h FROM res_company WHERE id = $1", [await env.company()]))[0]?.h ?? 0);
    if (horizon) {
      add("horizon_time", horizon);
      details.push([translate(env, "Time Horizon"), translate(env, "+ %d days").replace("%d", String(Math.trunc(horizon)))]);
    }
    const buy = rules.filter((r) => r.action === "buy");
    if (buy.length) {
      if ((await rows(env, "SELECT 1 FROM product_supplierinfo WHERE product_tmpl_id = $1 AND (date_start IS NOT NULL OR date_end IS NOT NULL) LIMIT 1", [p!.t])).length) {
        throw new NotPorted("stock forecasted lead days with dated vendors");
      }
      if (buy.length > 1) throw new NotPorted("stock forecasted lead days with several buy rules (ensure_one)");
      const company = buy[0]!.company_id ?? await env.company();
      const cenv = env.withContext({ ...env.context, allowed_company_ids: [company] });
      const seller = await selectSeller(cenv, new DbRec(cenv, cenv.reg.model("product.product"), product), {
        company, partner: null, date: null, quantity: null, uom: null, forceUom: false, params: false, envCompany: company,
      });
      if (!seller) {
        add("total_delay", 365);
        add("no_vendor_found_delay", 365);
        details.push([translate(env, "No Vendor Found"), translate(env, "+ %s days").replace("%s", "365")]);
      } else {
        if (!env.context["ignore_vendor_lead_time"]) {
          add("total_delay", seller.delay);
          add("purchase_delay", seller.delay);
          details.push([translate(env, "Receipt Date"), seller.delay]);
          details.push([translate(env, "Vendor Lead Time"), translate(env, "+ %d days").replace("%d", String(Math.trunc(seller.delay)))]);
        }
        const days = buy[0]!.company_id === null ? 0
          : Number((await rows<{ d: number | null }>(env, "SELECT days_to_purchase AS d FROM res_company WHERE id = $1", [buy[0]!.company_id]))[0]?.d ?? 0);
        add("total_delay", days);
        details.push([translate(env, "Order Deadline"), days]);
        details.push([translate(env, "Days to Purchase"), translate(env, "+ %d days").replace("%d", String(Math.trunc(days)))]);
      }
    }
  } else if (rules.some((r) => r.action === "buy")) {
    throw new NotPorted("stock forecasted lead days of a buy rule with bypass_global_horizon_days");
  }
  // `leadtime[0].get('total_delay', 0)`: a float once a delay was added (defaultdict(float)), else the integer 0
  return { total_delay: delays.has("total_delay") ? pyFloat(delays.get("total_delay")!) : 0, details };
}

/** stock_move.py:2565-2570 `_get_source_document` with sale_stock stock.py:167-169 and purchase_stock stock_move.py:149-151. */
async function sourceDocument(env: Environment, move: number): Promise<Dict | false> {
  const [m] = await rows<{ picking_id: number | null; sale_line_id: number | null; purchase_line_id: number | null }>(env.sudo(),
    "SELECT picking_id, sale_line_id, purchase_line_id FROM stock_move WHERE id = $1", [move]);
  let doc: { model: string; id: number } | null = m!.picking_id ? { model: "stock.picking", id: m!.picking_id } : null;
  if (m!.purchase_line_id) {
    const [o] = await rows<{ o: number }>(env, "SELECT order_id AS o FROM purchase_order_line WHERE id = $1", [m!.purchase_line_id]);
    if (o) doc = { model: "purchase.order", id: o.o };
  }
  // sale_stock stock.py:167-169: `self.sale_line_id._filtered_access('read').order_id or res`
  if (m!.sale_line_id && (await filteredAccess(env, "sale.order.line", [m!.sale_line_id], "read")).size) {
    const [o] = await rows<{ o: number }>(env.sudo(), "SELECT order_id AS o FROM sale_order_line WHERE id = $1", [m!.sale_line_id]);
    if (o) doc = { model: "sale.order", id: o.o };
  }
  if (!doc) return false;
  const [r] = await env.sudo().model(doc.model).read([doc.id], ["display_name"], "");
  return { _name: doc.model, id: doc.id, name: r?.["display_name"] ?? false };
}

interface Ctx { env: Environment; uom: Map<number, Dict>; product: Map<number, Dict>; now: string; matchIds: number[] }

/** stock_forecasted.py:177-231 `_prepare_report_line` (read=True) with sale_stock :8-29. */
async function prepareLine(c: Ctx, line: Line, moves: Map<number, { state: string; date: string; picking_id: number | null }>): Promise<Dict> {
  const { env } = c;
  const out = line.out, moveIn = line.moveIn;
  const o = out !== null ? moves.get(out)! : null;
  const productUom = (await rows<{ u: number }>(env, "SELECT t.uom_id AS u FROM product_product p JOIN product_template t ON t.id = p.product_tmpl_id WHERE p.id = $1", [line.product]))[0]!.u;
  if (!c.uom.has(productUom)) c.uom.set(productUom, (await env.model("uom.uom").read([productUom], []))[0]!);
  if (!c.product.has(line.product)) {
    const [p] = await env.model("product.product").read([line.product], ["display_name"], "");
    c.product.set(line.product, { id: line.product, display_name: p?.["display_name"] ?? false });
  }
  let reservation: Dict | false = false;
  if (line.reserved !== null) {
    const picking = moves.get(line.reserved)?.picking_id ?? null;
    const name = picking === null ? false : (await rows<{ n: string }>(env, "SELECT name AS n FROM stock_picking WHERE id = $1", [picking]))[0]?.n ?? false;
    reservation = { _name: "stock.picking", name, id: picking ?? false };
  }
  const res: Dict = {
    document_in: false, document_out: false, receipt_date: false, delivery_date: false,
    product: c.product.get(line.product),
    replenishment_filled: line.filled,
    is_late: o && moveIn ? o.date < moveIn.date : false,
    delivery_late: o ? o.state !== "done" && o.date < c.now : false,
    receipt_late: moveIn ? moveIn.state !== "done" && moveIn.date < c.now : false,
    quantity: pyFloat(line.quantity),
    move_out: null, move_in: null,
    reservation, in_transit: line.inTransit,
    is_matched: c.matchIds.some((id) => id === moveIn?.id || id === out),
    uom_id: c.uom.get(productUom),
  };
  const dateOf = async (date: string): Promise<string> => formatDate(env, (await contextDay(env, date)) as string);
  if (moveIn) {
    res["move_in"] = (await env.model("stock.move").read([moveIn.id], ["id", "date", "move_orig_ids"]))[0];
    res["document_in"] = await sourceDocument(env, moveIn.id);
    res["receipt_date"] = await dateOf(moveIn.date);
  }
  if (o && out !== null) {
    const mo = (await env.model("stock.move").read([out], ["id", "date", "move_orig_ids"]))[0]!;
    res["move_out"] = mo;
    res["document_out"] = await sourceDocument(env, out);
    res["delivery_date"] = await dateOf(o.date);
    if (o.picking_id) {
      mo["picking_id"] = (await env.model("stock.picking").read([o.picking_id], ["id", "priority"]))[0];
      const [sale] = await rows<{ s: number | null }>(env, "SELECT sale_id AS s FROM stock_picking WHERE id = $1", [o.picking_id]);
      if (sale?.s) {
        const [so] = await env.model("sale.order").read([sale.s], ["amount_untaxed", "currency_id", "partner_id"], "");
        mo["picking_id"] = {
          id: o.picking_id, priority: (mo["picking_id"] as Dict)["priority"],
          sale_id: {
            id: sale.s, amount_untaxed: so?.["amount_untaxed"],
            currency_id: (await env.model("res.currency").read([idOf(so?.["currency_id"])!], ["id", "name"], ""))[0],
            partner_id: (await env.model("res.partner").read([idOf(so?.["partner_id"])!], ["id", "display_name"], ""))[0],
          },
        };
      }
    }
  }
  return res;
}

/** `_read_group(domain, aggregates=['product_qty:sum'], groupby=['product_id'])` of the draft moves. */
async function draftSums(env: Environment, products: readonly number[], whLocations: readonly number[]): Promise<{ in: Map<number, number>; out: Map<number, number> }> {
  const base = [["product_id", "in", [...products]], ["product_uom_qty", "!=", 0]];
  const outDomain = [...base, "&", ["location_id", "in", [...whLocations]], "|", ["location_dest_id", "not in", [...whLocations]],
    "&", ["forecasted_location_id", "!=", false], ["forecasted_location_id", "not in", [...whLocations]], ["state", "=", "draft"]];
  const inDomain = [...base, "&", ["location_id", "not in", [...whLocations]], ["location_dest_id", "in", [...whLocations]], ["state", "=", "draft"]];
  const sum = async (domain: unknown[]): Promise<Map<number, number>> => {
    const ids = await env.model("stock.move").search(parseDomain(domain));
    const out = new Map<number, number>();
    if (!ids.length) return out;
    for (const r of await rows<{ p: number; q: number }>(env, "SELECT product_id AS p, sum(product_qty)::float8 AS q FROM stock_move WHERE id = ANY($1::int[]) GROUP BY product_id", [ids])) out.set(r.p, r.q);
    return out;
  };
  return { in: await sum(inDomain), out: await sum(outDomain) };
}

/** stock_forecasted.py:157-174 `_get_report_data`. */
async function reportData(env: Environment, templates: number[] | null, productIds: number[] | null): Promise<Dict> {
  const warehouse = await warehouseOf(env);
  const whLocations = await env.model("stock.location").search(parseDomain([["id", "child_of", warehouse.view]]));
  const res: Dict = {};
  let products: number[];
  if (templates) {
    products = await env.model("product.product").search(parseDomain([["product_tmpl_id", "in", templates]]));
    // `products.product_variant_ids`: the active variants of each template in turn
    const byTmpl = await rows<{ id: number; t: number }>(env, "SELECT id, product_tmpl_id AS t FROM product_product WHERE id = ANY($1::int[])", [products]);
    // (each template's variants in the search's order, `_order = 'default_code, name, id'`; the SELECT has no order)
    const tmplOf = new Map(byTmpl.map((r) => [r.id, r.t]));
    const found = products;
    products = templates.flatMap((t) => found.filter((id) => tmplOf.get(id) === t));
    if (byTmpl.some((r) => products.filter((p) => p === r.id).length > 1)) throw new NotPorted("stock forecasted report of a repeated template");
    // stock_forecasted.py:120-123: `pv.product_template_attribute_value_ids._get_combination_name()`
    const combinations = await combinationNames(env, products);
    res["product_templates"] = await env.model("product.template").read(templates, ["id", "display_name"], "");
    res["product_templates_ids"] = templates;
    res["product_variants"] = products.map((id) => ({ id, combination_name: combinations.get(id) ?? "" }));
    res["product_variants_ids"] = products;
    res["multiple_product"] = products.length > 1;
  } else {
    products = productIds!;
    res["product_templates"] = false;
    res["product_variants"] = await env.model("product.product").read(products, ["id", "display_name"], "");
    res["product_variants_ids"] = products;
    res["multiple_product"] = products.length > 1;
  }
  // `_get_product_quantities`, `draft_picking_qty`, the lead times
  const draft = await draftSums(env, products, whLocations);
  const productRes: Record<string, Dict> = {};
  const qtyRead = await env.model("product.product").read(products, ["uom_id", "qty_available", "virtual_available", "free_qty", "incoming_qty", "outgoing_qty"], "");
  for (const r of qtyRead) {
    const id = Number(r["id"]);
    const uom = idOf(r["uom_id"]);
    const [u] = await env.model("uom.uom").read([uom!], ["display_name"], "");
    productRes[String(id)] = {
      uom: u?.["display_name"], quantity_on_hand: r["qty_available"], virtual_available: r["virtual_available"], free_qty: r["free_qty"],
      incoming_qty: r["incoming_qty"], outgoing_qty: r["outgoing_qty"], qty: { in: 0, out: 0 },
    };
  }
  const addQuantities = (name: string, qin: Map<number, number>, qout: Map<number, number>): void => {
    for (const id of products) {
      const p = productRes[String(id)]!;
      const i = qin.get(id) ?? 0, o = qout.get(id) ?? 0;
      p[name] = { in: pyFloat(i), out: pyFloat(o) };
      const q = p["qty"] as { in: number; out: number };
      q.in += i; q.out += o;
    }
  };
  addQuantities("draft_picking_qty", draft.in, draft.out);
  for (const id of products) productRes[String(id)]!["leadtime"] = await leadtime(env, id, warehouse.stock);
  // purchase_stock: the requests for quotation of the warehouse's operation types in the warehouse's company
  {
    const [w] = await rows<{ c: number }>(env, "SELECT company_id AS c FROM stock_warehouse WHERE id = $1", [warehouse.id]);
    const company = env.context["warehouse_id"] ? w!.c : await env.company();
    const domain: unknown[] = [["state", "in", ["draft", "sent", "to approve"]], ["product_id", "in", products]];
    if (env.context["warehouse_id"]) domain.push(["order_id.picking_type_id.warehouse_id", "=", warehouse.id]);
    domain.push(["company_id", "=", company]);
    const lines = await env.sudo().model("purchase.order.line").search(parseDomain(domain));
    const data = lines.length ? await rows<{ id: number; p: number; q: number; o: number; n: string }>(env,
      "SELECT l.id, l.product_id AS p, l.product_uom_qty::float8 AS q, l.order_id AS o, po.name AS n FROM purchase_order_line l JOIN purchase_order po ON po.id = l.order_id WHERE l.id = ANY($1::int[])", [lines]) : [];
    const byLine = new Map(data.map((d) => [d.id, d]));
    const qin = new Map<number, number>();
    for (const id of lines) { const d = byLine.get(id)!; qin.set(d.p, (qin.get(d.p) ?? 0) + d.q); }
    addQuantities("draft_purchase_qty", qin, new Map());
    for (const p of products) {
      const mine = lines.map((id) => byLine.get(id)!).filter((d) => d.p === p);
      if (!mine.length) continue;
      const orders = [...new Map(mine.map((d) => [d.o, d.n])).entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
      productRes[String(p)]!["draft_purchase_orders"] = orders.map(([id, name]) => ({ id, name }));
      productRes[String(p)]!["draft_purchase_orders_matched"] = mine.some((d) => d.id === env.context["purchase_line_to_match_id"]);
    }
  }
  // sale_stock: the quotations of the warehouse
  {
    const domain: unknown[] = [["state", "in", ["draft", "sent"]]];
    domain.push(templates ? ["product_template_id", "in", templates] : ["product_id", "in", products]);
    if (env.context["warehouse_id"]) domain.push(["warehouse_id", "=", env.context["warehouse_id"]]);
    const lines = await env.sudo().model("sale.order.line").search(parseDomain(domain));
    const data = lines.length ? await rows<{ id: number; p: number; q: number; u: number; pu: number; o: number; n: string }>(env,
      `SELECT l.id, l.product_id AS p, l.product_uom_qty::float8 AS q, l.product_uom_id AS u, t.uom_id AS pu, l.order_id AS o, so.name AS n
         FROM sale_order_line l JOIN sale_order so ON so.id = l.order_id JOIN product_product pp ON pp.id = l.product_id JOIN product_template t ON t.id = pp.product_tmpl_id
        WHERE l.id = ANY($1::int[])`, [lines]) : [];
    if (data.some((d) => d.u !== d.pu)) throw new NotPorted("stock forecasted report of quotations in another unit");
    const byLine = new Map(data.map((d) => [d.id, d]));
    const qout = new Map<number, number>();
    for (const id of lines) { const d = byLine.get(id)!; qout.set(d.p, (qout.get(d.p) ?? 0) + d.q); }
    addQuantities("draft_sale_qty", new Map(), qout);
    for (const p of products) {
      const mine = lines.map((id) => byLine.get(id)!).filter((d) => d.p === p);
      if (!mine.length) continue;
      const orders = [...new Map(mine.map((d) => [d.o, d.n])).entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
      productRes[String(p)]!["draft_sale_orders"] = orders.map(([id, name]) => ({ id, name }));
      productRes[String(p)]!["draft_sale_orders_matched"] = mine.some((d) => d.id === env.context["sale_line_to_match_id"]);
    }
  }
  for (const p of Object.values(productRes)) {
    const q = p["qty"] as { in: number; out: number };
    p["qty"] = { in: pyFloat(q.in), out: pyFloat(q.out) };
  }
  res["product"] = productRes;
  // stock_account: the value of the warehouse's quants, for stock managers
  if (await hasGroup(env, "stock.group_stock_manager") && whLocations.length) {
    const [loc] = await rows<{ c: number | null }>(env, "SELECT company_id AS c FROM stock_location WHERE id = $1", [whLocations[0]]);
    const domain: unknown[] = [["company_id", "=", loc?.c ?? false], ["location_id", "in", whLocations]];
    domain.push(templates ? ["product_id.product_tmpl_id", "in", templates] : ["product_id", "in", products]);
    const quants = await env.model("stock.quant").search(parseDomain(domain));
    let value = 0;
    for (const r of quants.length ? await env.model("stock.quant").read(quants, ["value"], "") : []) value += num(r["value"]);
    const [cur] = await rows<{ symbol: string; position: string; decimal_places: number }>(env,
      "SELECT c.symbol, c.position, c.decimal_places FROM res_company co JOIN res_currency c ON c.id = co.currency_id WHERE co.id = $1", [await env.company()]);
    const v = floatRepr(value, cur!.decimal_places);
    res["value"] = cur!.position === "after" ? `${v} ${cur!.symbol}` : `${cur!.symbol} ${v}`;
  }
  const lines = await reportLines(env, products, whLocations, warehouse.stock);
  const moveIds = [...new Set(lines.flatMap((l) => [l.out, l.reserved].filter((x): x is number => x !== null)))];
  const moves = new Map((moveIds.length ? await rows<{ id: number; state: string; date: string; picking_id: number | null }>(env,
    "SELECT id, state, to_char(date, 'YYYY-MM-DD HH24:MI:SS') AS date, picking_id FROM stock_move WHERE id = ANY($1::int[])", [moveIds]) : []).map((m) => [m.id, m]));
  const matchIds = Array.isArray(env.context["move_to_match_ids"]) ? (env.context["move_to_match_ids"] as unknown[]).filter((x): x is number => typeof x === "number") : [];
  const c: Ctx = { env, uom: new Map(), product: new Map(), now: datetimeToString(await dbNow(env)), matchIds };
  const out: Dict[] = [];
  for (const l of lines) out.push(await prepareLine(c, l, moves));
  res["lines"] = out;
  res["user_can_edit_pickings"] = await hasGroup(env, "stock.group_stock_user");
  return res;
}

async function getReportValues(env: Environment, kwargs: Dict, args: unknown[], model: "product.template" | "product.product"): Promise<Dict> {
  const docids = (args[0] ?? kwargs["docids"]) as unknown;
  const data = args.length > 1 ? args[1] : kwargs["data"] ?? null;
  const ids = Array.isArray(docids) ? docids.filter((x): x is number => typeof x === "number") : typeof docids === "number" ? [docids] : [];
  if (!ids.length) throw new NotPorted("stock forecasted report without products (AssertionError)");
  return {
    data, doc_ids: docids, doc_model: model,
    docs: await reportData(env, model === "product.template" ? ids : null, model === "product.product" ? ids : null),
    precision: await precision(env),
  };
}

registerMethod("stock.forecasted_product_template", "get_report_values", async (env, _ids, args, kwargs) => getReportValues(env, kwargs, args, "product.template"), { apiModel: true, readonly: true });
registerMethod("stock.forecasted_product_product", "get_report_values", async (env, _ids, args, kwargs) => getReportValues(env, kwargs, args, "product.product"), { apiModel: true, readonly: true });
