/**
 * `GET /web/service-worker.js`: `odoo/addons/web/controllers/webmanifest.py:87 service_worker` ->
 * `_get_service_worker_content` (:97: `web/static/src/service_worker.js` read in text mode) extended by
 * `odoo/addons/mail/controllers/webmanifest.py:11` (appends `mail/static/src/service_worker.js` when the user
 * `_is_internal()`). Headers: `Content-Type: text/javascript` (verbatim, no charset) and
 * `Service-Worker-Allowed: /odoo`; nosniff from post_dispatch. No Cache-Control (the S1 reference agrees).
 *
 * Owned by stream H2.
 */
import { HttpError } from "../errors";
import type { RequestContext } from "../http/context";
import { route } from "../http/router";
import { fetchStaticAsset } from "./static";
import { userHasGroup } from "./binary";

/** `file_open(path)` in text mode: utf-8 with universal newlines (\r\n and \r become \n). */
async function readText(ctx: RequestContext, path: string): Promise<string> {
  const file = await fetchStaticAsset(ctx.env, path);
  if (file === null) throw new HttpError(404, `${path} missing from static assets`);
  return new TextDecoder("utf-8").decode(file.data).replace(/\r\n?/g, "\n");
}

/** `request.env.user._is_internal()` (res_users.py:1271): `request.env.uid` (the public user for auth="public"). */
export async function currentUserIsInternal(ctx: RequestContext): Promise<boolean> {
  const cr = ctx.cursor();
  let uid = ctx.uid ?? ctx.session.uid;
  if (uid === null) {
    const r = await cr.query<{ res_id: number }>("SELECT res_id FROM ir_model_data WHERE module = 'base' AND name = 'public_user'");
    uid = r.rows[0]?.res_id ?? null;
    if (uid === null) return false;
  }
  return userHasGroup(cr, uid, "base.group_user");
}

async function serviceWorker(ctx: RequestContext): Promise<Response> {
  let body = await readText(ctx, "/web/static/src/service_worker.js");
  if (await currentUserIsInternal(ctx)) body += await readText(ctx, "/mail/static/src/service_worker.js");
  return new Response(body, {
    headers: {
      "Content-Type": "text/javascript",
      "Service-Worker-Allowed": "/odoo",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

route("/web/service-worker.js", serviceWorker, { auth: "public", methods: ["GET"], readonly: true });
