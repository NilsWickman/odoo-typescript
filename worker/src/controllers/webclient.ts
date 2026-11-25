/**
 * `GET /web/webclient/load_menus` (home.py:92-105 -> `ir.ui.menu.load_web_menus`, web/models/ir_ui_menu.py:12-87,
 * `load_menus` and `_visible_menu_ids` in odoo/odoo/addons/base/models/ir_ui_menu.py:68-132, 228-322) and
 * `/web/webclient/version_info` (webclient.py:92-98). Translations, bundles, the service worker and the offline
 * page are stream H2's routes (other files).
 * TODO(orm): plain SQL stands in for the ORM calls cited below; switch to `ctx.orm()` when src/orm/ lands.
 */
import type { Cursor } from "../db";
import { NotPorted, OdooError } from "../errors";
import type { RequestContext } from "../http/context";
import { jsonRoute, route } from "../http/router";
import { SERVER_SERIE, SERVER_VERSION, SERVER_VERSION_INFO } from "../session/info";
import { userGroupIds, userRole, xmlidToResId, SUPERUSER_ID } from "../session/user";

import { readFile as readFilestore } from "../filestore";
import { installedModules } from "../http/modules";
import { registerMethod } from "../http/methods";
import { attachmentValues } from "../models/binary";
import { envFor } from "../web/common";

/** A translated jsonb value for `lang` with the en_US fallback (fields_textual.py: `_get_stored_translations`). */
export function translated(value: unknown, lang: string): string | false {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const picked = v[lang] ?? v["en_US"];
  return typeof picked === "string" ? picked : false;
}

/** The action tables behind `ir_ui_menu.action` ("model,id"), ir_actions.py `_table` per class. */
const ACTION_TABLES: Record<string, string> = {
  "ir.actions.report": "ir_act_report_xml",
  "ir.actions.act_window": "ir_act_window",
  "ir.actions.act_url": "ir_act_url",
  "ir.actions.server": "ir_act_server",
  "ir.actions.client": "ir_act_client",
};

/** ir_ui_menu.py:92-96 MODEL_BY_TYPE: the column naming the model an action opens. */
const MODEL_BY_TYPE: Record<string, string> = {
  "ir.actions.act_window": "res_model",
  "ir.actions.report": "model",
  "ir.actions.server": "model_name",
};

interface MenuRow { id: number; parent_id: number | null; action: string | null; name: unknown; web_icon: string | null; sequence: number }

/**
 * `self.env[model].has_access('read')` for the menus (models.py:3464-3495 -> `_access_domain` 3601-3646):
 * `Domain.OR(permissions)`, so readable when some active `ir_access` row with 'r' in `operation` belongs to one of
 * the user's groups (ir_access.py:34-39 IN_SELECTION); the superuser always may. A model missing from ir_model is not
 * readable (`self.env.get(model) is not None`). Every model the menus open in one statement: Odoo answers each
 * from the ormcache of `_get_access_groups`, the port had two statements per model on a new isolate (207 of the 446
 * statements of a cold load_menus on poc_erp, docs/accept/C2.md).
 */
async function modelsReadable(cr: Cursor, models: readonly string[], groups: ReadonlySet<number>, uid: number): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (models.length === 0) return out;
  const r = await cr.query<{ model: string; readable: boolean }>(
    `SELECT m.model, EXISTS (SELECT 1 FROM ir_access a WHERE a.model_id = m.id AND COALESCE(a.active, false)
        AND a.operation LIKE '%r%' AND a.group_id = ANY($2::int[])) AS readable
      FROM ir_model m WHERE m.model = ANY($1::varchar[])`,
    [[...models], [...groups]],
  );
  for (const row of r.rows) out.set(row.model, uid === SUPERUSER_ID || row.readable);
  for (const m of models) if (!out.has(m)) out.set(m, false);
  return out;
}

/** An action a menu points to: the model it opens (MODEL_BY_TYPE, or null) and its `path`. */
interface MenuAction { opened: string | null; path: string | null }

/**
 * The actions behind the menus, per action model: one statement for every action table (ir_ui_menu.py:86-113 reads
 * them per model to check existence and the opened model, :294-303 again for the paths).
 */
