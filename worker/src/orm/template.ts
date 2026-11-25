/**
 * Which corpus template a database was copied from, for the generated data that depends on the installed module
 * set (gen/out/models.json, translations, precompiled bundles); imported data modules do not count: S1 runs on poc_corpus copies (gen/out/), C1 on
 * poc_erp copies (gen/out/poc_erp/). gen/templates.py records each template's `ir_module_module` installed names
 * (Odoo's registry `_init_modules`, odoo/odoo/modules/loading.py); a database is matched by that exact set.
 * A database matching no template raises NotPorted: its Python metadata was never generated.
 */
import type { Cursor } from "../db";
import { NotPorted } from "../errors";
import { onRegistryChange } from "./signaling";

export interface TemplateInfo {
  /** Template name (poc_corpus, poc_erp). */
  readonly name: string;
  /** Subdirectory of gen/out holding its outputs ("" for poc_corpus). */
  readonly dir: string;
  /** A template that is `dir`'s plus installed modules: the subdirectory of its overlay (src/orm/overlay.ts). */
  readonly overlay?: string;
  /**
   * VAGB B0: during an install, the module of the overlay's install whose data is loading, when it is not the graph's
   * last: its registry is the one after that module (gen/install_capture.py install_steps.json, src/orm/overlay.ts),
   * not the template's. The compiled keys still serve the template (`name`).
   */
  readonly step?: string;
}

/** The key of a template's generated data in a cache: its name, and the install step it is pinned at. */
export function templateKey(t: TemplateInfo): string {
  return t.step ? `${t.name}@${t.step}` : t.name;
}

let index: Promise<ReadonlyMap<string, TemplateInfo>> | null = null;

function loadIndex(): Promise<ReadonlyMap<string, TemplateInfo>> {
  index ??= import("../../gen/out/templates.json").then((mod) => {
    const raw: unknown = mod.default;
    const out = new Map<string, TemplateInfo>();
    if (typeof raw !== "object" || raw === null) return out;
    for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const modules = e["modules"];
      if (!Array.isArray(modules)) continue;
      const overlay = typeof e["overlay"] === "string" ? { overlay: e["overlay"] } : {};
      out.set(modules.map(String).sort().join(","), { name, dir: typeof e["dir"] === "string" ? e["dir"] : "", ...overlay });
    }
    return out;
  });
  return index;
}

/** A template's installed modules (gen/out/templates.json), or null for an unknown name. */
export async function templateModules(name: string): Promise<string[] | null> {
  for (const [key, info] of await loadIndex()) if (info.name === name) return key ? key.split(",") : [];
  return null;
}

/** Every module of some template (gen/out/templates.json): the only modules an install can end on a template with. */
export async function templateModuleNames(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const key of (await loadIndex()).keys()) for (const m of key ? key.split(",") : []) out.add(m);
  return out;
}

/** The template whose installed modules are exactly `modules` (imported data modules left out), or null. */
export async function templateForModules(modules: Iterable<string>): Promise<TemplateInfo | null> {
  return (await loadIndex()).get([...modules].sort().join(",")) ?? null;
}

const byDb = new Map<string, Promise<TemplateInfo>>();
const MAX_DBS = 32;
onRegistryChange((db) => byDb.delete(db));

/**
 * During a module install (src/modules/install.ts) the database's registry is the new module set's before the new
 * modules are 'installed' (Odoo loads a module's code before its data): the template is set for the rest of the
 * transaction. A rollback forgets it with the rest of the registry state (src/orm/signaling.ts).
 */
export function pinTemplate(db: string, template: TemplateInfo): void {
  byDb.set(db, Promise.resolve(template));
}

/** The template of the cursor's database, cached per database name until its registry changes (src/orm/signaling.ts). */
export function templateOf(cr: Cursor): Promise<TemplateInfo> {
  const cached = byDb.get(cr.db);
  if (cached !== undefined) return cached;
  const p = (async () => {
    // imported data modules have no Python code and are not loaded into the registry (base_import_module
    // ir_module.py `_get_modules_to_load_domain`: imported = False); `imported` only exists with that module
    const res = await cr.query<{ name: string }>(
      `SELECT name FROM ir_module_module m WHERE state = 'installed'
          AND NOT COALESCE((to_jsonb(m) ->> 'imported')::boolean, false) ORDER BY name`);
    const key = res.rows.map((r) => r.name).sort().join(",");
    const info = (await loadIndex()).get(key);
    if (info === undefined) throw new NotPorted(`generated metadata for database ${cr.db}: its installed modules match no template in gen/out/templates.json`);
    return info;
  })();
  p.catch(() => byDb.delete(cr.db));
  byDb.set(cr.db, p);
  while (byDb.size > MAX_DBS) {
    const oldest = byDb.keys().next().value;
    if (oldest === undefined) break;
    byDb.delete(oldest);
  }
  return p;
}
