/**
 * Editing an existing product (proofs/edit_sweep.py, 2026-11-22): the parts of the `product.template` write chain
 * that act on other records, its constraints and its copy.
 *
 * - product product_template.py:836-859 write: a new unit is first written on the variants' lines (`_update_uom`,
 *   stock product.py:769-793, purchase product.py:169-184, sale product_product.py:139-155); a template made active
 *   without active variants gets them back (`_create_variant_ids`); an archived template archives its variants.
 * - stock product.py:1105-1140 write: Track Inventory turned on (`_clean_reservations`, `_reset_inventory`).
 * - stock_account product.py:36-80 write: a category of another costing method (`_update_standard_price`).
 * - sale_project product_template.py:139-145 write: a product that is no service tracks nothing.
 * - stock product.py:276-298 and :980-987 `_inverse_qty_available`: the quantity on hand as an inventory adjustment.
 * - product product_product.py:420-432 `_check_barcode_uniqueness` of the variants a barcode reaches.
 * - account product.py:243-262 `_check_uom_not_in_invoice`, sale_project product_template.py:115-127
 *   `_check_project_and_template`.
 * - product product_template.py:872-944 and stock product.py:1180-1194 copy.
 * What the port does not follow refuses with NotPorted.
 */
import { NotPorted, UserError, ValidationError } from "../errors";
import { registerMethod } from "../http/methods";
import { create } from "../orm/create";
import { cond, parseDomain } from "../orm/domain";
import type { Environment } from "../orm/types";
import { registerOverrides, write } from "../orm/write";
import { copy } from "../web/save";
import { envFor } from "../web/common";
import { translate } from "./util";
import { variantsOf } from "./sps_menus";
import { createVariantIds } from "./product_variants";
import { uomCompare } from "./stock_engine";

async function rows<T extends object>(env: Environment, text: string, params: unknown[]): Promise<T[]> {
  return (await env.cr.query<T & Record<string, unknown>>(text, params)).rows;
}

/** Python `%(name)s` formatting of a translated message. */
function fmt(message: string, args: Readonly<Record<string, string>>): string {
  return message.replace(/%\((\w+)\)s/g, (m, k: string) => (k in args ? args[k]! : m));
}

async function uomName(env: Environment, uom: number): Promise<string> {
  return (await rows<{ n: string | null }>(env, "SELECT COALESCE(name->>$2, name->>'en_US') AS n FROM uom_uom WHERE id = $1", [uom, env.lang ?? "en_US"]))[0]?.n ?? "";
}

// ------------------------------------------------------------------------------------------------------ _update_uom

const UOM_ERROR = "As other units of measure (ex : %(problem_uom)s) than %(uom)s have already been used for this product, the change of unit of measure can not be done.If you want to change it, please archive the product and create a new one.";
const UOM_ERROR_SALE = "As other units of measure (ex : %(problem_uom)s) than %(uom)s have already been used for this product, the change of unit of measure can not be done.\nIf you want to change it, please archive the product and create a new one.";

/** The lines `_update_uom` rewrites, found before the template's write (its unit is the one they must have). */
export interface UomPlan { readonly moves: number[]; readonly moveLines: number[] }

/**
 * product_template.py:837-839: the variants of the templates whose unit changes, `_update_uom(uom)` with
 * skip_uom_conversion, in the MRO of the installed modules (sale, purchase, stock, product): per (unit, variant) of
 * the variant's lines (`_read_group` as the user), a unit other than the template's raises, else the lines take the
 * new unit. The checks run here; the lines are written after the template (`applyUomPlan`), so that their computed
 * quantities read the new unit of the product as Odoo's flush does. Sale and purchase lines refuse (their price and
 * quantity recomputes under skip_uom_conversion are not ported).
 */
