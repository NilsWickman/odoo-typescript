import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NotPorted, UserError } from "../errors";
import { DEMO_NOT_PORTED_MESSAGE, demoNotPortedFloor } from "./not_ported";
import { pdfQuotaTarget } from "./quota";
import {
  claimSlotLease,
  constantTimeEqual,
  consumePdfQuota,
  databasesToMeasure,
  drainPool,
  enforceDbSizeCap,
  ipPrefixKey,
  reconcileSlotCount,
  resetPoolState,
  setMaintenance,
  collectDueWork,
  computeNextAlarmAt,
  createInitialSnapshot,
  DEFAULT_DEMO_CONFIG,
  enterPool,
  finishRunbotRebuild,
  finishSlotReset,
  getPoolStatus,
  isUserActivityRequest,
  parseDemoHost,
  pollQueue,
  releaseSlotLease,
  runbotDbName,
  verifySlotLease,
  type DemoConfig,
  type PoolSnapshot,
} from "./pool_logic";

function testConfig(overrides: Partial<DemoConfig> = {}): DemoConfig {
  return {
    ...DEFAULT_DEMO_CONFIG,
    slotCount: 3,
    idleMs: 60_000,
    runbotResetMs: 600_000,
    queueStaleMs: 20_000,
    claimGraceMs: 25_000,
    resetRetryMs: 60_000,
    ...overrides,
  };
}

let seq = 0;
const nextTok = () => `tok-${++seq}`;
const nextQ = () => `q-${++seq}`;
const nextSecret = () => `secret-${++seq}`;

/** Claim and return the fresh lease secret (asserting the claim succeeded). */
function claimOk(snap: PoolSnapshot, cfg: DemoConfig, slot: number, claimToken: string, now: number): string {
  const res = claimSlotLease(snap, cfg, slot, claimToken, now, nextSecret);
  assert.equal(res.ok, true);
  return res.leaseSecret;
}

describe("demo host parsing", () => {
  const cfg = testConfig({ slotCount: 20 });

  it("matches launcher, runbot, and numbered slots within range", () => {
    assert.deepEqual(parseDemoHost("odoo-ts-demo.example.com", cfg), { kind: "launcher" });
    assert.deepEqual(parseDemoHost("ODOO-TS-RUNBOT.EXAMPLE.COM:443", cfg), { kind: "runbot" });
    assert.deepEqual(parseDemoHost("odoo-ts-1.example.com", cfg), { kind: "slot", index: 1, host: "odoo-ts-1.example.com" });
    assert.deepEqual(parseDemoHost("odoo-ts-20.example.com", cfg), { kind: "slot", index: 20, host: "odoo-ts-20.example.com" });
  });

  it("rejects out-of-range, leading-zero, production, and nested hosts", () => {
    assert.deepEqual(parseDemoHost("odoo-ts.example.com", cfg), { kind: "unknown" });
    assert.deepEqual(parseDemoHost("odoo-ts-site1.example.com", cfg), { kind: "unknown" });
    assert.deepEqual(parseDemoHost("odoo-ts-0.example.com", cfg), { kind: "unknown" });
    assert.deepEqual(parseDemoHost("odoo-ts-01.example.com", cfg), { kind: "unknown" });
    assert.deepEqual(parseDemoHost("odoo-ts-21.example.com", cfg), { kind: "unknown" });
    assert.deepEqual(parseDemoHost("a.odoo-ts-1.example.com", cfg), { kind: "unknown" });
    assert.deepEqual(parseDemoHost("evil.example.com", cfg), { kind: "unknown" });
  });
});

describe("user activity classification", () => {
  it("counts real Odoo pages and RPC calls, ignores background/static traffic", () => {
    assert.equal(isUserActivityRequest("GET", "/odoo"), true);
    assert.equal(isUserActivityRequest("GET", "/web/login"), true);
    assert.equal(isUserActivityRequest("POST", "/web/dataset/call_kw/res.partner/web_search_read"), true);
    assert.equal(isUserActivityRequest("GET", "/websocket"), false);
    assert.equal(isUserActivityRequest("POST", "/bus/get_model_definitions"), false);
    assert.equal(isUserActivityRequest("GET", "/web/assets/1/web.assets_web.min.js"), false);
    assert.equal(isUserActivityRequest("GET", "/web/static/img/favicon.ico"), false);
    assert.equal(isUserActivityRequest("GET", "/__demo/status"), false);
    assert.equal(isUserActivityRequest("HEAD", "/odoo"), false);
  });
});

