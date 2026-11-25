/**
 * Uninstalling modules from the Apps screen: `button_uninstall_wizard` -> the `base.module.uninstall` wizard
 * (odoo/addons/base/wizard/base_module_uninstall.py) -> `button_immediate_uninstall` (base ir_module.py:608-690),
 * whose registry reload runs STEP 5 of `load_modules` (odoo/modules/loading.py:519-538): `module_uninstall`
 * (ir_module.py:506-514, base_import_module ir_module.py:395-410), i.e. `ir.model.data._module_data_uninstall`
 * (ir_model.py:2537-2709).
 *
 * Only modules without Python code (imported data modules) are uninstalled: a module with Python code would need its
 * uninstall hook, its tables and columns dropped and the registry rebuilt without its models (NotPorted). Data modules
 * defining models or fields (ir.model, ir.model.fields, constraints, relations) refuse as well.
 */
import { AccessDenied, AccessError, NotPorted, UserError } from "../errors";
import { registerMethod } from "../http/methods";
import { unlink } from "../orm/unlink";
import { write } from "../orm/write";
import type { Environment } from "../orm/types";
import { userHasGroup } from "../web/groups";
import { defineComputes } from "../models/tail_util";
import { recomputeModuleViews } from "./module_views";
import { registerOverrides } from "../orm/write";
import { genAssetJson } from "../gen_assets";
import { templateOf } from "../orm/template";
import { registryChanged } from "../orm/signaling";
import { reloadRegistryOf } from "../orm/env";
import { uninstallingModules } from "../models/ir_model_fields_create";
import { replayPhase, type Capture } from "./install";

const SERVER_WIDE_MODULES = ["base", "rpc", "web"]; // tools/config.py:32 DEFAULT_SERVER_WIDE_MODULES
const FORCED_MODULES = ["base"]; // modules/loading.py:40

async function isAdmin(env: Environment): Promise<boolean> {
  return env.su || env.uid === 1 || userHasGroup(env, "base.group_erp_manager");
}

/** `assert_log_admin_access` (ir_module.py:60-77). */
async function assertAdmin(env: Environment): Promise<void> {
  if (!(await isAdmin(env))) throw new AccessDenied();
}

/** `downstream_dependencies(known_deps, exclude_states)` (ir_module.py:530-557). */
export async function downstreamDependencies(env: Environment, ids: readonly number[], known: readonly number[] | null = null,
  excludeStates: readonly string[] = ["uninstalled", "uninstallable", "to remove"]): Promise<number[]> {
  if (!ids.length) return [...ids];
  const knownDeps = [...(known ?? [])];
  const exclude = knownDeps.length ? knownDeps : [...ids];
  const rows = (await env.cr.query<{ id: number }>(
    `SELECT DISTINCT m.id FROM ir_module_module_dependency d JOIN ir_module_module m ON (d.module_id = m.id)
      WHERE d.name IN (SELECT name FROM ir_module_module WHERE id = ANY($1::int[]))
        AND m.state != ALL($2::varchar[]) AND m.id != ALL($3::int[])`, [[...ids], [...excludeStates], exclude])).rows;
  const newDeps = rows.map((r) => r.id);
  const missing = newDeps.filter((id) => !knownDeps.includes(id));
  for (const id of newDeps) if (!knownDeps.includes(id)) knownDeps.push(id);
  if (missing.length) {
    for (const id of await downstreamDependencies(env, missing, knownDeps, excludeStates)) if (!knownDeps.includes(id)) knownDeps.push(id);
  }
  return knownDeps;
}

// base_module_uninstall.py:31-60
defineComputes("base.module.uninstall", {
  impacted_application_ids: async (env, rec) => (await impacted(env, (await rec.get("module_ids")) as number[])).apps,
  impacted_application_count: async (env, rec) => (await impacted(env, (await rec.get("module_ids")) as number[])).apps.length,
  impacted_module_ids: async (env, rec) => (await impacted(env, (await rec.get("module_ids")) as number[])).others,
  impacted_module_count: async (env, rec) => (await impacted(env, (await rec.get("module_ids")) as number[])).others.length,
  model_ids: async (env, rec) => lostModels(env, (await rec.get("module_ids")) as number[]),
  model_count: async (env, rec) => (await lostModels(env, (await rec.get("module_ids")) as number[])).length,
});

/** `_compute_impacted_module_ids`: the downstream modules sorted by (sequence, name), applications apart. */
async function impacted(env: Environment, moduleIds: readonly number[]): Promise<{ apps: number[]; others: number[] }> {
  const ids = await downstreamDependencies(env, moduleIds ?? [], moduleIds ?? []);
  const rows = (await env.cr.query<{ id: number; application: boolean | null }>(
    "SELECT id, application FROM ir_module_module WHERE id = ANY($1::int[]) ORDER BY sequence, name COLLATE \"C\"", [ids])).rows;
  return { apps: rows.filter((r) => r.application).map((r) => r.id), others: rows.filter((r) => !r.application).map((r) => r.id) };
}

