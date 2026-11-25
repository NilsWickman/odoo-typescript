/**
 * What Odoo reads from module files at runtime, from gen/out/poc_erp/apps.json (worker/gen/apps.py): the chart template
 * selection of res.company (account/models/chart_template.py:131-141) and the file-backed computes of ir.module.module
 * (base/models/ir_module.py). `_chart_template_selection` runs on an empty record in `fields_get`: `not country`, so
 * the generic chart goes first and the rest keeps the mapping's order. Other languages translate the country part of
 * the labels (chartNames).
 */
import { fetchStaticAsset } from "../controllers/static";
import { NotPorted } from "../errors";
import { requestOfCursor } from "../http/context";
import { registerMethod } from "../http/methods";
import { hooksOf, registerHooks } from "../orm/hooks";
import { registerDefaults } from "../orm/recompute";
import { binaryBytes } from "../orm/values";
import { envFor } from "../web/common";
import type { Environment } from "../orm/types";
import { defineComputes } from "./tail_util";
import { ATTACHMENT_COLUMNS, attachmentValue, type AttachmentRow } from "./binary";

interface AppsData {
  charts: { code: string; name: string; country_id: number | false; module: string }[];
  icons: Record<string, string>;
  modules: Record<string, { description_html: string; icon_flag: string; icon: string; installed_version: string }>;
  rating_images: Record<string, string>;
}

let data: AppsData | null = null;
async function apps(env: Environment): Promise<AppsData> {
  if (!env.reg.models.has("account.chart.template")) throw new NotPorted("gen/out/<template>/apps.json of a template without account");
  data ??= (await import("../../gen/out/poc_erp/apps.json")).default as unknown as AppsData;
  return data;
}

/** chart_template.py:131-145 `_guess_chart_template(country)`: the first template of the country, else the first one. */
export async function guessChartTemplate(env: Environment, country: number): Promise<{ code: string; module: string }> {
  const { charts } = await apps(env);
  return charts.find((c) => c.country_id === country) ?? charts[0]!;
}

/**
 * account ir_module.py:9-16 `templ`: a template's name is "<flag> <country name> - <template name>", where the country
 * name is res.country.name in the request's language (`_compute_account_templates` runs per environment) and the
 * template name is the one TEMPLATE_REGISTER (ir_module.py:39-70) froze at the process's first computation. apps.json
 * has the en_US names; the template part stays as generated (Odoo's process computes it once, measured English on the
 * oracle with sv_SE requests), the country part is translated. A name that does not start with its country's English
 * name refuses.
 */
async function chartNames(env: Environment, charts: AppsData["charts"]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const lang = env.lang ?? "en_US";
  if (lang === "en_US") { for (const c of charts) out.set(c.code, c.name); return out; }
  const ids = [...new Set(charts.map((c) => c.country_id).filter((x): x is number => x !== false))];
  const rows = (await env.cr.query<{ id: number; code: string; en: string; tr: string }>(
    "SELECT id, code, name->>'en_US' AS en, COALESCE(name->>$2, name->>'en_US') AS tr FROM res_country WHERE id = ANY($1::int[])", [ids, lang])).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const c of charts) {
    if (c.country_id === false) { out.set(c.code, c.name); continue; }
    const r = byId.get(c.country_id);
    // tools/business_data.py:76-83 get_flag: the two regional indicator symbols of an upper-case country code
    const flag = r && /^[A-Z]{2}$/.test(r.code) ? [...r.code].map((ch) => String.fromCodePoint(0x1f1e6 + ch.charCodeAt(0) - 65)).join("") : "";
    const prefix = r ? `${flag} ${r.en}` : "";
    if (!r || !(c.name === prefix || c.name.startsWith(`${prefix} - `))) throw new NotPorted(`chart template label ${c.code} in ${lang}`);
    out.set(c.code, `${flag} ${r.tr}${c.name.slice(prefix.length)}`);
  }
  return out;
}

registerHooks("res.company", {
  selection: {
    chart_template: async (env) => {
      const { charts } = await apps(env);
      const names = await chartNames(env, charts);
      return [...charts.filter((c) => c.code === "generic_coa"), ...charts.filter((c) => c.code !== "generic_coa")]
        .map((c) => [c.code, names.get(c.code)!] as [string, string]);
    },
  },
});
// account res_config_settings.py:38: the selection of the company, the default its value
registerHooks("res.config.settings", {
  selection: {
    // chart_template.py:131-141 on the current company: the templates of its country first
    chart_template: async (env) => {
      const { charts } = await apps(env);
      const country = (await env.cr.query<{ c: number | null }>(
        "SELECT p.country_id AS c FROM res_company c JOIN res_partner p ON p.id = c.partner_id WHERE c.id = $1", [await env.company()])).rows[0]?.c ?? null;
      if (country === null) return hooksOf("res.company").selection!["chart_template"]!(env);
      const names = await chartNames(env, charts);
      return [...charts.filter((c) => c.country_id === country), ...charts.filter((c) => c.country_id !== country)].map((c) => [c.code, names.get(c.code)!] as [string, string]);
    },
  },
});
registerDefaults("res.config.settings", {
  chart_template: async (env) => (await env.cr.query<{ c: string | null }>("SELECT chart_template AS c FROM res_company WHERE id = $1", [await env.company()])).rows[0]?.c ?? false,
});

