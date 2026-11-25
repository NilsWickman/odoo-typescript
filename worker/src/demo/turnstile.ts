/**
 * Cloudflare Turnstile on the launcher's `POST /__demo/enter` (src/demo/router.ts). Active only when both
 * `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are configured; unset (local development, unit tests) it is skipped.
 * This module is one of the two places allowed a global `fetch(` (worker/scripts/check_egress.mjs).
 */
import type { Env } from "../env";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function turnstileEnabled(env: Pick<Env, "TURNSTILE_SITE_KEY" | "TURNSTILE_SECRET_KEY">): boolean {
  return Boolean(env.TURNSTILE_SITE_KEY) && Boolean(env.TURNSTILE_SECRET_KEY);
}

/** Siteverify of the widget's `cf-turnstile-response` token; false on any failure (fail closed). */
export async function verifyTurnstile(secret: string, token: string, remoteIp: string | null): Promise<boolean> {
  if (!token || token.length > 2048) return false;
  const body = new FormData();
  body.set("secret", secret);
  body.set("response", token);
  if (remoteIp) body.set("remoteip", remoteIp);
  try {
    const res = await fetch(SITEVERIFY_URL, { method: "POST", body });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: unknown };
    return data.success === true;
  } catch (e) {
    console.warn("turnstile siteverify failed:", e);
    return false;
  }
}