/** `_compute_model_ids`: non-transient models whose external ids all belong to the impacted modules, by name. */
async function lostModels(env: Environment, moduleIds: readonly number[]): Promise<number[]> {
  if (!moduleIds?.length) return [];
  const ids = await downstreamDependencies(env, moduleIds, moduleIds);
  const names = (await env.cr.query<{ name: string }>("SELECT name FROM ir_module_module WHERE id = ANY($1::int[])", [ids])).rows.map((r) => r.name);
  const rows = (await env.cr.query<{ id: number; name: string }>(
    `SELECT m.id, m.name->>$2 AS name FROM ir_model m
      WHERE NOT m.transient
        AND EXISTS (SELECT 1 FROM ir_model_data d WHERE d.model = 'ir.model' AND d.res_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM ir_model_data d WHERE d.model = 'ir.model' AND d.res_id = m.id AND d.module != ALL($1::varchar[]))`,
    [names, env.lang ?? "en_US"])).rows;
  if (rows.length) throw new NotPorted("uninstalling a module that owns models (the model deletion is not ported)");
  return [];
}

/** `button_uninstall` (ir_module.py:676-690): checks, then the modules and their dependents become 'to remove'. */
async function buttonUninstall(env: Environment, ids: readonly number[]): Promise<number[]> {
  await assertAdmin(env);
  const rows = (await env.cr.query<{ id: number; name: string; state: string }>("SELECT id, name, state FROM ir_module_module WHERE id = ANY($1::int[]) ORDER BY id", [[...ids]])).rows;
  const forbidden = rows.map((r) => r.name).filter((n) => SERVER_WIDE_MODULES.includes(n) || FORCED_MODULES.includes(n));
  if (forbidden.length) throw new UserError(`Those modules cannot be uninstalled: ${[...new Set(forbidden)].join(", ")}`);
  if (rows.some((r) => !["installed", "to upgrade"].includes(r.state))) {
    throw new UserError("One or more of the selected modules have already been uninstalled, if you believe this to be an error, you may try again later or contact support.");
  }
  const deps = await downstreamDependencies(env, ids);
  const all = [...new Set([...ids, ...deps])];
  await write(env, "ir.module.module", all, { state: "to remove" });
  return all;
}

