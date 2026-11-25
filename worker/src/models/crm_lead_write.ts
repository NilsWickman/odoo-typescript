/**
 * crm.lead's write-side Python (odoo/addons/crm/models/crm_lead.py with crm_iap_enrich, mail.thread.blacklist,
 * mail.thread.phone and mail.tracking.duration.mixin): field defaults, the stored computes the ORM core runs on
 * create/write/onchange, record versions of the non-stored computes the form view requests (new records in
 * onchange), and the `create`/`write` overrides (:728-818) with the date/stage/probability bookkeeping and
 * `_handle_won_lost`. Predictive lead scoring (`automated_probability`, `probability`) and the won/lost frequency
 * updates live in src/models/crm_lead_pls.ts, which installs the handler with `setHandleWonLost`.
 */
import { NotPorted } from "../errors";
import * as D from "../orm/domain";
import { hasGroup } from "../orm/env";
import { DbRec, NewRec, type Rec, registerDefaults, registerRecordCompute, registerResetFirst } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { registerOverrides, write } from "../orm/write";
import { duplicateLeadCount } from "./crm_lead";
import { canonicalPhone, internationalPhone } from "./phone";
import { cleanWebsite, emailNormalize as emailNormalizeStrict } from "./partner_pure_write";
import { rottingOf as mixinRotting, type Rotting } from "./rotting";

/** tools/mail.py email_normalize: a text without any '@' holds no address (email_split finds none): False. */
function emailNormalize(text: string | null): string | null {
  if (text && !text.includes("@")) return null;
  return emailNormalizeStrict(text);
}
import { datetimeToString, dbNow, translate } from "./util";

const MODEL = "crm.lead";

export interface WonLost { readonly is_lost: boolean; readonly is_won: boolean }
export type HandleWonLost = (env: Environment, ids: readonly number[], oldStatus: ReadonlyMap<number, WonLost>,
  newStatus: ReadonlyMap<number, WonLost>) => Promise<void>;

let handleWonLostImpl: HandleWonLost | null = null;
/** Installed by src/models/crm_lead_pls.ts (`_handle_won_lost`, crm_lead.py:905). */
export function setHandleWonLost(fn: HandleWonLost): void { handleWonLostImpl = fn; }
async function handleWonLost(env: Environment, ids: readonly number[], oldStatus: ReadonlyMap<number, WonLost>, newStatus: ReadonlyMap<number, WonLost>): Promise<void> {
  if (handleWonLostImpl === null) throw new NotPorted("crm.lead _handle_won_lost (src/models/crm_lead_pls.ts)");
  await handleWonLostImpl(env, ids, oldStatus, newStatus);
}

// ------------------------------------------------------------------------------------------------ helpers

async function str(rec: Rec, name: string): Promise<string | null> {
  const v = await rec.get(name);
  return typeof v === "string" && v !== "" ? v : null;
}
const isSet = (v: unknown): boolean => v !== null && v !== undefined && v !== false && v !== "" && !(Array.isArray(v) && v.length === 0);
/** Many2one cache value -> id (a new record has none). */
const idOf = (v: unknown): number | null => (typeof v === "number" ? v : v instanceof DbRec ? v.id : null);

async function nowString(env: Environment): Promise<string> {
  return datetimeToString(await dbNow(env));
}


