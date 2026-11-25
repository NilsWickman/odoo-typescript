/**
 * Validating a transfer: stock_picking.py:1176-1245 `button_validate` (`_sanity_check` :1129-1173,
 * `_pre_action_done_hook` :1272-1291 with stock_sms, `_check_backorder` :1353-1366, `_action_done` :996-1043),
 * stock_move.py:2353-2435 `_action_done` with stock_account stock_move.py:248-259 (`_set_value` of incoming moves at
 * the purchase price, purchase_stock stock_move.py:262-277), purchase_stock/sale_stock `_action_synch_order`, and
 * stock_move_line.py:593-720 `_action_done` (quants through `_synchronize_quant`). Lots, packages, owners, backorders
 * through the wizard, cancelled remainders and real-time valuation refuse with NotPorted; push rules and the chained
 * destination moves are src/models/stock_push.ts.
 */
import { convertAmount } from "./currency_convert";
import { roundPrecision } from "./account_tax_engine";
import { currencyData } from "./account_taxes";
import { extraValue } from "./stock_extra_value";
import { NotPorted, UserError, ValidationError } from "../errors";
import { registerMethod } from "../http/methods";
import { trackPrepare } from "../mail/tracking";
import { closeTrackingScope } from "../mail/write_hooks";
import { hasGroup } from "../orm/env";
import { floatRound } from "../orm/convert";
import type { Environment } from "../orm/types";
import { write } from "../orm/write";
import { create } from "../orm/create";
import { unlink } from "../orm/unlink";
import { xmlid } from "../mail/message";
import { actionAssign, actionConfirm, cancelMoves, contextToday, moveRows, nowString, pickingActionConfirm, uomCompare, uomQuantityRaw, unitDigits, updateAvailableQuantity } from "./stock_engine";
import { uomQuantity } from "./sale_flow";
import { applyDestToPackage, checkEntirePack, preparePackageHistoryVals } from "./sweep2_stock_sale";
import { pyFloatReprSimple, translate } from "./util";
import { deferNotes, flushDeferredNotes } from "./purchase_flow";
import { backorderWizardAction, createBackorders, splitRemainders } from "./stock_backorder";
import { assertNoAllocation, assignDestMoves, pushApply } from "./stock_push";
import { fifoValue, productCost, remainingByMove, roundCurrency, updateStandardPrice, valuedMoves } from "./stock_valuation";
import { withCompany } from "./tail_util";
import { DbRec, RecomputeQueue } from "../orm/recompute";
import * as priv from "../orm/dispatch_gen";

async function rows<T extends object>(env: Environment, text: string, params: unknown[]): Promise<T[]> {
  return (await env.cr.query<T & Record<string, unknown>>(text, params)).rows;
}

const BYPASS = ["supplier", "customer", "inventory", "production"];

interface PickingRow { id: number; name: string; state: string; type_code: string; create_backorder: string; owner_id: number | null; batch_id: number | null; project_id: number | null; company_id: number; use_lots: boolean; auto_print: boolean }

async function pickingRows(env: Environment, ids: readonly number[]): Promise<PickingRow[]> {
  return rows<PickingRow>(env,
    `SELECT p.id, p.name, p.state, t.code AS type_code, t.create_backorder, p.owner_id, p.batch_id, p.project_id, p.company_id,
            (COALESCE(t.use_create_lots, false) OR COALESCE(t.use_existing_lots, false)) AS use_lots,
            (COALESCE(t.auto_print_delivery_slip, false) OR COALESCE(t.auto_print_return_slip, false) OR COALESCE(t.auto_print_product_labels, false)
              OR COALESCE(t.auto_print_lot_labels, false) OR COALESCE(t.auto_print_reception_report, false) OR COALESCE(t.auto_print_reception_report_labels, false)
              OR COALESCE(t.auto_print_packages, false) OR COALESCE(t.auto_print_package_label, false)) AS auto_print
       FROM stock_picking p JOIN stock_picking_type t ON t.id = p.picking_type_id WHERE p.id = ANY($1::int[]) ORDER BY p.priority DESC, p.scheduled_date ASC, p.id DESC`, [[...ids]]);
}

/** stock_move.py `_get_picked_quantity`. */
async function pickedQuantity(env: Environment, move: number): Promise<number> {
  const [m] = await rows<{ picked: boolean | null; quantity: number; uom_id: number }>(env, "SELECT picked, quantity::float8 AS quantity, uom_id FROM stock_move WHERE id = $1", [move]);
  const lines = await rows<{ picked: boolean | null; quantity: number; uom_id: number }>(env, "SELECT picked, quantity::float8 AS quantity, uom_id FROM stock_move_line WHERE move_id = $1 ORDER BY id", [move]);
  if (m!.picked && lines.some((l) => !l.picked)) {
    let qty = 0;
    for (const l of lines) {
      if (!l.picked) continue;
      qty += l.uom_id === m!.uom_id ? l.quantity : await uomQuantityRaw(env, l.quantity, l.uom_id, m!.uom_id);
    }
    return qty;
  }
  return m!.quantity;
}

