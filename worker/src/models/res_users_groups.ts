/**
 * Writing the groups of users: `res.users` write of `group_ids` (Settings -> Users, the access rights widget sends
 * the groups as commands) and of `notification_type` (the user's preference, whose inverse writes the groups), and
 * `res.groups` write of `user_ids` (Settings -> Groups). The Python MRO, outermost first:
 *   - res.users: discuss res_users.py:19-29 (super, then the channels of the linked groups auto-subscribe their
 *     users), mail res_users.py:209-266 (the portal access log, the notification type's Store to the user's bus),
 *     mail.thread (no tracked field here), base res_users.py:682-733 (the old groups, super, `_log_group_changes`,
 *     which mail res_users.py:290-307 turns into a tracking message on the user per changed user);
 *   - res.groups: discuss res_groups.py:9-13 (the channels of the group's implied groups), base res_groups.py:223-273
 *     (the users' group changes logged as above, `_apply_group_regular`, the share recomputation when the internal
 *     groups change).
 * The ORM core writes the relation and recomputes the stored fields depending on it (`share`, `notification_type`,
 * mail res_users.py:94-114). Refused before anything is written: a channel that would auto-subscribe a member
 * (`_subscribe_users_automatically` is not ported), a change of portal access (its message_post), the log in a
 * language the template is translated to, and the commands creating or editing groups.
 */
import { NotPorted, ValidationError } from "../errors";
import { requestOfCursor } from "../http/context";
import { busSend } from "../mail/busnotify";
import { messageLogBatch } from "../mail/message";
import { storeVersion } from "../bus/presence";
import { parseCommands } from "../orm/commands";
import { cond } from "../orm/domain";
import { impliedGroups, groupsImplying } from "../orm/env";
import { registerHooks } from "../orm/hooks";
import { checkWriteAccess, registerOverrides, write, type WriteFn } from "../orm/write";
import { RecomputeQueue } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { LIGHT_GROUP_XMLIDS } from "../session/user";
import { fieldOrder } from "./base_import";
import { hierarchy } from "./res_groups_hierarchy";
import { PySet } from "./pyset";
import { forgetX2manyOrder } from "../orm/x2many_order";
import { pyStrRepr, translate } from "./util";

type Groups = Map<number, number[]>;

/** `all_implied_ids` of a set of groups (res_groups.py:342-346): the groups and their transitively implied groups. */
async function closure(env: Environment, ids: Iterable<number>): Promise<Set<number>> {
  const implied = await impliedGroups(env);
  const out = new Set<number>();
  const todo = [...ids];
  while (todo.length) {
    const g = todo.pop()!;
    if (out.has(g)) continue;
    out.add(g);
    todo.push(...(implied.get(g) ?? []));
  }
  return out;
}

async function groupId(env: Environment, xmlid: string): Promise<number> {
  const id = await env.reg.xmlid(env.cr, xmlid);
  if (id === null) throw new NotPorted(`${xmlid} missing`);
  return id;
}

/** The users' explicit groups (`group_ids`, res_groups_users_rel), all users when `uids` is null. */
async function directGroups(env: Environment, uids: readonly number[] | null): Promise<Groups> {
  const rows = (await env.cr.query<{ uid: number; gid: number }>(
    `SELECT uid, gid FROM res_groups_users_rel ${uids ? "WHERE uid = ANY($1::int[])" : ""} ORDER BY uid, gid`, uids ? [[...uids]] : [])).rows;
  const out: Groups = new Map((uids ?? []).map((u) => [u, []]));
  for (const r of rows) (out.get(r.uid) ?? out.set(r.uid, []).get(r.uid)!).push(r.gid);
  return out;
}

