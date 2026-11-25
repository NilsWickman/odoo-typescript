/**
 * Discuss models' non-stored computes (odoo/addons/mail/models/discuss/): call history duration and name, channel
 * generated avatars. Each body cites its source; branches needing unported data refuse with NotPorted.
 */
import { NotPorted } from "../errors";
import { and, cond, TRUE } from "../orm/domain";
import { registerHooks } from "../orm/hooks";
import { hasGroup, userInfo } from "../orm/env";
import { userFlags } from "../session/user";
import { type Rec, registerDefaults, registerRecordCompute } from "../orm/recompute";
import { binaryBytes } from "../orm/values";
import type { BinaryValue, Environment } from "../orm/types";
import { generateTextAvatarSvg, getRandomUiColorFromSeed, placeholderValue } from "./avatar";
import { defineComputes, filteredAccess, formatDatetime, searchMethod } from "./tail_util";
import { datetimeToString, dbNow, sha512Hex, translate } from "./util";
import { randomBytes, randomInt } from "node:crypto";

/** "YYYY-MM-DD HH:MM:SS" (UTC) to epoch milliseconds. */
function utcMs(value: string): number {
  return Date.parse(`${value.replace(" ", "T")}Z`);
}

defineComputes("discuss.call.history", {
  // discuss_call_history.py:54-58 _compute_duration_hour: (end_dt or Datetime.now() - start_dt) in hours
  duration_hour: async (env, rec) => {
    const start = await rec.get("start_dt");
    if (typeof start !== "string") throw new NotPorted("discuss.call.history.duration_hour without start_dt");
    const end = await rec.get("end_dt");
    // fields.Datetime.now() drops the microseconds (fields_temporal.py Datetime.now)
    const endMs = typeof end === "string" ? utcMs(end) : Math.floor((await dbNow(env)).getTime() / 1000) * 1000;
    return (endMs - utcMs(start)) / 1000 / 3600;
  },
});

registerHooks("discuss.call.history", {
  // discuss_call_history.py:41-52 _compute_display_name: "<channel display_name> - <format_datetime(start_dt, tz=ctx tz)>"
  displayName: async (env, ids) => {
    const rows = (await env.cr.query<{ id: number; channel_id: number; start_dt: string | null }>(
      `SELECT id, channel_id, to_char(start_dt, 'YYYY-MM-DD HH24:MI:SS') AS start_dt FROM discuss_call_history WHERE id = ANY($1::int[])`, [ids])).rows;
    const names = await env.model("discuss.channel").displayName([...new Set(rows.map((r) => r.channel_id))]);
    const tz = typeof env.context.tz === "string" ? env.context.tz : null;
    const out = new Map<number, string>();
    for (const r of rows) out.set(r.id, `${names.get(r.channel_id) ?? ""} - ${await formatDatetime(env, r.start_dt, tz)}`);
    return out;
  },
});

