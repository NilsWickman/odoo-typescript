/**
 * Pure state machine for the demo load balancer, private slot pool, FIFO queue, and shared Runbot A/B rotator.
 * No Cloudflare runtime imports so it runs directly under `npm test` (Node).
 */

export type SlotState = "ready" | "occupied" | "resetting";

export interface DemoSlot {
  /** 1-based slot number (`odoo-ts-1` .. `odoo-ts-N`). */
  readonly index: number;
  /** Postgres database name (`demo_slot_1` .. `demo_slot_N`). */
  readonly db: string;
  state: SlotState;
  /**
   * Lease cookie secret (`__Host-odoo_demo_lease`), minted fresh when the claim nonce is burned; null until claimed and
   * when not occupied. Never appears in a URL.
   */
  token: string | null;
  /**
   * Single-use URL claim nonce (`/__demo/claim?t=`), set while an assigned lease waits to be claimed and burned by the
   * claim. Optional: snapshots written before it existed load as "no nonce".
   */
  claimToken?: string | null;
  /** Per-IP prefix key of the visitor holding the lease (`ipPrefixKey`); optional for older snapshots. */
  ipKey?: string | null;
  /** PDFs rendered under the current lease (reset on every claim); optional for older snapshots. */
  pdfCount?: number;
  /** Timestamp (ms) when the lease was assigned. */
  leasedAt: number | null;
  /** Timestamp (ms) when the lease cookie was actually claimed on the slot host (null until `/__demo/claim`). */
  claimedAt: number | null;
  /** Last real user HTTP activity timestamp (ms). */
  lastActiveAt: number | null;
  /** Timestamp (ms) when reset started (for retry/recovery if a reset stalls). */
  resetStartedAt: number | null;
  /** Incrementing epoch per reset, useful for diagnostics. */
  epoch: number;
}

export interface QueueWaiter {
  readonly id: string;
  readonly createdAt: number;
  lastPollAt: number;
  assignedSlot: number | null;
  /** The claim nonce of the assigned slot (`DemoSlot.claimToken`), handed to the waiter's browser. */
  assignedToken: string | null;
  assignedAt: number | null;
  /** Per-IP prefix key of the waiter (`ipPrefixKey`); optional for older snapshots. */
  ipKey?: string | null;
}

export interface RunbotState {
  active: "a" | "b";
  /** Timestamp (ms) of the next scheduled A/B swap. */
  nextResetAt: number;
  /** Side currently being rebuilt in the background, or null when standby is warm and ready. */
  rebuilding: "a" | "b" | null;
  /** Timestamp (ms) when rebuild started. */
  rebuildStartedAt: number | null;
  /** Incrementing epoch per swap. */
  epoch: number;
}

export interface DemoConfig {
  readonly baseDomain: string;
  readonly launcherHost: string;
  readonly runbotHost: string;
  readonly slotPrefix: string;
  readonly slotCount: number;
  /** Private slot inactivity timeout in ms (default 60_000 = 1 min). */
  readonly idleMs: number;
  /** Shared Runbot reset interval in ms (default 600_000 = 10 min). */
  readonly runbotResetMs: number;
  /** Time (ms) an unassigned queue waiter may go without polling before being pruned (default 20_000). */
  readonly queueStaleMs: number;
  /** Grace period (ms) to claim an assigned slot via `/__demo/claim` before releasing it (default 25_000). */
  readonly claimGraceMs: number;
  /** Retry window (ms) if a Postgres reset stalled or crashed mid-flight (default 60_000). */
  readonly resetRetryMs: number;
  /** Hard absolute lease cap (ms) from the claim, whatever the activity (`DEMO_MAX_LEASE_MS`, default 30 min). */
  readonly maxLeaseMs: number;
  /** Active leases one IPv4 /32 or IPv6 /64 may hold at once (`DEMO_MAX_SLOTS_PER_IP`, default 3). */
  readonly maxSlotsPerIp: number;
  /** Unassigned queue entries one IP prefix may hold at once (default 1). */
  readonly maxQueuedPerIp: number;
  /** `pg_database_size` cap of one demo database (`DEMO_MAX_DB_BYTES`, default 256 MiB). */
  readonly maxDbBytes: number;
  /** PDFs one lease may render (default 15). */
  readonly pdfPerLease: number;
  /** PDFs the whole demo may render per UTC day (default 200). */
  readonly pdfPerDay: number;
}

