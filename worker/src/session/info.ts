/**
 * `ir.http.session_info()` and `get_frontend_session_info()` as the installed modules compose them, in the order
 * the inheritance chain adds keys (the html pages embed the dict and are compared as text):
 *   web/models/ir_http.py:87-183 (base dict) -> base_setup/models/ir_http.py:9-13 (show_effect) ->
 *   bus/models/ir_http.py:107-110 (bus_info) -> web_tour/models/ir_http.py:7-10 (tour_enabled, current_tour) ->
 *   mail/models/ir_http.py:11-28 (storeData: the mail stream's, through `registerSessionInfoHook`) ->
 *   partner_autocomplete/models/ir_http.py:10-15 (iap_company_enrich);
 *   home.py:76-78 then appends browser_cache_secret on the web client page.
 * Frontend: web/models/ir_http.py:185-213 then bus/models/ir_http.py:99-105.
 * TODO(orm): the reads below are plain SQL standing in for the ORM calls they cite; switch to `ctx.orm()`.
 */
import { installedModules, isInstalled } from "../http/modules";
import type { Cursor } from "../db";
import { NotPorted } from "../errors";
import { datetimeToString } from "../http/json";
import { odooHmac, sessionTokenValues } from "./auth";
import type { Session } from "./session";
import { inOrder } from "../in_order";
import {
  databaseSecret, DEFAULT_MAX_CONTENT_LENGTH, fetchUser, icpBool, icpInt, icpStr, partnerDisplayName,
  userCompanyIds, userFlags, type UserFlags, type UserRow, xmlidToResId, contextGet,
} from "./user";

export const SERVER_VERSION = "20.0"; // odoo/odoo/release.py:15-17
export const SERVER_VERSION_INFO: readonly (number | string)[] = [20, 0, 0, "final", 0, ""];
export const SERVER_SERIE = "20.0";
export const BUS_WORKER_VERSION = "saas-19.5-1"; // addons/bus/websocket.py WebsocketConnectionHandler._VERSION

export interface SessionInfoRequest {
  readonly cr: Cursor;
  readonly session: Session;
  /** `request.env.user`: the session user, or the public user for auth="public"/none routes. */
  readonly uid: number;
  readonly cookies: ReadonlyMap<string, string>;
  /** `request.best_lang` for context_get's fallback chain. */
  readonly bestLang: string | null;
}

export type SessionInfo = Record<string, unknown>;

/** The mail stream adds `storeData` (mail/models/ir_http.py:11-28); registered by src/mail/, imported by index.ts. */
export type SessionInfoHook = (req: SessionInfoRequest, user: UserRow, flags: UserFlags, info: SessionInfo) => Promise<void>;
const HOOKS: SessionInfoHook[] = [];

export function registerSessionInfoHook(hook: SessionInfoHook): void {
  HOOKS.push(hook);
}

/** `odoo.tools.misc.hmac(env(su=True), "webclient-cache", registry.registry_sequence)` (web/models/ir_http.py:121). */
export async function registryHash(cr: Cursor): Promise<string> {
  // registry_sequence is `SELECT max(id) FROM orm_signaling_registry` (odoo/orm/registry.py:1120-1130)
  const r = await cr.query<{ seq: number | null }>("SELECT max(id) AS seq FROM orm_signaling_registry");
  const seq = r.rows[0]?.seq ?? null;
  if (seq === null) throw new Error("orm_signaling_registry is empty");
  return odooHmac(await databaseSecret(cr), "webclient-cache", Number(seq));
}

/** `res.currency.get_all_currencies()` (res_currency.py:333-342): active currencies by id, keyed by id. */
export async function allCurrencies(cr: Cursor): Promise<Record<string, unknown>> {
  const r = await cr.query<{ id: number; name: string; symbol: string; position: string; decimal_places: number }>(
    "SELECT id, name, symbol, position, decimal_places FROM res_currency WHERE active ORDER BY id",
  );
  const out: Record<string, unknown> = {};
  for (const c of r.rows) out[String(c.id)] = { name: c.name, symbol: c.symbol, position: c.position, digits: [69, c.decimal_places] };
  return out;
}

