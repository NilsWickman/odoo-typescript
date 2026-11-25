/**
 * `GET /odoo/offline`: `odoo/addons/web/controllers/webmanifest.py:107 offline` ->
 * `request.render('web.webclient_offline', {'odoo_icon': <web/static/img/odoo-icon-192x192.png bytes>})`
 * (webclient_templates.xml:315, through web.layout). The QWeb rendering belongs to stream Q: it registers its
 * renderer with `setTemplateRenderer` (src/index.ts wires it). The page always renders the database template.
 *
 * Owned by stream H2.
 */
import { HttpError, NotPorted } from "../errors";
import type { RequestContext } from "../http/context";
import { route } from "../http/router";
import { fetchStaticAsset } from "./static";

export type TemplateRenderer = (ctx: RequestContext, template: string, qcontext: Record<string, unknown>) => Promise<string>;

let renderer: TemplateRenderer | null = null;

/** Stream Q registers `ir.qweb._render` here; the dispatcher's index.ts calls it once at load time. */
export function setTemplateRenderer(r: TemplateRenderer): void {
  renderer = r;
}

async function offline(ctx: RequestContext): Promise<Response> {
  // webmanifest.py:109-115
  const file = await fetchStaticAsset(ctx.env, "/web/static/img/odoo-icon-192x192.png");
  if (file === null) throw new HttpError(404, "web/static/img/odoo-icon-192x192.png missing from static assets");
  if (renderer === null) throw new NotPorted("QWeb renderer is not registered");
  const html = await renderer(ctx, "web.webclient_offline", { odoo_icon: file.data });
  // Response(template=...) rendered by the dispatcher: text/html; charset=utf-8 and nosniff, no Cache-Control
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff" },
  });
}

route("/odoo/offline", offline, { auth: "public", methods: ["GET"], readonly: true });
