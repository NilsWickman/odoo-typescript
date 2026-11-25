/**
 * Upgrading an installed module from the Apps screen, B3 (what `-u` does): `button_immediate_upgrade` (base
 * ir_module.py:704-709) -> `_button_immediate_function` (:608-665) -> `button_upgrade` (:711-760), then the registry
 * reload (`Registry.new(update_module=True)` -> odoo/modules/loading.py `load_modules`, update mode).
 *
 * Measured on Odoo's upgrade of crm_iap_enrich in poc_erp (statement log, 61 writes): `update_list` (every module's
 * write_date) and the module's state 'to upgrade' by the user; in the reload, `update_list` again as the superuser,
 * the module's models reflected again (only sequence values taken: the rows are unchanged), its data files loaded in
 * update mode (the records of noupdate=0 blocks written back where they differ, a noupdate=1 block left as the user
 * left it, their XML ids upserted), `_reflect_field_groups`, the translations of the installed languages, the module
 * installed with its views listed again, `_process_end`, the autovacuum triggered and the models to check reflected.
 *
 * The parts that do not depend on what the user changed are Odoo's own statements, captured by
 * gen/install_capture.py --upgrade (gen/out/<template>/upgrade/<module>.json) and replayed after a fingerprint check,
 * as the install's (src/modules/install.ts); the data files are loaded by the port in update mode
 * (src/modules/convert.ts), which is what makes the user's edits come out as in Odoo. The module's code is the
 * template's (an upgrade with unchanged code: the registry and the schema stay); a module without a capture, one with
 * installed modules depending on it that the capture does not upgrade, a new dependency to install, or a
 * `_process_end` that would delete records refuse (NotPorted).
 */
import { AccessDenied, NotPorted, UserError } from "../errors";
import { genAssetJson } from "../gen_assets";
import { registerMethod } from "../http/methods";
import { flushHeldTracking } from "../mail/write_hooks";
import { createEnvironment } from "../orm/env";
import { trackLoadedXmlids, untrackLoadedXmlids } from "../orm/load_records";
import { registryChanged, setRegistryLoading } from "../orm/signaling";
import { pinTemplate, templateOf, type TemplateInfo } from "../orm/template";
import type { Environment } from "../orm/types";
import { write } from "../orm/write";
import type { IdRef } from "./convert";
import { computeInitColumns } from "./install_columns";
import { CAPTURE_FINGERPRINT_SQL, captureDiffers, isAdmin, loadData, moduleNext, moduleRows, replayPhase, type Capture, type ModuleFiles } from "./install";
import { recomputeModuleViews } from "./module_views";
import { updateListAfterReload } from "./uninstall";

interface UpgradeCapture extends Capture { files: Record<string, ModuleFiles>; terp: Record<string, Record<string, unknown>> }

const TRANSLATED_INFO = new Set(["shortdesc", "summary", "description"]);
const BOOLEAN_INFO = new Set(["application", "auto_install", "to_buy", "iap_paid_service"]);

/**
 * loading.py:216 `module.write(module.get_values_from_terp(package.manifest))` (ir_module.py:761-778, captured): the
 * ORM writes the values that differ from the record (measured: `url` NULL -> '' for crm_iap_enrich). A changed
 * translated value refuses.
 */
async function writeTerp(env: Environment, moduleId: number, terp: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(terp).sort();
  const row = (await env.cr.query<Record<string, unknown>>(
    `SELECT ${cols.map((c) => TRANSLATED_INFO.has(c) ? `"${c}"->>'en_US' AS "${c}"` : `"${c}"`).join(", ")} FROM ir_module_module WHERE id = $1`, [moduleId])).rows[0]!;
  // the column's value of a manifest value: False is NULL but for a boolean (whose NULL reads as False)
  const value = (c: string): unknown => terp[c] === false && typeof terp[c] === "boolean" && !BOOLEAN_INFO.has(c) ? null : terp[c];
  const changed = cols.filter((c) => BOOLEAN_INFO.has(c) ? Boolean(row[c]) !== Boolean(terp[c]) : value(c) !== row[c]);
  if (!changed.length) return;
  const tr = changed.filter((c) => TRANSLATED_INFO.has(c));
  if (tr.length) throw new NotPorted(`upgrade: the module's ${tr.join(", ")} changed (a translated write)`);
  await env.cr.query(`UPDATE ir_module_module SET ${changed.map((c, i) => `"${c}" = $${i + 2}`).join(", ")}, write_uid = ${env.uid}, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1`,
    [moduleId, ...changed.map(value)]);
}

