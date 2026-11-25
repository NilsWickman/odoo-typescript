/**
 * The demo's PDF quota (`DEMO_MODE=1` only), charged in `renderPdf` (src/controllers/report.ts) just before a PDF is
 * rendered: 15 per lease and 200 per UTC day, counted authoritatively by the DemoPool Durable Object. Fails closed:
 * without the binding, the lease, or an answer from the object, no PDF is rendered.
 */
import type { Env } from "../env";
import { UserError } from "../errors";
import type { PdfQuotaTarget } from "./pool_logic";

const POOL_DO_NAME = "global";

export const PDF_QUOTA_MESSAGES = {
  lease: "This demo session has reached its PDF limit. Start a new demo session to print more.",
  day: "The public demo has reached its daily PDF limit. Please try again tomorrow.",
  unavailable: "PDF printing is unavailable in the public demo right now. Please try again later.",
} as const;

/** The quota target of a request-scoped demo env (src/demo/router.ts scopedDemoEnv), null when it names none. */
export function pdfQuotaTarget(env: Pick<Env, "DEMO_LEASE_SLOT" | "DEMO_LEASE_SECRET">): PdfQuotaTarget | null {
  const slot = env.DEMO_LEASE_SLOT;
  if (slot === "runbot") return { kind: "runbot" };
  if (slot === undefined || !/^[1-9][0-9]*$/.test(slot) || !env.DEMO_LEASE_SECRET) return null;
  return { kind: "slot", index: Number(slot), leaseSecret: env.DEMO_LEASE_SECRET };
}

/** Charge one PDF; throws Odoo's UserError (a friendly dialog) when over quota or when the quota cannot be checked. */
export async function chargeDemoPdf(env: Env): Promise<void> {
  const target = pdfQuotaTarget(env);
  if (target === null || !env.DEMO_POOL) throw new UserError(PDF_QUOTA_MESSAGES.unavailable);
  let res: Awaited<ReturnType<import("../do/demo_pool").DemoPool["pdfQuota"]>>;
  try {
    res = await env.DEMO_POOL.get(env.DEMO_POOL.idFromName(POOL_DO_NAME)).pdfQuota(target);
  } catch (e) {
    console.warn("demo pdf quota check failed:", e);
    throw new UserError(PDF_QUOTA_MESSAGES.unavailable);
  }
  if (res.ok) return;
  throw new UserError(res.reason === "lease" ? PDF_QUOTA_MESSAGES.lease : res.reason === "day" ? PDF_QUOTA_MESSAGES.day : PDF_QUOTA_MESSAGES.unavailable);
}
