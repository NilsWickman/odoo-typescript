/**
 * The pure part of `/proof` (src/proof.ts): which requests it answers, on the private site and on the public demo, which
 * databases its facts come from, and the cache of those facts. No I/O here, so the unit tests import it directly.
 */
import { runbotDbName, type DemoHostTarget } from "./demo/pool_logic";

/** How long the database facts are kept in the isolate: one query a minute per isolate, not one per view. */
export const PROOF_FACTS_TTL_MS = 60_000;

/**
 * What `/proof` does with a request, before any other routing; `null` hands it on unchanged.
 * `demoHost` is `null` on the private site, else the request's demo host (src/demo/pool_logic.ts parseDemoHost).
 * On the demo only the launcher, the Runbot and the slot hosts answer, and only GET and HEAD: no lease, no login, no
 * call to the pool. Everything below `/proof/` is 404 on both (Access lets the whole path through on the private site).
 */
export function proofRoute(pathname: string, method: string, demoHost: DemoHostTarget["kind"] | null): "page" | "not_found" | null {
  if (pathname !== "/proof" && !pathname.startsWith("/proof/")) return null;
  if (demoHost === null) return pathname === "/proof" ? "page" : "not_found";
  if (demoHost === "unknown") return null;
  if (pathname.startsWith("/proof/")) return "not_found";
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" ? "page" : null;
}

/**
 * The databases the facts may come from, in order. `PROOF_DB` (one name, or several separated by commas) wins; on the
 * demo without it, the Runbot's two databases (fresh copies of the demo's template). Not the template itself: it is
 * marked ALLOW_CONNECTIONS = false (worker/vps/setup_demo_pg.sh), and a connection to it would make every slot's
 * `CREATE DATABASE ... TEMPLATE demo_template` fail while it lasts (src/do/demo_pool.ts resetDatabase).
 */
export function proofDbs(env: { readonly PROOF_DB?: string; readonly DEMO_MODE?: string }): string[] {
  const named = (env.PROOF_DB ?? "").split(",").map((d) => d.trim()).filter(Boolean);
  if (named.length > 0) return named;
  return env.DEMO_MODE === "1" ? [runbotDbName("a"), runbotDbName("b")] : [];
}

export interface CachedFacts<T> {
  readonly facts: T;
  readonly db: string;
  /** When the facts were read (ms since the epoch). */
  readonly at: number;
}

let cache: { key: string; value: CachedFacts<unknown> } | null = null;

/** For the tests. */
export function resetProofCache(): void {
  cache = null;
}

/**
 * The facts of the first database in `dbs` that answers, kept for `PROOF_FACTS_TTL_MS` in the isolate. The database
 * that answered last is tried first (one of the Runbot's two is dropped and recreated every rotation). A failure is not
 * cached: the error of the last database tried is thrown. Only plain data is kept, never a promise or a connection,
 * as nothing of one request's I/O may be used by another in a Worker.
 */
export async function cachedFacts<T>(dbs: readonly string[], read: (db: string) => Promise<T>, now: () => number = Date.now): Promise<CachedFacts<T>> {
  const key = dbs.join(",");
  const t = now();
  if (cache !== null && cache.key === key && t - cache.value.at < PROOF_FACTS_TTL_MS) return cache.value as CachedFacts<T>;
  const last = cache !== null && cache.key === key ? cache.value.db : null;
  const order = last !== null && dbs.includes(last) ? [last, ...dbs.filter((d) => d !== last)] : [...dbs];
  let error: unknown = new Error("no database");
  for (const db of order) {
    try {
      const facts = await read(db);
      const value: CachedFacts<T> = { facts, db, at: now() };
      cache = { key, value };
      return value;
    } catch (e) {
      error = e;
    }
  }
  throw error;
}
