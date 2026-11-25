/**
 * Wave 2 stock package buttons & shared package validation helpers (odoo/addons/stock/models/stock_package.py,
 * stock_package_history.py, stock_picking.py, stock_move_line.py).
 */
import { UserError } from "../errors";
import { registerMethod } from "../http/methods";
import { hasGroup } from "../orm/env";
import type { Environment } from "../orm/types";
import { unlink } from "../orm/unlink";
import { write } from "../orm/write";
import { envFor } from "../web/common";
import { applyPutaway, uomCompare } from "./stock_engine";
import { translate } from "./util";

const idOf = (v: unknown): number | null =>
  typeof v === "number" && v > 0 ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : null;

function ensureOne(ids: readonly number[] | null, model: string): number {
  if (ids === null || ids.length !== 1) throw new UserError(`Expected singleton: ${model}(${(ids ?? []).join(", ")})`);
  return ids[0]!;
}

async function rows<T extends object>(env: Environment, text: string, params: unknown[] = []): Promise<T[]> {
  return (await env.cr.query<T & Record<string, unknown>>(text, params)).rows;
}

/**
 * stock_package.py:533-545 `_get_all_package_dest_ids`: all parent destination packages recursively
 * (including `pkgIds` themselves), sorted ascending (matching Python int set iteration order).
 */
