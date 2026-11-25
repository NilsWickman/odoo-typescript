/**
 * Installing a language: the wizard odoo/addons/base/wizard/base_language_install.py (`lang_install` :35-63,
 * `switch_lang` :70-75, `reload` :65-68, `_default_lang_ids` :10-17, `_compute_first_lang_id` :30-33), the
 * activation `res.lang.write` (res_lang.py:393-429), and the term loading behind it:
 * `ir.module.module._update_translations` (ir_module.py:894-907) -> `_load_module_terms` (:988-1006, with the
 * overrides of base_import_module ir_module.py:58-86 and account ir_module.py:106-115) ->
 * `TranslationImporter.save` (translate.py:2196-2350), `account.account.tag._translate_tax_tags`
 * (account_account_tag.py:121-139) and `_load_non_installed_modules_manifest_terms` (ir_module.py:1009-1029).
 *
 * The .po files are read offline (worker/gen/lang_install.py, Odoo's own reader on a copy of the template): for each
 * importer `save` the generator records its `model_translations` in insertion order and, for the term-translated
 * fields (arch_db, html), the result of `StoredTranslations.translated` per record, keyed by a fingerprint of the
 * values it reads. Here the same SQL as `save` runs over those inputs, so records renamed since the template get
 * Odoo's merge. A term-translated record whose value differs from the template's, an imported data module with its
 * own .po attachment, a company whose chart template differs from the template's, or a language the generator did
 * not cover refuse with NotPorted.
 */
import { NotPorted, OdooError } from "../errors";
import { genAssetJson } from "../gen_assets";
import { registerMethod } from "../http/methods";
import { xmlid } from "../mail/message";
import { registerHooks } from "../orm/hooks";
import { registerDefaults } from "../orm/recompute";
import { templateOf } from "../orm/template";
import type { Environment } from "../orm/types";
import { write } from "../orm/write";
import { translate } from "./util";
import { loadCompanyTranslations } from "./chart_template";

const IN_MAX = 1000; // odoo/tools/constants.py:13

export interface ModelSave {
  readonly model: string;
  readonly table: string;
  readonly field: string;
  /** [module, name, {lang: value}] in the importer's insertion order */
  readonly entries: readonly [string, string, Readonly<Record<string, string>>][];
}

interface TermsSave {
  readonly model: string;
  readonly table: string;
  readonly field: string;
  /** xmlid -> record id -> fingerprint -> [changed values without overwrite, with overwrite] */
  readonly rows: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, readonly [Record<string, string | null>, Record<string, string | null>]>>>>>>;
}

interface ImporterSave {
  readonly overwrite: boolean;
  readonly force_overwrite: boolean;
  readonly caller: readonly string[];
  readonly model: readonly ModelSave[];
  readonly terms: readonly TermsSave[];
}

interface LangData {
  readonly _meta: { readonly lang: string; readonly template: string };
  readonly guard: { readonly companies: readonly [number, string | null][] };
  readonly saves: readonly ImporterSave[];
  readonly manifest: Readonly<Record<string, Record<string, Record<string, string>>>>;
}

function isLangData(v: unknown): v is LangData {
  return typeof v === "object" && v !== null && Array.isArray((v as { saves?: unknown }).saves) && typeof (v as { manifest?: unknown }).manifest === "object";
}

async function langData(env: Environment, lang: string): Promise<LangData> {
  const template = await templateOf(env.cr);
  if (template.dir === "") throw new NotPorted(`language install of ${lang} on ${template.name} (gen/lang_install.py runs on poc_erp)`);
  // a template with an overlay (poc_erp_se: poc_erp plus l10n_se) has its own install data: its modules' .po files
  // and its companies' chart templates (gen/lang_install.py with GEN_TEMPLATE=poc_erp_se)
  const dir = template.overlay ?? template.dir;
  const raw = await genAssetJson(`${dir}/lang/${lang}.json`);
  if (!isLangData(raw)) throw new NotPorted(`gen/out/${dir}/lang/${lang}.json has no importer saves`);
  return raw;
}

async function rows<T extends object>(env: Environment, text: string, params: unknown[] = []): Promise<T[]> {
  return (await env.cr.query<T & Record<string, unknown>>(text, params)).rows;
}

