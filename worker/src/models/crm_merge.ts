/**
 * Merging leads and opportunities: the wizard crm.merge.opportunity (crm/wizard/crm_merge_opportunities.py) and
 * crm.lead `merge_opportunity` / `_merge_opportunity` (crm/models/crm_lead.py:1455-1760). The head (the most
 * confident lead) takes the merged values, the summary of the others is posted on it (crm.crm_lead_merge_summary),
 * their messages and recent followers move to it, and they are deleted.
 * Moving activities, attachments and meetings, and leads with properties, refuse.
 */
import { NotPorted, UserError } from "../errors";
import { envFor } from "../web/common";
import { registerMethod } from "../http/methods";
import { and, cond, or } from "../orm/domain";
import { DbRec, registerDefaults, registerRecordCompute, type Rec } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { unlink } from "../orm/unlink";
import { write } from "../orm/write";
import { isHtmlEmpty } from "../qweb/helpers";
import { PyEnv, PyRecords, registerPyMethod } from "../qweb/records";
import { sanitizeBody } from "../mail/sanitize";
import { postNote } from "./stock_engine";
import { updateRow } from "./account_entries";
import { translate } from "./util";
import { xmlid } from "../mail/message";

const MODEL = "crm.lead";

/** crm_lead.py:26-58 CRM_LEAD_FIELDS_TO_MERGE. */
const FIELDS_TO_MERGE = ["campaign_id", "medium_id", "source_id", "name", "user_id", "color", "company_id", "lang_id", "team_id", "referred", "stage_id",
  "expected_revenue", "recurring_plan", "recurring_revenue", "create_date", "date_automation_last", "date_deadline", "partner_id", "title", "partner_name",
  "contact_name", "email_from", "function", "phone", "website"];
/** crm_lead.py:69-76 PARTNER_ADDRESS_FIELDS_TO_SYNC. */
const ADDRESS_FIELDS = ["street", "street2", "city", "zip", "state_id", "country_id"];
/** `_merge_get_fields_specific` (crm_lead.py:1590-1599, sale_crm crm_lead.py:98-102 `order_ids`, crm_iap_enrich
 * crm_lead.py:209-213 `iap_enrich_done`) and the fields iap_crm (crm_lead.py:12-13 `reveal_id`) and crm_iap_mine
 * (crm_lead.py:12-13 `lead_mining_request_id`) add to `_merge_get_fields`; a module not installed has no field. */
const SPECIFIC = ["description", "type", "priority", "tag_ids", "lost_reason_id", "order_ids", "iap_enrich_done"];
const EXTRA = ["reveal_id", "lead_mining_request_id"];

const idsOf = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number) : typeof v === "number" && v ? [v] : []);
const truthy = (v: unknown): boolean => !(v === false || v === null || v === undefined || v === 0 || v === "" || (Array.isArray(v) && !v.length));

// ------------------------------------------------------------------------------------------------ the wizard

// crm_merge_opportunities.py:20-33 default_get: the active leads that are not won
registerDefaults("crm.merge.opportunity", {
  opportunity_ids: async (env) => {
    const active = env.context["active_ids"];
    if (!Array.isArray(active) || !active.length) return undefined;
    const rows = (await env.cr.query<{ id: number; w: string | null }>("SELECT id, won_status AS w FROM crm_lead WHERE id = ANY($1::int[])", [active.map(Number)])).rows;
    const won = new Map(rows.map((r) => [r.id, r.w]));
    return [[6, 0, active.map(Number).filter((id) => won.has(id) && won.get(id) !== "won")]];
  },
});

registerRecordCompute("crm.merge.opportunity", {
  // :60-63 `_compute_user_id`: the salesperson when all the leads have the same one
  user_id: async (env, rec) => {
    const leads = idsOf(await rec.get("opportunity_ids"));
    const users = leads.length ? (await env.cr.query<{ u: number }>(
      "SELECT DISTINCT user_id AS u FROM crm_lead WHERE id = ANY($1::int[]) AND user_id IS NOT NULL", [leads])).rows.map((r) => r.u) : [];
    return users.length === 1 ? users[0]! : null;
  },
  // :46-57 `_compute_team_id`: a team the salesperson leads or belongs to
  team_id: async (env, rec) => {
    const user = idsOf(await rec.get("user_id"))[0];
    const current = await rec.prev("team_id");
    if (!user) return current;
    const team = idsOf(current)[0];
    let inTeam = false;
    if (team) inTeam = (await env.model("crm.team").search(and([cond("id", "=", team), or([cond("user_id", "=", user), cond("member_ids", "=", user)])]))).length > 0;
    if (inTeam) return current;
    const found = await env.model("crm.team").search(or([cond("user_id", "=", user), cond("member_ids", "=", user)]), { limit: 1 });
    return found[0] ?? null;
  },
});

