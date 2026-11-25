/**
 * Request router for `DEMO_MODE=1` (`odoo-ts-demo` Worker):
 *  - `odoo-ts-demo.example.com`: launcher, load balancer entry, FIFO queue page, live status API
 *  - `odoo-ts-runbot.example.com`: shared Runbot (10-minute A/B rotation, no queue)
 *  - `odoo-ts-1..N.example.com`: dedicated private slots (1-minute inactivity reset, lease-cookie protected)
 *
 * Hardening (docs/accept/briefs/demo-a1-hardening.md): `POST`-only entry with optional Turnstile, a single-use URL
 * claim nonce exchanged for a `__Host-` lease cookie, per-IP caps, a 5 MiB request body cap, the maintenance kill
 * switch (503) and the authenticated `/__demo/admin/*` endpoints. Everything here runs only with `DEMO_MODE=1`.
 */
import type { Env } from "../env";
import { parseCookies } from "../http/cookies";
import { handleRequest } from "../http/dispatch";
import { demoConfigFromEnv } from "../do/demo_pool";
import { BYPASS_HEADER, enforceDemoBodyCap, hasAdminToken, hasMaintenanceBypass } from "./guards";
import { ipPrefixKey, isUserActivityRequest, parseDemoHost, type DemoConfig } from "./pool_logic";
import { buildDemoBadgeSnippet, renderLauncherPage, renderNoticePage, renderQueuePage } from "./pages";
import { turnstileEnabled, verifyTurnstile } from "./turnstile";

/** The lease cookie: `__Host-` pins it to the exact slot host, Secure, Path=/ and no Domain. */
export const LEASE_COOKIE = "__Host-odoo_demo_lease";
/** The pre-hardening cookie name: never read, only expired on claim and reset. */
const LEGACY_LEASE_COOKIE = "odoo_demo_lease";
const POOL_DO_NAME = "global";
const MAINTENANCE_CACHE_MS = 5_000;