/** discuss_channel.py:25-29 `group_avatar`. */
const GROUP_AVATAR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 530.06 530.06">
<rect width="530.06" height="530.06" fill="#875a7b"/>
<path d="m184.356059,265.030004c-23.740561,0.73266 -43.157922,10.11172 -58.252302,28.136961l-29.455881,0c-12.0169,0 -22.128621,-2.96757 -30.335161,-8.90271s-12.309921,-14.618031 -12.309921,-26.048671c0,-51.730902 9.08582,-77.596463 27.257681,-77.596463c0.87928,0 4.06667,1.53874 9.56217,4.61622s12.639651,6.19167 21.432451,9.34235s17.512401,4.72613 26.158581,4.72613c9.8187,0 19.563981,-1.68536 29.236061,-5.05586c-0.73266,5.4223 -1.0991,10.25834 -1.0991,14.508121c0,20.370061 5.93514,39.127962 17.805421,56.273922zm235.42723,140.025346c0,17.585601 -5.34888,31.470971 -16.046861,41.655892s-24.912861,15.277491 -42.645082,15.277491l-192.122688,0c-17.732221,0 -31.947101,-5.09257 -42.645082,-15.277491s-16.046861,-24.070291 -16.046861,-41.655892c0,-7.7669 0.25653,-15.350691 0.76937,-22.751371s1.53874,-15.387401 3.07748,-23.960381s3.48041,-16.523211 5.82523,-23.850471s5.4955,-14.471411 9.45226,-21.432451s8.49978,-12.89618 13.628841,-17.805421c5.12906,-4.90924 11.393931,-8.82951 18.794611,-11.76037s15.570511,-4.3964 24.509931,-4.3964c1.46554,0 4.61622,1.57545 9.45226,4.72613s10.18492,6.6678 16.046861,10.55136c5.86194,3.88356 13.702041,7.40068 23.520741,10.55136s19.710601,4.72613 29.675701,4.72613s19.857001,-1.57545 29.675701,-4.72613s17.658801,-6.6678 23.520741,-10.55136c5.86194,-3.88356 11.21082,-7.40068 16.046861,-10.55136s7.98672,-4.72613 9.45226,-4.72613c8.93942,0 17.109251,1.46554 24.509931,4.3964s13.665551,6.85113 18.794611,11.76037c5.12906,4.90924 9.67208,10.844381 13.628841,17.805421s7.10744,14.105191 9.45226,21.432451s4.28649,15.277491 5.82523,23.850471s2.56464,16.559701 3.07748,23.960381s0.76937,14.984471 0.76937,22.751371zm-225.095689,-280.710152c0,15.534021 -5.4955,28.796421 -16.486501,39.787422s-24.253401,16.486501 -39.787422,16.486501s-28.796421,-5.4955 -39.787422,-16.486501s-16.486501,-24.253401 -16.486501,-39.787422s5.4955,-28.796421 16.486501,-39.787422s24.253401,-16.486501 39.787422,-16.486501s28.796421,5.4955 39.787422,16.486501s16.486501,24.253401 16.486501,39.787422zm154.753287,84.410884c0,23.300921 -8.24325,43.194632 -24.729751,59.681133s-36.380212,24.729751 -59.681133,24.729751s-43.194632,-8.24325 -59.681133,-24.729751s-24.729751,-36.380212 -24.729751,-59.681133s8.24325,-43.194632 24.729751,-59.681133s36.380212,-24.729751 59.681133,-24.729751s43.194632,8.24325 59.681133,24.729751s24.729751,36.380212 24.729751,59.681133zm126.616325,49.459502c0,11.43064 -4.10338,20.113531 -12.309921,26.048671s-18.318261,8.90271 -30.335161,8.90271l-29.455881,0c-15.094381,-18.025241 -34.511741,-27.404301 -58.252302,-28.136961c11.87028,-17.145961 17.805421,-35.903862 17.805421,-56.273922c0,-4.24978 -0.36644,-9.08582 -1.0991,-14.508121c9.67208,3.3705 19.417361,5.05586 29.236061,5.05586c8.64618,0 17.365781,-1.57545 26.158581,-4.72613s15.936951,-6.26487 21.432451,-9.34235s8.68289,-4.61622 9.56217,-4.61622c18.171861,0 27.257681,25.865561 27.257681,77.596463zm-28.136961,-133.870386c0,15.534021 -5.4955,28.796421 -16.486501,39.787422s-24.253401,16.486501 -39.787422,16.486501s-28.796421,-5.4955 -39.787422,-16.486501s-16.486501,-24.253401 -16.486501,-39.787422s5.4955,-28.796421 16.486501,-39.787422s24.253401,-16.486501 39.787422,-16.486501s28.796421,5.4955 39.787422,16.486501s16.486501,24.253401 16.486501,39.787422z" fill="#ffffff"/>
</svg>`;

/** discuss_channel.py:31-45 avatar_initials: first letters of the first and last words, uppercased. */
export function avatarInitials(name: string): string {
  const words = name.split(/\s+/u).filter((w) => w !== "");
  if (words.length === 0) return "";
  const first = (w: string): string => Array.from(w)[0] ?? "";
  return (first(words[0]!) + (words.length > 1 ? first(words[words.length - 1]!) : "")).toUpperCase();
}

defineComputes("discuss.channel", {
  // discuss_channel.py:310-315 _compute_avatar_128: image_128 or _generate_avatar() (:335-358)
  avatar_128: async (env, rec) => {
    if (rec.id !== null) {
      const image = await env.model("discuss.channel").binaryValue(rec.id, "image_128");
      if (image) return image;
    } else if (await rec.get("image_128")) throw new NotPorted("discuss.channel.avatar_128 of a new channel with an uploaded image");
    // `str(self.id)`: a record not saved yet has a NewId, `NewId_<repr(origin)>` or `NewId_0x<memory address>`
    // (orm/identifiers.py:45-50), which the API corpus compares as a placeholder (harness NORMALIZATION.md N9)
    const seed = rec.id !== null ? String(rec.id)
      : rec.origin !== null ? `NewId_${rec.origin}` : `NewId_0x7f${randomBytes(5).toString("hex")}`;
    const type = await rec.get("channel_type");
    if (type !== "channel" && type !== "group") return null;
    if (type === "group") {
      if ((await rec.get("default_display_mode")) === "video_full_screen") throw new NotPorted("discuss.channel meeting avatar (create_date day)");
      const bgcolor = getRandomUiColorFromSeed(seed);
      return binaryBytes(Buffer.from(GROUP_AVATAR.replace('fill="#875a7b"', `fill="${bgcolor}"`), "utf8"));
    }
    const name = await rec.get("name");
    // a named channel's display_name is its name (:250-254); member-based names are not ported here
    if (rec.id === null && (name === false || name === null || name === "")) {
      // display_name of an unnamed new channel: the name, '' (discuss_channel.py:250-254)
      return generateTextAvatarSvg("", seed);
    }
    if (typeof name !== "string" || name === "") throw new NotPorted("discuss.channel avatar of an unnamed channel (member display name)");
    return generateTextAvatarSvg(Array.from(avatarInitials(name)).slice(0, 1).join(""), seed);
  },
  // discuss_channel.py:317-324 _compute_avatar_cache_key: 'no-avatar' or sha512 of the avatar bytes
  avatar_cache_key: async (_env, rec) => {
    const avatar = await rec.get("avatar_128");
    if (!avatar || typeof avatar !== "object" || !("content" in avatar)) return "no-avatar";
    return sha512Hex(await (avatar as BinaryValue).content());
  },
});

/**
 * mail.guest's `avatar.mixin` (avatar_mixin.py:47-55 _compute_avatar): `image_<size>`, else for a saved guest with a
 * name mail_guest.py:149-155 `_avatar_generate_svg`, the guest's initials over a color seeded from its id
 * (`generate_text_avatar_svg(avatar_initials(name), str(id))`), else the placeholder (avatar_mixin.py:85-90).
 */
defineComputes("mail.guest", Object.fromEntries(["1920", "1024", "512", "256", "128"].map((size) => [`avatar_${size}`, async (env: Environment, rec: Rec) => {
  if (rec.id === null) {
    // a NewId is falsy: the image or the placeholder
    if (await rec.get(`image_${size}`)) throw new NotPorted(`mail.guest.avatar_${size} of a new guest with an image`);
    return placeholderValue("base/static/img/avatar_grey.png");
  }
  const image = await env.model("mail.guest").binaryValue(rec.id, `image_${size}`);
  if (image) return image;
  const name = await rec.get("name");
  if (typeof name === "string" && name !== "") return generateTextAvatarSvg(avatarInitials(name), String(rec.id));
  return placeholderValue("base/static/img/avatar_grey.png");
}])));

registerDefaults("discuss.category", {
  // discuss_category.py:14-15 _default_sequence: the highest sequence (as the user) plus one
  sequence: async (env) => {
    const [top] = await env.model("discuss.category").search(TRUE, { order: "sequence desc", limit: 1 });
    if (top === undefined) return 1;
    const row = (await env.cr.query<{ sequence: number | null }>("SELECT sequence FROM discuss_category WHERE id = $1", [top])).rows[0];
    return (row?.sequence || 0) + 1;
  },
});

/** discuss_call_history.py:60-76 _compute_recording_media with mail_call_artifact.py:101-108 _is_recording_media. */
function recordingMedia(which: "audio" | "video" | "any") {
  return async (env: Environment, rec: Rec): Promise<boolean> => {
    const mimetypes: string[] = [];
    for (const artifact of await rec.rels("artifact_ids")) {
      if (await artifact.get("recording_upload_pending")) continue;
      const media = await artifact.rel("media_id");
      if (!media) continue;
      const mimetype = (await env.cr.query<{ mimetype: string | null }>("SELECT mimetype FROM ir_attachment WHERE id = $1", [media.origin])).rows[0]?.mimetype;
      if (mimetype && (mimetype.startsWith("audio/") || mimetype.startsWith("video/"))) mimetypes.push(mimetype);
    }
    const audio = mimetypes.some((m) => m.startsWith("audio/")), video = mimetypes.some((m) => m.startsWith("video/"));
    return which === "audio" ? audio : which === "video" ? video : audio || video;
  };
}
defineComputes("discuss.call.history", {
  has_audio: recordingMedia("audio"),
  has_video: recordingMedia("video"),
  has_recording: recordingMedia("any"),
});

defineComputes("mail.call.artifact", {
  // mail_call_artifact.py:83-91 _compute_media_id: the attachment of the artifact (searched as the user)
  media_id: async (env, rec) => {
    if (rec.id === null) return null;
    const found = await env.model("ir.attachment").search(and([cond("res_model", "=", "mail.call.artifact"), cond("res_id", "in", [rec.id])]));
    if (found.length > 1) throw new NotPorted("mail.call.artifact with several media attachments (ValueError)");
    return found[0] ?? null;
  },
});

registerRecordCompute("discuss.channel", {
  // discuss_channel.py:390-396 _compute_member_indices (stored, precompute, no depends: frozen at creation): None for
  // every channel that is not a chat. A chat's indices come from its members (`_member_indices`, :385-388), which the
  // create override adds after the INSERT here (src/mail/channel_write.ts): refused.
  member_indices: async (_env, rec) => {
    if (rec.id !== null) throw new NotPorted("discuss.channel.member_indices recomputed on a saved channel");
    if ((await rec.get("channel_type")) === "chat") throw new NotPorted("discuss.channel.member_indices of a new chat (its members)");
    return null;
  },
});

registerDefaults("discuss.channel", {
  // discuss_channel.py:95-100 _generate_random_token: 10 characters of the non-ambiguous alphabet
  uuid: async () => {
    const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHIJKLMNPQRSTUVWXYZ23456789";
    return Array.from({ length: 10 }, () => alphabet[randomInt(alphabet.length)]).join("");
  },
  // discuss_channel.py:150: fields.Datetime.now() - timedelta(seconds=1)
  last_interest_dt: async (env) => datetimeToString(new Date(Math.floor((await dbNow(env)).getTime() / 1000) * 1000 - 1000)),
});

/** discuss_channel.py:424-433 _compute_self_member_id (compute_sudo): the highest member id of the current persona. */
async function selfMember(env: Environment, channel: number | null): Promise<number | null> {
  if (channel === null) return null;
  // res_users.py:716-719 _get_current_persona: the user, or the context guest for the public user
  if ((await userFlags(env.cr, env.uid)).isPublic) throw new NotPorted("discuss.channel membership of a guest persona");
  const partner = (await userInfo(env)).partnerId;
  const row = (await env.cr.query<{ id: number | null }>(
    "SELECT max(id) AS id FROM discuss_channel_member WHERE channel_id = $1 AND partner_id = $2", [channel, partner])).rows[0];
  return row?.id ?? null;
}
defineComputes("discuss.channel", {
  self_member_id: async (env, rec) => selfMember(env, rec.origin),
  // discuss_channel.py:398-402 _compute_is_member
  is_member: async (env, rec) => (await selfMember(env, rec.origin)) !== null,
  // discuss_channel.py:292-296 _compute_can_join
  can_join: async (env, rec) => (await selfMember(env, rec.origin)) === null && (await rec.get("channel_type")) !== "chat",
  // discuss_channel.py:298-302 _compute_can_leave
  can_leave: async (env, rec) => (await selfMember(env, rec.origin)) !== null && (await rec.get("channel_type")) !== "chat",
});

defineComputes("discuss.channel", {
  // discuss_channel.py:442-450 _compute_can_self_edit_readonly_channel: an admin/owner member, or an admin user
  can_self_edit_readonly_channel: async (env, rec) => {
    const member = await selfMember(env, rec.origin);
    if (member !== null) {
      const role = (await env.cr.query<{ channel_role: string | null }>("SELECT channel_role FROM discuss_channel_member WHERE id = $1", [member])).rows[0]?.channel_role;
      if (role === "admin" || role === "owner") return true;
    }
    // res_users.py:1292-1294 _is_admin
    return env.uid === 1 || hasGroup(env.withUser(env.uid).sudo(), "base.group_erp_manager");
  },
});

defineComputes("discuss.channel", {
  // discuss_channel.py:304-308 _compute_is_editable: has_access('write')
  // a record not saved yet: the model-level check (models.py has_access, `not origin`: the access domain is not FALSE)
  is_editable: async (env, rec) => rec.origin === null
    ? (await env.model("discuss.channel").accessDomain("write"))?.kind !== "false"
    : (await filteredAccess(env, "discuss.channel", [rec.origin], "write")).has(rec.origin),
});


defineComputes("discuss.channel.member", {
  // discuss_channel_member.py:132-136 _compute_can_unlink: has_access('unlink')
  can_unlink: async (env, rec) => rec.origin !== null && (await filteredAccess(env, "discuss.channel.member", [rec.origin], "unlink")).has(rec.origin),
});

registerHooks("discuss.channel.member", {
  // discuss_channel_member.py:227-234 _compute_display_name
  displayName: async (env, ids) => {
    const rows = (await env.cr.query<{ id: number; partner: string | null; guest: string | null; channel_id: number }>(
      `SELECT m.id, p.name AS partner, g.name AS guest, m.channel_id FROM discuss_channel_member m
         LEFT JOIN res_partner p ON p.id = m.partner_id LEFT JOIN mail_guest g ON g.id = m.guest_id WHERE m.id = ANY($1::int[])`, [ids])).rows;
    const channels = await env.model("discuss.channel").displayName([...new Set(rows.map((r) => r.channel_id))]);
    const out = new Map<number, string>();
    for (const r of rows) {
      const template = translate(env, "“%(member_name)s” in “%(channel_name)s”");
      out.set(r.id, template.replace("%(member_name)s", r.partner || r.guest || "False").replace("%(channel_name)s", channels.get(r.channel_id) ?? "False"));
    }
    return out;
  },
  search: {
    // discuss_channel_member.py:150-156 _search_is_self ('in' only)
    is_self: searchMethod("discuss.channel.member", "is_self", async (env, operator) => {
      if (operator !== "in") return null;
      if ((await userFlags(env.cr, env.uid)).isPublic) throw new NotPorted("discuss.channel.member.is_self of a guest persona");
      return cond("partner_id", "=", (await userInfo(env)).partnerId);
    }),
  },
});
defineComputes("discuss.channel.member", {
  // discuss_channel_member.py:138-148 _compute_is_self
  is_self: async (env, rec) => {
    if ((await userFlags(env.cr, env.uid)).isPublic) throw new NotPorted("discuss.channel.member.is_self of a guest persona");
    return (await rec.get("partner_id")) === (await userInfo(env)).partnerId;
  },
});

registerHooks("discuss.channel", {
  search: {
    // discuss_channel.py:435-440 _search_self_member_id
    self_member_id: searchMethod("discuss.channel", "self_member_id", async (_env, operator, operand) => {
      if (operator !== "in" && operator !== "any" && operator !== "any!") return null;
      const op = operator === "any!" ? "any!" : "any";
      return cond("channel_member_ids", op, and([cond("is_self", "=", true), cond("id", "in", operand)]));
    }),
  },
});