async function menuActions(cr: Cursor, menus: readonly MenuRow[]): Promise<Map<string, Map<number, MenuAction>>> {
  const byModel = new Map<string, number[]>();
  for (const m of menus) {
    const ref = parseActionRef(m.action);
    if (ref === null) continue;
    const list = byModel.get(ref.model) ?? [];
    list.push(ref.id);
    byModel.set(ref.model, list);
  }
  const parts: string[] = [];
  const params: unknown[] = [];
  const models: string[] = [];
  for (const [model, ids] of byModel) {
    const table = ACTION_TABLES[model];
    if (table === undefined) throw new NotPorted(`menu action model ${model}`);
    const modelCol = MODEL_BY_TYPE[model];
    params.push(ids);
    const p = `$${params.length}::int[]`;
    const k = models.length;
    models.push(model);
    if (modelCol === undefined) parts.push(`SELECT ${k} AS k, id, NULL::varchar AS opened, path FROM ${table} WHERE id = ANY(${p})`);
    else if (model === "ir.actions.server") parts.push(`SELECT ${k} AS k, a.id, im.model AS opened, a.path FROM ${table} a LEFT JOIN ir_model im ON im.id = a.model_id WHERE a.id = ANY(${p})`);
    else parts.push(`SELECT ${k} AS k, id, ${modelCol}::varchar AS opened, path FROM ${table} WHERE id = ANY(${p})`);
  }
  const out = new Map<string, Map<number, MenuAction>>(models.map((m) => [m, new Map()]));
  if (parts.length === 0) return out;
  const r = await cr.query<{ k: number; id: number; opened: string | null; path: string | null }>(parts.join(" UNION ALL "), params);
  for (const x of r.rows) out.get(models[x.k]!)!.set(x.id, { opened: x.opened, path: x.path });
  return out;
}

/** ir_ui_menu.py:68-132 `_visible_menu_ids`, with the actions read for it (reused for the paths by `loadMenus`). */
async function visibleMenuIds(cr: Cursor, uid: number, debug: boolean): Promise<{ visible: Set<number>; actions: Map<string, Map<number, MenuAction>> }> {
  const groups = new Set(await userGroupIds(cr, uid));
  const role = await userRole(cr, groups);
  const isRegular = role === "regular_user" || role === "group_system";
  if (!debug || !isRegular) {
    const noOne = await xmlidToResId(cr, "base.group_no_one");
    if (noOne !== null) groups.delete(noOne);
  }
  // search_fetch(['|', ('group_ids', '=', False), ('group_ids', 'in', group_ids)], ['parent_id', 'action'], order='id')
  const menus = await cr.query<MenuRow>(
    `SELECT m.id, m.parent_id, m.action, m.name, m.web_icon, m.sequence FROM ir_ui_menu m
      WHERE COALESCE(m.active, false)
        AND (NOT EXISTS (SELECT 1 FROM ir_ui_menu_group_rel r WHERE r.menu_id = m.id)
             OR EXISTS (SELECT 1 FROM ir_ui_menu_group_rel r WHERE r.menu_id = m.id AND r.gid = ANY($1::int[])))
      ORDER BY m.id`,
    [[...groups]],
  );
  // existing actions, with the model field they open (ir_ui_menu.py:86-113)
  const existing = await menuActions(cr, menus.rows);
  const opened = new Set<string>();
  for (const m of menus.rows) {
    const ref = parseActionRef(m.action);
    if (ref === null || MODEL_BY_TYPE[ref.model] === undefined) continue;
    const o = existing.get(ref.model)?.get(ref.id)?.opened ?? null;
    if (o !== null) opened.add(o);
  }
  const readable = await modelsReadable(cr, [...opened], groups, uid);
  const menuIds = new Set(menus.rows.map((m) => m.id));
  const parentOf = new Map(menus.rows.map((m) => [m.id, m.parent_id]));
  const visible = new Set<number>();
  for (const m of menus.rows) {
    const ref = parseActionRef(m.action);
    if (ref === null) continue;
    const found = existing.get(ref.model);
    if (found === undefined || !found.has(ref.id)) continue;
    if (MODEL_BY_TYPE[ref.model] !== undefined) {
      const o = found.get(ref.id)?.opened ?? null;
      if (o === null || readable.get(o) !== true) continue;
    }
    // make the menu visible, and its folder ancestors too (ir_ui_menu.py:125-130)
    let id: number | null = m.id;
    while (id !== null && !visible.has(id) && menuIds.has(id)) {
      visible.add(id);
      id = parentOf.get(id) ?? null;
    }
  }
  return { visible, actions: existing };
}

