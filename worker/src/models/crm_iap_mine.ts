/**
 * crm.iap.lead.mining.request and crm.iap.lead.industry (odoo/addons/crm_iap_mine/models/): field defaults (:24-60),
 * computes (`_compute_tooltip` :67, `_compute_lead_count` :77, `_compute_team_id` :88, `_compute_available_state_ids`
 * :103), onchanges (:127-154) and the industry display name (crm_iap_lead_industry.py:31-42). Submitting to IAP
 * (action_submit) is not ported.
 */
import { NotPorted } from "../errors";
import * as D from "../orm/domain";
import { hasGroup } from "../orm/env";
import { registerHooks } from "../orm/hooks";
import { NewRec, type Rec, registerDefaults, registerOnchange, registerRecordCompute } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { textwrapShorten, translate } from "./util";
import { defaultTeam } from "./crm_lead_write";
import { registerMethod } from "../http/methods";
import { envFor } from "../web/common";

const MODEL = "crm.iap.lead.mining.request";
const MAX_LEAD = 200; // :15
const CREDIT_PER_COMPANY = 1; // :17
const STATES_FILTER_COUNTRIES_WHITELIST = new Set(["AR", "AU", "BR", "CA", "IN", "MY", "MX", "NZ", "AE", "US"]); // iap_tools.py:53

registerDefaults(MODEL, {
  name: async (env) => translate(env, "New"), // :34
  state: async () => "draft", // :35
  lead_number: async () => 3, // :38
  // :24-28 _default_lead_type
  lead_type: async (env) => ((await hasGroup(env, "crm.group_use_lead")) ? "lead" : "opportunity"),
  user_id: async (env) => env.uid, // :50
  filter_on_size: async () => false, // :56
  company_size_min: async () => 1, // :57
  company_size_max: async () => 100, // :58
  // :30-31 _default_country_ids: env.company.country_id
  country_ids: async (env) => {
    const row = (await env.cr.query<{ country_id: number | null }>(
      "SELECT p.country_id FROM res_company c JOIN res_partner p ON p.id = c.partner_id WHERE c.id = $1", [await env.company()])).rows[0];
    return row?.country_id ? [row.country_id] : [];
  },
});

async function leadCount(env: Environment, id: number | null): Promise<number> {
  if (id === null) return 0;
  // _read_group as the user: the leads the user can see
  return (await env.model("crm.lead").search(D.cond("lead_mining_request_id", "in", [id]))).length;
}

registerRecordCompute(MODEL, {
  // :67-75
  lead_credits: async (env, rec) => {
    const n = Number(await rec.get("lead_number")) || 0;
    if (env.lang && env.lang !== "en_US") throw new NotPorted("lead_credits outside en_US");
    return `${CREDIT_PER_COMPANY * n} credits will be consumed to find ${n} companies.`;
  },
  // :77-86
  lead_count: async (env, rec) => leadCount(env, rec.origin),
  // :103-125
  available_state_ids: async (env, rec) => {
    const countries = await rec.rels("country_ids");
    const ids: number[] = [];
    for (const c of countries) if (STATES_FILTER_COUNTRIES_WHITELIST.has(String(await c.get("code")))) if (c.id !== null) ids.push(c.id);
    return ids.length ? env.model("res.country.state").search(D.cond("country_id", "in", ids)) : [];
  },
  // :88-101 (as crm.lead's _compute_team_id)
  team_id: async (env, rec) => {
    const user = await rec.get("user_id");
    const current = await rec.prev("team_id");
    if (typeof user !== "number") return current;
    if (typeof current === "number") {
      const t = (await env.sudo().model("crm.team").read([current], ["member_ids", "user_id"], ""))[0];
      const members = Array.isArray(t?.["member_ids"]) ? (t["member_ids"] as number[]) : [];
      if (members.includes(user) || t?.["user_id"] === user) return current;
    }
    const team = await defaultTeam(env, user, (await rec.get("lead_type")) === "lead" ? "use_leads" : "use_opportunities");
    return team; // `mining.team_id = team.id` (an empty recordset gives False)
  },
});

