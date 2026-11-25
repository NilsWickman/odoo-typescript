/**
 * The non-stored computed fields of res.partner that `read` of every field reaches (round 3, item 6: an unchanged
 * XML-RPC script reading all 206 fields): mail.thread's message counters and followers (mail/models/mail_thread.py
 * :185-340, sms mail_thread.py:20), the address and email formats (base res_partner.py:586-592, :655-685), the main
 * user (:515-530), `self` (:594), `is_public` (:958), and the fields of account, sale, product, phone_validation,
 * mail (discuss, activities), calendar and account_edi_ubl_cii. Each refuses where its Python would take a branch that
 * is not reproduced (an order Python takes from set iteration, credit limits, pricelists, a non-plain email).
 */
import { NotPorted } from "../errors";
import { accessDomain } from "../orm/access";
import { and, cond } from "../orm/domain";
import { hooksOf, registerHooks, type ComputeFn } from "../orm/hooks";
import { userInfo } from "../orm/env";
import { pySetOrder } from "../orm/pyset";
import type { Environment } from "../orm/types";
import { userHasGroup } from "../web/groups";
import { emailNormalize, formatAddr } from "../mail/message";
import { displayAddresses } from "./mail_address";
import { xmlidToResId } from "../session/user";
import { accountMoveCount, countryPricelists, pricelists } from "./partner_erp";
import { registerIsFollower } from "./tail_util";
import * as priv from "../orm/dispatch_gen";

const MODEL = "res.partner";

function each(ids: readonly number[], fn: (id: number) => unknown): Map<number, unknown> {
  return new Map(ids.map((id) => [id, fn(id)]));
}

/** Group `(res_id, n)` rows into a counter per id, 0 for the others. */
function counter(ids: readonly number[], rows: readonly { res_id: number; n: string | number }[]): Map<number, number> {
  const out = new Map<number, number>(ids.map((id) => [id, 0]));
  for (const r of rows) if (out.has(r.res_id)) out.set(r.res_id, (out.get(r.res_id) ?? 0) + Number(r.n));
  return out;
}

/**
 * fields_relational.py:692-725 `_RelationalMulti.convert_to_record`: the records of a computed x2many value the user
 * may read (`_filtered_access('read')`), then the active ones under `active_test`; the order is kept.
 */
async function visible(env: Environment, comodel: string, ids: readonly number[]): Promise<number[]> {
  if (!ids.length) return [];
  const def = env.reg.model(comodel);
  let out = [...new Set(ids)];
  if (!env.su) {
    if ((await accessDomain(env, def, "read")).kind === "false") return [];
    const ok = new Set(await env.withContext({ ...env.context, active_test: false }).model(comodel).search(cond("id", "in", out), { activeTest: false }));
    out = out.filter((id) => ok.has(id));
  }
  if (def.activeName && env.context["active_test"] !== false && out.length) {
    const active = new Set((await env.cr.query<{ id: number }>(`SELECT id FROM "${def.table}" WHERE id = ANY($1::int[]) AND "${def.activeName}"`, [out])).rows.map((r) => r.id));
    out = out.filter((id) => active.has(id));
  }
  return out;
}

/**
 * The mail.thread counters and followers of `model` (mail_thread.py :185-340, sms mail_thread.py:20-37), registered
 * where no model overrides them (hr_timesheet's account.analytic.line overrides `_compute_message_partner_ids`).
 */
