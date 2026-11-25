/**
 * OdooBot's onboarding chat, `res.users._init_odoobot` (odoo/addons/mail_bot/models/res_users.py:24-45), run by
 * `_on_webclient_bootstrap` on the first web client load of an internal user (web/controllers/home.py:68-69).
 *
 * Ported with SQL in the columns Odoo writes (as src/mail/message.ts does for messages):
 * - `discuss.channel._get_or_create_chat([odoobot, user partner])` (mail/models/discuss/discuss_channel.py:1763-1826)
 *   for the case where no chat exists yet: `create` (:522-581) of a `chat` channel with its two members
 *   (discuss_channel_member.py:259-300), `member_indices` precomputed (:385-396);
 * - `channel.sudo().message_post(author_id=odoobot, message_type='comment', silent=True, subtype mt_comment)`
 *   (discuss_channel.py:1423-1448 -> mail_thread.py message_post): one mail.message, no recipients (a chat's
 *   followers are empty and no partner_ids are given), and `_update_last_interest_dt` (:710-768), whose post-commit
 *   superuser sync writes the channel's `last_interest_dt` (write_uid = SUPERUSER_ID);
 * - `self.sudo().odoobot_state = 'onboarding_emoji'`.
 * Not reproduced: the three bus notifications of the request (measured on Odoo after demo's first page load: the
 * chat's Store to the user from `create` (:581) and from `_broadcast` (:1544-1551), `discuss.channel/new_message`
 * from `_notify_thread` (:1348-1363, `silent`), created at precommit after the page read `_bus_last_id`). On the
 * new message of a chat it has not fetched yet the client asks /mail/store for it (discuss_core_common_service.js
 * `getOrFetch`), unless `init_messaging` answered first; that race went one way in 38 of the map's 402 first
 * loads and the other way in 364, and with the notifications ported the port lost it both ways
 * (docs/accept/C1d.md, Fynd 1). bus_bus rows are not part of the compared state.
 * `_update_last_interest_dt` queues its update and the sync cron's trigger in the transaction, and the post-commit sync
 * (as superuser, src/mail/channel_post.ts `syncLastInterest`) applies the update and deletes both.
 * An existing chat (the `channel` branch, :1800-1811) and languages other than en_US refuse.
 */
import { randomInt } from "node:crypto";
import { NotPorted, UserError } from "../errors";
import { cond } from "../orm/domain";
import { userInfo } from "../orm/env";
import type { Environment } from "../orm/types";
import { computeAuthor, insertMessages, replyToDefault, trackingMessageId, xmlid } from "../mail/message";
import { requestOfCursor } from "../http/context";
import { queueLastInterest, syncLastInterest } from "../mail/channel_post";

/** mail_bot/models/res_users.py:34-38 after Markup % escaping and the Html field's sanitize (`<br/>` -> `<br>`, `<p>` wrap,
 * `&#39;` read back as `'`). */
function welcomeBody(env: Environment): string {
  if (env.lang && env.lang !== "en_US") throw new NotPorted(`OdooBot welcome message in ${env.lang} (mail_bot i18n)`);
  return "<p>Hello 👋<br>Odoo's Discuss application helps employees collaborate efficiently. I'm here to help you explore its features.<br><b>Go ahead - Try sending me an emoji 😊</b></p>";
}

/** discuss_channel.py:96-100 `_generate_random_token`: 10 characters of a non-ambiguous alphabet (random by design). */
function randomToken(): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHIJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 10; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

async function dbNowSeconds(env: Environment): Promise<string> {
  // fields.Datetime.now(): naive UTC, microseconds dropped
  const r = await env.cr.query<{ now: string }>("SELECT to_char(date_trunc('second', now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS') AS now");
  return r.rows[0]!.now;
}