/** `_module_data_uninstall(modules_to_remove)` (ir_model.py:2537-2709) for modules that only own records. */
async function moduleDataUninstall(env0: Environment, names: readonly string[]): Promise<void> {
  if (!env0.su && !(await userHasGroup(env0, "base.group_system"))) throw new AccessError("Administrator access is required to uninstall a module");
  const env = env0.withContext({ ...env0.context, force_delete: true, prefetch_fields: false });
  const moduleData = (await env.cr.query<{ id: number; model: string; res_id: number }>(
    "SELECT id, model, res_id FROM ir_model_data WHERE module = ANY($1::varchar[]) AND res_id IS NOT NULL AND res_id != 0 ORDER BY id DESC", [[...names]])).rows;
  const moduleDataIds = new Set(moduleData.map((d) => d.id));
  const items: [string, number][] = [];
  const fieldIds: number[] = [];
  const modelIds: number[] = [], selectionIds: number[] = [], constraintIds: number[] = [];
  const once = (list: number[], id: number): void => { if (!list.includes(id)) list.push(id); };
  for (const d of moduleData) {
    // :2561-2572 the reflection records go after the others, in their own order (src/models/ir_model_fields_create.ts
    // and below: their unlink drops the schema)
    if (d.model === "ir.model.fields") { once(fieldIds, d.res_id); continue; }
    if (d.model === "ir.model") { once(modelIds, d.res_id); continue; }
    if (d.model === "ir.model.fields.selection") { once(selectionIds, d.res_id); continue; }
    if (d.model === "ir.model.constraint") { once(constraintIds, d.res_id); continue; }
    if (!items.some(([m, id]) => m === d.model && id === d.res_id)) items.push([d.model, d.res_id]);
  }
  const undeletable: number[] = [];
  const del = async (model: string, ids: number[]): Promise<void> => {
    // records with external ids of other modules stay
    const refData = (await env.cr.query<{ id: number; module: string; res_id: number }>(
      "SELECT id, module, res_id FROM ir_model_data WHERE model = $1 AND res_id = ANY($2::int[])", [model, ids])).rows;
    const cloc = refData.filter((r) => r.module === "__cloc_exclude__");
    if (cloc.length) throw new NotPorted("uninstalling records with __cloc_exclude__ external ids");
    const kept = new Set(refData.filter((r) => !moduleDataIds.has(r.id)).map((r) => r.res_id));
    const def = env.reg.model(model);
    const existing = new Set((await env.cr.query<{ id: number }>(`SELECT id FROM "${def.table}" WHERE id = ANY($1::int[])`, [ids])).rows.map((r) => r.id));
    const records = ids.filter((id) => !kept.has(id) && existing.has(id));
    if (!records.length) return;
    await env.cr.query("SAVEPOINT module_data_uninstall");
    try {
      await unlink(env, model, records);
      await env.cr.query("RELEASE SAVEPOINT module_data_uninstall");
    } catch (e) {
      await env.cr.query("ROLLBACK TO SAVEPOINT module_data_uninstall");
      if (e instanceof NotPorted) throw e;
      // ir_model.py:2627-2633 logs the record that could not be deleted
      if (records.length <= 1) console.warn(`module uninstall: could not delete ${model} ${records.join(",")}: ${String(e)}`);
      if (records.length <= 1) undeletable.push(...refData.map((r) => r.id));
      else {
        const half = Math.floor(records.length / 2);
        await del(model, records.slice(0, half));
        await del(model, records.slice(half));
      }
    }
  };
  // :2641-2649 non-model records first, batched by consecutive model (itertools.groupby)
  let i = 0;
  while (i < items.length) {
    const model = items[i]![0];
    const ids: number[] = [];
    while (i < items.length && items[i]![0] === model) ids.push(items[i++]![1]);
    if (env.reg.models.has(model)) await del(model, ids);
  }
  // :2651-2657 copied views (key 'module.%' without external id)
  const orphans = (await env.cr.query<{ id: number }>(
    `SELECT id FROM ir_ui_view WHERE ${names.map((_, k) => `key LIKE $${k + 1}`).join(" OR ")} ORDER BY priority, name, id`,
    names.map((n) => `${n.replaceAll("_", "\\_").replaceAll("%", "\\%")}.%`))).rows.map((r) => r.id);
  if (orphans.length) await unlink(env.withContext({ ...env.context, active_test: false, force_delete: true }), "ir.ui.view", orphans);
  // :2659 the constraints (their unlink drops them, below)
  if (constraintIds.length) await del("ir.model.constraint", constraintIds);
  // :2661-2665 the selections that still exist (their unlink applies the values' ondelete)
  if (selectionIds.length) {
    const existing = new Set((await env.cr.query<{ id: number }>("SELECT id FROM ir_model_fields_selection WHERE id = ANY($1::int[])", [selectionIds])).rows.map((r) => r.id));
    const ids = selectionIds.filter((id) => existing.has(id));
    if (ids.length) await del("ir.model.fields.selection", ids);
  }
  // :2666 the fields: the external ids of fields already gone (deleted with their model) first, then the fields
  // but `id` and the log access columns of a model that has them
  if (fieldIds.length) {
    const existing = new Map((await env.cr.query<{ id: number; name: string; model: string }>(
      "SELECT id, name, model FROM ir_model_fields WHERE id = ANY($1::int[])", [fieldIds])).rows.map((f) => [f.id, f]));
    const orphans = moduleData.filter((d) => d.model === "ir.model.fields" && !existing.has(d.res_id)).map((d) => d.id);
    if (orphans.length) await unlink(env.sudo(), "ir.model.data", orphans);
    const ids = fieldIds.filter((id) => {
      const f = existing.get(id);
      return f !== undefined && !(f.name === "id" || (["create_uid", "create_date", "write_uid", "write_date"].includes(f.name) && env.reg.models.get(f.model)?.logAccess));
    });
    if (ids.length) await del("ir.model.fields", ids);
  }
  // :2667-2668 the many2many tables of the modules (ir.model.relation `_module_data_uninstall`, :2245-2271)
  await relationsUninstall(env, names);
  // :2671 the models (their unlink drops their tables, below)
  if (modelIds.length) await del("ir.model", modelIds);
  // :2679-2697 undeletable data whose record has gone in the meantime is removed with the rest
  const remaining = new Set(moduleDataIds);
  for (const id of undeletable) {
    const d = (await env.cr.query<{ model: string; res_id: number }>("SELECT model, res_id FROM ir_model_data WHERE id = $1", [id])).rows[0];
    if (!d || !env.reg.models.has(d.model)) continue;
    const exists = (await env.cr.query(`SELECT 1 FROM "${env.reg.model(d.model).table}" WHERE id = $1`, [d.res_id])).rows.length;
    if (exists) remaining.delete(id);
  }
  if (remaining.size) await unlink(env.sudo(), "ir.model.data", [...remaining]);
}

