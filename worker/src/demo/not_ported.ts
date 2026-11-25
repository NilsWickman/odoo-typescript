/**
 * The public demo's floor under `NotPorted` (src/http/dispatch.ts handleError, src/controllers/report.ts download):
 * strictly with `DEMO_MODE=1` and never with `LOCAL_DEV=1` (proofs, the oracle comparison) nor on the private Worker,
 * an uncaught refusal of the port reaches the visitor as Odoo's UserError dialog instead of a server error, and is
 * logged as a structured `demo-not-ported` line so the missing piece can be found in the logs.
 */
import type { Env } from "../env";
import { NotPorted, UserError } from "../errors";

export const DEMO_NOT_PORTED_MESSAGE = "This action is paused or not enabled in the public demo yet.";

export function demoNotPortedFloor(env: Pick<Env, "DEMO_MODE" | "LOCAL_DEV">, e: unknown, path = ""): unknown {
  if (env.DEMO_MODE !== "1" || env.LOCAL_DEV === "1" || !(e instanceof NotPorted)) return e;
  console.warn("demo-not-ported", JSON.stringify({ path, what: e.message }));
  return new UserError(DEMO_NOT_PORTED_MESSAGE);
}
