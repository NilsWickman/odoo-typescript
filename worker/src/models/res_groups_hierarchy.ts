/**
 * `res.groups._get_view_group_hierarchy` (odoo/odoo/addons/base/models/res_groups.py:522-555), the user form's group
 * widget: `res.users.view_group_hierarchy` (res_users.py:260-263) and `res.groups.view_group_hierarchy` (:517-518).
 * Closures: `all_implied_ids` is the group then its supersets ascending, `all_implied_by_ids` the group then its
 * subsets ascending (:346, :366 with SetDefinitions).
 */
import { NotPorted } from "../errors";
import { and, cond, or } from "../orm/domain";
import { groupsImplying, impliedGroups } from "../orm/env";
import { userFlags, userRole } from "../session/user";
import { registerHooks } from "../orm/hooks";
import { registerOverrides } from "../orm/write";
import type { Domain, Environment } from "../orm/types";
import { registerDefaults, registerRecordCompute } from "../orm/recompute";
import { isHtmlEmpty } from "../web/empty_list_help";
import { placeholderValue } from "./avatar";
import { defineComputes } from "./tail_util";
import { htmlEscape } from "./util";

export async function hierarchy(env: Environment): Promise<Record<string, unknown>> {
  const lang = env.lang ?? "en_US";
  const label = (col: string): string => `COALESCE(${col}->>$1, ${col}->>'en_US')`;
  const groups = (await env.cr.query<{ id: number; name: string; comment: string | null; privilege_id: number | null; sequence: number | null }>(
    `SELECT g.id, ${label("g.name")} AS name, ${label("g.comment")} AS comment, g.privilege_id, g.sequence
       FROM res_groups g LEFT JOIN res_groups_privilege p ON p.id = g.privilege_id
      ORDER BY p.sequence, ${label("p.name")}, p.id, g.sequence, ${label("g.name")}, g.id`, [lang])).rows;
  const rank = new Map(groups.map((g, i) => [g.id, i]));
  const implied = (await env.cr.query<{ gid: number; hid: number }>("SELECT gid, hid FROM res_groups_implied_rel")).rows;
  const direct = new Map<number, number[]>();
  const up = new Map<number, Set<number>>(), down = new Map<number, Set<number>>();
  for (const { gid, hid } of implied) {
    direct.set(gid, [...(direct.get(gid) ?? []), hid]);
    (up.get(gid) ?? up.set(gid, new Set()).get(gid)!).add(hid);
    (down.get(hid) ?? down.set(hid, new Set()).get(hid)!).add(gid);
  }
  const closure = (start: number, edges: Map<number, Set<number>>): number[] => {
    const seen = new Set<number>();
    const todo = [...(edges.get(start) ?? [])];
    while (todo.length) {
      const g = todo.pop()!;
      if (seen.has(g) || g === start) continue;
      seen.add(g);
      todo.push(...(edges.get(g) ?? []));
    }
    return [start, ...[...seen].sort((a, b) => a - b)];
  };
  const byRank = (ids: number[]): number[] => [...ids].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
  const userTypes = (await env.cr.query<{ name: string; id: number }>(
    "SELECT name, res_id AS id FROM ir_model_data WHERE module = 'base' AND model = 'res.groups' AND name IN ('group_user', 'group_portal', 'group_public')")).rows;
  const typeIds = ["group_user", "group_portal", "group_public"].map((n) => userTypes.find((u) => u.name === n)?.id).filter((i): i is number => i !== undefined);
  const groupsOut: Record<string, unknown> = {};
  const allImplied = new Map<number, number[]>();
  for (const g of groups) {
    const all = closure(g.id, up);
    allImplied.set(g.id, all);
    groupsOut[String(g.id)] = {
      id: g.id, name: g.name, comment: g.comment ?? false, privilege_id: g.privilege_id ?? false,
      disjoint_ids: typeIds.includes(g.id) ? typeIds.filter((t) => t !== g.id) : [],
      implied_ids: byRank(direct.get(g.id) ?? []), all_implied_ids: all, all_implied_by_ids: closure(g.id, down),
    };
  }
  const privileges = (await env.cr.query<{ id: number; name: string; category_id: number | null; description: string | null; placeholder: string | null; sequence: number | null }>(
    `SELECT id, ${label("name")} AS name, category_id, ${label("description")} AS description, ${label("placeholder")} AS placeholder, sequence
       FROM res_groups_privilege ORDER BY sequence, ${label("name")}, id`, [lang])).rows;
  const privilegesOut: Record<string, unknown> = {};
  for (const p of privileges) {
    const own = groups.filter((g) => g.privilege_id === p.id);
    const inside = new Set(own.map((g) => g.id));
    const key = (g: { id: number; sequence: number | null }): [number, number, number] =>
      [(allImplied.get(g.id) ?? []).filter((i) => inside.has(i)).length, g.sequence ?? 0, g.id];
    const sorted = [...own].sort((a, b) => {
      const ka = key(a), kb = key(b);
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
    });
    privilegesOut[String(p.id)] = { id: p.id, name: p.name, category_id: p.category_id ?? false, description: p.description ?? false,
      placeholder: p.placeholder ?? false, group_ids: sorted.map((g) => g.id) };
  }
  const withGroups = new Set(groups.map((g) => g.privilege_id));
  const categories = (await env.cr.query<{ id: number; name: string }>(
    `SELECT c.id, ${label("c.name")} AS name FROM ir_module_category c
      WHERE EXISTS (SELECT 1 FROM res_groups_privilege p JOIN res_groups g ON g.privilege_id = p.id WHERE p.category_id = c.id)
      ORDER BY c.sequence, ${label("c.name")}, c.id`, [lang])).rows.map((c) => ({
    id: c.id, name: c.name,
    privilege_ids: privileges.filter((p) => p.category_id === c.id && withGroups.has(p.id)).map((p) => p.id),
  }));
  return { groups: groupsOut, privileges: privilegesOut, categories };
}

