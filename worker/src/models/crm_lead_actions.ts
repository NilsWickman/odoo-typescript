/**
 * crm.lead form buttons that return an action: `action_schedule_meeting` (crm/models/crm_lead.py:1197-1226 with
 * `_get_opportunity_meeting_view_parameters` :1228), `action_show_potential_duplicates` (:1307-1318), and sale_crm's
 * `action_sale_quotations_new` / `action_view_sale_quotation` (sale_crm/models/crm_lead.py:29-51, :68-96).
 * The action dicts are `_for_xml_id` (base/models/ir_actions.py:206-226), the same dict as /web/action/load.
 */
import { NotPorted } from "../errors";
import { registerMethod } from "../http/methods";
import { and, cond } from "../orm/domain";
import { create } from "../orm/create";
import { envTz, userInfo } from "../orm/env";
import { DbRec } from "../orm/recompute";
import { write } from "../orm/write";
import { datetimeToString, dbNow } from "./util";
import type { Environment } from "../orm/types";

const MODEL = "crm.lead";

async function forXmlId(env: Environment, xmlid: string): Promise<Record<string, unknown>> {
  const { loadAction } = await import("../controllers/action");
  return loadAction({ cursor: () => env.cr, context: env.context, uid: env.uid }, xmlid);
}

function one(ids: number[] | null, method: string): number {
  if (!ids || ids.length !== 1) throw new NotPorted(`${MODEL}.${method} on ${ids?.length ?? 0} records (ensure_one)`);
  return ids[0]!;
}

async function lead(env: Environment, id: number, fields: string[]): Promise<Record<string, unknown>> {
  const row = (await env.model(MODEL).read([id], fields, ""))[0];
  if (!row) throw new NotPorted(`${MODEL} ${id} not readable`);
  return row;
}

const m2o = (v: unknown): number | false => (typeof v === "number" ? v : false);

/** sale_crm crm_lead.py:77-96 `_prepare_opportunity_quotation_context`. */
async function quotationContext(env: Environment, id: number): Promise<Record<string, unknown>> {
  const r = await lead(env, id, ["partner_id", "campaign_id", "medium_id", "name", "source_id", "utm_reference", "company_id", "tag_ids", "team_id", "user_id"]);
  if (r["utm_reference"]) throw new NotPorted("quotation context with a utm_reference");
  const ctx: Record<string, unknown> = {
    active_test: true,
    default_opportunity_id: id,
    default_partner_id: m2o(r["partner_id"]),
    default_campaign_id: m2o(r["campaign_id"]),
    default_medium_id: m2o(r["medium_id"]),
    default_origin: r["name"],
    default_source_id: m2o(r["source_id"]),
    default_utm_reference: false,
    default_company_id: m2o(r["company_id"]) || (await env.company()),
    default_tag_ids: [[6, 0, Array.isArray(r["tag_ids"]) ? r["tag_ids"] : []]],
  };
  if (r["team_id"]) ctx["default_team_id"] = r["team_id"];
  if (r["user_id"]) ctx["default_user_id"] = r["user_id"];
  // crm_sale_project crm_lead.py:103-109: self.sudo().project_ids[-1:].id
  const projects = await env.sudo().model("project.project").search(cond("lead_id", "=", id));
  ctx["is_sale_order"] = true;
  ctx["default_project_id"] = projects[projects.length - 1] ?? false;
  return ctx;
}

registerMethod(MODEL, "action_sale_quotations_new", async (env, ids) => {
  const id = one(ids, "action_sale_quotations_new");
  const r = await lead(env, id, ["partner_id"]);
  if (!r["partner_id"]) return forXmlId(env, "sale_crm.crm_quotation_partner_action");
  // action_new_quotation (:35-39)
  const action = await forXmlId(env, "sale_crm.sale_action_quotations_new");
  action["context"] = { ...(await quotationContext(env, id)), search_default_opportunity_id: id };
  return action;
}, { apiModel: false });

registerMethod(MODEL, "action_view_sale_quotation", async (env, ids) => {
  const id = one(ids, "action_view_sale_quotation");
  const action = await forXmlId(env, "sale.action_quotations_with_onboarding");
  action["context"] = { ...(await quotationContext(env, id)), search_default_draft: 1 };
  // Domain.AND([[('opportunity_id', '=', id)], [('state', 'in', ('draft', 'sent', 'cancel'))]])
  action["domain"] = ["&", ["opportunity_id", "=", id], ["state", "in", ["draft", "sent", "cancel"]]];
  const quotations = await env.model("sale.order").search(
    and([cond("opportunity_id", "=", id), cond("state", "in", ["draft", "sent", "cancel"])]));
  if (quotations.length === 1) {
    action["views"] = [[await env.reg.xmlid(env.cr, "sale.view_order_form"), "form"]];
    action["res_id"] = quotations[0]!;
  }
  return action;
}, { apiModel: false });