/** iap/tools/iap_tools.py:20-47 `_MAIL_PROVIDERS` (generic mail providers and the dummy example.com), in its order. */
const MAIL_PROVIDERS: ReadonlySet<string> = new Set([
  "gmail.com", "hotmail.com", "yahoo.com", "qq.com", "outlook.com", "163.com", "yahoo.fr", "live.com", "hotmail.fr", "icloud.com",
  "126.com", "me.com", "free.fr", "ymail.com", "msn.com", "mail.com", "orange.fr", "aol.com", "wanadoo.fr", "live.fr", "mail.ru",
  "yahoo.co.in", "rediffmail.com", "hku.hk", "googlemail.com", "gmx.de", "sina.com", "skynet.be", "laposte.net", "yahoo.co.uk",
  "yahoo.co.id", "web.de", "gmail.com ", "outlook.fr", "telenet.be", "yahoo.es", "naver.com", "hotmail.co.uk", "gmai.com", "foxmail.com",
  "hku.hku", "bluewin.ch", "sfr.fr", "libero.it", "mac.com", "rocketmail.com", "protonmail.com", "gmx.com", "gamil.com", "hotmail.es",
  "gmx.net", "comcast.net", "yahoo.com.mx", "linkedin.com", "yahoo.com.br", "yahoo.in", "yahoo.ca", "t-online.de", "139.com", "yandex.ru",
  "yahoo.com.hk", "yahoo.de", "yeah.net", "yandex.com", "nwytg.net", "neuf.fr", "yahoo.com.ar", "outlook.es", "abv.bg", "aliyun.com",
  "yahoo.com.tw", "ukr.net", "live.nl", "wp.pl", "hotmail.it", "live.com.mx", "zoho.com", "live.co.uk", "sohu.com", "twoomail.com",
  "yahoo.com.sg", "yahoo.com.vn", "windowslive.com", "gmail", "vols.utk.edu", "email.com", "tiscali.it", "yahoo.it", "gmx.ch", "trbvm.com",
  "nwytg.com", "mvrht.com", "nyit.edu", "o2.pl", "live.cn", "gmial.com", "seznam.cz", "live.be", "videotron.ca", "gmil.com", "live.ca",
  "hotmail.de", "sbcglobal.net", "connect.hku.hk", "yahoo.com.au", "att.net", "live.in", "btinternet.com", "gmx.fr", "voila.fr", "shaw.ca",
  "prodigy.net.mx", "vip.qq.com", "yahoo.com.ph", "bigpond.com", "7thcomputing.com", "freenet.de", "alice.it", "esi.dz", "bk.ru",
  "mail.odoo.com", "gmail.con", "fiu.edu", "gmal.com", "useemlikefun.com", "google.com", "trbvn.com", "yopmail.com", "ya.ru",
  "hotmail.co.th", "arcor.de", "hotmail.ca", "21cn.com", "live.de", "outlook.de", "gmailcom", "unal.edu.co", "tom.com", "yahoo.gr",
  "gmx.at", "inbox.lv", "ziggo.nl", "xs4all.nl", "sapo.pt", "live.com.au", "nate.com", "online.de", "sina.cn", "gmail.co", "rogers.com",
  "mailinator.com", "cox.net", "hotmail.be", "verizon.net", "yahoo.co.jp", "usa.com", "consultant.com", "hotmai.com", "189.cn", "sky.com",
  "eezee-it.com", "opayq.com", "maildrop.cc", "home.nl", "virgilio.it", "outlook.be", "hanmail.net", "uol.com.br", "hec.ca",
  "terra.com.br", "inbox.ru", "tin.it", "list.ru", "hotmail.com ", "safecoms.com", "smile.fr", "sprintit.fi", "uniminuto.edu.co",
  "bol.com.br", "bellsouth.net", "nirmauni.ac.in", "ldc.edu.in", "ig.com.br", "engineer.com", "scarlet.be", "inbox.com", "gmaill.com",
  "freemail.hu", "live.it", "blackwaretech.com", "byom.de", "dispostable.com", "dayrep.com", "aim.com", "prixgen.com", "gmail.om",
  "asterisk-tech.mn", "in.com", "aliceadsl.fr", "lycos.com", "topnet.tn", "teleworm.us", "kedgebs.com", "supinfo.com", "posteo.de",
  "yahoo.com ", "op.pl", "gmail.fr", "grr.la", "oci.fr", "aselcis.com", "optusnet.com.au", "mailcatch.com", "rambler.ru", "protonmail.ch",
  "prisme.ch", "bbox.fr", "orbitalu.com", "netcourrier.com", "iinet.net.au", "cegetel.net", "proton.me", "dbmail.com", "club-internet.fr",
  "outlook.jp", "eim.ae", "pm.me", "ik.me", "etik.com", "ikmail.com", "example.com",
]);
/** :49 `_MAIL_DOMAIN_BLACKLIST = _MAIL_PROVIDERS | {'odoo.com'}`. */
const MAIL_DOMAIN_BLACKLIST: ReadonlySet<string> = new Set([...MAIL_PROVIDERS, "odoo.com"]);
/** Whether `domain` is in iap_tools._MAIL_PROVIDERS (crm_iap_enrich crm_lead.py:72 discards these domains). */
export function mailProviderDomain(domain: string): boolean {
  return MAIL_PROVIDERS.has(domain);
}
/** iap/tools/iap_tools.py:62-87 mail_prepare_for_domain_search (min_email_length=0). */
function mailPrepareForDomainSearch(email: string | null): string | null {
  if (!email) return null;
  const check = emailNormalize(email) ?? email.toLowerCase();
  const at = check.lastIndexOf("@");
  if (at < 0) return check;
  const domain = check.slice(at + 1);
  return MAIL_DOMAIN_BLACKLIST.has(domain) ? check : `@${domain}`;
}