function parseActionRef(ref: string | null): { model: string; id: number } | null {
  if (ref === null || ref === "") return null;
  const comma = ref.indexOf(",");
  if (comma < 0) return null;
  const id = Number(ref.slice(comma + 1));
  return Number.isInteger(id) ? { model: ref.slice(0, comma), id } : null;
}

interface MenuDict {
  id: number;
  name: string | false;
  app_id: number;
  action_model: string | false;
  action_id: number | false;
  web_icon: string | false;
  web_icon_data: string | false;
  web_icon_data_mimetype: string | false;
  xmlid: string;
  action_path: string | false;
  children: number[];
}

/**
 * `_load_menus_blacklist` (ir_ui_menu.py:204, `[]`) with the installed overrides: project/models/ir_ui_menu.py:10-20
 * (hr*, the other overriding modules, are refused when installed).
 */
async function loadMenusBlacklist(cr: Cursor, uid: number, debug: boolean): Promise<Set<number>> {
  const mods = await installedModules(cr);
  for (const m of ["hr", "hr_timesheet", "hr_timesheet_attendance", "hr_holidays_attendance", "hr_recruitment"]) {
    if (mods.has(m)) throw new NotPorted(`${m}/models/ir_ui_menu.py _load_menus_blacklist`);
  }
  const out = new Set<number>();
  if (!mods.has("project")) return out;
  const groups = new Set(await userGroupIds(cr, uid));
  const has = async (xmlid: string): Promise<boolean> => {
    const id = await xmlidToResId(cr, xmlid);
    // res_users.py:1196 has_group: base.group_no_one only with request.session.debug
    return id !== null && groups.has(id) && (xmlid !== "base.group_no_one" || debug);
  };
  const ref = async (xmlid: string): Promise<void> => {
    const id = await xmlidToResId(cr, xmlid);
    if (id === null) throw new Error(`${xmlid} missing`); // env.ref raises
    out.add(id);
  };
  const stages = await has("project.group_project_stages");
  if (stages) {
    await ref("project.menu_projects");
    await ref("project.menu_projects_config");
  }
  if (!(stages && await has("base.group_no_one"))) await ref("project.menu_project_config_project_stage");
  return out;
}

/**
 * ir_ui_menu.py:228-311 `load_menus(debug)`: the visible menus in `_order`. `debug` is the request's session's: both
 * `_filter_visible_menus` (:134-140) and `has_group('base.group_no_one')` in `_load_menus_blacklist` read
 * `request.session.debug`; the method's own `debug` argument only keys its ormcache.
 */