/** `ir.model.relation._module_data_uninstall` (ir_model.py:2245-2271) of the relations the modules own. */
async function relationsUninstall(env: Environment, names: readonly string[]): Promise<void> {
  const rels = (await env.cr.query<{ id: number; name: string }>(
    `SELECT r.id, r.name FROM ir_model_relation r JOIN ir_module_module m ON m.id = r.module WHERE m.name = ANY($1::varchar[]) ORDER BY r.id`,
    [[...names]])).rows;
  if (!rels.length) return;
  const ids = new Set(rels.map((r) => r.id));
  const toDrop: string[] = [];
  for (const r of [...rels].reverse()) {
    // the table stays while a relation row of another module holds it
    const owners = (await env.cr.query<{ id: number }>("SELECT id FROM ir_model_relation WHERE name = $1", [r.name])).rows;
    if (owners.some((o) => !ids.has(o.id))) continue;
    if ((await env.cr.query("SELECT 1 FROM pg_class WHERE relname = $1 AND relnamespace = current_schema::regnamespace AND relkind IN ('r', 'p')", [r.name])).rows.length
      && !toDrop.includes(r.name)) toDrop.push(r.name);
  }
  await unlink(env, "ir.model.relation", rels.map((r) => r.id));
  for (const t of toDrop) await env.cr.query(`DROP TABLE "${t.replace(/"/g, '""')}" CASCADE`);
}

/** `sql.make_identifier` (tools/sql.py): a name over 63 bytes is shortened with a hash (not ported). */
function pgIdentifier(name: string): string {
  if (new TextEncoder().encode(name).length > 63) throw new NotPorted(`the identifier ${name} (make_identifier of a long name)`);
  return name;
}
const q = (name: string): string => `"${name.replace(/"/g, '""')}"`;

registerOverrides("ir.model.constraint", {
  // ir_model.py:2103-2153 unlink: the constraint or index dropped where no row of another module names it
  unlink: async (env, ids, next) => {
    if (!ids.length) return next(env, ids);
    if (!env.context["force_delete"]) throw new NotPorted("ir.model.constraint.unlink outside a module uninstall");
    const rows = (await env.cr.query<{ id: number; name: string; type: string; model: string }>(
      "SELECT c.id, c.name, c.type, m.model FROM ir_model_constraint c JOIN ir_model m ON m.id = c.model WHERE c.id = ANY($1::int[]) ORDER BY c.id DESC", [[...ids]])).rows;
    const set = new Set(ids);
    for (const c of rows) {
      const table = env.reg.models.get(c.model)?.table ?? c.model.replace(/\./g, "_");
      const owners = (await env.cr.query<{ id: number }>("SELECT id FROM ir_model_constraint WHERE name = $1", [c.name])).rows;
      if (owners.some((o) => !set.has(o.id))) continue;
      const hname = pgIdentifier(c.name);
      if (c.type === "f" || c.type === "u") {
        const types = c.type === "u" ? ["c", "u", "x"] : ["f"];
        const exists = (await env.cr.query(
          `SELECT FROM pg_constraint cs JOIN pg_class cl ON (cs.conrelid = cl.oid)
            WHERE cs.contype = ANY($1::"char"[]) AND cs.conname = $2 AND cl.relname = $3 AND cl.relnamespace = current_schema::regnamespace`,
          [types, hname, table])).rows.length;
        if (exists) await env.cr.query(`ALTER TABLE ${q(table)} DROP CONSTRAINT ${q(hname)}`);
      }
      if (c.type === "i") await env.cr.query(`DROP INDEX IF EXISTS ${q(hname)}`);
    }
    return next(env, ids);
  },
});

registerOverrides("ir.model.fields.selection", {
  // ir_model.py:1964-2058 unlink -> `_process_ondelete`: the values' ondelete applies to the records holding them. The
  // ondelete policies of the registry's fields are not generated: a removed value that records still hold refuses.
  unlink: async (env, ids, next) => {
    if (!ids.length) return next(env, ids);
    const rows = (await env.cr.query<{ id: number; value: string; model: string; name: string }>(
      "SELECT s.id, s.value, f.model, f.name FROM ir_model_fields_selection s JOIN ir_model_fields f ON f.id = s.field_id WHERE s.id = ANY($1::int[])", [[...ids]])).rows;
    for (const r of rows) {
      const def = env.reg.models.get(r.model);
      const field = def?.fields.get(r.name);
      if (!def || !field || !field.store || def.abstract || !["selection", "reference"].includes(field.type)) continue;
      if (field.companyDependent) throw new NotPorted(`the ondelete of ${r.model}.${r.name}'s value ${r.value} (company dependent)`);
      if ((await env.cr.query(`SELECT 1 FROM ${q(def.table)} WHERE ${q(r.name)} = $1 LIMIT 1`, [r.value])).rows.length) {
        throw new NotPorted(`the ondelete of ${r.model}.${r.name}'s value ${r.value}, which records hold`);
      }
    }
    return next(env, ids);
  },
});

