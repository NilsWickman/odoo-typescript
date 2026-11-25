/**
 * D25: on the site, Apps lists only the modules the site can serve. A deliberate deviation from Odoo, off unless the
 * Worker's APPS_INSTALLABLE_DBS (deploy.sh) matches the request's database, so local proof runs and the harness's
 * copies on the site see every module of Odoo and OCA, as the oracle.
 *
 * Shown: every module that is not `uninstalled`/`uninstallable` (installed, to install, to upgrade, to remove), and
 * every uninstalled module whose install (`button_install`: its dependencies, then the auto_install modules, as
 * src/modules/install.ts) ends on a module set that this Worker serves: a template of gen/out/templates.json whose
 * compiled build is in the bundle (src/orm/builds.ts, the same test as the install's refusal, which stays behind
 * it). Hidden everywhere the client lists modules: the rule is a `_search` domain (src/orm/hooks.ts searchDomain), so
 * search, search_count, read_group, name_search and the search panel's counters all see it; the search panel's
 * categories are restricted in src/models/ir_module_panel.ts. Superuser searches (the install's own) are not
 * restricted.
 *
 * A database whose module records are not those of the install captures' base (a language added since the template:
 * its terms in ir_module_module and ir_module_category, results/demo-explore-apps-poweruser.md class A) shows no
 * uninstalled module at all: every install would refuse in update_list (src/modules/uninstall.ts moduleRecordsMatch,
 * the same test), so Apps does not offer one. Nor does a database where an app is installed already (its modules are
 * an overlay template's): every install capture starts from the base template (gen/install_capture.py), so a second
 * app, even one whose module set a template has (poc_erp_site1 is Maintenance and Partner Title installed together),
 * would refuse in the install (`captureDiffers`). A new copy of the template offers them all again.
 */
import { and, cond } from "../orm/domain";
import { registerHooks } from "../orm/hooks";
import { buildMissing } from "../orm/builds";
import { templateForModules, templateModuleNames } from "../orm/template";
import type { Domain, Environment } from "../orm/types";

/** env.cache key: whether the request's database shows only installable modules (set with the PDF engine's). */
export const APPS_INSTALLABLE_KEY = "apps.installable_only";

/** Whether `db` matches the Worker's APPS_INSTALLABLE_DBS (a regex; unset = off, Odoo's Apps). */
export function appsInstallableOnly(dbs: string | undefined, db: string | null): boolean {
  return !!dbs && db !== null && new RegExp(dbs).test(db);
}

export function appsRestricted(env: Environment): boolean {
  return !env.su && env.cache.get(APPS_INSTALLABLE_KEY) === true;
}

const INSTALL_STATES = new Set(["installed", "to install", "to upgrade"]);

export interface ModuleInfo {
  readonly id: number;
  readonly name: string;
  readonly state: string;
  readonly autoInstall: boolean;
  /** base_import_module's data modules: not part of a template's module set (src/orm/template.ts). */
  readonly imported: boolean;
  /** module_country: an auto_install module restricted to these countries (ir_module.py:430-436). */
  readonly countries: readonly number[];
  readonly deps: readonly { readonly name: string; readonly autoRequired: boolean }[];
}

/**
 * The module set (names, imported modules left out) after `button_install` of `name` (ir_module.py:406-447 as
 * src/modules/install.ts buttonInstall), or null when the install fails (a dependency that is not in the system).
 */
export function installTarget(mods: ReadonlyMap<string, ModuleInfo>, companyCountries: ReadonlySet<number>, name: string): string[] | null {
  const state = new Map<string, string>([...mods].map(([n, m]) => [n, m.state]));
  // `_state_update(mods, 'to install', ['uninstalled'])` (:376-404): the dependencies first, then the module
  const mark = (n: string, level: number): boolean => {
    if (level < 1) return false;
    if (state.get(n) !== "uninstalled") return true;
    for (const d of mods.get(n)!.deps) {
      if (!mods.has(d.name)) return false; // "the latter module is not available in your system"
      if (state.get(d.name) !== "to install" && !mark(d.name, level - 1)) return false;
    }
    if (state.get(n) === "uninstalled") state.set(n, "to install");
    return true;
  };
  let next = [name];
  while (next.length) {
    for (const n of next) if (!mark(n, 100)) return null;
    next = [];
    for (const m of mods.values()) {
      if (state.get(m.name) !== "uninstalled" || !m.autoInstall) continue;
      const states = new Set(m.deps.filter((d) => d.autoRequired).map((d) => state.get(d.name) ?? "unknown"));
      if (![...states].every((s) => INSTALL_STATES.has(s)) || !states.has("to install")) continue;
      if (m.countries.length && !m.countries.some((c) => companyCountries.has(c))) continue;
      next.push(m.name);
    }
  }
  return [...mods.values()].filter((m) => INSTALL_STATES.has(state.get(m.name)!) && !m.imported).map((m) => m.name).sort();
}

