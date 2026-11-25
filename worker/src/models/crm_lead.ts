/**
 * crm.lead read-side computes the CRM views request (C1, template poc_erp): odoo/addons/crm/models/crm_lead.py and
 * the mixins it inherits (mail.activity.mixin, calendar's activity mixin, mail.tracking.duration.mixin rotting,
 * mail.thread needaction, mail.thread.blacklist, mail.thread.phone), plus the installed overrides of sale_crm,
 * crm_sale_project and crm_iap_enrich. Branches whose data the template does not hold (sale orders, projects)
 * refuse with NotPorted rather than answer from an unported conversion.
 */
import { NotPorted } from "../errors";
import { and, cond, or, TRUE } from "../orm/domain";
import { registerGroupExpand } from "../web/read_group";
import { envCache, userInfo } from "../orm/env";
import { registerHooks } from "../orm/hooks";
import { joinMany2one, sql, type Sql, type Table } from "../orm/sql";
import type { Environment } from "../orm/types";
import { registerActivityMixin } from "./crm_activity";
import { canonicalPhone, internationalPhone } from "./phone";
import { contextDay, datetimeToString, dbNow, translate } from "./util";

const MODEL = "crm.lead";

interface LeadRow {
  id: number; company_id: number | null; active: boolean | null; email_from: string | null; email_state: string | null;
  email_normalized: string | null; email_domain_criterion: string | null; iap_enrich_done: boolean | null;
  reveal_id: string | null; probability: number | string | null; automated_probability: number | string | null;
  partner_id: number | null; phone: string | null; phone_sanitized: string | null; stage_id: number | null;
  won_status: string | null; type: string | null; date_last_stage_update: string | null; create_date: string | null;
  country_code: string | null; company_country_code: string | null; partner_email: string | null; partner_phone: string | null;
  partner_country_code: string | null; commercial_partner_id: number | null; rotting_threshold_days: number | null;
}

/** The stored columns the computes below read, once per request and id set (as superuser: the ORM cache). */
function leads(env: Environment, ids: readonly number[]): Promise<Map<number, LeadRow>> {
  // not cached per request: computes run again after writes in the same request (web_save reads after create)
  return (async () => {
    const company = await env.company();
    const rows = (await env.cr.query<LeadRow>(
      `SELECT l.id, l.company_id, l.active, l.email_from, l.email_state, l.email_normalized, l.email_domain_criterion,
         l.iap_enrich_done, l.reveal_id, l.probability, l.automated_probability, l.partner_id, l.phone, l.phone_sanitized,
         l.stage_id, l.won_status, l.type, l.date_last_stage_update::text AS date_last_stage_update,
         l.create_date::text AS create_date, c.code AS country_code,
         cc.code AS company_country_code, p.email AS partner_email, p.phone AS partner_phone, pc.code AS partner_country_code,
         p.commercial_partner_id, s.rotting_threshold_days
       FROM crm_lead l
       LEFT JOIN res_country c ON c.id = l.country_id
       LEFT JOIN res_company co ON co.id = COALESCE(l.company_id, $2)
       LEFT JOIN res_partner cp ON cp.id = co.partner_id
       LEFT JOIN res_country cc ON cc.id = cp.country_id
       LEFT JOIN res_partner p ON p.id = l.partner_id
       LEFT JOIN res_country pc ON pc.id = p.country_id
       LEFT JOIN crm_stage s ON s.id = l.stage_id
       WHERE l.id = ANY($1::int[])`, [ids, company])).rows;
    return new Map(rows.map((r) => [r.id, r]));
  })();
}

function each<T>(ids: readonly number[], rows: Map<number, LeadRow>, fn: (r: LeadRow) => T): Map<number, unknown> {
  const out = new Map<number, unknown>();
  for (const id of ids) {
    const r = rows.get(id);
    if (r !== undefined) out.set(id, fn(r));
  }
  return out;
}