export async function planUomUpdate(env: Environment, templates: readonly number[], uom: number | null): Promise<UomPlan> {
  const changing = (await rows<{ id: number }>(env, "SELECT id FROM product_template WHERE id = ANY($1::int[]) AND uom_id IS DISTINCT FROM $2 ORDER BY id", [[...templates], uom])).map((r) => r.id);
  const plan = { moves: [] as number[], moveLines: [] as number[] };
  if (!changing.length) return plan;
  const variants = await variantsOf(env, changing);
  if (!variants.length) return plan;
  const groups = async (model: string, table: string, column: string): Promise<{ ids: number[]; uom: number; tmplUom: number }[]> => {
    if (!env.reg.models.has(model)) return [];
    const found = await env.model(model).search(cond("product_id", "in", variants));
    if (!found.length) return [];
    return rows<{ ids: number[]; uom: number; tmplUom: number }>(env,
      `SELECT array_agg(l.id ORDER BY l.id) AS ids, l.${column} AS uom, t.uom_id AS "tmplUom"
         FROM ${table} l JOIN product_product p ON p.id = l.product_id JOIN product_template t ON t.id = p.product_tmpl_id
        WHERE l.id = ANY($1::int[]) GROUP BY l.${column}, l.product_id, t.uom_id ORDER BY l.${column}, l.product_id`, [found]);
  };
  // stock names the units by `name`, sale and purchase by `display_name` (the same for a unit)
  const check = async (gs: { uom: number; tmplUom: number }[], message: string): Promise<void> => {
    for (const g of gs) {
      if (g.uom === g.tmplUom) continue;
      throw new UserError(fmt(translate(env, message), { problem_uom: await uomName(env, g.uom), uom: await uomName(env, g.tmplUom) }));
    }
  };
  // sale product_product.py:139-155 and purchase product.py:169-184 run first (the later modules of the MRO)
  const sale = await groups("sale.order.line", "sale_order_line", "product_uom_id");
  await check(sale, UOM_ERROR_SALE);
  if (sale.length) throw new NotPorted("product.template unit change with sale order lines (_update_uom of sale.order.line)");
  const purchase = await groups("purchase.order.line", "purchase_order_line", "uom_id");
  await check(purchase, UOM_ERROR);
  if (purchase.length) throw new NotPorted("product.template unit change with purchase order lines (_update_uom of purchase.order.line)");
  // stock product.py:769-793
  const moves = await groups("stock.move", "stock_move", "uom_id");
  await check(moves, UOM_ERROR);
  const lines = await groups("stock.move.line", "stock_move_line", "uom_id");
  await check(lines, UOM_ERROR);
  plan.moves.push(...moves.flatMap((g) => g.ids));
  plan.moveLines.push(...lines.flatMap((g) => g.ids));
  return plan;
}

/** `moves.uom_id = to_uom_id` and `move_lines.uom_id = to_uom_id` under skip_uom_conversion (stock product.py:782, :792). */
export async function applyUomPlan(env: Environment, plan: UomPlan, uom: number | null): Promise<void> {
  const senv = env.withContext({ ...env.context, skip_uom_conversion: true });
  if (plan.moves.length) await write(senv, "stock.move", plan.moves, { uom_id: uom });
  if (plan.moveLines.length) await write(senv, "stock.move.line", plan.moveLines, { uom_id: uom });
}

// ----------------------------------------------------------------------------------------- stock: Track Inventory

/**
 * stock_quant.py:1174-1207 `_clean_reservations` (sudo): the reserved quantities of the quants are set to what the
 * open move lines of storable products reserve. The port checks they already agree (the case of a consistent
 * database) and refuses when a quant's reservation would change.
 */