async function loadMenus(cr: Cursor, uid: number, lang: string, debug: boolean,
  iconBytes: (a: { res_id: number; store_fname: string | null; db_datas: Buffer | null }) => Promise<Uint8Array | null>): Promise<{ menus: Map<number, MenuDict>; roots: number[] }> {
  const { visible, actions } = await visibleMenuIds(cr, uid, debug);
  // search_fetch([...], ['name', 'parent_id', 'action', 'web_icon']) in _order = "sequence,id" (ir_ui_menu.py:18)
  const all = await cr.query<MenuRow>(
    "SELECT id, parent_id, action, name, web_icon, sequence FROM ir_ui_menu WHERE COALESCE(active, false) ORDER BY sequence, id",
  );
  const blacklist = await loadMenusBlacklist(cr, uid, debug);
  let rows = all.rows.filter((m) => visible.has(m.id) && !blacklist.has(m.id));
  const children = new Map<number | false, number[]>();
  for (const m of rows) {
    const key = m.parent_id ?? false;
    const list = children.get(key) ?? [];
    list.push(m.id);
    children.set(key, list);
  }
  const appInfo = new Map<number, number>();
  const setApp = (appId: number, menuId: number): void => {
    appInfo.set(menuId, appId);
    for (const child of children.get(menuId) ?? []) setApp(appId, child);
  };
  for (const root of children.get(false) ?? []) setApp(root, root);
  rows = rows.filter((m) => appInfo.has(m.id));
  const ids = rows.map((m) => m.id);

  // _get_menuitems_xmlids (ir_ui_menu.py:313-322): complete_name per res_id, the last one wins
  const xml = await cr.query<{ res_id: number; module: string; name: string }>(
    "SELECT res_id, module, name FROM ir_model_data WHERE model = 'ir.ui.menu' AND res_id = ANY($1::int[]) ORDER BY module, name, id",
    [ids],
  );
  const xmlids = new Map<number, string>();
  for (const x of xml.rows) xmlids.set(x.res_id, `${x.module}.${x.name}`);

  // icon attachments (ir_ui_menu.py:256-265): raw bytes to base64 and the mimetype
  const att = await cr.query<{ res_id: number; mimetype: string | null; store_fname: string | null; db_datas: Buffer | null }>(
    `SELECT res_id, mimetype, store_fname, db_datas FROM ir_attachment
      WHERE res_model = 'ir.ui.menu' AND res_field = 'web_icon_data' AND res_id = ANY($1::int[]) ORDER BY res_id`,
    [ids],
  );
  const icons = new Map<number, { data: string; mimetype: string | false }>();
  for (const a of att.rows) {
    let bytes: Uint8Array | null = a.db_datas;
    if (bytes === null) bytes = await iconBytes(a);
    if (bytes === null) throw new NotPorted(`web_icon_data of menu ${a.res_id}: attachment ${a.store_fname ?? ""} not in the filestore`);
    icons.set(a.res_id, { data: Buffer.from(bytes).toString("base64"), mimetype: a.mimetype ?? false });
  }

  // action paths (ir_ui_menu.py:294-303), read with the actions above: the visible menus are among the searched ones
  const pathByRef = new Map<string, string | false>();
  for (const [model, byId] of actions) for (const [id, a] of byId) pathByRef.set(`${model},${id}`, a.path ?? false);

  const menus = new Map<number, MenuDict>();
  for (const m of rows) {
    const ref = parseActionRef(m.action);
    const icon = icons.get(m.id);
    menus.set(m.id, {
      id: m.id,
      name: translated(m.name, lang),
      app_id: appInfo.get(m.id) ?? m.id,
      action_model: ref?.model ?? false,
      action_id: ref?.id ?? false,
      web_icon: m.web_icon ?? false,
      web_icon_data: icon?.data ?? false,
      web_icon_data_mimetype: icon?.mimetype ?? false,
      xmlid: xmlids.get(m.id) ?? "",
      action_path: ref === null ? false : (pathByRef.get(`${ref.model},${ref.id}`) ?? false),
      children: children.get(m.id) ?? [],
    });
  }
  return { menus, roots: children.get(false) ?? [] };
}