/** `ir.ui.view.get_view_info()` (web/models/ir_ui_view.py:9-32 with mail 14-15 and web_hierarchy 57-58). */
export async function viewInfo(cr: Cursor, lang = "en_US"): Promise<Record<string, unknown>> {
  const icons: Record<string, { icon: string; multi_record?: boolean }> = {
    hierarchy: { icon: "family_history" }, // web_hierarchy
    activity: { icon: "schedule" }, // mail
    list: { icon: "reorder" },
    form: { icon: "contact_mail", multi_record: false },
    graph: { icon: "bar_chart" },
    pivot: { icon: "oi_view-pivot" },
    kanban: { icon: "oi_view-kanban" },
    calendar: { icon: "calendar_today" },
    search: { icon: "search" },
  };
  // fields_get(['type'], ['selection'])['type']['selection']: ir_model_fields_selection in sequence order
  const r = await cr.query<{ value: string; name: unknown }>(
    `SELECT s.value, s.name FROM ir_model_fields_selection s JOIN ir_model_fields f ON f.id = s.field_id
      WHERE f.model = 'ir.ui.view' AND f.name = 'type' ORDER BY s.sequence, s.id`,
  );
  const out: Record<string, unknown> = {};
  for (const row of r.rows) {
    const info = icons[row.value];
    if (row.value === "qweb" || info === undefined) continue;
    // fields_get labels in the request env's language (ir_model.py:1607-1620 get_field_selection), en_US fallback
    const names = typeof row.name === "object" && row.name !== null ? (row.name as Record<string, unknown>) : null;
    const label = names !== null ? (names[lang] ?? names["en_US"]) : row.name;
    out[row.value] = { display_name: label, icon: info.icon, multi_record: info.multi_record ?? true };
  }
  return out;
}

/**
 * `res.users.settings._find_or_create_for_user(user)._res_users_settings_format()` (res_users_settings.py:24-45):
 * the fields of the installed modules in `_fields` order: id, embedded_actions_config_ids (web/models/
 * res_users_settings.py:7-14), channel_notifications (mail/models/discuss/res_users_settings.py:15), user_id as
 * `{'id': ...}` last; `volume_settings_ids` is blacklisted by mail, `display_name` by base.
 */
async function userSettings(cr: Cursor, uid: number): Promise<Record<string, unknown>> {
  let r = await cr.query<{ id: number; channel_notifications: string | null }>(
    "SELECT id, channel_notifications FROM res_users_settings WHERE user_id = $1 ORDER BY id LIMIT 1", [uid],
  );
  if (r.rows.length === 0) {
    // sudo().create({'user_id': user.id}); the table is excluded from the harness's database diff
    await cr.query(
      `INSERT INTO res_users_settings (user_id, create_uid, create_date, write_uid, write_date)
       VALUES ($1, $1, now(), $1, now())`, [uid],
    );
    r = await cr.query("SELECT id, channel_notifications FROM res_users_settings WHERE user_id = $1 ORDER BY id LIMIT 1", [uid]);
  }
  const row = r.rows[0];
  if (row === undefined) throw new Error("res_users_settings insert failed");
  const emb = await cr.query<{ action_id: number; res_id: number | null; embedded_actions_order: string | null; embedded_actions_visibility: string | null; embedded_visibility: boolean | null }>(
    "SELECT action_id, res_id, embedded_actions_order, embedded_actions_visibility, embedded_visibility FROM res_users_settings_embedded_action WHERE user_setting_id = $1 ORDER BY id",
    [row.id],
  );
  const config: Record<string, unknown> = {};
  const idList = (s: string | null): (number | false)[] => (s === null || s === "" ? [] : s.split(",").map((x) => (x === "false" ? false : Number(x))));
  for (const e of emb.rows) {
    // web/models/res_users_settings_embedded_action.py:54-66
    config[`${e.action_id}+${e.res_id ?? ""}`] = {
      embedded_actions_order: idList(e.embedded_actions_order),
      embedded_actions_visibility: idList(e.embedded_actions_visibility),
      embedded_visibility: e.embedded_visibility ?? false,
    };
  }
  const out: Record<string, unknown> = { id: row.id, embedded_actions_config_ids: config, channel_notifications: row.channel_notifications ?? false };
  // calendar/models/res_users_settings.py:9 calendar_show_activities (Boolean, default True), in _fields order
  if (await isInstalled(cr, "calendar")) {
    const c = await cr.query<{ v: boolean | null }>("SELECT calendar_show_activities AS v FROM res_users_settings WHERE id = $1", [row.id]);
    out["calendar_show_activities"] = c.rows[0]?.v ?? false;
  }
  out["user_id"] = { id: uid };
  return out;
}

