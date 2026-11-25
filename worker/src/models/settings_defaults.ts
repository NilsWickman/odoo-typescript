/**
 * `res.config.settings.default_get` (odoo/odoo/addons/base/models/res_config.py:237-283): after the generic defaults,
 * every field is valued by its kind (`_get_classified_fields`, :177-228):
 *   group_*   whether every group of the field (`group`, default base.group_user) implies `implied_group`
 *             (`all_implied_ids` includes the group itself); a selection field gets '1'/'0'
 *   module_*  whether the module is installed, to install or to upgrade (only modules that exist in ir_module_module)
 *   config    ir.config_parameter `config_parameter` converted to the field's type (get_str/int/float/bool,
 *             ir_config_parameter.py:100-160), else the field's default
 * and then `get_values()`, whose overrides in the template are those of mail, purchase_stock, crm_iap_enrich and
 * auth_totp_mail (ported below). The Python-only attributes come from gen/settings_fields.py
 * (gen/out/poc_erp/settings_fields.json; a site over poc_erp from its overlay's own file, written by compiler/sitebuild.py);
 * another template, a site built without the file, an unported override or a `default_*` field refuses.
 */
import { NotPorted } from "../errors";
import { checkModelAccess } from "../orm/access";
import { templateKey, templateOf } from "../orm/template";
import { registerOverrides } from "../orm/write";
import { registerDefaultResolver, registerDefaults } from "../orm/recompute";
import { withOverlay } from "../orm/overlay";
import settingsFields from "../../gen/out/poc_erp/settings_fields.json" with { type: "json" };
import type { Environment } from "../orm/types";

export interface SettingsField {
  kind: "default" | "group" | "module" | "config" | "other";
  type: string;
  implied_group: string | null;
  group: string[] | null;
  config_parameter: string | null;
  default_model: string | null;
  comodel: string | null;
  default: { const: unknown } | "callable" | null;
}
export interface SettingsData { fields: Record<string, SettingsField>; overrides: { get_values: string[]; default_get: string[] } }

const PORTED_GET_VALUES = new Set(["auth_totp_mail", "crm_iap_enrich", "mail", "purchase_stock"]);

const DATA = new Map<string, Promise<SettingsData>>();
export async function settingsData(env: Environment): Promise<SettingsData> {
  const t = await templateOf(env.cr);
  if (t.dir !== "poc_erp") throw new NotPorted(`res.config.settings default_get on template ${t.name} (gen/settings_fields.py covers poc_erp and its sites)`);
  let p = DATA.get(templateKey(t));
  if (!p) {
    // a site: its overlay's settings_fields.json is the whole file (template_delta.py does not reduce it), so its top
    // level replaces the base's
    p = withOverlay(t, "settings_fields.json", settingsFields as unknown as SettingsData, null);
    DATA.set(templateKey(t), p);
  }
  const d = await p;
  const unported = [...d.overrides.get_values.filter((m) => !PORTED_GET_VALUES.has(m)), ...d.overrides.default_get];
  if (unported.length) throw new NotPorted(`res.config.settings get_values/default_get of ${unported.join(", ")}`);
  return d;
}

/**
 * The rows default_get reads per field (one query per kind instead of one per field: on the site every statement is a
 * round trip to the VPS, about 5.5 ms, and the Settings page's 150 single-row lookups were 0.8 of its 1.1-1.3 s,
 * Workers Logs 2026-11-17 17:04-17:05). Read at the start of the call, as Odoo's per-field reads see the same rows.
 */
interface Prefetch { xmlids: Map<string, number>; closure: Map<number, Set<number>>; modules: Map<string, string>; icp: Map<string, string | null> }

