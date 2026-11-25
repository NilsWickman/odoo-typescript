/**
 * CRM configuration models' computes (crm.stage, crm.lost.reason) and crm.team's alias mixin fields
 * (odoo/addons/crm/models/, mail/models/mail_alias_mixin_optional.py). The lead/team behaviour of the CRM
 * scenarios lives in src/models/crm_*.ts; this file holds only these list/form computes.
 */
import { NotPorted } from "../errors";
import { and, cond, TRUE } from "../orm/domain";
import { type Rec, registerDefaults, registerRecordCompute } from "../orm/recompute";
import { datetimeToString, dbNow } from "./util";
import { str2bool } from "../orm/values";
import type { Environment } from "../orm/types";
import { configParam, defineComputes, registerAliasMixin } from "./tail_util";

defineComputes("crm.stage", {
  // crm_stage.py:53-55 _compute_team_count: search_count([]) of crm.team as the user
  team_count: async (env) => env.model("crm.team").searchCount(TRUE),
});

defineComputes("crm.lost.reason", {
  // crm_lost_reason.py:16-24 _compute_leads_count: _read_group of crm.lead (active_test=False) per lost reason
  leads_count: async (env, rec) => {
    if (rec.id === null) return 0;
    return env.withContext({ ...env.context, active_test: false }).model("crm.lead")
      .searchCount(cond("lost_reason_id", "in", [rec.id]));
  },
});

registerAliasMixin("crm.team");

registerDefaults("crm.team", {
  // sales_team crm_team.py:83-84 _get_default_favorite_user_ids
  favorite_user_ids: async (env) => [[6, 0, [env.uid]]],
});

registerDefaults("crm.iap.lead.mining.request", {
  // crm_iap_mine crm_iap_lead_mining_request.py:31-32 _default_country_ids: env.company.country_id
  country_ids: async (env) => {
    const country = (await env.cr.query<{ country_id: number | null }>(
      "SELECT p.country_id FROM res_company c JOIN res_partner p ON p.id = c.partner_id WHERE c.id = $1", [await env.company()])).rows[0]?.country_id ?? null;
    return [[6, 0, country === null ? [] : [country]]];
  },
});

/** crm_team.py:67-75 _compute_assignment_enabled with crm_lead.py:2040-2043 `_is_rule_based_assignment_activated`. */
async function assignment(env: Environment): Promise<{ enabled: boolean; auto: boolean }> {
  const raw = await configParam(env, "crm.lead.auto.assignment");
  const enabled = raw === null ? false : str2bool(raw, false);
  if (!enabled) return { enabled, auto: false };
  const cron = await env.reg.xmlid(env.cr, "crm.ir_cron_crm_lead_assign");
  if (cron === null) return { enabled, auto: false };
  const active = (await env.cr.query<{ active: boolean | null }>("SELECT active FROM ir_cron WHERE id = $1", [cron])).rows[0]?.active ?? false;
  return { enabled, auto: Boolean(active) };
}
defineComputes("crm.team", {
  assignment_enabled: async (env) => (await assignment(env)).enabled,
  assignment_auto_enabled: async (env) => (await assignment(env)).auto,
  // crm_team.py:53-56 _compute_assignment_max: the members' capacities
  assignment_max: async (_env, rec) => {
    let sum = 0;
    for (const m of await rec.rels("crm_team_member_ids")) sum += Number((await m.get("assignment_max")) ?? 0);
    return sum;
  },
});

registerRecordCompute("mail.alias", {
  // mail_alias.py:240-244 _compute_alias_status (stored): reset to 'not_tested'
  alias_status: async () => "not_tested",
});