// :65-90 action_merge
registerMethod("crm.merge.opportunity", "action_merge", async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  if (ids?.length !== 1) throw new Error("ValueError: Expected singleton: crm.merge.opportunity");
  const wizard = new DbRec(env, env.reg.model("crm.merge.opportunity"), ids[0]!);
  const leads = idsOf(await wizard.get("opportunity_ids"));
  const merged = await mergeOpportunity(env, leads, idsOf(await wizard.get("user_id"))[0] ?? false, idsOf(await wizard.get("team_id"))[0] ?? false);
  const ok = merged !== null;
  return {
    type: "ir.actions.client", tag: "display_notification",
    params: {
      message: ok ? translate(env, "Leads merged", "crm") : translate(env, "Something went wrong, please try again later", "crm"),
      type: ok ? "success" : "warning", sticky: false, next: { type: "ir.actions.act_window_close" },
    },
  };
}, { apiModel: false });

// crm_lead.py:1505-1519 merge_opportunity: the head's id
registerMethod(MODEL, "merge_opportunity", async (env0, ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const userId = (args[0] ?? kwargs["user_id"] ?? false) as number | false;
  const teamId = (args[1] ?? kwargs["team_id"] ?? false) as number | false;
  if ((args[2] ?? kwargs["auto_unlink"] ?? true) !== true) throw new NotPorted("merge_opportunity without auto_unlink");
  return mergeOpportunity(env, ids ?? [], userId, teamId);
}, { apiModel: false });

// crm_lead.py:1747-1790 `_format_properties` of a lead without properties (the merge summary)
registerPyMethod(MODEL, "_format_properties", async (recs) => {
  const id = recs.ensureOne();
  const p = (await recs.env.cr.query<{ p: unknown }>("SELECT lead_properties AS p FROM crm_lead WHERE id = $1", [id])).rows[0]?.p;
  if (p && typeof p === "object" && Object.keys(p as object).length) throw new NotPorted("crm.lead._format_properties of a lead with properties");
  return [];
});

// ------------------------------------------------------------------------------------------------ the merge

interface Lead { id: number; rec: Rec; values: Map<string, unknown> }

/** crm_lead.py:1521-1575 `_merge_opportunity(user_id, team_id, auto_unlink=True, max_length=5)`. */
async function mergeOpportunity(env: Environment, ids: readonly number[], userId: number | false, teamId: number | false): Promise<number> {
  if (ids.length <= 1) throw new UserError(translate(env, "Select at least two Leads/Opportunities from the list to merge them.", "crm"));
  if (ids.length > 5 && !env.su) throw new UserError(translate(env, "To prevent data loss, Leads and Opportunities can only be merged by groups of %(max_length)s.", "crm").replace("%(max_length)s", "5"));
  if (env.lang && env.lang !== "en_US") throw new NotPorted(`crm.lead merge in ${env.lang} (the summary's translations)`);
  const def = env.reg.model(MODEL);
  const fields = [...FIELDS_TO_MERGE, ...SPECIFIC, ...ADDRESS_FIELDS, ...EXTRA].filter((f) => def.fields.has(f));
  const leads: Lead[] = [];
  for (const id of ids) {
    const rec = new DbRec(env, def, id);
    const values = new Map<string, unknown>();
    for (const f of [...fields, "active", "probability"]) values.set(f, await rec.get(f));
    leads.push({ id, rec, values });
  }
  // :1923-1946 `_sort_by_confidence_level(reverse=True)`
  const stageSeq = new Map<number, number>();
  for (const l of leads) {
    const s = idsOf(l.values.get("stage_id"))[0];
    if (s && !stageSeq.has(s)) stageSeq.set(s, Number((await env.cr.query<{ q: number }>("SELECT sequence AS q FROM crm_stage WHERE id = $1", [s])).rows[0]?.q ?? 0));
  }
  const key = (l: Lead): number[] => {
    const opp = l.values.get("type") === "opportunity";
    const s = idsOf(l.values.get("stage_id"))[0];
    return [opp || Boolean(l.values.get("active")) ? 1 : 0, opp ? 1 : 0, s ? stageSeq.get(s) ?? 0 : 0, Number(l.values.get("probability") ?? 0), -l.id];
  };
  const cmp = (a: Lead, b: Lead): number => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! < kb[i]! ? -1 : 1;
    return 0;
  };
  // sorted(reverse=True) is stable: equal keys keep their order
  const sorted = [...leads].sort((a, b) => -cmp(a, b));
  const head = sorted[0]!, tail = sorted.slice(1);
  const data = await mergeData(env, sorted, fields);
  if (userId) data.set("user_id", userId);
  if (teamId) data.set("team_id", teamId);
  const mergedFollowers = await mergeFollowers(env, head.id, tail.map((l) => l.id));
  await logSummary(env, head.id, tail.map((l) => l.id), mergedFollowers);
  await mergeDependences(env, head.id, tail);
  // :1557-1561 the stage must be one of the team's
  const team = idsOf(data.get("team_id"))[0];
  if (team) {
    const stages = await env.model("crm.stage").search(or([cond("team_ids", "in", [team]), cond("team_ids", "=", false)]), { order: "sequence, id" });
    if (!stages.includes(idsOf(data.get("stage_id"))[0] ?? -1)) data.set("stage_id", stages[0] ?? false);
  }
  // :1563-1568 the salesperson and team already set are not written
  if (data.has("user_id") && (idsOf(head.values.get("user_id"))[0] ?? false) === (idsOf(data.get("user_id"))[0] ?? false)) data.delete("user_id");
  if (data.has("team_id") && (idsOf(head.values.get("team_id"))[0] ?? false) === (idsOf(data.get("team_id"))[0] ?? false)) data.delete("team_id");
  // models.py:3857-3864 write drops the log access columns (create_date)
  data.delete("create_date");
  await write(env, MODEL, [head.id], Object.fromEntries(data));
  // :1571-1573 the others, as superuser
  await unlink(env.sudo(), MODEL, tail.map((l) => l.id));
  return head.id;
}