/** sales_team/models/crm_team.py:19-81 `_get_default_team_id(user_id, domain)` for domain [(use_x, '=', True)]. */
export async function defaultTeam(env: Environment, userId: number, useField: "use_leads" | "use_opportunities"): Promise<number | null> {
  const ctxTeam = env.context["default_team_id"];
  const defaultTeamId = typeof ctxTeam === "number" && ctxTeam ? ctxTeam : null;
  const userCompanies = (await env.sudo().model("res.users").read([userId], ["company_ids"], ""))[0]?.["company_ids"];
  const companies = new Set(await env.companies());
  const validCids: (number | false)[] = [false, ...(Array.isArray(userCompanies) ? (userCompanies as number[]) : []).filter((c) => companies.has(c))];
  const Team = env.model("crm.team");
  const teams = await Team.search(D.and([D.cond("company_id", "in", validCids),
    D.or([D.cond("user_id", "=", userId), D.cond("member_ids", "in", [userId])])]));
  const matching = async (ids: number[]): Promise<number[]> =>
    ids.length === 0 ? [] : await Team.search(D.and([D.cond("id", "in", ids), D.cond(useField, "=", true)]))
      .then((found) => ids.filter((id) => found.includes(id))); // filtered_domain keeps the order of `ids`
  let team: number | null = null;
  if (teams.length) {
    const filtered = await matching(teams);
    team = defaultTeamId !== null && filtered.includes(defaultTeamId) ? defaultTeamId : filtered[0] ?? null;
  }
  if (team === null) team = defaultTeamId !== null && teams.includes(defaultTeamId) ? defaultTeamId : teams[0] ?? null;
  if (team === null && defaultTeamId !== null) team = defaultTeamId;
  if (team === null) {
    const all = await Team.search(D.cond("company_id", "in", validCids));
    if (all.length) team = (await matching(all))[0] ?? null;
    if (team === null) team = all[0] ?? null;
  }
  return team;
}

/** crm_lead.py:1001-1025 `_stage_find(domain=[('fold', '=', False)])` for one lead. */
async function stageFind(env: Environment, teamId: number | null): Promise<number | null> {
  const base = teamId !== null
    ? D.or([D.cond("team_ids", "=", false), D.cond("team_ids", "in", [teamId])])
    : D.cond("team_ids", "=", false);
  const ids = await env.model("crm.stage").search(D.and([base, D.cond("fold", "=", false)]), { order: "sequence, id", limit: 1 });
  return ids[0] ?? null;
}

// ------------------------------------------------------------------------------------------------ defaults

registerDefaults(MODEL, {
  user_id: async (env) => env.uid, // :108 default=lambda self: self.env.user
  active: async () => true, // :125
  // :128 'lead' if the user has crm.group_use_lead else 'opportunity'
  type: async (env) => ((await hasGroup(env, "crm.group_use_lead")) ? "lead" : "opportunity"),
  priority: async () => "0", // :132 AVAILABLE_PRIORITIES[0][0] (crm_stage.py)
  color: async () => 0, // :141
  expected_revenue: async () => 0, // :143
  recurring_revenue: async () => 0, // :145
  message_bounce: async () => 0, // mail_thread_blacklist.py:44
});

// ------------------------------------------------------------------------------------------------ stored computes

const ADDRESS_FIELDS = ["street", "street2", "city", "zip", "state_id", "country_id"] as const; // :69 PARTNER_ADDRESS_FIELDS_TO_SYNC

/** :658-664 `_prepare_address_values_from_partner`: all address fields of the partner, or the lead's own. */
async function addressValue(rec: Rec, field: string): Promise<unknown> {
  const partner = await rec.rel("partner_id");
  if (partner) {
    let any = false;
    for (const f of ADDRESS_FIELDS) if (isSet(await partner.get(f))) any = true;
    if (any) return partner.get(field);
  }
  return rec.prev(field);
}

/** :680-697 `_get_partner_email_update(force_void)`. */
async function partnerEmailUpdate(rec: Rec, forceVoid: boolean, own?: unknown): Promise<boolean> {
  const partner = await rec.rel("partner_id");
  const ownValue = own === undefined ? await rec.get("email_from") : own;
  const email = typeof ownValue === "string" && ownValue !== "" ? ownValue : null;
  if (!partner || !(forceVoid || email)) return false;
  const pEmail = await str(partner, "email");
  if (email === pEmail) return false;
  const lead = emailNormalize(email) ?? email ?? false;
  const part = emailNormalize(pEmail) ?? pEmail ?? false;
  return lead !== part;
}

/** mail.thread.phone `_phone_get_country` for crm.lead: the lead's country, else the company's (phone_validation). */
async function phoneCountry(env: Environment, rec: Rec): Promise<string | null> {
  const country = await rec.rel("country_id");
  if (country) return str(country, "code");
  const company = await rec.rel("company_id");
  const companyId = company?.id ?? (await env.company());
  const row = (await env.cr.query<{ code: string | null }>(
    `SELECT c.code FROM res_company co JOIN res_partner p ON p.id = co.partner_id LEFT JOIN res_country c ON c.id = p.country_id WHERE co.id = $1`,
    [companyId])).rows[0];
  return row?.code ?? null;
}

