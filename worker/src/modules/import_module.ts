/**
 * Importing data modules: base_import_module (odoo/addons/base_import_module/models/ir_module.py:108-392 and
 * models/base_import_module.py). A .zip with one directory per module, each with a `__manifest__.py`, data files
 * (xml, csv), static files and translations; no Python. Modules whose dependencies are not installed would need
 * `button_immediate_install` of those modules, i.e. their Python code: that refuses (NotPorted) unless the
 * dependency is itself installed.
 */
import { createHash } from "node:crypto";
import { AccessError, NotPorted, OdooError, UserError } from "../errors";
import { registerMethod } from "../http/methods";
import { create } from "../orm/create";
import { write } from "../orm/write";
import type { Environment } from "../orm/types";
import { userHasGroup } from "../web/groups";
import { writeFile } from "../filestore";
import { requestOfCursor } from "../http/context";
import { guessMimetype, indexContent, imageSize, plainXml } from "../mail/attachment";
import { evalExpr, isDict, dictEntries } from "../pyexpr";
import { parseXml, type Element } from "../xml";
import { readZip, isZip, type ZipEntry } from "./zip";
import { MANIFEST_NAMES, readManifest, type Manifest } from "./manifest";
import { convertFile, type IdRef } from "./convert";
import { recomputeModuleViews } from "./module_views";

const MAX_FILE_SIZE = 100 * 1024 * 1024; // ir_module.py:34

/** The extracted members of one import, by their path in the zip ('module/dir/file'). */
type Files = Map<string, Uint8Array>;

async function isAdmin(env: Environment): Promise<boolean> {
  return env.su || env.uid === 1 || userHasGroup(env, "base.group_erp_manager");
}

/** `topological_sort` (tools/misc.py:344-372). */
function topologicalSort(elems: Map<string, string[]>): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const visit = (n: string) => {
    if (visited.has(n)) return;
    visited.add(n);
    if (elems.has(n)) {
      for (const it of elems.get(n)!) visit(it);
      result.push(n);
    }
  };
  for (const el of elems.keys()) visit(el);
  return result;
}

/** `_is_studio_custom` (ir_module.py:733-760): a record context with a truthy `studio`. */
function isStudioCustom(files: Files, module: string): boolean {
  for (const [path, data] of files) {
    if (!path.startsWith(`${module}/`) || !path.toLowerCase().endsWith(".xml")) continue;
    let root: Element;
    try { root = parseXml(new TextDecoder().decode(data).replace(/^<\?xml[^>]*\?>/, "")); } catch { continue; }
    for (const rec of root.children) {
      if (rec.kind !== "element") continue;
      const ctx = rec.attrib.get("context");
      if (!ctx) continue;
      try {
        const v = evalExpr(ctx, new Map());
        if (isDict(v) && dictEntries(v).some(([k, x]) => k === "studio" && !!x)) return true;
      } catch { continue; }
    }
  }
  return false;
}

/** `get_values_from_terp` (base ir_module.py:761-778). */
function valuesFromTerp(terp: Manifest): Record<string, unknown> {
  const contributors = terp.get<string[] | undefined>("contributors") ?? [];
  const autoInstall = terp.get<unknown>("auto_install");
  return {
    description: dedent(terp.description),
    shortdesc: terp.get<string>("name") ?? "",
    author: terp.get<string>("author") ?? "Unknown",
    maintainer: terp.get<unknown>("maintainer") ?? false,
    contributors: contributors.join(", ") || false,
    website: terp.get<string>("website") ?? "",
    license: terp.get<string>("license") ?? "LGPL-3",
    sequence: terp.get<number>("sequence") ?? 100,
    application: terp.get<boolean>("application") ?? false,
    auto_install: autoInstall !== false && autoInstall !== undefined,
    icon: false, // set by the caller (Manifest.icon)
    summary: terp.get<string>("summary") ?? "",
    url: terp.get<string>("url") || terp.get<string>("live_test_url") || "",
    to_buy: false,
    iap_paid_service: terp.get<boolean>("iap_paid_service") ?? false,
  };
}

