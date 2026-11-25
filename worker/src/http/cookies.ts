/**
 * Cookie parsing and the `Set-Cookie` format werkzeug produces (`werkzeug.http.dump_cookie`), as Odoo's
 * `Response.set_cookie`/`FutureResponse.set_cookie` call it (`odoo/odoo/http/response.py:102-146`):
 * `key=value; Expires=<http date>; Max-Age=<n>; HttpOnly; Path=/` with werkzeug's attribute order
 * Domain, Expires, Max-Age, Secure, HttpOnly, Path, SameSite. The harness compares the attributes and drops
 * `Expires` (harness/NORMALIZATION.md R2).
 */

export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (header === null) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (key !== "" && !out.has(key)) out.set(key, decodeURIComponentSafe(value));
  }
  return out;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    if (e instanceof URIError) return s;
    throw e;
  }
}

export interface CookieOptions {
  /** Seconds; werkzeug also sets `Expires` from it only when `expires` is not given. Odoo always passes expires. */
  readonly maxAge?: number;
  /** Absolute expiry; Odoo defaults to now + 365 days (response.py:109-110, 141-142). */
  readonly expires?: Date | null;
  readonly path?: string;
  readonly domain?: string;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  readonly sameSite?: "Strict" | "Lax" | "None";
}

/** `werkzeug.http.dump_cookie`; `max_age=0` with a default expiry: Odoo passes expires=-1 so Expires is 1 year ahead. */
export function dumpCookie(key: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${key}=${value}`];
  if (opts.domain !== undefined) parts.push(`Domain=${opts.domain}`);
  if (opts.expires !== undefined && opts.expires !== null) parts.push(`Expires=${httpDate(opts.expires)}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.secure === true) parts.push("Secure");
  if (opts.httpOnly === true) parts.push("HttpOnly");
  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.sameSite !== undefined) parts.push(`SameSite=${opts.sameSite}`);
  return parts.join("; ");
}

/** RFC 1123 date as werkzeug's `http_date`: "Thu, 28 Oct 2027 10:31:22 GMT" (= Date#toUTCString). */
export function httpDate(d: Date): string {
  return d.toUTCString();
}

/** `set_cookie(key, max_age=0)` as `_post_logout` does for `cids` (web/models/ir_http.py:70): expired cookie. */
export function expiredCookie(key: string, now: Date): string {
  // werkzeug: max_age=0 and the (default, one year ahead) expires given by Odoo's set_cookie wrapper.
  return dumpCookie(key, "", { maxAge: 0, expires: new Date(now.getTime() + 365 * 86400 * 1000) });
}