describe("DemoPool slot assignment, FIFO queue, and 1-minute inactivity reset", () => {
  it("assigns free slots, queues when full, and promotes head of FIFO queue after reset", () => {
    const cfg = testConfig({ slotCount: 2 });
    const t0 = 1_000_000;
    const snap = createInitialSnapshot(cfg, t0);

    const r1 = enterPool(snap, cfg, t0, nextTok, nextQ);
    assert.equal(r1.kind, "assigned");
    assert.equal(r1.slot, 1);
    const r1Lease = claimOk(snap, cfg, r1.slot, r1.claimToken, t0 + 500);

    const r2 = enterPool(snap, cfg, t0 + 1_000, nextTok, nextQ);
    assert.equal(r2.kind, "assigned");
    assert.equal(r2.slot, 2);
    const r2Lease = claimOk(snap, cfg, r2.slot, r2.claimToken, t0 + 1_500);

    // Pool full: visitors 3 and 4 enter FIFO queue
    const r3 = enterPool(snap, cfg, t0 + 2_000, nextTok, nextQ);
    assert.equal(r3.kind, "queued");
    assert.equal(r3.position, 1);
    assert.equal(r3.totalWaiting, 1);

    const r4 = enterPool(snap, cfg, t0 + 3_000, nextTok, nextQ);
    assert.equal(r4.kind, "queued");
    assert.equal(r4.position, 2);
    assert.equal(r4.totalWaiting, 2);

    // Slot 2 stays active at t0 + 40s, slot 1 is idle since t0 + 500ms
    const v2 = verifySlotLease(snap, cfg, r2.slot, r2Lease, true, t0 + 40_000);
    assert.equal(v2.ok, true);

    // Both waiters heartbeat regularly while waiting so neither goes stale (>20s)
    for (const t of [t0 + 15_000, t0 + 30_000, t0 + 45_000, t0 + 55_000]) {
      const p3 = pollQueue(snap, cfg, r3.queueId, t, nextTok);
      assert.equal(p3.kind, "queued");
      assert.equal(p3.position, 1);
      const p4 = pollQueue(snap, cfg, r4.queueId, t, nextTok);
      assert.equal(p4.kind, "queued");
      assert.equal(p4.position, 2);
    }

    // At t0 + 60_500ms: slot 1 has been idle for 60s -> expires and enters resetting
    const due = collectDueWork(snap, cfg, t0 + 60_500, nextTok);
    assert.deepEqual(due.slotsToReset, [1]);
    assert.equal(snap.slots[0]!.state, "resetting");
    assert.equal(snap.slots[1]!.state, "occupied");

    // Old token for slot 1 is immediately rejected
    assert.equal(verifySlotLease(snap, cfg, r1.slot, r1Lease, true, t0 + 60_600).ok, false);

    // Once Postgres reset finishes, waiter #1 (r3) is promoted immediately into slot 1!
    finishSlotReset(snap, cfg, 1, true, t0 + 62_000, nextTok);
    assert.equal(snap.slots[0]!.state, "occupied");

    const p3Ready = pollQueue(snap, cfg, r3.queueId, t0 + 62_500, nextTok);
    assert.equal(p3Ready.kind, "assigned");
    assert.equal(p3Ready.slot, 1);
    assert.notEqual(p3Ready.claimToken, r1.claimToken);

    // Waiter #2 (r4) moves up to position #1
    const p4Moved = pollQueue(snap, cfg, r4.queueId, t0 + 62_500, nextTok);
    assert.equal(p4Moved.kind, "queued");
    assert.equal(p4Moved.position, 1);
  });

  it("prunes stale queue waiters and revokes unclaimed assignments", () => {
    const cfg = testConfig({ slotCount: 1 });
    const t0 = 2_000_000;
    const snap = createInitialSnapshot(cfg, t0);

    // Visitor 1 gets slot 1 but never claims it (closed browser before redirect)
    const r1 = enterPool(snap, cfg, t0, nextTok, nextQ);
    assert.equal(r1.kind, "assigned");

    // Visitor 2 joins queue and polls; visitor 3 joins queue and abandons tab
    const r2 = enterPool(snap, cfg, t0 + 1_000, nextTok, nextQ);
    assert.equal(r2.kind, "queued");
    const r3 = enterPool(snap, cfg, t0 + 1_000, nextTok, nextQ);
    assert.equal(r3.kind, "queued");

    // Visitor 2 polls at t0 + 15s (alive), visitor 3 does not
    assert.equal(pollQueue(snap, cfg, r2.queueId, t0 + 15_000, nextTok).kind, "queued");

    // At t0 + 26s: r1's claimGraceMs (25s) expired -> slot 1 returned ready and immediately promoted to r2!
    // Meanwhile r3 went stale (>20s without poll) and is pruned.
    const p2 = pollQueue(snap, cfg, r2.queueId, t0 + 26_000, nextTok);
    assert.equal(p2.kind, "assigned");
    assert.equal(p2.slot, 1);
    assert.equal(pollQueue(snap, cfg, r3.queueId, t0 + 26_000, nextTok).kind, "gone");
  });

  it("does not extend inactivity timer on background (non-user) requests", () => {
    const cfg = testConfig({ slotCount: 1 });
    const t0 = 3_000_000;
    const snap = createInitialSnapshot(cfg, t0);

    const r1 = enterPool(snap, cfg, t0, nextTok, nextQ);
    assert.equal(r1.kind, "assigned");
    const r1Lease = claimOk(snap, cfg, r1.slot, r1.claimToken, t0);

    // Background polling at +30s and +55s does not refresh lastActiveAt
    const bg1 = verifySlotLease(snap, cfg, r1.slot, r1Lease, false, t0 + 30_000);
    assert.equal(bg1.ok, true);
    if (bg1.ok) assert.equal(bg1.idleRemainingMs, 30_000);

    const bg2 = verifySlotLease(snap, cfg, r1.slot, r1Lease, false, t0 + 55_000);
    assert.equal(bg2.ok, true);
    if (bg2.ok) assert.equal(bg2.idleRemainingMs, 5_000);

    // At +60s it expires!
    const expired = verifySlotLease(snap, cfg, r1.slot, r1Lease, false, t0 + 60_000);
    assert.equal(expired.ok, false);
    if (!expired.ok) assert.equal(expired.reason, "expired");
  });

  it("supports manual reset and immediate re-use after reset completes", () => {
    const cfg = testConfig({ slotCount: 1 });
    const t0 = 4_000_000;
    const snap = createInitialSnapshot(cfg, t0);

    const r1 = enterPool(snap, cfg, t0, nextTok, nextQ);
    assert.equal(r1.kind, "assigned");
    const r1Lease = claimOk(snap, cfg, 1, r1.claimToken, t0);

    assert.equal(releaseSlotLease(snap, 1, "wrong-token", t0 + 5_000), false);
    assert.equal(releaseSlotLease(snap, 1, r1Lease, t0 + 5_000), true);
    assert.equal(snap.slots[0]!.state, "resetting");

    finishSlotReset(snap, cfg, 1, true, t0 + 8_000, nextTok);
    assert.equal(snap.slots[0]!.state, "ready");
    assert.equal(snap.slots[0]!.epoch, 2);
  });
});