interface CompanyRow { id: number; name: string; sequence: number; parent_id: number | null; currency_id: number; iap_enrich_auto_done: boolean | null }

async function companies(cr: Cursor, ids: readonly number[]): Promise<CompanyRow[]> {
  if (ids.length === 0) return [];
  const r = await cr.query<CompanyRow>(
    "SELECT id, name, sequence, parent_id, currency_id, iap_enrich_auto_done FROM res_company WHERE id = ANY($1::int[])", [ids],
  );
  const byId = new Map(r.rows.map((c) => [c.id, c]));
  return ids.map((id) => {
    const c = byId.get(id);
    if (c === undefined) throw new Error(`res_company ${id} missing`);
    return c;
  });
}

/** `bus.bus._bus_last_id()` (addons/bus/models/bus.py:182-184). */
async function busLastId(cr: Cursor): Promise<number> {
  const r = await cr.query<{ id: number | null }>("SELECT max(id) AS id FROM bus_bus");
  return r.rows[0]?.id ?? 0;
}

/**
 * ir.http `session_info()` (web/models/ir_http.py:87 and the modules' overrides) through the private hook: a site's
 * compiled override (l10n_tr's ir_http.py:7-14, each allowed company's fiscal country code) runs around the hand port's.
 * Without one (every template but such a site) the hand port's answers directly, with no environment made.
 */
export async function sessionInfo(req: SessionInfoRequest): Promise<SessionInfo> {
  const priv = await import("../orm/dispatch_gen");
  if (!priv.ir_http.session_info.quick()) return sessionInfoHand(req);
  const { createEnvironment } = await import("../orm/env");
  const env = await createEnvironment({ cr: req.cr, uid: req.uid, context: { ...req.session.context } });
  const out = await priv.ir_http.session_info.call(env, [], [], async () => sessionInfoHand(req));
  if (out === null || typeof out !== "object" || Array.isArray(out)) throw new NotPorted(`session_info returning ${JSON.stringify(out)}`);
  return out as SessionInfo;
}