/** :699-716 `_get_partner_phone_update(force_void)`. */
async function partnerPhoneUpdate(env: Environment, rec: Rec, forceVoid: boolean, own?: unknown): Promise<boolean> {
  const partner = await rec.rel("partner_id");
  const ownValue = own === undefined ? await rec.get("phone") : own;
  const phone = typeof ownValue === "string" && ownValue !== "" ? ownValue : null;
  if (!partner || !(forceVoid || phone)) return false;
  const pPhone = await str(partner, "phone");
  if (phone === pPhone) return false;
  const lead = (await canonicalPhone(phone, await phoneCountry(env, rec))) || phone || false;
  const pCountry = await partner.rel("country_id");
  const part = (await canonicalPhone(pPhone, pCountry ? await str(pCountry, "code") : await phoneCountry(env, rec))) || pPhone || false;
  return lead !== part;
}

registerRecordCompute(MODEL, {
  // :286-301 _compute_team_id (a void user keeps the team)
  team_id: async (env, rec) => {
    const user = idOf(await rec.get("user_id"));
    const current = await rec.prev("team_id");
    if (user === null) return current;
    const teamId = idOf(current);
    if (teamId !== null) {
      const t = (await env.sudo().model("crm.team").read([teamId], ["member_ids", "user_id"], ""))[0];
      const members = Array.isArray(t?.["member_ids"]) ? (t["member_ids"] as number[]) : [];
      if (members.includes(user) || t?.["user_id"] === user) return current;
    }
    const type = await rec.get("type");
    const team = await defaultTeam(env, user, type === "lead" ? "use_leads" : "use_opportunities");
    return team ?? (teamId === null ? current : null);
  },
  // :302-337 _compute_company_id
  company_id: async (env, rec) => {
    let proposal = idOf(await rec.prev("company_id"));
    const user = idOf(await rec.get("user_id"));
    const team = await rec.rel("team_id");
    const teamCompany = team ? idOf(await team.get("company_id")) : null;
    const partner = await rec.rel("partner_id");
    const userCompanies = async (): Promise<number[]> => {
      if (user === null) return [];
      const v = (await env.sudo().model("res.users").read([user], ["company_ids"], ""))[0]?.["company_ids"];
      return Array.isArray(v) ? (v as number[]) : [];
    };
    if (proposal !== null) {
      if (user !== null && !(await userCompanies()).includes(proposal)) proposal = null;
      else if (teamCompany !== null && proposal !== teamCompany) proposal = null;
      else if (team && teamCompany === null && user === null) proposal = null;
      else if (!team && user === null && (!partner || idOf(await partner.get("company_id")) !== proposal)) proposal = null;
    }
    if (proposal !== null) return proposal;
    if (teamCompany !== null) return teamCompany;
    if (user !== null) {
      const company = await env.company();
      const ucs = await userCompanies();
      if (ucs.includes(company)) return company;
      const own = (await env.sudo().model("res.users").read([user], ["company_id"], ""))[0]?.["company_id"];
      return typeof own === "number" && (await env.companies()).includes(own) ? own : null;
    }
    if (partner) return idOf(await partner.get("company_id"));
    return null;
  },
  // :339-343 _compute_stage_id
  stage_id: async (env, rec) => {
    // `lead.stage_id` inside its own compute: the value before recomputation
    const prevStage = await rec.prev("stage_id");
    const stage = typeof prevStage === "number" ? new DbRec(env, env.reg.model("crm.stage"), prevStage) : prevStage instanceof NewRec ? prevStage : null;
    const team = idOf(await rec.get("team_id"));
    if (stage) {
      if (team === null) return stage instanceof NewRec ? stage : stage.id;
      const teams = await stage.get("team_ids");
      if (!Array.isArray(teams) || teams.length === 0 || teams.includes(team)) return stage.id;
    }
    return stageFind(env, team);
  },
  // :345-349 _compute_date_open
  date_open: async (env, rec) => {
    const cur = await rec.prev("date_open");
    if (!cur && idOf(await rec.get("user_id")) !== null) return nowString(env);
    return cur;
  },
  // :351-355 _compute_date_last_stage_update
  date_last_stage_update: async (env, rec) => (await rec.prev("date_last_stage_update")) || nowString(env),
  // :357-366 _compute_day_open; :368-376 _compute_day_close (None for others: an integer column -> 0)
  day_open: async (_env, rec) => dayDiff(await rec.get("create_date"), await rec.get("date_open"), true),
  day_close: async (_env, rec) => dayDiff(await rec.get("create_date"), await rec.get("date_closed"), false),
  // :388-392 _compute_name
  name: async (env, rec) => {
    const cur = await rec.prev("name");
    const partner = await rec.rel("partner_id");
    if (!cur && partner) {
      const pname = await str(partner, "name");
      if (pname) return translate(env, "%s's opportunity").replace("%s", pname);
    }
    return cur;
  },
  // :394-400 _compute_contact_name (:666 _prepare_contact_name_from_partner)
  contact_name: async (_env, rec) => {
    const partner = await rec.rel("partner_id");
    if (!partner) return null;
    const name = (await partner.get("is_company")) ? null : await str(partner, "name");
    return name ?? (await rec.prev("contact_name"));
  },
  // :402-408 _compute_partner_name (:670 _prepare_partner_name_from_partner)
  partner_name: async (_env, rec) => {
    const partner = await rec.rel("partner_id");
    if (!partner) return null;
    const parent = await partner.rel("parent_id");
    let name = parent ? await str(parent, "name") : null;
    if (!name && (await partner.get("is_company"))) name = await str(partner, "name");
    else if (!name && (await str(partner, "parent_name"))) name = await str(partner, "parent_name");
    return name ?? (await rec.prev("partner_name"));
  },
  // :410-415 _compute_function, :417-422 _compute_website
  function: async (_env, rec) => {
    const cur = await rec.prev("function");
    const partner = await rec.rel("partner_id");
    const pv = partner ? await str(partner, "function") : null;
    return !cur || pv ? pv : cur;
  },
  website: async (_env, rec) => {
    const cur = await rec.prev("website");
    const partner = await rec.rel("partner_id");
    const pv = partner ? await str(partner, "website") : null;
    return !cur || pv ? pv : cur;
  },
  // :424-438 _compute_lang_id (leads without partner keep their value)
  lang_id: async (env, rec) => {
    const partner = await rec.rel("partner_id");
    if (!partner) return rec.prev("lang_id");
    const code = await str(partner, "lang");
    if (!code) return null;
    const row = (await env.cr.query<{ id: number }>("SELECT id FROM res_lang WHERE code = $1", [code])).rows[0];
    return row?.id ?? null;
  },
  // :444-448 _compute_partner_address_values
  street: async (_env, rec) => addressValue(rec, "street"),
  street2: async (_env, rec) => addressValue(rec, "street2"),
  city: async (_env, rec) => addressValue(rec, "city"),
  zip: async (_env, rec) => addressValue(rec, "zip"),
  state_id: async (_env, rec) => addressValue(rec, "state_id"),
  country_id: async (_env, rec) => addressValue(rec, "country_id"),
  // :450-454 _compute_email_from
  email_from: async (_env, rec) => {
    const partner = await rec.rel("partner_id");
    const pEmail = partner ? await str(partner, "email") : null;
    // inside its own compute, `lead.email_from` is the value before recomputation
    const own = await rec.prev("email_from");
    if (pEmail && (await partnerEmailUpdate(rec, true, own))) return pEmail;
    return own;
  },
  // mail_thread_blacklist.py:61 _compute_email_normalized (email_normalize(strict=False) of the primary email)
  email_normalized: async (_env, rec) => emailNormalize(await str(rec, "email_from")),
  // :461-467 _compute_email_domain_criterion
  email_domain_criterion: async (_env, rec) => mailPrepareForDomainSearch(await str(rec, "email_normalized")),
  // :469-474 _compute_phone
  phone: async (env, rec) => {
    const partner = await rec.rel("partner_id");
    const pPhone = partner ? await str(partner, "phone") : null;
    const own = await rec.prev("phone");
    if (pPhone && (await partnerPhoneUpdate(env, rec, true, own))) return pPhone;
    return own;
  },
  // mail_thread_phone.py:148 _compute_phone_sanitized
  phone_sanitized: async (env, rec) => (await canonicalPhone(await str(rec, "phone"), await phoneCountry(env, rec))) || null,
  // :480-491 _compute_phone_state (phone_parse raises UserError on invalid numbers)
  phone_state: async (env, rec) => {
    const phone = await str(rec, "phone");
    if (!phone) return null;
    const country = await rec.rel("country_id");
    const code = country ? await str(country, "code") : null;
    return (await canonicalPhone(phone, code)) ? "correct" : "incorrect";
  },
  // :493-499 _compute_email_state
  email_state: async (_env, rec) => {
    if (!(await str(rec, "email_from"))) return null;
    return (await rec.get("email_normalized")) ? "correct" : "incorrect";
  },
  // :518-536 prorated revenues
  prorated_revenue: async (_env, rec) => round2((num(await rec.get("expected_revenue")) * num(await rec.get("probability"))) / 100),
  // monetary values are rounded with the currency on assignment (fields_numeric.py:271 convert_to_cache)
  recurring_revenue_monthly: async (_env, rec) => {
    const plan = await rec.rel("recurring_plan");
    const months = plan ? num(await plan.get("number_of_months")) : 0;
    return round2(num(await rec.get("recurring_revenue")) / (months || 1));
  },
  recurring_revenue_monthly_prorated: async (_env, rec) => round2((num(await rec.get("recurring_revenue_monthly")) * num(await rec.get("probability"))) / 100),
  recurring_revenue_prorated: async (_env, rec) => round2((num(await rec.get("recurring_revenue")) * num(await rec.get("probability"))) / 100),
  // :562-570 _compute_won_status
  won_status: async (_env, rec) => {
    const probability = num(await rec.get("probability"));
    const stage = await rec.rel("stage_id");
    if (probability === 100 && stage && (await stage.get("is_won"))) return "won";
    if (!(await rec.get("active")) && probability === 0) return "lost";
    return "pending";
  },
  // mail_tracking_duration_mixin.py:29-57 _compute_duration_tracking
  duration_tracking: async (env, rec) => {
    const now = await dbNow(env);
    const prev = await rec.prev("duration_tracking");
    const dict: Record<string, unknown> = typeof prev === "object" && prev !== null && !Array.isArray(prev) ? { ...(prev as Record<string, unknown>) } : {};
    const last = dict["s"];
    if (last !== undefined && last !== null && typeof dict["d"] === "string") {
      const old = new Date(`${(dict["d"] as string).replace(" ", "T")}Z`);
      const key = String(last);
      const prevMinutes = typeof dict[key] === "number" ? (dict[key] as number) : 0;
      dict[key] = prevMinutes + Math.trunc((now.getTime() - old.getTime()) / 60000);
    }
    const stage = idOf(await rec.get("stage_id"));
    dict["s"] = stage ?? 0;
    dict["d"] = datetimeToString(now);
    return dict;
  },
  // properties: the values follow the definition of the team (fields_properties.py); empty without a definition
  lead_properties: async (_env, rec) => {
    const cur = await rec.prev("lead_properties");
    if (isSet(cur) && !(typeof cur === "object" && cur !== null && Object.keys(cur).length === 0)) {
      throw new NotPorted("crm.lead.lead_properties with values");
    }
    const team = await rec.rel("team_id");
    const def = team ? await team.get("lead_properties_definition") : null;
    if (Array.isArray(def) && def.length) throw new NotPorted("crm.lead.lead_properties with a team definition");
    return cur ?? null;
  },
});

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}
/** Python round(x, 2) (banker's rounding on the binary value, close enough to float repr for 2 digits). */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** `abs((date_b - date_a).days)` of two naive datetimes; None when one is missing (an int column stores 0). */
function dayDiff(create: unknown, other: unknown, dropMicro: boolean): number {
  if (typeof create !== "string" || typeof other !== "string") return 0;
  const a = Date.parse(`${(dropMicro ? create.slice(0, 19) : create).replace(" ", "T")}Z`);
  const b = Date.parse(`${other.replace(" ", "T")}Z`);
  const days = Math.floor((b - a) / 86_400_000); // timedelta.days floors
  return Math.abs(days);
}

