/**
 * Installing modules from the Apps screen in a running database: `button_immediate_install` (base ir_module.py:475-490)
 * -> `_button_immediate_function` (:608-665) -> `button_install` (:406-473), then the registry reload
 * (`Registry.new(update_module=True)` -> odoo/modules/loading.py `load_modules` / `load_module_graph`).
 *
 * The port installs a module only when its code is in the bundle: the module set after the install must be a template
 * of gen/out/templates.json (poc_erp + l10n_se is the overlay poc_erp_se, src/orm/overlay.ts). ACCEPTANCE A1 is the
 * first case (compiler/B1.md). Anything else refuses (NotPorted) before a row is written.
 */
import { setLoadingModule } from "./loading";
import { flushProcessedImages, openProcessedImages } from "../orm/image_write";
import { runDelayedAccountTranslator, runPostInit } from "./init_hooks";
import { isPgError } from "../orm/sql_errors";
import { dropHeldTracking, holdTracking, trackSavepointFlush } from "../mail/tracking";
import { noteCommitPoint } from "../orm/created";
import { flushHeldTracking } from "../mail/write_hooks";
import { AccessDenied, NotPorted, UserError } from "../errors";
import { registerMethod } from "../http/methods";
import { write } from "../orm/write";
import { pinTemplate, templateForModules, templateModules, type TemplateInfo } from "../orm/template";
import { installSteps } from "../orm/overlay";
import { buildMissing, installedBuilds } from "../orm/builds";
import { registryChanged, setRegistryLoading } from "../orm/signaling";
import { genAssetJson } from "../gen_assets";
import { createEnvironment } from "../orm/env";
import { convertFile, ParseError, type IdRef } from "./convert";
import { create } from "../orm/create";
import type { Environment } from "../orm/types";
import { userHasGroup } from "../web/groups";
import { updateListAfterReload } from "./uninstall";
import { recomputeModuleViews } from "./module_views";
import { applyReflection, type Reflect } from "./reflect";
import { applyTranslationSave, type TranslationSave } from "./install_translations";
import { computeInitColumns, initColumnData, noteDataWrite, postponeNotNull, type InitColumn } from "./install_columns";

const INSTALL_STATES = ["installed", "to install", "to upgrade"];

export async function isAdmin(env: Environment): Promise<boolean> {
  return env.su || env.uid === 1 || userHasGroup(env, "base.group_erp_manager");
}

export interface ModRow { id: number; name: string; state: string }

export async function moduleRows(env: Environment, where: string, params: unknown[]): Promise<ModRow[]> {
  return (await env.cr.query<ModRow>(
    `SELECT id, name, state FROM ir_module_module WHERE ${where} ORDER BY application DESC, sequence, name, id`, params)).rows;
}

/** `dependencies_id` with each dependency's state (ir_module.py:1076-1085: the depended module's state, else 'unknown'). */
async function dependencies(env: Environment, moduleId: number): Promise<{ name: string; depId: number | null; state: string; autoRequired: boolean }[]> {
  return (await env.cr.query<{ name: string; dep_id: number | null; state: string | null; auto: boolean | null }>(
    `SELECT d.name, m.id AS dep_id, m.state, d.auto_install_required AS auto
       FROM ir_module_module_dependency d LEFT JOIN ir_module_module m ON m.name = d.name
      WHERE d.module_id = $1 ORDER BY d.id`, [moduleId])).rows
    .map((r) => ({ name: r.name, depId: r.dep_id, state: r.state ?? "unknown", autoRequired: !!r.auto }));
}

/** `_state_update` (ir_module.py:376-404). */
async function stateUpdate(env: Environment, mods: ModRow[], newState: string, statesToUpdate: readonly string[], level = 100): Promise<void> {
  if (level < 1) throw new UserError("Recursion error in modules dependencies!");
  for (const module of mods) {
    const current = (await moduleRows(env, "id = $1", [module.id]))[0]!;
    if (!statesToUpdate.includes(current.state)) continue;
    const update: ModRow[] = [];
    for (const dep of await dependencies(env, module.id)) {
      if (dep.state === "unknown") {
        throw new UserError(`You try to install module "${current.name}" that depends on module "${dep.name}".\nBut the latter module is not available in your system.`);
      }
      if (dep.state !== newState && dep.depId !== null) update.push({ id: dep.depId, name: dep.name, state: dep.state });
    }
    await stateUpdate(env, update, newState, statesToUpdate, level - 1);
    const again = (await moduleRows(env, "id = $1", [module.id]))[0]!;
    if (statesToUpdate.includes(again.state)) {
      // check_external_dependencies (ir_module.py:300-318): the modules the port installs have none
      await write(env, "ir.module.module", [module.id], { state: newState });
    }
  }
}

