/**
 * Server-side `_()` (odoo/tools/translate.py:981-989 `get_translation`): `code_translations.get_python_translations(
 * module, lang).get(source, source)`, the `code` entries of the calling module's .po file. Generated per language by
 * worker/gen/lang_install.py (`<lang>.code.json`: module -> source -> translation) and packaged as a static asset
 * (src/gen_assets.ts). The .po files belong to the modules, not to a database, so the table is kept per language;
 * it is loaded before a request in that language runs (`ensureRegistryLang`), so `translate` can stay synchronous.
 */
import type { Cursor } from "../db";
import { NotPorted } from "../errors";
import { genAssetJson } from "../gen_assets";
import { templateOf } from "./template";

type Table = Readonly<Record<string, Readonly<Record<string, string>>>>;

const TABLES = new Map<string, Table>();
const LOADING = new Map<string, Promise<void>>();
/** The template dirs whose table is merged into TABLES' entry, per language: a template with an overlay (poc_erp_se)
 * has more modules' .po files (l10n_se); a module's translations are the same in every template. */
const MERGED = new Map<string, Set<string>>();
/** gen/code_sources.py: source text -> the modules whose Python code calls `_()` with it (per template dir). */
const SOURCES = new Map<string, Readonly<Record<string, readonly string[]>>>();
let sourcesDir: string | null = null;

/** Load the `_()` table of `lang` (once per isolate) when the database's template has one; else leave it absent. */
export async function loadCodeTranslations(cr: Cursor, lang: string): Promise<void> {
  const template = await templateOf(cr);
  const dir = template.overlay ?? template.dir;
  if (MERGED.get(lang)?.has(dir)) return;
  const key = `${dir}/${lang}`;
  let p = LOADING.get(key);
  if (p === undefined) {
    p = (async () => {
      if (template.dir === "") return;
      try {
        const raw = await genAssetJson(`${dir}/lang/${lang}.code.json`);
        if (typeof raw === "object" && raw !== null) {
          TABLES.set(lang, { ...(TABLES.get(lang) ?? {}), ...(raw as Table) });
          MERGED.set(lang, new Set([...(MERGED.get(lang) ?? []), dir]));
        }
      } catch (e) {
        if (!(e instanceof NotPorted)) throw e; // no table generated for this language: translate() refuses
      }
      if (!SOURCES.has(template.dir)) {
        try {
          const raw = await genAssetJson(`${template.dir}/lang/code_sources.json`);
          if (typeof raw === "object" && raw !== null) SOURCES.set(template.dir, raw as Record<string, readonly string[]>);
        } catch (e) {
          if (!(e instanceof NotPorted)) throw e; // not generated: translate() without a module refuses
        }
      }
      sourcesDir = template.dir;
    })().finally(() => LOADING.delete(key));
    LOADING.set(key, p);
  }
  await p;
}

/** `get_python_translations(module, lang).get(source, source)`; null when no table for `lang` is loaded. */
export function codeTranslation(lang: string, module: string, source: string): string | null {
  const table = TABLES.get(lang);
  if (table === undefined) return null;
  return table[module]?.[source] ?? source;
}

/**
 * `_()` for a port call site that does not name its module: the modules whose Python code calls `_()` with this very
 * text (gen/code_sources.py). When each of them translates it the same way, that is Odoo's answer whichever of them
 * the ported code came from; null (the caller refuses) when the text is in no module or the modules disagree.
 */
export function codeTranslationAnyModule(lang: string, source: string): string | null {
  const table = TABLES.get(lang);
  const sources = sourcesDir === null ? undefined : SOURCES.get(sourcesDir);
  const modules = sources?.[source];
  if (table === undefined || modules === undefined || modules.length === 0) return null;
  const ts = new Set(modules.map((m) => table[m]?.[source] ?? source));
  return ts.size === 1 ? [...ts][0]! : null;
}
