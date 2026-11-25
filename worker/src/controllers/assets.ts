/**
 * Compiled asset bundles.
 *  - `GET /web/assets/<unique>/<filename>`: `odoo/addons/web/controllers/binary.py:97 content_assets`. An existing
 *    public `ir_attachment` whose url `=like` the requested one is streamed; otherwise Odoo compiles the bundle
 *    (`ir.qweb._get_asset_bundle`, `AssetsBundle.css()/js()` -> `save_attachment`, assetsbundle.py:292) after
 *    checking the requested version against `bundle.get_version()` (redirect to the current link when it differs,
 *    binary.py:135-136). The port cannot compile: stream G precompiled the lazily loaded bundles with Odoo's own
 *    code (gen/bundles.py -> gen/out/bundles/index.json and the bytes), so the "compile" step becomes: insert the
 *    row Odoo would create and serve the precompiled bytes (filestore.ts finds them by store_fname).
 *  - `GET /web/bundle/<bundle_name>`: `odoo/addons/web/controllers/webclient.py:110 bundle` ->
 *    `ir.qweb._get_asset_nodes` (ir_qweb.py:2920) -> `AssetsBundle.get_links()` (assetsbundle.py:125: css link
 *    first, then js, urls carrying `get_version()`), serialized as `[{type, src}]`.
 *
 * Owned by stream H2.
 */
import { createHash } from "node:crypto";
import { indexContent } from "../mail/attachment";
import type { Cursor } from "../db";
import { HttpError, NotPorted } from "../errors";
import type { RequestContext } from "../http/context";
import { route } from "../http/router";
import { readFile, writeFile } from "../filestore";
import { STATIC_CACHE_LONG } from "./stream";
import { templateOf } from "../orm/template";
import { renderCompanyReportCss, type CompanyReportStyle } from "../qweb/scss";
import { ATTACHMENT_COLUMNS, attachmentStream, type AttachmentRow } from "./binary";

/** assetsbundle.py:25 */
const ANY_UNIQUE = "_______";
/** tools/constants.py: BINARY_EXTENSIONS = FONT_EXTENSIONS */
const BINARY_EXTENSIONS = new Set(["woff", "woff2", "ttf", "otf", "eot"]);

/** One compiled bundle file as gen/bundles.py recorded it (the ir_attachment row Odoo creates, without id/dates). */
interface BundleFile {
  readonly name: string;
  readonly url: string;
  readonly mimetype: string;
  readonly checksum: string;
  readonly store_fname: string;
  readonly file_size: number;
  readonly index_content: string | null;
  readonly company_id: number | null;
  /** When set, `saveBundleAttachment` splices `companyCss` into `base_store_fname` and writes the result to the filestore. */
  readonly dynamic?: { readonly baseStoreFname: string; readonly companyCss: string };
}

interface BundleEntry {
  readonly bundle_response: readonly { readonly type: string; readonly src: string }[];
  readonly css: BundleFile | null;
  readonly js: BundleFile | null;
}

const bundleIndexes = new Map<string, Promise<ReadonlyMap<string, BundleEntry>>>();
const overlayIndexes = new Map<string, Promise<ReadonlyMap<string, BundleEntry>>>();

/** Per corpus template (src/orm/template.ts): gen/out/bundles/ for poc_corpus, gen/out/poc_erp/bundles/ for C1. */
const BUNDLE_INDEX_LOADERS: Readonly<Record<string, () => Promise<{ default: unknown }>>> = {
  "": () => import("../../gen/out/bundles/index.json"),
  poc_erp: () => import("../../gen/out/poc_erp/bundles/index.json"),
};

/**
 * Per overlay template (gen/bundles.py with GEN_TEMPLATE=<overlay>): the bundles whose files differ from the base's,
 * compiled by Odoo with the overlay's modules installed: the page bundles the base template stores (web.assets_web:
 * an installed app's views and widgets) and the lazy ones. Odoo compiles them on the first request after the
 * install (binary.py:120-149); here they are saved from these (saveBundleAttachment). An overlay without an entry
 * here serves its base's bundles: a module set whose bundles differ and are not generated would serve the base's
 * files, so every overlay with web assets of its own has one.
 */