export async function getAllPackageDestIds(env: Environment, pkgIds: readonly number[]): Promise<number[]> {
  const seen = new Set<number>(pkgIds);
  let frontier = [...seen];
  while (frontier.length) {
    const next = await rows<{ p: number }>(
      env,
      "SELECT DISTINCT package_dest_id AS p FROM stock_package WHERE id = ANY($1::int[]) AND package_dest_id IS NOT NULL",
      [frontier],
    );
    frontier = [];
    for (const r of next) {
      if (!seen.has(r.p)) {
        seen.add(r.p);
        frontier.push(r.p);
      }
    }
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * stock_package.py:511-531 `_get_all_children_package_dest_ids`: all child packages recursively linked via
 * `package_dest_id`. Returns per-package descendant list and the flat set of all ids (including `pkgIds`).
 */
export async function getAllChildrenPackageDestIds(
  env: Environment,
  pkgIds: readonly number[],
): Promise<{ byPack: Map<number, number[]>; allIds: number[] }> {
  const all = new Set<number>(pkgIds);
  const childrenMap = new Map<number, number[]>();
  let frontier = [...all];
  while (frontier.length) {
    const found = await rows<{ id: number; parent: number }>(
      env,
      "SELECT id, package_dest_id AS parent FROM stock_package WHERE package_dest_id = ANY($1::int[]) ORDER BY id",
      [frontier],
    );
    frontier = [];
    for (const r of found) {
      childrenMap.set(r.parent, [...(childrenMap.get(r.parent) ?? []), r.id]);
      if (!all.has(r.id)) {
        all.add(r.id);
        frontier.push(r.id);
      }
    }
  }
  const collect = (id: number, visited = new Set<number>()): number[] => {
    const direct = childrenMap.get(id) ?? [];
    const out: number[] = [];
    for (const c of direct) {
      if (visited.has(c)) continue;
      visited.add(c);
      out.push(c, ...collect(c, visited));
    }
    return out;
  };
  const byPack = new Map<number, number[]>();
  for (const id of pkgIds) {
    const desc = collect(id);
    if (desc.length) byPack.set(id, desc);
  }
  return { byPack, allIds: [...all].sort((a, b) => a - b) };
}

/**
 * stock_package.py:143-155 `_compute_move_line_ids`: active (not done/cancel) move lines whose `result_package_id`
 * is in the package or any of its recursive `child_package_dest_ids`.
 */
async function activePackageMoveLines(
  env: Environment,
  pkgIds: readonly number[],
): Promise<{
  byPack: Map<number, { id: number; picking_id: number | null; result_package_id: number | null; location_dest_id: number; is_entire_pack: boolean | null; move_id: number | null }[]>;
  allLines: { id: number; picking_id: number | null; result_package_id: number | null; location_dest_id: number; is_entire_pack: boolean | null; move_id: number | null }[];
}> {
  if (!pkgIds.length) return { byPack: new Map(), allLines: [] };
  const { byPack: childrenByPack, allIds } = await getAllChildrenPackageDestIds(env, pkgIds);
  const allLines = await rows<{
    id: number; picking_id: number | null; result_package_id: number | null; location_dest_id: number;
    is_entire_pack: boolean | null; move_id: number | null;
  }>(
    env,
    `SELECT id, picking_id, result_package_id, location_dest_id, is_entire_pack, move_id
       FROM stock_move_line
      WHERE COALESCE(state, '') NOT IN ('done', 'cancel') AND result_package_id = ANY($1::int[])
      ORDER BY result_package_id DESC NULLS LAST, id`,
    [allIds],
  );
  const linesByDirectPkg = new Map<number, typeof allLines>();
  for (const l of allLines) {
    if (l.result_package_id === null) continue;
    linesByDirectPkg.set(l.result_package_id, [...(linesByDirectPkg.get(l.result_package_id) ?? []), l]);
  }
  const byPack = new Map<number, typeof allLines>();
  for (const pid of pkgIds) {
    const scope = new Set<number>([pid, ...(childrenByPack.get(pid) ?? [])]);
    const list: typeof allLines = [];
    const seen = new Set<number>();
    for (const sp of scope) {
      for (const l of linesByDirectPkg.get(sp) ?? []) {
        if (!seen.has(l.id)) {
          seen.add(l.id);
          list.push(l);
        }
      }
    }
    list.sort((a, b) => a.id - b.id);
    byPack.set(pid, list);
  }
  return { byPack, allLines };
}

/**
 * stock_move_line.py:1018-1024 `_prepare_package_history_vals` + stock_package.py:560-574 `_get_package_vals`.
 */
export async function preparePackageHistoryVals(
  env: Environment,
  resultPkgIds: readonly number[],
): Promise<Record<string, unknown>[]> {
  if (!resultPkgIds.length) return [];
  const allPkgIds = await getAllPackageDestIds(env, resultPkgIds);
  if (!allPkgIds.length) return [];
  const pkgRows = await rows<{
    id: number; name: string; complete_name: string | null; location_id: number | null;
    parent_package_id: number | null; package_dest_id: number | null;
  }>(
    env,
    "SELECT id, name, complete_name, location_id, parent_package_id, package_dest_id FROM stock_package WHERE id = ANY($1::int[])",
    [allPkgIds],
  );
  const pkgById = new Map(pkgRows.map((p) => [p.id, p]));
  // Parent orig names (for packages whose parent_package_id might not be in allPkgIds)
  const missingParents = [...new Set(pkgRows.map((p) => p.parent_package_id).filter((id): id is number => id !== null && !pkgById.has(id)))];
  const parentOrigNames = new Map<number, string>();
  for (const p of pkgRows) parentOrigNames.set(p.id, p.complete_name ?? p.name);
  if (missingParents.length) {
    for (const r of await rows<{ id: number; cn: string }>(env, "SELECT id, COALESCE(complete_name, name) AS cn FROM stock_package WHERE id = ANY($1::int[])", [missingParents])) {
      parentOrigNames.set(r.id, r.cn);
    }
  }
  const destCompleteName = (id: number, visited = new Set<number>()): string => {
    const p = pkgById.get(id);
    if (!p) return "";
    if (p.package_dest_id && !visited.has(p.package_dest_id)) {
      visited.add(id);
      return `${destCompleteName(p.package_dest_id, visited)} > ${p.name}`;
    }
    return p.name;
  };
  const outermostId = (id: number, visited = new Set<number>()): number => {
    const p = pkgById.get(id);
    if (!p || !p.package_dest_id || visited.has(p.package_dest_id)) return id;
    visited.add(id);
    return outermostId(p.package_dest_id, visited);
  };
  const { byPack } = await activePackageMoveLines(env, allPkgIds);
  const out: Record<string, unknown>[] = [];
  for (const pid of allPkgIds) {
    const p = pkgById.get(pid);
    if (!p) continue;
    const mls = byPack.get(pid) ?? [];
    const directMls = mls.filter((l) => l.result_package_id === pid).map((l) => l.id);
    const pickingIds = [...new Set(mls.map((l) => l.picking_id).filter((x): x is number => x !== null))].sort((a, b) => a - b);
    const locationDestId = mls.length ? mls[0]!.location_dest_id : false;
    out.push({
      location_id: p.location_id ?? false,
      location_dest_id: locationDestId,
      move_line_ids: [[6, 0, directMls]],
      picking_ids: [[6, 0, pickingIds]],
      package_id: pid,
      package_name: p.complete_name ?? p.name,
      parent_orig_id: p.parent_package_id ?? false,
      parent_orig_name: p.parent_package_id ? (parentOrigNames.get(p.parent_package_id) ?? false) : false,
      parent_dest_id: p.package_dest_id ?? false,
      parent_dest_name: p.package_dest_id ? destCompleteName(p.package_dest_id) : false,
      outermost_dest_id: outermostId(pid),
    });
  }
  return out;
}

/**
 * stock_package.py:476-510 `_apply_dest_to_package`: moves packages to their destination container
 * (`parent_package_id = package_dest_id`, `package_dest_id = False`), validating location consistency.
 */
export async function applyDestToPackage(
  env: Environment,
  pkgIds: readonly number[],
  processed = new Set<number>(),
): Promise<void> {
  const todoIds = [...new Set(pkgIds)].filter((id) => !processed.has(id));
  if (!todoIds.length) return;
  const pkgs = await rows<{
    id: number; name: string; location_id: number | null; package_dest_id: number | null; parent_package_id: number | null;
  }>(
    env,
    "SELECT id, name, location_id, package_dest_id, parent_package_id FROM stock_package WHERE id = ANY($1::int[]) ORDER BY name, id",
    [todoIds],
  );
  // Group by package_dest_id (preserving order)
  const groups = new Map<number | null, typeof pkgs>();
  for (const p of pkgs) {
    const k = p.package_dest_id ?? null;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const nextParents = new Set<number>();
  for (const [containerId, group] of groups) {
    const gIds = group.map((p) => p.id);
    if (containerId === null) {
      await write(env, "stock.package", gIds, { parent_package_id: false });
      for (const id of gIds) processed.add(id);
      continue;
    }
    const newLocs = [...new Set(group.map((p) => p.location_id).filter((l): l is number => l !== null))];
    if (newLocs.length > 1) {
      const [c] = await rows<{ name: string }>(env, "SELECT name FROM stock_package WHERE id = $1", [containerId]);
      throw new UserError(
        translate(env, "Packages %(duplicate_names)s are moved to different locations while being in the same container %(container_name)s.", "stock")
          .replace("%(duplicate_names)s", `[${group.map((p) => `'${p.name}'`).join(", ")}]`)
          .replace("%(container_name)s", c?.name ?? ""),
      );
    }
    // Check container's existing non-zero contained quants (container + its child_of packages)
    const [cPath] = await rows<{ parent_path: string | null }>(env, "SELECT parent_path FROM stock_package WHERE id = $1", [containerId]);
    const containerQuants = await rows<{ location_id: number; quantity: number }>(
      env,
      `SELECT q.location_id, q.quantity::float8 AS quantity
         FROM stock_quant q JOIN stock_package p ON p.id = q.package_id
        WHERE p.id = $1 OR ($2::text IS NOT NULL AND p.parent_path LIKE $2 || '%')`,
      [containerId, cPath?.parent_path ?? null],
    );
    const nonZeroLocs = new Set<number>();
    for (const q of containerQuants) {
      if ((await uomCompare(env, q.quantity, 0)) !== 0) nonZeroLocs.add(q.location_id);
    }
    if (nonZeroLocs.size) {
      const newLoc = newLocs[0] ?? null;
      const oldLocs = [...nonZeroLocs].filter((l) => l !== newLoc);
      if (oldLocs.length) {
        const oldNames = await env.sudo().model("stock.location").displayName(oldLocs);
        const newNames = newLoc ? await env.sudo().model("stock.location").displayName([newLoc]) : new Map<number, string>();
        throw new UserError(
          translate(env, "Can't move a container having packages in another location (%(old_location)s) to a different location (%(new_location)s).", "stock")
            .replace("%(old_location)s", oldNames.get(oldLocs[0]!) ?? "")
            .replace("%(new_location)s", newLoc ? (newNames.get(newLoc) ?? "") : ""),
        );
      }
    }
    await write(env, "stock.package", gIds, { parent_package_id: containerId, package_dest_id: false });
    for (const id of gIds) processed.add(id);
    nextParents.add(containerId);
  }
  if (nextParents.size) {
    const parentRows = await rows<{ id: number; parent_package_id: number | null; package_dest_id: number | null }>(
      env,
      "SELECT id, parent_package_id, package_dest_id FROM stock_package WHERE id = ANY($1::int[])",
      [[...nextParents]],
    );
    if (parentRows.some((p) => p.package_dest_id !== null || p.parent_package_id !== null)) {
      await applyDestToPackage(env, parentRows.map((p) => p.id), processed);
    }
  }
}

/** stock_package.py:414-433 `_check_move_lines_map_quant` + stock_picking.py:1068-1071. */
async function checkMoveLinesMapQuantPackage(
  env: Environment,
  pickingIds: readonly number[],
  pkgId: number,
): Promise<boolean> {
  if (!pickingIds.length) return false;
  const [pRow] = await rows<{ parent_path: string | null }>(env, "SELECT parent_path FROM stock_package WHERE id = $1", [pkgId]);
  const childIds = (await rows<{ id: number }>(
    env,
    "SELECT id FROM stock_package WHERE id = $1 OR ($2::text IS NOT NULL AND parent_path LIKE $2 || '%')",
    [pkgId, pRow?.parent_path ?? null],
  )).map((r) => r.id);
  const moveLines = await rows<{ product_id: number; lot_id: number | null; qpu: number }>(
    env,
    `SELECT l.product_id, l.lot_id, COALESCE(l.quantity_product_uom, 0)::float8 AS qpu
       FROM stock_move_line l
       JOIN product_product p ON p.id = l.product_id
       JOIN product_template t ON t.id = p.product_tmpl_id
      WHERE l.picking_id = ANY($1::int[]) AND COALESCE(t.is_storable, false) AND l.package_id = ANY($2::int[])`,
    [[...pickingIds], childIds],
  );
  if (!moveLines.length) return true;
  const quants = await rows<{ product_id: number; lot_id: number | null; quantity: number }>(
    env,
    `SELECT product_id, lot_id, COALESCE(quantity, 0)::float8 AS quantity
       FROM stock_quant
      WHERE package_id = ANY($1::int[]) AND (quantity != 0 OR reserved_quantity != 0)`,
    [childIds],
  );
  const qMap = new Map<string, number>();
  for (const q of quants) {
    const k = `${q.product_id}/${q.lot_id ?? ""}`;
    qMap.set(k, (qMap.get(k) ?? 0) + q.quantity);
  }
  const mlMap = new Map<string, number>();
  for (const l of moveLines) {
    const k = `${l.product_id}/${l.lot_id ?? ""}`;
    mlMap.set(k, (mlMap.get(k) ?? 0) + l.qpu);
  }
  for (const k of new Set([...qMap.keys(), ...mlMap.keys()])) {
    if ((await uomCompare(env, (qMap.get(k) ?? 0) - (mlMap.get(k) ?? 0), 0)) !== 0) return false;
  }
  return true;
}

/** stock_package.py:546-559 `_apply_package_dest_for_entire_packs`. */
async function applyPackageDestForEntirePacks(
  env: Environment,
  pkgIds: readonly number[],
  allowedIds: ReadonlySet<number> | null = null,
): Promise<void> {
  const uniq = [...new Set(pkgIds)];
  if (!uniq.length) return;
  const pkgs = await rows<{ id: number; parent_package_id: number | null }>(
    env,
    "SELECT id, parent_package_id FROM stock_package WHERE id = ANY($1::int[]) AND parent_package_id IS NOT NULL ORDER BY id",
    [uniq],
  );
  const byContainer = new Map<number, number[]>();
  for (const p of pkgs) {
    byContainer.set(p.parent_package_id!, [...(byContainer.get(p.parent_package_id!) ?? []), p.id]);
  }
  const assignedContainers: number[] = [];
  for (const [containerId, groupIds] of byContainer) {
    if (allowedIds && !allowedIds.has(containerId)) continue;
    const [cInfo] = await rows<{ package_use: string | null }>(
      env,
      "SELECT pt.package_use FROM stock_package p LEFT JOIN stock_package_type pt ON pt.id = p.package_type_id WHERE p.id = $1",
      [containerId],
    );
    if (cInfo?.package_use === "reusable") continue;
    const allChildren = (await rows<{ id: number }>(env, "SELECT id FROM stock_package WHERE parent_package_id = $1 ORDER BY id", [containerId])).map((r) => r.id);
    if (allChildren.length === groupIds.length && allChildren.every((cid, i) => cid === groupIds[i])) {
      await write(env, "stock.package", groupIds, { package_dest_id: containerId });
      assignedContainers.push(containerId);
    }
  }
  if (assignedContainers.length) {
    await applyPackageDestForEntirePacks(env, assignedContainers, allowedIds);
  }
}

/** stock_picking.py:1085-1099 `_check_entire_pack`. */
export async function checkEntirePack(env: Environment, pickingIds: readonly number[]): Promise<void> {
  const uniqPickings = [...new Set(pickingIds)];
  if (!uniqPickings.length) return;
  const mls = await rows<{
    id: number; picking_id: number | null; package_id: number | null; result_package_id: number | null; state: string | null;
  }>(
    env,
    "SELECT id, picking_id, package_id, result_package_id, state FROM stock_move_line WHERE picking_id = ANY($1::int[]) ORDER BY id",
    [uniqPickings],
  );
  const byPkg = new Map<number, typeof mls>();
  for (const l of mls) {
    if (l.package_id !== null) byPkg.set(l.package_id, [...(byPkg.get(l.package_id) ?? []), l]);
  }
  const hasBatchGroup = await hasGroup(env, "stock.group_stock_picking_batch");
  for (const [pkgId, pkgMls] of byPkg) {
    const pIds = [...new Set(pkgMls.map((l) => l.picking_id).filter((x): x is number => x !== null))];
    let isSingle = pIds.length === 1;
    if (!isSingle && hasBatchGroup && pIds.length > 1) {
      const batches = new Set((await rows<{ b: number | null }>(env, "SELECT DISTINCT batch_id AS b FROM stock_picking WHERE id = ANY($1::int[])", [pIds])).map((r) => r.b));
      isSingle = batches.size === 1 && !batches.has(null);
    }
    if (isSingle && pIds.length > 0 && (await checkMoveLinesMapQuantPackage(env, pIds, pkgId))) {
      const toPack = pkgMls.filter((l) => !l.result_package_id && l.state !== "done" && l.state !== "cancel").map((l) => l.id);
      if (toPack.length) {
        const [pInfo] = await rows<{ package_use: string | null }>(
          env,
          "SELECT pt.package_use FROM stock_package p LEFT JOIN stock_package_type pt ON pt.id = p.package_type_id WHERE p.id = $1",
          [pkgId],
        );
        if (pInfo?.package_use !== "reusable") {
          await write(env, "stock.move.line", toPack, { result_package_id: pkgId, is_entire_pack: true });
        }
      }
    }
  }
  const resultPkgIds = (await rows<{ p: number }>(
    env,
    "SELECT DISTINCT result_package_id AS p FROM stock_move_line WHERE picking_id = ANY($1::int[]) AND result_package_id IS NOT NULL ORDER BY p",
    [uniqPickings],
  )).map((r) => r.p);
  if (resultPkgIds.length) await applyPackageDestForEntirePacks(env, resultPkgIds);
}

/** stock_move_line.py:1102-1116 `_get_lines_not_entire_pack` applied to pickings after move line unlink. */
export async function clearNotEntirePackLines(env: Environment, pickingIds: readonly number[]): Promise<void> {
  const uniqPickings = [...new Set(pickingIds)];
  if (!uniqPickings.length) return;
  const relevant = await rows<{ id: number; picking_id: number | null; package_id: number | null; result_package_id: number | null }>(
    env,
    "SELECT id, picking_id, package_id, result_package_id FROM stock_move_line WHERE picking_id = ANY($1::int[]) AND COALESCE(is_entire_pack, false) ORDER BY id",
    [uniqPickings],
  );
  if (!relevant.length) return;
  const toClear = new Set<number>();
  const byPkg = new Map<number | null, typeof relevant>();
  for (const l of relevant) {
    if (l.package_id !== l.result_package_id) toClear.add(l.id);
    byPkg.set(l.package_id, [...(byPkg.get(l.package_id) ?? []), l]);
  }
  for (const [pkgId, pkgMls] of byPkg) {
    const pIds = [...new Set(pkgMls.map((l) => l.picking_id).filter((x): x is number => x !== null))];
    const ok = pkgId !== null && pIds.length === 1 && (await checkMoveLinesMapQuantPackage(env, pIds, pkgId));
    if (!ok) {
      for (const l of pkgMls) toClear.add(l.id);
    }
  }
  if (toClear.size) await write(env, "stock.move.line", [...toClear].sort((a, b) => a - b), { is_entire_pack: false });
}

/** stock_move_line.py:580-582: clear `package_dest_id` on packages not linked to any active picking. */
export async function clearIsolatedPackageDests(env: Environment, pkgIds: readonly number[]): Promise<void> {
  const uniq = [...new Set(pkgIds)];
  if (!uniq.length) return;
  const withDest = (await rows<{ id: number }>(
    env,
    "SELECT id FROM stock_package WHERE id = ANY($1::int[]) AND package_dest_id IS NOT NULL ORDER BY id",
    [uniq],
  )).map((r) => r.id);
  if (!withDest.length) return;
  const { byPack } = await activePackageMoveLines(env, withDest);
  const isolated = withDest.filter((pid) => !(byPack.get(pid) ?? []).some((l) => l.picking_id !== null));
  if (isolated.length) await write(env, "stock.package", isolated, { package_dest_id: false });
}

// =================================================================================================================
// STOCK PACKAGE & PACKAGE HISTORY BUTTONS
// =================================================================================================================

/** stock_package_history.py:35-42 `action_show_package`. */
registerMethod("stock.package.history", "action_show_package", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const id = ensureOne(ids0, "stock.package.history");
  const [rec] = await env.model("stock.package.history").read([id], ["package_id"], "");
  return {
    type: "ir.actions.act_window",
    view_mode: "form",
    res_model: "stock.package",
    res_id: idOf(rec?.["package_id"]) ?? false,
  };
}, { apiModel: false });

/** stock_package.py:369-405 `action_remove_package`. */
registerMethod("stock.package", "action_remove_package", async (env0, ids0, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const ids = ids0 ?? [];
  if (!ids.length) return true;
  await env.model("stock.package").read(ids, ["id"], "");

  const allPackageDestIds = await getAllPackageDestIds(env, ids);
  const { allLines } = await activePackageMoveLines(env, ids);
  const allMoveLineIds = new Set(allLines.map((l) => l.id));
  const selfSet = new Set(ids);
  const ctxPickings = Array.isArray(env.context["picking_ids"]) && (env.context["picking_ids"] as unknown[]).length
    ? new Set((env.context["picking_ids"] as unknown[]).map(Number))
    : null;

  const toUnlink = new Set<number>();
  const relatedMoveIds = new Set<number>();
  const toUpdate = new Set<number>();

  for (const line of allLines) {
    if (ctxPickings && (line.picking_id === null || !ctxPickings.has(line.picking_id))) continue;
    if (line.result_package_id !== null && selfSet.has(line.result_package_id)) {
      if (line.is_entire_pack) {
        toUnlink.add(line.id);
        if (line.move_id !== null) relatedMoveIds.add(line.move_id);
      } else {
        toUpdate.add(line.id);
      }
    }
  }

  if (toUnlink.size) await unlink(env, "stock.move.line", [...toUnlink].sort((a, b) => a - b));
  if (toUpdate.size) await write(env, "stock.move.line", [...toUpdate].sort((a, b) => a - b), { result_package_id: false });

  if (relatedMoveIds.size) {
    const emptyMoves = (await rows<{ id: number }>(
      env,
      `SELECT m.id FROM stock_move m
        WHERE m.id = ANY($1::int[]) AND m.product_uom_qty = 0
          AND NOT EXISTS (SELECT 1 FROM stock_move_line l WHERE l.move_id = m.id)
        ORDER BY m.id`,
      [[...relatedMoveIds]],
    )).map((r) => r.id);
    if (emptyMoves.length) await unlink(env, "stock.move", emptyMoves);
  }

  // If packages in self are dest containers of other packages, remove them as their dest as well
  const childDestIds = (await rows<{ id: number }>(
    env,
    "SELECT id FROM stock_package WHERE package_dest_id = ANY($1::int[]) ORDER BY id",
    [ids],
  )).map((r) => r.id);
  if (childDestIds.length) await write(env, "stock.package", childDestIds, { package_dest_id: false });
  await write(env, "stock.package", ids, { package_dest_id: false });

  // If parent packages are now isolated from bottom-level packages, clear their destination container as well
  if (allPackageDestIds.length) {
    const { byPack } = await activePackageMoveLines(env, allPackageDestIds);
    const isolated = allPackageDestIds.filter((pid) => (byPack.get(pid) ?? []).length === 0);
    if (isolated.length) await write(env, "stock.package", isolated, { package_dest_id: false });
  }

  // Putaway check on remaining move lines
  const remainingMlIds = [...allMoveLineIds].filter((id) => !toUnlink.has(id));
  if (remainingMlIds.length) {
    const remMoveIds = (await rows<{ m: number }>(
      env,
      "SELECT DISTINCT move_id AS m FROM stock_move_line WHERE id = ANY($1::int[]) AND move_id IS NOT NULL ORDER BY m",
      [remainingMlIds],
    )).map((r) => r.m);
    if (remMoveIds.length) await applyPutaway(env, remMoveIds);
  }

  return true;
}, { apiModel: false });
