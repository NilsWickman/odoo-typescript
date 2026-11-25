/**
 * The activity schedule wizard `mail.activity.schedule` on the write path (odoo/addons/mail/wizard/
 * mail_activity_schedule.py, phone_validation/wizard/mail_activity_schedule.py): `default_get` (:20-33), the field
 * defaults (:63 plan_on_demand_user_id), the computes (:101-318) and the `activity_category` selection of the
 * related field. Plans (plan_id set, `plan_mode`) refuse: no template data is ported.
 */
import { NotPorted } from "../errors";
import { and, cond, or } from "../orm/domain";
import { userInfo } from "../orm/env";
import { registerHooks } from "../orm/hooks";
import { DbRec, registerDefaults, registerOnchange, registerRecordCompute, type Rec, type RecordCompute } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { registerOverrides } from "../orm/write";
import { phoneGetFormatted, recipientNumber } from "./phone_recipients";
import { dbNow, todayInTz, validTz } from "./util";

const MODEL = "mail.activity.schedule";

async function contextToday(env: Environment): Promise<string> {
  return todayInTz(await dbNow(env), validTz(env.context.tz) ?? validTz((await userInfo(env)).tz) ?? "UTC");
}

/** mail/tools/parser.py:10 parse_res_ids for the shapes the web client sends (a list, or its Python repr). */
export function parseResIds(v: unknown): number[] {
  if (!v) return [];
  if (Array.isArray(v) && v.every((x) => Number.isInteger(x))) return v.map(Number);
  if (typeof v === "string") {
    const m = /^\s*[[(]\s*((?:-?\d+\s*,\s*)*-?\d*)\s*,?\s*[\])]\s*$/.exec(v);
    if (m !== null) return (m[1] ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "").map(Number);
  }
  throw new NotPorted(`res_ids ${JSON.stringify(v)} (parse_res_ids ValidationError)`);
}

/** Python `f"{context['active_ids']}"`: the repr of a list of ints. */
function pyListRepr(v: unknown): string {
  if (!Array.isArray(v) || !v.every((x) => Number.isInteger(x))) throw new NotPorted("active_ids repr of non-int values");
  return `[${v.join(", ")}]`;
}

interface TypeRow {
  id: number; name: string | null; summary: string | null; default_note: string | null; default_user_id: number | null;
  default_role_id: number | null; delay_count: number | null; delay_unit: string | null; delay_from: string | null;
  res_model: string | null; category: string | null;
}

async function activityType(env: Environment, rec: Rec): Promise<TypeRow | null> {
  const id = await rec.get("activity_type_id");
  if (typeof id !== "number") return null;
  const lang = env.lang ?? "en_US";
  return (await env.cr.query<TypeRow>(
    `SELECT id, COALESCE(name->>$2, name->>'en_US') AS name, COALESCE(summary->>$2, summary->>'en_US') AS summary,
       COALESCE(default_note->>$2, default_note->>'en_US') AS default_note, default_user_id, default_role_id, delay_count,
       delay_unit, delay_from, res_model, category
     FROM mail_activity_type WHERE id = $1`, [id, lang])).rows[0] ?? null;
}

/** mail_activity_type.py:153-160 `_get_date_deadline`: today (or activity_previous_deadline) + the delay. */
export async function activityTypeDeadline(env: Environment, t: Pick<TypeRow, "delay_count" | "delay_unit" | "delay_from">): Promise<string> {
  const prev = env.context["activity_previous_deadline"];
  const base = t.delay_from === "previous_activity" && typeof prev === "string" && prev ? prev.slice(0, 10) : await contextToday(env);
  const [y, m, d] = base.split("-").map(Number) as [number, number, number];
  const n = t.delay_count ?? 0;
  const date = new Date(Date.UTC(y, m - 1, d));
  switch (t.delay_unit) {
    case "days": date.setUTCDate(date.getUTCDate() + n); break;
    case "weeks": date.setUTCDate(date.getUTCDate() + 7 * n); break;
    case "months": {
      // relativedelta(months=n): clamp the day to the target month's length
      const target = new Date(Date.UTC(y, m - 1 + n, 1));
      const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
      return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
    }
    default: throw new NotPorted(`activity delay unit ${String(t.delay_unit)}`);
  }
  return date.toISOString().slice(0, 10);
}

async function resIds(rec: Rec): Promise<number[]> {
  return parseResIds(await rec.get("res_ids"));
}

/** `_get_applied_on_records` (:484-487): the records, or null without res_model. */
async function appliedOn(rec: Rec): Promise<{ model: string; ids: number[] } | null> {
  const model = await rec.get("res_model");
  if (typeof model !== "string" || !model) return null;
  return { model, ids: await resIds(rec) };
}

