/**
 * Plain-SQL reads of the session user that `session_info`, authentication and the menus need
 * (`odoo/odoo/addons/base/models/res_users.py`, `res_groups.py`, `ir_config_parameter.py`, `res_lang.py`).
 * TODO(orm): switch to `ctx.orm()` (src/orm/types.ts Model API) once the ORM stream lands; every query here
 * cites the ORM method it stands in for.
 */
import type { Cursor } from "../db";
import { NotPorted } from "../errors";
import { activeLangRows, registryCached, requestSequences } from "../orm/signaling";

export const SUPERUSER_ID = 1; // odoo/odoo/api.py SUPERUSER_ID
export const DEFAULT_MAX_CONTENT_LENGTH = 128 * 1024 * 1024; // odoo/odoo/http/_facade.py:10

/** `res_users` joined with its partner (`_inherits = {'res.partner': 'partner_id'}`). */
export interface UserRow {
  readonly id: number;
  readonly login: string;
  readonly password: string | null;
  readonly active: boolean;
  readonly company_id: number;
  readonly partner_id: number;
  readonly action_id: number | null;
  readonly share: boolean;
  readonly tour_enabled: boolean;
  readonly odoobot_state: string | null;
  readonly notification_type: string;
  readonly totp_secret: string | null;
  readonly partner_name: string | null;
  readonly partner_tz: string | null;
  readonly partner_lang: string | null;
  readonly partner_write_date: Date | null;
  readonly partner_parent_id: number | null;
  readonly partner_is_company: boolean;
  readonly partner_commercial_company_name: string | null;
  readonly partner_parent_name: string | null;
  /** `res_users.active` as stored (the session token hashes the raw value, None for NULL). */
  readonly active_raw: boolean | null;
  readonly partner_commercial_partner_id: number | null;
}

const USER_SQL = `
  SELECT u.id, u.login, u.password, COALESCE(u.active, false) AS active, u.company_id, u.partner_id, u.action_id,
         COALESCE(u.share, false) AS share, COALESCE(u.tour_enabled, false) AS tour_enabled, u.odoobot_state,
         u.notification_type, u.totp_secret,
         p.name AS partner_name, p.tz AS partner_tz, p.lang AS partner_lang, p.write_date AS partner_write_date,
         p.parent_id AS partner_parent_id, COALESCE(p.is_company, false) AS partner_is_company,
         p.commercial_company_name AS partner_commercial_company_name, pp.name AS partner_parent_name,
         u.active AS active_raw, p.commercial_partner_id AS partner_commercial_partner_id
    FROM res_users u
    JOIN res_partner p ON p.id = u.partner_id
    LEFT JOIN res_partner pp ON pp.id = p.parent_id`;

export async function fetchUser(cr: Cursor, uid: number): Promise<UserRow | null> {
  const r = await cr.query<UserRow>(`${USER_SQL} WHERE u.id = $1`, [uid]);
  return r.rows[0] ?? null;
}

/** `res.users._login`: `self.sudo().search(Domain('login', '=', login), order=_order, limit=1)` (res_users.py:862). */
export async function fetchUserByLogin(cr: Cursor, login: string): Promise<UserRow | null> {
  // search() applies active_test: only active users (models.py _search active_test rule)
  const r = await cr.query<UserRow>(`${USER_SQL} WHERE u.login = $1 AND u.active ORDER BY p.name, u.login LIMIT 1`, [login]);
  return r.rows[0] ?? null;
}

/** `ir.model.data._xmlid_to_res_id` / `env.ref`: `module.name` -> res_id, null when absent. */
export async function xmlidToResId(cr: Cursor, xmlid: string): Promise<number | null> {
  const dot = xmlid.indexOf(".");
  if (dot < 0) throw new Error(`xmlid without module: ${xmlid}`);
  // ir_model.py `_xmlid_lookup` is an ormcache of the registry (src/orm/signaling.ts)
  return registryCached(cr, `xmlid ${xmlid}`, async () => {
    const common = COMMON_XMLIDS.has(xmlid);
    if (common || xmlid.startsWith("group_", dot + 1)) {
      const hit = (await groupXmlids(cr)).get(xmlid);
      if (hit !== undefined) return hit;
      if (common) return null; // read by its (module, name) in that statement: absent
    }
    const r = await cr.query<{ res_id: number }>(
      "SELECT res_id FROM ir_model_data WHERE module = $1 AND name = $2",
      [xmlid.slice(0, dot), xmlid.slice(dot + 1)],
    );
    return r.rows[0]?.res_id ?? null;
  });
}