/** The reflection models: their XML ids are upserted by the replayed init phase (`_update_xmlids`, loaded xmlids). */
const REFLECTION = new Set(["ir.model", "ir.model.fields", "ir.model.fields.selection", "ir.model.constraint", "ir.model.relation", "ir.model.inherit"]);

async function captureOf(t: TemplateInfo, modules: readonly string[]): Promise<UpgradeCapture> {
  if (t.overlay || !t.dir) throw new NotPorted(`upgrading ${modules.join(", ")} in ${t.name}: upgrades are captured for poc_erp only (gen/install_capture.py --upgrade)`);
  return await genAssetJson(`${t.dir}/upgrade/${[...modules].sort().join("+")}.json`) as UpgradeCapture;
}

/** `button_upgrade` (ir_module.py:711-760): the modules and their installed dependents marked 'to upgrade'. */
async function buttonUpgrade(env: Environment, ids: readonly number[]): Promise<string[]> {
  if (!ids.length) return [];
  // :715 `update_list()`, by the user
  // `button_upgrade` runs in the full registry
  await updateListAfterReload(env, env.uid, true);
  const todo = await moduleRows(env, "id = ANY($1::int[])", [[...ids]]);
  if (todo.some((m) => m.name === "base")) throw new NotPorted("upgrading base (every installed module)");
  for (let i = 0; i < todo.length; i++) {
    const module = todo[i]!;
    if (module.state !== "installed" && module.state !== "to upgrade") throw new UserError(`Cannot upgrade module “${module.name}”. It is not installed.`);
    // check_external_dependencies: the template's modules have theirs (they are installed)
    const dependents = (await env.cr.query<{ id: number; name: string; state: string }>(
      `SELECT m.id, m.name, m.state FROM ir_module_module_dependency d JOIN ir_module_module m ON m.id = d.module_id
        WHERE d.name = $1 ORDER BY d.id`, [module.name])).rows;
    for (const dep of dependents) {
      if (dep.state === "installed" && !todo.some((m) => m.id === dep.id) && dep.name !== "studio_customization") todo.push(dep);
    }
  }
  await write(env, "ir.module.module", todo.map((m) => m.id), { state: "to upgrade" });
  const missing = (await env.cr.query<{ name: string; state: string | null }>(
    `SELECT d.name, m.state FROM ir_module_module_dependency d LEFT JOIN ir_module_module m ON m.name = d.name
      WHERE d.module_id = ANY($1::int[]) AND COALESCE(m.state, 'unknown') IN ('unknown', 'uninstalled') ORDER BY d.id LIMIT 1`, [todo.map((m) => m.id)])).rows[0];
  if (missing) throw new NotPorted(`upgrading with a dependency ${missing.name} ${missing.state ?? "unknown"} (its install)`);
  return todo.map((m) => m.name);
}

/** `_process_end` (ir_model.py:2716-2794) of the upgraded modules: what the load did not load again would be deleted. */
async function processEnd(env: Environment, modules: readonly string[], loaded: ReadonlySet<string>): Promise<void> {
  const rows = (await env.cr.query<{ xmlid: string; model: string; res_id: number }>(
    `SELECT module || '.' || name AS xmlid, model, res_id FROM ir_model_data
      WHERE module = ANY($1) AND res_id IS NOT NULL AND COALESCE(noupdate, false) != true ORDER BY id DESC`, [modules])).rows;
  const gone = [];
  for (const r of rows) {
    if (loaded.has(r.xmlid) || REFLECTION.has(r.model) || !env.reg.models.has(r.model)) continue;
    // :2744-2765 the XML id given to an `_inherits` parent created with its child: kept when a child was loaded
    let keep = false;
    for (const [name, def] of env.reg.models) {
      const link = def.inherits.get(r.model);
      if (!link || def.abstract) continue;
      const xids = (await env.cr.query<{ x: string }>(
        `SELECT d.module || '.' || d.name AS x FROM "${def.table}" c JOIN ir_model_data d ON d.model = $1 AND d.res_id = c.id
          WHERE c."${link}" = $2`, [name, r.res_id])).rows;
      if (xids.some((x) => loaded.has(x.x))) { keep = true; break; }
    }
    if (!keep) gone.push(r);
  }
  if (gone.length) throw new NotPorted(`_process_end of ${modules.join(", ")}: records no longer in the module's data (${gone.slice(0, 3).map((r) => r.xmlid).join(", ")})`);
}

