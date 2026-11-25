/**
 * The server side of the bus websocket protocol, version `saas-19.5-1` (odoo/addons/bus/websocket.py:814):
 * `WebsocketRequest.serve_websocket_message` / `_serve_ir_websocket` (websocket.py:735-769), the `ir.websocket`
 * model (odoo/addons/bus/models/ir_websocket.py) with the mail and discuss overrides
 * (odoo/addons/mail/models/ir_websocket.py, odoo/addons/mail/models/discuss/ir_websocket.py), and
 * `Websocket.send_worker_internal_message` (websocket.py:301-307).
 *
 * Frames the client sends (odoo/addons/bus/static/src/workers/websocket_worker.js):
 *   {"event_name": "subscribe", "data": {"channels": [...], "check_outdated": bool, "last": int|null}}   (l.592-599)
 *   {"event_name": "update_presence", "data": {"inactivity_period": int}}                                  (mail im_status_service.js:29)
 *   a one-byte binary frame 0x00 as connection check (l.473), ignored by the server (websocket.py:964-966)
 * Frames the server sends: a JSON list of notifications `[{"id": int, "message": {"type", "payload"}}]`
 * (bus_dispatcher.py:204-212, notifications.py:55) or of internal messages
 * `[{"type": "bus/last_id_reset"|"bus/subscription_outdated", "internal": true, "payload": ...}]` (websocket.py:307).
 *
 * The transport (frames, hibernation, fan-out) is the BusDispatcher Durable Object (src/do/bus.ts); this module
 * is pure protocol over a Cursor so the HTTP fallbacks (`/websocket/peek_notifications`) share it.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Cursor } from "../db";
import { NotPorted, SessionExpired } from "../errors";
import { BusValues, busLastId, channelWithDb, jsonDump, type BusRow, type RecordTarget } from "./bus";
import { setPresenceOffline, updatePresence } from "./presence";

/** websocket.py:814 `WebsocketConnectionHandler._VERSION`. */
export const VERSION = "saas-19.5-1";

/** odoo/addons/bus/websocket_protocol.py:62-78. */
export const CloseCode = {
  CLEAN: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  INCORRECT_DATA: 1003,
  ABNORMAL_CLOSURE: 1006,
  INCONSISTENT_DATA: 1007,
  MESSAGE_VIOLATING_POLICY: 1008,
  MESSAGE_TOO_BIG: 1009,
  EXTENSION_NEGOTIATION_FAILED: 1010,
  SERVER_ERROR: 1011,
  RESTART: 1012,
  TRY_LATER: 1013,
  BAD_GATEWAY: 1014,
  SESSION_EXPIRED: 4001,
  KEEP_ALIVE_TIMEOUT: 4002,
  KILL_NOW: 4003,
} as const;

/** What the websocket keeps of the HTTP session that opened it (websocket.py:198-203, 728-733). */
export interface WsSession {
  readonly db: string;
  readonly sid: string;
  /** `session.uid`: null for the public user. */
  readonly uid: number | null;
}

/** The websocket as the protocol sees it: `Websocket.send`, `send_worker_internal_message`, `dispatch.subscribe`. */
export interface WsSender {
  /** websocket.py:301-307: `[{"type": type_, "internal": True, "payload": payload}]`, not stored. */
  sendWorkerInternalMessage(type: string, payload?: unknown): void;
  /** bus_dispatcher.py:393-431 `dispatch.subscribe(channels, last, websocket)`: channels are `json_dump` strings. */
  subscribe(channels: readonly string[], last: number): Promise<void>;
}

/** websocket_protocol.py:32-34. Odoo logs it and keeps the connection open (websocket.py:975-976). */
export class InvalidWebsocketRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWebsocketRequest";
  }
}

/** The parts of `res.users` the channel list needs (`self.env.user`). */
export interface WsUser {
  readonly id: number;
  readonly partnerId: number;
  /** res_users.py:506-510 `_compute_share`: not in base.group_user. */
  readonly share: boolean;
  /** `self.env.user._is_public()`: the `base.public_user` record. */
  readonly isPublic: boolean;
  /** `all_group_ids` (res_users.py:252-253, 486-488): the reflexive transitive closure of group_ids. */
  readonly groupIds: readonly number[];
  readonly companyIds: readonly number[];
}

