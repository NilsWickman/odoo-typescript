/**
 * crm.team read methods the CRM pipeline calls: `get_team_switcher_data` (odoo/addons/crm/models/crm_team.py:793-837)
 * with crm.stage `_get_visible_stages_domain` (crm/models/crm_stage.py:40-42).
 */
import { and, cond, or, toList, TRUE } from "../orm/domain";
import { registerOnchange, registerRecordCompute } from "../orm/recompute";
import { loadAction } from "../controllers/action";
import { hasGroup } from "../orm/env";
import { registerMethod } from "../http/methods";
import { envFor } from "../web/common";
import type { Environment } from "../orm/types";
import { datetimeToString, dbNow, translate } from "./util";
import { hooksOf, registerHooks } from "../orm/hooks";
import { NotPorted, ValidationError } from "../errors";
import { create } from "../orm/create";
import { parseCommands } from "../orm/commands";
import { overlayOf } from "../orm/recompute";
import { aliasMixinWrite, aliasOnlyWrite, baseAliasCreationValues, checkAliasUnique, irModelId, registerAliasMixinUnlink, sanitizeAliasName, writeAliasCreationValues } from "../mail/alias_mixin";
import { registerOverrides, write } from "../orm/write";
import { registerWrittenOrder } from "../orm/x2many_order";
import { dictEntries, evalExpr, isDict, pyRepr } from "../pyexpr";

registerMethod("crm.team", "get_team_switcher_data", async (env0, _ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  // :806 teams using opportunities, order="sequence, id"
  let teams = await env.model("crm.team").search(cond("use_opportunities", "=", true), { order: "sequence, id" });
  if (teams.length <= 1) return { available: false, teams: [] };
  if (!(await hasGroup(env, "sales_team.group_sale_salesman_all_leads"))) {
    // :810-811: only the user's own teams (res.users.crm_team_ids)
    const [user] = await env.model("res.users").read([env.uid], ["crm_team_ids"], "");
    const own = new Set(Array.isArray(user?.["crm_team_ids"]) ? (user["crm_team_ids"] as number[]) : []);
    teams = teams.filter((id) => own.has(id));
  }
  // :813-819: crm.stage _read_group(visible stages, groupby team_ids, id:recordset); a stage without team falls in
  // the False group, a stage with teams in each of its teams' groups; ids ordered by id (ARRAY_AGG ORDER BY id)
  const stageIds = await env.model("crm.stage").search(or([cond("team_ids", "in", teams), cond("team_ids", "=", false)]));
  const stageTeams = await env.model("crm.stage").read(stageIds, ["team_ids"], "");
  const byTeam = new Map<number | false, number[]>();
  for (const row of [...stageTeams].sort((a, b) => Number(a["id"]) - Number(b["id"]))) {
    const linked = Array.isArray(row["team_ids"]) ? (row["team_ids"] as number[]) : [];
    for (const key of linked.length === 0 ? [false as const] : linked) byTeam.set(key, [...(byTeam.get(key) ?? []), Number(row["id"])]);
  }
  const shared = byTeam.get(false) ?? [];
  const names = await env.model("crm.team").read(teams, ["name"], "");
  const nameOf = new Map(names.map((r) => [Number(r["id"]), r["name"]]));
  return {
    available: true,
    teams: teams.map((id) => ({
      id,
      name: nameOf.get(id) ?? false,
      switcher_domain: toList(or([
        cond("team_id", "=", id),
        and([cond("team_id", "=", false), cond("stage_id", "in", [...(byTeam.get(id) ?? []), ...shared])]),
      ])),
    })),
  };
}, { apiModel: true, readonly: true });