export async function cleanReservations(env: Environment): Promise<void> {
  const quants = await rows<{ product_id: number; location_id: number; lot_id: number | null; package_id: number | null; owner_id: number | null; r: number; usage: string }>(env,
    `SELECT q.product_id, q.location_id, q.lot_id, q.package_id, q.owner_id, sum(q.reserved_quantity)::float8 AS r, l.usage
       FROM stock_quant q JOIN stock_location l ON l.id = q.location_id WHERE q.reserved_quantity != 0
      GROUP BY q.product_id, q.location_id, q.lot_id, q.package_id, q.owner_id, l.usage`, []);
  const lines = await rows<{ product_id: number; location_id: number; lot_id: number | null; package_id: number | null; owner_id: number | null; r: number; usage: string }>(env,
    `SELECT ml.product_id, ml.location_id, ml.lot_id, ml.package_id, ml.owner_id, sum(ml.quantity_product_uom)::float8 AS r, l.usage
       FROM stock_move_line ml JOIN stock_location l ON l.id = ml.location_id
       JOIN product_product p ON p.id = ml.product_id JOIN product_template t ON t.id = p.product_tmpl_id
      WHERE ml.state IN ('assigned', 'partially_available', 'waiting', 'confirmed') AND ml.quantity_product_uom != 0 AND COALESCE(t.is_storable, false)
      GROUP BY ml.product_id, ml.location_id, ml.lot_id, ml.package_id, ml.owner_id, l.usage`, []);
  const key = (r: { product_id: number; location_id: number; lot_id: number | null; package_id: number | null; owner_id: number | null }): string =>
    [r.product_id, r.location_id, r.lot_id, r.package_id, r.owner_id].join(",");
  const reserved = new Map(lines.map((r) => [key(r), r]));
  // stock_location.py:407-409 `should_bypass_reservation`
  const bypass = (usage: string): boolean => ["supplier", "customer", "inventory", "production"].includes(usage);
  for (const q of quants) {
    const ml = reserved.get(key(q))?.r ?? 0;
    if (bypass(q.usage) || (await uomCompare(env, q.r, ml)) !== 0) throw new NotPorted("stock.quant._clean_reservations correcting a reserved quantity");
    reserved.delete(key(q));
  }
  for (const r of reserved.values()) {
    // `_should_bypass_product` is False (stock_quant.py:1601)
    if (!bypass(r.usage)) throw new NotPorted("stock.quant._clean_reservations reserving the quantity of open move lines");
  }
}

/**
 * stock product.py:1142-1178 `_reset_inventory` of templates made storable: the done move lines of their variants
 * into or out of internal and transit locations, less what the quants there hold, would be reset with quants and an
 * inventory adjustment; the port refuses when there is any (none: nothing happens).
 */
export async function resetInventory(env: Environment, templates: readonly number[]): Promise<void> {
  if (!templates.length) return;
  const variants = await variantsOf(env, templates);
  if (!variants.length) return;
  const lineIds = await env.model("stock.move.line").search(parseDomain([["product_id", "in", variants], ["state", "=", "done"],
    "|", ["location_usage", "in", ["internal", "transit"]], ["location_dest_usage", "in", ["internal", "transit"]]]));
  const ledger = new Map<string, number>();
  const add = (product: number, location: number, q: number): void => { const k = `${product},${location}`; ledger.set(k, (ledger.get(k) ?? 0) + q); };
  for (const l of await rows<{ product_id: number; location_id: number; location_dest_id: number; q: number; su: string; du: string }>(env,
    `SELECT ml.product_id, ml.location_id, ml.location_dest_id, ml.quantity_product_uom::float8 AS q, s.usage AS su, d.usage AS du
       FROM stock_move_line ml JOIN stock_location s ON s.id = ml.location_id JOIN stock_location d ON d.id = ml.location_dest_id
      WHERE ml.id = ANY($1::int[]) ORDER BY ml.id`, [lineIds])) {
    if (["internal", "transit"].includes(l.su)) add(l.product_id, l.location_id, -l.q);
    if (["internal", "transit"].includes(l.du)) add(l.product_id, l.location_dest_id, l.q);
  }
  const quantIds = await env.model("stock.quant").search(parseDomain([["product_id", "in", variants], ["location_id.usage", "in", ["internal", "transit"]]]));
  for (const q of await rows<{ product_id: number; location_id: number; q: number }>(env,
    "SELECT product_id, location_id, sum(quantity)::float8 AS q FROM stock_quant WHERE id = ANY($1::int[]) GROUP BY product_id, location_id", [quantIds])) {
    const k = `${q.product_id},${q.location_id}`;
    if (ledger.has(k)) ledger.set(k, ledger.get(k)! - q.q);
  }
  for (const v of ledger.values()) {
    if ((await uomCompare(env, v, 0)) !== 0) throw new NotPorted("stock product.template._reset_inventory of moves the quants do not hold (inventory reset)");
  }
}

// ------------------------------------------------------------------------------------- stock_account: the category