async function companyCurrency(env: Environment): Promise<number | null> {
  const row = (await env.cr.query<{ currency_id: number | null }>("SELECT currency_id FROM res_company WHERE id = $1",
    [await env.company()])).rows[0];
  return row?.currency_id ?? null;
}

/** `float_compare(a, b, 2)` (tools/float_utils.py): compare after rounding the difference to 2 digits. */
function floatEqual2(a: number, b: number): boolean {
  return Math.abs(Math.round((a - b) * 100) / 100) < 0.005;
}

/** `tools.email_normalize` for the plain single-address case; anything else is not ported. */
function emailNormalize(email: string | null): string | false {
  if (!email) return false;
  const s = email.trim();
  if (!s.includes("@")) return false; // email_split finds no address
  if (/^[^\s@<>,;"]+@[^\s@<>,;"]+$/.test(s)) return s.toLowerCase();
  throw new NotPorted(`email_normalize of ${JSON.stringify(email)}`);
}

registerActivityMixin(MODEL);

registerHooks(MODEL, {
  computed: {
    // crm_lead.py:272-278
    company_currency: async (env, ids) => {
      const rows = await leads(env, ids);
      const fallback = await companyCurrency(env);
      const companies = [...new Set([...rows.values()].map((r) => r.company_id).filter((c): c is number => c !== null))];
      const cur = new Map((await env.cr.query<{ id: number; currency_id: number | null }>(
        "SELECT id, currency_id FROM res_company WHERE id = ANY($1::int[])", [companies])).rows.map((r) => [r.id, r.currency_id]));
      return each(ids, rows, (r) => (r.company_id === null ? fallback : cur.get(r.company_id) ?? null) ?? false);
    },
    // crm_lead.py:263-270: all companies the user can search, or the lead's company
    user_company_ids: async (env, ids) => {
      const rows = await leads(env, ids);
      const all = rows.size > 0 && [...rows.values()].some((r) => r.company_id === null)
        ? await env.model("res.company").search(TRUE) : [];
      return each(ids, rows, (r) => (r.company_id === null ? all : [r.company_id]));
    },
    // crm_lead.py:440-442: len(res.lang.get_installed())
    lang_active_count: async (env, ids) => {
      const n = (await env.cr.query<{ n: string }>("SELECT count(*)::text AS n FROM res_lang WHERE active")).rows[0]?.n ?? "0";
      return new Map(ids.map((id) => [id, Number(n)]));
    },
    // crm_lead.py:501-506
    is_automated_probability: async (env, ids) => each(ids, await leads(env, ids),
      (r) => floatEqual2(Number(r.probability ?? 0), Number(r.automated_probability ?? 0))),
    // crm_iap_enrich/models/crm_lead.py:19-26
    show_enrich_button: async (env, ids) => each(ids, await leads(env, ids), (r) =>
      !(!r.active || !r.email_from || r.email_state === "incorrect" || r.iap_enrich_done || r.reveal_id || Number(r.probability ?? 0) === 100)),
    // crm_lead.py:629-637 and :680-716 (force_void=False)
    partner_email_update: async (env, ids) => each(ids, await leads(env, ids), (r) => {
      if (r.partner_id !== null && r.email_from && r.email_from !== r.partner_email) {
        return (emailNormalize(r.email_from) || r.email_from || false) !== (emailNormalize(r.partner_email) || r.partner_email || false);
      }
      return false;
    }),
    partner_phone_update: async (env, ids) => {
      const rows = await leads(env, ids);
      const out = new Map<number, unknown>();
      for (const id of ids) {
        const r = rows.get(id);
        if (r === undefined) continue;
        if (r.partner_id !== null && r.phone && r.phone !== r.partner_phone) {
          // _phone_format(fname='phone'): the number in E164 for the record's country (mail_thread_phone.py)
          const lead = (await canonicalPhone(r.phone, r.country_code ?? r.company_country_code)) || r.phone || false;
          const partner = (await canonicalPhone(r.partner_phone, r.partner_country_code ?? r.company_country_code)) || r.partner_phone || false;
          out.set(id, lead !== partner);
        } else {
          out.set(id, false);
        }
      }
      return out;
    },
    // mail_tracking_duration_mixin.py:99-125 with crm_lead.py:379-386 (won_status pending, type opportunity)
    is_rotting: async (env, ids) => rotting(env, ids, "is_rotting"),
    rotting_days: async (env, ids) => rotting(env, ids, "rotting_days"),
    // mail_thread.py:278-293
    message_needaction: async (env, ids) => {
      const user = await userInfo(env);
      const rows = (await env.cr.query<{ res_id: number }>(
        `SELECT msg.res_id FROM mail_message msg
         RIGHT JOIN mail_notification rel ON rel.mail_message_id = msg.id AND rel.res_partner_id = $1
           AND (rel.is_read = false OR rel.is_read IS NULL)
         WHERE msg.model = $2 AND msg.res_id = ANY($3::int[]) AND msg.message_type != 'user_notification'`,
        [user.partnerId, MODEL, ids])).rows;
      const hit = new Set(rows.map((r) => r.res_id));
      return new Map(ids.map((id) => [id, hit.has(id)]));
    },
    // mail_thread_blacklist.py:39 _compute_is_blacklisted
    is_blacklisted: async (env, ids) => {
      const rows = await leads(env, ids);
      const emails = [...new Set([...rows.values()].map((r) => r.email_normalized).filter((e): e is string => !!e))];
      const bl = new Set((await env.cr.query<{ email: string }>(
        "SELECT email FROM mail_blacklist WHERE active AND email = ANY($1::text[])", [emails])).rows.map((r) => r.email));
      return each(ids, rows, (r) => !!r.email_normalized && bl.has(r.email_normalized));
    },
    // phone_validation/models/mail_thread_phone.py:158-161
    phone_formatted: async (env, ids) => {
      const rows = await leads(env, ids);
      const out = new Map<number, unknown>();
      for (const id of ids) {
        const r = rows.get(id);
        if (r !== undefined) out.set(id, await internationalPhone(r.phone_sanitized));
      }
      return out;
    },
    // mail_thread_phone.py:163-179: number fields of crm.lead = ['phone'] (crm_lead.py _phone_get_number_fields)
    phone_blacklisted: async (env, ids) => {
      const rows = await leads(env, ids);
      const numbers = [...new Set([...rows.values()].map((r) => r.phone_sanitized).filter((n): n is string => !!n))];
      const bl = new Set((await env.cr.query<{ number: string }>(
        "SELECT number FROM phone_blacklist WHERE active AND number = ANY($1::text[])", [numbers])).rows.map((r) => r.number));
      const out = new Map<number, unknown>();
      for (const id of ids) {
        const r = rows.get(id);
        if (r === undefined) continue;
        const sanitizedBlacklisted = !!r.phone_sanitized && bl.has(r.phone_sanitized);
        out.set(id, sanitizedBlacklisted && (await canonicalPhone(r.phone, r.country_code ?? r.company_country_code)) === r.phone_sanitized);
      }
      return out;
    },
    // crm_lead.py:538-560: calendar.event read_group as superuser
    meeting_display_date: async (env, ids) => meetings(env, ids, "date"),
    meeting_display_label: async (env, ids) => meetings(env, ids, "label"),
    // sale_crm/models/crm_lead.py:15-27
    quotation_count: async (env, ids) => saleCount(env, ids, ["draft", "sent"], true),
    sale_order_count: async (env, ids) => saleCount(env, ids, ["draft", "sent", "cancel"], false),
    // sale_crm crm_lead.py:16-25: the confirmed orders' totals (`_get_lead_sale_order_domain`) converted to the lead's
    // company currency (`company_currency`, crm_lead.py:273-278); `_convert` of a currency to itself is the amount
    // rounded (res_currency.py:356-375). Orders in another currency refuse (the rate of the order date).
    sale_amount_total: async (env, ids) => {
      const { roundPrecision } = await import("./account_tax_engine");
      const envCurrency = (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [await env.company()])).rows[0]!.c;
      const out = new Map<number, unknown>();
      for (const id of ids) {
        const lead = (await env.cr.query<{ c: number | null }>("SELECT c.currency_id AS c FROM crm_lead l LEFT JOIN res_company c ON c.id = l.company_id WHERE l.id = $1", [id])).rows[0];
        const currency = lead?.c ?? envCurrency;
        const orders = (await env.cr.query<{ currency_id: number; total: number }>(
          `SELECT currency_id, amount_total::float8 AS total FROM sale_order WHERE opportunity_id = $1 AND state NOT IN ('draft', 'sent', 'cancel')
            ORDER BY date_order DESC, id DESC`, [id])).rows;
        if (orders.some((o) => o.currency_id !== currency)) throw new NotPorted("crm.lead.sale_amount_total of orders in another currency (_convert at the order date)");
        const rounding = Number((await env.cr.query<{ r: number }>("SELECT rounding::float8 AS r FROM res_currency WHERE id = $1", [currency])).rows[0]!.r);
        let total = 0;
        for (const o of orders) total += o.total ? roundPrecision(o.total, rounding) : 0;
        out.set(id, total);
      }
      return out;
    },
    // crm_sale_project/models/crm_lead.py:11-35 (_read_group as the user)
    project_count: async (env, ids) => {
      const projects = await env.model("project.project").search(cond("lead_id", "in", [...ids]));
      if (projects.length > 0) throw new NotPorted("crm.lead.project_count with linked projects");
      return new Map(ids.map((id) => [id, 0]));
    },
    task_count: async (env, ids) => {
      const projects = await env.model("project.project").search(cond("lead_id", "in", [...ids]));
      if (projects.length > 0) throw new NotPorted("crm.lead.task_count with linked projects");
      return new Map(ids.map((id) => [id, 0]));
    },
    // crm_lead.py:572-627 (compute_sudo: superuser, active_test=False)
    duplicate_lead_count: async (env, ids) => {
      const rows = await leads(env, ids);
      const out = new Map<number, unknown>();
      for (const id of ids) {
        const r = rows.get(id);
        if (r === undefined) continue;
        out.set(id, await duplicateLeadCount(env, id, {
          email_domain_criterion: r.email_domain_criterion, partner_id: r.partner_id,
          commercial_partner_id: r.commercial_partner_id, phone_sanitized: r.phone_sanitized,
        }));
      }
      return out;
    },
  },
  computeSql: {
    // crm_lead.py:280-284 _compute_sql_company_currency
    company_currency: async (table: Table): Promise<Sql> => {
      const company = await joinMany2one(table, table.fieldDef("company_id"));
      const fallback = await companyCurrency(table.env);
      return sql`(CASE WHEN ${await table.field("company_id")} IS NOT NULL THEN ${await company.field("currency_id")} ELSE ${fallback} END)`;
    },
  },
});

