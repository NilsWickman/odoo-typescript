/**
 * The bits of Odoo's `request` that model code reads (`request.session.sid`, `request.httprequest.remote_addr`,
 * `request.httprequest.user_agent`), e.g. `res.session._compute_is_current` (base/models/res_device.py:201-211,
 * :280-286). src/http/context.ts installs it in `env.cache` when it builds the request's environment, as it does
 * for the filestore reader; outside a request it is absent (Odoo's `if not request`).
 */
import type { Environment } from "../orm/types";

export const REQUEST_INFO_KEY = "models.request_info";

export interface RequestInfo {
  /** The current session id (read live: the session may rotate during the request). */
  sid(): string;
  readonly remoteAddr: string;
  readonly userAgent: string;
}

function isRequestInfo(v: unknown): v is RequestInfo {
  return typeof v === "object" && v !== null && typeof (v as { sid?: unknown }).sid === "function";
}

export function requestInfo(env: Environment): RequestInfo | null {
  const v = env.cache.get(REQUEST_INFO_KEY);
  return isRequestInfo(v) ? v : null;
}