/** stock_move_line.py:593-720 `_action_done` (supports lots and packages; owners refuse). */
async function moveLinesDone(env: Environment, lineIds: readonly number[]): Promise<void> {
  if (!lineIds.length) return;
  const lines = await rows<{ id: number; quantity: number; qty_product: number; tracking: string; product_id: number; location_id: number; location_dest_id: number; storable: boolean;
    lot_id: number | null; package_id: number | null; result_package_id: number | null; owner_id: number | null; is_inventory: boolean | null; move_id: number; picking_id: number | null }>(env,
    `SELECT l.id, l.quantity::float8 AS quantity, l.quantity_product_uom::float8 AS qty_product, COALESCE(t.tracking, 'none') AS tracking, l.product_id, l.location_id,
            l.location_dest_id, COALESCE(t.is_storable, false) AS storable, l.lot_id, l.package_id, l.result_package_id, l.owner_id, m.is_inventory, l.move_id, l.picking_id
       FROM stock_move_line l JOIN stock_move m ON m.id = l.move_id JOIN product_product p ON p.id = l.product_id JOIN product_template t ON t.id = p.product_tmpl_id WHERE l.id = ANY($1::int[])`, [[...lineIds]]);
  const byId = new Map(lines.map((l) => [l.id, l]));
  const ordered = lineIds.map((id) => byId.get(id)!).filter((l) => l !== undefined);
  const toDelete: number[] = [];
  const withoutLot: number[] = [];
  const toCheck = new Map<string, number[]>();
  for (const ml of ordered) {
    if (ml.owner_id) throw new NotPorted("stock.move.line._action_done with owners");
    const cmp = await uomCompare(env, ml.quantity, 0);
    if (cmp > 0) {
      if (ml.tracking !== "lot" && ml.tracking !== "serial") continue;
      const [t] = await rows<{ type: number | null; c: boolean | null; e: boolean | null; scrap: boolean | null; company_id: number }>(env,
        `SELECT m.picking_type_id AS type, t.use_create_lots AS c, t.use_existing_lots AS e, m.is_scrap AS scrap, l.company_id
           FROM stock_move_line l JOIN stock_move m ON m.id = l.move_id LEFT JOIN stock_picking_type t ON t.id = m.picking_type_id WHERE l.id = $1`, [ml.id]);
      // :585-587 `_exclude_requiring_lot`
      if (!(t!.type || ml.is_inventory || ml.lot_id || t!.scrap)) { withoutLot.push(ml.id); continue; }
      if (!t!.type || ml.lot_id || (!t!.c && !t!.e)) continue;
      if (t!.c) {
        const key = `${ml.product_id}/${t!.company_id}`;
        toCheck.set(key, [...(toCheck.get(key) ?? []), ml.id]);
      } else withoutLot.push(ml.id);
      continue;
    }
    if (cmp < 0) throw new UserError(translate(env, "No negative quantities allowed"));
    if (!ml.is_inventory) toDelete.push(ml.id);
  }
  // :646-660 an existing lot of the name is assigned, a new name gets its lot created
  const toCreate: number[] = [];
  for (const [key, ids] of toCheck) {
    const [product, company] = key.split("/").map(Number) as [number, number];
    const names = await rows<{ id: number; lot_name: string | null }>(env, "SELECT id, lot_name FROM stock_move_line WHERE id = ANY($1::int[])", [ids]);
    const found = await rows<{ id: number; name: string }>(env,
      "SELECT id, name FROM stock_lot WHERE (company_id IS NULL OR company_id = $1) AND product_id = $2 AND name = ANY($3::text[]) ORDER BY name, id",
      [company, product, names.map((n) => n.lot_name).filter((n): n is string => !!n)]);
    const lots = new Map(found.map((l) => [l.name, l.id]));
    for (const id of ids) {
      const name = names.find((n) => n.id === id)!.lot_name;
      const lot = name ? lots.get(name) : undefined;
      if (lot !== undefined) await write(env, "stock.move.line", [id], { lot_id: lot });
      else if (name) toCreate.push(id);
      else withoutLot.push(id);
    }
  }
  if (withoutLot.length) {
    const products = await rows<{ product_id: number }>(env, "SELECT product_id FROM stock_move_line WHERE id = ANY($1::int[]) ORDER BY array_position($1::int[], id)", [withoutLot]);
    const uniq = [...new Set(products.map((p) => p.product_id))];
    const names = await env.model("product.product").displayName(uniq);
    throw new UserError(translate(env, "You need to supply a Lot/Serial Number for product:\n%(products)s", "stock").replace("%(products)s", uniq.map((p) => `- ${names.get(p) ?? ""}`).join("\n")));
  }
  if (toCreate.length) await createAndAssignLots(env, toCreate);
  // :676-679 unlink empty lines, keep remaining lines in mlsTodo
  if (toDelete.length) await unlink(env, "stock.move.line", toDelete);
  const deletedSet = new Set(toDelete);
  const mlsTodo = ordered.filter((ml) => !deletedSet.has(ml.id));
  if (!mlsTodo.length) return;
  for (const ml of mlsTodo) ml.lot_id = (await rows<{ l: number | null }>(env, "SELECT lot_id AS l FROM stock_move_line WHERE id = $1", [ml.id]))[0]!.l;

  // :688-692 Prepare package history records before any actual move
  const resultPkgIds = [...new Set(mlsTodo.map((ml) => ml.result_package_id).filter((p): p is number => p !== null))];
  if (!env.context["ignore_dest_packages"] && resultPkgIds.length) {
    const historyVals = await preparePackageHistoryVals(env, resultPkgIds);
    if (historyVals.length) await create(env, "stock.package.history", historyVals);
  }

  const processed: number[] = []; // :683 `ml_ids_to_ignore`, the lines already moved
  const movesToCheckPack = new Set<number>();
  for (const ml of mlsTodo) {
    if (!ml.storable || (await uomCompare(env, ml.qty_product, 0)) === 0) { processed.push(ml.id); continue; }
    // `_synchronize_quant(-qty, location, action="reserved")`: the reservation leaves the source
    const [m] = await moveRows(env, [ml.move_id]);
    const srcUsage = (await rows<{ u: string }>(env, "SELECT usage AS u FROM stock_location WHERE id = $1", [ml.location_id]))[0]!.u;
    if (!(BYPASS.includes(srcUsage) || !m!.storable)) await updateAvailableQuantity(env, ml.product_id, ml.location_id, 0, -ml.qty_product, null, ml.lot_id, ml.package_id);
    const inDate = await updateAvailableQuantity(env, ml.product_id, ml.location_id, -ml.qty_product, 0, null, ml.lot_id, ml.package_id);
    // the returned `_get_available_quantity(strict=True, allow_negative=True)`: the lot's quants, or the untracked ones
    const [after] = await rows<{ q: number; r: number }>(env,
      `SELECT COALESCE(sum(quantity), 0)::float8 AS q, COALESCE(sum(reserved_quantity), 0)::float8 AS r FROM stock_quant
        WHERE product_id = $1 AND location_id = $2 AND lot_id IS NOT DISTINCT FROM $3 AND package_id IS NOT DISTINCT FROM $4 AND owner_id IS NULL`,
      [ml.product_id, ml.location_id, ml.lot_id, ml.package_id]);
    const availQty = after!.q - after!.r;
    if (ml.lot_id !== null && availQty < 0) {
      // :754-761 a negative lot is compensated with untracked quants of the location (their positive availability)
      const [u] = await rows<{ v: number }>(env,
        `SELECT COALESCE(sum(quantity - COALESCE(reserved_quantity, 0)), 0)::float8 AS v FROM stock_quant
          WHERE product_id = $1 AND location_id = $2 AND lot_id IS NULL AND package_id IS NOT DISTINCT FROM $3 AND owner_id IS NULL`,
        [ml.product_id, ml.location_id, ml.package_id]);
      const untrackedQty = (await uomCompare(env, u!.v, 0)) > 0 ? u!.v : 0;
      if (untrackedQty > 0) {
        const taken = Math.min(untrackedQty, Math.abs(ml.qty_product));
        await updateAvailableQuantity(env, ml.product_id, ml.location_id, -taken, 0, inDate, null, ml.package_id);
        await updateAvailableQuantity(env, ml.product_id, ml.location_id, taken, 0, inDate, ml.lot_id, ml.package_id);
      }
    }
    await updateAvailableQuantity(env, ml.product_id, ml.location_dest_id, ml.qty_product, 0, inDate, ml.lot_id, ml.result_package_id);
    if (availQty < 0 && !BYPASS.includes(srcUsage) && m!.storable) {
      const reassigned = await freeReservation(env, ml, -availQty, [...processed, ml.id]);
      for (const rm of reassigned) movesToCheckPack.add(rm);
    }
    processed.push(ml.id);
    // :697-699 a lot leaving through a delivery gets the transfer's partner (`_get_lot_partner`)
    if (ml.lot_id !== null) {
      const [pk] = await rows<{ code: string | null; partner: number | null; dropship: boolean | null }>(env,
        // stock_dropshipping stock.py:37-41 `_compute_is_dropship` (not stored)
        `SELECT t.code, p.partner_id AS partner,
                ((s.usage = 'supplier' OR (s.usage = 'transit' AND s.company_id IS NULL)) AND (d.usage = 'customer' OR (d.usage = 'transit' AND d.company_id IS NULL))) AS dropship
           FROM stock_move m JOIN stock_picking p ON p.id = m.picking_id JOIN stock_picking_type t ON t.id = p.picking_type_id
           JOIN stock_location s ON s.id = p.location_id JOIN stock_location d ON d.id = p.location_dest_id WHERE m.id = $1`, [ml.move_id]);
      if (pk?.code === "outgoing") {
        if (pk.dropship) throw new NotPorted("stock_dropshipping _get_lot_partner of a dropship");
        if (pk.partner) {
          const have = (await rows<{ p: number }>(env, "SELECT res_partner_id AS p FROM res_partner_stock_lot_rel WHERE stock_lot_id = $1", [ml.lot_id])).map((r) => r.p);
          if (!have.includes(pk.partner)) await write(env, "stock.lot", [ml.lot_id], { partner_ids: [[6, 0, [...have, pk.partner]]] });
        }
      }
    }
  }

  // :713-720 apply destination containers & check entire packs on affected pickings
  if (!env.context["ignore_dest_packages"] && resultPkgIds.length) {
    await applyDestToPackage(env, resultPkgIds);
  }
  const affectedPickings = new Set<number>(mlsTodo.map((ml) => ml.picking_id).filter((p): p is number => p !== null));
  if (movesToCheckPack.size) {
    for (const r of await rows<{ p: number | null }>(env, "SELECT DISTINCT picking_id AS p FROM stock_move WHERE id = ANY($1::int[]) AND picking_id IS NOT NULL", [[...movesToCheckPack]])) {
      if (r.p !== null) affectedPickings.add(r.p);
    }
  }
  if (affectedPickings.size) await checkEntirePack(env, [...affectedPickings]);
}

/**
 * stock_move_line.py:829-891 `_free_reservation` of a line moved past the quantity there is: the other lines reserving
 * the same product, lot, package and location (not done, not picked, without owner), the current transfer's first,
 * then the latest scheduled first, are unlinked (or the last one reduced) up to the missing quantity; their moves go
 * back to make-to-stock without origin moves and are assigned again, in reverse order.
 */
async function freeReservation(env: Environment, ml: { id: number; move_id: number; product_id: number; location_id: number; lot_id: number | null; package_id: number | null },
  missing: number, ignore: readonly number[]): Promise<number[]> {
  const own = (await rows<{ p: number | null }>(env, "SELECT picking_id AS p FROM stock_move WHERE id = $1", [ml.move_id]))[0]?.p ?? null;
  const candidates = await rows<{ id: number; move_id: number | null; qty: number; quantity: number; uom_id: number; product_uom: number }>(env,
    `SELECT l.id, l.move_id, l.quantity_product_uom::float8 AS qty, l.quantity::float8 AS quantity, l.uom_id, t.uom_id AS product_uom
       FROM stock_move_line l LEFT JOIN stock_picking p ON p.id = l.picking_id LEFT JOIN stock_move m ON m.id = l.move_id
       JOIN product_product pp ON pp.id = l.product_id JOIN product_template t ON t.id = pp.product_tmpl_id
      WHERE l.product_id = $1 AND l.location_id = $2 AND l.lot_id IS NOT DISTINCT FROM $3 AND l.owner_id IS NULL AND l.package_id IS NOT DISTINCT FROM $6
        AND COALESCE(l.state, '') NOT IN ('done', 'cancel') AND l.quantity_product_uom > 0 AND NOT COALESCE(l.picked, false) AND l.id != ALL($4::int[])
      ORDER BY (l.picking_id IS DISTINCT FROM $5), COALESCE(p.scheduled_date, m.date) DESC NULLS LAST, l.id DESC`,
    [ml.product_id, ml.location_id, ml.lot_id, [...ignore], own, ml.package_id]);
  const reassign: number[] = [];
  const unlinkIds: number[] = [];
  let quantity = missing;
  for (const c of candidates) {
    if (c.move_id !== null && !reassign.includes(c.move_id)) reassign.push(c.move_id);
    if ((await uomCompare(env, c.qty, quantity)) <= 0) {
      quantity -= c.qty;
      unlinkIds.push(c.id);
      if ((await uomCompare(env, quantity, 0)) === 0) break;
    } else {
      const sub = c.uom_id === c.product_uom ? quantity : await uomQuantity(env, quantity, c.product_uom, c.uom_id, "HALF-UP");
      await write(env, "stock.move.line", [c.id], { quantity: c.quantity - sub });
      break;
    }
  }
  const unlinkMoves = unlinkIds.length ? (await rows<{ m: number }>(env, "SELECT DISTINCT move_id AS m FROM stock_move_line WHERE id = ANY($1::int[]) AND move_id IS NOT NULL", [unlinkIds])).map((r) => r.m) : [];
  for (const m of [...new Set([...unlinkMoves, ...reassign])]) await write(env, "stock.move", [m], { procure_method: "make_to_stock", move_orig_ids: [[5, 0, 0]] });
  if (unlinkIds.length) await unlink(env, "stock.move.line", unlinkIds);
  if (reassign.length) await actionAssign(env.withContext({ ...env.context, bypass_entire_pack: true }), [...reassign].reverse());
  return reassign;
}

/**
 * stock_move_line.py:790-806 `_create_and_assign_production_lot` (lot tracking: one lot per product and name) with
 * :780-788 `_prepare_new_lot_vals`, then each group of lines gets its lot.
 */