// sales_team/models/crm_team.py:144-147 _compute_member_ids (users of the active memberships, crm_team_member_ids
// has context active_test=True) and :185-191 _search_member_ids
registerHooks("crm.team", {
  computed: {
    member_ids: async (env, ids) => {
      const rows = (await env.cr.query<{ crm_team_id: number; user_id: number }>(
        `SELECT crm_team_id, user_id FROM crm_team_member WHERE crm_team_id = ANY($1::int[]) AND active ORDER BY id`, [ids])).rows;
      const out = new Map<number, unknown>(ids.map((id) => [id, [] as number[]]));
      for (const r of rows) {
        const list = out.get(r.crm_team_id) as number[];
        if (!list.includes(r.user_id)) list.push(r.user_id);
      }
      return out;
    },
  },
  search: {
    member_ids: async (_env, operator, value) => {
      if (operator.startsWith("not ") || operator === "!=") throw new NotPorted(`crm.team.member_ids ${operator} (NotImplemented)`);
      const domain = cond("crm_team_member_ids.user_id", operator, value);
      if (operator === "in" && Array.isArray(value) && value.includes(false)) return or([domain, cond("crm_team_member_ids", "=", false)]);
      return domain;
    },
  },
});

// sales_team/models/res_users.py:9-36: `crm_team_ids` = the teams of the user's active memberships
// (`crm_team_member_ids.crm_team_id`, crm.team.member `_order = 'create_date ASC, id'`), searched through them.
registerHooks("res.users", {
  computed: {
    crm_team_ids: async (env, ids) => {
      const rows = (await env.cr.query<{ user_id: number; crm_team_id: number }>(
        `SELECT user_id, crm_team_id FROM crm_team_member WHERE user_id = ANY($1::int[]) AND active IS TRUE ORDER BY create_date ASC, id`, [ids])).rows;
      const out = new Map<number, number[]>(ids.map((id) => [id, []]));
      for (const r of rows) {
        const list = out.get(r.user_id)!;
        if (!list.includes(r.crm_team_id)) list.push(r.crm_team_id);
      }
      return out;
    },
  },
  search: {
    crm_team_ids: async (env, operator, value) => {
      const users = await env.withContext({ ...env.context, active_test: false }).model("res.users")
        .search(cond("crm_team_member_ids.crm_team_id", operator, value), { limit: 10_000, activeTest: false });
      return users.length < 10_000 ? cond("id", "in", users) : cond("crm_team_member_ids.crm_team_id", operator, value);
    },
  },
});

// crm/models/crm_team.py:77-84 _compute_lead_unassigned_count (crm.lead _read_group as the user)
registerHooks("crm.team", {
  computed: {
    lead_unassigned_count: async (env, ids) => {
      const leads = await env.model("crm.lead").search(and([cond("team_id", "in", [...ids]), cond("user_id", "=", false)]));
      const teams = await env.sudo().model("crm.lead").read(leads, ["team_id"], "");
      const counts = new Map<number, number>();
      for (const r of teams) if (typeof r["team_id"] === "number") counts.set(r["team_id"], (counts.get(r["team_id"]) ?? 0) + 1);
      return new Map(ids.map((id) => [id, counts.get(id) ?? 0]));
    },
    // sales_team/models/crm_team.py:164-183 _compute_member_warning (mono-membership mode only)
    member_warning: async (env, ids) => {
      const rows = await env.sudo().model("crm.team").read([...ids], ["is_membership_multi", "member_ids"], "");
      const multi = (await env.cr.query<{ value: string }>("SELECT value FROM ir_config_parameter WHERE key = 'sales_team.membership_multi'")).rows[0]?.value;
      void multi;
      const out = new Map<number, unknown>(ids.map((id) => [id, false]));
      if (rows.every((r) => r["is_membership_multi"])) return out;
      for (const r of rows) {
        const members = Array.isArray(r["member_ids"]) ? (r["member_ids"] as number[]) : [];
        const other = await env.model("crm.team.member").search(and([cond("crm_team_id", "!=", Number(r["id"])), cond("user_id", "in", members)]));
        if (other.length) throw new NotPorted("crm.team.member_warning with memberships in other teams");
      }
      return out;
    },
    // sales_team/models/crm_team.py:193-200 _compute_member_company_ids
    member_company_ids: async (env, ids) => {
      const rows = await env.sudo().model("crm.team").read([...ids], ["company_id"], "");
      const all = await env.model("res.company").search(TRUE);
      return new Map(rows.map((r) => [Number(r["id"]), typeof r["company_id"] === "number" ? [r["company_id"]] : all]));
    },
  },
});

