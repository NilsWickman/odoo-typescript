/**
 * mail.activity.mixin computes for any model (odoo/addons/mail/models/mail_activity_mixin.py:134-230) and the
 * calendar override (odoo/addons/calendar/models/mail_activity_mixin.py:13-19), registered per model by
 * `registerActivityMixin`. `record.activity_ids` is the active activities of the record (`res_model` filter,
 * fields_relational.py:971; active_test), ordered by mail.activity `_order = 'date_deadline ASC, id ASC'`
 * (mail_activity.py:32). The per-activity state is `_compute_state_from_date` (mail_activity.py:225-237) in the
 * activity's `user_tz`, else the context/user tz. `activity_state` also has `compute_sql`
 * (`_compute_sql_activity_state`, mail_activity_mixin.py:178-213) for grouping and progress bars.
 */
import { NotPorted } from "../errors";
import { and, cond, FALSE, or } from "../orm/domain";
import { envCache, userInfo } from "../orm/env";
import { hooksOf, registerHooks } from "../orm/hooks";
import { NewRec, registerRecordCompute, type RecordCompute } from "../orm/recompute";
import { ident, sql, type Sql, type Table } from "../orm/sql";
import type { Domain, Environment } from "../orm/types";
import { dbNow, todayInTz, validTz } from "./util";

interface Activity {
  id: number; res_id: number; date_deadline: string | null; user_id: number | null; user_tz: string | null;
  decoration_type: string | null; icon: string | null; calendar_event_id: number | null; activity_type_id: number | null;
}

function activities(env: Environment, model: string, ids: readonly number[]): Promise<Activity[]> {
  const active = env.context["active_test"] !== false;
  return envCache(env, `activity_mixin:${model}:${JSON.stringify([ids, active])}`, async () =>
    (await env.cr.query<Activity>(
      `SELECT a.id, a.res_id, a.date_deadline::text AS date_deadline, a.user_id, a.user_tz, t.decoration_type, t.icon,
         a.calendar_event_id, a.activity_type_id
       FROM mail_activity a LEFT JOIN mail_activity_type t ON t.id = a.activity_type_id
       WHERE a.res_model = $1 AND a.res_id = ANY($2::int[]) AND ($3 = false OR a.active)
       ORDER BY a.date_deadline, a.id`, [model, ids, active])).rows);
}

function first<T>(rows: Activity[], ids: readonly number[], pick: (a: Activity) => T | null): Map<number, unknown> {
  const out = new Map<number, unknown>(ids.map((id) => [id, false]));
  const seen = new Set<number>();
  for (const a of rows) {
    if (seen.has(a.res_id)) continue;
    seen.add(a.res_id);
    out.set(a.res_id, pick(a) ?? false);
  }
  return out;
}

export function registerActivityMixin(model: string): void {
  registerHooks(model, {
    computed: {
      // mail_activity_mixin.py:162-173
      activity_state: async (env, ids) => {
        const rows = await activities(env, model, ids);
        const now = await dbNow(env);
        const user = await userInfo(env);
        const fallbackTz = validTz(env.context.tz) ?? validTz(user.tz) ?? "UTC";
        const states = new Map<number, Set<string>>();
        for (const a of rows) {
          if (a.date_deadline === null) continue;
          const today = todayInTz(now, validTz(a.user_tz) ?? fallbackTz);
          const s = a.date_deadline < today ? "overdue" : a.date_deadline === today ? "today" : "planned";
          const set = states.get(a.res_id) ?? new Set<string>();
          set.add(s);
          states.set(a.res_id, set);
        }
        return new Map(ids.map((id) => {
          const s = states.get(id);
          return [id, s?.has("overdue") ? "overdue" : s?.has("today") ? "today" : s?.has("planned") ? "planned" : false];
        }));
      },
      // :147-150
      activity_user_id: async (env, ids) => first(await activities(env, model, ids), ids, (a) => a.user_id),
      // :215-219
      activity_date_deadline: async (env, ids) => first(await activities(env, model, ids), ids, (a) => a.date_deadline),
      // :278-284 _compute_my_activity_date_deadline: the first activity of the current user
      my_activity_date_deadline: async (env, ids) =>
        first((await activities(env, model, ids)).filter((a) => a.user_id === env.uid), ids, (a) => a.date_deadline),
      // :134-145: the first 'danger' type, else the last 'warning' type, over the distinct activity types in order
      activity_exception_decoration: async (env, ids) => exception(await activities(env, model, ids), ids, "decoration_type"),
      activity_exception_icon: async (env, ids) => exception(await activities(env, model, ids), ids, "icon"),
      // calendar/models/mail_activity_mixin.py:13-19
      activity_calendar_event_id: async (env, ids) => first(await activities(env, model, ids), ids, (a) => a.calendar_event_id),
    },
    search: {
      // mail_activity_mixin.py:226-243 _search_activity_user_id (booleans test the existence of activities)
      activity_user_id: async (_env, operator, operand) => {
        if (negative(operator)) throw new NotPorted(`activity_user_id ${operator} (NotImplemented)`);
        let domain: Domain = FALSE;
        let value = operand;
        if (operator === "in" && Array.isArray(operand)) {
          const bools = operand.filter((v) => typeof v === "boolean");
          const values = operand.filter((v) => typeof v !== "boolean");
          if (bools.length) {
            if (bools.includes(true)) domain = or([domain, cond("activity_ids", "!=", false)]);
            if (bools.includes(false)) domain = or([domain, cond("activity_ids", "=", false)]);
            if (!values.length) return domain;
            value = values;
          }
        }
        return or([domain, cond("activity_ids", "any", and([cond("active", "in", [true, false]), cond("user_id", operator, value)]))]);
      },
      // :245-252 _search_activity_type_id, :254-261 _search_activity_summary
      activity_type_id: async (_env, operator, operand) => relatedSearch("activity_ids.activity_type_id", operator, operand),
      activity_summary: async (_env, operator, operand) => relatedSearch("activity_ids.summary", operator, operand),
      // :273-284 _search_my_activity_date_deadline
      my_activity_date_deadline: async (env, operator, operand) => {
        if (negative(operator)) throw new NotPorted(`my_activity_date_deadline ${operator} (NotImplemented)`);
        const domain = cond("activity_ids", "any", and([cond("active", "=", true), cond("date_deadline", operator, operand),
          cond("res_model", "=", model), cond("user_id", "=", env.uid)]));
        if (operator === "in" && Array.isArray(operand) && operand.includes(false)) return or([domain, cond("activity_ids", "=", false)]);
        return domain;
      },
      // mail_activity_mixin.py:221-228 _search_activity_date_deadline
      activity_date_deadline: async (_env, operator, operand) => {
        if (operator.startsWith("not ") || operator === "!=" || operator === "<>") {
          throw new NotPorted(`activity_date_deadline ${operator} (NotImplemented: negative operators)`);
        }
        const domain = cond("activity_ids.date_deadline", operator, operand);
        if (operator === "in" && Array.isArray(operand) && operand.includes(false)) return or([domain, cond("activity_ids", "=", false)]);
        return domain;
      },
    },
    computeSql: {
      // mail_activity_mixin.py:178-213
      activity_state: async (table: Table): Promise<Sql> => {
        const now = await dbNow(table.env);
        const alias = `${table.alias}__activity_state`;
        const sub = sql`(SELECT a.res_id AS res_id, MIN(SIGN(EXTRACT(day FROM (a.date_deadline - DATE_TRUNC('day', ${now.toISOString()}::timestamptz AT TIME ZONE COALESCE(a.user_tz, 'utc'))))))::INT AS activity_state
          FROM mail_activity a WHERE a.res_model = ${model} AND a.active IS TRUE GROUP BY a.res_id)`;
        table.query.addJoin("LEFT JOIN", alias, sub, sql`${table.id} = ${ident(alias, "res_id")}`);
        const col = ident(alias, "activity_state");
        return sql`CASE WHEN ${col} < 0 THEN 'overdue' WHEN ${col} = 0 THEN 'today' WHEN ${col} > 0 THEN 'planned' END`;
      },
    },
  });
}

