import { strict as assert } from "node:assert";
import { test } from "node:test";
import { appsInstallableOnly, installTarget, visibleModuleIds, visibleModules, type ModuleInfo } from "./apps_visible";
import type { Environment } from "../orm/types";

function mod(id: number, name: string, state: string, deps: (string | [string, true])[] = [], extra: Partial<ModuleInfo> = {}): ModuleInfo {
  return { id, name, state, autoInstall: false, imported: false, countries: [],
    deps: deps.map((d) => typeof d === "string" ? { name: d, autoRequired: false } : { name: d[0], autoRequired: true }), ...extra };
}

// a poc_erp_lunch-like site: base, mail, stock and account installed; the bundle serves base+lunch, base+maintenance
// (with its auto_install bridge to stock) and base+fleet (with account_fleet)
const MODS = new Map<string, ModuleInfo>([
  mod(1, "base", "installed"),
  mod(2, "mail", "installed", ["base"]),
  mod(3, "stock", "installed", ["mail"]),
  mod(4, "account", "installed", ["mail"]),
  mod(5, "lunch", "uninstalled", ["mail"]),
  mod(6, "maintenance", "uninstalled", ["mail"]),
  mod(7, "stock_maintenance", "uninstalled", [["maintenance", true], ["stock", true]], { autoInstall: true }),
  mod(8, "fleet", "uninstalled", ["mail"]),
  mod(9, "account_fleet", "uninstalled", [["fleet", true], ["account", true]], { autoInstall: true }),
  mod(10, "crm", "uninstalled", ["mail"]),
  mod(11, "broken", "uninstalled", ["not_in_the_system"]),
  mod(12, "l10n_zz", "uninstalled", [["account", true]], { autoInstall: true, countries: [99] }),
  mod(13, "theme_x", "uninstallable", ["base"]),
  mod(14, "imported_data", "installed", ["base"], { imported: true }),
  mod(15, "fleet_extra", "uninstalled", ["fleet", "crm"]),
].map((m) => [m.name, m]));
const INSTALLED = ["account", "base", "mail", "stock"];
const SERVED = [[...INSTALLED, "lunch"], [...INSTALLED, "maintenance", "stock_maintenance"], [...INSTALLED, "account_fleet", "fleet"]]
  .map((s) => [...s].sort().join(","));

test("install target: dependencies, then auto_install modules whose required dependencies are all installed", () => {
  const companies = new Set([46]);
  assert.deepEqual(installTarget(MODS, companies, "lunch"), [...INSTALLED, "lunch"].sort());
  assert.deepEqual(installTarget(MODS, companies, "stock_maintenance"), [...INSTALLED, "maintenance", "stock_maintenance"].sort());
  assert.deepEqual(installTarget(MODS, companies, "fleet"), [...INSTALLED, "account_fleet", "fleet"].sort());
  assert.deepEqual(installTarget(MODS, companies, "fleet_extra"), [...INSTALLED, "account_fleet", "crm", "fleet", "fleet_extra"].sort());
  assert.equal(installTarget(MODS, companies, "broken"), null);
  // an auto_install module with countries comes only with a company in one of them (ir_module.py:430-436)
  assert.deepEqual(installTarget(MODS, new Set([99]), "lunch"), [...INSTALLED, "lunch"].sort());
});

test("Apps shows the installed modules and those whose install ends on a served set, nothing else", async () => {
  const candidates = new Set([...MODS.keys()]);
  const asked: string[] = [];
  const shown = await visibleModules(MODS, new Set([46]), candidates, async (t) => { asked.push(t.join(",")); return SERVED.includes(t.join(",")); });
  assert.deepEqual([...shown].sort(), ["account", "account_fleet", "base", "fleet", "imported_data", "lunch", "mail", "maintenance", "stock",
    "stock_maintenance"]);
  // one question per distinct target (fleet and account_fleet, maintenance and stock_maintenance share theirs)
  assert.equal(asked.length, new Set(asked).size);
  // modules of no template are not even simulated
  const few = await visibleModules(MODS, new Set([46]), new Set(["lunch"]), async (t) => SERVED.includes(t.join(",")));
  assert.deepEqual([...few].sort(), ["account", "base", "imported_data", "lunch", "mail", "stock"]);
});

