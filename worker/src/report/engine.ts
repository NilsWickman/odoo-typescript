/**
 * The PDF engine of the Worker (D8b): Browser Run where it is bound and deployed; local development (LOCAL_DEV) has
 * none, as the oracle (no wkhtmltopdf), so `get_pdf_engine_state` is 'install' there
 * (base ir_actions_report.py:170-183, base_report_wkhtmltox for 'wkhtmltopdf').
 *
 * Model code has no Worker bindings: the request installs whether an engine exists in `env.cache[PDF_ENGINE_KEY]`
 * (src/http/context.ts, src/controllers/rpc.ts, src/controllers/json2.ts), so a method that renders a PDF refuses
 * instead of answering "Unable to find the pdf engine" where there is one.
 */
import type { Env } from "../env";
import type { Environment } from "../orm/types";

export const PDF_ENGINE_KEY = "report.pdf_engine";

export function pdfEngineOf(env: Env, db: string | null): NonNullable<Env["BROWSER"]> | null {
  if (env.LOCAL_DEV === "1") return null;
  // PDF_ENGINE_DBS (deploy.sh): only these databases get the engine; the harness's copies on the site are measured
  // without one, as the oracle (D8b)
  if (env.PDF_ENGINE_DBS && (db === null || !new RegExp(env.PDF_ENGINE_DBS).test(db))) return null;
  return env.BROWSER ?? null;
}

/** Whether the request that made `env` has a PDF engine (false when none was installed, as locally). */
export function hasPdfEngine(env: Environment): boolean {
  return env.cache.get(PDF_ENGINE_KEY) === true;
}