describe("Shared Runbot 10-minute A/B rotation", () => {
  it("swaps A -> B -> A every 10 minutes with zero downtime", () => {
    const cfg = testConfig({ runbotResetMs: 600_000 });
    const t0 = 5_000_000;
    const snap = createInitialSnapshot(cfg, t0);

    assert.equal(runbotDbName(snap.runbot.active), "demo_runbot_a");
    assert.equal(getPoolStatus(snap, cfg, t0).runbotNextResetInMs, 600_000);

    // Before 10 min: no swap
    const early = collectDueWork(snap, cfg, t0 + 599_000, nextTok);
    assert.equal(early.runbotSwapped, false);
    assert.equal(early.runbotToRebuild, null);

    // At 10 min: instant swap to B, schedule rebuild of A
    const swap1 = collectDueWork(snap, cfg, t0 + 600_000, nextTok);
    assert.equal(swap1.runbotSwapped, true);
    assert.equal(swap1.runbotToRebuild, "a");
    assert.equal(runbotDbName(snap.runbot.active), "demo_runbot_b");
    assert.equal(snap.runbot.nextResetAt, t0 + 1_200_000);

    finishRunbotRebuild(snap, cfg, "a", true, t0 + 603_000);
    assert.equal(snap.runbot.rebuilding, null);

    // Next alarm points to next Runbot reset when no slots are occupied
    assert.equal(computeNextAlarmAt(snap, cfg, t0 + 603_000), t0 + 1_200_000);

    // At 20 min: swap back to A, rebuild B
    const swap2 = collectDueWork(snap, cfg, t0 + 1_200_000, nextTok);
    assert.equal(swap2.runbotSwapped, true);
    assert.equal(swap2.runbotToRebuild, "b");
    assert.equal(runbotDbName(snap.runbot.active), "demo_runbot_a");
  });
});