type ClientChannel = string | RecordTarget;

const PRESENCE_CHANNEL_PREFIX = "odoo-presence-"; // mail/models/ir_websocket.py:12
const PRESENCE_CHANNEL_REGEX = /^odoo-presence-(res\.users|mail\.guest)_(\d+)(?:-([a-f0-9]{64}o0x[a-f0-9]+))?$/; // :13-17

async function xmlidToResId(cr: Cursor, module: string, name: string): Promise<number> {
  const r = await cr.query<{ res_id: number }>("SELECT res_id FROM ir_model_data WHERE module = $1 AND name = $2", [module, name]);
  const id = r.rows[0]?.res_id;
  if (id === undefined) throw new Error(`xmlid ${module}.${name} not found`);
  return id;
}

/**
 * ir_websocket.py:102-107 `_authenticate` and the environment user it yields: the session's user, or
 * `base.public_user` when the session has none. The session token check (`odoo/http/session.py:405-451
 * check()`) is the HTTP stream's session module; here the Worker authenticated the cookie at the upgrade and the
 * uid travels in the socket attachment. A logout during the connection is therefore not detected per message.
 */
export async function loadUser(cr: Cursor, uid: number | null): Promise<WsUser> {
  const publicId = await xmlidToResId(cr, "base", "public_user");
  const id = uid ?? publicId;
  const u = await cr.query<{ id: number; partner_id: number; active: boolean }>(
    "SELECT id, partner_id, active FROM res_users WHERE id = $1",
    [id],
  );
  const row = u.rows[0];
  if (row === undefined || (id !== publicId && !row.active)) throw new SessionExpired();
  const groups = await cr.query<{ gid: number }>(
    `WITH RECURSIVE g(gid) AS (
       SELECT gid FROM res_groups_users_rel WHERE uid = $1
       UNION
       SELECT r.hid FROM res_groups_implied_rel r JOIN g ON r.gid = g.gid)
     SELECT gid FROM g ORDER BY gid`,
    [id],
  );
  const groupIds = groups.rows.map((g) => g.gid);
  const companies = await cr.query<{ cid: number }>("SELECT cid FROM res_company_users_rel WHERE user_id = $1 ORDER BY cid", [id]);
  const groupUser = await xmlidToResId(cr, "base", "group_user");
  return {
    id,
    partnerId: row.partner_id,
    share: !groupIds.includes(groupUser),
    isPublic: id === publicId,
    groupIds,
    companyIds: companies.rows.map((c) => c.cid),
  };
}