/** discuss_channel.py:1763-1826 `_get_or_create_chat(partners_to)` for a new chat. Returns the channel id. */
async function createChat(env: Environment, partnersTo: readonly number[]): Promise<number> {
  const user = await userInfo(env);
  const found = await env.withContext({ ...env.context, active_test: false }).model("res.partner").search(cond("id", "in", [...partnersTo]));
  const partners = found.includes(user.partnerId) ? found : [...found, user.partnerId];
  if (partners.length > 2) throw new UserError("A chat should not be created with more than 2 persons. Create a group instead.");
  const other = partners.filter((p) => p !== user.partnerId);
  // :385-388 `_member_indices`: sorted partner ids
  const indices = [...partners].sort((a, b) => a - b).map((p) => `p${p}`).join(",");
  const existing = await env.cr.query<{ id: number }>("SELECT id FROM discuss_channel WHERE member_indices = $1 AND channel_type = 'chat'", [indices]);
  if (existing.rows.length) throw new NotPorted("_get_or_create_chat with an existing chat (member restore and _broadcast)");
  const names = (await env.cr.query<{ id: number; name: string | null }>("SELECT id, name FROM res_partner WHERE id = ANY($1::int[])", [partners])).rows;
  const nameOf = new Map(names.map((r) => [r.id, r.name ?? ""]));
  const now = await dbNowSeconds(env);
  const ch = (await env.cr.query<{ id: number; last: string }>(
    `INSERT INTO discuss_channel (name, channel_type, last_interest_dt, member_indices, uuid, active,
       create_uid, write_uid, create_date, write_date)
     VALUES ($1, 'chat', $2::timestamp - interval '1 second', $3, $4, true, $5, $5, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')
     RETURNING id, last_interest_dt::text AS last`,
    [partners.map((p) => nameOf.get(p) ?? "").join(", "), now, indices, randomToken(), env.uid])).rows[0]!;
  // :1787-1805: the current user's member first (pinned), then the correspondent's (unpinned until a message)
  const members: [number, string | null][] = [[user.partnerId, null], ...other.map((p): [number, string | null] => [p, now])];
  for (const [partnerId, unpin] of members) {
    await env.cr.query(
      `INSERT INTO discuss_channel_member (channel_id, partner_id, last_interest_dt, unpin_dt, new_message_separator,
         create_uid, write_uid, create_date, write_date)
       VALUES ($1, $2, $3::timestamp, $4::timestamp, 0, $5, $5, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')`,
      [ch.id, partnerId, ch.last, unpin, env.uid]);
  }
  return ch.id;
}

/** mail_bot/models/res_users.py:29-45 `_init_odoobot` for `env.user`. */
export async function initOdoobot(env: Environment): Promise<void> {
  const odoobot = await xmlid(env, "base.partner_root");
  const user = await userInfo(env);
  const body = welcomeBody(env);
  const su = env.sudo();
  const ctx = requestOfCursor(env.cr);
  const db = ctx?.db ?? null;
  if (ctx === null || db === null) throw new NotPorted("OdooBot's chat outside a request (last interest sync)");
  const channelId = await createChat(env, [odoobot, user.partnerId]);
  // message_post (mail_thread.py): author OdooBot, comment, mt_comment, company of the env (models.py:140-153)
  const [authorId, emailFrom] = await computeAuthor(su, odoobot, null);
  const subtype = await xmlid(su, "mail.mt_comment");
  const companyId = await su.company();
  const alias = (await su.cr.query<{ alias_domain_id: number | null }>("SELECT alias_domain_id FROM res_company WHERE id = $1", [companyId])).rows[0];
  if (alias?.alias_domain_id) throw new NotPorted("message_post record_alias_domain_id through a company alias domain");
  await insertMessages(su, [{
    model: "discuss.channel", res_id: channelId, body, author_id: authorId, email_from: emailFrom, message_type: "comment",
    subtype_id: subtype, reply_to: await replyToDefault(su, emailFrom), message_id: trackingMessageId("message-notify"),
    email_add_signature: true, record_alias_domain_id: false, record_company_id: companyId,
  }]);
  // discuss_channel.py:710-768 `_update_last_interest_dt` (in message_post): the queued update and the cron's trigger,
  // applied after the commit by the superuser sync, which deletes both and syncs the channel's field on its bus
  const trigger = await queueLastInterest(su, channelId);
  ctx.afterCommit(() => syncLastInterest(ctx.env, db, [channelId], trigger));
  // `self.sudo().odoobot_state = 'onboarding_emoji'` (not a tracked field; no mail write override applies)
  await su.cr.query(
    "UPDATE res_users SET odoobot_state = 'onboarding_emoji', write_uid = $2, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1",
    [env.uid, env.uid]);
}