const ident = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/** Python's json.dumps(sort_keys=True, ensure_ascii=False, separators=(',', ':')) for strings and flat objects. */
function canonical(v: Record<string, unknown>): string {
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${JSON.stringify(v[k])}`).join(",")}}`;
}

/** gen/lang_install.py `fingerprint`: sha256 of the keys `StoredTranslations.translated` reads for `lang`. */
async function fingerprint(values: Record<string, unknown>, lang: string): Promise<string> {
  const keep: Record<string, unknown> = {};
  for (const k of ["en_US", "_en_US", lang, `_${lang}`]) if (k in values) keep[k] = values[k];
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(keep)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** translate.py:2208-2268: the model terms of one importer save (term-translated fields). */
async function saveTerms(env: Environment, save: ImporterSave, lang: string): Promise<void> {
  for (const t of save.terms) {
    const xmlids = Object.keys(t.rows);
    for (let i = 0; i < xmlids.length; i += IN_MAX) {
      const chunk = xmlids.slice(i, i + IN_MAX);
      const mods = chunk.map((x) => x.slice(0, x.indexOf(".")));
      const names = chunk.map((x) => x.slice(x.indexOf(".") + 1));
      // translate.py:2219-2228 (no filter on imd.model, as in Odoo)
      const found = await rows<{ id: number; xmlid: string; values: Record<string, unknown> | null; noupdate: boolean | null }>(env,
        `SELECT m.id, imd.module || '.' || imd.name AS xmlid, m.${ident(t.field)} AS values, imd.noupdate
           FROM ${ident(t.table)} m, "ir_model_data" imd
          WHERE m.id = imd.res_id
            AND (imd.module, imd.name) IN (SELECT * FROM unnest($1::text[], $2::text[]))`, [mods, names]);
      const params: [number, string][] = [];
      for (const r of found) {
        const values = r.values;
        if (!values) continue;
        const en = values["_en_US"] ?? values["en_US"];
        if (!en) continue;
        const byId = t.rows[r.xmlid]?.[String(r.id)];
        const fp = await fingerprint(values, lang);
        const result = byId?.[fp];
        if (result === undefined) {
          throw new NotPorted(`translation of the terms of ${t.model}.${t.field} for ${r.xmlid} (id ${r.id}): its value differs from the template's (gen/lang_install.py computes the terms per template record)`);
        }
        const doOverwrite = save.force_overwrite || (!r.noupdate && save.overwrite);
        const changed = result[doOverwrite ? 1 : 0];
        if (Object.keys(changed).length) params.push([r.id, JSON.stringify(changed)]);
      }
      if (!params.length) continue;
      // translate.py:2257-2268
      await env.cr.query(
        `UPDATE ${ident(t.table)} AS m
            SET ${ident(t.field)} = jsonb_strip_nulls(${ident(t.field)} || t.value)
           FROM (SELECT * FROM unnest($1::int[], $2::jsonb[])) AS t(id, value)
          WHERE m.id = t.id`, [params.map((p) => p[0]), params.map((p) => p[1])]);
    }
  }
}

/** translate.py:2272-2343: the model translations of one importer save (fields with translate=True). */
async function saveModel(env: Environment, save: ImporterSave): Promise<void> {
  for (const m of save.model) await saveModelEntries(env, m, save.overwrite, save.force_overwrite);
}

/** The model part of `TranslationImporter.save` (translate.py:2196-2206) for one field, as account's
 * `_load_translations` uses it (src/models/chart_template.ts): entries [module, name, {lang: value}] in order. */
export async function saveModelTranslations(env: Environment, model: string, table: string, field: string,
  entries: readonly [string, string, Readonly<Record<string, string>>][], overwrite: boolean): Promise<void> {
  await saveModelEntries(env, { model, table, field, entries }, overwrite, false);
}

export async function saveModelEntries(env: Environment, m: ModelSave, overwrite: boolean, forceOverwrite: boolean): Promise<void> {
  {
    const field = ident(m.field);
    const valueQuery = forceOverwrite ? `m.${field} || merged.noupdate_value || merged.update_value`
      : overwrite ? `merged.noupdate_value || m.${field} || merged.update_value`
        : `merged.noupdate_value || merged.update_value || m.${field}`;
    for (let i = 0; i < m.entries.length; i += IN_MAX) {
      const chunk = m.entries.slice(i, i + IN_MAX);
      await env.cr.query(
        `WITH input(imd_module, imd_name, value, id) AS (
             SELECT * FROM unnest($1::text[], $2::text[], $3::jsonb[]) WITH ORDINALITY
         ),
         entries AS (
             SELECT imd.res_id, imd.noupdate, input.id, translation.key, translation.value
               FROM input
               JOIN "ir_model_data" AS imd
                 ON imd.model = $4
                AND imd.module = input.imd_module
                AND imd.name = input.imd_name
              CROSS JOIN LATERAL jsonb_each(input.value) AS translation(key, value)
         ),
         merged AS (
             SELECT res_id,
                    COALESCE(jsonb_object_agg(key, value ORDER BY id ASC) FILTER (WHERE noupdate), '{}'::jsonb) AS noupdate_value,
                    COALESCE(jsonb_object_agg(key, value ORDER BY id ASC) FILTER (WHERE NOT noupdate), '{}'::jsonb) AS update_value
               FROM entries
              GROUP BY res_id
         )
         UPDATE ${ident(m.table)} AS m
            SET ${field} = ${valueQuery}
           FROM merged
          WHERE m.id = merged.res_id`,
        [chunk.map((e) => e[0]), chunk.map((e) => e[1]), chunk.map((e) => JSON.stringify(e[2])), m.model]);
    }
  }
}

/** account_account_tag.py:121-139 `_translate_tax_tags` (no tag_ids). */
async function translateTaxTags(env: Environment, langs: readonly string[]): Promise<void> {
  for (const lang of langs) {
    if (lang === "en_US") continue;
    await env.cr.query(
      `UPDATE account_account_tag tag
          SET name = tag.name || jsonb_build_object($1::text, substring(tag.name->>'en_US' FOR 1) || (report_line.name->>$1::text))
         FROM account_report_line report_line
         JOIN account_report report ON report.id = report_line.report_id
        WHERE tag.applicability = 'taxes'
          AND tag.country_id = report.country_id
          AND tag.name->>'en_US' = substring(tag.name->>'en_US' FOR 1) || (report_line.name->>'en_US')
          AND tag.name->>$1::text != substring(tag.name->>'en_US' FOR 1) || (report_line.name->>$1::text)`, [lang]);
  }
}

/** res_lang.py:393-429 `write({'active': True})`: the ORM write, then the shortest url_code. */
export async function activateLangs(env: Environment, ids: readonly number[]): Promise<void> {
  await write(env.sudo(), "res.lang", ids, { active: true });
  const longs = await rows<{ id: number; code: string; url_code: string }>(env, "SELECT id, code, url_code FROM res_lang WHERE id = ANY($1::int[]) AND url_code LIKE '%\\_%'", [[...ids]]);
  for (const l of longs) {
    const short = l.code.split("_")[0] ?? "";
    const other = (await rows<{ id: number; code: string; active: boolean }>(env, "SELECT id, code, active FROM res_lang WHERE url_code = $1 ORDER BY active DESC, name LIMIT 1", [short]))[0];
    if (other && !other.active && other.code !== short) throw new NotPorted(`res.lang url_code swap of ${l.code} with ${other.code} (res_lang.py:413-427)`);
  }
  env.cache.delete("orm.langs");
}

/** base_import_module ir_module.py:58-86: imported data modules with their own .po attachment refuse. */
async function checkImportedPo(env: Environment, langs: readonly string[]): Promise<void> {
  const imported = await rows<{ name: string }>(env,
    "SELECT name FROM ir_module_module m WHERE state = 'installed' AND COALESCE((to_jsonb(m) ->> 'imported')::boolean, false)");
  for (const { name } of imported) {
    for (const lang of langs) {
      const bases = [lang.split("_")[0] ?? lang, lang];
      const att = await rows<{ id: number }>(env,
        "SELECT id FROM ir_attachment WHERE name = ANY($1::text[]) AND url = ANY($2::text[]) AND type = 'binary' LIMIT 1",
        [bases.map((b) => `${name}_${b}.po`), bases.map((b) => `/${name}/i18n/${b}.po`)]);
      if (att.length) throw new NotPorted(`translations of the imported module ${name} for ${lang} (base_import_module ir_module.py:58-86)`);
    }
  }
}

/** The wizard's languages in res.lang's order (`_order = 'active desc, name'`). */
async function wizardLangs(env: Environment, id: number): Promise<{ id: number; code: string }[]> {
  return rows<{ id: number; code: string }>(env,
    `SELECT l.id, l.code FROM res_lang_install_rel r JOIN res_lang l ON l.id = r.lang_id
      WHERE r.language_wizard_id = $1 ORDER BY l.active DESC, l.name, l.id`, [id]);
}

function ensureOne(ids: number[] | null): number {
  if (ids === null || ids.length !== 1) {
    throw new OdooError("builtins.ValueError", `Expected singleton: base.language.install(${(ids ?? []).join(", ")}${ids?.length === 1 ? "," : ""})`);
  }
  return ids[0] as number;
}

/** base_language_install.py:35-63 `lang_install`. */
async function langInstall(env: Environment, ids: number[] | null): Promise<unknown> {
  const id = ensureOne(ids);
  const langs = await wizardLangs(env, id);
  const codes = langs.map((l) => l.code);
  const overwrite = (await rows<{ overwrite: boolean | null }>(env, "SELECT overwrite FROM base_language_install WHERE id = $1", [id]))[0]?.overwrite === true;
  const data = new Map<string, LangData>();
  for (const code of codes) if (code !== "en_US") data.set(code, await langData(env, code));
  // the generated account translations are those of the template's companies and chart templates
  const companies = await rows<{ id: number; chart_template: string | null }>(env, "SELECT id, chart_template FROM res_company ORDER BY id");
  for (const [code, d] of data) {
    const same = JSON.stringify(companies.map((c) => [c.id, c.chart_template ?? null])) === JSON.stringify(d.guard.companies);
    if (!same) throw new NotPorted(`chart template translations for ${code} with companies other than the template's (account chart_template.py:1516-1575)`);
  }
  await activateLangs(env, langs.map((l) => l.id)); // base_language_install.py:38
  // ir_module.py:894-907 -> account's override around base_import_module's around base's (the generator's call order)
  await checkImportedPo(env, codes);
  if (codes.length > 1 && data.size > 1) throw new NotPorted("installing several languages at once (one importer save over all of them)");
  for (const [code, d] of data) {
    for (const save of d.saves) {
      // the wizard's checkbox is the overwrite of `_load_module_terms`; account's chart template loading always
      // saves with overwrite=False (chart_template.py:1575)
      const fromWizard = save.caller.some((c) => c.includes("base/models/ir_module.py"));
      const s: ImporterSave = fromWizard ? { ...save, overwrite } : save;
      await saveTerms(env, s, code);
      await saveModel(env, s);
      if (save.caller.some((c) => c.includes("chart_template.py"))) await translateTaxTags(env, [code]);
    }
    if (!d.saves.some((s) => s.caller.some((c) => c.includes("chart_template.py")))) await translateTaxTags(env, [code]);
  }
  // ir_module.py:1009-1029: the manifests of the modules that are not installed
  if (!(codes.length === 1 && (codes[0] === "en_US" || codes[0] === "en"))) {
    for (const [code, d] of data) {
      const names = Object.keys(d.manifest);
      const mods = await rows<{ id: number; name: string }>(env,
        "SELECT id, name FROM ir_module_module WHERE state != 'installed' AND name = ANY($1::text[]) ORDER BY application DESC, sequence, name, id", [names]);
      for (const m of mods) {
        const vals = d.manifest[m.name];
        if (vals) await write(env, "ir.module.module", [m.id], vals);
      }
      void code;
    }
  }
  if (langs.length === 1) {
    return {
      type: "ir.actions.act_window", res_model: "base.language.install", res_id: id, view_mode: "form", target: "new",
      views: [[await xmlid(env, "base.language_install_view_form_lang_switch"), "form"]],
    };
  }
  return {
    type: "ir.actions.client", tag: "display_notification", context: { ...env.context, active_ids: [id] }, target: "new",
    params: {
      message: translate(env, "The languages that you selected have been successfully installed. Users can choose their favorite language in their preferences."),
      type: "success", sticky: false, next: { type: "ir.actions.act_window_close" },
    },
  };
}

/**
 * The parts of a language's activation that a module's install delays or runs past the capture (src/modules/
 * init_hooks.ts, `_activate_and_install_lang` in a post_init hook), from the install data of the template the
 * overlay is built on (gen/out/<dir>/lang/<lang>.json, gen/lang_install.py on the base: what is installed before the
 * new modules). `_load_non_installed_modules_manifest_terms` (ir_module.py:1008-1026): the manifest terms of every
 * module not installed, an ORM write each, in ir.module.module's order.
 */
export async function loadManifestTerms(env: Environment, lang: string): Promise<void> {
  if (lang === "en_US" || lang === "en") return;
  const d = await baseLangData(env, lang);
  const names = Object.keys(d.manifest);
  const mods = await rows<{ id: number; name: string }>(env,
    "SELECT id, name FROM ir_module_module WHERE state != 'installed' AND name = ANY($1::text[]) ORDER BY application DESC, sequence, name, id", [names]);
  for (const m of mods) {
    const vals = d.manifest[m.name];
    if (vals) await write(env, "ir.module.module", [m.id], vals);
  }
}

/**
 * account ir_module.py:106-115 `load_account_translations`, delayed to `_register_hook` (ir_module.py:117-121) when
 * the registry is loading: `account.chart.template._load_translations(langs)` (the generator's saves from
 * chart_template.py, for the template's companies and chart templates; other companies refuse) and
 * `account.account.tag._translate_tax_tags(langs)`.
 */
export async function loadAccountTranslations(env: Environment, lang: string): Promise<void> {
  const d = await baseLangData(env, lang);
  // :1527 the companies with a chart template: the template's, as the generator saw them (their translations are its
  // saves), then any other (a demo company a new module created) through the chart loader's own translations; the
  // importer's entries are per company xmlid, so the two parts write disjoint records
  const companies = await rows<{ id: number; chart_template: string | null }>(env, "SELECT id, chart_template FROM res_company ORDER BY id");
  const known = new Map(d.guard.companies.map(([id, chart]) => [id, chart]));
  for (const [id, chart] of d.guard.companies) {
    if (chart !== null && companies.find((c) => c.id === id)?.chart_template !== chart) {
      throw new NotPorted(`chart template translations for ${lang}: company ${id} no longer has the template's chart ${chart} (account chart_template.py:1516-1575)`);
    }
  }
  const others = companies.filter((c) => c.chart_template !== null && !(known.has(c.id) && known.get(c.id) !== null));
  if (others.some((c) => known.has(c.id))) throw new NotPorted(`chart template translations for ${lang}: a template company with a new chart template`);
  for (const save of d.saves) {
    if (!save.caller.some((c) => c.includes("chart_template.py"))) continue;
    await saveTerms(env, save, lang);
    await saveModel(env, save);
  }
  for (const c of others) await loadCompanyTranslations(env, c.id, [lang]);
  await translateTaxTags(env, [lang]);
}

async function baseLangData(env: Environment, lang: string): Promise<LangData> {
  const template = await templateOf(env.cr);
  if (template.dir === "") throw new NotPorted(`language data of ${lang} on ${template.name} (gen/lang_install.py runs on poc_erp)`);
  const raw = await genAssetJson(`${template.dir}/lang/${lang}.json`);
  if (!isLangData(raw)) throw new NotPorted(`gen/out/${template.dir}/lang/${lang}.json has no importer saves`);
  return raw;
}

registerMethod("base.language.install", "lang_install", (env, ids) => langInstall(env, ids), { apiModel: false });

// base_language_install.py:65-68
registerMethod("base.language.install", "reload", async () => ({ type: "ir.actions.client", tag: "reload" }), { apiModel: false });

// base_language_install.py:70-75: `self.env.user.lang = self.first_lang_id.code`
registerMethod("base.language.install", "switch_lang", async (env, ids) => {
  const id = ensureOne(ids);
  const first = (await wizardLangs(env, id))[0];
  await write(env, "res.users", [env.uid], { lang: first ? first.code : false });
  return { type: "ir.actions.client", tag: "reload_context" };
}, { apiModel: false });

registerHooks("base.language.install", {
  computed: {
    // base_language_install.py:30-33
    first_lang_id: async (env, ids) => {
      const out = new Map<number, unknown>();
      for (const id of ids) out.set(id, (await wizardLangs(env, id))[0]?.id ?? false);
      return out;
    },
  },
});

registerDefaults("base.language.install", {
  // base_language_install.py:10-17
  lang_ids: async (env) => {
    if (env.context["active_model"] !== "res.lang") return false;
    const ids = env.context["active_ids"];
    if (Array.isArray(ids) && ids.length) return ids;
    return [env.context["active_id"]];
  },
  overwrite: async () => true,
});
