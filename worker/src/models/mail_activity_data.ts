/**
 * `mail.activity.get_activity_data` (odoo/addons/mail/models/mail_activity.py:830-981), the data of the activity
 * view. The activity search runs as superuser: mail.activity `_search` (:416-470) grants an activity when the user
 * can read its document, and every res_id here comes from `DocModel._search` as the user (filtered call, :889-891)
 * or is filtered by `DocModel.search` afterwards (:915-917), so the superuser search returns the same rows.
 */
import { NotPorted } from "../errors";
import { and, cond, parseDomain } from "../orm/domain";
import { userInfo } from "../orm/env";
import { registerMethod } from "../http/methods";
import type { Environment } from "../orm/types";
import { envFor, intArg, optInt } from "../web/common";
import { dbNow, todayInTz, validTz } from "./util";

interface Act {
  id: number; res_id: number; activity_type_id: number | false; active: boolean; date_done: string | false;
  date_deadline: string | false; user_id: number | false; role_id: number | false; summary: string | false;
  attachment_ids: number[];
}

/** `_compute_state_from_date(date_deadline, tz=False)` (:225-237): context_today in the context tz (else the user's). */
async function stateFromDate(env: Environment, deadline: string): Promise<string> {
  const tz = validTz(env.context.tz) ?? validTz((await userInfo(env)).tz) ?? "UTC";
  const today = todayInTz(await dbNow(env), tz);
  return deadline === today ? "today" : deadline < today ? "overdue" : "planned";
}

