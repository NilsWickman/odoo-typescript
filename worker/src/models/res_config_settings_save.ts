/**
 * Saving the Settings page: `res.config.settings` create (odoo/odoo/addons/base/models/res_config.py:518-550), the
 * inverse methods it runs, and `execute` (:347-403) with `set_values` of base (:290-345) and of every installed module
 * that overrides it, in the template's MRO (poc_erp, read from the registry with `odoo-bin shell`):
 *   sale_management, sale, crm_iap_enrich, purchase, stock, project, crm, account, product, mail, base.
 * Each override's code before `super()` runs on the way down, its code after on the way back, so the effects come in
 * the order of `setValues` below. Installing or uninstalling a module through a `module_*` field refuses (NotPorted),
 * as do the branches that would need more than the port has (a chart of accounts, a Peppol proxy, the registry setup
 * of crm.lead's scoring fields, a custom SFU client, the users' share recomputation).
 */
import { AccessError, NotPorted, OdooError, UserError, ValidationError } from "../errors";
import { registerMethod } from "../http/methods";
import { irModelId } from "../mail/alias_mixin";
import { cond, and, TRUE } from "../orm/domain";
import { create } from "../orm/create";
import { convertToCache } from "../orm/convert";
import { isPyFloat } from "../orm/values";
import { registerOverrides, write } from "../orm/write";
import { DbRec, type Rec, recordCompute, registerRecordCompute } from "../orm/recompute";
import { hooksOf, registerHooks } from "../orm/hooks";
import { guardOverride } from "../orm/override_guard";
import type { Environment, FieldDef } from "../orm/types";
import { dictEntries, evalExpr, isDict, pyRepr } from "../pyexpr";
import { defaultGet } from "../web/defaults";
import { isAdmin } from "./account_buttons";
import { fieldOrder } from "./base_import";
import { checkGroupRegular } from "./res_users_groups";
import { settingsData, type SettingsField } from "./settings_defaults";
import { translate } from "./util";

const S = "res.config.settings";

async function ref(env: Environment, xmlid: string): Promise<number | null> {
  return env.reg.xmlid(env.cr, xmlid);
}

/** The comparable form of a cache value (`convert_to_record` equality): ids for relations, numbers for numbers. */
function comparable(field: FieldDef, v: unknown): unknown {
  if (isPyFloat(v)) return v.float;
  switch (field.type) {
    case "many2one": return Array.isArray(v) ? v[0] : v || false;
    case "integer": case "float": case "monetary": return typeof v === "number" ? v : 0;
    case "boolean": return Boolean(v);
    case "one2many": case "many2many": throw new NotPorted(`res.config.settings create: related x2many ${field.name}`);
    default: return v === null || v === undefined ? false : v;
  }
}

/** The value of `path` (field names) from the record `id` of `model` (`old_value[:1][fname]` per step). */
async function pathValue(env: Environment, model: string, id: number | false, path: readonly string[]): Promise<{ field: FieldDef; value: unknown }> {
  let m = env.reg.model(model);
  let cur: number | false = id;
  for (let i = 0; i < path.length; i++) {
    const f = m.fields.get(path[i]!);
    if (!f) throw new NotPorted(`res.config.settings create: related path ${path.join(".")}`);
    const value = cur === false ? false : (await env.model(m.name).read([cur], [f.name], ""))[0]?.[f.name] ?? false;
    if (i === path.length - 1) return { field: f, value };
    if (f.type !== "many2one" || !f.relation) throw new NotPorted(`res.config.settings create: related path through ${m.name}.${f.name}`);
    cur = typeof value === "number" ? value : Array.isArray(value) && typeof value[0] === "number" ? value[0] : false;
    m = env.reg.model(f.relation);
  }
  throw new NotPorted("res.config.settings create: empty related path");
}

/** fields.py:799-813 `_inverse_related` on one real record: the value on the first target of the path (a full write). */
async function inverseRelated(env: Environment, field: FieldDef, id: number, value: unknown): Promise<void> {
  const path = field.related!.split(".");
  let m = env.reg.model(S);
  let cur: number | false = id;
  for (const step of path.slice(0, -1)) {
    const f = m.fields.get(step);
    if (!f || f.type !== "many2one" || !f.relation) throw new NotPorted(`inverse of related ${S}.${field.name}`);
    const v: unknown = cur === false ? false : (await env.model(m.name).read([cur], [step], ""))[0]?.[step];
    cur = typeof v === "number" ? v : false;
    m = env.reg.model(f.relation);
  }
  if (cur === false) return;
  const targetField = path[path.length - 1]!;
  const vals = { [targetField]: value };
  // sale res_company.py:112-123: writing `sale_automatic_invoice` syncs `sale.send_invoice_cron.active`
  if (m.name === "res.company" && targetField === "sale_automatic_invoice") {
    const hasBranch = (await env.cr.query("SELECT 1 FROM res_company WHERE parent_id = $1 LIMIT 1", [cur])).rows.length > 0;
    if (hasBranch) await guardOverride(env, m.name, "write", [cur], [vals]);
    await write(env, m.name, [cur], vals);
    const cron = await ref(env, "sale.send_invoice_cron");
    if (cron !== null) {
      const anyActive = (await env.model("res.company").search(cond("sale_automatic_invoice", "=", true), { limit: 1 })).length > 0;
      await write(env.sudo(), "ir.cron", [cron], { active: anyActive });
    }
    return;
  }
  await guardOverride(env, m.name, "write", [cur], [vals]);
  await write(env, m.name, [cur], vals);
}