/** ir_ui_menu.py:228-311 `load_menus` then web/models/ir_ui_menu.py:12-87 `load_web_menus`. */
export async function loadWebMenus(ctx: RequestContext, debug: boolean): Promise<Record<string, unknown>> {
  const cr = ctx.cursor();
  const uid = ctx.uid;
  if (uid === null) throw new Error("load_menus without a user");
  const db = ctx.db;
  if (db === null) throw new Error("load_menus without a database");
  const lang = typeof ctx.context["lang"] === "string" ? ctx.context["lang"] : "en_US";
  const { menus, roots } = await loadMenus(cr, uid, lang, debug, async (a) => a.store_fname !== null ? readFilestore(ctx.env, db, a.store_fname) : null);

  // load_web_menus (web/models/ir_ui_menu.py:21-87)
  const web: Record<string, unknown> = {};
  for (const menu of menus.values()) {
    let actionId = menu.action_id;
    let actionModel = menu.action_model;
    let actionPath = menu.action_path;
    let webIcon: string | false = menu.web_icon;
    let webIconData: string | false = menu.web_icon_data;
    if (menu.id === menu.app_id) {
      // an app takes the action of its first (sub)child having one
      let child: MenuDict | false = menu;
      while (child !== false && actionId === false) {
        actionId = child.action_id;
        actionModel = child.action_model;
        actionPath = child.action_path;
        const first: number | undefined = child.children[0];
        child = first === undefined ? false : (menus.get(first) ?? false);
      }
      const parts = menu.web_icon === false || menu.web_icon === "" ? [] : menu.web_icon.split(",");
      let icon: string | null = null;
      let color: string | null = null;
      let background: string | null = null;
      if (parts.length >= 2) [icon, color] = [parts[0] ?? "", parts[1] ?? ""];
      if (parts.length === 3) background = parts[2] ?? "";
      if (menu.web_icon_data !== false && menu.web_icon_data !== "") {
        // re.sub(r'\s/g', "", ...) is a no-op pattern in Odoo: the data uri is emitted as is
        webIconData = `data:${menu.web_icon_data_mimetype === false ? "" : menu.web_icon_data_mimetype};base64,${menu.web_icon_data}`;
      } else if (background !== null) {
        webIcon = [icon ?? "", color ?? "", background].join(",");
      } else {
        webIconData = "/web/static/img/default_icon_app.png";
      }
    }
    web[String(menu.id)] = {
      id: menu.id,
      name: menu.name,
      children: menu.children,
      appID: menu.app_id,
      xmlid: menu.xmlid,
      actionID: actionId,
      actionModel: actionModel,
      actionPath: actionPath,
      webIcon: webIcon,
      webIconData: webIconData,
      webIconDataMimetype: menu.web_icon_data_mimetype,
    };
  }
  web["root"] = {
    id: "root",
    name: "root",
    children: roots,
    appID: false,
    xmlid: "",
    actionID: false,
    actionModel: false,
    actionPath: false,
    webIcon: null,
    webIconData: null,
    webIconDataMimetype: null,
    backgroundImage: null, // menu.get('backgroundImage') of the root dict: absent -> None
  };
  return web;
}

// ir_ui_menu.py:228-311 `load_menus(debug)` over call_kw (`@api.model`): the menus dict, keyed by id, and 'root'
// (its TypeErrors name `<lambda>`: the ormcache wrapper, odoo/tools/cache.py)
registerMethod("ir.ui.menu", "load_menus", async (env0, _ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  for (const k of Object.keys(kwargs)) if (k !== "debug") throw new OdooError("builtins.TypeError", `<lambda>() got an unexpected keyword argument '${k}'`);
  if (args.length > 1) throw new OdooError("builtins.TypeError", `<lambda>() takes 2 positional arguments but ${args.length + 1} were given`);
  if (!("debug" in kwargs) && args.length === 0) throw new OdooError("builtins.TypeError", "<lambda>() missing 1 required positional argument: 'debug'");
  const sudo = env.sudo();
  const { menus, roots } = await loadMenus(env.cr, env.uid, env.lang ?? "en_US", env.debug, async (a) => {
    const v = (await attachmentValues(sudo, "ir.ui.menu", "web_icon_data", [a.res_id])).get(a.res_id);
    return v ? v.content() : null;
  });
  const out: Record<string, unknown> = {};
  for (const [id, m] of menus) out[String(id)] = m;
  out["root"] = { id: false, name: "root", children: roots };
  return out;
}, { apiModel: true, readonly: true });

// home.py:92-105
route("/web/webclient/load_menus", async (ctx) => {
  const lang = ctx.params["lang"];
  if (typeof lang === "string" && lang !== "") ctx.updateContext({ lang });
  const menus = await loadWebMenus(ctx, ctx.sessionState.debug !== "");
  return ctx.makeJsonResponse(menus, { "Cache-Control": "no-store" });
}, { auth: "user", methods: ["GET"], readonly: true, checkIdentity: false });

// webclient.py:92-98
jsonRoute("/web/webclient/version_info", async () => ({
  server_version: SERVER_VERSION,
  server_version_info: SERVER_VERSION_INFO,
  server_serie: SERVER_SERIE,
}), { auth: "none" });