/** Records the web client's Discuss and session code refers to on most pages (src/mail/bootstrap.ts, src/session/info.ts). */
const COMMON_XMLIDS: ReadonlySet<string> = new Set(["base.partner_root", "base.user_root", "base.public_user",
  "base.public_partner", "mail.mt_comment", "mail.mt_note", "mail.mt_important_notification"]);

/**
 * Every `res.groups` xmlid and COMMON_XMLIDS, in one statement: the group checks of a request (`has_group`, the user's
 * role, the menus) and the Discuss bootstrap looked their xmlids up one statement each, about eight per request on a
 * new isolate (docs/accept/C2.md). The (module, name) of ir_model_data is unique (ir_model.py:2322
 * `_module_name_uniq_index`), so a name found here is the whole answer of `_xmlid_lookup`; a group name not found is
 * looked up alone, a common one not found is absent.
 */
export function groupXmlids(cr: Cursor): Promise<Map<string, number | null>> {
  return registryCached(cr, "xmlids res.groups", async () => {
    const r = await cr.query<{ xmlid: string; res_id: number | null }>(
      `SELECT module || '.' || name AS xmlid, res_id FROM ir_model_data
        WHERE (model = 'res.groups' AND name LIKE 'group\\_%') OR module || '.' || name = ANY($1::text[])`, [[...COMMON_XMLIDS]]);
    return new Map(r.rows.map((x) => [x.xmlid, x.res_id]));
  });
}

/**
 * `res.users._get_group_ids()`: `all_group_ids`, the reflexive transitive closure of the user's `group_ids`
 * through `implied_ids` (res_users.py:485-489 and 1227-1233, res_groups.py:342-346). Tables: `res_groups_users_rel`
 * (uid, gid) and `res_groups_implied_rel` (gid, hid).
 */
export async function userGroupIds(cr: Cursor, uid: number): Promise<Set<number>> {
  // `_get_group_ids` is an ormcache of the registry (src/orm/signaling.ts); callers get their own set. Computed from
  // the user's direct groups and the implied relation that `env.user` reads anyway (src/orm/env.ts loadUser): one
  // statement less per request on a new isolate than a recursive query of its own (docs/accept/C2.md)
  return new Set(await registryCached(cr, `user groups ${uid}`, async () => {
    const [direct, implied] = await Promise.all([directGroupIds(cr, uid), impliedGroupMap(cr)]);
    return [...impliedClosure(direct, implied)];
  }));
}

/** The user's `group_ids` (res_groups_users_rel), kept with `_get_group_ids` in the registry (src/orm/signaling.ts). */
export function directGroupIds(cr: Cursor, uid: number): Promise<number[]> {
  return registryCached(cr, `user direct groups ${uid}`, async () => (await cr.query<{ gid: number }>(
    `SELECT gid FROM res_groups_users_rel WHERE uid = $1 ORDER BY gid`, [uid])).rows.map((r) => r.gid));
}

/** `res_groups_implied_rel`: group id -> directly implied group ids (res_groups.py:75), an ormcache of the registry. */
export function impliedGroupMap(cr: Cursor): Promise<Map<number, number[]>> {
  return registryCached(cr, "groups implied", async () => {
    const res = await cr.query<{ gid: number; hid: number }>(`SELECT gid, hid FROM res_groups_implied_rel ORDER BY gid, hid`);
    const map = new Map<number, number[]>();
    for (const r of res.rows) {
      const list = map.get(r.gid) ?? [];
      list.push(r.hid);
      map.set(r.gid, list);
    }
    return map;
  });
}

/** `all_implied_ids` (res_groups.py:342-346): the reflexive transitive closure of `implied_ids`. */
export function impliedClosure(groups: Iterable<number>, implied: ReadonlyMap<number, readonly number[]>): Set<number> {
  const out = new Set<number>();
  const todo = [...groups];
  while (todo.length > 0) {
    const gid = todo.pop() as number;
    if (out.has(gid)) continue;
    out.add(gid);
    for (const hid of implied.get(gid) ?? []) todo.push(hid);
  }
  return out;
}