// ------------------------------------------------------------------------- the stored computes a create leaves to flush
/** account res_config_settings.py:269-282: `module_account_extract and IrModule._get(<module>).state == 'installed'`. */
async function extractInstalled(env: Environment, rec: Rec, module: string): Promise<boolean> {
  if (!(await rec.get("module_account_extract"))) return false;
  const row = (await env.cr.query<{ state: string }>("SELECT state FROM ir_module_module WHERE name = $1", [module])).rows[0];
  return row?.state === "installed";
}
registerRecordCompute(S, {
  module_account_invoice_extract: (env, rec) => extractInstalled(env, rec, "account_invoice_extract"),
  module_account_bank_statement_extract: (env, rec) => extractInstalled(env, rec, "account_bank_statement_extract"),
  module_account_loan_extract: (env, rec) => extractInstalled(env, rec, "account_loans_extract"),
});

// ---------------------------------------------------------------------------------------------------------- create
registerOverrides(S, {
  create: async (env, valsList, next) => {
    await registerSettingsSave(env);
    // res_config.py:520-550: a related field whose value is the current one is dropped (no write of the company)
    const def = env.reg.model(S);
    for (const vals of valsList) {
      for (const field of def.fields.values()) {
        if (!(field.name in vals && field.related && !field.readonly)) continue;
        const [fname0, ...fnames] = field.related.split(".");
        if (!(fname0! in vals)) continue;
        const field0 = def.fields.get(fname0!);
        if (!field0 || field0.type !== "many2one" || !field0.relation) throw new NotPorted(`res.config.settings create: related ${field.related}`);
        const start = comparable(field0, convertToCache(field0, vals[fname0!], S));
        const old = await pathValue(env, field0.relation, typeof start === "number" ? start : false, fnames);
        const oldValue = comparable(old.field, old.value);
        const newValue = comparable(field, convertToCache(field, vals[field.name], S));
        if (oldValue === newValue) delete vals[field.name];
      }
    }
    return next(env, valsList);
  },
  inverse: {
    // stock res_config_settings.py:57-60
    replenish_on_order: async (env, _ids, vals) => {
      const route = await ref(env, "stock.route_warehouse0_mto");
      if (route !== null) await write(env, "stock.route", [route], { active: Boolean(vals["replenish_on_order"]) });
    },
    // crm res_config_settings.py:95-102
    predictive_lead_scoring_fields: async (env, ids, vals) => {
      const cmds = vals["predictive_lead_scoring_fields"];
      const { parseCommands } = await import("../orm/commands");
      let set: number[] = [];
      for (const c of parseCommands(cmds, `${S}.predictive_lead_scoring_fields`)) {
        if (c.op === "set") set = [...c.ids];
        else if (c.op === "link") set.push(c.id);
        else if (c.op === "clear") set = [];
        else throw new NotPorted(`${S}.predictive_lead_scoring_fields command ${c.op}`);
      }
      const names: string[] = [];
      for (const id of set) {
        const r = (await env.cr.query<{ name: string }>(
          "SELECT f.name FROM crm_lead_scoring_frequency_field s JOIN ir_model_fields f ON f.id = s.field_id WHERE s.id = $1", [id])).rows[0];
        if (r) names.push(r.name);
      }
      await write(env, S, ids, { predictive_lead_scoring_fields_str: names.join(",") });
    },
    // crm res_config_settings.py:121-127 (only a set date writes)
    predictive_lead_scoring_start_date: async (env, ids, vals) => {
      const d = vals["predictive_lead_scoring_start_date"];
      if (typeof d === "string" && d) await write(env, S, ids, { predictive_lead_scoring_start_date_str: d.slice(0, 10) });
    },
    // account_peppol res_config_settings.py:67-78: only a company with a Peppol user acts (the proxy)
    peppol_participation_role: async (env, ids) => {
      for (const id of ids) if (await peppolUser(env, id)) throw new NotPorted("res.config.settings peppol_participation_role with a Peppol user (proxy)");
    },
    // account_peppol res_config_settings.py:83-98
    account_peppol_contact_email: async (env, ids, vals) => {
      for (const id of ids) {
        const company = await settingsCompany(env, id);
        const [c] = await env.model("res.company").read([company], ["account_peppol_contact_email"], "");
        const value = vals["account_peppol_contact_email"] ?? false;
        if ((c?.["account_peppol_contact_email"] ?? false) === value) continue;
        await guardOverride(env, "res.company", "write", [company], [{ account_peppol_contact_email: value }]);
        await write(env, "res.company", [company], { account_peppol_contact_email: value });
        if (await peppolUser(env, id)) throw new NotPorted("res.config.settings account_peppol_contact_email with a Peppol user (proxy)");
      }
    },
  },
});

/**
 * Registered on first use (the field list is the registry's):
 * - the related fields with `readonly=False` invert through their path as `_inverse_related` does (not by a write of
 *   the settings record): one inverse per field (src/orm/write.ts runInverses calls each function once);
 * - the non-stored computed fields of a saved record read through their record computes (src/models/settings_computes.ts,
 *   written for the new record of the form): web_save reads the created record with the form's specification.
 */
let lazyRegistered = false;
export async function registerSettingsSave(env: Environment): Promise<void> {
  if (lazyRegistered) return;
  const def = env.reg.model(S);
  const inverse: Record<string, (env: Environment, ids: readonly number[], vals: Readonly<Record<string, unknown>>) => Promise<void>> = {};
  const computed: Record<string, (env: Environment, ids: readonly number[]) => Promise<Map<number, unknown>>> = {};
  const existing = hooksOf(S).computed ?? {};
  for (const field of def.fields.values()) {
    if (field.related && !field.readonly && !field.store) {
      inverse[field.name] = async (e, ids, vals) => { for (const id of ids) await inverseRelated(e, field, id, vals[field.name]); };
    }
    const fn = recordCompute(S, field.name);
    if (!field.store && !field.related && fn && !existing[field.name]) {
      computed[field.name] = async (e, ids) => new Map(await Promise.all(ids.map(async (id) => [id, await fn(e, new DbRec(e, def, id))] as [number, unknown])));
    }
  }
  registerOverrides(S, { inverse });
  registerHooks(S, { computed });
  lazyRegistered = true;
}