/** The users' groups after the commands (fields_relational.py Many2many.write_batch); creating or editing groups refuses. */
function applyCommands(before: Groups, value: unknown, field: string): Groups {
  if (Array.isArray(value) && value.some((c) => !Array.isArray(c))) {
    // discuss res_users.py:23-25 reads `command[0]` of each item: a plain list of ids is a TypeError there
    throw new NotPorted(`${field} written as a plain list of ids`);
  }
  const commands = parseCommands(value, field);
  const out: Groups = new Map();
  for (const [uid, gids] of before) {
    let cur = [...gids];
    for (const c of commands) {
      if (c.op === "link") { if (!cur.includes(c.id)) cur.push(c.id); }
      else if (c.op === "unlink") cur = cur.filter((g) => g !== c.id);
      else if (c.op === "clear") cur = [];
      else if (c.op === "set") cur = [...new Set(c.ids)];
      else throw new NotPorted(`${field} command ${c.op} (a group created, edited or deleted through a user)`);
    }
    out.set(uid, cur);
  }
  return out;
}

/**
 * discuss_channel.py:831-856 `_subscribe_users_automatically` of the channels whose groups are among `groups`: the
 * active partners of the channels' users (`group_ids.all_user_ids`, archived users included) who are not members.
 * Not ported: refused before the write when there is one, with the groups the users will have (`after`).
 */
async function refuseSubscriptions(env: Environment, groups: ReadonlySet<number>, after: Groups): Promise<void> {
  if (!groups.size) return;
  const channels = (await env.cr.query<{ c: number; g: number }>(
    "SELECT discuss_channel_id AS c, res_groups_id AS g FROM discuss_channel_res_groups_rel WHERE discuss_channel_id IN (SELECT discuss_channel_id FROM discuss_channel_res_groups_rel WHERE res_groups_id = ANY($1::int[]))",
    [[...groups]])).rows;
  if (!channels.length) return;
  const all = await directGroups(env, null);
  for (const [uid, gids] of after) all.set(uid, gids);
  const byChannel = new Map<number, Set<number>>();
  for (const r of channels) (byChannel.get(r.c) ?? byChannel.set(r.c, new Set()).get(r.c)!).add(r.g);
  const partners = new Map((await env.cr.query<{ id: number; partner_id: number; active: boolean | null }>(
    "SELECT u.id, u.partner_id, p.active FROM res_users u JOIN res_partner p ON p.id = u.partner_id")).rows.map((r) => [r.id, r]));
  for (const [channel, cgroups] of byChannel) {
    const members = new Set((await env.cr.query<{ p: number }>(
      "SELECT partner_id AS p FROM discuss_channel_member WHERE channel_id = $1 AND partner_id IS NOT NULL", [channel])).rows.map((r) => r.p));
    for (const [uid, gids] of all) {
      const p = partners.get(uid);
      if (!p || !p.active || members.has(p.partner_id)) continue;
      const mine = await closure(env, gids);
      if ([...cgroups].some((g) => mine.has(g))) {
        throw new NotPorted(`discuss.channel ${channel} would auto-subscribe user ${uid} (_subscribe_users_automatically)`);
      }
    }
  }
}

/** mail res_users.py:209-239: a change of portal access posts a message (not ported). A user who ends up both
 *  internal and portal is left to the constraint (`_check_disjoint_groups`, raised inside super().write first). */
async function refusePortalChange(env: Environment, before: Groups, after: Groups): Promise<void> {
  if (env.context["mail_create_nolog"] || env.context["mail_notrack"]) return;
  const portal = await groupId(env, "base.group_portal");
  const types = await userTypeGroups(env);
  for (const [uid, gids] of after) {
    const now = await closure(env, gids), was = await closure(env, before.get(uid) ?? []);
    if (now.has(portal) === was.has(portal)) continue;
    if (types.filter((t) => now.has(t)).length > 1) continue;
    throw new NotPorted(`res.users ${uid}: portal access ${now.has(portal) ? "granted" : "revoked"} (mail res_users.py:226-239 message_post)`);
  }
}

/** res_groups.py:381-389 `_get_user_type_groups`: base.group_user, base.group_portal, base.group_public. */
async function userTypeGroups(env: Environment): Promise<number[]> {
  const out: number[] = [];
  for (const x of ["base.group_user", "base.group_portal", "base.group_public"]) {
    const id = await env.reg.xmlid(env.cr, x);
    if (id !== null) out.push(id);
  }
  return out;
}