/**
 * stock_account product.py:38-44: the variants of the templates whose costing method differs from the new
 * category's (`category.property_cost_method` in the environment's company, the company's without a category).
 */
export async function costMethodChanges(env: Environment, templates: readonly number[], categ: unknown): Promise<number[]> {
  const id = typeof categ === "number" ? categ : Array.isArray(categ) && typeof categ[0] === "number" ? categ[0] : null;
  let method: unknown;
  if (id) method = (await env.model("product.category").read([id], ["property_cost_method"], ""))[0]?.["property_cost_method"];
  else method = (await env.model("res.company").read([await env.company()], ["cost_method"], ""))[0]?.["cost_method"];
  const out: number[] = [];
  for (const t of await env.model("product.template").read([...templates], ["cost_method"], "")) {
    if (t["cost_method"] !== method) out.push(...await variantsOf(env, [Number(t["id"])]));
  }
  return out;
}

/** stock_account product.py:720-748 `_update_standard_price` after the write: nothing to do for a standard cost. */
export async function updateStandardPrice(env: Environment, variants: readonly number[]): Promise<void> {
  if (!variants.length) return;
  for (const p of await env.model("product.product").read([...variants], ["cost_method", "lot_valuated"], "")) {
    if (p["lot_valuated"] && p["cost_method"] !== "standard") throw new NotPorted("product._update_standard_price of a lot-valuated product (its lots' average cost)");
    if (p["cost_method"] !== "standard") throw new NotPorted(`product._update_standard_price in ${String(p["cost_method"])} (the cost replayed from the moves)`);
  }
}

// ------------------------------------------------------------------------------------------ the quantity on hand

/** stock product.py:980-987 template `_inverse_qty_available`: the quantity goes to the first active variant. */
export async function inverseTemplateQtyAvailable(env: Environment, templates: readonly number[], qty: number): Promise<void> {
  if (env.context["skip_qty_available_update"]) return;
  for (const t of templates) {
    const [variant] = await variantsOf(env, [t]);
    if (variant === undefined) {
      if (qty) throw new UserError(translate(env, "Save the product form before updating the Quantity On Hand."));
      continue;
    }
    await inverseVariantQtyAvailable(env, [variant], qty);
  }
}

/**
 * stock product.py:276-298 variant `_inverse_qty_available`: a storable good with a quantity not below zero gets a
 * quant counted at it in the stock location of the company's first warehouse, applied at once (`from_inverse_qty`: no
 * move when the count is the quantity already there).
 */
export async function inverseVariantQtyAvailable(env: Environment, variants: readonly number[], qty: number): Promise<void> {
  if (env.context["skip_qty_available_update"]) return;
  let location: number | null | undefined;
  for (const p of await env.model("product.product").read([...variants], ["type", "is_storable"], "")) {
    if (!(p["type"] === "consu" && p["is_storable"] && (await uomCompare(env, qty, 0)) >= 0)) continue;
    if (location === undefined) {
      const [warehouse] = await env.model("stock.warehouse").search(cond("company_id", "=", await env.company()), { limit: 1 });
      location = warehouse === undefined ? null
        : (await rows<{ l: number | null }>(env, "SELECT lot_stock_id AS l FROM stock_warehouse WHERE id = $1", [warehouse]))[0]?.l ?? null;
    }
    if (location === null) throw new NotPorted("product qty_available inverse without a warehouse in the company (a quant without location)");
    const qenv = env.withContext({ ...env.context, inventory_mode: true, from_inverse_qty: true });
    const quants = await create(qenv, "stock.quant", [{ product_id: Number(p["id"]), location_id: location, inventory_quantity: qty }]);
    const { applyInventory } = await import("./stock_inventory");
    await applyInventory(qenv, quants);
  }
}

// ----------------------------------------------------------------------------------------------- product.product

/**
 * product_product.py:420-432 `_check_barcode_uniqueness` per run of variants of one company (`groupby`): no two
 * active variants with a barcode (:371-384), no template but the variant's mirroring one (:386-413), no packaging
 * (:415-418). A duplicate refuses: its message (`_build_duplicate_barcode_error_string`) is not ported; a packaging
 * raises Odoo's error.
 */