export async function buttonImmediateUpgrade(env: Environment, ids: readonly number[]): Promise<Record<string, unknown>> {
  if (!(await isAdmin(env))) throw new AccessDenied();
  await env.cr.query("SET LOCAL lock_timeout = '3s'");
  await env.cr.query("SELECT pg_advisory_xact_lock_shared(hashtext('registry_loading'))");
  await env.cr.query("LOCK ir_module_module IN EXCLUSIVE MODE");
  await env.cr.query("SELECT FROM ir_cron FOR UPDATE");
  // the template stays the database's through the upgrade (its modules are 'to upgrade' until the end)
  const template = await templateOf(env.cr);
  // the registry tables as the capture found them, before `button_upgrade` (its update_list may create a record)
  const f = (await env.cr.query<{ f: string }>(CAPTURE_FINGERPRINT_SQL)).rows[0]?.f;
  const names = await buttonUpgrade(env, ids);
  pinTemplate(env.cr.db, template);
  const cap = await captureOf(template, names);
  if ([...cap.modules].sort().join() !== [...names].sort().join()) throw new NotPorted(`upgrading ${names.join(", ")}: the capture upgrades ${cap.modules.join(", ")}`);
  const differs = await captureDiffers(env, cap, f);
  if (differs.length) throw new NotPorted(`upgrading ${names.join(", ")} in a database that differs from the capture's where it depends on it (gen/install_capture.py --upgrade): ${differs.slice(0, 5).join("; ")}`);
  registryChanged(env.cr);
  pinTemplate(env.cr.db, template);
  setRegistryLoading(env.cr, true);
  const loaded = trackLoadedXmlids(env.cr);
  try {
    // loading.py:400-403 `update_list()` as the superuser, then base marked installed (:405-408, a no-op here)
    await updateListAfterReload(env);
    await env.cr.query("update ir_module_module set state='installed' where name='base'");
    const order = cap.order.filter((p) => p.startsWith("init:")).map((p) => p.slice(5));
    const loadEnv = await createEnvironment({ cr: env.cr, uid: 1, su: true, context: {} });
    for (const module of order) {
      const row = (await moduleRows(loadEnv, "name = $1", [module]))[0]!;
      const files = cap.files[module];
      if (!files) throw new NotPorted(`upgrade of ${module}: its files are not in the capture`);
      // :146-150 the module's models reflected again (init_models), the registry as before (same code)
      await replayPhase(loadEnv, cap, `init:${module}`);
      await computeInitColumns(loadEnv);
      for (const r of await loadEnv.cr.query<{ module: string; name: string }>(
        "SELECT module, name FROM ir_model_data WHERE module = $1 AND model = ANY($2::varchar[])", [module, [...REFLECTION]]).then((q) => q.rows)) {
        loaded.add(`${r.module}.${r.name}`);
      }
      await writeTerp(loadEnv, row.id, cap.terp[module] ?? {});
      const idref: IdRef = new Map();
      // :182-205 the data files in update mode, then the demo when the module has demo
      await loadData(loadEnv, module, files, "data", idref, "update");
      const demo = (await loadEnv.cr.query<{ demo: boolean | null }>("SELECT demo FROM ir_module_module WHERE id = $1", [row.id])).rows[0]?.demo;
      if (demo && files.manifest.demo.length) throw new NotPorted(`upgrade of ${module}: its demo files`);
      await loadEnv.cr.query("UPDATE ir_module_module SET demo = true WHERE id = $1", [row.id]);
      await flushHeldTracking(loadEnv);
      await replayPhase(loadEnv, cap, `post:${module}`);
      if (cap.order.includes(`translations:${module}`)) await replayPhase(loadEnv, cap, `translations:${module}`);
      await loadEnv.cr.query("UPDATE ir_module_module SET state = 'installed', latest_version = $2, write_uid = 1, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1",
        [row.id, files.manifest.latest_version]);
      await recomputeModuleViews(loadEnv, [row.id]);
    }
    await processEnd(loadEnv, order, loaded);
    const vacuum = (await env.cr.query<{ id: number }>("SELECT res_id AS id FROM ir_model_data WHERE module = 'base' AND name = 'autovacuum_job'")).rows[0];
    if (vacuum) {
      await env.cr.query(
        `INSERT INTO ir_cron_trigger (cron_id, call_at, create_uid, write_uid, create_date, write_date)
         VALUES ($1, (clock_timestamp() AT TIME ZONE 'UTC') + interval '1 minute', 1, 1, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')`, [vacuum.id]);
    }
    await replayPhase(env, cap, "end");
    await computeInitColumns(env);
  } finally {
    untrackLoadedXmlids(env.cr);
    setRegistryLoading(env.cr, false);
  }
  return moduleNext(env, true);
}

registerMethod("ir.module.module", "button_immediate_upgrade", async (env, ids) => buttonImmediateUpgrade(env, ids ?? []), { apiModel: false });