/** Python `repr()` of the tuples `odoo.tools.misc.hmac` signs (misc.py:1815): strings, ints and nested tuples. */
function pyRepr(value: unknown): string {
  if (typeof value === "string") {
    if (value.includes("'") && !value.includes('"')) return `"${value}"`;
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `(${value.map(pyRepr).join(", ")}${value.length === 1 ? "," : ""})`;
  throw new Error(`pyRepr: unsupported ${typeof value}`);
}

/**
 * misc.py:1877-1933 `limited_field_access_token` / `verify_limited_field_access_token`: the token is
 * `hmac(database.secret, repr((scope, (model, id, field, timestamp))))` + "o" + timestamp (hex), valid while the
 * timestamp is in the future (misc.py:1930-1933; the clock is the database's).
 */
async function verifyLimitedFieldAccessToken(
  cr: Cursor,
  model: string,
  id: number,
  fieldName: string,
  accessToken: string,
  scope: string,
): Promise<boolean> {
  const sep = accessToken.lastIndexOf("o");
  if (sep < 0) return false;
  const timestamp = accessToken.slice(sep + 1);
  if (!/^0x[a-f0-9]+$/.test(timestamp)) return false;
  const secret = await cr.query<{ value: string }>("SELECT value FROM ir_config_parameter WHERE key = 'database.secret'");
  const key = secret.rows[0]?.value;
  if (key === undefined || key === "") throw new Error("database.secret is not set");
  const message = pyRepr([scope, [model, id, fieldName, timestamp]]);
  const expected = `${createHmac("sha256", key).update(message).digest("hex")}o${timestamp}`;
  const a = Buffer.from(accessToken);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const now = await cr.query<{ epoch: string }>("SELECT extract(epoch FROM now())::text AS epoch");
  return Number(now.rows[0]?.epoch ?? "0") < parseInt(timestamp, 16);
}

/**
 * `res.users.has_access("read")` for the presence channels, evaluated as the template's `ir_access` rows for
 * res.users (poc_corpus ids 67 "res_users all" group base.group_everyone `[('id','=',user.id)]`, 68 portal
 * `commercial_partner_id`, 69 "read all" base.group_user, 71 "edit all" base.group_erp_manager, 72 "user rule" for
 * everyone `['|', ('share','=',False), ('company_ids','in',company_ids)]`). Rules whose group the user has are
 * OR-ed; one without a domain grants everything. To be replaced by the ORM stream's ir.access evaluation.
 */
export async function readableUserIds(cr: Cursor, user: WsUser, ids: readonly number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const [groupUser, groupErpManager, groupPortal, groupEveryone] = await Promise.all([
    xmlidToResId(cr, "base", "group_user"),
    xmlidToResId(cr, "base", "group_erp_manager"),
    xmlidToResId(cr, "base", "group_portal"),
    xmlidToResId(cr, "base", "group_everyone"),
  ]);
  const inGroups = user.groupIds;
  if (inGroups.includes(groupUser) || inGroups.includes(groupErpManager)) {
    const r = await cr.query<{ id: number }>(
      `SELECT u.id FROM res_users u
        WHERE u.id = ANY($1::int[])
          AND (u.share IS NOT TRUE
            OR EXISTS (SELECT 1 FROM res_company_users_rel cu WHERE cu.user_id = u.id AND cu.cid = ANY($2::int[])))
        ORDER BY u.id`,
      [ids, user.companyIds],
    );
    return r.rows.map((x) => x.id);
  }
  const r = await cr.query<{ id: number }>(
    `SELECT u.id FROM res_users u
       JOIN res_partner p ON p.id = u.partner_id
      WHERE u.id = ANY($1::int[])
        AND (($2::boolean AND u.id = $3)
          OR ($4::boolean AND p.commercial_partner_id = (SELECT pp.commercial_partner_id FROM res_partner pp WHERE pp.id = $5)))
        AND (u.share IS NOT TRUE
          OR EXISTS (SELECT 1 FROM res_company_users_rel cu WHERE cu.user_id = u.id AND cu.cid = ANY($6::int[])))
      ORDER BY u.id`,
    [ids, inGroups.includes(groupEveryone), user.id, inGroups.includes(groupPortal), user.partnerId, user.companyIds],
  );
  return r.rows.map((x) => x.id);
}

/**
 * discuss/ir_websocket.py:38-45: `discuss.channel.search(["|", ("is_member", "=", True), ("id", "in", ids)])`
 * under the template's ir_access rows for discuss.channel (poc_corpus 188 for base.group_everyone: members of
 * non-"channel" channels or their parent, "channel" channels with no group or one of the user's groups; 190
 * base.group_system: everything). `is_member` is membership of the user's partner (discuss_channel.py:404-420).
 */
async function userDiscussChannels(cr: Cursor, user: WsUser, requested: readonly number[]): Promise<number[]> {
  const groupSystem = await xmlidToResId(cr, "base", "group_system");
  const r = await cr.query<{ id: number }>(
    `SELECT c.id FROM discuss_channel c
      WHERE c.active
        AND (EXISTS (SELECT 1 FROM discuss_channel_member m WHERE m.channel_id = c.id AND m.partner_id = $1 AND $2::boolean)
             OR c.id = ANY($3::int[]))
        AND ($4::boolean
             OR (c.channel_type <> 'channel' AND $2::boolean AND (
                   EXISTS (SELECT 1 FROM discuss_channel_member m WHERE m.channel_id = c.id AND m.partner_id = $1)
                OR EXISTS (SELECT 1 FROM discuss_channel_member m WHERE m.channel_id = c.parent_channel_id AND m.partner_id = $1)))
             OR (c.channel_type = 'channel' AND (c.group_public_id IS NULL OR c.group_public_id = ANY($5::int[]))))
      ORDER BY c.id`,
    [user.partnerId, !user.isPublic, requested, user.groupIds.includes(groupSystem), user.groupIds],
  );
  return r.rows.map((x) => x.id);
}

/**
 * `ir.websocket._build_bus_channel_list` through the installed overrides, outermost first:
 * discuss (mail/models/discuss/ir_websocket.py:14-57), mail (mail/models/ir_websocket.py:43-90),
 * bus (bus/models/ir_websocket.py:21-35). `sessionUid` is `req.session.uid` (bus ir_websocket.py:32).
 */
const DISCUSS_CATEGORY_REGEX = /^discuss\.category_(\d+)(?:-([a-f0-9]{64}o0x[a-f0-9]+))?$/;

export async function buildBusChannelList(
  cr: Cursor,
  user: WsUser,
  sessionUid: number | null,
  clientChannels: readonly string[],
): Promise<ClientChannel[]> {
  // discuss/ir_websocket.py:15-57
  let channels: ClientChannel[] = [...clientChannels];
  const discussChannelIds: number[] = [];
  const discussCategoryTokens = new Map<number, string>();
  for (const channel of [...channels]) {
    if (typeof channel !== "string") continue;
    if (channel.startsWith("mail.guest_")) {
      throw new NotPorted("bus: mail.guest channels (guest sessions)");
    }
    if (channel.startsWith("discuss.category_")) {
      channels = channels.filter((c) => c !== channel);
      const cm = DISCUSS_CATEGORY_REGEX.exec(channel);
      if (cm !== null) discussCategoryTokens.set(Number(cm[1]), cm[2] ?? "");
      continue;
    }
    const m = /discuss\.channel_(\d+)/.exec(channel);
    if (m !== null) {
      channels = channels.filter((c) => c !== channel);
      discussChannelIds.push(Number(m[1]));
    }
  }
  const allUserChannels = await userDiscussChannels(cr, user, discussChannelIds);
  channels.push(...allUserChannels.map((id): RecordTarget => ({ model: "discuss.channel", id })));
  if (!user.share) {
    channels.push(...allUserChannels.map((id): RecordTarget => ({ model: "discuss.channel", id, sub: "internal_users" })));
  }
  if (discussCategoryTokens.size > 0) {
    const requestedCatIds = [...discussCategoryTokens.keys()];
    const hasCatCol = (await cr.query<{ ok: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'discuss_channel' AND column_name = 'discuss_category_id') AS ok",
    )).rows[0]?.ok === true;
    const memberCatIds = hasCatCol && allUserChannels.length > 0
      ? new Set((await cr.query<{ id: number }>(
          "SELECT DISTINCT discuss_category_id AS id FROM discuss_channel WHERE id = ANY($1::int[]) AND discuss_category_id = ANY($2::int[])",
          [allUserChannels, requestedCatIds],
        )).rows.map((r) => r.id))
      : new Set<number>();
    for (const [catId, token] of discussCategoryTokens) {
      const ok = memberCatIds.has(catId)
        || (token !== "" && (await verifyLimitedFieldAccessToken(cr, "discuss.category", catId, "id", token, "discuss.category")));
      if (ok) channels.push({ model: "discuss.category", id: catId });
    }
  }

  // mail/models/ir_websocket.py:43-90
  const tokenByUserId = new Map<number, string>();
  const toClear = new Set<string>();
  for (const channel of channels) {
    if (typeof channel !== "string" || !channel.startsWith(PRESENCE_CHANNEL_PREFIX)) continue;
    toClear.add(channel);
    const m = PRESENCE_CHANNEL_REGEX.exec(channel);
    if (m === null) continue; // "Malformed presence channel" warning (:51)
    if (m[1] === "mail.guest") throw new NotPorted("bus: mail.guest presence channels");
    tokenByUserId.set(Number(m[2]), m[3] ?? "");
  }
  channels = channels.filter((c) => typeof c !== "string" || !toClear.has(c));
  const userIds = [...tokenByUserId.keys()];
  // `search([("id", "in", ids)])` with active_test=False: res.users `_order = 'name, login'` (res_users.py:178).
  const found = userIds.length === 0 ? [] : (await cr.query<{ id: number }>(
    `SELECT u.id FROM res_users u JOIN res_partner p ON p.id = u.partner_id
      WHERE u.id = ANY($1::int[]) ORDER BY p.name, u.login, u.id`,
    [userIds],
  )).rows.map((x) => x.id);
  const readable = new Set(await readableUserIds(cr, user, found));
  const allowedUsers: number[] = [];
  for (const id of found) {
    const token = tokenByUserId.get(id) ?? "";
    const ok = (token !== "" && (await verifyLimitedFieldAccessToken(cr, "res.users", id, "im_status", token, "mail.presence")))
      || readable.has(id);
    if (ok) allowedUsers.push(id);
  }
  // `| user`: the current persona (an empty recordset for the public user, res_users.py:716-719).
  if (!user.isPublic && !allowedUsers.includes(user.id)) allowedUsers.push(user.id);
  channels.push(...allowedUsers.map((id): RecordTarget => ({ model: "res.users", id, sub: "presence" })));

  // bus/models/ir_websocket.py:29-35
  channels.push("broadcast");
  channels.push(...user.groupIds.map((id): RecordTarget => ({ model: "res.groups", id })));
  if (sessionUid !== null) {
    channels.push({ model: "res.partner", id: user.partnerId });
    channels.push({ model: "res.users", id: user.id });
  }
  return channels;
}

