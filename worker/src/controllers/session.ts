/**
 * `odoo/addons/web/controllers/session.py` (Session controller).
 */
import { Cursor } from "../db";
import { AccessError, NotPorted } from "../errors";
import type { RequestContext } from "../http/context";
import { expiredCookie } from "../http/cookies";
import { dbFilter } from "../http/dispatch";
import { jsonRoute, route } from "../http/router";
import { authenticateSession, computeSessionToken, experimentRounds, logoutSession, touchSession } from "../session/auth";
import { sessionInfo, type SessionInfoRequest } from "../session/info";

function infoRequest(ctx: RequestContext, uid: number): SessionInfoRequest {
  return { cr: ctx.cursor(), session: ctx.sessionState, uid, cookies: ctx.requestCookies, bestLang: ctx.bestLang() };
}

/** `ir.http._post_logout` (web/models/ir_http.py:67-70): expire the `cids` cookie. */
function postLogout(ctx: RequestContext): void {
  ctx.cookies.push(expiredCookie("cids", new Date()));
}

// session.py:30-34
jsonRoute("/web/session/get_session_info", async (ctx) => {
  touchSession(ctx.sessionState);
  const uid = ctx.uid;
  if (uid === null) throw new AccessError("no user");
  return sessionInfo(infoRequest(ctx, uid));
}, { auth: "user", readonly: true });

// session.py:36-61
jsonRoute("/web/session/authenticate", async (ctx) => {
  const p = ctx.jsonParams ?? {};
  const db = p["db"];
  const login = p["login"];
  const password = p["password"];
  if (typeof db !== "string" || dbFilter([db]).length !== 1) throw new AccessError("Database not found.");
  if (typeof login !== "string" || typeof password !== "string") throw new AccessError("Database not found.");
  // session.py:42-49: a request without a database, or on another one, authenticates through a cursor of its own
  // on `db` (`Registry(db).cursor()` in an ExitStack: committed when the block ends, rolled back on an error).
  const own = ctx.db !== db ? new Cursor(ctx.env, db) : null;
  const cr = own ?? ctx.cursor();
  try {
    const sess = ctx.sessionState;
    const authInfo = await authenticateSession(cr, sess, { login, password, type: "password" }, {
      derivePassword: (bytes, salt) => ctx.store.derivePassword(sess.sid, bytes, salt),
      experimentRounds: experimentRounds(ctx.env.EXPERIMENT_PASSWORD_ROUNDS),
      remoteAddr: ctx.remoteAddr, userAgent: ctx.userAgent, baseLocation: ctx.baseLocation,
      tzCookie: ctx.requestCookies.get("tz") ?? null, bestLang: ctx.bestLang(),
      loginFailures: ctx.store.loginFailures(db, ctx.remoteAddr),
      // session.py:43-47: a cursor of its own has an environment without context; `request.env` exists only with a db
      lang: own !== null && ctx.db === null ? null : typeof sess.context["lang"] === "string" ? sess.context["lang"] : null,
    });
    if (authInfo.uid !== sess.uid) { // MFA pending (session.py:53-56)
      await own?.commit();
      return { uid: null };
    }
    sess.db = db;
    // save_session(request, env) (session.py:59): with the request's own database the dispatcher's post_dispatch
    // does it with the same effect; on another database the session token must come from that database's cursor.
    if (own !== null && sess.shouldRotate) {
      const uid = authInfo.uid;
      await ctx.store.rotate(sess, (sid) => computeSessionToken(own, uid, sid), false, Date.now() / 1000);
    }
    const info = await sessionInfo({ cr, session: sess, uid: authInfo.uid, cookies: ctx.requestCookies, bestLang: ctx.bestLang() });
    await own?.commit();
    return info;
  } catch (e) {
    await own?.rollback();
    throw e;
  } finally {
    await own?.close();
  }
}, { auth: "none" });

// session.py:63-66: `list(request.env.registry._init_modules)`, a set; sorted here for a stable answer
jsonRoute("/web/session/modules", async (ctx) => {
  const r = await ctx.cursor().query<{ name: string }>("SELECT name FROM ir_module_module WHERE state = 'installed' ORDER BY name");
  return r.rows.map((x) => x.name);
}, { auth: "user", readonly: true });

// session.py:68-70: ir.http._authenticate did the job
jsonRoute("/web/session/check", async () => null, { auth: "user", readonly: true });

// session.py:72-81
jsonRoute("/web/session/account", async () => {
  throw new NotPorted("/web/session/account (accounts.odoo.com oauth url)");
}, { auth: "user", readonly: true });

// session.py:83-85
jsonRoute("/web/session/destroy", async (ctx) => {
  logoutSession(ctx.sessionState, false, ctx.defaultLang(), Date.now() / 1000);
  postLogout(ctx);
  return null;
}, { auth: "user", readonly: true });

// session.py:87-90
route("/web/session/logout", async (ctx) => {
  logoutSession(ctx.sessionState, true, ctx.defaultLang(), Date.now() / 1000);
  postLogout(ctx);
  const redirect = ctx.params["redirect"];
  return ctx.redirect(typeof redirect === "string" && redirect !== "" ? redirect : "/odoo", 303);
}, { auth: "none", methods: ["POST"], readonly: true });

// session.py:92-110: identity confirmation (CheckIdentityException flow)
route("/web/session/identity", async () => {
  throw new NotPorted("/web/session/identity (web.check_identity page)");
}, { auth: "user", methods: ["GET"], checkIdentity: false });
jsonRoute("/web/session/identity/check", async () => {
  throw new NotPorted("/web/session/identity/check (ir.http._check_identity)");
}, { auth: "user", checkIdentity: false });
route("/web/session/fingerprint/check", async () => {
  throw new NotPorted("/web/session/fingerprint/check (update_device_fingerprint)");
}, { auth: "user", methods: ["POST"], checkIdentity: false, csrf: false });