export interface DuplicateCriteria {
  readonly email_domain_criterion: string | null; readonly partner_id: number | null;
  readonly commercial_partner_id: number | null; readonly phone_sanitized: string | null;
}

/** crm_lead.py:572-627 `_compute_potential_lead_duplicates` for one lead: `originId` is `lead._origin.id` (null for a
 *  record that has none: `('id', '!=', False)` excludes nothing). compute_sudo, active_test=False. A saved lead passes
 *  its stored values, a new one (onchange) its cache values. */
export async function duplicateLeadCount(env: Environment, originId: number | null, c: DuplicateCriteria): Promise<number> {
  const model = env.sudo().withContext({ ...env.context, active_test: false }).model("crm.lead");
  const LIMIT = 21; // SEARCH_RESULT_LIMIT
  const relevant = async (domain: ReturnType<typeof and>): Promise<number[]> => {
    const res = await model.search(domain, { limit: LIMIT, activeTest: false });
    return res.length < LIMIT ? res : [];
  };
  const common = (d: ReturnType<typeof cond>) => (originId === null ? d : and([cond("id", "!=", originId), d]));
  const dup = new Set<number>();
  if (c.email_domain_criterion) {
    for (const x of await relevant(common(cond("email_domain_criterion", "=", c.email_domain_criterion)))) dup.add(x);
  }
  if (c.partner_id !== null && c.commercial_partner_id !== null) {
    for (const x of await model.search(common(cond("partner_id", "child_of", [c.commercial_partner_id])), { activeTest: false })) dup.add(x);
  }
  if (c.phone_sanitized) {
    for (const x of await relevant(common(cond("phone_sanitized", "=", c.phone_sanitized)))) dup.add(x);
  }
  return dup.size;
}