registerRecordCompute("crm.team", {
  // sales_team/models/crm_team.py:144-147: the users of the active memberships (context active_test=True)
  member_ids: async (_env, rec) => {
    const users: number[] = [];
    for (const m of await rec.rels("crm_team_member_ids")) {
      if (!(await m.get("active"))) continue;
      const u = await m.get("user_id");
      if (typeof u === "number" && !users.includes(u)) users.push(u);
    }
    return users;
  },
  member_company_ids: async (env, rec) => {
    const company = await rec.get("company_id");
    return typeof company === "number" ? [company] : env.model("res.company").search(TRUE);
  },
  member_warning: async (env, rec) => {
    if (await rec.get("is_membership_multi")) return null;
    const members = await rec.get("member_ids");
    const ids = Array.isArray(members) ? members.filter((m): m is number => typeof m === "number") : [];
    if (!ids.length) return null;
    const other = await env.model("crm.team.member").search(and([cond("crm_team_id", "!=", rec.origin ?? false), cond("user_id", "in", ids)]));
    if (other.length) throw new NotPorted("crm.team.member_warning with memberships in other teams");
    return null;
  },
});

// crm/models/crm_team.py:783-787 action_primary_channel_button (sale/models/crm_team.py:28 outside the sales
// app scope; sales_team's base returns False) -> action_open_opportunities (:762-768)
registerMethod("crm.team", "action_primary_channel_button", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  if (env.context["in_sales_app"]) throw new NotPorted("crm.team.action_primary_channel_button in the sales app scope");
  if (!ids || ids.length !== 1) throw new NotPorted("action_primary_channel_button on several teams");
  const team = (await env.model("crm.team").read(ids, ["use_opportunities"], ""))[0];
  if (!team?.["use_opportunities"]) return false;
  return openOpportunities(env, ids);
}, { apiModel: false });

registerMethod("crm.team", "action_open_opportunities", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  if (!ids || ids.length !== 1) throw new NotPorted("action_open_opportunities on several teams");
  return openOpportunities(env, ids);
}, { apiModel: false });

async function openOpportunities(env: Environment, ids: readonly number[]): Promise<Record<string, unknown>> {
  const team = (await env.model("crm.team").read([...ids], ["alias_email"], ""))[0];
  const action = await loadAction({ cursor: () => env.cr, context: env.context, uid: env.uid }, "crm.crm_case_form_view_salesteams_opportunity");
  // crm/views/crm_helper_templates.xml crm_action_helper, rendered with the team
  if (team?.["alias_email"]) throw new NotPorted("crm_action_helper with a team alias email");
  if (env.lang && env.lang !== "en_US") throw new NotPorted(`crm_action_helper in ${env.lang}`);
  action["help"] = "\n            <p class=\"o_view_nocontent_smiling_face\">Create an opportunity to start playing with your pipeline.</p>\n            <p>Use the New button, or configure an email alias to test the email gateway.</p>";
  return action;
}

// crm/models/crm_team_member.py:38-46 _compute_assignment_rules; :58-85 lead day/month counts (crm.lead
// _read_group with active_test=False on date_open since now - 24 h / 30 days, by user and team)
const MEMBER_MAX_LEAD_ASSIGNMENT_QUOTA = 30000;
async function memberLeadCounts(env: Environment, ids: readonly number[], days: number): Promise<Map<number, unknown>> {
  const members = await env.sudo().model("crm.team.member").read([...ids], ["user_id", "crm_team_id"], "");
  const now = await dbNow(env);
  const from = datetimeToString(new Date(now.getTime() - days * 86_400_000));
  const teams = [...new Set(members.map((m) => m["crm_team_id"]).filter((x): x is number => typeof x === "number"))];
  const users = [...new Set(members.map((m) => m["user_id"]).filter((x): x is number => typeof x === "number"))];
  const Lead = env.withContext({ ...env.context, active_test: false }).model("crm.lead");
  const leadIds = await Lead.search(and([cond("date_open", ">=", from), cond("team_id", "in", teams), cond("user_id", "in", users)]), { activeTest: false });
  const rows = await env.sudo().withContext({ ...env.context, active_test: false }).model("crm.lead").read(leadIds, ["user_id", "team_id"], "");
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(`${r["user_id"]},${r["team_id"]}`, (counts.get(`${r["user_id"]},${r["team_id"]}`) ?? 0) + 1);
  return new Map(members.map((m) => [Number(m["id"]), counts.get(`${m["user_id"]},${m["crm_team_id"]}`) ?? 0]));
}
registerHooks("crm.team.member", {
  computed: {
    assignment_rules: async (env, ids) => {
      const rows = await env.sudo().model("crm.team.member").read([...ids], ["assignment_max"], "");
      return new Map(rows.map((r) => {
        const max = Number(r["assignment_max"] ?? 0);
        return [Number(r["id"]), max >= MEMBER_MAX_LEAD_ASSIGNMENT_QUOTA ? "unlimited" : max === 0 ? "opt-out" : "limited"];
      }));
    },
    lead_day_count: async (env, ids) => memberLeadCounts(env, ids, 1),
    lead_month_count: async (env, ids) => memberLeadCounts(env, ids, 30),
  },
});