async function settingsCompany(env: Environment, id: number): Promise<number> {
  const r = (await env.cr.query<{ c: number | null }>("SELECT company_id AS c FROM res_config_settings WHERE id = $1", [id])).rows[0];
  if (!r || r.c === null) throw new NotPorted("res.config.settings without a company");
  return r.c;
}

/** `record.account_peppol_edi_user` (account_peppol res_company.py: the company's edi user of the proxy type). */
async function peppolUser(env: Environment, id: number): Promise<boolean> {
  const company = await settingsCompany(env, id);
  const r = await env.cr.query("SELECT 1 FROM account_edi_proxy_client_user WHERE company_id = $1 AND proxy_type = 'peppol' AND active LIMIT 1", [company]);
  return r.rows.length > 0;
}

// ------------------------------------------------------------------------------------------------- the record's values
type Values = Record<string, unknown>;

/** The fields the overrides read besides the classified ones. */
const READ = ["company_id", "picking_policy", "chart_template", "vat_check_vies", "crm_auto_assignment_action", "crm_auto_assignment_interval_type",
  "crm_auto_assignment_interval_number", "crm_auto_assignment_run_datetime", "lock_confirmed_po", "po_order_approval", "po_lock", "po_double_validation",
  "use_custom_sfu_client"];

/** `self[name]` for the settings record: columns, computed and related fields through the ORM read (no ids format). */
async function recordValues(env: Environment, id: number, names: readonly string[]): Promise<Values> {
  const [r] = await env.model(S).read([id], [...names], "");
  if (!r) throw new NotPorted("res.config.settings record missing");
  return r;
}

/** The user's groups with their implied closure (`env.user.all_group_ids`), read now (after a group change too). */
async function userGroupIds(env: Environment, uid: number): Promise<Set<number>> {
  const r = await env.cr.query<{ id: number }>(
    `WITH RECURSIVE g(id) AS (SELECT gid FROM res_groups_users_rel WHERE uid = $1
       UNION SELECT r.hid FROM res_groups_implied_rel r JOIN g ON r.gid = g.id) SELECT id FROM g`, [uid]);
  return new Set(r.rows.map((x) => x.id));
}

/** `group.all_implied_ids` (the group and every group it implies, transitively). */
async function allImplied(env: Environment, gid: number): Promise<Set<number>> {
  const r = await env.cr.query<{ id: number }>(
    `WITH RECURSIVE g(id) AS (SELECT $1::int UNION SELECT r.hid FROM res_groups_implied_rel r JOIN g ON r.gid = g.id) SELECT id FROM g`, [gid]);
  return new Set(r.rows.map((x) => x.id));
}

async function directImplied(env: Environment, gid: number): Promise<Set<number>> {
  return new Set((await env.cr.query<{ hid: number }>("SELECT hid FROM res_groups_implied_rel WHERE gid = $1", [gid])).rows.map((r) => r.hid));
}

/** res_groups.py `_get_internal_group_ids`: base.group_user and every group implying it. */
async function internalGroupIds(env: Environment): Promise<string> {
  const user = await ref(env, "base.group_user");
  if (user === null) return "";
  const r = await env.cr.query<{ id: number }>(
    `WITH RECURSIVE g(id) AS (SELECT $1::int UNION SELECT r.gid FROM res_groups_implied_rel r JOIN g ON r.hid = g.id) SELECT id FROM g ORDER BY id`, [user]);
  return r.rows.map((x) => x.id).join(",");
}

/** res_groups.py:223-272 write of `implied_ids` (the ORM core, `_apply_group_regular`, the share recomputation). */
export async function writeImplied(env: Environment, groups: readonly number[], command: [number, number]): Promise<void> {
  if (!groups.length) return;
  const before = await internalGroupIds(env);
  await write(env.sudo(), "res.groups", groups, { implied_ids: [command] });
  await checkGroupRegular(env.sudo());
  if (before !== await internalGroupIds(env)) throw new NotPorted("res.groups implied_ids change of the internal groups (_recompute_user_share)");
}

/** res_groups.py:399-404 `_apply_group`. */
async function applyGroup(env: Environment, groups: readonly number[], implied: number): Promise<void> {
  const todo: number[] = [];
  for (const g of groups) if (!(await allImplied(env, g)).has(implied)) todo.push(g);
  await writeImplied(env, todo, [4, implied]);
}

/** res_groups.py:406-411 `_remove_group`: the groups implied by these that imply the group directly. */
async function removeGroup(env: Environment, groups: readonly number[], implied: number): Promise<void> {
  const all = new Set<number>();
  for (const g of groups) for (const x of await allImplied(env, g)) all.add(x);
  const todo: number[] = [];
  for (const g of [...all].sort((a, b) => a - b)) if ((await directImplied(env, g)).has(implied)) todo.push(g);
  await writeImplied(env, todo, [3, implied]);
}

// ------------------------------------------------------------------------------------------- ir.config_parameter
const INVALID = Symbol("INVALID_VALUE");
type IcpType = "str" | "int" | "float" | "bool";

/**
 * The ir_config_parameter rows of the keys the save sets, read in one query (on the site each statement is a round
 * trip, and the save read its 44 keys one by one); `icpSet` keeps it current with what it creates and writes.
 */
type IcpRows = Map<string, { id: number; value: string | null }>;