const OVERLAY_BUNDLE_LOADERS: Readonly<Record<string, () => Promise<{ default: unknown }>>> = {
  poc_erp_fleet: () => import("../../gen/out/poc_erp_fleet/bundles/index.json"),
  poc_erp_lunch: () => import("../../gen/out/poc_erp_lunch/bundles/index.json"),
  poc_erp_maint: () => import("../../gen/out/poc_erp_maint/bundles/index.json"),
  poc_erp_site1: () => import("../../gen/out/poc_erp_site1/bundles/index.json"),
};

function parseIndex(raw: unknown): Map<string, BundleEntry> {
  const map = new Map<string, BundleEntry>();
  if (typeof raw !== "object" || raw === null) return map;
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (name === "_meta" || typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const resp = Array.isArray(e["bundle_response"]) ? (e["bundle_response"] as unknown[]) : [];
    map.set(name, {
      bundle_response: resp.flatMap((n) => {
        if (typeof n !== "object" || n === null) return [];
        const node = n as Record<string, unknown>;
        return typeof node["type"] === "string" && typeof node["src"] === "string" ? [{ type: node["type"], src: node["src"] }] : [];
      }),
      css: asBundleFile(e["css"]),
      js: asBundleFile(e["js"]),
    });
  }
  return map;
}

/** The overlay's own bundle entries (empty for a base template or an overlay without generated bundles). */
async function loadOverlayIndex(overlay: string | undefined): Promise<ReadonlyMap<string, BundleEntry>> {
  const loader = overlay === undefined ? undefined : OVERLAY_BUNDLE_LOADERS[overlay];
  if (overlay === undefined || loader === undefined) return new Map();
  let p = overlayIndexes.get(overlay);
  if (p === undefined) {
    p = loader().then((mod) => parseIndex(mod.default));
    p.catch(() => overlayIndexes.delete(overlay));
    overlayIndexes.set(overlay, p);
  }
  return p;
}

/** The compiled file of `bundle` the overlay of the cursor's database has of its own, or null (the base's applies). */
export async function overlayBundleFile(cr: Cursor, bundle: string, ext: "css" | "js"): Promise<BundleFile | null> {
  return (await loadOverlayIndex((await templateOf(cr)).overlay)).get(bundle)?.[ext] ?? null;
}

function asBundleFile(v: unknown): BundleFile | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const str = (k: string): string => {
    const x = o[k];
    if (typeof x !== "string") throw new NotPorted(`gen/out/bundles/index.json: ${k} is not a string`);
    return x;
  };
  const fileSize = o["file_size"];
  const companyId = o["company_id"];
  const indexContent = o["index_content"];
  return {
    name: str("name"), url: str("url"), mimetype: str("mimetype"), checksum: str("checksum"), store_fname: str("store_fname"),
    file_size: typeof fileSize === "number" ? fileSize : Number(fileSize),
    index_content: typeof indexContent === "string" ? indexContent : null,
    company_id: typeof companyId === "number" ? companyId : null,
  };
}

/** gen/out/bundles/index.json of the database's template, loaded lazily once per isolate (ARCHITECTURE.md: no big tables at top level). */
export async function loadBundleIndex(cr: Cursor): Promise<ReadonlyMap<string, BundleEntry>> {
  const info = await templateOf(cr);
  const base = await loadBaseBundleIndex(info.dir);
  const own = await loadOverlayIndex(info.overlay);
  if (own.size === 0) return base;
  // the overlay's files over its base's, per file: an entry keeps the base's file of the other type when that is equal
  const out = new Map(base);
  for (const [name, e] of own) {
    const b = base.get(name);
    out.set(name, { bundle_response: e.bundle_response, css: e.css ?? b?.css ?? null, js: e.js ?? b?.js ?? null });
  }
  return out;
}