registerDefaults("res.users", { view_group_hierarchy: hierarchy });
defineComputes("res.users", { view_group_hierarchy: (env) => hierarchy(env) });
defineComputes("res.groups", { view_group_hierarchy: (env) => hierarchy(env) });

/** `group_ids.all_implied_ids` of the given groups (res_groups.py:342-346). */
async function impliedOf(env: Environment, ids: readonly number[]): Promise<Set<number>> {
  const implied = await impliedGroups(env);
  const out = new Set<number>();
  const todo = [...ids];
  while (todo.length) {
    const id = todo.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    todo.push(...(implied.get(id) ?? []));
  }
  return out;
}

defineComputes("res.users", {
  // auth_signup res_users.py:39-41 _compute_state
  state: async (_env, rec) => (!(await rec.get("active")) ? "inactive" : (await rec.get("login_date")) ? "active" : "new"),
  // web_tour res_users.py:9-13 _compute_tour_enabled
  tour_enabled: async (env, rec) => {
    const demo = (await env.cr.query("SELECT 1 FROM ir_module_module WHERE demo IS TRUE LIMIT 1")).rows.length > 0;
    if (demo) return false;
    if (rec.id === null) {
      const erpManager = await env.reg.xmlid(env.cr, "base.group_erp_manager");
      if (erpManager === null) return false;
      const implying = await groupsImplying(env, [erpManager]);
      for (const group of await rec.rels("group_ids")) {
        if (group.origin !== null && implying.has(group.origin)) return true;
      }
      return false;
    }
    return (await userFlags(env.cr, rec.id)).isAdmin;
  },
  // res_users.py:505-510 _compute_share: internal users have base.group_user through their groups
  share: async (env, rec) => {
    const user = await env.reg.xmlid(env.cr, "base.group_user");
    if (user === null) throw new NotPorted("base.group_user missing");
    const implying = await groupsImplying(env, [user]);
    for (const group of await rec.rels("group_ids")) if (group.origin !== null && implying.has(group.origin)) return false;
    return true;
  },
});

// res_users.py:430-446 _compute_role of a new user, from its groups (a record: the `computed` hook of res_users_prefs.ts)
registerRecordCompute("res.users", {
  // a new user reads through its new delegate partner (fields.py:1866-1870): a contact without image, active by default
  avatar_128: async (_env, rec) => {
    if (rec.id !== null) return (await rec.rel("partner_id"))?.get("avatar_128") ?? null;
    return placeholderValue("base/static/img/avatar_grey.png");
  },
  active_partner: async (_env, rec) => (rec.id === null ? true : (await rec.rel("partner_id"))?.get("active") ?? false),
  // sales_team res_users.py:38-45 _compute_sale_team_id: the oldest active membership
  sale_team_id: async (env, rec) => {
    if (rec.id === null) return null;
    return (await env.cr.query<{ t: number }>("SELECT crm_team_id AS t FROM crm_team_member WHERE user_id = $1 AND active ORDER BY create_date, id LIMIT 1", [rec.id])).rows[0]?.t ?? null;
  },
  // res_users.py:498-501 _compute_signature
  signature: async (_env, rec) => {
    const name = await rec.get("name");
    const current = await rec.prev("signature");
    return name && isHtmlEmpty(current) ? `<div>${htmlEscape(String(name))}</div>` : current;
  },
  role: async (env, rec) => {
    const ids = (await rec.rels("group_ids")).map((g) => g.origin).filter((g): g is number => g !== null);
    return userRole(env.cr, await impliedOf(env, ids));
  },
  // mail res_users.py:94-114 _compute_notification_type: inbox for the users in mail.group_mail_notification_type_inbox
  // (their own groups), email for the others; a portal user with inbox loses the group (that write refuses)
  notification_type: async (env, rec) => {
    const inbox = await env.reg.xmlid(env.cr, "mail.group_mail_notification_type_inbox");
    if (inbox === null) throw new NotPorted("mail.group_mail_notification_type_inbox missing");
    const current = await rec.prev("notification_type");
    const inGroup = (await rec.rels("group_ids")).some((g) => g.origin === inbox);
    let value = current;
    if (inGroup && current !== "inbox") value = "inbox";
    else if (!inGroup && current === "inbox") value = "email";
    if (value === "inbox" && (await rec.get("share"))) throw new NotPorted("res.users._compute_notification_type of a portal user with inbox notifications (group unlink)");
    return value;
  },
});

