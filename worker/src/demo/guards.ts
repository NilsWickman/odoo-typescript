/**
 * Request guards of the public demo (src/demo/router.ts), free of Worker runtime imports so they run under `npm test`.
 */
import type { Env } from "../env";
import { constantTimeEqual } from "./pool_logic";

/** Largest request body the public demo accepts (the private Worker keeps its 40 MiB chunked uploads). */
export const DEMO_MAX_BODY_BYTES = 5 * 1024 * 1024;
export const BYPASS_HEADER = "x-demo-admin-bypass";

/**
 * Non-GET bodies over 5 MiB answer 413, by Content-Length when given, otherwise by counting the stream (buffered up to
 * the cap and handed on as a fresh request).
 */
export async function enforceDemoBodyCap(request: Request, maxBytes = DEMO_MAX_BODY_BYTES): Promise<Request | Response> {
  if (request.method === "GET" || request.method === "HEAD" || request.body === null) return request;
  const tooLarge = (): Response =>
    new Response(`Request body larger than ${maxBytes} bytes is not accepted by the public demo.`, {
      status: 413,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", Connection: "close" },
    });
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim())) return Number(declared) > maxBytes ? tooLarge() : request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return tooLarge();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    body.set(c, off);
    off += c.byteLength;
  }
  return new Request(request, { body });
}

/** `X-Demo-Admin-Bypass` equal to `DEMO_BYPASS_TOKEN` (never the admin token) passes the maintenance 503. */
export function hasMaintenanceBypass(request: Request, env: Pick<Env, "DEMO_BYPASS_TOKEN">): boolean {
  const expected = env.DEMO_BYPASS_TOKEN;
  const given = request.headers.get(BYPASS_HEADER);
  return Boolean(expected) && given !== null && constantTimeEqual(given, expected!);
}

/** `Authorization: Bearer <DEMO_ADMIN_TOKEN>` (never the bypass token). */
export function hasAdminToken(request: Request, env: Pick<Env, "DEMO_ADMIN_TOKEN">): boolean {
  const expected = env.DEMO_ADMIN_TOKEN;
  if (!expected) return false;
  const m = /^Bearer[ ]+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "");
  return m !== null && constantTimeEqual(m[1]!, expected);
}