registerMethod("mail.activity", "get_activity_data", async (env0, _ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const resModel = kwargs["res_model"] ?? args[0];
  if (typeof resModel !== "string") throw new NotPorted("get_activity_data: res_model must be a string");
  const rawDomain = kwargs["domain"] ?? args[1];
  const limit = optInt(kwargs["limit"] ?? args[2] ?? null, "limit");
  const offset = intArg(kwargs["offset"] ?? args[3], "offset", 0);
  const fetchDone = (kwargs["fetch_done"] ?? args[4]) === true;
  const domain = parseDomain(rawDomain ?? []);
  const docModel = env.model(resModel);

  // 1. (:887-895)
  const activityTypes = await env.model("mail.activity.type").search(cond("res_model", "in", [resModel, false]));
  let activityDomain = cond("res_model", "=", resModel);
  const isFiltered = (Array.isArray(rawDomain) && rawDomain.length > 0) || (limit !== null && limit !== 0) || offset !== 0;
  if (isFiltered) {
    const docIds = await docModel.search(domain, { offset, limit, order: docModel.def.order });
    activityDomain = and([activityDomain, cond("res_id", "in", docIds)]);
  }
  const sudoActs = env.sudo().withContext({ ...env.context, active_test: !fetchDone }).model("mail.activity");
  const actIds = await sudoActs.search(activityDomain, { order: "date_done DESC, date_deadline ASC", activeTest: !fetchDone });
  const rows = await sudoActs.read(actIds, ["res_id", "activity_type_id", "active", "date_done", "date_deadline", "user_id", "role_id", "summary", "attachment_ids"], "");
  const m2o = (v: unknown): number | false => (typeof v === "number" ? v : false);
  const str = (v: unknown): string | false => (typeof v === "string" && v !== "" ? v : false);
  const acts: Act[] = rows.map((r) => ({
    id: Number(r["id"]), res_id: Number(r["res_id"]), activity_type_id: m2o(r["activity_type_id"]), active: r["active"] === true,
    date_done: str(r["date_done"]), date_deadline: str(r["date_deadline"]), user_id: m2o(r["user_id"]), role_id: m2o(r["role_id"]),
    summary: str(r["summary"]), attachment_ids: Array.isArray(r["attachment_ids"]) ? r["attachment_ids"].map(Number) : [],
  }));
  const completed = acts.filter((a) => !a.active);
  if (completed.some((a) => a.attachment_ids.length > 0)) throw new NotPorted("get_activity_data: attachments of done activities (:897-905)");

  // 3. (:907-911): odoo.tools.misc.groupby (misc.py:1164-1173) aggregates every element under its (res_id, type) key,
  // not only consecutive ones; the keys keep the order of their first element
  const runs = (list: Act[]): Map<string, Act[]> => {
    const out = new Map<string, Act[]>();
    for (const a of list) {
      const k = `${a.res_id},${a.activity_type_id}`;
      const group = out.get(k);
      if (group === undefined) out.set(k, [a]);
      else group.push(a);
    }
    return out;
  };
  const groupedCompleted = runs(completed);
  const groupedOngoing = runs(acts.filter((a) => a.active));

  // 4. (:913-917)
  let keys = [...new Set([...groupedOngoing.keys(), ...groupedCompleted.keys()])];
  if (!isFiltered) {
    const resIds = keys.map((k) => Number(k.split(",")[0]));
    const visible = new Set(await docModel.search(cond("id", "in", resIds)));
    keys = keys.filter((k) => visible.has(Number(k.split(",")[0])));
  }

  // 5. (:919-958)
  const toDeadline = new Map<number, string>();
  const toDone = new Map<number, string>();
  const grouped: Record<string, Record<string, unknown>> = {};
  for (const key of keys) {
    const [resIdRaw, typeRaw] = key.split(",");
    const resId = Number(resIdRaw);
    const ongoing = groupedOngoing.get(key) ?? [];
    const done = groupedCompleted.get(key) ?? [];
    // `ongoing | completed`: union in order, without duplicates
    const activities = [...ongoing, ...done.filter((d) => !ongoing.some((o) => o.id === d.id))];
    const dateDone = done[0]?.date_done || false;
    const dateDeadline = ongoing[0]?.date_deadline || false;
    if (dateDeadline && (!toDeadline.has(resId) || dateDeadline < (toDeadline.get(resId) ?? ""))) toDeadline.set(resId, dateDeadline);
    if (dateDone && (!toDone.has(resId) || dateDone > (toDone.get(resId) ?? ""))) toDone.set(resId, dateDone);
    const counts: Record<string, number> = {};
    for (const a of activities) {
      if (a.active && !a.date_deadline) throw new NotPorted("get_activity_data: activity without deadline");
      const s = a.active ? await stateFromDate(env, a.date_deadline as string) : "done";
      counts[s] = (counts[s] ?? 0) + 1;
    }
    const uniq = (xs: (number | false)[]): number[] => [...new Set(xs.filter((x): x is number => typeof x === "number"))];
    if (typeRaw === "false") throw new NotPorted("get_activity_data: activity without type");
    (grouped[String(resId)] ??= {})[String(typeRaw)] = {
      count_by_state: counts,
      ids: activities.map((a) => a.id),
      reporting_date: (ongoing.length > 0 && dateDeadline) || dateDone || null,
      state: ongoing.length > 0 ? await stateFromDate(env, dateDeadline as string) : "done",
      user_assigned_ids: uniq(ongoing.map((a) => a.user_id)),
      role_to_assign_ids: uniq(ongoing.filter((a) => !a.user_id).map((a) => a.role_id)),
      summaries: activities.map((a) => a.summary || ""),
    };
  }
  const ongoingIds = [...toDeadline.keys()].sort((a, b) => ((toDeadline.get(a) ?? "") < (toDeadline.get(b) ?? "") ? -1 : (toDeadline.get(a) ?? "") > (toDeadline.get(b) ?? "") ? 1 : 0));
  const completedIds = [...toDone.keys()]
    .sort((a, b) => ((toDone.get(a) ?? "") < (toDone.get(b) ?? "") ? 1 : (toDone.get(a) ?? "") > (toDone.get(b) ?? "") ? -1 : 0))
    .filter((id) => !toDeadline.has(id));

  const types = await env.model("mail.activity.type").read(activityTypes, ["name", "mail_template_ids"], "");
  const templateIds = [...new Set(types.flatMap((t) => (Array.isArray(t["mail_template_ids"]) ? (t["mail_template_ids"] as number[]) : [])))];
  const templateNames = new Map((templateIds.length > 0 ? await env.model("mail.template").read(templateIds, ["name"], "") : [])
    .map((t) => [Number(t["id"]), t["name"]]));
  return {
    activity_res_ids: [...ongoingIds, ...completedIds],
    activity_types: types.map((t) => ({
      id: t["id"],
      name: t["name"],
      template_ids: (Array.isArray(t["mail_template_ids"]) ? (t["mail_template_ids"] as number[]) : []).map((id) => ({ id, name: templateNames.get(id) ?? false })),
    })),
    grouped_activities: grouped,
  };
}, { apiModel: true, readonly: true });