registerMethod(MODEL, "action_schedule_meeting", async (env, ids, _args, kwargs) => {
  const id = one(ids, "action_schedule_meeting");
  const action = await forXmlId(env, "calendar.action_calendar_event");
  action["context"] = await scheduleMeetingContext(env, id, kwargs["smart_calendar"] !== false);
  return action;
}, { apiModel: false });

/** The context of `action_schedule_meeting` (crm_lead.py:1197-1226) of one lead. */
export async function scheduleMeetingContext(env: Environment, id: number, smart: boolean): Promise<Record<string, unknown>> {
  const r = await lead(env, id, ["partner_id", "type", "team_id", "name"]);
  const partnerIds = [(await userInfo(env)).partnerId];
  if (r["partner_id"]) partnerIds.push(Number(r["partner_id"]));
  const current = r["type"] === "opportunity" ? id : false;
  const ctx: Record<string, unknown> = {
    search_default_opportunity_id: current, default_opportunity_id: current, default_partner_id: m2o(r["partner_id"]),
    default_partner_ids: partnerIds, calendar_include_user_events: true, default_team_id: m2o(r["team_id"]), default_name: r["name"],
  };
  if (current && smart) {
    const [mode, initialDate] = await meetingViewParameters(env, id);
    Object.assign(ctx, { default_mode: mode, initial_date: initialDate });
  }
  return ctx;
}

/** A stored UTC datetime as the naive local time of `tz` ("YYYY-MM-DD HH:MM:SS"). */
function localNaive(utc: string, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(`${utc.slice(0, 19).replace(" ", "T")}Z`));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year").padStart(4, "0")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/** crm_lead.py:1228-1296 `_get_opportunity_meeting_view_parameters`: the calendar's mode and initial date from the
 *  lead's meetings (the unfinished ones if any), in the user's zone except all-day ones. */
async function meetingViewParameters(env: Environment, id: number): Promise<[string, string | false]> {
  const ids = await env.model("calendar.event").search(cond("opportunity_id", "=", id));
  if (!ids.length) return ["week", false];
  const rows = (await env.cr.query<{ start: string; stop: string; allday: boolean | null }>(
    `SELECT to_char(start, 'YYYY-MM-DD HH24:MI:SS') AS start, to_char(stop, 'YYYY-MM-DD HH24:MI:SS') AS stop, allday
       FROM calendar_event WHERE id = ANY($1::int[])`, [ids])).rows;
  const tz = await envTz(env);
  const dts = rows.map((r) => r.allday ? [r.start, r.stop] as const : [localNaive(r.start, tz), localNaive(r.stop, tz)] as const);
  const now = localNaive(datetimeToString(new Date()), tz);
  const unfinished = dts.filter((d) => d[1] >= now);
  const relevant = unfinished.length ? unfinished : dts;
  if (relevant.length === 1) return ["week", relevant[0]![0].slice(0, 10)];
  const earliest = relevant.map((d) => d[0]).sort()[0]!;
  const latest = relevant.map((d) => d[1]).sort().at(-1)!;
  const lang = (await userInfo(env)).lang;
  const ws = (await env.cr.query<{ week_start: string | null }>("SELECT week_start FROM res_lang WHERE code = $1 AND active", [lang])).rows[0]?.week_start;
  if (ws === undefined) throw new NotPorted(`_get_opportunity_meeting_view_parameters without the user's language ${String(lang)}`);
  const weekStartIndex = Number(ws ?? 0) - 1; // int(False) of an empty selection
  const day = new Date(`${earliest.slice(0, 10)}T00:00:00Z`);
  const weekday = (day.getUTCDay() + 6) % 7; // Monday 0
  const remaining = 7 - ((7 + weekday - weekStartIndex) % 7);
  const nextWeekStart = new Date(day.getTime() + remaining * 86400000).toISOString().slice(0, 10);
  return [latest <= `${nextWeekStart} 00:00:00` ? "week" : "month", earliest.slice(0, 10)];
}

registerMethod(MODEL, "action_show_potential_duplicates", async (env, ids) => {
  const id = one(ids, "action_show_potential_duplicates");
  const action = await forXmlId(env, "crm.crm_lead_opportunities");
  // duplicate_lead_ids = duplicates + the lead itself (crm_lead.py:626), as the user; the duplicates come from the
  // read-side compute (src/models/crm_lead.ts) which only counts them
  let dups = await duplicateIds(env, id);
  // reading the many2many as the user drops the leads it cannot read (fields_relational.py:692-719 convert_to_record;
  // the field context active_test=False keeps archived ones)
  if (!env.su) {
    const readable = new Set(await env.model(MODEL).search(cond("id", "in", dups), { activeTest: false }));
    dups = dups.filter((d) => readable.has(d));
  }
  action["domain"] = [["id", "in", dups]];
  action["context"] = { active_test: false, create: false };
  return action;
}, { apiModel: false });