describe("per-IP prefix keys (IPv4 /32, IPv6 /64)", () => {
  it("keys IPv4 by the whole address and IPv4-mapped IPv6 the same way", () => {
    assert.equal(ipPrefixKey("203.0.113.7"), "v4:203.0.113.7");
    assert.equal(ipPrefixKey(" 203.0.113.7 "), "v4:203.0.113.7");
    assert.notEqual(ipPrefixKey("203.0.113.7"), ipPrefixKey("203.0.113.8"));
    assert.equal(ipPrefixKey("::ffff:203.0.113.7"), "v4:203.0.113.7");
    assert.equal(ipPrefixKey("::ffff:cb00:7107"), "v4:203.0.113.7");
  });

  it("keys IPv6 by its /64, whatever the notation of the host part", () => {
    const a = ipPrefixKey("2001:db8:abcd:12::1");
    assert.equal(a, "v6:2001:db8:abcd:12::/64");
    assert.equal(ipPrefixKey("2001:0DB8:ABCD:0012:ffff:eeee:dddd:cccc"), a);
    assert.equal(ipPrefixKey("2001:db8:abcd:12:0:0:0:99%eth0"), a);
    assert.notEqual(ipPrefixKey("2001:db8:abcd:13::1"), a);
    assert.equal(ipPrefixKey("::1"), "v6:0:0:0:0::/64");
  });

  it("returns null for missing or malformed values (no cap applies)", () => {
    for (const bad of [null, undefined, "", "unknown", "256.1.1.1", "1.2.3", "2001:db8::1::2", "2001:db8:zz::1", "1:2:3:4:5:6:7:8:9"]) {
      assert.equal(ipPrefixKey(bad), null, String(bad));
    }
  });
});

