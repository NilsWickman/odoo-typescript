/**
 * `ir.ui.view` view combination: `_get_combined_arch`, `_get_combined_archs`, `_get_inheriting_views` and
 * `_combine` of odoo/odoo/addons/base/models/ir_ui_view.py (Odoo 20, commit dd5d3718; line numbers below refer to
 * it), on top of the template_inheritance.py port in ./inheritance.ts.
 *
 * Group filtering: Odoo 20 does not filter inheriting views by groups. An extension view cannot carry `group_ids`
 * (constraint `_check_groups`, ir_ui_view.py:550-556) and `_get_inheriting_views` (734-790) only filters on
 * `active` (`_get_inheriting_views_domain`, 718-724). Groups on *nodes* (`groups="..."` attributes) are handled by
 * the view postprocessing (`_postprocess_access_rights`, 1331-1360) and by QWeb's `t-groups`, not here.
 * `userGroupXmlids` is therefore accepted for the agreed interface but does not change the result.
 */
import type { Cursor } from "../db";
import { MissingError } from "../errors";
import { element, type Element } from "../xml/node";
import { parseXml } from "../xml/parse";
import { serializeXml } from "../xml/serialize";
import { applyInheritanceSpecs } from "./inheritance";
import { flagInheritingArch } from "../modules/view_buttons";

/** The part of the request cursor this module needs (so pure tests can pass a pg client). */
export type SqlCursor = Pick<Cursor, "query">;

export interface ViewRow {
  readonly id: number;
  readonly inheritId: number | null;
  readonly mode: "primary" | "extension";
  readonly priority: number;
  readonly key: string | null;
  readonly model: string | null;
  readonly type: string | null;
  readonly active: boolean;
  /** `arch_db` for the language, falling back to en_US (fields_textual.py: jsonb translations). */
  readonly arch: string | null;
}

interface RawRow {
  id: number;
  inherit_id: number | null;
  mode: string;
  priority: number;
  key: string | null;
  model: string | null;
  type: string | null;
  active: boolean;
  arch: string | null;
}

const VIEW_COLUMNS = `v.id, v.inherit_id, v.mode, v.priority, v.key, v.model, v.type, v.active,
  COALESCE(v.arch_db->>$LANG, v.arch_db->>'en_US') AS arch`;

function toRow(r: RawRow): ViewRow {
  if (r.mode !== "primary" && r.mode !== "extension") throw new Error(`ir_ui_view ${r.id}: unexpected mode ${r.mode}`);
  return {
    id: r.id,
    inheritId: r.inherit_id,
    mode: r.mode,
    priority: r.priority,
    key: r.key,
    model: r.model,
    type: r.type,
    active: r.active,
    arch: r.arch,
  };
}

export async function fetchViews(cr: SqlCursor, ids: readonly number[], lang: string): Promise<Map<number, ViewRow>> {
  if (ids.length === 0) return new Map();
  const res = await cr.query<RawRow>(`SELECT ${VIEW_COLUMNS.replace("$LANG", "$2")} FROM ir_ui_view v WHERE v.id = ANY($1::int[])`, [ids, lang]);
  return new Map(res.rows.map((r) => [r.id, toRow(r)]));
}

/**
 * `_get_inheriting_views` (734-790): the seed views (if active) plus, recursively, their active extension views
 * on the same model, ordered by priority then id. (Odoo's `_get_inheriting_views_domain` is `active = True`.)
 */
export async function getInheritingViews(cr: SqlCursor, seedIds: readonly number[], lang: string): Promise<ViewRow[]> {
  if (seedIds.length === 0) return [];
  const res = await cr.query<RawRow>(
    `WITH RECURSIVE ir_ui_view_inherits AS (
        SELECT ir_ui_view.id, ir_ui_view.inherit_id, ir_ui_view.mode, ir_ui_view.priority, ir_ui_view.model
        FROM ir_ui_view
        WHERE id = ANY($1::int[]) AND (ir_ui_view.active IS TRUE)
      UNION
        SELECT ir_ui_view.id, ir_ui_view.inherit_id, ir_ui_view.mode, ir_ui_view.priority, ir_ui_view.model
        FROM ir_ui_view
        INNER JOIN ir_ui_view_inherits parent ON parent.id = ir_ui_view.inherit_id
        WHERE coalesce(ir_ui_view.model, '') = coalesce(parent.model, '')
              AND ir_ui_view.mode = 'extension'
              AND (ir_ui_view.active IS TRUE)
    )
    SELECT ${VIEW_COLUMNS.replace("$LANG", "$2")}
    FROM ir_ui_view_inherits i JOIN ir_ui_view v ON v.id = i.id
    ORDER BY i.priority, i.id`,
    [seedIds, lang],
  );
  return res.rows.map(toRow);
}

