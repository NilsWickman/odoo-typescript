/**
 * ir.module.module `installed_version` (odoo/odoo/addons/base/models/ir_module.py:216-220 `_get_latest_version`):
 * the manifest version (`get_module_info(name).get('version', adapt_version('1.0'))`), from
 * src/models/module_versions.json (generated with Odoo's Manifest by src/models/gen_module_versions.py).
 */
import { NotPorted } from "../errors";
import { defineComputes } from "./tail_util";

let VERSIONS: Promise<Readonly<Record<string, string | null>>> | null = null;
function versions(): Promise<Readonly<Record<string, string | null>>> {
  VERSIONS ??= import("./module_versions.json").then((m) => m.default as Readonly<Record<string, string | null>>);
  return VERSIONS;
}

/** module.py:579 adapt_version('1.0') for the 20.0 series. */
const DEFAULT_VERSION = "20.0.1.0";

defineComputes("ir.module.module", {
  installed_version: async (env, rec) => {
    // base_import_module ir_module.py `_get_latest_version`: an imported module's version is its latest_version
    if (rec.id !== null) {
      const imp = (await env.cr.query<{ v: string | null }>(
        "SELECT CASE WHEN (to_jsonb(m) ->> 'imported')::boolean THEN latest_version END AS v FROM ir_module_module m WHERE id = $1", [rec.id])).rows[0]?.v;
      if (imp) return imp;
    }
    const name = await rec.get("name");
    if (typeof name !== "string") return DEFAULT_VERSION;
    const table = await versions();
    if (!(name in table)) throw new NotPorted(`ir.module.module manifest of ${name} (not in module_versions.json)`);
    // no manifest (`or {}`): the default version
    return table[name] ?? DEFAULT_VERSION;
  },
});