async function sessionInfoHand(req: SessionInfoRequest): Promise<SessionInfo> {
  const { cr, session } = req;
  const sessionUid = session.uid;
  const user = await fetchUser(cr, req.uid);
  if (user === null) throw new Error(`res.users ${req.uid} missing`);
  const flags = await userFlags(cr, user.id);

  // web/models/ir_http.py:91-96: the user's context, written back to the session when it changed
  let userContext: Record<string, unknown> = {};
  // the request env was built from the session context before this update (router.py:388), so view_info below is
  // in the session's previous language (verified against the oracle: the first page after a language change still
  // shows the old labels)
  const requestLang = typeof session.context["lang"] === "string" ? session.context["lang"] : "en_US";
  if (sessionUid !== null) {
    userContext = await contextGet(cr, user, req.bestLang);
    const current = session.context;
    const same = JSON.stringify(current) === JSON.stringify(userContext);
    if (!same) session.context = userContext;
  }
  const maxUpload = await icpInt(cr, "web.max_file_upload_size", DEFAULT_MAX_CONTENT_LENGTH);
  const deviceSalt = (await icpBool(cr, "base.session_check_device")) && sessionUid !== null
    ? (session.get("_device_salt") ?? false) : false;
  const sessionData = session.asData();
  // independent reads, sent together (each read where the dict below has it before)
  const [hash, settings, currencies, views] = await inOrder([registryHash(cr), userSettings(cr, user.id), allCurrencies(cr), viewInfo(cr, requestLang)] as const);

  const info: SessionInfo = {
    uid: sessionUid,
    device_salt: deviceSalt,
    is_system: sessionUid !== null ? flags.isSystem : false,
    is_admin: sessionUid !== null ? flags.isAdmin : false,
    is_public: flags.isPublic,
    is_internal_user: flags.isInternal,
    is_regular_user: sessionUid !== null ? flags.isRegular : false,
    user_context: userContext,
    db: cr.db,
    registry_hash: hash,
    user_settings: settings,
    server_version: SERVER_VERSION,
    server_version_info: SERVER_VERSION_INFO,
    support_url: "https://www.odoo.com/buy",
    name: user.partner_name ?? false,
    username: user.login,
    quick_login: await icpBool(cr, "web.quick_login", true),
    partner_write_date: user.partner_write_date === null ? false : datetimeToString(user.partner_write_date),
    partner_display_name: partnerDisplayName(user),
    partner_id: sessionUid !== null ? user.partner_id : null,
    "web.base.url": (await icpStr(cr, "web.base.url")) ?? "",
    active_ids_limit: (await icpInt(cr, "web.active_ids_limit")) || 20000,
    profile_session: sessionData["profile_session"] ?? null,
    profile_collectors: sessionData["profile_collectors"] ?? null,
    profile_params: sessionData["profile_params"] ?? null,
    max_file_upload_size: maxUpload,
    home_action_id: user.action_id ?? false,
    currencies,
    bundle_params: { lang: session.context["lang"] },
    test_mode: false, // config['test_enable']
    view_info: views,
    groups: { "base.group_allow_export": sessionUid !== null ? flags.allowExport : false },
  };
  if (session.debug !== "") (info["bundle_params"] as Record<string, unknown>)["debug"] = session.debug;
  if (flags.isInternal) {
    // web/models/ir_http.py:151-182: the companies of the user; ancestors outside them are "disallowed"
    const ids = await userCompanyIds(cr, user);
    const comps = await companies(cr, ids);
    const idSet = new Set(ids);
    const ancestors: number[] = [];
    for (const c of comps) if (c.parent_id !== null && !idSet.has(c.parent_id)) ancestors.push(c.parent_id);
    if (ancestors.length > 0) throw new NotPorted("session_info: disallowed ancestor companies (res_company.parent_ids hierarchy)");
    const allIds = new Set(ids);
    const childIds = async (id: number): Promise<number[]> => {
      const r = await cr.query<{ id: number }>("SELECT id FROM res_company WHERE parent_id = $1 ORDER BY sequence, name, id", [id]);
      return r.rows.map((x) => x.id).filter((x) => allIds.has(x));
    };
    // a Map keyed by the company ids (Python's dict: int keys, in the companies' order: sequence, name); a JS object
    // would sort integer keys; src/http/json.ts writes a key as its string
    const allowed = new Map<number, unknown>();
    const children = await inOrder(comps.map((c) => childIds(c.id)));
    comps.forEach((c, i) => {
      allowed.set(c.id, {
        id: c.id, name: c.name, sequence: c.sequence, child_ids: children[i]!,
        parent_id: c.parent_id ?? false, currency_id: c.currency_id,
      });
    });
    info["user_companies"] = { current_company: user.company_id, allowed_companies: allowed, disallowed_ancestor_companies: {} };
    info["show_effect"] = true;
    // base_setup/models/ir_http.py:9-13
    info["show_effect"] = await icpBool(cr, "base_setup.show_effect");
  }
  // module overrides in load order (key order of the dict): barcodes, barcodes_gs1_nomenclature before bus
  const barcodeMods = await installedModules(cr);
  // barcodes/models/ir_http.py:10-14
  if (barcodeMods.has("barcodes") && flags.isInternal) {
    info["max_time_between_keys_in_ms"] = (await icpInt(cr, "barcode.max_time_between_keys_in_ms", 0)) || 150;
  }
  // barcodes_gs1_nomenclature/models/ir_http.py:8-14
  if (barcodeMods.has("barcodes_gs1_nomenclature")) {
    const n = await cr.query<{ is_gs1_nomenclature: boolean | null; gs1_separator_fnc1: string | null }>(
      `SELECT n.is_gs1_nomenclature, n.gs1_separator_fnc1 FROM res_company c JOIN barcode_nomenclature n ON n.id = c.nomenclature_id
       WHERE c.id = $1`, [user.company_id]);
    const row = n.rows[0];
    if (row?.is_gs1_nomenclature === true) info["gs1_group_separator_encodings"] = row.gs1_separator_fnc1 ?? false;
  }
  // bus/models/ir_http.py:107-110
  info["bus_info"] = { last_id: await busLastId(cr), worker_version: BUS_WORKER_VERSION };
  // web_tour/models/ir_http.py:7-10
  info["tour_enabled"] = user.tour_enabled;
  info["current_tour"] = null;
  // mail/models/ir_http.py:11-28: storeData, provided by the mail stream
  for (const hook of HOOKS) await hook(req, user, flags, info);
  // partner_autocomplete/models/ir_http.py:10-15
  if (info["is_admin"] === true) {
    const company = (await companies(cr, [user.company_id]))[0];
    info["iap_company_enrich"] = !(company?.iap_enrich_auto_done ?? false);
  }
  const mods = await installedModules(cr);
  // spreadsheet/models/ir_http.py:9-16
  if (mods.has("spreadsheet")) info["can_insert_in_spreadsheet"] = false;
  return info;
}