/** `textwrap.dedent`. */
function dedent(text: string): string {
  const lines = text.split("\n");
  let margin: string | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = /^[ \t]*/.exec(line)![0];
    if (margin === null || !indent.startsWith(margin)) {
      let i = 0;
      const m: string = margin ?? indent;
      while (i < m.length && i < indent.length && m[i] === indent[i]) i++;
      margin = margin === null ? indent : m.slice(0, i);
    }
  }
  if (!margin) return lines.map((l) => (l.trim() ? l : "")).join("\n");
  return lines.map((l) => (l.trim() ? l.slice(margin!.length) : "")).join("\n");
}

/**
 * `IrAttachment.create({name, url, res_model, type: 'binary', raw, public})` for a module's static files
 * (ir_attachment.py:921: mimetype from the name, checksum, file_size, store_fname, index_content, _file_write).
 */
async function createBinaryAttachment(env: Environment, vals: { name: string; url: string; res_model: string; res_id?: number; public: boolean | null }, raw: Uint8Array, mimetypeOf?: string): Promise<number> {
  // create :934-938 and `_inverse_raw`: an empty file has no checksum, size or file (not ported here)
  if (!raw.length) throw new NotPorted("an empty static file of an imported module");
  // `_check_contents` :547-555 as the importing user
  const mimetype = await plainXml(env, mimetypeOf ?? guessMimetype(vals.name, raw));
  if (["image/png", "image/jpeg", "image/bmp", "image/tiff"].includes(mimetype)) {
    const [w, h] = imageSize(raw, mimetype);
    if (w > 1920 || h > 1920) throw new NotPorted("image autoresize of module static files larger than 1920x1920");
  }
  if ((await env.cr.query(`SELECT 1 FROM ir_config_parameter WHERE key = 'ir_attachment.location' AND value != 'file'`)).rows.length) throw new NotPorted("database attachment storage");
  const checksum = createHash("sha1").update(raw).digest("hex");
  const storeFname = `${checksum.slice(0, 2)}/${checksum}`;
  const company = await env.company();
  const row = (await env.cr.query<{ id: number }>(
    `INSERT INTO ir_attachment (name, url, res_model, res_id, company_id, type, public, mimetype, file_size, checksum, store_fname,
       index_content, create_uid, write_uid, create_date, write_date)
     VALUES ($1, $2, $3, $4, $5, 'binary', $6, $7, $8, $9, $10, $11, $12, $12, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')
     RETURNING id`,
    [vals.name, vals.url, vals.res_model, vals.res_id ?? null, company, vals.public, mimetype, raw.length, checksum, storeFname, indexContent(raw, mimetype), env.uid])).rows[0]!;
  const ctx = requestOfCursor(env.cr);
  if (ctx === null || ctx.db === null) throw new NotPorted("module static files outside a request");
  await writeFile(ctx.env, ctx.db, storeFname, raw);
  return row.id;
}

/**
 * `attachment.write(values)` of a re-imported static file (base_import_module ir_module.py:212-213 over ir_attachment.py
 * write :878-896, `_check_contents` and `_inverse_raw` -> `_set_attachment_data` :391-401): the values, the mimetype
 * from the name, the content's checksum, size, index and filestore name (the old file is only marked for the
 * filestore's garbage collection, `_file_delete`).
 */
async function updateBinaryAttachment(env: Environment, id: number, vals: { name: string; url: string; res_model: string; public: boolean }, raw: Uint8Array): Promise<void> {
  // create :934-938 and `_inverse_raw`: an empty file has no checksum, size or file (not ported here)
  if (!raw.length) throw new NotPorted("an empty static file of an imported module");
  // `_check_contents` :547-555 as the importing user
  const mimetype = await plainXml(env, guessMimetype(vals.name, raw));
  if (["image/png", "image/jpeg", "image/bmp", "image/tiff"].includes(mimetype)) {
    const [w, h] = imageSize(raw, mimetype);
    if (w > 1920 || h > 1920) throw new NotPorted("image autoresize of module static files larger than 1920x1920");
  }
  if ((await env.cr.query(`SELECT 1 FROM ir_config_parameter WHERE key = 'ir_attachment.location' AND value != 'file'`)).rows.length) throw new NotPorted("database attachment storage");
  const checksum = createHash("sha1").update(raw).digest("hex");
  const storeFname = `${checksum.slice(0, 2)}/${checksum}`;
  await env.cr.query(
    `UPDATE ir_attachment SET name = $2, url = $3, res_model = $4, type = 'binary', public = $5, mimetype = $6, file_size = $7, checksum = $8,
       store_fname = $9, index_content = $10, db_datas = NULL, write_uid = $11, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1`,
    [id, vals.name, vals.url, vals.res_model, vals.public, mimetype, raw.length, checksum, storeFname, indexContent(raw, mimetype), env.uid]);
  const ctx = requestOfCursor(env.cr);
  if (ctx === null || ctx.db === null) throw new NotPorted("module static files outside a request");
  await writeFile(ctx.env, ctx.db, storeFname, raw);
}