/** `button_install` (ir_module.py:406-473), without its action (only `button_immediate_install` calls it here). */
async function buttonInstall(env: Environment, ids: readonly number[]): Promise<void> {
  const companyCountries = new Set((await env.cr.query<{ c: number }>(
    "SELECT DISTINCT country_id AS c FROM res_company c JOIN res_partner p ON p.id = c.partner_id WHERE country_id IS NOT NULL")).rows.map((r) => r.c));
  let mods = await moduleRows(env, "id = ANY($1::int[])", [[...ids]]);
  while (mods.length) {
    await stateUpdate(env, mods, "to install", ["uninstalled"]);
    const next: ModRow[] = [];
    for (const m of await moduleRows(env, "state = 'uninstalled' AND auto_install", [])) {
      const states = new Set((await dependencies(env, m.id)).filter((d) => d.autoRequired).map((d) => d.state));
      if (![...states].every((s) => INSTALL_STATES.includes(s)) || !states.has("to install")) continue;
      const countries = (await env.cr.query<{ c: number }>("SELECT country_id AS c FROM module_country WHERE module_id = $1", [m.id])).rows;
      if (countries.length && !countries.some((r) => companyCountries.has(r.c))) continue;
      next.push(m);
    }
    mods = next;
  }
  const installNames = new Set((await moduleRows(env, "state = ANY($1::varchar[])", [INSTALL_STATES])).map((m) => m.name));
  const clash = (await env.cr.query<{ module: string; exclusion: string }>(
    `SELECT m.shortdesc->>'en_US' AS module, x.shortdesc->>'en_US' AS exclusion
       FROM ir_module_module_exclusion e JOIN ir_module_module m ON m.id = e.module_id
       LEFT JOIN ir_module_module x ON x.name = e.name
      WHERE m.name = ANY($1::varchar[]) AND e.name = ANY($1::varchar[]) ORDER BY m.id, e.id LIMIT 1`, [[...installNames]])).rows[0];
  if (clash) throw new UserError(`Modules "${clash.module}" and "${clash.exclusion}" are incompatible.`);
  // the exclusive categories (:449-471): none of the templates' modules is in one
  const exclusive = (await env.cr.query("SELECT 1 FROM ir_module_category WHERE exclusive LIMIT 1")).rows.length;
  if (exclusive) throw new NotPorted("button_install with an exclusive module category");
}

/** The installed modules (imported data modules left out, as src/orm/template.ts) plus `extra`. */
async function moduleSet(env: Environment, states: readonly string[]): Promise<string[]> {
  return (await env.cr.query<{ name: string }>(
    `SELECT name FROM ir_module_module m WHERE state = ANY($1::varchar[])
        AND NOT COALESCE((to_jsonb(m) ->> 'imported')::boolean, false) ORDER BY name`, [[...states]])).rows.map((r) => r.name);
}

/** The template the database moves to, or NotPorted: its registry (the Python code of the new modules) is not in the bundle. */
async function targetTemplate(env: Environment): Promise<TemplateInfo> {
  const names = await moduleSet(env, INSTALL_STATES);
  const t = await templateForModules(names);
  if (t === null) {
    const toInstall = (await moduleRows(env, "state = 'to install'", [])).map((m) => m.name);
    throw new NotPorted(`installing ${toInstall.join(", ")}: no generated registry for the resulting module set (gen/out/templates.json)`);
  }
  if (buildMissing(t.name)) {
    // D9: the module set has a compiled build, but not in this site's bundle (one build per site). No Odoo
    // counterpart: the port's own UserError, naming the set the site was built for
    const toInstall = (await moduleRows(env, "state = 'to install'", [])).map((m) => m.name);
    const target = new Set(names);
    const hints: string[] = [];
    for (const b of installedBuilds()) {
      const mods = await templateModules(b);
      if (!mods) continue;
      const missing = mods.filter((m) => !target.has(m));
      if (missing.length && [...target].every((m) => mods.includes(m))) hints.push(missing.join(", "));
    }
    throw new UserError(hints.length
      ? `${toInstall.join(", ")} cannot be installed on their own on this site: its build covers them together with ${hints[0]}. Install ${hints[0]} at the same time, or rebuild the site for this set of modules.`
      : `${toInstall.join(", ")} cannot be installed on this site: its build does not cover this set of modules. Rebuild the site with them.`);
  }
  return t;
}

// ------------------------------------------------------------------------------------- schema and reflection

interface ReflRow { key: string[]; added: boolean; offset?: number; values: Record<string, unknown> }
interface Reflection {
  columns: { table: string; column: string; type: string; comment: string | null; init: string | null }[];
  indexes: { name: string; def: string }[];
  constraints: { table: string; name: string; def: string }[];
  models: ReflRow[];
  fields: ReflRow[];
  selections: ReflRow[];
  xmlids: { offset: number; module: string; name: string; model: string; noupdate: boolean; key: string[] }[];
  sequences: Record<string, number>;
  /** What the end of the load takes of the sequences after the install's last row (no rows). */
  tail?: Record<string, number>;
  concerned: string[];
  fingerprint: string;
}

/** Kept identical to FINGERPRINT_SQL in worker/gen/install_reflection.py (`%(models)s` there is `$1` here). */
const FINGERPRINT_SQL = `
SELECT md5(COALESCE((SELECT string_agg(concat_ws('|', m.model, m.name::text, m.info, m.state, m."order", m.transient, m.abstract), E'\\n' ORDER BY m.model)
                       FROM ir_model m WHERE m.model = ANY($1)), '')
        || COALESCE((SELECT string_agg(concat_ws('|', f.model, f.name, f.ttype, f.store, f.relation, f.required, f.readonly, f.field_description::text, f.state), E'\\n' ORDER BY f.model, f.name)
                       FROM ir_model_fields f WHERE f.model = ANY($1)), '')
        || COALESCE((SELECT string_agg(concat_ws('|', f.model, f.name, s.value, s.sequence, s.name::text), E'\\n' ORDER BY f.model, f.name, s.value)
                       FROM ir_model_fields_selection s JOIN ir_model_fields f ON f.id = s.field_id WHERE f.model = ANY($1)), '')) AS f
`;