/** `_get_company_ids` (res_users.py:823-825): `[('active', '=', True), ('user_ids', 'in', self.id)]` in res.company._order. */
export function userActiveCompanyIds(cr: Cursor, uid: number): Promise<number[]> {
  return registryCached(cr, `user companies ${uid}`, async () => (await cr.query<{ id: number }>(
    `SELECT c.id FROM res_company c JOIN res_company_users_rel r ON r.cid = c.id
      WHERE r.user_id = $1 AND c.active IS TRUE ORDER BY c.sequence, c.name, c.id`, [uid])).rows.map((r) => r.id));
}

export interface AccessRow { model: string; group_id: number | null; operation: string; domain: string | null }

/** The active ir.access rows, an ormcache of the stable container (ir_access.py:282, src/orm/access.ts). */
export function accessRows(cr: Cursor): Promise<readonly AccessRow[]> {
  return registryCached(cr, "ir.access rows", async () => (await cr.query<AccessRow>(
    `SELECT m.model, a.group_id, a.operation, a.domain FROM ir_access a
     JOIN ir_model m ON m.id = a.model_id WHERE a.active ORDER BY a.id`,
  )).rows, "stable");
}

/**
 * The registry's ormcaches nearly every request with an environment reads (the configuration parameters, the active
 * languages, the user's companies and groups, the implied groups, the group xmlids, the access rows), asked for at
 * once when an environment is created: on an isolate that has them nothing is read; on a new isolate (most requests
 * on the site, docs/accept/C2.md) their statements are written together and share one round trip through the
 * tunnel (src/db.ts pipelining) instead of one each. The same statements and keys as their callers, so nothing is
 * read twice; reads only, before the request writes anything, in the transaction's snapshot. A failure is left to
 * the caller that awaits the value (registryCached forgets a failed load).
 */
export function warmRequest(cr: Cursor, uid: number): void {
  const loads: Promise<unknown>[] = [icpStr(cr, "database.secret"), activeLangRows(cr), userActiveCompanyIds(cr, uid),
    directGroupIds(cr, uid), impliedGroupMap(cr), groupXmlids(cr), accessRows(cr)];
  for (const p of loads) p.catch(() => undefined);
}

/** `res.users._has_group(xmlid)` (res_users.py:1214-1225) on an already computed group set. */
export async function hasGroup(cr: Cursor, groups: ReadonlySet<number>, xmlid: string): Promise<boolean> {
  const gid = await xmlidToResId(cr, xmlid);
  return gid !== null && groups.has(gid);
}

/** res_groups.py:421-433 `_get_light_group_xmlids` (no installed module extends it in the corpus: hr_holidays, point_of_sale). */
export const LIGHT_GROUP_XMLIDS = [
  "base.group_user", "base.group_portal", "base.group_public", "base.group_everyone", "base.group_no_one",
  "base.group_multi_currency", "base.default_user_group",
  // `_get_light_group_xmlids` overrides of the addons (addons/*/models/res_groups.py); xmlids of modules that are not
  // installed do not resolve and are skipped
  "account.group_cash_rounding", "account.group_delivery_invoice_address", "analytic.group_analytic_accounting",
  "crm.group_use_lead", "crm.group_use_recurring_revenues", "hr_attendance.group_hr_attendance_own",
  "hr_attendance.group_hr_attendance_own_reader", "hr_holidays.group_hr_holidays_employee",
  "hr_recruitment.group_applicant_cv_display", "l10n_in.group_l10n_in_reseller", "lunch.group_lunch_user",
  "mail.group_mail_notification_type_inbox", "mass_mailing.group_mass_mailing_campaign", "mrp.group_mrp_routings",
  "mrp.group_mrp_byproducts", "mrp.group_unlocked_by_default", "point_of_sale.group_pos_preset",
  "product.group_product_pricelist", "product.group_product_variant", "product.group_show_uom_price",
  "product_expiry.group_expiry_date_on_delivery_slip", "project.group_project_milestone",
  "project.group_project_recurring_tasks", "project.group_project_task_dependencies", "project.group_project_stages",
  "purchase.group_send_reminder", "purchase.group_warning_purchase", "sale.group_discount_per_so_line",
  "sale.group_proforma_sales", "sale.group_auto_done_setting", "sale.group_services_and_material", "sale.group_warning_sale",
  "stock.group_production_lot", "stock.group_adv_location", "stock.group_stock_multi_locations",
  "stock.group_stock_picking_batch", "stock.group_tracking_lot", "stock.group_tracking_owner",
  "stock.group_lot_on_delivery_slip", "stock.group_stock_lot_print_gs1", "stock.group_stock_sign_delivery",
  "stock.group_warning_stock", "stock_account.group_lot_on_invoice", "uom.group_uom", "website.group_multi_website",
  "website_sale.group_product_feed", "website_sale.group_product_price_comparison",
];