export interface BusSubscription {
  channels: string[];
  /** Last notification id delivered to or acknowledged by this socket (the catch-up lower bound). */
  last: number;
}

export interface BusStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
}

export interface BusSocketLike {
  readonly readyState: number;
  deserializeAttachment(): unknown;
  send(message: string): void;
}

/**
 * Fan-out committed bus rows to open WebSockets, isolating dead sockets and re-reading each subscription
 * before updating `last` so concurrent `subscribe` channel changes are never overwritten.
 */
export async function dispatchToWebSockets(
  storage: BusStorageLike,
  sockets: Iterable<BusSocketLike>,
  rows: readonly BusRow[],
  openReadyState = 1,
): Promise<void> {
  if (rows.length === 0) return;
  const byChannel = new Map<string, { id: number; message: unknown }[]>();
  for (const row of rows) {
    const list = byChannel.get(row.channel) ?? [];
    list.push({ id: row.id, message: JSON.parse(row.message) as unknown });
    byChannel.set(row.channel, list);
  }
  const subs = await storage.list<BusSubscription>({ prefix: "sub:" });
  for (const ws of sockets) {
    if (ws.readyState !== openReadyState) continue;
    const rawAtt = ws.deserializeAttachment();
    if (typeof rawAtt !== "object" || rawAtt === null || typeof (rawAtt as Record<string, unknown>)["id"] !== "string") continue;
    const key = `sub:${(rawAtt as { id: string }).id}`;
    const sub = subs.get(key);
    if (sub === undefined) continue;
    let maxId = sub.last;
    let failed = false;
    for (const channel of sub.channels) {
      const notifications = (byChannel.get(channel) ?? []).filter((n) => n.id > sub.last).sort((a, b) => a.id - b.id);
      if (notifications.length === 0) continue;
      try {
        ws.send(JSON.stringify(notifications));
      } catch {
        failed = true;
        break;
      }
      maxId = Math.max(maxId, notifications[notifications.length - 1]?.id ?? maxId);
    }
    if (failed) {
      await storage.delete(key);
      continue;
    }
    if (maxId !== sub.last) {
      const latest = await storage.get<BusSubscription>(key);
      if (latest !== undefined) {
        await storage.put<BusSubscription>(key, { channels: latest.channels, last: Math.max(latest.last, maxId) });
      }
    }
  }
}

