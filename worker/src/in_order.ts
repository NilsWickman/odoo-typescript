/**
 * The values of promises started together, in their order: reads that do not depend on each other are sent at once and
 * share round trips (src/db.ts pipelining). The first rejection in that order is thrown, the one a sequential run would
 * have met first; the others are waited for, so none is left running unobserved.
 */
export async function inOrder<T extends readonly unknown[]>(ps: T): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const settled = await Promise.allSettled(ps);
  for (const r of settled) if (r.status === "rejected") throw r.reason;
  return settled.map((r) => (r as PromiseFulfilledResult<unknown>).value) as { -readonly [K in keyof T]: Awaited<T[K]> };
}
