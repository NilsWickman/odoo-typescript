/**
 * Render the three phase-1 pages against the reference bodies with the values the controllers supply, taking the
 * session-dependent values (csrf token, session_info json, icon) from the reference itself so the comparison is
 * byte for byte.
 *   node --experimental-transform-types --import ./src/xml/resolve-hooks.ts src/qweb/pages.check.ts <ref_login.html> <ref_odoo.html> <ref_offline.html> [dsn]
 */
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { renderTemplate } from "./index";

const [loginRef, odooRef, offlineRef] = [process.argv[2], process.argv[3], process.argv[4]].map((p) => {
  if (p === undefined) throw new Error("usage: pages.check.ts <login> <odoo> <offline> [dsn]");
  return readFileSync(p, "utf8");
});
const dsn = process.argv[5] ?? "postgresql://odoo:odoo@127.0.0.1:5433/poc_corpus";
const client = new pg.Client({ connectionString: dsn });
await client.connect();
const cr = { query: client.query.bind(client) };

function csrfOf(html: string): string {
  return /csrf_token: "([^"]+)"/.exec(html)![1]!;
}
function sessionInfoOf(html: string): Record<string, unknown> {
  const m = /odoo\.__session_info__ = (.*);/.exec(html)!;
  return JSON.parse(m[1]!) as Record<string, unknown>;
}

function report(name: string, ours: string, ref: string): boolean {
  if (ours === ref) {
    console.log(`${name}: identical (${ours.length} bytes)`);
    return true;
  }
  let i = 0;
  while (i < ours.length && ours[i] === ref[i]) i++;
  console.log(`${name}: DIFFERS at ${i}\n  ref  ${JSON.stringify(ref.slice(Math.max(0, i - 80), i + 80))}\n  ours ${JSON.stringify(ours.slice(Math.max(0, i - 80), i + 80))}`);
  writeFileSync(`/tmp/q/ours_${name}.html`, ours);
  return false;
}

// GET /web/login (home.py:111-173 web_login + auth_signup/controllers/main.py:27-30, 135-142)
const loginCsrf = csrfOf(loginRef!);
const frontendInfo = sessionInfoOf(loginRef!);
const login = await renderTemplate(cr, "web.login", {
  databases: null,
  disable_database_manager: true,
  disable_opengraph: false,
  signup_enabled: true,
  reset_password_enabled: true,
  login_success: false,
  request: { csrf_token: () => loginCsrf, db: "poc_corpus" },
  env: new Map([["ir.http", { get_frontend_session_info: () => frontendInfo }]]),
  res_company: { uses_default_logo: true, name: "YourCompany" },
  keep_query: () => "",
});
const ok1 = report("login", login, loginRef!);

// GET /odoo (home.py:50-91 web_client: webclient_rendering_context = color_scheme + session_info)
const odooCsrf = csrfOf(odooRef!);
const odoo = await renderTemplate(cr, "web.webclient_bootstrap", {
  color_scheme: "light",
  session_info: sessionInfoOf(odooRef!),
  request: { csrf_token: () => odooCsrf, db: "poc_corpus" },
  res_company: { uses_default_logo: true, name: "YourCompany" },
});
const ok2 = report("odoo", odoo, odooRef!);

// GET /odoo/offline (webmanifest.py:108-115)
const offlineCsrf = csrfOf(offlineRef!);
const icon = /base64,([^"]+)"/.exec(offlineRef!)![1]!;
const offline = await renderTemplate(cr, "web.webclient_offline", {
  odoo_icon: { to_base64: () => icon },
  request: { csrf_token: () => offlineCsrf, db: "poc_corpus" },
});
const ok3 = report("offline", offline, offlineRef!);
await client.end();
process.exit(ok1 && ok2 && ok3 ? 0 : 1);