const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** The last value the table's id sequence gave (what the next row's id follows). */
async function lastId(env: Environment, table: string): Promise<number> {
  const r = (await env.cr.query<{ v: string }>(`SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END AS v FROM ${ident(`${table}_id_seq`)}`)).rows[0]!;
  return Number(r.v);
}

/** A row of `table` from the generator's values, with its id: the columns named, the others their database default. */
async function insertRow(env: Environment, table: string, id: number, values: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(values);
  await env.cr.query(
    `INSERT INTO ${ident(table)} (id, ${cols.map(ident).join(", ")})
     SELECT $1, ${cols.map(ident).join(", ")} FROM json_populate_record(NULL::${ident(table)}, $2::json)`, [id, JSON.stringify(values)]);
}

async function updateRow(env: Environment, table: string, where: string, params: unknown[], values: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(values);
  await env.cr.query(
    `UPDATE ${ident(table)} t SET (${cols.map(ident).join(", ")}) = (SELECT ${cols.map((c) => `r.${ident(c)}`).join(", ")}
       FROM json_populate_record(NULL::${ident(table)}, $${params.length + 1}::json) r) WHERE ${where}`, [...params, JSON.stringify(values)]);
}

async function modelId(env: Environment, model: string): Promise<number> {
  const id = (await env.cr.query<{ id: number }>("SELECT id FROM ir_model WHERE model = $1", [model])).rows[0]?.id;
  if (id === undefined) throw new NotPorted(`install reflection: no ir_model row for ${model}`);
  return id;
}

async function fieldId(env: Environment, model: string, name: string): Promise<number> {
  const id = (await env.cr.query<{ id: number }>("SELECT id FROM ir_model_fields WHERE model = $1 AND name = $2", [model, name])).rows[0]?.id;
  if (id === undefined) throw new NotPorted(`install reflection: no ir_model_fields row for ${model}.${name}`);
  return id;
}

/**
 * `registry.init_models` of the modules to install (registry.py:812-867): `_auto_init`'s new columns and their initial
 * values (fields.py:1234-1345), the reflection upserts (`upsert_en`, ir_model.py:150-190) of ir_model, ir_model_fields
 * and ir_model_fields_selection, their xmlids (`_update_xmlids`), indexes and foreign keys. These depend on the
 * registry during the install, so they come from Odoo's own install of the same modules on the template
 * (gen/install_reflection.py), replayed with the ids Odoo's sequences gave: each upserted row takes a value, inserted
 * or not, and `_update_xmlids` inserts the xmlids that exist already too (ON CONFLICT), so the sequences move past
 * the rows written as they did in Odoo. Only on a database whose reflection rows are still the template's.
 */
async function initModels(env: Environment, overlay: string): Promise<void> {
  const r = await genAssetJson(`${overlay}/install_reflection.json`) as Reflection;
  const f = (await env.cr.query<{ f: string }>(FINGERPRINT_SQL, [r.concerned])).rows[0]?.f;
  if (f !== r.fingerprint) throw new NotPorted(`installing into a database whose registry rows of ${r.concerned.join(", ")} differ from the template's (gen/install_reflection.py)`);
  for (const c of r.columns) {
    // sql.create_column (tools/sql.py:348-362) and _init_column_data's UPDATE ... WHERE col IS NULL
    await env.cr.query(`ALTER TABLE ${ident(c.table)} ADD COLUMN ${ident(c.column)} ${ident(c.type)}`);
    if (c.comment) await env.cr.query(`COMMENT ON COLUMN ${ident(c.table)}.${ident(c.column)} IS ${`'${c.comment.replace(/'/g, "''")}'`}`);
    if (c.init !== null) await env.cr.query(`UPDATE ${ident(c.table)} SET ${ident(c.column)} = $1::${ident(c.type)} WHERE ${ident(c.column)} IS NULL`, [c.init]);
  }
  const base: Record<string, number> = {};
  for (const t of Object.keys(r.sequences)) base[t] = await lastId(env, t);
  for (const m of r.models) {
    if (m.added) await insertRow(env, "ir_model", base["ir_model"]! + m.offset! + 1, m.values);
    else await updateRow(env, "ir_model", "t.model = $1", [m.key[0]], m.values);
  }
  for (const fr of r.fields) {
    const values = { ...fr.values };
    if (values["related_field_id"] != null || values["relation_field_id"] != null) throw new NotPorted(`install reflection: ${fr.key.join(".")} refers to another field by id`);
    if ("model_id" in values) values["model_id"] = await modelId(env, String(values["model_id"]));
    if (fr.added) await insertRow(env, "ir_model_fields", base["ir_model_fields"]! + fr.offset! + 1, values);
    else await updateRow(env, "ir_model_fields", "t.model = $1 AND t.name = $2", [fr.key[0], fr.key[1]], values);
  }
  for (const sr of r.selections) {
    const fid = await fieldId(env, sr.key[0]!, sr.key[1]!);
    if (sr.added) await insertRow(env, "ir_model_fields_selection", base["ir_model_fields_selection"]! + sr.offset! + 1, { ...sr.values, field_id: fid });
    else await updateRow(env, "ir_model_fields_selection", "t.field_id = $1 AND t.value = $2", [fid, sr.key[2]], sr.values);
  }
  for (const x of r.xmlids) {
    const resId = x.model === "ir.model" ? await modelId(env, x.key[0]!)
      : x.model === "ir.model.fields" ? await fieldId(env, x.key[0]!, x.key[1]!)
      : (await env.cr.query<{ id: number }>(
        "SELECT s.id FROM ir_model_fields_selection s JOIN ir_model_fields f ON f.id = s.field_id WHERE f.model = $1 AND f.name = $2 AND s.value = $3",
        [x.key[0], x.key[1], x.key[2]])).rows[0]!.id;
    await env.cr.query("INSERT INTO ir_model_data (id, module, name, model, res_id, noupdate) VALUES ($1, $2, $3, $4, $5, $6)",
      [base["ir_model_data"]! + x.offset + 1, x.module, x.name, x.model, resId, x.noupdate]);
  }
  for (const [t, took] of Object.entries(r.sequences)) {
    await env.cr.query(`SELECT setval(${`'${t}_id_seq'`}, $1, true)`, [base[t]! + took]);
  }
  for (const i of r.indexes) await env.cr.query(i.def);
  for (const c of r.constraints) await env.cr.query(`ALTER TABLE ${c.table} ADD CONSTRAINT ${ident(c.name)} ${c.def}`);
}

