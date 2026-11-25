/**
 * `t-call-assets` nodes from the compiled bundle attachments: `IrQweb._get_asset_nodes` / `_get_asset_links` /
 * `_link_to_node` (odoo/odoo/addons/base/models/ir_qweb.py:2920-3037) and `AssetsBundle.get_links` /
 * `get_link` / `get_asset_url` / `get_attachments` (odoo/odoo/addons/base/models/assetsbundle.py:125-148,
 * 176-180, 230-290). The port does not compile bundles: a link exists only when `ir_attachment` holds the bundle
 * (`url` like `/web/assets/<version>/<bundle>.min.<ext>`, `res_model = 'ir.ui.view'`, `res_id = 0`, `public`);
 * a missing attachment is NotPorted (lazy bundles are precompiled offline by gen/bundles.py, stream G/H2).
 * External assets (`external_assets` in get_links) are not known without the ir.asset definitions: none of the
 * bundles of the three phase-1 pages has any (reference exchanges), so they are not emitted.
 */
import { NotPorted } from "../errors";
import type { Cursor } from "../db";
import type { SqlCursor } from "../views/combine";

export interface AssetCall {
  readonly bundle: string;
  readonly css: boolean;
  readonly js: boolean;
  readonly binary: boolean;
  /** `t-autoprefix` (assetsbundle.py:178-179). */
  readonly autoprefix?: boolean;
}

export type AssetNode = readonly [tagName: string, attrs: Map<string, string | null>];

/** Key of an AssetCall in the preloaded link map. */
export function assetCallKey(c: AssetCall): string {
  return `${c.bundle}|${c.css ? 1 : 0}${c.js ? 1 : 0}${c.binary ? 1 : 0}${c.autoprefix ? 1 : 0}`;
}

/** `ir_asset._get_asset_bundle_url` (ir_asset.py:88-89) with `unique` as a wildcard; `get_attachments` query (230-257). */
async function attachmentUrls(cr: SqlCursor, bundleFile: string): Promise<string[]> {
  // SUPERUSER_ID = 1 (odoo/odoo/api.py), `max(id) ... GROUP BY name ORDER BY name`
  const res = await cr.query<{ url: string }>(
    `SELECT a.url FROM ir_attachment a JOIN (
        SELECT max(id) AS id FROM ir_attachment
        WHERE create_uid = 1 AND url LIKE $1 AND res_model = 'ir.ui.view' AND res_id = 0 AND public = true
        GROUP BY name ORDER BY name
     ) m ON m.id = a.id ORDER BY a.name`,
    [`/web/assets/%/${bundleFile.replace(/([%_\\])/g, "\\$1")}`],
  );
  return res.rows.map((r) => r.url);
}

/**
 * `AssetsBundle.get_links()` (assetsbundle.py:125-142) read from the attachments: binary bundles give one link per
 * binary asset (the caller keeps the first), otherwise the css link then the js link.
 */
export async function assetLinks(cr: SqlCursor, call: AssetCall, rtl: boolean): Promise<string[]> {
  const links: string[] = [];
  if (call.binary) {
    for (const ext of ["woff", "woff2"]) {
      // FONT_EXTENSIONS (odoo/odoo/tools/constants.py:6); `get_link` uses the `min.<ext>` name (assetsbundle.py:147)
      links.push(...(await attachmentUrls(cr, `${call.bundle}.min.${ext}`)));
    }
    if (links.length === 0) throw new NotPorted(`asset bundle ${call.bundle} (binary) has no compiled attachment`);
    return links;
  }
  if (call.bundle === "web.report_assets_pdf") {
    // web.minimal_layout: one css file without company styles, precompiled by gen/report_bundles.py; no js in the bundle
    const { reportPdfBundleFile } = await import("../controllers/assets");
    if (call.css) links.push((await reportPdfBundleFile(cr as Cursor, call.autoprefix ?? false)).url);
    return links;
  }
  if (call.bundle === "web.report_assets_common") {
    // the version depends on the company styles (`asset_styles_company_report.scss`): the precompiled variant, not a stored row
    const { reportBundleFile } = await import("../controllers/assets");
    if (call.css) links.push((await reportBundleFile(cr as Cursor, "css", call.autoprefix ?? false)).url);
    if (call.js) links.push((await reportBundleFile(cr as Cursor, "js", false)).url);
    return links;
  }
  // an overlay template whose modules change the bundle (an app installed from Apps): Odoo's link carries the version of
  // the new file list (assetsbundle.py:144-150 get_link -> get_version), compiled on its first request
  // (src/controllers/assets.ts saves it from gen/bundles.py's output); a stored older version is not linked
  const { overlayBundleFile } = await import("../controllers/assets");
  if (call.css && !rtl) {
    const own = await overlayBundleFile(cr as Cursor, call.bundle, "css");
    if (own) links.push(own.url);
  }
  if (call.css && links.length === 0) {
    const urls = await attachmentUrls(cr, `${call.bundle}${rtl ? ".rtl" : ""}.min.css`);
    if (urls.length === 0) throw new NotPorted(`asset bundle ${call.bundle}.min.css has no compiled attachment`);
    links.push(urls[0]!);
  }
  const ownJs = call.js ? await overlayBundleFile(cr as Cursor, call.bundle, "js") : null;
  if (ownJs) links.push(ownJs.url);
  else if (call.js) {
    const urls = await attachmentUrls(cr, `${call.bundle}.min.js`);
    if (urls.length === 0) throw new NotPorted(`asset bundle ${call.bundle}.min.js has no compiled attachment`);
    links.push(urls[0]!);
  }
  return links;
}

export interface LinkOptions {
  readonly deferLoad: boolean;
  readonly lazyLoad: boolean;
  readonly media: string | null;
}

/** `_link_to_node(path, defer_load, lazy_load, media)` (ir_qweb.py:2981-3037). */
export function linkToNode(path: string, opts: LinkOptions): AssetNode | null {
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : "js";
  if (ext === "js") {
    const attrs = new Map<string, string | null>([["type", "text/javascript"]]);
    if (opts.deferLoad) attrs.set("defer", "defer");
    if (opts.lazyLoad) attrs.set("data-src", path);
    else attrs.set("src", path);
    if (path.startsWith("/web/assets/")) attrs.set("onerror", "__odooAssetError=1");
    return ["script", attrs];
  }
  if (["css", "scss", "sass", "less"].includes(ext)) {
    return ["link", new Map<string, string | null>([["type", `text/${ext}`], ["rel", "stylesheet"], ["href", path], ["media", opts.media]])];
  }
  if (ext === "xml") {
    return ["script", new Map<string, string | null>([["type", "text/xml"], ["async", "async"], ["rel", "prefetch"], ["data-src", path]])];
  }
  if (ext === "woff" || ext === "woff2") {
    return ["link", new Map<string, string | null>([["rel", "preload"], ["href", path], ["as", "font"], ["crossorigin", ""]])];
  }
  return null;
}

/** `_get_asset_nodes` (2920-2927): `[links[0]]` for binary bundles, `media` only with css. */
export function assetNodes(links: readonly string[], call: AssetCall, opts: LinkOptions): AssetNode[] {
  const media = call.css ? opts.media : null;
  const used = call.binary ? links.slice(0, 1) : links;
  return used.map((l) => linkToNode(l, { ...opts, media })).filter((n): n is AssetNode => n !== null);
}