/** The groups of `ids` in res.groups `_order` ('privilege_id, sequence, name, id', res_groups.py:19). */
async function orderedGroups(env: Environment, ids: readonly number[]): Promise<number[]> {
  if (!ids.length) return [];
  return env.sudo().model("res.groups").search(cond("id", "in", [...ids]), { order: "privilege_id, sequence, name, id" });
}

/**
 * `user.all_group_ids & user_type_groups` (res_users.py:636): `group_ids.all_implied_ids` mapped over the user's
 * groups in `_order`, each group then its implied groups sorted by id (res_groups.py:346, set_expression.py:168-180),
 * in order of first appearance, kept when a user type group; then the ValidationError of the two constraints.
 */
async function disjointError(env: Environment, uid: number): Promise<ValidationError | null> {
  const types = await userTypeGroups(env);
  const implied = await impliedGroups(env);
  const all: number[] = [];
  for (const g of await orderedGroups(env, (await directGroups(env, [uid])).get(uid) ?? [])) {
    const sup = [...(await closure(env, implied.get(g) ?? []))].filter((x) => x !== g).sort((a, b) => a - b);
    for (const x of [g, ...sup]) if (!all.includes(x)) all.push(x);
  }
  const disjoint = all.filter((g) => types.includes(g));
  if (disjoint.length <= 1) return null;
  if (env.lang && env.lang !== "en_US") throw new NotPorted(`exclusive groups ValidationError in ${env.lang}`);
  const name = (await env.cr.query<{ name: string | null }>(
    "SELECT p.name FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1", [uid])).rows[0]?.name ?? "";
  const names = await env.sudo().model("res.groups").displayName(disjoint);
  return new ValidationError(`User ${pyStrRepr(name)} cannot be at the same time in exclusive groups ${disjoint.map((g) => pyStrRepr(names.get(g) ?? "")).join(", ")}.`);
}

registerOverrides("res.users", {
  constraints: [
    // res_users.py:644-649 _check_at_least_one_administrator (constraint methods run in name order)
    { fields: ["group_ids"], fn: async (env) => {
      const system = await groupId(env, "base.group_system");
      const users = (await env.cr.query("SELECT 1 FROM res_groups_users_rel r JOIN res_users u ON u.id = r.uid WHERE r.gid = $1 AND u.active LIMIT 1", [system])).rows;
      if (!users.length) {
        if (env.lang && env.lang !== "en_US") throw new NotPorted(`administrator ValidationError in ${env.lang}`);
        throw new ValidationError("You must have at least an administrator user.");
      }
    } },
    // res_users.py:629-642 _check_disjoint_groups
    { fields: ["group_ids"], fn: async (env, ids) => {
      for (const uid of ids) {
        const error = await disjointError(env, uid);
        if (error) throw error;
      }
    } },
    // res_users.py:617-627 _check_company
    { fields: ["company_id", "company_ids"], fn: async (env, ids) => {
      if (!ids.length) return;
      const rows = (await env.cr.query<{ id: number; company_id: number | null; company_name: string | null }>(
        `SELECT u.id, u.company_id, c.name AS company_name
           FROM res_users u
           LEFT JOIN res_company c ON c.id = u.company_id
          WHERE u.id = ANY($1::int[])
            AND u.company_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM res_company_users_rel r
               WHERE r.user_id = u.id AND r.cid = u.company_id
            )
          ORDER BY u.id`,
        [[...ids]],
      )).rows;
      if (rows.length) {
        const companyName = rows[0]!.company_name ?? "";
        const msg = env.lang && env.lang !== "en_US"
          ? translate(env, "The chosen company (%s) is not in the allowed companies for this user", "base").replace("%s", companyName)
          : `The chosen company (${companyName}) is not in the allowed companies for this user`;
        throw new ValidationError(msg);
      }
    } },
  ],
});

/**
 * The log is rendered in the user's language (ir.qweb `_render` of the view's translated arch): the template's
 * terms are ported in English only, so a language the view has a translation for refuses. Without one (poc_erp:
 * en_US only, also with fr_FR active) the English arch is rendered, with the groups' names in the language.
 */