async function icpRows(env: Environment, keys: readonly string[]): Promise<IcpRows> {
  const out: IcpRows = new Map();
  if (!keys.length) return out;
  const r = await env.cr.query<{ id: number; key: string; value: string | null }>(
    "SELECT id, key, value FROM ir_config_parameter WHERE key = ANY($1::text[])", [[...new Set(keys)]]);
  for (const row of r.rows) out.set(row.key, { id: Number(row.id), value: row.value });
  return out;
}

/** ir_config_parameter.py:132-160 `_get` and `_convert`: [value or null or INVALID, id or null]. */
function icpGet(rows: IcpRows, key: string, type: IcpType): [unknown, number | null] {
  const row = rows.get(key);
  if (!row) return [null, null];
  if (row.value === null) return [null, row.id];
  const v = row.value;
  switch (type) {
    case "str": return [v, row.id];
    case "bool": {
      const s = v.toLowerCase();
      if (["y", "yes", "1", "true", "t", "on"].includes(s)) return [true, row.id];
      if (["n", "no", "0", "false", "f", "off"].includes(s)) return [false, row.id];
      return [INVALID, row.id];
    }
    case "int": {
      const m = /^\s*([+-]?)(\d+(?:_\d+)*)\s*$/.exec(v);
      return [m ? Number(m[1]! + m[2]!.replace(/_/g, "")) : INVALID, row.id];
    }
    case "float": {
      const t = v.trim();
      return [/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t) ? Number(t) : INVALID, row.id];
    }
  }
}

/** Python `str(value)` of an ICP value. */
function pyStr(v: unknown): string {
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

/** mail mail_alias.py:352-363 `_sanitize_allowed_domains`. */
function sanitizeAllowedDomains(env: Environment, raw: string): string {
  const parts = raw.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) {
    throw new ValidationError(
      translate(
        env,
        "Value %(allowed_domains)s for `mail.catchall.domain.allowed` cannot be validated.\nIt should be a comma separated list of domains e.g. example.com,example.org.",
        "mail",
      ).replace("%(allowed_domains)s", raw),
    );
  }
  return parts.join(",");
}

/** ir_config_parameter.py:81-98 `_set` (as superuser): create the key, or write a changed value. */
async function icpSet(env: Environment, rows: IcpRows, key: string, value: unknown, type: IcpType): Promise<void> {
  const su = env.sudo();
  // mail ir_config_parameter.py:103-114: sanitize non-empty mail.catchall.domain.allowed
  if (key === "mail.catchall.domain.allowed" && typeof value === "string" && value) {
    value = sanitizeAllowedDomains(env, value);
  }
  const [old, id] = icpGet(rows, key, type);
  const stored = value === null ? false : pyStr(value);
  // crm ir_config_parameter.py:10-24: the scoring fields set up crm.lead's registry again
  if (key === "crm.pls_fields" && (id === null || old !== value)) throw new NotPorted("ir.config_parameter crm.pls_fields change (crm.lead registry setup)");
  let changed = false;
  if (id === null) {
    const [nid] = await create(su, "ir.config_parameter", [{ key, value: stored }]);
    if (nid !== undefined) rows.set(key, { id: nid, value: stored === false ? null : stored });
    changed = true;
  } else if (old !== value) {
    await write(su, "ir.config_parameter", [id], { value: stored });
    rows.set(key, { id, value: stored === false ? null : stored });
    changed = true;
  }
  // sale ir_config_parameter.py:27-45 `_sale_sync_linked_crons`
  if (changed && key === "sale.async_emails") {
    const cron = await ref(env, "sale.send_pending_emails_cron");
    if (cron !== null) {
      const s = stored === false ? "" : stored.toLowerCase();
      const active = ["y", "yes", "1", "true", "t", "on"].includes(s);
      await write(su, "ir.cron", [cron], { active });
    }
  }
}

/** mail ir_config_parameter.py:87-100 `set_bool` of the template rendering restriction. */
async function icpSetBool(env: Environment, rows: IcpRows, key: string, value: boolean): Promise<void> {
  if (key === "mail.restrict.template.rendering") {
    const user = await ref(env, "base.group_user");
    const editor = await ref(env, "mail.group_mail_template_editor");
    if (user !== null && editor !== null) {
      const implied = await directImplied(env, user);
      if (!value && !implied.has(editor)) await applyGroup(env, [user], editor);
      else if (value && implied.has(editor)) await removeGroup(env, [user], editor);
    }
  }
  await icpSet(env, rows, key, value, "bool");
}

// --------------------------------------------------------------------------------------------------- set_values
interface Classified { name: string; f: SettingsField }

async function classified(env: Environment): Promise<Classified[]> {
  const d = await settingsData(env);
  // `_get_classified_fields` iterates `self._fields` (src/models/field_order_poc_erp.json)
  const order = (await fieldOrder(env))[S];
  if (!order) throw new NotPorted("res.config.settings field order");
  const out: Classified[] = [];
  for (const name of order) {
    const f = d.fields[name];
    if (f && f.kind !== "other") out.push({ name, f });
  }
  for (const name of Object.keys(d.fields)) if (d.fields[name]!.kind !== "other" && !order.includes(name)) throw new NotPorted(`res.config.settings.${name} missing from the field order`);
  return out;
}

/**
 * The group settings (`group_*` with implied_group) the port may turn on. Turning one on gives every internal user a
 * group, and with it menus, actions, view fields and computes gated by `groups=` that no proof or map reached while it
 * was off: Settings > Project Stages switched the Projects menu to the stage-grouped kanban, whose `is_rotting` the
 * port refused, and the web client stayed on the page it came from (Nils on the site 2026-11-17,
 * docs/accept/briefs/nt-settings.md). A setting is here when `proofs/groups_scan.py --per-toggle` found that the port
 * saves it and serves every screen it changes (action/load, get_views, list/kanban rows and groups, the first record's
 * form, a new record's form) wherever Odoo does; the others refuse to turn on (turning one off is always allowed: that
 * is the template's state). Measured on poc_erp, 2026-11-17 (results/nts/pertoggle.log).
 */
