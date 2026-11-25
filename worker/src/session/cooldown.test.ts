import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Cursor } from "../db";
import { AccessDenied } from "../errors";
import { assertCanAuth, onLoginCooldown } from "./auth";
import type { LoginFailures } from "./session";

/**
 * A cursor answering only ir_config_parameter reads (res_users.py:1412-1417), read whole by `icpStr`, and the
 * signaling statement; its registry caches live for the cursor only (`isolateCache: false`).
 */
function cursor(params: Record<string, string>): Cursor {
  return {
    db: "t", isolateCache: false, writtenTables: new Set<string>(),
    query: async (sql: string) => ({
      rows: sql.includes("orm_signaling_registry") ? [{ now: new Date(0), registry: 1, default: 1, assets: 1, stable: 1, templates: 1, routing: 1, groups: 1, dboid: "1" }]
        : Object.entries(params).map(([key, value]) => ({ key, value })),
    }),
  } as unknown as Cursor;
}

function source(): LoginFailures & { state: [number, number] } {
  const s = { state: [0, 0] as [number, number],
    read: async () => s.state, failed: async (now: number) => { s.state = [s.state[0] + 1, now]; }, succeeded: async () => { s.state = [0, 0]; } };
  return s;
}

test("_on_login_cooldown: 5 failures by default, 60 s, 0 disables", async () => {
  const now = 1_000_000;
  assert.equal(await onLoginCooldown(cursor({}), 4, now - 1000, now), false);
  assert.equal(await onLoginCooldown(cursor({}), 5, now - 1000, now), true);
  assert.equal(await onLoginCooldown(cursor({}), 5, now - 60_000, now), false);
  assert.equal(await onLoginCooldown(cursor({ "base.login_cooldown_after": "10" }), 9, now, now), false);
  assert.equal(await onLoginCooldown(cursor({ "base.login_cooldown_after": "0" }), 50, now, now), false);
  assert.equal(await onLoginCooldown(cursor({ "base.login_cooldown_duration": "0" }), 5, now - 59_000, now), true);
  assert.equal(await onLoginCooldown(cursor({ "base.login_cooldown_duration": "3" }), 5, now - 3000, now), false);
});

test("_assert_can_auth: failures counted, refused while on cooldown without counting, cleared by a success", async () => {
  const cr = cursor({ "base.login_cooldown_after": "2" });
  const src = source();
  const fail = async (): Promise<never> => { throw new AccessDenied(); };
  for (let i = 0; i < 2; i++) await assert.rejects(assertCanAuth(cr, src, "en_US", "admin", fail), (e: Error) => e.message === "Access Denied");
  assert.equal(src.state[0], 2);
  await assert.rejects(assertCanAuth(cr, src, "en_US", "admin", async () => 1), (e: Error) => e.message.startsWith("Too many login failures"));
  assert.equal(src.state[0], 2);
  // translate.py:1077: without a language `_()` does int(user)
  await assert.rejects(assertCanAuth(cr, src, null, "admin", async () => 1), (e: Error) => e.message === "invalid literal for int() with base 10: 'admin'");
  src.state = [2, Date.now() - 61_000];
  assert.equal(await assertCanAuth(cr, src, "en_US", "admin", async () => 7), 7);
  assert.deepEqual(src.state, [0, 0]);
  assert.equal(await assertCanAuth(cr, null, null, "admin", async () => 8), 8); // no request: no cooldown
});