async function createAndAssignLots(env: Environment, lineIds: readonly number[]): Promise<void> {
  const lines = await rows<{ id: number; product_id: number; lot_name: string; company_id: number; product_company: number | null }>(env,
    `SELECT l.id, l.product_id, l.lot_name, l.company_id, t.company_id AS product_company FROM stock_move_line l
       JOIN product_product p ON p.id = l.product_id JOIN product_template t ON t.id = p.product_tmpl_id
      WHERE l.id = ANY($1::int[]) ORDER BY array_position($1::int[], l.id)`, [[...lineIds]]);
  const keys = new Map<string, number[]>();
  const vals: Record<string, unknown>[] = [];
  const index = new Map<string, number>();
  for (const l of lines) {
    const key = `${l.product_id}/${l.lot_name}`;
    keys.set(key, [...(keys.get(key) ?? []), l.id]);
    if (index.has(key)) continue;
    index.set(key, vals.length);
    const v: Record<string, unknown> = { name: l.lot_name, product_id: l.product_id };
    if (l.product_company !== null) {
      // `self.company_id in (product.company_id.all_child_ids | product.company_id)`
      const [c] = await rows<{ ok: boolean }>(env,
        "SELECT EXISTS (SELECT 1 FROM res_company WHERE id = $1 AND (id = $2 OR parent_path LIKE (SELECT parent_path FROM res_company WHERE id = $2) || '%')) AS ok", [l.company_id, l.product_company]);
      if (c!.ok) v["company_id"] = l.company_id;
    }
    vals.push(v);
  }
  const lots = await create(env, "stock.lot", vals);
  for (const [key, ids] of keys) await write(env, "stock.move.line", ids, { lot_id: lots[index.get(key)!]! });
}

/** stock_move.py:2353-2435 `_action_done` and stock_account :248-259. */
export async function movesDone(env0: Environment, moveIds: readonly number[], cancelBackorder: boolean): Promise<number[]> {
  const env = env0.sudo();
  const all = await moveRows(env, moveIds);
  const draftIds = all.filter((m) => m.state === "draft").map((m) => m.id);
  let confirmedIds: number[] = [];
  if (draftIds.length) confirmedIds = await actionConfirm(env, draftIds, { merge: false });
  const combinedIds = [...new Set([...moveIds, ...confirmedIds])];
  const moves = (await moveRows(env, combinedIds)).filter((m) => !["done", "cancel"].includes(m.state));
  const mlIdsToUnlink: number[] = [];
  for (const m of moves) {
    if (m.picked) {
      const unpicked = await rows<{ id: number }>(env, "SELECT id FROM stock_move_line WHERE move_id = $1 AND NOT COALESCE(picked, false) ORDER BY id", [m.id]);
      for (const u of unpicked) if (!mlIdsToUnlink.includes(u.id)) mlIdsToUnlink.push(u.id);
    }
    const [inv] = await rows<{ i: boolean | null }>(env, "SELECT is_inventory AS i FROM stock_move WHERE id = $1", [m.id]);
    if ((m.quantity <= 0 || !m.picked) && !inv?.i) {
      if ((await uomCompare(env, m.product_uom_qty, 0)) === 0 || cancelBackorder) {
        await cancelMoves(env, [m.id]);
      }
    }
  }
  if (mlIdsToUnlink.length) {
    const alive = (await rows<{ id: number }>(env, "SELECT id FROM stock_move_line WHERE id = ANY($1::int[]) ORDER BY id", [mlIdsToUnlink])).map((r) => r.id);
    if (alive.length) await unlink(env, "stock.move.line", alive);
  }
  const refreshed = await moveRows(env, moves.map((m) => m.id));
  const invMap = new Map((await rows<{ id: number; i: boolean | null }>(env, "SELECT id, is_inventory AS i FROM stock_move WHERE id = ANY($1::int[])", [refreshed.map((m) => m.id)])).map((r) => [r.id, Boolean(r.i)]));
  const todo = refreshed.filter((m) => !(m.state === "cancel" || (m.quantity <= 0 && !invMap.get(m.id)) || !m.picked));
  if (!todo.length) return [];
  // :2371-2374 `_create_backorder` of the moves being done: their remainders become new moves of the same transfer
  if (!cancelBackorder) await splitRemainders(env, todo.map((m) => m.id));
  const lines = (await rows<{ id: number }>(env, "SELECT id FROM stock_move_line WHERE move_id = ANY($1::int[]) ORDER BY result_package_id DESC NULLS LAST, id", [todo.map((m) => m.id)])).map((r) => r.id);
  await moveLinesDone(env, lines);
  // :2380-2396 check consistency of result packages and unlink zero quants when moving an entire package
  const todoIds = todo.map((m) => m.id);
  const resPkgs = (await rows<{ p: number }>(env,
    "SELECT DISTINCT result_package_id AS p FROM stock_move_line WHERE move_id = ANY($1::int[]) AND COALESCE(picked, false) AND result_package_id IS NOT NULL", [todoIds])).map((r) => r.p);
  if (resPkgs.length) {
    const badPkgs = await rows<{ id: number; name: string }>(env,
      `SELECT p.id, p.name FROM stock_quant q JOIN stock_package p ON p.id = q.package_id
        WHERE q.package_id = ANY($1::int[]) AND q.quantity > 0
        GROUP BY p.id, p.name HAVING count(DISTINCT q.location_id) > 1 ORDER BY p.name, p.id`, [resPkgs]);
    if (badPkgs.length) {
      const packageNames = badPkgs.map((p) => `\t${p.name}`).join("\n");
      throw new UserError(
        translate(env, "A package cannot be moved multiple times within a single transfer or split across multiple locations.\n\nConcerned package(s):\n%(package_names)s", "stock")
          .replace("%(package_names)s", packageNames),
      );
    }
  }
  const samePkgMove = await rows(env,
    "SELECT 1 FROM stock_move_line WHERE move_id = ANY($1::int[]) AND package_id IS NOT NULL AND package_id = result_package_id LIMIT 1", [todoIds]);
  if (samePkgMove.length) {
    const prec = Math.max(6, (await unitDigits(env)) * 2);
    const zeros = (await rows<{ id: number }>(env,
      `SELECT id FROM stock_quant
        WHERE (round(quantity::numeric, $1) = 0 OR quantity IS NULL)
          AND round(reserved_quantity::numeric, $1) = 0
          AND (round(inventory_quantity::numeric, $1) = 0 OR inventory_quantity IS NULL)
          AND user_id IS NULL ORDER BY id`, [prec])).map((r) => r.id);
    if (zeros.length) await unlink(env.sudo(), "stock.quant", zeros);
  }
  // the received-quantity note waits for the backorders and the pushed transfers (Odoo's lazy recompute of qty_received)
  deferNotes(env);
  // stock_move.py:2346-2351 `_check_quantity` -> stock_quant.py:619-635 `check_quantity`: a serial number is at most once
  // in a location (the quants of the moves' lots in their destinations and below, summed per product, location, lot).
  // Odoo checks after the state write but logs the pickings' tracking at precommit; the port logs it inside the write,
  // so the check comes first (an error then writes nothing that Odoo would not, not even a sequence number)
  await checkSerialQuantity(env, todoIds);
  await write(env, "stock.move", todoIds, { state: "done", date: await nowString(env) });
  // :2398-2420 `_apply_allocation`, `_push_apply` of the moves `_skip_push` keeps, then their destination moves assigned
  // (src/models/stock_push.ts), as the user (the env the transfer is validated with)
  await assertNoAllocation(env, todoIds);
  await pushApply(env0, todoIds);
  await assignDestMoves(env0, todoIds);
  // :2427-2430 the transfers of the done moves get their backorder
  if (!cancelBackorder) {
    const pickings = (await rows<{ id: number }>(env, "SELECT DISTINCT picking_id AS id FROM stock_move WHERE id = ANY($1::int[]) AND picking_id IS NOT NULL ORDER BY picking_id", [todoIds])).map((r) => r.id);
    if (pickings.length) {
      const backorders = await createBackorders(env, pickings);
      if (backorders.length) {
        const assignedBo = (await rows<{ p: number }>(env, "SELECT DISTINCT picking_id AS p FROM stock_move WHERE picking_id = ANY($1::int[]) AND state = 'assigned'", [backorders])).map((r) => r.p);
        if (assignedBo.length) await checkEntirePack(env, assignedBo);
      }
    }
  }
  await flushDeferredNotes(env);
  // (`_check_quantity` ran before the state write)
  // `_action_synch_order` (purchase_stock, sale_stock): moves without an order line
  for (const m of todo) {
    const [link] = await rows<{ purchase_line_id: number | null; sale_line_id: number | null; purchase_id: number | null; sale_id: number | null }>(env,
      `SELECT m.purchase_line_id, m.sale_line_id, (SELECT r.purchase_order_id FROM purchase_order_stock_picking_rel r WHERE r.stock_picking_id = m.picking_id LIMIT 1) AS purchase_id, p.sale_id
         FROM stock_move m LEFT JOIN stock_picking p ON p.id = m.picking_id WHERE m.id = $1`, [m.id]);
    if (link!.purchase_id && !link!.purchase_line_id) throw new NotPorted("purchase_stock _action_synch_order of a move without purchase line");
    if (link!.sale_id && !link!.sale_line_id) throw new NotPorted("sale_stock _action_synch_order of a move without sale line");
  }
  // stock_move.py:2424-2425: scrap moves return early before `_inverse_description_picking`
  const nonScrap = (await rows<{ id: number }>(env, "SELECT id FROM stock_move WHERE id = ANY($1::int[]) AND NOT COALESCE(is_scrap, false)", [todo.map((m) => m.id)])).map((r) => r.id);
  if (nonScrap.length) {
    // `_inverse_description_picking`: the description of the done move is kept
    const desc = await env.model("stock.move").read(todo.map((m) => m.id), ["description_picking"], "");
    for (const d of desc) await write(env, "stock.move", [Number(d["id"])], { description_picking_manual: d["description_picking"] ?? false });
  }
  await valueMoves(env, todo.map((m) => m.id));
  return todo.map((m) => m.id);
}