/** crm_lead.py:572-627 `_compute_potential_lead_duplicates` (compute_sudo: superuser, active_test=False). */
async function duplicateIds(env: Environment, id: number): Promise<number[]> {
  const su = env.sudo().withContext({ ...env.context, active_test: false });
  const r = (await su.model(MODEL).read([id], ["email_domain_criterion", "partner_id", "phone_sanitized"], ""))[0]!;
  const model = su.model(MODEL);
  const relevant = async (field: string, value: unknown): Promise<number[]> => {
    const res = await model.search(and([cond("id", "!=", id), cond(field, "=", value)]), { limit: 21, activeTest: false });
    return res.length < 21 ? res : [];
  };
  const out: number[] = [];
  const add = (xs: number[]): void => { for (const x of xs) if (!out.includes(x)) out.push(x); };
  if (r["email_domain_criterion"]) add(await relevant("email_domain_criterion", r["email_domain_criterion"]));
  if (r["partner_id"]) {
    const cp = (await su.model("res.partner").read([Number(r["partner_id"])], ["commercial_partner_id"], ""))[0]?.["commercial_partner_id"];
    if (typeof cp === "number") add(await model.search(and([cond("id", "!=", id), cond("partner_id", "child_of", [cp])]), { activeTest: false }));
  }
  if (r["phone_sanitized"]) add(await relevant("phone_sanitized", r["phone_sanitized"]));
  // `duplicate_lead_ids + lead`: recordset order, then the ids as stored (`.ids`)
  return [...out, id].filter((x, i, a) => a.indexOf(x) === i);
}

/** tools/mail.py parse_contact_from_email: the display name of a formatted address, nothing of a plain one. */
function contactName(email: string): string {
  const text = email.trim();
  if (/^[^\s<>"]+@[^\s<>"]+$/.test(text)) return "";
  const formatted = /^"?([^"<>]+?)"?\s*<[^<>]+>$/.exec(text);
  if (!formatted) throw new NotPorted(`parse_contact_from_email of ${JSON.stringify(email)}`);
  return formatted[1]!;
}

/** crm_lead.py:2006-2040 `_prepare_customer_values`. */
async function customerValues(env: Environment, rec: DbRec, name: unknown): Promise<Record<string, unknown>> {
  const email = await rec.get("email_from");
  const address = typeof email === "string" ? /[^\s<>"]+@[^\s<>"]+/.exec(email)?.[0] ?? false : false;
  const values: Record<string, unknown> = {
    name, user_id: env.context["default_user_id"] || ((await rec.get("user_id")) || false), comment: (await rec.get("description")) || false,
    phone: (await rec.get("phone")) || false, email: address, function: (await rec.get("function")) || false,
    street: (await rec.get("street")) || false, street2: (await rec.get("street2")) || false, zip: (await rec.get("zip")) || false, city: (await rec.get("city")) || false,
    country_id: (await rec.get("country_id")) || false, state_id: (await rec.get("state_id")) || false, website: (await rec.get("website")) || false,
    parent_id: false, type: "contact",
  };
  const partnerName = await rec.get("partner_name");
  if (partnerName) values["parent_name"] = partnerName;
  const lang = await rec.rel("lang_id");
  if (lang && (await lang.get("active"))) values["lang"] = await lang.get("code");
  return values;
}

// crm_lead.py:1320-1326 action_convert_to_opportunity with :1814-1842 convert_opportunity, :1844-1858 `_handle_partner_assignment`
registerMethod(MODEL, "action_convert_to_opportunity", async (env, ids) => {
  const id = one(ids, "action_convert_to_opportunity");
  const { inTrackingScope } = await import("./crm_lead_mail");
  return inTrackingScope(env, [id], () => convertToOpportunity(env, id));
}, { apiModel: false });

async function convertToOpportunity(env: Environment, id: number): Promise<false> {
  const rec = new DbRec(env, env.reg.model(MODEL), id);
  if ((await rec.get("active")) && (await rec.get("won_status")) !== "won") {
    if (!(await rec.get("stage_id"))) throw new NotPorted("action_convert_to_opportunity of a lead without a stage (_stage_find)");
    await write(env, MODEL, [id], { type: "opportunity", date_conversion: datetimeToString(await dbNow(env)) });
  }
  // :1950-1963 `_find_matching_partner`: an address that several partners hold needs `_partner_find_from_emails`' sort
  let partner = (await rec.get("partner_id")) || null;
  const email = (await rec.get("email_normalized")) || (await rec.get("email_from"));
  if (!partner && email) {
    const found = await env.model("res.partner").search(cond("email_normalized", "=", email));
    if (found.length > 1) throw new NotPorted("action_convert_to_opportunity with several partners on the address");
    partner = found[0] ?? null;
  }
  if (partner) { await write(env, MODEL, [id], { partner_id: partner }); return false; }
  // :1965-1986 `_create_customer`, without the context's defaults
  const cenv = env.withContext(Object.fromEntries(Object.entries(env.context).filter(([k]) => !k.startsWith("default_"))));
  const from = await rec.get("email_from");
  const contact = (await rec.get("contact_name")) || (typeof from === "string" ? contactName(from) : "");
  const [created] = await create(cenv, "res.partner", [await customerValues(env, rec, contact || (await rec.get("name")))]);
  await write(env, MODEL, [id], { partner_id: created });
  return false;
}