async function prefetch(env: Environment, d: SettingsData, fields: readonly string[]): Promise<Prefetch> {
  const xmlids = new Set<string>(), modules: string[] = [], keys = new Set<string>();
  for (const name of fields) {
    const f = d.fields[name];
    if (!f) continue;
    if (f.kind === "group") { xmlids.add(f.implied_group!); for (const g of f.group ?? ["base.group_user"]) xmlids.add(g); }
    else if (f.kind === "module") modules.push(name.slice(7));
    else if (f.kind === "config") keys.add(f.config_parameter!);
  }
  if (env.reg.model("res.config.settings").fields.has("auth_totp_enforce")) keys.add("auth_totp.policy");
  const out: Prefetch = { xmlids: new Map(), closure: new Map(), modules: new Map(), icp: new Map() };
  if (xmlids.size) {
    const pairs = [...xmlids].map((x) => x.split("."));
    const r = await env.cr.query<{ module: string; name: string; res_id: number }>(
      `SELECT d.module, d.name, d.res_id FROM ir_model_data d
         JOIN unnest($1::text[], $2::text[]) AS x(module, name) ON d.module = x.module AND d.name = x.name`,
      [pairs.map((p) => p[0]), pairs.map((p) => p[1])]);
    for (const row of r.rows) out.xmlids.set(`${row.module}.${row.name}`, Number(row.res_id));
    // `all_implied_ids` of every group a field names (the transitive closure of implied_ids, the group included)
    const roots = [...new Set(fields.flatMap((n) => { const f = d.fields[n]; return f?.kind === "group" ? (f.group ?? ["base.group_user"]) : []; }))]
      .map((x) => out.xmlids.get(x)).filter((id): id is number => id !== undefined);
    if (roots.length) {
      const c = await env.cr.query<{ root: number; id: number }>(
        `WITH RECURSIVE g(root, id) AS (SELECT r, r FROM unnest($1::int[]) AS r
           UNION SELECT g.root, i.hid FROM res_groups_implied_rel i JOIN g ON i.gid = g.id) SELECT root, id FROM g`, [roots]);
      for (const row of c.rows) {
        const s = out.closure.get(Number(row.root)) ?? new Set<number>();
        s.add(Number(row.id)); out.closure.set(Number(row.root), s);
      }
    }
  }
  if (modules.length) {
    const r = await env.cr.query<{ name: string; state: string }>("SELECT name, state FROM ir_module_module WHERE name = ANY($1::text[])", [modules]);
    for (const row of r.rows) out.modules.set(row.name, row.state);
  }
  if (keys.size) {
    const r = await env.cr.query<{ key: string; value: string | null }>("SELECT key, value FROM ir_config_parameter WHERE key = ANY($1::text[])", [[...keys]]);
    for (const row of r.rows) out.icp.set(row.key, row.value);
  }
  return out;
}

function xmlidRes(pf: Prefetch, xmlid: string): number {
  const id = pf.xmlids.get(xmlid);
  // res_config.py:193-195 ref(): _xmlid_to_res_model_res_id raises for a missing xmlid
  if (id === undefined) throw new NotPorted(`res.config.settings: missing xmlid ${xmlid}`);
  return id;
}

/** `implied_group in group.all_implied_ids` (res_groups: the transitive closure of implied_ids, the group included). */
function implies(pf: Prefetch, group: number, implied: number): boolean {
  return pf.closure.get(group)?.has(implied) ?? false;
}

/** ir_config_parameter.py:130-160 `_get` + `_convert`: undefined (null) when missing, NULL or invalid for the type. */
function icp(pf: Prefetch, key: string, type: "str" | "int" | "float" | "bool"): unknown {
  const v = pf.icp.get(key);
  if (v === undefined || v === null) return undefined;
  switch (type) {
    case "str": return v;
    case "bool": {
      // tools/misc.py:439-461 str2bool without default: ValueError (INVALID_VALUE) for anything else
      const s = v.toLowerCase();
      if (["y", "yes", "1", "true", "t", "on"].includes(s)) return true;
      if (["n", "no", "0", "false", "f", "off"].includes(s)) return false;
      return undefined;
    }
    case "int": {
      // Python int(str): surrounding whitespace, a sign, digits with single underscores between them
      const m = /^\s*([+-]?)(\d+(?:_\d+)*)\s*$/.exec(v);
      if (!m) return undefined;
      const n = Number(BigInt(m[1] + m[2]!.replace(/_/g, "")));
      if (!Number.isSafeInteger(n)) throw new NotPorted(`ir.config_parameter ${key}: integer beyond 2^53`);
      return n;
    }
    case "float": {
      const t = v.trim().replace(/(?<=\d)_(?=\d)/g, "");
      if (/^[+-]?(inf|infinity|nan)$/i.test(t)) throw new NotPorted(`ir.config_parameter ${key}: non-finite float`);
      if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) return undefined;
      return Number(t);
    }
  }
}

function fieldDefault(f: SettingsField, name: string, fallback: unknown): unknown {
  if (f.default === null) return fallback;
  if (f.default === "callable") throw new NotPorted(`res.config.settings.${name}: a callable default`);
  // `field.default(self) if field.default else <fallback>`: a constant default that is falsy still counts as given
  return f.default.const;
}