/** crm_lead.py:1460-1503 `_merge_data(fnames)` over the leads in their merge order. */
async function mergeData(env: Environment, leads: readonly Lead[], fields: readonly string[]): Promise<Map<string, unknown>> {
  const def = env.reg.model(MODEL);
  const out = new Map<string, unknown>();
  // :1577-1588 `_merge_get_fields_address`: the lead with the most address fields set (the first of them, `max`)
  let source = leads[0]!, best = -1;
  for (const l of leads) {
    const n = ADDRESS_FIELDS.filter((f) => def.fields.has(f) && truthy(l.values.get(f))).length;
    if (n > best) { best = n; source = l; }
  }
  for (const f of fields) {
    const field = def.fields.get(f)!;
    const values = leads.map((l) => l.values.get(f));
    if (f === "description") {
      // :1592 '<br/><br/>'.join of the non-empty descriptions
      out.set(f, values.filter((v) => !isHtmlEmpty(v)).map(String).join("<br/><br/>"));
    } else if (f === "type") {
      out.set(f, values.some((v) => v === "opportunity") ? "opportunity" : "lead");
    } else if (f === "priority") {
      const ps = values.filter(truthy).map(String);
      out.set(f, ps.length ? ps.reduce((a, b) => (b > a ? b : a)) : false);
    } else if (f === "tag_ids") {
      const tags: number[] = [];
      for (const v of values) for (const t of idsOf(v)) if (!tags.includes(t)) tags.push(t);
      out.set(f, [[6, 0, tags]]);
    } else if (f === "order_ids") {
      // [(4, order.id) for order in leads.order_ids]: the orders move to the head
      const orders: number[] = [];
      for (const v of values) for (const o of idsOf(v)) if (!orders.includes(o)) orders.push(o);
      if (orders.length) throw new NotPorted("crm.lead merge of opportunities with quotations (order_ids)");
      // no order: an empty command list, which changes nothing (not written)
    } else if (f === "iap_enrich_done") {
      out.set(f, values.some((v) => Boolean(v)));
    } else if (f === "lost_reason_id") {
      // :1596-1598 none when the head has a probability, else the first lost reason
      if (Number(leads[0]!.values.get("probability") ?? 0)) out.set(f, false);
      else out.set(f, idsOf(values.find((v) => idsOf(v).length))[0] ?? false);
    } else if (ADDRESS_FIELDS.includes(f)) {
      const v = source.values.get(f);
      out.set(f, field.type === "many2one" ? idsOf(v)[0] ?? false : v ?? false);
    } else if (field.type === "many2many" || field.type === "one2many") {
      continue;
    } else {
      // :1482-1489 the first value set
      const v = values.find(truthy);
      out.set(f, v === undefined ? false : field.type === "many2one" ? idsOf(v)[0] ?? false : v);
    }
  }
  return out;
}