registerOverrides("ir.model", {
  // ir_model.py:402-425 unlink, as a module uninstall runs it (force_delete; the registry set up afterwards by the load)
  unlink: async (env, ids, next) => {
    if (!ids.length) return next(env, ids);
    if (!env.context["force_delete"] || !uninstallingModules.has(env.cr)) throw new NotPorted("ir.model.unlink outside a module uninstall");
    const rows = (await env.cr.query<{ id: number; model: string }>("SELECT id, model FROM ir_model WHERE id = ANY($1::int[]) ORDER BY id", [[...ids]])).rows;
    const names = rows.map((r) => r.model);
    // :406-408 `_prepare_update` of their fields writes nothing under force_delete; :411 the fields whose comodel goes
    const rel = (await env.cr.query<{ id: number }>("SELECT id FROM ir_model_fields WHERE relation = ANY($1::varchar[]) ORDER BY id", [names])).rows.map((r) => r.id);
    if (rel.length) await unlink(env, "ir.model.fields", rel);
    // :414-416 the crons of the models
    const crons = (await env.cr.query<{ id: number }>(
      "SELECT c.id FROM ir_cron c JOIN ir_act_server s ON s.id = c.ir_actions_server_id WHERE s.model_id = ANY($1::int[]) ORDER BY c.id", [[...ids]])).rows.map((r) => r.id);
    if (crons.length) await unlink(env.withContext({ ...env.context, active_test: false }), "ir.cron", crons);
    // :419-421 the external ids of their records
    const data = (await env.cr.query<{ id: number }>("SELECT id FROM ir_model_data WHERE model = ANY($1::varchar[]) ORDER BY id", [names])).rows.map((r) => r.id);
    if (data.length) await unlink(env.sudo(), "ir.model.data", data);
    // :344-364 `_drop_table`
    for (const name of names) {
      const def = env.reg.models.get(name);
      if (!def || def.abstract) continue;
      const kind = (await env.cr.query<{ k: string }>("SELECT relkind::text AS k FROM pg_class WHERE relname = $1 AND relnamespace = current_schema::regnamespace", [def.table])).rows[0]?.k;
      if (kind === "v") await env.cr.query(`DROP VIEW ${q(def.table)}`);
      else if (kind === "r") await env.cr.query(`DROP TABLE ${q(def.table)} CASCADE`);
      else if (kind !== undefined) throw new NotPorted(`dropping the table of ${name} (relkind ${kind})`);
    }
    return next(env, ids);
  },
});

/** `module_uninstall` (ir_module.py:506-514) and base_import_module's deletion of imported modules (:395-410). */
async function moduleUninstall(env: Environment, ids: readonly number[]): Promise<void> {
  const rows = (await env.cr.query<{ id: number; name: string; imported: boolean | null }>("SELECT id, name, imported FROM ir_module_module WHERE id = ANY($1::int[]) ORDER BY id", [[...ids]])).rows;
  await moduleDataUninstall(env, rows.map((r) => r.name));
  await write(env.withContext({ ...env.context, prefetch_fields: false }), "ir.module.module", ids, { state: "uninstalled", latest_version: false });
  await recomputeModuleViews(env, ids);
  const imported = rows.filter((r) => r.imported).map((r) => r.id);
  if (imported.length) await unlink(env, "ir.module.module", imported);
}

/** Kept identical to FINGERPRINT_SQL in worker/gen/module_list.py (`%s` there is `$1` here). */
const FINGERPRINT_SQL = `
SELECT md5(COALESCE(string_agg(t.r, E'\\n' ORDER BY t.name), '')) || ':' ||
       (SELECT md5(COALESCE(string_agg(c.id || '|' || COALESCE(c.name::text, '') || '|' || COALESCE(c.parent_id::text, ''), E'\\n' ORDER BY c.id), ''))
          FROM ir_module_category c) || ':' ||
       (SELECT md5(COALESCE(string_agg(d.name || '|' || d.res_id, E'\\n' ORDER BY d.name), ''))
          FROM ir_model_data d WHERE d.module = 'base' AND d.model = 'ir.module.category') AS f
  FROM (SELECT m.name, concat_ws('|', m.name, m.description::text, m.shortdesc::text, m.author, m.maintainer, m.contributors,
                                 m.website, m.license, m.sequence, m.application, m.auto_install, m.icon, m.summary::text, m.url,
                                 m.to_buy, m.iap_paid_service, m.state = 'uninstallable', m.category_id,
               (SELECT string_agg(d.name || ':' || COALESCE(d.auto_install_required::text, ''), ',' ORDER BY d.name)
                  FROM ir_module_module_dependency d WHERE d.module_id = m.id),
               (SELECT string_agg(c.code, ',' ORDER BY c.code) FROM module_country r JOIN res_country c ON c.id = r.country_id
                 WHERE r.module_id = m.id),
               (SELECT string_agg(e.name, ',' ORDER BY e.name) FROM ir_module_module_exclusion e WHERE e.module_id = m.id)) AS r
          FROM ir_module_module m WHERE m.name = ANY($1)) t
`;

