/**
 * Python-only field attributes the write path needs and src/orm/types.ts FieldDef does not carry, read from the
 * generated metadata of the database's corpus template (gen/out[/<template>]/models.json, src/orm/template.ts):
 * `inverse=`, the kind of `translate=` (True, html_translate, xml_translate), `precompute=` is not generated.
 */
import { genModelsFile } from "../gen_models";
import { NotPorted } from "../errors";
import { templateKey, templateOf, type TemplateInfo } from "./template";
import { withOverlay } from "./overlay";
import type { Environment } from "./types";

export interface GenWriteField { readonly inverse: boolean; readonly translate: boolean | string; readonly currency_field?: string | null }
type GenModels = Readonly<Record<string, { readonly fields: Readonly<Record<string, GenWriteField>> }>>;

const cache = new Map<string, Promise<GenModels>>();

async function loadBase(dir: string): Promise<GenModels> {
  if (dir === "poc_erp" || dir === "") return ((await genModelsFile(dir)) as { models: unknown }).models as GenModels;
  throw new NotPorted(`gen/out/${dir}/models.json is not wired in src/orm/genmeta.ts`);
}

async function load(t: TemplateInfo): Promise<GenModels> {
  return (await withOverlay(t, "models.json", { models: await loadBase(t.dir) }, "models")).models;
}

export async function genField(env: Environment, model: string, field: string): Promise<GenWriteField | undefined> {
  const t = await templateOf(env.cr);
  let p = cache.get(templateKey(t));
  if (!p) { p = load(t); cache.set(templateKey(t), p); }
  return (await p)[model]?.fields[field];
}

export async function genModelFields(env: Environment, model: string): Promise<Readonly<Record<string, GenWriteField>>> {
  const t = await templateOf(env.cr);
  let p = cache.get(t.name);
  if (!p) { p = load(t); cache.set(t.name, p); }
  return (await p)[model]?.fields ?? {};
}

/** `translate` is a callable (html_translate / xml_translate): term-based translations. */
export async function translateKind(env: Environment, model: string, field: string): Promise<"model" | "terms" | null> {
  const g = await genField(env, model, field);
  if (!g || !g.translate) return null;
  return g.translate === true ? "model" : "terms";
}

/** gen/precompute.py: the `precompute=True` fields of a model (models.py:4302 `_add_precomputed_values`). */
export interface GenPrecompute { readonly fields: readonly string[]; readonly sudo: readonly string[]; readonly groups: readonly (readonly string[])[] }
type GenPrecomputes = Readonly<Record<string, GenPrecompute>>;
const preCache = new Map<string, Promise<GenPrecomputes>>();

async function loadPrecompute(t: TemplateInfo): Promise<GenPrecomputes> {
  return (await withOverlay(t, "precompute.json", { models: await loadPrecomputeBase(t.dir) }, "models")).models;
}

async function loadPrecomputeBase(dir: string): Promise<GenPrecomputes> {
  if (dir === "poc_erp") return (await import("../../gen/out/poc_erp/precompute.json", { with: { type: "json" } })).default.models as unknown as GenPrecomputes;
  if (dir === "") return (await import("../../gen/out/precompute.json", { with: { type: "json" } })).default.models as unknown as GenPrecomputes;
  throw new NotPorted(`gen/out/${dir}/precompute.json is not wired in src/orm/genmeta.ts`);
}

export async function genPrecompute(env: Environment, model: string): Promise<GenPrecompute | undefined> {
  const t = await templateOf(env.cr);
  let p = preCache.get(templateKey(t));
  if (!p) { p = loadPrecompute(t); preCache.set(templateKey(t), p); }
  return (await p)[model];
}

const siteCache = new Map<string, Map<string, readonly string[]>>();

/**
 * The fields of `model` that only the database's site overlay has (its new modules' fields: l10n_cn's
 * account.move.line `l10n_cn_output_vat_offset_account_id`), in the overlay's order; none without an overlay.
 */
export async function siteOnlyFields(env: Environment, model: string): Promise<readonly string[]> {
  const t = await templateOf(env.cr);
  if (!t.overlay) return [];
  const byModel = siteCache.get(templateKey(t)) ?? new Map<string, readonly string[]>();
  siteCache.set(templateKey(t), byModel);
  let names = byModel.get(model);
  if (names === undefined) {
    let merged = cache.get(t.name);
    if (!merged) { merged = load(t); cache.set(templateKey(t), merged); }
    const [all, base] = await Promise.all([merged, loadBase(t.dir)]);
    const own = base[model]?.fields ?? {};
    names = Object.keys(all[model]?.fields ?? {}).filter((f) => !(f in own));
    byModel.set(model, names);
  }
  return names;
}