const SERVED_GROUP_SETTINGS = new Set<string>([
  "group_analytic_accounting",
  "group_auto_done_setting",
  "group_cash_rounding",
  "group_discount_per_so_line",
  "group_lot_on_delivery_slip",
  "group_lot_on_invoice",
  "group_multi_currency",
  "group_product_pricelist",
  "group_product_variant",
  "group_proforma_sales",
  "group_project_stages",
  "group_sale_delivery_address",
  "group_send_reminder",
  "group_services_and_material",
  "group_show_uom_price",
  "group_stock_adv_location",
  "group_stock_lot_print_gs1",
  "group_stock_multi_locations",
  "group_stock_production_lot",
  "group_stock_sign_delivery",
  "group_stock_tracking_owner",
  "group_uom",
  "group_use_lead",
  "group_use_recurring_revenues",
  "group_warning_purchase",
  "group_warning_sale",
  "group_warning_stock",
  // kept refused:
  // - group_stock_picking_batch: enabling it breaks stock.picking.action_confirm (unported _find_auto_batch in
  //   stock_engine.ts/stock_inventory.ts) and opens unported stock.picking.batch screens
  // - group_stock_tracking_lot: stock.picking.packages_count for non-done transfers (report_stock.ts) and
  //   stock.package / stock.package.type screens are unported
]);

/** base res_config.py:290-345 `set_values`. */
async function baseSetValues(env: Environment, id: number, self: Values): Promise<void> {
  const fields = await classified(env);
  const allNames = [...env.reg.model(S).fields.keys()];
  const current = await defaultGet(env, S, allNames);
  if (fields.some((c) => c.f.kind === "default")) throw new NotPorted("res.config.settings default_* fields (ir.default.set)");
  // :312-320 group fields, sorted by their value (False first; a stable sort)
  const groups = fields.filter((c) => c.f.kind === "group");
  const key = (c: Classified): number => (self[c.name] === true || self[c.name] === "1" ? 1 : 0);
  // a group setting turned on that the port has not been shown to serve refuses before anything is written
  const unserved = groups.filter((c) => key(c) && self[c.name] !== current[c.name] && !SERVED_GROUP_SETTINGS.has(c.name));
  if (unserved.length) {
    throw new NotPorted(`turning on ${unserved.map((c) => `${c.name} (${c.f.implied_group})`).join(", ")} in Settings: the screens it opens are not all ported (proofs/groups_scan.py --per-toggle)`);
  }
  for (const c of [...groups].sort((a, b) => key(a) - key(b))) {
    if (self[c.name] === current[c.name]) continue;
    const implied = await ref(env, c.f.implied_group!);
    if (implied === null) throw new NotPorted(`res.config.settings: missing xmlid ${c.f.implied_group}`);
    const gids: number[] = [];
    for (const x of c.f.group ?? ["base.group_user"]) {
      const g = await ref(env, x);
      if (g === null) throw new NotPorted(`res.config.settings: missing xmlid ${x}`);
      gids.push(g);
    }
    if (key(c)) await applyGroup(env, gids, implied);
    else await removeGroup(env, gids, implied);
  }
  // :322-345 config fields
  const configs = fields.filter((x) => x.f.kind === "config");
  const rows = await icpRows(env.sudo(), configs.map((c) => c.f.config_parameter!));
  for (const c of configs) {
    const icpKey = c.f.config_parameter!;
    const value = self[c.name];
    switch (c.f.type) {
      case "char": case "datetime": case "selection": {
        const v = value === false || value === null || value === undefined ? null : String(value).trim();
        await icpSet(env, rows, icpKey, v, "str");
        break;
      }
      case "integer": await icpSet(env, rows, icpKey, value === false || value === null ? null : Math.trunc(Number(value)), "int"); break;
      case "many2one": {
        const v = Array.isArray(value) ? value[0] : value;
        await icpSet(env, rows, icpKey, typeof v === "number" && v ? v : null, "int");
        break;
      }
      case "float": await icpSet(env, rows, icpKey, value === false || value === null ? null : Number(isPyFloat(value) ? value.float : value), "float"); break;
      case "boolean": await icpSetBool(env, rows, icpKey, Boolean(value)); break;
      default: throw new OdooError("builtins.ValueError", `Invalid field type: ${c.f.type}`);
    }
  }
}

async function writeOn(env: Environment, model: string, ids: readonly number[], vals: Record<string, unknown>): Promise<void> {
  if (!ids.length) return;
  await guardOverride(env, model, "write", ids, [vals]);
  await write(env, model, ids, vals);
}