async function loadBaseBundleIndex(template: string): Promise<ReadonlyMap<string, BundleEntry>> {
  let bundleIndex = bundleIndexes.get(template);
  if (bundleIndex === undefined) {
    const loader = BUNDLE_INDEX_LOADERS[template];
    if (loader === undefined) throw new NotPorted(`gen/out/${template}/bundles/index.json is not wired in assets.ts`);
    bundleIndex = loader().then((mod) => parseIndex(mod.default)).catch((e) => {
      bundleIndexes.delete(template);
      throw e;
    });
    bundleIndexes.set(template, bundleIndex);
  }
  return bundleIndex;
}

/**
 * The compiled `web.report_assets_common` for the company styles of the database (gen/report_bundles.py): the bundle holds
 * `asset_styles_company_report.scss`, which `_update_asset_style` rewrites, so its bytes depend on these values.
 * The two precompiled variants (`default`, `c1_5e4766_010101_light`) are served as recorded by Odoo; any other company
 * layout/color/font/table combination splices the compiled `web.styles_company_report` CSS into the precompiled `default`
 * bundle (the rest of the bundle is identical).
 */
export async function reportBundleFile(cr: Cursor, assetType: "css" | "js", autoprefix: boolean): Promise<BundleFile> {
  const rows = (await cr.query<CompanyReportStyle & { active: boolean; sequence: number; name: string }>(
    `SELECT c.id, c.active, c.sequence, c.name, c.primary_color, c.secondary_color, c.font, c.report_tables_id, v.key AS layout
       FROM res_company c LEFT JOIN ir_ui_view v ON v.id = c.external_report_layout_id ORDER BY c.id`)).rows;
  const styled = rows.filter((r) => r.primary_color !== null || r.secondary_color !== null || r.layout !== null
    || (r.font !== null && r.font !== "Lato") || (r.report_tables_id !== null && r.report_tables_id !== "light"));
  const idx = await loadBundleIndex(cr);
  let variant: string | null = null;
  if (styled.length === 0) variant = "default";
  else if (styled.length === 1 && styled[0]!.id === 1 && styled[0]!.primary_color === "#5e4766" && styled[0]!.secondary_color === "#010101"
    && styled[0]!.layout === "web.external_layout_standard" && (styled[0]!.font === null || styled[0]!.font === "Lato")
    && (styled[0]!.report_tables_id === null || styled[0]!.report_tables_id === "light")) {
    variant = "c1_5e4766_010101_light";
  }
  if (variant !== null) {
    const entry = idx.get(`web.report_assets_common|${variant}${autoprefix ? "|auto" : ""}`);
    const file = entry?.[assetType];
    if (!file) throw new NotPorted(`web.report_assets_common ${variant} ${assetType} is not precompiled by gen/report_bundles.py`);
    return file;
  }
  const baseEntry = idx.get(`web.report_assets_common|default${autoprefix ? "|auto" : ""}`);
  const baseFile = baseEntry?.[assetType];
  if (!baseFile) throw new NotPorted(`web.report_assets_common default ${assetType} is not precompiled by gen/report_bundles.py`);
  const active = rows.filter((r) => r.active).sort((a, b) => a.sequence - b.sequence || (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id));
  const companyCss = renderCompanyReportCss(active);
  const version = createHash("sha1").update(`${baseFile.name}|${companyCss}`).digest("hex").slice(0, 7);
  const url = `/web/assets/${version}/${baseFile.name}`;
  if (assetType === "js") {
    return { ...baseFile, url };
  }
  return {
    ...baseFile,
    url,
    dynamic: { baseStoreFname: baseFile.store_fname, companyCss },
  };
}

/** web.report_assets_pdf (web.minimal_layout): the autoprefixed css that gen/report_bundles.py precompiled. */
export async function reportPdfBundleFile(cr: Cursor, autoprefix: boolean): Promise<BundleFile> {
  const file = autoprefix ? (await loadBundleIndex(cr)).get("web.report_assets_pdf|auto")?.css : undefined;
  if (!file) throw new NotPorted(`web.report_assets_pdf css${autoprefix ? " (autoprefixed)" : ""} is not precompiled by gen/report_bundles.py`);
  return file;
}

