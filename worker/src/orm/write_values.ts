/**
 * Column values that depend on the environment or on other values of the record (models.py `_create` :4384
 * `convert_to_column_insert`, `_write_multi` :4014-4060):
 *  - monetary fields rounded with the record's currency (fields_numeric.py:247-290);
 *  - company-dependent fields as jsonb per company, NULL / removed when equal to the ir.default fallback
 *    (fields.py:1135-1146, models.py:4046-4058, ir_default.py:222);
 *  - translated fields: a string in the env language or a `{lang: value}` dict (fields_textual.py:75-90, 110-135,
 *    320-420).
 */
import { NotPorted, ValidationError } from "../errors";
import { EMAIL_OUTGOING_XML } from "./html_output";
import { convertToCache, floatRepr, floatRoundRounding } from "./convert";
import { activeLangs, hasGroup } from "./env";
import { htmlSanitize } from "./html_sanitize";
import { translateKind } from "./genmeta";
import { ModelImpl } from "./model";
import { modelDefaults, valueToColumn } from "./sql";
import type { Environment, FieldDef, ModelDef } from "./types";

/** A translated value given as `{lang: value}` (cache format of fields_textual.py:115-135). */
export class TranslationDict {
  constructor(readonly values: Readonly<Record<string, string>>) {}
}

/** A company-dependent column update: the value for one company (models.py:4046). */
export class CompanyValue {
  constructor(readonly company: number, readonly column: unknown, readonly fallbacks: string) {}
  /** The jsonb patch `{company: value}` as Python's json.dumps writes it: a float field's value is a float, so an
   *  integral one keeps its ".0" (`{"1": 15.0}`, not `{"1": 15}`; the database diff reads them as float and int). */
  patch(field: FieldDef): string {
    const v = this.column;
    const float = (field.type === "float" || field.type === "monetary") && typeof v === "number" && Number.isInteger(v) && Math.abs(v) < 1e16;
    return `{${JSON.stringify(String(this.company))}: ${float ? `${v}.0` : JSON.stringify(v)}}`;
  }
}

