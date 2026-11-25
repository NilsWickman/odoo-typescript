/**
 * `GET /web/webclient/translations[/<unique>]?lang=&hash=&mods=`: `odoo/addons/web/controllers/webclient.py:50
 * translations` over `ir_http.py:541 _get_translations_for_webclient` and `:567 _get_web_translations_hash`.
 *
 * The translation data comes from gen/out/translations/<lang>.json (stream G, gen/translations.py: exactly the body
 * Odoo returns for `?lang=<lang>&hash=` with no `mods`), imported lazily and kept in a small per-isolate map. The
 * hash is recomputed here with Odoo's formula (sha1 of `json.dumps(cache, sort_keys=True)`, ir_http.py:580) so
 * that `mods=` subsets and `lang=None` answers carry the hash Odoo would send; for the plain case it equals the
 * generated one (asserted).
 *
 * Owned by stream H2.
 */
import { genAssetJson } from "../gen_assets";
import { HttpError, NotPorted } from "../errors";
import type { RequestContext } from "../http/context";
import { route } from "../http/router";
import { STATIC_CACHE_LONG } from "./stream";
import { templateOf } from "../orm/template";
import { installedModules } from "../http/modules";

interface TranslationsBody {
  readonly lang: string;
  readonly hash: string;
  readonly lang_parameters: Record<string, unknown> | null;
  readonly modules: Record<string, unknown>;
  readonly multi_lang: boolean;
}

/** Per corpus template (src/orm/template.ts: gen/out/ for poc_corpus, gen/out/poc_erp/ for C1), then per lang. */
const LOADERS: Readonly<Record<string, Readonly<Record<string, () => Promise<{ default: unknown }>>>>> = {
  "": {
    en_US: () => import("../../gen/out/translations/en_US.json"),
    fr_FR: () => import("../../gen/out/translations/fr_FR.json"),
  },
  poc_erp: {
    en_US: () => import("../../gen/out/poc_erp/translations/en_US.json"),
    fr_FR: () => import("../../gen/out/poc_erp/translations/fr_FR.json"),
  },
};

const CACHE = new Map<string, Promise<TranslationsBody>>();

function loadTranslations(template: string, lang: string): Promise<TranslationsBody> {
  const cacheKey = `${template}/${lang}`;
  let p = CACHE.get(cacheKey);
  if (p === undefined) {
    const loader = LOADERS[template]?.[lang];
    // languages installed at runtime (src/models/lang_install.ts): gen/lang_install.py writes the body next to the
    // terms, packaged as a static asset (src/gen_assets.ts) rather than bundled
    const load: () => Promise<unknown> = loader !== undefined ? async () => (await loader()).default
      : template !== "" ? () => genAssetJson(`${template}/lang/${lang}.webclient.json`)
        : () => { throw new NotPorted(`translations for ${lang} (gen/translations.py generates en_US and fr_FR)`); };
    p = load().then((raw: unknown) => {
      if (typeof raw !== "object" || raw === null) throw new NotPorted(`gen/out/translations/${lang}.json has no object body`);
      const o = raw as Record<string, unknown>;
      const lp = o["lang_parameters"];
      const modules = o["modules"];
      if (typeof modules !== "object" || modules === null) throw new NotPorted(`translations/${lang}.json: modules`);
      return {
        lang: String(o["lang"]),
        hash: String(o["hash"]),
        lang_parameters: typeof lp === "object" && lp !== null ? (lp as Record<string, unknown>) : null,
        modules: modules as Record<string, unknown>,
        multi_lang: o["multi_lang"] === true,
      };
    }).catch((e) => {
      CACHE.delete(cacheKey);
      throw e;
    });
    CACHE.set(cacheKey, p);
  }
  return p;
}

/**
 * Python `json.dumps(value, sort_keys=True)` (or `sortKeys` false: `json.dumps(value)`, insertion order) with the default separators and ensure_ascii=True, for the value
 * shapes the translation cache holds (null, bool, int, str, list, dict). Floats raise: their repr is not ported.
 */
export function pyJsonDumps(value: unknown, sortKeys = true): string {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new NotPorted("json.dumps of a float");
    return String(value);
  }
  if (typeof value === "string") return pyJsonString(value);
  if (Array.isArray(value)) return `[${value.map((v) => pyJsonDumps(v, sortKeys)).join(", ")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const keys = sortKeys ? Object.keys(o).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) : Object.keys(o);
    return `{${keys.map((k) => `${pyJsonString(k)}: ${pyJsonDumps(o[k], sortKeys)}`).join(", ")}}`;
  }
  throw new NotPorted(`json.dumps of ${typeof value}`);
}

function pyJsonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i] ?? "";
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c < 0x20 || c > 0x7e) out += `\\u${c.toString(16).padStart(4, "0")}`; // UTF-16 units = Python's surrogate pairs
    else out += ch;
  }
  return `${out}"`;
}

async function sha1Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** webclient.py:50 `translations`. */
async function translations(ctx: RequestContext): Promise<Response> {
  return translationsResponse(ctx, ctx.url.searchParams.get("hash"), ctx.url.searchParams.get("mods"), ctx.url.searchParams.get("lang"));
}