async function refuseTranslatedLog(env: Environment): Promise<void> {
  const lang = env.lang ?? "en_US";
  if (lang === "en_US") return;
  const translated = (await env.cr.query(
    `SELECT 1 FROM ir_ui_view v JOIN ir_model_data d ON d.model = 'ir.ui.view' AND d.res_id = v.id
      WHERE d.module = 'mail' AND d.name = 'group_change_template' AND v.arch_db ? $1`, [lang])).rows.length > 0;
  if (translated) throw new NotPorted(`res.users group change log in ${lang} (mail.group_change_template translation)`);
}

/** The group change log's body (mail/data/mail_templates_chatter.xml:86-104 `mail.group_change_template`, rendered
 *  by ir.qweb: the whitespace before a `t` directive and at the end of a `t` is dropped). */
function groupChangeBody(added: readonly [number, string][], removed: readonly [number, string][]): string {
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;").replace(/'/g, "&#39;");
  const part = (label: string, groups: readonly [number, string][]): string => `\n        <span>${label}</span>\n        <ul>`
    + groups.map(([id, name]) => `\n                <li><a href="#" data-oe-model="res.groups" data-oe-id="${id}">${esc(name)}</a></li>`).join("")
    + "\n        </ul>";
  return `<div class="o_mail_group_log">${added.length ? part("Added groups:", added) : ""}${removed.length ? part("Removed groups:", removed) : ""}\n</div>`;
}

/**
 * mail res_users.py:290-307 `_log_group_changes`: a tracking message on each user whose explicit groups changed, the
 * added and removed groups sorted by `display_name.lower()`, `_message_log_batch` in the users' order.
 */