function leaseCookie(value: string, maxAge: number): string {
  return `${LEASE_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

const EXPIRE_LEGACY_LEASE = `${LEGACY_LEASE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function poolStub(env: Env): DurableObjectStub<import("../do/demo_pool").DemoPool> {
  if (!env.DEMO_POOL) throw new Error("DEMO_POOL binding missing");
  return env.DEMO_POOL.get(env.DEMO_POOL.idFromName(POOL_DO_NAME));
}

function htmlResponse(html: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function wantsHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/html");
}

/** A friendly notice as HTML for a browser, JSON for anything else. */
function noticeResponse(
  request: Request,
  status: number,
  code: string,
  title: string,
  message: string,
  launcherHost: string,
  extraHeaders: Record<string, string> = {},
): Response {
  if (wantsHtml(request)) return htmlResponse(renderNoticePage(title, message, launcherHost), status, extraHeaders);
  return jsonResponse({ error: code, message }, status, extraHeaders);
}

function redirect(location: string, status = 303, extraHeaders: Record<string, string> = {}): Response {
  const h = new Headers({ Location: location, "Cache-Control": "no-store", ...extraHeaders });
  return new Response(null, { status, headers: h });
}

function isHtmlNavigation(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  return request.method === "GET" && accept.includes("text/html");
}

/**
 * Inject the small floating demo badge ONLY into `/web/login` and `/odoo` HTML responses
 * (never JSON-RPC, assets, downloads, or PDFs).
 */
async function maybeInjectBadge(
  pathname: string,
  response: Response,
  snippet: string,
): Promise<Response> {
  if (pathname !== "/web/login" && pathname !== "/odoo") return response;
  const ct = response.headers.get("content-type") ?? "";
  if (response.status !== 200 || !ct.toLowerCase().includes("text/html")) return response;
  const html = await response.text();
  const idx = html.lastIndexOf("</body>");
  const patched = idx >= 0 ? html.slice(0, idx) + snippet + html.slice(idx) : html + snippet;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(patched, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Create a request-scoped Env locked strictly to one demo database and safe public defaults, carrying the lease the
 * request's PDFs are charged to (src/demo/quota.ts).
 */
function scopedDemoEnv(env: Env, db: string, lease: { readonly slot: string; readonly secret?: string }): Env {
  const safeDb = db.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const overrides: Record<string, string> = {
    DB_FILTER: `^${safeDb}$`,
    PROXY_MODE: "0",
    APPS_INSTALLABLE_DBS: env.APPS_INSTALLABLE_DBS ?? "^demo_",
    DEMO_LEASE_SLOT: lease.slot,
    DEMO_LEASE_SECRET: lease.secret ?? "",
  };
  return new Proxy(env, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop in overrides) return overrides[prop];
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      return (typeof prop === "string" && prop in overrides) || Reflect.has(target, prop);
    },
  });
}

/**
 * Forward request to Odoo dispatcher with `x-odoo-database` (callers cannot override the slot DB) and the maintenance
 * bypass header stripped.
 */
function sanitizeRequestForOdoo(request: Request): Request {
  if (!request.headers.has("x-odoo-database") && !request.headers.has(BYPASS_HEADER)) return request;
  const headers = new Headers(request.headers);
  headers.delete("x-odoo-database");
  headers.delete(BYPASS_HEADER);
  return new Request(request, { headers });
}

/** The redirect to a slot's claim URL: the nonce is in the Location, so no Referer may carry it anywhere. */
function claimRedirect(host: string, claimToken: string): Response {
  return redirect(`https://${host}/__demo/claim?t=${encodeURIComponent(claimToken)}`, 303, { "Referrer-Policy": "no-referrer" });
}

function maintenanceResponse(request: Request, cfg: DemoConfig): Response {
  return noticeResponse(
    request,
    503,
    "demo_maintenance",
    "Down for maintenance",
    "The public demo is being updated. Please try again in a minute.",
    cfg.launcherHost,
    { "Retry-After": "60" },
  );
}


let maintenanceCache: { value: boolean; at: number } | null = null;

/** The kill switch, cached for 5 s in the isolate (an admin call through this isolate updates it at once). */
async function inMaintenance(env: Env): Promise<boolean> {
  const now = Date.now();
  if (maintenanceCache !== null && now - maintenanceCache.at < MAINTENANCE_CACHE_MS) return maintenanceCache.value;
  try {
    const value = await poolStub(env).maintenanceState();
    maintenanceCache = { value, at: now };
    return value;
  } catch (e) {
    console.warn("demo maintenance state unavailable:", e);
    return maintenanceCache?.value ?? false;
  }
}


/** `POST /__demo/admin/{maintenance,drain,reset-pool-state}` on the launcher host, Bearer `DEMO_ADMIN_TOKEN`. */
async function handleAdmin(request: Request, url: URL, env: Env): Promise<Response> {
  if (!env.DEMO_ADMIN_TOKEN) return jsonResponse({ error: "not_found" }, 404);
  if (!hasAdminToken(request, env)) return jsonResponse({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
  if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405, { Allow: "POST" });
  const pool = poolStub(env);
  switch (url.pathname) {
    case "/__demo/admin/maintenance": {
      let enabled: unknown;
      try {
        enabled = ((await request.json()) as { enabled?: unknown } | null)?.enabled;
      } catch {
        enabled = undefined;
      }
      if (typeof enabled !== "boolean") return jsonResponse({ error: "expected {\"enabled\": boolean}" }, 400);
      const res = await pool.setMaintenanceMode(enabled);
      maintenanceCache = { value: res.maintenance, at: Date.now() };
      return jsonResponse({ ok: true, maintenance: res.maintenance });
    }
    case "/__demo/admin/drain": {
      const res = await pool.drain();
      maintenanceCache = { value: true, at: Date.now() };
      return jsonResponse(res);
    }
    case "/__demo/admin/reset-pool-state": {
      const res = await pool.resetState();
      if (!res.ok) return jsonResponse({ ok: false, error: "maintenance_required" }, 409);
      return jsonResponse(res);
    }
    default:
      return jsonResponse({ error: "not_found" }, 404);
  }
}

async function handleLauncher(request: Request, url: URL, env: Env, cfg: DemoConfig): Promise<Response> {
  const pool = poolStub(env);

  if (url.pathname === "/__demo/status" && request.method === "GET") {
    return jsonResponse(await pool.status());
  }

  if (url.pathname === "/__demo/enter") {
    // POST only: a GET (link preview, prefetch, crawler) must never take a slot
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
    const clientIp = request.headers.get("cf-connecting-ip");
    if (turnstileEnabled(env)) {
      let token = "";
      try {
        const form = await request.formData();
        const v = form.get("cf-turnstile-response");
        token = typeof v === "string" ? v : "";
      } catch {
        token = "";
      }
      if (!(await verifyTurnstile(env.TURNSTILE_SECRET_KEY!, token, clientIp))) {
        return noticeResponse(request, 403, "demo_verification_failed", "Verification failed",
          "We could not verify that you are human. Please go back and try again.", cfg.launcherHost);
      }
    }
    const res = await pool.enter(ipPrefixKey(clientIp));
    if (res.kind === "assigned") return claimRedirect(res.host, res.claimToken);
    if (res.kind === "queued") return redirect(`/queue?q=${encodeURIComponent(res.queueId)}`, 303);
    if (res.kind === "maintenance") return maintenanceResponse(request, cfg);
    return noticeResponse(
      request,
      429,
      "demo_ip_limit",
      "Too many demos from your network",
      res.reason === "active"
        ? `Your network already has ${cfg.maxSlotsPerIp} private demos open. Close one (Reset) or wait for it to expire, then try again.`
        : "Your network already has a place in the queue. Please wait for it, or try again later.",
      cfg.launcherHost,
      { "Retry-After": "60" },
    );
  }

  if (url.pathname === "/__demo/queue-status" && request.method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    if (!q) return jsonResponse({ kind: "gone" });
    return jsonResponse(await pool.poll(q));
  }

  if (url.pathname === "/queue" && request.method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    if (!q) return redirect("/", 303);
    const res = await pool.poll(q);
    if (res.kind === "assigned") return claimRedirect(res.host, res.claimToken);
    if (res.kind === "gone") {
      return redirect("/", 303);
    }
    return htmlResponse(
      renderQueuePage(q, res.position, res.totalWaiting, res.nextFreeInMs, cfg.runbotHost),
    );
  }

  if (url.pathname === "/" && request.method === "GET") {
    const status = await pool.status();
    const reason =
      url.searchParams.get("expired") === "1"
        ? "expired"
        : url.searchParams.get("reset") === "1"
          ? "reset"
          : url.searchParams.get("unknown") === "1"
            ? "unknown"
            : null;
    return htmlResponse(renderLauncherPage(status, reason, turnstileEnabled(env) ? env.TURNSTILE_SITE_KEY! : null));
  }

  return redirect("/", 303);
}

async function handleRunbot(request: Request, url: URL, env: Env, exec: ExecutionContext, cfg: DemoConfig): Promise<Response> {
  const pool = poolStub(env);
  const info = await pool.runbotInfo();
  const res = await handleRequest(sanitizeRequestForOdoo(request), scopedDemoEnv(env, info.db, { slot: "runbot" }), exec);
  return maybeInjectBadge(
    url.pathname,
    res,
    buildDemoBadgeSnippet({ kind: "runbot", nextResetAt: info.nextResetAt, launcherHost: cfg.launcherHost }),
  );
}

async function handlePrivateSlot(
  request: Request,
  url: URL,
  env: Env,
  exec: ExecutionContext,
  cfg: DemoConfig,
  slotIndex: number,
): Promise<Response> {
  const pool = poolStub(env);

  if (url.pathname === "/__demo/claim" && request.method === "GET") {
    const noReferrer = { "Referrer-Policy": "no-referrer" };
    const claimToken = url.searchParams.get("t") ?? "";
    if (!claimToken) return redirect(`https://${cfg.launcherHost}/?unknown=1`, 303, noReferrer);
    // single use: the nonce is burned here and a fresh lease secret, never seen in a URL, becomes the cookie
    const claimed = await pool.claim(slotIndex, claimToken);
    if (!claimed.ok) return redirect(`https://${cfg.launcherHost}/?expired=1`, 303, noReferrer);
    // Clear any stale Odoo session_id cookie from a previous occupant and set our HttpOnly lease cookie
    const headers = new Headers({
      Location: "/web/login",
      "Cache-Control": "no-store",
      ...noReferrer,
    });
    headers.append("Set-Cookie", leaseCookie(claimed.leaseSecret, 3600));
    headers.append("Set-Cookie", EXPIRE_LEGACY_LEASE);
    headers.append("Set-Cookie", "session_id=; Path=/; HttpOnly; Max-Age=0");
    return new Response(null, { status: 303, headers });
  }

  // only the `__Host-` cookie counts: a plain `odoo_demo_lease` (settable from a sibling subdomain) is ignored
  const cookies = parseCookies(request.headers.get("cookie"));
  const token = cookies.get(LEASE_COOKIE) ?? null;

  if (url.pathname === "/__demo/reset" && request.method === "POST") {
    if (token) await pool.release(slotIndex, token);
    const headers = new Headers({
      Location: `https://${cfg.launcherHost}/?reset=1`,
      "Cache-Control": "no-store",
    });
    headers.append("Set-Cookie", leaseCookie("", 0));
    headers.append("Set-Cookie", EXPIRE_LEGACY_LEASE);
    headers.append("Set-Cookie", "session_id=; Path=/; HttpOnly; Max-Age=0");
    return new Response(null, { status: 303, headers });
  }

  if (!token) {
    if (isHtmlNavigation(request) || url.pathname === "/") {
      return redirect(`https://${cfg.launcherHost}/?unknown=1`, 303);
    }
    return new Response(JSON.stringify({ error: "demo_session_expired" }), {
      status: 410,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Demo-Expired": "1",
      },
    });
  }

  const userActivity = isUserActivityRequest(request.method, url.pathname);
  const verified = await pool.verify(slotIndex, token, userActivity);
  if (!verified.ok) {
    const clearHeaders = new Headers({
      "Cache-Control": "no-store",
      "X-Demo-Expired": "1",
    });
    clearHeaders.append("Set-Cookie", leaseCookie("", 0));
    clearHeaders.append("Set-Cookie", "session_id=; Path=/; HttpOnly; Max-Age=0");
    if (isHtmlNavigation(request) || url.pathname === "/") {
      const q = verified.reason === "missing" ? "unknown=1" : "expired=1";
      clearHeaders.set("Location", `https://${cfg.launcherHost}/?${q}`);
      return new Response(null, { status: 303, headers: clearHeaders });
    }
    clearHeaders.set("Content-Type", "application/json");
    return new Response(JSON.stringify({ error: "demo_session_expired" }), {
      status: 410,
      headers: clearHeaders,
    });
  }

  const res = await handleRequest(
    sanitizeRequestForOdoo(request),
    scopedDemoEnv(env, verified.db, { slot: String(slotIndex), secret: token }),
    exec,
  );
  return maybeInjectBadge(
    url.pathname,
    res,
    buildDemoBadgeSnippet({ kind: "slot", slotIndex, idleMs: cfg.idleMs, launcherHost: cfg.launcherHost }),
  );
}

/** Entry point called from `src/index.ts` when `env.DEMO_MODE === "1"`. */
export async function handleDemoRequest(incoming: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const url = new URL(incoming.url);
  const cfg = demoConfigFromEnv(env);
  const host = incoming.headers.get("host") ?? url.host;
  const target = parseDemoHost(host, cfg);

  const capped = await enforceDemoBodyCap(incoming);
  if (capped instanceof Response) return capped;
  const request = capped;

  if (target.kind === "launcher" && url.pathname.startsWith("/__demo/admin/")) return handleAdmin(request, url, env);
  if (target.kind !== "unknown" && !hasMaintenanceBypass(request, env) && (await inMaintenance(env))) {
    return maintenanceResponse(request, cfg);
  }

  switch (target.kind) {
    case "launcher":
      return handleLauncher(request, url, env, cfg);
    case "runbot":
      return handleRunbot(request, url, env, exec, cfg);
    case "slot":
      return handlePrivateSlot(request, url, env, exec, cfg, target.index);
    default:
      return redirect(`https://${cfg.launcherHost}/`, 302);
  }
}

/** Called from `src/index.ts` `scheduled()` when `env.DEMO_MODE === "1"`. */
export async function tickDemoPool(env: Env): Promise<void> {
  if (!env.DEMO_POOL) return;
  const st = await poolStub(env).tick();
  console.log(
    `demo tick: free=${st.freeSlots}/${st.totalSlots} occupied=${st.occupiedSlots} resetting=${st.resettingSlots} queue=${st.queueLength} runbotResetIn=${Math.round(st.runbotNextResetInMs / 1000)}s`,
  );
}