async function rotting(env: Environment, ids: readonly number[], which: "is_rotting" | "rotting_days"): Promise<Map<number, unknown>> {
  const rows = await leads(env, ids);
  const now = await dbNow(env);
  // _is_rotting_feature_enabled (mail_tracking_duration_mixin.py:60-80): some stage of the records rots
  const enabled = [...rows.values()].some((r) => (r.rotting_threshold_days ?? 0) !== 0);
  return each(ids, rows, (r) => {
    const empty = which === "is_rotting" ? false : 0;
    if (!enabled) return empty;
    // _get_rotting_domain: stage threshold != 0, won_status pending, type opportunity
    const days = r.rotting_threshold_days ?? 0;
    if (days === 0 || r.won_status !== "pending" || r.type !== "opportunity") return empty;
    const stamp = r.date_last_stage_update ?? r.create_date; // naive UTC timestamps
    const since = stamp === null ? now : new Date(`${stamp.replace(" ", "T")}Z`);
    if (since.getTime() + days * 86_400_000 >= now.getTime()) return empty;
    // (now - (date_last_stage_update or create_date)).days: floor of whole days
    return which === "is_rotting" ? true : Math.floor((now.getTime() - since.getTime()) / 86_400_000);
  });
}

/** crm_lead.py:539-560 `_compute_meeting_display`: the active meetings of each lead (superuser read_group), the next
 *  one to come else the last one, as its day in the environment's zone (`context_timestamp` assigned to a Date). */
