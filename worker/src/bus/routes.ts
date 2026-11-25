/**
 * The bus controllers: `odoo/addons/bus/controllers/websocket.py` (WebsocketController), the mail override
 * `odoo/addons/mail/controllers/websocket.py` (update_bus_presence) and `odoo/addons/bus/controllers/main.py`.
 * Registered with the shared route table (src/http/router.ts); the HTTP stream's dispatcher runs them.
 */
import { HttpError, NotPorted, SessionExpired } from "../errors";
import type { RequestContext } from "../http/context";
import { jsonRoute, route } from "../http/router";
import { SESSION_HEADER, type UpgradeInfo } from "../do/bus";
import { BusValues, dispatchRows, poll } from "./bus";
import { readFile } from "../filestore";
import { setPresenceOffline, updatePresence } from "./presence";
import { loadUser, prepareSubscribeData } from "./protocol";

/** websocket.py:802-810: the handshake headers Odoo requires (`_REQUIRED_HANDSHAKE_HEADERS`). */
const REQUIRED_HANDSHAKE_HEADERS = ["connection", "host", "sec-websocket-key", "sec-websocket-version", "upgrade", "origin"];
const SUPPORTED_VERSIONS = ["13"]; // websocket.py:803

/**
 * websocket.py:914-945 `_assert_handshake_validity`. The runtime completes the RFC 6455 handshake itself
 * (Sec-WebSocket-Accept); the request headers still reach the Worker and are validated as Odoo does.
 */
function assertHandshakeValidity(headers: Headers): void {
  const missing = REQUIRED_HANDSHAKE_HEADERS.filter((h) => !headers.has(h));
  if (missing.length > 0) throw new HttpError(400, `Empty or missing header(s): ${missing.join(", ")}`);
  if ((headers.get("upgrade") ?? "").toLowerCase() !== "websocket") throw new HttpError(400, "Invalid upgrade header");
  if (!(headers.get("connection") ?? "").toLowerCase().includes("upgrade")) throw new HttpError(400, "Invalid connection header");
  if (!SUPPORTED_VERSIONS.includes(headers.get("sec-websocket-version") ?? "")) {
    // websocket.py:70-82 UpgradeRequired
    throw new HttpError(426, "Wrong websocket version was given during the handshake", { "Sec-WebSocket-Version": SUPPORTED_VERSIONS.join("; ") });
  }
  const key = headers.get("sec-websocket-key") ?? "";
  let decoded: Buffer;
  try {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(key)) throw new Error("not base64");
    decoded = Buffer.from(key, "base64");
  } catch {
    throw new HttpError(400, "Sec-WebSocket-Key should be b64 encoded");
  }
  if (decoded.length !== 16) throw new HttpError(400, "Sec-WebSocket-Key should be of length 16 once decoded");
}

/** controllers/websocket.py:12-21 + websocket.py:826-859 `open_connection`: upgrade, then serve in the DO. */
async function websocket(ctx: RequestContext): Promise<Response> {
  assertHandshakeValidity(ctx.request.headers);
  const db = ctx.db;
  if (db === null) {
    // Odoo would upgrade and fail on the first message (InvalidDatabaseException, websocket.py:752-757).
    throw new HttpError(400, "no database");
  }
  const info: UpgradeInfo = {
    db,
    sid: ctx.session.sid,
    uid: ctx.session.uid,
    version: ctx.url.searchParams.get("version"),
    hasUserAgent: (ctx.request.headers.get("user-agent") ?? "") !== "",
  };
  const headers = new Headers(ctx.request.headers);
  headers.set(SESSION_HEADER, JSON.stringify(info));
  const stub = ctx.env.BUS.get(ctx.env.BUS.idFromName(db));
  return stub.fetch(ctx.request.url, { method: "GET", headers });
}
route("/websocket", websocket, { auth: "public", methods: ["GET"] });

/** controllers/websocket.py:23-30. */
// `json.dumps` default separators: a space after the colon.
route("/websocket/health", async () => new Response('{"status": "pass"}', {
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
}), { auth: "none", saveSession: false, methods: ["GET"] });

/**
 * controllers/websocket.py:32-44 `peek_notifications` (the worker's HTTP fallback; mail's override only adds the
 * guest context, mail/controllers/websocket.py:113-116).
 */
jsonRoute("/websocket/peek_notifications", async (ctx) => {
  const p = ctx.jsonParams ?? {};
  if (p["is_first_poll"] === true) {
    ctx.session["is_websocket_session"] = true;
    ctx.sessionDirty = true;
  } else if (!("is_websocket_session" in ctx.session)) {
    throw new SessionExpired();
  }
  const db = ctx.db;
  if (db === null) throw new HttpError(400, "no database");
  const cr = ctx.cursor();
  const user = await loadUser(cr, ctx.session.uid);
  const data = await prepareSubscribeData(cr, db, user, ctx.session.uid, p["channels"], p["last"]);
  const notifications = await poll(cr, data.channels, data.last);
  return { channels: data.channels.map((c) => JSON.parse(c) as unknown), notifications };
}, { auth: "public" });

/**
 * controllers/websocket.py:46-50 `on_websocket_closed` and mail/controllers/websocket.py:118-124
 * `update_bus_presence`: the bus rows are handed to the dispatcher before the dispatcher's commit (the request
 * contract has no post-commit hook yet); a rollback after that would have notified rows that do not exist.
 */