describe("single-use claim nonce and fresh lease secret", () => {
  it("burns the URL nonce on claim and mints a different lease secret for the cookie", () => {
    const cfg = testConfig({ slotCount: 1 });
    const t0 = 10_000_000;
    const snap = createInitialSnapshot(cfg, t0);
    const r = enterPool(snap, cfg, t0, nextTok, nextQ);
    assert.equal(r.kind, "assigned");
    // before the claim, the nonce is no lease: it opens nothing
    assert.equal(verifySlotLease(snap, cfg, 1, r.claimToken, true, t0 + 100).ok, false);
    const c = claimSlotLease(snap, cfg, 1, r.claimToken, t0 + 200, () => "lease-secret-1");
    assert.equal(c.ok, true);
    assert.equal(c.leaseSecret, "lease-secret-1");
    assert.notEqual(c.leaseSecret, r.claimToken);
    assert.equal(snap.slots[0]!.claimToken, null);
    // a second use of the same URL fails (replay from history, a leaked Referer)
    assert.equal(claimSlotLease(snap, cfg, 1, r.claimToken, t0 + 300, nextSecret).ok, false);
    // the nonce never works as a cookie, the secret does
    assert.equal(verifySlotLease(snap, cfg, 1, r.claimToken, true, t0 + 400).ok, false);
    assert.equal(verifySlotLease(snap, cfg, 1, "lease-secret-1", true, t0 + 400).ok, true);
    assert.equal(releaseSlotLease(snap, 1, r.claimToken, t0 + 500), false);
  });

  it("hands queued visitors a nonce that is pruned once claimed", () => {
    const cfg = testConfig({ slotCount: 1 });
    const t0 = 11_000_000;
    const snap = createInitialSnapshot(cfg, t0);
    const r1 = enterPool(snap, cfg, t0, nextTok, nextQ);
    assert.equal(r1.kind, "assigned");
    const l1 = claimOk(snap, cfg, 1, r1.claimToken, t0);
    const r2 = enterPool(snap, cfg, t0 + 1_000, nextTok, nextQ);
    assert.equal(r2.kind, "queued");
    assert.equal(releaseSlotLease(snap, 1, l1, t0 + 2_000), true);
    finishSlotReset(snap, cfg, 1, true, t0 + 3_000, nextTok);
    const p = pollQueue(snap, cfg, r2.queueId, t0 + 3_500, nextTok);
    assert.equal(p.kind, "assigned");
    claimOk(snap, cfg, 1, p.claimToken, t0 + 4_000);
    assert.equal(snap.queue.length, 0);
    assert.equal(pollQueue(snap, cfg, r2.queueId, t0 + 4_500, nextTok).kind, "gone");
  });

  it("compares secrets in constant time and exactly", () => {
    assert.equal(constantTimeEqual("abc", "abc"), true);
    assert.equal(constantTimeEqual("abc", "abd"), false);
    assert.equal(constantTimeEqual("abc", "abcd"), false);
    assert.equal(constantTimeEqual("", ""), true);
    assert.equal(constantTimeEqual("", "a"), false);
  });
});

describe("hard 30-minute lease cap", () => {
  it("expires an always-active lease 30 minutes after its claim and queues the reset", () => {
    const cfg = testConfig({ slotCount: 1, maxLeaseMs: 1_800_000, runbotResetMs: 86_400_000 });
    const t0 = 12_000_000;
    const snap = createInitialSnapshot(cfg, t0);
    const r = enterPool(snap, cfg, t0, nextTok, nextQ);
    assert.equal(r.kind, "assigned");
    const lease = claimOk(snap, cfg, 1, r.claimToken, t0);
    // a keep-alive bot touches every 30 s
    for (let t = t0 + 30_000; t < t0 + 1_800_000; t += 30_000) {
      assert.equal(verifySlotLease(snap, cfg, 1, lease, true, t).ok, true, `at ${t - t0}`);
      assert.deepEqual(collectDueWork(snap, cfg, t, nextTok).slotsToReset, []);
    }
    assert.equal(computeNextAlarmAt(snap, cfg, t0 + 1_790_000), t0 + 1_800_000);
    const v = verifySlotLease(snap, cfg, 1, lease, true, t0 + 1_800_000);
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.reason, "expired");
    assert.deepEqual(collectDueWork(snap, cfg, t0 + 1_800_000, nextTok).slotsToReset, [1]);
    assert.equal(snap.slots[0]!.state, "resetting");
    assert.equal(snap.slots[0]!.token, null);
  });
});