/**
 * stock_account stock_move.py:248-259 `_action_done`: `moves_out._set_value()` then `moves_in._set_value()`
 * (stock_move.py:345-438), no journal entry without a location valuation account (:757-765).
 */
async function valueMoves(env: Environment, moveIds: readonly number[]): Promise<void> {
  const dir = await rows<{ id: number; is_in: boolean | null; is_out: boolean | null; is_dropship: boolean | null }>(env,
    "SELECT id, is_in, is_out, is_dropship FROM stock_move WHERE id = ANY($1::int[]) ORDER BY id", [[...moveIds]]);
  if (dir.some((m) => m.is_dropship)) throw new NotPorted("stock_account _set_value of a dropship");
  await setValue(env, dir.filter((m) => m.is_out).map((m) => m.id));
  await setValue(env, dir.filter((m) => m.is_in).map((m) => m.id));
  // `_create_analytic_move`: an analytic distribution on the moves refuses
  if ((await rows(env, "SELECT 1 FROM stock_move m JOIN purchase_order_line l ON l.id = m.purchase_line_id WHERE m.id = ANY($1::int[]) AND l.analytic_distribution IS NOT NULL LIMIT 1", [[...moveIds]])).length) {
    throw new NotPorted("stock_account _create_analytic_move");
  }
}

