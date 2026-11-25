/**
 * `/proof`: a public page (outside Cloudflare Access: its own Access application "odoo-ts proof" with a bypass policy) showing that this response was
 * produced by the odoo-ts Worker on Cloudflare: the data center that ran it, the deployed Worker version, and a live
 * query of the Odoo database made from the Worker. Not an Odoo route; it reads no user data.
 *
 * On the public demo (`DEMO_MODE=1`, src/index.ts) it answers on the launcher, the Runbot and every slot host before
 * the demo router, without a lease or a login. The database facts are read at most once a minute per isolate
 * (src/proof_logic.ts), read-only; the request facts stay live.
 */
import type { Env } from "./env";
import { Cursor } from "./db";
import { demoConfigFromEnv } from "./do/demo_pool";
import { runbotDbName } from "./demo/pool_logic";
import { cachedFacts, PROOF_FACTS_TTL_MS, proofDbs, type CachedFacts } from "./proof_logic";

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

interface DbFacts { base: string; modules: number; partners: number; orders: number; moves: number; pg: string; ms: number; connectMs: number }

async function dbFacts(env: Env, db: string): Promise<DbFacts> {
  const cr = new Cursor(env, db);
  try {
    // the first statement of the transaction: nothing this page runs can write
    await cr.query("SET TRANSACTION READ ONLY");
    const t0 = performance.now();
    const r = await cr.query<{ base: string; modules: string; partners: string; orders: string; moves: string; pg: string }>(
      `SELECT (SELECT latest_version FROM ir_module_module WHERE name = 'base') AS base,
              (SELECT count(*) FROM ir_module_module WHERE state = 'installed')::text AS modules,
              (SELECT count(*) FROM res_partner)::text AS partners,
              (SELECT count(*) FROM sale_order)::text AS orders,
              (SELECT count(*) FROM account_move)::text AS moves,
              split_part(version(), ' ', 2) AS pg`,
    );
    const ms = Math.round(performance.now() - t0);
    await cr.rollback();
    const row = r.rows[0]!;
    return { base: row.base, modules: +row.modules, partners: +row.partners, orders: +row.orders, moves: +row.moves, pg: row.pg,
      ms: Math.max(0, ms - Math.round(cr.connectMs)), connectMs: Math.round(cr.connectMs) };
  } finally {
    await cr.close();
  }
}

export async function proof(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const cf = (request as Request & { cf?: Record<string, unknown> }).cf ?? {};
  const ray = request.headers.get("cf-ray") ?? "";
  const ver = env.CF_VERSION_METADATA;
  const demo = env.DEMO_MODE === "1";
  const dbs = proofDbs(env);
  let read: CachedFacts<DbFacts> | null = null;
  let dbError: string | null = null;
  if (dbs.length > 0) {
    try { read = await cachedFacts(dbs, (db) => dbFacts(env, db)); } catch (e) { dbError = e instanceof Error ? e.name : "error"; }
  }
  const facts = read?.facts ?? null;
  const cfg = demo ? demoConfigFromEnv(env) : null;
  const minutes = (ms: number) => { const m = Math.round(ms / 60_000); return m === 1 ? "1 minute" : `${m} minutes`; };
  const intro = cfg
    ? `This page was generated just now by the same Worker that serves this public demo of the Odoo web client
(<a href="https://${esc(cfg.launcherHost)}/">${esc(cfg.launcherHost)}</a>): every visitor gets a private copy of the
database, reset after ${minutes(cfg.idleMs)} idle, and a shared Runbot resets every ${minutes(cfg.runbotResetMs)}; log in
as <code>admin</code> / <code>admin</code>.`
    : `This page was generated just now by the same Worker that serves the Odoo web client on this domain (which is behind a login).`;
  const runbot = read !== null && (read.db === runbotDbName("a") || read.db === runbotDbName("b"));
  const dbLabel = read === null ? "" : runbot ? `${read.db} (the public Runbot's, a fresh copy of the demo's database)` : read.db;
  const row = (k: string, v: unknown) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>odoo-ts: running on Cloudflare Workers</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:680px;margin:40px auto;padding:0 16px;color:#1b1b1b}
h1{font-size:22px;margin:0 0 4px}p{color:#555}table{border-collapse:collapse;width:100%;margin:12px 0 24px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e3e3e3;vertical-align:top}th{width:45%;font-weight:600}
code{background:#f2f2f2;padding:1px 4px;border-radius:4px}@media(prefers-color-scheme:dark){body{background:#151515;color:#eee}p{color:#aaa}th,td{border-color:#333}code{background:#262626}}</style></head><body>
<h1>Odoo, ported to TypeScript, running in a Cloudflare Worker</h1>
<p>${intro}
Reload it and the request id and timing change; open it from another country and the data center changes.</p>
<h2>This request</h2><table>
${row("Cloudflare data center that ran the Worker", `${cf["colo"] ?? "?"}`)}
${row("Request id (cf-ray)", ray)}
${row("Your location as Cloudflare sees it", [cf["city"], cf["country"]].filter(Boolean).join(", ") || "?")}
${row("Served at (UTC)", new Date().toISOString())}
</table>
<h2>Deployed Worker</h2><table>
${row("Worker script", demo ? "odoo-ts-demo" : "odoo-ts")}
${row("Version id", ver?.id ?? "(local)")}
${row("Deployed at", ver?.timestamp ?? "(local)")}
</table>
<h2>Live Odoo database, queried from the Worker</h2>
${facts && read ? `<p>Read at most once a minute: the request above is live, these facts are up to ${PROOF_FACTS_TTL_MS / 1000} s old.</p><table>
${row("Database", dbLabel)}
${row("Read from the database at (UTC)", new Date(read.at).toISOString())}
${row("Odoo base module version", facts.base)}
${row("Installed Odoo modules", facts.modules)}
${row("Contacts / sales orders / journal entries", `${facts.partners} / ${facts.orders} / ${facts.moves}`)}
${row("PostgreSQL version (on a Hetzner VPS in Helsinki through a Cloudflare Tunnel, not Cloudflare)", facts.pg)}
${row("Connect from the Worker (TCP, authentication, BEGIN)", `${facts.connectMs} ms`)}
${row("Query round trip from the Worker", `${facts.ms} ms`)}
</table>` : `<p>${dbError ? `Database not reachable (${esc(dbError)}).` : "No database configured."}</p>`}
<p>Everything Odoo does on the server (HTTP, sessions, ORM, access rules, views, reports) runs as TypeScript in the Worker.
The only thing outside Cloudflare is PostgreSQL.</p>
</body></html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Served-By": "odoo-ts Worker" },
  });
}