describe("per-IP caps (3 active + 1 queued)", () => {
  it("refuses a fourth active lease and a second queue entry from one prefix", () => {
    const cfg = testConfig({ slotCount: 4, maxSlotsPerIp: 3, maxQueuedPerIp: 1 });
    const t0 = 13_000_000;
    const snap = createInitialSnapshot(cfg, t0);
    const ip = ipPrefixKey("2001:db8:1:2::10");
    const sameNet = ipPrefixKey("2001:db8:1:2::99");
    for (let i = 0; i < 3; i++) assert.equal(enterPool(snap, cfg, t0, nextTok, nextQ, ip).kind, "assigned");
    const fourth = enterPool(snap, cfg, t0, nextTok, nextQ, sameNet);
    assert.deepEqual(fourth, { kind: "limited", reason: "active" });
    // another network still gets the last slot; then a full pool queues
    assert.equal(enterPool(snap, cfg, t0, nextTok, nextQ, ipPrefixKey("198.51.100.1")).kind, "assigned");
    const other = ipPrefixKey("198.51.100.2");
    assert.equal(enterPool(snap, cfg, t0, nextTok, nextQ, other).kind, "queued");
    assert.deepEqual(enterPool(snap, cfg, t0, nextTok, nextQ, other), { kind: "limited", reason: "queued" });
    // without a key (local development) nothing is capped
    assert.equal(enterPool(snap, cfg, t0, nextTok, nextQ, null).kind, "queued");
    assert.equal(enterPool(snap, cfg, t0, nextTok, nextQ, null).kind, "queued");
  });

  it("frees the prefix's place when a lease ends", () => {
    const cfg = testConfig({ slotCount: 2, maxSlotsPerIp: 1 });
    const t0 = 14_000_000;
    const snap = createInitialSnapshot(cfg, t0);
    const ip = ipPrefixKey("192.0.2.5");
    const r = enterPool(snap, cfg, t0, nextTok, nextQ, ip);
    assert.equal(r.kind, "assigned");
    const lease = claimOk(snap, cfg, r.slot, r.claimToken, t0);
    assert.equal(enterPool(snap, cfg, t0 + 1, nextTok, nextQ, ip).kind, "limited");
    assert.equal(releaseSlotLease(snap, r.slot, lease, t0 + 2), true);
    assert.equal(enterPool(snap, cfg, t0 + 3, nextTok, nextQ, ip).kind, "assigned");
  });
});

describe("maintenance kill switch, drain and reset of the pool state", () => {
  it("pauses due work, entry, claims and polling while on", () => {
    const cfg = testConfig({ slotCount: 2 });
    const t0 = 15_000_000;
    const snap = createInitialSnapshot(cfg, t0);
    const r = enterPool(snap, cfg, t0, nextTok, nextQ);
    assert.equal(r.kind, "assigned");
    assert.equal(setMaintenance(snap, true), true);
    assert.equal(setMaintenance(snap, true), false);
    assert.deepEqual(enterPool(snap, cfg, t0, nextTok, nextQ), { kind: "maintenance" });
    assert.equal(claimSlotLease(snap, cfg, r.slot, r.claimToken, t0 + 1, nextSecret).ok, false);
    assert.equal(pollQueue(snap, cfg, "q-x", t0, nextTok).kind, "gone");
    // runbot rotation and idle resets wait
    const due = collectDueWork(snap, cfg, t0 + 10 * cfg.runbotResetMs, nextTok);
    assert.deepEqual(due, { slotsToReset: [], runbotToRebuild: null, runbotSwapped: false });
    assert.equal(computeNextAlarmAt(snap, cfg, t0), t0 + 60_000);
    assert.equal(getPoolStatus(snap, cfg, t0).maintenance, true);
    assert.deepEqual(databasesToMeasure(snap), []);
  });

  it("drain revokes every lease and clears the queue; reset-pool-state needs maintenance", () => {
    const cfg = testConfig({ slotCount: 2 });
    const t0 = 16_000_000;
    const snap = createInitialSnapshot(cfg, t0);
    const r1 = enterPool(snap, cfg, t0, nextTok, nextQ);
    const r2 = enterPool(snap, cfg, t0, nextTok, nextQ);
    assert.equal(r1.kind, "assigned");
    assert.equal(r2.kind, "assigned");
    const l1 = claimOk(snap, cfg, r1.slot, r1.claimToken, t0);
    assert.equal(enterPool(snap, cfg, t0, nextTok, nextQ).kind, "queued");
    assert.equal(resetPoolState(snap, cfg, t0), false);

    const { drainedSlots } = drainPool(snap, t0 + 1_000);
    assert.deepEqual(drainedSlots, [1, 2]);
    assert.equal(snap.maintenance, true);
    assert.equal(snap.queue.length, 0);
    assert.equal(verifySlotLease(snap, cfg, r1.slot, l1, true, t0 + 1_001).ok, false);
    assert.ok(snap.slots.every((s) => s.state === "resetting" && s.token === null && s.claimToken === null));

    snap.runbot.rebuilding = "b";
    assert.equal(resetPoolState(snap, cfg, t0 + 2_000), true);
    assert.ok(snap.slots.every((s) => s.state === "ready" && s.resetStartedAt === null));
    assert.equal(snap.runbot.rebuilding, null);
    assert.equal(snap.runbot.nextResetAt, t0 + 2_000 + cfg.runbotResetMs);

    setMaintenance(snap, false);
    assert.equal(enterPool(snap, cfg, t0 + 3_000, nextTok, nextQ).kind, "assigned");
  });
});