async function meetings(env: Environment, ids: readonly number[], which: "date" | "label"): Promise<Map<number, unknown>> {
  const rows = (await env.cr.query<{ opportunity_id: number; start: string }>(
    `SELECT opportunity_id, to_char(start, 'YYYY-MM-DD HH24:MI:SS') AS start FROM calendar_event
      WHERE opportunity_id = ANY($1::int[]) AND active AND start IS NOT NULL`, [ids])).rows;
  const now = datetimeToString(await dbNow(env));
  const starts = new Map<number, string[]>();
  for (const r of rows) starts.set(r.opportunity_id, [...(starts.get(r.opportunity_id) ?? []), r.start]);
  const out = new Map<number, unknown>();
  for (const id of ids) {
    const all = starts.get(id);
    if (!all) { out.set(id, which === "date" ? false : translate(env, "No Meeting")); continue; }
    const next = all.filter((s) => s > now).sort()[0];
    if (which === "label") out.set(id, translate(env, next !== undefined ? "Next Meeting" : "Last Meeting"));
    else out.set(id, await contextDay(env, next ?? [...all].sort().at(-1)!));
  }
  return out;
}

async function saleCount(env: Environment, ids: readonly number[], states: string[], inStates: boolean): Promise<Map<number, unknown>> {
  // lead.order_ids (one2many as the user's cache: no access filter at compute time) filtered on state
  const rows = (await env.cr.query<{ opportunity_id: number; n: string }>(
    `SELECT opportunity_id, count(*)::text AS n FROM sale_order WHERE opportunity_id = ANY($1::int[])
     AND ${inStates ? "" : "NOT "}(state = ANY($2::text[])) GROUP BY opportunity_id`, [ids, states])).rows;
  const by = new Map(rows.map((r) => [r.opportunity_id, Number(r.n)]));
  return new Map(ids.map((id) => [id, by.get(id) ?? 0]));
}