// ------------------------------------------------------------------------------------------------ non-stored (new records)

/** mail_tracking_duration_mixin.py:99-125 (src/models/rotting.ts) with crm_lead.py:382-386, for one record. */
function rottingOf(env: Environment, rec: Rec): Promise<Rotting> {
  return mixinRotting(env, rec, async (r) => (await r.get("won_status")) === "pending" && (await r.get("type")) === "opportunity");
}

registerRecordCompute(MODEL, {
  is_rotting: async (env, rec) => (await rottingOf(env, rec)).is_rotting,
  rotting_days: async (env, rec) => (await rottingOf(env, rec)).rotting_days,
  // crm_lead.py:272-278
  company_currency: async (env, rec) => {
    const company = await rec.rel("company_id");
    if (company) return company.get("currency_id");
    const row = (await env.cr.query<{ currency_id: number }>("SELECT currency_id FROM res_company WHERE id = $1", [await env.company()])).rows[0];
    return row?.currency_id ?? null;
  },
  // :263-270
  user_company_ids: async (env, rec) => {
    const company = idOf(await rec.get("company_id"));
    return company !== null ? [company] : env.model("res.company").search(D.TRUE);
  },
  // :440-442
  lang_active_count: async (env) => Number((await env.cr.query<{ n: string }>("SELECT count(*)::text AS n FROM res_lang WHERE active")).rows[0]?.n ?? 0),
  // :501-506
  is_automated_probability: async (_env, rec) =>
    Math.abs(Math.round((num(await rec.get("probability")) - num(await rec.get("automated_probability"))) * 100) / 100) < 0.005,
  // crm_iap_enrich/models/crm_lead.py:19-26
  show_enrich_button: async (_env, rec) => !(!(await rec.get("active")) || !(await str(rec, "email_from"))
    || (await rec.get("email_state")) === "incorrect" || (await rec.get("iap_enrich_done")) || (await str(rec, "reveal_id"))
    || num(await rec.get("probability")) === 100),
  partner_email_update: async (_env, rec) => partnerEmailUpdate(rec, false),
  partner_phone_update: async (env, rec) => partnerPhoneUpdate(env, rec, false),
  // mail_thread_phone.py:159
  phone_formatted: async (_env, rec) => (await internationalPhone((await rec.get("phone_sanitized")) as string | null)) || null,
  // mail_thread_blacklist.py:83
  is_blacklisted: async (env, rec) => {
    const email = await rec.get("email_normalized");
    return !!email && (await env.cr.query("SELECT 1 FROM mail_blacklist WHERE active AND email = $1", [email])).rows.length > 0;
  },
  // mail_thread_phone.py:163-179 (number fields of crm.lead: ['phone'])
  phone_blacklisted: async (env, rec) => {
    const n = await rec.get("phone_sanitized");
    if (!n || (await env.cr.query("SELECT 1 FROM phone_blacklist WHERE active AND number = $1", [n])).rows.length === 0) return false;
    return (await canonicalPhone(await str(rec, "phone"), await phoneCountry(env, rec))) === n;
  },
  // crm_lead.py:572-627 on the record's own values: in an onchange the email, phone or customer may have changed
  duplicate_lead_count: async (env, rec) => {
    const partner = await rec.rel("partner_id");
    if (partner && partner.id === null) throw new NotPorted("crm.lead.duplicate_lead_count with a new customer (child_of a NewId)");
    const commercial = partner ? idOf(await partner.get("commercial_partner_id")) : null;
    return duplicateLeadCount(env, rec.origin, {
      email_domain_criterion: ((await rec.get("email_domain_criterion")) as string | null) || null,
      partner_id: partner ? partner.id : null, commercial_partner_id: commercial,
      phone_sanitized: ((await rec.get("phone_sanitized")) as string | null) || null,
    });
  },
  // values that depend on other tables only: the origin's (an unsaved record has none)
  ...Object.fromEntries(["meeting_display_date", "meeting_display_label", "project_count", "task_count", "quotation_count",
    "sale_amount_total", "sale_order_count", "message_needaction",
    "activity_state", "activity_user_id", "activity_date_deadline", "my_activity_date_deadline", "activity_exception_decoration",
    "activity_exception_icon", "activity_calendar_event_id"].map((f) => [f, async (env: Environment, rec: Rec): Promise<unknown> => originValue(env, rec, f)])),
});