/** home.py:73-78: `hmac(env(su=True), "browser_cache_key", user._session_token_get_values())` on the web client page. */
export async function browserCacheSecret(cr: Cursor, uid: number): Promise<string> {
  const values = await sessionTokenValues(cr, uid);
  if (values === false) throw new Error(`res.users ${uid} missing`);
  return odooHmac(await databaseSecret(cr), "browser_cache_key", values.map(([k, v]) => [k, v]));
}

/** web/models/ir_http.py:185-213 `get_frontend_session_info` with bus/models/ir_http.py:99-105. */
export async function frontendSessionInfo(req: SessionInfoRequest): Promise<SessionInfo> {
  const { cr, session } = req;
  const sessionUid = session.uid;
  const flags = await userFlags(cr, req.uid);
  const info: SessionInfo = {
    is_admin: sessionUid !== null ? flags.isAdmin : false,
    is_system: sessionUid !== null ? flags.isSystem : false,
    is_public: flags.isPublic,
    is_internal_user: flags.isInternal,
    is_website_user: sessionUid !== null ? flags.isPublic : false,
    uid: sessionUid,
    registry_hash: await registryHash(cr),
    is_frontend: true,
    profile_session: session.asData()["profile_session"] ?? null,
    profile_collectors: session.asData()["profile_collectors"] ?? null,
    profile_params: session.asData()["profile_params"] ?? null,
    show_effect: await icpBool(cr, "base_setup.show_effect"),
    currencies: await allCurrencies(cr),
    quick_login: await icpBool(cr, "web.quick_login", true),
    bundle_params: { lang: session.context["lang"] },
    server_version: SERVER_VERSION,
    server_version_info: SERVER_VERSION_INFO,
    test_mode: false,
  };
  if (session.debug !== "") (info["bundle_params"] as Record<string, unknown>)["debug"] = session.debug;
  info["bus_info"] = { last_id: null, worker_version: BUS_WORKER_VERSION }; // with_last_id=False
  // http_routing/models/ir_http.py:268-277 (bundle_params.lang = request.lang.code when is_frontend: the same
  // context lang here)
  if (await isInstalled(cr, "http_routing")) info["translationURL"] = "/website/translations";
  // portal/models/ir_http.py:16-22
  if (sessionUid !== null) {
    const tour = (await cr.query<{ t: boolean | null }>("SELECT tour_enabled AS t FROM res_users WHERE id = $1", [req.uid])).rows[0]?.t ?? false;
    info["tour_enabled"] = tour;
    if (tour) info["current_tour"] = null;
  }
  return info;
}

/** `env.ref('base.public_user').id` for `_auth_method_public` (base ir_http.py:372-375). */
export async function publicUserId(cr: Cursor): Promise<number> {
  const id = await xmlidToResId(cr, "base.public_user");
  if (id === null) throw new Error("base.public_user missing");
  return id;
}