/** The settings' `set_values` chain (MRO above); `env` has active_test=False (execute, res_config.py:367). */
async function setValues(env: Environment, id: number): Promise<void> {
  const fields = env.reg.model(S).fields;
  const names = [...(await classified(env)).map((c) => c.name), ...READ.filter((n) => fields.has(n))];
  let self = await recordValues(env, id, names);
  const company = typeof self["company_id"] === "number" ? self["company_id"] : null;
  if (company === null) throw new NotPorted("res.config.settings without a company");

  // stock res_config_settings.py:104-120 (before super)
  const warehouseGrp = await ref(env, "stock.group_stock_multi_warehouses");
  const locationGrp = await ref(env, "stock.group_stock_multi_locations");
  const baseUser = await ref(env, "base.group_user");
  if (baseUser !== null) {
    const implied = await directImplied(env, baseUser);
    if (!self["group_stock_multi_locations"] && locationGrp !== null && implied.has(locationGrp) && warehouseGrp !== null && implied.has(warehouseGrp)) {
      throw new UserError(translate(env, "You can't deactivate the multi-location feature if you have more than one warehouse per company", "stock"));
    }
  }
  const pickingTypes = await env.model("stock.picking.type").search(and([cond("move_type", "!=", self["picking_policy"]), cond("company_id", "=", company)]));
  if (pickingTypes.length) await writeOn(env, "stock.picking.type", pickingTypes, { move_type: self["picking_policy"] });
  const stockPrevious = await defaultGet(env, S, ["group_stock_multi_locations", "group_stock_production_lot", "group_stock_tracking_lot"]);

  // project res_config_settings.py:13-18 (before super)
  const stageSubtype = await ref(env, "project.mt_project_stage_change");
  if (stageSubtype === null) throw new OdooError("builtins.ValueError", "External ID not found in the system: project.mt_project_stage_change");
  const hidden = (await env.cr.query<{ h: boolean | null }>("SELECT hidden AS h FROM mail_message_subtype WHERE id = $1", [stageSubtype])).rows[0]?.h ?? false;
  if (Boolean(hidden) === Boolean(self["group_project_stages"])) await write(env, "mail.message.subtype", [stageSubtype], { hidden: !self["group_project_stages"] });

  // crm res_config_settings.py:137-139 (before super)
  const leadGroup = await ref(env, "crm.group_use_lead");
  const hadLead = leadGroup !== null && (await userGroupIds(env, env.uid)).has(leadGroup);

  // product res_config_settings.py:38-39 (before super)
  const hadPricelist = (await defaultGet(env, S, ["group_product_pricelist"]))["group_product_pricelist"];

  // mail res_config_settings.py:96-98 `_save_sfu_client_asset()` (before super)
  await saveSfuClientAsset(env, self);

  await baseSetValues(env, id, self);
  env.cache.delete("orm.users");
  self = await recordValues(env, id, names);

  // product res_config_settings.py:40-45 (after super): an active-test-free search of every pricelist
  if (self["group_product_pricelist"] && !hadPricelist) {
    await activateOrCreatePricelists(env);
  } else if (!self["group_product_pricelist"]) {
    const active = (await env.cr.query<{ id: number }>("SELECT id FROM product_pricelist WHERE active ORDER BY id")).rows.map((r) => r.id);
    if (active.length) await writeOn(env.sudo(), "product.pricelist", active, { active: false });
  }

  // account res_config_settings.py:251-260 (after super)
  if (await env.company() === company && self["chart_template"]) {
    const [c] = await env.model("res.company").read([company], ["chart_template"], "");
    if (self["chart_template"] !== (c?.["chart_template"] ?? false)) throw new NotPorted("account.chart.template try_loading from the settings");
  }
  if (fields.has("module_l10n_eu_account_vies") && !self["module_l10n_eu_account_vies"] && self["vat_check_vies"]) await write(env, S, [id], { module_l10n_eu_account_vies: true });

  // crm res_config_settings.py:140-165 (after super)
  const hasLead = leadGroup !== null && (await userGroupIds(env, env.uid)).has(leadGroup);
  if (hadLead !== hasLead) {
    const teams = await env.model("crm.team").search(TRUE);
    if (teams.length) {
      const rows = await env.model("crm.team").read(teams, ["use_opportunities", "use_leads", "alias_id", "alias_defaults"], "");
      const oppTeams = rows.filter((r) => r["use_opportunities"]).map((r) => Number(r["id"]));
      if (oppTeams.length) await write(env, "crm.team", oppTeams, { use_leads: hasLead });
      const leadModelId = await irModelId(env, "crm.lead");
      const teamModelId = await irModelId(env, "crm.team");
      for (const r of rows) {
        const tid = Number(r["id"]);
        const aliasId = typeof r["alias_id"] === "number" ? r["alias_id"] : Array.isArray(r["alias_id"]) ? Number(r["alias_id"][0]) : null;
        if (!aliasId) continue;
        const useOpps = Boolean(r["use_opportunities"]);
        const useLeads = useOpps ? hasLead : Boolean(r["use_leads"]);
        const aliasVals: Record<string, unknown> = {
          alias_parent_thread_id: tid,
          alias_parent_model_id: teamModelId,
          alias_model_id: leadModelId,
        };
        if ("default_alias_domain_id" in env.context) aliasVals["alias_domain_id"] = env.context["default_alias_domain_id"];
        if (!useLeads && !useOpps) aliasVals["alias_name"] = false;
        const parsed = evalExpr(String(r["alias_defaults"] || "{}"), new Map());
        if (!isDict(parsed)) throw new NotPorted("crm.team alias_defaults that is not a dict");
        const defaults = new Map<unknown, unknown>(dictEntries(parsed));
        defaults.set("type", hasLead && useLeads ? "lead" : "opportunity");
        defaults.set("team_id", tid);
        aliasVals["alias_defaults"] = pyRepr(defaults);
        await write(env, "mail.alias", [aliasId], aliasVals);
      }
    }
  }
  const assignCron = await ref(env, "crm.ir_cron_crm_lead_assign");
  if (assignCron !== null) {
    const [cron] = await env.sudo().model("ir.cron").read([assignCron], ["active", "interval_type", "interval_number", "nextcall"], "");
    if (!cron) throw new NotPorted("crm.ir_cron_crm_lead_assign missing");
    const want: Record<string, unknown> = {
      active: Boolean(self["crm_use_auto_assignment"]) && self["crm_auto_assignment_action"] === "auto",
      interval_type: self["crm_auto_assignment_interval_type"],
      interval_number: self["crm_auto_assignment_interval_number"],
      nextcall: self["crm_auto_assignment_run_datetime"] ? self["crm_auto_assignment_run_datetime"] : cron["nextcall"],
    };
    const vals: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(want)) if (cron[k] !== v) vals[k] = v;
    if (Object.keys(vals).length) await write(env.sudo(), "ir.cron", [assignCron], vals);
  }

  // stock res_config_settings.py:121-155 (after super)
  if ((await userGroupIds(env, env.uid)).has((await ref(env, "stock.group_stock_manager")) ?? -1)) {
    const multi = Boolean(self["group_stock_multi_locations"]);
    if (multi && !stockPrevious["group_stock_multi_locations"]) {
      // `with_context(active_test=True).search([])` as the user (the warehouses of the allowed companies)
      const whs = await env.withContext({ ...env.context, active_test: true }).model("stock.warehouse").search(TRUE);
      await writeOn(env, "stock.picking.type", await intTypes(env, whs), { active: true });
      await setViewsActive(env, false);
    } else if (!multi && stockPrevious["group_stock_multi_locations"]) {
      const whs = await env.model("stock.warehouse").search(and([cond("reception_steps", "=", "one_step"), cond("delivery_steps", "=", "ship_only")]));
      await writeOn(env, "stock.picking.type", await intTypes(env, whs), { active: false });
      await setViewsActive(env, true);
    }
    if (!self["group_stock_production_lot"] && stockPrevious["group_stock_production_lot"]) {
      const tracked = await env.cr.query(
        "SELECT 1 FROM product_product p JOIN product_template t ON t.id = p.product_tmpl_id WHERE t.tracking IN ('lot', 'serial') LIMIT 1");
      if (tracked.rows.length) throw new UserError(translate(env, "You have product(s) in stock that have lot/serial number tracking enabled. \nSwitch off tracking on all the products before switching off this setting.", "stock"));
    }
  }

  // purchase res_config_settings.py:38-45 (after super): related fields written on the settings record
  const poLock = self["lock_confirmed_po"] ? "lock" : "edit";
  const poDouble = self["po_order_approval"] ? "two_step" : "one_step";
  if (self["po_lock"] !== poLock) await writeSettings(env, id, { po_lock: poLock });
  if (self["po_double_validation"] !== poDouble) await writeSettings(env, id, { po_double_validation: poDouble });

  // crm_iap_enrich res_config_settings.py:17-21 (after super)
  const enrich = await ref(env, "crm_iap_enrich.ir_cron_lead_enrichment");
  if (enrich !== null) {
    const active = (await env.cr.query<{ a: boolean | null }>("SELECT active AS a FROM ir_cron WHERE id = $1", [enrich])).rows[0]?.a ?? false;
    const want = self["lead_enrich_auto"] === "auto";
    if (Boolean(active) !== want) await write(env.sudo(), "ir.cron", [enrich], { active: want });
  }

  // sale wizard/res_config_settings.py:123-128, sale_management wizard/res_config_settings.py:9-15 (after super)
  for (const x of ["sale.view_order_form_mandatory_product", "sale_management.sale_order_template_view_form_mandatory_product"]) {
    const view = await ref(env, x);
    if (view !== null) await writeOn(env, "ir.ui.view", [view], { active: Boolean(self["sale_order_mandatory_product"]) });
  }
}