function isDict(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** fields_textual.py:115-135 convert_to_cache of a dict for a translated field (validate=True). */
async function translationDict(env: Environment, def: ModelDef, field: FieldDef, value: Record<string, unknown>): Promise<TranslationDict | null> {
  const langs = await activeLangs(env);
  const out: Record<string, string> = {};
  let dropped = false;
  for (const [lang, v] of Object.entries(value)) {
    if (!langs.has(lang) && lang !== "en_US") { dropped = true; continue; }
    const c = convertToCache({ ...field, translate: false } as FieldDef, v, def.name);
    if (c === null) { dropped = true; continue; }
    out[lang] = String(c);
  }
  if (dropped) {
    if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated translation-dict error (${env.lang})`);
    // odoo/tools/translate.py: collection arguments of _() are rendered with format_list (en_US: "a, b, and c")
    const keys = Object.keys(value);
    const repr = keys.length <= 1 ? keys.join("") : keys.length === 2 ? `${keys[0]} and ${keys[1]}` : `${keys.slice(0, -1).join(", ")}, and ${keys[keys.length - 1]}`;
    if (Object.keys(value).some((l) => !langs.has(l) && l !== "en_US")) throw new ValidationError(`Some of the languages are not active: ${repr}`);
    throw new ValidationError(`Some of the translations are False: ${repr}`);
  }
  return Object.keys(out).length ? new TranslationDict(out) : null;
}

/** `res.currency` rounding and decimal places (res_currency.py:240, :286). */
async function currencyRounding(env: Environment, currencyId: number): Promise<{ rounding: number; places: number } | null> {
  const row = (await env.cr.query<{ rounding: string | number | null; decimal_places: number | null }>(
    "SELECT rounding, decimal_places FROM res_currency WHERE id = $1", [currencyId])).rows[0];
  if (!row || row.rounding === null) return null;
  return { rounding: Number(row.rounding), places: Number(row.decimal_places ?? 0) };
}

/** The currency of a record for a monetary field: from the values when given (directly or through the first step of a related currency field), else the record's. */
async function currencyOf(env: Environment, def: ModelDef, field: FieldDef, vals: Record<string, unknown>, id: number | null): Promise<number | null> {
  const name = field.currencyField ?? (def.fields.has("currency_id") ? "currency_id" : null);
  if (!name) throw new NotPorted(`currency field of ${def.name}.${field.name}`);
  const cf = def.fields.get(name);
  if (!cf) throw new NotPorted(`currency field ${def.name}.${name}`);
  if (name in vals) return convertToCache(cf, vals[name], def.name) as number | null;
  if (cf.related) {
    const [first, ...rest] = cf.related.split(".");
    if (first! in vals) {
      const ff = def.fields.get(first!)!;
      let cur = convertToCache(ff, vals[first!], def.name) as number | null;
      let model = ff.relation;
      for (const step of rest) {
        if (cur === null || !model) return null;
        const m = env.reg.model(model);
        const sf = m.fields.get(step)!;
        cur = ((await new ModelImpl(env.sudo(), m).values([cur], sf)).get(cur) as number | null) ?? null;
        model = sf.relation;
      }
      return cur;
    }
  }
  if (id === null) return null; // models.py:4384: the new record has no currency yet (record[:1] is empty)
  return ((await new ModelImpl(env.sudo(), def).values([id], cf)).get(id) as number | null) ?? null;
}

/** ir_default.py:174 `_get_model_defaults` for the user and company: the field's default, or null. */
async function irDefault(env: Environment, def: ModelDef, field: FieldDef, uid: number, company: number): Promise<unknown> {
  return (await modelDefaults(env, def.name, uid, company)).get(field.name) ?? null;
}

/** `convert_to_column` result of a company-dependent field in JSON (Python json.dumps of the SQL parameter). */
function columnJson(field: FieldDef, value: unknown): unknown {
  const v = valueToColumn(field, value);
  return v === undefined ? null : v;
}

/** ir_default.py:222 _get_field_column_fallbacks: per company, as superuser. */
async function fallbacks(env: Environment, def: ModelDef, field: FieldDef): Promise<string> {
  const companies = (await env.cr.query<{ id: number }>("SELECT id FROM res_company ORDER BY id")).rows.map((r) => r.id);
  const out: Record<string, unknown> = {};
  for (const c of companies) out[String(c)] = columnJson(field, await irDefault(env, def, field, 1, c));
  return JSON.stringify(out);
}

/** The cache value of `value` for record `id` (null on create), with the env/record-dependent conversions. */
export async function writeValue(env: Environment, def: ModelDef, field: FieldDef, value: unknown, vals: Record<string, unknown>, id: number | null): Promise<unknown> {
  if (field.translate && isDict(value)) {
    if (field.type !== "char" && field.type !== "text" && field.type !== "html") throw new NotPorted(`dict value for ${def.name}.${field.name}`);
    return translationDict(env, def, field, value);
  }
  if (field.type === "html" && typeof value === "string" && value !== "" && field.sanitize?.["sanitize"]) {
    return sanitizeHtml(env, def, field, value);
  }
  let cache = convertToCache(field, value, def.name);
  if (field.type === "monetary" && cache) {
    // fields_numeric.py:283-288: currency.round, then float(float_repr(value, decimal_places))
    const currency = await currencyOf(env, def, field, vals, id);
    const r = currency ? await currencyRounding(env, currency) : null;
    if (r) cache = Number(floatRepr(floatRoundRounding(cache as number, r.rounding), r.places));
  }
  if (field.companyDependent) {
    if (field.type === "one2many" || field.type === "many2many") throw new NotPorted(`company-dependent x2many ${def.name}.${field.name}`);
    const company = await env.company();
    return new CompanyValue(company, columnJson(field, cache), await fallbacks(env, def, field));
  }
  return cache;
}

/** fields_textual.py:731 Html._validated_cache_value: html_sanitize with the field's options, unless overridable. */
export async function sanitizeHtml(env: Environment, def: ModelDef, field: FieldDef, value: string): Promise<string> {
  const s = field.sanitize!;
  const row = (await env.cr.query<{ o: boolean | null }>("SELECT sanitize_overridable AS o FROM ir_model_fields WHERE model = $1 AND name = $2", [def.name, field.name])).rows[0];
  if (row?.o && await hasGroup(env, "base.group_sanitize_override")) return value;
  // sanitize='email_outgoing' (fields_textual.py:628-635) is the only spelling of both options off; its output method
  // is this Odoo commit's (gen/out/html_sanitize.json: 'xml' before Odoo 9710d237f, 'html' after)
  const xmlOutput = !s["sanitize_tags"] && !s["sanitize_attributes"] && EMAIL_OUTGOING_XML;
  return htmlSanitize(value, {
    sanitizeTags: !!s["sanitize_tags"], sanitizeAttributes: !!s["sanitize_attributes"], sanitizeStyle: !!s["sanitize_style"],
    sanitizeForm: true, stripStyle: !!s["strip_style"], stripClasses: !!s["strip_classes"], xmlOutput,
  });
}

/** INSERT parameter of a cache value (fields.py:1135 convert_to_column_insert, fields_textual.py:75). */
export async function insertColumn(env: Environment, def: ModelDef, field: FieldDef, cache: unknown): Promise<{ value: unknown; jsonb: boolean }> {
  const lang = env.lang ?? "en_US";
  if (cache instanceof CompanyValue) {
    const fallback = columnJson(field, await irDefault(env, def, field, env.uid, cache.company));
    if (JSON.stringify(cache.column) === JSON.stringify(fallback)) return { value: null, jsonb: true };
    return { value: cache.patch(field), jsonb: true };
  }
  if (field.translate) {
    if (cache === null || cache === undefined) return { value: null, jsonb: true };
    if (cache instanceof TranslationDict) {
      // fields_textual.py:86-89: en_US defaults to the env-language value, else the first one
      const v: Record<string, string> = { ...cache.values };
      if (!("en_US" in v)) v["en_US"] = v[lang] ?? Object.values(cache.values)[0]!;
      return { value: JSON.stringify(v), jsonb: true };
    }
    return { value: JSON.stringify(lang === "en_US" ? { en_US: cache } : { en_US: cache, [lang]: cache }), jsonb: true };
  }
  if (field.type === "monetary") {
    // psycopg2 adapts a float with repr(): 12000.0 keeps that scale in the numeric column (the database diff reads it)
    const n = typeof cache === "number" ? cache : 0;
    return { value: Number.isInteger(n) ? `${n}.0` : n, jsonb: false };
  }
  return { value: cache === undefined ? null : cache, jsonb: false };
}

/**
 * Term-translated (html_translate/xml_translate) fields: only the cases where no stored translation is merged. True
 * when the write leaves the stored value as it is (the field is then not written): tools/translate.py:671-690
 * `StoredTranslations.written`, `translate_terms_only`, where the written value is the stored one of its language and
 * no technical `_<lang>` value is dropped (an upgrade loading a view's unchanged arch, src/modules/upgrade.ts).
 */
export async function checkTermTranslationWrite(env: Environment, def: ModelDef, field: FieldDef, ids: readonly number[], cache: unknown): Promise<boolean> {
  if (!field.translate || (await translateKind(env, def.name, field.name)) !== "terms") return false;
  const lang = env.lang ?? "en_US";
  if (cache instanceof TranslationDict) throw new NotPorted(`term translations written as a dict (${def.name}.${field.name})`);
  const rows = (await env.cr.query<{ v: Record<string, unknown> | null }>(
    `SELECT ${field.name} AS v FROM ${def.table} WHERE id = ANY($1::int[])`, [ids])).rows;
  // fields_textual.py:409-417: without stored translations the value is stored for en_US and the env language;
  // StoredTranslations.written (term matching across languages) is not ported
  const unchanged = typeof cache === "string" && rows.length > 0 && rows.every((r) => r.v !== null && r.v[lang] === cache
    && !Object.keys(r.v).some((k) => k.startsWith("_")));
  if (unchanged) return true;
  for (const r of rows) if (r.v && (lang !== "en_US" || Object.keys(r.v).some((k) => k !== "en_US"))) throw new NotPorted(`term translation merge of ${def.name}.${field.name}`);
  return false;
}