/** stock_account stock_move.py:345-438 `_set_value` (without `recompute_date`) of done moves, all in or all out. */
export async function setValue(env: Environment, moveIds: readonly number[]): Promise<void> {
  if (!moveIds.length) return;
  const moves = await rows<{ id: number; is_in: boolean | null; is_out: boolean | null; purchase_line_id: number | null; cost_method: string; valuation: string; product_id: number; uom_id: number; product_uom: number; date: string; company_id: number }>(env,
    `SELECT m.id, m.is_in, m.is_out, m.purchase_line_id, m.product_id, m.uom_id, t.uom_id AS product_uom, m.date::text AS date, m.company_id,
            COALESCE(c.property_cost_method->>m.company_id::text, (SELECT d.json_value FROM ir_default d JOIN ir_model_fields f ON f.id = d.field_id
              WHERE f.model = 'product.category' AND f.name = 'property_cost_method' AND (d.company_id = m.company_id) LIMIT 1), '"standard"') AS cost_method,
            COALESCE(c.property_valuation->>m.company_id::text, (SELECT d.json_value FROM ir_default d JOIN ir_model_fields f ON f.id = d.field_id
              WHERE f.model = 'product.category' AND f.name = 'property_valuation' AND (d.company_id = m.company_id) LIMIT 1), '"periodic"') AS valuation
       FROM stock_move m JOIN product_product p ON p.id = m.product_id JOIN product_template t ON t.id = p.product_tmpl_id LEFT JOIN product_category c ON c.id = t.categ_id
      WHERE m.id = ANY($1::int[]) ORDER BY m.date, m.id`, [[...moveIds]]);
  const costOf = (m: { cost_method: string }): string => m.cost_method.replace(/"/g, "");
  const lots = new Map((await rows<{ id: number; lot: boolean | null }>(env,
    "SELECT p.id, t.lot_valuated AS lot FROM product_product p JOIN product_template t ON t.id = p.product_tmpl_id WHERE p.id = ANY($1::int[])", [[...new Set(moves.map((m) => m.product_id))]])).map((r) => [r.id, Boolean(r.lot)]));
  // the outgoing moves are valued before (`moves_out._set_value()` first), so a return's value reads its origin's
  const inValues = new Map<number, number>();
  for (const m of moves) if (m.is_in) inValues.set(m.id, await inValue(env, m, costOf(m), lots.get(m.product_id) ?? false));
  const costed = moves.filter((m) => costOf(m) !== "standard");
  if (costed.length) {
    const envCompany = await env.company();
    if (costed.some((m) => m.company_id !== envCompany)) throw new NotPorted("stock_account _set_value of an average or FIFO move in another company than the environment's");
    // :358-371 `moves_already_sold`: an incoming move whose quantity is not all on hand replays the valuation
    // (`recompute_date`); for standard products alone that replay values the moves as below (`_correct_inventory_valuation`
    // skips them), so it is only checked when an average or FIFO product is among them
    // The replay (`_correct_inventory_valuation`) is not ported: it refuses, unless every incoming move keeps its value
    // (a bill at the received price posted after a sale), when the replay rewrites the same values
    const ins = moves.filter((m) => m.is_in);
    if (ins.length) {
      const valued = await valuedMoves(env, ins.map((m) => m.id));
      let sold = false;
      for (const product of new Set(ins.map((m) => m.product_id))) {
        const cenv = await withCompany(env, ins.find((m) => m.product_id === product)!.company_id);
        const remaining = await remainingByMove(cenv, product);
        for (const m of ins.filter((x) => x.product_id === product)) if ((remaining.get(m.id) ?? 0) !== valued.get(m.id)!.qty) sold = true;
      }
      if (sold) {
        for (const m of ins) {
          const currency = (await rows<{ c: number }>(env, "SELECT currency_id AS c FROM res_company WHERE id = $1", [m.company_id]))[0]?.c ?? null;
          if ((await roundCurrency(env, inValues.get(m.id)!, currency)) !== valued.get(m.id)!.value) {
            throw new NotPorted("stock_account _set_value replaying the valuation (an incoming move already partly sold, recompute_date)");
          }
        }
      }
    }
  }
  // :375-385 the quantity of the FIFO moves going out that the on-hand quantity no longer has
  const processed = new Map<number, number>();
  const outs = await valuedMoves(env, moves.filter((m) => m.is_out).map((m) => m.id));
  for (const m of moves) {
    if (!m.is_out || costOf(m) !== "fifo") continue;
    processed.set(m.product_id, (processed.get(m.product_id) ?? 0) - outs.get(m.id)!.qty);
  }
  const recompute = new Set<number>();
  for (const m of moves) {
    const cost = costOf(m), valuation = m.valuation.replace(/"/g, "");
    const menv = await withCompany(env, m.company_id);
    if (valuation === "real_time" && (await rows(env, "SELECT 1 FROM stock_move m JOIN stock_location s ON s.id = m.location_id JOIN stock_location d ON d.id = m.location_dest_id WHERE m.id = $1 AND (s.valuation_account_id IS NOT NULL OR d.valuation_account_id IS NOT NULL)", [m.id])).length) {
      throw new NotPorted("stock_account _create_account_move of real-time valuation (a location valuation account)");
    }
    if (m.is_out) {
      if (lots.get(m.product_id)) throw new NotPorted("stock_account _set_value of an outgoing move with lot valuation");
      const qty = outs.get(m.id)!.qty;
      if (cost === "fifo") {
        // :411-416 `_get_fifo_value(valued_qty, stack_size_extra_qty=-processed)`
        recompute.add(m.product_id);
        const value = await fifoValue(menv, m.product_id, qty, -(processed.get(m.product_id) ?? 0));
        processed.set(m.product_id, (processed.get(m.product_id) ?? 0) + qty);
        await write(env, "stock.move", [m.id], { value: -value });
        continue;
      }
      // :426-428 outgoing moves at the product's cost (standard or average without lot valuation)
      const price = (await productCost(menv, m.product_id)).standardPrice;
      await write(env, "stock.move", [m.id], { value: -price * qty });
      continue;
    }
    if (!m.is_in) continue;
    recompute.add(m.product_id);
    const value = inValues.get(m.id)!;
    await write(env, "stock.move", [m.id], { value });
  }
  // :433-435 the cost of the products after their valued moves
  await updateStandardPrice(env, [...recompute]);
  // sale_stock_margin's `purchase_price` (depends on `move_ids.value`) is computed lazily in Odoo, at the flush after
  // the new cost; the port's write computed it at the value's write, before it: computed again with the new cost
  if (costed.length && env.reg.models.has("sale.order.line") && env.reg.model("sale.order.line").fields.get("purchase_price")?.store) {
    const lines = (await rows<{ id: number }>(env, "SELECT DISTINCT sale_line_id AS id FROM stock_move WHERE id = ANY($1::int[]) AND sale_line_id IS NOT NULL ORDER BY 1", [costed.map((m) => m.id)])).map((r) => r.id);
    if (lines.length) {
      const queue = new RecomputeQueue(env);
      queue.add("sale.order.line", "purchase_price", lines);
      await queue.run();
    }
  }
}

/**
 * stock_account account_move.py:38-73 `_post` (not for `move_reverse_cancel`), `button_draft`, `button_cancel`:
 * `line_ids.cogs_move_ids.filtered(lambda m: m.is_in or m.is_dropship)._set_value()`, the incoming moves of the
 * documents' lines valued again (a bill's price replaces the order's). `cogs_move_ids`: purchase_stock
 * account_move_line.py:11-15 (the purchase line's valued moves), sale_stock account_move.py:127-139 (the sale lines'
 * valued moves to or from a customer or transit location; consigned lines and COGS lines refuse).
 */
export async function revalueCogsMoves(env: Environment, accountMoveIds: readonly number[]): Promise<void> {
  if (!accountMoveIds.length || !env.reg.models.has("stock.move")) return;
  const ids = new Set<number>();
  if (env.reg.model("account.move.line").fields.get("purchase_line_id")?.store) {
    for (const r of await rows<{ id: number }>(env,
      `SELECT DISTINCT m.id FROM account_move_line l JOIN stock_move m ON m.purchase_line_id = l.purchase_line_id
        WHERE l.move_id = ANY($1::int[]) AND (m.is_in OR m.is_out) AND (m.is_in OR m.is_dropship)`, [[...accountMoveIds]])) ids.add(r.id);
  }
  if (env.reg.models.has("sale.order.line") && env.reg.model("stock.move").fields.get("sale_line_id")?.store) {
    if ((await rows(env, "SELECT 1 FROM account_move_line WHERE move_id = ANY($1::int[]) AND cogs_origin_id IS NOT NULL LIMIT 1", [[...accountMoveIds]])).length) {
      throw new NotPorted("stock_account _post with COGS lines (cogs_move_ids of cogs_origin_id)");
    }
    const sale = await rows<{ id: number; valued: boolean; consigned: boolean }>(env,
      `SELECT DISTINCT m.id, COALESCE(m.is_in OR m.is_out, false) AS valued,
              EXISTS (SELECT 1 FROM stock_move_line x WHERE x.move_id = m.id AND x.owner_id IS NOT NULL AND x.owner_id != (SELECT partner_id FROM res_company WHERE id = x.company_id)) AS consigned
         FROM account_move_line l JOIN sale_order_line_invoice_rel r ON r.invoice_line_id = l.id JOIN stock_move m ON m.sale_line_id = r.order_line_id
         JOIN stock_location s ON s.id = m.location_id JOIN stock_location d ON d.id = m.location_dest_id
        WHERE l.move_id = ANY($1::int[]) AND (s.usage IN ('customer', 'transit') OR d.usage IN ('customer', 'transit')) AND (m.is_in OR m.is_dropship)`, [[...accountMoveIds]]);
    for (const r of sale) {
      if (r.consigned) throw new NotPorted("stock_account _post with consigned move lines (_is_consigned_valued_line)");
      if (r.valued) ids.add(r.id);
    }
  }
  if (!ids.size) return;
  if ((await rows(env, "SELECT 1 FROM stock_move WHERE id = ANY($1::int[]) AND is_dropship LIMIT 1", [[...ids]])).length) throw new NotPorted("stock_account _set_value of a dropship");
  await setValue(env.sudo(), [...ids]);
}

type ValueMove = { id: number; purchase_line_id: number | null; product_id: number; uom_id: number; product_uom: number; date: string; company_id: number };

/** stock_account stock_move.py:443-536 `_get_value_data` of a done incoming move: from the bills, the quotation, the
 *  returned move, a previous company's move, the product's cost (stock_move.py:588-604; FIFO without cost: its own
 *  unit value). */
async function inValue(env: Environment, m: ValueMove, cost: string, lot: boolean): Promise<number> {
  const menv = await withCompany(env, m.company_id);
  if ((await rows(env, "SELECT 1 FROM product_value WHERE move_id = $1 LIMIT 1", [m.id])).length) throw new NotPorted("stock.move value set by hand (product.value)");
  // `_get_valued_qty`: the picked lines entering a valued location of the company
  const [q] = await rows<{ q: number }>(env,
    `SELECT COALESCE(sum(l.quantity_product_uom), 0)::float8 AS q FROM stock_move_line l JOIN stock_location s ON s.id = l.location_id JOIN stock_location d ON d.id = l.location_dest_id
      WHERE l.move_id = $1 AND COALESCE(l.picked, false) AND NOT (COALESCE(s.company_id = l.company_id, false) AND s.usage IN ('internal', 'transit'))
        AND COALESCE(d.company_id = l.company_id, false) AND d.usage IN ('internal', 'transit')`, [m.id]);
  let remaining = q!.q;
  let value = 0;
  if (m.purchase_line_id) {
    if (remaining) {
      // purchase_stock stock_move.py:186-238 `_get_value_from_account_move`: the posted bills of the line first
      const billed = await valueFromBills(env, m, remaining);
      value += billed.value;
      remaining -= billed.quantity;
    }
    if (remaining) {
      // purchase_stock stock_move.py:262-277 `_get_value_from_quotation`
      const [price] = await rows<{ p: number }>(env, "SELECT price_unit::float8 AS p FROM stock_move WHERE id = $1", [m.id]);
      const inProduct = m.uom_id === m.product_uom ? remaining : await uomQuantity(env, remaining, m.uom_id, m.product_uom, "UP");
      const quantity = Math.min(remaining, inProduct);
      value += (await stockMovePrice(env, m.purchase_line_id, price!.p, m.date)) * quantity;
      remaining -= quantity;
    }
  }
  if (remaining) {
    // stock_account stock_move.py:443-536 `_get_value_data`, 3. from the returned move (:577-586), 4. from a previous
    // move in another company (:606-616)
    const [o] = await rows<{ ret: number | null; is_out: boolean | null; value: number | null; orig_other: boolean }>(env,
      `SELECT r.id AS ret, r.is_out, r.value::float8 AS value,
              EXISTS(SELECT 1 FROM stock_move_move_rel x JOIN stock_move y ON y.id = x.move_orig_id WHERE x.move_dest_id = m.id AND y.company_id != m.company_id) AS orig_other
         FROM stock_move m LEFT JOIN stock_move r ON r.id = m.origin_returned_move_id WHERE m.id = $1`, [m.id]);
    if (o?.ret && o.is_out) {
      const [oq] = await rows<{ q: number }>(env,
        `SELECT COALESCE(sum(l.quantity_product_uom), 0)::float8 AS q FROM stock_move_line l JOIN stock_location s ON s.id = l.location_id JOIN stock_location d ON d.id = l.location_dest_id
          WHERE l.move_id = $1 AND COALESCE(l.picked, false) AND COALESCE(s.company_id = l.company_id, false) AND s.usage IN ('internal', 'transit')
            AND NOT (COALESCE(d.company_id = l.company_id, false) AND d.usage IN ('internal', 'transit'))`, [o.ret]);
      value += (await uomCompare(env, oq!.q, 0)) === 0 ? 0 : Math.abs(Number(o.value ?? 0) * remaining / oq!.q);
      remaining = 0;
    }
    if (remaining && o?.orig_other) throw new NotPorted("stock_account _get_value_from_previous_company");
  }
  if (remaining) {
    // stock_account stock_move.py:588-604 `_get_value_from_std_price`: the product's cost in the move's company; a
    // FIFO product without cost takes the move's own unit value (lot valuation refuses)
    if (lot) throw new NotPorted("stock_account _get_value_from_std_price with lot valuation");
    let price = (await productCost(menv, m.product_id)).standardPrice;
    if (!price && cost === "fifo") {
      const own = (await valuedMoves(env, [m.id])).get(m.id)!;
      if (own.qty) price = own.value / own.qty;
    }
    value += price * remaining;
  }
  // :524-528 `add_extra_value` (True here): `_get_value_from_extra(valued_qty)`, stock_account's VALUATION_DICT (value 0,
  // :618-619); a module's override through callPrivate (stock_landed_costs stock_move.py:12-39: the done landed costs)
  const extra = await priv.stock_move._get_value_from_extra.call(env, [m.id], [q!.q], async () => ({ value: 0, quantity: 0, description: false }));
  return value + extraValue(extra);
}

/** `_get_valued_qty` of a done move (stock_account stock_move.py:536-550): its in or out lines in product units. */
async function validQtyOf(env: Environment, moveId: number): Promise<{ qty: number; dir: "in" | "out" | null }> {
  const [m] = await rows<{ state: string; is_in: boolean | null; is_out: boolean | null; is_dropship: boolean | null }>(env, "SELECT state, is_in, is_out, is_dropship FROM stock_move WHERE id = $1", [moveId]);
  if (!m) return { qty: 0, dir: null };
  // purchase_stock stock_move.py:216-219 only counts moves with is_in, is_dropship or is_out (non-done moves have all three false)
  if (!m.is_in && !m.is_out && !m.is_dropship) return { qty: 0, dir: null };
  if (m.state !== "done") throw new NotPorted("purchase_stock _get_value_from_account_move with another move of the line not done (_is_in)");
  if (m.is_dropship) throw new NotPorted("purchase_stock _get_value_from_account_move with a dropship move of the line");
  const inSql = `NOT (COALESCE(s.company_id = l.company_id, false) AND s.usage IN ('internal', 'transit')) AND COALESCE(d.company_id = l.company_id, false) AND d.usage IN ('internal', 'transit')`;
  const outSql = `COALESCE(s.company_id = l.company_id, false) AND s.usage IN ('internal', 'transit') AND NOT (COALESCE(d.company_id = l.company_id, false) AND d.usage IN ('internal', 'transit'))`;
  const dir = m.is_in ? "in" : m.is_out ? "out" : null;
  if (dir === null) return { qty: 0, dir };
  const [q] = await rows<{ q: number }>(env,
    `SELECT COALESCE(sum(l.quantity_product_uom), 0)::float8 AS q FROM stock_move_line l JOIN stock_location s ON s.id = l.location_id JOIN stock_location d ON d.id = l.location_dest_id
      WHERE l.move_id = $1 AND COALESCE(l.picked, false) AND ${dir === "in" ? inSql : outSql}`, [moveId]);
  return { qty: q!.q, dir };
}

/**
 * purchase_stock stock_move.py:186-238 `_get_value_from_account_move` with :240-256 `_get_value_from_bill` and
 * `_get_quantity_from_bill`: the posted bills (and refunds) of the purchase line, less what the line's earlier moves of
 * the product already took, valued at the bill's price in the company currency (`compute_all(...)['total_void']`,
 * account_tax.py:4927-4954: the unrounded base plus the taxes without account; percent taxes excluded from the price
 * are ported, others refuse).
 */
async function valueFromBills(env: Environment, m: { id: number; purchase_line_id: number | null; product_id: number; product_uom: number; date: string }, quantity: number): Promise<{ value: number; quantity: number }> {
  const amls = await rows<{ id: number; move_type: string; quantity: number; uom: number | null; price_unit: number; discount: number | null; subtotal: number; currency: number | null; company: number; rate: number | null }>(env,
    `SELECT l.id, a.move_type, l.quantity::float8 AS quantity, l.product_uom_id AS uom, l.price_unit::float8 AS price_unit, l.discount::float8 AS discount,
            l.price_subtotal::float8 AS subtotal, l.currency_id AS currency, l.company_id AS company, a.invoice_currency_rate::float8 AS rate
       FROM account_move_line l JOIN account_move a ON a.id = l.move_id WHERE l.purchase_line_id = $1 AND a.state = 'posted' ORDER BY l.id`, [m.purchase_line_id]);
  let amlQty = 0, value = 0;
  for (const a of amls) {
    if (a.move_type !== "in_invoice" && a.move_type !== "in_refund") continue;
    const billQty = a.uom !== null && a.uom !== m.product_uom ? await uomQuantity(env, a.quantity, a.uom, m.product_uom, "UP") : a.quantity;
    const taxes = await rows<{ id: number; amount_type: string; amount: number; incl: boolean; voids: boolean }>(env,
      `SELECT t.id, t.amount_type, t.amount::float8 AS amount,
              COALESCE(t.price_include_override = 'tax_included', false) OR (t.price_include_override IS NULL AND c.account_price_include = 'tax_included') AS incl,
              EXISTS(SELECT 1 FROM account_tax_repartition_line r WHERE r.tax_id = t.id AND r.document_type = 'invoice' AND r.repartition_type = 'tax' AND r.account_id IS NULL AND r.factor_percent != 0) AS voids
         FROM account_move_line_account_tax_rel x JOIN account_tax t ON t.id = x.account_tax_id JOIN res_company c ON c.id = t.company_id
        WHERE x.account_move_line_id = $1`, [a.id]);
    let v = a.subtotal;
    if (taxes.length) {
      if (taxes.some((t) => t.amount_type !== "percent" || t.incl || t.voids)) throw new NotPorted("purchase_stock _get_value_from_bill with taxes other than percent taxes excluded from the price");
      v = a.price_unit * (1 - (a.discount ?? 0) / 100) * a.quantity;
    }
    const [cur] = await rows<{ c: number }>(env, "SELECT currency_id AS c FROM res_company WHERE id = $1", [a.company]);
    // `value / aml.currency_rate`: a bill's line has the bill's rate (account_move_line.py:869-883
    // `_compute_currency_rate`: `invoice_currency_rate or 1.0`), 1 in the company's currency
    const rate = a.currency !== null && a.currency !== cur!.c ? (a.rate || 1.0) : 1.0;
    const billValue = roundPrecision(v / rate, (await currencyData(env, cur!.c)).rounding);
    if (a.move_type === "in_invoice") { amlQty += billQty; value += billValue; } else { amlQty -= billQty; value -= billValue; }
  }
  if (amlQty <= 0) return { value: 0, quantity: 0 };
  // :208-219 the line's other moves of the product up to this one
  let other = 0;
  const moves = await rows<{ id: number; product_id: number; date: string }>(env,
    "SELECT id, product_id, date::text AS date FROM stock_move WHERE purchase_line_id = $1 AND id != $2 ORDER BY id", [m.purchase_line_id, m.id]);
  for (const o of moves) {
    if (o.product_id !== m.product_id) continue;
    if (o.date > m.date || (o.date === m.date && o.id > m.id)) continue;
    other += (await validQtyOf(env, o.id)).qty;
  }
  if ((await uomCompare(env, amlQty, other)) <= 0) return { value: 0, quantity: 0 };
  value = value * ((amlQty - other) / amlQty);
  amlQty -= other;
  return quantity >= amlQty ? { value, quantity: amlQty } : { value: quantity * value / amlQty, quantity };
}

/** purchase_stock `_get_stock_move_price_unit(date)`: the same as at receipt creation for one currency (checked there). */
async function stockMovePrice(env: Environment, line: number, movePrice: number, moveDate: string): Promise<number> {
  const [l] = await rows<{ price_unit: number; discount: number; qty: number; same: boolean; cur: number; ccur: number; company: number }>(env,
    `SELECT l.price_unit::float8 AS price_unit, COALESCE(l.discount, 0)::float8 AS discount, l.product_qty::float8 AS qty, (o.currency_id = c.currency_id) AS same,
            o.currency_id AS cur, c.currency_id AS ccur, l.company_id AS company
       FROM purchase_order_line l JOIN purchase_order o ON o.id = l.order_id JOIN res_company c ON c.id = o.company_id WHERE l.id = $1`, [line]);
  let discounted = l!.price_unit * (1 - l!.discount / 100);
  // purchase_order_line.py:287-289 at the move's date (`_get_stock_move_price_unit(self.date)`), round=False
  if (!l!.same) discounted = await convertAmount(env, discounted, l!.cur, l!.ccur, l!.company, moveDate.slice(0, 10), false);
  const digits = (await rows<{ d: number }>(env, "SELECT digits AS d FROM decimal_precision WHERE name = 'Product Price'", []))[0]?.d ?? 2;
  const price = floatRound(discounted, digits);
  if (price !== floatRound(movePrice, digits)) throw new NotPorted("purchase_stock _get_stock_move_price_unit changed since the receipt (taxes or units)");
  return price;
}

/** stock_move.py:2753-2774 `_trigger_assign`. */
export async function triggerAssign(env: Environment, moveIds: readonly number[]): Promise<void> {
  if (!moveIds.length) return;
  const off = await rows<{ v: string }>(env, "SELECT value AS v FROM ir_config_parameter WHERE key = 'stock.picking_no_auto_reserve'", []);
  if (off[0] && !["", "0", "false", "False"].includes(off[0].v)) return;
  const groups = await rows<{ dest: number; products: number[] }>(env,
    "SELECT location_dest_id AS dest, array_agg(DISTINCT product_id) AS products FROM stock_move WHERE id = ANY($1::int[]) GROUP BY location_dest_id", [[...moveIds]]);
  const refs = (await rows<{ r: number }>(env, "SELECT DISTINCT reference_id AS r FROM stock_reference_move_rel WHERE move_id = ANY($1::int[])", [[...moveIds]])).map((r) => r.r);
  const found: { id: number; priority: string; date: string; shared: boolean }[] = [];
  for (const g of groups) {
    const hits = await rows<{ id: number; priority: string; date: string; shared: boolean }>(env,
      `SELECT m.id, COALESCE(m.priority, '0') AS priority, m.date::text AS date,
              EXISTS (SELECT 1 FROM stock_reference_move_rel r WHERE r.move_id = m.id AND r.reference_id = ANY($4::int[])) AS shared
         FROM stock_move m LEFT JOIN stock_picking_type t ON t.id = m.picking_type_id JOIN stock_location l ON l.id = m.location_id
        WHERE m.state IN ('confirmed', 'partially_available') AND m.procure_method = 'make_to_stock'
          AND (m.reservation_date <= $3::date OR t.reservation_method = 'at_confirm')
          AND m.product_id = ANY($1::int[]) AND (SELECT parent_path FROM stock_location WHERE id = $2) LIKE l.parent_path || '%'`,
      [g.products, g.dest, await contextToday(env), refs]);
    for (const h of hits) if (!found.some((f) => f.id === h.id)) found.push(h);
  }
  // order='priority desc, date asc, id asc', then the moves sharing a reference first (sorted is stable)
  found.sort((a, b) => (a.priority < b.priority ? 1 : a.priority > b.priority ? -1 : a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  const ordered = [...found.filter((f) => f.shared), ...found.filter((f) => !f.shared)];
  await actionAssign(env, ordered.map((f) => f.id));
}

/** stock_picking.py:996-1043 `_action_done`. */
async function pickingsDone(env: Environment, pickings: PickingRow[], cancelBackorder: boolean): Promise<void> {
  if (pickings.some((p) => p.owner_id)) throw new NotPorted("stock.picking._action_done with an owner");
  const ids = pickings.map((p) => p.id);
  // purchase_stock stock.py:54-56: the order is acknowledged first; its tracking and the transfers' are logged at
  // precommit in that order (mail_track_mixin.py:133), after the notes posted meanwhile
  const orders = (await rows<{ id: number }>(env,
    `SELECT DISTINCT ON (m.picking_id) l.order_id AS id FROM stock_move m JOIN purchase_order_line l ON l.id = m.purchase_line_id
      WHERE m.picking_id = ANY($1::int[]) ORDER BY m.picking_id, m.sequence, m.id`, [ids])).map((r) => r.id);
  const purchases = [...new Set(orders)];
  await trackPrepare(env, "purchase.order", purchases);
  await trackPrepare(env, "stock.picking", ids);
  if (purchases.length) await write(env.sudo(), "purchase.order", purchases, { acknowledged: true });
  const todo = (await rows<{ id: number }>(env,
    "SELECT id FROM stock_move WHERE picking_id = ANY($1::int[]) AND state IN ('draft', 'waiting', 'partially_available', 'assigned', 'confirmed') ORDER BY sequence, id", [ids])).map((r) => r.id);
  await movesDone(env, todo, cancelBackorder);
  await write(env, "stock.picking", ids, { date_done: await nowString(env), priority: "0" });
  // :1016-1034: without a backorder, the followers are told what was not delivered
  if (cancelBackorder) {
    const { postOnPicking } = await import("./stock_backorder");
    for (const p of pickings) {
      const incomplete = await rows<{ quantity: number; product_uom_qty: number; product_id: number; uom: string }>(env,
        `SELECT m.quantity, m.product_uom_qty, m.product_id, COALESCE(u.name->>$2, u.name->>'en_US') AS uom
           FROM stock_move m JOIN uom_uom u ON u.id = m.uom_id WHERE m.picking_id = $1 ORDER BY m.sequence, m.id`, [p.id, env.lang ?? "en_US"]);
      const prec = await unitDigits(env);
      // float_utils.py float_compare: the difference rounded to the precision decides
      const floatCompare = (a: number, b: number, d: number): number => (floatRound(a - b, d) === 0 ? 0 : a < b ? -1 : 1);
      const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;").replace(/'/g, "&#39;");
      const lis: string[] = [];
      for (const m of incomplete) {
        if (floatCompare(Number(m.quantity), Number(m.product_uom_qty), prec) >= 0) continue;
        const product = (await env.sudo().model("product.product").displayName([m.product_id])).get(m.product_id) ?? "";
        const lineText = translate(env, "Only %(nbr_done)s %(uom)s of %(product)s delivered in contrast to the expected %(nbr_demanded)s %(uom)s", "stock")
          .replace(/%\(nbr_done\)s/g, pyFloatReprSimple(Number(m.quantity)))
          .replace(/%\(nbr_demanded\)s/g, pyFloatReprSimple(Number(m.product_uom_qty)))
          .replace(/%\(uom\)s/g, m.uom)
          .replace(/%\(product\)s/g, product);
        lis.push(`<li>${esc(lineText)}</li>`);
      }
      // `_('No backorder has been planned for undelivered demanded quantities: %s', Markup('<ul>...</ul>'))` as
      // html_sanitize stores it (the leading text in its own paragraph)
      if (lis.length) {
        const heading = translate(env, "No backorder has been planned for undelivered demanded quantities: %s", "stock").replace("%s", "");
        await postOnPicking(env, p.id, `<p>${esc(heading)}</p><ul>${lis.join("")}</ul>`, "stock.mt_picking_state");
      }
    }
  }
  const incoming = pickings.filter((p) => p.type_code === "incoming" || p.type_code === "internal").map((p) => p.id);
  const doneIncoming = (await rows<{ id: number }>(env, "SELECT id FROM stock_move WHERE picking_id = ANY($1::int[]) AND state = 'done' ORDER BY sequence, id", [incoming])).map((r) => r.id);
  await triggerAssign(env, doneIncoming);
  // `_intercompany_unpack` needs packages; `_send_confirmation_email` outgoing transfers of companies that send it
  for (const p of pickings) {
    if (p.type_code !== "outgoing") continue;
    const [c] = await rows<{ v: boolean | null }>(env, "SELECT stock_move_email_validation AS v FROM res_company WHERE id = $1", [p.company_id]);
    if (c?.v) throw new NotPorted("stock.picking._send_confirmation_email");
    // stock_sms stock_picking.py:46-57: the confirmation text message
    const [t] = await rows<{ sms: boolean; phone: string | null }>(env,
      `SELECT (COALESCE(c.stock_text_confirmation, false) AND c.stock_confirmation_type = 'sms') AS sms, rp.phone
         FROM res_company c, stock_picking sp LEFT JOIN res_partner rp ON rp.id = sp.partner_id WHERE c.id = $1 AND sp.id = $2`, [p.company_id, p.id]);
    if (t?.sms && t.phone && !env.context["skip_sms"] && !env.context["install_demo"]) throw new NotPorted("stock_sms _send_confirmation_email (the delivery text message)");
  }
  // sale_stock stock.py:302-340: moves of a sale order's transfer without a sale line
  if ((await rows(env, `SELECT 1 FROM stock_move m JOIN stock_picking p ON p.id = m.picking_id WHERE p.id = ANY($1::int[]) AND p.sale_id IS NOT NULL AND m.sale_line_id IS NULL LIMIT 1`, [ids])).length) {
    throw new NotPorted("sale_stock stock.picking._action_done of moves without sale line");
  }
  await closeTrackingScope(env, "purchase.order");
  await closeTrackingScope(env, "stock.picking");
}

/** stock_picking.py:1176-1245 `button_validate` (one transfer at a time). */
export async function buttonValidate(env: Environment, ids0: readonly number[]): Promise<unknown> {
  let pickings = (await pickingRows(env, ids0)).filter((p) => p.state !== "done");
  if (pickings.length > 1) throw new NotPorted("stock.picking.button_validate of several transfers (_should_show_transfers)");
  // :1178-1184 the draft transfers are confirmed first (`action_confirm` with to_validate), then each move without a
  // quantity takes its demand
  const draft = pickings.filter((p) => p.state === "draft").map((p) => p.id);
  if (!draft.length) return validateConfirmed(env, pickings);
  // the transfer's tracking covers the whole button (one "Draft -> Done" message, logged at precommit)
  await trackPrepare(env, "stock.picking", draft);
  {
    const cenv = env.withContext({ ...env.context, to_validate: true });
    // stock_picking.py:768-785 `action_confirm`: zero demand moves open their wizard
    if (!cenv.context["skip_zero_demand_check"] && (await rows(env, "SELECT 1 FROM stock_move WHERE picking_id = ANY($1::int[]) AND product_uom_qty <= 0 LIMIT 1", [draft])).length) {
      await closeTrackingScope(env, "stock.picking");
      const { zeroDemandWizardAction } = await import("./stock_inventory");
      return zeroDemandWizardAction(cenv, draft);
    }
    await pickingActionConfirm(cenv, draft);
    if (await hasGroup(env, "stock.group_stock_picking_batch")) throw new NotPorted("stock.picking._find_auto_batch");
    const digits = await unitDigits(env);
    for (const m of await rows<{ id: number; quantity: number; demand: number }>(env,
      "SELECT id, COALESCE(quantity, 0)::float8 AS quantity, product_uom_qty::float8 AS demand FROM stock_move WHERE picking_id = ANY($1::int[]) ORDER BY picking_id, sequence, id", [draft])) {
      if (floatRound(m.quantity, digits) === 0 && floatRound(m.demand, digits) !== 0) await write(env, "stock.move", [m.id], { quantity: m.demand });
    }
    pickings = (await pickingRows(env, ids0)).filter((p) => p.state !== "done");
  }
  const out = await validateConfirmed(env, pickings);
  await closeTrackingScope(env, "stock.picking");
  return out;
}

async function validateConfirmed(env: Environment, pickings0: PickingRow[]): Promise<unknown> {
  let pickings = pickings0;
  if (pickings.some((p) => p.batch_id)) throw new NotPorted("stock.picking.button_validate in a batch");
  const ids = pickings.map((p) => p.id);
  // `_sanity_check`
  if (!env.context["skip_sanity_check"]) {
    for (const p of pickings) {
      const moves = await rows<{ id: number; picked: boolean | null; state: string; quantity: number }>(env,
        "SELECT id, picked, state, quantity::float8 AS quantity FROM stock_move WHERE picking_id = $1 ORDER BY sequence, id", [p.id]);
      const lines = await rows(env, "SELECT 1 FROM stock_move_line WHERE picking_id = $1 LIMIT 1", [p.id]);
      if (!moves.length && !lines.length) throw new UserError(translate(env, "You can’t validate an empty transfer. Please add some products to move before proceeding."));
      const hasPick = moves.some((m) => m.picked && !["done", "cancel"].includes(m.state));
      const digits = await unitDigits(env);
      const relevant = moves.filter((m) => !["done", "cancel"].includes(m.state) && (!hasPick || m.picked));
      if (relevant.every((m) => floatRound(m.quantity, digits) === 0)) {
        throw new UserError(translate(env, "Transfer trouble alert! Validating a zero quantity transfer? You're not moving invisible goods around are you?\nSet some quantities and let's get moving!"));
      }
      if (p.use_lots) {
        // :1101-1127 `_get_lot_move_lines_for_sanity_check` (`no_quantities_done_ids` is never filled): the picked lines
        // of tracked products with a quantity, without a lot name or lot
        const missing = await rows<{ product_id: number }>(env,
          `SELECT l.product_id FROM stock_move_line l JOIN product_product pp ON pp.id = l.product_id JOIN product_template t ON t.id = pp.product_tmpl_id
            WHERE l.picking_id = $1 AND t.tracking IN ('lot', 'serial') AND COALESCE(l.picked, false) AND round(l.quantity::numeric, $2) != 0
              AND l.lot_id IS NULL AND COALESCE(l.lot_name, '') = '' ORDER BY l.id`, [p.id, digits]);
        if (missing.length) {
          const uniq = [...new Set(missing.map((r) => r.product_id))];
          const names = await env.model("product.product").displayName(uniq);
          throw new UserError(translate(env, "You need to supply a Lot/Serial number for products %s.", "stock").replace("%s", uniq.map((u) => names.get(u) ?? "").join(", ")));
        }
      }
    }
  }
  const ctxEnv = env.context["button_validate_picking_ids"] ? env : env.withContext({ ...env.context, button_validate_picking_ids: ids });
  // `_pre_action_done_hook`: moves with a quantity but none picked are all picked
  for (const p of pickings) {
    const moves = await rows<{ id: number; picked: boolean | null; quantity: number; dest_usage: string }>(ctxEnv,
      "SELECT m.id, m.picked, m.quantity::float8 AS quantity, d.usage AS dest_usage FROM stock_move m JOIN stock_location d ON d.id = m.location_dest_id WHERE m.picking_id = $1 ORDER BY m.sequence, m.id", [p.id]);
    let hasQuantity = false, hasPick = false;
    for (const m of moves) {
      if (m.quantity) hasQuantity = true;
      if (m.dest_usage === "inventory") continue;
      if (m.picked) hasPick = true;
      if (hasQuantity && hasPick) break;
    }
    if (hasQuantity && !hasPick) await write(ctxEnv, "stock.move", moves.map((m) => m.id), { picked: true });
  }
  if (!ctxEnv.context["skip_backorder"]) {
    const digits = await unitDigits(ctxEnv);
    for (const p of pickings) {
      if (p.create_backorder !== "ask") continue;
      const moves = await rows<{ id: number; qty: number; picked: boolean | null; state: string }>(ctxEnv,
        "SELECT id, product_uom_qty::float8 AS qty, picked, state FROM stock_move WHERE picking_id = $1 AND state != 'cancel' ORDER BY sequence, id", [p.id]);
      for (const m of moves) {
        if ((m.qty && !m.picked) || floatRound(await pickedQuantity(ctxEnv, m.id), digits) < floatRound(m.qty, digits)) {
          // `_action_generate_backorder_wizard(show_transfers=self._should_show_transfers())`: one transfer, no batch
          return backorderWizardAction(ctxEnv, [p.id], false);
        }
      }
    }
  }
  // stock_sms stock_picking.py:10-29 `_check_warn_sms`: deliveries to a partner with a phone, of a company that texts
  // them and has not been warned yet, open the warning wizard (:31-44)
  if (!ctxEnv.context["skip_sms"]) {
    const warn: number[] = [];
    for (const p of pickings) {
      const [c] = await rows<{ sms: boolean; warned: boolean | null; phone: string | null }>(ctxEnv,
        `SELECT (COALESCE(c.stock_text_confirmation, false) AND c.stock_confirmation_type = 'sms') AS sms, c.has_received_warning_stock_sms AS warned, rp.phone
           FROM res_company c, stock_picking sp LEFT JOIN res_partner rp ON rp.id = sp.partner_id WHERE c.id = $1 AND sp.id = $2`, [p.company_id, p.id]);
      if (c?.sms && p.type_code === "outgoing" && c.phone && !c.warned) warn.push(p.id);
    }
    if (warn.length) {
      const view = await xmlid(ctxEnv, "stock_sms.view_confirm_stock_sms");
      const [wiz] = await create(ctxEnv, "confirm.stock.sms", [{ pick_ids: warn.map((id) => [4, id, 0]) }]);
      return {
        name: translate(ctxEnv, "SMS"), type: "ir.actions.act_window", view_mode: "form", res_model: "confirm.stock.sms",
        views: [[view, "form"]], view_id: view, target: "new", res_id: wiz, context: ctxEnv.context,
      };
    }
  }
  // stock_picking.py:1199-1208: transfers whose type never backorders, and those the wizard said not to (unless
  // their type always backorders), are done with cancel_backorder; the others with backorders
  const notToBackorderIds = ctxEnv.context["picking_ids_not_to_backorder"];
  const notTo = new Set(pickings.filter((p) => p.create_backorder === "never").map((p) => p.id));
  if (Array.isArray(notToBackorderIds)) {
    for (const p of pickings) if (notToBackorderIds.includes(p.id) && p.create_backorder !== "always") notTo.add(p.id);
    if (notToBackorderIds.some((id) => !pickings.some((p) => p.id === id))) throw new NotPorted("picking_ids_not_to_backorder outside the validated transfers");
  }
  const noBackorder = pickings.filter((p) => notTo.has(p.id));
  const withBackorder = pickings.filter((p) => !notTo.has(p.id));
  if (noBackorder.length) await pickingsDone(ctxEnv.withContext({ ...ctxEnv.context, cancel_backorder: true }), noBackorder, true);
  if (withBackorder.length) await pickingsDone(ctxEnv.withContext({ ...ctxEnv.context, cancel_backorder: false }), withBackorder, false);
  pickings = await pickingRows(ctxEnv, ids);
  if (pickings.some((p) => p.auto_print)) throw new NotPorted("stock.picking autoprint report actions");
  // a transfer with a project, of a type with analytic costs: project_stock_account stock_move.py:11-14 creates its
  // analytic lines and sale_project_stock stock_picking.py:10-40 re-invoices them to the project's sale order (refused,
  // the transaction is rolled back); of another type both skip it (`continue`, the filter on `analytic_costs`)
  const projected = pickings.filter((p) => p.project_id).map((p) => p.id);
  if (projected.length && (await rows(ctxEnv,
    "SELECT 1 FROM stock_picking p JOIN stock_picking_type t ON t.id = p.picking_type_id WHERE p.id = ANY($1::int[]) AND t.analytic_costs LIMIT 1", [projected])).length) {
    throw new NotPorted("button_validate of a transfer with a project and analytic costs (project_stock_account, sale_project_stock)");
  }
  if (await hasGroup(ctxEnv, "stock.group_stock_picking_batch")) throw new NotPorted("stock.picking batch auto-assignment after validation");
  return true;
}

registerMethod("stock.picking", "button_validate", async (env, ids) => buttonValidate(env, ids ?? []), { apiModel: false });

/** stock_sms confirm_stock_sms.py:13-31 `send_sms` / `dont_send_sms`: the companies are marked as warned, then the transfers validated. */
async function confirmSms(env: Environment, ids: readonly number[], send: boolean): Promise<unknown> {
  if (ids.length !== 1) throw new UserError(translate(env, "Expected singleton: confirm.stock.sms"));
  const companies = (await rows<{ id: number; warned: boolean | null }>(env,
    `SELECT DISTINCT c.id, c.has_received_warning_stock_sms AS warned FROM stock_picking_sms_rel r JOIN stock_picking p ON p.id = r.stock_picking_id
       JOIN res_company c ON c.id = p.company_id WHERE r.confirm_stock_sms_id = $1 ORDER BY c.id`, [ids[0]]));
  for (const c of companies) {
    if (c.warned) continue;
    await write(env.sudo(), "res.company", [c.id], send ? { has_received_warning_stock_sms: true } : { has_received_warning_stock_sms: true, stock_text_confirmation: false });
  }
  const pickings = (env.context["button_validate_picking_ids"] as number[] | undefined) ?? [];
  return buttonValidate(env, pickings);
}

registerMethod("confirm.stock.sms", "send_sms", async (env, ids) => confirmSms(env, ids ?? [], true), { apiModel: false });
registerMethod("confirm.stock.sms", "dont_send_sms", async (env, ids) => confirmSms(env, ids ?? [], false), { apiModel: false });

// stock_move.py:313-317 `_inverse_picked` is on the lines (src/models/stock_new.ts registers the move inverses)
export async function inversePicked(env: Environment, moveIds: readonly number[]): Promise<void> {
  if (!moveIds.length) return;
  const su = env.sudo();
  const moveDef = env.reg.model("stock.move");
  const pickedIds: number[] = [];
  const unpickedIds: number[] = [];
  for (const id of moveIds) {
    const m = new DbRec(su, moveDef, id);
    if (await m.get("picked")) pickedIds.push(id);
    else unpickedIds.push(id);
  }
  for (const [picked, ids] of [[true, pickedIds], [false, unpickedIds]] as const) {
    if (!ids.length) continue;
    const lines: number[] = [];
    for (const id of ids) {
      for (const l of await new DbRec(su, moveDef, id).rels("move_line_ids")) if (l.id !== null) lines.push(l.id);
    }
    lines.sort((a, b) => a - b);
    if (lines.length) await write(env, "stock.move.line", lines, { picked });
  }
}


/** stock_move.py:2346-2351 `_check_quantity` with stock_quant.py:619-635 `check_quantity` (sudo). */
async function checkSerialQuantity(env: Environment, moveIds: readonly number[]): Promise<void> {
  // `_check_quantity`: the quants of the moves' products and lots in their destinations (child_of)
  const sn = await rows<{ product_id: number; location_id: number; lot_id: number }>(env,
    `SELECT DISTINCT q.product_id, q.location_id, q.lot_id FROM stock_quant q
       JOIN product_product p ON p.id = q.product_id JOIN product_template t ON t.id = p.product_tmpl_id JOIN stock_location loc ON loc.id = q.location_id
      WHERE q.product_id IN (SELECT product_id FROM stock_move WHERE id = ANY($1::int[]))
        AND q.lot_id IN (SELECT lot_id FROM stock_move_line WHERE move_id = ANY($1::int[]) AND lot_id IS NOT NULL)
        AND EXISTS (SELECT 1 FROM stock_move m JOIN stock_location d ON d.id = m.location_dest_id WHERE m.id = ANY($1::int[]) AND loc.parent_path LIKE d.parent_path || '%')
        AND t.tracking = 'serial' AND loc.usage != 'inventory'`, [[...moveIds]]);
  if (!sn.length) return;
  // check_quantity: the sum per (product, location, lot) over the sn quants' products, locations (child_of) and lots
  const groups = await rows<{ product: number; lot: number; qty: number }>(env,
    `SELECT q.product_id AS product, q.lot_id AS lot, sum(q.quantity)::float8 AS qty FROM stock_quant q JOIN stock_location loc ON loc.id = q.location_id
      WHERE q.product_id = ANY($1::int[]) AND q.lot_id = ANY($2::int[])
        AND EXISTS (SELECT 1 FROM stock_location l2 WHERE l2.id = ANY($3::int[]) AND loc.parent_path LIKE l2.parent_path || '%')
      GROUP BY q.product_id, q.location_id, q.lot_id`,
    [[...new Set(sn.map((r) => r.product_id))], [...new Set(sn.map((r) => r.lot_id))], [...new Set(sn.map((r) => r.location_id))]]);
  const bad: typeof groups = [];
  for (const g of groups) if ((await uomCompare(env, Math.abs(g.qty), 1)) > 0) bad.push(g);
  if (!bad.length) return;
  if (bad.length > 1) throw new NotPorted("stock.quant.check_quantity with several serial numbers assigned twice (read_group order)");
  const product = (await env.sudo().model("product.product").displayName([bad[0]!.product])).get(bad[0]!.product) ?? "";
  const [lot] = await rows<{ name: string }>(env, "SELECT name FROM stock_lot WHERE id = $1", [bad[0]!.lot]);
  throw new ValidationError(
    translate(env, "The serial number has already been assigned: \n Product: %(product)s, Serial Number: %(serial_number)s", "stock")
      .replace("%(product)s", product)
      .replace("%(serial_number)s", lot!.name),
  );
}
