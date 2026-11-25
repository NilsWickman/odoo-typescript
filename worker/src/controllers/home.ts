/**
 * `odoo/addons/web/controllers/home.py` (Home controller) with the auth_signup override of `web_login`
 * (`odoo/addons/auth_signup/controllers/main.py:26-38, 135-142`).
 *
 * Template values passed to `renderTemplate(cr, template, values)` (stream Q, src/qweb/render):
 * - every key Odoo puts in the qcontext (`values` of web_login, `webclient_rendering_context()` for the client);
 * - the request-derived names the templates evaluate (`odoo/addons/web/views/webclient_templates.xml`):
 *   `csrf_token` (`request.csrf_token()`), `debug` (`request.session.debug`), `db` (`request.db`),
 *   `query` (the query-string dict `keep_query()` reads), `frontend_session_info`
 *   (`env['ir.http'].get_frontend_session_info()` of web.frontend_layout), `uid` (`request.env.uid`).
 */
import { AccessDenied, AccessError, NotPorted } from "../errors";
import type { RequestContext } from "../http/context";
import { ensureDb } from "../http/dispatch";
import { ogTitleFromPath } from "./og_title";
import { route, jsonRoute } from "../http/router";
import { authenticateSession, computeSessionToken, experimentRounds, touchSession, checkSession, type Credential } from "../session/auth";
import { browserCacheSecret, frontendSessionInfo, publicUserId, sessionInfo, type SessionInfoRequest } from "../session/info";
import { fetchUser, icpBool, icpStr, userFlags, SUPERUSER_ID } from "../session/user";
import { renderPage } from "./page";
import { initOdoobot } from "../models/odoobot";

// home.py:30-34
const SIGN_UP_REQUEST_PARAMS = new Set(["db", "login", "debug", "token", "message", "error", "scope", "mode",
  "redirect", "redirect_hostname", "email", "name", "partner_id", "password", "confirm_password", "city",
  "country_id", "lang", "signup_email"]);
const CREDENTIAL_PARAMS = ["login", "password", "type"];

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** `request.params` as a string dict for `redirect_query` (home.py:42-43). */
function stringParams(ctx: RequestContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.params)) if (typeof v === "string") out[k] = v;
  return out;
}

/** utils.py:267-268 `is_user_internal`. */
async function isUserInternal(ctx: RequestContext, uid: number): Promise<boolean> {
  return (await userFlags(ctx.cursor(), uid)).isInternal;
}

function infoRequest(ctx: RequestContext, uid: number): SessionInfoRequest {
  return { cr: ctx.cursor(), session: ctx.sessionState, uid, cookies: ctx.requestCookies, bestLang: ctx.bestLang() };
}

/** The request-derived names every page template needs (see the module comment). */
async function templateRequestValues(ctx: RequestContext): Promise<Record<string, unknown>> {
  const query: Record<string, string> = {};
  for (const [k, v] of ctx.url.searchParams) if (!(k in query)) query[k] = v;
  return { csrf_token: await ctx.csrfToken(), debug: ctx.sessionState.debug, db: ctx.db, query, uid: ctx.uid };
}

function htmlResponse(html: string, headers: Record<string, string> = {}): Response {
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ...headers } });
}

// home.py:39-43
route("/", async (ctx) => {
  const uid = ctx.sessionState.uid;
  if (ctx.db !== null && uid !== null && !(await isUserInternal(ctx, uid))) {
    return ctx.redirectQuery("/web/login_successful", stringParams(ctx));
  }
  return ctx.redirectQuery("/odoo", stringParams(ctx));
}, { auth: "none" });

/**
 * `urllib.parse.urljoin(url_root, ref)` for a reference with an absolute path (Python 3.12 urljoin/urlunparse): dot
 * segments resolved, `;params`, `?query` and `#fragment` kept only when non-empty
 * (so "/odoo?" joins to ".../odoo").
 */
export function urljoinRoot(origin: string, ref: string): string {
  let rest = ref;
  let fragment = "";
  const hash = rest.indexOf("#");
  if (hash >= 0) { fragment = rest.slice(hash + 1); rest = rest.slice(0, hash); }
  let query = "";
  const q = rest.indexOf("?");
  if (q >= 0) { query = rest.slice(q + 1); rest = rest.slice(0, q); }
  // urlparse._splitparams: `;` after the last `/`
  let params = "";
  const semi = rest.indexOf(";", rest.lastIndexOf("/"));
  if (semi >= 0) { params = rest.slice(semi + 1); rest = rest.slice(0, semi); }
  // an absolute path ignores the base path; empty segments are kept (only relative references filter them)
  const segs = rest.split("/");
  const resolved: string[] = [];
  for (const seg of segs) {
    if (seg === "..") resolved.pop();
    else if (seg !== ".") resolved.push(seg);
  }
  const last = segs[segs.length - 1];
  if (last === "." || last === "..") resolved.push("");
  let path = resolved.join("/") || "/";
  if (params) path += `;${params}`;
  return `${origin}${path}${query ? `?${query}` : ""}${fragment ? `#${fragment}` : ""}`;
}