// mail/models/mail_alias.py:228-239 _compute_display_name
registerHooks("mail.alias", {
  displayName: async (env, ids) => {
    const rows = (await env.cr.query<{ id: number; alias_name: string | null; domain: string | null }>(
      `SELECT a.id, a.alias_name, d.name AS domain FROM mail_alias a LEFT JOIN mail_alias_domain d ON d.id = a.alias_domain_id
       WHERE a.id = ANY($1::int[])`, [ids])).rows;
    return new Map(rows.map((r) => [r.id, r.alias_name && r.domain ? `${r.alias_name}@${r.domain}` : r.alias_name ? r.alias_name : translate(env, "Inactive Alias")]));
  },
});

export { sanitizeAliasName };

/** mail_alias.py:15-16 `dot_atom_text` (rfc5322 3.2.3). */
const DOT_ATOM_TEXT = /^[a-zA-Z0-9!#$%&'*+\-/=?^_`{|}~]+(\.[a-zA-Z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/;

// mail/models/mail_alias.py:245-262 create: sanitized name, default alias domain, `_check_unique` (:302-358);
// :264-300 write: the sanitized name and `_check_unique` of the names and domains the write gives
registerOverrides("mail.alias", {
  create: async (env, valsList, next) => {
    const names: (string | false)[] = [], domains: (number | false)[] = [];
    for (const vals of valsList) {
      vals["alias_name"] = sanitizeAliasName(vals["alias_name"]);
      if (!("alias_domain_id" in vals)) {
        const company = await env.company();
        const row = (await env.cr.query<{ alias_domain_id: number | null }>("SELECT alias_domain_id FROM res_company WHERE id = $1", [company])).rows[0];
        vals["alias_domain_id"] = row?.alias_domain_id ?? false;
      }
      names.push(vals["alias_name"] as string | false);
      domains.push((vals["alias_domain_id"] || false) as number | false);
    }
    await checkAliasUnique(env, names, domains, []);
    return next(env, valsList);
  },
  write: async (env, ids, vals, next) => {
    if ("alias_name" in vals) vals["alias_name"] = sanitizeAliasName(vals["alias_name"]);
    const rows = (await env.cr.query<{ id: number; alias_name: string | null; d: number | null }>(
      "SELECT id, alias_name, alias_domain_id AS d FROM mail_alias WHERE id = ANY($1::int[])", [[...ids]])).rows;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const recs = ids.map((id) => byId.get(id)!).filter((r) => r !== undefined);
    let names: (string | false)[] = [];
    if (vals["alias_name"] && ids.length) names = ids.map(() => vals["alias_name"] as string);
    else if (!("alias_name" in vals) && "alias_domain_id" in vals) {
      // "avoid checking when writing the same value": `[vals['alias_domain_id']] != self.alias_domain_id.ids`
      const current = [...new Set(recs.map((r) => r.d).filter((d): d is number => d !== null))];
      const given = vals["alias_domain_id"] || false;
      if (!(current.length === 1 && current[0] === given)) names = recs.filter((r) => r.alias_name).map((r) => r.alias_name!);
    }
    if (names.length) {
      const tocheck = vals["alias_name"] ? recs : recs.filter((r) => r.alias_name);
      const domains = "alias_domain_id" in vals ? tocheck.map(() => (vals["alias_domain_id"] || false) as number | false) : tocheck.map((r) => r.d ?? false);
      await checkAliasUnique(env, names, domains, ids);
    }
    return next(env, ids, vals);
  },
  constraints: [
    // mail_alias.py:179-191 _check_alias_is_ascii
    {
      fields: ["alias_name"], fn: async (env, ids) => {
        const rows = (await env.cr.query<{ alias_name: string | null }>("SELECT alias_name FROM mail_alias WHERE id = ANY($1::int[]) ORDER BY array_position($1::int[], id)", [[...ids]])).rows;
        for (const r of rows) {
          if (r.alias_name && !DOT_ATOM_TEXT.test(r.alias_name)) {
            throw new ValidationError(translate(env, "You cannot use anything else than unaccented latin characters in the alias address %(alias_name)s.", "mail").replace("%(alias_name)s", r.alias_name));
          }
        }
      },
    },
    // mail_alias.py:202-213 _check_alias_domain_clash: no name of the domain's bounce or catchall address
    {
      fields: ["alias_name", "alias_domain_id"], fn: async (env, ids) => {
        const rows = (await env.cr.query<{ id: number }>(
          `SELECT a.id FROM mail_alias a JOIN mail_alias_domain d ON d.id = a.alias_domain_id
            WHERE a.id = ANY($1::int[]) AND a.alias_name IS NOT NULL AND a.alias_name IN (d.bounce_alias, d.catchall_alias)
            ORDER BY array_position($1::int[], a.id)`, [[...ids]])).rows;
        if (!rows.length) return;
        const names = await env.model("mail.alias").displayName(rows.map((r) => r.id));
        throw new ValidationError(translate(env, "Aliases %(alias_names)s is already used as bounce or catchall address. Please choose another alias.", "mail")
          .replace("%(alias_names)s", rows.map((r) => names.get(r.id) ?? "").join(", ")));
      },
    },
    // mail_alias.py:98-177 _check_alias_domain_id_mc: an alias whose domain belongs to companies keeps the domain of its
    // owner's (and target's) company
    {
      fields: ["alias_domain_id", "alias_force_thread_id", "alias_parent_model_id", "alias_parent_thread_id", "alias_model_id"], fn: async (env, ids) => {
        const rows = (await env.cr.query<{ id: number; d: number; pm: string | null; pt: number | null; tm: string | null; tt: number | null }>(
          `SELECT a.id, a.alias_domain_id AS d, pm.model AS pm, a.alias_parent_thread_id AS pt, tm.model AS tm, a.alias_force_thread_id AS tt
             FROM mail_alias a LEFT JOIN ir_model pm ON pm.id = a.alias_parent_model_id LEFT JOIN ir_model tm ON tm.id = a.alias_model_id
            WHERE a.id = ANY($1::int[]) AND EXISTS (SELECT 1 FROM res_company c WHERE c.alias_domain_id = a.alias_domain_id)
            ORDER BY array_position($1::int[], a.id)`, [[...ids]])).rows;
        for (const r of rows) {
          for (const [model, thread, kind] of [[r.pm, r.pt, "owner"], [r.tm, r.tt, "target"]] as const) {
            if (!model || !thread || !env.reg.models.has(model) || !env.reg.model(model).fields.has("company_id")) continue;
            const table = env.reg.model(model).table;
            const c = (await env.cr.query<{ id: number; name: string; d: number | null }>(
              `SELECT c.id, c.name, c.alias_domain_id AS d FROM "${table}" o JOIN res_company c ON c.id = o.company_id WHERE o.id = $1`, [thread])).rows[0];
            if (!c || c.d === r.d) continue;
            const dom = (await env.cr.query<{ name: string }>("SELECT name FROM mail_alias_domain WHERE id = $1", [r.d])).rows[0]?.name ?? "";
            const companies = (await env.cr.query<{ name: string }>("SELECT name FROM res_company WHERE alias_domain_id = $1 ORDER BY sequence, name", [r.d])).rows.map((x) => x.name);
            const source = kind === "owner"
              ? "We could not create alias %(alias_name)s because domain %(alias_domain_name)s belongs to company %(alias_company_names)s while the owner document belongs to company %(company_name)s."
              : "We could not create alias %(alias_name)s because domain %(alias_domain_name)s belongs to company %(alias_company_names)s while the target document belongs to company %(company_name)s.";
            throw new ValidationError(translate(env, source, "mail")
              .replace("%(alias_name)s", (await env.model("mail.alias").displayName([r.id])).get(r.id) ?? "")
              .replace("%(alias_domain_name)s", dom).replace("%(alias_company_names)s", companies.join(","))
              .replace("%(company_name)s", c.name));
          }
        }
      },
    },
  ],
});

/**
 * crm.team create through mail.alias.mixin (mail/models/mail_alias_mixin_optional.py:51-105, `_require_new_alias`
 * mail_alias_mixin.py:29-31): the mail.alias fields of the values create the alias first (sudo) with the
 * record-agnostic creation values, then each created team writes its own creation values on its alias.
 * `_alias_get_creation_values` (mail_alias_mixin_optional.py:186-196, crm/models/crm_team.py:171-181).
 */
async function teamAliasValues(env: Environment, teamId: number | null): Promise<Record<string, unknown>> {
  const values = await baseAliasCreationValues(env, "crm.team", teamId);
  values["alias_model_id"] = await irModelId(env, "crm.lead");
  if (teamId !== null) {
    const row = (await env.sudo().model("crm.team").read([teamId], ["use_leads", "use_opportunities", "alias_defaults"], ""))[0]!;
    if (!row["use_leads"] && !row["use_opportunities"]) values["alias_name"] = false;
    const parsed = evalExpr(String(row["alias_defaults"] || "{}"), new Map());
    if (!isDict(parsed)) throw new NotPorted("crm.team alias_defaults that is not a dict");
    const defaults = new Map<unknown, unknown>(dictEntries(parsed));
    defaults.set("type", (await hasGroup(env, "crm.group_use_lead")) && row["use_leads"] ? "lead" : "opportunity");
    defaults.set("team_id", teamId);
    values["alias_defaults"] = pyRepr(defaults); // a dict written on a Text field is stored as str(dict)
  }
  return values;
}

/** sales_team/models/crm_team.py:149-162 _inverse_member_ids for one team whose member_ids are `users`. */
async function inverseMemberIds(env: Environment, teamId: number, users: readonly number[]): Promise<void> {
  const memberships = await env.model("crm.team.member").search(cond("crm_team_id", "=", teamId), { activeTest: true });
  const rows = memberships.length ? await env.model("crm.team.member").read(memberships, ["user_id"], "") : [];
  const known = new Set(rows.map((r) => (Array.isArray(r["user_id"]) ? r["user_id"][0] : r["user_id"]) as number));
  const usersNew = users.filter((u) => !known.has(u));
  if (usersNew.length) await create(env, "crm.team.member", usersNew.map((u) => ({ crm_team_id: teamId, user_id: u })));
  for (const r of rows) {
    const user = (Array.isArray(r["user_id"]) ? r["user_id"][0] : r["user_id"]) as number;
    await write(env, "crm.team.member", [Number(r["id"])], { active: users.includes(user) });
  }
}

/** The member_ids of a new team from its create commands (the cache value the inverse reads). */
function memberIdsOfCommands(value: unknown): number[] {
  let users: number[] = [];
  for (const c of parseCommands(value, "crm.team.member_ids")) {
    if (c.op === "set") users = [...c.ids];
    else if (c.op === "link") { if (!users.includes(c.id)) users.push(c.id); }
    else if (c.op === "clear") users = [];
    else if (c.op === "unlink") users = users.filter((u) => u !== c.id);
    else throw new NotPorted(`crm.team member_ids command ${c.op} on create`);
  }
  return users;
}

registerOverrides("crm.team", {
  skipsCore: aliasOnlyWrite,
  inverse: {
    member_ids: async (env, ids) => {
      const overlay = overlayOf(env, "crm.team", "member_ids");
      for (const id of ids) {
        const users = overlay?.get(id);
        if (!Array.isArray(users) || users.some((u) => typeof u !== "number")) throw new NotPorted("inverse of crm.team.member_ids on write");
        await inverseMemberIds(env, id, users as number[]);
        // the memberships changed: member_ids is recomputed from them (`@api.depends('crm_team_member_ids.active')`)
        overlay?.delete(id);
      }
    },
  },
  // crm/models/crm_team.py:120-129 (use_leads/use_opportunities refuse in the guard), mail_alias_mixin_optional.py:108-141,
  // sales_team/models/crm_team.py:230-238: after the write, `member_ids` given adds the members to the favorites
  write: async (env, ids, vals, next) => aliasMixinWrite(env, "crm.team", ids, vals, async (e, i, v) => {
    await next(e, i, v);
    if (Array.isArray(v["member_ids"]) ? v["member_ids"].length > 0 : Boolean(v["member_ids"])) {
      // :263-265 _add_members_to_favorites: `team.favorite_user_ids = [(4, member.id) for member in team.member_ids]`
      for (const id of i) {
        const [row] = await e.model("crm.team").read([id], ["member_ids"], "");
        const members = Array.isArray(row?.["member_ids"]) ? (row["member_ids"] as number[]) : [];
        await write(e, "crm.team", [id], { favorite_user_ids: members.map((m) => [4, m, 0]) });
      }
    }
  }, (e, id) => teamAliasValues(e, id)),
  create: async (env, valsList, next) => {
    // member_ids (non-stored, inverse): its value is applied after create, as determine_inverse does (models.py:4211)
    const members = valsList.map((vals) => {
      if (!("member_ids" in vals)) return null;
      const users = memberIdsOfCommands(vals["member_ids"]);
      delete vals["member_ids"];
      return users;
    });
    return createWithAlias(env, valsList, async (e, vl) => {
      const ids = await next(e, vl);
      for (let i = 0; i < ids.length; i++) if (members[i]) await inverseMemberIds(e, ids[i]!, members[i]!);
      return ids;
    });
  },
});

// mail_alias_mixin_optional.py:143-148 unlink: the teams' aliases are deleted after them
registerAliasMixinUnlink("crm.team");
// `_add_members_to_favorites` links the members after the old favorites; the form's web_read sees that cache order
registerWrittenOrder("crm.team", "favorite_user_ids");

async function createWithAlias(env: Environment, valsList: Record<string, unknown>[],
  next: (env: Environment, valsList: Record<string, unknown>[]) => Promise<number[]>): Promise<number[]> {
  {
    const aliasFields = env.reg.model("mail.alias").fields;
    const defaultCompany = typeof env.context["default_company_id"] === "number" ? env.context["default_company_id"] as number : await env.company();
    const aliasValsList: Record<string, unknown>[] = [];
    const valid: Record<string, unknown>[] = [];
    for (const vals of valsList) {
      if (vals["alias_name"]) vals["alias_name"] = sanitizeAliasName(vals["alias_name"]);
      if (vals["alias_id"]) { valid.push(vals); continue; }
      const company = (vals["company_id"] as number | undefined) || defaultCompany;
      const aliasVals: Record<string, unknown> = {}, recordVals: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(vals)) (aliasFields.has(k) ? aliasVals : recordVals)[k] = v;
      const domain = "alias_domain_id" in aliasVals ? aliasVals["alias_domain_id"]
        : (await env.cr.query<{ alias_domain_id: number | null }>("SELECT alias_domain_id FROM res_company WHERE id = $1", [company])).rows[0]?.alias_domain_id ?? false;
      // record-agnostic values under `default_alias_domain_id` (mail_alias_mixin_optional.py:75-77)
      Object.assign(aliasVals, await teamAliasValues(env.withContext({ ...env.context, default_alias_domain_id: domain }), null));
      aliasValsList.push(aliasVals);
      valid.push(recordVals);
    }
    if (aliasValsList.length) {
      const aliasIds = await create(env.sudo(), "mail.alias", aliasValsList);
      let i = 0;
      for (const vals of valid) if (!vals["alias_id"]) vals["alias_id"] = aliasIds[i++];
    }
    const ids = await next(env, valid);
    await writeAliasCreationValues(env, "crm.team", ids, (id) => teamAliasValues(env, id));
    return ids;
  }
}