// mail res_users.py:145-149 _inverse_notification_type
registerOverrides("res.users", {
  inverse: {
    notification_type: async (env, ids) => {
      const inbox = await env.reg.xmlid(env.cr, "mail.group_mail_notification_type_inbox");
      if (inbox === null) throw new NotPorted("mail.group_mail_notification_type_inbox missing");
      await env.cr.query(
        `INSERT INTO res_groups_users_rel (gid, uid) SELECT $1, id FROM res_users WHERE id = ANY($2::int[]) AND notification_type = 'inbox' ON CONFLICT DO NOTHING`, [inbox, [...ids]]);
      await env.cr.query(
        `DELETE FROM res_groups_users_rel r USING res_users u WHERE r.uid = u.id AND r.gid = $1 AND u.id = ANY($2::int[]) AND u.notification_type IS DISTINCT FROM 'inbox'`, [inbox, [...ids]]);
    },
  },
});

// web res_users.py:13-28 name_search: the current user first; base res_users.py:760-768 a login match alone
registerHooks("res.users", {
  nameSearch: async (env, name, domain, operator, limit) => {
    const model = env.model("res.users");
    const pairs = async (ids: readonly number[]): Promise<[number, string][]> => {
      const names = await env.sudo().model("res.users").displayName(ids);
      return ids.map((id) => [id, names.get(id) ?? ""]);
    };
    if (name && !operator.startsWith("not") && operator !== "!=") {
      const byLogin = await model.search(and([cond("login", "=", name), domain]));
      if (byLogin.length) return moveFirst(pairs, byLogin, env.uid, limit, async () => []);
    }
    const query = (d: Domain, l: number | null): Promise<number[]> => model.search(and([cond("display_name", operator, name), d]), { limit: l });
    return moveFirst(pairs, await query(domain, limit), env.uid, limit, () => query(and([domain, cond("id", "=", env.uid)]), 1));
  },
});

async function moveFirst(pairs: (ids: readonly number[]) => Promise<[number, string][]>, ids: readonly number[], uid: number,
  limit: number | null, findUser: () => Promise<number[]>): Promise<[number, string][]> {
  if (ids.includes(uid)) return pairs([uid, ...ids.filter((id) => id !== uid)]);
  if (limit !== null && ids.length === limit) {
    const user = await findUser();
    if (user.length) return pairs([user[0]!, ...ids.slice(0, -1)]);
  }
  return pairs(ids);
}

// res_users.py:490-496 _search_all_group_ids: `group_ids.all_implied_ids`, the groups implying the value (res_groups.py:362)
registerHooks("res.users", {
  search: {
    all_group_ids: async (env, operator, value) => {
      const values = Array.isArray(value) ? value : [value];
      if (operator !== "in" && operator !== "=") throw new NotPorted(`res.users.all_group_ids ${operator}`);
      if (!values.every((v) => typeof v === "number" || v === false)) throw new NotPorted("res.users.all_group_ids by a name");
      // `group_ids.all_implied_ids in value`: a search of res.groups (res_groups.py:348-354 `_search_all_implied_ids`
      // gives `id in` the groups implying the value), a subquery on res_groups as Odoo's SQL has it (the plan, and so
      // the order of an unordered search, follows the query's shape)
      const domain = cond("group_ids", "any", cond("id", "in", [...(await groupsImplying(env, values.filter((v): v is number => typeof v === "number")))]));
      return values.includes(false) ? or([domain, cond("group_ids", "=", false)]) : domain;
    },
  },
});
