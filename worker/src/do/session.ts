/**
 * Odoo's session store (`odoo/http.py` FilesystemSessionStore) on a fixed set of Durable Objects: each object holds
 * the sessions whose sid falls in it (src/session/session.ts `SessionStore`), keyed by sid, and the login-failure
 * records named to it. KV was rejected for its visibility guarantees (docs/PHASE1.md section 5): a login followed by
 * a redirect must see the session it just wrote.
 *
 * A fixed set, not one object per sid (C2c, 2026-11-11): the first call to an object named by `idFromName` waits for
 * Cloudflare's global check that no other location created it (durable-objects/api/namespace "newUniqueId results in
 * lower request latency at first use"), measured on the site at 0.95-1.3 s per new object (results/evidence/c2d): every
 * new visitor's first page and every login (the rotated sid) paid it, a login twice with its failure record.
 */
import { DurableObject } from "cloudflare:workers";
import { purgeOldSessions, readLoginFailures, recordLoginFailure } from "../session/session_gc";
import { wasmPbkdf2 } from "../session/wasm-kdf";

const SESSION_KEY = "session:";

export class SessionStore extends DurableObject {
  /** Pure computation only. Never persisted; user lookup and the authentication decision stay in the Worker. */
  async derivePassword(password: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
    try {
      return wasmPbkdf2(password, salt, 600_000); // res_users.py:90, unchanged Odoo work factor
    } finally {
      password.fill(0);
    }
  }

  /** Nothing: a call that makes the object exist (the warm-up from a request, src/session/session.ts `warmSessionObjects`). */
  async ping(): Promise<void> {}

  async getSession(sid: string): Promise<string | null> {
    return (await this.ctx.storage.get<string>(SESSION_KEY + sid)) ?? null;
  }

  async putSession(sid: string, data: string): Promise<void> {
    await this.ctx.storage.put(SESSION_KEY + sid, data);
  }

  async deleteSession(sid: string): Promise<void> {
    await this.ctx.storage.delete(SESSION_KEY + sid);
  }

  async deleteOldSessions(prefix: string, currentSid: string, nowSec: number): Promise<void> {
    await purgeOldSessions(this.ctx.storage, prefix, currentSid, nowSec);
  }

  /**
   * res_users.py:1356-1384 `reg._login_failures[source]`: (failures since the last success, time of the last failure
   * in ms), under a key named by database and remote address (session.ts `loginFailures`), so every isolate sees the
   * same count. Odoo keeps it per process; a record in the shared objects is the shared state the cooldown needs on Workers.
   */
  async loginFailures(key: string): Promise<[number, number]> {
    return readLoginFailures(this.ctx.storage, key);
  }

  async loginFailed(key: string, now: number): Promise<void> {
    await recordLoginFailure(this.ctx.storage, key, now);
  }

  async loginSucceeded(key: string): Promise<void> {
    await this.ctx.storage.delete(key);
  }
}