export interface SubscribeData {
  /** The `json_dump` of each channel tuple, deduplicated in order (`OrderedSet`, ir_websocket.py:78-81). */
  readonly channels: string[];
  readonly last: number;
}

/** ir_websocket.py:45-83 `_prepare_subscribe_data`. */
export async function prepareSubscribeData(
  cr: Cursor,
  db: string,
  user: WsUser,
  sessionUid: number | null,
  channels: unknown,
  last: unknown,
): Promise<SubscribeData> {
  if (!Array.isArray(channels) || !channels.every((c): c is string => typeof c === "string")) {
    throw new Error("bus.Bus only string channels are allowed."); // ValueError, ir_websocket.py:63-65
  }
  const lastId = await busLastId(cr);
  let resolved: number;
  if (typeof last !== "number" || !Number.isInteger(last)) {
    resolved = lastId; // :68-74 (None, bool or non-int)
  } else if (last > lastId) {
    resolved = lastId; // :75-76
  } else {
    resolved = last;
  }
  const list = await buildBusChannelList(cr, user, sessionUid, channels);
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const c of list) {
    const key = jsonDump(channelWithDb(db, c));
    if (!seen.has(key)) {
      seen.add(key);
      ordered.push(key);
    }
  }
  return { channels: ordered, last: resolved };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new InvalidWebsocketRequest("data must be an object");
}