const computes: Record<string, RecordCompute> = {
  // :101-105
  res_model_id: async (env, rec) => {
    const model = await rec.get("res_model");
    if (typeof model !== "string" || !model) return false;
    return (await env.cr.query<{ id: number }>("SELECT id FROM ir_model WHERE model = $1", [model])).rows[0]?.id ?? false;
  },
  // :107-115 (only when empty)
  res_ids: async (env, rec) => {
    const cur = await rec.prev("res_ids");
    if (cur) return cur;
    const active = env.context["active_ids"];
    const parsed = parseResIds(active);
    if (parsed.length > 0 && parsed.length <= 500) return pyListRepr(active);
    if (parsed.length === 0 && env.context["active_id"]) return pyListRepr([env.context["active_id"]]);
    return cur || false;
  },
  // :117-123
  company_id: async (env, rec) => {
    const on = await appliedOn(rec);
    if (on === null) return false;
    const def = env.reg.model(on.model);
    if (on.ids.length > 0 && def.fields.has("company_id")) {
      const c = (await env.model(on.model).read([on.ids[0]!], ["company_id"], ""))[0]?.["company_id"];
      if (typeof c === "number") return c;
    }
    return env.company();
  },
  // :125-169 (activity-based: no plan)
  // Html values in the cache form (fields.py Html.convert_to_cache: False -> None), so an onchange snapshot of the
  // client's `false` (src/web/onchange.ts) compares equal and the unchanged field is not returned
  error: async (env, rec) => (await errors(env, rec)).error,
  has_error: async (env, rec) => (await errors(env, rec)).error !== null,
  warning: async () => null,
  has_warning: async () => false,
  // :172-175
  is_batch_mode: async (_env, rec) => (await resIds(rec)).length > 1,
  // :177-181 (compute_sudo)
  plan_available_ids: async (env, rec) => {
    const company = await rec.get("company_id");
    const model = await rec.get("res_model");
    return env.model("mail.activity.plan").search(and([
      or([cond("company_id", "=", false), cond("company_id", "=", typeof company === "number" ? company : false)]),
      or([cond("res_model", "=", false), cond("res_model", "=", typeof model === "string" && model ? model : false)]),
      cond("template_ids", "!=", false),
    ]));
  },
  // :183-191
  plan_id: async (env) => {
    if (env.context["plan_mode"]) throw new NotPorted("activity plans (plan_mode)");
    return false;
  },
  // :199-201
  plan_date: async (env) => contextToday(env),
  // :203-245: no plan, no lines
  plan_schedule_line_ids: async (_env, rec) => {
    if (await rec.get("plan_id")) throw new NotPorted("activity plan schedule lines");
    return [];
  },
  // :250-255 (compute_sudo)
  activity_type_available_ids: async (env, rec) => {
    const model = await rec.get("res_model");
    return env.model("mail.activity.type").search(or([cond("res_model", "=", false), cond("res_model", "=", typeof model === "string" && model ? model : false)]));
  },
  // :257-263, mail_activity.py:51-56 _default_activity_type_for_model
  activity_type_id: async (env, rec) => {
    const cur = await rec.prev("activity_type_id");
    const model = await rec.get("res_model");
    if (typeof cur === "number") {
      const t = (await env.cr.query<{ res_model: string | null }>("SELECT res_model FROM mail_activity_type WHERE id = $1", [cur])).rows[0];
      if (!(t?.res_model && typeof model === "string" && model && t.res_model !== model)) return cur;
    }
    const domain = typeof model === "string" && model
      ? or([cond("res_model", "=", model), cond("res_model", "=", false)]) : cond("res_model", "=", false);
    return (await env.model("mail.activity.type").search(domain, { limit: 1 }))[0] ?? false;
  },
  // :271-277
  date_deadline: async (env, rec) => {
    const t = await activityType(env, rec);
    if (t?.delay_count) return activityTypeDeadline(env, t);
    return (await rec.prev("date_deadline")) || contextToday(env);
  },
  // :279-285
  summary: async (env, rec) => {
    const t = await activityType(env, rec);
    if (t?.summary) return t.summary;
    return (await rec.prev("summary")) || (t?.name ?? false);
  },
  // :287-294 with phone_validation's _get_phone_number (only single phone call records)
  phone: async (env, rec) => {
    const on = await appliedOn(rec);
    const t = await activityType(env, rec);
    if (t?.category !== "phonecall" || on === null || on.ids.length !== 1) return false;
    // phone_validation's _get_phone_number (:21-27): record.exists(), check_access('read') (the read below, as the
    // user: compute_sudo=False), then _phone_get_recipients_info()[id]["number"]
    const id = on.ids[0]!;
    if (!env.reg.models.has(on.model)) return false;
    const table = env.reg.model(on.model).table;
    if (!(await env.cr.query(`SELECT 1 FROM "${table}" WHERE id = $1`, [id])).rows.length) return false;
    return recipientNumber(env, on.model, id);
  },
  // phone_validation/wizard/mail_activity_schedule.py:11-19
  phone_formatted: async (env, rec) => {
    const phone = await rec.get("phone");
    const on = await appliedOn(rec);
    if (phone && on !== null && on.ids.length === 1) return phoneGetFormatted(env, on.model, on.ids[0]!, phone as string);
    return phone || false;
  },
  // :296-299
  note: async (env, rec) => {
    const t = await activityType(env, rec);
    return t?.default_note ? t.default_note : await rec.prev("note");
  },
  // :301-307
  activity_user_id: async (env, rec) => {
    const t = await activityType(env, rec);
    if (t?.default_user_id || t?.default_role_id) return t.default_user_id ?? false;
    const cur = await rec.prev("activity_user_id");
    if (!cur && !(await rec.prev("activity_role_id"))) return env.uid;
    return cur;
  },
  // :309-313
  activity_role_id: async (env, rec) => {
    const t = await activityType(env, rec);
    if (t?.default_user_id || t?.default_role_id) return t.default_role_id ?? false;
    return rec.prev("activity_role_id");
  },
};

