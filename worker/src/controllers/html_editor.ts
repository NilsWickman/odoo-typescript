/**
 * `/html_editor/get_ice_servers` (and `/web_editor/get_ice_servers`): html_editor/controllers/main.py:720-722 ->
 * `mail.ice.server._get_ice_servers()` (mail/models/mail_ice_server.py:39-53). Twilio credentials
 * (mail/tools/discuss.py:132-142) would need an outgoing API call: refused. Otherwise the local servers
 * (`_get_local_ice_servers`, :21-37): `sudo().search([], limit=5)` in `_order` (default `id`).
 */
import { NotPorted } from "../errors";
import { isInstalled } from "../http/modules";
import { jsonRoute } from "../http/router";
import { icpBool, icpStr } from "../session/user";

jsonRoute(["/web_editor/get_ice_servers", "/html_editor/get_ice_servers"], async (ctx) => {
  const cr = ctx.cursor();
  if (!(await isInstalled(cr, "html_editor"))) throw new NotPorted("/html_editor/get_ice_servers without html_editor");
  if (await icpBool(cr, "mail.use_call_server") && await icpBool(cr, "mail.use_twilio_rtc_servers")) {
    const sid = await icpStr(cr, "mail.twilio_account_sid");
    const token = await icpStr(cr, "mail.twilio_account_token");
    if (sid && token) throw new NotPorted("Twilio TURN servers (mail_ice_server.py:44-52 posts to api.twilio.com)");
  }
  const r = await cr.query<{ server_type: string; uri: string; username: string | null; credential: string | null }>(
    "SELECT server_type, uri, username, credential FROM mail_ice_server ORDER BY id LIMIT 5");
  return r.rows.map((s) => {
    const out: Record<string, unknown> = { urls: `${s.server_type}:${s.uri}` };
    if (s.username) out["username"] = s.username;
    if (s.credential) out["credential"] = s.credential;
    return out;
  });
}, { auth: "user" });