// calendar/models/calendar_event.py:170-172, :348-352: calendar_id's domain depends on the user
registerHooks("calendar.event", {
  descriptionDomain: {
    ...hooksOf("calendar.event").descriptionDomain,
    calendar_id: async (env) => [["calendar_user_ids", "any", [["user_id", "=", env.uid], ["access_role", "in", ["writer", "owner"]]]]],
  },
});

// crm_team.py:101-104 _onchange_use_leads_opportunities: a team using neither leads nor opportunities loses its alias name
registerOnchange("crm.team", "_onchange_use_leads_opportunities", ["use_leads", "use_opportunities"], async (_env, rec) => {
  if (!(await rec.get("use_leads")) && !(await rec.get("use_opportunities"))) await rec.set("alias_name", null);
});

/** misc.py:439-462 `str2bool` of a config parameter as `get_bool` reads it (ir_config_parameter.py:100-161): null when
 *  the parameter is missing, empty or invalid (the default). */
async function configBool(env: Environment, key: string): Promise<boolean | null> {
  const v = (await env.cr.query<{ value: string | null }>("SELECT value FROM ir_config_parameter WHERE key = $1", [key])).rows[0]?.value;
  if (v === undefined || v === null) return null;
  const s = v.toLowerCase();
  if (["y", "yes", "1", "true", "t", "on"].includes(s)) return true;
  if (["n", "no", "0", "false", "f", "off"].includes(s)) return false;
  return null;
}

