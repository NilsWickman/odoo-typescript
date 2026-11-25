/** Zero-dependency storage GC helpers for the SessionStore Durable Object (keeps `do/session.ts` free of Node/ORM imports). */

export const SESSION_STORAGE_PREFIX = "session:";
export const LOGIN_FAILURES_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface SessionStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  list<T>(options?: { prefix?: string; limit?: number }): Promise<Map<string, T>>;
}

export async function purgeOldSessions(storage: SessionStorageLike, sidPrefix: string, currentSid: string, nowSec: number): Promise<number> {
  const currentKey = SESSION_STORAGE_PREFIX + currentSid;
  const entries = await storage.list<string>({ prefix: SESSION_STORAGE_PREFIX + sidPrefix });
  const toDelete: string[] = [];
  for (const [key, raw] of entries) {
    if (key === currentKey) continue;
    try {
      const data = JSON.parse(raw) as unknown;
      if (typeof data === "object" && data !== null && !Array.isArray(data)) {
        const del = (data as Record<string, unknown>)["deletion_time"];
        if (typeof del === "number" && del <= nowSec) toDelete.push(key);
      }
    } catch {
      toDelete.push(key);
    }
  }
  for (let i = 0; i < toDelete.length; i += 128) {
    await storage.delete(toDelete.slice(i, i + 128));
  }
  return toDelete.length;
}

export async function readLoginFailures(storage: SessionStorageLike, key: string, now: number = Date.now()): Promise<[number, number]> {
  const entry = await storage.get<[number, number]>(key);
  if (entry === undefined) return [0, 0];
  const [failures, previous] = entry;
  if (previous > 0 && now - previous > LOGIN_FAILURES_MAX_AGE_MS) {
    await storage.delete(key);
    return [0, 0];
  }
  return [failures, previous];
}

export async function recordLoginFailure(storage: SessionStorageLike, key: string, now: number): Promise<void> {
  const [failures] = await readLoginFailures(storage, key, now);
  await storage.put(key, [failures + 1, now]);
  const entries = await storage.list<[number, number]>({ prefix: "login_failures:", limit: 64 });
  const stale: string[] = [];
  for (const [k, v] of entries) {
    if (k !== key && v[1] > 0 && now - v[1] > LOGIN_FAILURES_MAX_AGE_MS) stale.push(k);
  }
  if (stale.length > 0) await storage.delete(stale);
}