/** ir_asset.py:91 `_parse_bundle_name(bundle_name, debug_assets=False)`; ValueError -> null (-> 404, binary.py:148). */
export function parseBundleName(filename: string): { bundle: string; rtl: boolean; assetType: "css" | "js" | "binary"; autoprefix: boolean } | null {
  let dot = filename.lastIndexOf(".");
  if (dot < 0) return null;
  let bundle = filename.slice(0, dot);
  let assetType = filename.slice(dot + 1);
  if (BINARY_EXTENSIONS.has(assetType)) {
    assetType = "binary";
    dot = bundle.lastIndexOf(".");
    bundle = dot < 0 ? bundle : bundle.slice(0, dot);
  }
  let rtl = false;
  let autoprefix = false;
  if (assetType !== "binary") {
    dot = bundle.lastIndexOf(".");
    const min = dot < 0 ? bundle : bundle.slice(dot + 1);
    bundle = dot < 0 ? "" : bundle.slice(0, dot);
    if (min !== "min") return null;
  }
  if (assetType === "css") {
    if (bundle.endsWith(".autoprefixed")) { bundle = bundle.slice(0, -13); autoprefix = true; }
    if (bundle.endsWith(".rtl")) { bundle = bundle.slice(0, -4); rtl = true; }
  } else if (assetType !== "js" && assetType !== "binary") {
    return null;
  }
  if (bundle.split(".").length !== 2 && assetType !== "binary") return null;
  return { bundle, rtl, assetType, autoprefix };
}

/** ir_attachment.py:561 `_index`, with its `readline(io.DEFAULT_BUFFER_SIZE)` chunks (src/mail/attachment.ts). */
export { indexContent };

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

async function findAssetAttachment(cr: Cursor, unique: string, filename: string): Promise<AttachmentRow | null> {
  // binary.py:111-118: public, url set, url =like, res_model ir.ui.view, res_id 0, create_uid SUPERUSER; limit 1
  // with ir.attachment's `_order = 'id desc'` (ir_attachment.py:84)
  const uniquePattern = unique === ANY_UNIQUE ? ANY_UNIQUE : escapeLike(unique);
  const urlPattern = `/web/assets/${uniquePattern}/${escapeLike(filename)}`;
  const r = await cr.query<AttachmentRow>(
    `SELECT ${ATTACHMENT_COLUMNS} FROM ir_attachment
      WHERE public = true AND url IS NOT NULL AND url LIKE $1 ESCAPE '\\' AND res_model = 'ir.ui.view' AND res_id = 0 AND create_uid = 1
      ORDER BY id DESC LIMIT 1`,
    [urlPattern],
  );
  return r.rows[0] ?? null;
}

/**
 * `AssetsBundle.save_attachment` (assetsbundle.py:292) -> `ir.attachment.with_user(SUPERUSER_ID).create` with the
 * values Odoo computes (ir_attachment.py:921 create, :424 _get_datas_related_values, :561 _index), then
 * `_clean_attachments` (:198: older versions of the same bundle file are deleted).
 */
const REPORT_STYLE_START = "/* web/static/asset_styles_company_report.scss */\n ";
const REPORT_STYLE_END = "\n\n/* /html_editor/";

