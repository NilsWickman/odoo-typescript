/**
 * CSRF tokens, `odoo/odoo/http/requestlib.py:224-272` (Request.csrf_token / validate_csrf):
 * `hmac_sha1(database.secret, sid[:42] + str(max_ts)).hexdigest() + "o" + str(max_ts)`, where `max_ts` is
 * `int(time.time() + (time_limit or CSRF_TOKEN_SALT))` and CSRF_TOKEN_SALT is one year (requestlib.py:55).
 * The harness masks tokens of this shape (rcheck.py `_CSRF`), so wall-clock time here never reaches a comparison.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { STORED_SESSION_BYTES } from "../session/session";

export const CSRF_TOKEN_SALT = 60 * 60 * 24 * 365;

export function csrfToken(secret: string, sid: string, timeLimit: number | null = null): string {
  if (secret === "") throw new Error("CSRF protection requires a configured database secret"); // requestlib.py:236
  const maxTs = Math.floor(Date.now() / 1000 + (timeLimit ?? CSRF_TOKEN_SALT));
  const msg = `${sid.slice(0, STORED_SESSION_BYTES)}${maxTs}`;
  const hm = createHmac("sha1", Buffer.from(secret, "ascii")).update(msg).digest("hex");
  return `${hm}o${maxTs}`;
}

export function validateCsrf(secret: string, sid: string, csrf: unknown): boolean {
  if (typeof csrf !== "string" || csrf === "") return false; // requestlib.py:253
  if (secret === "") throw new Error("CSRF protection requires a configured database secret");
  const sep = csrf.lastIndexOf("o");
  const hm = sep < 0 ? csrf : csrf.slice(0, sep);
  const maxTs = sep < 0 ? "" : csrf.slice(sep + 1);
  if (maxTs !== "") {
    if (!/^\d+$/.test(maxTs)) return false; // int(max_ts) raised ValueError
    if (Number(maxTs) < Math.floor(Date.now() / 1000)) return false;
  }
  const msg = `${sid.slice(0, STORED_SESSION_BYTES)}${maxTs}`;
  const expected = createHmac("sha1", Buffer.from(secret, "ascii")).update(msg).digest("hex");
  const a = Buffer.from(hm, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b); // odoo.tools.consteq
}