/** ir_websocket.py:85-96 `_subscribe` (mail's override only adds the guest context, mail ir_websocket.py:32-34). */
async function subscribe(cr: Cursor, session: WsSession, user: WsUser, ogData: unknown, ws: WsSender): Promise<void> {
  const data = asRecord(ogData);
  const prepared = await prepareSubscribeData(cr, session.db, user, session.uid, data["channels"], data["last"]);
  const ogLast = data["last"];
  if (data["check_outdated"] === true) {
    // :87-91: does the client's last notification still exist?
    const exists = typeof ogLast === "number"
      ? (await cr.query<{ id: number }>("SELECT id FROM bus_bus WHERE id = $1", [ogLast])).rows.length > 0
      : false;
    if (!exists) ws.sendWorkerInternalMessage("bus/subscription_outdated");
  }
  if (ogLast !== prepared.last) {
    ws.sendWorkerInternalMessage("bus/last_id_reset", prepared.last); // :92-95
  }
  await ws.subscribe(prepared.channels, prepared.last); // :96
}

/**
 * websocket.py:735-769 `serve_websocket_message` + `_serve_ir_websocket`, for one incoming text frame, inside one
 * transaction (`acquire_cursor`, :748). Returns the `bus_bus` rows the handling created (the precommit hook of
 * bus.py:123-137), for the caller to dispatch after its commit.
 */
export async function serveWebsocketMessage(cr: Cursor, session: WsSession, message: string, ws: WsSender): Promise<BusRow[]> {
  let request: Record<string, unknown>;
  try {
    request = asRecord(JSON.parse(message));
  } catch (e) {
    if (e instanceof InvalidWebsocketRequest) throw e;
    throw new InvalidWebsocketRequest(`Invalid JSON data, ${e instanceof Error ? e.message : String(e)}`); // :742-744
  }
  const eventName = request["event_name"];
  if (typeof eventName !== "string") throw new InvalidWebsocketRequest("Key 'event_name' is missing from request"); // :739-741
  const data = request["data"];
  const user = await loadUser(cr, session.uid); // _authenticate, :766
  const bus = new BusValues(session.db);
  if (eventName === "subscribe") {
    await subscribe(cr, session, user, data, ws); // :767-768
  }
  // ir.websocket._serve_ir_websocket: bus does nothing (ir_websocket.py:37-43); mail handles update_presence
  // (mail/models/ir_websocket.py:26-41): `_update_mail_presence(**data)`, skipped for the public user without guest.
  if (eventName === "update_presence") {
    const d = asRecord(data);
    const inactivity = d["inactivity_period"];
    if (typeof inactivity !== "number") throw new InvalidWebsocketRequest("inactivity_period must be a number");
    if (!user.isPublic) await updatePresence(cr, bus, user.id, inactivity);
  }
  return bus.create(cr, user.id);
}

/**
 * websocket.py:536-538 on `_terminate`: `ir.websocket._on_websocket_closed(cookies)`; mail sets the user's presence
 * offline (mail/models/ir_websocket.py:92-100). The guest cookie branch (:97-100) is not ported (no guests).
 */
export async function onWebsocketClosed(cr: Cursor, session: WsSession): Promise<BusRow[]> {
  const user = await loadUser(cr, session.uid);
  const bus = new BusValues(session.db);
  if (!user.isPublic) await setPresenceOffline(cr, bus, user.id);
  return bus.create(cr, user.id);
}