export function registerThreadComputes(model: string): void {
  const prev = hooksOf(model).computed ?? {};
  const computed: Record<string, ComputeFn> = {
    // :262-272 `_compute_has_message`
    has_message: async (env, ids) => {
      const hit = new Set((await env.cr.query<{ res_id: number }>(
        "SELECT DISTINCT res_id FROM mail_message mm WHERE res_id = ANY($1::int[]) AND mm.model = $2", [ids, model])).rows.map((r) => r.res_id));
      return each(ids, (id) => hit.has(id));
    },
    // :332-339: `ir.attachment._read_group` as the user (ir_attachment.py `_search`: res_field = False, access)
    message_attachment_count: async (env, ids) => {
      const found = await env.model("ir.attachment").search(and([cond("res_id", "in", [...ids]), cond("res_model", "=", model)]));
      const rows = found.length ? (await env.cr.query<{ res_id: number; n: string }>(
        "SELECT res_id, count(*)::text AS n FROM ir_attachment WHERE id = ANY($1::int[]) GROUP BY res_id", [found])).rows : [];
      return counter(ids, rows);
    },
    // :278-296 `_compute_message_needaction` (the RIGHT JOIN with conditions on msg is an inner join)
    message_needaction_counter: async (env, ids) => counter(ids, await needaction(env, model, ids)),
    message_needaction: async (env, ids) => new Map([...counter(ids, await needaction(env, model, ids))].map(([id, n]) => [id, n > 0])),
    // :303-326 `_compute_message_has_error`
    message_has_error_counter: async (env, ids) => counter(ids, await hasError(env, model, ids)),
    message_has_error: async (env, ids) => new Map([...counter(ids, await hasError(env, model, ids))].map(([id, n]) => [id, n > 0])),
    // sms mail_thread.py:20-37
    message_has_sms_error: async (env, ids) => {
      const partner = (await userInfo(env)).partnerId;
      const rows = (await env.cr.query<{ res_id: number; n: string }>(
        `SELECT msg.res_id, COUNT(msg.res_id)::text AS n FROM mail_message msg INNER JOIN mail_notification notif ON notif.mail_message_id = msg.id
          WHERE notif.notification_type = 'sms' AND notif.notification_status = 'exception' AND notif.author_id = $1 AND msg.model = $2
            AND msg.res_id = ANY($3::int[]) AND msg.message_type != 'user_notification' GROUP BY msg.res_id`, [partner, model, ids])).rows;
      return new Map([...counter(ids, rows)].map(([id, n]) => [id, n > 0]));
    },
    // :184-196 `_compute_message_partner_ids`: the followers' partners (mail.followers in id order), only the user's
    // own and commercial partner for a non-internal user
    message_partner_ids: async (env, ids) => {
      const internal = env.su || await userHasGroup(env, "base.group_user");
      const rows = (await env.cr.query<{ res_id: number; partner_id: number }>(
        "SELECT res_id, partner_id FROM mail_followers WHERE res_model = $1 AND res_id = ANY($2::int[]) AND partner_id IS NOT NULL ORDER BY id", [model, ids])).rows;
      let allow: Set<number> | null = null;
      if (!internal) {
        const me = (await userInfo(env)).partnerId;
        const cp = (await env.cr.query<{ c: number | null }>("SELECT commercial_partner_id AS c FROM res_partner WHERE id = $1", [me])).rows[0]?.c ?? null;
        allow = new Set([me, ...(cp ? [cp] : [])]);
      }
      const out = new Map<number, unknown>();
      for (const id of ids) {
        const partners = [...new Set(rows.filter((r) => r.res_id === id).map((r) => r.partner_id))].filter((p) => allow === null || allow.has(p));
        out.set(id, await visible(env, "res.partner", partners));
      }
      return out;
    },
  };
  const missing = Object.fromEntries(Object.entries(computed).filter(([name]) => prev[name] === undefined));
  registerHooks(model, { computed: missing });
}

async function needaction(env: Environment, model: string, ids: readonly number[]): Promise<{ res_id: number; n: number }[]> {
  if (!ids.length) return [];
  const partner = (await userInfo(env)).partnerId;
  return (await env.cr.query<{ res_id: number }>(
    `SELECT msg.res_id FROM mail_message msg RIGHT JOIN mail_notification rel ON rel.mail_message_id = msg.id AND rel.res_partner_id = $1
       AND (rel.is_read = false OR rel.is_read IS NULL) WHERE msg.model = $2 AND msg.res_id = ANY($3::int[]) AND msg.message_type != 'user_notification'`,
    [partner, model, ids])).rows.map((r) => ({ res_id: r.res_id, n: 1 }));
}