export interface PoolSnapshot {
  slots: DemoSlot[];
  queue: QueueWaiter[];
  runbot: RunbotState;
  /**
   * Operator kill switch (`POST /__demo/admin/maintenance|drain`): no background resets, launcher/Runbot/slots answer
   * 503. Optional so snapshots written before it load unchanged (absent = false).
   */
  maintenance?: boolean;
  /** Global PDF counter of the current UTC day (`YYYY-MM-DD`); optional for older snapshots. */
  pdfDay?: { day: string; count: number };
}

export type DemoHostTarget =
  | { readonly kind: "launcher" }
  | { readonly kind: "runbot" }
  | { readonly kind: "slot"; readonly index: number; readonly host: string }
  | { readonly kind: "unknown" };

export const DEFAULT_DEMO_CONFIG: DemoConfig = {
  baseDomain: "example.com",
  launcherHost: "odoo-ts-demo.example.com",
  runbotHost: "odoo-ts-runbot.example.com",
  slotPrefix: "odoo-ts-",
  slotCount: 50,
  idleMs: 60_000,
  runbotResetMs: 600_000,
  queueStaleMs: 20_000,
  claimGraceMs: 25_000,
  resetRetryMs: 60_000,
  maxLeaseMs: 1_800_000,
  maxSlotsPerIp: 3,
  maxQueuedPerIp: 1,
  maxDbBytes: 268_435_456,
  pdfPerLease: 15,
  pdfPerDay: 200,
};

export function slotDbName(index: number): string {
  return `demo_slot_${index}`;
}

export function runbotDbName(side: "a" | "b"): string {
  return side === "a" ? "demo_runbot_a" : "demo_runbot_b";
}

export function slotHostname(index: number, cfg: Pick<DemoConfig, "slotPrefix" | "baseDomain">): string {
  return `${cfg.slotPrefix}${index}.${cfg.baseDomain}`;
}

/**
 * Classify the incoming Host header against the demo configuration.
 * Only exact launcher, exact runbot, or `<slotPrefix><1..slotCount>.<baseDomain>` match.
 */
export function parseDemoHost(rawHost: string, cfg: DemoConfig): DemoHostTarget {
  const host = rawHost.toLowerCase().split(":")[0]!;
  if (host === cfg.launcherHost.toLowerCase()) return { kind: "launcher" };
  if (host === cfg.runbotHost.toLowerCase()) return { kind: "runbot" };
  const suffix = `.${cfg.baseDomain.toLowerCase()}`;
  const prefix = cfg.slotPrefix.toLowerCase();
  if (!host.endsWith(suffix)) return { kind: "unknown" };
  const label = host.slice(0, -suffix.length);
  if (label.includes(".") || !label.startsWith(prefix)) return { kind: "unknown" };
  const numStr = label.slice(prefix.length);
  if (!/^[1-9][0-9]*$/.test(numStr)) return { kind: "unknown" };
  const index = Number(numStr);
  if (!Number.isSafeInteger(index) || index < 1 || index > cfg.slotCount) return { kind: "unknown" };
  return { kind: "slot", index, host };
}

/**
 * Whether an HTTP request on a private demo slot counts as active user interaction that resets the
 * 1-minute inactivity timer. Background WebSockets, bus polling, static assets, and demo control
 * endpoints do NOT keep an idle tab alive forever.
 */
export function isUserActivityRequest(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  if (m === "HEAD" || m === "OPTIONS") return false;
  if (pathname === "/websocket" || pathname.startsWith("/bus/") || pathname.startsWith("/longpolling")) return false;
  if (pathname.startsWith("/__demo/")) return false;
  if (pathname === "/favicon.ico" || pathname === "/robots.txt" || pathname === "/health") return false;
  if (pathname.startsWith("/web/assets/") || pathname.startsWith("/web/static/")) return false;
  if (pathname.startsWith("/web/image/") || pathname.startsWith("/web/binary/")) return false;
  // Service worker & manifest background checks
  if (pathname === "/odoo/service-worker.js" || pathname === "/web/manifest.webmanifest") return false;
  return true;
}

/**
 * Constant-time string comparison for bearer secrets (lease cookie, claim nonce, admin and bypass tokens): the time
 * depends only on the longer length, never on where the first difference is.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diff === 0;
}

function parseIPv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/**
 * The per-IP cap key of a `CF-Connecting-IP` value: the whole address for IPv4 (`/32`, also for IPv4-mapped IPv6),
 * the first four hextets for IPv6 (`/64`, one customer's usual allocation). Null for a missing or unparseable value
 * (local development without Cloudflare in front): no per-IP cap applies then.
 */