/** product res_company.py:15-51 `_activate_or_create_pricelists` for all companies. */
async function activateOrCreatePricelists(env: Environment): Promise<void> {
  if (env.context["disable_company_pricelist_creation"]) return;
  const plGroup = await ref(env, "product.group_product_pricelist");
  if (plGroup === null || !(await userGroupIds(env, env.uid)).has(plGroup)) return;
  const companies = await env.model("res.company").search(TRUE);
  if (!companies.length) return;
  const su = env.sudo();
  const existing = (await env.cr.query<{ id: number; company_id: number; active: boolean }>(
    `SELECT p.id, p.company_id, p.active FROM product_pricelist p JOIN res_company c ON c.id = p.company_id
      WHERE p.company_id = ANY($1::int[]) AND p.currency_id = c.currency_id
        AND NOT EXISTS (SELECT 1 FROM product_pricelist_item i WHERE i.pricelist_id = p.id)
      ORDER BY p.id`, [companies])).rows;
  const inactiveIds = existing.filter((r) => !r.active).map((r) => r.id);
  if (inactiveIds.length) await writeOn(su, "product.pricelist", inactiveIds, { active: true });
  const covered = new Set(existing.map((r) => r.company_id));
  const vals: Record<string, unknown>[] = [];
  for (const c of companies) {
    if (covered.has(c)) continue;
    const cur = (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [c])).rows[0]!.c;
    vals.push({ name: translate(env, "Default", "product"), currency_id: cur, company_id: c, sequence: 10 });
  }
  if (vals.length) await create(su, "product.pricelist", vals);
}

/** A write on the settings record (its related fields invert through their path). */
async function writeSettings(env: Environment, id: number, vals: Record<string, unknown>): Promise<void> {
  for (const [name, value] of Object.entries(vals)) {
    const field = env.reg.model(S).fields.get(name)!;
    if (!field.related) throw new NotPorted(`res.config.settings write of ${name}`);
    await inverseRelated(env, field, id, value);
  }
}

/** `warehouses.int_type_id` (mapped: distinct, in the warehouses' order). */
async function intTypes(env: Environment, warehouses: readonly number[]): Promise<number[]> {
  const out: number[] = [];
  for (const w of warehouses) {
    const t = (await env.cr.query<{ t: number | null }>("SELECT int_type_id AS t FROM stock_warehouse WHERE id = $1", [w])).rows[0]?.t;
    if (typeof t === "number" && !out.includes(t)) out.push(t);
  }
  return out;
}

