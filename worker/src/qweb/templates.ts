/**
 * Template loading for the QWeb renderer: `IrQweb._get_template` / `_preload_trees` (ir_qweb.py:1227-1339) and
 * `ir.ui.view._fetch_template_views` / `_get_view_etrees` (ir_ui_view.py:1195-1258, 2502-2507). A template
 * reference is a view id or a `key` (xmlid); the tree is the combined arch (inheritance applied). Sub-templates
 * named by static `t-call` attributes are loaded transitively, like `_preload_trees`, so rendering needs no I/O.
 */
import { MissingError, NotPorted } from "../errors";
import { iter, type Element } from "../xml/node";
import { combinedArchTree, type SqlCursor } from "../views/combine";
import { assetCallKey, assetLinks, type AssetCall } from "./assets";

export interface LoadedTemplate {
  /** The view id (`ref` in Odoo's compile context). */
  readonly id: number;
  /** The view key (`ref_name`), or null for a view without key. */
  readonly key: string | null;
  /** The combined arch; the renderer never mutates it. */
  readonly tree: Element;
}

export interface TemplateSet {
  readonly byRef: Map<string | number, LoadedTemplate>;
  /** Links per asset call key (assets.ts), preloaded for every `t-call-assets` in the loaded trees; a NotPorted
   *  (no compiled attachment) is kept and only raised when that `t-call-assets` is actually rendered. */
  readonly assets: Map<string, readonly string[] | NotPorted>;
  readonly rtl: boolean;
}

interface ViewInfo {
  id: number;
  key: string | null;
  type: string | null;
}

/** `_fetch_template_views` for one reference (ir_ui_view.py:1195-1258): by key (priority, id; active only), then ir.model.data. */
async function fetchTemplateView(cr: SqlCursor, ref: string | number): Promise<ViewInfo> {
  if (typeof ref === "number") {
    const r = await cr.query<ViewInfo>("SELECT id, key, type FROM ir_ui_view WHERE id = $1", [ref]);
    const row = r.rows[0];
    if (row === undefined) throw new MissingError(`Template not found: '${ref}'`);
    return row;
  }
  const byKey = await cr.query<ViewInfo>("SELECT id, key, type FROM ir_ui_view WHERE key = $1 AND active IS TRUE ORDER BY priority, id LIMIT 1", [ref]);
  if (byKey.rows[0] !== undefined) return byKey.rows[0];
  if (ref.includes(".")) {
    const dot = ref.indexOf(".");
    const byXmlid = await cr.query<ViewInfo>(
      `SELECT v.id, v.key, v.type FROM ir_model_data d JOIN ir_ui_view v ON v.id = d.res_id
       WHERE d.model = 'ir.ui.view' AND d.module = $1 AND d.name = $2`,
      [ref.slice(0, dot), ref.slice(dot + 1)],
    );
    if (byXmlid.rows[0] !== undefined) return byXmlid.rows[0];
  }
  throw new MissingError(`External ID can not be loaded: ${ref}`);
}

/** `_id_or_xmlid` (ir_qweb.py:499-503). */
export function idOrXmlid(ref: string | number): string | number {
  if (typeof ref === "number") return ref;
  return /^\d+$/.test(ref) ? parseInt(ref, 10) : ref;
}

export interface LoadOptions {
  readonly lang?: string;
  /** `debug` of the session; `assets` in it would need debug bundles (NotPorted). */
  readonly debug?: string;
}

/**
 * Load `root` and, transitively, the templates its static `t-call`s name (`_preload_trees`, ir_qweb.py:1277-1339:
 * refs with `{`, `<` or `/` or with t-options/t-lang on the element are skipped), plus the asset links.
 */