async function saveBundleAttachment(ctx: RequestContext, file: BundleFile, filename: string): Promise<AttachmentRow> {
  const cr = ctx.cursor();
  let bytes: Uint8Array;
  let checksum = file.checksum;
  let storeFname = file.store_fname;
  let fileSize = file.file_size;
  let index = file.index_content;
  if (file.dynamic) {
    const baseBytes = await readFile(ctx.env, ctx.db ?? "", file.dynamic.baseStoreFname);
    if (baseBytes === null) throw new NotPorted(`precompiled bundle bytes ${file.dynamic.baseStoreFname} are not in the filestore`);
    const text = new TextDecoder().decode(baseBytes);
    const s = text.indexOf(REPORT_STYLE_START);
    const e = s >= 0 ? text.indexOf(REPORT_STYLE_END, s + REPORT_STYLE_START.length) : -1;
    if (s < 0 || e < 0) throw new NotPorted(`web.report_assets_common marker missing in ${file.dynamic.baseStoreFname}`);
    const out = text.slice(0, s + REPORT_STYLE_START.length) + file.dynamic.companyCss + text.slice(e);
    bytes = new TextEncoder().encode(out);
    checksum = createHash("sha1").update(bytes).digest("hex");
    storeFname = `${checksum.slice(0, 2)}/${checksum}`;
    fileSize = bytes.byteLength;
    index = null;
    await writeFile(ctx.env, ctx.db ?? "", storeFname, bytes);
  } else {
    const read = await readFile(ctx.env, ctx.db ?? "", file.store_fname);
    if (read === null) throw new NotPorted(`precompiled bundle bytes ${file.store_fname} are not in the filestore`);
    if (read.byteLength !== file.file_size) throw new NotPorted(`precompiled bundle ${file.name}: size ${read.byteLength} != ${file.file_size}`);
    bytes = read;
  }
  const idxText = index ?? indexContent(bytes, file.mimetype);
  // company_id default: env.company of the creating user (SUPERUSER), ir_attachment.py company_id field default
  const company = await cr.query<{ company_id: number | null }>("SELECT company_id FROM res_users WHERE id = 1");
  const companyId = company.rows[0]?.company_id ?? null;
  const ins = await cr.query<{ id: number }>(
    `INSERT INTO ir_attachment (name, res_model, res_id, res_field, type, url, public, mimetype, checksum, store_fname,
        file_size, index_content, db_datas, description, access_token, company_id, original_id,
        create_uid, write_uid, create_date, write_date)
     VALUES ($1, 'ir.ui.view', 0, NULL, 'binary', $2, true, $3, $4, $5, $6, $7, NULL, NULL, NULL, $8, NULL,
        1, 1, now() at time zone 'UTC', now() at time zone 'UTC')
     RETURNING id`,
    [file.name, file.url, file.mimetype, checksum, storeFname, fileSize, idxText, companyId],
  );
  // _clean_attachments: url =like /web/assets/_______/<filename>, url != keep, public
  await cr.query(
    "DELETE FROM ir_attachment WHERE url LIKE $1 ESCAPE '\\' AND url <> $2 AND public = true",
    [`/web/assets/${ANY_UNIQUE}/${escapeLike(filename)}`, file.url],
  );
  // the filestore files of deleted rows are marked for GC in Odoo (_file_delete); nothing to do in this port.
  const row = await cr.query<AttachmentRow>(`SELECT ${ATTACHMENT_COLUMNS} FROM ir_attachment WHERE id = $1`, [ins.rows[0]?.id ?? 0]);
  const saved = row.rows[0];
  if (saved === undefined) throw new Error("inserted attachment row not found");
  return saved;
}