test("the setting: a regex of databases, off when unset or empty", () => {
  assert.equal(appsInstallableOnly(undefined, "odoo_db"), false);
  assert.equal(appsInstallableOnly("", "odoo_db"), false);
  assert.equal(appsInstallableOnly("^odoo_db$", "odoo_db"), true);
  assert.equal(appsInstallableOnly("^odoo_db$", "odoo_db_copy"), false);
  assert.equal(appsInstallableOnly("^odoo_db$", null), false);
});

test("a database whose module records are not the captures' base (a language added since) offers no install", async () => {
  const data = (await import("../../gen/out/poc_erp/module_list.json")).default as unknown as { fingerprint: string };
  const rows = [...MODS.values()].map((m) => ({ id: m.id, name: m.name, state: m.state, auto_install: m.autoInstall, imported: m.imported }));
  const deps = [...MODS.values()].flatMap((m) => m.deps.map((d) => ({ module_id: m.id, name: d.name, auto: d.autoRequired })));
  const run = async (fingerprint: string) => {
    const asked: string[] = [];
    const env = {
      cache: new Map<string, unknown>(),
      cr: {
        query: async (sql: string) => ({
          rows: sql.includes("md5(") ? [{ f: fingerprint }]
            : sql.includes("FROM ir_module_module_dependency") ? deps
            : sql.includes("FROM ir_module_module m ORDER BY id") ? rows : [],
        }),
      },
    } as unknown as Environment;
    const ids = await visibleModuleIds(env, async (t) => { asked.push(t.join(",")); return SERVED.includes(t.join(",")); });
    return { names: ids.map((id) => [...MODS.values()].find((m) => m.id === id)!.name).sort(), asked };
  };
  const installed = ["account", "base", "imported_data", "mail", "stock"];
  // the captures' base: the installs the bundle serves are offered
  const same = await run(data.fingerprint);
  assert.ok(same.names.includes("lunch") && same.names.includes("fleet"));
  // Swedish added: its terms in ir_module_module change the fingerprint, update_list would refuse every install
  const other = await run("not-the-fingerprint");
  assert.deepEqual(other.names, installed);
  assert.equal(other.asked.length, 0);
});

test("a database with an app installed (an overlay template's modules) offers no second install", async () => {
  const data = (await import("../../gen/out/poc_erp/module_list.json")).default as unknown as { fingerprint: string };
  const templates = (await import("../../gen/out/templates.json")).default as unknown as Record<string, { modules: string[] }>;
  const run = async (installed: string[]) => {
    const names = new Set([...installed, "fleet", "account_fleet", "lunch", "maintenance", "stock_maintenance"]);
    const rows = [...names].map((name, i) => ({ id: i + 1, name, state: installed.includes(name) ? "installed" : "uninstalled", auto_install: false, imported: false }));
    const env = {
      cache: new Map<string, unknown>(),
      cr: { query: async (sql: string) => ({ rows: sql.includes("md5(") ? [{ f: data.fingerprint }] : sql.includes("FROM ir_module_module m ORDER BY id") ? rows : [] }) },
    } as unknown as Environment;
    const ids = await visibleModuleIds(env, async () => true);
    return rows.filter((r) => ids.includes(r.id) && r.state === "uninstalled").map((r) => r.name).sort();
  };
  // on the base template every app the bundle serves is offered
  assert.ok((await run(templates["poc_erp"]!.modules)).includes("lunch"));
  // with Fleet installed (poc_erp_fleet's modules), none
  assert.deepEqual(await run(templates["poc_erp_fleet"]!.modules), []);
});