export async function checkVariantBarcodes(env: Environment, ids: readonly number[]): Promise<void> {
  if (env.context["skip_barcode_uniqueness_check"] || !ids.length) return;
  const info = await rows<{ id: number; barcode: string | null; company_id: number | null; t: number }>(env,
    `SELECT p.id, p.barcode, t.company_id, t.id AS t FROM product_product p JOIN product_template t ON t.id = p.product_tmpl_id WHERE p.id = ANY($1::int[])`, [[...ids]]);
  const byId = new Map(info.map((r) => [r.id, r]));
  const ordered = ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => r !== undefined);
  const su = env.sudo();
  for (let i = 0; i < ordered.length;) {
    const company = ordered[i]!.company_id;
    let j = i;
    while (j < ordered.length && ordered[j]!.company_id === company) j++;
    const run = ordered.slice(i, j);
    i = j;
    const barcodes = run.map((r) => r.barcode).filter((b): b is string => Boolean(b));
    if (!barcodes.length) continue;
    const domain: unknown[] = [["barcode", "in", barcodes]];
    if (company) domain.push(["company_id", "in", [false, company]]);
    const products = await su.model("product.product").search(parseDomain(domain));
    if (products.length && (await rows(env, "SELECT 1 FROM product_product WHERE id = ANY($1::int[]) GROUP BY barcode HAVING count(*) > 1 LIMIT 1", [products])).length) {
      throw new NotPorted("product.product barcode already assigned to another variant (duplicate barcode message)");
    }
    const mirrored: number[] = [];
    for (const t of new Set(run.map((r) => r.t))) if ((await variantsOf(env, [t])).length === 1) mirrored.push(t);
    const templates = await su.model("product.template").search(parseDomain([...domain, ["id", "not in", mirrored]]));
    if (templates.length) throw new NotPorted("product.product barcode already assigned to a template (duplicate barcode message)");
    if ((await su.model("product.uom").search(parseDomain(domain), { limit: 1 })).length) {
      throw new ValidationError(translate(env, "A packaging already uses the barcode"));
    }
  }
}

/** stock product.py:697-701: a variant archived or unarchived takes its orderpoints with it (active_test=False). */
export async function orderpointsFollow(env: Environment, ids: readonly number[], active: unknown): Promise<void> {
  const changing = (await rows<{ id: number }>(env, "SELECT id FROM product_product WHERE id = ANY($1::int[]) AND active IS DISTINCT FROM $2", [[...ids], Boolean(active)])).map((r) => r.id);
  if (!changing.length) return;
  const aenv = env.withContext({ ...env.context, active_test: false });
  const points = await aenv.model("stock.warehouse.orderpoint").search(cond("product_id", "in", changing), { activeTest: false });
  if (points.length) await write(aenv, "stock.warehouse.orderpoint", points, { active: active });
}

// --------------------------------------------------------------------------------------------------- constraints

registerOverrides("product.template", {
  constraints: [
    // account product.py:243-262 `_check_uom_not_in_invoice`
    {
      fields: ["uom_id"],
      fn: async (env, ids) => {
        if (!ids.length) return;
        const hit = await rows(env, `SELECT t.id FROM account_move_line line
            JOIN product_product v ON line.product_id = v.id JOIN product_template t ON v.product_tmpl_id = t.id
           WHERE t.id = ANY($1::int[]) AND line.parent_state = 'posted' AND t.uom_id != line.product_uom_id LIMIT 1`, [[...ids]]);
        if (hit.length) {
          throw new ValidationError(translate(env, "This product is already being used in posted Journal Entries.\nIf you want to change its Unit of Measure, please archive this product and create a new one."));
        }
      },
    },
    // sale_project product_template.py:115-127 `_check_project_and_template`
    {
      fields: ["project_id", "project_template_id"],
      fn: async (env, ids) => {
        if (!env.reg.model("product.template").fields.has("project_template_id")) return;
        for (const t of await env.model("product.template").read([...ids], ["name", "service_tracking", "project_id", "project_template_id"], "")) {
          const tracking = t["service_tracking"], project = Boolean(t["project_id"]), template = Boolean(t["project_template_id"]);
          const name = String(t["name"] ?? "");
          if (tracking === "no" && (project || template)) {
            throw new ValidationError(translate(env, "The product %s should not have a project nor a project template since it will not generate project.").replace("%s", name));
          } else if (tracking === "task_global_project" && template) {
            throw new ValidationError(translate(env, "The product %s should not have a project template since it will generate a task in a global project.").replace("%s", name));
          } else if ((tracking === "task_in_project" || tracking === "project_only") && project) {
            throw new ValidationError(translate(env, "The product %s should not have a global project since it will generate a project.").replace("%s", name));
          }
        }
      },
    },
  ],
});