/** stock res_config_settings.py:131-136, :144-149: the editable location views (if they still exist). */
async function setViewsActive(env: Environment, active: boolean): Promise<void> {
  for (const x of ["stock.stock_location_view_tree2_editable", "stock.stock_location_view_form_editable"]) {
    const view = await ref(env, x);
    if (view !== null) await writeOn(env, "ir.ui.view", [view], { active });
  }
}

export const SFU_CLIENT_SOURCE_URL = "/_custom/mail/static/lib/odoo_sfu/odoo_sfu.js";
const SFU_CLIENT_TARGET = "/mail/static/lib/odoo_sfu/odoo_sfu.js";

/** mail res_config_settings.py:112-149 `_save_sfu_client_asset(client_source=None)`. */
export async function saveSfuClientAsset(env: Environment, self: Values, clientSource?: string | null): Promise<void> {
  const noWeb = env.withContext({ ...env.context, website_id: false });
  const assetEnv = noWeb.withContext({ ...noWeb.context, active_test: false });
  const attRows = (await env.cr.query<{ id: number; store_fname: string | null }>(
    `SELECT id, store_fname FROM ir_attachment WHERE type = 'binary' AND url = $1 ORDER BY id DESC LIMIT 1`,
    [SFU_CLIENT_SOURCE_URL],
  )).rows;
  const sourceAtt = attRows[0] ?? null;
  const asset = (await env.cr.query<{ id: number; active: boolean | null }>(
    `SELECT id, active FROM ir_asset WHERE bundle = 'mail.assets_odoo_sfu' AND directive = 'replace'
        AND path = $1 AND target = $2
      ORDER BY sequence, id LIMIT 1`,
    [SFU_CLIENT_SOURCE_URL, SFU_CLIENT_TARGET],
  )).rows[0];
  const sourceProvided = clientSource !== undefined && clientSource !== null;
  let source = sourceProvided ? clientSource : "";
  if (!sourceProvided && sourceAtt) {
    // Only need the existing source content if activating the custom client
    const wanted = Boolean(self["use_call_server"]) && Boolean(self["use_sfu_server"]) && Boolean(self["use_custom_sfu_client"]);
    if (wanted) throw new NotPorted("res.config.settings: reading existing custom SFU client source attachment");
  }
  const wanted = Boolean(self["use_call_server"]) && Boolean(self["use_sfu_server"]) && Boolean(self["use_custom_sfu_client"]);
  if (wanted && !source.trim()) {
    throw new UserError(translate(env, "Cannot activate custom SFU client without providing a source.", "mail"));
  }
  if (sourceProvided) {
    const encoded = new TextEncoder().encode(source);
    if (sourceAtt) {
      throw new NotPorted("res.config.settings: updating existing custom SFU client source attachment");
    }
    await create(noWeb, "ir.attachment", [{
      name: "SFU client source",
      type: "binary",
      url: SFU_CLIENT_SOURCE_URL,
      mimetype: "application/javascript",
      raw: encoded,
    }]);
  }
  if (asset) {
    if (Boolean(asset.active) !== wanted) await write(assetEnv, "ir.asset", [asset.id], { active: wanted });
  } else if (wanted) {
    await create(assetEnv, "ir.asset", [{
      name: "Alternative SFU client",
      bundle: "mail.assets_odoo_sfu",
      directive: "replace",
      path: SFU_CLIENT_SOURCE_URL,
      target: SFU_CLIENT_TARGET,
    }]);
  }
}

// ------------------------------------------------------------------------------------------------------- execute
/** res_config.py:347-403 `execute` of one settings record. */
export async function executeSettings(env: Environment, id: number): Promise<Record<string, unknown>> {
  if (!(await isAdmin(env))) throw new AccessError(translate(env, "Only administrators can change the settings", "base"));
  const e = env.withContext({ ...env.context, active_test: false });
  await registerSettingsSave(e);
  await setValues(e, id);
  // :373-376 the module fields: installing or uninstalling refuses
  const modules = (await classified(e)).filter((c) => c.f.kind === "module");
  const self = await recordValues(e, id, modules.map((c) => c.name));
  const toInstall: string[] = [], toUninstall: string[] = [];
  // one query for every module field's state (one round trip on the site instead of one per field)
  const states = new Map((await e.cr.query<{ name: string; state: string }>(
    "SELECT name, state FROM ir_module_module WHERE name = ANY($1::text[])", [modules.map((c) => c.name.slice(7))])).rows.map((r) => [r.name, r.state]));
  for (const c of modules) {
    const state = states.get(c.name.slice(7));
    if (state === undefined) continue; // `IrModule._get(name)`: a module that does not exist is not classified
    if (self[c.name] && state !== "installed") toInstall.push(c.name.slice(7));
    if (!self[c.name] && (state === "installed" || state === "to upgrade")) toUninstall.push(c.name.slice(7));
  }
  if (toInstall.length || toUninstall.length) {
    throw new NotPorted(`res.config.settings execute: ${toInstall.length ? `installing ${toInstall.join(", ")}` : ""}${toInstall.length && toUninstall.length ? ", " : ""}${toUninstall.length ? `uninstalling ${toUninstall.join(", ")}` : ""}`);
  }
  // :395-403 `res.config.next()` is the reload action
  return { type: "ir.actions.client", tag: "reload" };
}

registerMethod(S, "execute", async (env, ids) => {
  // res_config.py:361 ensure_one
  if (ids === null || ids.length !== 1) throw new OdooError("builtins.ValueError", `Expected singleton: res.config.settings(${(ids ?? []).join(", ")}${ids?.length === 1 ? "," : ""})`);
  return executeSettings(env, ids[0]!);
}, { apiModel: false });