/** `ir.module.module.create` (base ir_module.py:780-791): the module and its `base.module_<name>` XML id. */
async function createModule(env: Environment, vals: Record<string, unknown>): Promise<number> {
  const [id] = await create(env, "ir.module.module", [vals]);
  await create(env, "ir.model.data", [{ name: `module_${String(vals["name"])}`, model: "ir.module.module", module: "base", res_id: id, noupdate: true }]);
  return id!;
}

/** `_update_from_terp` (base ir_module.py:832-836). */
async function updateFromTerp(env: Environment, modId: number, terp: Manifest): Promise<void> {
  // _update_dependencies
  const depends = terp.get<string[]>("depends");
  const autoReq = new Set(Array.isArray(terp.get("auto_install")) ? terp.get<string[]>("auto_install") : []);
  const deps = (await env.cr.query<{ id: number; name: string }>("SELECT id, name FROM ir_module_module_dependency WHERE module_id = $1 ORDER BY id", [modId])).rows;
  const existing = new Set(deps.map((d) => d.name));
  const toDelete: number[] = [];
  for (const dep of deps) {
    if (!depends.includes(dep.name)) toDelete.push(dep.id);
    else await write(env, "ir.module.module.dependency", [dep.id], { auto_install_required: autoReq.has(dep.name) });
  }
  const toCreate = [...new Set(depends)].filter((n) => !existing.has(n));
  if (toCreate.length) await create(env, "ir.module.module.dependency", toCreate.map((name) => ({ module_id: modId, name, auto_install_required: autoReq.has(name) })));
  if (toDelete.length) await env.cr.query("DELETE FROM ir_module_module_dependency WHERE id = ANY($1::int[])", [toDelete]);
  // _update_countries
  const countries = terp.get<string[]>("countries") ?? [];
  if (countries.length) throw new NotPorted("imported module with countries");
  // _update_exclusions
  if ((terp.get<string[] | undefined>("excludes") ?? []).length) throw new NotPorted("imported module with excludes");
  if ((await env.cr.query("SELECT 1 FROM ir_module_module_exclusion WHERE module_id = $1", [modId])).rows.length) throw new NotPorted("imported module with exclusions");
  // _update_category
  const category = terp.get<string>("category") ?? "Uncategorized";
  const path: string[] = [];
  let cur = (await env.cr.query<{ c: number | null }>("SELECT category_id AS c FROM ir_module_module WHERE id = $1", [modId])).rows[0]?.c ?? null;
  const seen = new Set<number>();
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const c = (await env.cr.query<{ name: string; parent_id: number | null }>("SELECT name->>'en_US' AS name, parent_id FROM ir_module_category WHERE id = $1", [cur])).rows[0];
    if (!c) break;
    path.unshift(c.name);
    cur = c.parent_id;
  }
  const categs = category.split("/");
  if (JSON.stringify(categs) !== JSON.stringify(path)) {
    await write(env, "ir.module.module", [modId], { category_id: await createCategories(env, categs) });
  }
}

/** `modules.db.create_categories` (odoo/modules/db.py:158-196). */
async function createCategories(env: Environment, categories: string[]): Promise<number> {
  let pId: number | null = null;
  let xmlId = "module_category";
  for (const category of categories) {
    xmlId += "_" + category.toLowerCase().replaceAll("&", "and").replaceAll(" ", "_");
    const row = (await env.cr.query<{ res_id: number }>("SELECT res_id FROM ir_model_data WHERE name = $1 AND module = $2 AND model = $3", [xmlId, "base", "ir.module.category"])).rows[0];
    if (!row) {
      pId = (await env.cr.query<{ id: number }>("INSERT INTO ir_module_category (name, parent_id) VALUES ($1, $2) RETURNING id", [JSON.stringify({ en_US: category }), pId])).rows[0]!.id;
      await env.cr.query("INSERT INTO ir_model_data (module, name, res_id, model, noupdate) VALUES ($1, $2, $3, $4, $5)", ["base", xmlId, pId, "ir.module.category", true]);
    } else pId = row.res_id;
  }
  return pId!;
}