/** Non-stored values of a new record read from its origin; a record without origin gets the compute's empty result. */
async function originValue(env: Environment, rec: Rec, field: string): Promise<unknown> {
  if (rec.origin !== null && rec instanceof NewRec) {
    // these computes do not depend on the record's own editable fields (duplicate_lead_count, which does, is computed
    // on the record's values above)
    return (await new DbRec(env, rec.def, rec.origin).get(field));
  }
  // models.py new(): no origin -> the computes see an empty record
  switch (field) {
    case "meeting_display_label": return translate(env, "No Meeting");
    case "project_count": case "task_count": case "quotation_count": case "sale_order_count": case "rotting_days": return 0;
    case "sale_amount_total": return 0;
    case "is_rotting": case "message_needaction": return false;
    default: return null;
  }
}

// ------------------------------------------------------------------------------------------------ create / write

async function statusOf(env: Environment, ids: readonly number[]): Promise<Map<number, WonLost>> {
  const rows = await env.sudo().withContext({ ...env.context, active_test: false }).model(MODEL).read(ids, ["won_status"], "");
  return new Map(rows.map((r) => [Number(r["id"]), { is_lost: r["won_status"] === "lost", is_won: r["won_status"] === "won" }]));
}

async function enrichTrigger(env: Environment): Promise<void> {
  // crm_iap_enrich/models/crm_lead.py:41-49: trigger the enrichment cron in 'auto' mode (ir_cron.py:750 _trigger,
  // :790 _trigger_list: an inactive cron skips triggers that are not in the future)
  const mode = (await env.cr.query<{ value: string }>("SELECT value FROM ir_config_parameter WHERE key = 'crm.iap.lead.enrich.setting'")).rows[0]?.value || "auto";
  if (mode !== "auto") return;
  const cronId = await env.reg.xmlid(env.cr, "crm_iap_enrich.ir_cron_lead_enrichment");
  if (cronId === null) return;
  const active = (await env.cr.query<{ active: boolean }>("SELECT active FROM ir_cron WHERE id = $1", [cronId])).rows[0]?.active;
  if (!active) return;
  await env.cr.query(
    `INSERT INTO ir_cron_trigger (cron_id, call_at, create_uid, create_date, write_uid, write_date)
     VALUES ($1, date_trunc('second', now() AT TIME ZONE 'UTC'), $2, now() AT TIME ZONE 'UTC', $2, now() AT TIME ZONE 'UTC')`,
    [cronId, env.uid]);
}