async function logGroupChanges(env: Environment, users: readonly number[], before: Groups): Promise<void> {
  const after = await directGroups(env, users);
  const bodies = new Map<number, string>();
  for (const uid of users) {
    if (bodies.has(uid)) continue;
    const old = new Set(before.get(uid) ?? []), now = new Set(after.get(uid) ?? []);
    const added = [...now].filter((g) => !old.has(g)), removed = [...old].filter((g) => !now.has(g));
    if (!added.length && !removed.length) continue;
    const names = await env.sudo().model("res.groups").displayName([...added, ...removed]);
    const sorted = (ids: number[]): [number, string][] => ids.map((id): [number, string] => [id, names.get(id) ?? ""])
      .sort(([, a], [, b]) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
    bodies.set(uid, groupChangeBody(sorted(added), sorted(removed)));
  }
  if (bodies.size) await messageLogBatch(env, "res.users", bodies, { messageType: "tracking" });
}

/** `self.env.context.get('no_group_change_log') is not NO_GROUP_CHANGE_LOG`: the sentinel is a Python object no RPC
 *  context can carry, so a client's write always logs (the port's own inverse writes the relation directly). */
function logsGroups(): boolean {
  return true;
}

/**
 * The res.users write when `group_ids` or `notification_type` is written (src/models/res_users_prefs.ts dispatches
 * here after base's `active` checks): the refusals first, then `next` (the ORM core: relation, recomputations,
 * constraints, the notification type's inverse), the group log, and the notification type's Store.
 */
export async function groupsWrite(env: Environment, ids: readonly number[], vals: Record<string, unknown>, next: WriteFn): Promise<void> {
  const keys = Object.keys(vals);
  // BaseModel.write's access checks (inside super()) come before anything the overrides do
  await checkWriteAccess(env, "res.users", ids, keys);
  const hasGroups = "group_ids" in vals, hasNotification = "notification_type" in vals;
  if (hasNotification && keys.length > 1) throw new NotPorted(`res.users write of notification_type with ${keys.filter((k) => k !== "notification_type").join(", ")} (the Store's written fields)`);
  const before = await directGroups(env, ids);
  if (hasGroups) {
    await refuseTranslatedLog(env);
    const after = applyCommands(before, vals["group_ids"], "res.users.group_ids");
    // discuss res_users.py:22-27: the groups linked or set, with their implied groups
    const commands = parseCommands(vals["group_ids"], "res.users.group_ids");
    const linked = commands.flatMap((c) => (c.op === "link" ? [c.id] : c.op === "set" ? [...c.ids] : []));
    if (vals["group_ids"]) await refuseSubscriptions(env, await closure(env, linked), after);
    await refusePortalChange(env, before, after);
  }
  // mail res_users.py:221-222: the users whose notification type changes
  let modified: number[] = [];
  const written: Record<string, string[]> = {};
  if (hasNotification) {
    const rows = (await env.cr.query<{ id: number; notification_type: string | null; write_uid: number | null }>(
      "SELECT id, notification_type, write_uid FROM res_users WHERE id = ANY($1::int[]) ORDER BY id", [[...ids]])).rows;
    modified = ids.filter((id, i) => ids.indexOf(id) === i && rows.find((r) => r.id === id)?.notification_type !== vals["notification_type"]);
    // mail models.py:29-34 Base._flush marks the flushed fields of the transaction, in `_fields` order: the write's
    // log columns (write_uid when it changes) and the changed notification type
    const order = (await fieldOrder(env))["res.users"] ?? [];
    for (const r of rows) {
      written[String(r.id)] = order.filter((n) => (n === "write_uid" && r.write_uid !== env.uid) || n === "write_date"
        || (n === "notification_type" && modified.includes(r.id)));
    }
  }
  await next(env, ids, vals);
  // res_users.py:721-723 `invalidate_all` after a write of the groups
  if ("group_ids" in vals && ids.length) forgetX2manyOrder(env.cr);
  if (hasGroups && logsGroups()) await logGroupChanges(env, ids, before);
  // mail res_users.py:260-262: Store(bus_channel=user).add(user, ["notification_type"])
  if (modified.length) {
    const ctx = requestOfCursor(env.cr);
    if (!ctx) throw new NotPorted("res.users notification_type Store outside a request");
    for (const uid of modified) {
      const value = (await env.cr.query<{ n: string }>("SELECT notification_type AS n FROM res_users WHERE id = $1", [uid])).rows[0]?.n ?? false;
      await busSend(ctx, env, { model: "res.users", id: uid }, "mail.record/insert", {
        "res.users": [{ id: uid, notification_type: value }],
        __store_version__: await storeVersion(env.cr, { "res.users": written }),
      });
    }
  }
}

/**
 * res_groups.py:458-472 `_apply_group_regular` after a write of `user_ids` only: the hierarchy did not change, so the
 * regular group's implying groups are what it was given last. Checked here: a template where they differ (Odoo would
 * write them) refuses.
 */
export async function checkGroupRegular(env: Environment): Promise<void> {
  const ids = await regularImplyingIds(env);
  if (ids === null) return;
  const regular = (await env.reg.xmlid(env.cr, "base.group_user_regular"))!;
  const current = new Set((await env.cr.query<{ gid: number }>("SELECT gid FROM res_groups_implied_rel WHERE hid = $1", [regular])).rows.map((r) => r.gid));
  if (ids.length !== current.size || ids.some((g) => !current.has(g))) throw new NotPorted("res.groups _apply_group_regular would rewrite base.group_user_regular's implying groups");
}

/**
 * res_groups.py:437-472 `_apply_group_regular`: base.group_user_regular implied by the regular groups (the least
 * privileged of each privilege); written (`implied_by_ids = [Command.set(ids)]`) when they differ. The light groups
 * are LIGHT_GROUP_XMLIDS (`_get_light_group_xmlids` of poc_erp's modules; a module adding its own is not known here).
 */
export async function applyGroupRegular(env: Environment): Promise<void> {
  const ids = await regularImplyingIds(env);
  if (ids === null) return;
  const regular = (await env.reg.xmlid(env.cr, "base.group_user_regular"))!;
  const current = new Set((await env.cr.query<{ gid: number }>("SELECT gid FROM res_groups_implied_rel WHERE hid = $1", [regular])).rows.map((r) => r.gid));
  if (ids.length === current.size && ids.every((g) => current.has(g))) return;
  await write(env.sudo().withContext({ ...env.context, apply_regular_group: true }), "res.groups", [regular], { implied_by_ids: [[6, 0, ids]] });
}

/** res_groups.py:414-419 `_get_internal_group_ids`: base.group_user and every group implying it. */
export async function internalGroups(env: Environment): Promise<string> {
  const user = await env.reg.xmlid(env.cr, "base.group_user");
  if (user === null) return "";
  const r = await env.cr.query<{ id: number }>(
    `WITH RECURSIVE g(id) AS (SELECT $1::int UNION SELECT r.gid FROM res_groups_implied_rel r JOIN g ON r.hid = g.id) SELECT id FROM g ORDER BY id`, [user]);
  return r.rows.map((x) => x.id).join(",");
}

/** res_users.py:513-560 `_recompute_user_share`: res.users.share and res.partner.partner_share in bulk. */
export async function recomputeUserShare(env: Environment): Promise<void> {
  const internal = (await internalGroups(env)).split(",").filter(Boolean).map(Number);
  await env.cr.query(`WITH _share AS (
      SELECT u.id, any_value(r.gid) is null as share FROM res_users u
        LEFT JOIN res_groups_users_rel r ON r.uid = u.id AND r.gid = ANY($1::int[]) GROUP BY u.id)
    UPDATE res_users u SET share = s.share FROM _share s WHERE s.id = u.id AND s.share IS DISTINCT FROM u.share`, [internal]);
  await env.cr.query(`WITH _share AS (
      SELECT p.id, any_value(u.id) IS NULL as partner_share FROM res_partner p
        LEFT JOIN res_users u ON u.partner_id = p.id AND u.share IS NOT TRUE GROUP BY p.id)
    UPDATE res_partner p SET partner_share = s.partner_share FROM _share s WHERE s.id = p.id AND s.partner_share IS DISTINCT FROM p.partner_share`);
  env.cache.delete("orm.users");
}

/** res_partner.py:533-539 `_compute_partner_share` of the users' partners, written (see res.groups create). */
async function writePartnerShare(env: Environment, users: readonly number[]): Promise<void> {
  const superPartner = (await env.cr.query<{ p: number }>("SELECT partner_id AS p FROM res_users WHERE id = 1")).rows[0]?.p ?? null;
  const rows = (await env.cr.query<{ id: number; share: boolean }>(
    `SELECT p.id, NOT EXISTS (SELECT 1 FROM res_users u WHERE u.partner_id = p.id AND u.active AND u.share IS NOT TRUE) AS share
       FROM res_partner p WHERE p.id IN (SELECT partner_id FROM res_users WHERE id = ANY($1::int[])) ORDER BY p.id`, [users])).rows;
  for (const r of rows) {
    await env.cr.query("UPDATE res_partner SET partner_share = $2, write_uid = $3, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1",
      [r.id, r.id === superPartner ? false : r.share, env.uid]);
  }
}

/** The groups that should imply base.group_user_regular (`_apply_group_regular`'s `ids`), or null without that group. */
async function regularImplyingIds(env: Environment): Promise<number[] | null> {
  const regular = await env.reg.xmlid(env.cr, "base.group_user_regular");
  if (regular === null) return null;
  const light = new Set<number>();
  for (const x of LIGHT_GROUP_XMLIDS) {
    const id = await env.reg.xmlid(env.cr, x);
    if (id !== null) light.add(id);
  }
  const data = await hierarchy(env) as { groups: Record<string, { privilege_id: number | false; implied_ids: number[] }>; privileges: Record<string, { group_ids: number[] }> };
  const all = Object.keys(data.groups).map(Number);
  const regularIds = new Set(all.filter((g) => !light.has(g) && g !== regular));
  const container = await env.reg.xmlid(env.cr, "base.default_user_group");
  if (container !== null) regularIds.delete(container);
  const key = (g: number): number => {
    const pid = data.groups[String(g)]!.privilege_id;
    return pid ? data.privileges[String(pid)]!.group_ids.indexOf(g) : 0;
  };
  // sorted() is stable over the set's order; which group is kept per privilege only depends on the keys
  const sorted = [...regularIds].sort((a, b) => key(a) - key(b));
  const privileges = new Set<number>();
  const ids: number[] = [];
  for (const g of sorted) {
    const pid = data.groups[String(g)]!.privilege_id;
    if (!pid || !data.groups[String(g)]!.implied_ids.some((i) => regularIds.has(i))) ids.push(g);
    else if (!privileges.has(pid)) { ids.push(g); privileges.add(pid); }
  }
  return ids;
}

/** The active users of a group (`group.user_ids.ids` read as superuser: res.users `_order` 'name, login'). */
async function groupUsers(env: Environment, gid: number): Promise<number[]> {
  const ids = (await env.cr.query<{ uid: number }>("SELECT uid FROM res_groups_users_rel WHERE gid = $1", [gid])).rows.map((r) => r.uid);
  if (!ids.length) return [];
  return env.sudo().model("res.users").search(cond("id", "in", ids), { order: "name, login" });
}

registerOverrides("res.groups", {
  // res_groups.py:276-282 create: `_apply_group_regular`, then the share recomputation when the internal groups changed
  create: async (env, valsList, next) => {
    const before = await internalGroups(env);
    const ids = await next(env, valsList);
    // the members' `group_ids` changed (the many2many's inverse): res.users.share (depends on group_ids,
    // res_users.py:505) and res.partner.partner_share (depends on user_ids.share, res_partner.py:533) are recomputed
    // at the flush. Measured on Odoo's install of Maintenance (data files): the users' share is cached and unchanged,
    // not written; their partners' partner_share is not cached, so it is written (write_date, the flushing uid)
    const members = (await env.cr.query<{ uid: number }>("SELECT DISTINCT uid FROM res_groups_users_rel WHERE gid = ANY($1::int[]) ORDER BY uid", [ids])).rows.map((r) => r.uid);
    if (members.length) await writePartnerShare(env, members);
    await applyGroupRegular(env);
    if (before !== await internalGroups(env)) await recomputeUserShare(env);
    return ids;
  },
  write: async (env, ids, vals, next) => {
    const keys = Object.keys(vals);
    // the port's own writes of other keys (res.config.settings `_apply_group`: implied_ids) keep the ORM core as
    // before; a client's write of them refuses in the guard (src/orm/override_status.ts)
    if (!keys.includes("user_ids")) return next(env, ids, vals);
    if (keys.length !== 1) throw new NotPorted(`res.groups write of ${keys.join(", ")} (res_groups.py:223)`);
    await checkWriteAccess(env, "res.groups", ids, keys);
    await refuseTranslatedLog(env);
    // the users' groups after the commands, for the refusals before the write
    const commands = parseCommands(vals["user_ids"], "res.groups.user_ids");
    if (commands.some((c) => c.op === "create" || c.op === "update" || c.op === "delete")) throw new NotPorted("res.groups user_ids command creating, editing or deleting a user");
    const oldUsers = new Map<number, number[]>();
    for (const gid of ids) oldUsers.set(gid, await groupUsers(env, gid));
    const members = new Map<number, Set<number>>();
    for (const gid of ids) {
      const raw = (await env.cr.query<{ uid: number }>("SELECT uid FROM res_groups_users_rel WHERE gid = $1", [gid])).rows.map((r) => r.uid);
      let cur = new Set(raw);
      for (const c of commands) {
        if (c.op === "link") cur.add(c.id);
        else if (c.op === "unlink") cur.delete(c.id);
        else if (c.op === "clear") cur = new Set();
        else if (c.op === "set") cur = new Set(c.ids);
      }
      members.set(gid, cur);
    }
    const touched = new Set([...members.values()].flatMap((s) => [...s]));
    for (const gid of ids) for (const u of oldUsers.get(gid) ?? []) touched.add(u);
    const before = await directGroups(env, [...touched]);
    const after: Groups = new Map();
    for (const [uid, gids] of before) {
      const set = new Set(gids);
      for (const gid of ids) { if (members.get(gid)!.has(uid)) set.add(gid); else set.delete(gid); }
      after.set(uid, [...set]);
    }
    // discuss res_groups.py:11-12 `self.all_implied_ids`
    if (vals["user_ids"]) await refuseSubscriptions(env, await closure(env, ids), after);
    await refusePortalChange(env, before, after);
    await next(env, ids, vals);
    // res_groups.py:262-265 `_clear_caches` (invalidate_all) after the write of a non-superuser
    if (ids.length && !env.su) forgetX2manyOrder(env.cr);
    // fields_relational.py Many2many.write_batch: the inverse field changes too, so the users' stored fields depending
    // on `group_ids` are recomputed (share, mail's notification_type)
    const queue = new RecomputeQueue(env);
    await queue.modified("res.users", [...touched], ["group_ids"]);
    await queue.run();
    // res_groups.py:241-258: the changes per user, in the order of the groups and of Python's set differences
    const changes = new Map<number, { added: number[]; removed: number[] }>();
    for (const gid of ids) {
      const old = PySet.fromList(oldUsers.get(gid) ?? []), now = PySet.fromList(await groupUsers(env, gid));
      for (const u of now.difference(old).order()) (changes.get(u) ?? changes.set(u, { added: [], removed: [] }).get(u)!).added.push(gid);
      for (const u of old.difference(now).order()) (changes.get(u) ?? changes.set(u, { added: [], removed: [] }).get(u)!).removed.push(gid);
    }
    const users = [...changes.keys()];
    const current = await directGroups(env, users);
    const oldGroups: Groups = new Map();
    for (const [uid, ch] of changes) {
      const set = new Set((current.get(uid) ?? []).filter((g) => !ch.added.includes(g)));
      for (const g of ch.removed) set.add(g);
      oldGroups.set(uid, [...set]);
    }
    if (users.length) await logGroupChanges(env, users, oldGroups);
    await checkGroupRegular(env);
    // the internal groups depend on the hierarchy only, which a write of user_ids leaves: no share recomputation
  },
  constraints: [
    // res_groups.py:124-158 _check_user_disjoint_groups: an active user with the group and another user type group
    { fields: ["user_ids"], fn: async (env, ids) => {
      const types = await userTypeGroups(env);
      for (const gid of ids) {
        // `user_type_groups & group.all_implied_ids`
        const implied = await closure(env, [gid]);
        const userType = types.filter((t) => implied.has(t));
        if (!userType.length) continue;
        const withGroup = await groupsImplying(env, [gid]);
        const others = await groupsImplying(env, types.filter((t) => !userType.includes(t)));
        const user = (await env.cr.query<{ id: number }>(
          `SELECT u.id FROM res_users u WHERE u.active
              AND EXISTS (SELECT 1 FROM res_groups_users_rel r WHERE r.uid = u.id AND r.gid = ANY($1::int[]))
              AND EXISTS (SELECT 1 FROM res_groups_users_rel r WHERE r.uid = u.id AND r.gid = ANY($2::int[]))
            ORDER BY u.id LIMIT 1`, [[...withGroup], [...others]])).rows[0];
        if (user) {
          const error = await disjointError(env, user.id);
          if (error) throw error;
        }
      }
    } },
  ],
});

// res_groups.py:312-315 _compute_all_user_ids and :578-580 _compute_all_users_count: `group.all_implied_by_ids.user_ids`,
// the group then its implying groups sorted by id, each group's users in res.users `_order`, in order of first
// appearance; computed with archived users, which the field's value leaves out when read (measured: __system__)
async function allUsers(env: Environment, gid: number): Promise<number[]> {
  const implying = [...(await groupsImplying(env, [gid]))].filter((g) => g !== gid).sort((a, b) => a - b);
  const out: number[] = [];
  for (const g of [gid, ...implying]) {
    const ids = (await env.cr.query<{ uid: number }>("SELECT uid FROM res_groups_users_rel WHERE gid = $1", [g])).rows.map((r) => r.uid);
    if (!ids.length) continue;
    const ordered = await env.sudo().model("res.users").search(cond("id", "in", ids), { order: "name, login" });
    for (const u of ordered) if (!out.includes(u)) out.push(u);
  }
  return out;
}

registerHooks("res.groups", {
  computed: {
    all_user_ids: async (env, ids) => new Map(await Promise.all(ids.map(async (id): Promise<[number, unknown]> => [id, await allUsers(env, id)]))),
    all_users_count: async (env, ids) => new Map(await Promise.all(ids.map(async (id): Promise<[number, unknown]> => [id, (await allUsers(env, id)).length]))),
  },
});