/** `_import_module` (ir_module.py:108-323). */
async function importModule(env: Environment, module: string, files: Files, force: boolean, withDemo: boolean, dataModule: boolean): Promise<void> {
  const dec = new TextDecoder();
  const known = (await env.cr.query<{ id: number; name: string; state: string }>("SELECT id, name, state FROM ir_module_module ORDER BY name, id")).rows;
  const knownByName = new Map(known.map((m) => [m.name, m]));
  const installed = new Set(known.filter((m) => m.state === "installed").map((m) => m.name));
  const manifestBytes = files.get(`${module}/__manifest__.py`);
  if (!manifestBytes) return;
  const terp = readManifest(module, dec.decode(manifestBytes), (f) => { const b = files.get(`${module}/${f}`); return b ? dec.decode(b) : null; });
  if (!terp) return;
  const values = valuesFromTerp(terp);
  // :122-127 the icon in the module's static files when the zip has it, else Manifest.icon (base's icon)
  const iconPath = terp.get<string | undefined>("icon") || `${module}/static/description/icon.png`;
  values["icon"] = files.has(iconPath.replace(/^\//, "")) ? "/" + iconPath.replace(/^\//, "") : "/base/static/description/icon.png";
  values["latest_version"] = terp.version;
  if (dataModule) values["module_type"] = "industries";
  if (withDemo) values["demo"] = true;
  const unmet = terp.get<string[]>("depends").filter((d) => !installed.has(d));
  if (unmet.length) {
    const wrong = unmet.filter((d) => !knownByName.has(d));
    if (wrong.length) throw new UserError("Unknown module dependencies:" + "\n - " + wrong.join("\n - "));
    throw new NotPorted(`importing ${module}: installing its dependencies ${unmet.join(", ")} (their Python code is not ported)`);
  } else if (!installed.has("web_studio") && isStudioCustom(files, module)) {
    throw new UserError("Studio customizations require the Odoo Studio app.");
  }
  const mod = knownByName.get(module);
  let modId: number;
  let mode: "init" | "update";
  if (mod) {
    await write(env, "ir.module.module", [mod.id], { state: "installed", ...values });
    modId = mod.id;
    mode = force ? "init" : "update";
  } else {
    if (!terp.get<boolean>("installable")) throw new Error("Module not installable");
    modId = await createModule(env, { name: module, state: "installed", imported: true, ...values });
    mode = "init";
  }
  if ((terp.get<string[]>("cloc_exclude") ?? []).length) throw new NotPorted("imported module with cloc_exclude");
  const kinds = ["data", "init_xml", ...(withDemo ? ["demo"] : [])];
  for (const kind of kinds) {
    for (const filename of terp.get<string[] | undefined>(kind) ?? []) {
      const ext = (/\.[^./]*$/.exec(filename)?.[0] ?? "").toLowerCase();
      if (![".xml", ".csv", ".sql"].includes(ext)) continue;
      const noupdate = ext === ".csv" && kind === "init_xml";
      const pathname = `${module}/${filename}`;
      const content = files.get(pathname);
      if (!content) throw new Error(`File not found: ${pathname}`);
      const idref: IdRef = new Map();
      await convertFile(env, module, filename, content, idref, mode, noupdate, pathname);
    }
  }
  // :190-232 static files as public attachments on ir.ui.view, with an XML id of the module
  for (const [path, raw] of files) {
    if (!path.startsWith(`${module}/static/`) || path.endsWith("/")) continue;
    const urlPath = `/${path}`;
    const filename = urlPath.split("/").pop()!;
    const existing = (await env.cr.query<{ id: number }>("SELECT id FROM ir_attachment WHERE url = $1 AND type = 'binary' AND res_model = 'ir.ui.view'", [urlPath])).rows;
    if (existing.length > 1) throw new NotPorted("re-importing a module static file with several attachments of its url");
    if (existing.length) {
      await updateBinaryAttachment(env, existing[0]!.id, { name: filename, url: urlPath, res_model: "ir.ui.view", public: true }, raw);
      continue;
    }
    const attId = await createBinaryAttachment(env, { name: filename, url: urlPath, res_model: "ir.ui.view", public: true }, raw);
    await create(env, "ir.model.data", [{ name: `attachment_${urlPath}`.replaceAll(".", "_").replaceAll(" ", "_"), model: "ir.attachment", module, res_id: attId }]);
  }
  // :232-259 the translation files (i18n/*.po, no sub-directory) as binary attachments of the module, with an XML id
  const poFiles = [...files.keys()].filter((p) => p.startsWith(`${module}/i18n/`) && p.endsWith(".po") && !p.slice(`${module}/i18n/`.length).includes("/"));
  // `os.scandir` gives them in the directory's order, which the port cannot know: one file only
  if (poFiles.length > 1) throw new NotPorted("imported module with several i18n/*.po files (os.scandir order)");
  const poLangs: string[] = [];
  for (const path of poFiles) {
    const raw = files.get(path)!;
    const lang = path.slice(`${module}/i18n/`.length).split(".")[0]!;
    // `public` is not among the values (:241-248) and has no default: NULL
    const vals = { name: `${module}_${lang}.po`, url: `/${module}/i18n/${lang}.po`, res_model: "ir.module.module", res_id: modId, public: null };
    const existing = (await env.cr.query<{ id: number }>("SELECT id FROM ir_attachment WHERE url = $1 AND type = 'binary' AND name = $2", [vals.url, vals.name])).rows;
    if (existing.length) throw new NotPorted("re-importing a module's translation file (attachment.write)");
    const attId = await createBinaryAttachment(env, vals, raw, poMimetype(raw));
    await create(env, "ir.model.data", [{ name: `attachment_${module}_${lang}`.replaceAll(".", "_").replaceAll(" ", "_"), model: "ir.attachment", module, res_id: attId }]);
    poLangs.push(lang);
  }
  // :261-302 ir.asset records of the manifest's assets
  const assets = terp.get<Record<string, unknown>>("assets") ?? {};
  if (Object.keys(assets).length) throw new NotPorted("imported module with assets (the Worker's bundles are precompiled)");
  // :304-308 `_load_module_terms` of the installed languages (:58-82): an imported module's terms come from its
  // attachment `<module>_<lang>.po` of each base language (tools/translate.py get_base_langs); a file of a language
  // that is not installed is not read. Reading one (TranslationImporter) is not ported
  const installedLangs = (await env.cr.query<{ code: string }>("SELECT code FROM res_lang WHERE active ORDER BY code")).rows.map((r) => r.code);
  for (const lang of installedLangs) {
    for (const base of baseLangs(lang)) {
      if (poLangs.includes(base)) throw new NotPorted(`translations of imported module ${module} for the installed language ${lang} (TranslationImporter)`);
    }
  }
  await updateFromTerp(env, modId, terp);
  await recomputeModuleViews(env, [modId]);
}

/** tools/translate.py:2407-2418 get_base_langs. */
function baseLangs(lang: string): string[] {
  const base = lang.split("_", 1)[0]!;
  const out = [base];
  if (base === "es" && lang !== "es_ES" && lang !== "es_419") out.push("es_419");
  if (lang === "zh_HK") out.push("zh_TW");
  if (lang !== base) out.push(lang);
  return out;
}

/**
 * The mimetype `IrAttachment.create` gives a .po file from its content (ir_attachment.py `_compute_mimetype` ->
 * tools/mimetypes.py guess_mimetype, python-magic). Measured with the oracle's libmagic (2026-11-11): a catalogue with
 * only its header is text/plain, one with an entry (a `msgid` line after the first) text/x-po. Other content refuses.
 */
function poMimetype(raw: Uint8Array): string {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw); } catch { throw new NotPorted("a non UTF-8 .po file (libmagic)"); }
  if (!text.startsWith('msgid ""')) throw new NotPorted("a .po file that does not begin with its header (libmagic)");
  return /\nmsgid "/.test(text) ? "text/x-po" : "text/plain";
}

