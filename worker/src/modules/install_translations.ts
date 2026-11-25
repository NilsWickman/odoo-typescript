/**
 * The translation import of a module install written by the port, D23 path B part B2 (compiler/VAGB.md):
 * `ir.module.module._update_translations` -> `TranslationImporter.save` (odoo/tools/translate.py:2199-2350) for the
 * languages installed, at the `translations:<module>` point of the load (loading.py:230-232).
 *
 * The build records each save (gen/install_capture.py `rec_save`, placeholder `@@translations <n>@@`), without ids:
 *   - `model`: the fields with translate=True, entries [module, name, {lang: value}] in the importer's order. The same
 *     UPDATE as Odoo's runs over ir_model_data (src/models/lang_install.ts saveModelEntries), so the records are found
 *     by their xmlid in this database.
 *   - `terms`: the term-translated fields (views' arch_db, html fields), with their term updates per xmlid. The record's
 *     value is read as Odoo reads it (translate.py:2219-2228, by xmlid, no filter on imd.model). An xml_translate
 *     field is translated by the port on that value (src/modules/xml_translate.ts, `StoredTranslations.translated`);
 *     where the value is the build's (same fingerprint) the build's result must be the same. An html_translate field
 *     takes the build's result, and refuses (NotPorted) when its value differs from the build's.
 * Odoo writes the terms first, then the model translations (translate.py:2212-2350).
 */
import { NotPorted } from "../errors";
import type { Environment } from "../orm/types";
import { saveModelEntries, type ModelSave } from "../models/lang_install";
import { translatedChanges } from "./xml_translate";

const IN_MAX = 1000; // odoo/tools/constants.py

interface TermsSave {
  readonly model: string;
  readonly table: string;
  readonly field: string;
  /** the field's `translate`: xml_translate, html_translate (only the build's results), other */
  readonly translate?: "xml" | "html" | "other";
  /** xmlid -> the languages of its term updates, the updates ({source term: {lang: term}}) and, by fingerprint of the
   *  build's value, the build's [changed without overwrite, with overwrite] */
  readonly records: Readonly<Record<string, {
    readonly langs: readonly string[];
    readonly terms?: Readonly<Record<string, Readonly<Record<string, string>>>>;
    readonly by_fp: Readonly<Record<string, readonly [Record<string, string | null>, Record<string, string | null>]>>;
  }>>;
}

export interface TranslationSave {
  readonly overwrite: boolean;
  readonly force_overwrite: boolean;
  readonly model: readonly ModelSave[];
  readonly terms: readonly TermsSave[];
}

const ident = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/** gen/install_capture.py `term_fp`: sha256 of the canonical JSON of the keys the term translation reads. */
async function termFp(values: Record<string, unknown>, langs: readonly string[]): Promise<string> {
  const keys = ["en_US", "_en_US", ...langs.flatMap((l) => [l, `_${l}`])];
  const keep = [...new Set(keys)].filter((k) => k in values).sort();
  const text = `{${keep.map((k) => `${JSON.stringify(k)}:${JSON.stringify(values[k])}`).join(",")}}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `res.lang._get_active_by('code')` keys: the languages `StoredTranslations._validate` keeps. */
async function activeLangs(env: Environment): Promise<Set<string>> {
  return new Set((await env.cr.query<{ code: string }>("SELECT code FROM res_lang WHERE active")).rows.map((r) => r.code));
}

/** translate.py:2212-2268: the model terms of one save. */
async function saveTerms(env: Environment, save: TranslationSave): Promise<void> {
  for (const t of save.terms) {
    const xmlids = Object.keys(t.records);
    for (let i = 0; i < xmlids.length; i += IN_MAX) {
      const chunk = xmlids.slice(i, i + IN_MAX);
      const found = (await env.cr.query<{ id: number; xmlid: string; values: Record<string, unknown> | null; noupdate: boolean | null }>(
        `SELECT m.id, imd.module || '.' || imd.name AS xmlid, m.${ident(t.field)} AS values, imd.noupdate
           FROM ${ident(t.table)} m, "ir_model_data" imd
          WHERE m.id = imd.res_id
            AND (imd.module, imd.name) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
        [chunk.map((x) => x.slice(0, x.indexOf("."))), chunk.map((x) => x.slice(x.indexOf(".") + 1))])).rows;
      const params: [number, string][] = [];
      for (const r of found) {
        const values = r.values;
        if (!values) continue;
        if (!(values["_en_US"] ?? values["en_US"])) continue;
        const rec = t.records[r.xmlid];
        const overwrite = save.force_overwrite || (!r.noupdate && save.overwrite);
        const built = rec ? rec.by_fp[await termFp(values, rec.langs)]?.[overwrite ? 1 : 0] : undefined;
        let changed: Record<string, string | null> | undefined = built;
        if (rec?.terms && t.translate === "xml") {
          // the port's own translation of this record's value (B2 step 2): what Odoo computes on this database
          const updates = new Map<string, Map<string, string>>();
          for (const [src, byLang] of Object.entries(rec.terms)) {
            for (const [lang, term] of Object.entries(byLang)) (updates.get(lang) ?? updates.set(lang, new Map()).get(lang)!).set(src, term);
          }
          try {
            changed = translatedChanges(values, updates, await activeLangs(env), overwrite);
          } catch (e) {
            // a term the port cannot parse as lxml's HTML parser repairs it (project's Arabic edit_project: a broken
            // tag in the .po): on the build's own value (same fingerprint) the build's result is Odoo's; else refuse
            if (!(e instanceof NotPorted) || built === undefined) throw e;
            changed = built;
          }
          if (built !== undefined && JSON.stringify(built) !== JSON.stringify(changed)) {
            throw new NotPorted(`translation of the terms of ${t.model}.${t.field} for ${r.xmlid}: the port's differs from the build's on the same value`);
          }
        }
        if (changed === undefined) {
          throw new NotPorted(`translation of the terms of ${t.model}.${t.field} for ${r.xmlid}: its value differs from the build's, and ${t.translate ?? "the field"} terms are not translated by the port (compiler/VAGB.md B2)`);
        }
        if (Object.keys(changed).length) params.push([r.id, JSON.stringify(changed)]);
      }
      if (!params.length) continue;
      await env.cr.query(
        `UPDATE ${ident(t.table)} AS m
            SET ${ident(t.field)} = jsonb_strip_nulls(${ident(t.field)} || t.value)
           FROM (SELECT * FROM unnest($1::int[], $2::jsonb[])) AS t(id, value)
          WHERE m.id = t.id`, [params.map((p) => p[0]), params.map((p) => p[1])]);
    }
  }
}

/** One recorded `TranslationImporter.save` of the install's translations phase. */
export async function applyTranslationSave(env: Environment, save: TranslationSave): Promise<void> {
  await saveTerms(env, save);
  for (const m of save.model) await saveModelEntries(env, m, save.overwrite, save.force_overwrite);
}