/**
 * sales_team crm_team_member.py:191-213 `_synchronize_memberships` (mono-membership mode): the users' active memberships
 * in other teams are archived (`action_archive`). The search is the user's (record rules), on active memberships only.
 */
async function synchronizeMemberships(env: Environment, pairs: readonly { user: number; team: number }[]): Promise<void> {
  const existing = await env.model("crm.team.member").search(and([cond("active", "=", true), cond("user_id", "in", pairs.map((p) => p.user))]));
  if (!existing.length) return;
  const rows = await env.model("crm.team.member").read(existing, ["user_id", "crm_team_id"], "");
  const toArchive: number[] = [];
  for (const p of pairs) {
    for (const r of rows) {
      const id = Number(r["id"]);
      if (r["user_id"] === p.user && r["crm_team_id"] !== p.team && !toArchive.includes(id)) toArchive.push(id);
    }
  }
  // models.py action_archive: the active ones, `write({'active': False})` (the write's own sync needs active=True)
  if (toArchive.length) await write(env, "crm.team.member", toArchive, { active: false });
}

// sales_team crm_team_member.py:153-171 create: in mono-membership mode the users' other memberships are archived first
// (rådet runda 13, åtgärd 6: before, adding a salesperson to a team refused at the guard)
registerOverrides("crm.team.member", {
  // sales_team crm_team_member.py:173-189 write: activating memberships archives the users' others (mono-membership mode)
  write: async (env, ids, vals, next) => {
    if (vals["active"] && !(await configBool(env.sudo(), "sales_team.membership_multi"))) {
      const rows = (await env.cr.query<{ id: number; user_id: number | null; crm_team_id: number | null }>(
        "SELECT id, user_id, crm_team_id FROM crm_team_member WHERE id = ANY($1::int[])", [[...ids]])).rows;
      const byId = new Map(rows.map((r) => [r.id, r]));
      const pairs = ids.map((id) => byId.get(id)).filter((r) => r !== undefined).map((r) => {
        if (r.user_id === null || r.crm_team_id === null) throw new NotPorted("crm.team.member write active on a membership without user or team");
        return { user: r.user_id, team: r.crm_team_id };
      });
      await synchronizeMemberships(env, pairs);
    }
    return next(env, ids, vals);
  },
  create: async (env, valsList, next) => {
    if (!(await configBool(env.sudo(), "sales_team.membership_multi"))) {
      const pairs = valsList.map((v) => {
        // `values['user_id']`, `values['crm_team_id']`: a KeyError in Odoo when one is missing
        if (!("user_id" in v) || !("crm_team_id" in v)) throw new NotPorted("crm.team.member create without user_id or crm_team_id (KeyError)");
        const user = typeof v["user_id"] === "number" ? v["user_id"] : null, team = typeof v["crm_team_id"] === "number" ? v["crm_team_id"] : null;
        if (user === null || team === null) throw new NotPorted("crm.team.member create with an empty user_id or crm_team_id");
        return { user, team };
      });
      await synchronizeMemberships(env, pairs);
    }
    return next(env, valsList);
  },
});
