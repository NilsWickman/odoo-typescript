/**
 * The module whose install `load_module_graph` is loading on a cursor (loading.py:114-304, src/modules/install.ts
 * loadModule): Odoo's registry at that step holds the modules installed before it and that module, not the ones after
 * it in the graph (`registry.load(package)` per module). Compiled code of a later module checks it (VAGB B0).
 */
const LOADING = new WeakMap<object, { module: string; later: readonly string[] }>();

/** `later`: the modules of the install that load after `module` (not in Odoo's registry yet). */
export function setLoadingModule(cr: object, module: string | null, later: readonly string[] = []): void {
  if (module === null) LOADING.delete(cr);
  else LOADING.set(cr, { module, later });
}

export function loadingModule(cr: object): string | null {
  return LOADING.get(cr)?.module ?? null;
}

/** The modules of the install still to load after the one loading now (none outside an install). */
export function laterModules(cr: object): readonly string[] {
  return LOADING.get(cr)?.later ?? [];
}
