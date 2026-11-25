/**
 * ir.ui.menu `create`/`write` with `web_icon` (odoo/addons/base/models/ir_ui_menu.py:147-171): an image icon
 * `"<module>,<path>"` is read from the module's files (`_read_image` :57-66, the Worker's static assets) into the
 * attachment field `web_icon_data`; a built icon (three parts) has none. A file the assets do not have refuses (Odoo
 * would read it from the addons path).
 */
import { NotPorted } from "../errors";
import { fetchStaticAsset } from "../controllers/static";
import { requestOfCursor } from "../http/context";
import { storeAttachment } from "../orm/image_write";
import type { Environment } from "../orm/types";
import { registerOverrides } from "../orm/write";

const EXTENSIONS = [".png", ".gif", ".ico", ".jfif", ".jpeg", ".jpg", ".svg", ".webp"];

/** `_compute_web_icon_data(web_icon)`: the image's bytes, or null (no image icon). */
async function webIconData(env: Environment, webIcon: unknown): Promise<Uint8Array | null> {
  if (typeof webIcon !== "string" || !webIcon) return null;
  const parts = webIcon.split(",");
  if (parts.length !== 2) return null;
  const path = `${parts[0]}/${parts[1]}`;
  if (!EXTENSIONS.some((e) => path.toLowerCase().endsWith(e))) throw new NotPorted(`menu web_icon ${webIcon} (file_open filter_ext)`);
  const ctx = requestOfCursor(env.cr);
  if (ctx === null) throw new NotPorted("menu web_icon outside a request");
  const file = await fetchStaticAsset(ctx.env, `/${path}`);
  if (file === null) throw new NotPorted(`menu web_icon ${webIcon}: not among the Worker's static files`);
  return file.data;
}

registerOverrides("ir.ui.menu", {
  create: async (env, valsList, next) => {
    const icons = await Promise.all(valsList.map((v) => ("web_icon" in v ? webIconData(env, v["web_icon"]) : Promise.resolve(null))));
    const ids = await next(env, valsList);
    // models.py `_create`: the attachment field is stored with the record (Binary attachment=True)
    for (const [i, data] of icons.entries()) if (data) await storeAttachment(env.sudo(), "ir.ui.menu", "web_icon_data", ids[i]!, data);
    return ids;
  },
  write: async (env, ids, vals, next) => {
    if (!("web_icon" in vals)) return next(env, ids, vals);
    const data = await webIconData(env, vals["web_icon"]);
    await next(env, ids, vals);
    if (!data) throw new NotPorted("menu write of a web_icon without an image (web_icon_data cleared)");
    for (const id of ids) await storeAttachment(env.sudo(), "ir.ui.menu", "web_icon_data", id, data);
  },
});
