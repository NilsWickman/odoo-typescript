/**
 * Installed module names of the request's database (`ir_module_module.state = 'installed'`, the registry's
 * `_init_modules`, odoo/odoo/modules/loading.py), for overrides that only exist when a module is installed
 * (e.g. http_routing's `get_frontend_session_info`, portal's `frontend_layout`). Cached per database name until its
 * registry changes (a module install, src/orm/signaling.ts `onRegistryChange`).
 */
import type { Cursor } from "../db";
import { onRegistryChange } from "../orm/signaling";

const cache = new Map<string, Promise<ReadonlySet<string>>>();
onRegistryChange((db) => cache.delete(db));

export function installedModules(cr: Cursor): Promise<ReadonlySet<string>> {
  let p = cache.get(cr.db);
  if (p === undefined) {
    p = cr.query<{ name: string }>("SELECT name FROM ir_module_module WHERE state = 'installed'")
      .then((r) => new Set(r.rows.map((row) => row.name)));
    p.catch(() => cache.delete(cr.db));
    cache.set(cr.db, p);
    while (cache.size > 32) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  return p;
}

export async function isInstalled(cr: Cursor, module: string): Promise<boolean> {
  return (await installedModules(cr)).has(module);
}