defineComputes("crm.team", {
  // sales_team crm_team.py:139-142 _compute_is_membership_multi: get_bool('sales_team.membership_multi')
  is_membership_multi: async (env) => {
    const raw = await configParam(env, "sales_team.membership_multi");
    return raw === null ? false : str2bool(raw, false);
  },
});
registerRecordCompute("mail.alias", {
  // mail_alias.py:215-226 _compute_alias_full_name (stored)
  alias_full_name: async (_env, rec) => {
    const name = await rec.get("alias_name");
    const domain = await rec.rel("alias_domain_id");
    if (domain && name) return `${String(name)}@${String(await domain.get("name"))}`;
    if (name) return name;
    return null;
  },
});

/** crm_team_member.py:66-84 _compute_lead_month_count: leads opened in the last 30 days (active_test=False). */
async function leadMonthCount(env: Environment, user: number | null, team: number | null): Promise<number> {
  if (!user || !team) return 0;
  const from = datetimeToString(new Date(Math.floor((await dbNow(env)).getTime() / 1000) * 1000 - 30 * 86400 * 1000));
  return env.withContext({ ...env.context, active_test: false }).model("crm.lead").searchCount(and([
    cond("date_open", ">=", from), cond("team_id", "in", [team]), cond("user_id", "in", [user])]));
}
defineComputes("crm.team.member", {
  lead_month_count: async (env, rec) => {
    const user = await rec.get("user_id"), team = await rec.get("crm_team_id");
    return leadMonthCount(env, typeof user === "number" ? user : null, typeof team === "number" ? team : null);
  },
});
/** crm_team.py:95-99 _compute_lead_all_assigned_month_count */
async function teamMonthCount(env: Environment, rec: Rec): Promise<number> {
  let sum = 0;
  for (const m of await rec.rels("crm_team_member_ids")) sum += Number((await m.get("lead_month_count")) ?? 0);
  return sum;
}
defineComputes("crm.team", {
  lead_all_assigned_month_count: teamMonthCount,
  lead_all_assigned_month_exceeded: async (env, rec) => {
    let max = 0;
    for (const m of await rec.rels("crm_team_member_ids")) max += Number((await m.get("assignment_max")) ?? 0);
    return (await teamMonthCount(env, rec)) > max;
  },
});

defineComputes("crm.team", {
  // sales_team crm_team.py:194-200 _compute_member_company_ids: the team's company, else every company (as the user)
  member_company_ids: async (env, rec) => {
    const company = await rec.get("company_id");
    if (typeof company === "number" && company) return [company];
    return env.model("res.company").search(TRUE);
  },
});

defineComputes("crm.team", {
  // sales_team crm_team.py:163-183 _compute_member_warning: mono-membership mode only
  member_warning: async (env, rec) => {
    const raw = await configParam(env, "sales_team.membership_multi");
    if (raw !== null && str2bool(raw, false)) return false;
    const members = await rec.get("member_ids");
    const users = Array.isArray(members) ? members.filter((u): u is number => typeof u === "number") : [];
    const others = await env.model("crm.team.member").search(and([cond("crm_team_id", "!=", rec.id !== null ? rec.id : false), cond("user_id", "in", users)]));
    if (others.length === 0) return false;
    throw new NotPorted("crm.team.member_warning text (members already in other teams)");
  },
});

defineComputes("crm.team", {
  // crm_team.py:85-93 _compute_opportunity_count: opportunities of the team (as the user, active ones)
  opportunity_count: async (env, rec) => {
    if (rec.id === null) return 0;
    return env.model("crm.lead").searchCount(and([cond("team_id", "in", [rec.id]), cond("type", "=", "opportunity")]));
  },
});

registerRecordCompute("crm.team", {
  // sales_team crm_team.py:144-147 _compute_member_ids on new teams (the read side is src/models/crm_team.ts): the
  // users of the active memberships
  member_ids: async (_env, rec) => {
    const out: number[] = [];
    for (const m of await rec.rels("crm_team_member_ids")) {
      if (!(await m.get("active"))) continue;
      const user = await m.get("user_id");
      if (typeof user === "number" && user && !out.includes(user)) out.push(user);
    }
    return out;
  },
});