/** home.py:49-85 `web_client`. */
async function webClient(ctx: RequestContext): Promise<Response> {
  await ensureDb(ctx);
  const sess = ctx.sessionState;
  if (sess.uid === null) {
    // werkzeug full_path always carries the "?" (requestlib HTTPRequest.full_path)
    return ctx.redirectQuery("/web/login", { redirect: `${ctx.url.pathname}?${ctx.url.search.slice(1)}` }, 303);
  }
  const redirect = str(ctx.params["redirect"]);
  if (redirect !== null && redirect !== "") return ctx.redirect(redirect, 303);
  const client = { remoteAddr: ctx.remoteAddr, userAgent: ctx.userAgent };
  await checkSession(ctx.cursor(), ctx.store, sess, client, ctx.defaultLang(), Date.now() / 1000);
  if (!(await isUserInternal(ctx, sess.uid))) return ctx.redirect("/web/login_successful", 303);
  touchSession(sess); // home.py:62-63: refresh the session lifetime
  ctx.uid = sess.uid; // home.py:65-66 update_env(user=session.uid)
  try {
    const user = await fetchUser(ctx.cursor(), sess.uid);
    if (user === null) throw new AccessError("user missing");
    // mail_bot/models/res_users.py:60-63 _on_webclient_bootstrap: initialise OdooBot's chat for a fresh internal user
    if ((await isUserInternal(ctx, sess.uid)) && (user.odoobot_state === null || user.odoobot_state === "not_initialized")) {
      await initOdoobot(await ctx.orm());
    }
    // web/models/ir_http.py:72-79 webclient_rendering_context
    const info = await sessionInfo(infoRequest(ctx, sess.uid));
    info["browser_cache_secret"] = await browserCacheSecret(ctx.cursor(), sess.uid); // home.py:73-78
    const values = { color_scheme: "light", session_info: info, ...(await templateRequestValues(ctx)) };
    const html = await renderPage(ctx, "web.webclient_bootstrap", values);
    return htmlResponse(html, { "X-Frame-Options": "DENY", "Cache-Control": "no-store" });
  } catch (e) {
    if (e instanceof AccessError) return ctx.redirect("/web/login?error=access"); // home.py:84-85
    throw e;
  }
}

route(["/web", "/odoo", "/odoo/<path:subpath>", "/scoped_app/<path:subpath>"], webClient, { auth: "none" });

/** utils.py:248-264 `_get_login_redirect_url`. */
async function loginRedirectUrl(ctx: RequestContext, uid: number, redirect: string | null): Promise<string> {
  if (ctx.sessionState.uid !== null) {
    if (redirect !== null && redirect !== "") return redirect;
    return (await isUserInternal(ctx, ctx.sessionState.uid)) ? "/odoo" : "/web/login_successful";
  }
  // partial session (MFA): the user's `_mfa_url()` (auth_totp -> /web/login/totp), carrying the redirect
  void uid;
  const url = "/web/login/totp";
  if (redirect === null || redirect === "") return url;
  return `${url}?redirect=${encodeURIComponent(redirect).replace(/%20/g, "+")}`;
}

