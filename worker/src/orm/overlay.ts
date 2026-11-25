/**
 * Generated data of a template that is another template plus installed modules (poc_erp_se: poc_erp with l10n_se):
 * the base template's files (gen/out/<dir>/) and, from gen/out/<overlay>/ packaged as static assets under /__gen/
 * (src/gen_assets.ts), only what the extra modules change (worker/gen/template_delta.py). A loader merges the
 * overlay over the base by top-level keys (whole models replaced, never merged field by field).
 *
 * VAGB B0, the registry per module: while an install loads a module that is not the graph's last, Odoo's registry
 * holds the modules before it and that module only (loading.py:181-188 `registry.load(package)` per module). The
 * template is then pinned at that step (src/modules/install.ts, TemplateInfo.step) and the step's entries of
 * gen/out/<overlay>/install_steps.json (gen/install_capture.py: the generators run on Odoo's registry at that step)
 * replace the overlay's, whole entries again, `null` for an entry the step does not have.
 */
import { NotPorted } from "../errors";
import { genAssetJson } from "../gen_assets";
import { isLazyRecord, layeredRecord } from "../gen_models";
import type { TemplateInfo } from "./template";

/** The overlay of `file` (e.g. "models.json") for the template, or null when the template has none. */
export async function overlayOf(template: TemplateInfo, file: string): Promise<Record<string, unknown> | null> {
  if (!template.overlay) return null;
  return await genAssetJson(`${template.overlay}/${file}`) as Record<string, unknown>;
}

interface InstallSteps {
  readonly order: readonly string[];
  readonly files: readonly string[];
  readonly steps: Readonly<Record<string, Readonly<Record<string, Record<string, unknown>>>>>;
}

const STEPS = new Map<string, Promise<InstallSteps | null>>();

/** The overlay's install steps (gen/install_capture.py), or null when its capture has none (a single module). Parsed
 *  once per isolate (3.4 MB for poc_erp_fleet: whole entries of account.move and account.move.line). */
export function installSteps(overlay: string): Promise<InstallSteps | null> {
  let p = STEPS.get(overlay);
  if (!p) {
    p = (async () => {
      try {
        return await genAssetJson(`${overlay}/install_steps.json`) as InstallSteps;
      } catch (e) {
        if (e instanceof NotPorted) return null; // not packaged: no steps
        throw e;
      }
    })();
    p.catch(() => STEPS.delete(overlay));
    STEPS.set(overlay, p);
    while (STEPS.size > 2) STEPS.delete(STEPS.keys().next().value!);
  }
  return p;
}

/** The step's entries of `file`: the map `key` (or the top level) of the entries that differ from the overlay's. */
async function stepPatch(template: TemplateInfo, file: string): Promise<Record<string, unknown>> {
  const steps = template.overlay ? await installSteps(template.overlay) : null;
  if (!steps || !steps.order.includes(template.step!)) throw new NotPorted(`the registry of ${template.name} while ${template.step} loads: not in its install_steps.json (gen/install_capture.py)`);
  if (!steps.files.includes(file)) throw new NotPorted(`${file} of ${template.name} while ${template.step} loads: the capture did not step it (gen/install_capture.py STEP_FILES)`);
  return steps.steps[template.step!]?.[file] ?? {};
}

/** `entries` with `patch`'s: a value replaces the entry, null removes it. */
function patched(entries: Record<string, unknown>, patch: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!patch || !Object.keys(patch).length) return entries;
  const out = { ...entries };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** `base` with the overlay's entries of `key` (or of the top level when key is null) replacing the base's. */
export async function withOverlay<T>(template: TemplateInfo, file: string, base: T, key: string | null): Promise<T> {
  const merged = await withOverlayOnly(template, file, base, key);
  if (!template.step) return merged;
  const patch = await stepPatch(template, file);
  const m = merged as Record<string, unknown>;
  if (key === null) return patched(m, patch) as T;
  const inner = m[key] as Record<string, unknown>;
  // a lazy record (models.json) layered once more: its entries are parsed only when read
  const p = (patch[key] ?? {}) as Record<string, unknown>;
  if (isLazyRecord(inner)) {
    const over = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== null));
    return { ...m, [key]: layeredRecord(inner, over, new Set(Object.keys(p).filter((k) => p[k] === null))) } as T;
  }
  return { ...m, [key]: patched(inner, p) } as T;
}

async function withOverlayOnly<T>(template: TemplateInfo, file: string, base: T, key: string | null): Promise<T> {
  const over = await overlayOf(template, file);
  if (over === null) return base;
  if (key === null) return { ...(base as Record<string, unknown>), ...over } as T;
  const b = base as Record<string, unknown>;
  // models.json's lazy `models` (src/gen_models.ts): layered, so that the base's models are parsed only when read
  if (isLazyRecord(b[key])) return { ...b, [key]: layeredRecord(b[key], (over[key] ?? {}) as Record<string, unknown>) } as T;
  return { ...b, [key]: { ...(b[key] as Record<string, unknown>), ...(over[key] as Record<string, unknown>) } } as T;
}