/** crm_lead.py:1688-1730 `_merge_followers`: the followers who posted on the others in the last 30 days. */
async function mergeFollowers(env: Environment, head: number, others: readonly number[]): Promise<Map<number, number[]>> {
  const rows = (await env.cr.query<{ id: number }>(
    `SELECT MAX(mf.id) AS id
       FROM mail_followers AS mf
       JOIN mail_message AS mm ON mm.author_id = mf.partner_id AND mm.res_id = mf.res_id AND mm.model = 'crm.lead' AND mm.date > NOW() - INTERVAL '30 DAY'
  LEFT JOIN mail_followers AS destf ON destf.res_model = 'crm.lead' AND destf.res_id = $2 AND destf.partner_id = mf.partner_id
      WHERE mf.res_model = 'crm.lead' AND mf.res_id = ANY($1::int[]) AND destf IS NULL
   GROUP BY mf.partner_id`, [[...others], head])).rows.map((r) => r.id);
  if (!rows.length) return new Map();
  // moving them (`followers_to_update.write({"res_id": ...})`) and listing them in the summary are not ported
  throw new NotPorted("crm.lead merge moving followers who wrote on the merged leads (_merge_followers)");
}

/** crm_lead.py:1732-1744 `_merge_log_summary`: crm.crm_lead_merge_summary posted as a note on the head. */
async function logSummary(env: Environment, head: number, others: readonly number[], mergedFollowers: ReadonlyMap<number, number[]>): Promise<void> {
  if (mergedFollowers.size) throw new NotPorted("crm.lead merge summary with merged followers");
  // mail_thread.py:2724 message_post_with_source -> `_message_compose_with_view`: ir.qweb rendering with `object`
  const { renderQweb } = await import("../controllers/report");
  const rendered = await renderQweb(env, "crm.crm_lead_merge_summary", {
    object: new PyRecords(env, MODEL, [head]), opportunities: new PyRecords(env, MODEL, [...others]), merged_followers: new Map(),
    is_html_empty: (v: unknown) => isHtmlEmpty(v), env: new PyEnv(env),
  });
  const note = await xmlid(env, "mail.mt_note");
  const notified = (await env.cr.query(
    `SELECT 1 FROM mail_followers f JOIN mail_followers_mail_message_subtype_rel r ON r.mail_followers_id = f.id JOIN res_partner p ON p.id = f.partner_id
      WHERE f.res_model = 'crm.lead' AND f.res_id = $1 AND r.mail_message_subtype_id = $2 LIMIT 1`, [head, note])).rows.length;
  if (notified) throw new NotPorted("crm.lead merge summary with followers of internal notes to notify");
  await postNote(env, MODEL, head, sanitizeBody(rendered.trim()));
}

/** crm_lead.py:1608-1686 `_merge_dependences`: the others' messages move to the head ("From <name>"). */
async function mergeDependences(env: Environment, head: number, tail: readonly Lead[]): Promise<void> {
  const ids = tail.map((l) => l.id);
  if ((await env.cr.query("SELECT 1 FROM mail_activity WHERE res_model = 'crm.lead' AND res_id = ANY($1::int[]) LIMIT 1", [ids])).rows.length) {
    throw new NotPorted("crm.lead merge of leads with activities (_merge_dependences_history)");
  }
  if ((await env.cr.query("SELECT 1 FROM ir_attachment WHERE res_model = 'crm.lead' AND res_id = ANY($1::int[]) LIMIT 1", [ids])).rows.length) {
    throw new NotPorted("crm.lead merge of leads with attachments (_merge_dependences_attachments)");
  }
  if ((await env.cr.query("SELECT 1 FROM calendar_event WHERE opportunity_id = ANY($1::int[]) LIMIT 1", [ids])).rows.length) {
    throw new NotPorted("crm.lead merge of leads with meetings (_merge_dependences_calendar_events)");
  }
  const su = env.sudo();
  for (const l of tail) {
    const name = String(l.values.get("name") ?? "");
    // `opportunity_su.message_ids` (mail.message `_order` 'id desc')
    const messages = (await su.cr.query<{ id: number; subject: string | null }>(
      "SELECT id, subject FROM mail_message WHERE model = 'crm.lead' AND res_id = $1 ORDER BY id DESC", [l.id])).rows;
    for (const m of messages) {
      const subject = m.subject
        ? translate(env, "From %(source_name)s: %(source_subject)s", "crm").replace("%(source_name)s", () => name).replace("%(source_subject)s", () => m.subject!)
        : translate(env, "From %(source_name)s", "crm").replace("%(source_name)s", () => name);
      await updateRow(su, "mail_message", m.id, { res_id: head, subject });
    }
  }
}