describe("per-database size cap", () => {
  it("revokes and resets oversized leased slots and brings the Runbot swap forward", () => {
    const cfg = testConfig({ slotCount: 3, maxDbBytes: 1_000 });
    const t0 = 17_000_000;
    const snap = createInitialSnapshot(cfg, t0);
    for (let i = 0; i < 2; i++) assert.equal(enterPool(snap, cfg, t0, nextTok, nextQ).kind, "assigned");
    assert.deepEqual(databasesToMeasure(snap), ["demo_slot_1", "demo_slot_2", "demo_runbot_a"]);
    const sizes = new Map([["demo_slot_1", 999], ["demo_slot_2", 1_001], ["demo_slot_3", 5_000], ["demo_runbot_a", 2_000]]);
    const res = enforceDbSizeCap(snap, cfg, sizes, t0 + 10);
    assert.deepEqual(res, { slotsToReset: [2], runbotForced: true });
    assert.equal(snap.slots[0]!.state, "occupied");
    assert.equal(snap.slots[1]!.state, "resetting");
    assert.equal(snap.slots[2]!.state, "ready"); // a free slot is fresh from the template, not measured
    const due = collectDueWork(snap, cfg, t0 + 10, nextTok);
    assert.equal(due.runbotSwapped, true);
    assert.equal(due.runbotToRebuild, "a");
  });
});

describe("two-tier PDF quotas", () => {
  it("allows 15 per lease, restarts with a new lease, and stops at 200 per UTC day", () => {
    const cfg = testConfig({ slotCount: 2, pdfPerLease: 15, pdfPerDay: 200 });
    const t0 = Date.UTC(2026, 10, 24, 12, 0, 0);
    const snap = createInitialSnapshot(cfg, t0);
    const r = enterPool(snap, cfg, t0, nextTok, nextQ);
    assert.equal(r.kind, "assigned");
    // the claim nonce is no lease
    assert.deepEqual(consumePdfQuota(snap, cfg, { kind: "slot", index: r.slot, leaseSecret: r.claimToken }, t0), { ok: false, reason: "invalid" });
    const lease = claimOk(snap, cfg, r.slot, r.claimToken, t0);
    const target = { kind: "slot", index: r.slot, leaseSecret: lease } as const;
    for (let i = 0; i < 15; i++) assert.equal(consumePdfQuota(snap, cfg, target, t0 + i).ok, true);
    assert.deepEqual(consumePdfQuota(snap, cfg, target, t0 + 20), { ok: false, reason: "lease" });
    assert.deepEqual(consumePdfQuota(snap, cfg, { ...target, leaseSecret: "forged" }, t0), { ok: false, reason: "invalid" });
    // the Runbot only counts against the day
    for (let i = 15; i < 200; i++) assert.equal(consumePdfQuota(snap, cfg, { kind: "runbot" }, t0 + i).ok, true);
    assert.deepEqual(consumePdfQuota(snap, cfg, { kind: "runbot" }, t0 + 300), { ok: false, reason: "day" });
    // a new UTC day starts over
    const next = consumePdfQuota(snap, cfg, { kind: "runbot" }, t0 + 12 * 3_600_000);
    assert.deepEqual(next, { ok: true, leaseRemaining: null, dayRemaining: 199 });
    // maintenance refuses
    setMaintenance(snap, true);
    assert.deepEqual(consumePdfQuota(snap, cfg, { kind: "runbot" }, t0), { ok: false, reason: "maintenance" });
  });

  it("reads the quota target from the request-scoped env", () => {
    assert.deepEqual(pdfQuotaTarget({ DEMO_LEASE_SLOT: "runbot" }), { kind: "runbot" });
    assert.deepEqual(pdfQuotaTarget({ DEMO_LEASE_SLOT: "7", DEMO_LEASE_SECRET: "s" }), { kind: "slot", index: 7, leaseSecret: "s" });
    assert.equal(pdfQuotaTarget({ DEMO_LEASE_SLOT: "7", DEMO_LEASE_SECRET: "" }), null);
    assert.equal(pdfQuotaTarget({}), null);
    assert.equal(pdfQuotaTarget({ DEMO_LEASE_SLOT: "07", DEMO_LEASE_SECRET: "s" }), null);
  });
});