registerHooks(MODEL, {
  computed: {
    // :103-125 for database records (read path)
    available_state_ids: async (env, ids) => {
      const out = new Map<number, unknown>();
      for (const id of ids) {
        const rows = (await env.cr.query<{ code: string | null; id: number }>(
          `SELECT c.id, c.code FROM crm_iap_lead_mining_request_res_country_rel r JOIN res_country c ON c.id = r.res_country_id
           WHERE r.crm_iap_lead_mining_request_id = $1 ORDER BY c.name->>'en_US', c.id`, [id])).rows;
        const countries = rows.filter((r) => STATES_FILTER_COUNTRIES_WHITELIST.has(r.code ?? "")).map((r) => r.id);
        out.set(id, countries.length ? await env.model("res.country.state").search(D.cond("country_id", "in", countries)) : []);
      }
      return out;
    },
    lead_count: async (env, ids) => new Map(await Promise.all(ids.map(async (id) => [id, await leadCount(env, id)] as [number, unknown]))),
    lead_credits: async (env, ids) => {
      if (env.lang && env.lang !== "en_US") throw new NotPorted("lead_credits outside en_US");
      const rows = await env.sudo().model(MODEL).read(ids, ["lead_number"], "");
      return new Map(rows.map((r) => {
        const n = Number(r["lead_number"]) || 0;
        return [Number(r["id"]), `${CREDIT_PER_COMPANY * n} credits will be consumed to find ${n} companies.`];
      }));
    },
  },
});

// onchanges, in getmembers() (alphabetical) order
registerOnchange(MODEL, "_onchange_available_state_ids", ["available_state_ids"], async (_env, rec: NewRec) => {
  const avail = new Set((await rec.get("available_state_ids")) as number[]);
  const states = (await rec.get("state_ids")) as unknown[];
  if (Array.isArray(states) && states.some((s) => typeof s !== "number" || !avail.has(s))) {
    await rec.set("state_ids", states.filter((s) => typeof s === "number" && avail.has(s)));
  }
});
registerOnchange(MODEL, "_onchange_company_size_max", ["company_size_max"], async (_env, rec: NewRec) => {
  const max = Number(await rec.get("company_size_max")), min = Number(await rec.get("company_size_min"));
  if (max < min) await rec.set("company_size_max", min);
});
registerOnchange(MODEL, "_onchange_company_size_min", ["company_size_min"], async (_env, rec: NewRec) => {
  const min = Number(await rec.get("company_size_min")), max = Number(await rec.get("company_size_max"));
  if (min <= 0) await rec.set("company_size_min", 1);
  else if (min > max) await rec.set("company_size_min", max);
});
registerOnchange(MODEL, "_onchange_country_ids", ["country_ids"], async (_env, rec: NewRec) => {
  await rec.set("state_ids", []);
});
registerOnchange(MODEL, "_onchange_lead_number", ["lead_number"], async (_env, rec: NewRec) => {
  const n = Number(await rec.get("lead_number"));
  if (n <= 0) await rec.set("lead_number", 1);
  else if (n > MAX_LEAD) await rec.set("lead_number", MAX_LEAD);
});

// crm_iap_lead_industry.py:31-42 _compute_display_name
registerHooks("crm.iap.lead.industry", {
  displayName: async (env, ids) => {
    const rows = (await env.cr.query<{ id: number; name: Record<string, string> | null; division: Record<string, string> | null }>(
      `SELECT i.id, i.name, d.name AS division FROM crm_iap_lead_industry i LEFT JOIN crm_iap_lead_industry_division d ON d.id = i.division_id
       WHERE i.id = ANY($1::int[])`, [ids])).rows;
    const lang = env.lang ?? "en_US";
    const tr = (v: Record<string, string> | null): string => (v ? v[lang] ?? v["en_US"] ?? "" : "");
    return new Map(rows.map((r) => [r.id, env.context["formatted_display_name"]
      ? `${textwrapShorten(tr(r.name), 40, "...")} \t--${textwrapShorten(tr(r.division), 40, "...")}--`
      : tr(r.name)]));
  },
});

export type { Rec };

/** crm_iap_mine/models/crm_lead.py:15-24 `action_generate_leads` (@api.model): the lead mining request's form, in a dialog. */
registerMethod("crm.lead", "action_generate_leads", async (env0, _ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  return {
    name: translate(env, "Need help reaching your target?", "crm_iap_mine"),
    type: "ir.actions.act_window",
    res_model: MODEL,
    target: "new",
    views: [[false, "form"]],
    context: { is_modal: true },
  };
}, { apiModel: true });