/**
 * Whether the database's module records are those update_list was generated on (FINGERPRINT_SQL against
 * gen/out/poc_erp/module_list.json): the test behind updateListAfterReload's refusal, so every install, upgrade and
 * uninstall refuses where this is false. Apps (src/modules/apps_visible.ts) offers no install there.
 */
export async function moduleRecordsMatch(env: Environment, data?: ModuleList): Promise<boolean> {
  data ??= (await import("../../gen/out/poc_erp/module_list.json")).default as unknown as ModuleList;
  const f = (await env.cr.query<{ f: string }>(FINGERPRINT_SQL, [data.modules])).rows[0]?.f;
  return f === data.fingerprint;
}

/**
 * The registry reload after the module operation (`Registry.new(update_module=True)`, ir_module.py:638 ->
 * modules/loading.py:400-403) runs `update_list()` (ir_module.py:796-830) as the superuser: every module with a
 * manifest on disk gets `_update_from_terp`, whose `country_ids` assignment (:855-866) writes the record even when its
 * countries are unchanged. The modules and the state update_list compares with the manifests come from
 * worker/gen/module_list.py (gen/out/poc_erp/module_list.json, checked there to change nothing else): while the
 * fingerprint of that state is the template's, only `write_date`/`write_uid` change; otherwise (another template, module
 * records written since) this refuses.
 */
export async function updateListAfterReload(env: Environment, uid = 1, fullRegistry = false): Promise<[number, number]> {
  const data = (await import("../../gen/out/poc_erp/module_list.json")).default as unknown as ModuleList;
  if (!(await moduleRecordsMatch(env, data))) throw new NotPorted("update_list after a module operation: the module records differ from the generated manifests (gen/module_list.py)");
  // :819-824 the modules on disk without a record (the vendored OCA modules, B6): created as Odoo's update_list
  // creates them (gen/module_list.py `new`); one created before must still be as created
  let added = 0;
  const news = Object.keys(data.new ?? {}).sort();
  for (const name of news) {
    const n = data.new![name]!;
    // in the registry reload only base's fields are set (loading.py:400): other modules' defaults are not applied
    const cols = Object.keys(n.row).filter((c) => fullRegistry || !(data.reload_without ?? []).includes(c)).sort();
    const existing = (await env.cr.query<Record<string, unknown>>(`SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM ir_module_module WHERE name = $1`, [name])).rows[0];
    if (existing) {
      const kept = cols.filter((c) => !CHANGING.has(c));
      // a record created in an install's registry reload has no value in the columns of other modules' fields
      // (reload_without: base_import_module's module_type, imported), and update_list does not write them since
      // (get_values_from_terp has neither): NULL there is as created too
      const created = (c: string) => [JSON.stringify(n.row[c] ?? null), ...((data.reload_without ?? []).includes(c) ? ["null"] : [])];
      const differs = kept.filter((c) => !created(c).includes(JSON.stringify(existing[c] ?? null)));
      if (differs.length) throw new NotPorted(`update_list: the record of ${name} differs from its manifest (${differs.join(", ")})`);
      continue;
    }
    const values = cols.map((c) => (n.row[c] !== null && typeof n.row[c] === "object" ? JSON.stringify(n.row[c]) : n.row[c]));
    const id = (await env.cr.query<{ id: number }>(
      `INSERT INTO ir_module_module (${cols.map((c) => `"${c}"`).join(", ")}, create_uid, write_uid, create_date, write_date)
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}, $${cols.length + 1}, $${cols.length + 1}, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC') RETURNING id`,
      [...values, uid])).rows[0]!.id;
    for (const x of n.xmlids) {
      await env.cr.query(`INSERT INTO ir_model_data (create_date, create_uid, model, module, name, noupdate, res_id, write_date, write_uid)
        VALUES (now() AT TIME ZONE 'UTC', $1, $2, $3, $4, $5, $6, now() AT TIME ZONE 'UTC', $1)`, [uid, x.model, x.module, x.name, x.noupdate, id]);
    }
    for (const d of n.dependencies) await env.cr.query("INSERT INTO ir_module_module_dependency (auto_install_required, module_id, name) VALUES ($1, $2, $3)", [d.auto_install_required, id, d.name]);
    if (n.countries.length) await env.cr.query("INSERT INTO module_country (module_id, country_id) SELECT $1, id FROM res_country WHERE code = ANY($2::varchar[])", [id, n.countries]);
    for (const x of n.exclusions) await env.cr.query("INSERT INTO ir_module_module_exclusion (module_id, name) VALUES ($1, $2)", [id, x]);
    added++;
  }
  // :826 `_update_from_terp` of every module: `country_ids` assigned, a write even when unchanged
  await env.cr.query("UPDATE ir_module_module SET write_uid = $2, write_date = now() AT TIME ZONE 'UTC' WHERE name = ANY($1)", [[...data.modules, ...news], uid]);
  // :812-813 the first count: the known modules whose manifest version is above their latest_version (1.0 when none)
  const latest = new Map((await env.cr.query<{ name: string; v: string | null }>(
    "SELECT name, latest_version AS v FROM ir_module_module WHERE name = ANY($1)", [data.modules])).rows.map((r) => [r.name, r.v]));
  let updated = 0;
  for (const name of data.modules) if (versionAbove(data.versions?.[name] ?? null, latest.get(name) ?? null)) updated++;
  return [updated, added];
}