export function ipPrefixKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const ip = raw.trim();
  const v4 = parseIPv4(ip);
  if (v4) return `v4:${v4.join(".")}`;
  if (!ip.includes(":")) return null;
  let s = ip.split("%")[0]!.toLowerCase();
  const tail4 = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (tail4) {
    const p = parseIPv4(tail4[2]!);
    if (!p) return null;
    s = `${tail4[1]}${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + tail.length > 7) return null;
  const groups = [...head, ...new Array<string>(8 - head.length - tail.length).fill("0"), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const n = groups.map((g) => parseInt(g, 16));
  if (n.slice(0, 5).every((x) => x === 0) && n[5] === 0xffff) {
    return `v4:${n[6]! >> 8}.${n[6]! & 255}.${n[7]! >> 8}.${n[7]! & 255}`;
  }
  return `v6:${n.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

function freshSlot(index: number): DemoSlot {
  return {
    index,
    db: slotDbName(index),
    state: "ready",
    token: null,
    claimToken: null,
    ipKey: null,
    pdfCount: 0,
    leasedAt: null,
    claimedAt: null,
    lastActiveAt: null,
    resetStartedAt: null,
    epoch: 1,
  };
}

/** Drop every lease field of a slot (the caller sets the new state). */
function clearLease(slot: DemoSlot): void {
  slot.token = null;
  slot.claimToken = null;
  slot.ipKey = null;
  slot.pdfCount = 0;
  slot.leasedAt = null;
  slot.claimedAt = null;
  slot.lastActiveAt = null;
}

function assignSlot(slot: DemoSlot, now: number, claimToken: string, ipKey: string | null): void {
  slot.state = "occupied";
  slot.token = null;
  slot.claimToken = claimToken;
  slot.ipKey = ipKey;
  slot.pdfCount = 0;
  slot.leasedAt = now;
  slot.claimedAt = null;
  slot.lastActiveAt = now;
}

/** When a claimed lease ends: idle timeout or the hard cap from the claim, whichever comes first. */
function claimedLeaseEndsAt(slot: DemoSlot, cfg: DemoConfig): number | null {
  if (slot.claimedAt === null) return null;
  const idleEnd = slot.lastActiveAt !== null ? slot.lastActiveAt + cfg.idleMs : Infinity;
  return Math.min(idleEnd, slot.claimedAt + cfg.maxLeaseMs);
}

export function createInitialSnapshot(cfg: DemoConfig, now: number): PoolSnapshot {
  const slots: DemoSlot[] = [];
  for (let i = 1; i <= cfg.slotCount; i++) slots.push(freshSlot(i));
  return {
    slots,
    queue: [],
    runbot: {
      active: "a",
      nextResetAt: now + cfg.runbotResetMs,
      rebuilding: null,
      rebuildStartedAt: null,
      epoch: 1,
    },
    maintenance: false,
  };
}

/**
 * Fill the optional fields a snapshot written by an older version lacks (claim nonce, IP key, PDF counters,
 * maintenance flag). Unknown fields are kept, so a rollback to the older version still reads what this one wrote.
 */
export function normalizeSnapshot(snap: PoolSnapshot): void {
  for (const s of snap.slots) {
    s.claimToken ??= null;
    s.ipKey ??= null;
    s.pdfCount ??= 0;
  }
  for (const w of snap.queue) w.ipKey ??= null;
  snap.maintenance ??= false;
}

/** Reconcile persisted snapshot with current slotCount (supports scaling DEMO_SLOTS up or down). */
export function reconcileSlotCount(snap: PoolSnapshot, cfg: DemoConfig): void {
  normalizeSnapshot(snap);
  const byIndex = new Map(snap.slots.map((s) => [s.index, s]));
  const next: DemoSlot[] = [];
  for (let i = 1; i <= cfg.slotCount; i++) next.push(byIndex.get(i) ?? freshSlot(i));
  snap.slots = next;
}

export type EnterResult =
  | { readonly kind: "assigned"; readonly slot: number; readonly claimToken: string; readonly host: string }
  | {
      readonly kind: "queued";
      readonly queueId: string;
      readonly position: number;
      readonly totalWaiting: number;
      readonly nextFreeInMs: number | null;
    }
  | { readonly kind: "limited"; readonly reason: "active" | "queued" }
  | { readonly kind: "maintenance" };

export type PollResult =
  | { readonly kind: "assigned"; readonly slot: number; readonly claimToken: string; readonly host: string }
  | {
      readonly kind: "queued";
      readonly position: number;
      readonly totalWaiting: number;
      readonly freeSlots: number;
      readonly totalSlots: number;
      readonly nextFreeInMs: number | null;
    }
  | { readonly kind: "gone" };

export type ClaimResult =
  | { readonly ok: true; readonly db: string; readonly leaseSecret: string }
  | { readonly ok: false };

export interface PoolStatus {
  readonly totalSlots: number;
  readonly freeSlots: number;
  readonly occupiedSlots: number;
  readonly resettingSlots: number;
  readonly queueLength: number;
  readonly nextFreeInMs: number | null;
  readonly idleMs: number;
  readonly runbotResetMs: number;
  readonly runbotNextResetAt: number;
  readonly runbotNextResetInMs: number;
  readonly runbotHost: string;
  readonly maintenance: boolean;
}

export interface DueWork {
  readonly slotsToReset: number[];
  readonly runbotToRebuild: "a" | "b" | null;
  readonly runbotSwapped: boolean;
}

function estimateNextFreeInMs(snap: PoolSnapshot, cfg: DemoConfig, now: number): number | null {
  if (snap.slots.some((s) => s.state === "ready")) return 0;
  let earliest = Infinity;
  for (const s of snap.slots) {
    if (s.state === "resetting") {
      // A DB clone on VPS takes ~2-4 seconds
      earliest = Math.min(earliest, now + 3_000);
    } else if (s.state === "occupied") {
      if (s.claimedAt === null && s.leasedAt !== null) {
        earliest = Math.min(earliest, s.leasedAt + cfg.claimGraceMs);
      } else {
        const end = claimedLeaseEndsAt(s, cfg);
        if (end !== null) earliest = Math.min(earliest, end);
      }
    }
  }
  return Number.isFinite(earliest) ? Math.max(0, earliest - now) : null;
}

/** Occupied slots (assigned or claimed) held by one IP prefix. */
function activeLeasesOf(snap: PoolSnapshot, ipKey: string): number {
  return snap.slots.filter((s) => s.state === "occupied" && s.ipKey === ipKey).length;
}

/** Prune stale unassigned waiters and unclaimed expired slot leases, then promote waiters into ready slots. */
export function pruneAndPromote(snap: PoolSnapshot, cfg: DemoConfig, now: number, makeToken: () => string): boolean {
  if (snap.maintenance === true) return false;
  let changed = false;

  // 1. Revoke leases that were assigned but never claimed within claimGraceMs (the user closed the tab before redirect)
  for (const s of snap.slots) {
    if (s.state === "occupied" && s.claimedAt === null && s.leasedAt !== null && now - s.leasedAt >= cfg.claimGraceMs) {
      // Nobody ever logged in or touched the DB — safe to return directly to "ready" without a Postgres clone!
      s.state = "ready";
      clearLease(s);
      changed = true;
    }
  }

  // 2. Prune dead queue waiters (unassigned and no poll for queueStaleMs, or assigned whose lease was revoked)
  const kept: QueueWaiter[] = [];
  for (const w of snap.queue) {
    if (w.assignedSlot !== null) {
      const slot = snap.slots[w.assignedSlot - 1];
      const stillValid =
        slot !== undefined &&
        slot.state === "occupied" &&
        slot.claimToken != null &&
        w.assignedToken !== null &&
        slot.claimToken === w.assignedToken;
      if (stillValid && w.assignedAt !== null && now - w.assignedAt < cfg.claimGraceMs) {
        kept.push(w);
      } else {
        changed = true;
      }
    } else if (now - w.lastPollAt < cfg.queueStaleMs) {
      kept.push(w);
    } else {
      changed = true;
    }
  }
  snap.queue = kept;

  // 3. Promote waiting FIFO entries into any ready slots (a waiter whose prefix is at its active cap waits its turn)
  for (const w of snap.queue) {
    if (w.assignedSlot !== null) continue;
    const ready = snap.slots.find((s) => s.state === "ready");
    if (!ready) break;
    const ipKey = w.ipKey ?? null;
    if (ipKey !== null && activeLeasesOf(snap, ipKey) >= cfg.maxSlotsPerIp) continue;
    const claimToken = makeToken();
    assignSlot(ready, now, claimToken, ipKey);
    w.assignedSlot = ready.index;
    w.assignedToken = claimToken;
    w.assignedAt = now;
    changed = true;
  }

  return changed;
}

/**
 * Request entry from the launcher: assigns a free slot immediately (with a single-use claim nonce) or places the
 * visitor in the FIFO queue. `ipKey` (`ipPrefixKey`) caps active leases and queue entries per IP prefix.
 */
export function enterPool(
  snap: PoolSnapshot,
  cfg: DemoConfig,
  now: number,
  makeToken: () => string,
  makeQueueId: () => string,
  ipKey: string | null = null,
): EnterResult {
  if (snap.maintenance === true) return { kind: "maintenance" };
  pruneAndPromote(snap, cfg, now, makeToken);
  if (ipKey !== null && activeLeasesOf(snap, ipKey) >= cfg.maxSlotsPerIp) return { kind: "limited", reason: "active" };
  const hasWaiting = snap.queue.some((w) => w.assignedSlot === null);
  const ready = hasWaiting ? undefined : snap.slots.find((s) => s.state === "ready");
  if (ready !== undefined) {
    const claimToken = makeToken();
    assignSlot(ready, now, claimToken, ipKey);
    return { kind: "assigned", slot: ready.index, claimToken, host: slotHostname(ready.index, cfg) };
  }
  if (ipKey !== null) {
    const queued = snap.queue.filter((w) => w.assignedSlot === null && w.ipKey === ipKey).length;
    if (queued >= cfg.maxQueuedPerIp) return { kind: "limited", reason: "queued" };
  }
  const queueId = makeQueueId();
  snap.queue.push({
    id: queueId,
    createdAt: now,
    lastPollAt: now,
    assignedSlot: null,
    assignedToken: null,
    assignedAt: null,
    ipKey,
  });
  const unassigned = snap.queue.filter((w) => w.assignedSlot === null);
  return {
    kind: "queued",
    queueId,
    position: unassigned.length,
    totalWaiting: unassigned.length,
    nextFreeInMs: estimateNextFreeInMs(snap, cfg, now),
  };
}

/** Poll queue status (heartbeat + assignment check). */
export function pollQueue(
  snap: PoolSnapshot,
  cfg: DemoConfig,
  queueId: string,
  now: number,
  makeToken: () => string,
): PollResult {
  if (snap.maintenance === true) return { kind: "gone" };
  const existing = snap.queue.find((w) => w.id === queueId);
  if (existing !== undefined) {
    existing.lastPollAt = now;
  }
  pruneAndPromote(snap, cfg, now, makeToken);

  const waiter = snap.queue.find((w) => w.id === queueId);
  if (!waiter) return { kind: "gone" };
  if (waiter.assignedSlot !== null && waiter.assignedToken !== null) {
    return {
      kind: "assigned",
      slot: waiter.assignedSlot,
      claimToken: waiter.assignedToken,
      host: slotHostname(waiter.assignedSlot, cfg),
    };
  }
  const unassigned = snap.queue.filter((w) => w.assignedSlot === null);
  const pos = unassigned.findIndex((w) => w.id === queueId) + 1;
  return {
    kind: "queued",
    position: Math.max(1, pos),
    totalWaiting: unassigned.length,
    freeSlots: snap.slots.filter((s) => s.state === "ready").length,
    totalSlots: snap.slots.length,
    nextFreeInMs: estimateNextFreeInMs(snap, cfg, now),
  };
}

/**
 * Claim a lease on `/__demo/claim?t=<claimToken>`: burns the single-use URL nonce, mints a fresh lease secret for the
 * `__Host-odoo_demo_lease` cookie, marks claimedAt (start of the hard lease cap) and removes the matching queue record.
 */
export function claimSlotLease(
  snap: PoolSnapshot,
  cfg: DemoConfig,
  slotIndex: number,
  claimToken: string,
  now: number,
  makeSecret: () => string,
): ClaimResult {
  if (snap.maintenance === true || !claimToken) return { ok: false };
  const slot = snap.slots[slotIndex - 1];
  if (!slot || slot.state !== "occupied" || slot.claimToken == null || !constantTimeEqual(slot.claimToken, claimToken)) {
    return { ok: false };
  }
  if (slot.leasedAt !== null && now - slot.leasedAt >= cfg.claimGraceMs) {
    slot.state = "ready";
    clearLease(slot);
    return { ok: false };
  }
  const leaseSecret = makeSecret();
  slot.claimToken = null;
  slot.token = leaseSecret;
  slot.claimedAt = now;
  slot.lastActiveAt = now;
  slot.pdfCount = 0;
  snap.queue = snap.queue.filter((w) => !(w.assignedSlot === slotIndex && w.assignedToken === claimToken));
  return { ok: true, db: slot.db, leaseSecret };
}

function leaseMatches(slot: DemoSlot | undefined, leaseSecret: string | null): slot is DemoSlot {
  return (
    slot !== undefined &&
    slot.state === "occupied" &&
    slot.token !== null &&
    leaseSecret !== null &&
    leaseSecret !== "" &&
    constantTimeEqual(slot.token, leaseSecret)
  );
}

/** Verify lease cookie on a private slot request and optionally record user activity. */
export function verifySlotLease(
  snap: PoolSnapshot,
  cfg: DemoConfig,
  slotIndex: number,
  token: string | null,
  isUserActivity: boolean,
  now: number,
):
  | { readonly ok: true; readonly db: string; readonly idleRemainingMs: number; readonly touched: boolean }
  | { readonly ok: false; readonly reason: "missing" | "expired" | "mismatch" } {
  if (!token) return { ok: false, reason: "missing" };
  const slot = snap.slots[slotIndex - 1];
  if (!leaseMatches(slot, token)) return { ok: false, reason: "mismatch" };
  const last = slot.lastActiveAt ?? slot.leasedAt ?? now;
  if (now - last >= cfg.idleMs) {
    return { ok: false, reason: "expired" };
  }
  if (slot.claimedAt !== null && now - slot.claimedAt >= cfg.maxLeaseMs) {
    return { ok: false, reason: "expired" };
  }
  let touched = false;
  if (isUserActivity) {
    // Only mark state dirty when lastActiveAt moves by >= 1s (saves SQLite writes on rapid bursts)
    if (now - last >= 1_000) {
      slot.lastActiveAt = now;
      touched = true;
    }
  }
  const effectiveLast = slot.lastActiveAt ?? last;
  return {
    ok: true,
    db: slot.db,
    idleRemainingMs: Math.max(0, cfg.idleMs - (now - effectiveLast)),
    touched,
  };
}

/** Manually release a slot and transition it to resetting. */
export function releaseSlotLease(
  snap: PoolSnapshot,
  slotIndex: number,
  token: string,
  now: number,
): boolean {
  const slot = snap.slots[slotIndex - 1];
  if (!leaseMatches(slot, token)) return false;
  slot.state = "resetting";
  clearLease(slot);
  slot.resetStartedAt = now;
  return true;
}

/**
 * Inspect timers and return any due slot resets and/or Runbot A/B swap + rebuild work.
 * Transitions expired slots (idle, or past the hard lease cap) to `"resetting"` immediately so no request can use
 * them while resetting. Nothing is due while the pool is in maintenance.
 */
export function collectDueWork(
  snap: PoolSnapshot,
  cfg: DemoConfig,
  now: number,
  makeToken: () => string,
): DueWork {
  if (snap.maintenance === true) return { slotsToReset: [], runbotToRebuild: null, runbotSwapped: false };
  pruneAndPromote(snap, cfg, now, makeToken);

  const slotsToReset: number[] = [];
  for (const s of snap.slots) {
    const end = s.state === "occupied" ? claimedLeaseEndsAt(s, cfg) : null;
    if (end !== null && now >= end) {
      s.state = "resetting";
      clearLease(s);
      s.resetStartedAt = now;
      slotsToReset.push(s.index);
    } else if (s.state === "resetting" && (s.resetStartedAt === null || now - s.resetStartedAt >= cfg.resetRetryMs)) {
      s.resetStartedAt = now;
      slotsToReset.push(s.index);
    }
  }

  let runbotSwapped = false;
  let runbotToRebuild: "a" | "b" | null = null;
  if (now >= snap.runbot.nextResetAt && snap.runbot.rebuilding === null) {
    const oldActive = snap.runbot.active;
    snap.runbot.active = oldActive === "a" ? "b" : "a";
    snap.runbot.epoch += 1;
    snap.runbot.nextResetAt = now + cfg.runbotResetMs;
    snap.runbot.rebuilding = oldActive;
    snap.runbot.rebuildStartedAt = now;
    runbotSwapped = true;
    runbotToRebuild = oldActive;
  } else if (
    snap.runbot.rebuilding !== null &&
    (snap.runbot.rebuildStartedAt === null || now - snap.runbot.rebuildStartedAt >= cfg.resetRetryMs)
  ) {
    snap.runbot.rebuildStartedAt = now;
    runbotToRebuild = snap.runbot.rebuilding;
  }

  return { slotsToReset, runbotToRebuild, runbotSwapped };
}

export function finishSlotReset(
  snap: PoolSnapshot,
  cfg: DemoConfig,
  slotIndex: number,
  ok: boolean,
  now: number,
  makeToken: () => string,
): void {
  const slot = snap.slots[slotIndex - 1];
  if (!slot) return;
  if (ok) {
    slot.state = "ready";
    slot.resetStartedAt = null;
    slot.epoch += 1;
    pruneAndPromote(snap, cfg, now, makeToken);
  } else {
    // Keep in "resetting" and allow alarm retry after resetRetryMs (or sooner on next tick)
    slot.resetStartedAt = now - cfg.resetRetryMs + 10_000;
  }
}

export function finishRunbotRebuild(snap: PoolSnapshot, cfg: DemoConfig, side: "a" | "b", ok: boolean, now: number): void {
  if (snap.runbot.rebuilding !== side) return;
  if (ok) {
    snap.runbot.rebuilding = null;
    snap.runbot.rebuildStartedAt = null;
  } else {
    snap.runbot.rebuildStartedAt = now - cfg.resetRetryMs + 10_000;
  }
}

/** The databases whose `pg_database_size` the cron tick measures: every leased slot and the live Runbot side. */
export function databasesToMeasure(snap: PoolSnapshot): string[] {
  if (snap.maintenance === true) return [];
  const dbs = snap.slots.filter((s) => s.state === "occupied").map((s) => s.db);
  dbs.push(runbotDbName(snap.runbot.active));
  return dbs;
}

/**
 * Per-database size cap: a leased slot whose database grew past `maxDbBytes` loses its lease at once and is queued for
 * a reset; an oversized live Runbot side is swapped on the next due-work pass (its rotation is brought forward).
 */
export function enforceDbSizeCap(
  snap: PoolSnapshot,
  cfg: DemoConfig,
  sizes: ReadonlyMap<string, number>,
  now: number,
): { readonly slotsToReset: number[]; readonly runbotForced: boolean } {
  if (snap.maintenance === true) return { slotsToReset: [], runbotForced: false };
  const slotsToReset: number[] = [];
  for (const s of snap.slots) {
    const size = sizes.get(s.db);
    if (s.state === "occupied" && size !== undefined && size > cfg.maxDbBytes) {
      s.state = "resetting";
      clearLease(s);
      s.resetStartedAt = now;
      slotsToReset.push(s.index);
    }
  }
  let runbotForced = false;
  const runbotSize = sizes.get(runbotDbName(snap.runbot.active));
  if (runbotSize !== undefined && runbotSize > cfg.maxDbBytes && snap.runbot.rebuilding === null && snap.runbot.nextResetAt > now) {
    snap.runbot.nextResetAt = now;
    runbotForced = true;
  }
  return { slotsToReset, runbotForced };
}

/** Turn the operator kill switch on or off; true when it changed. */
export function setMaintenance(snap: PoolSnapshot, enabled: boolean): boolean {
  const was = snap.maintenance === true;
  snap.maintenance = enabled;
  return was !== enabled;
}

/**
 * `POST /__demo/admin/drain`: maintenance on, every lease revoked (its slot left "resetting", to be rebuilt or put
 * back by `resetPoolState`), the queue emptied. Returns the slots whose lease was revoked.
 */
export function drainPool(snap: PoolSnapshot, now: number): { readonly drainedSlots: number[] } {
  snap.maintenance = true;
  const drainedSlots: number[] = [];
  for (const s of snap.slots) {
    if (s.state === "occupied") {
      s.state = "resetting";
      clearLease(s);
      s.resetStartedAt = now;
      drainedSlots.push(s.index);
    }
  }
  snap.queue = [];
  return { drainedSlots };
}

/**
 * `POST /__demo/admin/reset-pool-state`, only while in maintenance (the operator has rebuilt the databases): every
 * slot back to "ready" without a lease, the Runbot idle with a full rotation ahead, the queue empty.
 */
export function resetPoolState(snap: PoolSnapshot, cfg: DemoConfig, now: number): boolean {
  if (snap.maintenance !== true) return false;
  for (const s of snap.slots) {
    s.state = "ready";
    clearLease(s);
    s.resetStartedAt = null;
    s.epoch += 1;
  }
  snap.queue = [];
  snap.runbot.rebuilding = null;
  snap.runbot.rebuildStartedAt = null;
  snap.runbot.nextResetAt = now + cfg.runbotResetMs;
  snap.runbot.epoch += 1;
  return true;
}

export type PdfQuotaTarget =
  | { readonly kind: "slot"; readonly index: number; readonly leaseSecret: string }
  | { readonly kind: "runbot" };

export type PdfQuotaResult =
  | { readonly ok: true; readonly leaseRemaining: number | null; readonly dayRemaining: number }
  | { readonly ok: false; readonly reason: "lease" | "day" | "invalid" | "maintenance" };

/** UTC calendar day of a timestamp, the global PDF counter's key. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Two-tier PDF quota, counted only when a PDF is about to be rendered: `pdfPerLease` per lease (slot plus lease
 * secret; the Runbot has no lease) and `pdfPerDay` for the whole demo per UTC day. Consumes one unit when allowed.
 */
export function consumePdfQuota(snap: PoolSnapshot, cfg: DemoConfig, target: PdfQuotaTarget, now: number): PdfQuotaResult {
  if (snap.maintenance === true) return { ok: false, reason: "maintenance" };
  const day = utcDay(now);
  if (!snap.pdfDay || snap.pdfDay.day !== day) snap.pdfDay = { day, count: 0 };
  let slot: DemoSlot | null = null;
  if (target.kind === "slot") {
    const s = snap.slots[target.index - 1];
    if (!leaseMatches(s, target.leaseSecret)) return { ok: false, reason: "invalid" };
    if ((s.pdfCount ?? 0) >= cfg.pdfPerLease) return { ok: false, reason: "lease" };
    slot = s;
  }
  if (snap.pdfDay.count >= cfg.pdfPerDay) return { ok: false, reason: "day" };
  snap.pdfDay.count += 1;
  if (slot !== null) slot.pdfCount = (slot.pdfCount ?? 0) + 1;
  return {
    ok: true,
    leaseRemaining: slot !== null ? cfg.pdfPerLease - (slot.pdfCount ?? 0) : null,
    dayRemaining: cfg.pdfPerDay - snap.pdfDay.count,
  };
}

export function getPoolStatus(snap: PoolSnapshot, cfg: DemoConfig, now: number): PoolStatus {
  let freeSlots = 0;
  let occupiedSlots = 0;
  let resettingSlots = 0;
  for (const s of snap.slots) {
    if (s.state === "ready") freeSlots++;
    else if (s.state === "occupied") occupiedSlots++;
    else resettingSlots++;
  }
  const queueLength = snap.queue.filter((w) => w.assignedSlot === null).length;
  return {
    totalSlots: snap.slots.length,
    freeSlots,
    occupiedSlots,
    resettingSlots,
    queueLength,
    nextFreeInMs: estimateNextFreeInMs(snap, cfg, now),
    idleMs: cfg.idleMs,
    runbotResetMs: cfg.runbotResetMs,
    runbotNextResetAt: snap.runbot.nextResetAt,
    runbotNextResetInMs: Math.max(0, snap.runbot.nextResetAt - now),
    runbotHost: cfg.runbotHost,
    maintenance: snap.maintenance === true,
  };
}

/** Compute the earliest timestamp (ms) when the Durable Object alarm should wake up next. */
export function computeNextAlarmAt(snap: PoolSnapshot, cfg: DemoConfig, now: number): number {
  // In maintenance nothing is due; a slow heartbeat keeps the alarm registered for when it is lifted.
  if (snap.maintenance === true) return now + 60_000;
  let earliest = snap.runbot.nextResetAt;
  if (snap.runbot.rebuilding !== null && snap.runbot.rebuildStartedAt !== null) {
    earliest = Math.min(earliest, snap.runbot.rebuildStartedAt + cfg.resetRetryMs);
  }
  for (const s of snap.slots) {
    if (s.state === "occupied") {
      if (s.claimedAt === null && s.leasedAt !== null) {
        earliest = Math.min(earliest, s.leasedAt + cfg.claimGraceMs);
      } else {
        const end = claimedLeaseEndsAt(s, cfg);
        if (end !== null) earliest = Math.min(earliest, end);
      }
    } else if (s.state === "resetting" && s.resetStartedAt !== null) {
      earliest = Math.min(earliest, s.resetStartedAt + cfg.resetRetryMs);
    }
  }
  for (const w of snap.queue) {
    if (w.assignedSlot === null) {
      earliest = Math.min(earliest, w.lastPollAt + cfg.queueStaleMs);
    } else if (w.assignedAt !== null) {
      earliest = Math.min(earliest, w.assignedAt + cfg.claimGraceMs);
    }
  }
  // Never schedule in the past; minimum 1s debounce
  return Math.max(now + 1_000, earliest);
}