/** `res.users.role` (res_users.py:430-446 `_compute_role`): group_system > light_user > regular_user > False. */
export async function userRole(cr: Cursor, groups: ReadonlySet<number>): Promise<"group_system" | "light_user" | "regular_user" | false> {
  const groupSystem = await xmlidToResId(cr, "base.group_system");
  const groupUser = await xmlidToResId(cr, "base.group_user");
  if (groupSystem !== null && groups.has(groupSystem)) return "group_system";
  if (groupUser === null || !groups.has(groupUser)) return false;
  // `_is_light_groups`: the user's groups are a subset of the light groups (res_groups.py:475-479)
  const light = new Set<number>();
  for (const xid of LIGHT_GROUP_XMLIDS) {
    const id = await xmlidToResId(cr, xid);
    if (id !== null) light.add(id);
  }
  for (const g of groups) if (!light.has(g)) return "regular_user";
  return "light_user";
}

export interface UserFlags {
  readonly isInternal: boolean; // res_users.py:1271-1273 has_group('base.group_user')
  readonly isSystem: boolean; // 1288-1290 has_group('base.group_system')
  readonly isAdmin: boolean; // 1292-1294 superuser or has_group('base.group_erp_manager')
  readonly isPublic: boolean; // 1284-1286 has_group('base.group_public')
  readonly isRegular: boolean; // 1275-1278 role in ('regular_user', 'group_system')
  readonly allowExport: boolean; // web/models/ir_http.py:146 has_group('base.group_allow_export')
  readonly groups: ReadonlySet<number>;
}

export async function userFlags(cr: Cursor, uid: number): Promise<UserFlags> {
  const groups = await userGroupIds(cr, uid);
  const role = await userRole(cr, groups);
  return {
    isInternal: await hasGroup(cr, groups, "base.group_user"),
    isSystem: await hasGroup(cr, groups, "base.group_system"),
    isAdmin: uid === SUPERUSER_ID || await hasGroup(cr, groups, "base.group_erp_manager"),
    isPublic: await hasGroup(cr, groups, "base.group_public"),
    isRegular: role === "regular_user" || role === "group_system",
    allowExport: await hasGroup(cr, groups, "base.group_allow_export"),
    groups,
  };
}

/** `res.lang.get_installed()`: active languages' codes sorted by name (res_lang.py:347-352). */
export async function installedLangs(cr: Cursor): Promise<string[]> {
  // `_get_active_by` is an ormcache of the registry's stable container (res_lang.py:347-355), src/orm/signaling.ts; callers get their own list
  return (await activeLangRows(cr)).map((x) => x.code);
}

/** The lang of the company's partner, `env.user.company_id.partner_id.lang` (res_users.py:810, misc.py:1288). */
async function companyPartnerLang(cr: Cursor, companyId: number): Promise<string | null> {
  const r = await cr.query<{ lang: string | null }>(
    "SELECT p.lang FROM res_company c JOIN res_partner p ON p.id = c.partner_id WHERE c.id = $1", [companyId],
  );
  return r.rows[0]?.lang ?? null;
}

/**
 * `res.users.context_get()` (res_users.py:791-820): `{'lang', 'tz', 'uid'}` from `read(['lang', 'tz'])`, the lang
 * validated against the installed languages with the fallbacks context > request > company > en_US > first.
 */
export async function contextGet(cr: Cursor, user: UserRow, bestLang: string | null): Promise<{ lang: string; tz: string | false; uid: number }> {
  const langs = await installedLangs(cr);
  let lang: string | null = user.partner_lang;
  if (lang === null || !langs.includes(lang)) {
    lang = bestLang;
    if (lang === null || !langs.includes(lang)) {
      lang = await companyPartnerLang(cr, user.company_id);
      if (lang === null || !langs.includes(lang)) {
        lang = "en_US";
        if (!langs.includes(lang)) lang = langs[0] ?? "en_US";
      }
    }
  }
  // read() converts an empty char to False (fields.py convert_to_read)
  return { lang, tz: user.partner_tz ?? false, uid: user.id };
}