/** `_import_zipfile` (ir_module.py:326-392). */
export async function importZipfile(env: Environment, data: Uint8Array, force: boolean, withDemo: boolean): Promise<[string, string[]]> {
  if (!(await isAdmin(env))) throw new AccessError("Only administrators can install data modules.");
  if (!data.length) throw new Error("No file sent.");
  if (!isZip(data)) throw new UserError("Only zip files are supported.");
  const entries = readZip(data);
  for (const zf of entries) {
    if (zf.fileSize > MAX_FILE_SIZE) throw new UserError(`File '${zf.filename}' exceed maximum allowed file size`);
  }
  const dec = new TextDecoder();
  const files: Files = new Map();
  const manifests: [string, ZipEntry][] = entries
    .filter((f) => f.filename.split("/").length === 2 && MANIFEST_NAMES.includes(f.filename.split("/")[1]!))
    .map((f): [string, ZipEntry] => [f.filename.split("/")[0]!, f])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1].filename < b[1].filename ? -1 : 1));
  const dataFiles = new Map<string, string[]>();
  const dependencies = new Map<string, string[]>();
  const dirs = new Set<string>();
  for (const [modName, manifest] of manifests) {
    const content = await manifest.read();
    files.set(manifest.filename, content);
    dirs.add(modName);
    const terp = readManifest(modName, dec.decode(content), () => null);
    if (!terp) continue;
    const toImport = [...terp.get<string[]>("data"), ...(terp.get<string[] | undefined>("init_xml") ?? []), ...(terp.get<string[] | undefined>("update_xml") ?? []), ...(withDemo ? terp.get<string[]>("demo") : [])];
    dataFiles.set(modName, toImport.filter((f) => [".xml", ".csv", ".sql"].includes((/\.[^./]*$/.exec(f)?.[0] ?? "").toLowerCase())).map((f) => `${modName}/${f}`));
    dependencies.set(modName, terp.get<string[]>("depends"));
  }
  const sorted = topologicalSort(dependencies);
  const wrongModules = [...dirs].filter((d) => !sorted.includes(d));
  if (wrongModules.length) throw new UserError(`No manifest found in '${wrongModules.join(", ")}'. Can't import the zip file.`);
  for (const file of entries) {
    const modName = file.filename.split("/")[0]!;
    const isData = (dataFiles.get(modName) ?? []).includes(file.filename);
    const isStatic = file.filename.startsWith(`${modName}/static`);
    const isTranslation = file.filename.startsWith(`${modName}/i18n`) && file.filename.endsWith(".po");
    const isReadme = /^[^/]+\/README(\.(rst|md|txt))?$/.test(file.filename);
    if (isData || isStatic || isTranslation || isReadme) files.set(file.filename, await file.read());
  }
  const envSudo = env.sudo().withContext({ ...env.context, website_id: null });
  const names: string[] = [];
  for (const modName of sorted) {
    names.push(modName);
    try {
      await importModule(envSudo, modName, files, force, withDemo, !!env.context["data_module"]);
    } catch (e) {
      if (e instanceof NotPorted) throw e;
      // :389-392: the message embeds traceback.format_exc(); the port has no Python frames, so the frames are one
      // line saying so, and the last line is Python's "<class>: <message>" (dotted for Odoo's own exceptions)
      const last = e instanceof OdooError ? `${e.odooName}: ${e.message}` : e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      throw new UserError(`Error while importing module '${modName}'.\n\n Traceback (most recent call last):\n  (no Python frames: the Worker runs the TypeScript port)\n${last}\n \n\n`);
    }
  }
  return ["", names];
}

/** base_import_module/models/base_import_module.py:16-25 `import_module`. */
registerMethod("base.import.module", "import_module", async (env, ids) => {
  if (ids?.length !== 1) throw new NotPorted("import_module on several wizards (ensure_one)");
  const row = (await env.cr.query<{ module_file: Buffer | Uint8Array | string | null; force: boolean | null; with_demo: boolean | null }>(
    "SELECT module_file, force, with_demo FROM base_import_module WHERE id = $1", [ids[0]])).rows[0];
  if (!row) throw new NotPorted("import_module of a missing wizard");
  // Binary(attachment=False) stores the bytes themselves in a bytea column (fields_binary.py:71-83)
  const file = row.module_file;
  const bytes = file === null ? new Uint8Array() : typeof file === "string" ? new TextEncoder().encode(file) : new Uint8Array(file);
  await importZipfile(env, bytes, !!row.force, !!row.with_demo);
  return { type: "ir.actions.act_url", target: "self", url: "/odoo" };
}, { apiModel: false });