const moduleOf = async (env: Environment, name: unknown): Promise<AppsData["modules"][string]> => {
  const m = (await apps(env)).modules[String(name)];
  if (!m) throw new NotPorted(`ir.module.module ${String(name)} without generated data`);
  return m;
};

/** ir_ui_menu.py `_get_full_name(level=6)`: the parents joined with '/', cut with '...' six levels up. */
async function menuPath(env: Environment, id: number, level = 6): Promise<string> {
  if (level <= 0) return "...";
  const row = (await env.cr.query<{ parent_id: number | null; name: string | null }>(
    "SELECT parent_id, COALESCE(name->>$2, name->>'en_US') AS name FROM ir_ui_menu WHERE id = $1", [id, env.lang ?? "en_US"])).rows[0];
  if (!row) return "";
  return row.parent_id ? `${await menuPath(env, row.parent_id, level - 1)}/${row.name ?? ""}` : row.name ?? "";
}

/** ir_module.py:222-252 `_get_views`, one of the three lists: empty unless installed, else sorted lines. */
async function moduleData(env: Environment, state: unknown, name: unknown, model: string): Promise<string> {
  if (!["installed", "to upgrade", "to remove"].includes(String(state))) return "";
  const ids = (await env.cr.query<{ res_id: number }>(
    "SELECT res_id FROM ir_model_data WHERE module = $1 AND model = $2 AND res_id IS NOT NULL AND res_id != 0", [name, model])).rows.map((r) => r.res_id);
  if (!ids.length) return "";
  let lines: string[];
  if (model === "ir.ui.view") {
    lines = (await env.cr.query<{ name: string; type: string; inherit_id: number | null }>(
      "SELECT name, type, inherit_id FROM ir_ui_view WHERE id = ANY($1::int[])", [ids])).rows
      .map((v) => `${v.inherit_id ? "* INHERIT " : ""}${v.name} (${v.type})`);
  } else if (model === "ir.actions.report") {
    lines = (await env.cr.query<{ name: string }>(
      "SELECT COALESCE(name->>$2, name->>'en_US') AS name FROM ir_act_report_xml WHERE id = ANY($1::int[])", [ids, env.lang ?? "en_US"])).rows.map((r) => r.name);
  } else {
    const existing = (await env.cr.query<{ id: number }>("SELECT id FROM ir_ui_menu WHERE id = ANY($1::int[])", [ids])).rows.map((r) => r.id);
    lines = [];
    for (const id of existing) lines.push(await menuPath(env, id));
  }
  return lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join("\n");
}

/**
 * Imported data modules have no files on disk (base_import_module ir_module.py): no manifest, so no flag and the
 * version is `latest_version` (`_get_latest_version`); the icon is the module's static attachment, else the file of
 * its icon path (base's); the description is docutils' rendering of `description` (an empty one only).
 */
async function importedModule(env: Environment, id: number | null): Promise<{ icon: string | null; latest_version: string | null; description: string | null } | null> {
  if (id === null) return null;
  const row = (await env.cr.query<{ imported: boolean | null; icon: string | null; latest_version: string | null; description: string | null }>(
    "SELECT (to_jsonb(m) ->> 'imported')::boolean AS imported, icon, latest_version, description->>'en_US' AS description FROM ir_module_module m WHERE id = $1", [id])).rows[0];
  return row?.imported ? row : null;
}