/** `odoo.tools.misc.get_lang(env).code` (misc.py:1272-1290) for the request's context lang. */
export async function getLangCode(cr: Cursor, contextLang: string | undefined, companyId: number | null): Promise<string> {
  const langs = await installedLangs(cr);
  let lang = langs.includes("en_US") ? "en_US" : (langs[0] ?? "en_US");
  if (contextLang !== undefined && langs.includes(contextLang)) lang = contextLang;
  else if (companyId !== null) {
    const companyLang = await companyPartnerLang(cr, companyId);
    if (companyLang !== null && langs.includes(companyLang)) lang = companyLang;
  }
  return lang;
}

/** `res.users._get_company_ids()` (res_users.py:822-826): company_id first, then the active companies the user is in. */
export async function userCompanyIds(cr: Cursor, user: UserRow): Promise<number[]> {
  // res.company _order = 'sequence, name' (res_company.py:64); the ormcache `env.user` reads too (src/orm/env.ts)
  const ids = [user.company_id];
  for (const id of await userActiveCompanyIds(cr, user.id)) if (!ids.includes(id)) ids.push(id);
  return ids;
}

/** `res.partner._get_complete_name()` (res_partner.py:469-481) for the user's partner (`partner_display_name`). */
export function partnerDisplayName(user: UserRow): string {
  let name = user.partner_name ?? "";
  if (user.partner_parent_id !== null) {
    if (name === "") throw new NotPorted("res.partner display name of an unnamed child contact (type description)");
    if (!user.partner_is_company) name = `${user.partner_commercial_company_name ?? user.partner_parent_name ?? ""}, ${name}`;
  }
  return name.trim();
}

// ir.config_parameter getters (ir_config_parameter.py:100-130, _get 131-151, _convert 152-162)
/**
 * `ir.config_parameter._get_param(key)` (ir_config_parameter.py `@ormcache('key')`, `SELECT value ... WHERE key = %s`).
 * The whole table in one statement, kept as one ormcache of the registry (src/orm/signaling.ts: ir_config_parameter is
 * watched, a write clears it and signals): a page read about ten parameters one statement each on a new isolate
 * (docs/accept/C2.md). The table is small (32 rows, 276 characters of values on poc_erp).
 */
export async function icpStr(cr: Cursor, key: string): Promise<string | null> {
  const all = await registryCached(cr, "ir.config_parameter all", async () => {
    const r = await cr.query<{ key: string; value: string | null }>("SELECT key, value FROM ir_config_parameter");
    return new Map(r.rows.map((x) => [x.key, x.value]));
  });
  return all.get(key) ?? null;
}

/** `odoo.tools.misc.str2bool` (misc.py:439-464). */
export function str2bool(s: string): boolean | null {
  const l = s.toLowerCase();
  if (["y", "yes", "1", "true", "t", "on"].includes(l)) return true;
  if (["n", "no", "0", "false", "f", "off"].includes(l)) return false;
  return null;
}

export async function icpBool(cr: Cursor, key: string, dflt = false): Promise<boolean> {
  const v = await icpStr(cr, key);
  if (v === null) return dflt;
  return str2bool(v) ?? dflt; // INVALID_VALUE -> default (ir_config_parameter.py:103-104)
}

export async function icpInt(cr: Cursor, key: string, dflt = 0): Promise<number> {
  const v = await icpStr(cr, key);
  if (v === null) return dflt;
  return /^-?\d+$/.test(v.trim()) ? Number(v) : dflt;
}

/** `database.secret`, required by csrf, session tokens and `odoo.tools.misc.hmac`. */
export async function databaseSecret(cr: Cursor): Promise<string> {
  const s = await icpStr(cr, "database.secret");
  if (s === null || s === "") throw new Error("database.secret is not configured");
  return s;
}

/** `cr.now()`: the database's now(), frozen per copy by the harness (ARCHITECTURE.md Runtime facts). */
export async function dbNow(cr: Cursor): Promise<Date> {
  // read with the signaling sequences in one statement, as Odoo's `get_sequences` (src/orm/signaling.ts)
  const now = (await requestSequences(cr)).now;
  if (!(now instanceof Date)) throw new Error("now() did not return a timestamp");
  return now;
}