registerOverrides(MODEL, {
  inverse: {
    // crm_lead.py:456-459 _inverse_email_from: push the lead email to the partner when it differs
    email_from: async (env, ids) => {
      for (const id of ids) {
        const rec = new DbRec(env, env.reg.model(MODEL), id);
        if (await partnerEmailUpdate(rec, false)) {
          await write(env, "res.partner", [idOf(await rec.get("partner_id"))!], { email: (await rec.get("email_from")) || false });
        }
      }
    },
    // crm_lead.py:476-479 _inverse_phone
    phone: async (env, ids) => {
      for (const id of ids) {
        const rec = new DbRec(env, env.reg.model(MODEL), id);
        if (await partnerPhoneUpdate(env, rec, false)) {
          await write(env, "res.partner", [idOf(await rec.get("partner_id"))!], { phone: (await rec.get("phone")) || false });
        }
      }
    },
  },
  // crm_lead.py:728-758, wrapped by crm_iap_enrich create (:41-49)
  create: async (env, valsList, next) => {

    for (const vals of valsList) if (typeof vals["website"] === "string" && vals["website"]) vals["website"] = cleanWebsite(vals["website"]);
    const ids = await next(env, valsList);
    // :735-737 leads created directly in a won stage get date_closed
    const rows = await env.model(MODEL).read(ids, ["date_closed", "stage_id"], "");
    const wonStages = new Set((await env.cr.query<{ id: number }>("SELECT id FROM crm_stage WHERE is_won")).rows.map((r) => r.id));
    const wonToSet = rows.filter((r) => !r["date_closed"] && typeof r["stage_id"] === "number" && wonStages.has(r["stage_id"])).map((r) => Number(r["id"]));
    if (wonToSet.length) await write(env, MODEL, wonToSet, { date_closed: await nowString(env) });
    await handleWonLost(env, ids, new Map(), await statusOf(env, ids));
    await enrichTrigger(env);
    // :745-755: on import, leads without partner but with contact/address data log crm_lead_creation_message
    if (env.context["import_file"]) {
      const custom = ["partner_name", "contact_name", "function", "website", "street", "street2", "city", "zip", "state_id", "country_id"];
      const rows = await env.sudo().model(MODEL).read(ids, ["partner_id", ...custom], "");
      if (rows.some((r) => !r["partner_id"] && custom.some((f) => r[f]))) throw new NotPorted("crm.lead import creation message (crm_lead_creation_message)");
    }
    return ids;
  },
  // crm_lead.py:760-818
  write: async (env, ids, vals, next) => {
    if (typeof vals["website"] === "string" && vals["website"]) vals["website"] = cleanWebsite(vals["website"]);
    const now = await nowString(env);
    let stageUpdated = false, stageIsWon = false;
    const current = await env.sudo().withContext({ ...env.context, active_test: false }).model(MODEL).read(ids, ["stage_id", "user_id"], "");
    if ("stage_id" in vals) {
      const newStage = vals["stage_id"] || false;
      stageUpdated = current.some((r) => (r["stage_id"] || false) !== newStage);
      if (stageUpdated) vals["date_last_stage_update"] = now;
      if (stageUpdated && newStage) {
        const isWon = (await env.cr.query<{ is_won: boolean }>("SELECT is_won FROM crm_stage WHERE id = $1", [newStage])).rows[0]?.is_won;
        if (isWon) { Object.assign(vals, { active: true, probability: 100, automated_probability: 100 }); stageIsWon = true; }
      }
    }
    if ("user_id" in vals && !vals["user_id"]) vals["date_open"] = false;
    else if (vals["user_id"]) {
      if (current.some((r) => (r["user_id"] || false) !== vals["user_id"])) vals["date_open"] = now;
    }
    const prob = typeof vals["probability"] === "number" ? vals["probability"] : 0;
    if (prob >= 100 || !("active" in vals ? vals["active"] : true)) vals["date_closed"] = now;
    else if (prob > 0) vals["date_closed"] = false;
    else if (stageUpdated && !stageIsWon && !("probability" in vals)) vals["date_closed"] = false;

    const updateFrequencies = ["active", "stage_id", "probability"].some((f) => f in vals);
    const oldStatus = updateFrequencies ? await statusOf(env, ids) : new Map<number, WonLost>();
    if (!stageIsWon) {
      await next(env, ids, vals);
    } else {
      // stage change between two won stages keeps date_closed
      const wonStages = new Set((await env.cr.query<{ id: number }>("SELECT id FROM crm_stage WHERE is_won")).rows.map((r) => r.id));
      const already = current.filter((r) => typeof r["stage_id"] === "number" && wonStages.has(r["stage_id"])).map((r) => Number(r["id"]));
      const remaining = ids.filter((id) => !already.includes(id));
      if (remaining.length) await next(env, remaining, { ...vals });
      if (already.length) { const v = { ...vals }; delete v["date_closed"]; await next(env, already, v); }
    }
    if (updateFrequencies) await handleWonLost(env, ids, oldStatus, await statusOf(env, ids));
  },
});

// crm_lead.py:463 `self.email_domain_criterion = False` before the values (src/orm/recompute.ts RESET_FIRST)
registerResetFirst(MODEL, ["email_domain_criterion"]);