/** The columns a module's install changes (not compared with the manifest's values). */
const CHANGING = new Set(["state", "demo", "latest_version", "menus_by_module", "views_by_module", "reports_by_module"]);

interface ModuleList {
  modules: string[];
  fingerprint: string;
  new?: Record<string, { row: Record<string, unknown>; xmlids: { model: string; module: string; name: string; noupdate: boolean }[];
    dependencies: { name: string; auto_install_required: boolean }[]; countries: string[]; exclusions: string[] }>;
  versions?: Record<string, string | null>;
  reload_without?: string[];
}

/** `parse_version(version) > parse_version(latest or adapt_version('1.0'))` (tools/parse_version.py), dotted numbers. */
function versionAbove(version: string | null, latest: string | null): boolean {
  const parse = (v: string): number[] => {
    if (!/^[0-9]+([.][0-9]+)*$/.test(v)) throw new NotPorted(`update_list: the version ${v} (parse_version of a non-numeric version)`);
    const parts = v.split(".").map(Number);
    while (parts.length > 1 && parts[parts.length - 1] === 0) parts.length -= 1;
    return parts;
  };
  const a = parse(version ?? "20.0.1.0"), b = parse(latest ?? "20.0.1.0");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** `update_list` (ir_module.py:794-830) from the Apps menu ("Update Apps List"): `[updated, added]`. */
registerMethod("ir.module.module", "update_list", async (env) => {
  await assertAdmin(env);
  return updateListAfterReload(env, env.uid, true);
}, { apiModel: true });

/**
 * base_module_update.py:12-20 `update_module`, the "Update Apps List" wizard the Apps menu opens: `update_list`, the
 * manifest terms of the uninstalled modules in the languages of base.group_system's users (all_user_ids: through the
 * implying groups, archived users too), then the wizard's counts. ir_module.py:1011-1012 returns at once for no
 * language or a single en_US/en; en_US has no manifest translations to write, so a list of only en_US/en (or no lang)
 * is no write either; another language would read the modules' .po files: refused.
 */
registerMethod("base.module.update", "update_module", async (env, ids) => {
  const recs = [...(ids ?? [])];
  // models.py ensure_one: ValueError("Expected singleton: ...") (refused, as elsewhere in the port)
  if (recs.length !== 1) throw new NotPorted(`ensure_one on base.module.update(${recs.join(", ")})`);
  await assertAdmin(env);
  const [updated, added] = await updateListAfterReload(env, env.uid, true) as [number, number];
  const langs = (await env.cr.query<{ lang: string | null }>(
    `WITH RECURSIVE g(id) AS (
       SELECT res_id FROM ir_model_data WHERE module = 'base' AND name = 'group_system' AND model = 'res.groups'
       UNION SELECT r.gid FROM res_groups_implied_rel r JOIN g ON g.id = r.hid)
     SELECT DISTINCT p.lang FROM res_groups_users_rel gu JOIN g ON g.id = gu.gid
       JOIN res_users u ON u.id = gu.uid JOIN res_partner p ON p.id = u.partner_id`)).rows.map((r) => r.lang);
  const other = langs.filter((l) => l && l !== "en_US" && l !== "en");
  if (other.length) throw new NotPorted(`update_module: the manifest terms of the uninstalled modules in ${other.join(", ")} (_load_non_installed_modules_manifest_terms)`);
  await write(env, "base.module.update", recs, { updated, added, state: "done" });
  return null;
}, { apiModel: false });

/** base_module_update.py:22-31 `action_module_open` (the wizard's Open Apps button): the modules' list action. */
registerMethod("base.module.update", "action_module_open", async () => ({
  domain: "[]", name: "Modules", view_mode: "list,form", res_model: "ir.module.module", view_id: false, type: "ir.actions.act_window",
}), { apiModel: false, readonly: true });

/** `button_immediate_uninstall` (ir_module.py:667-674 -> `_button_immediate_function` :608-665). */
async function buttonImmediateUninstall(env: Environment, ids: readonly number[]): Promise<Record<string, unknown>> {
  await assertAdmin(env);
  const toRemove = await buttonUninstall(env, ids);
  // the registry reload (loading.py:519-538): modules with Python code would need their hooks, schema and models
  const rows = (await env.cr.query<{ id: number; name: string; imported: boolean | null }>("SELECT id, name, imported FROM ir_module_module WHERE state = 'to remove'")).rows;
  const withCode = rows.filter((r) => !r.imported).map((r) => r.name);
  void toRemove;
  if (withCode.length) {
    // loading.py:519-538 with the registry of the modules still loaded: their uninstall hooks, `module_uninstall`, then
    // the registry loaded again without them. Their code must be in the bundle (an overlay template's) and have no hook.
    const template = await templateOf(env.cr);
    if (!template.overlay) throw new NotPorted(`uninstalling ${withCode.join(", ")} from ${template.name}: the template has no overlay of its modules`);
    const files = await genAssetJson(`${template.overlay}/module_files.json`) as Record<string, { manifest: Record<string, unknown> }>;
    for (const name of withCode) {
      const man = files[name]?.manifest;
      if (!man) throw new NotPorted(`uninstalling ${name}: its manifest is not in ${template.overlay}`);
      if (man["uninstall_hook"]) throw new NotPorted(`uninstalling ${name}: its uninstall hook (Python)`);
    }
    await updateListAfterReload(env);
    uninstallingModules.add(env.cr);
    try {
      await moduleUninstall(env, rows.map((r) => r.id));
    } finally {
      uninstallingModules.delete(env.cr);
    }
    // the registry of the remaining modules (`Registry.new` once more, loading.py:536-538): update_list, then the
    // models to check reflected again (:540-555), as the build captured it (gen/install_capture.py --uninstall)
    registryChanged(env.cr);
    await reloadRegistryOf(env.cr, env.lang);
    await updateListAfterReload(env);
    let cap: Capture;
    try {
      // named after the modules the user uninstalls (gen/install_capture.py --uninstall <module ...>)
      const clicked = (await env.cr.query<{ name: string }>("SELECT name FROM ir_module_module WHERE id = ANY($1::int[]) ORDER BY name", [[...ids]])).rows.map((r) => r.name);
      cap = await genAssetJson(`${template.overlay}/uninstall/${clicked.join("+")}.json`) as Capture;
    } catch (e) {
      if (e instanceof NotPorted) throw new NotPorted(`uninstalling ${withCode.join(", ")}: no capture of its uninstall in ${template.overlay}`);
      throw e;
    }
    await replayPhase(env.withUser(1).sudo(), cap, "end");
  } else {
    await moduleUninstall(env, rows.map((r) => r.id));
    await updateListAfterReload(env);
  }
  // `next()` (:591-606): an open ir.actions.todo is launched, else /odoo
  if ((await env.cr.query("SELECT 1 FROM ir_actions_todo WHERE state = 'open' LIMIT 1")).rows.length) throw new NotPorted("ir.actions.todo action_launch after a module operation");
  return { type: "ir.actions.act_url", target: "self", url: "/odoo" };
}

registerMethod("ir.module.module", "button_uninstall_wizard", async (env, ids) => {
  await assertAdmin(env);
  return {
    type: "ir.actions.act_window", target: "new", name: env.lang && env.lang !== "en_US" ? await (async () => { throw new NotPorted(`translated "Uninstall module" (${env.lang})`); })() : "Uninstall module",
    view_mode: "form", res_model: "base.module.uninstall", context: { default_module_ids: [...(ids ?? [])] },
  };
}, { apiModel: false });

registerMethod("ir.module.module", "button_immediate_uninstall", async (env, ids) => buttonImmediateUninstall(env, ids ?? []), { apiModel: false });

registerMethod("base.module.uninstall", "action_uninstall", async (env, ids) => {
  const moduleIds = (await env.cr.query<{ id: number }>(
    `SELECT r.ir_module_module_id AS id FROM base_module_uninstall_ir_module_module_rel r WHERE r.base_module_uninstall_id = ANY($1::int[]) ORDER BY r.ir_module_module_id`, [[...(ids ?? [])]])).rows.map((r) => r.id);
  return buttonImmediateUninstall(env, moduleIds);
}, { apiModel: false });