registerOverrides("res.config.settings", {
  defaultGet: async (env, fields, values) => {
    if (!fields.length) return;
    const d = await settingsData(env);
    // :242 self.check_access('read')
    await checkModelAccess(env, env.reg.model("res.config.settings"), "read");
    const pf = await prefetch(env, d, fields);
    for (const name of fields) {
      const f = d.fields[name];
      if (!f) {
        if (env.reg.model("res.config.settings").fields.has(name)) throw new NotPorted(`res.config.settings.${name} is not in gen/out/poc_erp/settings_fields.json`);
        continue;
      }
      switch (f.kind) {
        case "other": break;
        case "default": throw new NotPorted(`res.config.settings.${name}: a default_* field (ir.default._get)`);
        case "group": {
          const implied = xmlidRes(pf, f.implied_group!);
          let all = true;
          for (const g of f.group ?? ["base.group_user"]) if (!implies(pf, xmlidRes(pf, g), implied)) all = false;
          values[name] = f.type === "selection" ? (all ? "1" : "0") : all;
          break;
        }
        case "module": {
          const state = pf.modules.get(name.slice(7));
          // :217-218 `IrModule._get(name)`: a module that does not exist adds nothing
          if (state !== undefined) values[name] = ["installed", "to install", "to upgrade"].includes(state);
          break;
        }
        case "config": {
          const key = f.config_parameter!;
          let value: unknown;
          switch (f.type) {
            case "char": case "datetime": case "selection": value = (icp(pf, key, "str")) ?? fieldDefault(f, name, false); break;
            case "integer": value = (icp(pf, key, "int")) ?? fieldDefault(f, name, 0); break;
            case "float": value = (icp(pf, key, "float")) ?? fieldDefault(f, name, 0.0); break;
            case "boolean": value = (icp(pf, key, "bool")) ?? fieldDefault(f, name, false); break;
            case "many2one": {
              const id = (icp(pf, key, "int")) ?? fieldDefault(f, name, 0);
              if (typeof id !== "number") throw new NotPorted(`res.config.settings.${name}: many2one default ${String(id)}`);
              // :273-275 `browse(value).exists().id`: False for 0 or a deleted record
              const table = env.reg.model(f.comodel!).table;
              value = id && (await env.cr.query(`SELECT 1 FROM "${table}" WHERE id = $1`, [id])).rows.length ? id : false;
              break;
            }
            default: throw new NotPorted(`res.config.settings.${name}: config field of type ${f.type}`);
          }
          values[name] = value;
          break;
        }
      }
    }
    // :281 res.update(self.get_values()): every key, requested or not
    const reg = env.reg.model("res.config.settings").fields;
    // mail res_config_settings.py:90-94, :100-110 `_get_sfu_client_asset().active`
    if (reg.has("use_custom_sfu_client")) {
      const a = (await env.cr.query<{ active: boolean | null }>(
        `SELECT active FROM ir_asset WHERE bundle = 'mail.assets_odoo_sfu' AND directive = 'replace'
            AND path = '/_custom/mail/static/lib/odoo_sfu/odoo_sfu.js' AND target = '/mail/static/lib/odoo_sfu/odoo_sfu.js'
          ORDER BY sequence, id LIMIT 1`)).rows[0];
      values["use_custom_sfu_client"] = a ? Boolean(a.active) : false;
    }
    // purchase_stock res_config_settings.py:16-21: the id of the installed sale module (an int, as Odoo returns it)
    if (reg.has("is_installed_sale")) {
      const m = (await env.cr.query<{ id: number }>("SELECT id FROM ir_module_module WHERE name = 'sale' AND state = 'installed' ORDER BY id LIMIT 1")).rows[0];
      values["is_installed_sale"] = m ? m.id : false;
    }
    // crm_iap_enrich res_config_settings.py:11-15: 'auto' when its cron exists and is active
    if (reg.has("lead_enrich_auto")) {
      const cron = (await env.cr.query<{ active: boolean | null }>(
        `SELECT c.active FROM ir_model_data d JOIN ir_cron c ON c.id = d.res_id
          WHERE d.module = 'crm_iap_enrich' AND d.name = 'ir_cron_lead_enrichment' AND d.model = 'ir.cron'`)).rows[0];
      values["lead_enrich_auto"] = cron && cron.active ? "auto" : "manual";
    }
    // auth_totp_mail res_config_settings.py:28-31: bool(get_str('auth_totp.policy'))
    if (reg.has("auth_totp_enforce")) {
      const p = icp(pf, "auth_totp.policy", "str");
      values["auth_totp_enforce"] = typeof p === "string" && p !== "";
    }
  },
});

// A field of a new settings record that nobody assigned reads its default through default_get (fields.py:1855-1870,
// src/web/onchange.ts defaultOf) only when the field has one registered: mark every classified field and the
// get_values keys, whose value the override above sets (Odoo's `_add_missing_default_values` asks default_get for all
// fields at once, so a compute reading e.g. a config field sees its value).
const classified = Object.entries((settingsFields as unknown as SettingsData).fields).filter(([, f]) => f.kind !== "other").map(([n]) => n);
registerDefaults("res.config.settings", Object.fromEntries([...classified, "use_custom_sfu_client", "is_installed_sale", "lead_enrich_auto", "auth_totp_enforce"]
  .map((n) => [n, async () => undefined])));
// a site's classified fields beyond poc_erp's (its new modules' settings: auth_password_policy minlength)
registerDefaultResolver("res.config.settings", async (env, name) => {
  if (!(await templateOf(env.cr)).overlay) return false;
  const f = (await settingsData(env)).fields[name];
  return f !== undefined && f.kind !== "other";
});