// crm_lead.py:986-999 `_read_group_stage_ids` (stage_id group_expand): the stages of the groups plus the stages
// visible for the user's teams (crm_stage.py:40-42 `_get_visible_stages_domain`), as superuser, in stage order
registerGroupExpand(MODEL, "stage_id", async (env, _model, values) => {
  const defaultTeam = env.context["default_team_id"];
  let teamIds: number[];
  if (env.context["show_team_switcher"] && defaultTeam) teamIds = [Number(defaultTeam)];
  else {
    teamIds = [];
    if (env.context["show_user_team_stages"]) {
      const v = (await env.model("res.users").read([env.uid], ["crm_team_ids"], ""))[0]?.["crm_team_ids"];
      if (Array.isArray(v)) teamIds = v.map(Number);
    }
    if (defaultTeam) teamIds.push(Number(defaultTeam));
  }
  const ids = values.filter((v): v is number => typeof v === "number");
  return env.sudo().model("crm.stage").search(or([cond("id", "in", ids), or([cond("team_ids", "in", teamIds), cond("team_ids", "=", false)])]));
});

// crm_lead.py:825-855 search_fetch: ordering on my_activity_date_deadline searches in two steps, the leads with
// an activity of the user first (ordered by their earliest deadline), then the others
registerHooks(MODEL, {
  searchFetch: async (env, domain, opts, next) => {
    const order = opts.order ?? null;
    if (!order || !order.includes("my_activity_date_deadline")) return next(domain, opts);
    const items = order.split(",").map((i) => i.trim().toLowerCase());
    const asc = items.some((i) => i.includes("my_activity_date_deadline asc"));
    // mail.activity _read_group (the user's own activities bypass the activity rules, mail_activity.py:443)
    const acts = (await env.cr.query<{ res_id: number; d: string }>(
      `SELECT res_id, min(date_deadline)::text AS d FROM mail_activity WHERE res_model = $1 AND user_id = $2 AND active
       GROUP BY res_id ORDER BY min(date_deadline) ASC, res_id`, [MODEL, env.uid])).rows;
    const deadline = new Map(acts.map((a) => [a.res_id, a.d]));
    const rest = items.filter((i) => !i.includes("my_activity_date_deadline")).join(", ");
    const found = await next(and([cond("id", "in", [...deadline.keys()]), domain]), { order: rest || null });
    // sorted(..., key=deadline, reverse=not asc): a stable sort
    const ordered = [...found].sort((a, b) => {
      const x = deadline.get(a) ?? "", y = deadline.get(b) ?? "";
      return asc ? (x < y ? -1 : x > y ? 1 : 0) : (x > y ? -1 : x < y ? 1 : 0);
    });
    const offset = opts.offset ?? 0, limit = opts.limit ?? null;
    const keep = limit ? ordered.slice(offset, offset + limit) : ordered.slice(offset);
    const skip = limit ? ordered.slice(0, offset + limit) : ordered;
    if (limit && keep.length >= limit) return keep;
    const leadLimit = limit ? limit - keep.length : null;
    const leadOffset = offset ? Math.max(offset - found.length, 0) : 0;
    const others = await next(and([cond("id", "not in", skip), domain]), { offset: leadOffset, limit: leadLimit, order: rest || null });
    return [...keep, ...others];
  },
});