/**
 * The same computes on a new record of an onchange (the form of `model`): mail_activity_mixin.py's computes read
 * `record.activity_ids`, which for a record with an origin are the origin's activities (a new record's one2many is
 * a copy of its origin's lines) and for a record without one are none, so every value is False. Activities that
 * differ from the origin's (new lines, or lines the form added or removed) are refused. Only for models registered
 * here: crm.lead has its own (src/models/crm_lead_write.ts).
 */
export function registerActivityMixinNewRecords(model: string): void {
  const computed = hooksOf(model).computed ?? {};
  const computes: Record<string, RecordCompute> = {};
  for (const field of ACTIVITY_COMPUTES) {
    const fn = computed[field];
    if (!fn) throw new TypeError(`registerActivityMixinNewRecords(${model}) before registerActivityMixin: ${field}`);
    computes[field] = async (env, rec) => {
      const id = rec.origin;
      if (!(rec instanceof NewRec)) return id === null ? false : (await fn(env, [id])).get(id) ?? false;
      const lines = (await rec.rels("activity_ids")).map((l) => l.id);
      const origin = rec.originRec ? (await rec.originRec.rels("activity_ids")).map((l) => l.id) : [];
      if (lines.length !== origin.length || lines.some((l) => l === null || !origin.includes(l))) {
        throw new NotPorted(`${model}.${field} of a new record whose activities are not its origin's`);
      }
      if (id === null) return false;
      return (await fn(env, [id])).get(id) ?? false;
    };
  }
  registerRecordCompute(model, computes);
}

/** The computes `registerActivityMixin` registers (its `computed` hooks). */
const ACTIVITY_COMPUTES = ["activity_state", "activity_user_id", "activity_date_deadline", "my_activity_date_deadline",
  "activity_exception_decoration", "activity_exception_icon", "activity_calendar_event_id"] as const;

function negative(operator: string): boolean {
  return operator.startsWith("not ") || operator === "!=" || operator === "<>"; // Domain.NEGATIVE_OPERATORS
}

function relatedSearch(path: string, operator: string, operand: unknown): Domain {
  if (negative(operator)) throw new NotPorted(`${path} ${operator} (NotImplemented)`);
  const domain = cond(path, operator, operand);
  if (operator === "in" && Array.isArray(operand) && operand.includes(false)) return or([domain, cond("activity_ids", "=", false)]);
  return domain;
}

function exception(rows: Activity[], ids: readonly number[], field: "decoration_type" | "icon"): Map<number, unknown> {
  const out = new Map<number, unknown>(ids.map((id) => [id, false]));
  const byRecord = new Map<number, Activity[]>();
  for (const a of rows) byRecord.set(a.res_id, [...(byRecord.get(a.res_id) ?? []), a]);
  for (const [resId, acts] of byRecord) {
    // record.activity_ids.mapped('activity_type_id'): distinct types in activity order
    const seen = new Set<number | null>();
    let chosen: Activity | null = null;
    for (const a of acts) {
      if (a.activity_type_id === null || seen.has(a.activity_type_id)) continue;
      seen.add(a.activity_type_id);
      if (a.decoration_type === "danger") { chosen = a; break; }
      if (a.decoration_type === "warning") chosen = a;
    }
    out.set(resId, chosen === null ? false : chosen[field] || false);
  }
  return out;
}