/**
 * `_get_translation_frontend_modules_name` overrides (http_routing/models/ir_http.py:297 `['web']`, then each module's
 * `mods + [...]` in load order): portal/models/ir_http.py:11, payment/models/ir_http.py:10, portal_rating/models/ir_http.py:11.
 * The other overriding modules of the source tree are refused when installed.
 */
const FRONTEND_MODULE_OVERRIDES = ["portal", "payment", "portal_rating"];
const FRONTEND_MODULE_UNPORTED = ["auth_password_policy_portal", "auth_password_policy_signup", "website", "website_livechat",
  "mass_mailing", "point_of_sale", "delivery", "pos_self_order", "survey", "website_mail", "pos_online_payment_self_order"];

/** http_routing/controllers/main.py:12-18 `get_website_translations`. */
async function websiteTranslations(ctx: RequestContext): Promise<Response> {
  const mods = await installedModules(ctx.cursor());
  for (const m of FRONTEND_MODULE_UNPORTED) {
    if (mods.has(m)) throw new NotPorted(`${m}/models/ir_http.py _get_translation_frontend_modules_name`);
  }
  // get_translation_frontend_modules (http_routing/models/ir_http.py:279-288): the domain part is empty (:290)
  const modules = ["web", ...FRONTEND_MODULE_OVERRIDES.filter((m) => mods.has(m))];
  const extra = ctx.url.searchParams.get("mods");
  if (extra !== null && extra !== "") modules.push(...extra.split(","));
  return translationsResponse(ctx, ctx.url.searchParams.get("hash"), modules.join(","), ctx.url.searchParams.get("lang"));
}

async function translationsResponse(ctx: RequestContext, hash: string | null, modsParam: string | null, langArg: string | null): Promise<Response> {
  const cr = ctx.cursor();
  let lang = langArg;
  // :62-63: a lang that is not installed is treated as None
  const installed = await cr.query<{ code: string }>("SELECT code FROM res_lang WHERE active ORDER BY name");
  const codes = new Set(installed.rows.map((r) => r.code));
  if (lang !== null && lang !== "" && !codes.has(lang)) lang = null;
  if (lang === "") lang = null;
  // _get_translations_for_webclient: `if not lang: lang = self.env.context.get("lang")` (ir_http.py:543)
  const ctxLang = ctx.context.lang;
  const dataLang = lang ?? (typeof ctxLang === "string" && ctxLang !== "" ? ctxLang : "en_US");
  const template = await templateOf(cr);
  // a template with an overlay (poc_erp_se) has its own body for the languages installed at runtime there
  // (gen/lang_install.py with GEN_TEMPLATE=poc_erp_se); its other languages are the base template's
  const base = template.overlay !== undefined && LOADERS[template.dir]?.[dataLang] === undefined
    ? await loadTranslations(template.overlay, dataLang) : await loadTranslations(template.dir, dataLang);
  let modules = base.modules;
  if (modsParam !== null && modsParam !== "") {
    // :57-58: a comma separated list; code_translations.get_web_translations(module, lang) for each
    const picked: Record<string, unknown> = {};
    for (const m of modsParam.split(",")) {
      const v = base.modules[m];
      if (v === undefined) throw new NotPorted(`translations for module ${m} are not in gen/out/translations/${dataLang}.json`);
      picked[m] = v;
    }
    modules = picked;
  }
  // lang_parameters: res.lang._lang_get(lang) of the data language, None when inactive (ir_http.py:544-555)
  const langParameters = codes.has(dataLang) ? base.lang_parameters : null;
  const multiLang = codes.size > 1;
  const cache = { lang_parameters: langParameters, modules, lang, multi_lang: multiLang };
  const currentHash = await sha1Hex(pyJsonDumps(cache));
  if (modsParam === null && lang !== null && multiLang === base.multi_lang && langParameters === base.lang_parameters && currentHash !== base.hash) {
    throw new NotPorted(`translations hash mismatch: recomputed ${currentHash}, generated ${base.hash}`);
  }
  const body: Record<string, unknown> = { lang, hash: currentHash };
  if (currentHash !== hash) {
    body["lang_parameters"] = langParameters;
    body["modules"] = modules;
    body["multi_lang"] = multiLang;
  }
  // request.make_json_response(body, [('Cache-Control', 'public, max-age=31536000')]) (:86-88); the route's
  // cors='*' and nosniff are the dispatcher's (post_dispatch)
  return ctx.makeJsonResponse(body, {
    "Cache-Control": `public, max-age=${STATIC_CACHE_LONG}`,
    "X-Content-Type-Options": "nosniff",
  });
}

route("/website/translations", async (ctx) => {
  if (!(await installedModules(ctx.cursor())).has("http_routing")) throw new HttpError(404, "Not Found");
  return websiteTranslations(ctx);
}, { auth: "public", readonly: true });
route(["/web/webclient/translations", "/web/webclient/translations/<string:unique>"], translations, { auth: "public", readonly: true, cors: "*" });