/** home.py:110-173 `web_login`, wrapped by auth_signup/controllers/main.py:26-38. */
async function webLogin(ctx: RequestContext): Promise<Response> {
  await ensureDb(ctx);
  const sess = ctx.sessionState;
  ctx.params["login_success"] = false;
  const redirect = str(ctx.params["redirect"]);
  const method = ctx.request.method;
  if (method === "GET" && redirect !== null && redirect !== "" && sess.uid !== null) return ctx.redirect(redirect);

  // home.py:117-125: hybrid auth=user/auth=public
  if (ctx.uid === null) ctx.uid = sess.uid ?? await publicUserId(ctx.cursor());

  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx.params)) if (SIGN_UP_REQUEST_PARAMS.has(k)) values[k] = v;
  // db_list(): the oracle exposes a single database to the page (the reference login page has no database field)
  values["databases"] = ctx.db === null ? [] : [ctx.db];

  if (method === "POST") {
    try {
      const credential: Record<string, string> = {};
      for (const key of CREDENTIAL_PARAMS) {
        const v = ctx.params[key];
        if (typeof v === "string" && v !== "") credential[key] = v;
      }
      credential["type"] ??= "password";
      if (credential["login"] === undefined) throw new AccessDenied();
      // web/models/res_users.py:33-36 _should_captcha_login -> ir.http._verify_request_recaptcha_token: no-op
      // without google_recaptcha (base ir_http.py:584-586)
      const cred: Credential = { login: credential["login"], password: credential["password"] ?? "", type: credential["type"] };
      const authInfo = await authenticateSession(ctx.cursor(), sess, cred, {
        derivePassword: (password, salt) => ctx.store.derivePassword(sess.sid, password, salt),
        experimentRounds: experimentRounds(ctx.env.EXPERIMENT_PASSWORD_ROUNDS),
        remoteAddr: ctx.remoteAddr, userAgent: ctx.userAgent, baseLocation: ctx.baseLocation,
        tzCookie: ctx.requestCookies.get("tz") ?? null, bestLang: ctx.bestLang(),
        loginFailures: ctx.db === null ? null : ctx.store.loginFailures(ctx.db, ctx.remoteAddr),
        lang: typeof sess.context["lang"] === "string" ? sess.context["lang"] : null,
      });
      ctx.params["login_success"] = true;
      return ctx.redirect(await loginRedirectUrl(ctx, authInfo.uid, redirect)); // 303
    } catch (e) {
      if (!(e instanceof AccessDenied)) throw e;
      // home.py:142-146: the bare AccessDenied() reads "Wrong login/password"
      values["error"] = e.message === "Access Denied" ? "Wrong login/password" : e.message;
    }
  } else if (ctx.params["error"] === "access") {
    values["error"] = "Only employees can access this database. Please contact the administrator.";
  }
  if (!("login" in values)) {
    const authLogin = ctx.session["auth_login"];
    if (typeof authLogin === "string" && authLogin !== "") values["login"] = authLogin;
  }
  // home.py:154-155: the oracle runs with list_db = False (its login page shows no "Manage Databases" link)
  values["disable_database_manager"] = true;
  const safeRedirect = redirect !== null && redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : null;
  values["disable_opengraph"] = safeRedirect !== null && safeRedirect.startsWith("/odoo");
  if (values["disable_opengraph"] === true && safeRedirect !== null) {
    // home.py web_login: request.httprequest.url_root, the forwarded host behind proxy_mode (ProxyFix), as baseLocation
    const origin = ctx.baseLocation;
    values["og_url"] = urljoinRoot(origin, safeRedirect);
    // utils.py:20-37 og_title_from_path: "Odoo" for /odoo itself, else the last action's name
    const odooPath = safeRedirect.split("?")[0]?.replace(/^\/odoo/, "") ?? "";
    values["og_title"] = odooPath === "" || odooPath === "/" ? "Odoo"
      : await ogTitleFromPath(ctx.cursor(), safeRedirect, typeof ctx.context.lang === "string" ? ctx.context.lang : "en_US");
    values["og_image_url"] = `${origin}/web/static/img/og_image.png`;
    values["og_domain"] = new URL(origin).hostname;
  }
  // auth_signup/controllers/main.py:135-142 get_auth_signup_config
  values["signup_enabled"] = (await icpStr(ctx.cursor(), "auth_signup.invitation_scope")) === "b2c";
  values["reset_password_enabled"] = await icpBool(ctx.cursor(), "auth_signup.reset_password");
  // auth_signup main.py:31-37: already logged in with a redirect -> redirect
  if (sess.uid !== null && method === "GET" && redirect !== null && redirect !== "") return ctx.redirect(redirect);

  const uidForInfo = ctx.uid ?? await publicUserId(ctx.cursor());
  const frontend = await frontendSessionInfo(infoRequest(ctx, uidForInfo));
  const html = await renderPage(ctx, "web.login", {
    ...values, ...(await templateRequestValues(ctx)), frontend_session_info: frontend,
  });
  return htmlResponse(html, {
    "Cache-Control": "no-cache", "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": "frame-ancestors 'self'",
  });
}

route("/web/login", webLogin, { auth: "none" });

// home.py:175-179
route("/web/login_successful", async (ctx) => {
  const html = await renderPage(ctx, "web.login_successful", await templateRequestValues(ctx));
  return htmlResponse(html);
}, { auth: "user" });

// home.py:181-190 `switch_to_admin`
route("/web/become", async (ctx) => {
  const sess = ctx.sessionState;
  let uid = ctx.uid ?? SUPERUSER_ID;
  if ((await userFlags(ctx.cursor(), uid)).isSystem) {
    uid = SUPERUSER_ID;
    sess.uid = uid;
    const token = await computeSessionToken(ctx.cursor(), uid, sess.sid); // update_session_token
    sess.sessionToken = token === false ? null : token;
  }
  return ctx.redirect(await loginRedirectUrl(ctx, uid, null));
}, { auth: "user", readonly: true });

// home.py:200-215
route("/web/health", async () => new Response(JSON.stringify({ status: "pass" }), {
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
}), { auth: "none", saveSession: false });

// home.py:217-231
route("/robots.txt", async () => new Response("User-agent: *\nDisallow: /", { headers: { "Content-Type": "text/plain" } }), { auth: "none" });

// home.py:192-198: the cloc report is a developer tool
jsonRoute("/web/cloc", async () => {
  throw new NotPorted("/web/cloc (odoo.tools.cloc)");
});