// ------------------------------------------------------------------------------- captured install (gen/install_capture.py)

export interface Capture {
  base_fingerprint: string; modules: string[]; order: string[]; phases: Record<string, string[]>; now: string; reflect?: Reflect[];
  translations?: TranslationSave[];
  init_columns?: InitColumn[];
  /** The languages active when Odoo's install started (gen/install_capture.py). */
  langs?: string[];
  /** What the replayed statements depend on, once the reflection is the port's (gen/install_capture.py check_of). */
  replay_check?: { sql: string; expected: [string, string][] };
}

/**
 * Whether the captured statements hold on this database: with the port's reflection (src/modules/reflect.ts), the
 * capture's `replay_check` (the DDL's tables, and the sequences and row counts of the tables whose ids the statements
 * carry or the data files fill); without it, the registry tables' fingerprint taken before (`before`). The items that
 * differ, empty when the capture applies.
 */
export async function captureDiffers(env: Environment, cap: Capture, before: string | undefined): Promise<string[]> {
  if (!cap.replay_check) return before === cap.base_fingerprint ? [] : ["registry tables (base_fingerprint)"];
  if (!cap.replay_check.expected.length) return [];
  const got = new Map((await env.cr.query<{ k: string; v: string }>(cap.replay_check.sql)).rows.map((r) => [r.k, r.v]));
  return cap.replay_check.expected.filter(([k, v]) => got.get(k) !== v).map(([k, v]) => `${k}: ${got.get(k) ?? "missing"} (capture ${v})`);
}

/** Kept identical to FINGERPRINT_SQL in worker/gen/install_capture.py. */
export const CAPTURE_FINGERPRINT_SQL = `
SELECT md5(string_agg(t.v, E'\\n' ORDER BY t.k)) AS f FROM (
  SELECT 'seq ' || s.sequencename AS k, s.sequencename || '=' || COALESCE(s.last_value::text, '-') AS v
    FROM pg_sequences s WHERE s.schemaname = 'public' AND s.sequencename IN ('ir_model_id_seq', 'ir_model_fields_id_seq',
         'ir_model_fields_selection_id_seq', 'ir_model_constraint_id_seq', 'ir_model_relation_id_seq',
         'ir_model_inherit_id_seq', 'ir_model_data_id_seq')
  UNION ALL SELECT 'n ir_model', count(*)::text FROM ir_model
  UNION ALL SELECT 'n ir_model_fields', count(*)::text FROM ir_model_fields
  UNION ALL SELECT 'n ir_model_fields_selection', count(*)::text FROM ir_model_fields_selection
  UNION ALL SELECT 'n ir_model_constraint', count(*)::text FROM ir_model_constraint
  UNION ALL SELECT 'n ir_model_relation', count(*)::text FROM ir_model_relation
  UNION ALL SELECT 'n ir_model_inherit', count(*)::text FROM ir_model_inherit
  UNION ALL SELECT 'n ir_model_data', count(*)::text FROM ir_model_data
  UNION ALL SELECT 'tables', string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables WHERE schemaname = 'public'
) t
`;

/** The overlay's captured install, or null for an overlay replayed from install_reflection.json (l10n_se). */
async function captureOf(overlay: string): Promise<Capture | null> {
  try {
    return await genAssetJson(`${overlay}/install_capture.json`) as Capture;
  } catch (e) {
    if (e instanceof NotPorted) return null; // not packaged: the overlay has no capture
    throw e;
  }
}

/**
 * One phase of Odoo's own install of the module set (gen/install_capture.py): its schema and reflection statements,
 * as Odoo executed them, so that ids and sequences are Odoo's. The transaction's now() given as a parameter is a marker.
 */