// ----------------------------------------------------------------------------------------------- archive

/** product_template.py:861-870 `action_archive`: a product of a combo cannot be archived. */
registerMethod("product.template", "action_archive", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const ids = ids0 ?? [];
  const variants = await variantsOf(env, ids);
  const items = await env.model("product.combo.item").search(cond("product_id", "in", variants));
  if (items.length) {
    const names = await rows<{ n: string }>(env, `SELECT COALESCE(c.name->>$2, c.name->>'en_US') AS n FROM product_combo_item i JOIN product_combo c ON c.id = i.combo_id
       WHERE i.id = ANY($1::int[]) GROUP BY c.id, c.name ORDER BY min(array_position($1::int[], i.id))`, [items, env.lang ?? "en_US"]);
    throw new UserError(translate(env, "You cannot archive a product that is part of a combo. Please remove it from the following combos first: %s").replace("%s", names.map((r) => r.n).join(", ")));
  }
  const { setActiveOf } = await import("../web/save");
  return setActiveOf(env, "product.template", ids, false);
}, { apiModel: false });

// ------------------------------------------------------------------------------------------------------- copy

/**
 * product_template.py:872-944 copy, then stock product.py:1180-1194: the copied templates' price extras and pricelist
 * rules, and the variants' storage capacities. Templates with attribute lines refuse (the variants are matched by
 * their attribute values); a template without gets one variant, the match of the original's.
 */
registerMethod("product.template", "copy", async (env0, ids0, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const dflt = kwargs["default"] ?? args[0];
  if (dflt !== undefined && dflt !== null && dflt !== false && (typeof dflt !== "object" || Array.isArray(dflt))) throw new NotPorted("copy default");
  const ids = ids0 ?? [];
  if ((await rows(env, "SELECT 1 FROM product_template_attribute_line WHERE product_tmpl_id = ANY($1::int[]) LIMIT 1", [[...ids]])).length) {
    throw new NotPorted("product.template copy with attribute lines (price extras and variants matched by their values)");
  }
  const created = await copy(env, "product.template", ids, (dflt && typeof dflt === "object" ? dflt : {}) as Record<string, unknown>, true);
  for (const [i, template] of ids.entries()) {
    const twin = created[i]!;
    const [a, b] = await rows<{ id: number; c: number | null }>(env, "SELECT id, company_id AS c FROM product_template WHERE id = ANY($1::int[]) ORDER BY array_position($1::int[], id)", [[template, twin]]);
    if (a?.c !== b?.c) continue;
    // :897-907 the template's rules (searched as the user, ordered by id), copied onto the copy
    const pricings = await env.model("product.pricelist.item").search(cond("product_tmpl_id", "=", template), { order: "id" });
    if (pricings.length) {
      const variantSpecific = (await rows<{ id: number }>(env, "SELECT id FROM product_pricelist_item WHERE id = ANY($1::int[]) AND product_id IS NOT NULL", [pricings])).map((r) => r.id);
      if (variantSpecific.length) throw new NotPorted("product.template copy of variant-specific pricelist rules");
      await copy(env, "product.pricelist.item", pricings, { product_tmpl_id: twin });
    }
  }
  // stock product.py:1180-1194 the variants' storage category capacities
  const capacities = await rows<{ id: number }>(env, `SELECT c.id FROM stock_storage_category_capacity c JOIN product_product p ON p.id = c.product_id
     WHERE p.product_tmpl_id = ANY($1::int[]) AND p.active LIMIT 1`, [[...ids]]);
  if (capacities.length) throw new NotPorted("product.template copy of storage category capacities");
  return created;
}, { apiModel: false });