describe("forward-compatible snapshot load", () => {
  it("loads a snapshot written before the hardening and keeps working", () => {
    const cfg = testConfig({ slotCount: 3 });
    const t0 = 18_000_000;
    // the stored shape of the previous version: `token` used as nonce and cookie, no optional fields
    const legacy = JSON.parse(JSON.stringify({
      slots: [
        { index: 1, db: "demo_slot_1", state: "occupied", token: "old-cookie", leasedAt: t0, claimedAt: t0, lastActiveAt: t0, resetStartedAt: null, epoch: 4 },
        { index: 2, db: "demo_slot_2", state: "occupied", token: "old-unclaimed", leasedAt: t0, claimedAt: null, lastActiveAt: t0, resetStartedAt: null, epoch: 1 },
      ],
      queue: [{ id: "q-old", createdAt: t0, lastPollAt: t0 + 20_000, assignedSlot: null, assignedToken: null, assignedAt: null }],
      runbot: { active: "b", nextResetAt: t0 + 600_000, rebuilding: null, rebuildStartedAt: null, epoch: 9 },
    })) as PoolSnapshot;
    reconcileSlotCount(legacy, cfg);
    assert.equal(legacy.slots.length, 3);
    assert.equal(legacy.maintenance, false);
    assert.equal(legacy.slots[0]!.claimToken, null);
    assert.equal(legacy.slots[0]!.pdfCount, 0);
    assert.equal(legacy.queue[0]!.ipKey, null);
    assert.equal(legacy.runbot.epoch, 9);
    // an old unclaimed URL token can no longer be claimed; the slot comes back after the grace period
    assert.equal(claimSlotLease(legacy, cfg, 2, "old-unclaimed", t0 + 1_000, nextSecret).ok, false);
    collectDueWork(legacy, cfg, t0 + cfg.claimGraceMs, nextTok);
    assert.equal(legacy.slots[1]!.state, "occupied"); // promoted to the old queue waiter
    assert.equal(legacy.queue[0]!.assignedSlot, 2);
    // the old claimed lease still verifies by its secret and expires as usual
    assert.equal(verifySlotLease(legacy, cfg, 1, "old-cookie", false, t0 + 1_000).ok, true);
    assert.deepEqual(collectDueWork(legacy, cfg, t0 + cfg.idleMs, nextTok).slotsToReset, [1]);
  });
});

describe("demo-only NotPorted floor", () => {
  it("maps NotPorted to UserError only with DEMO_MODE=1 and never with LOCAL_DEV=1", () => {
    const e = new NotPorted("something");
    const mapped = demoNotPortedFloor({ DEMO_MODE: "1" }, e, "/web/dataset/call_kw");
    assert.ok(mapped instanceof UserError);
    assert.equal((mapped as UserError).message, DEMO_NOT_PORTED_MESSAGE);
    assert.equal(demoNotPortedFloor({}, e), e);
    assert.equal(demoNotPortedFloor({ DEMO_MODE: "0" }, e), e);
    assert.equal(demoNotPortedFloor({ DEMO_MODE: "1", LOCAL_DEV: "1" }, e), e);
    const other = new Error("boom");
    assert.equal(demoNotPortedFloor({ DEMO_MODE: "1" }, other), other);
  });
});