/** The names of the modules Apps shows (see the head of this file). `serves` tells whether a module set is served. */
export async function visibleModules(mods: ReadonlyMap<string, ModuleInfo>, companyCountries: ReadonlySet<number>,
  candidates: ReadonlySet<string>, serves: (modules: string[]) => Promise<boolean>): Promise<Set<string>> {
  const out = new Set<string>();
  const seen = new Map<string, boolean>();
  for (const m of mods.values()) {
    if (m.state !== "uninstalled" && m.state !== "uninstallable") { out.add(m.name); continue; }
    if (m.state !== "uninstalled" || !candidates.has(m.name)) continue;
    const target = installTarget(mods, companyCountries, m.name);
    if (target === null) continue;
    const key = target.join(",");
    let ok = seen.get(key);
    if (ok === undefined) seen.set(key, ok = await serves(target));
    if (ok) out.add(m.name);
  }
  return out;
}

async function loadModules(env: Environment): Promise<{ mods: Map<string, ModuleInfo>; countries: Set<number> }> {
  const rows = (await env.cr.query<{ id: number; name: string; state: string; auto_install: boolean | null; imported: boolean | null }>(
    `SELECT id, name, state, auto_install, COALESCE((to_jsonb(m) ->> 'imported')::boolean, false) AS imported
       FROM ir_module_module m ORDER BY id`)).rows;
  const deps = (await env.cr.query<{ module_id: number; name: string; auto: boolean | null }>(
    "SELECT module_id, name, auto_install_required AS auto FROM ir_module_module_dependency ORDER BY id")).rows;
  const mc = (await env.cr.query<{ module_id: number; c: number }>("SELECT module_id, country_id AS c FROM module_country")).rows;
  const countries = new Set((await env.cr.query<{ c: number }>(
    "SELECT DISTINCT country_id AS c FROM res_company c JOIN res_partner p ON p.id = c.partner_id WHERE country_id IS NOT NULL")).rows.map((r) => r.c));
  const depsOf = new Map<number, { name: string; autoRequired: boolean }[]>();
  for (const d of deps) {
    const l = depsOf.get(d.module_id) ?? [];
    l.push({ name: d.name, autoRequired: !!d.auto });
    depsOf.set(d.module_id, l);
  }
  const countriesOf = new Map<number, number[]>();
  for (const r of mc) countriesOf.set(r.module_id, [...(countriesOf.get(r.module_id) ?? []), r.c]);
  const mods = new Map<string, ModuleInfo>();
  for (const r of rows) {
    mods.set(r.name, { id: r.id, name: r.name, state: r.state, autoInstall: !!r.auto_install, imported: !!r.imported,
      countries: countriesOf.get(r.id) ?? [], deps: depsOf.get(r.id) ?? [] });
  }
  return { mods, countries };
}

const VISIBLE_KEY = "apps.visible_ids";

/** Whether this Worker serves a module set: a template whose compiled build is in the bundle. */
async function served(target: string[]): Promise<boolean> {
  const t = await templateForModules(target);
  return t !== null && !buildMissing(t.name);
}

/** The ids of the modules Apps shows in the request's database, once per request. */
export async function visibleModuleIds(env: Environment, serves: (modules: string[]) => Promise<boolean> = served): Promise<number[]> {
  const cached = env.cache.get(VISIBLE_KEY) as number[] | undefined;
  if (cached !== undefined) return cached;
  const { mods, countries } = await loadModules(env);
  // no install is offered where update_list would refuse it (see the head of this file)
  // (imported here: uninstall.ts -> install.ts -> ... reach this module's hooks at load, a cycle at module evaluation)
  const { moduleRecordsMatch } = await import("./uninstall");
  const installed = [...mods.values()].filter((m) => INSTALL_STATES.has(m.state) && !m.imported).map((m) => m.name);
  const onBase = !(await templateForModules(installed))?.overlay;
  const candidates = onBase && await moduleRecordsMatch(env) ? await templateModuleNames() : new Set<string>();
  const names = await visibleModules(mods, countries, candidates, serves);
  const ids = [...names].map((n) => mods.get(n)!.id).sort((a, b) => a - b);
  env.cache.set(VISIBLE_KEY, ids);
  return ids;
}

registerHooks("ir.module.module", {
  searchDomain: async (env: Environment, domain: Domain): Promise<Domain> =>
    appsRestricted(env) ? and([cond("id", "in", await visibleModuleIds(env)), domain]) : domain,
});