defineComputes("ir.module.module", {
  icon_flag: async (env, rec) => {
    if (rec.id === null) return "";
    if (await importedModule(env, rec.id)) return "";
    return (await moduleOf(env, await rec.get("name"))).icon_flag;
  },
  icon_image: async (env, rec) => {
    if (rec.id === null) return false;
    const imp = await importedModule(env, rec.id);
    if (imp) {
      // base_import_module ir_module.py `_get_icon_image`: `attachment.raw` of the static icon (the stored file)
      const att = (await env.cr.query<AttachmentRow>(
        `SELECT ${ATTACHMENT_COLUMNS} FROM ir_attachment WHERE url = $1 AND type = 'binary' AND res_model = 'ir.ui.view' ORDER BY id LIMIT 1`, [imp.icon])).rows[0];
      if (att) return attachmentValue(env, { ...att, res_field: null });
      if (imp.icon !== "/base/static/description/icon.png") return false;
      const sha = (await moduleOf(env, "base")).icon;
      return sha ? binaryBytes(Buffer.from((await apps(env)).icons[sha]!, "base64")) : false;
    }
    const sha = (await moduleOf(env, await rec.get("name"))).icon;
    if (!sha) return false;
    return binaryBytes(Buffer.from((await apps(env)).icons[sha]!, "base64"));
  },
  installed_version: async (env, rec) => {
    const imp = await importedModule(env, rec.id);
    if (imp?.latest_version) return imp.latest_version;
    return (await moduleOf(env, await rec.get("name"))).installed_version;
  },
  description_html: async (env, rec) => {
    const imp = await importedModule(env, rec.id);
    if (imp) {
      // docutils publish_string('') through MyWriter and html_sanitize (measured on Odoo)
      if (imp.description) throw new NotPorted("description_html of an imported module with a description (docutils)");
      return '<div class="document">\n\n\n\n</div>\n\n';
    }
    return (await moduleOf(env, await rec.get("name"))).description_html;
  },
  views_by_module: async (env, rec) => moduleData(env, await rec.get("state"), await rec.get("name"), "ir.ui.view"),
  reports_by_module: async (env, rec) => moduleData(env, await rec.get("state"), await rec.get("name"), "ir.actions.report"),
  menus_by_module: async (env, rec) => moduleData(env, await rec.get("state"), await rec.get("name"), "ir.ui.menu"),
});

/** rating.py:98-113 the image of `_rating_to_threshold` (rating_data.py:77-87). */
const ratingThreshold = (v: number): number => (v >= 4 ? 5 : v >= 3 ? 3 : v >= 1 ? 1 : 0);
defineComputes("rating.rating", {
  rating_image: async (env, rec) => {
    const v = Number(await rec.get("rating") || 0);
    return binaryBytes(Buffer.from((await apps(env)).rating_images[String(ratingThreshold(v))]!, "base64"));
  },
  rating_image_url: async (_env, rec) => `/rating/static/src/img/rating_${ratingThreshold(Number(await rec.get("rating") || 0))}.png`,
});

// base res_company.py:73-75 _get_logo
registerDefaults("res.company", {
  // stock res_company.py:10-14 _default_confirmation_mail_template, stock_sms res_company.py:10-14
  stock_mail_confirmation_template_id: async (env) => (await env.reg.xmlid(env.cr, "stock.mail_template_data_delivery_confirmation")) ?? false,
  stock_sms_confirmation_template_id: async (env) => (await env.reg.xmlid(env.cr, "stock_sms.sms_template_data_stock_delivery")) ?? false,
  // barcodes res_company.py:9-10 _get_default_nomenclature
  nomenclature_id: async (env) => (await env.reg.xmlid(env.cr, "barcodes.default_barcode_nomenclature")) ?? false,
  logo: async (env) => {
    const request = requestOfCursor(env.cr);
    if (request === null) throw new NotPorted("res.company.logo default outside a request");
    const file = await fetchStaticAsset(request.env, "/base/static/img/res_company_logo.png");
    if (file === null) throw new NotPorted("base/static/img/res_company_logo.png missing from the assets");
    return { content: Buffer.from(file.data).toString("base64"), filename: "logo.png" };
  },
});

/** rating.py:174-181 `action_open_rated_object`. */
registerMethod("rating.rating", "action_open_rated_object", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  if (ids?.length !== 1) throw new NotPorted("rating.rating.action_open_rated_object on several records (Expected singleton)");
  const [row] = await env.model("rating.rating").read(ids, ["res_model", "res_id"], "");
  return { type: "ir.actions.act_window", res_model: row!["res_model"], res_id: row!["res_id"], views: [[false, "form"]] };
}, { apiModel: false });

// ir_module.py:1075-1078, :1135-1138 `_compute_state`: the state of the named module, else 'unknown'
const namedModuleState = async (env: Environment, name: unknown): Promise<string> =>
  (await env.cr.query<{ state: string | null }>("SELECT state FROM ir_module_module WHERE name = $1", [name])).rows[0]?.state ?? "unknown";
defineComputes("ir.module.module.dependency", { state: async (env, rec) => namedModuleState(env, await rec.get("name")) });
defineComputes("ir.module.module.exclusion", { state: async (env, rec) => namedModuleState(env, await rec.get("name")) });

/** ir_module.py:502-503 `check_module_update`. */
registerMethod("ir.module.module", "check_module_update", async (env0, _ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  return (await env.cr.query("SELECT 1 FROM ir_module_module WHERE state IN ('to install', 'to upgrade', 'to remove') LIMIT 1")).rows.length > 0;
}, { apiModel: true, readonly: true });