async function hasError(env: Environment, model: string, ids: readonly number[]): Promise<{ res_id: number; n: string }[]> {
  if (!ids.length) return [];
  const partner = (await userInfo(env)).partnerId;
  return (await env.cr.query<{ res_id: number; n: string }>(
    `SELECT msg.res_id, COUNT(msg.res_id)::text AS n FROM mail_message msg INNER JOIN mail_notification notif ON notif.mail_message_id = msg.id
      WHERE notif.notification_status IN ('exception', 'bounce') AND notif.author_id = $1 AND msg.model = $2 AND msg.res_id = ANY($3::int[])
        AND msg.message_type != 'user_notification' GROUP BY msg.res_id`, [partner, model, ids])).rows;
}

registerThreadComputes(MODEL);
registerIsFollower(MODEL);

/** account company.py:37-41 PEPPOL_DEFAULT_COUNTRIES. */
const PEPPOL_DEFAULT_COUNTRIES = ["AT", "BE", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "IE", "IS", "LT", "LU", "LV", "MT", "NL", "NO", "SE", "SI"];

/**
 * account_edi_ubl_cii res_partner.py:261-275 `_get_ubl_cii_formats_info` through its hook (the PINT and national
 * EDI modules add their formats: l10n_sg_ubl_pint's pint_sg): account_edi_ubl_cii's dict as the hand.
 */
async function ublCiiFormatsInfo(env: Environment): Promise<Record<string, unknown>> {
  const v = await priv.res_partner._get_ubl_cii_formats_info.call(env, [], [], async () => ({
    ubl_bis3: { countries: [...PEPPOL_DEFAULT_COUNTRIES], on_peppol: true, sequence: 200, embed_attachments: true },
    xrechnung: { countries: ["DE"], sequence: 200, on_peppol: true },
    ubl_a_nz: { countries: ["NZ", "AU"], on_peppol: false },
    nlcius: { countries: ["NL"], on_peppol: true },
    ubl_sg: { countries: ["SG"], on_peppol: false },
    facturx: { countries: ["FR"], on_peppol: false },
    zugferd: { countries: ["DE"], on_peppol: false },
  }));
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new NotPorted("res.partner._get_ubl_cii_formats_info() returned something else than a dict");
  return v as Record<string, unknown>;
}