async function errors(env: Environment, rec: Rec): Promise<{ error: string | null }> {
  if (await rec.get("plan_id")) throw new NotPorted("activity plan errors (_check_plan_templates_error)");
  const list: string[] = [];
  const on = await appliedOn(rec);
  if (on !== null && on.ids.length > 1 && env.reg.model(on.model).fields.has("company_id")) {
    const rows = await env.model(on.model).read(on.ids, ["company_id"], "");
    if (new Set(rows.map((r) => r["company_id"]).filter((c) => c)).size > 1) list.push("The records must belong to the same company.");
  }
  if (!(await rec.get("res_ids")) && !(await rec.get("activity_user_id"))) list.push("Can't schedule activities without either a record or a user.");
  if (list.length === 0) return { error: null };
  if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated activity schedule errors (${env.lang})`);
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#39;").replace(/"/g, "&quot;");
  return { error: `The activity cannot be launched:<ul>${list.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` };
}

registerRecordCompute(MODEL, computes);

// the same bodies for reads of saved wizards (web_save's web_read): non-stored fields go through hooks.computed
const NON_STORED = ["company_id", "error", "has_error", "warning", "has_warning", "is_batch_mode", "plan_schedule_line_ids",
  "activity_type_available_ids", "phone_formatted"];
registerHooks(MODEL, {
  computed: Object.fromEntries(NON_STORED.map((name) => [name, async (env: Environment, ids: readonly number[]) => {
    const def = env.reg.model(MODEL);
    const out = new Map<number, unknown>();
    for (const id of ids) out.set(id, await computes[name]!(env, new DbRec(env, def, id)));
    return out;
  }])),
  // the related `activity_category` (:79) has mail.activity.type.category's selection (mail_activity_type.py)
  selection: {
    activity_category: async (env) => (env.reg.model("mail.activity.type").fields.get("category")?.selection ?? [])
      .map((s) => [s.value, s.labels[env.lang ?? "en_US"] ?? s.label] as [string, string]),
  },
});

registerDefaults(MODEL, {
  plan_on_demand_user_id: async (env) => env.uid, // :63
});

registerOverrides(MODEL, {
  // :20-33
  defaultGet: async (env, fields, values) => {
    const ctx = env.context;
    const active = parseResIds(ctx["active_ids"]);
    if (fields.includes("res_ids")) {
      if (active.length > 0 && active.length <= 500) values["res_ids"] = pyListRepr(ctx["active_ids"]);
      else if (active.length === 0 && ctx["active_id"]) values["res_ids"] = pyListRepr([ctx["active_id"]]);
    }
    const params = ctx["params"];
    const resModel = ctx["active_model"] || (typeof params === "object" && params !== null ? (params as Record<string, unknown>)["active_model"] : false) || false;
    if (fields.includes("res_model")) values["res_model"] = resModel;
  },
});

// The @api.onchange methods (models.py:594 getmembers order): mail_activity_schedule.py:265, :510, :193.
registerOnchange(MODEL, "_onchange_activity_type_id", ["activity_type_id"], async (_env, rec) => {
  if (await rec.get("activity_type_id")) await rec.set("plan_id", null); // "Reset UX"
});
registerOnchange(MODEL, "_onchange_activity_user_id", ["activity_user_id", "activity_type_id"], async (_env, rec) => {
  if ((await rec.get("activity_category")) !== "upload_file") return;
  // :514-526: the user must be able to post on the records (`_mail_get_operation_for_mail_message_operation`)
  if (await rec.get("res_model") && await rec.get("activity_user_id")) throw new NotPorted("mail.activity.schedule upload_file access check of the assigned user");
});
registerOnchange(MODEL, "_onchange_plan_id", ["plan_id"], async (_env, rec) => {
  if (await rec.get("plan_id")) await rec.set("activity_type_id", null); // "Reset UX"
});