async function presenceRoute(ctx: RequestContext, action: (uid: number, bus: BusValues) => Promise<void>): Promise<void> {
  const db = ctx.db;
  if (db === null) throw new HttpError(400, "no database");
  const cr = ctx.cursor();
  const user = await loadUser(cr, ctx.session.uid);
  const bus = new BusValues(db);
  if (!user.isPublic) await action(user.id, bus);
  const rows = await bus.create(cr, user.id);
  if (rows.length > 0) ctx.afterCommit(() => dispatchRows(ctx.env, db, rows));
}

jsonRoute("/websocket/on_closed", async (ctx) => {
  await presenceRoute(ctx, (uid, bus) => setPresenceOffline(ctx.cursor(), bus, uid));
  return null;
}, { auth: "public" });

jsonRoute("/websocket/update_bus_presence", async (ctx) => {
  if (!("is_websocket_session" in ctx.session)) throw new SessionExpired();
  const raw = (ctx.jsonParams ?? {})["inactivity_period"];
  const inactivity = typeof raw === "number" ? Math.trunc(raw) : typeof raw === "string" ? parseInt(raw, 10) : NaN;
  if (Number.isNaN(inactivity)) throw new HttpError(400, "inactivity_period must be an int");
  await presenceRoute(ctx, (uid, bus) => updatePresence(ctx.cursor(), bus, uid, inactivity));
  return {};
}, { auth: "public" });

/** controllers/main.py:9-14: `ir.model._get_model_definitions` belongs to the ORM; not needed by S1. */
route("/bus/get_model_definitions", async () => {
  throw new NotPorted("/bus/get_model_definitions (ir.model._get_model_definitions)");
}, { auth: "user", methods: ["POST"] });

const BUNDLE_NAME = "bus.websocket_worker_assets"; // controllers/websocket.py:58

interface BundleAttachment {
  id: number;
  name: string;
  store_fname: string | null;
  checksum: string;
  mimetype: string;
  file_size: number;
}

/** werkzeug `parse_etags` + `ETags.contains_raw`: weak comparison, `*` matches anything. */
function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (ifNoneMatch === null) return false;
  for (const part of ifNoneMatch.split(",")) {
    let tag = part.trim();
    if (tag === "*") return true;
    if (tag.startsWith("W/")) tag = tag.slice(2);
    if (tag.startsWith('"') && tag.endsWith('"')) tag = tag.slice(1, -1);
    if (tag === etag) return true;
  }
  return false;
}

/**
 * controllers/websocket.py:52-61 `get_websocket_worker_bundle`: `ir.qweb._get_asset_bundle(...).js()` is the
 * `ir_attachment` of the compiled bundle (assetsbundle.py:351-354, 230-261: the newest public attachment of
 * create_uid 1 named `<bundle>.min.js` under /web/assets/<version>/). Served by `ir.binary._get_stream_from` as
 * `Stream.get_response(content_security_policy=None)` (ir_attachment.py:1116-1137, http/stream.py:142-221,
 * odoo/tools/_vendor/send_file.py): etag = checksum, Content-Disposition inline, Cache-Control no-cache,
 * X-Content-Type-Options nosniff, conditional 304 with the entity headers removed (werkzeug Response:502-503).
 */
async function websocketWorkerBundle(ctx: RequestContext): Promise<Response> {
  if (ctx.session.debug.split(",").includes("assets")) {
    throw new NotPorted("debug=assets: the non-minified websocket worker bundle"); // :59 debug_assets
  }
  const db = ctx.db;
  if (db === null) throw new HttpError(400, "no database");
  const cr = ctx.cursor();
  const r = await cr.query<BundleAttachment>(
    `SELECT id, name, store_fname, checksum, mimetype, file_size FROM ir_attachment
      WHERE create_uid = 1 AND url LIKE $1 AND res_model = 'ir.ui.view' AND res_id = 0 AND public = true
      ORDER BY id DESC LIMIT 1`,
    [`/web/assets/%/${BUNDLE_NAME}.min.js`],
  );
  const att = r.rows[0];
  if (att === undefined) throw new NotPorted(`compiling the ${BUNDLE_NAME} bundle (no ir_attachment in the database)`);
  if (att.store_fname === null) throw new NotPorted("bundle attachment stored in db_datas");
  const headers = new Headers({
    // dispatcher.py:179-185: cors='*' on an http route with no explicit methods.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST",
    "Content-Disposition": `inline; filename=${att.name}`, // send_file.py:148-160 (ASCII name, no quoting needed)
    "Cache-Control": "no-cache", // send_file.py:192 (max_age None), public attachment keeps it bare (stream.py:216-221)
    "ETag": `"${att.checksum}"`, // send_file.py:207-208 set_etag(checksum)
    "Accept-Ranges": "bytes", // make_conditional(accept_ranges=True)
    "X-Content-Type-Options": "nosniff", // stream.py:211
  });
  if (etagMatches(ctx.request.headers.get("if-none-match"), att.checksum)) {
    return new Response(null, { status: 304, headers });
  }
  const bytes = await readFile(ctx.env, db, att.store_fname);
  if (bytes === null) throw new HttpError(404, `filestore object ${att.store_fname} missing`);
  // werkzeug adds the charset to application/javascript (`_charset_mimetypes`).
  headers.set("Content-Type", `${att.mimetype}; charset=utf-8`);
  headers.set("Content-Length", String(bytes.byteLength));
  return new Response(bytes, { status: 200, headers });
}
route("/bus/websocket_worker_bundle", websocketWorkerBundle, { auth: "public", methods: ["GET"] });