/** binary.py:97 `content_assets`. */
async function contentAssets(ctx: RequestContext, params: Record<string, string>): Promise<Response> {
  const filename = params["filename"] ?? "";
  let unique = params["unique"] ?? ANY_UNIQUE;
  const nocache = ctx.url.searchParams.get("nocache");
  if (unique === "any" || unique === "%") unique = ANY_UNIQUE;
  if (unique === "debug") throw new NotPorted("/web/assets/debug/ (unminified debug bundles are compiled on request)");
  const cr = ctx.cursor();
  let row = await findAssetAttachment(cr, unique, filename);
  if (row === null) {
    // "try to generate one" (binary.py:120-149)
    if (filename.endsWith(".map")) throw new HttpError(404, "Not Found");
    const parsed = parseBundleName(filename);
    if (parsed === null) throw new HttpError(404, "Not Found");
    if (parsed.rtl) throw new NotPorted(`${filename}: rtl bundles are not precompiled`);
    if (parsed.assetType === "binary") throw new NotPorted(`${filename}: binary (font) bundle not in the template`);
    if (parsed.autoprefix && parsed.bundle !== "web.report_assets_common" && parsed.bundle !== "web.report_assets_pdf") throw new NotPorted(`${filename}: autoprefixed bundles are not precompiled`);
    const entry = parsed.bundle === "web.report_assets_common" ? null : (await loadBundleIndex(cr)).get(parsed.bundle);
    const file = parsed.bundle === "web.report_assets_common" ? await reportBundleFile(cr, parsed.assetType, parsed.autoprefix)
      : parsed.bundle === "web.report_assets_pdf" && parsed.assetType === "css" ? await reportPdfBundleFile(cr, parsed.autoprefix)
      : entry === undefined ? null : entry![parsed.assetType];
    if (file === null || file === undefined) {
      throw new NotPorted(`bundle ${parsed.bundle} (${parsed.assetType}) is not precompiled by gen/bundles.py`);
    }
    const version = file.url.split("/")[3] ?? "";
    if (unique !== ANY_UNIQUE && unique !== version) {
      // binary.py:135-136: request.redirect(bundle.get_link(asset_type)), default code 303 (requestlib.py:358)
      return ctx.redirect(file.url, 303);
    }
    row = await saveBundleAttachment(ctx, file, filename);
  }
  const stream = await attachmentStream(ctx, row, filename);
  const opts: { asAttachment: boolean; contentSecurityPolicy: null; immutable?: boolean; maxAge?: number | null } = {
    asAttachment: false, contentSecurityPolicy: null,
  };
  if (unique !== "" && unique !== "debug") { opts.immutable = true; opts.maxAge = STATIC_CACHE_LONG; }
  if (nocache !== null && nocache !== "") opts.maxAge = null;
  return stream.getResponse(ctx.request, opts);
}

/** webclient.py:110 `bundle`. */
async function bundle(ctx: RequestContext, params: Record<string, string>): Promise<Response> {
  const name = params["bundle_name"] ?? "";
  const cr = ctx.cursor();
  // lang param -> request.update_context(lang=res.lang._get_code(lang)) (:115); rtl per the lang's direction
  // (ir_qweb.py:2934, env.lang or env.user.lang)
  const langParam = ctx.url.searchParams.get("lang");
  let lang: string | null = null;
  if (langParam !== null) {
    const r = await cr.query<{ code: string }>("SELECT code FROM res_lang WHERE active AND code = $1", [langParam]);
    lang = r.rows[0]?.code ?? null;
  }
  if (lang === null) {
    const ctxLang = ctx.context.lang;
    lang = typeof ctxLang === "string" && ctxLang !== "" ? ctxLang : null;
  }
  if (lang !== null) {
    const d = await cr.query<{ direction: string }>("SELECT direction FROM res_lang WHERE active AND code = $1", [lang]);
    if (d.rows[0]?.direction === "rtl") throw new NotPorted(`/web/bundle/${name} for an rtl language`);
  }
  const debug = ctx.url.searchParams.get("debug") ?? ctx.session.debug;
  if (debug.includes("assets")) throw new NotPorted(`/web/bundle/${name} with debug=assets`);

  let data: { type: string; src: string }[];
  const entry = (await loadBundleIndex(cr)).get(name);
  if (entry !== undefined) {
    data = [...entry.bundle_response];
  } else {
    // bundles the template already holds: the links are their stored urls (get_links: css first, then js)
    data = [];
    for (const [ext, type] of [["min.css", "link"], ["min.js", "script"]] as const) {
      const row = await findAssetAttachment(cr, ANY_UNIQUE, `${name}.${ext}`);
      if (row !== null && row.url !== null) data.push({ type, src: row.url });
    }
    if (data.length === 0) throw new NotPorted(`bundle ${name} is neither precompiled nor in ir_attachment`);
  }
  // request.make_json_response (requestlib.py:327); nosniff from post_dispatch (dispatcher.py:216)
  return ctx.makeJsonResponse(data, { "X-Content-Type-Options": "nosniff" });
}

route("/web/assets/<string:unique>/<string:filename>", contentAssets, { auth: "public", readonly: true });
route("/web/bundle/<string:bundle_name>", bundle, { auth: "public", methods: ["GET"], readonly: true });
