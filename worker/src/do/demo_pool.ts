/**
 * Durable Object (`DemoPool`) managing:
 *  - Dedicated private demo slots (`odoo-ts-1` .. `odoo-ts-N`, 1-minute inactivity reset)
 *  - FIFO queue when all private slots are occupied (with stale waiter pruning & instant promotion)
 *  - Shared Runbot (`odoo-ts-runbot`, 10-minute A/B blue-green rotation with zero downtime)
 *  - Serialized Postgres DROP/CREATE DATABASE ... TEMPLATE resets over `PG_NET` + Filestore/Bus resets
 *  - Hardening: hard lease cap, per-IP caps, per-database size cap (cron tick), PDF quotas, maintenance/drain.
 *
 * State stays one KV value (`pool_state_v1`); every new field is optional, so no storage migration and a rollback
 * to the previous version still loads the snapshot.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { withAdminClient } from "../db";
import {
  claimSlotLease,
  collectDueWork,
  consumePdfQuota,
  databasesToMeasure,
  drainPool,
  enforceDbSizeCap,
  computeNextAlarmAt,
  createInitialSnapshot,
  DEFAULT_DEMO_CONFIG,
  enterPool,
  finishRunbotRebuild,
  finishSlotReset,
  getPoolStatus,
  pollQueue,
  reconcileSlotCount,
  releaseSlotLease,
  resetPoolState,
  runbotDbName,
  setMaintenance,
  slotDbName,
  slotHostname,
  verifySlotLease,
  type ClaimResult,
  type DemoConfig,
  type EnterResult,
  type PdfQuotaResult,
  type PdfQuotaTarget,
  type PollResult,
  type PoolSnapshot,
  type PoolStatus,
} from "../demo/pool_logic";

const STATE_KEY = "pool_state_v1";
const DB_IDENT_RE = /^[a-z][a-z0-9_]{0,62}$/;

function assertIdent(name: string): string {
  if (!DB_IDENT_RE.test(name)) throw new Error(`unsafe SQL identifier: ${name}`);
  return name;
}

function posInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
}

export function demoConfigFromEnv(env: Env): DemoConfig {
  const baseDomain = env.DEMO_BASE_DOMAIN || DEFAULT_DEMO_CONFIG.baseDomain;
  return {
    baseDomain,
    launcherHost: env.DEMO_LAUNCHER_HOST || `odoo-ts-demo.${baseDomain}`,
    runbotHost: env.DEMO_RUNBOT_HOST || `odoo-ts-runbot.${baseDomain}`,
    slotPrefix: env.DEMO_SLOT_PREFIX || DEFAULT_DEMO_CONFIG.slotPrefix,
    slotCount: posInt(env.DEMO_SLOTS, DEFAULT_DEMO_CONFIG.slotCount, 1, 100),
    idleMs: posInt(env.DEMO_IDLE_MS, DEFAULT_DEMO_CONFIG.idleMs, 10_000, 3_600_000),
    runbotResetMs: posInt(env.DEMO_RUNBOT_RESET_MS, DEFAULT_DEMO_CONFIG.runbotResetMs, 60_000, 86_400_000),
    queueStaleMs: DEFAULT_DEMO_CONFIG.queueStaleMs,
    claimGraceMs: DEFAULT_DEMO_CONFIG.claimGraceMs,
    resetRetryMs: DEFAULT_DEMO_CONFIG.resetRetryMs,
    maxLeaseMs: posInt(env.DEMO_MAX_LEASE_MS, DEFAULT_DEMO_CONFIG.maxLeaseMs, 60_000, 86_400_000),
    maxSlotsPerIp: posInt(env.DEMO_MAX_SLOTS_PER_IP, DEFAULT_DEMO_CONFIG.maxSlotsPerIp, 1, 100),
    maxQueuedPerIp: DEFAULT_DEMO_CONFIG.maxQueuedPerIp,
    maxDbBytes: posInt(env.DEMO_MAX_DB_BYTES, DEFAULT_DEMO_CONFIG.maxDbBytes, 16_777_216, 1_099_511_627_776),
    pdfPerLease: DEFAULT_DEMO_CONFIG.pdfPerLease,
    pdfPerDay: DEFAULT_DEMO_CONFIG.pdfPerDay,
  };
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

type ResetJob =
  | { readonly kind: "slot"; readonly index: number }
  | { readonly kind: "runbot"; readonly side: "a" | "b" };

export class DemoPool extends DurableObject<Env> {
  private snap: PoolSnapshot | null = null;
  private readonly cfg: DemoConfig;
  private readonly pendingJobs: ResetJob[] = [];
  private readonly queuedKeys = new Set<string>();
  private draining = false;
  /** The running `drainResetQueue()` (awaited by `drain()` so no clone runs on after the pool is drained). */
  private drainJob: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.cfg = demoConfigFromEnv(env);
  }

  private async load(now = Date.now()): Promise<PoolSnapshot> {
    if (this.snap === null) {
      const stored = await this.ctx.storage.get<PoolSnapshot>(STATE_KEY);
      if (stored) {
        reconcileSlotCount(stored, this.cfg);
        this.snap = stored;
      } else {
        this.snap = createInitialSnapshot(this.cfg, now);
        await this.persist(now);
      }
    }
    return this.snap;
  }

  private async persist(now = Date.now()): Promise<void> {
    if (this.snap === null) return;
    await this.ctx.storage.put(STATE_KEY, this.snap);
    const nextAt = computeNextAlarmAt(this.snap, this.cfg, now);
    await this.ctx.storage.setAlarm(nextAt);
  }

  private enqueueJob(job: ResetJob): void {
    const key = job.kind === "slot" ? `slot:${job.index}` : `runbot:${job.side}`;
    if (this.queuedKeys.has(key)) return;
    this.queuedKeys.add(key);
    this.pendingJobs.push(job);
    if (!this.draining) {
      this.draining = true;
      this.drainJob = this.drainResetQueue();
      this.ctx.waitUntil(this.drainJob);
    }
  }

  private async drainResetQueue(): Promise<void> {
    try {
      while (this.pendingJobs.length > 0) {
        const job = this.pendingJobs.shift()!;
        const key = job.kind === "slot" ? `slot:${job.index}` : `runbot:${job.side}`;
        try {
          if (job.kind === "slot") {
            const db = slotDbName(job.index);
            const url = `https://${slotHostname(job.index, this.cfg)}`;
            const ok = await this.resetDatabase(db, url);
            const now = Date.now();
            const snap = await this.load(now);
            finishSlotReset(snap, this.cfg, job.index, ok, now, randomToken);
            await this.persist(now);
          } else {
            const db = runbotDbName(job.side);
            const url = `https://${this.cfg.runbotHost}`;
            const ok = await this.resetDatabase(db, url);
            const now = Date.now();
            const snap = await this.load(now);
            finishRunbotRebuild(snap, this.cfg, job.side, ok, now);
            await this.persist(now);
          }
        } finally {
          this.queuedKeys.delete(key);
        }
      }
    } finally {
      this.draining = false;
      this.drainJob = null;
    }
  }

  /**
   * Drop and recreate one demo/runbot database from `DEMO_TEMPLATE_DB`, rotate `database.secret`,
   * set `web.base.url`, wipe its `FilestoreObject`, and close its `BusDispatcher` websockets.
   */
  private async resetDatabase(db: string, baseUrl: string): Promise<boolean> {
    const targetDb = assertIdent(db);
    const templateDb = assertIdent(this.env.DEMO_TEMPLATE_DB || "demo_template");
    const owner = assertIdent(this.env.DEMO_DB_OWNER || "odoo_demo");
    const t0 = Date.now();
    try {
      // 1. Close active websockets & clear uploaded runtime files for this DB
      const busStub = this.env.BUS.get(this.env.BUS.idFromName(targetDb)) as DurableObjectStub & {
        reset?: () => Promise<void>;
      };
      if (typeof busStub.reset === "function") {
        await busStub.reset().catch((e) => console.warn(`demo reset bus ${targetDb}:`, e));
      }
      const fsStub = this.env.FILESTORE_DO.get(this.env.FILESTORE_DO.idFromName(targetDb));
      await fsStub.reset().catch((e) => console.warn(`demo reset filestore ${targetDb}:`, e));

      // 2. Recreate Postgres DB from template (autocommit connection, serialized by drainResetQueue)
      // FILE_COPY: a checkpoint and a directory copy instead of WAL-logging every block of the template (PG 15's
      // default WAL_LOG); no statement timeout, as a clone of a large template may outlast a role's default
      await withAdminClient(this.env, "postgres", async (client) => {
        await client.query("SET statement_timeout = 0");
        await client.query(`DROP DATABASE IF EXISTS ${targetDb} WITH (FORCE)`);
        await client.query(`CREATE DATABASE ${targetDb} WITH TEMPLATE ${templateDb} OWNER ${owner} STRATEGY FILE_COPY`);
      });

      // 3. Rotate database.secret (invalidates every old session cookie!) and set web.base.url
      const freshSecret = crypto.randomUUID();
      await withAdminClient(this.env, targetDb, async (client) => {
        await client.query("UPDATE ir_config_parameter SET value = $1 WHERE key = 'database.secret'", [freshSecret]);
        await client.query("UPDATE ir_config_parameter SET value = $1 WHERE key = 'web.base.url'", [baseUrl]);
      });

      console.log(`demo reset ok: ${targetDb} (${Date.now() - t0} ms)`);
      return true;
    } catch (e) {
      console.error(`demo reset failed for ${targetDb}:`, e);
      return false;
    }
  }

  private async runDueWork(now: number): Promise<void> {
    const snap = await this.load(now);
    if (snap.maintenance === true) return; // kill switch: no background CREATE DATABASE
    const due = collectDueWork(snap, this.cfg, now, randomToken);
    if (due.slotsToReset.length > 0 || due.runbotSwapped || due.runbotToRebuild !== null) {
      await this.persist(now);
    }
    for (const index of due.slotsToReset) this.enqueueJob({ kind: "slot", index });
    if (due.runbotToRebuild !== null) this.enqueueJob({ kind: "runbot", side: due.runbotToRebuild });
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    await this.runDueWork(now);
    await this.persist(now);
  }

  /**
   * Called by the Worker's 1-minute cron trigger as a safety net alongside DO alarms; also enforces the per-database
   * size cap (`pg_database_size` of every leased slot and the live Runbot side).
   */
  async tick(): Promise<PoolStatus> {
    const now = Date.now();
    await this.runDueWork(now);
    await this.enforceDbSizes();
    const snap = await this.load(now);
    await this.persist(now);
    return getPoolStatus(snap, this.cfg, now);
  }

  private async enforceDbSizes(): Promise<void> {
    const snap = await this.load();
    const dbs = databasesToMeasure(snap);
    if (dbs.length === 0) return;
    let rows: { datname: string; size: string }[];
    try {
      rows = await withAdminClient(this.env, "postgres", async (client) =>
        (await client.query<{ datname: string; size: string }>(
          "SELECT datname, pg_database_size(datname)::text AS size FROM pg_database WHERE datname = ANY($1::text[])",
          [dbs],
        )).rows,
      );
    } catch (e) {
      console.warn("demo db size check failed:", e);
      return;
    }
    const now = Date.now();
    const sizes = new Map(rows.map((r) => [r.datname, Number(r.size)]));
    const res = enforceDbSizeCap(snap, this.cfg, sizes, now);
    if (res.slotsToReset.length === 0 && !res.runbotForced) return;
    console.warn(`demo db size cap (${this.cfg.maxDbBytes} B): reset slots [${res.slotsToReset.join(",")}] runbotForced=${res.runbotForced}`);
    await this.persist(now);
    for (const index of res.slotsToReset) this.enqueueJob({ kind: "slot", index });
    if (res.runbotForced) await this.runDueWork(now);
  }

  async status(): Promise<PoolStatus> {
    const now = Date.now();
    await this.runDueWork(now);
    const snap = await this.load(now);
    return getPoolStatus(snap, this.cfg, now);
  }

  async enter(ipKey: string | null = null): Promise<EnterResult> {
    const now = Date.now();
    await this.runDueWork(now);
    const snap = await this.load(now);
    const result = enterPool(snap, this.cfg, now, randomToken, randomToken, ipKey);
    await this.persist(now);
    return result;
  }

  async poll(queueId: string): Promise<PollResult> {
    const now = Date.now();
    await this.runDueWork(now);
    const snap = await this.load(now);
    const result = pollQueue(snap, this.cfg, queueId, now, randomToken);
    await this.persist(now);
    return result;
  }

  /** Burns the single-use claim nonce and returns the fresh lease secret for the `__Host-` cookie. */
  async claim(slotIndex: number, claimToken: string): Promise<ClaimResult> {
    const now = Date.now();
    const snap = await this.load(now);
    const res = claimSlotLease(snap, this.cfg, slotIndex, claimToken, now, randomToken);
    await this.persist(now);
    return res;
  }

  async verify(
    slotIndex: number,
    token: string | null,
    isUserActivity: boolean,
  ): Promise<
    | { readonly ok: true; readonly db: string; readonly idleRemainingMs: number }
    | { readonly ok: false; readonly reason: "missing" | "expired" | "mismatch" }
  > {
    const now = Date.now();
    const snap = await this.load(now);
    const res = verifySlotLease(snap, this.cfg, slotIndex, token, isUserActivity, now);
    if (!res.ok) {
      if (res.reason === "expired") await this.runDueWork(now);
      return res;
    }
    if (res.touched) await this.persist(now);
    return { ok: true, db: res.db, idleRemainingMs: res.idleRemainingMs };
  }

  async release(slotIndex: number, token: string): Promise<boolean> {
    const now = Date.now();
    const snap = await this.load(now);
    const ok = releaseSlotLease(snap, slotIndex, token, now);
    if (!ok) return false;
    await this.persist(now);
    this.enqueueJob({ kind: "slot", index: slotIndex });
    return true;
  }

  /** Whether the kill switch is on (src/demo/router.ts caches it for 5 s per isolate). */
  async maintenanceState(): Promise<boolean> {
    return (await this.load()).maintenance === true;
  }

  async setMaintenanceMode(enabled: boolean): Promise<{ readonly maintenance: boolean }> {
    const now = Date.now();
    const snap = await this.load(now);
    if (setMaintenance(snap, enabled)) await this.persist(now);
    if (!enabled) await this.runDueWork(now);
    return { maintenance: snap.maintenance === true };
  }

  /**
   * Maintenance on, every lease revoked, the queue cleared, queued reset jobs dropped and the running one awaited (no
   * background CREATE DATABASE continues), then every slot's and both Runbot sides' websockets closed.
   */
  async drain(): Promise<{ readonly ok: true; readonly drainedSlots: number; readonly pendingJobs: number }> {
    const now = Date.now();
    const snap = await this.load(now);
    const { drainedSlots } = drainPool(snap, now);
    await this.persist(now);
    for (const job of this.pendingJobs.splice(0)) {
      this.queuedKeys.delete(job.kind === "slot" ? `slot:${job.index}` : `runbot:${job.side}`);
    }
    if (this.drainJob !== null) await this.drainJob.catch(() => undefined);
    const dbs = [...snap.slots.map((s) => s.db), runbotDbName("a"), runbotDbName("b")];
    await Promise.all(dbs.map((db) => this.resetBus(db)));
    return { ok: true, drainedSlots: drainedSlots.length, pendingJobs: this.pendingJobs.length };
  }

  /** While in maintenance: wipe every slot's and Runbot side's FilestoreObject and put all pool state back to free. */
  async resetState(): Promise<{ readonly ok: boolean; readonly slots: number }> {
    const now = Date.now();
    const snap = await this.load(now);
    if (snap.maintenance !== true) return { ok: false, slots: 0 };
    const dbs = [...snap.slots.map((s) => s.db), runbotDbName("a"), runbotDbName("b")];
    await Promise.all(
      dbs.map((db) =>
        this.env.FILESTORE_DO.get(this.env.FILESTORE_DO.idFromName(db)).reset().catch((e) => console.warn(`demo reset filestore ${db}:`, e)),
      ),
    );
    resetPoolState(snap, this.cfg, Date.now());
    await this.persist();
    return { ok: true, slots: snap.slots.length };
  }

  /**
   * Charge one PDF to the lease (15 per lease) and to the day (200 per UTC day). Called only when a PDF is about to be
   * rendered (src/demo/quota.ts); the caller fails closed when this throws.
   */
  async pdfQuota(target: PdfQuotaTarget): Promise<PdfQuotaResult> {
    const now = Date.now();
    const snap = await this.load(now);
    const res = consumePdfQuota(snap, this.cfg, target, now);
    if (res.ok) await this.persist(now);
    return res;
  }

  private async resetBus(db: string): Promise<void> {
    const busStub = this.env.BUS.get(this.env.BUS.idFromName(db)) as DurableObjectStub & { reset?: () => Promise<void> };
    if (typeof busStub.reset === "function") await busStub.reset().catch((e) => console.warn(`demo drain bus ${db}:`, e));
  }

  async runbotInfo(): Promise<{ readonly db: string; readonly nextResetAt: number; readonly epoch: number }> {
    const now = Date.now();
    await this.runDueWork(now);
    const snap = await this.load(now);
    return {
      db: runbotDbName(snap.runbot.active),
      nextResetAt: snap.runbot.nextResetAt,
      epoch: snap.runbot.epoch,
    };
  }
}