/**
 * `_combine(hierarchy)` (980-1051): pre-order depth-first traversal where primary views (and their children) are
 * applied after all extensions of the current primary view.
 */
export function combine(root: ViewRow, hierarchy: ReadonlyMap<number, readonly ViewRow[]>, validateId: number | true | null = null): Element {
  if (root.mode !== "primary") throw new Error(`_combine: view ${root.id} is not primary`);
  if (root.arch === null) throw new MissingError(`view ${root.id} has no arch`);
  let combinedArch = parseXml(root.arch);
  // `_add_validation_flag(combined_arch)` (ir_ui_view.py:907-924): the partial validation of `_check_xml`
  // `validate_view_ids is True` (the full validation of `_check_xml` outside create) flags the root as well
  if (validateId !== null && (validateId === true || validateId === root.id)) combinedArch.attrib.set("__validate__", "1");
  // `sorted(hierarchy[self], key=lambda v: v.mode)`: 'extension' sorts before 'primary' (stable)
  const queue: ViewRow[] = [...(hierarchy.get(root.id) ?? [])].sort((a, b) => (a.mode < b.mode ? -1 : a.mode > b.mode ? 1 : 0));
  while (queue.length > 0) {
    const view = queue.shift()!;
    const arch = view.arch !== null && view.arch !== "" ? parseXml(view.arch) : element("data");
    if (validateId !== null && (validateId === true || validateId === root.id)) combinedArch.attrib.set("__validate__", "1");
    else if (validateId !== null && view.id === validateId) flagInheritingArch(combinedArch, arch);
    combinedArch = applyInheritanceSpecs(combinedArch, arch);
    for (const child of [...(hierarchy.get(view.id) ?? [])].reverse()) {
      if (child.mode === "primary") queue.push(child);
      else queue.unshift(child);
    }
  }
  return combinedArch;
}

export interface CombineOptions {
  /** `lang` of the environment (translated archs); default en_US. */
  readonly lang?: string;
  /** `validate_view_ids` of `_check_xml`'s partial validation: the view whose nodes get `__validate__`. */
  readonly validateId?: number | true;
}

/**
 * `_get_combined_arch()` for one view (1057-1116): walk `inherit_id` up to the root, collect the inheriting views
 * of every view on that chain, and combine from the root. The arch of a primary view that itself inherits (e.g.
 * web.frontend_layout) is thus its parent's arch with its own specs applied, then its extensions.
 */
export async function combinedArchTree(
  cr: SqlCursor,
  viewId: number,
  _userGroupXmlids: ReadonlySet<string>,
  opts: CombineOptions = {},
): Promise<Element> {
  const lang = opts.lang ?? "en_US";
  // the chain from the requested view to its root (`parented`, 1066-1073)
  const parented: number[] = [];
  let root: ViewRow | null = null;
  let current = viewId;
  for (;;) {
    const rows = await fetchViews(cr, [current], lang);
    const view = rows.get(current);
    if (view === undefined) throw new MissingError(`Record does not exist or has been deleted.\n(Record: ir.ui.view(${current},), User: 1)`);
    parented.push(view.id);
    if (view.inheritId === null) {
      root = view;
      break;
    }
    current = view.inheritId;
  }
  const allTreeViews = await getInheritingViews(cr, parented, lang);
  // `children_views`: inherit_id -> children in (priority, id) order (1090-1093)
  const childrenViews = new Map<number, ViewRow[]>();
  for (const view of allTreeViews) {
    if (view.inheritId === null) continue;
    const list = childrenViews.get(view.inheritId);
    if (list === undefined) childrenViews.set(view.inheritId, [view]);
    else list.push(view);
  }
  // `get_hierarchy(root, parented_ids)` (1095-1104): primary children only when they are on the requested chain
  const parentedIds = new Set(parented);
  const hierarchy = new Map<number, ViewRow[]>();
  const getHierarchy = (view: ViewRow): void => {
    for (const child of childrenViews.get(view.id) ?? []) {
      if (parentedIds.has(child.id) || child.mode !== "primary") {
        const list = hierarchy.get(view.id);
        if (list === undefined) hierarchy.set(view.id, [child]);
        else list.push(child);
        getHierarchy(child);
      }
    }
  };
  getHierarchy(root);
  return combine(root, hierarchy, opts.validateId ?? null);
}

/** `get_combined_arch()` (1053-1055): the combined arch as `etree.tostring(..., encoding='unicode')`. */
export async function combinedArch(cr: SqlCursor, viewId: number, userGroupXmlids: ReadonlySet<string>, opts: CombineOptions = {}): Promise<string> {
  return serializeXml(await combinedArchTree(cr, viewId, userGroupXmlids, opts));
}

export { applyInheritanceSpecs, locateNode } from "./inheritance";