export async function loadTemplates(cr: SqlCursor, root: string | number, opts: LoadOptions = {}): Promise<TemplateSet> {
  const lang = opts.lang ?? "en_US";
  const byRef = new Map<string | number, LoadedTemplate>();
  const assetCalls = new Map<string, AssetCall>();
  // breadth first, one wave at a time: the views of a wave and then their combined archs are read together (they share
  // round trips, src/db.ts pipelining) and processed in the queue's order, as one after the other; a read's error is
  // thrown when its template's turn comes
  let queue: (string | number)[] = [idOrXmlid(root)];
  const settle = <T>(p: Promise<T>): Promise<{ ok: true; v: T } | { ok: false; e: unknown }> => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
  while (queue.length > 0) {
    const wave = queue;
    queue = [];
    const refs = [...new Set(wave.filter((ref) => !byRef.has(ref)))];
    const infos = new Map(await Promise.all(refs.map(async (ref) => [ref, await settle(fetchTemplateView(cr, ref))] as const)));
    const ids = [...new Set([...infos.values()].flatMap((r) => (r.ok && !byRef.has(r.v.id) && (r.v.type === null || r.v.type === "qweb") ? [r.v.id] : [])))];
    const trees = new Map(await Promise.all(ids.map(async (id) => [id, await settle(combinedArchTree(cr, id, new Set(), { lang }))] as const)));
    for (const ref of wave) {
      if (byRef.has(ref)) continue;
      const got = infos.get(ref)!;
      if (!got.ok) throw got.e;
      const info = got.v;
      if (byRef.has(info.id)) {
        byRef.set(ref, byRef.get(info.id)!);
        continue;
      }
      if (info.type !== null && info.type !== "qweb") throw new NotPorted(`template ${String(ref)} is not a QWeb view (type ${info.type})`);
      const built = trees.get(info.id)!;
      if (!built.ok) throw built.e;
      const tree = built.v;
      const loaded: LoadedTemplate = { id: info.id, key: info.key, tree };
      byRef.set(info.id, loaded);
      byRef.set(ref, loaded);
      if (info.key !== null) byRef.set(info.key, loaded);
      for (const el of iter(tree)) {
        const call = el.attrib.get("t-call");
        if (call !== undefined) {
          const hasOptions = [...el.attrib.keys()].some((a) => a.startsWith("t-options-") || a === "t-options" || a === "t-lang");
          if (!hasOptions && !call.includes("{") && !call.includes("<") && !call.includes("/")) queue.push(idOrXmlid(call));
        }
        const bundle = el.attrib.get("t-call-assets");
        if (bundle !== undefined) {
          const c: AssetCall = {
            bundle,
            css: compileBool(el.attrib.get("t-css"), true),
            js: compileBool(el.attrib.get("t-js"), true),
            binary: compileBool(el.attrib.get("t-binary"), false),
            autoprefix: compileBool(el.attrib.get("t-autoprefix"), false),
          };
          assetCalls.set(assetCallKey(c), c);
        }
      }
    }
  }
  // `_get_asset_links` (ir_qweb.py:2929-2941): rtl from res.lang, debug bundles when 'assets' in debug
  if ((opts.debug ?? "").includes("assets")) throw new NotPorted("debug=assets bundles");
  let rtl = false;
  if (assetCalls.size > 0) {
    const dir = await cr.query<{ direction: string }>("SELECT direction FROM res_lang WHERE code = $1", [lang]);
    rtl = dir.rows[0]?.direction === "rtl";
  }
  // the bundles' attachment reads are issued together and share a round trip (src/db.ts pipelining); the map keeps
  // the order of the calls in the templates
  const loaded = await Promise.all([...assetCalls].map(async ([key, call]): Promise<[string, readonly string[] | NotPorted]> => {
    try {
      return [key, await assetLinks(cr, call, rtl)];
    } catch (e) {
      if (!(e instanceof NotPorted)) throw e;
      return [key, e];
    }
  }));
  const assets = new Map<string, readonly string[] | NotPorted>(loaded);
  return { byRef, assets, rtl };
}

/** `_compile_bool` (ir_qweb.py:1693-1703). */
export function compileBool(attr: string | undefined, dflt: boolean): boolean {
  if (attr !== undefined && attr !== "") {
    const a = attr.toLowerCase();
    if (a === "false" || a === "0") return false;
    if (a === "true" || a === "1") return true;
  }
  return dflt;
}