export async function replayPhase(env: Environment, cap: Capture, phase: string): Promise<void> {
  const marker = `'${cap.now}'`;
  for (const text of cap.phases[phase] ?? []) {
    // the reflection, written by the port from what the registry expects at this step (src/modules/reflect.ts)
    const m = /^@@reflect (\d+)@@$/.exec(text);
    if (m) {
      const r = cap.reflect?.[Number(m[1])];
      if (!r) throw new NotPorted(`install capture: reflection ${m[1]} missing`);
      await applyReflection(env, r);
      continue;
    }
    // a new column's values on the existing rows, written by the port (B3)
    const ic = /^@@init_column (\d+)@@$/.exec(text);
    if (ic) {
      const c = cap.init_columns?.[Number(ic[1])];
      if (!c) throw new NotPorted(`install capture: init column ${ic[1]} missing`);
      await initColumnData(env, c);
      continue;
    }
    // the NOT NULL of a required column whose default waits for the registry (src/modules/install_columns.ts)
    if (postponeNotNull(env.cr, text)) continue;
    // the translation import, written by the port from what the build read in the .po files (B2)
    const t = /^@@translations (\d+)@@$/.exec(text);
    if (t) {
      const save = cap.translations?.[Number(t[1])];
      if (!save) throw new NotPorted(`install capture: translation save ${t[1]} missing`);
      noteDataWrite(env.cr, "a translation import");
      await applyTranslationSave(env, save);
      continue;
    }
    // a replayed statement writing a business table (not the ir_ reflection and schema bookkeeping)
    const dml = /^\s*(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+"?([a-z0-9_]+)"?/i.exec(text);
    if (dml && !dml[1]!.startsWith("ir_")) noteDataWrite(env.cr, `${text.slice(0, 60)}...`);
    await env.cr.query(text.split(marker).join("(now() AT TIME ZONE 'UTC')"));
  }
}

// ------------------------------------------------------------------------------------------------ the load

export interface ModuleFiles {
  manifest: { data: string[]; demo: string[]; latest_version: string; pre_init_hook: string; post_init_hook: string };
  files: Record<string, string>;
  po: Record<string, string>;
  /** the files `<field file=...>` names, base64 by their addons path (convert.py `file_open`) */
  binaries?: Record<string, string>;
}

/**
 * What runs at the flush after each data file (`env.cr.flush()`, loading.py:58): stored computes Odoo leaves pending
 * while the file loads and the port runs eagerly elsewhere register here (account.report.line foldability).
 */
const FILE_FLUSH: ((env: Environment) => Promise<void>)[] = [];
export function onDataFileFlush(fn: (env: Environment) => Promise<void>): void {
  FILE_FLUSH.push(fn);
}

/** Cursors loading a module from the addons path (not an imported data module): its views get `arch_fs`. */
const FROM_ADDONS = new WeakSet<object>();
export function loadingFromAddons(env: Environment): boolean {
  return FROM_ADDONS.has(env.cr);
}

/** `load_data` (loading.py:43-60): each file of the manifest's `kind`, then a flush (the precommit hooks); `mode`
 *  'update' for an upgrade (src/modules/upgrade.ts). */
export async function loadData(env: Environment, module: string, files: ModuleFiles, kind: "data" | "demo", idref: IdRef, mode: "init" | "update" = "init"): Promise<void> {
  for (const filename of files.manifest[kind]) {
    const text = files.files[filename];
    if (text === undefined) throw new NotPorted(`install of ${module}: ${filename} is not packaged (gen/module_files.py)`);
    FROM_ADDONS.add(env.cr);
    openProcessedImages(env, true); // the related images of Image fields created by the file are stored at its flush
    holdTracking(env.cr);
    try {
      await convertFile(env, module, filename, new TextEncoder().encode(text), idref, mode, kind === "demo", `${module}/${filename}`, files.binaries);
    } catch (e) {
      dropHeldTracking(env.cr); // the failed file's tracking goes with its savepoint (or the transaction)
      throw e;
    } finally {
      FROM_ADDONS.delete(env.cr);
    }
    // `env.cr.flush()` (loading.py:58): the precommit (the held tracking), then the pending computes
    await flushHeldTracking(env);
    // the precommit's `_track_finalize` pops the tracking data with the discards of the records created so far
    // (mail_track_mixin.py:107-115, :133-142): a later file's write of one is tracked (lunch's demo partner_hungry_dog,
    // created in lunch_data.xml, its email and name logged in Odoo)
    trackSavepointFlush(env.cr);
    noteCommitPoint(env.cr);
    await flushProcessedImages(env);
    for (const fn of FILE_FLUSH) await fn(env);
  }
}

/** An error of the port itself (a bug or a refusal), never a demo failure Odoo would record. */
function portError(e: unknown): boolean {
  const inner = e instanceof ParseError ? e.wrapped : e;
  if (inner instanceof ParseError) return portError(inner);
  // a NOT NULL or CHECK violation is the port writing a row Odoo does not (Odoo's own demo data meets them);
  // a unique violation can be Odoo's own demo failure (co_new: the demo company's name taken)
  if (isPgError(inner) && (inner.code === "23502" || inner.code === "23514")) return true;
  return inner instanceof NotPorted || inner instanceof TypeError || inner instanceof ReferenceError
    || inner instanceof RangeError || inner instanceof SyntaxError;
}

/**
 * `load_demo` (loading.py:62-84): the demo files in a savepoint, as the superuser with `install_demo`; on an error the
 * savepoint is rolled back, `base.demo_failure_todo` opened and an `ir.demo_failure` created with the traceback (its
 * text is Python's: harness rule N19 masks it), and the module is installed without demo.
 */
async function loadDemo(env: Environment, module: string, moduleId: number, files: ModuleFiles, idref: IdRef): Promise<boolean> {
  if (!files.manifest.demo.length) return true;
  const sp = `load_demo_${moduleId}`;
  await env.cr.query(`SAVEPOINT ${sp}`);
  try {
    await loadData(env.withContext({ ...env.context, install_demo: true }), module, files, "demo", idref);
    await env.cr.query(`RELEASE SAVEPOINT ${sp}`);
    return true;
  } catch (e) {
    if (portError(e)) throw e;
    await env.cr.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    // the rolled-back rows may be in the environment's cache: a new environment
    const fresh = await createEnvironment({ cr: env.cr, uid: env.uid, su: env.su, context: env.context });
    const todo = (await env.cr.query<{ res_id: number }>("SELECT res_id FROM ir_model_data WHERE module = 'base' AND name = 'demo_failure_todo'")).rows[0];
    if (todo && fresh.reg.models.has("ir.demo_failure")) {
      await write(fresh, "ir.actions.todo", [todo.res_id], { state: "open" });
      await create(fresh, "ir.demo_failure", [{ module_id: moduleId, error: `Traceback (most recent call last):\n${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\n` }]);
    }
    return false;
  }
}

/** One module of `load_module_graph` (loading.py:114-304) with update_operation 'install', after init_models. */
async function loadModule(env0: Environment, module: string, moduleId: number, files: ModuleFiles, cap: Capture | null,
  reload: () => Promise<Environment>): Promise<Environment> {
  if (files.manifest.pre_init_hook) throw new NotPorted(`install of ${module}: its pre_init_hook (Python)`);
  let env = env0;
  // :146-150 `registry.load(package)` and `registry.init_models` of the module's models (their tables and reflection,
  // captured from Odoo's install): the port's registry is read from the reflection, so it is loaded again after it
  if (cap) {
    await replayPhase(env, cap, `init:${module}`);
    env = await reload();
    // the new columns' computed values on existing rows (fields.py:1342-1345, flushed inside init_models)
    await computeInitColumns(env);
  }
  const idref: IdRef = new Map();
  await loadData(env, module, files, "data", idref);
  // `module._check()` only logs; demo when every module it depends on has demo (module_graph.py:202-203)
  const installable = !(await env.cr.query(
    `SELECT 1 FROM ir_module_module_dependency d JOIN ir_module_module m ON m.name = d.name
      WHERE d.module_id = $1 AND NOT COALESCE(m.demo, false) LIMIT 1`, [moduleId])).rows.length;
  const demo = installable ? await loadDemo(env, module, moduleId, files, idref) : false;
  await env.cr.query("UPDATE ir_module_module SET demo = $1 WHERE id = $2", [demo, moduleId]);
  // :226-227 `_reflect_field_groups`: captured (post phase), or in the reflection replayed by initModels
  if (cap) await replayPhase(env, cap, `post:${module}`);
  // :230-232 `_update_translations` of the installed languages (en_US has none)
  const langs = (await env.cr.query<{ code: string }>("SELECT code FROM res_lang WHERE active AND code != 'en_US' ORDER BY code")).rows.map((r) => r.code);
  const withPo = langs.filter((l) => files.po[l] !== undefined || files.po[l.split("_")[0]!] !== undefined);
  // captured from Odoo's install (gen/install_capture.py): what its translation import wrote, on the same records
  if (cap && cap.order.includes(`translations:${module}`)) await replayPhase(env, cap, `translations:${module}`);
  // a capture whose languages were these (gen/install_capture.py `langs`) and that has no translations phase for the
  // module: Odoo's import wrote nothing in them
  else if (withPo.length && !(cap?.langs && cap.modules.includes(module) && withPo.every((l) => cap.langs!.includes(l)))) {
    throw new NotPorted(`install of ${module}: its translations in ${withPo.join(", ")} (_update_translations)`);
  }
  // :236-240 the post_init hook, ported per module (src/modules/init_hooks.ts)
  if (files.manifest.post_init_hook) await runPostInit(env, module, files.manifest.post_init_hook, cap);
  // :245-256 the module installed at its manifest's version, with `_get_views` of the new state (ir_module.py:222-252)
  await env.cr.query("UPDATE ir_module_module SET state = 'installed', latest_version = $2, write_uid = $3, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1",
    [moduleId, files.manifest.latest_version, env.uid]);
  await recomputeModuleViews(env, [moduleId]);
  return env;
}

/**
 * `ir.model.data._process_end` (ir_model.py:2715-2790) of the installed modules: the module's XML ids not loaded by
 * this load are removed. A first install loads every one of its XML ids (data, reflection, the chart loader's are
 * account's), so there is nothing to remove; an older row of the module (a reinstall) refuses.
 */
async function processEnd(env: Environment, modules: readonly string[]): Promise<void> {
  const old = await env.cr.query(
    "SELECT 1 FROM ir_model_data WHERE module = ANY($1) AND res_id IS NOT NULL AND NOT COALESCE(noupdate, false) AND create_date < now() AT TIME ZONE 'UTC' LIMIT 1", [modules]);
  if (old.rows.length) throw new NotPorted(`_process_end of ${modules.join(", ")}: XML ids from an earlier install`);
}

/**
 * `next()` (ir_module.py:591-606): the first open ir.actions.todo is launched (ir_actions.py:1431-1456
 * `action_launch`: set done, its action read), else /odoo. A demo failure opens base.demo_failure_todo (its server
 * action).
 */
export async function moduleNext(env: Environment, read: boolean): Promise<Record<string, unknown>> {
  const todo = (await env.cr.query<{ id: number; action_id: number; type: string }>(
    `SELECT t.id, t.action_id, a.type FROM ir_actions_todo t JOIN ir_actions a ON a.id = t.action_id
      WHERE t.state = 'open' ORDER BY t.sequence, t.id LIMIT 1`)).rows[0];
  if (!todo) return { type: "ir.actions.act_url", target: "self", url: "/odoo" };
  await env.cr.query("SELECT 1 FROM ir_actions_todo WHERE id = $1 FOR NO KEY UPDATE", [todo.id]);
  await write(env, "ir.actions.todo", [todo.id], { state: "done" });
  // a caller that only tests the answer (`install_l10n_modules`) does not need the action's values (`read()` has no effect)
  if (!read) return { type: todo.type, id: todo.action_id };
  if (todo.type === "ir.actions.act_window") throw new NotPorted("ir.actions.todo action_launch of a window action (its context)");
  const [action] = await env.model(todo.type).read([todo.action_id], [], "");
  if (!action) throw new NotPorted(`ir.actions.todo ${todo.id} without its action`);
  return action;
}

/** `_button_immediate_function` (ir_module.py:608-665) with `button_install`. */
export async function buttonImmediateInstall(env: Environment, ids: readonly number[], opts: { readonly answer?: boolean } = {}): Promise<Record<string, unknown>> {
  if (!(await isAdmin(env))) throw new AccessDenied();
  await env.cr.query("SET LOCAL lock_timeout = '3s'");
  await env.cr.query("SELECT pg_advisory_xact_lock_shared(hashtext('registry_loading'))");
  await env.cr.query("LOCK ir_module_module IN EXCLUSIVE MODE");
  await env.cr.query("SELECT FROM ir_cron FOR UPDATE");
  await buttonInstall(env, ids);
  const template = await targetTemplate(env);
  if (!template.overlay) throw new NotPorted(`installing into ${template.name}: only an overlay template's modules are installed (compiler/B1.md)`);
  // registry.load of the new modules (registry.py:424-453): the registry of the new module set from here on
  registryChanged(env.cr);
  // ir_module.py:645-646: Odoo commits before `Registry.new`, whose load commits again; each commit of a transaction
  // that changed the registry signals it (registry.py:1132-1138). Measured on payment_demo's install
  // (2026-11-14): two orm_signaling_registry rows where the port's one commit wrote one, so the session's
  // registry_hash (an HMAC of the last id, src/session/info.ts) differed; the first row is written here
  await env.cr.query("INSERT INTO orm_signaling_registry DEFAULT VALUES");
  // registry.ready is False until load_modules ends (loading.py)
  setRegistryLoading(env.cr, true);
  try {
    pinTemplate(env.cr.db, template);
    // the registry tables as Odoo's capture found them before its reload (gen/install_capture.py takes the fingerprint
    // before `Registry.new`, whose update_list may create a record: a vendored module on disk, B6)
    const before = (await env.cr.query<{ f: string }>(CAPTURE_FINGERPRINT_SQL)).rows[0]?.f;
    const cap = await captureOf(template.overlay);
    // the captured statements' literals (ids, sequence values) hold on the state Odoo installed on, where they depend on it
    const differs = cap ? await captureDiffers(env, cap, before) : [];
    // loading.py:400-403 `update_list()` after base's graph, before the new modules load
    await updateListAfterReload(env);
    let toInstall = await moduleRows(env, "state = 'to install'", []);
    if (cap) {
      if (differs.length) throw new NotPorted(`installing into a database that differs from ${template.name}'s base where the capture depends on it (gen/install_capture.py): ${differs.slice(0, 5).join("; ")}`);
      const names = toInstall.map((m) => m.name).sort();
      if (names.join() !== [...cap.modules].sort().join()) throw new NotPorted(`installing ${names.join(", ")}: the capture of ${template.name} installs ${cap.modules.join(", ")}`);
      // ModuleGraph's order (modules/module_graph.py): the order of the modules' post phases in Odoo's install. Not the
      // init phases: a module without models of its own has none (registry.init_models is not called for it;
      // l10n_gcc_invoice_stock_account sorted first and its view found no l10n_gcc_invoice.l10n_gcc_report_invoice_document)
      const order = cap.order.filter((p) => p.startsWith("post:")).map((p) => p.slice(5));
      const lost = toInstall.filter((m) => !order.includes(m.name)).map((m) => m.name);
      if (lost.length) throw new NotPorted(`installing ${lost.join(", ")}: no post phase in the capture of ${template.name} (its graph order)`);
      toInstall = [...toInstall].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    } else {
      await initModels(env, template.overlay);
      if (toInstall.length > 1) throw new NotPorted(`installing several modules at once (${toInstall.map((m) => m.name).join(", ")}): the graph order`);
    }
    // VAGB B0, the registry per module (loading.py:181-188 `registry.load(package)` one module after the other): while
    // a module that is not the graph's last loads, the registry is the one after it (gen/install_capture.py
    // install_steps.json, src/orm/overlay.ts). A capture made before the steps were recorded has none: its modules load
    // with the final registry as before, and the compiled keys of a later module refuse (compiler/runtime/install.ts)
    const steps = cap && toInstall.length > 1 ? await installSteps(template.overlay) : null;
    if (steps && steps.order.join() !== toInstall.slice(0, -1).map((m) => m.name).join()) {
      throw new NotPorted(`installing ${toInstall.map((m) => m.name).join(", ")}: the install steps of ${template.name} are ${steps.order.join(", ")} (gen/install_capture.py)`);
    }
    const stepOf = (module: string): TemplateInfo => (steps?.order.includes(module) ? { ...template, step: module } : template);
    // load_modules' environment (loading.py:373): the superuser without context, on the new registry
    const loadEnv = await createEnvironment({ cr: env.cr, uid: 1, su: true, context: {} });
    const all = await genAssetJson(`${template.overlay}/module_files.json`) as Record<string, ModuleFiles>;
    // load_module_graph (loading.py:114-304) one module after the other on the same registry: a module's init phase
    // sees the models of the ones loaded before it (purchase_requisition_stock's column on purchase.requisition)
    let moduleEnv = loadEnv;
    for (const m of toInstall) {
      const files = all[m.name];
      if (files === undefined) throw new NotPorted(`install of ${m.name}: not a module of ${template.name}'s overlay`);
      setLoadingModule(env.cr, m.name, toInstall.slice(toInstall.indexOf(m) + 1).map((x) => x.name));
      // the module's code is in Odoo's registry from its init phase on (`_init_column_data`'s defaults are its)
      pinTemplate(env.cr.db, stepOf(m.name));
      try {
        moduleEnv = await loadModule(moduleEnv, m.name, m.id, files, cap, async () => {
          registryChanged(env.cr);
          pinTemplate(env.cr.db, stepOf(m.name));
          return createEnvironment({ cr: env.cr, uid: 1, su: true, context: {} });
        });
      } finally {
        setLoadingModule(env.cr, null);
      }
    }
    if (steps) {
      // the graph's last module loaded on the final registry; nothing after the loop runs on a step's
      registryChanged(env.cr);
      pinTemplate(env.cr.db, template);
    }
    // loading.py:252-253: Odoo commits after each module it installs, and each commit signals the changed registry; the
    // port's one commit at the request's end signals the last. Measured: payment_custom with account_payment_custom
    // auto-installed wrote three rows (2026-11-14, dev_fu_pcsig on the oracle), payment_demo two
    for (let i = 1; i < toInstall.length; i++) await env.cr.query("INSERT INTO orm_signaling_registry DEFAULT VALUES");
    // loading.py:509-517 modules left to install or upgrade are only logged; here they would be another graph's
    const left = await moduleRows(env, "state IN ('to install', 'to upgrade')", []);
    if (left.length) throw new NotPorted(`install leaving ${left.map((m) => m.name).join(", ")} to install or upgrade`);
    // :525-538 the updated modules: `_process_end`, then the autovacuum in a minute (ir_cron.py:750-817 `_trigger`)
    await processEnd(loadEnv, toInstall.map((m) => m.name));
    const vacuum = (await env.cr.query<{ id: number }>("SELECT res_id AS id FROM ir_model_data WHERE module = 'base' AND name = 'autovacuum_job'")).rows[0];
    if (vacuum) {
      await env.cr.query(
        `INSERT INTO ir_cron_trigger (cron_id, call_at, create_uid, write_uid, create_date, write_date)
         VALUES ($1, (clock_timestamp() AT TIME ZONE 'UTC') + interval '1 minute', 1, 1, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')`, [vacuum.id]);
    }
    // loading.py:478-491 `init_models` of the models whose fields are no longer translated reflects them again: their
    // existing xmlids take sequence values (ON CONFLICT), measured on Odoo's install (gen/install_reflection.py `tail`)
    if (cap) {
      await replayPhase(env, cap, "end");
      await computeInitColumns(env);
    } else {
      const refl = await genAssetJson(`${template.overlay}/install_reflection.json`) as Reflection;
      for (const [t, took] of Object.entries(refl.tail ?? {})) {
        if (took) await env.cr.query(`SELECT setval(${`'${t}_id_seq'`}, $1, true)`, [await lastId(env, t) + took]);
      }
    }
    // loading.py:583-590 `_register_hook` of every model: account's delayed chart template translations (a language
    // activated by a post_init hook, src/modules/init_hooks.ts)
    await runDelayedAccountTranslator(loadEnv);
  } finally {
    setRegistryLoading(env.cr, false);
  }
  // ir_module.py:654-664 `next()` in the caller's environment; a window action closing would reload the client
  const config = await moduleNext(env, opts.answer ?? true);
  if (config["type"] === "ir.actions.act_window_close") throw new NotPorted("module install answered by closing a window (the client reload)");
  return config;
}

registerMethod("ir.module.module", "button_immediate_install", async (env, ids) => buttonImmediateInstall(env, ids ?? []), { apiModel: false });