registerHooks(MODEL, {
  computed: {
    // account partner.py:1208-1227: customer invoices and credit notes of the partner and its children, as the user
    account_move_count: async (env, ids) => accountMoveCount(env, ids),
    // base res_partner.py:594-596 `_compute_get_ids`
    self: async (_env, ids) => each(ids, (id) => id),
    // :586-592 `_compute_address` (depends_context lang: the country name in the env's language)
    contact_address: async (env, ids) => displayAddresses(env, ids, false, "\n"),
    address: async (env, ids) => displayAddresses(env, ids, true, "\n"),
    contact_address_inline: async (env, ids) => displayAddresses(env, ids, false, ", "),
    address_inline: async (env, ids) => displayAddresses(env, ids, true, ", "),
    // :655-685 `_compute_email_formatted`: formataddr((name or "False", normalized)); only a plain address is ported
    // (email_normalize_all of several or formatted addresses, and an invalid one kept as is, refuse)
    email_formatted: async (env, ids) => {
      const rows = (await env.cr.query<{ id: number; name: string | null; email: string | null }>(
        "SELECT id, name, email FROM res_partner WHERE id = ANY($1::int[])", [ids])).rows;
      const out = new Map<number, unknown>();
      for (const r of rows) {
        if (!r.email) { out.set(r.id, false); continue; }
        const normalized = emailNormalize(r.email);
        if (normalized === null) throw new NotPorted("res.partner.email_formatted of an invalid email (formataddr of the raw value)");
        out.set(r.id, formatAddr(r.name || "False", normalized));
      }
      return out;
    },
    // :515-530 `_compute_main_user_id` (depends_context uid)
    main_user_id: async (env, ids) => {
      const me = await userInfo(env);
      const rows = (await env.cr.query<{ id: number; partner_id: number; share: boolean | null }>(
        "SELECT id, partner_id, share FROM res_users WHERE partner_id = ANY($1::int[]) AND active", [ids])).rows;
      const root = await xmlidToResId(env.cr, "base.partner_root");
      const rootUser = await xmlidToResId(env.cr, "base.user_root");
      return each(ids, (id) => {
        if (id === me.partnerId) return env.uid;
        // `users.sorted(lambda u: (not u.share, -u.id), reverse=True)[:1]`: internal users first, then the lowest id
        const users = rows.filter((u) => u.partner_id === id).sort((a, b) => (Number(!b.share) - Number(!a.share)) || (a.id - b.id));
        if (!users.length && id === root) return rootUser ?? null;
        return users[0]?.id ?? null;
      });
    },
    // :958-961 `_compute_is_public`: a user (archived too) in base.group_public
    is_public: async (env, ids) => {
      const group = await xmlidToResId(env.cr, "base.group_public");
      const hit = new Set(group === null ? [] : (await env.cr.query<{ partner_id: number }>(
        `SELECT DISTINCT u.partner_id FROM res_users u JOIN res_groups_users_rel r ON r.uid = u.id WHERE u.partner_id = ANY($1::int[]) AND r.gid = $2`,
        [ids, group])).rows.map((r) => r.partner_id));
      return each(ids, (id) => hit.has(id));
    },
    // account partner.py:436-439 and sale res_partner.py:93-99: nothing without the company's credit limit
    credit_to_invoice: async (env, ids) => {
      const use = (await env.cr.query<{ u: boolean | null }>("SELECT account_use_credit_limit AS u FROM res_company WHERE id = $1", [await env.company()])).rows[0]?.u;
      if (use) throw new NotPorted("res.partner.credit_to_invoice with the company's credit limit (sale res_partner.py:93)");
      return each(ids, () => 0);
    },
    // account partner.py:370-379: `list({codes of the companies' fiscal country groups})`, in the order of the Python set
    // (company.py:448-453, res_country.py:188-194: [''] without a fiscal country or without group codes)
    fiscal_country_group_codes: async (env, ids) => {
      const rows = (await env.cr.query<{ id: number; company_id: number | null }>("SELECT id, company_id FROM res_partner WHERE id = ANY($1::int[])", [ids])).rows;
      const allowed = [...await env.companies()];
      const out = new Map<number, unknown>();
      for (const r of rows) {
        const companies = r.company_id ? [r.company_id] : allowed;
        const facts = new Map((await env.cr.query<{ id: number; fc: number | null; codes: string[] | null }>(
          `SELECT co.id, co.account_fiscal_country_id AS fc, ARRAY(SELECT g.code FROM res_country_res_country_group_rel rel JOIN res_country_group g ON g.id = rel.res_country_group_id
              WHERE rel.res_country_id = co.account_fiscal_country_id AND g.code IS NOT NULL AND g.code != '' ORDER BY g.id) AS codes
             FROM res_company co WHERE co.id = ANY($1::int[])`, [companies])).rows.map((c) => [c.id, c]));
        const codes: string[] = [];
        for (const c of companies) {
          const f = facts.get(c);
          codes.push(...(f?.fc && f.codes?.length ? f.codes : [""]));
        }
        out.set(r.id, pySetOrder(codes));
      }
      return out;
    },
    // account partner.py:1203-1206 via res_partner_bank.py:70-90 (active accounts of the partner)
    duplicate_bank_partner_ids: async (env, ids) => {
      const rows = (await env.cr.query<{ partner_id: number; other: number }>(
        `SELECT this.partner_id, other.partner_id AS other FROM res_partner_bank this
           JOIN res_partner_bank other ON this.account_number = other.account_number AND this.id != other.id AND other.active = TRUE
          WHERE this.partner_id = ANY($1::int[]) AND this.active AND other.partner_id IS NOT NULL
            AND (((this.company_id = other.company_id) OR (this.company_id IS NULL AND other.company_id IS NULL)) OR other.company_id IS NULL)
          ORDER BY this.id, other.id`, [ids])).rows;
      if (rows.length) throw new NotPorted("res.partner.duplicate_bank_partner_ids with duplicated bank accounts (ARRAY_AGG order)");
      return each(ids, () => []);
    },
    // product res_partner.py:38-46 _compute_is_pricelist_manually_set
    is_pricelist_manually_set: async (env, ids) => {
      if (!ids.length) return new Map();
      const plMap = await pricelists(env, ids);
      const rows = (await env.cr.query<{ id: number; country_id: number | null }>(
        "SELECT id, country_id FROM res_partner WHERE id = ANY($1::int[])", [[...ids]])).rows;
      const countryIds = [...new Set(rows.map((r) => r.country_id).filter((c): c is number => c !== null))];
      const defaults = await countryPricelists(env, countryIds);
      const byId = new Map(rows.map((r) => [r.id, r.country_id]));
      return each(ids, (id) => {
        const cur = plMap.get(id) ?? false;
        const def = defaults.get(byId.get(id) ?? null) ?? false;
        return cur !== def;
      });
    },
    // account_edi_ubl_cii res_partner.py:143-147
    is_ubl_format: async (env, ids) => {
      const fmt = hooksOf(MODEL).computed?.["invoice_edi_format"];
      if (!fmt) throw new NotPorted("res.partner.invoice_edi_format");
      const values = await fmt(env, ids);
      // :143-147 `invoice_edi_format in self._get_ubl_cii_formats()` (:256-258: the keys of the formats info)
      const formats = Object.keys(await ublCiiFormatsInfo(env));
      return each(ids, (id) => formats.includes(String(values.get(id))));
    },
    // account_edi_ubl_cii res_partner.py:156-163
    routing_identifier: async (env, ids) => new Map((await env.cr.query<{ id: number; s: string | null; e: string | null }>(
      "SELECT id, routing_scheme AS s, routing_endpoint AS e FROM res_partner WHERE id = ANY($1::int[])", [ids])).rows
      .map((r) => [r.id, r.s && r.e ? `${r.s}:${r.e}` : false])),
    // phone_validation mail_thread_phone.py:164-171 (compute_sudo): the sanitized number among the active blacklist
    phone_sanitized_blacklisted: async (env, ids) => new Map((await env.cr.query<{ id: number; b: boolean }>(
      `SELECT p.id, EXISTS(SELECT 1 FROM phone_blacklist b WHERE b.active AND b.number = p.phone_sanitized) AS b FROM res_partner p WHERE p.id = ANY($1::int[])`,
      [ids])).rows.map((r) => [r.id, r.b])),
    // mail_thread_phone.py:51: not stored, not computed, only searchable: its value is the default (False)
    phone_mobile_search: async (_env, ids) => each(ids, () => false),
    // mail discuss/res_partner.py:25-28: `bool(partner.rtc_session_ids)` (the sessions the user may read)
    is_in_call: async (env, ids) => {
      const sessions = await env.model("discuss.channel.rtc.session").search(cond("partner_id", "in", [...ids]));
      const hit = new Set(sessions.length ? (await env.cr.query<{ partner_id: number }>(
        "SELECT partner_id FROM discuss_channel_rtc_session WHERE id = ANY($1::int[])", [sessions])).rows.map((r) => r.partner_id) : []);
      return each(ids, (id) => hit.has(id));
    },
    // mail_activity_mixin.py:102-106: the plans of the record's activities (mail.activity order: date_deadline, id)
    activity_plans_ids: async (env, ids) => {
      const acts = await activities(env, ids);
      const out = new Map<number, unknown>();
      for (const id of ids) out.set(id, await visible(env, "mail.activity.plan", acts.filter((a) => a.res_id === id && a.plan !== null).map((a) => a.plan!)));
      return out;
    },
    // calendar mail_activity_mixin.py:13-18: the calendar event of the first activity
    activity_calendar_event_id: async (env, ids) => {
      const acts = await activities(env, ids);
      return each(ids, (id) => acts.find((a) => a.res_id === id)?.event ?? null);
    },
  },
});

/** `record.activity_ids` (mail_activity_mixin.py: one2many on res_id with res_model, the activities the user may read). */
async function activities(env: Environment, ids: readonly number[]): Promise<{ res_id: number; plan: number | null; event: number | null }[]> {
  const found = await env.model("mail.activity").search(and([cond("res_model", "=", MODEL), cond("res_id", "in", [...ids])]), { order: "date_deadline ASC, id ASC" });
  if (!found.length) return [];
  const rows = (await env.cr.query<{ id: number; res_id: number; plan: number | null; event: number | null }>(
    "SELECT id, res_id, activity_plan_id AS plan, calendar_event_id AS event FROM mail_activity WHERE id = ANY($1::int[])", [found])).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  return found.map((id) => byId.get(id)!).filter(Boolean);
}
